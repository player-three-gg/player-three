# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## Tug of War (the README example): two teams, one `puller` role, a rope at -10..10, `pull` intents.
extends PlayerThreeGame

const TugMatch := preload("tug_match.gd")
const TugBot := preload("tug_bot.gd")


## The manifest, built with the addon's schema nodes; plain JSON identical to the Node SDK's.
static func build_manifest() -> PlayerThreeManifest:
	var S := PlayerThreeSchema
	var m := PlayerThreeManifest.new()
	m.id = "tug"
	m.version = "1.0.0"
	m.title = "Tug of War"
	m.tick_rate = 10
	m.doc = "Pull the rope to your side (±10) to win."
	m.teams = S.enumeration(["north", "south"])
	m.roles = S.enumeration(["puller"])
	m.role_doc("puller", "Pulls the rope.")
	m.intent("pull", ["puller"], {"strength": S.integer(1, 3)}, "Pull this tick.")
	m.observation = S.obj({"tick": S.integer(0, 100000), "rope": S.integer(-10, 10, "+ is north")})
	m.view = S.obj({"rope": S.integer(-10, 10)})
	m.report = S.obj({"outcome": S.enumeration(["win", "loss", "draw", "running"])})
	m.event = S.obj({"tick": S.integer(0, 100000), "kind": S.enumeration(["slip"])})
	m.directive = S.obj({})
	m.errors = S.enumeration(["tired"])
	m.opponents = S.enumeration(["easy"])
	m.control = {"intents": {"perSecond": 4, "burst": 4}}
	return m


func manifest() -> Dictionary:
	return build_manifest().to_dict()


func create_match(_options: Dictionary) -> PlayerThreeAdapter:
	return TugMatch.new()


func create_bot(_seat: Dictionary, _opponent: String, _options: Variant) -> PlayerThreeBot:
	return TugBot.new()
