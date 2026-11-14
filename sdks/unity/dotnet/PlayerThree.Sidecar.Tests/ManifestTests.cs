// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.IO;
using PlayerThree.Samples.TugOfWar;
using PlayerThree.Sidecar;
using Xunit;

public class ManifestTests
{
    [Fact]
    public void TugManifestMatchesTheConformanceFixtureMemberForMember()
    {
        // The sidecar conformance fixture, re-serialized compactly in its own member order: the builder must produce the
        // same members, values and order as the TypeScript defineManifest input it was recorded from.
        string fixture = null;
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null && fixture == null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "packages", "sidecar", "conformance", "tug.manifest.json");
            if (File.Exists(candidate)) fixture = candidate;
        }
        Assert.True(fixture != null, "packages/sidecar/conformance/tug.manifest.json not found above the test binaries");
        Assert.Equal(JsonValue.Parse(File.ReadAllText(fixture)).ToString(), Tug.Manifest().ToString());
    }

    [Fact]
    public void SchemaNodesMatchTheTypeScriptShapes()
    {
        Assert.Equal("{\"t\":\"int\",\"min\":-10,\"max\":10,\"doc\":\"+ is north\"}", T.Int(-10, 10, "+ is north").ToString());
        Assert.Equal("{\"t\":\"enum\",\"values\":[\"a\",\"b\"],\"doc\":\"d\"}", T.Enum(new[] { "a", "b" }, "d").ToString());
        Assert.Equal("{\"t\":\"str\",\"maxLength\":8,\"pattern\":\"^[a-z]+$\"}", T.Str(8, "^[a-z]+$").ToString());
        Assert.Equal("{\"t\":\"ints\",\"maxItems\":4,\"min\":0,\"max\":9}", T.Ints(4, 0, 9).ToString());
        Assert.Equal("{\"t\":\"num\",\"min\":0,\"max\":1.5}", T.Num(0, 1.5).ToString());
        Assert.Equal("{\"t\":\"id\",\"prefix\":\"u\"}", T.Id("u").ToString());
        Assert.Equal("{\"t\":\"list\",\"item\":{\"t\":\"bool\"},\"max\":3}", T.List(T.Bool(), 3).ToString());
        Assert.Equal("{\"t\":\"obj\",\"fields\":{\"a\":{\"t\":\"opt\",\"item\":{\"t\":\"bool\"}}},\"doc\":\"o\"}", T.Obj(("a", T.Opt(T.Bool()))).Doc("o").ToString());
        Assert.Equal("{\"t\":\"obj\",\"fields\":{},\"merge\":\"replace\"}", T.ObjReplace().ToString());
        Assert.Equal(
            "{\"t\":\"union\",\"tag\":\"kind\",\"variants\":{\"move\":{\"x\":{\"t\":\"int\",\"min\":0,\"max\":9}},\"stop\":{}}}",
            T.Union("kind", ("move", new[] { ("x", T.Int(0, 9)) }), ("stop", Array.Empty<(string, Schema)>())).ToString());
    }

    [Fact]
    public void SchemaBuildersRejectUnsafeShapes()
    {
        Assert.Throws<ArgumentException>(() => T.Enum());
        Assert.Throws<ArgumentException>(() => T.Enum("a", "a"));
        Assert.Throws<ArgumentException>(() => T.Enum("1bad"));
        Assert.Throws<ArgumentException>(() => T.Int(5, 1));
        Assert.Throws<ArgumentException>(() => T.Int(0, JsonValue.MaxSafeInteger + 1));
        Assert.Throws<ArgumentException>(() => T.Num(0, double.PositiveInfinity));
        Assert.Throws<ArgumentException>(() => T.Str(100001));
        Assert.Throws<ArgumentException>(() => T.Str(8, "[a-z]+"));
        Assert.Throws<ArgumentException>(() => T.Id("Upper"));
        Assert.Throws<ArgumentException>(() => T.Obj(("bad-name", T.Bool())));
        Assert.Throws<ArgumentException>(() => T.Obj(("a", T.Bool()), ("a", T.Bool())));
        Assert.Throws<ArgumentException>(() => T.List(T.Opt(T.Bool()), 1));
        Assert.Throws<ArgumentException>(() => T.Union("kind", ("v", new[] { ("kind", T.Bool()) })));
        Assert.Throws<ArgumentException>(() => T.Bool().Doc(new string('d', 4001)));
    }

    private static ManifestBuilder Minimal() =>
        new ManifestBuilder("g", "1", "G").Doc("d").TickRate(1).Teams("a", "b").Roles("r").RoleDoc("r", "rd")
            .Intent("go", new[] { "r" }, "go")
            .Observation(T.Obj()).View(T.Obj()).Report(T.Obj()).Event(T.Obj(("tick", T.Int(0, 9)), ("kind", T.Enum("k"))))
            .Directive(T.Obj()).Errors("e").Opponents("o").IntentRate(1, 1);

    [Fact]
    public void BuilderReportsMissingAndInconsistentMembers()
    {
        Assert.Equal("{\"perSecond\":1,\"burst\":1}", Minimal().Build()["control"]["intents"].ToString());
        Assert.Contains("roleDocs.x", Assert.Throws<ArgumentException>(() => Minimal().Roles("r", "x").Build()).Message);
        Assert.Contains("intents.go2.roles", Assert.Throws<ArgumentException>(() => Minimal().Intent("go2", new[] { "nope" }, "d").Build()).Message);
        Assert.Contains("event.tick", Assert.Throws<ArgumentException>(() => Minimal().Event(T.Obj(("kind", T.Enum("k")))).Build()).Message);
        Assert.Contains("observation.phase", Assert.Throws<ArgumentException>(() => Minimal().Observation(T.Obj(("phase", T.Bool()))).Build()).Message);
        Assert.Contains("limits.x", Assert.Throws<ArgumentException>(() => Minimal().Limits(T.Obj(("x", T.Bool()))).Build()).Message);
        Assert.Contains("kind", Assert.Throws<ArgumentException>(() => Minimal().Intent("k2", new[] { "r" }, "d", ("kind", T.Bool()))).Message);
        Assert.Contains("signals", Assert.Throws<ArgumentException>(() => Minimal().ControlMode("signals", JsonValue.NewObject())).Message);
    }

    [Fact]
    public void BuilderEmitsOptionalMembersInManifestOrder()
    {
        var m = Minimal()
            .ObservationScope(new[] { "units", "map" }, new Dictionary<string, string[]> { ["r"] = new[] { "units" } })
            .MatchData(T.Obj(("size", T.Int(1, 9))))
            .MatchOptions(T.Obj(("map", T.Opt(T.Enum("small")))))
            .Topic("rules", "The rules.", "Long text.")
            .ControlMode("sequence", JsonValue.Parse("{\"maxSteps\":4,\"maxTicksAhead\":10,\"minSpacingTicks\":1}"))
            .Build();
        var keys = new List<string>();
        foreach (var p in m.Properties) keys.Add(p.Key);
        Assert.Equal(new[] { "id", "version", "title", "tickRate", "doc", "teams", "roles", "roleDocs", "intents", "observation", "observationScope", "view", "matchData", "report", "event", "directive", "matchOptions", "errors", "opponents", "topics", "skills", "control" }, keys);
        Assert.Equal("{\"sections\":{\"t\":\"enum\",\"values\":[\"units\",\"map\"]},\"defaults\":{\"r\":[\"units\"]}}", m["observationScope"].ToString());
        Assert.Equal(4, m["control"]["sequence"]["maxSteps"].AsInt());
    }

    [Fact]
    public void HooksAreDerivedFromAdapterInterfaces()
    {
        Assert.Equal(Hooks.None, HookSet.Of<TugMatch>());
        Assert.Equal(Hooks.MatchData | Hooks.End, HookSet.Of(typeof(HookedMatch)));
    }

    private abstract class HookedMatch : IMatchDataAdapter, IEndAdapter
    {
        public abstract JsonValue MatchData(Seat seat);
        public abstract void End(IReadOnlyDictionary<string, Outcome> outcomes, IReadOnlyDictionary<string, int> ranks);
    }
}
