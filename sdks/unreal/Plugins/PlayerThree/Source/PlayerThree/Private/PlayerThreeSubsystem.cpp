// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "PlayerThreeSubsystem.h"

#include <exception>
#include <string>
#include <vector>

#include "HAL/PlatformMisc.h"

DEFINE_LOG_CATEGORY_STATIC(LogPlayerThree, Log, All);

namespace
{
std::string ToUtf8(const FString& Text) { return std::string(TCHAR_TO_UTF8(*Text)); }
FString FromUtf8(const std::string& Text) { return FString(UTF8_TO_TCHAR(Text.c_str())); }

/** Parses Blueprint JSON text; throws std::invalid_argument for malformed input. */
playerthree::Json ParseJson(const FString& Text)
{
	playerthree::Json Value = playerthree::Json::parse(ToUtf8(Text), nullptr, /*allow_exceptions=*/false);
	if (Value.is_discarded()) throw std::invalid_argument("malformed JSON");
	return Value;
}

/** SidecarError messages name their code; Unreal builds without RTTI, so no dynamic_cast here. */
FString Describe(const std::exception& Error) { return FromUtf8(Error.what()); }
}  // namespace

bool UPlayerThreeSubsystem::Start(std::shared_ptr<playerthree::GameDefinition> InGame,
                                  const FPlayerThreeSidecarSettings& InSettings, FString& OutError)
{
	if (Client)
	{
		OutError = TEXT("already started");
		return false;
	}
	if (!InGame)
	{
		OutError = TEXT("a game definition is required");
		return false;
	}
	try
	{
		std::unique_ptr<playerthree::Transport> Transport;
		if (InSettings.HostCommand.Num() > 0)
		{
			std::vector<std::string> Command;
			for (const FString& Arg : InSettings.HostCommand) Command.push_back(ToUtf8(Arg));
			Transport = playerthree::SpawnHost(Command);
		}
		else
		{
			FString Socket = InSettings.SocketPath;
			if (Socket.IsEmpty()) Socket = FPlatformMisc::GetEnvironmentVariable(TEXT("PLAYERTHREE_SIDECAR_SOCKET"));
			if (Socket.IsEmpty())
			{
				OutError = TEXT("no HostCommand, SocketPath or PLAYERTHREE_SIDECAR_SOCKET");
				return false;
			}
			Transport = playerthree::ConnectSocket(ToUtf8(Socket));
		}
		playerthree::SidecarOptions Options;
		Options.requestTimeoutMs = InSettings.RequestTimeoutMs;
		auto NewClient = std::make_unique<playerthree::SidecarClient>(*InGame, std::move(Transport), Options);
		NewClient->OnPush([this](const playerthree::Push& Push) {
			const FString Session = FromUtf8(Push.session);
			if (Push.kind == "ended") AutoStep.Remove(Session);
			OnPush.Broadcast(Session, FromUtf8(Push.kind), FromUtf8(Push.data.dump()));
		});
		NewClient->OnClosed([this](const std::string& Reason) {
			AutoStep.Empty();
			UE_LOG(LogPlayerThree, Warning, TEXT("sidecar connection closed: %s"), *FromUtf8(Reason));
			OnClosed.Broadcast(FromUtf8(Reason));
		});
		NewClient->Hello();
		const std::int64_t TickRate = InGame->Manifest().at("tickRate").get<std::int64_t>();
		TickSeconds = 1.0 / static_cast<double>(TickRate);
		Settings = InSettings;
		Game = std::move(InGame);
		Client = std::move(NewClient);
		UE_LOG(LogPlayerThree, Display, TEXT("sidecar ready, surfaceHash %s, MCP %s"), *GetSurfaceHash(), *GetMcpUrl());
		return true;
	}
	catch (const std::exception& Error)
	{
		OutError = Describe(Error);
		return false;
	}
}

playerthree::GameAdapter* UPlayerThreeSubsystem::FindMatch(const FString& Session) const
{
	return Client ? Client->Match(ToUtf8(Session)) : nullptr;
}

void UPlayerThreeSubsystem::Stop()
{
	AutoStep.Empty();
	if (Client) Client->Close();
	Client.reset();
	Game.reset();
}

void UPlayerThreeSubsystem::Deinitialize()
{
	Stop();
	Super::Deinitialize();
}

bool UPlayerThreeSubsystem::IsConnected() const { return Client && Client->Connected(); }

FString UPlayerThreeSubsystem::GetSurfaceHash() const { return Client ? FromUtf8(Client->SurfaceHash()) : FString(); }

FString UPlayerThreeSubsystem::GetMcpUrl() const { return Client ? FromUtf8(Client->McpUrl()) : FString(); }

FString UPlayerThreeSubsystem::CreateMatch(const FString& SpecJson, bool bAutoStep, FString& OutError)
{
	if (!IsConnected())
	{
		OutError = TEXT("not connected");
		return FString();
	}
	try
	{
		const FString Session = FromUtf8(Client->CreateMatch(ParseJson(SpecJson)));
		if (bAutoStep) AutoStep.Add(Session, 0.0);
		return Session;
	}
	catch (const std::exception& Error)
	{
		OutError = Describe(Error);
		return FString();
	}
}

bool UPlayerThreeSubsystem::StepMatch(const FString& Session, int32 Ticks, int64& OutTick, FString& OutError)
{
	if (!IsConnected())
	{
		OutError = TEXT("not connected");
		return false;
	}
	try
	{
		OutTick = Client->Step(ToUtf8(Session), Ticks);
		return true;
	}
	catch (const std::exception& Error)
	{
		OutError = Describe(Error);
		return false;
	}
}

void UPlayerThreeSubsystem::SetAutoStep(const FString& Session, bool bAutoStep)
{
	if (bAutoStep)
	{
		AutoStep.FindOrAdd(Session, 0.0);
	}
	else
	{
		AutoStep.Remove(Session);
	}
}

FString UPlayerThreeSubsystem::MintSeatToken(const FString& Session, const FString& Team, const FString& Role,
                                             FString& OutError)
{
	if (!IsConnected())
	{
		OutError = TEXT("not connected");
		return FString();
	}
	try
	{
		return FromUtf8(Client->MintSeatToken(ToUtf8(Session), ToUtf8(Team), ToUtf8(Role)));
	}
	catch (const std::exception& Error)
	{
		OutError = Describe(Error);
		return FString();
	}
}

bool UPlayerThreeSubsystem::DisposeMatch(const FString& Session, FString& OutError)
{
	AutoStep.Remove(Session);
	if (!IsConnected())
	{
		OutError = TEXT("not connected");
		return false;
	}
	try
	{
		Client->DisposeMatch(ToUtf8(Session));
		return true;
	}
	catch (const std::exception& Error)
	{
		OutError = Describe(Error);
		return false;
	}
}

FString UPlayerThreeSubsystem::HostRequest(const FString& Method, const FString& ArgsJson, bool& bOk, FString& OutError)
{
	bOk = false;
	if (!IsConnected())
	{
		OutError = TEXT("not connected");
		return FString();
	}
	try
	{
		const FString Data = FromUtf8(Client->Request(ToUtf8(Method), ParseJson(ArgsJson)).dump());
		bOk = true;
		return Data;
	}
	catch (const std::exception& Error)
	{
		OutError = Describe(Error);
		return FString();
	}
}

void UPlayerThreeSubsystem::Tick(float DeltaTime)
{
	if (!Client) return;
	try
	{
		if (!Client->Poll(0)) return;
		// Engine-owned clock: each auto-stepped match advances by the whole ticks this frame's time covers, capped
		// so a long hitch does not ask the host for an unbounded catch-up.
		TArray<FString> Sessions;
		AutoStep.GetKeys(Sessions);
		for (const FString& Session : Sessions)
		{
			double* Pending = AutoStep.Find(Session);
			if (!Pending) continue;  // ended or closed during an earlier Step this frame
			*Pending += DeltaTime;
			const int64 Due = FMath::Min<int64>(static_cast<int64>(*Pending / TickSeconds), Settings.MaxTicksPerFrame);
			if (Due < 1) continue;
			*Pending = FMath::Max(0.0, *Pending - static_cast<double>(Due) * TickSeconds);
			try
			{
				Client->Step(ToUtf8(Session), Due);
			}
			catch (const playerthree::SidecarError& Error)
			{
				if (Error.code() == "paused")
				{
					// The host holds the clock (§18); drop the time instead of bursting on resume.
					if (double* Held = AutoStep.Find(Session)) *Held = 0.0;
				}
				else if (!Client->Connected())
				{
					return;
				}
				else
				{
					UE_LOG(LogPlayerThree, Warning, TEXT("auto-step of %s stopped: %s"), *Session, *Describe(Error));
					AutoStep.Remove(Session);
				}
			}
		}
	}
	catch (const std::exception& Error)
	{
		UE_LOG(LogPlayerThree, Error, TEXT("sidecar: %s"), *Describe(Error));
	}
}

TStatId UPlayerThreeSubsystem::GetStatId() const
{
	RETURN_QUICK_DECLARE_CYCLE_STAT(UPlayerThreeSubsystem, STATGROUP_Tickables);
}
