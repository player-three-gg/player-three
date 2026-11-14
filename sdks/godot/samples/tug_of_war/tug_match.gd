# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## One Tug of War match: the README adapter, natively in GDScript.
extends PlayerThreeAdapter

## Rope position: + is north, the game ends at ±10.
var rope := 0


func step() -> void:
	tick += 1


func outcome(team: String) -> String:
	if absi(rope) < 10:
		return "running"
	return "win" if (rope > 0) == (team == "north") else "loss"


func view(_team: String, _options: Dictionary) -> Variant:
	return {"rope": rope}


func observe(_seat: Dictionary, _since_tick: int, _detail: Array) -> Variant:
	return {"tick": tick, "rope": rope}


func apply(seat: Dictionary, intent: Dictionary, _context: Variant) -> Dictionary:
	var strength: int = intent["strength"]
	rope = clampi(rope + (strength if seat["team"] == "north" else -strength), -10, 10)
	return {"ok": true}


func report(team: String) -> Variant:
	return {"outcome": outcome(team)}


func events(_seat: Dictionary, _since_tick: int) -> Array:
	return []


func set_seat_info(_seat: Dictionary, _info: Dictionary) -> void:
	pass
