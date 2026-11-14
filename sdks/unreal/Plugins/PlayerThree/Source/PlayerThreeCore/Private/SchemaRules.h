// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// SPEC §3 name grammars shared by the schema and manifest builders (internal).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "PlayerThree/Json.h"

namespace playerthree {
namespace rules {

/** `^[A-Za-z][A-Za-z0-9_.<>]{0,47}$`: intent kinds, enum values, union variants. */
bool EnumLiteral(const std::string& s);
/** `^[A-Za-z_][A-Za-z0-9_]{0,47}$`: field names and union tags. */
bool FieldName(const std::string& s);
/** `^[a-z]{1,8}$`. */
bool IdPrefix(const std::string& s);
/** `^[a-z][a-z0-9-]{0,47}$`. */
bool GameId(const std::string& s);
bool SafeInteger(std::int64_t v);
/** A schema node: an object with a string `t`. */
bool IsNode(const Json& schema);
/** Nonempty, unique enum literals; throws ManifestError at `path`. */
void CheckEnumValues(const std::vector<std::string>& values, const std::string& path);

}  // namespace rules
}  // namespace playerthree
