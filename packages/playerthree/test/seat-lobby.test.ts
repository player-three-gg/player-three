import { afterEach, describe, expect, it } from 'vitest';
import { definition, manifest, type TagManifest } from '../examples/tag/index.ts';
import { LOBBY_INSTRUCTIONS, type LobbyState, type MatchWait, type SeatControl } from '../src/control.ts';
import { PlayerThreeError, createPlayerThreeHost } from '../src/host/index.ts';
import type { AgentSession, PlayerThreeHost, PlayerThreeTraceEvent } from '../src/host/types.ts';
import { defineManifest, type GameDefinition } from '../src/manifest.ts';
import { t } from '../src/schema.ts';

const ALICE = 'alice_owner_0001';
const BOB = 'bob_owner_000002';
const TEAMS = ['blue', 'red'] as const;

/** Tag with a declared pre-match summary (manifest.lobby). */
const lobbyManifest = defineManifest({ ...manifest, lobby: t.obj({ arena: t.enum(['small', 'large']), captures: t.int(1, 9) }, 'the match you are seated for') });
const lobbyDefinition = { ...definition, manifest: lobbyManifest } as unknown as GameDefinition<TagManifest>;

let host: PlayerThreeHost<TagManifest> | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
});

function newHost(def: GameDefinition<TagManifest> = definition): PlayerThreeHost<TagManifest> {
  host = createPlayerThreeHost({ definition: def });
  return host;
}

function agentCommander(h: PlayerThreeHost<TagManifest>, owner: string, name: string, independentSessions = true): { id: string; control: SeatControl } {
  h.commanders.ensure(owner);
  const id = h.commanders.create(owner, { name, kind: 'agent', roles: ['runner'], isolation: { independentSessions } }).id;
  const session = h.agentSession(h.commanders.token(owner, id), 'runner') as Extract<AgentSession, { kind: 'commander' }>;
  return { id, control: session.control };
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

describe('pre-match lobby phase', () => {
  it('a game lobby reservation shows the seat, summary and start; ready carries into the held match; the wait returns the first observation at the start', async () => {
    const h = newHost(lobbyDefinition);
    const { id, control } = agentCommander(h, ALICE, 'Runner');
    const summary = { arena: 'small', captures: 3 };
    expect(() => h.commanders.reserve(ALICE, id, 'runner', { team: 'blue', match: { arena: 'huge' }, start: { kind: 'host' } })).toThrow(PlayerThreeError);
    expect(() => h.commanders.reserve(ALICE, id, 'runner', { team: 'green', start: { kind: 'host' } })).toThrow(PlayerThreeError);

    // A waiting agent learns its seat the moment the lobby reserves it.
    const waiting = control.wait({ seconds: 30 });
    h.commanders.reserve(ALICE, id, 'runner', { team: 'blue', match: summary, start: { kind: 'host' } });
    const seated = await waiting as LobbyState;
    expect(seated).toEqual({ phase: 'lobby', seat: { team: 'blue', role: 'runner' }, match: summary, you: { ready: false }, startsWhen: { kind: 'host' }, instruction: expect.stringContaining('game_ready') });
    expect(h.commanders.roster(ALICE)[0]!.reservations).toEqual([{ team: 'blue', role: 'runner', ready: false }]);
    expect(await control.ready()).toMatchObject({ phase: 'lobby', you: { ready: true }, instruction: expect.stringContaining('game_wait') });
    expect(h.commanders.roster(ALICE)[0]!.reservations).toEqual([{ team: 'blue', role: 'runner', ready: true }]);
    // A summary or start update keeps the mark; a different seat resets it.
    h.commanders.reserve(ALICE, id, 'runner', { team: 'blue', match: summary, start: { kind: 'countdown', at: Date.now() + 5_000 } });
    expect(await control.observe()).toMatchObject({ you: { ready: true }, startsWhen: { kind: 'countdown', inSeconds: 5 } });

    // The lobby starts its match held at tick 0: the ready agent stays ready and its wait blocks until the start.
    const pending = control.wait({ seconds: 30 });
    let done = false;
    void pending.then(() => (done = true));
    const match = h.createMatch({ seed: 4, realtime: false, readySeconds: 60, lobby: summary, assignments: [{ team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id } }] });
    // The game's preparation gate, established synchronously before agents reach the held match.
    match.holdStart();
    match.setLobbyStart({ kind: 'countdown', at: Date.now() + 3_000 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(done).toBe(false);
    expect(match.status('blue', 'runner').phase).toBe('lobby');
    expect(await control.observe()).toEqual({ phase: 'lobby', seat: { team: 'blue', role: 'runner' }, match: summary, you: { ready: true }, startsWhen: { kind: 'countdown', inSeconds: 3 }, instruction: expect.any(String) });
    expect(match.readiness().seats.find((s) => s.team === 'blue' && s.role === 'runner')?.state).toBe('ready');
    expect(await code(control.act([{ kind: 'stop' }]))).toBe('paused');
    match.skipReadyCheck();
    const entry = await pending as MatchWait;
    expect(entry).toEqual({ phase: 'match', tick: 0, outcome: 'running', events: [], observation: expect.objectContaining({ tick: 0, team: 'blue' }), instruction: expect.any(String) });
    expect(await control.act([{ kind: 'stop' }])).toEqual([{ ok: true }]);
    // Once the match ends the reservation is used up.
    match.end('draw');
    expect(h.commanders.roster(ALICE)[0]!.reservations).toEqual([]);
  });

  it('tells a lane with policy scope and no active policy to deploy first, until a policy or a pending proposal exists', async () => {
    const h = newHost();
    const { id, control } = agentCommander(h, ALICE, 'Runner');
    expect(await control.observe()).toMatchObject({ seat: null, instruction: LOBBY_INSTRUCTIONS.noPolicy });
    // Seated and ready: still nothing of the agent's would play the seat.
    h.commanders.reserve(ALICE, id, 'runner', { team: 'blue', start: { kind: 'host' } });
    expect(await control.ready()).toMatchObject({ seat: { team: 'blue', role: 'runner' }, you: { ready: true }, instruction: LOBBY_INSTRUCTIONS.noPolicy });
    // A pending supervised proposal is the deploy step taken; a rejected one is not.
    h.commanders.update(ALICE, id, { mandate: { autonomy: 'supervised' } });
    const proposed = await control.policyDeploy({ runtime: 'js', code: 'function think() { return []; }' });
    if (!('approval' in proposed)) throw new Error('Expected approval request');
    expect(await control.observe()).toMatchObject({ instruction: LOBBY_INSTRUCTIONS.ready });
    await h.commanders.resolveApproval(ALICE, id, proposed.approval.id, false);
    expect(await control.observe()).toMatchObject({ instruction: LOBBY_INSTRUCTIONS.noPolicy });
    // Without policy scope the agent cannot deploy: the usual next step.
    h.commanders.update(ALICE, id, { scopes: ['act'] });
    expect(await control.observe()).toMatchObject({ instruction: LOBBY_INSTRUCTIONS.ready });
    h.commanders.update(ALICE, id, { scopes: ['act', 'policy'], mandate: { autonomy: 'autonomous' } });
    expect(await control.policyDeploy({ runtime: 'js', code: 'function think() { return []; }' })).toMatchObject({ ok: true, version: 1 });
    expect(await control.observe()).toMatchObject({ instruction: LOBBY_INSTRUCTIONS.ready });
  });

  it('an exact-seat agent in a ready-check match: online, then ready; the deadline wait runs on the wall clock', async () => {
    const h = newHost();
    const match = h.createMatch({ seed: 1, realtime: false, readySeconds: 60, controllers: { blue: { runner: 'agent' } }, assignments: [{ team: 'blue', role: 'runner', owner: ALICE, kind: 'agent' }] });
    const agent = h.seatControl(match.mintSeatToken('blue', 'runner'))!;
    expect(match.readiness().seats.find((s) => s.team === 'blue' && s.role === 'runner')?.state).toBe('absent');
    const brief = await agent.briefing();
    expect(brief).toMatchObject({ phase: 'lobby', seat: { team: 'blue', role: 'runner' } });
    expect(match.readiness().seats.find((s) => s.team === 'blue' && s.role === 'runner')?.state).toBe('online');
    // No game time passes before the start: a lobby-phase wait ends after its wall-clock seconds with the lobby state.
    expect(await agent.wait({ seconds: 0.05 })).toMatchObject({ phase: 'lobby', seat: { team: 'blue', role: 'runner' }, you: { ready: false }, startsWhen: { kind: 'ready', inSeconds: 60 } });
    const pending = agent.wait({ seconds: 30 });
    expect(await agent.ready()).toMatchObject({ phase: 'lobby', you: { ready: true } });
    // Every assigned seat is ready: the ready check releases the hold and the wait returns the match entry.
    expect(match.readyCheck()?.pending).toBe(false);
    expect(await pending).toMatchObject({ phase: 'match', tick: 0, observation: { team: 'blue' } });
    expect(await agent.ready()).toEqual({ phase: 'match', you: { ready: true } });
    // Owners declare their own readiness through the game, not the agent control plane.
    expect(await code(match.seat('blue', 'runner').ready())).toBe('forbidden');
  });

  it('validates the pre-match summary and start description', () => {
    expect(() => newHost().createMatch({ realtime: false, lobby: { arena: 'small', captures: 1 } })).toThrow(PlayerThreeError);
    const h = newHost(lobbyDefinition);
    expect(() => h.createMatch({ realtime: false, lobby: { arena: 'small', captures: 0 } })).toThrow(PlayerThreeError);
    const match = h.createMatch({ realtime: false, lobby: { arena: 'large', captures: 2 } });
    expect(() => match.setLobbyStart({ kind: 'soon' } as never)).toThrow(PlayerThreeError);
    expect(() => match.setLobbyStart({ kind: 'ready', at: Number.NaN })).toThrow(PlayerThreeError);
    match.setLobbyStart(undefined);
  });

  it('reserves one commander on one team only: its roles may share a team, never span two', () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const { id } = h.commanders.create(ALICE, { name: 'Both roles', kind: 'agent', roles: ['runner', 'guard'], isolation: { independentSessions: true } });
    h.commanders.reserve(ALICE, id, 'runner', { team: 'blue', start: { kind: 'host' } });
    h.commanders.reserve(ALICE, id, 'guard', { team: 'blue', start: { kind: 'host' } });
    // The other team is refused, even for a lane of its own, and nothing changes.
    expect(() => h.commanders.reserve(ALICE, id, 'guard', { team: 'red', start: { kind: 'host' } })).toThrow(expect.objectContaining({ code: 'busy' }));
    expect(h.commanders.roster(ALICE)[0]!.reservations).toEqual([{ team: 'blue', role: 'runner', ready: false }, { team: 'blue', role: 'guard', ready: false }]);
    // Released first, the commander moves sides.
    h.commanders.reserve(ALICE, id, 'runner', null);
    h.commanders.reserve(ALICE, id, 'guard', { team: 'red', start: { kind: 'host' } });
    expect(h.commanders.roster(ALICE)[0]!.reservations).toEqual([{ team: 'red', role: 'guard', ready: false }]);
  });
});

describe('mid-match seat assignment', () => {
  for (const team of TEAMS) {
    it(`hands a running ${team} bot seat to a named commander: the bot stops, the agent gets its entry and acts next tick, and the hand-back detaches it`, async () => {
      const h = newHost();
      const { id, control } = agentCommander(h, ALICE, 'Runner');
      const traces: PlayerThreeTraceEvent[] = [];
      h.onTrace((e) => traces.push(e));
      const match = h.createMatch({ seed: 7, realtime: false });
      await match.step(20);
      const before = traces.filter((e) => e.type === 'intent' && e.team === team && e.role === 'runner' && e.source === 'bot').length;
      expect(before).toBeGreaterThan(0);
      // The agent waits in the lobby; the owner seats its commander mid-match.
      const waiting = control.wait({ seconds: 30 });
      match.assign({ team, role: 'runner', owner: ALICE, kind: 'agent', commander: { id } });
      const entry = await waiting as MatchWait;
      expect(entry).toMatchObject({ phase: 'match', tick: 20, outcome: 'running', events: [], observation: { tick: 20, team }, instruction: expect.any(String) });
      expect(h.commanders.roster(ALICE)[0]!.seated).toEqual({ match: match.id, team, roles: ['runner'] });
      expect((await control.briefing()).seat).toMatchObject({ team, role: 'runner' });
      expect(match.seats().find((s) => s.team === team && s.role === 'runner')).toMatchObject({ controller: 'agent', commander: true });
      expect(match.replay().entries.at(-1)).toEqual([20, team, 'runner', 'seat', 'agent', expect.any(Object)]);
      expect(match.readiness().seats.find((s) => s.team === team && s.role === 'runner')?.state).toBe('ready');

      // The agent acts at once and its intent plays on the next tick; the bot no longer submits for the seat.
      const mark = traces.length;
      expect(await control.act([{ kind: 'move', x: 8, y: 8 }])).toEqual([{ ok: true }]);
      await match.step(5);
      const after = traces.slice(mark).filter((e) => e.type === 'intent' && e.team === team && e.role === 'runner');
      expect(after.map((e) => e.type === 'intent' && e.source)).toEqual(['agent']);
      expect(match.replay().entries.filter((e) => e[3] === 'intent' && e[1] === team && e[2] === 'runner' && e[0] === 20)).toHaveLength(1);

      // Back to a bot: the commander is detached at once — its in-flight wait returns unseated, its calls leave the match.
      const inMatch = control.wait({ seconds: 30 });
      match.assign({ team, role: 'runner', owner: ALICE, kind: 'bot' });
      expect(await inMatch).toMatchObject({ phase: 'lobby', seat: null });
      expect(h.commanders.roster(ALICE)[0]!.seated).toBeNull();
      expect(await control.observe()).toMatchObject({ phase: 'lobby', seat: null });
      expect(await code(control.act([{ kind: 'stop' }]))).toBe('not_in_match');
      const handBack = traces.length;
      await match.step(2);
      expect(traces.slice(handBack).some((e) => e.type === 'intent' && e.team === team && e.role === 'runner' && e.source === 'bot')).toBe(true);
      expect(match.seats().find((s) => s.team === team && s.role === 'runner')).toMatchObject({ controller: 'bot' });
    });
  }

  it('revokes the previous exact-seat agent, keeps fog per team and enforces isolation and exclusivity', async () => {
    const h = newHost();
    const alice = agentCommander(h, ALICE, 'Alice runner', false);
    const second = agentCommander(h, ALICE, 'Alice second', false);
    const bob = agentCommander(h, BOB, 'Bob runner');
    const match = h.createMatch({ seed: 3, realtime: false, controllers: { blue: { runner: 'agent' } } });
    const token = match.mintSeatToken('blue', 'runner');
    const exact = h.seatControl(token)!;
    expect(await exact.observe()).toMatchObject({ team: 'blue' });
    match.assign({ team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice.id } });
    expect(h.seatControl(token)).toBeUndefined();
    expect(await code(exact.observe())).toBe('bad_token');
    // The commander sees only its team.
    expect(await alice.control.observe()).toMatchObject({ team: 'blue' });
    // One owner's agents on opposing teams need independent sessions; a commander seated elsewhere is busy.
    expect(() => match.assign({ team: 'red', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: second.id } })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => match.assign({ team: 'red', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice.id } })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    const other = h.createMatch({ seed: 4, realtime: false });
    expect(() => other.assign({ team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice.id } })).toThrow(expect.objectContaining({ code: 'busy' }));
    expect(() => match.assign({ team: 'red', role: 'runner', owner: BOB, kind: 'policy', commander: { id: bob.id } })).toThrow(expect.objectContaining({ code: 'invalid' }));
    // A failed hand-over changes nothing.
    expect(match.seats().find((s) => s.team === 'red' && s.role === 'runner')).toMatchObject({ controller: 'bot' });
    match.assign({ team: 'red', role: 'runner', owner: BOB, kind: 'agent', commander: { id: bob.id } });
    expect(await bob.control.observe()).toMatchObject({ team: 'red' });
    // Re-assigning the same occupant is a no-op.
    match.assign({ team: 'red', role: 'runner', owner: BOB, kind: 'agent', commander: { id: bob.id } });
    expect(await bob.control.observe()).toMatchObject({ team: 'red' });
    match.end('draw');
    expect(() => match.assign({ team: 'red', role: 'runner', owner: BOB, kind: 'bot' })).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('never seats one commander on both teams, by createMatch or a hand-over', () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const { id } = h.commanders.create(ALICE, { name: 'Both roles', kind: 'agent', roles: ['runner', 'guard'], isolation: { independentSessions: true } });
    expect(() => h.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id } },
      { team: 'red', role: 'guard', owner: ALICE, kind: 'agent', commander: { id } },
    ] })).toThrow(PlayerThreeError);
    const match = h.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id } }] });
    // Several roles of one team are fine; the other team is busy and the seat keeps its bot.
    match.assign({ team: 'blue', role: 'guard', owner: ALICE, kind: 'agent', commander: { id } });
    expect(() => match.assign({ team: 'red', role: 'guard', owner: ALICE, kind: 'agent', commander: { id } })).toThrow(expect.objectContaining({ code: 'busy' }));
    expect(match.seats().find((s) => s.team === 'red' && s.role === 'guard')).toMatchObject({ controller: 'bot' });
    expect(h.commanders.roster(ALICE)[0]!.seated).toEqual({ match: match.id, team: 'blue', roles: ['runner', 'guard'] });
  });

  it('an owner’s own commanders on opposing teams are marked self-play for good: no record, a marked history record', () => {
    const h = newHost();
    const alice = agentCommander(h, ALICE, 'Alice blue');
    const opponent = agentCommander(h, ALICE, 'Alice red');
    const bob = agentCommander(h, BOB, 'Bob red');
    const fair = h.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice.id } },
      { team: 'red', role: 'runner', owner: BOB, kind: 'agent', commander: { id: bob.id } },
    ] });
    expect(fair.sameOwnerOpposed).toBe(false);
    fair.end({ blue: 'win', red: 'loss' });
    fair.dispose();
    expect(h.history.get(fair.id)?.sameOwnerOpposed).toBe(false);
    expect(h.commanders.roster(ALICE).find((c) => c.id === alice.id)!.record).toEqual({ wins: 1, losses: 0, draws: 0 });

    // Distinct isolated commanders of one owner may face each other (practice), and a bot opponent is no owner's play.
    const practice = h.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice.id } },
      { team: 'red', role: 'runner', owner: ALICE, kind: 'bot' },
    ] });
    expect(practice.sameOwnerOpposed).toBe(false);
    practice.assign({ team: 'red', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: opponent.id } });
    expect(practice.sameOwnerOpposed).toBe(true);
    // Handing the opposing seat away again does not launder the match.
    practice.assign({ team: 'red', role: 'runner', owner: BOB, kind: 'agent', commander: { id: bob.id } });
    expect(practice.sameOwnerOpposed).toBe(true);
    practice.end({ blue: 'win', red: 'loss' });
    practice.dispose();
    expect(h.history.get(practice.id)?.sameOwnerOpposed).toBe(true);
    expect(h.commanders.roster(ALICE).find((c) => c.id === alice.id)!.record).toEqual({ wins: 1, losses: 0, draws: 0 });
    expect(h.commanders.roster(BOB)[0]!.record).toEqual({ wins: 0, losses: 1, draws: 0 });
  });
});
