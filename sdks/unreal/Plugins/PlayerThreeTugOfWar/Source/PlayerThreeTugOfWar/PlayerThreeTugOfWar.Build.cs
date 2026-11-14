// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using UnrealBuildTool;

// Tug of War on the PlayerThree sidecar: the rope actor, its adapter and a server game mode.
public class PlayerThreeTugOfWar : ModuleRules
{
	public PlayerThreeTugOfWar(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		bEnableExceptions = true;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "PlayerThree", "PlayerThreeCore" });
	}
}
