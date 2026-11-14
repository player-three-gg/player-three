/**
 * Policy sandbox contract. Implementations: `js` (QuickJS compiled to WASM) and `wasm` (core module, any language).
 *
 * Isolation requirements every runtime MUST meet:
 *  - no host capabilities: no fs, net, clock, timers, randomness source other than what obs provides, no host objects
 *  - hard wall-clock limit per call (`msPerCall`), memory cap (`memoryBytes`)
 *  - output is untrusted JSON; the host validates every intent like any other agent intent
 *  - state persists between calls of one loaded instance (a match), never across instances
 *
 * Policy entrypoint semantics (both runtimes):  think(observation) -> intents[]
 * See docs/POLICY_ABI.md for the exact JS and WASM ABIs.
 */
import type { PolicyLimits, PolicyRuntime } from '../manifest.ts';
import type { PolicyError } from '../control.ts';

/** A successful `think` call. */
export interface PolicyCallResult {
  /** Untrusted; at most limits.maxIntentsPerCall (extra are dropped and counted). */
  intents: unknown[];
  dropped: number;
  /** Lines the policy logged during this call, each ≤ maxLogLineBytes. */
  logs: string[];
  /** Wall time the call took on the sandbox thread (excludes host scheduling and the thread round trip). */
  ms: number;
  /** CPU time of the sandbox thread during the call: the quantity `msPerCall` budgets (load-independent). */
  cpuMs: number;
}

export type PolicyCallOutcome =
  | { ok: true; value: PolicyCallResult }
  /** `cpuMs` is present when the sandbox thread answered (not after a watchdog kill or on a dead instance). */
  | { ok: false; error: PolicyError; ms: number; cpuMs?: number; logs?: string[] };

/**
 * Observation detail a policy declares it reads (JS global `detail`, wasm custom section `playerthree.detail`): `'all'`
 * or section names (enum literals, unique). The host resolves it against the game's `observationScope`.
 */
export type PolicyDetail = readonly string[] | 'all';

/** One loaded policy, isolated in its own worker; state persists between its calls. */
export interface PolicyInstance {
  readonly runtime: PolicyRuntime;
  /** The artifact's declared observation detail (shape-checked at load); undefined when it declares none. */
  readonly detail: PolicyDetail | undefined;
  /**
   * Rejects never; failures are returned. After a `memory_limit`, an engine crash (reported as `threw`) or a `timeout`
   * other than a JS call's CPU-budget interrupt (wasm, the hang guard, a promise-job drain that overran) the instance is
   * dead and every further call returns the error that killed it. A JS call its interrupt stopped fails `timeout` and
   * keeps the instance, with its state as of the interruption (spec §11). `logs`: lines the policy logged before a
   * non-fatal failure (same caps as on success).
   */
  call(observation: unknown): Promise<PolicyCallOutcome>;
  readonly dead: boolean;
  dispose(): void;
}

/** The result of loading a policy: an instance, or a closed policy error. */
export type LoadResult = { ok: true; instance: PolicyInstance } | { ok: false; error: PolicyError };

/** Per-instance load options. */
export interface LoadOptions {
  /**
   * Seed for the sandbox's deterministic PRNG (JS `Math.random`). Same seed + same match data + same observation
   * sequence ⇒ same outputs, so practice runs and replays reproduce exactly. Default 0.
   */
  seed?: number;
  /** JSON-compatible bootstrap passed to init once. Independently capped at MATCH_DATA_MAX_BYTES (128 KiB). */
  matchData?: unknown;
}

/** Per-seat options of a trusted instance (spec §11 *Trusted runner*). */
export interface TrustedLoadOptions extends LoadOptions {
  /**
   * The seat's bot options (`GameDefinition.botOptions`, already validated by the host), or `null`/absent: the
   * instance's `createPolicy(options)` receives its own parsed copy, `null` when absent.
   */
  options?: Readonly<Record<string, number | boolean>> | null;
}

/** Bytes for wasm, text for js. Validates size, compiles, instantiates, checks exports. */
export type LoadPolicy = (
  runtime: PolicyRuntime,
  code: string | Uint8Array,
  limits: PolicyLimits,
  opts?: LoadOptions,
) => Promise<LoadResult>;

/**
 * A trusted call (spec §11 *Trusted runner*): synchronous, in the caller's thread, untimed (the caller measures what
 * it needs). `intents` and `dropped` as in `PolicyCallResult`; `logs` as there, empty when the call logged nothing.
 */
export type TrustedCallOutcome =
  | { ok: true; intents: unknown[]; dropped: number; logs: readonly string[] }
  | { ok: false; error: PolicyError; logs: readonly string[] };

/** One seat's instance of a trusted package, inside the realm its package shares with every other seat. */
export interface TrustedInstance {
  /**
   * Never throws. After a `timeout` (the hang guard killed the call) the instance is dead and every further call
   * returns that error.
   */
  call(observation: unknown): TrustedCallOutcome;
  readonly dead: boolean;
  dispose(): void;
}

export type TrustedLoadResult = { ok: true; instance: TrustedInstance } | { ok: false; error: PolicyError };
