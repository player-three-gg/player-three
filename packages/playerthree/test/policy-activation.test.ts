import { afterEach, describe, expect, it } from 'vitest';
import { definition, type TagManifest } from '../examples/tag/index.ts';
import { surfaceHash } from '../src/briefing.ts';
import { createPlayerThreeHost, memoryCommanderStore, memoryPoolStore, policyArtifactHash } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeMatch, PlayerThreeTraceEvent, CommanderStore, StoredPolicyArtifact } from '../src/host/types.ts';

const OWNER = 'policy_owner_0001';
const idle = { blue: { runner: 'none', guard: 'none' }, red: { runner: 'none', guard: 'none' } } as const;
const js = (code: string) => ({ runtime: 'js' as const, code });
const hosts: PlayerThreeHost<TagManifest>[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); });

function makeHost(commanderStore?: CommanderStore) {
  const host = createPlayerThreeHost({ definition, commanderStore });
  hosts.push(host);
  return host;
}

const state = (match: PlayerThreeMatch<TagManifest>, team = 'blue', role = 'runner') =>
  match.readiness().seats.find((seat) => seat.team === team && seat.role === role)?.state;

// Publishing drains the commander's ordered artifact/metadata writes before seating it.
async function seedLibrary(host: PlayerThreeHost<TagManifest>, artifact = js('function think() { return []; }'), role: 'runner' | 'guard' = 'runner') {
  host.commanders.ensure(OWNER);
  const id = host.commanders.create(OWNER, { name: 'Library', kind: 'policy', roles: [role], isolation: { independentSessions: true } }).id;
  const control = host.agentSession(host.commanders.token(OWNER, id), role)!.control;
  expect(await control.policyDeploy(artifact)).toMatchObject({ ok: true, version: 1 });
  await control.publish();
  return { control, id };
}

describe('policy activation validation', () => {
  it.each([
    ['schema', 'return [{ kind: "move", x: 99, y: 0 }];'],
    ['extra schema field', 'return [{ kind: "stop", injected: true }];'],
    ['role', 'return [{ kind: "dash" }];'],
    ['runtime', 'throw new Error("probe failed");'],
    ['initialization', 'return [];'],
    ['budget', 'return [{kind:"stop"},{kind:"stop"},{kind:"stop"},{kind:"stop"},{kind:"stop"}];'],
  ])('fails a fresh %s-invalid probe without replacing a working policy', async (failure, body) => {
    const host = makeHost();
    const match = host.createMatch({ realtime: false, controllers: idle });
    const seat = match.seat('blue', 'guard');
    expect(await seat.policyDeploy(js('function think() { return []; }'))).toMatchObject({ ok: true, version: 1 });
    match.setController('blue', 'guard', 'policy');
    const artifact = js(`${failure === 'initialization' ? 'function init() { throw new Error("bad init"); }' : ''} function think() { ${body} }`);
    expect(await seat.policyDeploy(artifact)).toMatchObject({ ok: false, error: { code: failure === 'runtime' || failure === 'initialization' ? 'threw' : 'bad_output' } });
    expect((await seat.policyStatus())?.version).toBe(1);
    expect(state(match, 'blue', 'guard')).toBe('policy_failed');
    expect(await seat.policyDeploy(js('function think() { return []; }'))).toMatchObject({ ok: true, version: 2 });
    expect(state(match, 'blue', 'guard')).toBe('ready');
  });

  it.each(['stale', 'missing_hash'] as const)('rejects %s library provenance at seating and rollback, preserving it when publishing', async (failure) => {
    const store = memoryCommanderStore();
    let stale = false;
    const host = makeHost({ ...store, loadArtifact: async (owner, commanderId, version) => {
      const artifact = await store.loadArtifact(owner, commanderId, version);
      if (artifact && stale && version === 1) {
        artifact.surfaceHash = '0'.repeat(64);
        if (failure === 'missing_hash') delete (artifact as Partial<StoredPolicyArtifact>).surfaceHash;
      }
      return artifact;
    } });
    const { control: commander, id } = await seedLibrary(host);
    expect((await store.loadArtifact(OWNER, id, 1))?.surfaceHash).toBe(surfaceHash(definition.manifest));
    stale = true;
    // Republishing must preserve the saved provenance, not relabel old code as current.
    const published = await commander.publish();
    if (!('policyId' in published)) throw new Error('expected pool entry');
    expect(host.pool.list().find((entry) => entry.id === published.policyId)?.surfaceHash).toBe(failure === 'stale' ? '0'.repeat(64) : undefined);
    const match = host.createMatch({ realtime: false, controllers: idle, assignments: [{ team: 'blue', role: 'runner', owner: OWNER, kind: 'policy', commander: { id }, policy: { version: 1 } }] });
    const seat = match.seat('blue', 'runner');
    await match.step(1);
    expect(await seat.policyStatus()).toBeNull();
    expect(state(match)).toBe('stale_policy');
    expect(await seat.policyDeploy(js('function think() { return []; }'))).toMatchObject({ ok: true, version: 2 });
    expect(await seat.policyRollback(1)).toMatchObject({ ok: false, error: { code: 'bad_module' } });
    expect(state(match)).toBe('stale_policy');
    expect((await seat.policyStatus())?.version).toBe(2);
  });

  it('reports policy_failed when saved active metadata points at a missing artifact', async () => {
    const store = memoryCommanderStore();
    const host = makeHost(store);
    const { id } = await seedLibrary(host);
    await store.deleteArtifact(OWNER, id, 1);
    const match = host.createMatch({
      realtime: false,
      controllers: idle,
      assignments: [{ team: 'blue', role: 'runner', owner: OWNER, kind: 'policy', commander: { id }, policy: { version: 1 } }],
    });
    await match.step(1);
    expect(await match.seat('blue', 'runner').policyStatus()).toBeNull();
    expect(state(match)).toBe('policy_failed');
    expect(match.cards().find((card) => card.seat.team === 'blue')?.mode).not.toBe('policy');
  });

  it.each([
    ['schema', 'return [{kind:"move",x:99,y:0}];'],
    ['role', 'return [{kind:"dash"}];'],
    ['runtime', 'throw new Error("red seat rejected");'],
  ])('reprobes a saved library on its actual seat for %s-invalid output', async (failure, invalid) => {
    const host = makeHost();
    const role = failure === 'role' ? 'guard' : 'runner';
    const { id } = await seedLibrary(host, js(`function think(obs) { if (obs.team === "red") { ${invalid} } return []; }`), role);
    const match = host.createMatch({ realtime: false, controllers: idle, assignments: [{ team: 'red', role, owner: OWNER, kind: 'policy', commander: { id }, policy: { version: 1 } }] });
    await match.step(1);
    expect(await match.seat('red', role).policyStatus()).toBeNull();
    expect(state(match, 'red', role)).toBe('policy_failed');
    expect(match.cards().find((card) => card.seat.team === 'red')?.mode).not.toBe('policy');
  });

  it('reprobes rollback on the current observation instead of accepting its earlier success', async () => {
    const host = makeHost();
    const match = host.createMatch({ realtime: false, controllers: { ...idle, blue: { runner: 'agent', guard: 'none' } } });
    const seat = match.seat('blue', 'runner');
    expect(await seat.policyDeploy(js('function think(obs) { return obs.tick === 0 ? [] : [{kind:"unknown"}]; }'))).toMatchObject({ ok: true, version: 1 });
    expect(await seat.policyDeploy(js('function think() { return []; }'))).toMatchObject({ ok: true, version: 2 });
    await match.step(2);
    expect(await seat.policyRollback(1)).toMatchObject({ ok: false, error: { code: 'bad_output' } });
    expect((await seat.policyStatus())?.version).toBe(2);
  });

  it.each(['stale', 'missing_hash', 'schema', 'role', 'runtime'] as const)('never activates a %s pool artifact', async (failure) => {
    const store = memoryPoolStore();
    const hash = failure === 'stale' ? '0'.repeat(64) : surfaceHash(definition.manifest);
    const artifact: StoredPolicyArtifact = {
      runtime: 'js', surfaceHash: hash,
      code: failure === 'schema' ? 'function think() { return [{kind:"move",x:99,y:0}]; }' :
        failure === 'role' ? 'function think() { return [{kind:"dash"}]; }' :
        failure === 'runtime' ? 'function think() { throw new Error("bad pool"); }' : 'function think() { return []; }',
      artifactHash: '',
    };
    artifact.artifactHash = policyArtifactHash(artifact);
    if (failure === 'missing_hash') delete (artifact as Partial<StoredPolicyArtifact>).surfaceHash;
    store.saveEntry({ id: 'pol_1', game: definition.manifest.id, role: 'guard', runtime: 'js', surfaceHash: hash, owner: 'publisher', createdAt: 1, wins: 0, losses: 0, draws: 0, drafts: 0 });
    store.saveArtifact('pol_1', artifact);
    const host = createPlayerThreeHost({ definition, poolStore: store });
    hosts.push(host);
    const match = host.createMatch({ realtime: false, controllers: { ...idle, blue: { runner: 'none', guard: 'policy' } } });
    await match.step(2);
    expect(state(match, 'blue', 'guard')).toBe(failure === 'stale' || failure === 'missing_hash' ? 'stale_policy' : 'policy_failed');
    expect(match.cards().find((card) => card.seat.role === 'guard')?.mode).not.toBe('policy');
    if (failure === 'schema') {
      const seat = match.seat('blue', 'guard');
      expect(await seat.policyDeploy(js('function think() { return []; }'))).toMatchObject({ ok: true, version: 1 });
      expect(state(match, 'blue', 'guard')).toBe('ready');
      expect(match.seats().find((entry) => entry.team === 'blue' && entry.role === 'guard')).not.toHaveProperty('poolPolicy');
      await match.step(2);
      expect(await seat.policyStatus()).toMatchObject({ calls: 1, errors: 0 });
    }
  });

  it.each(['controller', 'dispose'] as const)('records a cancelled background pool activation after %s retirement', async (retirement) => {
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<PlayerThreeTraceEvent>();
    const store = memoryPoolStore();
    const hash = surfaceHash(definition.manifest);
    store.saveEntry({ id: 'pol_1', game: definition.manifest.id, role: 'runner', runtime: 'js', surfaceHash: hash, owner: 'publisher', createdAt: 1, wins: 0, losses: 0, draws: 0, drafts: 0 });
    store.saveArtifact('pol_1', { ...js('function think() { return []; }'), surfaceHash: hash, artifactHash: policyArtifactHash(js('function think() { return []; }')) });
    const host = createPlayerThreeHost({
      poolStore: store,
      definition: {
        ...definition,
        create: (options) => {
          const adapter = definition.create(options);
          const observe = adapter.observe.bind(adapter);
          adapter.observe = (seat, since, detail) => {
            const value = observe(seat, since, detail);
            entered.resolve();
            return value;
          };
          return adapter;
        },
      },
    });
    hosts.push(host);
    host.onTrace((event) => {
      if (event.type === 'policy_deploy' && !event.ok && event.error?.message === 'Policy activation was cancelled.') cancelled.resolve(event);
    });
    const match = host.createMatch({ realtime: false, controllers: { ...idle, blue: { runner: 'policy', guard: 'none' } } });
    await entered.promise;
    if (retirement === 'dispose') match.dispose();
    else match.setController('blue', 'runner', 'none');
    expect(await cancelled.promise).toMatchObject({ type: 'policy_deploy', ok: false, error: { code: 'bad_output' } });
    expect(match.seats().find((entry) => entry.team === 'blue' && entry.role === 'runner')).not.toHaveProperty('policyVersion');
    if (retirement === 'controller') expect(state(match)).toBe('ready'); // the retired activation cannot poison its successor
  });

  it('fences a deployment when the controller changes while validation awaits', async () => {
    const host = makeHost();
    const match = host.createMatch({ realtime: false, controllers: idle });
    const seat = match.seat('blue', 'runner');
    const pending = seat.policyDeploy(js('function think() { return []; }'));
    match.setController('blue', 'runner', 'none');
    await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
    expect(await seat.policyStatus()).toBeNull();
  });

  it('does not install the live VM when assignment generation changes during the actual probe', async () => {
    const entered = Promise.withResolvers<void>();
    const host = createPlayerThreeHost({
      definition: {
        ...definition,
        create: (options) => {
          const adapter = definition.create(options);
          const observe = adapter.observe.bind(adapter);
          adapter.observe = (seat, since, detail) => {
            const value = observe(seat, since, detail);
            entered.resolve();
            return value;
          };
          return adapter;
        },
      },
    });
    hosts.push(host);
    const match = host.createMatch({ realtime: false, controllers: idle });
    const seat = match.seat('blue', 'runner');
    const pending = seat.policyDeploy(js('function think() { return []; }'));
    await entered.promise;
    match.setController('blue', 'runner', 'none');
    await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
    expect(await seat.policyStatus()).toBeNull();
  });
});
