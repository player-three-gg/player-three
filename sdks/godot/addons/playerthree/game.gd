# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## Your game's definition for the sidecar (SPEC §10 `GameDefinition`): its manifest, its optional
## adapter hooks, and factories for matches and built-in bots.
@abstract
class_name PlayerThreeGame
extends RefCounted

## Optional adapter calls a sidecar host may make, by wire name.
const HOOKS: PackedStringArray = ["matchData", "debugView", "observerView", "end", "forfeit", "rank", "clone", "signalLimits"]


## The plain-JSON manifest, e.g. [method PlayerThreeManifest.to_dict].
@abstract func manifest() -> Dictionary


## The optional hooks every adapter of this game implements (a subset of [constant HOOKS]). Declare
## `matchData` exactly when the manifest declares `matchData`.
func hooks() -> PackedStringArray:
	return PackedStringArray()


## A new match. [param options] is `{"seed": int, "teams": Array, "options"?: Dictionary,
## "alliances"?: Dictionary}`, already validated by the host. Return null when the game cannot play
## those sides; the host's `createMatch` then fails.
@abstract func create_match(options: Dictionary) -> PlayerThreeAdapter


## A built-in bot of strength [param opponent] (a manifest `opponents` literal) for [param seat].
## [param options] is the game's bot-options object or null.
@abstract func create_bot(seat: Dictionary, opponent: String, options: Variant) -> PlayerThreeBot
