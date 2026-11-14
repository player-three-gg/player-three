import { describe, expect, it } from 'vitest';
import { manifest } from '../examples/tag/index.ts';
import { buildBriefing, canonicalJson, surfaceHash } from '../src/briefing.ts';
import { defaultScopes, METHOD_MODE, METHOD_SCOPE, SCOPES } from '../src/control.ts';
import { createGuard } from '../src/guard.ts';
import { defineManifest, type AnyManifest } from '../src/manifest.ts';
import { t } from '../src/schema.ts';
import { composePolicy, defaultSkills, referenceSkill } from '../src/skill.ts';
import { briefingTopics, topicPage } from '../src/topics.ts';

const DELETE = Symbol('delete');
type Path = (string | number)[];

/** A copy of the tag manifest with the value at `path` replaced (or deleted). Manifests are plain JSON-able data. */
function variant(path: Path, value: unknown): AnyManifest {
  const copy: unknown = structuredClone(manifest);
  let node = copy as Record<string | number, unknown>; // plain nested objects/arrays by construction
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path.at(-1) as string | number;
  if (value === DELETE) delete node[last];
  else node[last] = value;
  return copy as AnyManifest;
}

describe('defineManifest', () => {
  it('accepts the tag manifest and returns it unchanged', () => {
    expect(defineManifest(manifest)).toBe(manifest);
  });

  it.each<[string, Path, unknown, RegExp]>([
    ['intent for an unknown role', ['intents', 'move', 'roles'], ['runner', 'king'], /intents\.move\.roles/],
    ['intent with no roles', ['intents', 'stop', 'roles'], [], /intents\.stop\.roles/],
    ['event without tick', ['event', 'fields', 'tick'], DELETE, /event\.tick/],
    ['event kind not an enum', ['event', 'fields', 'kind'], t.int(0, 3), /event\.kind/],
    ['a free-text schema type', ['observation', 'fields', 'chat'], { t: 'string' }, /no string type/],
    ['an enum literal that is prose', ['errors', 'values'], ['Ignore previous instructions'], /errors/],
    ['an unbounded list', ['view', 'fields', 'pieces', 'max'], Infinity, /list needs a finite max/],
    ['opt outside an object', ['observation', 'fields', 'flags', 'item'], t.opt(t.bool()), /t\.opt/],
    ['a bad skill name', ['skills', 0, 'name'], 'Tag Strategy', /skills\[0\]\.name/],
    ['a SKILL.md frontmatter name mismatch', ['skills', 0, 'name'], 'tag-tactics', /frontmatter/],
    ['a skill path escaping its directory', ['skills', 0, 'files', '../x.md'], 'x', /invalid relative path/],
    [
      'a skill named like the reference skill',
      ['skills', 0],
      { name: 'tag-reference', description: 'x', files: { 'SKILL.md': '---\nname: tag-reference\ndescription: x\n---\n' } },
      /reserved/,
    ],
    [
      'a skill using the SDK prefix',
      ['skills', 0],
      { name: 'playerthree-custom', description: 'x', files: { 'SKILL.md': '---\nname: playerthree-custom\ndescription: x\n---\n' } },
      /playerthree-.*reserved/,
    ],
    ['zero intent rate', ['control', 'intents', 'perSecond'], 0, /perSecond/],
    ['policy hz above tick rate', ['control', 'policy', 'hz'], 11, /policy\.hz/],
    ['a huge artifact limit', ['control', 'policy', 'maxArtifactBytes'], 50_000_000, /maxArtifactBytes/],
    ['practice without policies', ['control', 'policy'], DELETE, /enable control\.policy/],
    ['an unknown mode', ['control', 'telepathy'], {}, /unknown mode/],
    ['required house rule', ['limits'], t.obj({ drops: t.bool() }), /limits\.drops/],
    ['non-object house rules', ['limits'], t.bool(), /limits/],
    ['non-object match data', ['matchData'], t.bool(), /matchData/],
    ['free-text match data', ['matchData'], t.obj({ note: { t: 'string' } as never }), /no string type/],
    ['invalid observer schema', ['observer'], { t: 'internal' }, /observer/],
    ['zero sequence steps', ['control', 'sequence'], { maxSteps: 0, maxTicksAhead: 20, minSpacingTicks: 1 }, /maxSteps/],
    ['fractional sequence horizon', ['control', 'sequence'], { maxSteps: 4, maxTicksAhead: 2.5, minSpacingTicks: 1 }, /maxTicksAhead/],
    ['zero sequence spacing', ['control', 'sequence'], { maxSteps: 4, maxTicksAhead: 20, minSpacingTicks: 0 }, /minSpacingTicks/],
    ['a role without docs', ['roleDocs', 'guard'], DELETE, /roleDocs\.guard/],
    ['a param named kind', ['intents', 'move', 'params', 'kind'], t.bool(), /reserved/],
    ['an id that cannot name the reference skill', ['id'], 'tag-', /id/],
    ['a doc over the core budget', ['doc'], 'x'.repeat(6_001), /doc/],
    ['a role doc over budget', ['roleDocs', 'guard'], 'x'.repeat(3_501), /roleDocs\.guard/],
    ['missing topics', ['topics'], DELETE, /topics/],
    ['a topic named like a generated one', ['topics', 'intent/move'], { summary: 'x', text: 'y' }, /reserved/],
    ['a topic name with capitals', ['topics', 'Tactics'], { summary: 'x', text: 'y' }, /topics\.Tactics/],
    ['a multi-line topic summary', ['topics', 'tactics', 'summary'], 'one\ntwo', /summary/],
    ['a long topic summary', ['topics', 'tactics', 'summary'], 'x'.repeat(161), /summary/],
    ['a topic over a page', ['topics', 'tactics', 'text'], 'x'.repeat(8_001), /tactics\.text/],
    ['an unknown topic field', ['topics', 'tactics', 'pages'], 2, /unknown field/],
    [
      'a topic index over budget',
      ['topics'],
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`topic-${i}`, { summary: 's'.repeat(150), text: 'x' }])),
      /index/,
    ],
  ])('rejects %s', (_name, path, value, message) => {
    expect(() => defineManifest(variant(path, value))).toThrow(message);
  });

  it('accepts optional house rules and bounded sequences', () => {
    const m = { ...manifest, limits: t.obj({ drops: t.opt(t.bool()) }), control: { ...manifest.control, sequence: { maxSteps: 4, maxTicksAhead: 20, minSpacingTicks: 1 } } };
    expect(defineManifest(m)).toBe(m);
    expect(defaultScopes(m)).toEqual(SCOPES);
    expect(defaultScopes({ ...manifest, control: { intents: manifest.control.intents } })).toEqual(['act']);
    expect(METHOD_SCOPE.sequence).toBe('act');
    expect(METHOD_MODE.sequence).toBe('sequence');
    for (const method of ['briefing', 'observe', 'wait', 'skill', 'policyStatus'] as const) expect(METHOD_SCOPE[method]).toBeUndefined();
  });

  it('accepts closed match data and includes its schema in the pinned surface', () => {
    const m = { ...manifest, matchData: t.obj({ seed: t.int(0, 100) }) };
    expect(defineManifest(m)).toBe(m);
    expect(surfaceHash(m)).not.toBe(surfaceHash(manifest));
  });

  it('declares and guards an independent observer projection schema', () => {
    const observer = t.obj({ tick: t.int(0, 100), units: t.list(t.int(0, 100), 100) });
    const m = { ...manifest, observer };
    expect(defineManifest(m)).toBe(m);
    expect(surfaceHash(m)).not.toBe(surfaceHash(manifest));
    const guard = createGuard();
    expect(guard.pass('observer', observer, { tick: 0, units: [1, 2] }).ok).toBe(true);
    expect(guard.pass('observer', observer, { tick: 0, units: [1, 2], privateChat: 'secret' }).ok).toBe(false);
    expect(guard.pass('observer', observer, { tick: 0, units: ['debug'] }).ok).toBe(false);
  });
});

describe('outbound guard', () => {
  it('drops non-conforming data, counts it and logs only channel/path/code', () => {
    const drops: unknown[] = [];
    const guard = createGuard({ onDrop: (d) => drops.push(d) });
    const schema = t.obj({ hp: t.int(0, 10) });
    expect(guard.pass('observation', schema, { hp: 3 })).toEqual({ ok: true, value: { hp: 3 }, json: '{"hp":3}' });
    expect(guard.pass('observation', schema, { hp: 3, note: 'SECRET' })).toEqual({ ok: false });
    expect(guard.pass('observation', schema, { hp: Number.NaN })).toEqual({ ok: false });
    const cyclic: Record<string, unknown> = { hp: 1 };
    cyclic.self = cyclic;
    expect(guard.pass('view', schema, cyclic)).toEqual({ ok: false });
    // A getter that changes after the check cannot smuggle data: the snapshot is what passes.
    let reads = 0;
    const sneaky = { get hp() { return reads++ === 0 ? 1 : 'SECRET'; } };
    const r = guard.pass('report', schema, sneaky);
    expect(r).toEqual({ ok: true, value: { hp: 1 }, json: '{"hp":1}' });
    expect(guard.stats()).toEqual({ passed: 2, dropped: 3, droppedByChannel: { observation: 2, view: 1 } });
    expect(drops).toEqual([
      { channel: 'observation', code: 'unknown_field', path: ['?'] },
      { channel: 'observation', code: 'type', path: ['hp'] },
      { channel: 'view', code: 'type', path: [] },
    ]);
    expect(JSON.stringify(drops)).not.toContain('SECRET');
  });
});

describe('briefing and surface hash', () => {
  it('briefs a seat with its core: rules, role doc, intent kinds, topic index, skills and settings', () => {
    const b = buildBriefing(manifest, { team: 'red', role: 'guard' });
    expect(b.seat).toEqual({ team: 'red', role: 'guard', roleDoc: manifest.roleDocs.guard });
    expect(b.intents).toEqual(['move', 'stop']);
    expect(buildBriefing(manifest, { role: 'runner' }).intents).toEqual(['move', 'stop', 'dash']);
    expect(b.topics[0]).toBe(`tactics — ${manifest.topics.tactics.summary}`);
    expect(b.topics).toEqual(expect.arrayContaining([expect.stringMatching(/^intent\/<kind> — /), expect.stringMatching(/^schema\/<name> — /), expect.stringMatching(/^modes — .*policy ABI/)]));
    expect(b).not.toHaveProperty('modes');
    expect(b).not.toHaveProperty('observationSchema');
    expect(b.skills.map((s) => s.name)).toEqual(['tag-strategy', 'tag-reference', 'playerthree-commander', 'playerthree-inputs', 'playerthree-owner', 'playerthree-policy-author']);
    expect(b.surfaceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.scopes).toEqual(SCOPES);
    expect(b.mandate).toMatchObject({ autonomy: 'autonomous', whenAbsent: 'policy' });
    expect(b.mandate.directive).toBeDefined();
  });

  it('serves every generated topic from the manifest, paged within the topic budget', () => {
    const names = briefingTopics(manifest).map((topic) => topic.name);
    expect(names).toEqual(expect.arrayContaining(['tactics', 'role/runner', 'role/guard', 'intents', 'intent/dash', 'observation', 'observation/you', 'match-data', 'events', 'report', 'mandate', 'modes', 'schema/observation', 'schema/intent/move', 'schema/limits']));
    expect(names).not.toContain('match-data/fields');
    const text = (topic: string): string => topicPage(manifest, topic).text;
    expect(text('tactics')).toBe(manifest.topics.tactics.text);
    expect(text('intents')).toContain('- `dash` (runner) — Runner only: move every tick for 10 ticks.');
    expect(text('intents')).toContain('`cooldown` \\| `respawning`');
    expect(text('intent/move')).toContain('`x`: integer 0..15 — column');
    expect(text('observation')).toContain('`enemies`');
    expect(text('observation/you')).toContain('`you.carrying`: boolean');
    expect(text('events')).toContain('`flag_taken`');
    expect(text('mandate')).toContain('`stance`');
    expect(text('modes')).toContain('4 intents/s per seat, burst 8');
    expect(text('modes')).toContain('include');
    expect(text('modes')).toContain('game_observe');
    expect(JSON.parse(text('schema/limits').split('\n').slice(1).join('\n'))).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
    expect(() => topicPage(manifest, 'nope')).toThrow('invalid');
    expect(() => topicPage(manifest, 'tactics', 2)).toThrow('invalid');
    expect(() => topicPage(manifest, 'tactics', 0)).toThrow('invalid');
    const m = { ...manifest, limits: t.obj({ drops: t.opt(t.bool()) }) };
    expect(topicPage(m, 'mandate').text).toContain('`drops` (optional): boolean');
  });

  it('pages live match data by top-level key and splits long lists', () => {
    const m = { ...manifest, matchData: t.obj({ seed: t.int(0, 100), cells: t.list(t.int(0, 1_000_000), 10_000) }) };
    const cells = Array.from({ length: 10_000 }, (_, i) => 100_000 + i);
    const first = topicPage(m, 'match-data', 1, { matchData: { seed: 7, cells } });
    expect(first.pages).toBeGreaterThan(5);
    expect(first.text).toContain('seed: 7');
    const all: number[] = [];
    for (let page = 1; page <= first.pages; page++) {
      const p = topicPage(m, 'match-data', page, { matchData: { seed: 7, cells } });
      expect(p.text.length).toBeLessThanOrEqual(8_000);
      for (const line of p.text.split('\n')) {
        const match = /^cells\[(\d+)\.\.(\d+)\]: (.*)$/.exec(line);
        if (match) all.push(...(JSON.parse(match[3]!) as number[]));
      }
    }
    expect(all).toEqual(cells);
    expect(topicPage(m, 'match-data').text).toContain('`cells`');
    expect(topicPage(m, 'match-data/fields').text).toContain('`seed`');
  });

  it('is stable for equal surfaces and changes with any agent-visible change', () => {
    const h = surfaceHash(manifest);
    expect(surfaceHash(structuredClone(manifest))).toBe(h);
    expect(surfaceHash(variant(['intents', 'dash', 'doc'], 'Dash and also do something else.'))).not.toBe(h);
    expect(surfaceHash(variant(['observation', 'fields', 'tick', 'max'], 7))).not.toBe(h);
    expect(surfaceHash(variant(['skills', 0, 'files', 'SKILL.md'], `${manifest.skills[0]!.files['SKILL.md']}\nmore`))).not.toBe(h);
    expect(surfaceHash(variant(['control', 'intents', 'burst'], 9))).not.toBe(h);
    expect(surfaceHash(variant(['limits'], t.obj({ drops: t.opt(t.bool()) })))).not.toBe(h);
    expect(surfaceHash(variant(['control', 'sequence'], { maxSteps: 4, maxTicksAhead: 20, minSpacingTicks: 1 }))).not.toBe(h);
  });

  it('includes seat settings without sharing mutable owner state or changing the surface hash', () => {
    const mandate = { autonomy: 'supervised' as const, directive: { stance: 'attack' }, whenAbsent: 'hold' as const, limits: { drops: false } };
    const m = { ...manifest, limits: t.obj({ drops: t.opt(t.bool()) }) };
    const b = buildBriefing(m, { role: 'runner' }, { scopes: ['policy'], mandate });
    expect(b.scopes).toEqual(['policy']);
    expect(b.mandate).toEqual(mandate);
    expect(b.mandate).not.toBe(mandate);
    expect(b.surfaceHash).toBe(buildBriefing(m, { role: 'runner' }).surfaceHash);
  });

  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: undefined }, 2] })).toBe(canonicalJson({ a: [{ d: 1 }, 2], b: 1 }));
  });
});

describe('reference skill', () => {
  const skill = referenceSkill(manifest);
  const md = skill.files['SKILL.md']!;
  const all = Object.values(skill.files).join('\n');

  it('is a valid Agent Skill accepted by defineManifest', () => {
    expect(skill.name).toBe('tag-reference');
    const fm = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(md);
    expect(fm?.[1]).toBe('tag-reference');
    expect(JSON.parse(fm![2]!)).toBe(skill.description);
    expect(() => defineManifest({ ...manifest, id: 'tag2', starters: undefined, skills: [{ ...skill, name: 'tag2-ref', files: { ...skill.files, 'SKILL.md': md.replace('name: tag-reference', 'name: tag2-ref') } }] })).not.toThrow();
  });

  it('is an index plus one file per topic page, each within the topic budget', () => {
    expect(md.length).toBeLessThanOrEqual(8_000);
    expect(md).toContain('## Reading order');
    expect(md).toContain('`tactics.md` — ');
    expect(md).toContain('`intent/<kind>.md`');
    for (const topic of briefingTopics(manifest)) {
      topic.pages.forEach((page, i) => expect(skill.files[i === 0 ? `${topic.name}.md` : `${topic.name}.${i + 1}.md`]).toContain(page));
    }
    for (const [path, text] of Object.entries(skill.files)) expect(text.length, path).toBeLessThanOrEqual(8_000);
    expect(skill.files['RULES.md']).toContain(manifest.doc);
  });

  it('documents every intent with its params, observation fields, events, modes, limits, policy ABI and the playbook', () => {
    for (const kind of ['move', 'stop', 'dash']) expect(skill.files[`intent/${kind}.md`]).toContain(`# Intent \`${kind}\``);
    expect(all).toContain('`x`: integer 0..15 — column');
    expect(all).toContain('`you.carrying`: boolean');
    expect(all).toContain('`enemies[].role`');
    expect(all).toContain('`flag_taken`');
    expect(all).toContain('`cooldown` \\| `respawning`');
    expect(all).toContain('4 intents/s per seat, burst 8');
    expect(all).toContain('5 calls per game second');
    expect(all).toContain('≤ 1200 ticks');
    expect(all).toContain('function think(obs)');
    expect(all).toContain('env.log');
    expect(md).toContain('playerthree-commander');
    expect(all).toContain('`policy_deploy`');
  });
});

describe('composePolicy', () => {
  const skills = [manifest.skills[0]!];
  const lib = manifest.skills[0]!.files['policies/simple.js']!;

  it('prepends included served .js files to the code', () => {
    expect(composePolicy(skills, 'log(1);')).toBe('log(1);');
    expect(composePolicy(skills, 'log(1);', ['tag-strategy/policies/simple.js'])).toBe(`${lib}\nlog(1);`);
  });

  it.each([
    ['an unknown skill', ['nope/policies/simple.js']],
    ['an unknown file', ['tag-strategy/policies/none.js']],
    ['a non-js file', ['tag-strategy/SKILL.md']],
    ['a duplicate', ['tag-strategy/policies/simple.js', 'tag-strategy/policies/simple.js']],
    ['too many entries', Array.from({ length: 17 }, (_, i) => `tag-strategy/p${i}.js`)],
  ])('rejects %s', (_name, include) => {
    expect(() => composePolicy(skills, 'x', include)).toThrow('invalid');
  });
});

describe('default skills', () => {
  it('serves short SDK workflows for every game and gates mode-specific guidance', () => {
    const defaults = defaultSkills(manifest);
    expect(defaults.map((s) => s.name)).toEqual(['playerthree-commander', 'playerthree-inputs', 'playerthree-owner', 'playerthree-policy-author']);
    const text = (name: string) => defaults.find((s) => s.name === name)!.files['SKILL.md']!;
    expect(text('playerthree-commander')).toContain('every role you command');
    expect(text('playerthree-commander')).toContain('return to the lobby wait loop');
    // Deploy first: no generic mandatory reading list before it.
    expect(text('playerthree-commander')).not.toContain('READ BEFORE PLAYING');
    expect(text('playerthree-commander')).toMatch(/1\. `game_briefing`[^\n]*\n2\. With policy scope, deploy a working policy for \*\*every role you command\*\* next[^\n]*`policy_deploy` `\{ from, role \}` \(topic `starters`\)/);
    expect(text('playerthree-policy-author')).toMatch(/^1\. \*\*Deploy\*\* a starter by reference, `policy_deploy` `\{ from: "<skill>\/<path>\.js" \}`/m);
    expect(text('playerthree-commander')).toContain('`tag-strategy`');
    expect(text('playerthree-owner')).toContain('game_say');
    expect(text('playerthree-policy-author')).toContain(`${manifest.control.policy.msPerCall} ms/call`);
    expect(text('playerthree-policy-author')).toContain('practice_run');
    expect(text('playerthree-policy-author')).toContain('include: ["<skill>/<path>"');
    expect(text('playerthree-inputs')).not.toContain('game_sequence');
    const minimal = defineManifest({ ...manifest, starters: undefined, control: { intents: manifest.control.intents } });
    const withoutModes = defaultSkills(minimal);
    expect(withoutModes.map((s) => s.name)).toEqual(['playerthree-commander', 'playerthree-inputs', 'playerthree-owner']);
    expect(withoutModes.map((s) => s.files['SKILL.md']).join('\n')).not.toMatch(/`(?:policy_deploy|practice_run|game_sequence|game_say)`/);
    const sequenced = defaultSkills({ ...minimal, control: { ...minimal.control, sequence: { maxSteps: 7, maxTicksAhead: 101, minSpacingTicks: 3 } } });
    expect(sequenced.find((s) => s.name === 'playerthree-inputs')!.files['SKILL.md']).toContain('7 steps, 101 ticks ahead, minimum spacing 3 ticks');
    const noPractice = defaultSkills({ ...minimal, control: { ...minimal.control, policy: manifest.control.policy } });
    expect(noPractice.find((s) => s.name === 'playerthree-policy-author')!.files['SKILL.md']).not.toContain('practice_run');
  });
});
