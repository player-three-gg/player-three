/**
 * Deterministic `Math` for JS policies (SPEC §11 "Deterministic `Math`"): a pure-JavaScript port of the FreeBSD msun
 * descendants of fdlibm 5.3. Every engine that evaluates this source computes bit-identical results, because it uses
 * only IEEE-754 double `+ - * /`, the native `Math.sqrt` (correctly rounded by specification), comparisons, int32
 * conversions and typed-array bit access. No other native `Math` function is called.
 *
 * The source is ONE self-contained function expression, evaluated verbatim by every policy runtime (the QuickJS
 * prelude, and the Node tests that compare engines): `(function (M) { … })`. Calling it with a `Math`-like object
 * defines the 22 replacements on it as writable, configurable, non-enumerable methods with the native `name` and
 * `length` (method syntax: not constructors, like the natives). It captures `M.sqrt`, `Float64Array`, `Int32Array` and
 * `Object.defineProperty` at install time and touches no prototype at call time, so a policy that later overwrites any
 * of them cannot change these results. It defines no globals.
 *
 * Bit-exactness was verified against the msun C sources compiled with SSE2 doubles and no FP contraction. Ported
 * bug-for-bug: msun's `hypot` reuses a stale high word after rescaling a subnormal `b` (accurate but not ideal), and
 * the result must stay identical to the reference. The source must not contain backticks or `${`: it is embedded in the
 * QuickJS prelude's template literal.
 */
export const DETERMINISTIC_MATH_SOURCE = String.raw`(function (M) {
  'use strict';
  var sqrt = M.sqrt;
  var defineProperty = Object.defineProperty;
  // Captured: hypot allocates per call, after a policy may have reassigned the global.
  var Float64ArrayC = Float64Array;

  // Bit access: F[0] aliases the two int32 words W[HI] (sign, exponent, top 20 mantissa bits) and W[LO].
  // Integer-indexed typed-array access never consults a prototype, so a policy cannot intercept it.
  var F = new Float64Array(1);
  var W = new Int32Array(F.buffer);
  F[0] = 1;
  var HI = W[1] === 0x3ff00000 ? 1 : 0;
  var LO = 1 - HI;
  var words = function (hi, lo) { W[HI] = hi; W[LO] = lo; return F[0]; };

  var two24 = 1.67772160000000000000e+07, twon24 = 5.96046447753906250000e-08;
  var two54 = 1.80143985094819840000e+16;
  var huge = 1.0e300, tiny = 1.0e-300;
  var P2_1023 = words(0x7fe00000, 0), P2_M969 = words(0x03600000, 0);

  // s_scalbn.c (FreeBSD/musl): x * 2^n with a single rounding.
  function scalbn(x, n) {
    var y = x;
    if (n > 1023) {
      y *= P2_1023; n -= 1023;
      if (n > 1023) { y *= P2_1023; n -= 1023; if (n > 1023) n = 1023; }
    } else if (n < -1022) {
      // Keep the final n below -53 to avoid double rounding in the subnormal range.
      y *= P2_M969; n += 969;
      if (n < -1022) { y *= P2_M969; n += 969; if (n < -1022) n = -1022; }
    }
    W[HI] = (0x3ff + n) << 20; W[LO] = 0;
    return y * F[0];
  }

  // floor() of a finite v >= 0, by clearing fraction bits (truncation equals floor for non-negative values).
  function floorNonNeg(v) {
    F[0] = v;
    var e = ((W[HI] >> 20) & 0x7ff) - 0x3ff;
    if (e < 0) return 0;
    if (e < 20) { W[HI] = W[HI] & ~(0x000fffff >> e); W[LO] = 0; }
    else if (e < 52) W[LO] = W[LO] & ~(0xffffffff >>> (e - 20));
    return F[0];
  }

  // ---- k_rem_pio2.c: Payne-Hanek reduction for |x| >= 2^20 * pi/2 (prec 1: jk = 4) ----
  var IPIO2 = new Int32Array([
    0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62,
    0x95993C, 0x439041, 0xFE5163, 0xABDEBB, 0xC561B7, 0x246E3A,
    0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129,
    0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41,
    0x3991D6, 0x398353, 0x39F49C, 0x845F8B, 0xBDF928, 0x3B1FF8,
    0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF,
    0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5,
    0xF17B3D, 0x0739F7, 0x8A5292, 0xEA6BFB, 0x5FB11F, 0x8D5D08,
    0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3,
    0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880,
    0x4D7327, 0x310606, 0x1556CA, 0x73A8C9, 0x60E27B, 0xC08C6B
  ]);
  var PIO2 = new Float64Array([
    1.57079625129699707031e+00, 7.54978941586159635335e-08, 5.39030252995776476554e-15, 3.28200341580791294123e-22,
    1.27065575308067607349e-29, 1.22933308981111328932e-36, 2.73370053816464559624e-44, 2.16741683877804819444e-51
  ]);
  // Scratch state. Never live across a call that can re-enter the port (none of these call user code).
  var TX = new Float64Array(3), Y = new Float64Array(2);
  var IQ = new Int32Array(20), KF = new Float64Array(20), FQ = new Float64Array(20), Q = new Float64Array(20);

  // Reduces the 24-bit chunks TX[0..nx-1] * 2^e0; writes y = Y[0] + Y[1] and returns n mod 8.
  function kernelRemPio2(e0, nx) {
    var jk = 4, jp = 4, jx = nx - 1;
    var jv = ((e0 - 3) / 24) | 0;
    if (jv < 0) jv = 0;
    var q0 = e0 - 24 * (jv + 1);
    var i, j, k, m, n, ih, jz, carry, z, fw;
    j = jv - jx; m = jx + jk;
    for (i = 0; i <= m; i++, j++) KF[i] = j < 0 ? 0 : IPIO2[j];
    for (i = 0; i <= jk; i++) {
      for (j = 0, fw = 0.0; j <= jx; j++) fw += TX[j] * KF[jx + i - j];
      Q[i] = fw;
    }
    jz = jk;
    for (;;) {
      for (i = 0, j = jz, z = Q[jz]; j > 0; i++, j--) {
        fw = (twon24 * z) | 0;
        IQ[i] = (z - two24 * fw) | 0;
        z = Q[j - 1] + fw;
      }
      z = scalbn(z, q0);
      z -= 8.0 * floorNonNeg(z * 0.125);
      n = z | 0;
      z -= n;
      ih = 0;
      if (q0 > 0) {
        i = IQ[jz - 1] >> (24 - q0); n += i;
        IQ[jz - 1] -= i << (24 - q0);
        ih = IQ[jz - 1] >> (23 - q0);
      } else if (q0 === 0) ih = IQ[jz - 1] >> 23;
      else if (z >= 0.5) ih = 2;
      if (ih > 0) {
        n += 1; carry = 0;
        for (i = 0; i < jz; i++) {
          j = IQ[i];
          if (carry === 0) {
            if (j !== 0) { carry = 1; IQ[i] = 0x1000000 - j; }
          } else IQ[i] = 0xffffff - j;
        }
        if (q0 === 1) IQ[jz - 1] &= 0x7fffff;
        else if (q0 === 2) IQ[jz - 1] &= 0x3fffff;
        if (ih === 2) {
          z = 1.0 - z;
          if (carry !== 0) z -= scalbn(1.0, q0);
        }
      }
      if (z === 0) {
        j = 0;
        for (i = jz - 1; i >= jk; i--) j |= IQ[i];
        if (j === 0) {
          for (k = 1; IQ[jk - k] === 0; k++);
          for (i = jz + 1; i <= jz + k; i++) {
            KF[jx + i] = IPIO2[jv + i];
            for (j = 0, fw = 0.0; j <= jx; j++) fw += TX[j] * KF[jx + i - j];
            Q[i] = fw;
          }
          jz += k;
          continue;
        }
      }
      break;
    }
    if (z === 0) {
      jz -= 1; q0 -= 24;
      while (IQ[jz] === 0) { jz--; q0 -= 24; }
    } else {
      z = scalbn(z, -q0);
      if (z >= two24) {
        fw = (twon24 * z) | 0;
        IQ[jz] = (z - two24 * fw) | 0;
        jz += 1; q0 += 24;
        IQ[jz] = fw;
      } else IQ[jz] = z | 0;
    }
    fw = scalbn(1.0, q0);
    for (i = jz; i >= 0; i--) { Q[i] = fw * IQ[i]; fw *= twon24; }
    for (i = jz; i >= 0; i--) {
      for (fw = 0.0, k = 0; k <= jp && k <= jz - i; k++) fw += PIO2[k] * Q[i + k];
      FQ[jz - i] = fw;
    }
    fw = 0.0;
    for (i = jz; i >= 0; i--) fw += FQ[i];
    Y[0] = ih === 0 ? fw : -fw;
    fw = FQ[0] - fw;
    for (i = 1; i <= jz; i++) fw += FQ[i];
    Y[1] = ih === 0 ? fw : -fw;
    return n & 7;
  }

  // ---- e_rem_pio2.c: x - n*pi/2 = Y[0] + Y[1]; returns n. Caller handles |x| <= pi/4. ----
  var invpio2 = 6.36619772367581382433e-01,
    pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11,
    pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21,
    pio2_3 = 2.02226624871116645580e-21, pio2_3t = 8.47842766036889956997e-32;

  function remPio2(x, hx, ix) {
    var z, w, t, r, fn, n, i, j, high, e0, nx;
    var medium = false;
    if (ix <= 0x400f6a7a) {
      if ((ix & 0xfffff) === 0x921fb) medium = true;
      else if (ix <= 0x4002d97c) {
        if (hx > 0) { z = x - pio2_1; Y[0] = z - pio2_1t; Y[1] = (z - Y[0]) - pio2_1t; return 1; }
        z = x + pio2_1; Y[0] = z + pio2_1t; Y[1] = (z - Y[0]) + pio2_1t; return -1;
      } else {
        if (hx > 0) { z = x - 2 * pio2_1; Y[0] = z - 2 * pio2_1t; Y[1] = (z - Y[0]) - 2 * pio2_1t; return 2; }
        z = x + 2 * pio2_1; Y[0] = z + 2 * pio2_1t; Y[1] = (z - Y[0]) + 2 * pio2_1t; return -2;
      }
    } else if (ix <= 0x401c463b) {
      if (ix <= 0x4015fdbc) {
        if (ix === 0x4012d97c) medium = true;
        else if (hx > 0) { z = x - 3 * pio2_1; Y[0] = z - 3 * pio2_1t; Y[1] = (z - Y[0]) - 3 * pio2_1t; return 3; }
        else { z = x + 3 * pio2_1; Y[0] = z + 3 * pio2_1t; Y[1] = (z - Y[0]) + 3 * pio2_1t; return -3; }
      } else {
        if (ix === 0x401921fb) medium = true;
        else if (hx > 0) { z = x - 4 * pio2_1; Y[0] = z - 4 * pio2_1t; Y[1] = (z - Y[0]) - 4 * pio2_1t; return 4; }
        else { z = x + 4 * pio2_1; Y[0] = z + 4 * pio2_1t; Y[1] = (z - Y[0]) + 4 * pio2_1t; return -4; }
      }
    }
    if (medium || ix < 0x413921fb) {
      // rnint: round to nearest via the 1.5 * 2^52 shifter; |x * 2/pi| < 2^20.
      fn = (x * invpio2 + 6755399441055744.0) - 6755399441055744.0;
      n = fn | 0;
      r = x - fn * pio2_1;
      w = fn * pio2_1t;
      j = ix >> 20;
      Y[0] = r - w;
      F[0] = Y[0]; high = W[HI];
      i = j - ((high >> 20) & 0x7ff);
      if (i > 16) {
        t = r;
        w = fn * pio2_2;
        r = t - w;
        w = fn * pio2_2t - ((t - r) - w);
        Y[0] = r - w;
        F[0] = Y[0]; high = W[HI];
        i = j - ((high >> 20) & 0x7ff);
        if (i > 49) {
          t = r;
          w = fn * pio2_3;
          r = t - w;
          w = fn * pio2_3t - ((t - r) - w);
          Y[0] = r - w;
        }
      }
      Y[1] = (r - Y[0]) - w;
      return n;
    }
    if (ix >= 0x7ff00000) { Y[0] = Y[1] = x - x; return 0; }
    // z = scalbn(|x|, -e0) with e0 = ilogb(|x|) - 23, cut into three 24-bit chunks.
    e0 = (ix >> 20) - 1046;
    F[0] = x; W[HI] = ix - (e0 << 20); z = F[0];
    for (i = 0; i < 2; i++) { TX[i] = z | 0; z = (z - TX[i]) * two24; }
    TX[2] = z;
    nx = 3;
    while (TX[nx - 1] === 0) nx--;
    n = kernelRemPio2(e0, nx);
    if (hx < 0) { Y[0] = -Y[0]; Y[1] = -Y[1]; return -n; }
    return n;
  }

  // ---- k_sin.c, k_cos.c, k_tan.c: kernels on [-pi/4, pi/4], x + y the reduced argument ----
  var S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
    S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  function kernelSin(x, y, iy) {
    var z = x * x, w = z * z;
    var r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
    var v = z * x;
    if (iy === 0) return x + v * (S1 + z * r);
    return x - ((z * (0.5 * y - v * r) - y) - v * S1);
  }
  var C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
    C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
  function kernelCos(x, y) {
    var z = x * x, w = z * z;
    var r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
    var hz = 0.5 * z;
    w = 1.0 - hz;
    return w + (((1.0 - w) - hz) + (z * r - x * y));
  }
  var T = new Float64Array([
    3.33333333333334091986e-01, 1.33333333333201242699e-01, 5.39682539762260521377e-02, 2.18694882948595424599e-02,
    8.86323982359930005737e-03, 3.59207910759131235356e-03, 1.45620945432529025516e-03, 5.88041240820264096874e-04,
    2.46463134818469906812e-04, 7.81794442939557092300e-05, 7.14072491382608190305e-05, -1.85586374855275456654e-05,
    2.59073051863633712884e-05
  ]);
  var pio4 = 7.85398163397448278999e-01, pio4lo = 3.06161699786838301793e-17;
  function kernelTan(x, y, iy) {
    var z, r, v, w, s, a, t;
    F[0] = x;
    var hx = W[HI], ix = hx & 0x7fffffff;
    if (ix >= 0x3FE59428) {
      if (hx < 0) { x = -x; y = -y; }
      z = pio4 - x;
      w = pio4lo - y;
      x = z + w;
      y = 0.0;
    }
    z = x * x;
    w = z * z;
    r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
    v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
    s = z * x;
    r = y + z * (s * (r + v) + y);
    r += T[0] * s;
    w = x + r;
    if (ix >= 0x3FE59428) {
      v = iy;
      return (1 - ((hx >> 30) & 2)) * (v - 2.0 * (x - (w * w / (w + v) - r)));
    }
    if (iy === 1) return w;
    // -1/(x+r) computed accurately.
    F[0] = w; W[LO] = 0; z = F[0];
    v = r - (z - x);
    t = a = -1.0 / w;
    F[0] = t; W[LO] = 0; t = F[0];
    s = 1.0 + t * z;
    return t + a * (s + t * v);
  }

  // ---- e_asin.c / e_acos.c shared rational approximation ----
  var pio2_hi = 1.57079632679489655800e+00, pio2_lo = 6.12323399573676603587e-17, pio4_hi = 7.85398163397448278999e-01,
    pS0 = 1.66666666666666657415e-01, pS1 = -3.25565818622400915405e-01, pS2 = 2.01212532134862925881e-01,
    pS3 = -4.00555345006794114027e-02, pS4 = 7.91534994289814532176e-04, pS5 = 3.47933107596021167570e-05,
    qS1 = -2.40339491173441421878e+00, qS2 = 2.02094576023350569471e+00, qS3 = -6.88283971605453293030e-01,
    qS4 = 7.70381505559019352791e-02, pi = 3.14159265358979311600e+00;

  // ---- s_atan.c tables ----
  var ATANHI = new Float64Array([4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00]);
  var ATANLO = new Float64Array([2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]);
  var AT = new Float64Array([
    3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
    9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
    4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02
  ]);
  var pi_o_4 = 7.8539816339744827900e-01, pi_o_2 = 1.5707963267948965580e+00, pi_lo = 1.2246467991473531772e-16;

  // ---- e_exp.c / s_expm1.c ----
  var o_threshold = 7.09782712893383973096e+02, u_threshold = -7.45133219101941108420e+02,
    ln2_hi = 6.93147180369123816490e-01, ln2_lo = 1.90821492927058770002e-10, invln2 = 1.44269504088896338700e+00,
    P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05,
    P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08,
    twom1000 = 9.33263618503218878990e-302,
    Q1 = -3.33333333333331316428e-02, Q2 = 1.58730158725481460165e-03, Q3 = -7.93650757867487942473e-05,
    Q4 = 4.00821782732936239552e-06, Q5 = -2.01099218183624371326e-07;

  // ---- e_log.c, s_log1p.c, k_log.h ----
  var Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01, Lg3 = 2.857142874366239149e-01,
    Lg4 = 2.222219843214978396e-01, Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01,
    Lg7 = 1.479819860511658591e-01, ln2 = 6.93147180559945286227e-01;
  function kLog1p(f) {
    var s = f / (2.0 + f), z = s * s, w = z * z;
    var t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
    var t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    var R = t2 + t1;
    var hfsq = 0.5 * f * f;
    return s * (hfsq + R);
  }

  // ---- k_exp.c: exp(x) * 2^expt without intermediate overflow, for sinh/cosh near the overflow threshold ----
  var kln2 = 1246.97177782734161156;
  function ldexpExp(x, expt) {
    var e = exp(x - kln2);
    F[0] = e;
    var hx = W[HI];
    expt += (hx >> 20) - (0x3ff + 1023) + 1799;
    W[HI] = (hx & 0xfffff) | ((0x3ff + 1023) << 20);
    e = F[0];
    return e * words((0x3ff + expt) << 20, 0);
  }

  // ---- e_pow.c ----
  var BP = new Float64Array([1.0, 1.5]), DP_H = new Float64Array([0.0, 5.84962487220764160156e-01]),
    DP_L = new Float64Array([0.0, 1.35003920212974897128e-08]),
    two53 = 9007199254740992.0, thrd = 3.3333333333333331e-01,
    L1 = 5.99999999999994648725e-01, L2 = 4.28571428578550184252e-01, L3 = 3.33333329818377432918e-01,
    L4 = 2.72728123808534006489e-01, L5 = 2.30660745775561754067e-01, L6 = 2.06975017800338417784e-01,
    lg2 = 6.93147180559945286227e-01, lg2_h = 6.93147182464599609375e-01, lg2_l = -1.90465429995776804525e-09,
    ovt = 8.0085662595372944372e-17, cp = 9.61796693925975554329e-01, cp_h = 9.61796700954437255859e-01,
    cp_l = -7.02846165095275826516e-09, ivln2 = 1.44269504088896338700e+00, ivln2_h = 1.44269502162933349609e+00,
    ivln2_l = 1.92596299112661746887e-08;

  // ---- e_hypot.c, binary, for finite or +-Infinity arguments (the ES special cases run first) ----
  function hypot2(x, y) {
    var a, b, t1, t2, y1, y2, w, j, k, ha, hb;
    F[0] = x; ha = W[HI] & 0x7fffffff;
    F[0] = y; hb = W[HI] & 0x7fffffff;
    if (hb > ha) { a = y; b = x; j = ha; ha = hb; hb = j; } else { a = x; b = y; }
    F[0] = a; W[HI] = W[HI] & 0x7fffffff; a = F[0];
    F[0] = b; W[HI] = W[HI] & 0x7fffffff; b = F[0];
    if ((ha - hb) > 0x3c00000) return a + b; // a/b > 2^60
    k = 0;
    if (ha > 0x5f300000) { // a > 2^500
      if (ha >= 0x7ff00000) {
        w = a - b;
        F[0] = a; if (((ha & 0xfffff) | W[LO]) === 0) w = a;
        F[0] = b; if (((hb ^ 0x7ff00000) | W[LO]) === 0) w = b;
        return w;
      }
      ha -= 0x25800000; hb -= 0x25800000; k += 600;
      F[0] = a; W[HI] = ha; a = F[0];
      F[0] = b; W[HI] = hb; b = F[0];
    }
    if (hb < 0x20b00000) { // b < 2^-500
      if (hb <= 0x000fffff) { // subnormal b or 0
        F[0] = b;
        if ((hb | W[LO]) === 0) return a;
        t1 = words(0x7fd00000, 0); // 2^1022
        b *= t1;
        a *= t1;
        k -= 1022;
      } else {
        ha += 0x25800000; hb += 0x25800000; k -= 600;
        F[0] = a; W[HI] = ha; a = F[0];
        F[0] = b; W[HI] = hb; b = F[0];
      }
    }
    w = a - b;
    if (w > b) {
      t1 = words(ha, 0);
      t2 = a - t1;
      w = sqrt(t1 * t1 - (b * (-b) - t2 * (a + t1)));
    } else {
      a = a + a;
      y1 = words(hb, 0);
      y2 = b - y1;
      t1 = words(ha + 0x00100000, 0);
      t2 = a - t1;
      w = sqrt(t1 * y1 - (w * (-w) - (t1 * y2 + t2 * b)));
    }
    if (k !== 0) return words((1023 + k) << 20, 0) * w;
    return w;
  }

  var B1 = 715094163, B2 = 696219795,
    CP0 = 1.87595182427177009643, CP1 = -1.88497979543377169875, CP2 = 1.621429720105354466140,
    CP3 = -0.758397934778766047437, CP4 = 0.145996192886612446982;
  var ivln2hi = 1.44269504072144627571e+00, ivln2lo = 1.67517131648865118353e-10,
    ivln10hi = 4.34294481878168880939e-01, ivln10lo = 2.50829467116452752298e-11,
    log10_2hi = 3.01029995663611771306e-01, log10_2lo = 3.69423907715893078616e-13;

  // Method syntax gives each function the native name and length and makes it a non-constructor.
  // Each begins with exactly one ToNumber per argument, in order.
  var D = {
    // ---- s_sin.c, s_cos.c, s_tan.c ----
    sin(x) {
      x = +x;
      F[0] = x;
      var hx = W[HI], ix = hx & 0x7fffffff;
      if (ix <= 0x3fe921fb) {
        if (ix < 0x3e500000) return x; // |x| < 2^-26
        return kernelSin(x, 0.0, 0);
      }
      if (ix >= 0x7ff00000) return x - x;
      switch (remPio2(x, hx, ix) & 3) {
        case 0: return kernelSin(Y[0], Y[1], 1);
        case 1: return kernelCos(Y[0], Y[1]);
        case 2: return -kernelSin(Y[0], Y[1], 1);
        default: return -kernelCos(Y[0], Y[1]);
      }
    },
    cos(x) {
      x = +x;
      F[0] = x;
      var hx = W[HI], ix = hx & 0x7fffffff;
      if (ix <= 0x3fe921fb) {
        if (ix < 0x3e46a09e) return 1.0; // |x| < 2^-27 * sqrt(2)
        return kernelCos(x, 0.0);
      }
      if (ix >= 0x7ff00000) return x - x;
      switch (remPio2(x, hx, ix) & 3) {
        case 0: return kernelCos(Y[0], Y[1]);
        case 1: return -kernelSin(Y[0], Y[1], 1);
        case 2: return -kernelCos(Y[0], Y[1]);
        default: return kernelSin(Y[0], Y[1], 1);
      }
    },
    tan(x) {
      x = +x;
      F[0] = x;
      var hx = W[HI], ix = hx & 0x7fffffff;
      if (ix <= 0x3fe921fb) {
        if (ix < 0x3e400000) return x; // |x| < 2^-27
        return kernelTan(x, 0.0, 1);
      }
      if (ix >= 0x7ff00000) return x - x;
      var n = remPio2(x, hx, ix);
      return kernelTan(Y[0], Y[1], 1 - ((n & 1) << 1));
    },
    // ---- e_asin.c ----
    asin(x) {
      x = +x;
      var t, w, p, q, c, r, s;
      F[0] = x;
      var hx = W[HI], ix = hx & 0x7fffffff;
      if (ix >= 0x3ff00000) {
        if (((ix - 0x3ff00000) | W[LO]) === 0) return x * pio2_hi + x * pio2_lo;
        return (x - x) / (x - x);
      } else if (ix < 0x3fe00000) {
        if (ix < 0x3e500000) return x; // |x| < 2^-26
        t = x * x;
        p = t * (pS0 + t * (pS1 + t * (pS2 + t * (pS3 + t * (pS4 + t * pS5)))));
        q = 1.0 + t * (qS1 + t * (qS2 + t * (qS3 + t * qS4)));
        w = p / q;
        return x + x * w;
      }
      w = 1.0 - (x < 0 ? -x : x);
      t = w * 0.5;
      p = t * (pS0 + t * (pS1 + t * (pS2 + t * (pS3 + t * (pS4 + t * pS5)))));
      q = 1.0 + t * (qS1 + t * (qS2 + t * (qS3 + t * qS4)));
      s = sqrt(t);
      if (ix >= 0x3FEF3333) { // |x| > 0.975
        w = p / q;
        t = pio2_hi - (2.0 * (s + s * w) - pio2_lo);
      } else {
        F[0] = s; W[LO] = 0; w = F[0];
        c = (t - w * w) / (s + w);
        r = p / q;
        p = 2.0 * s * r - (pio2_lo - 2.0 * c);
        q = pio4_hi - 2.0 * w;
        t = pio4_hi - (p - q);
      }
      return hx > 0 ? t : -t;
    },
    // ---- e_acos.c ----
    acos(x) {
      x = +x;
      var z, p, q, r, w, s, c, df;
      F[0] = x;
      var hx = W[HI], ix = hx & 0x7fffffff;
      if (ix >= 0x3ff00000) {
        if (((ix - 0x3ff00000) | W[LO]) === 0) return hx > 0 ? 0.0 : pi + 2.0 * pio2_lo;
        return (x - x) / (x - x);
      }
      if (ix < 0x3fe00000) {
        if (ix <= 0x3c600000) return pio2_hi + pio2_lo; // |x| < 2^-57
        z = x * x;
        p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
        q = 1.0 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
        r = p / q;
        return pio2_hi - (x - (pio2_lo - x * r));
      } else if (hx < 0) {
        z = (1.0 + x) * 0.5;
        p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
        q = 1.0 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
        s = sqrt(z);
        r = p / q;
        w = r * s - pio2_lo;
        return pi - 2.0 * (s + w);
      }
      z = (1.0 - x) * 0.5;
      s = sqrt(z);
      F[0] = s; W[LO] = 0; df = F[0];
      c = (z - df * df) / (s + df);
      p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
      q = 1.0 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
      r = p / q;
      w = r * s + c;
      return 2.0 * (df + w);
    },
    // ---- s_atan.c ----
    atan(x) {
      x = +x;
      var w, s1, s2, z, id;
      F[0] = x;
      var hx = W[HI], ix = hx & 0x7fffffff;
      if (ix >= 0x44100000) { // |x| >= 2^66
        if (ix > 0x7ff00000 || (ix === 0x7ff00000 && W[LO] !== 0)) return x + x;
        return hx > 0 ? ATANHI[3] + ATANLO[3] : -ATANHI[3] - ATANLO[3];
      }
      if (ix < 0x3fdc0000) { // |x| < 0.4375
        if (ix < 0x3e400000) return x; // |x| < 2^-27
        id = -1;
      } else {
        x = x < 0 ? -x : x;
        if (ix < 0x3ff30000) {
          if (ix < 0x3fe60000) { id = 0; x = (2.0 * x - 1.0) / (2.0 + x); }
          else { id = 1; x = (x - 1.0) / (x + 1.0); }
        } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1.0 + 1.5 * x); }
        else { id = 3; x = -1.0 / x; }
      }
      z = x * x;
      w = z * z;
      s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
      s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
      if (id < 0) return x - x * (s1 + s2);
      z = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
      return hx < 0 ? -z : z;
    },
    // ---- e_atan2.c ----
    atan2(y, x) {
      y = +y;
      x = +x;
      if (x !== x || y !== y) return x + y;
      var z, q;
      F[0] = x;
      var hx = W[HI], lx = W[LO], ix = hx & 0x7fffffff;
      F[0] = y;
      var hy = W[HI], ly = W[LO], iy = hy & 0x7fffffff;
      if (hx === 0x3ff00000 && lx === 0) return atan(y); // x = 1
      var m = ((hy >> 31) & 1) | ((hx >> 30) & 2); // 2*sign(x) + sign(y)
      if ((iy | ly) === 0) {
        switch (m) {
          case 0: case 1: return y;
          case 2: return pi + tiny;
          default: return -pi - tiny;
        }
      }
      if ((ix | lx) === 0) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;
      if (ix === 0x7ff00000) {
        if (iy === 0x7ff00000) {
          switch (m) {
            case 0: return pi_o_4 + tiny;
            case 1: return -pi_o_4 - tiny;
            case 2: return 3.0 * pi_o_4 + tiny;
            default: return -3.0 * pi_o_4 - tiny;
          }
        }
        switch (m) {
          case 0: return 0.0;
          case 1: return -0.0;
          case 2: return pi + tiny;
          default: return -pi - tiny;
        }
      }
      if (iy === 0x7ff00000) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;
      var k = (iy - ix) >> 20;
      if (k > 60) { // |y/x| > 2^60
        z = pi_o_2 + 0.5 * pi_lo;
        m &= 1;
      } else if (hx < 0 && k < -60) z = 0.0;
      else { q = y / x; z = atan(q <= 0 ? 0 - q : q); } // fabs, including -0 -> +0
      switch (m) {
        case 0: return z;
        case 1: return -z;
        case 2: return pi - (z - pi_lo);
        default: return (z - pi_lo) - pi;
      }
    },
    // ---- e_sinh.c ----
    sinh(x) {
      x = +x;
      var t, h, ax;
      F[0] = x;
      var jx = W[HI], ix = jx & 0x7fffffff;
      if (ix >= 0x7ff00000) return x + x;
      h = jx < 0 ? -0.5 : 0.5;
      ax = x < 0 ? -x : x;
      if (ix < 0x40360000) { // |x| < 22
        if (ix < 0x3e300000) return x; // |x| < 2^-28
        t = expm1(ax);
        if (ix < 0x3ff00000) return h * (2.0 * t - t * t / (t + 1.0));
        return h * (t + t / (t + 1.0));
      }
      if (ix < 0x40862E42) return h * exp(ax);
      if (ix <= 0x408633CE) return h * 2.0 * ldexpExp(ax, -1);
      return x * 1.0e307;
    },
    // ---- e_cosh.c ----
    cosh(x) {
      x = +x;
      var t, w;
      F[0] = x;
      var ix = W[HI] & 0x7fffffff;
      if (ix >= 0x7ff00000) return x * x;
      var ax = x <= 0 ? 0 - x : x;
      if (ix < 0x3fd62e43) {
        t = expm1(ax);
        w = 1.0 + t;
        if (ix < 0x3c800000) return w;
        return 1.0 + (t * t) / (w + w);
      }
      if (ix < 0x40360000) {
        t = exp(ax);
        return 0.5 * t + 0.5 / t;
      }
      if (ix < 0x40862E42) return 0.5 * exp(ax);
      if (ix <= 0x408633CE) return ldexpExp(ax, -1);
      return huge * huge;
    },
    // ---- s_tanh.c ----
    tanh(x) {
      x = +x;
      var t, z;
      F[0] = x;
      var jx = W[HI], ix = jx & 0x7fffffff;
      if (ix >= 0x7ff00000) return jx >= 0 ? 1.0 / x + 1.0 : 1.0 / x - 1.0;
      if (ix < 0x40360000) { // |x| < 22
        if (ix < 0x3e300000) return x; // |x| < 2^-28
        if (ix >= 0x3ff00000) {
          t = expm1(2.0 * (x < 0 ? -x : x));
          z = 1.0 - 2.0 / (t + 2.0);
        } else {
          t = expm1(-2.0 * (x < 0 ? -x : x));
          z = -t / (t + 2.0);
        }
      } else z = 1.0 - tiny;
      return jx >= 0 ? z : -z;
    },
    // ---- s_asinh.c ----
    asinh(x) {
      x = +x;
      var t, w;
      F[0] = x;
      var hx = W[HI], ix = hx & 0x7fffffff;
      if (ix >= 0x7ff00000) return x + x;
      if (ix < 0x3e300000) return x; // |x| < 2^-28
      if (ix > 0x41b00000) { // |x| > 2^28
        w = log(x < 0 ? -x : x) + ln2;
      } else if (ix > 0x40000000) { // 2 < |x| <= 2^28
        t = x < 0 ? -x : x;
        w = log(2.0 * t + 1.0 / (sqrt(x * x + 1.0) + t));
      } else {
        t = x * x;
        w = log1p((x < 0 ? -x : x) + t / (1.0 + sqrt(1.0 + t)));
      }
      return hx > 0 ? w : -w;
    },
    // ---- e_acosh.c ----
    acosh(x) {
      x = +x;
      var t;
      F[0] = x;
      var hx = W[HI], lx = W[LO];
      if (hx < 0x3ff00000) return (x - x) / (x - x);
      if (hx >= 0x41b00000) {
        if (hx >= 0x7ff00000) return x + x;
        return log(x) + ln2;
      }
      if (((hx - 0x3ff00000) | lx) === 0) return 0.0;
      if (hx > 0x40000000) {
        t = x * x;
        return log(2.0 * x - 1.0 / (x + sqrt(t - 1.0)));
      }
      t = x - 1.0;
      return log1p(t + sqrt(2.0 * t + t * t));
    },
    // ---- e_atanh.c ----
    atanh(x) {
      x = +x;
      var t;
      F[0] = x;
      var hx = W[HI], lx = W[LO], ix = hx & 0x7fffffff;
      if (ix > 0x3ff00000 || (ix === 0x3ff00000 && lx !== 0)) return (x - x) / (x - x); // |x| > 1 or NaN
      if (ix === 0x3ff00000) return x / 0.0;
      if (ix < 0x3e300000) return x; // |x| < 2^-28
      W[HI] = ix; x = F[0]; // |x|
      if (ix < 0x3fe00000) {
        t = x + x;
        t = 0.5 * log1p(t + t * x / (1.0 - x));
      } else t = 0.5 * log1p((x + x) / (1.0 - x));
      return hx >= 0 ? t : -t;
    },
    // ---- e_exp.c ----
    exp(x) {
      x = +x;
      var y, hi = 0.0, lo = 0.0, c, t, twopk, k = 0;
      F[0] = x;
      var hx = W[HI];
      var xsb = hx >>> 31;
      hx &= 0x7fffffff;
      if (hx >= 0x40862E42) { // |x| >= 709.78...
        if (hx >= 0x7ff00000) {
          if (((hx & 0xfffff) | W[LO]) !== 0) return x + x;
          return xsb === 0 ? x : 0.0;
        }
        if (x > o_threshold) return huge * huge;
        if (x < u_threshold) return twom1000 * twom1000;
      }
      if (hx > 0x3fd62e42) { // |x| > 0.5 ln2
        if (hx < 0x3FF0A2B2) { // and |x| < 1.5 ln2
          if (xsb === 0) { hi = x - ln2_hi; lo = ln2_lo; k = 1; }
          else { hi = x + ln2_hi; lo = -ln2_lo; k = -1; }
        } else {
          k = (invln2 * x + (xsb === 0 ? 0.5 : -0.5)) | 0;
          t = k;
          hi = x - t * ln2_hi;
          lo = t * ln2_lo;
        }
        x = hi - lo;
      } else if (hx < 0x3e300000) { // |x| < 2^-28
        return 1.0 + x;
      } else k = 0;
      t = x * x;
      if (k >= -1021) twopk = words((0x3ff + k) << 20, 0);
      else twopk = words((0x3ff + (k + 1000)) << 20, 0);
      c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
      if (k === 0) return 1.0 - ((x * c) / (c - 2.0) - x);
      y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
      if (k >= -1021) {
        if (k === 1024) return y * 2.0 * P2_1023;
        return y * twopk;
      }
      return y * twopk * twom1000;
    },
    // ---- s_expm1.c ----
    expm1(x) {
      x = +x;
      var y, hi, lo, c = 0.0, t, e, hxs, hfx, r1, twopk, k;
      F[0] = x;
      var hx = W[HI];
      var xsb = hx & 0x80000000;
      hx &= 0x7fffffff;
      if (hx >= 0x4043687A) { // |x| >= 56 ln2
        if (hx >= 0x40862E42) { // |x| >= 709.78...
          if (hx >= 0x7ff00000) {
            if (((hx & 0xfffff) | W[LO]) !== 0) return x + x;
            return xsb === 0 ? x : -1.0;
          }
          if (x > o_threshold) return huge * huge;
        }
        if (xsb !== 0 && x + tiny < 0.0) return tiny - 1.0;
      }
      if (hx > 0x3fd62e42) { // |x| > 0.5 ln2
        if (hx < 0x3FF0A2B2) { // and |x| < 1.5 ln2
          if (xsb === 0) { hi = x - ln2_hi; lo = ln2_lo; k = 1; }
          else { hi = x + ln2_hi; lo = -ln2_lo; k = -1; }
        } else {
          k = (invln2 * x + (xsb === 0 ? 0.5 : -0.5)) | 0;
          t = k;
          hi = x - t * ln2_hi;
          lo = t * ln2_lo;
        }
        x = hi - lo;
        c = (hi - x) - lo;
      } else if (hx < 0x3c900000) { // |x| < 2^-54
        return x;
      } else k = 0;
      hfx = 0.5 * x;
      hxs = x * hfx;
      r1 = 1.0 + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
      t = 3.0 - r1 * hfx;
      e = hxs * ((r1 - t) / (6.0 - x * t));
      if (k === 0) return x - (x * e - hxs);
      twopk = words((0x3ff + k) << 20, 0);
      e = (x * (e - c) - c);
      e -= hxs;
      if (k === -1) return 0.5 * (x - e) - 0.5;
      if (k === 1) {
        if (x < -0.25) return -2.0 * (e - (x + 0.5));
        return 1.0 + 2.0 * (x - e);
      }
      if (k <= -2 || k > 56) {
        y = 1.0 - (e - x);
        if (k === 1024) y = y * 2.0 * P2_1023;
        else y = y * twopk;
        return y - 1.0;
      }
      if (k < 20) {
        t = words(0x3ff00000 - (0x200000 >> k), 0); // 1 - 2^-k
        y = t - (e - x);
        y = y * twopk;
      } else {
        t = words((0x3ff - k) << 20, 0); // 2^-k
        y = x - (e + t);
        y += 1.0;
        y = y * twopk;
      }
      return y;
    },
    // ---- e_log.c ----
    log(x) {
      x = +x;
      var hfsq, f, s, z, R, w, t1, t2, dk, i, j, k = 0;
      F[0] = x;
      var hx = W[HI], lx = W[LO];
      if (hx < 0x00100000) { // x < 2^-1022
        if (((hx & 0x7fffffff) | lx) === 0) return -two54 / 0.0;
        if (hx < 0) return (x - x) / 0.0;
        k -= 54; x *= two54;
        F[0] = x; hx = W[HI];
      }
      if (hx >= 0x7ff00000) return x + x;
      k += (hx >> 20) - 1023;
      hx &= 0x000fffff;
      i = (hx + 0x95f64) & 0x100000;
      F[0] = x; W[HI] = hx | (i ^ 0x3ff00000); x = F[0]; // normalize x or x/2
      k += i >> 20;
      f = x - 1.0;
      if ((0x000fffff & (2 + hx)) < 3) { // -2^-20 <= f < 2^-20
        if (f === 0.0) {
          if (k === 0) return 0.0;
          dk = k;
          return dk * ln2_hi + dk * ln2_lo;
        }
        R = f * f * (0.5 - 0.33333333333333333 * f);
        if (k === 0) return f - R;
        dk = k;
        return dk * ln2_hi - ((R - dk * ln2_lo) - f);
      }
      s = f / (2.0 + f);
      dk = k;
      z = s * s;
      i = hx - 0x6147a;
      w = z * z;
      j = 0x6b851 - hx;
      t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
      t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
      i |= j;
      R = t2 + t1;
      if (i > 0) {
        hfsq = 0.5 * f * f;
        if (k === 0) return f - (hfsq - s * (hfsq + R));
        return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
      }
      if (k === 0) return f - s * (f - R);
      return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
    },
    // ---- s_log1p.c ----
    log1p(x) {
      x = +x;
      var hfsq, f = 0.0, c = 0.0, s, z, R, u, hu = 0, k = 1;
      F[0] = x;
      var hx = W[HI], ax = hx & 0x7fffffff;
      if (hx < 0x3FDA827A) { // 1 + x < sqrt(2)+
        if (ax >= 0x3ff00000) { // x <= -1
          if (x === -1.0) return -two54 / 0.0;
          return (x - x) / (x - x);
        }
        if (ax < 0x3e200000) { // |x| < 2^-29
          if (ax < 0x3c900000) return x; // |x| < 2^-54
          return x - x * x * 0.5;
        }
        if (hx > 0 || hx <= (0xbfd2bec4 | 0)) { k = 0; f = x; hu = 1; } // sqrt(2)/2- <= 1 + x < sqrt(2)+
      }
      if (hx >= 0x7ff00000) return x + x;
      if (k !== 0) {
        if (hx < 0x43400000) {
          u = 1.0 + x;
          F[0] = u; hu = W[HI];
          k = (hu >> 20) - 1023;
          c = k > 0 ? 1.0 - (u - x) : x - (u - 1.0); // correction term
          c /= u;
        } else {
          u = x;
          F[0] = u; hu = W[HI];
          k = (hu >> 20) - 1023;
          c = 0;
        }
        hu &= 0x000fffff;
        if (hu < 0x6a09e) { // u ~< sqrt(2)
          F[0] = u; W[HI] = hu | 0x3ff00000; u = F[0];
        } else {
          k += 1;
          F[0] = u; W[HI] = hu | 0x3fe00000; u = F[0];
          hu = (0x00100000 - hu) >> 2;
        }
        f = u - 1.0;
      }
      hfsq = 0.5 * f * f;
      if (hu === 0) { // |f| < 2^-20
        if (f === 0.0) {
          if (k === 0) return 0.0;
          c += k * ln2_lo;
          return k * ln2_hi + c;
        }
        R = hfsq * (1.0 - 0.66666666666666666 * f);
        if (k === 0) return f - R;
        return k * ln2_hi - ((R - (k * ln2_lo + c)) - f);
      }
      s = f / (2.0 + f);
      z = s * s;
      R = z * (Lg1 + z * (Lg2 + z * (Lg3 + z * (Lg4 + z * (Lg5 + z * (Lg6 + z * Lg7))))));
      if (k === 0) return f - (hfsq - s * (hfsq + R));
      return k * ln2_hi - ((hfsq - (s * (hfsq + R) + (k * ln2_lo + c))) - f);
    },
    // ---- e_log2.c (k_log.h) ----
    log2(x) {
      x = +x;
      var f, hfsq, hi, lo, r, val_hi, val_lo, w, y, i, k = 0;
      F[0] = x;
      var hx = W[HI], lx = W[LO];
      if (hx < 0x00100000) { // x < 2^-1022
        if (((hx & 0x7fffffff) | lx) === 0) return -two54 / 0.0;
        if (hx < 0) return (x - x) / 0.0;
        k -= 54; x *= two54;
        F[0] = x; hx = W[HI];
      }
      if (hx >= 0x7ff00000) return x + x;
      if (hx === 0x3ff00000 && lx === 0) return 0.0;
      k += (hx >> 20) - 1023;
      hx &= 0x000fffff;
      i = (hx + 0x95f64) & 0x100000;
      F[0] = x; W[HI] = hx | (i ^ 0x3ff00000); x = F[0];
      k += i >> 20;
      y = k;
      f = x - 1.0;
      hfsq = 0.5 * f * f;
      r = kLog1p(f);
      hi = f - hfsq;
      F[0] = hi; W[LO] = 0; hi = F[0];
      lo = (f - hi) - hfsq + r;
      val_hi = hi * ivln2hi;
      val_lo = (lo + hi) * ivln2lo + lo * ivln2hi;
      w = y + val_hi;
      val_lo += (y - w) + val_hi;
      val_hi = w;
      return val_lo + val_hi;
    },
    // ---- e_log10.c (k_log.h) ----
    log10(x) {
      x = +x;
      var f, hfsq, hi, lo, r, val_hi, val_lo, w, y, y2, i, k = 0;
      F[0] = x;
      var hx = W[HI], lx = W[LO];
      if (hx < 0x00100000) { // x < 2^-1022
        if (((hx & 0x7fffffff) | lx) === 0) return -two54 / 0.0;
        if (hx < 0) return (x - x) / 0.0;
        k -= 54; x *= two54;
        F[0] = x; hx = W[HI];
      }
      if (hx >= 0x7ff00000) return x + x;
      if (hx === 0x3ff00000 && lx === 0) return 0.0;
      k += (hx >> 20) - 1023;
      hx &= 0x000fffff;
      i = (hx + 0x95f64) & 0x100000;
      F[0] = x; W[HI] = hx | (i ^ 0x3ff00000); x = F[0];
      k += i >> 20;
      y = k;
      f = x - 1.0;
      hfsq = 0.5 * f * f;
      r = kLog1p(f);
      hi = f - hfsq;
      F[0] = hi; W[LO] = 0; hi = F[0];
      lo = (f - hi) - hfsq + r;
      val_hi = hi * ivln10hi;
      y2 = y * log10_2hi;
      val_lo = y * log10_2lo + (lo + hi) * ivln10lo + lo * ivln10hi;
      w = y2 + val_hi;
      val_lo += (y2 - w) + val_hi;
      val_hi = w;
      return val_lo + val_hi;
    },
    // ---- e_pow.c, after the ECMAScript special cases that differ from C99 ----
    pow(x, y) {
      x = +x;
      y = +y;
      if (y !== y) return NaN;
      if (y === 0) return 1;
      if (x !== x) return NaN;
      if ((x === 1 || x === -1) && (y === Infinity || y === -Infinity)) return NaN;
      var z, ax, z_h, z_l, p_h, p_l, y1, t1, t2, r, s, t, u, v, w, i, j, k, yisint, n;
      var ss, s2, s_h, s_l, t_h, t_l;
      F[0] = x;
      var hx = W[HI], lx = W[LO] >>> 0;
      F[0] = y;
      var hy = W[HI], ly = W[LO] >>> 0;
      var ix = hx & 0x7fffffff, iy = hy & 0x7fffffff;
      if (hx === 0x3ff00000 && lx === 0) return 1.0;
      // yisint: 0 = y not an integer, 1 = odd integer, 2 = even integer (only computed for x < 0).
      yisint = 0;
      if (hx < 0) {
        if (iy >= 0x43400000) yisint = 2;
        else if (iy >= 0x3ff00000) {
          k = (iy >> 20) - 0x3ff;
          if (k > 20) {
            j = ly >>> (52 - k);
            if (((j << (52 - k)) >>> 0) === ly) yisint = 2 - (j & 1);
          } else if (ly === 0) {
            j = iy >> (20 - k);
            if ((j << (20 - k)) === iy) yisint = 2 - (j & 1);
          }
        }
      }
      if (ly === 0) {
        if (iy === 0x7ff00000) { // y is +-inf
          if (ix >= 0x3ff00000) return hy >= 0 ? y : 0.0;
          return hy < 0 ? -y : 0.0;
        }
        if (iy === 0x3ff00000) return hy < 0 ? 1.0 / x : x;
        if (hy === 0x40000000) return x * x;
        if (hy === 0x3fe00000 && hx >= 0) return sqrt(x);
      }
      ax = hx < 0 ? -x : x; // fabs, including -0 -> +0
      if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) { // x is +-0, +-inf, +-1
        z = ax;
        if (hy < 0) z = 1.0 / z;
        if (hx < 0) {
          if (((ix - 0x3ff00000) | yisint) === 0) z = (z - z) / (z - z); // (-1)**non-int
          else if (yisint === 1) z = -z;
        }
        return z;
      }
      n = (hx >>> 31) - 1; // 0 when x < 0
      if ((n | yisint) === 0) return (x - x) / (x - x); // (x<0)**(non-int)
      s = 1.0;
      if ((n | (yisint - 1)) === 0) s = -1.0; // (-ve)**(odd int)
      if (iy > 0x41e00000) { // |y| > 2^31
        if (iy > 0x43f00000) { // |y| > 2^64: must over/underflow
          if (ix <= 0x3fefffff) return hy < 0 ? huge * huge : tiny * tiny;
          if (ix >= 0x3ff00000) return hy > 0 ? huge * huge : tiny * tiny;
        }
        if (ix < 0x3fefffff) return hy < 0 ? s * huge * huge : s * tiny * tiny;
        if (ix > 0x3ff00000) return hy > 0 ? s * huge * huge : s * tiny * tiny;
        // |1 - x| <= 2^-20: log(x) by x - x^2/2 + x^3/3 - x^4/4.
        t = ax - 1.0;
        w = (t * t) * (0.5 - t * (thrd - t * 0.25));
        u = ivln2_h * t;
        v = t * ivln2_l - w * ivln2;
        t1 = u + v;
        F[0] = t1; W[LO] = 0; t1 = F[0];
        t2 = v - (t1 - u);
      } else {
        n = 0;
        if (ix < 0x00100000) { ax *= two53; n -= 53; F[0] = ax; ix = W[HI]; } // subnormal x
        n += (ix >> 20) - 0x3ff;
        j = ix & 0x000fffff;
        ix = j | 0x3ff00000;
        if (j <= 0x3988E) k = 0; // |x| < sqrt(3/2)
        else if (j < 0xBB67A) k = 1; // |x| < sqrt(3)
        else { k = 0; n += 1; ix -= 0x00100000; }
        F[0] = ax; W[HI] = ix; ax = F[0];
        // ss = s_h + s_l = (x - 1)/(x + 1) or (x - 1.5)/(x + 1.5)
        u = ax - BP[k];
        v = 1.0 / (ax + BP[k]);
        ss = u * v;
        F[0] = ss; W[LO] = 0; s_h = F[0];
        t_h = words(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
        t_l = ax - (t_h - BP[k]);
        s_l = v * ((u - s_h * t_h) - s_h * t_l);
        s2 = ss * ss;
        r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
        r += s_l * (s_h + ss);
        s2 = s_h * s_h;
        t_h = 3 + s2 + r;
        F[0] = t_h; W[LO] = 0; t_h = F[0];
        t_l = r - ((t_h - 3) - s2);
        u = s_h * t_h;
        v = s_l * t_h + t_l * ss;
        p_h = u + v;
        F[0] = p_h; W[LO] = 0; p_h = F[0];
        p_l = v - (p_h - u);
        z_h = cp_h * p_h;
        z_l = cp_l * p_h + p_l * cp + DP_L[k];
        t = n;
        t1 = (((z_h + z_l) + DP_H[k]) + t);
        F[0] = t1; W[LO] = 0; t1 = F[0];
        t2 = z_l - (((t1 - t) - DP_H[k]) - z_h);
      }
      // (y1 + y2) * (t1 + t2) with y1 = y truncated to its high word
      F[0] = y; W[LO] = 0; y1 = F[0];
      p_l = (y - y1) * t1 + y * t2;
      p_h = y1 * t1;
      z = p_l + p_h;
      F[0] = z; j = W[HI]; i = W[LO];
      if (j >= 0x40900000) { // z >= 1024
        if (((j - 0x40900000) | i) !== 0) return s * huge * huge;
        if (p_l + ovt > z - p_h) return s * huge * huge;
      } else if ((j & 0x7fffffff) >= 0x4090cc00) { // z <= -1075
        if (j !== (0xc090cc00 | 0) || i !== 0) return s * tiny * tiny;
        if (p_l <= z - p_h) return s * tiny * tiny;
      }
      // 2^(p_h + p_l)
      i = j & 0x7fffffff;
      k = (i >> 20) - 0x3ff;
      n = 0;
      if (i > 0x3fe00000) { // |z| > 0.5: n = [z + 0.5]
        n = j + (0x00100000 >> (k + 1));
        k = ((n & 0x7fffffff) >> 20) - 0x3ff;
        t = words(n & ~(0x000fffff >> k), 0);
        n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
        if (j < 0) n = -n;
        p_h -= t;
      }
      t = p_l + p_h;
      F[0] = t; W[LO] = 0; t = F[0];
      u = t * lg2_h;
      v = (p_l - (t - p_h)) * lg2 + t * lg2_l;
      z = u + v;
      w = v - (z - u);
      t = z * z;
      t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
      r = (z * t1) / (t1 - 2.0) - (w + z * w);
      z = 1.0 - (r - z);
      F[0] = z; j = (W[HI] + (n << 20)) | 0;
      if ((j >> 20) <= 0) z = scalbn(z, n); // subnormal output
      else { W[HI] = j; z = F[0]; }
      return s * z;
    },
    // ---- s_cbrt.c ----
    cbrt(x) {
      x = +x;
      var r, s, t, w, high, lo, hi;
      F[0] = x;
      var hx = W[HI], low = W[LO];
      var sign = hx & 0x80000000;
      hx ^= sign;
      if (hx >= 0x7ff00000) return x + x;
      // Rough cbrt to 5 bits.
      if (hx < 0x00100000) { // zero or subnormal
        if ((hx | low) === 0) return x;
        t = two54 * x;
        F[0] = t; high = W[HI];
        t = words(sign | (((high & 0x7fffffff) / 3 | 0) + B2), 0);
      } else t = words(sign | ((hx / 3 | 0) + B1), 0);
      // New cbrt to 23 bits.
      r = (t * t) * (t / x);
      t = t * ((CP0 + r * (CP1 + r * CP2)) + ((r * r) * r) * (CP3 + r * CP4));
      // Round t away from zero to 23 bits: 64-bit (bits + 0x80000000) & 0xffffffffc0000000.
      F[0] = t;
      hi = W[HI];
      lo = (W[LO] >>> 0) + 0x80000000;
      if (lo > 0xffffffff) { lo -= 0x100000000; hi = (hi + 1) | 0; }
      t = words(hi, lo & 0xc0000000);
      // One Newton step to 53 bits.
      s = t * t;
      r = x / s;
      w = t + t;
      r = (r - t) / (w + r);
      t = t + t * r;
      return t;
    },
    // ECMAScript: ToNumber every argument in order; any +-Infinity gives +Infinity, else any NaN gives NaN; then fold
    // left with the binary msun hypot.
    hypot(a, b) {
      var n = arguments.length, i, v, r, inf = false, nan = false;
      if (n === 0) return 0;
      if (n <= 2) {
        a = +a;
        b = n === 2 ? +b : 0;
        if (a === Infinity || a === -Infinity || b === Infinity || b === -Infinity) return Infinity;
        if (a !== a || b !== b) return NaN;
        F[0] = a; W[HI] = W[HI] & 0x7fffffff;
        return hypot2(F[0], b);
      }
      // Fresh storage: a valueOf hook may re-enter hypot while arguments are being converted.
      var vals = new Float64ArrayC(n);
      for (i = 0; i < n; i++) vals[i] = +arguments[i];
      for (i = 0; i < n; i++) {
        v = vals[i];
        if (v === Infinity || v === -Infinity) inf = true;
        else if (v !== v) nan = true;
      }
      if (inf) return Infinity;
      if (nan) return NaN;
      F[0] = vals[0]; W[HI] = W[HI] & 0x7fffffff; r = F[0];
      for (i = 1; i < n; i++) r = hypot2(r, vals[i]);
      return r;
    }
  };

  var atan = D.atan, exp = D.exp, expm1 = D.expm1, log = D.log, log1p = D.log1p;
  var NAMES = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
    'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'pow', 'cbrt', 'hypot'];
  for (var i = 0; i < NAMES.length; i++) {
    defineProperty(M, NAMES[i], { value: D[NAMES[i]], writable: true, enumerable: false, configurable: true });
  }
})`;

/** Version of the port; part of `surfaceHash`. Bump on any change that can alter a result bit. */
export const DETERMINISTIC_MATH_VERSION = 'fdlibm-5.3-js/1';

/** The functions the port replaces, in spec order. */
export const DETERMINISTIC_MATH_FUNCTIONS = [
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'pow', 'cbrt', 'hypot',
] as const;
