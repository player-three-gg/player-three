import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definition, type TagManifest } from '../examples/tag/index.ts';
import { createPlayerThreeHost, HISTORY_DEFAULTS } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeHostOptions, PlayerThreeMatch, Replay } from '../src/host/types.ts';

let hosts: PlayerThreeHost<TagManifest>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeHost(opts: Partial<PlayerThreeHostOptions<TagManifest>> = {}): PlayerThreeHost<TagManifest> {
  const h = createPlayerThreeHost({ definition, ...opts });
  hosts.push(h);
  return h;
}
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'playerthree-history-'));
  dirs.push(d);
  return d;
};

/** Plays a short session with an agent seat (one rejected intent), ends it and releases it; returns its final replay. */
async function playAndRelease(host: PlayerThreeHost<TagManifest>, seed = 3): Promise<{ match: PlayerThreeMatch<TagManifest>; replay: Replay }> {
  const match = host.createMatch({ seed, realtime: false, controllers: { blue: { runner: 'agent' } } });
  const runner = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
  await runner.act([{ kind: 'move', x: 15, y: 4 }]);
  await runner.act([{ kind: 'move', x: 99, y: 0 }]);
  await match.step(12);
  match.end({ blue: 'win', red: 'loss' });
  const replay = match.replay();
  match.dispose();
  return { match, replay };
}

describe('session history', () => {
  it('keeps a record and the replay of every released session, newest first', async () => {
    const host = makeHost();
    expect(host.history.limits).toEqual({ ...HISTORY_DEFAULTS, dir: null });
    expect(host.history.list()).toEqual([]);
    const seen: string[] = [];
    host.history.onRecord((r) => seen.push(r.id));
    const live = host.createMatch({ seed: 9, realtime: false });
    const { match, replay } = await playAndRelease(host);
    expect(host.getMatch(match.id)).toBeUndefined();
    expect(seen).toEqual([match.id]);
    const [record] = host.history.list();
    expect(record).toMatchObject({
      id: match.id,
      game: 'tag',
      gameVersion: definition.manifest.version,
      seed: 3,
      options: null,
      endedAt: expect.any(Number),
      releasedAt: expect.any(Number),
      ticks: 12,
      seconds: 12 / definition.manifest.tickRate,
      outcomes: { blue: 'win', red: 'loss' },
      owners: {},
      sameOwnerOpposed: false,
      rejections: 1,
      policyErrors: 0,
      codes: { rejections: [{ code: 'invalid:range', count: 1 }], policyErrors: [] },
      replay: true,
      replayBytes: Buffer.byteLength(JSON.stringify(replay)),
    });
    expect(record!.createdAt).toBeLessThanOrEqual(record!.endedAt!);
    expect(record!.seats).toContainEqual({ team: 'blue', role: 'runner', controller: 'agent', owner: null, commander: false, harnesses: [] });
    expect(await host.history.replay(match.id)).toEqual(replay);
    expect(host.history.get(live.id)).toBeUndefined();
    expect(await host.history.replay('nope')).toBeUndefined();

    // Released while running (an idle cap): outcome stays running, endedAt null.
    host.history.annotate(live.id, 'red', 'guard', 'Claude Code · sign-in');
    host.history.annotate(live.id, 'red', 'guard', 'Claude Code · sign-in');
    live.dispose();
    expect(host.history.list().map((r) => r.id)).toEqual([live.id, match.id]);
    expect(host.history.get(live.id)).toMatchObject({ endedAt: null, outcomes: { blue: 'running', red: 'running' } });
    expect(host.history.get(live.id)!.seats.find((s) => s.team === 'red' && s.role === 'guard')!.harnesses).toEqual(['Claude Code · sign-in']);
  });

  it('records commander owners per exact seat', async () => {
    const host = makeHost();
    await host.commanders.ready;
    host.commanders.ensure('owner-alice');
    const commanders = ['runner', 'guard'].map((role) => host.commanders.create('owner-alice', {
      name: role, kind: 'agent', roles: [role], isolation: { independentSessions: true },
    }));
    const match = host.createMatch({ realtime: false, assignments: commanders.map((commander) => ({
      team: 'blue', role: commander.roles[0]!, owner: 'owner-alice', kind: 'agent', commander: { id: commander.id },
    })) });
    match.dispose();
    const record = host.history.get(match.id)!;
    expect(record.owners).toEqual({ 'blue/runner': 'owner-alice', 'blue/guard': 'owner-alice' });
    expect(record.seats.filter((s) => s.team === 'blue').every((s) => s.owner === 'owner-alice' && s.commander)).toBe(true);
    expect(record.seats.filter((s) => s.team === 'red').every((s) => s.owner === null && !s.commander)).toBe(true);
  });

  it('retains distinct same-side owners and persists the exact-seat ownership index', () => {
    const host = makeHost();
    host.commanders.ensure('owner-alice');
    host.commanders.ensure('owner-bob');
    const match = host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: 'owner-alice', kind: 'bot' },
      { team: 'blue', role: 'guard', owner: 'owner-bob', kind: 'bot' },
    ] });
    const replay = match.replay();
    match.dispose();
    const record = host.history.get(match.id)!;
    expect(record.owners).toEqual({ 'blue/runner': 'owner-alice', 'blue/guard': 'owner-bob' });
    expect(record.seats.find((seat) => seat.team === 'blue' && seat.role === 'runner')?.owner).toBe('owner-alice');
    expect(record.seats.find((seat) => seat.team === 'blue' && seat.role === 'guard')?.owner).toBe('owner-bob');
    const dir = tempDir();
    writeFileSync(join(dir, `${match.id}.json`), JSON.stringify({
      format: 'playerthree.session', version: 1,
      record, replay,
    }));
    const restarted = makeHost({ history: { dir } });
    expect(restarted.history.get(match.id)?.owners).toEqual(record.owners);
  });

  it('is bounded by count, age and replay bytes (oldest dropped first)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const byCount = makeHost({ history: { maxSessions: 2 } });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await playAndRelease(byCount, i)).match.id);
    expect(byCount.history.list().map((r) => r.id)).toEqual([ids[2], ids[1]]);

    const byAge = makeHost({ history: { maxAgeMs: 60_000 } });
    const old = (await playAndRelease(byAge)).match.id;
    vi.setSystemTime(1_000_000 + 30_000);
    const fresh = (await playAndRelease(byAge)).match.id;
    expect(byAge.history.list().map((r) => r.id)).toEqual([fresh, old]);
    vi.setSystemTime(1_000_000 + 61_000);
    expect(byAge.history.list().map((r) => r.id)).toEqual([fresh]);
    expect(byAge.history.get(old)).toBeUndefined();

    const one = (await playAndRelease(makeHost())).replay;
    const size = Buffer.byteLength(JSON.stringify(one));
    const byBytes = makeHost({ history: { maxBytes: Math.floor(size * 1.5) } });
    const first = (await playAndRelease(byBytes)).match.id;
    const second = (await playAndRelease(byBytes)).match.id;
    expect(byBytes.history.list().map((r) => r.id)).toEqual([second]);
    expect(byBytes.history.get(first)).toBeUndefined();

    // A replay larger than the whole budget: the record is kept without it.
    const tiny = makeHost({ history: { maxBytes: 10 } });
    const big = (await playAndRelease(tiny)).match.id;
    expect(tiny.history.get(big)).toMatchObject({ replay: false, replayBytes: size });
    expect(await tiny.history.replay(big)).toBeUndefined();

    const off = makeHost({ history: { maxSessions: 0 } });
    await playAndRelease(off);
    expect(off.history.list()).toEqual([]);
    expect(() => makeHost({ history: { maxSessions: -1 } })).toThrow();
  });

  it('round-trips through its directory: atomic files, pruning, restart', async () => {
    const dir = tempDir();
    const host = makeHost({ history: { dir, maxSessions: 2 } });
    expect(host.history.limits.dir).toBe(dir);
    const played = [];
    for (let i = 0; i < 3; i++) played.push(await playAndRelease(host, i));
    await host.history.flush();
    expect(readdirSync(dir).sort()).toEqual([`${played[1]!.match.id}.json`, `${played[2]!.match.id}.json`].sort());
    const before = host.history.list();

    // Leftovers of a crash mid-write, a foreign file and an unreadable file do not break loading.
    writeFileSync(join(dir, `${played[0]!.match.id}.json.123.tmp`), '{');
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    writeFileSync(join(dir, 'broken.json'), '{');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restarted = makeHost({ history: { dir, maxSessions: 2 } });
    errors.mockRestore();
    expect(restarted.history.list()).toEqual(before);
    for (const p of played.slice(1)) expect(await restarted.history.replay(p.match.id)).toEqual(p.replay);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);

    // Bounds apply to what was loaded: a smaller budget prunes the files too.
    const smaller = makeHost({ history: { dir, maxSessions: 1 } });
    await smaller.history.flush();
    expect(smaller.history.list().map((r) => r.id)).toEqual([played[2]!.match.id]);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'broken.json')).toEqual([`${played[2]!.match.id}.json`]);
  });
});
