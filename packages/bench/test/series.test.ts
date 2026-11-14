import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { jsonSeriesStore } from 'playerthree/host';
import type { EventDefinition, GameMatchHost, GameMatchResult, SeriesSpec } from 'playerthree/arena';
import { createSeriesRunner } from '../src/series.ts';

const spec = (): SeriesSpec => ({ format: 'playerthree.series', version: 1, game: 'test', gameVersion: '1', surfaceHash: 'surface', track: 'bots', entrants: ['a', 'b'].map(id => ({ id, label: id, kind: 'bot', aiPlayer: true })), template: { format: 'playerthree.match', version: 1, game: 'test', gameVersion: '1', surfaceHash: 'surface', rulesHash: 'rules', seed: 1, map: { id: 'map', identity: 'map-v1', seed: 1, layout: 'duel' }, options: {}, sides: ['left', 'right'].map((id, index) => ({ id, alliance: id, spawnSlot: id, seats: [{ role: 'army', occupant: { kind: 'bot', level: index === 0 ? 'novice' : 'veteran', options: {} } }] })), bindings: [{ seat: { team: 'left', role: 'army' }, entrantId: 'a' }, { seat: { team: 'right', role: 'army' }, entrantId: 'b' }], observerPolicy: { allowOmniscient: true, minDelayMs: 0 }, rules: { ranked: false, coaching: 'off', practiceReasons: [] } }, scenarios: [{ id: 'seed1', seed: 1, map: { id: 'map', identity: 'map-v1', seed: 1, layout: 'duel' }, options: {} }], permutations: [{ id: 'normal', sideEntrants: [{ team: 'left', entrantId: 'a' }, { team: 'right', entrantId: 'b' }] }, { id: 'swap', sideEntrants: [{ team: 'left', entrantId: 'b' }, { team: 'right', entrantId: 'a' }] }], repetitions: 1, execution: { concurrency: 2, speed: 1, clock: 'accelerated', maxTicks: 10, maxWallMs: 1000, maxInfraRetries: 1, state: 'reset_each_match' }, budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null }, rating: { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 }, telemetry: { sampleEveryTicks: 1, includeCommentary: false } });

test('canonical schedule swaps complete seat lineups and streams each durable terminal revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-series-'));
  try {
    const seen: string[] = [];
    const host: GameMatchHost = {
      async describe() { return { game: 'test', gameVersion: '1', surfaceHash: 'surface', supportedLayouts: [{ map: 'map', layout: 'duel', sides: ['left', 'right'] }], clocks: ['accelerated'] }; },
      async resolve(value) { return { ...value, rulesHash: value.rulesHash || 'rules' }; },
      async create(value, context) {
        const occupant = value.sides[0]!.seats[0]!.occupant;
        seen.push(occupant.kind === 'bot' ? occupant.level : occupant.kind);
        const result: GameMatchResult = { terminal: 'finished', ticks: 10, simulatedMs: 500, wallMs: 1, outcomes: [{ team: 'left', rank: 1, outcome: 'win', reason: 'test' }, { team: 'right', rank: 2, outcome: 'loss', reason: 'test' }], metrics: [], artifacts: [] };
        return { id: context.attemptId, async start() {}, finished: Promise.resolve(result), async abort() {}, async dispose() {} };
      },
      async *observe() {}, async artifact() { return (async function* () {})(); },
    };
    const store = jsonSeriesStore(dir);
    const runner = createSeriesRunner({ host, store, binder: { async bind() { return { seats: [], async release() {} }; } } });
    const created = await runner.create('owner', spec());
    await runner.start('owner', created.id);
    const revisions: number[] = [];
    for await (const update of runner.updates({ kind: 'owner', owner: 'owner', seriesId: created.id })) revisions.push(update.revision);
    const results = await runner.results({ kind: 'owner', owner: 'owner', seriesId: created.id });
    assert.deepEqual(seen, ['novice', 'veteran']);
    assert.equal(results.tables.matches.length, 2);
    assert.equal(results.state, 'completed');
    assert.equal(results.format, 'playerthree.results.summary');
    assert.equal(results.sampling.tables.matches.method, 'complete');
    assert.ok(revisions.length >= 4);
    assert.equal(new Set(revisions).size, revisions.length);
    await assert.rejects(runner.results({ kind: 'owner', owner: 'other', seriesId: created.id }));
    const policy = { commentary: false, expiresAt: new Date(Date.now() + 60000).toISOString(), notBefore: 0, consentedEntrants: [] };
    const preview = await runner.previewShare('owner', created.id, policy);
    assert.equal(preview.disclosure.audience, 'shared');
    assert.equal(preview.accounting.provenance, 'shared_projection');
    const shared = await runner.createShare('owner', created.id, policy);
    assert.match(shared.token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal((await runner.results({ kind: 'share', token: shared.token })).disclosure.audience, 'shared');
    await runner.revokeShare('owner', created.id);
    await assert.rejects(runner.results({ kind: 'share', token: shared.token }));
    const renewed = await runner.createShare('owner', created.id, policy);
    assert.notEqual(renewed.token, shared.token);
    assert.ok(renewed.generation > shared.generation);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects incomplete permutations before creating any match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-invalid-'));
  try {
    let creates = 0;
    const host: GameMatchHost = { async describe() { return { game: 'test', gameVersion: '1', surfaceHash: 'surface', supportedLayouts: [], clocks: ['accelerated'] }; }, async resolve(s) { return s; }, async create() { creates++; throw new Error('must not create'); }, async *observe() {}, async artifact() { return (async function* () {})(); } };
    const runner = createSeriesRunner({ host, store: jsonSeriesStore(dir), binder: { async bind() { throw new Error('must not bind'); } } });
    const invalid = spec(); invalid.permutations = [{ id: 'bad', sideEntrants: [{ team: 'left', entrantId: 'a' }] }];
    await assert.rejects(runner.create('owner', invalid));
    assert.equal(creates, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('aborting a queued series never started goes straight to aborted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-queued-abort-'));
  try {
    let creates = 0;
    const host: GameMatchHost = {
      async describe() { return { game: 'test', gameVersion: '1', surfaceHash: 'surface', supportedLayouts: [{ map: 'map', layout: 'duel', sides: ['left', 'right'] }], clocks: ['accelerated'] }; },
      async resolve(s) { return { ...s, rulesHash: s.rulesHash || 'rules' }; },
      async create() { creates++; throw new Error('must not create'); }, async *observe() {}, async artifact() { return (async function* () {})(); },
    };
    const runner = createSeriesRunner({ host, store: jsonSeriesStore(dir), binder: { async bind() { throw new Error('must not bind'); } } });
    const { id } = await runner.create('owner', spec());
    await runner.abort('owner', id);
    assert.equal((await runner.results({ kind: 'owner', owner: 'owner', seriesId: id })).state, 'aborted');
    await runner.abort('owner', id);
    assert.equal(creates, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('infrastructure retries retain failed attempts and never retry an aborted gameplay attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-retries-'));
  try {
    let calls = 0;
    let releases = 0;
    const host: GameMatchHost = {
      async describe() { return { game: 'test', gameVersion: '1', surfaceHash: 'surface', supportedLayouts: [{ map: 'map', layout: 'duel', sides: ['left', 'right'] }], clocks: ['accelerated'] }; },
      async resolve(s) { return { ...s, rulesHash: s.rulesHash || 'rules' }; },
      async create(_s, context) {
        calls++;
        const terminal = calls === 1 ? 'infra_error' : 'aborted';
        return { id: context.attemptId, async start() {}, finished: Promise.resolve({ terminal, terminalReason: terminal === 'infra_error' ? 'worker_failure' : 'model_timeout', ticks: 0, simulatedMs: 0, wallMs: 1, outcomes: [], metrics: [], artifacts: [] } satisfies GameMatchResult), async abort() {}, async dispose() {} };
      },
      async *observe() {}, async artifact() { return (async function* () {})(); },
    };
    const store = jsonSeriesStore(dir);
    const runner = createSeriesRunner({ host, store, binder: { async bind() { return { seats: [], async release() { releases++; } }; } } });
    const input = spec(); input.permutations = [input.permutations[0]!]; input.execution.concurrency = 1;
    const created = await runner.create('owner', input);
    await runner.start('owner', created.id);
    for await (const _update of runner.updates({ kind: 'owner', owner: 'owner', seriesId: created.id })) { /* Drain committed updates. */ }
    const result = await runner.results({ kind: 'owner', owner: 'owner', seriesId: created.id });
    assert.equal(calls, 2);
    assert.equal(releases, 2);
    assert.deepEqual(result.tables.matches.map(m => m.status), ['infra_error', 'aborted']);
    assert.ok(result.tables.matches.every(m => !m.acceptedAttempt));
    assert.ok(result.tables.standings.every(s => s.games === 0));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('closing the runner suspends a series without aborting it; the next runner retries the interrupted trial', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-close-'));
  try {
    let creates = 0;
    const playing = Promise.withResolvers<void>();
    const host: GameMatchHost = {
      async describe() { return { game: 'test', gameVersion: '1', surfaceHash: 'surface', supportedLayouts: [{ map: 'map', layout: 'duel', sides: ['left', 'right'] }], clocks: ['accelerated'] }; },
      async resolve(s) { return { ...s, rulesHash: s.rulesHash || 'rules' }; },
      async create(_s, context) {
        // The first match never finishes on its own: only shutdown ends it.
        const first = ++creates === 1;
        if (first) playing.resolve();
        const result: GameMatchResult = { terminal: 'finished', ticks: 10, simulatedMs: 500, wallMs: 1, outcomes: [{ team: 'left', rank: 1, outcome: 'win', reason: 'test' }, { team: 'right', rank: 2, outcome: 'loss', reason: 'test' }], metrics: [], artifacts: [] };
        return { id: context.attemptId, async start() {}, finished: first ? Promise.withResolvers<GameMatchResult>().promise : Promise.resolve(result), async abort() {}, async dispose() {} };
      },
      async *observe() {}, async artifact() { return (async function* () {})(); },
    };
    const store = jsonSeriesStore(dir);
    const binder = { async bind() { return { seats: [], async release() {} }; } };
    const access = (id: string) => ({ kind: 'owner' as const, owner: 'owner', seriesId: id });
    const input = spec(); input.permutations = [input.permutations[0]!]; input.execution.concurrency = 1;
    const first = createSeriesRunner({ host, store, binder });
    const { id } = await first.create('owner', input);
    await first.start('owner', id);
    await playing.promise;
    const drained = (async () => { for await (const _update of first.updates(access(id))) { /* Ends once closed. */ } })();
    await first.close();
    await drained;
    assert.equal((await store.get(id))!.state, 'running');
    await assert.rejects(first.start('owner', id), /closed/);
    const second = createSeriesRunner({ host, store, binder });
    await second.start('owner', id);
    for await (const _update of second.updates(access(id))) { /* Drain committed updates. */ }
    const result = await second.results(access(id));
    assert.equal(result.state, 'completed');
    assert.deepEqual(result.tables.matches.map(m => [m.status, m.terminalReason, m.acceptedAttempt]), [['infra_error', 'shutdown', false], ['finished', 'finished', true]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects host results that split an alliance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-alliance-'));
  try {
    let calls = 0;
    const host: GameMatchHost = {
      async describe() { return { game: 'test', gameVersion: '1', surfaceHash: 'surface', supportedLayouts: [{ map: 'map', layout: 'duel', sides: ['left', 'right'] }], clocks: ['accelerated'] }; },
      async resolve(s) { return { ...s, rulesHash: s.rulesHash || 'rules' }; },
      async create(_s, context) {
        // First match splits the allies, second reports them together.
        const right = ++calls === 1 ? { team: 'right', rank: 2, outcome: 'loss' as const, reason: 'test' } : { team: 'right', rank: 1, outcome: 'win' as const, reason: 'test' };
        const result: GameMatchResult = { terminal: 'finished', ticks: 10, simulatedMs: 500, wallMs: 1, outcomes: [{ team: 'left', rank: 1, outcome: 'win', reason: 'test' }, right], metrics: [], artifacts: [] };
        return { id: context.attemptId, async start() {}, finished: Promise.resolve(result), async abort() {}, async dispose() {} };
      },
      async *observe() {}, async artifact() { return (async function* () {})(); },
    };
    const runner = createSeriesRunner({ host, store: jsonSeriesStore(dir), binder: { async bind() { return { seats: [], async release() {} }; } } });
    const input = spec(); input.execution.concurrency = 1;
    input.template = { ...input.template, sides: input.template.sides.map(side => ({ ...side, alliance: 'crew' })) };
    const created = await runner.create('owner', input);
    await runner.start('owner', created.id);
    for await (const _update of runner.updates({ kind: 'owner', owner: 'owner', seriesId: created.id })) { /* Drain committed updates. */ }
    const result = await runner.results({ kind: 'owner', owner: 'owner', seriesId: created.id });
    assert.equal(calls, 2);
    assert.deepEqual(result.tables.matches.map(m => [m.status, m.terminalReason]), [['aborted', 'execution_error'], ['finished', 'finished']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a telemetry row the declared schema rejects fails the series and surfaces its cause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-telemetry-failure-'));
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const dataSchema: EventDefinition['dataSchema'] = { type: 'object', properties: { cause: { type: 'string', enum: ['unknown', 'storm'] } }, additionalProperties: false };
    const host: GameMatchHost = {
      async describe() { return { game: 'test', gameVersion: '1', surfaceHash: 'surface', supportedLayouts: [{ map: 'map', layout: 'duel', sides: ['left', 'right'] }], clocks: ['accelerated'], eventDefinitions: [{ kind: 'kill', dataSchema }] }; },
      async resolve(s) { return { ...s, rulesHash: s.rulesHash || 'rules' }; },
      async create(_s, context) {
        // A cause outside the game's declared vocabulary, as Agent Command's army elimination once emitted.
        const finished = context.emitEvent({ matchId: context.attemptId, sequence: 0, tick: 1, atMs: 50, kind: 'kill', team: 'left', role: 'army', data: { cause: 'eliminated' } })
          .then((): GameMatchResult => ({ terminal: 'finished', ticks: 10, simulatedMs: 500, wallMs: 1, outcomes: [{ team: 'left', rank: 1, outcome: 'draw', reason: 'test' }, { team: 'right', rank: 1, outcome: 'draw', reason: 'test' }], metrics: [], artifacts: [] }));
        // The runner awaits `finished` only after attaching the match; the rejection is observed there.
        finished.catch(() => {});
        return { id: context.attemptId, async start() {}, finished, async abort() {}, async dispose() {} };
      },
      async *observe() {}, async artifact() { return (async function* () {})(); },
    };
    const runner = createSeriesRunner({ host, store: jsonSeriesStore(dir), binder: { async bind() { return { seats: [], async release() {} }; } } });
    const input = spec(); input.permutations = [input.permutations[0]!]; input.execution.concurrency = 1;
    const created = await runner.create('owner', input);
    await runner.start('owner', created.id);
    for await (const _update of runner.updates({ kind: 'owner', owner: 'owner', seriesId: created.id })) { /* Drain committed updates. */ }
    const result = await runner.results({ kind: 'owner', owner: 'owner', seriesId: created.id });
    assert.equal(result.state, 'failed');
    assert.deepEqual(result.completeness, { scheduleComplete: false, rawComplete: false, missing: ['durable_recording_failure', 'failure: Error: event.data.cause: enum'] });
    const [message, error] = logged.mock.calls.at(-1)!;
    assert.equal(message, `playerthree bench: series ${created.id} failed:`);
    assert.match((error as Error).stack!, /event\.data\.cause: enum\n\s+at /);
  } finally { logged.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});
