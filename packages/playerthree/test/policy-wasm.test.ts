import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import wabtInit from 'wabt';
import { MATCH_DATA_MAX_BYTES, type PolicyLimits } from '../src/manifest.ts';
import { loadPolicy, type PolicyInstance } from '../src/policy/index.ts';
import { limits, measure, observation50k, ok } from './policy-fixtures.ts';

let wabt: Awaited<ReturnType<typeof wabtInit>>;
beforeAll(async () => {
  wabt = await wabtInit();
});

function wat(src: string): Uint8Array {
  const m = wabt.parseWat('policy.wat', src, { bulk_memory: true, memory64: true });
  try {
    m.validate();
    return m.toBinary({}).buffer;
  } finally {
    m.destroy();
  }
}

const live: PolicyInstance[] = [];
afterEach(() => {
  for (const p of live.splice(0)) p.dispose();
});

async function load(src: string, over: Partial<PolicyLimits> = {}): Promise<PolicyInstance> {
  const r = await loadPolicy('wasm', wat(src), limits(over));
  if (!r.ok) throw new Error(`load failed: ${JSON.stringify(r.error)}`);
  live.push(r.instance);
  return r.instance;
}

/** Places the observation at 32 KiB, growing memory to fit it. */
const ALLOC = `
  (func (export "alloc") (param $len i32) (result i32)
    (local $need i32)
    (local.set $need (i32.shr_u (i32.add (i32.add (local.get $len) (i32.const 32768)) (i32.const 65535)) (i32.const 16)))
    (if (i32.gt_u (local.get $need) (memory.size))
      (then (drop (memory.grow (i32.sub (local.get $need) (memory.size))))))
    (i32.const 32768))`;

/** Writes `bytes` (a WAT string literal) at 1024 and returns it as the packed (ptr << 32 | len) result. */
const returning = (literal: string, len: number) => `
  (module
    (memory (export "memory") 1 4)
    (data (i32.const 1024) "${literal}")
    ${ALLOC}
    (func (export "think") (param i32 i32) (result i64)
      (i64.or (i64.shl (i64.const 1024) (i64.const 32)) (i64.const ${len}))))`;

/**
 * Reference policy: counts `{` in the observation (one per unit object) and answers
 * `[{"kind":"ping","len":<obs bytes>,"objs":<count>,"n":<calls since init>}]`; logs "think called" each call.
 */
const PING = `
(module
  (import "env" "log" (func $log (param i32 i32)))
  (memory (export "memory") 1 16)
  (global $calls (mut i32) (i32.const 0))
  (data (i32.const 0) "[{\\"kind\\":\\"ping\\",\\"len\\":")
  (data (i32.const 32) ",\\"objs\\":")
  (data (i32.const 48) ",\\"n\\":")
  (data (i32.const 56) "}]")
  (data (i32.const 64) "think called")
  (func $itoa (param $dst i32) (param $n i32) (result i32)
    (local $end i32) (local $t i32)
    (local.set $t (local.get $n))
    (local.set $end (i32.add (local.get $dst) (i32.const 1)))
    (block $done (loop $count
      (local.set $t (i32.div_u (local.get $t) (i32.const 10)))
      (br_if $done (i32.eqz (local.get $t)))
      (local.set $end (i32.add (local.get $end) (i32.const 1)))
      (br $count)))
    (local.set $t (local.get $end))
    (loop $write
      (local.set $t (i32.sub (local.get $t) (i32.const 1)))
      (i32.store8 (local.get $t) (i32.add (i32.const 48) (i32.rem_u (local.get $n) (i32.const 10))))
      (local.set $n (i32.div_u (local.get $n) (i32.const 10)))
      (br_if $write (i32.gt_u (local.get $t) (local.get $dst))))
    (local.get $end))
  (func (export "init") (param i32 i32) (global.set $calls (i32.const 1000)))
  ${ALLOC}
  (func (export "think") (param $ptr i32) (param $len i32) (result i64)
    (local $p i32) (local $i i32) (local $objs i32)
    (global.set $calls (i32.add (global.get $calls) (i32.const 1)))
    (call $log (i32.const 64) (i32.const 12))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $ptr) (local.get $i))) (i32.const 123))
        (then (local.set $objs (i32.add (local.get $objs) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (memory.copy (i32.const 1024) (i32.const 0) (i32.const 22))
    (local.set $p (call $itoa (i32.const 1046) (local.get $len)))
    (memory.copy (local.get $p) (i32.const 32) (i32.const 8))
    (local.set $p (call $itoa (i32.add (local.get $p) (i32.const 8)) (local.get $objs)))
    (memory.copy (local.get $p) (i32.const 48) (i32.const 5))
    (local.set $p (call $itoa (i32.add (local.get $p) (i32.const 5)) (global.get $calls)))
    (memory.copy (local.get $p) (i32.const 56) (i32.const 2))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (i64.or (i64.shl (i64.const 1024) (i64.const 32)) (i64.extend_i32_u (i32.sub (local.get $p) (i32.const 1024))))))`;

describe('wasm policy', () => {
  it('initializes once from separate UTF-8 JSON, retaining it across dynamic calls', async () => {
    const source = `(module
      (memory (export \"memory\") 1 4)
      (global $len (mut i32) (i32.const 0))
      (global $inits (mut i32) (i32.const 0))
      ${ALLOC}
      (func (export \"init\") (param $ptr i32) (param $len i32)
        (if (global.get $inits) (then unreachable))
        (global.set $inits (i32.const 1))
        (global.set $len (local.get $len))
        (memory.copy (i32.const 1024) (local.get $ptr) (local.get $len)))
      (func (export \"think\") (param i32 i32) (result i64)
        (if (i32.ne (global.get $inits) (i32.const 1)) (then unreachable))
        (i64.or (i64.shl (i64.const 1024) (i64.const 32)) (i64.extend_i32_u (global.get $len)))))`;
    const data = [{ kind: 'bootstrap', value: 'é' }];
    const loading = loadPolicy('wasm', wat(source), limits(), { matchData: data });
    data[0]!.value = 'changed';
    const loaded = await loading;
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    live.push(loaded.instance);
    for (const tick of [1, 2]) expect(ok(await loaded.instance.call({ tick })).intents).toEqual([{ kind: 'bootstrap', value: 'é' }]);
  });

  it('loads null bootstrap by default and rejects invalid initialization regions and traps', async () => {
    const source = (alloc: string, init: string) => `(module
      (memory (export \"memory\") 1 1)
      ${alloc}
      (func (export \"init\") (param $ptr i32) (param $len i32) ${init})
      (data (i32.const 1024) \"[]\")
      (func (export \"think\") (param i32 i32) (result i64) (i64.const 4398046511106)))`;
    const valid = await loadPolicy('wasm', wat(source(ALLOC,
      '(if (i32.ne (local.get $len) (i32.const 4)) (then unreachable)) (if (i32.ne (i32.load (local.get $ptr)) (i32.const 1819047278)) (then unreachable))')), limits());
    if (!valid.ok) throw new Error(JSON.stringify(valid.error));
    live.push(valid.instance);
    expect(ok(await valid.instance.call({})).intents).toEqual([]);
    const invalidAlloc = '(func (export \"alloc\") (param i32) (result i32) (i32.const -1))';
    expect(await loadPolicy('wasm', wat(source(invalidAlloc, '')), limits(), { matchData: {} })).toMatchObject({ ok: false, error: { code: 'bad_output' } });
    expect(await loadPolicy('wasm', wat(source(ALLOC, 'unreachable')), limits())).toMatchObject({ ok: false, error: { code: 'threw' } });
    expect(await loadPolicy('wasm', wat(source(ALLOC, '')), limits(), { matchData: 'x'.repeat(MATCH_DATA_MAX_BYTES) })).toMatchObject({ ok: false, error: { code: 'too_large' } });
  });

  it('runs a WAT policy: observation in, intents out, init, state and logs', async () => {
    const p = await load(PING);
    const obs = { tick: 3, units: [{ id: 'u_1' }, { id: 'u_2' }] };
    const len = Buffer.byteLength(JSON.stringify(obs));
    const first = ok(await p.call(obs));
    expect(first.intents).toEqual([{ kind: 'ping', len, objs: 3, n: 1001 }]);
    expect(first.logs).toEqual(['think called']);
    expect(first.dropped).toBe(0);
    const big = { units: Array.from({ length: 2000 }, (_, i) => ({ id: `u_${i}`, x: i })) };
    const second = ok(await p.call(big));
    expect(second.intents).toEqual([{ kind: 'ping', len: Buffer.byteLength(JSON.stringify(big)), objs: 2001, n: 1002 }]);
    expect(p.dead).toBe(false);
  });

  it('handles a ~50 KB observation well inside a tick budget', async () => {
    const p = await load(PING);
    const obs = observation50k();
    const stats = await measure(p, obs);
    console.log(`[perf] wasm ${stats.bytes} B obs: mean ${stats.mean.toFixed(2)} ms, max ${stats.max.toFixed(2)} ms over ${stats.n} calls`);
    expect(stats.mean).toBeLessThan(20);
  });

  it('rejects imports other than env.log', async () => {
    const cases = [
      '(import "wasi_snapshot_preview1" "fd_write" (func (param i32 i32 i32 i32) (result i32)))',
      '(import "env" "now" (func (result f64)))',
      '(import "env" "log" (func (param i32)))',
      '(import "env" "table" (table 1 funcref))',
      '(import "env" "g" (global i32))',
    ];
    for (const imp of cases) {
      const src = `(module ${imp} (memory (export "memory") 1 1) ${ALLOC} (func (export "think") (param i32 i32) (result i64) (i64.const 0)))`;
      expect(await loadPolicy('wasm', wat(src), limits()), imp).toMatchObject({ ok: false, error: { code: 'imports_not_allowed' } });
    }
    const importedMemory = `(module (import "env" "memory" (memory 1 2)) (export "memory" (memory 0)) ${ALLOC} (func (export "think") (param i32 i32) (result i64) (i64.const 0)))`;
    expect(await loadPolicy('wasm', wat(importedMemory), limits())).toMatchObject({ ok: false, error: { code: 'imports_not_allowed' } });
  });

  it('requires a memory maximum within memoryBytes', async () => {
    const mod = (mem: string) => wat(`(module (memory (export "memory") ${mem}) ${ALLOC} (func (export "think") (param i32 i32) (result i64) (i64.const 0)))`);
    expect(await loadPolicy('wasm', mod('1'), limits())).toMatchObject({ ok: false, error: { code: 'memory_limit', message: expect.stringContaining('maximum') } });
    expect(await loadPolicy('wasm', mod('1 257'), limits({ memoryBytes: 16 << 20 }))).toMatchObject({
      ok: false,
      error: { code: 'memory_limit', message: 'memory 0 declares a maximum of 257 pages; the limit is 256 pages' },
    });
    const mem64 = wat('(module (memory (export "memory") i64 1 2) (func (export "alloc") (param i32) (result i32) (i32.const 0)) (func (export "think") (param i32 i32) (result i64) (i64.const 0)))');
    expect(await loadPolicy('wasm', mem64, limits())).toMatchObject({ ok: false, error: { code: 'bad_module', message: expect.stringContaining('64-bit') } });
    // A shared memory would let a policy park the thread in memory.atomic.wait instead of computing.
    const sm = wabt.parseWat('policy.wat', `(module (memory (export "memory") 1 2 shared) ${ALLOC} (func (export "think") (param i32 i32) (result i64) (i64.const 0)))`, { bulk_memory: true, threads: true });
    const shared = sm.toBinary({}).buffer;
    sm.destroy();
    expect(await loadPolicy('wasm', shared, limits())).toMatchObject({ ok: false, error: { code: 'bad_module', message: expect.stringContaining('shared') } });
    const ok256 = await loadPolicy('wasm', mod('1 256'), limits({ memoryBytes: 16 << 20 }));
    expect(ok256.ok).toBe(true);
    if (ok256.ok) ok256.instance.dispose();
  });

  it('requires the ABI exports with exact signatures', async () => {
    const think = '(func (export "think") (param i32 i32) (result i64) (i64.const 0))';
    const cases: [string, string][] = [
      [`(memory 1 1) ${ALLOC} ${think}`, 'memory'],
      [`(memory (export "memory") 1 1) ${think}`, 'alloc'],
      [`(memory (export "memory") 1 1) ${ALLOC}`, 'think'],
      [`(memory (export "memory") 1 1) ${ALLOC} (func (export "think") (param i32 i32) (result i32) (i32.const 0))`, 'think'],
      [`(memory (export "memory") 1 1) ${ALLOC} ${think} (func (export "init") (param i32))`, 'init'],
      [`(memory (export "memory") 1 1) ${ALLOC} ${think} (func (export "init"))`, 'init'],
      [`(memory (export "memory") 1 1) ${ALLOC} ${think} (func (export "init") (param i32 i32) (result i32) (i32.const 0))`, 'init'],
    ];
    for (const [body, name] of cases) {
      expect(await loadPolicy('wasm', wat(`(module ${body})`), limits()), name).toMatchObject({
        ok: false,
        error: { code: 'missing_export', message: expect.stringContaining(name) },
      });
    }
  });

  it('rejects malformed, oversized and string artifacts', async () => {
    expect(await loadPolicy('wasm', new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff]), limits())).toMatchObject({ ok: false, error: { code: 'bad_module' } });
    expect(await loadPolicy('wasm', wat(PING), limits({ maxArtifactBytes: 100 }))).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(await loadPolicy('wasm', '(module)', limits())).toMatchObject({ ok: false, error: { code: 'bad_module' } });
    expect(await loadPolicy('wasm', wat(PING), limits({ runtimes: ['js'] }))).toEqual({ ok: false, error: { code: 'runtime_not_allowed' } });
  });

  it('kills an infinite loop at the deadline and stays dead', async () => {
    const p = await load(`(module (memory (export "memory") 1 1) ${ALLOC}
      (func (export "think") (param i32 i32) (result i64) (loop $l (br $l)) (i64.const 0)))`, { msPerCall: 50 });
    const t0 = performance.now();
    expect(await p.call({})).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(p.dead).toBe(true);
    expect(await p.call({})).toMatchObject({ ok: false, error: { code: 'timeout' }, ms: 0 });
  });

  it('kills an instance whose call returns over its CPU budget (only JS keeps its state through a timeout)', async () => {
    // think spins len × 65536 rounds of an LCG, then answers []: the observation's size sets the work.
    const SPIN = `(module (memory (export "memory") 1 2) ${ALLOC} (data (i32.const 0) "[]")
      (func (export "think") (param $ptr i32) (param $len i32) (result i64)
        (local $n i64) (local $x i64)
        (local.set $n (i64.mul (i64.extend_i32_u (local.get $len)) (i64.const 65536)))
        (block $done (loop $l
          (br_if $done (i64.eqz (local.get $n)))
          (local.set $x (i64.add (i64.mul (local.get $x) (i64.const 6364136223846793005)) (i64.const 1)))
          (local.set $n (i64.sub (local.get $n) (i64.const 1)))
          (br $l)))
        (i64.store (i32.const 8) (local.get $x))
        (i64.const 2)))`;
    // Calibrate on an unconstrained instance, then aim for about 3 × a 20 ms budget: over it, well inside the hang guard.
    const probe = await load(SPIN);
    const pad = (n: number) => 'x'.repeat(n);
    const cpu = ok(await probe.call(pad(400))).cpuMs;
    const len = Math.max(400, Math.round((400 * 60) / Math.max(cpu, 1)));
    const p = await load(SPIN, { msPerCall: 20 });
    expect(await p.call(pad(len))).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(p.dead).toBe(true);
  });

  it('times out a start function or init that never returns', async () => {
    const start = `(module (memory (export "memory") 1 1) ${ALLOC} (func (export "think") (param i32 i32) (result i64) (i64.const 0))
      (func $spin (loop $l (br $l))) (start $spin))`;
    expect(await loadPolicy('wasm', wat(start), limits({ msPerCall: 10 }))).toMatchObject({ ok: false, error: { code: 'timeout' } });
    const init = `(module (memory (export "memory") 1 1) ${ALLOC} (func (export "think") (param i32 i32) (result i64) (i64.const 0))
      (func (export "init") (param i32 i32) (loop $l (br $l))))`;
    expect(await loadPolicy('wasm', wat(init), limits({ msPerCall: 10 }))).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('reports traps as threw and keeps the instance', async () => {
    const p = await load(`(module (memory (export "memory") 1 1) ${ALLOC}
      (func (export "think") (param $ptr i32) (param $len i32) (result i64)
        (if (i32.gt_u (local.get $len) (i32.const 10)) (then unreachable))
        (i64.or (i64.shl (i64.const 0) (i64.const 32)) (i64.const 2)))
      (data (i32.const 0) "[]"))`);
    expect(await p.call({ pad: 'xxxxxxxxxx' })).toMatchObject({ ok: false, error: { code: 'threw', message: expect.stringContaining('unreachable') } });
    expect(p.dead).toBe(false);
    expect(ok(await p.call(1)).intents).toEqual([]);
  });

  it('turns runaway recursion with large frames into a catchable stack overflow and keeps the instance', async () => {
    const locals = Array.from({ length: 2000 }, () => 'i64').join(' ');
    const p = await load(`(module (memory (export "memory") 1 1) ${ALLOC}
      (func $rec (param $n i32) (result i32) (local ${locals}) (call $rec (i32.add (local.get $n) (i32.const 1))))
      (func (export "think") (param $ptr i32) (param $len i32) (result i64)
        (if (i32.gt_u (local.get $len) (i32.const 10)) (then (drop (call $rec (i32.const 0)))))
        (i64.const 2))
      (data (i32.const 0) "[]"))`);
    for (let i = 0; i < 2; i++) {
      expect(await p.call({ pad: 'xxxxxxxxxx' })).toMatchObject({ ok: false, error: { code: 'threw', message: expect.stringContaining('call stack') } });
      expect(p.dead).toBe(false);
      expect(ok(await p.call(1)).intents).toEqual([]);
    }
  });

  it('reports non-array, non-JSON, invalid UTF-8 and out-of-bounds output as bad_output', async () => {
    const cases: [string, number][] = [
      ['{\\"kind\\":\\"x\\"}', 12],
      ['not json', 8],
      ['[\\"\\ff\\"]', 5],
    ];
    for (const [literal, len] of cases) {
      const p = await load(returning(literal, len));
      expect(await p.call({}), literal).toMatchObject({ ok: false, error: { code: 'bad_output' } });
      expect(p.dead).toBe(false);
    }
    const oob = await load(`(module (memory (export "memory") 1 1) ${ALLOC}
      (func (export "think") (param i32 i32) (result i64) (i64.or (i64.shl (i64.const 65000) (i64.const 32)) (i64.const 1000))))`);
    expect(await oob.call({})).toMatchObject({ ok: false, error: { code: 'bad_output', message: expect.stringContaining('outside memory') } });
  });

  it('rejects output nested deeper than 32 levels on the host, the only check a wasm module meets', async () => {
    // Values may sit at most 32 levels below the top-level array: an empty array or a scalar there is fine, a scalar
    // one level deeper is not.
    const nest = (n: number, inner: string) => '['.repeat(n) + inner + ']'.repeat(n);
    const emptyAtLimit = await load(returning(nest(33, ''), 66));
    expect(ok(await emptyAtLimit.call({})).intents).toHaveLength(1);
    const atLimit = await load(returning(nest(32, '1'), 65));
    expect(ok(await atLimit.call({})).intents).toHaveLength(1);
    const over = await load(returning(nest(33, '1'), 67));
    expect(await over.call({})).toMatchObject({ ok: false, error: { code: 'bad_output', message: 'output nested deeper than 32 levels' } });
    expect(over.dead).toBe(false);
    // 1 MiB of brackets: 512 Ki levels, which V8's JSON.parse accepts but any recursive consumer would overflow on.
    const half = 512 * 1024;
    const bomb = await load(`(module (memory (export "memory") 32 32)
      (func (export "alloc") (param i32) (result i32) (i32.const ${2 * half}))
      (func (export "think") (param i32 i32) (result i64)
        (memory.fill (i32.const 0) (i32.const 91) (i32.const ${half}))
        (memory.fill (i32.const ${half}) (i32.const 93) (i32.const ${half}))
        (i64.const ${2 * half})))`);
    expect(await bomb.call({})).toMatchObject({ ok: false, error: { code: 'bad_output', message: 'output nested deeper than 32 levels' } });
    expect(bomb.dead).toBe(false);
  });

  it('drops intents beyond maxIntentsPerCall', async () => {
    const intents = JSON.stringify(Array.from({ length: 5 }, (_, i) => i));
    const p = await load(returning(intents, intents.length), { maxIntentsPerCall: 2 });
    expect(ok(await p.call({}))).toMatchObject({ intents: [0, 1], dropped: 3 });
  });

  it('cannot grow memory past its declared maximum', async () => {
    const p = await load(`(module (memory (export "memory") 1 2) ${ALLOC}
      (data (i32.const 0) "[0]") (data (i32.const 16) "[1]")
      (func (export "think") (param i32 i32) (result i64)
        (if (result i64) (i32.eq (memory.grow (i32.const 100)) (i32.const -1))
          (then (i64.const 3)) (else (i64.or (i64.shl (i64.const 16) (i64.const 32)) (i64.const 3))))))`);
    expect(ok(await p.call({})).intents).toEqual([0]);
  });

  it('bounds V8-heap allocations staticplayerthree: tables need a small maximum, GC types and oversized memory totals are refused', async () => {
    const think = '(func (export "think") (param i32 i32) (result i64) (i64.const 0))';
    const mod = (decls: string, features: Record<string, boolean> = {}) => {
      const m = wabt.parseWat('policy.wat', `(module (memory (export "memory") 1 1) ${decls} ${ALLOC} ${think})`, { bulk_memory: true, ...features });
      try {
        return m.toBinary({}).buffer;
      } finally {
        m.destroy();
      }
    };
    // A growable table is a heap bomb: one table.grow of millions of entries aborts the host process outright.
    expect(await loadPolicy('wasm', mod('(table 0 funcref)'), limits())).toMatchObject({ ok: false, error: { code: 'memory_limit' } });
    expect(await loadPolicy('wasm', mod('(table 0 70000 funcref)'), limits())).toMatchObject({ ok: false, error: { code: 'memory_limit' } });
    expect(await loadPolicy('wasm', mod('(table 0 40000 funcref) (table 0 40000 externref)', { reference_types: true }), limits())).toMatchObject({
      ok: false,
      error: { code: 'memory_limit', message: expect.stringContaining('80000') },
    });
    expect(await loadPolicy('wasm', mod('(type (struct (field i32)))', { gc: true, function_references: true }), limits())).toMatchObject({
      ok: false,
      error: { code: 'bad_module', message: expect.stringContaining('GC') },
    });

    const p = await load(`(module (memory (export "memory") 1 1) (table 1 16 funcref) ${ALLOC}
      (data (i32.const 0) "[0]") (data (i32.const 16) "[1]")
      (func (export "think") (param i32 i32) (result i64)
        (if (result i64) (i32.eq (table.grow (ref.null func) (i32.const 1000000)) (i32.const -1))
          (then (i64.const 3)) (else (i64.or (i64.shl (i64.const 16) (i64.const 32)) (i64.const 3))))))`);
    expect(ok(await p.call({})).intents).toEqual([0]);
  });

  it('counts every memory against the budget', async () => {
    const m = wabt.parseWat(
      'policy.wat',
      `(module (memory (export "memory") 1 200) (memory $b 1 200) ${ALLOC} (func (export "think") (param i32 i32) (result i64) (i64.const 0)))`,
      { bulk_memory: true, multi_memory: true } as Parameters<typeof wabt.parseWat>[2],
    );
    const bytes = m.toBinary({}).buffer;
    m.destroy();
    expect(await loadPolicy('wasm', bytes, limits({ memoryBytes: 16 << 20 }))).toMatchObject({
      ok: false,
      error: { code: 'memory_limit', message: 'memories declare 400 pages in total; the limit is 256 pages' },
    });
  });

  it('truncates log lines by UTF-8 bytes and caps lines per call', async () => {
    const p = await load(`(module (import "env" "log" (func $log (param i32 i32))) (memory (export "memory") 1 1) ${ALLOC}
      (data (i32.const 0) "[]")
      (data (i32.const 100) "\\c3\\a9\\c3\\a9\\c3\\a9\\c3\\a9\\c3\\a9\\c3\\a9")
      (func (export "think") (param i32 i32) (result i64)
        (call $log (i32.const 100) (i32.const 12))
        (call $log (i32.const 100) (i32.const 12))
        (call $log (i32.const 100) (i32.const 12))
        (i64.const 2)))`, { maxLogLines: 2, maxLogLineBytes: 5 });
    expect(ok(await p.call({})).logs).toEqual(['éé', 'éé']);
  });
});
