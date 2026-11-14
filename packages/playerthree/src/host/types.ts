/**
 * PlayerThreeHost — the in-process, transport-agnostic core. A game server creates one host per game definition,
 * creates matches on it, and lets transports (Colyseus interop, MCP endpoint, custom sockets) drive it.
 */
import type {
  Approval,
  DeployResult,
  IntentAck,
  Mandate,
  MatchReceipt,
  OwnerMessage,
  PauseInfo,
  PolicyArtifact,
  PolicyError,
  PolicyErrorCode,
  PolicyImportResult,
  PolicySource,
  PracticeRequest,
  PracticeResult,
  PublishResult,
  ResumeReason,
  Scope,
  Said,
  SeatPause,
  SeatControl,
  SeatStatus,
} from '../control.ts';
import type {
  AnyManifest,
  Controller,
  DetailRequest,
  FinalOutcome,
  GameAdapter,
  IntentSource,
  MandateOf,
  GameDefinition,
  GameMetrics,
  MatchOptionsOf,
  OpponentOf,
  Outcome,
  ReportOf,
  RoleOf,
  TeamOf,
  ViewOf,
} from '../manifest.ts';
import type { ObserverFrame, ObserverGrant, ObserverMessage, Principal, ServerMsg, ViewMessage } from '../protocol.ts';
export type { ObserverFrame, ObserverGrant, ObserverMessage, ViewMessage } from '../protocol.ts';
import type { ResultRows } from '../arena.ts';
import type { SchemaErrorCode, SchemaPath } from '../schema.ts';
import type { SignalBoard } from '../signals.ts';
import type { PolicyPackage } from '../control.ts';
import type { PolicyDetail } from '../policy/types.ts';
import type { CommanderLogStore, CommanderLogVerdict, CommanderLogVerdictRow, CommanderLogEntry, ResultsSigner, StoredCommanderLogEntry } from '../commander-log.ts';
export type * from '../commander-log.ts';

/** Optional harness accounting. Provider identity and billing are declared, never host-verified. */
export interface DecisionUsage {
  decisionId: string;
  latencyMs: number;
  source: 'provider' | 'self_report';
  reporter: 'reported' | 'estimated' | 'unpriced';
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costAmount?: string | null;
  currency?: string | null;
  pricingVersion?: string | null;
  coverage: 'complete' | 'partial' | 'unknown';
}
export interface UsageEvent {
  match: string;
  team: string;
  role: string;
  tick: number;
  receivedAt: number;
  report: DecisionUsage;
}

/** Options of `createPlayerThreeHost`: the game definition, storage (directories or custom stores) and host defaults. */
export interface PlayerThreeHostOptions<M extends AnyManifest> {
  definition: GameDefinition<M>;
  /** Directory for the published-policy pool (`jsonPoolStore`). Ignored when `poolStore` is given. Omit both for in-memory. */
  poolDir?: string;
  /** Back the published-policy pool with your own storage (a database, …). */
  poolStore?: PoolStore;
  /** Max concurrent live matches. */
  maxMatches?: number;
  /**
   * Directory for the commander rosters (JSON + policy artifacts, see `jsonCommanderStore`). Ignored when
   * `commanderStore` is given. Omit both for in-memory rosters.
   */
  dataDir?: string;
  /** Back the commander rosters with your own storage (a database, …). */
  commanderStore?: CommanderStore;
  /**
   * Recent sessions kept after the host releases them (record + replay, for the operator console). Default: in
   * memory, 50 sessions / 24 h / 64 MiB of replays. `dir` or `store` keeps them across restarts; `maxSessions: 0`
   * turns the history off.
   */
  history?: SessionHistoryOptions;
  /**
   * Host default match options (manifest.matchOptions; validated at creation, throws `invalid` otherwise). Every
   * match and practice run this host creates merges its own options over them (`mergeMatchOptions`: objects field
   * by field, other values replace); the merged options are what the match records and replays.
   */
  matchOptions?: MatchOptionsOf<M>;
  /**
   * Default match teams: matches created without `teams`, and lobby practice (whose tested seat plays the first).
   * Default: every manifest team. Validated at creation (`invalid` for unknown or duplicate teams).
   */
  teams?: readonly TeamOf<M>[];
  /**
   * Commander match log (SPEC §20.10.1): one entry per match × named commander, written when the match is over or
   * released. Default store: JSONL under `dataDir` (`<dataDir>/commander-log/<game>.jsonl`), else memory.
   */
  commanderLog?: CommanderLogOptions;
}

/** What the game stamps into each new entry before it is digested and signed. */
export interface CommanderLogContext {
  /** The private commander id and its trusted owner (never written to the signed entry). */
  commanderId: string;
  ownerRef: string;
  /** The owner-declared metadata snapshot (sealed in the entry; games key rating segments on it). */
  declared: { provider?: string; model?: string; scaffoldVersion?: string };
  /** The entry so far (`seq`, `prevDigest`, `digest`, `verdict` and `sig` are placeholders). */
  entry: CommanderLogEntry;
}

/** Commander match log settings (`PlayerThreeHostOptions.commanderLog`). */
export interface CommanderLogOptions {
  store?: CommanderLogStore;
  /** Public origin of this host, recorded in every entry (`host.origin`). */
  origin?: string;
  /**
   * Ed25519 results signer. Only a configured signer makes the host official (`host.official`, signed entries); without
   * one every entry is unsigned and `official: false`.
   */
  signer?: ResultsSigner;
  /** The game's rating decision for one entry (default: unrated). A failure stamps the default and is reported. */
  verdict?(context: CommanderLogContext): CommanderLogVerdict | Promise<CommanderLogVerdict>;
}

/** Game-supplied match facts for the commander log (game vocabularies; bounded identifiers). */
export interface MatchLogFacts {
  /** e.g. `duel_1v1`, `ffa`, `lobby`, `series` (default `custom`). */
  mode?: string;
  /** The rated queue that created the match, or null (default). */
  queue?: string | null;
  rulesHash?: string | null;
  customRules?: boolean;
  map?: { id: string; identity?: string | null; seed?: number | null; size?: number | null; layout?: string | null } | null;
}

/** Read side of the commander log (operators and the game; owner views go through `CommanderRegistry.log`). */
export interface CommanderLogReader {
  /** The signing key id, or null on an unofficial host. */
  readonly keyId: string | null;
  readonly official: boolean;
  entries(commanderId: string, afterSeq?: number): Promise<StoredCommanderLogEntry[]>;
  match(matchId: string): Promise<StoredCommanderLogEntry[]>;
  all(): Promise<StoredCommanderLogEntry[]>;
  verdicts(): Promise<CommanderLogVerdictRow[]>;
  /** Append a signed verdict change (a review void) for an entry; never rewrites the entry. */
  amend(entryId: string, verdict: CommanderLogVerdict, reason: string): Promise<CommanderLogVerdictRow>;
  /** After each durable append. Returns unsubscribe. */
  onAppend(listener: (row: StoredCommanderLogEntry) => void): () => void;
  /** Resolves once queued log writes finished. */
  flush(): Promise<void>;
}

export type SeatKind = 'human' | 'agent' | 'policy' | 'bot' | 'none';
/** A trusted, game-authenticated seat assignment (`CreateMatchOptions.assignments`, `PlayerThreeMatch.assign`). */
export interface SeatAssignment {
  team: string;
  role: string;
  /** Trusted game-authenticated opaque owner; never publish this identifier. */
  owner: string;
  kind: SeatKind;
  /** Trusted game grant of human owner control/delegation; never inferred from a shared owner or agent identity. */
  ownerControl?: boolean;
  /** Owner-private named commander; required for roster-backed agent/library seats. */
  commander?: { id: string };
  policy?: { version: number } | { policyId: string };
}
/** One transport connection's claim on a credential (`claimToken`); re-checked with `authorizeLease` on every request. */
export interface AuthorizationLease {
  readonly id: string;
  readonly principal: Principal;
}
export interface SeatTicket { token: string; expiresAt: number }
/** `online`: an agent seat whose agent is present but has not marked itself ready for the pre-match seat (`ready`). */
export type ReadinessState = 'ready' | 'online' | 'waiting' | 'absent' | 'stale_policy' | 'policy_failed' | 'consent_required';
export interface ReadinessSnapshot {
  mode: 'none' | 'start';
  pending: boolean;
  deadline?: number;
  seats: { team: string; role: string; kind: SeatKind; state: ReadinessState }[];
}
export interface PublicSeatCard {
  seat: { team: string; role: string };
  kind: 'agent' | 'policy';
  aiPlayer: true;
  mode: 'live' | 'policy' | 'bot' | 'held';
  harness?: { label: string; verified: boolean };
  policy?: { source: 'library' | 'pool'; version?: number; policyId?: string };
}
export interface CommentaryEvent {
  team: string;
  role: string;
  tick: number;
  category: 'summary' | 'chat';
  text: string;
}

export interface ObserverPolicy {
  allowOmniscient: boolean;
  minDelayMs: number;
  public: boolean;
  maxBytes?: number;
  maxAgeMs?: number;
}


/** Options of `PlayerThreeHost.createMatch`. */
export interface CreateMatchOptions<M extends AnyManifest> {
  seed?: number;
  observerPolicy?: ObserverPolicy;
  /** Match options (manifest.matchOptions; validated, `invalid` otherwise), merged over the host's `matchOptions`. Omitted fields use those, then the game's defaults. */
  options?: MatchOptionsOf<M>;
  /**
   * The manifest teams taking part (any order; the match keeps manifest order). Default: the host's `teams`, else
   * every manifest team. Seats, tokens, readiness, outcomes, ranks, observer grants and the session record cover
   * exactly these teams; anything naming another team fails `invalid`. Unknown or duplicate teams fail `invalid`.
   */
  teams?: readonly TeamOf<M>[];
  /**
   * Named alliances: alliance id → member teams, partitioning the match teams (every match team in exactly one;
   * `invalid` otherwise). An id that names a manifest team must name one of its own members. Allies share their
   * outcome and rank; `end()` accepts alliance ids as keys. Default: every team on its own.
   */
  alliances?: Readonly<Record<string, readonly TeamOf<M>[]>>;
  /** Initial controller per match seat: `{ [team]: { [role]: controller } }`. Default: `bot` everywhere. Other teams fail `invalid`. */
  controllers?: Partial<Record<string, Partial<Record<string, Controller>>>>;
  /** Built-in bot strength per match team (other teams fail `invalid`). Default: the strongest-but-one opponent. */
  botLevel?: Partial<Record<string, OpponentOf<M>>>;
  /** Exact-seat built-in bot options; validated against definition.botOptions. */
  botSeats?: readonly { team: string; role: string; level: string; options: Record<string, number | boolean> }[];
  /** Drive ticks with a timer at manifest.tickRate (default true). Tests use `step()`. */
  realtime?: boolean;
  /** View push rate to transports, Hz (default = tickRate). */
  viewHz?: number;
  /** Observational recorder cadence; independent of simulation and decision cadence. */
  metricSampleEveryTicks?: number;
  /** Trusted exact-seat assignments; duplicate seats or simultaneous named-commander leases fail atomically. */
  assignments?: SeatAssignment[];
  /**
   * Hold every stepping path at tick 0 until all assigned seats are ready, up to this many seconds.
   * Humans require both trusted ready approval and an authenticated game-room join.
   */
  readySeconds?: number;
  /**
   * The game's pre-match summary of this match (manifest.lobby; `invalid` when it does not conform or the game declares
   * none): every agent seat sees it as its lobby state's `match` while the match is held before its first tick.
   */
  lobby?: unknown;
  /** Facts the commander log records for this match (`PlayerThreeHostOptions.commanderLog`). */
  log?: MatchLogFacts;
  /**
   * A persistent session: no terminal outcome (`outcome()` stays `running`, the adapter's outcome is ignored, `end()`
   * throws `invalid`; close it with `dispose()`) and no time cap. Replay retention is a rolling window: after the
   * tick advances to a multiple of `checkpointTicks` the host checkpoints the game with adapter `clone()` (required),
   * keeps the newest `checkpoints` (2–100), and drops recorded entries older than the oldest kept checkpoint
   * (`replay().window`). Scrubbing reaches every tick from there to the current tick: at least the last
   * `(checkpoints − 1) × checkpointTicks` ticks, or the whole session while it is younger.
   */
  persistent?: { checkpointTicks: number; checkpoints: number };
}

/** The match's owner tokens, minted at creation: hand each team's token only to that team's owner. */
export interface MatchTokens {
  /** One owner token per match team. */
  teams: Record<string, string>;
  spectator: string;
}

export interface SeatInfo {
  team: string;
  role: string;
  controller: Controller;
  mandate: Mandate;
  scopes: Scope[];
  /** Deployed policy version for this seat, if any. */
  policyVersion?: number;
  /** Pool policy id when controller === 'policy'. */
  poolPolicy?: string;
  /** A recent call, an in-flight call, or an active sequence keeps the agent present. */
  agentActive: boolean;
  /** True when the seat was set up from the team owner's commander roster (its agent uses the persistent commander token). */
  commander?: boolean;
  /** Present while this seat holds a pausable session still (`whenAbsent: 'pause'`, agent absent). */
  pause?: SeatPause;
}

/** Compact clock/readiness check for a match created with assignments + readySeconds. */
export interface ReadyCheck {
  /** True while the match is held at tick 0. */
  pending: boolean;
  /** Wall clock (ms since epoch) for AI fallback. Required human admission does not time out into play. */
  deadline: number;
  /** Every assigned seat; ready follows its kind's gate. */
  seats: { team: string; role: string; ready: boolean }[];
}

/** One live match (session) on a host: seats and controllers, the clock, streams, replays and the protocol entry point. */
export interface PlayerThreeMatch<M extends AnyManifest = AnyManifest> {
  readonly id: string;
  readonly tokens: MatchTokens;
  readonly tick: number;
  /** The teams taking part, in manifest order. */
  readonly teams: readonly TeamOf<M>[];
  /** Declared alliances (id → member teams), or undefined when every team is on its own. */
  readonly alliances: Readonly<Record<string, readonly TeamOf<M>[]>> | undefined;
  /**
   * Sticky: one owner has held played seats (a human hold, an agent or a policy) on two mutually hostile teams of this
   * match. It is that owner's own practice: no outcome is recorded for its commanders or pool policies, and its
   * history record carries the mark so no rating or ranking counts it.
   */
  readonly sameOwnerOpposed: boolean;
  onTick(listener: (tick: number) => void): () => void;
  metrics(): GameMetrics;
  metricRows(): Partial<ResultRows>;
  onUsage(listener: (event: UsageEvent) => void): () => void;
  onCommentary(listener: (event: CommentaryEvent) => void): () => void;
  /** The validated match options this match was created with (`undefined`: game defaults). */
  readonly options: MatchOptionsOf<M> | undefined;
  /**
   * A match team's outcome. The first final outcome the game reports for a team is kept: from then on the team is
   * out (its seats' intents fail `game_over`, its bots and policies stop, its waits return, its commanders and pool
   * policies record the outcome) while the others play on. The match is over once every team is final.
   */
  outcome(team: TeamOf<M>): Outcome;
  /**
   * A match team's final placement once the match is over (1 is best, ties share, allies share their alliance's),
   * else null: the game's `rank()`, or ranked by outcome. `invalid` for a team not in the match.
   */
  rank(team: TeamOf<M>): number | null;
  seats(): SeatInfo[];
  /** Non-consuming agent lifecycle snapshot; does not drain wait transitions or messages. */
  status(team: TeamOf<M>, role: RoleOf<M>): SeatStatus;
  /** Seat lifecycle changes, not tick-rate observations. Returns unsubscribe. */
  onStatus(listener: (team: string, role: string) => void): () => void;
  /** Readiness/card changes: every status change plus agent arrivals (presence is not part of SeatStatus). */
  onReadiness(listener: (team: string, role: string) => void): () => void;

  /** Owner-level operations (also reachable via handleMessage for remote owners). */
  setController(team: TeamOf<M>, role: RoleOf<M>, controller: Controller, opts?: { poolPolicy?: string }): void;
  setMandate(team: TeamOf<M>, role: RoleOf<M>, mandate: MandateOf<M>): void;
  setScopes(team: TeamOf<M>, role: RoleOf<M>, scopes: Scope[]): void;
  resolveApproval(team: TeamOf<M>, role: RoleOf<M>, id: string, approve: boolean): Promise<DeployResult | PublishResult | void>;
  updateCommanderSettings(team: TeamOf<M>, role: RoleOf<M>, settings: CommanderSettings): void;
  /**
   * Trusted (game-authenticated owner) re-assignment of one seat, before the start or mid-match, at the current tick
   * boundary. The previous occupant is detached first: its commander lane returns to the lobby (its waits return
   * unseated), its exact-seat and human credentials (unless the same human keeps it) stop authenticating, and its
   * plan, pending approval, inbox and seat policies end. The new occupant takes the seat now — a named commander
   * (`commander`, with the createMatch rules: compatible role and kind, one owner's agents on different teams need
   * independent sessions, a commander seated elsewhere fails `busy`) gets the seat's lease, and its agent's next
   * wait returns the match entry with its first observation. Recorded as a seat change. Same occupant: no-op.
   * `invalid` once the seat's team is out, the match is over or its bindings were released.
   */
  assign(assignment: SeatAssignment): void;
  /**
   * Describe when a held match starts, for its agents' lobby state (`startsWhen`): `host` (the game starts it), `ready`
   * (once every seat is ready, or at `at`), `countdown` (at `at`); `at` is a wall clock (ms since epoch). Undefined
   * restores the default: `ready` with the ready-check deadline, or `host` for `holdStart()`.
   */
  setLobbyStart(start: { kind: 'host' | 'ready' | 'countdown'; at?: number } | undefined): void;
  /** Mint a seat token for an agent (one seat, this match). */
  mintSeatToken(team: TeamOf<M>, role: RoleOf<M>): string;
  mintHumanToken(team: TeamOf<M>, role: RoleOf<M>, opts?: { ttlSeconds?: number }): SeatTicket;
  /**
   * Extend the seat's claimed, still-connected human credential in place: its connection stays (no rejoin, no fresh
   * keyframe). Same holder check as `mintHumanToken`; `bad_token` when nothing live is left to extend.
   */
  renewHumanToken(team: TeamOf<M>, role: RoleOf<M>, opts?: { ttlSeconds?: number }): { expiresAt: number };
  mintSpectatorToken(team: TeamOf<M>, opts?: { ttlSeconds?: number }): SeatTicket;
  mintObserverToken(grant: ObserverGrant, opts: { owner: string; ttlSeconds?: number }): SeatTicket;
  /** Released observer messages after cursor `after`: deltas in order, or one keyframe (join, resync). Shared and frozen. */
  observerMessages(principal: Principal, perspective: string, after?: number): ObserverMessage[];
  observerFrames(grant: ObserverGrant, after?: number): AsyncIterable<ObserverFrame>;
  coachingAllowed(owner: string): boolean;
  /** Release execution authority without inventing an outcome or changing replay/game state. */
  releaseBindings(): Promise<void>;
  /** Stop at a serialized tick boundary without assigning an outcome; cannot be resumed. */
  halt(): Promise<void>;
  revokeToken(token: string): void;
  revokeSeat(team: TeamOf<M>, role: RoleOf<M>): void;
  setHumanReady(team: TeamOf<M>, role: RoleOf<M>, ready: boolean): void;
  humanJoined(team: TeamOf<M>, role: RoleOf<M>, joined: boolean): void;
  cards(): PublicSeatCard[];
  readiness(): ReadinessSnapshot;
  /** In-process control plane for a seat, acting with owner rights. */
  seat(team: TeamOf<M>, role: RoleOf<M>): SeatControl;
  /**
   * Chat mode (owner): message this team's own agents (`roles` or `all`). Text ≤ maxTellChars, rate-limited per
   * team; `ping` must match manifest.control.chat.ping. Reaches only that team's seats; never policies or replays.
   */
  tell(team: TeamOf<M>, roles: readonly RoleOf<M>[] | 'all', text: string, ping?: unknown): void;
  /** Agent replies (`say`) per team — deliver them to that team's owners only. Returns unsubscribe. */
  onSaid(listener: (team: TeamOf<M>, said: Said) => void): () => void;

  /** Guarded, fogged view for a team as a fresh snapshot (includes static parts); outside the view stream. */
  view(team: TeamOf<M>): ViewOf<M>;
  /** Unfogged developer-only JSON snapshot, or null if unsupported. Never exposed by the player protocol. */
  debugView(): unknown;
  /**
   * Subscribe to a team's view stream (SPEC §4, view streams). The host computes a team's views only while its stream has
   * subscribers: a first subscriber restarts it from a fresh view, then every view tick (viewHz) that changed the view
   * adds a version and calls `listener` with it. Returns unsubscribe.
   */
  onView(team: TeamOf<M>, listener: (version: number) => void): () => void;
  /**
   * The messages that bring a reader at version `after` (undefined: a fresh reader) up to the team's latest version:
   * the missed deltas in order, or one keyframe. Shared and frozen; empty when current or not subscribed.
   */
  viewMessages(team: TeamOf<M>, after?: number): ViewMessage[];
  /** Stream mode push for a seat; `detail` widens the pushed observations (unknown section → `invalid`). Returns unsubscribe. */
  stream(team: TeamOf<M>, role: RoleOf<M>, everyTicks: number, listener: (obs: unknown) => void, detail?: DetailRequest): () => void;
  /** Fires once when the match is over, with every match team's outcome and rank. */
  onEnd(listener: (outcomes: Record<string, Outcome>, ranks: Record<string, number>) => void): () => void;
  /** Guarded after-action report for a team (manifest.report), or null if the game produced non-conforming data. */
  report(team: TeamOf<M>): ReportOf<M> | null;
  /**
   * Replay so far: seed + every intent that reached `adapter.apply` and every seat change and pause/resume, per
   * tick and seat. Persistent sessions: only the retained window (`window` is set once older entries were dropped).
   */
  replay(): Replay;
  /**
   * Persistent sessions: an isolated copy (adapter `clone()`) of the newest kept checkpoint at or before `tick`
   * (default: the oldest kept one), positioned to re-simulate this session's `replay()` window with
   * `replaySimulation(definition, replay, target, position)`. Undefined when no kept checkpoint is that old (or the
   * session is not persistent; then replay from the seed).
   */
  checkpoint(tick?: number): ReplayPosition<M> | undefined;
  /**
   * The session stands still because a seat with `whenAbsent: 'pause'` has no present agent (pausable games), or
   * undefined while it runs.
   */
  paused(): PauseInfo | undefined;

  /**
   * Transport-agnostic message handling for `protocol.ts` messages from an authenticated principal.
   * `push` is the transport's channel to that client; required for `op: 'stream'` (subscriptions are keyed by
   * `(push, role)`; `everyTicks: 0` stops). Call `release(push)` when the client leaves.
   */
  handleMessage(principal: Principal, msg: unknown, push?: (msg: ServerMsg) => void): Promise<ServerMsg | undefined>;
  /** Drop every stream subscription made through `handleMessage` with this `push`. */
  release(push: (msg: ServerMsg) => void): void;

  /** Starts the realtime loop (ends a pending ready check). */
  start(): void;
  /** Trusted tick-0 manual preparation/countdown gate. Only start()/skipReadyCheck() releases it. */
  holdStart(): void;
  /** Ready check state, or undefined if the match was created without one. */
  readyCheck(): ReadyCheck | undefined;
  /**
   * End a pending ready check now ("start anyway"); starts the realtime loop if the match was created realtime.
   * Every stepping path refuses while pending; readiness() explains the per-seat gate.
   */
  skipReadyCheck(): void;
  stop(): void;
  /** True once the session's outcome is decided (by the game, or by `end()`). Never for a persistent session. */
  readonly over: boolean;
  /** Created with `persistent`: no outcome, `end()` throws `invalid`, replay retention is a checkpoint window. */
  readonly persistent: boolean;
  /**
   * End the session now, as if the game had decided it: the clock stops, `onEnd` listeners and the `match_ended`
   * trace fire, `outcome()`/`rank()`/`replay()` report it, and blocked `wait` calls return. `'draw'`: every team draws.
   * Otherwise keys are match teams and/or alliance ids (an alliance key covers its members) and values are either all
   * outcomes (`win`/`loss`/`draw`, ranked win, draw, loss) or all placements (1 = first; the single side placed first
   * wins, sides sharing first place draw, the rest lose; a standard competition ranking counting alliances, not
   * members). Every match team must be covered, allies must agree. Already over: no-op. Returns the final outcomes.
   * Throws `invalid` for any other shape and for a persistent session (it has no outcome; `dispose()` closes it).
   */
  end(outcomes: 'draw' | Readonly<Record<string, FinalOutcome>> | Readonly<Record<string, number>>): Record<string, Outcome>;
  /**
   * One match team concedes while the others play on: records the forfeit at the current tick (replay entry and
   * `forfeit` trace) and calls the game's `forfeit` hook, which takes the team out of play. The team's outcome turns
   * final when the game reports it (the per-team terminal rule); the host then retires it as any team that is out.
   * No-op once the team forfeited, its outcome is final or the session is over. Throws `invalid` for a team outside
   * the match, a game without the hook, or a persistent session (it has no outcome).
   */
  forfeit(team: TeamOf<M>, opts?: { abandoned?: boolean }): void;
  /**
   * Advance N ticks (tests, practice, engines owning the clock). Awaits policy calls. While the session is paused
   * it refuses with `PlayerThreeError('paused')`: synchronously when paused at the call, else the promise rejects at the
   * first tick that finds the session paused (ticks before it were stepped). Check `paused()` / `onStatus`.
   */
  step(n?: number): Promise<void>;
  dispose(): void;
}

/**
 * Policy provenance is host-authored, never accepted from a deploy request. The code is the composed source (never
 * its `include` list or modules); `artifactHash` is SHA-256 hex of its module bytes (`policyArtifactHash`).
 */
export type StoredPolicyArtifact = PolicyArtifact & { surfaceHash: string; artifactHash: string };

/** Where a library version came from (spec §13.1): all null for a deploy; `parent` and the package terms for an import. */
export interface PolicyProvenance {
  /** `hash` of the package the version was imported from. */
  parent: string | null;
  /** The imported package's SPDX `license` (`NOASSERTION` included). */
  license: string | null;
  /** The imported package's `author` display name. */
  author: string | null;
}

/**
 * A commander library version as stored: the artifact plus what a policy package (spec §13.1) exports besides it.
 * Never published to the pool (`Pool.publish` keeps only the artifact and its hashes).
 */
export type StoredCommanderArtifact = StoredPolicyArtifact & {
  /** The deploy request without host composition (or the imported package's), or null when not retained. */
  source: PolicySource | null;
  /** The artifact's declared observation detail, read at its deploy probe (or the imported package's); null: none. */
  detail: PolicyDetail | null;
  provenance: PolicyProvenance;
};

/** Owner export options (`CommanderRegistry.exportPolicy`). */
export interface PolicyExportOptions {
  /** SPDX expression; default the version's imported license, else `NOASSERTION`. */
  license?: string;
  /** Display name (null: none); default the version's imported author. */
  author?: string | null;
  /** When given, the version must belong to this role. */
  role?: string;
}

/** A published pool policy without its publisher (operators see {@link PoolRecord}). */
export interface PoolEntry {
  /** `pol_<digits>` */
  id: string;
  game: string;
  role: string;
  runtime: string;
  surfaceHash: string;
  /** Results of pool matches this policy played. */
  wins: number;
  losses: number;
  draws: number;
  createdAt: number;
  /** Times the pool drafted this entry into a seat at random (`draft`). */
  drafts: number;
}

/** Who published a pool entry: an owner's commander, or a team in a session (seat/owner tokens). */
export type PoolPublisher = { kind: 'commander'; owner: string } | { kind: 'session'; session: string; team: string };

/** Operator view of a pool entry, including disabled ones. */
export interface PoolRecord extends PoolEntry {
  publisher: PoolPublisher;
  /** Disabled entries stay listed for operators but are never drafted or selectable. */
  disabled: boolean;
}

/** The host's published-policy pool. */
export interface PolicyPool {
  /** Draftable (not disabled) entries. */
  list(role?: string): PoolEntry[];
  /** Random draftable entry for a role (counted in `drafts`), or undefined. */
  draft(role: string): PoolEntry | undefined;
  /** Operator tooling: every entry with its publisher and disabled flag. */
  entries(): PoolRecord[];
  /** Operator tooling: stop (or resume) drafting an entry. Undefined for unknown ids. */
  setDisabled(id: string, disabled: boolean): PoolRecord | undefined;
  /** Operator tooling: delete an entry and its artifact. Seats already running it keep playing. False if unknown. */
  unpublish(id: string): boolean;
}

/** The in-process host of one game (`createPlayerThreeHost`): creates matches, resolves tokens and serves the bindings. */
export interface PlayerThreeHost<M extends AnyManifest = AnyManifest> {
  readonly definition: GameDefinition<M>;
  /**
   * Resolves once the commander, pool and history stores have loaded; rejects (it never hangs) if any load fails.
   * Await it before serving. Sync stores (memory, JSON files) load during `createPlayerThreeHost`.
   */
  readonly ready: Promise<void>;
  readonly pool: PolicyPool;
  /** Sessions the host released recently (operator console). */
  readonly history: SessionHistory;
  /** The host default match options (validated `PlayerThreeHostOptions.matchOptions`; undefined: the game's defaults). */
  readonly matchOptions: MatchOptionsOf<M> | undefined;
  createMatch(opts?: CreateMatchOptions<M>): PlayerThreeMatch<M>;
  getMatch(id: string): PlayerThreeMatch<M> | undefined;
  /** Resolve any token to its match + principal. Constant-time compare; undefined if unknown/expired. */
  authenticate(token: string): { match: PlayerThreeMatch<M>; principal: Principal } | undefined;
  /** Atomically consumes a match credential for exactly one transport session. */
  claimToken(token: string, connectionId: string): AuthorizationLease | undefined;
  authorizeLease(lease: AuthorizationLease): Principal | undefined;
  disconnectLease(lease: AuthorizationLease): void;
  onLeaseRevoked(listener: (lease: AuthorizationLease) => void): () => void;
  /** Seat token → control plane bound to that seat (agent rights). Used by the MCP binding. */
  seatControl(token: string): SeatControl | undefined;
  /** Seat token or commander token → agent session (agent rights). Used by the MCP binding. */
  agentSession(token: string, role?: string): AgentSession | undefined;
  /** Named commander identities; each owns an exclusive exact-seat execution lease. */
  readonly commanders: CommanderRegistry<M>;
  readonly commanderLog: CommanderLogReader;
  dispose(): void;
  /** Live (not disposed) matches. */
  matches(): PlayerThreeMatch<M>[];
  /** Developer-facing trace stream (DevTools). Returns unsubscribe. Listener errors are swallowed. */
  onTrace(listener: (event: PlayerThreeTraceEvent) => void): () => void;
  onUsage(listener: (event: UsageEvent) => void): () => void;
}

// ------------------------------------------------------------------ session history

/** Bounds and storage of the session history (`PlayerThreeHostOptions.history`). */
export interface SessionHistoryOptions {
  /** Most sessions kept (oldest dropped first). Default 50; 0 turns the history off. */
  maxSessions?: number;
  /** Sessions released longer ago than this are dropped. Default 24 h. */
  maxAgeMs?: number;
  /** Total replay bytes kept (serialized JSON). A replay larger than this on its own is not kept (the record is). Default 64 MiB. */
  maxBytes?: number;
  /**
   * Directory for the history (`jsonHistoryStore`: one `<session>.json` per session, record + replay, written
   * atomically). Survives restarts. Ignored when `store` is given. Omit both for in-memory. Use one directory per game.
   */
  dir?: string;
  /** Back the history with your own storage (a database, …). Wins over `dir`. */
  store?: HistoryStore;
}

/** One seat as it was when the session was released. */
export interface SessionSeatRecord {
  team: string;
  role: string;
  controller: Controller;
  /** Trusted owner assigned to this exact seat, or null for an unassigned seat. */
  owner: string | null;
  /** Set up from the owner's commander roster. */
  commander: boolean;
  policyVersion?: number;
  poolPolicy?: string;
  /** Who held the seat as an agent, as reported by the transport (`annotate`), e.g. a sign-in client's name. */
  harnesses: string[];
}

/** A released session as the history keeps it. */
export interface SessionRecord {
  id: string;
  game: string;
  gameVersion: string;
  seed: number;
  /** Validated match options (null: game defaults). */
  options: unknown;
  /** Wall clock, ms since epoch. */
  createdAt: number;
  /** When the outcome was decided, or null (released while running). */
  endedAt: number | null;
  releasedAt: number;
  ticks: number;
  /** Game time (ticks / tickRate). */
  seconds: number;
  /** The match teams (manifest order) and declared alliances (null: every team on its own). */
  teams: string[];
  alliances: Record<string, string[]> | null;
  /** Per match team. */
  outcomes: Record<string, Outcome>;
  /** Final placement per match team, or null (released while running). */
  ranks: Record<string, number> | null;
  /** `{ [team/role]: owner }` for exact assigned seats. */
  owners: Record<string, string>;
  /** `PlayerThreeMatch.sameOwnerOpposed` at release: the owner's own practice, never rated or ranked. */
  sameOwnerOpposed: boolean;
  seats: SessionSeatRecord[];
  /** Rejected agent/policy/stream intents over the session. */
  rejections: number;
  policyErrors: number;
  /** Codes by count (top 16 each): rejected agent inputs, and policy errors (`timeout`, `threw`, `deploy:<code>`, …). */
  codes: { rejections: { code: string; count: number }[]; policyErrors: { code: string; count: number }[] };
  /** Serialized replay size. */
  replayBytes: number;
  /** False when the replay exceeded `maxBytes` on its own and only the record was kept. */
  replay: boolean;
  /** First tick the replay covers: 0, or the start of a persistent session's rolling window (`Replay.window.from`). */
  from: number;
}

/** Released sessions, newest first. Read-only for everything but the host and transports. */
export interface SessionHistory {
  /** Effective bounds; `dir` is the `jsonHistoryStore` directory from `dir`, else null (memory or a custom `store`). `maxSessions` 0: off. */
  readonly limits: { maxSessions: number; maxAgeMs: number; maxBytes: number; dir: string | null };
  list(): SessionRecord[];
  get(id: string): SessionRecord | undefined;
  /** The session's replay, or undefined (unknown, pruned, or too large to keep). */
  replay(id: string): Promise<Replay | undefined>;
  /**
   * Transports report who holds a seat of a session the host still holds (e.g. the MCP sign-in client's name, or
   * "seat token"); recorded with the seat on release. At most 4 labels per seat, 80 characters each.
   */
  annotate(session: string, team: string, role: string, harness: string): void;
  /** Called after each new record. Returns unsubscribe. */
  onRecord(listener: (record: SessionRecord) => void): () => void;
  /** Resolves once pending store writes and deletions are done. */
  flush(): Promise<void>;
}

/**
 * One recorded entry at `tick`, in recording order: an intent that reached `adapter.apply` or a `setSeatInfo` push
 * (controller/mandate change), both applied before `step()` of `tick`; a seat starting/stopping to hold a pausable
 * session still (`pause`/`resume`: no effect on the simulation, which does not step while paused); or a team's
 * forfeit (`PlayerThreeMatch.forfeit`, applied through `adapter.forfeit` before `step()` of `tick`). A forfeit is team-level:
 * its role is always the manifest's first role. A `signal` entry is an accepted `signal` / `signal_update` intent (games
 * declaring signals): it changes the team's signal board, never the simulation.
 * Owner intent entries always carry a seventh field, the verified owner-role scope (the seat's team roles its owner holds
 * as a human, else only the seat's role); every other intent source records exactly six fields.
 */
export type ReplayEntry =
  | [tick: number, team: string, role: string, op: 'intent', intent: unknown, source: Exclude<IntentSource, 'owner'>]
  | [tick: number, team: string, role: string, op: 'intent', intent: unknown, source: 'owner', ownerRoles: readonly string[]]
  | [tick: number, team: string, role: string, op: 'seat', controller: Controller, mandate: Mandate]
  | [tick: number, team: string, role: string, op: 'pause', reason: SeatPause['reason']]
  | [tick: number, team: string, role: string, op: 'resume', reason: ResumeReason]
  | [tick: number, team: string, role: string, op: 'forfeit']
  | [tick: number, team: string, role: string, op: 'signal', intent: unknown];

/**
 * A re-simulation position: inputs before `entryIndex` have already been applied to this isolated adapter.
 * `entryIndex` is absolute: it counts entries a persistent session's replay window dropped (`Replay.window.dropped`).
 */
export interface ReplayPosition<M extends AnyManifest> {
  adapter: GameAdapter<M>;
  entryIndex: number;
  /** The team signal boards at this position: required for games declaring signals. */
  signals?: SignalBoard;
}

/** Deterministic replay file. Re-simulate with `replayMatch(definition, replay)`. */
export interface Replay {
  format: 'playerthree.replay';
  version: 2;
  game: string;
  gameVersion: string;
  seed: number;
  /** Match options the match was created with (absent: game defaults). */
  options?: unknown;
  /** Final tick recorded. */
  ticks: number;
  /** The match teams (manifest order) and declared alliances (absent: every team on its own); the game is created with them. */
  teams: string[];
  alliances?: Record<string, string[]>;
  entries: ReplayEntry[];
  /** Per match team, as of `ticks`. */
  outcomes: Record<string, Outcome>;
  /** Final placement per match team, once the match is over. */
  ranks?: Record<string, number>;
  /**
   * Persistent sessions after retention dropped older entries: the window starts at checkpoint tick `from`, and
   * `dropped` entries were recorded before `entries[0]` (entry indices in replay positions count them). Such a replay
   * re-simulates only from that session's checkpoint (`PlayerThreeMatch.checkpoint()`), never from the seed.
   */
  window?: { from: number; dropped: number };
}

/** Who produced an intent / received an observation. */
export type TraceSource = 'owner' | 'agent' | 'policy' | 'bot' | 'stream';

export type GuardChannel = 'view' | 'observation' | 'matchData' | 'event' | 'report' | 'game_error' | 'lobby';

interface TraceBase {
  /** Wall clock, ms since epoch. */
  at: number;
  match: string;
  tick: number;
}
interface SeatTrace extends TraceBase {
  team: string;
  role: string;
}

/**
 * Developer-facing trace events (DevTools). Contains only closed-vocabulary game data and own-authored policy text;
 * logs of pool policies (authored by other players) are never included.
 */
export type PlayerThreeTraceEvent =
  | (TraceBase & { type: 'match_created'; seats: SeatInfo[] })
  | (TraceBase & { type: 'match_ended'; outcomes: Record<string, Outcome>; ranks: Record<string, number> })
  /** A match team forfeited (`PlayerThreeMatch.forfeit`); its final outcome follows when the game reports it. */
  | (TraceBase & { type: 'forfeit'; team: string })
  | (SeatTrace & { type: 'controller'; controller: Controller; previous: Controller; poolPolicy?: string })
  | (SeatTrace & { type: 'mandate'; mandate: Mandate })
  /** A seat started holding a pausable session still. */
  | (SeatTrace & { type: 'pause'; reason: SeatPause['reason'] })
  /** A seat stopped holding it; the session runs again once no seat holds it. */
  | (SeatTrace & { type: 'resume'; reason: ResumeReason })
  /** A guarded observation that was actually delivered. */
  | (SeatTrace & { type: 'observe'; source: TraceSource; data: unknown; bytes: number })
  /** `intent` is present only when it passed schema validation. */
  | (SeatTrace & { type: 'intent'; source: TraceSource; intent?: unknown; ack: IntentAck })
  | (SeatTrace & { type: 'policy_deploy'; ok: boolean; rollback: boolean; version?: number; error?: PolicyError })
  | (SeatTrace & {
      type: 'policy_call';
      version: number;
      /** True when a drafted pool policy ran (its logs are withheld). */
      pool: boolean;
      ms: number;
      intents: number;
      rejected: number;
      logs: string[];
      error?: PolicyErrorCode;
    })
  | (SeatTrace & { type: 'practice'; opponent: string; allies: string; ticks: number; seed: number; result: PracticeResult })
  | (TraceBase & { type: 'guard_drop'; channel: GuardChannel; code: SchemaErrorCode; path: SchemaPath; team?: string; role?: string });

// ------------------------------------------------------------------ commanders
export interface CommanderIdentity {
  id: string;
  name: string;
  kind: 'agent' | 'policy';
  roles: string[];
  /** Harness declaration, not externally verified isolation. Execution leases are exclusive. */
  isolation: { independentSessions: boolean };
  metadata?: { provider?: string; model?: string; scaffoldVersion?: string };
}
export type CreateCommander = Omit<CommanderIdentity, 'id'>;


export interface CommanderSettings {
  scopes: Scope[];
  mandate: Mandate;
  /** Built-in bot level (one of manifest.opponents) when the seat falls back to a bot. */
  botLevel: string;
}

export interface CommanderSettingsPatch {
  botLevel?: string;
  scopes?: Scope[];
  mandate?: Partial<Mandate>;
}

export interface CommanderPolicyVersion {
  version: number;
  /** null: legacy multi-role artifact without trustworthy role provenance; redeploy for the intended role. */
  role: string | null;
  runtime: string;
  surfaceHash: string;
  /** ms since epoch */
  createdAt: number;
  /** Module size: UTF-8 bytes of JS source, decoded bytes of a WASM module (0 if its artifact was missing on load). */
  bytes: number;
  /** SHA-256 hex of the module bytes (`policyArtifactHash`), computed at deploy. */
  artifactHash: string;
  /** The starter the version was deployed from (spec §11 *Starters*); absent for any other source. */
  from?: string;
  /** The knobs it was deployed with, when `from` and knobs were given. */
  knobs?: Record<string, unknown>;
}

/** Closed-vocabulary summary of the last practice run (UI or agent). */
export interface CommanderPractice {
  at: number;
  role: string;
  opponent: string;
  allies: string;
  ticks: number;
  seed: number;
  version: number;
  outcome: Extract<PracticeResult, { ok: true }>['outcome'];
  /** Guarded game report (manifest.report) from the last successful practice run. */
  report: unknown;
}

export interface CommanderStatus extends CommanderSettings, CommanderIdentity {
  policy: { activeByRole: Record<string, number | null>; versions: CommanderPolicyVersion[] };
  /** Decided, non-practice matches from the commander log (D11: derived, never stored on the commander). */
  record: { wins: number; losses: number; draws: number };
  lastPractice: CommanderPractice | null;
  approvals: { role: string; approval: Approval }[];
  /** An agent with this commander's token made a call in the last 30 s, or is blocked in game_wait. */
  connected: boolean;
  lastSeenAt: number | null;
  /** The live match currently seating this commander. */
  seated: { match: string; team: string; roles: string[] } | null;
  /** Lobby reservations of this commander's role lanes (`reserve`) and whether its agent marked each ready. */
  reservations: { team: string; role: string; ready: boolean }[];
}

/** Owner-side practice request (the commander's active library policy plays). */
export type CommanderPracticeRequest = Omit<PracticeRequest, 'artifact'> & { role: string };

/**
 * Persistent commander rosters. All methods take an owner id the game has already authenticated.
 * Unknown owners/commander IDs and invalid settings throw `PlayerThreeError('invalid')`.
 */
export interface CommanderRegistry<M extends AnyManifest = AnyManifest> {
  /** Resolves once the store has loaded; commander tokens do not authenticate before that. */
  readonly ready: Promise<void>;
  /** Finish queued artifact, role-library and terminal-receipt writes before closing persistent storage. */
  flush(): Promise<void>;
  /** Create an empty owner registry if missing. */
  ensure(owner: string): CommanderStatus[];
  create(owner: string, input: CreateCommander): CommanderStatus;
  rename(owner: string, id: string, input: CreateCommander): CommanderStatus;
  delete(owner: string, id: string): Promise<void>;
  has(owner: string): boolean;
  /** Every owner with a roster, sorted. For operator tooling; players only ever see their own roster. */
  owners(): string[];
  roster(owner: string): CommanderStatus[];
  update(owner: string, id: string, patch: CommanderSettingsPatch): CommanderStatus;
  token(owner: string, id: string): string;
  rotate(owner: string, id: string): string;
  practice(owner: string, id: string, req: CommanderPracticeRequest): Promise<PracticeResult>;
  rollback(owner: string, id: string, role: string, version: number): Promise<DeployResult>;
  /**
   * One library version as a `playerthree.policy/1` package (spec §13.1), exported now: no prompts, logs, owner or
   * commander ids. Unknown version (or not of `opts.role`), or a bad `license`/`author` → `invalid`.
   */
  exportPolicy(owner: string, id: string, version: number, opts?: PolicyExportOptions): Promise<PolicyPackage>;
  /**
   * Add a package as a new, inactive library version of `opts.role` (default: the first of the commander's roles the
   * package drives), after the spec §13.1 checks; activate it with `rollback`. Any failure → `invalid`, no echo.
   */
  importPolicy(owner: string, id: string, pkg: unknown, opts?: { role?: string }): Promise<PolicyImportResult>;
  resolveApproval(owner: string, id: string, approvalId: string, approve: boolean): Promise<DeployResult | PublishResult | void>;
  /** Delete an owner's roster, tokens and library. */
  remove(owner: string): Promise<void>;
  /** The owner's full log of one commander (entries and their sealed parts), oldest first. */
  log(owner: string, id: string): Promise<StoredCommanderLogEntry[]>;
  /** The commander's public id (`commanderPublicId`). */
  publicId(owner: string, id: string): string;
  /**
   * Chat mode: message the owner's own commanders (in the lobby or in their live match). Text ≤ maxTellChars,
   * rate-limited per owner; `ping` must match manifest.control.chat.ping.
   */
  tell(owner: string, commanderIds: readonly string[] | 'all', text: string, ping?: unknown): void;
  /** Recent owner ↔ commander chat of an owner (memory only), oldest first. Agent text: render as plain text. */
  chat(owner: string): ChatEntry[];
  /** Agent replies of any owner's commanders (lobby and matches). Returns unsubscribe. */
  onSaid(listener: (owner: string, said: CommanderSaid) => void): () => void;
  /**
   * Commander lifecycle or credential changes. `role` is the one execution lane that changed, or null when the
   * whole commander did. Returns unsubscribe; no text or credentials.
   */
  onStatus(listener: (owner: string, commanderId: string, role: string | null) => void): () => void;
  /**
   * Agent-rights access to an owner's commander for a credential the registry does not issue (the MCP binding's
   * OAuth connections): it stays usable while `valid()` holds. Undefined for unknown owners/roles.
   */
  agent(owner: string, id: string, valid: () => boolean, role?: RoleOf<M>): CommanderAgent | undefined;
  /**
   * A game lobby reserves one role lane of this commander for a seat of the next match (null clears it): until a match
   * seats it, its agent's lobby state shows the seat, the game's pre-match summary (`match`, manifest.lobby) and when
   * the match starts (`start.at`: wall clock, ms since epoch), and the agent can mark itself ready (carried into the
   * match that seats it there). A different seat, or clearing, resets ready and wakes the lane's lobby waits. The
   * reservation ends when the lane's match ends; it never seats anything by itself.
   */
  reserve(owner: string, id: string, role: RoleOf<M>, reservation: LobbyReservation | null): void;
}
export interface CommanderSaid extends Said {
  commanderId: string;
}


export interface ChatEntry {
  /** ms since epoch */
  at: number;
  from: 'owner' | 'agent';
  /** Owner messages: the recipients. Agent replies: the speaker. */
  commanderIds: string[];
  /** Match tick (0 in the lobby). */
  tick: number;
  text: string;
  ping?: unknown;
}

/** A game lobby's reservation of one commander role lane (`CommanderRegistry.reserve`). */
export interface LobbyReservation {
  /** A manifest team: the reserved seat is `{team, role}`. */
  team: string;
  /** The game's pre-match summary (manifest.lobby; `invalid` when it does not conform or the game declares none). */
  match?: unknown;
  /** When the match starts: `host` (the lobby's host starts it), `ready` (once every seat is ready, or at `at`), `countdown` (at `at`). */
  start: { kind: 'host' | 'ready' | 'countdown'; at?: number };
}

/** Agent-rights access to one commander that is not bound to its commander token (e.g. an OAuth connection). */
export interface CommanderAgent {
  /** Routes like the commander token (lobby or live seat) while `valid()` holds, else every call is `bad_token`. */
  control: SeatControl;
  reportUsage(report: DecisionUsage): void;
  status(): SeatStatus;
  /** Recent calls, in-flight work, or a running sequence keep this commander active. */
  active(): boolean;
  /** Read (and clear) unread owner messages (chat mode), in the lobby or the live seat. */
  drain(): OwnerMessage[];
  /** The live match seating the commander, or null (lobby). */
  seat(): { match: string; team: string; role: string } | null;
}

/** An authenticated agent: a per-match seat token, or a persistent commander token. */
export type AgentSession =
  | {
      kind: 'seat';
      control: SeatControl;
      reportUsage(report: DecisionUsage): void;
      match: PlayerThreeMatch;
      team: string;
      role: string;
      /** Read (and clear) unread owner messages (chat mode). */
      drain(): OwnerMessage[];
    }
  | {
      kind: 'commander';
      /** Routes to the seat while a match seats the commander, else lobby semantics. */
      control: SeatControl;
      reportUsage(report: DecisionUsage): void;
      status(): SeatStatus;
      owner: string;
      commanderId: string;
      role: string;
      /** Stable per (owner, commander ID, token generation): per-token consent and rate limits. */
      key: string;
      /** Read (and clear) unread owner messages (chat mode), in the lobby or the live seat. */
      drain(): OwnerMessage[];
      /** The live match seating the commander, or null (lobby). */
      seat(): { match: string; team: string; role: string } | null;
    };

// ------------------------------------------------------------------ commander storage

export interface StoredCommander extends CommanderSettings, CommanderIdentity {
  /** Token generation; bumped by rotate. */
  gen: number;
  versions: CommanderPolicyVersion[];
  nextVersion: number;
  activeByRole: Record<string, number | null>;
  /** One bounded receipt and one crash-recovery assignment marker per role. */
  results: Record<string, MatchReceipt>;
  pendingMatches: Record<string, { match: string; team: string; role: string; at: number }>;
  lastPractice: CommanderPractice | null;
  lastSeenAt: number | null;
}

export interface StoredOwner {
  owner: string;
  createdAt: number;
  commanders: StoredCommander[];
}

export interface CommanderStoreData {
  /**
   * base64url host key that commander tokens are derived from (HMAC). Whoever holds the store can derive every
   * token: protect it like the tokens themselves. null on first start (the host generates and saves one).
   */
  key: string | null;
  owners: StoredOwner[];
}

/**
 * Storage behind the commander registry. Every method may be sync or async; writes are issued in order and
 * failures are reported to the host's console (the in-memory state stays authoritative for the process).
 */
export interface CommanderStore {
  load(): CommanderStoreData | Promise<CommanderStoreData>;
  saveKey(key: string): void | Promise<void>;
  /** Upsert one owner's full record. */
  saveOwner(record: StoredOwner): void | Promise<void>;
  deleteOwner(owner: string): void | Promise<void>;
  saveArtifact(owner: string, commanderId: string, version: number, artifact: StoredCommanderArtifact): void | Promise<void>;
  /** Artifacts stored without source, detail or provenance load with null for each. */
  loadArtifact(owner: string, commanderId: string, version: number): StoredCommanderArtifact | undefined | Promise<StoredCommanderArtifact | undefined>;
  deleteArtifact(owner: string, commanderId: string, version: number): void | Promise<void>;
}

// ------------------------------------------------------------------ pool storage

/** A pool entry as stored: the public entry plus its publisher and disabled flag (operators only). */
export interface StoredPoolEntry extends PoolEntry {
  /** Publishing principal (`commander:<owner>` or `<session>/<team>`), for per-principal limits. */
  owner: string;
  disabled?: boolean;
}

export interface PoolStoreData {
  entries: StoredPoolEntry[];
}

/**
 * Storage behind the published-policy pool. Every method may be sync or async; writes are issued in order (an
 * entry's artifact before the entry) and failures are reported to the host's console (the in-memory state stays
 * authoritative for the process). Entries of other games in `load()` are ignored.
 */
export interface PoolStore {
  load(): PoolStoreData | Promise<PoolStoreData>;
  /** Upsert one entry (counters, disabled flag). */
  saveEntry(entry: StoredPoolEntry): void | Promise<void>;
  /** Delete an entry and its artifact. */
  deleteEntry(id: string): void | Promise<void>;
  saveArtifact(id: string, artifact: StoredPolicyArtifact): void | Promise<void>;
  loadArtifact(id: string): StoredPolicyArtifact | undefined | Promise<StoredPolicyArtifact | undefined>;
}

// ------------------------------------------------------------------ history storage

/**
 * Storage behind the session history. Every method may be sync or async; writes are issued in order and failures are
 * reported to the host's console. Records of other games in `load()` are ignored; the host prunes the loaded records
 * with its bounds (deleting from the store).
 */
export interface HistoryStore {
  /** Every kept record. `record.replay` is true only when the replay is actually stored. */
  load(): SessionRecord[] | Promise<SessionRecord[]>;
  /** Upsert a released session: its record and its replay as serialized JSON (`Replay`), or null when not kept. */
  save(record: SessionRecord, replay: string | null): void | Promise<void>;
  delete(id: string): void | Promise<void>;
  loadReplay(id: string): Replay | undefined | Promise<Replay | undefined>;
}
