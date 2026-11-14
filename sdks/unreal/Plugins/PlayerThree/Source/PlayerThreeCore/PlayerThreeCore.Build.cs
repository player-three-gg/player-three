// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using UnrealBuildTool;

// The engine-independent PlayerThree C++ core (sidecar client, framing, manifest builder, adapter interface): the
// same sources the CMake build tests outside Unreal. Plain C++17 with no UObject types.
public class PlayerThreeCore : ModuleRules
{
	public PlayerThreeCore(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		// The core and the vendored nlohmann/json report failures with exceptions.
		bEnableExceptions = true;
		// Each source keeps file-local helpers in anonymous namespaces; compile them as separate units.
		bUseUnity = false;
		PublicDependencyModuleNames.Add("Core");
	}
}
