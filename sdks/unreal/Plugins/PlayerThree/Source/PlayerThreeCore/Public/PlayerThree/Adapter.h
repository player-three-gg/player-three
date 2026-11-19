// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// The game side of SPEC §10, in C++: a GameDefinition creates matches (GameAdapter) and built-in bots
// (BotCommander). The sidecar host calls them synchronously on the engine's thread; every value is plain JSON that
// the host guards against the manifest before it reaches anyone.
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "PlayerThree/Json.h"

namespace playerthree {

/** One seat: a manifest team and role. */
struct Seat {
  std::string team;
  std::string role;
};

/** `apply` result: accepted, or rejected with one of the manifest's `errors` codes. */
struct ApplyResult {
  bool ok = true;
  std::string code;
  static ApplyResult Accept() { return ApplyResult{}; }
  static ApplyResult Reject(std::string code) { return ApplyResult{false, std::move(code)}; }
};

/** Trusted provenance of an applied intent (§4 Owner control); absent context means an explicit owner call. */
struct IntentContext {
  std::string source;  // owner | agent | policy | bot | fallback
  std::optional<std::vector<std::string>> ownerRoles;
};

/** `create` input: the match's sides (a nonempty subset of manifest teams, manifest order) and options. */
struct CreateOptions {
  std::int64_t seed = 0;
  std::vector<std::string> teams;
  /** Validated `matchOptions` object, or null when omitted. */
  Json options;
  /** `{allianceId: [team...]}`, or null when the match declares no alliances. */
  Json alliances;
};

/** Thrown by an adapter for input it cannot accept; answered as `invalid` instead of `engine_error`. */
class P3_API InvalidCall : public std::invalid_argument {
 public:
  using std::invalid_argument::invalid_argument;
};

/**
 * Optional adapter calls. A game lists the ones it implements in GameDefinition::Hooks(); the host never calls an
 * undeclared one, and the default implementations are unreachable through the sidecar.
 */
namespace hooks {
inline constexpr const char* kMatchData = "matchData";
inline constexpr const char* kDebugView = "debugView";
inline constexpr const char* kObserverView = "observerView";
inline constexpr const char* kEnd = "end";
inline constexpr const char* kForfeit = "forfeit";
inline constexpr const char* kRank = "rank";
inline constexpr const char* kClone = "clone";
inline constexpr const char* kSignalLimits = "signalLimits";
}  // namespace hooks

/** One running match. All calls are synchronous with respect to the match's tick (§10). */
class P3_API GameAdapter {
 public:
  virtual ~GameAdapter() = default;

  /** Current tick; monotonically increasing, starting at the value `create` reported. */
  virtual std::int64_t Tick() const = 0;
  /** Advances the simulation exactly one tick. */
  virtual void Step() = 0;
  /** `win`, `loss`, `draw` or `running` for a match team. */
  virtual std::string Outcome(const std::string& team) = 0;
  /** `manifest.view` for a side; `snapshot` is true for a watcher's first view. */
  virtual Json View(const std::string& team, bool snapshot) = 0;
  /** `manifest.observation` for a seat: fogged, events newer than `sinceTick`, `detail` sections in full. */
  virtual Json Observe(const Seat& seat, std::int64_t sinceTick, const std::vector<std::string>& detail) = 0;
  /** Applies a schema-valid, role-checked intent; enforces game legality and mandate limits. */
  virtual ApplyResult Apply(const Seat& seat, const Json& intent, const IntentContext* context) = 0;
  /** `manifest.report` for a side. */
  virtual Json Report(const std::string& team) = 0;
  /** Visible events with tick > sinceTick, oldest first (a JSON array). */
  virtual Json Events(const Seat& seat, std::int64_t sinceTick) = 0;
  /** Controller disclosure and owner mandate for a seat. */
  virtual void SetSeatInfo(const Seat& seat, const Json& controller, const Json& mandate) = 0;

  // Optional hooks (see hooks::). Defaults throw: only declared hooks are ever called.
  virtual Json MatchData(const Seat& seat);
  virtual Json DebugView();
  virtual Json ObserverView();
  /** Adopt host-declared final outcomes and ranks, both `{team: value}` objects. */
  virtual void End(const Json& outcomes, const Json& ranks);
  virtual void Forfeit(const std::string& team);
  virtual std::int64_t Rank(const std::string& team);
  /** Independent copy of the whole match: state, RNG and caches. */
  virtual std::unique_ptr<GameAdapter> Clone();
  /** This match's signal limits object, or null for signals off. */
  virtual Json SignalLimits();
};

/** A built-in bot for one seat; uses exactly the intents an agent could send. */
class P3_API BotCommander {
 public:
  virtual ~BotCommander() = default;
  /** Runs once before the first Think with the seat's guarded match data, or null. */
  virtual void Init(const Json& matchData) { (void)matchData; }
  /** Intents for this observation (a JSON array of intent objects). */
  virtual Json Think(const Json& observation) = 0;
};

/** The game: its manifest, match factory and built-in bots. */
class P3_API GameDefinition {
 public:
  virtual ~GameDefinition() = default;
  /** The plain-JSON manifest sent in `hello` (build it with ManifestBuilder or load a JSON file). */
  virtual const Json& Manifest() const = 0;
  /** Optional adapter calls every match of this game answers (hooks::*); `matchData` iff the manifest declares it. */
  virtual std::vector<std::string> Hooks() const { return {}; }
  /** A new match; throw InvalidCall for a side set or options the game cannot play. */
  virtual std::unique_ptr<GameAdapter> Create(const CreateOptions& options) = 0;
  /** A built-in bot of tier `opponent` (a manifest `opponents` value); `options` is an object or null. */
  virtual std::unique_ptr<BotCommander> CreateBot(const Seat& seat, const std::string& opponent,
                                                  const Json& options) = 0;
};

}  // namespace playerthree
