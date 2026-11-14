import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { definition, EXAMPLE_POLICY, type TagManifest } from '../examples/tag/index.ts';
import { surfaceHash } from '../src/briefing.ts';
import { createPlayerThreeHost, practiceLocal, seatBot } from '../src/host/index.ts';
import { defaultMandate, looseDefinition, policyArtifactHash, type SeatKey } from '../src/host/pipeline.ts';
import type { PlayerThreeHost } from '../src/host/types.ts';
import { observationSections, type GameDefinition, type PolicyLimits } from '../src/manifest.ts';
import { createPolicyPackage, validatePolicyPackage, type PolicyPackage } from '../src/policy-package.ts';
import { t } from '../src/schema.ts';
import {
  DETERMINISTIC_MATH_SOURCE,
  guardedEach,
  loadPolicy,
  loadTrustedPolicy,
  TRUSTED_HANG_MS,
  type LoadOptions,
  type PolicyCallOutcome,
  type PolicyInstance,
  type TrustedCallOutcome,
  type TrustedInstance,
} from '../src/policy/index.ts';
import { limits, observation50k } from './policy-fixtures.ts';

const m = definition.manifest;
const tagLimits = m.control.policy;

/** A validated package of `script` for the current tag surface (or the given one). */
function tagPackage(script: string, roles: string[] = ['runner'], hash = surfaceHash(m)): PolicyPackage {
  const pkg = createPolicyPackage({
    game: { id: m.id, version: m.version },
    surfaceHash: hash,
    roles,
    runtime: 'js',
    detail: null,
    source: { code: script },
    script,
    scriptHash: policyArtifactHash({ runtime: 'js', code: script }),
    lineage: { parent: null, version: 1 },
    license: 'Apache-2.0',
    author: null,
    createdAt: '2000-01-01T00:00:00.000Z',
  });
  const valid = validatePolicyPackage(pkg, tagLimits, m);
  if (!valid) throw new Error('test package is invalid');
  return valid;
}

/** A classic sandbox policy as a trusted package script: its whole text is one seat's instance. */
const asFactory = (classic: string): string =>
  `function createPolicy() {\n${classic}\nreturn { think: think, init: typeof init === 'function' ? init : undefined };\n}\n`;

const quick: PolicyInstance[] = [];
const trusted: TrustedInstance[] = [];
let host: PlayerThreeHost<TagManifest> | undefined;
afterEach(() => {
  for (const p of quick.splice(0)) p.dispose();
  for (const p of trusted.splice(0)) p.dispose();
  host?.dispose();
  host = undefined;
});

function trustedLoad(script: string, lim: PolicyLimits, opts?: LoadOptions): TrustedInstance {
  const r = loadTrustedPolicy(tagPackage(script), lim, opts);
  if (!r.ok) throw new Error(`trusted load failed: ${JSON.stringify(r.error)}`);
  trusted.push(r.instance);
  return r.instance;
}

/** `classic` loaded in the QuickJS sandbox, and as a factory package in the trusted runner. */
async function both(classic: string, lim: PolicyLimits, opts?: LoadOptions): Promise<[PolicyInstance, TrustedInstance]> {
  const q = await loadPolicy('js', classic, lim, opts);
  if (!q.ok) throw new Error(`quickjs load failed: ${JSON.stringify(q.error)}`);
  quick.push(q.instance);
  return [q.instance, trustedLoad(asFactory(classic), lim, opts)];
}

/** Everything a call returns except timing, for either runner. */
function untimed(r: PolicyCallOutcome | TrustedCallOutcome): { ok: boolean; logs: string[]; [k: string]: unknown } {
  if (!r.ok) return { ok: false, code: r.error.code, logs: [...(r.logs ?? [])] };
  const v = 'value' in r ? r.value : r;
  return { ok: true, intents: v.intents, dropped: v.dropped, logs: [...v.logs] };
}

/** Observations of `seats` from a bot-vs-bot tag match (hard vs hard: a full-length draw), one per think period. */
function recordObservations(seats: readonly SeatKey[], perSeat: number): Map<string, unknown[]> {
  const def = looseDefinition(definition);
  const adapter = def.create({ seed: 7, teams: ['blue', 'red'] });
  const all: SeatKey[] = [];
  for (const team of ['blue', 'red']) for (const role of ['runner', 'guard']) all.push({ team, role });
  for (const s of all) adapter.setSeatInfo(s, { controller: 'bot', mandate: defaultMandate(m) });
  const bots = all.map((seat) => ({ seat, bot: def.createBot(seat, 'hard'), since: 0 }));
  const out = new Map(seats.map((s) => [`${s.team}/${s.role}`, [] as unknown[]]));
  const period = Math.round(m.tickRate / tagLimits.hz);
  while (adapter.outcome('blue') === 'running' && [...out.values()].some((obs) => obs.length < perSeat)) {
    if (adapter.tick % period === 0) {
      for (const b of bots) {
        const obs = adapter.observe(b.seat, b.since, observationSections(m));
        b.since = adapter.tick;
        const rec = out.get(`${b.seat.team}/${b.seat.role}`);
        if (rec && rec.length < perSeat) rec.push(structuredClone(obs));
        for (const intent of b.bot.think(obs)) adapter.apply(b.seat, intent);
      }
    }
    adapter.step();
  }
  return out;
}

/** Exercises the deterministic Math port, Math.random, the frozen Date, logging and promise jobs on every call. */
const MATH_POLICY = `
var state = { n: 0, acc: 0, md: null };
function init(md) { state.md = md; log('init', md); }
function think(obs) {
  state.n++;
  var x = obs.you.x + Math.random(), y = obs.you.y + Math.random() * 3;
  var v = [Math.sin(x), Math.cos(y), Math.tan(x / 7), Math.atan2(y - 8, x - 8), Math.hypot(x, y, state.n), Math.hypot(x, y),
    Math.pow(x, 1.7), Math.pow(y + 1, -2.5), Math.exp(-y / 5), Math.expm1(y / 9), Math.log(x + 1), Math.log1p(x), Math.log2(y + 1),
    Math.log10(x + 1), Math.cbrt(x * y - 20), Math.asinh(x), Math.acosh(y + 1), Math.atanh(x / 32), Math.sinh(y / 4), Math.cosh(x / 4),
    Math.tanh(y - 7), Math.asin(x / 16), Math.acos(y / 20), Math.atan(x - y), Math.random(), Date.now(), new Date().getTime()];
  for (var i = 0; i < v.length; i++) state.acc = (state.acc * 31 + v[i]) % 1e9;
  log(v.slice(0, 13).join(','));
  log(v.slice(13).join(','), new Date(86400000 * state.n).toISOString(), String(new Date()));
  Promise.resolve(state.n).then(function (n) { log('job', n, state.acc); });
  var tx = Math.max(0, Math.min(15, Math.round(8 + 7 * Math.sin(state.acc))));
  var ty = Math.max(0, Math.min(15, Math.round(8 + 7 * Math.cos(state.acc))));
  return [{ kind: 'move', x: tx, y: ty }, { kind: 'note', acc: state.acc, md: state.md, v: v }];
}`;

describe('trusted runner', () => {
  it('matches the QuickJS sandbox call for call, every seat isolated inside the one shared realm', async () => {
    const seats = [{ team: 'blue', role: 'runner' }, { team: 'red', role: 'guard' }];
    const recorded = [...recordObservations(seats, 220).values()];
    for (const obs of recorded) expect(obs.length).toBe(220);
    const mathLimits = limits({ maxLogLines: 8, maxLogLineBytes: 4096, msPerCall: 200 });
    const cases: { script: string; lim: PolicyLimits; opts: LoadOptions }[] = [
      { script: EXAMPLE_POLICY, lim: tagLimits, opts: {} },
      { script: MATH_POLICY, lim: mathLimits, opts: { seed: 123456789012, matchData: { rules: [1, 2.5, 'x'] } } },
    ];
    let logged = 0;
    for (const { script, lim, opts } of cases) {
      // One instance per recorded seat, each with its own seed; the trusted ones share the package's realm.
      const pairs = await Promise.all(recorded.map((_, s) => both(script, lim, { ...opts, seed: (opts.seed ?? 0) + s })));
      const answers: TrustedCallOutcome[] = [];
      for (let i = 0; i < 220; i++) {
        // A think round: every trusted seat under one guard, as the host runs bot packages.
        guardedEach(pairs.length, (s) => (answers[s] = pairs[s]![1].call(recorded[s]![i])));
        for (let s = 0; s < pairs.length; s++) {
          const a = untimed(await pairs[s]![0].call(recorded[s]![i]));
          expect(untimed(answers[s]!)).toEqual(a);
          logged += a.logs.length;
        }
      }
    }
    // Both policies log (the example every 25th runner call, the Math policy every call): the comparison covers logs.
    expect(logged).toBeGreaterThan(4 * 220);
  }, 240_000);

  it('exposes exactly the QuickJS global set and no Node globals', async () => {
    const probe = `function think() {
      var names = Object.getOwnPropertyNames(globalThis).filter(function (n) { return n !== 'think' && n !== 'createPolicy'; }).sort();
      var members = {};
      for (var i = 0; i < names.length; i++) {
        var g = globalThis[names[i]];
        if ((typeof g !== 'function' && typeof g !== 'object') || g === null || g === globalThis) continue;
        members[names[i]] = Object.getOwnPropertyNames(g);
        if (typeof g === 'function' && g.prototype) members[names[i] + '.prototype'] = Object.getOwnPropertyNames(g.prototype);
      }
      return [names, members];
    }`;
    const [q, v] = await both(probe, limits({ msPerCall: 500 }));
    const [qr, vr] = [await q.call({}), v.call({})];
    if (!qr.ok || !vr.ok) throw new Error('probe failed');
    const [qNames, qMembers] = qr.value.intents as [string[], Record<string, string[]>];
    const [vNames, vMembers] = vr.intents as [string[], Record<string, string[]>];
    expect(vNames).toEqual(qNames);
    for (const name of ['require', 'process', 'console', 'queueMicrotask', 'structuredClone', 'setTimeout', 'setImmediate', 'Buffer', 'global',
      'module', 'fetch', 'WebAssembly', 'Atomics', 'Intl', 'Temporal', 'performance', 'TextEncoder', 'URL']) expect(vNames).not.toContain(name);
    // Members of the shared built-ins V8 still has beyond QuickJS: only those that cannot or must not be removed.
    const extra = Object.keys(vMembers).flatMap((k) => vMembers[k]!.filter((n) => !(qMembers[k] ?? []).includes(n)).map((n) => `${k}.${n}`));
    expect(extra.sort()).toEqual(['Error.stackTraceLimit', 'Symbol.asyncDispose', 'Symbol.dispose']);
  });

  it('refuses code generation from strings, which only the trusted runner forbids', async () => {
    const [q, v] = await both(`function think() { var r = []; try { r.push(new Function('return 1')()); } catch (e) { r.push(e.name); }
      try { r.push(eval('2')); } catch (e) { r.push(e.name); } return r; }`, limits());
    expect(untimed(await q.call({}))).toMatchObject({ ok: true, intents: [1, 2] });
    expect(untimed(v.call({}))).toMatchObject({ ok: true, intents: ['EvalError', 'EvalError'] });
  });

  it('answers the locale-sensitive built-ins as QuickJS does', async () => {
    const [q, v] = await both(`function think() {
      // Local time of dates whose zone offset has seconds (LMT, before ~1900) differs: QuickJS rounds the offset to
      // whole minutes (getTimezoneOffset), V8 does not. Their UTC forms agree.
      var dates = [0, 1e12, 1592000000000, 1592049600000, 8.64e15, NaN].map(function (t) { return new Date(t); });
      var out = [-1e14, -62198755200000].map(function (t) { return new Date(t).toUTCString() + ' ' + new Date(t).toISOString(); });
      for (var i = 0; i < dates.length; i++) {
        var d = dates[i];
        out.push(String(d), d.toString(), d.toTimeString(), d.toDateString(), d.toLocaleString('de-DE'), d.toLocaleDateString(), d.toLocaleTimeString(), '' + d);
      }
      [1234.5, -0, 1e21, 0.000001234, NaN, -Infinity, 12345678.9].forEach(function (n) { out.push(n.toLocaleString('de-DE', { style: 'percent' })); });
      out.push([1234.5, new Date(0), 'x'].toLocaleString(), new Float64Array([1234.5, 2]).toLocaleString(), (12345678901234567890n).toLocaleString());
      out.push('a'.localeCompare('B'), 'b'.localeCompare('a'), 'é'.localeCompare('e\\u0301'), 'ab'.localeCompare('abc'), 'abc'.localeCompare('ab'), '\\u00ff'.localeCompare('\\u0100x'), ''.localeCompare(''));
      out.push('ı'.toLocaleUpperCase('tr'), 'İ'.toLocaleLowerCase('tr'), 'straße'.toLocaleUpperCase());
      out.push(Date(), new Date().toString());
      return [out];
    }`, limits({ msPerCall: 500 }));
    const a = untimed(await q.call({}));
    expect(a).toMatchObject({ ok: true });
    expect(untimed(v.call({}))).toEqual(a);
  });

  it('kills a call that hangs at the hang guard only, resumes its batch, and gives later seats a fresh realm', () => {
    // Shared top-level state: a hang may leave it half-updated, so the next seat must not inherit it.
    const script = 'var calls = 0; function createPolicy() { return { think: function (obs) { calls++; if (obs.spin) for (;;) {} return [calls]; } }; }';
    const [a, b] = [trustedLoad(script, limits()), trustedLoad(script, limits())];
    expect(untimed(a.call({}))).toEqual({ ok: true, intents: [1], dropped: 0, logs: [] });
    const out: TrustedCallOutcome[] = [];
    const t0 = performance.now();
    guardedEach(3, (i) => (out[i] = (i === 1 ? b : a).call({ spin: i === 1 })));
    const elapsed = performance.now() - t0;
    // Neither the 25 ms sandbox budget nor any per-call kill: the guard's wall time.
    expect(elapsed).toBeGreaterThanOrEqual(TRUSTED_HANG_MS - 5);
    expect(elapsed).toBeLessThan(TRUSTED_HANG_MS + 1500);
    expect(out[1]).toBeUndefined();
    expect([untimed(out[0]!), untimed(out[2]!)]).toEqual([{ ok: true, intents: [2], dropped: 0, logs: [] }, { ok: true, intents: [4], dropped: 0, logs: [] }]);
    expect(b.dead).toBe(true);
    expect(b.call({})).toMatchObject({ ok: false, error: { code: 'timeout' } });
    // The surviving seat keeps the old realm; a new seat starts a fresh one.
    expect(untimed(a.call({}))).toMatchObject({ intents: [5] });
    expect(untimed(trustedLoad(script, limits()).call({}))).toMatchObject({ intents: [1] });

    // Outside a batch a call arms its own guard; a promise job that spins is inside the call as well.
    const w = trustedLoad(asFactory('function think() { Promise.resolve().then(function () { for (;;) {} }); return []; }'), limits());
    expect(w.call({})).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(w.dead).toBe(true);
    expect(loadTrustedPolicy(tagPackage('for (;;) {} function createPolicy() {}'), limits())).toEqual({ ok: false, error: { code: 'timeout' } });
    expect(loadTrustedPolicy(tagPackage('function createPolicy() { for (;;) {} }'), limits())).toEqual({ ok: false, error: { code: 'timeout' } });
  }, 30_000);

  it('validates output as the sandbox does and reports load errors with its codes', async () => {
    const lim = limits();
    const calls = [
      'function think() { return [function () {}]; }',
      'function think() { return 5; }',
      'function think() { return [NaN]; }',
      'function think() { return [new Map()]; }',
      'function think() { var o = []; for (var i = 0; i < 40; i++) o = [o]; return o; }',
      "function think() { return ['x'.repeat(1100000)]; }",
      'function think() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; }',
      "function think() { log('a', {b: [1]}, null, 2.5); throw new TypeError('boom'); }",
      'function think() { throw null; }',
      'function think() { function f() { return f() + 1; } return [f()]; }',
    ];
    for (const script of calls) {
      const [q, v] = await both(script, lim);
      const [a, b] = [await q.call({}), v.call({})];
      expect(untimed(b), script).toEqual(untimed(a));
      // Output checks are the shared prelude's: same text too. Engine exception text may differ.
      if (!a.ok && a.error.code === 'bad_output') expect(b).toMatchObject({ error: { message: a.error.message } });
    }
    // Host objects from the observation are plain data too.
    const echo = trustedLoad(asFactory('function think(obs) { return [obs.you, obs.list.map(function (x) { return x * 2; })]; }'), lim);
    expect(untimed(echo.call({ you: { x: 1 }, list: [1, 2] }))).toMatchObject({ ok: true, intents: [{ x: 1 }, [2, 4]] });

    // Top-level failures read as the sandbox reads them.
    for (const script of ['function think( {', "throw new Error('top');", 'JSON.parse("{");']) {
      const [a, b] = [await loadPolicy('js', script, lim), loadTrustedPolicy(tagPackage(script), lim)];
      if (a.ok) quick.push(a.instance);
      expect(b.ok ? 'ok' : b.error.code, script).toBe(a.ok ? 'ok' : a.error.code);
    }
    const loads: [string, string][] = [
      ['var x = 1;', 'missing_export'],
      ['var createPolicy = 3;', 'missing_export'],
      ['function createPolicy() { return {}; }', 'missing_export'],
      ["function createPolicy() { throw new Error('seat'); }", 'threw'],
      ["function createPolicy() { return { think: function () { return []; }, init: function () { throw new RangeError('init'); } }; }", 'threw'],
    ];
    for (const [script, code] of loads) expect(loadTrustedPolicy(tagPackage(script), lim), script).toMatchObject({ ok: false, error: { code } });
    expect(loadTrustedPolicy(tagPackage('function createPolicy() {}'), lim, { matchData: { f: () => 1 } })).toMatchObject({ ok: false, error: { code: 'bad_output' } });
    const wasm = { ...tagPackage('function createPolicy() {}'), runtime: 'wasm' as const };
    expect(loadTrustedPolicy(wasm, lim)).toEqual({ ok: false, error: { code: 'runtime_not_allowed' } });
    expect(loadTrustedPolicy(tagPackage('function createPolicy() {}'), limits({ runtimes: ['wasm'] }))).toEqual({ ok: false, error: { code: 'runtime_not_allowed' } });
  });

  it('adds little over a direct call on recorded observations', () => {
    const recorded = recordObservations([{ team: 'blue', role: 'runner' }], 220).get('blue/runner')!;
    const big = observation50k();
    // A bot-like decision over every unit, so the observation's size would show if it were serialised.
    const SCAN = `function think(obs) {
      var units = obs.units || obs.enemies || [], best = null, bestD = Infinity, hp = 0;
      for (var i = 0; i < units.length; i++) {
        var u = units[i], d = Math.hypot(u.x - 8, u.y - 8);
        hp += u.hp === undefined ? 1 : u.hp;
        if (d < bestD) { bestD = d; best = u; }
      }
      return best ? [{ kind: 'move', x: Math.round(best.x) % 16, y: Math.round(best.y) % 16, hp: hp }] : [];
    }`;
    const lim = limits({ maxLogLines: 8 });
    const report: Record<string, unknown> = {};
    for (const [name, script, observations] of [['tag example', EXAMPLE_POLICY, recorded], ['50 KB scan', SCAN, [big]]] as const) {
      const v = trustedLoad(asFactory(script), lim);
      // The same factory evaluated straight in a plain context with the same Math: the in-process bot baseline.
      const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY);
      vm.runInContext(`(${DETERMINISTIC_MATH_SOURCE})(Math); var log = function () {};\n${asFactory(script)}`, ctx);
      const direct = (vm.runInContext('createPolicy()', ctx) as { think(obs: unknown): unknown[] });
      const rounds = Math.ceil(2000 / observations.length);
      const overhead: number[] = [];
      const base: number[] = [];
      // One guarded batch, as a host think round runs its bot packages; both sides warm up first.
      guardedEach(1, () => {
        for (let r = 0; r < rounds + 2; r++) {
          for (const obs of observations) {
            const t0 = performance.now();
            const expected = direct.think(obs);
            const t1 = performance.now();
            const got = v.call(obs);
            const t2 = performance.now();
            if (!got.ok) throw new Error(JSON.stringify(got.error));
            if (JSON.stringify(got.intents) !== JSON.stringify(expected)) throw new Error('trusted and direct answers differ');
            if (r < 2) continue;
            base.push(t1 - t0);
            overhead.push(t2 - t1 - (t1 - t0));
          }
        }
      });
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
      report[name] = { calls: base.length, directMs: median(base), overheadMs: median(overhead) };
      // A JSON round trip of the 50 KB observation alone costs ~0.25 ms, a per-call guard or thread hop more.
      expect(median(overhead), name).toBeLessThan(0.05);
    }
    console.info('trusted call overhead (median ms):', JSON.stringify(report));
  }, 60_000);
});

describe('bot packages', () => {
  const idle = { runtime: 'js' as const, code: 'function think() { return []; }' };

  /** Tag whose `idle` runner tier is `script` as a package (`hash`: the package's surface). */
  function packaged(script = asFactory(EXAMPLE_POLICY), hash?: string): { def: GameDefinition<TagManifest>; asked: string[] } {
    const pkg = tagPackage(script, ['runner'], hash);
    const asked: string[] = [];
    const def: GameDefinition<TagManifest> = {
      ...definition,
      botPackages: (level, role) => {
        asked.push(`${level}/${role}`);
        return level === 'idle' && role === 'runner' ? pkg : undefined;
      },
    };
    return { def, asked };
  }

  const request = { opponent: 'idle', ticks: 1200, seed: 1, artifact: idle };
  const seat = { seat: { team: 'blue', role: 'runner' } };

  it('plays a practice seat with the registered package, and the built-in bot for a stale one', async () => {
    const fresh = packaged();
    const r = await practiceLocal(fresh.def, request, seat);
    if (!r.ok) throw new Error(r.code);
    // Both guards and red's runner: the tested blue runner is no bot.
    expect(fresh.asked.sort()).toEqual(['idle/guard', 'idle/guard', 'idle/runner']);
    // Red's runner is the example policy: it scores against idle defenders. The built-in idle bot never moves.
    expect(r.outcome).toBe('loss');
    expect(r.report).toMatchObject({ conceded: 3 });
    // Practice logs belong to the tested artifact only.
    expect(r.policy.logs).toEqual([]);

    const stale = packaged(undefined, '0'.repeat(64));
    const s = await practiceLocal(stale.def, request, seat);
    if (!s.ok) throw new Error(s.code);
    expect(stale.asked).toContain('idle/runner');
    expect(s.report).toMatchObject({ conceded: 0, captures: 0 });
  }, 120_000);

  it('hands a seat whose package hangs to the built-in bot', async () => {
    const hangs = packaged('function createPolicy() { return { think: function () { for (;;) {} } }; }');
    const r = await practiceLocal(hangs.def, request, seat);
    if (!r.ok) throw new Error(r.code);
    expect(r.wallMs).toBeGreaterThanOrEqual(TRUSTED_HANG_MS - 5);
    expect(r.report).toMatchObject({ conceded: 0, captures: 0 });
  }, 120_000);

  it('plays a live bot seat with the registered package', async () => {
    host = createPlayerThreeHost({ definition: packaged().def });
    const match = host.createMatch({
      seed: 1,
      realtime: false,
      controllers: { blue: { runner: 'none', guard: 'none' }, red: { runner: 'bot', guard: 'none' } },
      botLevel: { blue: 'idle', red: 'idle' },
    });
    let ended: Record<string, string> | undefined;
    match.onEnd((o) => (ended = o));
    await match.step(1200);
    expect(ended).toEqual({ blue: 'loss', red: 'win' });
  }, 120_000);

  it('seats a headless bot as the host does, naming the package that plays it', () => {
    const fresh = packaged();
    const seat = { team: 'blue', role: 'runner' } as const;
    const matchData = definition.create({ seed: 1, teams: ['blue', 'red'] }).matchData?.(seat) ?? null;
    const playing = seatBot(fresh.def, seat, 'idle', undefined, 1);
    playing.init?.(matchData);
    expect(playing.packageHash).toBe(fresh.def.botPackages!('idle', 'runner')!.hash);
    const built = seatBot(packaged(undefined, '0'.repeat(64)).def, seat, 'idle', undefined, 1);
    built.init?.(matchData);
    expect(built.packageHash).toBeUndefined();
    // A load failure falls back to the built-in bot: no package plays.
    const broken = seatBot(packaged('throw new Error("load");').def, seat, 'idle', undefined, 1);
    broken.init?.(matchData);
    expect(broken.packageHash).toBeUndefined();
    for (const b of [playing, built, broken]) b.dispose?.();
  });

  it('gives a live package seat its lobby bot options through createPolicy(options)', async () => {
    // Plays the example policy only with exactly the seat's options; any other value (or null) idles.
    const gated = asFactory(EXAMPLE_POLICY).replace('function createPolicy()', 'function playing()') +
      'function createPolicy(o) { return o !== null && o.aggression === 0.75 && o.economyReserve === 0.25 ? playing() : { think: function () { return []; } }; }\n';
    const play = async (options: Record<string, number> | undefined): Promise<Record<string, string> | undefined> => {
      const { def } = packaged(gated);
      host = createPlayerThreeHost({ definition: { ...def, botOptions: t.obj({ aggression: t.opt(t.num(0, 1)), economyReserve: t.opt(t.num(0, 1)) }) } });
      const match = host.createMatch({
        seed: 1,
        realtime: false,
        controllers: { blue: { runner: 'none', guard: 'none' }, red: { runner: 'bot', guard: 'none' } },
        botLevel: { blue: 'idle', red: 'idle' },
        ...(options ? { botSeats: [{ team: 'red', role: 'runner', level: 'idle', options }] } : {}),
      });
      let ended: Record<string, string> | undefined;
      match.onEnd((o) => (ended = o));
      await match.step(1200);
      host.dispose();
      host = undefined;
      return ended;
    };
    expect(await play({ aggression: 0.75, economyReserve: 0.25 })).toEqual({ blue: 'loss', red: 'win' });
    // Without its exact options the seat idles to the time cap.
    expect(await play({ aggression: 0.5, economyReserve: 0.25 })).toEqual({ blue: 'draw', red: 'draw' });
    expect(await play(undefined)).toEqual({ blue: 'draw', red: 'draw' });
  }, 120_000);

  it('keeps each seat its own options: per instance, never in the shared realm', () => {
    // One realm (one package); the top level and each instance report what they see; one seat mutates its copy.
    const script = 'var shared = typeof sharedOptions;\n' +
      'function createPolicy(o) { var seen = JSON.stringify(o); if (o) o.aggression = 99; ' +
      'return { think: function () { return [{ kind: "seen", options: seen, now: JSON.stringify(o), top: shared }]; } }; }\n';
    const pkg = tagPackage(script);
    const load = (options?: Record<string, number> | null) => {
      const r = loadTrustedPolicy(pkg, tagLimits, options === undefined ? {} : { options });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      trusted.push(r.instance);
      return r.instance;
    };
    const given = { aggression: 0.75, economyReserve: 0.25 };
    const [a, b, c] = [load(given), load({ aggression: 0.1 }), load()];
    const seen = (i: TrustedInstance) => {
      const r = i.call({});
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.intents[0];
    };
    expect(seen(a)).toEqual({ kind: 'seen', options: '{"aggression":0.75,"economyReserve":0.25}', now: '{"aggression":99,"economyReserve":0.25}', top: 'undefined' });
    expect(seen(b)).toEqual({ kind: 'seen', options: '{"aggression":0.1}', now: '{"aggression":99}', top: 'undefined' });
    expect(seen(c)).toEqual({ kind: 'seen', options: 'null', now: 'null', top: 'undefined' });
    // The host's object is never handed over: the instance mutated its own parsed copy.
    expect(given).toEqual({ aggression: 0.75, economyReserve: 0.25 });
  });
});
