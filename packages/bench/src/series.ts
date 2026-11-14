/** The reference series runner (`SeriesRunner`): schedules a SeriesSpec's trials over a `GameMatchHost`, records them durably in a `SeriesStore` and resumes after a restart. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from 'playerthree';
import type { AbortReason, BoundSeat, GameMatchHost, GameMatchResult, MatchExecution, MatchRow, ResultChunk, ResultRows, ResultsSummary, SeatBinder, SeriesAccess, SeriesLimits, SeriesRunner, SeriesSpec, SeriesStore, SharePolicy, StoredSeries, TrialRow } from 'playerthree/arena';
import { buildResultsSummary, exportMatchSpec, exportStoredResults, exportSeriesSpec, standings, validateResultRows, validateSeriesSpec, validateTelemetryRows } from 'playerthree/results';
import { SeriesStoreError } from 'playerthree/host';

/** Limits a series runner applies where `SeriesRunnerOptions.limits` sets none (bytes, ms). */
export const DEFAULT_SERIES_LIMITS: SeriesLimits = { maxGames: 200, maxConcurrency: 2, maxBytes: 2 * 1024 * 1024 * 1024, maxChunkBytes: 1024 * 1024, retentionMs: 30 * 86400000, maxWallMs: 3600000, maxAttemptBytes: 256 * 1024 * 1024, maxOwnerBytes: 4 * 1024 * 1024 * 1024, maxActiveSeries: 2 };
/** `host` runs single matches, `binder` binds entrants to seats, `store` persists series durably. */
export interface SeriesRunnerOptions { host: GameMatchHost; store: SeriesStore; binder: SeatBinder; limits?: Partial<SeriesLimits>; now?: () => number }
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const terminal = (s: StoredSeries) => ['completed', 'aborted', 'failed'].includes(s.state);
const positive = (n: number, name: string, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`); };
const unique = (xs: readonly string[], name: string) => { if (xs.some(x => !/^[A-Za-z0-9_.:-]{1,128}$/.test(x)) || new Set(xs).size !== xs.length) throw new Error(`Invalid ${name}`); };

/** Control of one executing series; `suspended` marks process shutdown, which is not an owner abort. */
interface RunControl { abort: AbortController; reason: AbortReason; suspended: boolean }
/** The reference runner adds `close()`: stop executing without a terminal transition so another process resumes. */
export interface ClosableSeriesRunner extends SeriesRunner { close(): Promise<void> }

/** The sole generic evaluation scheduler. Hosts own individual matches, never series loops. */
export function createSeriesRunner(options: SeriesRunnerOptions): ClosableSeriesRunner {
  const { host, store, binder } = options;
  const limits = { ...DEFAULT_SERIES_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const running = new Map<string, RunControl & { done: Promise<void> }>();
  let closing: Promise<void> | undefined;
  const summaries = new Map<string, { key: string; value: Promise<ResultsSummary> }>();
  async function summary(record: StoredSeries, policy?: SharePolicy, revision?: number): Promise<ResultsSummary> {
    const clock = now();
    const releasedRevision = policy ? record.updates.filter(u => u.releaseAt <= clock).at(-1)?.revision ?? 0 : record.revision;
    const key = canonicalJson({ revision: revision ?? record.revision, releasedRevision, policy, consents: record.commentaryConsents });
    const cached = summaries.get(record.id);
    if (cached?.key === key) return cached.value;
    const value = buildResultsSummary(record, () => store.iterateChunks(record.id, revision), revision, policy, clock);
    summaries.set(record.id, { key, value });
    if (summaries.size > 32) summaries.delete(summaries.keys().next().value!);
    try { return await value; }
    catch (e) { if (summaries.get(record.id)?.value === value) summaries.delete(record.id); throw e; }
  }
  const mutations = new Map<string, Promise<unknown>>();
  const mutate = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const pending = (mutations.get(id) ?? Promise.resolve()).then(fn);
    const tail = pending.catch(() => {});
    mutations.set(id, tail);
    void tail.then(() => { if (mutations.get(id) === tail) mutations.delete(id); });
    return pending;
  };
  const holder = randomUUID();
  const iso = () => new Date(now()).toISOString();
  const owned = async (owner: string, id: string) => { const s = await store.get(id); if (!s || s.owner !== owner || Date.parse(s.expiresAt) <= now()) throw new Error('Series not found'); return s; };
  const access = async (a: SeriesAccess) => {
    if (a.kind === 'owner') return { record: await owned(a.owner, a.seriesId), policy: undefined };
    if (!/^[A-Za-z0-9_-]{32}$/.test(a.token)) throw new Error('Share not found');
    const share = await store.resolveShare(createHash('sha256').update(a.token).digest('hex'));
    if (!share || share.revokedAt || Date.parse(share.policy.expiresAt) <= now() || share.policy.notBefore > now()) throw new Error('Share not found');
    return { record: await owned(share.owner, share.seriesId), policy: share.policy };
  };
  async function schedule(spec: SeriesSpec): Promise<TrialRow[]> {
    if (spec.format !== 'playerthree.series' || spec.version !== 1 || spec.template.format !== 'playerthree.match' || spec.template.version !== 1) throw new Error('Invalid series format');
    unique(spec.entrants.map(e => e.id), 'entrants'); unique(spec.scenarios.map(s => s.id), 'scenarios'); unique(spec.permutations.map(p => p.id), 'permutations'); unique(spec.template.sides.map(s => s.id), 'sides');
    if (!spec.entrants.length || !spec.scenarios.length || !spec.permutations.length) throw new Error('Empty schedule');
    positive(spec.repetitions, 'repetitions'); positive(spec.execution.concurrency, 'concurrency', limits.maxConcurrency); positive(spec.execution.maxTicks, 'maxTicks'); positive(spec.execution.maxWallMs, 'maxWallMs', limits.maxWallMs); positive(spec.telemetry.sampleEveryTicks, 'sampling cadence');
    if (!Number.isInteger(spec.execution.maxInfraRetries) || spec.execution.maxInfraRetries < 0 || spec.execution.maxInfraRetries > 10 || !Number.isFinite(spec.execution.speed) || spec.execution.speed <= 0) throw new Error('Invalid execution policy');
    if (spec.track === 'live' && spec.execution.clock === 'realtime' && spec.execution.speed !== 1) throw new Error('Realtime live matches require speed 1');
    if (spec.template.sides.some(s => s.seats.some(x => x.occupant.kind === 'open'))) throw new Error('Open seats block acceptance');
    if (spec.template.sides.some(s => s.seats.some(x => x.occupant.kind === 'human')) && spec.execution.speed !== 1) throw new Error('Human matches cannot accelerate');
    positive(spec.scenarios.length * spec.permutations.length * spec.repetitions, 'games', limits.maxGames);
    const description = await host.describe();
    if (description.game !== spec.game || description.gameVersion !== spec.gameVersion || description.surfaceHash !== spec.surfaceHash || !description.clocks.includes(spec.execution.clock)) throw new Error('Host identity or clock mismatch');
    spec.telemetry = { ...spec.telemetry, metricDefinitions: description.metricDefinitions ?? [], eventDefinitions: description.eventDefinitions ?? [] };
    const trials: TrialRow[] = [];
    for (const scenario of spec.scenarios) for (const permutation of spec.permutations) for (let repetition = 0; repetition < spec.repetitions; repetition++) {
      if (!Number.isSafeInteger(scenario.seed) || !Number.isSafeInteger(scenario.map.seed)) throw new Error('Invalid seed');
      unique(permutation.sideEntrants.map(x => x.team), 'permutation sides'); unique(permutation.sideEntrants.map(x => x.entrantId), 'permutation entrants');
      if (permutation.sideEntrants.length !== spec.template.sides.length || permutation.sideEntrants.some(x => !spec.template.sides.some(s => s.id === x.team) || !spec.entrants.some(e => e.id === x.entrantId))) throw new Error('Incomplete permutation');
      const layout = description.supportedLayouts.find(x => x.map === scenario.map.id && x.layout === scenario.map.layout);
      if (!layout || canonicalJson([...layout.sides].sort()) !== canonicalJson(spec.template.sides.map(x => x.id).sort())) throw new Error('Unsupported layout');
      const sides = spec.template.sides.map(side => {
        const entrantId = permutation.sideEntrants.find(p => p.team === side.id)!.entrantId;
        return { ...side, seats: side.seats.map(seat => {
          if (seat.occupant.kind === 'closed') return seat;
          const originalBinding = spec.template.bindings.find(b => b.entrantId === entrantId && b.seat.role === seat.role);
          const original = spec.entrantSeats?.find(e => e.entrantId === entrantId)?.seats.find(s => s.role === seat.role) ?? (originalBinding && spec.template.sides.find(s => s.id === originalBinding.seat.team)?.seats.find(s => s.role === seat.role));
          if (!original || original.occupant.kind === 'closed' || original.occupant.kind === 'open') throw new Error('Entrant has no compatible frozen seat');
          return { role: seat.role, occupant: original.occupant };
        }) };
      });
      const bindings = sides.flatMap(s => s.seats.filter(x => x.occupant.kind !== 'closed').map(x => ({ seat: { team: s.id, role: x.role }, entrantId: permutation.sideEntrants.find(p => p.team === s.id)!.entrantId })));
      const resolved = await host.resolve({ ...spec.template, rulesHash: '', sides, seed: scenario.seed, map: scenario.map, options: { ...spec.template.options, ...scenario.options }, bindings });
      if (resolved.game !== spec.game || resolved.gameVersion !== spec.gameVersion || resolved.surfaceHash !== spec.surfaceHash || !resolved.rulesHash) throw new Error('Resolved identity mismatch');
      const scheduleIndex = trials.length;
      trials.push({ trialId: `trial-${scheduleIndex}`, scenarioId: scenario.id, permutationId: permutation.id, repetition, scheduleIndex, seed: resolved.seed, mapId: resolved.map.id, mapIdentity: resolved.map.identity, mapSeed: resolved.map.seed, layoutId: resolved.map.layout, rulesHash: resolved.rulesHash, surfaceHash: resolved.surfaceHash, resolvedOptions: resolved.options, sideBindings: permutation.sideEntrants, spec: resolved });
    }
    return trials;
  }
  async function run(owner: string, id: string, control: RunControl) {
    let failure: unknown;
    let serial: Promise<unknown> = Promise.resolve();
    const locked = <T>(fn: () => Promise<T>): Promise<T> => { const p = mutate(id, fn); serial = p.catch(() => {}); return p; };
    const initial = await owned(owner, id);
    try {
      // An interrupted simulation is never resumed: retain a terminal infrastructure attempt.
      for (const active of initial.activeAttempts) {
        const trial = initial.trials.find(t => t.trialId === active.trialId)!;
        await commit(trial, active.attemptNumber, active.attemptId, active.startedAt, { terminal: initial.state === 'aborting' ? 'aborted' : 'infra_error', terminalReason: initial.state === 'aborting' ? 'owner' : 'process_interrupted', ticks: 0, simulatedMs: 0, wallMs: Math.max(0, now() - Date.parse(active.startedAt)), outcomes: [], metrics: [], artifacts: [] }, []);
      }
      let cursor = 0;
      async function commit(trial: TrialRow, attemptNumber: number, attemptId: string, startedAt: string, result: GameMatchResult, chunks: readonly ResultChunk[]) {
        return locked(async () => {
          const s = await owned(owner, id);
          const acceptedAttempt = result.terminal === 'finished' || result.terminal === 'forfeit';
          const attempt: MatchRow = { revision: s.revision + 1, matchId: s.activeAttempts.find(a => a.attemptId === attemptId)?.matchId ?? attemptId, trialId: trial.trialId, attemptId, attemptNumber, status: result.terminal, acceptedAttempt, startedAt, endedAt: iso(), ticks: result.ticks, simulatedMs: result.simulatedMs, wallMs: result.wallMs, terminalReason: result.terminalReason ?? result.terminal, outcomes: result.outcomes, spec: exportMatchSpec(trial.spec), releaseAt: now() + trial.spec.observerPolicy.minDelayMs };
          const attempts = [...s.attempts, attempt];
          const exhausted = (t: TrialRow) => { const a = attempts.filter(x => x.trialId === t.trialId); return a.some(x => x.acceptedAttempt || x.status === 'aborted') || a.length > s.spec.execution.maxInfraRetries; };
          const activeMatches = s.activeAttempts.filter(a => a.attemptId !== attemptId && a.matchId !== null).sort((a, b) => s.trials.find(t => t.trialId === a.trialId)!.scheduleIndex - s.trials.find(t => t.trialId === b.trialId)!.scheduleIndex || a.attemptNumber - b.attemptNumber).map(a => ({ matchId: a.matchId!, attemptId: a.attemptId, trialId: a.trialId, attemptNumber: a.attemptNumber, startedAt: a.startedAt, releaseAt: a.releaseAt, spec: exportMatchSpec(s.trials.find(t => t.trialId === a.trialId)!.spec) }));
          const update = { seriesId: id, revision: s.revision + 1, at: iso(), activeMatches, state: s.state, completed: s.trials.filter(exhausted).length, total: s.trials.length, standings: standings(s.spec, s.trials, attempts), releaseAt: Math.max(attempt.releaseAt, ...s.updates.map(x => x.releaseAt)) };
          await store.commitMatch(id, s.revision, { leaseHolder: holder, attempt, update, chunks });
        });
      }
      async function worker() {
        while (!control.abort.signal.aborted) {
          const trial = initial.trials[cursor++]; if (!trial) return;
          let current = await owned(owner, id);
          const previous = current.attempts.filter(a => a.trialId === trial.trialId);
          if (previous.some(a => a.acceptedAttempt || a.status === 'aborted') || previous.length > current.spec.execution.maxInfraRetries) continue;
          for (let attemptNumber = previous.length + 1; attemptNumber <= current.spec.execution.maxInfraRetries + 1 && !control.abort.signal.aborted; attemptNumber++) {
            const attemptId = `${id}_${trial.trialId}_${attemptNumber}`; const startedAt = iso();
            if (!await store.claim(id, holder, now() + current.spec.execution.maxWallMs + 60000)) throw new Error('Series lease lost');
            await locked(async () => { const s = await owned(owner, id); await store.beginAttempt(id, s.revision, { trialId: trial.trialId, attemptId, attemptNumber, startedAt, matchId: null, releaseAt: 0 }, holder); });
            let execution: MatchExecution | undefined;
            let binding: { seats: readonly BoundSeat[]; release(): Promise<void> } | undefined;
            let timer: NodeJS.Timeout | undefined;
            let chunkIndex = 0;
            let chunkQueue: Promise<void> = Promise.resolve();
            const abort = new AbortController();
            const stopped = Promise.withResolvers<GameMatchResult>();
            const stop = () => {
              abort.abort(control.reason);
              // A shutdown-interrupted match is an infrastructure attempt of the same trial; the next process may retry it.
              const result: GameMatchResult = { terminal: control.suspended ? 'infra_error' : 'aborted', terminalReason: control.reason, ticks: 0, simulatedMs: 0, wallMs: Math.max(0, now() - Date.parse(startedAt)), outcomes: [], metrics: [], artifacts: [] };
              void execution?.abort(control.reason).catch(() => {});
              stopped.resolve(result);
            };
            control.abort.signal.addEventListener('abort', stop, { once: true });
            if (control.abort.signal.aborted) stop();
            const emit = async (rows: Partial<ResultRows>) => {
              try {
                validateResultRows(rows);
                validateTelemetryRows(rows, current.spec.telemetry);
                const body = canonicalJson(rows); const bytes = Buffer.byteLength(body);
                if (bytes > limits.maxChunkBytes) throw new SeriesStoreError('quota', 'artifact_limit');
                const chunk: ResultChunk = { index: chunkIndex++, checksum: createHash('sha256').update(body).digest('hex'), bytes, rows };
                const pending = chunkQueue.then(() => store.appendChunk(id, attemptId, chunk, holder)); chunkQueue = pending;
                await pending;
              } catch (e) {
                if (e instanceof SeriesStoreError && e.code === 'quota') { control.reason = 'artifact_limit'; control.abort.abort(e); chunkQueue = Promise.resolve(); }
                else { failure = e; control.reason = 'storage'; control.abort.abort(e); }
                throw e;
              }
            };
            let result: GameMatchResult;
            const deadline = Promise.withResolvers<GameMatchResult>();
            timer = setTimeout(() => {
              abort.abort('deadline');
              deadline.resolve({ terminal: 'aborted', terminalReason: 'deadline', ticks: 0, simulatedMs: 0, wallMs: current.spec.execution.maxWallMs, outcomes: [], metrics: [], artifacts: [] });
              void execution?.abort('deadline').catch(() => {});
            }, current.spec.execution.maxWallMs);
            const interrupted = Promise.race([deadline.promise, stopped.promise]).then(value => { throw new Error(value.terminalReason); });
            try {
              const preparing = binder.bind(owner, trial.spec, { attemptId, signal: abort.signal, reset: current.spec.execution.state === 'reset_each_match' }).then(async value => {
                if (abort.signal.aborted) { await value.release(); throw new Error(String(abort.signal.reason)); }
                return value;
              });
              binding = await Promise.race([preparing, interrupted]);
              const creating = host.create(trial.spec, { attemptId, signal: abort.signal, bindings: binding.seats, execution: current.spec.execution, telemetry: current.spec.telemetry, budgets: current.spec.budgets, emitMetric: row => emit({ metrics: [row] }), emitEvent: event => emit({ events: [event] }), emitChunk: emit }).then(async value => {
                if (abort.signal.aborted) { await value.abort(abort.signal.reason as AbortReason); await value.dispose(); throw new Error(String(abort.signal.reason)); }
                return value;
              });
              execution = await Promise.race([creating, interrupted]);
              try { await locked(async () => { const s = await owned(owner, id); await store.attachMatch(id, s.revision, attemptId, execution!.id, now() + trial.spec.observerPolicy.minDelayMs, holder); }); }
              catch (e) { failure = e; control.reason = 'storage'; control.abort.abort(e); throw e; }
              await Promise.race([execution.start(), deadline.promise, stopped.promise]);
              result = await Promise.race([execution.finished, deadline.promise, stopped.promise]);
              if (![result.ticks, result.simulatedMs, result.wallMs].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid host result timing');
              if (result.terminal === 'finished' || result.terminal === 'forfeit') {
                unique(result.outcomes.map(o => o.team), 'outcome sides');
                if (result.outcomes.length !== trial.spec.sides.length || result.outcomes.some(o => !trial.spec.sides.some(s => s.id === o.team) || o.rank !== null && (!Number.isInteger(o.rank) || o.rank < 1))) throw new Error('Invalid host result outcomes');
                // Allies win, lose and place together; a host splitting an alliance would corrupt team ratings.
                const allianceOf = new Map(trial.spec.sides.map(s => [s.id, s.alliance]));
                if (result.outcomes.some(a => result.outcomes.some(b => allianceOf.get(a.team) === allianceOf.get(b.team) && (a.outcome !== b.outcome || a.rank !== b.rank)))) throw new Error('Invalid host result outcomes');
              }
              await chunkQueue;
              if (result.rows) await emit(result.rows);
              if (result.metrics.length) await emit({ metrics: result.metrics });
              for (const artifact of result.artifacts) if (artifact.availability === 'available') {
                const parts: Uint8Array[] = []; let bytes = 0;
                for await (const part of await host.artifact(artifact.id)) {
                  bytes += part.byteLength;
                  if (bytes > (limits.maxAttemptBytes ?? limits.maxBytes)) throw new SeriesStoreError('quota', 'artifact_limit');
                  parts.push(part);
                }
                const data = Buffer.concat(parts);
                if (bytes !== artifact.bytes || createHash('sha256').update(data).digest('hex') !== artifact.sha256) throw new Error('Artifact checksum mismatch');
                try { await store.putArtifact(id, artifact, data, holder); }
                catch (e) { if (!(e instanceof SeriesStoreError && e.code === 'quota')) failure = e; throw e; }
              }
              if (result.artifacts.length) await emit({ artifacts: result.artifacts });
            } catch (e) {
              // Only explicit host infrastructure failures may consume retry allowance.
              const infra = e instanceof Error && 'infrastructure' in e && e.infrastructure === true;
              const quota = e instanceof SeriesStoreError && e.code === 'quota';
              if (quota) { control.reason = 'artifact_limit'; control.abort.abort(e); }
              result = { terminal: !quota && (control.suspended || infra && !control.abort.signal.aborted) ? 'infra_error' : 'aborted', terminalReason: quota ? 'artifact_limit' : control.suspended ? control.reason : abort.signal.aborted ? String(abort.signal.reason) : control.abort.signal.aborted ? control.reason : infra ? 'infrastructure' : 'execution_error', ticks: 0, simulatedMs: 0, wallMs: Math.max(0, now() - Date.parse(startedAt)), outcomes: [], metrics: [], artifacts: [] };
            } finally {
              clearTimeout(timer); control.abort.signal.removeEventListener('abort', stop);
              try { await execution?.dispose(); } finally { await binding?.release(); }
            }
            if (failure) throw failure;
            await commit(trial, attemptNumber, attemptId, startedAt, result, []);
            if (result.terminal === 'infra_error' && !control.suspended && attemptNumber > current.spec.execution.maxInfraRetries && current.spec.execution.abortOn?.includes('infrastructure')) {
              control.reason = 'shutdown';
              control.abort.abort('infrastructure_retries_exhausted');
            }
            if (result.terminal !== 'infra_error') break;
          }
        }
      }
      await Promise.all(Array.from({ length: initial.spec.execution.concurrency }, () => worker().catch(e => { failure ??= e; control.reason = 'storage'; control.abort.abort(e); })));
      await serial;
      // The run is detached from `start`, so the cause must reach the operator log (with stack) and the exported completeness detail (message only, within the 4096-char text limit).
      if (failure) console.error(`playerthree bench: series ${id} failed:`, failure);
      await mutate(id, async () => {
        // Shutdown leaves the series running (lease released below) so `start` in the next process resumes it.
        if (control.suspended && !failure) return;
        const end = await owned(owner, id);
        await store.transition(id, end.revision, failure ? 'failed' : control.abort.signal.aborted || end.state === 'aborting' ? 'aborted' : 'completed', failure ? { rawComplete: false, missing: ['durable_recording_failure', `failure: ${failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)}`.slice(0, 4096)] } : undefined, holder);
      });
      if (failure) throw failure;
    } finally { await store.release(id, holder); }
  }
  const runner: ClosableSeriesRunner = {
    async create(owner, input) {
      if (closing) throw new Error('Series runner closed');
      if (!owner) throw new Error('Owner required');
      const spec = JSON.parse(canonicalJson(validateSeriesSpec(input))) as SeriesSpec;
      spec.template = await host.resolve(spec.template);
      const trials = await schedule(spec);
      await binder.validate?.(owner, spec);
      const id = randomUUID(); const createdMs = now(); const createdAt = new Date(createdMs).toISOString();
      // Labels/concurrency are presentation/resource decisions, not experiment identity.
      const safeSpec = exportSeriesSpec(spec);
      const comparison = { ...safeSpec, entrants: safeSpec.entrants.map(({ label: _label, ...e }) => e), execution: { ...safeSpec.execution, concurrency: undefined }, schedule: trials.map(t => ({ ...t, spec: exportMatchSpec(t.spec) })) };
      await store.create({ id, owner, spec, trials, revision: 0, state: 'queued', createdAt, updatedAt: createdAt, completedAt: null, comparisonHash: hash(comparison), limits, expiresAt: new Date(createdMs + limits.retentionMs).toISOString(), bytes: 0, commentaryConsents: spec.telemetry.commentaryConsents ?? [], activeAttempts: [], attempts: [], artifacts: [], chunkStats: [], updates: [], lease: null });
      return { id, revision: 0 };
    },
    async start(owner, id) {
      await mutate(id, async () => {
      if (closing) throw new Error('Series runner closed');
      const s = await owned(owner, id); if (terminal(s)) throw new Error('Series is terminal'); if (running.has(id)) return;
      if (!await store.claim(id, holder, now() + s.spec.execution.maxWallMs + 60000)) throw new Error('Series is already leased');
      try { if (s.state === 'queued') await store.transition(id, s.revision, 'running'); }
      catch (e) { await store.release(id, holder); throw e; }
      const control = { abort: new AbortController(), reason: 'owner' as AbortReason, suspended: false, done: Promise.resolve() };
      if (s.state === 'aborting') control.abort.abort('owner');
      running.set(id, control); control.done = run(owner, id, control).finally(() => running.delete(id));
      // Starting admits work, not a request held open until the entire experiment ends.
      void control.done.catch(() => {});
      });
    },
    async abort(owner, id) {
      // A queued series that never started is aborted outright (queued → aborted); a running one drains via aborting.
      await mutate(id, async () => { const s = await owned(owner, id); if (!terminal(s) && s.state !== 'aborting') await store.transition(id, s.revision, s.state === 'queued' && !running.has(id) ? 'aborted' : 'aborting'); });
      const active = running.get(id); if (active) { active.reason = 'owner'; active.abort.abort('owner'); await active.done; }
      else await mutate(id, async () => { const current = await owned(owner, id); if (!terminal(current)) await store.transition(id, current.revision, 'aborted'); });
    },
    async *updates(a, afterRevision = -1) {
      let cursor = afterRevision;
      for (;;) {
        const { record, policy } = await access(a);
        for (const update of record.updates) if (update.revision > cursor && (!policy || update.releaseAt <= now())) { cursor = update.revision; yield update; }
        if (terminal(record) && (!policy || record.updates.every(u => u.releaseAt <= now()))) return;
        // A closed runner commits nothing further; resumption belongs to the next process's runner.
        if (closing && !running.has(record.id)) return;
        await delay(100);
      }
    },
    async results(a, revision) { const { record, policy } = await access(a); return summary(record, policy, revision); },
    async *export(a, format, revision) {
      const { record, policy } = await access(a);
      yield* exportStoredResults(record, () => store.iterateChunks(record.id, revision), format, revision, policy, now());
    },
    async previewShare(owner, id, policy) {
      const record = await owned(owner, id);
      const consentedEntrants = record.commentaryConsents.filter(c => c.summaries || c.chat).map(c => c.entrantId);
      if (policy.commentary && consentedEntrants.length === 0) throw new Error('Commentary consent missing');
      return summary(record, { ...policy, consentedEntrants });
    },
    async createShare(owner, id, policy) {
      const s = await owned(owner, id);
      if (!Number.isFinite(policy.notBefore) || !Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= now() || Date.parse(policy.expiresAt) > Date.parse(s.expiresAt)) throw new Error('Invalid share expiry');
      const consentedEntrants = s.commentaryConsents.filter(c => c.summaries || c.chat).map(c => c.entrantId);
      if (policy.commentary && consentedEntrants.length === 0) throw new Error('Commentary consent missing');
      const token = randomBytes(24).toString('base64url');
      const saved = await store.share(id, owner, { seriesId: id, owner, digest: createHash('sha256').update(token).digest('hex'), generation: 0, policy: { ...policy, consentedEntrants }, revokedAt: null });
      return { token, generation: saved!.generation };
    },
    async revokeShare(owner, id) { await owned(owner, id); await store.share(id, owner, null); },
    async setCommentaryConsent(owner, id, entrantId, consent) {
      const record = await owned(owner, id);
      if (!record.spec.entrants.some(e => e.id === entrantId)) throw new Error('Entrant not found');
      await store.setCommentaryConsent(id, owner, entrantId, consent);
    },
    close() {
      closing ??= (async () => {
        const active = [...running.values()];
        for (const control of active) { control.suspended = true; control.reason = 'shutdown'; control.abort.abort('shutdown'); }
        await Promise.allSettled(active.map(control => control.done));
      })();
      return closing;
    },
  };
  return runner;
}

/** Reclaim only expired execution leases; interrupted simulations become fresh attempts. */
export async function recoverSeriesRunner(runner: SeriesRunner, store: SeriesStore, now = Date.now()): Promise<void> {
  for (const record of await store.recoverable(now)) await runner.start(record.owner, record.id);
}
