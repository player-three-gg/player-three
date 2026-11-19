/**
 * Host ↔ sandbox-worker call channel. One request in flight at a time.
 *
 * `ctrl` (SharedArrayBuffer, CTRL_BYTES): Int32 slots below, plus the worker-measured call wall time and thread CPU
 * time (ms) as two Float64s at MS_OFFSET.
 * `data` (growable SharedArrayBuffer): request = observation JSON (UTF-8) at [0, REQ_LEN);
 * response = [0, RES_A) output JSON or error message, then [RES_A, RES_A + RES_B) log lines as a JSON string array.
 *
 * The host bumps REQ_SEQ and notifies; the worker blocks in `Atomics.wait` on REQ_SEQ, answers by storing the same
 * sequence number into RES_SEQ and notifying; the host awaits RES_SEQ with `Atomics.waitAsync`. Measured round trip
 * overhead is ~0.03–0.05 ms versus ~0.06–0.08 ms for `postMessage`.
 */
import type { PolicyErrorCode } from '../control.ts';
import type { PolicyLimits } from '../manifest.ts';

export const REQ_SEQ = 0;
export const REQ_LEN = 1;
export const RES_SEQ = 2;
/** RES_OK | RES_ERROR | RES_FATAL */
export const RES_KIND = 3;
export const RES_A = 4;
export const RES_B = 5;
/** Index into ERROR_CODES when RES_KIND is an error. */
export const RES_CODE = 6;

export const RES_OK = 0;
/** The call failed; the instance stays usable (including a JS call its CPU-budget interrupt stopped, spec §11). */
export const RES_ERROR = 1;
/** The call failed and the instance must be killed (other timeouts, memory exhaustion, engine state lost). */
export const RES_FATAL = 2;

export const CTRL_BYTES = 64;
export const MS_OFFSET = 32;

export const DATA_INITIAL_BYTES = 1 << 20;
/** Address-space reservation for the growable data buffer. Observations larger than this are refused. */
export const DATA_MAX_BYTES = 256 << 20;

/** Largest policy output (UTF-8 JSON) accepted per call. */
export const MAX_OUTPUT_BYTES = 1 << 20;
/**
 * Deepest output structure accepted from a policy: no value more than this many levels below the top-level array.
 * The host enforces it on the parsed output (guest-side checks can be bypassed with getters, and wasm has none).
 */
export const MAX_OUTPUT_DEPTH = 32;

/** Load (top-level code / start function + `init`) may take this many per-call budgets. */
export const LOAD_BUDGET_FACTOR = 10;

/**
 * Budget rules. The budget is CPU time of the sandbox thread, measured from the moment it picks the call up, so time
 * the thread spends descheduled (a loaded machine), thread wake-up latency and host event-loop stalls never count.
 * The per-thread CPU clock (getrusage(RUSAGE_THREAD)) advances at scheduler ticks and context switches, so it can trail
 * the true value by about one tick. A separate, larger wall-clock hang guard bounds work the thread cannot interrupt
 * (wasm loops, long native operations) and threads starved of CPU.
 */
export function hangCapMs(budgetMs: number): number {
  return 4 * budgetMs + 100;
}

/** Host-side watchdog, measured from sending the request: the hang guard plus slack for thread wake-ups. */
export function watchdogMs(budgetMs: number): number {
  return hangCapMs(budgetMs) + 50;
}

/** Wall and thread-CPU clocks in milliseconds; injectable so the budget rule can be tested without real load. */
export interface BudgetClocks {
  wallMs(): number;
  cpuMs(): number;
}

const threadClocks: BudgetClocks = {
  wallMs: () => performance.now(),
  cpuMs: () => {
    const u = process.threadCpuUsage();
    return (u.user + u.system) / 1000;
  },
};

/** Tracks one call (or the load phase) on the sandbox thread. */
export class Budget {
  readonly limitMs: number;
  readonly start: number;
  readonly cpu0: number;
  readonly #clocks: BudgetClocks;
  constructor(limitMs: number, clocks: BudgetClocks = threadClocks) {
    this.limitMs = limitMs;
    this.#clocks = clocks;
    this.start = clocks.wallMs();
    this.cpu0 = clocks.cpuMs();
  }
  /** Wall time since the call was picked up. */
  wallMs(): number {
    return this.#clocks.wallMs() - this.start;
  }
  /** Sandbox-thread CPU time since the call was picked up: the budgeted quantity. */
  cpuMs(): number {
    return this.#clocks.cpuMs() - this.cpu0;
  }
  exceeded(): boolean {
    const wall = this.wallMs();
    // One thread cannot use more CPU than wall time: skip the CPU clock (a syscall) while wall time is within budget.
    if (wall <= this.limitMs) return false;
    if (wall > hangCapMs(this.limitMs)) return true;
    return this.cpuMs() > this.limitMs;
  }
  /** Past the wall-clock hang guard: work the thread could not interrupt, or a thread starved of CPU. */
  hung(): boolean {
    return this.wallMs() > hangCapMs(this.limitMs);
  }
  /** A budget of the same size on the same clocks, starting now. */
  fresh(): Budget {
    return new Budget(this.limitMs, this.#clocks);
  }
}

export const ERROR_CODES: readonly PolicyErrorCode[] = [
  'runtime_not_allowed',
  'too_large',
  'compile',
  'missing_export',
  'bad_module',
  'imports_not_allowed',
  'memory_limit',
  'timeout',
  'threw',
  'bad_output',
];

export interface WorkerInit {
  runtime: 'js' | 'wasm';
  ctrl: SharedArrayBuffer;
  data: SharedArrayBuffer;
  limits: PolicyLimits;
  seed: number;
  /** Independent, bounded JSON bootstrap supplied during loading, never on the call channel. */
  matchDataJson: string;
  /** js: policy source. */
  source?: string;
  /** js: compiled QuickJS engine; wasm: compiled policy module. */
  module: WebAssembly.Module;
  /** js: QuickJS linear memory bounds, in 64 KiB pages. */
  enginePages?: { initial: number; maximum: number };
}

/** Worker → host messages during load. Calls use the shared-memory channel. */
export type LoadMessage =
  | { t: 'begin' }
  /** `detail`: a JS policy's declared global `detail` as JSON text (absent: none declared). */
  | { t: 'ready'; detail?: string }
  | { t: 'fail'; code: PolicyErrorCode; message?: string; fatal: boolean };
