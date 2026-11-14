// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using UnrealBuildTool;

// UPlayerThreeSubsystem: the thin Unreal wrapper that drives the PlayerThreeCore sidecar client from the game thread.
public class PlayerThree : ModuleRules
{
	public PlayerThree(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		// SidecarClient reports failures as exceptions; the subsystem turns them into Blueprint error strings.
		bEnableExceptions = true;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "PlayerThreeCore" });
	}
}
