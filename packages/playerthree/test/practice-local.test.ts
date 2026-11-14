import { afterEach, describe, expect, it } from 'vitest';
import { definition, EXAMPLE_POLICY, type TagManifest } from '../examples/tag/index.ts';
import type { PracticeResult } from '../src/control.ts';
import { createPlayerThreeHost, practiceLocal } from '../src/host/index.ts';
import type { PlayerThreeHost } from '../src/host/types.ts';

let host: PlayerThreeHost<TagManifest> | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
});

const artifact = { runtime: 'js' as const, code: EXAMPLE_POLICY };
const request = { opponent: 'easy', ticks: 1200, seed: 1, artifact };

/** Recursive key structure and value types: what must match between entry points. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return v === null ? 'null' : typeof v;
}

/** The result without wall-clock timing (machine-dependent). */
function untimed(r: PracticeResult): unknown {
  const { wallMs: _wallMs, policy, ...rest } = r;
  const { meanMs: _meanMs, maxMs: _maxMs, ...stats } = policy;
  return { ...rest, policy: stats };
}

describe('practiceLocal', () => {
  it('plays the tested artifact against built-in bots without a host', async () => {
    const r = await practiceLocal(definition, request, { seat: { team: 'blue', role: 'runner' } });
    if (!r.ok) throw new Error(r.code);
    expect(r.outcome).toBe('win');
    expect(r.ticks).toBeLessThan(1200);
    expect(r.report).toMatchObject({ outcome: 'win' });
    expect(r.policy).toMatchObject({ version: 0, runtime: 'js', errors: 0, timeouts: 0 });
    expect(r.policy.calls).toBeGreaterThan(50);
    expect(r.policy.logs.length).toBeGreaterThan(0);
  });

  it('is deterministic for a seed, and seeds 1 by default on the first team and role', async () => {
    const a = await practiceLocal(definition, request);
    const b = await practiceLocal(definition, request);
    expect(untimed(b)).toEqual(untimed(a));
    const { seed: _seed, ...unseeded } = request;
    expect(untimed(await practiceLocal(definition, unseeded))).toEqual(untimed(a));
  });

  it('returns exactly the practice_run result for the same seat, seed and artifact', async () => {
    host = createPlayerThreeHost({ definition });
    const match = host.createMatch({ seed: 4, realtime: false, controllers: { blue: { runner: 'none', guard: 'none' }, red: { runner: 'none', guard: 'none' } } });
    const live = await match.seat('red', 'guard').practice(request);
    const local = await practiceLocal(definition, request, { seat: { team: 'red', role: 'guard' } });
    expect(shape(local)).toEqual(shape(live));
    expect(untimed(local)).toEqual(untimed(live));
  });

  it('reports a rejected artifact as a policy failure and validates the request like practice_run', async () => {
    const big = { runtime: 'js' as const, code: `//${'x'.repeat(definition.manifest.control.policy.maxArtifactBytes)}` };
    const r = await practiceLocal(definition, { opponent: 'idle', ticks: 10, artifact: big });
    expect(r).toMatchObject({ ok: false, code: 'policy', policy: { version: 0, errors: 1, lastError: { code: 'too_large' } } });
    expect(r).not.toHaveProperty('report');
    await expect(practiceLocal(definition, { opponent: 'godlike', ticks: 10, artifact })).rejects.toMatchObject({ code: 'invalid' });
    await expect(practiceLocal(definition, { opponent: 'idle', ticks: 1201, artifact })).rejects.toMatchObject({ code: 'invalid' });
    await expect(practiceLocal(definition, { opponent: 'idle', ticks: 10, artifact }, { seat: { team: 'green', role: 'runner' } })).rejects.toMatchObject({ code: 'invalid' });
  });
});
