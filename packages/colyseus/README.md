# @playerthree/colyseus

Give any [Colyseus](https://colyseus.io) 0.18 room **agent seats**. Players attach their own LLM agents (their
harness, their tokens) to seats in your game through [PlayerThree](../../README.md), as teammates or as rivals.

This package wires a Colyseus `Room` to a PlayerThree `PlayerThreeMatch`:

- **Leased auth on join** — `options.token` is atomically claimed through `host.claimToken` for this connection and
  match. Every inbound message and private outbound delivery calls `host.authorizeLease`; expiry, replacement,
  leave, kick and match end close stale connections. MCP and Colyseus share the same first-use claim registry.
- **Exact-seat humans** — `match.mintHumanToken(team, role)` grants own-side fog but only that seat's control,
  minting, scopes, approvals and owner-agent chat. Public lobbies must never issue trusted side-root tokens.
- **Fogged views** — humans receive only their side. Scoped spectators from `match.mintSpectatorToken(team)` cannot
  watch another side. Agents never get team views; they get their own seat's observation.
- **Delayed observers** — observer tokens (`match.mintObserverToken(grant, { owner })`) receive only released, delayed
  frames on `playerthree:observer`, for the perspectives their grant allows; they are sealed from every live and owner
  channel.
- **Delta-encoded view streams** — each team's views travel as one keyframe (on join or watch) and then
  `playerthree/delta` structural deltas from the previous version; every message is encoded once and the same bytes go
  to every reader of that team. A team's stream is computed only while some client watches it.
- **Flow control** — realtime and room-stepped matches share one delivery pass, with a default 50 ms minimum interval
  per client. With `@colyseus/ws-transport`, each batch is followed by a uniquely tagged ping; the next batch waits for
  its matching pong, not an unrelated transport heartbeat. A slow client then gets the deltas it missed in one batch,
  or one keyframe when it fell more than a bounded batch behind, even if the match is paused. Join/watch keyframes,
  control replies, agent streams/chat, seats and end reports bypass this view-only gate.
- **Control messages** — `playerthree:call | playerthree:stream | playerthree:mandate | playerthree:scopes |
  playerthree:resolveApproval | playerthree:controller | playerthree:mint | playerthree:tell` are routed to the match
  with a size cap and an in-flight cap per client; results come back on `playerthree:result`. Inputs are never echoed.
- **Stream mode** — a seat agent sends `playerthree:stream` and receives `playerthree:obs` every N ticks (rate-capped by the manifest).
- **Private seats / public cards** — `playerthree:seats` includes mandate/scopes only for the human's exact seat (or the
  trusted root's side). Spectators receive no private seats. `playerthree:cards` is a separately constructed allowlisted
  AI identity payload filtered to authorized sides, with no private agent configuration or source.
- **Cleanup** — leave/disposal releases subscriptions and disconnects the lease. Human joins/leaves call
  `match.humanJoined(team, role, true/false)`; the game must separately call `setHumanReady` for explicit readiness.
  Trusted private team-root connections additionally mark their team's assigned human roles connected and ready;
  the last root departure clears readiness for roles without a remaining human connection. This compatibility
  behavior is never available through a public human ticket and never affects the opposite team.

Nothing here is game-specific, and nothing an opponent types can reach your agents: PlayerThree's schemas have no
free-text type and every outbound message passes the closed-vocabulary guard.

## Install

```sh
npm install playerthree @playerthree/colyseus @colyseus/core @colyseus/ws-transport
```

To develop against a checkout instead, clone `player-three` beside your game and depend on its packages with pnpm
`link:` specifiers (`"@playerthree/colyseus": "link:../player-three/packages/colyseus"`,
`"playerthree": "link:../player-three/packages/playerthree"`), as Agent Command does; see
[CONTRIBUTING](../../CONTRIBUTING.md#two-repositories).

## Use

**1. Create the host.**

The host owns every match; `definition` is your PlayerThree `GameDefinition`.

```ts title="server.ts"
import { defineRoom, defineServer, Room, type Client } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { createPlayerThreeHost } from 'playerthree/host';
import {
  bindPlayerThreeRoom,
  type PlayerThreeRoomBinding,
} from '@playerthree/colyseus';
import { definition } from './my-game.ts';

const host = createPlayerThreeHost({ definition });
```

**2. Bind the room.**

Create the match server-side, then bind it to the room. The binding issues exact-seat human or
fixed-perspective spectator tickets and forwards the room lifecycle. `dispose()` also disposes the
match; opt out with `disposeMatch: false`.

```ts title="server.ts"
class MyRoom extends Room {
  playerThree: PlayerThreeRoomBinding | undefined;

  onCreate(options: { matchId: string }) {
    const match = host.getMatch(options.matchId)!;
    this.playerThree = bindPlayerThreeRoom(this, { host, match });
  }
  onAuth(client: Client, options: unknown) {
    return this.playerThree?.onAuth(client, options) ?? false;
  }
  onJoin(client: Client, options: unknown) {
    this.playerThree?.onJoin(client, options);
  }
  onLeave(client: Client) {
    this.playerThree?.onLeave(client);
  }
  onDispose() {
    this.playerThree?.dispose();
  }
}
```

**3. Start the server.**

Policy uploads travel over the room, so raise the ws frame cap (default 4 KiB) to your policy size.

```ts title="server.ts"
const server = defineServer({
  transport: new WebSocketTransport({ maxPayload: 256 * 1024 }),
  rooms: { my_room: defineRoom(MyRoom) },
});
await server.listen(2567);
```

Client side (`@colyseus/sdk`):

**4. Follow the view.**

`applyView` applies a keyframe, or a delta onto exactly the previous version. It returns
`undefined` on a gap (a protocol error); rejoin to get a keyframe. `MSG` holds the message names
(`MSG.view === 'playerthree:view'`).

```ts title="client.ts"
import { applyView, MSG, type ViewState } from 'playerthree';

const room = await client.joinById(roomId, { token: humanSeatToken });
let view: ViewState | undefined;
room.onMessage('playerthree:view', (message) => {
  view = applyView(view, message);
  if (view) render(view.view);
});
room.onMessage('playerthree:seats', ({ seats }) => updatePanel(seats));
room.onMessage('playerthree:cards', ({ cards }) => updatePublicCards(cards));
room.onMessage('playerthree:result', (r) => resolvePending(r.seq, r));
```

**5. Send requests.**

Each request carries a `seq`; its `playerthree:result` echoes it. `mint` returns `{ role, token }`
for the player's agent.

```ts title="client.ts"
room.send('playerthree:mint', { op: 'mint', seq: 1, role: 'squad' });
room.send('playerthree:controller', {
  op: 'controller',
  seq: 2,
  role: 'squad',
  controller: 'agent',
});
room.send('playerthree:call', {
  op: 'call',
  seq: 3,
  role: 'squad',
  method: 'act',
  args: { intents: [{ kind: 'move', x: 4, y: 9 }] },
});
```

Scoped spectators join with `{ token, watch: ['blue'] }`; their credential's side is the default and the only
permitted watch perspective. Unscoped spectator/root tokens remain trusted private APIs, not public lobby tickets.
An extra human seat connection can join with `{ token, view: false }` to receive exact-seat results, private seats
and agent replies without duplicate own-side view/report traffic. This does not change its seat authority.

Agents can connect over `playerthree/mcp`, which serves MCP `2026-07-28` (`server/discover` plus the per-request
envelope) and 2025-era clients (the `initialize` handshake), both stateless. A temporary match-seat token claims its
lease on its first real request (discovery claims nothing); that response returns an `Mcp-Session-Id`. Send that ID
with the bearer on every subsequent request. A second client or handshake using the same seat ticket is rejected;
only trusted owner reissue/revocation permits a replacement. HTTP DELETE with that session ID terminates the session
and its credential. Persistent commander/OAuth credentials hold no session and keep their multi-match semantics.
On revocation, pending MCP exchanges receive a terminal generic authorization error before their streams close;
no pending private result is delivered. At match end, authorized own-side terminal reports are sent before lease
revocation, through an immediate socket write rather than the pending join-acknowledgement queue. No queued
views are flushed and no lease is extended for delivery; subsequent calls, streams and admissions are denied.

## Options

| Option | Default | |
|---|---|---|
| `host`, `match` | — | The `PlayerThreeHost` and the match this room carries. |
| `maxMessageBytes` | `MAX_MESSAGE_BYTES` (1 MiB) | JSON size cap per inbound message (keep the transport's `maxPayload` ≥ this). |
| `maxInFlight` | 4 | Unanswered requests per client before replying `busy`. |
| `seatsIntervalMs` | 1000 | How often seat liveness changes are checked. |
| `viewIntervalMs` | 50 | Minimum interval between view batches per client; `0` disables the rate bound, not WebSocket backpressure. |
| `allow` | all | Principal kinds allowed to join (`team`, `human`, `seat`, `spectator`, `observer`). |
| `disposeMatch` | `true` | Dispose the match with the room. |

Also set `room.maxMessagesPerSecond` to bound per-client message floods.

The room clock must keep ticking while the match is paused (normal Colyseus rooms already do). The binding never
replaces `client.enqueueRaw`, and removes its pong listeners and timers on leave/dispose. The built-in ping adapter
uses the structural `client.ref` interface (`ping`, `on`, `off`) of `@colyseus/ws-transport`; transports without that
interface still get coalescing and rate limiting, but cannot provide the WebSocket read acknowledgement.
Pongs acknowledge socket reads, not completion of the browser's rendering work. The transport's normal heartbeat
remains enabled: a client that stops reading for longer than its heartbeat timeout can still be disconnected.

The real-server/SDK regression tests pause the client's actual receive socket across multiple heartbeat windows,
exercise realtime and stepped matches, and assert isolation, no disconnect, bounded catch-up, and that the state the
client rebuilds from keyframe + deltas equals the match's current view after pausing the match. Separate tagged-pong
cases keep heartbeat pongs flowing while holding view acknowledgements, checking that keyframes, results, seats and
reports remain immediate.

## Messages

| Type | Direction | Payload |
|---|---|---|
| `playerthree:call` | client → server | `{ op: 'call', seq, role, method, args }` (`args` = the MCP tool input) |
| `playerthree:stream` | client → server | `{ op: 'stream', seq, role, everyTicks }` (seat agents; `0` stops) |
| `playerthree:mandate` | owner → server | `{ op: 'mandate', seq, role, mandate: { autonomy, directive, limits?, whenAbsent } }` |
| `playerthree:scopes` | owner → server | `{ op: 'scopes', seq, role, scopes }` (replaces the live seat's agent permissions) |
| `playerthree:resolveApproval` | owner → server | `{ op: 'resolveApproval', seq, role, id, approve }` |
| `playerthree:controller` / `playerthree:mint` | owner → server | `{ op, seq, role, … }` |
| `playerthree:tell` | owner → server | `{ op: 'tell', seq, roles, text, ping? }` (chat mode; `roles` is a role list or `'all'`) |
| `playerthree:watch` | spectator → server | `{ op: 'watch', teams }` (match teams only, rate limited per spectator token; views, reports and observer perspectives cover the match's teams, not every manifest team) |
| `playerthree:observer` | observer → server | `{ perspective, after? }` (no other keys; a match team the grant allows, or `'all'` for an omniscient grant) |
| `playerthree:result` | server → client | `{ op: 'result', seq, ok, data \| code }` |
| `playerthree:view` | server → owners/spectators | `{ op: 'view', team, version, view }` (keyframe) or `{ op: 'view', team, version, delta }` (from `version - 1`) |
| `playerthree:obs` | server → seat agent | `{ op: 'obs', role, data }` |
| `playerthree:seats` | server → owners | `{ op: 'seats', seats }` (only privately owned seats) |
| `playerthree:cards` | server → owners/spectators | `{ op: 'cards', cards }` (public identity DTOs only) |
| `playerthree:report` | server → owners/spectators | `{ op: 'report', team, data }` |
| `playerthree:said` | server → owners | `{ op: 'said', role, tick, text }` (an agent's chat reply: to its exact human seat or the trusted team root only) |
| `playerthree:observer` | server → observer | `{ op: 'observer', state, grant?, frame? }` (`state`: `buffering`, `ready` or `closed`; delayed `frame`s carry a keyframe `world` or a `delta`) |

`playerthree:call` also carries `method: 'sequence'` with `{ steps: [{ in, intents }], cancelOn? }` when the game enables
sequence mode. Seats keep their assigned controller when an agent is absent; `mandate.whenAbsent` chooses policy,
fallback bot, or hold behavior, or (games declaring `control.pausable`) `pause`: the session stands still and the seat
list carries `pause: { reason, tick, since, until? }` on each seat holding it. A supervised deploy, rollback, or publish
returns an approval request; only the team owner may resolve it through `playerthree:resolveApproval`. Mandate and approval
changes refresh the seat list immediately.

## Requirements

Colyseus `^0.18`, Node ≥ 24 (from a checkout, Node runs the TypeScript sources directly through type stripping; the
packed package ships compiled `dist/`). Apache-2.0 licensed.

Reference game: Agent Command — a 3D RTS on four stacked planes where you hand the planes you are not watching to your agents.
