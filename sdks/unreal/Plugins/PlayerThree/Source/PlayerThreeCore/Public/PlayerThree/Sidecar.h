// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// The engine end of the SPEC §20.8 (a) sidecar, wire protocol 1. The engine owns the simulation and clock: it sends
// `hello` with its manifest, asks the host for matches (`createMatch`), and drives each match with Step(session, n)
// (`advance`). The host owns MCP, OAuth, guards, seats and policies, and calls back into the GameDefinition's
// adapters and bots synchronously. Everything runs on the caller's thread; nothing here starts a thread.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "PlayerThree/Adapter.h"
#include "PlayerThree/Framing.h"
#include "PlayerThree/Json.h"
#include "PlayerThree/Transport.h"

namespace playerthree {

/** Wire protocol version sent in `hello`. */
inline constexpr int kProtocolVersion = 1;

/**
 * A failed sidecar operation. `code` is the host's result code (`paused`, `over`, `unknown_session`, `invalid`, …),
 * the host's fatal `error` code (`invalid_manifest`, `protocol`, `too_large`, `bad_frame`, `timeout`), or one of
 * this client's: `closed` (the connection is gone), `timeout` (no reply within SidecarOptions::requestTimeoutMs),
 * `busy` (a second engine request while one is outstanding, or a request from inside a host call).
 */
class P3_API SidecarError : public std::runtime_error {
 public:
  SidecarError(std::string code, const std::string& what) : std::runtime_error(what), code_(std::move(code)) {}
  const std::string& code() const noexcept { return code_; }

 private:
  std::string code_;
};

struct SidecarOptions {
  /** Per-message limit in both directions, excluding '\n'. */
  std::size_t maxMessageBytes = kMaxMessageBytes;
  /** How long Hello() waits for `ready`. */
  int helloTimeoutMs = 10000;
  /**
   * How long Step() and Request() wait for their reply; negative waits forever. An `advance` includes the host's
   * thinking phase, so keep this above the slowest policy/agent gate. On timeout the connection closes.
   */
  int requestTimeoutMs = 60000;
};

/** A host → engine push (`seats`, `ended`, …); no reply. */
struct Push {
  std::string session;
  std::string kind;
  Json data;
};

class P3_API SidecarClient {
 public:
  /** `game` must outlive the client. Nothing is sent until Hello(). */
  SidecarClient(GameDefinition& game, std::unique_ptr<Transport> transport, SidecarOptions options = {});
  ~SidecarClient();
  SidecarClient(const SidecarClient&) = delete;
  SidecarClient& operator=(const SidecarClient&) = delete;

  /** Sends `hello` (manifest + hooks) and waits for `ready`; throws SidecarError with the host's code. */
  void Hello();
  /** Hex `surfaceHash` and MCP endpoint URL from `ready`. */
  const std::string& SurfaceHash() const noexcept { return surfaceHash_; }
  const std::string& McpUrl() const noexcept { return mcpUrl_; }

  /**
   * Serves host calls and pushes for up to `timeoutMs` (0: only what is already readable). Returns false once the
   * connection is closed. Call it every frame while no Step() is running.
   */
  bool Poll(int timeoutMs);

  /**
   * Engine-owned clock: the host runs up to `n` ticks of `session` (thinking phase, gates, `apply` and `step`
   * calls, served here meanwhile) and returns the match tick. Throws SidecarError `paused`, `over`, … .
   */
  std::int64_t Step(const std::string& session, std::int64_t n);

  /**
   * A game-side host operation (`createMatch`, `mintSeatToken`, `seats`, `cards`, `readiness`, `setController`,
   * `setMandate`, `end`, `forfeit`, `dispose`); returns its `data`. Host calls are served while waiting.
   */
  Json Request(const std::string& method, Json args);

  /** `createMatch`: an engine-clocked match (the host calls `create` before replying); returns its session id. */
  std::string CreateMatch(const Json& spec);
  /** `mintSeatToken`: one seat's MCP bearer token. A secret for its owner: never log it (see WriteOwnerOnlyFile). */
  std::string MintSeatToken(const std::string& session, const std::string& team, const std::string& role);
  /** `dispose`: ends and releases the match (the host sends `call dispose` first). */
  void DisposeMatch(const std::string& session);

  /** The adapter of a live session, or nullptr. */
  GameAdapter* Match(const std::string& session) const;
  /** Live match session ids, sorted. */
  std::vector<std::string> Matches() const;
  /**
   * Takes a match away from the client: after a disconnect the host has dropped every session, and the engine
   * may keep playing it with its own bots (§20.8). Returns nullptr for an unknown session.
   */
  std::unique_ptr<GameAdapter> ReleaseMatch(const std::string& session);

  /** Called for every push, from inside Poll/Step/Request. Step, Request and Poll throw `busy` inside it. */
  void OnPush(std::function<void(const Push&)> handler) { onPush_ = std::move(handler); }
  /** Called once when the connection closes, with the reason. */
  void OnClosed(std::function<void(const std::string& reason)> handler) { onClosed_ = std::move(handler); }

  bool Connected() const noexcept { return transport_ != nullptr; }
  /** Closes the connection; the host disposes its sessions. Live matches stay available via ReleaseMatch. */
  void Close();
  /** Exit code of a spawned host after the connection closed (see Transport::ExitCode). */
  std::optional<int> HostExitCode() const noexcept { return hostExit_; }

 private:
  struct Reply {
    bool ok = false;
    Json data;
    std::string code;
    std::string message;
  };

  void Send(const Json& message);
  bool Pump(int timeoutMs);
  void Handle(const std::string& line);
  void HandleCall(const Json& message);
  Json Dispatch(const std::string& session, const std::string& method, const Json& args);
  Reply Await(int timeoutMs);
  /** Sends the fatal `error` notice (best effort) and closes. */
  void Abort(const std::string& code, const std::string& message);
  void Shutdown(const std::string& code, const std::string& reason);
  [[noreturn]] void ThrowClosed() const;
  std::int64_t BeginRequest();

  GameDefinition& game_;
  std::unique_ptr<Transport> transport_;
  SidecarOptions options_;
  LineDecoder decoder_;
  std::vector<char> buffer_;
  std::vector<std::string> hooks_;
  std::string surfaceHash_;
  std::string mcpUrl_;
  bool helloSent_ = false;
  bool ready_ = false;
  bool inCall_ = false;
  bool inPush_ = false;
  std::int64_t nextId_ = 1;
  std::int64_t outstanding_ = 0;  // engine request id awaiting its result, 0 when none
  bool replied_ = false;
  Reply reply_;
  std::map<std::string, std::unique_ptr<GameAdapter>> matches_;
  std::map<std::string, std::unique_ptr<BotCommander>> bots_;
  std::function<void(const Push&)> onPush_;
  std::function<void(const std::string&)> onClosed_;
  std::optional<int> hostExit_;
  std::string closeCode_;
  std::string closeReason_;
};

}  // namespace playerthree
