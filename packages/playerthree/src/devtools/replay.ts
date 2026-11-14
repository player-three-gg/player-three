/** Replay scrubbing for the operator console: re-simulates a replay to a tick in isolation, under global limits (`REPLAY_LIMITS`). */
import { setImmediate } from 'node:timers/promises';
import { replaySimulation, type ReplayResult } from '../host/replay.ts';
import type { Replay, ReplayPosition } from '../host/types.ts';
import type { AnyManifest, GameDefinition } from '../manifest.ts';

export const REPLAY_LIMITS = { ticks: 36_000, fallbackTicks: 20_000, entries: 100_000, bytes: 5 * 1024 * 1024, concurrent: 2, milliseconds: 120_000, memory: 256 * 1024 * 1024, checkpoints: 80 } as const;
export class ReplayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
interface Checkpoint<M extends AnyManifest> extends ReplayPosition<M> { bytes: number }
interface Timeline<M extends AnyManifest> { cursor?: ReplayPosition<M>; points: Checkpoint<M>[] }

/** Conservative graph estimate, including typed-array backing stores and shared/cyclic references once. */
function retainedBytes(root: unknown): number {
  const seen = new Set<object>();
  const stack = [root];
  let bytes = 0;
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === 'string') { bytes += value.length * 2 + 32; continue; }
    if (!value || typeof value !== 'object' || seen.has(value)) { bytes += 8; continue; }
    seen.add(value);
    bytes += 128;
    if (ArrayBuffer.isView(value)) stack.push(value.buffer);
    else if (value instanceof ArrayBuffer) bytes += value.byteLength;
    else if (value instanceof Map) for (const [key, item] of value) { bytes += 64; stack.push(key, item); }
    else if (value instanceof Set) for (const item of value) { bytes += 32; stack.push(item); }
    else for (const [key, item] of Object.entries(value)) { bytes += 32 + key.length * 2; stack.push(item); }
  }
  return bytes;
}

/** Per-source forward cursors, optional cloned checkpoints, cooperative cancellation and global limits. */
export class ReplayScrubber<M extends AnyManifest> {
  private readonly jobs = new Map<string, AbortController>();
  private readonly timelines = new Map<string, Timeline<M>>();
  private readonly definition: GameDefinition<M>;
  constructor(definition: GameDefinition<M>) { this.definition = definition; }

  private trim(): void {
    for (;;) {
      let bytes = 0;
      let count = 0;
      let victim: { timeline: Timeline<M>; index: number; spacing: number } | undefined;
      for (const timeline of this.timelines.values()) {
        if (timeline.cursor) bytes += retainedBytes(timeline.cursor.adapter);
        count += timeline.points.length;
        for (let i = 0; i < timeline.points.length; i++) {
          const point = timeline.points[i]!;
          bytes += point.bytes;
          // Prefer thinning densely spaced interior points, preserving coverage across the full match.
          const spacing = i === 0 || i === timeline.points.length - 1 ? Infinity : timeline.points[i + 1]!.adapter.tick - timeline.points[i - 1]!.adapter.tick;
          if (!victim || spacing < victim.spacing) victim = { timeline, index: i, spacing };
        }
      }
      if (bytes <= REPLAY_LIMITS.memory && count <= REPLAY_LIMITS.checkpoints) return;
      if (victim) victim.timeline.points.splice(victim.index, 1);
      else {
        const idle = [...this.timelines.keys()].find((key) => !this.jobs.has(key));
        if (!idle) throw new ReplayError(413, 'Replay too large: checkpoint memory limit exceeded.');
        this.timelines.delete(idle);
      }
    }
  }

  /**
   * Re-simulate `replay` through `tick` on the `key` timeline. A persistent session's replay (`window`) only covers
   * ticks from `window.from`: positions before its dropped entries are discarded and the run starts from `checkpoint`
   * (the session's `PlayerThreeMatch.checkpoint`) unless a cached position inside the window is closer.
   */
  async run(replay: Replay, tick: number, signal: AbortSignal, key = 'replay', checkpoint?: (tick: number) => ReplayPosition<M> | undefined): Promise<ReplayResult<M>> {
    if (this.jobs.size >= REPLAY_LIMITS.concurrent || this.jobs.has(key)) throw new ReplayError(429, 'Replay busy: at most two re-simulations, one per timeline, can run at once.');
    const window = replay?.window;
    const from = window?.from ?? 0;
    const dropped = window?.dropped ?? 0;
    if (!Number.isSafeInteger(tick) || tick < from || tick > replay?.ticks) throw new ReplayError(400, window ? `Invalid replay tick: this session keeps ticks ${from}–${replay.ticks}.` : 'Invalid replay tick.');
    // Persistent sessions grow without bound; the limits apply to the span re-simulated from the window start.
    if (tick - from > REPLAY_LIMITS.ticks || !Array.isArray(replay?.entries) || replay.entries.length > REPLAY_LIMITS.entries) throw new ReplayError(413, 'Replay too long: limited to 36,000 ticks and 100,000 recorded entries.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.jobs.set(key, controller);
    let timeline = this.timelines.get(key);
    if (!timeline) {
      if (this.timelines.size >= 4) {
        const idle = [...this.timelines.keys()].find((id) => !this.jobs.has(id));
        if (idle) this.timelines.delete(idle);
      }
      timeline = { points: [] };
      this.timelines.set(key, timeline);
    }
    // Cached positions from before the window's dropped entries cannot be continued.
    if (window) timeline.points = timeline.points.filter((p) => p.entryIndex >= dropped);
    let position = timeline.cursor;
    if (position && (position.adapter.tick > tick || position.entryIndex < dropped)) position = undefined;
    let point: Checkpoint<M> | undefined;
    for (const p of timeline.points) if (p.adapter.tick <= tick && (!position || p.adapter.tick > position.adapter.tick) && (!point || p.adapter.tick > point.adapter.tick)) point = p;
    if (point) position = { adapter: point.adapter.clone!(), entryIndex: point.entryIndex, ...(point.signals ? { signals: point.signals.clone() } : {}) };
    if (window) {
      const kept = checkpoint?.(tick);
      if (kept && (!position || kept.adapter.tick > position.adapter.tick)) position = kept;
      if (!position) {
        this.jobs.delete(key);
        signal.removeEventListener('abort', abort);
        throw new ReplayError(404, 'Replay not found: the session keeps no checkpoint this old.');
      }
    }
    const simulation = replaySimulation(this.definition, replay, tick, position);
    const deadline = performance.now() + REPLAY_LIMITS.milliseconds;
    let lastPoint = -1;
    try {
      for (;;) {
        await setImmediate();
        controller.signal.throwIfAborted();
        for (let i = 0; i < 100; i++) {
          if (performance.now() > deadline) throw new ReplayError(413, 'Replay too long: exceeded the two-minute re-simulation limit.');
          const next = simulation.next();
          if (next.done) { this.trim(); return next.value; }
          position = next.value;
          timeline.cursor = position;
          const adapter = position.adapter;
          if (!adapter.clone && tick - from > REPLAY_LIMITS.fallbackTicks) throw new ReplayError(413, 'Replay too long: adapters without checkpoints are limited to 20,000 ticks.');
          if (adapter.clone && adapter.tick % 500 === 0 && adapter.tick !== lastPoint) {
            lastPoint = adapter.tick;
            if (!timeline.points.some((point) => point.adapter.tick === adapter.tick)) {
              const clone = adapter.clone();
              timeline.points.push({ adapter: clone, entryIndex: position.entryIndex, ...(position.signals ? { signals: position.signals.clone() } : {}), bytes: retainedBytes(clone) });
              timeline.points.sort((a, b) => a.adapter.tick - b.adapter.tick);
              this.trim();
            }
          }
        }
      }
    } catch (error) {
      // Cancellation may retain a valid partial cursor; malformed inputs must not poison future seeks.
      if (!controller.signal.aborted) this.timelines.delete(key);
      throw error;
    } finally {
      simulation.return(undefined as never);
      signal.removeEventListener('abort', abort);
      this.jobs.delete(key);
    }
  }

  forget(key: string): void { this.timelines.delete(key); }
  close(): void {
    for (const job of this.jobs.values()) job.abort();
    this.timelines.clear();
  }
}
