# @playerthree/sidecar

The PlayerThree host for game servers that are not written in JavaScript: Unity, Unreal, Godot, C++, C#, Go.
Your dedicated server keeps the simulation and the clock. The sidecar is a separate local process that runs a normal
`PlayerThreeHost` and serves MCP, OAuth, guards, scopes, mandates, presence, policies and sessions. The two talk
newline-delimited JSON over stdio or a local socket, never over a network interface ([SPEC §20.8 (a)](../../spec/SPEC.md#208-engine-reach)).

Engine SDKs that speak this protocol live in [`sdks/`](../../sdks).

## Run it

Install it next to your dedicated server (Node ≥ 24):

```sh
npm i @playerthree/sidecar
# Your server spawns the sidecar and talks on the child's stdin/stdout:
node_modules/.bin/playerthree-sidecar --stdio --port 8787
# …or the sidecar listens on a Unix socket (created 0600):
node_modules/.bin/playerthree-sidecar --socket /run/mygame/p3.sock
```

From a checkout, run `pnpm install`, then `node packages/sidecar/bin/playerthree-sidecar.ts` in place of
`node_modules/.bin/playerthree-sidecar`.

Options: `--port` (MCP port, default 8787, 0 = any; the URL is sent in `ready`), `--listen` (default 127.0.0.1),
`--call-timeout` (ms per adapter call, default 5000), `--hello-timeout` (default 10000), `--data-dir` (persist
commanders and the commander log), `--devtools` (operator console at `/playerthree/devtools`). Logs go to stderr.
The process exits when the engine disconnects: 0 after an orderly close, 1 after a protocol error, timeout or failed
handshake.

## The protocol in 30 seconds

One JSON object per line, at most 1048576 UTF-8 bytes before the `"\n"`. Unknown members are ignored.

```text
engine → {"op":"hello","protocol":1,"manifest":{…},"hooks":[]}
host   → {"op":"ready","surfaceHash":"…","mcp":"http://127.0.0.1:8787/mcp"}
engine → {"op":"host","id":1,"method":"createMatch",
          "args":[{"seed":1,"controllers":{"north":{"puller":"agent"}}}]}
host   → {"op":"call","id":1,"session":"s1","method":"create",
          "args":[{"seed":1,"teams":["north","south"]}]}
engine → {"op":"result","id":1,"ok":true,"data":{"tick":0}}
host   → {"op":"result","id":1,"ok":true,"data":{"session":"s1","tick":0}}
engine → {"op":"host","id":2,"method":"mintSeatToken",
          "args":["s1","north","puller"]}
host   → {"op":"result","id":2,"ok":true,"data":{"token":"…"}}
engine → {"op":"advance","id":3,"session":"s1","n":1}
host   → {"op":"call","id":7,"session":"s1","method":"step","args":[]}
engine → {"op":"result","id":7,"ok":true,"data":{"tick":1}}
host   → {"op":"result","id":3,"ok":true,"data":{"tick":1}}
host   → {"op":"push","session":"s1","kind":"ended",
          "data":{"outcomes":{…},"ranks":{…}}}
```

The `manifest` is the plain JSON manifest. During `advance` the host also sends `think`, `apply`
and `observe` calls besides `step`.

- **Host → engine `call`s** are the adapter (§10) and the game's built-in bots, one at a time and synchronous: the
  host blocks until the engine answers. The engine must answer every call, including while its own request is
  outstanding. Methods: `create`, `step`, `outcome`, `view`, `observe`, `apply`, `report`, `events`, `setSeatInfo`;
  the hooks the engine declared in `hello.hooks` (`matchData`, `debugView`, `observerView`, `end`, `forfeit`, `rank`,
  `clone`, `signalLimits`); bots `createBot`, `init`, `think`; and `dispose` when the host lets a session go. Seats
  are `{"team","role"}`. Results are `{"ok":true,"data"}` or `{"ok":false,"code"}` (`unknown_method`,
  `unknown_session`, `invalid`, `engine_error`); every output is schema-guarded by the host as in-process.
- **Engine → host requests**, one at a time, each answered by a `result`: `advance` (run up to `n` host ticks,
  data `{tick}`) and `host` methods `createMatch`, `mintSeatToken`, `seats`, `cards`, `readiness`, `setController`,
  `setMandate`, `end`, `forfeit`, `dispose`.
- **Pushes**: `seats` (after any seat status change) and `ended`.
- **Fatal** `{"op":"error","code"}` then close: `too_large`, `bad_frame`, `timeout` (a call missed its deadline),
  `invalid_manifest`, `protocol`. When the connection closes the host disposes every session (seat tokens revoked,
  MCP seats dropped); the engine should move agent and policy seats to its own bots.

The full message table is in the spec.

## Conformance

[`conformance/`](conformance) holds the Tug of War sample (the README game) as an engine-neutral fixture:

- `tug.manifest.json`: the manifest every engine sample sends verbatim;
- `tug.transcript.jsonl`: the recorded, normalized exchange of a passing run;
- `mock-engine.mjs`: the engine side in plain Node (no PlayerThree imports);
- `run.ts`: the runner. It is the real sidecar plus checks: it holds each engine request so the order of engine
  ticks and agent calls is fixed, seats an MCP agent on north that observes and pulls on the first three ticks, plays on until the south bot wins, sends
  error-case calls (unknown method and session) and a call of exactly 1048576 bytes, finally sends a 1048577-byte
  line (the engine must close), and compares the transcript.

The engine spawns the runner in place of the sidecar (stdio):

```sh
node packages/sidecar/conformance/mock-engine.mjs -- \
  node packages/sidecar/conformance/run.ts --stdio
```

The runner spawns the engine, which connects to `$PLAYERTHREE_SIDECAR_SOCKET`:

```sh
node packages/sidecar/conformance/run.ts --socket -- \
  node packages/sidecar/conformance/mock-engine.mjs
```

The published package ships the same runner, compiled, with its fixtures in `dist/conformance/`, so an engine can
check itself against an installed sidecar:

```sh
node node_modules/@playerthree/sidecar/dist/conformance/run.js --socket -- \
  <your engine command…>
```

The sample flow an engine runs: `hello` with `tug.manifest.json` and no hooks; `createMatch`
`{"seed":1,"controllers":{"north":{"puller":"agent"},"south":{"puller":"bot"}},"botLevel":{"south":"easy"}}`;
`mintSeatToken` for north/puller (hand the token to its owner in an owner-only file, never in a log); `advance` one tick every 100 ms until the `ended`
push; `dispose`; close. The Tug adapter and its bot (always pull 1) are the README's.

`--record <file>` writes the normalized transcript instead of comparing; `--timeout <s>` (default 60).

## Supported platforms

Supported: stdio and Unix-domain sockets (Linux, macOS), plain-JSON manifests validated like in-process ones, every
core adapter call plus the optional hooks above, built-in bots, engine-owned clock, the seat and lifecycle host
operations above, pushes, size limit, per-call timeout, disconnect cleanup, MCP and DevTools.

Limits: Windows named pipes are accepted (`--socket \\.\pipe\<name>`) and CI runs the .NET and C++ conformance over
one, but this build cannot restrict a pipe to the server's OS user; use stdio on Windows. The lobby operations `reserve`, `release` and
`capabilities` (§20.4, §20.6) and game metrics recorders are not part of protocol 1. Practice, policies and replays
run on host-created engine sessions, so the engine must support several sessions at once to offer them.

## License

Apache-2.0, see [LICENSE](../../LICENSE).
