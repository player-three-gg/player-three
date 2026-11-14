// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;

namespace PlayerThree.Sidecar
{
    /// <summary>Start options of a <see cref="PlayerThreeSidecar"/>.</summary>
    public sealed class SidecarOptions
    {
        /// <summary>The plain-JSON manifest sent in <c>hello</c> (<see cref="ManifestBuilder.Build"/> or a parsed JSON file).</summary>
        public JsonValue Manifest { get; set; }
        /// <summary>The game: match factory and built-in bots.</summary>
        public IGame Game { get; set; }
        /// <summary>Optional adapter calls every match of this game answers (<see cref="HookSet.Of{TAdapter}"/>).</summary>
        public Hooks Hooks { get; set; }
        /// <summary>Longest wait for the host's <c>ready</c>, in milliseconds (the host itself allows 10 s for <c>hello</c>).</summary>
        public int HandshakeTimeoutMs { get; set; } = 30000;
        /// <summary>Longest wait for the result of one engine request (<see cref="PlayerThreeSidecar.Step"/>, <see cref="PlayerThreeSidecar.Request"/>), in milliseconds.</summary>
        public int RequestTimeoutMs { get; set; } = 60000;
        /// <summary>Diagnostics (protocol failures, adapter exceptions); null discards them. Called on the owner thread or the reader thread.</summary>
        public Action<string> Log { get; set; }
    }

    /// <summary>A host-pushed notification (<c>seats</c>, <c>ended</c>, …) for a session.</summary>
    public sealed class SidecarPush
    {
        /// <summary>Session id.</summary>
        public string Session { get; }
        /// <summary>Push kind.</summary>
        public string Kind { get; }
        /// <summary>Push payload.</summary>
        public JsonValue Data { get; }

        internal SidecarPush(string session, string kind, JsonValue data) { Session = session; Kind = kind; Data = data; }
    }

    /// <summary>An engine request the host answered with <c>ok:false</c> (<c>paused</c>, <c>over</c>, <c>unknown_session</c>, <c>invalid</c>, …).</summary>
    public sealed class SidecarRequestException : Exception
    {
        /// <summary>The host's closed failure code.</summary>
        public string Code { get; }

        internal SidecarRequestException(string method, string code, string message)
            : base($"{method} failed: {code}{(message == null ? "" : " (" + message + ")")}") { Code = code; }
    }

    /// <summary>The connection is closed (host exit, protocol failure, timeout or <see cref="PlayerThreeSidecar.Dispose"/>).</summary>
    public sealed class SidecarClosedException : Exception
    {
        /// <summary>Why it closed: <c>eof</c>, <c>disposed</c>, <c>timeout</c>, a host fatal code (<c>too_large</c>, <c>bad_frame</c>, <c>invalid_manifest</c>, …) or a local protocol code.</summary>
        public string Reason { get; }

        internal SidecarClosedException(string reason, string message) : base(message) { Reason = reason; }
    }

    /// <summary>
    /// The engine side of the PlayerThree sidecar (SPEC §20.8, wire protocol 1). The engine owns the simulation and the
    /// clock; the host owns MCP, OAuth, guards, scopes, mandates, presence, policies and sessions.
    ///
    /// Threading: one background thread reads the channel. Host <c>call</c>s and <c>push</c>es are queued and run only on
    /// the owner thread (the thread that called <see cref="Start"/>) inside <see cref="Pump()"/>, <see cref="Step"/> and
    /// <see cref="Request"/>; those three throw on any other thread. While a request is outstanding the owner thread
    /// keeps answering the host's calls, which is what keeps <c>advance</c> synchronous per tick.
    /// <see cref="WorkAvailable"/> fires on the reader thread so an engine can schedule a <see cref="Pump()"/> on its main
    /// loop (Unity <c>SynchronizationContext</c>, Godot <c>CallDeferred</c>, …) instead of polling.
    /// </summary>
    public sealed class PlayerThreeSidecar : IDisposable
    {
        /// <summary>Wire protocol version this client speaks.</summary>
        public const int Protocol = 1;

        private readonly SidecarTransport _transport;
        private readonly FrameWriter _writer;
        private readonly FrameReader _reader;
        private readonly IGame _game;
        private readonly Hooks _hooks;
        private readonly int _requestTimeoutMs;
        private readonly Action<string> _log;
        private readonly Thread _owner;
        private readonly Thread _readerThread;

        private readonly ConcurrentQueue<JsonValue> _inbox = new ConcurrentQueue<JsonValue>();
        private readonly AutoResetEvent _signal = new AutoResetEvent(false);
        private readonly Dictionary<string, IAdapter> _matches = new Dictionary<string, IAdapter>(StringComparer.Ordinal);
        private readonly Dictionary<string, IBot> _bots = new Dictionary<string, IBot>(StringComparer.Ordinal);
        private readonly HashSet<string> _ended = new HashSet<string>(StringComparer.Ordinal);

        private readonly object _state = new object();
        private JsonValue _handshake;
        private long _pendingId; // the one outstanding engine request (0: none)
        private JsonValue _pendingResult;
        private long _nextId;
        private string _closedReason;
        private string _closedMessage;
        private bool _closedRaised;
        private bool _inPump;

        /// <summary>Host's surface hash from <c>ready</c> (SPEC §4).</summary>
        public string SurfaceHash { get; private set; }
        /// <summary>The MCP endpoint URL from <c>ready</c>, or null when the host did not report one.</summary>
        public string McpUrl { get; private set; }

        /// <summary>Fires on the reader thread whenever queued host work is waiting for <see cref="Pump()"/>. Keep it cheap and non-blocking.</summary>
        public event Action WorkAvailable;
        /// <summary>A host push, raised on the owner thread.</summary>
        public event Action<SidecarPush> Pushed;
        /// <summary>The connection closed (with its reason), raised once on the owner thread. The host has disposed every session: move agent and policy seats to the game's own bots.</summary>
        public event Action<SidecarClosedException> Closed;

        /// <summary>True until the connection closes.</summary>
        public bool IsConnected { get { lock (_state) return _closedReason == null; } }

        private PlayerThreeSidecar(SidecarTransport transport, SidecarOptions options)
        {
            _transport = transport;
            _writer = new FrameWriter(transport.Output);
            _reader = new FrameReader(transport.Input);
            _game = options.Game;
            _hooks = options.Hooks;
            _requestTimeoutMs = options.RequestTimeoutMs;
            _log = options.Log;
            _owner = Thread.CurrentThread;
            _readerThread = new Thread(ReadLoop) { IsBackground = true, Name = "playerthree-sidecar-reader" };
        }

        /// <summary>
        /// Says <c>hello</c> over <paramref name="transport"/> and waits for <c>ready</c>. The calling thread becomes the
        /// owner thread. Throws <see cref="SidecarClosedException"/> when the host refuses the manifest or the channel fails,
        /// and disposes the transport then.
        /// </summary>
        public static PlayerThreeSidecar Start(SidecarTransport transport, SidecarOptions options)
        {
            if (transport == null) throw new ArgumentNullException(nameof(transport));
            if (options == null) throw new ArgumentNullException(nameof(options));
            if (options.Manifest == null || options.Manifest.Kind != JsonKind.Object) throw new ArgumentException("options.Manifest must be the manifest JSON object");
            if (options.Game == null) throw new ArgumentException("options.Game is required");
            var s = new PlayerThreeSidecar(transport, options);
            try
            {
                s._readerThread.Start();
                // A host that refuses hello may close before our flush returns; the wait below reports its reason.
                s.Write(JsonValue.NewObject().Set("op", "hello").Set("protocol", Protocol).Set("manifest", options.Manifest).Set("hooks", HookSet.ToJson(options.Hooks)));
                var deadline = Environment.TickCount + options.HandshakeTimeoutMs;
                JsonValue reply;
                while (true)
                {
                    lock (s._state)
                    {
                        reply = s._handshake;
                        if (reply == null && s._closedReason != null) throw s.ClosedError();
                    }
                    if (reply != null) break;
                    var left = deadline - Environment.TickCount;
                    if (left <= 0)
                    {
                        s.Close("timeout", "the host did not answer hello in time", notify: false);
                        throw s.ClosedError();
                    }
                    s._signal.WaitOne(left);
                }
                if (Str(reply, "op") != "ready")
                {
                    s.Close(Str(reply, "code") ?? "protocol", Str(reply, "message") ?? "the host refused hello", notify: false);
                    throw s.ClosedError();
                }
                s.SurfaceHash = Str(reply, "surfaceHash");
                s.McpUrl = Str(reply, "mcp");
                return s;
            }
            catch
            {
                s.Dispose();
                throw;
            }
        }

        /// <summary>True once the host pushed <c>ended</c> for the session (owner thread).</summary>
        public bool HasEnded(string session) => _ended.Contains(session);

        /// <summary>The engine's adapter for a live match session, or null.</summary>
        public IAdapter Match(string session) => _matches.TryGetValue(session, out var a) ? a : null;

        /// <summary>
        /// Keeps answering host calls as they arrive for <paramref name="milliseconds"/> (an engine loop's idle time
        /// between ticks), returning early only when the connection closes. Owner thread only.
        /// </summary>
        public int Pump(int milliseconds)
        {
            EnterPump();
            try
            {
                var handled = Drain();
                var deadline = Environment.TickCount + milliseconds;
                while (IsConnected)
                {
                    var left = deadline - Environment.TickCount;
                    if (left <= 0) break;
                    _signal.WaitOne(left);
                    handled += Drain();
                }
                return handled;
            }
            finally { _inPump = false; }
        }

        /// <summary>Answers every queued host call and raises queued pushes; returns how many messages it handled. Owner thread only.</summary>
        public int Pump()
        {
            EnterPump();
            try { return Drain(); }
            finally { _inPump = false; }
        }

        /// <summary>
        /// The engine-owned clock (<c>advance</c>): the host runs up to <paramref name="ticks"/> ticks (thinking phase,
        /// gates, <c>apply</c> and <c>step</c> calls, answered here on the owner thread) and returns the match's tick.
        /// Throws <see cref="SidecarRequestException"/> with <c>paused</c>, <c>over</c>, <c>unknown_session</c> or <c>invalid</c>.
        /// </summary>
        public int Step(string session, int ticks = 1)
        {
            if (session == null) throw new ArgumentNullException(nameof(session));
            if (ticks < 1) throw new ArgumentOutOfRangeException(nameof(ticks), "advance at least one tick");
            var data = Send("advance", id => JsonValue.NewObject().Set("op", "advance").Set("id", id).Set("session", session).Set("n", ticks));
            return data["tick"].AsInt();
        }

        /// <summary>
        /// A game-side host operation (<c>createMatch</c>, <c>mintSeatToken</c>, <c>seats</c>, <c>cards</c>,
        /// <c>readiness</c>, <c>setController</c>, <c>setMandate</c>, <c>end</c>, <c>forfeit</c>, <c>dispose</c>).
        /// Blocks (answering host calls) until the result. Throws <see cref="SidecarRequestException"/> on <c>ok:false</c>.
        /// </summary>
        public JsonValue Request(string method, params JsonValue[] args)
        {
            if (method == null) throw new ArgumentNullException(nameof(method));
            var a = JsonValue.NewArray(args ?? Array.Empty<JsonValue>());
            return Send(method, id => JsonValue.NewObject().Set("op", "host").Set("id", id).Set("method", method).Set("args", a));
        }

        /// <summary><c>createMatch</c> with plain-JSON options (<c>seed</c>, <c>options</c>, <c>teams</c>, <c>alliances</c>, <c>controllers</c>, <c>botLevel</c>); returns the new session id. The host has called <see cref="IGame.Create"/> by then.</summary>
        public string CreateMatch(JsonValue matchOptions) => Request("createMatch", matchOptions ?? JsonValue.NewObject())["session"].AsString();

        /// <summary><c>mintSeatToken</c>: an MCP bearer token for one seat of one match. Hand it only to that seat's owner and never log it (<see cref="SeatTokenFile"/>).</summary>
        public string MintSeatToken(string session, Seat seat) => Request("mintSeatToken", session, seat.Team, seat.Role)["token"].AsString();

        /// <summary><c>dispose</c>: release the session; the host calls the adapter's dispose before replying.</summary>
        public void DisposeSession(string session) => Request("dispose", session);

        /// <summary>Closes the connection (the host then disposes every session and exits) and stops the reader thread.</summary>
        public void Dispose()
        {
            Close("disposed", "the engine closed the connection", notify: false);
            if (Thread.CurrentThread == _readerThread) return;
            // The host normally hangs up once we stop sending; if it does not, force the pending read to end.
            if (!_readerThread.Join(3000))
            {
                _transport.Abort();
                _readerThread.Join(2000);
            }
        }

        // ------------------------------------------------------------------ owner-thread plumbing

        private void EnterPump()
        {
            if (Thread.CurrentThread != _owner) throw new InvalidOperationException("PlayerThreeSidecar is used only from the thread that started it");
            if (_inPump) throw new InvalidOperationException("an adapter call cannot pump the sidecar or issue a host request");
            _inPump = true;
        }

        private JsonValue Send(string method, Func<long, JsonValue> build)
        {
            EnterPump();
            try
            {
                Drain();
                long id;
                lock (_state)
                {
                    if (_closedReason != null) throw ClosedError();
                    id = ++_nextId;
                    _pendingId = id;
                    _pendingResult = null;
                }
                Write(build(id));
                var deadline = Environment.TickCount + _requestTimeoutMs;
                while (true)
                {
                    Drain();
                    JsonValue result;
                    lock (_state)
                    {
                        result = _pendingResult;
                        if (result == null && _closedReason != null) { _pendingId = 0; throw ClosedError(); }
                    }
                    if (result != null)
                    {
                        lock (_state) { _pendingId = 0; _pendingResult = null; }
                        Drain(); // pushes that arrived before this result (e.g. `ended`) are visible when the request returns
                        if (result["ok"]?.Kind == JsonKind.Bool && result["ok"].AsBool()) return result["data"] ?? JsonValue.Null;
                        throw new SidecarRequestException(method, Str(result, "code") ?? "invalid", Str(result, "message"));
                    }
                    var left = deadline - Environment.TickCount;
                    if (left <= 0)
                    {
                        // A late reply would break the one-outstanding-request rule, so a timeout ends the connection.
                        Close("timeout", $"{method} got no result within {_requestTimeoutMs} ms", notify: true);
                        continue;
                    }
                    _signal.WaitOne(left);
                }
            }
            finally
            {
                _inPump = false;
                RaiseClosedIfNeeded();
            }
        }

        private int Drain()
        {
            var handled = 0;
            while (_inbox.TryDequeue(out var message))
            {
                handled++;
                if (Str(message, "op") == "call") Answer(message);
                else RaisePush(message);
            }
            RaiseClosedIfNeeded();
            return handled;
        }

        private void RaisePush(JsonValue message)
        {
            var session = Str(message, "session");
            var kind = Str(message, "kind");
            if (kind == "ended" && session != null) _ended.Add(session);
            var handler = Pushed;
            if (handler == null) return;
            try { handler(new SidecarPush(session, kind, message["data"] ?? JsonValue.Null)); }
            catch (Exception e) { _log?.Invoke($"playerthree/sidecar: push handler threw: {e}"); }
        }

        private void RaiseClosedIfNeeded()
        {
            SidecarClosedException error;
            lock (_state)
            {
                if (_closedReason == null || _closedRaised || _closedReason == "disposed") return;
                _closedRaised = true;
                error = ClosedError();
            }
            try { Closed?.Invoke(error); }
            catch (Exception e) { _log?.Invoke($"playerthree/sidecar: Closed handler threw: {e}"); }
        }

        private void Answer(JsonValue call)
        {
            var id = call["id"];
            JsonValue reply;
            try
            {
                reply = Ok(id, Dispatch(Str(call, "session"), Str(call, "method"), call["args"]));
            }
            catch (CallFailure f)
            {
                reply = Fail(id, f.Code, f.Message);
            }
            catch (Exception e) when (e is InvalidOperationException || e is FormatException || e is NullReferenceException || e is KeyNotFoundException || e is ArgumentException)
            {
                // Args of the wrong shape surface as accessor failures before any game code runs.
                reply = Fail(id, "invalid", "bad arguments: " + e.Message);
            }
            catch (GameException e)
            {
                _log?.Invoke($"playerthree/sidecar: {Str(call, "method")} threw: {e.InnerException}");
                reply = Fail(id, "engine_error", e.InnerException.GetType().Name + ": " + e.InnerException.Message);
            }
            try { _writer.Write(reply); }
            catch (SidecarProtocolException) { Write(Fail(id, "engine_error", "result exceeds the 1048576-byte message limit")); }
            catch (Exception e) when (e is System.IO.IOException || e is ObjectDisposedException || e is NotSupportedException)
            {
                Close("eof", "the connection failed: " + e.Message, notify: true);
            }
        }

        private static JsonValue Ok(JsonValue id, JsonValue data) => JsonValue.NewObject().Set("op", "result").Set("id", id).Set("ok", true).Set("data", data ?? JsonValue.Null);

        private static JsonValue Fail(JsonValue id, string code, string message)
        {
            if (message != null && message.Length > 500) message = message.Substring(0, 500);
            var r = JsonValue.NewObject().Set("op", "result").Set("id", id).Set("ok", false).Set("code", code);
            if (message != null) r.Set("message", message);
            return r;
        }

        private JsonValue Dispatch(string session, string method, JsonValue args)
        {
            if (session == null || method == null) throw new CallFailure("invalid", "call needs session and method");
            if (args == null || args.Kind != JsonKind.Array) throw new CallFailure("invalid", "args must be an array");
            switch (method)
            {
                case "create":
                {
                    if (_matches.ContainsKey(session) || _bots.ContainsKey(session)) throw new CallFailure("invalid", $"session {session} exists");
                    var req = ParseCreate(session, Arg(args, 0));
                    var adapter = Game(() => _game.Create(req));
                    Register(session, adapter);
                    return Tick(adapter);
                }
                case "createBot":
                {
                    if (_matches.ContainsKey(session) || _bots.ContainsKey(session)) throw new CallFailure("invalid", $"session {session} exists");
                    var seat = Seat.FromJson(Arg(args, 0));
                    var opponent = Arg(args, 1).AsString();
                    var options = args.Count > 2 && !args[2].IsNull ? args[2] : null;
                    var bot = Game(() => _game.CreateBot(seat, opponent, options));
                    _bots[session] = bot ?? throw new GameException(new InvalidOperationException("CreateBot returned null"));
                    return JsonValue.Null;
                }
                case "init":
                    Game(() => { Bot(session).Init(Arg(args, 0)); return 0; });
                    return JsonValue.Null;
                case "think":
                {
                    var bot = Bot(session);
                    var obs = Arg(args, 0);
                    return Game(() => bot.Think(obs)) ?? JsonValue.NewArray();
                }
                case "dispose":
                {
                    IDisposable d = null;
                    if (_matches.TryGetValue(session, out var m)) { _matches.Remove(session); d = m as IDisposable; }
                    else if (_bots.TryGetValue(session, out var b)) { _bots.Remove(session); d = b as IDisposable; }
                    else throw new CallFailure("unknown_session", $"no session {session}");
                    _ended.Remove(session);
                    if (d != null) Game(() => { d.Dispose(); return 0; });
                    return JsonValue.Null;
                }
            }

            var a = MatchOf(session);
            switch (method)
            {
                case "step":
                    Game(() => { a.Step(); return 0; });
                    return Tick(a);
                case "outcome":
                {
                    var team = Arg(args, 0).AsString();
                    return OutcomeWire(Game(() => a.Outcome(team)));
                }
                case "view":
                {
                    var team = Arg(args, 0).AsString();
                    var opts = args.Count > 1 ? args[1] : null;
                    var snapshot = opts != null && opts.Kind == JsonKind.Object && opts["snapshot"]?.Kind == JsonKind.Bool && opts["snapshot"].AsBool();
                    return Game(() => a.View(team, snapshot));
                }
                case "observe":
                {
                    var seat = Seat.FromJson(Arg(args, 0));
                    var since = Arg(args, 1).AsInt();
                    var detail = new List<string>();
                    if (args.Count > 2 && !args[2].IsNull) foreach (var s in args[2].Items) detail.Add(s.AsString());
                    return Game(() => a.Observe(seat, since, detail));
                }
                case "apply":
                {
                    var seat = Seat.FromJson(Arg(args, 0));
                    var intent = Arg(args, 1);
                    if (intent.Kind != JsonKind.Object) throw new CallFailure("invalid", "intent must be an object");
                    var context = IntentContext.FromJson(args.Count > 2 ? args[2] : null);
                    return Game(() => a.Apply(seat, intent, context)).ToJson();
                }
                case "report":
                {
                    var team = Arg(args, 0).AsString();
                    return Game(() => a.Report(team));
                }
                case "events":
                {
                    var seat = Seat.FromJson(Arg(args, 0));
                    var since = Arg(args, 1).AsInt();
                    return Game(() => a.Events(seat, since)) ?? JsonValue.NewArray();
                }
                case "setSeatInfo":
                {
                    var seat = Seat.FromJson(Arg(args, 0));
                    var info = Arg(args, 1);
                    var seatInfo = new SeatInfo(info["controller"].AsString(), info["mandate"] ?? JsonValue.Null);
                    Game(() => { a.SetSeatInfo(seat, seatInfo); return 0; });
                    return JsonValue.Null;
                }
                case "matchData":
                {
                    var h = Hook<IMatchDataAdapter>(a, Hooks.MatchData, method);
                    var seat = Seat.FromJson(Arg(args, 0));
                    return Game(() => h.MatchData(seat));
                }
                case "debugView":
                    return Game(() => Hook<IDebugViewAdapter>(a, Hooks.DebugView, method).DebugView());
                case "observerView":
                    return Game(() => Hook<IObserverViewAdapter>(a, Hooks.ObserverView, method).ObserverView());
                case "end":
                {
                    var h = Hook<IEndAdapter>(a, Hooks.End, method);
                    var outcomes = new Dictionary<string, Outcome>(StringComparer.Ordinal);
                    foreach (var p in Arg(args, 0).Properties) outcomes[p.Key] = ParseOutcome(p.Value.AsString());
                    var ranks = new Dictionary<string, int>(StringComparer.Ordinal);
                    foreach (var p in Arg(args, 1).Properties) ranks[p.Key] = p.Value.AsInt();
                    Game(() => { h.End(outcomes, ranks); return 0; });
                    return JsonValue.Null;
                }
                case "forfeit":
                {
                    var h = Hook<IForfeitAdapter>(a, Hooks.Forfeit, method);
                    var team = Arg(args, 0).AsString();
                    Game(() => { h.Forfeit(team); return 0; });
                    return JsonValue.Null;
                }
                case "rank":
                {
                    var h = Hook<IRankAdapter>(a, Hooks.Rank, method);
                    var team = Arg(args, 0).AsString();
                    return Game(() => h.Rank(team));
                }
                case "clone":
                {
                    var h = Hook<ICloneAdapter>(a, Hooks.Clone, method);
                    var target = Arg(args, 0).AsString();
                    if (_matches.ContainsKey(target) || _bots.ContainsKey(target)) throw new CallFailure("invalid", $"session {target} exists");
                    var copy = Game(() => h.Clone());
                    Register(target, copy);
                    return Tick(copy);
                }
                default:
                    throw new CallFailure("unknown_method", $"unknown method {method}");
            }
        }

        private void Register(string session, IAdapter adapter)
        {
            if (adapter == null) throw new GameException(new InvalidOperationException("the game returned no adapter"));
            foreach (var (flag, wire, iface) in HookSet.All)
                if ((_hooks & flag) != 0 && !iface.IsInstanceOfType(adapter))
                    throw new GameException(new InvalidOperationException($"hello declared hook {wire} but {adapter.GetType().Name} does not implement {iface.Name}"));
            _matches[session] = adapter;
        }

        private T Hook<T>(IAdapter a, Hooks flag, string method) where T : class
        {
            if ((_hooks & flag) == 0 || !(a is T h)) throw new CallFailure("unknown_method", $"hook {method} was not declared in hello");
            return h;
        }

        private IAdapter MatchOf(string session) =>
            _matches.TryGetValue(session, out var a) ? a : throw new CallFailure("unknown_session", $"no match session {session}");

        private IBot Bot(string session) =>
            _bots.TryGetValue(session, out var b) ? b : throw new CallFailure("unknown_session", $"no bot session {session}");

        private static JsonValue Tick(IAdapter a) => JsonValue.NewObject().Set("tick", a.Tick);

        private static JsonValue Arg(JsonValue args, int i) =>
            i < args.Count ? args[i] : throw new CallFailure("invalid", $"missing argument {i}");

        private static CreateRequest ParseCreate(string session, JsonValue spec)
        {
            if (spec.Kind != JsonKind.Object) throw new CallFailure("invalid", "create takes one object");
            var teams = new List<string>();
            foreach (var t in spec["teams"].Items) teams.Add(t.AsString());
            Dictionary<string, IReadOnlyList<string>> alliances = null;
            if (spec.TryGet("alliances", out var al) && !al.IsNull)
            {
                alliances = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
                foreach (var p in al.Properties)
                {
                    var members = new List<string>();
                    foreach (var m in p.Value.Items) members.Add(m.AsString());
                    alliances[p.Key] = members;
                }
            }
            var options = spec.TryGet("options", out var o) && !o.IsNull ? o : null;
            return new CreateRequest(session, spec["seed"].AsLong(), options, teams, alliances);
        }

        private static JsonValue OutcomeWire(Outcome o)
        {
            switch (o)
            {
                case Outcome.Win: return "win";
                case Outcome.Loss: return "loss";
                case Outcome.Draw: return "draw";
                default: return "running";
            }
        }

        private static Outcome ParseOutcome(string s)
        {
            switch (s)
            {
                case "win": return Outcome.Win;
                case "loss": return Outcome.Loss;
                case "draw": return Outcome.Draw;
                case "running": return Outcome.Running;
                default: throw new CallFailure("invalid", $"unknown outcome {s}");
            }
        }

        /// <summary>Runs game code, marking its exceptions as the game's (engine_error) rather than bad arguments.</summary>
        private static TResult Game<TResult>(Func<TResult> f)
        {
            try { return f(); }
            catch (CallFailure) { throw; }
            catch (GameException) { throw; }
            catch (Exception e) { throw new GameException(e); }
        }

        private sealed class CallFailure : Exception
        {
            public string Code { get; }
            public CallFailure(string code, string message) : base(message) { Code = code; }
        }

        private sealed class GameException : Exception
        {
            public GameException(Exception inner) : base(inner.Message, inner) { }
        }

        // ------------------------------------------------------------------ reader thread

        private void ReadLoop()
        {
            try
            {
                while (true)
                {
                    JsonValue message;
                    try { message = _reader.Read(); }
                    catch (SidecarProtocolException e)
                    {
                        // Our side of the fatal-frame rule: tell the host why, then close.
                        TryWrite(JsonValue.NewObject().Set("op", "error").Set("code", e.Code == "too_large" ? "too_large" : "bad_frame").Set("message", e.Message));
                        Close(e.Code, e.Message, notify: true);
                        return;
                    }
                    if (message == null)
                    {
                        Close("eof", "the host closed the connection", notify: true);
                        return;
                    }
                    if (!Route(message)) return;
                }
            }
            catch (Exception e) when (e is System.IO.IOException || e is ObjectDisposedException || e is InvalidOperationException)
            {
                Close("eof", "the connection failed: " + e.Message, notify: true);
            }
            finally
            {
                _transport.Release();
            }
        }

        /// <summary>Routes one inbound message; false when it was fatal and the connection is closed.</summary>
        private bool Route(JsonValue message)
        {
            var op = Str(message, "op");
            switch (op)
            {
                case "ready":
                    lock (_state)
                    {
                        if (_handshake != null) return BadFrame("duplicate ready");
                        _handshake = message;
                    }
                    _signal.Set();
                    return true;
                case "error":
                    lock (_state)
                    {
                        if (_handshake == null) { _handshake = message; }
                    }
                    Close(Str(message, "code") ?? "protocol", Str(message, "message") ?? "the host reported a fatal error", notify: true);
                    return false;
                case "result":
                {
                    var id = message["id"];
                    bool expected;
                    lock (_state)
                    {
                        expected = id != null && id.Kind == JsonKind.Number && _pendingId != 0 && id.AsDouble() == _pendingId && _pendingResult == null;
                        if (expected) _pendingResult = message;
                    }
                    if (!expected) return BadFrame("result for a request that is not outstanding");
                    _signal.Set();
                    return true;
                }
                case "call":
                    if (message["id"]?.Kind != JsonKind.Number) return BadFrame("call without an integer id");
                    Enqueue(message);
                    return true;
                case "push":
                    Enqueue(message);
                    return true;
                default:
                    return BadFrame($"unknown op {op ?? "(none)"}");
            }
        }

        private bool BadFrame(string why)
        {
            TryWrite(JsonValue.NewObject().Set("op", "error").Set("code", "bad_frame").Set("message", why));
            Close("bad_frame", why, notify: true);
            return false;
        }

        private void Enqueue(JsonValue message)
        {
            _inbox.Enqueue(message);
            _signal.Set();
            try { WorkAvailable?.Invoke(); }
            catch (Exception e) { _log?.Invoke($"playerthree/sidecar: WorkAvailable handler threw: {e}"); }
        }

        // ------------------------------------------------------------------ shared

        private void Write(JsonValue message)
        {
            try { _writer.Write(message); }
            catch (Exception e) when (e is System.IO.IOException || e is ObjectDisposedException || e is NotSupportedException)
            {
                Close("eof", "the connection failed: " + e.Message, notify: true);
            }
        }

        private void TryWrite(JsonValue message)
        {
            try { _writer.Write(message); }
            catch (Exception) { /* closing anyway */ }
        }

        private void Close(string reason, string message, bool notify)
        {
            lock (_state)
            {
                if (_closedReason != null) return;
                _closedReason = reason;
                _closedMessage = message;
            }
            if (reason != "disposed" && reason != "eof") _log?.Invoke($"playerthree/sidecar: closing ({reason}): {message}");
            // Stop sending only: disposing the input under the reader's pending read can block, so the reader releases it.
            try { _transport.Shutdown(); }
            catch (Exception) { /* best effort */ }
            try { _signal.Set(); }
            catch (ObjectDisposedException) { /* disposed after close */ }
            if (notify)
            {
                try { WorkAvailable?.Invoke(); }
                catch (Exception) { /* diagnostics only */ }
            }
        }

        private SidecarClosedException ClosedError() => new SidecarClosedException(_closedReason, $"sidecar connection closed ({_closedReason}): {_closedMessage}");

        private static string Str(JsonValue o, string key)
        {
            var v = o?[key];
            return v != null && v.Kind == JsonKind.String ? v.AsString() : null;
        }
    }
}
