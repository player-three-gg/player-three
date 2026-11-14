import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { MATCH_DATA_MAX_BYTES, type PolicyLimits } from '../src/manifest.ts';
import { loadPolicy, type PolicyInstance } from '../src/policy/index.ts';
import { limits, measure, observation50k, ok } from './policy-fixtures.ts';

const live: PolicyInstance[] = [];
afterEach(() => {
  for (const p of live.splice(0)) p.dispose();
});

async function load(source: string, over: Partial<PolicyLimits> = {}, seed?: number): Promise<PolicyInstance> {
  const r = await loadPolicy('js', source, limits(over), seed === undefined ? undefined : { seed });
  if (!r.ok) throw new Error(`load failed: ${JSON.stringify(r.error)}`);
  live.push(r.instance);
  return r.instance;
}

describe('js policy', () => {
  it('initializes once with an isolated bootstrap, separate from every observation', async () => {
    const data = { rules: { value: 7 }, terrain: [1, 2, 3] };
    const loading = loadPolicy('js', `
      var data, inits = 0;
      function init(matchData) { if (++inits !== 1) throw new Error('duplicate init'); data = matchData; }
      function think(obs) { return [{ kind: 'n', value: data.rules.value, tick: obs.tick, inits: inits, staticInObs: !!obs.match }]; }
    `, limits(), { matchData: data });
    data.rules.value = 99;
    const loaded = await loading;
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    live.push(loaded.instance);
    for (const tick of [1, 2]) {
      expect(ok(await loaded.instance.call({ tick })).intents).toEqual([{ kind: 'n', value: 7, tick, inits: 1, staticInObs: false }]);
    }
  });

  it('initializes without declared match data using null', async () => {
    const p = await load('var match; function init(data) { match = data; } function think() { return [{kind:\"n\", empty: match === null}]; }');
    expect(ok(await p.call({})).intents).toEqual([{ kind: 'n', empty: true }]);
  });

  it('bounds initialization JSON independently, with exact UTF-8 accounting', async () => {
    const code = 'var data; function init(value) { data = value; } function think() { return [{kind:\"n\", length:data.length}]; }';
    const exact = await loadPolicy('js', code, limits(), { matchData: 'x'.repeat(MATCH_DATA_MAX_BYTES - 2) });
    if (!exact.ok) throw new Error(JSON.stringify(exact.error));
    live.push(exact.instance);
    expect(ok(await exact.instance.call({})).intents).toEqual([{ kind: 'n', length: MATCH_DATA_MAX_BYTES - 2 }]);
    for (const data of ['x'.repeat(MATCH_DATA_MAX_BYTES - 1), 'é'.repeat(MATCH_DATA_MAX_BYTES / 2)]) {
      expect(await loadPolicy('js', code, limits(), { matchData: data })).toMatchObject({ ok: false, error: { code: 'too_large' } });
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const matchData of [cyclic, { value: NaN }, { value: undefined }, { value: () => {} }, 1n]) {
      expect(await loadPolicy('js', code, limits(), { matchData })).toMatchObject({ ok: false, error: { code: 'bad_output', message: 'match data must be JSON-compatible' } });
    }
  });

  it('keeps state across calls, runs init once, returns intents and logs', async () => {
    const p = await load(`
      let calls = 0;
      let base = 0;
      function init() { base = 100; }
      function think(obs) {
        calls++;
        log('tick', obs.tick, { calls });
        return obs.units.filter((u) => u.hp > 50).map((u) => ({ kind: 'attack', unit: u.id, n: base + calls }));
      }`);
    const obs = { tick: 7, units: [{ id: 'u_1', hp: 90 }, { id: 'u_2', hp: 10 }, { id: 'u_3', hp: 60 }] };
    const first = ok(await p.call(obs));
    expect(first.intents).toEqual([
      { kind: 'attack', unit: 'u_1', n: 101 },
      { kind: 'attack', unit: 'u_3', n: 101 },
    ]);
    expect(first.dropped).toBe(0);
    expect(first.logs).toEqual(['tick 7 {"calls":1}']);
    expect(first.ms).toBeGreaterThan(0);
    const second = ok(await p.call({ ...obs, tick: 8 }));
    expect(second.intents[0]).toEqual({ kind: 'attack', unit: 'u_1', n: 102 });
    expect(second.logs).toEqual(['tick 8 {"calls":2}']);
    expect(p.dead).toBe(false);
  });

  it('keeps the instance through a CPU-budget timeout, with its state as of the interruption', async () => {
    const p = await load(`
      let calls = 0, finished = 0;
      const trail = [];
      function think(obs) {
        calls++;
        if (obs.spin) {
          log('spinning');
          trail.push('started');
          try { for (;;) {} } catch (e) { trail.push('caught'); } finally { trail.push('finally'); }
        }
        finished++;
        return [{ kind: 'n', calls, finished, trail: trail.join() }];
      }`, { msPerCall: 50 });
    expect(ok(await p.call({})).intents).toEqual([{ kind: 'n', calls: 1, finished: 1, trail: '' }]);
    const t0 = performance.now();
    expect(await p.call({ spin: true })).toMatchObject({ ok: false, error: { code: 'timeout' }, logs: ['spinning'] });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(p.dead).toBe(false);
    // `calls` and `trail` kept what the interrupted call wrote; its catch, finally and the rest never ran.
    expect(ok(await p.call({})).intents).toEqual([{ kind: 'n', calls: 3, finished: 2, trail: 'started' }]);
  });

  it('hard-kills work the interpreter cannot interrupt (native sort) at the deadline', async () => {
    // Building the array (~0.1 s unloaded) happens at load, which gets 10 × msPerCall. Each default sort of the copy
    // takes ~0.8 s unloaded and never yields to the interrupt handler, so only the hang guard's watchdog (4 × 100 +
    // 150 ms after the request) can stop it before the first sort ends.
    const p = await load(
      `const big = []; for (let i = 0; i < 400000; i++) big.push((i * 7919) % 100003);
       function think() { big.slice().sort(); big.slice().sort(); big.slice().sort(); return []; }`,
      { msPerCall: 100, memoryBytes: 64 << 20 },
    );
    const t0 = performance.now();
    expect(await p.call({})).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(p.dead).toBe(true);
  });

  it('stops an allocation bomb at the memory cap', async () => {
    const p = await load('function think() { const keep = []; for (;;) keep.push(new Array(10000).fill(1)); }', { msPerCall: 5000 });
    const t0 = performance.now();
    expect(await p.call({})).toMatchObject({ ok: false, error: { code: 'memory_limit' } });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(p.dead).toBe(true);
  });

  it('refuses a single allocation larger than the budget', async () => {
    const p = await load('function think() { return [new ArrayBuffer(64 * 1024 * 1024).byteLength]; }');
    expect(await p.call({})).toMatchObject({ ok: false, error: { code: 'memory_limit' } });
    expect(p.dead).toBe(true);
  });

  it('has no host capabilities', async () => {
    const p = await load(`
      const probes = ['fetch', 'require', 'process', 'console', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
        'XMLHttpRequest', 'WebSocket', 'WebAssembly', 'std', 'os', 'scriptArgs', 'print', 'Deno', 'Bun', 'module', 'performance'];
      const dyn = {};
      function init() {
        for (const m of ['std', 'os', 'fs', 'node:fs', 'https://example.com/x.js']) {
          dyn[m] = 'pending';
          import(m).then(() => { dyn[m] = 'loaded'; }, () => { dyn[m] = 'rejected'; });
        }
      }
      function think() {
        let escaped;
        try { escaped = typeof this.constructor.constructor('return process')(); } catch (e) { escaped = 'threw ' + e.name; }
        return [{ kind: 'probe', types: probes.map((g) => typeof globalThis[g]), dyn, escaped }];
      }`);
    const v = ok(await p.call({}));
    const intent = v.intents[0] as { types: string[]; dyn: Record<string, string>; escaped: string };
    expect(new Set(intent.types)).toEqual(new Set(['undefined']));
    expect(intent.dyn).toEqual({ std: 'rejected', os: 'rejected', fs: 'rejected', 'node:fs': 'rejected', 'https://example.com/x.js': 'rejected' });
    expect(intent.escaped).toBe('threw ReferenceError');
  });

  it('rejects module syntax at compile time', async () => {
    for (const src of ['import * as std from "std"; function think() { return []; }', 'export function think() { return []; }']) {
      const r = await loadPolicy('js', src, limits());
      expect(r).toMatchObject({ ok: false, error: { code: 'compile' } });
    }
  });

  it('reports non-array and non-JSON output as bad_output without killing the instance', async () => {
    const p = await load(`
      let mode = 0;
      class Unit { constructor() { this.id = 1; } }
      function think(obs) {
        switch (obs.mode) {
          case 0: return { kind: 'move' };
          case 1: return undefined;
          case 2: return [() => 1];
          case 3: return [{ x: NaN }];
          case 4: return [{ x: 1n }];
          case 5: { const a = { kind: 'loop' }; a.self = a; return [a]; }
          case 6: return [new Unit()];
          case 7: return [{ x: undefined }];
          case 8: return [Symbol('s')];
          case 9: return 'x'.repeat(10);
          default: return [{ kind: 'fine' }];
        }
      }`);
    for (let mode = 0; mode <= 9; mode++) {
      const r = await p.call({ mode });
      expect(r, `mode ${mode}`).toMatchObject({ ok: false, error: { code: 'bad_output' } });
    }
    expect(p.dead).toBe(false);
    expect(ok(await p.call({ mode: 10 })).intents).toEqual([{ kind: 'fine' }]);
  });

  it('enforces output depth and UTF-8 size on the host when getters sidestep the in-VM checks', async () => {
    // The in-VM check reads each property once; JSON.stringify reads it again and gets 5000 levels of nesting.
    const p = await load(`
      function think(obs) {
        if (obs.mode === 'size') return ['é'.repeat(600000)];
        let deep = 1;
        for (let i = 0; i < 5000; i++) deep = [deep];
        let reads = 0;
        return [{ kind: 'x', get a() { return reads++ === 0 ? 1 : deep; } }];
      }`, { memoryBytes: 32 << 20 });
    expect(await p.call({ mode: 'depth' })).toMatchObject({ ok: false, error: { code: 'bad_output', message: 'output nested deeper than 32 levels' } });
    // 600 000 UTF-16 units pass the in-VM pre-check but encode to 1.2 MB of UTF-8, over the 1 MiB output limit.
    expect(await p.call({ mode: 'size' })).toMatchObject({ ok: false, error: { code: 'bad_output', message: 'output larger than 1048576 bytes' } });
    expect(p.dead).toBe(false);
  });

  it('reports a promise result as bad_output and times out an endless microtask chain', async () => {
    const p = await load(`
      function think(obs) {
        if (obs.chain) { const f = () => Promise.resolve().then(f); f(); return []; }
        if (obs.after) return [1];
        return new Promise(() => {});
      }`, { msPerCall: 50 });
    expect(await p.call({})).toMatchObject({ ok: false, error: { code: 'bad_output', message: 'think must return an array, got object' } });
    expect(p.dead).toBe(false);
    const t0 = performance.now();
    expect(await p.call({ chain: true })).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(performance.now() - t0).toBeLessThan(2000);
    // The interrupt stops the job it lands in before that job queues the next one, so nothing is left over.
    expect(ok(await p.call({ after: true })).intents).toEqual([1]);
  });

  it('runs promise jobs left at a timeout within that call, and is killed when they overrun as well', async () => {
    const p = await load(`
      const order = [];
      function think(obs) {
        if (obs.spin) { Promise.resolve().then(() => order.push('job')); for (;;) {} }
        if (obs.spinJob) { Promise.resolve().then(() => { for (;;) {} }); for (;;) {} }
        order.push('call');
        return [order.join()];
      }`, { msPerCall: 50 });
    expect(await p.call({ spin: true })).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(p.dead).toBe(false);
    // Drained by the timed-out call: the job ran before this call's think, not after it (as a leftover would).
    expect(ok(await p.call({})).intents).toEqual(['job,call']);
    expect(await p.call({ spinJob: true })).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(p.dead).toBe(true);
  });

  it('drops intents beyond maxIntentsPerCall and counts them', async () => {
    const p = await load('function think() { return Array.from({ length: 20 }, (_, i) => ({ kind: "move", i })); }', { maxIntentsPerCall: 8 });
    const v = ok(await p.call({}));
    expect(v.intents).toHaveLength(8);
    expect(v.intents.at(-1)).toEqual({ kind: 'move', i: 7 });
    expect(v.dropped).toBe(12);
  });

  it('truncates log lines by UTF-8 bytes, caps lines per call and resets per call', async () => {
    const p = await load(
      `function think(obs) {
        log('a'.repeat(100));
        log('é'.repeat(100));
        log('🙂'.repeat(100));
        for (let i = 0; i < 10; i++) log('extra', i);
        return [];
      }`,
      { maxLogLines: 3, maxLogLineBytes: 15 },
    );
    for (let i = 0; i < 2; i++) {
      const { logs } = ok(await p.call({}));
      expect(logs).toEqual(['a'.repeat(15), 'é'.repeat(7), '🙂'.repeat(3)]);
      for (const l of logs) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(15);
    }
  });

  it('is deterministic for a seed: Math.random and the clock replay exactly', async () => {
    const src = `
      const seen = [];
      function think(obs) {
        seen.push(obs.tick);
        return [{ kind: 'roll', r: Math.random(), r2: Math.floor(Math.random() * 1e6), now: Date.now(), d: new Date().getTime(), sum: seen.length }];
      }`;
    const run = async (seed: number) => {
      const p = await load(src, {}, seed);
      const out: unknown[] = [];
      for (let tick = 0; tick < 20; tick++) out.push(ok(await p.call({ tick })).intents);
      return out;
    };
    const a = await run(42);
    const b = await run(42);
    const c = await run(43);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
    const first = (a[0] as { r: number; now: number; d: number }[])[0]!;
    expect(first.now).toBe(0);
    expect(first.d).toBe(0);
    const rolls = a.map((x) => (x as { r: number }[])[0]!.r);
    expect(new Set(rolls).size).toBe(rolls.length);
    for (const r of rolls) expect(r >= 0 && r < 1).toBe(true);
  });

  it('keeps explicit dates working while freezing the clock', async () => {
    const p = await load(
      'class Stamp extends Date {} function think() { return [new Date(86400000).toISOString(), Date(), new Date() instanceof Date, new Stamp().getTime(), new Stamp() instanceof Stamp]; }',
    );
    expect(ok(await p.call({})).intents).toEqual(['1970-01-02T00:00:00.000Z', expect.stringMatching(/ 19(69|70) /), true, 0, true]);
  });

  it('isolates instances of the same code', async () => {
    const src = 'let n = 0; function think() { globalThis.mark = (globalThis.mark || 0) + 1; n++; return [{ kind: "n", n, mark: globalThis.mark }]; }';
    const a = await load(src);
    const b = await load(src);
    ok(await a.call({}));
    ok(await a.call({}));
    expect(ok(await b.call({})).intents).toEqual([{ kind: 'n', n: 1, mark: 1 }]);
  });

  it('reports a throw with its message and location, keeps logs and the instance', async () => {
    const p = await load('function think(obs) {\n  log("before");\n  if (obs.boom) throw new TypeError("no target");\n  return [];\n}');
    const r = await p.call({ boom: true });
    expect(r).toMatchObject({ ok: false, error: { code: 'threw', message: expect.stringMatching(/^TypeError: no target \(policy\.js:3:\d+\)$/) }, logs: ['before'] });
    expect(p.dead).toBe(false);
    expect(ok(await p.call({ boom: false })).intents).toEqual([]);
  });

  it('turns runaway recursion into a catchable stack overflow', async () => {
    const p = await load('function f(n) { return f(n + 1) + 1; } function think(obs) { if (obs.deep) return [f(0)]; return [1]; }');
    expect(await p.call({ deep: true })).toMatchObject({ ok: false, error: { code: 'threw', message: expect.stringContaining('stack overflow') } });
    expect(ok(await p.call({ deep: false })).intents).toEqual([1]);
  });

  it('validates the artifact at load', async () => {
    expect(await loadPolicy('js', 'function think( {', limits())).toMatchObject({
      ok: false,
      error: { code: 'compile', message: expect.stringMatching(/^SyntaxError: .*\(policy\.js:1:\d+\)$/) },
    });
    expect(await loadPolicy('js', 'function nope() {}', limits())).toMatchObject({ ok: false, error: { code: 'missing_export' } });
    expect(await loadPolicy('js', 'throw new Error("top")', limits())).toMatchObject({ ok: false, error: { code: 'threw', message: expect.stringMatching(/^Error: top \(policy\.js:1:\d+\)$/) } });
    expect(await loadPolicy('js', 'function think() { return []; } function init() { throw new RangeError("bad init"); }', limits())).toMatchObject({
      ok: false,
      error: { code: 'threw', message: expect.stringContaining('RangeError: bad init') },
    });
    expect(await loadPolicy('js', '// ' + 'x'.repeat(2000), limits({ maxArtifactBytes: 1000 }))).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(await loadPolicy('js', 'function think() { return []; }', limits({ runtimes: ['wasm'] }))).toEqual({ ok: false, error: { code: 'runtime_not_allowed' } });
    expect(await loadPolicy('js', 'for (;;) {} function think() { return []; }', limits({ msPerCall: 10 }))).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('serialises concurrent calls on one instance', async () => {
    const p = await load('let n = 0; function think() { n++; return [n]; }');
    const rs = await Promise.all([p.call({}), p.call({}), p.call({})]);
    expect(rs.map((r) => ok(r).intents[0])).toEqual([1, 2, 3]);
  });

  it('handles a ~50 KB observation well inside a tick budget', async () => {
    const p = await load(`
      function think(obs) {
        const mine = [], foes = [];
        for (const u of obs.units) (u.team === 'blue' ? mine : foes).push(u);
        const out = [];
        for (const m of mine) {
          if (out.length >= 8) break;
          let best = null, bd = Infinity;
          for (const f of foes) { const d = (f.x - m.x) ** 2 + (f.y - m.y) ** 2; if (d < bd) { bd = d; best = f; } }
          if (best) out.push({ kind: 'attack', unit: m.id, target: best.id });
        }
        return out;
      }`);
    const obs = observation50k();
    const stats = await measure(p, obs);
    console.log(`[perf] js ${stats.bytes} B obs: mean ${stats.mean.toFixed(2)} ms, max ${stats.max.toFixed(2)} ms over ${stats.n} calls`);
    expect(stats.mean).toBeLessThan(20);
  });

  it('rejects calls after dispose', async () => {
    const p = await load('function think() { return []; }');
    p.dispose();
    expect(p.dead).toBe(true);
    expect(await p.call({})).toMatchObject({ ok: false });
  });

  // One sandbox instance is one OS thread, so the process's thread count shows whether any worker outlives its instance.
  it.runIf(process.platform === 'linux')('terminates the worker of every killed, disposed or failed instance', { timeout: 30_000 }, async () => {
    const threads = () => Number(/^Threads:\s+(\d+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))![1]);
    (await load('function think() { return []; }')).dispose();
    // Workers of earlier tests may still be exiting: the baseline is the lowest count seen.
    let base = threads();
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      base = Math.min(base, threads());
    }
    const [loop, sort, bomb, fine] = await Promise.all([
      // A timeout whose leftover promise job overruns its drain too: killed (a plain loop's instance survives).
      load('function think() { Promise.resolve().then(() => { for (;;) {} }); for (;;) {} }', { msPerCall: 100 }),
      // Uninterruptible native work: only the host watchdog's terminate stops it (see the native sort test above).
      load(
        `const big = []; for (let i = 0; i < 400000; i++) big.push((i * 7919) % 100003);
         function think() { big.slice().sort(); big.slice().sort(); big.slice().sort(); return []; }`,
        { msPerCall: 100, memoryBytes: 64 << 20 },
      ),
      load('function think() { const keep = []; for (;;) keep.push(new Array(10000).fill(1)); }', { msPerCall: 5000 }),
      load('function think() { return []; }'),
    ]);
    expect(threads()).toBeGreaterThanOrEqual(base + 4);
    expect(await loop.call({})).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(await sort.call({})).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(await bomb.call({})).toMatchObject({ ok: false, error: { code: 'memory_limit' } });
    fine.dispose();
    for (const src of ['for (;;) {} function think() { return []; }', 'throw new Error("top")', 'function think( {']) {
      expect(await loadPolicy('js', src, limits({ msPerCall: 100 }))).toMatchObject({ ok: false });
    }
    let now = threads();
    for (let i = 0; i < 100 && now > base; i++) {
      await sleep(50);
      now = threads();
    }
    expect(now).toBeLessThanOrEqual(base);
  });
});
