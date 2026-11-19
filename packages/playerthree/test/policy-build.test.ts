import { afterEach, describe, expect, it } from 'vitest';
import { manifest as tag } from '../examples/tag/index.ts';
import { servedSkills } from '../src/briefing.ts';
import { POLICY_MAX_MODULES, POLICY_MODULES_MAX_BYTES, type SkillDef } from '../src/manifest.ts';
import { checkArgs } from '../src/mcp/args.ts';
import { toolSurface } from '../src/mcp/surface.ts';
import { annotateLoadError, parseArtifact } from '../src/host/pipeline.ts';
import { PlayerThreeError } from '../src/host/util.ts';
import { buildPolicy, loadPolicy, type PolicyBuildResult, type PolicyInstance } from '../src/policy/index.ts';
import { limits, ok } from './policy-fixtures.ts';

const coach: SkillDef = {
  name: 'coach',
  description: 'test skill',
  files: {
    'SKILL.md': '---\nname: coach\ndescription: test\n---\n',
    'lib/aim.js': 'export function aim(x) { return x * 2; }\n',
    'lib/global.js': 'function libHelper() { return "lib"; }\n',
    'lib/bad.js': 'var ok = 1;\nvar broken = ;\n',
    'notes.md': '# notes\n',
  },
};
const skills = [coach];
const ctx = { skills, starters: new Map() };

const live: PolicyInstance[] = [];
afterEach(() => {
  for (const p of live.splice(0)) p.dispose();
});

async function run(code: string, matchData?: unknown): Promise<PolicyInstance> {
  const r = await loadPolicy('js', code, limits(), matchData === undefined ? undefined : { matchData });
  if (!r.ok) throw new Error(`load failed: ${JSON.stringify(r.error)}`);
  live.push(r.instance);
  return r.instance;
}

const build = (modules: Record<string, string>, entry = 'main.ts'): Promise<PolicyBuildResult> =>
  buildPolicy({ entry, load: (path) => (Object.hasOwn(modules, path) ? modules[path] : undefined), skills });

async function built(modules: Record<string, string>, entry = 'main.ts'): Promise<string> {
  const r = await build(modules, entry);
  if (!r.ok) throw new Error(`build failed: ${r.message} at ${JSON.stringify(r.location)}`);
  return r.code;
}

async function buildError(modules: Record<string, string>, entry = 'main.ts'): Promise<{ message: string; location: { file: string; line: number; column: number } }> {
  const r = await build(modules, entry);
  if (r.ok) throw new Error('build unexpectedly succeeded');
  return r;
}

/** parseArtifact's thrown PlayerThreeError, or undefined when it did not throw. */
async function thrown(raw: unknown, over = {}): Promise<PlayerThreeError | undefined> {
  try {
    await parseArtifact(raw, limits(over), ctx);
  } catch (e) {
    if (e instanceof PlayerThreeError) return e;
    throw e;
  }
  return undefined;
}

const MAIN = `
import { step, type Point } from './lib/geo.ts';
import { aim } from './coach/lib/aim.js';
let calls = 0;
export const detail = 'all';
export function init(data: { base: number } | null): void { calls = data ? data.base : 0; }
export function think(obs: { x: number }): Point[] { calls++; return [{ kind: 'move', ...step(obs.x), n: aim(calls) }]; }
`;
const GEO = `
export interface Point { kind: string; x: number; n?: number }
export function step(x: number): Omit<Point, 'kind'> { return { x: x + 1 }; }
`;

describe('buildPolicy', () => {
  it('bundles ES/TS modules and served skill imports into a classic script the real sandbox runs', async () => {
    const code = await built({ 'main.ts': MAIN, 'lib/geo.ts': GEO });
    expect(code).not.toMatch(/^\s*(import|export)\b/m);
    expect(code).toContain('// lib/geo.ts');
    expect(code).toContain('// coach/lib/aim.js');
    const p = await run(code, { base: 10 });
    // init (base 10) and detail reached the ABI; think sees the module-scoped state.
    expect(p.detail).toBe('all');
    expect(ok(await p.call({ x: 4 })).intents).toEqual([{ kind: 'move', x: 5, n: 22 }]);
    expect(ok(await p.call({ x: 0 })).intents).toEqual([{ kind: 'move', x: 1, n: 24 }]);
  });

  it('binds only the ABI globals the entry exports', async () => {
    const code = await built({ 'main.mjs': 'export function think() { return [{ kind: typeof init + "/" + typeof detail }]; }' }, 'main.mjs');
    expect(code).not.toContain('var init');
    expect(code).not.toContain('var detail');
    expect(ok(await (await run(code)).call({})).intents).toEqual([{ kind: 'undefined/undefined' }]);
  });

  it('binds an exported createPolicy, the trusted runner factory, next to think', async () => {
    const entry = 'export function createPolicy() { return { think: () => [{ kind: "seat" }] }; }\nconst seat = createPolicy();\nexport const think = () => seat.think();\n';
    const code = await built({ 'main.ts': entry });
    expect(code).toContain('var createPolicy = ');
    expect(ok(await (await run(`${code}\nvar think0 = think; think = function (o) { return [typeof createPolicy].concat(think0(o)); };`)).call({})).intents).toEqual(['function', { kind: 'seat' }]);
  });

  it('is deterministic', async () => {
    const modules = { 'main.ts': MAIN, 'lib/geo.ts': GEO };
    expect(await built(modules)).toBe(await built(modules));
  });

  it('rejects imports outside the module rules with esbuild-located own text', async () => {
    const cases: [string, RegExp][] = [
      ["import x from 'fs';", /not a relative import/],
      ["import x from '/etc/x.js';", /not a relative import/],
      ["import x from 'https://example.com/x.js';", /not a relative import/],
      ["import x from '../x.js';", /escapes the policy root/],
      ["import x from './lib';", /file extension/],
      ["import x from './nope.js';", /could not resolve/],
      ["import x from './coach/notes.md';", /file extension/],
      ["import x from './coach/lib/none.js';", /could not resolve/],
      ["const x = require('./lib/geo.ts');", /require is not supported/],
      ["const x = import('./lib/geo.ts');", /dynamic import\(\) is not supported/],
      ['const f = (p) => import(p);', /import/],
      ["import x from './lib/geo.ts' with { type: 'json' };", /import attributes/],
    ];
    for (const [line, message] of cases) {
      // `x` is used: TypeScript semantics elide imports only used as types (or not at all) before resolution.
      const e = await buildError({ 'main.ts': `${line}\nexport function think() { return [typeof x]; }\n`, 'lib/geo.ts': GEO });
      expect(e.message, line).toMatch(message);
      expect(e.location, line).toMatchObject({ file: 'main.ts', line: 1 });
    }
  });

  it('locates errors in the failing module and requires a think export', async () => {
    const e = await buildError({ 'main.ts': "import { step } from './lib/geo.ts';\nexport function think() { return [step(1)]; }\n", 'lib/geo.ts': 'export const a = 1;\nexport function step( { return 1; }\n' });
    expect(e.location).toMatchObject({ file: 'lib/geo.ts', line: 2 });
    expect(await buildError({ 'main.ts': 'export function decide() { return []; }\n' })).toEqual({ ok: false, message: 'main.ts must export think', location: { file: 'main.ts', line: 1, column: 0 } });
    // Module syntax the classic script cannot keep (top-level await) is a build error.
    expect((await buildError({ 'main.ts': 'await 0;\nexport function think() { return []; }\n' })).location).toMatchObject({ file: 'main.ts', line: 1 });
    expect((await buildError({ 'main.ts': 'export function think() { return []; }' }, 'other.ts')).message).toMatch(/not a provided module/);
  });
});

describe('parseArtifact with modules', () => {
  const think = 'export function think() { return []; }\n';

  it('bundles, composes include before the bundle and returns the source', async () => {
    const raw = { runtime: 'js', modules: { 'main.ts': 'export function think() { return [{ kind: libHelper() }]; }\n' }, entry: 'main.ts', include: ['coach/lib/global.js'] };
    const parsed = await parseArtifact(raw, limits(), ctx);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.source).toEqual(raw);
    expect(parsed.artifact.code.startsWith(`${coach.files['lib/global.js']}\n`)).toBe(true);
    expect(ok(await (await run(parsed.artifact.code)).call({})).intents).toEqual([{ kind: 'lib' }]);
  });

  it('applies the size limit to the composed script', async () => {
    const raw = { runtime: 'js', modules: { 'main.ts': `${think}// ${'x'.repeat(2000)}\n` }, entry: 'main.ts' };
    expect(await parseArtifact(raw, limits({ maxArtifactBytes: 1000 }), ctx)).toEqual({ ok: false, error: { code: 'too_large' } });
  });

  it('rejects malformed module artifacts as invalid before bundling', async () => {
    const many = Object.fromEntries(Array.from({ length: POLICY_MAX_MODULES + 1 }, (_, i) => [`m${i}.js`, think]));
    const huge = { 'main.js': think, 'big.js': `//${'x'.repeat(POLICY_MODULES_MAX_BYTES)}` };
    const cases: [string, unknown][] = [
      ['traversal key', { runtime: 'js', modules: { '../x.js': think }, entry: '../x.js' }],
      ['absolute key', { runtime: 'js', modules: { '/x.js': think }, entry: '/x.js' }],
      ['no extension', { runtime: 'js', modules: { main: think }, entry: 'main' }],
      ['__proto__ key', { runtime: 'js', modules: JSON.parse(`{"__proto__":${JSON.stringify(think)}}`), entry: '__proto__' }],
      ['skill-named key', { runtime: 'js', modules: { 'coach/x.js': think }, entry: 'coach/x.js' }],
      ['too many modules', { runtime: 'js', modules: many, entry: 'm0.js' }],
      ['too much source', { runtime: 'js', modules: huge, entry: 'main.js' }],
      ['missing entry', { runtime: 'js', modules: { 'main.js': think }, entry: 'other.js' }],
      ['non-string module', { runtime: 'js', modules: { 'main.js': 1 }, entry: 'main.js' }],
      ['empty modules', { runtime: 'js', modules: {}, entry: 'main.js' }],
      ['unknown include', { runtime: 'js', modules: { 'main.js': think }, entry: 'main.js', include: ['coach/none.js'] }],
    ];
    for (const [label, raw] of cases) {
      const e = await thrown(raw);
      expect(e?.code, label).toBe('invalid');
      expect(e?.detail, label).toBeUndefined();
    }
  });

  it('names the missing or extra member of a malformed artifact: closed schemaCode, path and expected', async () => {
    const bodies = 'Artifact: one of code | modules+entry';
    const shapes: [string, unknown, { schemaCode: string; path: (string | number)[]; expected: string }][] = [
      ['no body', { runtime: 'js' }, { schemaCode: 'missing_field', path: ['code'], expected: bodies }],
      ['nothing at all', {}, { schemaCode: 'missing_field', path: ['code'], expected: bodies }],
      ['entry alone', { runtime: 'js', entry: 'main.js' }, { schemaCode: 'missing_field', path: ['modules'], expected: 'Artifact: { runtime: "js"; modules; entry; include? }' }],
      ['no runtime', { code: 'function think(){return []}' }, { schemaCode: 'missing_field', path: ['runtime'], expected: 'Artifact["runtime"]: "js" | "wasm"' }],
      ['modules without entry', { runtime: 'js', modules: { 'main.js': think } }, { schemaCode: 'missing_field', path: ['entry'], expected: 'Artifact["entry"]: string (one of the modules keys)' }],
      ['entry without modules', { runtime: 'js', code: 'function think(){return []}', entry: 'main.js' }, { schemaCode: 'unknown_field', path: ['entry'], expected: 'Artifact: { runtime; code; include? }' }],
      ['code and modules', { runtime: 'js', code: 'x', modules: { 'main.js': think }, entry: 'main.js' }, { schemaCode: 'unknown_field', path: ['modules'], expected: 'Artifact: { runtime; code; include? }' }],
      ['wasm modules', { runtime: 'wasm', modules: { 'main.js': think }, entry: 'main.js' }, { schemaCode: 'enum', path: ['runtime'], expected: 'Artifact["runtime"]: "js"' }],
      ['unknown key', { runtime: 'js', code: 'x', secret_key: 1 }, { schemaCode: 'unknown_field', path: ['?'], expected: 'Artifact: { runtime; code; include? } | { runtime: "js"; modules; entry; include? }' }],
      ['empty code', { runtime: 'js', code: '' }, { schemaCode: 'range', path: ['code'], expected: 'Artifact["code"]: string (nonempty)' }],
    ];
    for (const [label, raw, detail] of shapes) {
      const e = await thrown(raw);
      expect(e?.code, label).toBe('invalid');
      expect(e?.detail, label).toEqual(detail);
    }
  });

  it('reports a build failure as invalid with own-text detail', async () => {
    const e = await thrown({ runtime: 'js', modules: { 'main.js': "import fs from 'fs';\nexport function think() { return []; }\n" }, entry: 'main.js' });
    expect(e?.code).toBe('invalid');
    expect(e?.detail).toMatchObject({ message: expect.stringMatching(/"fs" is not a relative import/), location: { file: 'main.js', line: 1 } });
    const missing = await thrown({ runtime: 'js', modules: { 'main.js': 'export const x = 1;\n' }, entry: 'main.js' });
    expect(missing?.detail).toEqual({ message: 'main.js must export think', location: { file: 'main.js', line: 1, column: 0 } });
  });
});

describe('annotateLoadError', () => {
  async function loadError(raw: { runtime: 'js'; code: string; include: string[] }) {
    const parsed = await parseArtifact(raw, limits(), ctx);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    const loaded = await loadPolicy('js', parsed.artifact.code, limits());
    if (loaded.ok) throw new Error('load unexpectedly succeeded');
    return annotateLoadError(loaded.error, parsed.source, skills);
  }

  it('names the include file or code part a composed load failure comes from', async () => {
    // global.js ends with a newline, so it spans two lines of the composed script before bad.js starts.
    const inInclude = await loadError({ runtime: 'js', code: 'function think() { return []; }', include: ['coach/lib/global.js', 'coach/lib/bad.js'] });
    expect(inInclude).toMatchObject({ code: 'compile', message: expect.stringMatching(/\(policy\.js:4:(\d+)\) \(in coach\/lib\/bad\.js:2:\1\)$/) });
    const inCode = await loadError({ runtime: 'js', code: 'var a = 1;\nnull.x;\nfunction think() { return []; }', include: ['coach/lib/global.js'] });
    expect(inCode).toMatchObject({ code: 'threw', message: expect.stringMatching(/\(policy\.js:4:(\d+)\) \(in code:2:\1\)$/) });
  });

  it('leaves other errors and include-free sources unchanged', () => {
    const error = { code: 'compile' as const, message: 'SyntaxError: x (policy.js:1:1)' };
    expect(annotateLoadError(error, { runtime: 'js', code: 'x' }, skills)).toBe(error);
    const timeout = { code: 'timeout' as const, message: '(policy.js:1:1)' };
    expect(annotateLoadError(timeout, { runtime: 'js', code: 'x', include: ['coach/lib/global.js'] }, skills)).toBe(timeout);
  });
});

describe('policy_deploy input schema', () => {
  const schema = new Map(toolSurface(tag, servedSkills(tag)).map((tool) => [tool.method, tool.inputSchema])).get('policyDeploy')!;
  const esm = 'export function think() { return []; }';

  it('accepts code or modules + entry and checks module maps without naming their keys', () => {
    expect(checkArgs(schema, { runtime: 'js', code: 'x' })).toEqual({ ok: true });
    expect(checkArgs(schema, { runtime: 'js', modules: { 'main.ts': esm, 'lib/a.mjs': esm }, entry: 'main.ts' })).toEqual({ ok: true });
    // Body combinations are the host's rule: it names the missing or extra member (parseArtifact tests above).
    expect(checkArgs(schema, { runtime: 'js', modules: { 'main.ts': esm } })).toEqual({ ok: true });
    expect(checkArgs(schema, { runtime: 'js', entry: 'main.ts' })).toEqual({ ok: true });
    expect(checkArgs(schema, { runtime: 'js', modules: { '../x.js': esm }, entry: 'main.ts' })).toEqual({ ok: false, code: 'pattern', path: ['modules', '?'] });
    expect(checkArgs(schema, { runtime: 'js', modules: { 'main.ts': 1 }, entry: 'main.ts' })).toEqual({ ok: false, code: 'type', path: ['modules', '?'] });
    expect(checkArgs(schema, { runtime: 'js', modules: {}, entry: 'main.ts' })).toEqual({ ok: false, code: 'range', path: ['modules'] });
    const many = Object.fromEntries(Array.from({ length: POLICY_MAX_MODULES + 1 }, (_, i) => [`m${i}.js`, esm]));
    expect(checkArgs(schema, { runtime: 'js', modules: many, entry: 'm0.js' })).toEqual({ ok: false, code: 'too_long', path: ['modules'] });
  });
});
