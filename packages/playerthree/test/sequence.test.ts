import { afterEach, describe, expect, it, vi } from 'vitest';
import { definition, manifest, TagGame } from '../examples/tag/index.ts';
import { createPlayerThreeHost, replayMatch } from '../src/host/index.ts';
import type { PlayerThreeHost } from '../src/host/types.ts';
import type { Mandate, PolicyArtifact } from '../src/control.ts';

const sequenceManifest = { ...manifest, control: { ...manifest.control, sequence: { maxSteps: 4, maxTicksAhead: 100, minSpacingTicks: 2 } } };
let host: PlayerThreeHost<typeof manifest>;
afterEach(() => { host?.dispose(); vi.restoreAllMocks(); });

function setup() {
  host = createPlayerThreeHost({ definition: { ...definition, manifest: sequenceManifest } });
  const match = host.createMatch({ seed: 11, realtime: false, controllers: { blue: { runner: 'agent', guard: 'none' }, red: { runner: 'none', guard: 'none' } } });
  const agent = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
  return { match, agent };
}

const stop = { kind: 'stop' as const };
const move = { kind: 'move', x: 5, y: 5 };
const policy: PolicyArtifact = { runtime: 'js', code: 'function think() { return [{kind:"move",x:5,y:5}]; }' };

describe('scheduled sequences', () => {
  it('validates the whole plan before replacing it and records due intents for deterministic replay', async () => {
    const { match, agent } = setup();
    expect(await agent.sequence({ steps: [{ in: 0, intents: [move] }, { in: 3, intents: [stop] }] })).toMatchObject({ ok: true, acks: [[{ ok: true }], [{ ok: true }]] });
    expect(await agent.sequence({ steps: [{ in: 1, intents: [stop] }, { in: 4, intents: [{ kind: 'teleport' }] }] })).toMatchObject({ ok: false, code: 'invalid', acks: [[{ ok: true }], [{ ok: false, code: 'invalid' }]] });
    await match.step(5);
    const intents = match.replay().entries.filter((entry) => entry[3] === 'intent');
    expect(intents.map((entry) => [entry[0], entry[4]])).toEqual([[0, move], [3, stop]]);
    const replay = replayMatch({ ...definition, manifest: sequenceManifest }, match.replay());
    expect(replay.adapter.view('blue')).toEqual(match.view('blue'));
  });

  it('revocation cancels the old credential plan without cancelling a replacement plan', async () => {
    const { match, agent } = setup();
    expect(await agent.sequence({ steps: [{ in: 3, intents: [move] }] })).toMatchObject({ ok: true });
    const replacement = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
    await expect(agent.act([stop])).rejects.toMatchObject({ code: 'bad_token' });
    expect(await replacement.sequence({ steps: [{ in: 1, intents: [stop] }] })).toMatchObject({ ok: true });
    await match.step(4);
    expect(match.replay().entries.filter((entry) => entry[3] === 'intent').map((entry) => [entry[0], entry[4]])).toEqual([[1, stop]]);
  });

  it('enforces length, horizon, spacing, roles and event vocabulary without scheduling', async () => {
    const { match, agent } = setup();
    for (const request of [
      { steps: Array.from({ length: 5 }, (_, n) => ({ in: n * 2, intents: [stop] })) },
      { steps: [{ in: 101, intents: [stop] }] },
      { steps: [{ in: -1, intents: [stop] }] },
      { steps: [{ in: 0.5, intents: [stop] }] },
      { steps: [{ in: 3, intents: [stop] }, { in: 4, intents: [stop] }] },
      { steps: [{ in: 0, intents: [stop] }], cancelOn: ['untrusted-event'] },
    ]) expect(await agent.sequence(request)).toMatchObject({ ok: false, code: 'invalid' });
    match.setController('blue', 'guard', 'agent');
    const guard = host.seatControl(match.mintSeatToken('blue', 'guard'))!;
    expect(await guard.sequence({ steps: [{ in: 0, intents: [{ kind: 'dash' }] }] })).toMatchObject({ ok: false, acks: [[{ ok: false, code: 'forbidden_role' }]] });
    await match.step();
    expect(match.replay().entries.filter((entry) => entry[3] === 'intent')).toEqual([]);
  });

  it('replaces, explicitly cancels, drops on controller changes and counts as presence', async () => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { match, agent } = setup();
    await agent.sequence({ steps: [{ in: 2, intents: [move] }] });
    await agent.sequence({ steps: [{ in: 3, intents: [stop] }] });
    now += 31_000;
    expect(match.seats()[0]!.agentActive).toBe(true);
    await match.step(4);
    expect(match.replay().entries.filter((entry) => entry[3] === 'intent').map((entry) => entry[4])).toEqual([stop]);
    expect(match.seats()[0]!.agentActive).toBe(false);
    await agent.sequence({ steps: [{ in: 1, intents: [move] }] });
    await agent.sequence({ steps: [] });
    await match.step(2);
    await agent.sequence({ steps: [{ in: 1, intents: [move] }] });
    match.setController('blue', 'runner', 'none');
    await match.step(2);
    expect(match.replay().entries.filter((entry) => entry[3] === 'intent')).toHaveLength(1);
  });

  it('live scopes apply to per-match tokens and cancel scheduled actions immediately', async () => {
    const { match, agent } = setup();
    await agent.sequence({ steps: [{ in: 2, intents: [move] }] });
    match.setScopes('blue', 'runner', ['practice', 'say']);
    expect((await agent.briefing()).scopes).toEqual(['practice', 'say']);
    expect(await agent.act([stop])).toEqual([{ ok: false, code: 'out_of_scope' }]);
    expect(await agent.sequence({ steps: [{ in: 2, intents: [move] }] })).toMatchObject({ ok: false, code: 'out_of_scope' });
    await expect(agent.policyDeploy(policy)).rejects.toMatchObject({ code: 'out_of_scope' });
    await match.step(3);
    expect(match.replay().entries.filter((entry) => entry[3] === 'intent')).toEqual([]);
    match.setScopes('blue', 'runner', ['act']);
    expect(await agent.act([stop])).toEqual([{ ok: true }]);
  });

  it('cancels on visible guarded events before the next due step', async () => {
    host = createPlayerThreeHost({ definition: {
      ...definition, manifest: sequenceManifest,
      create: ({ seed }) => {
        const game = new TagGame(seed);
        game.events = (_seat, since) => game.tick > since ? [{ tick: game.tick, kind: 'tagged', team: 'blue', role: 'runner' }] : [];
        return game;
      },
    } });
    const match = host.createMatch({ realtime: false, controllers: { blue: { runner: 'agent', guard: 'none' }, red: { runner: 'none', guard: 'none' } } });
    const agent = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
    await agent.sequence({ steps: [{ in: 2, intents: [move] }], cancelOn: ['tagged'] });
    await match.step(4);
    expect(match.replay().entries.filter((entry) => entry[3] === 'intent')).toEqual([]);
  });
});
describe('mandate presence fallback', () => {
  it.each(['policy', 'bot', 'hold'] as const)('keeps agent ownership and switches %s deterministically on presence', async (whenAbsent) => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    host = createPlayerThreeHost({ definition: { ...definition, manifest: sequenceManifest, createBot: () => ({ think: () => [stop] }) } });
    const match = host.createMatch({ realtime: false, controllers: { blue: { runner: 'agent', guard: 'none' }, red: { runner: 'none', guard: 'none' } } });
    match.setMandate('blue', 'runner', { autonomy: 'autonomous', directive: { stance: 'balanced' }, whenAbsent });
    expect((await match.seat('blue', 'runner').policyDeploy(policy)).ok).toBe(true);
    const emitted = () => match.replay().entries.filter((entry) => entry[3] === 'intent').map((entry) => entry[4]);
    await match.step(2);
    expect(emitted()).toEqual(whenAbsent === 'hold' ? [] : [whenAbsent === 'bot' ? stop : move]);
    const agent = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
    await agent.observe();
    await match.step(2);
    expect(emitted().at(-1)).toEqual(move);
    now += 31_000;
    const before = emitted().length;
    await match.step(2);
    expect(emitted().slice(before)).toEqual(whenAbsent === 'hold' ? [] : [whenAbsent === 'bot' ? stop : move]);
    expect(match.seats()[0]!.controller).toBe('agent');
    const waiting = agent.wait({ seconds: 1 });
    now += 31_000;
    expect(match.seats()[0]!.agentActive).toBe(true);
    await match.step(10);
    await waiting;
  });

  it('uses the fallback bot in policy mode without a deployed policy', async () => {
    host = createPlayerThreeHost({ definition: { ...definition, manifest: sequenceManifest, createBot: () => ({ think: () => [stop] }) } });
    const match = host.createMatch({ realtime: false, controllers: { blue: { runner: 'agent', guard: 'none' }, red: { runner: 'none', guard: 'none' } } });
    await match.step();
    expect(match.replay().entries.filter((entry) => entry[3] === 'intent').map((entry) => entry[4])).toEqual([stop]);
  });
});

describe('live supervised approval', () => {
  it('does not mutate before approval, replaces pending requests, wakes waiters and rejects stale ids', async () => {
    const { match, agent } = setup();
    const mandate: Mandate = { autonomy: 'supervised', directive: { stance: 'balanced' }, whenAbsent: 'hold' };
    match.setMandate('blue', 'runner', mandate as never);
    const first = await agent.policyDeploy(policy);
    if (first.ok || !('approval' in first)) throw new Error('expected approval');
    expect(first.approval).toMatchObject({ kind: 'policyDeploy', version: 1 });
    expect(await agent.policyStatus()).toMatchObject({ version: null, approval: { status: 'pending' } });
    const next = await agent.policyDeploy(policy);
    if (next.ok || !('approval' in next)) throw new Error('expected approval');
    await expect(match.resolveApproval('blue', 'runner', first.approval.id, true)).rejects.toMatchObject({ code: 'approval_not_found' });
    const waiting = agent.wait({ seconds: 10 });
    expect(await match.resolveApproval('blue', 'runner', next.approval.id, true)).toMatchObject({ ok: true, version: 1 });
    expect(await waiting).toMatchObject({ wake: 'approval' });
    expect(await agent.policyStatus()).toMatchObject({ version: 1, approval: { status: 'approved' } });
    const publication = await agent.publish();
    if (!('approval' in publication)) throw new Error('expected approval');
    expect(publication.approval).toMatchObject({ kind: 'publish', version: 1 });
    expect(host.pool.list()).toHaveLength(0);
    const owner = host.authenticate(match.tokens.teams.blue!)!.principal;
    expect(await match.handleMessage(owner, { op: 'resolveApproval', seq: 1, role: 'runner', id: publication.approval.id, approve: false })).toMatchObject({ ok: true });
    expect(await agent.policyStatus()).toMatchObject({ approval: { status: 'rejected' } });
    expect(host.pool.list()).toHaveLength(0);
  });
});
