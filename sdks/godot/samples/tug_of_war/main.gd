# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## Tug of War dedicated server: spawns the sidecar host, creates one match (north: an MCP agent seat,
## south: the built-in `easy` bot), logs the agent's MCP URL and the path of an owner-only file holding
## the seat token (tokens never go to the log), runs the engine clock until the match ends, then
## disposes it and exits with the host's exit code.
##
##   godot --headless --path sdks/godot -- [--conformance] [--node=node] [--sidecar=<entry.ts>] [-- <host args…>]
##
## `--conformance` spawns the conformance runner (`packages/sidecar/conformance/run.ts --stdio`) in place
## of the sidecar: it is the real host plus checks, and its exit code becomes this process's. Arguments
## after a second `--` go to the host after `--stdio` (e.g. `-- --port 8787`).
extends Node

const TugGame := preload("tug_game.gd")
const TugMatch := preload("tug_match.gd")
## The north seat's bearer token, readable by this OS user only; removed when the host connection closes.
const TOKEN_FILE := "user://tug-seat-token"

var _sidecar: PlayerThreeSidecar
var _session := ""
var _conformance := false
var _failure := ""


func _ready() -> void:
	var user_args := OS.get_cmdline_user_args()
	var split := user_args.find("--")
	var host_args := user_args.slice(split + 1) if split != -1 else PackedStringArray()
	var options := _parse_args(user_args.slice(0, split) if split != -1 else user_args)
	_conformance = options.has("conformance")
	var repo := ProjectSettings.globalize_path("res://").path_join("../..").simplify_path()
	var default_entry := "packages/sidecar/conformance/run.ts" if _conformance else "packages/sidecar/bin/playerthree-sidecar.ts"
	var entry: String = options.get("sidecar", repo.path_join(default_entry))
	var args := PackedStringArray([entry, "--stdio"])
	args.append_array(host_args)

	_sidecar = PlayerThreeSidecar.new()
	_sidecar.program = options.get("node", "node")
	_sidecar.arguments = args
	_sidecar.connected.connect(_on_connected)
	_sidecar.failed.connect(_on_failed)
	_sidecar.match_ended.connect(_on_match_ended)
	_sidecar.advanced.connect(_on_advanced)
	_sidecar.closed.connect(_on_closed)
	add_child(_sidecar)
	var err := _sidecar.start(TugGame.new())
	if err != OK:
		printerr("tug: could not start the sidecar: ", error_string(err))
		get_tree().quit(1)


func _on_connected(surface_hash: String, mcp_url: String) -> void:
	print("tug: host ready, surfaceHash ", surface_hash)
	var created := _sidecar.create_match({
		"seed": 1,
		"controllers": {"north": {"puller": "agent"}, "south": {"puller": "bot"}},
		"botLevel": {"south": "easy"},
	})
	if not created["ok"]:
		_fail("createMatch failed: %s" % created["code"])
		return
	_session = created["data"]["session"]
	var minted := _sidecar.request("mintSeatToken", [_session, "north", "puller"])
	if not minted["ok"]:
		_fail("mintSeatToken failed: %s" % minted["code"])
		return
	var token_path := _write_token(minted["data"]["token"])
	if token_path.is_empty():
		_fail("could not write the seat token file")
		return
	print("tug: match %s; connect an MCP agent to %s with the bearer token in %s" % [_session, mcp_url, token_path])


## Writes [param token] to TOKEN_FILE with owner-only permissions; returns its absolute path, or "" on
## failure. The file is emptied and restricted before the token is written, so it is never readable by
## others while it holds the secret.
func _write_token(token: String) -> String:
	var file := FileAccess.open(TOKEN_FILE, FileAccess.WRITE)
	if file == null:
		return ""
	file.close()
	# Windows has no Unix modes; user:// lives in the user's own profile directory there.
	if OS.get_name() != "Windows" and FileAccess.set_unix_permissions(TOKEN_FILE, FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER) != OK:
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TOKEN_FILE))
		return ""
	file = FileAccess.open(TOKEN_FILE, FileAccess.WRITE)
	if file == null:
		return ""
	file.store_string(token + "\n")
	file.close()
	return ProjectSettings.globalize_path(TOKEN_FILE)


func _on_advanced(session: String, tick: int) -> void:
	# Once per game second; until an agent plays north, its absent seat falls back and the rope stays near 0.
	var game := _sidecar.adapter(session) as TugMatch
	if game != null and tick % 10 == 0:
		print("tug: tick %d, rope %d" % [tick, game.rope])


func _on_match_ended(session: String, outcomes: Dictionary, _ranks: Dictionary) -> void:
	if session != _session:
		return
	var game := _sidecar.adapter(session)
	print("tug: match %s ended at tick %d: %s" % [session, game.tick if game != null else -1, JSON.stringify(outcomes)])
	var disposed := _sidecar.request("dispose", [session])
	if not disposed["ok"] and not _conformance:
		_failure = "dispose failed: %s" % disposed["code"]
	_sidecar.close()


func _on_failed(code: String, message: String) -> void:
	# Under --conformance the runner provokes fatal errors on purpose; its exit code is the verdict.
	if not _conformance:
		_failure = "%s %s" % [code, message]
	printerr("tug: connection failed: ", code, " ", message)


func _on_closed(exit_code: int) -> void:
	print("tug: sidecar exited with ", exit_code)
	# The host revoked the token when it disposed the session; don't leave the dead secret behind.
	if FileAccess.file_exists(TOKEN_FILE):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TOKEN_FILE))
	if _conformance:
		get_tree().quit(0 if exit_code == 0 else 1)
	elif not _failure.is_empty():
		printerr("tug: ", _failure)
		get_tree().quit(1)
	else:
		get_tree().quit(0 if exit_code == 0 else 1)


func _fail(message: String) -> void:
	_failure = message
	_sidecar.close()


func _parse_args(user_args: PackedStringArray) -> Dictionary:
	var options := {}
	for arg in user_args:
		if not arg.begins_with("--"):
			continue
		var pair := arg.substr(2).split("=", true, 1)
		options[pair[0]] = pair[1] if pair.size() == 2 else ""
	return options
