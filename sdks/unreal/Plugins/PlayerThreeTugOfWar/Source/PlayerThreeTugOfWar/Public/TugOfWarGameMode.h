// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// Server game mode of the Tug of War sample. On a server it connects UPlayerThreeSubsystem to the sidecar host,
// creates one match (north = an agent seat, south = the built-in easy bot), writes the north seat token to the
// owner-only file Saved/PlayerThree/tug-seat-token and logs that path and the MCP endpoint (never the token), lets
// the subsystem step the match at 10 ticks per second and disposes it when the host pushes `ended`.
//
// Host selection, from the server command line:
//   -P3Host="node <repo>/packages/sidecar/bin/playerthree-sidecar.ts --stdio"   spawn the host over stdio
//   -P3Socket=<path>                                                           connect to a listening host
// Without either, PLAYERTHREE_SIDECAR_SOCKET is used.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"

#include "TugOfWarGameMode.generated.h"

UCLASS()
class PLAYERTHREETUGOFWAR_API ATugOfWarGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	/** The match's PlayerThree session id, once created. */
	UPROPERTY(BlueprintReadOnly, Category = "Tug of War")
	FString Session;

protected:
	virtual void BeginPlay() override;

private:
	UFUNCTION()
	void HandlePush(const FString& PushSession, const FString& Kind, const FString& DataJson);
};
