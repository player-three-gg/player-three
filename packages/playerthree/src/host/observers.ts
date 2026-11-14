/** Observer streams: the delayed, bounded, per-perspective frame history every observer reader of a match shares. */
import { setTimeout as sleep } from 'node:timers/promises';
import { diff, patch, type JsonDelta } from '../delta.ts';
import type { Outcome } from '../manifest.ts';
import type { ObserverCommentary, ObserverFrame, ObserverGrant, ObserverMessage } from '../protocol.ts';

/** Retained history past the release watermark (ms): bounds resume cursors and slow-reader catch-up. */
export const OBSERVER_TAIL_MS = 60_000;
/** A reader further behind the watermark than this many frames is resynchronized with one keyframe. */
export const OBSERVER_MAX_BATCH = 40;
/** A zero-delay stream records every frame only while someone read it this recently (ms); otherwise once a second. */
export const OBSERVER_WATCH_MS = 5_000;

/** Default history bound for a policy: its delay plus the resume tail. */
export function observerRetentionMs(policy: { minDelayMs: number; maxAgeMs?: number }): number {
  return policy.maxAgeMs ?? policy.minDelayMs + OBSERVER_TAIL_MS;
}

export interface ObserverStreamOptions {
  teams: readonly string[];
  /** These callbacks MUST already apply the declared observer/view schemas. */
  projectAll: () => unknown;
  projectTeam: (team: string) => unknown;
  outcomes: () => Record<string, Outcome>;
  now?: () => number;
  maxBytes?: number;
  maxAgeMs?: number;
  /** Optional explicit-disclosure channel. No hook means no commentary, regardless of vision permission. */
  commentary?: {
    capture: () => readonly ObserverCommentary[];
    /** Rechecked at delivery so withdrawn consent cannot leak retained commentary. */
    authorize: (grant: ObserverGrant, item: ObserverCommentary) => boolean;
  };
}
interface RecordedFrame {
  sequence: number;
  tick: number;
  recordedAt: number;
  /** Per perspective: JSON of the delta from the previous frame, '' when unchanged. Strings keep retention compact. */
  deltas: Record<string, string>;
  outcomes?: Record<string, Outcome>;
  commentary?: readonly ObserverCommentary[];
  bytes: number;
  /** Delivery messages shared by every reader of this frame with the same grant scope, built on first read. */
  messages?: Map<string, ObserverMessage>;
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key in value) freeze((value as Record<string, unknown>)[key]);
  return value;
}

/**
 * Append-only, bounded wall-clock history shared by every observer channel and reconnect.
 *
 * Every frame is recorded once as a structural delta per perspective (`playerthree/delta`) against the previous frame;
 * the oldest frames fold into a base state as they expire. Readers get one keyframe and then each released delta, and
 * every message is built once per frame and grant scope and shared (immutable) by every reader at that cursor, so the
 * per-observer cost is only the transport's fan-out.
 */
export class ObserverStream {
  private readonly options: ObserverStreamOptions;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly perspectives: readonly string[];
  private history: RecordedFrame[] = [];
  /** Newest recorded state per perspective (detached; diffed against the next capture). */
  private readonly head = new Map<string, unknown>();
  /** State per perspective at `base.sequence`, the frame just before the oldest retained one. */
  private readonly base = { sequence: 0, state: new Map<string, unknown>() };
  /** Last reconstructed keyframe per perspective, so joins at an advancing watermark replay only the new deltas. */
  private readonly cursors = new Map<string, { sequence: number; state: unknown }>();
  private bytes = 0;
  private sequence = 0;
  private closed = false;
  private terminal = false;
  private lastTime = 0;
  /** Last read per perspective (stream clock). */
  private readonly readAt = new Map<string, number>();

  constructor(options: ObserverStreamOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60 * 1000;
    this.perspectives = ['all', ...options.teams];
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 ||
        !Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs < 1) throw new Error('playerthree/observer: invalid retention');
  }

  private clock(): number {
    // A backward clock adjustment may lengthen the delay but never shorten it.
    this.lastTime = Math.max(this.lastTime, this.now());
    return this.lastTime;
  }

  private captureCommentary(tick: number): ObserverCommentary[] {
    const items = this.options.commentary?.capture() ?? [];
    if (!Array.isArray(items) || items.length > 1000) throw new Error('playerthree/observer: invalid commentary');
    return items.map((item) => {
      if (!item || typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 128 ||
          !this.options.teams.includes(item.team) || typeof item.role !== 'string' || item.role.length < 1 || item.role.length > 48 ||
          !Number.isSafeInteger(item.tick) || item.tick < 0 || item.tick > tick ||
          item.category !== 'summary' && item.category !== 'chat' ||
          typeof item.text !== 'string' || item.text.length < 1 || item.text.length > 280) throw new Error('playerthree/observer: invalid commentary');
      // Explicit allowlist: a structurally wider publisher object cannot smuggle private fields.
      return { id: item.id, team: item.team, role: item.role, tick: item.tick, category: item.category, text: item.text };
    });
  }

  /** `perspective` was read within `OBSERVER_WATCH_MS`: a host may record it densely only while someone watches. */
  watched(perspective: string): boolean {
    return this.now() - (this.readAt.get(perspective) ?? Number.NEGATIVE_INFINITY) < OBSERVER_WATCH_MS;
  }

  /**
   * Record one frame. Only `refresh` perspectives are projected again; the others carry over unchanged, which keeps
   * unwatched perspectives cheap. The terminal frame always refreshes every perspective.
   */
  capture(tick: number, refresh: readonly string[] = this.perspectives): void {
    if (this.closed || this.terminal) return;
    try {
      const outcomes = this.options.outcomes();
      const terminal = this.options.teams.every((team) => outcomes[team] !== undefined && outcomes[team] !== 'running');
      const recordedAt = this.clock();
      const deltas: Record<string, string> = {};
      const changes: [string, JsonDelta][] = [];
      let bytes = 0;
      for (const perspective of this.perspectives) {
        deltas[perspective] = '';
        if (!terminal && !refresh.includes(perspective)) continue;
        const next = perspective === 'all' ? this.options.projectAll() : this.options.projectTeam(perspective);
        // diff detaches every value it carries: no mutable adapter state enters the history.
        const change = diff(this.head.get(perspective), next);
        if (!change) continue;
        const json = JSON.stringify(change);
        deltas[perspective] = json;
        bytes += Buffer.byteLength(json);
        changes.push([perspective, change]);
      }
      const commentary = this.options.commentary ? this.captureCommentary(tick) : undefined;
      if (commentary) bytes += Buffer.byteLength(JSON.stringify(commentary));
      this.expire(recordedAt);
      if (this.bytes + bytes > this.maxBytes) return this.dispose();
      for (const [perspective, change] of changes) this.head.set(perspective, patch(this.head.get(perspective), change));
      this.history.push({
        sequence: ++this.sequence, tick, recordedAt, deltas, bytes,
        ...(terminal ? { outcomes: { ...outcomes } } : {}),
        ...(commentary ? { commentary } : {}),
      });
      this.bytes += bytes;
      this.terminal = terminal;
    } catch {
      this.dispose();
    }
  }

  private expire(now: number): void {
    // Terminal playback is retained through its delay, but never beyond the declared age bound.
    let count = 0;
    while (count < this.history.length && this.history[count]!.recordedAt < now - this.maxAgeMs) {
      const frame = this.history[count++]!;
      for (const perspective of this.perspectives) {
        const json = frame.deltas[perspective];
        if (json) this.base.state.set(perspective, patch(this.base.state.get(perspective), JSON.parse(json) as JsonDelta));
      }
      this.base.sequence = frame.sequence;
      this.bytes -= frame.bytes;
    }
    if (count) this.history.splice(0, count);
  }

  /** The full projection of `perspective` at retained `sequence`, replaying deltas from the nearest known state. */
  private stateAt(perspective: string, sequence: number): unknown {
    const memo = this.cursors.get(perspective);
    let at = memo && memo.sequence <= sequence && memo.sequence >= this.base.sequence ? memo.sequence : this.base.sequence;
    let state = at === memo?.sequence ? memo.state : this.base.state.get(perspective);
    const first = this.history[0]!.sequence;
    for (; at < sequence; at++) {
      const json = this.history[at + 1 - first]!.deltas[perspective];
      if (json) state = patch(state, JSON.parse(json) as JsonDelta);
    }
    this.cursors.set(perspective, { sequence, state });
    return state;
  }

  /**
   * The released messages for a reader whose last applied frame is `after`: each newer released delta in order, or a
   * single keyframe at the release watermark when `after` is absent or more than `maxBatch` frames behind. Frame
   * messages are shared and frozen.
   */
  read(grant: ObserverGrant, perspective: string, after?: number, maxBatch = OBSERVER_MAX_BATCH): ObserverMessage[] {
    const closed: ObserverMessage[] = [{ op: 'observer', state: 'closed' }];
    if (this.closed || !Number.isSafeInteger(grant.delayMs) || grant.delayMs < 0 || grant.delayMs >= this.maxAgeMs ||
        (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || after > this.sequence))) return closed;
    const allowed = grant.kind === 'team'
      ? perspective === grant.team && this.options.teams.includes(grant.team)
      : (perspective === 'all'
          ? grant.teams.length === this.options.teams.length && this.options.teams.every((team) => grant.teams.includes(team))
          : grant.teams.includes(perspective)) && grant.teams.length > 0 &&
        grant.teams.every((team) => this.options.teams.includes(team));
    if (!allowed) return closed;
    const now = this.clock();
    this.readAt.set(perspective, now);
    this.expire(now);
    const first = this.history[0];
    if (!first) return this.sequence > 0 ? closed : [{ op: 'observer', state: 'buffering' }];
    if (after !== undefined && after < first.sequence - 1) return closed;
    // Latest frame whose release time has passed (recordedAt is monotonic).
    let lo = 0;
    let hi = this.history.length - 1;
    let released = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.history[mid]!.recordedAt + grant.delayMs <= now) { released = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (released < 0) return [{ op: 'observer', state: 'buffering' }];
    const watermark = this.history[released]!.sequence;
    if (after !== undefined && after >= watermark) return [{ op: 'observer', state: 'buffering' }];
    if (after === undefined || watermark - after > maxBatch) return [this.message(this.history[released]!, grant, perspective, true)];
    const out: ObserverMessage[] = [];
    for (let sequence = after + 1; sequence <= watermark; sequence++) out.push(this.message(this.history[sequence - first.sequence]!, grant, perspective, false));
    return out;
  }

  private message(frame: RecordedFrame, grant: ObserverGrant, perspective: string, keyframe: boolean): ObserverMessage {
    const commentary = frame.commentary?.filter((item) =>
      (grant.kind === 'team' ? item.team === grant.team : grant.teams.includes(item.team)) &&
      this.options.commentary?.authorize(grant, item) === true,
    );
    // Consent is rechecked on every delivery, so frames that disclose commentary are never shared from a cache.
    const key = commentary?.length ? undefined : `${keyframe ? 'k' : 'd'}|${perspective}|${grant.kind === 'team' ? grant.team : '*'}|${grant.delayMs}`;
    const cached = key === undefined ? undefined : frame.messages?.get(key);
    if (cached) return cached;
    const json = frame.deltas[perspective];
    const body: ObserverFrame = {
      sequence: frame.sequence, tick: frame.tick, recordedAt: frame.recordedAt,
      releaseAt: frame.recordedAt + grant.delayMs, perspective,
      ...(keyframe ? { world: this.stateAt(perspective, frame.sequence) } : json ? { delta: JSON.parse(json) as JsonDelta } : {}),
      ...(frame.outcomes ? { outcomes: Object.fromEntries(
        Object.entries(frame.outcomes).filter(([team]) => grant.kind === 'omniscient' ? grant.teams.includes(team) : team === grant.team),
      ) } : {}),
      ...(commentary?.length ? { commentary: structuredClone(commentary) } : {}),
    };
    const message = freeze<ObserverMessage>({ op: 'observer', state: 'ready', frame: body });
    if (key !== undefined) (frame.messages ??= new Map()).set(key, message);
    return message;
  }

  async *frames(grant: ObserverGrant, perspective = grant.kind === 'team' ? grant.team : 'all', after?: number): AsyncIterable<ObserverFrame> {
    let cursor = after;
    while (!this.closed) {
      let delivered = false;
      for (const message of this.read(grant, perspective, cursor)) {
        if (message.state === 'closed') throw new Error('playerthree/observer: stream closed');
        if (!message.frame) continue;
        delivered = true;
        cursor = message.frame.sequence;
        yield message.frame;
        if (message.frame.outcomes) return;
      }
      // One tick at 20 Hz: a released frame waits at most this long for a trusted pull consumer.
      if (!delivered) await sleep(25);
    }
    throw new Error('playerthree/observer: stream closed');
  }

  dispose(): void {
    this.closed = true;
    this.history = [];
    this.head.clear();
    this.base.state.clear();
    this.cursors.clear();
    this.bytes = 0;
  }
}
