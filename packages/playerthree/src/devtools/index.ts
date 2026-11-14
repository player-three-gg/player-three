/**
 * PlayerThree DevTools — the operator console: one self-contained page on the game server where the game's developers and
 * operators see and control what agents do, in development and in production. Players never get in (see access.ts
 * for the access modes and the threat model); a player's view of their own agents is the separate player API
 * (player.ts).
 *
 * GET  <path>                                the page (static; no data, no external assets, strict CSP)
 * GET  <path>/api/overview                   game, sessions, active agents, rejections/policy errors (last 15 min)
 * GET  <path>/api/sessions                   sessions the host holds (live and ended) + recent (released) sessions
 * GET  <path>/api/sessions/<id>/state        one session, every side: seats, observations, policies, recent trace
 * GET  <path>/api/sessions/<id>/stream       live trace (Server-Sent Events)
 * GET  <path>/api/sessions/<id>/view         ?perspective=god|side:<team>|seat:<team>/<role>
 * GET  <path>/api/sessions/<id>/scrub        ?tick=&perspective= (isolated re-simulation; never touches the session)
 * GET  <path>/api/sessions/<id>/replay       deterministic replay file (download)
 * POST <path>/api/sessions/<id>/end          { outcomes: 'draw' | { [team|alliance]: 'win'|'loss'|'draw' } | { [team|alliance]: placement } }
 * GET  <path>/api/recent/<id>                a released session's record (host.history)
 * GET  <path>/api/recent/<id>/scrub          ?tick=&perspective= ; GET <path>/api/recent/<id>/replay (download)
 * POST <path>/api/replays                    upload an exported replay; GET <path>/api/replays/<key>/scrub
 * GET  <path>/api/agents                     ?q=&limit= every owner's commanders and sign-in connections
 * POST <path>/api/agents/rotate              { owner, commander } new commander token (the old one stops working)
 * POST <path>/api/agents/revoke              { owner, connection } revoke a sign-in connection (needs `oauth`)
 * GET  <path>/api/policies                   commander libraries, the policy pool, policy error stats
 * GET  <path>/api/policies/package           ?owner=&commander=&version= one library version as a policy package (download)
 * POST <path>/api/policies/pool              { id, action: 'disable'|'enable'|'unpublish' }
 * GET  <path>/api/bench                      bench result directories (`benchResultsDir`); GET …/bench/<key>/report
 * POST <path>/api/bench/replay               { dir, path } open a bench replay for scrubbing (like an upload)
 * GET  <path>/api/safety                     surfaceHash, modes and limits, scopes, Safety Card, rejection stats
 * GET  <path>/api/settings                   match options schema, host defaults, options per live/recent session
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { canonicalJson, surfaceHash } from '../briefing.ts';
import { defaultScopes, SCOPES, type PolicyStatus } from '../control.ts';
import { createGuard } from '../guard.ts';
import { problemOf } from '../host/history.ts';
import { looseAdapter } from '../host/pipeline.ts';
import type { PlayerThreeHost, PlayerThreeMatch, PlayerThreeTraceEvent, CommanderStatus, PoolRecord, Replay, SessionRecord, TraceSource } from '../host/types.ts';
import { PlayerThreeError } from '../host/util.ts';
import { resolveDetail, type AnyManifest } from '../manifest.ts';
import type { AuthorizationServer, OwnedConnectionStatus } from '../mcp/oauth/server.ts';
import { toJsonSchema } from '../schema.ts';
import { createOperatorAccess, type OperatorAccessOptions, type RequestKind } from './access.ts';
import { BenchError, benchDirs, benchReplay, benchReport, benchSummary } from './bench.ts';
import { ReplayError, ReplayScrubber, REPLAY_LIMITS } from './replay.ts';
import { json, policyStats, TraceHub } from './trace.ts';
import { withSignals } from '../signals.ts';

export { createPlayerApiHandler, type PlayerApiHandler, type PlayerApiOptions, type PlayerConsoleTarget, type PlayerState } from './player.ts';
export type { OperatorAccessMode, OperatorAccessOptions } from './access.ts';

/** Options of the operator console: mount path, trace history and the access mode ({@link OperatorAccessOptions}). */
export interface DevtoolsOptions extends OperatorAccessOptions {
  /** Mount path. Default `/playerthree/devtools`. */
  path?: string;
  /** Trace events kept per session for late joiners. Default 600. */
  history?: number;
  /** Your MCP authorization server: lists every owner's sign-in connections and lets operators revoke them. */
  oauth?: AuthorizationServer;
  /**
   * Bench output directory (`playerthree-bench --out`): the console lists it and its immediate subdirectories that hold
   * a `results.json`, renders their reports and opens their replays in the timeline. Runs are started with the CLI.
   */
  benchResultsDir?: string;
  /** Path of the game's Safety Card (`playerthree audit … --out SAFETY.md`), shown in the Safety section. */
  safetyCard?: string;
}

/** A framework-neutral operator console request handler (see {@link createDevtoolsHandler}). */
export interface DevtoolsHandler {
  /** Handles the request if it is under the mount path; resolves false otherwise (nothing written). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Unsubscribe from the host and end open streams. */
  close(): void;
}

const asset = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
/** Images are inlined as data URIs: the page's CSP allows `img-src data:` only, so it stays self-contained. */
const dataUri = (name: string, type: string) => `data:${type};base64,${readFileSync(new URL(`./${name}`, import.meta.url)).toString('base64')}`;
const PAGE = { html: asset('page.html'), css: asset('page.css'), js: asset('page.js'), logo: dataUri('logo.webp', 'image/webp'), icon: dataUri('icon.png', 'image/png') };

/** Rejections and policy errors are counted over this window. */
const WINDOW_MINUTES = 15;
const WINDOW_MS = WINDOW_MINUTES * 60_000;
const MAX_PROBLEMS = 5000;
const MAX_BODY_BYTES = 4096;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const POOL_ID_RE = /^pol_[0-9]{1,9}$/;
const BENCH_KEY_RE = /^[0-9a-f]{16}$/;
/** Seats annotated with their agent's harness, per session (one lookup per seat). */
const MAX_ANNOTATED = 10_000;
interface Problem {
  at: number;
  kind: 'rejection' | 'policy_error';
  code: string;
  session: string;
  team: string;
  role: string;
  tick: number;
  owner: string | null;
  source?: TraceSource;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message?: string, extra: Record<string, unknown> = {}) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'invalid', 'Request body too large.');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid', 'Request body is not valid JSON.');
  }
}

const field = (body: unknown, name: string): unknown => (body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);

/** Top `limit` codes by count. */
function topCodes(problems: Iterable<Problem>, limit: number): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of problems) counts.set(p.code, (counts.get(p.code) ?? 0) + 1);
  return [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, limit);
}

/** Sum per-session code counts (history records) and keep the top `limit`. */
function mergeCodes(lists: Iterable<{ code: string; count: number }[]>, limit: number): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const list of lists) for (const c of list) counts.set(c.code, (counts.get(c.code) ?? 0) + c.count);
  return [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, limit);
}

/** The operator console as a request handler for any node:http stack; {@link mountDevtools} wires it into a server. */
export function createDevtoolsHandler<M extends AnyManifest>(typedHost: PlayerThreeHost<M>, opts: DevtoolsOptions = {}): DevtoolsHandler {
  // The console only reads game-agnostic data; erase the manifest type (deep generic assignability is expensive for tsc).
  const host = typedHost as unknown as PlayerThreeHost;
  const access = createOperatorAccess(opts);
  const base = (opts.path ?? '/playerthree/devtools').replace(/\/+$/, '');
  const manifest = host.definition.manifest;
  const teams: readonly string[] = manifest.teams.values;
  const roles: readonly string[] = manifest.roles.values;
  const hash = surfaceHash(manifest);
  const hub = new TraceHub(host, opts.history ?? 600);
  const scrubber = new ReplayScrubber(host.definition);
  /** Replays opened for scrubbing by key: uploads and bench replays (the last four). */
  const uploads = new Map<string, Replay>();
  let uploading = 0;
  /** Recent sessions' replays being scrubbed (the last four), so a seek does not re-read the history. */
  const recentReplays = new Map<string, Replay>();

  // ------------------------------------------------------------------ session lifetimes, problems, owners

  /** Wall-clock bounds of sessions seen while mounted. */
  const lifetimes = new Map<string, { createdAt: number | null; endedAt: number | null }>();
  const problems: Problem[] = [];
  /** `match\nteam\nrole` → owner of the exact seated commander; rebuilt after commander changes. */
  let seatOwners: Map<string, string> | undefined;

  const ownersBySeat = (): Map<string, string> => {
    if (seatOwners) return seatOwners;
    const map = new Map<string, string>();
    try {
      for (const owner of host.commanders.owners()) {
        for (const c of host.commanders.roster(owner)) if (c.seated) for (const role of c.seated.roles) map.set(`${c.seated.match}\n${c.seated.team}\n${role}`, owner);
      }
    } catch {
      // Host disposed: no owners.
    }
    seatOwners = map;
    return map;
  };
  const unsubscribeCommanders = host.commanders.onStatus(() => {
    seatOwners = undefined;
  });

  const prune = (now: number): void => {
    let drop = 0;
    while (drop < problems.length && problems[drop]!.at < now - WINDOW_MS) drop++;
    if (problems.length - drop > MAX_PROBLEMS) drop = problems.length - MAX_PROBLEMS;
    if (drop > 0) problems.splice(0, drop);
  };

  const unsubscribeTrace = host.onTrace((e: PlayerThreeTraceEvent) => {
    if (e.type === 'match_created') {
      lifetimes.set(e.match, { createdAt: e.at, endedAt: null });
      seatOwners = undefined;
      const live = new Set(host.matches().map((m) => m.id));
      for (const id of lifetimes.keys()) if (id !== e.match && !live.has(id)) lifetimes.delete(id);
      return;
    }
    if (e.type === 'match_ended') {
      const l = lifetimes.get(e.match);
      if (l) l.endedAt = e.at;
      else lifetimes.set(e.match, { createdAt: null, endedAt: e.at });
      return;
    }
    const p = problemOf(e);
    if (p) {
      problems.push({ ...p, at: e.at, session: e.match, tick: e.tick, owner: ownersBySeat().get(`${e.match}\n${p.team}\n${p.role}`) ?? null });
      prune(e.at);
    }
    // Only intents name their source: a seat that acted as an agent (`agent` / `stream`) gets its holder recorded.
    if (e.type === 'intent' && (e.source === 'agent' || e.source === 'stream')) annotate(e.match, e.team, e.role);
  });

  /**
   * Tell the host's session history who held a seat as an agent: the owner's active sign-in connections holding the
   * role (client name), else the commander token, else a per-match seat token. Once per seat per session.
   */
  const annotated = new Set<string>();
  function annotate(session: string, team: string, role: string): void {
    const key = `${session}\n${team}/${role}`;
    if (annotated.has(key)) return;
    if (annotated.size >= MAX_ANNOTATED) annotated.clear();
    annotated.add(key);
    const seat = host.getMatch(session)?.seats().find((s) => s.team === team && s.role === role);
    if (!seat) return;
    const owner = seat.commander ? ownersBySeat().get(`${session}\n${team}\n${role}`) : undefined;
    const labels: string[] = [];
    if (owner !== undefined) {
      for (const c of opts.oauth?.allConnections() ?? []) {
        const commander = host.commanders.roster(owner).find((entry) => entry.id === c.commander);
        if (c.active && c.roles.includes(role) && commander?.seated?.match === session && commander.seated.team === team && commander.seated.roles.includes(role)) labels.push(`${c.client.name}${c.client.softwareId ? ` (${c.client.softwareId})` : ''} · sign-in`);
      }
    }
    if (!labels.length) labels.push(owner !== undefined ? 'commander token' : 'seat token');
    for (const label of labels) host.history.annotate(session, team, role, label);
  }

  const recentProblems = (): Problem[] => {
    prune(Date.now());
    return problems;
  };

  // ------------------------------------------------------------------ sessions

  const statusOf = (m: PlayerThreeMatch): 'waiting' | 'running' | 'ended' => (m.over ? 'ended' : m.readyCheck()?.pending ? 'waiting' : 'running');
  const sessionStatus = (m: PlayerThreeMatch) => ({
    tick: m.tick,
    status: statusOf(m),
    teams: m.teams,
    alliances: m.alliances ?? null,
    outcomes: Object.fromEntries(m.teams.map((t) => [t, m.outcome(t)])),
    /** Final placements (competition ranking), only once the match is over. */
    ranks: m.over ? Object.fromEntries(m.teams.map((t) => [t, m.rank(t)])) : null,
    seats: m.seats(),
    /** No outcome ever: the game closes it (`dispose`), the console cannot end it. */
    persistent: m.persistent,
  });

  function sessionSummary(m: PlayerThreeMatch, owners: Map<string, string>, windowProblems: Problem[]) {
    const s = sessionStatus(m);
    const life = lifetimes.get(m.id);
    const seatOwner: Record<string, string> = {};
    for (const seat of s.seats) {
      const owner = owners.get(`${m.id}\n${seat.team}\n${seat.role}`);
      if (owner) seatOwner[`${seat.team}/${seat.role}`] = owner;
    }
    return {
      id: m.id,
      ...s,
      seconds: m.tick / manifest.tickRate,
      createdAt: life?.createdAt ?? null,
      endedAt: life?.endedAt ?? null,
      owners: seatOwner,
      activeAgents: s.seats.filter((x) => x.agentActive).length,
      rejections: windowProblems.filter((p) => p.session === m.id && p.kind === 'rejection').length,
    };
  }

  async function sessionState(m: PlayerThreeMatch) {
    const log = hub.log(m.id);
    const policies: Record<string, PolicyStatus | null> = {};
    const calls: Record<string, PlayerThreeTraceEvent[]> = {};
    const observations: Record<string, PlayerThreeTraceEvent> = {};
    for (const seat of m.seats()) {
      const key = `${seat.team}/${seat.role}`;
      policies[key] = await policyStats(m, seat.team, seat.role);
      calls[key] = log.calls.get(key) ?? [];
      const o = log.lastObs.get(key);
      if (o) observations[key] = o;
    }
    return {
      game: { id: manifest.id, title: manifest.title, version: manifest.version, tickRate: manifest.tickRate, policy: manifest.control.policy ?? null },
      session: m.id,
      ...sessionStatus(m),
      observations,
      policies,
      calls,
      practice: log.practice,
      events: log.events,
    };
  }

  function view(m: PlayerThreeMatch, perspective: string) {
    if (perspective === 'god') return { tick: m.tick, data: m.debugView() };
    if (perspective.startsWith('side:') && m.teams.includes(perspective.slice(5))) return { tick: m.tick, data: m.view(perspective.slice(5)) };
    const seat = m.seats().find((s) => perspective === `seat:${s.team}/${s.role}`);
    if (!seat) throw new HttpError(400, 'invalid', 'Unknown perspective.');
    return { tick: m.tick, observation: hub.log(m.id).lastObs.get(`${seat.team}/${seat.role}`) ?? null };
  }

  function end(m: PlayerThreeMatch, body: unknown) {
    if (m.persistent) throw new HttpError(409, 'persistent_session', 'This session is persistent: it has no outcome, so it cannot be ended here. The game closes it.');
    if (m.over) throw new HttpError(409, 'session_over', 'This session is already over.');
    const outcomes = field(body, 'outcomes');
    try {
      const final = m.end(outcomes as never);
      return { id: m.id, tick: m.tick, status: 'ended' as const, outcomes: final, ranks: Object.fromEntries(m.teams.map((t) => [t, m.rank(t)])) };
    } catch (error) {
      if (error instanceof PlayerThreeError && error.code === 'invalid') {
        // An alliance may be named after one of its own members; list each key once.
        const keys = new Set<string>([...m.teams, ...Object.keys(m.alliances ?? {})]);
        throw new HttpError(400, 'invalid', `outcomes must be 'draw', a win/loss/draw or a placement covering every team, keyed by team or alliance (${[...keys].join(', ')}).`);
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ replays

  const gameInfo = () => ({ id: manifest.id, title: manifest.title, version: manifest.version, tickRate: manifest.tickRate, policy: manifest.control.policy ?? null });

  async function upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    let reading = false;
    try {
      if (uploading >= 2) throw new ReplayError(429, 'Replay upload busy.');
      uploading++;
      reading = true;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > REPLAY_LIMITS.bytes) {
          req.resume();
          throw new ReplayError(413, 'Replay file too large: maximum 5 MiB.');
        }
        chunks.push(bytes);
      }
      const replay = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Replay;
      json(res, 200, await openReplay(replay, controller.signal));
    } catch (error) {
      if (!controller.signal.aborted) json(res, error instanceof ReplayError ? error.status : 400, { error: 'invalid', message: error instanceof Error ? error.message : 'Invalid replay.' });
    } finally {
      if (reading) uploading--;
      res.off('close', abort);
    }
  }

  /** Validate a replay by re-simulating tick 0 and keep it (with uploads, the last four) for scrubbing under a new key. */
  async function openReplay(replay: Replay, signal: AbortSignal) {
    if (replay?.ticks > REPLAY_LIMITS.ticks) throw new ReplayError(413, 'Replay too long: maximum 36,000 ticks.');
    const key = randomBytes(16).toString('hex');
    await scrubber.run(replay, 0, signal, key);
    if (uploads.size >= 4) {
      const oldest = uploads.keys().next().value!;
      uploads.delete(oldest);
      scrubber.forget(oldest);
    }
    uploads.set(key, replay);
    const seats = replay.teams.flatMap((team) => roles.map((role) => ({ team, role })));
    return { replay: key, ticks: replay.ticks, seats, game: gameInfo() };
  }

  interface ScrubSource {
    /** Scrubber timeline key. */
    key: string;
    replay(): Replay | undefined | Promise<Replay | undefined>;
    /** Recorded trace events near the tick (live sessions only). */
    events?: PlayerThreeTraceEvent[];
    missing: string;
    /** Live persistent sessions: their kept checkpoints (`PlayerThreeMatch.checkpoint`). */
    checkpoint?: PlayerThreeMatch['checkpoint'];
  }

  async function scrub(res: ServerResponse, params: URLSearchParams, source: ScrubSource): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    try {
      const replay = await source.replay();
      if (!replay) throw new ReplayError(404, source.missing);
      const rawTick = params.get('tick');
      if (rawTick === null || !/^\d+$/.test(rawTick)) throw new ReplayError(400, 'Invalid replay tick.');
      const perspective = params.get('perspective') ?? 'god';
      const seat = replay.teams.flatMap((team) => roles.map((role) => ({ team, role }))).find((s) => perspective === `seat:${s.team}/${s.role}`);
      const side = perspective.startsWith('side:') && replay.teams.includes(perspective.slice(5)) ? perspective.slice(5) : undefined;
      if (perspective !== 'god' && !side && !seat) throw new ReplayError(400, 'Invalid perspective.');
      const result = await scrubber.run(replay, Number(rawTick), controller.signal, source.key, source.checkpoint);
      const adapter = looseAdapter(result.adapter);
      let data: unknown;
      if (perspective === 'god') data = adapter.debugView?.() ?? null;
      else {
        const guard = createGuard({ onDrop: () => {} });
        // The replayed signal boards fill the host-owned `signals` member, as live.
        const board = result.signals;
        const checked = side
          ? guard.pass('view', manifest.view, board ? withSignals(adapter.view(side, { snapshot: true }), board.team(side)) : adapter.view(side, { snapshot: true }))
          // The seat's observation as an agent receives it by default (its role's detail).
          : guard.pass('observation', manifest.observation, board
            ? withSignals(adapter.observe(seat!, Math.max(-1, adapter.tick - 1), resolveDetail(manifest, seat!.role, undefined) ?? []), board.seat(seat!.team, seat!.role))
            : adapter.observe(seat!, Math.max(-1, adapter.tick - 1), resolveDetail(manifest, seat!.role, undefined) ?? []));
        if (!checked.ok) throw new ReplayError(500, 'Adapter returned an invalid perspective.');
        data = checked.value;
      }
      json(res, 200, {
        tick: adapter.tick,
        ticks: replay.ticks,
        /** First tick a persistent session still keeps (0 otherwise). */
        from: replay.window?.from ?? 0,
        paused: result.paused,
        data,
        entries: replay.entries.filter((e) => Math.abs(e[0] - adapter.tick) <= 1).slice(0, 200),
        events: (source.events ?? []).filter((e) => Math.abs(e.tick - adapter.tick) <= 1).slice(0, 200),
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        const status = error instanceof ReplayError ? error.status : 400;
        json(res, status, { error: status === 404 ? 'replay_not_found' : status === 429 ? 'busy' : 'invalid', message: error instanceof Error ? error.message : 'Invalid replay.' });
      }
    } finally {
      res.off('close', abort);
    }
  }

  // ------------------------------------------------------------------ recent sessions (host.history)

  const scrubbable = (r: SessionRecord): boolean => r.replay && r.gameVersion === manifest.version && r.from === 0;

  function recentSummary(r: SessionRecord) {
    return {
      id: r.id,
      status: 'released' as const,
      gameVersion: r.gameVersion,
      teams: r.teams,
      alliances: r.alliances,
      outcomes: r.outcomes,
      ranks: r.ranks,
      ticks: r.ticks,
      seconds: r.seconds,
      createdAt: r.createdAt,
      endedAt: r.endedAt,
      releasedAt: r.releasedAt,
      owners: r.owners,
      seats: r.seats,
      rejections: r.rejections,
      policyErrors: r.policyErrors,
      replay: r.replay,
      replayBytes: r.replayBytes,
      scrubbable: scrubbable(r),
    };
  }

  const recentRecord = (id: string): SessionRecord => {
    const r = ID_RE.test(id) ? host.history.get(id) : undefined;
    if (!r) throw new HttpError(404, 'session_not_found', 'This session is not in the recent history (pruned, or never released here).');
    return r;
  };

  async function recentReplay(id: string): Promise<Replay | undefined> {
    const cached = recentReplays.get(id);
    if (cached) return cached;
    const replay = await host.history.replay(id);
    if (!replay) return undefined;
    if (recentReplays.size >= 4) {
      const oldest = recentReplays.keys().next().value!;
      recentReplays.delete(oldest);
      scrubber.forget(`recent:${oldest}`);
    }
    recentReplays.set(id, replay);
    return replay;
  }

  function recentDetail(r: SessionRecord) {
    const reason = !r.replay
      ? `Its replay (${Math.round(r.replayBytes / 1024)} KiB) was larger than the history's byte limit, so only the record was kept.`
      : r.gameVersion !== manifest.version
        ? `It was recorded with game version ${r.gameVersion}; this server runs ${manifest.version}, so it cannot be re-simulated here.`
        : r.from > 0
          ? `It was a persistent session: its replay window starts at tick ${r.from} from a checkpoint that was released with it, so it cannot be re-simulated. Export keeps the window.`
          : null;
    return { game: gameInfo(), record: { ...r }, seats: r.teams.flatMap((team) => roles.map((role) => ({ team, role }))), scrubbable: scrubbable(r), reason };
  }

  async function recentDownload(res: ServerResponse, r: SessionRecord): Promise<void> {
    const replay = await recentReplay(r.id);
    if (!replay) throw new HttpError(404, 'replay_not_found', 'This session was kept without its replay.');
    json(res, 200, replay, { 'content-disposition': `attachment; filename="${manifest.id.replace(/[^A-Za-z0-9_-]/g, '_')}-${r.id}.replay.json"` });
  }

  // ------------------------------------------------------------------ agents

  function connectionRow(c: OwnedConnectionStatus) {
    const { id, name, registration, uri, softwareId, softwareVersion } = c.client;
    return {
      id: c.id,
      commander: c.commander,
      client: { id, name, registration, ...(uri ? { uri } : {}), ...(softwareId ? { softwareId } : {}), ...(softwareVersion ? { softwareVersion } : {}) },
      ...(registration === 'cimd' ? { domain: new URL(id).host } : {}),
      roles: c.roles,
      createdAt: c.createdAt,
      authorizedAt: c.authorizedAt,
      lastSeenAt: c.lastSeenAt,
      active: c.active,
    };
  }

  function commanderRow(c: CommanderStatus, rejections: { code: string; count: number }[]) {
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      roles: c.roles,
      isolation: c.isolation,
      metadata: c.metadata,
      botLevel: c.botLevel,
      scopes: c.scopes,
      mandate: c.mandate,
      connected: c.connected,
      lastSeenAt: c.lastSeenAt,
      seated: c.seated ? { session: c.seated.match, team: c.seated.team, roles: c.seated.roles } : null,
      policy: { activeByRole: c.policy.activeByRole, versions: c.policy.versions.length },
      approvals: c.approvals,
      rejections,
    };
  }

  function agents(params: URLSearchParams) {
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const rawLimit = Number(params.get('limit') ?? 100);
    const limit = Number.isSafeInteger(rawLimit) ? Math.min(500, Math.max(1, rawLimit)) : 100;
    const connections = new Map<string, OwnedConnectionStatus[]>();
    for (const c of opts.oauth?.allConnections() ?? []) connections.set(c.owner, [...(connections.get(c.owner) ?? []), c]);
    const owners = new Set([...host.commanders.owners(), ...connections.keys()]);
    const rejected = new Map<string, Problem[]>();
    for (const p of recentProblems()) {
      if (p.kind !== 'rejection' || p.owner === null) continue;
      const key = `${p.owner}\n${p.role}`;
      rejected.set(key, [...(rejected.get(key) ?? []), p]);
    }
    const rows = [...owners].filter((owner) => !q || owner.toLowerCase().includes(q)).map((owner) => {
      const roster = host.commanders.has(owner) ? host.commanders.roster(owner) : [];
      const conns = connections.get(owner) ?? [];
      const seen = [...roster.map((c) => c.lastSeenAt), ...conns.map((c) => c.lastSeenAt)].filter((t): t is number => t !== null);
      return {
        owner,
        activeNow: roster.some((c) => c.connected) || conns.some((c) => c.active),
        lastSeenAt: seen.length ? Math.max(...seen) : null,
        commanders: roster.map((c) => commanderRow(c, topCodes(c.seated ? c.seated.roles.flatMap((role) => rejected.get(`${owner}\n${role}`) ?? []) : [], 8))),
        connections: conns.map(connectionRow),
      };
    });
    rows.sort((a, b) => Number(b.activeNow) - Number(a.activeNow) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.owner.localeCompare(b.owner));
    return { oauth: opts.oauth !== undefined, window: { minutes: WINDOW_MINUTES }, total: rows.length, owners: rows.slice(0, limit) };
  }

  function stringField(body: unknown, name: string): string {
    const v = field(body, name);
    if (typeof v !== 'string' || v.length === 0 || v.length > 256) throw new HttpError(400, 'invalid', `Missing or invalid "${name}".`);
    return v;
  }

  function rotate(body: unknown) {
    const owner = stringField(body, 'owner');
    const commander = stringField(body, 'commander');
    if (!host.commanders.has(owner) || !host.commanders.roster(owner).some((entry) => entry.id === commander)) throw new HttpError(404, 'commander_not_found', 'No named commander for this owner.');
    // The new token is not returned: the owner gets it from the game's own UI.
    host.commanders.rotate(owner, commander);
    return { ok: true };
  }

  function revoke(body: unknown) {
    if (!opts.oauth) throw new HttpError(501, 'oauth_not_mounted', 'Pass your OAuth authorization server to the console (`oauth` option) to manage sign-in connections.');
    const owner = stringField(body, 'owner');
    const connection = stringField(body, 'connection');
    try {
      opts.oauth.revokeConnection(owner, connection);
    } catch (error) {
      if (error instanceof PlayerThreeError) throw new HttpError(404, 'not_found', 'No such connection for this owner.');
      throw error;
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ policies

  /** crash: the policy threw or ran out of memory; timeout: over its per-call budget; error: anything else (bad output, failed deploys). */
  const policyErrorKind = (code: string): 'timeout' | 'crash' | 'error' => (code === 'timeout' ? 'timeout' : code === 'threw' || code === 'memory_limit' ? 'crash' : 'error');

  async function policies() {
    const libraries = [];
    for (const owner of host.commanders.owners()) {
      for (const c of host.commanders.roster(owner)) {
        const played = c.record.wins + c.record.losses + c.record.draws;
        if (!c.policy.versions.length && !c.lastPractice && !played) continue;
        const p = c.lastPractice;
        libraries.push({
          owner,
          commander: c.id,
          name: c.name,
          roles: c.roles,
          kind: c.kind,
          activeByRole: c.policy.activeByRole,
          versions: [...c.policy.versions].sort((a, b) => b.version - a.version),
          lastPractice: p ? { at: p.at, opponent: p.opponent, allies: p.allies, ticks: p.ticks, seed: p.seed, version: p.version, outcome: p.outcome } : null,
          record: c.record,
          seated: c.seated ? { session: c.seated.match, team: c.seated.team, roles: c.seated.roles } : null,
          approvals: c.approvals,
        });
      }
    }
    const owners = ownersBySeat();
    const records = host.history.list();
    const publisherOwner = ({ publisher: p, role }: PoolRecord): string | null => {
      if (p.kind === 'commander') return p.owner;
      return owners.get(`${p.session}\n${p.team}\n${role}`) ?? records.find((record) => record.id === p.session)?.owners[`${p.team}/${role}`] ?? null;
    };
    const pool = host.pool.entries().map((e) => ({ ...e, publisherOwner: publisherOwner(e) }));
    pool.sort((a, b) => b.createdAt - a.createdAt);

    const window = recentProblems().filter((p) => p.kind === 'policy_error');
    const bySeat = new Map<string, { owner: string | null; session: string; team: string; role: string; timeout: number; crash: number; error: number }>();
    for (const p of window) {
      const key = `${p.session}\n${p.team}/${p.role}`;
      const row = bySeat.get(key) ?? { owner: p.owner, session: p.session, team: p.team, role: p.role, timeout: 0, crash: 0, error: 0 };
      row[policyErrorKind(p.code)]++;
      bySeat.set(key, row);
    }
    const seats = [];
    for (const m of host.matches()) {
      for (const s of m.seats()) {
        if (s.policyVersion === undefined && s.poolPolicy === undefined) continue;
        const st = await policyStats(m, s.team, s.role);
        if (!st || st.version === null) continue;
        seats.push({
          session: m.id,
          team: s.team,
          role: s.role,
          owner: owners.get(`${m.id}\n${s.team}\n${s.role}`) ?? null,
          controller: s.controller,
          ...(s.poolPolicy !== undefined ? { poolPolicy: s.poolPolicy } : {}),
          version: st.version,
          runtime: st.runtime,
          calls: st.calls,
          timeouts: st.timeouts,
          errors: st.errors,
          meanMs: st.meanMs,
          maxMs: st.maxMs,
          lastError: st.lastError?.code ?? null,
        });
      }
    }
    return {
      modes: { policy: manifest.control.policy ?? null, pool: manifest.control.pool ?? null, practice: manifest.control.practice ?? null },
      libraries,
      pool,
      errors: {
        window: {
          minutes: WINDOW_MINUTES,
          total: window.length,
          codes: topCodes(window, 20).map((c) => ({ ...c, kind: policyErrorKind(c.code) })),
          seats: [...bySeat.values()].sort((a, b) => b.timeout + b.crash + b.error - (a.timeout + a.crash + a.error)),
        },
        live: seats,
        history: {
          sessions: records.length,
          total: records.reduce((n, r) => n + r.policyErrors, 0),
          codes: mergeCodes(records.map((r) => r.codes.policyErrors), 20).map((c) => ({ ...c, kind: policyErrorKind(c.code) })),
        },
      },
    };
  }

  /** One commander library version as its canonical `playerthree.policy/1` package (spec §13.1), as a file download. */
  async function policyPackage(res: ServerResponse, params: URLSearchParams): Promise<void> {
    const owner = params.get('owner') ?? '';
    const commander = params.get('commander') ?? '';
    const version = params.get('version') ?? '';
    if (!owner || owner.length > 256 || !commander || commander.length > 256 || !/^[1-9]\d{0,9}$/.test(version)) {
      throw new HttpError(400, 'invalid', 'Pass owner, commander and version (a library version number).');
    }
    let text: string;
    try {
      text = canonicalJson(await host.commanders.exportPolicy(owner, commander, Number(version)));
    } catch (error) {
      if (error instanceof PlayerThreeError) throw new HttpError(404, 'not_found', 'No such library version, or it cannot be packaged (e.g. an unassigned legacy role).');
      throw error;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="${commander.replace(/[^A-Za-z0-9_-]/g, '_')}-v${version}.json"`,
    });
    res.end(text);
  }

  function poolAction(body: unknown) {
    const id = stringField(body, 'id');
    if (!POOL_ID_RE.test(id)) throw new HttpError(400, 'invalid', 'Pool entry ids look like pol_<digits>.');
    const action = field(body, 'action');
    if (action === 'unpublish') {
      if (!host.pool.unpublish(id)) throw new HttpError(404, 'not_found', 'No such pool entry.');
      return { ok: true, id, unpublished: true };
    }
    if (action !== 'disable' && action !== 'enable') throw new HttpError(400, 'invalid', 'action must be disable, enable or unpublish.');
    const entry = host.pool.setDisabled(id, action === 'disable');
    if (!entry) throw new HttpError(404, 'not_found', 'No such pool entry.');
    return { ok: true, entry };
  }

  // ------------------------------------------------------------------ bench (read-only; runs start from the CLI)

  async function bench() {
    const root = opts.benchResultsDir;
    if (root === undefined) return { configured: false, root: null, results: [] };
    const results = [];
    for (const dir of await benchDirs(root)) {
      try {
        const s = await benchSummary(dir);
        results.push({ ...s, currentSurface: s.surfaceHash === hash, sameGame: s.game === manifest.id && s.gameVersion === manifest.version });
      } catch (error) {
        results.push({ key: dir.key, name: dir.name, error: error instanceof Error ? error.message : 'Unreadable results.' });
      }
    }
    results.sort((a, b) => ('createdAt' in b ? b.createdAt : '').localeCompare('createdAt' in a ? a.createdAt : ''));
    return { configured: true, root, results };
  }

  async function benchDir(key: string) {
    const root = opts.benchResultsDir;
    const dir = root !== undefined && BENCH_KEY_RE.test(key) ? (await benchDirs(root)).find((d) => d.key === key) : undefined;
    if (!dir) throw new HttpError(404, 'not_found', 'No such bench results directory.');
    return dir;
  }

  const benchHttp = (error: unknown): unknown =>
    error instanceof BenchError || error instanceof ReplayError ? new HttpError(error.status, error.status === 404 ? 'not_found' : error.status === 429 ? 'busy' : 'invalid', error.message) : error;

  async function benchOpen(body: unknown, res: ServerResponse) {
    const dir = await benchDir(stringField(body, 'dir'));
    const path = stringField(body, 'path');
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    try {
      return { ...(await openReplay(await benchReplay(dir, path), controller.signal)), name: `${dir.name}/${path}` };
    } catch (error) {
      throw benchHttp(error);
    } finally {
      res.off('close', abort);
    }
  }

  // ------------------------------------------------------------------ safety

  const MAX_CARD_BYTES = 512 * 1024;

  async function safetyCard() {
    const path = opts.safetyCard;
    if (path === undefined) return null;
    try {
      const s = await stat(path);
      if (s.size > MAX_CARD_BYTES) return { path, error: 'The Safety Card is larger than 512 KiB.' };
      const text = await readFile(path, 'utf8');
      return { path, modifiedAt: s.mtimeMs, text, matchesSurface: text.includes(hash) };
    } catch {
      return { path, error: 'No Safety Card at this path yet.' };
    }
  }

  async function safety() {
    const window = recentProblems();
    const records = host.history.list();
    const { dir, ...limits } = host.history.limits;
    return {
      game: gameInfo(),
      surfaceHash: hash,
      modes: manifest.control,
      scopes: { all: SCOPES, defaults: defaultScopes(manifest) },
      card: await safetyCard(),
      audit: 'playerthree audit <module exporting your GameDefinition> --out SAFETY.md',
      rejections: {
        window: {
          minutes: WINDOW_MINUTES,
          rejections: window.filter((p) => p.kind === 'rejection').length,
          policyErrors: window.filter((p) => p.kind === 'policy_error').length,
          codes: topCodes(window.filter((p) => p.kind === 'rejection'), 20),
        },
        history: {
          ...limits,
          persistent: dir !== null,
          sessions: records.length,
          since: records.length ? records[records.length - 1]!.releasedAt : null,
          rejections: records.reduce((n, r) => n + r.rejections, 0),
          policyErrors: records.reduce((n, r) => n + r.policyErrors, 0),
          codes: mergeCodes(records.map((r) => r.codes.rejections), 20),
        },
      },
    };
  }

  // ------------------------------------------------------------------ game settings (read-only)

  function settings() {
    return {
      schema: manifest.matchOptions ? toJsonSchema(manifest.matchOptions) : null,
      defaults: host.matchOptions ?? null,
      sessions: [
        ...host.matches().map((m) => ({ id: m.id, status: statusOf(m) as string, options: m.options ?? null, at: lifetimes.get(m.id)?.createdAt ?? null })),
        ...host.history.list().map((r) => ({ id: r.id, status: 'released', options: r.options ?? null, at: r.releasedAt })),
      ],
    };
  }

  // ------------------------------------------------------------------ overview

  function overview() {
    const sessions = host.matches();
    let commanders = 0;
    let activeNow = 0;
    const owners = host.commanders.owners();
    for (const owner of owners) {
      for (const c of host.commanders.roster(owner)) {
        commanders++;
        if (c.connected) activeNow++;
      }
    }
    // Seat-token agents (not commanders) are counted per seat; commander seats were counted above.
    for (const m of sessions) if (!m.over) activeNow += m.seats().filter((s) => s.agentActive && !s.commander).length;
    const window = recentProblems();
    return {
      access: access.mode,
      game: {
        id: manifest.id,
        title: manifest.title,
        version: manifest.version,
        tickRate: manifest.tickRate,
        surfaceHash: hash,
        modes: Object.entries(manifest.control).filter(([, v]) => v !== undefined).map(([k]) => k),
        teams,
        roles,
        opponents: manifest.opponents.values,
      },
      sessions: { live: sessions.filter((m) => !m.over).length, ended: sessions.filter((m) => m.over).length, recent: host.history.list().length },
      agents: { activeNow, owners: owners.length, commanders, connections: opts.oauth ? opts.oauth.allConnections().length : null },
      window: {
        minutes: WINDOW_MINUTES,
        rejections: window.filter((p) => p.kind === 'rejection').length,
        policyErrors: window.filter((p) => p.kind === 'policy_error').length,
        codes: topCodes(window, 8),
        recent: window.slice(-20).reverse(),
      },
      serverTime: Date.now(),
    };
  }

  // ------------------------------------------------------------------ HTTP

  function page(res: ServerResponse): void {
    const nonce = randomBytes(16).toString('base64');
    // Image placeholders are filled before CSS/JS are inlined, so only the template's own occurrences match.
    const html = PAGE.html
      .replace('__LOGO__', PAGE.logo)
      .replace('__ICON__', PAGE.icon)
      .replace('/*__CSS__*/', () => PAGE.css)
      .replace('/*__JS__*/', () => PAGE.js)
      .replaceAll('__NONCE__', nonce)
      .replaceAll('__BASE__', base)
      .replaceAll('__MODE__', access.mode);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  }

  const session = (id: string): PlayerThreeMatch => {
    const m = ID_RE.test(id) ? host.getMatch(id) : undefined;
    // `recent`: the host released it but keeps it in its history (the page links to the record).
    if (!m) throw new HttpError(404, 'session_not_found', 'The host no longer holds this session.', { recent: ID_RE.test(id) && host.history.get(id) !== undefined });
    return m;
  };

  const READS: Record<string, true> = { '/api/overview': true, '/api/sessions': true, '/api/agents': true, '/api/policies': true, '/api/policies/package': true, '/api/bench': true, '/api/safety': true, '/api/settings': true };
  const WRITES: Record<string, true> = { '/api/replays': true, '/api/agents/rotate': true, '/api/agents/revoke': true, '/api/policies/pool': true, '/api/bench/replay': true };

  /** Route → [method, kind]. */
  function route(sub: string): { method: 'GET' | 'POST'; kind: RequestKind } | undefined {
    if (sub === '' || sub === '/') return { method: 'GET', kind: 'page' };
    if (Object.hasOwn(READS, sub)) return { method: 'GET', kind: 'read' };
    if (Object.hasOwn(WRITES, sub)) return { method: 'POST', kind: 'write' };
    if (/^\/api\/sessions\/[^/]+\/end$/.test(sub)) return { method: 'POST', kind: 'write' };
    if (
      /^\/api\/sessions\/[^/]+\/(?:state|stream|view|scrub|replay)$/.test(sub) ||
      /^\/api\/replays\/[^/]+\/scrub$/.test(sub) ||
      /^\/api\/recent\/[^/]+(?:\/scrub|\/replay)?$/.test(sub) ||
      /^\/api\/bench\/[^/]+\/report$/.test(sub)
    ) {
      return { method: 'GET', kind: 'read' };
    }
    return undefined;
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse, sub: string, params: URLSearchParams): Promise<void> {
    if (sub === '' || sub === '/') return page(res);
    if (sub === '/api/overview') return json(res, 200, overview());
    if (sub === '/api/sessions') {
      const owners = ownersBySeat();
      const window = recentProblems();
      const list = host.matches().map((m) => sessionSummary(m, owners, window));
      list.sort((a, b) => Number(a.status === 'ended') - Number(b.status === 'ended') || (b.createdAt ?? 0) - (a.createdAt ?? 0));
      const { dir, ...limits } = host.history.limits;
      return json(res, 200, { sessions: list, recent: host.history.list().map(recentSummary), history: { ...limits, persistent: dir !== null } });
    }
    if (sub === '/api/agents') return json(res, 200, agents(params));
    if (sub === '/api/agents/rotate') return json(res, 200, rotate(await readJson(req)));
    if (sub === '/api/agents/revoke') return json(res, 200, revoke(await readJson(req)));
    if (sub === '/api/policies') return json(res, 200, await policies());
    if (sub === '/api/policies/package') return policyPackage(res, params);
    if (sub === '/api/policies/pool') return json(res, 200, poolAction(await readJson(req)));
    if (sub === '/api/bench') return json(res, 200, await bench());
    if (sub === '/api/bench/replay') return json(res, 200, await benchOpen(await readJson(req), res));
    if (sub === '/api/safety') return json(res, 200, await safety());
    if (sub === '/api/settings') return json(res, 200, settings());
    if (sub === '/api/replays') return upload(req, res);
    const replayScrub = /^\/api\/replays\/([^/]+)\/scrub$/.exec(sub);
    if (replayScrub) {
      const key = replayScrub[1]!;
      return scrub(res, params, { key, replay: () => uploads.get(key), missing: 'Replay not found (uploads are kept for the last four files).' });
    }
    const benchReportMatch = /^\/api\/bench\/([^/]+)\/report$/.exec(sub);
    if (benchReportMatch) {
      const dir = await benchDir(benchReportMatch[1]!);
      try {
        return json(res, 200, { name: dir.name, text: await benchReport(dir) });
      } catch (error) {
        throw benchHttp(error);
      }
    }
    const recent = /^\/api\/recent\/([^/]+)(?:\/(scrub|replay))?$/.exec(sub);
    if (recent) {
      const r = recentRecord(recent[1]!);
      if (recent[2] === 'replay') return recentDownload(res, r);
      if (recent[2] === 'scrub') {
        const missing = r.replay ? 'Recorded with another game version; cannot re-simulate.' : 'This session was kept without its replay.';
        return scrub(res, params, { key: `recent:${r.id}`, replay: () => (scrubbable(r) ? recentReplay(r.id) : undefined), missing });
      }
      return json(res, 200, recentDetail(r));
    }
    const [, id, action] = /^\/api\/sessions\/([^/]+)\/([a-z]+)$/.exec(sub)!;
    const m = session(id!);
    switch (action) {
      case 'state':
        return json(res, 200, await sessionState(m));
      case 'stream':
        return hub.stream(req, res, m, undefined, sessionStatus);
      case 'view':
        return json(res, 200, view(m, params.get('perspective') ?? 'god'));
      case 'scrub':
        return scrub(res, params, { key: m.id, replay: () => m.replay(), events: hub.log(m.id).events, missing: 'Replay not found.', checkpoint: (tick) => m.checkpoint(tick) });
      case 'replay':
        return json(res, 200, m.replay(), { 'content-disposition': `attachment; filename="${manifest.id.replace(/[^A-Za-z0-9_-]/g, '_')}-${m.id}.replay.json"` });
      case 'end':
        return json(res, 200, end(m, await readJson(req)));
    }
  }

  return {
    async handle(req, res) {
      const url = req.url ?? '/';
      const q = url.indexOf('?');
      const pathname = q === -1 ? url : url.slice(0, q);
      if (pathname !== base && !pathname.startsWith(`${base}/`)) return false;
      const sub = pathname.slice(base.length);
      const r = route(sub);
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const denied = await access.check(req, r?.kind === 'write' ? 'write' : r?.kind === 'page' ? 'page' : 'read');
      if (denied) {
        if (r?.kind === 'page') {
          res.writeHead(denied.status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          res.end(`PlayerThree operator console: ${denied.message}\n`);
        } else {
          json(res, denied.status, { error: denied.error, message: denied.message }, denied.status === 401 ? { 'www-authenticate': 'Bearer realm="playerthree-operator"' } : {});
        }
        return true;
      }
      if (!r) {
        json(res, 404, { error: 'not_found' });
        return true;
      }
      if (method !== r.method) {
        json(res, 405, { error: 'method_not_allowed' }, { allow: r.method === 'GET' ? 'GET, HEAD' : 'POST' });
        return true;
      }
      try {
        await dispatch(req, res, sub, new URL(url, 'http://localhost').searchParams);
      } catch (error) {
        if (res.headersSent) res.end();
        else if (error instanceof HttpError) json(res, error.status, { ...error.extra, error: error.code, message: error.message });
        else {
          console.error('playerthree/devtools: request failed', error);
          json(res, 500, { error: 'internal' });
        }
      }
      return true;
    },
    close() {
      unsubscribeTrace();
      unsubscribeCommanders();
      hub.close();
      scrubber.close();
      uploads.clear();
      recentReplays.clear();
    },
  };
}

/** Serve the operator console on an existing node:http server (requests under `path` never reach other listeners). */
export function mountDevtools<M extends AnyManifest>(
  httpServer: Server,
  host: PlayerThreeHost<M>,
  opts: DevtoolsOptions = {},
): { handler: DevtoolsHandler; close(): void } {
  const handler = createDevtoolsHandler(host, opts);
  const base = (opts.path ?? '/playerthree/devtools').replace(/\/+$/, '');
  const originalEmit = httpServer.emit;
  httpServer.emit = function (this: Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'request') {
      const req = args[0] as IncomingMessage;
      const url = req.url ?? '/';
      const q = url.indexOf('?');
      const pathname = q === -1 ? url : url.slice(0, q);
      if (pathname === base || pathname.startsWith(`${base}/`)) {
        void handler.handle(req, args[1] as ServerResponse);
        return true;
      }
    }
    return originalEmit.call(this, event, ...args);
  } as Server['emit'];
  return {
    handler,
    close() {
      httpServer.emit = originalEmit;
      handler.close();
    },
  };
}
