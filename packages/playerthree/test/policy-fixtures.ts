import type { PolicyLimits } from '../src/manifest.ts';
import type { PolicyCallOutcome, PolicyCallResult, PolicyInstance } from '../src/policy/index.ts';

export const limits = (over: Partial<PolicyLimits> = {}): PolicyLimits => ({
  runtimes: ['js', 'wasm'],
  hz: 4,
  msPerCall: 1000,
  memoryBytes: 16 << 20,
  maxArtifactBytes: 64 << 10,
  maxIntentsPerCall: 8,
  maxLogLines: 4,
  maxLogLineBytes: 64,
  ...over,
});

export function ok(r: PolicyCallOutcome): PolicyCallResult {
  if (!r.ok) throw new Error(`call failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** ~50 KB of JSON: 560 units of an RTS-like observation. */
export function observation50k() {
  const units = Array.from({ length: 560 }, (_, i) => ({
    id: `e_${i}`,
    kind: i % 3 ? 'tank' : 'drone',
    team: i % 2 ? 'red' : 'blue',
    plane: 'surface',
    x: ((i * 37) % 500) + 0.5,
    y: ((i * 91) % 500) + 0.25,
    hp: 100 - (i % 50),
  }));
  return { tick: 1, units };
}

/** Mean/max host-observed call time (ms, including serialisation and the thread round trip) over `n` calls after a warm-up. */
export async function measure(p: PolicyInstance, obs: unknown, n = 200) {
  for (let i = 0; i < 5; i++) ok(await p.call(obs));
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    ok(await p.call(obs));
    const ms = performance.now() - t0;
    sum += ms;
    max = Math.max(max, ms);
  }
  return { mean: sum / n, max, n, bytes: Buffer.byteLength(JSON.stringify(obs)) };
}
