/**
 * Operator reset of an obsolete PlayerThree database to the current schema (`playerthree db reset`). Owned tables
 * are the `playerthree_*` tables, the migration ledger, and the tables created by the ledger-recorded migration files
 * of each given game scope; nothing else in the database is touched. The drop runs in one transaction under the
 * migration advisory lock and re-checks the confirmed plan first; migrations are then re-applied through
 * `openPostgresStorage`. The connection string is never logged. A separate entry (`playerthree/postgres/reset`) so the
 * storage runtime never loads it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { openPostgresStorage } from './index.ts';
import { LEDGER_TABLE, MIGRATION_FILE, MIGRATION_LOCK, PLAYERTHREE_SCOPE } from './ledger.ts';

/** Options of a database reset: the connection and the game migration sets to drop and re-apply. */
export interface PostgresResetOptions {
  /** postgres:// connection string. */
  url: string;
  /** Game migration sets (as `openPostgresStorage`'s `migrations`) whose recorded tables are dropped and re-migrated. */
  migrations?: { scope: string; dir: string }[];
}

/** What a reset would drop, for the operator to confirm before anything is touched. */
export interface PostgresResetPlan {
  /** Server host and port from the connection string (never the credentials). */
  host: string;
  /** `current_database()`: the name an operator confirms. */
  database: string;
  /** `current_schema()`, where every listed table lives. */
  schema: string;
  /** Existing tables to drop, sorted. */
  tables: string[];
  /** Migration-ledger rows to drop, sorted by scope then name. */
  ledger: { scope: string; name: string }[];
}

const OWNED_PREFIX = `${PLAYERTHREE_SCOPE}_`;
/** Comments and string literals (blanked before scanning), or a dollar-quoted body (unsupported). */
const SQL_NOISE = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
const CREATE = /\bCREATE\s+/gi;
const CREATE_TABLE = /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(\s*\.)?/i;
const CREATE_INDEX = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i;

/** Tables a migration file creates. Anything it creates other than tables and their indexes is refused. */
function createdTables(sql: string, file: string): string[] {
  const text = sql.replace(SQL_NOISE, (m) => {
    if (m.startsWith('$')) throw new Error(`reset: ${file} uses dollar quoting; only CREATE TABLE / CREATE INDEX migrations can be reset`);
    return ' ';
  });
  const tables: string[] = [];
  for (const m of text.matchAll(CREATE)) {
    const rest = text.slice(m.index);
    const table = CREATE_TABLE.exec(rest);
    if (table) {
      if (table[2]) throw new Error(`reset: ${file} creates a schema-qualified table; only current-schema tables can be reset`);
      const name = table[1]!;
      tables.push(name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase());
    } else if (!CREATE_INDEX.test(rest)) {
      throw new Error(`reset: ${file} creates ${/^CREATE\s+(\S+)/i.exec(rest)![1]!.toUpperCase()}; only CREATE TABLE / CREATE INDEX migrations can be reset`);
    }
  }
  return tables;
}

function validateSets(sets: { scope: string; dir: string }[]): void {
  const seen = new Set<string>();
  for (const { scope, dir } of sets) {
    if (typeof scope !== 'string' || scope.length === 0 || scope === PLAYERTHREE_SCOPE) throw new Error('reset: migrations scope must be a non-empty name other than "playerthree"');
    if (typeof dir !== 'string' || dir.length === 0) throw new Error(`reset: migrations dir for scope ${scope} is required`);
    if (seen.has(scope)) throw new Error(`reset: scope ${scope} given twice`);
    seen.add(scope);
  }
}

async function computePlan(client: pg.Client, host: string, sets: { scope: string; dir: string }[]): Promise<PostgresResetPlan> {
  const [where] = (await client.query<{ database: string; schema: string | null }>('SELECT current_database() AS database, current_schema() AS schema')).rows;
  if (!where?.schema) throw new Error('reset: no current schema (empty search_path)');
  const existing = new Set(
    (await client.query<{ tablename: string }>('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = current_schema()')).rows.map((r) => r.tablename),
  );
  const ledger = existing.has(LEDGER_TABLE)
    ? (await client.query<{ scope: string; name: string }>(`SELECT scope, name FROM ${LEDGER_TABLE} ORDER BY scope, name`)).rows.map(({ scope, name }) => ({ scope, name }))
    : [];
  const given = new Set(sets.map((s) => s.scope));
  const unknown = [...new Set(ledger.map((r) => r.scope))].filter((s) => s !== PLAYERTHREE_SCOPE && !given.has(s));
  if (unknown.length > 0) {
    throw new Error(`reset: the ledger records scope(s) ${unknown.join(', ')} not given; pass --migrations <scope>=<dir> for each so their tables are reset with the ledger`);
  }

  const drop = new Set([...existing].filter((t) => t.startsWith(OWNED_PREFIX)));
  for (const { scope, dir } of sets) {
    const files = new Set(readdirSync(dir).filter((n) => MIGRATION_FILE.test(n)));
    const recorded = new Set(ledger.filter((r) => r.scope === scope).map((r) => r.name));
    for (const name of recorded) if (!files.has(name)) throw new Error(`reset: ledger row ${scope}/${name} has no file in the given directory; cannot tell which tables it created`);
    for (const name of [...files].sort()) {
      for (const table of createdTables(readFileSync(join(dir, name), 'utf8'), `${scope}/${name}`)) {
        if (!existing.has(table)) continue;
        if (recorded.has(name)) drop.add(table);
        else if (!drop.has(table)) throw new Error(`reset: table ${table} exists but ${scope}/${name} is not recorded in the ledger; it is not owned, so drop or record it yourself`);
      }
    }
  }
  return { host, database: where.database, schema: where.schema, tables: [...drop].sort(), ledger };
}

async function withClient<T>(url: string, fn: (client: pg.Client, host: string) => Promise<T>): Promise<T> {
  if (typeof url !== 'string' || url.length === 0) throw new Error('reset: url is required');
  const client = new pg.Client({ connectionString: url });
  // Connection-level errors after connect surface on the next query; never crash on the emitter.
  client.on('error', () => {});
  const host = client.port ? `${client.host}:${client.port}` : client.host;
  await client.connect();
  try {
    return await fn(client, host);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Connects and lists what `resetPostgresStorage` would drop. Read-only. Throws on any ownership mismatch. */
export async function planPostgresReset(opts: PostgresResetOptions): Promise<PostgresResetPlan> {
  const sets = opts.migrations ?? [];
  validateSets(sets);
  return withClient(opts.url, (client, host) => computePlan(client, host, sets));
}

/**
 * Drops exactly the confirmed plan's tables in one transaction (under the migration advisory lock, after re-checking
 * that the database still matches the plan), then re-applies PlayerThree's and every given scope's migrations through
 * `openPostgresStorage`. Returns the fresh ledger.
 */
export async function resetPostgresStorage(opts: PostgresResetOptions & { plan: PostgresResetPlan }): Promise<{ scope: string; name: string }[]> {
  const sets = opts.migrations ?? [];
  validateSets(sets);
  await withClient(opts.url, async (client, host) => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
      const now = await computePlan(client, host, sets);
      const { plan } = opts;
      if (now.database !== plan.database || now.schema !== plan.schema || JSON.stringify([now.tables, now.ledger]) !== JSON.stringify([plan.tables, plan.ledger])) {
        throw new Error('reset: the database changed since it was listed (or is a different database); nothing was dropped');
      }
      // RESTRICT (the default): a foreign key or view from a table that is not owned aborts the whole reset.
      if (now.tables.length > 0) await client.query(`DROP TABLE ${now.tables.map((t) => `"${t.replaceAll('"', '""')}"`).join(', ')}`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
  for (const set of sets.length > 0 ? sets : [undefined]) {
    const storage = await openPostgresStorage({ url: opts.url, max: 1, migrations: set });
    await storage.close();
  }
  return withClient(opts.url, async (client) => (await client.query<{ scope: string; name: string }>(`SELECT scope, name FROM ${LEDGER_TABLE} ORDER BY scope, name`)).rows.map(({ scope, name }) => ({ scope, name })));
}
