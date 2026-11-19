/** `playerthree/benchmark-store`: benchmark publication storage (atomic JSON files or PostgreSQL) and validated import. */
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from './briefing.ts';
import { validateBenchmarkPublication, type BenchmarkPublication } from './benchmark.ts';

export interface BenchmarkPublicationStore {
  put(publication: BenchmarkPublication): Promise<void>;
  get(id: string): Promise<BenchmarkPublication | null>;
  list(): Promise<BenchmarkPublication[]>;
  withdraw(id: string): Promise<void>;
}
const identifier = (id: string) => { if (!/^[A-Za-z0-9_.-]{1,160}$/.test(id)) throw new Error('Invalid publication id'); return id; };
/** Durable atomic replacement; callers own serialization. No provider keys or transcripts belong in these files. */
export async function writeBenchmarkJson(path: string, value: unknown, exclusive = false): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(canonicalJson(value)); await file.sync(); }
  finally { await file.close(); }
  try {
    if (exclusive) { await link(tmp, path); await unlink(tmp); } else await rename(tmp, path);
    const directory = await open(join(path, '..'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  catch (error) { await unlink(tmp).catch(() => {}); throw error; }
}
/** Atomic no-overwrite creation and separate permanent tombstones coordinate CLI/server processes. */
export function jsonBenchmarkStore(directory: string): BenchmarkPublicationStore {
  let pending = Promise.resolve<unknown>(undefined);
  const serial = <T>(fn: () => Promise<T>) => { const next = pending.then(fn); pending = next.catch(() => {}); return next; };
  const load = async (id: string): Promise<string | null> => {
    try { return await readFile(join(directory, `${identifier(id)}.json`), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  };
  const parse = (text: string | null): { publication: BenchmarkPublication | null; digest: string } | null => text === null ? null : JSON.parse(text);
  const withdrawn = async (id: string) => {
    try { await readFile(join(directory, `${identifier(id)}.withdrawn`)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  // Validation recomputes the bootstrap score: do it once per exact stored bytes, not on every read.
  const cache = new Map<string, { text: string; publication: BenchmarkPublication }>();
  const publicRead = async (id: string): Promise<BenchmarkPublication | null> => {
    if (await withdrawn(id)) return null;
    const text = await load(id);
    if (text === null) return null;
    let cached = cache.get(id);
    if (!cached || cached.text !== text) {
      const record = parse(text);
      if (!record?.publication) return null;
      const publication = validateBenchmarkPublication(record.publication);
      if (publication.id !== id || publication.digest !== record.digest) throw new Error('Publication identity mismatch');
      cached = { text, publication }; cache.set(id, cached);
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
    }
    return await withdrawn(id) ? null : structuredClone(cached.publication);
  };
  return {
    put: input => serial(async () => {
      const publication = validateBenchmarkPublication(input); identifier(publication.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await withdrawn(publication.id)) throw new Error('Immutable or withdrawn publication');
      try { await writeBenchmarkJson(join(directory, `${publication.id}.json`), { publication, digest: publication.digest }, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const old = parse(await load(publication.id));
        if (!old?.publication || old.digest !== publication.digest) throw new Error('Immutable or withdrawn publication');
      }
      if (await withdrawn(publication.id)) { await unlink(join(directory, `${publication.id}.json`)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); throw new Error('Immutable or withdrawn publication'); }
    }),
    get: id => serial(() => publicRead(id)),
    list: () => serial(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const results: BenchmarkPublication[] = [];
      for (const file of (await readdir(directory)).filter(f => f.endsWith('.json')).sort()) { const publication = await publicRead(file.slice(0, -5)); if (publication) results.push(publication); }
      return results;
    }),
    withdraw: id => serial(async () => {
      identifier(id); await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await writeBenchmarkJson(join(directory, `${id}.withdrawn`), { id }, true); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      cache.delete(id);
      // Keep only the tombstone at origin; downloaded copies cannot be recalled.
      await unlink(join(directory, `${id}.json`)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }),
  };
}
export type BenchmarkQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
/** Uses the existing PostgresStorage.query; no series foreign key or retention cascade. */
export function postgresBenchmarkStore(query: BenchmarkQuery, game: string): BenchmarkPublicationStore {
  const cache = new Map<string, BenchmarkPublication>();
  // Rows are immutable once written, so (id, stored digest) identifies validated bytes without re-hashing them per read.
  const validated = (row: Record<string, unknown>): BenchmarkPublication => {
    const key = `${String(row.id)}:${String(row.digest)}`;
    let publication = cache.get(key);
    if (!publication) {
      publication = validateBenchmarkPublication(row.publication);
      if (publication.id !== row.id || publication.digest !== row.digest) throw new Error('Publication identity mismatch');
      cache.set(key, publication);
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
    }
    return structuredClone(publication);
  };
  return {
    async put(input) {
      const publication = validateBenchmarkPublication(input); identifier(publication.id);
      if (publication.suite.game !== game) throw new Error('Publication game mismatch');
      const rows = await query('INSERT INTO playerthree_benchmark_publications (game,id,digest,publication) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (game,id) DO UPDATE SET digest = playerthree_benchmark_publications.digest WHERE playerthree_benchmark_publications.digest = EXCLUDED.digest AND playerthree_benchmark_publications.publication IS NOT NULL RETURNING id', [game, publication.id, publication.digest, canonicalJson(publication)]);
      if (!rows.length) throw new Error('Immutable or withdrawn publication');
    },
    // Always query visibility first: a cached validation can never bypass a tombstone.
    async get(id) { const rows = await query('SELECT id, digest, publication FROM playerthree_benchmark_publications WHERE game=$1 AND id=$2 AND publication IS NOT NULL', [game, identifier(id)]); return rows[0] ? validated(rows[0]) : null; },
    async list() { return (await query('SELECT id, digest, publication FROM playerthree_benchmark_publications WHERE game=$1 AND publication IS NOT NULL ORDER BY id', [game])).map(validated); },
    async withdraw(id) { await query('INSERT INTO playerthree_benchmark_publications (game,id,digest,publication) VALUES ($1,$2,$3,NULL) ON CONFLICT (game,id) DO UPDATE SET publication=NULL', [game, identifier(id), '0'.repeat(64)]); },
  };
}
/** Validation proves internal consistency, never trusted evaluation or model authorship. */
export async function importBenchmarkPublication(store: BenchmarkPublicationStore, input: unknown): Promise<BenchmarkPublication> {
  const publication = validateBenchmarkPublication(input);
  await store.put(publication);
  return publication;
}
