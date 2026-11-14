# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## SPEC §20.8 (a) sidecar framing: newline-delimited UTF-8 JSON, one object per line, at most
## MAX_LINE_BYTES per line (the terminating "\n" not counted).
##
## Godot's JSON parser reads every number as a float; [method decode_line] turns integral numbers back
## into [int] so ids, ticks and integer schema fields compare and index naturally in GDScript.
class_name PlayerThreeFraming
extends RefCounted

const MAX_LINE_BYTES := 1048576
## Largest integer a JSON double holds exactly (2^53 - 1); integral floats beyond it stay floats.
const MAX_SAFE_INTEGER := 9007199254740991

const NEWLINE := 10

var _pending := PackedByteArray()
## True while skipping the rest of an oversized line up to its newline.
var _skipping := false


## Splits a received chunk into complete lines. Returns one entry per finished line, in order:
## `{"message": Dictionary}` for a valid message, or `{"error": code}` with code `too_large`,
## `bad_utf8`, `bad_json` or `not_object`. An unfinished tail is kept for the next chunk.
func feed(chunk: PackedByteArray) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	var start := 0
	var size := chunk.size()
	while start < size:
		var nl := chunk.find(NEWLINE, start)
		if nl == -1:
			if not _skipping:
				_pending.append_array(chunk.slice(start))
				if _pending.size() > MAX_LINE_BYTES:
					# Report once and drop bytes until the next newline instead of buffering them.
					_pending.clear()
					_skipping = true
					out.append({"error": "too_large"})
			break
		if _skipping:
			_skipping = false
		elif _pending.is_empty():
			out.append(decode_line(chunk.slice(start, nl)))
		else:
			_pending.append_array(chunk.slice(start, nl))
			out.append(decode_line(_pending))
			_pending = PackedByteArray()
		start = nl + 1
	return out


## Bytes of an unfinished line currently buffered.
func pending_bytes() -> int:
	return _pending.size()


## Decodes one line (without its newline). See [method feed] for the result shape.
static func decode_line(line: PackedByteArray) -> Dictionary:
	if line.size() > MAX_LINE_BYTES:
		return {"error": "too_large"}
	var text := line.get_string_from_utf8()
	# get_string_from_utf8 substitutes U+FFFD for malformed input; a lossless round trip proves it was valid.
	if text.to_utf8_buffer() != line:
		return {"error": "bad_utf8"}
	var json := JSON.new()
	if json.parse(text) != OK:
		return {"error": "bad_json"}
	var data: Variant = json.data
	if typeof(data) != TYPE_DICTIONARY:
		return {"error": "not_object"}
	return {"message": integralize(data)}


## One message as a framed line ("\n"-terminated UTF-8). Returns `{"bytes": PackedByteArray}` or
## `{"error": code}`: `not_json` when [param message] holds a value JSON cannot carry (NaN, infinity,
## objects, non-string keys), `too_large` above MAX_LINE_BYTES.
static func encode(message: Dictionary) -> Dictionary:
	if not is_json_value(message):
		return {"error": "not_json"}
	var bytes := JSON.stringify(message, "", false).to_utf8_buffer()
	if bytes.size() > MAX_LINE_BYTES:
		return {"error": "too_large"}
	bytes.append(NEWLINE)
	return {"bytes": bytes}


## Whether [param value] maps onto JSON without loss: null, bool, int, finite float, String,
## StringName, Array, packed arrays of those, and Dictionary with String or StringName keys.
static func is_json_value(value: Variant) -> bool:
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING, TYPE_STRING_NAME, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_STRING_ARRAY:
			return true
		TYPE_FLOAT:
			return is_finite(value)
		TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY:
			for f: float in value:
				if not is_finite(f):
					return false
			return true
		TYPE_ARRAY:
			for item: Variant in value:
				if not is_json_value(item):
					return false
			return true
		TYPE_DICTIONARY:
			for key: Variant in value:
				var kt := typeof(key)
				if kt != TYPE_STRING and kt != TYPE_STRING_NAME:
					return false
				if not is_json_value(value[key]):
					return false
			return true
	return false


## Returns [param value] with every integral float within ±MAX_SAFE_INTEGER replaced by an [int],
## recursing into arrays and dictionaries (which are rebuilt, never shared with the input).
static func integralize(value: Variant) -> Variant:
	match typeof(value):
		TYPE_FLOAT:
			var f: float = value
			if f == floorf(f) and absf(f) <= MAX_SAFE_INTEGER:
				return int(f)
			return f
		TYPE_ARRAY:
			var out := []
			out.resize(value.size())
			for i in value.size():
				out[i] = integralize(value[i])
			return out
		TYPE_DICTIONARY:
			var out := {}
			for key: Variant in value:
				out[key] = integralize(value[key])
			return out
	return value
