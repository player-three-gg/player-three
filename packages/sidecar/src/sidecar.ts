/**
 * The reference sidecar (SPEC §20.8 (a)): a normal `PlayerThreeHost` whose game definition is a thin adapter over
 * the engine connection. The engine sends its manifest as plain JSON, owns the clock (`advance` → `match.step(n)`)
 * and answers every adapter and bot call synchronously; the host keeps MCP, OAuth, guards, scopes, mandates,
 * presence, policies and sessions exactly as in-process.
 */
import { defineManifest, PlayerThreeError, surfaceHash, type AnyManifest, type ApplyResult, type BotCommander, type GameAdapter, type GameDefinition, type Outcome, type Seat } from 'playerthree';
import { createPlayerThreeHost, type PlayerThreeHost, type PlayerThreeHostOptions, type PlayerThreeMatch } from 'playerthree/host';
import { EngineLink, SidecarCallError, type EngineLinkOptions, type LinkClosed } from './link.ts';
import { DEFAULT_HELLO_TIMEOUT_MS, HOOKS, isId, member, PROTOCOL, type Hook, type Msg, type Transport } from './protocol.ts';

/** Largest `advance` batch: bounds how long one engine request can hold the host. */
export const MAX_ADVANCE = 10_000;
const OUTCOMES: readonly string[] = ['win', 'loss', 'draw', 'running'];
const CREATE_KEYS: readonly string[] = ['seed', 'options', 'teams', 'alliances', 'controllers', 'botLevel'];

export interface SidecarOptions {
  transport: Transport;
  /** Per-call deadline (default 5000 ms); a missed deadline closes the connection. */
  callTimeoutMs?: number;
  /** How long a connected engine may take to send `hello` (default 10000 ms). */
  helloTimeoutMs?: number;
  /** Everything of the host but the game definition: stores, data dir, history, commander log, … */
  host?: Omit<PlayerThreeHostOptions<AnyManifest>, 'definition'>;
  /** Runs once the manifest is valid, before `ready`: serve MCP here and return its URL for `ready.mcp`. */
  serve?: (host: PlayerThreeHost) => string | undefined | Promise<string | undefined>;
  /** Sees every message, `in` from the engine and `out` to it, in this host's processing order. */
  tap?: EngineLinkOptions['tap'];
  /** Awaited before each engine request (`host` or `advance`) runs. Conformance orders engine ticks against agent calls with it. */
  gate?: (request: Msg) => Promise<void>;
}

export interface Sidecar {
  readonly link: EngineLink;
  /** Resolves with the host after a successful handshake; rejects when the handshake fails or the engine leaves first. */
  readonly ready: Promise<PlayerThreeHost>;
  /** Resolves once the engine connection is gone; every session is disposed by then. */
  readonly closed: Promise<LinkClosed>;
  /** The match behind an engine-created session. */
  match(session: string): PlayerThreeMatch | undefined;
  close(): void;
}

/** Thrown inside host-op handlers for a malformed request; becomes `ok:false` with this code. */
class RequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const seatArg = (seat: Seat): { team: string; role: string } => ({ team: seat.team, role: seat.role });

function tickOf(data: unknown, method: string, after?: number): number {
  const tick = member(data, 'tick');
  if (!Number.isSafeInteger(tick) || (tick as number) < 0) throw new SidecarCallError('bad_result', `${method} must return {"tick": integer ≥ 0}`);
  if (after !== undefined && (tick as number) <= after) throw new SidecarCallError('bad_result', `${method} must advance the tick (was ${after}, got ${tick})`);
  return tick as number;
}

interface AdapterContext {
  readonly link: EngineLink;
  readonly manifest: AnyManifest;
  readonly hooks: ReadonlySet<Hook>;
  /** Tracks a new session so the engine frees it once the host drops the adapter. */
  open(adapter: SidecarAdapter): void;
  /** A fresh host-assigned match session id (`s1`, `s2`, …). */
  nextSession(): string;
}

/** One engine-side match session. Every method is one synchronous `call`; outputs are guarded by the host as usual. */
class SidecarAdapter implements GameAdapter {
  readonly manifest: AnyManifest;
  readonly session: string;
  tick: number;
  readonly #ctx: AdapterContext;
  readonly #outcomes = new Map<string, Outcome>();
  matchData?: GameAdapter['matchData'];
  debugView?: GameAdapter['debugView'];
  observerView?: GameAdapter['observerView'];
  end?: GameAdapter['end'];
  forfeit?: GameAdapter['forfeit'];
  rank?: GameAdapter['rank'];
  clone?: GameAdapter['clone'];
  signalLimits?: GameAdapter['signalLimits'];

  constructor(ctx: AdapterContext, session: string, tick: number) {
    this.#ctx = ctx;
    this.manifest = ctx.manifest;
    this.session = session;
    this.tick = tick;
    const { hooks } = ctx;
    // Optional hooks exist only when the engine declared them, so the host sees exactly the in-process shape.
    if (hooks.has('matchData')) this.matchData = (seat) => this.#call('matchData', [seatArg(seat)]) as never;
    if (hooks.has('debugView')) this.debugView = () => this.#call('debugView', []);
    if (hooks.has('observerView')) this.observerView = () => this.#call('observerView', []);
    if (hooks.has('end')) this.end = (outcomes, ranks) => void this.#call('end', [outcomes, ranks]);
    if (hooks.has('forfeit')) this.forfeit = (team) => void this.#call('forfeit', [team]);
    if (hooks.has('rank')) this.rank = (team) => this.#call('rank', [team]) as number;
    if (hooks.has('signalLimits')) this.signalLimits = () => this.#call('signalLimits', []) as never;
    if (hooks.has('clone')) {
      this.clone = () => {
        const session = ctx.nextSession();
        const copy = new SidecarAdapter(ctx, session, tickOf(this.#call('clone', [session]), 'clone'));
        ctx.open(copy);
        return copy;
      };
    }
  }

  #call(method: string, args: unknown[]): unknown {
    return this.#ctx.link.call(this.session, method, args);
  }

  step(): void {
    this.tick = tickOf(this.#call('step', []), 'step', this.tick);
  }

  outcome(team: string): Outcome {
    // The host still reads outcomes while it disposes a session whose engine is gone (history, replay): answer with
    // the last outcome the engine reported rather than failing the teardown.
    if (this.#ctx.link.isClosed) return this.#outcomes.get(team) ?? 'running';
    const o = this.#call('outcome', [team]);
    if (typeof o !== 'string' || !OUTCOMES.includes(o)) throw new SidecarCallError('bad_result', 'outcome must be win, loss, draw or running');
    this.#outcomes.set(team, o as Outcome);
    return o as Outcome;
  }

  view(team: string, opts?: { snapshot: boolean }): never {
    return this.#call('view', [team, { snapshot: opts?.snapshot === true }]) as never;
  }

  observe(seat: Seat, sinceTick: number, detail: readonly string[]): never {
    return this.#call('observe', [seatArg(seat), sinceTick, detail]) as never;
  }

  apply(seat: Seat, intent: unknown, context?: unknown): ApplyResult<AnyManifest> {
    return this.#call('apply', [seatArg(seat), intent, context ?? null]) as ApplyResult<AnyManifest>;
  }

  report(team: string): never {
    return this.#call('report', [team]) as never;
  }

  events(seat: Seat, sinceTick: number): never[] {
    const events = this.#call('events', [seatArg(seat), sinceTick]);
    if (!Array.isArray(events)) throw new SidecarCallError('bad_result', 'events must return an array');
    return events as never[];
  }

  setSeatInfo(seat: Seat, info: { controller: string; mandate: unknown }): void {
    this.#call('setSeatInfo', [seatArg(seat), { controller: info.controller, mandate: info.mandate }]);
  }
}

function parseHooks(v: unknown): Set<Hook> | string {
  if (v === undefined) return new Set();
  const known: readonly string[] = HOOKS;
  if (!Array.isArray(v) || v.some((h) => typeof h !== 'string' || !known.includes(h)) || new Set(v).size !== v.length) {
    return `hooks must be distinct names from ${HOOKS.join(', ')}`;
  }
  return new Set(v as Hook[]);
}

/** Opens the engine link and runs the sidecar until the engine leaves. */
export async function startSidecar(opts: SidecarOptions): Promise<Sidecar> {
  const link = await EngineLink.open({
    transport: opts.transport,
    ...(opts.callTimeoutMs !== undefined ? { callTimeoutMs: opts.callTimeoutMs } : {}),
    ...(opts.tap ? { tap: opts.tap } : {}),
  });
  const ready = Promise.withResolvers<PlayerThreeHost>();
  ready.promise.catch(() => {});
  const matches = new Map<string, PlayerThreeMatch>();
  const adapters = new Map<string, SidecarAdapter>();
  let host: PlayerThreeHost | undefined;
  let helloSeen = false;
  let busy = false;
  let sessions = 0;
  let bots = 0;
  // Set by `create` while host.createMatch runs, so the host op learns its session id.
  let created: SidecarAdapter | undefined;

  // The host keeps no explicit lifetime for headless adapters (practice, replays, checkpoints) or bots: the engine
  // frees them when this host drops them.
  const released = new FinalizationRegistry<string>((session) => {
    if (link.isClosed) return;
    try {
      link.call(session, 'dispose', []);
    } catch {
      // The engine is gone or refused; nothing left to free on this side.
    }
  });

  const fatal = (code: 'protocol' | 'bad_frame' | 'invalid_manifest', message: string): void => link.close(code, message);

  // The hello deadline runs from the engine's connection, not from when the socket started listening.
  let helloTimer: NodeJS.Timeout | undefined;
  link.connected.then(
    () => {
      if (!helloSeen) helloTimer = setTimeout(() => fatal('protocol', 'no hello in time'), opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);
    },
    () => {},
  );

  const onHello = async (msg: Msg): Promise<void> => {
    clearTimeout(helloTimer);
    if (msg.protocol !== PROTOCOL) return fatal('protocol', `this host speaks protocol ${PROTOCOL}`);
    const hooks = parseHooks(msg.hooks);
    if (typeof hooks === 'string') return fatal('protocol', hooks);
    const raw = msg.manifest;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fatal('invalid_manifest', 'manifest must be a JSON object');
    let built: PlayerThreeHost;
    let hash: string;
    try {
      const manifest = defineManifest(raw as AnyManifest);
      if ((manifest.matchData !== undefined) !== hooks.has('matchData')) {
        return fatal('invalid_manifest', 'the matchData hook is required exactly when the manifest declares matchData');
      }
      const ctx: AdapterContext = {
        link,
        manifest,
        hooks,
        nextSession: () => `s${++sessions}`,
        open: (adapter) => {
          adapters.set(adapter.session, adapter);
          released.register(adapter, adapter.session, adapter);
        },
      };
      const definition: GameDefinition = {
        manifest,
        create: (args) => {
          const session = ctx.nextSession();
          const createArgs: Record<string, unknown> = { seed: args.seed, teams: args.teams };
          if (args.options !== undefined) createArgs.options = args.options;
          if (args.alliances !== undefined) createArgs.alliances = args.alliances;
          const adapter = new SidecarAdapter(ctx, session, tickOf(link.call(session, 'create', [createArgs]), 'create'));
          ctx.open(adapter);
          created = adapter;
          return adapter;
        },
        createBot: (seat, opponent, options) => {
          const id = `b${++bots}`;
          link.call(id, 'createBot', [seatArg(seat), opponent, options ?? null]);
          const bot: BotCommander = {
            init: (matchData) => void link.call(id, 'init', [matchData ?? null]),
            think: (obs) => {
              const intents = link.call(id, 'think', [obs]);
              if (!Array.isArray(intents)) throw new SidecarCallError('bad_result', 'think must return an array of intents');
              return intents as never[];
            },
          };
          released.register(bot, id);
          return bot;
        },
      };
      built = createPlayerThreeHost({ ...opts.host, definition });
      hash = surfaceHash(manifest);
    } catch (e) {
      return fatal('invalid_manifest', e instanceof Error ? e.message.slice(0, 500) : 'invalid manifest');
    }
    host = built;
    let mcp: string | undefined;
    try {
      mcp = await opts.serve?.(built);
    } catch (e) {
      built.dispose();
      return fatal('protocol', `host could not serve MCP: ${e instanceof Error ? e.message : String(e)}`);
    }
    link.send(mcp === undefined ? { op: 'ready', surfaceHash: hash } : { op: 'ready', surfaceHash: hash, mcp });
    ready.resolve(built);
  };

  const matchOf = (session: unknown): PlayerThreeMatch => {
    const match = typeof session === 'string' ? matches.get(session) : undefined;
    if (!match) throw new RequestError('unknown_session', 'no engine-created match with this session');
    return match;
  };

  const lastSeats = new Map<string, string>();
  const pushSeats = (session: string, match: PlayerThreeMatch): void => {
    const seats = match.seats();
    const json = JSON.stringify(seats);
    if (lastSeats.get(session) === json) return;
    lastSeats.set(session, json);
    link.send({ op: 'push', session, kind: 'seats', data: seats });
  };

  const dispose = (session: string): void => {
    const match = matchOf(session);
    matches.delete(session);
    lastSeats.delete(session);
    match.dispose();
    const adapter = adapters.get(session);
    adapters.delete(session);
    if (adapter) released.unregister(adapter);
    link.call(session, 'dispose', []);
  };

  const createMatch = (raw: unknown): { session: string; tick: number } => {
    const spec = raw ?? {};
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new RequestError('invalid', 'createMatch takes one options object');
    for (const key of Object.keys(spec)) if (!CREATE_KEYS.includes(key)) throw new RequestError('invalid', `createMatch does not take ${key}`);
    created = undefined;
    // The engine owns the clock: never start the host timer.
    const match = host!.createMatch({ ...(spec as object), realtime: false });
    const adapter = created as SidecarAdapter | undefined;
    if (!adapter) throw new RequestError('engine_error', 'createMatch did not create an engine session');
    matches.set(adapter.session, match);
    match.onStatus(() => {
      if (matches.get(adapter.session) === match) pushSeats(adapter.session, match);
    });
    match.onEnd((outcomes, ranks) => {
      if (matches.get(adapter.session) === match) link.send({ op: 'push', session: adapter.session, kind: 'ended', data: { outcomes, ranks } });
    });
    return { session: adapter.session, tick: match.tick };
  };

  const hostOps: Record<string, (args: unknown[]) => unknown> = {
    createMatch: ([spec]) => createMatch(spec),
    mintSeatToken: ([session, team, role]) => ({ token: matchOf(session).mintSeatToken(team as never, role as never) }),
    seats: ([session]) => matchOf(session).seats(),
    cards: ([session]) => matchOf(session).cards(),
    readiness: ([session]) => matchOf(session).readiness(),
    setController: ([session, team, role, controller]) => {
      matchOf(session).setController(team as never, role as never, controller as never);
      return null;
    },
    setMandate: ([session, team, role, mandate]) => {
      matchOf(session).setMandate(team as never, role as never, mandate as never);
      return null;
    },
    end: ([session, spec]) => matchOf(session).end(spec as never),
    forfeit: ([session, team]) => {
      matchOf(session).forfeit(team as never);
      return null;
    },
    dispose: ([session]) => {
      dispose(session as string);
      return null;
    },
  };

  const failure = (e: unknown): { code: string; message?: string } => {
    if (e instanceof RequestError || e instanceof SidecarCallError) return { code: e.code, message: e.message };
    if (e instanceof PlayerThreeError) return { code: e.code };
    return { code: 'engine_error', message: e instanceof Error ? e.message.slice(0, 200) : 'host operation failed' };
  };

  const onRequest = async (msg: Msg): Promise<void> => {
    const id = msg.id as number;
    let data: unknown;
    try {
      await opts.gate?.(msg);
      if (msg.op === 'advance') {
        const match = matchOf(msg.session);
        if (!isId(msg.n) || msg.n > MAX_ADVANCE) throw new RequestError('invalid', `n must be an integer in 1..${MAX_ADVANCE}`);
        if (match.over) throw new RequestError('over', 'the match is over');
        await match.step(msg.n);
        data = { tick: match.tick };
      } else {
        const op = typeof msg.method === 'string' && Object.hasOwn(hostOps, msg.method) ? hostOps[msg.method] : undefined;
        if (!op) throw new RequestError('unknown_method', 'unknown host method');
        const args = msg.args ?? [];
        if (!Array.isArray(args)) throw new RequestError('invalid', 'args must be an array');
        data = op(args);
      }
    } catch (e) {
      link.send({ op: 'result', id, ok: false, ...failure(e) });
      return;
    }
    link.send({ op: 'result', id, ok: true, data: data ?? null });
  };

  link.onMessage = (msg) => {
    if (msg.op === 'hello') {
      if (helloSeen) return fatal('protocol', 'duplicate hello');
      helloSeen = true;
      void onHello(msg);
      return;
    }
    if (!host) return fatal('protocol', 'hello must come first');
    if (!isId(msg.id)) return fatal('bad_frame', 'request id must be a positive integer');
    // Engine requests are sequential: the engine waits for each result (and answers calls meanwhile).
    if (busy) return fatal('protocol', 'one engine request at a time');
    busy = true;
    void onRequest(msg).finally(() => {
      busy = false;
    });
  };

  const closed = link.closed.then((c) => {
    clearTimeout(helloTimer);
    ready.reject(new Error(`engine left before the handshake finished: ${c.reason}`));
    matches.clear();
    adapters.clear();
    // Disposing the host disposes every match: tokens are revoked and MCP seats dropped.
    try {
      host?.dispose();
    } catch (e) {
      console.error(`playerthree/sidecar: disposing after the engine left failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return c;
  });

  return {
    link,
    ready: ready.promise,
    closed,
    match: (session) => matches.get(session),
    close: () => link.close(),
  };
}
