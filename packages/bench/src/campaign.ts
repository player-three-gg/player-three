/**
 * Benchmark campaigns (SPEC §20 *Fixed-reference benchmark publications*): each replicate authors the candidate's
 * policies independently, the frozen artifacts are evaluated through the series runner, and the record exports as a
 * consented publication. State lives in `outDir`, so re-running resumes.
 */
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, type PolicyArtifact } from 'playerthree';
import type { GameMatchHost, ResultsEnvelope, SeriesSpec, UsageRow } from 'playerthree/arena';
import { benchmarkDigest, sealBenchmark, scoreBenchmark, systemPromptDigest, validateBenchmarkSuite, validateBenchmarkPublication, type BenchmarkSuite, type BenchmarkExperiment, type BenchmarkPublication, type BenchmarkRun, type BenchmarkCost } from 'playerthree/benchmark';
import { writeBenchmarkJson } from 'playerthree/benchmark-store';
import { jsonSeriesStore } from 'playerthree/host';
import { RUNNER_HARNESS } from '@playerthree/runner';
/** The harness authored campaigns name in `suite.harness` (and `system.harness`): the runner that drives authoring. */
export { RUNNER_HARNESS };
import { createGameMatchHost, modelKeyEnv, type AuthoredPolicies } from './bot-match.ts';
import type { AuthoringHarness } from './harness.ts';
import { preflightToolArguments, type PreflightResult } from './preflight.ts';
import { lookupServedBy } from './served-by.ts';
import { validateConfig, type BenchConfig } from './config.ts';
import { loadDefinition } from './bots-config.ts';
import { createSeriesRunner } from './series.ts';

import { benchmarkSourceDigest, type BenchmarkSources } from './source-digest.ts';
/** Public suite metadata for {@link createBenchmarkSuite}; `candidateId` names the entrant whose policies each replicate authors. */
export interface BenchmarkSuiteMetadata {
  id: string; version: number; title: string; track: BenchmarkSuite['track']; candidateId: string;
  roles: string[]; references: BenchmarkSuite['references']; strata: BenchmarkSuite['strata']; blocks: BenchmarkSuite['blocks'];
  replicates: number; harness: BenchmarkSuite['harness']; bootstrapSeed?: number; bootstrapReplicates?: number;
  build: BenchmarkSuite['build'];
}
/** A campaign: the bench config and sealed suite, the candidate, the source trees whose digests must match the suite's build, and the publication consent. */
export interface CampaignConfig {
  bench: BenchConfig; suite: BenchmarkSuite; candidateId: string;
  /** The authoring harness (default the runner's own loop); `suite.harness` must equal its identity. */
  harness?: AuthoringHarness;
  build: { game: BenchmarkSources; runner: BenchmarkSources };
  pricing?: { version: string; asOf: string };
  /** Model-excluding comparison profile; native/open divisions also exclude vendor-specific harness identity. */
  system: BenchmarkExperiment['system']; consent: BenchmarkPublication['consent'];
}
/** Private ledger row: every authoring attempt and its spend, including infrastructure failures the public run omits. */
export interface CampaignAttempt {
  runId: string; number: number; startedAt: string; finishedAt: string | null;
  outcome: 'artifact' | 'model_failure' | 'infrastructure' | 'interrupted' | null; reason: string | null;
  /** Runner-estimated USD; null while running or after a crash, when the full per-run ceiling is charged instead. */
  costUsd: string | null;
}
/** The private campaign record (`campaign.json`): suite, experiment, scored runs and every authoring attempt. */
export interface CampaignRecord {
  format: 'playerthree.benchmark-campaign'; version: 1; suite: BenchmarkSuite; experiment: BenchmarkExperiment;
  runs: BenchmarkRun[]; scheduleDigest: string | null; attempts: CampaignAttempt[];
}
export interface CampaignOptions {
  outDir: string;
  /** Operator stop: authoring in progress becomes an infrastructure attempt; evaluation suspends without aborting its series. */
  signal?: AbortSignal;
  /** Cumulative USD ceiling over every authoring attempt of this campaign directory. */
  maxCampaignUsd?: number;
  log?: (message: string) => void;
}

function seriesIdentity(spec: SeriesSpec, candidateId: string): unknown {
  return { ...spec, entrants: spec.entrants.map(e => e.id === candidateId ? { id: e.id, kind: 'policy' } : e), execution: { ...spec.execution, concurrency: 1 } };
}
/** Seals and validates a suite for `config`'s series with `metadata`; the candidate entrant is generalized to a policy so the suite digest does not depend on it. */
export function createBenchmarkSuite(config: BenchConfig, metadata: BenchmarkSuiteMetadata): BenchmarkSuite {
  validateConfig(config);
  const { candidateId, bootstrapSeed = 1729, bootstrapReplicates = 2000, replicates, ...publicMetadata } = metadata;
  const suite = sealBenchmark<Omit<BenchmarkSuite, 'digest'>>({ ...publicMetadata, game: config.spec.game, gameVersion: config.spec.gameVersion, surfaceHash: config.spec.surfaceHash,
    seriesDigest: benchmarkDigest(seriesIdentity(config.spec, candidateId)), evaluation: { permutations: config.spec.permutations.map(p => p.id), repetitions: config.spec.repetitions },
    authoring: { replicates, budgets: config.spec.budgets, maxWallMs: config.spec.authoring?.maxWallMs ?? config.spec.execution.maxWallMs, practiceSeeds: [...config.spec.authoring?.practiceSeeds ?? []],
      ...(config.spec.authoring?.systemPrompt !== undefined ? { systemPrompt: { text: config.spec.authoring.systemPrompt, digest: systemPromptDigest(config.spec.authoring.systemPrompt) } } : {}),
      ...(config.spec.authoring?.contextTokens !== undefined ? { contextTokens: config.spec.authoring.contextTokens } : {}),
      ...(config.spec.authoring?.reasoning !== undefined ? { reasoning: config.spec.authoring.reasoning } : {}) },
    scoring: { method: 'weighted-score/1', timeout: 'draw', authoringFailure: 'zero' }, uncertainty: { method: 'crossed-run-block-bootstrap/1', seed: bootstrapSeed, replicates: bootstrapReplicates } });
  return validateBenchmarkSuite(suite);
}
function costFromUsage(rows: UsageRow[], pricing: NonNullable<CampaignConfig['pricing']>): BenchmarkCost {
  const priced = rows.filter(r => r.costAmount !== null && r.currency === 'USD');
  const complete = rows.length > 0 && priced.length === rows.length && rows.every(r => r.coverage === 'complete');
  return { scope: 'authoring-run', amount: priced.length ? priced.reduce((n, r) => n + Number(r.costAmount), 0).toFixed(12) : null,
    // Router-reported only when every priced turn was: one estimated turn makes the whole sum an estimate.
    currency: priced.length ? 'USD' : null, source: !priced.length ? 'unknown' : priced.every(r => r.reporter === 'reported') ? 'router-reported' : 'runner-estimate', coverage: complete ? 'complete' : priced.length ? 'partial' : 'unknown',
    pricingVersion: priced.length ? pricing.version : null, pricedAt: priced.length ? pricing.asOf : null };
}
const unknownCost = (): BenchmarkCost => ({ scope: 'authoring-run', amount: null, currency: null, source: 'unknown', coverage: 'unknown', pricingVersion: null, pricedAt: null });

/** Each replicate authors independently; evaluation only loads durable frozen artifacts and uses SeriesRunner. */
export async function runCampaign(config: CampaignConfig, options: CampaignOptions): Promise<CampaignRecord> {
  const { bench, candidateId } = config;
  const suite = validateBenchmarkSuite(config.suite);
  validateConfig(bench);
  if (config.system.harness !== `${suite.harness.id}/${suite.harness.version}`) throw new Error('Common-harness campaign identity mismatch');
  if (suite.build.gameDigest !== await benchmarkSourceDigest(config.build.game) || suite.build.runnerDigest !== await benchmarkSourceDigest(config.build.runner)) throw new Error('Benchmark source build mismatch');
  if (bench.spec.track !== 'policy' || bench.spec.execution.state !== 'reset_each_match' || bench.spec.execution.clock === 'decision_barrier') throw new Error('Campaign supports reset frozen-policy evaluation only');
  if (suite.seriesDigest !== benchmarkDigest(seriesIdentity(bench.spec, candidateId))) throw new Error('Immutable suite configuration changed');
  if (!bench.spec.entrants.some(e => e.id === candidateId) || bench.spec.template.sides.length !== 2 || new Set(bench.spec.template.sides.map(s => s.alliance)).size !== 2) throw new Error('weighted-score/1 requires two opposing sides and a candidate');
  if (canonicalJson(suite.blocks.map(b => b.scenarioId)) !== canonicalJson(bench.spec.scenarios.map(s => s.id))) throw new Error('Every scenario needs an ordered explicit evaluation block');
  if (canonicalJson(suite.evaluation) !== canonicalJson({ permutations: bench.spec.permutations.map(p => p.id), repetitions: bench.spec.repetitions }) || canonicalJson(suite.authoring.budgets) !== canonicalJson(bench.spec.budgets) || suite.authoring.maxWallMs !== (bench.spec.authoring?.maxWallMs ?? bench.spec.execution.maxWallMs) || canonicalJson(suite.authoring.practiceSeeds) !== canonicalJson(bench.spec.authoring?.practiceSeeds ?? []) || suite.authoring.systemPrompt?.text !== bench.spec.authoring?.systemPrompt || suite.authoring.contextTokens !== bench.spec.authoring?.contextTokens || suite.authoring.reasoning !== bench.spec.authoring?.reasoning) throw new Error('Suite budget or evaluation declaration mismatch');
  if (bench.spec.permutations.some(p => p.sideEntrants.filter(e => e.entrantId === candidateId).length !== 1)) throw new Error('Every permutation must evaluate the candidate exactly once');
  const worldBlocks = new Map<string, string>();
  for (const scenario of bench.spec.scenarios) {
    const world = canonicalJson({ seed: scenario.seed, map: scenario.map });
    const block = suite.blocks.find(b => b.scenarioId === scenario.id)!.blockId;
    if (worldBlocks.has(world) && worldBlocks.get(world) !== block) throw new Error('Identical worlds cannot be split into independent blocks');
    worldBlocks.set(world, block);
  }
  const candidateSeats = bench.spec.entrantSeats?.find(e => e.entrantId === candidateId)?.seats ?? bench.spec.template.sides.find(s => bench.spec.template.bindings.some(b => b.entrantId === candidateId && b.seat.team === s.id))!.seats;
  const candidateRoles = candidateSeats.filter(s => s.occupant.kind === 'commander' && s.occupant.ref.kind === 'policy').map(s => s.role).sort();
  if (canonicalJson(candidateRoles) !== canonicalJson([...suite.roles].sort())) throw new Error('Controlled roles mismatch');
  const supplied = bench.policies?.[candidateId];
  if (supplied && suite.authoring.replicates !== 1) throw new Error('One uploaded artifact is not multiple independent authoring runs');
  if ((suite.track === 'submitted-policy') !== !!supplied) throw new Error('Authored and submitted policy tracks must remain separate');
  // Results name the harness that actually authors: the configured one, else the runner's own loop.
  const harness = config.harness?.identity ?? RUNNER_HARNESS;
  if (!supplied && (suite.harness.id !== harness.id || suite.harness.version !== harness.version)) throw new Error(`Authored campaigns must name their harness ${harness.id}/${harness.version} in suite.harness`);
  if (suite.track === 'authored-policy' && (!bench.spec.authoring || bench.spec.budgets.maxCostUsd === null || bench.spec.budgets.maxTokens === null || bench.spec.budgets.maxTurns === null)) throw new Error('Authoring requires explicit per-run wall, cost, token and turn ceilings');
  if (!supplied && (!bench.models?.[candidateId]?.price || !config.pricing?.version || !Number.isFinite(Date.parse(config.pricing.asOf)))) throw new Error('Authored campaigns require frozen explicit prices and a dated pricing convention');
  if (Object.keys(bench.models ?? {}).some(id => id !== candidateId)) throw new Error('Reference opponents cannot author during evaluation');
  const references = bench.spec.entrants.filter(e => e.id !== candidateId).map(e => ({ id: e.id, digest: benchmarkDigest({ entrant: e, policies: bench.policies?.[e.id] ?? null, gameVersion: bench.spec.gameVersion }) }));
  if (canonicalJson(references) !== canonicalJson(suite.references)) throw new Error('Reference opponent digest mismatch');
  const definition = await loadDefinition(bench.definition);
  validateConfig(bench, definition);
  if (!supplied && (config.system.model !== bench.models?.[candidateId]?.model || config.system.provider !== bench.models?.[candidateId]?.provider)) throw new Error('System identity must match runner-requested model/provider');
  const experiment = sealBenchmark<Omit<BenchmarkExperiment, 'digest'>>({ id: config.system.id, suiteDigest: suite.digest, executionDigest: benchmarkDigest({ model: bench.models?.[candidateId] ?? null, supplied: supplied ?? null, pricing: config.pricing ?? null }), system: config.system, replicates: suite.authoring.replicates, provenance: suite.track === 'submitted-policy' ? 'submitted-artifact' : 'runner-observed' });
  if (options.maxCampaignUsd !== undefined && (!Number.isFinite(options.maxCampaignUsd) || options.maxCampaignUsd < 0)) throw new Error('Campaign USD ceiling must be a finite nonnegative number');
  // A missing credential is infrastructure: fail before any run starts rather than recording authoring attempts.
  const model = supplied ? undefined : bench.models?.[candidateId];
  const keyName = model ? modelKeyEnv(model) : null;
  if (keyName && !process.env[keyName]) throw new Error(`Set ${keyName} for ${model!.provider}/${model!.model}; no authoring started`);
  await mkdir(options.outDir, { recursive: true, mode: 0o700 });
  const lockPath = join(options.outDir, 'campaign.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Campaign lock requires operator inspection');
    try { process.kill(pid, 0); throw new Error('Campaign already running'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    await unlink(lockPath); lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(String(process.pid)); await lock.sync();
  const path = join(options.outDir, 'campaign.json');
  const save = (record: CampaignRecord) => writeBenchmarkJson(path, record);
  try {
    let record: CampaignRecord;
    try { record = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      record = { format: 'playerthree.benchmark-campaign', version: 1, suite, experiment, scheduleDigest: null, attempts: [],
        runs: Array.from({ length: suite.authoring.replicates }, (_, index) => ({ id: `run-${index + 1}`, index, status: 'pending', reason: null, authoringAttempts: 0, artifactDigest: null, seriesId: null, seriesRevision: null, trials: [], cost: unknownCost(), startedAt: null, finishedAt: null })) };
      await save(record);
    }
    if (record.format !== 'playerthree.benchmark-campaign' || record.version !== 1 || record.experiment.digest !== experiment.digest || record.suite.digest !== suite.digest || record.runs.length !== suite.authoring.replicates) throw new Error('Campaign resume identity mismatch');
    if (canonicalJson(record.suite) !== canonicalJson(suite) || canonicalJson(record.experiment) !== canonicalJson(experiment) || !Array.isArray(record.attempts) || record.runs.some((r, i) => r.id !== `run-${i + 1}` || r.index !== i || r.authoringAttempts !== record.attempts.filter(a => a.runId === r.id).length)) throw new Error('Campaign checkpoint integrity failure');
    exportCampaignPublication(record, config.consent);
    await mkdir(join(options.outDir, 'artifacts'), { recursive: true, mode: 0o700 });
    await mkdir(join(options.outDir, 'authoring'), { recursive: true, mode: 0o700 });
    const log = options.log ?? (() => {});
    // Probed once per invocation, before the first attempt it would author: a route that drops tool-call arguments
    // would score as a model failure, so authoring refuses it. An unreachable route is left to authoring, whose
    // provider outages are infrastructure attempts.
    let preflight: PreflightResult | undefined;
    const maxAttempts = bench.spec.execution.maxInfraRetries + 1;
    const runCeilingUsd = bench.spec.budgets.maxCostUsd === null ? 0 : Number(bench.spec.budgets.maxCostUsd);
    // An attempt of unknown spend (a crashed process) is charged its full per-run ceiling.
    const committedUsd = () => record.attempts.reduce((sum, a) => sum + (a.costUsd === null ? runCeilingUsd : Number(a.costUsd)), 0);
    const reopen = (run: BenchmarkRun) => Object.assign(run, { status: 'pending', reason: null, startedAt: null, finishedAt: null, cost: unknownCost() } satisfies Partial<BenchmarkRun>);
    for (const run of record.runs) if (run.status === 'authoring') {
      // The process died mid-authoring: infrastructure, never a model failure.
      const attempt = record.attempts.findLast(a => a.runId === run.id);
      if (attempt?.finishedAt === null) Object.assign(attempt, { finishedAt: new Date().toISOString(), outcome: 'interrupted', reason: 'process_interrupted' } satisfies Partial<CampaignAttempt>);
      reopen(run); await save(record);
    }
    for (const run of record.runs) {
      if (options.signal?.aborted) { log('Interrupted; re-run the command to resume.'); break; }
      if (run.status === 'failed' || run.status === 'evaluated') continue;
      if (run.status === 'pending') {
        let policies: Record<string, PolicyArtifact> | null = supplied ? structuredClone(supplied) : null;
        if (supplied) run.startedAt = new Date().toISOString();
        else {
          if (run.authoringAttempts >= maxAttempts) { log(`${run.id} used all ${maxAttempts} authoring attempts; the campaign stays incomplete and authors no further runs.`); break; }
          if (options.maxCampaignUsd !== undefined && committedUsd() + runCeilingUsd > options.maxCampaignUsd) { log(`Campaign ceiling: ${committedUsd().toFixed(4)} USD committed; another attempt of up to ${runCeilingUsd} USD would exceed ${options.maxCampaignUsd} USD. ${run.id} was not authored.`); break; }
          if (preflight === undefined && model!.provider !== 'scripted') {
            preflight = await preflightToolArguments(model!, process.env[keyName!]!, options.signal);
            const via = preflight.servedBy ? ` via ${preflight.servedBy}` : '';
            if (!preflight.ok && !preflight.unavailable) throw new Error(`Tool-argument preflight failed for ${model!.model}${via}: ${preflight.detail}. Pin a faithful upstream in the model's request (e.g. OpenRouter provider.only); ${run.id} was not authored`);
            log(`Tool-argument preflight ${preflight.ok ? 'passed' : `could not run (${preflight.detail})`} for ${model!.model}${via}.`);
          }
          const attempt: CampaignAttempt = { runId: run.id, number: run.authoringAttempts + 1, startedAt: new Date().toISOString(), finishedAt: null, outcome: null, reason: null, costUsd: null };
          record.attempts.push(attempt);
          run.status = 'authoring'; run.startedAt = attempt.startedAt; run.authoringAttempts = attempt.number; await save(record);
          const author = createGameMatchHost(definition, bench, { transcripts: join(options.outDir, 'transcripts') });
          let result: AuthoredPolicies;
          try { result = await author.author(candidateId, options.signal, { harness: config.harness, scratch: join(options.outDir, 'scratch') }); }
          catch (error) {
            // The operator sees why setup failed; the ledger keeps only the closed reason.
            log(`${run.id} authoring setup failed: ${error instanceof Error ? error.message : String(error)}`);
            result = { policies: null, reason: options.signal?.aborted ? 'authoring_interrupted' : 'authoring_setup_failed', usage: [], infrastructure: true, transcripts: [], servedBy: {}, generations: [],
              harness, wallMs: 0, turns: 0, providerErrors: 0, inputTokens: 0, outputTokens: 0, reportedUsd: null, billed: null, timeline: [], policyDigests: {} };
          }
          finally { await author.close(); }
          // After the run, the upstream of each turn the reply did not name is looked up by its generation id.
          const served = await lookupServedBy(result.servedBy, result.generations, model!.baseUrl, keyName ? process.env[keyName] : undefined, { signal: options.signal });
          await writeBenchmarkJson(join(options.outDir, 'authoring', `${run.id}-${attempt.number}.json`), { runId: run.id, attempt: attempt.number, reason: result.reason, infrastructure: result.infrastructure,
            harness: result.harness, model: model!.model, request: model!.request ?? null, preflight: preflight ?? null, servedBy: served.servedBy, servedByUnresolved: served.unresolved,
            wallMs: result.wallMs, turns: result.turns, providerErrors: result.providerErrors, inputTokens: result.inputTokens, outputTokens: result.outputTokens, reportedUsd: result.reportedUsd, billed: result.billed,
            practice: result.timeline.filter(event => event.kind === 'practice'), deploys: result.timeline.filter(event => event.kind !== 'practice'), policyDigests: result.policyDigests,
            transcripts: result.transcripts.map(file => `transcripts/${file}`), usage: result.usage, pricing: config.pricing, price: model!.price });
          const cost = costFromUsage(result.usage, config.pricing!);
          Object.assign(attempt, { finishedAt: new Date().toISOString(), reason: result.reason, costUsd: cost.amount ?? '0',
            outcome: result.infrastructure ? options.signal?.aborted ? 'interrupted' : 'infrastructure' : result.policies ? 'artifact' : 'model_failure' } satisfies Partial<CampaignAttempt>);
          if (result.infrastructure) {
            reopen(run); await save(record);
            log(`${run.id} authoring attempt ${attempt.number}/${maxAttempts}: infrastructure failure (${result.reason}; ${result.turns} model turns, ${result.providerErrors} failed provider requests); the run stays pending and unscored. Re-run the command to retry.`);
            break;
          }
          policies = result.policies; run.reason = result.reason; run.cost = cost;
        }
        if (!policies || suite.roles.some(role => !policies[role])) { run.status = 'failed'; run.reason ??= 'missing_role_artifact'; run.finishedAt = new Date().toISOString(); await save(record); continue; }
        run.artifactDigest = benchmarkDigest(policies);
        await writeBenchmarkJson(join(options.outDir, 'artifacts', `${run.artifactDigest}.json`), policies);
        run.status = 'frozen'; await save(record);
      }
      const policies = JSON.parse(await readFile(join(options.outDir, 'artifacts', `${run.artifactDigest}.json`), 'utf8')) as Record<string, PolicyArtifact>;
      if (benchmarkDigest(policies) !== run.artifactDigest) throw new Error('Frozen artifact integrity failure');
      const evaluation: BenchConfig = { ...bench, models: {}, policies: { ...bench.policies, [candidateId]: policies }, spec: structuredClone(bench.spec) };
      const adapter = createGameMatchHost(definition, evaluation);
      const store = jsonSeriesStore(join(options.outDir, 'series'));
      const runner = createSeriesRunner({ host: adapter.host, binder: adapter.binder, store });
      const owner = 'benchmark-campaign';
      const finished = (state: string) => ['completed', 'failed', 'aborted'].includes(state);
      let interrupted = false;
      try {
        if (!run.seriesId) { run.seriesId = (await runner.create(owner, evaluation.spec)).id; await save(record); }
        const stored = await store.get(run.seriesId);
        if (!stored) throw new Error('Campaign series unavailable; never silently recreate a trial');
        const scheduleDigest = benchmarkDigest(stored.trials.map(t => ({ ...t, spec: { ...t.spec, bindings: t.spec.bindings } })));
        if (record.scheduleDigest !== null && record.scheduleDigest !== scheduleDigest) throw new Error('Resolved schedule changed between authoring runs');
        record.scheduleDigest = scheduleDigest; await save(record);
        const access = { kind: 'owner' as const, owner, seriesId: run.seriesId };
        if (!finished(stored.state)) {
          // Operator interruption closes the runner instead of aborting: the series resumes on the next invocation.
          const suspend = () => { void runner.close(); };
          options.signal?.addEventListener('abort', suspend, { once: true });
          try {
            if (!options.signal?.aborted) {
              try { await runner.start(owner, run.seriesId); }
              catch (error) { if (!options.signal?.aborted) throw error; }
              for await (const _ of runner.updates(access)) { /* Runner owns match scheduling and recovery. */ }
            }
          } finally { options.signal?.removeEventListener('abort', suspend); }
          interrupted = !finished((await store.get(run.seriesId))!.state);
        }
        if (!interrupted) {
          const chunks: Uint8Array[] = [];
          for await (const chunk of runner.export(access, 'json')) chunks.push(chunk);
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ResultsEnvelope;
          run.seriesRevision = result.revision;
          run.trials = result.tables.schedule.map(trial => {
            const block = suite.blocks.find(b => b.scenarioId === trial.scenarioId)!;
            const attempts = result.tables.matches.filter(m => m.trialId === trial.trialId);
            const accepted = attempts.find(m => m.acceptedAttempt);
            const last = attempts.at(-1);
            const team = trial.sideBindings.find(b => b.entrantId === candidateId)!.team;
            const outcome = accepted?.outcomes.find(o => o.team === team)?.outcome;
            const status = outcome === 'win' ? 'win' : outcome === 'draw' ? 'draw' : outcome === 'loss' ? accepted?.status === 'forfeit' ? 'forfeit' : 'loss' : last?.terminalReason === 'tick_limit' ? 'timeout' : 'incomplete';
            return { trialId: trial.trialId, blockId: block.blockId, stratumId: block.stratumId, permutationId: trial.permutationId, status, score: status === 'win' ? 1 : status === 'draw' || status === 'timeout' ? .5 : status === 'incomplete' ? null : 0, attempts: attempts.length };
          });
          if (!result.completeness.rawComplete) run.trials = run.trials.map(t => ({ ...t, status: 'incomplete', score: null }));
          run.status = run.trials.every(t => t.score !== null) ? 'evaluated' : 'frozen';
          run.finishedAt = new Date().toISOString(); await save(record);
          await writeRunResults(join(options.outDir, 'results', run.id), result, adapter.host, log);
        }
      } finally { await runner.close(); await adapter.close(); }
      if (interrupted) { log(`Interrupted during ${run.id} evaluation; its series resumes when the command is re-run.`); break; }
      // A finished series with missing trials can never complete this campaign: spend nothing more on it.
      if (run.status !== 'evaluated') { log(`${run.id} evaluation stayed incomplete after its infrastructure retries; the campaign cannot complete and authors no further runs.`); break; }
    }
    return record;
  } finally { await lock.close(); await unlink(lockPath); }
}

/**
 * A run's canonical results and the replays this process can still serve (a series finished by an earlier process
 * left its replays with that process), under `results/<run-id>/`.
 */
async function writeRunResults(dir: string, results: ResultsEnvelope, host: GameMatchHost, log: (message: string) => void): Promise<void> {
  await mkdir(join(dir, 'replays'), { recursive: true, mode: 0o700 });
  await writeBenchmarkJson(join(dir, 'results.json'), results);
  let missing = 0;
  for (const artifact of results.tables.artifacts.filter(a => a.kind === 'replay' && a.availability === 'available')) {
    const parts: Uint8Array[] = [];
    try { for await (const part of await host.artifact(artifact.id)) parts.push(part); }
    catch { missing++; continue; }
    await writeFile(join(dir, 'replays', `${encodeURIComponent(artifact.id)}.json`), Buffer.concat(parts), { mode: 0o600 });
  }
  if (missing) log(`${missing} replay(s) of ${dir} were recorded by an earlier process and are no longer available.`);
}

/** Explicit consented public projection, separate from operational series retention. */
export function exportCampaignPublication(record: CampaignRecord, consent: BenchmarkPublication['consent'], publishedAt = new Date().toISOString()): BenchmarkPublication {
  const { digest: _digest, ...experimentBody } = record.experiment;
  // The private execution digest hashes a guessable provider/model/price configuration: anonymous exports drop it.
  if (!consent.attribution) Object.assign(experimentBody, { id: 'anonymous', executionDigest: null, system: { ...experimentBody.system, id: 'anonymous', label: 'Anonymous system', provider: null, model: null } });
  const evidence = { suite: record.suite, experiment: sealBenchmark(experimentBody), runs: record.runs, score: scoreBenchmark(record.suite, record.runs), consent };
  // The id names this public evidence only: identical evidence re-exports stably, and no private identity leaks through it.
  const body = { format: 'playerthree.benchmark-publication' as const, version: 1 as const, id: `publication-${benchmarkDigest(evidence).slice(0, 32)}`, revision: 1 as const, publishedAt,
    ...evidence, retention: { policy: 'until-withdrawn' as const, withdrawalNotice: 'Downloaded copies cannot be recalled.' as const } };
  return validateBenchmarkPublication(sealBenchmark(body));
}
