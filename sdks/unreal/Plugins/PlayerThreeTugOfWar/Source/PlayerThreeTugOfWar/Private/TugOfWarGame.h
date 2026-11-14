// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// Tug of War's PlayerThree definition for Unreal: each match is an ATugOfWarRope spawned in the server world, and
// the adapter reads and writes that actor. Same manifest and rules as the CLI sample (README Tug of War).
#pragma once

#include <memory>

#include "CoreMinimal.h"
#include "UObject/WeakObjectPtrTemplates.h"

#include "PlayerThree/Adapter.h"

class ATugOfWarRope;
class UWorld;

class FTugOfWarMatch final : public playerthree::GameAdapter
{
public:
	explicit FTugOfWarMatch(ATugOfWarRope* InRope);
	virtual ~FTugOfWarMatch() override;

	virtual std::int64_t Tick() const override;
	virtual void Step() override;
	virtual std::string Outcome(const std::string& Team) override;
	virtual playerthree::Json View(const std::string& Team, bool bSnapshot) override;
	virtual playerthree::Json Observe(const playerthree::Seat& Seat, std::int64_t SinceTick,
	                                  const std::vector<std::string>& Detail) override;
	virtual playerthree::ApplyResult Apply(const playerthree::Seat& Seat, const playerthree::Json& Intent,
	                                       const playerthree::IntentContext* Context) override;
	virtual playerthree::Json Report(const std::string& Team) override;
	virtual playerthree::Json Events(const playerthree::Seat& Seat, std::int64_t SinceTick) override;
	virtual void SetSeatInfo(const playerthree::Seat& Seat, const playerthree::Json& Controller,
	                         const playerthree::Json& Mandate) override;

private:
	/** The rope actor; throws if the world destroyed it under a live match. */
	ATugOfWarRope& Rope() const;

	TWeakObjectPtr<ATugOfWarRope> RopeActor;
};

class FTugOfWarDefinition final : public playerthree::GameDefinition
{
public:
	explicit FTugOfWarDefinition(UWorld* InWorld);

	virtual const playerthree::Json& Manifest() const override { return ManifestJson; }
	virtual std::unique_ptr<playerthree::GameAdapter> Create(const playerthree::CreateOptions& Options) override;
	virtual std::unique_ptr<playerthree::BotCommander> CreateBot(const playerthree::Seat& Seat,
	                                                             const std::string& Opponent,
	                                                             const playerthree::Json& Options) override;

private:
	TWeakObjectPtr<UWorld> World;
	playerthree::Json ManifestJson;
};
