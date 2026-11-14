/**
 * End-to-end: a real Colyseus server (ws transport) + the real SDK client, driving the `tag` example game.
 */
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMessageBytes, matchMaker, Protocol, Room, Server, type Client } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client as SdkClient, type Room as SdkRoom } from '@colyseus/sdk';
import { applyView, MSG, type PlayerThreeMatch, type ServerMsg, type ViewState } from 'playerthree';
import { createPlayerThreeHost, VIEW_MAX_BATCH } from 'playerthree/host';
import { createMcpRequestHandler } from 'playerthree/mcp';
import { definition, type TagManifest } from '../../playerthree/examples/tag/index.ts';
import { quadDefinition } from '../../playerthree/test/quad-fixture.ts';
import { bindPlayerThreeRoom, type PlayerThreeRoomBinding } from '../src/index.ts';

// The real SDK uses Node's ws implementation here, so slow-reader tests can pause the actual TCP receive stream.
vi.hoisted(() => {
  Reflect.deleteProperty(globalThis, 'WebSocket');
});
const host = createPlayerThreeHost({ definition });
const quadHost = createPlayerThreeHost({ definition: quadDefinition });
const MAX_BYTES = 8 * 1024;

class TagRoom extends Room {
  playerThree: PlayerThreeRoomBinding | undefined;
  onCreate(options: { matchId: string; viewIntervalMs?: number }) {
    const match = host.getMatch(options.matchId);
    if (!match) throw new Error('unknown match');
    this.autoDispose = false;
    this.playerThree = bindPlayerThreeRoom(this, { host, match, maxMessageBytes: MAX_BYTES, viewIntervalMs: options.viewIntervalMs });
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

/** The same binding over the four-team quad game, whose matches may play a subset of its teams. */
class QuadRoom extends TagRoom {
  override onCreate(options: { matchId: string }) {
    const match = quadHost.getMatch(options.matchId);
    if (!match) throw new Error('unknown match');
    this.autoDispose = false;
    this.playerThree = bindPlayerThreeRoom(this, { host: quadHost, match, maxMessageBytes: MAX_BYTES });
  }
}

let server: Server;
let sdk: SdkClient;

beforeAll(async () => {
  server = new Server({
    transport: new WebSocketTransport({ maxPayload: 64 * 1024, pingInterval: 100, pingMaxRetries: 6 }),
    greet: false,
    gracefullyShutdown: false,
  });
  server.define('tag', TagRoom);
  server.define('quad', QuadRoom);
  await server.listen(0, '127.0.0.1');
  const port = (server.transport.server!.address() as AddressInfo).port;
  sdk = new SdkClient(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await server.gracefullyShutdown(false);
  host.dispose();
  quadHost.dispose();
});

interface Received {
  type: string;
  msg: ServerMsg;
}

interface Conn {
  room: SdkRoom;
  inbox: Received[];
  /** Each team's view as the client rebuilds it from keyframes and deltas. */
  views: Map<string, ViewState>;
  /** Deltas that arrived without their base version (must stay 0). */
  gaps: number;
}

async function newMatch(realtime = false, viewIntervalMs?: number): Promise<{ match: PlayerThreeMatch<TagManifest>; roomId: string }> {
  const match = host.createMatch({ realtime, viewHz: 10 });
  const room = await matchMaker.createRoom('tag', { matchId: match.id, viewIntervalMs });
  return { match, roomId: room.roomId };
}

async function join(roomId: string, options: Record<string, unknown>): Promise<Conn> {
  const room = await sdk.joinById(roomId, options);
  const conn: Conn = { room, inbox: [], views: new Map(), gaps: 0 };
  room.onMessage('*', (type, msg) => {
    const received = msg as ServerMsg;
    conn.inbox.push({ type: String(type), msg: received });
    if (received.op !== 'view') return;
    const next = applyView(conn.views.get(received.team), received);
    if (next) conn.views.set(received.team, next);
    else conn.gaps++;
  });
  return conn;
}

/** Polls a condition fed by network messages (the SDK exposes no promise per message). */
async function until<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let seq = 0;
async function request(conn: Conn, type: string, body: Record<string, unknown>): Promise<ServerMsg & { op: 'result' }> {
  const s = ++seq;
  conn.room.send(type, { ...body, seq: s });
  const got = await until(() => conn.inbox.find((r) => r.msg.op === 'result' && r.msg.seq === s));
  return got.msg as ServerMsg & { op: 'result' };
}

/**
 * Round-trip barrier: the server handles a client's messages in order and the socket is ordered, so once the reply
 * to this request arrives, everything sent to the client before it has arrived too.
 */
const barrier = (conn: Conn) => request(conn, MSG.call, { op: 'call', role: 'runner', method: 'briefing', args: {} });

const viewMessages = (conn: Conn) => conn.inbox.filter((r) => r.msg.op === 'view');
/** Tick of the rebuilt view of the team the client heard from last. */
function lastTick(conn: Conn): number | undefined {
  const msg = viewMessages(conn).at(-1)?.msg;
  if (msg?.op !== 'view') return undefined;
  const view = conn.views.get(msg.team)?.view;
  return typeof view === 'object' && view !== null && 'tick' in view && typeof view.tick === 'number' ? view.tick : undefined;
}

/** Node ws internals are test-only; the SDK still decodes every real wire message. */
interface ReaderSocket {
  pause(): void;
  resume(): void;
  pong(data: Buffer): void;
  on(event: 'ping', listener: (data: Buffer) => void): void;
  off(event: 'ping', listener: (data: Buffer) => void): void;
  _autoPong: boolean;
}

function reader(conn: Conn): ReaderSocket {
  // The SDK's generic transport type deliberately omits its Node-specific WebSocket.
  const transport = conn.room.connection.transport as unknown as { ws: ReaderSocket };
  return transport.ws;
}

describe('view backpressure over real SDK sockets', () => {
  it.each([false, true])('keeps a slow reader connected and catches up (realtime=%s)', async (realtime) => {
    const { match, roomId } = await newMatch(realtime);
    const slow = await join(roomId, { token: match.tokens.teams.blue });
    const fast = await join(roomId, { token: match.tokens.teams.red });
    const ws = reader(slow);
    let dropped = false;
    slow.room.onLeave(() => { dropped = true; });
    slow.room.onDrop(() => { dropped = true; });
    try {
      await until(() => lastTick(slow) !== undefined && lastTick(fast) !== undefined);
      // Real delays exercise ws heartbeat timers and TCP reads together; fake clocks cannot reproduce this interaction.
      // Longer than several complete heartbeat retry windows overall, but read a little in each window.
      for (let round = 0; round < 7; round++) {
        ws.pause();
        const before = viewMessages(slow).length;
        if (!realtime) await match.step(30);
        await sleep(300);
        const target = match.view('blue').tick;
        await until(() => (lastTick(fast) ?? -1) >= target);
        expect(viewMessages(slow)).toHaveLength(before);
        ws.resume();
        await until(() => (lastTick(slow) ?? -1) >= target);
        expect(dropped).toBe(false);
        // Bounded catch-up: the one unread batch, then at most one batch of the deltas it missed (or one keyframe).
        expect(viewMessages(slow).length - before).toBeLessThanOrEqual(2 * VIEW_MAX_BATCH);
      }
      match.stop();
      await match.step(0); // finish any already-running realtime tick before observing the paused state
      const finalTick = match.view('blue').tick;
      await until(() => lastTick(slow) === finalTick);
      // Every delta applied to exactly its base: the rebuilt state is the match's current view.
      expect(slow.gaps).toBe(0);
      expect(slow.views.get('blue')?.view).toEqual(match.view('blue'));
      const delivered = viewMessages(slow).length;
      await sleep(150); // paused: no new match events are needed and no duplicate state is sent
      expect(viewMessages(slow)).toHaveLength(delivered);
      expect(viewMessages(slow).every((r) => r.msg.op === 'view' && r.msg.team === 'blue')).toBe(true);
      expect(viewMessages(fast).every((r) => r.msg.op === 'view' && r.msg.team === 'red')).toBe(true);
    } finally {
      ws.resume();
      await slow.room.leave();
      await fast.room.leave();
      match.dispose();
    }
  }, 10_000);

  it.each([0, 50])('only acknowledges the matching view ping, without blocking other messages (interval=%s)', async (interval) => {
    const { match, roomId } = await newMatch(false, interval);
    const owner = await join(roomId, { token: match.tokens.teams.blue });
    const spectator = await join(roomId, { token: match.tokens.spectator, watch: ['red'] });
    const held: { ws: ReaderSocket; pings: Buffer[]; listener: (data: Buffer) => void }[] = [];
    for (const conn of [owner, spectator]) {
      const ws = reader(conn);
      const pings: Buffer[] = [];
      const listener = (data: Buffer) => {
        if (data.toString().startsWith('playerthree:view:')) pings.push(data);
        else ws.pong(data); // real transport heartbeats must not acknowledge a view batch
      };
      ws._autoPong = false;
      ws.on('ping', listener);
      held.push({ ws, pings, listener });
    }
    try {
      await match.step(10);
      await until(() => held.every((h) => h.pings.length === 1));
      const counts = [owner, spectator].map((c) => viewMessages(c).length);
      await match.step(10);
      await sleep(750); // heartbeats keep the connection alive, but cannot unlock held views
      expect([owner, spectator].map((c) => viewMessages(c).length)).toEqual(counts);
      expect((await request(owner, MSG.controller, { op: 'controller', role: 'guard', controller: 'human' })).ok).toBe(true);
      await until(() => owner.inbox.some((r) => r.msg.op === 'seats' && r.msg.seats.some((s) => s.role === 'guard' && s.controller === 'human')));
      spectator.room.send(MSG.watch, { op: 'watch', teams: ['blue'] });
      await until(() => lastTick(spectator) === 20); // watch snapshot bypasses the held view batch
      const watched = spectator.inbox.length;
      const late = await join(roomId, { token: match.tokens.teams.blue });
      await until(() => lastTick(late) === 20); // another client's join never waits for this one
      await late.room.leave();
      // The final report bypasses held views; match end then revokes every live lease.
      await match.step(1300);
      await until(() => [owner, spectator].every((c) => c.inbox.some((r) => r.msg.op === 'report' && r.msg.team === 'blue')));
      expect(owner.inbox.filter((r) => r.msg.op === 'report').every((r) => r.msg.op === 'report' && r.msg.team === 'blue')).toBe(true);
      expect(spectator.inbox.slice(watched).filter((r) => r.msg.op === 'view').every((r) => r.msg.op === 'view' && r.msg.team === 'blue')).toBe(true);
    } finally {
      for (const h of held) {
        h.ws._autoPong = true;
        h.ws.off('ping', h.listener);
      }
      await owner.room.leave();
      await spectator.room.leave();
    }
  }, 10_000);
});
describe('auth', () => {
  it('rejects missing, malformed, unknown and other-match tokens', async () => {
    const { roomId } = await newMatch();
    const other = await newMatch();
    for (const options of [{}, { token: 42 }, { token: 'short' }, { token: 'A'.repeat(32) }, { token: other.match.tokens.teams.blue }]) {
      await expect(sdk.joinById(roomId, options)).rejects.toThrow();
    }
  });

  it('accepts the match\'s owner, seat and spectator tokens', async () => {
    const { match, roomId } = await newMatch();
    const seatToken = match.mintSeatToken('red', 'guard');
    for (const token of [match.tokens.teams.blue, match.tokens.teams.red, match.tokens.spectator, seatToken]) {
      const conn = await join(roomId, { token });
      await conn.room.leave();
    }
  });
});

describe('views', () => {
  it('a team owner only ever receives its own team\'s views and seats', async () => {
    const { match, roomId } = await newMatch();
    const blue = await join(roomId, { token: match.tokens.teams.blue });
    const red = await join(roomId, { token: match.tokens.teams.red });
    // Paced like a live match: each reader keeps up, so it never falls a whole batch behind (which would resync).
    for (let tick = 5; tick <= 30; tick += 5) {
      await match.step(5);
      await until(() => lastTick(blue) === tick && lastTick(red) === tick);
    }

    for (const [conn, team] of [
      [blue, 'blue'],
      [red, 'red'],
    ] as const) {
      const views = conn.inbox.filter((r) => r.type === MSG.view);
      expect(views.every((r) => r.msg.op === 'view' && r.msg.team === team)).toBe(true);
      // One keyframe on join, then only deltas, each applying to exactly the previous version.
      expect(views.filter((r) => 'view' in r.msg)).toHaveLength(1);
      expect(conn.gaps).toBe(0);
      expect(conn.views.get(team)?.view).toEqual(match.view(team));
      const seats = conn.inbox.filter((r) => r.type === MSG.seats);
      expect(seats.length).toBeGreaterThan(0);
      for (const r of seats) if (r.msg.op === 'seats') expect(r.msg.seats.every((s) => s.team === team)).toBe(true);
    }
    // The first view a client gets is the current one, sent on join, as a keyframe.
    expect(blue.inbox[0]?.type).toBe(MSG.view);
    expect('view' in blue.inbox[0]!.msg).toBe(true);
    await blue.room.leave();
    await red.room.leave();
  });

  it('spectators get the teams they watch, and can switch', async () => {
    const { match, roomId } = await newMatch();
    const spec = await join(roomId, { token: match.tokens.spectator, watch: ['red'] });
    await match.step(5);
    await until(() => lastTick(spec) === 5);
    expect(spec.inbox.filter((r) => r.msg.op === 'view').every((r) => r.msg.op === 'view' && r.msg.team === 'red')).toBe(true);

    spec.room.send(MSG.watch, { op: 'watch', teams: ['blue'] });
    await until(() => spec.inbox.some((r) => r.msg.op === 'view' && r.msg.team === 'blue'));
    const n = spec.inbox.length;
    await match.step(5);
    await until(() => lastTick(spec) === 10);
    const after = spec.inbox.slice(n).filter((r) => r.msg.op === 'view');
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.msg.op === 'view' && r.msg.team === 'blue')).toBe(true);

    // Unknown teams are ignored, not partially applied.
    spec.room.send(MSG.watch, { op: 'watch', teams: ['blue', 'green'] });
    await barrier(spec);
    const m = spec.inbox.length;
    await match.step(3);
    await until(() => lastTick(spec) === 13);
    expect(spec.inbox.slice(m).filter((r) => r.msg.op === 'view').every((r) => r.msg.op === 'view' && r.msg.team === 'blue')).toBe(true);
    await spec.room.leave();
  });

  it('rate limits spectator watch snapshots per token, across extra sockets', async () => {
    const { match, roomId } = await newMatch();
    // Paused and never stepped: every view below is a watch or join snapshot, a fresh guarded projection.
    const spec = await join(roomId, { token: match.tokens.spectator, watch: ['red'] });
    await barrier(spec);
    const joined = viewMessages(spec).length;
    for (let i = 0; i < 10; i++) spec.room.send(MSG.watch, { op: 'watch', teams: [i % 2 ? 'red' : 'blue'] });
    await barrier(spec);
    // Burst of 4 flips at 2 per second: the rest are dropped, not projected.
    expect(viewMessages(spec).length - joined).toBeGreaterThanOrEqual(4);
    expect(viewMessages(spec).length - joined).toBeLessThanOrEqual(5);
    // The budget belongs to the token, so another socket with the same shared token cannot reset it.
    const second = await join(roomId, { token: match.tokens.spectator, watch: ['red'] });
    await barrier(second);
    const before = viewMessages(second).length;
    second.room.send(MSG.watch, { op: 'watch', teams: ['blue', 'red'] });
    await barrier(second);
    expect(viewMessages(second)).toHaveLength(before);
    await spec.room.leave();
    await second.room.leave();
    match.dispose();
  });

  it('owners get their own team\'s report when the match ends', async () => {
    const { match, roomId } = await newMatch();
    const blue = await join(roomId, { token: match.tokens.teams.blue });
    // Intentionally no request barrier: end may precede the server processing this client's JOIN_ROOM ACK.
    await match.step(1300);
    const report = await until(() => blue.inbox.find((r) => r.type === MSG.report));
    expect(report.msg.op === 'report' && report.msg.team).toBe('blue');
    expect(blue.inbox.filter((r) => r.type === MSG.report).every((r) => r.msg.op === 'report' && r.msg.team === 'blue')).toBe(true);

    // End revokes all admissions, including trusted/private root tokens.
    await expect(sdk.joinById(roomId, { token: match.tokens.teams.red })).rejects.toThrow();
    await blue.room.leave();
    match.dispose();
  });
});

describe('team subsets', () => {
  it('spectator watches and end reports cover only the match teams', async () => {
    const match = quadHost.createMatch({ realtime: false, viewHz: 10, teams: ['north', 'east', 'south'] });
    const { roomId } = await matchMaker.createRoom('quad', { matchId: match.id });
    const spec = await join(roomId, { token: match.tokens.spectator });
    const viewTeams = (from: number) => new Set(spec.inbox.slice(from).flatMap((r) => r.msg.op === 'view' ? [r.msg.team] : []));
    await match.step(2);
    await until(() => viewTeams(0).size === 3);
    expect(viewTeams(0)).toEqual(new Set(['north', 'east', 'south']));

    // A manifest team outside the match is unknown here: the whole watch is ignored, not partially applied.
    spec.room.send(MSG.watch, { op: 'watch', teams: ['north', 'west'] });
    await barrier(spec);
    const m = spec.inbox.length;
    await match.step(2);
    await until(() => viewTeams(m).size === 3);
    expect(viewTeams(m)).toEqual(new Set(['north', 'east', 'south']));

    match.end({ north: 'win', east: 'loss', south: 'loss' });
    await until(() => spec.inbox.filter((r) => r.type === MSG.report).length === 3);
    expect(new Set(spec.inbox.flatMap((r) => r.msg.op === 'report' ? [r.msg.team] : []))).toEqual(new Set(['north', 'east', 'south']));
    await spec.room.leave();
    match.dispose();
  });
});

describe('owner messages', () => {
  it('mint, controller and act work for the owner\'s own team', async () => {
    const { match, roomId } = await newMatch();
    const blue = await join(roomId, { token: match.tokens.teams.blue });

    const mint = await request(blue, MSG.mint, { op: 'mint', role: 'runner' });
    expect(mint.ok).toBe(true);
    const minted = mint.ok ? (mint.data as { role: string; token: string }) : undefined;
    expect(minted?.role).toBe('runner');
    expect(host.authenticate(minted!.token)?.principal).toEqual({ kind: 'seat', match: match.id, team: 'blue', role: 'runner' });

    const ctl = await request(blue, MSG.controller, { op: 'controller', role: 'guard', controller: 'human' });
    expect(ctl.ok).toBe(true);
    expect(match.seats().find((s) => s.team === 'blue' && s.role === 'guard')?.controller).toBe('human');
    expect(match.seats().find((s) => s.team === 'red' && s.role === 'guard')?.controller).toBe('bot');
    // Seat changes are pushed without waiting for the interval.
    await until(() =>
      blue.inbox.some((r) => r.msg.op === 'seats' && r.msg.seats.some((s) => s.role === 'guard' && s.controller === 'human')),
    );

    const act = await request(blue, MSG.call, { op: 'call', role: 'guard', method: 'act', args: { intents: [{ kind: 'move', x: 3, y: 3 }] } });
    expect(act.ok).toBe(true);
    expect(act.ok && act.data).toEqual([{ ok: true }]);
    await blue.room.leave();
  });

  it('routes mandate updates and owner approval decisions, publishing the new seat state', async () => {
    const { match, roomId } = await newMatch();
    match.setController('blue', 'runner', 'agent');
    const blue = await join(roomId, { token: match.tokens.teams.blue });
    const agent = await join(roomId, { token: match.mintSeatToken('blue', 'runner') });
    const mandate = { autonomy: 'supervised', directive: { stance: 'attack' }, whenAbsent: 'hold' };
    expect((await request(blue, MSG.mandate, { op: 'mandate', role: 'runner', mandate })).ok).toBe(true);
    expect(match.seats().find((s) => s.team === 'blue' && s.role === 'runner')?.mandate).toEqual(mandate);
    expect((await request(blue, MSG.scopes, { op: 'scopes', role: 'runner', scopes: ['policy', 'practice', 'say'] })).ok).toBe(true);
    await until(() => blue.inbox.some((r) => r.msg.op === 'seats' && r.msg.seats.some((s) => s.team === 'blue' && s.role === 'runner' && !s.scopes.includes('act'))));
    expect(await request(agent, MSG.call, { op: 'call', role: 'runner', method: 'act', args: { intents: [{ kind: 'stop' }] } })).toMatchObject({ ok: true, data: [{ ok: false, code: 'out_of_scope' }] });
    expect(await request(agent, MSG.call, { op: 'call', role: 'runner', method: 'briefing', args: {} })).toMatchObject({ ok: true, data: { scopes: ['policy', 'practice', 'say'] } });
    expect(await request(blue, MSG.scopes, { op: 'scopes', role: 'runner', scopes: ['unknown'] })).toMatchObject({ ok: false, code: 'bad_message' });
    await until(() => blue.inbox.some((r) => r.msg.op === 'seats' && r.msg.seats.some((s) => s.role === 'runner' && s.mandate.autonomy === 'supervised')));
    const proposed = await request(agent, MSG.call, { op: 'call', role: 'runner', method: 'policyDeploy', args: { runtime: 'js', code: 'function think() { return []; }' } });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || typeof proposed.data !== 'object' || proposed.data === null || !('approval' in proposed.data)) throw new Error('missing approval');
    const approval = proposed.data.approval;
    if (typeof approval !== 'object' || approval === null || !('id' in approval) || typeof approval.id !== 'string') throw new Error('missing approval id');
    expect(approval).toMatchObject({ kind: 'policyDeploy', version: 1 });
    const resolved = await request(blue, MSG.resolveApproval, { op: 'resolveApproval', role: 'runner', id: approval.id, approve: true });
    expect(resolved.ok).toBe(true);
    expect(match.seats().find((s) => s.team === 'blue' && s.role === 'runner')?.policyVersion).toBe(1);
    const missing = await request(blue, MSG.resolveApproval, { op: 'resolveApproval', role: 'runner', id: approval.id, approve: false });
    expect(missing).toMatchObject({ ok: false, code: 'approval_not_found' });
    await blue.room.leave();
    await agent.room.leave();
  });

  it('rejects malformed and oversized messages without echoing them', async () => {
    const { match, roomId } = await newMatch();
    const blue = await join(roomId, { token: match.tokens.teams.blue });
    const wrongOp = await request(blue, MSG.mint, { op: 'controller', role: 'runner', controller: 'bot' });
    expect(wrongOp).toEqual({ op: 'result', seq: wrongOp.seq, ok: false, code: 'bad_message' });
    expect(match.seats().find((s) => s.team === 'blue' && s.role === 'runner')?.controller).toBe('bot');

    const big = await request(blue, MSG.call, { op: 'call', role: 'runner', method: 'act', args: { intents: [], pad: 'x'.repeat(MAX_BYTES) } });
    expect(big).toEqual({ op: 'result', seq: big.seq, ok: false, code: 'bad_message' });
    await blue.room.leave();
  });

  it('rejects non-finite numbers, prototype keys, deep nesting and oversized batches without applying an intent', async () => {
    const { match, roomId } = await newMatch();
    const blue = await join(roomId, { token: match.tokens.teams.blue });
    const intents = () => match.replay().entries.filter((entry) => entry[3] === 'intent').length;
    const act = (list: unknown) => request(blue, MSG.call, { op: 'call', role: 'runner', method: 'act', args: { intents: list } });
    const recorded = intents();
    // msgpack carries NaN and ±Infinity, which JSON cannot: the schema must still see them as non-numbers.
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1e308]) {
      expect(await act([{ kind: 'move', x, y: 3 }])).toMatchObject({ ok: true, data: [{ ok: false, code: 'invalid' }] });
    }
    // Own `__proto__` / `constructor` keys (as JSON.parse creates them) are unknown fields, never prototypes.
    const proto = JSON.parse('{"kind":"move","x":3,"y":3,"__proto__":{"polluted":true}}') as unknown;
    const ctor = JSON.parse('{"kind":"move","x":3,"y":3,"constructor":{"prototype":{"polluted":true}}}') as unknown;
    expect(await act([proto, ctor])).toMatchObject({ ok: true, data: [{ ok: false, code: 'invalid' }, { ok: false, code: 'invalid' }] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const envelope = JSON.parse(`{"op":"call","role":"runner","method":"act","args":{"intents":[]},"__proto__":{"role":"guard"},"seq":${++seq}}`) as Record<string, unknown>;
    blue.room.send(MSG.call, envelope);
    expect((await until(() => blue.inbox.find((r) => r.msg.op === 'result' && r.msg.seq === envelope.seq))).msg).toMatchObject({ ok: false, code: 'bad_message' });
    let deep: unknown = { kind: 'move', x: 3, y: 3 };
    for (let i = 0; i < 1000; i++) deep = [deep];
    expect(await act([deep])).toMatchObject({ ok: true, data: [{ ok: false, code: 'invalid' }] });
    // Nesting past the decoder's stack (raw frame: the client encoder has the same limit) drops only that socket.
    const abuser = await join(roomId, { token: match.tokens.teams.blue });
    const dropped = Promise.withResolvers<void>();
    abuser.room.onLeave(() => dropped.resolve());
    abuser.room.connection.send(getMessageBytes.raw(Protocol.ROOM_DATA, MSG.call, undefined, Buffer.alloc(60_000, 0x91)));
    await dropped.promise;
    await barrier(blue);
    expect(await act(Array.from({ length: 65 }, () => ({ kind: 'move', x: 3, y: 3 })))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await act('move')).toMatchObject({ ok: false, code: 'invalid' });
    // Wrong-typed envelope fields: a non-integer or negative seq is never echoed back.
    for (const bad of [-1, 1.5, Number.NaN]) blue.room.send(MSG.call, { op: 'call', seq: bad, role: 'runner', method: 'briefing', args: {} });
    await barrier(blue);
    expect(blue.inbox.filter((r) => r.msg.op === 'result' && r.msg.seq === 0 && !r.msg.ok && r.msg.code === 'bad_message')).toHaveLength(3);
    expect(intents()).toBe(recorded);
    await blue.room.leave();
    await abuser.room.leave();
    match.dispose();
  });
});

describe('seat principals', () => {
  it('drive only their own seat, cannot use owner operations, and never get views', async () => {
    const { match, roomId } = await newMatch();
    const token = match.mintSeatToken('blue', 'runner');
    match.setController('blue', 'runner', 'agent');
    const agent = await join(roomId, { token });

    expect((await request(agent, MSG.mint, { op: 'mint', role: 'runner' })).ok).toBe(false);
    expect((await request(agent, MSG.controller, { op: 'controller', role: 'runner', controller: 'none' })).ok).toBe(false);
    expect((await request(agent, MSG.mandate, { op: 'mandate', role: 'runner', mandate: { autonomy: 'autonomous', directive: { stance: 'attack' }, whenAbsent: 'hold' } })).ok).toBe(false);
    expect(await request(agent, MSG.scopes, { op: 'scopes', role: 'runner', scopes: ['act'] })).toMatchObject({ ok: false, code: 'forbidden' });
    expect((await request(agent, MSG.resolveApproval, { op: 'resolveApproval', role: 'runner', id: 'unknown', approve: true })).ok).toBe(false);
    expect((await request(agent, MSG.call, { op: 'call', role: 'guard', method: 'act', args: { intents: [{ kind: 'stop' }] } })).ok).toBe(false);
    expect(match.seats().find((s) => s.team === 'blue' && s.role === 'runner')?.controller).toBe('agent');

    const own = await request(agent, MSG.call, { op: 'call', role: 'runner', method: 'act', args: { intents: [{ kind: 'stop' }] } });
    expect(own.ok && own.data).toEqual([{ ok: true }]);

    const stream = await request(agent, MSG.stream, { op: 'stream', role: 'runner', everyTicks: 1 });
    expect(stream.ok).toBe(true);
    await match.step(10);
    await until(() => agent.inbox.filter((r) => r.type === MSG.obs).length >= 3);
    for (const r of agent.inbox.filter((x) => x.type === MSG.obs)) {
      expect(r.msg.op === 'obs' && r.msg.role).toBe('runner');
    }
    expect(agent.inbox.some((r) => r.type === MSG.view || r.type === MSG.seats || r.type === MSG.report)).toBe(false);

    // Another seat's stream is not reachable with this token.
    expect((await request(agent, MSG.stream, { op: 'stream', role: 'guard', everyTicks: 1 })).ok).toBe(false);
    await agent.room.leave();
  });
});

describe('owner chat', () => {
  it('owners tell their own agents; agent replies reach only that team\'s owners', async () => {
    const { match, roomId } = await newMatch();
    const blueSeatToken = match.mintSeatToken('blue', 'runner');
    const blue = await join(roomId, { token: match.tokens.teams.blue });
    const red = await join(roomId, { token: match.tokens.teams.red });
    const spec = await join(roomId, { token: match.tokens.spectator });
    const agent = await join(roomId, { token: blueSeatToken });

    const told = await request(blue, MSG.tell, { op: 'tell', roles: ['runner'], text: 'Runner: go north' });
    expect(told.ok).toBe(true);
    expect((await request(agent, MSG.tell, { op: 'tell', roles: 'all', text: 'psst' })).ok).toBe(false);
    const waited = await request(agent, MSG.call, { op: 'call', role: 'runner', method: 'wait', args: { seconds: 0 } });
    expect(waited.ok && waited.data).toMatchObject({ messages: [{ from: 'owner', text: 'Runner: go north' }] });

    const said = await request(agent, MSG.call, { op: 'call', role: 'runner', method: 'say', args: { text: 'Going north' } });
    expect(said.ok).toBe(true);
    const got = await until(() => blue.inbox.find((r) => r.type === MSG.said));
    expect(got.msg).toEqual({ op: 'said', role: 'runner', tick: 0, text: 'Going north' });
    await barrier(red);
    await barrier(spec);
    await barrier(agent);
    for (const conn of [red, spec, agent]) expect(conn.inbox.some((r) => r.type === MSG.said)).toBe(false);
    for (const conn of [blue, red, spec, agent]) await conn.room.leave();
  });
});

describe('sealed public seat bindings', () => {
  async function humanMatch() {
    const match = host.createMatch({
      realtime: false,
      assignments: [
        { team: 'blue', role: 'runner', owner: 'owner_blue_runner', kind: 'human' },
        { team: 'blue', role: 'guard', owner: 'owner_blue_guard', kind: 'human' },
        { team: 'red', role: 'runner', owner: 'owner_red_runner', kind: 'human' },
      ],
    });
    const room = await matchMaker.createRoom('tag', { matchId: match.id });
    return { match, roomId: room.roomId };
  }

  it('preserves trusted root readiness until the last root leaves without making public humans implicitly ready', async () => {
    const { match, roomId } = await humanMatch();
    const first = await join(roomId, { token: match.tokens.teams.blue });
    const second = await join(roomId, { token: match.tokens.teams.blue });
    let human: Conn | undefined;
    let root: Conn | undefined;
    try {
      expect(match.readiness().seats.filter((seat) => seat.team === 'blue' && seat.kind === 'human').map((seat) => seat.state)).toEqual(['ready', 'ready']);
      expect(match.readiness().seats.find((seat) => seat.team === 'red' && seat.role === 'runner')?.state).toBe('waiting');
      await first.room.leave();
      expect(match.readiness().seats.filter((seat) => seat.team === 'blue' && seat.kind === 'human').every((seat) => seat.state === 'ready')).toBe(true);
      await second.room.leave();
      expect(match.readiness().seats.filter((seat) => seat.team === 'blue' && seat.kind === 'human').every((seat) => seat.state === 'waiting')).toBe(true);
      human = await join(roomId, { token: match.mintHumanToken('blue', 'runner').token });
      expect(match.readiness().seats.find((seat) => seat.team === 'blue' && seat.role === 'runner')?.state).toBe('waiting');
      match.setHumanReady('blue', 'runner', true);
      root = await join(roomId, { token: match.tokens.teams.blue });
      await root.room.leave();
      expect(match.readiness().seats.find((seat) => seat.team === 'blue' && seat.role === 'runner')?.state).toBe('ready');
      expect(match.readiness().seats.find((seat) => seat.team === 'blue' && seat.role === 'guard')?.state).toBe('waiting');
    } finally {
      await first.room.leave();
      await second.room.leave();
      await root?.room.leave();
      await human?.room.leave();
      match.dispose();
    }
  });

  it('delivers authorized terminal reports to public humans and scoped spectators before revoking them; a claimed seat stays read-only until disposal', async () => {
    const { match, roomId } = await humanMatch();
    const humanToken = match.mintHumanToken('blue', 'runner').token;
    const spectatorToken = match.mintSpectatorToken('blue').token;
    const seatToken = match.mintSeatToken('blue', 'guard');
    const human = await join(roomId, { token: humanToken });
    const spectator = await join(roomId, { token: spectatorToken });
    const agent = await join(roomId, { token: seatToken });
    const order = new Map<Conn, string[]>();
    const [humanClosed, spectatorClosed, agentClosed] = [human, spectator, agent].map((conn) => {
      const events: string[] = [];
      order.set(conn, events);
      const done = Promise.withResolvers<void>();
      // Typed handlers suppress the SDK wildcard inbox collector; observe order through another wildcard.
      conn.room.onMessage('*', (type) => { if (type === MSG.report) events.push('report'); });
      conn.room.onLeave(() => { events.push('closed'); done.resolve(); });
      return done.promise;
    });
    try {
      await request(agent, MSG.stream, { op: 'stream', role: 'guard', everyTicks: 1 });
      match.end('draw');
      await Promise.all([humanClosed, spectatorClosed]);
      expect(order.get(human)).toEqual(['report', 'closed']);
      expect(order.get(spectator)).toEqual(['report', 'closed']);
      for (const conn of [human, spectator]) {
        const reports = conn.inbox.filter((item) => item.msg.op === 'report');
        expect(reports).toHaveLength(1);
        expect(reports[0]?.msg).toMatchObject({ op: 'report', team: 'blue' });
      }
      // Terminal delivery: an already-claimed seat lease keeps reading its final state until disposal.
      expect(order.get(agent)).toEqual([]);
      expect(host.authenticate(seatToken)).toBeDefined();
      const counts = [human, spectator, agent].map((conn) => conn.inbox.length);
      match.tell('blue', ['runner'], 'POST_END_PRIVATE_SENTINEL');
      expect([human, spectator, agent].map((conn) => conn.inbox.length)).toEqual(counts);
      for (const token of [humanToken, spectatorToken]) {
        expect(host.authenticate(token)).toBeUndefined();
        await expect(sdk.joinById(roomId, { token })).rejects.toThrow();
      }
      // Read-only: the claimed lease admits no further connection.
      await expect(sdk.joinById(roomId, { token: seatToken })).rejects.toThrow();
      match.dispose();
      await agentClosed;
      expect(order.get(agent)).toEqual(['closed']);
      expect(host.authenticate(seatToken)).toBeUndefined();
    } finally {
      for (const conn of [human, spectator, agent]) await conn.room.leave();
      match.dispose();
    }
  });

  it('atomically rejects duplicate seat admission across both Colyseus and actual MCP sessions', async () => {
    const { match, roomId } = await newMatch();
    const handler = createMcpRequestHandler(host);
    const socketToken = match.mintSeatToken('blue', 'runner');
    const socket = await join(roomId, { token: socketToken });
    // Seat credentials speak only the stateless 2026-07-28 revision: the first real call claims the exact lease.
    const firstCall = (token: string) => handler.fetch(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'binding-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    }));
    try {
      await expect(sdk.joinById(roomId, { token: socketToken })).rejects.toThrow();
      expect((await firstCall(socketToken)).status).toBe(401);
      const mcpToken = match.mintSeatToken('blue', 'guard');
      const bound = await firstCall(mcpToken);
      expect(bound.status).toBe(200);
      expect(bound.headers.get('mcp-session-id')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await bound.text();
      await expect(sdk.joinById(roomId, { token: mcpToken })).rejects.toThrow();
      expect((await firstCall(mcpToken)).status).toBe(401);
      const racingToken = match.mintSeatToken('red', 'runner');
      const [socketRace, httpRace] = await Promise.allSettled([
        join(roomId, { token: racingToken }),
        firstCall(racingToken),
      ]);
      expect(httpRace.status).toBe('fulfilled');
      const httpWon = httpRace.status === 'fulfilled' && httpRace.value.status === 200;
      expect(Number(socketRace.status === 'fulfilled') + Number(httpWon)).toBe(1);
      if (httpRace.status === 'fulfilled') {
        expect([200, 401]).toContain(httpRace.value.status);
        await httpRace.value.text();
      }
      if (socketRace.status === 'fulfilled') await socketRace.value.room.leave();
      await socket.room.leave();
      await expect(sdk.joinById(roomId, { token: socketToken })).rejects.toThrow();
    } finally {
      await socket.room.leave();
      await handler.close();
      match.dispose();
    }
  });

  it('gives a human own-side fog but exact-seat private state, control, mint and agent replies only', async () => {
    const { match, roomId } = await humanMatch();
    const joined = vi.spyOn(match, 'humanJoined');
    const runnerToken = match.mintHumanToken('blue', 'runner').token;
    const runner = await join(roomId, { token: runnerToken });
    const guard = await join(roomId, { token: match.mintHumanToken('blue', 'guard').token, view: false });
    const red = await join(roomId, { token: match.mintHumanToken('red', 'runner').token });
    const spectator = await join(roomId, { token: match.mintSpectatorToken('blue').token, watch: ['red'] });
    const agent = await join(roomId, { token: match.mintSeatToken('blue', 'runner') });
    try {
      await expect(sdk.joinById(roomId, { token: runnerToken })).rejects.toThrow();
      expect(joined).toHaveBeenCalledWith('blue', 'runner', true);
      expect(joined).toHaveBeenCalledWith('blue', 'guard', true);
      expect(match.readiness().seats.find((seat) => seat.team === 'blue' && seat.role === 'runner')?.state).toBe('waiting');
      for (const [team, role] of [['blue', 'runner'], ['blue', 'guard'], ['red', 'runner']] as const) match.setHumanReady(team, role, true);
      expect(match.readiness().seats.find((seat) => seat.team === 'blue' && seat.role === 'runner')?.state).toBe('ready');
      for (const [conn, team] of [[runner, 'red'], [red, 'blue']] as const) {
        expect(await request(conn, MSG.controller, { op: 'controller', team, role: 'runner', controller: 'none' })).toMatchObject({ ok: false, code: 'bad_message' });
        expect(await request(conn, MSG.mint, { op: 'mint', team, role: 'runner' })).toMatchObject({ ok: false, code: 'bad_message' });
      }
      expect(match.seats().find((seat) => seat.team === 'red' && seat.role === 'runner')?.controller).toBe('human');
      for (const intruder of [runner, red]) {
        expect(await request(intruder, MSG.controller, { op: 'controller', role: 'guard', controller: 'none' })).toMatchObject({ ok: false, code: 'forbidden' });
        expect(await request(intruder, MSG.mint, { op: 'mint', role: 'guard' })).toMatchObject({ ok: false, code: 'forbidden' });
        expect(await request(intruder, MSG.call, { op: 'call', role: 'guard', method: 'policyStatus', args: {} })).toMatchObject({ ok: false, code: 'forbidden' });
        expect(await request(intruder, MSG.stream, { op: 'stream', role: 'guard', everyTicks: 1 })).toMatchObject({ ok: false, code: 'forbidden' });
      }
      expect(await request(guard, MSG.controller, { op: 'controller', role: 'runner', controller: 'none' })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await request(guard, MSG.tell, { op: 'tell', roles: ['runner'], text: 'FOREIGN_OWNER_INJECTION' })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await request(runner, MSG.tell, { op: 'tell', roles: 'all', text: 'PRIVATE_RUNNER_ORDER' })).toMatchObject({ ok: true });
      const heard = await request(agent, MSG.call, { op: 'call', role: 'runner', method: 'wait', args: { seconds: 0 } });
      expect(heard).toMatchObject({ ok: true, data: { messages: [{ from: 'owner', text: 'PRIVATE_RUNNER_ORDER' }] } });
      expect(await request(agent, MSG.call, { op: 'call', role: 'runner', method: 'say', args: { text: 'PRIVATE_RUNNER_REASONING' } })).toMatchObject({ ok: true });
      await until(() => runner.inbox.some((item) => item.msg.op === 'said'));
      for (const conn of [guard, red, spectator]) {
        await barrier(conn);
        expect(JSON.stringify(conn.inbox)).not.toContain('PRIVATE_RUNNER_REASONING');
        expect(JSON.stringify(conn.inbox)).not.toContain('PRIVATE_RUNNER_ORDER');
      }
      const ownSeats = runner.inbox.filter((item) => item.msg.op === 'seats');
      expect(ownSeats.length).toBeGreaterThan(0);
      for (const item of ownSeats) if (item.msg.op === 'seats') expect(item.msg.seats.every((seat) => seat.team === 'blue' && seat.role === 'runner')).toBe(true);
      expect(guard.inbox.some((item) => item.msg.op === 'seats')).toBe(true);
      expect(guard.inbox.some((item) => item.msg.op === 'view' || item.msg.op === 'report')).toBe(false);
      expect(spectator.inbox.some((item) => item.msg.op === 'seats')).toBe(false);
      expect(viewMessages(runner).every((item) => item.msg.op === 'view' && item.msg.team === 'blue')).toBe(true);
      expect(viewMessages(red).every((item) => item.msg.op === 'view' && item.msg.team === 'red')).toBe(true);
      expect(viewMessages(spectator).every((item) => item.msg.op === 'view' && item.msg.team === 'blue')).toBe(true);
      expect(await request(runner, MSG.mint, { op: 'mint', role: 'runner' })).toMatchObject({ ok: true });
      await runner.room.leave();
      expect(joined).toHaveBeenCalledWith('blue', 'runner', false);
      expect(match.readiness().seats.find((seat) => seat.team === 'blue' && seat.role === 'runner')?.state).toBe('waiting');
    } finally {
      for (const conn of [runner, guard, red, spectator, agent]) await conn.room.leave();
      joined.mockRestore();
      match.dispose();
    }
  });

  it('keeps a scoped spectator on its fixed side and outside every private agent operation', async () => {
    const { match, roomId } = await newMatch();
    match.setController('blue', 'runner', 'agent');
    const ticket = match.mintSpectatorToken('blue');
    const spectator = await join(roomId, { token: ticket.token });
    try {
      await expect(sdk.joinById(roomId, { token: ticket.token })).rejects.toThrow();
      spectator.room.send(MSG.watch, { op: 'watch', teams: ['red'] });
      for (const [type, payload] of [
        [MSG.mint, { op: 'mint', role: 'runner' }],
        [MSG.call, { op: 'call', role: 'runner', method: 'policyStatus', args: {} }],
        [MSG.stream, { op: 'stream', role: 'runner', everyTicks: 1 }],
        [MSG.tell, { op: 'tell', roles: 'all', text: 'SPECTATOR_INJECTION' }],
      ] as const) expect(await request(spectator, type, payload)).toMatchObject({ ok: false, code: 'forbidden' });
      await match.step(5);
      await until(() => lastTick(spectator) === 5);
      expect(viewMessages(spectator).every((item) => item.msg.op === 'view' && item.msg.team === 'blue')).toBe(true);
      expect(spectator.inbox.some((item) => item.msg.op === 'seats' || item.msg.op === 'said' || item.msg.op === 'obs')).toBe(false);
      expect(spectator.inbox.some((item) => item.msg.op === 'cards' && item.msg.cards.some((card) => card.seat.team === 'blue' && card.seat.role === 'runner' && card.aiPlayer))).toBe(true);
      for (const item of spectator.inbox) if (item.msg.op === 'cards') {
        expect(item.msg.cards.every((card) => card.seat.team === 'blue')).toBe(true);
        expect(JSON.stringify(item.msg)).not.toMatch(/mandate|scopes|owner|token|endpoint|code/);
      }
    } finally {
      await spectator.room.leave();
      match.dispose();
    }
  });

  it('closes an already joined stream on owner revocation and an idle spectator on expiry', async () => {
    const { match, roomId } = await newMatch();
    const token = match.mintSeatToken('blue', 'runner');
    const agent = await join(roomId, { token });
    const revoked = Promise.withResolvers<void>();
    agent.room.onLeave(() => revoked.resolve());
    await request(agent, MSG.stream, { op: 'stream', role: 'runner', everyTicks: 1 });
    match.revokeSeat('blue', 'runner');
    await revoked.promise;
    const count = agent.inbox.length;
    await match.step(5);
    expect(agent.inbox).toHaveLength(count);
    await expect(sdk.joinById(roomId, { token })).rejects.toThrow();
    // Real sockets stay idle here: the host's platform expiry timer, not another request or simulation tick,
    // must close the connection; fake timers cannot drive the real Colyseus HTTP/WebSocket handshake.
    const ticket = match.mintSpectatorToken('blue', { ttlSeconds: 1 });
    const spectator = await join(roomId, { token: ticket.token });
    const expired = Promise.withResolvers<void>();
    spectator.room.onLeave(() => expired.resolve());
    await expired.promise;
    await expect(sdk.joinById(roomId, { token: ticket.token })).rejects.toThrow();
    match.dispose();
  });
});
