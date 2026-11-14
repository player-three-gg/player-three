# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## Test game declaring optional hooks, with an adapter that misbehaves on purpose where the dispatcher
## must catch it (a step that does not advance, null and non-JSON results).
extends PlayerThreeGame

var disposed := false


class HookMatch:
	extends PlayerThreeAdapter

	var game: RefCounted
	var ended := {}

	func _init(owner: RefCounted) -> void:
		game = owner
		tick = 5

	func step() -> void:
		pass

	func outcome(_team: String) -> String:
		return "running"

	func view(_team: String, _options: Dictionary) -> Variant:
		return {}

	func observe(_seat: Dictionary, _since_tick: int, _detail: Array) -> Variant:
		return null

	func apply(_seat: Dictionary, _intent: Dictionary, _context: Variant) -> Dictionary:
		return {"ok": false, "code": "tired"}

	func report(_team: String) -> Variant:
		return Vector2(1, 2)

	func events(_seat: Dictionary, _since_tick: int) -> Array:
		return []

	func set_seat_info(_seat: Dictionary, _info: Dictionary) -> void:
		pass

	func match_data(_seat: Dictionary) -> Variant:
		return {"lane": 2}

	func debug_view() -> Variant:
		return null

	func rank(_team: String) -> int:
		return 1

	func end(outcomes: Dictionary, _ranks: Dictionary) -> void:
		ended = outcomes

	func clone() -> PlayerThreeAdapter:
		var copy := HookMatch.new(game)
		copy.tick = tick
		return copy

	func dispose() -> void:
		game.disposed = true


class Idle:
	extends PlayerThreeBot

	func think(_observation: Variant) -> Array:
		return []


func manifest() -> Dictionary:
	return {}


func hooks() -> PackedStringArray:
	return PackedStringArray(["matchData", "debugView", "rank", "end", "clone"])


func create_match(_options: Dictionary) -> PlayerThreeAdapter:
	return HookMatch.new(self)


func create_bot(_seat: Dictionary, _opponent: String, _options: Variant) -> PlayerThreeBot:
	return Idle.new()
