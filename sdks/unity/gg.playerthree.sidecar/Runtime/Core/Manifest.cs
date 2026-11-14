// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace PlayerThree.Sidecar
{
    /// <summary>
    /// Builds the plain-JSON game manifest (SPEC §3) that the engine sends in <c>hello</c>. Member names and shapes are
    /// exactly those of the TypeScript <c>GameManifest</c>; the builder checks what it can locally (required members,
    /// roles of intents and role docs, the event's <c>tick</c>/<c>kind</c>) and the host runs the full
    /// <c>defineManifest</c> validation at <c>hello</c>, replying <c>error</c> for anything it cannot serve.
    /// </summary>
    public sealed class ManifestBuilder
    {
        private readonly string _id;
        private readonly string _version;
        private readonly string _title;
        private string _doc;
        private double? _tickRate;
        private Schema _teams, _roles, _errors, _opponents;
        private readonly JsonValue _roleDocs = JsonValue.NewObject();
        private readonly JsonValue _intents = JsonValue.NewObject();
        private readonly Dictionary<string, string[]> _intentRoles = new Dictionary<string, string[]>(StringComparer.Ordinal);
        private Schema _observation, _view, _report, _event, _directive;
        private Schema _observer, _matchData, _lobby, _limits, _matchOptions;
        private JsonValue _observationScope;
        private readonly JsonValue _topics = JsonValue.NewObject();
        private readonly JsonValue _skills = JsonValue.NewArray();
        private readonly JsonValue _control = JsonValue.NewObject();

        /// <summary>A manifest for game <paramref name="id"/> (<c>^[a-z][a-z0-9-]{0,47}$</c>) at a version and title.</summary>
        public ManifestBuilder(string id, string version, string title)
        {
            _id = id ?? throw new ArgumentNullException(nameof(id));
            _version = version ?? throw new ArgumentNullException(nameof(version));
            _title = title ?? throw new ArgumentNullException(nameof(title));
        }

        /// <summary>Core rules every seat reads first (≤ 6000 chars; details belong in topics).</summary>
        public ManifestBuilder Doc(string doc) { _doc = doc; return this; }
        /// <summary>Simulation ticks per second of game time (1..1000).</summary>
        public ManifestBuilder TickRate(double ticksPerSecond) { _tickRate = ticksPerSecond; return this; }
        /// <summary>The game's sides.</summary>
        public ManifestBuilder Teams(params string[] teams) { _teams = T.Enum(teams); return this; }
        /// <summary>The seat roles within a side.</summary>
        public ManifestBuilder Roles(params string[] roles) { _roles = T.Enum(roles); return this; }
        /// <summary>Per-role agent briefing (every role needs one).</summary>
        public ManifestBuilder RoleDoc(string role, string doc) { _roleDocs.Set(role, doc); return this; }
        /// <summary>Game-level <c>apply</c> failure codes.</summary>
        public ManifestBuilder Errors(params string[] codes) { _errors = T.Enum(codes); return this; }
        /// <summary>Built-in bot strengths, weakest first.</summary>
        public ManifestBuilder Opponents(params string[] levels) { _opponents = T.Enum(levels); return this; }

        /// <summary>One intent kind: the roles that may send it, its tool doc and its parameter fields.</summary>
        public ManifestBuilder Intent(string kind, string[] roles, string doc, params (string name, Schema schema)[] parameters)
        {
            if (!T.IsEnumLiteral(kind)) throw Fail($"intents.{kind}: intent name must be an enum literal");
            if (_intents.Has(kind)) throw Fail($"intents.{kind}: declared twice");
            if (roles == null || roles.Length == 0) throw Fail($"intents.{kind}.roles: must list at least one role");
            foreach (var p in parameters ?? Array.Empty<(string, Schema)>()) if (p.name == "kind") throw Fail($"intents.{kind}.params: `kind` is reserved for the intent tag");
            _intentRoles[kind] = (string[])roles.Clone();
            _intents.Set(kind, JsonValue.NewObject().Set("roles", JsonValue.Strings(roles)).Set("params", T.Fields(parameters)).Set("doc", doc));
            return this;
        }

        /// <summary>Seat-focused, fogged agent observation (top-level <c>phase</c> is reserved).</summary>
        public ManifestBuilder Observation(Schema s) { _observation = s; return this; }
        /// <summary>Team-level fogged render state for human clients.</summary>
        public ManifestBuilder View(Schema s) { _view = s; return this; }
        /// <summary>After-action report for one side.</summary>
        public ManifestBuilder Report(Schema s) { _report = s; return this; }
        /// <summary>One seat-visible event: an obj with <c>tick: int</c> and <c>kind: enum</c>.</summary>
        public ManifestBuilder Event(Schema s) { _event = s; return this; }
        /// <summary>Typed owner → agent guidance (an obj; <c>T.Obj()</c> for none).</summary>
        public ManifestBuilder Directive(Schema s) { _directive = s; return this; }
        /// <summary>Optional omniscient observer data.</summary>
        public ManifestBuilder Observer(Schema s) { _observer = s; return this; }
        /// <summary>Optional immutable seat-visible bootstrap (an obj); requires <see cref="IMatchDataAdapter"/>.</summary>
        public ManifestBuilder MatchData(Schema s) { _matchData = s; return this; }
        /// <summary>Optional pre-match lobby summary (an obj).</summary>
        public ManifestBuilder Lobby(Schema s) { _lobby = s; return this; }
        /// <summary>Optional owner house rules (an obj of <c>T.Opt</c> fields) the adapter enforces in <c>apply</c>.</summary>
        public ManifestBuilder Limits(Schema s) { _limits = s; return this; }
        /// <summary>Optional match options (an obj of <c>T.Opt</c> fields).</summary>
        public ManifestBuilder MatchOptions(Schema s) { _matchOptions = s; return this; }

        /// <summary>Observation sections in rendering order, and per role the sections rendered in full by default.</summary>
        public ManifestBuilder ObservationScope(string[] sections, IReadOnlyDictionary<string, string[]> defaults)
        {
            if (defaults == null) throw new ArgumentNullException(nameof(defaults));
            var d = JsonValue.NewObject();
            foreach (var kv in defaults) d.Set(kv.Key, JsonValue.Strings(kv.Value));
            _observationScope = JsonValue.NewObject().Set("sections", T.Enum(sections).ToJson()).Set("defaults", d);
            return this;
        }

        /// <summary>An on-demand briefing topic, in index order.</summary>
        public ManifestBuilder Topic(string name, string summary, string text)
        {
            _topics.Set(name, JsonValue.NewObject().Set("summary", summary).Set("text", text));
            return this;
        }

        /// <summary>A developer Agent Skill; <paramref name="files"/> maps relative paths to UTF-8 text and includes <c>SKILL.md</c>.</summary>
        public ManifestBuilder Skill(string name, string description, IReadOnlyDictionary<string, string> files)
        {
            if (files == null) throw new ArgumentNullException(nameof(files));
            var f = JsonValue.NewObject();
            foreach (var kv in files) f.Set(kv.Key, kv.Value);
            _skills.Add(JsonValue.NewObject().Set("name", name).Set("description", description).Set("files", f));
            return this;
        }

        /// <summary>Direct-control rate: a per-seat token bucket for intents (<c>control.intents</c>, required).</summary>
        public ManifestBuilder IntentRate(double perSecond, int burst)
        {
            _control.Set("intents", JsonValue.NewObject().Set("perSecond", perSecond).Set("burst", burst));
            return this;
        }

        /// <summary>
        /// Another control mode (<c>sequence</c>, <c>policy</c>, <c>stream</c>, <c>practice</c>, <c>pool</c>,
        /// <c>chat</c>, <c>pausable</c>) with its plain-JSON limits exactly as SPEC §3 defines them.
        /// </summary>
        public ManifestBuilder ControlMode(string mode, JsonValue limits)
        {
            if (mode == "intents") throw Fail("control.intents: use IntentRate");
            if (mode == "signals") throw Fail("control.signals: team signals are not supported by this SDK yet");
            _control.Set(mode, (limits ?? throw new ArgumentNullException(nameof(limits))).Clone());
            return this;
        }

        /// <summary>The manifest's plain JSON. Throws <see cref="ArgumentException"/> naming the first missing or inconsistent member.</summary>
        public JsonValue Build()
        {
            if (string.IsNullOrEmpty(_doc)) throw Fail("doc: required");
            if (_tickRate == null) throw Fail("tickRate: required");
            if (_teams == null) throw Fail("teams: required");
            if (_roles == null) throw Fail("roles: required");
            if (_errors == null) throw Fail("errors: required");
            if (_opponents == null) throw Fail("opponents: required");
            if (_intents.Count == 0) throw Fail("intents: at least one intent is required");
            Require(_observation, "observation");
            Require(_view, "view");
            Require(_report, "report");
            Require(_event, "event");
            Require(_directive, "directive");
            if (!_control.Has("intents")) throw Fail("control.intents: required (IntentRate)");

            var roles = new HashSet<string>(StringComparer.Ordinal);
            foreach (var r in _roles.Node["values"].Items) roles.Add(r.AsString());
            foreach (var r in roles) if (!_roleDocs.Has(r)) throw Fail($"roleDocs.{r}: every role needs a doc");
            foreach (var p in _roleDocs.Properties) if (!roles.Contains(p.Key)) throw Fail($"roleDocs.{p.Key}: not a role");
            foreach (var kv in _intentRoles)
                foreach (var r in kv.Value) if (!roles.Contains(r)) throw Fail($"intents.{kv.Key}.roles: unknown role {r}");
            if (_directive.Type != "obj") throw Fail("directive: must be an obj");
            if (_event.Type != "obj") throw Fail("event: must be an obj");
            var ef = _event.Node["fields"];
            if (ef["tick"]?["t"]?.AsString() != "int") throw Fail("event.tick: event must have a `tick: T.Int` field");
            if (ef["kind"]?["t"]?.AsString() != "enum") throw Fail("event.kind: event must have a `kind: T.Enum` field");
            if (_observation.Type == "obj" && _observation.Node["fields"].Has("phase")) throw Fail("observation.phase: reserved (lobby state)");
            OptionalFields(_limits, "limits");
            OptionalFields(_matchOptions, "matchOptions");
            if (_matchData != null && _matchData.Type != "obj") throw Fail("matchData: must be an obj");
            if (_lobby != null && _lobby.Type != "obj") throw Fail("lobby: must be an obj");

            var m = JsonValue.NewObject()
                .Set("id", _id).Set("version", _version).Set("title", _title).Set("tickRate", _tickRate.Value).Set("doc", _doc)
                .Set("teams", _teams.ToJson()).Set("roles", _roles.ToJson()).Set("roleDocs", _roleDocs.Clone())
                .Set("intents", _intents.Clone()).Set("observation", _observation.ToJson());
            if (_observationScope != null) m.Set("observationScope", _observationScope.Clone());
            m.Set("view", _view.ToJson());
            if (_observer != null) m.Set("observer", _observer.ToJson());
            if (_matchData != null) m.Set("matchData", _matchData.ToJson());
            if (_lobby != null) m.Set("lobby", _lobby.ToJson());
            m.Set("report", _report.ToJson()).Set("event", _event.ToJson()).Set("directive", _directive.ToJson());
            if (_limits != null) m.Set("limits", _limits.ToJson());
            if (_matchOptions != null) m.Set("matchOptions", _matchOptions.ToJson());
            m.Set("errors", _errors.ToJson()).Set("opponents", _opponents.ToJson())
                .Set("topics", _topics.Clone()).Set("skills", _skills.Clone()).Set("control", _control.Clone());
            return m;
        }

        private static void Require(Schema s, string member)
        {
            if (s == null) throw Fail($"{member}: required");
        }

        private static void OptionalFields(Schema s, string member)
        {
            if (s == null) return;
            if (s.Type != "obj") throw Fail($"{member}: must be an obj");
            foreach (var f in s.Node["fields"].Properties)
                if (f.Value["t"].AsString() != "opt") throw Fail($"{member}.{f.Key}: every field must be T.Opt (missing means the game default)");
        }

        private static ArgumentException Fail(string why) => new ArgumentException("playerthree/manifest: " + why);
    }
}
