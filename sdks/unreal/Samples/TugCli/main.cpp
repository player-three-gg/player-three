// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// Tug of War as a plain C++ dedicated server on the PlayerThree sidecar (SPEC §20.8, wire protocol 1):
//
//   p3-tug [--token-file <path>] -- node <repo>/packages/sidecar/bin/playerthree-sidecar.ts --stdio
//   PLAYERTHREE_SIDECAR_SOCKET=<path> p3-tug [--token-file <path>]
//
// The first spawns the host over stdio, the second connects to a listening host. It sends `hello` with the Tug
// manifest, creates one engine-clocked match (north = an agent seat, south = the built-in easy bot), writes the north
// seat's MCP bearer token to an owner-only (0600) file (default ./tug-seat-token) and logs only that path and the
// MCP URL, advances one tick every 100 ms (tickRate 10) until the host pushes `ended`, disposes the match and reads
// until the host closes. Logs go to stderr. When it spawned the host, it exits with the host's exit code (the
// conformance runner's verdict).
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "PlayerThree/Sidecar.h"
#include "TugOfWar.h"

namespace {

int Usage() {
  std::cerr << "usage: p3-tug [--token-file <path>] -- <host command...>   (spawn the sidecar host over stdio)\n"
               "       PLAYERTHREE_SIDECAR_SOCKET=<path> p3-tug [--token-file <path>]   (connect to a listening host)\n";
  return 2;
}

}  // namespace

int main(int argc, char** argv) {
  using playerthree::Json;
  using Clock = std::chrono::steady_clock;

  std::vector<std::string> command;
  std::string tokenFile = "tug-seat-token";
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--") {
      command.assign(argv + i + 1, argv + argc);
      break;
    }
    if (arg == "--token-file" && i + 1 < argc) {
      tokenFile = argv[++i];
      continue;
    }
    if (arg == "-h" || arg == "--help") return Usage();
    std::cerr << "p3-tug: unknown argument " << arg << "\n";
    return Usage();
  }
  const char* socket = std::getenv("PLAYERTHREE_SIDECAR_SOCKET");
  if (command.empty() && (socket == nullptr || *socket == '\0')) return Usage();

  tug::TugDefinition game;
  const bool spawned = !command.empty();
  std::unique_ptr<playerthree::Transport> transport;
  try {
    // A spawned host gets 30 s to exit after the connection closes, so its exit code is not lost.
    transport = spawned ? playerthree::SpawnHost(command, 30000) : playerthree::ConnectSocket(socket);
  } catch (const std::exception& e) {
    std::cerr << "p3-tug: " << e.what() << "\n";
    return 1;
  }

  playerthree::SidecarClient client(game, std::move(transport));
  std::string session;
  bool ended = false;
  bool disposing = false;
  client.OnPush([&](const playerthree::Push& push) {
    if (push.kind == "ended" && push.session == session) {
      ended = true;
      std::cerr << "p3-tug: match " << push.session << " ended: " << push.data.dump() << "\n";
    }
  });
  client.OnClosed([](const std::string& reason) { std::cerr << "p3-tug: connection closed: " << reason << "\n"; });

  try {
    client.Hello();
    std::cerr << "p3-tug: ready, surfaceHash " << client.SurfaceHash() << "\n";
    session = client.CreateMatch(Json{{"seed", 1},
                                      {"controllers", {{"north", {{"puller", "agent"}}}, {"south", {{"puller", "bot"}}}}},
                                      {"botLevel", {{"south", "easy"}}}});
    // A seat token is a secret for the seat's owner: it goes to a file only this OS user can read, never to a log.
    playerthree::WriteOwnerOnlyFile(tokenFile, client.MintSeatToken(session, "north", "puller"));
    std::cerr << "p3-tug: match " << session << "; connect an MCP client to " << client.McpUrl()
              << " with the bearer token in " << tokenFile << " to play north/puller\n";

    const auto period = std::chrono::milliseconds(100);  // tickRate 10: one tick per 100 ms of game time
    Clock::time_point next = Clock::now();
    while (!ended) {
      const std::int64_t tick = client.Step(session, 1);
      if (tick % 50 == 0) {
        const tug::TugMatch* match = dynamic_cast<const tug::TugMatch*>(client.Match(session));
        std::cerr << "p3-tug: tick " << tick << " rope " << (match ? match->Rope() : 0) << "\n";
      }
      next += period;
      while (!ended) {
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(next - Clock::now()).count();
        if (left <= 0) break;
        if (!client.Poll(static_cast<int>(left))) throw playerthree::SidecarError("closed", "host closed");
      }
    }
    disposing = true;
    client.DisposeMatch(session);
    // Keep serving until the host closes the connection.
    while (client.Poll(1000)) {
    }
  } catch (const playerthree::SidecarError& e) {
    // Once the match is disposed (or its dispose is in flight) the host closing the channel is the normal end.
    if (!(disposing && !client.Connected())) {
      std::cerr << "p3-tug: " << e.what() << " [" << e.code() << "]\n";
      client.Close();
      return 1;
    }
  } catch (const std::exception& e) {
    std::cerr << "p3-tug: " << e.what() << "\n";
    client.Close();
    return 1;
  }
  client.Close();
  // Spawned under the conformance runner, the host's exit code is its verdict.
  if (spawned) return client.HostExitCode().value_or(1);
  return 0;
}
