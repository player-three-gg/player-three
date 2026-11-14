# @playerthree/console

The player console for PlayerThree games: what the player's own agents are doing, on the player's own seats only.
A headless client over the game's player API, plus an optional framework-free drop-in panel. Browser-safe: no Node
built-ins, no framework.

## Server: mount the player API

The optional `owner` maps your owner credential to a commander-roster owner id (the lobby view).
`path` defaults to `/playerthree/player`.

```ts
import { createPlayerApiHandler } from 'playerthree/devtools';

const player = createPlayerApiHandler(host, {
  path: '/playerthree/player',
  owner: (req) => mySessionOwner(req),
});

// In your request listener:
if (await player.handle(req, res)) return;
```

An authenticated host profile resolved by `owner` sees its named commander roster by default, even while those
commanders are seated. Roster entries have no permanent team; multiple entries may support the same role.
A commander may hold several compatible role lanes on one side; its transient `seated` attachment contains
`{match,team,roles}`. Each live console request still selects exactly one scalar `role`.
Live profile requests must explicitly select `?commander=<id>&match=<id>&team=<team>&role=<role>`. All four values
must match that owner's current commander lease. Invalid, foreign, stale or cross-side/broader-view selections
fail closed; the API never chooses the first side or exposes opponent/observer channels.

Human capabilities see only their exact seat. Trusted private team-root capabilities see their own team, and must
never be issued to public lobby players. Agent, spectator and observer capabilities are refused.

## Client

`credential` is authenticated by the host's profile resolver and is never an owner id. `target`
returns `{ commander, match, team, role }`, or `undefined` for the roster. The optional
`pricePerMTok` prices the estimate per million input tokens (any currency).

```ts
import { createPlayerConsole } from '@playerthree/console';

const client = createPlayerConsole({
  credential: () => profileCredential,
  url: '/playerthree/player',
  target: () => selectedCommanderSeat,
  pricePerMTok: 3,
});
```

`subscribe` delivers each `ConsoleSnapshot`. `start()` polls `/state` every 2 s and follows
`/stream` while a match runs; `stop()` ends it.

```ts
const off = client.subscribe((s) => render(s));
client.start();
```

Each `ConsoleSnapshot` has `status` (`idle` / `connecting` / `live` / `error` with a closed `error` code), `game`,
`phase` (`lobby` / `match`), `match`, `team`, `tick`, `outcome`, `streaming`, `seats`, `estimate` and `updatedAt`.
Per `ConsoleSeat`:

| Field | |
|---|---|
| `commander`, `name`, `roles`, `role`, `team`, `target` | Stable named ID and compatible roles; runtime role/team are null in the lobby; exact approval target |
| `controller`, `live`, `present`, `paused`, `lastSeenAt` | Runtime controller (lobby: execution kind `agent`/`policy`); connection presence |
| `readiness` | Exact live readiness/probe/consent state (`ready`, `online`, `waiting`, `absent`, `stale_policy`, `policy_failed`, `consent_required`); null in the lobby |
| `mandate`, `scopes`, `limits` | Owner settings; `limits` is `mandate.limits` |
| `approvals` | Pending supervised proposals as `{role,approval}[]`: all commander lanes in the lobby, only the selected role live |
| `policy`, `logs`, `errors` | Policy stats, own `log()` tail, deploy/call failures (newest first) |
| `intents`, `rejections` | Recent intents with closed ack codes (newest first) and rejected counts per code |
| `practice` | Practice runs with their explicitly selected compatible `role` (newest first) |
| `observation` | Last delivered observation: `bytes`, `tokens`, `cost` |

**Token estimate:** `tokens = ceil(bytes / bytesPerToken)` with `bytesPerToken` 4 by default — a rough average for
JSON, not a tokenizer; real counts vary by model. With `pricePerMTok`, `cost = tokens × pricePerMTok / 1,000,000` is
the price of the agent reading that observation once.

The credential travels only in the `Authorization` header (the stream is read through `fetch`, not `EventSource`).
Rejected agent input never reaches the console, only its closed code.

## Panel

`mount` defaults to `document.body`. `toggleKey` takes a `KeyboardEvent.code` or `.key`; `null`
disables the keyboard toggle. `actions` is optional. The panel also has `open()`, `close()` and
`destroy()`.

```ts
import { mountConsolePanel } from '@playerthree/console';

const panel = mountConsolePanel({
  console: client,
  mount: hudElement,
  toggleKey: 'Backslash',
  roleLabel: (role) => ROLE_NAMES[role],
  currency: '$',
  actions: {
    resolveApproval: (target, id, approve) =>
      myOwnerApi.resolveApproval(target, id, approve),
  },
});
panel.toggle();
```

Approval targets are either `{kind:'commander', commander, seat?:{match,team,role}}` or
`{kind:'seat', match,team,role}`. Route the first through the authenticated profile's commander-ID API and the
second through the live exact-seat owner capability. Do not reinterpret a role as a commander ID or broaden a
human seat capability to the whole team. Policy/practice/settings/chat controls belong to the corresponding
owner-private commander API; observation and intent traces belong only to the explicitly selected live seat.

Hidden by default; the key never fires while the player types in a field or holds Ctrl/Alt/Meta. The client polls
only while the panel is open (`pollWhileHidden: true` to keep it running). Everything is rendered as text.

Theme it with CSS custom properties on the panel or any ancestor; all built-in selectors use `:where()`, so your own
rules on the `playerthree-console*` classes always win:

`--playerthree-console-bg`, `-panel`, `-fg`, `-muted`, `-border`, `-accent`, `-ok`, `-bad`, `-warn`, `-font`, `-mono`,
`-size`, `-radius`, `-shadow`, `-width`, `-position` (default `fixed`), `-inset` (default `12px 12px 12px auto`),
`-z`.
