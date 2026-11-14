import { createHash } from 'node:crypto';
import type { MatchRow, MatchSpec, ResultChunk, ResultRows, ResultsEnvelope, SeriesSpec, SharePolicy, StoredResultChunk, StoredSeries, TrialRow } from '../src/arena.ts';
import { canonicalJson } from '../src/briefing.ts';
import { ARENA_HOST_EVENT_DEFINITIONS, exportMatchSpec, exportStoredResults, standings } from '../src/results.ts';

export const CREATED = '2000-01-01T00:00:00.000Z';
export const ENDED = '2000-01-01T00:01:00.000Z';
export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Raw chunks of a fixture series, keyed by attempt (committed or not); `record.chunkStats` mirrors the initial set. */
export interface SeriesFixture { record: StoredSeries; chunks: { attemptId: string; chunk: ResultChunk }[] }
export function chunkOf(rows: Partial<ResultRows>, index = 0): ResultChunk {
  return { index, rows, checksum: digest(rows), bytes: Buffer.byteLength(canonicalJson(rows)) };
}

/** In-memory `SeriesStore.iterateChunks`: committed attempts at the revision, schedule/attempt order, then chunk index. */
export function fixtureChunks(fixture: SeriesFixture, revision?: number): () => AsyncIterable<StoredResultChunk> {
  return async function* () {
    const { record } = fixture, selected = revision ?? record.revision;
    const order = new Map(record.trials.map((trial) => [trial.trialId, trial.scheduleIndex]));
    const attempts = record.attempts.filter((attempt) => attempt.revision <= selected).sort((a, b) => order.get(a.trialId)! - order.get(b.trialId)! || a.attemptNumber - b.attemptNumber);
    for (const attempt of attempts) {
      for (const entry of fixture.chunks.filter((chunk) => chunk.attemptId === attempt.attemptId).sort((a, b) => a.chunk.index - b.chunk.index)) yield { attemptId: entry.attemptId, chunk: entry.chunk, committedRevision: attempt.revision };
    }
  };
}

export async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

/** The full canonical envelope exactly as downloaded (streamed JSON export, parsed). */
export async function envelopeOf(fixture: SeriesFixture, revision?: number, policy?: SharePolicy, now?: number): Promise<ResultsEnvelope> {
  return JSON.parse((await collect(exportStoredResults(fixture.record, fixtureChunks(fixture), 'json', revision, policy, now))).toString('utf8')) as ResultsEnvelope;
}

export function seriesFixture(): SeriesFixture {
  const template: MatchSpec = {
    format: 'playerthree.match', version: 1, game: 'fixture', gameVersion: '1', surfaceHash: digest('surface'), rulesHash: digest('rules'), seed: 7,
    map: { id: 'arena', identity: digest('map'), seed: 7, layout: 'duel' }, options: { resourceMultiplier: 1 },
    sides: [
      { id: 'blue', spawnSlot: 'west', alliance: 'blue', seats: [{ role: 'surface', occupant: { kind: 'commander', ref: { id: 'PRIVATE_COMMANDER', kind: 'agent' } } }] },
      { id: 'red', spawnSlot: 'east', alliance: 'red', seats: [{ role: 'surface', occupant: { kind: 'human', memberId: 'PRIVATE_MEMBER' } }] },
    ], bindings: [{ seat: { team: 'blue', role: 'surface' }, entrantId: 'alpha' }, { seat: { team: 'red', role: 'surface' }, entrantId: 'beta' }],
    observerPolicy: { allowOmniscient: true, minDelayMs: 0 }, rules: { ranked: false, coaching: 'off', practiceReasons: [] },
  };
  const spec: SeriesSpec = {
    format: 'playerthree.series', version: 1, game: 'fixture', gameVersion: '1', surfaceHash: template.surfaceHash, track: 'live',
    entrants: [{ id: 'alpha', kind: 'agent', label: 'Alpha', aiPlayer: true, provider: 'provider', model: 'model', selfReported: true, harness: { label: 'test harness', verified: false }, stateResetSource: 'declared' }, { id: 'beta', kind: 'human', label: 'Beta', aiPlayer: false, stateResetSource: 'not_applicable' }],
    template, entrantSeats: [{ entrantId: 'alpha', seats: template.sides[0]!.seats }],
    scenarios: [7, 11].map((seed) => ({ id: `seed-${seed}`, seed, map: { ...template.map, seed }, options: { resourceMultiplier: 1 } })),
    permutations: [{ id: 'normal', sideEntrants: [{ team: 'blue', entrantId: 'alpha' }, { team: 'red', entrantId: 'beta' }] }], repetitions: 1,
    execution: { concurrency: 2, speed: 1, clock: 'realtime', maxTicks: 100, maxWallMs: 10000, maxInfraRetries: 1, state: 'reset_each_match', abortOn: ['infrastructure'] },
    budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null }, rating: { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 },
    telemetry: { sampleEveryTicks: 20, includeCommentary: false, metricDefinitions: [{ metric: 'economy.alloy', unit: 'alloy', scope: 'side', interpretation: 'stock' }], eventDefinitions: ARENA_HOST_EVENT_DEFINITIONS, commentaryConsents: [{ entrantId: 'alpha', summaries: true, chat: false }] },
  };
  const trials: TrialRow[] = spec.scenarios.map((scenario, index) => ({
    trialId: `trial-${index}`, scenarioId: scenario.id, permutationId: 'normal', repetition: 0, scheduleIndex: index, seed: scenario.seed,
    mapId: scenario.map.id, mapIdentity: scenario.map.identity, mapSeed: scenario.map.seed, layoutId: scenario.map.layout, rulesHash: template.rulesHash, surfaceHash: template.surfaceHash,
    resolvedOptions: scenario.options, sideBindings: spec.permutations[0]!.sideEntrants, spec: { ...template, seed: scenario.seed, map: scenario.map, options: scenario.options },
  }));
  const attempts = trials.map((trial, index): MatchRow => ({ matchId: `match-${index}`, trialId: trial.trialId, attemptId: `attempt-${index}`, attemptNumber: 1, revision: index + 2, status: 'finished', acceptedAttempt: true,
    startedAt: CREATED, endedAt: ENDED, ticks: 100, simulatedMs: 5000 + index * 1000, wallMs: 6000 + index * 1000, terminalReason: 'victory',
    outcomes: [{ team: 'blue', rank: index === 0 ? 0 : 1, outcome: index === 0 ? 'win' : 'loss', reason: 'victory' }, { team: 'red', rank: index === 0 ? 1 : 0, outcome: index === 0 ? 'loss' : 'win', reason: 'victory' }], spec: exportMatchSpec(trial.spec), releaseAt: 0,
  }));
  const rows: Partial<ResultRows> = {
    seats: [{ matchId: 'match-0', team: 'blue', role: 'surface', entrantId: 'alpha', executionKind: 'agent', fallbackKind: null, artifactVersion: null, artifactHash: null, readyState: 'ready', activeTicks: 100, submittedIntents: 2, acceptedIntents: 1, rejectedIntents: 1, commandApm: 12, policyErrors: 0 }],
    metrics: [{ matchId: 'match-0', tick: 0, sequence: 0, scope: 'side', team: 'blue', role: null, metric: 'economy.alloy', value: 100, unit: 'alloy' }, { matchId: 'match-0', tick: 20, sequence: 1, scope: 'side', team: 'blue', role: null, metric: 'economy.alloy', value: 80, unit: 'alloy' }],
    causes: [{ matchId: 'match-0', sequence: 0, tick: 20, victimTeam: 'red', victimRole: 'surface', victimKind: 'tank', attackerTeam: null, attackerRole: null, attackerKind: null, cause: 'environment', count: 1, alloyValue: 20, energyValue: 5 }],
    intents: [{ matchId: 'match-0', team: 'blue', role: 'surface', source: 'agent', code: 'game.invalid_target', submitted: 1, accepted: 0, rejected: 1 }],
    decisions: [10, 20, 30, 100].map((latencyMs, index) => ({ matchId: 'match-0', team: 'blue', role: 'surface', decisionId: `decision-${index}`, startedAt: CREATED, finishedAt: ENDED, latencyMs, source: 'runner', status: 'ok' })),
    usage: [
      { matchId: 'match-0', phase: 'inference', team: 'blue', role: 'surface', entrantId: 'alpha', executionId: 'PRIVATE_EXECUTION', decisionId: 'decision-0', reporter: 'runner', inputTokens: 10, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, costAmount: '0.10', currency: 'USD', pricingVersion: 'test', coverage: 'partial' },
      { matchId: 'match-0', phase: 'inference', team: 'blue', role: 'surface', entrantId: 'alpha', executionId: 'PRIVATE_EXECUTION', decisionId: 'decision-1', reporter: 'runner', inputTokens: 20, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costAmount: '0.20', currency: 'USD', pricingVersion: 'test', coverage: 'partial' },
    ],
    events: [{ matchId: 'match-0', sequence: 0, tick: 0, atMs: 0, kind: 'host.lifecycle', team: null, role: null, data: { state: 'started' } }, { matchId: 'match-0', sequence: 1, tick: 20, atMs: 1000, kind: 'commentary', team: 'blue', role: 'surface', data: { entrantId: 'alpha', category: 'summary', text: 'Building tanks' } }],
    artifacts: [{ id: 'replay-0', matchId: 'match-0', kind: 'recording', format: 'fixture', version: 1, sha256: digest('recording'), bytes: 12, availability: 'available' }],
  };
  const chunk = chunkOf(rows);
  const record: StoredSeries = {
    id: 'series-fixture', owner: 'PRIVATE_OWNER', spec, trials, revision: 3, state: 'completed', createdAt: CREATED, updatedAt: ENDED, completedAt: ENDED, comparisonHash: digest('comparison'),
    limits: { maxGames: 200, maxConcurrency: 2, maxBytes: 1000000, maxChunkBytes: 100000, retentionMs: 100000, maxWallMs: 100000 }, expiresAt: '2099-01-01T00:00:00.000Z', bytes: 12345, rawComplete: true, missing: [], commentaryConsents: spec.telemetry.commentaryConsents!, activeAttempts: [], attempts, artifacts: [],
    chunkStats: [{ attemptId: 'attempt-0', count: 1, bytes: chunk.bytes }],
    updates: [1, 2, 3].map((revision) => ({ seriesId: 'series-fixture', revision, at: revision === 1 ? CREATED : ENDED, state: revision === 3 ? 'completed' : 'running', completed: Math.max(0, revision - 1), total: 2, standings: standings(spec, trials, attempts.filter((attempt) => attempt.revision <= revision)), activeMatches: [], releaseAt: 0 })), lease: null,
  };
  return { record, chunks: [{ attemptId: 'attempt-0', chunk }] };
}
