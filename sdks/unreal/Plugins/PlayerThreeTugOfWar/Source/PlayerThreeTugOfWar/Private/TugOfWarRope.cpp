// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "TugOfWarRope.h"

#include "Net/UnrealNetwork.h"

ATugOfWarRope::ATugOfWarRope()
{
	bReplicates = true;
	bAlwaysRelevant = true;
	// The sidecar clock steps the rope, not the actor tick.
	PrimaryActorTick.bCanEverTick = false;
}

void ATugOfWarRope::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME(ATugOfWarRope, Rope);
	DOREPLIFETIME(ATugOfWarRope, MatchTick);
}
