/**
 * Trusted runner (spec §11 *Trusted runner*): host-registered first-party policy packages in V8 through `node:vm`,
 * synchronously in the caller's thread. `node:vm` is not a security boundary: only `loadTrustedPolicy` (index.ts)
 * reaches this module, for packages the game itself registered (`GameDefinition.botPackages`).
 *
 * It runs like an in-process bot, not like the sandbox:
 *  - one realm per package for the life of the process, shared by every seat of every match: the package's top level
 *    runs once and its JIT stays warm. Per-seat state lives in the instance the script's global `createPolicy(options)`
 *    returns for each seat (`options`: the seat's bot options, parsed in the realm per seat, or `null`);
 *  - a plain context (`vm.constants.DONT_CONTEXTIFY`), so the policy's global lookups stay on V8's fast paths;
 *  - the observation is the host's own object, passed by reference and never serialised. The output goes through the
 *    sandbox's checks and serialisation inside the realm and is parsed back into host objects;
 *  - no CPU budget, no worker thread. The hang guard is `vm`'s wall-clock `timeout`, whose watchdog thread costs a few
 *    hundred microseconds to arm, so `guardedEach` arms one for a whole batch of calls (a match's think round); a call
 *    made outside any batch arms its own.
 *
 * Determinism is the sandbox's: the realm is trimmed to the QuickJS global set with QuickJS's locale-independent
 * built-ins, and gets the deterministic `Math` and the frozen `Date` (PRELUDE parts shared with guest-js.ts). Each seat
 * has its own sfc32 `Math.random` stream, seeded as the sandbox seeds its one, and its own `log` lines; the prelude
 * switches both to the entering seat on every entry.
 *
 * Not bounded: memory (the realm lives on the host's heap) and unhandled promise rejections, which reach the host
 * process's `unhandledRejection` like a built-in bot's would.
 */
import vm from 'node:vm';
import type { PolicyError, PolicyErrorCode } from '../control.ts';
import type { PolicyLimits } from '../manifest.ts';
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_DEPTH } from './channel.ts';
import { engineMessage } from './guest.ts';
import { decodeStatus, PRELUDE_BINDINGS, PRELUDE_DATE, PRELUDE_FMT, PRELUDE_MIX, preludeChecks } from './prelude.ts';
import { MAX_MESSAGE_BYTES, truncateUtf8 } from './text.ts';
import type { TrustedCallOutcome, TrustedInstance, TrustedLoadResult } from './types.ts';

/** Wall time one guarded region (a batch of trusted calls, a realm's top level, a seat's instantiation) may take. */
export const TRUSTED_HANG_MS = 1000;

/**
 * The global object's own properties in the QuickJS sandbox before the prelude (which adds `log`), in its order.
 * Every other global of the V8 context (`console`, `WebAssembly`, `Atomics`, `Intl`, `Temporal`, …) is deleted.
 */
const QUICKJS_GLOBALS: readonly string[] = [
  'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'InternalError', 'AggregateError',
  'Array', 'Object', 'Function', 'Iterator', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'Infinity', 'NaN', 'undefined', 'eval', 'Number', 'Boolean', 'String',
  'Math', 'Reflect', 'Symbol', 'globalThis', 'BigInt', 'Date', 'RegExp', 'JSON', 'Proxy', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'ArrayBuffer', 'SharedArrayBuffer', 'Uint8ClampedArray', 'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'BigInt64Array', 'BigUint64Array', 'Float16Array', 'Float32Array', 'Float64Array', 'DataView', 'Promise', 'WeakRef',
  'FinalizationRegistry',
];

/**
 * Members of the shared built-ins that V8 has and QuickJS 2025-09-13 lacks, deleted so a package cannot come to
 * depend on them. Kept: `Error.stackTraceLimit` (V8 captures no stack without it) and the non-configurable
 * `Symbol.dispose` / `Symbol.asyncDispose`. QuickJS-only members (`Math.sumPrecise`, `Set.groupBy`,
 * `Function.prototype.fileName`/`lineNumber`/`columnNumber`) are absent here.
 */
const V8_ONLY_MEMBERS: readonly (readonly [string, readonly string[]])[] = [
  ['Error', ['captureStackTrace']],
  ['Array', ['fromAsync']],
  ['BigInt.prototype', ['toLocaleString']],
  ['Date.prototype', ['toTemporalInstant']],
  ['JSON', ['isRawJSON', 'rawJSON']],
  ['RegExp', ['$&', "$'", '$+', '$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$_', '$`', 'input', 'lastMatch', 'lastParen', 'leftContext', 'rightContext']],
  ['Uint8Array', ['fromBase64', 'fromHex']],
  ['Uint8Array.prototype', ['setFromBase64', 'setFromHex', 'toBase64', 'toHex']],
];

/**
 * Realm setup, evaluated first: the QuickJS global set (an `InternalError` constructor like QuickJS's, which the
 * prelude's out-of-memory check names) and QuickJS's locale-independent results for the locale-sensitive built-ins.
 * Returns `describe`, which reads an exception from the package's top level as the sandbox does: `c` (SyntaxError, a
 * compile failure) or `t` (threw), then the text; null when it cannot be read.
 */
const REALM_SETUP = `(function () {
  'use strict';
  const G = globalThis;
  const allowed = ${JSON.stringify(QUICKJS_GLOBALS)};
  const own = Object.getOwnPropertyNames, del = Reflect.deleteProperty, defineProperty = Object.defineProperty;
  const create = Object.create, construct = Reflect.construct, apply = Reflect.apply;
  const exec = RegExp.prototype.exec, StringC = String, ErrorC = Error;
  for (const k of own(G)) if (!allowed.includes(k)) del(G, k);
  for (const [path, names] of ${JSON.stringify(V8_ONLY_MEMBERS)}) {
    let o = G;
    for (const p of path.split('.')) o = o[p];
    for (const n of names) del(o, n);
  }

  // QuickJS has no ICU: its locale methods ignore locales and options. V8's answer with ICU (and its Date strings
  // append the zone's display name), so each is replaced by QuickJS's result, read off quickjs.c.
  const DateP = Date.prototype, StrP = String.prototype;
  const dateToString = DateP.toString, dateToTimeString = DateP.toTimeString, getTime = DateP.getTime;
  const getFullYear = DateP.getFullYear, getMonth = DateP.getMonth, getDate = DateP.getDate;
  const getHours = DateP.getHours, getMinutes = DateP.getMinutes, getSeconds = DateP.getSeconds;
  const numToString = Number.prototype.toString, toUpper = StrP.toUpperCase, toLower = StrP.toLowerCase;
  const normalize = StrP.normalize, lastIndexOf = StrP.lastIndexOf, slice = StrP.slice, charCodeAt = StrP.charCodeAt;
  const isNaNC = Number.isNaN, TypeErrorC = TypeError;
  const install = (o, fns) => { for (const k of own(fns)) defineProperty(o, k, { value: fns[k], writable: true, configurable: true }); };
  // "… GMT-0800 (Pacific Standard Time)" → "… GMT-0800".
  const noZoneName = (s) => { const i = apply(lastIndexOf, s, [' (']); return i < 0 ? s : apply(slice, s, [0, i]); };
  // printf %0<w>d: the sign counts towards the width.
  const pad = (n, w) => { let s = StringC(n < 0 ? -n : n); while (s.length < (n < 0 ? w - 1 : w)) s = '0' + s; return n < 0 ? '-' + s : s; };
  const day = (d) => { const y = apply(getFullYear, d, []); return pad(apply(getMonth, d, []) + 1, 2) + '/' + pad(apply(getDate, d, []), 2) + '/' + pad(y, y < 0 ? 5 : 4); };
  const time = (d) => { const h = apply(getHours, d, []); return pad((h + 11) % 12 + 1, 2) + ':' + pad(apply(getMinutes, d, []), 2) + ':' + pad(apply(getSeconds, d, []), 2) + (h < 12 ? ' AM' : ' PM'); };
  const valid = (d) => !isNaNC(apply(getTime, d, []));
  install(DateP, {
    toString() { return noZoneName(apply(dateToString, this, [])); },
    toTimeString() { return noZoneName(apply(dateToTimeString, this, [])); },
    toLocaleString() { return valid(this) ? day(this) + ', ' + time(this) : 'Invalid Date'; },
    toLocaleDateString() { return valid(this) ? day(this) : 'Invalid Date'; },
    toLocaleTimeString() { return valid(this) ? time(this) : 'Invalid Date'; },
  });
  install(Number.prototype, { toLocaleString() { return apply(numToString, this, []); } });
  install(StrP, {
    // NFC, then the first differing code unit's difference, else -1/0/1 by length.
    localeCompare(that) {
      if (this === undefined || this === null) throw new TypeErrorC('String.prototype.localeCompare called on null or undefined');
      const a = apply(normalize, StringC(this), ['NFC']), b = apply(normalize, StringC(that), ['NFC']);
      const n = a.length < b.length ? a.length : b.length;
      for (let i = 0; i < n; i++) { const d = apply(charCodeAt, a, [i]) - apply(charCodeAt, b, [i]); if (d !== 0) return d; }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    },
    toLocaleUpperCase() { return apply(toUpper, this, []); },
    toLocaleLowerCase() { return apply(toLower, this, []); },
  });

  const InternalError = function InternalError(message) {
    return construct(ErrorC, arguments, new.target === undefined ? InternalError : new.target);
  };
  Object.setPrototypeOf(InternalError, ErrorC);
  const proto = create(ErrorC.prototype);
  defineProperty(proto, 'constructor', { value: InternalError, writable: true, configurable: true });
  defineProperty(proto, 'name', { value: 'InternalError', writable: true, configurable: true });
  defineProperty(proto, 'message', { value: '', writable: true, configurable: true });
  defineProperty(InternalError, 'prototype', { value: proto, writable: false });
  defineProperty(G, 'InternalError', { value: InternalError, writable: true, configurable: true });

  const LOC = /policy\\.js:\\d+:\\d+/;
  return function describe(e) {
    try {
      const read = (k) => { const v = e[k]; return typeof v === 'string' || typeof v === 'number' ? v : undefined; };
      const n = StringC(read('name') ?? ''), m = StringC(read('message') ?? ''), stack = StringC(read('stack') ?? '');
      const loc = apply(exec, LOC, [stack]);
      const at = loc ? ' (' + loc[0] + ')' : '';
      if (n !== '' || m !== '') return (n === 'SyntaxError' ? 'c' : 't') + (n || 'Error') + ': ' + m + at;
      return 't' + (typeof e === 'string' ? e : 'non-Error exception');
    } catch { return null; }
  };
})()`;

/**
 * The realm's prelude, evaluated after the setup and before the package: the sandbox's bindings, deterministic
 * `Math`, frozen `Date`, log formatting and output checks, with per-seat records instead of the sandbox's single
 * stream and log. A record is the seat's `Math.random` state, its log lines and its policy instance; `seat` is the
 * record of the seat whose code runs (the top level's own: seed 0, no log lines). Output may hold the host's plain
 * objects and arrays (taken from the observation) as well as the realm's. Status strings are the sandbox's.
 */
const TRUSTED_PRELUDE = `(function (maxOut, maxDepth, maxMsg, HostObjProto) {
  'use strict';
${PRELUDE_BINDINGS}
  const create = Object.create;

${PRELUDE_MIX}
  const next = (s) => {
    const t = (((s.a + s.b) | 0) + s.d) | 0;
    s.d = (s.d + 1) | 0;
    s.a = s.b ^ (s.b >>> 9);
    s.b = (s.c + (s.c << 3)) | 0;
    s.c = (s.c << 21) | (s.c >>> 11);
    s.c = (s.c + t) | 0;
    return t >>> 0;
  };
  const newSeat = (seedLo, seedHi, maxLines, maxChars) => {
    const s = {
      a: mix(seedLo ^ 0x9e3779b9), b: mix(seedHi ^ 0x243f6a88), c: mix(seedLo ^ 0xb7e15162), d: mix(seedHi ^ 0x6a09e667),
      maxLines, maxChars, lines: 0, logs: create(null), policy: null,
    };
    for (let i = 0; i < 12; i++) next(s);
    return s;
  };
  let seat = newSeat(0, 0, 0, 0);
  defineProperty(Math, 'random', { value: function random() { return next(seat) / 4294967296; }, writable: true, configurable: true });

${PRELUDE_DATE}

${PRELUDE_FMT}
  defineProperty(G, 'log', {
    value: function log(...args) {
      const r = seat;
      if (r.lines >= r.maxLines) return;
      let s = '';
      for (let i = 0; i < args.length && s.length < r.maxChars; i++) s += (i > 0 ? ' ' : '') + fmt(args[i]);
      r.logs[r.lines++] = s.length > r.maxChars ? s.slice(0, r.maxChars) : s;
    },
    writable: true, configurable: true,
  });

${preludeChecks('p !== ObjProto && p !== HostObjProto && p !== null')}

  return {
    seat: newSeat,
    create(s, json, optionsJson) {
      seat = s;
      s.lines = 0;
      try {
        if (typeof createPolicy !== 'function') return 'xpolicy must define a global function createPolicy()';
        const p = createPolicy(JSONparse(optionsJson));
        if (p === null || (typeof p !== 'object' && typeof p !== 'function') || typeof p.think !== 'function') {
          return 'xcreatePolicy() must return an object with a think(obs) method';
        }
        s.policy = p;
        if (typeof p.init === 'function') p.init(JSONparse(json));
        return 'o';
      } catch (e) { return isOOM(e) ? 'm' : 'e' + describe(e); }
    },
    call(s, obs) {
      seat = s;
      s.lines = 0;
      try {
        const p = s.policy;
        if (typeof p.think !== 'function') return 'ethink is not a function';
        const out = p.think(obs);
        if (!isArray(out)) return 'bthink must return an array, got ' + (out === null ? 'null' : typeof out);
        const bad = check(out, 0);
        if (bad !== '') return 'b' + bad;
        const str = JSONstringify(out);
        if (str.length > maxOut) return 'boutput larger than ' + maxOut + ' bytes';
        return 'o' + str;
      } catch (e) { return isOOM(e) ? 'm' : 'e' + describe(e); }
    },
  };
})`;

/** A seat's record in its realm (a realm object: the host only reads its log lines). */
interface SeatRecord {
  readonly lines: number;
  readonly logs: Readonly<Record<number, unknown>>;
}

interface RealmApi {
  seat(seedLo: number, seedHi: number, maxLines: number, maxChars: number): SeatRecord;
  create(s: SeatRecord, matchDataJson: string, optionsJson: string): string;
  call(s: SeatRecord, obs: unknown): string;
}

interface Realm {
  readonly ctx: vm.Context;
  readonly api: RealmApi;
}

/** Realms (or the failure loading one) by package hash; a realm a hang interrupted is dropped (`TrustedSeat.kill`). */
const realms = new Map<string, Realm | PolicyError>();

/** Evaluating any script in a realm drains its microtask queue (`afterEvaluate`): the policy's promise jobs. */
const DRAIN = new vm.Script('void 0', { filename: 'playerthree:drain' });
const TOP_LEVEL = { timeout: TRUSTED_HANG_MS };
const SCRIPT_TIMEOUT = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
const isTimeout = (e: unknown): boolean => e !== null && typeof e === 'object' && 'code' in e && e.code === SCRIPT_TIMEOUT;
const NO_LOGS: readonly string[] = Object.freeze([]);
const TIMEOUT: PolicyError = Object.freeze({ code: 'timeout' });
const DISPOSED: PolicyError = Object.freeze({ code: 'threw', message: 'instance disposed' });

function error(code: PolicyErrorCode, message: string): PolicyError {
  return { code, message: truncateUtf8(message, MAX_MESSAGE_BYTES) };
}

/** Text of a compile error `vm.Script` raised (a host-realm SyntaxError): name, message and line. */
function compileMessage(e: unknown): string {
  if (!(e instanceof Error)) return engineMessage(e);
  const line = /policy\.js:(\d+)/.exec(e.stack ?? '')?.[1];
  return `${e.name}: ${e.message}${line ? ` (policy.js:${line})` : ''}`;
}

/** A fresh realm with `source`'s top level run (its promise jobs included), or the failure that stopped it. */
function openRealm(source: string): Realm | PolicyError {
  // An ordinary global object (no interceptor onto a host sandbox object), no eval/Function from strings, no
  // WebAssembly compilation, its own microtask queue.
  const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: 'playerthree:trusted',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  const describe = vm.runInContext(REALM_SETUP, ctx, { filename: 'playerthree:realm' }) as (e: unknown) => unknown;
  const factory = vm.runInContext(TRUSTED_PRELUDE, ctx, { filename: 'playerthree:prelude' }) as (...args: unknown[]) => RealmApi;
  const api = factory(MAX_OUTPUT_BYTES, MAX_OUTPUT_DEPTH, MAX_MESSAGE_BYTES, Object.prototype);
  let script: vm.Script;
  try {
    script = new vm.Script(source, { filename: 'policy.js' });
  } catch (e) {
    return error('compile', compileMessage(e));
  }
  try {
    script.runInContext(ctx, TOP_LEVEL);
  } catch (e) {
    if (isTimeout(e)) return TIMEOUT;
    const described = describe(e);
    if (typeof described !== 'string') return error('threw', 'exception could not be converted to a string');
    return error(described[0] === 'c' ? 'compile' : 'threw', described.slice(1));
  }
  return { ctx, api };
}

let depth = 0;
/** The seat whose code runs, if any: the one a hang guard that expires now interrupted. */
let current: TrustedSeat | null = null;
let guard: { ctx: vm.Context; slot: { run: (() => void) | undefined }; script: vm.Script } | undefined;
const GUARD_OPTIONS = { timeout: TRUSTED_HANG_MS, displayErrors: false };

/**
 * Runs `fn` under one hang guard (a `vm` timeout of TRUSTED_HANG_MS around it); inside a guard `fn` just runs. False
 * when the guard expired and stopped `fn` wherever it was; `takeHung` then names the trusted call it interrupted.
 */
function runGuarded(fn: () => void): boolean {
  if (depth > 0) {
    fn();
    return true;
  }
  if (!guard) {
    const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY, { name: 'playerthree:guard' });
    guard = { ctx, slot: vm.runInContext('globalThis', ctx) as { run: (() => void) | undefined }, script: new vm.Script('run()', { filename: 'playerthree:guard' }) };
  }
  guard.slot.run = fn;
  depth++;
  try {
    guard.script.runInContext(guard.ctx, GUARD_OPTIONS);
    return true;
  } catch (e) {
    if (isTimeout(e)) return false;
    throw e;
  } finally {
    depth--;
    guard.slot.run = undefined;
  }
}

/** The seat whose call an expired guard interrupted (killed now), or null when it expired outside any trusted call. */
function takeHung(): TrustedSeat | null {
  const hung = current;
  current = null;
  hung?.kill();
  return hung;
}

/**
 * Runs `step(i)` for i = 0 … n − 1 in order, every trusted call inside under one hang guard: the guard's fixed cost
 * is paid once per batch instead of once per call. A trusted call the guard interrupts is killed (its instance answers
 * `timeout` from then on), its step is abandoned, and the batch resumes at the next step under a fresh guard. Throws
 * when the guard expires outside any trusted call (the batch's own host work took TRUSTED_HANG_MS).
 */
export function guardedEach(n: number, step: (i: number) => void): void {
  let i = 0;
  const body = (): void => {
    for (; i < n; i++) step(i);
  };
  while (i < n && !runGuarded(body)) {
    if (takeHung()) i++;
    else if (i < n) throw new Error('playerthree: a trusted hang guard expired outside any trusted call');
  }
}

class TrustedSeat implements TrustedInstance {
  readonly #key: string;
  readonly #limits: PolicyLimits;
  #realm: Realm | null;
  #record: SeatRecord | null;
  #error: PolicyError | null = null;

  constructor(key: string, realm: Realm, record: SeatRecord, limits: PolicyLimits) {
    this.#key = key;
    this.#realm = realm;
    this.#record = record;
    this.#limits = limits;
  }

  get dead(): boolean {
    return this.#error !== null;
  }

  /**
   * `createPolicy(options)` and the instance's `init` for this seat: null, or the failure. Both arguments are JSON
   * text, parsed in the realm into the seat's own objects. The caller guards it.
   */
  create(matchDataJson: string, optionsJson: string): PolicyError | null {
    const f = decodeStatus(this.#enter(matchDataJson, optionsJson), true);
    return f === null ? null : f.message === undefined ? { code: f.code } : { code: f.code, message: f.message };
  }

  call(observation: unknown): TrustedCallOutcome {
    if (this.#error) return { ok: false, error: this.#error, logs: NO_LOGS };
    if (depth > 0) return this.#call(observation);
    let out: TrustedCallOutcome | undefined;
    if (runGuarded(() => (out = this.#call(observation)))) return out!;
    // Expired: interrupting this call, or the host work after it (then the answer stands).
    if (!takeHung() && out) return out;
    this.kill();
    return { ok: false, error: TIMEOUT, logs: NO_LOGS };
  }

  /** Stopped mid-call by the hang guard. Seats already in its realm keep it; later seats get a fresh one. */
  kill(): void {
    if (this.#realm && realms.get(this.#key) === this.#realm) realms.delete(this.#key);
    this.#error = TIMEOUT;
    this.#realm = null;
    this.#record = null;
  }

  dispose(): void {
    this.#error ??= DISPOSED;
    this.#realm = null;
    this.#record = null;
  }

  /**
   * This seat's entry into its realm (`think` with the observation `arg`; with `optionsJson`, instantiation with the
   * match data JSON `arg`), then the promise jobs it queued, with `current` naming the seat throughout.
   */
  #enter(arg: unknown, optionsJson?: string): string {
    const realm = this.#realm!;
    current = this;
    try {
      const status = optionsJson === undefined ? realm.api.call(this.#record!, arg) : realm.api.create(this.#record!, arg as string, optionsJson);
      DRAIN.runInContext(realm.ctx);
      return status;
    } catch (e) {
      // The prelude catches the policy's exceptions; this is the engine failing around it (stack exhaustion).
      return `e${engineMessage(e)}`;
    } finally {
      current = null;
    }
  }

  #call(observation: unknown): TrustedCallOutcome {
    const status = this.#enter(observation);
    const logs = this.#logs();
    if (status.charCodeAt(0) !== 0x6f /* o */) {
      const f = decodeStatus(status, false) ?? { code: 'threw' as const, message: 'unexpected sandbox status', fatal: true };
      const err: PolicyError = f.message === undefined ? { code: f.code } : { code: f.code, message: f.message };
      if (f.fatal) this.#error = err;
      return { ok: false, error: err, logs };
    }
    // UTF-8 is at most 3 bytes per UTF-16 unit: measure only output that could exceed the cap.
    if (status.length > MAX_OUTPUT_BYTES / 3 && Buffer.byteLength(status, 'utf8') - 1 > MAX_OUTPUT_BYTES) {
      return { ok: false, error: { code: 'bad_output', message: `output larger than ${MAX_OUTPUT_BYTES} bytes` }, logs };
    }
    const out = JSON.parse(status.slice(1)) as unknown[];
    const max = this.#limits.maxIntentsPerCall;
    return { ok: true, intents: out.length > max ? out.slice(0, max) : out, dropped: Math.max(0, out.length - max), logs };
  }

  /** The lines this seat logged in its last entry, capped like the sandbox's. */
  #logs(): readonly string[] {
    const record = this.#record;
    const n = record ? Math.min(record.lines, this.#limits.maxLogLines) : 0;
    if (n === 0) return NO_LOGS;
    const logs: string[] = [];
    for (let i = 0; i < n; i++) {
      const line = record!.logs[i];
      if (typeof line === 'string') logs.push(truncateUtf8(line, this.#limits.maxLogLineBytes));
    }
    return logs;
  }
}

/**
 * A seat's instance of the package `key` (its hash) whose composed script is `source`: the package's realm (opened
 * and cached on first use), then the script's `createPolicy(options)` and the instance's `init(matchData)` under a
 * hang guard.
 */
export function instantiateTrusted(key: string, source: string, limits: PolicyLimits, seed: number, matchDataJson: string, optionsJson: string): TrustedLoadResult {
  let realm = realms.get(key);
  if (realm === undefined) {
    realm = openRealm(source);
    realms.set(key, realm);
  }
  if (!('api' in realm)) return { ok: false, error: realm };
  const record = realm.api.seat(seed >>> 0, Math.floor(seed / 4294967296) >>> 0, limits.maxLogLines, limits.maxLogLineBytes);
  const seat = new TrustedSeat(key, realm, record, limits);
  let failed: PolicyError | null | undefined;
  if (!runGuarded(() => (failed = seat.create(matchDataJson, optionsJson)))) {
    if (!takeHung()) seat.kill();
    return { ok: false, error: TIMEOUT };
  }
  if (failed) {
    seat.dispose();
    return { ok: false, error: failed };
  }
  return { ok: true, instance: seat };
}
