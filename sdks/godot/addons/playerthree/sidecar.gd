# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## Runs the PlayerThree sidecar host (SPEC §20.8 (a), wire protocol 1) next to your Godot game server.
##
## The node spawns the host as a child process and speaks newline-delimited JSON over its stdio. The
## engine owns the simulation and the clock; the host owns MCP, OAuth, guards, mandates and sessions.
## Host calls into your [PlayerThreeAdapter]s and [PlayerThreeBot]s are answered on the main thread:
## between frames from [method Node._process], and inside [method advance] / [method request], which
## block until the host replies so each tick stays synchronous (§10). Signals are emitted deferred, so
## their handlers may call [method request] and [method advance].
class_name PlayerThreeSidecar
extends Node

## The host accepted the manifest. [param mcp_url] is where agents connect.
signal connected(surface_hash: String, mcp_url: String)
## The connection failed: the host refused the handshake or either side broke the protocol. [signal closed] follows.
signal failed(code: String, message: String)
## The host created match [param session] through your [method PlayerThreeGame.create_match].
signal session_created(session: String)
## The host released match [param session].
signal session_disposed(session: String)
## An [method advance] of [param session] completed at [param tick].
signal advanced(session: String, tick: int)
## A host push (`seats`, `ended`, …) for [param session].
signal pushed(session: String, kind: String, data: Variant)
## Every team of [param session] is final. Its clock has stopped.
signal match_ended(session: String, outcomes: Dictionary, ranks: Dictionary)
## The connection is closed and the host process has exited ([param exit_code] -1 when unknown or
## killed). Per §20.8 the host has disposed every session; move agent and policy seats to your own bots.
signal closed(exit_code: int)

const PROTOCOL := 1
const SETTING_PROGRAM := "playerthree/sidecar/program"
const SETTING_ARGUMENTS := "playerthree/sidecar/arguments"

const _Transport := preload("stdio_transport.gd")

## Wire method → [adapter method, argument types (TYPE_NIL: any JSON), result kind, optional hook].
## Result kinds: "void" (data null), "tick" (data {tick}), "value" (non-null JSON), "nullable" (any JSON).
const _MATCH_METHODS := {
	"step": ["step", [], "tick", false],
	"outcome": ["outcome", [TYPE_STRING], "value", false],
	"view": ["view", [TYPE_STRING, TYPE_DICTIONARY], "value", false],
	"observe": ["observe", [TYPE_DICTIONARY, TYPE_INT, TYPE_ARRAY], "value", false],
	"apply": ["apply", [TYPE_DICTIONARY, TYPE_DICTIONARY, TYPE_NIL], "value", false],
	"report": ["report", [TYPE_STRING], "value", false],
	"events": ["events", [TYPE_DICTIONARY, TYPE_INT], "value", false],
	"setSeatInfo": ["set_seat_info", [TYPE_DICTIONARY, TYPE_DICTIONARY], "void", false],
	"matchData": ["match_data", [TYPE_DICTIONARY], "value", true],
	"debugView": ["debug_view", [], "nullable", true],
	"observerView": ["observer_view", [], "nullable", true],
	"signalLimits": ["signal_limits", [], "nullable", true],
	"end": ["end", [TYPE_DICTIONARY, TYPE_DICTIONARY], "void", true],
	"forfeit": ["forfeit", [TYPE_STRING], "void", true],
	"rank": ["rank", [TYPE_STRING], "value", true],
}

enum State { IDLE, HANDSHAKE, READY, CLOSED }

## Program to spawn; empty uses the project setting `playerthree/sidecar/program` (default `node`).
@export var program := ""
## Its arguments; empty uses `playerthree/sidecar/arguments`. They must make the host speak stdio
## (`.../packages/sidecar/bin/playerthree-sidecar.ts --stdio`).
@export var arguments := PackedStringArray()
## Advance every match started with [method create_match] (or [method run_clock]) from
## [method Node._physics_process] at the manifest's `tickRate`.
@export var advance_in_physics := true
## Longest wait for the host's reply to one [method request] or [method advance].
@export var request_timeout_msec := 30000
## Copy the host's stderr log lines to Godot's stderr.
@export var forward_stderr := true
## After the connection closes, how long to wait for the host to exit before killing it.
@export var exit_grace_msec := 10000

var _state := State.IDLE
var _game: PlayerThreeGame
var _hooks := {}
var _tick_rate := 0
var _transport: _Transport
var _framing := PlayerThreeFraming.new()
var _next_id := 1
## Id of the single engine request in flight (0: none) and its result once received.
var _outstanding := 0
var _reply := {}
var _matches := {}
var _bots := {}
## Clocked match session → fractional ticks owed.
var _clocks := {}
var _pumping := false
var _dispatching := false
var _surface_hash := ""
var _mcp_url := ""
var _exit_code := -1


## Spawns the host and sends `hello` with [param game]'s manifest and hooks. [signal connected] or
## [signal failed] reports the host's answer.
func start(game: PlayerThreeGame) -> Error:
	if _state != State.IDLE:
		return ERR_ALREADY_IN_USE
	var manifest := game.manifest()
	var declared := game.hooks()
	for hook in declared:
		if not hook in PlayerThreeGame.HOOKS:
			push_error("playerthree: unknown hook %s" % hook)
			return ERR_INVALID_PARAMETER
	_game = game
	_hooks.clear()
	for hook in declared:
		_hooks[hook] = true
	_tick_rate = int(manifest.get("tickRate", 0))
	var hello := PlayerThreeFraming.encode({"op": "hello", "protocol": PROTOCOL, "manifest": manifest, "hooks": declared})
	if hello.has("error"):
		push_error("playerthree: manifest is not sendable JSON (%s)" % hello["error"])
		return ERR_INVALID_DATA
	var exe := program if not program.is_empty() else String(ProjectSettings.get_setting(SETTING_PROGRAM, "node"))
	var args := arguments if not arguments.is_empty() else PackedStringArray(ProjectSettings.get_setting(SETTING_ARGUMENTS, PackedStringArray()))
	_transport = _Transport.new()
	var err := _transport.start(exe, args, forward_stderr)
	if err != OK:
		_transport = null
		return err
	_state = State.HANDSHAKE
	if not _transport.write(hello["bytes"]):
		_close_with("closed", "could not write hello", false)
		return ERR_CANT_CONNECT
	return OK


## Whether the host accepted the manifest and the connection is open.
func is_ready() -> bool:
	return _state == State.READY


## The surface hash the host computed for the manifest (empty before [signal connected]).
func surface_hash() -> String:
	return _surface_hash


## The host's MCP endpoint (empty before [signal connected]).
func mcp_url() -> String:
	return _mcp_url


## Sends game-side host operation [param method] (e.g. `createMatch`, `mintSeatToken`, `seats`,
## `setController`, `end`, `dispose`) and blocks until its result, answering host calls meanwhile.
## Returns `{"ok": true, "data": …}` or `{"ok": false, "code": String, "message"?: String}`; local codes
## are `not_ready` (before [signal connected]), `closed` (no connection), `busy` (called from inside an
## adapter call or another request) and `timeout` (no reply within [member request_timeout_msec]; the
## connection is then closed).
func request(method: String, args: Array = []) -> Dictionary:
	return _send_request({"op": "host", "method": method, "args": args})


## Asks the host to run up to [param n] ticks of [param session] (thinking phase, gates, `apply` and
## `step` calls) and blocks until it has. Returns [method request]'s shape with `data` `{"tick": int}`;
## host codes include `paused` (§18) and `over`.
func advance(session: String, n: int = 1) -> Dictionary:
	if n < 1:
		return {"ok": false, "code": "invalid", "message": "n must be at least 1"}
	var result := _send_request({"op": "advance", "session": session, "n": n})
	if result["ok"]:
		_emit_deferred(&"advanced", [session, int(result["data"]["tick"])])
	elif result["code"] == "over" or result["code"] == "unknown_session":
		_clocks.erase(session)
	return result


## `createMatch` with [param spec] (`seed`, `options`, `teams`, `alliances`, `controllers`, `botLevel`, all
## optional); on success the match's clock runs when [member advance_in_physics] is set. Returns
## [method request]'s shape with `data` `{"session": String, "tick": int}`.
func create_match(spec: Dictionary = {}) -> Dictionary:
	var result := request("createMatch", [spec])
	if result["ok"] and advance_in_physics:
		run_clock(String(result["data"]["session"]))
	return result


## Advances [param session] from [method Node._physics_process] at the manifest's tick rate until the
## match ends, is disposed or [method stop_clock] is called.
func run_clock(session: String) -> void:
	if not _clocks.has(session):
		_clocks[session] = 0.0


## Stops advancing [param session] automatically.
func stop_clock(session: String) -> void:
	_clocks.erase(session)


## The adapter of a live match session, or null.
func adapter(session: String) -> PlayerThreeAdapter:
	return _matches.get(session)


## Closes the connection; the host disposes its sessions and exits. Waits up to
## [member exit_grace_msec] for it before killing it. Returns its exit code (-1 when killed or unknown).
func close() -> int:
	if _state == State.IDLE or _state == State.CLOSED:
		return _exit_code
	_finish()
	return _exit_code


func _notification(what: int) -> void:
	# A node freed outside the tree (never added, or already removed) still must not leak the host process.
	if what == NOTIFICATION_PREDELETE and _transport != null:
		_transport.close(exit_grace_msec)


func _exit_tree() -> void:
	close()


func _process(_delta: float) -> void:
	if _state == State.HANDSHAKE or _state == State.READY:
		_pump()


func _physics_process(delta: float) -> void:
	if _state != State.READY or not advance_in_physics or _clocks.is_empty():
		return
	for session: String in _clocks.keys():
		if not _clocks.has(session) or _state != State.READY:
			continue
		var owed: float = _clocks[session] + delta * _tick_rate
		# 1e-6 absorbs float drift (six 1/60 s frames at 10 ticks/s sum to 0.99999…).
		var n := int(owed + 1e-6)
		if n < 1:
			_clocks[session] = owed
			continue
		# Catch up at most one second per frame; a longer stall is dropped rather than replayed in a burst.
		_clocks[session] = maxf(owed - n, 0.0)
		var result := advance(session, mini(n, maxi(_tick_rate, 1)))
		if not result["ok"] and result["code"] == "paused" and _clocks.has(session):
			_clocks[session] = 0.0


func _send_request(message: Dictionary) -> Dictionary:
	if _state == State.HANDSHAKE:
		return {"ok": false, "code": "not_ready"}
	if _state != State.READY:
		return {"ok": false, "code": "closed"}
	if _outstanding != 0 or _dispatching:
		return {"ok": false, "code": "busy"}
	var id := _next_id
	_next_id += 1
	message["id"] = id
	var framed := PlayerThreeFraming.encode(message)
	if framed.has("error"):
		return {"ok": false, "code": "invalid", "message": "request is not sendable JSON (%s)" % framed["error"]}
	_outstanding = id
	_reply = {}
	if not _transport.write(framed["bytes"]):
		_outstanding = 0
		_close_with("closed", "host stdin closed", false)
		return {"ok": false, "code": "closed"}
	var deadline := Time.get_ticks_msec() + request_timeout_msec
	while true:
		_pump()
		if not _reply.is_empty():
			var reply := _reply
			_reply = {}
			_outstanding = 0
			return reply
		if _state != State.READY:
			_outstanding = 0
			return {"ok": false, "code": "closed"}
		if Time.get_ticks_msec() >= deadline:
			# A late reply would answer an id no longer outstanding, so the connection cannot continue.
			_outstanding = 0
			_close_with("timeout", "no reply to request %d" % id, true)
			return {"ok": false, "code": "timeout"}
		_transport.wait(2000)
	return {}


func _pump() -> void:
	if _pumping or _transport == null:
		return
	_pumping = true
	var eof := _transport.at_eof()
	for chunk in _transport.take():
		for entry in _framing.feed(chunk):
			if _state == State.CLOSED:
				break
			_handle(entry)
	_pumping = false
	if eof and _state == State.HANDSHAKE:
		_close_with("closed", "the host exited before ready (is the sidecar command right?)", false)
	elif eof and _state != State.CLOSED:
		_finish()


func _handle(entry: Dictionary) -> void:
	if entry.has("error"):
		if entry["error"] == "too_large":
			_close_with("too_large", "line over %d bytes" % PlayerThreeFraming.MAX_LINE_BYTES, true)
		else:
			_close_with("bad_frame", "unreadable line (%s)" % entry["error"], true)
		return
	var msg: Dictionary = entry["message"]
	match msg.get("op"):
		"ready":
			if _state != State.HANDSHAKE:
				_close_with("bad_frame", "unexpected ready", true)
				return
			_surface_hash = str(msg.get("surfaceHash", ""))
			_mcp_url = str(msg.get("mcp", ""))
			_state = State.READY
			_emit_deferred(&"connected", [_surface_hash, _mcp_url])
		"error":
			_close_with(str(msg.get("code", "error")), str(msg.get("message", "")), false)
		"call":
			if _state != State.READY:
				_close_with("bad_frame", "call before ready", true)
				return
			_answer(msg)
		"result":
			var id: Variant = msg.get("id")
			if typeof(id) != TYPE_INT or id != _outstanding or not _reply.is_empty() or typeof(msg.get("ok")) != TYPE_BOOL:
				_close_with("bad_frame", "result for no outstanding request", true)
				return
			if msg["ok"]:
				_reply = {"ok": true, "data": msg.get("data")}
			else:
				_reply = {"ok": false, "code": str(msg.get("code", "error"))}
				if msg.has("message"):
					_reply["message"] = str(msg["message"])
		"push":
			var session := str(msg.get("session", ""))
			var kind := str(msg.get("kind", ""))
			var data: Variant = msg.get("data")
			if kind == "ended":
				_clocks.erase(session)
				var ended: Dictionary = data if typeof(data) == TYPE_DICTIONARY else {}
				_emit_deferred(&"match_ended", [session, ended.get("outcomes", {}), ended.get("ranks", {})])
			_emit_deferred(&"pushed", [session, kind, data])
		_:
			_close_with("bad_frame", "unknown op", true)


func _answer(msg: Dictionary) -> void:
	var id: Variant = msg.get("id")
	var session: Variant = msg.get("session")
	var method: Variant = msg.get("method")
	var args: Variant = msg.get("args")
	if typeof(id) != TYPE_INT or id < 1 or typeof(session) != TYPE_STRING or typeof(method) != TYPE_STRING or typeof(args) != TYPE_ARRAY:
		_close_with("bad_frame", "malformed call", true)
		return
	_dispatching = true
	var result := _call(session, method, args)
	_dispatching = false
	result["op"] = "result"
	result["id"] = id
	var framed := PlayerThreeFraming.encode(result)
	if framed.has("error"):
		framed = PlayerThreeFraming.encode({"op": "result", "id": id, "ok": false, "code": "engine_error", "message": "result is %s" % framed["error"]})
	if not _transport.write(framed["bytes"]):
		_close_with("closed", "host stdin closed", false)


func _call(session: String, method: String, args: Array) -> Dictionary:
	match method:
		"create":
			if _matches.has(session) or _bots.has(session):
				return _err("invalid", "session exists")
			if args.size() != 1 or typeof(args[0]) != TYPE_DICTIONARY:
				return _err("invalid", "create takes one options object")
			var match_adapter := _game.create_match(args[0])
			if match_adapter == null:
				return _err("engine_error", "create_match returned null")
			_matches[session] = match_adapter
			_emit_deferred(&"session_created", [session])
			return _ok({"tick": match_adapter.tick})
		"createBot":
			if _matches.has(session) or _bots.has(session):
				return _err("invalid", "session exists")
			if args.size() != 3 or typeof(args[0]) != TYPE_DICTIONARY or typeof(args[1]) != TYPE_STRING:
				return _err("invalid", "createBot takes seat, opponent, options")
			var bot := _game.create_bot(args[0], args[1], args[2])
			if bot == null:
				return _err("engine_error", "create_bot returned null")
			_bots[session] = bot
			return _ok(null)
		"init", "think":
			var bot: PlayerThreeBot = _bots.get(session)
			if bot == null:
				return _err("unknown_session", "")
			if args.size() != 1:
				return _err("invalid", "%s takes one argument" % method)
			if method == "init":
				bot.init(args[0])
				return _ok(null)
			var intents: Variant = bot.think(args[0])
			if typeof(intents) != TYPE_ARRAY or not PlayerThreeFraming.is_json_value(intents):
				return _err("engine_error", "think must return an Array of intents")
			return _ok(intents)
		"dispose":
			if args.size() != 0:
				return _err("invalid", "dispose takes no arguments")
			if _matches.has(session):
				var released: PlayerThreeAdapter = _matches[session]
				_matches.erase(session)
				_clocks.erase(session)
				if released.has_method(&"dispose"):
					released.call(&"dispose")
				_emit_deferred(&"session_disposed", [session])
				return _ok(null)
			if _bots.erase(session):
				return _ok(null)
			return _err("unknown_session", "")
		"clone":
			if not _hooks.has("clone"):
				return _err("unknown_method", "")
			var source: PlayerThreeAdapter = _matches.get(session)
			if source == null:
				return _err("unknown_session", "")
			if args.size() != 1 or typeof(args[0]) != TYPE_STRING or _matches.has(args[0]) or _bots.has(args[0]):
				return _err("invalid", "clone takes one new session id")
			var copy: Variant = source.call(&"clone")
			if not copy is PlayerThreeAdapter:
				return _err("engine_error", "clone must return a PlayerThreeAdapter")
			_matches[args[0]] = copy
			return _ok({"tick": copy.tick})
	var spec: Array = _MATCH_METHODS.get(method, [])
	if spec.is_empty() or (spec[3] and not _hooks.has(method)):
		return _err("unknown_method", "")
	var target: PlayerThreeAdapter = _matches.get(session)
	if target == null:
		return _err("unknown_session", "")
	var types: Array = spec[1]
	if args.size() != types.size():
		return _err("invalid", "%s takes %d arguments" % [method, types.size()])
	for i in types.size():
		if types[i] != TYPE_NIL and typeof(args[i]) != types[i]:
			return _err("invalid", "%s argument %d has the wrong type" % [method, i + 1])
	if method == "apply" and args[2] != null and typeof(args[2]) != TYPE_DICTIONARY:
		return _err("invalid", "apply context must be an object or null")
	var adapter_method: StringName = spec[0]
	if not target.has_method(adapter_method):
		return _err("engine_error", "adapter has no %s()" % adapter_method)
	var before := target.tick
	var value: Variant = target.callv(adapter_method, args)
	match spec[2]:
		"void":
			return _ok(null)
		"tick":
			if target.tick <= before:
				return _err("engine_error", "step must increase tick")
			return _ok({"tick": target.tick})
		"value":
			if value == null:
				return _err("engine_error", "%s returned null" % adapter_method)
	if not PlayerThreeFraming.is_json_value(value):
		return _err("engine_error", "%s returned a non-JSON value" % adapter_method)
	return _ok(value)


func _ok(data: Variant) -> Dictionary:
	return {"ok": true, "data": data}


func _err(code: String, message: String) -> Dictionary:
	var result := {"ok": false, "code": code}
	if not message.is_empty():
		result["message"] = message
	return result


## Fatal end of the connection: optionally tell the host why (§20.8 `error`), then close.
func _close_with(code: String, message: String, notify: bool) -> void:
	if _state == State.CLOSED:
		return
	if notify and _transport != null:
		var framed := PlayerThreeFraming.encode({"op": "error", "code": code, "message": message})
		_transport.write(framed["bytes"])
	_emit_deferred(&"failed", [code, message])
	_finish()


func _finish() -> void:
	_state = State.CLOSED
	_clocks.clear()
	_matches.clear()
	_bots.clear()
	if _transport != null:
		_exit_code = _transport.close(exit_grace_msec)
		_transport = null
	_emit_deferred(&"closed", [_exit_code])


func _emit_deferred(signal_name: StringName, args: Array) -> void:
	var call := Callable(self, &"emit_signal").bindv([signal_name] + args)
	call.call_deferred()
