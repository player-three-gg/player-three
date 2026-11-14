# PlayerThree for game developers

**Players can hand a seat in your game to their own AI agent. They bring the model (BYOM) and pay for it; you pay nothing for inference. The agent sees only its seat's view and acts only through the intents you declare.**

The integration works like accessibility for agents: you describe a semantic **screen** and semantic **buttons**, so an AI never has to scrape pixels or drive your UI. The same description is useful to narration, voice and switch-access integrations for humans; PlayerThree does not ship those human interfaces. A seat can be player 2, a squadmate, an RTS commander or a rival, and your game does not depend on one model vendor.

This is not multiplayer-only. A **side** groups seats, an **owner** is the player handing over control, and a **perspective** is what a seat can see. Teams are one case; the code keeps `teams` / `team`, with one declared value allowed. Manifest `teams` are the sides a game declares; `createMatch({ teams?, alliances? })` seats a nonempty subset (default the host's `teams`, else all), optionally partitioned into alliances, and the game's `create({ seed, options?, teams, alliances? })` receives them. Use the same path for a co-op companion, a hand-off while away, a bot author for a single-player run, or a benchmark without an opposing side.

A **session** is the general term: it may end in an outcome or be persistent (MMO, idle world, colony). A **match** is the multiplayer case; a **team** is one kind of side, and an **opponent** is a competitive counterpart. A counterpart is optional. Existing APIs still use `createMatch`, `team` and phase `"match"` even for solo runs. Persistent adapters can return `running`; durable world storage/recovery and persistent episode management are **Proposed**, not implied by that outcome.

## The minimum developer path

1. **Describe buttons + screen.** Define typed intents, a server-fogged observation and the adapter over your simulation. The closed schema derives TypeScript types, JSON Schema, MCP tools and reference documentation. Keep the screen small and the buttons meaningful.
2. **Choose unplugged behavior.** The owner selects `mandate.whenAbsent`: `policy` keeps a deployed policy playing (or falls back to the built-in bot), `bot` pauses the policy and uses the fallback bot, `hold` does nothing. An agent assignment does not change just because its harness goes away. A recent/in-flight call or an active sequence makes the agent present.
3. **Add optional house rules.** Declare an optional `limits` object with optional fields; the game enforces those restrictions in `apply`. The owner's mandate combines those limits with the typed objective (`directive`), `autonomy` and unplugged behavior. Separate scopes decide which actions are permitted. Supervised policy deploys, rollbacks and publication await owner approval; per-intent approval is proposed, not implemented.
4. **Mount + connect kit.** Mount the MCP endpoint and use `@playerthree/connect` for harness setup, consent/status types, mandate presets and the kickoff prompt. Draw the connection and commander controls in your game's own UI. Players sign in with their own harness and credentials; you do not buy their inference.

`hold` does not pause time. A game that declares `control.pausable: { maxPauseSeconds? }` (only where one absent seat may stop everyone, e.g. solo or turn-based play) lets owners choose `whenAbsent: 'pause'`: the host stops stepping while that seat's agent is absent (`step()` refuses with `paused`; `match.paused()`, `SeatInfo.pause` and the seat status say who, why and since when) and resumes on the agent's next call or an owner change; after `maxPauseSeconds` the seat plays like `policy` until its agent returns. Other games reject `pause`. Sessions with no terminal outcome use `createMatch({ persistent: { checkpointTicks, checkpoints } })` (needs adapter `clone()`): `outcome()` stays `running`, and replay retention is a rolling checkpoint window (in memory only). Per-move supervision is Proposed. See the [genre matrix](../spec/SPEC.md#genre-matrix--integration-guidance-not-required-mode-presets) for RTS, turn-based, card, puzzle, roguelike, persistent/idle, squadmate and companion choices.

```ts
import { createPlayerThreeHost } from 'playerthree/host';
import { mountMcp } from 'playerthree/mcp';
import { harnessSetup } from '@playerthree/connect';

// definition contains your manifest, adapter factory and built-in bot factory.
const host = createPlayerThreeHost({ definition });
mountMcp(httpServer, host, { path: '/mcp' });

// Browser-side: render the returned setup information in your own UI.
const setup = harnessSetup('claude-code', {
  mcpUrl: 'https://game.example/mcp', serverName: 'my-game',
});
```

See the runnable [Tag example](../packages/playerthree/examples/tag), [MCP setup](MCP.md), and the normative [version 1 specification](../spec/SPEC.md). Colyseus users bind their room with `@playerthree/colyseus`; other games keep their own netcode.

### Where to run the host

| Integration | Host placement | Status |
|---|---|---|
| Multiplayer | Developer's game server alongside the authoritative simulation | **Implemented** |
| Desktop / console single-player | Local sidecar started by the game, using the engine-adapter contract | **Proposed** packaging; sidecar implemented |
| Browser-only single-player | Developer backend running game logic, or a small local helper process the tab connects to | **Proposed** integration topology; backend can reuse the server SDK |

**A browser tab cannot accept MCP connections itself.** Use an accepting backend/helper; the existing stdio bridge only forwards to a host, it does not host the game's simulation. Deterministic replay and headless practice are opt-in game capabilities, not requirements for live control.

For commander controls, `MANDATE_PRESETS` offers **Autonomous**, **Policy author** (no `act`) and **Advisor**
(`practice`, `policy`, `say`, supervised). Intersect preset scopes with supported modes before applying them;
these are UI shortcuts, not new protocol modes. `kickoffPrompt({ gameTitle, roles, mandate })` supplies the
owner-pasted first message: the briefing for every commanded role, the topics its role doc lists under READ BEFORE
PLAYING, then `playerthree-commander/SKILL.md` and the game's strategy skill; signing in alone does not
start a model turn. Render connection `active` as “Active now”, otherwise “Signed in”. Each consent independently
binds the explicitly selected named commander and compatible granted roles; matching client names never merge lanes.
Consent data (`ConsentCommander`) includes ID/name/kind/roles/isolation, safe self-reported metadata, scopes and mandate.
The core's `playerthree/control` export supplies browser-safe control types alongside the DOM-free connect kit.

Agent Command's reference UI groups these controls by plane: a preset derived from scopes/autonomy (**Custom**
when no preset matches), away fallback, house-rule toggles, stance, policy status, pending approval buttons and a
kickoff prompt for signed-in plane holders. Its consent page shows each plane's mode and its connection chips
distinguish active agents from saved sign-ins. These are game-owned screens, not widgets shipped by PlayerThree.

Live mandate edits, scope replacement and approval resolution are owner protocol operations, which the Colyseus binding carries. The owner scope operation
is `{ op: 'scopes', seq, role, scopes }` on `playerthree:scopes`, or `PlayerThreeMatch.setScopes(team, role, scopes)` in-process.
`SeatInfo.scopes` exposes live permissions for every agent credential, including per-match tokens; revoking `act`
cancels scheduled agent sequences. The game's authenticated profile API can also call `commanders.update` to
persist scopes and propagate them to the live seat. A non-profile seat can use the live operation without a roster.

For Claude Code, `harnessSetup('claude-code', { mcpUrl, serverName, channel: true })` (`SetupOptions.channel`)
generates the stdio `--channel` command and interactive development-channel launch instruction. This is an
explicit research-preview opt-in, not automatic wake on ordinary MCP sign-in. Hosted `claude-api` setup belongs
in token choices only, needs public HTTPS and a commander token, and uses tools including `game_skill`, not
channels or the Skills extension. See [MCP](MCP.md#claude-code-wake-channel--implemented-research-preview).

The SDK supplies `playerthree-commander`, `playerthree-inputs`, `playerthree-owner`, and (policy mode only)
`playerthree-policy-author`. Their mode-gated workflows and generated reference are hashed into `surfaceHash`;
games supply strategy skills, never names with the reserved `playerthree-` prefix.

Wiring your own lobby: `createMatch({ assignments, readySeconds?, lobby? })` seats explicitly selected named
commanders on exact seats, the trusted `commanders.reserve(owner, id, role, reservation)` shows an agent its reserved
seat and your pre-match summary before the match exists, and `PlayerThreeMatch.assign(assignment)` hands a seat over
mid-match. Agents see a lobby state until the match starts and mark themselves ready with `game_ready`. Games whose
seats each watch part of a larger state declare `observationScope`; teammates that need to ask each other for help
use typed team signals; and the commander match log gives signed, verifiable records to rate from. See
[commanders](DESIGN.md#commanders-persistent-rosters), [observation scope](DESIGN.md#observation-scope),
[team signals](DESIGN.md#team-signals-manifestsignals-controlsignals) and
[commander match log and ratings](DESIGN.md#commander-match-log-and-ratings) in the design notes.

## Choose only the layers you need

| Layer | Package / location | Purpose |
|---|---|---|
| Spec | [spec/SPEC.md](../spec/SPEC.md) | Engine/language-agnostic contract; labels implemented and proposed features |
| Core SDK | `playerthree` · `packages/playerthree` | Schemas, host, guards, policies, practice, replay, MCP/OAuth, DevTools, canonical results, commander match log and ratings, PostgreSQL storage |
| Connect kit | `@playerthree/connect` · `packages/connect` | DOM-free, browser-safe onboarding primitives; no Node built-ins |
| Player console | `@playerthree/console` · `packages/console` | Browser-safe client over the player API (own seats only) + optional drop-in panel |
| Runner + stdio bridge | `@playerthree/runner` · `packages/runner` | BYOM runner and surface-pinned bridge |
| Developer CLI | `@playerthree/cli` · `packages/cli` | `playerthree lint`, `audit`, `dev`, `db reset` |
| Benchmark | `@playerthree/bench` · `packages/bench` | Model and policy benchmarks on your game: a frozen series spec (scenarios with seeds, maps and match options, side permutations, shared budgets, held-out seeds), canonical `results.json` and CSV exports, Elo or TrueSkill standings, guardrails, and fixed-reference campaigns; compare results only across equal `comparisonHash` |
| Colyseus binding | `@playerthree/colyseus` · `packages/colyseus` | Integrate an existing Colyseus room |
| Engine sidecar | `@playerthree/sidecar` · `packages/sidecar` | Host for non-JS servers (Unity, Unreal, Godot, …) over stdio or a Unix socket, with the conformance runner |

## What makes it practical

| Feature | Why a game developer cares |
|---|---|
| **One schema → everything** | Types, JSON Schema, tool definitions and the generated reference skill share one source. Add strategy notes and example policies, not duplicate API docs. |
| **Three input tiers** | Intents for one decision, bounded tick-relative sequences for short plans, sandboxed policies for tick-rate play without continuous model calls. |
| **Player control** | Scopes govern permissions; mandates govern objectives, house rules, autonomy and absence. The game owns the authenticated owner UI. |
| **`playerthree lint`** | Checks docs, vocabulary, list bounds and observation size; estimates polling costs so you can design an affordable screen. |
| **`playerthree audit`** | Exercises the input/output boundary and produces a surface hash and Safety Card. See [CLI](CLI.md); an audit is not proof against a malicious game developer. |
| **PlayerThree DevTools** | Operator console: Overview, Sessions (all sides' traces, God / side / seat perspectives, isolated replay scrubbing, end/export), Agents (rotate/revoke), Policies (libraries, pool disable/unpublish), Bench (result directories), Safety and Game settings. Loopback-only without a credential locally; game admin `authorize` or `operatorToken` in production. See [DEVTOOLS](DEVTOOLS.md). |
| **Shared bot contract** | Built-in bots use the same typed intents, providing fallback play, practice opponents and examples. |
| **Replay when supported** | Record the seed, control changes and intents that reach game `apply`, including game-rule rejections, then re-simulate a deterministic adapter. Replay and headless practice are opt-in integration capabilities. |
| **Zero-LLM CI** | Run policies and built-in bots headlessly; scripted providers can exercise benchmarking without an API key. |
| **Any language for policies** | JavaScript in QuickJS-WASM, or core WASM from Rust/Zig/C/AssemblyScript through the [policy ABI](POLICY_ABI.md). |

The safety contract has three audiences: **the player** (no third-party text reaches their powerful harness), **the game** (validated, fogged, rate-limited actions) and **other players** (fair limits and a disclosed controller; your UI renders the badge).

## Operator console — Implemented

DevTools is the operator console, for the game's developers and operators only; player credentials never open it.
Locally it needs no credential but answers only direct loopback requests with a loopback `Host`, no proxy headers and
same-origin browser headers. In production mount it with `authorize(req)` backed by your admin auth, or a static
`operatorToken` (Bearer, HTTPS or direct loopback only, never in URLs).
Optional `GameAdapter.debugView(): unknown` supplies bounded unfogged JSON through `PlayerThreeMatch.debugView()`;
without it God view has no snapshot. Sessions switches God / side / last delivered seat observation, shows all sides'
traces, scrubs replays in an isolated adapter (optional `GameAdapter.clone()` enables bounded checkpoints; not durable
persistent-world storage), exports replays and ends sessions through `PlayerThreeMatch.end()` (`'draw'`, outcomes or
placements keyed by team or alliance; optional `GameAdapter.end(outcomes, ranks)` lets the game adopt them). A team is
out at its first final outcome while the others play on; the match is over when every match team is final, and
`onEnd((outcomes, ranks) => …)` fires then. Agents rotates commander tokens and, with `oauth`, revokes sign-in connections.
Policies lists every commander library and the pool (disable or unpublish entries), Bench reads the result
directories you pass as `benchResultsDir`, Safety shows the surface hash, modes, scopes and your Safety Card
(`safetyCard`), and Game settings shows match options read-only. See [DEVTOOLS](DEVTOOLS.md).

## Player console — Implemented

The console shows owner-private named commanders in the lobby and exact-seat activity in a match.
Mount the player API with the game's authenticated profile resolver. Human capabilities remain exact-seat;
trusted private team-root tokens must never be issued to public lobby participants.

**1. Mount the player API on the server.** The handler resolves `false` for paths it does not own.

```ts title="server.ts"
import { createPlayerApiHandler } from 'playerthree/devtools';

const player = createPlayerApiHandler(host, {
  owner: (req) => mySessionOwner(req),
});

// in your request listener
if (await player.handle(req, res)) return;
```

**2. Create the client.** `@playerthree/console` is browser-safe and uses no Node built-ins. `url` defaults to
`/playerthree/player`. `target` returns `{ commander, match, team, role }`, or `undefined` for the roster.

```ts title="client.ts"
import { createPlayerConsole, mountConsolePanel } from '@playerthree/console';

const client = createPlayerConsole({
  credential: () => profileCredential,
  target: () => selectedCommanderSeat,
  pricePerMTok: 3,
});
```

**3. Mount the panel.** `actions.resolveApproval` forwards approval decisions to your owner API.

```ts title="client.ts"
const panel = mountConsolePanel({
  console: client,
  mount: hud,
  toggleKey: 'Backslash',
  currency: '$',
  actions: {
    resolveApproval: (target, id, approve) =>
      myOwnerApi.resolveApproval(target, id, approve),
  },
});
```

- **Headless:** `client.subscribe((snapshot) => …)` gives each named commander ID/name/compatible-role set or exact
  live seat. Multiple commanders supporting the same role remain distinct. Lobby role/team are null; controller
  is the commander's `agent`/`policy` execution kind, not a human/bot/opponent preference. Live seats include
  readiness/probe/consent state, presence, pause state, mandate, scopes, limits, role-labelled pending `approvals`, policy
  stats/errors/log tail, recent intents with closed ack codes and per-code rejection counts, practice runs, and
  the last observation's size with a token estimate.
  Tokens are estimated as `ceil(bytes / 4)` (`bytesPerToken` to change it; an estimate, not a tokenizer); with
  `pricePerMTok` the snapshot also carries the cost of reading that observation once. Draw your own UI from it, or:
- **Panel:** framework-free DOM, hidden until the toggle key (default `\`, never while typing; `null` to wire your own
  button) or `panel.toggle()`. Theme it with `--playerthree-console-*` CSS variables (colors, fonts, radius, width, inset,
  z-index); its selectors have zero specificity so your own rules win. It polls only while open. Approvals stay
  read-only unless you pass `actions.resolveApproval`.

Profile requests without a target remain roster-only; live requests require the exact currently owned
`?commander=<id>&match=<id>&team=<team>&role=<role>` lease. Human capabilities return only their exact seat.
Agent, spectator and observer capabilities cannot open this API. No automatic first-side routing or
opponent/omniscient channel exists; cross-side or broader-view owners cannot coach through the console.
Approval callbacks receive `{kind:'commander',commander,seat?:{match,team,role}}` or
`{kind:'seat',match,team,role}`, never a role-keyed commander alias. Policy, practice, settings and chat use the
authenticated profile's named commander API, separately from live seat control.

## Operator sections — Proposed parts

The Policies, Bench, Safety and Game settings sections are implemented (above). Starting BYOM bench runs from the console and editing match options or default mandates are **Proposed**: the console points to the CLI and your game's own configuration instead.

## Reference games

- **Agent Command** ([agentcommand.gg](https://agentcommand.gg); sibling repository `agent-command`) is the implemented real-time multiplayer reference: four declared sides played as two-side duels or four-army free-for-alls, commander roles, team signals, owner controls and a benchmark config.

Single-player integrations use the same adapter contract with one declared side; a benchmark series may seat a single side (scored by outcome and the game's report, with no rating). Capability-gated host pausing (`control.pausable`) and in-memory persistent sessions are Implemented; durable persistent lifecycle remains **Proposed**. Persistent benchmarking uses time-boxed episodes and reports; existing finite tick budgets do not imply world recovery or indefinite replay retention.
