# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## The `easy` Tug of War bot: pulls with strength 1 every time it thinks.
extends PlayerThreeBot


func think(_observation: Variant) -> Array:
	return [{"kind": "pull", "strength": 1}]
