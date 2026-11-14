// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "PlayerThree/Manifest.h"

#include <algorithm>
#include <cmath>

#include "SchemaRules.h"

namespace playerthree {

namespace {

/** Length in UTF-16 code units of UTF-8 text (SPEC §3 counts text bounds that way). */
std::size_t Utf16Length(const std::string& utf8) {
  std::size_t units = 0;
  for (unsigned char c : utf8) {
    if ((c & 0xC0) != 0x80) units += (c >= 0xF0) ? 2 : 1;  // a 4-byte sequence is a surrogate pair
  }
  return units;
}

void CheckText(const std::string& value, std::size_t max, const std::string& path) {
  const std::size_t n = Utf16Length(value);
  if (n < 1 || n > max) throw ManifestError(path + ": must be 1.." + std::to_string(max) + " characters");
}

bool IsObjNode(const Json& schema) { return rules::IsNode(schema) && schema["t"] == "obj"; }

std::vector<std::string> EnumValues(const Json& node) {
  std::vector<std::string> out;
  for (const Json& v : node["values"]) out.push_back(v.get<std::string>());
  return out;
}

const char* const kOptionalMembers[] = {"matchData", "lobby", "observer", "limits", "matchOptions",
                                        "observationScope", "signals"};

}  // namespace

ManifestBuilder::ManifestBuilder(std::string id, std::string version, std::string title, std::int64_t tickRate,
                                 std::string doc) {
  if (!rules::GameId(id)) throw ManifestError("id: must match ^[a-z][a-z0-9-]{0,47}$");
  CheckText(version, 64, "version");
  CheckText(title, 200, "title");
  CheckText(doc, 6000, "doc");
  if (tickRate < 1 || tickRate > 1000) throw ManifestError("tickRate: must be 1..1000");
  manifest_ = Json{{"id", id}, {"version", version}, {"title", title}, {"tickRate", tickRate}, {"doc", doc}};
}

ManifestBuilder& ManifestBuilder::Teams(const std::vector<std::string>& teams, const std::string& doc) {
  rules::CheckEnumValues(teams, "teams");
  manifest_["teams"] = t::Enum(teams, doc);
  return *this;
}

ManifestBuilder& ManifestBuilder::Roles(const std::vector<std::string>& roles, const std::string& doc) {
  rules::CheckEnumValues(roles, "roles");
  manifest_["roles"] = t::Enum(roles, doc);
  return *this;
}

ManifestBuilder& ManifestBuilder::RoleDoc(const std::string& role, const std::string& doc) {
  CheckText(doc, 3500, "roleDocs." + role);
  roleDocs_[role] = doc;
  return *this;
}

ManifestBuilder& ManifestBuilder::Intent(const std::string& kind, const std::vector<std::string>& roles,
                                         const Fields& params, const std::string& doc) {
  const std::string path = "intents." + kind;
  if (!rules::EnumLiteral(kind)) throw ManifestError(path + ": kind must match ^[A-Za-z][A-Za-z0-9_.<>]{0,47}$");
  if (intents_.contains(kind)) throw ManifestError(path + ": duplicate intent");
  if (roles.empty()) throw ManifestError(path + ".roles: must be nonempty");
  for (const Field& f : params) {
    if (f.name == "kind") throw ManifestError(path + ".params.kind: `kind` is reserved");
  }
  CheckText(doc, 4000, path + ".doc");
  intents_[kind] = Json{{"roles", roles}, {"params", FieldMap(params, path + ".params")}, {"doc", doc}};
  return *this;
}

ManifestBuilder& ManifestBuilder::Observation(Json schema) {
  manifest_["observation"] = std::move(schema);
  return *this;
}
ManifestBuilder& ManifestBuilder::View(Json schema) {
  manifest_["view"] = std::move(schema);
  return *this;
}
ManifestBuilder& ManifestBuilder::Report(Json schema) {
  manifest_["report"] = std::move(schema);
  return *this;
}
ManifestBuilder& ManifestBuilder::Event(Json schema) {
  manifest_["event"] = std::move(schema);
  return *this;
}
ManifestBuilder& ManifestBuilder::Directive(Json schema) {
  manifest_["directive"] = std::move(schema);
  return *this;
}

ManifestBuilder& ManifestBuilder::Errors(const std::vector<std::string>& codes) {
  rules::CheckEnumValues(codes, "errors");
  manifest_["errors"] = t::Enum(codes);
  return *this;
}

ManifestBuilder& ManifestBuilder::Opponents(const std::vector<std::string>& tiers) {
  rules::CheckEnumValues(tiers, "opponents");
  manifest_["opponents"] = t::Enum(tiers);
  return *this;
}

ManifestBuilder& ManifestBuilder::Topic(const std::string& name, const std::string& summary, const std::string& text) {
  if (topics_.contains(name)) throw ManifestError("topics." + name + ": duplicate topic");
  CheckText(summary, 160, "topics." + name + ".summary");
  CheckText(text, 8000, "topics." + name + ".text");
  topics_[name] = Json{{"summary", summary}, {"text", text}};
  return *this;
}

ManifestBuilder& ManifestBuilder::Skill(const std::string& name, const std::string& description,
                                        const std::map<std::string, std::string>& files) {
  if (files.find("SKILL.md") == files.end()) throw ManifestError("skills." + name + ": SKILL.md is required");
  CheckText(description, 1024, "skills." + name + ".description");
  Json fileMap = Json::object();
  for (const auto& file : files) fileMap[file.first] = file.second;
  skills_.push_back(Json{{"name", name}, {"description", description}, {"files", fileMap}});
  return *this;
}

ManifestBuilder& ManifestBuilder::IntentRate(double perSecond, std::int64_t burst) {
  if (!std::isfinite(perSecond) || perSecond < 0.01 || perSecond > 1000) {
    throw ManifestError("control.intents.perSecond: must be 0.01..1000");
  }
  if (burst < 1 || burst > 10000) throw ManifestError("control.intents.burst: must be 1..10000");
  // An integral rate is written as a JSON integer, exactly like the Node SDK's `perSecond: 4`.
  Json rate = std::floor(perSecond) == perSecond ? Json(static_cast<std::int64_t>(perSecond)) : Json(perSecond);
  control_["intents"] = Json{{"perSecond", rate}, {"burst", burst}};
  return *this;
}

ManifestBuilder& ManifestBuilder::ControlMode(const std::string& mode, Json limits) {
  if (mode == "intents") throw ManifestError("control.intents: use IntentRate");
  if (!limits.is_object()) throw ManifestError("control." + mode + ": limits must be an object");
  control_[mode] = std::move(limits);
  return *this;
}

ManifestBuilder& ManifestBuilder::Optional(const std::string& member, Json value) {
  if (std::none_of(std::begin(kOptionalMembers), std::end(kOptionalMembers),
                   [&](const char* m) { return member == m; })) {
    throw ManifestError(member + ": not an optional manifest member");
  }
  optional_[member] = std::move(value);
  return *this;
}

Json ManifestBuilder::Build() const {
  for (const char* member : {"teams", "roles", "observation", "view", "report", "event", "directive", "errors",
                             "opponents"}) {
    if (!manifest_.contains(member)) throw ManifestError(std::string(member) + ": required");
  }
  const std::vector<std::string> roles = EnumValues(manifest_["roles"]);
  for (const std::string& role : roles) {
    if (!roleDocs_.contains(role)) throw ManifestError("roleDocs." + role + ": every role needs a doc");
  }
  for (const auto& entry : roleDocs_.items()) {
    if (std::find(roles.begin(), roles.end(), entry.key()) == roles.end()) {
      throw ManifestError("roleDocs." + entry.key() + ": unknown role");
    }
  }
  if (intents_.empty()) throw ManifestError("intents: at least one intent is required");
  for (const auto& entry : intents_.items()) {
    for (const Json& role : entry.value()["roles"]) {
      if (std::find(roles.begin(), roles.end(), role.get<std::string>()) == roles.end()) {
        throw ManifestError("intents." + entry.key() + ".roles: unknown role " + role.get<std::string>());
      }
    }
  }
  for (const char* member : {"observation", "view", "report", "directive"}) {
    if (!IsObjNode(manifest_[member])) throw ManifestError(std::string(member) + ": must be a t::Obj schema");
  }
  const Json& event = manifest_["event"];
  const bool eventShape = IsObjNode(event) && event["fields"].contains("tick") && event["fields"]["tick"]["t"] == "int" &&
                          event["fields"].contains("kind") && event["fields"]["kind"]["t"] == "enum";
  if (!eventShape) throw ManifestError("event: must be a t::Obj with required `tick` int and `kind` enum");
  if (!control_.contains("intents")) throw ManifestError("control.intents: required (IntentRate)");

  Json out = Json::object();
  for (const char* member : {"id", "version", "title", "tickRate", "doc", "teams", "roles"}) out[member] = manifest_[member];
  out["roleDocs"] = roleDocs_;
  out["intents"] = intents_;
  for (const char* member : {"observation", "view", "report", "event", "directive", "errors", "opponents"}) {
    out[member] = manifest_[member];
  }
  out["topics"] = topics_;
  out["skills"] = skills_;
  out["control"] = control_;
  for (const auto& entry : optional_) out[entry.first] = entry.second;
  return out;
}

}  // namespace playerthree
