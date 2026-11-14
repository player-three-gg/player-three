/**
 * `playerthree/results`: canonical series results (SPEC §20.10, §20.11) — export projections that drop private
 * references, bounded-memory canonical JSON/CSV exports and live summaries — plus the re-exported arena schemas,
 * ratings and commander-log verification.
 */
import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from './briefing.ts';
import type { AttemptAccounting, EntrantCard, EntrantRow, ExportMatchSpec, ExportSeriesSpec, LatencySummary, MatchRow, MatchSpec, ResultRows, ResultsEnvelope, ResultsSummary, SeriesUpdate, SharePolicy, StandingRow, StoredResultChunk, StoredSeries, UsageRow, UsageSummary } from './arena.ts';
import { standings } from './ratings.ts';
import { ARENA_OBJECT_LIMITS, RESULT_ROW_SCHEMAS, RESULTS_ENVELOPE_SCHEMA } from './arena-schema.ts';
export { MATCH_SPEC_SCHEMA, EXPORT_MATCH_SPEC_SCHEMA, SERIES_SPEC_SCHEMA, EXPORT_SERIES_SPEC_SCHEMA, ACTIVE_MATCH_SCHEMA, SERIES_UPDATE_SCHEMA, RESULT_ROW_SCHEMAS, RESULTS_ENVELOPE_SCHEMA, RESULTS_SUMMARY_SCHEMA, ARENA_HOST_EVENT_DEFINITIONS, validateSeriesSpec, validateMatchSpec, validateResultsEnvelope, validateResultsSummary, validateResultRows, validateTelemetryRows } from './arena-schema.ts';
export { blockBootstrap, rateMatch, standings, type RatedLineup, type ScoreBlock, type SkillRating, type TrueSkillParameters } from './ratings.ts';
export { compareLogEntries, COMMANDER_LOG_FORMAT, COMMANDER_LOG_VERSION, UNRATED } from './commander-log.ts';
export { commanderPublicId, effectiveVerdict, entryDigest, parseResultsSigner, resultsKeyId, resultsPublicKey, sealedDigest, verifyCommanderLog, verifyVerdictRow } from './commander-log-integrity.ts';
export type * from './commander-log.ts';
export type { ResultsEnvelope, ResultsSummary, StoredResultChunk, StandingRow, ExportMatchSpec, ExportSeriesSpec } from './arena.ts';

/** Column order is part of the version-1 CSV contract; JSON uses canonical sorted object keys. */
export const RESULT_COLUMNS = {
  entrants: ['entrantId', 'kind', 'label', 'aiPlayer', 'provider', 'model', 'selfReported', 'harness', 'harnessVerified', 'scaffoldVersion', 'artifactHash', 'botVersion', 'botLevel', 'botOptions', 'stateResetSource'],
  schedule: ['trialId', 'scenarioId', 'permutationId', 'repetition', 'scheduleIndex', 'seed', 'mapId', 'mapIdentity', 'mapSeed', 'layoutId', 'rulesHash', 'surfaceHash', 'resolvedOptions', 'sideBindings'],
  matches: ['matchId', 'trialId', 'attemptId', 'attemptNumber', 'revision', 'status', 'acceptedAttempt', 'startedAt', 'endedAt', 'ticks', 'simulatedMs', 'wallMs', 'terminalReason', 'outcomes', 'spec', 'releaseAt'],
  seats: ['matchId', 'team', 'role', 'entrantId', 'executionKind', 'fallbackKind', 'artifactVersion', 'artifactHash', 'readyState', 'activeTicks', 'submittedIntents', 'acceptedIntents', 'rejectedIntents', 'commandApm', 'policyErrors'],
  metrics: ['matchId', 'tick', 'sequence', 'scope', 'team', 'role', 'metric', 'value', 'unit'],
  causes: ['matchId', 'sequence', 'tick', 'victimTeam', 'victimRole', 'victimKind', 'attackerTeam', 'attackerRole', 'attackerKind', 'cause', 'count', 'alloyValue', 'energyValue'],
  intents: ['matchId', 'team', 'role', 'source', 'code', 'submitted', 'accepted', 'rejected'],
  decisions: ['matchId', 'team', 'role', 'decisionId', 'startedAt', 'finishedAt', 'latencyMs', 'source', 'status'],
  usage: ['matchId', 'phase', 'team', 'role', 'entrantId', 'executionId', 'decisionId', 'reporter', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costAmount', 'currency', 'pricingVersion', 'coverage'],
  events: ['matchId', 'sequence', 'tick', 'atMs', 'kind', 'team', 'role', 'data'],
  standings: ['entrantId', 'wins', 'losses', 'draws', 'games', 'winRate', 'scoreRate', 'rating', 'mu', 'sigma', 'conservativeRating', 'ratingParameters', 'ratingImplementation', 'provisional', 'averageSimulatedMs', 'averageWallMs', 'confidence'],
  artifacts: ['id', 'matchId', 'kind', 'format', 'version', 'sha256', 'bytes', 'availability', 'releaseAt', 'expiresAt'],
} as const satisfies { [K in keyof ResultsEnvelope['tables']]: readonly (keyof ResultsEnvelope['tables'][K][number])[] };

type Table = keyof typeof RESULT_COLUMNS;
const RAW_TABLES = ['seats', 'metrics', 'causes', 'intents', 'decisions', 'usage', 'events', 'artifacts'] as const;
const TABLE_KEYS = Object.keys(RESULT_COLUMNS) as Table[];
const PRIMARY_KEYS: Record<Table, readonly string[]> = {
  entrants: ['entrantId'], schedule: ['scheduleIndex', 'trialId'], matches: ['trialId', 'attemptNumber', 'attemptId'],
  seats: ['matchId', 'team', 'role'], metrics: ['matchId', 'sequence', 'metric'], causes: ['matchId', 'sequence'],
  intents: ['matchId', 'team', 'role', 'source', 'code'], decisions: ['matchId', 'team', 'role', 'decisionId'],
  usage: ['entrantId', 'phase', 'matchId', 'executionId', 'decisionId', 'reporter'], events: ['matchId', 'sequence'],
  standings: ['entrantId'], artifacts: ['id'],
};
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const encoder = new TextEncoder();
type RawTable = typeof RAW_TABLES[number];
type Row = Record<string, unknown>;
type Head = Omit<ResultsEnvelope, 'tables'>;
type Key = number | string;
/** A row with its canonical JSON and precomputed primary-key values; `row` may be dropped while buffered for sorting. */
interface Item { json: string; keys: readonly Key[]; row?: Row }

/** Rows per table in a live summary; raw tables beyond it are sampled and labelled, never silently truncated. */
const SUMMARY_LIMIT = 2000;
/** External sort: initial sorted runs hold at most this many bytes; merges read at most FAN_IN runs at once. */
const RUN_BYTES = 4 * 1024 * 1024;
const FAN_IN = 16;
const WRITE_BATCH = 65536;
function* canonicalParts(value: unknown): Iterable<string> {
  if (value === null || typeof value !== 'object') { yield canonicalJson(value); return; }
  if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index++) { if (index) yield ','; yield* canonicalParts(value[index] ?? null); }
    yield ']'; return;
  }
  yield '{';
  let first = true;
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) continue;
    if (!first) yield ','; first = false;
    yield JSON.stringify(key); yield ':'; yield* canonicalParts(item);
  }
  yield '}';
}
function itemOf(table: Table, row: Row, json = canonicalJson(row)): Item {
  return { json, row, keys: PRIMARY_KEYS[table].map((key) => { const value = row[key]; return typeof value === 'number' ? value : canonicalJson(value); }) };
}
/** Canonical table order: primary-key columns (numbers numerically, otherwise canonical JSON text), then the whole row's canonical JSON. */
function compareItems(a: Item, b: Item): number {
  for (let index = 0; index < a.keys.length; index++) {
    const x = a.keys[index]!, y = b.keys[index]!;
    const comparison = typeof x === 'number' && typeof y === 'number' ? x - y : cmp(typeof x === 'number' ? canonicalJson(x) : x, typeof y === 'number' ? canonicalJson(y) : y);
    if (comparison) return comparison;
  }
  return cmp(a.json, b.json);
}
function sortRows<T>(rows: readonly T[], table: Table): T[] {
  return rows.map((row) => itemOf(table, row as Row)).sort(compareItems).map((item) => item.row as T);
}
async function* encodeParts(parts: AsyncIterable<string> | Iterable<string>): AsyncIterable<Uint8Array> {
  let pending = '';
  for await (const part of parts) {
    if (pending.length + part.length > WRITE_BATCH && pending) { yield encoder.encode(pending); pending = ''; }
    pending += part;
  }
  if (pending) yield encoder.encode(pending);
}
function byteLength(value: unknown): number {
  let total = 0; for (const part of canonicalParts(value)) total += Buffer.byteLength(part); return total;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const PRIVATE_KEY = /^(?:owner(?:Id)?|commander(?:Id|Ref)?|memberId|roster(?:Id|Ref)?|ref|(?:access|refresh|seat|api|bearer)?[_-]?token|secret|password|credential(?:s)?|authorization|cookie|prompt(?:s)?|system[_-]?prompt|api[_-]?key|api[_-]?url|endpoint|policy[_-]?code|chat)$/i;

/** Game-defined options and events must already be schema-validated public data at the recording boundary. */
function publicJson(value: unknown, depth = 0, maxProperties: number = ARENA_OBJECT_LIMITS.metadata): unknown {
  if (depth > 32) throw new Error('Result metadata nesting exceeds 32');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Results require finite numbers'); return value; }
  if (typeof value === 'string') { if (value.length > 4096) throw new Error('Result text exceeds 4096 characters'); return value; }
  if (Array.isArray(value)) { if (value.length > 4096) throw new Error('Result metadata array exceeds 4096 items'); return value.map((item) => publicJson(item, depth + 1, maxProperties)); }
  if (typeof value === 'object') {
    if (Object.keys(value).length > maxProperties) throw new Error(`Result metadata object exceeds ${maxProperties} properties`);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined && !PRIVATE_KEY.test(key)) result[key] = publicJson(item, depth + 1, maxProperties);
    return result;
  }
  throw new Error('Results require JSON values');
}

function project<T>(value: T, columns: readonly string[], maxProperties: number = ARENA_OBJECT_LIMITS.metadata): T {
  const source = value as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const column of columns) result[column] = source[column] === undefined ? null : publicJson(source[column], 0, maxProperties);
  return result as T;
}

function card(card: EntrantCard): EntrantCard {
  const result = project(card, ['id', 'label', 'kind', 'aiPlayer', ...Object.keys(card).filter((key) => ['provider', 'model', 'selfReported', 'harness', 'scaffoldVersion', 'artifactHash', 'botVersion', 'botLevel', 'botOptions', 'stateResetSource'].includes(key))]);
  if (card.harness) result.harness = { label: card.harness.label, verified: card.harness.verified };
  return result;
}
function entrant(card: EntrantCard): EntrantRow {
  return { entrantId: card.id, kind: card.kind, label: card.label, aiPlayer: card.aiPlayer, provider: card.provider ?? null, model: card.model ?? null, selfReported: card.selfReported === true, harness: card.harness?.label ?? null, harnessVerified: card.harness?.verified === true, scaffoldVersion: card.scaffoldVersion ?? null, artifactHash: card.artifactHash ?? null, botVersion: card.botVersion ?? null, botLevel: card.botLevel ?? null, botOptions: card.botOptions ? publicJson(card.botOptions) as EntrantRow['botOptions'] : null, stateResetSource: card.stateResetSource ?? null };
}

/** Never copy owner/member/commander references into even the owner's downloadable raw dataset. */
export function exportMatchSpec(spec: MatchSpec | ExportMatchSpec): ExportMatchSpec {
  return {
    format: 'playerthree.match', version: 1, game: spec.game, gameVersion: spec.gameVersion, surfaceHash: spec.surfaceHash, rulesHash: spec.rulesHash,
    seed: spec.seed, map: { id: spec.map.id, identity: spec.map.identity, seed: spec.map.seed, layout: spec.map.layout }, options: publicJson(spec.options, 0, ARENA_OBJECT_LIMITS.options) as MatchSpec['options'],
    bindings: spec.bindings.map((binding) => ({ seat: { team: binding.seat.team, role: binding.seat.role }, entrantId: binding.entrantId })),
    observerPolicy: { allowOmniscient: spec.observerPolicy.allowOmniscient, minDelayMs: spec.observerPolicy.minDelayMs },
    rules: { ranked: spec.rules.ranked, coaching: spec.rules.coaching, practiceReasons: [...spec.rules.practiceReasons] },
    sides: spec.sides.map((side) => ({ id: side.id, spawnSlot: side.spawnSlot, alliance: side.alliance, seats: side.seats.map((seat) => {
      const entrantId = spec.bindings.find((binding) => binding.seat.team === side.id && binding.seat.role === seat.role)?.entrantId ?? null;
      if ('kind' in seat) return { role: seat.role, kind: seat.kind, entrantId };
      const occupant = seat.occupant;
      return { role: seat.role, kind: occupant.kind === 'commander' ? occupant.ref.kind : occupant.kind === 'open' || occupant.kind === 'closed' ? 'none' : occupant.kind, entrantId };
    }) })),
  };
}

/** The public projection of a SeriesSpec: private occupant, owner and commander references removed (as in {@link exportMatchSpec}). */
export function exportSeriesSpec(spec: StoredSeries['spec']): ExportSeriesSpec {
  return {
    format: 'playerthree.series', version: 1, game: spec.game, gameVersion: spec.gameVersion, surfaceHash: spec.surfaceHash, track: spec.track,
    entrants: spec.entrants.map(card), template: exportMatchSpec(spec.template),
    ...(spec.entrantSeats ? { entrantSeats: spec.entrantSeats.map((blueprint) => ({ entrantId: blueprint.entrantId, seats: blueprint.seats.map((seat) => ({ role: seat.role, entrantId: blueprint.entrantId, kind: seat.occupant.kind === 'commander' ? seat.occupant.ref.kind : seat.occupant.kind === 'open' || seat.occupant.kind === 'closed' ? 'none' : seat.occupant.kind })) })) } : {}),
    ...(spec.authoring ? { authoring: { practiceSeeds: [...spec.authoring.practiceSeeds], maxOutputTokens: spec.authoring.maxOutputTokens, maxWallMs: spec.authoring.maxWallMs, ...(spec.authoring.starters ? { starters: { ...spec.authoring.starters } } : {}) } } : {}),
    scenarios: spec.scenarios.map((scenario) => ({ id: scenario.id, seed: scenario.seed, map: { id: scenario.map.id, identity: scenario.map.identity, seed: scenario.map.seed, layout: scenario.map.layout }, options: publicJson(scenario.options, 0, ARENA_OBJECT_LIMITS.options) as MatchSpec['options'] })),
    permutations: spec.permutations.map((permutation) => ({ id: permutation.id, sideEntrants: permutation.sideEntrants.map((binding) => ({ team: binding.team, entrantId: binding.entrantId })) })),
    repetitions: spec.repetitions, execution: { ...project(spec.execution, ['concurrency', 'speed', 'clock', 'maxTicks', 'maxWallMs', 'maxInfraRetries', 'state']), ...(spec.execution.abortOn ? { abortOn: [...spec.execution.abortOn] } : {}) },
    budgets: project(spec.budgets, ['maxTokens', 'maxCostUsd', 'maxTurns']), rating: spec.rating.algorithm === 'elo' ? project(spec.rating, ['algorithm', 'version', 'initial', 'k', 'scale']) : project(spec.rating, ['algorithm', 'version', 'mu', 'sigma', 'beta', 'tau', 'drawProbability']),
    telemetry: {
      sampleEveryTicks: spec.telemetry.sampleEveryTicks, includeCommentary: spec.telemetry.includeCommentary,
      ...(spec.telemetry.commentaryConsents ? { commentaryConsents: spec.telemetry.commentaryConsents.map((consent) => ({ entrantId: consent.entrantId, summaries: consent.summaries, chat: consent.chat })) } : {}),
      ...(spec.telemetry.metricDefinitions ? { metricDefinitions: spec.telemetry.metricDefinitions.map((definition) => project(definition, ['metric', 'scope', 'unit', 'interpretation'])) } : {}),
      ...(spec.telemetry.eventDefinitions ? { eventDefinitions: spec.telemetry.eventDefinitions.map((definition) => ({ kind: definition.kind, dataSchema: publicJson(definition.dataSchema) as typeof definition.dataSchema })) } : {}),
    },
  };
}

/** Owns one lazily created private directory under os.tmpdir(); `dispose` always removes it with every run file. */
class Spill {
  dir: string | undefined;
  count = 0;
  async file(): Promise<string> {
    this.dir ??= await mkdtemp(join(tmpdir(), 'playerthree-results-'));
    return join(this.dir, `${this.count++}.run`);
  }
  async dispose(): Promise<void> {
    const dir = this.dir;
    this.dir = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

async function writeRun(path: string, lines: Iterable<string> | AsyncIterable<string>): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    let pending = '';
    for await (const line of lines) {
      pending += `${line}\n`;
      if (pending.length >= WRITE_BATCH) { await handle.write(pending); pending = ''; }
    }
    if (pending) await handle.write(pending);
  } finally { await handle.close(); }
}

/** Run files hold one canonical JSON row per `\n` (canonical JSON escapes every raw line terminator). */
async function* readLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: WRITE_BATCH });
  try {
    let rest = '';
    for await (const chunk of stream as AsyncIterable<string>) {
      const text = rest + chunk;
      let start = 0;
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) { yield text.slice(start, end); start = end + 1; }
      rest = text.slice(start);
    }
    if (rest) yield rest;
  } finally { stream.destroy(); }
}

async function* mergeRuns(paths: readonly string[], decode: (line: string) => Item): AsyncGenerator<Item> {
  const readers = paths.map(readLines);
  try {
    const next = async (index: number): Promise<Item | undefined> => { const step = await readers[index]!.next(); return step.done ? undefined : decode(step.value); };
    const heads = await Promise.all(readers.map((_, index) => next(index)));
    for (;;) {
      let best = -1;
      for (let index = 0; index < heads.length; index++) if (heads[index] && (best < 0 || compareItems(heads[index]!, heads[best]!) < 0)) best = index;
      if (best < 0) return;
      yield heads[best]!;
      heads[best] = await next(best);
    }
  } finally {
    for (const reader of readers) await reader.return(undefined);
  }
}

/** Bounded-memory external merge sort of canonical rows; `sorted()` may be iterated repeatedly until the spill is disposed. */
class Sorter {
  spill: Spill;
  decode: (line: string) => Item;
  buffer: Item[] = [];
  bytes = 0;
  runs: string[] = [];
  constructor(spill: Spill, decode: (line: string) => Item) { this.spill = spill; this.decode = decode; }
  /** Takes ownership of `item` (its parsed row is dropped while buffered); returns a promise only when a run spills. */
  add(item: Item, size: number): void | Promise<void> {
    if (this.buffer.length && this.bytes + size + 1 > RUN_BYTES) return this.flush().then(() => this.push(item, size));
    this.push(item, size);
  }
  push(item: Item, size: number): void {
    delete item.row;
    this.buffer.push(item);
    this.bytes += size + 1;
  }
  async flush(): Promise<void> {
    this.buffer.sort(compareItems);
    const path = await this.spill.file();
    await writeRun(path, this.buffer.map((item) => item.json));
    this.runs.push(path);
    this.buffer = [];
    this.bytes = 0;
  }
  async *sorted(): AsyncGenerator<Item> {
    if (this.runs.length === 0) { this.buffer.sort(compareItems); yield* this.buffer; return; }
    if (this.buffer.length) await this.flush();
    while (this.runs.length > FAN_IN) {
      const merged: string[] = [];
      for (let start = 0; start < this.runs.length; start += FAN_IN) {
        const group = this.runs.slice(start, start + FAN_IN);
        if (group.length === 1) { merged.push(group[0]!); continue; }
        const path = await this.spill.file();
        await writeRun(path, jsonLines(mergeRuns(group, this.decode)));
        for (const run of group) await rm(run, { force: true });
        merged.push(path);
      }
      this.runs = merged;
    }
    yield* mergeRuns(this.runs, this.decode);
  }
}
async function* jsonLines(items: AsyncIterable<Item>): AsyncIterable<string> {
  for await (const item of items) yield item.json;
}
const tableSorter = (spill: Spill, table: Table) => new Sorter(spill, (line) => { const item = itemOf(table, JSON.parse(line) as Row, line); delete item.row; return item; });

/** Keeps the canonical first `limit` rows seen so far in at most twice that many items. */
class Prefix {
  limit: number;
  items: Item[] = [];
  constructor(limit: number) { this.limit = limit; }
  add(item: Item): void {
    this.items.push(item);
    if (this.items.length >= this.limit * 2) this.trim();
  }
  trim(): void {
    this.items.sort(compareItems);
    if (this.items.length > this.limit) this.items.length = this.limit;
  }
  rows(): Row[] { this.trim(); return this.items.map((item) => item.row!); }
}

/** The committed, released revision a reader may see and the identities its rows must belong to. */
interface Snapshot {
  record: StoredSeries; shared: SharePolicy | undefined; now: number; selected: number; update: SeriesUpdate | undefined;
  attempts: readonly MatchRow[]; attemptIds: ReadonlySet<string>; matches: ReadonlyMap<string, MatchRow>; commentary: boolean;
}
function snapshotOf(record: StoredSeries, revision: number | undefined, shared: SharePolicy | undefined, now: number): Snapshot {
  if (shared && (Date.parse(shared.expiresAt) <= now || shared.notBefore > now)) throw new Error('Results share unavailable');
  let available = record.revision;
  if (shared) {
    available = 0;
    for (const update of [...record.updates].sort((a, b) => a.revision - b.revision)) {
      if (update.releaseAt > now || update.activeMatches.some((match) => match.releaseAt > now) || record.attempts.some((attempt) => attempt.revision <= update.revision && attempt.releaseAt > now)) break;
      available = update.revision;
    }
  }
  const selected = revision ?? available;
  if (!Number.isInteger(selected) || selected < 0 || selected > available) throw new Error('Results revision unavailable');
  const update = record.updates.find((entry) => entry.revision === selected);
  if (selected !== 0 && !update) throw new Error('Results revision unavailable');
  const attempts = record.attempts.filter((attempt) => attempt.revision <= selected);
  const matches = new Map<string, MatchRow>();
  for (const attempt of sortRows(attempts, 'matches')) if (!matches.has(attempt.matchId)) matches.set(attempt.matchId, attempt);
  return { record, shared, now, selected, update, attempts, attemptIds: new Set(attempts.map((attempt) => attempt.attemptId)), matches, commentary: !shared || shared.commentary };
}

/** The single row projection/sanitisation path shared by full exports and summaries; `undefined` withholds the row. */
function projectRow(snap: Snapshot, name: RawTable, source: object): Row | undefined {
  const matchId = 'matchId' in source ? source.matchId : null;
  if (matchId !== null && matchId !== undefined && !snap.matches.has(matchId as string)) return undefined;
  const row = project(source as Row, RESULT_COLUMNS[name]);
  if (name === 'usage') row.executionId = `execution_${hash(canonicalJson([snap.record.id, row.entrantId, row.executionId])).slice(0, 24)}`;
  if (name === 'events') {
    const event = row as unknown as ResultRows['events'][number];
    if (/(?:^|[.:_])commentary(?:$|[.:_])/.test(event.kind)) {
      if (!snap.commentary) return undefined;
      const shared = snap.shared;
      if (shared) {
        const ids = typeof event.data.entrantId === 'string' ? [event.data.entrantId] : event.team === null ? snap.record.spec.entrants.map((card) => card.id) : snap.matches.get(event.matchId)?.spec.bindings.filter((binding) => binding.seat.team === event.team && (event.role === null || binding.seat.role === event.role)).map((binding) => binding.entrantId) ?? [];
        const category = event.data.category === 'chat' ? 'chat' : 'summaries';
        if (ids.length === 0 || !ids.every((id) => shared.consentedEntrants.includes(id) && snap.record.commentaryConsents.some((consent) => consent.entrantId === id && consent[category]))) return undefined;
      }
    }
  }
  if (name === 'artifacts' && snap.shared && ((row.releaseAt as number | null) ?? 0) > snap.now) return undefined;
  return row;
}
function projectChunk(snap: Snapshot, rows: ResultRows | Partial<ResultRows>, only?: ReadonlySet<RawTable>): Partial<Record<RawTable, Row[]>> {
  const projection: Partial<Record<RawTable, Row[]>> = {};
  for (const name of RAW_TABLES) {
    const source = rows[name];
    if (source === undefined || (only && !only.has(name))) continue;
    const projected: Row[] = [];
    for (const raw of source) { const row = projectRow(snap, name, raw); if (row) projected.push(row); }
    projection[name] = projected;
  }
  return projection;
}
/** Committed attempts of the snapshot only; uncommitted or later chunks never reach a reader. */
async function* committed(snap: Snapshot, iterate: () => AsyncIterable<StoredResultChunk>): AsyncIterable<StoredResultChunk> {
  for await (const entry of iterate()) if (entry.committedRevision <= snap.selected && snap.attemptIds.has(entry.attemptId)) yield entry;
}
function recordArtifacts(snap: Snapshot, seen: ReadonlySet<string>): Row[] {
  return snap.record.artifacts.filter((artifact) => artifact.matchId && snap.matches.has(artifact.matchId) && (!snap.shared || (artifact.releaseAt ?? 0) <= snap.now) && !seen.has(artifact.id)).map((artifact) => project(artifact as unknown as Row, RESULT_COLUMNS.artifacts));
}

interface UsageGroup {
  entrantId: string; phase: UsageRow['phase']; reporter: UsageRow['reporter']; currency: string | null; samples: number; complete: boolean; unknown: boolean;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; cost: { total: bigint; scale: number } | null;
}
const TOKEN_COLUMNS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
interface MetricSeries { count: number; minTick: number; maxTick: number; minSequence: number; maxSequence: number }
interface Scan {
  rows: Record<RawTable, number>; bytes: Record<RawTable, number>; chunks: AttemptAccounting[]; recordedBytes: number; artifactBytes: number;
  usage: Map<string, UsageGroup>; seats: Map<string, { json: string; entrantId: string | null }>; series: Map<string, MetricSeries>;
}
const metricSeriesKey = (row: Row) => canonicalJson([row.matchId, row.scope, row.team, row.role, row.metric]);

/** Exact decimal sum without floating point; the scale grows to the longest fraction seen. */
function addCost(cost: { total: bigint; scale: number }, value: string): void {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Cost must be a nonnegative decimal string');
  const [integer, fraction = ''] = value.split('.');
  if (fraction.length > cost.scale) { cost.total *= 10n ** BigInt(fraction.length - cost.scale); cost.scale = fraction.length; }
  cost.total += BigInt(integer! + fraction.padEnd(cost.scale, '0'));
}
function costText(cost: { total: bigint; scale: number }): string {
  if (!cost.scale) return cost.total.toString();
  const text = cost.total.toString().padStart(cost.scale + 1, '0');
  return `${text.slice(0, -cost.scale)}.${text.slice(-cost.scale)}`;
}
function addUsage(groups: Map<string, UsageGroup>, row: UsageRow): void {
  const key = canonicalJson([row.entrantId, row.phase, row.reporter, row.currency]);
  let group = groups.get(key);
  if (!group) { group = { entrantId: row.entrantId, phase: row.phase, reporter: row.reporter, currency: row.currency, samples: 0, complete: true, unknown: true, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: { total: 0n, scale: 0 } }; groups.set(key, group); }
  group.samples++;
  group.complete &&= row.coverage === 'complete';
  group.unknown &&= row.coverage === 'unknown';
  for (const column of TOKEN_COLUMNS) { const value = row[column], total = group[column]; group[column] = total === null || value === null ? null : total + value; }
  if (row.costAmount === null) group.cost = null;
  else if (group.cost) addCost(group.cost, row.costAmount);
}

/**
 * First pass over every committed chunk: projects each row once, feeds it to `add` and accumulates the exact
 * table/attempt accounting, usage totals, seat entrants (canonical first row per seat) and metric series extents.
 */
async function scanRows(snap: Snapshot, iterate: () => AsyncIterable<StoredResultChunk>, add: (table: RawTable, item: Item, size: number) => void | Promise<void>): Promise<Scan> {
  const zero = () => Object.fromEntries(RAW_TABLES.map((table) => [table, 0])) as Record<RawTable, number>;
  const scan: Scan = { rows: zero(), bytes: zero(), chunks: [], recordedBytes: 0, artifactBytes: 0, usage: new Map(), seats: new Map(), series: new Map() };
  const attempts = new Map<string, { chunks: number; bytes: number; digest: Hash }>();
  const artifactIds = new Set<string>();
  // Synchronous sinks (summaries) must not pay a promise per row; only spilling sorters return one.
  const accept = (table: RawTable, row: Row): void | Promise<void> => {
    const item = itemOf(table, row), size = Buffer.byteLength(item.json);
    scan.rows[table]++; scan.bytes[table] += size;
    if (table === 'usage') addUsage(scan.usage, row as unknown as UsageRow);
    else if (table === 'artifacts') { artifactIds.add(row.id as string); scan.artifactBytes += row.bytes as number; }
    else if (table === 'seats') {
      const key = canonicalJson([row.matchId, row.team, row.role]), seat = scan.seats.get(key);
      if (!seat || item.json < seat.json) scan.seats.set(key, { json: item.json, entrantId: row.entrantId as string | null });
    } else if (table === 'metrics') {
      const key = metricSeriesKey(row), tick = row.tick as number, sequence = row.sequence as number, series = scan.series.get(key);
      if (!series) scan.series.set(key, { count: 1, minTick: tick, maxTick: tick, minSequence: sequence, maxSequence: sequence });
      else { series.count++; series.minTick = Math.min(series.minTick, tick); series.maxTick = Math.max(series.maxTick, tick); series.minSequence = Math.min(series.minSequence, sequence); series.maxSequence = Math.max(series.maxSequence, sequence); }
    }
    return add(table, item, size);
  };
  for await (const entry of committed(snap, iterate)) {
    const projection = projectChunk(snap, entry.chunk.rows);
    // A shared manifest cannot expose hashes/lengths of withheld commentary or private source identifiers.
    const json = snap.shared ? canonicalJson(projection) : undefined;
    let attempt = attempts.get(entry.attemptId);
    if (!attempt) { attempt = { chunks: 0, bytes: 0, digest: createHash('sha256') }; attempts.set(entry.attemptId, attempt); }
    const bytes = json === undefined ? entry.chunk.bytes : Buffer.byteLength(json);
    attempt.chunks++; attempt.bytes += bytes; scan.recordedBytes += bytes;
    attempt.digest.update(json === undefined ? entry.chunk.checksum : hash(json));
    for (const table of RAW_TABLES) for (const row of projection[table] ?? []) { const pending = accept(table, row); if (pending) await pending; }
  }
  for (const row of recordArtifacts(snap, artifactIds)) { const pending = accept('artifacts', row); if (pending) await pending; }
  scan.chunks = [...attempts.entries()].sort(([a], [b]) => cmp(a, b)).map(([attemptId, attempt]) => ({ attemptId, chunks: attempt.chunks, bytes: attempt.bytes, sha256: attempt.digest.digest('hex') }));
  return scan;
}

/** Evenly spaced bucket per series slot (by tick, else sequence) keeps whole-match shape within the row budget. */
class Stride {
  plans = new Map<string, { quota: number; series: MetricSeries; slots: (Item | undefined)[] | undefined; all: Item[] }>();
  constructor(series: ReadonlyMap<string, MetricSeries>, limit: number) {
    // Water-fill the budget: small series keep every row, the rest share what remains equally (key order breaks ties).
    let remaining = limit, left = series.size;
    for (const [key, entry] of [...series.entries()].sort(([a, x], [b, y]) => x.count - y.count || cmp(a, b))) {
      const quota = Math.min(entry.count, Math.floor(remaining / left));
      remaining -= quota; left--;
      this.plans.set(key, { quota, series: entry, slots: quota < entry.count ? new Array<Item | undefined>(quota).fill(undefined) : undefined, all: [] });
    }
  }
  add(item: Item): void {
    const row = item.row!, plan = this.plans.get(metricSeriesKey(row));
    if (!plan || plan.quota === 0) return;
    if (!plan.slots) { plan.all.push(item); return; }
    const byTick = plan.series.maxTick > plan.series.minTick;
    const position = (byTick ? row.tick : row.sequence) as number, low = byTick ? plan.series.minTick : plan.series.minSequence, high = byTick ? plan.series.maxTick : plan.series.maxSequence;
    const span = plan.quota - 1, slot = high > low && span > 0 ? Math.round((position - low) * span / (high - low)) : 0;
    const target = span > 0 ? low + (high - low) * slot / span : low;
    const current = plan.slots[slot];
    if (current) {
      const distance = Math.abs(position - target), other = Math.abs(((byTick ? current.row!.tick : current.row!.sequence) as number) - target);
      if (distance > other || (distance === other && compareItems(item, current) >= 0)) return;
    }
    plan.slots[slot] = item;
  }
  rows(): Row[] {
    const items: Item[] = [];
    for (const plan of this.plans.values()) { items.push(...plan.all); for (const item of plan.slots ?? []) if (item) items.push(item); }
    return items.sort(compareItems).map((item) => item.row!);
  }
}

/**
 * Second pass: exact nearest-rank decision latency per entrant/source via a bounded external sort of every sample,
 * plus the metric stride selection when a summary needs one.
 */
async function latencyPass(snap: Snapshot, iterate: () => AsyncIterable<StoredResultChunk>, scan: Scan, spill: Spill, stride?: Stride): Promise<LatencySummary[]> {
  if (scan.rows.decisions === 0 && !stride) return [];
  const sorter = new Sorter(spill, (line) => { const [group, value] = JSON.parse(line) as [string, number]; return { json: line, keys: [group, value] }; });
  const groups = new Map<string, { entrantId: string; source: LatencySummary['source']; samples: number }>();
  const only = new Set<RawTable>(stride ? ['decisions', 'metrics'] : ['decisions']);
  for await (const entry of committed(snap, iterate)) {
    const projection = projectChunk(snap, entry.chunk.rows, only);
    if (stride) for (const row of projection.metrics ?? []) stride.add(itemOf('metrics', row));
    for (const row of projection.decisions ?? []) {
      const decision = row as unknown as ResultRows['decisions'][number];
      const seat = scan.seats.get(canonicalJson([decision.matchId, decision.team, decision.role]));
      const entrantId = seat?.entrantId ?? snap.matches.get(decision.matchId)?.spec.bindings.find((binding) => binding.seat.team === decision.team && binding.seat.role === decision.role)?.entrantId;
      if (!entrantId) continue;
      if (!Number.isFinite(decision.latencyMs) || decision.latencyMs < 0) throw new Error('Invalid decision latency');
      const key = canonicalJson([entrantId, decision.source]);
      const group = groups.get(key);
      if (group) group.samples++; else groups.set(key, { entrantId, source: decision.source, samples: 1 });
      const json = canonicalJson([key, decision.latencyMs]);
      const pending = sorter.add({ json, keys: [key, decision.latencyMs] }, Buffer.byteLength(json));
      if (pending) await pending;
    }
  }
  const result: LatencySummary[] = [];
  let current: { key: string; summary: LatencySummary; index: number; p50: number; p95: number } | undefined;
  for await (const item of sorter.sorted()) {
    const key = item.keys[0] as string, value = item.keys[1] as number;
    if (current?.key !== key) {
      const group = groups.get(key)!;
      current = { key, index: 0, p50: Math.ceil(group.samples * 0.5) - 1, p95: Math.ceil(group.samples * 0.95) - 1, summary: { entrantId: group.entrantId, source: group.source, samples: group.samples, p50Ms: null, p95Ms: null, method: 'nearest_rank/1' } };
      result.push(current.summary);
    }
    if (current.index === current.p50) current.summary.p50Ms = value;
    if (current.index === current.p95) current.summary.p95Ms = value;
    current.index++;
  }
  return result;
}

function usageSummaries(groups: ReadonlyMap<string, UsageGroup>, entrants: readonly EntrantRow[], authoring: boolean): UsageSummary[] {
  const summaries = [...groups.entries()].sort(([a], [b]) => cmp(a, b)).map(([, group]): UsageSummary => ({
    entrantId: group.entrantId, phase: group.phase, reporter: group.reporter, currency: group.currency, samples: group.samples,
    coverage: group.complete ? 'complete' : group.unknown ? 'unknown' : 'partial',
    inputTokens: group.inputTokens, outputTokens: group.outputTokens, cacheReadTokens: group.cacheReadTokens, cacheWriteTokens: group.cacheWriteTokens, costAmount: group.cost ? costText(group.cost) : null,
  }));
  for (const entrant of entrants) for (const phase of authoring ? ['authoring', 'inference'] as const : ['inference'] as const) {
    if (!summaries.some((summary) => summary.entrantId === entrant.entrantId && summary.phase === phase)) summaries.push({ entrantId: entrant.entrantId, phase, reporter: null, currency: null, samples: 0, coverage: 'unknown', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costAmount: null });
  }
  return summaries.sort((a, b) => cmp(canonicalJson([a.entrantId, a.phase, a.reporter, a.currency]), canonicalJson([b.entrantId, b.phase, b.reporter, b.currency])));
}

/** Exact metadata tables of the snapshot; all are bounded by the series schedule and attempt limits. */
interface Bounded { entrants: EntrantRow[]; schedule: ResultsEnvelope['tables']['schedule'][number][]; matches: MatchRow[]; standings: StandingRow[] }
function boundedTables(snap: Snapshot): Bounded {
  const { record, attempts } = snap;
  return {
    entrants: sortRows(record.spec.entrants.map(entrant), 'entrants'),
    schedule: sortRows(record.trials.map((trial) => project(trial as unknown as Row, RESULT_COLUMNS.schedule, ARENA_OBJECT_LIMITS.options) as unknown as ResultsEnvelope['tables']['schedule'][number]), 'schedule'),
    matches: sortRows(attempts.map((attempt) => ({ ...project(attempt, RESULT_COLUMNS.matches, ARENA_OBJECT_LIMITS.options), spec: exportMatchSpec(attempt.spec), outcomes: attempt.outcomes.map((row) => project(row, ['team', 'rank', 'outcome', 'reason'])) })), 'matches'),
    standings: sortRows(standings(record.spec, record.trials, attempts), 'standings'),
  };
}
const isBounded = (table: Table): table is keyof Bounded => table === 'entrants' || table === 'schedule' || table === 'matches' || table === 'standings';

function headOf(snap: Snapshot, scan: Scan, bounded: Bounded, latency: LatencySummary[]): Head {
  const { record, selected, update, attempts, shared } = snap;
  const state = update?.state ?? 'queued';
  const updatedAt = update?.at ?? record.createdAt;
  const terminal = state === 'completed' || state === 'aborted' || state === 'failed';
  const recording = [...record.updates].filter((entry) => entry.revision <= selected && entry.recording).sort((a, b) => b.revision - a.revision)[0]?.recording;
  const tables = Object.fromEntries(TABLE_KEYS.map((table) => [table, isBounded(table)
    ? { rows: bounded[table].length, bytes: byteLength(bounded[table]) }
    : { rows: scan.rows[table], bytes: scan.rows[table] ? 2 + scan.bytes[table] + scan.rows[table] - 1 : 2 }])) as ResultsEnvelope['accounting']['tables'];
  return {
    format: 'playerthree.results', version: 1, seriesId: record.id, revision: selected, state,
    createdAt: record.createdAt, updatedAt, completedAt: terminal ? updatedAt : null, comparisonHash: record.comparisonHash, spec: exportSeriesSpec(record.spec),
    activeMatches: (update?.activeMatches ?? []).map((active) => ({ matchId: active.matchId, attemptId: active.attemptId, trialId: active.trialId, attemptNumber: active.attemptNumber, startedAt: active.startedAt, spec: exportMatchSpec(active.spec), releaseAt: active.releaseAt })).sort((a, b) => cmp(a.matchId, b.matchId)),
    summaries: { latency, usage: usageSummaries(scan.usage, bounded.entrants, record.spec.authoring !== undefined) },
    accounting: { provenance: shared ? 'shared_projection' : 'recorded_chunks', tables, recordedBytes: scan.recordedBytes, chunks: scan.chunks },
    completeness: { scheduleComplete: record.trials.every((trial) => attempts.some((attempt) => attempt.trialId === trial.trialId && attempt.acceptedAttempt)), rawComplete: !recording && (selected !== record.revision || record.rawComplete !== false), missing: [...(recording?.missing ?? (selected === record.revision ? record.missing : undefined) ?? [])].sort(cmp) },
    retention: { expiresAt: record.expiresAt, maxBytes: record.limits.maxBytes, bytes: scan.recordedBytes + scan.artifactBytes },
    disclosure: { audience: shared ? 'shared' : 'owner', commentary: snap.commentary },
  };
}

/**
 * Bounded live view of a committed (and, when shared, released) revision. Bounded metadata tables are complete;
 * each raw table keeps at most 2000 rows — metrics evenly strided per (match, scope, side, seat, metric) series,
 * other tables as their canonical prefix — and `sampling` labels every table. Accounting, latency quantiles, usage
 * totals, completeness and retention are exact over all rows. The shared projection is the export's.
 */
export async function buildResultsSummary(record: StoredSeries, iterate: () => AsyncIterable<StoredResultChunk>, revision?: number, policy?: SharePolicy, now = Date.now()): Promise<ResultsSummary> {
  const snap = snapshotOf(record, revision, policy, now);
  const spill = new Spill();
  try {
    const prefixes = Object.fromEntries(RAW_TABLES.map((table) => [table, new Prefix(SUMMARY_LIMIT)])) as Record<RawTable, Prefix>;
    const scan = await scanRows(snap, iterate, (table, item) => prefixes[table].add(item));
    const stride = scan.rows.metrics > SUMMARY_LIMIT ? new Stride(scan.series, SUMMARY_LIMIT) : undefined;
    const latency = await latencyPass(snap, iterate, scan, spill, stride);
    const bounded = boundedTables(snap);
    const raw = Object.fromEntries(RAW_TABLES.map((table) => [table, table === 'metrics' && stride ? stride.rows() : prefixes[table].rows()])) as Record<RawTable, Row[]>;
    const sampling: ResultsSummary['sampling'] = { limit: SUMMARY_LIMIT, tables: Object.fromEntries(TABLE_KEYS.map((table) => {
      if (isBounded(table)) return [table, { rows: bounded[table].length, included: bounded[table].length, method: 'complete' }];
      const rows = scan.rows[table], included = raw[table].length;
      return [table, { rows, included, method: rows <= SUMMARY_LIMIT ? 'complete' : table === 'metrics' ? 'stride_per_series' : 'sorted_prefix' }];
    })) as ResultsSummary['sampling']['tables'] };
    const head = headOf(snap, scan, bounded, latency);
    return { ...head, format: 'playerthree.results.summary', tables: { ...(raw as unknown as Omit<ResultsEnvelope['tables'], keyof Bounded>), ...bounded }, sampling };
  } finally { await spill.dispose(); }
}

/** Prepared full export: exact head plus re-iterable canonically ordered table streams over one spill directory. */
interface Prepared { head: Head; bounded: Bounded; sorters: Record<RawTable, Sorter> }
async function prepare(snap: Snapshot, iterate: () => AsyncIterable<StoredResultChunk>, spill: Spill): Promise<Prepared> {
  const sorters = Object.fromEntries(RAW_TABLES.map((table) => [table, tableSorter(spill, table)])) as Record<RawTable, Sorter>;
  const scan = await scanRows(snap, iterate, (table, item, size) => sorters[table].add(item, size));
  const latency = await latencyPass(snap, iterate, scan, spill);
  const bounded = boundedTables(snap);
  return { head: headOf(snap, scan, bounded, latency), bounded, sorters };
}
async function* tableItems(prepared: Prepared, table: Table): AsyncIterable<Item> {
  if (isBounded(table)) { for (const row of prepared.bounded[table]) yield { json: canonicalJson(row), keys: [], row: row as unknown as Row }; return; }
  yield* prepared.sorters[table].sorted();
}
const SORTED_TABLES = [...TABLE_KEYS].sort(cmp);
/** Canonical JSON of the envelope, emitted part by part: sorted object keys, tables streamed row by row. */
async function* envelopeParts(prepared: Prepared): AsyncIterable<string> {
  const value: Record<string, unknown> = { ...prepared.head, tables: null };
  yield '{';
  let first = true;
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue;
    yield `${first ? '' : ','}${JSON.stringify(key)}:`;
    first = false;
    if (key !== 'tables') { yield* canonicalParts(item); continue; }
    yield '{';
    for (const [index, table] of SORTED_TABLES.entries()) {
      yield `${index ? ',' : ''}${JSON.stringify(table)}:[`;
      let row = 0;
      for await (const entry of tableItems(prepared, table)) { if (row++) yield ','; yield entry.json; }
      yield ']';
    }
    yield '}';
  }
  yield '}';
}

/**
 * Streams the complete `playerthree.results` v1 download of a committed revision with bounded memory: the canonical
 * JSON envelope (identical bytes to `canonicalJson(envelope)`), or the CSV ZIP of one RFC-4180 table per file plus
 * `schema.json`, `spec.json` and `manifest.json`. Rows are ordered by an external merge sort whose temporary run files
 * live in a private os.tmpdir() directory that is removed when the stream ends, fails or is abandoned.
 */
export async function* exportStoredResults(record: StoredSeries, iterate: () => AsyncIterable<StoredResultChunk>, format: 'json' | 'csv', revision?: number, policy?: SharePolicy, now = Date.now()): AsyncIterable<Uint8Array> {
  if (format !== 'json' && format !== 'csv') throw new Error('Unsupported results export format');
  const snap = snapshotOf(record, revision, policy, now);
  const spill = new Spill();
  try {
    const prepared = await prepare(snap, iterate, spill);
    if (format === 'json') { yield* encodeParts(envelopeParts(prepared)); return; }
    const digest = createHash('sha256');
    for await (const part of envelopeParts(prepared)) digest.update(part);
    const manifests = csvManifests(prepared.head, prepared.bounded.standings, digest.digest('hex'));
    async function* files(): AsyncIterable<{ name: string; chunks: AsyncIterable<Uint8Array> }> {
      for (const table of TABLE_KEYS) {
        async function* lines(): AsyncIterable<string> {
          yield csvHeader(table);
          for await (const item of tableItems(prepared, table)) yield csvLine(table, item.row ?? JSON.parse(item.json) as Row);
        }
        yield { name: `${table}.csv`, chunks: encodeParts(lines()) };
      }
      for (const [name, content] of manifests) yield { name, chunks: encodeParts([content]) };
    }
    yield* zip(files());
  } finally { await spill.dispose(); }
}

/** SHA-256 over the exact canonical UTF-8 JSON download, including format/version/revision. */
export function resultsDigest(envelope: ResultsEnvelope): string {
  const digest = createHash('sha256');
  for (const part of canonicalParts(envelope)) digest.update(part);
  return digest.digest('hex');
}

/** RFC 4180; null is \\N, literal leading backslash is doubled, formula/apostrophe strings gain one apostrophe. */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '\\N';
  else if (typeof value === 'string') {
    text = value.startsWith('\\') ? `\\${value}` : /^[=+\-@\t\r\n']/.test(value) ? `'${value}` : value;
  } else text = typeof value === 'object' ? canonicalJson(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const FOREIGN_KEYS = {
  schedule: { sideBindings: 'entrants.entrantId' }, matches: { trialId: 'schedule.trialId' }, seats: { matchId: 'matches.matchId', entrantId: 'entrants.entrantId' },
  metrics: { matchId: 'matches.matchId' }, causes: { matchId: 'matches.matchId' }, intents: { matchId: 'matches.matchId' }, decisions: { matchId: 'matches.matchId' },
  usage: { matchId: 'matches.matchId', entrantId: 'entrants.entrantId' }, events: { matchId: 'matches.matchId' }, standings: { entrantId: 'entrants.entrantId' }, artifacts: { matchId: 'matches.matchId' },
};

function csvManifests(head: Head, standingRows: readonly StandingRow[], digest: string): ReadonlyMap<string, string> {
  const schema = {
    format: 'playerthree.results.csv', version: 1, encoding: 'UTF-8', lineEndings: 'CRLF', delimiter: ',', quote: '"',
    null: '\\N', escaping: { strings: 'Double one leading backslash; otherwise prefix one apostrophe for a leading =,+,-,@,TAB,CR,LF,or apostrophe. Decode using column type before interpreting null.', structured: 'Canonical JSON in RFC-4180 cell; no spreadsheet evaluation.' },
    tables: Object.fromEntries(TABLE_KEYS.map((table) => [table, { columns: RESULT_COLUMNS[table], primaryKey: PRIMARY_KEYS[table], additionalProperties: false }])), foreignKeys: FOREIGN_KEYS,
    $defs: RESULTS_ENVELOPE_SCHEMA.$defs, rowSchemas: RESULT_ROW_SCHEMAS, envelopeSchema: RESULTS_ENVELOPE_SCHEMA,
    units: { tick: 'simulation ticks', atMs: 'simulated milliseconds', latencyMs: 'wall milliseconds', simulatedMs: 'simulated milliseconds', wallMs: 'wall milliseconds', commandApm: 'accepted commands per active simulated minute', alloyValue: 'resolved replacement alloy', energyValue: 'resolved replacement energy', costAmount: 'decimal string in currency; unknown=null', metric: 'metrics.unit (game-declared metric identity)', releaseAt: 'Unix milliseconds' },
    quantiles: 'nearest_rank/1', ratings: head.spec.rating, confidence: standingRows.map((row) => ({ entrantId: row.entrantId, ...row.confidence })),
  };
  const { spec: _spec, ...metadata } = head;
  return new Map([
    ['schema.json', canonicalJson(schema)],
    ['spec.json', canonicalJson(head.spec)],
    ['manifest.json', canonicalJson({ ...metadata, digest: { algorithm: 'sha256', canonicalJson: digest } })],
  ]);
}
const csvHeader = (table: Table) => RESULT_COLUMNS[table].map(csvCell).join(',') + '\r\n';
const csvLine = (table: Table, row: Row) => RESULT_COLUMNS[table].map((column) => csvCell(row[column])).join(',') + '\r\n';

/** CSV files of an already materialised (small) envelope for CLI report writers; same serializer as the streamed ZIP. */
export function serializeResultsCsv(envelope: ResultsEnvelope): ReadonlyMap<string, string> {
  const { tables, ...head } = envelope;
  const files = TABLE_KEYS.map((table): [string, string] => [`${table}.csv`, csvHeader(table) + (tables[table] as readonly unknown[]).map((row) => csvLine(table, row as Row)).join('')]);
  return new Map([...files, ...csvManifests(head, tables.standings, resultsDigest(envelope))]);
}

// ZIP32 stored entries, UTF-8 names, deterministic DOS date, streaming CRC/data descriptors; no whole archive buffer.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); return crc >>> 0;
});
function words(size: number, values: readonly [number, number, 2 | 4][]): Uint8Array {
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  for (const [offset, value, width] of values) if (width === 2) view.setUint16(offset, value, true); else view.setUint32(offset, value, true);
  return bytes;
}
async function* zip(files: AsyncIterable<{ name: string; chunks: AsyncIterable<Uint8Array> }>): AsyncIterable<Uint8Array> {
  let position = 0;
  const directory: { name: Uint8Array; offset: number; size: number; crc: number }[] = [];
  for await (const file of files) {
    const name = encoder.encode(file.name), offset = position;
    const header = words(30, [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0808, 2], [12, 33, 2], [26, name.byteLength, 2]]);
    yield header; yield name; position += header.byteLength + name.byteLength;
    let size = 0, crc = 0xffffffff;
    for await (const chunk of file.chunks) {
      size += chunk.byteLength; position += chunk.byteLength;
      if (position > 0xffffffff) throw new Error('Results ZIP exceeds ZIP32 limit');
      for (const byte of chunk) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]!;
      yield chunk;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = words(16, [[0, 0x08074b50, 4], [4, crc, 4], [8, size, 4], [12, size, 4]]);
    yield descriptor; position += descriptor.byteLength;
    directory.push({ name, offset, size, crc });
  }
  const start = position;
  for (const entry of directory) {
    const central = words(46, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0808, 2], [14, 33, 2], [16, entry.crc, 4], [20, entry.size, 4], [24, entry.size, 4], [28, entry.name.byteLength, 2], [42, entry.offset, 4]]);
    yield central; yield entry.name; position += central.byteLength + entry.name.byteLength;
  }
  yield words(22, [[0, 0x06054b50, 4], [8, directory.length, 2], [10, directory.length, 2], [12, position - start, 4], [16, start, 4]]);
}
