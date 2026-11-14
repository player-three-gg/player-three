/**
 * Trace plumbing shared by the operator console and the player API: per-session memory of recent trace events,
 * last observations, policy call timings and practice runs, plus Server-Sent Event subscribers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PolicyStatus } from '../control.ts';
import type { PlayerThreeHost, PlayerThreeMatch, PlayerThreeTraceEvent } from '../host/types.ts';

/**
 * Bytes an SSE subscriber may leave unread before it is disconnected. A client that stops reading would otherwise
 * grow the server's write buffer without bound (every trace event of a fast session, per open stream).
 */
export const MAX_SSE_BUFFERED_BYTES = 256 * 1024;

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

/** Seat-scoped events go to that seat's team only; session-level ones are filtered/trimmed per team. */
export function forTeam(e: PlayerThreeTraceEvent, team: string): PlayerThreeTraceEvent | undefined {
  switch (e.type) {
    case 'match_created':
      return { ...e, seats: e.seats.filter((s) => s.team === team) };
    case 'match_ended':
      return e;
    case 'guard_drop':
      return e.team === undefined || e.team === team ? e : undefined;
    default:
      return e.team === team ? e : undefined;
  }
}

/** A seat's policy stats, or null when the game has no policy mode. */
export async function policyStats(m: PlayerThreeMatch, team: string, role: string): Promise<PolicyStatus | null> {
  try {
    return await m.seat(team, role).policyStatus();
  } catch {
    return null;
  }
}

export interface SessionLog {
  events: PlayerThreeTraceEvent[];
  /** Last delivered observation per `team/role`. */
  lastObs: Map<string, PlayerThreeTraceEvent>;
  /** Recent practice runs (all teams; filtered on read). */
  practice: PlayerThreeTraceEvent[];
  /** Recent policy calls per `team/role` (timings sparkline). */
  calls: Map<string, PlayerThreeTraceEvent[]>;
}

interface Subscriber {
  session: string;
  /** undefined: every side (operator). */
  team: string | undefined;
  res: ServerResponse;
  status: (m: PlayerThreeMatch) => unknown;
  project?: (event: PlayerThreeTraceEvent) => PlayerThreeTraceEvent | undefined;
  valid?: () => boolean;
  /** Observations are coalesced per seat to ≤ 4/s so a fast game cannot flood the page. */
  pendingObs: Map<string, PlayerThreeTraceEvent>;
}

export class TraceHub {
  private readonly host: PlayerThreeHost;
  private readonly historySize: number;
  private readonly logs = new Map<string, SessionLog>();
  private readonly subs = new Set<Subscriber>();
  private readonly unsubscribe: () => void;
  private readonly pump: NodeJS.Timeout;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(host: PlayerThreeHost, historySize: number) {
    this.host = host;
    this.historySize = historySize;
    this.unsubscribe = host.onTrace((e) => this.record(e));
    this.pump = setInterval(() => {
      for (const s of this.subs) {
        for (const e of s.pendingObs.values()) this.send(s, 'trace', e);
        s.pendingObs.clear();
      }
    }, 250);
    this.pump.unref();
    this.heartbeat = setInterval(() => {
      for (const s of this.subs) {
        const m = this.host.getMatch(s.session);
        if (m) this.send(s, 'status', s.status(m));
        else {
          // The host no longer holds the session: end the stream so clients stop waiting for it.
          this.subs.delete(s);
          s.res.end();
        }
      }
    }, 1000);
    this.heartbeat.unref();
  }

  log(session: string): SessionLog {
    let l = this.logs.get(session);
    if (!l) {
      l = { events: [], lastObs: new Map(), practice: [], calls: new Map() };
      this.logs.set(session, l);
      // Forget sessions the host no longer holds (bounded memory on long-lived servers).
      const live = new Set(this.host.matches().map((m) => m.id));
      for (const id of this.logs.keys()) if (id !== session && !live.has(id)) this.logs.delete(id);
    }
    return l;
  }

  private record(e: PlayerThreeTraceEvent): void {
    const log = this.log(e.match);
    if (e.type === 'observe') log.lastObs.set(`${e.team}/${e.role}`, e);
    else if (e.type === 'practice') {
      log.practice.push(e);
      if (log.practice.length > 20) log.practice.shift();
    } else if (e.type === 'policy_call') {
      const key = `${e.team}/${e.role}`;
      const list = log.calls.get(key) ?? [];
      list.push(e);
      if (list.length > 120) list.shift();
      log.calls.set(key, list);
    }
    if (e.type !== 'observe' && e.type !== 'policy_call') {
      log.events.push(e);
      if (log.events.length > this.historySize) log.events.splice(0, log.events.length - this.historySize);
    }
    for (const s of this.subs) {
      if (s.session !== e.match) continue;
      const v = s.team === undefined ? e : forTeam(e, s.team);
      if (!v) continue;
      if (v.type === 'observe') s.pendingObs.set(`${v.team}/${v.role}`, v);
      else this.send(s, 'trace', v);
    }
  }

  private send(s: Subscriber, event: string, data: unknown): void {
    if (s.valid && !s.valid()) {
      this.subs.delete(s);
      s.pendingObs.clear();
      s.res.end();
      return;
    }
    if (event === 'trace' && s.project) {
      data = s.project(data as PlayerThreeTraceEvent);
      if (data === undefined) return;
    }
    if (s.res.destroyed) {
      this.subs.delete(s);
      return;
    }
    if (s.res.writableLength > MAX_SSE_BUFFERED_BYTES) {
      this.subs.delete(s);
      s.pendingObs.clear();
      s.res.destroy();
      return;
    }
    s.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Answer with an SSE stream of the session's trace (one side, or all with `team` undefined). */
  stream(req: IncomingMessage, res: ServerResponse, m: PlayerThreeMatch, team: string | undefined, status: (m: PlayerThreeMatch) => unknown, access?: { project(event: PlayerThreeTraceEvent): PlayerThreeTraceEvent | undefined; valid(): boolean }): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    res.flushHeaders();
    const s: Subscriber = { session: m.id, team, res, status, pendingObs: new Map(), ...access };
    this.subs.add(s);
    this.send(s, 'status', status(m));
    req.on('close', () => this.subs.delete(s));
  }

  close(): void {
    this.unsubscribe();
    clearInterval(this.pump);
    clearInterval(this.heartbeat);
    for (const s of this.subs) s.res.end();
    this.subs.clear();
  }
}
