/**
 * A two-team squad game with team signals: `scout`, `medic` and `gunner` per team. The vocabulary is one `request`
 * kind (`need: heal | cover | scan`, optional point and target); the medic answers heal, the gunner cover, the scout
 * scan. Built-in bots: `helper` answers every request it receives (ack, then done on its next decision); `asker`
 * additionally asks for a heal from the scout seat at its first decision. The game itself never sees signals.
 */
import { defineManifest, signalSchemas, t, type GameAdapter, type GameDefinition, type MatchSides, type Seat, type SignalLimits } from '../src/index.ts';

export const SQUAD_ROLES = ['scout', 'medic', 'gunner'] as const;
const team = t.enum(['blue', 'red']);
const roles = t.enum(SQUAD_ROLES);

export const squadSignals = {
  kinds: {
    request: {
      roles: ['scout', 'medic', 'gunner'],
      params: {
        need: t.enum(['heal', 'cover', 'scan']),
        x: t.opt(t.int(0, 63)),
        y: t.opt(t.int(0, 63)),
        target: t.opt(t.id('e')),
      },
      doc: 'Ask a teammate for help at a point or on a unit.',
    },
  },
  cards: {
    medic: [{ kind: 'request', where: { need: ['heal'] } }],
    gunner: [{ kind: 'request', where: { need: ['cover'] } }],
    scout: [{ kind: 'request', where: { need: ['scan'] } }],
  },
} as const;

export const SQUAD_LIMITS: SignalLimits = { perSecond: 1, burst: 3, maxOpen: 3, ttlTicks: 50, keepTicks: 20 };
const signals = signalSchemas(SQUAD_ROLES, squadSignals, SQUAD_LIMITS);

export const squadManifest = defineManifest({
  id: 'squad',
  version: '1.0.0',
  title: 'Squad',
  doc: 'Three seats per team ask each other for help.',
  roleDocs: { scout: 'Scout: scans.', medic: 'Medic: heals.', gunner: 'Gunner: covers.' },
  tickRate: 10,
  teams: team,
  roles,
  intents: {
    wave: { roles: [...SQUAD_ROLES], params: {}, doc: 'Wave.' },
    ...signals.intents,
  },
  observation: t.obj({ tick: t.int(0, 1_000_000), team, waves: t.int(0, 1_000_000), signals: signals.observation }),
  view: t.obj({ tick: t.int(0, 1_000_000), team, signals: signals.view }),
  directive: t.obj({ stance: t.enum(['any']) }),
  errors: t.enum(['nope']),
  event: t.obj({ tick: t.int(0, 1_000_000), kind: t.enum(['waved']) }),
  opponents: t.enum(['idle', 'helper', 'asker']),
  report: t.obj({ waves: t.int(0, 1_000_000) }),
  skills: [],
  topics: {},
  control: {
    intents: { perSecond: 100, burst: 100 },
    policy: { runtimes: ['js'], hz: 10, msPerCall: 50, memoryBytes: 16 << 20, maxArtifactBytes: 64 * 1024, maxIntentsPerCall: 8, maxLogLines: 10, maxLogLineBytes: 200 },
    practice: { maxTicks: 200, concurrent: 2 },
    chat: { maxTellChars: 200, maxSayChars: 100 },
    signals: SQUAD_LIMITS,
  },
  signals: squadSignals,
});
export type SquadManifest = typeof squadManifest;

export class SquadGame implements GameAdapter<SquadManifest> {
  readonly manifest = squadManifest;
  tick = 0;
  readonly waves = new Map<string, number>();
  /** Test switch: this match's signal limits (`undefined`: the manifest's; `null`: off). */
  limits: SignalLimits | null | undefined;
  readonly sides: MatchSides<SquadManifest>;

  constructor(sides: MatchSides<SquadManifest>, limits: SignalLimits | null | undefined) {
    this.sides = sides;
    this.limits = limits;
  }

  step(): void { this.tick++; }
  outcome() { return 'running' as const; }
  view(team: 'blue' | 'red') { return { tick: this.tick, team }; }
  observe(seat: Seat<SquadManifest>) { return { tick: this.tick, team: seat.team, waves: this.waves.get(seat.team) ?? 0 }; }
  apply(seat: Seat<SquadManifest>) {
    this.waves.set(seat.team, (this.waves.get(seat.team) ?? 0) + 1);
    return { ok: true as const };
  }
  report(team: 'blue' | 'red') { return { waves: this.waves.get(team) ?? 0 }; }
  events() { return []; }
  setSeatInfo(): void {}
  clone(): SquadGame {
    const copy = new SquadGame(this.sides, this.limits);
    copy.tick = this.tick;
    for (const [k, v] of this.waves) copy.waves.set(k, v);
    return copy;
  }
}

/** Per-match limits the next created games report through `signalLimits()` (reset by tests). */
export const squadMatchLimits: { value: SignalLimits | null | undefined } = { value: undefined };

type Obs = { signals: { inbox: { id: string; state: string; need: string }[]; sent: { id: string; state: string }[] } };

/** `helper` / `asker` bot: answers its inbox (ack, then done next decision); `asker` scouts ask for a heal once. */
function squadBot(seat: Seat<SquadManifest>, level: string) {
  let asked = false;
  return {
    think(obs: Obs) {
      if (level === 'idle') return [];
      const out: unknown[] = [];
      for (const s of obs.signals.inbox) {
        if (s.state === 'submitted') out.push({ kind: 'signal_update', id: s.id, update: 'ack' });
        else if (s.state === 'working') out.push({ kind: 'signal_update', id: s.id, update: 'done' });
      }
      if (level === 'asker' && seat.role === 'scout' && !asked) {
        asked = true;
        out.push({ kind: 'signal', signal: { kind: 'request', to: 'medic', need: 'heal', x: 3, y: 4 } });
      }
      return out as never[];
    },
  };
}

export const squadDefinition: GameDefinition<SquadManifest> = {
  manifest: squadManifest,
  create({ teams }) {
    const game = new SquadGame({ teams }, squadMatchLimits.value);
    if (game.limits !== undefined) {
      const limits = game.limits;
      (game as GameAdapter<SquadManifest>).signalLimits = () => limits;
    }
    return game;
  },
  createBot: (seat, level) => squadBot(seat, level) as never,
};
