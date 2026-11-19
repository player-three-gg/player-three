# PlayerThree over MCP

PlayerThree's primary agent binding is an [MCP](https://modelcontextprotocol.io) server that the **game server** hosts.
Every player adds the same static URL (`https://game.example/mcp`) to their own harness (Claude Code, Codex, OpenCode,
Pi, oh-my-pi, Hermes, any MCP client); the harness signs in through the browser with MCP OAuth, and the game's consent page lets the player
pick which roles that **connection** commands (one connection can command several). There is no secret to paste. The
player pays for their own model; the game pays nothing. The agent gets one tool per control-plane operation,
SDK default workflow skills, generated reference documentation and the game's strategy skills.

The normative contract is [PlayerThree Specification version 1](../spec/SPEC.md). “Team” in API names means a side; one-side games are supported. Each observation is restricted to its recipient's perspective.

- Spec revision **2026-07-28** (stateless: no `initialize`, no sessions; `server/discover`; per-request `_meta`
  envelope; `Mcp-Method` / `Mcp-Name` headers; cacheable lists with `ttlMs` / `cacheScope`). 2025-era clients are
  served by the SDK's stateless fallback.
- MCP authorization (2026-07-28): OAuth 2.1 authorization server built in (PKCE S256, Client ID Metadata Documents and
  dynamic client registration, RFC 9728 protected resource metadata, RFC 9207 `iss`, rotating refresh tokens,
  revocation). Seat and commander tokens keep working as bearer tokens.
- Streamable HTTP endpoint (players install nothing), plus `playerthree-mcp` from `@playerthree/runner`, a local **stdio bridge** with surface pinning.
- `playerthree-run` from `@playerthree/runner`: plays end-to-end with your own OpenAI or Anthropic key and a hard dollar budget.

Both CLIs need only `--url`: they sign in through the browser too.

The `npx --package @playerthree/runner …` commands below fetch the runner from npm. From a checkout of this repository
(after `pnpm install`), run `node packages/runner/bin/playerthree-mcp.ts …` or `node packages/runner/bin/playerthree-run.ts …`
with the same flags.

## For game developers

```ts
import { createServer } from 'node:http';
import { createPlayerThreeHost } from 'playerthree/host';
import { mountMcp } from 'playerthree/mcp';

const host = createPlayerThreeHost({ definition });
// your existing server
const httpServer = createServer(app);
mountMcp(httpServer, host, { path: '/mcp' });
```

`mountMcp` intercepts requests whose pathname is exactly `path`; everything else reaches your other listeners
unchanged. If you route yourself, use the handler directly:

```ts
import { createMcpRequestHandler } from 'playerthree/mcp';

const mcp = createMcpRequestHandler(host, {
  // exact Origin values allowed (browsers)
  allowedOrigins: [],
  onConsent: (e) => log(e),
  // out-of-band errors; never sent to agents
  onError: (err) => log(err),
});
```

Requests carrying any `Origin` not in `allowedOrigins` get `403`. `onConsent` receives
`{ match, team, role, owner?, via: 'elicitation' | 'implicit', granted }`. The handler has these faces:

| Use | Call |
|---|---|
| `node:http` | `await mcp(req, res)` |
| fetch-style (Workers, Bun, Deno, Hono) | `await mcp.fetch(request)` |
| shutdown | `await mcp.close()` |
| pin value | `mcp.surfaceHash` |

Per-match seat tokens come from `match.mintSeatToken(team, role)` (or the exact seat owner's
`playerthree:mint`). They expire, bind to one MCP transport session, and cannot be shared between clients.
Seat credentials work in both protocol eras: a 2026-07-28 client names its revision in each request's `_meta`
envelope, a 2025-era client opens with `initialize` (served by the SDK's stateless legacy leg). Seat discovery is
side-effect-free. The first valid real request claims one exact lease and returns `mcp-session-id`; a malformed first
request (headers, envelope, JSON-RPC shape, unknown method or invalid params) or a notification gets its error without
consuming the token or issuing a session. Clients retain that
header on every later call and DELETE it on disconnect. Expiry or revocation closes its private exchanges.
Persistent commander roster credentials keep their normal separate lifecycle.

**1. Create the host.** The host loads its commander (and match log), pool and history stores before
`host.ready` resolves. `dataDir` keeps them on disk; pass `commanderStore: yourDbStore` instead (for example from
`playerthree/postgres`) to back rosters with your own database.

```ts
const host = createPlayerThreeHost({ definition, dataDir: './data' });
await host.ready;
```

**2. Register a commander.** Call these only for an authenticated game player. `ensure` creates an empty named
registry; `create` adds a named commander to it; `token` returns its owner-private, rotatable token.

```ts
host.commanders.ensure(player.id);
const commander = host.commanders.create(player.id, {
  name: 'Orbital strategist',
  kind: 'agent',
  roles: ['orbit'],
  isolation: { independentSessions: true },
});
const token = host.commanders.token(player.id, commander.id);
host.commanders.update(player.id, commander.id, { botLevel: 'veteran' });
```

**3. Seat it in a match.** An assignment names the commander by id. `readySeconds` holds the match at tick 0 for a
ready check; at the deadline unready AI seats fall back, while required human admission does not time out.

```ts
const assignments = [
  {
    team: 'blue',
    role: 'orbit',
    owner: player.id,
    kind: 'agent',
    commander: { id: commander.id },
  },
];
const match = host.createMatch({ assignments, readySeconds: 60 });
match.readiness();
match.readyCheck();
```

| Call | Returns |
|---|---|
| `match.readiness()` | `{ mode, pending, deadline?, seats: [{ team, role, kind, state }] }` |
| `match.readyCheck()` | compact clock snapshot `{ pending, deadline, seats: [{ team, role, ready }] }`, or `undefined` without a ready check |

`step()` refuses while the ready check is pending.

> [!NOTE]
> Human assignments also require trusted `match.setHumanReady(team, role, ready)` and authenticated
> `match.humanJoined(team, role, joined)`. `match.skipReadyCheck()` explicitly starts the match anyway; reserve it
> for trusted fallback policy.

**4. Manage it: roster, log, practice, rollback, mandate.** These are owner UI calls.

```ts
host.commanders.roster(player.id);
await host.commanders.log(player.id, commander.id);
await host.commanders.practice(player.id, commander.id, {
  role: 'orbit',
  opponent: 'veteran',
  ticks: 3000,
});
await host.commanders.rollback(player.id, commander.id, 'orbit', 2);
```

| Call | Returns |
|---|---|
| `roster(owner)` | each commander: named id, compatible roles, policy library, W/L/D `record`, `connected`, exact `seated` lane |
| `log(owner, id)` | owner-only commander match log entries, oldest first |

A mandate update is a partial patch: it preserves the other mandate fields. `resolveApproval` answers one of the
commander's pending approvals (listed as `approvals` in its roster entry).

```ts
host.commanders.update(player.id, commander.id, {
  scopes: ['policy', 'practice', 'say'],
  mandate: { autonomy: 'supervised', whenAbsent: 'policy' },
});
await host.commanders.resolveApproval(player.id, commander.id, approvalId, true);
```

PlayerThree does not authenticate players: the game maps its own identity to the opaque `owner` id. See
[DESIGN §2 Commanders](DESIGN.md#commanders-persistent-rosters). A commander's W/L/D `record` is derived from the
commander match log (`createPlayerThreeHost({ commanderLog })`,
[SPEC §20.10.1](../spec/SPEC.md#20101-commander-match-log--implemented)), never stored on the commander.

### Sign-in: one URL for every player (OAuth)

```ts
import { createAuthorizationServer, mountMcp } from 'playerthree/mcp';

const auth = createAuthorizationServer(host, {
  // your public origin (no path)
  issuer: 'https://game.example',
  // your consent page
  consentUrl: (requestId) => `/connect?r=${requestId}`,
  // or store: yourConnectionStore; default in memory
  dataDir: './data',
});
await auth.ready;
// also serves /.well-known/oauth-* and /oauth/*
mountMcp(httpServer, host, { path: '/mcp', auth });
```

To route yourself, use `createMcpRequestHandler(host, { auth })` and call
`if (await auth.handle(req, res)) return;` before it.

The harness gets `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`,
discovers the authorization server, identifies itself (a Client ID Metadata Document URL, e.g. Claude Code's
`https://claude.ai/oauth/claude-code-client-metadata`, or dynamic client registration), and opens
`/oauth/authorize`. That validates the request (client, exact redirect URI — loopback redirect URIs match any port,
RFC 8252 — PKCE S256, `resource`) and sends the browser to **your** consent page. Your page authenticates the player
itself, then takes three steps.

**Show the request.** `consentRequest` returns what the page displays, or `undefined` for an unknown or expired id.

```ts
const request = auth.consentRequest(requestId);
```

| Field | Meaning |
|---|---|
| `id` | the request id |
| `client` | `{ id, registration: 'cimd' \| 'dcr', name, uri?, logoUri?, softwareId?, softwareVersion? }` |
| `domain?` | CIMD: the host that served the metadata (verified); absent for DCR (self-asserted) |
| `redirect` | `{ uri, host, loopback }`: show the host; warn when it is loopback only |
| `roles`, `expiresAt` | grantable roles and the request's expiry |

**Answer it.** Send the browser to `redirect`: the client's redirect URI with `code`, `state` and `iss`, or with
`error=access_denied`.

```ts
const { redirect } = auth.resolveConsent(requestId, {
  owner: player.id,
  commander: selectedCommander.id,
  roles: ['orbit', 'sky'],
  approve: true,
});
```

**Manage connections.** `connections` lists
`[{ id, commander, client, roles, createdAt, authorizedAt, lastSeenAt, active }]`. A role update applies to the
agent's next call; revoking stops every token of the connection at once.

```ts
auth.connections(player.id);
auth.updateConnection(player.id, id, { roles: ['orbit'] });
auth.revokeConnection(player.id, id);
```

A connection binds one explicitly selected named commander ID and a subset of its compatible roles. Create that
commander through the authenticated owner registry (`host.commanders.create`); `ensure(owner)` creates only an empty
registry. Every consent creates an independent connection: matching owners, roles, client names or providers never
merge credentials or steal another connection's roles. Calls route through that commander's exact per-role lanes
on one live match/team. Another named commander may support the same role on an opposing side. Consent grants roles;
the named commander's owner-set scopes still apply. Revoking or editing one connection does not change another.
Harness kinds for icons can be derived from `client` (`softwareId` `dev.playerthree.bridge` / `dev.playerthree.runner`
for PlayerThree's CLIs; for metadata-document clients the `domain` is the trustworthy part).

“Signed in” means this connection exists. “Active now” means a call within 30 seconds or an in-flight call (including
`game_wait`). The authorization API exposes `ConnectionStatus.active` / `lastSeenAt`;
`@playerthree/connect`'s `ConnectionInfo` uses `active` / `lastSeen` and also includes `authorizedAt`. A saved connection
does not by itself mean the model is running.

Details: authorization codes live 60 s and are single use (a replayed code revokes what it produced); access tokens
live 1 h and are bound to the MCP endpoint URL; refresh tokens (30 days) rotate on every use and a rotated one coming
back revokes the connection; `POST /oauth/revoke` (RFC 7009). Metadata documents are fetched over https only (plain
http to localhost only with `allowLoopbackClients`, for development), from public addresses only, without
redirects, in 5 s and 5 KiB, and cached per `Cache-Control` (1 min … 24 h). Rate-limit `/oauth/*` per IP in your
server; the authorization server caps pending requests and registrations itself, and keeps at most 20 connections
per owner (redeeming another code fails `invalid_grant`). All endpoints must be https in
production (Claude Code refuses other token endpoints than localhost).

For local proxy development only, `aliases` can list the other loopback origins serving the same MCP endpoint.
Discovery, `WWW-Authenticate`, and authorization-response `iss` then follow the configured request origin
(including a configured proxy's forwarded host). Unconfigured origins are never reflected. Production hosts
should configure only their public HTTPS issuer and no aliases.

The consent browser must use the player's existing identity, not silently create a new owner when the harness
opens a different browser. Agent Command provides an example of host-owned pairing: the owner mints a six-character
code in Commanders, valid ten minutes and single use. The other browser exchanges it for a hashed, request-bound
consent capability and safe roster details; approval sends that capability, never the owner's profile secret.
Codes and capabilities expire with the request, cannot be replayed or applied to another request, and are
rate-limited per owner and IP. The DOM-free `@playerthree/connect` wire types include `PairingCode`, `ConsentCommander`,
`PairingResult` (`commanders: ConsentCommander[]`), and the alternative `ConsentAnswer.pairingCode` / `pairingToken` fields; the host implements
identity, pairing storage, and UI.
`ConsentCommander` includes `id`, `name`, compatible `roles`, `kind`, isolation, optional self-reported metadata,
`holder` (a harness already signed in to it, or null), `scopes` and `mandate`; `PairingResult.commanders` supplies the
safe choices. `ConsentAnswer.commander` selects the
exact ID. These are owner settings to display, not values the harness may self-grant.

### What the endpoint exposes

One tool per `SeatControl` method, named by `MCP_TOOL_NAMES`, listed in this order, and only if the game enables the
method's mode (`manifest.control`), followed by `game_usage`, which every game lists:

| Tool | Mode | Read-only | Arguments (generated from the manifest) |
|---|---|---|---|
| `game_briefing` | intents | yes | `{ topic?: string, page?: int ≥ 1 }` (`page` requires `topic`) — no topic: the core briefing (rules, role doc, mandate, intent kinds, one-line `topics` index); with `topic`: one page (≤ 8,000 chars) of a game or generated topic (`intent/<kind>`, `observation`, `match-data`, `modes`, `schema/<name>`, …) as raw text plus a `[page p/n — next: …]` line |
| `game_observe` | intents | yes | `{ since?: int, detail?: Section[] \| "all", fields?: TopLevelKey[], page?: int ≥ 1 }` — `detail` (games declaring `observationScope`) adds sections rendered in full to the role's defaults (briefing `observationScope`: `full` / `summary`); a result over 24,000 chars is paged from a per-role snapshot (`page`, `pages`, `tick`, `next`, `items`); `{ page: n }` reads that snapshot |
| `game_act` | intents | no | `{ intents: Intent[1..min(burst,64)] }` — the union of the game's intents, tagged by `kind` |
| `game_sequence` | sequence | no | `{ steps: { in: int, intents: Intent[1..min(burst,64)] }[], cancelOn?: EventKind[] }` |
| `game_wait` | intents | yes | `{ seconds: 0..60, until?: EventKind[] }` — one role's wait; lobby uses wall-clock time, match entry includes that role's first observation |
| `game_ready` | intents | no | `{}` — marks only the selected pre-match seat ready; add `role` when commanding several roles |
| `game_skill` | intents | yes | `{ name: SkillName, path: string, offset?: int }` — a window of ≤ 20,000 chars cut after a line, raw text plus a `[… continues: game_skill {…, "offset": N}]` line |
| `policy_deploy` | policy | no | A game's starter by reference `{ from: Starter, knobs?: object }` (games declaring starters; topic `starters`), or `{ runtime: allowed runtimes, code: string, include?: "<skill>/<path>.js"[] ≤ 16 }` — included skill files are prepended; the composed source must fit `maxArtifactBytes` — or (js) `{ runtime, modules, entry, include? }`. Exactly one body; the host names a missing or extra member: `{"error":"invalid","schemaCode":"missing_field","path":["code"],"expected":"Artifact: one of code \| modules+entry \| from"}` (a rejected `from`/knob likewise carries `schemaCode`, `path`, `expected`) |
| `policy_status` | policy | yes | `{}` — the active version's stats, plus `from` and `knobs` when it was deployed from a starter; `policy: null` means nothing is deployed (or proposed), so no policy plays the role |
| `policy_rollback` | policy | no | `{ version: int }` |
| `practice_run` | practice | no | `{ opponent: Opponent, ticks: 1..maxTicks, seed?, allies?: Opponent, artifact?, options? }` — `artifact` takes the same shapes as `policy_deploy`, including `{ from, knobs? }`; `options` is an opaque object here (its JSON Schema is topic `schema/match-options`) that the host validates: a failure names its path, e.g. `["options","map"]`, with `expected` |
| `pool_publish` | pool | no | `{}` |
| `game_say` | chat | no | `{ text, disclosure?:"observers", category?:"summary"\|"chat" }` — private unless explicitly disclosed |
| `game_usage` | — (always listed) | no | Bounded self-reported exact-live-seat usage; no caller-supplied lane identifiers |

The list every model turn carries stays small: descriptions say what a tool does with one example, and details live
in topics and skills. Generating the surface fails for a game over the tool-surface budget (SPEC §4: each description
≤ 1,500, inputSchema ≤ 48,000, outputSchema ≤ 70,000, and name + description + inputSchema over all tools ≤ 120,000
UTF-16 code units of compact JSON; exported from `playerthree/mcp` as `TOOL_DESCRIPTION_MAX`, `TOOL_INPUT_SCHEMA_MAX`,
`TOOL_OUTPUT_SCHEMA_MAX`, `TOOL_SURFACE_MAX`).

Every tool except `game_skill` also takes an optional `role` (enum of the manifest's roles): which of the
credential's roles the call is for. It is **required** when the credential commands more than one role (a sign-in
connection); `game_briefing` defaults to the first role. A role the credential does not command → `forbidden`; no
role while several are held → `invalid` with `path: ["role"]`. `game_briefing` lists every role the credential
commands as `commands: [{ role, phase, team? }]`.

`game_usage` is optional self-reported telemetry, not a gameplay action or billing authority. It accepts
`decisionId`, `latencyMs`, `source:"provider"|"self_report"`, `reporter:"reported"|"estimated"|"unpriced"`,
`coverage:"complete"|"partial"|"unknown"`, optional token counts, and optional `costAmount`, `currency`,
`pricingVersion`. Missing/null values remain unknown, not zero. The authenticated exact live lane supplies match,
team and role; caller-supplied lane identifiers are rejected. Declared latency never becomes measured latency.
`game_say` remains owner-private unless the caller explicitly sets `disclosure:"observers"` and optional
`category:"summary"|"chat"`; observer consent and delay still apply. `category` alone is invalid.

Every tool has an `outputSchema` and returns `structuredContent` (also serialized as text for clients that ignore
structured output). Annotations: `openWorldHint: false` everywhere; `readOnlyHint` as above. The server instructions
include the `surfaceHash` and the order: the core briefing (whose role doc may name one topic to read first), then,
with policy scope, a working policy for every commanded role (a starter by reference is one call), then topics and
skill files, with `playerthree-commander/SKILL.md` for the lifecycle. With policy mode they say what a policy is (a
sandboxed program you write or fork, `policy_deploy {code}` or `{modules, entry}`), where writing one is documented
(`playerthree-policy-author`, topic `modes`) and that improving it is how a seat plays well. Follow the seat's mandate:
autonomous means decide and act without asking within scopes and limits; supervised means propose policies for
the owner to approve. Keep the monitor loop running: a reply without a tool call ends the client's turn, so it ends only
when the match is over or the seat is genuinely blocked, not to announce a next step, offer to continue, list
non-blocking decisions or report a milestone.

Results are fail-closed: the host's outbound guard validates game data against the manifest, and the endpoint
validates every result against the tool's `outputSchema` before sending it (a mismatch becomes `internal`).

`PracticeResult` is a discriminated union:

- Success: `{ ok: true, outcome, ticks, report, policy, wallMs }`, with a guarded report matching the game's schema.
- Failure: `{ ok: false, code: 'policy' | 'guard', policy, wallMs }` for artifact-load or guarded-output failure.

Failures contain no outcome, ticks or fake nullable report. Commander `lastPractice` is updated only on success.

**Errors** are tool results with `isError: true` and text `{"error": "<code>"}`, where `<code>` is one of
`bad_message` (unknown tool), `bad_token`, `forbidden`, `mode_unavailable`, `out_of_scope`, `rate_limited`, `invalid`
(with `schemaCode` and `path`: schema field names / indices only), `busy`, `internal`, `consent_declined`,
`not_in_match` (unseated act/sequence), `paused` (act/sequence before the start), `approval_not_found`, `approval_pending`, or `approval_failed`.
Per-intent results are acks: `ok`, or `invalid` + schema path, `forbidden_role`, `out_of_scope`, `rate_limited`,
`not_controller`, `game_over`, `game` + the game's own error code, or (games declaring signals) `signal` + the signal
code. Input is never echoed.

A mode the game does not support fails `mode_unavailable`; an enabled mode outside the seat's scopes fails
`out_of_scope`. Missing permission does not make a nonexistent mode appear available.

**Three credential kinds, one surface.** A *seat token* drives one seat of one match. A *commander token* is persistent
(one per named commander). A *sign-in connection* binds the selected commander ID and compatible roles;
role edits and revocation apply to the next call. None of these credentials can widen the exact live seat lane.
An army-wide named commander still routes through these per-role lanes; a human/owner or spectator
credential is not an MCP agent credential and cannot mark an agent seat ready.

Every seat tool accepts `role` (except role-independent `game_skill`). The static enum lists the game's
vocabulary, not the credential's permissions. Call `game_briefing {}` to discover current `commands`;
briefing defaults to the first role. With several commands, pass `role` on other seat calls, including
`game_ready` and `game_wait`. With one command, omitting it still selects that one role. The static
schema keeps `role` optional because the shared surface also serves single-seat tokens and changing grants.

Readiness is a declaration that you are prepared for **one seat**, not proof that you read a briefing or
deployed a policy, and not a bulk declaration for your commander or army. For every commanded seated role,
read `game_briefing {role}`, follow its mandate, and call `game_ready {role}` when prepared. Ready your
prepared seats before blocking on the start, then loop `game_wait {seconds:60,role}` for every commanded
role. A result with `you.ready: true` and `phase: "lobby"` is successful readiness for that seat; others or
the host may still be pending (`startsWhen`). An unseated role's ready call changes nothing; wait for seating.
After seating or reassignment, refresh the briefing and current `commands`, and ready the new seat if needed.
Readiness follows the reservation's seat, not all future assignments; revoked roles cannot be selected.

Commander tokens and connections have two phases, reported as `phase` by `game_briefing` and `game_wait`:

| | lobby (unseated or before the match starts) | match (the seat's match is running) |
|---|---|---|
| `game_briefing` | `phase: "lobby"`, role doc, mandate and scopes; unseated roles have no team | the seat's briefing, `phase: "match"`; `teams` are this match's sides (manifest order), plus `alliances` (`{ [id]: team[] }`) when the match declares them |
| `game_observe` | lobby state: `seat` (null when unseated), `match?`, `you.ready`, `startsWhen`, `instruction` (for a commander role with policy scope, no active policy and no pending approval: deploy one first) | the seat's observation |
| `game_act`, `game_sequence` | `not_in_match` when unseated; `paused` before the start | the seat |
| `game_ready` | marks only this seat ready and returns its lobby state; unseated is a no-op | no-op returning `{phase:"match",you:{ready:true}}` |
| `game_wait` | blocks up to `seconds` (wall clock); wakes on seating, owner message or approval change; ordinary timeout returns the lobby state; match start returns the first observation | game time; also wakes on visible requested events, game end, owner messages or approval changes |
| `policy_*` | the commander's library (deploy probes on a fresh game; status is current stats/approval, not a version list) | the seat; deploys/rollbacks also update the library |
| `practice_run`, `game_skill`, `pool_publish` | the commander's active policy / static docs | the seat |

An `agent` kind seats the commander as controller `agent` from tick 0, without switching controller labels
when its harness becomes active. While present it can act and its deployed policy runs. When absent, the mandate
chooses `policy` (deployed policy, otherwise fallback bot), `bot` (policy paused), `hold` (nothing acts), or, in games
declaring `control.pausable`, `pause` (the session's clock stops until the agent's next call; `game_wait` then ends
after its `seconds` of wall-clock time, and the seat status resource carries `paused`).
After the seat's team has a final outcome the token is back in the lobby: a team that is out returns while other
teams of the match play on. The surface hash covers the static phase and
role-routing semantics, not a particular owner's current settings.

When seating or match end occurs with no wait in flight, the first newly seated result and the terminal ended
result are retained for a subsequent wait, once each. Retained transitions never preempt or swallow unread
owner messages; owner-message delivery keeps priority and drains each message once.

Terminal delivery is retry-safe: commander waits, lobby observations and private status include an optional
`previousMatch: {match,team,role,tick,outcome,disposition,at}`. This is the latest receipt for that exact role,
not the current match. `disposition:"final"` carries only an authoritative win/loss/draw; interrupted execution
has `disposition:"interrupted", outcome:"unknown"`. After a process restart without a saved closing state,
`tick` is `null`, never an invented final tick; `at` is receipt recording time, not time of game end.
Receipts contain no observations, messages or other teams' results. They are not consumed by delivery and
do not preempt the next match's entry. One per role is retained in the commander store for `history.maxAgeMs`
(24 hours by default), replaced by the next result or removed when the role/commander is removed.
Call `host.commanders.flush()` after disposal and before closing persistent storage during graceful shutdown.

Already-claimed one-match seat leases may read their final wait/role observation until normal disposal or
expiry, but cannot mutate the game or deploy policies. Fresh claims after elimination/end are rejected.
Eliminated roles read a frozen authorized observation, not the surviving teams' ongoing game. Explicit seat
revocation, credential rotation and expiry still invalidate access immediately.

### Scopes, mandate and approvals

`game_briefing` exposes `scopes` and `mandate`; topic `mandate` documents the directive and limits fields (`schema/directive`, `schema/limits` give their JSON Schemas). Scopes are owner-set
per commander: `act` permits direct intents, sequences and stream; `policy` deploy/rollback; `practice` practice;
`publish` publication; `say` owner replies. Briefing, observation, wait, skills and policy status require no action
scope, but still respect enabled modes and phase. Every agent credential, including owner-minted per-match seat
tokens, follows the live seat's scopes; minting a new token cannot bypass a scope restriction.

The mandate is `{ autonomy: 'autonomous' | 'supervised', directive, limits?, whenAbsent: 'policy' | 'bot' | 'hold' | 'pause' }`
(`pause` only for games declaring `control.pausable`; the briefing schema lists it only there).
The objective and optional limits follow the game's schemas; the game enforces limits in `apply`. In supervised mode,
deploy/rollback/publish return `{ ok: false, approval: { id, kind, version } }` without changing the active policy or publishing.
`kind` is `policyDeploy`, `policyRollback` or `publish`. Each seat keeps one pending proposal; a newer proposal replaces it.
Both `ApprovalRequest` and `Approval` require `version`: deploy pins the proposed next version (a stale version fails
resolution with `approval_failed`), while rollback and publish expose the target version.

Owners resolve through `commanders.resolveApproval(owner, commanderId, id, approve)` or
`match.resolveApproval(team, role, id, approve)`. The owner transport accepts
`{ op: 'resolveApproval', seq, role, id, approve }` on `playerthree:resolveApproval`; mandate updates use
`match.setMandate(team, role, mandate)` or `{ op: 'mandate', seq, role, mandate }` on `playerthree:mandate`.
These are owner operations, never agent tools. Missing/stale approvals yield `approval_not_found`; an approval
already being resolved yields `approval_pending`; resolution failures can yield `approval_failed`.

Live scope replacement uses `PlayerThreeMatch.setScopes(team, role, scopes)` or
`{ op: 'scopes', seq, role, scopes }` on `playerthree:scopes`. Current permissions appear in `SeatInfo.scopes` and the
briefing. Revoking `act` cancels scheduled agent sequences. Commander settings updates propagate to the live seat;
the owner operation also works for seats without a persistent commander.

`policy_status` returns `{ policy: null }` when neither a policy nor approval exists; otherwise `policy` is current
policy stats, or `{ version: null }` without a deployed policy, with optional
`approval: { id, kind, version, status: 'pending' | 'approved' | 'rejected' | 'failed' }` and optional
`activationError` (`stale_policy`, `policy_failed` or `needs_role_deploy`, see [Policy ABI](POLICY_ABI.md)).
`game_wait` wakes with `wake: 'approval'`; read status for the outcome. Status does **not** enumerate retained
versions: record successful deploy version numbers or use the owner's roster/library UI to select a rollback.
Per-intent approval is proposed, not implemented; scopes must remove `act` when direct acting is unwanted.

### Sequences

`game_sequence` is available only with `control.sequence`. `in` is a nonnegative tick offset from submission;
steps must be ordered and at least `minSpacingTicks` apart, within `maxTicksAhead`, with at most `maxSteps` steps.
MCP allows 1–`min(burst,64)` intents per step and at most 16 `cancelOn` kinds (declared, unique event kinds).
The entire plan is schema/role/scope-checked before scheduling. It returns `{ ok: true, id, acks }`, or
`{ ok: false, code: 'invalid' | 'out_of_scope' | 'not_controller' | 'game_over', acks }`; `acks` is an array per step.
Malformed MCP arguments can instead fail as a tool-level `invalid` error.

One sequence is active per seat; a valid new plan replaces it and `{ steps: [] }` cancels it. Acceptance is not a
promise of later game-rule success: due steps pass the agent gate before the simulation step. Losing agent control
drops the plan, and `cancelOn` cancels on the first matching event visible to that seat. Active sequences count as
presence. Use sandboxed policy code, not sequences, for conditionals.

**Owner chat** (`control.chat`). The owner of a seat (and nobody else) can message their agents. `game_wait` returns
early with `wake: "owner_message"` and the unread `messages` (`{ from: "owner", tick, text, ping? }`);
`game_observe` returns unread `messages` next to `observation`. Messages are marked read once delivered.
`game_say` sends a reply (rate-limited: 3, then one per 2 s) that only the owner sees. Owner messages: 5, then one
per second, per owner.

Consumers must inspect the **entire result envelope**, including top-level `messages`, before extracting
`observation` or printing a reduced summary. Discarding a `game_wait` result loses the messages it returned;
a subsequent `game_observe` does not replay them. Observation `fields` filtering preserves sibling messages,
while continuation pages do not drain the inbox. Monitor every commanded role separately.

**Team signals** (`manifest.signals`). `game_observe` includes `signals: { inbox, sent }`; `game_wait` returns early
with `wake: "signal"` and that slice when a teammate's signal reaches the seat or one it sent or took changes state.
Send and answer with the `signal` / `signal_update` intents through `game_act`; refusals ack
`{ ok: false, code: "signal", signalCode }`. Briefing topic `signals` lists the kinds and each role's card.

**Skills** are served over the MCP Skills extension (`io.modelcontextprotocol/skills`), with file size and SHA-256
digest under `skill://<game id>/<skill>/…`. `game_skill` reads the same files for tools-only clients:

| Skill | Responsibility |
|---|---|
| `playerthree-commander` | Connect, prepare every commanded role, lobby wait, play, return to the lobby |
| `playerthree-inputs` | Choose enabled input tiers within scopes |
| `playerthree-owner` | Follow mandate, limits, approvals and own-owner chat |
| `playerthree-policy-author` | Policy authoring workflow; served only with policy mode |
| `<game>-reference` | Generated game schemas, intents, limits and ABI |
| Game-declared skills | Strategy and example policies owned by the game developer |

Default content is mode-gated and included in `surfaceHash`. The `playerthree-` prefix is reserved: developer skills
using it are rejected. Read `playerthree-commander/SKILL.md` first after briefing, as the server instructions direct.
Skills clients should use YAML 1.2 frontmatter typing, not YAML 1.1 coercions such as treating `on` as a boolean.

**Long calls.** `practice_run` and `game_wait` are synchronous; if the request carries a `progressToken`, the server
sends a progress notification every second while they run (clients use it to keep the request alive). The tasks
extension is not used: `@modelcontextprotocol/server` 2.4.0 does not implement it.

**Caching.** `tools/list`, `server/discover` and skills results carry `ttlMs: 3600000`,
`cacheScope: "private"`. `resources/list` is private with `ttlMs: 0`: credentials and role grants can change.

**Limits.** Request bodies over 1 MiB → 413. Per seat token, commander token or connection: 10 calls/s (burst 20) →
`rate_limited`; at most **4 non-wait calls** in flight plus **2 waits per commanded role**, with overflow → `busy`.
Fallback channel waits and model-requested waits share this allowance. Listen-based lifecycle streams do not
occupy tool-call or wait slots; their resource filters are authenticated before opening. Intents also obey `control.intents`.
Concurrent `policy_deploy`, `policy_rollback` and `policy_import` calls of one commander queue and run in order (at most
8 per commander, then `busy`), so an agent may deploy all its roles in parallel.

## For players

Add the game's MCP URL once and sign in through the browser. The game's consent page shows which harness asks
(for harnesses with a Client ID Metadata Document, like Claude Code, also the domain vouching for it; others are marked
unverified) and where the browser returns, and lets you select a named commander and compatible roles. Your agent
waits in its own lobby between matches (briefing, skills, practice and an isolated policy library), then routes only
to its explicitly assigned seat. Edit or revoke one connection without changing another named commander.

The examples use `https://game.example/mcp` and the server name `game`.

### Claude Code

```sh
claude mcp add --transport http game https://game.example/mcp
```

Then `/mcp` → *game* → *Authenticate* (or `claude mcp login game`). Claude Code identifies itself with its metadata
document (`https://claude.ai/oauth/claude-code-client-metadata`) and a loopback callback.

### Claude Code wake channel — Implemented (research preview)

For lifecycle-driven wakeups, replace the ordinary HTTP registration with the opt-in stdio bridge
(substitute your MCP URL; the server name here is `agent-command`):

```sh
# register the bridge as a stdio server
claude mcp add --transport stdio agent-command -- \
  npx --package @playerthree/runner playerthree-mcp \
  --url https://game.example/mcp \
  --channel

# start an interactive session with the channel loaded
claude --dangerously-load-development-channels server:agent-command
```

`playerthree-mcp --channel` declares `experimental: { 'claude/channel': {} }` on the current protocol only.
It sends `notifications/claude/channel` only for **seated**, **match ended** (with outcome),
**approval resolved**, and messages explicitly labelled **from owner**. It prefers `client.listen` on private
status resources, checks that the server honors the filter, and reads status on updates. When unavailable it
falls back to a background `game_wait` per commanded role plus a shared `game_briefing` poll per second.
Owner text is fetched through the authenticated agent wait path, never through status resources.
No observations, arbitrary events, policy logs, or other players' text are forwarded as channel content.
Reply to the owner with `game_say` when permitted; the channel itself is one-way.

This custom-channel setup is a **research preview**, not universal MCP push. The development flag works only in
an **interactive** Claude Code session: `-p` and the Agent SDK ignore it. Organization `channelsEnabled` policy
still applies. Events are **silently dropped** if the server is not loaded as a channel; successful registration
as an ordinary MCP server is insufficient. See the [Claude Code channel reference](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview).

Without channels, paste the game's kickoff prompt and follow `playerthree-commander`: in the lobby keep
`game_wait({ seconds: 60, role })` running in a loop for every commanded role. Ordinary MCP and signing in alone
do not start a model turn.

### Listen-based wake — Implemented

Standard MCP `subscriptions/listen` carries private lifecycle updates. Each sign-in connection, commander token
generation, or seat token gets a distinct resource for each commanded role:
`playerthree://seat/<base64url HMAC(server key, credential id + role)>`. Its `name` is the manifest role and its MIME
type is `application/json`. Discover it using **that credential's** `resources/list`; do not derive, log, or share
the URI. It is never part of a trace, DevTools feed or shared manifest.

```ts
const { resources } = await client.listResources(undefined, {
  cacheMode: 'bypass',
});
const statusResources = resources.filter((resource) =>
  resource.uri.startsWith('playerthree://seat/'),
);

client.setNotificationHandler(
  'notifications/resources/updated',
  async (notification) => {
    const status = await client.readResource(
      { uri: notification.params.uri },
      { cacheMode: 'bypass' },
    );
    // Use status locally; never log the private URI.
  },
);

const subscription = await client.listen({
  resourceSubscriptions: statusResources.map((resource) => resource.uri),
});
```

Check `subscription.honoredFilter.resourceSubscriptions` before relying on wake delivery.

Resource contents contain only `phase: "lobby" | "match"`, optional `team`, `tick`, optional `outcome`,
optional `previousMatch`, optional `approval: { id, kind, version, status }`, `unreadOwnerMessages`, and (pausable
games, while paused) `paused`. No owner text, observations or
policy logs appear. Reading status **does not consume** inbox messages, approval wakes, or retained seating/end
transitions that `game_wait` returns. Owner messages remain available through `game_wait`/`game_observe` with
their `from: "owner"` label. End status returns the commander to the lobby with the final tick/outcome while
that terminal transition is retained.

Seating, match end, approval changes and owner messages publish URI-only updates to the affected credentials.
The server advertises `resources: { subscribe: true }`. SDK 2.4.0's listen router has no `authInfo`, so PlayerThree
authenticates **every requested URI before opening the stream**, as well as every resource read; another
credential gets not found even if it knows a URI. Role edits, credential rotation and revocation abort affected
listen request signals. The SDK then unsubscribes from the bus and closes the SSE stream, so old subscriptions
stop receiving updates; rotating URI key material is unnecessary. Server restart does change the HMAC key:
rediscover resources on reconnect. Role grants become visible on the next uncached listing.

See the upstream [listen client API](https://ts.sdk.modelcontextprotocol.io/v2/clients/subscriptions.md) and
[server notification API](https://ts.sdk.modelcontextprotocol.io/v2/servers/notifications.md).

### Hosted Claude API and Managed Agents

The [Claude API MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector) supports
**tools only**, not resources, the Skills extension or channels. `game_skill` supplies all playbooks, so the
agent can still use the complete enabled tool workflow. A **publicly reachable HTTPS URL** is required:
localhost and local stdio bridges are not reachable from hosted Claude.

Merge this into a Messages API request:

```json
{
  "mcp_servers": [{
    "type": "url",
    "url": "https://game.example/mcp",
    "name": "agent-command",
    "authorization_token": "<commander token>"
  }],
  "tools": [{ "type": "mcp_toolset", "mcp_server_name": "agent-command" }]
}
```

Send `anthropic-beta: mcp-client-2025-11-20`, or `mcp-client-2026-09-15` for connector tool-list pinning.
Use a persistent commander token as `authorization_token`, without a `Bearer ` prefix. If using OAuth access
tokens instead, the caller obtains and refreshes them; the connector does not perform the game's browser sign-in.
Managed Agents declare the MCP server on the agent and supply credentials through a vault.
The connect catalog's `claude-api` recipe is offered in **token choices only**, not browser OAuth choices.
Connector tool-list pinning is not `surfaceHash` verification: PlayerThree's hash also covers the manifest, every
served skill and session semantics. Check the game's published hash and returned metadata when pinning that contract.

### Codex CLI

```sh
codex mcp add game --url https://game.example/mcp
codex mcp login game
```

### OpenCode

```sh
opencode mcp add game --url https://game.example/mcp
opencode mcp auth game
```

`opencode mcp add <name> --url` writes the global `~/.config/opencode/opencode.json` (`"mcp": { "game": { "type":
"remote", "url": … } }`). OpenCode identifies itself with its metadata document (`https://opencode.ai/oauth/opencode/client.json`)
and a loopback callback.

### Pi

```sh
pi mcp add game --url https://game.example/mcp
pi mcp login game
```

The server lands in `~/.pi/agent/mcp.json`; run `/reload` in a running session. Pi identifies itself with its metadata
document (`https://pi.dev/oauth/client.json`) and a loopback callback.

### oh-my-pi

oh-my-pi has no shell `mcp add`; type its quick-add inside a session:

```text
/mcp add game --scope user --url https://game.example/mcp --transport http
```

Quick-add tests the connection and runs the browser sign-in itself (dynamic client registration as `oh-my-pi`,
loopback callback); `/mcp reauth game` repeats it. The same entry can go into `~/.omp/agent/mcp.json`
(`"mcpServers": { "game": { "type": "http", "url": … } }`). oh-my-pi also imports Claude Code, Codex and Cursor
MCP configs, so an existing setup for one of those connects it too.

This Streamable HTTP setup does not install a push-to-prompt extension. Transport notifications and progress
events are not themselves model turns. Keep per-role wait/observe loops running and preserve their full result
envelopes so owner messages reach the agent even without channel integration.

### Hermes Agent

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  game:
    url: https://game.example/mcp
    auth: oauth
```

Hermes shows the authorization link on first connection (`hermes mcp login game` to redo it).

### Any MCP client

```json
{
  "mcpServers": {
    "game": {
      "type": "http",
      "url": "https://game.example/mcp"
    }
  }
}
```

The client must implement MCP authorization (2026-07-28: protected resource metadata, PKCE S256, CIMD
or dynamic client registration). Clients without OAuth use a token instead (below).

### stdio bridge

```json
{
  "mcpServers": {
    "game": {
      "command": "npx",
      "args": [
        "--package",
        "@playerthree/runner",
        "playerthree-mcp",
        "--url",
        "https://game.example/mcp"
      ]
    }
  }
}
```

`playerthree-mcp` is a local stdio MCP server that forwards to exactly one URL (no redirects) and has no other
capabilities: no files, no processes, no other network access beyond that URL and a one-shot 127.0.0.1 listener for the
sign-in callback.

- Without a token it signs in through the browser (dynamic client registration, PKCE S256, `iss` check, loopback
  redirect) and prints the sign-in URL on stderr too. `npx --package @playerthree/runner playerthree-mcp --url … --login` signs in ahead of time (do
  this once before adding it to a harness that starts servers in the background); `--logout` forgets the cached sign-in;
  `--no-browser` only prints the URL. Registration and tokens are cached per URL in the user config dir
  (`$XDG_CONFIG_HOME/playerthree/oauth.json`, `~/Library/Application Support/playerthree`, `%APPDATA%\playerthree`, or
  `PLAYERTHREE_CONFIG_DIR`), mode 0600; refresh tokens rotate silently.
- It refuses to start (exit code 2) if the endpoint's `surfaceHash` differs from `--expect-hash`. Get the hash from
  the game's published safety card (`playerthree audit`), from `game_briefing`, or from the bridge's own first run
  (it prints the hash on stderr).
- Without `--expect-hash` it pins the hash it saw at startup for the rest of the session.
- The tool list it serves is the one it verified at startup; every forwarded result must carry the pinned hash, or the
  bridge stops forwarding.
- Skills are fetched once and every file is verified against its listed size and sha256 digest before it is served.
- The consent prompt (pasted tokens only) is passed through to your client.

From a repository checkout, run `node packages/runner/bin/playerthree-mcp.ts …` instead of `npx --package @playerthree/runner playerthree-mcp`.

### Pasted tokens (fallback)

For clients without OAuth, or to drive exactly one seat of one match: a **commander token** (the game's roster
screen; one named identity, persistent, rotatable) or a **seat token** (minted for one seat of one match) as a bearer token.

```sh tab="Claude Code"
claude mcp add --transport http game https://game.example/mcp \
  --header "Authorization: Bearer <token>"
```

```sh tab="stdio bridge"
npx --package @playerthree/runner playerthree-mcp \
  --url https://game.example/mcp \
  --token <token> \
  --expect-hash <surfaceHash>
```

The bridge also reads the token from `PLAYERTHREE_TOKEN` instead of `--token`.

Codex: `bearer_token_env_var = "PLAYERTHREE_TOKEN"` under `[mcp_servers.game]` in `~/.codex/config.toml`; JSON clients:
`"headers": { "Authorization": "Bearer <token>" }`.

### Consent

The first time a pasted token is used, the server asks **you** (not the agent), through your client's elicitation UI:
*"Allow an AI agent to command blue/runner in Tag? It will only receive closed-vocabulary game data (no text from other
players) and can only act through the game's typed commands for this one seat."* Declining refuses the call with
`consent_declined`; the next call asks again. The answer is remembered per token. Answers the server did not ask for
are ignored (consent requests carry signed, token-bound state).

If your client cannot show elicitation forms, adding the server with the token counts as consent; the first tool
result then says so.
Sign-in connections are not asked again: the game's consent page was the consent.

### `playerthree-run`: play with your own key

```sh tab="OpenAI"
OPENAI_API_KEY=sk-… npx --package @playerthree/runner playerthree-run \
  --url https://game.example/mcp \
  --model gpt-5-mini \
  --max-usd 0.50
```

```sh tab="Anthropic"
ANTHROPIC_API_KEY=sk-ant-… npx --package @playerthree/runner playerthree-run \
  --url https://game.example/mcp \
  --token <token> \
  --model claude-sonnet-5-5 \
  --max-usd 2
```

Without `--token` (or `PLAYERTHREE_TOKEN`) the runner signs in through the browser like the bridge (same cache,
`--no-browser`). With a connection commanding several roles, the model is told its roles and passes `role`; the
runner's own waits follow the first role. From a repository checkout, run `node packages/runner/bin/playerthree-run.ts …`
instead of `npx --package @playerthree/runner playerthree-run`.

| Flag | |
|---|---|
| `--model` | model id (`PLAYERTHREE_MODEL`); default `gpt-5-mini` with an OpenAI key, `claude-haiku-5-5` with an Anthropic key |
| `--provider` | `openai` (Responses API) or `anthropic` (Messages API); inferred from the model id |
| `--max-usd` | hard budget (default 1.00). Before each model turn the runner checks that spent + the worst case of the next turn (estimated input + `--max-output-tokens`) fits; otherwise it stops |
| `--max-output-tokens` | per turn (default 16384; a reply cut at the cap runs nothing it cut short) |
| `--reasoning-effort` | `low`, `medium` (default), `high`, `xhigh` or `off`: sent on every turn, so no API or gateway picks its own (OpenAI `reasoning.effort`; Anthropic adaptive thinking at `output_config.effort`). `off` sends none, for models without reasoning; OpenAI gpt-5/o models then run at `low` |
| `--price-in` / `--price-out` | USD per 1M tokens, required for models without a built-in price |
| `--max-turns`, `--idle-wait` | stop after N turns; game seconds to wait while the model idles (default 30) |
| `--expect-hash` | refuse unless the endpoint's surfaceHash matches |
| `--yes` | answer the consent prompt of a pasted token with "allow" (otherwise you are asked on the terminal) |
| `--token`, `--no-browser` | use a pasted token instead of signing in; only print the sign-in URL |

In chat mode an owner message wakes the model at once (also while it idles in the lobby); the runner adds it as a
user turn labelled as from the owner, and the model answers with `game_say`.

With a commander token or a connection the runner starts in the lobby: the model prepares (briefing, skills, deploy, practice);
when it idles the runner blocks in `game_wait` without spending tokens until a match seats the commander, then wakes
the model. The run ends when that match ends.

The runner follows what StarSkirmish Bench showed works: deploy a working policy first (a game's starter by
reference is one call, `policy_deploy {from}`); a policy is code the model can write or fork (`policy_deploy {code}` or
`{modules, entry}`, skill `playerthree-policy-author`, topic `modes`), and improving it is how it plays well. It follows
the seat's mandate, practices early against the strongest opponent, reads the report and the policy's logs, revises,
preserves a working policy (roll back or request rollback), then monitors with `game_wait` / `game_observe`. While the
model idles, the runner waits on the game itself (no tokens) and wakes the model with what happened, never with pacing
or time-left text; a lobby turn that ends with no active policy is first answered with the deploy step. A reply cut off
at the output cap (`--max-output-tokens`) is answered with what happened, and a tool call it cut short never runs. The
model's reasoning goes back with its tool results: Anthropic's signed thinking blocks unmodified, OpenAI's encrypted
reasoning items (`store: false` with `include: ["reasoning.encrypted_content"]`). Old tool outputs are elided from the
context to bound cost. Every turn prints tokens and dollars; the session ends cleanly when the match ends, the budget
is reached, or on Ctrl-C, with a summary line.

Programmatic consumers import from `@playerthree/runner`. `RemoteSeat.sequence()` calls the sequence tool;
`RemoteSeat.call(..., { signal })` supports cancellation. `Budget(maxUsd, price, maxTokens)` also enforces a token
ceiling. `runAgent({ ..., authoring: true })` runs a lobby authoring session with no early exit: a tool-free turn is
answered with the seat's policy status until `maxTurns`, the budget or the signal ends it (the policy benchmark's
authoring phase). `runAgent({ transcript })` receives every prompt, reply, tool call and tool result; `RUNNER_HARNESS`
names this loop in benchmark results. `createScriptedProvider(turns, model?)` supplies deterministic offline model
turns; it is a test/evaluation provider, not hosted inference.

## Safety: what each guarantee looks like from your side

| PlayerThree guarantee ([DESIGN §4](DESIGN.md#4-safety-model)) | What you observe |
|---|---|
| 1. No free-text type exists | Every `outputSchema` is closed: game data is enums, pattern-locked ids (`u_12`), bounded numbers, booleans, bounded lists. No field can carry another player's words. |
| 2. Outbound guard, fail closed | Results that would not match their schema are never sent; you get `{"error":"internal"}` instead of malformed data. |
| 3. Own-text rule | The only free text in results is the developer's documentation (briefing, skills, tool descriptions — covered by the surfaceHash), your own policy's log lines and errors in `policy_*` / `practice_run` results, and (chat mode) `messages` from your own owner, labelled `from: "owner"`. |
| 4. No third-party text channel | Your owner's guidance arrives as a typed `mandate` (including `directive`) and, if the game enables chat, as owner `messages`. Opponents, teammates and spectators cannot send you text; your `game_say` replies reach only your owner. |
| 5. Fog is server-side | `game_observe` / `game_wait` return only what your team can see; there is nothing more to ask for. |
| 6. Agent output is untrusted | Bad arguments get closed codes with schema paths (`{"error":"invalid","schemaCode":"range","path":["ticks"]}`), wrong-role or wrong-controller intents get `forbidden_role` / `not_controller`, floods get `rate_limited`. Your input is never echoed back. |
| 7. Policies are sandboxed | `policy_deploy` code runs in QuickJS-in-WASM or a capability-free WASM module with time and memory caps; overruns show up as `timeout` / `memory_limit` in `policy_status`. |
| 8. Static, pinned tool surface | Tool names, descriptions, schemas and skills are fixed at server start; `surfaceHash` in the instructions, `tools/list` `_meta` and every result lets you pin them (`--expect-hash`). No sampling or roots. Long-call progress and consent remain supported. Private listen resources add only closed lifecycle status; the explicitly enabled bridge channel projects restricted lifecycle/owner notifications. |
| 9. Scoped credentials | A seat token drives one seat in one match; commander and OAuth tokens bind one named commander and its exact live lane. Same-role opposing sessions stay isolated. Wrong, malformed, expired, rotated, revoked, owner and spectator tokens get the same `401`. Credentials cannot change controllers, mint tokens or gain omniscient observer access. |
