import { createHash } from 'node:crypto';
import { canonicalJson, surfaceHash, type GameDefinition } from 'playerthree';
import type { MatchSpec, SeriesSpec } from 'playerthree/arena';
import type { BenchConfig } from '../src/config.ts';
import { definition } from './bots-fixture.ts';

export function fixture(game: GameDefinition = definition): BenchConfig {
  const teams: readonly string[] = game.manifest.teams.values;
  const roles: readonly string[] = game.manifest.roles.values;
  const pin = surfaceHash(game.manifest);
  const entrants = teams.map((team, index) => ({ id: `entrant-${index}`, label: team, kind: 'bot' as const, aiPlayer: true, botLevel: index === 0 ? 'easy' : 'idle', botOptions: {}, stateResetSource: 'not_applicable' as const }));
  const sides: MatchSpec['sides'] = teams.map((team, index) => ({ id: team, spawnSlot: team, alliance: team, seats: roles.map((role) => ({ role, occupant: { kind: 'bot', level: entrants[index]!.botLevel, options: {} } })) }));
  const map = { id: 'fixture', identity: 'fixture/1', seed: 3, layout: 'declared' };
  const template: MatchSpec = { format: 'playerthree.match', version: 1, game: game.manifest.id, gameVersion: game.manifest.version, surfaceHash: pin, rulesHash: 'resolve', seed: 3, map, options: {}, sides,
    bindings: sides.flatMap((side, index) => side.seats.map((slot) => ({ seat: { team: side.id, role: slot.role }, entrantId: entrants[index]!.id }))), observerPolicy: { allowOmniscient: false, minDelayMs: 0 }, rules: { ranked: false, coaching: 'off', practiceReasons: [] } };
  const spec: SeriesSpec = { format: 'playerthree.series', version: 1, game: template.game, gameVersion: template.gameVersion, surfaceHash: pin, track: 'bots', entrants, template,
    scenarios: [3, 4].map((seed) => ({ id: `seed-${seed}`, seed, map: { ...map, seed }, options: {} })),
    permutations: teams.map((_team, offset) => ({ id: `rotation-${offset}`, sideEntrants: teams.map((team, index) => ({ team, entrantId: entrants[(index + offset) % teams.length]!.id })) })), repetitions: 1,
    execution: { concurrency: 1, speed: 1000, clock: 'accelerated', maxTicks: 8, maxWallMs: 20000, maxInfraRetries: 0, state: 'reset_each_match' },
    budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null }, rating: { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 }, telemetry: { sampleEveryTicks: 1, includeCommentary: false, metricDefinitions: [{ metric: 'collected', scope: 'match', unit: 'game', interpretation: 'cumulative' }, { metric: 'tickSum', scope: 'match', unit: 'game', interpretation: 'cumulative' }, { metric: 'minutes', scope: 'match', unit: 'game', interpretation: 'cumulative' }, { metric: 'score', scope: 'side', unit: 'game', interpretation: 'stock' }] } };
  return { definition: game, spec, resolve(match) {
    const options = game.manifest.matchOptions ? { endAt: 4, increment: 1, ...match.options } : match.options;
    return { ...match, options, rulesHash: createHash('sha256').update(canonicalJson(options)).digest('hex') };
  } };
}
