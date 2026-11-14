import { describe, expect, it } from 'vitest';
import { ObserverStream, OBSERVER_MAX_BATCH } from '../src/host/observers.ts';
import { diff, patch } from '../src/delta.ts';
import type { ObserverGrant, ObserverMessage } from '../src/protocol.ts';
import type { Outcome } from '../src/manifest.ts';

const publicGrant: ObserverGrant = { kind: 'omniscient', teams: ['blue', 'red'], delayMs: 180_000 };
function fixture(limits: { maxBytes?: number; maxAgeMs?: number } = {}) {
  let now = 1_000_000;
  let tick = 0;
  let over = false;
  const world = { terrain: [1], units: [1, 2], resources: { blue: 100, red: 200 } };
  const stream = new ObserverStream({
    teams: ['blue', 'red'],
    projectAll: () => ({ ...world, tick }),
    projectTeam: (team) => ({ team, tick, units: team === 'blue' ? [1] : [2] }),
    outcomes: (): Record<string, Outcome> => over ? { blue: 'win', red: 'loss' } : { blue: 'running', red: 'running' },
    now: () => now,
    ...limits,
  });
  return { stream, world, advance(ms: number, ticks = 0) { now += ms; tick += ticks; }, capture() { stream.capture(tick); }, end() { over = true; } };
}
const one = (messages: ObserverMessage[]): ObserverMessage => { expect(messages).toHaveLength(1); return messages[0]!; };

/** What a client does: keyframes replace, deltas apply to the previous frame of the same perspective. */
function replay(messages: ObserverMessage[], state: { sequence: number; world: unknown }) {
  for (const message of messages) {
    const frame = message.frame;
    if (!frame) continue;
    if (frame.world !== undefined) state.world = frame.world;
    else {
      expect(frame.sequence).toBe(state.sequence + 1);
      if (frame.delta) state.world = patch(state.world, frame.delta);
    }
    state.sequence = frame.sequence;
  }
  return state;
}

describe('observer wall-clock history', () => {
  it('buffers bootstrap and outcomes despite accelerated simulation and late joins', () => {
    const f = fixture();
    f.capture();
    f.advance(1_000, 72_000);
    f.end();
    f.capture();
    expect(f.stream.read(publicGrant, 'all')).toEqual([{ op: 'observer', state: 'buffering' }]);
    f.advance(179_000);
    const initial = one(f.stream.read(publicGrant, 'all'));
    expect(initial.frame).toMatchObject({ tick: 0, sequence: 1, releaseAt: 1_180_000 });
    expect(initial.frame?.outcomes).toBeUndefined();
    expect(f.stream.read(publicGrant, 'all', 1)).toEqual([{ op: 'observer', state: 'buffering' }]);
    f.advance(1_000);
    expect(one(f.stream.read(publicGrant, 'all', 1)).frame).toMatchObject({ tick: 72_000, delta: { v: { tick: 72_000 } }, outcomes: { blue: 'win', red: 'loss' } });
    // Reconnect gets the released terminal frame as a keyframe, never a separate live completion push.
    expect(one(f.stream.read(publicGrant, 'all')).frame).toMatchObject({ sequence: 2, world: { tick: 72_000, units: [1, 2] } });
  });

  it('keeps team grants fixed and frames detached from mutable state and immutable for readers', () => {
    const f = fixture();
    f.capture();
    f.world.units.push(99);
    const team: ObserverGrant = { kind: 'team', team: 'blue', delayMs: 0 };
    expect(one(f.stream.read(team, 'red')).state).toBe('closed');
    expect(one(f.stream.read(team, 'all')).state).toBe('closed');
    expect(one(f.stream.read(team, 'blue')).frame?.world).toEqual({ team: 'blue', tick: 0, units: [1] });
    const immediate = { ...publicGrant, delayMs: 0 };
    const frame = one(f.stream.read(immediate, 'all')).frame!;
    const world = frame.world;
    if (typeof world !== 'object' || world === null || !('units' in world) || !Array.isArray(world.units)) throw new Error('units missing');
    const units = world.units;
    expect(units).toEqual([1, 2]);
    expect(() => units.push(77)).toThrow(TypeError);
    expect(one(f.stream.read(immediate, 'all')).frame?.world).toMatchObject({ units: [1, 2] });
    expect(one(f.stream.read({ kind: 'omniscient', teams: ['blue'], delayMs: 0 }, 'all')).state).toBe('closed');
  });

  it('streams every frame as a delta after one keyframe and shares each message across readers', () => {
    const f = fixture();
    const grant = { ...publicGrant, delayMs: 1_000 };
    f.capture();
    for (let i = 1; i <= 30; i++) {
      f.world.resources.blue += i;
      if (i === 10) f.world.units.push(3);
      f.advance(50, 1);
      f.capture();
    }
    f.advance(1_000);
    const join = f.stream.read(grant, 'all');
    expect(join).toHaveLength(1);
    expect(join[0]!.frame?.sequence).toBe(31);
    // Two readers at the same cursor receive the same frozen message objects: built and encoded once.
    expect(f.stream.read(grant, 'all')[0]).toBe(join[0]);
    const late = replay(f.stream.read(grant, 'all', 5), { sequence: 5, world: undefined });
    expect(late.sequence).toBe(31);
    const tail = f.stream.read(grant, 'all', 20);
    expect(tail).toHaveLength(11);
    expect(f.stream.read(grant, 'all', 20)[3]).toBe(tail[3]);
    expect(tail.every((message) => message.frame?.world === undefined && message.frame?.delta !== undefined)).toBe(true);
    const state = replay(f.stream.read(grant, 'all', 0), { sequence: 0, world: undefined });
    expect(state).toEqual({ sequence: 31, world: { terrain: [1], units: [1, 2, 3], resources: { blue: 100 + 465, red: 200 }, tick: 30 } });
  });

  it('resynchronizes a reader too far behind with a single released keyframe', () => {
    const f = fixture();
    const grant = { ...publicGrant, delayMs: 0 };
    f.capture();
    for (let i = 0; i < OBSERVER_MAX_BATCH + 5; i++) { f.advance(50, 1); f.capture(); }
    const behind = f.stream.read(grant, 'all', 1);
    expect(behind).toHaveLength(1);
    expect(behind[0]!.frame).toMatchObject({ sequence: OBSERVER_MAX_BATCH + 6, world: { tick: OBSERVER_MAX_BATCH + 5 } });
  });

  it('folds expired frames into the base so late keyframes stay exact', () => {
    const f = fixture({ maxAgeMs: 2_000 });
    const grant = { ...publicGrant, delayMs: 1_000 };
    for (let i = 0; i < 100; i++) { f.world.resources.red = i; f.advance(100, 1); f.capture(); }
    f.advance(1_000);
    const frame = one(f.stream.read(grant, 'all')).frame!;
    expect(frame).toMatchObject({ sequence: 100, world: { resources: { blue: 100, red: 99 }, tick: 100 } });
    expect(one(f.stream.read(grant, 'all', 1)).state).toBe('closed');
  });

  it('fails closed on capacity, schema/projector failure, expired cursors and invalid delays', () => {
    const tiny = fixture({ maxBytes: 1 });
    tiny.capture();
    expect(one(tiny.stream.read(publicGrant, 'all')).state).toBe('closed');
    const f = fixture({ maxAgeMs: 200_000 });
    f.capture();
    f.advance(100_000); f.capture();
    f.advance(100_000); f.capture();
    f.advance(100_000); f.capture();
    f.advance(100_000);
    expect(one(f.stream.read(publicGrant, 'all', 1)).state).toBe('closed');
    expect(one(f.stream.read({ ...publicGrant, delayMs: 200_000 }, 'all')).state).toBe('closed');
    expect(one(f.stream.read(publicGrant, 'all', 99)).state).toBe('closed');
    const invalid = new ObserverStream({ teams: ['blue'], projectAll: () => { throw new Error('bad schema'); }, projectTeam: () => null, outcomes: () => ({ blue: 'running' }) });
    invalid.capture(0);
    expect(one(invalid.read({ kind: 'team', team: 'blue', delayMs: 0 }, 'blue')).state).toBe('closed');
  });

  it('retains delayed end watermark after simulation stops', async () => {
    const f = fixture();
    f.end(); f.capture();
    f.advance(180_000);
    const iterator = f.stream.frames(publicGrant)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ sequence: 1, outcomes: { blue: 'win', red: 'loss' } });
    expect((await iterator.next()).done).toBe(true);
    f.advance(1_000_000);
    expect(one(f.stream.read(publicGrant, 'all')).state).toBe('closed'); // declared retention bound, not an immortal replay
    f.stream.dispose();
    expect(one(f.stream.read(publicGrant, 'all')).state).toBe('closed');
  });

  it('separates voluntary commentary consent from vision and rechecks withdrawal', () => {
    let consent = false;
    const item = { id: 'event', team: 'blue', role: 'role', tick: 0, category: 'summary' as const, text: 'Attacking', privateOwner: 'never-export' };
    const stream = new ObserverStream({
      teams: ['blue', 'red'], projectAll: () => ({}), projectTeam: () => ({}),
      outcomes: () => ({ blue: 'running', red: 'running' }), now: () => 1_000_000,
      commentary: { capture: () => [item], authorize: () => consent },
    });
    stream.capture(0);
    const grant = { ...publicGrant, delayMs: 0 };
    expect(one(stream.read(grant, 'all')).frame?.commentary).toBeUndefined();
    consent = true;
    expect(one(stream.read(grant, 'all')).frame?.commentary).toEqual([
      { id: 'event', team: 'blue', role: 'role', tick: 0, category: 'summary', text: 'Attacking' },
    ]);
    consent = false;
    expect(one(stream.read(grant, 'all')).frame?.commentary).toBeUndefined();
    expect(one(stream.read({ kind: 'team', team: 'red', delayMs: 0 }, 'red')).frame?.commentary).toBeUndefined();
  });
});

describe('structural JSON deltas', () => {
  it('round-trips keyed lists, positional arrays, removals and type changes with structural sharing', () => {
    const prev = { tick: 1, match: { size: 48, rules: [1, 2, 3] }, entities: [{ id: 'a', x: 1 }, { id: 'b', x: 2 }, { id: 7, x: 3 }], grid: Array.from({ length: 20 }, (_, i) => i), gone: true, nested: [[1], [2]] };
    const next = { tick: 2, match: { size: 48, rules: [1, 2, 3] }, entities: [{ id: 7, x: 3 }, { id: 'a', x: 1.5 }, { id: 'c', x: 0 }], grid: Array.from({ length: 21 }, (_, i) => i === 4 ? 40 : i), nested: [[1], [2, 3]], skipped: undefined };
    const delta = diff(prev, next)!;
    const out = patch(prev, delta) as typeof next & { match: unknown };
    expect(out).toEqual(JSON.parse(JSON.stringify(next)));
    expect(out.match).toBe(prev.match);
    const terrain = { cells: Array.from({ length: 1000 }, (_, i) => i % 7), units: Array.from({ length: 50 }, (_, i) => ({ id: `u${i}`, x: i, y: i })) };
    const moved = { ...terrain, units: terrain.units.map((unit) => unit.id === 'u3' ? { ...unit, x: 3.5 } : unit) };
    expect(JSON.stringify(diff(terrain, moved))).toBe('{"o":{"units":{"k":1,"u":{"u3":{"v":{"x":3.5}}}}}}');
    expect(diff(next, JSON.parse(JSON.stringify(next)))).toBeUndefined();
    expect(patch([1, 2], diff([1, 2], { a: 1 })!)).toEqual({ a: 1 });
    expect(patch({ list: [{ id: 'x' }] }, diff({ list: [{ id: 'x' }] }, { list: [] })!)).toEqual({ list: [] });
  });
});
