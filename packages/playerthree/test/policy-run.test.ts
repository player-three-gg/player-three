import { describe, expect, it, vi } from 'vitest';
import { MAX_CONSECUTIVE_TIMEOUTS, PolicyRun } from '../src/host/policy.ts';
import type * as Sandbox from '../src/policy/index.ts';
import type { LoadPolicy, PolicyCallOutcome, PolicyInstance } from '../src/policy/types.ts';
import { limits } from './policy-fixtures.ts';

// Host-side sandbox failures (no worker thread, boot timeout) make the loader reject rather than return an error.
const loadPolicy = vi.hoisted(() => ({ fn: undefined as unknown as LoadPolicy }));
vi.mock('../src/policy/index.ts', () => ({ loadPolicy: (...args: Parameters<LoadPolicy>) => loadPolicy.fn(...args) }));
const sandbox = await vi.importActual<typeof Sandbox>('../src/policy/index.ts');

/** An instance killed by its first call (as after a timeout), so the next think must restart it. */
function dyingInstance(): PolicyInstance {
  let dead = false;
  return {
    runtime: 'js',
    detail: undefined,
    get dead() { return dead; },
    async call() {
      dead = true;
      return { ok: false, error: { code: 'timeout' }, ms: 1 };
    },
    dispose() {},
  };
}

describe('policy run restarts', () => {
  it('a rejected restart load stops the run without rejecting think or poisoning later calls', async () => {
    loadPolicy.fn = () => Promise.reject(new Error('worker exhausted'));
    const run = new PolicyRun(1, { runtime: 'js', code: 'function think() { return []; }' }, dyingInstance(), limits(), 1, null, []);
    expect(await run.think({})).toMatchObject({ intents: [], error: { code: 'timeout' } });
    expect(await run.think({})).toMatchObject({ intents: [], error: { code: 'threw' } });
    expect(await run.think({})).toEqual({ intents: [], logs: [], ms: 0 });
    expect(run.active).toBe(false);
    expect(run.snapshot()).toMatchObject({ successfulCalls: 0, consecutiveFailures: 2, timeouts: 1, errors: 1, lastError: { code: 'threw' } });
  });

  it('counts successful empty decisions and clears failure streaks without erasing historical errors', async () => {
    let calls = 0;
    const run = new PolicyRun(1, { runtime: 'js', code: '' }, {
      runtime: 'js', detail: undefined, dead: false, dispose() {},
      async call() {
        return ++calls <= 2 ? { ok: false, error: { code: 'threw' }, ms: 1 }
          : { ok: true, value: { intents: [], dropped: 0, logs: [], ms: 1, cpuMs: 1 } };
      },
    }, limits(), 1, null, []);
    await run.think({});
    await run.think({});
    expect(run.snapshot()).toMatchObject({ calls: 2, successfulCalls: 0, consecutiveFailures: 2 });
    await run.think({});
    expect(run.snapshot()).toMatchObject({ calls: 3, successfulCalls: 1, consecutiveFailures: 0, errors: 2, lastError: { code: 'threw' } });
    run.dispose();
  });
});

describe('policy run timeouts an instance survives (JS)', () => {
  const TIMEOUT: PolicyCallOutcome = { ok: false, error: { code: 'timeout' }, ms: 5, cpuMs: 5, logs: [] };
  const SUCCESS: PolicyCallOutcome = { ok: true, value: { intents: [], dropped: 0, logs: [], ms: 1, cpuMs: 1 } };
  /** An instance that answers `script` in order (then successes) and stays alive until disposed. */
  function scripted(script: PolicyCallOutcome[]): PolicyInstance {
    let disposed = false;
    return {
      runtime: 'js', detail: undefined,
      get dead() { return disposed; },
      async call() { return script.shift() ?? SUCCESS; },
      dispose() { disposed = true; },
    };
  }

  it(`kills and reloads the instance after ${MAX_CONSECUTIVE_TIMEOUTS} timeouts in a row`, async () => {
    let loads = 0;
    loadPolicy.fn = async () => {
      loads++;
      return { ok: true, instance: scripted([]) };
    };
    const first = scripted(Array(MAX_CONSECUTIVE_TIMEOUTS).fill(TIMEOUT));
    const run = new PolicyRun(1, { runtime: 'js', code: '' }, first, limits(), 1, null, []);
    for (let i = 1; i < MAX_CONSECUTIVE_TIMEOUTS; i++) {
      expect(await run.think({})).toMatchObject({ error: { code: 'timeout' } });
      expect(first.dead).toBe(false);
    }
    expect(await run.think({})).toMatchObject({ error: { code: 'timeout' } });
    expect(first.dead).toBe(true);
    expect(loads).toBe(0);
    expect(await run.think({})).toEqual({ intents: [], logs: [], ms: 1 });
    expect(loads).toBe(1);
    expect(run.snapshot()).toMatchObject({ calls: MAX_CONSECUTIVE_TIMEOUTS + 1, successfulCalls: 1, timeouts: MAX_CONSECUTIVE_TIMEOUTS, consecutiveFailures: 0 });
    run.dispose();
  });

  it('a successful call resets the count', async () => {
    loadPolicy.fn = () => Promise.reject(new Error('no reload expected'));
    const below = Array(MAX_CONSECUTIVE_TIMEOUTS - 1).fill(TIMEOUT);
    const instance = scripted([...below, SUCCESS, ...below, SUCCESS]);
    const run = new PolicyRun(1, { runtime: 'js', code: '' }, instance, limits(), 1, null, []);
    for (let i = 0; i < 2 * MAX_CONSECUTIVE_TIMEOUTS; i++) await run.think({});
    expect(instance.dead).toBe(false);
    expect(run.snapshot()).toMatchObject({ successfulCalls: 2, timeouts: 2 * (MAX_CONSECUTIVE_TIMEOUTS - 1), consecutiveFailures: 0 });
    run.dispose();
  });

  it('keeps a real JS instance\'s state through a timeout and reloads it fresh after the cap', { timeout: 30_000 }, async () => {
    loadPolicy.fn = sandbox.loadPolicy;
    const code = 'let n = 0; function think(obs) { n++; if (obs.spin) for (;;) {} return [n]; }';
    const lim = limits({ msPerCall: 50 });
    const loaded = await sandbox.loadPolicy('js', code, lim);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const run = new PolicyRun(1, { runtime: 'js', code }, loaded.instance, lim, 1, null, []);
    try {
      expect(await run.think({})).toMatchObject({ intents: [1] });
      expect(await run.think({ spin: true })).toMatchObject({ error: { code: 'timeout' } });
      // The interrupted call's increment survived.
      expect(await run.think({})).toMatchObject({ intents: [3] });
      for (let i = 0; i < MAX_CONSECUTIVE_TIMEOUTS; i++) expect(await run.think({ spin: true })).toMatchObject({ error: { code: 'timeout' } });
      // Reloaded: a fresh instance counts from its own first call.
      expect(await run.think({})).toMatchObject({ intents: [1] });
    } finally {
      run.dispose();
    }
  });
});
