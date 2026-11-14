import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Budget, hangCapMs, watchdogMs, type BudgetClocks } from '../src/policy/channel.ts';
import { loadJs } from '../src/policy/guest-js.ts';
import type { Guest, GuestResult } from '../src/policy/guest.ts';
import { loadPolicy, type PolicyInstance } from '../src/policy/index.ts';
import { parseWasm } from '../src/policy/wasm-binary.ts';
import { limits, ok } from './policy-fixtures.ts';

/** Manually advanced clocks; counts CPU-clock reads (each one is a syscall on the real thread clock). */
function fakeClocks() {
  const c = { wall: 1000, cpu: 500, cpuReads: 0 };
  const clocks: BudgetClocks = {
    wallMs: () => c.wall,
    cpuMs: () => {
      c.cpuReads++;
      return c.cpu;
    },
  };
  return { c, clocks };
}

describe('policy budget rule (sandbox-thread CPU time)', () => {
  it('forgives any wall time the thread spends descheduled while its CPU time stays within budget', () => {
    const { c, clocks } = fakeClocks();
    const b = new Budget(25, clocks);
    // A loaded machine: 24 ms of CPU spread over 90 ms of wall time.
    c.wall += 90;
    c.cpu += 24;
    expect(b.exceeded()).toBe(false);
    expect(b.wallMs()).toBe(90);
    expect(b.cpuMs()).toBe(24);
  });

  it('times out once the thread has used more CPU than the budget, however little wall time passed', () => {
    const { c, clocks } = fakeClocks();
    const b = new Budget(25, clocks);
    c.wall += 25.5;
    c.cpu += 25.5;
    expect(b.exceeded()).toBe(true);
  });

  it('keeps a separate, larger wall-clock hang guard for work it cannot interrupt or a starved thread', () => {
    const { c, clocks } = fakeClocks();
    const b = new Budget(25, clocks);
    expect(hangCapMs(25)).toBe(200);
    expect(watchdogMs(25)).toBe(250);
    c.wall += hangCapMs(25);
    c.cpu += 1;
    expect(b.exceeded()).toBe(false);
    c.wall += 0.5;
    expect(b.exceeded()).toBe(true);
  });

  it('does not read the CPU clock while wall time is within budget (one thread cannot use more CPU than wall time)', () => {
    const { c, clocks } = fakeClocks();
    const b = new Budget(25, clocks);
    const reads = c.cpuReads;
    c.wall += 25;
    c.cpu += 25;
    expect(b.exceeded()).toBe(false);
    expect(c.cpuReads).toBe(reads);
  });
});

describe('JS timeout recovery (the guest in this thread, on driven clocks)', () => {
  /** The sandbox worker's JS guest, on the same engine build and memory bound as `loadPolicy` gives it. */
  async function jsGuest(source: string): Promise<Guest> {
    const require = createRequire(import.meta.url);
    const pkg = createRequire(require.resolve('quickjs-emscripten')).resolve('@jitl/quickjs-wasmfile-release-sync/package.json');
    const bytes = await readFile(join(dirname(pkg), 'dist', 'emscripten-module.wasm'));
    const info = parseWasm(bytes);
    const mem = info.imports.find((i) => i.kind === 'memory')!.limits!;
    const maximum = Math.min(mem.max!, Math.max(mem.min, Math.ceil((info.global0I32! + limits().memoryBytes) / 65536)));
    const loaded = await loadJs(source, { module: await WebAssembly.compile(bytes), pages: { initial: mem.min, maximum } }, limits(), 1, 'null', () => new Budget(10_000));
    if (!loaded.ok) throw new Error(JSON.stringify(loaded));
    return loaded.guest;
  }

  /** Clocks that advance 1 ms of wall time, and `cpuPerMs` of CPU time, on every wall read (each interrupt poll). */
  function drivenClocks(cpuPerMs: number): BudgetClocks {
    let wall = 0;
    let cpu = 0;
    return {
      wallMs: () => {
        cpu += cpuPerMs;
        return ++wall;
      },
      cpuMs: () => cpu,
    };
  }

  function call(guest: Guest, obs: unknown, budget: Budget): GuestResult {
    const bytes = new TextEncoder().encode(JSON.stringify(obs));
    return guest.call(bytes, bytes.length, budget);
  }

  const SPIN = 'let n = 0; function think(obs) { n++; if (obs.spin) for (;;) {} return [n]; }';

  it('keeps the instance when the CPU-budget interrupt stops a call', async () => {
    const guest = await jsGuest(SPIN);
    expect(call(guest, { spin: true }, new Budget(10, drivenClocks(1)))).toMatchObject({ ok: false, code: 'timeout', fatal: false });
    expect(call(guest, {}, new Budget(10_000))).toMatchObject({ ok: true, out: '[2]' });
  });

  it('kills it when the interrupt fires at the wall-clock hang guard instead (a thread starved of CPU)', async () => {
    const guest = await jsGuest(SPIN);
    expect(call(guest, { spin: true }, new Budget(10, drivenClocks(0)))).toMatchObject({ ok: false, code: 'timeout', fatal: true });
  });
});

describe('policy call timing report', () => {
  const live: PolicyInstance[] = [];
  afterEach(() => {
    for (const p of live.splice(0)) p.dispose();
  });

  it('reports the budgeted thread CPU time next to the sandbox-side wall time', async () => {
    // Tens of ms of interpreter work (several scheduler ticks) against a 1 s budget.
    const r = await loadPolicy('js', 'function think() { let x = 0; for (let i = 0; i < 1000000; i++) x = (x * 31 + i) | 0; return [{ kind: "n", x }]; }', limits());
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    live.push(r.instance);
    const v = ok(await r.instance.call({}));
    expect(v.cpuMs).toBeGreaterThan(0);
    // The per-thread clock advances at scheduler ticks, so allow one tick of skew above the wall time.
    expect(v.cpuMs).toBeLessThanOrEqual(v.ms + 10);
  });

  it('reports the CPU time of a call that ran over its budget', async () => {
    const r = await loadPolicy('js', 'function think() { for (;;) {} }', limits({ msPerCall: 20 }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    live.push(r.instance);
    const out = await r.instance.call({});
    expect(out).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(out.ok ? undefined : out.cpuMs).toBeTypeOf('number');
  });
});
