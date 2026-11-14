/**
 * Owner-private player console. Profile authentication defaults to the named commander roster; live data requires
 * an explicit commander + exact seat selection. Human capabilities see exactly their seat. Trusted private team
 * capabilities retain team console access. Agent, spectator and observer capabilities never grant console rights.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PolicyStatus } from '../control.ts';
import type { PlayerThreeHost, PlayerThreeMatch, PlayerThreeTraceEvent, CommanderStatus, ReadinessState, SeatInfo } from '../host/types.ts';
import type { AnyManifest, Outcome } from '../manifest.ts';
import { forTeam, json, policyStats, TraceHub } from './trace.ts';

/** Options of the player API. */
export interface PlayerApiOptions {
  /** Mount path. Default `/playerthree/player`. */
  path?: string;
  /** Trace events kept per session for late joiners. Default 600. */
  history?: number;
  /** Resolve the game's authenticated host profile, never an owner id supplied in a URL or body. */
  owner?: (req: IncomingMessage) => string | undefined | Promise<string | undefined>;
}

/** A framework-neutral player API request handler: `handle` resolves false for requests outside its mount path. */
export interface PlayerApiHandler {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): void;
}

/** Profile-authenticated live selection. Every component must match the commander's current execution lease. */
export interface PlayerConsoleTarget {
  commander: string;
  match: string;
  team: string;
  role: string;
}

/** `GET <path>/state`; selection uses `?commander=…&match=…&team=…&role=…`. */
export interface PlayerState {
  game: { id: string; title: string; version: string; tickRate: number; policy: unknown };
  match: string | null;
  team: string | null;
  target: PlayerConsoleTarget | null;
  tick: number;
  outcome: Outcome | null;
  seats: SeatInfo[];
  readiness: Record<string, ReadinessState>;
  /** Live maps are keyed by exact role within the single selected side, never by commander identity. */
  observations: Record<string, PlayerThreeTraceEvent>;
  policies: Record<string, PolicyStatus | null>;
  calls: Record<string, PlayerThreeTraceEvent[]>;
  practice: PlayerThreeTraceEvent[];
  events: PlayerThreeTraceEvent[];
  /** Owner-private connection/library data only, never observer or opponent channels. */
  commanders?: CommanderStatus[];
}

type Live = { match: PlayerThreeMatch; team: string; role?: string; valid(): boolean };
type Caller = { kind: 'capability'; live: Live } | { kind: 'owner'; owner: string; target?: PlayerConsoleTarget };

/** The owner-private player API (`GET <path>/state`, `GET <path>/stream`) that `@playerthree/console` reads. */
export function createPlayerApiHandler<M extends AnyManifest>(typedHost: PlayerThreeHost<M>, opts: PlayerApiOptions = {}): PlayerApiHandler {
  const host = typedHost as unknown as PlayerThreeHost;
  const base = (opts.path ?? '/playerthree/player').replace(/\/+$/, '');
  const hub = new TraceHub(host, opts.history ?? 600);

  function selected(owner: string, target: PlayerConsoleTarget): Live | undefined {
    const valid = () => {
      if (!host.commanders.has(owner)) return false;
      const commander = host.commanders.roster(owner).find((c) => c.id === target.commander);
      const seat = commander?.seated;
      const match = host.getMatch(target.match);
      return !!match && !!commander && match.coachingAllowed(owner) && commander.roles.includes(target.role) &&
        seat?.match === target.match && seat.team === target.team && seat.roles.includes(target.role);
    };
    const match = host.getMatch(target.match);
    return match && valid() ? { match, team: target.team, role: target.role, valid } : undefined;
  }

  const liveFor = (caller: Caller): Live | undefined => caller.kind === 'capability' ? caller.live :
    caller.target ? selected(caller.owner, caller.target) : undefined;
  const seatsFor = (live: Live) => live.match.seats().filter((s) => s.team === live.team && (live.role === undefined || s.role === live.role));
  const status = (live: Live) => ({
    tick: live.match.tick, outcome: live.match.outcome(live.team), seats: seatsFor(live),
    readiness: Object.fromEntries(live.match.readiness().seats
      .filter((s) => s.team === live.team && (live.role === undefined || s.role === live.role))
      .map((s) => [s.role, s.state])),
  });

  function project(event: PlayerThreeTraceEvent, live: Live): PlayerThreeTraceEvent | undefined {
    const value = forTeam(event, live.team);
    if (!value) return undefined;
    if (value.type === 'match_created') return { ...value, seats: value.seats.filter((s) => live.role === undefined || s.role === live.role) };
    if (value.type === 'match_ended') return { ...value, outcomes: { [live.team]: value.outcomes[live.team]! }, ranks: { [live.team]: value.ranks[live.team]! } };
    // Unattributed guard events are operator diagnostics, not private player-console events.
    if (!('team' in value) || value.team !== live.team) return undefined;
    return live.role !== undefined && (!('role' in value) || value.role !== live.role) ? undefined : value;
  }

  async function state(caller: Caller): Promise<PlayerState> {
    const d = host.definition.manifest;
    const game = { id: d.id, title: d.title, version: d.version, tickRate: d.tickRate, policy: d.control.policy ?? null };
    const live = liveFor(caller);
    const commanders = caller.kind === 'owner' ? { commanders: host.commanders.roster(caller.owner) } : {};
    const target = caller.kind === 'owner' ? caller.target ?? null : null;
    if (target && !live) throw new Error('Private seat authorization changed');
    if (!live) return { game, match: null, team: null, target, tick: 0, outcome: null, seats: [], readiness: {}, observations: {}, policies: {}, calls: {}, practice: [], events: [], ...commanders };
    const { match: m, team } = live;
    const log = hub.log(m.id);
    const policies: Record<string, PolicyStatus | null> = {};
    const calls: Record<string, PlayerThreeTraceEvent[]> = {};
    const observations: Record<string, PlayerThreeTraceEvent> = {};
    for (const seat of seatsFor(live)) {
      const key = `${seat.team}/${seat.role}`;
      policies[seat.role] = await policyStats(m, seat.team, seat.role);
      calls[seat.role] = log.calls.get(key) ?? [];
      const observation = log.lastObs.get(key);
      if (observation) observations[seat.role] = observation;
    }
    if (!live.valid()) throw new Error('Private seat authorization changed');
    return {
      game, match: m.id, team, target, ...status(live), observations, policies, calls,
      practice: log.practice.map((e) => project(e, live)).filter((e) => e !== undefined),
      events: log.events.map((e) => project(e, live)).filter((e) => e !== undefined), ...commanders,
    };
  }

  async function authorize(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<Caller | undefined> {
    const token = /^Bearer ([A-Za-z0-9_-]{1,64})$/.exec(req.headers.authorization ?? '')?.[1];
    const auth = token ? host.authenticate(token) : undefined;
    const keys = ['commander', 'match', 'team', 'role'] as const;
    const hasTarget = keys.some((key) => query.has(key));
    if (auth) {
      const p = auth.principal;
      if (!hasTarget && (p.kind === 'team' || p.kind === 'human')) return {
        kind: 'capability', live: { match: auth.match, team: p.team, ...(p.kind === 'human' ? { role: p.role } : {}),
          valid: () => !!token && host.authenticate(token)?.principal === p },
      };
      json(res, 403, { error: 'forbidden' });
      return undefined;
    }
    let owner: string | undefined;
    try { owner = await opts.owner?.(req); } catch { owner = undefined; }
    if (owner === undefined) {
      json(res, 401, { error: 'bad_token' });
      return undefined;
    }
    host.commanders.ensure(owner);
    if (hasTarget) {
      if (keys.some((key) => query.getAll(key).length !== 1 || !query.get(key))) {
        json(res, 400, { error: 'bad_message' });
        return undefined;
      }
      const target: PlayerConsoleTarget = { commander: query.get('commander')!, match: query.get('match')!, team: query.get('team')!, role: query.get('role')! };
      if (!selected(owner, target)) {
        json(res, 403, { error: 'forbidden' });
        return undefined;
      }
      return { kind: 'owner', owner, target };
    }
    return { kind: 'owner', owner };
  }

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://player.invalid');
      if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'bad_message' }); return true; }
      const sub = url.pathname.slice(base.length);
      if (sub !== '/state' && sub !== '/stream') { json(res, 404, { error: 'bad_message' }); return true; }
      const who = await authorize(req, res, url.searchParams);
      if (!who) return true;
      if (sub === '/stream') {
        const live = liveFor(who);
        if (!live) { json(res, 409, { error: 'not_in_match' }); return true; }
        hub.stream(req, res, live.match, live.team, () => status(live), {
          project: (event) => project(event, live), valid: live.valid,
        });
        return true;
      }
      try { json(res, 200, await state(who)); } catch { json(res, 403, { error: 'forbidden' }); }
      return true;
    },
    close() { hub.close(); },
  };
}
