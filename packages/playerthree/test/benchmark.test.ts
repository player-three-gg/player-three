import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { benchmarkDigest, sealBenchmark, scoreBenchmark, validateBenchmarkPublication, validateBenchmarkSuite, type BenchmarkSuite, type BenchmarkRun, type BenchmarkPublication, type BenchmarkExperiment } from '../src/benchmark.ts';
import { importBenchmarkPublication, jsonBenchmarkStore, postgresBenchmarkStore } from '../src/benchmark-store.ts';
const hash = benchmarkDigest('test fixture only');
const suite = sealBenchmark<Omit<BenchmarkSuite, 'digest'>>({ id: 'fixture', version: 1, title: 'Synthetic contract fixture', track: 'authored-policy', game: 'fixture', gameVersion: '1', surfaceHash: hash, seriesDigest: hash, build: { gameDigest: hash, runnerDigest: hash }, roles: ['player'], references: [{ id: 'reference', digest: hash }], strata: [{ id: 'reference', weight: 1 }], blocks: [{ scenarioId: 'a', blockId: 'world-a', stratumId: 'reference' }, { scenarioId: 'b', blockId: 'world-b', stratumId: 'reference' }], evaluation: { permutations: ['first', 'second'], repetitions: 1 }, authoring: { replicates: 2, budgets: { maxTokens: 100, maxCostUsd: '1', maxTurns: 2 }, maxWallMs: 1000, practiceSeeds: [99] }, scoring: { method: 'weighted-score/1', timeout: 'draw', authoringFailure: 'zero' }, uncertainty: { method: 'crossed-run-block-bootstrap/1', seed: 42, replicates: 100 }, harness: { id: 'fixture', version: '1' } });
function run(index: number, failed = false): BenchmarkRun {
  return { id: `run-${index}`, index, status: failed ? 'failed' : 'evaluated', reason: failed ? 'no_artifact' : null, authoringAttempts: 1, artifactDigest: failed ? null : hash, seriesId: failed ? null : `series-${index}`, seriesRevision: failed ? null : 1, startedAt: '2000-01-01T00:00:00Z', finishedAt: '2000-01-01T00:00:01Z', cost: { scope: 'authoring-run', amount: null, currency: null, source: 'unknown', coverage: 'unknown', pricingVersion: null, pricedAt: null }, trials: failed ? [] : suite.blocks.flatMap(block => suite.evaluation.permutations.map(permutationId => ({ trialId: '', blockId: block.blockId, stratumId: block.stratumId, permutationId, status: 'win' as const, score: 1, attempts: 1 }))).map((t, i) => ({ ...t, trialId: `trial-${i}` })) };
}
function publication(runs = [run(0), run(1, true)]): BenchmarkPublication {
  const experiment = sealBenchmark<Omit<BenchmarkExperiment, 'digest'>>({ id: 'system', suiteDigest: suite.digest, executionDigest: hash, system: { id: 'system', label: 'Fixture', provider: null, model: null, harness: 'fixture/1', configurationDigest: hash }, replicates: 2, provenance: 'runner-observed' });
  return sealBenchmark({ format: 'playerthree.benchmark-publication' as const, version: 1 as const, id: 'fixture-publication', revision: 1 as const, publishedAt: '2000-01-01T00:00:02Z', suite, experiment, runs, score: scoreBenchmark(suite, runs), consent: { results: true as const, attribution: true, artifacts: false as const, research: true, training: false, license: 'CC0-1.0' }, retention: { policy: 'until-withdrawn' as const, withdrawalNotice: 'Downloaded copies cannot be recalled.' as const } });
}
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('scores failed authoring as zero with an equal run denominator and reproducible crossed uncertainty', () => {
  const p = publication();
  expect(p.score).toMatchObject({ complete: true, failedRuns: 1, value: .5, runScores: [1, 0], expectedTrials: 8, scoredTrials: 4, uncertainty: { blocks: 2, runs: 2 } });
  expect(p.score.interval).not.toBeNull();
  expect(scoreBenchmark(suite, p.runs)).toEqual(p.score);
  expect(validateBenchmarkPublication(p)).toEqual(p);
});
it('standalone scoring and import reject a dropped, duplicated or misidentified trial', () => {
  for (const mutation of ['drop', 'duplicate', 'block']) {
    const runs = [run(0), run(1)];
    if (mutation === 'drop') runs[0]!.trials.pop();
    if (mutation === 'duplicate') runs[0]!.trials[0] = { ...runs[0]!.trials[1]! };
    if (mutation === 'block') runs[0]!.trials[0]!.blockId = 'wrong';
    expect(scoreBenchmark(suite, runs)).toMatchObject({ complete: false, value: null });
    expect(() => validateBenchmarkPublication(publication(runs))).toThrow();
  }
});
it('preserves incomplete trials and unknown costs without an official score', () => {
  const runs = [run(0), run(1)];
  runs[0]!.trials[0] = { ...runs[0]!.trials[0]!, status: 'incomplete', score: null, attempts: 3 };
  const p = publication(runs);
  expect(validateBenchmarkPublication(p).score).toMatchObject({ complete: false, value: null, interval: null });
  expect(p.runs[0]!.cost.amount).toBeNull();
});
it('bounds schedule products before allocating or resampling them', () => {
  const { digest: _, ...body } = suite;
  const oversized = sealBenchmark({ ...body, evaluation: { ...suite.evaluation, repetitions: Number.MAX_SAFE_INTEGER } });
  expect(() => validateBenchmarkSuite(oversized)).toThrow('limits');
  expect(() => scoreBenchmark(oversized, [])).toThrow('limits');
});
it('rejects unconsented attribution, extra private fields, wrong hashes and wrong scores', () => {
  const p = publication();
  expect(() => validateBenchmarkPublication({ ...p, apiKey: 'must-not-publish' })).toThrow();
  const { digest: _, ...body } = p;
  expect(() => validateBenchmarkPublication(sealBenchmark({ ...body, consent: { ...p.consent, attribution: false } }))).toThrow('Attribution');
  const { digest: _experimentDigest, ...experiment } = p.experiment;
  const redacted = { ...experiment, id: 'anonymous', system: { ...experiment.system, id: 'anonymous', label: 'Anonymous system', provider: null, model: null } };
  const anonymous = (executionDigest: string | null) => sealBenchmark({ ...body, consent: { ...p.consent, attribution: false }, experiment: sealBenchmark({ ...redacted, executionDigest }) });
  expect(() => validateBenchmarkPublication(anonymous(hash))).toThrow('Attribution');
  expect(validateBenchmarkPublication(anonymous(null)).experiment.executionDigest).toBeNull();
  expect(() => validateBenchmarkPublication({ ...p, digest: '0'.repeat(64) })).toThrow('digest');
  expect(() => validateBenchmarkPublication(sealBenchmark({ ...body, score: { ...p.score, value: 1 } }))).toThrow('score');
});
it('retains immutable public evidence independently and makes withdrawal irreversible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'playerthree-publications-')); directories.push(directory);
  const store = jsonBenchmarkStore(directory); const p = publication();
  await importBenchmarkPublication(store, p);
  expect(await jsonBenchmarkStore(directory).get(p.id)).toEqual(p);
  expect(await store.list()).toEqual([p]);
  await expect(importBenchmarkPublication(store, { ...p, verified: true })).rejects.toThrow();
  await store.withdraw(p.id);
  expect(await store.get(p.id)).toBeNull();
  expect(await store.list()).toEqual([]);
  await expect(store.put(p)).rejects.toThrow('withdrawn');
});
it('atomically rejects competing cross-instance publication writers and honors early withdrawal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'playerthree-publication-race-')); directories.push(directory);
  const a = jsonBenchmarkStore(directory); const b = jsonBenchmarkStore(directory);
  const first = publication();
  const { digest: _, ...body } = first;
  const second = sealBenchmark({ ...body, publishedAt: '2000-01-02T00:00:02Z' });
  const results = await Promise.allSettled([a.put(first), b.put(second)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  await a.withdraw('not-yet-created');
  const later = sealBenchmark({ ...body, id: 'not-yet-created' });
  await expect(b.put(later)).rejects.toThrow('withdrawn');
  expect(await b.get('not-yet-created')).toBeNull();
});
it('checks PostgreSQL visibility even after immutable data has entered the validation cache', async () => {
  const p = publication(); let visible = true; let reads = 0;
  const store = postgresBenchmarkStore(async () => { reads++; return visible ? [{ id: p.id, digest: p.digest, publication: p }] : []; }, 'fixture');
  expect(await store.get(p.id)).toEqual(p);
  expect(await store.get(p.id)).toEqual(p);
  visible = false;
  expect(await store.get(p.id)).toBeNull();
  expect(await store.list()).toEqual([]);
  expect(reads).toBe(4);
});
