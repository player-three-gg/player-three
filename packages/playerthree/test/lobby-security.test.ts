import { afterEach, describe, expect, it, vi } from 'vitest';
import { definition, manifest, TagGame, type TagManifest } from '../examples/tag/index.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import type { PlayerThreeHost, SeatAssignment } from '../src/host/types.ts';
import type { Principal } from '../src/protocol.ts';
import { t } from '../src/schema.ts';

let host: PlayerThreeHost<TagManifest> | undefined;
afterEach(() => { host?.dispose(); vi.useRealTimers(); });

function setup(assignments: SeatAssignment[] = [
  { team: 'blue', role: 'runner', owner: 'alice_owner_0001', kind: 'human' },
  { team: 'blue', role: 'guard', owner: 'bob_owner_000002', kind: 'human' },
], readySeconds?: number) {
  host = createPlayerThreeHost({ definition });
  return { host, match: host.createMatch({ assignments, readySeconds, realtime: false, seed: 1 }) };
}

describe('public lobby capabilities', () => {
  it('atomically binds a human token once, rejects forged leases, and consumes disconnected tickets', () => {
    const { host, match } = setup();
    const ticket = match.mintHumanToken('blue', 'runner');
    const lease = host.claimToken(ticket.token, 'socket-a')!;
    expect(lease.principal).toEqual({ kind: 'human', match: match.id, team: 'blue', role: 'runner' });
    expect(host.claimToken(ticket.token, 'socket-a')).toBeUndefined();
    expect(host.claimToken(ticket.token, 'socket-b')).toBeUndefined();
    expect(host.authorizeLease({ ...lease })).toBeUndefined();
    expect(host.authorizeLease(lease)).toEqual(lease.principal);
    host.disconnectLease(lease);
    expect(host.authorizeLease(lease)).toBeUndefined();
    expect(host.claimToken(ticket.token, 'socket-c')).toBeUndefined();
  });

  it('reissue, expiry, leave and end revoke already-claimed credentials despite throwing observers', () => {
    vi.useFakeTimers();
    const { host, match } = setup();
    let revoked = 0;
    host.onLeaseRevoked(() => { throw new Error('observer failure'); });
    host.onLeaseRevoked(() => { revoked++; });
    const first = match.mintHumanToken('blue', 'runner');
    const old = host.claimToken(first.token, 'old')!;
    const next = match.mintHumanToken('blue', 'runner', { ttlSeconds: 1 });
    expect(host.authorizeLease(old)).toBeUndefined();
    const expiring = host.claimToken(next.token, 'next')!;
    vi.advanceTimersByTime(1000);
    expect(host.authorizeLease(expiring)).toBeUndefined();
    const leaving = host.claimToken(match.mintHumanToken('blue', 'guard').token, 'leaving')!;
    match.revokeSeat('blue', 'guard');
    expect(host.authorizeLease(leaving)).toBeUndefined();
    const ending = host.claimToken(match.mintHumanToken('blue', 'runner').token, 'ending')!;
    match.onEnd(() => { throw new Error('terminal observer failure'); });
    match.end('draw');
    expect(host.authorizeLease(ending)).toBeUndefined();
    expect(host.claimToken(match.mintHumanToken('blue', 'runner').token, 'after-end')).toBeUndefined();
    expect(revoked).toBe(4);
    expect(() => match.humanJoined('blue', 'runner', false)).not.toThrow();
  });

  it('never gives a human authority over a different same-side seat', async () => {
    const { host, match } = setup();
    const principal = host.authenticate(match.mintHumanToken('blue', 'runner').token)!.principal;
    for (const msg of [
      { op: 'call', role: 'guard', method: 'observe', args: {} },
      { op: 'stream', role: 'guard', everyTicks: 1 },
      { op: 'mint', role: 'guard' },
      { op: 'controller', role: 'guard', controller: 'agent' },
      { op: 'scopes', role: 'guard', scopes: [] },
      { op: 'resolveApproval', role: 'guard', id: 'foreign', approve: true },
    ]) {
      expect(await match.handleMessage(principal, { ...msg, seq: 1 }, () => {})).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(await match.handleMessage(principal, { op: 'controller', role: 'runner', controller: 'human', seq: 2 })).toMatchObject({ ok: true });
  });

  it('a human who hands their seat to an agent, bot or hold keeps renewing its exact-seat ticket', async () => {
    const { host, match } = setup([
      { team: 'blue', role: 'runner', owner: 'alice_owner_0001', kind: 'human' },
      { team: 'blue', role: 'guard', owner: 'alice_owner_0001', kind: 'agent' },
    ]);
    let seq = 1;
    for (const controller of ['agent', 'bot', 'none', 'human'] as const) {
      const principal = host.authenticate(match.mintHumanToken('blue', 'runner').token)!.principal;
      expect(await match.handleMessage(principal, { op: 'controller', seq: seq++, role: 'runner', controller })).toMatchObject({ ok: true });
      // The periodic renewal after the hand-off: still the same human's seat.
      expect(() => match.mintHumanToken('blue', 'runner')).not.toThrow();
    }
    // An agent-assigned seat never becomes a human credential, and a revoked (left or kicked) seat is gone.
    expect(() => match.mintHumanToken('blue', 'guard')).toThrow(expect.objectContaining({ code: 'forbidden' }));
    match.revokeSeat('blue', 'runner');
    expect(() => match.mintHumanToken('blue', 'runner')).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('requires an explicit human-control grant for initially automated seats and drops it on ownership handoff', () => {
    const { host, match } = setup([
      { team: 'blue', role: 'runner', owner: 'alice_owner_0001', kind: 'bot', ownerControl: true },
      { team: 'blue', role: 'guard', owner: 'alice_owner_0001', kind: 'agent' },
    ]);
    const ticket = match.mintHumanToken('blue', 'runner');
    const lease = host.claimToken(ticket.token, 'owner')!;
    expect(host.authorizeLease(lease)).toMatchObject({ kind: 'human', role: 'runner' });
    expect(() => match.mintHumanToken('blue', 'guard')).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => match.renewHumanToken('blue', 'runner')).not.toThrow();
    match.assign({ team: 'blue', role: 'runner', owner: 'alice_owner_0001', kind: 'agent' });
    expect(host.authorizeLease(lease)).toBeUndefined();
    expect(() => match.mintHumanToken('blue', 'runner')).not.toThrow();
    match.assign({ team: 'blue', role: 'runner', owner: 'bob_owner_000002', kind: 'agent' });
    expect(() => match.mintHumanToken('blue', 'runner')).toThrow(expect.objectContaining({ code: 'forbidden' }));
    match.assign({ team: 'blue', role: 'runner', owner: 'bob_owner_000002', kind: 'bot', ownerControl: true });
    expect(() => match.mintHumanToken('blue', 'runner')).not.toThrow();
    match.revokeSeat('blue', 'runner');
    expect(() => match.mintHumanToken('blue', 'runner')).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('explicit owner grants preserve human participation and broader-view anti-coaching restrictions', async () => {
    const observerManifest = { ...manifest, observer: t.obj({ tick: t.int(0, 1_000_000), visible: t.int(0, 4) }) };
    host = createPlayerThreeHost({ definition: {
      ...definition,
      manifest: observerManifest,
      create: ({ seed }) => {
        const game = new TagGame(seed);
        return Object.assign(game, { manifest: observerManifest, observerView: () => ({ tick: game.tick, visible: 4 }) });
      },
    } }) as unknown as PlayerThreeHost<TagManifest>;
    const policy = { allowOmniscient: true, minDelayMs: 0, public: false };
    const grant = { kind: 'omniscient' as const, teams: ['blue', 'red'], delayMs: 0 };
    const match = host.createMatch({ realtime: false, observerPolicy: policy, assignments: [
      { team: 'blue', role: 'runner', owner: 'alice', kind: 'bot', ownerControl: true },
      { team: 'blue', role: 'guard', owner: 'bob', kind: 'agent' },
    ] });
    expect(() => match.mintObserverToken(grant, { owner: 'alice' })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    match.mintObserverToken(grant, { owner: 'bob' });
    expect(() => match.assign({ team: 'blue', role: 'guard', owner: 'bob', kind: 'agent', ownerControl: true })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => match.mintHumanToken('blue', 'guard')).toThrow(expect.objectContaining({ code: 'forbidden' }));
    // Unranked practice: alice's own isolated agent on the other team keeps her human seat mintable and renewable...
    match.assign({ team: 'red', role: 'guard', owner: 'alice', kind: 'agent' });
    const lease = host.claimToken(match.mintHumanToken('blue', 'runner').token, 'alice')!;
    expect(host.authorizeLease(lease)).toMatchObject({ kind: 'human', role: 'runner' });
    expect(() => match.renewHumanToken('blue', 'runner')).not.toThrow();
    // ...but she can never coach: owner messages to her seats are refused, and a human seat on the other team too.
    expect(await match.handleMessage(lease.principal, { op: 'tell', seq: 1, roles: ['runner'], text: 'cross-team order' })).toMatchObject({ ok: false, code: 'forbidden' });
    match.assign({ team: 'red', role: 'guard', owner: 'alice', kind: 'human' });
    expect(() => match.mintHumanToken('blue', 'runner')).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => match.mintHumanToken('red', 'guard')).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('renews a connected human credential in place: the same lease outlives its first expiry', () => {
    vi.useFakeTimers();
    const { host, match } = setup();
    let revoked = 0;
    host.onLeaseRevoked(() => { revoked++; });
    const first = match.mintHumanToken('blue', 'runner');
    // Nothing claimed yet: an unused bearer keeps its short admission window.
    expect(() => match.renewHumanToken('blue', 'runner', { ttlSeconds: 600 })).toThrow(expect.objectContaining({ code: 'bad_token' }));
    const lease = host.claimToken(first.token, 'socket')!;
    vi.advanceTimersByTime(100_000);
    const { expiresAt } = match.renewHumanToken('blue', 'runner', { ttlSeconds: 600 });
    expect(expiresAt).toBe(Date.now() + 600_000);
    vi.advanceTimersByTime(500_000);
    expect(host.authorizeLease(lease)).toEqual(lease.principal);
    expect(revoked).toBe(0);
    vi.advanceTimersByTime(100_000);
    expect(host.authorizeLease(lease)).toBeUndefined();
    expect(revoked).toBe(1);
    // A dropped connection has nothing left to extend: the client takes a fresh ticket instead.
    expect(() => match.renewHumanToken('blue', 'runner')).toThrow(expect.objectContaining({ code: 'bad_token' }));
    expect(() => match.renewHumanToken('blue', 'runner', { ttlSeconds: 601 })).toThrow(expect.objectContaining({ code: 'invalid' }));
    // Same holder rule as minting: delegated seats renew, a revoked seat does not.
    host.claimToken(match.mintHumanToken('blue', 'runner').token, 'again');
    match.setController('blue', 'runner', 'bot');
    expect(() => match.renewHumanToken('blue', 'runner')).not.toThrow();
    match.revokeSeat('blue', 'runner');
    expect(() => match.renewHumanToken('blue', 'runner')).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('a reissued human ticket inherits the seat message budget instead of resetting it', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] }); // frozen clock: no refill between the two sockets
    const { host, match } = setup();
    const status = (principal: Principal, seq: number) =>
      match.handleMessage(principal, { op: 'call', seq, role: 'runner', method: 'policyStatus' });
    const first = host.authenticate(match.mintHumanToken('blue', 'runner').token)!.principal;
    for (let i = 0; i < 40; i++) expect(await status(first, i)).toMatchObject({ ok: true });
    const reissued = host.authenticate(match.mintHumanToken('blue', 'runner').token)!.principal;
    expect(await status(reissued, 41)).toMatchObject({ ok: false, code: 'rate_limited' });
    // A different seat keeps its own budget.
    const guard = host.authenticate(match.mintHumanToken('blue', 'guard').token)!.principal;
    expect(await match.handleMessage(guard, { op: 'call', seq: 42, role: 'guard', method: 'policyStatus' })).toMatchObject({ ok: true });
  });

  it('holds every stepping path until both trusted ready and actual human joins', async () => {
    vi.useFakeTimers();
    const { match } = setup(undefined, 60);
    match.setHumanReady('blue', 'runner', true);
    match.setHumanReady('blue', 'guard', true);
    expect(() => match.step()).toThrow();
    vi.advanceTimersByTime(60_001);
    expect(() => match.step()).toThrow();
    match.humanJoined('blue', 'runner', true);
    expect(() => match.step()).toThrow();
    match.humanJoined('blue', 'guard', true);
    expect(match.readiness().pending).toBe(false);
    await match.step();
    expect(match.tick).toBe(1);
  });

  it('manual preparation gates prevent tick-zero gameplay despite readiness deadlines', async () => {
    vi.useFakeTimers();
    const { host, match } = setup([]);
    match.holdStart();
    const owner = match.seat('blue', 'runner');
    const agent = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
    const before = JSON.stringify(match.view('blue'));
    await owner.briefing();
    await owner.observe();
    await expect(owner.act([{ kind: 'stop' }])).rejects.toMatchObject({ code: 'paused' });
    await expect(agent.act([{ kind: 'stop' }])).rejects.toMatchObject({ code: 'paused' });
    await expect(owner.sequence({ steps: [] })).rejects.toMatchObject({ code: 'paused' });
    expect(JSON.stringify(match.view('blue'))).toBe(before);
    vi.advanceTimersByTime(600_001);
    expect(match.readiness().pending).toBe(true);
    expect(() => match.step()).toThrow();
    await expect(owner.act([{ kind: 'stop' }])).rejects.toMatchObject({ code: 'paused' });
    match.skipReadyCheck();
    expect(await owner.act([{ kind: 'stop' }])).toEqual([{ ok: true }]);
    await match.step();
    expect(match.tick).toBe(1);
    expect(() => match.holdStart()).toThrow();
  });

  it('human all-chat targets only its own seat and invalid replacement preserves its lease', async () => {
    const { host, match } = setup();
    const human = match.mintHumanToken('blue', 'runner');
    const lease = host.claimToken(human.token, 'human')!;
    const runner = host.agentSession(match.mintSeatToken('blue', 'runner'))!;
    const guard = host.agentSession(match.mintSeatToken('blue', 'guard'))!;
    expect(await match.handleMessage(lease.principal, { op: 'tell', seq: 1, roles: 'all', text: 'private order' })).toMatchObject({ ok: true });
    expect(runner.drain()).toMatchObject([{ text: 'private order' }]);
    expect(guard.drain()).toEqual([]);
    expect(await match.handleMessage(lease.principal, { op: 'tell', seq: 2, roles: ['guard'], text: 'foreign order' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(() => match.mintHumanToken('blue', 'runner', { ttlSeconds: 601 })).toThrow();
    expect(host.authorizeLease(lease)).toEqual(lease.principal);
  });

  it('does not log adapter exception text supplied by private game input', async () => {
    const secret = 'sentinel-token-endpoint-policy-source';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      host = createPlayerThreeHost({ definition: {
        ...definition,
        create: (options) => {
          const adapter = definition.create(options);
          adapter.observe = () => { throw new Error(secret); };
          return adapter;
        },
      } });
      const match = host.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: 'alice_owner_0001', kind: 'human' }] });
      const principal = host.authenticate(match.mintHumanToken('blue', 'runner').token)!.principal;
      expect(await match.handleMessage(principal, { op: 'call', seq: 1, role: 'runner', method: 'observe', args: {} })).toMatchObject({ ok: false, code: 'internal' });
      expect(log).toHaveBeenCalledWith('playerthree/host: handleMessage failed');
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally { log.mockRestore(); }
  });

  it('preserves scoped spectator perspective and cached agent controls reject revocation', async () => {
    const { host, match } = setup();
    const spectator = host.claimToken(match.mintSpectatorToken('blue').token, 'watch')!;
    expect(spectator.principal).toEqual({ kind: 'spectator', match: match.id, team: 'blue' });
    expect(await match.handleMessage(spectator.principal, { op: 'mint', seq: 1, role: 'runner' })).toMatchObject({ ok: false, code: 'forbidden' });
    const token = match.mintSeatToken('blue', 'runner');
    const cached = host.seatControl(token)!;
    match.revokeToken(token);
    await expect(cached.briefing()).rejects.toMatchObject({ code: 'bad_token' });
  });

  it('cancels revoked waits before they can steal replacement agent owner messages', async () => {
    const { host, match } = setup([]);
    const old = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
    const pending = old.wait({ seconds: 60 }).then(() => 'unexpected success', (error: { code: string }) => error.code);
    const replacement = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
    expect(await pending).toBe('bad_token');
    match.tell('blue', ['runner'], 'Only replacement may consume this.');
    expect(await replacement.wait({ seconds: 0 })).toMatchObject({ messages: [{ text: 'Only replacement may consume this.' }] });
  });

  it('invalidated commander connections do not drain a new connection owner inbox', async () => {
    const { host } = setup([]);
    const owner = 'alice_owner_0001';
    host.commanders.ensure(owner);
    const commander = host.commanders.create(owner, { name: 'Alice runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    host.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner, kind: 'agent', commander: { id: commander } }] });
    let authorized = true;
    const old = host.commanders.agent(owner, commander, () => authorized, 'runner')!;
    const pending = old.control.wait({ seconds: 60 }).then(() => 'unexpected success', (error: { code: string }) => error.code);
    authorized = false;
    host.commanders.tell(owner, [commander], 'New connection private message.');
    expect(await pending).toBe('bad_token');
    const replacement = host.commanders.agent(owner, commander, () => true, 'runner')!;
    expect(await replacement.control.wait({ seconds: 0 })).toMatchObject({ messages: [{ text: 'New connection private message.' }] });
  });

  it('validates assignments before binding and rejects concurrent commander placement', async () => {
    const { host, match } = setup([]);
    host.commanders.ensure('alice_owner_0001');
    const commander = host.commanders.create('alice_owner_0001', { name: 'Alice runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const policyCommander = host.commanders.create('alice_owner_0001', { name: 'Alice policy', kind: 'policy', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const one: SeatAssignment = { team: 'blue', role: 'runner', owner: 'alice_owner_0001', kind: 'agent', commander: { id: commander } };
    expect(() => host.createMatch({ realtime: false, assignments: [one, { ...one, team: 'red' }] })).toThrow();
    expect(() => host.createMatch({ realtime: false, assignments: [{ ...one, kind: 'policy', commander: { id: policyCommander }, policy: { version: 999 } }] })).toThrow();
    expect(host.commanders.roster(one.owner).find((entry) => entry.id === commander)!.seated).toBeNull();
    const assigned = host.createMatch({ realtime: false, assignments: [one], readySeconds: 60 });
    expect(() => host.createMatch({ realtime: false, assignments: [{ ...one, team: 'red' }] })).toThrow();
    expect(assigned.readiness().seats.find((s) => s.role === 'runner' && s.team === 'blue')?.state).toBe('absent');
    const agent = host.agentSession(host.commanders.token(one.owner, commander), 'runner')!;
    await agent.control.briefing();
    expect(assigned.readiness().seats.find((s) => s.role === 'runner' && s.team === 'blue')?.state).toBe('online');
    await agent.control.ready();
    expect(assigned.readiness().seats.find((s) => s.role === 'runner' && s.team === 'blue')?.state).toBe('ready');
    const serialized = JSON.stringify(assigned.cards());
    expect(serialized).not.toContain(one.owner);
    for (const secret of ['scopes', 'mandate', 'token', 'endpoint', 'code']) expect(serialized).not.toContain(`\"${secret}\"`);
    expect(assigned.cards()[0]).toMatchObject({ kind: 'agent', aiPlayer: true, harness: { verified: false } });
    match.dispose();
  });
});
