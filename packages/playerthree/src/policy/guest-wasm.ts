/** Core WebAssembly policy guest (runs inside the sandbox worker). The module was validated by the host. */
import type { PolicyLimits } from '../manifest.ts';
import { MAX_OUTPUT_BYTES } from './channel.ts';
import { engineMessage, failure, type Guest, type GuestLoad, type GuestResult } from './guest.ts';
import { decodeTruncated } from './text.ts';

type Alloc = (len: number) => number;
type Think = (ptr: number, len: number) => unknown;

export function loadWasm(module: WebAssembly.Module, limits: PolicyLimits, matchDataJson: string, begin: () => void): GuestLoad {
  const logs: string[] = [];
  let memory: WebAssembly.Memory | undefined;

  const log = (ptr: number, len: number): void => {
    if (logs.length >= limits.maxLogLines || !memory) return;
    const p = ptr >>> 0;
    const n = len >>> 0;
    const buf = memory.buffer;
    if (p + n > buf.byteLength) throw new RangeError('log: region outside memory');
    // A UTF-8 sequence is at most 4 bytes; reading a few extra lets an over-long line be cut on a character boundary.
    const bytes = new Uint8Array(buf, p, Math.min(n, limits.maxLogLineBytes + 4));
    logs.push(decodeTruncated(bytes, limits.maxLogLineBytes));
  };

  begin();
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(module, { env: { log } });
  } catch (e) {
    return failure('threw', engineMessage(e), false);
  }
  const ex = instance.exports;
  if (!(ex.memory instanceof WebAssembly.Memory) || typeof ex.alloc !== 'function' || typeof ex.think !== 'function') {
    return failure('missing_export', 'module must export memory, alloc and think', false);
  }
  memory = ex.memory;
  const mem = ex.memory;
  const alloc = ex.alloc as Alloc;
  const think = ex.think as Think;
  if (typeof ex.init === 'function') {
    try {
      const bytes = new TextEncoder().encode(matchDataJson);
      const ptr = alloc(bytes.length) >>> 0;
      if (ptr + bytes.length > mem.buffer.byteLength) return failure('bad_output', 'alloc returned an initialization region outside memory', false);
      new Uint8Array(mem.buffer, ptr, bytes.length).set(bytes);
      (ex.init as (ptr: number, len: number) => void)(ptr, bytes.length);
    } catch (e) {
      return failure('threw', engineMessage(e), false);
    }
  }

  const bad = (message: string): GuestResult => ({ ...failure('bad_output', message, false), logs });

  const run = (data: Uint8Array, len: number): GuestResult => {
    logs.length = 0;
    try {
      const ptr = alloc(len) >>> 0;
      if (ptr + len > mem.buffer.byteLength) return bad('alloc returned a region outside memory');
      new Uint8Array(mem.buffer, ptr, len).set(data.subarray(0, len));
      const r = think(ptr, len);
      if (typeof r !== 'bigint') return bad('think must return an i64');
      const packed = BigInt.asUintN(64, r);
      const outPtr = Number(packed >> 32n);
      const outLen = Number(packed & 0xffffffffn);
      if (outLen > MAX_OUTPUT_BYTES) return bad(`output larger than ${MAX_OUTPUT_BYTES} bytes`);
      if (outPtr + outLen > mem.buffer.byteLength) return bad('think returned a region outside memory');
      return { ok: true, out: new Uint8Array(mem.buffer, outPtr, outLen), logs };
    } catch (e) {
      return { ...failure('threw', engineMessage(e), false), logs };
    }
  };

  const guest: Guest = {
    call(data, len, budget) {
      const r = run(data, len);
      // A module cannot be interrupted: an overrun is judged once it returns (the host watchdog stops a hang) and kills
      // the instance, as every non-JS timeout does (spec §11).
      return budget.exceeded() ? { ...failure('timeout', undefined, true), logs: [] } : r;
    },
  };
  return { ok: true, guest };
}
