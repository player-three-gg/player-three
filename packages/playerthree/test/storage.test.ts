import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definition, type TagManifest } from '../examples/tag/index.ts';
import { createPlayerThreeHost, jsonCommanderStore, jsonPoolStore, memoryCommanderStore, memoryPoolStore, policyArtifactHash } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeHostOptions, HistoryStore, PoolStore, SessionRecord, StoredPoolEntry } from '../src/host/types.ts';
import { surfaceHash } from '../src/briefing.ts';

const hosts: PlayerThreeHost<TagManifest>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const makeHost = (opts: Partial<PlayerThreeHostOptions<TagManifest>> = {}) => {
  const h = createPlayerThreeHost({ definition, ...opts });
  hosts.push(h);
  return h;
};
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'playerthree-storage-'));
  dirs.push(d);
  return d;
};
/** A stored artifact carries the SHA-256 of its module bytes. */
const hashed = <A extends { runtime: 'js' | 'wasm'; code: string; surfaceHash: string }>(a: A) => ({ ...a, artifactHash: policyArtifactHash(a) });
/** A commander library version as stored: the artifact plus its source, detail and provenance (null: a plain deploy). */
const library = <A extends { runtime: 'js' | 'wasm'; code: string; surfaceHash: string }>(a: A) =>
  ({ ...hashed(a), source: null, detail: null, provenance: { parent: null, license: null, author: null } });
const entry = (id: string, game: string): StoredPoolEntry => ({ id, game, role: 'runner', runtime: 'js', surfaceHash: surfaceHash(definition.manifest), wins: 0, losses: 0, draws: 0, createdAt: 1, drafts: 0, owner: 'commander:alice_owner_0001' });
const failing = (): Promise<never> => Promise.reject(new Error('store down'));

describe('jsonPoolStore', () => {
  it('keeps other games’ entries in a shared directory and deletes artifacts with their entry', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'pool.json'), JSON.stringify({ version: 1, entries: [entry('pol_1', 'other')] }));
    const store = jsonPoolStore(dir);
    store.saveArtifact('pol_2', hashed({ runtime: 'wasm', code: Buffer.from([0, 97, 115, 109]).toString('base64'), surfaceHash: surfaceHash(definition.manifest) }));
    store.saveEntry(entry('pol_2', 'tag'));
    expect(JSON.parse(readFileSync(join(dir, 'pool.json'), 'utf8')).entries.map((e: StoredPoolEntry) => e.id)).toEqual(['pol_1', 'pol_2']);
    expect(store.loadArtifact('pol_2')).toEqual(hashed({ runtime: 'wasm', code: Buffer.from([0, 97, 115, 109]).toString('base64'), surfaceHash: surfaceHash(definition.manifest) }));

    // The host only sees its own game's entries.
    expect(makeHost({ poolDir: dir }).pool.list().map((e) => e.id)).toEqual(['pol_2']);
    store.deleteEntry('pol_2');
    expect(existsSync(join(dir, 'pol_2.json'))).toBe(false);
    expect(store.load()).toEqual({ entries: [entry('pol_1', 'other')] });
    expect(() => store.saveArtifact('../x', hashed({ runtime: 'js', code: '', surfaceHash: surfaceHash(definition.manifest) }))).toThrow(/unsafe/);
  });

  it('poolStore wins over poolDir', () => {
    const dir = tempDir();
    const store = memoryPoolStore();
    store.saveEntry(entry('pol_3', 'tag'));
    expect(makeHost({ poolDir: dir, poolStore: store }).pool.list().map((e) => e.id)).toEqual(['pol_3']);
    expect(existsSync(join(dir, 'pool.json'))).toBe(false);
  });
});

describe('artifact provenance storage', () => {
  it('stores artifacts under pattern-checked owner and commander-ID path components', async () => {
    const dir = tempDir();
    const store = jsonCommanderStore(dir);
    await store.load();
    const artifact = library({ runtime: 'js' as const, code: 'function think(){return []}', surfaceHash: 'c'.repeat(64) });
    const id = randomUUID();
    await store.saveArtifact('alice_owner_0001', id, 1, artifact);
    expect(existsSync(join(dir, 'artifacts', 'alice_owner_0001', id, '1.json'))).toBe(true);
    expect(await store.loadArtifact('alice_owner_0001', id, 1)).toEqual(artifact);
    await store.deleteArtifact('alice_owner_0001', id, 1);
    expect(await store.loadArtifact('alice_owner_0001', id, 1)).toBeUndefined();
    for (const unsafe of ['../escape', 'Array<Int>', id.toUpperCase()]) {
      expect(() => store.saveArtifact('alice_owner_0001', unsafe, 1, artifact)).toThrow(/unsafe/);
    }
    expect(() => store.saveArtifact('../escape', id, 1, artifact)).toThrow(/unsafe/);
  });

  it.skipIf(process.platform === 'win32')('fix: keeps the token-derivation key and private policy code unreadable to other local users', async () => {
    const dir = join(tempDir(), 'commanders');
    const store = jsonCommanderStore(dir);
    await store.load();
    await store.saveKey('k'.repeat(43));
    const id = randomUUID();
    await store.saveArtifact('alice_owner_0001', id, 1, library({ runtime: 'js', code: 'function think(){return []}', surfaceHash: 'c'.repeat(64) }));
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, 'commanders.json'))).toBe(0o600);
    expect(mode(join(dir, 'artifacts', 'alice_owner_0001', id))).toBe(0o700);
    expect(mode(join(dir, 'artifacts', 'alice_owner_0001', id, '1.json'))).toBe(0o600);
  });

  it.each(['memory', 'json'] as const)('preserves JS and WASM surface hashes in %s commander and pool stores', async (kind) => {
    const commander = kind === 'memory' ? memoryCommanderStore() : jsonCommanderStore(tempDir());
    const pool = kind === 'memory' ? memoryPoolStore() : jsonPoolStore(tempDir());
    await commander.load();
    await pool.load();
    for (const [index, artifact] of [
      hashed({ runtime: 'js' as const, code: 'function think() { return []; }', surfaceHash: 'a'.repeat(64) }),
      hashed({ runtime: 'wasm' as const, code: Buffer.from([0, 97, 115, 109]).toString('base64'), surfaceHash: 'b'.repeat(64) }),
    ].entries()) {
      const id = randomUUID();
      await commander.saveArtifact('alice_owner_0001', id, index + 1, library(artifact));
      await pool.saveArtifact(`pol_${index + 1}`, artifact);
      expect(await commander.loadArtifact('alice_owner_0001', id, index + 1)).toEqual(library(artifact));
      expect(await pool.loadArtifact(`pol_${index + 1}`)).toEqual(artifact);
    }
  });

  it.each(['memory', 'json'] as const)('round-trips a version’s source, detail and provenance in the %s commander store', async (kind) => {
    const store = kind === 'memory' ? memoryCommanderStore() : jsonCommanderStore(tempDir());
    await store.load();
    const id = randomUUID();
    const artifact = {
      ...hashed({ runtime: 'js' as const, code: 'function think(){return []}', surfaceHash: 'd'.repeat(64) }),
      source: { runtime: 'js' as const, modules: { 'main.ts': 'export function think() { return []; }' }, entry: 'main.ts', include: ['tag-strategy/policies/simple.js'] },
      detail: 'all' as const,
      provenance: { parent: 'e'.repeat(64), license: 'MIT OR Apache-2.0', author: 'Grace' },
    };
    await store.saveArtifact('alice_owner_0001', id, 3, artifact);
    expect(await store.loadArtifact('alice_owner_0001', id, 3)).toEqual(artifact);
  });

  it('loads an artifact file stored before sources were retained with null source, detail and provenance', async () => {
    const dir = tempDir();
    const store = jsonCommanderStore(dir);
    await store.load();
    const id = randomUUID();
    const plain = hashed({ runtime: 'js' as const, code: 'function think(){return []}', surfaceHash: 'c'.repeat(64) });
    await store.saveArtifact('alice_owner_0001', id, 1, library(plain));
    writeFileSync(join(dir, 'artifacts', 'alice_owner_0001', id, '1.json'), JSON.stringify(plain));
    expect(await store.loadArtifact('alice_owner_0001', id, 1)).toEqual(library(plain));
  });
});

describe('host.ready', () => {
  it('resolves once async stores have loaded', async () => {
    const pool = memoryPoolStore();
    pool.saveEntry(entry('pol_4', 'tag'));
    const record = { id: 's_1', game: 'tag', releasedAt: Date.now(), replayBytes: 2, teams: ['blue', 'red'], seats: [], owners: {}, sameOwnerOpposed: false, replay: true } as unknown as SessionRecord;
    const history: HistoryStore = { load: async () => [record], save: async () => {}, delete: async () => {}, loadReplay: async () => ({ ok: 1 }) as never };
    const commanders = memoryCommanderStore();
    const host = makeHost({
      commanderStore: { ...commanders, load: async () => commanders.load() },
      poolStore: { ...pool, load: async () => pool.load() } satisfies PoolStore,
      history: { store: history, dir: tempDir() },
    });
    expect(host.pool.list()).toEqual([]);
    await host.ready;
    expect(host.pool.list().map((e) => e.id)).toEqual(['pol_4']);
    expect(host.history.list().map((r) => r.id)).toEqual(['s_1']);
    expect(host.history.limits.dir).toBeNull();
    expect(await host.history.replay('s_1')).toEqual({ ok: 1 });
  });

  it.each(['commanders', 'pool', 'history'] as const)('rejects when the %s store fails to load', async (which) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = makeHost({
      ...(which === 'commanders' ? { commanderStore: { ...memoryCommanderStore(), load: failing } } : {}),
      ...(which === 'pool' ? { poolStore: { ...memoryPoolStore(), load: failing } } : {}),
      ...(which === 'history' ? { history: { store: { load: failing, save() {}, delete() {}, loadReplay: () => undefined } } } : {}),
    });
    await expect(host.ready).rejects.toThrow('store down');
    expect(errors).toHaveBeenCalled();
  });
});
