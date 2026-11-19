// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "TugOfWarGame.h"

#include <stdexcept>

#include "Engine/World.h"
#include "PlayerThree/Manifest.h"
#include "PlayerThree/Schema.h"
#include "TugOfWarRope.h"

namespace t = playerthree::t;
using playerthree::Json;

namespace
{
Json BuildManifest()
{
	return playerthree::ManifestBuilder("tug", "1.0.0", "Tug of War", 10, "Pull the rope to your side (\xC2\xB1" "10) to win.")
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

/** The `easy` built-in bot: pull with strength 1 every decision. */
class FPullBot final : public playerthree::BotCommander
{
public:
	virtual Json Think(const Json&) override { return Json::array({Json{{"kind", "pull"}, {"strength", 1}}}); }
};
}  // namespace

FTugOfWarMatch::FTugOfWarMatch(ATugOfWarRope* InRope) : RopeActor(InRope) {}

FTugOfWarMatch::~FTugOfWarMatch()
{
	if (ATugOfWarRope* Actor = RopeActor.Get()) Actor->Destroy();
}

ATugOfWarRope& FTugOfWarMatch::Rope() const
{
	ATugOfWarRope* Actor = RopeActor.Get();
	if (!Actor) throw std::runtime_error("the rope actor was destroyed");
	return *Actor;
}

std::int64_t FTugOfWarMatch::Tick() const { return Rope().MatchTick; }

void FTugOfWarMatch::Step() { ++Rope().MatchTick; }

std::string FTugOfWarMatch::Outcome(const std::string& Team)
{
	const int32 Position = Rope().Rope;
	if (FMath::Abs(Position) < 10) return "running";
	return (Position > 0) == (Team == "north") ? "win" : "loss";
}

Json FTugOfWarMatch::View(const std::string&, bool) { return Json{{"rope", Rope().Rope}}; }

Json FTugOfWarMatch::Observe(const playerthree::Seat&, std::int64_t, const std::vector<std::string>&)
{
	return Json{{"tick", Rope().MatchTick}, {"rope", Rope().Rope}};
}

playerthree::ApplyResult FTugOfWarMatch::Apply(const playerthree::Seat& Seat, const Json& Intent,
                                               const playerthree::IntentContext*)
{
	// The host has validated the intent (kind `pull`, strength 1..3) and the seat's role.
	const int32 Strength = Intent.at("strength").get<int32>();
	ATugOfWarRope& Actor = Rope();
	Actor.Rope = FMath::Clamp(Actor.Rope + (Seat.team == "north" ? Strength : -Strength), -10, 10);
	return playerthree::ApplyResult::Accept();
}

Json FTugOfWarMatch::Report(const std::string& Team) { return Json{{"outcome", Outcome(Team)}}; }

Json FTugOfWarMatch::Events(const playerthree::Seat&, std::int64_t) { return Json::array(); }

void FTugOfWarMatch::SetSeatInfo(const playerthree::Seat&, const Json&, const Json&) {}

FTugOfWarDefinition::FTugOfWarDefinition(UWorld* InWorld) : World(InWorld), ManifestJson(BuildManifest()) {}

std::unique_ptr<playerthree::GameAdapter> FTugOfWarDefinition::Create(const playerthree::CreateOptions& Options)
{
	if (Options.teams != std::vector<std::string>{"north", "south"})
	{
		throw playerthree::InvalidCall("Tug of War plays north against south");
	}
	UWorld* Target = World.Get();
	if (!Target) throw std::runtime_error("no world to spawn the rope in");
	ATugOfWarRope* Actor = Target->SpawnActor<ATugOfWarRope>();
	if (!Actor) throw std::runtime_error("could not spawn the rope");
	return std::make_unique<FTugOfWarMatch>(Actor);
}

std::unique_ptr<playerthree::BotCommander> FTugOfWarDefinition::CreateBot(const playerthree::Seat&, const std::string&,
                                                                          const Json&)
{
	return std::make_unique<FPullBot>();
}
