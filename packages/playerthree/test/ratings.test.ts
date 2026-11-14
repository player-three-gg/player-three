import { Rating, TrueSkill } from 'ts-trueskill';
import { describe, expect, it } from 'vitest';
import type { MatchRow, TrialRow } from '../src/arena.ts';
import { blockBootstrap, rateMatch, standings } from '../src/ratings.ts';
import { exportMatchSpec } from '../src/results.ts';
import { seriesFixture } from './arena-fixtures.ts';

describe('canonical series ratings', () => {
  it('uses simultaneous zero-sum Elo updates with explicit K and logistic scale', () => {
    const { record } = seriesFixture();
    const rows = standings(record.spec, record.trials, [record.attempts[0]!]);
    expect(rows.find((row) => row.entrantId === 'alpha')).toMatchObject({ wins: 1, losses: 0, draws: 0, games: 1, winRate: 1, scoreRate: 1, rating: 1516, mu: null, sigma: null, conservativeRating: null, provisional: true });
    expect(rows.find((row) => row.entrantId === 'beta')?.rating).toBe(1484);
    expect(rows[0]!.ratingParameters).toEqual({ algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400, conservativeMultiplier: 3, minDelta: null });
    record.spec.rating = { algorithm: 'elo', version: 1, initial: 1200, k: 20, scale: 200 };
    expect(standings(record.spec, record.trials, [record.attempts[0]!])[0]?.rating).toBe(1210);
  });

  it('does not label score rate as win rate, rates draws as half scores and excludes infrastructure/aborts', () => {
    const { record } = seriesFixture();
    const draw: MatchRow = { ...record.attempts[0]!, outcomes: record.attempts[0]!.outcomes.map((outcome) => ({ ...outcome, rank: 0, outcome: 'draw' })) };
    const invalid: MatchRow[] = [
      { ...record.attempts[1]!, acceptedAttempt: false, status: 'infra_error', outcomes: [] },
      { ...record.attempts[1]!, attemptId: 'aborted', acceptedAttempt: false, status: 'aborted', outcomes: [] },
    ];
    const rows = standings(record.spec, record.trials, [draw, ...invalid]);
    expect(rows[0]).toMatchObject({ wins: 0, draws: 1, losses: 0, games: 1, winRate: 0, scoreRate: 0.5, rating: 1500 });
    expect(rows[1]?.rating).toBe(1500);
    expect(rows[0]?.confidence.winRate).toBeNull();
  });

  it('recomputes provisional ratings in schedule order, independent of concurrency finish order', () => {
    const { record } = seriesFixture();
    const one = standings(record.spec, record.trials, [record.attempts[1]!]);
    expect(one[0]?.rating).toBe(1484);
    const complete = standings(record.spec, record.trials, [...record.attempts].reverse());
    expect(complete).toEqual(standings(record.spec, [...record.trials].reverse(), record.attempts));
    const expected = 1516 + 32 * (0 - 1 / (1 + 10 ** ((1484 - 1516) / 400)));
    expect(complete[0]?.rating).toBeCloseTo(expected, 12);
    expect(complete.every((row) => !row.provisional)).toBe(true);
    expect(complete[0]).toMatchObject({ averageSimulatedMs: 5500, averageWallMs: 6500 });
    expect(complete.reduce((sum, row) => sum + row.rating!, 0)).toBe(3000);
  });

  it('rejects multiple accepted attempts instead of cherry-picking a better retry', () => {
    const { record } = seriesFixture();
    expect(() => standings(record.spec, record.trials, [record.attempts[0]!, { ...record.attempts[0]!, attemptId: 'duplicate', attemptNumber: 2 }])).toThrow(/Multiple accepted/);
  });

  it('uses the real maintained TrueSkill factor graph and publishes mean/deviation/conservative value', () => {
    const { record } = seriesFixture();
    record.spec.rating = { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: 0.1 };
    const rows = standings(record.spec, record.trials, [record.attempts[0]!]);
    expect(rows[0]?.mu).toBeCloseTo(29.395832, 5);
    expect(rows[1]?.mu).toBeCloseTo(20.604168, 5);
    expect(rows[0]?.sigma).toBeCloseTo(7.171476, 5);
    expect(rows[0]?.conservativeRating).toBeCloseTo(rows[0]!.mu! - 3 * rows[0]!.sigma!, 12);
    expect(rows[0]?.rating).toBeNull();
    expect(rows[0]?.ratingImplementation).toBe('ts-trueskill/5.1.0');
    expect(rows[0]?.ratingParameters).toMatchObject({ beta: 25 / 6, tau: 25 / 300, drawProbability: 0.1, minDelta: 0.0001, conservativeMultiplier: 3 });
  });

  it('supports multiplayer ranks and ties without inventing causal seat ratings or pairwise Elo', () => {
    const { record } = seriesFixture();
    record.spec.entrants = [...record.spec.entrants, { id: 'gamma', label: 'Gamma', kind: 'bot', aiPlayer: true }];
    const base = record.trials[0]!;
    const spec = { ...base.spec, sides: [...base.spec.sides, { ...base.spec.sides[1]!, id: 'green', spawnSlot: 'north', alliance: 'green' }] };
    const trial: TrialRow = { ...base, spec, sideBindings: [{ team: 'blue', entrantId: 'alpha' }, { team: 'red', entrantId: 'beta' }, { team: 'green', entrantId: 'gamma' }] };
    const match: MatchRow = { ...record.attempts[0]!, outcomes: [{ team: 'blue', rank: 0, outcome: 'win', reason: 'rank' }, { team: 'red', rank: 1, outcome: 'draw', reason: 'rank' }, { team: 'green', rank: 1, outcome: 'draw', reason: 'rank' }] };
    expect(() => standings(record.spec, [trial], [match])).toThrow(/Elo requires/);
    const config = { algorithm: 'trueskill', version: 1, mu: 30, sigma: 6, beta: 3, tau: 0.1, drawProbability: 0.2 } as const;
    record.spec.rating = config;
    const rows = standings(record.spec, [trial], [match]);
    const reference = new TrueSkill(config.mu, config.sigma, config.beta, config.tau, config.drawProbability).rate([[new Rating(30, 6)], [new Rating(30, 6)], [new Rating(30, 6)]], [0, 1, 1], null, 0.0001) as Rating[][];
    rows.forEach((row, index) => { expect(row.mu).toBeCloseTo(reference[index]![0]!.mu, 12); expect(row.sigma).toBeCloseTo(reference[index]![0]!.sigma, 12); });
    expect(rows[0]!.mu!).toBeGreaterThan(rows[1]!.mu!);
    // Tied ranks converge only to the factor graph's minDelta schedule, not to exact symmetry.
    expect(rows[1]!.mu!).toBeCloseTo(rows[2]!.mu!, 1);
    expect(rows).toHaveLength(3);
  });

  describe('alliances', () => {
    /** Four sides `blue`/`red` (alliance `gold`) vs `green`/`white` (alliance `jade`), entrants alpha..delta. */
    function twoVsTwo(alliances: readonly string[] = ['gold', 'gold', 'jade', 'jade']) {
      const { record } = seriesFixture();
      record.spec.entrants = [...record.spec.entrants, { id: 'gamma', label: 'Gamma', kind: 'bot', aiPlayer: true }, { id: 'delta', label: 'Delta', kind: 'bot', aiPlayer: true }];
      const base = record.trials[0]!;
      const teams = ['blue', 'red', 'green', 'white'];
      const sides = teams.map((team, index) => ({ ...base.spec.sides[1]!, id: team, spawnSlot: team, alliance: alliances[index]! }));
      const trial: TrialRow = { ...base, spec: { ...base.spec, sides }, sideBindings: teams.map((team, index) => ({ team, entrantId: ['alpha', 'beta', 'gamma', 'delta'][index]! })) };
      const ranks = Object.fromEntries(sides.map((side) => [side.alliance, side.alliance === alliances[0] ? 1 : 2]));
      const match: MatchRow = { ...record.attempts[0]!, outcomes: sides.map((side) => ({ team: side.id, rank: ranks[side.alliance]!, outcome: ranks[side.alliance] === 1 ? 'win' : 'loss', reason: 'rank' })) };
      return { record, trial, match };
    }

    it('rates each alliance as one TrueSkill team at its shared rank', () => {
      const { record, trial, match } = twoVsTwo();
      const config = { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: 0.1 } as const;
      record.spec.rating = config;
      const rows = standings(record.spec, [trial], [match]);
      const prior = () => new Rating(config.mu, config.sigma);
      const reference = new TrueSkill(config.mu, config.sigma, config.beta, config.tau, config.drawProbability).rate([[prior(), prior()], [prior(), prior()]], [1, 2], null, 0.0001) as Rating[][];
      expect(rows.map((row) => row.mu)).toEqual([reference[0]![0]!.mu, reference[0]![1]!.mu, reference[1]![0]!.mu, reference[1]![1]!.mu]);
      expect(rows.map((row) => [row.wins, row.losses])).toEqual([[1, 0], [1, 0], [0, 1], [0, 1]]);
    });

    it('rates Elo only between two single-entrant alliances', () => {
      expect(() => { const { record, trial, match } = twoVsTwo(); standings(record.spec, [trial], [match]); }).toThrow(/Elo requires/);
      // Alliance ids need not be team ids: two one-entrant alliances are an ordinary duel.
      const { record } = seriesFixture();
      const base = record.trials[0]!;
      const trial: TrialRow = { ...base, spec: { ...base.spec, sides: base.spec.sides.map((side) => ({ ...side, alliance: `${side.id}-alliance` })) } };
      expect(standings(record.spec, [trial], [record.attempts[0]!]).map((row) => row.rating)).toEqual([1516, 1484]);
    });

    it('rejects allies with different ranks or outcomes', () => {
      const { record, trial, match } = twoVsTwo();
      record.spec.rating = { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: 0.1 };
      const split: MatchRow = { ...match, outcomes: match.outcomes.map((row) => row.team === 'red' ? { ...row, rank: 3, outcome: 'loss' } : row) };
      expect(() => standings(record.spec, [trial], [split])).toThrow(/Invalid rated outcome/);
      const duplicate: TrialRow = { ...trial, sideBindings: trial.sideBindings.map((binding) => binding.team === 'red' ? { ...binding, entrantId: 'alpha' } : binding) };
      expect(() => standings(record.spec, [duplicate], [match])).toThrow(/multiple rated sides/);
    });
  });

  it('keeps default TrueSkill draws symmetric while reducing uncertainty', () => {
    const { record } = seriesFixture();
    record.spec.rating = { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: 0.1 };
    const draw = { ...record.attempts[0]!, outcomes: record.attempts[0]!.outcomes.map((outcome) => ({ ...outcome, rank: 0, outcome: 'draw' as const })) };
    const rows = standings(record.spec, [record.trials[0]!], [draw]);
    expect(rows[0]?.mu).toBeCloseTo(25, 12);
    expect(rows[1]?.mu).toBeCloseTo(25, 12);
    expect(rows[0]!.sigma!).toBeLessThan(25 / 3);
    expect(rows[0]?.sigma).toBeCloseTo(rows[1]!.sigma!, 12);
  });
});

describe('scenario/seed block confidence intervals', () => {
  it('resamples whole side-mirror blocks instead of treating correlated games independently', () => {
    const { record } = seriesFixture();
    const trials: TrialRow[] = [], attempts: MatchRow[] = [];
    for (const base of record.trials) for (let mirror = 0; mirror < 2; mirror++) {
      const index = trials.length;
      const sideBindings = mirror ? [{ team: 'blue', entrantId: 'beta' }, { team: 'red', entrantId: 'alpha' }] : base.sideBindings;
      const trial: TrialRow = { ...base, trialId: `${base.trialId}-${mirror}`, permutationId: mirror ? 'mirror' : 'normal', scheduleIndex: index, sideBindings };
      trials.push(trial);
      attempts.push({ ...record.attempts[0]!, trialId: trial.trialId, matchId: `mirror-match-${index}`, attemptId: `mirror-attempt-${index}`, revision: index + 1, spec: exportMatchSpec(trial.spec), outcomes: sideBindings.map((binding) => {
        const win = (binding.entrantId === 'alpha') === (base.seed === 7);
        return { team: binding.team, rank: win ? 0 : 1, outcome: win ? 'win' : 'loss', reason: 'victory' };
      }) });
    }
    const rows = standings(record.spec, trials, attempts);
    expect(rows[0]).toMatchObject({ games: 4, wins: 2, losses: 2, winRate: 0.5, confidence: { method: 'seed_block_bootstrap', version: 1, blocks: 2, seed: 0x51eed, replicates: 2000, level: 0.95, winRate: [0, 1], scoreRate: [0, 1], independent: true } });
    expect(standings(record.spec, [...trials].reverse(), [...attempts].reverse())).toEqual(rows);
  });

  it('reports no identifiable between-seed interval for one block or carry-state dependence', () => {
    const { record } = seriesFixture();
    const one = standings(record.spec, [record.trials[0]!], [record.attempts[0]!]);
    expect(one[0]?.confidence).toMatchObject({ blocks: 1, winRate: null, scoreRate: null });
    record.spec.execution.state = 'carry_within_series';
    expect(standings(record.spec, record.trials, record.attempts)[0]?.confidence).toMatchObject({ blocks: 2, independent: false, winRate: null, scoreRate: null });
    const empty = standings(record.spec, record.trials, []);
    expect(empty[0]).toMatchObject({ games: 0, winRate: null, scoreRate: null, averageSimulatedMs: null, averageWallMs: null });
  });
});

describe('rateMatch', () => {
  const env = { mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: 0.05 };
  const none = new Map<string, { mu: number; sigma: number }>();

  it('is the plain ts-trueskill update at weight 1 and changes nothing at weight 0', () => {
    const direct = new TrueSkill(env.mu, env.sigma, env.beta, env.tau, env.drawProbability).rate([[new Rating(30, 4)], [new Rating(22, 6)]], [1, 2], null, 0.0001) as Rating[][];
    const prior = new Map([['a', { mu: 30, sigma: 4 }], ['b', { mu: 22, sigma: 6 }]]);
    const rated = rateMatch(env, [{ ids: ['a'], rank: 1 }, { ids: ['b'], rank: 2 }], prior);
    expect(rated.get('a')).toEqual({ mu: direct[0]![0]!.mu, sigma: direct[0]![0]!.sigma });
    expect(rated.get('b')).toEqual({ mu: direct[1]![0]!.mu, sigma: direct[1]![0]!.sigma });
    expect(rateMatch(env, [{ ids: ['a'], rank: 1 }, { ids: ['b'], rank: 2 }], prior, 0)).toEqual(prior);
    // Unknown ids start at μ₀/σ₀.
    expect(rateMatch(env, [{ ids: ['x'], rank: 1 }, { ids: ['y'], rank: 1 }], none, 0).get('x')).toEqual({ mu: 25, sigma: 25 / 3 });
  });

  it('blends a partial match weight into μ and σ²', () => {
    const full = rateMatch(env, [{ ids: ['a'], rank: 1 }, { ids: ['b'], rank: 2 }], none);
    const half = rateMatch(env, [{ ids: ['a'], rank: 1 }, { ids: ['b'], rank: 2 }], none, 0.5);
    const a = full.get('a')!, h = half.get('a')!;
    expect(h.mu).toBeCloseTo(25 + 0.5 * (a.mu - 25), 12);
    expect(h.sigma ** 2).toBeCloseTo((25 / 3) ** 2 + 0.5 * (a.sigma ** 2 - (25 / 3) ** 2), 12);
    expect(() => rateMatch(env, [{ ids: ['a'], rank: 1 }, { ids: ['b'], rank: 2 }], none, 1.5)).toThrow(/weight/);
  });

  it('moves a lineup member by its plane share (partial-play weights)', () => {
    const rated = rateMatch(env, [{ ids: ['main', 'helper'], rank: 1, weights: [0.75, 0.25] }, { ids: ['solo'], rank: 2 }], none);
    const main = rated.get('main')!, helper = rated.get('helper')!;
    expect(main.mu).toBeGreaterThan(helper.mu);
    expect(helper.mu).toBeGreaterThan(25);
    expect(main.sigma).toBeLessThan(helper.sigma);
    expect(rated.get('solo')!.mu).toBeLessThan(25);
    expect(() => rateMatch(env, [{ ids: ['a'], rank: 1, weights: [0] }, { ids: ['b'], rank: 2 }], none)).toThrow(/lineup/);
  });

  it('rates free-for-all placements and alliances as TrueSkill teams', () => {
    const ffa = rateMatch({ ...env, drawProbability: 0.01 }, ['a', 'b', 'c', 'd'].map((id, i) => ({ ids: [id], rank: i + 1 })), none);
    const mus = ['a', 'b', 'c', 'd'].map((id) => ffa.get(id)!.mu);
    expect([...mus].sort((x, y) => y - x)).toEqual(mus);
    const allied = rateMatch(env, [{ ids: ['a', 'b'], rank: 1 }, { ids: ['c', 'd'], rank: 2 }], none);
    const direct = new TrueSkill(env.mu, env.sigma, env.beta, env.tau, env.drawProbability).rate([[new Rating(), new Rating()], [new Rating(), new Rating()]], [1, 2], null, 0.0001) as Rating[][];
    expect(allied.get('b')!.mu).toBe(direct[0]![1]!.mu);
    expect(allied.get('c')!.mu).toBe(direct[1]![0]!.mu);
  });

  it('bootstraps whole seed blocks and refuses a single block', () => {
    expect(blockBootstrap([{ key: 'a', wins: 2, score: 2, games: 2 }])).toEqual({ winRate: null, scoreRate: null });
    const blocks = [{ key: 'a', wins: 2, score: 2, games: 2 }, { key: 'b', wins: 0, score: 1, games: 2 }, { key: 'c', wins: 1, score: 1, games: 2 }];
    const result = blockBootstrap(blocks);
    expect(result).toEqual(blockBootstrap([...blocks].reverse()));
    expect(result.scoreRate![0]).toBeLessThanOrEqual(result.scoreRate![1]);
  });
});
