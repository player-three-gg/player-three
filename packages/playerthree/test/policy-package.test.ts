import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { definition, EXAMPLE_POLICY, type TagManifest } from '../examples/tag/index.ts';
import { canonicalJson, surfaceHash } from '../src/briefing.ts';
import type { SeatControl } from '../src/control.ts';
import { createPlayerThreeHost, PlayerThreeError, policyArtifactHash } from '../src/host/index.ts';
import type { AgentSession, PlayerThreeHost } from '../src/host/types.ts';
import { POLICY_EXPORT_PAGE, POLICY_PACKAGE_MAX_BYTES } from '../src/manifest.ts';
import { mountMcp } from '../src/mcp/index.ts';
import { createPolicyPackage, policyPackageHash, validatePolicyPackage, type PolicyPackage } from '../src/policy-package.ts';

const ALICE = 'alice_owner_0001';
const limits = definition.manifest.control.policy!;
const manifest = definition.manifest;
/** Own code composed after the tag skill's example policy; declares its observation detail. */
const OWN = "var detail = 'all';";
const INCLUDE = ['tag-strategy/policies/simple.js'];

let host: PlayerThreeHost<TagManifest> | undefined;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  host?.dispose();
  host = undefined;
});

function newHost(): PlayerThreeHost<TagManifest> {
  host = createPlayerThreeHost({ definition });
  host.commanders.ensure(ALICE);
  return host;
}

function commander(h: PlayerThreeHost<TagManifest>, role: 'runner' | 'guard' = 'runner', kind: 'agent' | 'policy' = 'policy'): { id: string; control: SeatControl } {
  const id = h.commanders.create(ALICE, { name: `Lib ${role}`, kind, roles: [role], isolation: { independentSessions: true } }).id;
  const session = h.agentSession(h.commanders.token(ALICE, id), role) as Extract<AgentSession, { kind: 'commander' }>;
  return { id, control: session.control };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PlayerThreeError) {
      // Closed: a rejected package never comes back with detail.
      expect(e.detail).toBeUndefined();
      return e.code;
    }
    throw e;
  }
  return 'resolved';
}

/** The package with some members replaced, re-hashed (as anyone holding a package can). */
function rehashed(pkg: PolicyPackage, members: Partial<Omit<PolicyPackage, 'format' | 'hash'>>): PolicyPackage {
  const { format: _format, hash: _hash, ...rest } = pkg;
  return createPolicyPackage({ ...rest, ...members });
}

describe('policy packages', () => {
  it('exports a deployed version as a closed, self-verifying package without identities or logs', async () => {
    const h = newHost();
    const a = commander(h);
    expect(await a.control.policyDeploy({ runtime: 'js', code: OWN, include: INCLUDE })).toMatchObject({ ok: true, version: 1 });
    const token = h.commanders.token(ALICE, a.id);

    const pkg = await h.commanders.exportPolicy(ALICE, a.id, 1);
    expect(validatePolicyPackage(pkg, limits, manifest)).toEqual(pkg);
    expect(pkg).toMatchObject({
      format: 'playerthree.policy/1',
      game: { id: 'tag', version: manifest.version },
      surfaceHash: surfaceHash(manifest),
      roles: ['runner'],
      runtime: 'js',
      detail: 'all',
      source: { code: OWN, include: INCLUDE },
      script: `${EXAMPLE_POLICY}\n${OWN}`,
      lineage: { parent: null, version: 1 },
      license: 'NOASSERTION',
      author: null,
    });
    expect(pkg.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const { hash, ...unhashed } = pkg;
    expect(hash).toBe(policyPackageHash(unhashed));

    // The hash is a function of the content: two exports differ only in their export time.
    const again = await h.commanders.exportPolicy(ALICE, a.id, 1, { license: 'MIT', author: 'Ada' });
    expect(rehashed(again, { createdAt: pkg.createdAt, license: 'NOASSERTION', author: null }).hash).toBe(pkg.hash);
    expect(again).toMatchObject({ license: 'MIT', author: 'Ada' });

    const text = canonicalJson(pkg);
    for (const secret of [ALICE, a.id, token, h.commanders.publicId(ALICE, a.id)]) expect(text).not.toContain(secret);
    expect(Object.keys(pkg).sort()).toEqual(['author', 'createdAt', 'detail', 'format', 'game', 'hash', 'license', 'lineage', 'roles', 'runtime', 'script', 'scriptHash', 'source', 'surfaceHash']);
    expect(text).not.toMatch(/"(logs|owner|commander|token|calls|probe)"/);
    // A sample for the record (truncated).
    console.log(`sample package: ${text.slice(0, 1200)}… (${Buffer.byteLength(text)} bytes)`);

    expect(await code(h.commanders.exportPolicy(ALICE, a.id, 2))).toBe('invalid');
    expect(await code(h.commanders.exportPolicy(ALICE, a.id, 1, { role: 'guard' }))).toBe('invalid');
    expect(await code(h.commanders.exportPolicy(ALICE, a.id, 1, { license: 'MIT WITH x' }))).toBe('invalid');
    expect(await code(h.commanders.exportPolicy(ALICE, a.id, 1, { author: 'Eve\u202Etxt' }))).toBe('invalid');
  });

  it('imports into another commander as an inactive version with lineage; rollback activates and probes it', async () => {
    const h = newHost();
    const a = commander(h);
    expect(await a.control.policyDeploy({ runtime: 'js', code: OWN, include: INCLUDE })).toMatchObject({ ok: true });
    const pkg = await h.commanders.exportPolicy(ALICE, a.id, 1, { license: 'Apache-2.0', author: 'Ada' });

    const b = commander(h);
    expect(await b.control.policyDeploy({ runtime: 'js', code: 'function think() { return []; }' })).toMatchObject({ ok: true, version: 1 });
    expect(await h.commanders.importPolicy(ALICE, b.id, pkg)).toEqual({ ok: true, version: 2, stale: false });
    const status = h.commanders.roster(ALICE).find((c) => c.id === b.id)!;
    expect(status.policy.activeByRole).toEqual({ runner: 1 });
    expect(status.policy.versions.map((v) => v.version)).toEqual([1, 2]);

    const reexported = await h.commanders.exportPolicy(ALICE, b.id, 2);
    expect(reexported).toMatchObject({ lineage: { parent: pkg.hash, version: 2 }, source: pkg.source, script: pkg.script, detail: 'all', license: 'Apache-2.0', author: 'Ada' });

    const rolled = await h.commanders.rollback(ALICE, b.id, 'runner', 2);
    expect(rolled).toMatchObject({ ok: true, version: 2, probe: { version: 2, runtime: 'js' } });
    expect(h.commanders.roster(ALICE).find((c) => c.id === b.id)!.policy.activeByRole).toEqual({ runner: 2 });

    // The seat method needs no approval, even supervised (activation is a rollback, which keeps its rules).
    h.commanders.update(ALICE, b.id, { mandate: { autonomy: 'supervised' } });
    expect(await b.control.policyImport(pkg)).toEqual({ ok: true, version: 3, stale: false });
    expect(await b.control.policyRollback(3)).toMatchObject({ ok: false, approval: { kind: 'policyRollback', version: 3 } });
  });

  it('rejects tampered, foreign, mismatched, prototype-keyed, oversized and wrong-role packages as invalid', async () => {
    const h = newHost();
    const a = commander(h);
    expect(await a.control.policyDeploy({ runtime: 'js', code: OWN, include: INCLUDE })).toMatchObject({ ok: true });
    const pkg = await h.commanders.exportPolicy(ALICE, a.id, 1);
    const b = commander(h);
    const guard = commander(h, 'guard');
    const withKey = (value: object, key: string) => JSON.parse(canonicalJson(value).replace(/^\{/, `{${JSON.stringify(key)}:1,`)) as PolicyPackage;
    const modular = { modules: { 'main.js': 'export function think() { return []; }\n' }, entry: 'main.js' };
    const bad: [string, unknown][] = [
      ['tampered hash', { ...pkg, hash: '0'.repeat(64) }],
      ['tampered script', { ...pkg, script: `${pkg.script}\n` }],
      ['wrong game', rehashed(pkg, { game: { id: 'other-game', version: '1.0.0' } })],
      ['unknown member', { ...pkg, extra: true }],
      ['missing member', (({ author: _author, ...rest }) => rest)(pkg)],
      ['bad license', rehashed(pkg, { license: 'MIT WITH x' })],
      ['bad author', rehashed(pkg, { author: 'Eve\u0007' })],
      ['bad createdAt', rehashed(pkg, { createdAt: '2000-02-30T00:00:00.000Z' })],
      ['undeclared detail', rehashed(pkg, { detail: ['nope'] })],
      ['oversize', rehashed(pkg, { script: 'x'.repeat(POLICY_PACKAGE_MAX_BYTES + 1) })],
      ['not an object', 'package'],
      ['null', null],
    ];
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      bad.push([`${key} key`, withKey(pkg, key)]);
      bad.push([`${key} module key`, rehashed(pkg, { source: { ...modular, modules: withKey(modular.modules, key) as unknown as Record<string, string> } })]);
    }
    // A scriptHash that matches its script but not the rebuild of `source`.
    const script = `${pkg.script}\n`;
    bad.push(['rebuild differs', rehashed(pkg, { script, scriptHash: policyArtifactHash({ runtime: 'js', code: script }) })]);
    for (const [label, value] of bad) {
      expect(await code(h.commanders.importPolicy(ALICE, b.id, value)), label).toBe('invalid');
      expect(await code(b.control.policyImport(value as PolicyPackage)), label).toBe('invalid');
    }
    // The guard lane is not among the package's roles.
    expect(await code(h.commanders.importPolicy(ALICE, guard.id, pkg))).toBe('invalid');
    expect(await code(guard.control.policyImport(pkg))).toBe('invalid');
    expect(h.commanders.roster(ALICE).find((c) => c.id === b.id)!.policy.versions).toEqual([]);
  });

  it('stores a package made for another surface stale: rollback and seating report it until redeployed', async () => {
    const h = newHost();
    const a = commander(h);
    expect(await a.control.policyDeploy({ runtime: 'js', code: 'function think() { return []; }' })).toMatchObject({ ok: true });
    const foreign = rehashed(await h.commanders.exportPolicy(ALICE, a.id, 1), { surfaceHash: 'f'.repeat(64), script: 'not even js', scriptHash: '' });
    // Without a rebuild the script is taken as packaged, so it only has to match its own hash.
    const stale = rehashed(foreign, { scriptHash: policyArtifactHash({ runtime: 'js', code: 'not even js' }) });
    const b = commander(h);
    expect(await b.control.policyImport(stale)).toEqual({ ok: true, version: 1, stale: true });
    const version = h.commanders.roster(ALICE).find((c) => c.id === b.id)!.policy.versions[0]!;
    expect(version).toMatchObject({ version: 1, surfaceHash: 'f'.repeat(64) });
    expect(await b.control.policyRollback(1)).toMatchObject({ ok: false, error: { code: 'bad_module' } });
    expect((await h.commanders.exportPolicy(ALICE, b.id, 1)).surfaceHash).toBe('f'.repeat(64));

    const match = h.createMatch({
      realtime: false,
      controllers: { blue: { runner: 'none', guard: 'none' }, red: { runner: 'none', guard: 'none' } },
      assignments: [{ team: 'blue', role: 'runner', owner: ALICE, kind: 'policy', commander: { id: b.id }, policy: { version: 1 } }],
    });
    await match.step(1);
    expect(match.readiness().seats.find((s) => s.team === 'blue' && s.role === 'runner')?.state).toBe('stale_policy');
    // In the match the seat imports through its commander library and can roll back to the new version.
    expect(await b.control.policyImport(await h.commanders.exportPolicy(ALICE, a.id, 1))).toEqual({ ok: true, version: 2, stale: false });
    expect(await b.control.policyRollback(2)).toMatchObject({ ok: true, version: 2 });
    expect((await b.control.policyExport()).version).toBe(2);
  });

  it('round-trips a modules source: the import rebuilds it to the same script', async () => {
    const h = newHost();
    const a = commander(h);
    const modules = {
      'main.ts': "import { stop } from './lib/moves.ts';\nexport function think(obs: { tick: number }): unknown[] { return obs.tick < 0 ? [] : [stop()]; }\n",
      'lib/moves.ts': "export const stop = () => ({ kind: 'stop' as const });\n",
    };
    expect(await a.control.policyDeploy({ runtime: 'js', modules, entry: 'main.ts' })).toMatchObject({ ok: true, version: 1 });
    const pkg = await h.commanders.exportPolicy(ALICE, a.id, 1);
    expect(pkg.source).toEqual({ modules, entry: 'main.ts' });
    expect(pkg.detail).toBeNull();
    const b = commander(h);
    expect(await h.commanders.importPolicy(ALICE, b.id, pkg)).toEqual({ ok: true, version: 1, stale: false });
    expect(await h.commanders.exportPolicy(ALICE, b.id, 1)).toMatchObject({ source: pkg.source, script: pkg.script, scriptHash: pkg.scriptHash });
    expect(await h.commanders.rollback(ALICE, b.id, 'runner', 1)).toMatchObject({ ok: true });
  });
});

describe('policy packages over MCP', () => {
  async function endpoint(h: PlayerThreeHost<TagManifest>): Promise<string> {
    const server: Server = createServer((_req, res) => res.writeHead(404).end());
    const mounted = mountMcp(server, h);
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    closers.push(async () => {
      await mounted.close();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  }

  async function connect(url: string, token: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } }));
    closers.unshift(() => client.close());
    return client;
  }

  const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;

  it('pages policy_export into the canonical package and imports it with policy_import', { timeout: 30_000 }, async () => {
    const h = newHost();
    const a = commander(h, 'runner', 'agent');
    // ~40 KB of own code, twice in the package (source and script): six pages.
    const big = `function think() { return []; }\n// ${'x'.repeat(40_000)}\n`;
    expect(await a.control.policyDeploy({ runtime: 'js', code: big })).toMatchObject({ ok: true, version: 1 });
    const url = await endpoint(h);
    const exporter = await connect(url, h.commanders.token(ALICE, a.id));

    const pages: string[] = [];
    let first: Record<string, unknown> | undefined;
    for (let page = 1; ; page++) {
      const r = (await exporter.callTool({ name: 'policy_export', arguments: page === 1 ? {} : { version: 1, page } })) as CallToolResult;
      expect(r.isError, textOf(r)).toBeFalsy();
      const s = r.structuredContent as { version: number; hash: string; bytes: number; page: number; pages: number; text: string; next?: { version: number; page: number } };
      first ??= s;
      expect(s).toMatchObject({ version: 1, hash: first['hash'], page, pages: first['pages'] });
      expect(s.text.length).toBeLessThanOrEqual(POLICY_EXPORT_PAGE);
      expect(textOf(r)).toBe(`${s.text}\n[page ${page}/${s.pages}${s.next ? ` — next: policy_export {"version":1,"page":${page + 1}}` : ' — end of package'}]`);
      pages.push(s.text);
      if (!s.next) break;
      expect(s.next).toEqual({ version: 1, page: page + 1 });
    }
    const joined = pages.join('');
    expect(pages).toHaveLength(Math.ceil(joined.length / POLICY_EXPORT_PAGE));
    expect(pages.length).toBeGreaterThan(2);
    expect(Buffer.byteLength(joined)).toBe(first!['bytes']);
    const pkg = JSON.parse(joined) as PolicyPackage;
    expect(canonicalJson(pkg)).toBe(joined);
    expect(validatePolicyPackage(pkg, limits, manifest)).toEqual(pkg);
    expect(pkg.hash).toBe(first!['hash']);
    expect(pkg.script).toBe(big);

    const b = commander(h, 'runner', 'agent');
    const importer = await connect(url, h.commanders.token(ALICE, b.id));
    const imported = (await importer.callTool({ name: 'policy_import', arguments: { package: pkg } })) as CallToolResult;
    expect(imported.structuredContent).toEqual({ ok: true, version: 1, stale: false });
    const rejected = (await importer.callTool({ name: 'policy_import', arguments: { package: { ...pkg, hash: '0'.repeat(64) } } })) as CallToolResult;
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(textOf(rejected))).toEqual({ error: 'invalid' });
    const unknownVersion = (await importer.callTool({ name: 'policy_export', arguments: { version: 9 } })) as CallToolResult;
    expect(JSON.parse(textOf(unknownVersion))).toEqual({ error: 'invalid' });
  });
});
