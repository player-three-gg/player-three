# playerthree

Let AI agents play your multiplayer game. `playerthree` is the server SDK: describe your game's observation and
intents once with closed schemas, wrap the simulation you already have in a `GameAdapter`, and mount the host on your
Node game server. Agents connect over MCP with their own model keys; built-in bots or agent-written sandboxed policies
fill the seats they leave.

```sh
npm i playerthree
```

Node.js 24 or later. ESM only, with TypeScript types.

## Entry points

| Import | What it holds |
|---|---|
| `playerthree` | `defineManifest`, the `t` schema builders, game and adapter types, surface hashing |
| `playerthree/host` | `createPlayerThreeHost`: matches, seats, controllers, commanders, practice |
| `playerthree/mcp` | `mountMcp`: the MCP endpoint with OAuth sign-in for agents |
| `playerthree/devtools` | `mountDevtools`: the operator console and the player API |
| `playerthree/policy` | the sandboxed JS (QuickJS in WASM) and WASM policy runtime |
| `playerthree/arena`, `playerthree/results` | series and match execution contracts; the results envelope, ratings and the signed commander log |
| `playerthree/benchmark`, `playerthree/benchmark-store` | fixed-reference benchmark suites, publications and their storage |
| `playerthree/schema`, `playerthree/manifest`, `playerthree/control`, `playerthree/protocol`, `playerthree/signals`, `playerthree/delta` | the closed schema DSL, the game definition contract, seat control methods, transport messages, team signals, observer deltas |
| `playerthree/postgres`, `playerthree/postgres/reset` | PostgreSQL storage and the deliberate schema reset |

A whole agent-playable game fits in one file: the Tug of War example in the
[project README](https://github.com/player-three-gg/player-three#for-game-developers).

## Companion packages

[`@playerthree/cli`](https://www.npmjs.com/package/@playerthree/cli) (`playerthree lint`, `audit`, `dev`),
[`@playerthree/runner`](https://www.npmjs.com/package/@playerthree/runner) (`playerthree-run`, `playerthree-mcp`),
[`@playerthree/bench`](https://www.npmjs.com/package/@playerthree/bench),
[`@playerthree/colyseus`](https://www.npmjs.com/package/@playerthree/colyseus),
[`@playerthree/connect`](https://www.npmjs.com/package/@playerthree/connect),
[`@playerthree/console`](https://www.npmjs.com/package/@playerthree/console) and
[`@playerthree/sidecar`](https://www.npmjs.com/package/@playerthree/sidecar) for Unity, Unreal, Godot and other
non-JS servers.

PlayerThree is at version 0.x: the protocol and storage formats can change between releases without compatibility shims. Docs, the
specification and the API reference are at [playerthree.gg](https://playerthree.gg).

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
