import { describe, expect, expectTypeOf, it } from 'vitest';
import { manifest } from '../examples/tag/index.ts';
import { servedSkills, surfaceHash } from '../src/briefing.ts';
import { topicPage } from '../src/topics.ts';
import { createGuard } from '../src/guard.ts';
import { defaultOf, mergeMatchOptions, parseMatchOptions } from '../src/host/pipeline.ts';
import { parsePracticeRequest } from '../src/host/practice.ts';
import { defineManifest, type AnyManifest } from '../src/manifest.ts';
import { checkArgs } from '../src/mcp/args.ts';
import { toolSurface } from '../src/mcp/surface.ts';
import { codePointLength, t, toJsonSchema, validate, type Infer, type Schema } from '../src/schema.ts';

const text = t.str(16, '^map_[A-Za-z0-9_-]+$', 'Trusted developer map identifier.');
const cells = t.ints(4, -10, 255, 'Flat cell codes.');
const record = t.obj({ text, cells, label: t.opt(t.str(8)) });

describe('bounded schema builders', () => {
  it.each([-1, 0.5, Number.NaN, Infinity, 100_001, Number.MAX_SAFE_INTEGER])('rejects string maximum %s', (max) => {
    expect(() => t.str(max)).toThrow(/maxLength/);
  });

  it.each([-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects integer-array maximum %s', (max) => {
    expect(() => t.ints(max, 0, 1)).toThrow(/maxItems/);
  });

  it.each([[1, 0], [0.5, 1], [0, Infinity], [Number.NaN, 1], [Number.MIN_SAFE_INTEGER - 1, 0]])('rejects item bounds %s..%s', (min, max) => {
    expect(() => t.ints(4, min, max)).toThrow(/range/);
  });

  it.each(['unanchored', '^(a+)+$', '^a|b$', '^a*b$', '^a?b$', '^a{1,2}b$', '^a{2,1}$', '^a{100001}$', '^a{1,100001}$', '^\\1$', '^\\p{L}+$', '^[z-a]$', '^[$', `^${'a'.repeat(255)}$`])('rejects unsafe or oversized pattern %s', (pattern) => {
    expect(() => t.str(100, pattern)).toThrow(/pattern/);
  });

  it('bounds docs independently of data and supports zero maxima', () => {
    expect(() => t.str(0, undefined, 'x'.repeat(4001))).toThrow(/doc/);
    expect(() => t.ints(0, 0, 0, 'x'.repeat(4001))).toThrow(/doc/);
    expect(validate(t.str(0), '').ok).toBe(true);
    expect(validate(t.ints(0, 0, 0), []).ok).toBe(true);
    expect(() => t.str(100_000, '^[\\s\\S]*$', 'x'.repeat(4000))).not.toThrow();
    expect(() => t.str(10, '^a{2}[0-9]+$')).not.toThrow();
  });
});

describe('bounded runtime validation', () => {
  it('counts Unicode code points, including lone surrogates, rather than bytes or UTF-16 units', () => {
    expect(codePointLength('a😀\ud800')).toBe(3);
    expect(validate(t.str(1), '😀')).toEqual({ ok: true, value: '😀' });
    expect(validate(t.str(1), '\ud800')).toEqual({ ok: true, value: '\ud800' });
    expect(validate(t.str(1), '😀a')).toEqual({ ok: false, code: 'too_long', path: [] });
    expect(validate(t.str(1), 1)).toEqual({ ok: false, code: 'type', path: [] });
  });

  it('requires complete pattern matches, checks bounds first, and never echoes rejected text', () => {
    expect(validate(text, 'map_A-0').ok).toBe(true);
    expect(validate(text, 'map_a\n')).toEqual({ ok: false, code: 'pattern', path: [] });
    expect(validate(text, 'map_a '.repeat(4))).toEqual({ ok: false, code: 'too_long', path: [] });
    expect(validate(text, 'SECRET')).toEqual({ ok: false, code: 'pattern', path: [] });
    expect(validate(t.str(2, '^..$'), '😀a').ok).toBe(true);
  });

  it.each([
    [null, 'type', []], [{ 0: 1 }, 'type', []], ['1', 'type', []],
    [[1, 2, 3, 4, 5], 'too_long', []], [[-11], 'range', [0]], [[256], 'range', [0]],
    [[1, 1.5], 'not_integer', [1]], [[Infinity], 'type', [0]], [[Number.NaN], 'type', [0]], [[false], 'type', [0]],
  ])('rejects invalid integer arrays with closed index paths', (value, code, path) => {
    expect(validate(cells, value)).toEqual({ ok: false, code, path });
  });

  it('accepts boundaries and rejects sparse and unsafe values', () => {
    expect(validate(cells, [-10, 0, 255]).ok).toBe(true);
    expect(validate(cells, []).ok).toBe(true);
    expect(validate(cells, Array(1))).toEqual({ ok: false, code: 'type', path: [0] });
    expect(validate(t.ints(1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), [Number.MAX_SAFE_INTEGER + 1])).toEqual({ ok: false, code: 'range', path: [0] });
  });

  it('preserves string and number-array inference through nested optional and union fields', () => {
    expectTypeOf<Infer<typeof text>>().toEqualTypeOf<string>();
    expectTypeOf<Infer<typeof cells>>().toEqualTypeOf<number[]>();
    expectTypeOf<Infer<typeof record>>().toEqualTypeOf<{ text: string; cells: number[]; label?: string }>();
    const union = t.union('__type', { Int: { __value: t.int(0, 2) }, 'Array<Int>': { __value: cells } });
    expectTypeOf<Infer<typeof union>>().toEqualTypeOf<{ __type: 'Int'; __value: number } | { __type: 'Array<Int>'; __value: number[] }>();
  });
});

describe('bounded schema surfaces', () => {
  it('round-trips plain schema JSON with bounds, patterns and static docs intact', () => {
    // A serialized developer schema is the same runtime shape as the DSL output.
    const copy = JSON.parse(JSON.stringify(record)) as Schema;
    expect(toJsonSchema(copy)).toEqual(toJsonSchema(record));
    expect(validate(copy, { text: 'map_A', cells: [0, 255] }).ok).toBe(true);
    expect(toJsonSchema(text)).toEqual({ type: 'string', maxLength: 16, pattern: '^map_[A-Za-z0-9_-]+$(?![\\s\\S])', description: 'Trusted developer map identifier.' });
    expect(toJsonSchema(cells)).toEqual({ type: 'array', maxItems: 4, items: { type: 'integer', minimum: -10, maximum: 255 }, description: 'Flat cell codes.' });
  });

  it('validates plain JSON manifests without trusting builder calls', () => {
    const m = { ...manifest, observation: record };
    expect(defineManifest(m)).toBe(m);
    for (const node of [
      { t: 'str' }, { t: 'str', maxLength: Infinity }, { t: 'str', maxLength: 8, pattern: '^(a+)+$' },
      { t: 'str', maxLength: 8, doc: 1 }, { t: 'str', maxLength: 8, doc: 'x'.repeat(4001) },
      { t: 'ints', maxItems: -1, min: 0, max: 1 }, { t: 'ints', maxItems: 2, min: 1.5, max: 2 },
      { t: 'ints', maxItems: 2, min: 0, max: 1, doc: 'x'.repeat(4001) }, { t: 'json' },
    ]) {
      // These are intentionally invalid developer manifest fixtures.
      expect(() => defineManifest({ ...manifest, observation: node } as AnyManifest)).toThrow(/observation/);
    }
  });

  it('validates match options on the host with closed paths; the tool schema leaves them to topic schema/match-options', async () => {
    const options = t.obj({ label: t.opt(t.str(1, '^.$')), cells: t.opt(cells) });
    const m = defineManifest({ ...manifest, matchOptions: options, observation: record, event: t.obj({ ...manifest.event.fields, label: t.opt(t.str(8)) }) });
    const tools = toolSurface(m, servedSkills(m));
    const practice = tools.find((tool) => tool.method === 'practice')!;
    const input = practice.inputSchema.properties as Record<string, Record<string, unknown>>;
    // An opaque object pointing at the topic: a large options schema never rides in every model turn.
    expect(input.options).toEqual({ type: 'object', additionalProperties: {}, description: expect.stringContaining('game_briefing {topic:"schema/match-options"}') });
    expect(practice.description).toContain('schema/match-options');
    expect(checkArgs(practice.inputSchema, { opponent: 'easy', ticks: 10, options: { cells: [256] } })).toEqual({ ok: true });
    expect(parseMatchOptions(m, { label: '😀', cells: [255] })).toEqual({ label: '😀', cells: [255] });
    const rejected = (f: () => unknown): unknown => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return undefined;
    };
    expect(rejected(() => parseMatchOptions(m, { cells: [256] }))).toMatchObject({
      code: 'invalid', detail: { schemaCode: 'range', path: ['cells', 0], expected: expect.stringMatching(/^MatchOptions\["cells"\]\[number\]: number \(.*255/) },
    });
    expect(rejected(() => parseMatchOptions(m, { label: '\n' }))).toMatchObject({ code: 'invalid', detail: { schemaCode: 'pattern', path: ['label'] } });
    expect(rejected(() => parseMatchOptions(manifest, {}))).toMatchObject({ code: 'invalid', detail: { schemaCode: 'unknown_field', path: [], expected: 'MatchOptions: never' } });
    // practice_run: under `options`, never echoing the rejected key or value.
    const practiced = async (raw: unknown, game: AnyManifest = m): Promise<unknown> => {
      try {
        await parsePracticeRequest(game, servedSkills(game), raw, 'runner');
      } catch (e) {
        return e;
      }
      return undefined;
    };
    expect(await practiced({ opponent: 'easy', ticks: 10, options: { cells: [256] } })).toMatchObject({ code: 'invalid', detail: { schemaCode: 'range', path: ['options', 'cells', 0] } });
    const unknown = await practiced({ opponent: 'easy', ticks: 10, options: { secret_key: 1 } }) as { detail: unknown };
    expect(unknown).toMatchObject({ code: 'invalid', detail: { schemaCode: 'unknown_field', path: ['options', '?'], expected: 'MatchOptions: { label?; cells? }' } });
    expect(JSON.stringify(unknown.detail)).not.toContain('secret_key');
    expect(await practiced({ opponent: 'easy', ticks: 10, options: {} }, manifest)).toMatchObject({ code: 'invalid', detail: { schemaCode: 'unknown_field', path: ['options'] } });
    expect(await practiced({ opponent: 'easy', ticks: 10, options: { label: 'a' } })).toBeUndefined();
    // The schema topics carry the exact JSON Schemas (sorted keys, one page per 8,000 chars; header line first).
    const schemaOf = (name: string): unknown => {
      const first = topicPage(m, `schema/${name}`);
      const pages = [first.text, ...Array.from({ length: first.pages - 1 }, (_, i) => topicPage(m, `schema/${name}`, i + 2).text)];
      return JSON.parse(pages.join('\n').split('\n').slice(1).join('\n'));
    };
    expect(schemaOf('match-options')).toEqual(toJsonSchema(options));
    expect(() => topicPage(manifest, 'schema/match-options')).toThrow('invalid');
    expect(schemaOf('observation')).toEqual(toJsonSchema(record));
    expect(schemaOf('event')).toEqual(toJsonSchema(m.event));
    expect(surfaceHash(m)).not.toBe(surfaceHash(manifest));
    expect(defaultOf(t.str(1))).toBe('');
    expect(defaultOf(cells)).toEqual([]);
    expect(() => defaultOf(text)).toThrow(/default/);
  });

  it('fix: enforces every keyword the advertised tool input schemas carry (uniqueItems, dependentRequired)', () => {
    const tools = new Map(toolSurface(manifest, servedSkills(manifest)).map((tool) => [tool.method, tool.inputSchema]));
    // Any keyword outside this set would be advertised to clients but silently skipped by checkArgs.
    const enforced = new Set(['type', 'properties', 'required', 'additionalProperties', 'dependentRequired', 'propertyNames', 'minProperties', 'maxProperties',
      'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'enum', 'const', 'oneOf', 'title', 'description']);
    const walk = (s: Record<string, unknown>): void => {
      for (const key of Object.keys(s)) expect(enforced, key).toContain(key);
      if (s['oneOf']) return;
      for (const child of Object.values((s['properties'] ?? {}) as Record<string, Record<string, unknown>>)) walk(child);
      if (s['items']) walk(s['items'] as Record<string, unknown>);
      // Maps (policy `modules`): key and value schemas.
      if (typeof s['additionalProperties'] === 'object') walk(s['additionalProperties'] as Record<string, unknown>);
      if (s['propertyNames']) walk(s['propertyNames'] as Record<string, unknown>);
    };
    for (const schema of tools.values()) walk(schema);
    expect(checkArgs(tools.get('briefing')!, { page: 2 })).toEqual({ ok: false, code: 'missing_field', path: ['topic'] });
    expect(checkArgs(tools.get('briefing')!, { topic: 'observation', page: 2 })).toEqual({ ok: true });
    expect(checkArgs(tools.get('observe')!, { fields: ['tick', 'tick'] })).toEqual({ ok: false, code: 'range', path: ['fields', 1] });
    expect(checkArgs(tools.get('say')!, { text: 'hi', category: 'summary' })).toEqual({ ok: false, code: 'missing_field', path: ['disclosure'] });
    expect(checkArgs(tools.get('say')!, { text: 'hi', disclosure: 'observers', category: 'summary' })).toEqual({ ok: true });
    expect(checkArgs(tools.get('policyDeploy')!, { runtime: 'js', code: 'x', include: ['a/b.js', 'a/b.js'] })).toEqual({ ok: false, code: 'range', path: ['include', 1] });
  });

  it('snapshots bounded outputs and retains closed unknown-field failures', () => {
    const drops: unknown[] = [];
    const guard = createGuard({ onDrop: (drop) => drops.push(drop) });
    const value = { text: 'map_A', cells: [255] };
    const result = guard.pass('observation', record, value);
    value.cells[0] = 999;
    expect(result).toMatchObject({ ok: true, value: { text: 'map_A', cells: [255] } });
    expect(guard.pass('view', record, value)).toEqual({ ok: false });
    expect(guard.pass('report', record, { text: 'SECRET', cells: [] })).toEqual({ ok: false });
    expect(guard.pass('observation', record, { text: 'map_A', cells: [], SECRET: 'payload' })).toEqual({ ok: false });
    expect(drops).toEqual([
      { channel: 'view', code: 'range', path: ['cells', 0] },
      { channel: 'report', code: 'pattern', path: ['text'] },
      { channel: 'observation', code: 'unknown_field', path: ['?'] },
    ]);
  });

  it('supports only declared LDtk field names and tokens, including prototype-spelled fields without pollution', () => {
    const schema = t.union('__type', {
      Int: { __identifier: t.str(8), __value: t.int(0, 9) },
      'Array<Int>': { __identifier: t.str(8), __value: t.ints(4, 0, 9) },
    });
    expect(validate(schema, { __type: 'Array<Int>', __identifier: 'C2', __value: [1] }).ok).toBe(true);
    expect(validate(schema, { __type: 'Array<Float>', __identifier: 'C2', __value: [1] })).toEqual({ ok: false, code: 'tag', path: ['__type'] });
    expect(() => t.enum(['bad token'])).toThrow();
    expect(() => t.enum(['A'.repeat(49)])).toThrow();
    expect(() => t.obj({ 'bad-key': t.bool() })).toThrow();
    const fields = Object.fromEntries([['__proto__', t.str(4)]]);
    const proto = t.obj(fields);
    const data = Object.fromEntries([['__proto__', 'safe']]);
    expect(validate(proto, data).ok).toBe(true);
    const exported = toJsonSchema(proto).properties as Record<string, unknown>;
    expect(Object.hasOwn(exported, '__proto__')).toBe(true);
    expect(JSON.stringify(defaultOf(proto))).toBe('{"__proto__":""}');
    expect(JSON.stringify(mergeMatchOptions(proto, defaultOf(proto) as Record<string, unknown>, data))).toBe('{"__proto__":"safe"}');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});
