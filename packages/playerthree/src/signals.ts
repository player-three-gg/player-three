/**
 * Team signals: typed requests between teammates of any seat kind (human, agent, policy, bot).
 *
 * The game declares a closed vocabulary (`manifest.signals`): signal kinds with typed payloads (enums, numbers,
 * coordinates, entity ids — never free text) and per-role cards listing what each role answers. Seats emit them as
 * two reserved intents through the ordinary intent pipeline (`signal`, `signal_update`), so every seat kind, every
 * binding, sequences and replays carry them with no new channel. The host keeps one board per match team and
 * attaches the seat's slice (`signals: {inbox, sent}`) to every observation and the team's slice to every team view.
 *
 * Shapes follow the Agent2Agent (A2A) protocol where it fits a deterministic, team-only, fog-safe match: a signal is
 * an A2A Task (id, lifecycle state), its payload a structured data part, role cards are Agent Card skills (capability
 * discovery), and delivery is push (observations, `game_wait` wakes). Transport, open text parts and auth stay out.
 */
import type { AnyManifest } from './manifest.ts';
import { t, type EnumS, type Fields, type IdS, type IntS, type ListS, type ObjS, type OptS, type Schema, type UnionS } from './schema.ts';

/** Reserved intent kinds when `manifest.signals` is declared. */
export const SIGNAL_INTENT = 'signal';
export const SIGNAL_UPDATE_INTENT = 'signal_update';
/** `to` value addressing every teammate whose card answers the signal. */
export const SIGNAL_TEAM = 'team';
/** The reserved top-level observation/view member. */
export const SIGNALS_FIELD = 'signals';
/** Signal ids are `sg_<n>`, numbered per team board. */
export const SIGNAL_ID_PREFIX = 'sg';

/** Updates a seat may send: responders `ack` / `decline` / `done` / `fail`, the requester `cancel`. */
export const SIGNAL_UPDATES = ['ack', 'decline', 'done', 'fail', 'cancel'] as const;
export type SignalUpdate = (typeof SIGNAL_UPDATES)[number];

/**
 * A2A TaskState names: `submitted` (sent, nobody took it), `working` (acked), then terminal `completed` (done),
 * `rejected` (declined), `failed` (the responder tried and could not), `canceled` (by the requester) or `expired`
 * (open past its `expires` tick — the one state A2A lacks: a match clock, not a client, ends unanswered requests).
 */
export const SIGNAL_STATES = ['submitted', 'working', 'completed', 'rejected', 'failed', 'canceled', 'expired'] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

/**
 * Closed reasons a signal intent is refused (`{ok:false, code:'signal', signalCode}`):
 * - `disabled`: this match has signals off;
 * - `unsupported`: no teammate's card answers this kind/payload at that address (yourself included);
 * - `unknown_signal`: no such signal on your team's board (expired ones leave it after `keepTicks`);
 * - `not_recipient`: you neither sent nor received it, or another teammate already took it;
 * - `closed`: it is already in a terminal state;
 * - `too_many_open`: you already have `maxOpen` open signals.
 */
export const SIGNAL_CODES = ['disabled', 'unsupported', 'unknown_signal', 'not_recipient', 'closed', 'too_many_open'] as const;
export type SignalCode = (typeof SIGNAL_CODES)[number];

/** Entry members the host owns; signal params must not use these names. */
export const SIGNAL_ENTRY_FIELDS = ['kind', 'id', 'from', 'to', 'tick', 'expires', 'state', 'by'] as const;

const OPEN: ReadonlySet<SignalState> = new Set(['submitted', 'working']);
const MAX_TICK = 2 ** 31 - 1;

/** One signal kind of `manifest.signals.kinds`: who may send it and its typed payload. */
export interface SignalKindDef<P extends Fields = Fields> {
  /** Roles that may send this kind. */
  readonly roles: readonly string[];
  /** Typed payload. Closed schema nodes only and no `str` anywhere: signals carry no text by construction. */
  readonly params: P;
  /** Static developer text for agents (trusted): what the request means and how a responder answers it. */
  readonly doc: string;
}

/**
 * One capability on a role's card (an A2A Agent Card skill): the role answers `kind`, optionally only for the listed
 * values of enum params (`where: { need: ['scan'] }`). Routing checks cards: nobody is asked for what they cannot do.
 */
export interface SignalSkill {
  readonly kind: string;
  readonly where?: { readonly [param: string]: readonly string[] };
}

export interface SignalVocabulary<K extends Record<string, SignalKindDef> = Record<string, SignalKindDef>> {
  readonly kinds: K;
  /** Per role: the signals it answers. Roles without a card answer nothing (they may still send). */
  readonly cards: { readonly [role: string]: readonly SignalSkill[] };
}

/** `control.signals`: the host rule bounding what one seat can put on its team's board. */
export interface SignalLimits {
  /** New signals per seat per second of game time (token bucket in ticks, so bots and replays agree). */
  readonly perSecond: number;
  readonly burst: number;
  /** Open (submitted/working) signals per sender; also the sender's share of the board. */
  readonly maxOpen: number;
  /** An open signal expires this many ticks after it was sent. */
  readonly ttlTicks: number;
  /** A closed signal stays visible this many ticks (so the requester sees how it ended), then leaves the board. */
  readonly keepTicks: number;
}

/** Inclusive bounds of each `control.signals` limit. */
export const SIGNAL_LIMIT_BOUNDS: Readonly<Record<keyof SignalLimits, readonly [number, number, boolean]>> = {
  perSecond: [0.01, 100, false],
  burst: [1, 100, true],
  maxOpen: [1, 32, true],
  ttlTicks: [1, MAX_TICK, true],
  keepTicks: [0, MAX_TICK, true],
};

type EntryFields<R extends readonly string[]> = {
  readonly id: IdS;
  readonly from: EnumS<R>;
  readonly to: EnumS;
  readonly tick: IntS;
  readonly expires: IntS;
  readonly state: EnumS<typeof SIGNAL_STATES>;
  readonly by: OptS<EnumS<R>>;
};
type SendFields = { readonly to: EnumS };
type Kinds = Record<string, SignalKindDef>;

/** One board entry as every recipient sees it: the payload plus host-owned lifecycle members. */
export type SignalEntrySchema<R extends readonly string[], K extends Kinds> = UnionS<'kind', { [k in keyof K & string]: K[k]['params'] & EntryFields<R> }>;

/** The generated members a game composes into its manifest (`signalSchemas`). */
export interface SignalSchemas<R extends readonly string[], K extends Kinds> {
  readonly intents: {
    readonly signal: { readonly roles: readonly string[]; readonly params: { readonly signal: UnionS<'kind', { [k in keyof K & string]: K[k]['params'] & SendFields }> }; readonly doc: string };
    readonly signal_update: { readonly roles: readonly string[]; readonly params: { readonly id: IdS; readonly update: EnumS<typeof SIGNAL_UPDATES> }; readonly doc: string };
  };
  /** The `signals` observation member: this seat's inbox and the signals it sent. */
  readonly observation: ObjS<{ readonly inbox: ListS<SignalEntrySchema<R, K>>; readonly sent: ListS<SignalEntrySchema<R, K>> }>;
  /** The `signals` team-view member: the whole team board (humans, observers). */
  readonly view: ListS<SignalEntrySchema<R, K>>;
}

/** Addresses a kind accepts: roles whose card answers it, then `team`. */
function targets(roles: readonly string[], vocab: SignalVocabulary, kind: string): string[] {
  return [...roles.filter((r) => (vocab.cards[r] ?? []).some((s) => s.kind === kind)), SIGNAL_TEAM];
}

/**
 * The reserved intents and the `signals` observation/view members for a vocabulary. A game spreads `intents` into its
 * intent map and adds `observation` / `view` as the `signals` member of its observation and view objects; the host
 * fills that member (a game's `observe` / `view` leave it out). `defineManifest` checks they match exactly.
 */
export function signalSchemas<const R extends readonly string[], const K extends Kinds>(
  roles: R,
  vocab: SignalVocabulary<K>,
  limits: SignalLimits,
): SignalSchemas<R, K> {
  const kinds = Object.keys(vocab.kinds);
  const senders = roles.filter((r) => kinds.some((k) => (vocab.kinds[k] as SignalKindDef).roles.includes(r)));
  const roleEnum = t.enum(roles as unknown as [string, ...string[]]) as unknown as EnumS<R>;
  const send: Record<string, Fields> = {};
  const entry: Record<string, Fields> = {};
  for (const k of kinds) {
    const def = vocab.kinds[k] as SignalKindDef;
    const to = t.enum(targets(roles, vocab, k) as [string, ...string[]], 'A teammate role whose card answers this signal, or `team`: every teammate that answers it.');
    send[k] = { ...def.params, to };
    entry[k] = {
      ...def.params,
      id: t.id(SIGNAL_ID_PREFIX, 'Team-local signal id; reference it in signal_update.'),
      from: roleEnum,
      to,
      tick: t.int(0, MAX_TICK, 'Tick it was sent.'),
      expires: t.int(0, MAX_TICK, 'Tick an open signal expires.'),
      state: t.enum(SIGNAL_STATES, 'submitted → working (acked) → completed | rejected | failed | canceled | expired.'),
      by: t.opt(roleEnum),
    };
  }
  const entrySchema = t.union('kind', entry, 'A team signal. `from` sent it to `to`; `by` is the teammate that took or closed it.');
  const sideMax = roles.length * limits.maxOpen;
  return {
    intents: {
      signal: {
        roles: senders,
        params: { signal: t.union('kind', send, 'The signal: its kind, payload and `to`.') },
        doc: 'Ask teammates for help with a typed team signal (no text). `to` is one teammate role or `team`. It reaches only your team and appears in the recipients\' `signals.inbox` and your `signals.sent`; follow it there by id. Briefing topic `signals` lists the kinds and who answers what.',
      },
      signal_update: {
        roles: [...roles],
        params: {
          id: t.id(SIGNAL_ID_PREFIX, 'A signal from your inbox or sent list.'),
          update: t.enum(SIGNAL_UPDATES, 'Responders: ack (taking it), decline, done, fail. Requester: cancel.'),
        },
        doc: 'Answer a team signal: ack (you are on it), decline, done, fail; or cancel one you sent. The requester sees the new state.',
      },
    } as unknown as SignalSchemas<R, K>['intents'],
    observation: t.obj({
      inbox: t.list(entrySchema, sideMax - limits.maxOpen, 'Signals teammates sent you (open first-come for `team` signals), oldest first.'),
      sent: t.list(entrySchema, limits.maxOpen, 'Signals you sent and their state, oldest first.'),
    }, 'Team signals (host-provided).') as unknown as SignalSchemas<R, K>['observation'],
    view: t.list(entrySchema, sideMax, 'The team\'s signal board (host-provided), oldest first.') as unknown as SignalSchemas<R, K>['view'],
  };
}

// ---------------------------------------------------------------- manifest validation

const ENUM_LITERAL = /^[A-Za-z][A-Za-z0-9_.<>]{0,47}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Canonical JSON (sorted keys, undefined members dropped) for exact schema comparison. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** No text anywhere in a payload: the closed DSL's only text node is `str`. */
function hasText(s: unknown): boolean {
  if (!isObj(s)) return false;
  switch (s.t) {
    case 'str': return true;
    case 'list': case 'opt': return hasText(s.item);
    case 'obj': return isObj(s.fields) && Object.values(s.fields).some(hasText);
    case 'union': return isObj(s.variants) && Object.values(s.variants).some((f) => isObj(f) && Object.values(f).some(hasText));
    default: return false;
  }
}

/**
 * Structural checks of `manifest.signals` and the generated members it requires. `fail(path, why)` throws.
 * `checkFields` is the manifest's own field-map check (closed nodes, field names).
 */
export function checkSignals(m: AnyManifest, fail: (path: string, why: string) => never, checkFields: (path: string, fields: unknown) => void): void {
  const vocab: unknown = m.signals;
  const limits: unknown = m.control.signals;
  if (vocab === undefined) {
    if (limits !== undefined) fail('control.signals', 'needs manifest.signals (the vocabulary)');
    return;
  }
  if (!isObj(limits)) fail('control.signals', 'required with manifest.signals');
  const roles = (m.roles as EnumS).values as readonly string[];
  if (roles.includes(SIGNAL_TEAM)) fail('roles', `\`${SIGNAL_TEAM}\` is the signal broadcast address; rename that role`);
  if (!isObj(vocab) || Object.keys(vocab).some((k) => k !== 'kinds' && k !== 'cards')) fail('signals', 'must be { kinds, cards }');
  if (!isObj(vocab.kinds) || Object.keys(vocab.kinds).length === 0) fail('signals.kinds', 'at least one signal kind is required');
  for (const [kind, d] of Object.entries(vocab.kinds)) {
    const path = `signals.kinds.${kind}`;
    if (!ENUM_LITERAL.test(kind)) fail(path, `kind must match ${ENUM_LITERAL}`);
    if (!isObj(d) || Object.keys(d).some((k) => !['roles', 'params', 'doc'].includes(k))) fail(path, 'must be { roles, params, doc }');
    if (!Array.isArray(d.roles) || d.roles.length === 0) fail(`${path}.roles`, 'must list at least one sender role');
    for (const r of d.roles) if (!roles.includes(r)) fail(`${path}.roles`, `unknown role ${JSON.stringify(r)}`);
    if (typeof d.doc !== 'string' || d.doc.length === 0 || d.doc.length > 4000) fail(`${path}.doc`, 'required (≤4000 chars)');
    checkFields(`${path}.params`, d.params);
    for (const [k, f] of Object.entries(d.params as Record<string, unknown>)) {
      if ((SIGNAL_ENTRY_FIELDS as readonly string[]).includes(k)) fail(`${path}.params.${k}`, `\`${k}\` is a host-owned signal member`);
      if (hasText(f)) fail(`${path}.params.${k}`, 'signals carry no text: use enums, numbers, ids');
    }
  }
  if (!isObj(vocab.cards)) fail('signals.cards', 'must map roles to the signals they answer');
  const answered = new Set<string>();
  for (const [role, skills] of Object.entries(vocab.cards)) {
    if (!roles.includes(role)) fail(`signals.cards.${role}`, 'not a role');
    if (!Array.isArray(skills)) fail(`signals.cards.${role}`, 'must be a list of { kind, where? }');
    const seen = new Set<string>();
    for (const [i, s] of skills.entries()) {
      const path = `signals.cards.${role}[${i}]`;
      if (!isObj(s) || Object.keys(s).some((k) => k !== 'kind' && k !== 'where')) fail(path, 'must be { kind, where? }');
      const def = isObj(vocab.kinds) ? vocab.kinds[s.kind as string] : undefined;
      if (typeof s.kind !== 'string' || !isObj(def)) fail(`${path}.kind`, 'unknown signal kind');
      if (seen.has(s.kind)) fail(`${path}.kind`, 'one skill per kind (list every accepted value in `where`)');
      seen.add(s.kind);
      answered.add(s.kind);
      if (s.where === undefined) continue;
      if (!isObj(s.where) || Object.keys(s.where).length === 0) fail(`${path}.where`, 'must name at least one enum param');
      for (const [field, values] of Object.entries(s.where)) {
        const p = (def.params as Record<string, Schema>)[field];
        const node = p?.t === 'opt' ? p.item : p;
        if (node?.t !== 'enum') fail(`${path}.where.${field}`, 'must be an enum param of the kind');
        if (!Array.isArray(values) || values.length === 0 || values.some((v) => !(node.values as readonly unknown[]).includes(v))) {
          fail(`${path}.where.${field}`, 'must list declared values of that enum');
        }
      }
    }
  }
  for (const kind of Object.keys(vocab.kinds)) if (!answered.has(kind)) fail(`signals.kinds.${kind}`, 'no role card answers it');
  for (const k of Object.keys(limits)) if (!(k in SIGNAL_LIMIT_BOUNDS)) fail(`control.signals.${k}`, 'unknown field');
  for (const [k, [min, max, integer]] of Object.entries(SIGNAL_LIMIT_BOUNDS)) {
    const v = limits[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
      fail(`control.signals.${k}`, `must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`);
    }
  }
  let generated: SignalSchemas<readonly string[], Kinds>;
  try {
    generated = signalSchemas(roles, vocab as unknown as SignalVocabulary, limits as unknown as SignalLimits);
  } catch (error) {
    fail('signals', error instanceof Error ? error.message : 'invalid vocabulary');
  }
  const intents = m.intents as Record<string, unknown>;
  for (const kind of [SIGNAL_INTENT, SIGNAL_UPDATE_INTENT] as const) {
    if (canonical(intents[kind]) !== canonical(generated.intents[kind])) fail(`intents.${kind}`, 'must be signalSchemas(...).intents.' + kind);
  }
  for (const [member, want] of [['observation', generated.observation], ['view', generated.view]] as const) {
    const s = m[member] as Schema;
    if (s.t !== 'obj') fail(member, 'must be a t.obj when signals are declared');
    if (canonical((s.fields as Fields)[SIGNALS_FIELD]) !== canonical(want)) fail(`${member}.${SIGNALS_FIELD}`, `must be signalSchemas(...).${member}`);
  }
}

// ---------------------------------------------------------------- board

/** One entry as seats see it. Payload params sit beside the host members. */
export type SignalEntry = {
  kind: string;
  id: string;
  from: string;
  to: string;
  tick: number;
  expires: number;
  state: SignalState;
  by?: string;
} & Record<string, unknown>;

/** The ack of one `signal` / `signal_update` intent. */
export type SignalAck =
  | { ok: true }
  | { ok: false; code: 'rate_limited' | 'forbidden_role' }
  | { ok: false; code: 'signal'; signalCode: SignalCode };

interface Rec {
  entry: SignalEntry;
  recipients: readonly string[];
  declined: string[];
  /** Tick it turned terminal (−1 while open). */
  closedAt: number;
}

interface Bucket { tokens: number; at: number }

interface TeamBoard {
  next: number;
  recs: Rec[];
}

/** A seat's slice: what it received and what it sent (the `signals` observation member). */
export interface SeatSignals {
  inbox: SignalEntry[];
  sent: SignalEntry[];
}

const refuse = (signalCode: SignalCode): SignalAck => ({ ok: false, code: 'signal', signalCode });

/**
 * A match's signal boards, one per team: the deterministic state machine every host loop shares (live matches,
 * practice, replays, a game's own headless runner). Input is already schema-checked; time is the match tick, never
 * wall time. `limits` null: signals are off for this match (every signal intent fails `disabled`).
 */
export class SignalBoard {
  private readonly vocab: SignalVocabulary;
  private readonly roles: readonly string[];
  private readonly tickRate: number;
  private readonly boards = new Map<string, TeamBoard>();
  private readonly buckets = new Map<string, Bucket>();
  /** Per seat (`team/role`): bumped whenever something it should notice changes (new inbox entry, its request moved). */
  private readonly versions = new Map<string, number>();
  readonly limits: SignalLimits | null;

  constructor(manifest: AnyManifest, teams: readonly string[], limits: SignalLimits | null) {
    if (!manifest.signals) throw new Error('playerthree/signals: the manifest declares no signals');
    this.vocab = manifest.signals;
    this.roles = (manifest.roles as EnumS).values;
    this.tickRate = manifest.tickRate;
    this.limits = limits;
    for (const team of teams) this.boards.set(team, { next: 1, recs: [] });
  }

  /** The limits a match runs with: the manifest's, narrowed by the adapter's per-match `signalLimits()` (null = off). */
  static limitsFor(manifest: AnyManifest, adapter: { signalLimits?(): SignalLimits | null }): SignalLimits | null {
    const max = manifest.control.signals;
    if (!max) return null;
    if (!adapter.signalLimits) return max;
    const own = adapter.signalLimits();
    if (own === null) return null;
    for (const [k, [min]] of Object.entries(SIGNAL_LIMIT_BOUNDS) as [keyof SignalLimits, readonly [number, number, boolean]][]) {
      const v = own[k];
      // A match may only narrow the manifest rule (it sizes the observation lists), never widen it.
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max[k]) throw new Error(`playerthree/signals: adapter signalLimits().${k} outside [${min}, ${max[k]}]`);
    }
    return { perSecond: own.perSecond, burst: own.burst, maxOpen: own.maxOpen, ttlTicks: own.ttlTicks, keepTicks: own.keepTicks };
  }

  private board(team: string): TeamBoard {
    const b = this.boards.get(team);
    if (!b) throw new Error('playerthree/signals: unknown team');
    return b;
  }

  private bump(team: string, role: string): void {
    const key = `${team}/${role}`;
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  /** Changes counter of one seat's slice; compare against the last one an agent saw to wake it. */
  version(team: string, role: string): number {
    return this.versions.get(`${team}/${role}`) ?? 0;
  }

  /** Does `role`'s card answer this signal? */
  private answers(role: string, kind: string, payload: Record<string, unknown>): boolean {
    const skill = (this.vocab.cards[role] ?? []).find((s) => s.kind === kind);
    if (!skill) return false;
    if (!skill.where) return true;
    return Object.entries(skill.where).every(([field, values]) => payload[field] === undefined || values.includes(payload[field] as string));
  }

  /**
   * Apply one schema-checked `signal` / `signal_update` intent from a seat at `tick` (the tick about to step).
   * Deterministic: same board, same input, same result.
   */
  apply(team: string, role: string, intent: { kind: string } & Record<string, unknown>, tick: number): SignalAck {
    if (!this.limits) return refuse('disabled');
    const board = this.board(team);
    if (intent.kind === SIGNAL_INTENT) return this.send(team, board, role, intent['signal'] as { kind: string; to: string } & Record<string, unknown>, tick, this.limits);
    if (intent.kind === SIGNAL_UPDATE_INTENT) return this.update(team, board, role, intent['id'] as string, intent['update'] as SignalUpdate, tick);
    throw new Error('playerthree/signals: not a signal intent');
  }

  private send(team: string, board: TeamBoard, role: string, signal: { kind: string; to: string } & Record<string, unknown>, tick: number, limits: SignalLimits): SignalAck {
    const def = this.vocab.kinds[signal.kind];
    if (!def) throw new Error('playerthree/signals: unchecked signal kind');
    if (!def.roles.includes(role)) return { ok: false, code: 'forbidden_role' };
    const { kind, to, ...payload } = signal;
    const recipients = (to === SIGNAL_TEAM ? this.roles : [to]).filter((r) => r !== role && this.answers(r, kind, payload));
    if (recipients.length === 0) return refuse('unsupported');
    let open = 0;
    let closed = 0;
    let oldestClosed = -1;
    for (let i = 0; i < board.recs.length; i++) {
      const rec = board.recs[i]!;
      if (rec.entry.from !== role) continue;
      if (rec.closedAt < 0) open++;
      else if (closed++ === 0) oldestClosed = i;
    }
    if (open >= limits.maxOpen) return refuse('too_many_open');
    const key = `${team}/${role}`;
    const bucket = this.buckets.get(key) ?? { tokens: limits.burst, at: tick };
    bucket.tokens = Math.min(limits.burst, bucket.tokens + (Math.max(0, tick - bucket.at) * limits.perSecond) / this.tickRate);
    bucket.at = tick;
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return { ok: false, code: 'rate_limited' };
    bucket.tokens -= 1;
    // The sender's share of the board is maxOpen entries: a new signal pushes out its oldest closed one.
    if (open + closed >= limits.maxOpen) board.recs.splice(oldestClosed, 1);
    const entry: SignalEntry = {
      ...payload,
      kind,
      id: `${SIGNAL_ID_PREFIX}_${board.next}`,
      from: role,
      to,
      tick,
      expires: Math.min(MAX_TICK, tick + limits.ttlTicks),
      state: 'submitted',
    };
    // Team-local ids: a team must not learn how many signals another team sent. 9 digits wrap long after any match.
    board.next = board.next >= 999_999_999 ? 1 : board.next + 1;
    board.recs.push({ entry, recipients, declined: [], closedAt: -1 });
    for (const r of recipients) this.bump(team, r);
    return { ok: true };
  }

  private update(team: string, board: TeamBoard, role: string, id: string, update: SignalUpdate, tick: number): SignalAck {
    const rec = board.recs.find((r) => r.entry.id === id);
    if (!rec) return refuse('unknown_signal');
    const e = rec.entry;
    const sender = e.from === role;
    const recipient = rec.recipients.includes(role) && !rec.declined.includes(role);
    if (!sender && !recipient) return refuse('not_recipient');
    if (rec.closedAt >= 0) return refuse('closed');
    let next: SignalState;
    if (update === 'cancel') {
      if (!sender) return refuse('not_recipient');
      next = 'canceled';
    } else {
      if (!recipient) return refuse('not_recipient');
      // A `working` signal belongs to whoever acked it first.
      if (e.state === 'working' && e.by !== role) return refuse('not_recipient');
      if (update === 'ack') {
        if (e.state === 'working') return { ok: true };
        next = 'working';
      } else if (update === 'decline') {
        if (e.state === 'submitted' && rec.recipients.length > 1) {
          rec.declined.push(role);
          // A broadcast is rejected only once every recipient declined it.
          if (rec.declined.length < rec.recipients.length) return { ok: true };
        }
        next = 'rejected';
      } else next = update === 'done' ? 'completed' : 'failed';
    }
    e.state = next;
    if (update !== 'cancel') e.by = role;
    if (!OPEN.has(next)) rec.closedAt = tick;
    if (!sender) this.bump(team, e.from);
    for (const r of rec.recipients) if (r !== role && !rec.declined.includes(r)) this.bump(team, r);
    return { ok: true };
  }

  /** Tick boundary: open signals past `expires` expire, closed ones leave after `keepTicks`. Call before deciding. */
  advance(tick: number): void {
    if (!this.limits) return;
    const keep = this.limits.keepTicks;
    for (const [team, board] of this.boards) {
      if (board.recs.length === 0) continue;
      for (const rec of board.recs) {
        if (rec.closedAt >= 0 || tick < rec.entry.expires) continue;
        rec.entry.state = 'expired';
        rec.closedAt = tick;
        this.bump(team, rec.entry.from);
        for (const r of rec.recipients) if (!rec.declined.includes(r)) this.bump(team, r);
      }
      if (board.recs.some((r) => r.closedAt >= 0 && tick >= r.closedAt + keep)) board.recs = board.recs.filter((r) => r.closedAt < 0 || tick < r.closedAt + keep);
    }
  }

  /** One seat's slice (fresh copies). Declined broadcast entries leave the decliner's inbox. */
  seat(team: string, role: string): SeatSignals {
    const out: SeatSignals = { inbox: [], sent: [] };
    for (const rec of this.board(team).recs) {
      if (rec.entry.from === role) out.sent.push({ ...rec.entry });
      else if (rec.recipients.includes(role) && !rec.declined.includes(role)) out.inbox.push({ ...rec.entry });
    }
    return out;
  }

  /** The team's whole board (fresh copies): its team view member. */
  team(team: string): SignalEntry[] {
    return this.board(team).recs.map((r) => ({ ...r.entry }));
  }

  /** Independent copy (persistent-session checkpoints, replay positions). */
  clone(): SignalBoard {
    const copy = Object.create(SignalBoard.prototype) as SignalBoard;
    const fields = copy as unknown as {
      vocab: SignalVocabulary; roles: readonly string[]; tickRate: number; limits: SignalLimits | null;
      boards: Map<string, TeamBoard>; buckets: Map<string, Bucket>; versions: Map<string, number>;
    };
    fields.vocab = this.vocab;
    fields.roles = this.roles;
    fields.tickRate = this.tickRate;
    fields.limits = this.limits;
    fields.boards = new Map([...this.boards].map(([team, b]) => [team, {
      next: b.next,
      recs: b.recs.map((r) => ({ entry: { ...r.entry }, recipients: r.recipients, declined: [...r.declined], closedAt: r.closedAt })),
    }]));
    fields.buckets = new Map([...this.buckets].map(([k, v]) => [k, { ...v }]));
    fields.versions = new Map(this.versions);
    return copy;
  }
}

/** Is this checked intent one of the reserved signal intents of a manifest that declares signals? */
export function isSignalIntent(m: AnyManifest, intent: { kind: string }): boolean {
  return m.signals !== undefined && (intent.kind === SIGNAL_INTENT || intent.kind === SIGNAL_UPDATE_INTENT);
}

/** Attach a seat's slice to a game observation (the game leaves `signals` out; the host owns it). */
export function withSignals(raw: unknown, signals: SeatSignals | SignalEntry[]): unknown {
  return isObj(raw) ? { ...raw, [SIGNALS_FIELD]: signals } : raw;
}

/** Empty slice for observations taken outside a match board (deploy probes, lint). */
export function emptySeatSignals(): SeatSignals {
  return { inbox: [], sent: [] };
}
