/**
 * `playerthree/benchmark`: fixed-reference benchmark suites and publications (SPEC §20 *Fixed-reference benchmark
 * publications*) — types, digests and sealing, weighted scoring with a crossed run × block bootstrap, and validation.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './briefing.ts';
import type { SeriesSpec } from './arena.ts';

export interface BenchmarkSuite {
  id: string; version: number; title: string; track: 'authored-policy' | 'submitted-policy';
  game: string; gameVersion: string; surfaceHash: string; seriesDigest: string;
  build: { gameDigest: string; runnerDigest: string };
  roles: string[]; references: { id: string; digest: string }[];
  strata: { id: string; weight: number }[];
  blocks: { scenarioId: string; blockId: string; stratumId: string }[];
  evaluation: { permutations: string[]; repetitions: number };
  authoring: { replicates: number; budgets: SeriesSpec['budgets']; maxWallMs: number; practiceSeeds: number[] };
  scoring: { method: 'weighted-score/1'; timeout: 'draw'; authoringFailure: 'zero' };
  uncertainty: { method: 'crossed-run-block-bootstrap/1'; seed: number; replicates: number };
  harness: { id: string; version: string }; digest: string;
}
export interface BenchmarkExperiment {
  /** Null in anonymous exports: a digest of a guessable provider/model/price configuration re-identifies it. */
  id: string; suiteDigest: string; executionDigest: string | null;
  system: { id: string; label: string; provider: string | null; model: string | null; harness: string; configurationDigest: string };
  replicates: number; provenance: 'runner-observed' | 'submitted-artifact'; digest: string;
}
export interface BenchmarkCost {
  scope: 'authoring-run'; amount: string | null; currency: 'USD' | null;
  source: 'router-reported' | 'runner-estimate' | 'unknown'; coverage: 'complete' | 'partial' | 'unknown';
  pricingVersion: string | null; pricedAt: string | null;
}
export interface BenchmarkTrial {
  trialId: string; blockId: string; stratumId: string; permutationId: string;
  status: 'win' | 'draw' | 'loss' | 'forfeit' | 'timeout' | 'incomplete'; score: number | null; attempts: number;
}
export interface BenchmarkRun {
  id: string; index: number; status: 'pending' | 'authoring' | 'frozen' | 'failed' | 'evaluated'; reason: string | null;
  /** Authoring attempts started for this replicate; infrastructure failures re-author it within the frozen retry limit. */
  authoringAttempts: number;
  artifactDigest: string | null; seriesId: string | null; seriesRevision: number | null;
  trials: BenchmarkTrial[]; cost: BenchmarkCost; startedAt: string | null; finishedAt: string | null;
}
export interface BenchmarkScore {
  complete: boolean; expectedRuns: number; completedRuns: number; failedRuns: number;
  expectedTrials: number; scoredTrials: number; value: number | null; runScores: (number | null)[];
  interval: [number, number] | null;
  uncertainty: { method: 'crossed-run-block-bootstrap/1'; seed: number; replicates: number; blocks: number; runs: number };
}
export interface BenchmarkPublication {
  format: 'playerthree.benchmark-publication'; version: 1; id: string; revision: 1; publishedAt: string;
  suite: BenchmarkSuite; experiment: BenchmarkExperiment; runs: BenchmarkRun[]; score: BenchmarkScore;
  consent: { results: true; attribution: boolean; artifacts: false; research: boolean; training: boolean; license: string };
  retention: { policy: 'until-withdrawn'; withdrawalNotice: 'Downloaded copies cannot be recalled.' }; digest: string;
}
/** SHA-256 hex of the canonical JSON of `value`. */
export function benchmarkDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
/** `value` plus `digest`, the {@link benchmarkDigest} of `value` (which must not carry a digest yet). */
export function sealBenchmark<T extends object>(value: T): T & { digest: string } { return { ...value, digest: benchmarkDigest(value) }; }
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
/** Explicit blocks preserve all mirrors; the same sampled blocks are shared across sampled runs. */
export function scoreBenchmark(suite: BenchmarkSuite, runs: readonly BenchmarkRun[]): BenchmarkScore {
  validateBenchmarkSuite(suite);
  if (runs.length > 100) throw new Error('Benchmark run limit exceeded');
  const expectedRuns = suite.authoring.replicates;
  const expectedPerRun = suite.blocks.length * suite.evaluation.permutations.length * suite.evaluation.repetitions;
  const expected = new Map<string, string>();
  for (const block of suite.blocks) for (const permutation of suite.evaluation.permutations) for (let i = 0; i < suite.evaluation.repetitions; i++) expected.set(`trial-${expected.size}`, canonicalJson([block.blockId, block.stratumId, permutation]));
  const weights = suite.strata.reduce((n, s) => n + s.weight, 0);
  const blocks = [...new Set(suite.blocks.map(b => b.blockId))].sort();
  const aggregates = runs.map(run => {
    check(run, runShape, 'run');
    if (run.status === 'failed' && (run.artifactDigest !== null || run.seriesId !== null || run.trials.length !== 0)) throw new Error('Failed authoring cannot have evaluation evidence');
    if (run.trials.length > expectedPerRun) throw new Error('Benchmark trial limit exceeded');
    const valid = run.status === 'evaluated' && run.trials.length === expectedPerRun && new Set(run.trials.map(t => t.trialId)).size === expectedPerRun && run.trials.every(t => expected.get(t.trialId) === canonicalJson([t.blockId, t.stratumId, t.permutationId]) && t.score !== null && t.score === (t.status === 'win' ? 1 : ['draw', 'timeout'].includes(t.status) ? .5 : ['loss', 'forfeit'].includes(t.status) ? 0 : null));
    const strata = new Map<string, Map<string, { sum: number; count: number }>>();
    if (valid) for (const trial of run.trials) {
      const cells = strata.get(trial.stratumId) ?? new Map<string, { sum: number; count: number }>();
      const cell = cells.get(trial.blockId) ?? { sum: 0, count: 0 };
      cell.sum += trial.score!; cell.count++; cells.set(trial.blockId, cell); strata.set(trial.stratumId, cells);
    }
    return { run, valid, strata };
  });
  const complete = runs.length === expectedRuns && new Set(runs.map(r => r.id)).size === runs.length && runs.every((r, i) => r.index === i) && aggregates.every(a => a.run.status === 'failed' || a.valid);
  const valueFor = (index: number, counts?: Map<string, number>): number | null => {
    const aggregate = aggregates[index]!;
    if (aggregate.run.status === 'failed') return 0;
    if (!aggregate.valid) return null;
    let sum = 0;
    for (const stratum of suite.strata) {
      let total = 0; let n = 0;
      for (const [block, cell] of aggregate.strata.get(stratum.id) ?? []) {
        const count = counts ? counts.get(block) ?? 0 : 1;
        total += cell.sum * count; n += cell.count * count;
      }
      if (!n) return null;
      sum += total / n * stratum.weight / weights;
    }
    return sum;
  };
  const runScores = runs.map((_, i) => valueFor(i));
  const value = complete ? mean(runScores as number[]) : null;
  let interval: [number, number] | null = null;
  if (complete && runs.length > 1 && blocks.length > 1) {
    let state = suite.uncertainty.seed >>> 0;
    const random = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 4294967296 * n); };
    const samples: number[] = [];
    const groups = new Map<string, string[]>();
    for (const block of blocks) {
      const key = canonicalJson([...new Set(suite.blocks.filter(b => b.blockId === block).map(b => b.stratumId))].sort());
      groups.set(key, [...(groups.get(key) ?? []), block]);
    }
    for (let i = 0; i < suite.uncertainty.replicates; i++) {
      const counts = new Map<string, number>();
      for (const group of groups.values()) for (let j = 0; j < group.length; j++) {
        const block = group[random(group.length)]!;
        counts.set(block, (counts.get(block) ?? 0) + 1);
      }
      let sum = 0;
      for (let j = 0; j < runs.length; j++) sum += valueFor(random(runs.length), counts)!;
      samples.push(sum / runs.length);
    }
    samples.sort((a, b) => a - b);
    interval = [samples[Math.floor((samples.length - 1) * .025)]!, samples[Math.ceil((samples.length - 1) * .975)]!];
  }
  return { complete, expectedRuns, completedRuns: aggregates.filter(a => a.valid).length, failedRuns: runs.filter(r => r.status === 'failed').length,
    expectedTrials: expectedRuns * expectedPerRun, scoredTrials: runs.reduce((n, r) => n + r.trials.filter(t => t.score !== null).length, 0), value, runScores, interval,
    uncertainty: { ...suite.uncertainty, blocks: blocks.length, runs: runs.length } };
}

// Closed projection: unknown keys (including transcripts, endpoints and uploaded trust flags) reject.
type Shape = string | readonly Shape[] | { readonly [key: string]: Shape };
const costShape = { scope: '=authoring-run', amount: '?decimal', currency: '?=USD', source: '=router-reported|runner-estimate|unknown', coverage: '=complete|partial|unknown', pricingVersion: '?text', pricedAt: '?date' };
const trialShape = { trialId: 'id', blockId: 'id', stratumId: 'id', permutationId: 'id', status: '=win|draw|loss|forfeit|timeout|incomplete', score: '?number', attempts: 'integer' };
const runShape = { id: 'id', index: 'integer', status: '=pending|authoring|frozen|failed|evaluated', reason: '?id', authoringAttempts: 'integer', artifactDigest: '?hash', seriesId: '?id', seriesRevision: '?integer', trials: [trialShape], cost: costShape, startedAt: '?date', finishedAt: '?date' };
const uncertaintyShape = { method: '=crossed-run-block-bootstrap/1', seed: 'integer', replicates: 'integer' };
const suiteShape = { id: 'id', version: 'integer', title: 'text', track: '=authored-policy|submitted-policy', game: 'id', gameVersion: 'text', surfaceHash: 'hash', seriesDigest: 'hash', build: { gameDigest: 'hash', runnerDigest: 'hash' }, roles: ['id'], references: [{ id: 'id', digest: 'hash' }], strata: [{ id: 'id', weight: 'number' }], blocks: [{ scenarioId: 'id', blockId: 'id', stratumId: 'id' }], evaluation: { permutations: ['id'], repetitions: 'integer' }, authoring: { replicates: 'integer', budgets: { maxTokens: '?integer', maxCostUsd: '?decimal', maxTurns: '?integer' }, maxWallMs: 'integer', practiceSeeds: ['integer'] }, scoring: { method: '=weighted-score/1', timeout: '=draw', authoringFailure: '=zero' }, uncertainty: uncertaintyShape, harness: { id: 'id', version: 'text' }, digest: 'hash' };
const experimentShape = { id: 'id', suiteDigest: 'hash', executionDigest: '?hash', system: { id: 'id', label: 'text', provider: '?text', model: '?text', harness: 'text', configurationDigest: 'hash' }, replicates: 'integer', provenance: '=runner-observed|submitted-artifact', digest: 'hash' };
const publicationShape: Shape = { format: '=playerthree.benchmark-publication', version: '=1', id: 'id', revision: '=1', publishedAt: 'date', suite: suiteShape, experiment: experimentShape, runs: [runShape], score: { complete: 'boolean', expectedRuns: 'integer', completedRuns: 'integer', failedRuns: 'integer', expectedTrials: 'integer', scoredTrials: 'integer', value: '?number', runScores: ['?number'], interval: 'interval', uncertainty: { ...uncertaintyShape, blocks: 'integer', runs: 'integer' } }, consent: { results: '=true', attribution: 'boolean', artifacts: '=false', research: 'boolean', training: 'boolean', license: 'text' }, retention: { policy: '=until-withdrawn', withdrawalNotice: '=Downloaded copies cannot be recalled.' }, digest: 'hash' };
function check(value: unknown, shape: Shape, path = 'publication'): void {
  const fail = (): never => { throw new Error(`Invalid benchmark ${path}`); };
  if (Array.isArray(shape)) { if (!Array.isArray(value) || value.length > 100000) fail(); (value as unknown[]).forEach((v, i) => check(v, shape[0]!, `${path}[${i}]`)); return; }
  if (typeof shape === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    const obj = value as Record<string, unknown>;
    if (Object.keys(obj).length !== Object.keys(shape).length || Object.keys(obj).some(k => !(k in shape))) fail();
    for (const [key, field] of Object.entries(shape)) check(obj[key], field, `${path}.${key}`);
    return;
  }
  const rule = shape as string;
  if (rule.startsWith('?')) { if (value === null) return; return check(value, rule.slice(1), path); }
  if (rule.startsWith('=')) {
    const allowed = rule.slice(1).split('|').map(v => v === 'true' ? true : v === 'false' ? false : v === '1' ? 1 : v);
    if (!allowed.includes(value as never)) fail();
    return;
  }
  switch (rule) {
    case 'text': if (typeof value !== 'string' || !value.length || value.length > 500 || /[\x00-\x1f]/.test(value)) fail(); break;
    case 'id': if (typeof value !== 'string' || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(value)) fail(); break;
    case 'hash': if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); break;
    case 'date': if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(); break;
    case 'decimal': if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || !Number.isFinite(Number(value))) fail(); break;
    case 'integer': if (!Number.isSafeInteger(value) || (value as number) < 0) fail(); break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) fail(); break;
    case 'boolean': if (typeof value !== 'boolean') fail(); break;
    case 'interval': if (value !== null && (!Array.isArray(value) || value.length !== 2 || value.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) || value[0] > value[1])) fail(); break;
    default: fail();
  }
}
function verifyDigest(value: { digest: string }): void { const { digest, ...body } = value; if (benchmarkDigest(body) !== digest) throw new Error('Benchmark digest mismatch'); }
/** Checks a suite's shape, digest and bounds; returns a copy. */
export function validateBenchmarkSuite(input: unknown): BenchmarkSuite {
  check(input, suiteShape, 'suite'); const suite = input as BenchmarkSuite; verifyDigest(suite);
  const trials = suite.blocks.length * suite.evaluation.permutations.length * suite.evaluation.repetitions;
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 200 || suite.roles.length > 32 || suite.references.length > 100 || suite.strata.length > 200 || suite.authoring.practiceSeeds.length > 10000 || suite.uncertainty.replicates * suite.authoring.replicates * trials > 20000000) throw new Error('Benchmark suite exceeds execution or analysis limits');
  const unique = (ids: string[]) => ids.length > 0 && new Set(ids).size === ids.length;
  if (!unique(suite.roles) || !unique(suite.strata.map(s => s.id)) || !unique(suite.blocks.map(b => b.scenarioId)) || !unique(suite.evaluation.permutations) || suite.evaluation.repetitions < 1 || suite.version < 1 || suite.strata.some(s => s.weight <= 0) || suite.blocks.some(b => !suite.strata.some(s => s.id === b.stratumId)) || suite.authoring.replicates < 1 || suite.authoring.replicates > 100 || suite.authoring.maxWallMs < 1 || suite.uncertainty.replicates < 100 || suite.uncertainty.replicates > 10000) throw new Error('Invalid benchmark suite design');
  if (suite.strata.some(s => !suite.blocks.some(b => b.stratumId === s.id)) || !Number.isFinite(suite.strata.reduce((n, s) => n + s.weight, 0))) throw new Error('Unrepresented or invalid benchmark stratum');
  return structuredClone(suite);
}
/** Checks a publication end to end — shape, digests, suite, run lineage, adjudication, anonymity and the recomputed score; returns a copy. */
export function validateBenchmarkPublication(input: unknown): BenchmarkPublication {
  check(input, publicationShape); const p = input as BenchmarkPublication; verifyDigest(p); validateBenchmarkSuite(p.suite); verifyDigest(p.experiment);
  if (p.experiment.system.harness !== `${p.suite.harness.id}/${p.suite.harness.version}`) throw new Error('Common-harness publication identity mismatch');
  if (p.experiment.suiteDigest !== p.suite.digest || p.experiment.replicates !== p.suite.authoring.replicates || p.runs.length !== p.experiment.replicates || new Set(p.runs.map(r => r.id)).size !== p.runs.length || p.runs.some((r, i) => r.index !== i)) throw new Error('Invalid benchmark lineage');
  const expected = p.suite.blocks.flatMap(block => p.suite.evaluation.permutations.flatMap(permutationId => Array.from({ length: p.suite.evaluation.repetitions }, () => ({ blockId: block.blockId, stratumId: block.stratumId, permutationId })))).map((t, i) => canonicalJson([`trial-${i}`, t.blockId, t.stratumId, t.permutationId])).sort();
  for (const run of p.runs) {
    if (run.status === 'evaluated' && canonicalJson(run.trials.map(t => canonicalJson([t.trialId, t.blockId, t.stratumId, t.permutationId])).sort()) !== canonicalJson(expected)) throw new Error('Unbalanced benchmark schedule');
    if (new Set(run.trials.map(t => t.trialId)).size !== run.trials.length) throw new Error('Duplicate benchmark trial');
    if (run.status === 'failed' && (run.artifactDigest !== null || run.seriesId !== null || run.trials.length !== 0)) throw new Error('Failed authoring cannot have evaluation evidence');
    if (run.status === 'evaluated' && (!run.artifactDigest || !run.seriesId || run.seriesRevision === null)) throw new Error('Missing benchmark lineage');
    for (const trial of run.trials) {
      const score = trial.status === 'win' ? 1 : ['draw', 'timeout'].includes(trial.status) ? .5 : trial.status === 'incomplete' ? null : 0;
      if (trial.score !== score || !p.suite.blocks.some(b => b.blockId === trial.blockId && b.stratumId === trial.stratumId)) throw new Error('Invalid benchmark adjudication');
    }
    if (run.cost.coverage === 'complete' && (run.cost.amount === null || run.cost.currency === null || run.cost.source === 'unknown' || run.cost.pricingVersion === null || run.cost.pricedAt === null)) throw new Error('Incomplete benchmark cost');
    if (p.suite.track === 'submitted-policy' ? run.authoringAttempts !== 0 : run.status !== 'pending' && run.authoringAttempts < 1) throw new Error('Invalid benchmark authoring attempts');
  }
  if (!p.consent.attribution && (p.experiment.executionDigest !== null || p.experiment.system.provider !== null || p.experiment.system.model !== null || p.experiment.system.label !== 'Anonymous system')) throw new Error('Attribution consent missing');
  if (canonicalJson(scoreBenchmark(p.suite, p.runs)) !== canonicalJson(p.score)) throw new Error('Benchmark score mismatch');
  return structuredClone(p);
}
