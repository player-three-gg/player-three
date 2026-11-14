// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// The Tug of War simulation state as a replicated actor: the server's adapter (FTugOfWarMatch) mutates it, clients
// render it. One rope per PlayerThree match session.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"

#include "TugOfWarRope.generated.h"

UCLASS()
class PLAYERTHREETUGOFWAR_API ATugOfWarRope : public AActor
{
	GENERATED_BODY()

public:
	ATugOfWarRope();

	/** -10..10; + is north. */
	UPROPERTY(Replicated, BlueprintReadOnly, Category = "Tug of War")
	int32 Rope = 0;

	/** The match tick (game ticks since creation, at 10 per second). */
	UPROPERTY(Replicated, BlueprintReadOnly, Category = "Tug of War")
	int64 MatchTick = 0;

	virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override;
};
