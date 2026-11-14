// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// Drives the PlayerThree sidecar (SPEC §20.8) from an Unreal game instance, typically a dedicated server: it owns
// the SidecarClient, serves the host's adapter calls every frame and advances auto-stepped matches at the
// manifest's tick rate. Game logic stays in a C++ playerthree::GameDefinition; Blueprints get the session basics.
#pragma once

#include <memory>

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Tickable.h"

#include "PlayerThree/Sidecar.h"

#include "PlayerThreeSubsystem.generated.h"

/** How to reach the sidecar host. The engine is always the client. */
USTRUCT(BlueprintType)
struct PLAYERTHREE_API FPlayerThreeSidecarSettings
{
	GENERATED_BODY()

	/** Spawn the host over stdio, e.g. ["node", "<repo>/packages/sidecar/bin/playerthree-sidecar.ts", "--stdio"]. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "PlayerThree")
	TArray<FString> HostCommand;

	/** Otherwise connect to this socket (UDS path, or \\.\pipe\<name> on Windows); empty: PLAYERTHREE_SIDECAR_SOCKET. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "PlayerThree")
	FString SocketPath;

	/** Longest wait for a host reply, including an advance's thinking phase; the connection closes after it. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "PlayerThree", meta = (ClampMin = "100"))
	int32 RequestTimeoutMs = 60000;

	/** Most ticks one frame may ask the host to catch up on for an auto-stepped match. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "PlayerThree", meta = (ClampMin = "1"))
	int32 MaxTicksPerFrame = 10;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FPlayerThreePushSignature, const FString&, Session, const FString&, Kind,
                                               const FString&, DataJson);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FPlayerThreeClosedSignature, const FString&, Reason);

UCLASS()
class PLAYERTHREE_API UPlayerThreeSubsystem : public UGameInstanceSubsystem, public FTickableGameObject
{
	GENERATED_BODY()

public:
	/**
	 * Connects to the host and completes the handshake for `Game` (its manifest and hooks). The subsystem keeps the
	 * definition alive while connected. Returns false with OutError on failure.
	 */
	bool Start(std::shared_ptr<playerthree::GameDefinition> Game, const FPlayerThreeSidecarSettings& Settings,
	           FString& OutError);

	/** The match adapter the host created for a session (owned by the client), or nullptr. */
	playerthree::GameAdapter* FindMatch(const FString& Session) const;

	/** Closes the connection; the host disposes its sessions. */
	UFUNCTION(BlueprintCallable, Category = "PlayerThree")
	void Stop();

	UFUNCTION(BlueprintPure, Category = "PlayerThree")
	bool IsConnected() const;

	UFUNCTION(BlueprintPure, Category = "PlayerThree")
	FString GetSurfaceHash() const;

	/** The host's MCP endpoint, for connect instructions. */
	UFUNCTION(BlueprintPure, Category = "PlayerThree")
	FString GetMcpUrl() const;

	/**
	 * `createMatch` with a JSON spec ({"seed","teams","options","controllers","botLevel",…}); returns the session id,
	 * empty on failure. With bAutoStep the subsystem advances it at the manifest tick rate until it ends.
	 */
	UFUNCTION(BlueprintCallable, Category = "PlayerThree")
	FString CreateMatch(const FString& SpecJson, bool bAutoStep, FString& OutError);

	/** Engine clock: asks the host to run up to Ticks ticks now. Returns false with OutError (`paused`, `over`, …). */
	UFUNCTION(BlueprintCallable, Category = "PlayerThree")
	bool StepMatch(const FString& Session, int32 Ticks, int64& OutTick, FString& OutError);

	UFUNCTION(BlueprintCallable, Category = "PlayerThree")
	void SetAutoStep(const FString& Session, bool bAutoStep);

	/**
	 * The MCP bearer token of one seat. A secret for that seat's owner: never log it; hand it over in an owner-only
	 * file (playerthree::WriteOwnerOnlyFile) or the game's own authenticated channel.
	 */
	UFUNCTION(BlueprintCallable, Category = "PlayerThree")
	FString MintSeatToken(const FString& Session, const FString& Team, const FString& Role, FString& OutError);

	UFUNCTION(BlueprintCallable, Category = "PlayerThree")
	bool DisposeMatch(const FString& Session, FString& OutError);

	/** Any game-side host operation (`seats`, `setController`, `end`, …) with JSON array args; returns JSON data. */
	UFUNCTION(BlueprintCallable, Category = "PlayerThree")
	FString HostRequest(const FString& Method, const FString& ArgsJson, bool& bOk, FString& OutError);

	/** Host pushes (`seats`, `ended`, …) with their data as JSON. */
	UPROPERTY(BlueprintAssignable, Category = "PlayerThree")
	FPlayerThreePushSignature OnPush;

	/** The connection closed; matches still held can be continued with the game's own bots. */
	UPROPERTY(BlueprintAssignable, Category = "PlayerThree")
	FPlayerThreeClosedSignature OnClosed;

	// UGameInstanceSubsystem
	virtual void Deinitialize() override;

	// FTickableGameObject
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override;
	virtual ETickableTickType GetTickableTickType() const override { return ETickableTickType::Conditional; }
	virtual bool IsTickable() const override { return Client != nullptr; }
	/** The host keeps calling the adapter while the game is paused; keep serving it. */
	virtual bool IsTickableWhenPaused() const override { return true; }

private:
	std::shared_ptr<playerthree::GameDefinition> Game;
	std::unique_ptr<playerthree::SidecarClient> Client;
	FPlayerThreeSidecarSettings Settings;
	/** Seconds per game tick (1 / manifest tickRate). */
	double TickSeconds = 0.1;
	/** Auto-stepped sessions and their unspent frame time in seconds. */
	TMap<FString, double> AutoStep;
};
