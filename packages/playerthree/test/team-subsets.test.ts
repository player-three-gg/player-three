import { afterEach, describe, expect, it } from 'vitest';
import { definition as tag } from '../examples/tag/index.ts';
import { PlayerThreeError, createPlayerThreeHost, replayMatch } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeMatch, PlayerThreeTraceEvent, CreateMatchOptions, Replay } from '../src/host/types.ts';
import { games, quadDefinition, type QuadManifest } from './quad-fixture.ts';

let host: PlayerThreeHost<QuadManifest>;
afterEach(() => host?.dispose());

const OBSERVERS = { allowOmniscient: true, minDelayMs: 0, public: false } as const;

function setup(opts: CreateMatchOptions<QuadManifest> = {}, teams?: CreateMatchOptions<QuadManifest>['teams']): PlayerThreeMatch<QuadManifest> {
  host = createPlayerThreeHost({ definition: quadDefinition, ...(teams ? { teams } : {}) });
  return host.createMatch({ seed: 1, realtime: false, ...opts });
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof PlayerThreeError ? error.code : 'thrown';
  }
  return undefined;
};

describe('match teams', () => {
  it('a two-team match out of a four-team manifest has only those seats, tokens, grants and outcomes', async () => {
    const ended: unknown[] = [];
    const match = setup({ teams: ['south', 'north'], observerPolicy: OBSERVERS });
    match.onEnd((outcomes, ranks) => ended.push({ outcomes, ranks }));
    const game = games.at(-1)!;
    expect(match.teams).toEqual(['north', 'south']);
    expect(match.alliances).toBeUndefined();
    expect(game.sides).toEqual({ teams: ['north', 'south'] });
    expect(match.seats().map((s) => s.team)).toEqual(['north', 'south']);
    expect(Object.keys(match.tokens.teams)).toEqual(['north', 'south']);
    expect(match.readiness().seats.map((s) => s.team)).toEqual(['north', 'south']);
    expect((await match.seat('north', 'pilot').briefing()).teams).toEqual(['north', 'south']);

    expect(code(() => match.mintSeatToken('east', 'pilot'))).toBe('invalid');
    expect(code(() => match.outcome('west'))).toBe('invalid');
    expect(code(() => match.view('east'))).toBe('invalid');
    expect(code(() => match.mintObserverToken({ kind: 'team', team: 'east', delayMs: 0 }, { owner: 'o' }))).toBe('invalid');
    expect(code(() => match.mintObserverToken({ kind: 'omniscient', teams: ['north', 'east', 'south', 'west'], delayMs: 0 }, { owner: 'o' }))).toBe('forbidden');
    expect(code(() => match.mintObserverToken({ kind: 'omniscient', teams: ['north', 'south'], delayMs: 0 }, { owner: 'o' }))).toBeUndefined();

    game.results.set('north', 'win').set('south', 'loss');
    await match.step(1);
    expect(match.over).toBe(true);
    expect(match.rank('north')).toBe(1);
    expect(match.rank('south')).toBe(2);
    expect(ended).toEqual([{ outcomes: { north: 'win', south: 'loss' }, ranks: { north: 1, south: 2 } }]);
    const replay = match.replay();
    expect(replay).toMatchObject({ teams: ['north', 'south'], outcomes: { north: 'win', south: 'loss' }, ranks: { north: 1, south: 2 } });
    expect(replay.alliances).toBeUndefined();
    match.dispose();
    expect(host.history.get(match.id)).toMatchObject({ teams: ['north', 'south'], alliances: null, outcomes: { north: 'win', south: 'loss' }, ranks: { north: 1, south: 2 } });
  });

  it('rejects unknown, duplicate and absent teams and options naming teams outside the match', () => {
    host = createPlayerThreeHost({ definition: quadDefinition });
    const create = (opts: CreateMatchOptions<QuadManifest>) => code(() => host.createMatch({ realtime: false, ...opts }));
    expect(create({ teams: ['north', 'nowhere' as 'east'] })).toBe('invalid');
    expect(create({ teams: ['north', 'north'] })).toBe('invalid');
    expect(create({ teams: [] })).toBe('invalid');
    expect(create({ teams: ['north', 'south'], controllers: { east: { pilot: 'agent' } } })).toBe('invalid');
    expect(create({ teams: ['north', 'south'], controllers: { north: { captain: 'agent' } } })).toBe('invalid');
    expect(create({ teams: ['north', 'south'], botLevel: { west: 'idle' } })).toBe('invalid');
    expect(create({ teams: ['north', 'south'], botSeats: [{ team: 'east', role: 'pilot', level: 'idle', options: {} }] })).toBe('invalid');
    expect(create({ teams: ['north', 'south'], assignments: [{ team: 'east', role: 'pilot', owner: 'alice', kind: 'human' }] })).toBe('invalid');
    expect(host.matches()).toHaveLength(0);
    expect(() => createPlayerThreeHost({ definition: quadDefinition, teams: ['north', 'up' as 'east'] })).toThrow(PlayerThreeError);
  });

  it('defaults to the host teams, else every manifest team', () => {
    expect(setup({}, ['west', 'east']).teams).toEqual(['east', 'west']);
    host.dispose();
    expect(setup().teams).toEqual(['north', 'east', 'south', 'west']);
  });

  it('a game that cannot play a side set refuses it', () => {
    const tagHost = createPlayerThreeHost({ definition: tag });
    try {
      expect(() => tagHost.createMatch({ realtime: false, teams: ['blue'] })).toThrow(/blue against red/);
      expect(tagHost.createMatch({ realtime: false }).teams).toEqual(['blue', 'red']);
    } finally {
      tagHost.dispose();
    }
  });

  it('replays recreate the game with the recorded sides', async () => {
    const match = setup({ teams: ['east', 'west'], alliances: { gold: ['west'], east: ['east'] } });
    await match.step(3);
    const replay = match.replay();
    expect(replay).toMatchObject({ teams: ['east', 'west'], alliances: { east: ['east'], gold: ['west'] } });
    replayMatch(quadDefinition, replay);
    expect(games.at(-1)!.sides).toEqual({ teams: ['east', 'west'], alliances: { east: ['east'], gold: ['west'] } });
    const { teams: _teams, ...missing } = replay;
    expect(() => replayMatch(quadDefinition, missing as Replay)).toThrow(/bad match sides/);
    expect(() => replayMatch(quadDefinition, { ...replay, teams: ['east', 'mars'] })).toThrow(/bad match sides/);
  });

  it('live practice plays the match sides', async () => {
    const match = setup({ teams: ['north', 'east', 'south'] });
    const result = await match.seat('east', 'pilot').practice({ opponent: 'idle', ticks: 3, artifact: { runtime: 'js', code: 'function think() { return []; }' } });
    expect(result).toMatchObject({ ok: true });
    expect(games.at(-1)!.sides).toEqual({ teams: ['north', 'east', 'south'] });
  });
});

describe('teams that are out', () => {
  it('a three-team match plays on after one team is final; that team is out', async () => {
    const traces: PlayerThreeTraceEvent[] = [];
    const match = setup({ teams: ['north', 'east', 'south'], botLevel: { north: 'pinger', east: 'pinger', south: 'pinger' } });
    host.onTrace((e) => traces.push(e));
    const game = games.at(-1)!;
    const east = match.seat('east', 'pilot');
    await match.step(2);
    expect(game.pings.get('east')).toBeGreaterThan(0);
    const waiting = east.wait({ seconds: 60 });

    game.results.set('east', 'loss');
    await match.step(1);
    expect(match.over).toBe(false);
    expect(match.outcome('east')).toBe('loss');
    expect(match.rank('east')).toBeNull();
    await expect(waiting).resolves.toMatchObject({ outcome: 'loss' });
    expect(await east.act([{ kind: 'ping' }])).toEqual([{ ok: false, code: 'game_over' }]);
    expect(await match.seat('north', 'pilot').act([{ kind: 'ping' }])).toEqual([{ ok: true }]);
    const pings = game.pings.get('east')!;
    const south = game.pings.get('south')!;
    // The kept outcome never changes, whatever the game reports later (running again: its game would accept pings).
    game.results.set('east', 'running');
    await match.step(3);
    expect(match.outcome('east')).toBe('loss');
    // Its bot no longer decides while the others play on.
    expect(game.pings.get('east')).toBe(pings);
    expect(game.pings.get('south')).toBe(south + 3);

    game.results.set('north', 'win').set('south', 'loss');
    await match.step(1);
    expect(match.over).toBe(true);
    // Ranked by outcome: one winner, the two losers share second place.
    expect([match.rank('north'), match.rank('east'), match.rank('south')]).toEqual([1, 2, 2]);
    expect(traces.filter((e) => e.type === 'match_ended')).toEqual([
      expect.objectContaining({ outcomes: { north: 'win', east: 'loss', south: 'loss' }, ranks: { north: 1, east: 2, south: 2 } }),
    ]);
  });

  it('uses the game ranks when they form a valid ranking, else ranks by outcome', async () => {
    const valid = setup({ teams: ['north', 'east', 'south', 'west'] });
    let game = games.at(-1)!;
    const placed = { north: 3, east: 1, south: 4, west: 2 };
    game.rank = (team) => placed[team];
    game.results.set('north', 'loss').set('east', 'win').set('south', 'loss').set('west', 'loss');
    await valid.step(1);
    expect(valid.teams.map((team) => valid.rank(team))).toEqual([3, 1, 4, 2]);
    host.dispose();

    const invalid = setup({ teams: ['north', 'east', 'south'] });
    game = games.at(-1)!;
    // 1, 3, 3 is not a competition ranking (the tied pair is second).
    game.rank = (team) => (team === 'north' ? 1 : 3);
    game.results.set('north', 'win').set('east', 'loss').set('south', 'loss');
    await invalid.step(1);
    expect(invalid.teams.map((team) => invalid.rank(team))).toEqual([1, 2, 2]);
  });

  it("end('draw') keeps the outcome of teams already out; contradicting it is invalid", async () => {
    const match = setup({ teams: ['north', 'east', 'south'] });
    const game = games.at(-1)!;
    game.results.set('east', 'loss');
    await match.step(1);
    expect(code(() => match.end({ north: 'loss', east: 'win', south: 'loss' }))).toBe('invalid');
    expect(match.over).toBe(false);
    expect(match.end('draw')).toEqual({ north: 'draw', east: 'loss', south: 'draw' });
    expect([match.rank('north'), match.rank('east'), match.rank('south')]).toEqual([1, 3, 1]);
    expect(game.ended).toEqual({ outcomes: { north: 'draw', east: 'loss', south: 'draw' }, ranks: { north: 1, east: 3, south: 1 } });
  });
});

describe('free-for-all placements', () => {
  it('end() with placements orders a four-team free-for-all', () => {
    const match = setup();
    const game = games.at(-1)!;
    expect(match.end({ north: 2, east: 1, south: 4, west: 3 })).toEqual({ north: 'loss', east: 'win', south: 'loss', west: 'loss' });
    expect(match.teams.map((team) => match.rank(team))).toEqual([2, 1, 4, 3]);
    expect(game.ended).toEqual({ outcomes: { north: 'loss', east: 'win', south: 'loss', west: 'loss' }, ranks: { north: 2, east: 1, south: 4, west: 3 } });
  });

  it('shared first place draws; malformed placements are invalid', () => {
    const match = setup();
    for (const bad of [
      { north: 1, east: 1, south: 2, west: 4 }, // after two firsts comes third
      { north: 1, east: 2, south: 3 }, // west missing
      { north: 1, east: 2, south: 3, west: 0 },
      { north: 1, east: 2, south: 3, west: 4.5 },
      { north: 1, east: 'loss', south: 3, west: 4 },
      { north: 1, east: 2, south: 3, west: 4, mars: 5 },
      {},
    ]) expect(code(() => match.end(bad as never)), JSON.stringify(bad)).toBe('invalid');
    expect(match.over).toBe(false);
    expect(match.end({ north: 1, east: 1, south: 3, west: 4 })).toEqual({ north: 'draw', east: 'draw', south: 'loss', west: 'loss' });
  });
});

describe('alliances', () => {
  const twoVsTwo = { alliances: { gold: ['east', 'north'], jade: ['south', 'west'] } } satisfies CreateMatchOptions<QuadManifest>;

  it('a 2v2 maps alliance outcomes to members, in the briefing, replay and record', async () => {
    const match = setup(twoVsTwo);
    expect(match.alliances).toEqual({ gold: ['north', 'east'], jade: ['south', 'west'] });
    expect(games.at(-1)!.sides).toEqual({ teams: ['north', 'east', 'south', 'west'], alliances: { gold: ['north', 'east'], jade: ['south', 'west'] } });
    expect(await match.seat('west', 'pilot').briefing()).toMatchObject({ teams: ['north', 'east', 'south', 'west'], alliances: { gold: ['north', 'east'], jade: ['south', 'west'] } });
    expect(match.end({ gold: 'loss', jade: 'win' })).toEqual({ north: 'loss', east: 'loss', south: 'win', west: 'win' });
    expect(match.teams.map((team) => match.rank(team))).toEqual([2, 2, 1, 1]);
    match.dispose();
    expect(host.history.get(match.id)).toMatchObject({ alliances: { gold: ['north', 'east'], jade: ['south', 'west'] }, ranks: { north: 2, east: 2, south: 1, west: 1 } });
  });

  it('team keys and alliance keys combine; allies must agree and every team must be covered', () => {
    const match = setup(twoVsTwo);
    expect(code(() => match.end({ north: 'win', east: 'loss', jade: 'loss' }))).toBe('invalid');
    expect(code(() => match.end({ north: 'win', jade: 'loss' }))).toBe('invalid');
    expect(code(() => match.end({ gold: 'win', north: 'loss', jade: 'loss' }))).toBe('invalid');
    expect(code(() => match.end({ gold: 1, jade: 1, north: 1, south: 2 }))).toBe('invalid');
    expect(match.end({ gold: 1, north: 1, jade: 2 })).toEqual({ north: 'win', east: 'win', south: 'loss', west: 'loss' });
  });

  it('allies share the rank by outcome even when the game reports them apart', async () => {
    const match = setup(twoVsTwo);
    games.at(-1)!.results.set('north', 'loss').set('east', 'win').set('south', 'loss').set('west', 'loss');
    await match.step(1);
    expect(match.teams.map((team) => match.rank(team))).toEqual([1, 1, 2, 2]);
  });

  it('alliances must partition the match teams with unambiguous ids', () => {
    host = createPlayerThreeHost({ definition: quadDefinition });
    const create = (opts: CreateMatchOptions<QuadManifest>) => code(() => host.createMatch({ realtime: false, ...opts }));
    expect(create({ alliances: { gold: ['north', 'east'], jade: ['south'] } })).toBe('invalid'); // west missing
    expect(create({ alliances: { gold: ['north', 'east'], jade: ['east', 'south', 'west'] } })).toBe('invalid'); // east twice
    expect(create({ teams: ['north', 'south'], alliances: { gold: ['north', 'east'], jade: ['south'] } })).toBe('invalid'); // east not playing
    expect(create({ alliances: { south: ['north', 'east'], jade: ['south', 'west'] } })).toBe('invalid'); // names another team
    expect(create({ alliances: { gold: [], jade: ['north', 'east', 'south', 'west'] } })).toBe('invalid');
    expect(create({ alliances: {} })).toBe('invalid');
    expect(create({ alliances: { north: ['north', 'east'], jade: ['south', 'west'] } })).toBeUndefined();
  });
});
