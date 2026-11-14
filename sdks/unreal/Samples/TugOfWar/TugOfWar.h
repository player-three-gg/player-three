// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// Tug of War (the README's sample game) as a plain C++ GameDefinition: two teams, one `puller` role, a rope at
// -10..10 (+ is north), and a `pull {strength 1..3}` intent. The built-in `easy` bot pulls with strength 1.
#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include "PlayerThree/Adapter.h"
#include "PlayerThree/Json.h"

namespace tug {

/** The Tug of War manifest, built with playerthree::ManifestBuilder. */
playerthree::Json Manifest();

class TugMatch final : public playerthree::GameAdapter {
 public:
  std::int64_t Tick() const override { return tick_; }
  void Step() override { ++tick_; }
  std::string Outcome(const std::string& team) override;
  playerthree::Json View(const std::string& team, bool snapshot) override;
  playerthree::Json Observe(const playerthree::Seat& seat, std::int64_t sinceTick,
                            const std::vector<std::string>& detail) override;
  playerthree::ApplyResult Apply(const playerthree::Seat& seat, const playerthree::Json& intent,
                                 const playerthree::IntentContext* context) override;
  playerthree::Json Report(const std::string& team) override;
  playerthree::Json Events(const playerthree::Seat& seat, std::int64_t sinceTick) override;
  void SetSeatInfo(const playerthree::Seat& seat, const playerthree::Json& controller,
                   const playerthree::Json& mandate) override;

  std::int64_t Rope() const { return rope_; }

 private:
  std::int64_t tick_ = 0;
  std::int64_t rope_ = 0;  // -10..10, + is north
};

class TugDefinition final : public playerthree::GameDefinition {
 public:
  TugDefinition();
  const playerthree::Json& Manifest() const override { return manifest_; }
  std::unique_ptr<playerthree::GameAdapter> Create(const playerthree::CreateOptions& options) override;
  std::unique_ptr<playerthree::BotCommander> CreateBot(const playerthree::Seat& seat, const std::string& opponent,
                                                       const playerthree::Json& options) override;

 private:
  playerthree::Json manifest_;
};

}  // namespace tug
