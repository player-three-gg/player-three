import { afterEach, describe, expect, it, vi } from 'vitest';
import { definition as tag } from '../examples/tag/index.ts';
import type { Mandate, PauseInfo } from '../src/control.ts';
import { PlayerThreeError, createPlayerThreeHost, replayMatch } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeTraceEvent, ReplayEntry } from '../src/host/types.ts';
import { defineManifest, type GameAdapter, type GameDefinition, type Seat } from '../src/manifest.ts';
import { t } from '../src/schema.ts';

/** Tiny single-side game: each `add` intent adds `n` to a running total; ticks are turns. */
function countManifest(control: { pausable?: { maxPauseSeconds?: number } }) {
  return defineManifest({
    id: 'count',
    version: '1.0.0',
    title: 'Count',
    doc: 'Add to a running total, one turn per tick.',
    roleDocs: { player: 'Adds.' },
    tickRate: 10,
    teams: t.enum(['solo']),
    roles: t.enum(['player']),
    intents: { add: { roles: ['player'], params: { n: t.int(1, 3) }, doc: 'Add n.' } },
    observation: t.obj({ tick: t.int(0, 1_000_000), total: t.int(0, 1_000_000) }),
    view: t.obj({ tick: t.int(0, 1_000_000), total: t.int(0, 1_000_000) }),
    directive: t.obj({ style: t.enum(['steady']) }),
    errors: t.enum(['full']),
    opponents: t.enum(['easy']),
    report: t.obj({ total: t.int(0, 1_000_000) }),
    event: t.obj({ tick: t.int(0, 1_000_000), kind: t.enum(['added']) }),
    skills: [],
    topics: {},
    control: { intents: { perSecond: 100, burst: 100 }, ...control },
  });
}

const pausable = countManifest({ pausable: { maxPauseSeconds: 60 } });
type Count = typeof pausable;

class CountGame {
  readonly manifest = pausable;
  tick = 0;
  total = 0;
  added: number[] = [];
  step(): void { this.tick++; }
  outcome(): 'running' { return 'running'; }
  view() { return { tick: this.tick, total: this.total }; }
  observe() { return { tick: this.tick, total: this.total }; }
  apply(_seat: Seat<Count>, intent: { n: number }) {
    this.total += intent.n;
    this.added.push(this.tick);
    return { ok: true as const };
  }
  report() { return { total: this.total }; }
  events(_seat: Seat<Count>, since: number) { return this.added.filter((tick) => tick > since).slice(-20).map((tick) => ({ tick, kind: 'added' as const })); }
  setSeatInfo(): void {}
  clone(): CountGame {
    const copy = new CountGame();
    copy.tick = this.tick;
    copy.total = this.total;
    copy.added = [...this.added];
    return copy;
  }
}

function countDefinition(manifest: Count = pausable, cloneable = true): GameDefinition<Count> {
  return {
    manifest,
    create: () => {
      const game = new CountGame();
      if (!cloneable) Object.defineProperty(game, 'clone', { value: undefined });
      return game as unknown as GameAdapter<Count>;
    },
    createBot: () => ({ think: () => [{ kind: 'add', n: 1 }] }),
  };
}

const mandate = (whenAbsent: Mandate['whenAbsent']) => ({ autonomy: 'autonomous' as const, directive: { style: 'steady' as const }, whenAbsent });
function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof PlayerThreeError ? e.code : 'other';
  }
  return undefined;
}

let host: PlayerThreeHost<Count> | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
  vi.useRealTimers();
});

/** A paused-capable seat whose agent has just called (present), then the owner chooses `whenAbsent: 'pause'`. */
async function agentSession() {
  vi.useFakeTimers({ now: 1_000_000 });
  host = createPlayerThreeHost({ definition: countDefinition() });
  const traces: PlayerThreeTraceEvent[] = [];
  host.onTrace((e) => {
    if (e.type === 'pause' || e.type === 'resume') traces.push(e);
  });
  const match = host.createMatch({ seed: 1, realtime: false, controllers: { solo: { player: 'agent' } } });
  const agent = host.seatControl(match.mintSeatToken('solo', 'player'))!;
  await agent.briefing();
  match.setMandate('solo', 'player', mandate('pause'));
  return { match, agent, traces };
}

const pauseEntries = (entries: ReplayEntry[]) => entries.filter((e) => e[3] === 'pause' || e[3] === 'resume').map((e) => [e[0], e[3], e[4]]);

describe('whenAbsent: pause', () => {
  it('is rejected unless the game declares control.pausable', () => {
    const tagHost = createPlayerThreeHost({ definition: tag });
    try {
      const match = tagHost.createMatch({ realtime: false });
      expect(code(() => match.setMandate('blue', 'runner', { autonomy: 'autonomous', directive: { stance: 'attack' }, whenAbsent: 'pause' as never }))).toBe('invalid');
      tagHost.commanders.ensure('alice_owner_0001');
      const commander = tagHost.commanders.create('alice_owner_0001', { name: 'Tag runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
      expect(code(() => tagHost.commanders.update('alice_owner_0001', commander, { mandate: { whenAbsent: 'pause' } }))).toBe('invalid');
    } finally {
      tagHost.dispose();
    }
    expect(() => countManifest({ pausable: { maxPauseSeconds: 0 } })).toThrow(/maxPauseSeconds/);
    expect(() => countManifest({ pausable: { maxPause: 5 } as never })).toThrow(/unknown field/);
    host = createPlayerThreeHost({ definition: countDefinition() });
    host.commanders.ensure('alice_owner_0001');
    const commander = host.commanders.create('alice_owner_0001', { name: 'Counter', kind: 'agent', roles: ['player'], isolation: { independentSessions: true } }).id;
    expect(host.commanders.update('alice_owner_0001', commander, { mandate: { whenAbsent: 'pause' } }).mandate.whenAbsent).toBe('pause');
  });

  it('stops the clock while the agent is absent, resumes on its next call, and replays the pauses', async () => {
    const { match, agent, traces } = await agentSession();
    expect(await agent.act([{ kind: 'add', n: 2 }])).toEqual([{ ok: true }]);
    await match.step(3);
    expect(match.paused()).toBeUndefined();

    vi.setSystemTime(1_031_000);
    expect(code(() => match.step())).toBe('paused');
    const since = 1_031_000;
    const paused: PauseInfo = { tick: 3, since, seats: [{ team: 'solo', role: 'player', reason: 'agent_absent', tick: 3, since, until: since + 60_000 }] };
    expect(match.paused()).toEqual(paused);
    expect(match.seats()[0]).toMatchObject({ controller: 'agent', agentActive: false, pause: { reason: 'agent_absent', tick: 3, since, until: since + 60_000 } });
    expect(match.status('solo', 'player').paused).toEqual(paused);
    expect(match.tick).toBe(3);

    // Any call by the agent resumes the session at this tick boundary; the briefing shows the mode and mandate.
    expect(await agent.briefing()).toMatchObject({ mandate: { whenAbsent: 'pause' } });
    expect((await agent.briefing('modes')).text).toContain('at most 60 s');
    expect(match.paused()).toBeUndefined();
    expect(match.seats()[0]!.pause).toBeUndefined();
    await match.step(2);
    expect(match.tick).toBe(5);

    // Absent again: paused at tick 5 until the replay ends.
    vi.setSystemTime(1_070_000);
    expect(code(() => match.step())).toBe('paused');
    expect(traces.map((e) => [e.tick, e.type, 'reason' in e ? e.reason : undefined])).toEqual([[3, 'pause', 'agent_absent'], [3, 'resume', 'present'], [5, 'pause', 'agent_absent']]);
    const replay = match.replay();
    expect(pauseEntries(replay.entries)).toEqual([[3, 'pause', 'agent_absent'], [3, 'resume', 'present'], [5, 'pause', 'agent_absent']]);
    const at3 = replayMatch(countDefinition(), replay, 3);
    expect(at3.paused).toEqual([]);
    const end = replayMatch(countDefinition(), replay);
    expect(end.paused).toEqual([{ team: 'solo', role: 'player' }]);
    expect(end.adapter.view('solo')).toEqual(match.view('solo'));
  });

  it('a realtime session stands still while paused and resumes when the owner changes the mandate', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    host = createPlayerThreeHost({ definition: countDefinition() });
    const match = host.createMatch({ seed: 2, controllers: { solo: { player: 'agent' } } });
    match.setMandate('solo', 'player', mandate('pause'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(match.paused()).toMatchObject({ tick: 0 });
    expect(match.tick).toBe(0);
    match.setMandate('solo', 'player', mandate('hold'));
    expect(match.paused()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(match.tick).toBeGreaterThan(5);
    expect(pauseEntries(match.replay().entries)).toEqual([[0, 'pause', 'agent_absent'], [0, 'resume', 'owner']]);
  });

  it('falls back to the bot after max pause, ends waits on wall-clock time, and pauses again after the agent returns', async () => {
    const { match, agent } = await agentSession();
    vi.setSystemTime(1_040_000);
    expect(code(() => match.step())).toBe('paused');
    // An owner wait measures wall-clock time while game time stands still.
    const waiting = match.seat('solo', 'player').wait({ seconds: 5 });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(waiting).resolves.toMatchObject({ tick: 0, outcome: 'running' });

    await vi.advanceTimersByTimeAsync(55_000);
    expect(match.paused()).toBeUndefined();
    expect(match.seats()[0]).toMatchObject({ controller: 'agent', agentActive: false });
    await match.step(3);
    expect(match.tick).toBe(3);
    expect(match.replay().entries.filter((e) => e[3] === 'intent').map((e) => e[0])).toEqual([0, 1, 2]);
    expect(pauseEntries(match.replay().entries)).toEqual([[0, 'pause', 'agent_absent'], [0, 'resume', 'timeout']]);

    await agent.observe();
    vi.setSystemTime(Date.now() + 31_000);
    expect(code(() => match.step())).toBe('paused');
    expect(match.paused()).toMatchObject({ tick: 3 });
    expect((replayMatch(countDefinition(), match.replay()).adapter as unknown as CountGame).total).toBe(3);
  });
});

describe('persistent sessions', () => {
  it('never ends, keeps a rolling replay window and stays scrubbable inside it', async () => {
    const definition = countDefinition();
    const referenceHost = createPlayerThreeHost({ definition });
    const reference = referenceHost.createMatch({ seed: 7, realtime: false });
    await reference.step(100);
    host = createPlayerThreeHost({ definition });
    const match = host.createMatch({ seed: 7, realtime: false, persistent: { checkpointTicks: 10, checkpoints: 3 } });
    await match.step(100);
    expect([match.persistent, reference.persistent]).toEqual([true, false]);
    expect(match.outcome('solo')).toBe('running');
    expect(match.over).toBe(false);
    expect(code(() => match.end('draw'))).toBe('invalid');

    const replay = match.replay();
    // Checkpoints at ticks 80, 90 and 100 are kept: the seat entry and the intents of ticks 0–79 were dropped.
    expect(replay.window).toEqual({ from: 80, dropped: 81 });
    expect(replay.entries.map((e) => e[0])).toEqual(Array.from({ length: 20 }, (_, i) => 80 + i));
    expect(replay.outcomes).toEqual({ solo: 'running' });

    for (const tick of [80, 85, 99, 100]) {
      const scrubbed = replayMatch(definition, replay, tick, match.checkpoint(tick));
      expect(scrubbed.adapter.view('solo')).toEqual(replayMatch(definition, reference.replay(), tick).adapter.view('solo'));
    }
    referenceHost.dispose();
    expect(replayMatch(definition, replay, 100, match.checkpoint()).adapter.view('solo')).toEqual(match.view('solo'));
    expect(match.checkpoint(79)).toBeUndefined();
    expect(() => replayMatch(definition, replay, 79, match.checkpoint())).toThrow(/invalid target tick/);
    expect(() => replayMatch(definition, replay)).toThrow(/starts at a checkpoint/);

    // Retention stays bounded however long the session runs.
    await match.step(900);
    expect(match.replay().window).toEqual({ from: 980, dropped: 981 });
    expect(match.replay().entries).toHaveLength(20);
  });

  it('leaves commander results alone and requires adapter clone()', async () => {
    host = createPlayerThreeHost({ definition: countDefinition() });
    host.commanders.ensure('alice_owner_0001');
    const commander = host.commanders.create('alice_owner_0001', { name: 'Counter', kind: 'agent', roles: ['player'], isolation: { independentSessions: true } }).id;
    const match = host.createMatch({ realtime: false, persistent: { checkpointTicks: 5, checkpoints: 2 }, assignments: [{ team: 'solo', role: 'player', owner: 'alice_owner_0001', kind: 'agent', commander: { id: commander } }] });
    await match.step(40);
    match.dispose();
    expect(host.commanders.roster('alice_owner_0001')[0]).toMatchObject({ record: { wins: 0, losses: 0, draws: 0 }, seated: null });

    expect(code(() => host!.createMatch({ realtime: false, persistent: { checkpointTicks: 0, checkpoints: 2 } }))).toBe('invalid');
    expect(code(() => host!.createMatch({ realtime: false, persistent: { checkpointTicks: 5, checkpoints: 1 } }))).toBe('invalid');
    const noClone = createPlayerThreeHost({ definition: countDefinition(pausable, false) });
    try {
      expect(() => noClone.createMatch({ realtime: false, persistent: { checkpointTicks: 5, checkpoints: 2 } })).toThrow(/clone/);
    } finally {
      noClone.dispose();
    }
  });
});
