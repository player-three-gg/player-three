import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { manifest as tag } from '../examples/tag/index.ts';
import { EXPECTED_MAX, expectedAt, intentTypeNames, manifestDts } from '../src/dts.ts';
import { TOPIC_TEXT_MAX, type AnyManifest } from '../src/manifest.ts';
import { t } from '../src/schema.ts';
import { referenceSkill } from '../src/skill.ts';
import { topicIndex, topicPage } from '../src/topics.ts';

const TSC = new URL('../../../node_modules/.bin/tsc', import.meta.url).pathname;
// Thirty literals: longer than one line, so the generator breaks the union one member per line.
const MANY = Array.from({ length: 30 }, (_, i) => `value${i}`) as [string, ...string[]];

/** Only the members `manifestDts` / `expectedAt` read; a full manifest adds nothing here. */
const probe = {
  id: 'probe',
  version: '0.1.0',
  teams: t.enum(['north', 'south']),
  roles: t.enum(['scout', 'builder']),
  observationScope: { sections: t.enum(['units', 'map']), defaults: { scout: ['units'], builder: [] } },
  observation: t.obj({
    tick: t.int(0, 1000, 'game tick'),
    units: t.list(t.obj({ id: t.id('u'), hp: t.int(0, 100), tags: t.ints(4, 0, 9), mode: t.enum(['idle', 'move']) }), 16, 'your units'),
    note: t.opt(t.str(40, '^[a-z ]+$', 'free */ text')),
    order: t.union('type', { go: { x: t.num(0, 1) }, wait: {} }),
    empty: t.obj({}),
    many: t.enum(MANY),
  }),
  matchData: t.obj({ seed: t.int(0, 99) }),
  intents: {
    queue_add: { roles: ['builder'], doc: 'Queue an item.', params: { item: t.enum(['tank', 'drone']), count: t.opt(t.int(1, 5)) } },
    queueAdd: { roles: ['scout'], doc: 'Same name.', params: {} },
    'queue.add': { roles: ['builder'], doc: 'Same name again.', params: {} },
    move: {
      roles: ['scout', 'builder'],
      doc: 'Move units.',
      params: {
        units: t.list(t.id('u'), 8),
        x: t.int(0, 63),
        plan: t.opt(t.union('type', { a: { n: t.int(0, 3) }, b: { n: t.str(3), m: t.bool() } })),
      },
    },
    pick: { roles: ['scout'], doc: 'Pick one of many.', params: { what: t.enum(Array.from({ length: 200 }, (_, i) => `choice${i}`) as [string, ...string[]]) } },
  },
  control: { intents: { perSecond: 4, burst: 8 }, policy: { runtimes: ['js'], hz: 2, msPerCall: 25, memoryBytes: 1 << 24, maxArtifactBytes: 65536, maxIntentsPerCall: 8, maxLogLines: 20, maxLogLineBytes: 200 } },
} as unknown as AnyManifest;

const dir = mkdtempSync(join(tmpdir(), 'p3-dts-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function tsc(dts: string, policy: string): { status: number | null; out: string } {
  writeFileSync(join(dir, 'game.d.ts'), dts);
  writeFileSync(join(dir, 'policy.js'), policy);
  // cwd: the temp dir, so no repository tsconfig applies (tsc refuses files plus a found config).
  const r = spawnSync(TSC, ['--noEmit', '--allowJs', '--checkJs', '--strict', '--target', 'es2022', '--lib', 'es2022', 'policy.js'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('manifestDts', () => {
  const dts = manifestDts(probe);

  it('is a global script with a header line naming game and version (and role)', () => {
    expect(dts.split('\n')[0]).toMatch(/^\/\/ probe 0\.1\.0: /);
    expect(manifestDts(probe, { role: 'scout' }).split('\n')[0]).toMatch(/^\/\/ probe 0\.1\.0 \(role scout\): /);
    expect(dts).not.toMatch(/^\s*(import|export)\b/m);
    expect(() => manifestDts(probe, { role: 'nobody' })).toThrow(/unknown role/);
  });

  it('declares Role, Team, Section, Detail and maps every schema node', () => {
    expect(dts).toContain('type Role = "scout" | "builder";');
    expect(dts).toContain('type Team = "north" | "south";');
    expect(dts).toContain('type Section = "units" | "map";');
    expect(dts).toContain('type Detail = "all" | readonly Section[];');
    expect(dts).toContain('  /** game tick — integer 0..1000 */\n  tick: number;');
    expect(dts).toContain('    id: `u_${number}`;');
    expect(dts).toContain('    /** at most 4 integers, each 0..9 */\n    tags: number[];');
    expect(dts).toContain('    mode: "idle" | "move";');
    expect(dts).toContain('  /** your units — at most 16 items */\n  units: {');
    // Docs cannot close the comment; opt fields are optional.
    expect(dts).toContain('  /** free *\\/ text — at most 40 code points, pattern ^[a-z ]+$ */\n  note?: string;');
    expect(dts).toContain('  order: {\n    type: "go";\n    /** 0..1 */\n    x: number;\n  } | {\n    type: "wait";\n  };');
    expect(dts).toContain('  empty: Record<string, never>;');
    // Wrapped: `| `-led lines packed to at most 100 code units.
    expect(dts).toMatch(/\n {2}many:\n {4}\| "value0" \| "value1" \| [^\n]*\n {4}\| "value\d+"/);
    for (const line of dts.split('\n')) if (line.trimStart().startsWith('| ')) expect(line.trimStart().length).toBeLessThanOrEqual(102);
    expect(dts).toContain('type MatchData = {\n  /** integer 0..99 */\n  seed: number;\n};');
  });

  it('names intent types by PascalCased kind, with collision suffixes in manifest order', () => {
    expect([...intentTypeNames(Object.keys(probe.intents))]).toEqual([
      ['queue_add', 'QueueAddIntent'], ['queueAdd', 'QueueAddIntent_2'], ['queue.add', 'QueueAddIntent_3'], ['move', 'MoveIntent'], ['pick', 'PickIntent'],
    ]);
    expect(dts).toContain('/** Queue an item. Roles: builder. */\ntype QueueAddIntent = {\n  kind: "queue_add";\n  item: "tank" | "drone";\n  /** integer 1..5 */\n  count?: number;\n};');
    expect(dts).toContain('type QueueAddIntent_2 = {\n  kind: "queueAdd";\n};');
    expect(dts).toContain('type QueueAddIntent_3 = {\n  kind: "queue.add";\n};');
    expect(dts).toContain('type IntentKind = "queue_add" | "queueAdd" | "queue.add" | "move" | "pick";');
    expect(dts).toContain('type Intent = QueueAddIntent | QueueAddIntent_2 | QueueAddIntent_3 | MoveIntent | PickIntent;');
    expect(dts).toContain('type RoleIntents = {\n  scout: QueueAddIntent_2 | MoveIntent | PickIntent;\n  builder: QueueAddIntent | QueueAddIntent_3 | MoveIntent;\n};');
  });

  it('narrows Intent to one role, without RoleIntents', () => {
    const scout = manifestDts(probe, { role: 'scout' });
    expect(scout).toContain('type Intent = QueueAddIntent_2 | MoveIntent | PickIntent;');
    expect(scout).not.toContain('RoleIntents');
    expect(scout).toContain('type QueueAddIntent = {');
  });

  it('declares Think, Init and log only with policy mode; MatchData null without bootstrap', () => {
    expect(dts).toContain('type Think = (obs: Observation) => Intent[];');
    expect(dts).toContain('type Init = (matchData: MatchData | null) => void;');
    expect(dts).toContain('declare function log(...args: unknown[]): void;');
    const bare = manifestDts({ ...probe, matchData: undefined, observationScope: undefined, control: { intents: probe.control.intents } } as AnyManifest);
    expect(bare).toContain('type MatchData = null;');
    expect(bare).toContain('type Section = never;');
    expect(bare).not.toMatch(/Think|Init|declare function log/);
  });

  it('type-checks a correct // @ts-check policy and pinpoints a wrong one, fully documented or bounds only', () => {
    for (const docs of ['full', 'bounds'] as const) {
      const declarations = manifestDts(probe, { docs });
      const good = tsc(declarations, `// @ts-check
/// <reference path="./game.d.ts" />
/** @type {Detail} */
var detail = ['map'];
/** @type {MatchData | null} */
var boot = null;
/** @type {Init} */
function init(matchData) { boot = matchData; }
/** @type {Think} */
function think(obs) {
  log('tick', obs.tick, boot && boot.seed);
  const ids = obs.units.filter((u) => u.mode === 'idle' && u.tags.length > 0).map((u) => u.id);
  if (obs.order.type === 'go' && obs.order.x > 0.5) return [{ kind: 'queue_add', item: 'tank', count: 2 }];
  return [{ kind: 'move', units: ids, x: 3, plan: { type: 'b', n: 'abc', m: true } }, { kind: 'queue.add' }];
}
`);
      expect(good.out, docs).toBe('');
      expect(good.status, docs).toBe(0);
      const bad = tsc(declarations, `// @ts-check
/// <reference path="./game.d.ts" />
/** @type {Think} */
function think(obs) {
  return [{ kind: 'mvoe' }, { kind: 'move', units: [], x: obs.tikc }];
}
`);
      expect(bad.status, docs).not.toBe(0);
      expect(bad.out, docs).toMatch(/error TS2322: Type '"mvoe"' is not assignable/);
      expect(bad.out, docs).toMatch(/error TS2339: Property 'tikc' does not exist on type 'Observation'/);
    }
  });

  it("docs: 'bounds' keeps bound notes as trailing comments and drops every prose doc", () => {
    const brief = manifestDts(probe, { docs: 'bounds' });
    expect(brief.split('\n')[0]).toContain('(bound notes only, no prose docs)');
    expect(brief).not.toContain('/**');
    for (const prose of ['game tick', 'your units', 'free', 'Queue an item.', 'Roles:', 'Seat roles.', "policy's own logs"]) expect(brief).not.toContain(prose);
    expect(brief).toContain('  tick: number; // integer 0..1000');
    expect(brief).toContain('    tags: number[]; // at most 4 integers, each 0..9');
    expect(brief).toContain('  note?: string; // at most 40 code points, pattern ^[a-z ]+$');
    expect(brief).toContain('  }[]; // at most 16 items');
    expect(brief).toContain('type QueueAddIntent = {\n  kind: "queue_add";\n  item: "tank" | "drone";\n  count?: number; // integer 1..5\n};');
    // Same declarations otherwise: only comments differ.
    const strip = (text: string): string => text.replace(/\s*\/\*\*.*?\*\/\n/g, '\n').replace(/ \/\/ .*$/gm, '').replace(/^\/\/.*\n/, '').replace(/\n+/g, '\n').trim();
    expect(strip(brief)).toBe(strip(dts));
  });
});

describe('expectedAt', () => {
  it('names the declared type at the path, never the value', () => {
    expect(expectedAt(probe, ['units', 0], 'move')).toBe('MoveIntent["units"][number]: `u_${number}`');
    expect(expectedAt(probe, ['units'], 'move')).toBe('MoveIntent["units"]: `u_${number}`[] (at most 8 items)');
    expect(expectedAt(probe, ['x'], 'move')).toBe('MoveIntent["x"]: number (integer 0..63)');
    expect(expectedAt(probe, ['?'], 'move')).toBe('MoveIntent: { kind; units; x; plan? }');
    expect(expectedAt(probe, ['count'], 'queue_add')).toBe('QueueAddIntent["count"]: number (integer 1..5)');
    expect(expectedAt(probe, ['plan', 'type'], 'move')).toBe('MoveIntent["plan"]["type"]: "a" | "b"');
    expect(expectedAt(probe, ['plan'], 'move')).toBe('MoveIntent["plan"]: { type: "a"; n } | { type: "b"; n; m }');
    expect(expectedAt(probe, ['plan', '?'], 'move')).toBe('MoveIntent["plan"]: { type: "a"; n } | { type: "b"; n; m }');
    // The path does not say which variant failed: both declarations of `n` are candidates.
    expect(expectedAt(probe, ['plan', 'n'], 'move')).toBe('MoveIntent["plan"]["n"]: number (integer 0..3) | string (at most 3 code points)');
    expect(expectedAt(probe, ['kind'])).toBe('IntentKind: "queue_add" | "queueAdd" | "queue.add" | "move" | "pick"');
    expect(expectedAt(probe, [])).toBe('Intent: QueueAddIntent | QueueAddIntent_2 | QueueAddIntent_3 | MoveIntent | PickIntent');
  });

  it('cuts after the last whole union member that fits', () => {
    const e = expectedAt(probe, ['what'], 'pick');
    expect(e.length).toBeLessThanOrEqual(EXPECTED_MAX);
    expect(e).toMatch(/^PickIntent\["what"\]: "choice0" \| "choice1" \| .*"choice\d+" \| …$/);
  });
});

describe('types topics', () => {
  // Long intent docs push the declarations over several pages.
  const big = {
    ...tag,
    intents: {
      ...tag.intents,
      // Many kinds, not only long docs: the topics serve bounds-only declarations, which drop the docs.
      ...Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`extra${i}`, { roles: ['runner'], doc: 'A long rule. '.repeat(250), params: { x: t.int(0, 15), y: t.int(0, 15), label: t.opt(t.str(8, '^[a-z]+$')) } }])),
    },
  } as AnyManifest;

  for (const [topic, role] of [['types', undefined], ['types/runner', 'runner']] as const) {
    it(`${topic}: pages fit and rejoin to manifestDts`, () => {
      const first = topicPage(big, topic, 1);
      expect(first.pages).toBeGreaterThan(1);
      const pages = [first.text];
      for (let p = 2; p <= first.pages; p++) pages.push(topicPage(big, topic, p).text);
      for (const text of pages) expect(text.length).toBeLessThanOrEqual(TOPIC_TEXT_MAX - 100);
      const joined = pages.join('\n');
      expect(joined.slice(joined.indexOf('\n') + 1)).toBe(manifestDts(big, { ...(role === undefined ? {} : { role }), docs: 'bounds' }));
    });
  }

  it('are indexed, served as reference files and pointed at from schema and intent topics', () => {
    expect(topicIndex(tag).some((line) => line.startsWith('types — '))).toBe(true);
    const files = referenceSkill(tag).files;
    expect(files['types.md']).toContain('type MoveIntent = {');
    expect(files['types/guard.md']).toContain('type Intent = MoveIntent | StopIntent;');
    expect(files['SKILL.md']).toContain('`types.md`');
    expect(topicPage(tag, 'intent/move').text).toContain('TypeScript: `MoveIntent` in topic `types`');
    expect(topicPage(tag, 'schema/observation').text.split('\n')[0]).toContain('topic `types`');
    expect(topicPage(tag, 'intents').text).toContain('`` MoveIntent["x"]: number (integer 0..15) ``');
  });
});
