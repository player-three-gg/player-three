import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PracticeResult } from 'playerthree';
import { main } from '../src/index.ts';

const TAG = new URL('../../playerthree/examples/tag/index.ts', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'playerthree-practice-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(['policy', 'practice', ...argv], { out: (s) => out.push(s), err: (s) => err.push(s), color: false });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const CLASSIC = `function think(obs) { log('seen', obs.tick); return [{ kind: 'stop' }]; }`;

describe('playerthree policy practice', () => {
  it('practices a classic script and prints stats, the policy logs and the report', async () => {
    const r = await run(TAG, file('classic.js', CLASSIC), '--ticks', '20', '--opponent', 'idle');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^outcome running after 20 ticks/);
    expect(r.out).toMatch(/calls \d+, meanMs [\d.]+, maxMs [\d.]+, errors 0, timeouts 0, intentsEmitted \d+/);
    expect(r.out).toContain('  seen 0');
    expect(r.out).toContain('report:');
  });

  it('--json prints exactly the PracticeResult', async () => {
    const r = await run(TAG, file('classic.js', CLASSIC), '--ticks', '20', '--seed', '3', '--seat', 'red/guard', '--json');
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out) as PracticeResult;
    expect(Object.keys(result).sort()).toEqual(['ok', 'outcome', 'policy', 'report', 'ticks', 'wallMs']);
    expect(result).toMatchObject({ ok: true, ticks: 20, policy: { version: 0, runtime: 'js', errors: 0 } });
    if (!result.ok) throw new Error(result.code);
    expect(result.policy.logs).toContain('seen 0');
  });

  it('builds a TypeScript entry with relative imports through the host module path', async () => {
    file('helper.ts', `export const target = (n: number): number => n % 16;\n`);
    const entry = file('policy.ts', `import { target } from './helper.ts';\nexport function think(obs: { tick: number }): unknown[] { log('ts', target(obs.tick)); return []; }\n`);
    const r = await run(TAG, entry, '--ticks', '10', '--opponent', 'idle', '--json');
    expect(r.err).toBe('');
    const result = JSON.parse(r.out) as PracticeResult;
    expect(result).toMatchObject({ ok: true, policy: { errors: 0 } });
    expect(result.policy.logs).toContain('ts 0');
  });

  it('treats a .js file with module syntax as an ES module entry', async () => {
    const entry = file('module.js', `export function think(obs) { log('esm', obs.tick); return []; }\n`);
    const r = await run(TAG, entry, '--ticks', '10', '--opponent', 'idle', '--json');
    expect(r.err).toBe('');
    expect((JSON.parse(r.out) as PracticeResult).policy.logs).toContain('esm 0');
  });

  it('rejects unknown opponents and out-of-range ticks as usage errors', async () => {
    const policy = file('classic.js', CLASSIC);
    const bad = await run(TAG, policy, '--opponent', 'godlike');
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--opponent must be one of idle, easy, hard');
    expect((await run(TAG, policy, '--ticks', '1201')).code).toBe(2);
  });

  it('reports an artifact over the size limit as too_large and exits 1', async () => {
    const r = await run(TAG, file('big.js', `//${'x'.repeat(64 * 1024)}`), '--ticks', '5');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^practice failed: policy/);
    expect(r.out).toContain('lastError: too_large');
  });
});
