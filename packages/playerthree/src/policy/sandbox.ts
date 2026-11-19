/** Host side of a policy instance: one worker thread per instance, calls over the shared-memory channel, hard kill. */
import { Worker } from 'node:worker_threads';
import type { PolicyError } from '../control.ts';
import type { PolicyLimits, PolicyRuntime } from '../manifest.ts';
import {
  CTRL_BYTES,
  DATA_INITIAL_BYTES,
  DATA_MAX_BYTES,
  ERROR_CODES,
  LOAD_BUDGET_FACTOR,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_DEPTH,
  MS_OFFSET,
  REQ_LEN,
  REQ_SEQ,
  RES_A,
  RES_B,
  RES_CODE,
  RES_FATAL,
  RES_KIND,
  RES_OK,
  RES_SEQ,
  watchdogMs,
  type LoadMessage,
  type WorkerInit,
} from './channel.ts';
import { MAX_MESSAGE_BYTES, truncateUtf8 } from './text.ts';
import type { LoadResult, PolicyCallOutcome, PolicyCallResult, PolicyDetail, PolicyInstance } from './types.ts';

/** Source checkouts run `.ts` directly; the published package runs the emitted `.js`. */
const WORKER_URL = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url);
/** Time a worker may take to boot before it starts running untrusted code. Exceeding it is a host failure. */
const BOOT_TIMEOUT_MS = 30_000;
/** Native stack for the sandbox thread; deep enough that QuickJS's own stack guard trips first. */
const WORKER_STACK_MB = 8;
/** V8 heap headroom for the worker itself (glue code, marshalled strings), on top of the policy's budget. */
const WORKER_HEAP_BASE_MB = 32;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** Section names a policy may declare: the manifest enum-literal grammar. */
const SECTION_NAME = /^[A-Za-z][A-Za-z0-9_.<>]{0,47}$/;
/** Most section names one declaration may list (a game declares far fewer; the host checks the real set). */
export const MAX_DETAIL_SECTIONS = 64;

/**
 * Shape check of a declared observation detail (JSON text): `"all"` or a list of unique section names. Null when
 * malformed; whether the names exist is the host's check against the game's `observationScope`.
 */
export function parseDetail(json: string): PolicyDetail | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (v === 'all') return 'all';
  if (!Array.isArray(v) || v.length > MAX_DETAIL_SECTIONS) return null;
  if (!v.every((s): s is string => typeof s === 'string' && SECTION_NAME.test(s)) || new Set(v).size !== v.length) return null;
  return v;
}

export const DETAIL_ERROR = 'detail must be "all" or a list of unique observation section names';

export interface SpawnSpec {
  runtime: PolicyRuntime;
  limits: PolicyLimits;
  seed: number;
  matchDataJson: string;
  module: WebAssembly.Module;
  source?: string;
  enginePages?: { initial: number; maximum: number };
  /** wasm: the detail declared in the module's custom section, already shape-checked (JS reports it from the guest). */
  detail?: PolicyDetail;
}

function workerFailure(e: unknown): PolicyError {
  if ((e as { code?: unknown } | null)?.code === 'ERR_WORKER_OUT_OF_MEMORY') return { code: 'memory_limit', message: 'sandbox heap exhausted' };
  return { code: 'threw', message: 'sandbox crashed' };
}

/** Spawns the worker, runs the load phase under the load budget, and returns a live instance or the load error. */
export function spawnPolicy(spec: SpawnSpec): Promise<LoadResult> {
  const ctrlBuf = new SharedArrayBuffer(CTRL_BYTES);
  const dataBuf = new SharedArrayBuffer(DATA_INITIAL_BYTES, { maxByteLength: DATA_MAX_BYTES });
  const init: WorkerInit = { runtime: spec.runtime, ctrl: ctrlBuf, data: dataBuf, limits: spec.limits, seed: spec.seed, matchDataJson: spec.matchDataJson, module: spec.module };
  if (spec.source !== undefined) init.source = spec.source;
  if (spec.enginePages !== undefined) init.enginePages = spec.enginePages;

  const worker = new Worker(WORKER_URL, {
    workerData: init,
    execArgv: [],
    env: {},
    stdout: true,
    stderr: true,
    resourceLimits: {
      maxOldGenerationSizeMb: WORKER_HEAP_BASE_MB + Math.ceil(spec.limits.memoryBytes / (1 << 20)),
      maxYoungGenerationSizeMb: 8,
      stackSizeMb: WORKER_STACK_MB,
    },
  });
  // Nothing a policy does may reach the host's stdio.
  worker.stdout.resume();
  worker.stderr.resume();

  const { promise, resolve, reject } = Promise.withResolvers<LoadResult>();
  let started = false;
  let settled = false;
  let timer = setTimeout(() => fail(new Error('policy sandbox worker did not start')), BOOT_TIMEOUT_MS);
  const finish = (r: LoadResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    worker.off('message', onMessage);
    if (!r.ok) void worker.terminate();
    resolve(r);
  };
  const fail = (e: unknown): void => {
    if (settled) return;
    if (started) return finish({ ok: false, error: workerFailure(e) });
    settled = true;
    clearTimeout(timer);
    void worker.terminate();
    reject(e instanceof Error ? e : new Error('policy sandbox worker failed to start'));
  };
  const onMessage = (m: LoadMessage): void => {
    if (m.t === 'begin') {
      started = true;
      clearTimeout(timer);
      const budget = spec.limits.msPerCall * LOAD_BUDGET_FACTOR;
      timer = setTimeout(() => finish({ ok: false, error: { code: 'timeout', message: `load exceeded ${budget} ms` } }), watchdogMs(budget));
    } else if (m.t === 'ready') {
      let detail = spec.detail;
      if (m.detail !== undefined) {
        const parsed = parseDetail(m.detail);
        if (parsed === null) return finish({ ok: false, error: { code: 'bad_output', message: DETAIL_ERROR } });
        detail = parsed;
      }
      finish({ ok: true, instance: new SandboxInstance(spec.runtime, detail, spec.limits, worker, ctrlBuf, dataBuf) });
    } else {
      const error: PolicyError = { code: m.code };
      if (m.message !== undefined) error.message = m.message;
      finish({ ok: false, error });
    }
  };
  worker.on('message', onMessage);
  worker.once('error', fail);
  worker.once('exit', () => fail(new Error('policy sandbox worker exited during load')));
  return promise;
}

class SandboxInstance implements PolicyInstance {
  readonly runtime: PolicyRuntime;
  readonly detail: PolicyDetail | undefined;
  readonly #limits: PolicyLimits;
  readonly #worker: Worker;
  readonly #ctrl: Int32Array;
  readonly #ms: Float64Array;
  readonly #dataBuf: SharedArrayBuffer;
  readonly #data: Uint8Array;
  #seq = 0;
  #death: PolicyError | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  /** Resolves when the worker dies on its own (heap limit, crash). */
  readonly #exited: Promise<void>;

  constructor(runtime: PolicyRuntime, detail: PolicyDetail | undefined, limits: PolicyLimits, worker: Worker, ctrl: SharedArrayBuffer, data: SharedArrayBuffer) {
    this.runtime = runtime;
    this.detail = detail;
    this.#limits = limits;
    this.#worker = worker;
    this.#ctrl = new Int32Array(ctrl);
    this.#ms = new Float64Array(ctrl, MS_OFFSET, 2);
    this.#dataBuf = data;
    this.#data = new Uint8Array(data);
    const exited = Promise.withResolvers<void>();
    this.#exited = exited.promise;
    worker.once('error', (e) => {
      this.#kill(workerFailure(e));
      exited.resolve();
    });
    worker.once('exit', () => {
      this.#kill({ code: 'threw', message: 'sandbox exited' });
      exited.resolve();
    });
    // An idle instance must not keep the host process alive; in-flight calls hold a timer.
    worker.unref();
  }

  get dead(): boolean {
    return this.#death !== null;
  }

  call(observation: unknown): Promise<PolicyCallOutcome> {
    const p = this.#queue.then(() =>
      this.#call(observation).catch((): PolicyCallOutcome => {
        // A host-side fault in the channel itself: the instance cannot be trusted to continue.
        this.#kill({ code: 'threw', message: 'sandbox channel failure' });
        return { ok: false, error: this.#death!, ms: 0 };
      }),
    );
    this.#queue = p;
    return p;
  }

  dispose(): void {
    this.#kill({ code: 'threw', message: 'instance disposed' });
  }

  #kill(error: PolicyError): void {
    if (this.#death) return;
    this.#death = error;
    void this.#worker.terminate();
    // Release a pending Atomics.waitAsync on the response slot.
    Atomics.notify(this.#ctrl, RES_SEQ);
  }

  async #call(observation: unknown): Promise<PolicyCallOutcome> {
    const t0 = performance.now();
    const elapsed = (): number => performance.now() - t0;
    if (this.#death) return { ok: false, error: this.#death, ms: 0 };

    let json: string | undefined;
    try {
      json = JSON.stringify(observation ?? null);
    } catch {
      json = undefined;
    }
    if (json === undefined) return { ok: false, error: { code: 'threw', message: 'observation is not JSON-serialisable' }, ms: elapsed() };
    const worst = json.length * 3;
    if (worst > this.#data.length) this.#dataBuf.grow(Math.min(DATA_MAX_BYTES, worst));
    const { read, written } = encoder.encodeInto(json, this.#data);
    if (read < json.length) return { ok: false, error: { code: 'too_large', message: 'observation exceeds the sandbox channel' }, ms: elapsed() };

    const ctrl = this.#ctrl;
    const seq = ++this.#seq;
    ctrl[REQ_LEN] = written;
    const wait = Atomics.waitAsync(ctrl, RES_SEQ, seq - 1);
    Atomics.store(ctrl, REQ_SEQ, seq);
    Atomics.notify(ctrl, REQ_SEQ);

    if (wait.async) {
      const deadline = Promise.withResolvers<void>();
      const timer = setTimeout(deadline.resolve, watchdogMs(this.#limits.msPerCall));
      await Promise.race([wait.value, deadline.promise, this.#exited]);
      clearTimeout(timer);
    }
    if (Atomics.load(ctrl, RES_SEQ) !== seq) {
      this.#kill(this.#death ?? { code: 'timeout' });
      return { ok: false, error: this.#death!, ms: elapsed() };
    }

    // Time the policy spent on the sandbox thread; host scheduling noise is not the policy's cost.
    const ms = this.#ms[0]!;
    const cpuMs = this.#ms[1]!;
    const a = ctrl[RES_A]!;
    const b = ctrl[RES_B]!;
    const logs = JSON.parse(strictUtf8.decode(this.#data.slice(a, a + b))) as string[];
    const kind = ctrl[RES_KIND];
    if (kind !== RES_OK) {
      const error: PolicyError = { code: ERROR_CODES[ctrl[RES_CODE]!] ?? 'threw' };
      if (a > 0) error.message = truncateUtf8(strictUtf8.decode(this.#data.slice(0, a)), MAX_MESSAGE_BYTES);
      if (kind === RES_FATAL) {
        this.#kill(error);
        return { ok: false, error, ms, cpuMs };
      }
      return { ok: false, error, ms, cpuMs, logs };
    }

    // The host is the trust boundary for output: guest-side checks are early rejects a policy can sidestep
    // (getters that answer differently on a second read, or a wasm module, which has none).
    if (a > MAX_OUTPUT_BYTES) return { ok: false, error: { code: 'bad_output', message: `output larger than ${MAX_OUTPUT_BYTES} bytes` }, ms, cpuMs, logs };
    let out: unknown;
    try {
      out = JSON.parse(strictUtf8.decode(this.#data.slice(0, a)));
    } catch {
      return { ok: false, error: { code: 'bad_output', message: 'output is not valid UTF-8 JSON' }, ms, cpuMs, logs };
    }
    if (!Array.isArray(out)) return { ok: false, error: { code: 'bad_output', message: 'output must be a JSON array of intents' }, ms, cpuMs, logs };
    if (nestedTooDeep(out, 0)) return { ok: false, error: { code: 'bad_output', message: `output nested deeper than ${MAX_OUTPUT_DEPTH} levels` }, ms, cpuMs, logs };
    const max = this.#limits.maxIntentsPerCall;
    const value: PolicyCallResult = {
      intents: out.length > max ? out.slice(0, max) : out,
      dropped: Math.max(0, out.length - max),
      logs,
      ms,
      cpuMs,
    };
    return { ok: true, value };
  }
}

/** True when a value lies more than MAX_OUTPUT_DEPTH levels below the top-level array; recursion stops at that bound. */
function nestedTooDeep(v: unknown, depth: number): boolean {
  if (depth > MAX_OUTPUT_DEPTH) return true;
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) {
    for (const x of v) if (nestedTooDeep(x, depth + 1)) return true;
  } else {
    for (const k in v) if (nestedTooDeep((v as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}
