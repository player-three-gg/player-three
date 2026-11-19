import { afterEach, describe, expect, it } from 'vitest';
import { ackCode, createPlayerConsole, estimateTokens, mergeTrace, type PlayerConsole, type PlayerConsoleOptions, type PlayerStateWire } from '../src/index.ts';
import { TOKEN, commander, fakeApi, intent, matchState, seat, settle, type FakeApi } from './fake.ts';

const consoles: PlayerConsole[] = [];
afterEach(() => {
  for (const c of consoles.splice(0)) c.stop();
});

function open(api: FakeApi, extra: Partial<PlayerConsoleOptions> = {}): PlayerConsole {
  const c = createPlayerConsole({ credential: TOKEN, fetch: api.fetch, pollMs: 60_000, ...extra });
  consoles.push(c);
  return c;
}

describe('player console client', () => {
  it('normalizes the own seats: status, mandate, approvals, intents with ack codes, policy errors, logs and the token estimate', async () => {
    const api = fakeApi();
    const c = open(api, { pricePerMTok: 3, stream: false });
    await c.refresh();
    const s = c.snapshot;
    expect(s).toMatchObject({ status: 'live', phase: 'match', match: 'm1', team: 'blue', tick: 40, outcome: 'running', game: { id: 'tag', title: 'Tag' } });
    expect(s.seats.map((x) => x.role)).toEqual(['runner', 'guard']);

    const runner = s.seats[0]!;
    expect(runner).toMatchObject({ controller: 'agent', live: true, present: true, readiness: 'ready', scopes: ['act', 'policy', 'practice'], limits: { asteroidDrops: false, collapses: true } });
    expect(runner.mandate).toMatchObject({ autonomy: 'supervised', whenAbsent: 'policy' });
    // Newest first, closed codes only (rejected input is never part of the trace).
    expect(runner.intents.map((i) => [i.tick, i.kind, i.code])).toEqual([[13, null, 'invalid'], [12, null, 'no_energy'], [11, null, 'invalid'], [10, 'move', 'ok']]);
    expect(runner.rejections).toEqual([{ code: 'invalid', count: 2 }, { code: 'no_energy', count: 1 }]);
    // 1000 bytes / 4 = 250 tokens; at 3 per million tokens.
    expect(runner.observation).toEqual({ at: 30, tick: 30, bytes: 1000, tokens: 250, cost: 0.00075 });
    // null policy status: the game has no policy mode for this seat.
    expect(runner.policy).toBeNull();

    const guard = s.seats[1]!;
    expect(guard).toMatchObject({ controller: 'policy', present: false, approvals: [{ role: 'guard', approval: { id: 'ap1', kind: 'policyDeploy', version: 3, status: 'pending' } }], logs: ['hello', 'world'] });
    expect(guard.policy).toMatchObject({ version: 2, runtime: 'js', calls: 10, errors: 2, timeouts: 1 });
    expect(guard.errors.map((e) => [e.phase, e.code, e.message])).toEqual([
      ['call', 'timeout', undefined],
      ['deploy', 'compile', 'SyntaxError'],
      ['call', 'threw', 'boom at think'],
    ]);
    expect(guard.observation).toBeNull();
  });

  it('follows the live stream between polls without duplicating events the next poll returns', async () => {
    const api = fakeApi();
    const c = open(api);
    let notified = 0;
    c.subscribe(() => notified++);
    c.start();
    await settle();
    expect(api.streams).toBe(1);
    expect(c.snapshot.streaming).toBe(true);

    const fresh = intent('runner', 50, { ok: false, code: 'rate_limited' });
    api.push('trace', fresh);
    api.push('trace', { type: 'observe', at: 51, match: 'm1', tick: 51, team: 'blue', role: 'guard', source: 'policy', bytes: 400 });
    api.push('status', { tick: 52, outcome: 'running', seats: [seat('runner', { agentActive: false }), seat('guard')], readiness: { runner: 'waiting', guard: 'policy_failed' } });
    await settle();
    let s = c.snapshot;
    expect(s.tick).toBe(52);
    expect(s.seats[0]!.present).toBe(false);
    expect(s.seats.map((seat) => seat.readiness)).toEqual(['waiting', 'policy_failed']);
    expect(s.seats[0]!.intents[0]).toMatchObject({ tick: 50, code: 'rate_limited' });
    expect(s.seats[1]!.observation).toMatchObject({ bytes: 400, tokens: 100, cost: null });
    expect(notified).toBeGreaterThan(2);

    // The server has recorded it too: the next snapshot holds it once.
    const st = api.state as PlayerStateWire;
    st.events.push(fresh);
    await c.refresh();
    s = c.snapshot;
    expect(s.seats[0]!.intents.filter((i) => i.code === 'rate_limited')).toHaveLength(1);
    // The fresher streamed observation is kept over the older snapshot one.
    expect(s.seats[1]!.observation?.bytes).toBe(400);
  });

  it('keeps multiple same-role commanders distinct and teamless in the lobby', async () => {
    const api = fakeApi({ ...matchState(), match: null, team: null, tick: 0, outcome: null, seats: [], observations: {}, policies: {}, calls: {}, events: [], commanders: [
      commander('deepseek', { name: 'DeepSeek' }),
      commander('claude', { name: 'Claude', roles: ['runner', 'guard'], connected: true, seated: { match: 'm1', team: 'red', roles: ['runner', 'guard'] }, approvals: [
        { role: 'runner', approval: { id: 'ap9', kind: 'publish', version: 4, status: 'pending' } },
        { role: 'guard', approval: { id: 'ap10', kind: 'policyDeploy', version: 5, status: 'pending' } },
      ] }),
    ] });
    const c = open(api);
    c.start();
    await settle();
    const s = c.snapshot;
    expect(s.phase).toBe('lobby');
    expect(api.streams).toBe(0);
    expect(s.seats.map((x) => [x.commander, x.name, x.roles, x.role, x.team, x.controller])).toEqual([
      ['deepseek', 'DeepSeek', ['runner'], null, null, 'agent'],
      ['claude', 'Claude', ['runner', 'guard'], null, null, 'agent'],
    ]);
    expect(s.seats[0]!.target).toEqual({ kind: 'commander', commander: 'deepseek' });
    expect(s.seats[0]!.policy).toEqual({ version: 4, versions: 4 });
    expect(s.seats[0]!.practice).toEqual([{ at: 99, role: 'runner', opponent: 'novice', ticks: 600, seed: 7, outcome: 'win', version: 4 }]);
    expect(s.seats[1]!.approvals).toMatchObject([
      { role: 'runner', approval: { id: 'ap9', kind: 'publish' } },
      { role: 'guard', approval: { id: 'ap10', kind: 'policyDeploy' } },
    ]);
  });

  it('sends the named exact target and clears lane history when the selection changes', async () => {
    let target = { commander: 'deepseek', match: 'm1', team: 'blue', role: 'runner' };
    const api = fakeApi({ ...matchState(), target, commanders: [commander('deepseek', { roles: ['runner', 'guard'], approvals: [
      { role: 'runner', approval: { id: 'runner-pending', kind: 'publish', version: 4, status: 'pending' } },
      { role: 'guard', approval: { id: 'guard-private', kind: 'publish', version: 4, status: 'pending' } },
    ] })], seats: [seat('runner')] });
    const c = open(api, { target: () => target, stream: false });
    await c.refresh();
    expect(api.requests[0]).toContain('/state?commander=deepseek&match=m1&team=blue&role=runner');
    expect(c.snapshot.seats[0]!.target).toEqual({ kind: 'commander', commander: 'deepseek', seat: { match: 'm1', team: 'blue', role: 'runner' } });
    expect(c.snapshot.seats[0]!.approvals.map((entry) => entry.approval.id)).toEqual(['runner-pending']);
    target = { commander: 'claude', match: 'm1', team: 'red', role: 'runner' };
    api.state = { ...matchState(), target, team: 'red', commanders: [commander('claude')], seats: [seat('runner', { team: 'red' })], observations: {}, events: [], calls: {} };
    await c.refresh();
    expect(c.snapshot.seats[0]).toMatchObject({ commander: 'claude', team: 'red', intents: [], observation: null });
    expect(api.requests[1]).toContain('commander=claude&match=m1&team=red&role=runner');
  });

  it('reports closed error codes and never sends a request without a credential', async () => {
    const api = fakeApi();
    const bad = open(api, { credential: 'not-the-owner' });
    await bad.refresh();
    expect(bad.snapshot).toMatchObject({ status: 'error', error: 'bad_token' });

    const none = createPlayerConsole({ credential: () => undefined, fetch: api.fetch });
    consoles.push(none);
    const before = api.requests.length;
    await none.refresh();
    expect(none.snapshot).toMatchObject({ status: 'error', error: 'no_credential' });
    expect(api.requests.length).toBe(before);

    api.state = { status: 500, error: 'Internal <b>' };
    const c = open(api);
    await c.refresh();
    expect(c.snapshot.error).toBe('http_500');
  });
});

describe('helpers', () => {
  it('ackCode, estimateTokens and mergeTrace', () => {
    expect(ackCode({ ok: true })).toBe('ok');
    expect(ackCode({ ok: false, code: 'game', gameCode: 'mandate_limit' })).toBe('mandate_limit');
    expect(ackCode({ ok: false, code: 'out_of_scope' })).toBe('out_of_scope');
    expect(estimateTokens(1001)).toBe(251);
    expect(estimateTokens(1000, 3)).toBe(334);
    const a = intent('runner', 1, { ok: true });
    const b = intent('runner', 2, { ok: true });
    // Two identical events are two occurrences; one already in the snapshot is not added again.
    expect(mergeTrace([a, b], [b, b])).toEqual([a, b, b]);
  });
});
