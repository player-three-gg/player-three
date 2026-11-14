import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definition, manifest, TagGame, type TagManifest } from '../examples/tag/index.ts';
import type { GameDefinition } from '../src/index.ts';
import { t } from '../src/schema.ts';
import { createPlayerApiHandler, type PlayerApiHandler, type PlayerState } from '../src/devtools/player.ts';
import { MAX_SSE_BUFFERED_BYTES, TraceHub } from '../src/devtools/trace.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import type { PlayerThreeHost, CommanderStatus } from '../src/host/types.ts';

const ALICE = 'alice_owner_0001';
const BOB = 'bob_owner_000002';
/** Only the host's profile resolver supplies owner identity, never request query parameters. */
const SECRETS: Record<string, string> = { 'alice-profile-secret': ALICE, 'bob-profile-secret': BOB, 'carol-no-roster': 'carol_owner_003' };

let rigs: { host: PlayerThreeHost<TagManifest>; player: PlayerApiHandler; server: Server }[] = [];
afterEach(async () => {
  for (const r of rigs) {
    r.player.close();
    r.host.dispose();
    const closed = Promise.withResolvers<void>();
    r.server.close(() => closed.resolve());
    await closed.promise;
  }
  rigs = [];
});

/** Tag with an observer schema: omniscient observer grants require one, and this suite proves the player API rejects them. */
const observerManifest = { ...manifest, observer: t.obj({ tick: t.int(0, 1_000_000), visible: t.int(0, 4) }) };
const observed: GameDefinition<TagManifest> = { ...definition, manifest: observerManifest, create: ({ seed }) => {
  const game = new TagGame(seed);
  return Object.assign(game, { manifest: observerManifest, observerView: () => ({ tick: game.tick, visible: 4 }) });
} };

async function rig(): Promise<{ host: PlayerThreeHost<TagManifest>; base: string }> {
  const host = createPlayerThreeHost({ definition: observed });
  await host.commanders.ready;
  const owner = (req: IncomingMessage) => SECRETS[/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''];
  const player = createPlayerApiHandler(host, { owner });
  const server = createServer((req, res) => void player.handle(req, res));
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  rigs.push({ host, player, server });
  return { host, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/playerthree/player` };
}

const get = (url: string, credential: string) => fetch(url, { headers: { authorization: `Bearer ${credential}` } });
const create = (host: PlayerThreeHost<TagManifest>, owner: string, name: string, roles = ['runner']): CommanderStatus =>
  host.commanders.create(owner, { name, kind: 'agent', roles, isolation: { independentSessions: true } });
const target = (commander: string, match: string, team: string, role: string) => new URLSearchParams({ commander, match, team, role });

describe('player API: named commander and exact-seat authority', () => {
  it('returns a teamless named roster, preserves duplicate compatible roles, and accepts empty authenticated profiles', async () => {
    const { host, base } = await rig();
    const first = create(host, ALICE, 'DeepSeek');
    const second = create(host, ALICE, 'Claude', ['runner', 'guard']);
    const response = await get(`${base}/state`, 'alice-profile-secret');
    expect(response.status).toBe(200);
    const state = await response.json() as PlayerState;
    expect(state).toMatchObject({ match: null, team: null, target: null, seats: [], readiness: {}, events: [] });
    expect(state.commanders?.map((c) => [c.id, c.name, c.roles, c.seated])).toEqual([
      [first.id, 'DeepSeek', ['runner'], null], [second.id, 'Claude', ['runner', 'guard'], null],
    ]);
    expect(state.commanders?.every((c) => !('role' in c) && !('preference' in c))).toBe(true);
    expect(JSON.stringify(state)).not.toContain(host.commanders.token(ALICE, first.id));
    expect((await get(`${base}/stream`, 'alice-profile-secret')).status).toBe(409);
    const empty = await get(`${base}/state`, 'carol-no-roster');
    expect(empty.status).toBe(200);
    expect((await empty.json() as PlayerState).commanders).toEqual([]);
    expect((await get(`${base}/state?owner=${ALICE}`, 'wrong')).status).toBe(401);
  });

  it('does not automatically follow any side, and rejects role-key or foreign-commander selections', async () => {
    const { host, base } = await rig();
    const alice = create(host, ALICE, 'Alice runner');
    const bob = create(host, BOB, 'Bob runner');
    const match = host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice.id } },
      { team: 'red', role: 'runner', owner: BOB, kind: 'agent', commander: { id: bob.id } },
    ] });
    const roster = await (await get(`${base}/state`, 'alice-profile-secret')).json() as PlayerState;
    expect(roster).toMatchObject({ match: null, team: null, seats: [], observations: {}, events: [] });
    expect((await get(`${base}/state?role=runner`, 'alice-profile-secret')).status).toBe(400);
    expect((await get(`${base}/state?${target('runner', match.id, 'blue', 'runner')}`, 'alice-profile-secret')).status).toBe(403);
    expect((await get(`${base}/state?${target(bob.id, match.id, 'red', 'runner')}`, 'alice-profile-secret')).status).toBe(403);
    expect((await get(`${base}/state?${target(alice.id, match.id, 'red', 'runner')}`, 'alice-profile-secret')).status).toBe(403);
    expect((await get(`${base}/state?${target(alice.id, match.id, 'blue', 'guard')}`, 'alice-profile-secret')).status).toBe(403);
    const selected = await get(`${base}/state?${target(alice.id, match.id, 'blue', 'runner')}`, 'alice-profile-secret');
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ match: match.id, team: 'blue', target: { commander: alice.id, match: match.id, team: 'blue', role: 'runner' } });
  });

  it('keeps several role lanes of one named commander separately selectable', async () => {
    const { host, base } = await rig();
    const commander = create(host, ALICE, 'Whole side', ['runner', 'guard']);
    const match = host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: commander.id } },
      { team: 'blue', role: 'guard', owner: ALICE, kind: 'agent', commander: { id: commander.id } },
    ] });
    await match.seat('blue', 'runner').observe();
    await match.seat('blue', 'guard').observe();
    const roster = await (await get(`${base}/state`, 'alice-profile-secret')).json() as PlayerState;
    expect(roster.commanders?.[0]?.seated).toMatchObject({ match: match.id, team: 'blue' });
    expect(roster.commanders?.[0]?.seated?.roles.slice().sort()).toEqual(['guard', 'runner']);
    for (const role of ['runner', 'guard']) {
      const response = await get(`${base}/state?${target(commander.id, match.id, 'blue', role)}`, 'alice-profile-secret');
      expect(response.status).toBe(200);
      const state = await response.json() as PlayerState;
      expect(state.seats.map((seat) => seat.role)).toEqual([role]);
      expect(Object.keys(state.observations)).toEqual([role]);
      expect(Object.keys(state.policies)).toEqual([role]);
    }
  });

  it('seals HTTP and SSE to the selected owned lane, including same-side peers, and closes on revocation', async () => {
    const { host, base } = await rig();
    const alice = create(host, ALICE, 'Alice runner');
    const bob = create(host, BOB, 'Bob guard', ['guard']);
    const match = host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice.id } },
      { team: 'blue', role: 'guard', owner: BOB, kind: 'agent', commander: { id: bob.id } },
    ] });
    await match.seat('blue', 'runner').observe();
    await match.seat('blue', 'guard').observe();
    const query = target(alice.id, match.id, 'blue', 'runner');
    const state = await (await get(`${base}/state?${query}`, 'alice-profile-secret')).json() as PlayerState;
    expect(state.seats.map((seat) => [seat.team, seat.role])).toEqual([['blue', 'runner']]);
    expect(Object.keys(state.observations)).toEqual(['runner']);
    expect(Object.keys(state.policies)).toEqual(['runner']);
    expect(Object.keys(state.readiness)).not.toContain('guard');
    expect(JSON.stringify(state.events)).not.toContain('"role":"guard"');
    const stream = await get(`${base}/stream?${query}`, 'alice-profile-secret');
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"role":"runner"');
    expect(first).not.toContain('"role":"guard"');
    match.revokeSeat('blue', 'runner');
    for (;;) {
      const next = await reader.read();
      expect(new TextDecoder().decode(next.value)).not.toContain('"role":"guard"');
      if (next.done) break;
    }
    reader.releaseLock();
    expect((await get(`${base}/state?${query}`, 'alice-profile-secret')).status).toBe(403);
  });

  it('keeps the live human console exact-seat and rejects agent, spectator and observer capabilities', async () => {
    const { host, base } = await rig();
    const match = host.createMatch({ realtime: false, observerPolicy: { allowOmniscient: true, minDelayMs: 0, public: false }, assignments: [{ team: 'blue', role: 'runner', owner: ALICE, kind: 'human' }] });
    const human = match.mintHumanToken('blue', 'runner').token;
    const state = await (await get(`${base}/state`, human)).json() as PlayerState;
    expect(state.seats.map((seat) => [seat.team, seat.role])).toEqual([['blue', 'runner']]);
    expect(state.commanders).toBeUndefined();
    expect(state.target).toBeNull();
    expect((await get(`${base}/state?${target('forged', match.id, 'red', 'guard')}`, human)).status).toBe(403);
    expect((await get(`${base}/state`, match.mintSeatToken('blue', 'guard'))).status).toBe(403);
    expect((await get(`${base}/state`, match.tokens.spectator)).status).toBe(403);
    const observer = match.mintObserverToken({ kind: 'omniscient', teams: ['blue', 'red'], delayMs: 0 }, { owner: BOB }).token;
    expect((await get(`${base}/state`, observer)).status).toBe(403);
    expect((await get(`${base}/stream`, observer)).status).toBe(403);
    const team = await (await get(`${base}/state`, match.tokens.teams.blue!)).json() as PlayerState;
    expect(team.seats.every((seat) => seat.team === 'blue')).toBe(true);
    expect(team.commanders).toBeUndefined();
  });

  it('denies owner console access across opposing seats even when both commanders belong to that profile', async () => {
    const { host, base } = await rig();
    const first = create(host, ALICE, 'Blue isolated lane');
    const second = create(host, ALICE, 'Red isolated lane');
    const match = host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: first.id } },
      { team: 'red', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: second.id } },
    ] });
    expect((await get(`${base}/state?${target(first.id, match.id, 'blue', 'runner')}`, 'alice-profile-secret')).status).toBe(403);
    expect((await get(`${base}/stream?${target(second.id, match.id, 'red', 'runner')}`, 'alice-profile-secret')).status).toBe(403);
    const roster = await (await get(`${base}/state`, 'alice-profile-secret')).json() as PlayerState;
    expect(roster.seats).toEqual([]);
    expect(roster.observations).toEqual({});
  });
});

describe('trace streams', () => {
  it('fix: disconnects a subscriber that stops reading instead of buffering without bound', () => {
    // The hub's 1 s status heartbeat is the write that must notice the backlog.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const host = createPlayerThreeHost({ definition });
    const hub = new TraceHub(host as unknown as PlayerThreeHost, 10);
    const match = host.createMatch({ realtime: false, controllers: { blue: { runner: 'bot', guard: 'bot' }, red: { runner: 'bot', guard: 'bot' } } });
    // A response whose peer never drains: everything written stays in the socket buffer.
    const writes: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableLength: 0,
      writeHead() { return this; }, flushHeaders() {},
      write(chunk: string) { writes.push(chunk); this.writableLength += chunk.length; return false; },
      destroy() { this.destroyed = true; return this; }, end() {},
    });
    try {
      hub.stream(new EventEmitter() as IncomingMessage, res as unknown as ServerResponse, match as never, undefined, () => ({ tick: match.tick }));
      expect(writes).toHaveLength(1);
      res.writableLength = MAX_SSE_BUFFERED_BYTES + 1;
      vi.advanceTimersByTime(1_000);
      expect(res.destroyed).toBe(true);
      expect(writes).toHaveLength(1);
      vi.advanceTimersByTime(1_000);
      expect(writes).toHaveLength(1);
    } finally {
      hub.close();
      host.dispose();
      vi.useRealTimers();
    }
  });
});
