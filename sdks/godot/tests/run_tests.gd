# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## Headless tests for the framing, the schema/manifest JSON, the stdio transport and call dispatch.
##   godot --headless --path sdks/godot --import                      (once: registers the class names)
##   godot --headless --path sdks/godot --script res://tests/run_tests.gd
## Exits 0 when every check passes, 1 otherwise.
extends SceneTree

const TugGame := preload("res://samples/tug_of_war/tug_game.gd")
const Transport := preload("res://addons/playerthree/stdio_transport.gd")
const HookGame := preload("res://tests/hook_game.gd")

## The Tug of War manifest as the Node SDK's `defineManifest` input serializes it (README example).
const TUG_MANIFEST_JSON := '{"id":"tug","version":"1.0.0","title":"Tug of War","tickRate":10,"doc":"Pull the rope to your side (±10) to win.","teams":{"t":"enum","values":["north","south"]},"roles":{"t":"enum","values":["puller"]},"roleDocs":{"puller":"Pulls the rope."},"intents":{"pull":{"roles":["puller"],"params":{"strength":{"t":"int","min":1,"max":3}},"doc":"Pull this tick."}},"observation":{"t":"obj","fields":{"tick":{"t":"int","min":0,"max":100000},"rope":{"t":"int","min":-10,"max":10,"doc":"+ is north"}}},"view":{"t":"obj","fields":{"rope":{"t":"int","min":-10,"max":10}}},"report":{"t":"obj","fields":{"outcome":{"t":"enum","values":["win","loss","draw","running"]}}},"event":{"t":"obj","fields":{"tick":{"t":"int","min":0,"max":100000},"kind":{"t":"enum","values":["slip"]}}},"directive":{"t":"obj","fields":{}},"errors":{"t":"enum","values":["tired"]},"opponents":{"t":"enum","values":["easy"]},"topics":{},"skills":[],"control":{"intents":{"perSecond":4,"burst":4}}}'
## The conformance fixture, once packages/sidecar is in the same checkout.
const FIXTURE := "../../packages/sidecar/conformance/tug.manifest.json"

var _failures := 0
var _checks := 0
var _section := ""


func _init() -> void:
	_test_framing_lines()
	_test_framing_limits()
	_test_framing_errors()
	_test_encode()
	_test_integralize()
	_test_schema_nodes()
	_test_manifest()
	_test_dispatch()
	_test_hooks()
	_test_transport_round_trip()
	print("%d checks, %d failed" % [_checks, _failures])
	quit(0 if _failures == 0 else 1)


func _check(ok: bool, what: String) -> void:
	_checks += 1
	if not ok:
		_failures += 1
		printerr("FAIL [%s] %s" % [_section, what])


func _eq(actual: Variant, expected: Variant, what: String) -> void:
	_check(typeof(actual) == typeof(expected) and actual == expected, "%s: got %s, want %s" % [what, var_to_str(actual), var_to_str(expected)])


func _bytes(text: String) -> PackedByteArray:
	return text.to_utf8_buffer()


func _line_of(size: int) -> PackedByteArray:
	# A JSON object padded to exactly `size` bytes: {"op":"call","pad":"xxx…"}
	var head := '{"op":"call","pad":"'
	var tail := '"}'
	return _bytes(head + "x".repeat(size - head.length() - tail.length()) + tail)


func _test_framing_lines() -> void:
	_section = "framing lines"
	var f := PlayerThreeFraming.new()
	var out := f.feed(_bytes('{"op":"ready","surfaceHash":"ab"}\n{"op":"push"'))
	_eq(out.size(), 1, "one complete line")
	_eq(out[0]["message"], {"op": "ready", "surfaceHash": "ab"}, "first message")
	_eq(f.pending_bytes(), 12, "tail buffered")
	out = f.feed(_bytes(',"kind":"seats"}\n\n{"id":3}\n'))
	_eq(out.size(), 3, "tail, empty line and third line")
	_eq(out[0]["message"], {"op": "push", "kind": "seats"}, "joined across chunks")
	_eq(out[1], {"error": "bad_json"}, "empty line is not JSON")
	_eq(out[2]["message"]["id"], 3, "integral id is int")
	_eq(f.pending_bytes(), 0, "nothing pending")
	# Byte-at-a-time delivery, including a multi-byte UTF-8 character split across chunks.
	var line := _bytes('{"doc":"±10"}\n')
	var got: Array[Dictionary] = []
	for b in line:
		got.append_array(f.feed(PackedByteArray([b])))
	_eq(got.size(), 1, "byte-wise feed yields one message")
	_eq(got[0]["message"]["doc"], "±10", "UTF-8 reassembled")


func _test_framing_limits() -> void:
	_section = "framing limits"
	var f := PlayerThreeFraming.new()
	var max_line := _line_of(PlayerThreeFraming.MAX_LINE_BYTES)
	_eq(max_line.size(), 1048576, "fixture line size")
	var chunk := max_line.duplicate()
	chunk.append(10)
	var out := f.feed(chunk)
	_eq(out.size(), 1, "1048576-byte line parsed")
	_check(out[0].has("message"), "1048576-byte line is a message")
	# The same line in 64 KiB chunks, as the pipe delivers it.
	out = []
	var at := 0
	while at < chunk.size():
		out.append_array(f.feed(chunk.slice(at, at + 65536)))
		at += 65536
	_eq(out.size(), 1, "chunked 1048576-byte line parsed")
	_check(out[0].has("message"), "chunked max line is a message")
	# One byte over, whole and chunked: one too_large, then framing resumes at the next line.
	var over := _line_of(PlayerThreeFraming.MAX_LINE_BYTES + 1)
	over.append(10)
	over.append_array(_bytes('{"op":"ok"}\n'))
	out = f.feed(over)
	_eq(out.size(), 2, "oversized whole line then next")
	_eq(out[0], {"error": "too_large"}, "1048577-byte line rejected")
	_eq(out[1]["message"], {"op": "ok"}, "next line still framed")
	out = []
	at = 0
	while at < over.size():
		out.append_array(f.feed(over.slice(at, at + 65536)))
		at += 65536
	_eq(out.size(), 2, "oversized chunked line reported once")
	_eq(out[0], {"error": "too_large"}, "chunked 1048577-byte line rejected")
	_eq(out[1]["message"], {"op": "ok"}, "next line after skipped one")
	_check(f.pending_bytes() == 0, "no oversized buffering")


func _test_framing_errors() -> void:
	_section = "framing errors"
	var f := PlayerThreeFraming.new()
	var bad := PackedByteArray([123, 34, 97, 34, 58, 34, 0xff, 34, 125, 10])  # {"a":"\xff"}
	print("note: the Unicode parsing error Godot logs next is expected (invalid UTF-8 test)")
	_eq(f.feed(bad), [{"error": "bad_utf8"}], "invalid UTF-8")
	_eq(f.feed(_bytes('{"a":1\n')), [{"error": "bad_json"}], "truncated JSON")
	_eq(f.feed(_bytes('[1,2]\n')), [{"error": "not_object"}], "array is not a message")
	_eq(f.feed(_bytes('"op"\n')), [{"error": "not_object"}], "string is not a message")


func _test_encode() -> void:
	_section = "encode"
	var r := PlayerThreeFraming.encode({"op": "result", "id": 7, "ok": true, "data": {"tick": 3, "rope": -2.5, "s": "a\nb"}})
	_check(r.has("bytes"), "encodes")
	var bytes: PackedByteArray = r["bytes"]
	_eq(bytes[bytes.size() - 1], 10, "ends with newline")
	_eq(bytes.count(10), 1, "exactly one newline (string newlines escaped)")
	var back := PlayerThreeFraming.decode_line(bytes.slice(0, bytes.size() - 1))
	_eq(back["message"], {"op": "result", "id": 7, "ok": true, "data": {"tick": 3, "rope": -2.5, "s": "a\nb"}}, "round trip")
	_eq(PlayerThreeFraming.encode({"x": NAN}), {"error": "not_json"}, "NaN refused")
	_eq(PlayerThreeFraming.encode({"x": [INF]}), {"error": "not_json"}, "infinity refused")
	_eq(PlayerThreeFraming.encode({"x": {1: "a"}}), {"error": "not_json"}, "int key refused")
	_eq(PlayerThreeFraming.encode({"x": Vector2(1, 2)}), {"error": "not_json"}, "Vector2 refused")
	_eq(PlayerThreeFraming.encode({"x": RefCounted.new()}), {"error": "not_json"}, "Object refused")
	_check(PlayerThreeFraming.encode({&"k": PackedStringArray(["a"]), "n": PackedInt32Array([1])}).has("bytes"), "StringName keys and packed arrays")
	var exact := '{"pad":"' + "x".repeat(PlayerThreeFraming.MAX_LINE_BYTES - 10) + '"}'
	_eq(exact.length(), PlayerThreeFraming.MAX_LINE_BYTES, "exact fixture size")
	var big := PlayerThreeFraming.encode({"pad": "x".repeat(PlayerThreeFraming.MAX_LINE_BYTES - 10)})
	_eq(big.get("bytes", PackedByteArray()).size(), PlayerThreeFraming.MAX_LINE_BYTES + 1, "1048576-byte message encodes")
	_eq(PlayerThreeFraming.encode({"pad": "x".repeat(PlayerThreeFraming.MAX_LINE_BYTES - 9)}), {"error": "too_large"}, "1048577-byte message refused")


func _test_integralize() -> void:
	_section = "integralize"
	var v: Variant = PlayerThreeFraming.decode_line(_bytes('{"a":1,"b":1.5,"c":[2,-0,1e3],"d":{"e":9007199254740991},"f":1e300}'))["message"]
	_eq(v["a"], 1, "int")
	_eq(v["b"], 1.5, "float stays")
	_eq(v["c"], [2, 0, 1000], "array ints")
	_eq(v["d"]["e"], 9007199254740991, "max safe integer")
	_eq(typeof(v["f"]), TYPE_FLOAT, "beyond safe range stays float")


func _test_schema_nodes() -> void:
	_section = "schema"
	var S := PlayerThreeSchema
	_eq(S.integer(1, 3), {"t": "int", "min": 1, "max": 3}, "int")
	_eq(S.integer(-10, 10, "+ is north"), {"t": "int", "min": -10, "max": 10, "doc": "+ is north"}, "int with doc")
	_eq(S.number(0.0, 1.5), {"t": "num", "min": 0.0, "max": 1.5}, "num")
	_eq(S.boolean("on"), {"t": "bool", "doc": "on"}, "bool")
	_eq(S.enumeration(["a", "b"]), {"t": "enum", "values": ["a", "b"]}, "enum")
	_eq(S.id("u"), {"t": "id", "prefix": "u"}, "id")
	_eq(S.text(40), {"t": "str", "maxLength": 40}, "str")
	_eq(S.text(8, "[a-z]+"), {"t": "str", "maxLength": 8, "pattern": "[a-z]+"}, "str with pattern")
	_eq(S.ints(4, 0, 9), {"t": "ints", "maxItems": 4, "min": 0, "max": 9}, "ints")
	_eq(S.list(S.integer(0, 1), 5), {"t": "list", "item": {"t": "int", "min": 0, "max": 1}, "max": 5}, "list")
	_eq(S.obj({"x": S.opt(S.boolean())}, "", "replace"), {"t": "obj", "fields": {"x": {"t": "opt", "item": {"t": "bool"}}}, "merge": "replace"}, "obj with opt and merge")
	_eq(S.union("kind", {"a": {}, "b": {"n": S.integer(0, 1)}}), {"t": "union", "tag": "kind", "variants": {"a": {}, "b": {"n": {"t": "int", "min": 0, "max": 1}}}}, "union")


func _test_manifest() -> void:
	_section = "manifest"
	var built := TugGame.build_manifest()
	_eq(built.check(), PackedStringArray(), "Tug manifest complete")
	var expected: Variant = PlayerThreeFraming.decode_line(_bytes(TUG_MANIFEST_JSON))["message"]
	_eq(built.to_dict(), expected, "Tug manifest JSON")
	var reparsed: Variant = PlayerThreeFraming.decode_line(_bytes(built.to_json()))["message"]
	_eq(reparsed, expected, "to_json round trip")
	var fixture := ProjectSettings.globalize_path("res://").path_join(FIXTURE).simplify_path()
	if FileAccess.file_exists(fixture):
		var on_disk: Variant = PlayerThreeFraming.integralize(JSON.parse_string(FileAccess.get_file_as_string(fixture)))
		_eq(built.to_dict(), on_disk, "Tug manifest equals the conformance fixture")
	else:
		print("note: %s not in this checkout; compared against the embedded copy only" % FIXTURE)
	var empty := PlayerThreeManifest.new()
	var problems := empty.check()
	_check("id is required" in problems, "missing id reported")
	_check("tickRate must be a positive integer" in problems, "missing tickRate reported")
	_check("teams must be an enum schema" in problems, "missing teams reported")
	_check("control.intents is required" in problems, "missing control reported")
	var partial := TugGame.build_manifest()
	partial.role_docs.clear()
	partial.intent("shove", ["giant"], {}, "Shove.")
	partial.event = PlayerThreeSchema.obj({"tick": PlayerThreeSchema.integer(0, 1)})
	problems = partial.check()
	_check("roleDocs.puller is required" in problems, "missing role doc reported")
	_check("intents.shove names unknown role giant" in problems, "unknown intent role reported")
	_check("event needs fields tick (int) and kind (enum)" in problems, "event shape reported")
	partial.match_options = PlayerThreeSchema.obj({})
	_eq(partial.to_dict().get("matchOptions"), {"t": "obj", "fields": {}}, "optional member included when set")
	_check(not built.to_dict().has("matchData"), "unset optional member omitted")


func _test_dispatch() -> void:
	_section = "dispatch"
	var sidecar := PlayerThreeSidecar.new()
	sidecar._game = TugGame.new()
	var north := {"team": "north", "role": "puller"}
	_eq(sidecar._call("s1", "create", [{"seed": 1, "teams": ["north", "south"]}]), {"ok": true, "data": {"tick": 0}}, "create")
	_eq(sidecar._call("s1", "create", [{"seed": 1, "teams": ["north", "south"]}])["code"], "invalid", "duplicate session")
	_eq(sidecar._call("s1", "apply", [north, {"kind": "pull", "strength": 3}, {"source": "agent"}]), {"ok": true, "data": {"ok": true}}, "apply")
	_eq(sidecar._call("s1", "apply", [north, {"kind": "pull", "strength": 3}, null]), {"ok": true, "data": {"ok": true}}, "apply without context")
	_eq(sidecar._call("s1", "step", []), {"ok": true, "data": {"tick": 1}}, "step")
	_eq(sidecar._call("s1", "observe", [north, 0, []]), {"ok": true, "data": {"tick": 1, "rope": 6}}, "observe")
	_eq(sidecar._call("s1", "view", ["south", {"snapshot": true}]), {"ok": true, "data": {"rope": 6}}, "view")
	_eq(sidecar._call("s1", "outcome", ["north"]), {"ok": true, "data": "running"}, "outcome")
	_eq(sidecar._call("s1", "report", ["south"]), {"ok": true, "data": {"outcome": "running"}}, "report")
	_eq(sidecar._call("s1", "events", [north, 0]), {"ok": true, "data": []}, "events")
	_eq(sidecar._call("s1", "setSeatInfo", [north, {"controller": "agent", "mandate": {}}]), {"ok": true, "data": null}, "setSeatInfo")
	_eq(sidecar._call("s1", "nope", [])["code"], "unknown_method", "unknown method")
	_eq(sidecar._call("s9", "observe", [north, 0, []])["code"], "unknown_session", "unknown session")
	_eq(sidecar._call("s1", "matchData", [north])["code"], "unknown_method", "undeclared hook")
	_eq(sidecar._call("s1", "clone", ["s2"])["code"], "unknown_method", "undeclared clone")
	_eq(sidecar._call("s1", "observe", [north, 0])["code"], "invalid", "wrong arity")
	_eq(sidecar._call("s1", "observe", [north, "0", []])["code"], "invalid", "wrong argument type")
	_eq(sidecar._call("s1", "apply", [north, {"kind": "pull", "strength": 1}, 5])["code"], "invalid", "bad context")
	_eq(sidecar._call("b1", "createBot", [north, "easy", null]), {"ok": true, "data": null}, "createBot")
	_eq(sidecar._call("b1", "init", [null]), {"ok": true, "data": null}, "bot init")
	_eq(sidecar._call("b1", "think", [{"tick": 1, "rope": 6}]), {"ok": true, "data": [{"kind": "pull", "strength": 1}]}, "bot think")
	_eq(sidecar._call("b1", "observe", [north, 0, []])["code"], "unknown_session", "match method on bot session")
	_eq(sidecar._call("s1", "think", [{}])["code"], "unknown_session", "bot method on match session")
	_eq(sidecar._call("b1", "dispose", []), {"ok": true, "data": null}, "dispose bot")
	_eq(sidecar._call("s1", "dispose", []), {"ok": true, "data": null}, "dispose match")
	_eq(sidecar._call("s1", "dispose", [])["code"], "unknown_session", "dispose twice")
	sidecar.free()


func _test_hooks() -> void:
	_section = "hooks"
	var sidecar := PlayerThreeSidecar.new()
	sidecar._game = HookGame.new()
	for hook in sidecar._game.hooks():
		sidecar._hooks[hook] = true
	var seat := {"team": "north", "role": "puller"}
	sidecar._call("s1", "create", [{"seed": 1, "teams": ["north"]}])
	_eq(sidecar._call("s1", "matchData", [seat]), {"ok": true, "data": {"lane": 2}}, "matchData")
	_eq(sidecar._call("s1", "debugView", []), {"ok": true, "data": null}, "nullable debugView")
	_eq(sidecar._call("s1", "rank", ["north"]), {"ok": true, "data": 1}, "rank")
	_eq(sidecar._call("s1", "end", [{"north": "win"}, {"north": 1}]), {"ok": true, "data": null}, "end")
	_eq(sidecar.adapter("s1").ended, {"north": "win"}, "end reached the adapter")
	_eq(sidecar._call("s1", "step", [])["code"], "engine_error", "step without tick increase")
	_eq(sidecar._call("s1", "observe", [seat, 0, []])["code"], "engine_error", "null result")
	_eq(sidecar._call("s1", "report", ["north"])["code"], "engine_error", "non-JSON result")
	_eq(sidecar._call("s1", "clone", ["s2"]), {"ok": true, "data": {"tick": 5}}, "clone")
	_check(sidecar.adapter("s2") != null and sidecar.adapter("s2") != sidecar.adapter("s1"), "clone is a new adapter")
	_eq(sidecar._call("s1", "clone", ["s2"])["code"], "invalid", "clone onto a live session")
	_eq(sidecar._call("s1", "dispose", []), {"ok": true, "data": null}, "dispose")
	_check(sidecar._game.disposed, "adapter dispose() ran")
	sidecar.free()


func _test_transport_round_trip() -> void:
	_section = "transport"
	if not FileAccess.file_exists("/bin/cat"):
		print("note: /bin/cat missing; transport round trip not run")
		return
	var t := Transport.new()
	_eq(t.start("/bin/cat", PackedStringArray(), false), OK, "spawn")
	var framing := PlayerThreeFraming.new()
	var big := PlayerThreeFraming.encode({"op": "call", "pad": "y".repeat(PlayerThreeFraming.MAX_LINE_BYTES - 22)})
	_eq(big["bytes"].size(), PlayerThreeFraming.MAX_LINE_BYTES + 1, "max-size frame")
	var small := PlayerThreeFraming.encode({"op": "result", "id": 1, "ok": true, "data": null})
	# cat echoes as we write; the reader thread drains it, so a 1 MiB write cannot deadlock the pipe.
	_check(t.write(small["bytes"]) and t.write(big["bytes"]) and t.write(small["bytes"]), "writes complete")
	var got: Array[Dictionary] = []
	var deadline := Time.get_ticks_msec() + 10000
	while got.size() < 3 and Time.get_ticks_msec() < deadline:
		for chunk in t.take():
			got.append_array(framing.feed(chunk))
		t.wait(5000)
	_eq(got.size(), 3, "three frames back")
	if got.size() == 3:
		_eq(got[0]["message"]["id"], 1, "first frame")
		_eq(got[1]["message"]["pad"].length(), PlayerThreeFraming.MAX_LINE_BYTES - 22, "max frame intact")
		_eq(got[2]["message"]["op"], "result", "third frame")
	_eq(t.close(2000), 0, "cat exits 0 on stdin EOF")
	_check(t.at_eof(), "reader saw EOF")
