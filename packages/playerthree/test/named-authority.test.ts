import { afterEach, describe, expect, it, vi } from 'vitest';
import { definition, manifest, TagGame } from '../examples/tag/index.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import type { DecisionUsage } from '../src/host/types.ts';
import { t } from '../src/schema.ts';

const OWNER = 'owner_one';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function fixture() {
  const observerManifest = { ...manifest, observer: t.obj({ tick: t.int(0, 1_000_000), visible: t.int(0, 4) }) };
  const host = createPlayerThreeHost({ definition: {
    ...definition,
    manifest: observerManifest,
    create: ({ seed }) => {
      const game = new TagGame(seed);
      return Object.assign(game, { manifest: observerManifest, observerView: () => ({ tick: game.tick, visible: 4 }) });
    },
  } });
  cleanups.push(() => host.dispose());
  const commander = (name: string, roles = ['runner'], independentSessions = true) => host.commanders.create(OWNER, {
    name, kind: 'agent', roles, isolation: { independentSessions },
  });
  return { host, commander };
}

const policy = { allowOmniscient: true, minDelayMs: 0, public: false };
const all = { kind: 'omniscient' as const, teams: ['blue', 'red'], delayMs: 0 };

describe('named commander exact-seat authority', () => {
  it('creates empty registries and independent identities for the same compatible role', () => {
    const { host, commander } = fixture();
    expect(host.commanders.ensure(OWNER)).toEqual([]);
    const first = commander('DeepSeek');
    const second = commander('Claude');
    expect(first.id).not.toBe(second.id);
    expect(host.commanders.roster(OWNER).map((c) => c.name)).toEqual(['DeepSeek', 'Claude']);
    expect(host.commanders.token(OWNER, first.id)).not.toBe(host.commanders.token(OWNER, second.id));
    expect(() => host.commanders.token(OWNER, 'runner')).toThrow();
    expect(() => host.commanders.update(OWNER, first.id, { preference: 'human' } as never)).toThrow();
  });

  it('validates a whole binding batch before publishing any match or acquiring a lease', () => {
    const { host, commander } = fixture();
    const first = commander('A');
    const second = commander('B', ['guard']);
    expect(() => host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: first.id } },
      { team: 'red', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: second.id } },
    ] })).toThrow();
    expect(host.matches()).toHaveLength(0);
    expect(host.commanders.roster(OWNER).every((entry) => entry.seated === null)).toBe(true);
    expect(() => host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: first.id } },
      { team: 'red', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: first.id } },
    ] })).toThrow();
    expect(host.matches()).toHaveLength(0);
  });

  it('requires an independent-session declaration across opposing live commanders', () => {
    const { host, commander } = fixture();
    const first = commander('A', ['runner'], false);
    const second = commander('B');
    expect(() => host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: first.id } },
      { team: 'red', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: second.id } },
    ] })).toThrow();
    expect(host.matches()).toHaveLength(0);
  });

  it('keeps opposing same-owner sessions, fog, readiness and private chat in exact lanes', async () => {
    const { host, commander } = fixture();
    const first = commander('A', ['runner', 'guard']);
    const second = commander('B');
    const firstToken = host.commanders.token(OWNER, first.id);
    const a = host.agentSession(firstToken, 'runner')!;
    const wrongRole = host.agentSession(firstToken, 'guard')!;
    const b = host.agentSession(host.commanders.token(OWNER, second.id), 'runner')!;
    await a.control.briefing(); // Connection availability is not prepared-seat readiness.
    await b.control.briefing();
    const match = host.createMatch({ seed: 1, realtime: false, readySeconds: 60, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: first.id } },
      { team: 'red', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: second.id } },
    ] });
    expect(match.readiness().pending).toBe(true);
    expect(match.readiness().seats.filter((seat) => seat.kind === 'agent').map((seat) => seat.state)).toEqual(['absent', 'absent']);
    expect(a.kind === 'commander' && a.seat()).toEqual({ match: match.id, team: 'blue', role: 'runner' });
    expect(b.kind === 'commander' && b.seat()).toEqual({ match: match.id, team: 'red', role: 'runner' });
    expect(await wrongRole.control.observe()).toMatchObject({ phase: 'lobby', seat: null });
    // Held before the start: each lane sees its own seat only, online until it marks itself ready.
    expect(await a.control.observe()).toMatchObject({ phase: 'lobby', seat: { team: 'blue', role: 'runner' }, you: { ready: false } });
    expect(await b.control.observe()).toMatchObject({ phase: 'lobby', seat: { team: 'red', role: 'runner' }, you: { ready: false } });
    expect(match.readiness().seats.filter((seat) => seat.kind === 'agent').map((seat) => seat.state)).toEqual(['online', 'online']);
    await a.control.ready();
    expect(match.readiness().seats.filter((seat) => seat.kind === 'agent').map((seat) => seat.state)).toEqual(['ready', 'online']);
    expect(match.readiness().pending).toBe(true);
    await b.control.ready();
    expect(match.readiness().pending).toBe(false);
    expect(await a.control.observe()).toMatchObject({ team: 'blue' });
    expect(await b.control.observe()).toMatchObject({ team: 'red' });
    expect(match.tick).toBe(0);
    expect(await a.control.act([{ kind: 'stop' }])).toEqual([{ ok: true }]);
    expect(await b.control.act([{ kind: 'stop' }])).toEqual([{ ok: true }]);
    expect(() => host.commanders.tell(OWNER, [first.id], 'Coach the other side')).toThrow();
    await a.control.say('Private blue reply');
    expect(b.drain()).toEqual([]);
    expect(host.commanders.chat(OWNER).at(-1)).toMatchObject({ commanderIds: [first.id], text: 'Private blue reply' });
    expect(() => host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: first.id } },
    ] })).toThrow();
    expect(host.matches()).toHaveLength(1);
  });

  it('binds several compatible roles on one side as isolated lanes of one exclusive match lease', async () => {
    const { host, commander } = fixture();
    const selected = commander('Whole army', ['runner', 'guard']);
    const token = host.commanders.token(OWNER, selected.id);
    const runner = host.agentSession(token, 'runner')!;
    const guard = host.agentSession(token, 'guard')!;
    const match = host.createMatch({ realtime: false, readySeconds: 60, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: selected.id } },
      { team: 'blue', role: 'guard', owner: OWNER, kind: 'agent', commander: { id: selected.id } },
    ] });
    expect(host.commanders.roster(OWNER)[0]!.seated).toEqual({ match: match.id, team: 'blue', roles: ['runner', 'guard'] });
    expect(await runner.control.observe()).toMatchObject({ phase: 'lobby', seat: { team: 'blue', role: 'runner' } });
    await runner.control.ready();
    expect(match.readiness().pending).toBe(true);
    expect(await guard.control.ready()).toMatchObject({ phase: 'lobby', seat: { team: 'blue', role: 'guard' }, you: { ready: true } });
    expect(match.readiness().pending).toBe(false);
    expect(await runner.control.observe()).toMatchObject({ team: 'blue', you: { role: 'runner' } });
    expect(await guard.control.observe()).toMatchObject({ team: 'blue', you: { role: 'guard' } });
    match.tell('blue', ['runner'], 'Runner only');
    expect(runner.drain()).toMatchObject([{ text: 'Runner only' }]);
    expect(guard.drain()).toEqual([]);
    expect(() => host.createMatch({ realtime: false, assignments: [
      { team: 'red', role: 'guard', owner: OWNER, kind: 'agent', commander: { id: selected.id } },
    ] })).toThrow();
    match.end('draw');
    expect(host.commanders.roster(OWNER)[0]!.record.draws).toBe(1);
    expect(host.commanders.roster(OWNER)[0]!.seated).toBeNull();
  });

  it('releases aborted execution leases without inventing a draw or changing replay inputs', async () => {
    const { host, commander } = fixture();
    const selected = commander('A');
    const match = host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: selected.id } },
    ] });
    const replay = match.replay();
    await match.releaseBindings();
    expect(match.outcome('blue')).toBe('running');
    expect(match.replay()).toEqual(replay);
    expect(host.commanders.roster(OWNER)[0]!.seated).toBeNull();
    expect(() => match.step(1)).toThrow();
    expect(host.createMatch({ realtime: false, assignments: [
      { team: 'red', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: selected.id } },
    ] })).toBeDefined();
  });

  it('announces a prepared commander seat becoming ready when its session arrives', async () => {
    const { host, commander } = fixture();
    const selected = commander('A');
    const session = host.agentSession(host.commanders.token(OWNER, selected.id), 'runner')!;
    const match = host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: selected.id } },
    ] });
    const seen: string[] = [];
    // A start gate subscribes after binding and must observe the arrival, not only later unrelated status changes.
    match.onReadiness(() => seen.push(match.readiness().seats[0]!.state));
    expect(match.readiness().seats[0]!.state).toBe('absent');
    await session.control.briefing();
    expect(match.readiness().seats[0]!.state).toBe('ready');
    expect(seen).toContain('ready');
  });

  it('returns commanders of a halted, unended match to the lobby before its bindings are released', async () => {
    const { host, commander } = fixture();
    const selected = commander('A');
    const session = host.agentSession(host.commanders.token(OWNER, selected.id), 'runner')!;
    const match = host.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: selected.id } },
    ] });
    expect(await session.control.observe()).toMatchObject({ team: 'blue' });
    await match.halt();
    expect(match.over).toBe(false);
    expect(session.kind === 'commander' && session.seat()).toBeNull();
    expect(host.commanders.roster(OWNER)[0]!.seated).toBeNull();
    expect(await session.control.observe()).toMatchObject({ phase: 'lobby', seat: null });
    expect(await session.control.briefing()).toMatchObject({ phase: 'lobby' });
    await match.releaseBindings();
    expect(await session.control.observe()).toMatchObject({ phase: 'lobby', seat: null });
  });

  it('halts a batched step at the requested tick boundary without a synthetic outcome', async () => {
    const { host } = fixture();
    const match = host.createMatch({ realtime: false, seed: 1 });
    let settling: Promise<void> | undefined;
    match.onTick((tick) => { if (tick === 2) settling = match.halt(); });
    await match.step(20);
    await settling;
    expect(match.tick).toBe(2);
    expect(match.outcome('blue')).toBe('running');
    expect(() => match.start()).toThrow();
    expect(() => match.step(1)).toThrow();
  });

  it('rotates only the selected named credential and revokes existing scoped sessions', async () => {
    const { host, commander } = fixture();
    const first = commander('A');
    const second = commander('B');
    const oldToken = host.commanders.token(OWNER, first.id);
    const oldSession = host.agentSession(oldToken)!;
    const otherToken = host.commanders.token(OWNER, second.id);
    host.commanders.rotate(OWNER, first.id);
    expect(host.agentSession(oldToken)).toBeUndefined();
    await expect(oldSession.control.briefing()).rejects.toMatchObject({ code: 'bad_token' });
    expect(host.agentSession(otherToken)).toBeDefined();
  });
});

describe('observer principal admission and release clocks', () => {
  it('retains human participation after release and cannot upgrade that player to All or another side', () => {
    const { host } = fixture();
    const match = host.createMatch({ realtime: false, observerPolicy: policy, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'human' },
    ] });
    match.revokeSeat('blue', 'runner');
    expect(() => match.mintObserverToken(all, { owner: OWNER })).toThrow();
    expect(() => match.mintObserverToken({ kind: 'team', team: 'red', delayMs: 0 }, { owner: OWNER })).toThrow();
    const ticket = match.mintObserverToken({ kind: 'team', team: 'blue', delayMs: 0 }, { owner: OWNER });
    const lease = host.claimToken(ticket.token, 'fixed-team')!;
    expect(match.observerMessages(lease.principal, 'blue')[0]?.frame?.perspective).toBe('blue');
    expect(match.observerMessages(lease.principal, 'all')[0]?.state).toBe('closed');
  });

  it('separates observer vision from all agent, owner and operator methods', async () => {
    const { host, commander } = fixture();
    const selected = commander('A');
    const match = host.createMatch({ realtime: false, observerPolicy: policy, assignments: [
      { team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: selected.id } },
    ] });
    const ticket = match.mintObserverToken(all, { owner: OWNER });
    const lease = host.claimToken(ticket.token, 'observer')!;
    expect(host.agentSession(ticket.token)).toBeUndefined();
    expect(host.seatControl(ticket.token)).toBeUndefined();
    expect(match.observerMessages(lease.principal, 'all')[0]?.frame?.world).toEqual({ tick: 0, visible: 4 });
    expect(() => match.observerMessages({ ...lease.principal }, 'all')).toThrow();
    expect(await match.handleMessage(lease.principal, { op: 'mint', seq: 1, role: 'runner' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(() => host.commanders.tell(OWNER, [selected.id], 'Leaked omniscient coaching')).toThrow();
    match.revokeToken(ticket.token);
    expect(host.authorizeLease(lease)).toBeUndefined();
    expect(() => match.observerMessages(lease.principal, 'all')).toThrow();
  });

  it('holds public bootstrap and outcomes for 180 wall seconds and keeps an admitted lease through buffering', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { host } = fixture();
    expect(() => host.createMatch({ realtime: false, observerPolicy: { ...policy, public: true, minDelayMs: 179_999 } })).toThrow();
    const match = host.createMatch({ realtime: false, observerPolicy: { ...policy, public: true, minDelayMs: 180_000 } });
    expect(() => match.mintObserverToken(all, { owner: OWNER })).toThrow();
    const ticket = match.mintObserverToken({ ...all, delayMs: 180_000 }, { owner: OWNER, ttlSeconds: 120 });
    const lease = host.claimToken(ticket.token, 'public-observer')!;
    expect(host.authenticate(ticket.token)).toBeUndefined();
    expect(host.claimToken(ticket.token, 'duplicate')).toBeUndefined();
    match.end('draw');
    expect(match.observerMessages(lease.principal, 'all')).toEqual([{ op: 'observer', state: 'buffering' }]);
    vi.advanceTimersByTime(179_999);
    expect(host.authorizeLease(lease)).toBeDefined();
    expect(match.observerMessages(lease.principal, 'all')).toEqual([{ op: 'observer', state: 'buffering' }]);
    vi.advanceTimersByTime(1);
    expect(match.observerMessages(lease.principal, 'all')[0]?.frame?.outcomes).toEqual({ blue: 'draw', red: 'draw' });
    host.disconnectLease(lease);
    expect(host.authorizeLease(lease)).toBeUndefined();
  });
});

describe('host-owned metric recorder lifecycle', () => {
  it('owns one recorder, collects exact ticks, drains rows and finalizes only once', async () => {
    let instances = 0;
    let collects = 0;
    let finishes = 0;
    let cadence: number | undefined;
    let drained = false;
    const intents: unknown[] = [];
    const host = createPlayerThreeHost({ definition: {
      ...definition,
      metrics: (_game, options) => {
        instances++;
        cadence = options?.sampleEveryTicks;
        return {
          collect: () => { collects++; },
          finish: () => { finishes++; return { match: { ticks: collects }, sides: {} }; },
          intent: (intent) => { intents.push(intent); },
          rows: (matchId) => {
            if (drained) return {};
            drained = true;
            return { metrics: [{ matchId, tick: collects, sequence: 1, scope: 'match' as const,
              team: null, role: null, metric: 'ticks', value: collects, unit: 'tick' }] };
          },
        };
      },
    } });
    cleanups.push(() => host.dispose());
    const match = host.createMatch({ realtime: false, metricSampleEveryTicks: 7, controllers: {
      blue: { runner: 'agent', guard: 'none' }, red: { runner: 'none', guard: 'none' },
    } });
    expect(instances).toBe(1);
    expect(cadence).toBe(7);
    expect(() => match.metrics()).toThrow();
    const agent = host.agentSession(match.mintSeatToken('blue', 'runner'))!;
    await agent.control.act([{ kind: 'stop' }]);
    await match.step(3);
    expect(collects).toBe(3);
    expect(intents).toEqual([{ team: 'blue', role: 'runner', source: 'agent', accepted: true, code: 'ok' }]);
    expect(match.metricRows().metrics?.[0]).toMatchObject({ matchId: match.id, tick: 3, value: 3 });
    expect(match.metricRows()).toEqual({});
    await match.halt();
    expect(match.metrics().match.ticks).toBe(3);
    expect(match.metrics().match.ticks).toBe(3);
    match.dispose();
    expect(finishes).toBe(1);
  });
});

describe('optional exact-seat accounting and voluntary commentary', () => {
  it('validates and bounds reports without accepting a caller-selected seat or duplicate decision', async () => {
    const { host, commander } = fixture();
    const selected = commander('A');
    const session = host.agentSession(host.commanders.token(OWNER, selected.id), 'runner')!;
    const report: DecisionUsage = { decisionId: 'turn_1', latencyMs: 125, source: 'self_report', reporter: 'reported', inputTokens: 20, outputTokens: 5, costAmount: '0.001', currency: 'USD', coverage: 'complete' };
    expect(() => session.reportUsage(report)).toThrow();
    const match = host.createMatch({ realtime: false, assignments: [
      { team: 'red', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: selected.id } },
    ] });
    const events: unknown[] = [];
    host.onUsage((event) => events.push(event));
    session.reportUsage(report);
    expect(events).toMatchObject([{ match: match.id, team: 'red', role: 'runner', report: { decisionId: 'turn_1', latencyMs: 125 } }]);
    expect(() => session.reportUsage(report)).toThrow();
    expect(() => session.reportUsage({ ...report, decisionId: 'turn_2', team: 'blue' } as never)).toThrow();
    expect(() => session.reportUsage({ ...report, decisionId: 'turn_2', inputTokens: -1 })).toThrow();
    expect(() => session.reportUsage({ ...report, decisionId: 'turn_2', reporter: 'estimated', pricingVersion: null })).toThrow();
    expect(events).toHaveLength(1);
    const commentary: unknown[] = [];
    match.onCommentary((event) => commentary.push(event));
    await session.control.say('Owner only');
    expect(commentary).toEqual([]);
    await session.control.say('Voluntary summary', { audience: 'observers', category: 'summary' });
    expect(commentary).toEqual([{ team: 'red', role: 'runner', tick: 0, category: 'summary', text: 'Voluntary summary' }]);
  });
});
