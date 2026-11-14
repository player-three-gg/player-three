# PlayerThree DevTools

DevTools is the **operator console**: one page on the game server for the game's developers and operators. It
shows every session from every side (unfogged when the game supports it), live and recently released, scrubs
replays, ends sessions, manages commanders, agent connections and the policy pool, and shows bench results, the
game's safety surface and its match options. It is not a player screen: player credentials never open it. Players use
the separate [player API](#player-api).

## Mounting

```ts
import { mountDevtools, createDevtoolsHandler } from 'playerthree/devtools';

// serves /playerthree/devtools; returns { handler, close }
mountDevtools(httpServer, host);
```

To route requests yourself, use the handler directly:

```ts
const dt = createDevtoolsHandler(host);
if (await dt.handle(req, res)) return;
```

`mountDevtools` wraps the server's request listeners like `mountMcp`: requests under `path` never reach other
listeners. `createDevtoolsHandler(host, opts).handle(req, res)` resolves `false` for other paths without writing;
`close()` unsubscribes from the host and ends open streams.

| `DevtoolsOptions` | Default | |
|---|---|---|
| `path` | `/playerthree/devtools` | Mount path |
| `history` | `600` | Trace events kept per session for late joiners |
| `authorize` | — | Production: `(req) => boolean \| Promise<boolean>` backed by the game's admin auth |
| `operatorToken` | — | Production fallback: static secret, 32–512 printable ASCII characters without spaces |
| `oauth` | — | The game's MCP `AuthorizationServer`; enables listing and revoking sign-in connections |
| `benchResultsDir` | — | Bench output directory (`playerthree-bench --out`): it and its immediate subdirectories holding a `results.json` are listed in **Bench** |
| `safetyCard` | — | Path of the game's Safety Card (`playerthree audit … --out SAFETY.md`), shown in **Safety** |

Recent sessions come from the host, not the console: `createPlayerThreeHost({ history })` keeps released sessions (see
[Recent sessions](#recent-sessions)). Host default match options (`createPlayerThreeHost({ matchOptions })`) appear in
**Game settings**.

The `playerthree` CLI comes from `@playerthree/cli` and `playerthree-bench` from `@playerthree/bench`. From a checkout
of this repository, run `node packages/cli/bin/playerthree.ts audit …` and `node packages/bench/bin/playerthree-bench.ts …`
instead (see [CLI](CLI.md)).

## Access

Exactly one mode is active per mount. Passing both `authorize` and `operatorToken`, or a malformed token, throws at
mount. Player credentials (team owner, seat, spectator, commander tokens, OAuth access tokens) never grant access.

**Local (default, no credential).** For development on the developer's own machine. Requests are accepted only when:

- the TCP peer is loopback (127.0.0.0/8, `::1`, `::ffff:127.x`);
- no proxy header is present (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, `X-Client-IP`, `True-Client-IP`,
  `CF-Connecting-IP`, `Fastly-Client-IP`), so a same-host reverse proxy cannot make public requests look local;
- `Host` is `localhost`, `127.0.0.1` or `[::1]` (any port), blocking DNS rebinding;
- `Sec-Fetch-Site`, when present, is `same-origin`, and `Origin`, when present, is a loopback origin (any port, so a
  dev server such as Vite may proxy it), blocking cross-site reads and CSRF;
- state-changing requests also carry `Origin` or `Sec-Fetch-Site` and a JSON body, which a cross-origin page cannot
  send without a CORS preflight that is never answered. Local `curl`/scripts may read freely; to write they send an `Origin`.

**`authorize` (production).** The game's hook decides for the page and every API request, typically from its admin
session cookie. Because cookies are ambient, writes additionally need a same-origin `Origin`/`Sec-Fetch-Site` and a
JSON body.

```ts
mountDevtools(httpServer, host, {
  // your existing admin auth
  authorize: async (req) =>
    (await adminSessionFromCookie(req))?.isAdmin === true,
  oauth: authServer,
});
```

**`operatorToken` (production fallback).** A long static secret sent as `Authorization: Bearer …`. It is compared in
constant time (SHA-256 digests + `timingSafeEqual`) and accepted only over HTTPS (TLS socket, or `X-Forwarded-Proto:
https` from the TLS-terminating proxy) or from a direct loopback peer. It never appears in URLs: the page asks for it
once and keeps it in `sessionStorage` (this tab only); **Sign out** clears it. Generate one with, for example,
`openssl rand -base64 32`.

```ts
mountDevtools(httpServer, host, {
  operatorToken: process.env.OPERATOR_TOKEN,
});
```

## Sections

- **Overview** — game identity, modes, teams/roles; live, ended and recent session counts; active agents, owners,
  commanders and connections; rejections and policy errors over the last 15 minutes with top codes and recent problems.
- **Sessions** — live sessions first, ended ones the host still holds, then **Recent** (released by the host, from its
  history). Per session: seats, controllers and mandates, **God / side / seat** perspectives, all sides' traces live,
  policy stats and practice, replay scrubbing, replay download, and **End** (draw for every side still playing, or one
  alliance or unallied team wins and the rest lose, with
  confirmation). A recent session opens in the same timeline (every perspective, scrubbing, export) with its record:
  times, seed, options, match teams and alliances, outcome and rank per match team, seats with controller, owner and the harnesses that held them, rejection and
  policy-error codes. A live session's page that turns into "no longer held" links to its recent entry when the
  history has it.
- **Agents** — owners (searchable), their named commanders (ID, name, compatible roles, kind, scopes, mandate, activity, exact seat, policy versions,
  approvals, rejection codes) and sign-in connections. **Rotate** revokes a commander token at once, also inside a
  live match; the new token is not returned (the owner gets it from the game's UI). **Revoke** removes a connection
  (requires `oauth`).
- **Policies** — every named commander's isolated library (active version; each version's runtime, size and creation time; last
  practice; W/L/D; the seat it plays), the **bot pool** (entry, role, runtime, publisher: the commander's owner, or the
  session/team for seat-published entries with the team's owner when known; random drafts; W/L/D; status) with
  **Disable/Enable** (stop drafting; seats already running it keep playing) and **Unpublish** (delete entry and
  artifact), and how policies fail: crashes (`threw`, `memory_limit`), timeouts and other errors (bad output, failed
  deploys) over the last 15 minutes per seat and across the recent sessions, plus live per-seat call stats.
- **Bench** — read-only canonical `playerthree.results` v1 envelopes, validated against the shared closed schema.
  Each directory shows series state/revision, surface, comparison hash, held-out seeds, tick cap and authoring budgets;
  standings use `entrantId` and include W/L/D, score rate, rating and provisional state. Usage shows phase, reporter,
  currency and coverage; unknown token/cost values remain unknown, never zero. Decision latency separates sources.
  Match rows retain accepted/excluded attempts, physical-side bindings and outcomes. Available `playerthree.replay`
  artifacts open from `artifacts/<encoded-artifact-id>.json`; optional `report.md` remains readable. CLI execution
  and model credentials stay outside the console. Old benchmark formats are not accepted.
- **Safety** — `surfaceHash`; enabled modes with their limits; the scope vocabulary with the defaults for new seats;
  the Safety Card when `safetyCard` is set (flagged stale when it does not mention the current surface hash), else how
  to generate it with `playerthree audit`; rejection codes over the last 15 minutes and over the recent sessions.
- **Game settings** — read-only: the `manifest.matchOptions` schema (type, description, host default per option) and
  the options every live and recent session runs with. Rules are the game's to define and the server's to pass;
  the console does not edit them.

God view uses optional `GameAdapter.debugView(): unknown`, which supplies **bounded, JSON-compatible unfogged state**;
`PlayerThreeMatch.debugView()` forwards it or returns `null`. It deliberately bypasses player-view schemas, so the adapter
must bound it; it is never exposed through agent tools or the player API. Side perspectives use the guarded side
view; seat perspectives show the last delivered observation (no fresh observation is triggered). Ending a session
calls `PlayerThreeMatch.end()`; games that implement `GameAdapter.end(outcomes, ranks)` adopt the declared outcomes and
ranks so their views and reports agree.

Controller assignment and presence are distinct: an assigned agent stays controller `agent` while absent.
`agentActive` reflects a recent call, an in-flight call or an active sequence; the mandate's `whenAbsent` chooses
deployed policy/fallback bot, bot only, hold, or (games declaring `control.pausable`) pause: the session stands still;
seats show `pause`, sessions `paused()`. A sign-in connection alone does not imply activity.

### Keyboard and links

| Keys | |
|---|---|
| `g o` / `g s` / `g a` / `g p` / `g b` / `g y` / `g t` | Overview / Sessions / Agents / Policies / Bench / Safety / Game settings |
| `1` … `7` | The same, by number |
| `/` | Filter agents |
| `[` / `]` | Step tick back / forward |
| `l` | Back to live |
| `p` | Pause feed |
| `Esc` | Close dialog |

Deep links use the hash: `#overview`, `#sessions/<id>`, `#recent/<id>`, `#agents?q=<owner>`, `#policies`, `#bench`,
`#bench?dir=<key>&replay=<path>` (a bench replay in the timeline), `#safety`, `#settings`.

## HTTP API

The page and a JSON API under `<path>/api/*` (default `/playerthree/devtools`). Responses are `application/json` with
`cache-control: no-store`; the page has a strict per-response-nonce CSP. Writes are `POST` with a JSON body. Errors
are `{ error, message? }`.

| Endpoint | Result |
|---|---|
| `GET /api/overview` | `access` mode, game info, session counts, agent counts (`connections: null` without `oauth`), 15-minute problem window |
| `GET /api/sessions` | `{ sessions, recent, history }`: held sessions (live newest first, then ended: status, tick, match `teams`, `alliances` (or null), `outcomes` per match team, `ranks` (null until over), seats, owners, active agents, rejections), recent records (with `teams`, `alliances`, `outcomes`, `ranks`), the history's bounds |
| `GET /api/sessions/:id/state` | All sides: seats, last observations, policy status and calls, practice, trace history |
| `GET /api/sessions/:id/stream` | SSE: `status` every second, `trace` for every event (observations coalesced to ≤ 4/s per seat) |
| `GET /api/sessions/:id/view?perspective=god\|side:<team>\|seat:<team>/<role>` | `{ tick, data }` (god `null` without `debugView()`), or `{ tick, observation }` for a seat |
| `GET /api/sessions/:id/scrub?tick=N&perspective=…` | Isolated re-simulation: `{ tick, ticks, from, paused, data, entries, events }` (`from`: first tick a persistent session keeps; `paused`: seats holding a pause at T) |
| `GET /api/sessions/:id/replay` | The deterministic replay file as an attachment |
| `POST /api/sessions/:id/end` | Body `{ outcomes: 'draw' \| { [team\|alliance]: 'win'\|'loss'\|'draw' } \| { [team\|alliance]: placement } }`, covering every match team (allies agree; teams already out keep their outcome) → `{ id, tick, status, outcomes, ranks }` |
| `POST /api/replays` | Body: exported replay JSON → `{ replay, ticks, seats, game }` |
| `GET /api/replays/:key/scrub?tick=N&perspective=…` | Scrub an uploaded replay with the same perspectives |
| `GET /api/recent/:id` | `{ game, record, seats, scrubbable, reason }`: a released session's record (`reason` explains why it cannot be scrubbed) |
| `GET /api/recent/:id/scrub?tick=N&perspective=…` | Scrub a recent session like a held one |
| `GET /api/recent/:id/replay` | Its recorded replay as an attachment |
| `GET /api/agents?q=<owner>&limit=<1..500>` | `{ oauth, window, total, owners }`: commanders and connections per owner, active first (default limit 100) |
| `POST /api/agents/rotate` | Body `{ owner, commander }` (exact commander ID) → `{ ok: true }` |
| `POST /api/agents/revoke` | Body `{ owner, connection }` → `{ ok: true }` |
| `GET /api/policies` | `{ modes, libraries, pool, errors: { window, live, history } }` |
| `POST /api/policies/pool` | Body `{ id, action: 'disable' \| 'enable' \| 'unpublish' }` → `{ ok, entry }` / `{ ok, id, unpublished }` |
| `GET /api/bench` | `{ configured, root, results }`: canonical series summaries (`key`, `seriesId`, revision/state, entrants, standings, usage, latency, completeness and matches with artifact replay paths) |
| `GET /api/bench/:key/report` | `{ name, text }`: its `report.md` |
| `POST /api/bench/replay` | Body `{ dir: <key>, path }` (the exact persisted path derived from an available canonical replay artifact) → `{ replay, ticks, seats, game, name }`, scrubbed like an upload |
| `GET /api/safety` | `{ game, surfaceHash, modes, scopes, card, audit, rejections: { window, history } }` |
| `GET /api/settings` | `{ schema, defaults, sessions }`: match options JSON Schema, host defaults, options per live/recent session |

| Status | Codes |
|---|---|
| 401 | `unauthorized` (token mode: missing or wrong token) |
| 403 | `forbidden` (authorize hook), `loopback_only`, `forbidden_host`, `forbidden_origin`, `https_required` |
| 404 | `not_found`, `session_not_found` (with `recent: true` when the history has the session), `replay_not_found`, `commander_not_found` |
| 400 / 405 / 409 / 413 / 415 | `invalid`, `method_not_allowed`, `session_over` / `persistent_session` (persistent sessions have no outcome; the game closes them, so the page offers no End), `invalid` for a request body, replay or bench file too large or a replay too long, `json_required` |
| 422 | `invalid`: a bench `results.json` that is not a valid `playerthree.results` v1 envelope, or a bench replay that is not JSON |
| 429 / 501 / 500 | `busy` (both scrub slots or this source's slot occupied; the page retries after ~150 ms; a third concurrent upload also gets 429), `oauth_not_mounted`, `internal` (also when the `authorize` hook throws) |

The stream ends when the host disposes the session; clients reconnect with backoff and treat 404 as gone. A client
that leaves more than 256 KiB unread is disconnected. In token mode the page reads SSE with `fetch` so it can send
the `Authorization` header.

## Recent sessions

When the host releases a session (the game disposes it: Agent Command after `END_GRACE_SECONDS`, an idle or duration
cap, shutdown), `host.history` keeps a record and the replay:

```ts
createPlayerThreeHost({
  definition,
  history: {
    maxSessions: 50,
    maxAgeMs: 24 * 3_600_000,
    maxBytes: 64 * 1024 * 1024,
    dir,
  },
});
// newest first: SessionRecord[]
host.history.list();
// the recorded replay, or undefined
await host.history.replay(id);
```

A `SessionRecord` holds id, game and version, seed, options, match `teams`, `alliances` (or null), created/ended/released
times, ticks and game seconds, outcome per match team, `ranks` (or null), owners per team, `sameOwnerOpposed` (the
owner's own practice: never rated or ranked), seats (controller at release, owner, commander roster or not, policy version or pool
entry, `harnesses`), rejection and policy-error counts with their top codes, the replay size and `from` (first tick a
persistent session's replay window covers). Rejections count the same way as the Overview window (agent, policy and
stream inputs); the host keeps its trace on while the history is on.

Bounds (defaults): **50 sessions**, **24 hours**, **64 MiB** of serialized replays; the oldest go first. A replay
larger than the byte budget on its own is dropped and the record kept. `maxSessions: 0` turns the history off.
In memory by default; with `dir` each session is one `<id>.json` (record + replay) written to a temporary file and
renamed, pruned with the bounds, and reloaded at startup (interrupted writes and unreadable files are skipped). A
`store` (your own `HistoryStore`, e.g. `playerthree/postgres`) wins over `dir`.
Use one directory per game; `host.history.flush()` awaits pending writes (call it after `host.dispose()` on shutdown).

**Data reset.** Records stored before per-match team subsets (no `teams`) or without the `sameOwnerOpposed` mark are
skipped at load. Reset with `DELETE FROM playerthree_sessions;` (PostgreSQL; `playerthree db reset` resets every
PlayerThree table) or delete the JSON history directory.

`harnesses` come from transports: the console reports, per seat that acted as an agent, the owner's active sign-in
clients holding the role (`<client name> (<software id>) · sign-in`), else `commander token`, else `seat token`
(`host.history.annotate(session, team, role, label)`). Recent sessions scrub through the same limits as uploads;
one recorded with another game version or a persistent session's window (its checkpoints were released with it) is
export-only, and one kept without its replay shows only its record.

## Replay scrubbing

Choose a tick with the slider or `[` / `]`, switch among **God**, any **side** or any **seat**, and return with
**Live**. **Load exported replay** accepts the host's exported replay JSON; game ID and `gameVersion` must match the
running definition exactly, and files are never executed as code.

Scrubbing reconstructs the recorded seed, match options, controller/mandate entries and applied intents in an
isolated adapter. It never steps, observes or changes the live session. Tick T includes recorded inputs at T, before
the next step. God uses optional `debugView()`; sides use guarded `view(side, { snapshot: true })`; seats use guarded
`observe(seat, max(-1, T-1))`, a fresh historical observation rather than the last live delivery. Up to 200 recorded
inputs within ±1 tick accompany the snapshot, plus retained session trace events within ±1 tick. Old host trace events
can already have expired; exported replays contain inputs, not policy logs or observation traces.

The host keeps an isolated forward cursor per source. Optional `GameAdapter.clone()` enables independent checkpoints
every 500 ticks; clones MUST copy all mutable simulation state, RNG, buffers, maps and caches. The cache holds at most
four timelines and 80 checkpoints within a **256 MiB conservative retained-graph budget**, thinning densely spaced
checkpoints to preserve coverage across the match. Backward seeks restore the nearest earlier checkpoint; adapters
without cloning restart from zero.

Limits: **36,000 target ticks** (20,000 without cloning), **100,000 entries**, **two concurrent simulations** (one
per source), **two minutes** per seek, and the last four uploaded files of at most **5 MiB** each. Over-limit work
returns 413 with a “too long”/“too large” message; occupied slots return 429. Work yields every 100 steps/inputs, and
superseded browser requests cancel their server simulation. Limits are cooperative: one synchronous adapter call
cannot be interrupted. Loading another source or closing the console never changes a live session. Persistent
sessions keep a rolling replay window: scrubbing starts from the session's kept checkpoint (`PlayerThreeMatch.checkpoint`),
ticks before `from` are unavailable, and the limits apply to the span after `from`.

## Player API

The owner-scoped API is separate from the operator console and is the backend of the player console
(`@playerthree/console`, see [DX](DX.md#player-console--implemented)). `path` defaults to `/playerthree/player`,
and history defaults to 600 events per session. `owner` is optional: it maps your authenticated player profile to a
commander-roster owner id.

```ts
import { createPlayerApiHandler } from 'playerthree/devtools';
const player = createPlayerApiHandler(host, {
  path: '/playerthree/player',
  owner: (req) => mySessionOwner(req),
});

// in your request listener
if (await player.handle(req, res)) return;
```

| Endpoint | |
|---|---|
| `GET <path>/state` | Snapshot: `match`, `team`, `target`, `tick`, `outcome`, the authorized `seats` and role-keyed `readiness`, observations (with byte size), policy status, recent policy calls, practice runs and trace events; for profile access also `commanders`, the owner's named-commander roster |
| `GET <path>/stream` | Live `PlayerThreeTraceEvent`s over SSE (observations coalesced to ≤ 4/s per seat) + 1 Hz status; 409 `not_in_match` without a live seat |

Access is decided per request:

- `Authorization: Bearer <capability>`: a human seat token sees exactly its seat; a trusted private team owner token
  sees its own team in that match.
- Otherwise `owner(req)` resolves the game's own authenticated profile; a caller-supplied owner id grants nothing.
  Without a selection the state carries only that owner's `commanders` roster (`match`, `team` and `target` null),
  even while commanders are seated. Live data needs the complete quartet
  `?commander=<id>&match=<id>&team=<team>&role=<role>`, naming a commander of that owner that currently holds exactly
  that lane. Partial or repeated quartet fields get 400 `bad_message`; a foreign, stale or forbidden selection 403
  `forbidden`.
- Agent seat, spectator and observer tokens, or a capability combined with a quartet, get 403 `forbidden`; with
  neither a known capability nor a resolved owner the answer is 401 `bad_token`.

Owners see only their own seats, observations (with byte size), intents/acks, policy stats/logs, approvals and
practice — exactly what their own agents already receive. Rejected agent input is never shown, only its closed code
and schema path; commander tokens are never included.

## Out of scope in the console

Starting bench runs (model-free bots or BYOM: use `playerthree-bench`) and editing match options or default mandates
(the game defines its rules, the server passes them) stay outside the console.

## Agent Command

Agent Command mounts the console with no credential locally — `pnpm dev` prints the plain
`http://localhost:2567/playerthree/devtools` URL — and in static-token mode when `OPERATOR_TOKEN` is set (a Railway
secret in production, where the console is mounted only with it; `PLAYERTHREE_DEVTOOLS=0` turns it off). Its
dev-admin endpoints keep their own `AC_DEV_ADMIN_TOKEN` (development only). Its `debugView()` snapshot is shared with the
dev-admin god endpoint: entity detail is capped at **2048** entries, with `entitiesOmitted` reporting the rest.

Server variables: `HISTORY_DIR` (keep Recent sessions on disk; unset in production unless you opt in; with
`DATABASE_URL` they live in PostgreSQL instead), `HISTORY_SESSIONS` / `HISTORY_HOURS` / `HISTORY_MB` (bounds, default
50 / 24 / 64), `BENCH_RESULTS_DIR` and `SAFETY_CARD`. `pnpm dev` sets `HISTORY_DIR=<DATA_DIR>/history` (when
`DATA_DIR` is set), `BENCH_RESULTS_DIR=<repo>/bench-results` (where `pnpm bench` writes) and
`SAFETY_CARD=<repo>/SAFETY.md` unless they are set. Matches are released `END_GRACE_SECONDS` (default 120) after they
end.

See [SPEC](../spec/SPEC.md#operator-console--implemented).
