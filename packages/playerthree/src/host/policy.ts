/**
 * One loaded policy version and its stats. Wraps a sandbox `PolicyInstance`; restarts it after a hard kill
 * (timeout / memory) a few times, then stops calling it until the next deploy or rollback. A JS instance survives a
 * timeout with its state (spec §11), up to MAX_CONSECUTIVE_TIMEOUTS in a row, then is killed and restarted the same way.
 */
import type { InvalidIntent, PolicyArtifact, PolicyError, PolicyStats } from '../control.ts';
import { resolveDetail, type AnyManifest, type PolicyLimits } from '../manifest.ts';
import { loadPolicy } from '../policy/index.ts';
import type { LoadResult, PolicyCallOutcome, PolicyInstance } from '../policy/types.ts';

const MAX_RESTARTS = 3;
/** Timeouts a surviving (JS) instance may take without a successful call in between before it is killed and reloaded. */
export const MAX_CONSECUTIVE_TIMEOUTS = 3;

export interface PolicyThink {
  /** Untrusted output, already capped at maxIntentsPerCall. */
  intents: unknown[];
  logs: string[];
  ms: number;
  error?: PolicyError;
}

export function artifactBytes(artifact: PolicyArtifact): string | Uint8Array {
  return artifact.runtime === 'wasm' ? new Uint8Array(Buffer.from(artifact.code, 'base64')) : artifact.code;
}

export function emptyStats(version: number, runtime: PolicyArtifact['runtime']): PolicyStats {
  return { version, runtime, calls: 0, successfulCalls: 0, consecutiveFailures: 0, timeouts: 0, errors: 0, meanMs: 0, maxMs: 0, intentsEmitted: 0, intentsRejected: [], logs: [] };
}

/** Load an artifact; `{ ok: false }` carries the sandbox's own-authored error about it. */
export async function loadArtifact(
  artifact: PolicyArtifact,
  limits: PolicyLimits,
  seed: number,
  matchData: unknown,
): Promise<LoadResult> {
  return loadPolicy(artifact.runtime, artifactBytes(artifact), limits, { seed, matchData });
}

export type SeatArtifactLoad = { ok: true; instance: PolicyInstance; detail: string[] } | { ok: false; error: PolicyError };

/**
 * Load an artifact for a seat of `role`, resolving the observation detail it declares against the game's
 * `observationScope`: the role's defaults united with the declared sections (spec §11). An unknown section fails
 * `bad_output` and disposes the instance.
 */
export async function loadSeatArtifact(
  artifact: PolicyArtifact,
  limits: PolicyLimits,
  seed: number,
  matchData: unknown,
  manifest: AnyManifest,
  role: string,
): Promise<SeatArtifactLoad> {
  const loaded = await loadArtifact(artifact, limits, seed, matchData);
  if (!loaded.ok) return loaded;
  const detail = resolveDetail(manifest, role, loaded.instance.detail);
  if (detail === null) {
    loaded.instance.dispose();
    return { ok: false, error: { code: 'bad_output', message: 'detail names an observation section this game does not declare' } };
  }
  return { ok: true, instance: loaded.instance, detail };
}

export class PolicyRun {
  readonly version: number;
  readonly artifact: PolicyArtifact;
  /** Observation sections this policy's `think` receives in full (resolved at load; fixed per artifact). */
  readonly detail: readonly string[];
  readonly stats: PolicyStats;
  private instance: PolicyInstance;
  private readonly limits: PolicyLimits;
  private readonly seed: number;
  private readonly matchData: unknown;
  private restarts = 0;
  /** Timeouts of the current instance since its last successful call. */
  private timeouts = 0;
  private totalMs = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(version: number, artifact: PolicyArtifact, instance: PolicyInstance, limits: PolicyLimits, seed: number, matchData: unknown, detail: readonly string[]) {
    this.version = version;
    this.artifact = artifact;
    this.instance = instance;
    this.limits = limits;
    this.seed = seed;
    this.matchData = matchData;
    this.detail = detail;
    this.stats = emptyStats(version, artifact.runtime);
  }

  /** False once the instance died more than MAX_RESTARTS times in a row (or was disposed). */
  get active(): boolean {
    return !this.disposed && (!this.instance.dead || this.restarts < MAX_RESTARTS);
  }

  /** Calls are serialized per instance. Never rejects. */
  think(observation: unknown): Promise<PolicyThink> {
    const run = this.queue.then(() => this.call(observation));
    this.queue = run;
    return run;
  }

  private async call(observation: unknown): Promise<PolicyThink> {
    if (this.disposed) return { intents: [], logs: [], ms: 0 };
    if (this.instance.dead) {
      if (this.restarts >= MAX_RESTARTS) return { intents: [], logs: [], ms: 0 };
      this.restarts++;
      let loaded: LoadResult;
      try {
        loaded = await loadArtifact(this.artifact, this.limits, this.seed, this.matchData);
      } catch {
        // Host-side sandbox failures (no worker thread, boot timeout) reject; a rejection here would break the
        // never-rejects contract and poison the queue, so every later think() — and the match tick awaiting it — fails.
        loaded = { ok: false, error: { code: 'threw', message: 'sandbox failed to start' } };
      }
      if (!loaded.ok) {
        this.restarts = MAX_RESTARTS;
        this.recordError(loaded.error);
        return { intents: [], logs: [], ms: 0, error: loaded.error };
      }
      if (this.disposed) {
        loaded.instance.dispose();
        return { intents: [], logs: [], ms: 0 };
      }
      this.instance = loaded.instance;
      this.timeouts = 0;
    }
    let r: PolicyCallOutcome;
    try {
      r = await this.instance.call(observation);
    } catch {
      // The sandbox contract says call() never rejects; treat a violation as a crash of this artifact.
      r = { ok: false, error: { code: 'threw' }, ms: 0 };
    }
    const s = this.stats;
    s.calls++;
    const ms = r.ok ? r.value.ms : r.ms;
    this.totalMs += ms;
    s.meanMs = this.totalMs / s.calls;
    s.maxMs = Math.max(s.maxMs, ms);
    if (!r.ok) {
      this.recordError(r.error);
      // A timeout the instance survived keeps its state as of the interruption; a run of them without a success means
      // it no longer finishes within budget, so it is killed and the next call reloads it fresh.
      if (r.error.code === 'timeout' && !this.instance.dead && ++this.timeouts >= MAX_CONSECUTIVE_TIMEOUTS) this.instance.dispose();
      const logs = r.logs ?? [];
      this.appendLogs(logs);
      return { intents: [], logs, ms, error: r.error };
    }
    this.timeouts = 0;
    if (!this.instance.dead) this.restarts = 0;
    s.successfulCalls++;
    s.consecutiveFailures = 0;
    const { intents, dropped, logs } = r.value;
    const capped = intents.slice(0, this.limits.maxIntentsPerCall);
    s.intentsEmitted += capped.length;
    const over = dropped + (intents.length - capped.length);
    if (over > 0) this.reject('too_many', over);
    this.appendLogs(logs);
    return { intents: capped, logs, ms };
  }

  private recordError(error: PolicyError): void {
    this.stats.consecutiveFailures++;
    if (error.code === 'timeout') this.stats.timeouts++;
    else this.stats.errors++;
    this.stats.lastError = error;
  }

  private appendLogs(lines: string[]): void {
    if (lines.length === 0) return;
    const logs = this.stats.logs;
    logs.push(...lines);
    if (logs.length > this.limits.maxLogLines) logs.splice(0, logs.length - this.limits.maxLogLines);
  }

  /**
   * Count a rejected intent by closed code (ack code, `game:<code>`, `too_many`); a schema-invalid one (`invalid`, the
   * ack itself works) also becomes `lastInvalid`.
   */
  reject(code: string, n = 1, invalid?: InvalidIntent): void {
    const row = this.stats.intentsRejected.find((r) => r.code === code);
    if (row) row.count += n;
    else this.stats.intentsRejected.push({ code, count: n });
    // Copy the three members: an ack passed as `invalid` also carries `ok` and `code`.
    if (invalid) this.stats.lastInvalid = { schemaCode: invalid.schemaCode, path: [...invalid.path], expected: invalid.expected };
  }

  snapshot(): PolicyStats {
    return structuredClone(this.stats);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.instance.dispose();
  }
}
