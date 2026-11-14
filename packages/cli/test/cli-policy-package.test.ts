import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, validatePolicyPackage, type PolicyPackage } from 'playerthree';
import { createPlayerThreeHost, jsonCommanderStore } from 'playerthree/host';
import { definition } from '../../playerthree/examples/tag/index.ts';
import { main } from '../src/index.ts';

const TAG = new URL('../../playerthree/examples/tag/index.ts', import.meta.url).pathname;
const ALICE = 'alice_owner_0001';
const dir = mkdtempSync(join(tmpdir(), 'playerthree-package-'));
const store = join(dir, 'store');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A host over the store directory, as a dev host would run it (only one process at a time). */
function storeHost() {
  return createPlayerThreeHost({ definition, commanderStore: jsonCommanderStore(store) });
}

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(['policy', ...argv], { out: (s) => out.push(s), err: (s) => err.push(s), color: false });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('playerthree policy export / import', () => {
  it('exports a version from a JSON commander store and imports it into another commander', async () => {
    const prep = storeHost();
    await prep.ready;
    prep.commanders.ensure(ALICE);
    const from = prep.commanders.create(ALICE, { name: 'From', kind: 'policy', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const to = prep.commanders.create(ALICE, { name: 'To', kind: 'policy', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const control = prep.agentSession(prep.commanders.token(ALICE, from), 'runner')!.control;
    expect(await control.policyDeploy({ runtime: 'js', code: "function think() { return [{ kind: 'stop' }]; }" })).toMatchObject({ ok: true, version: 1 });
    await prep.commanders.flush();
    prep.dispose();

    const file = join(dir, 'policy.json');
    const exported = await run('export', TAG, '--store', store, '--owner', ALICE, '--commander', from, '--license', 'MIT', '--author', 'Ada', '--out', file);
    expect(exported.err).toBe('');
    expect(exported.code).toBe(0);
    const text = readFileSync(file, 'utf8');
    const pkg = JSON.parse(text) as PolicyPackage;
    expect(canonicalJson(pkg)).toBe(text);
    expect(validatePolicyPackage(pkg, definition.manifest.control.policy!, definition.manifest)).toEqual(pkg);
    expect(pkg).toMatchObject({ roles: ['runner'], license: 'MIT', author: 'Ada', lineage: { parent: null, version: 1 }, source: { code: "function think() { return [{ kind: 'stop' }]; }" } });
    expect(exported.out).toBe(`wrote ${file}: v1 runner js, ${Buffer.byteLength(text)} bytes, hash ${pkg.hash}`);
    expect(text).not.toContain(ALICE);
    expect(text).not.toContain(from);

    // Without --out (and --version: the active one) the package goes to stdout.
    const printed = await run('export', TAG, '--store', store, '--owner', ALICE, '--commander', from);
    expect(printed.code).toBe(0);
    expect((JSON.parse(printed.out) as PolicyPackage).script).toBe(pkg.script);

    const imported = await run('import', TAG, file, '--store', store, '--owner', ALICE, '--commander', to);
    expect(imported.err).toBe('');
    expect(imported.code).toBe(0);
    expect(imported.out).toBe('imported as v1 (inactive); activate it with a rollback to v1');

    const after = storeHost();
    try {
      await after.ready;
      const status = after.commanders.roster(ALICE).find((c) => c.id === to)!;
      expect(status.policy.versions).toMatchObject([{ version: 1, role: 'runner' }]);
      expect(status.policy.activeByRole['runner'] ?? null).toBeNull();
      expect(await after.commanders.exportPolicy(ALICE, to, 1)).toMatchObject({ lineage: { parent: pkg.hash, version: 1 }, license: 'MIT', author: 'Ada', script: pkg.script });
      expect(await after.commanders.rollback(ALICE, to, 'runner', 1)).toMatchObject({ ok: true, version: 1 });
    } finally {
      await after.commanders.flush();
      after.dispose();
    }

    writeFileSync(join(dir, 'tampered.json'), JSON.stringify({ ...pkg, hash: '0'.repeat(64) }));
    const tampered = await run('import', TAG, join(dir, 'tampered.json'), '--store', store, '--owner', ALICE, '--commander', to);
    expect(tampered.code).toBe(1);
    expect(tampered.err).toMatch(/^playerthree policy: invalid: /);
    const unknown = await run('export', TAG, '--store', store, '--owner', ALICE, '--commander', from, '--version', '9');
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/^playerthree policy: invalid: /);
  });

  it('requires the store, owner and commander', async () => {
    const r = await run('export', TAG, '--store', store, '--owner', ALICE);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--commander is required');
    expect((await run('import', TAG, '--store', store, '--owner', ALICE, '--commander', 'x')).code).toBe(2);
  });
});
