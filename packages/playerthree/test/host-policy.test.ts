import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { definition, EXAMPLE_POLICY, type TagManifest } from '../examples/tag/index.ts';
import { createPlayerThreeHost, memoryPoolStore } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeMatch, PlayerThreeTraceEvent } from '../src/host/types.ts';
import type { GameDefinition } from '../src/manifest.ts';
import { loadPolicy } from '../src/policy/index.ts';

let host: PlayerThreeHost<TagManifest>;
const dirs: string[] = [];
afterEach(() => {
  host?.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const js = (code: string) => ({ runtime: 'js' as const, code });
/** Moves the runner to (x, y) every call and logs a marker. */
const goTo = (x: number, y: number, marker = 'mine') => js(`function think(obs) { log('${marker}', obs.tick); return [{ kind: 'move', x: ${x}, y: ${y} }]; }`);

function idleMatch(opts: Parameters<PlayerThreeHost<TagManifest>['createMatch']>[0] = {}): PlayerThreeMatch<TagManifest> {
  host ??= createPlayerThreeHost({ definition });
  return host.createMatch({
    seed: 4,
    realtime: false,
    controllers: { blue: { runner: 'none', guard: 'none' }, red: { runner: 'none', guard: 'none' } },
    ...opts,
  });
}

const runnerPos = (match: PlayerThreeMatch<TagManifest>) => match.view('blue').pieces.find((p) => p.team === 'blue' && p.role === 'runner')!;

describe('policy deploy', () => {
  it('probes, versions, and only drives the seat while the controller is agent or policy', async () => {
    host = createPlayerThreeHost({ definition });
    const match = idleMatch();
    const seat = match.seat('blue', 'runner');
    const start = runnerPos(match);
    const d = await seat.policyDeploy(goTo(start.x, start.y > 7 ? 0 : 15));
    expect(d).toMatchObject({ ok: true, version: 1, probe: { calls: 1, errors: 0, intentsEmitted: 1, logs: ['mine 0'] } });

    await match.step(10);
    expect(runnerPos(match)).toMatchObject({ x: start.x, y: start.y }); // controller is 'none'

    match.setController('blue', 'runner', 'agent');
    await match.step(10);
    expect(runnerPos(match).y).not.toBe(start.y);
    const status = await seat.policyStatus();
    expect(status).toMatchObject({ version: 1, runtime: 'js', errors: 0, timeouts: 0 });
    if (!status || status.version === null) throw new Error('expected deployed policy');
    expect(status!.calls).toBeGreaterThanOrEqual(4);
    expect(status!.logs.at(-1)).toMatch(/^mine \d+$/);
    expect(match.seats().find((s) => s.team === 'blue' && s.role === 'runner')?.policyVersion).toBe(1);
  });

  it('seeds policy PRNGs from a value derived from the match seed, not the raw seed, deterministically', async () => {
    host = createPlayerThreeHost({ definition });
    const roll = 'function think() { log(String(Math.random())); return []; }';
    // The first draw of a fresh instance, through the probe (first loadArtifact site) and the live run (second site).
    const draws = async () => {
      const match = idleMatch({ seed: 4 });
      const seat = match.seat('blue', 'runner');
      const d = await seat.policyDeploy(js(roll));
      if (!d.ok) throw new Error(`deploy failed: ${JSON.stringify(d)}`);
      match.setController('blue', 'runner', 'agent');
      await match.step(10);
      const status = await seat.policyStatus();
      if (!status || status.version === null) throw new Error('expected deployed policy');
      return { probe: d.probe.logs[0], live: status.logs[0] };
    };
    const first = await draws();
    expect(first.probe).toMatch(/^0\.\d+$/);
    expect(first.live).toBe(first.probe);
    // A policy that knew the raw match seed could otherwise replay the sandbox PRNG; the derived seed hides it.
    const raw = await loadPolicy('js', roll, definition.manifest.control.policy!, { seed: 4 });
    if (!raw.ok) throw new Error(JSON.stringify(raw.error));
    const rawCall = await raw.instance.call({});
    raw.instance.dispose();
    if (!rawCall.ok) throw new Error(JSON.stringify(rawCall.error));
    expect(rawCall.value.logs[0]).toMatch(/^0\.\d+$/);
    expect(first.probe).not.toBe(rawCall.value.logs[0]);
    expect(await draws()).toEqual(first);
  });

  it('composes `include`d skill files into the probed, stored and size-checked artifact', async () => {
    const store = memoryPoolStore();
    host = createPlayerThreeHost({ definition, poolStore: store });
    const match = idleMatch();
    const seat = match.seat('blue', 'runner');
    const include = ['tag-strategy/policies/simple.js'];
    expect(await seat.policyDeploy({ runtime: 'js', code: "log('own');", include })).toMatchObject({ ok: true, version: 1 });
    const { policyId } = (await seat.publish()) as { policyId: string };
    expect((await store.loadArtifact(policyId))?.code).toBe(`${EXAMPLE_POLICY}\nlog('own');`);
    // The limit applies to the composed source: own code that fits alone is too large with its includes.
    const limit = definition.manifest.control.policy.maxArtifactBytes;
    expect(await seat.policyDeploy({ runtime: 'js', code: `//${'x'.repeat(limit - 10)}`, include })).toEqual({ ok: false, error: { code: 'too_large' } });
    await expect(seat.policyDeploy({ runtime: 'js', code: '//', include: ['tag-strategy/SKILL.md'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(seat.policyDeploy({ runtime: 'wasm', code: 'AGFzbQEAAAA=', include })).rejects.toMatchObject({ code: 'invalid' });
    expect(await seat.practice({ opponent: 'idle', ticks: 5, artifact: { runtime: 'js', code: '//', include } })).toMatchObject({ ok: true });
  });

  it('policy seats observe the same start-of-tick world as bots, before any bot intent lands', async () => {
    const log: { tick: number; call: 'observe' | 'apply' }[] = [];
    const spied: GameDefinition<TagManifest> = {
      ...definition,
      create: (opts) => {
        const game = definition.create(opts);
        const observe = game.observe.bind(game);
        const apply = game.apply.bind(game);
        game.observe = (seat, since, detail) => (log.push({ tick: game.tick, call: 'observe' }), observe(seat, since, detail));
        game.apply = (seat, intent) => (log.push({ tick: game.tick, call: 'apply' }), apply(seat, intent));
        return game;
      },
    };
    host = createPlayerThreeHost({ definition: spied });
    const match = idleMatch({ controllers: { blue: { runner: 'bot', guard: 'bot' }, red: { runner: 'agent', guard: 'none' } }, botLevel: { blue: 'hard', red: 'hard' } });
    expect(await match.seat('red', 'runner').policyDeploy(goTo(0, 0))).toMatchObject({ ok: true });
    log.length = 0;
    await match.step(40);
    const ticks = [...new Set(log.filter((l) => l.call === 'apply').map((l) => l.tick))];
    expect(ticks.length).toBeGreaterThan(1);
    for (const tick of ticks) {
      const round = log.filter((l) => l.tick === tick);
      expect(round.filter((l) => l.call === 'observe')).toHaveLength(3);
      expect(round.findIndex((l) => l.call === 'apply')).toBe(3);
    }
  });

  it('rejects a deploy whose probe fails and keeps the working version; rollback restores old versions', async () => {
    host = createPlayerThreeHost({ definition });
    const match = idleMatch();
    const seat = match.seat('blue', 'runner');
    expect(await seat.policyDeploy(goTo(1, 1))).toMatchObject({ ok: true, version: 1 });
    expect(await seat.policyDeploy(goTo(2, 2))).toMatchObject({ ok: true, version: 2 });

    const broken = await seat.policyDeploy(js('function think(obs) { throw new Error("boom: " + obs.tick); }'));
    expect(broken).toMatchObject({ ok: false, error: { code: 'threw' } });
    expect((broken as { error: { message?: string } }).error.message).toContain('boom: 0');
    expect(await seat.policyDeploy(js('this is not javascript'))).toMatchObject({ ok: false, error: { code: 'compile' } });
    expect(await seat.policyDeploy(js('x'.repeat(70_000)))).toEqual({ ok: false, error: { code: 'too_large' } });
    expect(await seat.policyDeploy({ runtime: 'wasm', code: '***' })).toEqual({ ok: false, error: { code: 'bad_module' } });
    await expect(seat.policyDeploy({ runtime: 'lua', code: 'x' } as never)).rejects.toMatchObject({ code: 'invalid' });
    expect((await seat.policyStatus())!.version).toBe(2);

    expect(await seat.policyRollback(1)).toMatchObject({ ok: true, version: 1 });
    expect((await seat.policyStatus())!.version).toBe(1);
    await expect(seat.policyRollback(3)).rejects.toMatchObject({ code: 'invalid' });
    // The next deploy continues the numbering.
    expect(await seat.policyDeploy(goTo(3, 3))).toMatchObject({ ok: true, version: 3 });
  });

  // 12 deploys (11 + rollback), each spawning two sandbox workers; give it room on a heavily loaded box.
  it('keeps at most 10 versions', { timeout: 60_000 }, async () => {
    host = createPlayerThreeHost({ definition });
    const seat = idleMatch().seat('red', 'guard');
    for (let v = 1; v <= 11; v++) expect(await seat.policyDeploy(goTo(10, v))).toMatchObject({ ok: true, version: v });
    await expect(seat.policyRollback(1)).rejects.toMatchObject({ code: 'invalid' });
    expect(await seat.policyRollback(2)).toMatchObject({ ok: true, version: 2 });
  });

  it('policy output is validated like agent intents and budgeted per call', async () => {
    host = createPlayerThreeHost({ definition });
    const match = idleMatch({ controllers: { blue: { guard: 'agent' } } });
    const seat = match.seat('blue', 'guard');
    const spam = js(`var calls = 0; function think() { if (++calls === 1) return []; var out = [{ kind: 'dash' }, { kind: 'move', x: 99, y: 0 }, { kind: 'stop', why: 'x' }]; for (var i = 0; i < 10; i++) out.push({ kind: 'stop' }); return out; }`);
    expect(await seat.policyDeploy(spam)).toMatchObject({ ok: true });
    await match.step(10);
    const s = (await seat.policyStatus())!;
    if (s.version === null) throw new Error('expected deployed policy');
    const rejected = Object.fromEntries(s.intentsRejected.map((r) => [r.code, r.count]));
    expect(rejected.forbidden_role).toBeGreaterThan(0);
    expect(rejected.invalid).toBeGreaterThan(0);
    expect(rejected.too_many).toBeGreaterThan(0);
    // The most recent schema-invalid intent of each call (the move's range failure comes first).
    expect(s.lastInvalid).toEqual({ schemaCode: 'unknown_field', path: ['?'], expected: 'StopIntent: { kind }' });
    expect(s.intentsEmitted).toBe((s.calls - 1) * 4);
  });

  // The deploy probe plus up to three restarts each load a fresh sandbox (0.5–0.9 s apiece at load average ~20).
  it('an infinite loop times out without stalling the match', { timeout: 30_000 }, async () => {
    host = createPlayerThreeHost({ definition });
    const match = idleMatch({ controllers: { blue: { runner: 'agent' } } });
    const seat = match.seat('blue', 'runner');
    const looping = js(`var n = 0; function think(obs) { n++; if (n > 1) { while (true) {} } return []; }`);
    expect(await seat.policyDeploy(looping)).toMatchObject({ ok: true });
    await match.step(40);
    expect(match.tick).toBe(40);
    const s = (await seat.policyStatus())!;
    if (s.version === null) throw new Error('expected deployed policy');
    expect(s.timeouts).toBeGreaterThan(0);
    expect(s.lastError?.code).toBe('timeout');
  });
});

describe('practice', () => {
  it('runs a headless match and returns the report, policy stats and logs', async () => {
    host = createPlayerThreeHost({ definition });
    const traces: PlayerThreeTraceEvent[] = [];
    host.onTrace((e) => traces.push(e));
    const seat = idleMatch().seat('blue', 'runner');
    const r = await seat.practice({ opponent: 'easy', ticks: 1200, seed: 1, artifact: js(EXAMPLE_POLICY) });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.code);
    expect(r.outcome).toBe('win');
    expect(r.ticks).toBeLessThan(1200);
    expect(r.report).toMatchObject({ outcome: 'win', captures: 3 });
    expect(r.policy).toMatchObject({ version: 0, runtime: 'js', errors: 0, timeouts: 0 });
    expect(r.policy.calls).toBeGreaterThan(50);
    expect(r.policy.logs.length).toBeGreaterThan(0);
    expect(r.wallMs).toBeGreaterThanOrEqual(0);
    expect(traces.find((e) => e.type === 'practice')).toMatchObject({ team: 'blue', role: 'runner', opponent: 'easy', allies: 'easy', seed: 1, result: r });

    // Same seed + same policy → same result.
    const again = await seat.practice({ opponent: 'easy', ticks: 1200, seed: 1, artifact: js(EXAMPLE_POLICY) });
    if (!again.ok) throw new Error(again.code);
    expect(again.report).toEqual(r.report);
  });

  it('defaults to the deployed policy, reports compile errors, and validates the request', async () => {
    host = createPlayerThreeHost({ definition });
    const seat = idleMatch().seat('red', 'runner');
    await expect(seat.practice({ opponent: 'hard', ticks: 100 })).rejects.toMatchObject({ code: 'invalid' });
    await seat.policyDeploy(js(EXAMPLE_POLICY));
    const r = await seat.practice({ opponent: 'hard', ticks: 100, seed: 2 });
    expect(r).toMatchObject({ ticks: 100, outcome: 'running', policy: { version: 1 } });
    const bad = await seat.practice({ opponent: 'idle', ticks: 100, artifact: js('function think( {') });
    expect(bad).toMatchObject({ ok: false, code: 'policy', policy: { errors: 1, lastError: { code: 'compile' } } });
    expect(bad).not.toHaveProperty('report');
    await expect(seat.practice({ opponent: 'godlike', ticks: 100 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(seat.practice({ opponent: 'idle', ticks: 1201 })).rejects.toMatchObject({ code: 'invalid' });
  });

  it.each(['observation', 'report'] as const)('returns a closed guard failure for invalid %s', async (channel) => {
    const badDefinition: GameDefinition<TagManifest> = {
      ...definition,
      create: (options) => {
        const adapter = definition.create(options);
        if (channel === 'observation') adapter.observe = () => ({ injected: 'untrusted' }) as never;
        else adapter.report = () => ({ injected: 'untrusted' }) as never;
        return adapter;
      },
    };
    host = createPlayerThreeHost({ definition: badDefinition });
    const result = await idleMatch().seat('blue', 'runner').practice({ opponent: 'idle', ticks: 1, artifact: js('function think() { return []; }') });
    expect(result).toMatchObject({ ok: false, code: 'guard' });
    expect(result).not.toHaveProperty('report');
    expect(JSON.stringify(result)).not.toContain('untrusted');
  });

  it('limits concurrent practice per principal and does not starve the live match', async () => {
    host = createPlayerThreeHost({ definition });
    const match = idleMatch();
    match.setController('blue', 'runner', 'agent');
    const agent = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
    await agent.policyDeploy(js(EXAMPLE_POLICY));
    const runs = [1, 2].map((seed) => agent.practice({ opponent: 'hard', ticks: 1200, seed }));
    await expect(agent.practice({ opponent: 'hard', ticks: 10 })).rejects.toMatchObject({ code: 'busy' });
    // The owner is a different principal with its own budget.
    const owner = match.seat('blue', 'runner').practice({ opponent: 'idle', ticks: 10 });
    let liveTicks = 0;
    const live = (async () => {
      while (liveTicks < 20) {
        await match.step(1);
        liveTicks++;
      }
    })();
    // The live match finished its ticks while the long practice runs were still going.
    const liveWhenPracticeDone = await Promise.all(runs).then(() => liveTicks);
    await Promise.all([owner, live]);
    expect(liveWhenPracticeDone).toBe(20);
    expect(await agent.practice({ opponent: 'idle', ticks: 10 })).toMatchObject({ ok: true, ticks: 10 });
  });
});

describe('pool', () => {
  it('publish → draft into a policy seat → W/L recorded at match end, persisted to poolDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'playerthree-pool-'));
    dirs.push(dir);
    host = createPlayerThreeHost({ definition, poolDir: dir });
    const author = idleMatch().seat('red', 'runner');
    await expect(author.publish()).rejects.toMatchObject({ code: 'invalid' });
    await author.policyDeploy(js(EXAMPLE_POLICY));
    const published = await author.publish();
    if (!('policyId' in published)) throw new Error('expected published policy');
    const { policyId } = published;
    expect(policyId).toMatch(/^pol_\d{9}$/);
    expect(host.pool.list('runner')).toEqual([expect.objectContaining({ id: policyId, game: 'tag', role: 'runner', runtime: 'js', wins: 0, losses: 0, draws: 0 })]);
    expect(host.pool.list('guard')).toEqual([]);
    expect(host.pool.draft('runner')?.id).toBe(policyId);
    expect(readdirSync(dir).sort()).toEqual([`${policyId}.json`, 'pool.json']);
    expect(JSON.parse(readFileSync(join(dir, 'pool.json'), 'utf8')).entries[0].owner).toBeTypeOf('string');
    expect(host.pool.list()[0]).not.toHaveProperty('owner');

    // A human-less async match: the drafted pool policy plays red's runner against blue's easy bots.
    const traces: PlayerThreeTraceEvent[] = [];
    host.onTrace((e) => traces.push(e));
    const match = host.createMatch({ seed: 1, realtime: false, controllers: { red: { runner: 'policy', guard: 'bot' } }, botLevel: { blue: 'easy', red: 'easy' } });
    expect(match.seats().find((s) => s.team === 'red' && s.role === 'runner')).toMatchObject({ controller: 'policy', poolPolicy: policyId });
    let ended: Record<string, string> | undefined;
    match.onEnd((o) => (ended = o));
    await match.step(1200);
    expect(ended).toEqual({ blue: 'loss', red: 'win' });
    expect(host.pool.list('runner')[0]).toMatchObject({ wins: 1, losses: 0, draws: 0 });

    // Another player's code: its log text never reaches this match's trace or the seat's own status.
    const calls = traces.filter((e) => e.type === 'policy_call');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((e) => e.type === 'policy_call' && e.pool && e.logs.length === 0)).toBe(true);
    expect(await match.seat('red', 'runner').policyStatus()).toBeNull();

    // Reloaded from disk by a fresh host.
    host.dispose();
    host = createPlayerThreeHost({ definition, poolDir: dir });
    expect(host.pool.list()).toEqual([expect.objectContaining({ id: policyId, wins: 1 })]);
    const again = host.createMatch({ seed: 2, realtime: false });
    again.setController('red', 'runner', 'policy', { poolPolicy: policyId });
    await again.step(20);
    expect(again.seats().find((s) => s.team === 'red' && s.role === 'runner')?.poolPolicy).toBe(policyId);
  });

  it('enforces the per-principal publish limit and role-matching drafts', async () => {
    host = createPlayerThreeHost({ definition });
    const match = idleMatch();
    const seat = match.seat('blue', 'guard');
    await seat.policyDeploy(goTo(3, 3));
    for (let i = 0; i < 3; i++) await seat.publish();
    await expect(seat.publish()).rejects.toMatchObject({ code: 'forbidden' });
    const id = host.pool.list('guard')[0]!.id;
    expect(() => match.setController('blue', 'runner', 'policy', { poolPolicy: id })).toThrow();
    expect(() => match.setController('blue', 'runner', 'policy')).toThrow();
    match.setController('red', 'guard', 'policy');
    expect(match.seats().find((s) => s.team === 'red' && s.role === 'guard')?.poolPolicy).toMatch(/^pol_/);
  });

  it('operators see publishers and draft counts, disable and unpublish entries (persisted)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'playerthree-pool-'));
    dirs.push(dir);
    host = createPlayerThreeHost({ definition, poolDir: dir });
    const author = idleMatch();
    const seat = author.seat('red', 'runner');
    await seat.policyDeploy(js(EXAMPLE_POLICY));
    const first = await seat.publish();
    const second = await seat.publish();
    if (!('policyId' in first) || !('policyId' in second)) throw new Error('expected published policies');
    expect(host.pool.entries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.policyId, publisher: { kind: 'session', session: author.id, team: 'red' }, disabled: false, drafts: 0 }),
    ]));
    expect(host.pool.draft('runner')).toBeDefined();
    expect(host.pool.entries().reduce((n, e) => n + e.drafts, 0)).toBe(1);

    // Disabled: listed for operators only, never drafted or selectable.
    expect(host.pool.setDisabled(first.policyId, true)).toMatchObject({ id: first.policyId, disabled: true });
    expect(host.pool.list().map((e) => e.id)).toEqual([second.policyId]);
    for (let i = 0; i < 10; i++) expect(host.pool.draft('runner')?.id).toBe(second.policyId);
    const match = idleMatch();
    expect(() => match.setController('red', 'runner', 'policy', { poolPolicy: first.policyId })).toThrow();
    expect(host.pool.setDisabled('pol_1', true)).toBeUndefined();

    // Unpublished: gone with its artifact.
    expect(host.pool.unpublish(second.policyId)).toBe(true);
    expect(host.pool.unpublish(second.policyId)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([`${first.policyId}.json`, 'pool.json']);
    expect(host.pool.draft('runner')).toBeUndefined();

    host.dispose();
    host = createPlayerThreeHost({ definition, poolDir: dir });
    expect(host.pool.entries()).toEqual([expect.objectContaining({ id: first.policyId, disabled: true, drafts: expect.any(Number) })]);
    expect(host.pool.setDisabled(first.policyId, false)).toMatchObject({ disabled: false });
    expect(host.pool.draft('runner')?.id).toBe(first.policyId);
  });
});
