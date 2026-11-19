/**
 * PlayerThree Control Plane v1 — the game-agnostic operations an agent can perform on a seat.
 *
 * One contract, several bindings:
 *   - in-process (built-in bots, practice, tests)
 *   - WebSocket (`protocol.ts`: `call` / `result`, plus the `stream` push for tick-rate control)
 *   - MCP (remote Streamable HTTP endpoint or local stdio bridge): one tool per method below
 *
 * Trust rule for every output: game data is closed-vocabulary (schema-validated before it leaves the server).
 * Free text is limited to the seat's own owner's messages and its own policy's log lines and engine errors.
 * Owner messages carry the closed `from: 'owner'` label. Developer docs (briefing, skills) are static.
 */
import type { AnyManifest, DetailRequest, PolicyRuntime } from './manifest.ts';
import type { POLICY_PACKAGE_FORMAT } from './manifest.ts';
import type { SchemaErrorCode, SchemaPath } from './schema.ts';
import type { SeatSignals, SignalCode } from './signals.ts';

/**
 * Where a session is. `lobby`: before the match a seat is in starts — nothing seats the agent yet (commander tokens
 * between matches), a game lobby reserved a seat for the next match, or the agent's match is held before its first
 * tick (ready check, preparation, countdown). `match`: the match is running (or just ended for this seat).
 */
export type SessionPhase = 'lobby' | 'match';

/**
 * When a pre-match seat's match starts. `seat`: nothing seats the agent yet; `host`: the lobby's host (or the game)
 * starts it; `ready`: once every seat is ready, or at the ready deadline; `countdown`: the start countdown runs.
 * `inSeconds`: wall-clock seconds left until the deadline or the countdown's end, when known.
 */
export interface LobbyStart {
  kind: 'seat' | 'host' | 'ready' | 'countdown';
  inSeconds?: number;
}

/**
 * The pre-match state of an agent (phase `lobby`): what `wait`, `observe` and `ready` report before the match starts.
 * `seat` is the reserved or held seat (null while nothing seats the agent), `match` the game's guarded pre-match
 * summary (manifest.lobby; absent when the game declares none or nothing seats the agent), `you.ready` whether the
 * agent marked itself ready for this seat, and `instruction` the next step (static host text).
 */
export interface LobbyState {
  phase: 'lobby';
  seat: { team: string; role: string } | null;
  match?: unknown;
  you: { ready: boolean };
  startsWhen: LobbyStart;
  instruction: string;
  previousMatch?: MatchReceipt;
}

/** Static next-step texts of the lobby state. */
export const LOBBY_INSTRUCTIONS = {
  unseated: 'No match seats you yet. Prepare (game_briefing, skills, policies), then call game_wait {seconds:60,role}; it returns when a lobby seats that role. Use roles from game_briefing.commands; monitor each commanded role.',
  seated: 'This role is seated for the next match. Read game_briefing {role}, then game_ready {role} when prepared for this seat. Ready each commanded seated role separately, then game_wait {seconds:60,role} for each until phase is "match".',
  ready: 'This seat is ready, not necessarily the whole lobby. Prepare and ready any other commanded seats, then keep game_wait {seconds:60,role} running for each commanded role until phase is "match". Other participants or the host may still need to start; startsWhen describes the start condition.',
  /**
   * Instead of the above for a commander lane whose role may deploy (policy mode and policy scope) but has no active
   * policy and no pending approval: none of the agent's code would play that role, absent only a fallback bot would.
   */
  noPolicy: 'No policy is active for this role, so none of your code plays it (while you are away only a fallback bot, or nothing, does). Deploy one first: a starter, where the game has them, is one call, policy_deploy {from,role} (topic `starters`); supervised seats propose it for owner approval. Then game_ready {role} once seated and game_wait {seconds:60,role} as usual.',
} as const;

/** Static next-step text of the first result in a match (a held match started, or a seat handed over mid-match). */
export const MATCH_INSTRUCTION = 'The match is running and you command this seat: read game_briefing for it, then play from this observation.';

/** The result of marking a seat ready: the lobby state, or `match` once the match runs (ready is then implied). */
export type ReadyResult = LobbyState | { phase: 'match'; you: { ready: true } };

/** Agent permission scopes an owner grants per seat (SPEC §6). */
export const SCOPES = ['act', 'policy', 'practice', 'publish', 'say'] as const;
export type Scope = (typeof SCOPES)[number];

/** Owner intent for a seat; directive and limits follow the game's schemas. */
export interface Mandate {
  autonomy: 'autonomous' | 'supervised';
  directive: unknown;
  limits?: unknown;
  /** `pause` is valid only when the game declares `control.pausable`. */
  whenAbsent: 'policy' | 'bot' | 'hold' | 'pause';
}

/**
 * One seat holding a pausable session still: controller `agent`, mandate `whenAbsent: 'pause'`, agent absent.
 * `reason` is a closed code (`agent_absent` is the only reason).
 */
export interface SeatPause {
  reason: 'agent_absent';
  /** Tick at which this seat began holding the session (the session does not advance while paused). */
  tick: number;
  /** Wall clock (ms since epoch) when it began. */
  since: number;
  /** Wall clock when this seat stops holding and falls back to its policy or bot (`control.pausable.maxPauseSeconds`). */
  until?: number;
}

/** A paused session: who holds it (every seat listed), and since when it has stood still. */
export interface PauseInfo {
  /** Tick the session stands at. */
  tick: number;
  /** Wall clock (ms since epoch) when the session paused. */
  since: number;
  seats: ({ team: string; role: string } & SeatPause)[];
}

/** Why a seat stopped holding a paused session: its agent is present again, the owner changed the seat, or max pause ran out. */
export type ResumeReason = 'present' | 'owner' | 'timeout';

export interface Approval {
  id: string;
  kind: 'policyDeploy' | 'policyRollback' | 'publish';
  /** Proposed policy version (the version being published for publish). */
  version: number;
  status: 'pending' | 'approved' | 'rejected' | 'failed';
}
export type ApprovalRequest = Pick<Approval, 'id' | 'kind' | 'version'>;

/**
 * The core briefing: small enough to read first (doc ≤ DOC_MAX, role doc ≤ ROLE_DOC_MAX, one-line topic index).
 * Everything else (intent details, observation fields, match data, events, report, mandate, modes, policy ABI, JSON
 * Schemas, game topics) is fetched on demand with `briefing(topic, page?)`.
 */
export interface Briefing {
  controlPlane: number;
  /** `lobby`: commander token between matches (no team yet; game_observe/game_act answer `not_in_match`). */
  phase: SessionPhase;
  game: { id: string; version: string; title: string; doc: string; tickRate: number };
  /** `team` is absent in the lobby. */
  seat: { team?: string; role: string; roleDoc: string };
  /**
   * Games declaring `observationScope`: the sections this role's observation renders in full by default and those it
   * only summarises; observe's `detail` (or a policy's declared `detail`) adds sections.
   */
  observationScope?: { full: string[]; summary: string[] };
  /** In a match: the teams taking part (manifest order). In the lobby: every team the game declares. */
  teams: string[];
  /** In a match that declares alliances: alliance id → member teams. Absent: every team is on its own. */
  alliances?: Record<string, string[]>;
  roles: string[];
  scopes: Scope[];
  mandate: Mandate;
  /** Intent kinds this seat's role may send (details: topics `intents` and `intent/<kind>`). */
  intents: string[];
  /** Topic index, one `name — summary` line each: game topics, then generated families (e.g. `intent/<kind> — …`). */
  topics: string[];
  /** Every served skill; read files with `skill(name, path)` (each skill's SKILL.md lists its files). */
  skills: { name: string; description: string }[];
  /** sha256 over the canonical tool surface + manifest. Pin it to detect any change. */
  surfaceHash: string;
}

/** One page of a briefing topic. `text` ≤ TOPIC_TEXT_MAX; `next` names the following page while there is one. */
export interface TopicPage {
  topic: string;
  /** 1-based. */
  page: number;
  pages: number;
  text: string;
  next?: { topic: string; page: number };
}

/** A window of one skill file: `text` ≤ SKILL_PAGE_MAX, cut after a newline; `next` is the offset to continue at. */
export interface SkillPage {
  name: string;
  path: string;
  /** UTF-16 offset of `text` in the file. */
  offset: number;
  /** File length (UTF-16 code units). */
  total: number;
  text: string;
  next?: number;
}

/**
 * Why an intent failed its schema: closed `schemaCode`, the developer-field `path`, and `expected` — what the schema
 * wanted there in the vocabulary of the generated declarations (`expectedAt`, ≤ EXPECTED_MAX), never the input.
 */
export interface InvalidIntent {
  schemaCode: SchemaErrorCode;
  path: SchemaPath;
  expected: string;
}

/** Result of one intent. Never echoes input. */
export type IntentAck =
  | { ok: true }
  | ({ ok: false; code: 'invalid' } & InvalidIntent)
  | { ok: false; code: 'forbidden_role' | 'rate_limited' | 'not_controller' | 'game_over' | 'out_of_scope' }
  | { ok: false; code: 'game'; gameCode: string }
  | { ok: false; code: 'signal'; signalCode: SignalCode };

export interface SequenceRequest {
  steps: { in: number; intents: unknown[] }[];
  cancelOn?: string[];
}

export type SequenceResult =
  | { ok: true; id: string; acks: IntentAck[][] }
  | { ok: false; code: 'invalid' | 'out_of_scope' | 'not_controller' | 'game_over'; acks: IntentAck[][] };

/** A policy as the host probes, stores, versions, publishes and hashes it: one composed module. */
export interface PolicyArtifact {
  runtime: PolicyRuntime;
  /** `js`: source text (classic script). `wasm`: base64 of a core WebAssembly module. */
  code: string;
}

/**
 * A deploy by reference to one of the game's starters (spec §11 *Starters*): `from` names the starter
 * (`"<skill>/<path>.js"`), `knobs` the values its `knobs` schema accepts (omitted: `createPolicy(null)`).
 */
export interface StarterRef {
  from: string;
  knobs?: Record<string, unknown>;
}

/**
 * A policy as a caller submits it (`policy_deploy`, `practice_run.artifact`): `code`, (js only) ES `modules` the
 * host bundles from `entry` (spec §11), or (js only) a starter reference. `include` (js only, not with `from`):
 * served skill `.js` files (`"<skill>/<path>"`, ≤ MAX_POLICY_INCLUDES) prepended to the code or bundle (see
 * `composePolicy`). The host turns it into a `PolicyArtifact`; the commander library also retains it as the version's
 * package `source` (spec §13.1), a starter reference always with `runtime: 'js'`.
 */
export type PolicySource =
  | ({ runtime: PolicyRuntime; include?: string[] } & (
    | { code: string }
    /** Module source by path (skill file-key grammar, `.js`/`.mjs`/`.ts`/`.mts`); `entry` is one of the paths. */
    | { modules: Record<string, string>; entry: string }
  ))
  | ({ runtime?: 'js'; include?: never } & StarterRef);

/** `source`: the artifact exactly as deployed, without `runtime` (that is the package's own `runtime`). */
export type PolicyPackageSource =
  | ({ include?: string[] } & ({ code: string } | { modules: Record<string, string>; entry: string }))
  | ({ include?: never } & StarterRef);

export interface PolicyPackage {
  format: typeof POLICY_PACKAGE_FORMAT;
  game: { id: string; version: string };
  /** The host surface the version was deployed or imported against. */
  surfaceHash: string;
  /** The manifest roles the version drives. */
  roles: string[];
  runtime: PolicyRuntime;
  /** Declared observation detail: `'all'`, declared section names, or null when undeclared. */
  detail: 'all' | string[] | null;
  /** Null when the exporting host did not retain the deployed source. */
  source: PolicyPackageSource | null;
  /** The composed artifact: JS source, or base64 WASM. */
  script: string;
  /** `policyArtifactHash` of `script`. */
  scriptHash: string;
  /** `parent`: hash of the package this version was imported from; `version`: the exporting library's version. */
  lineage: { parent: string | null; version: number };
  /** SPDX expression, `NOASSERTION` when the exporter states none. */
  license: string;
  /** A display name, never an identifier or credential. */
  author: string | null;
  /** Export time, `YYYY-MM-DDTHH:MM:SS.sssZ`. */
  createdAt: string;
  record?: { wins: number; losses: number; draws: number };
  /** SHA-256 hex of the canonical JSON of the package without `hash`. */
  hash: string;
}

/** One `policy_export` page: a slice of the canonical package JSON; joined in order, the pages are the package. */
export interface PolicyExportPage {
  version: number;
  hash: string;
  /** UTF-8 bytes of the whole canonical package. */
  bytes: number;
  page: number;
  pages: number;
  text: string;
  next?: { version: number; page: number };
}

export type PolicyErrorCode =
  | 'runtime_not_allowed'
  | 'too_large'
  | 'compile'
  | 'missing_export'
  | 'bad_module'
  | 'imports_not_allowed'
  | 'memory_limit'
  | 'timeout'
  | 'threw'
  | 'bad_output';

/** A policy load or call failure: a closed code plus, at most, the engine's message about the caller's own artifact. */
export interface PolicyError {
  code: PolicyErrorCode;
  /** Own-authored text only (engine message about the caller's artifact). Truncated. */
  message?: string;
}

/** Running statistics of one deployed policy version. */
export interface PolicyStats {
  version: number;
  runtime: PolicyRuntime;
  /** Calls since this version was deployed. */
  calls: number;
  /** Successful decisions, including a valid empty intent list. */
  successfulCalls: number;
  /** Failed calls/restarts since the last successful decision. */
  consecutiveFailures: number;
  timeouts: number;
  errors: number;
  /** Mean / max wall time per call, ms. */
  meanMs: number;
  maxMs: number;
  intentsEmitted: number;
  intentsRejected: { code: string; count: number }[];
  /** The most recent schema-invalid intent this policy returned. */
  lastInvalid?: InvalidIntent;
  lastError?: PolicyError;
  /** Tail of the policy's own `log()` output. */
  logs: string[];
}

/**
 * `from` / `knobs`: the active version was deployed from a starter (spec §11 *Starters*); `knobs` only when it was
 * deployed with knobs.
 */
export type PolicyStatus = (PolicyStats | { version: null }) & {
  approval?: Approval;
  activationError?: 'stale_policy' | 'policy_failed' | 'needs_role_deploy';
  from?: string;
  knobs?: Record<string, unknown>;
};

/** `policyDeploy` result: the new version with its probe call's stats, a load error, or (supervised) an approval request. */
export type DeployResult =
  | { ok: true; version: number; /** One dry-run call against the current observation. */ probe: PolicyStats }
  | { ok: false; error: PolicyError }
  | { ok: false; approval: ApprovalRequest };

/** `practice` arguments: a headless match against a built-in opponent (SPEC §13). */
export interface PracticeRequest {
  /** One of the manifest's opponents. */
  opponent: string;
  ticks: number;
  seed?: number;
  /** Policy to test; defaults to the seat's deployed policy. */
  artifact?: PolicySource;
  /** Bot strength for your other seats (team games); defaults to the same as `opponent`. */
  allies?: string;
  /** Match options for the practice match (manifest.matchOptions); in a match, defaults to that match's options. */
  options?: Record<string, unknown>;
}

/** `practice` result. */
export type PracticeResult = {
  ok: true;
  outcome: 'win' | 'loss' | 'draw' | 'running';
  ticks: number;
  /** Game report (closed vocabulary, manifest.report). */
  report: unknown;
  policy: PolicyStats;
  /** Wall-clock ms the practice took. */
  wallMs: number;
} | {
  ok: false;
  /** Policy loading failed, or game output failed closed-vocabulary validation. */
  code: 'policy' | 'guard';
  policy: PolicyStats;
  wallMs: number;
};

export interface WaitRequest {
  /** Game seconds to wait at most (wall-clock seconds in the lobby, where the wait ends as soon as a match seats you). */
  seconds: number;
  /** Return early when any event of these kinds happens (game event enum literals). */
  until?: string[];
}

/**
 * A message from the seat's own owner (the player this agent works for). Owner-authored text: same trust as the
 * player typing into their own harness. Never from opponents, teammates or spectators.
 */
export interface OwnerMessage {
  from: 'owner';
  /** Match tick when sent (0 in the lobby). */
  tick: number;
  text: string;
  /** Typed attachment (manifest.control.chat.ping), e.g. a map point. */
  ping?: unknown;
}

/** An agent's reply to its owner (`say`), as delivered to the owner's clients only. */
export interface Said {
  role: string;
  tick: number;
  /** Agent-authored text: render as plain text, never as markup. */
  text: string;
}

/** What ended a wait early, and unread owner messages; shared by both phases' results. */
export interface WaitWake {
  /** Unread owner messages (chat mode). Present only when there are some; they are then marked read. */
  messages?: OwnerMessage[];
  /** Why the wait ended early. `signal`: a teammate's signal reached you, or one you sent changed state. */
  wake?: 'owner_message' | 'approval' | 'signal';
  /** Your team-signal slice (games declaring signals), present when the wait ended with `wake: 'signal'`. */
  signals?: SeatSignals;
  previousMatch?: MatchReceipt;
}

/**
 * A wait result. Before the match starts it is the lobby state; a wait that sees the match start (or the seat handed
 * to this agent mid-match) returns `match` at once with that first `observation` and an `instruction`.
 */
export type WaitResult = (LobbyState & WaitWake) | (MatchWait & WaitWake);

export interface MatchWait {
  phase: 'match';
  tick: number;
  outcome: 'win' | 'loss' | 'draw' | 'running';
  /** Events in the window (closed vocabulary). */
  events: unknown[];
  /** The seat's first observation (manifest.observation) when this result is the agent's entry into the match. */
  observation?: unknown;
  /** Next step on entry into the match (static host text). */
  instruction?: string;
}

/** Bounded, non-consuming receipt for this role only; never includes observations or other teams' results. */
export interface MatchReceipt {
  match: string;
  team: string;
  role: string;
  /** Last known tick; null after restart when the process never saved its closing state. */
  tick: number | null;
  outcome: 'win' | 'loss' | 'draw' | 'unknown';
  disposition: 'final' | 'interrupted';
  /** Recording time, milliseconds since epoch. */
  at: number;
}

/** Non-consuming lifecycle snapshot. No owner text, policy text, or game observations. */
export interface SeatStatus {
  phase: SessionPhase;
  team?: string;
  tick: number;
  outcome?: MatchWait['outcome'];
  previousMatch?: MatchReceipt;
  approval?: Approval;
  unreadOwnerMessages: number;
  /** Present while the session is paused (pausable games only). */
  paused?: PauseInfo;
}

export type PublishResult = { policyId: string } | { ok: false; approval: ApprovalRequest };

export interface PolicyExportRequest {
  version?: number;
  page?: number;
}

/** `policyImport`: the new library version and whether it was stored stale (another host surface). */
export interface PolicyImportResult {
  ok: true;
  version: number;
  stale: boolean;
}

/** The control plane for one seat. Every binding implements or forwards exactly this. */
export interface SeatControl {
  /** The core briefing. */
  briefing(): Promise<Briefing>;
  /** One page (default 1) of a topic from the briefing's index; unknown topic or page → `invalid`. */
  briefing(topic: string, page?: number): Promise<TopicPage>;
  /**
   * Returns manifest.observation. `since`: last tick already seen, for events. `detail`: observation sections to render
   * in full besides the role's defaults, or `'all'` (games declaring `observationScope`; unknown section → `invalid`).
   */
  observe(since?: number, detail?: DetailRequest): Promise<unknown>;
  act(intents: unknown[]): Promise<IntentAck[]>;
  sequence(req: SequenceRequest): Promise<SequenceResult>;
  policyDeploy(artifact: PolicySource): Promise<DeployResult>;
  policyStatus(): Promise<PolicyStatus | null>;
  policyRollback(version: number): Promise<DeployResult>;
  /**
   * One page (default 1) of a library version (default the role's active one) as a `playerthree.policy/1` package
   * (spec §13.1). Page 1 exports afresh; later pages slice that same export. No library or unknown version → `invalid`.
   */
  policyExport(request?: PolicyExportRequest): Promise<PolicyExportPage>;
  /** Add a package as a new, inactive library version for this role (spec §13.1); any failure → `invalid`. */
  policyImport(pkg: PolicyPackage): Promise<PolicyImportResult>;
  practice(req: PracticeRequest): Promise<PracticeResult>;
  publish(): Promise<PublishResult>;
  wait(req: WaitRequest): Promise<WaitResult>;
  /** Mark this agent ready for its pre-match seat (no-op once the match runs). */
  ready(): Promise<ReadyResult>;
  /** A window of a skill file (developer text) starting at `offset` (default 0); unknown file or offset → `invalid`. */
  skill(name: string, path: string, offset?: number): Promise<SkillPage>;
  /** Agent-authored owner reply; observer disclosure is a separate explicit opt-in emission. */
  say(text: string, disclosure?: { audience: 'observers'; category: 'summary' | 'chat' }): Promise<SayResult>;
}

export interface SayResult {
  ok: true;
  tick: number;
}

/** Names of the control-plane methods (`SeatControl` keys); each maps to one MCP tool. */
export type ControlMethod = keyof SeatControl;

/** Which control mode gates each method (`intents` is always available). */
export const METHOD_MODE: Record<ControlMethod, 'intents' | 'sequence' | 'policy' | 'practice' | 'pool' | 'chat'> = {
  briefing: 'intents',
  observe: 'intents',
  act: 'intents',
  sequence: 'sequence',
  wait: 'intents',
  ready: 'intents',
  skill: 'intents',
  policyDeploy: 'policy',
  policyStatus: 'policy',
  policyRollback: 'policy',
  policyExport: 'policy',
  policyImport: 'policy',
  practice: 'practice',
  publish: 'pool',
  say: 'chat',
};

/** Reading never requires a scope. */
export const METHOD_SCOPE: Record<ControlMethod, Scope | undefined> = {
  briefing: undefined,
  observe: undefined,
  act: 'act',
  sequence: 'act',
  wait: undefined,
  ready: undefined,
  skill: undefined,
  policyDeploy: 'policy',
  policyStatus: undefined,
  policyRollback: 'policy',
  policyExport: 'policy',
  policyImport: 'policy',
  practice: 'practice',
  publish: 'publish',
  say: 'say',
};

/** New seats receive each permission supported by the game. */
export function defaultScopes(manifest: AnyManifest): Scope[] {
  return SCOPES.filter((scope) => scope === 'act' || manifest.control[scope === 'publish' ? 'pool' : scope === 'say' ? 'chat' : scope] !== undefined);
}

/** Stable MCP tool names. Same for every game. */
export const MCP_TOOL_NAMES: Record<ControlMethod, string> = {
  briefing: 'game_briefing',
  observe: 'game_observe',
  act: 'game_act',
  sequence: 'game_sequence',
  wait: 'game_wait',
  ready: 'game_ready',
  skill: 'game_skill',
  policyDeploy: 'policy_deploy',
  policyStatus: 'policy_status',
  policyRollback: 'policy_rollback',
  policyExport: 'policy_export',
  policyImport: 'policy_import',
  practice: 'practice_run',
  publish: 'pool_publish',
  say: 'game_say',
};
