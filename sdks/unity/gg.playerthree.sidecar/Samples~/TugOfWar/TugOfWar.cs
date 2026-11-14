// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using PlayerThree.Sidecar;

namespace PlayerThree.Samples.TugOfWar
{
    /// <summary>
    /// The README's Tug of War as a native C# game: two teams pull a rope; the first to drag it to their end (±10) wins.
    /// Engine-independent, so the Unity sample and the .NET console sample share it unchanged.
    /// </summary>
    public static class Tug
    {
        /// <summary>The game's plain-JSON manifest (SPEC §3).</summary>
        public static JsonValue Manifest() =>
            new ManifestBuilder("tug", "1.0.0", "Tug of War")
                .TickRate(10)
                .Doc("Pull the rope to your side (±10) to win.")
                .Teams("north", "south")
                .Roles("puller")
                .RoleDoc("puller", "Pulls the rope.")
                .Intent("pull", new[] { "puller" }, "Pull this tick.", ("strength", T.Int(1, 3)))
                .Observation(T.Obj(("tick", T.Int(0, 100000)), ("rope", T.Int(-10, 10, "+ is north"))))
                .View(T.Obj(("rope", T.Int(-10, 10))))
                .Report(T.Obj(("outcome", T.Enum("win", "loss", "draw", "running"))))
                .Event(T.Obj(("tick", T.Int(0, 100000)), ("kind", T.Enum("slip"))))
                .Directive(T.Obj())
                .Errors("tired")
                .Opponents("easy")
                .IntentRate(4, 4)
                .Build();
    }

    /// <summary>The match factory and built-in bots.</summary>
    public sealed class TugGame : IGame
    {
        public IAdapter Create(CreateRequest request) => new TugMatch();
        public IBot CreateBot(Seat seat, string opponent, JsonValue options) => new TugBot();
    }

    /// <summary>One match: the rope position, +10 is north's end.</summary>
    public sealed class TugMatch : IAdapter
    {
        public int Tick { get; private set; }
        public int Rope { get; private set; }

        public void Step() => Tick++;

        public Outcome Outcome(string team) =>
            Math.Abs(Rope) < 10 ? PlayerThree.Sidecar.Outcome.Running
            : (Rope > 0) == (team == "north") ? PlayerThree.Sidecar.Outcome.Win : PlayerThree.Sidecar.Outcome.Loss;

        public JsonValue Observe(Seat seat, int sinceTick, IReadOnlyList<string> detail) =>
            JsonValue.NewObject().Set("tick", Tick).Set("rope", Rope);

        public JsonValue View(string team, bool snapshot) => JsonValue.NewObject().Set("rope", Rope);

        public ApplyResult Apply(Seat seat, JsonValue intent, IntentContext context)
        {
            var strength = intent["strength"].AsInt();
            Rope = Math.Max(-10, Math.Min(10, Rope + (seat.Team == "north" ? strength : -strength)));
            return ApplyResult.Accepted;
        }

        public JsonValue Report(string team)
        {
            string outcome;
            switch (Outcome(team))
            {
                case PlayerThree.Sidecar.Outcome.Win: outcome = "win"; break;
                case PlayerThree.Sidecar.Outcome.Loss: outcome = "loss"; break;
                case PlayerThree.Sidecar.Outcome.Draw: outcome = "draw"; break;
                default: outcome = "running"; break;
            }
            return JsonValue.NewObject().Set("outcome", outcome);
        }

        public JsonValue Events(Seat seat, int sinceTick) => JsonValue.NewArray();

        public void SetSeatInfo(Seat seat, SeatInfo info) { }
    }

    /// <summary>The <c>easy</c> bot: always pulls with strength 1.</summary>
    public sealed class TugBot : IBot
    {
        public void Init(JsonValue matchData) { }

        public JsonValue Think(JsonValue observation) =>
            JsonValue.ArrayOf(JsonValue.NewObject().Set("kind", "pull").Set("strength", 1));
    }
}
