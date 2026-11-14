// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Threading;
using PlayerThree.Samples.TugOfWar;
using PlayerThree.Sidecar;
using Xunit;

/// <summary>The host side of an in-process channel, scripted by a test on a background thread.</summary>
internal sealed class FakeHost : IDisposable
{
    private readonly FrameReader _reader;
    private readonly FrameWriter _writer;
    private readonly Stream _toEngine;
    private readonly Stream _fromEngine;
    private int _nextCall;

    private FakeHost(Stream fromEngine, Stream toEngine)
    {
        _fromEngine = fromEngine;
        _toEngine = toEngine;
        _reader = new FrameReader(fromEngine);
        _writer = new FrameWriter(toEngine);
    }

    /// <summary>A connected pair: the engine's transport and the scripted host.</summary>
    public static (SidecarTransport engine, FakeHost host) Create()
    {
        var hostToEngine = new AnonymousPipeServerStream(PipeDirection.Out);
        var engineIn = new AnonymousPipeClientStream(PipeDirection.In, hostToEngine.ClientSafePipeHandle);
        var engineToHost = new AnonymousPipeServerStream(PipeDirection.In);
        var engineOut = new AnonymousPipeClientStream(PipeDirection.Out, engineToHost.ClientSafePipeHandle);
        return (SidecarTransport.FromStreams(engineIn, engineOut), new FakeHost(engineToHost, hostToEngine));
    }

    public static FakeHost Over(Stream duplex) => new FakeHost(duplex, duplex);

    public JsonValue Read() => _reader.Read();

    public void Write(JsonValue m) => _writer.Write(m);

    public void WriteRaw(string line)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(line + "\n");
        _toEngine.Write(bytes, 0, bytes.Length);
        _toEngine.Flush();
    }

    /// <summary>Reads hello and answers ready.</summary>
    public JsonValue Handshake()
    {
        var hello = Read();
        Write(JsonValue.NewObject().Set("op", "ready").Set("surfaceHash", "abc123").Set("mcp", "http://127.0.0.1:8787/mcp"));
        return hello;
    }

    /// <summary>Sends one call and returns the engine's result message (asserting it echoes the id).</summary>
    public JsonValue Call(string session, string method, params JsonValue[] args)
    {
        var id = ++_nextCall;
        Write(JsonValue.NewObject().Set("op", "call").Set("id", id).Set("session", session).Set("method", method).Set("args", JsonValue.NewArray(args)));
        var r = Read();
        Assert.Equal("result", r["op"].AsString());
        Assert.Equal(id, r["id"].AsInt());
        return r;
    }

    public JsonValue CallOk(string session, string method, params JsonValue[] args)
    {
        var r = Call(session, method, args);
        Assert.True(r["ok"].AsBool(), r.ToString());
        return r["data"];
    }

    public string CallFails(string session, string method, params JsonValue[] args)
    {
        var r = Call(session, method, args);
        Assert.False(r["ok"].AsBool(), r.ToString());
        return r["code"].AsString();
    }

    public void Reply(JsonValue request, JsonValue data) =>
        Write(JsonValue.NewObject().Set("op", "result").Set("id", request["id"]).Set("ok", true).Set("data", data));

    public void Dispose()
    {
        _toEngine.Dispose();
        _fromEngine.Dispose();
    }
}

public class SidecarClientTests
{
    private static JsonValue Seat(string team) => JsonValue.NewObject().Set("team", team).Set("role", "puller");

    private static SidecarOptions Options(IGame game = null, Hooks hooks = Hooks.None) => new SidecarOptions
    {
        Manifest = Tug.Manifest(),
        Game = game ?? new TugGame(),
        Hooks = hooks,
        RequestTimeoutMs = 10000,
    };

    /// <summary>
    /// Runs the host script on its own thread. The engine side deliberately blocks the test (owner) thread, exactly as
    /// an engine main loop does, so the script is a plain thread rather than a task. After the script, the host keeps
    /// reading and hangs up at the engine's end of stream, as the real sidecar does.
    /// </summary>
    private sealed class HostScript
    {
        private readonly ManualResetEventSlim _done = new ManualResetEventSlim();
        private Exception _error;

        public HostScript(FakeHost host, Action body)
        {
            new Thread(() =>
            {
                try { body(); }
                catch (Exception e) { _error = e; }
                _done.Set();
                if (host == null) return;
                try { while (host.Read() != null) { } }
                catch (Exception) { /* the engine broke the stream; hang up all the same */ }
                host.Dispose();
            }) { IsBackground = true }.Start();
        }

        /// <summary>Waits for the script (true when it finished in time) and rethrows its assertion failures.</summary>
        public bool Wait(int timeoutMs = 20000)
        {
            if (!_done.Wait(timeoutMs)) return false;
            if (_error != null) throw new Exception("host script failed", _error);
            return true;
        }
    }

    private static HostScript Script(FakeHost host, Action body) => new HostScript(host, body);

    [Fact]
    public void HandshakeSendsHelloAndReadsReady()
    {
        var (engine, host) = FakeHost.Create();
        JsonValue hello = null;
        var script = Script(host, () => hello = host.Handshake());
        using (var sidecar = PlayerThreeSidecar.Start(engine, Options()))
        {
            script.Wait();
            Assert.Equal("hello", hello["op"].AsString());
            Assert.Equal(1, hello["protocol"].AsInt());
            Assert.True(hello["manifest"].DeepEquals(Tug.Manifest()));
            Assert.Equal("[]", hello["hooks"].ToString());
            Assert.Equal("abc123", sidecar.SurfaceHash);
            Assert.Equal("http://127.0.0.1:8787/mcp", sidecar.McpUrl);
        }
        host.Dispose();
    }

    [Fact]
    public void HandshakeRefusalClosesWithTheHostCode()
    {
        var (engine, host) = FakeHost.Create();
        var script = Script(host, () =>
        {
            host.Read();
            host.Write(JsonValue.Parse("{\"op\":\"error\",\"code\":\"invalid_manifest\",\"message\":\"doc: required\"}"));
        });
        var e = Assert.Throws<SidecarClosedException>(() => PlayerThreeSidecar.Start(engine, Options()));
        script.Wait();
        Assert.Equal("invalid_manifest", e.Reason);
        Assert.Contains("doc: required", e.Message);
        host.Dispose();
    }

    [Fact]
    public void MatchLifecycleRunsAdapterCallsOnTheOwnerThreadDuringRequests()
    {
        var (engine, host) = FakeHost.Create();
        var game = new RecordingGame();
        var script = Script(host, () =>
        {
            host.Handshake();
            var create = host.Read();
            Assert.Equal("host", create["op"].AsString());
            Assert.Equal("createMatch", create["method"].AsString());
            Assert.Equal(1, create["args"][0]["seed"].AsInt());
            Assert.Equal("{\"tick\":0}", host.CallOk("s1", "create", JsonValue.Parse("{\"seed\":1,\"teams\":[\"north\",\"south\"]}")).ToString());
            Assert.True(host.CallOk("s1", "setSeatInfo", Seat("north"), JsonValue.Parse("{\"controller\":\"agent\",\"mandate\":{}}")).IsNull);
            host.Reply(create, JsonValue.Parse("{\"session\":\"s1\",\"tick\":0}"));

            var advance = host.Read();
            Assert.Equal("advance", advance["op"].AsString());
            Assert.Equal("s1", advance["session"].AsString());
            Assert.Equal(1, advance["n"].AsInt());
            Assert.Equal("{\"ok\":true}", host.CallOk("s1", "apply", Seat("north"), JsonValue.Parse("{\"kind\":\"pull\",\"strength\":3}"), JsonValue.Parse("{\"source\":\"agent\"}")).ToString());
            Assert.Equal("{\"tick\":1}", host.CallOk("s1", "step").ToString());
            Assert.Equal("{\"tick\":1,\"rope\":3}", host.CallOk("s1", "observe", Seat("north"), 0, JsonValue.NewArray()).ToString());
            Assert.Equal("{\"rope\":3}", host.CallOk("s1", "view", "south", JsonValue.Parse("{\"snapshot\":true}")).ToString());
            Assert.Equal("running", host.CallOk("s1", "outcome", "north").AsString());
            Assert.Equal("{\"outcome\":\"running\"}", host.CallOk("s1", "report", "south").ToString());
            Assert.Equal("[]", host.CallOk("s1", "events", Seat("north"), 0).ToString());
            host.Write(JsonValue.Parse("{\"op\":\"push\",\"session\":\"s1\",\"kind\":\"ended\",\"data\":{\"outcomes\":{},\"ranks\":{}}}"));
            host.Reply(advance, JsonValue.Parse("{\"tick\":1}"));
        });

        using (var sidecar = PlayerThreeSidecar.Start(engine, Options(game)))
        {
            var pushes = new List<string>();
            sidecar.Pushed += p => pushes.Add(p.Session + ":" + p.Kind);
            var session = sidecar.CreateMatch(JsonValue.Parse("{\"seed\":1}"));
            Assert.Equal("s1", session);
            Assert.Equal(1, sidecar.Step(session, 1));
            script.Wait();
            Assert.True(sidecar.HasEnded(session));
            Assert.Equal(new[] { "s1:ended" }, pushes);
            Assert.Equal(3, ((TugMatch)((RecordingMatch)sidecar.Match(session)).Inner).Rope);
            Assert.Equal("agent", game.Match.LastContext.Source);
            Assert.All(game.Match.Threads, id => Assert.Equal(Environment.CurrentManagedThreadId, id));
            Assert.Equal(8, game.Match.Threads.Count);
        }
        host.Dispose();
    }

    [Fact]
    public void AnswersErrorCasesWithClosedCodes()
    {
        var (engine, host) = FakeHost.Create();
        var script = Script(host, () =>
        {
            host.Handshake();
            var seats = host.Read();
            host.CallOk("s1", "create", JsonValue.Parse("{\"seed\":7,\"teams\":[\"north\",\"south\"]}"));
            Assert.Equal("invalid", host.CallFails("s1", "create", JsonValue.Parse("{\"seed\":7,\"teams\":[\"north\",\"south\"]}"))); // session exists
            Assert.Equal("engine_error", host.CallFails("s5", "create", JsonValue.Parse("{\"seed\":7,\"teams\":[\"north\"]}"))); // the game refuses the sides
            Assert.Equal("invalid", host.CallFails("s6", "create", JsonValue.Parse("{\"teams\":[\"north\"]}"))); // no seed
            Assert.Equal("unknown_method", host.CallFails("s1", "teleport"));
            Assert.Equal("unknown_session", host.CallFails("s9", "step"));
            Assert.Equal("invalid", host.CallFails("s1", "observe", "north", 0, JsonValue.NewArray()));
            Assert.Equal("invalid", host.CallFails("s1", "outcome"));
            Assert.Equal("unknown_method", host.CallFails("s1", "debugView"));
            Assert.Equal("engine_error", host.CallFails("s1", "apply", Seat("north"), JsonValue.Parse("{\"kind\":\"pull\"}"), JsonValue.Null));
            var big = host.Call("s1", "report", "north");
            Assert.Equal("engine_error", big["code"].AsString());
            Assert.Contains("1048576", big["message"].AsString());

            Assert.True(host.CallOk("b1", "createBot", Seat("south"), "easy", JsonValue.Null).IsNull);
            Assert.True(host.CallOk("b1", "init", JsonValue.Null).IsNull);
            Assert.Equal("[{\"kind\":\"pull\",\"strength\":1}]", host.CallOk("b1", "think", JsonValue.Parse("{\"tick\":0,\"rope\":0}")).ToString());
            Assert.True(host.CallOk("b1", "dispose").IsNull);
            Assert.Equal("unknown_session", host.CallFails("b1", "think", JsonValue.NewObject()));
            Assert.True(host.CallOk("s1", "dispose").IsNull);
            Assert.Equal("unknown_session", host.CallFails("s1", "step"));
            host.Reply(seats, JsonValue.NewArray());
        });
        using (var sidecar = PlayerThreeSidecar.Start(engine, Options(new HugeReportGame())))
        {
            Assert.Equal("[]", sidecar.Request("seats", "s1").ToString());
            script.Wait();
        }
        host.Dispose();
    }

    [Fact]
    public void RequestFailuresCarryTheHostCode()
    {
        var (engine, host) = FakeHost.Create();
        var script = Script(host, () =>
        {
            host.Handshake();
            var advance = host.Read();
            host.Write(JsonValue.NewObject().Set("op", "result").Set("id", advance["id"]).Set("ok", false).Set("code", "paused"));
        });
        using (var sidecar = PlayerThreeSidecar.Start(engine, Options()))
        {
            Assert.Equal("paused", Assert.Throws<SidecarRequestException>(() => sidecar.Step("s1")).Code);
            script.Wait();
            Assert.True(sidecar.IsConnected);
        }
        host.Dispose();
    }

    [Fact]
    public void UnexpectedResultIsABadFrameThatClosesTheConnection()
    {
        var (engine, host) = FakeHost.Create();
        JsonValue notice = null, after = null;
        var script = Script(host, () =>
        {
            host.Handshake();
            host.Write(JsonValue.Parse("{\"op\":\"result\",\"id\":99,\"ok\":true,\"data\":null}"));
            notice = host.Read();
            after = host.Read();
        });
        using (var sidecar = PlayerThreeSidecar.Start(engine, Options()))
        {
            SidecarClosedException closed = null;
            sidecar.Closed += e => closed = e;
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (sidecar.IsConnected && DateTime.UtcNow < deadline) sidecar.Pump(50);
            sidecar.Pump();
            script.Wait();
            Assert.Equal("error", notice["op"].AsString());
            Assert.Equal("bad_frame", notice["code"].AsString());
            Assert.Null(after); // EOF: the engine closed its side
            Assert.Equal("bad_frame", closed.Reason);
        }
        host.Dispose();
    }

    [Fact]
    public void AnswersALimitSizedCallAndClosesOnAnOversizedLine()
    {
        var (engine, host) = FakeHost.Create();
        JsonValue notice = null;
        var script = Script(host, () =>
        {
            host.Handshake();
            var dispose = host.Read();
            host.CallOk("s1", "create", JsonValue.Parse("{\"seed\":1,\"teams\":[\"north\",\"south\"]}"));
            // A call of exactly 1048576 bytes (padding in an ignored member) must be answered.
            const string head = "{\"op\":\"call\",\"id\":2,\"session\":\"s1\",\"method\":\"step\",\"args\":[],\"pad\":\"";
            host.WriteRaw(head + new string('x', Framing.MaxMessageBytes - head.Length - 2) + "\"}");
            var r = host.Read();
            Assert.True(r["ok"].AsBool());
            host.WriteRaw(head + new string('x', Framing.MaxMessageBytes - head.Length - 1) + "\"}");
            notice = host.Read();
            Assert.Null(host.Read());
            GC.KeepAlive(dispose);
        });
        using (var sidecar = PlayerThreeSidecar.Start(engine, Options()))
        {
            var e = Assert.Throws<SidecarClosedException>(() => sidecar.DisposeSession("s1"));
            script.Wait();
            Assert.Equal("too_large", e.Reason);
            Assert.Equal("too_large", notice["code"].AsString());
            Assert.Equal(1, sidecar.Match("s1").Tick);
        }
        host.Dispose();
    }

    [Fact]
    public void HostDisconnectFailsTheOutstandingRequestAndRaisesClosed()
    {
        var (engine, host) = FakeHost.Create();
        var script = Script(host, () =>
        {
            host.Handshake();
            host.Read();
            host.Dispose();
        });
        using (var sidecar = PlayerThreeSidecar.Start(engine, Options()))
        {
            var raised = 0;
            sidecar.Closed += _ => raised++;
            Assert.Equal("eof", Assert.Throws<SidecarClosedException>(() => sidecar.Step("s1")).Reason);
            script.Wait();
            sidecar.Pump();
            Assert.Equal(1, raised);
            Assert.False(sidecar.IsConnected);
            Assert.Throws<SidecarClosedException>(() => sidecar.Request("seats", "s1"));
        }
    }

    [Fact]
    public void RequestTimeoutClosesTheConnection()
    {
        var (engine, host) = FakeHost.Create();
        var script = Script(host, () =>
        {
            host.Handshake();
            host.Read(); // never answered
            host.Read(); // EOF once the engine gives up
        });
        var options = Options();
        options.RequestTimeoutMs = 200;
        using (var sidecar = PlayerThreeSidecar.Start(engine, options))
        {
            Assert.Equal("timeout", Assert.Throws<SidecarClosedException>(() => sidecar.Step("s1")).Reason);
            Assert.True(script.Wait(5000));
        }
        host.Dispose();
    }

    [Fact]
    public void OnlyTheOwnerThreadPumpsAndAdapterCallsCannotReenter()
    {
        var (engine, host) = FakeHost.Create();
        PlayerThreeSidecar sidecar = null;
        var game = new ReentrantGame(() => sidecar);
        var script = Script(host, () =>
        {
            host.Handshake();
            var seats = host.Read();
            host.CallOk("s1", "create", JsonValue.Parse("{\"seed\":1,\"teams\":[\"north\",\"south\"]}"));
            Assert.Equal("engine_error", host.CallFails("s1", "step"));
            host.Reply(seats, JsonValue.NewArray());
        });
        using (sidecar = PlayerThreeSidecar.Start(engine, Options(game)))
        {
            Exception offThread = null;
            var t = new Thread(() => { try { sidecar.Pump(); } catch (Exception e) { offThread = e; } });
            t.Start();
            t.Join();
            Assert.IsType<InvalidOperationException>(offThread);
            sidecar.Request("seats", "s1");
            script.Wait();
            Assert.IsType<InvalidOperationException>(game.Seen);
        }
        host.Dispose();
    }

    [Fact]
    public void DeclaredHooksAreRequiredAndAnswered()
    {
        var (engine, host) = FakeHost.Create();
        JsonValue hello = null;
        var script = Script(host, () =>
        {
            hello = host.Handshake();
            var seats = host.Read();
            Assert.Equal("engine_error", host.CallFails("s1", "create", JsonValue.Parse("{\"seed\":1,\"teams\":[\"north\",\"south\"]}")));
            host.CallOk("s2", "create", JsonValue.Parse("{\"seed\":2,\"teams\":[\"north\",\"south\"]}"));
            Assert.Equal("{\"rope\":0,\"tick\":0}", host.CallOk("s2", "debugView").ToString());
            Assert.Equal("{\"tick\":0}", host.CallOk("s2", "clone", "s3").ToString());
            Assert.Equal("{\"rope\":0,\"tick\":0}", host.CallOk("s3", "debugView").ToString());
            Assert.Equal("invalid", host.CallFails("s2", "clone", "s3"));
            host.Reply(seats, JsonValue.NewArray());
        });
        var game = new HookGame();
        using (var sidecar = PlayerThreeSidecar.Start(engine, Options(game, Hooks.DebugView | Hooks.Clone)))
        {
            sidecar.Request("seats", "s2");
            script.Wait();
            Assert.Equal("[\"debugView\",\"clone\"]", hello["hooks"].ToString());
            Assert.NotSame(sidecar.Match("s2"), sidecar.Match("s3"));
        }
        host.Dispose();
    }

    [Fact]
    public void ConnectsOverAUnixDomainSocket()
    {
        if (!Socket.OSSupportsUnixDomainSockets) return;
        var path = Path.Combine(Path.GetTempPath(), $"p3-sidecar-test-{Guid.NewGuid():N}.sock");
        using var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        listener.Bind(new UnixDomainSocketEndPoint(path));
        listener.Listen(1);
        var script = Script(null, () =>
        {
            using var conn = listener.Accept();
            using var stream = new NetworkStream(conn, true);
            var host = FakeHost.Over(stream);
            host.Handshake();
            Assert.Null(host.Read()); // engine disposes → EOF
        });
        var previous = Environment.GetEnvironmentVariable(SidecarTransport.SocketEnvironmentVariable);
        Environment.SetEnvironmentVariable(SidecarTransport.SocketEnvironmentVariable, path);
        try
        {
            using (var sidecar = PlayerThreeSidecar.Start(SidecarTransport.FromEnvironment(), Options()))
                Assert.Equal("abc123", sidecar.SurfaceHash);
            Assert.True(script.Wait(5000));
        }
        finally
        {
            Environment.SetEnvironmentVariable(SidecarTransport.SocketEnvironmentVariable, previous);
            File.Delete(path);
        }
    }

    // ---------------------------------------------------------------- test games

    private sealed class RecordingGame : IGame
    {
        public RecordingMatch Match;
        public IAdapter Create(CreateRequest request) => Match = new RecordingMatch(new TugMatch());
        public IBot CreateBot(PlayerThree.Sidecar.Seat seat, string opponent, JsonValue options) => new TugBot();
    }

    private sealed class RecordingMatch : IAdapter
    {
        public readonly IAdapter Inner;
        public readonly List<int> Threads = new List<int>();
        public IntentContext LastContext;
        public RecordingMatch(IAdapter inner) { Inner = inner; }
        private void Note() => Threads.Add(Environment.CurrentManagedThreadId);
        public int Tick => Inner.Tick;
        public void Step() { Note(); Inner.Step(); }
        public Outcome Outcome(string team) { Note(); return Inner.Outcome(team); }
        public JsonValue View(string team, bool snapshot) { Note(); Assert.True(snapshot); return Inner.View(team, snapshot); }
        public JsonValue Observe(PlayerThree.Sidecar.Seat seat, int sinceTick, IReadOnlyList<string> detail) { Note(); return Inner.Observe(seat, sinceTick, detail); }
        public ApplyResult Apply(PlayerThree.Sidecar.Seat seat, JsonValue intent, IntentContext context) { Note(); LastContext = context; return Inner.Apply(seat, intent, context); }
        public JsonValue Report(string team) { Note(); return Inner.Report(team); }
        public JsonValue Events(PlayerThree.Sidecar.Seat seat, int sinceTick) { Note(); return Inner.Events(seat, sinceTick); }
        public void SetSeatInfo(PlayerThree.Sidecar.Seat seat, SeatInfo info) { Note(); Assert.Equal("agent", info.Controller); }
    }

    /// <summary>Tug, except a one-team match is refused and the report is larger than one message.</summary>
    private sealed class HugeReportGame : IGame
    {
        public IAdapter Create(CreateRequest request)
        {
            if (request.Teams.Count != 2) throw new ArgumentException("Tug needs both teams");
            return new HugeReport();
        }
        public IBot CreateBot(PlayerThree.Sidecar.Seat seat, string opponent, JsonValue options) => new TugBot();
    }

    private sealed class HugeReport : IAdapter
    {
        private readonly TugMatch _m = new TugMatch();
        public int Tick => _m.Tick;
        public void Step() => _m.Step();
        public Outcome Outcome(string team) => _m.Outcome(team);
        public JsonValue View(string team, bool snapshot) => _m.View(team, snapshot);
        public JsonValue Observe(PlayerThree.Sidecar.Seat seat, int sinceTick, IReadOnlyList<string> detail) => _m.Observe(seat, sinceTick, detail);
        public ApplyResult Apply(PlayerThree.Sidecar.Seat seat, JsonValue intent, IntentContext context) => _m.Apply(seat, intent, context);
        public JsonValue Report(string team) => JsonValue.NewObject().Set("outcome", new string('x', Framing.MaxMessageBytes));
        public JsonValue Events(PlayerThree.Sidecar.Seat seat, int sinceTick) => _m.Events(seat, sinceTick);
        public void SetSeatInfo(PlayerThree.Sidecar.Seat seat, SeatInfo info) { }
    }

    private sealed class ReentrantGame : IGame
    {
        private readonly Func<PlayerThreeSidecar> _sidecar;
        public Exception Seen;
        public ReentrantGame(Func<PlayerThreeSidecar> sidecar) { _sidecar = sidecar; }
        public IAdapter Create(CreateRequest request) => new Reentrant(this);
        public IBot CreateBot(PlayerThree.Sidecar.Seat seat, string opponent, JsonValue options) => new TugBot();

        private sealed class Reentrant : IAdapter
        {
            private readonly ReentrantGame _g;
            public Reentrant(ReentrantGame g) { _g = g; }
            public int Tick => 0;
            public void Step()
            {
                try { _g._sidecar().Step("s1"); }
                catch (Exception e) { _g.Seen = e; throw; }
            }
            public Outcome Outcome(string team) => PlayerThree.Sidecar.Outcome.Running;
            public JsonValue View(string team, bool snapshot) => JsonValue.NewObject();
            public JsonValue Observe(PlayerThree.Sidecar.Seat seat, int sinceTick, IReadOnlyList<string> detail) => JsonValue.NewObject();
            public ApplyResult Apply(PlayerThree.Sidecar.Seat seat, JsonValue intent, IntentContext context) => ApplyResult.Accepted;
            public JsonValue Report(string team) => JsonValue.NewObject();
            public JsonValue Events(PlayerThree.Sidecar.Seat seat, int sinceTick) => JsonValue.NewArray();
            public void SetSeatInfo(PlayerThree.Sidecar.Seat seat, SeatInfo info) { }
        }
    }

    /// <summary>First match lacks the declared hooks; later ones implement them.</summary>
    private sealed class HookGame : IGame
    {
        private int _created;
        public IAdapter Create(CreateRequest request) => _created++ == 0 ? (IAdapter)new TugMatch() : new HookedTug(new TugMatch());
        public IBot CreateBot(PlayerThree.Sidecar.Seat seat, string opponent, JsonValue options) => new TugBot();
    }

    private sealed class HookedTug : IAdapter, IDebugViewAdapter, ICloneAdapter
    {
        private readonly TugMatch _m;
        public HookedTug(TugMatch m) { _m = m; }
        public JsonValue DebugView() => JsonValue.NewObject().Set("rope", _m.Rope).Set("tick", _m.Tick);
        public IAdapter Clone() => new HookedTug(new TugMatch());
        public int Tick => _m.Tick;
        public void Step() => _m.Step();
        public Outcome Outcome(string team) => _m.Outcome(team);
        public JsonValue View(string team, bool snapshot) => _m.View(team, snapshot);
        public JsonValue Observe(PlayerThree.Sidecar.Seat seat, int sinceTick, IReadOnlyList<string> detail) => _m.Observe(seat, sinceTick, detail);
        public ApplyResult Apply(PlayerThree.Sidecar.Seat seat, JsonValue intent, IntentContext context) => _m.Apply(seat, intent, context);
        public JsonValue Report(string team) => _m.Report(team);
        public JsonValue Events(PlayerThree.Sidecar.Seat seat, int sinceTick) => _m.Events(seat, sinceTick);
        public void SetSeatInfo(PlayerThree.Sidecar.Seat seat, SeatInfo info) { }
    }
}
