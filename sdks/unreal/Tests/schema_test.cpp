// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// SPEC §3: schema nodes and the plain-JSON manifest. The Tug of War manifest built in C++ must equal, member order
// included, the conformance fixture (the Node SDK's `defineManifest` input serialized as JSON).
#include <fstream>
#include <limits>
#include <sstream>

#include "PlayerThree/Manifest.h"
#include "PlayerThree/Schema.h"
#include "TugOfWar.h"
#include "check.h"

namespace t = playerthree::t;
using playerthree::Json;
using playerthree::ManifestBuilder;
using playerthree::ManifestError;

namespace {

Json ReadJson(const char* path) {
  std::ifstream file(path, std::ios::binary);
  std::stringstream text;
  text << file.rdbuf();
  return Json::parse(text.str());
}

ManifestBuilder Minimal() {
  ManifestBuilder m("demo", "1", "Demo", 20, "Rules.");
  m.Teams({"a"})
      .Roles({"r"})
      .RoleDoc("r", "Plays.")
      .Intent("go", {"r"}, {}, "Go.")
      .Observation(t::Obj({}))
      .View(t::Obj({}))
      .Report(t::Obj({}))
      .Event(t::Obj({{"tick", t::Int(0, 10)}, {"kind", t::Enum({"k"})}}))
      .Directive(t::Obj({}))
      .Errors({"no"})
      .Opponents({"easy"})
      .IntentRate(0.5, 1);
  return m;
}

}  // namespace

TEST(tug_manifest_equals_the_conformance_fixture) {
  const Json fixture = ReadJson(P3_TUG_MANIFEST_FIXTURE);
  const Json built = tug::Manifest();
  CHECK_EQ(built.dump(), fixture.dump());
}

TEST(schema_nodes_match_the_node_builders) {
  CHECK_EQ(t::Enum({"a", "b"}).dump(), std::string(R"({"t":"enum","values":["a","b"]})"));
  CHECK_EQ(t::Enum({"a"}, "doc").dump(), std::string(R"({"t":"enum","values":["a"],"doc":"doc"})"));
  CHECK_EQ(t::Id("e").dump(), std::string(R"({"t":"id","prefix":"e"})"));
  CHECK_EQ(t::Str(10, "^[a-z]+$", "d").dump(), std::string(R"({"t":"str","maxLength":10,"pattern":"^[a-z]+$","doc":"d"})"));
  CHECK_EQ(t::Int(-3, 3).dump(), std::string(R"({"t":"int","min":-3,"max":3})"));
  CHECK_EQ(t::Num(0, 1.5).dump(), std::string(R"({"t":"num","min":0.0,"max":1.5})"));
  CHECK_EQ(t::Bool().dump(), std::string(R"({"t":"bool"})"));
  CHECK_EQ(t::List(t::Bool(), 4).dump(), std::string(R"({"t":"list","item":{"t":"bool"},"max":4})"));
  CHECK_EQ(t::Ints(8, 0, 9).dump(), std::string(R"({"t":"ints","maxItems":8,"min":0,"max":9})"));
  CHECK_EQ(t::Obj({{"z", t::Bool()}, {"a", t::Opt(t::Int(0, 1))}}, "", true).dump(),
           std::string(R"({"t":"obj","fields":{"z":{"t":"bool"},"a":{"t":"opt","item":{"t":"int","min":0,"max":1}}},"merge":"replace"})"));
  CHECK_EQ(t::Union("kind", {{"Move", {{"x", t::Int(0, 9)}}}, {"Stop", {}}}).dump(),
           std::string(R"({"t":"union","tag":"kind","variants":{"Move":{"x":{"t":"int","min":0,"max":9}},"Stop":{}}})"));
}

TEST(schema_builders_reject_bad_grammar_and_bounds) {
  THROWS(t::Enum({}), ManifestError);
  THROWS(t::Enum({"a", "a"}), ManifestError);
  THROWS(t::Enum({"1a"}), ManifestError);
  THROWS(t::Enum({std::string(49, 'a')}), ManifestError);
  CHECK(t::Enum({"Array<Int>", "C2", "a.b_c"}).is_object());
  THROWS(t::Id("E"), ManifestError);
  THROWS(t::Id("abcdefghi"), ManifestError);
  THROWS(t::Str(-1), ManifestError);
  THROWS(t::Str(100001), ManifestError);
  THROWS(t::Str(5, "[a-z]"), ManifestError);
  THROWS(t::Int(2, 1), ManifestError);
  THROWS(t::Int(0, t::kMaxSafeInteger + 1), ManifestError);
  THROWS(t::Num(0, std::numeric_limits<double>::infinity()), ManifestError);  // MSVC rejects 1.0 / 0.0 (C2124)
  THROWS(t::List(t::Bool(), -1), ManifestError);
  THROWS(t::List(t::Opt(t::Bool()), 1), ManifestError);
  THROWS(t::List(Json::object(), 1), ManifestError);
  THROWS(t::Ints(1, 5, 4), ManifestError);
  THROWS(t::Obj({{"9x", t::Bool()}}), ManifestError);
  THROWS(t::Obj({{"a", t::Bool()}, {"a", t::Bool()}}), ManifestError);
  THROWS(t::Opt(t::Opt(t::Bool())), ManifestError);
  THROWS(t::Union("kind", {{"A", {{"kind", t::Bool()}}}}), ManifestError);
  THROWS(t::Union("kind", {}), ManifestError);
  THROWS(t::Union("bad-tag", {{"A", {}}}), ManifestError);
}

TEST(manifest_member_order_and_optional_members) {
  const Json m = Minimal().Optional("matchOptions", t::Obj({{"seed", t::Opt(t::Int(0, 9))}})).Build();
  std::vector<std::string> keys;
  for (const auto& entry : m.items()) keys.push_back(entry.key());
  CHECK_EQ(keys, (std::vector<std::string>{"id", "version", "title", "tickRate", "doc", "teams", "roles", "roleDocs",
                                           "intents", "observation", "view", "report", "event", "directive",
                                           "errors", "opponents", "topics", "skills", "control", "matchOptions"}));
  CHECK_EQ(m["control"].dump(), std::string(R"({"intents":{"perSecond":0.5,"burst":1}})"));
  CHECK_EQ(m["intents"]["go"]["params"].dump(), std::string("{}"));
}

TEST(manifest_topics_skills_and_control_modes) {
  const Json m = Minimal()
                     .Topic("rules", "How to win.", "Pull.")
                     .Topic("rules/advanced", "More.", "Pull harder.")
                     .Skill("demo-strategy", "Strategy.", {{"SKILL.md", "---\nname: demo-strategy\ndescription: S\n---\n"}})
                     .ControlMode("chat", Json{{"maxTellChars", 200}, {"maxSayChars", 100}})
                     .Build();
  CHECK_EQ(m["topics"].dump(), std::string(R"({"rules":{"summary":"How to win.","text":"Pull."},"rules/advanced":{"summary":"More.","text":"Pull harder."}})"));
  CHECK_EQ(m["skills"][0]["name"].get<std::string>(), std::string("demo-strategy"));
  CHECK(m["control"].contains("chat"));
}

TEST(manifest_rejects_missing_and_inconsistent_members) {
  THROWS(ManifestBuilder("Bad", "1", "T", 10, "d"), ManifestError);
  THROWS(ManifestBuilder("ok", "", "T", 10, "d"), ManifestError);
  THROWS(ManifestBuilder("ok", "1", "T", 0, "d"), ManifestError);
  THROWS(ManifestBuilder("ok", "1", "T", 1001, "d"), ManifestError);
  THROWS(ManifestBuilder("ok", "1", "T", 10, "d").Build(), ManifestError);
  THROWS(Minimal().RoleDoc("ghost", "x").Build(), ManifestError);
  THROWS(Minimal().Intent("fly", {"ghost"}, {}, "Fly.").Build(), ManifestError);
  THROWS(Minimal().Intent("go", {"r"}, {}, "Again."), ManifestError);
  THROWS(Minimal().Intent("hop", {"r"}, {{"kind", t::Bool()}}, "Hop."), ManifestError);
  THROWS(Minimal().Intent("hop", {}, {}, "Hop."), ManifestError);
  THROWS(Minimal().Event(t::Obj({{"tick", t::Int(0, 1)}})).Build(), ManifestError);
  THROWS(Minimal().Observation(t::Bool()).Build(), ManifestError);
  THROWS(Minimal().Optional("colour", Json::object()), ManifestError);
  THROWS(Minimal().IntentRate(0, 1), ManifestError);
  THROWS(Minimal().ControlMode("intents", Json::object()), ManifestError);
  THROWS(Minimal().Skill("s", "d", {{"README.md", "x"}}), ManifestError);
  ManifestBuilder noRate("ok", "1", "T", 10, "d");
  noRate.Teams({"a"}).Roles({"r"}).RoleDoc("r", "x").Intent("go", {"r"}, {}, "Go.").Observation(t::Obj({}));
  noRate.View(t::Obj({})).Report(t::Obj({})).Directive(t::Obj({})).Errors({"e"}).Opponents({"o"});
  noRate.Event(t::Obj({{"tick", t::Int(0, 1)}, {"kind", t::Enum({"k"})}}));
  THROWS_IF(noRate.Build(), ManifestError, std::string(e.what()).find("control.intents") != std::string::npos);
}

TEST_MAIN()
