import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { replayMatch, type Replay } from 'playerthree/host';
import { binomialTwoSided, createGameMatchHost, evaluateGuardrails, runBench, snapshotMetrics, type Guardrail } from '../src/index.ts';
import { definition } from './bots-fixture.ts';
import { fixture } from './series-fixture.ts';
import { quadBots, quadSeries } from './quad-bots-fixture.ts';

const TRUESKILL = { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: 0.1 } as const;

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'playerthree-series-')); directories.push(path); return path; }

describe('headless common series runner', { timeout: 30000 }, () => {
  it('preserves explicit seed/permutation order, native cadence, metrics and replay', async () => {
    const outDir = await directory();
    const results = await runBench(fixture(), { outDir });
    expect(results.format).toBe('playerthree.results');
    expect(results.tables.schedule.map((trial) => [trial.seed, trial.sideBindings[0]!.entrantId])).toEqual([[3, 'entrant-0'], [3, 'entrant-1'], [4, 'entrant-0'], [4, 'entrant-1']]);
    expect(results.tables.matches.every((match) => match.status === 'finished' && match.ticks === 4)).toBe(true);
    expect(results.tables.usage).toEqual([]);
    expect(results.tables.metrics.filter((row) => row.metric === 'collected').map((row) => row.value)).toEqual([4, 4, 4, 4]);
    expect(results.tables.metrics.filter((row) => row.metric === 'tickSum').map((row) => row.value)).toEqual([10, 10, 10, 10]);
    for (const artifact of results.tables.artifacts) {
      const replay = JSON.parse(await readFile(join(outDir, 'artifacts', `${encodeURIComponent(artifact.id)}.json`), 'utf8')) as Replay;
      expect(replayMatch(definition, replay).outcomes).toEqual(replay.outcomes);
    }
    expect(JSON.parse(await readFile(join(outDir, 'results.json'), 'utf8'))).toEqual(results);
    for (const table of Object.keys(results.tables)) expect(await readFile(join(outDir, 'csv', `${table}.csv`), 'utf8')).toContain('\n');
  });

  it('preserves sandbox policy execution, bootstrap and exact policy counters', async () => {
    const config = fixture();
    const role = definition.manifest.roles.values[0]!;
    config.spec = { ...config.spec, entrantSeats: config.spec.entrants.map((entrant, index) => ({ entrantId: entrant.id, seats: definition.manifest.roles.values.map((seatRole) => ({ role: seatRole, occupant: index === 0 && seatRole === role ? { kind: 'commander' as const, ref: { id: entrant.id, kind: 'policy' as const } } : { kind: 'bot' as const, level: 'idle', options: {} } })) })) };
    config.policies = { 'entrant-0': { [role]: { runtime: 'js', code: 'var match; function init(data){if(match)throw Error("repeated init");match=data;} function think(obs){if(obs.match||!match)throw Error("bootstrap");return [{kind:"increment",amount:match.increment}];}' } } };
    const results = await runBench(config, { outDir: await directory() });
    expect(results.tables.seats.filter((seat) => seat.executionKind === 'policy')).toHaveLength(4);
    expect(results.tables.metrics.filter((row) => row.metric === 'policy.errors').every((row) => row.value === 0)).toBe(true);
    expect(results.tables.metrics.filter((row) => row.metric === 'policy.calls').every((row) => row.value > 0)).toBe(true);
  });

  it('never turns a tick cap or owner abort into a rated draw', async () => {
    const config = fixture();
    config.spec = { ...config.spec, execution: { ...config.spec.execution, maxTicks: 1 } };
    const results = await runBench(config, { outDir: await directory() });
    expect(results.tables.matches.every((match) => match.status === 'aborted' && match.outcomes.every((outcome) => outcome.outcome === 'aborted'))).toBe(true);
    expect(results.tables.standings.every((standing) => standing.draws === 0)).toBe(true);
    const adapter = createGameMatchHost(definition, config);
    const bound = await adapter.binder.bind('abort_owner', config.spec.template, { attemptId: 'abort-attempt', reset: true, signal: new AbortController().signal });
    const execution = await adapter.host.create(config.spec.template, { attemptId: 'abort-attempt', bindings: bound.seats, signal: new AbortController().signal, execution: config.spec.execution, telemetry: config.spec.telemetry, budgets: config.spec.budgets, emitMetric: async () => {}, emitEvent: async () => {}, emitChunk: async () => {} });
    try { await execution.abort('owner'); expect((await execution.finished).terminal).toBe('aborted'); }
    finally { await execution.dispose(); await bound.release(); await adapter.close(); }
  });

  it('evaluates logical entrant and physical team guardrails from canonical rows', async () => {
    const results = await runBench(fixture(), { outDir: await directory() });
    const base: Guardrail = { id: 'band', scope: 'match', metric: 'ticks', aggregation: 'median', comparator: 'between', threshold: [4, 4] };
    const guards = evaluateGuardrails(results, [base, { ...base, id: 'wins', scope: 'entrant:entrant-0', metric: 'outcome.win', aggregation: 'mean', comparator: '==', threshold: 1 }, { ...base, id: 'bias', scope: 'team:blue', metric: 'outcome.win', aggregation: 'binomialTwoSided', comparator: '>=', threshold: 0.05 }, { ...base, id: 'missing', metric: 'not.recorded' }]);
    expect(guards.map((guard) => guard.passed)).toEqual([true, true, true, false]);
    expect(guards[3]).toMatchObject({ value: null, reason: 'missing metric' });
  });
  it('runs config arrays as separate series and exits nonzero on failed guardrails', async () => {
    const outDir = await directory();
    const path = join(outDir, 'array.config.ts');
    await writeFile(path, `import {fixture} from ${JSON.stringify(new URL('./series-fixture.ts', import.meta.url).href)};
const first=fixture(), second=fixture();
second.guardrails=[{id:'impossible',scope:'entrant:entrant-0',metric:'outcome.win',aggregation:'mean',comparator:'==',threshold:2}];
export default [first,second];
`);
    const child = spawnSync(process.execPath, [new URL('../bin/playerthree-bench.ts', import.meta.url).pathname, '--config', path, '--out', outDir], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(1);
    expect(child.stdout).toContain('INVALID');
    const first = JSON.parse(await readFile(join(outDir, 'series-1', 'results.json'), 'utf8'));
    const second = JSON.parse(await readFile(join(outDir, 'series-2', 'results.json'), 'utf8'));
    expect(first.format).toBe('playerthree.results');
    expect(second.seriesId).not.toBe(first.seriesId);
    expect(JSON.parse(await readFile(join(outDir, 'series-2', 'guardrails.json'), 'utf8'))[0].passed).toBe(false);
  });
});

describe('team subsets and alliances', { timeout: 30000 }, () => {
  it('plays two sides of a four-team game and rejects unknown sides', async () => {
    const outDir = await directory();
    const config = quadSeries([{ team: 'north', alliance: 'north' }, { team: 'east', alliance: 'east' }], ['hard', 'idle'], { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 });
    const results = await runBench(config, { outDir });
    expect(results.tables.matches).toHaveLength(4);
    for (const match of results.tables.matches) {
      expect(match.status).toBe('finished');
      expect(match.outcomes.map((row) => row.team)).toEqual(['north', 'east']);
      expect(match.outcomes.map((row) => row.rank).sort()).toEqual([1, 2]);
    }
    for (const artifact of results.tables.artifacts) {
      const replay = JSON.parse(await readFile(join(outDir, 'artifacts', `${encodeURIComponent(artifact.id)}.json`), 'utf8')) as Replay;
      expect(replay.teams).toEqual(['north', 'east']);
      expect(replay.alliances).toBeUndefined();
      expect(replayMatch(quadBots, replay).outcomes).toEqual(replay.outcomes);
    }
    const standings = new Map(results.tables.standings.map((row) => [row.entrantId, row]));
    expect(standings.get('entrant-0')).toMatchObject({ wins: 4, losses: 0 });
    expect(standings.get('entrant-1')).toMatchObject({ wins: 0, losses: 4 });
    const adapter = createGameMatchHost(quadBots, config);
    try {
      const template = config.spec.template;
      await expect(adapter.host.resolve({ ...template, sides: [template.sides[0]!, { ...template.sides[1]!, id: 'mars' }] })).rejects.toThrow('unsupported physical sides');
      await expect(adapter.host.resolve({ ...template, sides: [template.sides[0]!, template.sides[0]!] })).rejects.toThrow('unsupported physical sides');
    } finally { await adapter.close(); }
  });

  it('rates a 2v2 alliance series with allies sharing outcome and rank', async () => {
    const outDir = await directory();
    const sides = [{ team: 'north', alliance: 'gold' }, { team: 'east', alliance: 'gold' }, { team: 'south', alliance: 'jade' }, { team: 'west', alliance: 'jade' }];
    const results = await runBench(quadSeries(sides, ['hard', 'normal', 'easy', 'idle'], TRUESKILL), { outDir });
    expect(results.tables.matches).toHaveLength(8);
    for (const match of results.tables.matches) {
      expect(match.status).toBe('finished');
      const row = Object.fromEntries(match.outcomes.map((outcome) => [outcome.team, outcome]));
      expect([row.north!.outcome, row.north!.rank]).toEqual([row.east!.outcome, row.east!.rank]);
      expect([row.south!.outcome, row.south!.rank]).toEqual([row.west!.outcome, row.west!.rank]);
    }
    for (const artifact of results.tables.artifacts) {
      const replay = JSON.parse(await readFile(join(outDir, 'artifacts', `${encodeURIComponent(artifact.id)}.json`), 'utf8')) as Replay;
      expect(replay.alliances).toEqual({ gold: ['north', 'east'], jade: ['south', 'west'] });
    }
    const mu = new Map(results.tables.standings.map((row) => [row.entrantId, row.mu!]));
    expect(mu.get('entrant-0')!).toBeGreaterThan(mu.get('entrant-3')!);
  });

  it('orders a free-for-all by placement through TrueSkill', async () => {
    const sides = ['north', 'east', 'south', 'west'].map((team) => ({ team, alliance: team }));
    const results = await runBench(quadSeries(sides, ['hard', 'normal', 'easy', 'idle'], TRUESKILL), { outDir: await directory() });
    expect(results.tables.matches).toHaveLength(8);
    for (const match of results.tables.matches) {
      expect(match.status).toBe('finished');
      expect(match.outcomes.map((row) => row.rank).sort()).toEqual([1, 2, 3, 4]);
      expect(match.outcomes.map((row) => row.rank === 1 ? 'win' : 'loss')).toEqual(match.outcomes.map((row) => row.outcome));
    }
    const ranked = [...results.tables.standings].sort((a, b) => b.mu! - a.mu!).map((row) => row.entrantId);
    expect(ranked).toEqual(['entrant-0', 'entrant-1', 'entrant-2', 'entrant-3']);
  });
});

it('snapshots finite game metrics and retains exact fair-coin tails', () => {
  const raw = { match: { count: 1 }, sides: { blue: { score: 2 } } };
  const copy = snapshotMetrics(raw, ['blue', 'red']);
  raw.match.count = 99;
  expect(copy.match.count).toBe(1);
  expect(copy.sides.red).toEqual({});
  expect(() => snapshotMetrics({ match: { count: Infinity }, sides: {} }, [])).toThrow('finite');
  expect(() => snapshotMetrics({ match: {}, sides: { unknown: {} } }, ['blue'])).toThrow('unknown team');
  expect(binomialTwoSided(0, 4)).toBeCloseTo(0.125);
  expect(binomialTwoSided(1000, 2000)).toBeCloseTo(1);
});
