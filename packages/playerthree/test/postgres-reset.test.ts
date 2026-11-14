/**
 * `resetPostgresStorage` against PGlite (Postgres compiled to wasm) behind PGliteSocketServer, via the real `pg` driver:
 * drops exactly the owned tables in one transaction, refuses ownership mismatches, and re-migrates to a bootable schema.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPostgresStorage } from '../src/postgres/index.ts';
import { planPostgresReset, resetPostgresStorage } from '../src/postgres/reset.ts';

let db: PGlite;
let server: PGLiteSocketServer;
let url: string;
let dir: string;

beforeEach(async () => {
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port: 0, maxConnections: 8 });
  await server.start();
  url = `postgres://postgres@${server.getServerConn()}/postgres`;
  dir = mkdtempSync(join(tmpdir(), 'playerthree-reset-'));
  writeFileSync(
    join(dir, '001_widgets.sql'),
    "-- CREATE TABLE commented_out (x int);\nCREATE TABLE widgets (id text PRIMARY KEY, label text DEFAULT 'create table nope (x int)');\nCREATE UNIQUE INDEX widgets_label ON widgets (label);",
  );
}, 60_000);

afterEach(async () => {
  await server?.stop();
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const game = () => ({ scope: 'game', dir });
/** Boots once (PlayerThree + game migrations), seeds owned rows and an unrelated `bystander` table. */
async function seed(): Promise<void> {
  const storage = await openPostgresStorage({ url, max: 2, migrations: game() });
  await storage.query("INSERT INTO widgets (id) VALUES ('w1')");
  await storage.query("INSERT INTO playerthree_commander_keys (game, key) VALUES ('g', 'k')");
  await storage.query('CREATE TABLE bystander (id int PRIMARY KEY)');
  await storage.query('INSERT INTO bystander VALUES (7)');
  await storage.close();
}
const tables = async () => (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map((r) => r.tablename);

describe('resetPostgresStorage', () => {
  it('drops only owned tables, then re-migrates an obsolete database to a bootable schema', async () => {
    await seed();
    // An obsolete database: a table the current schema needs is missing, a removed one lingers.
    await db.exec('DROP TABLE playerthree_benchmark_publications; CREATE TABLE playerthree_legacy (x int);');
    await expect(openPostgresStorage({ url, migrations: game() })).rejects.toThrow(/obsolete schema/);

    const plan = await planPostgresReset({ url, migrations: [game()] });
    expect(plan).toMatchObject({ database: 'postgres', schema: 'public' });
    expect(plan.host).toMatch(/:\d+$/);
    expect(plan.tables).toContain('playerthree_legacy');
    expect(plan.tables).toContain('playerthree_migrations');
    expect(plan.tables).toContain('widgets');
    expect(plan.tables).not.toContain('bystander');
    expect(plan.tables.every((t) => t === 'widgets' || t.startsWith('playerthree_'))).toBe(true);
    expect(plan.ledger).toEqual([
      { scope: 'game', name: '001_widgets.sql' },
      { scope: 'playerthree', name: '001_init.sql' },
      { scope: 'playerthree', name: '002_policy_source.sql' },
    ]);

    const ledger = await resetPostgresStorage({ url, migrations: [game()], plan });
    expect(ledger).toEqual(plan.ledger);
    const after = await tables();
    expect(after).toContain('bystander');
    expect(after).toContain('playerthree_benchmark_publications');
    expect(after).not.toContain('playerthree_legacy');
    expect((await db.query('SELECT id FROM bystander')).rows).toEqual([{ id: 7 }]);
    expect((await db.query('SELECT * FROM widgets')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM playerthree_commander_keys')).rows).toEqual([]);
    const storage = await openPostgresStorage({ url, migrations: game() });
    await storage.close();
  });

  it('refuses a ledger scope that was not given, before dropping anything', async () => {
    await seed();
    const before = await tables();
    await expect(planPostgresReset({ url })).rejects.toThrow(/scope\(s\) game not given/);
    const plan = await planPostgresReset({ url, migrations: [game()] });
    await expect(resetPostgresStorage({ url, plan })).rejects.toThrow(/scope\(s\) game not given/);
    expect(await tables()).toEqual(before);
  });

  it('refuses an existing table whose migration is not recorded (not owned)', async () => {
    await seed();
    writeFileSync(join(dir, '002_gadgets.sql'), 'CREATE TABLE gadgets (id int);');
    await db.exec('CREATE TABLE gadgets (id int)');
    await expect(planPostgresReset({ url, migrations: [game()] })).rejects.toThrow(/gadgets exists but game\/002_gadgets\.sql is not recorded/);
  });

  it('refuses a recorded migration missing from the given directory', async () => {
    await seed();
    const other = mkdtempSync(join(tmpdir(), 'playerthree-reset-'));
    try {
      await expect(planPostgresReset({ url, migrations: [{ scope: 'game', dir: other }] })).rejects.toThrow(/game\/001_widgets\.sql has no file/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses migrations that create objects other than tables and indexes', async () => {
    await seed();
    writeFileSync(join(dir, '002_view.sql'), 'CREATE VIEW widget_ids AS SELECT id FROM widgets;');
    await expect(planPostgresReset({ url, migrations: [game()] })).rejects.toThrow(/creates VIEW/);
  });

  it('drops nothing when the database changed since it was listed', async () => {
    await seed();
    const plan = await planPostgresReset({ url, migrations: [game()] });
    await db.exec('CREATE TABLE playerthree_late (x int)');
    const before = await tables();
    await expect(resetPostgresStorage({ url, migrations: [game()], plan })).rejects.toThrow(/changed since it was listed/);
    expect(await tables()).toEqual(before);
    await expect(resetPostgresStorage({ url, migrations: [game()], plan: { ...plan, database: 'elsewhere' } })).rejects.toThrow(/changed since/);
  });

  it('rolls the whole drop back when a table it does not own depends on an owned one', async () => {
    await seed();
    await db.exec('CREATE TABLE fan (id text REFERENCES widgets (id))');
    const before = await tables();
    const plan = await planPostgresReset({ url, migrations: [game()] });
    await expect(resetPostgresStorage({ url, migrations: [game()], plan })).rejects.toThrow();
    expect(await tables()).toEqual(before);
    expect((await db.query('SELECT id FROM widgets')).rows).toEqual([{ id: 'w1' }]);
  });
});
