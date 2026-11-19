/**
 * @playerthree/colyseus — bind a Colyseus `Room` to a PlayerThree `PlayerThreeMatch`.
 *
 * What the binding does (and nothing game-specific):
 *  - `onAuth`: atomically claims a host authorization lease for this connection and match.
 *    Every inbound request and private delivery reauthorizes that lease; revocation closes the connection.
 *  - routes `MSG.call | stream | mandate | scopes | resolveApproval | controller | mint | tell` to `match.handleMessage`
 *    with a size cap and an in-flight cap per client; replies on `MSG.result`, stream pushes on `MSG.obs`.
 *  - fan-out of each team's view stream (`match.onView` / `match.viewMessages`): a keyframe on join or watch, then the
 *    structural deltas, each message encoded once and shared by every reader of that team. Each team's guarded view
 *    goes only to that team's owner clients and to spectators that chose to watch it (`MSG.watch`, rate limited per
 *    spectator token). Seat principals (agents) never receive views — only their own stream. A team's stream is
 *    subscribed (computed) only while some client watches it.
 *  - view flow control, for every client: a client gets views about once per `viewIntervalMs` at most, and each
 *    batch is followed by a WebSocket ping: no further views until its pong shows the client has read up to there.
 *    A slow client then catches up with the deltas it missed in one batch, or with one keyframe when it fell more
 *    than a bounded batch behind, instead of backing up its socket until the transport's heartbeat drops it as
 *    unresponsive. Nothing else (join/watch keyframes, seats, results, stream pushes, reports, chat) is held back.
 *  - pushes `MSG.seats` and `MSG.cards` (on join, on change) and `MSG.report` (once a team's outcome is decided).
 *  - observer principals choose a granted perspective with `MSG.observer` and receive only its released observer
 *    frames; they get no views, seats or RPC.
 *  - chat mode: routes owner messages and agent replies only to the exact owning human seat (or a trusted
 *    private team-root client), never to spectators, agents, opponents or another human role on the same team.
 *  - cleans up subscriptions on leave and on dispose.
 *
 * Wire it into your room's lifecycle hooks:
 *
 * ```ts
 * class MyRoom extends Room {
 *   playerThree!: PlayerThreeRoomBinding;
 *   onCreate(options) { this.playerThree = bindPlayerThreeRoom(this, { host, match: host.getMatch(options.matchId)! }); }
 *   onAuth(client, options) { return this.playerThree.onAuth(client, options); }
 *   onJoin(client, options) { this.playerThree.onJoin(client, options); }
 *   onLeave(client) { this.playerThree.onLeave(client); }
 *   onDispose() { this.playerThree.dispose(); }
 * }
 * ```
 */
import { randomBytes } from 'node:crypto';
import { ClientState, getMessageBytes, Protocol, type Client } from '@colyseus/core';
import {
  MAX_MESSAGE_BYTES,
  MSG,
  TOKEN_RE,
  type ClientMsg,
  type Outcome,
  type ObserverMessage,
  type Principal,
  type Said,
  type SeatInfo,
  type ServerErrorCode,
  type ServerMsg,
  type ViewMessage,
} from 'playerthree';
import { TokenBucket, type AuthorizationLease, type PublicSeatCard, type ReadinessSnapshot } from 'playerthree/host';

/**
 * The parts of a `PlayerThreeMatch` the binding uses, with teams as plain strings so any game's match fits
 * (every `PlayerThreeMatch<M>` is assignable).
 */
export interface PlayerThreeMatchPort {
  readonly id: string;
  /** The teams taking part (a subset of the manifest teams): spectator watches, reports and perspectives cover only these. */
  readonly teams: readonly string[];
  seats(): SeatInfo[];
  cards(): PublicSeatCard[];
  humanJoined(team: string, role: string, joined: boolean): void;
  readiness(): ReadinessSnapshot;
  setHumanReady(team: string, role: string, ready: boolean): void;
  outcome(team: string): Outcome;
  report(team: string): unknown;
  observerMessages(principal: Extract<Principal, { kind: 'observer' }>, perspective: string, after?: number): ObserverMessage[];
  /** Subscribe to a team's view stream (computed only while subscribed); notified with each new version. */
  onView(team: string, listener: (version: number) => void): () => void;
  /** Messages bringing a reader at version `after` (undefined: fresh) up to date: missed deltas or one keyframe. */
  viewMessages(team: string, after?: number): ViewMessage[];
  onEnd(listener: (outcomes: Record<string, Outcome>, ranks: Record<string, number>) => void): () => void;
  /** Agent replies per team (chat mode). Optional so older match implementations still fit. */
  onSaid?(listener: (team: string, said: Said) => void): () => void;
  handleMessage(principal: Principal, msg: unknown, push?: (msg: ServerMsg) => void): Promise<ServerMsg | undefined>;
  release(push: (msg: ServerMsg) => void): void;
  dispose(): void;
}

/** The parts of a `PlayerThreeHost` the binding uses (every `PlayerThreeHost<M>` is assignable). */
export interface PlayerThreeHostPort {
  authenticate(token: string): { match: { readonly id: string }; principal: Principal } | undefined;
  claimToken(token: string, connectionId: string): AuthorizationLease | undefined;
  authorizeLease(lease: AuthorizationLease): Principal | undefined;
  disconnectLease(lease: AuthorizationLease): void;
  onLeaseRevoked(listener: (lease: AuthorizationLease) => void): () => void;
}

/** Options of {@link bindPlayerThreeRoom}. */
export interface PlayerThreeRoomOptions {
  host: PlayerThreeHostPort;
  /** The match this room carries. Tokens of any other match are rejected. */
  match: PlayerThreeMatchPort;
  /**
   * Inbound message cap in bytes (JSON-encoded size), default `MAX_MESSAGE_BYTES`.
   * The WebSocket transport has its own frame cap (`WebSocketTransport({ maxPayload })`, 4 KiB by default) —
   * raise it to at least this value if agents deploy policies over the room.
   */
  maxMessageBytes?: number;
  /** Unanswered control-plane requests allowed per client before replying `busy`. Default 4. */
  maxInFlight?: number;
  /** How often seat changes (liveness, policy versions) are checked, ms. Default 1000. */
  seatsIntervalMs?: number;
  /** Principal kinds allowed to join this room. Default: all declared principal kinds. */
  allow?: readonly Principal['kind'][];
  /** Dispose the `PlayerThreeMatch` together with the room. Default true. */
  disposeMatch?: boolean;
  /**
   * Minimum time between two batches of views to one client, ms (views in between are coalesced: the latest per team
   * wins). Default 50 (≤ 20 per second); 0 = no rate bound, only the per-client ping/pong flow control. The room clock
   * retries pending views even when the match is paused.
   */
  viewIntervalMs?: number;
}

/**
 * The parts of a Colyseus `Room` the binding uses. Structural, so rooms from another copy of `@colyseus/core`
 * (e.g. a linked workspace) are accepted.
 */
export interface PlayerThreeRoomLike {
  onMessage(type: string, callback: (client: Client, message: unknown) => unknown): unknown;
  readonly clock: { setInterval(handler: () => void, ms: number): { clear(): void } };
}

/** The room-side handle: call these from the room's lifecycle hooks. */
export interface PlayerThreeRoomBinding {
  /** Call from `Room#onAuth`. Returns the principal (becomes `client.auth`) or `false` to reject the join. */
  onAuth(client: Client, options: unknown): Principal | false;
  /** Call from `Room#onJoin`. Human `view: false` suppresses views/reports; spectators cannot expand their scope. */
  onJoin(client: Client, options?: unknown): void;
  /** Call from `Room#onLeave` (and `onDrop` if you do not allow reconnection). */
  onLeave(client: Client): void;
  /** Principal of a joined client. */
  principal(client: Client): Principal | undefined;
  /** Call from `Room#onDispose`. Idempotent. */
  dispose(): void;
}

type InboundOp = ClientMsg['op'];

/** Exhaustive RPC registration; watch and observer requests have their own transport-only authority paths. */
const INBOUND: Record<InboundOp, true> = {
  call: true,
  stream: true,
  mandate: true,
  scopes: true,
  resolveApproval: true,
  controller: true,
  mint: true,
  tell: true,
};

const ALL_KINDS: readonly Principal['kind'][] = ['team', 'human', 'seat', 'spectator', 'observer'];

/**
 * Spectator watch changes per token: each newly watched team costs a fresh guarded projection and encoding. Keyed by
 * the token's principal, so neither reconnecting nor opening more sockets with a shared spectator token resets it.
 */
const WATCH_RATE = { perSecond: 2, burst: 4 } as const;

interface Entry {
  client: Client;
  lease: AuthorizationLease;
  /** Teams whose views/seats/reports this client receives. Empty for seat principals. */
  watch: Set<string>;
  push: (msg: ServerMsg) => void;
  inFlight: number;
  lastSeats: string;
  lastCards: string;
  /** Version of each watched team's view stream this client has (its last keyframe or delta). */
  viewSent: Map<string, number>;
  /** When this client last got views (`performance.now()`). */
  viewAt: number;
  /** Payload of the ping that followed this client's last views, until the client's pong echoes it. */
  awaiting: string | undefined;
  /** Pings the client's WebSocket; undefined if the transport has none (views are then only rate-bounded). */
  ping: ((payload: string) => void) | undefined;
  /** Stops listening for the client's pongs. */
  offPong: (() => void) | undefined;
  observerPerspective: string | undefined;
  observerAfter: number | undefined;
  observerState: ObserverMessage['state'] | undefined;
}

/** What view flow control needs from `client.ref`: a `ws` WebSocket, as `@colyseus/ws-transport` provides. */
interface PingSocket {
  ping(data: Buffer): void;
  on(event: 'pong', listener: (data: Buffer) => void): unknown;
  off(event: 'pong', listener: (data: Buffer) => void): unknown;
}

function isPingSocket(ref: unknown): ref is PingSocket {
  if (typeof ref !== 'object' || ref === null) return false;
  const s = ref as Partial<Record<keyof PingSocket, unknown>>;
  return typeof s.ping === 'function' && typeof s.on === 'function' && typeof s.off === 'function';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The request's `seq` if it is a sane counter, else 0. Nothing else from the input is ever echoed. */
function seqOf(msg: unknown): number {
  const seq = isRecord(msg) ? msg.seq : undefined;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : 0;
}

function jsonBytes(v: unknown): number {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? 0 : Buffer.byteLength(s);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function encode(msg: ServerMsg): Buffer {
  return getMessageBytes.raw(Protocol.ROOM_DATA, MSG[msg.op], msg);
}

/** Binds `room` to `opts.match`: registers the PlayerThree message handlers and returns the lifecycle hooks to call (see the module example). */
export function bindPlayerThreeRoom(room: PlayerThreeRoomLike, opts: PlayerThreeRoomOptions): PlayerThreeRoomBinding {
  const { host, match } = opts;
  const maxBytes = opts.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const maxInFlight = opts.maxInFlight ?? 4;
  const allow = opts.allow ?? ALL_KINDS;
  const teams: readonly string[] = match.teams;
  const viewInterval = Math.max(0, opts.viewIntervalMs ?? 50);

  const connectionPrefix = `colyseus:${randomBytes(16).toString('hex')}:`;
  const authed = new Map<Client, AuthorizationLease>();
  const entries = new Map<string, Entry>();
  /** Encoded report per team, once decided. */
  const reports = new Map<string, Buffer>();
  /** One view-stream subscription per watched team, counting the clients that watch it. */
  const streams = new Map<string, { readers: number; unsubscribe: () => void }>();
  /** Encoded view messages: one encoding per shared message, fanned out to every reader of its team. */
  const viewBytes = new WeakMap<ViewMessage, Buffer>();
  let pingSeq = 0;
  /** A delivery pass is queued for views just pushed. */
  let viewsQueued = false;
  let disposed = false;
  /** Watch-change budget per spectator token (see WATCH_RATE); the token's principal is one shared frozen object. */
  const watchBuckets = new WeakMap<Principal, TokenBucket>();

  /** One delivery pass after the views of this tick (one per team, pushed back to back), not one per view. */
  function queueViews(): void {
    if (viewsQueued) return;
    viewsQueued = true;
    queueMicrotask(() => {
      viewsQueued = false;
      if (disposed) return;
      const now = performance.now();
      for (const entry of entries.values()) sendViewsIfDue(entry, now);
    });
  }

  function watchTeam(team: string): void {
    const stream = streams.get(team);
    if (stream) stream.readers++;
    else streams.set(team, { readers: 1, unsubscribe: match.onView(team, queueViews) });
  }

  function unwatchTeam(team: string): void {
    const stream = streams.get(team);
    if (!stream || --stream.readers > 0) return;
    streams.delete(team);
    stream.unsubscribe();
  }

  /** Enqueues a team's view messages (each encoded once, shared); true if any was sent. */
  function sendViewMessages(entry: Entry, team: string, messages: readonly ViewMessage[]): boolean {
    if (messages.length === 0 || !authorize(entry)) return false;
    for (const message of messages) {
      let bytes = viewBytes.get(message);
      if (!bytes) viewBytes.set(message, bytes = encode(message));
      entry.client.enqueueRaw(bytes);
      entry.viewSent.set(team, message.version);
    }
    return true;
  }

  function humanConnected(team: string, role: string): boolean {
    for (const other of entries.values()) {
      const principal = host.authorizeLease(other.lease);
      if (principal && (principal.kind === 'team' || principal.kind === 'human') && principal.team === team &&
          (principal.kind === 'team' || principal.role === role)) return true;
    }
    return false;
  }

  function remove(client: Client, close: boolean): void {
    const pending = authed.get(client);
    authed.delete(client);
    if (pending) host.disconnectLease(pending);
    const entry = entries.get(client.sessionId);
    if (entry?.client === client) {
      entries.delete(client.sessionId);
      entry.offPong?.();
      match.release(entry.push);
      for (const team of entry.watch) unwatchTeam(team);
      const principal = entry.lease.principal;
      if (principal.kind === 'human') {
        match.humanJoined(principal.team, principal.role, humanConnected(principal.team, principal.role));
      } else if (principal.kind === 'team') {
        for (const seat of match.readiness().seats) {
          if (seat.team !== principal.team || seat.kind !== 'human') continue;
          const connected = humanConnected(seat.team, seat.role);
          match.humanJoined(seat.team, seat.role, connected);
          if (!connected) match.setHumanReady(seat.team, seat.role, false);
        }
      }
      host.disconnectLease(entry.lease);
    }
    if (close) client.leave(4001);
  }

  function authorize(entry: Entry): Principal | undefined {
    if (disposed || entries.get(entry.client.sessionId) !== entry) return undefined;
    const principal = host.authorizeLease(entry.lease);
    if (!principal) remove(entry.client, true);
    return principal;
  }

  const send = (entry: Entry, msg: ServerMsg) => {
    const principal = authorize(entry);
    if (!principal) return;
    // Observer sockets are sealed from every live/owner channel, including accidental host pushes.
    if (principal.kind === 'observer' && msg.op !== 'observer' && !(msg.op === 'result' && !msg.ok)) return;
    if (principal.kind !== 'observer' && msg.op === 'observer') return;
    entry.client.enqueueRaw(encode(msg));
  };

  const offRevoked = host.onLeaseRevoked((lease) => {
    for (const [client, pending] of authed) if (pending.id === lease.id) remove(client, true);
    for (const entry of entries.values()) if (entry.lease.id === lease.id) remove(entry.client, true);
  });

  const reply = (entry: Entry, seq: number, code: ServerErrorCode) =>
    entry.push({ op: 'result', seq, ok: false, code });

  function reportOf(team: string): Buffer | undefined {
    const cached = reports.get(team);
    if (cached) return cached;
    if (match.outcome(team) === 'running') return undefined;
    const data = match.report(team);
    if (data === null) return undefined;
    const bytes = encode({ op: 'report', team, data });
    reports.set(team, bytes);
    return bytes;
  }

  function sendSeats(entry: Entry, all: SeatInfo[], cards: PublicSeatCard[]) {
    const principal = authorize(entry);
    if (!principal || principal.kind === 'seat' || principal.kind === 'observer') return;
    // Private seat state is never projected by fog perspective: owning a side's view does not own its agents.
    const seats = principal.kind === 'team'
      ? all.filter((s) => s.team === principal.team)
      : principal.kind === 'human'
        ? all.filter((s) => s.team === principal.team && s.role === principal.role)
        : [];
    const json = JSON.stringify(seats);
    if (seats.length > 0 && json !== entry.lastSeats) {
      entry.lastSeats = json;
      send(entry, { op: 'seats', seats });
    }
    if (entry.watch.size === 0) return;
    const visibleCards = cards.filter((card) => entry.watch.has(card.seat.team));
    const cardJson = JSON.stringify(visibleCards);
    if (cardJson !== entry.lastCards) {
      entry.lastCards = cardJson;
      send(entry, { op: 'cards', cards: visibleCards });
    }
  }

  function refreshSeats() {
    if (disposed || entries.size === 0) return;
    const all = match.seats();
    const cards = match.cards();
    for (const entry of entries.values()) sendSeats(entry, all, cards);
  }

  /** Initial state for teams a client just started watching (already subscribed through `watchTeam`). */
  function sendSnapshot(entry: Entry, newTeams: Iterable<string>) {
    for (const team of newTeams) {
      if (!authorize(entry)) return;
      // A keyframe of the stream's own latest version, so its next deltas apply to exactly this state.
      sendViewMessages(entry, team, match.viewMessages(team));
      const report = reportOf(team);
      if (report && authorize(entry)) entry.client.enqueueRaw(report);
    }
    sendSeats(entry, match.seats(), match.cards());
  }

  /** Encoded observer frames: one encoding per shared frame message, fanned out to every observer at that cursor. */
  const observerBytes = new WeakMap<ObserverMessage, Buffer>();

  /**
   * Sends every released observer frame after the client's cursor in one batch (a keyframe when it joins, changes
   * perspective or falls too far behind), then pings it like views: no further frames until its pong.
   */
  function sendObserver(entry: Entry, now: number): void {
    const principal = authorize(entry);
    if (principal?.kind !== 'observer' || entry.observerPerspective === undefined ||
        entry.awaiting !== undefined || now - entry.viewAt < viewInterval) return;
    // enqueueRaw buffers JOINING clients; a socket ping would overtake those queued frames.
    if (entry.client.state !== ClientState.JOINED) return;
    let messages: ObserverMessage[];
    try {
      messages = match.observerMessages(principal, entry.observerPerspective, entry.observerAfter);
    } catch {
      remove(entry.client, true);
      return;
    }
    let sent = false;
    for (const message of messages) {
      if (!message.frame) {
        if (message.state === 'buffering' && entry.observerState === 'ready') continue;
        if (message.state === entry.observerState) continue;
        entry.observerState = message.state;
        // Admission metadata travels only with state changes; frames are shared by every grant of the same scope.
        send(entry, { ...message, grant: principal.grant });
        continue;
      }
      if (!authorize(entry)) return;
      let bytes = observerBytes.get(message);
      if (!bytes) observerBytes.set(message, bytes = encode(message));
      entry.client.enqueueRaw(bytes);
      entry.observerAfter = message.frame.sequence;
      entry.observerState = 'ready';
      sent = true;
    }
    if (!sent) return;
    entry.viewAt = now;
    if (entry.ping) {
      entry.awaiting = `playerthree:view:${++pingSeq}`;
      entry.ping(entry.awaiting);
    }
  }

  /**
   * Sends the client what it missed of every team it watches (deltas, or one keyframe when too far behind), then
   * pings it. No-op while the client has not read its last views yet (no pong), so a slow reader holds at most one
   * batch of views in its socket.
   */
  function sendViews(entry: Entry, now: number) {
    if (!authorize(entry)) return;
    // enqueueRaw buffers JOINING clients; a socket ping would overtake those queued views.
    if (entry.awaiting !== undefined || entry.client.state !== ClientState.JOINED) return;
    let sent = false;
    for (const team of entry.watch) {
      if (sendViewMessages(entry, team, match.viewMessages(team, entry.viewSent.get(team)))) sent = true;
    }
    if (!sent || !authorize(entry)) return;
    entry.viewAt = now;
    if (!entry.ping) return;
    entry.awaiting = `playerthree:view:${++pingSeq}`;
    entry.ping(entry.awaiting);
  }

  /** Views go out right away to clients that are ready and whose interval has passed; the rest wait for the timer. */
  function sendViewsIfDue(entry: Entry, now: number) {
    const principal = authorize(entry);
    if (principal?.kind === 'observer') sendObserver(entry, now);
    else if (principal && now - entry.viewAt >= viewInterval) sendViews(entry, now);
  }

  // Retry independently of match ticks: a paused match or a just-joined client still needs its latest pending view.
  const viewTimer = room.clock.setInterval(() => {
    const now = performance.now();
    for (const entry of entries.values()) sendViewsIfDue(entry, now);
  }, viewInterval || 1);

  const offEnd = match.onEnd(() => {
    for (const team of teams) {
      const bytes = reportOf(team);
      if (!bytes) continue;
      // enqueueRaw retains JOINING clients' packets until their JOIN_ROOM acknowledgement. End revokes
      // immediately, so this already-authorized terminal packet must reach the socket before its close frame.
      // Do not flush queued views or extend the lease while waiting for an acknowledgement.
      for (const entry of entries.values()) if (entry.watch.has(team) && authorize(entry)) entry.client.raw(bytes);
    }
    refreshSeats();
  });

  // A shared fog perspective never grants another human's owner-agent channel.
  const offSaid = match.onSaid?.((team, said) => {
    let bytes: Buffer | undefined;
    for (const entry of entries.values()) {
      const principal = authorize(entry);
      if (!principal || (principal.kind !== 'team' && principal.kind !== 'human') || principal.team !== team) continue;
      if (principal.kind === 'human' && principal.role !== said.role) continue;
      bytes ??= encode({ op: 'said', role: said.role, tick: said.tick, text: said.text });
      if (authorize(entry)) entry.client.enqueueRaw(bytes);
    }
  });

  const seatsTimer = room.clock.setInterval(refreshSeats, opts.seatsIntervalMs ?? 1000);

  async function handle(client: Client, op: InboundOp, message: unknown) {
    const entry = entries.get(client.sessionId);
    if (!entry || entry.client !== client) return;
    const principal = authorize(entry);
    if (!principal) return;
    const seq = seqOf(message);
    if (!isRecord(message) || message.op !== op || jsonBytes(message) > maxBytes) return reply(entry, seq, 'bad_message');
    if (principal.kind === 'observer') return reply(entry, seq, 'forbidden');
    if (entry.inFlight >= maxInFlight) return reply(entry, seq, 'busy');
    entry.inFlight++;
    let res: ServerMsg | undefined;
    try {
      res = await match.handleMessage(principal, message, entry.push);
    } catch {
      res = { op: 'result', seq, ok: false, code: 'internal' };
    } finally {
      entry.inFlight--;
    }
    if (entries.get(client.sessionId) !== entry) return;
    if (res) entry.push(res);
    if (op === 'controller' || op === 'mandate' || op === 'scopes' || op === 'resolveApproval' || op === 'mint') refreshSeats();
  }

  for (const op of Object.keys(INBOUND) as InboundOp[]) {
    room.onMessage(MSG[op], (client: Client, message: unknown) => {
      void handle(client, op, message);
    });
  }

  room.onMessage(MSG.observer, (client: Client, message: unknown) => {
    const entry = entries.get(client.sessionId);
    if (!entry || entry.client !== client) return;
    const principal = authorize(entry);
    if (principal?.kind !== 'observer') return;
    if (!isRecord(message) || jsonBytes(message) > maxBytes ||
        Object.keys(message).some((key) => key !== 'perspective' && key !== 'after') ||
        typeof message.perspective !== 'string' ||
        (message.after !== undefined && (!Number.isSafeInteger(message.after) || (message.after as number) < 0))) {
      return reply(entry, 0, 'bad_message');
    }
    // The host grants match teams only; the binding still never serves a perspective outside the match.
    const permitted = message.perspective === 'all'
      ? principal.grant.kind === 'omniscient'
      : teams.includes(message.perspective) &&
        (principal.grant.kind === 'team' ? message.perspective === principal.grant.team : principal.grant.teams.includes(message.perspective));
    if (!permitted) return reply(entry, 0, 'forbidden');
    entry.observerPerspective = message.perspective;
    entry.observerAfter = message.after as number | undefined;
    entry.observerState = undefined;
    entry.viewAt = Number.NEGATIVE_INFINITY;
    sendObserver(entry, performance.now());
  });

  room.onMessage(MSG.watch, (client: Client, message: unknown) => {
    const entry = entries.get(client.sessionId);
    if (!entry || entry.client !== client) return;
    const principal = authorize(entry);
    if (principal?.kind !== 'spectator' || !isRecord(message) || message.op !== 'watch' || jsonBytes(message) > maxBytes) return;
    const next = parseWatch(message.teams, principal.team === undefined ? teams : [principal.team]);
    if (!next) return;
    let bucket = watchBuckets.get(principal);
    if (!bucket) watchBuckets.set(principal, (bucket = new TokenBucket(WATCH_RATE.perSecond, WATCH_RATE.burst)));
    if (!bucket.take()) return;
    const added = [...next].filter((t) => !entry.watch.has(t));
    for (const team of entry.watch) {
      if (next.has(team)) continue;
      unwatchTeam(team);
      // Watching it again later starts from a keyframe.
      entry.viewSent.delete(team);
    }
    for (const team of added) watchTeam(team);
    entry.watch = next;
    entry.lastSeats = '';
    sendSnapshot(entry, added);
  });

  return {
    onAuth(client, options) {
      if (disposed) return false;
      const token = isRecord(options) ? options.token : undefined;
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
      const auth = host.authenticate(token);
      if (!auth || auth.match.id !== match.id || !allow.includes(auth.principal.kind)) return false;
      const lease = host.claimToken(token, `${connectionPrefix}${client.sessionId}`);
      if (!lease) return false;
      authed.set(client, lease);
      return lease.principal;
    },

    onJoin(client, options) {
      const lease = authed.get(client);
      const principal = lease && host.authorizeLease(lease);
      if (!principal || disposed) {
        remove(client, true);
        return;
      }
      authed.delete(client);
      let watch: Set<string>;
      if (principal.kind === 'team' || principal.kind === 'human') {
        watch = principal.kind === 'human' && isRecord(options) && options.view === false ? new Set() : new Set([principal.team]);
      }
      else if (principal.kind === 'spectator') {
        const permitted = principal.team === undefined ? teams : [principal.team];
        watch = (isRecord(options) && options.watch !== undefined ? parseWatch(options.watch, permitted) : undefined) ?? new Set(permitted);
      }
      else watch = new Set();
      const ref: unknown = client.ref;
      const socket = isPingSocket(ref) ? ref : undefined;
      const entry: Entry = {
        client,
        lease: lease!,
        watch,
        push: (msg) => send(entry, msg),
        inFlight: 0,
        lastSeats: '',
        lastCards: '',
        viewSent: new Map(),
        viewAt: Number.NEGATIVE_INFINITY,
        awaiting: undefined,
        ping: socket && ((payload) => socket.ping(Buffer.from(payload))),
        offPong: undefined,
        observerPerspective: principal.kind === 'observer' ? (principal.grant.kind === 'team' ? principal.grant.team : 'all') : undefined,
        observerAfter: undefined,
        observerState: undefined,
      };
      if (socket) {
        // Only the pong to the ping after the last views counts; heartbeat pings carry no payload.
        const onPong = (data: Buffer) => {
          if (entry.awaiting === undefined || !Buffer.isBuffer(data) || data.toString() !== entry.awaiting) return;
          entry.awaiting = undefined;
          if (!disposed) sendViewsIfDue(entry, performance.now());
        };
        socket.on('pong', onPong);
        entry.offPong = () => socket.off('pong', onPong);
      }
      entries.set(client.sessionId, entry);
      for (const team of watch) watchTeam(team);
      if (principal.kind === 'human') match.humanJoined(principal.team, principal.role, true);
      else if (principal.kind === 'team') {
        // A trusted private team-root client joins and readies its team's human seats; public human tokens never enter here.
        for (const seat of match.readiness().seats) {
          if (seat.team !== principal.team || seat.kind !== 'human') continue;
          match.humanJoined(seat.team, seat.role, true);
          match.setHumanReady(seat.team, seat.role, true);
        }
      }
      if (principal.kind === 'observer') sendObserver(entry, performance.now());
      else sendSnapshot(entry, watch);
    },

    onLeave(client) {
      remove(client, false);
    },

    principal(client) {
      const entry = entries.get(client.sessionId);
      return entry && entry.client === client ? authorize(entry) : undefined;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      offEnd();
      offSaid?.();
      offRevoked();
      seatsTimer.clear();
      viewTimer.clear();
      for (const client of authed.keys()) remove(client, true);
      for (const entry of entries.values()) remove(entry.client, true);
      entries.clear();
      reports.clear();
      // Leaving clients released their teams; nothing may keep a disposed room's streams computing.
      for (const stream of streams.values()) stream.unsubscribe();
      streams.clear();
      if (opts.disposeMatch ?? true) match.dispose();
    },
  };
}

/** A set of known teams (deduplicated), or undefined if the input is not a list of known team names. */
function parseWatch(v: unknown, teams: readonly string[]): Set<string> | undefined {
  if (!Array.isArray(v) || v.length > teams.length * 2) return undefined;
  const out = new Set<string>();
  for (const t of v) {
    if (typeof t !== 'string' || !teams.includes(t)) return undefined;
    out.add(t);
  }
  return out;
}
