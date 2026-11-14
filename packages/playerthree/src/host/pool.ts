/**
 * Published-policy pool. Entries are drafted into seats with controller `policy` (async enemies, ladders,
 * agents fighting each other while their owners are offline). Backed by a `PoolStore` (memory by default,
 * `jsonPoolStore(poolDir)`, or the game's database). Entries live in memory once loaded; artifacts load from the
 * store when a seat needs one. Operators can disable (stop drafting) or unpublish (delete) entries.
 */
import { randomInt } from 'node:crypto';
import { POLICY_RUNTIMES, type Outcome } from '../manifest.ts';
import type { PolicyPool, PoolEntry, PoolPublisher, PoolRecord, PoolStore, PoolStoreData, StoredPolicyArtifact, StoredPoolEntry } from './types.ts';
import { POOL_ID } from './store.ts';
import { SerialWrites } from './util.ts';

const entryOf = ({ owner: _owner, disabled: _disabled, ...e }: StoredPoolEntry): PoolEntry => ({ ...e });

function publisherOf(owner: string): PoolPublisher {
  if (owner.startsWith('commander:')) return { kind: 'commander', owner: owner.slice('commander:'.length) };
  const slash = owner.lastIndexOf('/');
  return { kind: 'session', session: owner.slice(0, slash), team: owner.slice(slash + 1) };
}

export class Pool implements PolicyPool {
  /** Resolves once the store has loaded; rejects if the load failed. */
  readonly ready: Promise<void>;
  private readonly game: string;
  private readonly store: PoolStore;
  private readonly stored = new Map<string, StoredPoolEntry>();
  private readonly writes = new SerialWrites(() => console.error('playerthree/pool: store write failed'));

  constructor(game: string, store: PoolStore) {
    this.game = game;
    this.store = store;
    let data: PoolStoreData | Promise<PoolStoreData>;
    try {
      data = store.load();
    } catch (e) {
      data = Promise.reject(e);
    }
    if (data instanceof Promise) {
      this.ready = data.then((d) => this.init(d));
      this.ready.catch(() => console.error('playerthree/pool: store failed to load'));
    } else {
      this.init(data);
      this.ready = Promise.resolve();
    }
  }

  private init(data: PoolStoreData): void {
    if (!Array.isArray(data?.entries)) throw new Error('playerthree/pool: malformed store data');
    for (const e of data.entries) {
      if (e?.game !== this.game || typeof e.id !== 'string' || !POOL_ID.test(e.id) || this.stored.has(e.id)) continue;
      if (!(POLICY_RUNTIMES as readonly string[]).includes(e.runtime) || typeof e.owner !== 'string') continue;
      // Entries saved before draft counting have no `drafts`.
      this.stored.set(e.id, { ...e, drafts: Number.isSafeInteger(e.drafts) ? e.drafts : 0 });
    }
  }

  private save(e: StoredPoolEntry): void {
    const copy = { ...e };
    this.writes.write(() => this.store.saveEntry(copy));
  }

  private draftable(role?: string): StoredPoolEntry[] {
    return [...this.stored.values()].filter((e) => !e.disabled && (role === undefined || e.role === role));
  }

  list(role?: string): PoolEntry[] {
    return this.draftable(role).map(entryOf);
  }

  draft(role: string): PoolEntry | undefined {
    const candidates = this.draftable(role);
    if (candidates.length === 0) return undefined;
    const e = candidates[randomInt(candidates.length)]!;
    e.drafts++;
    this.save(e);
    return entryOf(e);
  }

  /** A draftable entry by id (explicit selection), or undefined. */
  get(id: string): PoolEntry | undefined {
    const e = this.stored.get(id);
    return e && !e.disabled ? entryOf(e) : undefined;
  }

  entries(): PoolRecord[] {
    return [...this.stored.values()].map((e) => ({ ...entryOf(e), publisher: publisherOf(e.owner), disabled: e.disabled === true }));
  }

  setDisabled(id: string, disabled: boolean): PoolRecord | undefined {
    const e = this.stored.get(id);
    if (!e) return undefined;
    if (disabled) e.disabled = true;
    else delete e.disabled;
    this.save(e);
    return { ...entryOf(e), publisher: publisherOf(e.owner), disabled };
  }

  unpublish(id: string): boolean {
    if (!this.stored.delete(id)) return false;
    this.writes.write(() => this.store.deleteEntry(id));
    return true;
  }

  countBy(owner: string): number {
    let n = 0;
    for (const e of this.stored.values()) if (e.owner === owner) n++;
    return n;
  }

  publish(role: string, artifact: StoredPolicyArtifact, owner: string): PoolEntry {
    let id: string;
    do id = `pol_${randomInt(100_000_000, 1_000_000_000)}`;
    while (this.stored.has(id));
    const entry: StoredPoolEntry = { id, game: this.game, role, runtime: artifact.runtime, surfaceHash: artifact.surfaceHash, wins: 0, losses: 0, draws: 0, createdAt: Date.now(), drafts: 0, owner };
    // Only the artifact and its hashes: a commander library version's source and provenance never enter the pool.
    const copy: StoredPolicyArtifact = { runtime: artifact.runtime, code: artifact.code, surfaceHash: artifact.surfaceHash, artifactHash: artifact.artifactHash };
    // The artifact first: a stored entry never points at a missing artifact.
    this.writes.write(() => this.store.saveArtifact(id, copy));
    this.stored.set(id, entry);
    this.save(entry);
    return entryOf(entry);
  }

  /** The entry's artifact from the store (after pending writes), or undefined (unknown, unpublished, unreadable). */
  async artifact(id: string): Promise<StoredPolicyArtifact | undefined> {
    if (!this.stored.has(id)) return undefined;
    await this.writes.flush();
    try {
      return (await this.store.loadArtifact(id)) ?? undefined;
    } catch (e) {
      console.error('playerthree/pool: artifact failed to load');
      return undefined;
    }
  }

  record(id: string, outcome: Outcome): void {
    const e = this.stored.get(id);
    if (!e || outcome === 'running') return;
    if (outcome === 'win') e.wins++;
    else if (outcome === 'loss') e.losses++;
    else e.draws++;
    this.save(e);
  }

  /** Resolves once pending store writes are done. */
  flush(): Promise<void> {
    return this.writes.flush();
  }
}
