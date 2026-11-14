import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadPolicy, type PolicyInstance } from 'playerthree/policy';
import { main } from '../src/index.ts';

const TAG = new URL('../../playerthree/examples/tag/index.ts', import.meta.url).pathname;
/** The tag example's `control.policy.maxArtifactBytes`. */
const TAG_MAX_BYTES = 64 * 1024;
const dir = mkdtempSync(join(tmpdir(), 'playerthree-build-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const live: PolicyInstance[] = [];
afterEach(() => {
  for (const p of live.splice(0)) p.dispose();
});

function file(name: string, text: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

async function build(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(['policy', 'build', ...argv], { out: (s) => out.push(s), err: (s) => err.push(s), color: false });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const limits = { runtimes: ['js' as const], hz: 4, msPerCall: 1000, memoryBytes: 16 << 20, maxArtifactBytes: 1 << 20, maxIntentsPerCall: 8, maxLogLines: 4, maxLogLineBytes: 64 };

describe('playerthree policy build', () => {
  it('bundles an ESM/TS entry into a classic script file the sandbox runs', async () => {
    file('ok/lib/geo.ts', 'export const step = (x: number): number => x + 1;\n');
    const entry = file('ok/main.ts', "import { step } from './lib/geo.ts';\nexport function think(obs: { x: number }): unknown[] { return [{ kind: 'move', x: step(obs.x) }]; }\n");
    const out = join(dir, 'out/policy.js');
    mkdirSync(dirname(out), { recursive: true });
    const r = await build(entry, '--out', out);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const code = readFileSync(out, 'utf8');
    expect(code).toContain('// lib/geo.ts');
    const loaded = await loadPolicy('js', code, limits);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    live.push(loaded.instance);
    const called = await loaded.instance.call({ x: 2 });
    expect(called).toMatchObject({ ok: true, value: { intents: [{ kind: 'move', x: 3 }] } });
    // Without --out the script goes to stdout, identical to the file.
    expect((await build(entry)).out).toBe(code.slice(0, -1));
  });

  it('rejects bad imports, files outside the entry directory and a missing think export', async () => {
    file('outside.ts', 'export const x = 1;\n');
    const cases: [string, RegExp][] = [
      ["import fs from 'fs';\nexport function think() { return [fs]; }\n", /^main\.ts:1:\d+: "fs" is not a relative import/],
      ["import { x } from '../outside.ts';\nexport function think() { return [x]; }\n", /^main\.ts:1:\d+: "\.\.\/outside\.ts" escapes the policy root/],
      ["import { x } from './missing.ts';\nexport function think() { return [x]; }\n", /could not resolve/],
      ['await 0;\nexport function think() { return []; }\n', /^main\.ts:1:\d+: /],
      ['export function decide() { return []; }\n', /^main\.ts:1:0: main\.ts must export think$/],
    ];
    for (const [source, message] of cases) {
      const r = await build(file('bad/main.ts', source));
      expect(r.code, source).toBe(1);
      expect(r.err, source).toMatch(message);
      expect(r.out, source).toBe('');
    }
  });

  it('with --game composes includes, resolves skill imports and enforces maxArtifactBytes', async () => {
    const entry = file('game/main.mjs', "import './tag-strategy/policies/simple.js';\nexport function think() { return []; }\n");
    expect((await build(entry)).err).toMatch(/could not resolve/);
    const r = await build(entry, '--game', TAG, '--include', 'tag-strategy/policies/simple.js');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    // The include is prepended to the bundle (the side-effect-free skill import itself resolves and is tree-shaken).
    const bare = await build(entry, '--game', TAG);
    expect(bare.code).toBe(0);
    expect(r.out.length).toBeGreaterThan(bare.out.length);
    expect(r.out.endsWith(`\n${bare.out}`)).toBe(true);
    expect(await build(entry, '--game', TAG, '--include', 'tag-strategy/SKILL.md')).toMatchObject({ code: 1, err: expect.stringMatching(/--include/) });

    const big = file('big/main.ts', `const pad = '${'x'.repeat(TAG_MAX_BYTES)}';\nexport function think(): unknown[] { return [pad.length]; }\n`);
    expect(await build(big)).toMatchObject({ code: 0 });
    const over = await build(big, '--game', TAG);
    expect(over.code).toBe(1);
    expect(over.err).toMatch(new RegExp(`allows at most ${TAG_MAX_BYTES} \\(maxArtifactBytes\\)`));
  });

  it('with --from builds a starter reference exactly as policy_deploy does, with closed errors', async () => {
    const starter = 'tag-strategy/policies/starter.js';
    const ok = await build('--from', starter, '--knobs', '{"flank":2,"stance":"attack"}', '--game', TAG);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain("createPolicy(JSON.parse('{\"stance\":\"attack\",\"flank\":2}'))");
    const loaded = await loadPolicy('js', `${ok.out}\n`, limits);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) live.push(loaded.instance);
    const bad = await build('--from', starter, '--knobs', '{"flank":9}', '--game', TAG);
    expect(bad).toMatchObject({ code: 1, err: 'invalid (range) at ["knobs","flank"]: expected Knobs["flank"]: number (integer 0..7)' });
    const notStarter = await build('--from', 'tag-strategy/policies/simple.js', '--game', TAG);
    expect(notStarter).toMatchObject({ code: 1, err: expect.stringContaining('invalid (enum) at ["from"]') });
    expect((await build('--from', starter)).code).toBe(2);
    expect((await build('--from', starter, '--game', TAG, '--role', 'keeper')).code).toBe(2);
  });

  it('reports usage errors with exit 2', async () => {
    expect((await build()).code).toBe(2);
    expect((await build(file('u/main.ts', 'export function think() { return []; }\n'), '--include', 'x/y.js')).code).toBe(2);
  });
});
