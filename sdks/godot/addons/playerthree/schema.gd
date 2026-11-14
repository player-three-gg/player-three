# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## Bounded, closed-shape schema nodes as plain JSON dictionaries: the same nodes the Node SDK's `t`
## builders produce (SPEC §3), so a manifest built here is the manifest the host validates.
##
## Names differ from `t` only where GDScript reserves a word: [method integer] is `t.int`,
## [method number] `t.num`, [method boolean] `t.bool`, [method enumeration] `t.enum`, [method text] `t.str`.
## Builders report a bad argument with [method @GlobalScope.push_error] and still return the node; the
## host is the authority and refuses an invalid manifest at `hello`.
class_name PlayerThreeSchema
extends RefCounted

const MAX_STRING_LENGTH := 100000
const MAX_DOC_LENGTH := 4000

static var _enum_literal := RegEx.create_from_string("^[A-Za-z][A-Za-z0-9_.<>]{0,47}$")
static var _id_prefix := RegEx.create_from_string("^[a-z]{1,8}$")
static var _field_name := RegEx.create_from_string("^[A-Za-z_][A-Za-z0-9_]{0,47}$")


## `t.enum(values, doc?)`: one of a closed set of literals.
static func enumeration(values: Array, doc := "") -> Dictionary:
	var seen := {}
	for v: Variant in values:
		if typeof(v) != TYPE_STRING or _enum_literal.search(v) == null:
			push_error("playerthree/schema: enum literal must match ^[A-Za-z][A-Za-z0-9_.<>]{0,47}$: %s" % str(v))
		elif seen.has(v):
			push_error("playerthree/schema: duplicate enum literal")
		seen[v] = true
	if values.is_empty():
		push_error("playerthree/schema: enum needs at least one literal")
	return _with_doc({"t": "enum", "values": values.duplicate()}, doc)


## `t.id(prefix, doc?)`: an opaque game id such as `u_12`.
static func id(prefix: String, doc := "") -> Dictionary:
	if _id_prefix.search(prefix) == null:
		push_error("playerthree/schema: id prefix must match ^[a-z]{1,8}$")
	return _with_doc({"t": "id", "prefix": prefix}, doc)


## `t.str(maxLength, pattern?, doc?)`: trusted text bounded in Unicode code points. The host checks
## [param pattern] against its linear-time regex subset.
static func text(max_length: int, pattern := "", doc := "") -> Dictionary:
	if max_length < 0 or max_length > MAX_STRING_LENGTH:
		push_error("playerthree/schema: bad string maxLength (0..100000 Unicode code points)")
	_check_doc(doc)
	var node := {"t": "str", "maxLength": max_length}
	if not pattern.is_empty():
		node["pattern"] = pattern
	return _with_doc(node, doc)


## `t.ints(maxItems, min, max, doc?)`: a flat bounded integer array.
static func ints(max_items: int, min_value: int, max_value: int, doc := "") -> Dictionary:
	if max_items < 0:
		push_error("playerthree/schema: bad ints maxItems")
	_check_range(min_value, max_value, "ints")
	_check_doc(doc)
	return _with_doc({"t": "ints", "maxItems": max_items, "min": min_value, "max": max_value}, doc)


## `t.int(min, max, doc?)`: a bounded integer.
static func integer(min_value: int, max_value: int, doc := "") -> Dictionary:
	_check_range(min_value, max_value, "int")
	return _with_doc({"t": "int", "min": min_value, "max": max_value}, doc)


## `t.num(min, max, doc?)`: a bounded finite number.
static func number(min_value: float, max_value: float, doc := "") -> Dictionary:
	if not is_finite(min_value) or not is_finite(max_value) or min_value > max_value:
		push_error("playerthree/schema: bad num range")
	return _with_doc({"t": "num", "min": min_value, "max": max_value}, doc)


## `t.bool(doc?)`.
static func boolean(doc := "") -> Dictionary:
	return _with_doc({"t": "bool"}, doc)


## `t.list(item, max, doc?)`: at most [param max_items] items of one schema.
static func list(item: Dictionary, max_items: int, doc := "") -> Dictionary:
	if max_items < 0:
		push_error("playerthree/schema: bad list max")
	return _with_doc({"t": "list", "item": item, "max": max_items}, doc)


## `t.obj(fields, doc?, {merge})`: a closed object. [param merge] is `""` or `"replace"` (atomic
## replacement in layered match options).
static func obj(fields: Dictionary, doc := "", merge := "") -> Dictionary:
	_check_fields(fields)
	var node := _with_doc({"t": "obj", "fields": fields}, doc)
	if merge == "replace":
		node["merge"] = "replace"
	elif not merge.is_empty():
		push_error("playerthree/schema: bad object merge mode")
	return node


## `t.opt(item)`: an optional field; only meaningful directly inside [method obj] or [method union] fields.
static func opt(item: Dictionary) -> Dictionary:
	return {"t": "opt", "item": item}


## `t.union(tag, variants, doc?)`: objects tagged by [param tag]; [param variants] maps each tag
## literal to its fields (without the tag itself).
static func union(tag: String, variants: Dictionary, doc := "") -> Dictionary:
	if _field_name.search(tag) == null:
		push_error("playerthree/schema: invalid union tag")
	for name: Variant in variants:
		if typeof(name) != TYPE_STRING or _enum_literal.search(name) == null:
			push_error("playerthree/schema: union variant must match ^[A-Za-z][A-Za-z0-9_.<>]{0,47}$: %s" % str(name))
			continue
		var fields: Variant = variants[name]
		if typeof(fields) != TYPE_DICTIONARY:
			push_error("playerthree/schema: union variant fields must be a Dictionary")
			continue
		if fields.has(tag):
			push_error("playerthree/schema: variant fields must not redeclare the tag")
		_check_fields(fields)
	return _with_doc({"t": "union", "tag": tag, "variants": variants}, doc)


static func _with_doc(node: Dictionary, doc: String) -> Dictionary:
	if not doc.is_empty():
		node["doc"] = doc
	return node


static func _check_doc(doc: String) -> void:
	# The Node SDK bounds doc in UTF-16 code units; GDScript's length() counts code points.
	if doc.to_utf16_buffer().size() / 2 > MAX_DOC_LENGTH:
		push_error("playerthree/schema: doc must be at most 4000 UTF-16 code units")


static func _check_range(min_value: int, max_value: int, kind: String) -> void:
	if min_value > max_value or absi(min_value) > PlayerThreeFraming.MAX_SAFE_INTEGER or absi(max_value) > PlayerThreeFraming.MAX_SAFE_INTEGER:
		push_error("playerthree/schema: bad %s range" % kind)


static func _check_fields(fields: Dictionary) -> void:
	for key: Variant in fields:
		if typeof(key) != TYPE_STRING or _field_name.search(key) == null:
			push_error("playerthree/schema: field name must match ^[A-Za-z_][A-Za-z0-9_]{0,47}$: %s" % str(key))
		elif typeof(fields[key]) != TYPE_DICTIONARY or not fields[key].has("t"):
			push_error("playerthree/schema: field %s is not a schema node" % key)
