// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "TugOfWar.h"

#include <algorithm>
#include <cstdlib>

#include "PlayerThree/Manifest.h"
#include "PlayerThree/Schema.h"

namespace tug {

namespace t = playerthree::t;
using playerthree::Json;

Json Manifest() {
  return playerthree::ManifestBuilder("tug", "1.0.0", "Tug of War", 10, "Pull the rope to your side (±10) to win.")
      .Teams({"north", "south"})
      .Roles({"puller"})
      .RoleDoc("puller", "Pulls the rope.")
      .Intent("pull", {"puller"}, {{"strength", t::Int(1, 3)}}, "Pull this tick.")
      .Observation(t::Obj({{"tick", t::Int(0, 100000)}, {"rope", t::Int(-10, 10, "+ is north")}}))
      .View(t::Obj({{"rope", t::Int(-10, 10)}}))
      .Report(t::Obj({{"outcome", t::Enum({"win", "loss", "draw", "running"})}}))
      .Event(t::Obj({{"tick", t::Int(0, 100000)}, {"kind", t::Enum({"slip"})}}))
      .Directive(t::Obj({}))
      .Errors({"tired"})
      .Opponents({"easy"})
      .IntentRate(4, 4)
      .Build();
}

std::string TugMatch::Outcome(const std::string& team) {
  if (std::abs(rope_) < 10) return "running";
  return (rope_ > 0) == (team == "north") ? "win" : "loss";
}

Json TugMatch::View(const std::string&, bool) { return Json{{"rope", rope_}}; }

Json TugMatch::Observe(const playerthree::Seat&, std::int64_t, const std::vector<std::string>&) {
  return Json{{"tick", tick_}, {"rope", rope_}};
}

playerthree::ApplyResult TugMatch::Apply(const playerthree::Seat& seat, const Json& intent,
                                         const playerthree::IntentContext*) {
  // The host has validated the intent against the manifest (kind `pull`, strength 1..3) and the seat's role.
  const std::int64_t strength = intent.at("strength").get<std::int64_t>();
  rope_ = std::clamp<std::int64_t>(rope_ + (seat.team == "north" ? strength : -strength), -10, 10);
  return playerthree::ApplyResult::Accept();
}

Json TugMatch::Report(const std::string& team) { return Json{{"outcome", Outcome(team)}}; }

Json TugMatch::Events(const playerthree::Seat&, std::int64_t) { return Json::array(); }

void TugMatch::SetSeatInfo(const playerthree::Seat&, const Json&, const Json&) {}

namespace {

class PullBot final : public playerthree::BotCommander {
 public:
  Json Think(const Json&) override { return Json::array({Json{{"kind", "pull"}, {"strength", 1}}}); }
};

}  // namespace

TugDefinition::TugDefinition() : manifest_(tug::Manifest()) {}

std::unique_ptr<playerthree::GameAdapter> TugDefinition::Create(const playerthree::CreateOptions& options) {
  // Tug of War needs both sides.
  if (options.teams != std::vector<std::string>{"north", "south"}) {
    throw playerthree::InvalidCall("Tug of War plays north against south");
  }
  return std::make_unique<TugMatch>();
}

std::unique_ptr<playerthree::BotCommander> TugDefinition::CreateBot(const playerthree::Seat&, const std::string&,
                                                                    const Json&) {
  return std::make_unique<PullBot>();
}

}  // namespace tug
