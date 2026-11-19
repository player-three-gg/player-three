/** Tag simulation + PlayerThree adapter. Deterministic for a given seed and intent sequence. */
import type { ApplyResult, Controller, MandateOf, EventOf, GameAdapter, ObservationOf, Outcome, ReportOf, Seat, ViewOf } from 'playerthree';
import { MAX_TICKS, ROLES, SIZE, TEAMS, WIN_CAPTURES, manifest, type TagManifest } from './manifest.ts';

type Team = (typeof TEAMS)[number];
type Role = (typeof ROLES)[number];
type TagEvent = EventOf<TagManifest>;
type Intent = { kind: 'move'; x: number; y: number } | { kind: 'stop' } | { kind: 'dash' };

/** Cells within this Chebyshev distance of your own base are off-limits unless you carry the enemy flag. */
const BASE_ZONE = 2;
const STEP_TICKS = 2;
const DASH_TICKS = 10;
const DASH_COOLDOWN = 60;
const RESPAWN_TICKS = 20;
const VISION = 5;
const MAX_EVENTS = 256;

interface Piece {
  team: Team;
  role: Role;
  x: number;
  y: number;
  target: { x: number; y: number } | null;
  carrying: boolean;
  respawnAt: number;
  dashUntil: number;
  dashReadyAt: number;
}

interface TeamStats {
  captures: number;
  flagPickups: number;
  tagsMade: number;
  timesTagged: number;
}

const other = (team: Team): Team => (team === 'blue' ? 'red' : 'blue');
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
/** True when (x) is on `team`'s half. */
const onHalf = (team: Team, x: number): boolean => (team === 'blue' ? x < SIZE / 2 : x >= SIZE / 2);

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export class TagGame implements GameAdapter<TagManifest> {
  readonly manifest = manifest;
  tick = 0;
  readonly bases: Record<Team, { x: number; y: number }>;
  readonly pieces: Piece[];
  readonly stats: Record<Team, TeamStats> = {
    blue: { captures: 0, flagPickups: 0, tagsMade: 0, timesTagged: 0 },
    red: { captures: 0, flagPickups: 0, tagsMade: 0, timesTagged: 0 },
  };
  private readonly eventLog: TagEvent[] = [];
  private readonly seatInfo = new Map<string, { controller: Controller; mandate: MandateOf<TagManifest> }>();
  /** Outcomes the host declared when it ended the session early (`PlayerThreeMatch.end`). */
  private ended: Record<Team, Exclude<Outcome, 'running'>> | null = null;

  constructor(seed: number) {
    const row = 2 + Math.floor(rng(seed)() * (SIZE - 4));
    this.bases = { blue: { x: 0, y: row }, red: { x: SIZE - 1, y: SIZE - 1 - row } };
    this.pieces = TEAMS.flatMap((team) =>
      ROLES.map((role): Piece => ({
        team,
        role,
        ...this.spawn(team, role),
        target: null,
        carrying: false,
        respawnAt: 0,
        dashUntil: 0,
        dashReadyAt: 0,
      })),
    );
  }

  /** Spawn points sit just outside the base zone: the guard in front of the base, the runner off to the side. */
  private spawn(team: Team, role: Role): { x: number; y: number } {
    const b = this.bases[team];
    const dx = team === 'blue' ? BASE_ZONE + 1 : -(BASE_ZONE + 1);
    if (role === 'guard') return { x: b.x + dx, y: b.y };
    return { x: b.x + dx, y: Math.min(SIZE - 1, Math.max(0, b.y + (b.y < SIZE / 2 ? -3 : 3))) };
  }

  private piece(seat: Seat<TagManifest>): Piece {
    return this.pieces.find((p) => p.team === seat.team && p.role === seat.role)!;
  }

  private emit(kind: TagEvent['kind'], team: Team, role: Role): void {
    this.eventLog.push({ tick: this.tick, kind, team, role });
    if (this.eventLog.length > MAX_EVENTS) this.eventLog.shift();
  }

  /** Where `team`'s flag is: carried by an enemy piece or at home. */
  private flagOf(team: Team): { team: Team; x: number; y: number; carried: boolean } {
    const carrier = this.pieces.find((p) => p.team !== team && p.carrying);
    const at = carrier ?? this.bases[team];
    return { team, x: at.x, y: at.y, carried: carrier !== undefined };
  }

  private over(): boolean {
    return this.stats.blue.captures >= WIN_CAPTURES || this.stats.red.captures >= WIN_CAPTURES || this.tick >= MAX_TICKS;
  }

  step(): void {
    if (this.over()) return;
    this.tick++;
    for (const p of this.pieces) {
      if (p.respawnAt > 0) {
        if (this.tick >= p.respawnAt) {
          p.respawnAt = 0;
          Object.assign(p, this.spawn(p.team, p.role));
        }
        continue;
      }
      const every = this.tick < p.dashUntil ? 1 : STEP_TICKS;
      if (p.target && this.tick % every === 0) {
        const x = p.x + Math.sign(p.target.x - p.x);
        const y = p.y + Math.sign(p.target.y - p.y);
        // Your own base zone is off-limits unless you bring the enemy flag home (no flag camping); leaving is always allowed.
        const base = this.bases[p.team];
        const next = cheb({ x, y }, base);
        if (p.carrying || next > BASE_ZONE || next > cheb(p, base)) {
          p.x = x;
          p.y = y;
        }
        if (p.x === p.target.x && p.y === p.target.y) p.target = null;
      }
    }
    // Tags: a live piece on the enemy half next to a live enemy is tagged (both can be tagged at the midline).
    const live = this.pieces.filter((p) => p.respawnAt === 0);
    const tagged = live.filter((p) => !onHalf(p.team, p.x) && live.some((e) => e.team !== p.team && cheb(p, e) <= 1));
    for (const p of tagged) {
      if (p.carrying) {
        p.carrying = false;
        this.emit('flag_returned', p.team, p.role);
      }
      p.respawnAt = this.tick + RESPAWN_TICKS;
      p.target = null;
      this.stats[p.team].timesTagged++;
      this.stats[other(p.team)].tagsMade++;
      this.emit('tagged', p.team, p.role);
    }
    for (const p of live) {
      if (p.respawnAt > 0) continue;
      const enemyBase = this.bases[other(p.team)];
      if (!p.carrying && p.x === enemyBase.x && p.y === enemyBase.y && !this.flagOf(other(p.team)).carried) {
        p.carrying = true;
        this.stats[p.team].flagPickups++;
        this.emit('flag_taken', p.team, p.role);
      } else if (p.carrying && p.x === this.bases[p.team].x && p.y === this.bases[p.team].y) {
        p.carrying = false;
        this.stats[p.team].captures++;
        this.emit('captured', p.team, p.role);
      }
    }
  }

  outcome(team: Team): Outcome {
    if (this.ended) return this.ended[team];
    const mine = this.stats[team].captures;
    const theirs = this.stats[other(team)].captures;
    // Decided when a team reaches WIN_CAPTURES (simultaneous final captures compare totals) or time runs out.
    if (mine < WIN_CAPTURES && theirs < WIN_CAPTURES && this.tick < MAX_TICKS) return 'running';
    return mine > theirs ? 'win' : mine < theirs ? 'loss' : 'draw';
  }

  end(outcomes: Partial<Record<Team, Exclude<Outcome, 'running'>>>): void {
    // The host declares every match team; Tag matches always have both.
    this.ended = { blue: outcomes.blue!, red: outcomes.red! };
  }

  private visibleTo(team: Team): Piece[] {
    const eyes = this.pieces.filter((p) => p.team === team && p.respawnAt === 0);
    return this.pieces.filter((p) => p.team !== team && p.respawnAt === 0 && eyes.some((e) => cheb(e, p) <= VISION));
  }

  view(team: Team): ViewOf<TagManifest> {
    const visible = new Set<Piece>([...this.pieces.filter((p) => p.team === team), ...this.visibleTo(team)]);
    return {
      tick: this.tick,
      pieces: [...visible].map((p) => ({ team: p.team, role: p.role, x: p.x, y: p.y, carrying: p.carrying, respawning: p.respawnAt > 0 })),
      flags: TEAMS.map((t) => this.flagOf(t)),
      score: { blue: this.stats.blue.captures, red: this.stats.red.captures },
      seats: ROLES.map((role) => ({ role, controller: this.seatInfo.get(`${team}/${role}`)?.controller ?? 'none' })),
    };
  }

  observe(seat: Seat<TagManifest>, sinceTick: number): ObservationOf<TagManifest> {
    const me = this.piece(seat);
    const pub = (p: Piece) => ({ role: p.role, x: p.x, y: p.y, carrying: p.carrying, respawning: p.respawnAt > 0 });
    return {
      tick: this.tick,
      team: seat.team,
      you: pub(me),
      dashReady: me.role === 'runner' && this.tick >= me.dashReadyAt,
      allies: this.pieces.filter((p) => p.team === seat.team && p !== me).map(pub),
      enemies: this.visibleTo(seat.team).map((p) => ({ role: p.role, x: p.x, y: p.y, carrying: p.carrying })),
      flags: TEAMS.map((t) => this.flagOf(t)),
      bases: TEAMS.map((t) => ({ team: t, ...this.bases[t] })),
      score: { mine: this.stats[seat.team].captures, theirs: this.stats[other(seat.team)].captures },
      directive: this.seatInfo.get(`${seat.team}/${seat.role}`)?.mandate.directive ?? { stance: 'balanced' },
      events: this.events(seat, sinceTick).slice(-32),
    };
  }

  apply(seat: Seat<TagManifest>, intent: Intent): ApplyResult<TagManifest> {
    const p = this.piece(seat);
    if (p.respawnAt > 0) return { ok: false, code: 'respawning' };
    switch (intent.kind) {
      case 'move':
        p.target = { x: intent.x, y: intent.y };
        return { ok: true };
      case 'stop':
        p.target = null;
        return { ok: true };
      case 'dash':
        if (this.tick < p.dashReadyAt) return { ok: false, code: 'cooldown' };
        p.dashUntil = this.tick + 1 + DASH_TICKS;
        p.dashReadyAt = this.tick + DASH_COOLDOWN;
        return { ok: true };
    }
  }

  report(team: Team): ReportOf<TagManifest> {
    const s = this.stats[team];
    return {
      outcome: this.outcome(team),
      ticks: this.tick,
      captures: s.captures,
      conceded: this.stats[other(team)].captures,
      flagPickups: s.flagPickups,
      tagsMade: s.tagsMade,
      timesTagged: s.timesTagged,
    };
  }

  events(_seat: Seat<TagManifest>, sinceTick: number): TagEvent[] {
    return this.eventLog.filter((e) => e.tick > sinceTick);
  }

  setSeatInfo(seat: Seat<TagManifest>, info: { controller: Controller; mandate: MandateOf<TagManifest> }): void {
    this.seatInfo.set(`${seat.team}/${seat.role}`, info);
  }
}
