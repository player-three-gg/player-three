# PlayerThree design

> Players can hand a seat in your game to their own AI agent. They bring the model and pay for it; you pay nothing for inference. The agent sees only its seat's view and acts only through the intents you declare.

The [version 1 specification](../spec/SPEC.md) is normative. This document explains the design and trade-offs, not a separate protocol. Features marked **proposed** are not shipped.

PlayerThree describes a semantic screen (observation) and semantic buttons (intents): the accessibility problem extended to agents. The same description can support narration, voice and switch-access integrations. A game developer supplies the world and typed contract; players bring their own model/harness to a seat such as a squadmate, RTS commander or card-game partner. Agent Command is the multiplayer reference game (see §6); the contract also supports single-side integrations.

The organizing concepts are **owner**, **side** and **perspective**. The owner hands over the controller; a side groups seats; a perspective determines what one side or seat sees. A team is only one kind of side. The current code and wire names remain `teams` / `team`, and a single `teams` value is supported: co-op companions, handing off while away, authoring a bot for a single-player run and benchmarks with no opponent are all valid uses.

| General term | Meaning | Multiplayer case / existing code |
|---|---|---|
| **Session** | A running world or run, ending in an outcome or persistent without one. | **Match**; code still uses `PlayerThreeMatch`, `createMatch`, `matchOptions` and phase `"match"` for all game types. |
| **Side** | A grouping of seats; one is enough. Manifest `teams` declare the sides; a match seats a nonempty subset, optionally partitioned into alliances. | **Team**; code retains `teams` / `team`. |
| **Counterpart** | An optional cooperating or competing participant. | **Opponent** in competitive games; `opponents` remains the built-in bot-tier field. |

A session is not an MCP transport session, OAuth connection or persistent commander identity. General terminology does not change version 1 wire names.

### Ending and persistent sessions

An ending session has a win/loss/draw or another game objective expressed through the existing outcomes and report. A persistent session (MMO, idle world, colony) has no terminal outcome: `createMatch({ persistent: { checkpointTicks, checkpoints } })` keeps `outcome()` at `running` (whatever the adapter says), refuses `end()` and never counts a commander result; `dispose()` closes it.

A named commander plays one team per match: the host refuses its second team at reservation, `createMatch` and `assign`, so no agent ever sees or acts for two sides. An owner's *different* commanders may oppose each other (isolated sessions), but the match is then the owner's own practice: `PlayerThreeMatch.sameOwnerOpposed` turns on for good once one owner plays seats on two hostile teams; such a match records no pool win/loss/draw, its commander-log entries carry `selfPlay` and never count in commander records, and its session record is marked, so no rating or ranking can count self-play.

Outcomes are per match team. The host keeps the first final outcome the game reports for a team; that team is out (intents `game_over`, bots/policies stop, waits return) while the others play on, and the match is over once every match team is final. Ranks then follow optional `GameAdapter.rank(team)` (competition ranking over alliances and lone teams; allies share), else outcome order win > draw > loss. `PlayerThreeMatch.end()` takes `'draw'`, outcomes or placements keyed by team or alliance, covering every match team; `onEnd((outcomes, ranks) => …)` and optional `GameAdapter.end(outcomes, ranks)` receive both. `PlayerThreeMatch.forfeit(team, { abandoned? })` concedes one team mid-match (leave, kick, unrecovered absence) without ending it for the others: a replay entry `[tick, team, firstRole, 'forfeit']` re-applied through optional `GameAdapter.forfeit(team)`, after which the game reports the team's final outcome (`abandoned` only marks the commander-log disposition). Replays and history records carry `teams`, `alliances` and `ranks`; records and replays stored before per-match team subsets are not readable (reset with `DELETE FROM playerthree_sessions;` on PostgreSQL or delete the JSON history directory).

Persistent replay/scrub uses checkpoints (adapter `clone()`, required) instead of an ever-growing replay from tick zero: the host clones the game every `checkpointTicks`, keeps the newest `checkpoints` clones and drops older replay entries, so scrubbing reaches at least the last `(checkpoints − 1) × checkpointTicks` ticks (`replay().window`, `match.checkpoint(tick)`). This window is in memory only; durable checkpoint storage, restart recovery and unbounded history are **Proposed**. Benchmark persistent worlds through time-boxed episodes and game reports, without inventing wins/losses for a world still `running`.

### Pause is different from hold

A game that declares `control.pausable` (optionally `{ maxPauseSeconds }`) lets owners choose `whenAbsent: 'pause'`; other games reject it. While any agent-controlled seat with that mandate has no present agent, the host stops stepping (a realtime clock stands still; `step()` refuses with `paused`), records `pause`/`resume` replay entries and exposes who/why/since in `SeatInfo.pause`, `match.paused()` and the seat status. The agent's next call resumes it, so does an owner changing the seat; past `maxPauseSeconds` the seat plays like `policy` until its agent returns. Declare it only where one absent seat may stop everyone (solo play, a turn-based seat that must move): never for a shared world, so one companion going away cannot freeze an MMO. Agent Command (real-time PvP) does not declare it.

`hold` suppresses that seat's fallback actions but keeps the simulation clock running. A turn-based adapter may wait for an accepted action before consuming a move; that is not host-level pause. Pausing could later support per-move supervision; current supervised autonomy gates artifacts, not individual moves.

## 1. Lessons from StarSkirmish

[StarSkirmish Bench](https://starskirmish.com/bench/v0-2) gave LLMs one hour to write a StarCraft bot with tools to compile,
play practice games and read summaries/logs. Findings that shape PlayerThree:

- LLMs are far stronger as **bot authors** than as real-time players → first-class **policies** (agent-written code, sandboxed, tick rate).
- The best predictor of strength was **practice against strong opponents early** → first-class **practice** (headless, fast-forward, tiered built-in opponents, structured after-action reports + the policy's own logs).
- Agents started from demo bots' source → games ship **skills** with example policies.
- Keeping the artifact working matters → policy **versions**, a dry-run probe on deploy, and rollback.

## 2. Control plane (game-agnostic, mode-extensible)

All bindings expose the same `SeatControl` operations (`packages/playerthree/src/control.ts`). Games opt into **modes** (`manifest.control`):

| Mode | What | Rate | For |
|---|---|---|---|
| `intents` (always) | Typed intents, incl. game macros | LLM pace | commanders, turn-based |
| `sequence` | Bounded tick-relative plans, optionally cancelled by visible events | scheduled ticks | build orders and short coordinated plans |
| `policy` | Agent-written code (`js` in QuickJS-WASM, or a core `wasm` module from any language) | tick rate | allies at runtime, bots |
| `stream` | Observation push every N ticks, intents per tick | tick rate | fast/cheap/realtime models |
| `practice` | Headless sparring vs built-in opponents | fast-forward | the write → test → revise loop |
| `pool` | Publish a policy; it can be drafted into other matches | offline | ladders, agents fighting each other, humans fighting other people's bots |
| `chat` | Owner ↔ own-agent messages (`tell` / `game_say`), optional typed ping | human pace | "Sky, cover the asteroid drop", agents reporting back |
| `signals` | Typed teammate requests (`signal` / `signal_update` intents, `signals` in observations and views) | any pace | "Depths → Surface: troops to this Shaft", a bot answering a human |
| `pausable` | Owners may choose `whenAbsent: 'pause'`: the whole session stands still while that seat's agent is absent (see above) | until the agent returns or `maxPauseSeconds` | solo play, a turn-based seat that must move |

New modes are added as new optional keys — never by changing existing ones. Agents discover modes from the briefing's generated `modes` topic.

### Controllers
`human` | `agent` (live LLM; may also run its deployed policy) | `policy` (published policy, no LLM) | `bot` (developer's built-in) | `none`.

### Permissions, mandate and presence

These answer different questions and must not collapse into a single “AI mode”:

- **Scopes** say what a seat's agent may do: `act` (including sequences and stream), `policy`, `practice`, `publish`, `say`. Reads remain available. Owners configure persistent commander scopes or live seat scopes; OAuth grants roles, not extra permissions. Every agent credential, including per-match tokens, follows the live seat's scopes. Unsupported modes fail `mode_unavailable`; supported but ungranted operations fail `out_of_scope`.
- **Mandate** says what the owner wants: `{ autonomy, directive, limits?, whenAbsent }`. The game declares the typed objective and optional house rules; it enforces limits in `apply`. Autonomous agents act without asking within their scopes and limits. Supervised deploys, rollbacks and publication create one replaceable pending approval per seat, resolved by the owner; status and waits carry the outcome. Per-intent approval is **proposed**.
- **Presence** says whether the assigned agent is active now: a call within 30 seconds, any in-flight call, or an active sequence. `SeatInfo.agentActive` and sign-in `ConnectionInfo.active` are liveness indicators, not controller assignment. “Signed in” means a connection exists; “active now” means recent activity.
- **Absence** follows `mandate.whenAbsent`: `policy` runs the deployed policy or fallback bot; `bot` pauses policy and runs the fallback bot; `hold` pauses both; `pause` (games declaring `control.pausable`) stops the whole session's clock until the agent returns. A tick chooses presence before policy/bot evaluation so resuming activity has deterministic effects.

The agent's briefing carries scopes and mandate. Instructions tell it to follow the mandate, deploy a working policy quickly for each commanded role where permitted, and keep monitoring while the match is live. The DOM-free `@playerthree/connect` presets and kickoff prompt help the game's UI explain this without redefining the protocol.

The public settings type is `CommanderSettings = { botLevel, scopes, mandate }`; `CommanderSettingsPatch` accepts a partial mandate. Live updates use `match.setMandate(team, role, mandate)` and `adapter.setSeatInfo(seat, { controller, mandate })`. Owner transport operations include `playerthree:mandate`, `playerthree:scopes` and `playerthree:resolveApproval`. `{ op: 'scopes', seq, role, scopes }` / `PlayerThreeMatch.setScopes(team, role, scopes)` replaces live scopes, exposed in `SeatInfo.scopes`; revoking `act` cancels scheduled agent sequences. Agents read the house-rule schema from the generated `schema/limits` briefing topic (the `mandate` topic explains it).

Supervised results add `{ ok: false, approval: { id, kind, version } }` to deploy/rollback/publication. Both `ApprovalRequest` and `Approval` require `version`: deploy pins the proposed next version (stale proposals fail resolution), rollback/publish expose their target. Approval kinds are `policyDeploy`, `policyRollback`, `publish`; states are `pending`, `approved`, `rejected`, `failed`. Resolve with `commanders.resolveApproval(owner, commanderId, id, approve)` or `match.resolveApproval(team, role, id, approve)`. `policyStatus()` is current stats (or `{ version: null }`) with optional approval, or `null` when neither exists; it is not a library-version listing. `wait` wakes with `wake: 'approval'`. Closed approval errors are `approval_not_found`, `approval_pending`, `approval_failed`; exact binding shapes are in [MCP](MCP.md).

### Input tiers

An **intent** is one immediate semantic button press. A **sequence** is a bounded plan of `{ in, intents }` steps measured in ticks from submission; the host validates the entire plan before scheduling anything. One sequence per seat is active, a replacement supersedes it, empty steps cancel, and `cancelOn` responds only to events visible to that seat. Due steps pass through the agent gate before the simulation step and enter replay like other intents. There is no embedded branching language. A **policy** is sandboxed code for recurring tick-rate decisions. These tiers let the model choose how often it needs to think without making every simulation tick an inference bill.

### Observation scope

A seat that focuses on one part of a larger state (one plane of several, one squad of a team) need not parse all of it
on every call. A game declares `observationScope: { sections, defaults }` and renders each observation with a *detail*:
the sections shown in full (`GameAdapter.observe(seat, sinceTick, detail)`), the others present as the game's compact
summaries. The detail is the role's `defaults` united with what the consumer asks for: agents per call
(`game_observe {detail}`, stream subscriptions), policies once in the artifact (the `detail` global or the
`playerthree.detail` custom section, [Policy ABI](POLICY_ABI.md#observation-detail)); built-in bots always get every
section. Detail never widens fog ([SPEC §3](../spec/SPEC.md#3-game-description--implemented)).

### Commanders: persistent rosters
Per-match seat tokens make agents hard to set up (a fresh token mid-game, every game). So a game can give each player
a **roster** of persistent, independently named **commanders** (`host.commanders`,
`packages/playerthree/src/host/commanders.ts`). PlayerThree owns how agents attach and persist; the game owns identity
and UX.

- **Owner**: an opaque id the game provides (`OWNER_RE`; its account/profile id). PlayerThree never authenticates
  owners and never shows the id to agents or opponents; the game authenticates its players and calls the registry.
- **Commander**: an independently named persistent identity (`id`, `name`, `kind:"agent"|"policy"`, compatible
  `roles`, isolation declaration and optional private self-reported metadata), with a rotatable token, scopes,
  mandate, fallback bot level and isolated policy library. Win/loss/draw records are not stored on it: they come from
  the commander match log (`CommanderStatus.record`, [SPEC §20.10.1](../spec/SPEC.md#20101-commander-match-log--implemented)). Multiple identities may support the same role.
- **Lobby**: a commander lane is in the lobby between matches and while its match is held before the first tick
  ([SPEC §4 *Lobby phase*](../spec/SPEC.md#lobby-phase--implemented)). `game_briefing` has `phase: "lobby"` (no team
  while nothing seats it); `game_observe` and `game_wait` return the lobby state `{phase: "lobby", seat, match?,
  you: {ready}, startsWhen, instruction}`; `game_ready` marks the agent ready for its pre-match seat; `game_act` /
  `game_sequence` answer `not_in_match` without a seat and `paused` in a held match. `game_skill`, `practice_run`,
  `policy_deploy` / `policy_status` / `policy_rollback` (on the library), `pool_publish` and `game_say` work.
  `game_wait` blocks in wall-clock time and returns early on a new or changed seat, an approval change or an owner
  message; when the match starts it returns the match entry with the seat's first observation. A game lobby reserves
  a lane for its next match with the trusted `commanders.reserve(owner, id, role, { team, match?, start } | null)`
  (`match` is the guarded manifest `lobby` summary, as `createMatch({ lobby })` for a held match; `start.kind` is
  `host`, `ready` or `countdown`). The tool surface is identical for both token kinds.
- **Exact-seat assignment**: `createMatch({ assignments: [{team,role,owner,kind,commander:{id}}] })` attaches only the
  explicitly selected named commander to exact match/team/role leases. One ID may fill several compatible roles
  on one match/team, with per-role inbox, wait and approval state; it cannot span opponents or concurrent matches.
  Assignments derive owners from authentication and fail atomically. Named identities have only agent/policy kinds.
  A commander returns to the lobby on outcome, release or disposal; a new match cannot steal its live routing.
  Live deploys and rollbacks also update the persistent library.
  `PlayerThreeMatch.assign(assignment)` re-assigns one seat before the start or mid-match at the current tick
  boundary, atomically and recorded as a seat change: the previous occupant's lane returns to the lobby and its
  exact-seat credentials stop, and the new commander's next `game_wait` returns the match entry. `ownerControl: true`
  lets the owner of an automated seat hold it as a human
  ([SPEC §4 *Mid-match seat assignment*](../spec/SPEC.md#mid-match-seat-assignment--implemented)).
  Session history and operator attribution index owners by `team/role`; retained history rebuilds that index
  from its per-seat records. Loading an empty commander library does not emit an unchanged lifecycle status.
- **Ready check**: `readySeconds` holds all stepping paths, including `step()`, at tick 0. Agents need fresh
  presence since assignment and their own ready mark (`game_ready`; present but unmarked is `online`); saved
  policies need current-surface, actual-seat activation validation. Humans need
  both `setHumanReady(team,role,true)` from the trusted game and `humanJoined(team,role,true)` from the authorized
  room binding. `readiness()` exposes closed per-seat states; `readyCheck()` retains the compact clock snapshot.
  `skipReadyCheck()` / `start()` are trusted explicit fallback overrides; the deadline releases AI gates only
  after all required humans are ready and actually joined. The game cancels or ends absent-human preparations.
  Public countdowns call `match.holdStart()` synchronously after creating the non-realtime match, before
  exposing it to agents. This independent manual gate survives readiness/deadlines and rejects gameplay `act`
  and `sequence` with `paused`, while briefing, observe and policy probes remain available. Release only with
  trusted `skipReadyCheck()` / `start()` once countdown and actual human admission are complete.
- **Public multiplayer credentials**: `mintHumanToken(team,role,{ttlSeconds?})` and
  `mintSpectatorToken(team,{ttlSeconds?})` return `{token,expiresAt}`. The human can manage only its exact seat,
  though its game view is own-side fogged. The spectator's side is fixed. These and agent seat tokens expire
  after 120 seconds by default (maximum 600), atomically bind once with `host.claimToken(token,connectionId)`,
  and are consumed on disconnect. Every inbound call and private outbound push requires `authorizeLease`.
  Reissue, `revokeSeat`, expiry, end and disposal revoke joined clients; use `onLeaseRevoked` to close transports.
  `renewHumanToken(team,role,{ttlSeconds?})` extends a connected human credential in place (no rejoin). A human
  who hands their seat to an agent, policy, bot or hold still holds it: minting and renewal keep working until
  `revokeSeat`.
  Revocation immediately rejects token-bound pending waits and cancels their queued sequences before a replacement
  can consume messages. Waiters recheck credential validity before reading/draining private data; persistent
  commander connections retain their ordinary authenticated terminal-match/lobby transition.
  Root team/unrestricted spectator tokens remain trusted private APIs, never public-lobby admission credentials.
- **Public disclosure**: use `cards()`, not `seats()`. Cards unconditionally mark AI and disclose actual controller
  mode and policy source/version without owner IDs, credentials, scopes, mandates, chat, endpoints or code.
  Without trusted harness authentication metadata, the card is explicitly unverified.
  Host failure diagnostics use fixed messages rather than interpolating adapter/storage exceptions, which can
  contain private inputs, credentials or connection strings. Observer failures cannot prevent terminal revocation.
- **Storage**: `CommanderStore` (sync or async methods): JSON files under `dataDir`, in memory by default,
  `playerthree/postgres`, or the game's own database. Tokens are HMAC-derived from a host key in the store and looked up
  by SHA-256 digest; the store is as sensitive as the tokens.

Seating, the start of a held match and terminal match-end results are retained once when there was no wait in flight,
so transitions between calls are not lost. They never preempt or swallow unread owner messages. `PracticeResult` is explicitly
`{ ok: true, outcome, ticks, report, policy, wallMs }` or
`{ ok: false, code: 'policy' | 'guard', policy, wallMs }`; commander `lastPractice` records successes only.

### Owner ↔ commander chat (`control.chat`)
A player can talk to **their own** agents, and only theirs: `match.tell(team, roles | 'all', text, ping?)` (protocol
`playerthree:tell`, team owners only) or `host.commanders.tell(owner, commanderIds | 'all', text, ping?)` (named
commander IDs, never role aliases; lobby or live match). Text ≤ `maxTellChars` (≤ 500), rate-limited;
`ping` is a developer-declared closed-vocabulary schema (e.g. a map point).
Agents receive `{ from: 'owner', tick, text, ping? }`: `game_wait` ends early (`wake: 'owner_message'`) and returns
unread `messages`; `game_observe` returns them **next to** the observation, never inside it. Policies never
receive chat. Agents answer with `game_say` (≤ `maxSayChars`, ≤ 280, rate-limited) — delivered only to that team's
owner clients (`playerthree:said`; via `match.onSaid`) and, for roster commanders, to the owner's roster log
(`commanders.chat(owner)`, `commanders.onSaid`). Works in the lobby too. The one explicit exception is
`game_say { disclosure: "observers", category? }`, which opts that reply into consented observer commentary (delayed
like every observer frame, [SPEC §12](../spec/SPEC.md#12-owner-chat--implemented)). Chat is in memory only: never in replays,
the pool, DevTools traces or persisted storage. Player-to-player chat, if a game wants it, is a game concern
outside PlayerThree and never enters agent-facing payloads.

### Team signals (`manifest.signals`, `control.signals`)

Seats on one team need to ask each other for help — an RTS plane wanting troops from the surface, a squadmate calling
for cover — whatever drives them: a human, an agent, a policy or a built-in bot. Chat cannot carry this: teammates are
third parties to your agent, and policies never receive chat. Team signals are the typed alternative
([spec §22](../spec/SPEC.md#22-team-signals--implemented)).

- **Closed vocabulary.** The game declares signal kinds with typed payloads (enums, numbers, coordinates, entity ids;
  `defineManifest` rejects any `str`), and per-role **cards**: what each role answers (`{kind, where?}`, e.g. Orbit
  answers `request_support` with `need: scan`). Routing checks cards, so nobody is asked for what they cannot do.
- **Ordinary intents.** `signal {signal:{kind, to: role | 'team', …payload}}` and `signal_update {id, update}` are two
  reserved intents generated by `signalSchemas()`; every input tier, gate, sequence and replay carries them unchanged.
  A per-seat bucket in game ticks and an open-signal cap bound what one seat can put on the board.
- **Lifecycle the requester can see.** `submitted → working → completed | rejected | failed | canceled | expired`, the
  A2A task states plus `expired` (open past `ttlTicks`). The first teammate to ack a `team` broadcast takes it.
- **Host-owned board, one per team.** The host attaches each seat's slice (`signals: {inbox, sent}`) to every
  observation, the team's board to every view, and wakes waiting agents (`wake: "signal"`). Games never handle them in
  `apply`; a game's UI renders the view member, its bots and policies read the observation member.
- **Deterministic.** Boards change only through accepted signal intents (recorded as replay entries) and tick turnover
  right after each step. Ids are team-local, so a team learns nothing about another team's traffic.
- **Per match.** `adapter.signalLimits()` narrows the manifest's limits or turns signals off for one match (a lobby rule).

We borrowed from Google's Agent2Agent protocol what fits a deterministic, fog-safe match — agent-card skills as role
cards, the task lifecycle and its state names, structured data parts instead of text, push-style delivery and cancel —
and left out what does not: HTTP transport, text and file parts, per-request auth, and open-ended dialogue
(`input-required`).

### Policy packages: a shareable, game-agnostic envelope — format and starter knobs implemented, registries proposed

The implemented envelope is `playerthree.policy/1` ([SPEC §13.1](../spec/SPEC.md#131-policy-packages--implemented-registries-proposed)): sources plus composed script, content hash, lineage, license, owner-only export/import. The notes below are the wider design. Policy *contents* are game-specific; the *envelope and lifecycle* are not. PlayerThree defines the envelope so every PlayerThree game can grow a bot community without rebuilding the tooling.

- **Package:** a JSON manifest plus code files. Manifest fields:
  - `format: "playerthree.policy/1"`;
  - runtime (`js` or `wasm`), entry, and a content digest;
  - license; authors and description (shown to humans only, rendered as plain text, never delivered to any agent);
  - roles it can drive;
  - **compatibility:** game id plus hashes of the game's observation and intent schemas.
- **Knobs:** typed tunables (e.g. aggression, greed, timings). The policy reads them; owners or agents tweak them between matches without editing code. Implemented for a game's starters ([SPEC §11 *Starters*](../spec/SPEC.md#starters--implemented)): the starter module exports a bounded JSON Schema `knobs`, and `policy_deploy {from, knobs}` builds `createPolicy(knobs)`; the package records `{from, knobs}` as its source.
- **Lifecycle:**
  - validate (schema, digest, compatibility);
  - load into the sandbox;
  - practice;
  - rate on the host's ladder;
  - publish to the host pool;
  - fork, with parent and child lineage recorded.

  Incompatible packages are rejected or flagged, never run silently.
- **Safety:** imported packages run in the same sandbox as any policy. Package text never reaches an agent. Opponents' agents never see a bot's code.
- **Not in PlayerThree:** a central registry and community UI. Each game hosts its own gallery and ladder on PlayerThree's APIs; a cross-game registry could be a separate service later.

### Who fights whom
- **Allies**: your agent drives seats on your team (in Agent Command, its roles are called planes: the ones you are not watching).
- **Rivals, for real**: each team owner attaches their own agents; agent vs agent in a live match.
- **Async enemies**: published policies from the pool fill enemy seats; humans fight other people's agent-written bots.

## 3. Bindings

PlayerThree does not own the game's netcode.

- **In-process** `PlayerThreeHost` / `PlayerThreeMatch`: the game server hosts matches; built-in bots and practice use this directly.
- **MCP** (primary agent binding), spec `2026-07-28`, `@modelcontextprotocol/server` v2:
  - remote **Streamable HTTP** endpoint the game server mounts (players install nothing), and a **stdio** bridge that forwards to it;
  - one tool per control method with stable names (`game_briefing`, `game_observe`, `game_act`, `game_wait`, `policy_deploy`, …);
  - one static URL for every player: the endpoint's own OAuth 2.1 authorization server signs harnesses in through the browser; the game's consent page grants a **connection** (one selected named commander and a granted subset of its compatible roles) that routes like that commander's token, editable live and revocable ([MCP.md](MCP.md#sign-in-one-url-for-every-player-oauth));
  - per-match seat tokens and persistent commander tokens on the same endpoint as bearer fallbacks (see Commanders);
  - default workflows (`playerthree-commander`, `playerthree-inputs`, `playerthree-owner`, and policy-mode-only `playerthree-policy-author`), generated reference and developer strategy **skills** over the MCP Skills extension (`io.modelcontextprotocol/skills`), with content digests and `game_skill` fallback; the reserved `playerthree-` prefix prevents developer overrides and all content participates in `surfaceHash`;
  - **elicitation** via MRTR to get the human's explicit consent when a token is first used;
  - long calls (`practice_run`, `game_wait`) send progress notifications; the MCP tasks extension is not used yet because the 2.4.0 SDKs only reserve its method names.
- **Colyseus interop** (`@playerthree/colyseus`): wire a Colyseus `Room` to a `PlayerThreeMatch` — token auth on join, owner messages (`playerthree:*`), per-client fogged views, and stream mode. A separate package; the core never imports Colyseus.
- Any other transport: carry the `protocol.ts` messages yourself.

The runner bridge's opt-in `--channel` provides Claude Code research-preview lifecycle wakes through experimental
`claude/channel`: seating, match outcome, approval resolution and labelled own-owner messages only. It prefers
implemented private `subscriptions/listen` seat-status updates, falling back to per-role waits and a shared
once-per-second briefing poll. Ordinary MCP still needs a kickoff and lobby wait loop. Hosted Claude API /
Managed Agents are tools-only; `game_skill` suffices, with public HTTPS and a commander token.
See [MCP](MCP.md#claude-code-wake-channel--implemented-research-preview) for authentication and wake limitations.

### Benchmarking

`@playerthree/bench` evaluates models and policies on any compatible game, BYOM, through the reference series runner
([SPEC §20.11](../spec/SPEC.md#2011-series-execution-durability-and-disclosure--implemented)). A `bench.config.ts`
default-exports one `BenchConfig` (or a list): the game `definition` (inline, or `{ module: <file: URL>, export? }`), an
explicit frozen `SeriesSpec` in `spec`, `models` and pinned `policies` keyed by entrant id, an optional
`resolve(matchSpec)` hook that freezes the game's actual defaults, map identity and `rulesHash` (required for games
with `matchOptions`), and optional `guardrails`. Run it with `playerthree-bench --config ./bench.config.ts --out
./bench-results` (from `@playerthree/bench`); from a checkout that is
`node packages/bench/bin/playerthree-bench.ts --config ./bench.config.ts --out ./bench-results`
([CLI](CLI.md#benchmark-cli--separate-package)).

The `SeriesSpec` pins game, version and `surfaceHash`, and declares the `track`, entrant cards, a template match (sides
and seats whose occupants are built-in bots at a level or commander seats of kind `agent` or `policy`), `scenarios`
(seed, map, options), side `permutations` and `repetitions`, `execution` (clock `realtime` or `accelerated` for this
runner, `speed`, `maxTicks`, `maxWallMs`, `maxInfraRetries`, `concurrency`), shared `budgets` (`maxTokens`,
`maxCostUsd`, `maxTurns`), `rating` (Elo or TrueSkill) and `telemetry`. Every match runs headlessly on an in-process
host behind a loopback MCP endpoint:

- **bots**: built-in tiers and pinned `policies` artifacts; no model, credentials or budget.
- **policy** (primary): a policy seat without a pinned artifact is authored once per entrant and role by its model in
  a lobby session (briefing, skills, deploy, practice restricted to `spec.authoring.practiceSeeds`, within
  `authoring.maxWallMs`); that frozen artifact then plays every match with no LLM. Campaigns author all of a
  candidate's roles with one lobby commander, optionally after pre-deploying `authoring.starters`, through the
  runner's loop or OpenCode ([CLI](CLI.md#fixed-reference-campaigns)). The session brief ends with the series' own
  `authoring.brief` when it has one: how the frozen policies are evaluated (rules, opponents, maps, scoring), so a
  model never has to guess which rules its practice should use. A series `authoring.systemPrompt` is the model's whole
  system prompt under either harness (OpenCode's own never reaches the model), published in the suite with its digest.
- **live**: `agent` seats play through intents and sequences with the runner's agent loop.

`gauntlet` (a frozen policy against fixed built-in references) is a game-defined series of the same shape.

Comparisons pin the surface hash, keep held-out scenario seeds disjoint from practice seeds (validation refuses an
overlap), and share one budget per series: per-model budgets are refused, and `maxCostUsd` needs a known or explicit
price. Keys come from `apiKeyEnv` (default `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`); the `scripted` provider replays a
`script` offline, so CI needs no key. The results' `comparisonHash` covers the export-safe spec and the expanded
schedule, not display labels or worker concurrency. The benchmark measures the declared game surface and budgets, not
an unrestricted claim about model strength.

Outputs are the canonical `playerthree.results` download `results.json`, the same revision as CSV tables
(`results.zip`, `csv/`), available replays under `artifacts/` and, with guardrails, `guardrails.json`. Standings carry
win/score rates with seed-block bootstrap intervals and the configured Elo or TrueSkill rating
([SPEC §20.10](../spec/SPEC.md#2010-canonical-results-and-ratings--implemented)); usage keeps tokens and decimal cost
where priced and null where unknown. The CLI exits nonzero when a series does not complete, an accepted match did not
finish, or a guardrail fails. Fixed-reference campaigns (`playerthree-bench campaign`) author independent runs per
candidate model against an immutable suite and publish consented evidence ([CLI](CLI.md#fixed-reference-campaigns)).

Games may implement `metrics(game, { sampleEveryTicks? })` returning a `GameMetricRecorder`: `collect()` after every
tick, including the terminal one; `finish()` once, returning finite numeric maps `{ match, sides }` keyed by physical
teams; optional `rows(matchId)` for sampled result rows and `intent(row)` for intent accounting. Recorders must only
observe: no state mutation, RNG consumption or changed observations. The runner validates `finish()` output (4096
entries/map, 128 characters/key, 1 MiB total) and records it as match and side metric rows, with units from
`spec.telemetry.metricDefinitions`. Game-specific metric names remain entirely in the game adapter.

Optional `guardrails` are data, not callbacks: `{ id, scenario?, metric, scope, aggregation, comparator, threshold }`,
evaluated over accepted matches. Scopes are `match`, `entrant:<id>` or `team:<physical-team>`; aggregations are `mean`,
`median`, `min`, `max`, `sum`, or `binomialTwoSided`; comparators are `<`, `<=`, `>`, `>=`, `==`, `!=`, or inclusive
`between` with a pair. Metrics `ticks` and `truncated` and side `outcome.win/loss/draw` are built in; a game metric's
value is its last sample in the match. `binomialTwoSided` requires a side `outcome.win` and counts decisive outcomes
only (none gives p=1). A guardrail with a missing metric or no samples fails. Games choose all thresholds and any
multiple-comparison correction in their config.

Replay execution checks `gameVersion` against the current manifest and rejects a mismatch with
`playerthree/replay: game version mismatch`; recorded inputs do not establish cross-version reproducibility.

`GameAdapter.apply(seat, intent, context)` receives trusted `IntentContext.source` (`owner`, `agent`, `policy`,
`bot`, or `fallback`), independently of the seat's controller. Sources come from the authenticated host path,
not the intent payload; direct calls omitting context are explicit owner calls. Practice supplies policy/bot
origins too. Games may use this distinction to keep automation from overwriting explicit orders.
Replay format v2 records the source as the sixth field of every `intent` tuple, plus `ownerRoles` as a seventh on
`owner` intents, and restores both during replay. Any other replay version is rejected (`not a replay v2`) rather than
guessing whether an agent-controlled seat's input was manual or automatic.

### Commander match log and ratings

Commander records and ratings come from one append-only log, never from counters a commander stores
([SPEC §20.10.1](../spec/SPEC.md#20101-commander-match-log--implemented)). When a match is over, halted or disposed,
the host writes one `playerthree.commanderLog` entry per match × named commander from host-observed facts: game,
version and surface; the commander's public id (`commanderPublicId(game, id)`, never its private id or owner); seats,
lineup and opponents; control accounting (owner intents and tells, fallback and absent-policy ticks, paused time,
`assist`, `fallbackShare`); outcome, disposition, rank and a replay digest; the game's facts from
`createMatch({ log })` (mode, queue, rules hash, map); and `selfPlay`. The game's `commanderLog.verdict(context)` hook
stamps `{ rated, pool, segmentId, weight, badges, reasons }` (unrated without one). Entries chain per commander
(`seq`, `prevDigest`, `digest`); with an Ed25519 `commanderLog.signer` (`parseResultsSigner`) the host is official and
signs every entry, and `verifyCommanderLog(entries, keys, sealed?)` (`playerthree/results`) checks format, digest,
chain and signature under published `ResultsKey` validity windows and revocation. Verdict changes are separately
signed rows (`host.commanderLog.amend`), never rewrites; deleting a commander or owner tombstones only its sealed
owner-private part. `CommanderStatus.record` counts the log's decided, non-self-play entries, and owners read their
commander's entries with `commanders.log(owner, id)`.

A game rates from that log. `rateMatch(env, lineups, ratings, weight?)` (`playerthree/results`) is the one TrueSkill
update (`ts-trueskill` 5.1.0) every rating uses, series standings included: allied lineups form one team at their
shared rank, members may carry partial-play weights in (0, 1], and the match weight in [0, 1] blends the update.
`blockBootstrap(blocks)` gives seed-block percentile intervals for a game's own scoring blocks. Only a signed host's
entries should feed a public rating, and imported or submitted results never do
([SPEC §20.7](../spec/SPEC.md#207-fair-play-rules)).

### Engine adapters — sidecar implemented

A non-JS game server (Unity, Unreal, Godot, C++, C#, Go) runs the host as a local sidecar process, `@playerthree/sidecar` (SPEC §20.8 (a)). The engine spawns it over stdio or connects to its owner-only Unix socket, sends its manifest as plain JSON, drives the clock with `advance` (host `match.step(n)`) and answers adapter and bot calls as newline-delimited JSON. The adapter stays JSON-in/JSON-out and synchronous per tick: the host blocks on each call until the engine answers (per-call deadline). `packages/sidecar/conformance` (Tug of War manifest, transcript, mock engine, runner) is what every engine SDK passes. Determinism, replay and practice are opt-in capabilities; a live integration must not require a headless deterministic engine.

### Hosting topology by game type

| Game type | Host location | Status |
|---|---|---|
| Multiplayer | Developer's game server, next to the authoritative simulation. | **Implemented** |
| Desktop / console single-player | Local sidecar started by the game; engine calls use the adapter contract. | **Proposed** packaging; the sidecar itself is implemented |
| Browser-only single-player | Developer's backend runs game logic and the host, or a small local helper process accepts MCP and bridges the tab's simulation. | **Proposed** integration topology; server SDK exists |

**A browser tab cannot accept MCP connections itself.** A browser-only game still needs that backend or helper endpoint. The existing stdio MCP bridge forwards to an already running host; it is not the proposed simulation sidecar/helper.

### Genre fit

These are integration choices, not presets automatically enabled by the SDK. All games expose intents; sequences and policies are optional. Stream is a transport for intents, not another input tier. `pause` needs a game declaring `control.pausable`. **† Proposed:** desktop/console sidecar and browser backend/helper packaging. The [spec matrix](../spec/SPEC.md#genre-matrix--integration-guidance-not-required-mode-presets) defines the same guidance.

| Genre | Input tiers | `whenAbsent` choices | Session | Hosting |
|---|---|---|---|---|
| RTS | Intents, sequences, policy | `policy`, `bot`, `hold` | Ending match | Multiplayer server |
| Turn-based | Intents; sequences/policy optional | `hold`, `policy`, `bot`, solo `pause` | Ending; optional persistent campaign | Server, sidecar†, browser backend/helper† |
| Card | Intents; policy optional | `bot`, `policy`, `hold`, solo `pause` | Ending match/run | Server, sidecar†, browser backend/helper† |
| Puzzle | Intents, short sequences; policy optional | `hold`, `pause`, `policy` | Ending run | Sidecar†, browser backend/helper† |
| Roguelike | Intents, sequences, policy | `policy`, `bot`, `hold`, pausable `pause` | Ending run; optional persistent campaign | Sidecar†, browser backend/helper†; multiplayer server |
| MMO / persistent | Intents, sequences, policy | `policy`, `bot`, `hold`; no shared-world pause | Persistent | Multiplayer server |
| Idle / colony | Intents, sequences, policy | `policy`, `bot`, `hold`; private-world `pause` if pausable | Persistent | Server, sidecar†, browser backend/helper† |
| FPS squadmate | Tactical intents/sequences, tick-rate policy; stream optional | `policy`, `bot`, `hold` | Ending match | Multiplayer server; solo sidecar† |
| Co-op companion | Intents, sequences, policy | `policy`, `bot`, `hold`; `pause` only if the whole input-needing session can stop | Ending or persistent | Multiplayer server; solo sidecar† or browser backend/helper† |

### Storage
Hosts keep commanders, OAuth connections, the pool, the session history, the commander match log and benchmark series behind their store interfaces (`CommanderStore`, `ConnectionStore`, `PoolStore`, `HistoryStore`, `CommanderLogStore`, `SeriesStore`): in memory by default (a series always selects a durable store explicitly), JSON files under `dataDir` / `poolDir` / `history.dir` (the commander log as JSONL under `dataDir`; series through `jsonSeriesStore(dir)`), or the game's database. `playerthree/postgres` implements all six on PostgreSQL (`pg` driver) with game-scoped tables and plain-SQL migrations applied at startup, so hosted deployments (e.g. Railway) get durability and backups; `await host.ready` before serving. Live state stays in one process per game. In 0.x, schemas are replaced, never converted: a database created by an older schema refuses to open until an operator runs [`playerthree db reset`](CLI.md#playerthree-db-reset), which drops only PlayerThree's and the named game scopes' tables and re-applies the migrations. See [SPEC §21](../spec/SPEC.md#21-durable-storage--implemented).

## 4. Safety model

Threat: an agent seat is usually a powerful harness (shell, files, web). Everything the game returns is model input.

1. **No third-party text reaches an agent.** The schema DSL (`packages/playerthree/src/schema.ts`) has `enum`, `id`, `int`, `ints`, `num`, `bool`, `list`, `obj`, `opt`, `union` and one text node, `str`: bounded, optionally pattern-checked, and restricted by contract to trusted developer data or the receiving seat's own owner's data (team signals reject it outright).
   Enum literals are developer-declared identifiers; ids are pattern-locked (`e_123`). Nothing an opponent, a teammate or a spectator types can reach an agent.
2. **Outbound guard.** Every observation, view, report and event is validated against its schema before it leaves; non-conforming data fails closed.
3. **Own-text rule.** The only free text an agent ever receives is text its own side authored: its policy's log lines and engine errors about its own artifact, and (chat mode) messages from its **own owner** — the same trust as the player typing into their own harness — labelled `from: 'owner'` and kept next to, never inside, game data.
4. **No third-party text channel.** Owner → agent guidance is a typed mandate plus, opt-in, owner chat. Teammates reach your agent only through typed team signals (closed vocabulary, no text; see Team signals). Opponents, teammates (a co-op teammate is a third party) and spectators have no text channel to your agent; they cannot send `tell` and never see `game_say` replies, which go to the speaking seat's own owner only (render as plain text, never markup). In-game player-to-player chat stays a game concern outside PlayerThree and never enters agent-facing payloads.
5. **Fog is server-side.** Agents see exactly what their team sees.
6. **Agent output is untrusted.** Schema-validated, role-checked, controller-checked, rate-limited. Errors are closed codes + schema paths; input is never echoed.
7. **Policies are sandboxed.** QuickJS-in-WASM or capability-free WASM; no imports beyond `log`; a per-call CPU-time budget with a wall-clock hang guard, memory caps; hard kill.
8. **Static, pinned tool surface.** Tool names/descriptions/schemas and all served skills are generated from the manifest at startup; `surfaceHash` lets a player pin them. No sampling or roots. Consent and long-call progress are supported; an explicitly enabled stdio channel additionally projects only the restricted lifecycle/owner messages above.
9. **Seat-, commander- and connection-scoped credentials.** A seat token = one seat in one match; unclaimed it expires after 120 seconds by default, and it dies with the match. A commander token = one named commander of one owner's roster: in the lobby it reaches only that commander's own library, practice and static docs; in a match only the exact seats that commander occupies on one team (agent rights). Rotation revokes the old commander token at once (also mid-match). A sign-in connection = one selected named commander and the compatible roles its owner granted on the game's consent page, each with exactly a commander token's rights; role edits and revocation apply to the next call. No kind can mint tokens, change controllers or join the game transport as an owner/spectator.
10. **Sign-in is spec OAuth, consent stays with the game.** MCP authorization 2026-07-28: protected resource metadata (RFC 9728) in the `401` challenge, authorization server metadata (RFC 8414) with `S256` as the only PKCE method, `iss` in every authorization response (RFC 9207), public clients only. Clients are Client ID Metadata Documents — fetched over https from public addresses only (every resolved address vetted and the vetted one connected to; no redirects; 5 s, 5 KiB, JSON; `client_id` must match; no secrets), cached per `Cache-Control` — or dynamically registered (https or loopback redirect URIs only; self-asserted names are shown as unverified). Redirect URIs match exactly (loopback: any port, RFC 8252). PlayerThree never authenticates players: the game's own page answers the consent request for its authenticated owner and shows the client, the verified domain if any and the redirect host. Codes: 60 s, single use, replay revokes. Access tokens: opaque, 1 h, audience-bound to the MCP endpoint. Refresh tokens: rotate on every use; a rotated one presented again revokes the connection. Only SHA-256 digests of tokens are stored. Revocation (RFC 7009 and owner-side) is immediate.

Out of scope: a malicious game developer (manifest text is trusted); *strategic* deception (baiting is gameplay).

These guarantees serve three audiences: the **player** (no third-party text reaches their harness), the **game** (validated, fogged and rate-limited control), and **other players** (fair restrictions and disclosed controller identity). `setSeatInfo` exposes the controller and mandate; the game chooses how to display the controller badge and enforce its gameplay limits.

## 5. Operator console — Implemented

DevTools is the developer/operator-only **operator console**, not a player screen with an admin switch. Player
credentials never grant access. Exactly one access mode per mount:

- **Local (default):** no credential; direct loopback peer only, proxy headers rejected, `Host` limited to
  `localhost`/`127.0.0.1`/`[::1]`, `Sec-Fetch-Site`/`Origin` checked against DNS rebinding and CSRF; writes need
  `Origin` or `Sec-Fetch-Site` plus a JSON body.
- **Production:** `authorize(req)` backed by the game's admin auth (ambient-cookie writes also need same-origin headers
  and JSON), or a static `operatorToken` fallback (Bearer, SHA-256 + timing-safe comparison, HTTPS or direct loopback
  only, never in URLs).
- **Overview:** game, session counts, agent activity, 15-minute rejection and policy-error window.
- **Sessions:** live/ended sessions, God / side / seat perspectives, all sides' traces, isolated replay scrubbing,
  export, end (`PlayerThreeMatch.end`, adopted by the game through optional `GameAdapter.end(outcomes, ranks)`).
- **Agents:** commanders and sign-in connections, activity, rejections; rotate/revoke.
- **Policies:** every named commander's isolated library, pool entries (disable or unpublish through
  `host.pool.setDisabled` / `host.pool.unpublish`) and exact-seat policy failures.
- **Bench:** read-only listing of the bench result directories given as `benchResultsDir`, with standings, cost and
  replays opened in the session timeline.
- **Safety:** `surfaceHash`, enabled modes and limits, scopes and new-seat defaults, the game's Safety Card when
  configured (`safetyCard`), and rejection codes.
- **Game settings:** read-only `matchOptions` schema, the host's default options and each session's options.

Optional `GameAdapter.debugView(): unknown` supplies bounded unfogged JSON; `PlayerThreeMatch.debugView()` forwards it or
returns `null` when absent. Optional `GameAdapter.clone()` enables bounded scrub checkpoints; it does not create
durable world storage. Agent Command mounts the console without a credential locally and with `OPERATOR_TOKEN` when
deployed; its dev-admin API keeps `AC_DEV_ADMIN_TOKEN`. See [DevTools](DEVTOOLS.md) for the API and limits.

### Operator sections — Proposed parts

Starting BYOM bench runs from the console and editing match options or default mandates are **Proposed**; the console
points to the CLI and the game's own configuration instead ([DevTools](DEVTOOLS.md#sections)).

### Player console — Implemented

`@playerthree/console` reads the owner-private player API (`createPlayerApiHandler`) with a credential the game already holds: the game's profile credential through the API's `owner` resolver (the named commander roster by default; a live seat only with an explicit `?commander=&match=&team=&role=` selection), an exact-seat human capability, or a trusted private team-root capability. It is a headless client plus an optional drop-in panel the game themes (CSS variables) and hides behind a toggle key. It covers only the owner's seats: status, mandate/scopes/limits, approvals, recent intents and ack codes, own policy errors/logs, practice, observation size and a token estimate (`ceil(bytes / 4)`, optional price). It grants neither God view nor cross-owner access, and approvals resolve only through the game's own owner action.

## 6. Reference games

- **Agent Command** ([agentcommand.gg](https://agentcommand.gg)): implemented multiplayer reference with four declared sides, played as two-side duels or four-army free-for-alls, in real-time commander play. It exercises competitive matches, team signals, owner controls and model benchmarking.

Single-player support comes from the same manifest and adapter contract: `teams` accepts one side, and a benchmark series may seat a single side (outcome plus the game's report; one-side matches feed no rating). A match need not seat every declared side (`createMatch({ teams })`). Capability-gated host pausing and in-memory persistent sessions are Implemented; durable persistent-world lifecycle remains **Proposed**. Multiplayer terminology and assumptions are not requirements for every integration.
