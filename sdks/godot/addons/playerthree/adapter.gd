# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## One running match of your game: the adapter contract (SPEC §10) the sidecar host calls, one call at a
## time and synchronously per tick. Extend it and implement every abstract method.
##
## Values are plain JSON: a seat is `{"team": String, "role": String}`, an intent is a Dictionary with
## `kind` plus its validated parameters, and whatever you return is guarded by the host against the
## manifest schemas before any agent sees it. Integral numbers arrive as [int].
##
## Optional hooks are ordinary methods you add and also list in [method PlayerThreeGame.hooks]:
## [codeblock]
## func match_data(seat: Dictionary) -> Variant          # "matchData", required with manifest.matchData
## func debug_view() -> Variant                          # "debugView"
## func observer_view() -> Variant                       # "observerView"
## func end(outcomes: Dictionary, ranks: Dictionary) -> void   # "end"
## func forfeit(team: String) -> void                    # "forfeit"
## func rank(team: String) -> int                        # "rank"
## func clone() -> PlayerThreeAdapter                    # "clone"
## func signal_limits() -> Variant                       # "signalLimits" (a Dictionary or null)
## [/codeblock]
## [method dispose], when present, runs once the host has released the match.
@abstract
class_name PlayerThreeAdapter
extends RefCounted

## The match's current tick: starts at the game's first tick and increases on every [method step].
var tick := 0


## Advances the simulation exactly one tick (and must increase [member tick]).
@abstract func step() -> void


## `"win"`, `"loss"`, `"draw"` or `"running"` for [param team].
@abstract func outcome(team: String) -> String


## `manifest.view` data for [param team]'s perspective. [param options] is `{"snapshot": bool}`.
@abstract func view(team: String, options: Dictionary) -> Variant


## `manifest.observation` for [param seat], fogged, with events newer than [param since_tick];
## [param detail] lists the observation sections to render in full.
@abstract func observe(seat: Dictionary, since_tick: int, detail: Array) -> Variant


## Applies one schema-valid, role-checked intent. Returns `{"ok": true}` or
## `{"ok": false, "code": <manifest error>}`. [param context] is `{"source", "ownerRoles"?}` or null.
@abstract func apply(seat: Dictionary, intent: Dictionary, context: Variant) -> Dictionary


## `manifest.report` for [param team].
@abstract func report(team: String) -> Variant


## Events visible to [param seat] with `tick > since_tick`, oldest first.
@abstract func events(seat: Dictionary, since_tick: int) -> Array


## Controller disclosure and owner mandate for [param seat]: `{"controller": String, "mandate": Dictionary}`.
@abstract func set_seat_info(seat: Dictionary, info: Dictionary) -> void
