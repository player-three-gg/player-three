/**
 * JSON Schemas (draft 2020-12) of the arena documents — MatchSpec, SeriesSpec, result rows, series updates, results
 * envelope and summary — and their validators. Validation errors name schema paths only, never input values.
 */
import type { ArenaJsonSchema, EventDefinition, MatchSpec, ResultRows, ResultsEnvelope, ResultsSummary, SeriesSpec } from './arena.ts';
import { canonicalJson } from './briefing.ts';

const text: ArenaJsonSchema = { type: 'string', maxLength: 4096 };
const id: ArenaJsonSchema = { type: 'string', minLength: 1, maxLength: 256 };
const label: ArenaJsonSchema = { type: 'string', minLength: 1, maxLength: 256 };
const bool: ArenaJsonSchema = { type: 'boolean' };
const integer: ArenaJsonSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positive: ArenaJsonSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const finite: ArenaJsonSchema = { type: 'number', minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE };
const nonnegative: ArenaJsonSchema = { type: 'number', minimum: 0, maximum: Number.MAX_VALUE };
const probability: ArenaJsonSchema = { type: 'number', minimum: 0, maximum: 1 };
const decimal: ArenaJsonSchema = { type: 'string', maxLength: 128, pattern: '^\\d+(?:\\.\\d+)?$' };
const utc: ArenaJsonSchema = { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$', maxLength: 24 };
/** Resolved game configuration is wider than event metadata; both remain bounded. */
export const ARENA_OBJECT_LIMITS = { metadata: 128, options: 256 } as const;
const publicValue: ArenaJsonSchema = { $ref: '#/$defs/publicValue' };
const publicObject: ArenaJsonSchema = { type: 'object', maxProperties: ARENA_OBJECT_LIMITS.metadata, additionalProperties: publicValue, propertyNames: { type: 'string', maxLength: 128, pattern: '^(?!(?:owner(?:Id)?|commander(?:Id|Ref)?|memberId|roster(?:Id|Ref)?|ref|secret|password|credentials?|authorization|cookie|prompts?|systemPrompt|apiKey|apiUrl|endpoint|policyCode|chat|token|accessToken|refreshToken)$)[a-zA-Z][a-zA-Z0-9_.-]*$' } };
const optionsValue: ArenaJsonSchema = { $ref: '#/$defs/optionsValue' };
const optionsObject: ArenaJsonSchema = { ...publicObject, maxProperties: ARENA_OBJECT_LIMITS.options, additionalProperties: optionsValue };
const definitions: Readonly<Record<string, ArenaJsonSchema>> = {
  publicValue: { anyOf: [{ type: 'null' }, bool, finite, text, { type: 'array', maxItems: 4096, items: publicValue }, publicObject] },
  optionsValue: { anyOf: [{ type: 'null' }, bool, finite, text, { type: 'array', maxItems: 4096, items: optionsValue }, optionsObject] },
  dataSchema: object({
    type: { anyOf: [enumeration('object', 'array', 'string', 'number', 'integer', 'boolean', 'null'), list(enumeration('object', 'array', 'string', 'number', 'integer', 'boolean', 'null'), 7, 1)] },
    const: publicValue, enum: list(publicValue, 256, 1), anyOf: list({ $ref: '#/$defs/dataSchema' }, 32, 1),
    oneOf: list({ $ref: '#/$defs/dataSchema' }, 32, 1), format: { const: 'date-time' },
    properties: { type: 'object', maxProperties: 128, additionalProperties: { $ref: '#/$defs/dataSchema' } }, required: list(id, 128),
    additionalProperties: { anyOf: [bool, { $ref: '#/$defs/dataSchema' }] }, propertyNames: { $ref: '#/$defs/dataSchema' }, maxProperties: integer,
    items: { $ref: '#/$defs/dataSchema' }, minItems: integer, maxItems: integer, minLength: integer, maxLength: integer, pattern: text,
    minimum: finite, maximum: finite, exclusiveMinimum: finite, description: text,
  }, ['type', 'const', 'enum', 'anyOf', 'oneOf', 'properties', 'required', 'additionalProperties', 'propertyNames', 'maxProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'description', 'format']),
};
function object(properties: Readonly<Record<string, ArenaJsonSchema>>, optional: readonly string[] = []): ArenaJsonSchema {
  return { type: 'object', properties, required: Object.keys(properties).filter((key) => !optional.includes(key)), additionalProperties: false };
}
function list(items: ArenaJsonSchema, maxItems = 4096, minItems = 0): ArenaJsonSchema { return { type: 'array', items, maxItems, minItems }; }
function nullable(schema: ArenaJsonSchema): ArenaJsonSchema { return { anyOf: [schema, { type: 'null' }] }; }
function enumeration(...values: readonly string[]): ArenaJsonSchema { return { type: 'string', enum: values }; }
function document(name: string, schema: ArenaJsonSchema): ArenaJsonSchema {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `urn:playerthree:${name}:1`, $defs: definitions, ...schema };
}
const seatRef = object({ team: id, role: id });
const binding = object({ seat: seatRef, entrantId: id });
const map = object({ id, identity: id, seed: integer, layout: id });
const botOptions: ArenaJsonSchema = { type: 'object', maxProperties: 64, propertyNames: { type: 'string', maxLength: 128 }, additionalProperties: { anyOf: [finite, bool] } };
const card = object({ id, label, kind: enumeration('bot', 'agent', 'policy', 'human'), aiPlayer: bool, provider: label, model: label, selfReported: { const: true }, harness: object({ label, verified: bool }), scaffoldVersion: id, artifactHash: id, botVersion: id, botLevel: id, botOptions, stateResetSource: enumeration('runner', 'declared', 'not_applicable') }, ['provider', 'model', 'selfReported', 'harness', 'scaffoldVersion', 'artifactHash', 'botVersion', 'botLevel', 'botOptions', 'stateResetSource']);
const occupant: ArenaJsonSchema = { anyOf: [
  object({ kind: { const: 'human' }, memberId: id }), object({ kind: { const: 'open' } }), object({ kind: { const: 'closed' } }),
  object({ kind: { const: 'bot' }, level: id, options: botOptions }),
  object({ kind: { const: 'commander' }, ref: object({ id, kind: enumeration('agent', 'policy'), version: positive }, ['version']) }),
] };
const executionKind = enumeration('human', 'bot', 'agent', 'policy', 'none');
const privateSide = object({ id, spawnSlot: id, alliance: id, seats: list(object({ role: id, occupant }), 64, 1) });
const exportSide = object({ id, spawnSlot: id, alliance: id, seats: list(object({ role: id, kind: executionKind, entrantId: nullable(id) }), 64, 1) });
const matchFields = {
  format: { const: 'playerthree.match' }, version: { const: 1 }, game: id, gameVersion: id, surfaceHash: id, rulesHash: id, seed: integer, map,
  options: optionsObject, bindings: list(binding, 512), observerPolicy: object({ allowOmniscient: bool, minDelayMs: integer }),
  rules: object({ ranked: bool, coaching: enumeration('off', 'owner', 'game'), practiceReasons: list(text, 64) }),
} satisfies Record<string, ArenaJsonSchema>;
const privateMatch = object({ ...matchFields, sides: list(privateSide, 32, 1) });
const exportMatch = object({ ...matchFields, sides: list(exportSide, 32, 1) });
export const MATCH_SPEC_SCHEMA = document('playerthree.match', privateMatch);
export const EXPORT_MATCH_SPEC_SCHEMA = document('playerthree.export-match', exportMatch);
const elo = { algorithm: { const: 'elo' }, version: { const: 1 }, initial: finite, k: { type: 'number', exclusiveMinimum: 0 }, scale: { type: 'number', exclusiveMinimum: 0 } } satisfies Record<string, ArenaJsonSchema>;
const trueskill = { algorithm: { const: 'trueskill' }, version: { const: 1 }, mu: finite, sigma: { type: 'number', exclusiveMinimum: 0 }, beta: { type: 'number', exclusiveMinimum: 0 }, tau: nonnegative, drawProbability: { type: 'number', minimum: 0, maximum: 0.999999999 } } satisfies Record<string, ArenaJsonSchema>;
const rating: ArenaJsonSchema = { anyOf: [object(elo), object(trueskill)] };
const commentaryConsent = object({ entrantId: id, summaries: bool, chat: bool });
export const ARENA_HOST_EVENT_DEFINITIONS: readonly EventDefinition[] = [
  { kind: 'host.lifecycle', dataSchema: object({ state: enumeration('started', 'finished', 'forfeit', 'aborted', 'infra_error'), reason: text }, ['reason']) },
  { kind: 'commentary', dataSchema: object({ entrantId: id, category: enumeration('summary', 'chat'), text }) },
];
const seriesFields = {
  format: { const: 'playerthree.series' }, version: { const: 1 }, game: id, gameVersion: id, surfaceHash: id, track: enumeration('bots', 'policy', 'live', 'gauntlet'), entrants: list(card, 200, 1),
  authoring: object({ practiceSeeds: list(integer, 200, 1), maxOutputTokens: positive, maxWallMs: positive, starters: { type: 'object', maxProperties: 64, propertyNames: { type: 'string', minLength: 1, maxLength: 256 }, additionalProperties: { type: 'string', minLength: 1, maxLength: 512 } } }, ['starters']),
  scenarios: list(object({ id, seed: integer, map, options: optionsObject }), 200, 1),
  permutations: list(object({ id, sideEntrants: list(object({ team: id, entrantId: id }), 32, 1) }), 200, 1), repetitions: { type: 'integer', minimum: 1, maximum: 200 },
  execution: object({ concurrency: { type: 'integer', minimum: 1, maximum: 200 }, speed: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 }, clock: enumeration('realtime', 'accelerated', 'decision_barrier'), maxTicks: positive, maxWallMs: positive, maxInfraRetries: { type: 'integer', minimum: 0, maximum: 100 }, state: enumeration('reset_each_match', 'carry_within_series'), abortOn: list(enumeration('infrastructure'), 1) }, ['abortOn']),
  budgets: object({ maxTokens: nullable(integer), maxCostUsd: nullable(decimal), maxTurns: nullable(integer) }), rating,
  telemetry: object({ sampleEveryTicks: positive, includeCommentary: bool, commentaryConsents: list(commentaryConsent, 200), metricDefinitions: list(object({ metric: id, scope: enumeration('match', 'side', 'seat'), unit: id, interpretation: enumeration('stock', 'cumulative', 'rate', 'configuration') }), 1024), eventDefinitions: list(object({ kind: id, dataSchema: { $ref: '#/$defs/dataSchema' } }), 1024) }, ['commentaryConsents', 'metricDefinitions', 'eventDefinitions']),
} satisfies Record<string, ArenaJsonSchema>;
export const SERIES_SPEC_SCHEMA = document('playerthree.series', object({ ...seriesFields, template: privateMatch, entrantSeats: list(object({ entrantId: id, seats: list(object({ role: id, occupant }), 64, 1) }), 200, 1) }, ['entrantSeats', 'authoring']));
const exportSeries = object({ ...seriesFields, template: exportMatch, entrantSeats: list(object({ entrantId: id, seats: list(object({ role: id, kind: executionKind, entrantId: id }), 64, 1) }), 200, 1) }, ['entrantSeats', 'authoring']);
export const EXPORT_SERIES_SPEC_SCHEMA = document('playerthree.export-series', exportSeries);
const outcome = object({ team: id, rank: nullable(integer), outcome: enumeration('win', 'loss', 'draw', 'aborted'), reason: text });
const confidence = object({ method: { const: 'seed_block_bootstrap' }, version: { const: 1 }, seed: integer, replicates: positive, blocks: integer, level: probability, winRate: nullable(list(probability, 2, 2)), scoreRate: nullable(list(probability, 2, 2)), independent: bool });
const standing = object({
  entrantId: id, wins: integer, losses: integer, draws: integer, games: integer, winRate: nullable(probability), scoreRate: nullable(probability), rating: nullable(finite), mu: nullable(finite), sigma: nullable(nonnegative), conservativeRating: nullable(finite),
  ratingParameters: { anyOf: [object({ ...elo, conservativeMultiplier: nonnegative, minDelta: nullable(nonnegative) }), object({ ...trueskill, conservativeMultiplier: nonnegative, minDelta: nullable(nonnegative) })] },
  ratingImplementation: enumeration('elo/1', 'ts-trueskill/5.1.0'), provisional: bool, averageSimulatedMs: nullable(nonnegative), averageWallMs: nullable(nonnegative), confidence,
});
export const RESULT_ROW_SCHEMAS = {
  entrants: object({ entrantId: id, kind: enumeration('bot', 'agent', 'policy', 'human'), label, aiPlayer: bool, provider: nullable(label), model: nullable(label), selfReported: bool, harness: nullable(label), harnessVerified: bool, scaffoldVersion: nullable(id), artifactHash: nullable(id), botVersion: nullable(id), botLevel: nullable(id), botOptions: nullable(botOptions), stateResetSource: nullable(enumeration('runner', 'declared', 'not_applicable')) }),
  schedule: object({ trialId: id, scenarioId: id, permutationId: id, repetition: integer, scheduleIndex: integer, seed: integer, mapId: id, mapIdentity: id, mapSeed: integer, layoutId: id, rulesHash: id, surfaceHash: id, resolvedOptions: optionsObject, sideBindings: list(object({ team: id, entrantId: id }), 32, 1) }),
  matches: object({ matchId: id, trialId: id, attemptId: id, attemptNumber: positive, revision: positive, status: enumeration('finished', 'forfeit', 'aborted', 'infra_error'), acceptedAttempt: bool, startedAt: utc, endedAt: utc, ticks: integer, simulatedMs: nonnegative, wallMs: nonnegative, terminalReason: text, outcomes: list(outcome, 32), spec: exportMatch, releaseAt: nonnegative }),
  seats: object({ matchId: id, team: id, role: id, entrantId: nullable(id), executionKind, fallbackKind: nullable(executionKind), artifactVersion: nullable(integer), artifactHash: nullable(id), readyState: id, activeTicks: nullable(integer), submittedIntents: nullable(integer), acceptedIntents: nullable(integer), rejectedIntents: nullable(integer), commandApm: nullable(nonnegative), policyErrors: nullable(integer) }),
  metrics: object({ matchId: id, tick: integer, sequence: integer, scope: enumeration('match', 'side', 'seat'), team: nullable(id), role: nullable(id), metric: id, value: finite, unit: id }),
  causes: object({ matchId: id, sequence: integer, tick: integer, victimTeam: id, victimRole: id, victimKind: id, attackerTeam: nullable(id), attackerRole: nullable(id), attackerKind: nullable(id), cause: id, count: integer, alloyValue: nonnegative, energyValue: nonnegative }),
  intents: object({ matchId: id, team: id, role: id, source: id, code: id, submitted: integer, accepted: integer, rejected: integer }),
  decisions: object({ matchId: id, team: id, role: id, decisionId: id, startedAt: utc, finishedAt: utc, latencyMs: nonnegative, source: enumeration('runner', 'provider', 'self_report', 'host_gap'), status: id }),
  usage: object({ matchId: nullable(id), phase: enumeration('authoring', 'inference'), team: nullable(id), role: nullable(id), entrantId: id, executionId: id, decisionId: nullable(id), reporter: enumeration('runner', 'reported', 'estimated', 'unpriced'), inputTokens: nullable(integer), outputTokens: nullable(integer), cacheReadTokens: nullable(integer), cacheWriteTokens: nullable(integer), costAmount: nullable(decimal), currency: nullable(id), pricingVersion: nullable(id), coverage: enumeration('complete', 'partial', 'unknown') }),
  events: object({ matchId: id, sequence: integer, tick: integer, atMs: nonnegative, kind: id, team: nullable(id), role: nullable(id), data: publicObject }),
  standings: standing,
  artifacts: object({ id, matchId: nullable(id), kind: enumeration('replay', 'recording'), format: id, version: positive, sha256: text, bytes: integer, availability: enumeration('available', 'not_recorded', 'expired'), releaseAt: nullable(nonnegative), expiresAt: nullable(utc) }),
} satisfies Record<keyof ResultsEnvelope['tables'], ArenaJsonSchema>;
const tableAccounting = object(Object.fromEntries(Object.keys(RESULT_ROW_SCHEMAS).map((name) => [name, object({ rows: integer, bytes: integer })])));
const activeMatch = object({ matchId: id, attemptId: id, trialId: id, attemptNumber: positive, startedAt: utc, spec: exportMatch, releaseAt: nonnegative });
export const ACTIVE_MATCH_SCHEMA = document('playerthree.active-match', activeMatch);
export const SERIES_UPDATE_SCHEMA = document('playerthree.series-update', object({ seriesId: id, revision: positive, at: utc, state: enumeration('queued', 'running', 'aborting', 'completed', 'aborted', 'failed'), completed: integer, total: integer, standings: list(standing, 200), activeMatches: list(activeMatch, 200), releaseAt: nonnegative, recording: object({ rawComplete: { const: false }, missing: list(text) }) }, ['recording']));
const envelopeFields = {
  version: { const: 1 }, seriesId: id, revision: integer, state: enumeration('queued', 'running', 'aborting', 'completed', 'aborted', 'failed'), createdAt: utc, updatedAt: utc, completedAt: nullable(utc), comparisonHash: id, spec: exportSeries,
  activeMatches: list(activeMatch, 200),
  tables: object(Object.fromEntries(Object.entries(RESULT_ROW_SCHEMAS).map(([name, schema]) => [name, list(schema, Number.MAX_SAFE_INTEGER)]))),
  summaries: object({ latency: list(object({ entrantId: id, source: enumeration('runner', 'provider', 'self_report', 'host_gap'), samples: integer, p50Ms: nullable(nonnegative), p95Ms: nullable(nonnegative), method: { const: 'nearest_rank/1' } })), usage: list(object({ entrantId: id, phase: enumeration('authoring', 'inference'), reporter: nullable(enumeration('runner', 'reported', 'estimated', 'unpriced')), currency: nullable(id), samples: integer, coverage: enumeration('complete', 'partial', 'unknown'), inputTokens: nullable(integer), outputTokens: nullable(integer), cacheReadTokens: nullable(integer), cacheWriteTokens: nullable(integer), costAmount: nullable(decimal) })) }),
  // One aggregate per attempt: chunk count, byte total and SHA-256 over the concatenated hex chunk checksums in index order.
  accounting: object({ provenance: enumeration('recorded_chunks', 'shared_projection'), tables: tableAccounting, recordedBytes: integer, chunks: list(object({ attemptId: id, chunks: positive, bytes: integer, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }), Number.MAX_SAFE_INTEGER) }),
  completeness: object({ scheduleComplete: bool, rawComplete: bool, missing: list(text) }), retention: object({ expiresAt: utc, maxBytes: integer, bytes: integer }), disclosure: object({ audience: enumeration('owner', 'shared'), commentary: bool }),
} satisfies Record<string, ArenaJsonSchema>;
export const RESULTS_ENVELOPE_SCHEMA = document('playerthree.results', object({ format: { const: 'playerthree.results' }, ...envelopeFields }));
const sampledTable = object({ rows: integer, included: integer, method: enumeration('complete', 'sorted_prefix', 'stride_per_series') });
export const RESULTS_SUMMARY_SCHEMA = document('playerthree.results.summary', object({
  format: { const: 'playerthree.results.summary' }, ...envelopeFields,
  sampling: object({ limit: positive, tables: object(Object.fromEntries(Object.keys(RESULT_ROW_SCHEMAS).map((name) => [name, sampledTable]))) }),
}));
function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  return canonicalJson(left) === canonicalJson(right);
}

/** Errors expose schema paths only, never rejected input or provider payloads. */
function check(schema: ArenaJsonSchema, value: unknown, path: string, depth = 0): void {
  if (depth > 64) throw new Error(`${path}: depth`);
  if (Array.isArray(schema.type)) {
    check({ ...schema, type: undefined, anyOf: schema.type.map((type) => ({ ...schema, type })) }, value, path, depth + 1); return;
  }
  if (schema.$ref) {
    const target = definitions[schema.$ref.slice('#/$defs/'.length)];
    if (!target) throw new Error('Unknown arena schema reference');
    check(target, value, path, depth + 1); return;
  }
  if ('const' in schema && !equalJson(value, schema.const)) throw new Error(`${path}: const`);
  if (schema.enum && !schema.enum.some((item) => equalJson(value, item))) throw new Error(`${path}: enum`);
  if (schema.anyOf || schema.oneOf) {
    let matches = 0;
    for (const variant of schema.anyOf ?? schema.oneOf!) {
      try { check(variant, value, path, depth + 1); matches++; if (schema.anyOf) break; } catch { /* Count matching closed variants. */ }
    }
    if (matches === 0 || (schema.oneOf && matches !== 1)) throw new Error(`${path}: schema variants`);
  }
  if (schema.type === 'null' && value !== null) throw new Error(`${path}: null`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path}: boolean`);
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))) throw new Error(`${path}: number`);
    if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)) throw new Error(`${path}: range`);
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path}: string`);
    if ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value))) throw new Error(`${path}: string bounds`);
    if (schema.format === 'date-time' && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) throw new Error(`${path}: UTC timestamp`);
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path}: array`);
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) throw new Error(`${path}: array bounds`);
    if (schema.items) value.forEach((item, index) => check(schema.items!, item, `${path}[${index}]`, depth + 1));
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error(`${path}: object`);
    const object = value as Record<string, unknown>, properties = schema.properties ?? {};
    if (schema.maxProperties !== undefined && Object.keys(object).length > schema.maxProperties) throw new Error(`${path}: object bounds`);
    for (const required of schema.required ?? []) if (!Object.hasOwn(object, required)) throw new Error(`${path}.${required}: required`);
    for (const [key, item] of Object.entries(object)) {
      if (Object.hasOwn(properties, key)) check(properties[key]!, item, `${path}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) throw new Error(`${path}: unknown field`);
      else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, item, `${path}.*`, depth + 1);
      if (schema.propertyNames) check(schema.propertyNames, key, `${path}: key`, depth + 1);
    }
  }
}
/** Throws (schema path only) unless `value` is a valid SeriesSpec with bounded, self-contained event schemas. */
export function validateSeriesSpec(value: unknown): SeriesSpec {
  check(SERIES_SPEC_SCHEMA, value, 'series');
  const spec = value as SeriesSpec;
  for (const definition of spec.telemetry.eventDefinitions ?? []) boundedGameSchema(definition.dataSchema);
  return spec;
}
/** Throws with a schema path (never the input) unless `value` is a valid MatchSpec. */
export function validateMatchSpec(value: unknown): MatchSpec { check(MATCH_SPEC_SCHEMA, value, 'match'); return value as MatchSpec; }
/** Throws with a schema path (never the input) unless `value` is a valid `playerthree.results` envelope. */
export function validateResultsEnvelope(value: unknown): ResultsEnvelope { check(RESULTS_ENVELOPE_SCHEMA, value, 'results'); return value as ResultsEnvelope; }
/** Throws with a schema path (never the input) unless `value` is a valid `playerthree.results.summary`. */
export function validateResultsSummary(value: unknown): ResultsSummary { check(RESULTS_SUMMARY_SCHEMA, value, 'summary'); return value as ResultsSummary; }
/** Validate recorder table columns before persistence; metadata payload semantics are additionally game-schema validated. */
export function validateResultRows(value: unknown): asserts value is Partial<ResultRows> {
  const tables = Object.entries(RESULT_ROW_SCHEMAS).filter(([key]) => !['entrants', 'schedule', 'matches', 'standings'].includes(key));
  const properties = Object.fromEntries(tables.map(([key, schema]) => [key, list(key === 'artifacts' ? { ...schema, required: schema.required?.filter((field) => !['matchId', 'releaseAt', 'expiresAt'].includes(field)) } : schema, 65536)]));
  check(document('playerthree.result-chunk', object(properties, Object.keys(properties))), value, 'rows');
}

function boundedGameSchema(schema: ArenaJsonSchema, depth = 0): void {
  if (depth > 32 || schema.$ref || schema.$defs) throw new Error('Event schema must be bounded and self-contained');
  if (schema.anyOf || schema.oneOf) { for (const item of schema.anyOf ?? schema.oneOf!) boundedGameSchema(item, depth + 1); return; }
  if (schema.const !== undefined || schema.enum) return;
  const types = typeof schema.type === 'string' ? [schema.type] : schema.type ?? [];
  if (types.length === 0) throw new Error('Event schema must declare a type');
  for (const type of types) {
    // Pattern-locked IDs reuse the protocol DSL; the enclosing public row schema still caps all strings at 4096.
    if (type === 'string' && schema.maxLength === undefined && schema.pattern === undefined) throw new Error('Event string schema must declare maxLength or a locked pattern');
    if (type === 'array') {
      if (!schema.items || schema.maxItems === undefined) throw new Error('Event array schema must declare items/maxItems');
      boundedGameSchema(schema.items, depth + 1);
    }
    if (type === 'object') {
      if (schema.additionalProperties !== false) throw new Error('Event objects must declare closed properties');
      for (const child of Object.values(schema.properties ?? {})) boundedGameSchema(child, depth + 1);
    }
  }
}

/** Checks recorder rows against the series' declared metric identities/scopes and event kinds and data schemas. */
export function validateTelemetryRows(rows: Partial<ResultRows>, telemetry: SeriesSpec['telemetry']): void {
  for (const row of rows.metrics ?? []) {
    if (!telemetry.metricDefinitions?.some((definition) => definition.metric === row.metric && definition.scope === row.scope && definition.unit === row.unit)) throw new Error('Undeclared metric identity, scope or unit');
    if ((row.scope === 'match' && (row.team !== null || row.role !== null)) || (row.scope === 'side' && (row.team === null || row.role !== null)) || (row.scope === 'seat' && (row.team === null || row.role === null))) throw new Error('Metric scope attribution mismatch');
  }
  for (const row of rows.events ?? []) {
    const definition = telemetry.eventDefinitions?.find((definition) => definition.kind === row.kind);
    if (!definition) throw new Error('Undeclared timeline event kind');
    boundedGameSchema(definition.dataSchema);
    check(definition.dataSchema, row.data, 'event.data');
  }
}
