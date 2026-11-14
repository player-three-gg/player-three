/**
 * A four-team bench game (`north`, `east`, `south`, `west`) whose matches play any subset of its teams, alone or in
 * alliances. Every bot adds its level's strength to its team's score each decision; at tick 4 units (alliances, else
 * lone teams) place by summed score, so a series' outcomes and placements follow the entrants' bot levels.
 */
import { defineManifest, surfaceHash, t, type GameDefinition } from 'playerthree';
import type { MatchSpec, SeriesSpec } from 'playerthree/arena';
import { manifest as tag } from '../../playerthree/examples/tag/manifest.ts';
import type { BenchConfig } from '../src/config.ts';

const END_TICK = 4;
const STRENGTH: Record<string, number> = { idle: 0, easy: 1, normal: 2, hard: 3 };

const manifest = defineManifest({
  ...tag, id: 'bench-quad', title: 'Benchmark quad',
  teams: t.enum(['north', 'east', 'south', 'west']),
  opponents: t.enum(['idle', 'easy', 'normal', 'hard'], 'each decision adds 0, 1, 2 or 3 to the team score'),
  intents: { increment: { roles: ['runner', 'guard'], params: { amount: t.int(1, 10000) }, doc: 'Increment the team score.' } },
  observation: t.obj({ tick: t.int(0, 100), score: t.int(0, 100000) }),
  view: t.obj({ tick: t.int(0, 100) }),
  report: t.obj({ score: t.int(0, 100000) }),
  event: t.obj({ tick: t.int(0, 100), kind: t.enum(['incremented']) }),
  directive: t.obj({}), skills: [], starters: undefined,
});

export const quadBots: GameDefinition<typeof manifest> = {
  manifest,
  create({ teams, alliances }) {
    let tick = 0;
    const score = new Map<string, number>(teams.map((team) => [team, 0]));
    const units: readonly (readonly string[])[] = alliances ? Object.values(alliances) : teams.map((team) => [team]);
    const total = (members: readonly string[]) => members.reduce((sum, member) => sum + score.get(member)!, 0);
    // Standard competition ranking of the units by summed score; allies share their unit's placement.
    const placement = (team: string) => {
      const mine = total(units.find((members) => members.includes(team))!);
      return 1 + units.filter((members) => total(members) > mine).length;
    };
    return {
      manifest,
      get tick() { return tick; },
      step() { tick++; },
      outcome(team) {
        if (tick < END_TICK) return 'running';
        if (placement(team) !== 1) return 'loss';
        return units.filter((members) => placement(members[0]!) === 1).length === 1 ? 'win' : 'draw';
      },
      rank(team) { return placement(team); },
      view() { return { tick }; },
      observe({ team }) { return { tick, score: score.get(team)! }; },
      apply({ team }, intent) { score.set(team, score.get(team)! + intent.amount); return { ok: true }; },
      report(team) { return { score: score.get(team)! }; },
      events() { return []; },
      setSeatInfo() {},
    };
  },
  createBot(_seat, opponent) {
    return { think: () => STRENGTH[opponent]! > 0 ? [{ kind: 'increment', amount: STRENGTH[opponent]! }] : [] };
  },
};

/**
 * A bot series over `sides` (one entrant per side, playing `levels[i]` at first), rotating the entrants through the
 * sides once per seed.
 */
export function quadSeries(sides: readonly { team: string; alliance: string }[], levels: readonly string[], rating: SeriesSpec['rating']): BenchConfig {
  const roles: readonly string[] = manifest.roles.values;
  const pin = surfaceHash(manifest);
  const entrants = levels.map((level, index) => ({ id: `entrant-${index}`, label: level, kind: 'bot' as const, aiPlayer: true, botLevel: level, botOptions: {}, stateResetSource: 'not_applicable' as const }));
  const specSides: MatchSpec['sides'] = sides.map((side, index) => ({ id: side.team, spawnSlot: side.team, alliance: side.alliance, seats: roles.map((role) => ({ role, occupant: { kind: 'bot', level: levels[index]!, options: {} } })) }));
  const map = { id: 'quad', identity: 'quad/1', seed: 3, layout: 'corners' };
  const template: MatchSpec = { format: 'playerthree.match', version: 1, game: manifest.id, gameVersion: manifest.version, surfaceHash: pin, rulesHash: 'resolve', seed: 3, map, options: {}, sides: specSides,
    bindings: specSides.flatMap((side, index) => side.seats.map((slot) => ({ seat: { team: side.id, role: slot.role }, entrantId: entrants[index]!.id }))), observerPolicy: { allowOmniscient: false, minDelayMs: 0 }, rules: { ranked: false, coaching: 'off', practiceReasons: [] } };
  const spec: SeriesSpec = { format: 'playerthree.series', version: 1, game: template.game, gameVersion: template.gameVersion, surfaceHash: pin, track: 'bots', entrants, template,
    scenarios: [3, 4].map((seed) => ({ id: `seed-${seed}`, seed, map: { ...map, seed }, options: {} })),
    permutations: sides.map((_side, offset) => ({ id: `rotation-${offset}`, sideEntrants: sides.map((side, index) => ({ team: side.team, entrantId: entrants[(index + offset) % sides.length]!.id })) })), repetitions: 1,
    execution: { concurrency: 1, speed: 1000, clock: 'accelerated', maxTicks: 8, maxWallMs: 20000, maxInfraRetries: 0, state: 'reset_each_match' },
    budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null }, rating, telemetry: { sampleEveryTicks: 1, includeCommentary: false } };
  return { definition: quadBots, spec };
}
