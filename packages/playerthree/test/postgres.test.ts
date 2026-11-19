/**
 * `playerthree/postgres` against a real PostgreSQL wire server: PGlite (Postgres compiled to wasm) behind
 * PGliteSocketServer on an ephemeral port, driven by the real `pg` driver.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definition, EXAMPLE_POLICY, type TagManifest } from '../examples/tag/index.ts';
import { createPlayerThreeHost, policyArtifactHash } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeTraceEvent, SessionRecord, StoredCommanderArtifact, StoredOwner, StoredPolicyArtifact, StoredPoolEntry } from '../src/host/types.ts';
import type { StoredClient, StoredConnection } from '../src/mcp/index.ts';
import { openPostgresStorage, type PostgresStorage, type PostgresStorageOptions } from '../src/postgres/index.ts';

const ALICE = 'alice_owner_0001';
const WASM_CODE = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 255, 0]).toString('base64');
const JS_CODE = 'function think() { return []; } // ünïcode';
const WASM: StoredPolicyArtifact = { runtime: 'wasm', code: WASM_CODE, surfaceHash: 'a'.repeat(64), artifactHash: policyArtifactHash({ runtime: 'wasm', code: WASM_CODE }) };
const JS: StoredPolicyArtifact = { runtime: 'js', code: JS_CODE, surfaceHash: 'b'.repeat(64), artifactHash: policyArtifactHash({ runtime: 'js', code: JS_CODE }) };
/** Library versions: a plain deploy-era row (nothing retained) and an imported one carrying everything a package needs. */
const LIB_WASM: StoredCommanderArtifact = { ...WASM, source: null, detail: null, provenance: { parent: null, license: null, author: null } };
const LIB_JS: StoredCommanderArtifact = {
  ...JS,
  source: { runtime: 'js', modules: { 'main.ts': JS_CODE }, entry: 'main.ts', include: ['tag-strategy/policies/simple.js'] },
  detail: ['you'],
  provenance: { parent: 'c'.repeat(64), license: 'MIT', author: 'Ada' },
};

let db: PGlite;
let server: PGLiteSocketServer;
let url: string;
const dirs: string[] = [];

beforeAll(async () => {
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port: 0, maxConnections: 8 });
  await server.start();
  // Port 0: the server reports the ephemeral port it bound.
  url = `postgres://postgres@${server.getServerConn()}/postgres`;
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await db?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const open = (opts: Partial<PostgresStorageOptions> = {}) => openPostgresStorage({ url, max: 4, ...opts });
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'playerthree-pg-'));
  dirs.push(d);
  return d;
};
const owner = (id: string, createdAt = 1): StoredOwner => ({ owner: id, createdAt, commanders: [] });
const entry = (id: string, game: string, wins = 0): StoredPoolEntry => ({
  id,
  game,
  role: 'runner',
  runtime: 'js',
  surfaceHash: JS.surfaceHash,
  wins,
  losses: 0,
  draws: 0,
  createdAt: 5,
  drafts: 0,
  owner: 'commander:alice_owner_0001',
});
const session = (id: string, game: string, releasedAt: number, replay = true): SessionRecord => ({
  id,
  game,
  gameVersion: '1',
  seed: 1,
  options: null,
  createdAt: releasedAt - 10,
  endedAt: releasedAt - 1,
  releasedAt,
  ticks: 3,
  seconds: 0.15,
  teams: ['blue', 'red'],
  alliances: null,
  outcomes: { blue: 'win', red: 'loss' },
  ranks: { blue: 1, red: 2 },
  owners: {},
  sameOwnerOpposed: false,
  seats: [],
  rejections: 0,
  policyErrors: 0,
  codes: { rejections: [], policyErrors: [] },
  replayBytes: 12,
  from: 0,
  replay,
});

describe('migrations', () => {
  it('applies PlayerThree and game migrations once, in name order, under their scopes', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '001_profiles.sql'), 'CREATE TABLE game_profiles (id text PRIMARY KEY, name text NOT NULL);');
    writeFileSync(join(dir, '002_seed.sql'), "INSERT INTO game_profiles VALUES ('p1', 'Ada');");
    writeFileSync(join(dir, 'notes.md'), 'not a migration');
    const migrations = { scope: 'mig_game', dir };

    let storage = await open({ migrations });
    expect(await storage.query('SELECT name FROM game_profiles WHERE id = $1', ['p1'])).toEqual([{ name: 'Ada' }]);
    await storage.close();
    await storage.close();

    // Reopening is a no-op (re-running 001 would fail: CREATE TABLE without IF NOT EXISTS); a new file applies.
    writeFileSync(join(dir, '003_more.sql'), "INSERT INTO game_profiles VALUES ('p2', 'Grace');");
    storage = await open({ migrations });
    expect(await storage.query<{ id: string }>('SELECT id FROM game_profiles ORDER BY id')).toEqual([{ id: 'p1' }, { id: 'p2' }]);
    const applied = await storage.query<{ scope: string; name: string }>(
      "SELECT scope, name FROM playerthree_migrations WHERE scope IN ('playerthree', 'mig_game') ORDER BY scope, name",
    );
    expect(applied).toEqual([
      { scope: 'mig_game', name: '001_profiles.sql' },
      { scope: 'mig_game', name: '002_seed.sql' },
      { scope: 'mig_game', name: '003_more.sql' },
      { scope: 'playerthree', name: '001_init.sql' },
      { scope: 'playerthree', name: '002_policy_source.sql' },
    ]);
    await storage.close();
    await expect(storage.query('SELECT 1')).rejects.toThrow(/closed/);
  });


  it('rolls a failing migration back and records nothing', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '001_bad.sql'), 'CREATE TABLE half_done (id int); SELECT no_such_column FROM half_done;');
    await expect(open({ migrations: { scope: 'bad_game', dir } })).rejects.toThrow(/bad_game\/001_bad\.sql/);
    const storage = await open();
    expect(await storage.query("SELECT to_regclass('half_done') AS t")).toEqual([{ t: null }]);
    expect(await storage.query("SELECT name FROM playerthree_migrations WHERE scope = 'bad_game'")).toEqual([]);
    await storage.close();
    await expect(open({ migrations: { scope: 'playerthree', dir } })).rejects.toThrow(/scope/);
  });
});

describe('stores', () => {
  let storage: PostgresStorage;
  beforeAll(async () => {
    storage = await open();
  });
  afterAll(() => storage.close());

  it('commanders: key, owners and js/wasm artifacts, scoped by game', async () => {
    const s = storage.commanders('cmd_game');
    expect(storage.commanders('cmd_game')).toBe(s);
    expect(await s.load()).toEqual({ key: null, owners: [] });
    await s.saveKey('k'.repeat(43));
    await s.saveOwner(owner(ALICE));
    await s.saveOwner({ ...owner(ALICE), createdAt: 2 });
    await s.saveOwner(owner('bob_owner_000002'));
    await s.saveArtifact(ALICE, 'cmd_runner', 1, LIB_JS);
    await s.saveArtifact(ALICE, 'cmd_runner', 2, LIB_WASM);
    expect(await s.load()).toEqual({ key: 'k'.repeat(43), owners: [{ ...owner(ALICE), createdAt: 2 }, owner('bob_owner_000002')] });
    expect(await s.loadArtifact(ALICE, 'cmd_runner', 1)).toEqual(LIB_JS);
    expect(await s.loadArtifact(ALICE, 'cmd_runner', 2)).toEqual(LIB_WASM);
    expect(await s.loadArtifact(ALICE, 'cmd_runner', 3)).toBeUndefined();
    expect(await storage.commanders('cmd_other').load()).toEqual({ key: null, owners: [] });
    expect(await storage.commanders('cmd_other').loadArtifact(ALICE, 'cmd_runner', 1)).toBeUndefined();

    await s.deleteArtifact(ALICE, 'cmd_runner', 1);
    expect(await s.loadArtifact(ALICE, 'cmd_runner', 1)).toBeUndefined();
    await s.deleteOwner(ALICE);
    expect((await s.load()).owners.map((o) => o.owner)).toEqual(['bob_owner_000002']);
    expect(await s.loadArtifact(ALICE, 'cmd_runner', 2)).toBeUndefined();
  });

  it('connections: connections and clients, scoped by game', async () => {
    const s = storage.connections('con_game');
    const connection: StoredConnection = {
      id: 'con_AAAAAAAAAAAAAAAA',
      owner: ALICE,
      commander: 'cmd_postgres_fixture',
      client: { id: 'https://client.example/meta.json', registration: 'cimd', name: 'Client' },
      roles: ['runner'],
      resource: 'https://game.example/mcp',
      scope: 'playerthree',
      createdAt: 1,
      authorizedAt: 1,
      lastSeenAt: null,
      refresh: { digest: 'ab'.repeat(32), expiresAt: 10 },
      retired: [],
      access: [{ digest: 'cd'.repeat(32), expiresAt: 5 }],
    };
    const client: StoredClient = { id: 'dcr_1', registration: 'dcr', name: 'Registered', redirectUris: ['http://127.0.0.1/cb'], createdAt: 1, lastUsedAt: null };
    await s.saveConnection(connection);
    await s.saveConnection({ ...connection, lastSeenAt: 7 });
    await s.saveClient(client);
    expect(await s.load()).toEqual({ connections: [{ ...connection, lastSeenAt: 7 }], clients: [client] });
    expect(await storage.connections('con_other').load()).toEqual({ connections: [], clients: [] });
    await s.deleteConnection(connection.id);
    await s.deleteClient(client.id);
    expect(await s.load()).toEqual({ connections: [], clients: [] });
  });

  it('pool: entries and js/wasm artifacts, scoped by game', async () => {
    const s = storage.pool('pool_game');
    await s.saveArtifact('pol_1', JS);
    await s.saveEntry(entry('pol_1', 'pool_game'));
    await s.saveArtifact('pol_2', WASM);
    await s.saveEntry({ ...entry('pol_2', 'pool_game'), disabled: true });
    await s.saveEntry(entry('pol_1', 'pool_game', 3));
    expect(await s.load()).toEqual({ entries: [entry('pol_1', 'pool_game', 3), { ...entry('pol_2', 'pool_game'), disabled: true }] });
    expect(await s.loadArtifact('pol_1')).toEqual(JS);
    expect(await s.loadArtifact('pol_2')).toEqual(WASM);
    expect(await storage.pool('pool_other').load()).toEqual({ entries: [] });
    expect(await storage.pool('pool_other').loadArtifact('pol_1')).toBeUndefined();
    await s.deleteEntry('pol_2');
    expect((await s.load()).entries.map((e) => e.id)).toEqual(['pol_1']);
    expect(await s.loadArtifact('pol_2')).toBeUndefined();
  });

  it('history: records with and without replays, oldest first, scoped by game', async () => {
    const s = storage.history('his_game');
    const replay = { format: 'playerthree.replay', version: 1, game: 'his_game', gameVersion: '1', seed: 1, ticks: 3, entries: [[0, 'blue', 'runner', { kind: 'move', x: 1, y: 2 }]], outcomes: { b: 'win', a: 'loss' } };
    await s.save(session('s2', 'his_game', 2000), JSON.stringify(replay));
    await s.save(session('s1', 'his_game', 1000, false), null);
    // A record claiming a replay that was never stored loads as replay: false.
    await s.save(session('s3', 'his_game', 3000), null);
    expect(await s.load()).toEqual([session('s1', 'his_game', 1000, false), session('s2', 'his_game', 2000), session('s3', 'his_game', 3000, false)]);
    // Kept verbatim (json, not jsonb): key order survives.
    expect(JSON.stringify(await s.loadReplay('s2'))).toBe(JSON.stringify(replay));
    expect(await s.loadReplay('s1')).toBeUndefined();
    expect(await s.loadReplay('nope')).toBeUndefined();
    expect(await storage.history('his_other').load()).toEqual([]);
    await s.delete('s2');
    expect((await s.load()).map((r) => r.id)).toEqual(['s1', 's3']);
  });

  it('applies unawaited writes in issue order', async () => {
    const s = storage.pool('order_game');
    const ops: Promise<void>[] = [];
    for (let wins = 0; wins < 30; wins++) ops.push(s.saveEntry(entry('pol_7', 'order_game', wins)) as Promise<void>);
    ops.push(s.deleteEntry('pol_7') as Promise<void>);
    ops.push(s.saveEntry(entry('pol_7', 'order_game', 99)) as Promise<void>);
    await Promise.all(ops);
    expect(await s.load()).toEqual({ entries: [entry('pol_7', 'order_game', 99)] });
  });

  it('a failed operation rejects only itself', async () => {
    const s = storage.commanders('fail_game');
    const bad = s.saveArtifact(ALICE, 'cmd_runner', 2 ** 40, LIB_JS);
    const good = s.saveOwner(owner(ALICE));
    await expect(bad).rejects.toThrow();
    await good;
    expect((await s.load()).owners).toEqual([owner(ALICE)]);
  });
});

describe('close', () => {
  it('drains every store before ending the pool', async () => {
    const storage = await open();
    const pool = storage.pool('drain_game');
    const history = storage.history('drain_game');
    for (let wins = 0; wins < 10; wins++) void pool.saveEntry(entry('pol_9', 'drain_game', wins));
    void history.save(session('d1', 'drain_game', 1000), '{"a":1}');
    await storage.close();
    await expect(pool.load()).rejects.toThrow(/closed/);

    const again = await open();
    expect(await again.pool('drain_game').load()).toEqual({ entries: [entry('pol_9', 'drain_game', 9)] });
    expect(await again.history('drain_game').loadReplay('d1')).toEqual({ a: 1 });
    await again.close();
  });
});

describe('host on Postgres', () => {
  const hostOn = (storage: PostgresStorage, maxSessions = 5): PlayerThreeHost<TagManifest> =>
    createPlayerThreeHost({
      definition,
      commanderStore: storage.commanders('tag'),
      poolStore: storage.pool('tag'),
      history: { store: storage.history('tag'), maxSessions },
    });

  it('reloads rosters, pool and history after a restart; history pruning deletes rows', { timeout: 60_000 }, async () => {
    let storage = await open();
    let host = hostOn(storage);
    expect(host.history.limits.dir).toBeNull();
    await host.ready;
    const commander = host.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } });
    host.commanders.update(ALICE, commander.id, { botLevel: 'hard' });
    const token = host.commanders.token(ALICE, commander.id);

    const author = host.createMatch({ seed: 4, realtime: false, controllers: { blue: { runner: 'none', guard: 'none' }, red: { runner: 'none', guard: 'none' } } });
    const seat = author.seat('red', 'runner');
    expect(await seat.policyDeploy({ runtime: 'js', code: EXAMPLE_POLICY })).toMatchObject({ ok: true });
    const published = await seat.publish();
    if (!('policyId' in published)) throw new Error('expected a published policy');
    author.dispose();

    const played = host.createMatch({ seed: 1, realtime: false });
    await played.step(5);
    played.end('draw');
    const replay = played.replay();
    played.dispose();
    const records = host.history.list();
    expect(records.map((r) => r.id)).toEqual([played.id, author.id]);
    const roster = host.commanders.roster(ALICE);
    host.dispose();
    // No explicit flush: close() drains the stores' queued writes.
    await storage.close();

    storage = await open();
    host = hostOn(storage);
    await host.ready;
    expect(host.commanders.has(ALICE)).toBe(true);
    expect(host.commanders.token(ALICE, commander.id)).toBe(token);
    expect(host.commanders.roster(ALICE).map(({ connected: _c, ...r }) => r)).toEqual(roster.map(({ connected: _c, ...r }) => r));
    expect(host.pool.list()).toEqual([expect.objectContaining({ id: published.policyId, game: 'tag', role: 'runner', runtime: 'js' })]);
    expect(host.history.list()).toEqual(records);
    expect(await host.history.replay(played.id)).toEqual(replay);

    // The pool artifact loads from Postgres when a seat drafts it.
    const traces: PlayerThreeTraceEvent[] = [];
    host.onTrace((e) => traces.push(e));
    const drafted = host.createMatch({ seed: 2, realtime: false });
    drafted.setController('red', 'runner', 'policy', { poolPolicy: published.policyId });
    await drafted.step(20);
    expect(traces.some((e) => e.type === 'policy_call' && e.pool && e.team === 'red')).toBe(true);
    drafted.dispose();
    host.dispose();
    await host.history.flush();
    await storage.close();

    // A smaller bound prunes loaded records and deletes their rows.
    storage = await open();
    host = hostOn(storage, 1);
    await host.ready;
    expect(host.history.list().map((r) => r.id)).toEqual([drafted.id]);
    await host.history.flush();
    expect(await storage.query("SELECT id FROM playerthree_sessions WHERE game = 'tag'")).toEqual([{ id: drafted.id }]);
    host.dispose();
    await storage.close();
  });

  it('commander log: insert-only chained entries, tallies after restart, verdict rows and the sealed-only tombstone', { timeout: 60_000 }, async () => {
    let storage = await open();
    const logged = (s: PostgresStorage) => createPlayerThreeHost({ definition, commanderStore: s.commanders('logtag'), commanderLog: { store: s.commanderLog('logtag') } });
    let host = logged(storage);
    await host.ready;
    const alice = host.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true }, metadata: { model: 'm' } });
    const play = async (h: PlayerThreeHost<TagManifest>, outcome: 'win' | 'loss') => {
      const match = h.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice.id } }] });
      await match.step(1);
      match.end({ blue: outcome, red: outcome === 'win' ? 'loss' : 'win' });
      match.dispose();
      return match.id;
    };
    const first = await play(host, 'win');
    await host.commanders.flush();
    host.dispose();
    await storage.close();
    storage = await open();
    host = logged(storage);
    await host.ready;
    expect(host.commanders.roster(ALICE)[0]!.record).toEqual({ wins: 1, losses: 0, draws: 0 });
    await play(host, 'loss');
    const rows = await host.commanders.log(ALICE, alice.id);
    expect(rows.map((r) => r.entry.seq)).toEqual([1, 2]);
    expect(rows[1]!.entry.prevDigest).toBe(rows[0]!.entry.digest);
    expect((await host.commanderLog.match(first)).map((r) => r.entry.entryId)).toEqual([rows[0]!.entry.entryId]);
    // Insert only: a second entry for the same (commander, seq) is refused by the table.
    await expect(storage.commanderLog('logtag').append(rows[0]!)).rejects.toThrow();
    const void_ = await host.commanderLog.amend(rows[0]!.entry.entryId, { rated: false, pool: null, segmentId: null, weight: 0, badges: [], reasons: ['voided_review'] }, 'review');
    expect(await host.commanderLog.verdicts()).toEqual([void_]);
    await host.commanders.delete(ALICE, alice.id);
    await host.commanderLog.flush();
    const kept = await host.commanderLog.entries(alice.id);
    expect(kept.map((r) => r.sealed)).toEqual([null, null]);
    expect(kept.map((r) => r.entry)).toEqual(rows.map((r) => r.entry));
    host.dispose();
    await storage.close();
  });
});
