# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## A built-in commander (SPEC §10 `createBot`): the host runs it for bot seats and practice opponents and
## sends it the same observations agents get. It must use exactly the intents agents use.
@abstract
class_name PlayerThreeBot
extends RefCounted


## Runs once before the first [method think] with the seat's guarded match data (null when the
## manifest declares none). Override when the bot needs it.
func init(match_data: Variant) -> void:
	pass


## The intents to send for this observation (possibly none).
@abstract func think(observation: Variant) -> Array
