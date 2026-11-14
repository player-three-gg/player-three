# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## Builds a game manifest (SPEC §3) as plain JSON, the `manifest` of the sidecar `hello` (§20.8).
## Member names map to the Node SDK's `defineManifest` keys in camelCase ([member tick_rate] →
## `tickRate`). Schema members take [PlayerThreeSchema] nodes. The host runs the full manifest checks
## at `hello`; [method check] catches missing or mistyped members before the host is spawned.
class_name PlayerThreeManifest
extends RefCounted

var id := ""
var version := ""
var title := ""
## Core rules every seat reads first (≤ 6000 characters).
var doc := ""
## Simulation ticks per second of game time.
var tick_rate := 0
## [method PlayerThreeSchema.enumeration] of team ids.
var teams := {}
## [method PlayerThreeSchema.enumeration] of role ids.
var roles := {}
## Role id → briefing text; see [method role_doc].
var role_docs := {}
## Intent kind → `{roles, params, doc}`; see [method intent].
var intents := {}
var observation := {}
var view := {}
var directive := {}
var errors := {}
var opponents := {}
var report := {}
## Must be an object schema with `tick` (int) and `kind` (enum) fields.
var event := {}
## Topic name → `{summary, text}`; see [method topic].
var topics := {}
## Agent Skills; see [method skill].
var skills: Array[Dictionary] = []
## `manifest.control`, e.g. `{"intents": {"perSecond": 4, "burst": 4}}`.
var control := {}

# Optional members: an empty Dictionary leaves the member out.
var observation_scope := {}
var observer := {}
var match_data := {}
var lobby := {}
var limits := {}
var match_options := {}
var signals := {}


## Declares a role's agent briefing.
func role_doc(role: String, text: String) -> PlayerThreeManifest:
	role_docs[role] = text
	return self


## Declares intent [param kind]: the [param allowed_roles] that may send it, its parameter fields
## (name → schema node) and its tool documentation.
func intent(kind: String, allowed_roles: Array, params: Dictionary, intent_doc: String) -> PlayerThreeManifest:
	intents[kind] = {"roles": allowed_roles.duplicate(), "params": params, "doc": intent_doc}
	return self


## Declares an on-demand briefing topic.
func topic(name: String, summary: String, topic_text: String) -> PlayerThreeManifest:
	topics[name] = {"summary": summary, "text": topic_text}
	return self


## Declares an Agent Skill: [param files] maps relative paths to UTF-8 content and must include `SKILL.md`.
func skill(name: String, description: String, files: Dictionary) -> PlayerThreeManifest:
	skills.append({"name": name, "description": description, "files": files})
	return self


## The manifest as a plain-JSON [Dictionary].
func to_dict() -> Dictionary:
	var m := {
		"id": id,
		"version": version,
		"title": title,
		"doc": doc,
		"tickRate": tick_rate,
		"teams": teams,
		"roles": roles,
		"roleDocs": role_docs,
		"intents": intents,
		"observation": observation,
		"view": view,
		"directive": directive,
		"errors": errors,
		"opponents": opponents,
		"report": report,
		"event": event,
		"topics": topics,
		"skills": skills,
		"control": control,
	}
	var optional := {
		"observationScope": observation_scope,
		"observer": observer,
		"matchData": match_data,
		"lobby": lobby,
		"limits": limits,
		"matchOptions": match_options,
		"signals": signals,
	}
	for key: String in optional:
		if not optional[key].is_empty():
			m[key] = optional[key]
	return m


## The manifest as one line of JSON.
func to_json() -> String:
	return JSON.stringify(to_dict(), "", false)


## Problems the host would refuse outright; empty when the manifest is complete. Bounds, regexes and
## cross-references beyond these are the host's checks.
func check() -> PackedStringArray:
	var problems := PackedStringArray()
	for pair: Array in [["id", id], ["version", version], ["title", title], ["doc", doc]]:
		if pair[1].is_empty():
			problems.append("%s is required" % pair[0])
	if tick_rate <= 0:
		problems.append("tickRate must be a positive integer")
	for pair: Array in [["teams", teams], ["roles", roles], ["errors", errors], ["opponents", opponents]]:
		if pair[1].get("t") != "enum":
			problems.append("%s must be an enum schema" % pair[0])
	for pair: Array in [["observation", observation], ["view", view], ["report", report]]:
		if not pair[1].has("t"):
			problems.append("%s must be a schema" % pair[0])
	for pair: Array in [["directive", directive], ["event", event]]:
		if pair[1].get("t") != "obj":
			problems.append("%s must be an object schema" % pair[0])
	if event.get("t") == "obj":
		var fields: Dictionary = event.get("fields", {})
		if fields.get("tick", {}).get("t") != "int" or fields.get("kind", {}).get("t") != "enum":
			problems.append("event needs fields tick (int) and kind (enum)")
	if intents.is_empty():
		problems.append("at least one intent is required")
	var role_ids: Array = roles.get("values", [])
	for role: Variant in role_ids:
		if not role_docs.has(role):
			problems.append("roleDocs.%s is required" % role)
	for kind: String in intents:
		for role: Variant in intents[kind]["roles"]:
			if not role in role_ids:
				problems.append("intents.%s names unknown role %s" % [kind, role])
	if typeof(control.get("intents")) != TYPE_DICTIONARY:
		problems.append("control.intents is required")
	return problems
