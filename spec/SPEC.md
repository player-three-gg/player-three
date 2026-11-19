# PlayerThree Specification

**Version 1** · Control plane `1` · Game transport protocol `1`

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative as defined by RFC 2119. JSON examples describe data, not a required implementation language. `?` in shape notation means an omitted optional member; it is not part of the member name. Integers and numbers MUST be finite; ranges are inclusive.

**Implemented** identifies the version 1 contract, including scopes, mandates, absence behavior, sequences, supervised artifact approvals, benchmarking, and connect-kit onboarding delivered with this specification. **Proposed** identifies work outside current conformance. A feature being Implemented does not require every game to enable its optional mode. Unless explicitly marked Proposed, subsections inherit their section's Implemented status.

## 1. Purpose and framing — Implemented

PlayerThree lets an **owner** — the player handing over the second controller — give a seat to their own AI. A **seat** is a controllable slot within a **side**; a **perspective** is what that seat or side may see. Teams are one possible grouping, not a requirement for multiplayer or opposition. The current wire/API names remain `{team,role}` and `teams`; `teams` MAY contain a single value. **BYOM** means the owner or benchmark operator supplies the model, credentials, and model spending, rather than the game hosting an LLM for them.

The interface parallels accessibility: an observation is a semantic screen, and intents are semantic buttons. These same game descriptions can support narration, voice, or switch access; this specification does not standardize those human interfaces.

Single-side games are conforming integrations: a co-op companion, handing control over while away, authoring a bot for a single-player run, or benchmarking a run without an opponent. Multiple sides do not imply that every participant sees the same perspective; the game MUST enforce each recipient's visibility. A manifest's `teams` are the sides a game declares; each match seats a nonempty subset of them (default all), optionally partitioned into named **alliances** whose members share outcome and rank (§10).

### Terminology — Implemented framing; API names unchanged

| General term | Meaning | Multiplayer case / current API vocabulary |
|---|---|---|
| **Session** | One running game world or run, either ending in an outcome or persistent without a terminal outcome. | A **match** is the multiplayer case; current APIs use `PlayerThreeMatch`, `createMatch`, `matchOptions` and phase `"match"` for solo sessions too. |
| **Side** | A grouping of controllable seats; one side is sufficient. | A **team** is one case; current schemas and APIs use `teams` / `team`. |
| **Counterpart** | An optional other participant, cooperating or competing; a solo run needs none. | An **opponent** is the competitive case; current `opponents` names built-in bot tiers. |

An owner and a perspective retain the meanings above. A game session is not an MCP transport session, an OAuth connection, or a commander's persistent identity. These general terms do not rename version 1 fields or add a new phase literal. See §18 for persistent-session and pause limitations.

A conforming integration MUST uphold three safety promises:

1. **To the player:** no third-party player text reaches the agent through PlayerThree.
2. **To the game:** actions are validated, role- and controller-checked, fogged, and rate-limited; an agent receives no privileged cheating channel.
3. **To other players:** agent control is bounded and disclosed. The host MUST convey the assigned controller to the game; the game MUST disclose agent/policy control through an appropriate badge or equivalent presentation and enforce its declared gameplay limits.

The game developer and static developer documentation are trusted. A malicious game developer and strategic deception within legal gameplay are outside the threat model. A co-op teammate is a third party, not the seat's owner.

## 2. Layers and conformance roles — Implemented

| Layer | Responsibility | Reference package / status |
|---|---|---|
| Specification | Language- and engine-independent data and behavior contract | This document — **Implemented** |
| Server SDK / host | Manifest validation, guards, matches, commanders, policy sandbox, practice, pool, MCP and authorization | `playerthree` — **Implemented** |
| Connect kit | DOM-free harness setup, consent/status types, kickoff and mandate presets; no Node built-ins | `@playerthree/connect` — **Implemented** |
| Player console | Own-seat status client over the player API plus an optional themeable panel; no Node built-ins | `@playerthree/console` — **Implemented** |
| Runner and stdio bridge | BYOM execution and MCP forwarding; bins `playerthree-run`, `playerthree-mcp` | `@playerthree/runner` — **Implemented** |
| Developer CLI | `playerthree lint`, `playerthree audit`, `playerthree dev`, `playerthree db reset` (§21.2) | `@playerthree/cli` — **Implemented** |
| Benchmark | Reproducible model evaluation under fixed budgets | `@playerthree/bench` — **Implemented** |
| Transport binding | Existing game netcode integration | `@playerthree/colyseus` — **Implemented** |
| Engine sidecar | Host process for non-JS game servers (Unity, Unreal, Godot, C++, C#, Go): newline-delimited JSON over stdio or a Unix socket for the adapter and bot calls, the engine-owned clock and game-side session operations; conformance fixture and runner (§20.8) | `@playerthree/sidecar` — **Implemented** (protocol 1) |
| Godot SDK | GDScript addon that spawns the sidecar over stdio and answers its calls; Tug of War sample (§20.8) | `sdks/godot` — **Implemented**: headless Godot 4.5 and 4.7.2 pass the sidecar conformance runner on Linux and Windows, 4.7.2 on macOS |
| Unity / .NET SDK | netstandard2.1 sidecar client core, Unity package wrapper (`PlayerThreeSidecarRunner`); Tug of War sample (§20.8) | `sdks/unity` — **Implemented** for the .NET core, whose console sample passes the conformance runner on Linux, Windows and macOS; the Unity package wrapper is not yet compiled in Unity |
| Unreal / C++ SDK | C++17 sidecar client core, Unreal plugin wrapper (`UPlayerThreeSubsystem`); Tug of War sample (§20.8) | `sdks/unreal` — **Implemented** for the C++17 core, whose CLI sample passes the conformance runner on Linux, Windows and macOS; the Unreal plugin is not yet compiled in Unreal |
| Lobby integration profile | Seat kinds, identity cards, seat reservation, readiness, capability descriptors and fair-play rules for game-owned lobbies (§20) | **Proposed** |

A **game implementer** MUST supply the description and adapter, fog correctly, enforce game rules and mandate limits, and authenticate human owners. A **host implementer** MUST enforce the core safety and lifecycle rules and every optional mode it advertises. A **binding implementer** MUST preserve authorization, method semantics, and output guards. A **client implementer** MUST discover modes and roles, respect scopes and mandate, and handle closed errors. Implementations MAY use Unity, Unreal, Go, or another environment without depending on the reference packages.

The sidecar (§20.8) MUST preserve JSON-in/JSON-out operations, synchronous adapter semantics per tick, plain-JSON manifests, and engine-driven ticking; the reference blocks the host on each adapter call until the engine answers. Deterministic replay and headless practice MUST remain opt-in integration capabilities, not prerequisites for live agent seats. No discovery or engine plug-in protocol is standardized.

### Hosting topology — multiplayer server Implemented; single-player packaging Proposed

| Game type | Where the host and MCP endpoint run | Status |
|---|---|---|
| Multiplayer | The developer's game server, alongside the authoritative simulation and existing netcode. | **Implemented** |
| Desktop / console single-player | A local sidecar started by the game, calling the engine through the adapter contract (§10). The sidecar host is shipped (§20.8); platform packaging is not. | **Proposed** |
| Browser-only single-player, backend simulation | The developer's backend runs the game logic and host; the tab is a client. The existing server SDK is usable here, but a turnkey browser single-player integration is not shipped. | **Proposed integration topology** |
| Browser-only single-player, local simulation | A small local helper process that the tab connects to hosts the MCP endpoint and bridges the simulation through the adapter contract. | **Proposed** |

**A browser tab cannot accept MCP connections itself.** Browser-only rendering or play does not remove the need for a backend or local helper that accepts harness connections. Neither the §20.8 sidecar nor the Proposed helper is the existing stdio bridge: that bridge forwards MCP to an already running host.

## 3. Game description — Implemented

A manifest MUST be serializable as plain JSON. Functions, class instances, and runtime-dependent documentation MUST NOT be required to describe a game.

| Member | Meaning / constraints |
|---|---|
| `id`, `version`, `title`, `doc` | Static game identifier, version, title, core rules. `id`: `^[a-z][a-z0-9-]{0,47}$`; version 1–64, title 1–200, doc 1–6000 UTF-16 code units (details belong in `topics`). |
| `tickRate` | Game ticks per second, 1–1000. Turn-based games MAY advance one tick per turn. |
| `teams`, `roles` | Nonempty, unique `enum` schemas. `teams` names the sides the game declares and MAY contain one value; each side/role pair identifies a seat. A match seats a nonempty subset of `teams` (manifest order), optionally partitioned into alliances (§10). Current API names are retained. |
| `roleDocs` | One static nonempty document per role, maximum 3500 code units; no unknown roles. A role doc MAY name one topic to read first (for example "Read first: topic `tactics`."); it SHOULD NOT carry a reading list, since the default skills put a working deploy before further reading (below). |
| `topics` | Required map (possibly empty) of on-demand briefing topics `name → {summary, text}`, in index order. Names match `^[a-z][a-z0-9-]*(/[a-z0-9-]+)*$`, at most 64 code units, and MUST NOT equal or start with `<root>/` for the generated roots `role`, `intents`, `intent`, `observation`, `match-data`, `events`, `report`, `mandate`, `modes`, `schema`, `signals`, `starters`, `types`. `summary`: one line, 1–160; `text`: 1–8000. The index lines `name — summary` (newline-joined) total at most 5000. |
| `intents` | Nonempty map from intent kind to `{roles, params, doc}`; roles MUST exist and be nonempty, `params` is a field map, doc 1–4000 code units. `kind` is reserved. |
| `observation`, `view` | Closed schemas for seat-focused agent data and side-focused human render data, respectively. Both MUST enforce the recipient's perspective server-side. |
| `observationScope?` | Optional observation detail for games whose seats each focus on one part of a larger state (one plane of several, one squad of a team): `{sections, defaults}`. `sections` is a nonempty, unique `enum` schema of closed section names; `defaults` maps every role to the sections (a list of declared names, no repeats, possibly empty) its observation renders in full by default. See *Observation scope* below. |
| `matchData?` | Closed object schema for immutable, seat-visible match bootstrap data. Requires adapter `matchData(seat)`; it MUST enforce the seat's perspective. |
| `lobby?` | Closed object schema for the game's guarded pre-match summary in the lobby state (§4 *Lobby phase*). |
| `observer?` | Schema for omniscient observer data from adapter `observerView()` (§20.9). |
| `directive` | Object schema for the owner's objective, carried inside the mandate. |
| `limits?` | Object schema for owner-selected gameplay restrictions; every field MUST be optional. The game enforces these restrictions in `apply`. |
| `errors` | Nonempty enum schema of game rejection codes. |
| `event` | Object schema containing required `tick: int` and `kind: enum`; describes one visible event. |
| `opponents` | Nonempty enum schema of built-in opponent tiers, weakest first. |
| `report` | Closed schema for one side's after-action report, including solo-run results where applicable. |
| `matchOptions?` | Object schema with every field optional; omission means the game's default. Options MUST be validated before creating a match; a failure is `invalid` with `schemaCode`, `path` and `expected` (§4). The tool surface does not inline it: `practice_run.options` is an opaque object and the schema is topic `schema/match-options` (§4 *Tool-surface budget*). |
| `skills` | Static developer skills, possibly empty; see below. |
| `starters?` | Map from a starter path `"<skill>/<path>.js"` (a `.js` file of one of the game's own `skills`) to `{summary, roles?}`: ready-made baseline policies a player deploys by reference (§11 *Starters*). Requires `control.policy` with the `js` runtime. |
| `control` | Required `intents` mode and optional supported modes with finite limits. |
| `signals?` | Team-signal vocabulary `{kinds, cards}` (§22). Requires `control.signals` and the generated members. |

An intent is the JSON object `{ "kind": "<declared kind>", ...declared parameters }`. It MUST NOT contain undeclared parameters. Developer-authored intent kinds, enum values, and union variant names MUST match `^[A-Za-z][A-Za-z0-9_.<>]{0,47}$` (1–48 ASCII code units, permitting closed tokens such as `Surface`, `C2`, and `Array<Int>`). Field names and union tag names MUST match `^[A-Za-z_][A-Za-z0-9_]{0,47}$`, permitting declared interchange fields such as `__identifier`. These grammars do not admit wildcard runtime keys or values: every enum value/variant and object field MUST still be explicitly declared. Id prefix and numeric-suffix grammar is unchanged.

**Observation scope.** A game declaring `observationScope` renders each observation with a *detail*: the set of sections shown in full, in `sections` order. Sections outside the detail are still present as the game's compact summaries (counts, alerts and the cross-section threats a seat must react to); the game decides their shape inside its closed `observation` schema. The detail of a request is the role's `defaults` united with the requested sections, or every section for `"all"`; unknown section names are `invalid`. Agents request detail per call (`game_observe {detail}`, stream subscriptions); policies declare it once in the artifact (§11); built-in bots, the game's own code, always receive every section. Detail never widens fog: a section in full shows only what the seat's team may know, and summaries derive only from that same knowledge. Games without `observationScope` pass an empty detail and render as before.

### Closed schema vocabulary — Implemented

| JSON schema node | Accepted data |
|---|---|
| `{"t":"enum","values":[...]}` | Exactly one developer-declared literal; values unique and nonempty. |
| `{"t":"id","prefix":"e"}` | `e_` followed by 1–9 ASCII decimal digits. Prefix MUST match `^[a-z]{1,8}$`. |
| `{"t":"str","maxLength":N,"pattern"?:P}` | String of zero through N Unicode code points (a surrogate pair counts once; a lone surrogate counts once), not UTF-8 bytes or UTF-16 code units. N MUST be an integer in 0–100000. Optional P uses the safe pattern subset below. |
| `{"t":"int","min":0,"max":100}` | Integer within the bounds; schema bounds MUST be safe integers, within ±9007199254740991. |
| `{"t":"num","min":0,"max":1}` | Finite number within finite bounds. |
| `{"t":"bool"}` | Boolean only. |
| `{"t":"list","item":schema,"max":N}` | Array of zero through N items; N MUST be a nonnegative safe integer. |
| `{"t":"ints","maxItems":N,"min":A,"max":B}` | Array of zero through N integers, each within inclusive A–B. N MUST be a nonnegative safe integer; A and B MUST be safe integers with A ≤ B. This is a compact schema node, not a packed/binary wire encoding. |
| `{"t":"obj","fields":{"field":schema},"merge"?:"replace"}` | Object with precisely the declared fields, except optional fields MAY be omitted. Optional `merge:"replace"` controls atomic match-option layering, not validation. |
| `{"t":"opt","item":schema}` | Optional field marker, valid only directly in object or union-variant field maps. Omitted is not JSON `null`. |
| `{"t":"union","tag":"kind","variants":{"variant":{...fields}}}` | Tagged object; tag value selects the field map. Variants MUST NOT redeclare the tag. |

Schema nodes other than `opt` MAY carry static developer `doc`. The `str` and `ints` documentation MUST be a string of at most 4000 UTF-16 code units when present. There is no unbounded string or arbitrary-object/JSON node. Validators MUST reject unknown fields, invalid tags, non-finite numbers, out-of-vocabulary enum strings, and values exceeding declared bounds without echoing them. JSON Schema representations use the draft 2020-12 subset, closed objects (`additionalProperties: false`), bounded strings/arrays/numbers, and tagged alternatives. SDK builders are `t.str(maxLength, pattern?, doc?)` and `t.ints(maxItems, min, max, doc?)`; inferred types are `string` and `number[]`.

Bounded strings are not a prompt-injection sanitizer. Game integrations MUST restrict their provenance to trusted developer data or the receiving seat's authorized owner data; third-party chat, names, labels, and arbitrary third-party text MUST NOT enter agent-visible bounded strings. A pattern narrows syntax, not authority. Bounds apply before pattern matching. This extension does not relax the three safety promises in §1 or outbound own-text guards.

A `str` pattern MUST be 2–256 ASCII printable UTF-16 code units, start with `^`, and end with `$`. Its body is a concatenation of literal characters, `.`, character classes, or escapes `\d`, `\D`, `\w`, `\W`, `\s`, `\S`, `\n`, `\r`, `\t`, and escaped regex punctuation. Each atom MAY have a fixed `{n}` repetition; only the final atom MAY instead have `?`, `*`, `+`, `{m,n}`, or `{m,}` repetition. Explicit repetition bounds MUST be integers in 0–100000 with m ≤ n. Groups, alternation, lookarounds, backreferences, lazy/possessive modifiers, internal anchors, and other escapes MUST be rejected. Patterns MUST compile with ECMAScript Unicode (`u`) semantics. Hosts MUST require the match to consume the entire value (including rejecting a trailing newline otherwise permitted by `$`). This deliberately linear matching subset avoids catastrophic backtracking, and schema pattern/document payloads are independently bounded.
Character-class bodies MUST contain at least one atom after any initial negation marker; empty `[]` / `[^]` classes are outside this subset. Required directive strings default to empty text only when it conforms; a required pattern that rejects empty text has no automatic directive default, just as a required id has none.


JSON Schema exports `str` as `{type:"string",maxLength:N,pattern?:P}`; for a pattern P, the exported pattern MUST enforce strict end-of-input rather than `$`'s pre-final-newline behavior. `ints` exports as `{type:"array",maxItems:N,items:{type:"integer",minimum:A,maximum:B}}`. Exported maxLength retains Unicode-code-point units. Budget tools MUST conservatively account for up to `2 + 6*N` UTF-8 JSON bytes for an unrestricted bounded string (quotes plus JSON escaping), without materializing it. Integer-array byte accounting MUST use `2` for N=0 and `2 + N*max(len(JSON(A)),len(JSON(B))) + (N-1)` otherwise; it MUST NOT charge generic floating-number, object, or per-item schema overhead. Patterns MAY reduce actual string size, but MUST NOT cause a size underestimate.

Object schemas MAY declare `merge:"replace"` through `t.obj(fields, doc?, {merge:"replace"})`; any other merge value MUST be rejected. JSON Schema exports this static metadata as `"x-playerthree-merge":"replace"`. When host defaults, live-match options, practice overrides, or benchmark options are layered, a later supplied value at a marked object MUST replace the entire earlier object, without retaining omitted fields. Unmarked objects retain recursive field-wise merge behavior; arrays and scalar values replace. Omitted optional values retain the earlier layer. Implementations MUST use the manifest's schema when merging, including metadata under optional fields and union variants, and MUST NOT infer atomicity from field names or game-specific selector shapes. The annotation does not change accepted data, inferred TypeScript field types, or byte budgets; the merged result MUST still conform to `matchOptions`.



### Control modes and limits — Implemented

| Mode | Fields and permitted limits |
|---|---|
| `intents` (required) | `perSecond`: 0.01–1000; integer `burst`: 1–10000. |
| `sequence` | Integer `maxSteps`: 1–10000; `maxTicksAhead`: 0–2147483647; `minSpacingTicks`: 1–2147483647. See §9. |
| `policy` | Nonempty `runtimes`: `js` and/or `wasm`; `hz`: 0.01–tickRate; integer `msPerCall`: 1–1000; `memoryBytes`: 1048576–1073741824; `maxArtifactBytes`: 1–700000; `maxIntentsPerCall`: 1–1000; `maxLogLines`: 0–1000; `maxLogLineBytes`: 1–4096. |
| `stream` | `maxHz`: 0.01–tickRate; integer `intentsPerTick`: 1–1000. |
| `practice` | Integer `maxTicks`: 1–10000000; `concurrent`: 1–64 per principal. Requires `policy`. |
| `pool` | Integer `maxPublishedPerPrincipal`: 1–1000. Requires `policy`. |
| `chat` | Integer `maxTellChars`: 1–500; `maxSayChars`: 1–280; optional closed-schema `ping`. |
| `pausable` | Object with only optional integer `maxPauseSeconds`: 1–604800. Allows `whenAbsent:"pause"` (§18). |
| `signals` | Requires manifest `signals`. `perSecond`: 0.01–100; integers `burst`: 1–100, `maxOpen`: 1–32, `ttlTicks`: 1–2147483647, `keepTicks`: 0–2147483647. See §22. |

Unknown control modes MUST be rejected rather than silently enabled. A skill contains `{name, description, files}`. Names MUST match `^[a-z0-9]+(-[a-z0-9]+)*$` and be at most 64 code units; descriptions are 1–1024. File keys MUST be relative paths, at most 200 code units, consisting of slash-separated segments matching `[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*`; values are UTF-8 text. `SKILL.md` MUST exist with YAML frontmatter whose `name` matches and whose `description` is nonempty. Names MUST be unique. `<game-id>-reference` is reserved for the generated reference skill; the game id MUST form a valid skill name with that suffix.

The `playerthree-` skill-name prefix is reserved: developer skills using it MUST be rejected. The host serves
`playerthree-commander`, `playerthree-inputs`, and `playerthree-owner`, plus `playerthree-policy-author` only when policy
mode exists. Their workflow content is mode-gated; games own strategy skills and example policies.
`playerthree-commander` states an explicit short order: (1) the core `game_briefing`, whose role doc may name one topic to
read first; (2) with policy mode and policy scope, deploying a working policy for every commanded role next (for a game
declaring starters, a starter by reference: one call, topic `starters`); (3) further topics and skill files (including
the game's strategy skill). It carries no mandatory reading list and no limit on reading.
`playerthree-policy-author` starts with that one-call deploy (a starter by reference, else a minimal script), then improves
it: knobs, practice against the strongest opponent, then a fork into `modules`; it documents policy `include` (§11) and
names the topics that writing code needs at that step. Server instructions state the same order and, with policy mode,
what a policy is (a sandboxed program, one script or modules plus an entry, written or forked and deployed with
`policy_deploy`), where writing one is documented (`playerthree-policy-author`, topic `modes`) and that improving it is how
a seat plays well. They also say when a turn should end: a reply without a tool call ends the client's turn while the
policy keeps playing, so it ends only when the match is over or the seat is genuinely blocked, not to announce a next
step, offer to continue, list non-blocking decisions or report a milestone. The exception is an endpoint
whose seats author policies ahead of play (`McpOptions.authoring`, a benchmark's authoring lobby, policy mode only):
there they state facts without a reading order or play advice: what each tool does, that the core `game_briefing`
indexes every topic and skill, that a policy is a sandboxed program (one script or modules plus an entry) written or
forked and deployed with `policy_deploy`, that starters are complete built-in policies to deploy by reference or fork,
and where writing one is documented (`playerthree-policy-author`, topics `modes`, `observation`, `intents`, `types`).
All default skill content is part of `surfaceHash` and available through both the MCP Skills extension and `game_skill`.

The generated `<game-id>-reference` skill is the briefing topics as files, from the same source as `game_briefing`
topics: `SKILL.md` (at most 8000 code units: purpose, reading order, one line per game topic and per generated topic
family), `RULES.md` (the core rules, tick rate and teams) and one file per topic page, `<topic>.md` and, for later
pages, `<topic>.<n>.md` (path segments outside `[A-Za-z0-9_-]` become `_`), each at most 8000 code units.
Skills clients SHOULD interpret frontmatter with YAML 1.2 typing (for example, `on` is a string, not a YAML 1.1 boolean).

## 4. Agent surface — Implemented

`SeatControl` is the binding-independent operation set. MCP exposes one stable tool per enabled method, with static descriptions and JSON input/output schemas. Unsupported modes MUST NOT be advertised and calls to them MUST fail `mode_unavailable`. Read-only discovery does not grant a disabled mode.

In the following table, `Artifact` means `{runtime:"js"|"wasm", code:string, include?:[string]}` or, js only, `{runtime:"js", modules:{[path]:string}, entry:string, include?:[string]}`, or a starter reference `{from:"<skill>/<path>.js", knobs?:object, runtime?:"js"}`: JavaScript source, base64-encoded core WebAssembly bytes, JavaScript/TypeScript ES modules the host bundles, or one of the game's declared starters built with the given knobs; `include`, `modules` and starters are defined in §11. `Stats` means policy version/runtime, `calls`, `timeouts`, `errors`, `meanMs`, `maxMs`, `intentsEmitted`, `intentsRejected:[{code,count}]`, optional `lastInvalid:{schemaCode,path,expected}` (the most recent schema-invalid intent the policy returned, shaped like the `invalid` ack below), optional `lastError`, and own `logs`.

| SeatControl method → MCP tool | MCP arguments (excluding role) | MCP result / binding distinction |
|---|---|---|
| `briefing()` / `briefing(topic,page?)` → `game_briefing` | `{topic?:string[1..128],page?:int[1..10000]}`; `page` requires `topic` | Core briefing (no topic) or a topic page `{topic,page,pages,text,next?:{topic,page}}`, both described below. |
| `observe(since?,detail?)` → `game_observe` | `{since?:int[0..2147483647],detail?:[Section]\|"all",fields?:[TopLevelObservationKey],page?:int[1..10000]}`; `detail` only for games declaring `observationScope` (unique declared sections) | `{observation, messages?}`, or a page `{observation,page,pages,tick,next?:{page},items?,messages?}` (below); SeatControl returns the whole observation itself. `detail` adds sections rendered in full to the role's defaults (§3 *Observation scope*). |
| `act(intents)` → `game_act` | `{intents:[Intent]}`; 1–min(burst,64) | `{acks:[IntentAck]}` in input order; SeatControl returns the array. In-process act accepts an empty array and at most 64 intents. |
| `sequence(request)` → `game_sequence` | `{steps:[{in:int>=0,intents:[Intent]}],cancelOn?:[EventKind]}` | Sequence acceptance/rejection and per-step acks (§9). |
| `wait(request)` → `game_wait` | `{seconds:number[0..60],until?:[EventKind]}`; at most 16 kinds | In a running match `{phase:"match",tick,outcome,events,messages?,signals?,wake?}`; the agent's entry into its match (the start of its held match, or a seat handed to it mid-match) adds the first `observation` (bounded and paged like `game_observe`; later pages via `game_observe {page}`) and an `instruction`. Before the start the lobby state `{phase:"lobby",seat,match?,you:{ready},startsWhen,instruction,messages?,wake?}` (§4 *Lobby phase*). |
| `ready()` → `game_ready` | `{}` | Marks the agent ready for its pre-match seat; returns the lobby state, or `{phase:"match",you:{ready:true}}` once the match runs. Unseated: changes nothing. Owner rights: `forbidden` (owners use the game's ready). |
| `skill(name,path,offset?)` → `game_skill` | `{name:SkillName,path:string,offset?:int>=0}`; `path` matches the skill file grammar | `{name,path,offset,total,text,next?}`: at most 20000 code units from `offset`, cut just after a newline when the file continues; `next` is the offset to continue at. Unknown file or offset → `invalid`. |
| `policyDeploy(artifact)` → `policy_deploy` | Artifact; which members combine is checked by the host (§11 *Artifact shape*), not the tool schema | `{ok:true,version,probe:Stats}`, `{ok:false,error:PolicyError}`, or approval request (§7). A malformed artifact is `invalid` with `schemaCode`, `path` and `expected`. Concurrent calls queue (§11 *Concurrent deploys*). |
| `policyStatus()` → `policy_status` | `{}` | `{policy: PolicyStatus \| null}`; SeatControl returns the inner value. `PolicyStatus` is current stats or `{version:null}`, with optional `approval` (§7), and `from` and `knobs` when the active version was deployed from a starter (§11); not a list of retained versions. `null` means nothing is deployed and nothing is proposed. |
| `policyRollback(version)` → `policy_rollback` | `{version:int[1..2147483647]}` | Same result alternatives as deploy; reactivates a retained version. |
| `practice(request)` → `practice_run` | `{opponent,ticks,seed?,allies?,artifact?,options?}`; `artifact` takes every `policy_deploy` shape; `options` is advertised as an open `{type:"object",additionalProperties:{}}` whose description points at topic `schema/match-options` | `PracticeResult`: `{ok:true,outcome,ticks,report,policy:Stats,wallMs}` or `{ok:false,code:"policy"\|"guard",policy:Stats,wallMs}`. Ticks 1–maxTicks, seed integer 0–2147483647; opponents/allies declared tiers. The host validates `options` against `manifest.matchOptions` and the artifact's shape: a failure is `invalid` with `schemaCode`, `path` under `["options",…]` / `["artifact",…]` and `expected`. |
| `publish()` → `pool_publish` | `{}` | `{policyId}` or approval request (§7). |
| `policyExport({version?,page?})` → `policy_export` | `{version?:int[1..2147483647],page?:int[1..10000]}` | One page of the caller's own library version as a `playerthree.policy/1` package `{version,hash,bytes,page,pages,text,next?}` (§13.1); SeatControl returns the same page. |
| `policyImport(package)` → `policy_import` | `{package:PolicyPackage}` | `{ok:true,version,stale}`: a new, inactive library version (§13.1). |
| `say(text)` → `game_say` | `{text:string}` | `{ok:true,tick}`. |

`PracticeResult` is discriminated by `ok`. Artifact-load failure uses `code:"policy"`; guarded game-output failure uses `code:"guard"`. Failure MUST NOT fabricate an outcome, tick count or nullable report. Successful reports MUST conform to the game's report schema. Commander `lastPractice` records successful runs only.

Every MCP tool except `game_skill` accepts optional `role`, an enum of manifest roles. With several granted roles, callers MUST supply it except for `game_briefing`, which defaults to the first commanded role. `game_skill` is role-independent and has no role argument. An unheld role yields `forbidden`; missing a required role yields `invalid`, `schemaCode:"missing_field"`, `path:["role"]`.

Knowledge is disclosed progressively. The core briefing (no `topic`) MUST contain `controlPlane:1`, `phase`, `game:{id,version,title,doc,tickRate}`, `seat:{role,roleDoc,team?}`, `teams`, `alliances?`, `roles`, the seat's current `scopes` and `mandate`, `intents` (the kinds this seat's role may send), `topics` (index lines `name — summary`: game topics in manifest order, then one line per generated family, e.g. `intent/<kind> — …`), `skills:[{name,description}]` and `surfaceHash`. It MUST NOT carry JSON Schemas, full intent definitions, modes, match data, report or event schemas. MCP adds `commands:[{role,phase,team?}]` for every currently granted role. Team is omitted in the lobby. Dynamic authorization and mandate data MUST NOT be mistaken for static pinned surface data.

With `topic`, the result is one page `{topic,page,pages,text,next?}`, `text` at most 8000 code units; unknown topics or pages → `invalid`. Game topics serve their `text`. Generated topics (one source with the reference skill, §3): `role/<role>`; `intents` (each kind with roles and first sentence, ack and error codes); `intent/<kind>` (doc, field lines, shape); `observation` (top-level fields) and `observation/<field>` (nested fields); `match-data` (in a match: the seat's guarded bootstrap as `key: JSON` lines, long lists split as `key[i..j]` and objects as `key.sub`, paged; in the lobby: its field docs) and `match-data/fields`; `events`; `report`; `mandate` (explainer, directive and limits fields); `modes` (control modes and limits, opponents, result paging, policy ABI including `include` and `modules`, and one machine-readable line `Surface JSON: {control,opponents,errors,eventKinds,intentRoles}`); `signals` (games declaring signals, §22: kinds, role cards, lifecycle); `starters` (games declaring starters, §11 *Starters*: each starter's path, roles, summary and knobs, and the deploy call); `schema/<name>` (canonical sorted-key JSON Schema text after a header line, paged at line breaks) for `observation`, `match-data`, `event`, `report`, `directive`, `limits`, `match-options` (games declaring `matchOptions`: the full schema of `practice_run.options`, which the tool schema leaves opaque) and `intent/<kind>`; `types` and `types/<role>` (the generated TypeScript declarations of §11 *Generated types* in their compact `docs:"bounds"` form, which keeps bound notes and omits developer prose already served by the other topics, after a header line, paged at line breaks; `types/<role>` narrows `Intent` to that role's kinds). Long generated topics are paged.

In phase `match`, `teams` are the match's sides (manifest order) and the briefing carries `alliances` when the match declares them; in the lobby `teams` are the manifest's declared sides.

In phase `match`, a game declaring `matchData` MUST serve guarded `matchData`, obtained from adapter `matchData(seat)`, as the `match-data` topic; lobby `match-data` documents fields only. It is dynamic match data, not static pinned surface content, and MUST pass the same snapshot, schema and own-text guards as observations.

`game_observe` bounds its result: when `{observation, messages?}` would exceed the result budget, the endpoint snapshots the (optionally `detail`-widened and `fields`-filtered) observation per credential and role, splits it into pages of whole JSON (top-level keys in schema order; plain nested objects by key; lists by items, with `items` giving each split list's `{from,to,of}`) and returns page 1 with `page`, `pages`, `tick` and `next`. `{page:n}` (n ≥ 2) returns page n of that same snapshot however old (its `tick` says so) until the next unpaged call replaces it; without a snapshot or past its end → `invalid`. `fields` lists top-level observation keys (closed enum). Policies and bots always receive whole observations, at their own detail (§11; bots: every section).

### Results and errors — Implemented

Successful MCP calls MUST provide validated `structuredContent` and a text content. The text is the JSON serialization of `structuredContent`, except: a topic page is its raw `text` (not JSON-escaped), followed when the topic has several pages by a line `[page p/n — next: game_briefing {"topic":…,"page":p+1}]` (last page: `[page n/n — end of topic]`); a skill window is its raw `text`, followed when the file continues by `[… continues: game_skill {"name":…,"path":…,"offset":N}]`; an observation page is its JSON followed by a line naming the next `game_observe {"page":…}`. Every default tool result text MUST be at most `RESULT_TEXT_MAX` = 24000 code units. A result inconsistent with its output schema MUST become `internal`, never unvalidated output. Tools MUST declare `openWorldHint:false`; briefing, observe, wait, skill, and policy status are read-only. Tool-level errors have `isError:true` and JSON text `{"error":"<code>"}`. Validation errors MAY additionally contain `schemaCode` and `path`; failures the host checks beyond the tool schema — an artifact's shape (§11 *Artifact shape*), a starter reference (§11 *Starters*) and match options — MUST carry `schemaCode`, `path` and `expected`, and the MCP error result MUST carry all three.

Closed tool codes are `bad_message`, `bad_token`, `forbidden`, `mode_unavailable`, `out_of_scope`, `approval_not_found`, `approval_pending`, `approval_failed`, `rate_limited`, `invalid`, `busy`, `internal`, `not_in_match`, `paused` (a held match before its first tick, or a paused session, §18), and MCP-only `consent_declined`.

An `IntentAck` is `{ok:true}` or `{ok:false,code:...}`. Failure codes are `invalid` (also `schemaCode,path,expected`), `forbidden_role`, `out_of_scope`, `rate_limited`, `not_controller`, `game_over`, `signal` (also `signalCode`, games declaring signals, §22), or `game` (also `gameCode`, from manifest errors). Host-internal failures MUST remain closed; they MUST NOT expose exceptions or rejected input. Schema codes are exactly `type`, `enum`, `range`, `not_integer`, `pattern`, `too_long`, `unknown_field`, `missing_field`, `tag`. Paths contain developer field names, nonnegative array indices, or `?` for an unknown field, never the rejected key or value.

`expected` names what the schema wanted at `path`, in the vocabulary of the generated declarations (§11 *Generated types*): a type reference, `: `, then the expected type on one line, for example `MoveIntent["units"][number]: \`e_${number}\`` or `MoveIntent["x"]: number (integer 0..63)`. The reference is the intent's generated type name followed by `["field"]` per field and `[number]` per list index of `path`; a failing `kind` refers to `IntentKind`, an unknown field to its enclosing object, whose type lists only field names (`{ kind; units; x? }`), and a union to its tag values. It is derived only from the manifest and `path`, never from the rejected value, and is at most `EXPECTED_MAX` = 512 code units, cut after the last whole union member that fits and ending `| …`. Match options use the same form rooted at `MatchOptions` (`MatchOptions["cells"][number]: number (integer 0..255)`; a game without options: `MatchOptions: never`); artifact shapes root at `Artifact` (§11 *Artifact shape*); starter knobs at `Knobs` (§11 *Starters*).

### Tool-surface budget — Implemented

Every model turn carries the whole tool list, so the tool surface is the always-on part of progressive disclosure: each tool states what it does and one example, and details live in topics and skills fetched on demand. Sizes are UTF-16 code units of compact JSON (`JSON.stringify(x).length`; a description: its own length). The surface MUST satisfy:

| Constant | Limit | Measure |
|---|---|---|
| `TOOL_DESCRIPTION_MAX` | 1500 | each tool's description |
| `TOOL_INPUT_SCHEMA_MAX` | 48000 | each tool's inputSchema |
| `TOOL_OUTPUT_SCHEMA_MAX` | 70000 | each tool's outputSchema |
| `TOOL_SURFACE_MAX` | 120000 | model-facing total: the sum over tools of name + description + inputSchema |

The limits were set from the reference game (Agent Command: largest description 1340 for `game_wait`, inputSchema 41988 for `game_sequence`, outputSchema 61931 for `game_wait`, model-facing total 109270) with 10–15% headroom, so it passes and a regression such as an inlined options schema (150040 before `schema/match-options`) or a paragraph-long description fails. Generating the surface for a game over any limit MUST fail with an error naming the tool, the measure, the size and the limit, so no host, surface hash or MCP mount exists for it. A game's intents ride in `game_act` and `game_sequence` (every kind's doc and params), and its observation and events in the `game_observe` / `game_wait` output schemas; those are the largest parts of a surface and the first candidates for further disclosure.

### Surface pinning and sessions — Implemented

`surfaceHash` is lowercase hexadecimal SHA-256 of canonical UTF-8 JSON covering control-plane version, the complete manifest, generated tool definitions, all served skills (including the generated reference and SDK defaults), and session/role-routing semantics. Canonicalization MUST recursively sort object keys, preserve array order, omit absent object members, and use compact JSON encoding. Reference hashes include complete tool records (`name`, `method`, `title`, `description`, input/output schemas, annotations), not just tool names. Equivalent behavior with different static documentation MAY have a different hash. Hosts MUST keep the surface static for their lifetime; clients SHOULD pin it and reject unexpected changes. MCP carries the hash in `_meta["dev.playerthree/surfaceHash"]` on tool listings and call results.

Agent sessions have two phases; these are game phases, not MCP transport sessions:

| Phase | Required behavior |
|---|---|
| `lobby` | Before the match a seat is in starts: nothing seats a commander yet (between matches), a game lobby reserved a seat for its next match, or the agent's match is held before its first tick (ready check, `holdStart`). Briefing has no team while nothing seats the agent. Observe and wait return the lobby state; act and sequence fail `not_in_match` without a seat and `paused` in a held match. Skills, library deploy/status/rollback, practice, publish, and owner chat work when their modes/scopes allow. Wait uses wall time. |
| `match` | The match runs. Calls route only to the commander's live seat. Wait uses game time and can wake for visible requested events, game end, owner messages, or approval changes. Deploy/rollback update the persistent library as well as the live seat. |

A named commander ID MAY occupy several compatible role seats only in one live match on one team, with exact per-role execution, wait, inbox and approval lanes. It MUST NOT occupy or be reserved on two teams (allies included) or concurrent live matches: `createMatch` fails `invalid`, `assign` and `commanders.reserve` fail `busy`. New assignments fail atomically rather than steal routing. Distinct named IDs MAY support identical roles and occupy opposing/concurrent sessions with declared independent isolation. On release/outcome/disposal, the affected lanes return to their commander's lobby. A per-match seat token has no lobby.

**Same-owner opposition.** `PlayerThreeMatch.sameOwnerOpposed` becomes true, and stays true for the rest of the match, once one owner holds played seats (a human hold, `kind:"agent"` or `kind:"policy"`; bot and hold seats are not played) on two teams that are not allies. Such a match is that owner's own practice: the host MUST NOT record its outcomes in commander win/loss/draw counts or pool policy records (receipts and outcomes are still delivered), and its session record carries `sameOwnerOpposed:true`; a rating or ranking MUST NOT count a marked match.

If no wait is in flight, the first newly seated result, the start of a held match and the terminal ended result are
retained for a subsequent wait, once each, so a transition between calls is not lost: a lane remembers the match its
agent last saw (any session of that lane — MCP calls are stateless). Retained transitions MUST NOT preempt or swallow
unread owner messages; owner-message delivery retains its priority and consume-once semantics.

### Lobby phase — Implemented

The **lobby state** is `{phase:"lobby",seat,match?,you:{ready},startsWhen,instruction}`. `seat` is `{team,role}` once a game lobby reserves a seat or a held match seats the agent, else `null`. `match` is the game's guarded pre-match summary (manifest `lobby`, a closed `t.obj`; e.g. map, layout and rules summary), supplied per reservation or per match (`createMatch({lobby})`). `startsWhen` is `{kind,inSeconds?}`: `seat` (nothing seats the agent), `host` (the lobby's host or the game starts it), `ready` (once every seat is ready, or at the deadline), `countdown`; `inSeconds` is the wall-clock time left when known. `instruction` is static host text naming the next step: for a commander lane no match seats yet (unseated, or reserved by a game lobby) whose role may deploy (policy mode and `policy` in its scopes) while it has no active policy and no pending approval, it is the *no policy* text (`LOBBY_INSTRUCTIONS.noPolicy`: no policy is active for this role, deploy one first — a starter is one call, `policy_deploy {from}`, topic `starters` — then ready and wait as usual), reserved and ready or not; otherwise it names the unseated, seated or ready next step. The manifest's observation MUST NOT declare a top-level `phase` field (it marks the lobby state).

The protocol is: seated, read the briefing, call `ready`, then `wait` until `phase` is `match`. A wait blocks up to its `seconds` of wall time and returns the lobby state at a timeout, an early wake (owner message, approval), or a new or changed seat (an unready agent seated into a held match learns its seat at once); the moment the match starts it returns the **match entry** `{phase:"match",tick,outcome,events:[],observation,instruction}` with the seat's first observation. A seat handed to an agent mid-match (`PlayerThreeMatch.assign`) also returns its entry at once.

Readiness is the agent's own declaration: an agent seat is `absent` without presence, `online` while present but not marked ready, and `ready` once marked (in a running match presence suffices). A game lobby reserves a commander lane with the trusted `commanders.reserve(owner,id,role,{team,match?,start:{kind,at?}} | null)`; it never seats anything by itself, and a reservation on a team other than one of the commander's other reserved lanes fails `busy` (release those first). The ready mark belongs to the reserved seat: it survives summary or start updates, resets on a different seat or clearing, carries into the held match that seats the lane at that seat (and back to the reservation when that match is disposed before starting), and the reservation ends with the lane's match. `CommanderStatus.reservations` lists `{team,role,ready}` per reserved lane. A held match's start description is the trusted `match.setLobbyStart({kind,at?} | undefined)`; by default `ready` with the ready-check deadline, or `host` for `holdStart()`. Seating a lane wakes its lobby waits on a microtask, after the game's synchronous `holdStart()`.

### Mid-match seat assignment — Implemented

`PlayerThreeMatch.assign(assignment)` (trusted, game-authenticated owner; the `createMatch` assignment shape) re-assigns one seat before the start or mid-match at the current tick boundary, and is recorded as a seat change. Everything that can fail is validated first (atomic): the seat's team must still play, a commander must be on the owner's roster with the role and kind, one owner's agent commanders on different teams need independent sessions (`forbidden`), a commander live elsewhere is `busy` (several roles of one team in the same match are allowed), a policy seat needs a pool entry or a commander version. Then the previous occupant is detached: its commander lane returns to the lobby and its in-flight waits return the unseated lobby state, its exact-seat credentials and (unless the same human keeps the seat) human credentials stop authenticating, control planes made for it fail `bad_token` and no longer count as the seat's presence, and its sequence, pending approval, inbox, ready mark and seat policies end. The new occupant takes the seat at once: a commander gets the seat's lease (its library and settings, as at match creation) and its agent's next wait returns the match entry; other kinds take the seat's default mandate and scopes. Re-assigning the same occupant is a no-op; `invalid` once the seat's team is out, the match is over or its bindings were released. The session record's ownership follows the latest owner.

**Owner control.** An assignment MAY set `ownerControl:true`: the owner of an initially automated seat (agent, policy, bot or hold) then holds it as a human, exactly as a `kind:"human"` assignment does (human token, owner operations). A lobby records `ownerControl` per slot and passes it unchanged. An owner holding a broader view of the session MUST NOT receive it (`forbidden`). Re-assigning the seat to the same owner keeps the human hold; a different owner drops it unless that assignment grants it again. Every intent the host delivers carries its trusted `source` (`owner`, `agent`, `policy`, `bot`, `fallback`); an `owner` intent also carries `ownerRoles`, the roles of that seat's team whose current assignment the same owner holds as a human (always including the acting seat), or only the acting seat's role when the seat is not human-held. Games scope owner-wide authority (e.g. a shared-resource priority) to `ownerRoles`, never to the owner's identity.

The reference MCP binding uses revision `2026-07-28`, stateless Streamable HTTP with SDK fallback for older clients; it does not require a game transport connection. Skills are also served through `io.modelcontextprotocol/skills`, including file size and SHA-256 digest, at `skill://<game-id>/<skill>/...`. Long wait/practice calls with a progress token emit progress every second. The MCP tasks extension is not used. Static lists use `ttlMs:3600000`, `cacheScope:"private"`. Bindings MUST NOT add sampling or roots access.

The optional game transport carries `playerthree:call` with `{op:"call",seq,role,method,args}` and `playerthree:result` with `{op:"result",seq,ok:true,data}` or `{op:"result",seq,ok:false,code}`; observe `args` are `{since?,detail?}`. It also carries stream (`{op:"stream",seq,role,everyTicks,detail?}`), view, observation, seats, report, controller, mandate, mint, approval-resolution, tell, and said operations. Only authenticated owners MAY change controllers/mandates, resolve approvals, mint seat tokens, or send owner messages. Spectators receive selected teams' fogged views, not agent/owner rights.

Team views travel as a **view stream** per match team. Version `n` of a team's stream is that team's guarded view at the `n`-th view push (periodic views with their omitted static top-level members carried over, so every version is a complete view). `playerthree:view` carries either `{op:"view",team,version,view}`, a keyframe (the full view at `version`), or `{op:"view",team,version,delta}`, an `playerthree/delta` structural delta from `version - 1` of the same team's stream. Deltas are computed only from consecutive versions of that team's own guarded view, never from another team's view or unguarded state, so they disclose nothing the keyframe would not. A reader gets a keyframe when it joins, when it starts watching a team, and when it is more than a bounded batch of versions behind; otherwise it gets every newer delta of that team, in order. Every message is built once and shared, byte for byte, by every reader of that team. Over the ordered transport a reader never sees a gap; a delta whose `version` is not exactly the reader's version plus one is a protocol error: the reader MUST discard that team's state and rejoin for a keyframe. The host computes a team's stream only while something subscribes to it (`match.onView(team,listener)`, notified with each new version); `match.viewMessages(team,after?)` returns the messages that bring a reader at version `after` (none: a fresh reader) up to the latest version. `match.view(team)` remains a fresh guarded snapshot outside the stream.

Views are pushed at `viewHz`, at most once per step: a step of several ticks (accelerated room stepping, fast-forward) adds one version on its last tick, so a reader never receives game ticks no realtime client could have seen. A version is added only when the view changed. Unchanged subtrees keep their identity in the reader's rebuilt view, so readers MUST treat views as immutable.

Mandate updates use `playerthree:mandate` with `{op:"mandate",seq,role,mandate}`; the in-process equivalent is `match.setMandate(team,role,mandate)`. Approval resolution uses `playerthree:resolveApproval` with `{op:"resolveApproval",seq,role,id,approve}`, equivalent to `match.resolveApproval(team,role,id,approve)`. There is no standalone directive operation. Seat information and replay seat changes carry the whole mandate; the trace kind is `mandate`.

Live scope updates use `playerthree:scopes` with `{op:"scopes",seq,role,scopes}`, equivalent to
`PlayerThreeMatch.setScopes(team,role,scopes)`. `SeatInfo.scopes` exposes current live permissions.
Only owners may replace scopes; every agent credential for the seat, including per-match tokens, follows them.
Revoking `act` cancels the seat's scheduled agent sequence.

## 5. Credentials and consent — Implemented

| Credential | Authority and lifecycle |
|---|---|
| Seat token | One seat in one match; owner-minted, follows the live seat's scopes, invalid after the match is disposed. It cannot become an owner or spectator credential. |
| Commander token | One named commander ID, persistent across matches; isolated library/practice/docs and exact per-role lanes on one live match/team. Rotation MUST revoke the old token immediately, including live use. |
| Sign-in connection | OAuth connection for one selected named commander and a granted subset of compatible roles; live calls route only its exact lease. Role edits and revocation MUST apply on the next call. |

Seat and commander bearer tokens are opaque 32-character base64url strings (24 bytes), not user identity. Invalid, expired, rotated, revoked, owner, and spectator credentials MUST NOT authenticate to the agent endpoint. Agent credentials MUST NOT mint credentials, grant roles, modify scopes or mandate, or change controllers. Owner identifiers MUST remain opaque and MUST NOT be sent to agents or opponents. The game, not PlayerThree, authenticates owners.

The trusted consent surface is the **game's authenticated consent page**, not an agent conversation. OAuth selects a named commander and compatible roles; it does not let the harness self-grant action scopes. Multiple same-role connections MUST remain independent: matching owners, clients, providers or roles MUST NOT merge identities or steal grants. Consent SHOULD show the selected name, requested harness, verified metadata domain where available, granted roles/modes, and return destination; self-asserted names MUST NOT appear verified.

Each approved consent creates an independent connection with `commander` identifying the selected named entry. `createdAt` and `authorizedAt` record creation and authorization times. `ConnectionStatus.active` and browser `ConnectionInfo.active` mean current connection activity, not existence of a saved sign-in. Old owner-role/client storage has no migration path; operators reset it.

MCP authorization MUST follow MCP's authorization specification: OAuth 2.1, RFC 9728 protected-resource metadata in the `401` challenge, RFC 8414 authorization-server metadata, PKCE `S256` only, RFC 9207 `iss`, public clients, and resource-bound tokens. Redirect URIs MUST match exactly except RFC 8252 loopback ports. Production endpoints MUST use HTTPS. Client ID Metadata Documents MUST be fetched only from vetted public HTTPS addresses, without redirects, within 5 seconds and 5 KiB, with matching `client_id`; dynamic registrations MAY use HTTPS or loopback redirects. Loopback development exceptions MUST be explicit.

Authorization codes are single-use and live 60 seconds; replay revokes the credentials they produced. Access tokens live one hour and bind to the MCP endpoint. Refresh tokens live 30 days, rotate on use, and reuse revokes the connection. Revocation uses RFC 7009. The game SHOULD rate-limit OAuth endpoints by IP. Token fallback uses consent elicitation where supported; otherwise deliberate installation with a seat/commander token counts as implicit consent. A declined elicitation MUST fail `consent_declined`.

## 6. Scopes — Implemented

The closed vocabulary is `act`, `policy`, `practice`, `publish`, `say`.

| Scope | Required for |
|---|---|
| `act` | `act`, `sequence`, stream-mode intents |
| `policy` | `policyDeploy`, `policyRollback` |
| `practice` | `practice` |
| `publish` | `publish` |
| `say` | `say` |

`briefing`, `observe`, `wait`, `skill`, and `policyStatus` require no action scope (but their mode, authentication, and phase restrictions still apply). Scope checks MUST occur server-side for every credential and binding. A mode absent from the game MUST fail `mode_unavailable`; a supported mode outside the seat's scopes MUST fail `out_of_scope`. Per-intent scope rejection uses `{ok:false,code:"out_of_scope"}`.

Scopes are owner-set in `CommanderSettings.scopes`, per named commander, not per owner-role or harness. They apply to that commander's tokens/connections and per-match tokens accessing its live seat. Defaults include every scope supported by the game's modes; owner-minted tokens do not bypass later restrictions. Consent MUST NOT silently override scopes.

## 7. Mandate — Implemented; per-intent approval Proposed

The owner assigns:

```json
{"autonomy":"autonomous","directive":{},"whenAbsent":"policy"}
```

`autonomy` MUST be `autonomous` or `supervised`; `directive` MUST conform to `manifest.directive`; optional `limits` MUST conform to `manifest.limits`; `whenAbsent` MUST be `policy`, `bot`, `hold`, or `pause` only when `control.pausable` exists. Commander identity is `{id,name,kind,roles,isolation,metadata?}`; `kind` is only `agent` or `policy`, never permanent human/bot/none preferences. Settings are `{botLevel,scopes,mandate}`. `CommanderSettingsPatch` permits partial mandate updates; validated updates reach only that commander's exact live seat and subsequent briefings/`setSeatInfo`. Built-in bot configuration remains separate from named connections.

Autonomous agents MAY act without asking within scopes, game rules, and mandate limits. Under supervised autonomy, `policyDeploy`, `policyRollback`, and `publish` MUST NOT activate/publish immediately: they return `{ok:false,approval:{id,kind,version}}`, where `kind` is `policyDeploy`, `policyRollback` or `publish`. Each exact commander lane has at most one pending request; the newest replaces it. Owners resolve through `commanders.resolveApproval(owner,commanderId,id,approve)` or exact-seat `match.resolveApproval(team,role,id,approve)`. Stale/missing identifiers fail `approval_not_found`; in-progress resolution fails `approval_pending`; resolution failure can yield `approval_failed`. Existing active policy remains unchanged merely because a proposal was submitted or rejected.

`Approval` is `{id,kind,version,status}`; `ApprovalRequest` requires `{id,kind,version}`. Deploy proposals pin the proposed next version; if it is no longer the next version at resolution, approval fails with `approval_failed`. Rollback and publish expose their target version. Status is `pending`, `approved`, `rejected` or `failed`. `policyStatus()` returns `null` when there is neither policy nor approval; otherwise it returns policy stats or `{version:null}`, with optional `approval`. MCP wraps this as `{policy:...}`. Waits wake with `wake:"approval"` and callers read status for the outcome. `policy_status` does not enumerate retained versions: callers record successful deploy version numbers or use the owner's library UI to choose a rollback.

Mandate gameplay limits are not a generic policy sandbox feature: the **game MUST enforce them in `apply`**, returning a declared game error code. The host MUST propagate them to the adapter. Agent guidance MUST say to follow the seat's mandate, not universally demand permission-free play. Agents SHOULD deploy a working policy promptly for each commanded role when allowed, and keep the wait/observe monitor loop running while a match is live.

**Proposed:** per-intent human approval for turn-based games. Supervised autonomy currently gates artifact deployment/rollback/publication, not every `act` or sequence. Scopes MUST be used to disallow direct acting when desired.

## 8. Presence and whenAbsent — Implemented

Controller values are `human`, `agent`, `policy`, `bot`, `none`. Assigned controller and liveness are distinct: an `agent` kind commander MUST remain controller `agent` from tick 0, including when absent. Hosts MUST NOT relabel it merely because fallback is running.

An agent is **present** if it has made a call within 30 seconds, has a call in flight (including a blocked wait), or has an active sequence. Seat liveness is `SeatInfo.agentActive`; sign-in connection activity is `ConnectionInfo.active`. A stored sign-in connection alone is not activity.

| Assigned controller / presence | What acts |
|---|---|
| `agent`, present | Authorized agent intents and its deployed policy. |
| `agent`, absent, `whenAbsent:"policy"` | Deployed policy; otherwise fallback bot at the seat's `botLevel`. |
| `agent`, absent, `whenAbsent:"bot"` | Fallback bot; deployed policy paused. |
| `agent`, absent, `whenAbsent:"hold"` | Nothing; deployed policy paused. |
| `agent`, absent, `whenAbsent:"pause"` (pausable games) | The whole session stands still until the agent is present again (§18); after `maxPauseSeconds`, as `policy` until the agent returns. |

The host MUST choose presence/fallback behavior at the beginning of a tick's thinking phase and use that decision consistently for the tick. Fallback intents MUST pass a dedicated validated gate; absence MUST NOT grant general bot authority to agent input. Ready checks continue waiting for agent presence until their configured deadline or explicit owner start; `readySeconds` is at most 600.

## 9. Input tiers — Implemented

**Intent:** `act(intents)` applies semantic commands through schema, role, scope, controller, rate, and game-rule checks. Acks correspond to input order and MUST NOT echo input. Stream mode uses the same authority checks, pushes observations no faster than `maxHz`, and caps intents per tick. A stream subscription uses `everyTicks`; zero stops it. Its optional `detail` (as `observe`'s, §3 *Observation scope*) applies to every pushed observation; unknown sections are `invalid`.

**Sequence:** a finite plan of `{in,intents}` steps, where `in` is an integer number of ticks from submission, at least zero. `control.sequence` declares maximum steps, maximum horizon, and minimum spacing in ticks. The host MUST validate the whole plan's shape, roles, and scope before scheduling any step; rejection MUST schedule nothing. Acceptance returns `{ok:true,id,acks:IntentAck[][]}` with an opaque string ID. Rejection returns `{ok:false,code:"invalid"|"out_of_scope"|"not_controller"|"game_over",acks:IntentAck[][]}`; per-step acks identify invalid intents where available. Malformed MCP arguments MAY instead fail as tool-level `invalid`. Scheduling acceptance does not promise later game-rule success.

A seat MUST have at most one active sequence. A valid replacement supersedes it; empty `steps` cancels. Due intents MUST pass the agent gate before the due tick's `step()` and be recorded as ordinary replay intent entries when they reach `apply`. The host MUST drop steps if the controller is no longer `agent`. `cancelOn` contains only declared event kinds and MUST cancel on the first such event visible to that seat, never on hidden events. Length, horizon, and spacing limits MUST be enforced. Sequences have no conditionals; use a policy for conditional behavior.

Steps MUST be strictly ordered by `in` and obey minimum spacing. Each MCP step has 1–`min(control.intents.burst,64)` intents; the in-process method allows zero through 64. `cancelOn` kinds MUST be declared and unique; MCP additionally caps the list at 16. Empty `steps` cancels rather than scheduling an empty plan.

**Policy:** code maps guarded observations to intents at configured tick cadence, without an LLM call each tick. It MUST remain sandboxed and its outputs MUST be treated as untrusted. An active policy does not confer authority beyond its seat, controller, game rules, or mandate.

## 10. Adapter contract — Implemented

The game provides `create({seed,options?,teams,alliances?})`, returning a match with manifest and monotonically increasing integer `tick`. `teams` is always passed: the match's sides, a nonempty subset of manifest `teams` in manifest order. `alliances` (`{[allianceId]: team[]}`, a partition of `teams`) is passed only when the match declares them. A game that cannot play a given side set MUST throw. Practice-capable games also provide built-in `createBot(seat,opponent)` whose `think(observation)` returns intents. The implemented running adapter has eight core calls plus schema-dependent match bootstrap and the optional hooks below (developer snapshot, observer view, checkpoint clone, rank, end, signal limits, forfeit); `team` parameters identify sides, including the single side of a solo game:

| Call | Required result / effect |
|---|---|
| `step()` | Advance one simulation tick synchronously; return no data. |
| `outcome(team)` | `win`, `loss`, `draw`, or `running` for the side; solo games define these outcomes against their own objectives. |
| `view(team,{snapshot}?)` | `manifest.view` data, restricted to that side's perspective. `snapshot:true` is the initial view; periodic views MAY omit schema-optional *top-level* members whose value is static for the match (for example match bootstrap data). An omitted top-level member means "unchanged", never "removed": every other top-level member MUST be present in every periodic view. |
| `observe(seat,sinceTick,detail)` | `manifest.observation`, seat-focused and fogged; include only relevant events newer than `sinceTick`. `detail` lists the sections to render in full, in manifest `sections` order (empty for a game without `observationScope`); the rest are the game's summaries. Match bootstrap data is delivered separately, never injected into observations. |
| `apply(seat,intent,context?)` | `{ok:true}` or `{ok:false,code:<manifest error>}`; enforce game legality and mandate limits. `context` is the trusted `{source,ownerRoles?}` (§4 *Owner control*). |
| `report(team)` | `manifest.report` for that side, including game-specific solo-run scores or accomplishments. |
| `events(seat,sinceTick)` | Visible events with `tick > sinceTick`, oldest first, each matching `manifest.event`. |
| `setSeatInfo(seat,{controller,mandate})` | Update controller disclosure and owner instructions/restrictions known by the game. |
| `matchData?(seat)` | Immutable seat-visible bootstrap data conforming to `manifest.matchData`; REQUIRED when that schema is present. |
| `debugView?(): unknown` | Optional bounded, JSON-compatible unfogged developer snapshot, never an agent/player payload. `PlayerThreeMatch.debugView()` forwards it or returns `null` when unsupported. |
| `observerView?(): unknown` | Optional omniscient observer data conforming to `manifest.observer`; required for omniscient observer grants (§20.9). |
| `clone?()` | Optional independent copy of the running game (state and RNG) for DevTools replay checkpoints and persistent-session checkpoints (§18). |
| `rank?(team): number` | Optional final placement, read once every match team is final: standard competition ranking (1,2,2,4) counted over alliances and lone teams; allies share a rank. Absent or invalid → the host ranks by outcome (win > draw > loss). |
| `end?(outcomes, ranks)` | Optional: adopt host-declared final outcomes and ranks (per match team) so the game's own outcome, views and reports agree. Without it the host still reports the declared outcomes. |
| `signalLimits?(): SignalLimits \| null` | Optional, games declaring signals (§22): this match's signal limits, each at most the manifest's `control.signals`, or `null` for signals off in this match. Read once when the match or a replay of it is created; an out-of-range value fails creation. |
| `forfeit?(team)` | Optional: the match team concedes (`PlayerThreeMatch.forfeit`); take it out of play while the others play on and report its final outcome from `outcome(team)` once the game decides it (at once or at a later step). Called before `step()` of the current tick, at most once per team and only while its outcome is not final; recorded in replays, so as deterministic as `apply`. Without it `PlayerThreeMatch.forfeit` fails `invalid`. |

**Per-team terminal rule.** The host keeps the first final outcome (`win`/`loss`/`draw`) the game reports for each match team; later changes are ignored. A final team is out — its intents fail `game_over`, its bots/policies stop, its waits return, commanders and pool record it — while the other teams play on. The match is over once every match team is final; ranks are then fixed (`PlayerThreeMatch.rank(team)`, `null` until over). A game that decides all its teams on the same tick (any duel) therefore ends exactly when it did before; a game MUST report a team final only when that team is out of play.

`PlayerThreeMatch.end(spec)` declares final outcomes. `spec` is `'draw'` (teams already out keep their outcome; the rest draw), `{[teamOrAllianceId]: 'win'|'loss'|'draw'}`, or `{[teamOrAllianceId]: placement}` (a valid competition ranking: a single first-placed unit wins, a shared first place draws, the rest lose). An alliance key covers its members; every match team MUST be covered, allies MUST agree, and a declared outcome contradicting a team's kept outcome fails `invalid`, as does any other shape. It is a no-op once the session is over. It calls adapter `end?(outcomes, ranks)`, stops the clock, fires `onEnd((outcomes, ranks) => …)` and the `match_ended` trace (with `ranks`), returns pending waits, and the outcomes and ranks are recorded in the replay. A failing adapter `end` does not keep the session running. `PlayerThreeMatch.over` is true once every match team is final, by the game or by `end()`. A persistent session (§18) has no outcome: `end()` fails `invalid` and `over` stays false.

`PlayerThreeMatch.forfeit(team)` lets one match team concede while the session continues for the others (a player leaving, kicked or not recovered). The host records it at the current tick — the replay entry `[tick,team,role,"forfeit"]`, whose `role` is always the manifest's first role (the entry is team-level), and the trace event `forfeit {team}` — then calls adapter `forfeit?(team)`. The team's outcome turns final when the game reports it, and the per-team terminal rule applies as for any team that is out; when the forfeit leaves the game deciding every team, the session is over as usual. It is a no-op once the team forfeited, its outcome is final or the session is over; it fails `invalid` for a team outside the match, a game without the hook, and a persistent session (§18, no outcome).

Inputs and outputs MUST have JSON-compatible meanings, even if implemented as native structs. Adapter calls MUST be synchronous with respect to a tick; hosts MUST finish awaited policy work before stepping. An engine MAY own the clock: create a non-realtime match and invoke host `match.step(n)` instead of running the host timer. Adapter `step()` itself is distinct from this potentially asynchronous host operation.

The host MUST snapshot and guard `adapter.matchData(seat)` against `manifest.matchData` before supplying it separately to each fresh policy or built-in bot instance. Bootstrap JSON is capped at 131072 UTF-8 bytes (`MATCH_DATA_MAX_BYTES`), independently of observation input; existing observation caps MUST NOT be increased to accommodate bootstrap. An oversized or invalid bootstrap MUST fail closed. JavaScript policies receive it through optional synchronous `init(matchData)`; WASM policies through optional `init(ptr,len)`, with checked UTF-8 JSON bytes allocated using `alloc`. Without declared match data the initialization value is JSON `null`. Built-in bots MAY implement synchronous `init(matchData)`; the host MUST call it before their first `think`. Deployment probes (including the lobby), restored/reloaded policies, practice, benchmarks and crash restarts MUST initialize every fresh instance. Agents obtain the same guarded data through their match briefing. Every observation, including the first and stream observations, remains the game's dynamic observation; the host MUST NOT merge bootstrap data into it.

Determinism is an opt-in capability: a game claiming deterministic replay MUST reproduce the same simulation for the same game version, seed, options, and ordered applied inputs/seat changes. Live-only integrations MUST NOT claim deterministic replay merely because they record inputs. Headless practice similarly requires the game to support independent simulated matches. This version does not assign new manifest keys for advertising these engine capabilities.

Replay envelopes use `format:"playerthree.replay"`, `version:2`, `game`, `gameVersion`, `seed`, optional `options`, `teams` (the match's sides), optional `alliances`, `ticks`, `entries`, `outcomes`, optional `ranks` (once over), and (persistent sessions, §18) optional `window:{from,dropped}`. Replay execution creates the game with the recorded `teams`/`alliances`. Entries preserve tick and recording order, including every intent reaching `apply` (even game-rejected intents), controller/mandate seat changes, pause/resume transitions (§18), accepted team signals (`[tick,team,role,"signal",intent]`, §22) and team forfeits (`[tick,team,firstRole,"forfeit"]`, re-applied through adapter `forfeit` before `step()` of that tick; replay execution rejects any other shape, a second forfeit of the same team, and a game without the hook). Replay MUST NOT include owner chat or third-party policy text. **Proposed:** a sidecar carries these eight calls over a local socket or stdio without weakening their semantics (§20.8).

Intent entries are `[tick,team,role,"intent",intent,source]`, six fields, for `agent`, `policy`, `bot` and `fallback` sources, and `[tick,team,role,"intent",intent,"owner",ownerRoles]`, seven fields, for `owner` intents: `ownerRoles` is the scope delivered with the intent, without duplicates, containing the entry's role and only manifest roles. Replay execution re-delivers the recorded context and rejects any other shape (`invalid intent source`, `invalid owner roles`); an owner entry without `ownerRoles` is malformed, never read as seat-local.

Replay execution MUST reject a `gameVersion` different from the current manifest version. The reference error is
`playerthree/replay: game version mismatch`.

## 11. Policy ABI — Implemented

The detailed runtime contract is [Policy ABI](../docs/POLICY_ABI.md). Policy-runtime implementers MUST follow that ABI, including its resource limits and error meanings; the host language need not be JavaScript.

| Runtime | Entry points |
|---|---|
| `js` | Classic script with global synchronous `think(obs) -> intent[]`, optional `init(matchData)`, optional global `detail`, provided `log(...args)`. No module imports. |
| `wasm` | Core module exporting bounded 32-bit unshared `memory`, `alloc(i32)->i32`, `think(i32,i32)->i64`; optional `init(i32,i32)->()`; optional custom section `playerthree.detail`. Only optional import is `env.log(i32,i32)->()`. |

For WASM, the host writes UTF-8 JSON observation bytes into `alloc(len)`'s checked region. `think(ptr,len)` returns unsigned packed `(outPtr << 32) | outLen`; the checked output region MUST contain a UTF-8 JSON intent array. WASI, imported memory, other imports, shared/64-bit memory, unbounded memories/tables, and GC heap types are forbidden.

JS artifacts MAY carry `include:["<skill>/<path>", …]` (at most 16 distinct entries) naming served skill `.js` files (`policy_deploy` and `practice_run.artifact`). The host composes the source as the included contents joined by `\n`, then `\n`, then `code` (`composePolicy(skills, code, include?)`); unknown or non-`.js` entries, or `include` with `wasm`, are `invalid`. Size limits apply to the composed source, and the composed source (never the list) is what is probed, stored, versioned, published and hashed.

A JS artifact MAY instead carry ES modules: `modules:{"<path>":source,…}` and `entry:"<path>"`, without `code` (`policy_deploy`, `practice_run.artifact`). Module paths follow the skill file-key grammar (§3), are at most 200 code units, end in `.js`, `.mjs`, `.ts` or `.mts`, and their first segment MUST NOT name a served skill; `entry` MUST be one of them. At most `POLICY_MAX_MODULES` = 64 modules are allowed, with at most `POLICY_MODULES_MAX_BYTES` = 1048576 UTF-8 bytes of source in total, checked before bundling. The host bundles them into one classic script with esbuild (`buildPolicy`, pinned esbuild version, no author-supplied plugins, no filesystem, network or package resolution): TypeScript types are stripped without type checking; static `import` and `export … from` specifiers MUST be relative (`./`, `../`), carry their file extension, stay inside the module root and name a provided module or a served skill `.js` file at its include path `<skill>/<path>`. Bare, absolute and URL specifiers, `require`, dynamic `import()` and paths escaping the root are build errors. The entry MUST export `think` and MAY export `init`, `detail` and `createPolicy` (the trusted runner's factory, §11 *Trusted runner*); the bundle is an IIFE whose result the script binds to the global `var`s of those names (exports only), so the composed script satisfies the classic-script ABI unchanged and contains no module syntax. With `include` the composition is the included contents joined by `\n`, then `\n`, then the bundle, so bundled code may call include-defined globals. A build failure is `invalid` with `message` (esbuild's first error, own text, at most 1024 code units) and `location:{file,line,column}` (a module path or include entry, 1-based line, 0-based column); a missing `think` export is a build failure. Size limits apply to the composed script, and it (never the modules) is what is probed, stored, versioned, published and hashed. The same modules, entry, include, served skills and PlayerThree version MUST yield the same script.

A composed artifact's engine locations refer to the composed script (`policy.js:line:col`). When a composed artifact fails `compile` (or `threw` during its load) at deployment or practice, the host MUST append the originating part as own text, ` (in <skill>/<path>:<line>:<col>)` for an include file or ` (in code:<line>:<col>)` for `code`; a bundle's location stays in the composed script, whose esbuild module comments (`// <path>`) name each module's part.

*Artifact shape.* An artifact has exactly one body: `code` (with `runtime`), js `modules`+`entry` (with `runtime:"js"`) or a starter reference `from` (§11 *Starters*); `include` goes with `code` or `modules`, `knobs` with `from`. The tool schema advertises the members; the host checks how they combine and MUST reject a wrong shape as `invalid` with `schemaCode`, a developer-field `path` (never a rejected key or value; `["artifact",…]` inside `practice_run`) and `expected` rooted at `Artifact`, in this order: not an object → `type` at `[]`; an unknown key → `unknown_field` at `["?"]` with the shapes the game accepts (`Artifact: { runtime; code; include? } | …`); no body → `missing_field` at `["code"]` with `Artifact: one of code | modules+entry | from` (`modules+entry` only with the js runtime, `from` only for a game declaring starters), except that `knobs` alone names `["from"]` and `entry` alone names `["modules"]`; a second body, or a member its body does not take (`entry` with `code`, `include` with `from`, …) → `unknown_field` at that member with the body's shape (`Artifact: { runtime; code; include? }`); a missing `runtime` or `entry` → `missing_field` there (`Artifact["runtime"]: "js" | "wasm"`, `Artifact["entry"]: string (one of the modules keys)`); a runtime other than `js` with `from` or `modules`, or another value, → `enum` at `["runtime"]`; `include` with `wasm` → `unknown_field` at `["include"]`; an empty `code` → `range` at `["code"]`. Module and include problems beyond these keep their own rules (above).

*Concurrent deploys.* A commander's lobby deploys, rollbacks and imports (`policy_deploy`, `policy_rollback`, `policy_import`, any of its roles) share its version counter, and a match seat's deploys and rollbacks share the seat; each set runs **one at a time in queue order**, each call to its own result. A call first validates and builds its artifact on its own (a malformed one fails at once, without queueing), then joins the queue; versions are numbered when a call reaches the head, so concurrent deploys number in queue order. A failed or rejected call never blocks the ones behind it. At most `MAX_QUEUED_DEPLOYS` = 8 calls run or wait in one queue; a call arriving at a full queue fails `busy` at once. A supervised deploy or rollback (§7) is not queued: while the queue holds any call it fails `approval_pending`. **Why:** an agent commanding several roles naturally deploys them in parallel; rejecting all but one as `busy` cost such agents their first deploys.

Policy loaders accept optional JSON-compatible `matchData`, bounded to 131072 UTF-8 JSON bytes independently of observation input. Initialization runs once per sandbox instance, under the load budget, after script/module startup and before any `think`. The initialization payload is an isolated JSON snapshot; policies MAY retain it in instance state. WASM `init` has exactly two `i32` parameters and no results; the old zero-argument WASM signature is not supported.

A policy MAY declare the observation detail it reads (§3 *Observation scope*): the string `"all"` or a list of section names. JS declares it as the global `detail`, read once after top-level code and before `init`; WASM as one custom section `playerthree.detail` holding the UTF-8 JSON value, read before instantiation. Undeclared means the role's defaults. The host resolves it against the manifest when loading (deploy probes, activation, practice, restarts) and gives every `think` of that instance observations at the role's defaults united with the declared sections. A malformed declaration, a duplicate section or an unknown section fails loading with `bad_output`.

Instances MUST be isolated, have no files/network/environment/timers/host capability, and be disposable independently. Instance state persists within a match, never between instances. JS uses seeded pseudorandomness, fixed time and deterministic `Math` (below) rather than a live entropy/clock source or engine-defined approximations; WASM floating-point and JS timezone behavior MUST NOT be assumed deterministic across engines. Deployment MUST perform a dry-run probe before activation; a broken deployment MUST NOT replace the working policy. Source size is measured in UTF-8 bytes, WASM size in decoded bytes.

In JS, `Math.random()` is seeded deterministic sfc32; `Date.now()` is `0` and zero-argument `new Date()` is the
Unix epoch. Explicit date arguments still work. These substitutes are not access to live clock or unseeded entropy.
Developer-only `debugView()` is Implemented (§10 and DevTools below); it grants no capability to sandboxed policies.

**Deterministic `Math`.** ECMAScript leaves most `Math` functions implementation-approximated. Every JS policy runtime (the QuickJS sandbox and the trusted runner below) MUST replace `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `pow`, `cbrt` and `hypot` on the policy's `Math` object, before the policy's top-level code, with PlayerThree's pure-JavaScript port of fdlibm 5.3 (FreeBSD msun algorithms) that also returns the ECMAScript special-case values (e.g. `pow(1, NaN)` and `pow(-1, ±∞)` are `NaN`; `hypot` of any `±∞` is `+∞` even with `NaN`; `hypot()` is `+0`). `hypot` with more than two arguments folds left with the binary fdlibm `hypot` after the special cases; arguments are coerced with `ToNumber` exactly once each, in order. The port uses only IEEE-754 `+ - * /`, `Math.sqrt`, comparisons and typed-array bit access, which every conforming engine evaluates identically, so the same artifact, seed and inputs produce bit-identical results under any engine. `sqrt`, `fround`, `round`, `floor`, `ceil`, `trunc`, `sign`, `abs`, `min`, `max`, `clz32` and `imul` stay native (exact by specification). The replacements are ordinary writable, non-enumerable properties with the native `name` and `length`: a policy MAY overwrite them, at its own determinism cost. The port's version (`DETERMINISTIC_MATH_VERSION`) is part of `surfaceHash`.

**Engine identity.** The host runs exactly one JS engine build, Bellard's QuickJS 2025-09-13 (quickjs-emscripten `RELEASE_SYNC`); there is no per-policy or per-host engine choice. Its identity (`POLICY_JS_ENGINE` = `quickjs 2025-09-13`) is part of `surfaceHash`, and `buildPolicy` (§11 modules, `playerthree policy build`) lowers syntax to that engine's supported ECMAScript level (`POLICY_ES_TARGET` = `es2025`; e.g. `using` declarations are lowered), so a bundled policy never depends on syntax the sandbox lacks.

Fixed ABI caps include 1 MiB JSON output, JS nesting depth 32, engine error text 1 KiB, JS stack 256 KiB, and 65536 total WASM table entries. The unit of `msPerCall` is **CPU time of the sandbox's own thread**, measured from the moment it picks the call up: time the thread is descheduled (host load), thread wake-up latency and host event-loop stalls MUST NOT count against the policy, so the same artifact passes or fails its budget independently of machine load. The load budget is ten times `msPerCall`, in the same unit. Separately, a larger wall-clock hang guard bounds work the thread cannot interrupt or a thread starved of CPU: a call or load exceeding `4 × budget + 100 ms` of wall time on the sandbox thread fails `timeout`, and the reference host watchdog hard-kills `50 ms` after that from sending the request. Per-call intents/logs and memory MUST obey the manifest caps. Extra intents are dropped/countable, not unlimited work. Policy error codes are exactly `runtime_not_allowed`, `too_large`, `compile`, `missing_export`, `bad_module`, `imports_not_allowed`, `memory_limit`, `timeout`, `threw`, `bad_output`. Only errors about the caller's own artifact MAY include bounded engine text.

**Timeouts.** A JS call stopped by its in-engine CPU-budget interrupt fails `timeout` and yields no intents (its log lines are returned), but the instance MUST be kept. QuickJS unwinds the whole stack with an uncatchable error: no `catch` or `finally` runs, so the policy's state is whatever it was at the interruption point, possibly half-updated, and that point depends on CPU timing, so it is not deterministic. A policy that must stay consistent computes into locals and commits its state at the end of `think`. Promise jobs still queued at the interrupt MUST NOT run in, or be billed to, the next call: they are drained before the timed-out call returns, to completion, under a fresh budget of `msPerCall` billed to that call; a drain that overruns as well kills the instance. A JS call that returns over its budget without the interrupt firing (it polls between bytecodes, not inside one native operation) fails `timeout` the same way. Every other timeout kills the instance: the wall-clock hang guard and host watchdog, any `wasm` call, and the trusted runner's guard (below); so do `memory_limit` and engine crashes (`threw`). The host kills a JS instance after `MAX_CONSECUTIVE_TIMEOUTS` = 3 timeouts without a successful call in between. A killed instance is reloaded fresh, with `init`, on its next call, at most three times without a successful call in between; after that the policy is not called until the next deploy or rollback.

### Generated types — Implemented

`manifestDts(manifest, {role?, docs?})` (exported from `playerthree`; `docs` is `"full"`, the default, or `"bounds"`, which omits developer prose and keeps bound notes) renders a manifest as TypeScript declarations for policy authors and agents. The output is a global script (no `import`/`export`), so a `.d.ts` file serves both a classic `// @ts-check` JS policy through `/// <reference path>` and ES/TS modules. It declares, from the manifest schemas only:

- `Role`, `Team`, `Section` (declared observation sections, `never` without `observationScope`) and `Detail = "all" | readonly Section[]`;
- `Observation` (`manifest.observation`, including host-owned members such as `signals`) and `MatchData` (`null` when the game declares none);
- one type per intent kind, named by PascalCasing the kind's alphanumeric runs plus `Intent` (`queue_add` → `QueueAddIntent`; a name collision appends `_2`, `_3`, … in manifest order), `IntentKind`, and the union `Intent` of every kind (with `role`: that role's kinds); without `role`, `RoleIntents` maps each role to its kinds' union;
- with policy mode, `Think = (obs: Observation) => Intent[]`, `Init = (matchData: MatchData | null) => void` and the ambient `declare function log(...args: unknown[]): void`.

Schema nodes map to the `Infer` types: `enum` → string-literal union, `id` → `` `<prefix>_${number}` ``, `str` → `string`, `int`/`num` → `number`, `bool` → `boolean`, `ints` → `number[]`, `list` → `T[]`, `obj` → an object type whose `opt` fields are optional (`?`), an empty `obj` → `Record<string, never>`, `union` → a union of object types with the tag first. Bounds a type cannot carry (integer ranges, string lengths and patterns, list lengths) and developer docs become JSDoc on fields. The schema DSL has no null node; `MatchData | null` in `Init` is the ABI's own omission value. Policies type their entry points with JSDoc (`/** @type {Think} */ function think(obs) {…}`, `/** @type {Detail} */ var detail = […]`) or TypeScript annotations; the generator deliberately does not declare `think`, `init` or `detail` themselves, because an ambient declaration would turn the policy's definition into an uncontextualized overload. The same declarations are served as the `types` topics (§4) and written by `playerthree types` (§17); `schemaToTs(schema)` (exported from `playerthree/schema`) is the per-node renderer.

### Trusted runner — Implemented

A host MAY run **host-registered first-party packages** (§13.1), and only those, in V8 instead of QuickJS, at the speed of an in-process bot. `loadTrustedPolicy(pkg, limits, {seed, matchData})` from `playerthree/policy` synchronously returns one seat's instance, whose `call(observation)` is synchronous too. `node:vm` is not a security boundary, so the trusted runner MUST NOT load code from `policy_deploy`, `policy_import`, `practice_run`, the pool or any other upload; registration is host configuration (operator code), never a seat or owner operation. Only `js` packages qualify.

*ABI.* The package's composed classic `script` MUST define a global function `createPolicy(options)`. Every call returns a new instance, an object with `think(obs)` and optionally `init(matchData)`, that holds one seat's whole state. `options` is the seat's bot options (the exact-seat options a host validated against `GameDefinition.botOptions`, the same value `createBot` receives) as the instance's own parsed copy, or `null` when the seat has none; it belongs to that instance only and never reaches the realm's shared state. The script's top level runs once per realm, not per seat, so it MUST NOT keep per-seat state: what it keeps is shared by every seat of the process. `init` receives the seat's own parsed copy of the match data (`null` when absent). `think` receives the host's observation object itself, read-only and from the host realm (`Array.isArray` holds; `instanceof Array` against the realm's own constructors does not), and returns intents as in the sandbox. The instance's `detail` is not read: bot seats observe every section. A package SHOULD also define the sandbox globals over one instance of its own (`var seat = createPolicy(); function think(obs) { return seat.think(obs); }`, and `init` likewise), so that it also runs in the QuickJS sandbox and its parity can be checked; `buildPolicy` binds an exported `createPolicy` next to `think`. Trusted packages SHOULD ship unminified, with a readable `source` that rebuilds to the shipped script, so that a game's built-in bots can be read, exported and forked. The script MUST stay within `maxArtifactBytes`. Minification is acceptable only when a package would otherwise exceed that limit, and only if the package records it as a build option so that the rebuild still matches the shipped script.

*Realm.* There is one `node:vm` context per package `hash`, for the life of the process, shared by every seat and match that uses that package, so its JIT stays warm across seats. A fresh context per seat would cost 1.2–2.3× at p95. The context is plain (`vm.constants.DONT_CONTEXTIFY`): Node's default contextified global answers every global lookup through interceptors, at 1.2–1.35×. It allows no code generation from strings or WebAssembly and has its own microtask queue. It is trimmed to QuickJS's global set, with QuickJS's locale-independent built-ins, the deterministic `Math` and the frozen `Date`. Each seat has its own sfc32 `Math.random` stream, seeded from `seed` exactly as the sandbox's, and its own `log` lines; the top level draws from a seed-0 stream and cannot log. A load that fails (compile error, top-level throw, hang) is that package's result for the life of the process.

*Calls.* Calls run in the host's thread, with no worker hop. The observation is never serialised (JSON costs about 0.25 ms per call), and there is no `msPerCall` budget or kill. The output gets the sandbox's checks inside the realm (JSON data, 1 MiB, depth 32), is serialised and parsed into host objects, and is capped at `maxIntentsPerCall`; logs follow the sandbox caps, and the seat's promise jobs run inside its call. A wall-clock hang guard, `vm`'s timeout at `TRUSTED_HANG_MS` = 1000 ms, bounds each guarded region. Arming it starts a watchdog thread (a few hundred µs), so a host SHOULD run a round's trusted calls as one batch with `guardedEach(n, step)`, which arms one guard for the whole batch. A call the guard interrupts is killed: its instance answers `timeout` from then on, the batch resumes at its next step, and the package's realm is dropped from the cache, so later seats get a fresh realm while seats already in it keep it. A call outside any batch arms its own guard. Memory is not bounded (the realm lives on the host's heap), and an unhandled promise rejection reaches the host's `unhandledRejection`, as a built-in bot's would.

The same package, seed, match data and observations MUST yield the same intents and logs from one trusted instance as from the package's sandbox globals in the QuickJS sandbox; PlayerThree tests this on recorded observations, together with per-seat isolation inside one realm. Known gaps, documented and tested: string code generation (`eval`, `new Function`) throws `EvalError` in the trusted runner; local times before about 1900 can differ by the seconds of the zone offset (UTC methods agree); engine error and stack text differ, while error codes match; there is no `memory_limit`.

**Bot packages.** A `GameDefinition` MAY declare `botPackages(level, role)`, returning a registered first-party package (or `undefined`) for a built-in bot tier and role. Wherever the host would call `createBot(seat, level)` (opponents, allies, practice, fallback), it first asks `botPackages`. A package found there plays the seat as a bot through the trusted runner, seeing every observation section like any built-in bot, with the seat's bot options as `createPolicy(options)`. Its `surfaceHash` MUST equal the current surface, or the host MUST fall back to `createBot`. Each think round runs a match's (or a practice run's) bots synchronously and in seat order, under one `guardedEach` guard when a package plays among them. A package that fails to load, or whose call the hang guard kills, hands its seat to the built-in bot (a fresh `createBot` and `init`); a call that throws or returns bad output contributes no intents that round. The host records the `hash` of every package that played a seat in its match log (`LoggedSeat.botPackages`, first-seated order) and in the commander log's seat references (`botPackages`). This is the hook for porting built-in tiers to policies; a game that declares no packages is unchanged.

### Starters — Implemented

A game MAY declare **starters** (manifest `starters`, §3): ready-made, tunable baseline policies it serves as skill files, which a player deploys by reference instead of sending code. Each key is a starter path `"<skill>/<path>.js"` naming a `.js` file of one of the manifest's own `skills`; each value is `{summary, roles?}`, where `summary` is one line of 1–160 code units and `roles` (default: every role) is a nonempty list of unique manifest roles the starter plays. At most `MAX_STARTERS` = 16 starters; declaring any requires `control.policy` with the `js` runtime.

*Module.* A starter is an ES module, resolved with its static relative imports exactly like a served skill file imported by `modules` (above). It MUST export `createPolicy(knobs)` and MAY export `knobs` and `detail`. `createPolicy` returns one seat's instance `{think(obs), init?(matchData)}` exactly as in the trusted ABI (*Trusted runner* below), where `knobs` is the deploy's validated knobs object, or `null` when the deploy gives none; `detail` is the policy's declared observation detail. `knobs` is a plain-JSON JSON Schema of what a deployer may set (*Knobs* below); without it the only accepted knobs object is `{}`. The host reads `createPolicy` and `knobs` once per process by evaluating the starter's module graph as trusted developer code (served skill text, never player input), outside the sandbox and with a no-op `log`; a starter's top level MUST therefore be deterministic and free of side effects. A starter whose evaluation throws, that lacks `createPolicy`, or whose `knobs` breaks the rules below is a manifest error when the host first serves the surface.

*Knobs.* The schema is `{type:"object", additionalProperties:false, properties, description?}` with 1–`STARTER_MAX_KNOBS` = 32 properties per object, objects nested at most 4 deep, and at most `STARTER_KNOBS_SCHEMA_MAX_BYTES` = 16384 UTF-8 bytes of canonical JSON. Property names match `^[A-Za-z][A-Za-z0-9_]{0,63}$` and are never `__proto__`, `constructor` or `prototype`. Every property has a `default` that its own schema accepts, an optional `description` (1–512 code units), and exactly one of these shapes: `{type:"integer", minimum, maximum}` (safe integers, `minimum ≤ maximum`); `{type:"number", minimum, maximum}` (finite, `minimum ≤ maximum`); `{type:"boolean"}`; `{type:"string", enum}` (1–64 unique strings of 1–64 code units); `{type:"string", maxLength}` (integer 1–256); `{type:"array", items, maxItems, minItems?, uniqueItems?}` (`maxItems` 0–256, `minItems` ≤ `maxItems`; `items` is any of these shapes except an array, without `default`); or `{type:"object", additionalProperties:false, properties}` (nested knobs, same rules). There is no `required`: every knob MAY be omitted, and the starter applies its own default for it.

*Deploy by reference.* `policy_deploy` and `practice_run.artifact` accept `{from, knobs?}` (optionally with `runtime:"js"`) instead of `code` or `modules`; `include`, `code`, `modules` and `entry` MUST NOT accompany `from`. The host, in order: requires `from` to be a declared starter whose `roles` include the seat's role, else `invalid` with `schemaCode:"enum"`, `path:["from"]`; requires `knobs`, when present, to be a JSON object of at most `STARTER_KNOBS_MAX_BYTES` = 4096 UTF-8 bytes of JSON, else `invalid` with `schemaCode` `type` or `too_long` at `["knobs"]`; and validates it against the starter's schema. A schema failure is `invalid` with `schemaCode` (the §4 codes), `path` (`["knobs", …]`, `?` for an unknown key, never the rejected key or value) and `expected`, the knob's type in the §4 `expected` vocabulary with the reference `Knobs` (`Knobs["aggression"]: number (integer 0..10)`), derived from the schema and path only and at most `EXPECTED_MAX` code units. Errors carry no other detail. The host then builds the artifact as a `modules` artifact (above) whose only module is the generated entry `starter.js`:

```js
import * as starter from './<skill>/<path>.js';
const seat = starter.createPolicy(JSON.parse("<knobs JSON>")); // `null` without knobs
export function think(obs) { return seat.think(obs); }
export function init(matchData) { if (typeof seat.init === 'function') seat.init(matchData); }
export const detail = starter.detail;
```

so every sandbox instance holds one instance created with the deploy's knobs. `<knobs JSON>` is the validated knobs re-serialized with keys in schema order, so equal knobs yield byte-identical scripts. Size limits, the probe, versioning, storage, publication and hashing then apply to that script as to any deploy. The version's `source` (library version, supervised approval, package `source`, §13.1) is `{runtime:"js", from, knobs?}`; the library version also lists `from` and `knobs`, and `policy_status` returns them while that version is active. Starters are readable like any served skill file (`game_skill`): to go beyond the knobs, a player forks one by sending `modules` that import it at `<skill>/<path>.js` and call `createPolicy` themselves.

*Discovery.* A game declaring starters has the generated topic `starters` (index line `starters — …`, §4): the deploy call, then per starter its path, roles, summary and one line per knob (type with bounds or enum values, default, description; nested knobs indented), and one machine-readable line `Starters JSON: {"<path>":{roles,knobs}}` carrying each starter's exact knobs JSON Schema (`null` without one). It is static surface content (§4 *Surface pinning*).

## 12. Owner chat — Implemented

Chat is opt-in via `control.chat`. Only authenticated exact-seat owners MAY call `tell(team,roles|"all",text,ping?)`; registry `commanders.tell(owner,commanderIds|"all",text,ping?)` addresses distinct named IDs, never role aliases. Owner messages are `{from:"owner",tick,text,ping?}`; lobby tick is zero. Delivery MUST remain isolated to each selected named commander's lane, including opposing same-role entries.

Messages travel outside observations under `messages`; wait wakes with `wake:"owner_message"` and observe/wait drain once. Policies MUST NOT receive chat. Replies through `say`/`game_say` are owner-private by default; registry listeners include `commanderId`. Only explicit `disclosure:"observers"` may project consented commentary, with optional `category:"summary"|"chat"`; category alone is invalid and observer delay still applies. Private reasoning/chat MUST NOT be implicitly forwarded. UIs render text as plain text.

Text MUST be normalized to NFC, nonempty and non-whitespace, within manifest limits (UTF-16 code-unit counts), and reject C0/C1 controls except tab/newline as well as bidi overrides/isolates U+202A–U+202E and U+2066–U+2069. Owner sends use a bucket of 5 replenished at 1/second per owner; agent replies use a bucket of 3 replenished at 0.5/second per seat. Chat MUST remain memory-only: no replay, pool, DevTools trace, or persistent storage. Player-to-player chat is outside PlayerThree and MUST NOT enter agent payloads.

## 13. Practice and pool — Implemented

Practice MUST use an independent headless match, with the tested seat's supplied or active artifact, enemy bots at `opponent`, and allied bots at `allies` (defaulting to `opponent`). It MUST obey `maxTicks` and per-principal concurrency; a commander is one principal across the lobby and any match seating it. Optional `options` MUST match the manifest; live practice defaults to that match's options. Reports and observations MUST pass guards, and returned logs MUST belong only to the tested artifact. Practice MUST NOT mutate the live match. An inline, never-deployed artifact has statistics version `0`.

Every practice entry point validates its request with the same function (`parsePracticeRequest`: the `practice_run` argument schema bounded by `maxTicks`, the manifest's opponents, the options against `manifest.matchOptions` and the artifact rules of §11; options and artifact-shape failures carry `schemaCode`, `path` under `["options",…]` / `["artifact",…]` and `expected`) and plays it with the same runner (`runPractice`). Local practice (`practiceLocal(definition, request, {seat?, teams?})` from `playerthree/host`, and `playerthree policy practice`, §17) is that path without a host: the given teams (a nonempty subset of the manifest's, in manifest order; default all), the given seat (default the first of those teams and the first role), the manifest's default mandate, no concurrency bound (no principal), statistics version `0`, and seed `1` unless given. Its result is a `PracticeResult` of exactly the `practice_run` shape, with the tested artifact's own logs.

Publication places the active policy in the game's pool, bounded by `maxPublishedPerPrincipal`, with role/game/runtime metadata and a `policyId` shaped `pol_<digits>`. Drafted policies run as controller `policy` under the same sandbox; their code, logs, and engine messages MUST NOT be sent to other owners' agents. Pool entries expose wins/losses/draws, not the publishing principal's private identifier. Supervised publication requires §7 approval.

Pool durability (memory, JSON files, PostgreSQL) is Implemented through `PoolStore` (§21). The pool rule is unchanged by packages: `pool_publish` and pool entries never reveal a policy's code, logs or source to anyone.

### 13.1 Policy packages — Implemented; registries Proposed

Terms: a **policy** is an agent- or owner-authored artifact (§11); a **bot** is a game's built-in opponent tier; an **agent** (live commander) is a model over MCP. A **policy package** is the portable, self-verifying form of one commander library version, format `playerthree.policy/1`: one closed JSON object, exchanged as its canonical JSON (`canonicalJson`: sorted keys, no whitespace, UTF-8).

| Member | Constraint |
|---|---|
| `format` | `"playerthree.policy/1"`. |
| `game` | `{id, version}`: the manifest's `id` (§3 grammar) and `version` (1–64). |
| `surfaceHash` | 64 lowercase hex: the host surface the version was deployed or imported against (§4). |
| `roles` | Nonempty, unique manifest roles the version drives (the library version's role). |
| `runtime` | `"js"` or `"wasm"`. |
| `detail` | The artifact's declared observation detail (§11): `"all"`, a list of unique declared section names, or `null` when undeclared. |
| `source` | `null`, `{code, include?}`, (js) `{modules, entry, include?}` or (js) `{from, knobs?}`: the artifact exactly as deployed (§4 `Artifact` without `runtime`), bounded by the §11 limits (`POLICY_MAX_MODULES`, `POLICY_MODULES_MAX_BYTES`, `include` at most 16 entries, `code` at most `maxArtifactBytes` UTF-8 bytes; `from` a starter path of at most 265 code units, `knobs` a JSON object of at most `STARTER_KNOBS_MAX_BYTES`). `null` when the host did not retain it. |
| `script` | The composed artifact the host stores, probes and hashes: JS source, or base64 WASM; at most `maxArtifactBytes` decoded bytes. |
| `scriptHash` | 64 lowercase hex: `policyArtifactHash` of `script`. |
| `lineage` | `{parent, version}`: `parent` is the `hash` of the package this library version was imported from, or `null`; `version` is the exporting library's version number (1–2147483647). |
| `license` | SPDX license expression: one to four identifiers (`[A-Za-z0-9][A-Za-z0-9.+-]{0,63}`, optionally `LicenseRef-` prefixed) joined by ` AND ` or ` OR `, at most 256 code units; `NOASSERTION` when the exporter states none. |
| `author` | `null` or a display name of 1–64 code points without C0/C1 controls or bidi controls. Never an owner id, principal, commander id, email or credential. |
| `createdAt` | Export time, `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC). |
| `record?` | `{wins, losses, draws}` (integers 0–2147483647): the version's finished-match results when the library tracks them. |
| `hash` | 64 lowercase hex: SHA-256 of the canonical JSON of the package without `hash`. |

A package MUST NOT contain prompts, transcripts, owner messages, logs, statistics other than `record`, owner or principal identifiers, commander ids, tokens or secrets. The whole canonical package is at most `POLICY_PACKAGE_MAX_BYTES` = 4194304 UTF-8 bytes. Validation is closed: unknown or missing members, own `__proto__`/`constructor`/`prototype` keys anywhere, wrong patterns or out-of-bound sizes are `invalid`.

**Export** is owner-only and reads the caller's own commander library: host `exportPolicy(owner, commanderId, version, {license?, author?})` (`commanders.exportPolicy`), the seat method `policyExport({version?, page?})` → MCP `policy_export` under the `policy` scope (default the role's active version), and `playerthree policy export` (§17). It is a read, so supervised seats need no approval; a seat without a commander library, or an unknown version for its role, is `invalid`. MCP returns `{version, hash, bytes, page, pages, text, next?}`: `text` is a slice of at most `POLICY_EXPORT_PAGE` = 16000 code units of the canonical package JSON, cut only between code points; joined in order, the pages are the package. The text content is the raw `text` followed by `[page p/n — next: policy_export {"version":v,"page":p+1}]` or `[page n/n — end of package]`, as for topic pages (§4).

**Import** adds a new library version for the caller's role without activating it: host `importPolicy(owner, commanderId, package)`, seat method `policyImport(package)` → MCP `policy_import {package}` under the `policy` scope (no approval: activation is a `policy_rollback`, which keeps its §7 rules), and `playerthree policy import`. The host MUST, in order: validate the closed schema and size; recompute `hash` (mismatch `invalid`); require `game.id` to equal the manifest id, the caller's role in `roles`, an allowed `runtime`, and `scriptHash` to match `script`; then, when `source` is present and `surfaceHash` equals the current surface, rebuild `script` from `source` exactly as `policy_deploy` would (§11) and require byte equality (`invalid` otherwise). With a different `surfaceHash` the rebuild is skipped and the version is stored with the package's `surfaceHash`, so seating or rollback reports `stale_policy` (§11) until redeployed. Every failure is `invalid` with no echo of package content. The result is `{ok:true, version, stale}`. The new version records `lineage.parent = hash`, the package's `source`, `license` and `author`; retention (ten per role) applies. Activation (rollback, seating) then runs the ordinary surface check and probe.

Tunable knobs are Implemented for starters (§11 *Starters*): a package of a starter deploy carries `{from, knobs?}` and rebuilds from it. **Proposed:** compatibility hashes finer than `surfaceHash`, and community registries. A host-local pool or package exchange MUST NOT be described as implementing a registry. Bot tiers already map to host-registered first-party packages (§11 *Bot packages*).

## 14. Benchmark protocol — Implemented

Benchmark configuration MUST identify the game definition, tested seat role(s), built-in opponent tiers, held-out seeds, tick horizon, provider/model, tracks, and budgets for model turns, tokens or priced dollars, and wall time. The runner supplies the model key; an offline scripted provider MUST be supported so CI requires no API key.

| Track | Protocol |
|---|---|
| **Policy** (primary) | Start an in-process host with loopback MCP. The runner authors through a lobby commander using briefing, skills, deploy, and practice under budget. Freeze the active library artifact, then evaluate it headlessly with **no LLM** on held-out seeds against every configured tier and both sides for two-side games (mirrored seating); single-side games run solo and record outcome plus report. |
| **Live** | Run matches with the runner acting through live intents/sequences under the configured budgets; use mirrored sides for two-side games or solo runs for one side. |

A valid comparison MUST pin `surfaceHash`, fix seeds, assign identical budgets per model, and keep evaluation seeds out of practice. It MUST preserve the declared tracks/opponents/seating and report failures rather than silently removing failed runs. A run violating these conditions MUST NOT be presented as a valid controlled comparison. Replays support examination; deterministic reproduction additionally requires the game's capability in §10.

Outputs MUST include `results.json` and a Markdown report with per-tier wins/losses/draws, Wilson 95% confidence intervals (with the measured proportion and denominator identified), tokens and dollars where priced, model turns, wall time, invalid-intent rate, policy errors, surface hash, seeds, and replays. Unpriced usage MUST NOT be represented as measured zero cost. Agent Command supplies a game-specific configuration and `pnpm bench`; these are reference-game integration details, not requirements for another engine's configuration syntax.

The reference `@playerthree/bench` CLI accepts `playerthree-bench --config ./bench.config.ts --out ./bench-results`. The TypeScript module default-exports `BenchConfig` with `definition`, `roles`, `opponents`, `seeds`, disjoint `practiceSeeds`, `ticks`, pinned `surfaceHash`, `budgets:{maxModelTurns,maxTokens,maxUsd?,maxWallMs,maxOutputTokens}` (output cap default 16384 tokens per turn), `models:[{provider:"openai"|"anthropic"|"scripted",model,apiKeyEnv?,request?,price?:{inPerM,outPerM},script?}]` (`request`: extra top-level provider request fields such as router upstream pins), and `tracks` selecting `policy`, `live`, or both. It supports one or two declared sides; in a one-side game there is no opposing side to populate, and results MUST retain both outcome and the game's report. Budget limits are shared across model configurations, applied per role-authoring session in the policy track and per evaluated match in the live track. Every model session writes its JSONL transcript under `<out>/transcripts`, and every model's route passes the tool-argument preflight (*Fixed-reference benchmark publications*) before a series starts.

For solo benchmarks set `opponents:[]`: every held-out seed runs once, labelled tier `solo`, with outcome and game report. Two-side benchmarks require declared opponent tiers and mirror each seed across both sides. The reference outputs `results.json`, `report.md` and replay files under `replays/`, including practice seeds actually used, per-session usage/stop reasons, and the common budget. `apiKeyEnv` defaults to `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; an unknown-price model requires explicit `price` when `maxUsd` is set. A scripted model requires a `script` and no key.

### Model-free bot benchmarks

The **bots** track MUST require no model, credentials, practice seeds or model budget. Its config supplies
`tracks:['bots']`, a definition module reference `{module,export?}`, pinned `surfaceHash`, and ordered `sets`.
Each set supplies `id`, fixed `seeds`, `ticks`, optional game `options`, logical `sides:{A,B}` and `mirrored`.
Each side supplies a native `bot` tier and optional per-role `policies` containing `PolicyArtifact` values.
Missing policy roles use that side's native bot. Mirrors swap the entire side configuration, not seed or rules.
The public `runBotMatches` API also accepts arbitrary ordered expanded trials with these fields.
Worker threads MUST import the definition by module URL/export, use the host's native observation/decision cadence
and policy sandbox, and return results in input order independent of worker count. No random draft or new simulation
entropy is permitted. Worker count and timing MUST NOT change comparison identity.

An optional `GameDefinition.metrics(game)` creates an observational recorder with `collect()` and `finish()`.
The benchmark MUST collect once after every advanced tick, including the terminal tick, and finish once.
Recorders MUST NOT mutate the simulation, consume its RNG, or alter observations. `finish()` returns
`{match:Record<string,number>,sides:Record<string,Record<string,number>>}` with physical team keys.
The benchmark snapshots these maps, rejects non-finite numbers, unknown teams and oversized output (at most
4096 entries per map, 128 characters per metric key, 1 MiB total), then maps sides to logical A/B.
The game owns metric names and may keep a typed recorder internally; the runner MUST NOT contain game-specific types.

Declarative guardrails specify `id`, optional `set`, `metric`, `scope` (`match`, `A`, `B`, or `team:<name>`),
`aggregation` (`mean`, `median`, `min`, `max`, `sum`, `binomialTwoSided`), `comparator`
(`<`, `<=`, `>`, `>=`, `==`, `!=`, `between`) and finite `threshold` (inclusive pair for `between`).
Built-in metrics include `ticks`, `truncated`, and side `outcome.win`, `outcome.loss`, `outcome.draw`;
`binomialTwoSided` uses decisive side outcomes only and the exact fair-coin two-sided probability.
Missing observations MUST fail a guardrail rather than silently narrow its sample. Guardrail results MUST record
observed value, sample count and pass/fail in JSON and Markdown; any failure MUST make the CLI exit nonzero.
The bot identity MUST include game/version/surface, ordered sets, seeds, caps, game options, policy artifact
contents, native tiers, mirror semantics and guardrails. Outputs MUST retain the same results/report/replay
layout and operator-console discoverability as model benchmarks, with zero model calls.

## 15. Safety requirements — Implemented

1. **Outbound guard:** snapshot game output, validate the snapshot against its declared schema, and transmit only that snapshot. Invalid observations, match bootstrap data, views, reports, events, and game codes MUST fail closed, never be repaired into plausible data. Diagnostics MUST contain only closed code and safe schema path, not leaked data.
2. **Own-text rule:** free text reaching an agent is limited to trusted static developer documentation, that principal's policy logs/errors, and its own owner's labelled messages. Opponent/pool policy text, player names, arbitrary chat, and imported package descriptions MUST NOT become agent input. Teammates coordinate only through typed team signals (§22), which carry no text.
3. **Fog:** `observe`, `matchData`, `view`, `events`, and reports MUST enforce the recipient's visibility on the server. Event-driven wait and sequence cancellation MUST NOT reveal hidden events. Team signals MUST reach only the sending team's seats and views (§22.3). Schema validity alone does not prove correct fog.
4. **Untrusted agent output:** every input tier MUST pass the applicable schema, role, scope, controller, budget/rate, and game checks. Rejected values MUST NOT be echoed. Policies and built-in bots use semantic intents rather than a hidden privileged action API.
5. **Resource bounds:** protocol and MCP bodies are capped at 1048576 bytes; oversized HTTP bodies return 413. MCP per credential uses 10 calls/second, burst 20 (`rate_limited`), at most 4 non-wait calls in flight plus at most 2 waits per commanded role (overflow `busy`). Intent buckets, stream limits, policy resources, practice concurrency, pool quotas, sequence limits, and chat buckets apply additionally.
6. **Transport and credentials:** browsers with an unallowed `Origin` MUST receive 403; allowlists contain exact origins. Revocation and role/scope changes MUST not be bypassable through another binding. Tokens and their persistent backing secrets MUST be protected as credentials.
7. **Inspection:** The player API MUST accept only authenticated host profiles, exact-seat human capabilities, or trusted private team-root capabilities. Profile requests default to the named roster; live profile requests MUST validate an explicit commander ID plus exact match/team/role against that owner's current attachment and coaching authorization. Human capabilities MUST NOT expose same-side peers' private seat state. Agent, spectator and observer capabilities MUST be refused. Rejected input and third-party policy text MUST be withheld. Inspection MUST NOT become a second, less guarded agent or observer channel. The operator console below is separate and MUST NOT accept player credentials.

## 16. Connect-kit semantics — Implemented

The connect kit supplies a harness catalog and `harnessSetup(kind,{mcpUrl,serverName,token?,channel?})` for one shared MCP URL and browser sign-in; bearer tokens are a fallback. `SetupOptions.channel` explicitly selects Claude Code's stdio wake-channel setup, not ordinary HTTP MCP. Catalog kind `claude-api` describes hosted Claude and belongs in token choices, not OAuth sign-in choices. The kit MUST remain DOM-free and leave owner identity, pairing, consent rendering, and UI to the game.

**Signed in** means a connection exists for a selected named commander and compatible granted roles. **Active now** means recent connection calls or calls in flight; saved sign-in alone is inactive. `ConnectionInfo.commander` binds the exact identity. Removing a connection MUST revoke it, not merely hide its chip. Pairing returns `commanders:ConsentCommander[]`; answers select `commander` and `roles`, never owner-role aliases.

`kickoffPrompt({gameTitle,roles,mandate})` supplies text the owner can paste into a turn-based harness to start the briefing/skills/deploy-or-propose/monitor workflow, explicitly pointing to `game_skill(name:"playerthree-commander",path:"SKILL.md")`. It MUST respect the mandate and MUST NOT imply that connecting alone starts model execution.

`MANDATE_PRESETS` are UI conveniences:

| Preset | Scopes | Autonomy |
|---|---|---|
| `autonomous` | All supported scopes | `autonomous` |
| `author` | All supported scopes except `act` | `autonomous` |
| `advisor` | Supported members of `practice`, `policy`, `say` | `supervised` |

Presets MUST NOT introduce protocol modes or implicit extra permissions. The exported preset arrays contain the named scope sets; UIs MUST intersect them with scopes supported by the game's modes before applying them. On the wire only scopes and mandate are authoritative; UI names MAY vary. The reference core exposes `SCOPES`, `Scope`, `METHOD_SCOPE` and `defaultScopes(manifest)`; `playerthree/control` is browser-safe.

The connect kit's `ConsentCommander` exposes named ID, name, kind, compatible roles, isolation, optional self-reported metadata, scopes and mandate. The trusted UI SHOULD display them; they never permit an agent to grant permissions or select another identity implicitly.

## 17. Conformance and Safety Card — Implemented

Conformance applies to advertised roles and modes, not to an implementation language. A game/host MUST satisfy §§3–10 and §15; enabled policy/chat/practice/pool bindings MUST additionally satisfy their sections. An MCP binding MUST satisfy §§4–6; a benchmark MUST satisfy §14; a store implementation MUST satisfy §21.1. Proposed features are not conformance requirements.

Implementers SHOULD run `playerthree lint` for vocabulary, schema bounds, documentation, and observation-size checks, and `playerthree audit` for generated adversarial intent/control inputs, no-echo behavior, outbound conformance, and surface pinning. Reference invocations are:

```text
playerthree audit <definition-module> --out SAFETY.md
playerthree audit --url <mcp-url> --token <seat-token> --expect-hash <sha256> --out SAFETY.md
```

Audits act on a live host and SHOULD use isolated test matches/credentials. A Safety Card SHOULD publish game/version, control-plane version, surface hash, observation fields, available intents/tools, modes and limits, audit date, check outcomes, and skipped checks. It MUST describe owner-chat exceptions accurately, distinguish supported features from granted scopes, and not claim unrun checks passed. Audit success is evidence about tested behavior, not proof of correct game fog, fair balance, a trustworthy developer, or deterministic simulation.

Policy authoring tools use the same generic functions as the host, never a second implementation:

```text
playerthree types <definition-module> [--role <role>] [--brief] [--out policy.d.ts]
playerthree policy build <entry> [--game <definition-module>] [--include <skill>/<path>]... [--out policy.js]
playerthree policy build --from <skill>/<path>.js [--knobs <json>] [--role <role>] --game <definition-module> [--out policy.js]
playerthree policy practice <definition-module> <policy-file> [--seat team/role] [--teams t1,t2] [--options <json>] [--include <skill>/<path>]... [--opponent <tier>] [--allies <tier>] [--seed N] [--ticks N] [--json]
playerthree policy practice <definition-module> --from <skill>/<path>.js [--knobs <json>] [--seat team/role] [--teams t1,t2] [--options <json>] [--opponent <tier>] [--allies <tier>] [--seed N] [--ticks N] [--json]
playerthree policy export <definition-module> --store <commander-store-dir> --owner <owner> --commander <id> [--version N] [--license <spdx>] [--author <name>] [--out policy.json]
playerthree policy import <definition-module> <package.json> --store <commander-store-dir> --owner <owner> --commander <id>
```

`types` writes `manifestDts` (§11 *Generated types*; `--brief` writes the `docs:"bounds"` form the `types` topics serve). `policy build` bundles an ES-module or TypeScript entry with `buildPolicy`, reading only files under the entry's directory through the same relative-import rules as `modules` (§11), composes `include` when given, and with `--game` checks the composed size against that game's `maxArtifactBytes` and resolves includes and skill imports against its served skills; it fails on any build error or module syntax left in the output. `policy build --from` builds a declared starter (§11 *Starters*) of `--game` with `--knobs` exactly as `policy_deploy {from, knobs}` would for `--role` (default: the starter's first role), printing the closed `invalid` detail (`schemaCode`, `path`, `expected`) on a rejected reference. `policy practice` builds a `.ts`, `.mts` or `.mjs` file (or a `.js` file with module syntax) the same way, otherwise treats the file as a classic script (with `--from`, it submits the starter reference `{from, knobs?}` instead), then runs local practice (§13); `--json` prints the `PracticeResult`, and the exit status is 0 only for `ok:true`.

`policy export` and `policy import` call `exportPolicy`/`importPolicy` (§13.1) on a host built over a JSON commander store directory (`jsonCommanderStore`), such as a local dev host's; they MUST NOT run while another process serves that store.

### Operator console — Implemented

DevTools is the **operator console**, for the game's developers and operators only. The reference mounts it with
`mountDevtools` / `createDevtoolsHandler` (default path `/playerthree/devtools`). Exactly one access mode is active per mount;
configuring both `authorize` and `operatorToken`, or a malformed token, MUST fail at mount.

- **Local (default, no credential):** the TCP peer MUST be loopback; requests carrying any proxy header (`Forwarded`,
  `Via`, `X-Forwarded-*`, `X-Real-IP`, `X-Client-IP`, `True-Client-IP`, `CF-Connecting-IP`, `Fastly-Client-IP`) MUST be
  rejected; `Host` MUST be `localhost`, `127.0.0.1` or `[::1]` (any port); `Sec-Fetch-Site`, when present, MUST be
  `same-origin` and `Origin`, when present, MUST be a loopback origin. State-changing requests MUST carry `Origin` or
  `Sec-Fetch-Site` and a JSON body.
- **`authorize(req) => boolean | Promise<boolean>`:** the game's own admin authentication decides every page and API
  request. Because cookies are ambient, state-changing requests MUST also carry a same-origin `Origin`/`Sec-Fetch-Site`
  and a JSON body.
- **`operatorToken`:** a static secret of 32–512 printable ASCII characters sent as `Authorization: Bearer`, compared
  through SHA-256 digests and timing-safe comparison, and accepted only over HTTPS (TLS or `X-Forwarded-Proto: https`)
  or from a direct loopback peer. It MUST NOT appear in URLs; the page keeps it in tab-scoped `sessionStorage`.
- **Separation:** player credentials (owner, seat, spectator, commander, OAuth access tokens) MUST NOT grant access in
  any mode, and operator credentials MUST NOT be accepted as agent credentials or exposed to players.

The console provides **Overview** (game, sessions, agent activity, 15-minute rejection/policy-error window),
**Sessions** (live, ended-but-held and recent), **Agents**, **Policies**, **Bench**, **Safety** and **Game settings**.
For any session still held by the host it exposes all sides' state and traces and the perspectives `god`,
`side:<team>` and `seat:<team>/<role>`: respectively optional adapter `debugView()`, a guarded side view, or the last
delivered seat observation (not a new observation). The game's developer snapshot MUST be bounded JSON; it is
deliberately outside player schemas and never an agent tool. Ending a session calls `PlayerThreeMatch.end` (§10); a
persistent session (§18) has no outcome and cannot be ended from the console. Exporting downloads the deterministic
replay. Agents lists owners' commanders and, when the game passes its `AuthorizationServer` as `oauth`, their sign-in
connections (`AuthorizationServer.allConnections()`); rotating a commander token revokes the old one immediately and
does not return the new one; revoking removes a connection. [DevTools](../docs/DEVTOOLS.md) lists the HTTP API.

**Recent sessions — Implemented.** When the host releases a session (the game disposes it), `host.history` keeps a
record — id, game version, seed, options, match `teams`, `alliances` (or null), created/ended/released times, ticks, outcome per match side, `ranks` (or null), owners, `sameOwnerOpposed`, seats
(controller at release, owner, policy, and the harness labels transports reported for agent holders), rejection and
policy-error counts with top codes — and its replay. The history MUST be bounded by count, age and replay bytes
(reference defaults 50 sessions, 24 h, 64 MiB; oldest dropped first; a replay over the byte budget is dropped and its
record kept). It is in memory by default; with a history store (§21: one JSON file per session through atomic
writes, or PostgreSQL) it persists, pruned with the same bounds (pruning deletes from the store), and reloads at startup. The console lists recent sessions, opens them in the
same timeline (every perspective, scrubbing, export) under the same operator authorization, and a live session that
is no longer held links to its recent record. A recent session MUST be scrubbed exactly like a fresh replay of its
recorded replay; records from another game version, without a kept replay, or of a persistent session's window are
export-only. Records and replays stored before per-match team subsets or without `sameOwnerOpposed` are not readable (data reset, §21).

**Replay scrubbing — Implemented.** Scrubbing a session or an uploaded replay MUST reconstruct the recorded seed,
options, match sides/alliances and entries through T in an isolated adapter; it MUST NOT mutate or observe the live session. Inputs recorded
at T are included before the next step. Perspectives are God (`debugView`), guarded side view, or guarded fresh seat
observation with `sinceTick=max(-1,T-1)`. Up to 200 recorded inputs and retained host trace events within ±1 tick
accompany the snapshot; expired traces are not reconstructed. Uploads accept exported replay JSON only for the same
game ID and game version, under the same operator authorization.

The reference implementation retains isolated forward cursors and, when optional `GameAdapter.clone()` is present,
checkpoints every 500 ticks. A clone MUST be independent, preserving all state and RNG while sharing no mutable
buffers, maps or caches. Cache retention is bounded to four timelines, 80 checkpoints and a conservative 256 MiB
retained-graph estimate, thinning dense checkpoints to maintain temporal coverage. Without cloning backward seeks
replay from zero. Limits are 36,000 target ticks (20,000 without cloning), 100,000 entries, two concurrent simulations
(one per source), two minutes per seek, and four uploaded files up to 5 MiB each. Cancellation and deadlines are
cooperative between synchronous adapter calls; over-limit requests return explicit errors rather than partial state.

**Player API — Implemented.** `createPlayerApiHandler` (default path `/playerthree/player`) serves `GET <path>/state` and
`GET <path>/stream` (Server-Sent Events) under the inspection boundary in §15.7. `Authorization: Bearer` accepts an
exact-seat human capability, a trusted private team-root capability, or a game profile credential resolved by
`owner(req)`. The resolver alone supplies owner identity; a caller-supplied owner ID grants no authority.

Profile requests without a target return only the owner's named `commanders` roster, with `match`, `team` and
`target` null and live seat/trace maps empty, even when commanders are seated. An authenticated profile may have an
empty roster. Multiple commanders may support the same role; there is no owner × role singleton or permanent
roster team. A transient commander attachment is `{match,team,roles}`, allowing several separately guarded
same-side role lanes.

A live profile request MUST supply the complete quartet
`?commander=<id>&match=<id>&team=<team>&role=<role>`. The named commander MUST belong to the authenticated owner,
support that scalar role, and currently hold that exact match/team/role lane. Cross-side or broader-view owners
fail the match's coaching authorization. Partial or repeated quartet fields return 400 `bad_message`; foreign,
incompatible, stale or forbidden selections return 403. The API MUST NOT infer the first attached commander/side.
Human capabilities expose only their exact seat; trusted private team-root capabilities expose only their own
team and MUST NOT be issued to public lobby participants. Agent, spectator and observer capabilities receive 403;
unknown credentials receive 401. `/stream` without a live selection/capability returns 409 `not_in_match`.

State carries `target` (the selected quartet or null), `match`/`team`, `tick`, `outcome`, authorized `seats` and
role-keyed `readiness`, observations (with UTF-8 byte size), policy status (stats, own logs, last error, approval),
recent policy calls, practice runs and projected trace events. Readiness retains `ready`, `waiting`, `absent`,
`stale_policy`, `policy_failed` and `consent_required`. Role-keyed maps are confined to the selected side and,
for profile/human access, one exact role; role is never used as a commander identity. Commander credentials are
never included. Snapshot generation rechecks the lease after asynchronous policy reads; streams recheck their
authorization before delivery and close when access is revoked rather than following another lane.

### Operator sections — Implemented; console-started bench runs and settings editing Proposed

| Operator section | Responsibilities |
|---|---|
| Policies | Every named commander's isolated library (versions, runtime, size, creation time, active version, last practice and W/L/D), pool entries and exact-seat policy failures. Operators can disable or unpublish pool entries through `host.pool.setDisabled` / `host.pool.unpublish`; players see only draftable entries. No library aliases by owner × role exist. |
| Bench | Read-only listing of the bench result directories the console is given (`benchResultsDir`): validity and reasons, surface match, per run and tier W/L/D with the Wilson 95% interval, cost (tokens, USD when priced), turns, wall time, invalid-intent rate, policy errors, the rendered report, and every listed replay opened in the timeline. Replays are read only by the paths `results.json` lists, inside their directory. |
| Safety | `surfaceHash`, enabled modes with their limits, the scope vocabulary and new-seat defaults, the game's Safety Card when configured (flagged stale when it does not name the current surface hash) or how to produce it with `playerthree audit`, and rejection codes over the problem window and the recent sessions. |
| Game settings | Read-only: the `matchOptions` schema, the host's default match options and the options each live or recent session runs with. |

Starting BYOM bench runs from the console and editing match options or default mandates are **Proposed**; the
console points to the CLI and to the game's own configuration instead.

### Player console — Implemented

`@playerthree/console` (browser-safe, no Node built-ins) is the player console: a headless client over the player API
using the owner credential the game already holds, restricted to that owner's seats, plus an optional drop-in panel.

- **Client** (`createPlayerConsole({ credential, target?, url?, pollMs?, stream?, pricePerMTok?, bytesPerToken?, maxIntents? })`):
  polls `/state` (default every 2 s) and, while a match runs, follows `/stream` through `fetch` so the credential stays
  in the Authorization header, never in a URL. Live events received after a state request was sent are merged with
  its answer counting each occurrence once. `target` is `{commander,match,team,role}` or a getter returning that
  quartet or undefined; undefined keeps profile access roster-only. Selection changes clear old lane history.
  The snapshot lists distinct named commander IDs/names/compatible roles in the lobby, with null runtime role/team,
  or the exact selected live seat. It retains execution kind/controller, presence, readiness/probe/consent state,
  pause state, mandate, scopes, limits (`mandate.limits`), role-labelled pending `approvals` (`{role,approval}[]`;
  all commander lanes in the lobby, only the selected role live), policy stats/errors/log tail, recent
  intents (newest first, closed ack code: `ok`, the ack code, or the game's code for `game` rejections) with
  per-code rejection counts, practice runs including their explicitly selected role, and observation size with a token estimate
  `tokens = ceil(bytes / bytesPerToken)` (default 4 bytes per token: an estimate, not a tokenizer) and, with a price,
  `cost = tokens × pricePerMTok / 1,000,000` per read. Errors surface as closed codes (`bad_token`, `forbidden`,
  `no_credential`, `network`, `http_<n>`).
- **Panel** (`mountConsolePanel({ console, mount?, toggleKey?, title?, roleLabel?, className?, currency?, actions?,
  pollWhileHidden?, onToggle? })`): framework-free DOM mounted into any element, hidden by default, toggled by a
  configurable key (default `Backslash`; never while typing in a field or with Ctrl/Alt/Meta; `null` disables) and
  themed through `--playerthree-console-*` CSS custom properties on zero-specificity selectors. It renders every value as
  text. Approvals are read-only unless the game passes `actions.resolveApproval(target,approvalId,approve)`.
  Its target is `{kind:'commander',commander,seat?:{match,team,role}}` for the authenticated profile's named
  commander operation or `{kind:'seat',match,team,role}` for live exact-seat control; no role-keyed alias exists.
  The client polls only while the panel is open unless `pollWhileHidden`.

The console grants neither a God view nor any authority over other owners' seats: it is a read view of what the
owner's own agents already receive.

### Wake channels and listen-based wake — Implemented

`playerthree-mcp --channel` opts into experimental `claude/channel` on the current protocol only, and emits
`notifications/claude/channel` for `seated`, `match_ended` (with outcome), `approval_resolved`, and labelled
`owner_message` only. It prefers standard listen-based status updates when the server honors the resource filter;
otherwise background waits monitor each commanded role and a shared briefing poll runs once per second.
It MUST NOT project observations, arbitrary game events, other players' text or policy logs into channel messages.
Ordinary MCP still needs an initial kickoff and the commander's lobby `game_wait` loop to keep running.
Claude Code's custom-channel development flag is an interactive research preview: `-p` and Agent SDK ignore that
flag; organization policy still applies; events are silently dropped unless loaded as a channel.
See [MCP setup](../docs/MCP.md#claude-code-wake-channel--implemented-research-preview).

MCP `subscriptions/listen` delivers URI-only `notifications/resources/updated` for private seat status resources.
Each credential (sign-in connection, commander-token generation or seat token) and commanded role has its own
`playerthree://seat/<base64url HMAC(server key, credential id + role)>` URI. Only that credential's `resources/list`
MAY expose it; `resources/read` MUST re-authenticate ownership, otherwise return not found. Status is JSON containing
only `phase:"lobby"|"match"`, optional manifest `team`, `tick`, optional closed `outcome`, optional approval
`{id,kind,version,status}`, `unreadOwnerMessages`, and (pausable games, while paused) `paused`
`{tick,since,seats:[{team,role,reason,tick,since,until?}]}` (§18). It MUST NOT contain free text.

The host's non-consuming status snapshot MUST NOT drain inboxes, approvals, or retained transitions delivered by
`wait`. Lifecycle hooks cover seating, match end, approval changes, owner messages, pause/resume and credential/role changes.
The binding advertises `resources:{subscribe:true}` and publishes updates only for affected credentials.
Because the SDK listen router has no authentication context, the binding MUST validate every requested resource
URI at its authenticated HTTP boundary. Revocation, token rotation and role removal MUST stop old stream delivery.
The reference binding aborts the stream's HTTP request signal; SDK 2.4.0 tears down its bus subscription and closes
the stream. No URI-key fallback is needed. Status URIs MUST NOT enter logs, traces, DevTools, or shared manifests.
Resource listings are private and uncached because role grants can change. Resource snapshots do not replace
`game_wait` for observations/events or labelled owner-text delivery; a listen notification alone does not start
a model turn in harnesses without wake support.

### Hosted Claude — Implemented tools-only setup

The Claude API MCP connector and Managed Agents use tools only: no resources, Skills extension or channels.
`game_skill` serves all required playbooks. Supply a publicly reachable HTTPS MCP URL and a commander token as
`authorization_token`; callers using OAuth instead must acquire and refresh tokens themselves. Managed Agents
declare the server on the agent and supply credentials through a vault. Connector tool-list pinning is not
PlayerThree `surfaceHash` pinning: the latter also covers skills, manifest and session semantics.
See [hosted setup and upstream references](../docs/MCP.md#hosted-claude-api-and-managed-agents).

## 18. Sessions across genres — Implemented; durable session state Proposed

An **ending session** produces a terminal outcome, including a single-player puzzle or run. A **persistent session** has no terminal game outcome, as in an MMO, idle world or ongoing colony. Both use the match-named APIs (`createMatch`, `PlayerThreeMatch`).

### Persistent sessions — Implemented (in memory)

`createMatch({persistent:{checkpointTicks,checkpoints}})` creates a persistent session (`PlayerThreeMatch.persistent` is true): integer `checkpointTicks` 1–2147483647 and `checkpoints` 2–100 (any other shape fails `invalid`); the adapter MUST implement `clone()` (creation throws otherwise). Its `outcome()` is always `running`, whatever the adapter reports; `over` stays false; `end()` fails `invalid`; `dispose()` closes it. There is no time cap. No outcome is ever recorded for commanders (their win/loss/draw counts stay unchanged) or for drafted pool policies.

Replay retention is a rolling window. Right after the session steps to a tick that is a multiple of `checkpointTicks`, the host keeps an isolated `clone()` of the game (never inside a tick or a pause), keeps only the newest `checkpoints` clones, and drops every replay entry recorded before the oldest kept checkpoint. Once anything was dropped, `replay()` carries `window:{from,dropped}`: `from` is the oldest kept checkpoint's tick and `dropped` counts the entries recorded before `entries[0]`. Scrubbing reaches every tick from `from` to the current tick: at least the last `(checkpoints − 1) × checkpointTicks` ticks, or the whole session while it is younger. `PlayerThreeMatch.checkpoint(tick?)` returns an isolated copy of the newest kept checkpoint at or before `tick` (default: the oldest), positioned for `replayMatch(definition, replay, target, position)` / `replaySimulation`; position entry indices are absolute (they count `dropped`). A replay with a `window` and no position fails (`this replay starts at a checkpoint`), and so does a target before `from`.

Limits: the window lives in process memory (`checkpoints` adapter clones plus the window's entries, bounded per tick by intent rate limits, policy/bot output caps and owner buckets) and is released by `dispose()`. A windowed replay file is a log of its window, not a standalone reproducible replay: checkpoints are not serialized. Durable checkpoint storage, recovery of a live session after a restart and unbounded history are **Proposed**; rosters, the pool, OAuth connections and released-session records are durable through §21. Benchmarks use time-boxed episodes with explicit tick budgets and game reports; a session still `running` at the horizon is reported as truncated, never as a fabricated win or loss.

### Pausing while absent — Implemented

A game opts in with `control.pausable` (`{maxPauseSeconds?}`, §3); it SHOULD do so only when one absent seat may stop the whole session for everyone in it (solo play, a turn-based seat that must move), never for a shared world. Owners can then set `whenAbsent:"pause"`; for any other game the host rejects it with `invalid` (live `setMandate`, protocol `mandate` op, commander settings), and the typed `MandateOf<M>` only includes `pause` when the manifest declares `pausable`. The briefing lists `modes.pausable`, its mandate schema allows `pause`, and the agent docs explain it; non-pausable games' surfaces are unchanged.

A seat **holds** the session while its controller is `agent`, its mandate says `whenAbsent:"pause"`, its agent is absent (§8), and its max pause has not run out. The session is **paused** while any seat holds it. The host decides only at tick boundaries, never while a tick executes: before every due tick (realtime timer or `step()`), on each agent call, on owner mandate/controller changes, and every 250 ms while paused. A seat whose agent turns absent inside a tick acts like `hold` for the rest of that tick.

While paused, a realtime session does not step. `PlayerThreeMatch.step(n)` refuses with the closed code `paused` (`PlayerThreeError`): synchronously when the session is paused at the call, otherwise the promise rejects at the first tick that finds it paused (earlier ticks were stepped). Engines owning the clock check `paused()` or listen to `onStatus`. Game time stands still, so a `wait` ends after its `seconds` of wall-clock time instead. An ended session is never paused.

A seat stops holding with a closed reason: `present` (its agent called), `owner` (controller or mandate changed), or `timeout` (`maxPauseSeconds` of wall-clock time since the seat began holding). After `timeout` the seat acts as `whenAbsent:"policy"` (deployed policy, else fallback bot) until its agent is present again or the owner changes the seat; a later absence pauses again. Without `maxPauseSeconds` a pause lasts until presence or an owner change.

Exposure: `SeatInfo.pause` `{reason:"agent_absent",tick,since,until?}` on each holding seat (also in the protocol `seats` push), `PlayerThreeMatch.paused()` and `SeatStatus.paused` `{tick,since,seats:[{team,role,reason,tick,since,until?}]}` (status resource, player console), and trace events `pause {reason}` / `resume {reason}`. `since`/`until` are wall-clock milliseconds.

Replays record each transition at its tick: `[tick,team,role,"pause","agent_absent"]` and `[tick,team,role,"resume",reason]`. They do not touch the simulation (it does not step while paused); presence is wall-clock state, so the host records the decisions instead of re-deciding them, and fallback actions after `timeout` are ordinary intent entries. Replay execution validates the pairing and reports the seats holding a pause at the target tick (`ReplayResult.paused`). Entries are bounded: one per transition, and every transition needs an agent call, a 30-second absence, a rate-limited owner change or an expired max pause.

`hold` is not pause: it suppresses the absent seat's policy/bot actions while simulation time continues. Per-move supervision in turn-based games remains **Proposed**; supervised autonomy still gates artifacts, not individual moves.

### Genre matrix — integration guidance, not required mode presets

All games expose intents; sequences and policies are optional. Stream is an optional transport mode for intents, not a fourth input tier. Choices below are typical design choices within the declared modes and the owner's mandate, not automatic SDK defaults. `pause` needs a game declaring `control.pausable`. **Sidecar†** single-player packaging and **browser backend/helper†** are Proposed (§2; the §20.8 sidecar host itself is Implemented); using an implemented input tier does not imply a turnkey genre integration exists.

| Genre / agent role | Input tiers | Suitable `whenAbsent` | Session kind | Host |
|---|---|---|---|---|
| RTS commander | Intents, sequences, policy for tick-rate tactics | `policy`, `bot`, `hold` | Ending match | Multiplayer server |
| Turn-based player | Intents; sequences/policy optional | `hold`, `policy`, `bot`; `pause` for pausable solo play | Ending; persistent campaign optional | Multiplayer server, sidecar†, or browser backend/helper† |
| Card partner/player | Intents; policy optional | `bot`, `policy`, `hold`; `pause` in solo play | Ending match/run | Multiplayer server, sidecar†, or browser backend/helper† |
| Puzzle solver | Intents; sequences for short plans; policy optional | `hold`, `pause`, `policy` | Ending run | Sidecar† or browser backend/helper† |
| Roguelike companion/player | Intents, sequences, policy | `policy`, `bot`, `hold`, `pause` if pausable | Ending run; persistent campaign optional | Sidecar† or browser backend/helper†; server for multiplayer |
| MMO / persistent-world companion | Intents, sequences, policy | `policy`, `bot`, `hold`; no shared-world pause | Persistent | Multiplayer server |
| Idle / colony caretaker | Intents, sequences, policy | `policy`, `bot`, `hold`; `pause` only for a pausable private world | Persistent | Server, sidecar†, or browser backend/helper† |
| FPS squadmate | Intents for tactics, sequences for plans, policy for tick-rate control; stream optional | `policy`, `bot`, `hold` | Ending match | Multiplayer server; sidecar† for solo |
| Co-op companion | Intents, sequences, policy | `policy`, `bot`, `hold`; `pause` only when the whole input-needing session can stop | Ending or persistent | Multiplayer server; sidecar† or browser backend/helper† for single-player companion play |

## 19. Reference games — Implemented

**Agent Command** is the multiplayer reference: four declared sides played as two-side duels or four-army free-for-alls, real-time play, commander roles, owner controls and a game-specific benchmark configuration. It exercises the competitive match case, not a requirement that every game have opponents or that every declared side play every match (§10).

For single-player integrations, manifests MAY declare one side (§3), and the benchmark supports solo runs (§14). Pausable games and in-memory persistent sessions are Implemented with test fixtures, not a second reference game; durable persistent lifecycle remains **Proposed** (§18).

Supporting implementation guides: [Design](../docs/DESIGN.md), [MCP](../docs/MCP.md), [Developer experience](../docs/DX.md), [DevTools](../docs/DEVTOOLS.md), and [Policy ABI](../docs/POLICY_ABI.md).

## 20. Lobby integration profile — Proposed

This profile lets a game with its own lobby — any engine (Unreal, Unity, web, native), any platform service (Steam, EOS, PlayFab, console, custom) — seat agents as first-class players. **The game owns UI, account identity, matchmaking, moderation and simulation/session policy; PlayerThree owns the reusable benchmark runner, bindings, live standings, ratings, results, exports and series persistence.** Nothing here is a §17 conformance requirement until Implemented; an integration claiming the profile MUST satisfy §20.13.

A **lobby** is any game-owned surface that places players into sessions: a pre-game room, matchmaking queue, open-game list, invite, drop-in join of a running or persistent session, or a single-player companion picker. A **reservation** holds one or more seats in a new or existing session. The profile assumes no teams, no simultaneous real-time play, no fixed participant count and no session start or end: it covers turn-based, card and board games, co-op, sports and racing, party games, single-player companions, persistent worlds (§18) and asynchronous play-by-mail.

**Implemented start-mode primitives (reference TypeScript SDK).** The SDK implements trusted
`createMatch({assignments:[{team,role,owner,kind,commander?:{id},policy?}],readySeconds?})`, exact-seat human
credentials, fixed-side spectator credentials, transport leases, `cards()` and `readiness()`.
`assignments` replaces side-wide `commanders`; duplicate seats and concurrent placement of one
named commander ID MUST fail atomically. `policy?` selects `{version}` from that commander's
library or `{policyId}` from the pool. The game MUST derive every owner from authenticated
server state. Root team tokens remain trusted/private capabilities and MUST NOT reach a public lobby.

`mintHumanToken(team,role,{ttlSeconds?})` and `mintSpectatorToken(team,{ttlSeconds?})` return
`{token,expiresAt}`. Human tokens grant own-side fogged views but owner operations, private
agent messages, approvals, minting and streams only for the exact role. A human keeps holding its seat (and may
renew its human token) after handing the controller to an agent, policy, bot or hold; only `revokeSeat` ends it.
A human token requires a seat its owner holds as a human (`kind:"human"` or `ownerControl`). Mint and renew MUST be refused (`forbidden`) when that owner holds a broader view of the session or a human seat on another team. Owning only agent, policy or bot seats on another team (an owner's own isolated practice opponent, unranked) does not forbid the owner's human seats; coaching stays refused: no owner message may reach a seat whose owner also owns seats on another team.
Spectator watch MUST
NOT widen its fixed team. Seat, human and scoped spectator credentials expire (default
120 seconds, maximum 600), bind atomically on first `claimToken(token,connectionId)` to one
transport lease, and MUST reject every duplicate claim. `authorizeLease(lease)` MUST precede
each inbound operation and private outbound delivery. Disconnect consumes the lease;
replacement, expiry, `revokeSeat`, match end and disposal revoke joined clients as well.
`renewHumanToken(team,role,{ttlSeconds?})` moves the expiry of the seat's claimed, still-connected human credential
(same holder rule, same bounds) and returns `{expiresAt}`, so a game renews without a rejoin; an unclaimed or
dropped credential is `bad_token` and needs a fresh `mintHumanToken`.
Revocation callbacks MUST NOT interrupt revocation if an observer throws. Persistent roster
commander credentials and OAuth connections retain their normal, separately revocable lifecycle.

Match seat-token MCP MUST maintain one server-issued `mcp-session-id` per exact claimed lease on current-protocol
requests. Side-effect-free `server/discover` never claims a token. The first non-discovery POST claims the lease
atomically only after it is fully validated (headers, envelope, JSON-RPC shape, method and params) and dispatched; a
rejected or notification-only first POST consumes nothing and issues no session. The claim returns its session header;
clients MUST retain that header on subsequent calls. Every seat POST names its revision in `params._meta`
(`io.modelcontextprotocol/protocolVersion`) and its `MCP-Protocol-Version` header MUST name the same revision; a
missing or different header is a `-32020` header mismatch and any other revision is `-32022`. Every endpoint uses
only `2026-07-28`; obsolete initialize/date fallback and compatibility parsers are forbidden. DELETE, expiry and
revocation terminate the exact lease and private streams. Persistent commander/OAuth state stays independently scoped.

A stdio bridge's local `server/discover` MUST be side-effect-free: discovery/probe processes
MUST NOT initialize the remote seat session or consume its single-use credential. Local
discovery exposes static bridge capabilities and generic bootstrap instructions, not invented
remote tools, schemas, hashes or match bootstrap. The first substantive local tool-list,
tool-call or resource operation acquires the remote session and obtains its actual metadata.
That process MUST retain the acquired session and MUST NOT replay the consumed credential
in a replacement session. Clients MUST obtain the actual guarded `game_briefing` before play.
Locally a bridge MUST also serve the 2025-era `initialize` handshake (stdio clients such as OpenCode open with it),
negotiated per MCP: the client's requested revision when the bridge supports it, otherwise the latest revision it
supports. That handshake is local discovery too and acquires nothing; upstream the bridge speaks only `2026-07-28`.

Start readiness holds every stepping path, including engine-owned `step()`, and rejects
owner/agent gameplay `act` and `sequence` with `paused` while held. Briefing, observation,
policy deployment and activation probes remain available. `holdStart()` adds a trusted,
tick-zero manual preparation/countdown gate that no readiness deadline or fresh connection
can release; only trusted `skipReadyCheck()` / `start()` releases it. A public game MUST
establish that gate synchronously before exposing the held match to agents.

Human readiness requires both a trusted game ready call and an authenticated exact-seat
room join; the AI readiness deadline MUST NOT automatically release an unjoined/unready
human. The game must cancel/end that preparation or explicitly choose its trusted start
fallback. Agent presence must be newer than assignment. Cards are allowlisted data, never
seat snapshots: no owner IDs, tokens, scopes, mandates, endpoints, code, logs or private
chat. Harness verification MUST derive from trusted authentication metadata, and is
unverified when unavailable.

These primitives are **not** a claim that the whole profile is implemented: the generic
reservation service, existing-session reservation lifecycle, capability descriptor, turn
readiness and the §20.8 sidecar lobby operations remain Proposed. A game-owned reservation service may compose
these primitives, but MUST enforce the complete reservation and confidentiality contracts.


### 20.1 Seats and controller kinds

A seat is a declared side × role pair (§1, §3), written `{team,role}` on the wire. In a one-side game the side is implicit and lobby UIs need not show it; sides never imply teams or factions. A session's seat set is bounded by its match sides × roles (Implemented): `createMatch({teams?,alliances?})` picks a nonempty subset of manifest sides (default the host's `teams`, else all) and optionally partitions it into alliances; controllers, bot levels, bot seats and assignments naming a side outside the match fail `invalid`, and owner tokens exist only for match sides. Games with a variable participant count declare the maximum and seat only the sides that play.

| Lobby kind | Wire controller | Who acts |
|---|---|---|
| `human` | `human` | A person through the game client. |
| `agent` | `agent` | The owner's live agent through MCP; absence follows `whenAbsent` (§8). |
| `policy` | `policy` | A sandboxed artifact (§11) with no live model expected: a pool entry (§13) or a version from the owner's library. |
| `bot` | `bot` | A built-in tier at `botLevel`. |
| `none` | `none` | Nobody; the seat is empty. |

An **open** seat is a lobby state, not a controller: a `none` or `bot` seat the lobby offers for drop-in. Filling or vacating a seat MUST use owner/game controller operations at a tick boundary and MUST be recorded as a controller seat change (§10), including in running and persistent sessions. The game sets cut-offs (for example, no takeover after a turn, lap or minute).

### 20.2 Agent identity card

The host MUST produce one card per `agent` or `policy` seat for the lobby and game client to render:

```json
{"seat":{"team":"black","role":"player"},"kind":"agent","aiPlayer":true,
 "owner":{"display":"Robin"},"harness":{"label":"Codex","verified":false},
 "model":{"name":"example-model","selfReported":true},
 "mode":"live","policy":{"source":"library","version":3}}
```

- `aiPlayer:true` is mandatory and MUST be shown to every participant and spectator who can see the seat, in lobby listings, in session and in results. No setting removes it (§1 promise 3). Built-in bots keep the game's own bot label.
- `owner.display` is game-supplied human-facing text under the game's own name rules. It MUST NOT carry the opaque owner identifier and MUST NOT enter any agent payload (§15.2).
- `harness.label` comes from verified client metadata where available (§5); otherwise `verified:false` and UIs MUST NOT present it as verified.
- `provider?` and `model?` are optional, bounded, self-reported identity metadata on the private owner connection card. They MUST be marked `selfReported:true`; absence means unknown, never a guessed provider/model. Public disclosure requires the owner's explicit sharing choice or the published game rule and MUST NOT disclose reasoning, private chat or transport credentials.
- `mode` is the current reality: `live` (agent present), `policy` (artifact acting, including absent fallback), `bot` (fallback bot), `held` (`hold` or `pause`). `policy?` gives `source` (`library` or `pool`) and version or `policyId`, never code, logs or the publisher's identity.
- Cards MUST update on every controller, presence or fallback change and MUST NOT include tokens, mandates, scopes, chat or policy text.

### 20.3 Bring-your-own commanders

A player's roster contains independently named commanders identified by opaque commander IDs, owned by their authenticated game account. Each commander declares nonempty compatible manifest roles; identity is independent of team and role. Multiple commanders MAY support the same role. Tokens, OAuth grants, settings, policy libraries and private messages MUST bind to the selected commander ID, never an owner × role lookup.

- The game authenticates the player by its own or a platform identity and maps it to its opaque owner identifier. Platform identifiers MUST NOT reach agents or other players.
- The lobby attaches an explicitly selected commander ID to exact `{session,team,role}` leases only for compatible roles. One named ID may fill several roles on the same team in one match, with independent per-role inboxes, waits and approvals; it MUST NOT span two teams (refused when the second team is chosen, not first at the start, so its agent never sees both sides' seats) or concurrent matches. Failure is atomic. Distinct commanders of the same owner MAY occupy opposing sides or concurrent sessions, including identical roles, without sharing observations, messages, approvals or transport state; such a match is the owner's unranked practice (`sameOwnerOpposed`); its log entries carry `selfPlay` and never count in records (§20.10.1).
- The authenticated consent page MUST select the named commander and a nonempty subset of its compatible roles. A grant MUST NOT claim another commander's role or replace another connection merely because its owner, role, client name or provider matches. Missing consent sends the owner to this page or connect-kit setup (§16); agents cannot grant consent.
- Agents never browse, queue, reserve or join: they follow their owner. Agent credentials MUST NOT authenticate to any lobby or reservation operation, so a public lobby does not widen what an agent can do.

### 20.4 Seat reservation

`reserve(request)` is a game-side operation: an in-process host call, a sidecar message (§20.8), or a game-authenticated server-to-server request. It MUST NOT accept player, spectator, operator or agent credentials.

```json
{"session":"new","create?":{"seed?":1,"options?":{},"persistent?":{"checkpointTicks":600,"checkpoints":4}},
 "seats":[{"team":"white","role":"player","kind":"human","owner":"<opaque>"},
          {"team":"black","role":"player","kind":"agent","owner":"<opaque>","commander":"cmd_<opaque>"}],
 "ready?":{"mode":"turn","seconds?":86400,"agent?":"live_or_policy"},
 "rules?":{"ranked":false,"coaching":"owner","modelDisclosure":"owner"},"ttlSeconds":120}
```

`session` is `"new"` or an existing session identifier (drop-in, persistent worlds, an open async game). Per-seat members: `kind`, `owner?` (required for `human`, `agent` and library `policy`), `botLevel?`, and for `policy` either `policyId` or `version`. The result:

```json
{"session":"s_42","surfaceHash":"<sha256>","expiresAt":946684800000,
 "seats":[{"team":"white","role":"player","kind":"human","join":{"token":"<opaque>"}},
          {"team":"black","role":"player","kind":"agent",
           "agent":{"route":"roster","mcpUrl":"https://game.example/mcp","serverName":"game"}}]}
```

- A reservation MUST be atomic: every seat or none. Closed failure codes are `invalid`, `forbidden`, `not_open`, `seat_taken`, `consent_required`, `expired` and `busy`; they MUST NOT echo input. Seats of an existing session MUST be open (§20.1).
- Unclaimed reservations expire at `expiresAt`; the seat reverts and its join token or seat token stops authenticating.
- A **human join token** is opaque (§5 format) and covers one seat in one session: it lets the game client play that seat and exercise owner rights over that seat only. It MUST be delivered only to the reserved player.
- **Agent connect instructions** are data, not prose. `route:"roster"` names the selected commander and creates no credential: only that commander's exact lease is routed on seating; `mcpUrl`/`serverName` identify the endpoint. `route:"token"` returns an exact-seat token (§5), delivered only through the owner's authenticated channel and rendered with `harnessSetup` (§16). OAuth and persistent commander sessions MUST retain independent session state per named commander and lease lane, including opposing same-role connections. Tokens MUST NOT appear in listings or reach other players or spectators.
- Public listings MAY show each seat's kind, open state and card, never tokens or owner identifiers.

### 20.5 Readiness

Readiness is optional per game. `ready.mode` is `none` (no gate: drop-in, persistent worlds), `start` (the session is held before its first tick, as `readySeconds`, at most 600) or `turn` (before each turn the seat must act on; the game reports whose input it awaits through a Proposed optional adapter call `awaiting?(): Seat[]`). Readiness and the start gate cover the match's seats only (sides in the match × roles; Implemented). Seat states are closed: `ready`, `online`, `waiting`, `absent`, `stale_policy`, `policy_failed`, `consent_required`.

| Kind | Ready when |
|---|---|
| `human` | The game client has joined and met the game's own ready rule. |
| `agent` | `start` (Implemented): present (§8) since the seat was assigned **and** marked ready by its agent (`ready` / `game_ready`, §4 *Lobby phase*); present but unmarked is `online`, not present is `absent`. Once the match runs, presence suffices. A ready mark given to a game lobby's reservation of the same seat carries over. `turn`: present during the turn window. With `agent:"live_or_policy"` and `whenAbsent:"policy"`, a policy-ready seat also counts. |
| `policy` | Policy-ready: an artifact is active for the seat and passed **activation validation** in this session. |
| `bot`, `none` | Always. |

**Activation validation** MUST run whenever a library version or pool entry becomes a seat's active policy, including at seating: (1) the surface hash recorded with the artifact MUST equal the host's current `surfaceHash`; library versions and pool entries MUST record it at deploy or publish; (2) a dry-run probe MUST succeed on this seat's guarded current observation in this session, within limits, with no policy error and only schema- and role-valid intents. A mismatch is `stale_policy`; a failed probe is `policy_failed`. Either way the artifact MUST NOT activate, the seat MUST NOT report ready, and the owner MUST see the state; the owner's agent can redeploy, which probes as usual (§11). This closes the gap where a saved artifact authored against an earlier surface activates at seating unchecked.

At the deadline, or on an owner or game start, unready seats proceed under fallback: `agent` per `whenAbsent` (§8); unready `policy` as the reservation's `botLevel` bot, or `none` when no bot is given; `human` per game rule (for example forfeit in async play). The card MUST show the resulting `mode`. The readiness snapshot is `{mode,pending,deadline?,seats:[{team,role,kind,state}]}`.

### 20.6 Capability descriptor

The host MUST derive one descriptor per agent or policy seat for matchmaking:

```json
{"seat":{"team":"black","role":"player"},"kind":"agent","modes":["intents","sequence","policy"],
 "cadence":{"intentsPerSecond":2,"burst":4,"policyHz?":2,"streamMaxHz?":10},
 "budgets":{"msPerCall?":20,"memoryBytes?":67108864,"turnSeconds?":86400},
 "latency":"async","latencySource":"declared"}
```

`modes` and `cadence` are manifest control limits (§3) intersected with the seat's scopes; `budgets` are the policy limits and the game's turn or response budget. Latency classes are closed:

| Class | Responds within |
|---|---|
| `tick` | Every tick or policy cadence, with no model call: `policy` and `bot` seats, stream mode. |
| `realtime` | Seconds: a live model in a real-time session. |
| `turn` | A turn deadline of seconds to minutes. |
| `async` | Hours or days: play-by-mail, persistent-world caretakers. |

`policy` and `bot` seats are `tick`. For `agent` seats the owner declares the class (`latencySource:"declared"`); declared latency MUST NOT be presented as measured performance. A measured class requires host-recorded timing and an explicit measurement window. Missing usage, latency, token or cost values MUST remain absent, not zero. Optional agent-reported usage MUST be bounded, self-reported and attributed only to the credential's exact current seat lease; it cannot identify or update another seat. A descriptor describes reach, not skill, and MUST NOT carry model identity or owner identifiers. Lobbies SHOULD match on class: a real-time session needs `tick` coverage (a policy fallback) or `realtime`; an async game accepts any class.

### 20.7 Fair-play rules

Fair play is per game and per role. The lobby MUST show its rules before a player joins.

- **Perspective parity:** an agent seat MUST NOT see more than the game's rules let a human in that seat see (§15.3). A single-player companion or co-op partner MAY share its owner's perspective; an opposing agent MUST NOT exceed a human opponent's; in open-information games (chess, most board games) both see the board. A semantic observation format is not an information advantage.
- **Rate limits:** manifest control limits are the ceiling; lobby rules MAY tighten them for a session through mandate `limits` that the game enforces, never loosen them. Competitive lobbies SHOULD choose human-comparable action rates, or the one-move-per-turn rule a turn-based game already implies.
- **Coaching and observer isolation:** only the exact seat's authenticated owner can message its selected commander (§12), never other players or spectators. `rules.coaching` is `off`, `owner`, or `game` (a game-defined window). An owner holding a broader view of that session MUST NOT message an agent in it. Player and agent credentials MUST remain sealed from omniscient views. Omniscience is observer-only: immediate access is permitted only for private/benchmark sessions; public observer output MUST be delayed by at least 180 seconds. Neither observer credentials nor delayed spectator data may widen an agent's private reasoning, chat or observation lane.
- **Ranked separation:** rated queues MUST either exclude `agent` and `policy` seats or keep separate pools and ratings (for example humans-only versus agents-allowed). Results with such seats MUST be labelled in history and MUST NOT silently feed a humans-only rating; leaderboards SHOULD label agent-assisted runs. A game rates from the commander match log (§20.10.1): its verdict hook decides per entry, only a signed (official) host's entries should feed a public rating, and a game MUST NOT accept imported or submitted results into it.
- **Disclosure on by default:** the AI-player label is unconditional (§20.2). Harness disclosure is on by default; model disclosure follows `rules.modelDisclosure` (`owner` or `required`). Listings MUST state whether agents are allowed and which kinds before joining.
- Lobby chat, player names, profiles and descriptions MUST NOT reach agents (§15.2).

### 20.8 Engine reach

**(a) Sidecar — protocol 1 Implemented (`@playerthree/sidecar`); Windows named-pipe restriction and lobby operations Proposed.** The reference host runs as a separate process next to a non-JS dedicated server (Unreal, Unity, Godot, C++, C#, Go). The engine is always the client: it spawns the host and speaks on the child's stdin/stdout (`playerthree-sidecar --stdio`), or connects to a local socket the host listens on (`playerthree-sidecar --socket <path>`; a launcher passes the path in the environment variable `PLAYERTHREE_SIDECAR_SOCKET`). A Unix domain socket MUST be accessible only to the server's OS user: the reference creates it under umask `0177`, mode `0600`, accepts exactly one connection, then stops listening and removes the socket file. The engine channel is never on a network interface; the MCP endpoint is served as usual (§5). On Windows the reference accepts a `\\.\pipe\<name>` path but cannot yet restrict the pipe to the server's user (Proposed); use stdio there. The engine owns the simulation and clock; the host owns MCP, OAuth, guards, scopes, mandates, presence, policies and sessions.

**Framing.** Newline-delimited UTF-8 JSON, one object per line, at most 1048576 bytes excluding the terminating `"\n"`; receivers ignore unknown members. A longer line, terminated or not, makes the receiver send `{"op":"error","code":"too_large"}` and close; invalid UTF-8, a non-object, an unknown `op` or a `result` for an id that is not outstanding is `bad_frame`. `op:"error"` is only this fatal notice: its sender closes right after. Requests are correlated by positive integer `id` in two independent spaces, host `call`s and engine requests; a `result` echoes its request's `id`.

| Direction | Message | Meaning |
|---|---|---|
| engine → host | `{"op":"hello","protocol":1,"manifest":{...},"hooks":[...]}` | First message, within 10 s of connecting. `manifest` is the plain JSON of the `defineManifest` input (schema nodes in their plain form, e.g. `{"t":"int","min":0,"max":10}`), validated exactly as in-process (§3). `hooks` lists the optional adapter calls the engine answers: `matchData` (required exactly when the manifest declares `matchData`), `debugView`, `observerView`, `end`, `forfeit`, `rank`, `clone`, `signalLimits`. Reply `{"op":"ready","surfaceHash","mcp"?}` (`mcp`: the endpoint URL), or `error` `invalid_manifest`/`protocol` and close. |
| host → engine | `{"op":"call","id","session","method","args":[...]}` | One adapter or bot call (below). |
| engine → host | `{"op":"result","id","ok":true,"data"}` or `{"op":"result","id","ok":false,"code","message"?}` | Answer to a call or an engine request. For calls, `ok:false` is an adapter throw (codes `unknown_method`, `unknown_session`, `invalid`, `engine_error`); the host guards `data` exactly as in-process output. |
| engine → host | `{"op":"advance","id","session","n"}` | Engine-owned clock: the host runs `match.step(n)`, 1 ≤ `n` ≤ 10000 (thinking phase, gates, `apply` and `step` calls) and answers `result` with data `{"tick"}`, or `ok:false` with `paused` (§18), `over`, `unknown_session`, `invalid` or the code of the engine call that failed. |
| engine → host | `{"op":"host","id","method","args":[...]}` | Game-side operations (below); answered by `result`. |
| host → engine | `{"op":"push","session","kind","data"}` | `seats` (the match's `seats()` after a seat status change, sent only when it changed) and `ended` (`{outcomes,ranks}`). No reply. |
| either | `{"op":"error","code","message"?}` | Fatal: `too_large`, `bad_frame`, `timeout`, `invalid_manifest`, `protocol`; the sender closes. |

Calls (seat = `{"team","role"}`; void results are `"data":null`):

| Method | Args | Data |
|---|---|---|
| `create` | `[{seed,teams,options?,alliances?}]` for a new session | `{"tick"}` (initial tick) |
| `step` | `[]` | `{"tick"}`, greater than the previous tick |
| `outcome` / `report` | `[team]` | outcome string / `manifest.report` |
| `view` | `[team,{"snapshot":bool}]` | `manifest.view` |
| `observe` | `[seat,sinceTick,detail]` | `manifest.observation` |
| `apply` | `[seat,intent,context or null]` | `{"ok":true}` or `{"ok":false,"code"}` |
| `events` | `[seat,sinceTick]` | event array |
| `setSeatInfo` | `[seat,{controller,mandate}]` | `null` |
| hooks | `matchData [seat]`, `debugView []`, `observerView []`, `end [outcomes,ranks]`, `forfeit [team]`, `rank [team]`, `clone [newSession]`, `signalLimits []` | as §10; `clone` returns `{"tick"}` of the copy |
| `createBot` | `[seat,opponent,options or null]` for a new bot session | `null` |
| `init` / `think` | `[matchData or null]` / `[observation]` | `null` / intent array |
| `dispose` | `[]` | `null`: the host no longer references the session |

Host operations (`session` is a match created through `createMatch`):

| Method | Args | Data |
|---|---|---|
| `createMatch` | `[{seed?,options?,teams?,alliances?,controllers?,botLevel?}]` | `{"session","tick"}`; the match is not realtime (engine clock) and the host calls `create` before answering |
| `mintSeatToken` | `[session,team,role]` | `{"token"}`: the seat's MCP bearer credential (§5), for its owner only |
| `seats` / `cards` / `readiness` | `[session]` | `seats()` / `cards()` / `readiness()` |
| `setController` / `setMandate` | `[session,team,role,controller or mandate]` | `null` |
| `end` / `forfeit` | `[session,spec]` / `[session,team]` | declared outcomes / `null` (§10) |
| `dispose` | `[session]` | `null`; the host disposes the match and sends its `dispose` call before answering |

The host has at most one `call` in flight on the connection and blocks until its result, so adapter semantics stay synchronous per tick (§10). The engine MUST answer calls at any time, including while its own request is outstanding, and has at most one request (`advance` or `host`) outstanding; a second is `protocol`. Sessions are host-assigned: `s<N>` for match adapters (`create`, `clone`), `b<N>` for built-in bots, which the host forwards to the engine like adapters. The host sends `dispose` for a session once it no longer references it: at once for host `dispose`, and when collected for headless adapters (practice, replay, checkpoints) and bots. A call unanswered within the call timeout (reference default 5000 ms) makes the host send `timeout` and close. When the connection closes, the host MUST dispose its sessions (seat tokens revoked, MCP seats dropped); the reference process then exits. The engine SHOULD move agent and policy seats to its own bots and update disclosure.

**Conformance.** `packages/sidecar/conformance` holds the Tug of War sample (the README game): `tug.manifest.json`, the normalized transcript `tug.transcript.jsonl`, `mock-engine.mjs` (the engine side in plain Node) and the runner `run.ts`. The runner is the reference host plus checks; the engine spawns it over stdio, or it spawns the engine with `PLAYERTHREE_SIDECAR_SOCKET`. The engine sends `hello` with that manifest and no hooks; `createMatch` `{"seed":1,"controllers":{"north":{"puller":"agent"},"south":{"puller":"bot"}},"botLevel":{"south":"easy"}}`; `mintSeatToken` for north/puller; `advance` one tick at a time until the `ended` push; then `dispose`, and closes. The runner holds each engine request to fix the order of ticks and agent calls, seats an MCP agent on north that observes and pulls on the first three ticks, plays on until the south bot wins, checks `unknown_method` and `unknown_session` answers, a call of exactly 1048576 bytes and the engine closing on a 1048577-byte line, and compares the transcript. An engine binding claiming the sidecar MUST pass it.

**Not in protocol 1 (Proposed):** the lobby operations `reserve`, `release` and `capabilities` (§20.4, §20.6), `cards`/`readiness`/`status` pushes, game metric recorders and `botOptions` over the wire, several engines per host, and reconnect without disposal.

**(b) Native ports.** An engine MAY implement the agent surface itself instead of running the host: §§4–9 and §15, the §5 credentials and authorization, and §11 and §13 only if it advertises policy, practice or pool. A port MUST compute `surfaceHash` as §4 specifies and SHOULD pass `playerthree audit --url`. The profile's data (cards, reservations, readiness, descriptors) is identical on both paths.

**Engine samples.** Each engine SDK under `sdks/` ships the Tug of War sample natively, launching the host over stdio, and passes the conformance runner. A `playerthree audit --url` CI job against a sidecar-hosted game is not shipped.

### 20.9 Observers — Implemented

Observer admission MUST create a separate read-only principal, not a player, agent,
team-owner or operator capability. A grant is exactly one of:

```ts
type ObserverGrant =
  | { kind: 'team'; team: string; delayMs: number }
  | { kind: 'omniscient'; teams: readonly string[]; delayMs: number };
```

A team grant MUST remain fixed to that side's actual guarded fogged projection and MUST name a match side.
An omniscient grant MUST list exactly the match's sides (Implemented) and MAY choose `all` or one of them. `all` requires
authorization for every match side. A game enabling omniscience MUST declare
`manifest.observer` and implement `adapter.observerView()` conforming to that
closed schema. The projection MUST contain full battlefield visibility, terrain
and permitted public side economy/production/army state; it MUST NOT be
`debugView()`, an internal simulation dump, or the union of player observations.
Private chat, mandates, approval state, policy source/logs, prompts, credentials
and private owner metadata MUST NOT enter observer data.

The game owns admission, retained player history and frozen room policy. A human
or agent MUST NOT acquire omniscience, including by leaving, reconnecting or
moving to Observers during the same live match, while it can still influence play.
A human player (`mintObserverToken` owner with human player history) keeps its own
side's team grant only, until every team it played is final and none of them has an
alliance member still running (eliminated, forfeited or the match over); from then
on it MAY receive any grant the match's observer policy allows, and an omniscient
grant makes it a broader-view owner (no coaching). A persistent session never
decides teams, so its players never qualify. Immediate omniscience is allowed
only for explicitly admitted private/benchmark observers without player history
or out of play as above.
Public omniscient grants MUST enforce at least 180000 milliseconds of wall-clock
delay; games MAY increase it. Simulated ticks or accelerated execution MUST NOT
shorten it. Existing fixed-team streams MAY retain their separately disclosed
team-perspective policy; they MUST NOT silently become omniscient.

The reference transport uses `playerthree:observer` requests
`{perspective:string,after?:number}` and responses
`{op:"observer",state:"buffering"|"ready"|"closed",grant?,frame?}`. An admitted
grant MAY be sent while buffering; live tick, outcome and completion MUST NOT.
Frames contain `{sequence,tick,recordedAt,releaseAt,perspective,world|delta,outcomes?}`:
`world` is a keyframe (the full projection) and `delta` is an `playerthree/delta`
structural delta from frame `sequence - 1` of the same perspective. A reader gets
one keyframe (join, perspective change, a cursor more than a bounded batch behind
the watermark) and then every released frame as a delta, in order; a reader that
misses a sequence MUST request a new keyframe. Frames carry no per-reader data, so
the server builds and encodes each frame once and fans it out.
The server MUST release only frames with `now >= releaseAt` and MUST use the
same released sequence/watermark for every correlated channel: bootstrap,
terrain, events, resources, commentary, metrics, standings, completion,
replay/downloads, reports, social images and outcome metadata. Commentary MUST
default off and requires independent affected-owner category consent plus
explicit public-sharing consent; vision permission alone never authorizes it.

The buffer MUST detach mutable state, bound bytes and age, reject invalid/stale
resume cursors, and fail closed if required history cannot be retained. Late
joins and reconnects MUST start from retained released frames, never a live
bootstrap. A stopped simulation MUST retain delayed playback through its terminal
watermark; the real end MUST NOT cause a live completion push or shortcut.
Backpressure MAY disconnect or resynchronize to an authorized released snapshot,
never advance to unreleased data.

Observers interpolate between frames, so the reference host records a frame on
every real-time tick (wall-clock capped near the tick rate for accelerated
matches) whenever the stream is delayed or was read within the last few seconds,
and once a second otherwise. Retention defaults to the delay plus 60 seconds.

`mintObserverToken(grant,{owner,ttlSeconds?})` creates a single-use observer
admission ticket. Its TTL bounds the time to claim, not the duration of an active
delayed playback lease: a 120-second admission window MUST NOT terminate a
180-second buffering stream. A claimed lease remains bounded by disconnect,
explicit revocation, retained playback and match disposal; the consumed ticket
MUST NOT authorize a second connection.
`observerMessage(principal,perspective,after?)` reads the authorized history;
trusted server integrations MAY use `observerFrames(grant,after?)` over the same
release clock. Each inbound request and outbound delivery MUST reauthorize the
active lease; active-lease expiry or revocation MUST close existing connections. Observer
transports MUST reject act, tell, mint, mandate, deploy, control and all other
agent/owner operations, and MUST NOT receive live player channels. Agent/player
transports MUST never receive observer frames. Broader-view owners MUST NOT
coach agents in that match. Observer authority MUST NOT imply operator access.

### 20.10 Canonical results and ratings — Implemented

`playerthree/results` publishes the only raw results contract: `playerthree.results`,
version `1`. Existing bench reports, producers, readers and committed fixtures
MUST cut over outright; no legacy input, fallback, alias or conversion is supported.
`arena.ts` defines the closed table row types; `arena-schema.ts` publishes bounded
versioned JSON Schemas and runtime validation for the specs, recorder rows and
envelope. Game-defined metric keys/units and event payloads MUST additionally
satisfy their declared game schemas before recording. Rejected unvalidated
commands, provider response objects and private debug traces MUST NOT be recorded.

`exportStoredResults(record, iterate, format, revision?, sharePolicy?, now?)` streams
the full canonical download of one consistent committed revision, reading raw rows
only through `iterate()` (a `SeriesStore.iterateChunks` snapshot). An envelope
contains the immutable export-safe series spec, exact
resolved match specs, comparison identity, state/timestamps, every schedule row,
every committed attempt (including failures and aborts), logical entrants and
physical side bindings, and the following tables:

| Table | Version-1 columns and meaning |
|---|---|
| `entrants` | Series-local `entrantId`, kind, label, unconditional AI-player label, provider/model and self-report marker, harness/verification, scaffold/artifact/bot identity/options and reset provenance. No owner, roster, member or commander IDs. |
| `schedule` | Trial/scenario/permutation/repetition/index, seeds, map identity/seed/layout, surface/rules hashes, resolved options and side bindings. Pending trials remain visible. |
| `matches` | Match/trial/attempt identity and number, committed revision, terminal status, accepted-attempt flag, timestamps, ticks, simulated/wall durations, terminal reason, side ranks/ties/outcomes (one `OutcomeRow` per side with its `rank`; allied sides — `MatchSpec.sides[].alliance` — share outcome and rank), exact export-safe spec and release watermark. |
| `seats` | Match/side/role/entrant, actual execution/fallback kind, artifact identity, readiness, active ticks, attempted/accepted/rejected commands, command APM and policy errors. |
| `metrics` | Match, exact tick/sequence, match/side/seat scope, side/role, game-declared metric key, finite numeric value and unit. Includes declared economy, army and production time samples and final totals. |
| `causes` | Match/sequence/tick, victim side/plane/kind, nullable attacker side/plane/kind, cause, count and separate resolved alloy/energy values. Environmental, friendly, self, cross-plane and unknown attribution remain distinct. |
| `intents` | Match/side/role/source/rejection-code buckets with submitted/accepted/rejected counts; acceptance code is `ok`. Individual safe attempts/acknowledgements remain timeline events. |
| `decisions` | Match/side/role/decision, start/end, raw latency milliseconds, instrumentation source and status. |
| `usage` | Nullable match, authoring/inference phase, nullable side/role, entrant, pseudonymous execution/decision identities, reporter, nullable input/output/cache-read/cache-write tokens, nullable decimal cost/currency/pricing version and coverage. Failed attempts and policy authoring are included. |
| `events` | Match/sequence/tick/simulated milliseconds, game-declared kind, optional side/role and bounded schema-validated public data. Commentary requires separate disclosure consent. |
| `standings` | Counts, win/score rates, explicit algorithm/implementation/parameters, Elo or TrueSkill mean/deviation/conservative estimate, provisional state, simulated/wall mean durations and seed-block confidence metadata. |
| `artifacts` | Opaque ID, optional match, replay/recording kind, format/version, checksum, byte count, availability and release/expiry. An artifact is not a live-room bearer credential. |

Raw means the complete **declared recorded dataset**, not unrecorded video or
arbitrary provider/debug data. Uncommitted recorder chunks remain private recovery
state until a terminal attempt commits. `activeMatches` is a separate typed
envelope projection of real allocated host match IDs, attempt/trial identity,
start time, exact export-safe spec and release watermark; it never invents a
terminal outcome. Attaching an allocated match commits a new revision and every
update stores its active-match snapshot, so historical JSON/digests remain stable.
Watch requests independently obtain an authorized observer grant before attaching
to the real match stream. Pending allocations without a real match ID are not
watchable. Side economy MUST NOT
be duplicated as per-seat income. Army replacement alloy/energy MUST be separate,
exclude unfinished production, and distinguish structures. Command APM counts
accepted submitted commands per active simulated minute, not clicks or unit
auto-attacks; zero duration is null. Attribution MUST NOT invent an attacker.

Nearest-rank version-1 latency p50/p95 summaries preserve sample count and source;
host call gaps MUST NOT be labelled model think time. Missing tokens/cost are
null, never a fabricated zero bill. Usage summaries distinguish authoring from
inference, currencies/reporters, partial coverage and unknown prices; decimal
money is summed exactly without binary floating-point conversion. Provenance,
per-table cardinality/UTF-8 byte counts, per-attempt chunk aggregates
`{attemptId, chunks, bytes, sha256}` (`sha256` is SHA-256 over the concatenated
lowercase-hex chunk checksums in chunk-index order; a shared projection hashes and
counts its projected chunks instead) and completeness
are exported. `rawComplete` describes persistence of emitted records, not whether
the whole schedule ran. Recording failure MUST make it false with an explanation.

Only accepted `finished`/`forfeit` results are rated. Infrastructure errors and
aborts are not draws. Recompute every revision in canonical schedule-index order;
concurrent worker completion order MUST NOT affect final ratings. Elo applies only to
exactly two single-entrant lineups: initial 1500, K=32, scale=400 and draw score 0.5;
any other match MUST use a declared rank-capable algorithm rather than invent pairwise Elo. TrueSkill uses the
maintained `ts-trueskill` 5.1.0 factor-graph implementation: default mean 25,
deviation 25/3, beta 25/6, tau 25/300, draw probability 0.1, convergence delta
0.0001 and conservative mean minus 3 deviations; an alliance's entrants form one
TrueSkill team ranked by the alliance's shared rank. All effective parameters and the
implementation are recorded. One logical entrant is its lineup, not an invented
causal rating for every seat.

`rateMatch(env, lineups, ratings, weight?)` (`playerthree/results`) is the one
TrueSkill update every rating uses, `standings` included: `env` holds the TrueSkill
parameters, each lineup `{ids, rank, weights?}` is one team at its placement
(allies together) with optional per-member partial-play weights in (0, 1]
(`ts-trueskill` weights, e.g. plane share), and unknown ids start at `env.mu`/`env.sigma`.
The match weight `weight` ∈ [0, 1] (default 1) blends each member's update:
μ' = μ + w(μ_new − μ), σ'² = σ² + w(σ_new² − σ²); 1 is the plain update exactly and
0 changes nothing. `blockBootstrap(blocks)` is the seed-block percentile bootstrap
above for callers that score their own blocks (a game's gauntlet).

Win rate is wins/completed valid games; score rate is `(wins + 0.5*draws)/games`.
Confidence intervals use deterministic percentile bootstrap over whole
scenario/map/seed blocks, retaining all mirror/permutation/repetition outcomes in
their seed block. Method/version, 32-bit LCG seed, 2000 replicates, block count and
95% level are recorded. Fewer than two blocks yields null intervals, not spurious
certainty. Carry-state series are explicitly non-independent and have no
seed-independent interval. Series-local ratings are descriptive; pooling requires
equal game/build/surface/rules/maps, track, budgets, reset and clock semantics plus
an independent admission policy.

Canonical JSON uses sorted object keys, deterministic table primary-key ordering
(primary-key columns, numbers numerically and other values by canonical JSON text,
then the row's canonical JSON), finite numbers, explicit null and UTC timestamps.
`resultsDigest(envelope)` is SHA-256 of the exact UTF-8 canonical JSON download,
including format/version and revision; no self-referential digest field is
inserted. `exportStoredResults` emits JSON byte-identical to
`canonicalJson(envelope)` or a deterministic UTF-8 ZIP containing one RFC-4180 CSV
per table, `schema.json` (columns, closed schemas, keys, units and conventions),
`spec.json` and `manifest.json` (revision metadata, accounting and canonical JSON
digest). Memory is bounded for the 2 GiB-per-series limit: canonical ordering never
assumes raw append order but uses an external merge sort whose sorted runs hold at
most 4 MiB, merged at most 16 at a time, in a private `os.tmpdir()` directory that
is removed when the stream completes, fails or is abandoned. Exact latency
quantiles use the same external sort over every sample in a second pass.
Structured cells are canonical JSON. CSV null is `\N`; a literal leading
backslash is doubled, and otherwise strings beginning with `=`, `+`, `-`, `@`,
TAB, CR, LF or apostrophe gain one apostrophe. Decode using the column schema:
the exact `\N` cell is null, otherwise undo one leading escape. This is reversible,
prevents formula execution, and does not alter canonical JSON metadata.
`serializeResultsCsv(envelope)` writes the same files for an already materialised
envelope (CLI report writers).

`buildResultsSummary(record, iterate, revision?, sharePolicy?, now?)` returns the
bounded live view `ResultsSummary` (`format:"playerthree.results.summary"`, version
`1`, schema `RESULTS_SUMMARY_SCHEMA`): the envelope's top-level shape, with every
table present, plus `sampling:{limit, tables:{<table>:{rows, included, method}}}`.
`rows` is the full count; `method` is `complete`, `sorted_prefix` or
`stride_per_series`. The bounded metadata tables (`entrants`, `schedule`,
`matches`, `standings`) are complete; each recorded table keeps at most `limit`
(2000) rows: `metrics` evenly strided per (match, scope, side, role, metric) series
across its tick range so charts span whole matches, other tables as their canonical
prefix. Summaries, accounting, completeness and retention are exact over all rows,
computed in at most two bounded passes. Full exports and summaries share one row
projection and sanitisation path, including the shared projection.
`SeriesRunner.results` returns this summary; `SeriesRunner.previewShare(owner, id,
policy)` returns the exact shared summary a share would publish; only
`SeriesRunner.export` streams raw rows.

### 20.10.1 Commander match log — Implemented

The host writes one append-only entry (`playerthree.commanderLog`, version `1`, types in `playerthree/results`) per match × named commander, from host-observed facts only. A commander holding several lanes of one team gets one entry. Entries are written once per match: when it is over (final outcomes and ranks), else when it is halted or disposed (`outcome:"unknown"`, `disposition:"interrupted"`, or `"aborted"` before the first tick). A commander replaced or revoked before the end is logged `unknown`/`interrupted`; its team's outcome is not its result. Practice runs are not logged.

- **Identity:** `entryId`, per-commander `seq` (from 1), `prevDigest`, `digest`; `game`, `gameVersion`, `surfaceHash`, `matchId`; `host {origin, keyId, official}`. The commander appears only as its public id `commanderPublicId(game, commanderId)` (`c_` + 20 base64url characters of SHA-256 over `playerthree/commander-public\0<game>\0<commanderId>`); its private id and owner never appear in the signed entry.
- **Game facts:** `CreateMatchOptions.log` supplies `mode`, `queue` (game vocabularies; bounded labels), `rulesHash`, `customRules` and `map {id, identity, seed, size, layout}`; absent facts are `custom`/`null`/`false`. The entry also carries the secret match `seed` (entries exist only once the match is over or released) and `selfPlay` (`sameOwnerOpposed`).
- **Seats and lineup:** `seats[]` with tenure ticks, `planesControlled`, `planesTotal` (the manifest's role count), `planeShare`; `lineup[]` (this team's seats: role, kind, `sameOwner`, and the public id only for the same owner's commanders); `opponents[]` (hostile teams with rank and seats: role, kind, public commander id or null, bot level, SHA-256 of bot options, policy version and `artifactHash` of commander policies).
- **Control** (host accumulator over the match; intervals equal a re-derivation from the replay's `seat` entries): `control[]` per role, `ownerIntents` (accepted owner intents on the team), `ownerTells` (owner messages delivered to the team's seats), per role `fallbackTicks` (fallback bot for an absent agent), `absentPolicyTicks` (the deployed policy for an absent agent), `pausedMs` (wall clock: the simulation stands still while paused), `acceptedIntents` (agent/policy); `assist` (`takeover` if any team seat was human-controlled, else `owner_intents`, `owner_chat`, `none`); `fallbackShare` = max over the commander's roles of (fallback + absent-policy ticks for agents) / held ticks; `policies[]` (version, runtime, `surfaceHash`, `artifactHash` per role at the end), `policySwitches[]`, `executionKind` (`policy`, `live`, or `mixed` when an agent had fallback or absent-policy ticks), `harness {label, verified:false}` from the transport's annotation (no harness is verified).
- **Result:** `outcome` (`win|loss|draw|unknown`), `disposition` (`final|forfeit|abandoned|interrupted|aborted`; `forfeit(team, {abandoned:true})` marks an abandon), `rank`, `terminalReason` (`game`, `declared` by `end()`, `forfeit`, `abandoned`, `released`), `ticks`, `simSeconds`, `wallMs`, `startedAt`, `endedAt`, `replayRef {session, digest, kept}` (`digest` = SHA-256 of the canonical replay JSON; it survives replay pruning).
- **Verdict:** the game's `commanderLog.verdict(context)` (sync or async; context = private commander id, trusted owner, the declared-metadata snapshot, entry draft) returns `{rated, pool, segmentId, weight∈[0,1], badges[], reasons[]}` (bounded labels), stamped before digesting and signing. Without a hook, or on failure, the entry is unrated. A later verdict change is a separately signed `CommanderLogVerdictRow` (`commanderLog.amend(entryId, verdict, reason)`), never a rewrite; `effectiveVerdict` applies the newest.
- **Sealed part:** `{salt, ownerRef, name, declared, usage}`, owner-only; the entry's `sealed` is SHA-256 of its canonical JSON (the random salt keeps low-entropy values such as model names from being guessed). `declared` is the owner's metadata snapshotted when the seat was prepared; later edits never rewrite it. `usage` sums self-reported decision usage with the worst declared coverage; absent reports stay absent. Deleting a commander or owner tombstones its entries (sealed part dropped); the signed entries, the chain and opponents' rating inputs remain.
- **Digest and chain:** `digest` = SHA-256 hex of `canonicalJson(entry without digest and sig)`, which covers `prevDigest`. Entries complete one at a time in issue order, so each commander's chain is linear with an async verdict or store.
- **Signature:** with `commanderLog.signer` (Ed25519, `parseResultsSigner` reads PKCS#8 PEM or single-line base64/base64url DER) the host is official: `host.official:true`, `host.keyId` = `k_` + 16 hex of SHA-256 over the SPKI DER public key, `sig` = base64url Ed25519 over `canonicalJson(entry without sig)`. Without a signer entries are unsigned and `official:false`. A game decides who may configure a signer.
- **Verification:** `verifyCommanderLog(entries, keys, sealed?)` checks one commander's contiguous segment in seq order (a full log starts at seq 1 with a null `prevDigest`): format, digest, chain, and the signature under a published `ResultsKey {keyId, publicKey (SPKI DER base64url), from, until, revokedAt?}` valid at the entry's `endedAt`; optional owner sealed parts must match their commitments. Failures name the first bad index and the reason (`format`, `digest`, `chain`, `unsigned`, `unknown_key`, `signature`, `sealed`). `verifyVerdictRow` checks amendments.
- **Storage:** `CommanderLogStore` (`heads`, `append`, `entries`, `match`, `all` in `(endedAt, matchId, commander)` order, `appendVerdict`, `verdicts`, `redact`): `commanderLog.store`, else JSONL at `<dataDir>/commander-log/<game>.jsonl`, else memory; PostgreSQL `storage.commanderLog(game)`. Insert only: (commander, seq), (match, commander) and entry ids are unique; `redact` is the one rewrite and clears only sealed parts. `PlayerThreeHost.commanderLog` reads it for the game; owners read their own commander's full entries with `commanders.log(owner, id)`.
- **Records:** `CommanderStatus.record {wins, losses, draws}` counts the log's decided, non-self-play entries. Commanders store no win/loss/draw counters; stored commanders that still carry `stats` are refused (reset).
- **Artifacts:** `StoredPolicyArtifact.artifactHash` and `CommanderPolicyVersion.artifactHash` are SHA-256 hex of the module bytes (the composed JS source as UTF-8, or the decoded WASM module), computed at deploy (`policyArtifactHash`).

### 20.11 Series execution, durability and disclosure — Implemented

Series tracks are `bots`, `policy`, `live` and `gauntlet` (a frozen policy entrant against fixed built-in bot references; the game admits only policy lineups and keeps its results out of ratings).

PlayerThree owns the reusable series runner; games own match allocation/simulation,
seat binding and UI. Freeze and validate the full schedule and resolved specs,
capabilities, seeds/maps/layouts, rules/surface identity, reset policy, budgets,
artifact/scaffold versions, consents, connector lanes and recording quotas before
spending model budget. Display labels and worker count do not change comparison
identity; clock semantics and effective contention are disclosed. Human matches
MUST NOT accelerate; accelerated live or decision-barrier execution is a distinct
comparison identity, not silently equivalent to realtime.

Trial identity is series/scenario/permutation/repetition; attempt identity adds
attempt number. Bound concurrency by capacity and independent connector lanes.
Reset conversation/scratch state between matches unless explicit carry-state is
declared, with externally unverifiable reset labelled declared. Retry only
declared infrastructure errors, at most the frozen retry limit (default one),
using the same frozen spec and fresh isolated bindings. Model timeout, invalid
policy, budget exhaustion and gameplay loss MUST NOT be infrastructure retries.
Never cherry-pick a better attempt or erase failed-attempt usage. Owner abort
stops pending starts, signals active simulations, awaits cleanup and commits
partial results; unfinished games are not draws. Process shutdown (the reference
runner's `close()`) is not an owner abort: it stops scheduling, signals active
simulations, commits each interrupted match as an `infra_error` attempt
(`shutdown`) of the same trial, leaves the series non-terminal and releases its
lease, so the next process's `start` resumes it within the frozen retry limit.

Persist immutable specs/schedule, active attempts, ordered SHA-256 checked chunks,
artifacts, revisions and updates in `SeriesStore`. Commit terminal result,
accepted-attempt selection, standings and stream update in one revision-CAS
transaction; `(series, trial)` has at most one accepted attempt. Emit only after
commit, with monotonic revision/resume cursor and consistent snapshot recovery.
The owner receives provisional standings after **each match completion**, not
only after a model run. Execution leases fence attempt/chunk/artifact writes and
commits against stale workers. Process death/expired lease recovery marks
unrecoverable attempts `infra_error`, releases bindings and follows the frozen
retry/abort policy; it is not restoration of a non-checkpointed live simulation.

Configured production uses PostgreSQL via the existing scoped SQL migration and
transaction mechanism. Local JSON storage is an explicit single-process choice,
using ordered journaled atomic renames and bounded chunk/artifact files. It MUST
NOT silently replace a failed configured database. Failed durable writes stop
scheduling; a recording failure exports `rawComplete:false` with missing-data
reasons, never a complete benchmark. Retention, per-match/series/owner quota and
expiry are enforced; required raw rows MUST NOT be silently truncated. A hard cap
causes an explicit `artifact_limit` abort retaining all safely collected data.

Owner downloads and shares use the same export-safe projection: no private
roster/owner/member/commander refs, credentials, API endpoints, prompts, policy
code or debug traces. Seat occupant refs become execution kind and series-local
entrant identity; execution IDs are deterministic series-scoped pseudonyms.
Commentary is off by default for shares and requires both an explicit share
choice and current recorded consent for every contributing entrant. Withdrawal
revokes commentary-bearing share generations atomically.

Share tokens contain at least 192 random bits; persist only SHA-256 digest plus
series, generation, policy and revocation metadata. A new share gets a new token;
revoked/expired/unknown links have the same not-found behavior. Share expiry MUST
NOT exceed result retention. Snapshot/stream/JSON/CSV/image/artifact authorization
all recheck the active generation and release watermark. A delayed viewer sees a
revision only after **all** contributing attempts/data in that revision are
released; hiding rows while leaking counts, terminal state or ratings is invalid.
Owner-private live updates are independent of public delay. Shared pages/images
contain only the allowlisted projection, use no third-party assets, and MUST
disclose that revocation cannot erase downloaded copies or social-platform caches.

### Fixed-reference benchmark publications — Implemented

`playerthree/benchmark` defines versioned suites, experiment identities, independent
authoring runs and a minimal public evidence projection. The benchmark coordinator
MUST use `SeriesRunner` for all evaluation scheduling, attempts and infrastructure
retries. Suite identity excludes the candidate model but pins its evaluation
schedule, reference artifacts/builds, controlled roles, harness, budget, scoring and
explicit scenario-to-world-block assignment. Every authoring replicate gets a new
isolated environment and a budget shared only by that run's roles.
Common-harness campaigns MUST match system harness identity to the suite's
versioned harness and verify source-byte digests of the game and runner inputs
before execution. Dirty source bytes are part of identity; a game version or
surface hash alone does not identify engine implementation. Operators MUST
review source/dependency input coverage; these hashes do not attest an arbitrary
uploaded build or provider's hidden weights. Different harnesses require separate
suites, not mixed primary model scores. The reference coordinator authors through
one of two harnesses, selected in private campaign configuration, and the suite's
`harness` MUST equal the selected one's identity: `@playerthree/runner`'s own loop
(the default; `{id:"playerthree-run", version:<runner package version>}`,
`RUNNER_HARNESS`), or OpenCode run headless (`{id:"opencode", version:<the
version the binary reports>}`, read from the binary before any authoring).

A replicate's controlled roles are one persistent lobby commander: one model
session commands every role and deploys one policy per role. The optional
`authoring.starters` (role → starter path) deploys each named role's starter by
reference with its default knobs before the wall clock starts, so every such role
has an active policy from the first model turn; these deployments are the
harness's, not model turns, and enter the deploy timeline as such. The optional
`authoring.brief` (1–4096 characters) is the series' own statement of how its
frozen policies are evaluated (rules, opponents, maps, scoring); every authoring
session's brief, under either harness, MUST carry it, so the model knows what
its practice should match. The optional `authoring.systemPrompt` (1–4096
characters) MUST be the model's entire system prompt in every authoring request,
under either harness and for every provider: the harness's own system prompt
never reaches the model, and the session brief then opens the conversation as
its first user message. Harnesses and their prompts move scores, so a suite
that fixes the prompt compares models under the same words. The suite
publishes it as `authoring.systemPrompt: {text, digest}` (`digest`: SHA-256 hex
of the UTF-8 text, `systemPromptDigest`); validation rejects a digest that does
not match, and a suite without one keeps its digest. The optional
`authoring.contextTokens` (an integer above `maxOutputTokens`) is the one context
window every model's conversation is compacted against by a harness that
compacts (OpenCode), capped at a model's own window (`BenchModel.contextTokens`)
when that is smaller: how often a model's history is summarized then depends on
its work, not on its window. The suite publishes it as `authoring.contextTokens`.
The optional `authoring.reasoning` (`low`, `medium`, `high` or `xhigh`) is the one
reasoning effort every authoring request asks for under either harness, each
mapping it to its provider's own field (OpenCode's proxy: Chat Completions
`reasoning_effort`; the runner: OpenAI Responses `reasoning.effort`, Anthropic
adaptive thinking at `output_config.effort`). Without it each route applies its
own default, and defaults differ between providers and routes. The suite
publishes it as `authoring.reasoning`. An authoring lobby's MCP endpoint serves
the authoring server instructions (§3 *Control modes and limits*), and the harness's status line
names each role's active version (and whether the harness pre-deployed it), not a
starter file.
Once authoring ends (deadline, ceiling or stop), the lobby refuses further deployments, rollbacks
and practice (`mode_unavailable`), so a call an external harness still had in
flight cannot change what is frozen.

The OpenCode harness runs `opencode run` in a fresh isolated home and an empty
working directory, reaching the game only through the `playerthree-mcp` stdio
bridge with the commander's credential. It denies bash, web fetch, web search,
files outside its working directory and the game's live-play tools (act,
sequence, publish). The model's provider requests pass through a loopback
metering proxy that alone holds the key: it adds the model's private request
extras (router pinning), replaces every system and developer message OpenCode
sends with the one `authoring.systemPrompt` message when the series fixes one
(messages and tools otherwise untouched), asks for `authoring.reasoning` as `reasoning_effort`, caps each reply at `authoring.maxOutputTokens`, buffers
each reply whole, charges it against the run's ceilings and withholds a reply
whose charge crosses one (so its tool calls never run), and records the upstream,
generation id, cached input tokens and cost the router reports. A turn is charged
its actual cost: the router-reported cost on the reply (OpenRouter `usage.cost`),
else that generation's `total_cost` looked up by its id, else a cache-aware
estimate at the frozen prices (cached input at `price.cacheReadPerM`, default the
input price). Its usage row is `reported` (pricing `router-reported`) or `runner`
accordingly, and a run's public cost `source` is `router-reported` only when every
priced turn was. When an
`opencode run` ends before the deadline, the harness continues the same session
with the time left and the seat's status (active version per role, last practice
result), and nothing else (`continuationPrompt`). OpenCode compacts the session
against `authoring.contextTokens` (default 250,000, capped as above); the
synthetic user message it adds after a compaction ("Continue if you have next
steps, or stop and ask for clarification…") never reaches the model: the proxy
replaces it with `continuationPrompt` as of its first forwarding, and its quotes
inside a summarizer request's history with the time-free `[harness]` line. The
summarizer request carries the series system prompt like every other. OpenCode's
tool-output limits sit above the game's result cap, so it never truncates a game
result. OpenCode marks prompt-cache breakpoints (`cache_control`) on its system
messages and on its last two messages, on the message itself; the proxy moves a
dropped system message's mark onto the series prompt's text part and the mark of
a plain-text user or system message onto its text part. A router that translates
to Anthropic Messages (OpenRouter) reads only part-level marks on such messages,
so the first request of every `opencode run` (whose only marked messages are the
previous reply and the new prompt) read and wrote no cache before. A run that
completes no model turn is retried after a pause; three such runs in a row end
authoring as a provider failure (infrastructure when no turn ever completed).
Authoring by any harness that reaches its deadline without one completed model
turn is infrastructure too, never a scored cutoff: its frozen artifacts would be
the pre-deployed starters, not the model's work. A failed provider request is an
error status, an unreachable provider or an error event inside a 200 reply.

A model may declare `billing: "openrouter-key"`: its router key's cumulative billed
usage (`GET <baseUrl>/v1/key`) is read before authoring and polled during it, and
authoring stops as `budget` once the billed delta reaches the per-run cost
ceiling, whichever of the measured estimate or the billed delta gets there first.
Key usage is account-wide, so concurrent use of the key counts against the run;
the ceiling stays conservative, never lax.

The private authoring ledger additionally records, per attempt, the harness
identity, wall time, model turns, failed provider requests, input and output tokens, router-reported cost
and billed key delta where available, every practice run (opponent, seed,
outcome), the deploy timeline (each starter pre-deploy, deployment and rollback
with role, version and source digest) and each frozen role's artifact digest.
Evaluation writes each run's canonical results and the replays still available in
that process under `results/<run-id>/`.

Authoring has no early exit: a tool-free model turn never ends a replicate's
authoring. The harness answers it with the seat's policy status (active version or
none, last practice result) and authoring runs until its frozen turn, token, cost
or wall ceiling; the policy active then is the frozen artifact. A reply cut off at
the output cap is not a stop either: a tool call it cut short never executes, and
the model is told so. Everything a harness itself says during authoring (brief,
continuation, cap note) states rules, limits and status only, never strategy
advice: a model that ends its turn more often would otherwise be coached more
often. The game's own briefing, server instructions and skills are game content.
Before the first attempt an invocation would author, the
coordinator probes the model's route with one tool call carrying string, array and
code arguments next to a required enum (the tool-argument preflight). A route that
drops or changes them fails the invocation before any attempt is recorded; an
unreachable route (network failure, 408, 429, 5xx) is left to authoring, whose
provider outages are infrastructure. Routers are pinned per model in private
execution configuration (extra provider request fields, part of the execution
digest). Each model session leaves a private JSONL transcript: a session header
(harness, phase, model, request extras, output cap, system prompt, tool names),
then every runner-authored prompt and owner message, each model reply with its
tool calls and usage, every tool result as the model received it, and the stop
reason, never credentials. The private authoring ledger names the attempt's
transcripts, its harness, its preflight result and the upstream that served each
turn (`servedBy`: turns per upstream). Where a reply does not name its upstream but
carries a router generation id (OpenRouter's Responses API), the runner records
the id in the transcript and the upstream is looked up by it after the attempt,
with the model's own key from its environment variable, never logged; turns whose
upstream stays unknown are counted (`servedByUnresolved`), never guessed.

Frozen policies are committed before evaluation and survive process interruption.
Only model-caused authoring failures are zero-score runs: no valid artifact
within the frozen token, turn, cost or wall ceilings, or a non-transient provider
rejection after at least one completed turn. Infrastructure failures leave the
replicate pending and unscored, never zero: a missing credential (checked before
any authoring starts), environment or harness setup exceptions, any provider
failure before the first completed turn, provider timeouts (408), rate limits
(429), server errors (5xx) and network failures, and operator or process
interruption. A later invocation re-authors a pending replicate in a fresh
environment with a fresh budget. A replicate gets at most
`1 + execution.maxInfraRetries` authoring attempts; every attempt, its outcome
and spend stay in the private campaign ledger, and the public run records its
attempt count. The per-run budget is hard: a turn whose measured usage crosses a
ceiling is charged but its tool calls never execute, so the frozen artifact is
the latest one deployed within budget. An optional campaign spending ceiling
counts recorded spend plus the full per-run cost ceiling for each attempt of
unknown spend; no attempt starts that could cross it. While an earlier replicate
can never complete (authoring attempts or evaluation retries exhausted), the
coordinator authors no further runs. Operator interruption of evaluation closes
the runner (above) instead of aborting the series; resume re-evaluates the same
series, trials, world seeds and artifact. Missing evaluation trials make the
whole campaign incomplete with no final score. Infrastructure retries retain the
same trial, world seed and artifact. Tick-cap draws are an explicit suite
adjudication.
The weighted mean is averaged equally across declared runs. Crossed bootstrap
resamples runs and shared world blocks, retaining rotations and fixed stratum
weights. It is descriptive uncertainty, not a multiple-comparison superiority test.

Publication is a separate, explicit consent operation with independent retention,
not a public series share. Only allowlisted identifiers, artifact digests, trial
adjudications and coverage-aware cost summaries enter its closed JSON contract.
Prompts, credentials, endpoints, commentary and source code are excluded. Cost
estimates are not bills; missing/partial cost never becomes zero.
Pricing convention/version and its as-of date are frozen explicitly, separately
from run timestamps and model-specific numerical rates. Private authoring usage
evidence retains rates and measured calls, including failed calls with unknown
usage. Public cost scope is authoring only, not evaluation compute or invoices:
it covers the attempt that produced the replicate, while infrastructure-failed
attempts' spend stays in the private ledger. A publication id derives from its
public evidence body (suite, public experiment, runs, score, consent), never from
private identity; re-exporting identical evidence keeps its id and first
timestamp, and new evidence gets a new id. Without attribution consent the system
identity is redacted and `executionDigest` is `null`, since a digest of a guessable
provider/model/price configuration would re-identify it.
Imports validate hashes and recompute scores but do not attest authorship or
execution. Trust is
assigned by the importing operator outside the downloadable payload. Publication
withdrawal keeps a tombstone; downloaded copies cannot be recalled. Live command
and decision-barrier attestation are outside this authored-policy protocol.

### 20.12 Example flows

**Asynchronous board game.** Sides `white`, `black`; role `player`; `ready.mode:"turn"` with a 24-hour turn. Alice opens a game: `reserve` a new session with `white` as her `human` seat and `black` left open. Bob, browsing open games, takes `black` for his roster commander: `reserve` on the existing session with `kind:"agent"`, `route:"roster"`. Whenever `awaiting()` names `black`, its readiness is `waiting` until Bob's agent is present; his `async` descriptor matches the lobby. If the turn deadline passes, `whenAbsent:"policy"` plays a validated library policy, or the game applies its forfeit rule. Both players see "AI player · Bob · Codex (unverified)"; the result goes to the agents-allowed ladder.

**Co-op persistent world, drop-in companion.** One side `party`; roles include `companion`; `ready.mode:"none"`. Carol is already playing. Her lobby's "bring my companion" button reserves `party/companion` in the existing session with `kind:"agent"`; the seat changes from `none` at the next tick boundary and is recorded. The companion shares Carol's party perspective, which the game declares as parity for that role. Other players see its card; coaching is `owner`. When Carol leaves, the game releases the seat, and `whenAbsent:"bot"` covers any gap.

### 20.13 Conformance checklist

An integration claiming this profile MUST:

1. Map lobby kinds to wire controllers as §20.1 specifies and record every seat fill or vacate as a controller change.
2. Produce identity cards with the unconditional AI-player label, self-reported model marking, unverified-harness marking and no owner identifiers, tokens or agent-bound player text.
3. Attach roster commanders only through the game's authenticated owner and §5 consent, and refuse agent credentials on every lobby operation.
4. Implement atomic, expiring reservations for new and existing sessions, with closed codes, per-seat human join tokens and data-only agent connect instructions delivered only to their owner.
5. Run activation validation (recorded surface hash plus in-session probe) whenever a saved artifact activates, and never report a stale or failed policy ready.
6. Support the readiness modes it advertises (at least `none`) and show fallback reality on cards.
7. Publish capability descriptors with a closed latency class and no model or owner identity.
8. Declare and show fair-play rules; enforce perspective parity, coaching restrictions and ranked separation or labelling.
9. For a sidecar, use the §20.8 framing on an OS-user-only local channel; for a native port, compute `surfaceHash` per §4.

### 20.14 Open questions

- **Concurrent sessions:** use distinct named IDs with independent-session isolation; one ID may span compatible roles only within one match/team, never steal an existing lane or span opponents.
- **Dynamic seat sets:** MMOs and large party games may exceed a declared side × role set; seats created at runtime are not specified.
- **Policy compatibility:** an exact hash match invalidates every saved artifact on any surface change. Compatibility hashes (§13, Proposed) could narrow this.
- **Measured latency:** how to measure it, over what window and how it resists gaming.
- **Model disclosure:** BYOM gives no verification path beyond self-report.
- **Credential shape:** whether per-seat human join tokens replace or sit beside per-side owner tokens.
- **Identity linking:** how platform identities map to rosters across several hosts of one game.
- **Sidecar scope:** multiple engines per host process, reconnect without disposal, restricting a Windows named pipe to the server's user, and `awaiting?` versus turn events.

## 21. Durable storage — Implemented

The host keeps commander, connection, pool and history data behind their existing store interfaces. Series execution adds `SeriesStore` (`playerthree/arena`): its committed durable state, not an optimistic in-process copy, is authoritative for results. Host stores may be in memory, JSON files, PostgreSQL (`playerthree/postgres`), or a game implementation; an explicit store option wins over its directory option. A series MUST select a durable backend explicitly. Configured production PostgreSQL failures MUST NOT silently fall back to files or memory.

| Store | Holds | Host option | JSON-file layout |
|---|---|---|---|
| `CommanderStore` (`playerthree/host`) | Host key, named commander rosters, library artifacts | `commanderStore`, else `dataDir` | `<dataDir>/commanders/<game>/commanders.json`; `artifacts/<owner>/<commanderId>/<version>.json` |
| `ConnectionStore` (`playerthree/mcp`) | OAuth connections (token digests only), registered clients | `createAuthorizationServer({store})`, else `dataDir` | `<dataDir>/oauth/<game>/connections.json` (mode 0600) |
| `PoolStore` (`playerthree/host`) | Pool entries (publishing principal, disabled flag, counters) and their artifacts | `poolStore`, else `poolDir` | `<poolDir>/pool.json` (`{version:1,entries}`; other games' entries in the directory are kept); `<poolDir>/<id>.js\|wasm` |
| `CommanderLogStore` (types `playerthree/results`; `memoryCommanderLogStore`, `jsonlCommanderLogStore` from `playerthree/host`) | Signed, chained commander match log entries, their sealed parts and verdict rows (§20.10.1) | `commanderLog.store`, else `dataDir` | `<dataDir>/commander-log/<game>.jsonl` (one `{entry}` or `{verdict}` per line, 0600; a tombstone rewrites the file atomically) |
| `HistoryStore` (`playerthree/host`) | Released session records (with match `teams`, `alliances`, per-team `outcomes` and `ranks`) and kept replays | `history.store`, else `history.dir` | `<dir>/<session>.json` (`{format:"playerthree.session",version:1,record,replay}`) |
| `SeriesStore` (types `playerthree/arena`; `jsonSeriesStore`, `SeriesStoreError`, `seriesChunkJson` from `playerthree/host`) | Immutable accepted specification/schedule, attempts, per-attempt chunk counts/bytes, raw chunks/artifacts, revisions, standings, execution lease and digest-only share generations | runner `store`; `storage.series(game)` or explicit `jsonSeriesStore(dir)` | `<dir>/series.json` (metadata only), `journal.json` while committing, `<series>.<attempt>.<index>.chunk.json`, `<series>.<artifact>.artifact` |

**Data reset.** Session records and replays stored before per-match team subsets (records without `teams`/`alliances`/`ranks`, replays without `teams`) are not readable; there is no converter. Reset with `DELETE FROM playerthree_sessions;` (PostgreSQL) or delete the JSON history directory.

`StoredSeries` is metadata only: `get`, `list` and `recoverable` never return raw rows or per-chunk manifests; `chunkStats` holds one `{attemptId, count, bytes}` entry per attempt that appended chunks (bounded by attempts). Raw rows are read only through `iterateChunks(id, revision?)`, an `AsyncIterable<StoredResultChunk>` (`{attemptId, chunk, committedRevision}`): every iteration snapshots the attempts committed at the requested (default current) revision, then yields their chunks in schedule-index/attempt-number order and chunk-index order, one checksum-verified chunk at a time, outside the metadata transaction. Active (uncommitted) attempts are never yielded; an unavailable revision, a missing chunk or a payload whose SHA-256/byte count no longer matches rejects. `playerthree/arena` is a types-only module (no Node or DOM runtime dependency), so browser packages may import it.

### 21.1 Ordering and failures

- Commander, connection, pool and history methods MAY be sync or async; their owning components issue writes in order. `SeriesStore` methods are async and serialize transactions in issue order. PostgreSQL series transactions additionally hold a game-scoped transaction advisory lock, protecting cross-process quota admission and per-series revision/lease changes.
- Existing host best-effort write reporting does not constitute series durability. A failed `SeriesStore` operation MUST reject, stop further scheduling and trigger cleanup. Only committed results may be published. Recording failures persist `rawComplete:false` with an explicit missing-data reason if the store is writable; they MUST NOT be presented as complete benchmarks.
- `PlayerThreeHost.ready` resolves once the commander, pool and history stores have loaded and rejects, never hangs, if any load fails; `AuthorizationServer.ready` does the same for connections. A game SHOULD await both before serving. Sync stores load during construction; commander tokens do not authenticate before their store has loaded.
- Pool entries and history records are held in memory; a pool artifact or a replay is read from its store when needed, after pending writes. Pruning the history by its bounds deletes from the store, including records loaded at startup.
- JSON-file writes are atomic (temp file + rename); loading removes temp files of interrupted writes. Owner ids, roles, pool ids and session ids are pattern-checked before they become path components.
- Stores hold credential-equivalent material (the commander host key, token digests) and MUST be protected like credentials (§15).
- One host process per game owns live host state. Local series files support one process per directory, not distributed transactions. PostgreSQL series leases coordinate execution admission and expired-lease recovery only; they do not restore a live simulation.

### 21.2 PostgreSQL — `playerthree/postgres`

`openPostgresStorage({url, max?, migrations?})` connects with the `pg` driver (pool size `max`, default 10), applies pending migrations, and returns `commanders(game)`, `connections(game)`, `pool(game)`, `history(game)`, `commanderLog(game)` and `series(game)` stores, `query(text, params?)` for parameterized SQL on the game's own tables, and `close()`. One store object per kind/game preserves issue order. `close()` drains queued operations before ending the pool. The connection string is never logged. Series queries use this pool and existing SQL execution machinery, not a second ORM/schema source.

Migrations are plain SQL files named `NNN_name.sql`, applied at startup in name order, each in its own transaction, while holding a PostgreSQL session advisory lock so concurrent starts never apply one twice. Applied files are tracked in `playerthree_migrations(scope, name, applied_at)` with primary key `(scope, name)`. PlayerThree's own files ship in the package (`src/postgres/migrations/`) under scope `playerthree`. A game passes `migrations:{scope, dir}` for its own tables; they apply after PlayerThree's, under the game's scope, which MUST NOT be `playerthree`. A failing migration rolls back, is not recorded, and fails the open.

Every PlayerThree data table is game-scoped. Host tables are `playerthree_commander_keys`, `playerthree_commander_owners`, `playerthree_commander_artifacts`, `playerthree_oauth_connections`, `playerthree_oauth_clients`, `playerthree_pool_entries`, `playerthree_pool_artifacts`, `playerthree_sessions`, `playerthree_commander_log` and `playerthree_commander_log_verdicts`. Commander artifact identity is `(game,owner,commander_id,version)`, never owner×role.

Fixed-reference benchmark publications (§20.11) use `playerthree_benchmark_publications` (`postgresBenchmarkStore` in `playerthree/benchmark-store`; `jsonBenchmarkStore(dir)` locally).

Series tables are `playerthree_series`, `playerthree_series_trials`, `playerthree_series_attempts`, `playerthree_series_result_chunks`, `playerthree_series_artifacts`, `playerthree_series_updates` and `playerthree_series_shares`. A partial unique index permits one accepted terminal attempt per trial. `commitMatch` checks the expected series revision and atomically writes the terminal attempt, raw-chunk additions, standings/update and new revision; identical duplicate commits return the original revision and conflicting callbacks reject. Chunk keys are ordered/idempotent; each row stores the exact canonical chunk JSON as `payload` text with its SHA-256 `checksum` and UTF-8 `bytes` (checked by constraint), and series records keep only per-attempt counts. Chunk reads are single-row queries without the series advisory lock. Artifact payloads have independent checksums and manifest rows. Indexed expiry pruning deletes at most 100 series per invocation, cascading all dependent rows and shares. A database whose chunk table predates `payload` is rejected as an obsolete schema (explicit operator reset).

`claim`, `release`, `beginAttempt` and `recoverable` persist execution leases and active attempt identities. Only expired or released leases may be reclaimed; a restart resolves active attempts under the stored infrastructure retry/abort policy before starting fresh isolated bindings. `beginAttempt`, `appendChunk`, `putArtifact` and `MatchCommit.leaseHolder` require the live execution holder, fencing writes from a replaced worker. Execution-driven `transition` supplies its fifth `leaseHolder` argument; intentional owner/admin transitions omit it. Transitions record their own monotonic update and preserve the previous release watermark. Results/updates are never emitted before commit.

`attachMatch(id,expectedRevision,attemptId,matchId,releaseAt,holder)` commits a leased active attempt's actual match identity and disclosure watermark, increments revision, and writes an export-safe `SeriesUpdate.activeMatches` snapshot atomically. Every transition and terminal commit persists the exact active set for its revision; completion removes only that finished attempt while historical snapshots stay unchanged. Active match discovery is part of the same canonical result/update contract, not an independently mutable live source. Public consumers MUST withhold its revision until the committed release watermark permits disclosure.

`jsonSeriesStore(dir)` is an explicit local backend with shared in-process issue ordering, mode-0600 files, fsync, atomic temporary-file/rename writes and a revision journal. Journal replay completes interrupted chunk/artifact/index commits before any read. Corrupt/obsolete records and corrupt/missing raw chunks reject; the store does not skip them. Byte limits are checked before journal/SQL commit: configurable per-chunk, per-attempt, per-series and per-owner caps, plus active-series admission. Quota errors are explicit `artifact_limit` outcomes, not silently truncated exports. Expiry and owner deletion revoke access to raw artifacts and every share generation.

Shares store SHA-256 digests only, with store-allocated monotonically increasing generations; plaintext random 192-bit tokens exist only in the owner response. Re-sharing revokes the previous active generation in the same transaction; revocation, expiry and deletion stop future origin access. Unknown, expired and revoked lookups have the same absent result. The same current generation/policy authorizes page, update, export and image routes. `setCommentaryConsent` persists independent entrant summary/chat category consent after owner authorization. A share derives its consented emitter list from current stored grants rather than caller claims; projections omit every unconsented entrant/category. Withdrawing a previously granted category revokes active commentary-share generations atomically. Consent changes do not mutate the immutable comparison specification.

Schema replacement is deliberate in 0.x: fresh setup applies the packaged migrations in order, and no migration converts an older, incompatible schema. Opening an obsolete database fails with an explicit reset requirement and never converts or deletes it. Operators must approve/reset the ten host data tables above, all seven series tables and the benchmark publications table if present, and this package's `playerthree_migrations` rows (`scope='playerthree'`) before initializing fresh current schema. Game-owned profiles/credentials or benchmark tables referencing these records must be reset by their own operator as well. Local equivalents are commander `commanders.json` plus its artifact tree, OAuth `connections.json`, pool index/artifacts, history session/replay files and the complete configured series directory. Stop old live work before the reset; recreate profiles, named connections and policy artifacts and restart game/SDK/assets together. No old-data importer, compatibility alias, converter or automatic destructive reset is supplied.

**Operator reset.** `playerthree db reset` ([CLI](../docs/CLI.md#playerthree-db-reset)) over `planPostgresReset({url, migrations?})` / `resetPostgresStorage({url, migrations?, plan})` (entry `playerthree/postgres/reset`, which the storage entry MUST NOT import) performs that reset on explicit operator confirmation; it is never automatic. The URL comes from `DATABASE_URL` only and is never printed; the plan reports server host, `current_database()`, `current_schema()`, the tables and the ledger rows to drop. Owned tables are every `playerthree_*` table in the current schema plus the current-schema tables created by each given game scope's ledger-recorded migration files; nothing else is dropped. Execution MUST require `--yes` and the exact database name (typed interactively, or `--confirm`; non-terminals require `--confirm`). Any mismatch — a ledger scope not given, a recorded file missing, an existing table from an unrecorded migration, a migration creating anything but tables and indexes, or a database differing from the confirmed plan — exits non-zero before dropping. The drop is one transaction under the migration advisory lock with `DROP TABLE … RESTRICT` semantics; migrations are then re-applied through `openPostgresStorage`.

## 22. Team signals — Implemented

Team signals let teammates of any seat kind (human, agent, policy, bot) ask each other for help through typed,
closed-vocabulary requests, and answer them. They are prompt-injection safe by construction: a signal carries no text.

### 22.1 Vocabulary and cards

`manifest.signals` is `{kinds, cards}`:

- `kinds`: nonempty map kind → `{roles, params, doc}`. Kind names follow the intent-kind grammar (§3); `roles` are the
  sender roles; `params` is a field map of closed schema nodes that MUST NOT contain `str` at any depth (enums, numbers,
  coordinates, entity ids, lists and objects of those) and MUST NOT use the host-owned names `kind`, `id`, `from`, `to`,
  `tick`, `expires`, `state`, `by`; `doc` is 1–4000 code units of static developer text.
- `cards`: role → list of skills `{kind, where?}`: what that role answers. `where` maps enum params of the kind to a
  nonempty subset of their declared values (`{need:["scan"]}`); one skill per kind and role. Every kind MUST be answered
  by at least one role. No role may be named `team` (the broadcast address).

`control.signals` (§3) is the host rule: per-seat token bucket `perSecond`/`burst` for new signals, measured in ticks
(`tickRate`), never wall time; `maxOpen` open signals per sender, which is also the sender's share of the board;
`ttlTicks` until an open signal expires; `keepTicks` a closed signal stays visible. A match MAY narrow every limit or
turn signals off through adapter `signalLimits()` (§10); it MUST NOT widen them, because they size the schemas below.

`signalSchemas(roles, signals, control.signals)` generates the members the game composes into its manifest, and
`defineManifest` MUST reject a manifest whose members differ from the generated ones in canonical JSON:

| Member | Content |
|---|---|
| `intents.signal` | Senders: every role sending some kind. Params `{signal: union by kind}`; each variant is the kind's params plus `to`: an enum of the roles whose card answers the kind, then `team`. |
| `intents.signal_update` | Every role. Params `{id: id "sg", update: "ack"\|"decline"\|"done"\|"fail"\|"cancel"}`. |
| `observation.signals` | `{inbox: [Entry] (≤ (roles − 1) × maxOpen), sent: [Entry] (≤ maxOpen)}`. The observation MUST be an object schema. |
| `view.signals` | `[Entry]` (≤ roles × maxOpen): the team's whole board. The view MUST be an object schema. |

An Entry is a union by `kind`: the kind's params plus `id` (`sg_<n>`, team-local), `from` (role), `to`, `tick` (sent),
`expires`, `state` and optional `by` (the role that took or closed it). Without `manifest.signals` none of these names is
reserved.

### 22.2 Sending, routing and answering

Signals travel as the two reserved intents through the ordinary intent pipeline: schema, role, controller/scope and
rate gates apply as for any intent, so agents (`game_act`, `game_sequence`, stream), policies (`think` output), built-in
bots and team owners (owner gate, any seat of their team) all use them. A gated signal intent reaches the host's team
board instead of `adapter.apply`; the game never sees it. Board refusals use the ack `{ok:false,code:"signal",signalCode}`
with `signalCode` one of `disabled` (off in this match), `unsupported` (no teammate's card answers the kind and payload at
that address, the sender itself never counts), `unknown_signal`, `not_recipient`, `closed`, `too_many_open`; a sender
whose bucket is empty gets `rate_limited`; a sender role the kind does not list gets `forbidden_role`.

- `to: <role>` delivers to that teammate when its card answers; `to: "team"` delivers to every teammate except the
  sender whose card answers it.
- Lifecycle (A2A task states): `submitted` → `working` (a recipient `ack`s and becomes `by`; a broadcast belongs to the
  first) → terminal `completed` (`done`), `rejected` (`decline`; a broadcast only once every recipient declined; a
  decliner's inbox drops it), `failed` (`fail`), `canceled` (the sender's `cancel`), or `expired` (still open at
  `expires = tick + ttlTicks`). Only recipients answer, only the sender cancels, a `working` signal answers only to `by`,
  and a terminal signal refuses every update with `closed`. `ack` of one's own `working` signal is a no-op success.
- A new signal pushes the sender's oldest closed entry off the board when the sender already has `maxOpen` entries.

### 22.3 Delivery

The host owns the `signals` members: a game's `observe`/`view` omit them and the host attaches them before the outbound
guard. Every observation (agents, streams, policies, bots, deployment probes, practice) carries the seat's slice:
`inbox` (signals addressed to it, oldest first) and `sent`. Every team view carries the team's board, so human clients
render it through their game UI and authorized observers receive it with the configured delay, like everything else in
the view. `game_wait` ends early with `wake:"signal"` and the seat's `signals` when its slice changed since the agent last
observed or waited (a new inbox entry; a state change of a signal it sent or received). Boards are per match team: no
observation, view, wait, ack or id ever reflects another team's signals (ids count per team).

### 22.4 Determinism and replay

Boards are a deterministic function of accepted signal intents and ticks. The host turns every board over right after
each `step()` (expiry, then removal of closed entries past `keepTicks`), before any input of the new tick; signals sent
between ticks or by bots and policies in a tick's decision round take that tick's `tick`. Accepted signal intents are
recorded as replay entries `[tick,team,role,"signal",intent]` (refused ones are not recorded, and signal intents never
appear as `intent` entries). Replay execution re-applies them to a fresh board (created with the replayed adapter's
`signalLimits()`), turning it over after each step, and MUST reject an entry the board refuses. `ReplayPosition` and
`ReplayResult` carry the board (`signals`); persistent-session checkpoints clone it with the adapter. `SignalBoard` is
exported so a game's own headless runner can host signals identically.

### 22.5 Relation to Agent2Agent (A2A)

Signals adopt A2A concepts where they fit a deterministic, tick-based, team-only, fog-safe match, with A2A names where
they do not hurt clarity:

| A2A | Team signals | Why |
|---|---|---|
| Agent Card skills (capability discovery) | Role `cards` `{kind, where?}`, published in the `signals` briefing topic and the generated `to` enums | Requesters ask only teammates that can help; routing refuses the rest (`unsupported`). Cards are static per role so routing is deterministic and pinned by `surfaceHash`. |
| Task with id and lifecycle | Board entry with `id` and `state`: `submitted`, `working`, `completed`, `rejected`, `failed`, `canceled`, plus `expired` | Requesters see progress without asking. `expired` replaces an A2A client's timeout: the match clock ends unanswered requests. `input-required` and `auth-required` are omitted: there is no free-text dialogue and no per-request auth. |
| `DataPart` (structured parts) | Typed params from a closed schema | Machine-checkable and injection-safe. A2A text parts are not imported. |
| Push notifications / streaming status updates | Slices in every observation; `game_wait` wakes with `wake:"signal"` | Delivery rides the existing tick-synchronous channels. |
| Cancel Task | `signal_update` `cancel` by the sender | Same meaning. |

Not imported: HTTP/JSON-RPC/gRPC transport (signals ride the intent pipeline and replays), text and file parts,
cross-organization authentication (a team's seats already share one authenticated match), and contexts/history listing
(the board is the bounded, current history).
