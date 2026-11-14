/** Series ratings (SPEC §20.10): Elo and TrueSkill standings in canonical schedule order, `rateMatch` and seed-block bootstrap intervals. */
import { Rating, TrueSkill } from 'ts-trueskill';
import type { MatchRow, SeriesSpec, StandingRow, TrialRow } from './arena.ts';

const BOOTSTRAP_SEED = 0x51eed;
const BOOTSTRAP_REPLICATES = 2000;
const CONFIDENCE_LEVEL = 0.95;
const TRUE_SKILL_MIN_DELTA = 0.0001;

/** `lineups`: one per alliance (allied sides compete as one team), in side order, holding its entrants and shared rank. */
type Game = { trial: TrialRow; match: MatchRow; entrants: { id: string; rank: number; outcome: 'win' | 'loss' | 'draw' }[]; lineups: { ids: string[]; rank: number; outcome: 'win' | 'loss' | 'draw' }[] };

function eligibleGames(trials: readonly TrialRow[], attempts: readonly MatchRow[]): Game[] {
  const accepted = new Map<string, MatchRow>();
  for (const match of attempts) {
    if (!match.acceptedAttempt || (match.status !== 'finished' && match.status !== 'forfeit')) continue;
    if (accepted.has(match.trialId)) throw new Error(`Multiple accepted attempts: ${match.trialId}`);
    accepted.set(match.trialId, match);
  }
  const games: Game[] = [];
  for (const trial of [...trials].sort((a, b) => a.scheduleIndex - b.scheduleIndex || (a.trialId < b.trialId ? -1 : a.trialId > b.trialId ? 1 : 0))) {
    const match = accepted.get(trial.trialId);
    if (!match) continue;
    const entrants: Game['entrants'] = [];
    const lineups = new Map<string, Game['lineups'][number]>();
    for (const binding of trial.sideBindings) {
      const outcome = match.outcomes.find((row) => row.team === binding.team);
      const alliance = trial.spec.sides.find((side) => side.id === binding.team)?.alliance;
      if (!outcome || alliance === undefined || outcome.rank === null || outcome.outcome === 'aborted') throw new Error(`Invalid rated outcome: ${match.matchId}/${binding.team}`);
      if (!Number.isFinite(outcome.rank)) throw new Error('Nonfinite outcome rank');
      // One logical entrant is its lineup: it never plays two sides, allied or not.
      if (entrants.some((row) => row.id === binding.entrantId)) throw new Error('An entrant cannot occupy multiple rated sides');
      entrants.push({ id: binding.entrantId, rank: outcome.rank, outcome: outcome.outcome });
      const lineup = lineups.get(alliance);
      if (!lineup) lineups.set(alliance, { ids: [binding.entrantId], rank: outcome.rank, outcome: outcome.outcome });
      else if (lineup.rank !== outcome.rank || lineup.outcome !== outcome.outcome) throw new Error(`Invalid rated outcome: ${match.matchId}/${binding.team}`);
      else lineup.ids.push(binding.entrantId);
    }
    if (lineups.size < 2) continue;
    games.push({ trial, match, entrants, lineups: [...lineups.values()] });
  }
  return games;
}

/** One seed block of an entrant's games: wins, score (win 1, draw 0.5) and game count. */
export interface ScoreBlock {
  key: string;
  wins: number;
  score: number;
  games: number;
}

/**
 * Deterministic percentile bootstrap (32-bit LCG seed `BOOTSTRAP_SEED`, 2000 replicates, 95%) over whole blocks, never
 * individual games: win-rate and score-rate intervals, or null for fewer than two blocks (a single seed cannot identify
 * between-seed uncertainty). Blocks are resampled in key order, so the result is independent of input order.
 */
export function blockBootstrap(blocks: readonly ScoreBlock[]): { winRate: [number, number] | null; scoreRate: [number, number] | null } {
  if (blocks.length < 2) return { winRate: null, scoreRate: null };
  const values = [...blocks].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  let state = BOOTSTRAP_SEED;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x100000000; };
  const wins: number[] = [], scores: number[] = [];
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate++) {
    let w = 0, s = 0, n = 0;
    for (let i = 0; i < values.length; i++) {
      const block = values[Math.floor(random() * values.length)]!;
      w += block.wins; s += block.score; n += block.games;
    }
    wins.push(w / n); scores.push(s / n);
  }
  const bounds = (values: number[]): [number, number] => {
    values.sort((a, b) => a - b);
    const tail = (1 - CONFIDENCE_LEVEL) / 2;
    return [values[Math.max(0, Math.ceil(tail * values.length) - 1)]!, values[Math.ceil((1 - tail) * values.length) - 1]!];
  };
  return { winRate: bounds(wins), scoreRate: bounds(scores) };
}

/** Percentile bootstrap over whole scenario/map/seed blocks, never individual mirrors. */
function confidence(games: readonly Game[], entrantId: string, independent: boolean): StandingRow['confidence'] {
  const blocks = new Map<string, ScoreBlock>();
  for (const game of games) {
    const entrant = game.entrants.find((row) => row.id === entrantId);
    if (!entrant) continue;
    const key = JSON.stringify([game.trial.scenarioId, game.trial.mapIdentity, game.trial.seed, game.trial.mapSeed]);
    let block = blocks.get(key);
    if (!block) { block = { key, wins: 0, score: 0, games: 0 }; blocks.set(key, block); }
    block.games++;
    if (entrant.outcome === 'win') { block.wins++; block.score++; }
    else if (entrant.outcome === 'draw') block.score += 0.5;
  }
  const result: StandingRow['confidence'] = { method: 'seed_block_bootstrap', version: 1, seed: BOOTSTRAP_SEED, replicates: BOOTSTRAP_REPLICATES, blocks: blocks.size, level: CONFIDENCE_LEVEL, winRate: null, scoreRate: null, independent };
  // A carry-state series has no independent seed blocks.
  if (!independent) return result;
  return { ...result, ...blockBootstrap([...blocks.values()]) };
}

/** TrueSkill parameters (`ts-trueskill` 5.1.0). */
export interface TrueSkillParameters {
  mu: number;
  sigma: number;
  beta: number;
  tau: number;
  drawProbability: number;
}

export interface SkillRating {
  mu: number;
  sigma: number;
}

/** One side of a rated match: its members (one TrueSkill team), its placement and optional partial-play weights. */
export interface RatedLineup {
  ids: readonly string[];
  rank: number;
  /** Per member, in (0, 1]: the share of the side it played (e.g. plane share); default 1. */
  weights?: readonly number[];
}

const environments = new Map<string, TrueSkill>();

/**
 * One TrueSkill update (the factor graph of `ts-trueskill` 5.1.0, convergence delta 0.0001). Each lineup is a team
 * (allies together), ranked by `rank`; `weights` are partial-play weights. Unknown ids start at `env.mu`/`env.sigma`.
 * The match weight `weight` ∈ [0, 1] blends each member's update: μ' = μ + w(μ_new − μ), σ'² = σ² + w(σ_new² − σ²);
 * 1 is the plain update (exactly), 0 changes nothing. Returns the members' new ratings.
 */
export function rateMatch(env: TrueSkillParameters, lineups: readonly RatedLineup[], ratings: ReadonlyMap<string, SkillRating>, weight = 1): Map<string, SkillRating> {
  if (!(weight >= 0 && weight <= 1)) throw new Error('Match weight must be in [0, 1]');
  if (lineups.length < 2) throw new Error('A rated match needs at least two lineups');
  for (const lineup of lineups) {
    if (lineup.ids.length === 0 || !Number.isFinite(lineup.rank) || lineup.weights && (lineup.weights.length !== lineup.ids.length || lineup.weights.some((w) => !(w > 0 && w <= 1)))) throw new Error('Invalid rated lineup');
  }
  const prior = (id: string): SkillRating => ratings.get(id) ?? { mu: env.mu, sigma: env.sigma };
  const out = new Map<string, SkillRating>();
  if (weight === 0) {
    for (const lineup of lineups) for (const id of lineup.ids) out.set(id, { ...prior(id) });
    return out;
  }
  const key = JSON.stringify([env.mu, env.sigma, env.beta, env.tau, env.drawProbability]);
  let environment = environments.get(key);
  if (!environment) environments.set(key, (environment = new TrueSkill(env.mu, env.sigma, env.beta, env.tau, env.drawProbability)));
  const groups = lineups.map((lineup) => lineup.ids.map((id) => { const r = prior(id); return new Rating(r.mu, r.sigma); }));
  const weights = lineups.some((lineup) => lineup.weights) ? lineups.map((lineup) => lineup.weights ? [...lineup.weights] : lineup.ids.map(() => 1)) : null;
  const updated = environment.rate(groups, lineups.map((lineup) => lineup.rank), weights, TRUE_SKILL_MIN_DELTA) as Rating[][];
  lineups.forEach((lineup, index) => lineup.ids.forEach((id, member) => {
    const next = updated[index]![member]!;
    const before = prior(id);
    out.set(id, weight === 1 ? { mu: next.mu, sigma: next.sigma } : {
      mu: before.mu + weight * (next.mu - before.mu),
      sigma: Math.sqrt(before.sigma ** 2 + weight * (next.sigma ** 2 - before.sigma ** 2)),
    });
  }));
  return out;
}

/** Recompute after each committed match in canonical schedule order, not worker completion order. */
export function standings(spec: SeriesSpec, trials: readonly TrialRow[], attempts: readonly MatchRow[]): StandingRow[] {
  const config = spec.rating;
  const games = eligibleGames(trials, attempts);
  const elo = new Map(spec.entrants.map((entrant) => [entrant.id, config.algorithm === 'elo' ? config.initial : 0]));
  const skill = new Map<string, SkillRating>(spec.entrants.map((entrant) => [entrant.id, config.algorithm === 'trueskill' ? { mu: config.mu, sigma: config.sigma } : { mu: 0, sigma: 0 }]));
  for (const game of games) {
    for (const entrant of game.entrants) if (!elo.has(entrant.id)) throw new Error(`Unknown entrant: ${entrant.id}`);
    if (config.algorithm === 'elo') {
      if (game.lineups.length !== 2 || game.lineups.some((lineup) => lineup.ids.length !== 1)) throw new Error('Elo requires exactly two entrant lineups; use TrueSkill for multiplayer');
      const a = game.lineups[0]!, b = game.lineups[1]!;
      const ra = elo.get(a.ids[0]!)!, rb = elo.get(b.ids[0]!)!;
      const score = a.rank === b.rank ? 0.5 : a.rank < b.rank ? 1 : 0;
      const delta = config.k * (score - 1 / (1 + 10 ** ((rb - ra) / config.scale)));
      elo.set(a.ids[0]!, ra + delta); elo.set(b.ids[0]!, rb - delta);
    } else {
      // Each alliance is one TrueSkill team: its members' skills sum against the other alliances at its placement.
      for (const [id, rating] of rateMatch(config, game.lineups, skill)) skill.set(id, rating);
    }
  }
  return spec.entrants.map((entrant): StandingRow => {
    const played = games.filter((game) => game.entrants.some((row) => row.id === entrant.id));
    let wins = 0, draws = 0, losses = 0, simulated = 0, wall = 0;
    for (const game of played) {
      const outcome = game.entrants.find((row) => row.id === entrant.id)!.outcome;
      if (outcome === 'win') wins++; else if (outcome === 'draw') draws++; else losses++;
      simulated += game.match.simulatedMs; wall += game.match.wallMs;
    }
    const rating = skill.get(entrant.id)!;
    return {
      entrantId: entrant.id, wins, losses, draws, games: played.length,
      winRate: played.length ? wins / played.length : null, scoreRate: played.length ? (wins + 0.5 * draws) / played.length : null,
      rating: config.algorithm === 'elo' ? elo.get(entrant.id)! : null,
      mu: config.algorithm === 'trueskill' ? rating.mu : null, sigma: config.algorithm === 'trueskill' ? rating.sigma : null,
      conservativeRating: config.algorithm === 'trueskill' ? rating.mu - 3 * rating.sigma : null,
      ratingParameters: config.algorithm === 'elo'
        ? { algorithm: 'elo', version: 1, initial: config.initial, k: config.k, scale: config.scale, conservativeMultiplier: 3, minDelta: null }
        : { algorithm: 'trueskill', version: 1, mu: config.mu, sigma: config.sigma, beta: config.beta, tau: config.tau, drawProbability: config.drawProbability, conservativeMultiplier: 3, minDelta: TRUE_SKILL_MIN_DELTA },
      ratingImplementation: config.algorithm === 'elo' ? 'elo/1' : 'ts-trueskill/5.1.0',
      provisional: games.length < trials.length,
      averageSimulatedMs: played.length ? simulated / played.length : null, averageWallMs: played.length ? wall / played.length : null,
      confidence: confidence(games, entrant.id, spec.execution.state === 'reset_each_match'),
    };
  });
}
