/**
 * One live match: seats, controllers, directives, the intent pipeline, the tick loop (bots, policies, stream
 * pushes, view pushes, waiters), policies with versions, practice, pool, replays and protocol messages.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ResultRows } from '../arena.ts';
import { ObserverStream, observerRetentionMs } from './observers.ts';
import { ViewStream } from './views.ts';
import { callMethod, MAX_STREAM_EVERY_TICKS, parseClientMessage, safeSeq } from './messages.ts';
import { parseDecisionUsage } from './usage.ts';
import { buildBriefing, canonicalJson, servedSkills, surfaceHash } from '../briefing.ts';
import type { CommanderLogUsage } from '../commander-log.ts';
import { skillPage } from '../skill.ts';
import { topicPage } from '../topics.ts';
import {
  LOBBY_INSTRUCTIONS,
  MATCH_INSTRUCTION,
  METHOD_MODE,
  METHOD_SCOPE,
  SCOPES,
  defaultScopes,
  type LobbyStart,
  type LobbyState,
  type ReadyResult,
  type SessionPhase,
  type Approval,
  type ApprovalRequest,
  type Mandate,
  type PauseInfo,
  type ResumeReason,
  type SeatPause,
  type Scope,
  type SequenceRequest,
  type SequenceResult,
  type Briefing,
  type ControlMethod,
  type DeployResult,
  type IntentAck,
  type PolicyArtifact,
  type PolicyError,
  type PolicyImportResult,
  type PolicyExportRequest,
  type PolicySource,
  type PolicyStats,
  type PracticeRequest,
  type PracticeResult,
  type OwnerMessage,
  type PublishResult,
  type Said,
  type SayResult,
  type StarterRef,
  type SeatControl,
  type SeatStatus,
  type WaitResult,
} from '../control.ts';
import { createGuard, validateUnknown, type OutboundGuard } from '../guard.ts';
import { LIMITS } from '../mcp/surface.ts';
import {
  CONTROLLERS,
  intentSchema,
  observationSections,
  resolveDetail,
  type DetailRequest,
  type AnyManifest,
  type Controller,
  type FinalOutcome,
  type GameAdapter,
  type IntentSource,
  type GameMetricRecorder,
  type GameMetrics,
  type MandateOf,
  type GameDefinition,
  type MatchOptionsOf,
  type Outcome,
  type ReportOf,
  type RoleOf,
  type SkillDef,
  type TeamOf,
  type ViewOf,
} from '../manifest.ts';
import type { ClientMsg, ObserverFrame, ObserverGrant, ObserverMessage, Principal, ServerErrorCode, ServerMsg, ViewMessage } from '../protocol.ts';
import { t, type EnumS, type ObjS, type UnionS } from '../schema.ts';
import { isSignalIntent, SignalBoard, withSignals } from '../signals.ts';
import {
  applyIntent,
  annotateLoadError,
  checkIntent,
  DeployQueue,
  defaultMandate,
  matchDataFor,
  mergeMatchOptions,
  parseEndOutcomes,
  parseMandate,
  looseDefinition,
  parseArgs,
  parseArtifact,
  policyArtifactHash,
  parseChatRoles,
  parseChatText,
  ranksByOutcome,
  rejectCode,
  starterOf,
  validRanks,
  type LooseAdapter,
  type LooseDefinition,
  type SeatKey,
  type Sides,
  type Sim,
} from './pipeline.ts';
import { loadSeatArtifact, PolicyRun } from './policy.ts';
import { createSeatBot, eachBot, type SeatBot } from './seat-bot.ts';
import type { PolicyDetail } from '../policy/types.ts';
import { starterCatalog, type StarterCatalog } from '../policy/starters.ts';
import type { PolicyExportPage, PolicyPackage } from '../policy-package.ts';
import { DEPLOYED } from './store.ts';
import type { Pool } from './pool.ts';
import { parsePracticeRequest, runPractice, thinkPeriod } from './practice.ts';
import type {
  PlayerThreeMatch,
  PlayerThreeTraceEvent,
  CreateMatchOptions,
  GuardChannel,
  CommanderSettings,
  MatchTokens,
  ObserverPolicy,
  CommentaryEvent,
  PoolEntry,
  ReadyCheck,
  Replay,
  ReplayEntry,
  ReplayPosition,
  SeatInfo,
  PublicSeatCard,
  ReadinessSnapshot,
  ReadinessState,
  SeatAssignment,
  SeatTicket,
  StoredCommanderArtifact,
  StoredPolicyArtifact,
  TraceSource,
  DecisionUsage,
  MatchLogFacts,
  SeatKind,
  UsageEvent,
} from './types.ts';
import { PlayerThreeError, newToken, snapshot, TokenBucket } from './util.ts';

const MAX_VERSIONS = 10;
const AGENT_LIVENESS_MS = 30_000;
/** While paused: how often presence, max pause and waits' wall-clock deadlines are re-checked. */
const PAUSE_POLL_MS = 250;
const MAX_WAITERS_PER_PRINCIPAL = 4;
const MAX_WAIT_EVENTS = 100;
/** Inbound protocol messages per principal (on top of the intent bucket). */
const MSG_PER_SECOND = 20;
const MSG_BURST = 40;
/** Unread owner messages kept per seat (oldest dropped). */
export const MAX_INBOX = 20;
/** Owner messages per team owner, and agent replies per seat: tokens per second / burst. */
export const TELL_RATE = { perSecond: 1, burst: 5 } as const;
export const SAY_RATE = { perSecond: 0.5, burst: 3 } as const;

/** Distribute `Omit` over the trace union so each variant keeps its own fields. */
type TraceInput = PlayerThreeTraceEvent extends infer E ? (E extends PlayerThreeTraceEvent ? Omit<E, 'at' | 'match' | 'tick'> : never) : never;

/**
 * A seat set up from a commander roster: the registry's side of the link. Settings and library state are
 * snapshots taken when the match was created.
 */
export interface CommanderLink {
  readonly settings: CommanderSettings;
  readonly active: number | null;
  readonly needsRoleDeploy: boolean;
  readonly nextVersion: number;
  /** Atomically reserve an artifact version across this named commander's simultaneous role lanes. */
  reserveVersion(): number;
  /** Library versions with their artifacts, oldest first. */
  library(): Promise<{ version: number; artifact: StoredCommanderArtifact }[]>;
  /** The commander's agent is connected (recent call or blocked in a wait). */
  connected(): boolean;
  /** A new version was deployed into the seat. */
  deployed(version: number, artifact: StoredCommanderArtifact, probe: PolicyStats): void;
  /** `policyExport` against the lane's commander library (spec §13.1). */
  exportPage(request: unknown): Promise<PolicyExportPage>;
  /** `policyImport` into the lane's commander library: a new, inactive version (spec §13.1). */
  importPackage(pkg: unknown): Promise<{ result: PolicyImportResult; artifact: StoredCommanderArtifact }>;
  /** An existing version was rolled back to. */
  activated(version: number, probe: PolicyStats): void;
  /** The seat's team outcome was decided (the team is out, or the match is over). */
  ended(outcome: Outcome): void;
  /** `interrupted`: execution stopped without an outcome; otherwise the seat was revoked/reassigned. */
  released(interrupted?: boolean): void;
  /** Lobby messages not read yet; they move into the seat's inbox. */
  takeInbox(): OwnerMessage[];
  /** The team owner messaged roles of this roster in the match (chat log). */
  told(roles: string[], message: OwnerMessage): void;
  /** The commander's agent replied in the match (chat log). */
  said(said: Said): void;
  approval(): PendingApproval | undefined;
  approvalChanged(pending: PendingApproval): void;
  /** A non-consuming seat status changed (including owner-message delivery). */
  statusChanged(): void;
  /** The agent marked this seat ready while its lane's lobby reservation named it (carried in at seating). */
  readonly ready: boolean;
  /** The agent marked this seat ready in the held match: the lane's matching reservation keeps it. */
  readied(): void;
}

/** What a match needs from its host. */
export interface MatchHost<M extends AnyManifest> {
  readonly definition: GameDefinition<M>;
  readonly pool: Pool;
  tracing(): boolean;
  emit(event: PlayerThreeTraceEvent): void;
  registerToken(token: string, matchId: string, principal: Principal, expiresAt?: number): void;
  /** Move a claimed, connected credential's expiry to `expiresAt`; false when it is gone, expired or not in use. */
  extendToken(token: string, expiresAt: number): boolean;
  revokeToken(token: string): void;
  revokeMatch(matchId: string, keepObservers?: boolean): void;
  principalAccess(principal: Principal): { key: string; valid(): boolean } | undefined;
  /** Running practice count per principal key (shared across matches). */
  readonly practices: Map<string, number>;
  /** Host default match options (validated); per-request practice options deep-merge over them. */
  readonly matchOptions: Record<string, unknown> | undefined;
  /** Host default match teams (validated). */
  readonly teams: readonly string[];
  /**
   * Prepare a named commander for a seat of this live match (`PlayerThreeMatch.assign`): the createMatch roster checks, and
   * `crossTeam` (the owner's agent commanders sit on another team) requires independent sessions. `bind()` routes
   * the commander's lane to the seat once the match installed it.
   */
  prepareCommander(match: Match<M>, assignment: SeatAssignment, crossTeam: boolean): { link: CommanderLink; bind(): void };
  /** The match is over, or released without an outcome: write its commander log entries (once). */
  logMatch(match: Match<M>, logged: LoggedMatch): void;
  /** A seat was re-assigned to a trusted owner (the session record's ownership index follows it). */
  assigned(match: Match<M>, team: string, role: string, owner: string): void;
  disposed(match: Match<M>): void;
}

/** Rights a control plane acts with. `key` identifies the principal for per-principal limits. */
interface Rights {
  kind: 'owner' | 'agent';
  key: string;
  commander?: boolean;
  valid?: () => boolean;
}

interface StreamSub {
  everyTicks: number;
  since: number;
  /** Observation sections pushed in full (resolved at subscription). */
  detail: readonly string[];
  listener: (obs: unknown) => void;
}

interface Waiter {
  st: SeatState;
  key: string;
  /** Agent waits drain the seat's owner messages and end early on a new one. */
  agent: boolean;
  /**
   * Started before the match's first tick (lobby phase): it ends at `wallUntil`, early wakes, or the start — then
   * with the match entry (the first observation).
   */
  lobby: boolean;
  start: number;
  until: number;
  /** Wall-clock deadline: while the session is paused or held (game time stands still) the wait ends at it. */
  wallUntil: number;
  timer?: ReturnType<typeof setTimeout>;
  kinds: Set<string> | null;
  resolve: (r: WaitResult) => void;
  reject: (error: PlayerThreeError) => void;
  valid?: () => boolean;
}

export interface PendingApproval {
  approval: Approval;
  action:
    | { kind: 'policyDeploy'; artifact: PolicySource }
    | { kind: 'policyRollback'; version: number }
    | { kind: 'publish'; version: number };
}


/** One seat's commander-log facts, accumulated by the host while the match runs (SPEC §20.10.1). */
interface SeatLog {
  /** Controller intervals, exactly as the replay's `seat` entries record them; the last one is open. */
  control: { fromTick: number; controller: Controller }[];
  /** Named commanders that held this seat, with their tenure; the last one may be open. */
  occupants: { link: CommanderLink; fromTick: number; toTick: number | null }[];
  ownerIntents: number;
  ownerTells: number;
  fallbackTicks: number;
  absentPolicyTicks: number;
  acceptedIntents: number;
  pausedMs: number;
  pausedSince: number | undefined;
  switches: { tick: number; version: number }[];
  usage: CommanderLogUsage | undefined;
  /** Hashes of the bot packages that played this seat (spec §11 *Bot packages*), in first-seated order. */
  botPackages: string[];
}

export interface LoggedSeat {
  team: string;
  role: string;
  kind: SeatKind;
  owner: string | undefined;
  /** `left`: replaced or revoked before the log was written (its outcome is not the commander's). */
  occupants: { link: CommanderLink; fromTick: number; toTick: number; left: boolean }[];
  control: { fromTick: number; toTick: number; controller: Controller }[];
  ownerIntents: number;
  ownerTells: number;
  fallbackTicks: number;
  absentPolicyTicks: number;
  acceptedIntents: number;
  pausedMs: number;
  switches: { tick: number; version: number }[];
  policyVersion?: number;
  poolPolicy?: string;
  botLevel?: string;
  botOptions?: Record<string, number | boolean>;
  /** Hashes of the bot packages that played the seat (as `bot` or as an agent's fallback), when any did. */
  botPackages?: string[];
  usage?: CommanderLogUsage;
}

/** What the host knows about a match when it writes its commander log entries. */
export interface LoggedMatch {
  id: string;
  seed: number;
  ticks: number;
  tickRate: number;
  teams: readonly string[];
  alliances: Readonly<Record<string, readonly string[]>> | undefined;
  /** Final outcomes (`running` for a team still in play when the match was released). */
  outcomes: Record<string, Outcome>;
  ranks: Record<string, number> | null;
  over: boolean;
  /** Teams that forfeited, and whether the game called it an abandon. */
  forfeited: ReadonlyMap<string, 'forfeit' | 'abandoned'>;
  /** `end()` declared the outcome (not the game). */
  declared: boolean;
  selfPlay: boolean;
  startedAt: number;
  endedAt: number;
  facts: MatchLogFacts | undefined;
  seats: LoggedSeat[];
  /** SHA-256 hex of the canonical replay JSON. */
  replayDigest: string;
}

/** A persistent session's kept checkpoint: isolated adapter clone after the step to `tick`; `entryIndex` is absolute. */
interface Checkpoint {
  tick: number;
  entryIndex: number;
  adapter: LooseAdapter;
  signals?: SignalBoard;
}

interface SeatState {
  seat: SeatKey;
  controller: Controller;
  assignment?: SeatAssignment;
  /** Frozen role-authorized observation at elimination/end; never follows the surviving teams. */
  terminal?: { tick: number; observation: unknown };
  /** Human control granted by assignment/history or explicitly by the game; delegation preserves it, revocation ends it. */
  humanHeld: boolean;
  humanReady: boolean;
  humanConnected: boolean;
  botOptions?: Record<string, number | boolean>;
  humanTokens: Set<string>;
  mandate: Mandate;
  scopes: Scope[];
  pending?: PendingApproval;
  resolvingApproval?: boolean;
  approvalUnread: boolean;
  sequence?: { id: string; key: string; valid?: () => boolean; steps: { tick: number; intents: unknown[] }[]; cancelOn: Set<string>; since: number; agent: boolean };
  calls: number;
  /** The seat's agent marked itself ready for the pre-match seat (`ready`); reset when the occupant changes. */
  agentReady: boolean;
  /**
   * Increments whenever `assign` replaces the occupant: control planes made for an earlier occupant stop working
   * (`bad_token`) and their late calls no longer count as this seat's presence.
   */
  occupancy: number;
  /** Presence and fallback are sampled once at think start, never between policy awaits. */
  activeAtThink: boolean;
  policyAtThink: boolean;
  fallbackAtThink: boolean;
  /** Set while this seat holds a pausable session still. */
  pause?: SeatPause;
  /** Max pause ran out: falls back like `whenAbsent: 'policy'` until its agent is present or the owner changes the seat. */
  pauseExpired: boolean;
  /** Built-in bot or bot package (`createSeatBot`) playing the seat as `bot` or as the agent's fallback. */
  bot?: SeatBot;
  botSince: number;
  /** Deployed policy versions (newest last, ≤ MAX_VERSIONS), with the starter each was deployed from. */
  history: ({ version: number; artifact: StoredPolicyArtifact } & Partial<StarterRef>)[];
  nextVersion: number;
  run?: PolicyRun;
  policySince: number;
  /** The seat's deploys and rollbacks, one at a time in arrival order. */
  deploys: DeployQueue;
  policyReadiness?: 'stale_policy' | 'policy_failed';
  /** Increment when a controller/assignment changes, to fence asynchronous activation. */
  activationGeneration: number;
  /** Drafted pool policy while controller === 'policy'. */
  pool?: { entry: PoolEntry; run?: PolicyRun; loading?: Promise<void> };
  lastAgentAt: number;
  ownerBucket: TokenBucket;
  agentBucket: TokenBucket;
  streams: Set<StreamSub>;
  /** Stream-mode intent budget: count for `streamTick`. */
  streamTick: number;
  streamCount: number;
  seatTokens: Set<string>;
  /** Set up from a commander roster. */
  commander?: CommanderLink;
  /** Commander library load (versions + active policy); awaited before the first think and before deploys. */
  libLoading?: Promise<void>;
  /** Per-seat bot level (commander fallback level); else the team's. */
  botLevel?: string;
  /** The game's exact-seat bot level (`botSeats`), restored when an occupant leaves. */
  seatBotLevel?: string;
  /** Unread owner messages (chat mode). Never recorded in replays, never shown to policies. */
  inbox: OwnerMessage[];
  sayBucket: TokenBucket;
  /** Signal board version of this seat its agent last saw (observe or wait); a newer one wakes its waits. */
  signalsSeen: number;
  log: SeatLog;
}

export class Match<M extends AnyManifest> implements PlayerThreeMatch<M> {
  readonly id = randomUUID();
  readonly tokens: MatchTokens;
  readonly seed: number;
  /** Policy sandbox PRNG seed: one-way from the secret match seed, so guest Math.random output cannot reveal it. */
  private readonly policySeed: number;
  readonly options: MatchOptionsOf<M> | undefined;
  private readonly host: MatchHost<M>;
  private readonly m: M;
  private readonly adapter: LooseAdapter;
  private readonly def: LooseDefinition;
  private readonly guard: OutboundGuard;
  private readonly sim: Sim;
  private readonly schema: UnionS;
  /** Team signal boards (games declaring signals). Turned over right after each step, like the simulation. */
  private readonly signals: SignalBoard | undefined;
  /** Match teams in manifest order (frozen) and the validated sides they belong to. */
  private readonly teamList: readonly string[];
  private readonly sides: Sides;
  private readonly roles: readonly string[];
  private readonly seatsState: SeatState[];
  private readonly botLevel: Record<string, string>;
  private readonly period: number;
  private readonly viewPeriod: number;
  private readonly entries: ReplayEntry[] = [];
  /** Persistent sessions' retention: rolling checkpoint window (absolute entry indices count `dropped`). */
  private readonly retention: { checkpointTicks: number; checkpoints: number } | undefined;
  private readonly checkpoints: Checkpoint[] = [];
  private dropped = 0;
  private windowFrom = 0;
  /** Each match team's view stream, created on first subscription (computed only while it has subscribers). */
  private readonly viewStreams = new Map<string, ViewStream>();
  /** A view tick passed in the current step batch; its streams are pushed on the batch's last tick. */
  private viewDue = false;
  private readonly endListeners = new Set<(outcomes: Record<string, Outcome>, ranks: Record<string, number>) => void>();
  private readonly saidListeners = new Set<(team: TeamOf<M>, said: Said) => void>();
  private readonly statusListeners = new Set<(team: string, role: string) => void>();
  private readonly readinessListeners = new Set<(team: string, role: string) => void>();
  private readonly tickListeners = new Set<(tick: number) => void>();
  private readonly observerPolicy: ObserverPolicy | undefined;
  private readonly observers: ObserverStream | undefined;
  private readonly broaderOwners = new Set<string>();
  private readonly metricRecorder: GameMetricRecorder | undefined;
  private readonly historicalPlayers = new Map<string, Set<string>>();
  /** `sameOwnerOpposed`: never cleared, so a later hand-over cannot launder an owner's self-play into a result. */
  private opposedOwners = false;
  private readonly usageListeners = new Set<(event: UsageEvent) => void>();
  private readonly commentaryListeners = new Set<(event: CommentaryEvent) => void>();
  private readonly usageSeen = new Map<string, Set<string>>();
  private readonly usageBuckets = new Map<string, TokenBucket>();
  private lastObserverCaptureAt = 0;
  /** Wall time of the last frame that refreshed every observer perspective (the 1 Hz floor). */
  private lastObserverFullAt = 0;
  /** Perspectives refreshed this frame; reused across ticks. */
  private readonly observerRefresh: string[] = [];
  /** Each team's guarded incremental view for the tick it was computed (shared by players and observers). */
  private readonly tickViews = new Map<string, { tick: number; view: Record<string, unknown> }>();
  /** Static snapshot-only members of each team's view (the bootstrap), taken once for view streams and observer frames. */
  private readonly viewBootstrap = new Map<string, Record<string, unknown>>();
  private finalMetrics: GameMetrics | undefined;
  private readonly tellBuckets = new Map<string, TokenBucket>();
  private readonly waiters = new Set<Waiter>();
  private readonly msgBuckets = new Map<string, TokenBucket>();
  private readonly pushSubs = new Map<(msg: ServerMsg) => void, Map<string, () => void>>();
  private readonly skills: SkillDef[];
  private readonly starters: StarterCatalog;
  private readonly briefings = new Map<string, Briefing>();
  private readonly argSchemas;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private ended = false;
  /** Kept final outcome per team: the first the game reported, or declared by `end()`. Never changes once set. */
  private readonly finals = new Map<string, FinalOutcome>();
  /** Teams that forfeited (`forfeit()`); recorded once, even before the game reports them final. */
  private readonly forfeited = new Set<string>();
  /** Teams whose seats were retired (terminal handling done). */
  private readonly retired = new Set<string>();
  /** Final placements, set when the match is over. */
  private ranks: Record<string, number> | undefined;
  private isDisposed = false;
  private readonly realtime: boolean;
  private executionReleased = false;
  private halted = false;
  private bindingRelease: Promise<void> | undefined;
  private hold: { pending: boolean; deadline: number; seats: SeatState[]; timer?: ReturnType<typeof setInterval> } | undefined;
  private manualStart = false;
  /** A tick is executing (between its first think and its step): pause is decided only outside. */
  private ticking = false;
  /** Set while any seat holds the session paused. */
  private pausedAt: { tick: number; since: number; timer: ReturnType<typeof setInterval> } | undefined;
  /** The game's guarded pre-match summary (manifest.lobby) shown in held seats' lobby state. */
  private readonly lobbyInfo: unknown;
  /** The game's description of when a held match starts (`setLobbyStart`); undefined: derived from the hold. */
  private lobbyStartAt: { kind: 'host' | 'ready' | 'countdown'; at?: number } | undefined;
  /** Commander log facts from createMatch, the creation time, and whether this match wrote its entries. */
  private readonly logFacts: MatchLogFacts | undefined;
  private readonly createdAt = Date.now();
  private logged = false;
  private declaredEnd = false;
  private readonly abandoned = new Set<string>();

  constructor(
    host: MatchHost<M>,
    opts: CreateMatchOptions<M>,
    seed: number,
    options: Record<string, unknown> | undefined,
    sides: Sides,
    commanders?: ReadonlyMap<string, CommanderLink>,
  ) {
    this.host = host;
    this.def = looseDefinition(host.definition);
    this.m = this.def.manifest as M;
    this.seed = seed;
    this.policySeed = createHash('sha256').update(`playerthree/policy:${seed}`).digest().readUIntBE(0, 6);
    this.options = options as MatchOptionsOf<M> | undefined;
    this.observerPolicy = opts.observerPolicy ? structuredClone(opts.observerPolicy) : undefined;
    const observerPolicy = this.observerPolicy;
    if (observerPolicy && (typeof observerPolicy.allowOmniscient !== 'boolean' || typeof observerPolicy.public !== 'boolean' ||
      !Number.isSafeInteger(observerPolicy.minDelayMs) || observerPolicy.minDelayMs < (observerPolicy.public ? 180_000 : 0) ||
      Object.keys(observerPolicy).some((key) => !['allowOmniscient', 'public', 'minDelayMs', 'maxBytes', 'maxAgeMs'].includes(key)) ||
      observerPolicy.maxBytes !== undefined && (!Number.isSafeInteger(observerPolicy.maxBytes) || observerPolicy.maxBytes < 1) ||
      observerPolicy.maxAgeMs !== undefined && (!Number.isSafeInteger(observerPolicy.maxAgeMs) || observerPolicy.maxAgeMs <= observerPolicy.minDelayMs))) throw new PlayerThreeError('invalid');
    const persistent = opts.persistent;
    if (persistent !== undefined) {
      const keys = persistent !== null && typeof persistent === 'object' ? Object.keys(persistent) : [];
      if (keys.length !== 2 || !keys.includes('checkpointTicks') || !keys.includes('checkpoints') ||
        !validateUnknown(t.int(1, LIMITS.maxTick), persistent.checkpointTicks).ok || !validateUnknown(t.int(2, 100), persistent.checkpoints).ok) {
        throw new PlayerThreeError('invalid');
      }
      this.retention = { checkpointTicks: persistent.checkpointTicks, checkpoints: persistent.checkpoints };
    }
    this.teamList = Object.freeze([...sides.teams]);
    this.sides = sides.alliances
      ? { teams: this.teamList, alliances: Object.freeze(Object.fromEntries(Object.entries(sides.alliances).map(([id, members]) => [id, Object.freeze([...members])]))) }
      : { teams: this.teamList };
    this.roles = (this.m.roles as EnumS).values;
    const known = (keys: Record<string, unknown> | undefined, valid: readonly string[]): boolean =>
      keys === undefined || (keys !== null && typeof keys === 'object' && Object.keys(keys).every((key) => valid.includes(key)));
    if (!known(opts.botLevel, this.teamList) || !known(opts.controllers, this.teamList) ||
      Object.values(opts.controllers ?? {}).some((roles) => !known(roles, this.roles))) throw new PlayerThreeError('invalid');
    this.adapter = this.def.create({ seed, ...(options === undefined ? {} : { options }), ...this.sides });
    if (this.m.matchData && typeof this.adapter.matchData !== 'function') throw new PlayerThreeError('internal');
    this.signals = this.m.signals ? new SignalBoard(this.m, this.teamList, SignalBoard.limitsFor(this.m, this.adapter)) : undefined;
    if (opts.metricSampleEveryTicks !== undefined && (!Number.isSafeInteger(opts.metricSampleEveryTicks) ||
      opts.metricSampleEveryTicks < 1 || opts.metricSampleEveryTicks > 2 ** 31 - 1)) throw new PlayerThreeError('invalid');
    this.metricRecorder = this.def.metrics?.(this.adapter, opts.metricSampleEveryTicks === undefined ? undefined : { sampleEveryTicks: opts.metricSampleEveryTicks });
    if (this.retention && typeof this.adapter.clone !== 'function') throw new Error('playerthree/host: persistent sessions need adapter clone()');
    this.guard = createGuard({
      // Every channel this match passes data through is a GuardChannel literal.
      onDrop: (d) => this.trace({ type: 'guard_drop', channel: d.channel as GuardChannel, code: d.code, path: d.path }),
    });
    this.sim = { manifest: this.m, adapter: this.adapter, guard: this.guard, record: (e) => this.entries.push(e) };
    if (opts.lobby !== undefined) {
      if (!this.m.lobby) throw new PlayerThreeError('invalid');
      const lobby = this.guard.pass('lobby', this.m.lobby, opts.lobby);
      if (!lobby.ok) throw new PlayerThreeError('invalid');
      this.lobbyInfo = lobby.value;
    }
    this.logFacts = opts.log === undefined ? undefined : parseLogFacts(opts.log);
    this.schema = intentSchema(this.m);
    this.period = thinkPeriod(this.m);
    this.viewPeriod = Math.max(1, Math.round(this.m.tickRate / (opts.viewHz ?? this.m.tickRate)));
    this.skills = servedSkills(this.m);
    this.starters = starterCatalog(this.m);
    const opponents = (this.m.opponents as EnumS).values;
    const defaultLevel = opponents[Math.max(0, opponents.length - 2)] as string;
    this.botLevel = Object.fromEntries(this.teamList.map((team) => [team, (opts.botLevel?.[team] as string | undefined) ?? defaultLevel]));
    for (const level of Object.values(this.botLevel)) if (!opponents.includes(level)) throw new Error('playerthree/host: unknown botLevel');
    const eventKinds = ((this.m.event as ObjS).fields.kind as EnumS).values as [string, ...string[]];
    this.argSchemas = {
      since: t.int(0, LIMITS.maxTick),
      wait: t.obj({ seconds: t.num(0, LIMITS.maxWaitSeconds), until: t.opt(t.list(t.enum(eventKinds), LIMITS.maxUntilKinds)) }),
      version: t.int(1, LIMITS.maxVersion),
    };
    const mandate = defaultMandate(this.m);
    const { perSecond, burst } = this.m.control.intents;
    this.seatsState = this.teamList.flatMap((team) =>
      this.roles.map((role): SeatState => ({
        seat: { team, role },
        controller: 'bot',
        humanReady: false,
        humanHeld: false,
        humanConnected: false,
        humanTokens: new Set(),
        mandate: structuredClone(mandate),
        scopes: defaultScopes(this.m),
        calls: 0,
        agentReady: false,
        occupancy: 0,
        approvalUnread: false,
        activeAtThink: false,
        fallbackAtThink: false,
        policyAtThink: false,
        pauseExpired: false,
        botSince: 0,
        history: [],
        nextVersion: 1,
        policySince: 0,
        deploys: new DeployQueue(),
        activationGeneration: 0,
        lastAgentAt: 0,
        ownerBucket: new TokenBucket(perSecond, burst),
        agentBucket: new TokenBucket(perSecond, burst),
        streams: new Set(),
        streamTick: -1,
        streamCount: 0,
        seatTokens: new Set(),
        inbox: [],
        sayBucket: new TokenBucket(SAY_RATE.perSecond, SAY_RATE.burst),
        signalsSeen: 0,
        log: { control: [], occupants: [], ownerIntents: 0, ownerTells: 0, fallbackTicks: 0, absentPolicyTicks: 0, acceptedIntents: 0, pausedMs: 0, pausedSince: undefined, switches: [], usage: undefined, botPackages: [] },
      })),
    );
    const botSeats = new Map<string, { level: string; options: Record<string, number | boolean> }>();
    for (const config of opts.botSeats ?? []) {
      if (!config || typeof config !== 'object' || Object.keys(config).some((key) => !['team', 'role', 'level', 'options'].includes(key))) throw new PlayerThreeError('invalid');
      const key = `${config.team}/${config.role}`;
      if (!this.teamList.includes(config.team) || !this.roles.includes(config.role) || !opponents.includes(config.level) ||
        botSeats.has(key) || config.options === null || typeof config.options !== 'object' || Array.isArray(config.options) ||
        Object.values(config.options).some((v) => typeof v !== 'boolean' && (typeof v !== 'number' || !Number.isFinite(v))) ||
        (this.def.botOptions ? !validateUnknown(this.def.botOptions, config.options).ok : Object.keys(config.options).length > 0)) throw new PlayerThreeError('invalid');
      botSeats.set(key, { level: config.level, options: structuredClone(config.options) });
    }
    for (const st of this.seatsState) {
      const botConfig = botSeats.get(`${st.seat.team}/${st.seat.role}`);
      if (botConfig) { st.botLevel = st.seatBotLevel = botConfig.level; st.botOptions = botConfig.options; }
      const assignment = opts.assignments?.find((a) => a.team === st.seat.team && a.role === st.seat.role);
      st.assignment = assignment ? { ...assignment } : undefined;
      if (assignment && (assignment.kind === 'human' || assignment.ownerControl === true)) {
        st.humanHeld = true;
        let teams = this.historicalPlayers.get(assignment.owner);
        if (!teams) this.historicalPlayers.set(assignment.owner, (teams = new Set()));
        teams.add(assignment.team);
      }
      const explicit = assignment?.kind ?? opts.controllers?.[st.seat.team]?.[st.seat.role];
      if (explicit !== undefined && !CONTROLLERS.includes(explicit)) throw new Error('playerthree/host: unknown controller');
      const link = commanders?.get(`${st.seat.team}/${st.seat.role}`);
      if (link) {
        this.initCommander(st, link, explicit, assignment?.policy && 'policyId' in assignment.policy ? assignment.policy.policyId : undefined, false);
        continue;
      }
      // `policy` drafts from the pool here (a fresh match has no deployed policy yet).
      this.applyController(st, explicit ?? 'bot', assignment?.policy && 'policyId' in assignment.policy ? assignment.policy.policyId : undefined, false);
    }
    this.noteOpposedOwners();
    this.realtime = opts.realtime !== false;
    const readySeats = this.seatsState.filter((st) => st.assignment !== undefined);
    if (opts.readySeconds !== undefined && readySeats.length > 0) {
      this.hold = { pending: true, deadline: Date.now() + opts.readySeconds * 1000, seats: readySeats };
      this.hold.timer = setInterval(() => this.checkReady(), 250);
      this.hold.timer.unref?.();
    }
    this.tokens = {
      teams: Object.fromEntries(this.teamList.map((team) => [team, newToken()])),
      spectator: newToken(),
    };
    for (const team of this.teamList) host.registerToken(this.tokens.teams[team] as string, this.id, { kind: 'team', match: this.id, team });
    host.registerToken(this.tokens.spectator, this.id, { kind: 'spectator', match: this.id });
    if (observerPolicy) {
      if (observerPolicy.allowOmniscient && (!this.m.observer || !this.adapter.observerView)) throw new PlayerThreeError('invalid');
      this.observers = new ObserverStream({
        teams: this.teamList,
        maxBytes: observerPolicy.maxBytes,
        maxAgeMs: observerRetentionMs(observerPolicy),
        projectTeam: (team) => this.teamView(team),
        projectAll: () => {
          // Without omniscient admission nobody can read `all`: never pay for (or retain) that projection.
          if (!observerPolicy.allowOmniscient || !this.m.observer || !this.adapter.observerView) return null;
          const raw = snapshot(this.adapter.observerView());
          const value = raw.ok ? validateUnknown(this.m.observer, raw.value) : raw;
          if (!value.ok) throw new PlayerThreeError('internal');
          return value.value;
        },
        outcomes: () => Object.fromEntries(this.teamList.map((team) => [team, this.outcomeOf(team)])),
      });
      this.observers.capture(this.tick);
      this.lastObserverCaptureAt = this.lastObserverFullAt = Date.now();
    }
    this.trace({ type: 'match_created', seats: this.seats() });
    if (this.realtime && !this.hold?.pending) this.start();
  }

  // ------------------------------------------------------------------ commander seats

  private initCommander(st: SeatState, link: CommanderLink, explicit: Controller | undefined, poolPolicy: string | undefined, push: boolean): void {
    st.commander = link;
    st.log.occupants.push({ link, fromTick: this.adapter.tick, toTick: null });
    st.agentReady = link.ready;
    st.inbox.push(...link.takeInbox());
    st.botLevel ??= link.settings.botLevel;
    st.mandate = structuredClone(link.settings.mandate);
    st.scopes = [...link.settings.scopes];
    st.pending = link.approval();
    this.applyController(st, explicit ?? 'agent', poolPolicy, push);
    if (this.m.control.policy) st.libLoading = this.loadLibrary(st, link);
  }

  private async loadLibrary(st: SeatState, link: CommanderLink): Promise<void> {
    const generation = st.activationGeneration;
    const previousRun = st.run;
    const previousReadiness = st.policyReadiness;
    try {
      const lib = await link.library();
      if (this.isDisposed || st.activationGeneration !== generation) return;
      st.history = lib.slice(-MAX_VERSIONS).map(({ version, artifact }) => ({ version, artifact, ...starterOf(artifact.source) }));
      st.nextVersion = Math.max(st.nextVersion, link.nextVersion);
      const active = lib.find((v) => v.version === link.active);
      if (active && !st.run && !st.pool) {
        const loaded = await this.preparePolicy(st, active.artifact, active.version, generation);
        if (loaded.ok) {
          st.run = loaded.run;
          st.policySince = this.adapter.tick;
          this.trace({ type: 'policy_deploy', team: st.seat.team, role: st.seat.role, ok: true, rollback: false, version: active.version });
        } else {
          this.trace({ type: 'policy_deploy', team: st.seat.team, role: st.seat.role, ok: false, rollback: false, error: loaded.error });
        }
      } else if (link.active !== null && !active && !st.pool) {
        st.policyReadiness = 'policy_failed';
      }
    } catch (e) {
      if (!this.isDisposed && st.activationGeneration === generation) st.policyReadiness = 'policy_failed';
      console.error('playerthree/host: commander library load failed');
    }
    if (!this.isDisposed && st.activationGeneration === generation &&
      (st.run !== previousRun || st.policyReadiness !== previousReadiness)) this.statusChanged(st);
    this.checkReady();
  }

  /** A commander's agent called into its seat: re-check readiness and pause without changing ownership. */
  commanderCall(team: string, role: string): void {
    this.checkReady();
    this.updatePause();
  }

  /** True once the match's outcome is decided. */
  get over(): boolean {
    return this.ended;
  }

  get persistent(): boolean {
    return this.retention !== undefined;
  }

  readyCheck(): ReadyCheck | undefined {
    const h = this.hold;
    if (!h) return undefined;
    return {
      pending: this.manualStart || h.pending,
      deadline: h.deadline,
      seats: h.seats.map((st) => ({ team: st.seat.team, role: st.seat.role, ready: this.readinessState(st) === 'ready' })),
    };
  }

  private checkReady(): void {
    const h = this.hold;
    if (!h?.pending) return;
    if (this.manualStart) return;
    // An AI deadline cannot admit an absent human. The game must end/cancel or explicitly override.
    if (h.seats.some((st) => st.assignment?.kind === 'human' && (!st.humanReady || !st.humanConnected))) return;
    if (Date.now() >= h.deadline || h.seats.every((st) => this.readinessState(st) === 'ready')) this.skipReadyCheck();
  }

  private endHold(): void {
    this.manualStart = false;
    if (!this.hold?.pending) return;
    this.hold.pending = false;
    clearInterval(this.hold.timer);
    this.hold.timer = undefined;
  }

  private fallbackUnreadyPolicies(): void {
    for (const st of this.seatsState) {
      if ((st.assignment?.kind ?? st.controller) === 'policy' && this.readinessState(st) !== 'ready') {
        this.applyController(st, 'bot', undefined, true);
      }
    }
  }

  holdStart(): void {
    this.live();
    if (this.tick !== 0 || this.ended || this.ticking || this.busy) throw new PlayerThreeError('invalid');
    this.stop();
    this.manualStart = true;
    if (!this.hold) this.hold = { pending: true, deadline: Date.now() + 600_000, seats: this.seatsState.filter((st) => st.assignment !== undefined) };
    else this.hold.pending = true;
    clearInterval(this.hold.timer);
    this.hold.timer = undefined;
  }

  skipReadyCheck(): void {
    this.manualStart = false;
    if (!this.hold?.pending) return;
    this.fallbackUnreadyPolicies();
    this.endHold();
    this.enterMatch();
    if (this.realtime) this.start();
  }

  // ------------------------------------------------------------------ lobby phase

  /** Held before the first tick (ready check, or the game's manual preparation/countdown gate). */
  private prematch(): boolean {
    return !this.ended && !this.halted && !this.isDisposed && (this.manualStart || this.hold?.pending === true);
  }

  /** The match left its hold: lobby-phase waits return the match entry now. */
  private enterMatch(): void {
    for (const w of [...this.waiters]) if (w.lobby) this.checkWaiter(w);
  }

  setLobbyStart(start: { kind: 'host' | 'ready' | 'countdown'; at?: number } | undefined): void {
    this.live();
    if (start !== undefined && (start === null || typeof start !== 'object' || !['host', 'ready', 'countdown'].includes(start.kind) ||
      Object.keys(start).some((key) => key !== 'kind' && key !== 'at') ||
      start.at !== undefined && (typeof start.at !== 'number' || !Number.isFinite(start.at)))) throw new PlayerThreeError('invalid');
    this.lobbyStartAt = start === undefined ? undefined : { kind: start.kind, ...(start.at !== undefined ? { at: start.at } : {}) };
  }

  private lobbyStart(): LobbyStart {
    const start = this.lobbyStartAt ?? (this.manualStart || !this.hold ? { kind: 'host' as const } : { kind: 'ready' as const, at: this.hold.deadline });
    return start.at === undefined ? { kind: start.kind } : { kind: start.kind, inSeconds: Math.max(0, Math.ceil((start.at - Date.now()) / 1000)) };
  }

  /** A held seat's pre-match state, as its agent sees it. */
  private lobbyState(st: SeatState): LobbyState {
    return {
      phase: 'lobby',
      seat: { ...st.seat },
      ...(this.lobbyInfo !== undefined ? { match: structuredClone(this.lobbyInfo) } : {}),
      you: { ready: st.agentReady },
      startsWhen: this.lobbyStart(),
      instruction: st.agentReady ? LOBBY_INSTRUCTIONS.ready : LOBBY_INSTRUCTIONS.seated,
    };
  }

  /** Whether this seat's agent is marked ready (commander routing: a newly seated, unready agent learns its seat at once). */
  agentReady(team: string, role: string): boolean {
    return this.state(team, role).agentReady;
  }

  /** The phase a seat's agent is in: `lobby` while the match is held before its first tick. */
  phase(): SessionPhase {
    return this.prematch() ? 'lobby' : 'match';
  }

  // ------------------------------------------------------------------ basics

  get tick(): number {
    return this.adapter.tick;
  }

  debugView(): unknown {
    return this.adapter.debugView?.() ?? null;
  }

  private validateObserverGrant(grant: ObserverGrant): void {
    const policy = this.observerPolicy;
    if (!policy || !grant || !Number.isSafeInteger(grant.delayMs) || grant.delayMs < policy.minDelayMs ||
      grant.delayMs >= observerRetentionMs(policy) ||
      grant.kind !== 'team' && grant.kind !== 'omniscient') throw new PlayerThreeError('forbidden');
    if (grant.kind === 'team') {
      if (!this.teamList.includes(grant.team) || Object.keys(grant).some((k) => !['kind', 'team', 'delayMs'].includes(k))) throw new PlayerThreeError('invalid');
    } else if (!policy.allowOmniscient || !Array.isArray(grant.teams) || grant.teams.length !== this.teamList.length ||
      new Set(grant.teams).size !== this.teamList.length || grant.teams.some((t) => !this.teamList.includes(t)) ||
      Object.keys(grant).some((k) => !['kind', 'teams', 'delayMs'].includes(k))) throw new PlayerThreeError('forbidden');
  }

  mintObserverToken(grant: ObserverGrant, opts: { owner: string; ttlSeconds?: number }): SeatTicket {
    this.live();
    this.validateObserverGrant(grant);
    if (!opts || typeof opts.owner !== 'string' || !opts.owner || opts.owner.length > 128 ||
      Object.keys(opts).some((key) => !['owner', 'ttlSeconds'].includes(key))) throw new PlayerThreeError('invalid');
    const ttl = opts.ttlSeconds ?? 120;
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 86_400) throw new PlayerThreeError('invalid');
    const history = this.historicalPlayers.get(opts.owner);
    // A player keeps its own side's view until it can no longer influence play: every team it played is final and
    // none of them has an ally still running. A persistent session never decides teams, so that never happens there.
    if (history && history.size > 0 && !this.outOfPlay(history) &&
      (grant.kind === 'omniscient' || [...history].some((team) => team !== grant.team))) throw new PlayerThreeError('forbidden');
    if (grant.kind === 'omniscient') {
      this.broaderOwners.add(opts.owner);
      for (const st of this.seatsState) if (st.assignment?.owner === opts.owner) st.inbox.length = 0;
    }
    const token = newToken();
    const expiresAt = Date.now() + ttl * 1000;
    this.host.registerToken(token, this.id, { kind: 'observer', match: this.id, grant: structuredClone(grant) }, expiresAt);
    return { token, expiresAt };
  }

  /** Every team final and no alliance member of theirs still running. */
  private outOfPlay(teams: ReadonlySet<string>): boolean {
    const allies = Object.values(this.sides.alliances ?? {}).filter((members) => members.some((team) => teams.has(team)));
    return [...teams, ...allies.flat()].every((team) => this.finals.has(team));
  }

  observerMessages(principal: Principal, perspective: string, after?: number): ObserverMessage[] {
    if (principal.kind !== 'observer' || principal.match !== this.id || !this.host.principalAccess(principal)?.valid()) throw new PlayerThreeError('bad_token');
    this.validateObserverGrant(principal.grant);
    return this.observers!.read(principal.grant, perspective, after);
  }

  observerFrames(grant: ObserverGrant, after?: number): AsyncIterable<ObserverFrame> {
    this.validateObserverGrant(grant);
    return this.observers!.frames(grant, grant.kind === 'team' ? grant.team : 'all', after);
  }

  coachingAllowed(owner: string): boolean {
    return !this.broaderOwners.has(owner) &&
      new Set(this.seatsState.filter((st) => st.assignment?.owner === owner).map((st) => st.seat.team)).size <= 1;
  }

  onTick(listener: (tick: number) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  metrics(): GameMetrics {
    if (!this.ended && !this.halted && !this.isDisposed) throw new PlayerThreeError('invalid');
    this.finalMetrics ??= this.metricRecorder?.finish() ?? { match: {}, sides: {} };
    return structuredClone(this.finalMetrics);
  }

  metricRows(): Partial<ResultRows> {
    return this.metricRecorder?.rows?.(this.id) ?? {};
  }

  onUsage(listener: (event: UsageEvent) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  /** Trusted SDK routing supplies the seat; reports cannot select another seat or execution identity. */
  recordUsage(team: string, role: string, input: DecisionUsage): void {
    this.live();
    const st = this.state(team, role);
    if (this.finals.has(team)) throw new PlayerThreeError('forbidden');
    const report = parseDecisionUsage(input);
    const key = `${team}/${role}`;
    let seen = this.usageSeen.get(key);
    if (!seen) this.usageSeen.set(key, (seen = new Set()));
    if (seen.has(report.decisionId)) throw new PlayerThreeError('invalid');
    if (seen.size >= 4096) throw new PlayerThreeError('busy');
    let bucket = this.usageBuckets.get(key);
    if (!bucket) this.usageBuckets.set(key, (bucket = new TokenBucket(2, 8)));
    if (!bucket.take()) throw new PlayerThreeError('rate_limited');
    seen.add(report.decisionId);
    const u = st.log.usage ??= { decisions: 0, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, coverage: 'complete' };
    u.decisions++;
    const add = (total: number | null, value: number | null | undefined): number | null => value == null ? total : (total ?? 0) + value;
    u.inputTokens = add(u.inputTokens, report.inputTokens);
    u.outputTokens = add(u.outputTokens, report.outputTokens);
    u.cacheReadTokens = add(u.cacheReadTokens, report.cacheReadTokens);
    u.cacheWriteTokens = add(u.cacheWriteTokens, report.cacheWriteTokens);
    if (report.coverage === 'unknown' || report.coverage === 'partial' && u.coverage === 'complete') u.coverage = report.coverage;
    const event: UsageEvent = { match: this.id, team, role, tick: this.tick, receivedAt: Date.now(), report };
    for (const listener of this.usageListeners) {
      try { listener(structuredClone(event)); } catch { /* Telemetry cannot interrupt play. */ }
    }
  }

  onCommentary(listener: (event: CommentaryEvent) => void): () => void {
    this.commentaryListeners.add(listener);
    return () => this.commentaryListeners.delete(listener);
  }

  private trace(e: TraceInput): void {
    if (!this.host.tracing()) return;
    this.host.emit({ ...e, at: Date.now(), match: this.id, tick: this.adapter.tick } as PlayerThreeTraceEvent);
  }

  private state(team: unknown, role: unknown): SeatState {
    const st = this.seatsState.find((s) => s.seat.team === team && s.seat.role === role);
    if (!st) throw new PlayerThreeError('invalid');
    return st;
  }

  private live(): void {
    if (this.isDisposed || this.executionReleased || this.halted) throw new PlayerThreeError('forbidden');
  }

  outcome(team: TeamOf<M>): Outcome {
    return this.outcomeOf(this.teamKey(team));
  }

  private outcomeOf(team: string): Outcome {
    // A persistent session has no terminal outcome, whatever the adapter reports.
    if (this.retention) return 'running';
    return this.finals.get(team) ?? this.adapter.outcome(team);
  }

  rank(team: TeamOf<M>): number | null {
    return this.ranks?.[this.teamKey(team)] ?? null;
  }

  get teams(): readonly TeamOf<M>[] {
    return this.teamList as readonly TeamOf<M>[];
  }

  get alliances(): Readonly<Record<string, readonly TeamOf<M>[]>> | undefined {
    return this.sides.alliances as Readonly<Record<string, readonly TeamOf<M>[]>> | undefined;
  }

  get sameOwnerOpposed(): boolean {
    return this.opposedOwners;
  }

  /**
   * Played seats are the ones an owner directs (a human hold, an agent, a policy); bots and holds are not, so a game's
   * synthetic owner of every opponent bot never marks a match. Allies share a side.
   */
  private noteOpposedOwners(): void {
    if (this.opposedOwners) return;
    const sides = new Map<string, string>();
    for (const st of this.seatsState) {
      const a = st.assignment;
      if (!a || !(st.humanHeld || a.kind === 'agent' || a.kind === 'policy')) continue;
      const side = Object.entries(this.sides.alliances ?? {}).find(([, members]) => members.includes(st.seat.team))?.[0] ?? `team:${st.seat.team}`;
      const first = sides.get(a.owner);
      if (first === undefined) sides.set(a.owner, side);
      else if (first !== side) { this.opposedOwners = true; return; }
    }
  }

  end(outcomes: 'draw' | Readonly<Record<string, FinalOutcome>> | Readonly<Record<string, number>>): Record<string, Outcome> {
    this.live();
    if (this.retention) throw new PlayerThreeError('invalid');
    if (!this.ended) {
      let declared: { outcomes: Record<string, FinalOutcome>; ranks: Record<string, number> };
      if (outcomes === 'draw') {
        // Teams already out keep their outcome; everyone still playing draws.
        const drawn = Object.fromEntries(this.teamList.map((team): [string, FinalOutcome] => [team, this.finals.get(team) ?? 'draw']));
        declared = { outcomes: drawn, ranks: ranksByOutcome(this.sides, drawn) };
      } else {
        declared = parseEndOutcomes(this.sides, outcomes);
        // A kept final outcome never changes.
        for (const [team, kept] of this.finals) if (declared.outcomes[team] !== kept) throw new PlayerThreeError('invalid');
      }
      for (const team of this.teamList) this.finals.set(team, declared.outcomes[team]!);
      this.ranks = declared.ranks;
      this.declaredEnd = true;
      // The game adopts them first, so views and reports pushed from onEnd listeners already agree. A failing hook
      // does not keep the session running: the declared outcomes stand.
      try {
        this.adapter.end?.({ ...declared.outcomes }, { ...declared.ranks });
      } catch (e) {
        console.error('playerthree/host: adapter.end() failed; the declared outcomes stand');
      }
      this.endHold();
      this.checkEnd();
      // The adapter adopted the outcomes: a view shared earlier this tick predates them.
      this.tickViews.clear();
      this.observers?.capture(this.tick);
      for (const w of [...this.waiters]) this.checkWaiter(w);
    }
    return Object.fromEntries(this.teamList.map((team) => [team, this.outcomeOf(team)]));
  }

  forfeit(team: TeamOf<M>, opts?: { abandoned?: boolean }): void {
    this.live();
    const key = this.teamKey(team);
    const forfeit = this.adapter.forfeit?.bind(this.adapter);
    if (!forfeit || this.retention) throw new PlayerThreeError('invalid');
    if (this.ended || this.finals.has(key) || this.forfeited.has(key)) return;
    this.forfeited.add(key);
    if (opts?.abandoned === true) this.abandoned.add(key);
    // Recorded before the hook runs, like an intent before `apply`: replays re-apply it at this point among the inputs.
    this.entries.push([this.adapter.tick, key, this.roles[0]!, 'forfeit']);
    this.trace({ type: 'forfeit', team: key });
    forfeit(key);
    // A game that decides the team (or the whole match) at once has it retired now, not after the next step.
    this.checkEnd();
    this.tickViews.clear();
    this.observers?.capture(this.tick);
    this.updatePause();
    for (const w of [...this.waiters]) this.checkWaiter(w);
  }

  status(team: TeamOf<M>, role: RoleOf<M>): SeatStatus {
    const st = this.state(team, role);
    const paused = this.paused();
    return {
      phase: this.prematch() ? 'lobby' : 'match',
      team: st.seat.team,
      tick: st.terminal?.tick ?? this.adapter.tick,
      outcome: this.outcomeOf(st.seat.team),
      ...(st.pending ? { approval: { ...st.pending.approval } } : {}),
      unreadOwnerMessages: st.inbox.length,
      ...(paused ? { paused } : {}),
    };
  }

  onStatus(listener: (team: string, role: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Readiness/card changes (status changes plus agent arrivals, which the agent's own SeatStatus does not carry). */
  onReadiness(listener: (team: string, role: string) => void): () => void {
    this.readinessListeners.add(listener);
    return () => this.readinessListeners.delete(listener);
  }

  private statusChanged(st: SeatState): void {
    st.commander?.statusChanged();
    this.notify(this.statusListeners, st);
    this.readinessChanged(st);
  }

  private readinessChanged(st: SeatState): void {
    this.notify(this.readinessListeners, st);
  }

  private notify(listeners: ReadonlySet<(team: string, role: string) => void>, st: SeatState): void {
    for (const listener of listeners) {
      try {
        listener(st.seat.team, st.seat.role);
      } catch {
        // Status observers must not interrupt seat mutations.
      }
    }
  }

  private teamKey(team: unknown): string {
    if (typeof team !== 'string' || !this.teamList.includes(team)) throw new PlayerThreeError('invalid');
    return team;
  }

  seats(): SeatInfo[] {
    return this.seatsState.map((st) => ({
      team: st.seat.team,
      role: st.seat.role,
      controller: st.controller,
      mandate: structuredClone(st.mandate),
      scopes: [...st.scopes],
      ...(st.run ? { policyVersion: st.run.version } : {}),
      ...(st.pool ? { poolPolicy: st.pool.entry.id } : {}),
      agentActive: this.agentActive(st),
      ...(st.commander ? { commander: true } : {}),
      ...(st.pause ? { pause: { ...st.pause } } : {}),
    }));
  }

  private readinessState(st: SeatState): ReadinessState {
    const kind = st.assignment?.kind ?? st.controller;
    if (kind === 'human') return st.humanReady && st.humanConnected ? 'ready' : 'waiting';
    // Present agents are `online` until they mark the pre-match seat ready; once the match runs, presence suffices.
    if (kind === 'agent') return !this.agentActive(st) ? 'absent' : st.agentReady || !this.prematch() ? 'ready' : 'online';
    if (kind === 'policy') {
      if (st.policyReadiness) return st.policyReadiness;
      return (st.pool?.run ?? st.run)?.active ? 'ready' : 'waiting';
    }
    return 'ready';
  }

  readiness(): ReadinessSnapshot {
    return {
      mode: this.hold ? 'start' : 'none',
      pending: this.manualStart || (this.hold?.pending ?? false),
      ...(this.hold ? { deadline: this.hold.deadline } : {}),
      seats: this.seatsState.map((st) => ({ ...st.seat, kind: st.assignment?.kind ?? st.controller, state: this.readinessState(st) })),
    };
  }

  cards(): PublicSeatCard[] {
    const cards: PublicSeatCard[] = [];
    for (const st of this.seatsState) {
      const kind = st.assignment?.kind ?? st.controller;
      if (kind !== 'agent' && kind !== 'policy') continue;
      const active = this.agentActive(st);
      const run = st.pool?.run ?? st.run;
      const mode = this.hold?.pending ? 'held' : st.controller === 'bot' ? 'bot' :
        st.controller === 'agent' && active ? 'live' :
        run?.active && (st.controller === 'policy' || st.controller === 'agent' && st.mandate.whenAbsent === 'policy') ? 'policy' :
        st.controller === 'agent' && (st.mandate.whenAbsent === 'bot' || st.mandate.whenAbsent === 'policy') ? 'bot' : 'held';
      cards.push({
        seat: { ...st.seat }, kind, aiPlayer: true, mode,
        ...(kind === 'agent' ? { harness: { label: 'Unverified harness', verified: false } } : {}),
        ...(st.pool ? { policy: { source: 'pool', policyId: st.pool.entry.id } } :
          st.run ? { policy: { source: 'library', version: st.run.version } } : {}),
      });
    }
    return cards;
  }

  setHumanReady(team: TeamOf<M>, role: RoleOf<M>, ready: boolean): void {
    if (typeof ready !== 'boolean') throw new PlayerThreeError('invalid');
    if (ready) this.live();
    const st = this.state(team, role);
    st.humanReady = ready;
    if (this.isDisposed) return;
    this.statusChanged(st);
    this.checkReady();
  }

  humanJoined(team: TeamOf<M>, role: RoleOf<M>, joined: boolean): void {
    if (typeof joined !== 'boolean') throw new PlayerThreeError('invalid');
    if (joined) this.live();
    const st = this.state(team, role);
    st.humanConnected = joined;
    if (this.isDisposed) return;
    this.statusChanged(st);
    this.checkReady();
  }

  private pushSeatInfo(st: SeatState): void {
    const info = { controller: st.controller, mandate: structuredClone(st.mandate) };
    this.entries.push([this.adapter.tick, st.seat.team, st.seat.role, 'seat', info.controller, structuredClone(info.mandate)]);
    const last = st.log.control.at(-1);
    if (last?.fromTick === this.adapter.tick) last.controller = info.controller;
    else if (last?.controller !== info.controller) st.log.control.push({ fromTick: this.adapter.tick, controller: info.controller });
    this.adapter.setSeatInfo(st.seat, info);
  }

  // ------------------------------------------------------------------ owner operations

  setController(team: TeamOf<M>, role: RoleOf<M>, controller: Controller, opts?: { poolPolicy?: string }): void {
    this.live();
    if (!CONTROLLERS.includes(controller)) throw new PlayerThreeError('invalid');
    const st = this.state(team, role);
    if (controller === 'human' && st.assignment && this.broaderOwners.has(st.assignment.owner)) throw new PlayerThreeError('forbidden');
    this.applyController(st, controller, opts?.poolPolicy, true);
    if (st.assignment) st.assignment.kind = controller;
    if (controller === 'human' && st.assignment) {
      st.humanHeld = true;
      let teams = this.historicalPlayers.get(st.assignment.owner);
      if (!teams) this.historicalPlayers.set(st.assignment.owner, (teams = new Set()));
      teams.add(st.seat.team);
    }
    this.noteOpposedOwners();
    this.statusChanged(st);
    this.checkReady();
  }

  assign(input: SeatAssignment): void {
    this.live();
    if (this.ended || this.halted || this.executionReleased) throw new PlayerThreeError('invalid');
    const keys = input !== null && typeof input === 'object' ? Object.keys(input) : [];
    if (keys.some((key) => !['team', 'role', 'owner', 'kind', 'ownerControl', 'commander', 'policy'].includes(key))) throw new PlayerThreeError('invalid');
    const { team, role, owner, kind, ownerControl, commander, policy } = input;
    const st = this.state(team, role);
    if (this.finals.has(st.seat.team)) throw new PlayerThreeError('invalid');
    if (typeof owner !== 'string' || !owner || owner.length > 128 || !CONTROLLERS.includes(kind)) throw new PlayerThreeError('invalid');
    if (ownerControl !== undefined && typeof ownerControl !== 'boolean') throw new PlayerThreeError('invalid');
    if (commander !== undefined && (!['agent', 'policy'].includes(kind) || commander === null || typeof commander !== 'object' ||
      typeof commander.id !== 'string' || Object.keys(commander).length !== 1)) throw new PlayerThreeError('invalid');
    if (policy !== undefined && (kind !== 'policy' || policy === null || typeof policy !== 'object' || Object.keys(policy).length !== 1 ||
      !('policyId' in policy ? typeof policy.policyId === 'string' : 'version' in policy && commander !== undefined && Number.isSafeInteger(policy.version) && policy.version > 0))) throw new PlayerThreeError('invalid');
    if ((kind === 'human' || ownerControl === true) && this.broaderOwners.has(owner)) throw new PlayerThreeError('forbidden');
    const current = st.assignment;
    if (current && current.owner === owner && current.kind === kind && current.ownerControl === ownerControl && current.commander?.id === commander?.id &&
      JSON.stringify(current.policy) === JSON.stringify(policy) && st.controller === kind) return;
    const poolPolicy = policy && 'policyId' in policy ? policy.policyId : undefined;
    // Validate everything that can fail before the previous occupant is detached: the hand-over is atomic.
    if (kind === 'policy' && !commander) {
      if (!this.m.control.pool && !this.m.control.policy) throw new PlayerThreeError('mode_unavailable');
      const entry = poolPolicy === undefined ? undefined : this.host.pool.get(poolPolicy);
      if (poolPolicy !== undefined ? !entry || entry.role !== st.seat.role : !this.m.control.pool) throw new PlayerThreeError('invalid');
    }
    const prepared = commander
      ? this.host.prepareCommander(this, { team, role, owner, kind, commander: { id: commander.id }, ...(policy ? { policy } : {}) },
        kind === 'agent' && this.seatsState.some((other) => other !== st && other.seat.team !== st.seat.team &&
          other.assignment?.owner === owner && other.assignment.kind === 'agent' && other.assignment.commander !== undefined))
      : undefined;
    this.detach(st, kind === 'human' && current?.kind === 'human' && current.owner === owner);
    st.humanHeld = kind === 'human' || ownerControl === true || (current?.owner === owner && st.humanHeld);
    st.assignment = { team: st.seat.team, role: st.seat.role, owner, kind, ...(ownerControl === undefined ? {} : { ownerControl }), ...(commander ? { commander: { id: commander.id } } : {}), ...(policy ? { policy: structuredClone(policy) } : {}) };
    this.host.assigned(this, st.seat.team, st.seat.role, owner);
    if (st.humanHeld) {
      let teams = this.historicalPlayers.get(owner);
      if (!teams) this.historicalPlayers.set(owner, (teams = new Set()));
      teams.add(st.seat.team);
    }
    if (prepared) {
      this.initCommander(st, prepared.link, kind, poolPolicy, true);
      prepared.bind();
    } else {
      // The seat's own defaults: a departing commander's mandate and permissions do not carry over.
      st.mandate = defaultMandate(this.m);
      st.scopes = defaultScopes(this.m);
      this.applyController(st, kind, poolPolicy, true);
    }
    if (this.hold && !this.hold.seats.includes(st)) this.hold.seats.push(st);
    this.noteOpposedOwners();
    this.statusChanged(st);
    this.checkReady();
  }

  /**
   * The seat's occupant stops now, before another takes it: its commander lane returns to the lobby, its exact-seat
   * credentials (and human ones unless `keepHuman`) stop authenticating, its agent's waits return unseated, and its
   * plan, approval, inbox, presence and seat policies end. Earlier control planes stop working (`occupancy`).
   */
  private detach(st: SeatState, keepHuman: boolean): void {
    st.occupancy++;
    const occupant = st.log.occupants.at(-1);
    if (occupant && occupant.toTick === null) occupant.toTick = this.adapter.tick;
    const link = st.commander;
    st.commander = undefined;
    link?.released();
    for (const token of st.seatTokens) this.host.revokeToken(token);
    st.seatTokens.clear();
    if (!keepHuman) {
      for (const token of st.humanTokens) this.host.revokeToken(token);
      st.humanTokens.clear();
      st.humanConnected = false;
      st.humanReady = false;
    }
    for (const w of [...this.waiters]) {
      if (w.st !== st || !w.agent) continue;
      this.waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve({ phase: 'lobby', seat: null, you: { ready: false }, startsWhen: { kind: 'seat' }, instruction: LOBBY_INSTRUCTIONS.unseated });
    }
    st.sequence = undefined;
    st.pending = undefined;
    st.approvalUnread = false;
    st.inbox.length = 0;
    st.agentReady = false;
    st.calls = 0;
    st.lastAgentAt = 0;
    st.libLoading = undefined;
    st.run?.dispose();
    st.run = undefined;
    st.history = [];
    st.nextVersion = 1;
    st.policyReadiness = undefined;
    st.botLevel = st.seatBotLevel;
  }

  private applyController(st: SeatState, controller: Controller, poolPolicy: string | undefined, push: boolean): void {
    const previous = st.controller;
    let pool: SeatState['pool'];
    if (controller === 'policy') {
      if (!this.m.control.pool && !this.m.control.policy) throw new PlayerThreeError('mode_unavailable');
      let entry: PoolEntry | undefined;
      if (poolPolicy !== undefined) {
        entry = this.host.pool.get(poolPolicy);
        if (!entry || entry.role !== st.seat.role) throw new PlayerThreeError('invalid');
      } else if (!st.run && st.commander?.active == null && this.m.control.pool) {
        entry = this.host.pool.draft(st.seat.role);
      }
      // Without an explicit pool policy the seat's own deployed policy runs; else a drafted one.
      if (!entry && !st.run && st.commander?.active == null) throw new PlayerThreeError('invalid');
      if (entry) pool = { entry };
    }
    st.activationGeneration++;
    if (st.pool && st.pool !== pool) st.pool.run?.dispose();
    st.pool = pool;
    if (pool) pool.loading = this.loadPoolRun(st, pool);
    st.controller = controller;
    const bot = controller === 'bot' || controller === 'agent' ? createSeatBot(this.def, st.seat, st.botLevel ?? (this.botLevel[st.seat.team] as string), st.botOptions, this.policySeed) : undefined;
    st.bot?.dispose?.();
    st.bot = undefined;
    if (controller !== 'agent') st.sequence = undefined;
    st.botSince = this.adapter.tick;
    st.policySince = this.adapter.tick;
    this.pushSeatInfo(st);
    bot?.init?.(matchDataFor(this.sim, st.seat));
    if (bot) this.logBot(st, bot);
    st.bot = bot;
    if (push) this.trace({ type: 'controller', team: st.seat.team, role: st.seat.role, controller, previous, ...(pool ? { poolPolicy: pool.entry.id } : {}) });
    st.pauseExpired = false;
    if (push) this.updatePause();
  }

  private async loadPoolRun(st: SeatState, pool: NonNullable<SeatState['pool']>): Promise<void> {
    const generation = st.activationGeneration;
    const artifact = await this.host.pool.artifact(pool.entry.id);
    if (st.pool !== pool || this.isDisposed || st.activationGeneration !== generation) return;
    if (!artifact || !this.m.control.policy) {
      st.policyReadiness = 'policy_failed';
      this.statusChanged(st);
      this.checkReady();
      return;
    }
    if (pool.entry.surfaceHash !== surfaceHash(this.m)) {
      st.policyReadiness = 'stale_policy';
      this.statusChanged(st);
      this.checkReady();
      return;
    }
    const loaded = await this.preparePolicy(st, artifact, 0, generation);
    if (loaded.ok) pool.run = loaded.run;
    else this.trace({ type: 'policy_deploy', team: st.seat.team, role: st.seat.role, ok: false, rollback: false, error: loaded.error });
    if (!this.isDisposed && st.activationGeneration === generation) this.statusChanged(st);
    this.checkReady();
  }

  setMandate(team: TeamOf<M>, role: RoleOf<M>, mandate: MandateOf<M>): void {
    this.live();
    this.applyMandate(this.state(team, role), mandate);
  }

  setScopes(team: TeamOf<M>, role: RoleOf<M>, scopes: Scope[]): void {
    this.live();
    if (!Array.isArray(scopes) || !scopes.every((scope) => SCOPES.includes(scope))) throw new PlayerThreeError('invalid');
    const st = this.state(team, role);
    st.scopes = [...new Set(scopes)];
    if (st.sequence?.agent && !st.scopes.includes('act')) st.sequence = undefined;
  }

  private applyMandate(st: SeatState, mandate: unknown): void {
    st.mandate = parseMandate(this.m, mandate);
    this.pushSeatInfo(st);
    this.trace({ type: 'mandate', team: st.seat.team, role: st.seat.role, mandate: structuredClone(st.mandate) });
    st.pauseExpired = false;
    this.updatePause();
  }

  updateCommanderSettings(team: string, role: string, settings: CommanderSettings): void {
    const st = this.state(team, role);
    this.setScopes(team as TeamOf<M>, role as RoleOf<M>, settings.scopes);
    if (st.botLevel !== settings.botLevel) {
      st.botLevel = settings.botLevel;
      st.bot?.dispose?.();
      st.bot = undefined;
      const bot = createSeatBot(this.def, st.seat, st.botLevel, st.botOptions, this.policySeed);
      bot.init?.(matchDataFor(this.sim, st.seat));
      this.logBot(st, bot);
      st.bot = bot;
      st.botSince = this.adapter.tick;
    }
    this.applyMandate(st, settings.mandate);
  }

  /** Note the package a freshly seated bot plays (none for a built-in bot or a package that fell back at load). */
  private logBot(st: SeatState, bot: SeatBot): void {
    const hash = bot.packageHash;
    if (hash !== undefined && !st.log.botPackages.includes(hash)) st.log.botPackages.push(hash);
  }

  private agentActive(st: SeatState): boolean {
    return st.calls > 0 || st.sequence !== undefined || st.commander?.connected() === true ||
      (st.lastAgentAt > 0 && Date.now() - st.lastAgentAt < AGENT_LIVENESS_MS);
  }

  // ------------------------------------------------------------------ pause (control.pausable)

  /**
   * Decide pause at a tick boundary (never while a tick executes). A seat holds the session still while its
   * controller is `agent`, its mandate says `whenAbsent: 'pause'` and its agent is absent; it stops holding when the
   * agent is present again (`present`), the owner changes the seat (`owner`), or max pause runs out (`timeout`: it
   * then falls back like `policy` until its agent is present again or the owner changes the seat). Each change is a
   * replay entry and a trace event at the current tick.
   */
  private updatePause(): void {
    const pausable = this.m.control.pausable;
    if (!pausable || this.ticking || this.ended || this.isDisposed) return;
    const now = Date.now();
    const tick = this.adapter.tick;
    let changed = false;
    for (const st of this.seatsState) {
      const active = this.agentActive(st);
      if (active) st.pauseExpired = false;
      // A seat whose team is out stops holding the session (as when its owner changes the seat).
      const pausing = st.controller === 'agent' && st.mandate.whenAbsent === 'pause' && !this.finals.has(st.seat.team);
      const { team, role } = st.seat;
      if (st.pause) {
        const reason: ResumeReason | undefined = !pausing ? 'owner' : active ? 'present' : st.pause.until !== undefined && now >= st.pause.until ? 'timeout' : undefined;
        if (!reason) continue;
        if (reason === 'timeout') st.pauseExpired = true;
        st.pause = undefined;
        if (st.log.pausedSince !== undefined) st.log.pausedMs += now - st.log.pausedSince;
        st.log.pausedSince = undefined;
        this.entries.push([tick, team, role, 'resume', reason]);
        this.trace({ type: 'resume', team, role, reason });
        changed = true;
      } else if (pausing && !active && !st.pauseExpired) {
        const max = pausable.maxPauseSeconds;
        st.pause = { reason: 'agent_absent', tick, since: now, ...(max !== undefined ? { until: now + max * 1000 } : {}) };
        st.log.pausedSince = now;
        this.entries.push([tick, team, role, 'pause', 'agent_absent']);
        this.trace({ type: 'pause', team, role, reason: 'agent_absent' });
        changed = true;
      }
    }
    if (!changed) return;
    const holding = this.seatsState.some((st) => st.pause !== undefined);
    if (holding && !this.pausedAt) {
      const timer = setInterval(() => this.pollPause(), PAUSE_POLL_MS);
      timer.unref?.();
      this.pausedAt = { tick, since: now, timer };
    } else if (!holding) {
      this.stopPauseTimer();
    }
    for (const st of this.seatsState) this.statusChanged(st);
  }

  /** While paused: presence, max pause and the wall-clock deadlines of waits (game time stands still). */
  private pollPause(): void {
    this.updatePause();
    if (this.pausedAt) for (const w of [...this.waiters]) this.checkWaiter(w);
  }

  private stopPauseTimer(): void {
    if (!this.pausedAt) return;
    clearInterval(this.pausedAt.timer);
    this.pausedAt = undefined;
  }

  paused(): PauseInfo | undefined {
    if (!this.pausedAt) return undefined;
    return {
      tick: this.pausedAt.tick,
      since: this.pausedAt.since,
      seats: this.seatsState.flatMap((st) => (st.pause ? [{ team: st.seat.team, role: st.seat.role, ...st.pause }] : [])),
    };
  }

  mintSeatToken(team: TeamOf<M>, role: RoleOf<M>): string {
    this.live();
    return this.mint(this.state(team, role));
  }

  mintHumanToken(team: TeamOf<M>, role: RoleOf<M>, opts?: { ttlSeconds?: number }): SeatTicket {
    this.live();
    const st = this.humanHolder(team, role);
    const ticket = this.ticket({ kind: 'human', match: this.id, team: st.seat.team, role: st.seat.role }, opts);
    for (const old of st.humanTokens) this.host.revokeToken(old);
    st.humanTokens.clear();
    st.humanConnected = false;
    st.humanTokens.add(ticket.token);
    return ticket;
  }

  renewHumanToken(team: TeamOf<M>, role: RoleOf<M>, opts?: { ttlSeconds?: number }): { expiresAt: number } {
    this.live();
    const st = this.humanHolder(team, role);
    const expiresAt = Date.now() + ticketTtl(opts) * 1000;
    for (const token of st.humanTokens) if (this.host.extendToken(token, expiresAt)) return { expiresAt };
    throw new PlayerThreeError('bad_token');
  }

  /**
   * A human credential needs a seat the owner holds as a human. Owning an isolated agent seat on another team does not
   * forbid it (owner messages to that owner's seats stay refused by `coachingAllowed`); holding human seats on two
   * teams, or a broader view of the session, does.
   */
  private humanHolder(team: TeamOf<M>, role: RoleOf<M>): SeatState {
    const st = this.state(team, role);
    if (!st.assignment || !st.humanHeld) throw new PlayerThreeError('forbidden');
    const owner = st.assignment.owner;
    if (this.broaderOwners.has(owner) ||
      this.seatsState.some((other) => other.humanHeld && other.assignment?.owner === owner && other.seat.team !== st.seat.team)) {
      throw new PlayerThreeError('forbidden');
    }
    return st;
  }

  mintSpectatorToken(team: TeamOf<M>, opts?: { ttlSeconds?: number }): SeatTicket {
    this.live();
    return this.ticket({ kind: 'spectator', match: this.id, team: this.teamKey(team) }, opts);
  }

  private ticket(principal: Principal, opts?: { ttlSeconds?: number }): SeatTicket {
    const ttl = ticketTtl(opts);
    const token = newToken();
    const expiresAt = Date.now() + ttl * 1000;
    this.host.registerToken(token, this.id, principal, expiresAt);
    return { token, expiresAt };
  }

  revokeToken(token: string): void { this.host.revokeToken(token); }

  revokeSeat(team: TeamOf<M>, role: RoleOf<M>): void {
    const st = this.state(team, role);
    for (const token of st.humanTokens) this.host.revokeToken(token);
    for (const token of st.seatTokens) this.host.revokeToken(token);
    st.humanTokens.clear();
    st.seatTokens.clear();
    st.humanConnected = false;
    st.humanReady = false;
    st.humanHeld = false;
    st.commander?.released();
    const occupant = st.log.occupants.at(-1);
    if (occupant && occupant.toTick === null) occupant.toTick = this.adapter.tick;
    st.commander = undefined;
    if (st.assignment) st.assignment.kind = 'none';
    this.applyController(st, 'none', undefined, true);
    this.statusChanged(st);
  }

  private mint(st: SeatState): string {
    // One agent per seat: re-pairing revokes the previous agent's token.
    for (const old of st.seatTokens) this.host.revokeToken(old);
    st.seatTokens.clear();
    const token = newToken();
    st.seatTokens.add(token);
    this.host.registerToken(token, this.id, { kind: 'seat', match: this.id, team: st.seat.team, role: st.seat.role });
    this.statusChanged(st);
    return token;
  }

  seat(team: TeamOf<M>, role: RoleOf<M>): SeatControl {
    const st = this.state(team, role);
    return this.control(st, { kind: 'owner', key: `${this.id}/${st.seat.team}` });
  }

  /**
   * Agent-rights control plane for a seat principal. A seated commander passes its own principal key, so its
   * per-principal limits (practice concurrency, waits) are shared with its lobby calls.
   */
  controlFor(principal: Principal, commanderKey?: string, valid?: () => boolean): SeatControl | undefined {
    if (principal.kind !== 'seat' || principal.match !== this.id || this.isDisposed) return undefined;
    const st = this.state(principal.team, principal.role);
    const access = commanderKey === undefined ? this.host.principalAccess(principal) : undefined;
    if (commanderKey === undefined && !access) return undefined;
    const key = commanderKey ?? access?.key ?? `${this.id}/${st.seat.team}/${st.seat.role}`;
    return this.control(st, { kind: 'agent', key, commander: commanderKey !== undefined, valid: valid ?? access?.valid });
  }

  /** Revocation removes pending consumers before replacement credentials can receive private messages. */
  revokePrincipal(key: string): void {
    for (const waiter of this.waiters) {
      if (waiter.key !== key) continue;
      this.waiters.delete(waiter);
      waiter.reject(new PlayerThreeError('bad_token'));
    }
    for (const st of this.seatsState) if (st.sequence?.key === key) st.sequence = undefined;
  }

  // ------------------------------------------------------------------ outbound data

  /** The game's observation of a seat plus the host-owned `signals` slice; unguarded. */
  private rawObservation(st: SeatState, since: number, detail: readonly string[]): unknown {
    const raw = this.adapter.observe(st.seat, since, detail);
    return this.signals ? withSignals(raw, this.signals.seat(st.seat.team, st.seat.role)) : raw;
  }

  private observeFor(st: SeatState, since: number, source: TraceSource, detail: readonly string[]): unknown {
    if (st.terminal) return structuredClone(st.terminal.observation);
    const version = this.signals?.version(st.seat.team, st.seat.role) ?? 0;
    const r = this.guard.pass('observation', this.m.observation, this.rawObservation(st, since, detail));
    if (!r.ok) return undefined;
    if (source === 'agent') st.signalsSeen = version;
    this.trace({ type: 'observe', team: st.seat.team, role: st.seat.role, source, data: r.value, bytes: Buffer.byteLength(r.json) });
    return r.value;
  }

  /** The seat's observation detail for a request (spec §3 *Observation scope*); unknown sections → `invalid`. */
  private detailFor(st: SeatState, request: unknown): string[] {
    const detail = resolveDetail(this.m, st.seat.role, request);
    if (detail === null) throw new PlayerThreeError('invalid');
    return detail;
  }

  /** The game's team view plus the host-owned `signals` board; unguarded. */
  private rawView(team: string, snapshot: boolean): unknown {
    const raw = this.adapter.view(team, { snapshot });
    return this.signals ? withSignals(raw, this.signals.team(team)) : raw;
  }

  view(team: TeamOf<M>): ViewOf<M> {
    const r = this.guard.pass('view', this.m.view, this.rawView(this.teamKey(team), true));
    if (!r.ok) throw new PlayerThreeError('internal');
    return r.value as ViewOf<M>;
  }

  /** This tick's guarded incremental team view, computed once per tick for players and observers alike. */
  private incrementalView(team: string): unknown {
    const tick = this.adapter.tick;
    const cached = this.tickViews.get(team);
    if (cached?.tick === tick) return cached.view;
    const r = this.guard.pass('view', this.m.view, this.rawView(team, false));
    if (!r.ok) return undefined;
    if (typeof r.value === 'object' && r.value !== null && !Array.isArray(r.value)) this.tickViews.set(team, { tick, view: r.value as Record<string, unknown> });
    return r.value;
  }

  /**
   * A snapshot-equivalent team view for view streams and observer frames: the shared incremental view over the
   * snapshot's members (taken once), so dense recording never re-projects or re-validates the bootstrap. Every
   * snapshot member is kept, not only those the first incremental view lacked: an adapter may still send a static
   * member (e.g. match data) on its first incremental view and omit it afterwards, and late joiners' keyframes must
   * still carry it. Static members keep their identity across ticks, so stream diffs skip them without a deep compare.
   */
  private teamView(team: string): unknown {
    const incremental = this.incrementalView(team);
    if (typeof incremental !== 'object' || incremental === null || Array.isArray(incremental)) return this.view(team as TeamOf<M>);
    let bootstrap = this.viewBootstrap.get(team);
    if (!bootstrap) {
      const full: unknown = this.view(team as TeamOf<M>);
      bootstrap = typeof full === 'object' && full !== null ? { ...full } : {};
      this.viewBootstrap.set(team, bootstrap);
    }
    return { ...bootstrap, ...incremental };
  }

  report(team: TeamOf<M>): ReportOf<M> | null {
    const r = this.guard.pass('report', this.m.report, this.adapter.report(this.teamKey(team)));
    return r.ok ? (r.value as ReportOf<M>) : null;
  }

  onView(team: TeamOf<M>, listener: (version: number) => void): () => void {
    const key = this.teamKey(team);
    let stream = this.viewStreams.get(key);
    if (!stream) this.viewStreams.set(key, stream = new ViewStream(key));
    // Unsubscribed streams are not computed: resume from a fresh view so a joining reader's keyframe is current.
    if (stream.listeners.size === 0 && !this.isDisposed) {
      stream.reset();
      this.pushView(stream);
    }
    stream.listeners.add(listener);
    const subscribed = stream;
    return () => { subscribed.listeners.delete(listener); };
  }

  viewMessages(team: TeamOf<M>, after?: number): ViewMessage[] {
    return this.viewStreams.get(this.teamKey(team))?.messages(after) ?? [];
  }

  /** Push the team's current complete view; false when it is unavailable (a guard drop) or unchanged. */
  private pushView(stream: ViewStream): boolean {
    let view: unknown;
    try { view = this.teamView(stream.team); } catch { return false; }
    return view !== undefined && stream.push(view);
  }

  onEnd(listener: (outcomes: Record<string, Outcome>, ranks: Record<string, number>) => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  stream(team: TeamOf<M>, role: RoleOf<M>, everyTicks: number, listener: (obs: unknown) => void, detail?: DetailRequest): () => void {
    this.live();
    return this.streamFor(this.state(team, role), everyTicks, listener, detail);
  }

  private streamFor(st: SeatState, everyTicks: number, listener: (obs: unknown) => void, detail: unknown): () => void {
    if (!this.m.control.stream) throw new PlayerThreeError('mode_unavailable');
    if (!Number.isSafeInteger(everyTicks) || everyTicks < 1 || everyTicks > MAX_STREAM_EVERY_TICKS) throw new PlayerThreeError('invalid');
    const sub: StreamSub = { everyTicks: Math.max(everyTicks, this.minStreamEvery()), since: this.adapter.tick, detail: this.detailFor(st, detail), listener };
    st.streams.add(sub);
    return () => st.streams.delete(sub);
  }

  private minStreamEvery(): number {
    return Math.ceil(this.m.tickRate / (this.m.control.stream?.maxHz ?? this.m.tickRate));
  }

  replay(): Replay {
    return {
      format: 'playerthree.replay',
      version: 2,
      game: this.m.id,
      gameVersion: this.m.version,
      seed: this.seed,
      ...(this.options === undefined ? {} : { options: structuredClone(this.options) }),
      ticks: this.adapter.tick,
      teams: [...this.teamList],
      ...(this.sides.alliances ? { alliances: structuredClone(this.sides.alliances) as Record<string, string[]> } : {}),
      entries: structuredClone(this.entries),
      outcomes: Object.fromEntries(this.teamList.map((team) => [team, this.outcomeOf(team)])),
      ...(this.ranks ? { ranks: { ...this.ranks } } : {}),
      ...(this.windowFrom > 0 ? { window: { from: this.windowFrom, dropped: this.dropped } } : {}),
    };
  }

  checkpoint(tick?: number): ReplayPosition<M> | undefined {
    if (tick !== undefined && !Number.isSafeInteger(tick)) throw new PlayerThreeError('invalid');
    let found: Checkpoint | undefined;
    for (const cp of this.checkpoints) if (tick === undefined ? !found : cp.tick <= tick) found = cp;
    return found
      ? { adapter: found.adapter.clone!() as unknown as GameAdapter<M>, entryIndex: found.entryIndex, ...(found.signals ? { signals: found.signals.clone() } : {}) }
      : undefined;
  }

  /**
   * Persistent sessions, right after a step to a multiple of `checkpointTicks`: keep an isolated clone (never inside a
   * pause or a tick) and, past `checkpoints` clones, drop the oldest one and every entry recorded before the new oldest.
   */
  private keepCheckpoint(): void {
    const p = this.retention!;
    this.checkpoints.push({
      tick: this.adapter.tick,
      entryIndex: this.dropped + this.entries.length,
      adapter: this.adapter.clone!(),
      ...(this.signals ? { signals: this.signals.clone() } : {}),
    });
    if (this.checkpoints.length <= p.checkpoints) return;
    this.checkpoints.shift();
    const oldest = this.checkpoints[0]!;
    this.entries.splice(0, oldest.entryIndex - this.dropped);
    this.dropped = oldest.entryIndex;
    this.windowFrom = oldest.tick;
  }

  // ------------------------------------------------------------------ intent pipeline

  /**
   * schema → role → controller → rate limit → apply. `gate` decides the controller/rate rules:
   * owners always may act (bucketed); agents only while controller is `agent` (bucketed, or per-tick budget while
   * streaming); policies only while their run is the seat's active one; bots only while controller is `bot`.
   */
  private submit(st: SeatState, gate: IntentSource, raws: readonly unknown[], run?: PolicyRun): IntentAck[] {
    const source: TraceSource = gate === 'fallback' ? 'bot' : gate === 'agent' && st.streams.size > 0 ? 'stream' : gate;
    const acks: IntentAck[] = [];
    for (const raw of raws) {
      let ack: IntentAck;
      let intent: unknown;
      if (this.ended || this.finals.has(st.seat.team)) ack = { ok: false, code: 'game_over' };
      else {
        const c = checkIntent(this.m, this.schema, st.seat.role, raw);
        if (!c.ok) ack = c.ack;
        else {
          intent = c.intent;
          ack = this.gate(st, gate, run) ?? this.applyChecked(st, c.intent, gate);
        }
      }
      if (run) {
        const code = rejectCode(ack);
        if (code) run.reject(code, 1, !ack.ok && ack.code === 'invalid' ? ack : undefined);
      }
      acks.push(ack);
      if (ack.ok && (gate === 'agent' || gate === 'policy')) st.log.acceptedIntents++;
      else if (ack.ok && gate === 'owner') st.log.ownerIntents++;
      this.metricRecorder?.intent?.({ team: st.seat.team, role: st.seat.role, source, accepted: ack.ok, code: rejectCode(ack) ?? 'ok' });
      this.trace({ type: 'intent', team: st.seat.team, role: st.seat.role, source, ...(intent !== undefined ? { intent } : {}), ack });
    }
    return acks;
  }

  /**
   * A gated intent reaches the game, or (the reserved signal intents) the team's signal board: accepted signals are
   * recorded like intents and wake the agents whose slice changed.
   */
  private applyChecked(st: SeatState, intent: { kind: string } & Record<string, unknown>, source: IntentSource): IntentAck {
    if (!this.signals || !isSignalIntent(this.m, intent)) {
      const ownerRoles = source === 'owner'
        ? st.assignment && st.humanHeld
          ? this.seatsState.filter((other) => other.seat.team === st.seat.team && other.humanHeld && other.assignment?.owner === st.assignment!.owner).map((other) => other.seat.role)
          : [st.seat.role]
        : undefined;
      return applyIntent(this.sim, st.seat, intent, { source, ...(ownerRoles ? { ownerRoles } : {}) });
    }
    const ack = this.signals.apply(st.seat.team, st.seat.role, intent, this.adapter.tick);
    if (ack.ok) {
      this.sim.record([this.adapter.tick, st.seat.team, st.seat.role, 'signal', structuredClone(intent)]);
      for (const w of [...this.waiters]) if (w.agent) this.checkWaiter(w);
    }
    return ack;
  }

  private gate(st: SeatState, gate: IntentSource, run?: PolicyRun): IntentAck | undefined {
    switch (gate) {
      case 'owner':
        return st.ownerBucket.take() ? undefined : { ok: false, code: 'rate_limited' };
      case 'agent': {
        if (!st.scopes.includes('act')) return { ok: false, code: 'out_of_scope' };
        if (st.controller !== 'agent') return { ok: false, code: 'not_controller' };
        const stream = this.m.control.stream;
        if (stream && st.streams.size > 0) {
          if (st.streamTick !== this.adapter.tick) {
            st.streamTick = this.adapter.tick;
            st.streamCount = 0;
          }
          if (st.streamCount >= stream.intentsPerTick) return { ok: false, code: 'rate_limited' };
          st.streamCount++;
          return undefined;
        }
        return st.agentBucket.take() ? undefined : { ok: false, code: 'rate_limited' };
      }
      case 'policy':
        return run && this.activeRun(st) === run ? undefined : { ok: false, code: 'not_controller' };
      case 'bot':
        return st.controller === 'bot' ? undefined : { ok: false, code: 'not_controller' };
      case 'fallback':
        return st.controller === 'agent' && st.fallbackAtThink ? undefined : { ok: false, code: 'not_controller' };
    }
  }

  /** The policy that drives a seat right now, if any. */
  private activeRun(st: SeatState): PolicyRun | undefined {
    if (st.controller === 'policy') return st.pool ? st.pool.run : st.run;
    if (st.controller === 'agent' && st.policyAtThink) return st.run;
    return undefined;
  }

  sequenceActive(team: string, role: string): boolean {
    return !this.isDisposed && this.state(team, role).sequence !== undefined;
  }

  private schedule(st: SeatState, rights: Rights, raw: SequenceRequest): SequenceResult {
    const limits = this.m.control.sequence!;
    const snap = snapshot(raw);
    const invalid = (acks: IntentAck[][] = []): SequenceResult => ({ ok: false, code: 'invalid', acks });
    if (!snap.ok || !snap.value || typeof snap.value !== 'object' || Array.isArray(snap.value)) return invalid();
    const req = snap.value as SequenceRequest;
    if (Object.keys(req).some((key) => key !== 'steps' && key !== 'cancelOn') || !Array.isArray(req.steps) || req.steps.length > limits.maxSteps) return invalid();
    const kinds = ((this.m.event as ObjS).fields.kind as EnumS).values;
    if (req.cancelOn !== undefined && (!Array.isArray(req.cancelOn) || req.cancelOn.length > kinds.length ||
      req.cancelOn.some((kind) => !kinds.includes(kind)) || new Set(req.cancelOn).size !== req.cancelOn.length)) return invalid();
    const acks: IntentAck[][] = [];
    let previous = -1;
    let valid = true;
    for (const step of req.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).some((key) => key !== 'in' && key !== 'intents') ||
        !Number.isSafeInteger(step.in) || step.in < 0 || step.in > limits.maxTicksAhead ||
        !Array.isArray(step.intents) || step.intents.length > LIMITS.maxIntentsPerCall) return invalid(acks);
      if (previous >= 0 && (step.in <= previous || step.in - previous < limits.minSpacingTicks)) valid = false;
      previous = step.in;
      acks.push(step.intents.map((intent): IntentAck => {
        const result = checkIntent(this.m, this.schema, st.seat.role, intent);
        if (!result.ok) {
          valid = false;
          return result.ack;
        }
        return { ok: true };
      }));
    }
    if (!valid) return invalid(acks);
    const code = rights.kind === 'agent' && !st.scopes.includes('act') ? 'out_of_scope' : this.ended || this.finals.has(st.seat.team) ? 'game_over' : st.controller !== 'agent' ? 'not_controller' : undefined;
    if (code) return { ok: false, code, acks: req.steps.map((step) => step.intents.map(() => ({ ok: false, code }))) };
    const id = randomUUID();
    st.sequence = req.steps.length === 0 ? undefined : {
      id,
      key: rights.key,
      valid: rights.valid,
      steps: req.steps.map((step) => ({ tick: this.adapter.tick + step.in, intents: step.intents })),
      cancelOn: new Set(req.cancelOn),
      since: this.adapter.tick,
      agent: rights.kind === 'agent',
    };
    return { ok: true, id, acks };
  }

  private cancelSequences(): void {
    for (const st of this.seatsState) {
      const seq = st.sequence;
      if (!seq) continue;
      if ((seq.valid && !seq.valid()) || st.controller !== 'agent' || (seq.agent && !st.scopes.includes('act'))) {
        st.sequence = undefined;
        continue;
      }
      if (seq.cancelOn.size > 0) {
        for (const event of this.adapter.events(st.seat, seq.since)) {
          const checked = this.guard.pass('event', this.m.event, event);
          const value = checked.ok ? checked.value : undefined;
          if (value !== null && typeof value === 'object' && 'kind' in value && typeof value.kind === 'string' && seq.cancelOn.has(value.kind)) {
            st.sequence = undefined;
            break;
          }
        }
        seq.since = this.adapter.tick;
      }
    }
  }

  private advanceSequences(tick: number): void {
    this.cancelSequences();
    for (const st of this.seatsState) {
      const seq = st.sequence;
      if (!seq) continue;
      while (seq.steps.length > 0 && seq.steps[0]!.tick <= tick) {
        const step = seq.steps.shift()!;
        this.submit(st, 'agent', step.intents);
      }
      if (seq.steps.length === 0) st.sequence = undefined;
    }
  }

  private requestApproval(st: SeatState, action: PendingApproval['action']): { ok: false; approval: ApprovalRequest } {
    if (st.resolvingApproval || st.deploys.size > 0) throw new PlayerThreeError('approval_pending');
    const approval: Approval = { id: randomUUID(), kind: action.kind, version: action.kind === 'policyDeploy' ? st.commander?.nextVersion ?? st.nextVersion : action.version, status: 'pending' };
    st.pending = { approval, action };
    this.approvalChanged(st);
    return { ok: false, approval: { id: approval.id, kind: approval.kind, version: approval.version } };
  }

  private approvalChanged(st: SeatState): void {
    if (st.pending) st.commander?.approvalChanged(st.pending);
    st.approvalUnread = true;
    for (const waiter of [...this.waiters]) if (waiter.agent && waiter.st === st) this.checkWaiter(waiter, true, false, true);
    this.statusChanged(st);
  }

  async resolveApproval(team: TeamOf<M>, role: RoleOf<M>, id: string, approve: boolean): Promise<DeployResult | PublishResult | void> {
    this.live();
    if (typeof id !== 'string' || typeof approve !== 'boolean') throw new PlayerThreeError('invalid');
    const st = this.state(team, role);
    const pending = st.pending;
    if (!pending || pending.approval.id !== id || pending.approval.status !== 'pending') throw new PlayerThreeError('approval_not_found');
    if (st.resolvingApproval) throw new PlayerThreeError('approval_pending');
    if (!approve) {
      pending.approval.status = 'rejected';
      this.approvalChanged(st);
      return;
    }
    st.resolvingApproval = true;
    try {
      await st.libLoading;
      const action = pending.action;
      if (action.kind === 'policyDeploy' && (st.commander?.nextVersion ?? st.nextVersion) !== pending.approval.version) throw new PlayerThreeError('approval_failed');
      const result = action.kind === 'publish' ? this.publish(st, action.version)
        : action.kind === 'policyRollback' ? await this.deploy(st, undefined, action.version)
        : await this.deploy(st, action.artifact);
      pending.approval.status = 'ok' in result && !result.ok ? 'failed' : 'approved';
      return result;
    } catch (error) {
      pending.approval.status = 'failed';
      throw new PlayerThreeError('approval_failed');
    } finally {
      st.resolvingApproval = false;
      this.approvalChanged(st);
    }
  }

  // ------------------------------------------------------------------ owner chat

  private chatMode() {
    const chat = this.m.control.chat;
    if (!chat) throw new PlayerThreeError('mode_unavailable');
    return chat;
  }

  tell(team: TeamOf<M>, roles: readonly RoleOf<M>[] | 'all', text: string, ping?: unknown): void {
    this.live();
    const chat = this.chatMode();
    const t = this.teamKey(team);
    const targets = parseChatRoles(roles, this.roles);
    if (targets.some((role) => {
      const owner = this.state(t, role).assignment?.owner;
      return owner !== undefined && !this.coachingAllowed(owner);
    })) throw new PlayerThreeError('forbidden');
    const body = parseChatText(text, chat.maxTellChars);
    let typedPing: unknown;
    if (ping !== undefined) {
      if (!chat.ping) throw new PlayerThreeError('invalid');
      const snap = snapshot(ping);
      const r = snap.ok ? validateUnknown(chat.ping, snap.value) : snap;
      if (!r.ok) throw new PlayerThreeError('invalid');
      typedPing = r.value;
    }
    let bucket = this.tellBuckets.get(t);
    if (!bucket) this.tellBuckets.set(t, (bucket = new TokenBucket(TELL_RATE.perSecond, TELL_RATE.burst)));
    if (!bucket.take()) throw new PlayerThreeError('rate_limited');
    const message: OwnerMessage = { from: 'owner', tick: this.adapter.tick, text: body, ...(typedPing !== undefined ? { ping: typedPing } : {}) };
    let logged = false;
    for (const role of targets) {
      const st = this.state(t, role);
      if (st.commander && !logged) {
        st.commander.told(targets, structuredClone(message));
        logged = true;
      }
      this.deliver(st, structuredClone(message));
    }
  }

  /** Put an owner message into a seat's inbox and wake that seat's agent waits. */
  deliver(st: SeatState, message: OwnerMessage): void {
    st.inbox.push(message);
    st.log.ownerTells++;
    if (st.inbox.length > MAX_INBOX) st.inbox.splice(0, st.inbox.length - MAX_INBOX);
    for (const w of [...this.waiters]) if (w.agent && w.st === st) this.checkWaiter(w, true, true);
    this.statusChanged(st);
  }

  /** A commander registry delivering a lobby-sent message to a seated commander. */
  deliverTo(team: string, role: string, message: OwnerMessage): void {
    if (this.isDisposed) return;
    this.deliver(this.state(team, role), { ...message, tick: this.adapter.tick });
  }

  /** Read (and clear) a seat's unread owner messages. */
  private drain(st: SeatState): OwnerMessage[] {
    return st.inbox.splice(0, st.inbox.length);
  }

  /** Unread owner messages of the seat an agent principal holds (MCP: next to the observation). */
  inboxFor(principal: Principal): OwnerMessage[] {
    if (principal.kind !== 'seat' || principal.match !== this.id || this.isDisposed || !this.m.control.chat) return [];
    return this.drain(this.state(principal.team, principal.role));
  }

  onSaid(listener: (team: TeamOf<M>, said: Said) => void): () => void {
    this.saidListeners.add(listener);
    return () => this.saidListeners.delete(listener);
  }

  private say(st: SeatState, rights: Rights, raw: unknown, disclosure?: { audience: 'observers'; category: 'summary' | 'chat' }): SayResult {
    const chat = this.chatMode();
    if (rights.kind !== 'agent') throw new PlayerThreeError('forbidden');
    const text = parseChatText(raw, chat.maxSayChars);
    if (disclosure !== undefined && (!disclosure || typeof disclosure !== 'object' ||
      Object.keys(disclosure).length !== 2 || disclosure.audience !== 'observers' ||
      !['summary', 'chat'].includes(disclosure.category))) throw new PlayerThreeError('invalid');
    if (!st.sayBucket.take()) throw new PlayerThreeError('rate_limited');
    const said: Said = { role: st.seat.role, tick: this.adapter.tick, text };
    if (disclosure) {
      const event: CommentaryEvent = { team: st.seat.team, role: st.seat.role, tick: this.tick, category: disclosure.category, text };
      for (const listener of this.commentaryListeners) {
        try { listener({ ...event }); } catch { /* Consent gates must not interrupt the agent. */ }
      }
    }
    for (const l of this.saidListeners) {
      try {
        l(st.seat.team as TeamOf<M>, { ...said });
      } catch {
        // A transport listener must not break the agent's call.
      }
    }
    st.commander?.said({ ...said });
    return { ok: true, tick: said.tick };
  }

  // ------------------------------------------------------------------ tick loop

  start(): void {
    this.live();
    if (this.halted) throw new PlayerThreeError('forbidden');
    this.manualStart = false;
    if (this.hold?.pending) this.fallbackUnreadyPolicies();
    this.endHold();
    this.enterMatch();
    if (this.timer || this.ended || this.isDisposed) return;
    this.timer = setInterval(() => {
      // Never queue up ticks behind a slow one: the game slows down instead of bursting.
      if (this.busy) return;
      // Paused: the clock stands still (the pause timer re-checks presence).
      this.updatePause();
      if (this.pausedAt) return;
      this.busy = true;
      // Failures are logged and stop the match inside enqueue; nothing to handle here.
      this.enqueue(1)
        .catch(() => {})
        .finally(() => {
          this.busy = false;
        });
    }, 1000 / this.m.tickRate);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  step(n = 1): Promise<void> {
    this.live();
    if (this.halted) throw new PlayerThreeError('forbidden');
    if (!Number.isSafeInteger(n) || n < 0) throw new PlayerThreeError('invalid');
    this.checkReady();
    if (this.manualStart || this.hold?.pending) throw new PlayerThreeError('paused');
    this.updatePause();
    if (this.pausedAt) throw new PlayerThreeError('paused');
    return this.enqueue(n);
  }

  private enqueue(n: number): Promise<void> {
    const next = this.chain.then(async () => {
      for (let i = 0; i < n && !this.ended && !this.isDisposed && !this.halted; i++) {
        this.checkReady();
        if (this.manualStart || this.hold?.pending) throw new PlayerThreeError('paused');
        // Pause is decided at each tick boundary; a paused session refuses the remaining ticks.
        this.updatePause();
        if (this.pausedAt) throw new PlayerThreeError('paused');
        this.ticking = true;
        try {
          await this.tickOnce(i === n - 1);
        } finally {
          this.ticking = false;
        }
      }
    });
    this.chain = next.catch((e: unknown) => {
      if (e instanceof PlayerThreeError && e.code === 'paused') return;
      console.error('playerthree/host: tick failed; match stopped');
      this.stop();
    });
    return next;
  }

  /**
   * One simulation tick. `final`: the last tick of this step batch. Views are pushed once per batch (on its last tick,
   * if a view tick passed during it), so a multi-tick step — accelerated room stepping, fast-forward — adds one
   * stream version, not one per game tick that no client could have seen.
   */
  private async tickOnce(final: boolean): Promise<void> {
    const tick = this.adapter.tick;
    this.cancelSequences();
    if (tick % this.period === 0) await this.think(tick);
    if (this.ended || this.isDisposed) return;
    this.advanceSequences(tick);
    this.adapter.step();
    this.metricRecorder?.collect();
    const now = this.adapter.tick;
    // Turn the boards over before anything of the new tick (agent input between ticks, checkpoints, observations).
    this.signals?.advance(now);
    if (this.retention && now !== tick && now % this.retention.checkpointTicks === 0) this.keepCheckpoint();
    for (const st of this.seatsState) {
      for (const sub of st.streams) {
        if (now % sub.everyTicks !== 0) continue;
        const obs = this.observeFor(st, sub.since, 'stream', sub.detail);
        sub.since = now;
        if (obs !== undefined) sub.listener(obs);
      }
    }
    if (now % this.viewPeriod === 0) this.viewDue = true;
    if (this.viewDue && final) {
      this.viewDue = false;
      for (const stream of this.viewStreams.values()) {
        if (stream.listeners.size > 0 && this.pushView(stream)) for (const l of stream.listeners) l(stream.version);
      }
    }
    this.checkEnd();
    if (this.observers) this.recordObservers(now);
    // Views are shared only within this tick: commands between ticks change what the next view shows.
    this.tickViews.clear();
    for (const listener of this.tickListeners) {
      try { listener(now); } catch { /* Recorder consumers cannot interrupt simulation. */ }
    }
    for (const w of this.waiters) this.checkWaiter(w);
  }

  /**
   * Observers interpolate between frames, so every perspective someone can be watching is recorded each real-time
   * tick: `all` of a delayed omniscient policy, the teams of a delayed team-only policy, and any perspective read in
   * the last few seconds. Everything is refreshed at least once a second. The wall-clock gap (60% of a real-time
   * tick, so arrival jitter never skips one) caps accelerated matches at about the tick rate.
   */
  private recordObservers(tick: number): void {
    const observers = this.observers!;
    const policy = this.observerPolicy!;
    const wall = Date.now();
    if (this.ended || wall - this.lastObserverFullAt >= 1000) {
      observers.capture(tick);
      this.lastObserverCaptureAt = this.lastObserverFullAt = wall;
      return;
    }
    if (wall - this.lastObserverCaptureAt < 600 / this.m.tickRate) return;
    const refresh = this.observerRefresh;
    refresh.length = 0;
    const delayed = policy.minDelayMs > 0;
    if (policy.allowOmniscient && (delayed || observers.watched('all'))) refresh.push('all');
    for (const team of this.teamList) if (!policy.allowOmniscient && delayed || observers.watched(team)) refresh.push(team);
    if (refresh.length === 0) return;
    observers.capture(tick, refresh);
    this.lastObserverCaptureAt = wall;
  }

  private async think(tick: number): Promise<void> {
    // Simultaneous decisions: wait for pending policy loads, then every deciding seat (bots and active
    // policies) observes the same start-of-tick world before any bot or policy intent is submitted.
    await Promise.all(this.seatsState.flatMap((st) => [st.pool?.loading, st.libLoading]));
    if (this.isDisposed) return;
    for (const st of this.seatsState) {
      st.activeAtThink = this.agentActive(st);
      // Past max pause the seat falls back like `policy`. A pause seat that turned absent inside this tick holds
      // (nothing acts) until the next tick boundary pauses the session.
      const absent = st.mandate.whenAbsent === 'pause' && st.pauseExpired ? 'policy' : st.mandate.whenAbsent;
      st.policyAtThink = st.activeAtThink || absent === 'policy';
      st.fallbackAtThink = st.controller === 'agent' && !st.activeAtThink && (absent === 'bot' || (absent === 'policy' && !st.run));
      if (this.finals.has(st.seat.team)) continue;
      if (st.fallbackAtThink) st.log.fallbackTicks += this.period;
      else if (st.controller === 'agent' && !st.activeAtThink && st.policyAtThink && st.run?.active) st.log.absentPolicyTicks += this.period;
      const run = this.activeRun(st);
      if (run?.active && run !== st.pool?.run && st.log.switches.at(-1)?.version !== run.version) st.log.switches.push({ tick, version: run.version });
    }
    // Seats of a team that is out no longer decide.
    const policies = this.seatsState.flatMap((st) => {
      const run = this.activeRun(st);
      if (!run?.active || this.finals.has(st.seat.team)) return [];
      const obs = this.guard.pass('observation', this.m.observation, this.rawObservation(st, st.policySince, run.detail));
      st.policySince = tick;
      return obs.ok ? [{ st, run, obs: obs.value }] : [];
    });
    const bots = this.seatsState.flatMap((st) => {
      const bot = st.bot;
      if ((st.controller !== 'bot' && !st.fallbackAtThink) || !bot || this.finals.has(st.seat.team)) return [];
      // Built-in bots are game code: every section in full.
      const obs = this.guard.pass('observation', this.m.observation, this.rawObservation(st, st.botSince, observationSections(this.m)));
      st.botSince = tick;
      return obs.ok ? [{ st, bot, obs: obs.value, intents: [] as unknown[] }] : [];
    });
    // Bot packages answer synchronously too, under one trusted hang guard for the round (spec §11 *Trusted runner*).
    eachBot(bots, (i) => {
      const b = bots[i]!;
      b.intents = b.bot.think(b.obs);
    });
    for (const { st, intents } of bots) this.submit(st, st.controller === 'bot' ? 'bot' : 'fallback', intents);
    const calls = policies.map(async ({ st, run, obs }) => ({ st, run, out: await run.think(obs) }));
    for (const r of await Promise.all(calls)) {
      if (!r || this.isDisposed) continue;
      const { st, run, out } = r;
      const acks = this.submit(st, 'policy', out.intents, run);
      const pool = st.pool?.run === run;
      this.trace({
        type: 'policy_call',
        team: st.seat.team,
        role: st.seat.role,
        version: run.version,
        pool,
        ms: out.ms,
        intents: out.intents.length,
        rejected: acks.filter((a) => !a.ok).length,
        // Pool policies are other players' code: their text never reaches this match's people.
        logs: pool ? [] : out.logs,
        ...(out.error ? { error: out.error.code } : {}),
      });
    }
  }

  /**
   * Keep each team's first final outcome. A team that turns final is out: its sequences stop, its pool policies and
   * commanders record the outcome, its seats' status changes (its waits return after the tick). Once every team is
   * final the match is over: ranks are fixed and the end listeners fire.
   */
  private checkEnd(): void {
    if (this.ended || this.retention) return;
    for (const team of this.teamList) {
      if (this.finals.has(team)) continue;
      const outcome = this.adapter.outcome(team);
      if (outcome === 'win' || outcome === 'loss' || outcome === 'draw') this.finals.set(team, outcome);
    }
    const out = this.teamList.filter((team) => this.finals.has(team) && !this.retired.has(team));
    if (out.length === 0) return;
    const over = this.finals.size === this.teamList.length;
    if (over) {
      this.ended = true;
      this.stop();
      // An ended session is not paused (no resume entry: nothing follows the end).
      this.stopPauseTimer();
      for (const st of this.seatsState) st.pause = undefined;
      this.ranks ??= this.finalRanks();
      this.writeLog();
    }
    for (const team of out) this.retired.add(team);
    const retiring = this.seatsState.filter((st) => out.includes(st.seat.team));
    for (const st of retiring) {
      st.sequence = undefined;
      st.terminal = { tick: this.adapter.tick, observation: structuredClone(this.observeFor(st, 0, 'agent', this.detailFor(st, undefined))) };
      st.activationGeneration++;
    }
    // An owner's self-play records no pool outcome and no commander stats (`sameOwnerOpposed`); receipts still go out.
    if (!this.opposedOwners) for (const st of retiring) if (st.controller === 'policy' && st.pool) this.host.pool.record(st.pool.entry.id, this.finals.get(st.seat.team)!);
    for (const st of retiring) st.commander?.ended(this.finals.get(st.seat.team)!);
    for (const st of over ? this.seatsState : retiring) this.statusChanged(st);
    if (!over) return;
    const outcomes: Record<string, Outcome> = Object.fromEntries(this.teamList.map((team) => [team, this.finals.get(team)!]));
    const ranks = { ...this.ranks! };
    this.trace({ type: 'match_ended', outcomes, ranks });
    for (const listener of this.endListeners) {
      try { listener({ ...outcomes }, { ...ranks }); } catch { /* Terminal revocation must outlive observer failures. */ }
    }
    this.host.revokeMatch(this.id, true);
  }

  /** The game's ranks when they follow the ranking rules, else ranks by outcome. */
  private finalRanks(): Record<string, number> {
    const rank = this.adapter.rank?.bind(this.adapter);
    if (rank) {
      try {
        const ranks = Object.fromEntries(this.teamList.map((team) => [team, rank(team)]));
        if (validRanks(this.sides, ranks)) return ranks;
      } catch {
        // A failing game ranking falls back like an invalid one.
      }
      console.error('playerthree/host: adapter.rank() broke the ranking rules; ranked by outcome');
    }
    return ranksByOutcome(this.sides, Object.fromEntries(this.finals));
  }

  // ------------------------------------------------------------------ wait

  private wait(st: SeatState, rights: Rights, raw: unknown): Promise<WaitResult> {
    const req = parseArgs(this.argSchemas.wait, raw);
    let mine = 0;
    for (const w of this.waiters) if (w.key === rights.key) mine++;
    if (mine >= MAX_WAITERS_PER_PRINCIPAL) throw new PlayerThreeError('busy');
    const { promise, resolve, reject } = Promise.withResolvers<WaitResult>();
    const now = this.adapter.tick;
    const w: Waiter = {
      st,
      key: rights.key,
      agent: rights.kind === 'agent',
      lobby: this.prematch(),
      start: now,
      until: now + Math.ceil(req.seconds * this.m.tickRate),
      wallUntil: Date.now() + req.seconds * 1000,
      kinds: req.until && req.until.length > 0 ? new Set(req.until) : null,
      resolve,
      reject,
      valid: rights.valid,
    };
    this.waiters.add(w);
    // No game time passes before the start: a lobby-phase wait runs on the wall clock. Its timer ends it outright
    // (timers may fire a millisecond before `wallUntil` by Date.now()).
    if (w.lobby) {
      w.timer = setTimeout(() => this.checkWaiter(w, true), req.seconds * 1000);
      w.timer.unref?.();
    }
    // Unread owner messages end an agent's wait at once.
    const approval = w.agent && st.approvalUnread;
    this.checkWaiter(w, approval || (w.agent && st.inbox.length > 0), w.agent && st.inbox.length > 0, approval);
    return promise;
  }

  /** The agent's first result in the running match: its first observation (`since` 0: the whole picture) and the next step. */
  private entry(st: SeatState, agent: boolean): WaitResult {
    const observation = this.observeFor(st, 0, agent ? 'agent' : 'owner', this.detailFor(st, undefined));
    return {
      phase: 'match', tick: this.adapter.tick, outcome: this.outcomeOf(st.seat.team), events: [],
      ...(observation !== undefined ? { observation } : {}), instruction: MATCH_INSTRUCTION,
    };
  }

  private checkWaiter(w: Waiter, force = false, ownerMessage = false, approval = false): void {
    if (w.valid && !w.valid()) {
      this.waiters.delete(w);
      clearTimeout(w.timer);
      w.reject(new PlayerThreeError('bad_token'));
      return;
    }
    if (w.st.terminal) {
      this.waiters.delete(w);
      clearTimeout(w.timer);
      const messages = w.agent ? this.drain(w.st) : [];
      w.resolve({ phase: 'match', tick: w.st.terminal.tick, outcome: this.outcomeOf(w.st.seat.team), events: [],
        ...(messages.length ? { messages } : {}) });
      return;
    }
    const wake = { ...(approval ? { wake: 'approval' as const } : ownerMessage ? { wake: 'owner_message' as const } : {}) };
    if (w.lobby) {
      const held = this.prematch();
      if (!(force || !held || Date.now() >= w.wallUntil)) return;
      this.waiters.delete(w);
      clearTimeout(w.timer);
      if (approval) w.st.approvalUnread = false;
      const messages = w.agent ? this.drain(w.st) : [];
      const extra = { ...(messages.length > 0 ? { messages } : {}), ...wake };
      if (held) w.resolve({ ...this.lobbyState(w.st), ...extra });
      else if (this.ended || this.halted || this.isDisposed) w.resolve({ phase: 'match', tick: this.adapter.tick, outcome: this.outcomeOf(w.st.seat.team), events: [], ...extra });
      else w.resolve({ ...this.entry(w.st, w.agent), ...extra });
      return;
    }
    const events = this.adapter.events(w.st.seat, w.start);
    const hit = w.kinds !== null && events.some((e) => typeof e === 'object' && e !== null && 'kind' in e && typeof e.kind === 'string' && w.kinds!.has(e.kind));
    const due = this.adapter.tick >= w.until || (this.pausedAt !== undefined && Date.now() >= w.wallUntil);
    const { team, role } = w.st.seat;
    const signalVersion = this.signals?.version(team, role) ?? 0;
    // A teammate's signal (or a change to one this seat sent) the agent has not seen yet ends its wait.
    const signal = w.agent && signalVersion > w.st.signalsSeen;
    if (!(force || hit || signal || this.ended || this.finals.has(team) || this.isDisposed || due)) return;
    this.waiters.delete(w);
    if (approval) w.st.approvalUnread = false;
    if (signal) w.st.signalsSeen = signalVersion;
    const out: unknown[] = [];
    for (const e of events.slice(-MAX_WAIT_EVENTS)) {
      const r = this.guard.pass('event', this.m.event, e);
      if (r.ok) out.push(r.value);
    }
    const messages = w.agent ? this.drain(w.st) : [];
    w.resolve({
      phase: 'match',
      tick: this.adapter.tick,
      outcome: this.outcomeOf(w.st.seat.team),
      events: out,
      ...(messages.length > 0 ? { messages } : {}),
      ...(signal ? { signals: this.signals!.seat(team, role) } : {}),
      ...(approval ? { wake: 'approval' as const } : ownerMessage ? { wake: 'owner_message' as const } : signal ? { wake: 'signal' as const } : {}),
    });
  }

  // ------------------------------------------------------------------ policies

  private policyLimits() {
    const limits = this.m.control.policy;
    if (!limits) throw new PlayerThreeError('mode_unavailable');
    return limits;
  }

  /**
   * A saved artifact never shares its probe VM with the clean instance that will play. `source`: the request a fresh
   * deploy came from, so a load failure names its originating part (spec §11).
   */
  private async preparePolicy(st: SeatState, artifact: StoredPolicyArtifact, version: number, generation: number, source?: PolicySource): Promise<
    { ok: true; run: PolicyRun; probe: PolicyStats; detail: PolicyDetail | null } | { ok: false; error: PolicyError; cancelled?: true }
  > {
    const limits = this.policyLimits();
    const fail = (error: PolicyError, state: 'stale_policy' | 'policy_failed' = 'policy_failed') => {
      if (!this.isDisposed && st.activationGeneration === generation) {
        st.policyReadiness = state;
        this.statusChanged(st);
      }
      return { ok: false as const, error };
    };
    if (artifact.surfaceHash !== surfaceHash(this.m)) return fail({ code: 'bad_module', message: 'Saved policy surface does not match this host.' }, 'stale_policy');
    let matchData: unknown;
    try {
      matchData = matchDataFor(this.sim, st.seat);
    } catch (error) {
      fail({ code: 'bad_output', message: 'Seat bootstrap failed its schema guard.' });
      throw error;
    }
    const loaded = await loadSeatArtifact(artifact, limits, this.policySeed, matchData, this.m, st.seat.role);
    if (!loaded.ok) return fail(annotateLoadError(loaded.error, source, this.skills));
    if (this.isDisposed || st.activationGeneration !== generation) {
      loaded.instance.dispose();
      return { ...fail({ code: 'bad_output', message: 'Policy activation was cancelled.' }), cancelled: true };
    }
    const probe = new PolicyRun(version, artifact, loaded.instance, limits, this.policySeed, matchData, loaded.detail);
    let stats: PolicyStats;
    try {
      const obs = this.guard.pass('observation', this.m.observation, this.rawObservation(st, this.adapter.tick, probe.detail));
      if (!obs.ok) return fail({ code: 'bad_output', message: 'Seat observation failed its schema guard.' });
      const out = await probe.think(obs.value);
      if (this.isDisposed || st.activationGeneration !== generation) return { ...fail({ code: 'bad_output', message: 'Policy activation was cancelled.' }), cancelled: true };
      if (out.error) return fail(out.error);
      for (const raw of out.intents) {
        const checked = checkIntent(this.m, this.schema, st.seat.role, raw);
        if (!checked.ok) return fail({ code: 'bad_output', message: 'Policy emitted an invalid intent.' });
      }
      stats = probe.snapshot();
      if (stats.intentsRejected.length > 0) return fail({ code: 'bad_output', message: 'Policy exceeded its intent budget.' });
    } finally {
      probe.dispose();
    }
    if (this.isDisposed || st.activationGeneration !== generation) return { ...fail({ code: 'bad_output', message: 'Policy activation was cancelled.' }), cancelled: true };
    // Load only after validation; init receives the same guarded seat bootstrap, never probe state.
    const live = await loadSeatArtifact(artifact, limits, this.policySeed, matchData, this.m, st.seat.role);
    if (!live.ok) return fail(live.error);
    if (this.isDisposed || st.activationGeneration !== generation) {
      live.instance.dispose();
      return { ...fail({ code: 'bad_output', message: 'Policy activation was cancelled.' }), cancelled: true };
    }
    st.policyReadiness = undefined;
    return { ok: true, run: new PolicyRun(version, artifact, live.instance, limits, this.policySeed, matchData, live.detail), probe: stats, detail: live.instance.detail ?? null };
  }

  private async deploy(st: SeatState, rawArtifact: unknown, rollback?: number): Promise<DeployResult> {
    const limits = this.policyLimits();
    const generation = st.activationGeneration;
    await st.libLoading;
    if (this.isDisposed || st.activationGeneration !== generation) throw new PlayerThreeError('forbidden');
    let artifact: StoredPolicyArtifact;
    let source: PolicySource | undefined;
    if (rollback === undefined) {
      const parsed = await parseArtifact(rawArtifact, limits, { skills: this.skills, starters: this.starters, role: st.seat.role });
      if (!parsed.ok) {
        st.policyReadiness = 'policy_failed';
        this.statusChanged(st);
        this.trace({ type: 'policy_deploy', team: st.seat.team, role: st.seat.role, ok: false, rollback: false, error: parsed.error });
        return { ok: false, error: parsed.error };
      }
      artifact = { ...parsed.artifact, surfaceHash: surfaceHash(this.m), artifactHash: policyArtifactHash(parsed.artifact) };
      source = parsed.source;
    } else {
      const old = st.history.find((h) => h.version === rollback);
      if (!old) throw new PlayerThreeError('invalid');
      artifact = old.artifact;
    }
    return st.deploys.run(async () => {
      // Numbered once the seat's earlier deploys have run, so concurrent deploys number in queue order.
      const version = rollback ?? st.commander?.reserveVersion() ?? st.nextVersion;
      const fail = (error: PolicyError): DeployResult => {
        this.trace({ type: 'policy_deploy', team: st.seat.team, role: st.seat.role, ok: false, rollback: rollback !== undefined, error });
        return { ok: false, error };
      };
      const loaded = await this.preparePolicy(st, artifact, version, generation, source);
      if (!loaded.ok) {
        if (loaded.cancelled) throw new PlayerThreeError('forbidden');
        return fail(loaded.error);
      }
      const probeStats = loaded.probe;
      if (st.pool) {
        // Redeployment recovers a failed pool seat by selecting the newly validated own policy.
        st.activationGeneration++;
        st.pool.run?.dispose();
        st.pool = undefined;
      }
      st.run?.dispose();
      st.run = loaded.run;
      if (st.assignment?.kind === 'policy' && st.controller !== 'policy') this.applyController(st, 'policy', undefined, true);
      st.policySince = this.adapter.tick;
      if (rollback === undefined) {
        st.history.push({ version, artifact, ...starterOf(source) });
        if (st.history.length > MAX_VERSIONS) st.history.shift();
        st.nextVersion = Math.max(st.nextVersion, version + 1);
      }
      this.trace({ type: 'policy_deploy', team: st.seat.team, role: st.seat.role, ok: true, rollback: rollback !== undefined, version });
      if (st.commander) {
        if (rollback === undefined) st.commander.deployed(version, { ...artifact, source: source ?? null, detail: loaded.detail, provenance: { ...DEPLOYED } }, probeStats);
        else st.commander.activated(version, probeStats);
      }
      this.statusChanged(st);
      this.checkReady();
      return { ok: true, version, probe: probeStats };
    });
  }

  private async practice(st: SeatState, rights: Rights, raw: unknown): Promise<PracticeResult> {
    const req = await parsePracticeRequest(this.m, this.skills, raw, st.seat.role);
    let artifact: PolicyArtifact;
    let version: number;
    if (req.artifact) {
      if (!req.artifact.ok) throw new PlayerThreeError('invalid');
      artifact = req.artifact.artifact;
      version = 0;
    } else if (st.run) {
      artifact = st.run.artifact;
      version = st.run.version;
    } else {
      throw new PlayerThreeError('invalid');
    }
    const running = this.host.practices.get(rights.key) ?? 0;
    if (running >= req.concurrent) throw new PlayerThreeError('busy');
    this.host.practices.set(rights.key, running + 1);
    try {
      const seed = req.seed ?? Math.floor(Math.random() * LIMITS.maxSeed);
      const allies = req.allies ?? req.opponent;
      const result = await runPractice({
        definition: this.def,
        seat: st.seat,
        ...this.sides,
        opponent: req.opponent,
        allies,
        ticks: req.ticks,
        seed,
        options: req.options === undefined ? this.options : mergeMatchOptions(this.m.matchOptions, this.host.matchOptions, req.options),
        artifact,
        ...(req.artifact?.ok ? { source: req.artifact.source } : {}),
        version,
        mandate: st.mandate,
      });
      this.trace({ type: 'practice', team: st.seat.team, role: st.seat.role, opponent: req.opponent, allies, ticks: req.ticks, seed, result });
      return result;
    } finally {
      const n = (this.host.practices.get(rights.key) ?? 1) - 1;
      if (n <= 0) this.host.practices.delete(rights.key);
      else this.host.practices.set(rights.key, n);
    }
  }

  private publish(st: SeatState, version?: number): PublishResult {
    const pool = this.m.control.pool;
    if (!pool) throw new PlayerThreeError('mode_unavailable');
    const artifact = st.history.find((entry) => entry.version === (version ?? st.run?.version))?.artifact;
    if (!artifact) throw new PlayerThreeError('invalid');
    const owner = `${this.id}/${st.seat.team}`;
    if (this.host.pool.countBy(owner) >= pool.maxPublishedPerPrincipal) throw new PlayerThreeError('forbidden');
    return { policyId: this.host.pool.publish(st.seat.role, artifact, owner).id };
  }

  // ------------------------------------------------------------------ control plane

  private control(st: SeatState, rights: Rights): SeatControl {
    // A control plane serves the occupant it was made for: after `assign` hands the seat over, its calls fail.
    const occupancy = st.occupancy;
    const touch = (): void => {
      this.live();
      if (rights.valid && !rights.valid()) throw new PlayerThreeError('bad_token');
      if (rights.kind !== 'agent') return;
      if (st.occupancy !== occupancy) throw new PlayerThreeError('bad_token');
      st.lastAgentAt = Date.now();
      // A present agent ends a max-pause fallback and resumes a session its absence paused (at this tick boundary,
      // or the next one).
      st.pauseExpired = false;
      if (st.pause) this.updatePause();
    };
    const gateMode = (method: ControlMethod): void => {
      const mode = METHOD_MODE[method];
      if (mode !== 'intents' && !this.m.control[mode]) throw new PlayerThreeError('mode_unavailable');
      const scope = METHOD_SCOPE[method];
      if (rights.kind === 'agent' && scope && !st.scopes.includes(scope)) throw new PlayerThreeError('out_of_scope');
    };
    const key = `${st.seat.team}/${st.seat.role}`;
    const control: SeatControl = {
      briefing: (async (topic?: string, page?: number) => {
        touch();
        if (topic !== undefined) {
          if (st.terminal && topic === 'match-data') throw new PlayerThreeError('forbidden');
          // Only the live match-data topic reads (and guards) the seat's bootstrap.
          const matchData = topic === 'match-data' && this.m.matchData ? matchDataFor(this.sim, st.seat) : null;
          return topicPage(this.m, topic, page, { matchData });
        }
        let b = this.briefings.get(key);
        if (!b) {
          b = buildBriefing(this.m, st.seat, {}, this.sides);
          this.briefings.set(key, b);
        }
        return { ...structuredClone(b), phase: this.prematch() ? 'lobby' : 'match', scopes: [...st.scopes], mandate: structuredClone(st.mandate) };
      }) as SeatControl['briefing'],
      observe: async (since?: number, detail?: DetailRequest) => {
        touch();
        // Before the start an agent's observation is its lobby state (seat, pre-match summary, readiness, start).
        if (rights.kind === 'agent' && this.prematch()) return this.lobbyState(st);
        const s = since === undefined ? 0 : parseArgs(this.argSchemas.since, since);
        const obs = this.observeFor(st, s, rights.kind === 'agent' ? 'agent' : 'owner', this.detailFor(st, detail));
        if (obs === undefined) throw new PlayerThreeError('internal');
        return obs;
      },
      act: async (intents: unknown[]) => {
        touch();
        if (this.manualStart || this.hold?.pending) throw new PlayerThreeError('paused');
        if (!Array.isArray(intents) || intents.length > LIMITS.maxIntentsPerCall) throw new PlayerThreeError('invalid');
        if (rights.kind === 'agent' && !st.scopes.includes('act')) return intents.map(() => ({ ok: false as const, code: 'out_of_scope' as const }));
        return this.submit(st, rights.kind, intents);
      },
      sequence: async (request: SequenceRequest) => {
        touch();
        if (this.manualStart || this.hold?.pending) throw new PlayerThreeError('paused');
        if (!this.m.control.sequence) throw new PlayerThreeError('mode_unavailable');
        return this.schedule(st, rights, request);
      },
      policyDeploy: async (artifact: PolicySource) => {
        touch();
        gateMode('policyDeploy');
        const generation = st.activationGeneration;
        await st.libLoading;
        if (this.isDisposed || st.activationGeneration !== generation) throw new PlayerThreeError('forbidden');
        if (rights.kind === 'agent' && st.mandate.autonomy === 'supervised') {
          const parsed = await parseArtifact(artifact, this.policyLimits(), { skills: this.skills, starters: this.starters, role: st.seat.role });
          if (!parsed.ok) return { ok: false, error: parsed.error };
          // The approval keeps the request itself, so the approved deploy's library version retains its source.
          return this.requestApproval(st, { kind: 'policyDeploy', artifact: parsed.source });
        }
        return this.deploy(st, artifact);
      },
      policyStatus: async () => {
        touch();
        const generation = st.activationGeneration;
        await st.libLoading;
        touch();
        if (this.isDisposed || st.activationGeneration !== generation) throw new PlayerThreeError('forbidden');
        const activationError = st.policyReadiness ?? (!st.run && st.commander?.needsRoleDeploy ? 'needs_role_deploy' as const : undefined);
        if (!st.run && !st.pending && !activationError) return null;
        const active = st.run ? st.history.find((h) => h.version === st.run!.version) : undefined;
        return {
          ...(st.run ? st.run.snapshot() : { version: null }),
          ...(active?.from === undefined ? {} : { from: active.from, ...(active.knobs === undefined ? {} : { knobs: structuredClone(active.knobs) }) }),
          ...(st.pending ? { approval: { ...st.pending.approval } } : {}),
          ...(activationError ? { activationError } : {}),
        };
      },
      policyRollback: async (version: number) => {
        touch();
        gateMode('policyRollback');
        const v = parseArgs(this.argSchemas.version, version);
        const generation = st.activationGeneration;
        await st.libLoading;
        if (this.isDisposed || st.activationGeneration !== generation) throw new PlayerThreeError('forbidden');
        if (rights.kind === 'agent' && st.mandate.autonomy === 'supervised') {
          if (!st.history.some((entry) => entry.version === v)) throw new PlayerThreeError('invalid');
          return this.requestApproval(st, { kind: 'policyRollback', version: v });
        }
        return this.deploy(st, undefined, v);
      },
      policyExport: async (request?: PolicyExportRequest) => {
        touch();
        gateMode('policyExport');
        // Packages are library versions: a seat without a commander library has none to export.
        if (!st.commander) throw new PlayerThreeError('invalid');
        return st.commander.exportPage(request);
      },
      policyImport: async (pkg: PolicyPackage) => {
        touch();
        gateMode('policyImport');
        if (!st.commander) throw new PlayerThreeError('invalid');
        const generation = st.activationGeneration;
        await st.libLoading;
        if (this.isDisposed || st.activationGeneration !== generation) throw new PlayerThreeError('forbidden');
        const { result, artifact } = await st.commander.importPackage(pkg);
        // The seat rolls back within its own history: the imported version joins it, inactive until rolled back to.
        if (!this.isDisposed && st.activationGeneration === generation) {
          st.history.push({ version: result.version, artifact, ...starterOf(artifact.source) });
          if (st.history.length > MAX_VERSIONS) st.history.shift();
          st.nextVersion = Math.max(st.nextVersion, result.version + 1);
        }
        return result;
      },
      practice: async (req: PracticeRequest) => {
        touch();
        gateMode('practice');
        return this.practice(st, rights, req);
      },
      publish: async () => {
        touch();
        gateMode('publish');
        await st.libLoading;
        if (rights.kind === 'agent' && st.mandate.autonomy === 'supervised') {
          if (!st.run) throw new PlayerThreeError('invalid');
          return this.requestApproval(st, { kind: 'publish', version: st.run.version });
        }
        return this.publish(st);
      },
      wait: async (req) => {
        touch();
        return this.wait(st, rights, req);
      },
      ready: async (): Promise<ReadyResult> => {
        touch();
        // Readiness is the agent's own declaration; owners have their game's ready (setHumanReady).
        if (rights.kind !== 'agent') throw new PlayerThreeError('forbidden');
        if (!this.prematch()) return { phase: 'match', you: { ready: true } };
        if (!st.agentReady) {
          st.agentReady = true;
          st.commander?.readied();
          this.statusChanged(st);
          this.checkReady();
        }
        return this.lobbyState(st);
      },
      skill: async (name: string, path: string, offset?: number) => {
        touch();
        return skillPage(this.skills, name, path, offset);
      },
      say: async (text, disclosure) => {
        touch();
        gateMode('say');
        return this.say(st, rights, text, disclosure);
      },
    };
    for (const method of Object.keys(control) as ControlMethod[]) {
      const invoke = control[method] as (...args: never[]) => Promise<unknown>;
      control[method] = (async (...args: never[]) => {
        // Retained seat leases may only read after the team is final. Trusted owner controls still submit intents and
        // sequences so they receive the specified per-intent `game_over` acks (SPEC §10 *Per-team terminal rule*).
        const ownerIntents = rights.kind === 'owner' && (method === 'act' || method === 'sequence');
        if (st.terminal && !ownerIntents && !['briefing', 'observe', 'wait', 'skill', 'policyStatus', 'policyExport'].includes(method)) throw new PlayerThreeError('forbidden');
        const counted = rights.kind === 'agent' && st.occupancy === occupancy;
        if (counted) {
          // Presence is derived from calls and liveness clocks, so an arrival is announced explicitly: start gates
          // (arena hosts) wait on status events, and the agent's first call is the only signal it is now ready.
          const arriving = st.calls === 0 && st.sequence === undefined && !(st.lastAgentAt > 0 && Date.now() - st.lastAgentAt < AGENT_LIVENESS_MS);
          st.calls++;
          if (arriving && !this.isDisposed && !this.halted && !this.executionReleased) this.readinessChanged(st);
        }
        try {
          return await invoke(...args);
        } finally {
          // A call that outlived its occupant (the seat was handed over meanwhile) is not the new occupant's presence.
          if (counted && st.occupancy === occupancy) {
            st.calls--;
            st.lastAgentAt = Date.now();
          }
        }
      }) as never;
    }
    return control;
  }

  // ------------------------------------------------------------------ protocol

  async handleMessage(principal: Principal, raw: unknown, push?: (msg: ServerMsg) => void): Promise<ServerMsg | undefined> {
    const msg = parseClientMessage(raw, this.roles);
    const seq = msg?.seq ?? safeSeq(raw);
    const fail = (code: ServerErrorCode): ServerMsg => ({ op: 'result', seq, ok: false, code });
    if (!msg) return fail('bad_message');
    if (this.isDisposed || principal.match !== this.id) return fail('bad_token');
    const access = this.host.principalAccess(principal);
    if (!access || !access.valid()) return fail('bad_token');
    if (principal.kind === 'spectator' || principal.kind === 'observer') return fail('forbidden');
    const pkey = principal.kind === 'seat' || principal.kind === 'human' ? `${principal.kind}:${principal.team}/${principal.role}` : `team:${principal.team}`;
    let bucket = this.msgBuckets.get(pkey);
    if (!bucket) this.msgBuckets.set(pkey, (bucket = new TokenBucket(MSG_PER_SECOND, MSG_BURST)));
    if (!bucket.take()) return fail('rate_limited');
    if (msg.op === 'tell') {
      // Owners message their own team's agents only; agents and spectators cannot send owner messages.
      if (principal.kind !== 'team' && principal.kind !== 'human') return fail('forbidden');
      if (principal.kind === 'human' && msg.roles !== 'all' && msg.roles.some((role) => role !== principal.role)) return fail('forbidden');
      try {
        this.tell(principal.team as TeamOf<M>, (principal.kind === 'human' ? [principal.role] : msg.roles) as RoleOf<M>[] | 'all', msg.text, msg.ping);
        return { op: 'result', seq, ok: true, data: null };
      } catch (e) {
        if (e instanceof PlayerThreeError) return fail(e.code);
        console.error('playerthree/host: tell failed');
        return fail('internal');
      }
    }
    if (principal.kind === 'seat' && (msg.role !== principal.role || (msg.op !== 'call' && msg.op !== 'stream'))) return fail('forbidden');
    if (principal.kind === 'human' && msg.role !== principal.role) return fail('forbidden');
    try {
      const data = await this.dispatch(principal, this.state(principal.team, msg.role), msg, push);
      return { op: 'result', seq, ok: true, data };
    } catch (e) {
      if (e instanceof PlayerThreeError) return fail(e.code);
      console.error('playerthree/host: handleMessage failed');
      return fail('internal');
    }
  }

  private async dispatch(principal: Principal, st: SeatState, msg: Exclude<ClientMsg, { op: 'tell' }>, push?: (msg: ServerMsg) => void): Promise<unknown> {
    const role = st.seat.role;
    switch (msg.op) {
      case 'call': {
        const control =
          principal.kind === 'seat'
            ? this.controlFor(principal)
            : this.control(st, { kind: 'owner', key: `${this.id}/${st.seat.team}`, ...this.host.principalAccess(principal) });
        if (!control) throw new PlayerThreeError('forbidden');
        return callMethod(control, msg.method, msg.args);
      }
      case 'stream': {
        if (!this.m.control.stream || !push) throw new PlayerThreeError('mode_unavailable');
        let subs = this.pushSubs.get(push);
        subs?.get(role)?.();
        subs?.delete(role);
        if (msg.everyTicks === 0) return { everyTicks: 0 };
        const unsubscribe = this.streamFor(st, msg.everyTicks, (data) => push({ op: 'obs', role, data }), msg.detail);
        if (!subs) this.pushSubs.set(push, (subs = new Map()));
        subs.set(role, unsubscribe);
        return { everyTicks: Math.max(msg.everyTicks, this.minStreamEvery()) };
      }
      case 'mandate':
        this.applyMandate(st, msg.mandate);
        return null;
      case 'scopes':
        this.setScopes(st.seat.team as TeamOf<M>, st.seat.role as RoleOf<M>, msg.scopes);
        return null;
      case 'controller':
        this.setController(st.seat.team as TeamOf<M>, st.seat.role as RoleOf<M>, msg.controller);
        return null;
      case 'resolveApproval':
        return this.resolveApproval(st.seat.team as TeamOf<M>, st.seat.role as RoleOf<M>, msg.id, msg.approve);
      case 'mint':
        return { role, token: this.mint(st) };
    }
  }

  release(push: (msg: ServerMsg) => void): void {
    const subs = this.pushSubs.get(push);
    if (!subs) return;
    for (const unsubscribe of subs.values()) unsubscribe();
    this.pushSubs.delete(push);
  }

  // ------------------------------------------------------------------ lifecycle

  halt(): Promise<void> {
    this.halted = true;
    this.stop();
    this.endHold();
    this.stopPauseTimer();
    // A halted match never runs again: its commanders return to the lobby now (not_in_match), not when the host
    // later releases bindings, and in-match waits wake instead of waiting for ticks that will never come.
    for (const st of this.seatsState) st.commander?.released(true);
    this.writeLog();
    for (const waiter of [...this.waiters]) this.checkWaiter(waiter, true);
    return this.chain;
  }

  releaseBindings(): Promise<void> {
    if (this.bindingRelease) return this.bindingRelease;
    if (this.isDisposed) return Promise.resolve();
    this.executionReleased = true;
    this.bindingRelease = this.halt().then(() => {
      if (this.isDisposed) return;
      this.endHold();
      this.stopPauseTimer();
      this.observers?.capture(this.tick);
      this.host.revokeMatch(this.id, true);
      for (const st of this.seatsState) {
        st.commander?.released(true);
        st.commander = undefined;
        st.sequence = undefined;
        st.streams.clear();
        st.seatTokens.clear();
        st.humanTokens.clear();
      }
      for (const waiter of [...this.waiters]) this.checkWaiter(waiter, true);
    });
    return this.bindingRelease;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.writeLog();
    this.stop();
    this.endHold();
    this.stopPauseTimer();
    this.checkpoints.length = 0;
    this.observers?.dispose();
    this.tickListeners.clear();
    this.usageListeners.clear();
    this.commentaryListeners.clear();
    this.usageSeen.clear();
    this.usageBuckets.clear();
    for (const st of this.seatsState) st.commander?.released(true);
    for (const w of [...this.waiters]) this.checkWaiter(w, true);
    this.host.revokeMatch(this.id);
    for (const team of this.teamList) this.host.revokeToken(this.tokens.teams[team] as string);
    this.host.revokeToken(this.tokens.spectator);
    for (const st of this.seatsState) {
      for (const tok of st.seatTokens) this.host.revokeToken(tok);
      st.seatTokens.clear();
      st.run?.dispose();
      st.pool?.run?.dispose();
      st.bot?.dispose?.();
      st.streams.clear();
    }
    this.pushSubs.clear();
    for (const stream of this.viewStreams.values()) stream.listeners.clear();
    this.viewStreams.clear();
    this.endListeners.clear();
    this.saidListeners.clear();
    for (const st of this.seatsState) this.statusChanged(st);
    this.statusListeners.clear();
    this.readinessListeners.clear();
    this.host.disposed(this);
    if (this.metricRecorder && this.finalMetrics === undefined) {
      try { this.finalMetrics = this.metricRecorder.finish(); } catch { console.error('playerthree/host: metric recorder failed to close'); }
    }
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  /**
   * Hand the commander log facts to the host, once: when the match is over (outcomes and ranks final), else when it
   * is halted or disposed without an outcome (the entries say `interrupted`, or `aborted` before the first tick).
   */
  private writeLog(): void {
    if (this.logged || this.retention) return;
    this.logged = true;
    const ticks = this.adapter.tick;
    const now = Date.now();
    const seats = this.seatsState.map((st): LoggedSeat => {
      const log = st.log;
      const control = log.control.map((c, i) => ({ fromTick: c.fromTick, toTick: log.control[i + 1]?.fromTick ?? ticks, controller: c.controller }));
      return {
        team: st.seat.team, role: st.seat.role, kind: st.assignment?.kind ?? st.controller, owner: st.assignment?.owner,
        occupants: log.occupants.map((o) => ({ link: o.link, fromTick: o.fromTick, toTick: o.toTick ?? ticks, left: o.toTick !== null })),
        control, ownerIntents: log.ownerIntents, ownerTells: log.ownerTells, fallbackTicks: log.fallbackTicks,
        absentPolicyTicks: log.absentPolicyTicks, acceptedIntents: log.acceptedIntents,
        pausedMs: log.pausedMs + (log.pausedSince === undefined ? 0 : now - log.pausedSince),
        switches: log.switches.map((s) => ({ ...s })),
        ...(st.run ? { policyVersion: st.run.version } : {}),
        ...(st.pool ? { poolPolicy: st.pool.entry.id } : {}),
        ...(st.controller === 'bot' || st.assignment?.kind === 'bot' ? { botLevel: st.botLevel ?? this.botLevel[st.seat.team] } : {}),
        ...(st.botOptions ? { botOptions: structuredClone(st.botOptions) } : {}),
        ...(log.botPackages.length > 0 ? { botPackages: [...log.botPackages] } : {}),
        ...(log.usage ? { usage: { ...log.usage } } : {}),
      };
    });
    if (!seats.some((seat) => seat.occupants.length > 0)) return;
    const forfeited = new Map<string, 'forfeit' | 'abandoned'>();
    for (const team of this.forfeited) forfeited.set(team, this.abandoned.has(team) ? 'abandoned' : 'forfeit');
    this.host.logMatch(this, {
      id: this.id, seed: this.seed, ticks, tickRate: this.m.tickRate, teams: this.teamList, alliances: this.sides.alliances,
      outcomes: Object.fromEntries(this.teamList.map((team) => [team, this.finals.get(team) ?? 'running'])),
      ranks: this.ranks ? { ...this.ranks } : null, over: this.ended, forfeited, declared: this.declaredEnd,
      selfPlay: this.opposedOwners, startedAt: this.createdAt, endedAt: now, facts: this.logFacts, seats,
      replayDigest: createHash('sha256').update(canonicalJson(this.replay())).digest('hex'),
    });
  }
}

/** Scoped credential lifetime in seconds: default 120, at most 600. */
function ticketTtl(opts?: { ttlSeconds?: number }): number {
  const ttl = opts?.ttlSeconds ?? 120;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 600) throw new PlayerThreeError('invalid');
  return ttl;
}

const LOG_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** Game-supplied commander-log facts: bounded labels and numbers only (`invalid` otherwise). */
function parseLogFacts(raw: MatchLogFacts): MatchLogFacts {
  const label = (v: unknown): boolean => typeof v === 'string' && LOG_LABEL.test(v);
  const nullable = (v: unknown, ok: (v: unknown) => boolean): boolean => v === undefined || v === null || ok(v);
  const count = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
  const identity = (v: unknown): boolean => typeof v === 'string' && v.length <= 128;
  if (raw === null || typeof raw !== 'object' || Object.keys(raw).some((k) => !['mode', 'queue', 'rulesHash', 'customRules', 'map'].includes(k)) ||
    raw.mode !== undefined && !label(raw.mode) || !nullable(raw.queue, label) || !nullable(raw.rulesHash, identity) ||
    raw.customRules !== undefined && typeof raw.customRules !== 'boolean') throw new PlayerThreeError('invalid');
  const map = raw.map;
  if (map !== undefined && map !== null && (typeof map !== 'object' || Object.keys(map).some((k) => !['id', 'identity', 'seed', 'size', 'layout'].includes(k)) ||
    !label(map.id) || !nullable(map.identity, identity) || !nullable(map.seed, count) || !nullable(map.size, count) || !nullable(map.layout, label))) throw new PlayerThreeError('invalid');
  return structuredClone(raw);
}

