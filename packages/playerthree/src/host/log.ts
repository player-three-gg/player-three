/**
 * The host's commander match log (SPEC §20.10.1): chain heads and tallies in memory, entries in the store. Entries are
 * completed one at a time in issue order — the game's verdict, then seq/prevDigest from the commander's head, the
 * digest and the signature — so every commander's chain is linear even with an async verdict or store.
 */
import { UNRATED, type CommanderLogEntry, type CommanderLogHead, type CommanderLogSealed, type CommanderLogStore, type CommanderLogVerdict, type CommanderLogVerdictRow, type StoredCommanderLogEntry } from '../commander-log.ts';
import { entryDigest, signEntry, signVerdictRow } from '../commander-log-integrity.ts';
import type { CommanderLogOptions, CommanderLogReader } from './types.ts';
import { SerialWrites } from './util.ts';

type Maybe<T> = T | Promise<T>;

function then<T, R>(value: Maybe<T>, fn: (value: T) => Maybe<R>): Maybe<R> {
  return value instanceof Promise ? value.then(fn) : fn(value);
}

/** An entry before the log completes it: `seq`, `prevDigest`, `digest`, `verdict` and `sig` are filled in here. */
export interface LogDraft {
  commanderId: string;
  ownerRef: string;
  declared: CommanderLogSealed['declared'];
  entry: CommanderLogEntry;
  sealed: CommanderLogSealed | null;
}

const VERDICT_KEYS = ['rated', 'pool', 'segmentId', 'weight', 'badges', 'reasons'];
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** A game verdict is closed data: bounded labels and a weight in [0, 1]; anything else is a failed verdict. */
function checkVerdict(v: CommanderLogVerdict): CommanderLogVerdict {
  const labels = (list: unknown): list is string[] => Array.isArray(list) && list.length <= 32 && list.every((x) => typeof x === 'string' && LABEL.test(x));
  if (!v || typeof v !== 'object' || Object.keys(v).some((k) => !VERDICT_KEYS.includes(k)) || typeof v.rated !== 'boolean' ||
    !(v.pool === null || typeof v.pool === 'string' && LABEL.test(v.pool)) || !(v.segmentId === null || typeof v.segmentId === 'string' && v.segmentId.length <= 128) ||
    typeof v.weight !== 'number' || !(v.weight >= 0 && v.weight <= 1) || !labels(v.badges) || !labels(v.reasons)) throw new Error('playerthree/commander-log: invalid verdict');
  return { rated: v.rated, pool: v.pool, segmentId: v.segmentId, weight: v.weight, badges: [...v.badges], reasons: [...v.reasons] };
}

export class CommanderLog implements CommanderLogReader {
  readonly ready: Promise<void>;
  readonly keyId: string | null;
  readonly official: boolean;
  readonly origin: string;
  private readonly store: CommanderLogStore;
  private readonly opts: CommanderLogOptions;
  private readonly heads = new Map<string, CommanderLogHead>();
  private readonly listeners = new Set<(row: StoredCommanderLogEntry) => void>();
  private readonly writes = new SerialWrites((e) => console.error('playerthree/commander-log: write failed', e instanceof Error ? e.message : ''));

  constructor(store: CommanderLogStore, opts: CommanderLogOptions = {}) {
    this.store = store;
    this.opts = opts;
    this.keyId = opts.signer?.keyId ?? null;
    this.official = opts.signer !== undefined;
    this.origin = opts.origin ?? 'local';
    let heads: Maybe<CommanderLogHead[]>;
    try {
      heads = store.heads();
    } catch (e) {
      heads = Promise.reject(e);
    }
    const init = (list: CommanderLogHead[]) => { for (const head of list) this.heads.set(head.commanderId, { ...head }); };
    if (heads instanceof Promise) {
      this.ready = heads.then(init);
      this.ready.catch(() => console.error('playerthree/commander-log: store failed to load'));
    } else {
      init(heads);
      this.ready = Promise.resolve();
    }
  }

  /** Decided, non-practice tallies of a commander. */
  record(commanderId: string): { wins: number; losses: number; draws: number } {
    const head = this.heads.get(commanderId);
    return { wins: head?.wins ?? 0, losses: head?.losses ?? 0, draws: head?.draws ?? 0 };
  }

  /** Queue one entry: verdict, chain, digest, signature, append, head and tallies, listeners. */
  write(draft: LogDraft): void {
    this.writes.write(() => then(this.verdict(draft), (verdict) => {
      const head = this.heads.get(draft.commanderId);
      const entry: CommanderLogEntry = { ...draft.entry, seq: (head?.seq ?? 0) + 1, prevDigest: head?.digest ?? null, verdict, digest: '', sig: null };
      entry.digest = entryDigest(entry);
      if (this.opts.signer) {
        const { sig: _sig, ...unsigned } = entry;
        entry.sig = signEntry(unsigned, this.opts.signer);
      }
      const row: StoredCommanderLogEntry = { commanderId: draft.commanderId, entry, sealed: draft.sealed };
      return then(this.store.append(structuredClone(row)), () => {
        const decided = !entry.selfPlay && entry.outcome !== 'unknown';
        this.heads.set(draft.commanderId, {
          commanderId: draft.commanderId, seq: entry.seq, digest: entry.digest,
          wins: (head?.wins ?? 0) + (decided && entry.outcome === 'win' ? 1 : 0),
          losses: (head?.losses ?? 0) + (decided && entry.outcome === 'loss' ? 1 : 0),
          draws: (head?.draws ?? 0) + (decided && entry.outcome === 'draw' ? 1 : 0),
        });
        for (const listener of this.listeners) {
          try { listener(structuredClone(row)); } catch { /* Listeners cannot interrupt the log. */ }
        }
      });
    }));
  }

  private verdict(draft: LogDraft): Maybe<CommanderLogVerdict> {
    const fallback = (): CommanderLogVerdict => {
      console.error('playerthree/commander-log: verdict failed; entry stays unrated');
      return structuredClone(UNRATED) as CommanderLogVerdict;
    };
    const hook = this.opts.verdict;
    if (!hook) return structuredClone(UNRATED) as CommanderLogVerdict;
    try {
      const v = hook({ commanderId: draft.commanderId, ownerRef: draft.ownerRef, declared: { ...draft.declared }, entry: structuredClone(draft.entry) });
      if (v instanceof Promise) return v.then(checkVerdict).catch(fallback);
      return checkVerdict(v);
    } catch {
      return fallback();
    }
  }

  /** Privacy tombstone: the store drops the commander's sealed parts; entries and chain stay. */
  redact(commanderId: string): void {
    this.writes.write(() => this.store.redact(commanderId));
  }

  async entries(commanderId: string, afterSeq?: number): Promise<StoredCommanderLogEntry[]> {
    await this.flush();
    return structuredClone(await this.store.entries(commanderId, afterSeq));
  }

  async match(matchId: string): Promise<StoredCommanderLogEntry[]> {
    await this.flush();
    return structuredClone(await this.store.match(matchId));
  }

  async all(): Promise<StoredCommanderLogEntry[]> {
    await this.flush();
    return structuredClone(await this.store.all());
  }

  async verdicts(): Promise<CommanderLogVerdictRow[]> {
    await this.flush();
    return structuredClone(await this.store.verdicts());
  }

  async amend(entryId: string, verdict: CommanderLogVerdict, reason: string): Promise<CommanderLogVerdictRow> {
    if (typeof entryId !== 'string' || typeof reason !== 'string' || !LABEL.test(reason)) throw new Error('playerthree/commander-log: invalid amendment');
    const checked = checkVerdict(verdict);
    const unsigned = { entryId, at: Date.now(), verdict: checked, reason, keyId: this.keyId };
    const row: CommanderLogVerdictRow = { ...unsigned, sig: this.opts.signer ? signVerdictRow(unsigned, this.opts.signer) : null };
    await this.flush();
    await this.store.appendVerdict(row);
    return structuredClone(row);
  }

  onAppend(listener: (row: StoredCommanderLogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): Promise<void> {
    return this.writes.flush();
  }
}
