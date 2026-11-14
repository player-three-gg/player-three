/**
 * A four-team test game: sides `north`, `east`, `south`, `west`, one `pilot` seat each. Tests decide outcomes and
 * ranks directly on the created adapter (`games`), so match-level team handling is tested without game rules.
 */
import { defineManifest, t, type FinalOutcome, type GameAdapter, type GameDefinition, type MatchSides, type Outcome, type Seat } from '../src/index.ts';

export const QUAD_TEAMS = ['north', 'east', 'south', 'west'] as const;
type QuadTeam = (typeof QUAD_TEAMS)[number];
const team = t.enum(QUAD_TEAMS);

export const quadManifest = defineManifest({
  id: 'quad',
  version: '1.0.0',
  title: 'Quad',
  doc: 'Four corners. Pilots ping; the test decides who wins.',
  roleDocs: { pilot: 'The only role: ping.' },
  tickRate: 10,
  teams: team,
  roles: t.enum(['pilot']),
  intents: { ping: { roles: ['pilot'], params: {}, doc: 'Count one ping for your team.' } },
  observation: t.obj({ tick: t.int(0, 1_000_000), team, sides: t.list(team, 4), pings: t.int(0, 1_000_000) }),
  view: t.obj({ tick: t.int(0, 1_000_000), team }),
  observer: t.obj({ tick: t.int(0, 1_000_000), sides: t.list(team, 4) }),
  directive: t.obj({ stance: t.enum(['any']) }),
  errors: t.enum(['out'], 'out: your team is out'),
  event: t.obj({ tick: t.int(0, 1_000_000), kind: t.enum(['pinged']) }),
  opponents: t.enum(['idle', 'pinger'], 'idle does nothing; pinger pings every decision'),
  report: t.obj({ outcome: t.enum(['win', 'loss', 'draw', 'running']), pings: t.int(0, 1_000_000) }),
  skills: [],
  topics: {},
  control: {
    intents: { perSecond: 100, burst: 100 },
    policy: { runtimes: ['js'], hz: 10, msPerCall: 50, memoryBytes: 16 << 20, maxArtifactBytes: 64 * 1024, maxIntentsPerCall: 4, maxLogLines: 10, maxLogLineBytes: 200 },
    practice: { maxTicks: 100, concurrent: 2 },
  },
});
export type QuadManifest = typeof quadManifest;

export class QuadGame implements GameAdapter<QuadManifest> {
  readonly manifest = quadManifest;
  readonly sides: MatchSides<QuadManifest>;
  tick = 0;
  /** Outcomes the test reports through `outcome()`; absent teams are running. */
  readonly results = new Map<QuadTeam, Outcome>();
  readonly pings = new Map<QuadTeam, number>();
  /** Set by a test to report placements. */
  rank?: (team: QuadTeam) => number;
  /** What the host declared through `end`. */
  ended: { outcomes: Partial<Record<QuadTeam, FinalOutcome>>; ranks: Partial<Record<QuadTeam, number>> } | undefined;
  /** Forfeits in call order as [tick, team]: the team stops pinging at once and loses at the next step. */
  readonly forfeits: [number, QuadTeam][] = [];

  constructor(sides: MatchSides<QuadManifest>) {
    this.sides = sides;
  }

  step(): void {
    this.tick++;
    for (const [, team] of this.forfeits) if (!this.results.has(team)) this.results.set(team, 'loss');
  }

  outcome(team: QuadTeam): Outcome {
    return this.ended?.outcomes[team] ?? this.results.get(team) ?? 'running';
  }

  view(team: QuadTeam) {
    return { tick: this.tick, team };
  }

  observerView() {
    return { tick: this.tick, sides: [...this.sides.teams] };
  }

  observe(seat: Seat<QuadManifest>) {
    return { tick: this.tick, team: seat.team, sides: [...this.sides.teams], pings: this.pings.get(seat.team) ?? 0 };
  }

  apply(seat: Seat<QuadManifest>) {
    if (this.outcome(seat.team) !== 'running' || this.forfeits.some(([, team]) => team === seat.team)) return { ok: false as const, code: 'out' as const };
    this.pings.set(seat.team, (this.pings.get(seat.team) ?? 0) + 1);
    return { ok: true as const };
  }

  report(team: QuadTeam) {
    return { outcome: this.outcome(team), pings: this.pings.get(team) ?? 0 };
  }

  events() {
    return [];
  }

  setSeatInfo(): void {}

  end(outcomes: Partial<Record<QuadTeam, FinalOutcome>>, ranks: Partial<Record<QuadTeam, number>>): void {
    this.ended = { outcomes, ranks };
  }

  forfeit(team: QuadTeam): void {
    this.forfeits.push([this.tick, team]);
  }
}

/** Every adapter `quadDefinition` created, newest last. */
export const games: QuadGame[] = [];

export const quadDefinition: GameDefinition<QuadManifest> = {
  manifest: quadManifest,
  create({ teams, alliances }) {
    const game = new QuadGame(alliances ? { teams, alliances } : { teams });
    games.push(game);
    return game;
  },
  createBot: (_seat, level) => ({ think: () => (level === 'pinger' ? [{ kind: 'ping' as const }] : []) }),
};
