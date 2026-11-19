// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// Byte channels to the sidecar host (SPEC §20.8 (a)). The engine is always the client: it either spawns the host
// and talks over the child's stdin/stdout, or connects to the one local socket the host listens on (a Unix domain
// socket, or a named pipe on Windows). Neither opens a network port.
#pragma once

#include <cstddef>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "PlayerThree/Json.h"

namespace playerthree {

/** The channel could not be opened, failed, or reached end of stream. */
class P3_API TransportError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

/** A bidirectional byte stream. Used from one thread (the engine's game thread). */
class P3_API Transport {
 public:
  virtual ~Transport() = default;
  /**
   * Waits up to `timeoutMs` milliseconds (negative: no limit) for input and reads at most `capacity` bytes. Returns
   * 0 on timeout; throws TransportError at end of stream or on failure.
   */
  virtual std::size_t Read(char* buffer, std::size_t capacity, int timeoutMs) = 0;
  /** Writes every byte or throws TransportError. */
  virtual void Write(const char* data, std::size_t size) = 0;
  /** Closes the channel (the host then disposes this engine's sessions); waits for a spawned host. Idempotent. */
  virtual void Close() = 0;
  /** Exit code of a host this transport spawned, once Close() returned; empty for sockets or a signalled host. */
  virtual std::optional<int> ExitCode() const { return std::nullopt; }
};

/**
 * Starts the host as a child process (argv[0] resolved on PATH) and talks to it over the child's stdin/stdout,
 * e.g. `{"node", "packages/sidecar/bin/playerthree-sidecar.ts", "--stdio"}`. The child's stderr is inherited.
 * Close() closes the pipes and waits up to `exitWaitMs` for the child to exit before terminating it.
 */
P3_API std::unique_ptr<Transport> SpawnHost(const std::vector<std::string>& argv, int exitWaitMs = 5000);

/**
 * Connects to the socket a host listens on, as passed in `PLAYERTHREE_SIDECAR_SOCKET`: a Unix domain socket path
 * (Linux, macOS) or a named pipe (`\\.\pipe\<name>`, Windows). Refuses a host running as another OS user, so another
 * account cannot pose as the host.
 */
P3_API std::unique_ptr<Transport> ConnectSocket(const std::string& path);

/**
 * Writes a secret, such as a seat token from SidecarClient::MintSeatToken, to `path` for its owner to pick up,
 * instead of logging it. POSIX: the file is opened without following a symlink, created or truncated with mode 0600
 * and set to 0600 again before any byte is written. Windows: the file keeps its directory's ACL (use a directory
 * only this user can read, such as the profile). Throws TransportError on failure.
 */
P3_API void WriteOwnerOnlyFile(const std::string& path, const std::string& contents);

}  // namespace playerthree
