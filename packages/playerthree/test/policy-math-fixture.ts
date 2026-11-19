/**
 * Seeded inputs for the deterministic-Math identity tests. The generator is a JS source string evaluated verbatim in
 * Node and inside the QuickJS policy sandbox, so both sides test exactly the same inputs. It uses only integer
 * xorshift, `Math.imul` (exact by specification) and typed-array bit construction, never an approximated function.
 */
import { DETERMINISTIC_MATH_FUNCTIONS } from '../src/policy/math.ts';

export const MATH_FUNCTIONS = DETERMINISTIC_MATH_FUNCTIONS;
export const BINARY_FUNCTIONS: readonly string[] = ['atan2', 'pow', 'hypot'];
/** Inputs (or input pairs) per function. */
export const MATH_INPUTS = 20000;

/**
 * `(function (fnIndex, n, binary) -> Float64Array)`: n inputs (n pairs, interleaved, when binary). The first entries
 * are special values (all special x special combinations for binary functions); the rest cycle through raw bit
 * patterns, every exponent including subnormals, moderate magnitudes, values next to 1, small integers and halves,
 * and neighbours of multiples of pi/2.
 */
export const MATH_INPUTS_SOURCE = String.raw`(function (fnIndex, n, binary) {
  'use strict';
  var s = (0x9e3779b9 ^ Math.imul(fnIndex + 1, 0x85ebca6b)) | 0;
  var next = function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  var F = new Float64Array(1), W = new Uint32Array(F.buffer);
  F[0] = 1;
  var HI = W[1] === 0x3ff00000 ? 1 : 0, LO = 1 - HI;
  var bits = function (hi, lo) { W[HI] = hi; W[LO] = lo; return F[0]; };
  var SPECIAL = [0, -0, 1, -1, Infinity, -Infinity, NaN, 0.5, -0.5, 2, -2, 3, -3, 1e-300, 5e-324, -5e-324,
    2.2250738585072014e-308, 1.7976931348623157e308, -1.7976931348623157e308, 1e22, 1e300, 709.782712893384,
    -745.1332191019411, 1.5707963267948966, 3.141592653589793, 22, 0.1];
  var one = function (mode) {
    var r = next(), sign = (r & 1) << 31, t, k;
    switch (mode) {
      case 0: return bits(next(), next());
      case 1: return bits((sign | ((r >>> 1) % 2047) << 20 | (next() & 0xfffff)) >>> 0, next());
      case 2: return bits((sign | (993 + (r >>> 1) % 43) << 20 | (next() & 0xfffff)) >>> 0, next());
      case 3:
        t = bits(((970 + (r >>> 1) % 53) << 20 | (next() & 0xfffff)) >>> 0, next());
        return (r & 2) ? 1 + t : 1 - t;
      case 4: return ((r >>> 1) % 129 - 64) / ((r & 0x100) ? 1 : 2);
      default:
        k = (r >>> 1) % 4001 - 2000;
        t = k * 1.5707963267948966;
        F[0] = t;
        W[LO] = (W[LO] + (next() & 15) - 8) >>> 0;
        return F[0];
    }
  };
  var out = new Float64Array(binary ? 2 * n : n);
  var ns = SPECIAL.length, i = 0, m;
  if (binary) {
    for (; i < n && i < ns * ns; i++) { out[2 * i] = SPECIAL[i % ns]; out[2 * i + 1] = SPECIAL[(i / ns) | 0]; }
    for (; i < n; i++) { m = i % 6; out[2 * i] = one(m); out[2 * i + 1] = one((m + (i % 5)) % 6); }
  } else {
    for (; i < n && i < ns; i++) out[i] = SPECIAL[i];
    for (; i < n; i++) out[i] = one(i % 6);
  }
  return out;
})`;

/**
 * `(function (v) -> string)`: the 16-hex-digit bit pattern of v, high word first. NaN is canonicalised to
 * 7ff8000000000000: engines may change NaN payloads, and no Math result depends on them.
 */
export const HEX_SOURCE = String.raw`(function () {
  var F = new Float64Array(1), W = new Uint32Array(F.buffer);
  F[0] = 1;
  var HI = W[1] === 0x3ff00000 ? 1 : 0, LO = 1 - HI;
  return function (v) {
    if (v !== v) return '7ff8000000000000';
    F[0] = v;
    return ('0000000' + W[HI].toString(16)).slice(-8) + ('0000000' + W[LO].toString(16)).slice(-8);
  };
})()`;
