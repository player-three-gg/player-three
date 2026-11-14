/** PostgreSQL backend for `durableSeriesStore` (`playerthree_series*` tables), scoped per game. */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { ResultChunk, SeriesStore, ShareRecord, StoredSeries } from '../arena.ts';
import { durableSeriesStore, SeriesStoreError } from '../series-store.ts';

type ChunkRow = { checksum: string; bytes: string; payload: string };
const CHUNK_QUERY = 'SELECT checksum, bytes, payload FROM playerthree_series_result_chunks WHERE game=$1 AND series_id=$2 AND attempt_id=$3 AND chunk_index=$4';

/** The stored payload is the exact canonical chunk JSON; its SHA-256 and byte length must still match. */
function storedChunk(row: ChunkRow | undefined, index: number): ResultChunk {
  if (!row) throw new SeriesStoreError('not_found', 'missing durable raw chunk');
  const bytes = Number(row.bytes);
  if (Buffer.byteLength(row.payload) !== bytes || createHash('sha256').update(row.payload).digest('hex') !== row.checksum) throw new SeriesStoreError('invalid', 'corrupt raw result chunk');
  return { index, checksum: row.checksum, bytes, rows: JSON.parse(row.payload) as ResultChunk['rows'] };
}

/** Uses the existing pg pool; a game-scoped transaction lock serializes quota admission across processes. */
export function postgresSeriesStore(pool: pg.Pool, game: string, run: <T>(fn: () => Promise<T>) => Promise<T>): SeriesStore {
  return durableSeriesStore({
    // Committed chunk rows are immutable; a single read needs no metadata transaction or advisory lock.
    readChunk: (id, attemptId, index) => run(async () => storedChunk((await pool.query<ChunkRow>(CHUNK_QUERY, [game, id, attemptId, index])).rows[0], index)),
    transaction: (fn) => run(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`playerthree.series:${game}`]);
          const previous = new Map<string, { active: Map<string, string>; terminal: Set<string>; revision: number }>();
          const result = await fn({
            get: async (id) => {
              const record = (await client.query<{ record: StoredSeries }>('SELECT record FROM playerthree_series WHERE game = $1 AND id = $2 FOR UPDATE', [game, id])).rows[0]?.record;
              if (record) previous.set(id, { active: new Map(record.activeAttempts.map((attempt) => [attempt.attemptId, `${attempt.matchId}\0${attempt.releaseAt}`])), terminal: new Set(record.attempts.map((attempt) => attempt.attemptId)), revision: record.revision });
              return record;
            },
            list: async (owner) => (await client.query<{ record: StoredSeries }>(`SELECT record FROM playerthree_series WHERE game = $1${owner === undefined ? '' : ' AND owner = $2'} ORDER BY id`, owner === undefined ? [game] : [game, owner])).rows.map((row) => row.record),
            expired: async (now, limit) => (await client.query<{ record: StoredSeries }>('SELECT record FROM playerthree_series WHERE game=$1 AND expires_at <= $2 ORDER BY expires_at,id LIMIT $3', [game, new Date(now).toISOString(), limit])).rows.map((row) => row.record),
            recoverable: async (now) => (await client.query<{ record: StoredSeries }>("SELECT record FROM playerthree_series WHERE game=$1 AND state IN ('queued','running','aborting') AND expires_at > $2 AND (lease_expires_at IS NULL OR lease_expires_at <= $2) ORDER BY id", [game, new Date(now).toISOString()])).rows.map((row) => row.record),
            resolveShare: async (digest, now) => (await client.query<{ record: ShareRecord }>("SELECT sh.record FROM playerthree_series_shares sh JOIN playerthree_series s ON s.game=sh.game AND s.id=sh.series_id WHERE sh.game=$1 AND sh.digest=$2 AND sh.revoked_at IS NULL AND sh.expires_at > $3 AND s.expires_at > $3 AND (sh.record->'policy'->>'notBefore')::double precision <= $4", [game, digest, new Date(now).toISOString(), now])).rows[0]?.record,
            save: async (record) => {
              const before = previous.get(record.id);
              await client.query('INSERT INTO playerthree_series (game,id,owner,state,revision,expires_at,bytes,lease_expires_at,record) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (game,id) DO UPDATE SET state=EXCLUDED.state,revision=EXCLUDED.revision,expires_at=EXCLUDED.expires_at,bytes=EXCLUDED.bytes,lease_expires_at=EXCLUDED.lease_expires_at,record=EXCLUDED.record', [game, record.id, record.owner, record.state, record.revision, record.expiresAt, record.bytes, record.lease ? new Date(record.lease.expiresAt).toISOString() : null, JSON.stringify(record)]);
              if (!before) for (const trial of record.trials) await client.query('INSERT INTO playerthree_series_trials (game,series_id,id,schedule_index,record) VALUES ($1,$2,$3,$4,$5::jsonb)', [game, record.id, trial.trialId, trial.scheduleIndex, JSON.stringify(trial)]);
              for (const attempt of record.activeAttempts) if (before?.active.get(attempt.attemptId) !== `${attempt.matchId}\0${attempt.releaseAt}`) await client.query("INSERT INTO playerthree_series_attempts (game,series_id,id,trial_id,accepted,status,record) VALUES ($1,$2,$3,$4,false,'active',$5::jsonb) ON CONFLICT (game,series_id,id) DO UPDATE SET record=EXCLUDED.record", [game, record.id, attempt.attemptId, attempt.trialId, JSON.stringify(attempt)]);
              for (const attempt of record.attempts) if (!before?.terminal.has(attempt.attemptId)) await client.query('INSERT INTO playerthree_series_attempts (game,series_id,id,trial_id,accepted,status,record) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (game,series_id,id) DO UPDATE SET accepted=EXCLUDED.accepted,status=EXCLUDED.status,record=EXCLUDED.record', [game, record.id, attempt.attemptId, attempt.trialId, attempt.acceptedAttempt, attempt.status, JSON.stringify(attempt)]);
              for (const update of record.updates) if (update.revision > (before?.revision ?? -1)) await client.query('INSERT INTO playerthree_series_updates (game,series_id,revision,release_at,record) VALUES ($1,$2,$3,$4,$5::jsonb)', [game, record.id, update.revision, new Date(update.releaseAt).toISOString(), JSON.stringify(update)]);
            },
            delete: async (id) => { await client.query('DELETE FROM playerthree_series WHERE game=$1 AND id=$2', [game, id]); },
            readChunk: async (id, attemptId, index) => storedChunk((await client.query<ChunkRow>(CHUNK_QUERY, [game, id, attemptId, index])).rows[0], index),
            writeChunk: async (id, attemptId, chunk, payload) => { await client.query('INSERT INTO playerthree_series_result_chunks (game,series_id,attempt_id,chunk_index,checksum,bytes,payload) VALUES ($1,$2,$3,$4,$5,$6,$7)', [game, id, attemptId, chunk.index, chunk.checksum, chunk.bytes, payload]); },
            shares: async (id) => (await client.query<{ record: ShareRecord }>('SELECT record FROM playerthree_series_shares WHERE game=$1 AND series_id=$2 ORDER BY generation', [game, id])).rows.map((row) => row.record),
            saveShares: async (id, shares) => {
              // Revoke first so the partial unique active-generation index is never violated.
              for (const share of [...shares].sort((a, b) => Number(a.revokedAt === null) - Number(b.revokedAt === null))) await client.query('INSERT INTO playerthree_series_shares (game,series_id,generation,digest,expires_at,revoked_at,record) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (game,series_id,generation) DO UPDATE SET revoked_at=EXCLUDED.revoked_at,record=EXCLUDED.record', [game, id, share.generation, share.digest, share.policy.expiresAt, share.revokedAt, JSON.stringify(share)]);
            },
            readArtifact: async (id, artifactId) => {
              const data = (await client.query<{ data: Buffer }>('SELECT data FROM playerthree_series_artifacts WHERE game=$1 AND series_id=$2 AND id=$3', [game, id, artifactId])).rows[0]?.data;
              return data ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined;
            },
            writeArtifact: async (id, artifact, data) => { await client.query('INSERT INTO playerthree_series_artifacts (game,series_id,id,checksum,bytes,record,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)', [game, id, artifact.id, artifact.sha256, artifact.bytes, JSON.stringify(artifact), Buffer.from(data.buffer, data.byteOffset, data.byteLength)]); },
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      } finally { client.release(); }
    }),
  });
}
