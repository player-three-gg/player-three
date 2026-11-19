// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "PlayerThree/Adapter.h"

#include <stdexcept>

namespace playerthree {

namespace {
[[noreturn]] void Undeclared(const char* hook) {
  throw std::logic_error(std::string("playerthree: adapter hook not implemented: ") + hook);
}
}  // namespace

Json GameAdapter::MatchData(const Seat&) { Undeclared(hooks::kMatchData); }
Json GameAdapter::DebugView() { Undeclared(hooks::kDebugView); }
Json GameAdapter::ObserverView() { Undeclared(hooks::kObserverView); }
void GameAdapter::End(const Json&, const Json&) { Undeclared(hooks::kEnd); }
void GameAdapter::Forfeit(const std::string&) { Undeclared(hooks::kForfeit); }
std::int64_t GameAdapter::Rank(const std::string&) { Undeclared(hooks::kRank); }
std::unique_ptr<GameAdapter> GameAdapter::Clone() { Undeclared(hooks::kClone); }
Json GameAdapter::SignalLimits() { Undeclared(hooks::kSignalLimits); }

}  // namespace playerthree
