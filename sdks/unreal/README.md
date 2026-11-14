# PlayerThree for Unreal (C++ sidecar SDK)

Seat MCP agents in an Unreal (or any C++) dedicated server through the PlayerThree **sidecar host** (SPEC §20.8,
wire protocol 1). Your engine keeps the simulation and the clock. The sidecar, the normal Node `PlayerThreeHost` in
its own process, serves MCP, OAuth, guards, seats, policies and bots' scheduling, and calls back into your game over
a local channel: the stdio of a host process your server spawns, or one Unix domain socket / named pipe. It never
uses a network interface.

## Layout

| Path | What |
|---|---|
| `Plugins/PlayerThree/Source/PlayerThreeCore` | The core, plain C++17 with no Unreal types: `SidecarClient`, framing, transports, `ManifestBuilder` and `t::*` schema nodes, the `GameDefinition` / `GameAdapter` / `BotCommander` interfaces. Vendors nlohmann/json 3.11.3 (MIT, see [NOTICE](NOTICE)). |
| `Plugins/PlayerThree/Source/PlayerThree` | The Unreal wrapper: `UPlayerThreeSubsystem` (a `UGameInstanceSubsystem` + `FTickableGameObject`). |
| `Plugins/PlayerThreeTugOfWar` | Unreal sample plugin: a replicated `ATugOfWarRope` actor, its adapter and `ATugOfWarGameMode`. |
| `Samples/TugOfWar`, `Samples/TugCli` | The same game as a plain C++ library and the `p3-tug` command-line server. |
| `Tests` | ctest suites for framing, schema/manifest, the sidecar client protocol and the OS transports. |

## The 30-second sample (CLI)

```sh
# from a PlayerThree checkout with dependencies installed (pnpm install)
cmake -S sdks/unreal -B build/unreal -DCMAKE_BUILD_TYPE=Release
cmake --build build/unreal
build/unreal/p3-tug -- node packages/sidecar/bin/playerthree-sidecar.ts --stdio
```

`p3-tug` sends `hello` with the Tug of War manifest, asks the host for one match (north is an agent seat, south is
the built-in `easy` bot), writes the north seat's bearer token to `./tug-seat-token` (mode 0600; `--token-file
<path>` to choose) and logs only that path and the MCP URL, then advances one tick every 100 ms until the host
pushes `ended`. Point an MCP client at that URL with that token and pull the rope. After the match it disposes it
and keeps the connection open until the host closes it (Ctrl-C to stop). Seat tokens are never logged.

To connect to a host that is already listening on a socket instead:

```sh
PLAYERTHREE_SIDECAR_SOCKET=/run/user/1000/p3.sock build/unreal/p3-tug
```

## Your own game

Describe the game as plain JSON and implement the adapter; the host guards everything you return.

**1. Describe the game.** `ManifestBuilder` builds the manifest as plain JSON from `t::*` schema
nodes.

```cpp
#include "PlayerThree/Manifest.h"
#include "PlayerThree/Sidecar.h"

namespace t = playerthree::t;

playerthree::Json manifest =
    playerthree::ManifestBuilder("tug", "1.0.0", "Tug of War", 10,
                                 "Pull the rope to your side (±10) to win.")
        .Teams({"north", "south"})
        .Roles({"puller"})
        .RoleDoc("puller", "Pulls the rope.")
        .Intent("pull", {"puller"}, {{"strength", t::Int(1, 3)}}, "Pull this tick.")
        .Observation(t::Obj({{"tick", t::Int(0, 100000)},
                             {"rope", t::Int(-10, 10, "+ is north")}}))
        .View(t::Obj({{"rope", t::Int(-10, 10)}}))
        .Report(t::Obj({{"outcome", t::Enum({"win", "loss", "draw", "running"})}}))
        .Event(t::Obj({{"tick", t::Int(0, 100000)}, {"kind", t::Enum({"slip"})}}))
        .Directive(t::Obj({}))
        .Errors({"tired"})
        .Opponents({"easy"})
        .IntentRate(4, 4)
        .Build();
```

**2. Define the game.** A `GameDefinition` returns the manifest and creates matches and built-in
bots.

```cpp
class MyGame : public playerthree::GameDefinition {
  // Manifest(), Create() -> GameAdapter, CreateBot()
};
```

**3. Connect to the host.** `SpawnHost` starts the sidecar over stdio. `Hello()` sends the
manifest and the declared hooks and waits for `ready`, which carries the surface hash and the
MCP URL (`client.SurfaceHash()`, `client.McpUrl()`).

```cpp
MyGame game;
playerthree::SidecarClient client(
    game,
    playerthree::SpawnHost(
        {"node", "<repo>/packages/sidecar/bin/playerthree-sidecar.ts", "--stdio"}));
client.Hello();
```

**4. Create a match and run the clock.** The seat token goes to a 0600 file, never to a log. Your
engine owns the clock: each loop advances one tick, then serves host calls for 100 ms.

```cpp
std::string session = client.CreateMatch(
    {{"seed", 1}, {"controllers", {{"north", {{"puller", "agent"}}}}}});
playerthree::WriteOwnerOnlyFile(
    "seat-token", client.MintSeatToken(session, "north", "puller"));
for (;;) {
  client.Step(session, 1);
  client.Poll(100);
}
```

A `GameAdapter` answers the eight §10 calls (`Step`, `Outcome`, `View`, `Observe`, `Apply`, `Report`, `Events`,
`SetSeatInfo`) with `playerthree::Json` (an insertion-ordered `nlohmann::ordered_json`). Optional hooks (`MatchData`,
`DebugView`, `ObserverView`, `End`, `Forfeit`, `Rank`, `Clone`, `SignalLimits`) are implemented by overriding them and
listing their names in `GameDefinition::Hooks()`; the host never calls an undeclared one. Built-in bots are yours:
the host forwards `createBot` / `init` / `think` to your `BotCommander`.

Everything runs on the calling thread. While `Step`, `Request` (and the helpers `CreateMatch`, `MintSeatToken`,
`DisposeMatch`) wait for their reply they keep answering the host's calls, as §20.8 requires; `Poll` serves calls
and pushes between steps. Push and close handlers must not start another request. An adapter that throws
`InvalidCall` answers `invalid`, any other exception `engine_error`; an unencodable or oversized result is answered as
`engine_error` instead of breaking the stream. Protocol violations by the host (bad frames, a line over 1048576
bytes, a result for an id that is not outstanding) close the connection.

## Unreal

1. Copy `Plugins/PlayerThree` (and, for the sample, `Plugins/PlayerThreeTugOfWar`) into your project's `Plugins/`.
2. Add `"PlayerThree", "PlayerThreeCore"` to your game module's dependencies and set `bEnableExceptions = true`
   in its `Build.cs` (the core reports errors as exceptions).
3. On the server, start the subsystem with your C++ definition:

```cpp
UPlayerThreeSubsystem* P3 = GetGameInstance()->GetSubsystem<UPlayerThreeSubsystem>();
// HostCommand (stdio), SocketPath or PLAYERTHREE_SIDECAR_SOCKET
FPlayerThreeSidecarSettings Settings;
FString Error;
P3->Start(std::make_shared<FMyGame>(GetWorld()), Settings, Error);
FString Session = P3->CreateMatch(TEXT("{\"seed\":1}"), /*bAutoStep=*/true, Error);
```

The subsystem polls the connection every frame (also while paused) and advances auto-stepped matches by the whole
ticks each frame covers at the manifest `tickRate`, at most `MaxTicksPerFrame` at once; a `paused` reply drops the
pending time. Blueprints get `CreateMatch`, `StepMatch`, `SetAutoStep`, `MintSeatToken`, `DisposeMatch`,
`HostRequest` (any host operation, JSON in and out), `IsConnected`, `GetSurfaceHash`, `GetMcpUrl`, and the `OnPush` /
`OnClosed` events. Only start it on a server (`GetNetMode() != NM_Client`).

Sample: enable `PlayerThreeTugOfWar`, set `ATugOfWarGameMode` as the map's game mode and run the dedicated server
with `-P3Host="node <repo>/packages/sidecar/bin/playerthree-sidecar.ts --stdio"` (or `-P3Socket=<path>`). The north
seat's token is written to `Saved/PlayerThree/tug-seat-token` (0600 on Linux and macOS); the log shows that path and
the MCP URL.

## Tests and conformance

Run these from the PlayerThree checkout after `pnpm install`. The conformance runner is the real
sidecar plus checks.

```sh
cmake -S sdks/unreal -B build/unreal
cmake --build build/unreal
ctest --test-dir build/unreal --output-on-failure
```

`framing`, `sidecar` and `transport` need nothing else; `schema` compares the C++ Tug manifest with
`packages/sidecar/conformance/tug.manifest.json`. `conformance_stdio` runs
`p3-tug -- node packages/sidecar/conformance/run.ts --stdio` (the engine spawns the runner in place of the sidecar and
exits with its verdict) and `conformance_socket` runs `node packages/sidecar/conformance/run.ts --socket -- p3-tug`
(the runner listens, the engine connects through `PLAYERTHREE_SIDECAR_SOCKET`). Both check the transcript, the error
codes, the 1048576-byte call and the 1048577-byte close. `-DP3_REPO=<checkout>` points at another checkout;
`-DP3_CONFORMANCE=OFF` skips the two runner tests (no node). With Visual Studio (multi-config) generators, build with
`cmake --build build/unreal --config Debug` and test with `ctest --test-dir build/unreal -C Debug`.

## Supported platforms

| | |
|---|---|
| **Tested in CI** (Linux: g++ with ASan/UBSan and clang with `-Werror`; macOS: AppleClang) | Framing (≤ 1048576 bytes excluding `\n`, chunked input, early rejection of oversized lines, UTF-8); every protocol-1 message and call method, error codes and fatal errors; hooks; engine-owned clock; host operations and pushes; request and hello timeouts; disconnect with matches kept for the engine; Unix domain socket client (`SO_PEERCRED` on Linux, `getpeereid` on macOS); spawned host over stdio with its exit code; `SIGPIPE`-safe writes; owner-only (0600, symlink-refusing) seat token files; manifest builder output equal to the conformance fixture; the CLI sample under the conformance runner over stdio and over a Unix socket. |
| **Tested in CI on Windows** (MSVC `/W4`) | Framing, schema and protocol suites; the CLI sample under the conformance runner over stdio (the `CreateProcessW` spawn path) and over a named pipe (with its server-SID check), writing the seat token file. The `transport` suite is POSIX-only. |
| **Unreal plugin and Unreal sample** | Not yet compiled in the Unreal Editor; CI tests the C++17 core they wrap. |
| **Implemented, not exercised by a test** | Refusing a socket whose host runs as another OS user (`SO_PEERCRED` / `getpeereid` / pipe server SID). |
| **CI** | [Engines](https://github.com/player-three-gg/player-three/actions/workflows/engines.yml) runs the CMake build and `ctest` on ubuntu (both compilers) for every push and pull request, and on Windows and macOS for pushes to `main`. |
| **Not supported** | Lobby operations that protocol 1 leaves out (`reserve`, `release`, `capabilities`); a Blueprint-implementable adapter (adapters are C++); Unreal-native JSON types (`FJsonObject`) in the public API. |
