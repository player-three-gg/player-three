# PlayerThree for Godot

A pure-GDScript Godot 4 addon that seats MCP agents in your Godot dedicated server. It spawns the
PlayerThree **sidecar host** next to the server and speaks the SPEC §20.8 (a) sidecar protocol
(protocol 1) with it. The host serves MCP, OAuth, guards, mandates and sessions. Your game keeps the
simulation and the clock.

```text
Godot server ──stdin/stdout NDJSON──▶ playerthree-sidecar (Node) ──MCP──▶ agents
  your sim, adapter, bots                PlayerThreeHost: guards, seats, policies
```

Requirements: Godot 4.5 or later, and Node 24 or later to run the sidecar host from a PlayerThree checkout
(`packages/sidecar`).

## Install

1. Copy `addons/playerthree/` into your project's `addons/`. The addon needs Godot **4.5 or later**
   (abstract classes); CI tests it on 4.5 and 4.7.2.
2. Optionally enable the plugin (*Project → Project Settings → Plugins*). It registers the
   `playerthree/sidecar/program` and `playerthree/sidecar/arguments` project settings, which
   `PlayerThreeSidecar` uses when its own `program` and `arguments` are empty.
3. Point the node at the host:
   `node <checkout>/packages/sidecar/bin/playerthree-sidecar.ts --stdio [--port 8787]`.

## The 30-second sample

The Tug of War sample (`samples/tug_of_war/`) is the README's Node example, written natively in GDScript.
It has two teams, one `puller` role, a rope at −10…10, and `pull` intents. Run it headless as a dedicated
server from this directory:

```sh
# Once: builds the class cache.
godot --headless --path . --import
# Spawns ../../packages/sidecar and runs one match.
godot --headless --path .
```

The server creates a match with an MCP agent seat on north and the built-in `easy` bot on south. It
writes the north seat token to `user://tug-seat-token`, a file only your OS user can read (mode 0600,
removed when the host connection closes; a killed server leaves the already-revoked token behind). It logs that file's path and the MCP URL, never the token itself, so
you can point a harness at it. It runs the engine clock
at 10 ticks/s and logs the rope once per game second. Until an agent plays north, the absent seat falls
back to the built-in bot, which pulls as hard as south's, so the rope stays near 0. When the match ends, the server disposes it and
exits with the host's exit code. Sample options go after `--`: `--node=/path/to/node` and
`--sidecar=/path/to/playerthree-sidecar.ts`. Host options go after a second `--`, for example
`godot --headless --path . -- -- --port 0`.

The whole game is three small scripts.

**1. Describe the game.** `tug_game.gd` builds the manifest with the addon's schema nodes. The
result is the same plain JSON as the Node SDK's manifest.

```gdscript title="tug_game.gd"
static func build_manifest() -> PlayerThreeManifest:
	var S := PlayerThreeSchema
	var m := PlayerThreeManifest.new()
	m.id = "tug"
	m.version = "1.0.0"
	m.title = "Tug of War"
	m.tick_rate = 10
	m.doc = "Pull the rope to your side (±10) to win."
	m.teams = S.enumeration(["north", "south"])
	m.roles = S.enumeration(["puller"])
	m.role_doc("puller", "Pulls the rope.")
	m.intent("pull", ["puller"], {"strength": S.integer(1, 3)}, "Pull this tick.")
	m.observation = S.obj({
		"tick": S.integer(0, 100000),
		"rope": S.integer(-10, 10, "+ is north"),
	})
	# … view, report, event, directive, errors, opponents, control
	return m
```

**2. Hand the host the manifest and the factories.** The same script extends `PlayerThreeGame`;
the host calls `create_match` for each new match and `create_bot` for each built-in bot seat.

```gdscript title="tug_game.gd"
extends PlayerThreeGame

const TugMatch := preload("tug_match.gd")
const TugBot := preload("tug_bot.gd")

func manifest() -> Dictionary:
	return build_manifest().to_dict()

func create_match(_options: Dictionary) -> PlayerThreeAdapter:
	return TugMatch.new()

func create_bot(_seat: Dictionary, _opponent: String, _options: Variant) -> PlayerThreeBot:
	return TugBot.new()
```

**3. Run one match.** `tug_match.gd` is the SPEC §10 adapter: it holds the rope, advances the
tick and decides the outcome.

```gdscript title="tug_match.gd"
extends PlayerThreeAdapter

var rope := 0

func step() -> void:
	tick += 1

func outcome(team: String) -> String:
	if absi(rope) < 10:
		return "running"
	return "win" if (rope > 0) == (team == "north") else "loss"
```

**4. Answer agents.** `observe` returns what a seat sees, and `apply` moves the rope for each
`pull` intent the host has already validated.

```gdscript title="tug_match.gd"
func observe(_seat: Dictionary, _since_tick: int, _detail: Array) -> Variant:
	return {"tick": tick, "rope": rope}

func apply(seat: Dictionary, intent: Dictionary, _context: Variant) -> Dictionary:
	var strength: int = intent["strength"]
	rope = clampi(rope + (strength if seat["team"] == "north" else -strength), -10, 10)
	return {"ok": true}

# … view, report, events, set_seat_info
```

**5. Start the server.** `main.gd` spawns the sidecar host, creates the match once the host is
ready, and writes the north seat token to an owner-only file. The token never goes to the log.

```gdscript title="main.gd"
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
		print(mcp_url, " token in ", _write_token(token))
	)
	sidecar.start(preload("tug_game.gd").new())
```

## API

| Piece | What it is |
|---|---|
| `PlayerThreeSidecar` (Node) | Spawns the host with `OS.execute_with_pipe`, sends `hello`, and answers every host `call` on the main thread. `start(game)`, `request(method, args)` (host operations: `createMatch`, `mintSeatToken`, `seats`, `cards`, `readiness`, `setController`, `setMandate`, `end`, `forfeit`, `dispose`), `advance(session, n)`, `create_match(spec)`, `run_clock`/`stop_clock`, `adapter(session)`, `close()`. Signals: `connected`, `failed`, `session_created`, `session_disposed`, `advanced`, `pushed`, `match_ended`, `closed`. |
| `PlayerThreeGame` | Abstract definition: `manifest()`, `hooks()`, `create_match(options)`, `create_bot(seat, opponent, options)`. |
| `PlayerThreeAdapter` | Abstract match: `tick` plus `step`, `outcome`, `view`, `observe`, `apply`, `report`, `events`, `set_seat_info`. Optional hooks are plain methods declared in `hooks()`: `match_data`, `debug_view`, `observer_view`, `end`, `forfeit`, `rank`, `clone`, `signal_limits`. An optional `dispose()` runs when the host releases the match. |
| `PlayerThreeBot` | Abstract built-in commander: `think(observation) -> Array`, optional `init(match_data)`. The host forwards bot seats and practice opponents to it. |
| `PlayerThreeManifest`, `PlayerThreeSchema` | Build the manifest as plain JSON. The schema nodes are the Node SDK's `t` nodes; `integer`/`number`/`boolean`/`enumeration`/`text` stand in for `t.int`/`num`/`bool`/`enum`/`str`, whose names GDScript reserves. `check()` lists missing or mistyped members; the host runs the full `defineManifest` checks at `hello`. |
| `PlayerThreeFraming` | The §20.8 framing: NDJSON lines of at most 1048576 bytes (excluding `\n`), with UTF-8 and JSON validation and strict JSON encoding (no NaN, infinity, objects or non-string keys). |

**Clock and threading.** The engine owns the clock. With `advance_in_physics` (the default), every
session started through `create_match` advances from `_physics_process` at the manifest's `tickRate`. The
node catches up at most one second of ticks per frame; `paused` and `over` replies are honoured.
`advance` and `request` block the main thread until the host replies, and answer the host's calls
meanwhile, so each tick runs synchronously as SPEC §10 requires. Calls that arrive between ticks (an
agent's `observe`, say) are answered from `_process`. Signals are emitted deferred, so their handlers can
call `request`. Inside an adapter call, `request` returns `busy`.

**Why stdio, not a socket.** Godot 4 has no Unix-domain-socket or named-pipe client, and loopback TCP would
break §20.8's "never on a network interface". So the node always spawns the host and uses its
stdin/stdout. The pipes stay blocking: a non-blocking `execute_with_pipe` pipe silently drops the
unwritten tail of a large write. One thread reads the host's stdout, another forwards its stderr log
lines to Godot's stderr, and writes block until the host has read them.

**Values.** Everything crossing the wire is plain JSON. A seat is `{"team", "role"}`, an intent is a
Dictionary with `kind`, and integral numbers arrive as `int`. The node answers protocol violations,
unreadable lines and oversized lines with the §20.8 fatal `error` (`bad_frame`, `too_large`) and closes.
When a match returns a non-JSON value, a `null` where a value is required, or a `step` that does not
advance `tick`, the call fails with `engine_error`.

## Tests and conformance

```sh
# Framing, schema/manifest JSON, dispatch, pipes
godot --headless --path . --script res://tests/run_tests.gd
# The sample against the conformance runner
godot --headless --path . -- --conformance
```

`--conformance` spawns `packages/sidecar/conformance/run.ts --stdio` in place of the sidecar. The runner
is the real host plus the transcript, error-case and size-limit checks, and the sample exits with the
runner's verdict.

## Supported platforms

- Supported: Linux x86_64, Windows x86_64 and macOS (headless Godot 4.5 and 4.7.2; macOS on 4.7.2 only). The
  match adapter, every optional hook, built-in bots, every protocol-1 host operation, engine-driven ticking,
  fatal-error handling and the 1 MiB frame limit.
- CI: [Engines](https://github.com/player-three-gg/player-three/actions/workflows/engines.yml) imports the project, runs
  the tests and the stdio conformance on ubuntu for every push and pull request, and on Windows and macOS for
  pushes to `main`.
- Not supported: connecting to a host started separately over its `--socket` (Godot has no client for it);
  Web exports (no processes); the lobby-profile operations `reserve`, `release` and `capabilities`, which
  protocol 1 does not define.

Licensed under the Apache License, Version 2.0, like the rest of PlayerThree.
