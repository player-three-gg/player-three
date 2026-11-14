# Game engines

PlayerThree's host is a Node/TypeScript program. A game server written in Godot, Unity, Unreal, C++, C#, Go or
another language runs it next to the server as a separate local process: the **sidecar host**. The game server keeps
the simulation and the clock. The sidecar runs a normal `PlayerThreeHost` and serves MCP, OAuth, guards, seats,
mandates, presence, policies and sessions.

```text
game server ──stdio or Unix socket, NDJSON──▶ playerthree-sidecar ──MCP──▶ agents
  simulation, adapter, bots, clock             PlayerThreeHost
```

The two processes exchange newline-delimited JSON over the sidecar's stdin/stdout or an owner-only Unix socket,
never a network interface. The game server sends its manifest as plain JSON, answers the adapter and bot calls one
at a time, and advances the match tick by tick. The protocol is [SPEC §20.8](../../spec/SPEC.md#208-engine-reach);
the [sidecar host](../../packages/sidecar/README.md) page summarises it.

## Engine SDKs

Each SDK wraps the protocol for its engine and ships the same Tug of War sample: two teams, one `puller` role, a
rope from −10 to 10 and `pull` intents. An MCP agent takes the north seat and plays against the built-in bot on
south.

| SDK | Language | Status |
|---|---|---|
| [Godot](../../sdks/godot/README.md) | GDScript addon for Godot 4.5+ | Headless Godot 4.5 and 4.7.2 pass conformance on Linux and Windows, 4.7.2 on macOS. |
| [Unity and .NET](../../sdks/unity/README.md) | C# (netstandard2.1) core and a Unity package | The .NET core passes conformance on Linux, Windows (stdio and a named pipe) and macOS. |
| [Unreal and C++](../../sdks/unreal/README.md) | C++17 core and an Unreal plugin | The C++17 core passes conformance with g++, clang, AppleClang and MSVC. |

The [Engines CI workflow](https://github.com/player-three-gg/player-three/actions/workflows/engines.yml) runs every SDK's
tests and conformance on Linux for each push and pull request, and on Windows and macOS for pushes to `main`.

Another language needs no SDK: a server that reads and writes JSON lines on a child process's pipes can speak the
protocol directly.

The engine SDKs install from this repository; each SDK's page has the steps. The sidecar host runs on Node 24 or
later.

## Starting a match

Each SDK spawns the sidecar over stdio, sends `hello` with the manifest, creates a match with an agent on the north
seat and advances it from the engine's clock. This is the server side of each Tug of War sample:

```gdscript tab="GDScript" title="main.gd"
func _ready() -> void:
	var sidecar := PlayerThreeSidecar.new()
	sidecar.arguments = [
		"../../packages/sidecar/bin/playerthree-sidecar.ts",
		"--stdio",
	]
	add_child(sidecar)
	sidecar.connected.connect(func(_hash, mcp_url):
		var created := sidecar.create_match({
			"seed": 1,
			"controllers": {
				"north": {"puller": "agent"},
				"south": {"puller": "bot"},
			},
			"botLevel": {"south": "easy"},
		})
		var session: String = created["data"]["session"]
		var minted := sidecar.request("mintSeatToken", [session, "north", "puller"])
		var token: String = minted["data"]["token"]
		# An owner-only file; never log the token
		print(mcp_url, " token in ", _write_token(token))
	)
	sidecar.start(preload("tug_game.gd").new())
```

```csharp tab="C#" title="Program.cs"
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
var session = sidecar.CreateMatch(JsonValue.Parse(
    "{\"seed\":1,\"controllers\":{\"north\":{\"puller\":\"agent\"}}}"));
while (!sidecar.HasEnded(session))
{
    sidecar.Step(session, 1);
    sidecar.Pump(100);
}
```

```cpp tab="C++"
MyGame game;
playerthree::SidecarClient client(
    game,
    playerthree::SpawnHost(
        {"node", "<repo>/packages/sidecar/bin/playerthree-sidecar.ts", "--stdio"}));
// Sends the manifest and hooks, waits for ready
client.Hello();
std::string session = client.CreateMatch(
    {{"seed", 1}, {"controllers", {{"north", {{"puller", "agent"}}}}}});
// A 0600 file, never a log
playerthree::WriteOwnerOnlyFile(
    "seat-token", client.MintSeatToken(session, "north", "puller"));
// Your clock: advance, then serve host calls
for (;;) {
  client.Step(session, 1);
  client.Poll(100);
}
```

Each SDK's page has the manifest, the adapter and the rest of the sample.

## Conformance

[`packages/sidecar/conformance`](../../packages/sidecar/conformance) holds the Tug of War manifest, a recorded
transcript, a mock engine in plain Node and the conformance runner. The runner is the real sidecar plus checks. The
game server spawns it in place of the sidecar over stdio, or the runner spawns the server on a socket:

```sh
node packages/sidecar/conformance/run.ts --stdio
node packages/sidecar/conformance/run.ts --socket -- <server command…>
```

It seats an MCP agent, plays the match to its end, sends error-case calls and calls at the line-size limit, and
compares the exchange with the transcript. It prints each check and exits 0 on a pass.
