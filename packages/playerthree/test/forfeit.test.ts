import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { definition as tag } from '../examples/tag/index.ts';
import { PlayerThreeError, createPlayerThreeHost, replayMatch } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeMatch, PlayerThreeTraceEvent, CreateMatchOptions, Replay, ReplayEntry } from '../src/host/types.ts';
import type { GameAdapter } from '../src/index.ts';
import { games, QuadGame, quadDefinition, type QuadManifest } from './quad-fixture.ts';

let host: PlayerThreeHost<QuadManifest> | undefined;
afterEach(() => host?.dispose());

function setup(opts: CreateMatchOptions<QuadManifest> = {}): { match: PlayerThreeMatch<QuadManifest>; game: QuadGame; traces: PlayerThreeTraceEvent[] } {
  host = createPlayerThreeHost({ definition: quadDefinition });
  const traces: PlayerThreeTraceEvent[] = [];
  host.onTrace((e) => traces.push(e));
  const match = host.createMatch({ seed: 1, realtime: false, ...opts });
  return { match, game: games.at(-1)!, traces };
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof PlayerThreeError ? error.code : 'thrown';
  }
  return undefined;
};

/** Everything the quad game simulates, hashed: equal hashes mean an identical game state. */
function stateHash(adapter: GameAdapter<QuadManifest>): string {
  const game = adapter as QuadGame;
  const sorted = <V>(map: Map<string, V>) => [...map].sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify({ tick: game.tick, pings: sorted(game.pings), results: sorted(game.results), forfeits: game.forfeits })).digest('hex');
}

const forfeitEntries = (replay: Replay) => replay.entries.filter((e) => e[3] === 'forfeit');

describe('PlayerThreeMatch.forfeit', () => {
  it('is recorded at its tick among the intents and replays to the identical state', async () => {
    const { match, game, traces } = setup({ botLevel: { north: 'pinger', east: 'pinger', south: 'pinger', west: 'pinger' } });
    await match.step(3);
    const east = match.seat('east', 'pilot');
    // Recording order matters: the ping before the forfeit counts, the one after it is refused by the game.
    expect(await east.act([{ kind: 'ping' }])).toEqual([{ ok: true }]);
    match.forfeit('east');
    expect(await east.act([{ kind: 'ping' }])).toEqual([{ ok: false, code: 'game', gameCode: 'out' }]);
    expect(game.forfeits).toEqual([[3, 'east']]);
    expect(traces.filter((e) => e.type === 'forfeit')).toEqual([expect.objectContaining({ type: 'forfeit', tick: 3, team: 'east' })]);
    const replayAt3 = match.replay();
    expect(forfeitEntries(replayAt3)).toEqual([[3, 'east', 'pilot', 'forfeit']]);
    expect(replayAt3.entries.filter((e) => e[0] === 3 && e[1] === 'east').map((e) => e[3])).toEqual(['intent', 'forfeit', 'intent']);

    await match.step(4);
    match.forfeit('north');
    await match.step(2);
    expect(match.outcome('north')).toBe('loss');
    const replay = match.replay();
    expect(forfeitEntries(replay)).toEqual([[3, 'east', 'pilot', 'forfeit'], [7, 'north', 'pilot', 'forfeit']]);

    const replayed = replayMatch(quadDefinition, replay);
    expect(stateHash(replayed.adapter)).toBe(stateHash(game));
    expect(replayed.outcomes).toEqual(replay.outcomes);
    // Scrubbing to the forfeit's tick includes it, as any input recorded at that tick.
    const at3 = replayMatch(quadDefinition, replay, 3).adapter as QuadGame;
    expect(at3.forfeits).toEqual([[3, 'east']]);
    expect(at3.pings.get('east')).toBe(game.pings.get('east'));
  });

  it("keeps the forfeited team's final outcome while the others play on until they are decided", async () => {
    const { match, game, traces } = setup({ teams: ['north', 'east', 'south'], botLevel: { north: 'pinger', east: 'pinger', south: 'pinger' } });
    const east = match.seat('east', 'pilot');
    await match.step(2);
    const waiting = east.wait({ seconds: 60 });
    match.forfeit('east');
    // The game decides at its next step; until then the team is not final.
    expect(match.outcome('east')).toBe('running');
    await match.step(1);
    expect(match.outcome('east')).toBe('loss');
    expect(match.over).toBe(false);
    await expect(waiting).resolves.toMatchObject({ outcome: 'loss' });
    expect(await east.act([{ kind: 'ping' }])).toEqual([{ ok: false, code: 'game_over' }]);

    const pings = game.pings.get('east');
    const south = game.pings.get('south')!;
    game.results.set('east', 'win');
    await match.step(3);
    expect(match.outcome('east')).toBe('loss');
    expect(game.pings.get('east')).toBe(pings);
    expect(game.pings.get('south')).toBe(south + 3);

    game.results.set('north', 'win').set('south', 'loss');
    await match.step(1);
    expect(match.over).toBe(true);
    expect([match.rank('north'), match.rank('east'), match.rank('south')]).toEqual([1, 2, 2]);
    expect(traces.filter((e) => e.type === 'match_ended')).toEqual([expect.objectContaining({ outcomes: { north: 'win', east: 'loss', south: 'loss' } })]);
  });

  it('retires the team at once when the game decides at the forfeit, ending a duel', async () => {
    const { match, game } = setup({ teams: ['north', 'south'] });
    const ended: unknown[] = [];
    match.onEnd((outcomes, ranks) => ended.push({ outcomes, ranks }));
    await match.step(1);
    game.forfeit = (team) => {
      game.forfeits.push([game.tick, team]);
      game.results.set(team, 'loss').set(team === 'north' ? 'south' : 'north', 'win');
    };
    match.forfeit('south');
    expect(match.over).toBe(true);
    expect(ended).toEqual([{ outcomes: { north: 'win', south: 'loss' }, ranks: { north: 1, south: 2 } }]);
  });

  it('is idempotent and a no-op once the team is final or the match is over', async () => {
    const { match, game, traces } = setup({ teams: ['north', 'east', 'south'] });
    match.forfeit('east');
    match.forfeit('east');
    expect(game.forfeits).toEqual([[0, 'east']]);
    await match.step(1);
    match.forfeit('east');
    expect(game.forfeits).toEqual([[0, 'east']]);

    game.results.set('north', 'loss');
    await match.step(1);
    match.forfeit('north');
    expect(game.forfeits).toEqual([[0, 'east']]);

    match.end('draw');
    match.forfeit('south');
    expect(game.forfeits).toEqual([[0, 'east']]);
    expect(forfeitEntries(match.replay())).toEqual([[0, 'east', 'pilot', 'forfeit']]);
    expect(traces.filter((e) => e.type === 'forfeit')).toHaveLength(1);
  });

  it('lets a human watch omnisciently once its teams are final and no ally of theirs still plays', async () => {
    const { match, game } = setup({
      teams: ['north', 'east', 'south'],
      alliances: { gold: ['north', 'east'], south: ['south'] },
      observerPolicy: { allowOmniscient: true, minDelayMs: 0, public: false },
      assignments: [{ team: 'east', role: 'pilot', owner: 'alice', kind: 'human' }, { team: 'south', role: 'pilot', owner: 'bob', kind: 'human' }],
    });
    const all = { kind: 'omniscient', teams: ['north', 'east', 'south'], delayMs: 0 } as const;
    expect(code(() => match.mintObserverToken(all, { owner: 'alice' }))).toBe('forbidden');
    match.forfeit('east');
    await match.step(1);
    expect(match.outcome('east')).toBe('loss');
    // Its ally north still plays: alice could still help it with what she sees.
    expect(code(() => match.mintObserverToken(all, { owner: 'alice' }))).toBe('forbidden');
    expect(code(() => match.mintObserverToken({ kind: 'team', team: 'south', delayMs: 0 }, { owner: 'alice' }))).toBe('forbidden');

    match.forfeit('south');
    await match.step(1);
    expect(match.over).toBe(false);
    expect(code(() => match.mintObserverToken(all, { owner: 'bob' }))).toBeUndefined();
    expect(match.coachingAllowed('bob')).toBe(false);
    expect(code(() => match.mintObserverToken(all, { owner: 'alice' }))).toBe('forbidden');

    game.results.set('north', 'win');
    await match.step(1);
    expect(match.over).toBe(true);
    expect(code(() => match.mintObserverToken(all, { owner: 'alice' }))).toBeUndefined();
    expect(code(() => match.mintObserverToken({ kind: 'team', team: 'south', delayMs: 0 }, { owner: 'alice' }))).toBeUndefined();
  });

  it('refuses teams outside the match, games without the hook and persistent sessions', () => {
    const { match } = setup({ teams: ['north', 'east'] });
    expect(code(() => match.forfeit('south'))).toBe('invalid');
    expect(code(() => match.forfeit('mars' as never))).toBe('invalid');
    host!.dispose();

    const tagHost = createPlayerThreeHost({ definition: tag });
    try {
      const tagMatch = tagHost.createMatch({ seed: 1, realtime: false });
      expect(code(() => tagMatch.forfeit(tagMatch.teams[0]!))).toBe('invalid');
      expect(forfeitEntries(tagMatch.replay())).toEqual([]);
    } finally {
      tagHost.dispose();
    }

    host = createPlayerThreeHost({
      definition: { ...quadDefinition, create: (opts) => Object.assign(quadDefinition.create(opts), { clone: () => new QuadGame({ teams: opts.teams }) }) },
    });
    const persistent = host.createMatch({ realtime: false, teams: ['north', 'east'], persistent: { checkpointTicks: 5, checkpoints: 2 } });
    expect(code(() => persistent.forfeit('north'))).toBe('invalid');
  });

  it('replays reject malformed, repeated and unsupported forfeit entries', async () => {
    const { match } = setup({ teams: ['north', 'east'] });
    await match.step(1);
    match.forfeit('east');
    await match.step(1);
    const replay = match.replay();
    const withEntries = (entries: unknown[]): Replay => ({ ...replay, entries: entries as ReplayEntry[] });
    expect(() => replayMatch(quadDefinition, withEntries([[1, 'east', 'pilot', 'forfeit', 'now']]))).toThrow(/invalid forfeit entry/);
    expect(() => replayMatch(quadDefinition, withEntries([[1, 'east', 'pilot', 'forfeit'], [1, 'east', 'pilot', 'forfeit']]))).toThrow(/invalid forfeit entry/);
    expect(() => replayMatch(quadDefinition, withEntries([[1, 'mars', 'pilot', 'forfeit']]))).toThrow(/unknown seat/);
    expect(() => replayMatch(quadDefinition, withEntries([[1, 'east', 'pilot', 'forfeit']]))).not.toThrow();

    const tagHost = createPlayerThreeHost({ definition: tag });
    try {
      const tagMatch = tagHost.createMatch({ seed: 1, realtime: false });
      await tagMatch.step(1);
      const tagReplay = tagMatch.replay();
      const role = tagMatch.seats()[0]!.role;
      expect(() => replayMatch(tag, { ...tagReplay, entries: [[0, tagMatch.teams[0]!, role, 'forfeit']] })).toThrow(/invalid forfeit entry/);
    } finally {
      tagHost.dispose();
    }
  });
});
