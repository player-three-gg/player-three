// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// SPEC §3 closed schema vocabulary as plain-JSON nodes: the C++ twin of the Node SDK's `t` builders. Each builder
// checks its own grammar and bounds, so an unsafe schema fails where it is written; the host re-validates the whole
// manifest on `hello`.
#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include "PlayerThree/Json.h"

namespace playerthree {

/** A manifest or schema that breaks a SPEC §3 rule; `what()` names the member. */
class P3_API ManifestError : public std::invalid_argument {
 public:
  using std::invalid_argument::invalid_argument;
};

/** One named field of an object schema or intent; fields keep declaration order. */
struct Field {
  std::string name;
  Json schema;
};
using Fields = std::vector<Field>;

/** One variant of a tagged union: its name and fields (never the tag itself). */
struct Variant {
  std::string name;
  Fields fields;
};

namespace t {

/** Largest |integer| a schema bound may use (JavaScript's Number.MAX_SAFE_INTEGER). */
inline constexpr std::int64_t kMaxSafeInteger = 9007199254740991;

/** `{"t":"enum","values":[...]}`: nonempty, unique literals matching `^[A-Za-z][A-Za-z0-9_.<>]{0,47}$`. */
P3_API Json Enum(const std::vector<std::string>& values, const std::string& doc = "");
/** `{"t":"id","prefix":P}`: prefix `^[a-z]{1,8}$`. */
P3_API Json Id(const std::string& prefix, const std::string& doc = "");
/** `{"t":"str","maxLength":N}`, N in 0..100000 code points; optional anchored pattern (the host checks its subset). */
P3_API Json Str(std::int64_t maxLength, const std::string& pattern = "", const std::string& doc = "");
/** `{"t":"int","min":A,"max":B}`: safe integers, A <= B. */
P3_API Json Int(std::int64_t min, std::int64_t max, const std::string& doc = "");
/** `{"t":"num","min":A,"max":B}`: finite, A <= B. */
P3_API Json Num(double min, double max, const std::string& doc = "");
/** `{"t":"bool"}`. */
P3_API Json Bool(const std::string& doc = "");
/** `{"t":"list","item":S,"max":N}`: N a nonnegative safe integer. */
P3_API Json List(const Json& item, std::int64_t max, const std::string& doc = "");
/** `{"t":"ints","maxItems":N,"min":A,"max":B}`. */
P3_API Json Ints(std::int64_t maxItems, std::int64_t min, std::int64_t max, const std::string& doc = "");
/** `{"t":"obj","fields":{...}}`, optionally `"merge":"replace"` (atomic option layering, SPEC §3). */
P3_API Json Obj(const Fields& fields, const std::string& doc = "", bool mergeReplace = false);
/** `{"t":"opt","item":S}`: an optional field; only valid directly inside a field map. */
P3_API Json Opt(const Json& item);
/** `{"t":"union","tag":T,"variants":{...}}`. */
P3_API Json Union(const std::string& tag, const std::vector<Variant>& variants, const std::string& doc = "");

}  // namespace t

/** A field map as the JSON object `{name: schema}`, in declaration order; checks names and `opt` placement. */
P3_API Json FieldMap(const Fields& fields, const std::string& path);

}  // namespace playerthree
