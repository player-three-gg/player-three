/**
 * Recent sessions. When the host releases a session (the game disposes it: after its end grace, an idle or duration
 * cap, shutdown), it keeps a bounded record of it — who played, how it ended, how many inputs were rejected — and its
 * deterministic replay, so the operator console can still list, scrub and export it. Bounded by count, age and replay
 * bytes; in memory by default, or backed by a `HistoryStore` (`jsonHistoryStore(dir)`, the game's database), pruned
 * with the bounds, so the history survives restarts. With a store, records stay in memory and replays load on demand.
 */
import type { AnyManifest } from '../manifest.ts';
import { jsonHistoryStore } from './store.ts';
import type { PlayerThreeMatch, PlayerThreeTraceEvent, HistoryStore, Replay, SessionHistory, SessionHistoryOptions, SessionRecord, TraceSource } from './types.ts';
import { SerialWrites } from './util.ts';

/** Default session history bounds (`SessionHistoryOptions`): 50 sessions, 24 h, 64 MiB of replays. */
export const HISTORY_DEFAULTS = { maxSessions: 50, maxAgeMs: 24 * 60 * 60_000, maxBytes: 64 * 1024 * 1024 } as const;

/** Sources whose rejected intents count as agent rejections (bots' and the human owner's do not). */
const AGENT_SOURCES: Partial<Record<TraceSource, true>> = { agent: true, policy: true, stream: true };

export interface Problem {
  kind: 'rejection' | 'policy_error';
  code: string;
  team: string;
  role: string;
  source?: TraceSource;
}

/** Agent rejections and policy errors in the trace, with a closed-vocabulary code (`invalid:<schema code>`, `game:<code>`, …). */
export function problemOf(e: PlayerThreeTraceEvent): Problem | undefined {
  if (e.type === 'intent' && !e.ack.ok && AGENT_SOURCES[e.source]) {
    const a = e.ack;
    const code = a.code === 'invalid' ? `invalid:${a.schemaCode}` : a.code === 'game' ? `game:${a.gameCode}` : a.code;
    return { kind: 'rejection', code, team: e.team, role: e.role, source: e.source };
  }
  if (e.type === 'policy_call' && e.error) return { kind: 'policy_error', code: e.error, team: e.team, role: e.role, source: 'policy' };
  if (e.type === 'policy_deploy' && !e.ok) return { kind: 'policy_error', code: `deploy:${e.error?.code ?? 'failed'}`, team: e.team, role: e.role };
  return undefined;
}

const MAX_HARNESSES = 4;
const MAX_CODES = 16;

const topCounts = (counts: Map<string, number>) =>
  [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, MAX_CODES);

interface Live {
  createdAt: number;
  endedAt: number | null;
  owners: Record<string, string>;
  rejections: number;
  policyErrors: number;
  codes: { rejections: Map<string, number>; policyErrors: Map<string, number> };
  harnesses: Map<string, string[]>;
}

interface Item {
  record: SessionRecord;
  /** In-memory replay (no store only). */
  replay?: Replay;
  /** Kept replay bytes (0 when not kept). */
  bytes: number;
}

const bound = (v: number | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  if (!Number.isSafeInteger(v) || v < 0) throw new Error('playerthree/history: bounds must be non-negative integers');
  return v;
};

/** Host-internal: the history plus the per-session accounting the host feeds it. */
export class History implements SessionHistory {
  readonly limits: SessionHistory['limits'];
  /** Resolves once the store has loaded; rejects if the load failed. */
  readonly ready: Promise<void>;
  private readonly manifest: AnyManifest;
  private readonly store: HistoryStore | undefined;
  private readonly items = new Map<string, Item>();
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Set<(record: SessionRecord) => void>();
  private readonly writes = new SerialWrites(() => console.error('playerthree/history: write failed'));

  constructor(manifest: AnyManifest, opts: SessionHistoryOptions = {}) {
    this.manifest = manifest;
    this.limits = {
      maxSessions: bound(opts.maxSessions, HISTORY_DEFAULTS.maxSessions),
      maxAgeMs: bound(opts.maxAgeMs, HISTORY_DEFAULTS.maxAgeMs),
      maxBytes: bound(opts.maxBytes, HISTORY_DEFAULTS.maxBytes),
      dir: opts.store === undefined ? (opts.dir ?? null) : null,
    };
    this.store = opts.store ?? (opts.dir !== undefined ? jsonHistoryStore(opts.dir) : undefined);
    if (this.store === undefined || !this.enabled) {
      this.ready = Promise.resolve();
      return;
    }
    let data: SessionRecord[] | Promise<SessionRecord[]>;
    try {
      data = this.store.load();
    } catch (e) {
      data = Promise.reject(e);
    }
    if (data instanceof Promise) {
      this.ready = data.then((records) => this.init(records));
      this.ready.catch(() => console.error('playerthree/history: store failed to load'));
    } else {
      this.init(data);
      this.ready = Promise.resolve();
    }
  }

  get enabled(): boolean {
    return this.limits.maxSessions > 0;
  }

  // ------------------------------------------------------------------ host side

  /** Every trace event of every session (the host traces whenever the history is on). */
  track(e: PlayerThreeTraceEvent): void {
    if (!this.enabled) return;
    const l = this.entry(e.match, e.at);
    if (e.type === 'match_ended') l.endedAt = e.at;
    const p = problemOf(e);
    if (!p) return;
    if (p.kind === 'rejection') l.rejections++;
    else l.policyErrors++;
    const counts = p.kind === 'rejection' ? l.codes.rejections : l.codes.policyErrors;
    counts.set(p.code, (counts.get(p.code) ?? 0) + 1);
  }

  /** A session was created; `owners` maps exact team/role seats to trusted owners. */
  opened(id: string, owners: Record<string, string>): void {
    if (this.enabled) this.entry(id, Date.now()).owners = { ...owners };
  }

  /** A seat was re-assigned (`PlayerThreeMatch.assign`): the session record names its latest trusted owner. */
  assigned(id: string, seat: string, owner: string): void {
    if (this.enabled) this.entry(id, Date.now()).owners[seat] = owner;
  }

  /** The host released the session: keep its record and replay. */
  released(m: PlayerThreeMatch): void {
    const l = this.live.get(m.id);
    this.live.delete(m.id);
    if (!this.enabled || !l) return;
    const replay = m.replay();
    const text = JSON.stringify(replay);
    const size = Buffer.byteLength(text);
    const keep = size <= this.limits.maxBytes;
    const record: SessionRecord = {
      id: m.id,
      game: this.manifest.id,
      gameVersion: this.manifest.version,
      seed: replay.seed,
      options: replay.options ?? null,
      createdAt: l.createdAt,
      endedAt: l.endedAt,
      releasedAt: Date.now(),
      ticks: replay.ticks,
      seconds: replay.ticks / this.manifest.tickRate,
      teams: replay.teams,
      alliances: replay.alliances ?? null,
      outcomes: replay.outcomes,
      ranks: replay.ranks ?? null,
      owners: l.owners,
      sameOwnerOpposed: m.sameOwnerOpposed,
      seats: m.seats().map((s) => ({
        team: s.team,
        role: s.role,
        controller: s.controller,
        owner: l.owners[`${s.team}/${s.role}`] ?? null,
        commander: s.commander === true,
        ...(s.policyVersion !== undefined ? { policyVersion: s.policyVersion } : {}),
        ...(s.poolPolicy !== undefined ? { poolPolicy: s.poolPolicy } : {}),
        harnesses: l.harnesses.get(`${s.team}/${s.role}`) ?? [],
      })),
      rejections: l.rejections,
      policyErrors: l.policyErrors,
      codes: { rejections: topCounts(l.codes.rejections), policyErrors: topCounts(l.codes.policyErrors) },
      replayBytes: size,
      from: replay.window?.from ?? 0,
      replay: keep,
    };
    const store = this.store;
    this.items.set(record.id, { record, bytes: keep ? size : 0, ...(keep && store === undefined ? { replay } : {}) });
    if (store !== undefined) this.writes.write(() => store.save(record, keep ? text : null));
    this.prune(Date.now());
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // Listeners must never break the host.
      }
    }
  }

  private entry(id: string, at: number): Live {
    let l = this.live.get(id);
    if (!l) {
      l = { createdAt: at, endedAt: null, owners: {}, rejections: 0, policyErrors: 0, codes: { rejections: new Map(), policyErrors: new Map() }, harnesses: new Map() };
      this.live.set(id, l);
    }
    return l;
  }

  /** Drop the oldest sessions until every bound holds (all three bounds drop oldest first). */
  private prune(now: number): void {
    let bytes = 0;
    for (const item of this.items.values()) bytes += item.bytes;
    for (const [id, item] of this.items) {
      const tooOld = item.record.releasedAt < now - this.limits.maxAgeMs;
      if (!tooOld && this.items.size <= this.limits.maxSessions && bytes <= this.limits.maxBytes) break;
      this.items.delete(id);
      bytes -= item.bytes;
      const store = this.store;
      if (store !== undefined) this.writes.write(() => store.delete(id));
    }
  }

  /** Loaded records go before any released while the store was loading (those are newer). */
  private init(records: SessionRecord[]): void {
    if (!Array.isArray(records)) throw new Error('playerthree/history: malformed store data');
    const loaded: Item[] = [];
    for (const r of records) {
      if (!r || typeof r.id !== 'string' || r.game !== this.manifest.id || this.items.has(r.id)) continue;
      if (typeof r.releasedAt !== 'number' || typeof r.replayBytes !== 'number' || !Array.isArray(r.seats) || !Array.isArray(r.teams)) continue;
      // Unreadable without its practice mark: an unmarked record could be counted as a ranked result.
      if (typeof r.sameOwnerOpposed !== 'boolean') continue;
      const kept = r.replay === true;
      if (!r.owners || typeof r.owners !== 'object' || Array.isArray(r.owners)) throw new Error('playerthree/history: malformed ownership index');
      let owned = 0;
      for (const seat of r.seats) {
        if (typeof seat.owner !== 'string') continue;
        owned++;
        if (r.owners[`${seat.team}/${seat.role}`] !== seat.owner) throw new Error('playerthree/history: malformed ownership index');
      }
      if (Object.keys(r.owners).length !== owned) throw new Error('playerthree/history: malformed ownership index');
      loaded.push({ record: { ...r, replay: kept }, bytes: kept ? r.replayBytes : 0 });
    }
    loaded.sort((a, b) => a.record.releasedAt - b.record.releasedAt);
    const released = [...this.items.values()];
    this.items.clear();
    for (const item of [...loaded, ...released]) this.items.set(item.record.id, item);
    this.prune(Date.now());
  }

  // ------------------------------------------------------------------ SessionHistory

  list(): SessionRecord[] {
    this.prune(Date.now());
    return [...this.items.values()].map((i) => i.record).reverse();
  }

  get(id: string): SessionRecord | undefined {
    this.prune(Date.now());
    return this.items.get(id)?.record;
  }

  async replay(id: string): Promise<Replay | undefined> {
    const item = this.items.get(id);
    if (!item?.record.replay) return undefined;
    if (item.replay) return structuredClone(item.replay);
    if (this.store === undefined) return undefined;
    await this.writes.flush();
    try {
      return (await this.store.loadReplay(id)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  annotate(session: string, team: string, role: string, harness: string): void {
    const l = this.live.get(session);
    if (!l || typeof harness !== 'string' || harness.length === 0) return;
    const key = `${team}/${role}`;
    const list = l.harnesses.get(key) ?? [];
    const label = harness.slice(0, 80);
    if (list.includes(label) || list.length >= MAX_HARNESSES) return;
    list.push(label);
    l.harnesses.set(key, list);
  }

  /** Harness labels the transports reported for a seat of a session the host still holds (host-internal). */
  harnesses(session: string, team: string, role: string): string[] {
    return [...this.live.get(session)?.harnesses.get(`${team}/${role}`) ?? []];
  }

  onRecord(listener: (record: SessionRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): Promise<void> {
    return this.writes.flush();
  }
}
