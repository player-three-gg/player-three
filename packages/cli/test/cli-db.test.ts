/**
 * `playerthree db reset` against PGlite behind PGliteSocketServer (real `pg` driver): confirmation gating, output
 * without credentials, owned-only drops and re-migration.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { openPostgresStorage } from 'playerthree/postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/index.ts';

const SECRET = 'hunter2-not-logged';
let db: PGlite;
let server: PGLiteSocketServer;
let url: string;
let dir: string;

beforeAll(async () => {
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port: 0, maxConnections: 8 });
  await server.start();
  url = `postgres://postgres:${SECRET}@${server.getServerConn()}/postgres`;
  dir = mkdtempSync(join(tmpdir(), 'playerthree-cli-db-'));
  writeFileSync(join(dir, '001_widgets.sql'), 'CREATE TABLE widgets (id text PRIMARY KEY);');
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  const storage = await openPostgresStorage({ url, max: 2, migrations: { scope: 'game', dir } });
  await storage.query("INSERT INTO widgets (id) VALUES ('w1') ON CONFLICT DO NOTHING");
  await storage.query('CREATE TABLE IF NOT EXISTS bystander (id int PRIMARY KEY)');
  await storage.query('INSERT INTO bystander VALUES (7) ON CONFLICT DO NOTHING');
  await storage.close();
});

function capture(extra: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), color: false, env: { DATABASE_URL: url }, interactive: false, ...extra };
  return { io, out, err, all: () => [...out, ...err].join('\n') };
}
const run = (args: string[], extra?: Partial<Io>) => {
  const c = capture(extra);
  return main(['db', 'reset', '--migrations', `game=${dir}`, ...args], c.io).then((code) => ({ code, ...c }));
};
const widgets = async () => (await db.query<{ id: string }>('SELECT id FROM widgets')).rows.map((r) => r.id);

describe('playerthree db reset', () => {
  it('needs DATABASE_URL from the environment', async () => {
    const c = capture({ env: {} });
    expect(await main(['db', 'reset'], c.io)).toBe(2);
    expect(c.all()).toMatch(/DATABASE_URL is not set/);
  });

  it('lists the plan with host and database, never the password, and refuses without --yes', async () => {
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.all()).not.toContain(SECRET);
    expect(r.out[0]).toMatch(/^host .+:\d+, database postgres, schema public$/);
    expect(r.all()).toContain('playerthree_migrations');
    expect(r.all()).toContain('  widgets');
    expect(r.all()).toContain('game/001_widgets.sql');
    expect(r.all()).not.toContain('bystander');
    expect(r.err.join('\n')).toMatch(/refusing without --yes/);
    expect(await widgets()).toEqual(['w1']);
  });

  it('refuses a non-terminal without --confirm, and a mismatched --confirm or typed name', async () => {
    let r = await run(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/not a terminal/);
    r = await run(['--yes', '--confirm', 'postgres2']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/does not match database postgres/);
    const asked: string[] = [];
    r = await run(['--yes'], { interactive: true, prompt: async (q) => (asked.push(q), 'Postgres') });
    expect(r.code).toBe(1);
    expect(asked).toHaveLength(1);
    // Without --yes the prompt never appears.
    r = await run([], { interactive: true, prompt: async () => 'postgres' });
    expect(r.code).toBe(1);
    expect(await widgets()).toEqual(['w1']);
  });

  it('resets only owned tables with --yes and the typed database name, leaving a bootable schema', async () => {
    const r = await run(['--yes'], { interactive: true, prompt: async () => 'postgres\n' });
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toMatch(/^reset postgres: dropped \d+ table\(s\); applied game\/001_widgets\.sql, playerthree\/001_init\.sql, playerthree\/002_policy_source\.sql$/);
    expect(await widgets()).toEqual([]);
    expect((await db.query('SELECT id FROM bystander')).rows).toEqual([{ id: 7 }]);
    const storage = await openPostgresStorage({ url, migrations: { scope: 'game', dir } });
    await storage.close();
  });

  it('accepts an exact --confirm non-interactively', async () => {
    const r = await run(['--yes', '--confirm', 'postgres']);
    expect(r.code).toBe(0);
    expect(r.all()).not.toContain(SECRET);
    expect(await widgets()).toEqual([]);
  });

  it('exits non-zero when a ledger scope is not given', async () => {
    const c = capture();
    expect(await main(['db', 'reset', '--yes', '--confirm', 'postgres'], c.io)).toBe(1);
    expect(c.err.join('\n')).toMatch(/scope\(s\) game not given/);
    expect(await widgets()).toEqual(['w1']);
  });
});
