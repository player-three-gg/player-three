// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// Builds the plain-JSON game manifest (SPEC §3) a sidecar engine sends in `hello`: the same members and schema
// nodes as the Node SDK's `defineManifest` input. Build() checks presence and the cheap structural rules so a
// mistake fails at startup with the member's name; the host still validates the whole manifest authoritatively.
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "PlayerThree/Json.h"
#include "PlayerThree/Schema.h"

namespace playerthree {

class P3_API ManifestBuilder {
 public:
  /** Static identity and core rules: id `^[a-z][a-z0-9-]{0,47}$`, tickRate 1..1000 game ticks per second. */
  ManifestBuilder(std::string id, std::string version, std::string title, std::int64_t tickRate, std::string doc);

  /** Sides and roles (nonempty, unique, enum literals). */
  ManifestBuilder& Teams(const std::vector<std::string>& teams, const std::string& doc = "");
  ManifestBuilder& Roles(const std::vector<std::string>& roles, const std::string& doc = "");
  /** One static doc per role. */
  ManifestBuilder& RoleDoc(const std::string& role, const std::string& doc);
  /** An intent kind: the roles that may send it, its parameter fields and its doc. */
  ManifestBuilder& Intent(const std::string& kind, const std::vector<std::string>& roles, const Fields& params,
                          const std::string& doc);
  /** Closed schemas built with t::*. */
  ManifestBuilder& Observation(Json schema);
  ManifestBuilder& View(Json schema);
  ManifestBuilder& Report(Json schema);
  /** Event schema: an object with required `tick` int and `kind` enum. */
  ManifestBuilder& Event(Json schema);
  ManifestBuilder& Directive(Json schema);
  /** Game rejection codes and built-in opponent tiers (weakest first). */
  ManifestBuilder& Errors(const std::vector<std::string>& codes);
  ManifestBuilder& Opponents(const std::vector<std::string>& tiers);
  /** An on-demand briefing topic, in index order. */
  ManifestBuilder& Topic(const std::string& name, const std::string& summary, const std::string& text);
  /** A developer skill: name, description and files (`SKILL.md` with frontmatter is required by the host). */
  ManifestBuilder& Skill(const std::string& name, const std::string& description,
                         const std::map<std::string, std::string>& files);
  /** The required `control.intents` rate limit. */
  ManifestBuilder& IntentRate(double perSecond, std::int64_t burst);
  /** Another control mode (`sequence`, `chat`, `pausable`, …) with its limits object. */
  ManifestBuilder& ControlMode(const std::string& mode, Json limits);
  /**
   * An optional top-level member: `matchData`, `lobby`, `observer`, `limits`, `matchOptions`, `observationScope` or
   * `signals`. Any other name throws ManifestError.
   */
  ManifestBuilder& Optional(const std::string& member, Json value);

  /** The manifest JSON; throws ManifestError naming the first missing or malformed member. */
  Json Build() const;

 private:
  Json manifest_;
  Json roleDocs_ = Json::object();
  Json intents_ = Json::object();
  Json topics_ = Json::object();
  Json skills_ = Json::array();
  Json control_ = Json::object();
  std::map<std::string, Json> optional_;
};

}  // namespace playerthree
