// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "PlayerThree/Schema.h"

#include <cmath>
#include <set>

#include "SchemaRules.h"

namespace playerthree {

namespace rules {

namespace {
bool Alpha(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
bool Digit(char c) { return c >= '0' && c <= '9'; }
bool Lower(char c) { return c >= 'a' && c <= 'z'; }
}  // namespace

bool EnumLiteral(const std::string& s) {
  if (s.empty() || s.size() > 48 || !Alpha(s[0])) return false;
  for (char c : s) {
    if (!Alpha(c) && !Digit(c) && c != '_' && c != '.' && c != '<' && c != '>') return false;
  }
  return true;
}

bool FieldName(const std::string& s) {
  if (s.empty() || s.size() > 48 || !(Alpha(s[0]) || s[0] == '_')) return false;
  for (char c : s) {
    if (!Alpha(c) && !Digit(c) && c != '_') return false;
  }
  return true;
}

bool IdPrefix(const std::string& s) {
  if (s.empty() || s.size() > 8) return false;
  for (char c : s) {
    if (!Lower(c)) return false;
  }
  return true;
}

bool GameId(const std::string& s) {
  if (s.empty() || s.size() > 48 || !Lower(s[0])) return false;
  for (char c : s) {
    if (!Lower(c) && !Digit(c) && c != '-') return false;
  }
  return true;
}

bool SafeInteger(std::int64_t v) { return v >= -t::kMaxSafeInteger && v <= t::kMaxSafeInteger; }

bool IsNode(const Json& schema) { return schema.is_object() && schema.contains("t") && schema["t"].is_string(); }

void CheckEnumValues(const std::vector<std::string>& values, const std::string& path) {
  if (values.empty()) throw ManifestError(path + ": enum needs at least one value");
  std::set<std::string> seen;
  for (const std::string& v : values) {
    if (!EnumLiteral(v)) throw ManifestError(path + ": enum literal must match ^[A-Za-z][A-Za-z0-9_.<>]{0,47}$: " + v);
    if (!seen.insert(v).second) throw ManifestError(path + ": duplicate enum literal " + v);
  }
}

}  // namespace rules

namespace {

/** Adds `doc` only when given, as the Node builders omit an undefined doc. */
Json WithDoc(Json node, const std::string& doc) {
  if (!doc.empty()) node["doc"] = doc;
  return node;
}

/** A schema node usable as a value (not an `opt` marker, which only a field map may hold). */
void CheckValueNode(const Json& schema, const std::string& path) {
  if (!rules::IsNode(schema)) throw ManifestError(path + ": expected a schema node built with t::*");
  if (schema["t"] == "opt") throw ManifestError(path + ": t::Opt is only valid directly inside a field map");
}

}  // namespace

Json FieldMap(const Fields& fields, const std::string& path) {
  Json map = Json::object();
  for (const Field& field : fields) {
    const std::string at = path + "." + field.name;
    if (!rules::FieldName(field.name)) throw ManifestError(at + ": field name must match ^[A-Za-z_][A-Za-z0-9_]{0,47}$");
    if (map.contains(field.name)) throw ManifestError(at + ": duplicate field");
    if (!rules::IsNode(field.schema)) throw ManifestError(at + ": expected a schema node built with t::*");
    map[field.name] = field.schema;
  }
  return map;
}

namespace t {

Json Enum(const std::vector<std::string>& values, const std::string& doc) {
  rules::CheckEnumValues(values, "t::Enum");
  return WithDoc(Json{{"t", "enum"}, {"values", values}}, doc);
}

Json Id(const std::string& prefix, const std::string& doc) {
  if (!rules::IdPrefix(prefix)) throw ManifestError("t::Id: prefix must match ^[a-z]{1,8}$");
  return WithDoc(Json{{"t", "id"}, {"prefix", prefix}}, doc);
}

Json Str(std::int64_t maxLength, const std::string& pattern, const std::string& doc) {
  if (maxLength < 0 || maxLength > 100000) throw ManifestError("t::Str: maxLength must be 0..100000 code points");
  Json node{{"t", "str"}, {"maxLength", maxLength}};
  if (!pattern.empty()) {
    // The full safe-pattern subset (SPEC §3) is enforced by the host; here only its frame.
    bool printable = true;
    for (char c : pattern) printable = printable && c >= 0x20 && c < 0x7f;
    if (pattern.size() < 2 || pattern.size() > 256 || !printable || pattern.front() != '^' || pattern.back() != '$') {
      throw ManifestError("t::Str: pattern must be 2..256 printable ASCII characters from ^ to $");
    }
    node["pattern"] = pattern;
  }
  return WithDoc(std::move(node), doc);
}

Json Int(std::int64_t min, std::int64_t max, const std::string& doc) {
  if (!rules::SafeInteger(min) || !rules::SafeInteger(max) || min > max) throw ManifestError("t::Int: bad range");
  return WithDoc(Json{{"t", "int"}, {"min", min}, {"max", max}}, doc);
}

Json Num(double min, double max, const std::string& doc) {
  if (!std::isfinite(min) || !std::isfinite(max) || min > max) throw ManifestError("t::Num: bad range");
  return WithDoc(Json{{"t", "num"}, {"min", min}, {"max", max}}, doc);
}

Json Bool(const std::string& doc) { return WithDoc(Json{{"t", "bool"}}, doc); }

Json List(const Json& item, std::int64_t max, const std::string& doc) {
  CheckValueNode(item, "t::List item");
  if (max < 0 || !rules::SafeInteger(max)) throw ManifestError("t::List: bad max");
  return WithDoc(Json{{"t", "list"}, {"item", item}, {"max", max}}, doc);
}

Json Ints(std::int64_t maxItems, std::int64_t min, std::int64_t max, const std::string& doc) {
  if (maxItems < 0 || !rules::SafeInteger(maxItems)) throw ManifestError("t::Ints: bad maxItems");
  if (!rules::SafeInteger(min) || !rules::SafeInteger(max) || min > max) throw ManifestError("t::Ints: bad range");
  return WithDoc(Json{{"t", "ints"}, {"maxItems", maxItems}, {"min", min}, {"max", max}}, doc);
}

Json Obj(const Fields& fields, const std::string& doc, bool mergeReplace) {
  Json node = WithDoc(Json{{"t", "obj"}, {"fields", FieldMap(fields, "t::Obj")}}, doc);
  if (mergeReplace) node["merge"] = "replace";
  return node;
}

Json Opt(const Json& item) {
  CheckValueNode(item, "t::Opt item");
  return Json{{"t", "opt"}, {"item", item}};
}

Json Union(const std::string& tag, const std::vector<Variant>& variants, const std::string& doc) {
  if (!rules::FieldName(tag)) throw ManifestError("t::Union: invalid tag");
  if (variants.empty()) throw ManifestError("t::Union: needs at least one variant");
  Json map = Json::object();
  for (const Variant& variant : variants) {
    const std::string at = "t::Union." + variant.name;
    if (!rules::EnumLiteral(variant.name)) throw ManifestError(at + ": variant must match ^[A-Za-z][A-Za-z0-9_.<>]{0,47}$");
    if (map.contains(variant.name)) throw ManifestError(at + ": duplicate variant");
    for (const Field& field : variant.fields) {
      if (field.name == tag) throw ManifestError(at + ": variant fields must not redeclare the tag");
    }
    map[variant.name] = FieldMap(variant.fields, at);
  }
  return WithDoc(Json{{"t", "union"}, {"tag", tag}, {"variants", map}}, doc);
}

}  // namespace t

}  // namespace playerthree
