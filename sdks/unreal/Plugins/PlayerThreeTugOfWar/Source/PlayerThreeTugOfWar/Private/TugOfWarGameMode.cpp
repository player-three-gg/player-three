// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "TugOfWarGameMode.h"

#include <exception>
#include <memory>

#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "PlayerThree/Transport.h"
#include "PlayerThreeSubsystem.h"
#include "TugOfWarGame.h"

DEFINE_LOG_CATEGORY_STATIC(LogTugOfWar, Log, All);

void ATugOfWarGameMode::BeginPlay()
{
	Super::BeginPlay();
	// The host runs next to the authoritative simulation only: never on a client.
	if (GetNetMode() == NM_Client) return;
	UPlayerThreeSubsystem* PlayerThree = GetGameInstance()->GetSubsystem<UPlayerThreeSubsystem>();
	if (!PlayerThree) return;

	FPlayerThreeSidecarSettings Settings;
	FString HostCommand;
	if (FParse::Value(FCommandLine::Get(), TEXT("P3Host="), HostCommand, /*bShouldStopOnSeparator=*/false))
	{
		HostCommand.ParseIntoArrayWS(Settings.HostCommand);
	}
	FParse::Value(FCommandLine::Get(), TEXT("P3Socket="), Settings.SocketPath);

	FString Error;
	if (!PlayerThree->Start(std::make_shared<FTugOfWarDefinition>(GetWorld()), Settings, Error))
	{
		UE_LOG(LogTugOfWar, Error, TEXT("PlayerThree sidecar did not start: %s"), *Error);
		return;
	}
	PlayerThree->OnPush.AddDynamic(this, &ATugOfWarGameMode::HandlePush);

	Session = PlayerThree->CreateMatch(
		TEXT("{\"seed\":1,\"controllers\":{\"north\":{\"puller\":\"agent\"},\"south\":{\"puller\":\"bot\"}},")
		TEXT("\"botLevel\":{\"south\":\"easy\"}}"),
		/*bAutoStep=*/true, Error);
	if (Session.IsEmpty())
	{
		UE_LOG(LogTugOfWar, Error, TEXT("createMatch failed: %s"), *Error);
		return;
	}
	const FString Token = PlayerThree->MintSeatToken(Session, TEXT("north"), TEXT("puller"), Error);
	if (Token.IsEmpty())
	{
		UE_LOG(LogTugOfWar, Error, TEXT("mintSeatToken failed: %s"), *Error);
		return;
	}
	// A seat token is a secret for the seat's owner: it goes to a file only this OS user can read, never to a log.
	const FString TokenPath = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() / TEXT("PlayerThree/tug-seat-token"));
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(TokenPath), /*Tree=*/true);
	try
	{
		playerthree::WriteOwnerOnlyFile(std::string(TCHAR_TO_UTF8(*TokenPath)), std::string(TCHAR_TO_UTF8(*Token)));
	}
	catch (const std::exception& WriteError)
	{
		UE_LOG(LogTugOfWar, Error, TEXT("could not write the seat token file: %s"), UTF8_TO_TCHAR(WriteError.what()));
		return;
	}
	UE_LOG(LogTugOfWar, Display, TEXT("match %s: connect an MCP client to %s with the bearer token in %s to play north/puller"),
	       *Session, *PlayerThree->GetMcpUrl(), *TokenPath);
}

void ATugOfWarGameMode::HandlePush(const FString& PushSession, const FString& Kind, const FString& DataJson)
{
	if (Kind != TEXT("ended") || PushSession != Session) return;
	UE_LOG(LogTugOfWar, Display, TEXT("match %s ended: %s"), *Session, *DataJson);
	// Pushes arrive inside the subsystem's Poll/Step; a host request must wait for the next frame.
	GetWorldTimerManager().SetTimerForNextTick([this] {
		UPlayerThreeSubsystem* PlayerThree = GetGameInstance()->GetSubsystem<UPlayerThreeSubsystem>();
		FString Error;
		if (PlayerThree && !PlayerThree->DisposeMatch(Session, Error))
		{
			UE_LOG(LogTugOfWar, Warning, TEXT("dispose failed: %s"), *Error);
		}
	});
}
