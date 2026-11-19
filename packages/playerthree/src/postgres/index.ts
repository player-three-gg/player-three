/**
 * `playerthree/postgres` — durable storage for PlayerThree on PostgreSQL (e.g. Railway's `DATABASE_URL`): commander
 * rosters, OAuth connections, the published-policy pool and the session history, all game-scoped. Opening applies the
 * pending migrations — PlayerThree's own (`./migrations`, scope `playerthree`), then the game's — each in its own
 * transaction, under a session advisory lock so concurrent instances never migrate twice.
 *
 * Each store runs its operations one at a time in issue order (the connection pool could otherwise reorder them), and
 * `close()` drains every store before it ends the pool. The connection string is never logged.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PolicyArtifact } from '../control.ts';
import type { CommanderStore, HistoryStore, PoolStore, Replay, SessionRecord, StoredCommanderArtifact, StoredOwner, StoredPolicyArtifact, StoredPoolEntry } from '../host/types.ts';
import { commanderArtifact } from '../host/store.ts';
import type { CommanderLogHead, CommanderLogStore, CommanderLogVerdictRow, StoredCommanderLogEntry } from '../commander-log.ts';
import { policyArtifactHash } from '../host/pipeline.ts';
import type { ConnectionStore, StoredClient, StoredConnection } from '../mcp/oauth/store.ts';
import type { SeriesStore } from '../arena.ts';
import { LEDGER_TABLE, MIGRATION_FILE, MIGRATION_LOCK, PLAYERTHREE_SCOPE } from './ledger.ts';
import { postgresSeriesStore } from './series.ts';

export { PLAYERTHREE_SCOPE } from './ledger.ts';

/** Options of `openPostgresStorage`. */
export interface PostgresStorageOptions {
  /** postgres:// connection string (e.g. Railway's DATABASE_URL). */
  url: string;
  /** Pool size (default 10). */
  max?: number;
  /** The game's own migrations: a directory of `NNN_name.sql` files applied in name order after PlayerThree's, tracked under `scope`. */
  migrations?: { scope: string; dir: string };
}

/** Opened PostgreSQL storage: game-scoped stores to pass to the host, the MCP endpoint and the series runner. */
export interface PostgresStorage {
  commanders(game: string): CommanderStore;
  connections(game: string): ConnectionStore;
  pool(game: string): PoolStore;
  history(game: string): HistoryStore;
  commanderLog(game: string): CommanderLogStore;
  series(game: string): SeriesStore;
  /** Parameterized query for the game's own tables (rows). */
  query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]): Promise<R[]>;
  /** Waits for every store's queued operations, then ends the pool. Idempotent. */
  close(): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
/** Session advisory lock held while migrating. */
const LOCK_SQL = `SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;

/** One store's operations, in issue order. A failed operation rejects its own promise only. */
class Serial {
  pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly isClosed: () => boolean;

  constructor(isClosed: () => boolean) {
    this.isClosed = isClosed;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isClosed()) return Promise.reject(new Error('playerthree/postgres: storage is closed'));
    this.pending++;
    const p = this.tail.then(fn).finally(() => {
      this.pending--;
    });
    this.tail = p.catch(() => {});
    return p;
  }

  idle(): Promise<unknown> {
    return this.tail;
  }
}

const codeOf = (a: PolicyArtifact): Buffer => (a.runtime === 'wasm' ? Buffer.from(a.code, 'base64') : Buffer.from(a.code, 'utf8'));
const artifactOf = (runtime: string, code: Buffer, surfaceHash: string): StoredPolicyArtifact => {
  const artifact = runtime === 'wasm' ? { runtime: 'wasm' as const, code: code.toString('base64') } : { runtime: 'js' as const, code: code.toString('utf8') };
  return { ...artifact, surfaceHash, artifactHash: policyArtifactHash(artifact) };
};

async function migrate(pool: pg.Pool, sets: { scope: string; dir: string }[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(LOCK_SQL);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (scope text NOT NULL, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (scope, name))`,
      );
      for (const { scope, dir } of sets) {
        const applied = new Set((await client.query<{ name: string }>(`SELECT name FROM ${LEDGER_TABLE} WHERE scope = $1`, [scope])).rows.map((r) => r.name));
        for (const name of readdirSync(dir).filter((n) => MIGRATION_FILE.test(n)).sort()) {
          if (applied.has(name)) continue;
          const sql = readFileSync(join(dir, name), 'utf8');
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query(`INSERT INTO ${LEDGER_TABLE} (scope, name) VALUES ($1, $2)`, [scope, name]);
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw new Error(`playerthree/postgres: migration ${scope}/${name} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
          }
        }
      }
    } finally {
      await client.query(UNLOCK_SQL).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/** Connects, applies pending migrations (one transaction each, under a pg advisory lock), returns the storage. */
export async function openPostgresStorage(opts: PostgresStorageOptions): Promise<PostgresStorage> {
  if (typeof opts?.url !== 'string' || opts.url.length === 0) throw new Error('playerthree/postgres: url is required');
  const max = opts.max ?? 10;
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('playerthree/postgres: max must be a positive integer');
  const sets = [{ scope: PLAYERTHREE_SCOPE, dir: MIGRATIONS_DIR }];
  if (opts.migrations !== undefined) {
    const { scope, dir } = opts.migrations;
    if (typeof scope !== 'string' || scope.length === 0 || scope === PLAYERTHREE_SCOPE) throw new Error('playerthree/postgres: migrations.scope must be a non-empty name other than "playerthree"');
    if (typeof dir !== 'string' || dir.length === 0) throw new Error('playerthree/postgres: migrations.dir is required');
    sets.push({ scope, dir });
  }

  const pool = new pg.Pool({ connectionString: opts.url, max });
  // An idle client losing its connection must not crash the process; the next query reconnects.
  pool.on('error', (e) => console.error('playerthree/postgres: idle connection error:', e.message));
  try {
    await migrate(pool, sets);
    try {
      await pool.query('SELECT commander_id, surface_hash, source, detail, provenance FROM playerthree_commander_artifacts LIMIT 0');
      await pool.query('SELECT sealed, ended_at FROM playerthree_commander_log LIMIT 0');
      await pool.query('SELECT lease_expires_at FROM playerthree_series LIMIT 0');
      await pool.query('SELECT payload FROM playerthree_series_result_chunks LIMIT 0');
      await pool.query('SELECT digest, publication FROM playerthree_benchmark_publications LIMIT 0');
    } catch (error) {
      throw new Error('playerthree/postgres: obsolete schema; explicit operator reset required', { cause: error });
    }
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }

  let closed = false;
  let closing: Promise<void> | undefined;
  const serials: Serial[] = [];
  const stores = new Map<string, unknown>();
  const q = async <R extends pg.QueryResultRow>(text: string, params: unknown[]): Promise<R[]> => (await pool.query<R>(text, params)).rows;
  /** One store per kind and game, so every user of a game's store shares its operation order. */
  const cached = <S>(kind: string, game: string, make: (run: Serial['run']) => S): S => {
    if (typeof game !== 'string' || game.length === 0) throw new Error('playerthree/postgres: game id is required');
    const key = `${kind}\0${game}`;
    let store = stores.get(key) as S | undefined;
    if (store === undefined) {
      const serial = new Serial(() => closed);
      serials.push(serial);
      store = make((fn) => serial.run(fn));
      stores.set(key, store);
    }
    return store;
  };

  return {
    commanders: (game) =>
      cached<CommanderStore>('commanders', game, (run) => ({
        load: () =>
          run(async () => {
            const [key] = await q<{ key: string }>('SELECT key FROM playerthree_commander_keys WHERE game = $1', [game]);
            const owners = await q<{ record: StoredOwner }>('SELECT record FROM playerthree_commander_owners WHERE game = $1 ORDER BY owner', [game]);
            return { key: key?.key ?? null, owners: owners.map((r) => r.record) };
          }),
        saveKey: (key) =>
          run(async () => {
            await q('INSERT INTO playerthree_commander_keys (game, key) VALUES ($1, $2) ON CONFLICT (game) DO UPDATE SET key = EXCLUDED.key', [game, key]);
          }),
        saveOwner: (record) =>
          run(async () => {
            await q(
              'INSERT INTO playerthree_commander_owners (game, owner, record) VALUES ($1, $2, $3::jsonb) ON CONFLICT (game, owner) DO UPDATE SET record = EXCLUDED.record, updated_at = now()',
              [game, record.owner, JSON.stringify(record)],
            );
          }),
        deleteOwner: (owner) =>
          run(async () => {
            await q(
              'WITH a AS (DELETE FROM playerthree_commander_artifacts WHERE game = $1 AND owner = $2) DELETE FROM playerthree_commander_owners WHERE game = $1 AND owner = $2',
              [game, owner],
            );
          }),
        saveArtifact: (owner, commanderId, version, artifact) =>
          run(async () => {
            await q(
              'INSERT INTO playerthree_commander_artifacts (game, owner, commander_id, version, runtime, code, surface_hash, source, detail, provenance) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb) ' +
                'ON CONFLICT (game, owner, commander_id, version) DO UPDATE SET runtime = EXCLUDED.runtime, code = EXCLUDED.code, surface_hash = EXCLUDED.surface_hash, source = EXCLUDED.source, detail = EXCLUDED.detail, provenance = EXCLUDED.provenance',
              [game, owner, commanderId, version, artifact.runtime, codeOf(artifact), artifact.surfaceHash,
                artifact.source === null ? null : JSON.stringify(artifact.source), artifact.detail === null ? null : JSON.stringify(artifact.detail), JSON.stringify(artifact.provenance)],
            );
          }),
        loadArtifact: (owner, commanderId, version) =>
          run(async () => {
            const [row] = await q<{ runtime: string; code: Buffer; surface_hash: string } & { [K in 'source' | 'detail' | 'provenance']: StoredCommanderArtifact[K] | null }>(
              'SELECT runtime, code, surface_hash, source, detail, provenance FROM playerthree_commander_artifacts WHERE game = $1 AND owner = $2 AND commander_id = $3 AND version = $4',
              [game, owner, commanderId, version],
            );
            return row ? commanderArtifact({ ...artifactOf(row.runtime, row.code, row.surface_hash), source: row.source, detail: row.detail, ...(row.provenance ? { provenance: row.provenance } : {}) }) : undefined;
          }),
        deleteArtifact: (owner, commanderId, version) =>
          run(async () => {
            await q('DELETE FROM playerthree_commander_artifacts WHERE game = $1 AND owner = $2 AND commander_id = $3 AND version = $4', [game, owner, commanderId, version]);
          }),
      })),

    connections: (game) =>
      cached<ConnectionStore>('connections', game, (run) => ({
        load: () =>
          run(async () => {
            const connections = await q<{ record: StoredConnection }>('SELECT record FROM playerthree_oauth_connections WHERE game = $1 ORDER BY id', [game]);
            const clients = await q<{ record: StoredClient }>('SELECT record FROM playerthree_oauth_clients WHERE game = $1 ORDER BY id', [game]);
            return { connections: connections.map((r) => r.record), clients: clients.map((r) => r.record) };
          }),
        saveConnection: (c) =>
          run(async () => {
            await q(
              'INSERT INTO playerthree_oauth_connections (game, id, owner, record) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (game, id) DO UPDATE SET owner = EXCLUDED.owner, record = EXCLUDED.record',
              [game, c.id, c.owner, JSON.stringify(c)],
            );
          }),
        deleteConnection: (id) =>
          run(async () => {
            await q('DELETE FROM playerthree_oauth_connections WHERE game = $1 AND id = $2', [game, id]);
          }),
        saveClient: (c) =>
          run(async () => {
            await q('INSERT INTO playerthree_oauth_clients (game, id, record) VALUES ($1, $2, $3::jsonb) ON CONFLICT (game, id) DO UPDATE SET record = EXCLUDED.record', [
              game,
              c.id,
              JSON.stringify(c),
            ]);
          }),
        deleteClient: (id) =>
          run(async () => {
            await q('DELETE FROM playerthree_oauth_clients WHERE game = $1 AND id = $2', [game, id]);
          }),
      })),

    pool: (game) =>
      cached<PoolStore>('pool', game, (run) => ({
        load: () =>
          run(async () => {
            const rows = await q<{ record: StoredPoolEntry }>('SELECT record FROM playerthree_pool_entries WHERE game = $1 ORDER BY id', [game]);
            return { entries: rows.map((r) => r.record) };
          }),
        saveEntry: (entry) =>
          run(async () => {
            await q(
              'INSERT INTO playerthree_pool_entries (game, id, owner, record) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (game, id) DO UPDATE SET owner = EXCLUDED.owner, record = EXCLUDED.record',
              [game, entry.id, entry.owner, JSON.stringify(entry)],
            );
          }),
        deleteEntry: (id) =>
          run(async () => {
            await q('WITH a AS (DELETE FROM playerthree_pool_artifacts WHERE game = $1 AND id = $2) DELETE FROM playerthree_pool_entries WHERE game = $1 AND id = $2', [game, id]);
          }),
        saveArtifact: (id, artifact) =>
          run(async () => {
            await q(
              'INSERT INTO playerthree_pool_artifacts (game, id, runtime, code, surface_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (game, id) DO UPDATE SET runtime = EXCLUDED.runtime, code = EXCLUDED.code, surface_hash = EXCLUDED.surface_hash',
              [game, id, artifact.runtime, codeOf(artifact), artifact.surfaceHash],
            );
          }),
        loadArtifact: (id) =>
          run(async () => {
            const [row] = await q<{ runtime: string; code: Buffer; surface_hash: string }>('SELECT runtime, code, surface_hash FROM playerthree_pool_artifacts WHERE game = $1 AND id = $2', [game, id]);
            return row ? artifactOf(row.runtime, row.code, row.surface_hash) : undefined;
          }),
      })),

    history: (game) =>
      cached<HistoryStore>('history', game, (run) => ({
        load: () =>
          run(async () => {
            const rows = await q<{ record: SessionRecord; kept: boolean }>(
              'SELECT record, replay IS NOT NULL AS kept FROM playerthree_sessions WHERE game = $1 ORDER BY released_at, id',
              [game],
            );
            return rows.map((r) => ({ ...r.record, replay: r.record.replay === true && r.kept }));
          }),
        save: (record, replay) =>
          run(async () => {
            await q(
              'INSERT INTO playerthree_sessions (game, id, released_at, record, replay) VALUES ($1, $2, to_timestamp($3::double precision / 1000), $4::jsonb, $5::json) ON CONFLICT (game, id) DO UPDATE SET released_at = EXCLUDED.released_at, record = EXCLUDED.record, replay = EXCLUDED.replay',
              [game, record.id, record.releasedAt, JSON.stringify(record), replay],
            );
          }),
        delete: (id) =>
          run(async () => {
            await q('DELETE FROM playerthree_sessions WHERE game = $1 AND id = $2', [game, id]);
          }),
        loadReplay: (id) =>
          run(async () => {
            const [row] = await q<{ replay: Replay | null }>('SELECT replay FROM playerthree_sessions WHERE game = $1 AND id = $2', [game, id]);
            return row?.replay ?? undefined;
          }),
      })),

    commanderLog: (game) =>
      cached<CommanderLogStore>('commanderLog', game, (run) => {
        type Row = { commander_id: string; entry: StoredCommanderLogEntry['entry']; sealed: StoredCommanderLogEntry['sealed'] };
        const rows = (list: Row[]): StoredCommanderLogEntry[] => list.map((r) => ({ commanderId: r.commander_id, entry: r.entry, sealed: r.sealed }));
        return {
          heads: () =>
            run(async () => {
              const list = await q<{ commander_id: string; seq: number; digest: string; wins: string; losses: string; draws: string }>(
                `SELECT h.commander_id, h.seq, h.digest, t.wins, t.losses, t.draws FROM (SELECT DISTINCT ON (commander_id) commander_id, seq, digest FROM playerthree_commander_log WHERE game = $1 ORDER BY commander_id, seq DESC) h
                 JOIN (SELECT commander_id,
                   count(*) FILTER (WHERE entry->>'outcome' = 'win' AND (entry->>'selfPlay')::boolean = false) AS wins,
                   count(*) FILTER (WHERE entry->>'outcome' = 'loss' AND (entry->>'selfPlay')::boolean = false) AS losses,
                   count(*) FILTER (WHERE entry->>'outcome' = 'draw' AND (entry->>'selfPlay')::boolean = false) AS draws
                   FROM playerthree_commander_log WHERE game = $1 GROUP BY commander_id) t USING (commander_id)`,
                [game],
              );
              return list.map((r): CommanderLogHead => ({ commanderId: r.commander_id, seq: r.seq, digest: r.digest, wins: Number(r.wins), losses: Number(r.losses), draws: Number(r.draws) }));
            }),
          append: (row) =>
            run(async () => {
              const e = row.entry;
              await q(
                'INSERT INTO playerthree_commander_log (game, commander_id, seq, entry_id, match_id, ended_at, entry, sealed, digest, prev_digest, sig) VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000), $7::jsonb, $8::jsonb, $9, $10, $11)',
                [game, row.commanderId, e.seq, e.entryId, e.matchId, e.endedAt, JSON.stringify(e), row.sealed === null ? null : JSON.stringify(row.sealed), e.digest, e.prevDigest, e.sig],
              );
            }),
          entries: (commanderId, afterSeq = 0) =>
            run(async () => rows(await q<Row>('SELECT commander_id, entry, sealed FROM playerthree_commander_log WHERE game = $1 AND commander_id = $2 AND seq > $3 ORDER BY seq', [game, commanderId, afterSeq]))),
          match: (matchId) =>
            run(async () => rows(await q<Row>('SELECT commander_id, entry, sealed FROM playerthree_commander_log WHERE game = $1 AND match_id = $2 ORDER BY commander_id', [game, matchId]))),
          all: () =>
            run(async () => rows(await q<Row>("SELECT commander_id, entry, sealed FROM playerthree_commander_log WHERE game = $1 ORDER BY ended_at, match_id, entry->>'commander'", [game]))),
          appendVerdict: (row) =>
            run(async () => {
              await q(
                'INSERT INTO playerthree_commander_log_verdicts (game, entry_id, at, verdict, reason, key_id, sig, record) VALUES ($1, $2, to_timestamp($3::double precision / 1000), $4::jsonb, $5, $6, $7, $8::jsonb)',
                [game, row.entryId, row.at, JSON.stringify(row.verdict), row.reason, row.keyId, row.sig, JSON.stringify(row)],
              );
            }),
          verdicts: () =>
            run(async () => (await q<{ record: CommanderLogVerdictRow }>('SELECT record FROM playerthree_commander_log_verdicts WHERE game = $1 ORDER BY at, entry_id', [game])).map((r) => r.record)),
          redact: (commanderId) =>
            run(async () => {
              await q('UPDATE playerthree_commander_log SET sealed = NULL WHERE game = $1 AND commander_id = $2 AND sealed IS NOT NULL', [game, commanderId]);
            }),
        };
      }),
    series: (game) => cached<SeriesStore>('series', game, (run) => postgresSeriesStore(pool, game, run)),

    async query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> {
      if (closed) throw new Error('playerthree/postgres: storage is closed');
      return (await pool.query(text, params)).rows as R[];
    },

    close() {
      closing ??= (async () => {
        // Drain until quiet: an owner's own write queue hands its next operation to a store only after the previous
        // one settled, so check again after the event loop turned.
        for (;;) {
          await Promise.all(serials.map((s) => s.idle()));
          await setImmediate();
          if (serials.every((s) => s.pending === 0)) break;
        }
        closed = true;
        await pool.end();
      })();
      return closing;
    },
  };
}
