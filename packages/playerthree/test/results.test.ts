import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetricRow, ResultRows, ResultsEnvelope, SharePolicy } from '../src/arena.ts';
import { canonicalJson } from '../src/briefing.ts';
import { ARENA_HOST_EVENT_DEFINITIONS, buildResultsSummary, csvCell, exportMatchSpec, exportSeriesSpec, exportStoredResults, RESULT_COLUMNS, resultsDigest, serializeResultsCsv, validateMatchSpec, validateResultRows, validateResultsEnvelope, validateResultsSummary, validateSeriesSpec, validateTelemetryRows } from '../src/results.ts';
import { chunkOf, collect, CREATED, ENDED, envelopeOf, fixtureChunks, seriesFixture, type SeriesFixture } from './arena-fixtures.ts';

const NOW = Date.parse('2000-01-15T00:00:00.000Z');
const SHARE: SharePolicy = { commentary: false, expiresAt: '2000-02-01T00:00:00.000Z', notBefore: 0, consentedEntrants: ['alpha'] };
const bytes = collect;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Read the standard central directory, not the writer's implementation-specific chunk boundaries. */
function unzipStored(archive: Buffer): Map<string, string> {
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  let cursor = archive.readUInt32LE(end + 16);
  const result = new Map<string, string>();
  for (let count = 0; count < archive.readUInt16LE(end + 10); count++) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(archive.readUInt16LE(cursor + 10)).toBe(0);
    expect(archive.readUInt16LE(cursor + 8) & 0x800).toBe(0x800);
    const size = archive.readUInt32LE(cursor + 24), nameLength = archive.readUInt16LE(cursor + 28);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const local = archive.readUInt32LE(cursor + 42);
    expect(archive.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + size);
    expect(crc32(data)).toBe(archive.readUInt32LE(cursor + 16));
    expect(archive.readUInt32LE(start + size)).toBe(0x08074b50);
    result.set(name, data.toString('utf8'));
    cursor += 46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  return result;
}
function parseCsv(csv: string): string[][] {
  const result: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!;
    if (char === '"') { if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\r' && csv[i + 1] === '\n' && !quoted) { row.push(cell); result.push(row); row = []; cell = ''; i++; }
    else cell += char;
  }
  expect(quoted).toBe(false); return result;
}

describe('canonical arena results', () => {
  it('exports every declared table, exact map/rules/seeds/bindings, cards and raw samples without private refs', async () => {
    const f = seriesFixture(), { record } = f, envelope = await envelopeOf(f);
    expect(validateResultsEnvelope(envelope)).toBe(envelope);
    expect(envelope.tables.matches).toHaveLength(2);
    expect(envelope.tables.schedule.map((row) => row.seed)).toEqual([7, 11]);
    expect(envelope.tables.schedule[0]).toMatchObject({ rulesHash: record.spec.template.rulesHash, mapIdentity: record.spec.template.map.identity, sideBindings: record.trials[0]!.sideBindings });
    expect(envelope.tables.entrants[0]).toMatchObject({ entrantId: 'alpha', harnessVerified: false, selfReported: true, stateResetSource: 'declared' });
    expect(envelope.tables.metrics.map((row) => [row.tick, row.value])).toEqual([[0, 100], [20, 80]]);
    expect(envelope.tables.causes[0]).toMatchObject({ attackerTeam: null, cause: 'environment', alloyValue: 20, energyValue: 5 });
    expect(envelope.tables.intents[0]?.code).toBe('game.invalid_target');
    expect(envelope.tables.artifacts[0]).toMatchObject({ availability: 'available', releaseAt: null, expiresAt: null });
    expect(envelope.tables.matches[0]!.spec).toEqual(exportMatchSpec(record.trials[0]!.spec));
    expect(envelope.spec.entrantSeats?.[0]?.seats[0]).toEqual({ role: 'surface', kind: 'agent', entrantId: 'alpha' });
    expect(envelope.spec.telemetry.metricDefinitions).toEqual(record.spec.telemetry.metricDefinitions);
    expect(canonicalJson(envelope)).not.toContain('PRIVATE_');
    expect(envelope.completeness).toEqual({ scheduleComplete: true, rawComplete: true, missing: [] });
    for (const name of Object.keys(RESULT_COLUMNS) as (keyof typeof RESULT_COLUMNS)[]) {
      expect(envelope.accounting.tables[name]).toEqual({ rows: envelope.tables[name].length, bytes: Buffer.byteLength(canonicalJson(envelope.tables[name])) });
    }
  });

  it('streams JSON byte-identical to the canonical envelope with per-attempt checksum chains', async () => {
    const f = seriesFixture();
    const json = (await bytes(exportStoredResults(f.record, fixtureChunks(f), 'json'))).toString('utf8');
    const envelope = validateResultsEnvelope(JSON.parse(json));
    expect(json).toBe(canonicalJson(envelope));
    expect(resultsDigest(envelope)).toBe(sha256(json));
    const chunk = f.chunks[0]!.chunk;
    expect(envelope.accounting.chunks).toEqual([{ attemptId: 'attempt-0', chunks: 1, bytes: chunk.bytes, sha256: sha256(chunk.checksum) }]);
    expect(envelope.accounting.recordedBytes).toBe(chunk.bytes);
    expect(envelope.retention.bytes).toBe(chunk.bytes + 12);
    const second = chunkOf({ metrics: [{ matchId: 'match-0', tick: 40, sequence: 2, scope: 'side', team: 'blue', role: null, metric: 'economy.alloy', value: 60, unit: 'alloy' }] }, 1);
    f.chunks.push({ attemptId: 'attempt-0', chunk: second });
    expect((await envelopeOf(f)).accounting.chunks).toEqual([{ attemptId: 'attempt-0', chunks: 2, bytes: chunk.bytes + second.bytes, sha256: sha256(chunk.checksum + second.checksum) }]);
  });

  it('publishes explicit unknown usage and source-separated nearest-rank decision quantiles', async () => {
    const envelope = await envelopeOf(seriesFixture());
    expect(envelope.summaries.latency).toEqual([{ entrantId: 'alpha', source: 'runner', samples: 4, p50Ms: 20, p95Ms: 100, method: 'nearest_rank/1' }]);
    expect(envelope.summaries.usage.find((row) => row.entrantId === 'alpha')).toMatchObject({ inputTokens: 30, outputTokens: 8, cacheReadTokens: null, cacheWriteTokens: null, costAmount: '0.30', coverage: 'partial' });
    expect(envelope.summaries.usage.find((row) => row.entrantId === 'beta')).toMatchObject({ samples: 0, reporter: null, coverage: 'unknown', inputTokens: null, costAmount: null });
  });

  it('retains failed attempts and their usage without rating them or discarding authoring', async () => {
    const f = seriesFixture(), { record } = f;
    const failed = { ...record.attempts[0]!, attemptId: 'failed-attempt', attemptNumber: 1, matchId: 'failed-match', status: 'infra_error' as const, acceptedAttempt: false, outcomes: [], terminalReason: 'worker_lost' };
    record.attempts = [failed, { ...record.attempts[0]!, attemptNumber: 2 }, record.attempts[1]!];
    record.spec.authoring = { practiceSeeds: [999], maxOutputTokens: 1000, maxWallMs: 10000 };
    const original = f.chunks[0]!.chunk.rows.usage![0]!;
    const rows: Partial<ResultRows> = { usage: [{ ...original, matchId: 'failed-match', decisionId: 'failed-decision', inputTokens: null, costAmount: null }, { ...original, matchId: null, phase: 'authoring', decisionId: 'authoring-decision' }] };
    f.chunks.push({ attemptId: failed.attemptId, chunk: chunkOf(rows) });
    const envelope = await envelopeOf(f);
    expect(envelope.tables.matches).toHaveLength(3);
    expect(envelope.tables.standings.find((row) => row.entrantId === 'alpha')?.games).toBe(2);
    expect(envelope.tables.usage).toHaveLength(4);
    expect(envelope.summaries.usage.find((row) => row.phase === 'inference' && row.entrantId === 'alpha')?.costAmount).toBeNull();
    expect(envelope.summaries.usage.find((row) => row.phase === 'authoring' && row.entrantId === 'alpha')).toMatchObject({ samples: 1, costAmount: '0.10' });
    expect(envelope.spec.authoring?.practiceSeeds).toEqual([999]);
  });

  it('keeps historical revision bytes stable despite later completions, active recorder appends and failure', async () => {
    const f = seriesFixture(), { record } = f;
    const before = await bytes(exportStoredResults(record, fixtureChunks(f), 'json', 2));
    record.updatedAt = '2000-01-15T10:00:00.000Z'; record.rawComplete = false; record.missing = ['disk_write_failed'];
    record.revision = 4; record.state = 'failed';
    record.updates = [...record.updates, { ...record.updates[2]!, revision: 4, at: record.updatedAt, state: 'failed', recording: { rawComplete: false, missing: ['disk_write_failed'] } }];
    f.chunks.push({ attemptId: 'uncommitted', chunk: chunkOf({}) });
    expect(await bytes(exportStoredResults(record, fixtureChunks(f), 'json', 2))).toEqual(before);
    expect((await envelopeOf(f)).completeness).toMatchObject({ rawComplete: false, missing: ['disk_write_failed'] });
    expect((await envelopeOf(f, 2)).updatedAt).toBe(ENDED);
    await expect(envelopeOf(f, 999)).rejects.toThrow(/revision/);
    await expect(buildResultsSummary(record, fixtureChunks(f), 999)).rejects.toThrow(/revision/);
  });

  it('exposes revisioned real active match identity without inventing terminal outcomes', async () => {
    const f = seriesFixture(), { record } = f;
    record.attempts = [record.attempts[0]!];
    record.state = 'running';
    record.updates = record.updates.map((update) => update.revision === 3 ? { ...update, state: 'running', activeMatches: [{ matchId: 'actual-host-match', attemptId: 'attempt-1', trialId: 'trial-1', attemptNumber: 1, startedAt: CREATED, spec: exportMatchSpec(record.trials[1]!.spec), releaseAt: NOW + 1000 }] } : update);
    expect((await envelopeOf(f)).activeMatches).toMatchObject([{ matchId: 'actual-host-match', trialId: 'trial-1' }]);
    expect((await envelopeOf(f)).tables.matches).toHaveLength(1);
    expect((await envelopeOf(f, 2)).activeMatches).toEqual([]);
    expect((await envelopeOf(f, undefined, SHARE, NOW)).revision).toBe(2);
    expect((await envelopeOf(f, undefined, SHARE, NOW + 1001)).activeMatches[0]?.matchId).toBe('actual-host-match');
  });

  it('gates all shared correlated metadata at a revision-prefix watermark', async () => {
    const f = seriesFixture(), { record } = f;
    record.attempts = record.attempts.map((match) => ({ ...match, releaseAt: match.revision === 2 ? NOW + 1000 : 0 }));
    const hidden = await envelopeOf(f, undefined, SHARE, NOW);
    expect(hidden.revision).toBe(1); expect(hidden.state).toBe('running');
    expect(hidden.tables.matches).toEqual([]); expect(hidden.tables.metrics).toEqual([]);
    expect(hidden.tables.standings.every((row) => row.games === 0)).toBe(true);
    expect(hidden.completedAt).toBeNull(); expect(hidden.updatedAt).toBe(CREATED);
    await expect(envelopeOf(f, 3, SHARE, NOW)).rejects.toThrow(/revision/);
    expect((await envelopeOf(f, undefined, SHARE, NOW + 1001)).revision).toBe(3);
  });

  it('requires current category-specific consent and never leaks withheld source hashes or lengths', async () => {
    const f = seriesFixture(), { record } = f;
    const owner = await envelopeOf(f);
    const hidden = await envelopeOf(f, undefined, SHARE, NOW);
    expect(hidden.tables.events.map((event) => event.kind)).toEqual(['host.lifecycle']);
    expect(hidden.accounting.provenance).toBe('shared_projection');
    expect(hidden.accounting.chunks[0]?.sha256).not.toBe(owner.accounting.chunks[0]?.sha256);
    expect(hidden.accounting.chunks[0]?.bytes).toBeLessThan(owner.accounting.chunks[0]!.bytes);
    const visible = await envelopeOf(f, undefined, { ...SHARE, commentary: true }, NOW);
    expect(visible.tables.events.map((event) => event.kind)).toEqual(['host.lifecycle', 'commentary']);
    record.commentaryConsents = [{ entrantId: 'alpha', summaries: false, chat: true }];
    expect((await envelopeOf(f, undefined, { ...SHARE, commentary: true }, NOW)).tables.events).toHaveLength(1);
    expect((await envelopeOf(f)).tables.events).toHaveLength(2);
    await expect(envelopeOf(f, undefined, { ...SHARE, expiresAt: CREATED }, NOW)).rejects.toThrow(/unavailable/);
  });

  it('applies the same shared sanitisation to summaries and downloads', async () => {
    const f = seriesFixture();
    const summary = validateResultsSummary(await buildResultsSummary(f.record, fixtureChunks(f), undefined, SHARE, NOW));
    const envelope = await envelopeOf(f, undefined, SHARE, NOW);
    expect(summary.disclosure).toEqual({ audience: 'shared', commentary: false });
    expect(summary.tables.events.map((event) => event.kind)).toEqual(['host.lifecycle']);
    expect(summary.tables.usage.every((row) => /^execution_[a-f0-9]{24}$/.test(row.executionId))).toBe(true);
    expect(canonicalJson(summary)).not.toContain('PRIVATE_');
    const { format: _summaryFormat, sampling: _sampling, ...summaryBody } = summary;
    const { format: _envelopeFormat, ...envelopeBody } = envelope;
    expect(summaryBody).toEqual(envelopeBody);
  });

  it('canonicalizes table and object order and digests exact version/revision JSON bytes', async () => {
    const f = seriesFixture(), { record } = f, first = await envelopeOf(f);
    record.attempts = [...record.attempts].reverse();
    record.trials = [...record.trials].reverse();
    const rows = f.chunks[0]!.chunk.rows;
    f.chunks[0] = { attemptId: 'attempt-0', chunk: chunkOf({ ...rows, metrics: [...rows.metrics!].reverse(), usage: [...rows.usage!].reverse() }) };
    const second = await envelopeOf(f);
    expect(canonicalJson({ ...second, accounting: { ...second.accounting, chunks: [] } })).toBe(canonicalJson({ ...first, accounting: { ...first.accounting, chunks: [] } }));
    const json = await bytes(exportStoredResults(record, fixtureChunks(f), 'json'));
    expect(resultsDigest(second)).toBe(createHash('sha256').update(json).digest('hex'));
    expect(resultsDigest(await envelopeOf(f, 2))).not.toBe(resultsDigest(second));
  });

  it('streams deterministic standards-compliant ZIP tables and manifests matching the JSON download', async () => {
    const f = seriesFixture(), envelope = await envelopeOf(f), files = serializeResultsCsv(envelope);
    const archive = await bytes(exportStoredResults(f.record, fixtureChunks(f), 'csv'));
    expect(await bytes(exportStoredResults(f.record, fixtureChunks(f), 'csv'))).toEqual(archive);
    const extracted = unzipStored(archive);
    expect(extracted).toEqual(files);
    expect(extracted.size).toBe(Object.keys(RESULT_COLUMNS).length + 3);
    for (const table of Object.keys(RESULT_COLUMNS) as (keyof typeof RESULT_COLUMNS)[]) {
      const csv = parseCsv(extracted.get(`${table}.csv`)!);
      expect(csv[0]).toEqual(RESULT_COLUMNS[table]);
      expect(csv.length - 1).toBe(envelope.tables[table].length);
    }
    expect(JSON.parse(extracted.get('spec.json')!)).toEqual(envelope.spec);
    expect(JSON.parse(extracted.get('manifest.json')!).digest.canonicalJson).toBe(resultsDigest(envelope));
    expect(JSON.parse(extracted.get('schema.json')!).tables.events.additionalProperties).toBe(false);
    const shared = unzipStored(await bytes(exportStoredResults(f.record, fixtureChunks(f), 'csv', undefined, SHARE, NOW)));
    expect(shared).toEqual(serializeResultsCsv(await envelopeOf(f, undefined, SHARE, NOW)));
    expect([...shared.values()].join('')).not.toContain('PRIVATE_');
  });

  it('round-trips RFC4180 strings, formula guards, null and literal null sentinels', () => {
    const values = ['=SUM(A1)', '+cmd', '-text', '@eval', '\tformula', '\rformula', '\nformula', "'literal", '\\N', '\\path', '', 'quoted "text",\r\nnext', 'Unicode λ'];
    for (const original of values) {
      const cell = parseCsv(csvCell(original) + '\r\n')[0]![0]!;
      const decoded = cell.startsWith('\\\\') ? cell.slice(1) : cell.startsWith("'") ? cell.slice(1) : cell;
      expect(decoded).toBe(original); expect(cell).not.toBe('\\N');
      if (/^[=+\-@\t\r\n]/.test(original)) expect(cell.startsWith("'")).toBe(true);
    }
    expect(parseCsv(csvCell(null) + '\r\n')[0]![0]).toBe('\\N');
    expect(parseCsv(csvCell(-12) + '\r\n')[0]![0]).toBe('-12');
  });
});

/** Two metric series, decisions and usage well beyond the summary limit, spread over several chunks in reverse order. */
function largeFixture(samples: number): SeriesFixture {
  const f = seriesFixture();
  const metric = (team: 'blue' | 'red', tick: number): MetricRow => ({ matchId: 'match-0', tick, sequence: tick * 2 + (team === 'red' ? 1 : 0), scope: 'side', team, role: null, metric: 'economy.alloy', value: tick % 97, unit: 'alloy' });
  const base = f.chunks[0]!.chunk.rows;
  const per = 1000;
  for (let start = samples - per, index = 1; start >= 0; start -= per, index++) {
    const ticks = Array.from({ length: per }, (_, offset) => start + per - 1 - offset);
    f.chunks.push({ attemptId: 'attempt-0', chunk: chunkOf({
      metrics: ticks.flatMap((tick) => [metric('blue', tick + 100), metric('red', tick + 100)]),
      decisions: ticks.map((tick) => ({ ...base.decisions![0]!, decisionId: `bulk-${String(tick).padStart(6, '0')}`, latencyMs: tick })),
      usage: ticks.map((tick) => ({ ...base.usage![0]!, decisionId: `bulk-${tick}`, inputTokens: 1, outputTokens: 2, costAmount: '0.001' })),
    }, index) });
  }
  return f;
}

describe('bounded results summaries', () => {
  it('labels sampled raw tables and keeps every aggregate exact over all rows', async () => {
    const f = largeFixture(3000);
    const summary = validateResultsSummary(await buildResultsSummary(f.record, fixtureChunks(f)));
    const envelope = await envelopeOf(f);
    expect(summary.format).toBe('playerthree.results.summary');
    expect(summary.sampling.limit).toBe(2000);
    expect(summary.sampling.tables.metrics).toEqual({ rows: 6002, included: summary.tables.metrics.length, method: 'stride_per_series' });
    expect(summary.tables.metrics.length).toBeLessThanOrEqual(2000);
    expect(summary.tables.metrics.length).toBeGreaterThan(1900);
    for (const team of ['blue', 'red']) {
      const ticks = summary.tables.metrics.filter((row) => row.team === team).map((row) => row.tick);
      expect(Math.min(...ticks)).toBe(team === 'blue' ? 0 : 100);
      expect(Math.max(...ticks)).toBe(3099);
    }
    expect(summary.tables.metrics).toEqual([...summary.tables.metrics].sort((a, b) => a.matchId.localeCompare(b.matchId) || a.sequence - b.sequence));
    expect(summary.sampling.tables.decisions).toEqual({ rows: 3004, included: 2000, method: 'sorted_prefix' });
    expect(summary.tables.decisions).toEqual(envelope.tables.decisions.slice(0, 2000));
    expect(summary.sampling.tables.usage).toEqual({ rows: 3002, included: 2000, method: 'sorted_prefix' });
    expect(summary.tables.usage).toEqual(envelope.tables.usage.slice(0, 2000));
    for (const table of ['entrants', 'schedule', 'matches', 'standings', 'seats', 'causes', 'intents', 'events', 'artifacts'] as const) {
      expect(summary.sampling.tables[table]).toEqual({ rows: envelope.tables[table].length, included: envelope.tables[table].length, method: 'complete' });
      expect(summary.tables[table]).toEqual(envelope.tables[table]);
    }
    expect(summary.summaries).toEqual(envelope.summaries);
    expect(summary.summaries.latency).toEqual([{ entrantId: 'alpha', source: 'runner', samples: 3004, p50Ms: 1497, p95Ms: 2849, method: 'nearest_rank/1' }]);
    expect(summary.summaries.usage.find((row) => row.entrantId === 'alpha')).toMatchObject({ samples: 3002, inputTokens: 3030, outputTokens: 6008, costAmount: '3.300' });
    expect(summary.accounting).toEqual(envelope.accounting);
    expect(summary.retention).toEqual(envelope.retention);
    expect(summary.completeness).toEqual(envelope.completeness);
  });
});

describe('external merge sort', () => {
  const previous = process.env.TMPDIR;
  afterEach(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });

  it('orders multi-run tables canonically and always removes its temporary runs', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'playerthree-sort-test-'));
    try {
      process.env.TMPDIR = scratch;
      const f = largeFixture(16000);
      const json = (await bytes(exportStoredResults(f.record, fixtureChunks(f), 'json'))).toString('utf8');
      expect(await readdir(scratch)).toEqual([]);
      const envelope = JSON.parse(json) as ResultsEnvelope;
      expect(json).toBe(canonicalJson(envelope));
      expect(envelope.tables.metrics).toHaveLength(32002);
      expect(envelope.tables.metrics.map((row) => row.sequence)).toEqual([...envelope.tables.metrics.map((row) => row.sequence)].sort((a, b) => a - b));
      expect(envelope.summaries.latency[0]).toMatchObject({ samples: 16004, p50Ms: 7997, p95Ms: 15199 });
      const abandoned = exportStoredResults(f.record, fixtureChunks(f), 'csv')[Symbol.asyncIterator]();
      await abandoned.next();
      expect((await readdir(scratch)).length).toBe(1);
      await abandoned.return?.();
      expect(await readdir(scratch)).toEqual([]);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 120_000);
});

describe('bounded current arena schemas', () => {
  it('retains wide nested configuration in series, schedules and downloadable match specs', async () => {
    const fixture = seriesFixture();
    const orbit = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`rule${index}`, index]));
    const options = { orbit, variants: [{ orbit }] };
    const record = {
      ...fixture.record,
      spec: {
        ...fixture.record.spec,
        template: { ...fixture.record.spec.template, options },
        scenarios: fixture.record.spec.scenarios.map((scenario) => ({ ...scenario, options })),
      },
      trials: fixture.record.trials.map((trial) => ({ ...trial, resolvedOptions: options, spec: { ...trial.spec, options } })),
      attempts: fixture.record.attempts.map((attempt) => ({ ...attempt, spec: { ...attempt.spec, options } })),
    };
    expect(validateSeriesSpec(record.spec)).toBe(record.spec);
    const envelope = await envelopeOf({ ...fixture, record });
    expect(validateResultsEnvelope(envelope)).toBe(envelope);
    expect(envelope.spec.template.options).toEqual(options);
    for (const scenario of envelope.spec.scenarios) expect(scenario.options).toEqual(options);
    for (const trial of envelope.tables.schedule) expect(trial.resolvedOptions).toEqual(options);
    for (const match of envelope.tables.matches) expect(match.spec.options).toEqual(options);

    const oversized = { ...record.spec.template, options: { orbit: { ...orbit, extraRule: 1 } } };
    expect(() => validateMatchSpec(oversized)).toThrow();
    expect(() => exportMatchSpec(oversized)).toThrow(/256 properties/);
    expect(() => validateMatchSpec({ ...record.spec.template, options: { variants: [{ authorization: 'private' }] } })).toThrow();
    const event = fixture.chunks[0]!.chunk.rows.events![0]!;
    const metadata = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, index]));
    expect(() => validateResultRows({ events: [{ ...event, data: metadata }] })).toThrow();
  });

  it('accepts exact private specs but rejects unknown fields, secrets, nonfinite values and unbounded cards', () => {
    const { record, chunks } = seriesFixture();
    expect(validateSeriesSpec(record.spec)).toBe(record.spec);
    expect(validateMatchSpec(record.spec.template)).toBe(record.spec.template);
    expect(() => validateSeriesSpec({ ...record.spec, legacyRuns: [] })).toThrow();
    expect(() => validateSeriesSpec({ ...record.spec, execution: { ...record.spec.execution, legacyRetry: true } })).toThrow();
    expect(() => validateSeriesSpec({ ...record.spec, entrants: [{ ...record.spec.entrants[0], label: 'x'.repeat(257) }, record.spec.entrants[1]] })).toThrow();
    expect(() => validateMatchSpec({ ...record.spec.template, options: { apiKey: 'private' } })).toThrow();
    expect(() => validateResultRows({ metrics: [{ ...chunks[0]!.chunk.rows.metrics![0], value: Number.NaN }] })).toThrow();
    expect(() => validateResultRows({ usage: [{ ...chunks[0]!.chunk.rows.usage![0], prompt: 'private' }] })).toThrow();
    expect(() => validateResultRows(chunks[0]!.chunk.rows)).not.toThrow();
  });

  it('requires declared metric keys/units/scope and closed bounded event payloads', () => {
    const { record, chunks } = seriesFixture(), rows = chunks[0]!.chunk.rows;
    expect(() => validateTelemetryRows(rows, record.spec.telemetry)).not.toThrow();
    expect(() => validateTelemetryRows({ metrics: rows.metrics }, { sampleEveryTicks: 20, includeCommentary: false })).toThrow(/Undeclared metric/);
    expect(() => validateTelemetryRows({ events: rows.events }, { sampleEveryTicks: 20, includeCommentary: false })).toThrow(/Undeclared timeline/);
    expect(() => validateTelemetryRows({ metrics: [{ ...rows.metrics![0]!, unit: 'USD' }] }, record.spec.telemetry)).toThrow();
    expect(() => validateTelemetryRows({ events: [{ ...rows.events![0]!, data: { state: 'started', providerPayload: 'private' } }] }, record.spec.telemetry)).toThrow();
    expect(() => validateSeriesSpec({ ...record.spec, telemetry: { ...record.spec.telemetry, eventDefinitions: [{ kind: 'unbounded', dataSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } }] } })).toThrow(/maxLength/);
    expect(ARENA_HOST_EVENT_DEFINITIONS.map((definition) => definition.kind)).toEqual(['host.lifecycle', 'commentary']);
    expect(exportSeriesSpec(record.spec).execution.abortOn).toEqual(['infrastructure']);
  });
});
