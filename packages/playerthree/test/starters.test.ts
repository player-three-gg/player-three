import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { definition, type TagManifest } from '../examples/tag/index.ts';
import { STARTER_POLICY, tagSkill } from '../examples/tag/skill.ts';
import { servedSkills, surfaceHash } from '../src/briefing.ts';
import type { PolicySource } from '../src/control.ts';
import { createPlayerThreeHost, PlayerThreeError, practiceLocal } from '../src/host/index.ts';
import { parseArtifact, type ArtifactContext } from '../src/host/pipeline.ts';
import type { AgentSession, PlayerThreeHost } from '../src/host/types.ts';
import { defineManifest, STARTER_KNOBS_MAX_BYTES, type AnyManifest, type SkillDef } from '../src/manifest.ts';
import { checkArgs } from '../src/mcp/args.ts';
import { mountMcp } from '../src/mcp/index.ts';
import { toolSurface } from '../src/mcp/surface.ts';
import { createPolicyPackage, validatePolicyPackage } from '../src/policy-package.ts';
import { starterCatalog, starterModule, STARTER_ENTRY } from '../src/policy/starters.ts';
import { loadPolicy } from '../src/policy/index.ts';
import { topicIndex, topicPage } from '../src/topics.ts';

const ALICE = 'alice_owner_0001';
const manifest = definition.manifest;
const limits = manifest.control.policy;
const STARTER = 'tag-strategy/policies/starter.js';
const ctx = (role?: string, m: AnyManifest = manifest): ArtifactContext => ({ skills: servedSkills(m), starters: starterCatalog(m), ...(role === undefined ? {} : { role }) });

let host: PlayerThreeHost<TagManifest> | undefined;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  host?.dispose();
  host = undefined;
});

/** The tag manifest with extra skill files and the given starters. */
function variant(files: Record<string, string>, starters: Record<string, { summary: string; roles?: string[] }>, extra: Partial<AnyManifest> = {}): AnyManifest {
  const skill: SkillDef = { ...tagSkill, files: { ...tagSkill.files, ...files } };
  return defineManifest({ ...manifest, skills: [skill], starters, ...extra } as AnyManifest);
}

/** A starter module exporting `createPolicy` and the given `knobs` source. */
const starterWith = (knobs: string | undefined): string =>
  `${knobs === undefined ? '' : `export const knobs = ${knobs};\n`}export function createPolicy() { return { think() { return []; } }; }\n`;

/** The closed error a rejected starter reference throws. */
async function rejected(raw: unknown, c: ArtifactContext = ctx('runner')): Promise<{ code: string; detail: unknown }> {
  try {
    await parseArtifact(raw, limits, c);
  } catch (e) {
    if (e instanceof PlayerThreeError) return { code: e.code, detail: e.detail };
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('starter declarations', () => {
  it('validates paths, summaries, roles and policy mode at defineManifest', () => {
    const summary = 'A starter.';
    expect(() => variant({}, { 'tag-strategy/policies/missing.js': { summary } })).toThrow(/\.js file of one of the manifest's skills/);
    expect(() => variant({}, { 'tag-strategy/SKILL.md': { summary } })).toThrow(/\.js file/);
    expect(() => variant({}, { 'other-skill/policies/starter.js': { summary } })).toThrow(/\.js file/);
    expect(() => variant({}, { [STARTER]: { summary: 'two\nlines' } })).toThrow(/one line/);
    expect(() => variant({}, { [STARTER]: { summary, roles: ['keeper'] } })).toThrow(/manifest roles/);
    expect(() => variant({}, { [STARTER]: { summary, roles: [] } })).toThrow(/manifest roles/);
    expect(() => variant({}, { [STARTER]: { summary, extra: 1 } as never })).toThrow(/\{summary, roles\?\}/);
    expect(() => variant({}, {})).toThrow(/1\.\.16 starters/);
    expect(() => variant({}, { [STARTER]: { summary } }, { control: { ...manifest.control, policy: { ...limits, runtimes: ['wasm'] } } })).toThrow(/js runtime/);
    expect(() => variant({}, { [STARTER]: { summary, roles: ['guard'] } })).not.toThrow();
  });

  it('reads createPolicy and the knobs schema from the module graph once per manifest', () => {
    const catalog = starterCatalog(manifest);
    expect(starterCatalog(manifest)).toBe(catalog);
    expect([...catalog.keys()]).toEqual([STARTER]);
    const starter = catalog.get(STARTER)!;
    expect(starter.roles).toEqual(['runner', 'guard']);
    expect(starter.knobs).toMatchObject({ type: 'object', additionalProperties: false, properties: { flank: { type: 'integer', minimum: 0, maximum: 7, default: 4 } } });
  });

  it('rejects starters whose module or knobs schema breaks the rules, naming the starter', () => {
    const path = 'tag-strategy/policies/bad.js';
    const bad = (source: string): (() => unknown) => () => starterCatalog(variant({ 'policies/bad.js': source }, { [path]: { summary: 'Bad.' } }));
    const knob = (property: string): string => `{ type: 'object', additionalProperties: false, properties: { a: ${property} } }`;
    expect(bad('export const knobs = {};\n')).toThrow(/bad\.js: must export createPolicy/);
    expect(bad("throw new Error('boom');\n")).toThrow(/bad\.js: evaluation failed: boom/);
    expect(bad("import '../../../escape.js';\nexport function createPolicy() {}\n")).toThrow(/escapes the skill root/);
    expect(bad("import 'fs';\nexport function createPolicy() {}\n")).toThrow(/not a relative import/);
    expect(bad("import './nope.js';\nexport function createPolicy() {}\n")).toThrow(/no served skill \.js file/);
    expect(bad(starterWith("{ type: 'object', properties: {} }"))).toThrow(/knobs: must be \{type:"object"/);
    expect(bad(starterWith(knob("{ type: 'integer', minimum: 0, maximum: 9 }")))).toThrow(/knobs\.a: every knob needs a non-null default/);
    expect(bad(starterWith(knob("{ type: 'integer', minimum: 0, default: 1 }")))).toThrow(/knobs\.a: needs safe integer minimum ≤ maximum/);
    expect(bad(starterWith(knob("{ type: 'integer', minimum: 0, maximum: 9, default: 10 }")))).toThrow(/knobs\.a: default must satisfy/);
    expect(bad(starterWith(knob("{ type: 'string', default: 'x' }")))).toThrow(/knobs\.a: a string needs an enum or maxLength/);
    expect(bad(starterWith(knob("{ type: 'string', enum: ['x'], default: 'x', pattern: '^x$' }")))).toThrow(/unsupported keyword "pattern"/);
    expect(bad(starterWith(knob("{ type: 'array', items: { type: 'array', items: { type: 'boolean' }, maxItems: 1 }, maxItems: 1, default: [] }")))).toThrow(/knobs\.a\[\]: items/);
    expect(bad(starterWith(knob("{ type: 'boolean', default: true, required: ['a'] }")))).toThrow(/unsupported keyword "required"/);
    expect(bad(starterWith("{ type: 'object', additionalProperties: false, properties: { constructor: { type: 'boolean', default: true } } }"))).toThrow(/not be __proto__, constructor or prototype/);
    expect(bad(starterWith("{ type: 'object', additionalProperties: false, properties: { ['__proto__']: { type: 'boolean', default: true } } }"))).toThrow(/not be __proto__/);
    expect(bad(starterWith(knob('{ type: "boolean", default: () => true }')))).toThrow(/must be plain JSON data/);
    const nested = (depth: number): string => (depth === 0 ? "{ type: 'boolean', default: true }" : `{ type: 'object', additionalProperties: false, properties: { a: ${nested(depth - 1)} }, default: {} }`);
    expect(bad(starterWith(knob(nested(4))))).toThrow(/nest at most 4 deep/);
    expect(() => starterCatalog(variant({ 'policies/ok.js': starterWith(knob(nested(3))) }, { 'tag-strategy/policies/ok.js': { summary: 'Ok.' } }))).not.toThrow();
  });
});

describe('deploy by reference (parseArtifact)', () => {
  it('builds the starter through the module path, with and without knobs, deterministically', async () => {
    const plain = await parseArtifact({ from: STARTER }, limits, ctx('runner'));
    if (!plain.ok) throw new Error(JSON.stringify(plain.error));
    expect(plain.source).toEqual({ runtime: 'js', from: STARTER });
    expect(plain.artifact.code).toContain('createPolicy(null)');

    const tuned = await parseArtifact({ from: STARTER, knobs: { flank: 2, stance: 'attack' }, runtime: 'js' }, limits, ctx('runner'));
    if (!tuned.ok) throw new Error(JSON.stringify(tuned.error));
    // Keys come back in schema order, so equal knobs build byte-identical scripts.
    expect(tuned.source).toEqual({ runtime: 'js', from: STARTER, knobs: { stance: 'attack', flank: 2 } });
    expect(Object.keys((tuned.source as { knobs: object }).knobs)).toEqual(['stance', 'flank']);
    const reordered = await parseArtifact({ from: STARTER, knobs: { stance: 'attack', flank: 2 } }, limits, ctx('runner'));
    expect(reordered.ok && reordered.artifact.code).toBe(tuned.artifact.code);
    expect(tuned.artifact.code).toContain(`// ${STARTER}`);
    expect(tuned.artifact.code).toContain(`// ${STARTER_ENTRY}`);

    // One instance per sandbox instance, made with the deploy's knobs: flank 2 approaches two rows off the flag row.
    const loaded = await loadPolicy('js', tuned.artifact.code, limits);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const obs = {
      tick: 0, team: 'blue', you: { role: 'runner', x: 1, y: 8, carrying: false, respawning: false }, dashReady: true, allies: [], enemies: [], flags: [],
      bases: [{ team: 'blue', x: 0, y: 8 }, { team: 'red', x: 15, y: 8 }], score: { mine: 0, theirs: 0 }, directive: { stance: 'defend' }, events: [],
    };
    const out = await loaded.instance.call(obs);
    loaded.instance.dispose();
    expect(out).toMatchObject({ ok: true, value: { intents: [{ kind: 'move', x: 15, y: 6 }] } });
  });

  it('rejects unknown, non-starter and traversal paths, other roles and mixtures with closed errors', async () => {
    const from = { code: 'invalid', detail: { schemaCode: 'enum', path: ['from'], expected: `Starter (role runner): "${STARTER}"` } };
    expect(await rejected({ from: 'tag-strategy/policies/unknown.js' })).toEqual(from);
    expect(await rejected({ from: 'tag-strategy/policies/simple.js' })).toEqual(from);
    expect(await rejected({ from: 'tag-strategy/policies/lib/board.js' })).toEqual(from);
    expect(await rejected({ from: `tag-strategy/policies/../policies/starter.js` })).toEqual(from);
    expect(await rejected({ from: '../../etc/passwd.js' })).toEqual(from);
    expect(await rejected({ from: '__proto__' })).toEqual(from);
    expect(await rejected({ from: 42 })).toEqual(from);
    // A mixture names the member a starter reference does not take; an unknown key is `?`, never echoed.
    const starterShape = 'Artifact: { from; knobs?; runtime?: "js" }';
    const mixtures: [unknown, unknown][] = [
      [{ from: STARTER, code: 'x' }, { schemaCode: 'unknown_field', path: ['code'], expected: starterShape }],
      [{ from: STARTER, include: ['tag-strategy/policies/simple.js'] }, { schemaCode: 'unknown_field', path: ['include'], expected: starterShape }],
      [{ from: STARTER, modules: {}, entry: 'a.js' }, { schemaCode: 'unknown_field', path: ['modules'], expected: starterShape }],
      [{ from: STARTER, runtime: 'wasm' }, { schemaCode: 'enum', path: ['runtime'], expected: 'Artifact["runtime"]: "js"' }],
      [{ from: STARTER, extra: 1 }, { schemaCode: 'unknown_field', path: ['?'], expected: 'Artifact: { from; knobs?; runtime?: "js" } | { runtime; code; include? } | { runtime: "js"; modules; entry; include? }' }],
    ];
    for (const [mixed, detail] of mixtures) expect(await rejected(mixed)).toEqual({ code: 'invalid', detail });
    // No body at all: the alternatives this game takes, `from` among them.
    expect(await rejected({ runtime: 'js' })).toEqual({ code: 'invalid', detail: { schemaCode: 'missing_field', path: ['code'], expected: 'Artifact: one of code | modules+entry | from' } });
    expect(await rejected({ knobs: { flank: 2 } })).toEqual({ code: 'invalid', detail: { schemaCode: 'missing_field', path: ['from'], expected: starterShape } });
    const guardOnly = variant({}, { [STARTER]: { summary: 'Guard only.', roles: ['guard'] } });
    expect(await rejected({ from: STARTER }, ctx('runner', guardOnly))).toEqual({ code: 'invalid', detail: { schemaCode: 'enum', path: ['from'], expected: 'Starter (role runner): never' } });
    expect((await parseArtifact({ from: STARTER }, limits, ctx('guard', guardOnly))).ok).toBe(true);
    // Without starters, `from` is never accepted.
    const none = { skills: servedSkills(manifest), starters: new Map(), role: 'runner' };
    expect(await rejected({ from: STARTER }, none)).toEqual({ code: 'invalid', detail: { schemaCode: 'enum', path: ['from'], expected: 'Starter (role runner): never' } });
  });

  it('validates knobs against the schema: closed path and expected, no echo, size bound, prototype keys', async () => {
    const knobs = async (value: unknown) => rejected({ from: STARTER, knobs: value });
    expect(await knobs({ flank: 9 })).toEqual({ code: 'invalid', detail: { schemaCode: 'range', path: ['knobs', 'flank'], expected: 'Knobs["flank"]: number (integer 0..7)' } });
    expect(await knobs({ flank: 1.5 })).toMatchObject({ detail: { schemaCode: 'not_integer', path: ['knobs', 'flank'] } });
    expect(await knobs({ flank: '2' })).toMatchObject({ detail: { schemaCode: 'type', path: ['knobs', 'flank'] } });
    expect(await knobs({ stance: 'CANARY' })).toEqual({ code: 'invalid', detail: { schemaCode: 'enum', path: ['knobs', 'stance'], expected: 'Knobs["stance"]: "owner" | "attack" | "defend" | "balanced"' } });
    const unknown = { code: 'invalid', detail: { schemaCode: 'unknown_field', path: ['knobs', '?'], expected: 'Knobs: { stance?; flank?; guardOffset?; dashHome? }' } };
    expect(await knobs({ CANARY: 1 })).toEqual(unknown);
    // An own `__proto__` key, as a JSON wire message carries it (an object literal would set the prototype instead).
    expect(await knobs(JSON.parse('{"__proto__":{"flank":1}}'))).toEqual(unknown);
    expect(await knobs(JSON.parse('{"constructor":1}'))).toEqual(unknown);
    expect(await knobs({ dashHome: 'x'.repeat(STARTER_KNOBS_MAX_BYTES) })).toMatchObject({ detail: { schemaCode: 'too_long', path: ['knobs'] } });
    let deep: unknown = 1;
    for (let i = 0; i < 2000; i++) deep = { a: deep };
    expect(await knobs(deep)).toMatchObject({ detail: { schemaCode: 'too_long', path: ['knobs'] } });
    for (const value of [null, [], 'x', 1]) expect(await knobs(value)).toMatchObject({ detail: { schemaCode: 'type', path: ['knobs'] } });
    const echo = JSON.stringify(await knobs({ stance: 'CANARY', CANARY: 1 }));
    expect(echo).not.toContain('CANARY');

    // A starter without a knobs export accepts only {}.
    const bare = variant({ 'policies/bare.js': starterWith(undefined) }, { 'tag-strategy/policies/bare.js': { summary: 'Bare.' } });
    expect((await parseArtifact({ from: 'tag-strategy/policies/bare.js', knobs: {} }, limits, ctx('runner', bare))).ok).toBe(true);
    expect(await rejected({ from: 'tag-strategy/policies/bare.js', knobs: { a: 1 } }, ctx('runner', bare))).toEqual({
      code: 'invalid', detail: { schemaCode: 'unknown_field', path: ['knobs', '?'], expected: 'Knobs: Record<string, never>' },
    });
  });

  it('keeps knob keys data inside the generated entry', () => {
    expect(starterModule({ from: STARTER, knobs: { stance: 'attack' } })).toContain('starter.createPolicy(JSON.parse("{\\"stance\\":\\"attack\\"}"))');
    expect(starterModule({ from: STARTER })).toContain('starter.createPolicy(null)');
  });
});

function commander(h: PlayerThreeHost<TagManifest>, role: 'runner' | 'guard' = 'runner') {
  const id = h.commanders.create(ALICE, { name: `Starter ${role}`, kind: 'agent', roles: [role], isolation: { independentSessions: true } }).id;
  const session = h.agentSession(h.commanders.token(ALICE, id), role) as Extract<AgentSession, { kind: 'commander' }>;
  return { id, control: session.control };
}

describe('deploy by reference on a host', () => {
  it('a match seat deploys and practices a starter; policy_status carries from and knobs', async () => {
    host = createPlayerThreeHost({ definition });
    const match = host.createMatch({ seed: 4, realtime: false, controllers: { blue: { runner: 'none', guard: 'none' }, red: { runner: 'none', guard: 'none' } } });
    const seat = match.seat('blue', 'runner');
    expect(await seat.policyDeploy({ from: STARTER })).toMatchObject({ ok: true, version: 1, probe: { calls: 1, errors: 0, intentsEmitted: 1 } });
    expect(await seat.policyStatus()).toMatchObject({ version: 1, from: STARTER });
    expect(await seat.policyStatus()).not.toHaveProperty('knobs');
    expect(await seat.policyDeploy({ from: STARTER, knobs: { flank: 1 } })).toMatchObject({ ok: true, version: 2 });
    match.setController('blue', 'runner', 'policy');
    await match.step(10);
    expect(await seat.policyStatus()).toMatchObject({ version: 2, from: STARTER, knobs: { flank: 1 }, errors: 0 });
    expect(await seat.policyRollback(1)).toMatchObject({ ok: true, version: 1 });
    const back = await seat.policyStatus();
    expect(back).toMatchObject({ version: 1, from: STARTER });
    expect(back).not.toHaveProperty('knobs');
    await expect(seat.policyDeploy({ from: STARTER, knobs: { flank: 8 } })).rejects.toMatchObject({ code: 'invalid', detail: { path: ['knobs', 'flank'] } });

    const practice = await seat.practice({ opponent: 'easy', ticks: 60, seed: 2, artifact: { from: STARTER, knobs: { stance: 'attack' } } });
    expect(practice).toMatchObject({ ok: true, ticks: 60, policy: { version: 0, errors: 0 } });
  });

  it('a commander library records from and knobs, exports them as the package source and an import rebuilds it', async () => {
    host = createPlayerThreeHost({ definition });
    host.commanders.ensure(ALICE);
    const a = commander(host);
    expect(await a.control.policyDeploy({ from: STARTER, knobs: { dashHome: false, guardOffset: 4 } })).toMatchObject({ ok: true, version: 1 });
    const version = host.commanders.roster(ALICE).find((c) => c.id === a.id)!.policy.versions[0]!;
    expect(version).toMatchObject({ version: 1, role: 'runner', from: STARTER, knobs: { guardOffset: 4, dashHome: false } });
    expect(await a.control.policyStatus()).toMatchObject({ version: 1, from: STARTER, knobs: { guardOffset: 4, dashHome: false } });

    const pkg = await host.commanders.exportPolicy(ALICE, a.id, 1);
    expect(pkg).toMatchObject({ runtime: 'js', detail: null, source: { from: STARTER, knobs: { guardOffset: 4, dashHome: false } }, surfaceHash: surfaceHash(manifest) });
    expect(validatePolicyPackage(pkg, limits, manifest)).toEqual(pkg);

    const b = commander(host);
    expect(await host.commanders.importPolicy(ALICE, b.id, pkg)).toEqual({ ok: true, version: 1, stale: false });
    expect(host.commanders.roster(ALICE).find((c) => c.id === b.id)!.policy.versions[0]).toMatchObject({ from: STARTER, knobs: { guardOffset: 4, dashHome: false } });
    expect(await host.commanders.exportPolicy(ALICE, b.id, 1)).toMatchObject({ source: pkg.source, script: pkg.script, scriptHash: pkg.scriptHash });

    // The import rebuilds for the importer's role: a starter that does not play it is invalid.
    const guardOnly = variant({}, { [STARTER]: { summary: 'Guard only.', roles: ['guard'] } });
    const strict = createPlayerThreeHost({ definition: { ...definition, manifest: guardOnly } as typeof definition });
    try {
      strict.commanders.ensure(ALICE);
      const c = commander(strict as unknown as PlayerThreeHost<TagManifest>);
      // The same package made for that host's surface, so the import rebuilds it.
      const { hash: _hash, format: _format, ...rest } = { ...pkg, surfaceHash: surfaceHash(guardOnly) };
      await expect(strict.commanders.importPolicy(ALICE, c.id, createPolicyPackage(rest))).rejects.toMatchObject({ code: 'invalid' });
    } finally {
      strict.dispose();
    }

    const practice = await a.control.practice({ opponent: 'easy', ticks: 40, seed: 1, artifact: { from: STARTER } });
    expect(practice).toMatchObject({ ok: true, ticks: 40 });
  });

  it('local practice takes a starter reference for the given seat', async () => {
    const request = { opponent: 'easy', ticks: 40, seed: 1, artifact: { from: STARTER, knobs: { stance: 'defend' } } satisfies PolicySource };
    expect(await practiceLocal(definition, request, { seat: { team: 'red', role: 'guard' } })).toMatchObject({ ok: true, ticks: 40 });
  });
});

describe('starter discovery and MCP shape', () => {
  it('indexes and serves the starters topic with each knob', () => {
    expect(topicIndex(manifest)).toContain('starters — ready baseline policies: deploy one by reference with knobs');
    const text = topicPage(manifest, 'starters').text;
    expect(text).toContain(`\`policy_deploy\` \`{"from":"${STARTER}","knobs":{"stance":"owner"}}\``);
    expect(text).toContain(`## \`${STARTER}\` (roles: runner, guard)`);
    expect(text).toContain('- `flank`: number (integer 0..7), default `4` — Rows toward the board centre');
    expect(text).toContain('- `stance`: "owner" | "attack" | "defend" | "balanced", default `"owner"`');
    expect(servedSkills(manifest).find((s) => s.name === 'playerthree-policy-author')!.files['SKILL.md']).toContain('topic `starters`');
    expect(servedSkills(manifest).find((s) => s.name === 'tag-strategy')!.files['policies/starter.js']).toBe(STARTER_POLICY);
  });

  it('advertises from as an enum of starters and knobs as a bounded map', () => {
    const schema = toolSurface(manifest, servedSkills(manifest)).find((tool) => tool.method === 'policyDeploy')!.inputSchema;
    expect((schema['properties'] as Record<string, unknown>)['from']).toMatchObject({ type: 'string', enum: [STARTER] });
    expect(checkArgs(schema, { from: STARTER, knobs: { flank: 2 } })).toEqual({ ok: true });
    expect(checkArgs(schema, { from: 'tag-strategy/policies/simple.js' })).toEqual({ ok: false, code: 'enum', path: ['from'] });
    expect(checkArgs(schema, { knobs: { flank: 2 } })).toEqual({ ok: true });
    expect(checkArgs(schema, { from: STARTER, knobs: JSON.parse('{"__proto__":1}') })).toEqual({ ok: false, code: 'pattern', path: ['knobs', '?'] });
    // Which members combine is the host's rule (it names the missing or extra one with expected), not the schema's.
    expect(checkArgs(schema, { code: 'x' })).toEqual({ ok: true });
  });

  it('deploys, reports and rejects by reference over MCP', { timeout: 30_000 }, async () => {
    host = createPlayerThreeHost({ definition });
    host.commanders.ensure(ALICE);
    const a = commander(host);
    const server: Server = createServer((_req, res) => res.writeHead(404).end());
    const mounted = mountMcp(server, host);
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    closers.push(async () => {
      await mounted.close();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    });
    const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), {
      authProvider: { token: async () => host!.commanders.token(ALICE, a.id) },
    }));
    closers.unshift(() => client.close());
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

    const deployed = await call('policy_deploy', { from: STARTER, knobs: { flank: 3 } });
    expect(deployed.structuredContent, text(deployed)).toMatchObject({ ok: true, version: 1 });
    const status = await call('policy_status', {});
    expect(status.structuredContent).toMatchObject({ policy: { version: 1, from: STARTER, knobs: { flank: 3 } } });

    const badKnob = await call('policy_deploy', { from: STARTER, knobs: { flank: 99 } });
    expect(badKnob.isError).toBe(true);
    expect(JSON.parse(text(badKnob))).toEqual({ error: 'invalid', schemaCode: 'range', path: ['knobs', 'flank'], expected: 'Knobs["flank"]: number (integer 0..7)' });
    const notStarter = await call('policy_deploy', { from: 'tag-strategy/policies/simple.js' });
    expect(JSON.parse(text(notStarter))).toEqual({ error: 'invalid', schemaCode: 'enum', path: ['from'] });
    const traversal = await call('policy_deploy', { from: `tag-strategy/policies/../../${STARTER}` });
    expect(JSON.parse(text(traversal))).toEqual({ error: 'invalid', schemaCode: 'enum', path: ['from'] });
    // No body: the MCP error carries the host's closed detail, naming the field and the alternatives.
    const bodies = 'Artifact: one of code | modules+entry | from';
    const bodiless = await call('policy_deploy', { runtime: 'js' });
    expect(JSON.parse(text(bodiless))).toEqual({ error: 'invalid', schemaCode: 'missing_field', path: ['code'], expected: bodies });
    const practiceBodiless = await call('practice_run', { opponent: 'easy', ticks: 40, artifact: { runtime: 'js' } });
    expect(JSON.parse(text(practiceBodiless))).toEqual({ error: 'invalid', schemaCode: 'missing_field', path: ['artifact', 'code'], expected: bodies });

    const practiced = await call('practice_run', { opponent: 'easy', ticks: 40, seed: 1, artifact: { from: STARTER } });
    expect(practiced.structuredContent, text(practiced)).toMatchObject({ ok: true, ticks: 40 });
    const topic = await call('game_briefing', { topic: 'starters' });
    expect(text(topic)).toContain(`## \`${STARTER}\``);
  });
});
