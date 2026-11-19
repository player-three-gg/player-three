/**
 * Headless player console: polls the game's player API (`GET <url>/state`) and follows its live trace
 * (`GET <url>/stream`, Server-Sent Events read through `fetch`, so the owner credential travels in the Authorization
 * header, never in a URL). It normalizes what the API returns into one snapshot of the owner's own seats.
 *
 * Owner-private routing is a server guarantee: profile credentials default to a named roster and must explicitly
 * select a current commander seat for live data. Human capabilities see one seat; observer/agent tokens are refused.
 *
 * Browser-safe: no Node built-ins, no DOM (the optional panel lives in `panel.ts`).
 */
import type { Approval, IntentAck, Mandate, PolicyErrorCode, PolicyStatus, PracticeResult, Scope } from 'playerthree/control';
import type { ServerMsg } from 'playerthree/protocol';

/** One seat as the host reports it (playerthree `SeatInfo`). */
export type SeatInfo = Extract<ServerMsg, { op: 'seats' }>['seats'][number];
export type Controller = SeatInfo['controller'];
export type Outcome = 'win' | 'loss' | 'draw' | 'running';
export type ConsoleReadiness = 'ready' | 'online' | 'waiting' | 'absent' | 'stale_policy' | 'policy_failed' | 'consent_required';

// ------------------------------------------------------------------ wire (player API)

interface TraceBase {
  at: number;
  match: string;
  tick: number;
}
interface SeatTrace extends TraceBase {
  team: string;
  role: string;
}

/** The trace events the console reads (the API may send others; they are ignored). */
export type PlayerTraceEvent =
  | (SeatTrace & { type: 'observe'; source: string; bytes: number; data?: unknown })
  | (SeatTrace & { type: 'intent'; source: string; intent?: unknown; ack: IntentAck })
  | (SeatTrace & { type: 'policy_deploy'; ok: boolean; rollback: boolean; version?: number; error?: { code: PolicyErrorCode; message?: string } })
  | (SeatTrace & { type: 'policy_call'; version: number; pool: boolean; ms: number; intents: number; rejected: number; logs: string[]; error?: PolicyErrorCode })
  | (SeatTrace & { type: 'practice'; opponent: string; allies: string; ticks: number; seed: number; result: PracticeResult });

/** An owner's persistent commander (owner credential only). */
export interface CommanderInfo {
  id: string;
  name: string;
  kind: 'agent' | 'policy';
  roles: string[];
  isolation: { independentSessions: boolean };
  metadata?: { provider?: string; model?: string; scaffoldVersion?: string };
  botLevel: string;
  scopes: Scope[];
  mandate: Mandate;
  policy: { activeByRole: Record<string, number | null>; versions: { version: number; role: string | null; runtime: string; createdAt: number }[] };
  record: { wins: number; losses: number; draws: number };
  lastPractice: { at: number; role: string; opponent: string; allies: string; ticks: number; seed: number; version: number; outcome: Outcome; report: unknown } | null;
  approvals: { role: string; approval: Approval }[];
  connected: boolean;
  lastSeenAt: number | null;
  seated: { match: string; team: string; roles: string[] } | null;
  reservations: { team: string; role: string; ready: boolean }[];
}

/** Profile-authenticated live selection, checked against the current commander lease by the host. */
export interface PlayerConsoleTarget {
  commander: string;
  match: string;
  team: string;
  role: string;
}

/** Approval routing never conflates a reusable commander with a live human seat. */
export type ConsoleActionTarget =
  | { kind: 'commander'; commander: string; seat?: { match: string; team: string; role: string } }
  | { kind: 'seat'; match: string; team: string; role: string };

/** `GET <url>/state` as the player API sends it. */
export interface PlayerStateWire {
  game: { id: string; title: string; version: string; tickRate: number; policy: unknown };
  match: string | null;
  team: string | null;
  target: PlayerConsoleTarget | null;
  tick: number;
  outcome: Outcome | null;
  seats: SeatInfo[];
  readiness: Record<string, ConsoleReadiness>;
  observations: Record<string, PlayerTraceEvent>;
  policies: Record<string, PolicyStatus | null>;
  calls: Record<string, PlayerTraceEvent[]>;
  practice: PlayerTraceEvent[];
  events: PlayerTraceEvent[];
  commanders?: CommanderInfo[];
}

// ------------------------------------------------------------------ snapshot

export interface ConsoleIntent {
  at: number;
  tick: number;
  /** Who produced it: `agent`, `policy`, `bot`, `owner` or `stream`. */
  source: string;
  /** The intent kind when it passed schema validation (rejected input is never stored). */
  kind: string | null;
  ack: IntentAck;
  /** `ok`, or the closed rejection code (a game code for `game` rejections). See {@link ackCode}. */
  code: string;
}

export interface ConsolePolicyError {
  at: number;
  tick: number;
  /** A failed deploy/rollback, or a failed policy call at tick rate. */
  phase: 'deploy' | 'call';
  code: PolicyErrorCode;
  /** Own-authored engine text about the owner's own artifact (plain text). */
  message?: string;
  version?: number;
}

export interface ConsolePractice {
  at: number;
  /** Compatible role selected for this practice run, not the commander's roster identity. */
  role: string;
  opponent: string;
  ticks: number;
  seed: number;
  /** Null when the run failed (`code`). */
  outcome: Outcome | null;
  code?: 'policy' | 'guard';
  /** Policy version that played, when known. */
  version?: number;
}

export interface ConsoleObservation {
  at: number;
  tick: number;
  /** UTF-8 JSON bytes of the guarded observation the seat's agent last received. */
  bytes: number;
  /** Estimated input tokens (`ceil(bytes / bytesPerToken)`). */
  tokens: number;
  /** Estimated cost of reading it once, in the price option's currency; null without a price. */
  cost: number | null;
}

export interface ConsolePolicy {
  /** Version playing in the live seat (or the active library version in the lobby); null: none. */
  version: number | null;
  runtime?: string;
  calls?: number;
  errors?: number;
  timeouts?: number;
  meanMs?: number;
  maxMs?: number;
  intentsEmitted?: number;
  intentsRejected?: { code: string; count: number }[];
  /** Library versions (owner credential). */
  versions?: number;
}

export interface ConsoleSeat {
  /** Persistent roster identity, or null for a human/private-team seat console. */
  commander: string | null;
  name: string | null;
  /** All compatible roles in the lobby; no arbitrary primary role is selected. */
  roles: string[];
  /** Exact runtime role, null for a reusable lobby commander. */
  role: string | null;
  team: string | null;
  target: ConsoleActionTarget;
  /** Runtime controller in a match; commander execution kind in the lobby. */
  controller: Controller;
  /** True while a live match seats it. */
  live: boolean;
  /** Exact live preparation/probe/consent state; null for a reusable lobby connection. */
  readiness: ConsoleReadiness | null;
  /** The seat's agent is active now (a recent or in-flight call, or a running sequence). */
  present: boolean;
  /** This seat holds a pausable session still while its agent is away (`whenAbsent: 'pause'`). */
  paused: boolean;
  /** Last agent call (owner credential), ms since epoch. */
  lastSeenAt: number | null;
  mandate: Mandate | null;
  scopes: Scope[];
  /** `mandate.limits` (house rules the game enforces). */
  limits: Record<string, unknown> | null;
  /** Pending proposals, role-labelled; live consoles include only their exact selected lane. */
  approvals: { role: string; approval: Approval }[];
  policy: ConsolePolicy | null;
  /** Policy `log()` tail (own-authored text; render as plain text). */
  logs: string[];
  /** Newest first. */
  intents: ConsoleIntent[];
  /** Rejected intents among `intents`, by code, most frequent first. */
  rejections: { code: string; count: number }[];
  /** Newest first. */
  errors: ConsolePolicyError[];
  /** Newest first. */
  practice: ConsolePractice[];
  observation: ConsoleObservation | null;
}

/** Client state: `live` after a successful refresh, `error` after a failed one (see `ConsoleSnapshot.error`). */
export type ConsoleStatus = 'idle' | 'connecting' | 'live' | 'error';

/** One normalized view of the owner's own seats, rebuilt on every refresh and live trace event. */
export interface ConsoleSnapshot {
  status: ConsoleStatus;
  /** Closed code when `status` is `error`: the API's `{ error }` (`bad_token`, `forbidden`…), `http_<n>` or `network`. */
  error: string | null;
  game: { id: string; title: string; version: string; tickRate: number } | null;
  /** `match` for an explicitly selected live lane or live owner capability, otherwise `lobby`. */
  phase: 'lobby' | 'match';
  match: string | null;
  team: string | null;
  tick: number;
  outcome: Outcome | null;
  /** The live trace stream is connected. */
  streaming: boolean;
  seats: ConsoleSeat[];
  estimate: { bytesPerToken: number; pricePerMTok: number | null };
  /** ms since epoch of the last successful refresh; 0 before the first. */
  updatedAt: number;
}

/** Options of {@link PlayerConsole}. */
export interface PlayerConsoleOptions {
  /**
   * The game's authenticated profile credential, a live exact-seat human capability, or a trusted private team
   * capability. Profile identity comes only from the host's `owner` resolver. Read before every request.
   */
  credential: string | (() => string | undefined);
  /** Player API base URL. Default `/playerthree/player`. */
  url?: string;
  /** Explicit live commander lane; undefined keeps profile authentication in roster-only mode. */
  target?: PlayerConsoleTarget | (() => PlayerConsoleTarget | undefined);
  /** `/state` refresh interval, ms (≥ 250). Default 2000. */
  pollMs?: number;
  /** Follow `/stream` for live intents and observations while a match runs. Default true. */
  stream?: boolean;
  /** Price per million input tokens for the observation cost estimate (any currency). Default: no cost shown. */
  pricePerMTok?: number;
  /** Bytes per token for the estimate. Default 4 (a rough average for JSON; real tokenizers vary by model). */
  bytesPerToken?: number;
  /** Recent intents kept per seat. Default 50. */
  maxIntents?: number;
  /** `fetch` implementation (tests, custom transports). Default the global `fetch`. */
  fetch?: typeof fetch;
}

/** Closed rejection code of an ack: `ok`, the ack code, or the game's code for `game` rejections. */
export function ackCode(ack: IntentAck): string {
  if (ack.ok) return 'ok';
  return ack.code === 'game' ? ack.gameCode : ack.code;
}

/** Input tokens for `bytes` of JSON at `bytesPerToken` (default 4): an estimate, not a tokenizer. */
export function estimateTokens(bytes: number, bytesPerToken = 4): number {
  return Math.ceil(bytes / bytesPerToken);
}

const MAX_TRACE = 2000;
const traceKey = (e: PlayerTraceEvent): string => JSON.stringify(e);

/**
 * Server snapshot ∪ live events received since the snapshot was requested. Everything received before the request is
 * in the snapshot; an event in both is counted once per occurrence (identical events can legitimately repeat).
 */
export function mergeTrace(snapshot: readonly PlayerTraceEvent[], live: readonly PlayerTraceEvent[]): PlayerTraceEvent[] {
  const seen = new Map<string, number>();
  for (const e of snapshot) seen.set(traceKey(e), (seen.get(traceKey(e)) ?? 0) + 1);
  const out = [...snapshot];
  for (const e of live) {
    const k = traceKey(e);
    const n = seen.get(k) ?? 0;
    if (n > 0) seen.set(k, n - 1);
    else out.push(e);
  }
  return out.sort((a, b) => a.at - b.at || a.tick - b.tick).slice(-MAX_TRACE);
}

/** Every distinct trace event of a state response (practice runs are also in `events`). */
function stateTrace(s: PlayerStateWire): PlayerTraceEvent[] {
  const all = [...s.events];
  const inEvents = new Set(s.events.map(traceKey));
  for (const e of s.practice) if (!inEvents.has(traceKey(e))) all.push(e);
  for (const list of Object.values(s.calls)) all.push(...list);
  return all;
}

function errorCode(status: number, body: unknown): string {
  const e = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
  return typeof e === 'string' && /^[a-z_]{1,32}$/.test(e) ? e : `http_${status}`;
}

type Listener = (s: ConsoleSnapshot) => void;

/** Headless player-console client: polls `/state`, follows `/stream` while a match runs and publishes {@link ConsoleSnapshot}s. */
export class PlayerConsole {
  private readonly opts: Required<Omit<PlayerConsoleOptions, 'pricePerMTok' | 'fetch' | 'credential' | 'target'>> & { pricePerMTok: number | null };
  private readonly target: () => PlayerConsoleTarget | undefined;
  private selection = '';
  private readonly credential: () => string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly listeners = new Set<Listener>();
  private wire: PlayerStateWire | undefined;
  private trace: PlayerTraceEvent[] = [];
  /** Live events received since the newest in-flight `/state` request was sent. */
  private live: PlayerTraceEvent[] = [];
  private lastObs = new Map<string, PlayerTraceEvent & { type: 'observe' }>();
  private status: ConsoleStatus = 'idle';
  private error: string | null = null;
  private updatedAt = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private streamCtl: AbortController | undefined;
  /** Match the open stream follows. */
  private streamMatch: string | null = null;
  private streaming = false;
  private streamRetry: ReturnType<typeof setTimeout> | undefined;
  private streamBackoff = 1000;
  private current: ConsoleSnapshot;

  constructor(opts: PlayerConsoleOptions) {
    const cred = opts.credential;
    this.credential = typeof cred === 'function' ? cred : () => cred;
    const target = opts.target;
    this.target = typeof target === 'function' ? target : () => target;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.opts = {
      url: (opts.url ?? '/playerthree/player').replace(/\/+$/, ''),
      pollMs: Math.max(250, opts.pollMs ?? 2000),
      stream: opts.stream ?? true,
      pricePerMTok: opts.pricePerMTok !== undefined && Number.isFinite(opts.pricePerMTok) && opts.pricePerMTok >= 0 ? opts.pricePerMTok : null,
      bytesPerToken: opts.bytesPerToken !== undefined && opts.bytesPerToken > 0 ? opts.bytesPerToken : 4,
      maxIntents: Math.max(1, opts.maxIntents ?? 50),
    };
    this.current = this.build();
  }

  /** The latest normalized snapshot. */
  get snapshot(): ConsoleSnapshot {
    return this.current;
  }

  /** Called with every new snapshot. Returns unsubscribe. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start polling (and streaming while a match runs). Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.status === 'idle') this.setStatus('connecting', null);
    void this.poll();
  }

  /** Stop all network activity; the last snapshot stays readable. */
  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.closeStream();
  }

  get started(): boolean {
    return this.running;
  }

  /** Fetch `/state` now. */
  async refresh(): Promise<void> {
    const token = this.credential();
    if (!token) {
      this.setStatus('error', 'no_credential');
      return;
    }
    const target = this.target();
    const selection = target ? new URLSearchParams({ ...target }).toString() : '';
    if (selection !== this.selection) {
      this.closeStream();
      this.selection = selection;
      this.wire = undefined;
      this.trace = [];
      this.lastObs.clear();
    }
    this.live = [];
    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.url}/state${selection ? `?${selection}` : ''}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    } catch {
      this.setStatus('error', 'network');
      return;
    }
    let body: unknown;
    if (this.selection !== selection) return;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (this.selection !== selection) return;
    if (!res.ok || typeof body !== 'object' || body === null) {
      this.setStatus('error', errorCode(res.status, body));
      if (res.status === 401 || res.status === 403) this.closeStream();
      return;
    }
    const wire = body as PlayerStateWire;
    if (wire.match !== this.wire?.match) {
      this.trace = [];
      this.lastObs.clear();
    }
    this.wire = wire;
    this.trace = mergeTrace(stateTrace(wire), this.live);
    for (const [role, o] of Object.entries(wire.observations)) {
      const key = o.type === 'observe' ? `${o.team}/${o.role}` : role;
      const prev = this.lastObs.get(key);
      if (o.type === 'observe' && (!prev || prev.at <= o.at)) this.lastObs.set(key, o);
    }
    this.updatedAt = Date.now();
    this.status = 'live';
    this.error = null;
    this.syncStream();
    this.emit();
  }

  private async poll(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.running) return;
    await this.refresh();
    if (this.running) this.timer = setTimeout(() => void this.poll(), this.opts.pollMs);
  }

  private setStatus(status: ConsoleStatus, error: string | null): void {
    this.status = status;
    this.error = error;
    this.emit();
  }

  private emit(): void {
    this.current = this.build();
    for (const l of this.listeners) l(this.current);
  }

  // ---------------------------------------------------------------- stream

  private syncStream(): void {
    const match = this.wire?.match ?? null;
    if (!this.running || !this.opts.stream || match === null) {
      this.closeStream();
      return;
    }
    if (this.streamCtl && this.streamMatch === match) return;
    this.closeStream();
    void this.openStream(match);
  }

  private closeStream(): void {
    clearTimeout(this.streamRetry);
    this.streamRetry = undefined;
    this.streamCtl?.abort();
    this.streamCtl = undefined;
    this.streamMatch = null;
    if (this.streaming) {
      this.streaming = false;
      this.emit();
    }
  }

  private async openStream(match: string): Promise<void> {
    const token = this.credential();
    if (!token) return;
    const ctl = new AbortController();
    this.streamCtl = ctl;
    this.streamMatch = match;
    try {
      const res = await this.fetchFn(`${this.opts.url}/stream${this.selection ? `?${this.selection}` : ''}`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ctl.signal, cache: 'no-store' });
      if (this.streamCtl !== ctl) {
        await res.body?.cancel();
        return;
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        // 409: no live match for this owner yet; the next poll that reports one reopens the stream.
        if (res.status !== 409) this.retryStream(ctl);
        else if (this.streamCtl === ctl) this.streamCtl = undefined;
        return;
      }
      this.streaming = true;
      this.streamBackoff = 1000;
      this.emit();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (this.streamCtl !== ctl) return;
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) !== -1) {
          this.onFrame(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
        }
      }
    } catch {
      /* aborted or dropped: handled below */
    }
    if (this.streamCtl !== ctl) return;
    this.streaming = false;
    this.emit();
    this.retryStream(ctl);
  }

  private retryStream(ctl: AbortController): void {
    if (this.streamCtl !== ctl || !this.running) return;
    this.streamCtl = undefined;
    const match = this.streamMatch;
    this.streamRetry = setTimeout(() => {
      if (this.running && match !== null && this.wire?.match === match && !this.streamCtl) void this.openStream(match);
    }, this.streamBackoff);
    this.streamBackoff = Math.min(this.streamBackoff * 2, 15_000);
  }

  private onFrame(frame: string): void {
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trimStart();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || !this.wire) return;
    if (event === 'status') {
      // Server-built frame (the player API's status shape).
      const s = parsed as { tick: number; outcome: Outcome; seats: SeatInfo[]; readiness: Record<string, ConsoleReadiness> };
      this.wire = { ...this.wire, tick: s.tick, outcome: s.outcome, seats: s.seats, readiness: s.readiness };
    } else if (event === 'trace') {
      const e = parsed as PlayerTraceEvent;
      if (e.match !== this.wire.match) return;
      if (e.type === 'observe') {
        this.lastObs.set(`${e.team}/${e.role}`, e);
      } else {
        this.live.push(e);
        this.trace.push(e);
        if (this.trace.length > MAX_TRACE) this.trace.splice(0, this.trace.length - MAX_TRACE);
      }
    } else return;
    this.emit();
  }

  // ---------------------------------------------------------------- normalize

  private build(): ConsoleSnapshot {
    const w = this.wire;
    const estimate = { bytesPerToken: this.opts.bytesPerToken, pricePerMTok: this.opts.pricePerMTok };
    const base = { status: this.status, error: this.error, streaming: this.streaming, estimate, updatedAt: this.updatedAt };
    if (!w) return { ...base, game: null, phase: 'lobby', match: null, team: null, tick: 0, outcome: null, seats: [] };
    const commanders = new Map((w.commanders ?? []).map((c) => [c.id, c]));
    const seats = w.match !== null
      ? w.seats.map((s) => this.seat(s.role, s, w.target ? commanders.get(w.target.commander) : undefined, w.policies[s.role]))
      : [...commanders.values()].map((c) => this.seat(null, undefined, c, undefined));
    const { id, title, version, tickRate } = w.game;
    return { ...base, game: { id, title, version, tickRate }, phase: w.match !== null ? 'match' : 'lobby', match: w.match, team: w.team, tick: w.tick, outcome: w.outcome, seats };
  }

  private seat(role: string | null, live: SeatInfo | undefined, cmd: CommanderInfo | undefined, status: PolicyStatus | null | undefined): ConsoleSeat {
    const mine = live ? this.trace.filter((e) => e.team === live.team && e.role === role) : [];
    const intents: ConsoleIntent[] = [];
    const errors: ConsolePolicyError[] = [];
    const practice: ConsolePractice[] = [];
    for (let i = mine.length - 1; i >= 0; i--) {
      const e = mine[i]!;
      if (e.type === 'intent' && intents.length < this.opts.maxIntents) {
        const it = e.intent;
        const kind = typeof it === 'object' && it !== null && 'kind' in it && typeof it.kind === 'string' ? it.kind : null;
        intents.push({ at: e.at, tick: e.tick, source: e.source, kind, ack: e.ack, code: ackCode(e.ack) });
      } else if (e.type === 'policy_deploy' && !e.ok && e.error) {
        errors.push({ at: e.at, tick: e.tick, phase: 'deploy', code: e.error.code, ...(e.error.message !== undefined ? { message: e.error.message } : {}), ...(e.version !== undefined ? { version: e.version } : {}) });
      } else if (e.type === 'policy_call' && e.error && !e.pool) {
        errors.push({ at: e.at, tick: e.tick, phase: 'call', code: e.error, version: e.version });
      } else if (e.type === 'practice') {
        const r = e.result;
        practice.push({ at: e.at, role: e.role, opponent: e.opponent, ticks: e.ticks, seed: e.seed, outcome: r.ok ? r.outcome : null, ...(r.ok ? { version: r.policy.version } : { code: r.code }) });
      }
    }
    const lp = cmd?.lastPractice;
    if (lp && !practice.some((p) => p.at >= lp.at)) {
      practice.push({ at: lp.at, role: lp.role, opponent: lp.opponent, ticks: lp.ticks, seed: lp.seed, outcome: lp.outcome, version: lp.version });
      practice.sort((a, b) => b.at - a.at);
    }
    const counts = new Map<string, number>();
    for (const it of intents) if (!it.ack.ok) counts.set(it.code, (counts.get(it.code) ?? 0) + 1);
    const rejections = [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

    const mandate = live?.mandate ?? cmd?.mandate ?? null;
    const approvals = (cmd?.approvals ?? []).filter((entry) => entry.approval.status === 'pending' && (role === null || entry.role === role));
    if (role !== null && status?.approval?.status === 'pending') {
      const index = approvals.findIndex((entry) => entry.role === role);
      const current = { role, approval: status.approval };
      if (index === -1) approvals.push(current);
      else approvals[index] = current;
    }
    let policy: ConsolePolicy | null = null;
    if (status && status.version !== null) {
      const { version, runtime, calls, errors: errs, timeouts, meanMs, maxMs, intentsEmitted, intentsRejected } = status;
      policy = { version, runtime, calls, errors: errs, timeouts, meanMs, maxMs, intentsEmitted, intentsRejected };
    } else if (status || cmd) {
      // In the lobby a seat has no role yet: a single-role commander's active version is still that role's.
      const policyRole = role ?? (cmd?.roles.length === 1 ? cmd.roles[0]! : null);
      policy = { version: live ? (live.policyVersion ?? null) : (policyRole === null ? null : cmd?.policy.activeByRole[policyRole] ?? null) };
    }
    if (policy && cmd) policy.versions = cmd.policy.versions.length;
    const lastError = status && status.version !== null ? status.lastError : undefined;
    if (lastError && !errors.some((x) => x.code === lastError.code && x.message === lastError.message)) {
      errors.push({ at: 0, tick: 0, phase: 'call', code: lastError.code, ...(lastError.message !== undefined ? { message: lastError.message } : {}) });
    }
    const o = live ? this.lastObs.get(`${live.team}/${live.role}`) : undefined;
    let observation: ConsoleObservation | null = null;
    if (o) {
      const tokens = estimateTokens(o.bytes, this.opts.bytesPerToken);
      observation = { at: o.at, tick: o.tick, bytes: o.bytes, tokens, cost: this.opts.pricePerMTok === null ? null : (tokens * this.opts.pricePerMTok) / 1_000_000 };
    }
    const limits = mandate && typeof mandate.limits === 'object' && mandate.limits !== null ? (mandate.limits as Record<string, unknown>) : null;
    return {
      commander: cmd?.id ?? null,
      name: cmd?.name ?? null,
      roles: cmd?.roles ?? (role === null ? [] : [role]),
      target: cmd ? { kind: 'commander', commander: cmd.id, ...(live && this.wire?.match ? { seat: { match: this.wire.match, team: live.team, role: live.role } } : {}) } :
        { kind: 'seat', match: this.wire!.match!, team: live!.team, role: live!.role },
      role,
      team: live?.team ?? null,
      controller: live?.controller ?? cmd?.kind ?? 'none',
      live: live !== undefined,
      readiness: live ? this.wire!.readiness[live.role] ?? null : null,
      present: live?.agentActive ?? cmd?.connected ?? false,
      paused: live?.pause !== undefined,
      lastSeenAt: cmd?.lastSeenAt ?? null,
      mandate,
      scopes: live?.scopes ?? cmd?.scopes ?? [],
      limits,
      approvals,
      policy,
      logs: status && status.version !== null ? status.logs : [],
      intents,
      rejections,
      errors,
      practice: practice.slice(0, 10),
      observation,
    };
  }
}

/** Creates a stopped {@link PlayerConsole}; call `start()`. */
export function createPlayerConsole(opts: PlayerConsoleOptions): PlayerConsole {
  return new PlayerConsole(opts);
}
