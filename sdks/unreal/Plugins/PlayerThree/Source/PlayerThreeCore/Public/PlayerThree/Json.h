// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// The JSON value type of the PlayerThree C++ core (vendored nlohmann/json 3.11.3, MIT, see NOTICE) and the export
// macro. The core is engine-independent C++17; under Unreal's build the module defines PLAYERTHREECORE_API and the
// THIRD_PARTY_INCLUDES_* guards, everywhere else both expand to nothing.
#pragma once

#if defined(THIRD_PARTY_INCLUDES_START)
THIRD_PARTY_INCLUDES_START
#endif
#include "../../ThirdParty/nlohmann/json.hpp"
#if defined(THIRD_PARTY_INCLUDES_END)
THIRD_PARTY_INCLUDES_END
#endif

#if defined(PLAYERTHREECORE_API)
#define P3_API PLAYERTHREECORE_API
#else
#define P3_API
#endif

namespace playerthree {

/**
 * Every manifest, adapter argument and adapter result is plain JSON (SPEC §3, §10, §20.8). Insertion-ordered, because
 * member order is meaningful in a manifest (intent, field and topic order reach agents and `surfaceHash`).
 */
using Json = nlohmann::ordered_json;

}  // namespace playerthree
