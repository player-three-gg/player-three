import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActiveAttempt, MatchCommit, MatchSpec, ResultChunk, SeriesSpec, SeriesStore, ShareRecord, StoredResultChunk, StoredSeries } from '../src/arena.ts';
import { openPostgresStorage, type PostgresStorage } from '../src/postgres/index.ts';
import { jsonSeriesStore, seriesChunkJson } from '../src/host/index.ts';

const dirs: string[] = [];
let database: PGlite;
let server: PGLiteSocketServer;
let postgres: PostgresStorage;
let ordinal = 0;
beforeAll(async () => {
  database = await PGlite.create();
  server = new PGLiteSocketServer({ db: database, port: 0, maxConnections: 8 });
  await server.start();
  postgres = await openPostgresStorage({ url: `postgres://postgres@${server.getServerConn()}/postgres`, max: 4 });
}, 60_000);
afterAll(async () => {
  await postgres?.close();
  await server?.stop();
  await database?.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function local(): Promise<{ store: SeriesStore; reopen: () => SeriesStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'playerthree-series-'));
  dirs.push(dir);
  return { store: jsonSeriesStore(dir), reopen: () => jsonSeriesStore(dir), dir };
}
function record(id = 'series_test'): StoredSeries {
  const createdAt = new Date().toISOString();
  const match: MatchSpec = { format: 'playerthree.match', version: 1, game: 'fixture', gameVersion: '1', surfaceHash: 'a'.repeat(64), rulesHash: 'b'.repeat(64), seed: 1, map: { id: 'map', identity: 'map:1', seed: 1, layout: 'duel' }, options: {}, sides: [{ id: 'blue', spawnSlot: 'west', alliance: 'blue', seats: [{ role: 'player', occupant: { kind: 'bot', level: 'normal', options: {} } }] }, { id: 'red', spawnSlot: 'east', alliance: 'red', seats: [{ role: 'player', occupant: { kind: 'bot', level: 'normal', options: {} } }] }], bindings: [{ seat: { team: 'blue', role: 'player' }, entrantId: 'one' }, { seat: { team: 'red', role: 'player' }, entrantId: 'two' }], observerPolicy: { allowOmniscient: false, minDelayMs: 0 }, rules: { ranked: false, coaching: 'off', practiceReasons: [] } };
  const spec: SeriesSpec = { format: 'playerthree.series', version: 1, game: match.game, gameVersion: match.gameVersion, surfaceHash: match.surfaceHash, track: 'bots', entrants: [{ id: 'one', kind: 'bot', label: 'One', aiPlayer: true }, { id: 'two', kind: 'bot', label: 'Two', aiPlayer: true }], template: match, scenarios: [{ id: 'scenario', seed: 1, map: match.map, options: {} }], permutations: [{ id: 'sides', sideEntrants: [{ team: 'blue', entrantId: 'one' }, { team: 'red', entrantId: 'two' }] }], repetitions: 1, execution: { concurrency: 1, speed: 1, clock: 'realtime', maxTicks: 100, maxWallMs: 1000, maxInfraRetries: 1, state: 'reset_each_match' }, budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null }, rating: { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 }, telemetry: { sampleEveryTicks: 20, includeCommentary: false } };
  return { id, owner: 'owner', spec, trials: [{ trialId: 'trial', scenarioId: 'scenario', permutationId: 'sides', repetition: 0, scheduleIndex: 0, seed: 1, mapId: 'map', mapIdentity: 'map:1', mapSeed: 1, layoutId: 'duel', rulesHash: match.rulesHash, surfaceHash: match.surfaceHash, resolvedOptions: {}, sideBindings: spec.permutations[0]!.sideEntrants, spec: match }], revision: 0, state: 'queued', createdAt, updatedAt: createdAt, completedAt: null, comparisonHash: 'c'.repeat(64), limits: { maxGames: 200, maxConcurrency: 2, maxBytes: 2 * 1024 * 1024, maxChunkBytes: 1024 * 1024, maxWallMs: 1000, retentionMs: 86_400_000 }, expiresAt: new Date(Date.parse(createdAt) + 86_400_000).toISOString(), bytes: 0, activeAttempts: [], attempts: [], artifacts: [], chunkStats: [], updates: [], lease: null, commentaryConsents: [] };
}
function chunk(index = 0, matchId = 'attempt_1'): ResultChunk {
  const rows: ResultChunk['rows'] = { events: [{ matchId, sequence: index, tick: index, atMs: index, kind: 'lifecycle', team: null, role: null, data: { state: 'started' } }] };
  const json = seriesChunkJson(rows);
  return { index, rows, bytes: Buffer.byteLength(json), checksum: createHash('sha256').update(json).digest('hex') };
}
async function begin(store: SeriesStore, initial: StoredSeries): Promise<ActiveAttempt> {
  await store.create(initial);
  expect(await store.claim(initial.id, 'worker', Date.now() + 60_000)).toBe(true);
  await store.transition(initial.id, 0, 'running');
  const active: ActiveAttempt = { trialId: 'trial', attemptId: 'attempt_1', attemptNumber: 1, startedAt: initial.createdAt, matchId: null, releaseAt: 0 };
  await store.beginAttempt(initial.id, 1, active, 'worker');
  return active;
}
function commit(initial: StoredSeries, active: ActiveAttempt, revision = 2, accepted = true): MatchCommit {
  const { sides: _sides, ...rest } = initial.spec.template;
  const at = new Date().toISOString();
  return { leaseHolder: 'worker', attempt: { ...active, revision, matchId: active.matchId ?? active.attemptId, status: accepted ? 'finished' : 'infra_error', acceptedAttempt: accepted, endedAt: at, ticks: 10, simulatedMs: 500, wallMs: 20, terminalReason: accepted ? 'finished' : 'process_death', outcomes: [], spec: { ...rest, sides: [] }, releaseAt: 0 }, update: { seriesId: initial.id, revision, at, state: 'running', completed: Number(accepted), total: 1, standings: [], activeMatches: [], releaseAt: 0 } };
}
function share(initial: StoredSeries): ShareRecord {
  const token = randomBytes(24).toString('base64url');
  return { seriesId: initial.id, owner: initial.owner, digest: createHash('sha256').update(token).digest('hex'), generation: 0, revokedAt: null, policy: { commentary: false, notBefore: 0, expiresAt: initial.expiresAt, consentedEntrants: [] } };
}
async function entries(source: AsyncIterable<StoredResultChunk>): Promise<StoredResultChunk[]> {
  const result: StoredResultChunk[] = [];
  for await (const entry of source) result.push(entry);
  return result;
}

for (const kind of ['file', 'postgres'] as const) describe(`${kind} SeriesStore`, () => {
  /** `corrupt` flips stored payload bytes of one committed chunk without changing its length. */
  async function setup(): Promise<{ store: SeriesStore; reopen: () => SeriesStore; corrupt: (id: string, attemptId: string, index: number) => Promise<void> }> {
    if (kind === 'file') {
      const { store, reopen, dir } = await local();
      return { store, reopen, corrupt: async (id, attemptId, index) => {
        const path = join(dir, `${id}.${attemptId}.${index}.chunk.json`);
        await writeFile(path, (await readFile(path, 'utf8')).replace('started', 'stopped'));
      } };
    }
    const game = `series_test_${ordinal++}`;
    return { store: postgres.series(game), reopen: () => postgres.series(game), corrupt: async (id, attemptId, index) => {
      await postgres.query("UPDATE playerthree_series_result_chunks SET payload = replace(payload, 'started', 'stopped') WHERE game = $1 AND series_id = $2 AND attempt_id = $3 AND chunk_index = $4", [game, id, attemptId, index]);
    } };
  }
  it('persists immutable schedule, ordered chunks, CAS terminal attempt/standings/update and duplicate callbacks', async () => {
    const { store, reopen } = await setup();
    const initial = record();
    const active = await begin(store, initial);
    const raw = chunk();
    await store.appendChunk(initial.id, active.attemptId, raw, 'worker');
    await store.appendChunk(initial.id, active.attemptId, raw, 'worker');
    await expect(store.appendChunk(initial.id, active.attemptId, chunk(2), 'worker')).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.appendChunk(initial.id, active.attemptId, { ...raw, checksum: '0'.repeat(64) }, 'worker')).rejects.toThrow(/checksum/);
    const terminal = commit(initial, active);
    await expect(store.commitMatch(initial.id, 0, terminal)).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.commitMatch(initial.id, 1, terminal)).toBe(2);
    expect(await store.commitMatch(initial.id, 1, terminal)).toBe(2);
    await expect(store.commitMatch(initial.id, 1, { ...terminal, attempt: { ...terminal.attempt, ticks: 99 } })).rejects.toMatchObject({ code: 'conflict' });
    const loaded = await reopen().get(initial.id);
    expect(loaded?.revision).toBe(2);
    expect(loaded?.attempts).toEqual([terminal.attempt]);
    expect(loaded).not.toHaveProperty('chunks');
    expect(loaded?.chunkStats).toEqual([{ attemptId: active.attemptId, count: 1, bytes: raw.bytes }]);
    // Metadata reads never carry raw rows.
    expect(JSON.stringify([loaded, await store.list(initial.owner), await store.recoverable(Date.now() + 86_400_000)])).not.toContain('lifecycle');
    expect(await entries(reopen().iterateChunks(initial.id))).toEqual([{ attemptId: active.attemptId, committedRevision: 2, chunk: raw }]);
    expect(loaded?.updates.at(-1)).toEqual(terminal.update);
    expect(loaded?.activeAttempts).toEqual([]);
    expect(loaded?.bytes).toBe(raw.bytes);
    await store.transition(initial.id, 2, 'completed');
    await store.release(initial.id, 'worker');
    expect(await store.claim(initial.id, 'new', Date.now() + 1000)).toBe(false);
  });
  it('streams committed chunks per revision snapshot in attempt/index order, never active ones, and rejects corrupt payloads', async () => {
    const { store, reopen, corrupt } = await setup();
    const initial = record();
    const first = await begin(store, initial);
    await store.appendChunk(initial.id, first.attemptId, chunk(0), 'worker');
    await store.appendChunk(initial.id, first.attemptId, chunk(1), 'worker');
    expect(await entries(store.iterateChunks(initial.id))).toEqual([]);
    await store.commitMatch(initial.id, 1, commit(initial, first, 2, false));
    const retry: ActiveAttempt = { ...first, attemptId: 'attempt_2', attemptNumber: 2 };
    await store.beginAttempt(initial.id, 2, retry, 'worker');
    await store.appendChunk(initial.id, retry.attemptId, chunk(0, 'attempt_2'), 'worker');
    expect((await entries(store.iterateChunks(initial.id))).map((entry) => [entry.attemptId, entry.chunk.index])).toEqual([['attempt_1', 0], ['attempt_1', 1]]);
    await store.commitMatch(initial.id, 2, commit(initial, retry, 3));
    const all = reopen().iterateChunks(initial.id);
    const expected = [
      { attemptId: 'attempt_1', committedRevision: 2, chunk: chunk(0) },
      { attemptId: 'attempt_1', committedRevision: 2, chunk: chunk(1) },
      { attemptId: 'attempt_2', committedRevision: 3, chunk: chunk(0, 'attempt_2') },
    ];
    expect(await entries(all)).toEqual(expected);
    expect(await entries(all)).toEqual(expected);
    expect(await entries(store.iterateChunks(initial.id, 2))).toEqual(expected.slice(0, 2));
    expect(await entries(store.iterateChunks(initial.id, 1))).toEqual([]);
    await expect(entries(store.iterateChunks(initial.id, 4))).rejects.toMatchObject({ code: 'invalid' });
    expect((await store.get(initial.id))?.chunkStats).toEqual([{ attemptId: 'attempt_1', count: 2, bytes: chunk(0).bytes + chunk(1).bytes }, { attemptId: 'attempt_2', count: 1, bytes: chunk(0, 'attempt_2').bytes }]);
    await corrupt(initial.id, 'attempt_1', 1);
    await expect(entries(store.iterateChunks(initial.id))).rejects.toThrow(/corrupt raw result chunk/);
    await expect(entries(store.iterateChunks('missing_series'))).rejects.toMatchObject({ code: 'not_found' });
  });
  it('commits active match attachment as an immutable revision and removes it in terminal snapshots', async () => {
    const { store, reopen } = await setup();
    const initial = record();
    const active = await begin(store, initial);
    const releaseAt = Date.now() + 180_000;
    await expect(store.attachMatch(initial.id, 1, active.attemptId, 'live_match', releaseAt, 'stale_worker')).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.attachMatch(initial.id, 1, active.attemptId, 'live_match', releaseAt, 'worker')).toBe(2);
    expect(await store.attachMatch(initial.id, 1, active.attemptId, 'live_match', releaseAt, 'worker')).toBe(2);
    await expect(store.attachMatch(initial.id, 2, active.attemptId, 'different_match', releaseAt, 'worker')).rejects.toMatchObject({ code: 'conflict' });
    const attached = await reopen().get(initial.id);
    expect(attached?.updates[0]?.activeMatches).toEqual([]);
    expect(attached?.updates[1]?.activeMatches).toEqual([expect.objectContaining({ matchId: 'live_match', attemptId: active.attemptId, releaseAt })]);
    expect(attached?.updates[1]?.releaseAt).toBe(releaseAt);
    const terminal = commit(initial, { ...active, matchId: 'live_match', releaseAt }, 3);
    terminal.attempt.releaseAt = releaseAt;
    terminal.update.releaseAt = releaseAt;
    await store.commitMatch(initial.id, 2, terminal);
    const finished = await reopen().get(initial.id);
    expect(finished?.updates[1]?.activeMatches).toEqual(attached?.updates[1]?.activeMatches);
    expect(finished?.updates[2]?.activeMatches).toEqual([]);
    expect(finished?.attempts[0]?.matchId).toBe('live_match');
  });
  it('serializes competing revisions and keeps failed attempts for lease recovery/retry', async () => {
    const { store } = await setup();
    const initial = record();
    const active = await begin(store, initial);
    expect(await store.claim(initial.id, 'other', Date.now() + 60_000)).toBe(false);
    expect((await store.recoverable(Date.now())).map((row) => row.id)).not.toContain(initial.id);
    expect((await store.recoverable(Date.now() + 120_000)).map((row) => row.id)).toContain(initial.id);
    const failed = commit(initial, active, 2, false);
    await store.commitMatch(initial.id, 1, failed);
    const retry = { ...active, attemptId: 'attempt_2', attemptNumber: 2 };
    await store.beginAttempt(initial.id, 2, retry, 'worker');
    const accepted = commit(initial, retry, 3);
    const results = await Promise.allSettled([store.commitMatch(initial.id, 2, accepted), store.transition(initial.id, 2, 'aborting')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await store.get(initial.id))?.attempts).toHaveLength(2);
    await expect(store.appendChunk(initial.id, retry.attemptId, chunk(), 'stale_worker')).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.transition(initial.id, 3, 'failed', undefined, 'stale_worker')).rejects.toMatchObject({ code: 'conflict' });
  });
  it('allocates digest-only share generations, revokes old links and enforces expiry/ownership', async () => {
    const { store, reopen } = await setup();
    const initial = record();
    await store.create(initial);
    const first = share(initial);
    expect((await store.share(initial.id, initial.owner, first))?.generation).toBe(1);
    expect((await reopen().resolveShare(first.digest))?.generation).toBe(1);
    await expect(store.share(initial.id, 'other', null)).rejects.toMatchObject({ code: 'not_found' });
    await store.share(initial.id, initial.owner, null);
    expect(await store.resolveShare(first.digest)).toBeUndefined();
    const second = share(initial);
    expect((await store.share(initial.id, initial.owner, second))?.generation).toBe(2);
    expect(await store.resolveShare(first.digest)).toBeUndefined();
    await expect(store.share(initial.id, initial.owner, { ...share(initial), policy: { ...first.policy, expiresAt: new Date(Date.parse(initial.expiresAt) + 1).toISOString() } })).rejects.toMatchObject({ code: 'invalid' });
    await store.delete(initial.id, initial.owner);
    expect(await reopen().resolveShare(second.digest)).toBeUndefined();
    expect(await store.get(initial.id)).toBeUndefined();
  });
  it('persists independent commentary categories and revokes active generations on withdrawal', async () => {
    const { store, reopen } = await setup();
    const initial = record();
    await store.create(initial);
    const forged = share(initial);
    forged.policy = { ...forged.policy, commentary: true, consentedEntrants: ['one', 'two'] };
    await expect(store.share(initial.id, initial.owner, forged)).rejects.toMatchObject({ code: 'invalid' });
    await store.setCommentaryConsent(initial.id, initial.owner, 'one', { summaries: true, chat: false });
    const projection = await store.share(initial.id, initial.owner, forged);
    expect(projection?.policy.consentedEntrants).toEqual(['one']);
    expect((await reopen().get(initial.id))?.commentaryConsents).toEqual([{ entrantId: 'one', summaries: true, chat: false }]);
    await store.setCommentaryConsent(initial.id, initial.owner, 'one', { summaries: false, chat: false });
    expect(await store.resolveShare(forged.digest)).toBeUndefined();
    await expect(store.setCommentaryConsent(initial.id, 'other', 'one', { summaries: true, chat: true })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('enforces active/profile/raw quotas without partial chunks and records explicit incomplete failure', async () => {
    const { store } = await setup();
    const initial = record();
    initial.limits.maxBytes = chunk().bytes - 1;
    const active = await begin(store, initial);
    await expect(store.appendChunk(initial.id, active.attemptId, chunk(), 'worker')).rejects.toMatchObject({ code: 'quota' });
    expect((await store.get(initial.id))?.bytes).toBe(0);
    expect((await store.get(initial.id))?.chunkStats).toHaveLength(0);
    await store.transition(initial.id, 1, 'failed', { rawComplete: false, missing: ['durable_recording_failure'] });
    expect(await store.get(initial.id)).toMatchObject({ state: 'failed', rawComplete: false, missing: ['durable_recording_failure'] });
    const failed = await store.get(initial.id);
    expect(failed?.updates.at(-1)).toMatchObject({ at: failed?.updatedAt, recording: { rawComplete: false, missing: ['durable_recording_failure'] } });
    expect(failed?.updates[0]).not.toHaveProperty('recording');
    await store.create(record('second'));
    await store.create(record('third'));
    await expect(store.create(record('fourth'))).rejects.toMatchObject({ code: 'quota' });
  });
  it('rolls back every chunk and result in a quota-failed terminal transaction', async () => {
    const { store } = await setup();
    const initial = record();
    initial.limits.maxBytes = chunk(0).bytes + chunk(1).bytes - 1;
    const active = await begin(store, initial);
    const terminal = { ...commit(initial, active), chunks: [chunk(0), chunk(1)] };
    await expect(store.commitMatch(initial.id, 1, terminal)).rejects.toMatchObject({ code: 'quota' });
    expect(await store.get(initial.id)).toMatchObject({ revision: 1, bytes: 0, attempts: [], chunkStats: [] });
    await store.appendChunk(initial.id, active.attemptId, chunk(), 'worker');
    expect((await store.get(initial.id))?.chunkStats).toEqual([{ attemptId: active.attemptId, count: 1, bytes: chunk().bytes }]);
  });
  it('enforces retained owner bytes and combined chunk/artifact attempt caps', async () => {
    const { store } = await setup();
    const first = record('first');
    first.limits.maxOwnerBytes = chunk().bytes * 2 - 1;
    const a = await begin(store, first);
    await store.appendChunk(first.id, a.attemptId, chunk(), 'worker');
    const second = record('second');
    second.limits.maxOwnerBytes = first.limits.maxOwnerBytes;
    const b = await begin(store, second);
    await expect(store.appendChunk(second.id, b.attemptId, chunk(), 'worker')).rejects.toMatchObject({ code: 'quota' });
    const third = record('separate_owner');
    third.owner = 'another_owner';
    const bytes = new TextEncoder().encode('replay');
    third.limits.maxAttemptBytes = bytes.byteLength + chunk().bytes - 1;
    const c = await begin(store, third);
    await store.putArtifact(third.id, { id: 'replay', matchId: c.attemptId, kind: 'replay', format: 'fixture', version: 1, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength, availability: 'available' }, bytes, 'worker');
    await expect(store.appendChunk(third.id, c.attemptId, chunk(), 'worker')).rejects.toMatchObject({ code: 'quota' });
  });
  it('retains checksummed artifact bytes and prunes series/chunks/shares/artifacts together', async () => {
    const { store, reopen } = await setup();
    const initial = record();
    const active = await begin(store, initial);
    const data = new TextEncoder().encode('retained replay');
    const artifact = { id: '../retained/replay:1', matchId: active.attemptId, kind: 'replay' as const, format: 'fixture', version: 1, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength, availability: 'available' as const, expiresAt: initial.expiresAt };
    await store.putArtifact(initial.id, artifact, data, 'worker');
    await store.putArtifact(initial.id, artifact, data, 'worker');
    expect(await reopen().getArtifact(initial.id, artifact.id)).toEqual(data);
    await store.appendChunk(initial.id, active.attemptId, chunk(), 'worker');
    const link = share(initial);
    await store.share(initial.id, initial.owner, link);
    await store.prune(Date.parse(initial.expiresAt) + 1);
    expect(await store.get(initial.id)).toBeUndefined();
    expect(await store.getArtifact(initial.id, artifact.id)).toBeUndefined();
    expect(await store.resolveShare(link.digest)).toBeUndefined();
  });
});

describe('local journal recovery and durable failures', () => {
  it('replays a durable revision journal before reads, drops incomplete temp files and never skips corrupt records', async () => {
    const { dir, store, reopen } = await local();
    const initial = record();
    await store.create(initial);
    const index = JSON.parse(await readFile(join(dir, 'series.json'), 'utf8')) as { records: StoredSeries[] };
    index.records[0]!.revision = 1;
    index.records[0]!.state = 'running';
    await writeFile(join(dir, 'journal.json'), JSON.stringify({ format: 'playerthree.series-journal', version: 1, index, chunks: [], artifacts: [], deleted: [] }));
    await writeFile(join(dir, 'series.json.interrupted.tmp'), 'incomplete');
    expect((await reopen().get(initial.id))?.revision).toBe(1);
    expect(await readdir(dir)).not.toContain('journal.json');
    expect(await readdir(dir)).not.toContain('series.json.interrupted.tmp');
    await writeFile(join(dir, 'series.json'), '{broken');
    await expect(reopen().get(initial.id)).rejects.toThrow();
  });
  it('rejects obsolete file formats and filesystem write errors instead of silently switching storage', async () => {
    const { dir, reopen } = await local();
    await writeFile(join(dir, 'series.json'), JSON.stringify({ version: 0, records: [] }));
    await expect(reopen().get('series')).rejects.toThrow(/reset/);
    const path = join(dir, 'not_a_directory');
    await writeFile(path, 'file');
    await expect(jsonSeriesStore(path).create(record())).rejects.toThrow();
  });
});

describe('obsolete PostgreSQL schema reset boundary', () => {
  it('rejects an obsolete initialized schema without rewriting or resetting its data', async () => {
    // Booting from the shared instance's data dir costs a fraction of a fresh initdb (seconds under load).
    const obsolete = await PGlite.create({ loadDataDir: await database.dumpDataDir('none') });
    const wire = new PGLiteSocketServer({ db: obsolete, port: 0, maxConnections: 4 });
    try {
      await obsolete.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE playerthree_migrations (scope text NOT NULL,name text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(scope,name)); INSERT INTO playerthree_migrations(scope,name) VALUES ('playerthree','001_init.sql'); CREATE TABLE playerthree_commander_artifacts (game text,owner text,role text,surface_hash text); INSERT INTO playerthree_commander_artifacts VALUES ('old','owner','player','pinned');");
      await wire.start();
      await expect(openPostgresStorage({ url: `postgres://postgres@${wire.getServerConn()}/postgres`, max: 2 })).rejects.toThrow(/explicit operator reset/);
      expect((await obsolete.query<{ role: string }>('SELECT role FROM playerthree_commander_artifacts')).rows).toEqual([{ role: 'player' }]);
    } finally {
      await wire.stop();
      await obsolete.close();
    }
  });
});
