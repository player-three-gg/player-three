/**
 * Deterministic `Math` (SPEC §11): the fdlibm/msun port must give bit-identical results in Node and in the QuickJS
 * policy sandbox, equal to the FreeBSD msun C sources it ports, and with the ECMAScript special-case values.
 *
 * Reference values: FreeBSD lib/msun/src (main) compiled with gcc, SSE2 doubles, -ffp-contract=off, glibc's correctly
 * rounded sqrt; each hard-case vector was cross-checked with mpmath at 4000 bits (263 of 288 correctly rounded, the
 * rest within 1 ulp, as fdlibm documents). The C99 results that ECMAScript overrides (pow(1, NaN), pow(-1, ±∞)) are
 * replaced by the ES values.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_MATH_FUNCTIONS,
  DETERMINISTIC_MATH_SOURCE,
  DETERMINISTIC_MATH_VERSION,
  loadPolicy,
  POLICY_JS_ENGINE,
  POLICY_RUNTIME,
  type PolicyInstance,
} from '../src/policy/index.ts';
import { limits, ok } from './policy-fixtures.ts';
import { BINARY_FUNCTIONS, HEX_SOURCE, MATH_FUNCTIONS, MATH_INPUTS, MATH_INPUTS_SOURCE } from './policy-math-fixture.ts';

type MathFn = (...args: unknown[]) => number;

/** A fresh port in Node, from the very source string the sandbox prelude evaluates. */
function nodePort(): Record<string, MathFn> {
  const target: Record<string, MathFn> = { sqrt: Math.sqrt as MathFn };
  (new Function(`return ${DETERMINISTIC_MATH_SOURCE}`)() as (m: object) => void)(target);
  return target;
}
const port = nodePort();
const hex = new Function(`return ${HEX_SOURCE}`)() as (v: number) => string;
const gen = new Function(`return ${MATH_INPUTS_SOURCE}`)() as (fnIndex: number, n: number, binary: boolean) => Float64Array;
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
/** '0x' + 16 hex digits, high word first. */
function fromHex(h: string): number {
  u32[1] = Number.parseInt(h.slice(2, 10), 16);
  u32[0] = Number.parseInt(h.slice(10), 16);
  return f64[0]!;
}

/** sha256 of the msun C reference outputs (hex, concatenated) over the seeded inputs of policy-math-fixture.ts. */
const REFERENCE_DIGESTS: Record<string, string> = {
  sin: '68a0d8b4b06c58f8e916babbbba341fe4619f711df4968a21dec2678b613f63e',
  cos: '949b6aa5fafb784b664eb456f134c8a09f03547b935f5782a58960ae6945ae9c',
  tan: 'daeef3d81b8375226ebdc1a96a5eab8088a207b3df0cbf7a70ccaebd0ff5cf32',
  asin: 'a5965c717af39bd89aa0e7ff64724ae693549159f490ef43a58a7692e3de6d83',
  acos: '736493eb83412075ea33232c4ffae9fee498b890bca2463f6ee860831c061fb1',
  atan: '3f86244fe325d4d284f6ebe1c9083102ea42c14dcec263781ec6aabd0f486c59',
  atan2: '1ba41f860d4c636822c11993f52b573d07e607aee4e67aa01c5381a75a8d3be8',
  sinh: 'ccdd7c6f182455a85c90483246566405620f55b0286987d19188dc46bfd8525d',
  cosh: '5ace6d335e5096e6dd1c2be0c0e625744f0ba307ea8ef2c7480e9110133e7253',
  tanh: '4eb18c155b2bf731262f0fc66035caa0a7e9d4990cfce92cd6e31367a1a0ba76',
  asinh: 'ece0a3ee765dffc473ece002ef38f139031f05be4929323c17e3fbb7ba59e20f',
  acosh: 'a144060863d20576fc6368278a2fd7089ffdce09ac6e74f4e23dcec418f2146b',
  atanh: '0d6c41c750d91054382448a6ac58b91b2aa685bda3842926f1b197d8d39ad5e3',
  exp: '0dbb130cd1e5e6afec989c7f3dbcec9d00929acbd8e99c75eebcd23e3b232eb1',
  expm1: '280c39183cd3ddec4f9b7638c2fb6b13530e4ff28784da8be6630572dab90a12',
  log: '761d3a801f0ab09510dca528078f6e315a5bdb1dbad6b389ac7de093feb0efc9',
  log1p: '915708006ade26ff34984230ddcebafaf8ab651e0c28834d7764d6e4baae4b1a',
  log2: 'aee12aa300ad9c34841e14e45942ebbc124b7f2812cc0cd2bbbda73dd600120b',
  log10: 'bf6337f56a0b54afdcc4861b6edf9a29e3ce7518cc72f9561aafcca1db64e516',
  pow: 'bf3ffa6e423a875fe71114d8b8308392425d9d2714d458f52cfc3a9d8a7bf085',
  cbrt: '0e09541c13d85fd63f61ba58943ee718811fb0487eb5259c56bda038d520bb60',
  hypot: '9be92770cf12f25302bd2da1d64c92f52ab64db90e40ae19822559d1fb8e26b5',
};

/** [function, argument bit patterns, msun C result bit pattern]. */
const VECTORS: [string, string[], string][] = [
  ['sin', ['0x4480f0cf064dd592'], '0xbfeb453ab76bf397'], // sin(1e+22) = -0.8522008497671888
  ['sin', ['0x7e37e43c8800759c'], '0xbfea2c16b010e385'], // sin(1e+300) = -0.8178819121159085
  ['sin', ['0xfe37e43c8800759c'], '0x3fea2c16b010e385'], // sin(-1e+300) = 0.8178819121159085
  ['sin', ['0x7fefffffffffffff'], '0x3f7452fc98b34e97'], // sin(1.7976931348623157e+308) = 0.004961954789184062
  ['sin', ['0x7506ac5b262ca1ff'], '0x3ff0000000000000'], // sin(5.319372648326541e+255) = 1
  ['sin', ['0x3ff921fb54442d18'], '0x3ff0000000000000'], // sin(1.5707963267948966) = 1
  ['sin', ['0x3ff921fb54442d19'], '0x3ff0000000000000'], // sin(1.5707963267948968) = 1
  ['sin', ['0x3ff921fb54442d17'], '0x3ff0000000000000'], // sin(1.5707963267948963) = 1
  ['sin', ['0x400921fb54442d18'], '0x3ca1a62633145c07'], // sin(3.141592653589793) = 1.2246467991473532e-16
  ['sin', ['0x401921fb54442d18'], '0xbcb1a62633145c07'], // sin(6.283185307179586) = -2.4492935982947064e-16
  ['sin', ['0x4012d97c7f3321d2'], '0xbff0000000000000'], // sin(4.71238898038469) = -1
  ['sin', ['0x430c6bf526340000'], '0x3feb76f88136ceba'], // sin(1000000000000000) = 0.8582727931702359
  ['sin', ['0x413921fb54442d18'], '0xbdd1a62633145c07'], // sin(1647099.3291652855) = -6.420676210313675e-11
  ['sin', ['0x01a56e1fc2f8f359'], '0x01a56e1fc2f8f359'], // sin(1e-300) = 1e-300
  ['sin', ['0x0000000000000001'], '0x0000000000000001'], // sin(5e-324) = 5e-324
  ['sin', ['0x8000000000000001'], '0x8000000000000001'], // sin(-5e-324) = -5e-324
  ['sin', ['0x0010000000000000'], '0x0010000000000000'], // sin(2.2250738585072014e-308) = 2.2250738585072014e-308
  ['sin', ['0x3fe0000000000000'], '0x3fdeaee8744b05f0'], // sin(0.5) = 0.479425538604203
  ['sin', ['0x3fe921fb54442d18'], '0x3fe6a09e667f3bcc'], // sin(0.7853981633974483) = 0.7071067811865475
  ['sin', ['0x3ff0000000000000'], '0x3feaed548f090cee'], // sin(1) = 0.8414709848078965
  ['sin', ['0x4059000000000000'], '0xbfe03425b78c4db8'], // sin(100) = -0.5063656411097588
  ['sin', ['0xc004000000000000'], '0xbfe326af0dcfcab0'], // sin(-2.5) = -0.5984721441039564; 1 ulp from correctly rounded 0xbfe326af0dcfcab1
  ['cos', ['0x4480f0cf064dd592'], '0x3fe0be2cef01c8f4'], // cos(1e+22) = 0.523214785395139
  ['cos', ['0x7e37e43c8800759c'], '0xbfe2699022adc4c1'], // cos(1e+300) = -0.5753861119575491
  ['cos', ['0xfe37e43c8800759c'], '0xbfe2699022adc4c1'], // cos(-1e+300) = -0.5753861119575491
  ['cos', ['0x7fefffffffffffff'], '0xbfefffe62ecfab75'], // cos(1.7976931348623157e+308) = -0.9999876894265599
  ['cos', ['0x7506ac5b262ca1ff'], '0xbc214ae72e6ba22f'], // cos(5.319372648326541e+255) = -4.687165924254628e-19
  ['cos', ['0x3ff921fb54442d18'], '0x3c91a62633145c07'], // cos(1.5707963267948966) = 6.123233995736766e-17
  ['cos', ['0x3ff921fb54442d19'], '0xbca72cece675d1fd'], // cos(1.5707963267948968) = -1.6081226496766366e-16
  ['cos', ['0x3ff921fb54442d17'], '0x3cb469898cc51702'], // cos(1.5707963267948963) = 2.83276944882399e-16
  ['cos', ['0x400921fb54442d18'], '0xbff0000000000000'], // cos(3.141592653589793) = -1
  ['cos', ['0x401921fb54442d18'], '0x3ff0000000000000'], // cos(6.283185307179586) = 1
  ['cos', ['0x4012d97c7f3321d2'], '0xbcaa79394c9e8a0a'], // cos(4.71238898038469) = -1.8369701987210297e-16
  ['cos', ['0x430c6bf526340000'], '0xbfe06c154609d33e'], // cos(1000000000000000) = -0.5131937377869702; 1 ulp from correctly rounded 0xbfe06c154609d33f
  ['cos', ['0x413921fb54442d18'], '0x3ff0000000000000'], // cos(1647099.3291652855) = 1
  ['cos', ['0x01a56e1fc2f8f359'], '0x3ff0000000000000'], // cos(1e-300) = 1
  ['cos', ['0x0000000000000001'], '0x3ff0000000000000'], // cos(5e-324) = 1
  ['cos', ['0x8000000000000001'], '0x3ff0000000000000'], // cos(-5e-324) = 1
  ['cos', ['0x0010000000000000'], '0x3ff0000000000000'], // cos(2.2250738585072014e-308) = 1
  ['cos', ['0x3fe0000000000000'], '0x3fec1528065b7d50'], // cos(0.5) = 0.8775825618903728
  ['cos', ['0x3fe921fb54442d18'], '0x3fe6a09e667f3bcd'], // cos(0.7853981633974483) = 0.7071067811865476
  ['cos', ['0x3ff0000000000000'], '0x3fe14a280fb5068c'], // cos(1) = 0.5403023058681398
  ['cos', ['0x4059000000000000'], '0x3feb981dbf665fdf'], // cos(100) = 0.8623188722876839
  ['cos', ['0xc004000000000000'], '0xbfe9a2f7ef858b7d'], // cos(-2.5) = -0.8011436155469337
  ['tan', ['0x4480f0cf064dd592'], '0xbffa0f79c1b6b258'], // tan(1e+22) = -1.628778225606899; 1 ulp from correctly rounded 0xbffa0f79c1b6b257
  ['tan', ['0x7e37e43c8800759c'], '0x3ff6be411f37ac77'], // tan(1e+300) = 1.4214488238747245
  ['tan', ['0xfe37e43c8800759c'], '0xbff6be411f37ac77'], // tan(-1e+300) = -1.4214488238747245
  ['tan', ['0x7fefffffffffffff'], '0xbf74530cfe729484'], // tan(1.7976931348623157e+308) = -0.004962015874444895
  ['tan', ['0x7506ac5b262ca1ff'], '0xc3bd9ba9a7975636'], // tan(5.319372648326541e+255) = -2133485385753704000
  ['tan', ['0x3ff921fb54442d18'], '0x434d02967c31cdb5'], // tan(1.5707963267948966) = 16331239353195370
  ['tan', ['0x3ff921fb54442d19'], '0xc33617a15494767a'], // tan(1.5707963267948968) = -6218431163823738
  ['tan', ['0x3ff921fb54442d17'], '0x4329153d9443ed0b'], // tan(1.5707963267948963) = 3530114321217157.5
  ['tan', ['0x400921fb54442d18'], '0xbca1a62633145c07'], // tan(3.141592653589793) = -1.2246467991473532e-16
  ['tan', ['0x401921fb54442d18'], '0xbcb1a62633145c07'], // tan(6.283185307179586) = -2.4492935982947064e-16
  ['tan', ['0x4012d97c7f3321d2'], '0x4333570efd768923'], // tan(4.71238898038469) = 5443746451065123
  ['tan', ['0x430c6bf526340000'], '0xbffac23600a95be4'], // tan(1000000000000000) = -1.672414782127583
  ['tan', ['0x413921fb54442d18'], '0xbdd1a62633145c07'], // tan(1647099.3291652855) = -6.420676210313675e-11
  ['tan', ['0x01a56e1fc2f8f359'], '0x01a56e1fc2f8f359'], // tan(1e-300) = 1e-300
  ['tan', ['0x0000000000000001'], '0x0000000000000001'], // tan(5e-324) = 5e-324
  ['tan', ['0x8000000000000001'], '0x8000000000000001'], // tan(-5e-324) = -5e-324
  ['tan', ['0x0010000000000000'], '0x0010000000000000'], // tan(2.2250738585072014e-308) = 2.2250738585072014e-308
  ['tan', ['0x3fe0000000000000'], '0x3fe17b4f5bf3474a'], // tan(0.5) = 0.5463024898437905
  ['tan', ['0x3fe921fb54442d18'], '0x3fefffffffffffff'], // tan(0.7853981633974483) = 0.9999999999999999
  ['tan', ['0x3ff0000000000000'], '0x3ff8eb245cbee3a6'], // tan(1) = 1.5574077246549023
  ['tan', ['0x4059000000000000'], '0xbfe2ca74d62b5d38'], // tan(100) = -0.5872139151569291
  ['tan', ['0xc004000000000000'], '0x3fe7e79b4e00bb15'], // tan(-2.5) = 0.7470222972386603
  ['asin', ['0x3fe0000000000000'], '0x3fe0c152382d7366'], // asin(0.5) = 0.5235987755982989
  ['asin', ['0xbfe0000000000000'], '0xbfe0c152382d7366'], // asin(-0.5) = -0.5235987755982989
  ['asin', ['0x3fef333333333333'], '0x3ff58c2b5ce0c3e5'], // asin(0.975) = 1.3467210414930773
  ['asin', ['0x3fef333333333334'], '0x3ff58c2b5ce0c3e7'], // asin(0.9750000000000001) = 1.3467210414930777
  ['asin', ['0x3fefffffffffffff'], '0x3ff921fb50442d18'], // asin(0.9999999999999999) = 1.5707963118937354
  ['asin', ['0xbfefffffffffffff'], '0xbff921fb50442d18'], // asin(-0.9999999999999999) = -1.5707963118937354
  ['asin', ['0x01a56e1fc2f8f359'], '0x01a56e1fc2f8f359'], // asin(1e-300) = 1e-300
  ['asin', ['0x0000000000000001'], '0x0000000000000001'], // asin(5e-324) = 5e-324
  ['asin', ['0x3e50000000000000'], '0x3e50000000000000'], // asin(1.4901161193847656e-8) = 1.4901161193847656e-8
  ['asin', ['0x3fb999999999999a'], '0x3fb9a49276037884'], // asin(0.1) = 0.1001674211615598
  ['asin', ['0x3fe6666666666666'], '0x3fe8d00e692afd95'], // asin(0.7) = 0.775397496610753
  ['acos', ['0x3fe0000000000000'], '0x3ff0c152382d7366'], // acos(0.5) = 1.0471975511965979
  ['acos', ['0xbfe0000000000000'], '0x4000c152382d7366'], // acos(-0.5) = 2.0943951023931957
  ['acos', ['0x3fefffffffffffff'], '0x3e50000000000000'], // acos(0.9999999999999999) = 1.4901161193847656e-8
  ['acos', ['0xbfefffffffffffff'], '0x400921fb52442d18'], // acos(-0.9999999999999999) = 3.141592638688632
  ['acos', ['0x01a56e1fc2f8f359'], '0x3ff921fb54442d18'], // acos(1e-300) = 1.5707963267948966
  ['acos', ['0x0000000000000001'], '0x3ff921fb54442d18'], // acos(5e-324) = 1.5707963267948966
  ['acos', ['0x3c670ef54646d497'], '0x3ff921fb54442d18'], // acos(1e-17) = 1.5707963267948966
  ['acos', ['0x3fb999999999999a'], '0x3ff787b22ce3f590'], // acos(0.1) = 1.4706289056333368
  ['acos', ['0xbfe6666666666666'], '0x4002c501446cd5f2'], // acos(-0.7) = 2.34619382340565; 1 ulp from correctly rounded 0x4002c501446cd5f1
  ['acos', ['0x3fe6666666666666'], '0x3fe973e83f5d5c9b'], // acos(0.7) = 0.7953988301841436
  ['atan', ['0x3fdc000000000000'], '0x3fda64eec3cc23fd'], // atan(0.4375) = 0.4124104415973873
  ['atan', ['0x3fe6000000000000'], '0x3fe345f01cce37bb'], // atan(0.6875) = 0.6022873461349642
  ['atan', ['0x3ff3000000000000'], '0x3febde70ed439fe7'], // atan(1.1875) = 0.870903457075653
  ['atan', ['0x4003800000000000'], '0x3ff2e75728833a54'], // atan(2.4375) = 1.1814796049617557
  ['atan', ['0x4410000000000000'], '0x3ff921fb54442d18'], // atan(73786976294838210000) = 1.5707963267948966
  ['atan', ['0xc410000000000000'], '0xbff921fb54442d18'], // atan(-73786976294838210000) = -1.5707963267948966
  ['atan', ['0x01a56e1fc2f8f359'], '0x01a56e1fc2f8f359'], // atan(1e-300) = 1e-300
  ['atan', ['0x0000000000000001'], '0x0000000000000001'], // atan(5e-324) = 5e-324
  ['atan', ['0x7e37e43c8800759c'], '0x3ff921fb54442d18'], // atan(1e+300) = 1.5707963267948966
  ['atan', ['0x3fe0000000000000'], '0x3fddac670561bb4f'], // atan(0.5) = 0.4636476090008061
  ['atan', ['0xbff0000000000000'], '0xbfe921fb54442d18'], // atan(-1) = -0.7853981633974483
  ['atan', ['0x4008000000000000'], '0x3ff3fc176b7a8560'], // atan(3) = 1.2490457723982544
  ['sinh', ['0x4036000000000000'], '0x41dab5adb9c43600'], // sinh(22) = 1792456423.065796
  ['sinh', ['0xc036000000000000'], '0xc1dab5adb9c43600'], // sinh(-22) = -1792456423.065796
  ['sinh', ['0x40862e4200000000'], '0x7fdffc045693009e'], // sinh(709.7822265625) = 8.984095368647863e+307; 1 ulp from correctly rounded 0x7fdffc045693009d
  ['sinh', ['0x408633ce8fb9f87d'], '0x7feffffffffffd3c'], // sinh(710.4758600739439) = 1.7976931348621746e+308; 1 ulp from correctly rounded 0x7feffffffffffd3b
  ['sinh', ['0x01a56e1fc2f8f359'], '0x01a56e1fc2f8f359'], // sinh(1e-300) = 1e-300
  ['sinh', ['0x0000000000000001'], '0x0000000000000001'], // sinh(5e-324) = 5e-324
  ['sinh', ['0x3fd62e42fefa39ef'], '0x3fd6a09e667f3bcc'], // sinh(0.34657359027997264) = 0.35355339059327373
  ['sinh', ['0xbff0000000000000'], '0xbff2cd9fc44eb982'], // sinh(-1) = -1.1752011936438014
  ['sinh', ['0x3e30000000000000'], '0x3e30000000000000'], // sinh(3.725290298461914e-9) = 3.725290298461914e-9
  ['sinh', ['0x3fe0000000000000'], '0x3fe0acd00fe63b97'], // sinh(0.5) = 0.5210953054937474
  ['sinh', ['0x403e000000000000'], '0x429370470aec28ed'], // sinh(30) = 5343237290762.231
  ['cosh', ['0x4036000000000000'], '0x41dab5adb9c43600'], // cosh(22) = 1792456423.065796
  ['cosh', ['0xc036000000000000'], '0x41dab5adb9c43600'], // cosh(-22) = 1792456423.065796
  ['cosh', ['0x40862e4200000000'], '0x7fdffc045693009e'], // cosh(709.7822265625) = 8.984095368647863e+307; 1 ulp from correctly rounded 0x7fdffc045693009d
  ['cosh', ['0x408633ce8fb9f87d'], '0x7feffffffffffd3c'], // cosh(710.4758600739439) = 1.7976931348621746e+308; 1 ulp from correctly rounded 0x7feffffffffffd3b
  ['cosh', ['0x01a56e1fc2f8f359'], '0x3ff0000000000000'], // cosh(1e-300) = 1
  ['cosh', ['0x3fd62e42fefa39ef'], '0x3ff0f876ccdf6cd9'], // cosh(0.34657359027997264) = 1.0606601717798212
  ['cosh', ['0xbff0000000000000'], '0x3ff8b07551d9f551'], // cosh(-1) = 1.543080634815244; 1 ulp from correctly rounded 0x3ff8b07551d9f550
  ['cosh', ['0x3e30000000000000'], '0x3ff0000000000000'], // cosh(3.725290298461914e-9) = 1
  ['cosh', ['0x3fe0000000000000'], '0x3ff20ac1862ae8d0'], // cosh(0.5) = 1.1276259652063807
  ['cosh', ['0x403e000000000000'], '0x429370470aec28ed'], // cosh(30) = 5343237290762.231
  ['tanh', ['0x4036000000000000'], '0x3ff0000000000000'], // tanh(22) = 1
  ['tanh', ['0xc036000000000000'], '0xbff0000000000000'], // tanh(-22) = -1
  ['tanh', ['0x3fe0000000000000'], '0x3fdd9353d7568af3'], // tanh(0.5) = 0.46211715726000974
  ['tanh', ['0x3ff0000000000000'], '0x3fe85efab514f394'], // tanh(1) = 0.7615941559557649
  ['tanh', ['0xbddb7cdfd9d7bdbb'], '0xbddb7cdfd9d7bdbb'], // tanh(-1e-10) = -1e-10
  ['tanh', ['0x01a56e1fc2f8f359'], '0x01a56e1fc2f8f359'], // tanh(1e-300) = 1e-300
  ['tanh', ['0x0000000000000001'], '0x0000000000000001'], // tanh(5e-324) = 5e-324
  ['tanh', ['0x3fd0000000000000'], '0x3fcf597ea69a1c86'], // tanh(0.25) = 0.24491866240370913
  ['tanh', ['0x4008000000000000'], '0x3fefd77d111a0b00'], // tanh(3) = 0.9950547536867305
  ['tanh', ['0x4035ffffffffffff'], '0x3ff0000000000000'], // tanh(21.999999999999996) = 1
  ['asinh', ['0x41b0000000000001'], '0x403419ecb712c481'], // asinh(268435456.00000006) = 20.101268236238415
  ['asinh', ['0xc1b0000000000001'], '0xc03419ecb712c481'], // asinh(-268435456.00000006) = -20.101268236238415
  ['asinh', ['0x4000000000000000'], '0x3ff719218313d087'], // asinh(2) = 1.4436354751788103
  ['asinh', ['0x4000000000000001'], '0x3ff719218313d088'], // asinh(2.0000000000000004) = 1.4436354751788105
  ['asinh', ['0x3fe0000000000000'], '0x3fdecc2caec5160a'], // asinh(0.5) = 0.48121182505960347
  ['asinh', ['0x01a56e1fc2f8f359'], '0x01a56e1fc2f8f359'], // asinh(1e-300) = 1e-300
  ['asinh', ['0x0000000000000001'], '0x0000000000000001'], // asinh(5e-324) = 5e-324
  ['asinh', ['0xfe37e43c8800759c'], '0xc0859bbfd8b83e43'], // asinh(-1e+300) = -691.4686750787736; 1 ulp from correctly rounded 0xc0859bbfd8b83e44
  ['asinh', ['0x7fefffffffffffff'], '0x408633ce8fb9f87d'], // asinh(1.7976931348623157e+308) = 710.4758600739439; 1 ulp from correctly rounded 0x408633ce8fb9f87e
  ['asinh', ['0x3fb999999999999a'], '0x3fb98eb9e7e5fc3f'], // asinh(0.1) = 0.09983407889920758; 1 ulp from correctly rounded 0x3fb98eb9e7e5fc3e
  ['acosh', ['0x3ff0000000000001'], '0x3e56a09e667f3bcd'], // acosh(1.0000000000000002) = 2.1073424255447017e-8; 1 ulp from correctly rounded 0x3e56a09e667f3bcc
  ['acosh', ['0x4000000000000000'], '0x3ff5124271980434'], // acosh(2) = 1.3169578969248166; 1 ulp from correctly rounded 0x3ff5124271980435
  ['acosh', ['0x4000000000000001'], '0x3ff5124271980436'], // acosh(2.0000000000000004) = 1.316957896924817
  ['acosh', ['0x41b0000000000000'], '0x403419ecb712c480'], // acosh(268435456) = 20.10126823623841; 1 ulp from correctly rounded 0x403419ecb712c481
  ['acosh', ['0x7e37e43c8800759c'], '0x40859bbfd8b83e43'], // acosh(1e+300) = 691.4686750787736; 1 ulp from correctly rounded 0x40859bbfd8b83e44
  ['acosh', ['0x7fefffffffffffff'], '0x408633ce8fb9f87d'], // acosh(1.7976931348623157e+308) = 710.4758600739439; 1 ulp from correctly rounded 0x408633ce8fb9f87e
  ['acosh', ['0x3ff8000000000000'], '0x3feecc2caec5160a'], // acosh(1.5) = 0.9624236501192069
  ['acosh', ['0x4024000000000000'], '0x4007f21ed1ce05d4'], // acosh(10) = 2.993222846126381
  ['atanh', ['0x3fe0000000000000'], '0x3fe193ea7aad030a'], // atanh(0.5) = 0.5493061443340548; 1 ulp from correctly rounded 0x3fe193ea7aad030b
  ['atanh', ['0xbfe0000000000000'], '0xbfe193ea7aad030a'], // atanh(-0.5) = -0.5493061443340548; 1 ulp from correctly rounded 0xbfe193ea7aad030b
  ['atanh', ['0x3fefffffffffffff'], '0x4032b708872320e2'], // atanh(0.9999999999999999) = 18.714973875118524
  ['atanh', ['0xbfefffffffffffff'], '0xc032b708872320e2'], // atanh(-0.9999999999999999) = -18.714973875118524
  ['atanh', ['0x01a56e1fc2f8f359'], '0x01a56e1fc2f8f359'], // atanh(1e-300) = 1e-300
  ['atanh', ['0x0000000000000001'], '0x0000000000000001'], // atanh(5e-324) = 5e-324
  ['atanh', ['0x3fb999999999999a'], '0x3fb9af93cd234412'], // atanh(0.1) = 0.10033534773107558
  ['atanh', ['0x3fdfffffffffffff'], '0x3fe193ea7aad030a'], // atanh(0.49999999999999994) = 0.5493061443340548
  ['exp', ['0x40862e42fefa39ef'], '0x7fefffffffffff2a'], // exp(709.782712893384) = 1.7976931348622732e+308
  ['exp', ['0x40862e42fefa39f0'], '0x7ff0000000000000'], // exp(709.7827128933841) = null
  ['exp', ['0xc0874910d52d3051'], '0x0000000000000001'], // exp(-745.1332191019411) = 5e-324
  ['exp', ['0xc0874910d52d3052'], '0x0000000000000000'], // exp(-745.1332191019412) = 0
  ['exp', ['0xc086232bdd7abcd2'], '0x001000000000007c'], // exp(-708.3964185322641) = 2.2250738585072626e-308
  ['exp', ['0xc086232bdd7abcd3'], '0x000ffffffffffe7c'], // exp(-708.3964185322642) = 2.2250738585070097e-308
  ['exp', ['0x3ff0000000000000'], '0x4005bf0a8b14576a'], // exp(1) = 2.7182818284590455; 1 ulp from correctly rounded 0x4005bf0a8b145769
  ['exp', ['0xbff0000000000000'], '0x3fd78b56362cef38'], // exp(-1) = 0.36787944117144233
  ['exp', ['0x3fd62e42fefa39ef'], '0x3ff6a09e667f3bcc'], // exp(0.34657359027997264) = 1.414213562373095
  ['exp', ['0x3ff0a2b23f3bab73'], '0x4006a09e667f3bcc'], // exp(1.0397207708399179) = 2.82842712474619
  ['exp', ['0x01a56e1fc2f8f359'], '0x3ff0000000000000'], // exp(1e-300) = 1
  ['exp', ['0x0000000000000001'], '0x3ff0000000000000'], // exp(5e-324) = 1
  ['exp', ['0x4059000000000000'], '0x48f3494a9b171bf5'], // exp(100) = 2.6881171418161356e+43
  ['exp', ['0xc059000000000000'], '0x36ea8c1f14e2af5d'], // exp(-100) = 3.720075976020836e-44
  ['exp', ['0x3fe0000000000000'], '0x3ffa61298e1e069c'], // exp(0.5) = 1.6487212707001282
  ['exp', ['0x3e112e0be826d695'], '0x3ff000000044b830'], // exp(1e-9) = 1.000000001
  ['expm1', ['0x3ddb7cdfd9d7bdbb'], '0x3ddb7cdfd9dda4e3'], // expm1(1e-10) = 1.00000000005e-10
  ['expm1', ['0xbddb7cdfd9d7bdbb'], '0xbddb7cdfd9d1d693'], // expm1(-1e-10) = -9.999999999500001e-11
  ['expm1', ['0x01a56e1fc2f8f359'], '0x01a56e1fc2f8f359'], // expm1(1e-300) = 1e-300
  ['expm1', ['0x0000000000000001'], '0x0000000000000001'], // expm1(5e-324) = 5e-324
  ['expm1', ['0x3c90000000000000'], '0x3c90000000000000'], // expm1(5.551115123125783e-17) = 5.551115123125783e-17
  ['expm1', ['0x3fe0000000000000'], '0x3fe4c2531c3c0d38'], // expm1(0.5) = 0.6487212707001282
  ['expm1', ['0xbfe0000000000000'], '0xbfd92e9a0720d3ec'], // expm1(-0.5) = -0.3934693402873666
  ['expm1', ['0x4043687a9f1af2b1'], '0x436fffffffffffec'], // expm1(38.816242111356935) = 72057594037927780
  ['expm1', ['0xc043687a9f1af2b1'], '0xbff0000000000000'], // expm1(-38.816242111356935) = -1
  ['expm1', ['0xc044000000000000'], '0xbff0000000000000'], // expm1(-40) = -1
  ['expm1', ['0x40862e42fefa39ef'], '0x7fefffffffffff2a'], // expm1(709.782712893384) = 1.7976931348622732e+308
  ['expm1', ['0x3ff0000000000000'], '0x3ffb7e151628aed2'], // expm1(1) = 1.718281828459045; 1 ulp from correctly rounded 0x3ffb7e151628aed3
  ['expm1', ['0x3ee4f8b588e368f1'], '0x3ee4f8bc681cdfb6'], // expm1(0.00001) = 0.000010000050000166668
  ['expm1', ['0x3fd62e42fefa39ef'], '0x3fda827999fcef32'], // expm1(0.34657359027997264) = 0.41421356237309503
  ['log', ['0x0000000000000001'], '0xc0874385446d71c3'], // log(5e-324) = -744.4400719213812
  ['log', ['0x0010000000000000'], '0xc086232bdd7abcd2'], // log(2.2250738585072014e-308) = -708.3964185322641
  ['log', ['0x000012688b70e62b'], '0xc0864e69394d9508'], // log(1e-310) = -713.8013788281542
  ['log', ['0x3ff0000000000001'], '0x3cafffffffffffff'], // log(1.0000000000000002) = 2.2204460492503128e-16
  ['log', ['0x3fefffffffffffff'], '0xbca0000000000000'], // log(0.9999999999999999) = -1.1102230246251565e-16
  ['log', ['0x4000000000000000'], '0x3fe62e42fefa39ef'], // log(2) = 0.6931471805599453
  ['log', ['0x4024000000000000'], '0x40026bb1bbb55516'], // log(10) = 2.302585092994046
  ['log', ['0x7e37e43c8800759c'], '0x4085963447f87fb5'], // log(1e+300) = 690.7755278982137
  ['log', ['0x7fefffffffffffff'], '0x40862e42fefa39ef'], // log(1.7976931348623157e+308) = 709.782712893384
  ['log', ['0x3fb999999999999a'], '0xc0026bb1bbb55515'], // log(0.1) = -2.3025850929940455
  ['log', ['0x3ff6a09e667f3bcd'], '0x3fd62e42fefa39f0'], // log(1.4142135623730951) = 0.3465735902799727
  ['log', ['0x3fe6a09e667f3bcd'], '0xbfd62e42fefa39ee'], // log(0.7071067811865476) = -0.3465735902799726
  ['log1p', ['0x3ddb7cdfd9d7bdbb'], '0x3ddb7cdfd9d1d693'], // log1p(1e-10) = 9.999999999500001e-11
  ['log1p', ['0xbddb7cdfd9d7bdbb'], '0xbddb7cdfd9dda4e3'], // log1p(-1e-10) = -1.00000000005e-10
  ['log1p', ['0x01a56e1fc2f8f359'], '0x01a56e1fc2f8f359'], // log1p(1e-300) = 1e-300
  ['log1p', ['0x0000000000000001'], '0x0000000000000001'], // log1p(5e-324) = 5e-324
  ['log1p', ['0xbfe0000000000000'], '0xbfe62e42fefa39ef'], // log1p(-0.5) = -0.6931471805599453
  ['log1p', ['0x3fda827999fcef32'], '0x3fd62e42fefa39ef'], // log1p(0.41421356237309503) = 0.34657359027997264
  ['log1p', ['0xbfd2bec333018866'], '0xbfd62e42fefa39ee'], // log1p(-0.2928932188134524) = -0.3465735902799726
  ['log1p', ['0x7e37e43c8800759c'], '0x4085963447f87fb5'], // log1p(1e+300) = 690.7755278982137
  ['log1p', ['0x4340000000000000'], '0x40425e4f7b2737fa'], // log1p(9007199254740992) = 36.7368005696771
  ['log1p', ['0xbfefffffffffffff'], '0xc0425e4f7b2737fa'], // log1p(-0.9999999999999999) = -36.7368005696771
  ['log1p', ['0x3e20000000000000'], '0x3e1fffffff800000'], // log1p(1.862645149230957e-9) = 1.8626451474962336e-9
  ['log1p', ['0x3ff0000000000000'], '0x3fe62e42fefa39ef'], // log1p(1) = 0.6931471805599453
  ['log2', ['0x0000000000000001'], '0xc090c80000000000'], // log2(5e-324) = -1074
  ['log2', ['0x000012688b70e62b'], '0xc0901730dabca5f6'], // log2(1e-310) = -1029.7977094150824
  ['log2', ['0x4020000000000000'], '0x4008000000000000'], // log2(8) = 3
  ['log2', ['0x4008000000000000'], '0x3ff95c01a39fbd68'], // log2(3) = 1.584962500721156
  ['log2', ['0x3ff0000000000001'], '0x3cb71547652b82fd'], // log2(1.0000000000000002) = 3.203426503814917e-16
  ['log2', ['0x3fefffffffffffff'], '0xbca71547652b82fe'], // log2(0.9999999999999999) = -1.6017132519074588e-16
  ['log2', ['0x3fb999999999999a'], '0xc00a934f0979a371'], // log2(0.1) = -3.321928094887362
  ['log2', ['0x7fefffffffffffff'], '0x4090000000000000'], // log2(1.7976931348623157e+308) = 1024
  ['log2', ['0x3ff6a09e667f3bcd'], '0x3fe0000000000001'], // log2(1.4142135623730951) = 0.5000000000000001
  ['log2', ['0x4090000000000000'], '0x4024000000000000'], // log2(1024) = 10
  ['log2', ['0x4024000000000000'], '0x400a934f0979a371'], // log2(10) = 3.321928094887362
  ['log10', ['0x0000000000000001'], '0xc07434e6420f4374'], // log10(5e-324) = -323.3062153431158
  ['log10', ['0x000012688b70e62b'], '0xc073600000000000'], // log10(1e-310) = -310
  ['log10', ['0x408f400000000000'], '0x4008000000000000'], // log10(1000) = 3
  ['log10', ['0x44b52d02c7e14af6'], '0x4037000000000000'], // log10(1e+23) = 23
  ['log10', ['0x3f50624dd2f1a9fc'], '0xc008000000000000'], // log10(0.001) = -3
  ['log10', ['0x4000000000000000'], '0x3fd34413509f79ff'], // log10(2) = 0.3010299956639812
  ['log10', ['0x7fefffffffffffff'], '0x40734413509f79ff'], // log10(1.7976931348623157e+308) = 308.25471555991675
  ['log10', ['0x3ff0000000000001'], '0x3c9bcb7b1526e50d'], // log10(1.0000000000000002) = 9.64327466553287e-17
  ['log10', ['0x3fefffffffffffff'], '0xbc8bcb7b1526e50f'], // log10(0.9999999999999999) = -4.821637332766436e-17
  ['log10', ['0x01a56e1fc2f8f359'], '0xc072c00000000000'], // log10(1e-300) = -300
  ['log10', ['0x4008000000000000'], '0x3fde8927964fd5fd'], // log10(3) = 0.47712125471966244
  ['cbrt', ['0x403b000000000000'], '0x4008000000000000'], // cbrt(27) = 3
  ['cbrt', ['0xc03b000000000000'], '0xc008000000000000'], // cbrt(-27) = -3
  ['cbrt', ['0x0000000000000001'], '0x2990000000000000'], // cbrt(5e-324) = 1.7031839360032603e-108
  ['cbrt', ['0x800012688b70e62b'], '0xaa7a9d1b0b5d7427'], // cbrt(-1e-310) = -4.641588833612774e-104
  ['cbrt', ['0x4000000000000000'], '0x3ff428a2f98d728b'], // cbrt(2) = 1.2599210498948732
  ['cbrt', ['0x7e37e43c8800759c'], '0x54b249ad2594c37d'], // cbrt(1e+300) = 1e+100
  ['cbrt', ['0x3f50624dd2f1a9fc'], '0x3fb999999999999a'], // cbrt(0.001) = 0.1
  ['cbrt', ['0x7fefffffffffffff'], '0x554428a2f98d728b'], // cbrt(1.7976931348623157e+308) = 5.643803094122362e+102
  ['cbrt', ['0x01a56e1fc2f8f359'], '0x2b2bff2ee48e0530'], // cbrt(1e-300) = 1e-100
  ['cbrt', ['0xc008000000000000'], '0xbff7137449123ef6'], // cbrt(-3) = -1.4422495703074083
  ['cbrt', ['0x4020000000000001'], '0x4000000000000000'], // cbrt(8.000000000000002) = 2
  ['atan2', ['0x3ff0000000000000', '0x3ff0000000000000'], '0x3fe921fb54442d18'], // atan2(1, 1) = 0.7853981633974483
  ['atan2', ['0x01a56e1fc2f8f359', '0x7e37e43c8800759c'], '0x0000000000000000'], // atan2(1e-300, 1e+300) = 0
  ['atan2', ['0x7e37e43c8800759c', '0x01a56e1fc2f8f359'], '0x3ff921fb54442d18'], // atan2(1e+300, 1e-300) = 1.5707963267948966
  ['atan2', ['0xbff0000000000000', '0xbff0000000000000'], '0xc002d97c7f3321d2'], // atan2(-1, -1) = -2.356194490192345
  ['atan2', ['0x3ff0000000000000', '0x81a56e1fc2f8f359'], '0x3ff921fb54442d18'], // atan2(1, -1e-300) = 1.5707963267948966
  ['atan2', ['0x81a56e1fc2f8f359', '0xbff0000000000000'], '0xc00921fb54442d18'], // atan2(-1e-300, -1) = -3.141592653589793
  ['atan2', ['0x4008000000000000', '0x4010000000000000'], '0x3fe4978fa3269ee1'], // atan2(3, 4) = 0.6435011087932844
  ['atan2', ['0xc008000000000000', '0x4010000000000000'], '0xbfe4978fa3269ee1'], // atan2(-3, 4) = -0.6435011087932844
  ['atan2', ['0x000730d67819e8d2', '0x4000000000000000'], '0x0003986b3c0cf469'], // atan2(1e-308, 2) = 5e-309
  ['atan2', ['0x0000000000000001', '0xbff0000000000000'], '0x400921fb54442d18'], // atan2(5e-324, -1) = 3.141592653589793
  ['atan2', ['0x4000000000000000', '0x3ff0000000000001'], '0x3ff1b6e192ebbe44'], // atan2(2, 1.0000000000000002) = 1.1071487177940904
  ['pow', ['0x4000000000000000', '0x3fe0000000000000'], '0x3ff6a09e667f3bcd'], // pow(2, 0.5) = 1.4142135623730951
  ['pow', ['0x4000000000000000', '0xc090c80000000000'], '0x0000000000000001'], // pow(2, -1074) = 5e-324
  ['pow', ['0x4000000000000000', '0x408ff80000000000'], '0x7fe0000000000000'], // pow(2, 1023) = 8.98846567431158e+307
  ['pow', ['0x4000000000000000', '0x4090000000000000'], '0x7ff0000000000000'], // pow(2, 1024) = null
  ['pow', ['0x4000000000000000', '0xc090cc0000000000'], '0x0000000000000000'], // pow(2, -1075) = 0
  ['pow', ['0x4024000000000000', '0x4036000000000000'], '0x4480f0cf064dd592'], // pow(10, 22) = 1e+22
  ['pow', ['0x4024000000000000', '0x4073400000000000'], '0x7fe1ccf385ebc8a0'], // pow(10, 308) = 1e+308
  ['pow', ['0x4024000000000000', '0xc074300000000000'], '0x0000000000000002'], // pow(10, -323) = 1e-323
  ['pow', ['0x3ff000001ad7f29b', '0x41cdcd6500000000'], '0x48f349445c228792'], // pow(1.0000001, 1000000000) = 2.6881038582144647e+43
  ['pow', ['0x3fefffffffffffff', '0x43d0000000000000'], '0x11c44109edb2088f'], // pow(0.9999999999999999, 4611686018427388000) = 4.377491037052927e-223
  ['pow', ['0xc000000000000000', '0x4008000000000000'], '0xc020000000000000'], // pow(-2, 3) = -8
  ['pow', ['0xc000000000000000', '0x408ff80000000000'], '0xffe0000000000000'], // pow(-2, 1023) = -8.98846567431158e+307
  ['pow', ['0xc000000000000000', '0xc090cc0000000000'], '0x8000000000000000'], // pow(-2, -1075) = 0
  ['pow', ['0x401c000000000000', '0x3fd5555555555555'], '0x3ffe9b5dba58189d'], // pow(7, 0.3333333333333333) = 1.912931182772389
  ['pow', ['0x01a56e1fc2f8f359', '0x01a56e1fc2f8f359'], '0x3ff0000000000000'], // pow(1e-300, 1e-300) = 1
  ['pow', ['0x3fe0000000000000', '0x4090c80000000000'], '0x0000000000000001'], // pow(0.5, 1074) = 5e-324
  ['pow', ['0x3ff0000000000001', '0x4330000000000000'], '0x4005bf0a8b145768'], // pow(1.0000000000000002, 4503599627370496) = 2.7182818284590446; 1 ulp from correctly rounded 0x4005bf0a8b145769
  ['pow', ['0x4008000000000000', '0x3fe0000000000000'], '0x3ffbb67ae8584caa'], // pow(3, 0.5) = 1.7320508075688772
  ['pow', ['0xbfe0000000000000', '0x4008000000000000'], '0xbfc0000000000000'], // pow(-0.5, 3) = -0.125
  ['pow', ['0x4004000000000000', '0xc004000000000000'], '0x3fb9e7c6e43390b7'], // pow(2.5, -2.5) = 0.10119288512538814
  ['pow', ['0x4202a05f20000000', '0x403e000000000000'], '0x7e37e43c8800759c'], // pow(10000000000, 30) = 1e+300
  ['pow', ['0x0000000000000001', '0x3fe0000000000000'], '0x1e60000000000000'], // pow(5e-324, 0.5) = 2.2227587494850775e-162
  ['pow', ['0x3ff8000000000000', '0x409b54cccccccccd'], '0x7fe296e1323efeab'], // pow(1.5, 1749.2) = 1.0443121725692963e+308
  ['hypot', ['0x7fe1ccf385ebc8a0', '0x7fe1ccf385ebc8a0'], '0x7fe92c80954c51f5'], // hypot(1e+308, 1e+308) = 1.4142135623730951e+308
  ['hypot', ['0x4008000000000000', '0x4010000000000000'], '0x4014000000000000'], // hypot(3, 4) = 5
  ['hypot', ['0x0000000000000001', '0x0000000000000001'], '0x0000000000000001'], // hypot(5e-324, 5e-324) = 5e-324
  ['hypot', ['0x000012688b70e62b', '0x000001d74124e3d1'], '0x000012800c7e35b3'], // hypot(1e-310, 1e-311) = 1.0049875621121e-310
  ['hypot', ['0x7e37e43c8800759c', '0x01a56e1fc2f8f359'], '0x7e37e43c8800759c'], // hypot(1e+300, 1e-300) = 1e+300
  ['hypot', ['0x3ff0000000000000', '0x3c9cd2b297d889bc'], '0x3ff0000000000000'], // hypot(1, 1e-16) = 1
  ['hypot', ['0x5f30000000000000', '0x5f30000000000000'], '0x5f36a09e667f3bcd'], // hypot(3.273390607896142e+150, 3.273390607896142e+150) = 4.629273392631434e+150
  ['hypot', ['0x7fefffffffffffff', '0x3ff0000000000000'], '0x7fefffffffffffff'], // hypot(1.7976931348623157e+308, 1) = 1.7976931348623157e+308
  ['hypot', ['0x16687e92154ef7ac', '0x16687e92154ef7ac'], '0x167151f68876f410'], // hypot(1e-200, 1e-200) = 1.414213562373095e-200
  ['hypot', ['0xc014000000000000', '0x4028000000000000'], '0x402a000000000000'], // hypot(-5, 12) = 13
  ['hypot', ['0x3ff0000000000000', '0x3ff0000000000000'], '0x3ff6a09e667f3bcd'], // hypot(1, 1) = 1.4142135623730951
];

const PI = Math.PI;
/** ECMAScript special values (ECMA-262 §21.3.2 and Number::exponentiate), including every signed-zero case. */
const ES_SPECIAL: [string, number[], number][] = [
  ['sin', [0], 0], ['sin', [-0], -0], ['sin', [Infinity], NaN], ['sin', [-Infinity], NaN], ['sin', [NaN], NaN],
  ['cos', [0], 1], ['cos', [-0], 1], ['cos', [Infinity], NaN], ['cos', [NaN], NaN],
  ['tan', [0], 0], ['tan', [-0], -0], ['tan', [-Infinity], NaN], ['tan', [NaN], NaN],
  ['asin', [0], 0], ['asin', [-0], -0], ['asin', [1], PI / 2], ['asin', [-1], -PI / 2], ['asin', [1.0000000000000002], NaN], ['asin', [-Infinity], NaN],
  ['acos', [1], 0], ['acos', [-1], PI], ['acos', [0], PI / 2], ['acos', [-1.0000000000000002], NaN], ['acos', [NaN], NaN],
  ['atan', [0], 0], ['atan', [-0], -0], ['atan', [Infinity], PI / 2], ['atan', [-Infinity], -PI / 2], ['atan', [NaN], NaN],
  ['sinh', [0], 0], ['sinh', [-0], -0], ['sinh', [Infinity], Infinity], ['sinh', [-Infinity], -Infinity], ['sinh', [711], Infinity], ['sinh', [-711], -Infinity],
  ['cosh', [0], 1], ['cosh', [-0], 1], ['cosh', [Infinity], Infinity], ['cosh', [-Infinity], Infinity], ['cosh', [-711], Infinity], ['cosh', [NaN], NaN],
  ['tanh', [0], 0], ['tanh', [-0], -0], ['tanh', [Infinity], 1], ['tanh', [-Infinity], -1], ['tanh', [NaN], NaN],
  ['asinh', [0], 0], ['asinh', [-0], -0], ['asinh', [Infinity], Infinity], ['asinh', [-Infinity], -Infinity], ['asinh', [NaN], NaN],
  ['acosh', [1], 0], ['acosh', [0.9999999999999999], NaN], ['acosh', [-0], NaN], ['acosh', [Infinity], Infinity], ['acosh', [-Infinity], NaN],
  ['atanh', [0], 0], ['atanh', [-0], -0], ['atanh', [1], Infinity], ['atanh', [-1], -Infinity], ['atanh', [1.0000000000000002], NaN], ['atanh', [Infinity], NaN],
  ['exp', [0], 1], ['exp', [-0], 1], ['exp', [Infinity], Infinity], ['exp', [-Infinity], 0], ['exp', [NaN], NaN],
  ['exp', [709.782712893384], 1.7976931348622732e308], ['exp', [709.7827128933841], Infinity], ['exp', [-745.1332191019411], 5e-324], ['exp', [-745.1332191019412], 0],
  ['expm1', [0], 0], ['expm1', [-0], -0], ['expm1', [Infinity], Infinity], ['expm1', [-Infinity], -1], ['expm1', [NaN], NaN],
  ['log', [0], -Infinity], ['log', [-0], -Infinity], ['log', [1], 0], ['log', [-5e-324], NaN], ['log', [Infinity], Infinity], ['log', [-Infinity], NaN],
  ['log1p', [0], 0], ['log1p', [-0], -0], ['log1p', [-1], -Infinity], ['log1p', [-1.0000000000000002], NaN], ['log1p', [Infinity], Infinity], ['log1p', [-Infinity], NaN],
  ['log2', [0], -Infinity], ['log2', [-0], -Infinity], ['log2', [1], 0], ['log2', [-1], NaN], ['log2', [Infinity], Infinity], ['log2', [8], 3], ['log2', [5e-324], -1074],
  ['log10', [0], -Infinity], ['log10', [-0], -Infinity], ['log10', [1], 0], ['log10', [-1], NaN], ['log10', [Infinity], Infinity], ['log10', [1000], 3],
  ['cbrt', [0], 0], ['cbrt', [-0], -0], ['cbrt', [Infinity], Infinity], ['cbrt', [-Infinity], -Infinity], ['cbrt', [NaN], NaN], ['cbrt', [-27], -3],
  // atan2(y, x): every signed zero and infinity combination.
  ['atan2', [0, 0], 0], ['atan2', [-0, 0], -0], ['atan2', [0, -0], PI], ['atan2', [-0, -0], -PI],
  ['atan2', [0, 1], 0], ['atan2', [-0, 1], -0], ['atan2', [0, -1], PI], ['atan2', [-0, -1], -PI],
  ['atan2', [0, Infinity], 0], ['atan2', [-0, Infinity], -0], ['atan2', [0, -Infinity], PI], ['atan2', [-0, -Infinity], -PI],
  ['atan2', [1, 0], PI / 2], ['atan2', [1, -0], PI / 2], ['atan2', [-1, 0], -PI / 2], ['atan2', [-1, -0], -PI / 2],
  ['atan2', [1, Infinity], 0], ['atan2', [-1, Infinity], -0], ['atan2', [1, -Infinity], PI], ['atan2', [-1, -Infinity], -PI],
  ['atan2', [Infinity, 1], PI / 2], ['atan2', [-Infinity, 1], -PI / 2], ['atan2', [Infinity, -1], PI / 2], ['atan2', [-Infinity, -0], -PI / 2],
  ['atan2', [Infinity, Infinity], PI / 4], ['atan2', [-Infinity, Infinity], -PI / 4],
  ['atan2', [Infinity, -Infinity], 3 * PI / 4], ['atan2', [-Infinity, -Infinity], -3 * PI / 4],
  ['atan2', [NaN, 1], NaN], ['atan2', [1, NaN], NaN], ['atan2', [NaN, NaN], NaN],
  ['atan2', [-5e-324, 1e300], -0], ['atan2', [5e-324, 1e300], 0], ['atan2', [5e-324, -1e300], PI], ['atan2', [-5e-324, -1e300], -PI],
  // pow: Number::exponentiate, in spec order.
  ['pow', [2, NaN], NaN], ['pow', [1, NaN], NaN], ['pow', [NaN, NaN], NaN],
  ['pow', [NaN, 0], 1], ['pow', [NaN, -0], 1], ['pow', [Infinity, 0], 1], ['pow', [-Infinity, -0], 1], ['pow', [0, 0], 1],
  ['pow', [NaN, 1], NaN],
  ['pow', [Infinity, 0.5], Infinity], ['pow', [Infinity, -0.5], 0],
  ['pow', [-Infinity, 3], -Infinity], ['pow', [-Infinity, 2], Infinity], ['pow', [-Infinity, 0.5], Infinity],
  ['pow', [-Infinity, -3], -0], ['pow', [-Infinity, -2], 0], ['pow', [-Infinity, -0.5], 0],
  ['pow', [0, 3], 0], ['pow', [0, 0.5], 0], ['pow', [0, -3], Infinity], ['pow', [0, -0.5], Infinity],
  ['pow', [-0, 3], -0], ['pow', [-0, 2], 0], ['pow', [-0, 0.5], 0], ['pow', [-0, Infinity], 0],
  ['pow', [-0, -1], -Infinity], ['pow', [-0, -3], -Infinity], ['pow', [-0, -2], Infinity], ['pow', [-0, -0.5], Infinity], ['pow', [-0, -Infinity], Infinity],
  ['pow', [2, Infinity], Infinity], ['pow', [-2, Infinity], Infinity], ['pow', [0.5, Infinity], 0], ['pow', [-0.5, Infinity], 0],
  ['pow', [2, -Infinity], 0], ['pow', [-2, -Infinity], 0], ['pow', [0.5, -Infinity], Infinity], ['pow', [-0.5, -Infinity], Infinity],
  ['pow', [1, Infinity], NaN], ['pow', [-1, Infinity], NaN], ['pow', [1, -Infinity], NaN], ['pow', [-1, -Infinity], NaN],
  ['pow', [-8, 1 / 3], NaN], ['pow', [-2, 0.5], NaN], ['pow', [-1, 0.5], NaN],
  ['pow', [1, 5], 1], ['pow', [-1, 5], -1], ['pow', [-1, 2 ** 53], 1], ['pow', [-1, 2 ** 52 + 1], -1], ['pow', [-2, 3], -8],
  ['pow', [-2, 1e300], Infinity], ['pow', [-0.5, 1e300], 0], ['pow', [-2, 1023], -(2 ** 1023)], ['pow', [2, -1074], 5e-324],
  // hypot: ToNumber all first; any infinity wins over NaN; no arguments or only zeros give +0.
  ['hypot', [], 0], ['hypot', [-0], 0], ['hypot', [-0, -0], 0], ['hypot', [-0, -0, -0], 0],
  ['hypot', [NaN], NaN], ['hypot', [Infinity], Infinity], ['hypot', [-Infinity], Infinity],
  ['hypot', [NaN, Infinity], Infinity], ['hypot', [-Infinity, NaN], Infinity], ['hypot', [NaN, 1, -Infinity], Infinity],
  ['hypot', [NaN, 1], NaN], ['hypot', [1, 2, NaN], NaN],
  ['hypot', [-3], 3], ['hypot', [3, 4], 5], ['hypot', [3, -4, 12], 13], ['hypot', [1e308, 1e308, 1e308], 1.7320508075688774e308],
];

/** One policy answers both batch requests (seeded inputs) and explicit hex-encoded calls with result bit patterns. */
const PROBE = `
  var gen = ${MATH_INPUTS_SOURCE};
  var hex = ${HEX_SOURCE};
  var NAMES = ${JSON.stringify(MATH_FUNCTIONS)};
  var BINARY = ${JSON.stringify(BINARY_FUNCTIONS)};
  var F = new Float64Array(1), W = new Uint32Array(F.buffer);
  F[0] = 1;
  var HI = W[1] === 0x3ff00000 ? 1 : 0;
  function fromHex(h) { W[HI] = parseInt(h.slice(2, 10), 16); W[1 - HI] = parseInt(h.slice(10), 16); return F[0]; }
  function think(obs) {
    var out = [], i;
    if (obs.calls) {
      for (i = 0; i < obs.calls.length; i++) out.push(hex(Math[obs.calls[i][0]].apply(Math, obs.calls[i][1].map(fromHex))));
      return [out.join(',')];
    }
    var binary = BINARY.indexOf(obs.fn) >= 0, xs = gen(NAMES.indexOf(obs.fn), obs.n, binary), f = Math[obs.fn];
    for (i = 0; i < obs.n; i++) out.push(hex(binary ? f(xs[2 * i], xs[2 * i + 1]) : f(xs[i])));
    return [out.join('')];
  }`;

async function loadJs(source: string): Promise<PolicyInstance> {
  const r = await loadPolicy('js', source, limits({ msPerCall: 20000, memoryBytes: 64 << 20 }));
  if (!r.ok) throw new Error(`load failed: ${JSON.stringify(r.error)}`);
  return r.instance;
}

/** Runs [fn, args] calls in the sandbox; result bit patterns as '0x…'. */
async function sandboxCalls(p: PolicyInstance, calls: [string, number[]][]): Promise<string[]> {
  const out = ok(await p.call({ calls: calls.map(([fn, args]) => [fn, args.map((a) => '0x' + hex(a))]) })).intents[0] as string;
  return out.split(',').map((h) => '0x' + h);
}

describe('deterministic Math', () => {
  it('names the runtime it pins in surfaceHash', () => {
    expect(DETERMINISTIC_MATH_VERSION).toBe('fdlibm-5.3-js/1');
    expect(POLICY_RUNTIME).toEqual({ js: POLICY_JS_ENGINE, math: DETERMINISTIC_MATH_VERSION });
    expect(DETERMINISTIC_MATH_FUNCTIONS).toHaveLength(22);
  });

  it('matches the msun C reference on hard cases, bit for bit (Node and sandbox)', async () => {
    const p = await loadJs(PROBE);
    try {
      const sandbox = await sandboxCalls(p, VECTORS.map(([fn, args]) => [fn, args.map(fromHex)]));
      VECTORS.forEach(([fn, args, want], i) => {
        const got = '0x' + hex(port[fn]!(...args.map(fromHex)));
        expect({ fn, args, got }).toEqual({ fn, args, got: want });
        expect({ fn, args, sandbox: sandbox[i] }).toEqual({ fn, args, sandbox: want });
      });
    } finally {
      p.dispose();
    }
  });

  it('returns the ECMAScript special values (Node and sandbox)', async () => {
    const p = await loadJs(PROBE);
    try {
      const sandbox = await sandboxCalls(p, ES_SPECIAL.map(([fn, args]) => [fn, args]));
      ES_SPECIAL.forEach(([fn, args, want], i) => {
        const got = port[fn]!(...args);
        expect({ fn, args, got: Object.is(got, want) ? 'same' : got }).toEqual({ fn, args, got: 'same' });
        expect({ fn, args, sandbox: sandbox[i] }).toEqual({ fn, args, sandbox: '0x' + hex(want) });
      });
    } finally {
      p.dispose();
    }
  });

  it(`is bit-identical in Node and QuickJS, and equal to msun, on ${MATH_INPUTS} seeded inputs per function`, async () => {
    const p = await loadJs(PROBE);
    try {
      for (const [idx, fn] of MATH_FUNCTIONS.entries()) {
        const binary = BINARY_FUNCTIONS.includes(fn);
        const xs = gen(idx, MATH_INPUTS, binary);
        const f = port[fn]!;
        let node = '';
        for (let i = 0; i < MATH_INPUTS; i++) node += hex(binary ? f(xs[2 * i], xs[2 * i + 1]) : f(xs[i]));
        const sandbox = ok(await p.call({ fn, n: MATH_INPUTS })).intents[0] as string;
        if (sandbox !== node) {
          let i = 0;
          while (sandbox.slice(16 * i, 16 * i + 16) === node.slice(16 * i, 16 * i + 16)) i++;
          const args = binary ? [xs[2 * i], xs[2 * i + 1]] : [xs[i]];
          expect.fail(`${fn}(${args.join(', ')}): node ${node.slice(16 * i, 16 * i + 16)} sandbox ${sandbox.slice(16 * i, 16 * i + 16)}`);
        }
        expect({ fn, digest: createHash('sha256').update(node).digest('hex') }).toEqual({ fn, digest: REFERENCE_DIGESTS[fn] });
      }
    } finally {
      p.dispose();
    }
  }, 120_000);

  it('converts each argument with ToNumber once, in order, and survives re-entrant conversions', () => {
    const seen: string[] = [];
    const arg = (tag: string, v: number) => ({ valueOf: () => (seen.push(tag), v) });
    expect(port.hypot!(arg('a', 3), arg('b', NaN), arg('c', Infinity), arg('d', 4))).toBe(Infinity);
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    seen.length = 0;
    expect(port.atan2!(arg('y', 1), arg('x', 1))).toBe(PI / 4);
    expect(port.pow!(arg('b', 2), arg('e', 10))).toBe(1024);
    expect(seen).toEqual(['y', 'x', 'b', 'e']);
    const nested = { valueOf: () => port.hypot!(5, 12, 0) };
    expect(port.hypot!(nested, 0, 0)).toBe(13);
    expect(port.hypot!(1e-300, 1e-300, nested)).toBe(port.hypot!(port.hypot!(1e-300, 1e-300), 13));
    expect(() => port.sin!(1n)).toThrow(TypeError);
  });

  it('installs ordinary native-shaped properties that a policy cannot break by tampering with builtins', async () => {
    for (const name of DETERMINISTIC_MATH_FUNCTIONS) {
      const f = port[name]!;
      expect({ name: f.name, length: f.length }).toEqual({ name, length: (Math as unknown as Record<string, MathFn>)[name]!.length });
    }
    const p = await loadJs(`
      var NAMES = ${JSON.stringify(MATH_FUNCTIONS)};
      var hex = ${HEX_SOURCE};
      var shapes = NAMES.map(function (n) {
        var d = Object.getOwnPropertyDescriptor(Math, n), ctor;
        try { new d.value(1); ctor = true; } catch (e) { ctor = e instanceof TypeError ? false : String(e); }
        return [n, d.writable, d.enumerable, d.configurable, d.value.name, d.value.length, 'prototype' in d.value, ctor];
      });
      var enumerable = Object.keys(Math);
      var leaked = ['M', 'F', 'W', 'D', 'HI', 'LO', 'IPIO2', 'words', 'scalbn', 'remPio2', 'kernelSin', 'hypot2', 'ldexpExp', 'sqrt', 'defineProperty']
        .filter(function (k) { return Object.prototype.hasOwnProperty.call(globalThis, k); });
      // Tamper with everything the port could depend on at call time.
      Math.sqrt = function () { return 0; };
      Float64Array = Int32Array = Uint32Array = null;
      Function.prototype.apply = Function.prototype.call = Array.prototype.push = null;
      Object.defineProperty = null;
      Math.sin = function () { return 42; };
      delete Math.cos;
      function think() {
        // Grouped: at most maxIntentsPerCall (8) top-level entries survive.
        return [shapes, enumerable, leaked, [Math.sin(1), typeof Math.cos], [
          hex(Math.tan(1e22)), hex(Math.asin(0.5)), hex(Math.acos(0.5)), hex(Math.hypot(1e308, 1e308)), hex(Math.hypot(1, 2, 3)),
          hex(Math.pow(2, 0.5)), hex(Math.acosh(10)), hex(Math.asinh(3)), Math.sqrt(4)]];
      }`);
    try {
      const [shapes, enumerable, leaked, [sin, cos], rest] = ok(await p.call({})).intents as [unknown[][], string[], string[], [number, string], unknown[]];
      expect(shapes).toEqual(DETERMINISTIC_MATH_FUNCTIONS.map((n) => [n, true, false, true, n, n === 'atan2' || n === 'pow' || n === 'hypot' ? 2 : 1, false, false]));
      expect(enumerable).toEqual([]);
      expect(leaked).toEqual([]);
      expect([sin, cos]).toEqual([42, 'undefined']);
      expect(rest).toEqual([
        hex(port.tan!(1e22)), hex(port.asin!(0.5)), hex(port.acos!(0.5)), hex(port.hypot!(1e308, 1e308)), hex(port.hypot!(1, 2, 3)),
        hex(port.pow!(2, 0.5)), hex(port.acosh!(10)), hex(port.asinh!(3)), 0,
      ]);
      expect(port.hypot!(1e308, 1e308)).toBe(1.4142135623730951e308);
    } finally {
      p.dispose();
    }
  });
});
