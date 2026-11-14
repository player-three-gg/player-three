/** JavaScript policy guest: QuickJS compiled to WebAssembly, one engine instance per policy instance (runs inside the sandbox worker). */
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten';
import type { PolicyLimits } from '../manifest.ts';
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_DEPTH, type Budget } from './channel.ts';
import { engineMessage, failure, type Guest, type GuestFailure, type GuestLoad } from './guest.ts';
import { decodeStatus, PRELUDE_BINDINGS, PRELUDE_DATE, PRELUDE_FMT, PRELUDE_MIX, preludeChecks } from './prelude.ts';
import { MAX_MESSAGE_BYTES, truncateUtf8 } from './text.ts';

/**
 * QuickJS's own stack guard. It must trip before V8's native stack (worker `stackSizeMb`) runs out,
 * and stay below the engine's 5 MiB shadow stack.
 */
export const QJS_STACK_BYTES = 256 * 1024;

const WARMUP = `
  const o = { tick: 1, units: [] };
  for (let i = 0; i < 200; i++) o.units.push({ id: 'u_' + i, x: i * 1.5, hp: 100 - (i % 7), kind: i % 2 ? 'a' : 'b', tags: [i, null, true] });
  let s = 0;
  for (let r = 0; r < 20; r++) {
    const p = JSON.parse(JSON.stringify(o));
    for (const u of p.units) if (u.hp > 50 && u.kind === 'a') s += Math.sqrt(u.x * u.x + 1);
    s += p.units.map((u) => ({ kind: 'move', unit: u.id })).filter((x) => x.unit.length > 2).slice(0, 8).length;
  }
  s;`;

/**
 * Trusted prelude, evaluated before the policy. Installs the deterministic `Math` functions (math.ts), `Math.random`
 * and `Date`, the `log` global, and returns `{ start, call }` closures holding pristine references to the builtins
 * they need, so the policy cannot tamper with marshalling. Status strings: `o<json>` ok, `b<msg>` bad output, `e<msg>` threw,
 * `x<msg>` missing entrypoint, `m` out of memory. The trusted runner (trusted.ts) shares its parts and status codes.
 */
export const PRELUDE = `(function (hostLog, seedLo, seedHi, maxLines, maxChars, maxOut, maxDepth, maxMsg) {
  'use strict';
${PRELUDE_BINDINGS}

  // sfc32 seeded through murmur3's finaliser; 32 bits of output per call.
${PRELUDE_MIX}
  let a = mix(seedLo ^ 0x9e3779b9), b = mix(seedHi ^ 0x243f6a88), c = mix(seedLo ^ 0xb7e15162), d = mix(seedHi ^ 0x6a09e667);
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  defineProperty(Math, 'random', { value: function random() { return next() / 4294967296; }, writable: true, configurable: true });

${PRELUDE_DATE}

  let lines = 0;
${PRELUDE_FMT}
  defineProperty(G, 'log', {
    value: function log(...args) {
      if (lines >= maxLines) return;
      lines++;
      let s = '';
      for (let i = 0; i < args.length && s.length < maxChars; i++) s += (i > 0 ? ' ' : '') + fmt(args[i]);
      hostLog(s.length > maxChars ? s.slice(0, maxChars) : s);
    },
    writable: true, configurable: true,
  });

${preludeChecks('p !== ObjProto && p !== null')}

  return {
    start(json) {
      lines = 0;
      try {
        if (typeof G.think !== 'function') return 'xpolicy must define a global function think(obs)';
        // The declared observation detail is read once, after top-level code and before init (POLICY_ABI.md). A bare
        // name, so script-level const/let bindings count as well as var and globalThis properties.
        const d = typeof detail === 'undefined' ? undefined : detail;
        const dj = d === undefined ? '' : JSONstringify(d);
        if (typeof dj !== 'string' || dj.length > maxOut) return 'bdetail must be JSON data: "all" or a list of observation section names';
        if (typeof G.init === 'function') G.init(JSONparse(json));
        return 'o' + dj;
      } catch (e) { return isOOM(e) ? 'm' : 'e' + describe(e); }
    },
    call(json) {
      lines = 0;
      try {
        const think = G.think;
        if (typeof think !== 'function') return 'ethink is not a function';
        const out = think(JSONparse(json));
        if (!isArray(out)) return 'bthink must return an array, got ' + (out === null ? 'null' : typeof out);
        const bad = check(out, 0);
        if (bad !== '') return 'b' + bad;
        const s = JSONstringify(out);
        // UTF-16 units never exceed UTF-8 bytes: a cheap early reject before marshalling. The host checks the exact size.
        if (s.length > maxOut) return 'boutput larger than ' + maxOut + ' bytes';
        return 'o' + s;
      } catch (e) { return isOOM(e) ? 'm' : 'e' + describe(e); }
    },
  };
})`;

export interface EngineSetup {
  module: WebAssembly.Module;
  pages: { initial: number; maximum: number };
}

/** `run`'s answer when the budget's interrupt fired. */
const INTERRUPTED = { interrupted: true } as const;

export async function loadJs(source: string, engine: EngineSetup, limits: PolicyLimits, seed: number, matchDataJson: string, begin: () => Budget): Promise<GuestLoad> {
  const memory = new WebAssembly.Memory({ initial: engine.pages.initial, maximum: engine.pages.maximum });
  const qjs = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule: engine.module, wasmMemory: memory }));
  const rt = qjs.newRuntime();
  // QuickJS cannot measure allocation sizes under Emscripten, so the real cap is the bounded linear memory above;
  // this still rejects any single allocation larger than the budget up front.
  rt.setMemoryLimit(limits.memoryBytes);
  rt.setMaxStackSize(QJS_STACK_BYTES);
  /** What the interrupt handler polls: the load or call budget, or a drain's (see `overrun`). */
  let budget: { exceeded(): boolean } | null = null;
  let interrupted = false;
  rt.setInterruptHandler(() => {
    if (budget === null || !budget.exceeded()) return false;
    interrupted = true;
    return true;
  });
  // Warm the engine's hot paths (JSON, property access, array builtins) in a throwaway context so V8's lazy wasm
  // compilation is not billed to the policy's first call. The policy's own context never sees this code.
  const warm = rt.newContext();
  warm.unwrapResult(warm.evalCode(WARMUP, 'playerthree:warmup', { type: 'global' })).dispose();
  warm.dispose();
  const ctx = rt.newContext();
  const logs: string[] = [];
  const hostLog = ctx.newFunction('hostLog', (h) => {
    if (logs.length < limits.maxLogLines) logs.push(truncateUtf8(ctx.getString(h), limits.maxLogLineBytes));
  });

  const seedLo = seed >>> 0;
  const seedHi = Math.floor(seed / 4294967296) >>> 0;
  const factory = ctx.unwrapResult(ctx.evalCode(PRELUDE, 'playerthree:prelude', { type: 'global', strict: true }));
  const args = [seedLo, seedHi, limits.maxLogLines, limits.maxLogLineBytes, MAX_OUTPUT_BYTES, MAX_OUTPUT_DEPTH, MAX_MESSAGE_BYTES].map((n) => ctx.newNumber(n));
  const api = ctx.unwrapResult(ctx.callFunction(factory, ctx.undefined, hostLog, ...args));
  for (const h of args) h.dispose();
  factory.dispose();
  hostLog.dispose();
  const start = ctx.getProp(api, 'start');
  const callFn = ctx.getProp(api, 'call');
  api.dispose();

  /** Classifies a failed VM evaluation at load: an interrupt or memory exhaustion. */
  const vmFailure = (err: QuickJSHandle | undefined, fallback: string): GuestFailure => {
    err?.dispose();
    if (interrupted) return failure('timeout', undefined, true);
    return failure('memory_limit', fallback, true);
  };

  /** The engine itself failed (e.g. native stack exhaustion inside QuickJS): its state is no longer trustworthy. */
  const engineFailure = (e: unknown): GuestFailure => {
    if (interrupted) return failure('timeout', undefined, true);
    if (memory.buffer.byteLength >= engine.pages.maximum * 65536) return failure('memory_limit', 'out of memory', true);
    return failure('threw', engineMessage(e), true);
  };

  /**
   * Runs queued promise jobs one at a time, so none starts after the interrupt fired; false once it fired. QuickJS
   * settles a job the interrupt stops as a rejection instead of failing, so the flag is what tells.
   */
  const runJobs = (): boolean => {
    while (rt.hasPendingJob()) {
      const jobs = rt.executePendingJobs(1);
      if (jobs.error) jobs.error.dispose();
      if (interrupted) return false;
    }
    return true;
  };

  /**
   * Runs one prelude entrypoint and then its promise jobs under the current budget, returning its status string.
   * `INTERRUPTED` when the budget's interrupt fired: the engine unwound the policy's stack and stays usable.
   */
  const run = (fn: QuickJSHandle, arg: string | undefined): { status: string } | typeof INTERRUPTED | GuestFailure => {
    let argH: QuickJSHandle | undefined;
    try {
      argH = arg === undefined ? undefined : ctx.newString(arg);
      const r = argH ? ctx.callFunction(fn, ctx.undefined, argH) : ctx.callFunction(fn, ctx.undefined);
      if (r.error) {
        r.error.dispose();
        // The prelude catches every catchable error, so this is the interrupt or memory exhaustion.
        return interrupted ? INTERRUPTED : failure('memory_limit', 'out of memory', true);
      }
      const status = ctx.getString(r.value);
      r.value.dispose();
      // An interrupt inside an async function only rejects its promise and the caller runs on: the flag tells.
      if (!runJobs() || interrupted) return INTERRUPTED;
      return { status };
    } catch (e) {
      return engineFailure(e);
    } finally {
      argH?.dispose();
    }
  };

  /**
   * A call over its CPU budget (spec §11). The interrupt unwound the policy's whole stack (no `catch` or `finally` ran)
   * and left the engine usable, so the instance keeps its state as of that point. Promise jobs still queued run now,
   * to completion, under a fresh budget of the same size, so none is left over to bill to the next call. A call past
   * the wall-clock hang guard, or a drain that overruns as well, kills the instance.
   */
  const overrun = (callBudget: Budget): GuestFailure => {
    if (callBudget.hung()) return failure('timeout', undefined, true);
    const drain = callBudget.fresh();
    budget = { exceeded: () => drain.exceeded() || callBudget.hung() };
    interrupted = false;
    try {
      return failure('timeout', undefined, !runJobs() || callBudget.hung());
    } catch (e) {
      return engineFailure(e);
    } finally {
      budget = null;
    }
  };

  budget = begin();
  const evaluated = (() => {
    try {
      return ctx.evalCode(source, 'policy.js', { type: 'global' });
    } catch (e) {
      return { error: undefined, hostError: e };
    }
  })();
  if ('hostError' in evaluated) return failure('compile', engineMessage(evaluated.hostError), true);
  if (evaluated.error) {
    if (interrupted) return vmFailure(evaluated.error, '');
    const err = evaluated.error;
    const described = describe(ctx, err);
    err.dispose();
    if (described === null) return vmFailure(undefined, 'out of memory');
    return failure(described.name === 'SyntaxError' ? 'compile' : 'threw', described.text, false);
  }
  evaluated.value.dispose();
  const started = run(start, matchDataJson);
  budget = null;
  if ('ok' in started) return started;
  if ('interrupted' in started) return failure('timeout', undefined, true);
  const startFailure = decodeStatus(started.status, true);
  if (startFailure) return startFailure;

  const guest: Guest = {
    call(data, len, callBudget) {
      logs.length = 0;
      interrupted = false;
      const json = new TextDecoder().decode(data.subarray(0, len));
      budget = callBudget;
      const r = run(callFn, json);
      budget = null;
      if ('ok' in r) return { ...r, logs };
      // Also over budget without an interrupt (it polls between bytecodes, not inside one native operation).
      if ('interrupted' in r || callBudget.exceeded()) return { ...overrun(callBudget), logs };
      const s = r.status;
      if (s.charCodeAt(0) === 0x6f /* o */) return { ok: true, out: s.slice(1), logs };
      return { ...(decodeStatus(s, false) ?? failure('threw', 'unexpected sandbox status', true)), logs };
    },
  };
  return started.status.length > 1 ? { ok: true, guest, detail: started.status.slice(1) } : { ok: true, guest };
}

/** Name + message of an exception from evaluating the policy's top level. Runs under the load budget. */
function describe(ctx: QuickJSContext, err: QuickJSHandle): { name: string; text: string } | null {
  try {
    const read = (key: string): string | number | undefined => {
      const h = ctx.getProp(err, key);
      const t = ctx.typeof(h);
      const v = t === 'string' ? ctx.getString(h) : t === 'number' ? ctx.getNumber(h) : undefined;
      h.dispose();
      return v;
    };
    const n = String(read('name') ?? '');
    const m = String(read('message') ?? '');
    const stack = String(read('stack') ?? '');
    const line = read('lineNumber');
    const loc = /policy\.js:\d+:\d+/.exec(stack)?.[0];
    const at = loc ? ` (${loc})` : typeof line === 'number' && line > 0 ? ` (line ${line})` : '';
    if (n !== '' || m !== '') return { name: n, text: truncateUtf8(`${n || 'Error'}: ${m}${at}`, MAX_MESSAGE_BYTES) };
    const str = ctx.typeof(err) === 'string' ? ctx.getString(err) : 'non-Error exception';
    return { name: '', text: truncateUtf8(str, MAX_MESSAGE_BYTES) };
  } catch {
    return null;
  }
}
