# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## Editor plugin: registers the project settings [PlayerThreeSidecar] falls back to when its own
## `program` / `arguments` are empty, so a project configures the host command once.
@tool
extends EditorPlugin


func _enter_tree() -> void:
	_add_setting(PlayerThreeSidecar.SETTING_PROGRAM, TYPE_STRING, "node", PROPERTY_HINT_NONE, "")
	_add_setting(PlayerThreeSidecar.SETTING_ARGUMENTS, TYPE_PACKED_STRING_ARRAY, PackedStringArray(), PROPERTY_HINT_NONE, "")


func _add_setting(name: String, type: int, default: Variant, hint: int, hint_string: String) -> void:
	if not ProjectSettings.has_setting(name):
		ProjectSettings.set_setting(name, default)
	ProjectSettings.set_initial_value(name, default)
	ProjectSettings.add_property_info({"name": name, "type": type, "hint": hint, "hint_string": hint_string})
