/**
 * `playerthree/arena`: types of series and match execution (SPEC §20.10, §20.11) — MatchSpec, SeriesSpec, result rows
 * and envelopes, and the GameMatchHost, SeatBinder, SeriesStore and SeriesRunner contracts.
 * Types only: browser packages load this module (directly or through protocol.ts) without Node or DOM libraries.
 */
import type { ObserverFrame, ObserverGrant } from './protocol.ts';
export type { ObserverFrame, ObserverGrant } from './protocol.ts';
/** The supported JSON Schema vocabulary is deliberately small and exported as ordinary draft-2020-12 schemas. */
export interface ArenaJsonSchema {
  readonly $schema?: string; readonly $id?: string; readonly $ref?: string; readonly $defs?: Readonly<Record<string, ArenaJsonSchema>>;
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | readonly ('object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null')[]; readonly const?: unknown; readonly enum?: readonly unknown[];
  readonly anyOf?: readonly ArenaJsonSchema[]; readonly oneOf?: readonly ArenaJsonSchema[]; readonly properties?: Readonly<Record<string, ArenaJsonSchema>>; readonly required?: readonly string[];
  readonly additionalProperties?: boolean | ArenaJsonSchema; readonly propertyNames?: ArenaJsonSchema; readonly maxProperties?: number;
  readonly items?: ArenaJsonSchema; readonly minItems?: number; readonly maxItems?: number; readonly minLength?: number; readonly maxLength?: number;
  readonly pattern?: string; readonly minimum?: number; readonly maximum?: number; readonly exclusiveMinimum?: number; readonly description?: string; readonly format?: 'date-time';
}
/** The platform AbortSignal when the consumer's libraries declare one (Node, DOM); otherwise only its read-only state. */
type ArenaAbortSignal = typeof globalThis extends { AbortSignal: { prototype: infer S } } ? S : { readonly aborted: boolean; readonly reason: unknown };
export type SeatRef = { team: string; role: string };
export type CommanderRef = { id: string; kind: 'agent' | 'policy'; version?: number };
export type SlotOccupant = { kind: 'human'; memberId: string } | { kind: 'open' } | { kind: 'bot'; level: string; options: Record<string, number | boolean> } | { kind: 'commander'; ref: CommanderRef } | { kind: 'closed' };
export interface SideSpec { id: string; spawnSlot: string; alliance: string; seats: readonly { role: string; occupant: SlotOccupant }[] }
export interface EntrantCard { id: string; label: string; kind: 'bot' | 'agent' | 'policy' | 'human'; aiPlayer: boolean; provider?: string; model?: string; selfReported?: true; harness?: { label: string; verified: boolean }; scaffoldVersion?: string; artifactHash?: string; botVersion?: string; botLevel?: string; botOptions?: Record<string, number | boolean>; stateResetSource?: 'runner' | 'declared' | 'not_applicable' }
/** One match: game identity and pinned hashes, seed and map, options, sides with their seat occupants, and entrant bindings. */
export interface MatchSpec {
  format: 'playerthree.match'; version: 1; game: string; gameVersion: string; surfaceHash: string; rulesHash: string;
  seed: number; map: { id: string; identity: string; seed: number; layout: string }; options: Record<string, unknown>;
  sides: readonly SideSpec[]; bindings: readonly { seat: SeatRef; entrantId: string }[];
  observerPolicy: { allowOmniscient: boolean; minDelayMs: number };
  rules: { ranked: boolean; coaching: 'off' | 'owner' | 'game'; practiceReasons: readonly string[] };
}
export type RatingConfig = { algorithm: 'elo'; version: 1; initial: number; k: number; scale: number } | { algorithm: 'trueskill'; version: 1; mu: number; sigma: number; beta: number; tau: number; drawProbability: number };
/** A frozen series: entrants, the match template, scenarios × side permutations × repetitions, execution limits, budgets, rating and telemetry. */
export interface SeriesSpec {
  format: 'playerthree.series'; version: 1; game: string; gameVersion: string; surfaceHash: string;
  /** `gauntlet`: a frozen policy entrant against fixed built-in bot references (a game's policy-only gauntlet). */
  track: 'bots' | 'policy' | 'live' | 'gauntlet';
  entrants: readonly EntrantCard[]; template: MatchSpec;
  entrantSeats?: readonly { entrantId: string; seats: readonly { role: string; occupant: SlotOccupant }[] }[];
  /** `starters`: role → starter path (`"<skill>/<path>.js"`) the harness deploys by reference, default knobs, before the authoring clock starts. */
  authoring?: { practiceSeeds: readonly number[]; maxOutputTokens: number; maxWallMs: number; starters?: Readonly<Record<string, string>> };
  scenarios: readonly { id: string; seed: number; map: MatchSpec['map']; options: Record<string, unknown> }[];
  permutations: readonly { id: string; sideEntrants: readonly { team: string; entrantId: string }[] }[]; repetitions: number;
  execution: { concurrency: number; speed: number; clock: 'realtime' | 'accelerated' | 'decision_barrier'; maxTicks: number; maxWallMs: number; maxInfraRetries: number; state: 'reset_each_match' | 'carry_within_series'; abortOn?: readonly 'infrastructure'[] };
  budgets: { maxTokens: number | null; maxCostUsd: string | null; maxTurns: number | null }; rating: RatingConfig;
  telemetry: { sampleEveryTicks: number; includeCommentary: boolean; commentaryConsents?: readonly { entrantId: string; summaries: boolean; chat: boolean }[]; metricDefinitions?: readonly MetricDefinition[]; eventDefinitions?: readonly EventDefinition[] };
}
export interface MetricRow { matchId: string; tick: number; sequence: number; scope: 'match' | 'side' | 'seat'; team: string | null; role: string | null; metric: string; value: number; unit: string }
export interface MetricDefinition { metric: string; scope: MetricRow['scope']; unit: string; interpretation: 'stock' | 'cumulative' | 'rate' | 'configuration' }
export interface EventDefinition { kind: string; dataSchema: ArenaJsonSchema }
export interface TimelineEvent { matchId: string; sequence: number; tick: number; atMs: number; kind: string; team: string | null; role: string | null; data: Record<string, unknown> }
export interface ArtifactRef { id: string; matchId?: string; kind: 'replay' | 'recording'; format: string; version: number; sha256: string; bytes: number; availability: 'available' | 'not_recorded' | 'expired'; releaseAt?: number; expiresAt?: string }
export interface OutcomeRow { team: string; rank: number | null; outcome: 'win' | 'loss' | 'draw' | 'aborted'; reason: string }
/** How one match attempt ended, with its outcomes, metrics and artifacts. */
export interface GameMatchResult { terminal: 'finished' | 'forfeit' | 'aborted' | 'infra_error'; ticks: number; simulatedMs: number; wallMs: number; outcomes: readonly OutcomeRow[]; metrics: readonly MetricRow[]; artifacts: readonly ArtifactRef[]; terminalReason?: string; rows?: Partial<ResultRows> }
export type AbortReason = 'owner' | 'deadline' | 'shutdown' | 'storage' | 'artifact_limit';
/** One created match: started once, settled through `finished`, abortable and disposable. */
export interface MatchExecution { id: string; start(): Promise<void>; finished: Promise<GameMatchResult>; abort(reason: AbortReason): Promise<void>; dispose(): Promise<void> }
export interface BoundSeat { seat: SeatRef; executionId: string; kind: 'human' | 'agent' | 'policy' | 'bot' | 'none' }
export interface BindingContext { attemptId: string; signal: ArenaAbortSignal; reset: boolean }
/** Binds a match's seats to entrants before it starts (and releases them after); `validate` vets a series up front. */
export interface SeatBinder { bind(owner: string, spec: MatchSpec, context: BindingContext): Promise<{ seats: readonly BoundSeat[]; release(): Promise<void> }>; validate?(owner: string, spec: SeriesSpec): Promise<void> }
/** A game's single-match runner for series: describes the game, resolves specs, creates matches and serves observers and artifacts. */
export interface GameMatchHost {
  describe(): Promise<{ game: string; gameVersion: string; surfaceHash: string; supportedLayouts: readonly { map: string; layout: string; sides: readonly string[] }[]; clocks: readonly SeriesSpec['execution']['clock'][]; metricDefinitions?: readonly MetricDefinition[]; eventDefinitions?: readonly EventDefinition[] }>;
  resolve(spec: MatchSpec): Promise<MatchSpec>;
  create(spec: MatchSpec, context: { attemptId: string; signal: ArenaAbortSignal; bindings: readonly BoundSeat[]; execution: SeriesSpec['execution']; telemetry: SeriesSpec['telemetry']; budgets: SeriesSpec['budgets']; emitMetric(row: MetricRow): Promise<void>; emitEvent(event: TimelineEvent): Promise<void>; emitChunk(rows: Partial<ResultRows>): Promise<void> }): Promise<MatchExecution>;
  observe(matchId: string, grant: ObserverGrant, after?: number): AsyncIterable<ObserverFrame>;
  artifact(id: string): Promise<AsyncIterable<Uint8Array>>;
}
export type SeriesState = 'queued' | 'running' | 'aborting' | 'completed' | 'aborted' | 'failed';
export interface StandingRow { entrantId: string; wins: number; losses: number; draws: number; games: number; winRate: number | null; scoreRate: number | null; rating: number | null; mu: number | null; sigma: number | null; conservativeRating: number | null; ratingParameters: RatingConfig & { conservativeMultiplier: number; minDelta: number | null }; ratingImplementation: 'elo/1' | 'ts-trueskill/5.1.0'; provisional: boolean; averageSimulatedMs: number | null; averageWallMs: number | null; confidence: { method: 'seed_block_bootstrap'; version: 1; seed: number; replicates: number; blocks: number; level: number; winRate: readonly [number, number] | null; scoreRate: readonly [number, number] | null; independent: boolean } }
export interface SeriesUpdate { seriesId: string; revision: number; at: string; state: SeriesState; completed: number; total: number; standings: readonly StandingRow[]; activeMatches: readonly ActiveMatchRow[]; releaseAt: number; recording?: { rawComplete: false; missing: readonly string[] } }
export type ExportMatchSpec = Omit<MatchSpec, 'sides'> & { sides: readonly { id: string; spawnSlot: string; alliance: string; seats: readonly { role: string; kind: BoundSeat['kind']; entrantId: string | null }[] }[] };
export type ExportSeriesSpec = Omit<SeriesSpec, 'template' | 'entrantSeats'> & { template: ExportMatchSpec; entrantSeats?: readonly { entrantId: string; seats: readonly { role: string; kind: BoundSeat['kind']; entrantId: string }[] }[] };
export interface TrialRow { trialId: string; scenarioId: string; permutationId: string; repetition: number; scheduleIndex: number; seed: number; mapId: string; mapIdentity: string; mapSeed: number; layoutId: string; rulesHash: string; surfaceHash: string; resolvedOptions: Record<string, unknown>; sideBindings: readonly { team: string; entrantId: string }[]; spec: MatchSpec }
export interface MatchRow { matchId: string; trialId: string; attemptId: string; attemptNumber: number; revision: number; status: GameMatchResult['terminal']; acceptedAttempt: boolean; startedAt: string; endedAt: string; ticks: number; simulatedMs: number; wallMs: number; terminalReason: string; outcomes: readonly OutcomeRow[]; spec: ExportMatchSpec; releaseAt: number }
export interface SeatRow { matchId: string; team: string; role: string; entrantId: string | null; executionKind: BoundSeat['kind']; fallbackKind: BoundSeat['kind'] | null; artifactVersion: number | null; artifactHash: string | null; readyState: string; activeTicks: number | null; submittedIntents: number | null; acceptedIntents: number | null; rejectedIntents: number | null; commandApm: number | null; policyErrors: number | null }
export interface CauseRow { matchId: string; sequence: number; tick: number; victimTeam: string; victimRole: string; victimKind: string; attackerTeam: string | null; attackerRole: string | null; attackerKind: string | null; cause: string; count: number; alloyValue: number; energyValue: number }
export interface IntentRow { matchId: string; team: string; role: string; source: string; code: string; submitted: number; accepted: number; rejected: number }
export interface DecisionRow { matchId: string; team: string; role: string; decisionId: string; startedAt: string; finishedAt: string; latencyMs: number; source: 'runner' | 'provider' | 'self_report' | 'host_gap'; status: string }
export interface UsageRow { matchId: string | null; phase: 'authoring' | 'inference'; team: string | null; role: string | null; entrantId: string; executionId: string; decisionId: string | null; reporter: 'runner' | 'reported' | 'estimated' | 'unpriced'; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; costAmount: string | null; currency: string | null; pricingVersion: string | null; coverage: 'complete' | 'partial' | 'unknown' }
export interface ResultRows { seats: readonly SeatRow[]; metrics: readonly MetricRow[]; causes: readonly CauseRow[]; intents: readonly IntentRow[]; decisions: readonly DecisionRow[]; usage: readonly UsageRow[]; events: readonly TimelineEvent[]; artifacts: readonly ArtifactRef[] }
export interface EntrantRow { entrantId: string; kind: EntrantCard['kind']; label: string; aiPlayer: boolean; provider: string | null; model: string | null; selfReported: boolean; harness: string | null; harnessVerified: boolean; scaffoldVersion: string | null; artifactHash: string | null; botVersion: string | null; botLevel: string | null; botOptions: Record<string, number | boolean> | null; stateResetSource: NonNullable<EntrantCard['stateResetSource']> | null }
export interface LatencySummary { entrantId: string; source: DecisionRow['source']; samples: number; p50Ms: number | null; p95Ms: number | null; method: 'nearest_rank/1' }
export interface UsageSummary { entrantId: string; phase: UsageRow['phase']; reporter: UsageRow['reporter'] | null; currency: string | null; samples: number; coverage: UsageRow['coverage']; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; costAmount: string | null }
export interface ArtifactRow { id: string; matchId: string | null; kind: ArtifactRef['kind']; format: string; version: number; sha256: string; bytes: number; availability: ArtifactRef['availability']; releaseAt: number | null; expiresAt: string | null }
export type ResultsTable = keyof ResultsEnvelope['tables'];
/** Per attempt: chunk count, total bytes and SHA-256 over the concatenated hex chunk checksums in index order (shared: of the projected chunks). */
export interface AttemptAccounting { attemptId: string; chunks: number; bytes: number; sha256: string }
/** The canonical `playerthree.results` document of one series revision (the full download). */
export interface ResultsEnvelope { format: 'playerthree.results'; version: 1; seriesId: string; revision: number; state: SeriesState; createdAt: string; updatedAt: string; completedAt: string | null; comparisonHash: string; spec: ExportSeriesSpec; activeMatches: readonly ActiveMatchRow[]; tables: Omit<ResultRows, 'artifacts'> & { entrants: readonly EntrantRow[]; schedule: readonly Omit<TrialRow, 'spec'>[]; matches: readonly MatchRow[]; standings: readonly StandingRow[]; artifacts: readonly ArtifactRow[] }; summaries: { latency: readonly LatencySummary[]; usage: readonly UsageSummary[] }; accounting: { provenance: 'recorded_chunks' | 'shared_projection'; tables: Readonly<Record<ResultsTable, { rows: number; bytes: number }>>; recordedBytes: number; chunks: readonly AttemptAccounting[] }; completeness: { scheduleComplete: boolean; rawComplete: boolean; missing: readonly string[] }; retention: { expiresAt: string; maxBytes: number; bytes: number }; disclosure: { audience: 'owner' | 'shared'; commentary: boolean } }
/**
 * Bounded live view of a revision: the envelope's shape with row-limited tables, labelled by `sampling`.
 * Accounting, summaries, completeness and retention are exact over every row; `sampling.tables[t].rows` is the full count.
 */
export interface ResultsSummary extends Omit<ResultsEnvelope, 'format'> {
  format: 'playerthree.results.summary';
  sampling: { limit: number; tables: Readonly<Record<ResultsTable, { rows: number; included: number; method: 'complete' | 'sorted_prefix' | 'stride_per_series' }>> };
}
export interface SeriesLimits { maxGames: number; maxConcurrency: number; maxBytes: number; maxChunkBytes: number; retentionMs: number; maxWallMs: number; maxAttemptBytes?: number; maxOwnerBytes?: number; maxActiveSeries?: number }
export interface ResultChunk { index: number; checksum: string; bytes: number; rows: Partial<ResultRows> }
export interface ActiveAttempt { trialId: string; attemptId: string; attemptNumber: number; startedAt: string; matchId: string | null; releaseAt: number }
export interface ActiveMatchRow { matchId: string; attemptId: string; trialId: string; attemptNumber: number; startedAt: string; spec: ExportMatchSpec; releaseAt: number }
/** Metadata only: raw rows live behind `SeriesStore.iterateChunks`; `chunkStats` has one entry per attempt that appended chunks. */
export interface StoredSeries { id: string; owner: string; spec: SeriesSpec; trials: readonly TrialRow[]; revision: number; state: SeriesState; createdAt: string; updatedAt: string; completedAt: string | null; comparisonHash: string; limits: SeriesLimits; expiresAt: string; bytes: number; rawComplete?: boolean; missing?: readonly string[]; commentaryConsents: readonly { entrantId: string; summaries: boolean; chat: boolean }[]; activeAttempts: readonly ActiveAttempt[]; attempts: readonly MatchRow[]; artifacts: readonly ArtifactRef[]; chunkStats: readonly { attemptId: string; count: number; bytes: number }[]; updates: readonly SeriesUpdate[]; lease: { holder: string; expiresAt: number } | null }
/** A checksum-verified raw chunk of an attempt committed at `committedRevision`. */
export interface StoredResultChunk { attemptId: string; chunk: ResultChunk; committedRevision: number }
export interface MatchCommit { attempt: MatchRow; update: SeriesUpdate; chunks?: readonly ResultChunk[]; leaseHolder: string }
export interface SharePolicy { commentary: boolean; expiresAt: string; notBefore: number; consentedEntrants: readonly string[] }
export interface ShareRecord { seriesId: string; owner: string; digest: string; generation: number; policy: SharePolicy; revokedAt: string | null }
/** Durable series storage: metadata, raw result chunks, artifacts, execution leases and shares. Execution writes check the expected revision or the lease holder. */
export interface SeriesStore {
  create(record: StoredSeries): Promise<void>;
  /** Metadata only; never raw rows. */
  get(id: string): Promise<StoredSeries | undefined>;
  list(owner: string, cursor?: string): Promise<readonly StoredSeries[]>;
  /**
   * Raw chunks of the attempts committed at `revision` (default: current), in schedule index/attempt number order then
   * chunk index. Each iteration snapshots afresh, holds one verified chunk at a time and rejects corrupt or missing data.
   */
  iterateChunks(id: string, revision?: number): AsyncIterable<StoredResultChunk>;
  attachMatch(id: string, expectedRevision: number, attemptId: string, matchId: string, releaseAt: number, holder: string): Promise<number>;
  appendChunk(id: string, attemptId: string, chunk: ResultChunk, holder: string): Promise<void>;
  beginAttempt(id: string, expectedRevision: number, attempt: ActiveAttempt, holder: string): Promise<void>;
  commitMatch(id: string, expectedRevision: number, commit: MatchCommit): Promise<number>;
  transition(id: string, expectedRevision: number, state: SeriesState, recording?: { rawComplete: false; missing: readonly string[] }, leaseHolder?: string): Promise<number>;
  share(id: string, owner: string, record: ShareRecord | null): Promise<ShareRecord | null>;
  resolveShare(tokenDigest: string): Promise<ShareRecord | undefined>;
  prune(now: number): Promise<void>;
  claim(id: string, holder: string, expiresAt: number): Promise<boolean>;
  release(id: string, holder: string): Promise<void>;
  recoverable(now: number): Promise<readonly StoredSeries[]>;
  delete(id: string, owner: string): Promise<void>;
  putArtifact(id: string, artifact: ArtifactRef, data: Uint8Array, holder: string): Promise<void>;
  getArtifact(id: string, artifactId: string): Promise<Uint8Array | undefined>;
  setCommentaryConsent(id: string, owner: string, entrantId: string, consent: { summaries: boolean; chat: boolean }): Promise<void>;
}
/** Who reads a series: its owner, or a share token holder (shared projection only). */
export type SeriesAccess = { kind: 'owner'; owner: string; seriesId: string } | { kind: 'share'; token: string };
/** Runs series end to end for owners; hosts only ever run single matches. */
export interface SeriesRunner {
  create(owner: string, spec: SeriesSpec): Promise<{ id: string; revision: number }>;
  start(owner: string, id: string): Promise<void>;
  abort(owner: string, id: string): Promise<void>;
  updates(access: SeriesAccess, afterRevision?: number): AsyncIterable<SeriesUpdate>;
  /** Bounded summary for live pages and polling; full raw data is only available through `export`. */
  results(access: SeriesAccess, revision?: number): Promise<ResultsSummary>;
  /** Streams the full canonical `playerthree.results` JSON or the CSV ZIP with bounded memory. */
  export(access: SeriesAccess, format: 'json' | 'csv', revision?: number): AsyncIterable<Uint8Array>;
  /** The exact shared projection a share with this policy would publish now, before creating the link. */
  previewShare(owner: string, id: string, policy: SharePolicy): Promise<ResultsSummary>;
  createShare(owner: string, id: string, policy: SharePolicy): Promise<{ token: string; generation: number }>;
  revokeShare(owner: string, id: string): Promise<void>;
  setCommentaryConsent(owner: string, id: string, entrantId: string, consent: { summaries: boolean; chat: boolean }): Promise<void>;
}
