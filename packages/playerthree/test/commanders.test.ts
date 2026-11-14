import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { definition, type TagManifest } from '../examples/tag/index.ts';
import { MAX_TICKS } from '../examples/tag/manifest.ts';
import { LOBBY_INSTRUCTIONS, type DeployResult, type SeatControl, type SeatStatus } from '../src/control.ts';
import { PlayerThreeError, createPlayerThreeHost, memoryCommanderStore } from '../src/host/index.ts';
import type { AgentSession, PlayerThreeHost, PlayerThreeTraceEvent } from '../src/host/types.ts';
import { mountMcp } from '../src/mcp/index.ts';

const ALICE = 'alice_owner_0001';
const BOB = 'bob_owner_000002';
const js = (code: string) => ({ runtime: 'js' as const, code });
/** Runner policy: walk to (x, y), log a marker. */
const goTo = (x: number, y: number, marker = 'lib') => js(`function think(obs) { log('${marker}', obs.tick); return [{ kind: 'move', x: ${x}, y: ${y} }]; }`);

let host: PlayerThreeHost<TagManifest> | undefined;
const dirs: string[] = [];
afterEach(() => {
  host?.dispose();
  host = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newHost(dataDir?: string): PlayerThreeHost<TagManifest> {
  host = createPlayerThreeHost({ definition, ...(dataDir ? { dataDir } : {}) });
  return host;
}

function commander(h: PlayerThreeHost<TagManifest>, owner: string, id: string, role: 'runner' | 'guard'): SeatControl {
  const s = h.agentSession(h.commanders.token(owner, id), role) as Extract<AgentSession, { kind: 'commander' }>;
  expect(s).toMatchObject({ kind: 'commander', owner, commanderId: id, role });
  return s.control;
}

/**
 * Deploy, retrying when the dry-run probe hits the sandbox's per-call time limit (a loaded test machine can stall
 * one call; the failed attempt leaves the version counter unchanged).
 */
async function deploy(c: SeatControl, artifact: { runtime: 'js'; code: string }): Promise<DeployResult> {
  for (let i = 0; ; i++) {
    const r = await c.policyDeploy(artifact);
    if (r.ok || 'approval' in r || r.error.code !== 'timeout' || i === 3) return r;
  }
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PlayerThreeError) return e.code;
    throw e;
  }
  return 'resolved';
}

describe('commander tokens in the lobby', () => {
  it('briefing without a team, skills, deploy/status/rollback/practice on the library, observe → lobby state, act → not_in_match', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    h.commanders.create(ALICE, { name: 'Guard', kind: 'agent', roles: ['guard'], isolation: { independentSessions: true } });
    const c = commander(h, ALICE, runnerId, 'runner');

    const b = await c.briefing();
    expect(b.phase).toBe('lobby');
    expect(b.seat).toEqual({ role: 'runner', roleDoc: expect.any(String) });
    expect((await c.skill(b.skills[0]!.name, 'SKILL.md')).text).toEqual(expect.any(String));
    expect((await c.briefing('intents')).text).toContain('`stop`');
    const unseated = { phase: 'lobby', seat: null, you: { ready: false }, startsWhen: { kind: 'seat' }, instruction: expect.stringContaining('No match seats you') };
    // Policy scope and nothing deployed yet: the next step is a deploy.
    const noPolicy = { ...unseated, instruction: LOBBY_INSTRUCTIONS.noPolicy };
    expect(await c.observe()).toEqual(noPolicy);
    expect(await c.ready()).toEqual(noPolicy);
    expect(await code(c.act([{ kind: 'stop' }]))).toBe('not_in_match');
    expect(await c.policyStatus()).toBeNull();
    expect(await code(c.practice({ opponent: 'easy', ticks: 50 }))).toBe('invalid');

    const d1 = await deploy(c, goTo(0, 0, 'v1'));
    expect(d1).toMatchObject({ ok: true, version: 1, probe: { calls: 1, errors: 0, intentsEmitted: 1, logs: ['v1 0'] } });
    expect(await deploy(c, js('function think( {'))).toMatchObject({ ok: false, error: { code: 'compile' } });
    const d2 = await deploy(c, goTo(15, 15, 'v2'));
    expect(d2).toMatchObject({ ok: true, version: 2 });
    expect(await c.policyStatus()).toMatchObject({ version: 2, logs: ['v2 0'] });

    const practice = await c.practice({ opponent: 'hard', ticks: 60, seed: 3 });
    expect(practice).toMatchObject({ ticks: 60, policy: { version: 2 } });
    if (!practice.ok) throw new Error(practice.code);
    const rb = await c.policyRollback(1);
    expect(rb).toMatchObject({ ok: true, version: 1 });
    expect(await code(c.policyRollback(7))).toBe('invalid');

    const [runner] = h.commanders.roster(ALICE);
    expect(runner).toMatchObject({
      roles: ['runner'],
      kind: 'agent',
      policy: { activeByRole: { runner: 1 }, versions: [{ version: 1, role: 'runner', runtime: 'js' }, { version: 2, role: 'runner', runtime: 'js' }] },
      lastPractice: { opponent: 'hard', allies: 'hard', ticks: 60, seed: 3, version: 2, outcome: practice.outcome },
      connected: true,
      seated: null,
    });

    const waited = await c.wait({ seconds: 0.05 });
    expect(waited).toEqual(unseated);
  });

  it('owner operations: settings are validated, practice runs the active policy', async () => {
    const h = newHost();
    expect(() => h.commanders.ensure('short')).toThrow(PlayerThreeError);
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const guardId = h.commanders.create(ALICE, { name: 'Guard', kind: 'agent', roles: ['guard'], isolation: { independentSessions: true } }).id;
    h.commanders.update(ALICE, guardId, { botLevel: 'easy' });
    const roster = h.commanders.roster(ALICE);
    expect(roster.map((r) => [r.roles, r.kind, r.botLevel])).toEqual([
      [['runner'], 'agent', 'easy'],
      [['guard'], 'agent', 'easy'],
    ]);
    expect(h.commanders.update(ALICE, runnerId, { mandate: { directive: { stance: 'attack' } }, botLevel: 'hard' })).toMatchObject({
      mandate: { directive: { stance: 'attack' }, autonomy: 'autonomous', whenAbsent: 'policy' },
      botLevel: 'hard',
    });
    for (const bad of [{ preference: 'god' }, { mandate: { directive: { stance: 'shout' } } }, { botLevel: 'impossible' }, { note: 'hi' }, { scopes: ['admin'] }, { mandate: { autonomy: 'maybe' } }, { directive: { stance: 'attack' } }]) {
      expect(() => h.commanders.update(ALICE, runnerId, bad as never)).toThrow(PlayerThreeError);
    }
    expect(() => h.commanders.update(BOB, runnerId, {})).toThrow(PlayerThreeError);
    expect(h.commanders.owners()).toEqual([ALICE]);
    expect(h.commanders.ensure(BOB)).toEqual([]);
    expect(h.commanders.owners()).toEqual([ALICE, BOB].sort());
    expect(await code(h.commanders.practice(ALICE, runnerId, { role: 'runner', opponent: 'easy', ticks: 10 }))).toBe('invalid');
    await deploy(commander(h, ALICE, runnerId, 'runner'), goTo(3, 3));
    const r = await h.commanders.practice(ALICE, runnerId, { role: 'runner', opponent: 'easy', ticks: 20 });
    expect(r).toMatchObject({ ticks: 20, policy: { version: 1 } });
    expect(h.commanders.roster(ALICE)[0]!.lastPractice).toMatchObject({ opponent: 'easy', version: 1, ticks: 20 });
  });
});

describe('seat scopes and mandates', () => {
  it('defaults to supported scopes, merges mandate patches, and rejects every forbidden write in lobby and match', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const initial = h.commanders.roster(ALICE)[0]!;
    expect(initial).toMatchObject({ scopes: ['act', 'policy', 'practice', 'publish', 'say'], mandate: { autonomy: 'autonomous', whenAbsent: 'policy' } });
    const c = commander(h, ALICE, runnerId, 'runner');
    h.commanders.update(ALICE, runnerId, { mandate: { directive: { stance: 'attack' } } });
    const updated = h.commanders.update(ALICE, runnerId, { scopes: [], mandate: { whenAbsent: 'hold' } });
    expect(updated.mandate).toEqual({ autonomy: 'autonomous', directive: { stance: 'attack' }, whenAbsent: 'hold' });
    const forbidden = [
      () => c.policyDeploy(goTo(0, 0)),
      () => c.policyRollback(1),
      () => c.policyExport(),
      () => c.policyImport({} as never),
      () => c.practice({ opponent: 'easy', ticks: 1 }),
      () => c.publish(),
      () => c.say('hello'),
    ];
    for (const call of forbidden) expect(await code(call())).toBe('out_of_scope');
    expect(await code(c.sequence({ steps: [] }))).toBe('mode_unavailable');
    expect(await c.act([{ kind: 'stop' }])).toEqual([{ ok: false, code: 'out_of_scope' }]);
    expect(await c.briefing()).toMatchObject({ scopes: [], mandate: updated.mandate });
    expect(await c.policyStatus()).toBeNull();
    expect((await c.wait({ seconds: 0 })).phase).toBe('lobby');
    const match = h.createMatch({ realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
    for (const call of forbidden) expect(await code(call())).toBe('out_of_scope');
    expect(await code(c.sequence({ steps: [] }))).toBe('mode_unavailable');
    expect(await c.act([{ kind: 'stop' }])).toEqual([{ ok: false, code: 'out_of_scope' }]);
    expect(await c.observe()).toMatchObject({ tick: 0 });
    h.commanders.update(ALICE, runnerId, { scopes: ['act'], mandate: { whenAbsent: 'bot' } });
    expect(await c.briefing()).toMatchObject({ scopes: ['act'], mandate: { whenAbsent: 'bot', directive: { stance: 'attack' } } });
    expect(await c.act([{ kind: 'stop' }])).toEqual([{ ok: true }]);
    match.dispose();
  });

  it('practice concurrency is one per-principal budget across the lobby and a live match', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    h.commanders.create(ALICE, { name: 'Guard', kind: 'agent', roles: ['guard'], isolation: { independentSessions: true } });
    const c = commander(h, ALICE, runnerId, 'runner');
    expect(await deploy(c, goTo(1, 1))).toMatchObject({ ok: true });
    const runs = [1, 2].map((seed) => c.practice({ opponent: 'hard', ticks: MAX_TICKS, seed }));
    expect(await code(c.practice({ opponent: 'hard', ticks: 10 }))).toBe('busy');
    const match = h.createMatch({ realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
    expect((await c.briefing()).phase).toBe('match');
    // Seated, the same principal still has both lobby runs in flight.
    expect(await code(c.practice({ opponent: 'hard', ticks: 10, artifact: goTo(1, 1) }))).toBe('busy');
    await Promise.all(runs);
    expect(await c.practice({ opponent: 'idle', ticks: 10, artifact: goTo(1, 1) })).toMatchObject({ ok: true, ticks: 10 });
    match.dispose();
  });

  it('supervised deploys replace pending requests, wake waiters, and report rejected, failed and approved outcomes', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    h.commanders.update(ALICE, runnerId, { mandate: { autonomy: 'supervised'  } });
    const c = commander(h, ALICE, runnerId, 'runner');
    const first = await c.policyDeploy(goTo(0, 0));
    if (!('approval' in first)) throw new Error('Expected approval request');
    expect(first.approval).toMatchObject({ kind: 'policyDeploy', version: 1 });
    expect(await c.policyStatus()).toEqual({ version: null, approval: { ...first.approval, status: 'pending' } });
    await c.wait({ seconds: 0 });
    const waiting = c.wait({ seconds: 30 });
    const second = await c.policyDeploy(goTo(1, 1));
    if (!('approval' in second)) throw new Error('Expected replacement request');
    expect(await waiting).toMatchObject({ wake: 'approval' });
    expect(await code(h.commanders.resolveApproval(ALICE, runnerId, first.approval.id, true))).toBe('approval_not_found');
    await h.commanders.resolveApproval(ALICE, runnerId, second.approval.id, false);
    expect(await c.policyStatus()).toMatchObject({ version: null, approval: { id: second.approval.id, status: 'rejected' } });
    expect(await c.wait({ seconds: 0 })).toMatchObject({ wake: 'approval' });
    const invalid = await c.policyDeploy(js('function think( {'));
    if (!('approval' in invalid)) throw new Error('Expected compile approval request');
    expect(await h.commanders.resolveApproval(ALICE, runnerId, invalid.approval.id, true)).toMatchObject({ ok: false, error: { code: 'compile' } });
    expect(await c.policyStatus()).toMatchObject({ approval: { status: 'failed' } });
    const valid = await c.policyDeploy(goTo(2, 2));
    if (!('approval' in valid)) throw new Error('Expected deploy approval request');
    expect(h.commanders.roster(ALICE)[0]!.policy.activeByRole.runner).toBeNull();
    expect(await h.commanders.resolveApproval(ALICE, runnerId, valid.approval.id, true)).toMatchObject({ ok: true, version: 1 });
    expect(await c.policyStatus()).toMatchObject({ version: 1, approval: { status: 'approved' } });
    expect(await code(h.commanders.resolveApproval(ALICE, runnerId, valid.approval.id, true))).toBe('approval_not_found');
  });

  it('pins publish and rollback proposals, and carries pending approval into a live match and back', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const c = commander(h, ALICE, runnerId, 'runner');
    expect(await deploy(c, goTo(0, 0))).toMatchObject({ ok: true, version: 1 });
    expect(await deploy(c, goTo(1, 1))).toMatchObject({ ok: true, version: 2 });
    h.commanders.update(ALICE, runnerId, { mandate: { autonomy: 'supervised' } });
    const rollback = await c.policyRollback(1);
    if (!('approval' in rollback)) throw new Error('Expected rollback approval request');
    expect(rollback.approval).toMatchObject({ kind: 'policyRollback', version: 1 });
    expect(await c.policyStatus()).toMatchObject({ version: 2 });
    const match = h.createMatch({ realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
    expect(await c.policyStatus()).toMatchObject({ approval: { ...rollback.approval, status: 'pending' } });
    expect(await h.commanders.resolveApproval(ALICE, runnerId, rollback.approval.id, true)).toMatchObject({ ok: true, version: 1 });
    const publish = await c.publish();
    if (!('approval' in publish)) throw new Error('Expected publish approval request');
    expect(publish.approval).toMatchObject({ kind: 'publish', version: 1 });
    match.dispose();
    expect(await c.policyStatus()).toMatchObject({ approval: { ...publish.approval, status: 'pending' } });
    await h.commanders.rollback(ALICE, runnerId, 'runner', 2);
    expect(await h.commanders.resolveApproval(ALICE, runnerId, publish.approval.id, true)).toMatchObject({ policyId: expect.any(String) });
    expect(await c.policyStatus()).toMatchObject({ version: 2, approval: { status: 'approved' } });
  });
});

describe('non-consuming seat status', () => {
  it('snapshots lobby messages and approval without consuming either wake, and isolates listeners', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    h.commanders.update(ALICE, runnerId, { mandate: { autonomy: 'supervised'  } });
    const session = h.agentSession(h.commanders.token(ALICE, runnerId), 'runner') as Extract<AgentSession, { kind: 'commander' }>;
    const statuses: SeatStatus[] = [];
    h.commanders.onStatus(() => { throw new Error('observer failure'); });
    const unsubscribe = h.commanders.onStatus((owner, role) => {
      expect([owner, role]).toEqual([ALICE, runnerId]);
      statuses.push(session.status());
    });
    h.commanders.tell(ALICE, [runnerId], 'private owner instruction');
    expect(statuses).toEqual([{ phase: 'lobby', tick: 0, unreadOwnerMessages: 1 }]);
    const proposed = await session.control.policyDeploy(goTo(0, 0));
    if (!('approval' in proposed)) throw new Error('Expected approval request');
    const snapshot = session.status();
    expect(snapshot).toEqual({
      phase: 'lobby', tick: 0, unreadOwnerMessages: 1,
      approval: { ...proposed.approval, status: 'pending' },
    });
    snapshot.approval!.status = 'approved';
    expect(session.status().approval!.status).toBe('pending');
    expect(JSON.stringify(session.status())).not.toContain('private owner instruction');
    expect(await session.control.wait({ seconds: 0 })).toMatchObject({ wake: 'approval' });
    expect(session.status().unreadOwnerMessages).toBe(1);
    expect(await session.control.wait({ seconds: 0 })).toMatchObject({ wake: 'owner_message', messages: [{ text: 'private owner instruction' }] });
    expect(session.status().unreadOwnerMessages).toBe(0);
    await h.commanders.resolveApproval(ALICE, runnerId, proposed.approval.id, false);
    expect(statuses.at(-1)!.approval!.status).toBe('rejected');
    expect(statuses).toHaveLength(3);
    unsubscribe();
  });

  it('bridges match messages and approvals synchronously, preserving seating and approval waits', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    h.commanders.update(ALICE, runnerId, { mandate: { autonomy: 'supervised'  } });
    const session = h.agentSession(h.commanders.token(ALICE, runnerId), 'runner') as Extract<AgentSession, { kind: 'commander' }>;
    const commanderStatuses: SeatStatus[] = [];
    const unsubscribeCommander = h.commanders.onStatus((owner, role) => {
      if (owner === ALICE && role === runnerId) commanderStatuses.push(session.status());
    });
    const match = h.createMatch({ realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
    expect(commanderStatuses).toEqual([{ phase: 'match', team: 'blue', tick: 0, outcome: 'running', unreadOwnerMessages: 0 }]);
    expect(session.status()).toEqual(match.status('blue', 'runner'));
    // Reading status does not acknowledge the seating transition.
    expect(await session.control.wait({ seconds: 30 })).toMatchObject({ phase: 'match', tick: 0 });
    const matchStatuses: SeatStatus[] = [];
    match.onStatus(() => { throw new Error('observer failure'); });
    const unsubscribeMatch = match.onStatus((team, role) => {
      if (team === 'blue' && role === 'runner') matchStatuses.push(match.status('blue', 'runner'));
    });
    match.tell('blue', ['runner'], 'match-only private instruction');
    expect(matchStatuses.at(-1)!.unreadOwnerMessages).toBe(1);
    expect(commanderStatuses.at(-1)).toEqual(matchStatuses.at(-1));
    expect(JSON.stringify(session.status())).not.toContain('private instruction');
    expect(await session.control.wait({ seconds: 0 })).toMatchObject({ wake: 'owner_message', messages: [{ text: 'match-only private instruction' }] });
    const proposed = await session.control.policyDeploy(goTo(0, 0));
    if (!('approval' in proposed)) throw new Error('Expected approval request');
    const snapshot = match.status('blue', 'runner');
    snapshot.approval!.status = 'approved';
    expect(session.status().approval!.status).toBe('pending');
    expect(await session.control.wait({ seconds: 0 })).toMatchObject({ wake: 'approval' });
    await h.commanders.resolveApproval(ALICE, runnerId, proposed.approval.id, false);
    expect(matchStatuses.at(-1)!.approval!.status).toBe('rejected');
    expect(commanderStatuses.at(-1)).toEqual(matchStatuses.at(-1));
    expect(await session.control.wait({ seconds: 0 })).toMatchObject({ wake: 'approval' });
    match.dispose();
    expect(commanderStatuses.at(-1)).toMatchObject({ phase: 'lobby', approval: { status: 'rejected' } });
    expect(matchStatuses).toHaveLength(4);
    unsubscribeMatch();
    unsubscribeCommander();
  });

  it('authenticates snapshots after token rotation, connection revocation and roster removal', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const guardId = h.commanders.create(ALICE, { name: 'Guard', kind: 'agent', roles: ['guard'], isolation: { independentSessions: true } }).id;
    const tokenSession = h.agentSession(h.commanders.token(ALICE, runnerId), 'runner') as Extract<AgentSession, { kind: 'commander' }>;
    let valid = true;
    const agent = h.commanders.agent(ALICE, runnerId, () => valid, 'runner')!;
    const notifications: [string, string][] = [];
    h.commanders.onStatus((owner, role) => notifications.push([owner, role]));
    const rotated = h.commanders.rotate(ALICE, runnerId);
    expect(notifications).toEqual([[ALICE, runnerId]]);
    expect(() => tokenSession.status()).toThrow(expect.objectContaining({ code: 'bad_token' }));
    expect(agent.status()).toEqual({ phase: 'lobby', tick: 0, unreadOwnerMessages: 0 });
    valid = false;
    expect(() => agent.status()).toThrow(expect.objectContaining({ code: 'bad_token' }));
    const current = h.agentSession(rotated) as Extract<AgentSession, { kind: 'commander' }>;
    await h.commanders.remove(ALICE);
    expect(notifications).toEqual([[ALICE, runnerId], [ALICE, runnerId], [ALICE, guardId]]);
    expect(() => current.status()).toThrow(expect.objectContaining({ code: 'bad_token' }));
  });

  it('notifies seat-token replacement and disposal after credentials are revoked', () => {
    const h = newHost();
    const match = h.createMatch({ realtime: false });
    const token = match.mintSeatToken('blue', 'runner');
    const authenticated: boolean[] = [];
    const unsubscribe = match.onStatus((team, role) => {
      if (team === 'blue' && role === 'runner') authenticated.push(h.authenticate(token) !== undefined);
    });
    match.mintSeatToken('blue', 'runner');
    expect(authenticated).toEqual([false]);
    match.dispose();
    expect(authenticated).toEqual([false, false]);
    unsubscribe();
  });
});

describe('auto-seating and routing', () => {
  it('delivers seating immediately on the first wait even when no lobby wait was pending', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const c = commander(h, ALICE, runnerId, 'runner');
    const match = h.createMatch({ realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
    expect(await c.wait({ seconds: 30 })).toMatchObject({ phase: 'match', tick: 0, outcome: 'running' });
    match.dispose();
  });

  it.each(['briefing', 'observe', 'wait'] as const)('does not repeat seating observed through %s before an owner-message wait', async (method) => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const c = commander(h, ALICE, runnerId, 'runner');
    const match = h.createMatch({ realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
    if (method === 'wait') await c.wait({ seconds: 0 });
    else await c[method]();
    const waiting = c.wait({ seconds: 30 });
    h.commanders.tell(ALICE, [runnerId], 'defend');
    expect(await waiting).toMatchObject({ wake: 'owner_message', messages: [{ text: 'defend' }] });
    match.dispose();
  });

  it('includes a simultaneous owner message in a retained seating result', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const c = commander(h, ALICE, runnerId, 'runner');
    const match = h.createMatch({ realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
    const waiting = c.wait({ seconds: 30 });
    h.commanders.tell(ALICE, [runnerId], 'defend');
    expect(await waiting).toMatchObject({ phase: 'match', wake: 'owner_message', messages: [{ text: 'defend' }] });
    expect(await c.wait({ seconds: 0 })).not.toHaveProperty('messages');
    match.dispose();
  });

  it('the library policy plays from tick 0; the same token routes to its assigned agent seat and returns to the lobby after the match', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    h.commanders.create(ALICE, { name: 'Guard', kind: 'agent', roles: ['guard'], isolation: { independentSessions: true } });
    const c = commander(h, ALICE, runnerId, 'runner');
    await deploy(c, goTo(0, 0, 'lib'));
    // A pending lobby wait transfers to the new match.
    const pending = c.wait({ seconds: 30 });

    const calls: PlayerThreeTraceEvent[] = [];
    h.onTrace((e) => {
      if (e.type === 'policy_call') calls.push(e);
    });
    const match = h.createMatch({ seed: 2, realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, ...(commander.roles[0] === 'guard' ? { kind: 'none' as const } : { kind: commander.kind, commander: { id: commander.id } }) })) });
    const session = h.agentSession(h.commanders.token(ALICE, runnerId), 'runner') as Extract<AgentSession, { kind: 'commander' }>;
    const endedStatuses: SeatStatus[] = [];
    h.commanders.onStatus((owner, role) => {
      if (owner === ALICE && role === runnerId) endedStatuses.push(session.status());
    });
    const matchStatuses: SeatStatus[] = [];
    match.onStatus((team, role) => {
      if (team === 'blue' && role === 'runner') matchStatuses.push(match.status('blue', 'runner'));
    });
    // The lobby wait ends as soon as the match seats the commander: its entry, with the first observation.
    expect(await pending).toEqual({ phase: 'match', tick: 0, outcome: 'running', events: [], observation: expect.objectContaining({ tick: 0 }), instruction: expect.any(String) });
    expect(h.commanders.roster(ALICE)[0]!.seated).toEqual({ match: match.id, team: 'blue', roles: ['runner'] });

    const blueRunner = () => match.seats().find((s) => s.team === 'blue' && s.role === 'runner')!;
    // The assigned controller stays agent; the library policy is deployed alongside it.
    expect(blueRunner()).toMatchObject({ controller: 'agent', commander: true });
    expect(match.seats().find((s) => s.team === 'blue' && s.role === 'guard')).toMatchObject({ controller: 'none' });
    expect(match.seats().find((s) => s.team === 'red' && s.role === 'runner')).toMatchObject({ controller: 'bot' });
    expect(match.seats().find((s) => s.team === 'red' && s.role === 'runner')!.commander).toBeUndefined();
    await match.step(1);
    expect(calls[0]).toMatchObject({ tick: 0, team: 'blue', role: 'runner', version: 1, logs: ['lib 0'] });
    expect(blueRunner().policyVersion).toBe(1);

    const b = await c.briefing();
    expect(b).toMatchObject({ phase: 'match', seat: { team: 'blue', role: 'runner' } });
    expect(await c.observe()).toMatchObject({ tick: 1 });
    expect(await c.act([{ kind: 'stop' }])).toEqual([{ ok: true }]);

    // A deploy in the match lands in the library as the next version and becomes active.
    expect(await deploy(c, goTo(1, 1, 'live'))).toMatchObject({ ok: true, version: 2 });
    expect(h.commanders.roster(ALICE)[0]!.policy).toMatchObject({ activeByRole: { runner: 2 }, versions: [{ version: 1 }, { version: 2 }] });

    await match.step(MAX_TICKS);
    expect(match.outcome('blue')).not.toBe('running');
    expect(endedStatuses.at(-1)).toEqual({ phase: 'lobby', tick: match.tick, outcome: match.outcome('blue'), unreadOwnerMessages: 0,
      previousMatch: { match: match.id, team: 'blue', role: 'runner', tick: match.tick, outcome: match.outcome('blue'), disposition: 'final', at: expect.any(Number) } });
    expect(matchStatuses.at(-1)).toEqual({ phase: 'match', team: 'blue', tick: match.tick, outcome: match.outcome('blue'), unreadOwnerMessages: 0 });
    // Back to the lobby once the outcome is decided; the result counts in the commander's stats.
    expect((await c.briefing()).phase).toBe('lobby');
    expect(await c.observe()).toMatchObject({ phase: 'lobby', seat: null });
    h.commanders.tell(ALICE, [runnerId], 'good game');
    expect(session.status()).toMatchObject({ phase: 'lobby', tick: match.tick, outcome: match.outcome('blue'), unreadOwnerMessages: 1 });
    expect(await c.wait({ seconds: 0 })).toMatchObject({ phase: 'match', tick: match.tick, outcome: match.outcome('blue'), wake: 'owner_message', messages: [{ text: 'good game' }] });
    expect(await c.wait({ seconds: 0 })).toMatchObject({ phase: 'lobby', seat: null });
    const [runner] = h.commanders.roster(ALICE);
    expect(runner!.seated).toBeNull();
    expect(runner!.record.wins + runner!.record.losses + runner!.record.draws).toBe(1);
  });

  it('an absent agent keeps its controller assignment while policy or bot supplies fallback', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const guardId = h.commanders.create(ALICE, { name: 'Guard', kind: 'agent', roles: ['guard'], isolation: { independentSessions: true } }).id;
    h.commanders.update(ALICE, guardId, { botLevel: 'hard' });
    // Deployed by the owner-side path (practice/rollback need a version): deploy via the token, then let liveness lapse.
    const c = commander(h, ALICE, runnerId, 'runner');
    await deploy(c, goTo(0, 0));
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => now + 60_000;
    try {
      const match = h.createMatch({ seed: 2, realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
      const seat = (role: string) => match.seats().find((s) => s.team === 'blue' && s.role === role)!;
      expect(seat('runner')).toMatchObject({ controller: 'agent', agentActive: false });
      // No library policy: the fallback bot acts without changing the assigned controller.
      expect(seat('guard')).toMatchObject({ controller: 'agent', agentActive: false });
      await match.step(1);
      expect(seat('runner').policyVersion).toBe(1);
      await c.briefing();
      expect(seat('runner')).toMatchObject({ controller: 'agent', agentActive: true });
      await commander(h, ALICE, guardId, 'guard').briefing();
      expect(seat('guard')).toMatchObject({ controller: 'agent', agentActive: true });
      // An owner override sticks: agent presence does not change it.
      match.setController('blue', 'runner', 'human');
      await c.briefing();
      expect(seat('runner').controller).toBe('human');
    } finally {
      Date.now = realNow;
    }
  });

  it('ready check: held until assigned agents connect (online) and mark themselves ready; skip starts anyway', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    h.commanders.create(ALICE, { name: 'Guard', kind: 'agent', roles: ['guard'], isolation: { independentSessions: true } });
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => now + 60_000;
    try {
      const match = h.createMatch({ seed: 1, realtime: false, readySeconds: 30, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, ...(commander.roles[0] === 'guard' ? { kind: 'bot' as const } : { kind: commander.kind, commander: { id: commander.id } }) })) });
      expect(match.readyCheck()).toMatchObject({ pending: true, seats: expect.arrayContaining([
        expect.objectContaining({ team: 'blue', role: 'runner', ready: false }),
        expect.objectContaining({ team: 'blue', role: 'guard', ready: true }),
      ]) });
      const runner = commander(h, ALICE, runnerId, 'runner');
      await runner.briefing();
      // Present is online, not ready: the agent declares readiness itself.
      expect(match.readiness().seats.find((s) => s.team === 'blue' && s.role === 'runner')?.state).toBe('online');
      expect(match.readyCheck()?.pending).toBe(true);
      expect(await runner.observe()).toMatchObject({ phase: 'lobby', seat: { team: 'blue', role: 'runner' }, you: { ready: false }, startsWhen: { kind: 'ready', inSeconds: 30 } });
      expect(await runner.ready()).toMatchObject({ phase: 'lobby', you: { ready: true } });
      expect(match.readyCheck()).toMatchObject({ pending: false, seats: expect.arrayContaining([
        expect.objectContaining({ team: 'blue', role: 'runner', ready: true }),
        expect.objectContaining({ team: 'blue', role: 'guard', ready: true }),
      ]) });
      match.dispose();

      const other = h.createMatch({ seed: 1, realtime: false, readySeconds: 30, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, ...(commander.roles[0] === 'guard' ? { kind: 'bot' as const } : { kind: commander.kind, commander: { id: commander.id } }) })) });
      // Cached lobby presence and an earlier match's ready mark cannot ready a new assignment.
      expect(other.readyCheck()?.pending).toBe(true);
      await commander(h, ALICE, runnerId, 'runner').briefing();
      expect(other.readyCheck()?.pending).toBe(true);
      await commander(h, ALICE, runnerId, 'runner').ready();
      expect(other.readyCheck()?.pending).toBe(false);
      other.dispose();
      Date.now = () => now + 120_000;
      const held = h.createMatch({ seed: 1, realtime: false, readySeconds: 30, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, ...(commander.roles[0] === 'guard' ? { kind: 'bot' as const } : { kind: commander.kind, commander: { id: commander.id } }) })) });
      expect(held.readyCheck()?.pending).toBe(true);
      held.skipReadyCheck();
      expect(held.readyCheck()?.pending).toBe(false);
      expect(h.createMatch({ realtime: false }).readyCheck()).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('token scope', () => {
  it('a commander token reaches only its own owner’s seat; rotation revokes the old token', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    h.commanders.ensure(BOB);
    const bobRunnerId = h.commanders.create(BOB, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const otherRunnerId = h.commanders.create(ALICE, { name: 'Other runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const aliceToken = h.commanders.token(ALICE, runnerId);
    expect(h.commanders.token(ALICE, runnerId)).toBe(aliceToken);
    expect(h.commanders.token(BOB, bobRunnerId)).not.toBe(aliceToken);
    expect(h.commanders.token(ALICE, otherRunnerId)).not.toBe(aliceToken);
    const otherToken = h.commanders.token(ALICE, otherRunnerId);
    const otherRunner = commander(h, ALICE, otherRunnerId, 'runner');
    expect((await otherRunner.briefing()).phase).toBe('lobby');
    expect(await otherRunner.observe()).toMatchObject({ phase: 'lobby', seat: null });
    // Not a match principal: cannot join a room or act as an owner/spectator.
    expect(h.authenticate(aliceToken)).toBeUndefined();
    expect(h.seatControl(aliceToken)).toBeUndefined();

    const assignments = [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent' as const, commander: { id: runnerId } },
      { team: 'red', role: 'runner', owner: BOB, kind: 'agent' as const, commander: { id: bobRunnerId } },
    ];
    const match = h.createMatch({ seed: 5, realtime: false, assignments });
    expect(() => h.createMatch({ assignments: [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: runnerId } },
      { team: 'red', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: runnerId } },
    ] })).toThrow(PlayerThreeError);
    expect(() => h.createMatch({ assignments: [{ team: 'blue', role: 'runner', owner: 'nobody_registered', kind: 'agent', commander: { id: runnerId } }] })).toThrow(PlayerThreeError);
    const alice = commander(h, ALICE, runnerId, 'runner');
    const bob = commander(h, BOB, bobRunnerId, 'runner');
    expect((await alice.briefing()).seat.team).toBe('blue');
    expect((await bob.briefing()).seat.team).toBe('red');
    const obs = (await alice.observe()) as { team: string };
    expect(obs.team).toBe('blue');
    // Alice's agent controls blue/runner only (agent rights): the seat flipped to agent, the others did not change.
    expect(match.seats().filter((s) => s.controller === 'agent').map((s) => `${s.team}/${s.role}`).sort()).toEqual(['blue/runner', 'red/runner']);

    const rotated = h.commanders.rotate(ALICE, runnerId);
    expect(h.commanders.token(ALICE, otherRunnerId)).toBe(otherToken);
    expect((await otherRunner.briefing()).phase).toBe('lobby');
    expect(rotated).not.toBe(aliceToken);
    expect(h.agentSession(aliceToken)).toBeUndefined();
    expect(await code(alice.observe())).toBe('bad_token');
    const fresh = h.agentSession(rotated)!;
    expect((await fresh.control.briefing()).seat.team).toBe('blue');
    expect(h.agentSession('A'.repeat(32))).toBeUndefined();
  });
});

describe('persistence', () => {
  it('rosters, tokens, libraries and stats survive a host restart (dataDir)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'playerthree-cmd-'));
    dirs.push(dir);
    let h = newHost(dir);
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    h.commanders.update(ALICE, runnerId, { botLevel: 'hard' });
    const token = h.commanders.token(ALICE, runnerId);
    const c = commander(h, ALICE, runnerId, 'runner');
    await deploy(c, goTo(0, 0, 'persisted'));
    await c.practice({ opponent: 'easy', ticks: 30, seed: 1 });
    const before = h.commanders.roster(ALICE);
    h.dispose();

    h = newHost(dir);
    await h.commanders.ready;
    expect(h.commanders.has(ALICE)).toBe(true);
    expect(h.commanders.token(ALICE, runnerId)).toBe(token);
    const after = h.commanders.roster(ALICE);
    expect(after.map(({ connected: _c, ...r }) => r)).toEqual(before.map(({ connected: _c, ...r }) => r));
    expect(await h.agentSession(token, 'runner')!.control.policyStatus()).toMatchObject({ version: 1 });

    const calls: PlayerThreeTraceEvent[] = [];
    h.onTrace((e) => {
      if (e.type === 'policy_call') calls.push(e);
    });
    const match = h.createMatch({ seed: 3, realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
    await match.step(1);
    expect(calls[0]).toMatchObject({ tick: 0, team: 'blue', role: 'runner', version: 1, logs: ['persisted 0'] });

    const rotated = h.commanders.rotate(ALICE, runnerId);
    h.dispose();
    h = newHost(dir);
    expect(h.agentSession(token)).toBeUndefined();
    expect(h.agentSession(rotated)).toMatchObject({ kind: 'commander', commanderId: runnerId, role: 'runner' });
    await h.commanders.remove(ALICE);
    expect(h.agentSession(rotated)).toBeUndefined();
    h.dispose();
    h = newHost(dir);
    expect(h.commanders.has(ALICE)).toBe(false);
  });
});

describe('commander tokens over MCP', () => {
  it('one endpoint config: lobby tools, then the live seat', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const server: Server = createServer((_q, r) => void r.writeHead(404).end());
    const mounted = mountMcp(server, h);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      const token = h.commanders.token(ALICE, runnerId);
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } }));
      const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
      const text = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

      const brief = await call('game_briefing');
      expect(brief.structuredContent).toMatchObject({ phase: 'lobby', seat: { role: 'runner' } });
      const obs = await call('game_observe');
      expect(obs.isError).toBeFalsy();
      expect(obs.structuredContent).toEqual({ phase: 'lobby', seat: null, you: { ready: false }, startsWhen: { kind: 'seat' }, instruction: expect.any(String) });
      expect(text(obs)).toEqual(obs.structuredContent);
      expect((await call('game_ready')).structuredContent).toMatchObject({ phase: 'lobby', seat: null, you: { ready: false } });
      expect((await call('policy_deploy', goTo(2, 2))).structuredContent).toMatchObject({ ok: true, version: 1 });
      expect((await call('game_wait', { seconds: 0 })).structuredContent).toMatchObject({ phase: 'lobby', seat: null });
      // A game lobby reserves the seat: the agent sees it and marks itself ready.
      h.commanders.reserve(ALICE, runnerId, 'runner', { team: 'blue', start: { kind: 'host' } });
      expect((await call('game_wait', { seconds: 0 })).structuredContent).toMatchObject({ phase: 'lobby', seat: { team: 'blue', role: 'runner' }, you: { ready: false }, startsWhen: { kind: 'host' } });
      expect((await call('game_ready')).structuredContent).toMatchObject({ phase: 'lobby', you: { ready: true } });
      expect(h.commanders.roster(ALICE)[0]!.reservations).toEqual([{ team: 'blue', role: 'runner', ready: true }]);
      // Game error codes count as `game:<code>` in policy stats and pass the output schema.
      const dash = js(`function think(obs) { return [{ kind: 'dash' }]; }`);
      const practiced = await call('practice_run', { opponent: 'easy', ticks: 200, seed: 1, artifact: dash });
      expect(practiced.isError).toBeFalsy();
      expect((practiced.structuredContent as { policy: { intentsRejected: { code: string }[] } }).policy.intentsRejected).toContainEqual(
        expect.objectContaining({ code: 'game:cooldown' }),
      );

      const match = h.createMatch({ seed: 2, realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
      expect((await call('game_wait', { seconds: 0 })).structuredContent).toMatchObject({ phase: 'match', tick: 0, outcome: 'running', observation: { tick: 0 }, instruction: expect.any(String) });
      expect((await call('game_ready')).structuredContent).toEqual({ phase: 'match', you: { ready: true } });
      expect((await call('game_briefing')).structuredContent).toMatchObject({ phase: 'match', seat: { team: 'blue', role: 'runner' } });
      expect((await call('game_observe')).isError).toBeFalsy();
      match.dispose();
      expect((await call('game_briefing')).structuredContent).toMatchObject({ phase: 'lobby' });
    } finally {
      await client.close();
      await mounted.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
