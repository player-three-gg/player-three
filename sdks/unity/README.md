# PlayerThree for Unity and .NET

Seat MCP agents, policies and bots in a Unity (or any C#) dedicated server. Your server keeps the simulation and the
clock; the PlayerThree **sidecar** host runs next to it as a separate process and serves MCP, OAuth, guards, scopes,
mandates, presence, policies and sessions ([SPEC §20.8](../../spec/SPEC.md#208-engine-reach)). The two speak
newline-delimited JSON over the sidecar's stdio or an owner-only local socket, never a network interface.

```text
sdks/unity/
  gg.playerthree.sidecar/        Unity package (UPM)
    Runtime/Core/                engine-independent core; also the .NET library sources
    Runtime/Unity/               PlayerThreeSidecarRunner MonoBehaviour
    Samples~/TugOfWar/           Tug of War game (shared) and the scene script
  dotnet/
    PlayerThree.Sidecar/         the core as a netstandard2.1 library
    PlayerThree.Sidecar.Tests/   xunit tests: JSON, framing, manifest, scripted host
    TugOfWar.Console/            Tug of War as a plain .NET console server
```

## Install

**Unity 2021.3+** (API compatibility level .NET Standard 2.1): Package Manager → *Add package from git URL…*

```text
https://github.com/player-three-gg/player-three.git?path=/sdks/unity/gg.playerthree.sidecar
```

then import the *Tug of War* sample from the package's page. The sidecar host needs Node 24+; by default the runner
spawns it from a checkout of this repository next to the Unity project folder:
`node ../player-three/packages/sidecar/bin/playerthree-sidecar.ts --stdio`.

**.NET** (any netstandard2.1 runtime): reference `dotnet/PlayerThree.Sidecar/PlayerThree.Sidecar.csproj`. No NuGet
dependencies; the core carries its own small JSON reader and writer.

## The 30-second sample

```sh
# Once, at the repository root
pnpm install
cd sdks/unity/dotnet
# Spawns the sidecar, starts a match, prints the agent's connect line
dotnet run --project TugOfWar.Console
```

It prints the MCP endpoint and a `claude mcp add …` line that reads the north seat's token from an owner-only file
(mode 0600, `~/.local/share/playerthree/tug-seat-token` on Linux); the token itself is never printed or logged. South is
the built-in `easy` bot. The engine advances one tick every 100 ms until a side drags the rope to ±10. Until an agent
connects, the absent north seat falls back to the same bot, so the rope holds at 0 and the match runs until you stop
it (Ctrl-C).

The whole game is [`Samples~/TugOfWar/TugOfWar.cs`](gg.playerthree.sidecar/Samples~/TugOfWar/TugOfWar.cs).
The console server around it is [`TugOfWar.Console/Program.cs`](dotnet/TugOfWar.Console/Program.cs).

**1. Describe the game.** `Tug.Manifest()` builds the manifest. `Build()` returns the same plain
JSON as the TypeScript `defineManifest`.

```csharp title="TugOfWar.cs"
public static JsonValue Manifest() =>
    new ManifestBuilder("tug", "1.0.0", "Tug of War")
        .TickRate(10)
        .Doc("Pull the rope to your side (±10) to win.")
        .Teams("north", "south")
        .Roles("puller")
        .RoleDoc("puller", "Pulls the rope.")
        .Intent("pull", new[] { "puller" }, "Pull this tick.", ("strength", T.Int(1, 3)))
        .Observation(T.Obj(
            ("tick", T.Int(0, 100000)),
            ("rope", T.Int(-10, 10, "+ is north"))))
        .View(T.Obj(("rope", T.Int(-10, 10))))
        .Report(T.Obj(("outcome", T.Enum("win", "loss", "draw", "running"))))
        .Event(T.Obj(("tick", T.Int(0, 100000)), ("kind", T.Enum("slip"))))
        .Directive(T.Obj())
        .Errors("tired")
        .Opponents("easy")
        .IntentRate(4, 4)
        .Build();
```

**2. Create matches and bots.** The host calls `TugGame.Create` for each new match and
`CreateBot` for each built-in bot seat.

```csharp title="TugOfWar.cs"
public sealed class TugGame : IGame
{
    public IAdapter Create(CreateRequest request) => new TugMatch();
    public IBot CreateBot(Seat seat, string opponent, JsonValue options) => new TugBot();
}
```

**3. Run one match.** `TugMatch` implements the eight `IAdapter` calls: `Observe`, `Apply`, `View`,
`Report`, `Events`, `Step`, `Outcome` and `SetSeatInfo`. `Apply` moves the rope for each `pull`
intent the host has already validated.

```csharp title="TugOfWar.cs"
public sealed class TugMatch : IAdapter
{
    public int Tick { get; private set; }
    public int Rope { get; private set; }

    public void Step() => Tick++;

    public ApplyResult Apply(Seat seat, JsonValue intent, IntentContext context)
    {
        var strength = intent["strength"].AsInt();
        Rope = Math.Max(-10, Math.Min(10,
            Rope + (seat.Team == "north" ? strength : -strength)));
        return ApplyResult.Accepted;
    }

    // …
}
```

**4. Start the sidecar.** The server spawns the sidecar host over stdio and sends `hello` with the
manifest, the game and the declared hooks.

```csharp title="Program.cs"
using var sidecar = PlayerThreeSidecar.Start(
    SidecarTransport.Spawn(
        "node",
        new[] { "packages/sidecar/bin/playerthree-sidecar.ts", "--stdio" }),
    new SidecarOptions
    {
        Manifest = Tug.Manifest(),
        Game = new TugGame(),
        Hooks = HookSet.Of<TugMatch>(),
    });
```

**5. Create a match and run the clock.** The engine owns the clock: each `Step` advances one tick,
and `Pump(100)` answers host calls for 100 ms before the next tick.

```csharp title="Program.cs"
var session = sidecar.CreateMatch(JsonValue.Parse(
    "{\"seed\":1,\"controllers\":{\"north\":{\"puller\":\"agent\"}}}"));
while (!sidecar.HasEnded(session))
{
    sidecar.Step(session, 1);
    sidecar.Pump(100);
}
```

In Unity, add `TugOfWarServer` (from the imported sample) to a GameObject in an empty scene and press Play: it adds a
`PlayerThreeSidecarRunner`, which answers host calls in `Update` and advances the clock from `FixedUpdate` at the
manifest's `tickRate`. The seat token goes to an owner-only file under `Application.persistentDataPath`; the log shows
only that path and the MCP URL, and the screen shows a connect line that reads the file.

## How it works

- `PlayerThreeSidecar.Start(transport, options)` sends `hello` with the manifest and the declared hooks and waits for
  `ready` (`SurfaceHash`, `McpUrl`). Transports: `SidecarTransport.Spawn` (the sidecar over stdio, the primary mode),
  `SidecarTransport.Connect(path)` (a host listening on a Unix domain socket or `\\.\pipe\name`),
  `SidecarTransport.FromEnvironment()` (`PLAYERTHREE_SIDECAR_SOCKET`), `SidecarTransport.FromStreams`.
- **Your game** implements `IGame` (`Create` a match, `CreateBot` a built-in bot) and `IAdapter` per match (§10's
  eight calls). Optional hooks are interfaces — `IMatchDataAdapter`, `IDebugViewAdapter`, `IObserverViewAdapter`,
  `IEndAdapter`, `IForfeitAdapter`, `IRankAdapter`, `ICloneAdapter` — declared with `Hooks = HookSet.Of<TMatch>()`. An
  adapter implementing `IDisposable` is disposed when the host releases its session.
- **Threading:** a background thread reads the channel; host calls run only on the thread that called `Start`, inside
  `Pump()`, `Pump(ms)`, `Step(session, n)` and `Request(...)`, so adapters touch engine state without locks. Calling
  those from another thread, or from inside an adapter call, throws. `WorkAvailable` fires on the reader thread when
  calls are waiting, for engines that schedule `Pump()` on their own loop instead of polling.
- **Engine-owned clock:** `Step(session, n)` sends `advance`; while it is outstanding the SDK answers the host's
  `apply`/`step`/`observe`… calls on your thread and returns the new tick. `paused` and `over` arrive as
  `SidecarRequestException.Code`.
- **Game-side operations:** `CreateMatch`, `MintSeatToken`, `DisposeSession`, and `Request(method, args…)` for the rest
  (`seats`, `cards`, `readiness`, `setController`, `setMandate`, `end`, `forfeit`). Never log a seat token:
  `SeatTokenFile.Write(path, token)` puts it in a file only the current OS user can read (0600 on Unix, created empty
  and restricted before the token is written; on Windows choose a folder under the user profile).
- **Failures:** an adapter exception answers `engine_error`; malformed arguments `invalid`; unknown methods and
  sessions `unknown_method` / `unknown_session`; a result over the 1048576-byte message limit `engine_error`. An
  oversized or malformed inbound line, an unexpected result id, a request timeout or the host closing the channel
  closes the connection: `Closed` fires on your thread, and the host has disposed every session — move agent and
  policy seats to your own bots.

## Supported platforms

| | |
|---|---|
| Sidecar wire protocol 1: hello/ready, calls, results, advance, host operations, pushes, fatal `error` | Yes |
| stdio (spawn the sidecar), Unix domain socket, Windows named pipe | Yes (.NET 8 on Linux, Windows and macOS; the named pipe on Windows) |
| Typed manifest builder for the whole closed schema vocabulary, topics, skills, control modes | Yes |
| Optional hooks matchData, debugView, observerView, end, forfeit, rank, clone | Yes |
| Team signals (`manifest.signals`, `signalLimits`) | Not supported |
| Lobby profile `reserve`/`release`/`capabilities` | Not in protocol 1 |
| Unity `PlayerThreeSidecarRunner` and the Tug scene script | Not yet compiled in the Unity Editor; CI tests the .NET core they wrap |
| CI | [Engines](https://github.com/player-three-gg/player-three/actions/workflows/engines.yml) runs `dotnet test` and the console sample under the conformance runner over stdio and a socket, on ubuntu for every push and pull request and on Windows and macOS for pushes to `main` |

## Develop

```sh
cd sdks/unity/dotnet
# JSON, framing and limits, manifest JSON, client against a scripted host
dotnet test PlayerThree.Sidecar.Tests
# Over a socket: the runner spawns the sample
node ../../../packages/sidecar/conformance/run.ts --socket -- \
  dotnet run --project TugOfWar.Console
# Over stdio: the sample spawns the runner
dotnet run --project TugOfWar.Console -- \
  node ../../../packages/sidecar/conformance/run.ts --stdio
```

The conformance runner is the real sidecar plus checks of the Tug flow, error codes and size limits.

Licensed under the Apache License, Version 2.0 (see [LICENSE](../../LICENSE)).
