/**
 * Prelude parts and status codes shared by both JS policy runtimes: the QuickJS sandbox (guest-js.ts, in the sandbox
 * worker) and the trusted runner (trusted.ts, in the host's thread). Free of engine imports, so the host never loads
 * QuickJS to run a trusted package.
 */
import { failure, type GuestFailure } from './guest.ts';
import { DETERMINISTIC_MATH_SOURCE } from './math.ts';

/**
 * The sandbox PRELUDE's (guest-js.ts) pristine built-in references and deterministic `Math`, shared verbatim with the
 * trusted prelude like the parts below. They rely on the names bound here (`G`, `JSONstringify`, `RealDate`, …) and on
 * the factory's `maxOut`/`maxDepth`/`maxMsg` parameters.
 */
export const PRELUDE_BINDINGS = `  const G = globalThis;
  const JSONparse = JSON.parse, JSONstringify = JSON.stringify, isArray = Array.isArray;
  const getProto = Object.getPrototypeOf, ObjProto = Object.prototype, keys = Object.keys;
  const defineProperty = Object.defineProperty, isFinite = Number.isFinite, imul = Math.imul;
  const StringC = String, construct = Reflect.construct, RealDate = Date, InternalErrorC = InternalError;

  // SPEC §11 Deterministic Math: fdlibm port replaces the engine's approximated functions before any policy code.
  (${DETERMINISTIC_MATH_SOURCE})(Math);`;

/** sfc32 seeded through murmur3's finaliser (the sandbox's one stream; the trusted prelude keeps one per seat). */
export const PRELUDE_MIX = `  const mix = (h) => { h = imul(h ^ (h >>> 16), 0x85ebca6b); h = imul(h ^ (h >>> 13), 0xc2b2ae35); return (h ^ (h >>> 16)) | 0; };`;

export const PRELUDE_DATE = `  // Frozen clock: Date.now() and new Date() always read the epoch.
  const FROZEN = 0;
  const FrozenDate = function Date(...args) {
    if (new.target === undefined) return new RealDate(FROZEN).toString();
    return construct(RealDate, args.length === 0 ? [FROZEN] : args, new.target);
  };
  defineProperty(FrozenDate, 'prototype', { value: RealDate.prototype, writable: false });
  defineProperty(FrozenDate, 'length', { value: 7 });
  FrozenDate.now = function now() { return FROZEN; };
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  defineProperty(RealDate.prototype, 'constructor', { value: FrozenDate, writable: true, configurable: true });
  defineProperty(G, 'Date', { value: FrozenDate, writable: true, configurable: true });`;

export const PRELUDE_FMT = `  const fmt = (v) => {
    if (typeof v === 'string') return v;
    try { const s = JSONstringify(v); if (s !== undefined) return s; } catch {}
    try { return StringC(v); } catch { return '[unprintable]'; }
  };`;

/** Error description and the output check; `plain` is the condition on a prototype `p` that rejects an object. */
export const preludeChecks = (plain: string): string => `  const isOOM = (e) => e === null || (e instanceof InternalErrorC && e.message === 'out of memory');
  const describe = (e) => {
    try {
      if (e !== null && typeof e === 'object' && typeof e.message === 'string') {
        const name = typeof e.name === 'string' ? e.name : 'Error';
        const stack = typeof e.stack === 'string' ? e.stack : '';
        const at = stack.indexOf('(policy.js:');
        const where = at < 0 ? '' : ' ' + stack.slice(at, stack.indexOf(')', at) + 1);
        return (name + ': ' + e.message).slice(0, maxMsg) + where;
      }
      return StringC(e).slice(0, maxMsg);
    } catch { return 'exception could not be converted to a string'; }
  };
  const check = (v, depth) => {
    if (depth > maxDepth) return 'output nested deeper than ' + maxDepth + ' levels';
    switch (typeof v) {
      case 'string': case 'boolean': return '';
      case 'number': return isFinite(v) ? '' : 'output contains a non-finite number';
      case 'object': {
        if (v === null) return '';
        if (isArray(v)) {
          for (let i = 0; i < v.length; i++) { const r = check(v[i], depth + 1); if (r !== '') return r; }
          return '';
        }
        const p = getProto(v);
        if (${plain}) return 'output contains an object that is not a plain object';
        const ks = keys(v);
        for (let i = 0; i < ks.length; i++) { const r = check(v[ks[i]], depth + 1); if (r !== '') return r; }
        return '';
      }
      default: return 'output contains a value of type ' + typeof v;
    }
  };`;

/** A prelude status string as a load or call failure; null for `o` (ok). */
export function decodeStatus(s: string, loading: boolean): GuestFailure | null {
  const tag = s[0];
  const msg = s.slice(1);
  switch (tag) {
    case 'o':
      return null;
    case 'b':
      return failure('bad_output', msg, false);
    case 'e':
      return failure('threw', msg, false);
    case 'x':
      return failure('missing_export', msg, false);
    case 'm':
      return failure('memory_limit', 'out of memory', true);
    default:
      return failure('threw', loading ? 'unexpected sandbox status during load' : 'unexpected sandbox status', true);
  }
}
