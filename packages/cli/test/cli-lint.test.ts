import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { definition } from '../../playerthree/examples/tag/index.ts';
import { lintDefinition, main, worstCase } from '../src/index.ts';
import { nonConformance } from '../src/conforms.ts';
import { objectMutations, rng, validValue, type JsonSchema } from '../src/fuzz.ts';
import type { GameDefinition } from 'playerthree';
import { t, toJsonSchema, validate, type Schema } from 'playerthree/schema';
import { buildBriefing, expectedAt, manifestDts, topicPage } from 'playerthree';
import { readSurface } from '../src/seat-surface.ts';
import { policyOwnText, vocabularyOf, vocabularyViolations } from '../src/vocab.ts';

const TAG = new URL('../../playerthree/examples/tag/index.ts', import.meta.url).pathname;
const BAD = new URL('./fixtures/sloppy-game.ts', import.meta.url).pathname;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), color: false }, out, err };
}

describe('worst-case observation size', () => {
  const schema = t.obj({
    tick: t.int(0, 1_000_000),
    speed: t.num(-250.5, 99.25),
    unit: t.opt(t.id('u')),
    mode: t.enum(['a', 'longest_literal_here']),
    units: t.list(t.obj({ id: t.id('e'), hp: t.int(0, 100), alive: t.bool(), tags: t.list(t.enum(['x', 'yy']), 3) }), 7),
    order: t.union('kind', { go: { x: t.num(0, 1) }, wait: {} }),
  });

  it('is an upper bound on the JSON size of every conforming value', () => {
    const worst = worstCase(schema);
    const js = toJsonSchema(schema);
    const rand = rng(42);
    for (let i = 0; i < 500; i++) {
      const v = validValue(js, i % 3 === 0 ? 'max' : 'random', rand, 1000);
      expect(validate(schema, v).ok).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThanOrEqual(worst.bytes);
    }
    // Extreme doubles at the range edges still fit (17 significant digits).
    const extreme = { tick: 1_000_000, speed: -250.49999999999997, unit: 'u_999999999', mode: 'longest_literal_here', units: [], order: { kind: 'go', x: 0.30000000000000004 } };
    expect(validate(schema, extreme).ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(extreme))).toBeLessThanOrEqual(worst.bytes);
  });

  it('scales with list maxima', () => {
    const one = worstCase(t.list(t.int(0, 9), 1));
    const many = worstCase(t.list(t.int(0, 9), 100));
    expect(many.bytes).toBe(2 + 100 + 99);
    expect(one.bytes).toBe(3);
  });
});

describe('bounded strings and flat integer arrays', () => {
  it('accounts for integer-array bytes tightly and matches the equivalent generic list', () => {
    for (const [maxItems, min, max] of [[0, 0, 9], [1, 0, 9], [3200, 0, 255], [4, -100, 9], [2, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
      const compact = worstCase(t.ints(maxItems!, min!, max!));
      const generic = worstCase(t.list(t.int(min!, max!), maxItems!));
      expect(compact).toEqual(generic);
      const width = Math.max(String(min).length, String(max).length);
      expect(compact.bytes).toBe(maxItems === 0 ? 2 : 2 + maxItems! * width + maxItems! - 1);
    }
    expect(worstCase(t.ints(3200, 0, 255)).bytes).toBe(12_801);
  });

  it('bounds JSON escaping and Unicode strings without materializing maximum-size data', () => {
    const bound = worstCase(t.str(8));
    expect(bound.bytes).toBe(50);
    for (const value of [String.fromCharCode(0).repeat(8), String.fromCharCode(0xd800).repeat(8), '😀'.repeat(8), String.fromCharCode(92, 34, 10, 13, 9)]) {
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(bound.bytes);
      expect(nonConformance(toJsonSchema(t.str(8)), value)).toBeUndefined();
    }
    expect(worstCase(t.str(0)).bytes).toBe(2);
    const fields = { text: t.str(10), values: t.ints(3, 0, 9) };
    expect(worstCase(t.obj(fields, undefined, { merge: 'replace' }))).toEqual(worstCase(t.obj(fields)));
  });

  it('generates valid boundary values and genuine invalid mutations for safe string patterns and ints', () => {
    for (const pattern of [undefined, '^$', '^map_[A-Z0-9_]{1,8}$', '^a{2}[0-9]+$', '^[\\\\s\\\\S]*$', '^[^a-z]+$', '^a?$', '^a{0}$', '^a{0,}$']) {
      const schema = t.obj({ label: t.str(16, pattern), cells: t.ints(4, -2, 12), kind: t.enum(['C2', 'Array<Int>']) });
      const exported = toJsonSchema(schema);
      for (const mode of ['min', 'max', 'random'] as const) {
        const value = validValue(exported, mode, rng(42)) as Record<string, unknown>;
        expect(validate(schema, value).ok, pattern).toBe(true);
        expect(nonConformance(exported, value), pattern).toBeUndefined();
        for (const mutation of objectMutations(exported, value, 64)) {
          expect(validate(schema, mutation.value).ok, mutation.label).toBe(false);
          expect(nonConformance(exported, mutation.value), mutation.label).toBeDefined();
        }
      }
    }
  });

  it('keeps remote validation aligned on bounds, patterns, fractional items and Unicode units', () => {
    const schema = t.obj({ label: t.str(2, '^..$'), cells: t.ints(2, -1, 2) });
    const exported = toJsonSchema(schema);
    for (const value of [
      { label: '😀a', cells: [-1, 2] }, { label: 'abc', cells: [] }, { label: 'a\\n', cells: [] },
      { label: 'aa', cells: [0.5] }, { label: 'aa', cells: [3] }, { label: 'aa', cells: [0, 0, 0] },
      { label: 1, cells: [] }, { label: 'aa', cells: {} },
    ]) expect(nonConformance(exported, value) === undefined).toBe(validate(schema, value).ok);
  });

  it('permits bounded text only at its declared schema positions, never as a global regex whitelist', async () => {
    const observation = t.obj({ label: t.str(4, '^[A-Z]+$'), nested: t.list(t.obj({ text: t.str(8) }), 2) });
    const manifest = { ...definition.manifest, observation };
    const surface = await readSurface(buildBriefing(manifest, { team: 'blue', role: 'runner' }), async (topic, page) => topicPage(manifest, topic, page));
    expect(surface.observationSchema).toEqual(toJsonSchema(observation));
    const vocab = vocabularyOf(surface);
    const schema = toJsonSchema(observation);
    expect(vocabularyViolations({ label: 'ABC', nested: [{ text: 'trusted' }] }, vocab, undefined, 20, schema)).toEqual([]);
    expect(vocabularyViolations({ label: 'ABCDE', nested: [] }, vocab, undefined, 20, schema)).toContainEqual({ path: '$.label', kind: 'string' });
    const leaked = vocabularyViolations({ label: 'ABC', nested: [], extra: 'ABC' }, vocab, undefined, 20, schema);
    expect(leaked.some((entry) => entry.kind === 'key')).toBe(true);
    expect(leaked.some((entry) => entry.kind === 'string')).toBe(true);
    expect(vocabularyViolations({ code: 'ABC' }, vocab)).toContainEqual({ path: '$.code', kind: 'string' });
  });

  it("accepts an invalid ack's expected only when it is built from declared vocabulary", async () => {
    const m = definition.manifest;
    const manifest = { ...m, intents: { ...m.intents, mark: { roles: ['runner'], doc: 'Mark a spot.', params: { label: t.str(4, '^[A-Z]+$'), on: t.list(t.id('u'), 2) } } } };
    const surface = await readSurface(buildBriefing(manifest, { team: 'blue', role: 'runner' }), async (topic, page) => topicPage(manifest, topic, page));
    const vocab = vocabularyOf(surface);
    const ack = (expected: string) => ({ ok: false, code: 'invalid', schemaCode: 'type', path: ['label'], expected });
    for (const [path, kind] of [[['label'], 'mark'], [['on', 0], 'mark'], [['on'], 'mark'], [['?'], 'mark'], [['x'], 'move'], [['kind']], [[]]] as const) {
      expect(vocabularyViolations(ack(expectedAt(manifest, [...path], kind)), vocab)).toEqual([]);
    }
    expect(vocabularyViolations({ lastInvalid: { schemaCode: 'range', path: ['x'], expected: expectedAt(manifest, ['x'], 'move') } }, vocab, policyOwnText)).toEqual([]);
    for (const leaked of ['MarkIntent["label"]: AUDITcanary', 'MarkIntent["label"]: "secret"', 'MarkIntent["on"]: `zz_${number}`[]', 'MarkIntent: { kind; label } %']) {
      expect(vocabularyViolations(ack(leaked), vocab)).toEqual([{ path: '$.expected', kind: 'string' }]);
    }
  });

  it('lints flat-array limits and flags bounded-text provenance at every declared root', () => {
    const m = definition.manifest;
    const game = { ...definition, manifest: { ...m, report: t.obj({ text: t.str(8), values: t.ints(4097, 0, 9) }), matchOptions: t.obj({ label: t.opt(t.str(4)) }), limits: t.obj({ label: t.opt(t.str(4)) }) } } as GameDefinition;
    const result = lintDefinition(game, { sampleTicks: 0 });
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'list.unbounded', path: 'report.values' }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'str.provenance', path: 'report.text' }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'str.provenance', path: 'matchOptions.label' }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'str.provenance', path: 'limits.label' }));
  });
});

describe('remote conformance check agrees with the validator', () => {
  it('accepts exactly what validate() accepts for the tag observation', () => {
    const s = definition.manifest.observation as Schema;
    const js = toJsonSchema(s);
    const rand = rng(7);
    for (let i = 0; i < 200; i++) {
      const v = validValue(js, 'random', rand) as Record<string, unknown>;
      expect(nonConformance(js, v)).toBeUndefined();
      for (const m of objectMutations(js as JsonSchema, v, 64).slice(0, 40)) {
        const wire = JSON.parse(JSON.stringify(m.value) ?? 'null') as unknown;
        expect(nonConformance(js, wire) === undefined).toBe(validate(s, wire).ok);
      }
    }
  });
});

describe('lintDefinition', () => {
  it('passes the tag example and samples real observations below the worst case', () => {
    const r = lintDefinition(definition, { sampleTicks: 300 });
    expect(r.findings.filter((f) => f.level === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.observation.samples).toBeGreaterThan(0);
    expect(r.observation.typical!.bytes).toBeGreaterThan(50);
    expect(r.observation.sampledMax!.bytes).toBeLessThanOrEqual(r.observation.worst.bytes);
  });

  it('lints optional observer projections independently of agent observations', () => {
    const observerDefinition = {
      ...definition,
      manifest: {
        ...definition.manifest,
        observer: t.obj({ units: t.list(t.int(0, 1), 100_000) }),
      },
    };
    const report = lintDefinition(observerDefinition, { sampleTicks: 0 });
    expect(report.findings.some((finding) => finding.level === 'error' && finding.path.startsWith('observer'))).toBe(true);
  });

  it('computes $/hour from cadence, tokens and the price table', () => {
    const r = lintDefinition(definition, { everySeconds: 5, prices: { mine: 3 }, sampleTicks: 50 });
    const row = r.cost.rows.find((x) => x.model === 'mine')!;
    expect(r.cost.observationsPerHour).toBe(720);
    expect(row.worstPerHour).toBeCloseTo((720 * r.observation.worst.tokens * 3) / 1e6, 10);
    expect(row.typicalPerHour).toBeCloseTo((720 * r.observation.typical!.tokens * 3) / 1e6, 10);
  });

  it('flags prose literals, unbounded lists, undocumented params, missing skills and oversized observations', () => {
    const m = definition.manifest;
    const sloppy: GameDefinition = {
      ...definition,
      manifest: {
        ...m,
        skills: [],
        errors: t.enum(['cooldown', 'respawning', 'ignore_all_previous_instructions']),
        report: t.obj({ history: t.list(t.int(0, 1), 100_000) }),
        intents: { ...m.intents, move: { ...m.intents.move, params: { x: t.int(0, 15), y: t.int(0, 15) } } },
      },
    } as GameDefinition;
    const r = lintDefinition(sloppy, { sampleTicks: 20, maxTokens: 500 });
    const codes = r.findings.map((f) => `${f.level}:${f.code}:${f.path}`);
    expect(codes).toContain('warn:enum.prose:errors');
    expect(codes).toContain('error:list.unbounded:report.history');
    expect(codes).toContain('warn:doc.param:intents.move.params.x');
    expect(codes).toContain('warn:skills.none:skills');
    expect(codes).toContain('error:obs.too_large:observation');
    expect(r.ok).toBe(false);
  });

  it('reports a game whose observe() breaks its own schema', () => {
    const broken: GameDefinition = {
      ...definition,
      create(opts) {
        const g = definition.create(opts);
        const observe = g.observe.bind(g);
        g.observe = (seat, since, detail) => ({ ...observe(seat, since, detail), note: 'free text' }) as never;
        return g;
      },
    };
    const r = lintDefinition(broken, { sampleTicks: 20 });
    expect(r.findings.some((f) => f.code === 'obs.nonconforming' && f.level === 'error')).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe('playerthree lint (CLI)', () => {
  it('exits 0 with parseable --json for the tag example', async () => {
    const c = capture();
    const code = await main(['lint', TAG, '--json', '--ticks', '100'], c.io);
    expect(code).toBe(0);
    const report = JSON.parse(c.out.join('\n')) as { ok: boolean; game: { id: string } };
    expect(report).toMatchObject({ ok: true, game: { id: 'tag' } });
  });

  it('exits 1 and names the problem for a sloppy game', async () => {
    const c = capture();
    const code = await main(['lint', BAD, '--ticks', '20'], c.io);
    expect(code).toBe(1);
    expect(c.out.join('\n')).toMatch(/error\s+report\.history\s+list max 50000 is effectively unbounded/);
  });

  it('rejects bad flags and missing exports with a usage error', async () => {
    const c = capture();
    expect(await main(['lint', TAG, '--price', 'oops'], c.io)).toBe(2);
    expect(await main(['lint', TAG, '--export', 'nope'], c.io)).toBe(1);
    expect(c.err.join('\n')).toMatch(/does not export a GameDefinition named `nope`/);
  });
});

describe('playerthree types (CLI)', () => {
  it('prints manifestDts, narrowed by --role, and writes --out', async () => {
    const c = capture();
    expect(await main(['types', TAG, '--role', 'guard'], c.io)).toBe(0);
    expect(`${c.out.join('\n')}\n`).toBe(manifestDts(definition.manifest, { role: 'guard' }));
    const dir = mkdtempSync(join(tmpdir(), 'p3-types-'));
    try {
      const out = join(dir, 'policy.d.ts');
      expect(await main(['types', TAG, '--out', out], capture().io)).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(manifestDts(definition.manifest));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const bad = capture();
    expect(await main(['types', TAG, '--role', 'nobody'], bad.io)).toBe(2);
    expect(bad.err.join('\n')).toMatch(/--role must be one of runner, guard/);
  });
});
