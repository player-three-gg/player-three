/**
 * Sandbox worker: hosts exactly one policy instance. Loads it (reporting over postMessage), then serves calls over the
 * shared-memory channel in a blocking loop. Each call gets a `Budget` the guest judges (guest.ts); the host terminates
 * the worker when its watchdog fires, and to dispose.
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  Budget,
  DATA_MAX_BYTES,
  ERROR_CODES,
  LOAD_BUDGET_FACTOR,
  MS_OFFSET,
  REQ_LEN,
  REQ_SEQ,
  RES_A,
  RES_B,
  RES_CODE,
  RES_ERROR,
  RES_FATAL,
  RES_KIND,
  RES_OK,
  RES_SEQ,
  type LoadMessage,
  type WorkerInit,
} from './channel.ts';
import type { Guest, GuestLoad, GuestResult } from './guest.ts';
import { loadJs } from './guest-js.ts';
import { loadWasm } from './guest-wasm.ts';

const init = workerData as WorkerInit;
const port = parentPort!;
const post = (m: LoadMessage): void => port.postMessage(m);
let loadBudget: Budget | undefined;
const begin = (): Budget => {
  post({ t: 'begin' });
  loadBudget = new Budget(init.limits.msPerCall * LOAD_BUDGET_FACTOR);
  return loadBudget;
};

let loaded: GuestLoad;
if (init.runtime === 'js') {
  loaded = await loadJs(init.source ?? '', { module: init.module, pages: init.enginePages! }, init.limits, init.seed, init.matchDataJson, begin);
} else {
  loaded = loadWasm(init.module, init.limits, init.matchDataJson, begin);
}
if (loaded.ok && loadBudget?.exceeded()) loaded = { ok: false, code: 'timeout', fatal: true };

if (loaded.ok) {
  post(loaded.detail === undefined ? { t: 'ready' } : { t: 'ready', detail: loaded.detail });
  serve(loaded.guest);
} else {
  const m: LoadMessage = { t: 'fail', code: loaded.code, fatal: loaded.fatal };
  if (loaded.message !== undefined) m.message = loaded.message;
  post(m);
}

function serve(guest: Guest): never {
  const ctrl = new Int32Array(init.ctrl);
  const ms = new Float64Array(init.ctrl, MS_OFFSET, 2);
  const data = new Uint8Array(init.data);
  const encoder = new TextEncoder();
  let seq = 0;

  /** Writes `s` as UTF-8 at `offset`, growing the shared buffer as needed; returns bytes written. */
  const writeString = (s: string, offset: number): number => {
    const need = offset + s.length * 3;
    if (need > data.length) init.data.grow(Math.min(DATA_MAX_BYTES, need));
    return encoder.encodeInto(s, data.subarray(offset)).written;
  };
  const writeBytes = (b: Uint8Array, offset: number): number => {
    if (offset + b.length > data.length) init.data.grow(offset + b.length);
    data.set(b, offset);
    return b.length;
  };

  for (;;) {
    Atomics.wait(ctrl, REQ_SEQ, seq);
    seq = Atomics.load(ctrl, REQ_SEQ);
    const budget = new Budget(init.limits.msPerCall);
    let r: GuestResult;
    try {
      r = guest.call(data, ctrl[REQ_LEN]!, budget);
    } catch (e) {
      r = { ok: false, code: 'threw', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e), fatal: true, logs: [] };
    }
    ms[0] = budget.wallMs();
    ms[1] = budget.cpuMs();
    let a: number;
    if (r.ok) {
      a = typeof r.out === 'string' ? writeString(r.out, 0) : writeBytes(r.out, 0);
      ctrl[RES_KIND] = RES_OK;
    } else {
      a = r.message === undefined ? 0 : writeString(r.message, 0);
      ctrl[RES_KIND] = r.fatal ? RES_FATAL : RES_ERROR;
      ctrl[RES_CODE] = ERROR_CODES.indexOf(r.code);
    }
    ctrl[RES_A] = a;
    ctrl[RES_B] = writeString(JSON.stringify(r.logs), a);
    Atomics.store(ctrl, RES_SEQ, seq);
    Atomics.notify(ctrl, RES_SEQ);
  }
}
