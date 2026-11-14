// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace PlayerThree.Sidecar
{
    /// <summary>One seat: a manifest team and role.</summary>
    public readonly struct Seat : IEquatable<Seat>
    {
        /// <summary>Manifest team (side).</summary>
        public string Team { get; }
        /// <summary>Manifest role.</summary>
        public string Role { get; }

        /// <summary>The seat <paramref name="team"/>/<paramref name="role"/>.</summary>
        public Seat(string team, string role)
        {
            Team = team ?? throw new ArgumentNullException(nameof(team));
            Role = role ?? throw new ArgumentNullException(nameof(role));
        }

        /// <summary>The seat's wire form <c>{"team","role"}</c>.</summary>
        public JsonValue ToJson() => JsonValue.NewObject().Set("team", Team).Set("role", Role);

        internal static Seat FromJson(JsonValue v) => new Seat(v["team"].AsString(), v["role"].AsString());

        public bool Equals(Seat other) => Team == other.Team && Role == other.Role;
        public override bool Equals(object obj) => obj is Seat s && Equals(s);
        public override int GetHashCode() => (Team?.GetHashCode() ?? 0) * 31 + (Role?.GetHashCode() ?? 0);
        public override string ToString() => Team + "/" + Role;
    }

    /// <summary>A side's outcome (SPEC §10 <c>outcome(team)</c>).</summary>
    public enum Outcome { Running, Win, Loss, Draw }

    /// <summary>What <see cref="IAdapter.Apply"/> returns: accepted, or rejected with a manifest <c>errors</c> code.</summary>
    public readonly struct ApplyResult
    {
        /// <summary>True when the game accepted the intent.</summary>
        public bool Ok { get; }
        /// <summary>The manifest error code when rejected; null when accepted.</summary>
        public string Code { get; }

        private ApplyResult(bool ok, string code) { Ok = ok; Code = code; }

        /// <summary>Accepted.</summary>
        public static ApplyResult Accepted => new ApplyResult(true, null);
        /// <summary>Rejected with one of the manifest's declared <c>errors</c>.</summary>
        public static ApplyResult Rejected(string code) => new ApplyResult(false, code ?? throw new ArgumentNullException(nameof(code)));

        internal JsonValue ToJson() => Ok ? JsonValue.NewObject().Set("ok", true) : JsonValue.NewObject().Set("ok", false).Set("code", Code);
    }

    /// <summary>Trusted provenance of an applied intent, supplied by the host (SPEC §4 <i>Owner control</i>).</summary>
    public sealed class IntentContext
    {
        /// <summary><c>owner</c>, <c>agent</c>, <c>policy</c>, <c>bot</c> or <c>fallback</c>.</summary>
        public string Source { get; }
        /// <summary>Same-team roles the owner controls; null means this seat's role only.</summary>
        public IReadOnlyList<string> OwnerRoles { get; }

        internal IntentContext(string source, IReadOnlyList<string> ownerRoles) { Source = source; OwnerRoles = ownerRoles; }

        internal static IntentContext FromJson(JsonValue v)
        {
            if (v == null || v.IsNull) return null;
            List<string> roles = null;
            if (v.TryGet("ownerRoles", out var r))
            {
                roles = new List<string>();
                foreach (var item in r.Items) roles.Add(item.AsString());
            }
            return new IntentContext(v["source"].AsString(), roles);
        }
    }

    /// <summary>Controller disclosure and the owner's mandate for a seat (<c>setSeatInfo</c>).</summary>
    public sealed class SeatInfo
    {
        /// <summary><c>human</c>, <c>agent</c>, <c>policy</c>, <c>bot</c> or <c>none</c>.</summary>
        public string Controller { get; }
        /// <summary>The mandate as plain JSON (directive, limits, whenAbsent, …; SPEC §7).</summary>
        public JsonValue Mandate { get; }

        internal SeatInfo(string controller, JsonValue mandate) { Controller = controller; Mandate = mandate; }
    }

    /// <summary>The host's <c>create</c> call: one new match of these sides.</summary>
    public sealed class CreateRequest
    {
        /// <summary>The host-assigned session id of the match (<c>s1</c>, <c>s2</c>, …).</summary>
        public string Session { get; }
        /// <summary>Deterministic seed.</summary>
        public long Seed { get; }
        /// <summary>Validated <c>manifest.matchOptions</c>, or null.</summary>
        public JsonValue Options { get; }
        /// <summary>The match's sides: a non-empty subset of manifest teams, in manifest order.</summary>
        public IReadOnlyList<string> Teams { get; }
        /// <summary>Alliance id → member teams, or null when the match declares none.</summary>
        public IReadOnlyDictionary<string, IReadOnlyList<string>> Alliances { get; }

        internal CreateRequest(string session, long seed, JsonValue options, IReadOnlyList<string> teams, IReadOnlyDictionary<string, IReadOnlyList<string>> alliances)
        {
            Session = session; Seed = seed; Options = options; Teams = teams; Alliances = alliances;
        }
    }

    /// <summary>
    /// The game: its match factory and its built-in bots. The host forwards both over the sidecar, so a game without
    /// bots still answers <see cref="CreateBot"/> (practice, absent seats and fallback use them).
    /// </summary>
    public interface IGame
    {
        /// <summary>A new match. Throw when the game cannot play the requested side set; the host's create fails.</summary>
        IAdapter Create(CreateRequest request);
        /// <summary>A built-in bot for a seat at strength <paramref name="opponent"/> (a manifest <c>opponents</c> literal); <paramref name="options"/> is null or the validated bot options.</summary>
        IBot CreateBot(Seat seat, string opponent, JsonValue options);
    }

    /// <summary>A built-in commander. Uses exactly the same intents as agents.</summary>
    public interface IBot
    {
        /// <summary>Runs once before the first <see cref="Think"/> with the seat's guarded match data, or JSON null.</summary>
        void Init(JsonValue matchData);
        /// <summary>Intents for this observation: a JSON array of <c>{"kind",…}</c>.</summary>
        JsonValue Think(JsonValue observation);
    }

    /// <summary>
    /// One running match (SPEC §10), JSON in and JSON out. Every call is synchronous with respect to the tick and runs
    /// on the thread that owns the <see cref="PlayerThreeSidecar"/> (inside <see cref="PlayerThreeSidecar.Pump()"/>,
    /// <see cref="PlayerThreeSidecar.Step"/> or <see cref="PlayerThreeSidecar.Request"/>), so adapter code may touch
    /// engine state without locks. The host guards every returned value against the manifest. An adapter that also
    /// implements <see cref="IDisposable"/> is disposed when the host disposes its session.
    /// </summary>
    public interface IAdapter
    {
        /// <summary>Current simulation tick, monotonically increasing.</summary>
        int Tick { get; }
        /// <summary>Advance one simulation tick.</summary>
        void Step();
        /// <summary>The side's outcome.</summary>
        Outcome Outcome(string team);
        /// <summary><c>manifest.view</c> for the side; <paramref name="snapshot"/> marks a client's first view.</summary>
        JsonValue View(string team, bool snapshot);
        /// <summary><c>manifest.observation</c> for the seat, fogged, events newer than <paramref name="sinceTick"/>; <paramref name="detail"/> lists sections to render in full.</summary>
        JsonValue Observe(Seat seat, int sinceTick, IReadOnlyList<string> detail);
        /// <summary>Apply a schema-validated, role-checked intent (<c>{"kind",…params}</c>); <paramref name="context"/> null means a direct owner call.</summary>
        ApplyResult Apply(Seat seat, JsonValue intent, IntentContext context);
        /// <summary><c>manifest.report</c> for the side.</summary>
        JsonValue Report(string team);
        /// <summary>Visible events with tick &gt; <paramref name="sinceTick"/>, oldest first: a JSON array of <c>manifest.event</c>.</summary>
        JsonValue Events(Seat seat, int sinceTick);
        /// <summary>Controller disclosure and the owner's mandate for a seat.</summary>
        void SetSeatInfo(Seat seat, SeatInfo info);
    }

    /// <summary>Hook <c>matchData</c>, required when the manifest declares <c>matchData</c>: immutable seat-visible bootstrap.</summary>
    public interface IMatchDataAdapter
    {
        /// <summary><c>manifest.matchData</c> for the seat.</summary>
        JsonValue MatchData(Seat seat);
    }

    /// <summary>Hook <c>debugView</c>: developer-only unfogged snapshot, never sent to players or agents.</summary>
    public interface IDebugViewAdapter
    {
        /// <summary>Bounded JSON snapshot.</summary>
        JsonValue DebugView();
    }

    /// <summary>Hook <c>observerView</c>: omniscient observer data conforming to <c>manifest.observer</c>.</summary>
    public interface IObserverViewAdapter
    {
        /// <summary>Observer data.</summary>
        JsonValue ObserverView();
    }

    /// <summary>Hook <c>end</c>: adopt host-declared final outcomes and ranks.</summary>
    public interface IEndAdapter
    {
        /// <summary>Final outcome and rank per match team.</summary>
        void End(IReadOnlyDictionary<string, Outcome> outcomes, IReadOnlyDictionary<string, int> ranks);
    }

    /// <summary>Hook <c>forfeit</c>: the team concedes; take it out of play (deterministically, like apply).</summary>
    public interface IForfeitAdapter
    {
        /// <summary>The team concedes now.</summary>
        void Forfeit(string team);
    }

    /// <summary>Hook <c>rank</c>: final competition placement of a team, read once every match team is final.</summary>
    public interface IRankAdapter
    {
        /// <summary>1 is best; ties share a rank and the next rank skips.</summary>
        int Rank(string team);
    }

    /// <summary>Hook <c>clone</c>: an independent copy of the running match (state and RNG), for checkpoints.</summary>
    public interface ICloneAdapter
    {
        /// <summary>The copy; it never shares mutable state with this match.</summary>
        IAdapter Clone();
    }

    /// <summary>The optional adapter calls an engine answers, declared in <c>hello</c>.</summary>
    [Flags]
    public enum Hooks
    {
        None = 0,
        MatchData = 1,
        DebugView = 2,
        ObserverView = 4,
        End = 8,
        Forfeit = 16,
        Rank = 32,
        Clone = 64,
    }

    /// <summary>Helpers for <see cref="Hooks"/>.</summary>
    public static class HookSet
    {
        internal static readonly (Hooks flag, string wire, Type iface)[] All =
        {
            (Hooks.MatchData, "matchData", typeof(IMatchDataAdapter)),
            (Hooks.DebugView, "debugView", typeof(IDebugViewAdapter)),
            (Hooks.ObserverView, "observerView", typeof(IObserverViewAdapter)),
            (Hooks.End, "end", typeof(IEndAdapter)),
            (Hooks.Forfeit, "forfeit", typeof(IForfeitAdapter)),
            (Hooks.Rank, "rank", typeof(IRankAdapter)),
            (Hooks.Clone, "clone", typeof(ICloneAdapter)),
        };

        /// <summary>The hooks an adapter type implements (declare these in <see cref="SidecarOptions.Hooks"/>).</summary>
        public static Hooks Of(Type adapterType)
        {
            var h = Hooks.None;
            foreach (var (flag, _, iface) in All) if (iface.IsAssignableFrom(adapterType)) h |= flag;
            return h;
        }

        /// <summary>The hooks <typeparamref name="TAdapter"/> implements.</summary>
        public static Hooks Of<TAdapter>() where TAdapter : IAdapter => Of(typeof(TAdapter));

        internal static JsonValue ToJson(Hooks hooks)
        {
            var a = JsonValue.NewArray();
            foreach (var (flag, wire, _) in All) if ((hooks & flag) != 0) a.Add(wire);
            return a;
        }
    }
}
