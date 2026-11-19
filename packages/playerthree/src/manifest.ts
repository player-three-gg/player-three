/**
 * The game definition contract (SPEC §3 Game description, §10 Adapter contract): the declarative `GameManifest`
 * (checked by `defineManifest`), the `GameAdapter` a game implements, built-in bots, and the `GameDefinition` that
 * bundles them; plus the fixed caps on agent-served text.
 */
import type { ResultRows } from './arena.ts';
import type { Mandate } from './control.ts';
import type { PolicyPackage } from './control.ts';
import { t, type EnumS, type Fields, type Infer, type ObjS, type Schema, type UnionS } from './schema.ts';
import { checkSignals, type SignalLimits, type SignalVocabulary } from './signals.ts';

/**
 * Game-agnostic contract. Nothing here assumes a genre: a "seat" is any slot an agent can drive
 * (an RTS plane commander, an FPS squadmate, a card-game player, a racing teammate…).
 * Time is a monotonically increasing `tick`; turn-based games advance it per turn.
 */

/**
 * Who drives a seat. Fixed by PlayerThree.
 * - human:  the team owner's client
 * - agent:  a live LLM harness (issues intents and may deploy a policy)
 * - policy: a published policy artifact, no live LLM (async bots: ladders, bot pools, "enemies are other players' bots")
 * - bot:    the developer's built-in commander
 * - none:   idle
 */
export const CONTROLLERS = ['human', 'agent', 'policy', 'bot', 'none'] as const;
export type Controller = (typeof CONTROLLERS)[number];

/** Policy artifact formats. `js`: source run in QuickJS compiled to WASM. `wasm`: a core WebAssembly module (any language) using the PlayerThree policy ABI. */
export const POLICY_RUNTIMES = ['js', 'wasm'] as const;
export type PolicyRuntime = (typeof POLICY_RUNTIMES)[number];

/** Independent UTF-8 JSON bound for match bootstrap, not part of an observation's byte budget. */
export const MATCH_DATA_MAX_BYTES = 128 * 1024;

/** One intent kind of `manifest.intents`: the roles that may send it and its parameter schema. */
export interface IntentDef<P extends Fields = Fields> {
  /** Seat roles allowed to issue this intent. */
  readonly roles: readonly string[];
  readonly params: P;
  /** Static developer text shown to agents (tool docs). Trusted. */
  readonly doc: string;
}

/**
 * Control modes. A game opts into each mode it supports; agents discover them from the briefing.
 * The set is designed to grow as models get faster and cheaper: a slow LLM is a commander that writes
 * policies (seconds per decision); a fast enough one can drive the seat directly every tick (`stream`).
 * New modes are added as new optional keys — never by changing an existing one.
 */
export interface IntentMode {
  /** Per seat token bucket for intents from tool calls / WS. */
  readonly perSecond: number;
  readonly burst: number;
}

/** A bounded, tick-relative plan; no branching or executable code. */
export interface SequenceMode {
  readonly maxSteps: number;
  readonly maxTicksAhead: number;
  readonly minSpacingTicks: number;
}

/** Tick-synchronous direct control: the server pushes observations every N ticks; intents apply on the next tick. */
export interface StreamMode {
  /** Max observation pushes per second of game time. */
  readonly maxHz: number;
  /** Max intents accepted per tick per seat. */
  readonly intentsPerTick: number;
}

/** Async bot pool: published policies can be drafted into seats of other players' matches. */
export interface PoolMode {
  readonly maxPublishedPerPrincipal: number;
}

/**
 * The game may stand still while an agent is away: owners can then choose `whenAbsent: 'pause'`. Declare it only
 * when one absent seat may stop the whole session for everyone in it (solo play, turn-based seats that must move).
 */
export interface PauseMode {
  /** Longest pause, wall-clock seconds; then the absent seat falls back to its policy (else its bot). Omit: unbounded. */
  readonly maxPauseSeconds?: number;
}

/** `manifest.control`: the control modes a game offers its seats (absent optional modes are unavailable). */
export interface ControlModes {
  /** Direct control at LLM pace. Always present. */
  readonly intents: IntentMode;
  readonly sequence?: SequenceMode;
  /** Agent-written code at tick rate. */
  readonly policy?: PolicyLimits;
  /** Direct control at tick rate (fast/cheap/realtime models). */
  readonly stream?: StreamMode;
  /** Headless sparring against built-in opponents. */
  readonly practice?: PracticeLimits;
  /** Publish policies so they can fight other people (and humans) when you are offline. */
  readonly pool?: PoolMode;
  /**
   * Owner ↔ own-agent chat: the seat's owner (and nobody else) can message their agents; agents reply to their
   * owner only (`game_say`). Third-party text never reaches an agent; policies never receive chat.
   */
  readonly chat?: ChatMode;
  /** `whenAbsent: 'pause'` is allowed: the host stops stepping while such a seat's agent is absent. */
  readonly pausable?: PauseMode;
  /** Team signals (with `manifest.signals`): the per-seat rate, open-signal cap and lifetimes. */
  readonly signals?: SignalLimits;
}

export interface ChatMode {
  /** Longest owner message, chars (≤ 500). */
  readonly maxTellChars: number;
  /** Longest agent reply, chars (≤ 280). */
  readonly maxSayChars: number;
  /** Optional typed attachment an owner can add to a message, e.g. a map point (closed vocabulary). */
  readonly ping?: Schema;
}

/** Hard caps on chat lengths (manifests may only lower them). */
export const MAX_TELL_CHARS = 500;
export const MAX_SAY_CHARS = 280;

export const CONTROL_PLANE_VERSION = 1;

/**
 * Agent knowledge budgets, in UTF-16 code units of the text an agent receives. Harnesses spill or truncate large tool
 * results (Claude Code past ~25K tokens, Codex ~10K tokens), so knowledge is disclosed progressively: a small core
 * briefing plus a one-line topic index, with topics, skill files and observations fetched in bounded pages.
 */
/** Upper bound on any default tool result's MCP text content (core briefing, topic and skill pages, observe pages). */
export const RESULT_TEXT_MAX = 24_000;
/** `manifest.doc`: the core rules every seat reads first. */
export const DOC_MAX = 6_000;
/** Each `manifest.roleDocs[role]`. */
export const ROLE_DOC_MAX = 3_500;
/** Each topic page (game topic `text`; generated topics are split or paged to fit). */
export const TOPIC_TEXT_MAX = 8_000;
/** One-line topic summary shown in the index. */
export const TOPIC_SUMMARY_MAX = 160;
/** All game-topic index lines (`name — summary`, newline-joined): keeps the core briefing and reference index small. */
export const TOPIC_INDEX_MAX = 5_000;
/** One `game_skill` page, cut at a newline. */
export const SKILL_PAGE_MAX = 20_000;
/** Skill `.js` files one policy artifact may `include`. */
export const MAX_POLICY_INCLUDES = 16;
/**
 * Generated topic roots: a game topic must not be one of these or start with `<root>/`. `role/<role>`, `intent/<kind>`,
 * `observation/<field>`, `match-data/fields`, `schema/<name>` and `types/<role>` live under them.
 */
export const GENERATED_TOPIC_ROOTS = ['role', 'intents', 'intent', 'observation', 'match-data', 'events', 'report', 'mandate', 'modes', 'schema', 'signals', 'starters', 'types'] as const;
/** Starters a manifest may declare (spec §11 *Starters*). */
export const MAX_STARTERS = 16;
/** Longest starter summary, in UTF-16 code units (one line, like a topic summary). */
export const STARTER_SUMMARY_MAX = TOPIC_SUMMARY_MAX;
/** Longest starter path `"<skill>/<path>.js"`: a skill name (≤ 64), `/`, a skill file key (≤ 200). */
export const STARTER_PATH_MAX = 265;
/** Largest `knobs` object a starter deploy may carry, in UTF-8 bytes of its JSON. */
export const STARTER_KNOBS_MAX_BYTES = 4096;
/** Largest starter `knobs` JSON Schema, in UTF-8 bytes of its compact JSON. */
export const STARTER_KNOBS_SCHEMA_MAX_BYTES = 16384;
/** Properties of one knobs object (the schema root or a nested object). */
export const STARTER_MAX_KNOBS = 32;

/**
 * A ready-made baseline policy the game serves as a skill `.js` file (spec §11 *Starters*), deployable by reference
 * (`policy_deploy {from, knobs?}`). Its module exports `createPolicy(knobs)` and, optionally, a `knobs` JSON Schema.
 */
export interface StarterDef {
  /** One line, ≤ STARTER_SUMMARY_MAX: what the starter plays and how well. */
  readonly summary: string;
  /** The roles it plays (unique manifest roles); default every role. */
  readonly roles?: readonly string[];
}

/** On-demand briefing topic. The index shows `name — summary`; the text is fetched with game_briefing `{ topic }`. */
export interface TopicDef {
  /** One line, ≤ TOPIC_SUMMARY_MAX. */
  readonly summary: string;
  /** ≤ TOPIC_TEXT_MAX. Static developer text (trusted). */
  readonly text: string;
}

/**
 * Policy = agent-written code that runs sandboxed at tick rate.
 * This is the StarSkirmish lesson: LLMs are far stronger as *bot authors* (write → practice → read reports → revise)
 * than as real-time players. Sandboxes have no I/O, no clock, no network; they only map observations to intents.
 */
export interface PolicyLimits {
  /** Formats this game accepts. */
  readonly runtimes: readonly PolicyRuntime[];
  /** Calls per second of game time. */
  readonly hz: number;
  /** CPU-time budget per call in milliseconds, on the sandbox thread (load-independent; overrun → `timeout`, spec §11). */
  readonly msPerCall: number;
  readonly memoryBytes: number;
  /** JS source bytes or WASM module bytes. */
  readonly maxArtifactBytes: number;
  readonly maxIntentsPerCall: number;
  readonly maxLogLines: number;
  readonly maxLogLineBytes: number;
}

export interface PracticeLimits {
  /** Longest headless practice match, in ticks. */
  readonly maxTicks: number;
  /** Concurrent practice matches per principal. */
  readonly concurrent: number;
}

/** Observation sections (spec §3 *Observation scope*). Plain JSON like the rest of the manifest. */
export interface ObservationScope {
  /** Closed section names (enum literals), in rendering order. */
  readonly sections: EnumS;
  /** Every role: the sections its observation renders in full by default (declared names, no repeats; may be empty). */
  readonly defaults: { readonly [role: string]: readonly string[] };
}

/** What a caller asks to see in full besides its role's defaults: section names, or every section. */
export type DetailRequest = readonly string[] | 'all';

/**
 * Everything a game exposes to agents. All text here is static developer text (trusted).
 * All data schemas are closed-vocabulary (see schema.ts). The manifest is plain JSON-able data,
 * so non-JS engines can author it and speak the wire protocol directly.
 */
export interface GameManifest<
  Teams extends EnumS = EnumS,
  Roles extends EnumS = EnumS,
  Intents extends Record<string, IntentDef> = Record<string, IntentDef>,
  Obs extends Schema = Schema,
  View extends Schema = Schema,
  Directive extends ObjS = ObjS,
  Errors extends EnumS = EnumS,
  Opponents extends EnumS = EnumS,
  Report extends Schema = Schema,
  Event extends ObjS = ObjS,
> {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  /** Core rules every seat reads first (≤ DOC_MAX). Details belong in `topics`. */
  readonly doc: string;
  /** Per-role briefing for agents (≤ ROLE_DOC_MAX each). Name the topics a role must read before playing. */
  readonly roleDocs: { readonly [role: string]: string };
  /**
   * On-demand briefing topics, in index order (`{}` allowed). Names match `^[a-z][a-z0-9-]*(/[a-z0-9-]+)*$` (≤ 64) and
   * must not collide with GENERATED_TOPIC_ROOTS. Also served as files of the generated `<id>-reference` skill.
   */
  readonly topics: { readonly [name: string]: TopicDef };
  readonly tickRate: number;
  readonly teams: Teams;
  readonly roles: Roles;
  readonly intents: Intents;
  /** Seat-focused, fogged agent observation. Also the input to policies. A top-level `phase` field is reserved (lobby state). */
  readonly observation: Obs;
  /**
   * Optional observation detail (spec §3 *Observation scope*): closed section names and, per role, the sections its
   * observation renders in full by default. The rest come as the game's compact summaries; agents widen the detail per
   * call, policies per artifact, built-in bots always get every section. Without it every detail is empty.
   */
  readonly observationScope?: ObservationScope;
  /** Team-level fogged render state for human clients. */
  readonly view: View;
  /** Full battlefield/public side state only; never internal debug, policy, chat or owner state. */
  readonly observer?: Schema;
  /** Closed, immutable, seat-visible bootstrap data supplied with an in-match briefing. */
  readonly matchData?: ObjS;
  /**
   * Closed pre-match summary of the match a seat is reserved or held for (e.g. map, layout, rules summary), shown to
   * its agent as the lobby state's `match` (phase `lobby`). The game supplies it per reservation or match.
   */
  readonly lobby?: ObjS;
  /** Typed owner → agent guidance. Owner free text is the separate opt-in `control.chat` mode (own agents only). */
  readonly directive: Directive;
  /** Owner house rules enforced by the game in apply(); every field must be t.opt. */
  readonly limits?: ObjS;
  /** Game-level apply() failure codes. */
  readonly errors: Errors;
  /** Practice opponents (built-in bots), weakest first. */
  readonly opponents: Opponents;
  /** After-action report for one team. */
  readonly report: Report;
  /**
   * One game event as seen by a seat. MUST have `tick: int` and `kind: enum` fields;
   * the host uses them for `wait({ until })` and DevTools.
   */
  readonly event: Event;
  /**
   * Options chosen when a match is created (closed vocabulary, e.g. a map preset). Every field must be `t.opt`:
   * a missing option means the game's default. The host validates options before `create()` sees them.
   */
  readonly matchOptions?: ObjS;
  /**
   * Developer-authored Agent Skills (agentskills.io format): how to play, the policy API, example bots.
   * Served over the MCP Skills extension with content digests. Static, trusted developer text.
   */
  readonly skills: readonly SkillDef[];
  /**
   * Starters by path `"<skill>/<path>.js"` (a `.js` file of one of `skills`), in index order (spec §11 *Starters*).
   * Requires `control.policy` with the `js` runtime; at most MAX_STARTERS.
   */
  readonly starters?: { readonly [path: string]: StarterDef };
  readonly control: ControlModes;
  /**
   * Team signals: the closed vocabulary of typed teammate requests and each role's card (what it answers). Requires
   * `control.signals` and the generated members of `signalSchemas(roles, signals, control.signals)`: its `intents`
   * spread into `intents`, and its `observation` / `view` as the `signals` member of the observation and view objects.
   */
  readonly signals?: SignalVocabulary;
}

export interface SkillDef {
  /** Agent Skills name: lowercase, digits, hyphens. Also the directory name. */
  readonly name: string;
  readonly description: string;
  /** Relative path → UTF-8 content. Must include `SKILL.md` (with frontmatter). */
  readonly files: { readonly [path: string]: string };
}

export type AnyManifest = GameManifest<any, any, any, any, any, any, any, any, any, any>;

export type TeamOf<M extends AnyManifest> = Infer<M['teams']>;
export type RoleOf<M extends AnyManifest> = Infer<M['roles']>;
export type ObservationOf<M extends AnyManifest> = Infer<M['observation']>;
export type ViewOf<M extends AnyManifest> = Infer<M['view']>;
/** What a game's `observe` returns: the observation without the host-owned `signals` member (when signals are declared). */
export type GameObservationOf<M extends AnyManifest> = M['signals'] extends SignalVocabulary ? Omit<ObservationOf<M>, 'signals'> : ObservationOf<M>;
/** What a game's `view` returns: the view without the host-owned `signals` member (when signals are declared). */
export type GameViewOf<M extends AnyManifest> = M['signals'] extends SignalVocabulary ? Omit<ViewOf<M>, 'signals'> : ViewOf<M>;
export type MatchDataOf<M extends AnyManifest> = M['matchData'] extends ObjS ? Infer<M['matchData']> : Record<string, unknown>;
export type DirectiveOf<M extends AnyManifest> = Infer<M['directive']>;
export type LimitsOf<M extends AnyManifest> = M['limits'] extends ObjS ? Infer<M['limits']> : Record<string, unknown>;
/**
 * `pause` only for games whose `control` declares `pausable` (the host rejects it otherwise). A mapped type, not a
 * conditional one, so `PlayerThreeMatch<M>` stays assignable to `PlayerThreeMatch<AnyManifest>`.
 */
export type WhenAbsentOf<M extends AnyManifest> =
  | Exclude<Mandate['whenAbsent'], 'pause'>
  | { [K in keyof M['control'] & 'pausable']: 'pause' }[keyof M['control'] & 'pausable'];
export type MandateOf<M extends AnyManifest> = Omit<Mandate, 'directive' | 'limits' | 'whenAbsent'> & {
  directive: DirectiveOf<M>;
  limits?: LimitsOf<M>;
  whenAbsent: WhenAbsentOf<M>;
};
export type GameErrorOf<M extends AnyManifest> = Infer<M['errors']>;
export type OpponentOf<M extends AnyManifest> = Infer<M['opponents']>;
export type ReportOf<M extends AnyManifest> = Infer<M['report']>;
export type EventOf<M extends AnyManifest> = Infer<M['event']>;
export type IntentOf<M extends AnyManifest> = {
  [K in keyof M['intents'] & string]: { kind: K } & Infer<ObjS<M['intents'][K]['params']>>;
}[keyof M['intents'] & string];

/** Validated match options of a game (the host rejects any options when the manifest declares none). */
export type MatchOptionsOf<M extends AnyManifest> = M['matchOptions'] extends ObjS ? Infer<M['matchOptions']> : Record<string, unknown>;

/** Observation section names of a game (`never` without `observationScope`). */
export type SectionOf<M extends AnyManifest> = NonNullable<M['observationScope']> extends { readonly sections: infer S extends EnumS } ? Infer<S> : never;

/** Every declared observation section, in manifest order (empty without `observationScope`): the detail `'all'`. */
export function observationSections(m: AnyManifest): readonly string[] {
  return (m.observationScope as ObservationScope | undefined)?.sections.values ?? [];
}

/**
 * The detail a seat of `role` observes with: its role's defaults united with `request` (a list of section names, or
 * `'all'` for every section; `undefined` = defaults only), in manifest order. Null when `request` is neither, names an
 * undeclared section or repeats one — callers answer `invalid`.
 */
export function resolveDetail(m: AnyManifest, role: string, request: unknown): string[] | null {
  const sections = observationSections(m);
  if (request === 'all') return [...sections];
  const scope = m.observationScope as ObservationScope | undefined;
  const want = new Set<string>(scope?.defaults[role] ?? []);
  if (request !== undefined) {
    if (!Array.isArray(request) || request.length > sections.length) return null;
    const seen = new Set<unknown>();
    for (const s of request) {
      if (typeof s !== 'string' || !sections.includes(s) || seen.has(s)) return null;
      seen.add(s);
      want.add(s);
    }
  }
  return sections.filter((s) => want.has(s));
}

/** One seat: a manifest team and role. */
export interface Seat<M extends AnyManifest = AnyManifest> {
  readonly team: TeamOf<M>;
  readonly role: RoleOf<M>;
}

/** Wire schema for any intent of this game: a union tagged by `kind`. */
export function intentSchema<M extends AnyManifest>(m: M): UnionS<'kind', Record<string, Fields>> {
  const variants: Record<string, Fields> = {};
  for (const [k, d] of Object.entries(m.intents as Record<string, IntentDef>)) variants[k] = d.params;
  return t.union('kind', variants, 'One intent; `kind` selects the variant.');
}

export type Outcome = 'win' | 'loss' | 'draw' | 'running';
/** A side's decided outcome. */
export type FinalOutcome = Exclude<Outcome, 'running'>;

/**
 * The sides of one match: the manifest teams taking part (a subset, in manifest order) and optional named alliances
 * (alliance id → member teams, manifest order; every match team belongs to exactly one). Without alliances every team
 * is on its own: two teams are a duel, more a free-for-all.
 */
export interface MatchSides<M extends AnyManifest = AnyManifest> {
  readonly teams: readonly TeamOf<M>[];
  readonly alliances?: Readonly<Record<string, readonly TeamOf<M>[]>>;
}

/** What `GameAdapter.apply` returns: accepted, or rejected with one of the game's declared error codes. */
export type ApplyResult<M extends AnyManifest = AnyManifest> = { ok: true } | { ok: false; code: GameErrorOf<M> };

/** Trusted caller provenance, supplied by the host, never by an intent's untrusted payload. */
export const INTENT_SOURCES = ['owner', 'agent', 'policy', 'bot', 'fallback'] as const;
export type IntentSource = (typeof INTENT_SOURCES)[number];
/** Host-supplied provenance of one applied intent. */
export interface IntentContext {
  readonly source: IntentSource;
  /** Current same-team roles with verified human control/delegation for this owner; absent means this seat's role only. */
  readonly ownerRoles?: readonly string[];
}

/** A built-in (developer-written, native) commander. Uses exactly the same intents as agents. */
export interface BotCommander<M extends AnyManifest = AnyManifest> {
  /** Runs once before think, with guarded seat-visible match data (null when no schema is declared). */
  init?(matchData: MatchDataOf<M> | null): void;
  think(obs: ObservationOf<M>): IntentOf<M>[];
}

/** One running match of a game. */
export interface GameAdapter<M extends AnyManifest = AnyManifest> {
  readonly manifest: M;
  readonly tick: number;
  step(): void;
  outcome(team: TeamOf<M>): Outcome;
  /**
   * Must conform to manifest.view. `snapshot` is true when a client starts watching (its first view) and false for
   * the periodic broadcast, so a game can send static, slow-changing parts (a map) only when they are needed.
   */
  view(team: TeamOf<M>, opts?: { snapshot: boolean }): GameViewOf<M>;
  /** Optional bounded JSON snapshot of unfogged state. Developer-only; never sent to players or agents. */
  debugView?(): unknown;
  /** Required for omniscient observers when manifest.observer is declared; must conform to that schema. */
  observerView?(): unknown;
  /**
   * Optional: the host ended the session early (`PlayerThreeMatch.end`, e.g. from the operator console) with these outcomes
   * and placements for every match team. Adopt them so the game's own outcome, views and reports agree. Without it
   * the host still reports the declared outcomes, but the game's views and reports keep whatever the game last decided.
   */
  end?(outcomes: Partial<Record<TeamOf<M>, FinalOutcome>>, ranks: Partial<Record<TeamOf<M>, number>>): void;
  /**
   * Optional: the match team concedes now (`PlayerThreeMatch.forfeit`); take it out of play while the others play on, and
   * report its final outcome from `outcome(team)` once the game decides it (now or at a later step). Called before
   * `step()` of the current tick and recorded in replays, so it MUST be deterministic like `apply`. Called at most once
   * per team, only while the team's outcome is not final. Without it `PlayerThreeMatch.forfeit` fails `invalid`.
   */
  forfeit?(team: TeamOf<M>): void;
  /**
   * Optional final placement of a match team, read once every match team's outcome is final: 1 is best, tied teams
   * share a rank and the next rank skips (1, 2, 2, 4), allies share their alliance's rank, and ranks count alliances
   * (or lone teams), never members. Without it, or when the ranks break these rules, the host ranks by outcome:
   * win, then draw, then loss.
   */
  rank?(team: TeamOf<M>): number;
  /** Optional independent in-memory checkpoint. Copy all mutable state, RNG and caches; never share them. */
  clone?(): GameAdapter<M>;
  /**
   * Must conform to manifest.observation, minus the host-owned `signals` member when signals are declared. Events after
   * `sinceTick`; bootstrap is delivered separately. `detail`: the sections to render in full, in manifest order (empty
   * without `observationScope`); summarise the others.
   */
  observe(seat: Seat<M>, sinceTick: number, detail: readonly SectionOf<M>[]): GameObservationOf<M>;
  /**
   * Optional, with `manifest.signals`: this match's signal limits, each at most the manifest's `control.signals`
   * (a match may narrow, never widen them), or `null` when this match has signals off (every signal intent then fails
   * `disabled`). Read once when the match (or a replay of it) is created. Without it the manifest's limits apply.
   */
  signalLimits?(): SignalLimits | null;
  /** Required when manifest.matchData is declared. Must enforce the seat's perspective. */
  matchData?(seat: Seat<M>): MatchDataOf<M>;
  /** Intent is already schema-validated and role-checked. Omitted context means an explicit direct/owner call. */
  apply(seat: Seat<M>, intent: IntentOf<M>, context?: IntentContext): ApplyResult<M>;
  /** Must conform to manifest.report. */
  report(team: TeamOf<M>): ReportOf<M>;
  /** Events visible to a seat with tick > sinceTick, oldest first. Each must conform to manifest.event. */
  events(seat: Seat<M>, sinceTick: number): EventOf<M>[];
  /** Server informs the game so it can render controller badges and enforce mandate limits. */
  setSeatInfo(seat: Seat<M>, info: { controller: Controller; mandate: MandateOf<M> }): void;
}

/** Observational benchmark data: finite numbers only; side keys are declared physical teams. */
export interface GameMetrics {
  match: Record<string, number>;
  sides: Record<string, Record<string, number>>;
}

/** A recorder must not mutate game state, consume RNG, or change observations. */
export interface GameMetricRecorder {
  /** Called after each benchmark tick, including the terminal tick. */
  collect(): void;
  /** Called once; maps are snapshotted and bounded by the benchmark runner. */
  finish(): GameMetrics;
  /** Sanitized normalized accounting rows for the generic result service. */
  rows?(matchId: string): Partial<ResultRows>;
  /** Observational intent accounting, including rejected attempts. */
  intent?(row: { team: string; role: string; source: string; code: string; accepted: boolean }): void;
}

/** Factory for matches: used for live rooms and headless practice. */
export interface GameDefinition<M extends AnyManifest = AnyManifest> {
  readonly manifest: M;
  /**
   * A new match of the given sides (`teams` ⊆ manifest teams, never empty; `alliances` only when the match declares
   * them). A game that cannot play a side set throws; the host never invents phantom sides.
   */
  create(opts: { seed: number; options?: MatchOptionsOf<M> } & MatchSides<M>): GameAdapter<M>;
  /** Built-in bot at a given strength for a seat. */
  createBot(seat: Seat<M>, opponent: OpponentOf<M>, options?: Record<string, number | boolean>): BotCommander<M>;
  /** Game-owned schema for deterministic built-in bot strategy options. */
  readonly botOptions?: ObjS;
  /**
   * A host-registered first-party policy package that plays the built-in bot tier `level` for `role` (spec §11 *Bot
   * packages*), or undefined for the built-in `createBot`. The host runs it through the trusted V8 runner
   * (`loadTrustedPolicy`) with every observation section, and only while its `surfaceHash` equals the current surface;
   * otherwise `createBot` plays the seat. Each seat's instance gets the seat's bot options as `createPolicy(options)`
   * (`null` without), as `createBot` gets them. Operator code only: never a seat's, owner's or pool upload.
   */
  botPackages?(level: OpponentOf<M>, role: RoleOf<M>): PolicyPackage | undefined;
  /** Optional game-owned, observational benchmark recorder for this adapter instance. */
  metrics?(game: GameAdapter<M>, options?: { sampleEveryTicks?: number }): GameMetricRecorder;
}

// ---------------------------------------------------------------- defineManifest

const ENUM_LITERAL = /^[A-Za-z][A-Za-z0-9_.<>]{0,47}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
const ID_PREFIX = /^[a-z]{1,8}$/;
/** Manifest `id` grammar (spec §3); also bounds `game.id` of policy packages. */
export const GAME_ID = /^[a-z][a-z0-9-]{0,47}$/;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Skill file path grammar (also game_skill's `path` input pattern). */
export const SKILL_PATH_PATTERN = '^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*(/[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*)*$';
const SKILL_PATH = new RegExp(SKILL_PATH_PATTERN);
/** ES modules one policy artifact may carry (spec §11 `modules`). */
export const POLICY_MAX_MODULES = 64;
/** UTF-8 bytes of module source one policy artifact may carry in total, checked before bundling. */
export const POLICY_MODULES_MAX_BYTES = 1048576;
/** Longest policy module path, in UTF-16 code units (the skill file-key bound). */
export const POLICY_MODULE_PATH_MAX = 200;
/** Policy module path grammar: a skill file path ending in `.js`, `.mjs`, `.ts` or `.mts`. */
export const POLICY_MODULE_PATH_PATTERN = `${SKILL_PATH_PATTERN.slice(0, -1)}\\.(js|mjs|ts|mts)$`;
/** Policy package format (spec §13.1). */
export const POLICY_PACKAGE_FORMAT = 'playerthree.policy/1';
/** Largest canonical policy package, in UTF-8 bytes. */
export const POLICY_PACKAGE_MAX_BYTES = 4_194_304;
/** Largest `policy_export` page of the canonical package JSON, in UTF-16 code units. */
export const POLICY_EXPORT_PAGE = 16_000;
/** Largest policy artifact whose base64 encoding still fits a 1 MiB protocol message. */
const MAX_ARTIFACT_BYTES = 700_000;
const TOPIC_NAME = /^[a-z][a-z0-9-]*(\/[a-z0-9-]+)*$/;

function checkTopics(topics: unknown): void {
  if (!isObj(topics)) fail('topics', 'required (an object; {} allowed)');
  let index = 0;
  for (const [name, def] of Object.entries(topics)) {
    const path = `topics.${name}`;
    if (name.length > 64 || !TOPIC_NAME.test(name)) fail(path, `name must match ${TOPIC_NAME} (≤64)`);
    const root = name.split('/')[0] as string;
    if ((GENERATED_TOPIC_ROOTS as readonly string[]).includes(root)) fail(path, `\`${root}\` is reserved for generated topics`);
    if (!isObj(def)) fail(path, 'must be { summary, text }');
    for (const k of Object.keys(def)) if (k !== 'summary' && k !== 'text') fail(`${path}.${k}`, 'unknown field');
    if (!isText(def.summary, TOPIC_SUMMARY_MAX) || /[\r\n]/.test(def.summary)) fail(`${path}.summary`, `one line, 1..${TOPIC_SUMMARY_MAX} chars`);
    if (!isText(def.text, TOPIC_TEXT_MAX)) fail(`${path}.text`, `1..${TOPIC_TEXT_MAX} chars`);
    index += (index === 0 ? 0 : 1) + name.length + 3 + def.summary.length;
  }
  if (index > TOPIC_INDEX_MAX) fail('topics', `index lines (name — summary) total ${index} chars; max ${TOPIC_INDEX_MAX}`);
}

function fail(path: string, why: string): never {
  throw new Error(`playerthree/manifest: ${path}: ${why}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function checkNum(path: string, v: unknown, min: number, max: number, integer = false): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    fail(path, `must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`);
  }
}

function checkEnum(path: string, s: unknown): asserts s is EnumS {
  if (!isObj(s) || s.t !== 'enum' || !Array.isArray(s.values) || s.values.length === 0) fail(path, 'must be a non-empty t.enum');
  for (const v of s.values) if (typeof v !== 'string' || !ENUM_LITERAL.test(v)) fail(path, `enum literal must match ${ENUM_LITERAL}`);
  if (new Set(s.values).size !== s.values.length) fail(path, 'duplicate enum literal');
}

function checkFieldsDef(path: string, fields: unknown): void {
  if (!isObj(fields)) fail(path, 'fields must be an object');
  for (const [k, f] of Object.entries(fields)) {
    if (!FIELD_NAME.test(k)) fail(path, `invalid field name ${JSON.stringify(k)}`);
    checkSchemaDef(`${path}.${k}`, isObj(f) && f.t === 'opt' ? f.item : f);
  }
}

/** Structural check of a schema tree (manifests may be authored as plain JSON by non-JS engines). */
function checkSchemaDef(path: string, s: unknown): void {
  if (!isObj(s)) fail(path, 'not a schema');
  switch (s.t) {
    case 'enum':
      return checkEnum(path, s);
    case 'id':
      if (typeof s.prefix !== 'string' || !ID_PREFIX.test(s.prefix)) fail(path, `id prefix must match ${ID_PREFIX}`);
      return;
    case 'str':
    case 'ints':
      try {
        if (s.t === 'str') t.str(s.maxLength as number, s.pattern as string | undefined, s.doc as string | undefined);
        else t.ints(s.maxItems as number, s.min as number, s.max as number, s.doc as string | undefined);
      } catch (error) {
        fail(path, error instanceof Error ? error.message : 'invalid bounded schema');
      }
      return;
    case 'int':
      if (!Number.isSafeInteger(s.min) || !Number.isSafeInteger(s.max) || (s.min as number) > (s.max as number)) fail(path, 'bad int range');
      return;
    case 'num':
      if (!Number.isFinite(s.min) || !Number.isFinite(s.max) || (s.min as number) > (s.max as number)) fail(path, 'bad num range');
      return;
    case 'bool':
      return;
    case 'list':
      if (!Number.isSafeInteger(s.max) || (s.max as number) < 0) fail(path, 'list needs a finite max');
      return checkSchemaDef(`${path}[]`, s.item);
    case 'obj':
      if (s.merge !== undefined && s.merge !== 'replace') fail(path, 'bad object merge mode');
      return checkFieldsDef(path, s.fields);
    case 'opt':
      return fail(path, 't.opt is only valid as a direct field of t.obj / t.union');
    case 'union':
      if (typeof s.tag !== 'string' || !FIELD_NAME.test(s.tag)) fail(path, 'invalid union tag');
      if (!isObj(s.variants) || Object.keys(s.variants).length === 0) fail(path, 'union needs variants');
      for (const [name, fields] of Object.entries(s.variants)) {
        if (!ENUM_LITERAL.test(name)) fail(path, `union variant must match ${ENUM_LITERAL}`);
        if (isObj(fields) && Object.hasOwn(fields, s.tag)) fail(path, 'variant fields must not redeclare the tag');
        checkFieldsDef(`${path}<${name}>`, fields);
      }
      return;
    default:
      fail(path, 'unknown schema type (there is deliberately no string type without explicit bounds)');
  }
}

/** Control-mode limits must be finite and sane: they bound what one seat can cost the server. */
function checkControl(c: unknown, tickRate: number): void {
  if (!isObj(c)) fail('control', 'required');
  // `signals` limits are checked with the vocabulary (checkSignals).
  for (const k of Object.keys(c)) if (!['intents', 'sequence', 'policy', 'stream', 'practice', 'pool', 'chat', 'pausable', 'signals'].includes(k)) fail(`control.${k}`, 'unknown mode');
  const i = c.intents;
  if (!isObj(i)) fail('control.intents', 'required');
  checkNum('control.intents.perSecond', i.perSecond, 0.01, 1000);
  checkNum('control.intents.burst', i.burst, 1, 10_000, true);
  if (c.sequence !== undefined) {
    const s = c.sequence;
    if (!isObj(s)) fail('control.sequence', 'must be an object');
    checkNum('control.sequence.maxSteps', s.maxSteps, 1, 10_000, true);
    checkNum('control.sequence.maxTicksAhead', s.maxTicksAhead, 0, 2 ** 31 - 1, true);
    checkNum('control.sequence.minSpacingTicks', s.minSpacingTicks, 1, 2 ** 31 - 1, true);
  }
  if (c.policy !== undefined) {
    const p = c.policy;
    if (!isObj(p)) fail('control.policy', 'must be an object');
    if (!Array.isArray(p.runtimes) || p.runtimes.length === 0) fail('control.policy.runtimes', 'must be non-empty');
    for (const r of p.runtimes) if (!(POLICY_RUNTIMES as readonly unknown[]).includes(r)) fail('control.policy.runtimes', 'unknown runtime');
    checkNum('control.policy.hz', p.hz, 0.01, tickRate);
    checkNum('control.policy.msPerCall', p.msPerCall, 1, 1000, true);
    checkNum('control.policy.memoryBytes', p.memoryBytes, 1 << 20, 1 << 30, true);
    checkNum('control.policy.maxArtifactBytes', p.maxArtifactBytes, 1, MAX_ARTIFACT_BYTES, true);
    checkNum('control.policy.maxIntentsPerCall', p.maxIntentsPerCall, 1, 1000, true);
    checkNum('control.policy.maxLogLines', p.maxLogLines, 0, 1000, true);
    checkNum('control.policy.maxLogLineBytes', p.maxLogLineBytes, 1, 4096, true);
  }
  if (c.stream !== undefined) {
    const s = c.stream;
    if (!isObj(s)) fail('control.stream', 'must be an object');
    checkNum('control.stream.maxHz', s.maxHz, 0.01, tickRate);
    checkNum('control.stream.intentsPerTick', s.intentsPerTick, 1, 1000, true);
  }
  if (c.practice !== undefined) {
    const p = c.practice;
    if (!isObj(p)) fail('control.practice', 'must be an object');
    if (c.policy === undefined) fail('control.practice', 'practice runs policies; enable control.policy');
    checkNum('control.practice.maxTicks', p.maxTicks, 1, 10_000_000, true);
    checkNum('control.practice.concurrent', p.concurrent, 1, 64, true);
  }
  if (c.pool !== undefined) {
    const p = c.pool;
    if (!isObj(p)) fail('control.pool', 'must be an object');
    if (c.policy === undefined) fail('control.pool', 'the pool holds policies; enable control.policy');
    checkNum('control.pool.maxPublishedPerPrincipal', p.maxPublishedPerPrincipal, 1, 1000, true);
  }
  if (c.chat !== undefined) {
    const ch = c.chat;
    if (!isObj(ch)) fail('control.chat', 'must be an object');
    for (const k of Object.keys(ch)) if (!['maxTellChars', 'maxSayChars', 'ping'].includes(k)) fail(`control.chat.${k}`, 'unknown field');
    checkNum('control.chat.maxTellChars', ch.maxTellChars, 1, MAX_TELL_CHARS, true);
    checkNum('control.chat.maxSayChars', ch.maxSayChars, 1, MAX_SAY_CHARS, true);
    if (ch.ping !== undefined) checkSchemaDef('control.chat.ping', ch.ping);
  }
  if (c.pausable !== undefined) {
    const p = c.pausable;
    if (!isObj(p)) fail('control.pausable', 'must be an object');
    for (const k of Object.keys(p)) if (k !== 'maxPauseSeconds') fail(`control.pausable.${k}`, 'unknown field');
    if (p.maxPauseSeconds !== undefined) checkNum('control.pausable.maxPauseSeconds', p.maxPauseSeconds, 1, 7 * 24 * 3600, true);
  }
}

function checkObservationScope(s: unknown, roles: readonly string[]): void {
  if (!isObj(s)) fail('observationScope', 'must be an object');
  checkEnum('observationScope.sections', s.sections);
  const sections = s.sections.values as readonly string[];
  if (!isObj(s.defaults)) fail('observationScope.defaults', 'required');
  for (const k of Object.keys(s.defaults)) if (!roles.includes(k)) fail(`observationScope.defaults.${k}`, 'not a role');
  for (const r of roles) {
    const d = s.defaults[r];
    if (!Array.isArray(d)) fail(`observationScope.defaults.${r}`, 'every role needs a list of default sections');
    for (const v of d) if (!sections.includes(v)) fail(`observationScope.defaults.${r}`, `unknown section ${JSON.stringify(v)}`);
    if (new Set(d).size !== d.length) fail(`observationScope.defaults.${r}`, 'duplicate section');
  }
}

function checkSkill(path: string, s: unknown): void {
  if (!isObj(s)) fail(path, 'must be an object');
  if (typeof s.name !== 'string' || s.name.length > 64 || !SKILL_NAME.test(s.name)) fail(`${path}.name`, `must match ${SKILL_NAME} (≤64)`);
  if (!isText(s.description, 1024)) fail(`${path}.description`, 'must be 1..1024 chars');
  if (!isObj(s.files)) fail(`${path}.files`, 'must be an object');
  for (const [p, content] of Object.entries(s.files)) {
    if (!SKILL_PATH.test(p) || p.length > 200) fail(`${path}.files`, `invalid relative path ${JSON.stringify(p)}`);
    if (typeof content !== 'string') fail(`${path}.files.${p}`, 'must be UTF-8 text');
  }
  const md = s.files['SKILL.md'];
  if (typeof md !== 'string') fail(`${path}.files`, 'must include SKILL.md');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!fm) fail(`${path}.files.SKILL.md`, 'must start with YAML frontmatter');
  const name = /^name:\s*(.+)$/m.exec(fm[1] ?? '')?.[1]?.trim();
  if (name !== s.name) fail(`${path}.files.SKILL.md`, 'frontmatter `name` must equal the skill name');
  if (!/^description:\s*\S/m.test(fm[1] ?? '')) fail(`${path}.files.SKILL.md`, 'frontmatter needs a description');
}

/**
 * Starter declarations (spec §11 *Starters*): paths naming a `.js` file of a developer skill, one-line summaries, known
 * unique roles, policy mode with js. The modules themselves (exports, knobs schema) are checked when the host first
 * evaluates them (`starterCatalog`), which needs Node and is not part of this browser-safe module.
 */
function checkStarters(starters: unknown, skills: readonly SkillDef[], roles: readonly string[], control: ControlModes): void {
  if (!isObj(starters)) fail('starters', 'must be an object');
  const entries = Object.entries(starters);
  if (entries.length === 0 || entries.length > MAX_STARTERS) fail('starters', `declare 1..${MAX_STARTERS} starters (omit the member for none)`);
  if (!control.policy?.runtimes.includes('js')) fail('starters', 'starters need control.policy with the js runtime');
  for (const [path, def] of entries) {
    const at = `starters.${path}`;
    const slash = path.indexOf('/');
    const skill = slash > 0 ? skills.find((s) => s.name === path.slice(0, slash)) : undefined;
    const file = path.slice(slash + 1);
    if (path.length > STARTER_PATH_MAX || !skill || !file.endsWith('.js') || !Object.hasOwn(skill.files, file)) {
      fail(at, 'must name a .js file of one of the manifest\'s skills as "<skill>/<path>.js"');
    }
    if (!isObj(def) || Object.keys(def).some((k) => k !== 'summary' && k !== 'roles')) fail(at, 'must be {summary, roles?}');
    if (!isText(def.summary, STARTER_SUMMARY_MAX) || /[\r\n]/.test(def.summary)) fail(`${at}.summary`, `one line, 1..${STARTER_SUMMARY_MAX} chars`);
    if (def.roles !== undefined) {
      const list = def.roles;
      if (!Array.isArray(list) || list.length === 0 || new Set(list).size !== list.length || list.some((r) => !roles.includes(r as string))) {
        fail(`${at}.roles`, 'a nonempty list of unique manifest roles');
      }
    }
  }
}

/**
 * Typed identity helper: returns the manifest unchanged (with its inferred schema types) after validating it.
 * Throws a descriptive error at startup for anything PlayerThree cannot serve safely: non-closed schemas,
 * intents for unknown roles, an event schema without `tick: int` / `kind: enum`, invalid skills, insane limits.
 */
export function defineManifest<const M extends AnyManifest>(m: M): M {
  if (!isObj(m)) fail('manifest', 'must be an object');
  if (typeof m.id !== 'string' || !GAME_ID.test(m.id)) fail('id', `must match ${GAME_ID}`);
  if (!isText(m.version, 64)) fail('version', 'required (≤64 chars)');
  if (!isText(m.title, 200)) fail('title', 'required (≤200 chars)');
  if (!isText(m.doc, DOC_MAX)) fail('doc', `required (≤${DOC_MAX} chars; move details into topics)`);
  checkNum('tickRate', m.tickRate, 1, 1000);
  checkEnum('teams', m.teams);
  checkEnum('roles', m.roles);
  checkEnum('errors', m.errors);
  checkEnum('opponents', m.opponents);
  const roles = m.roles.values as readonly string[];
  if (!isObj(m.roleDocs)) fail('roleDocs', 'required');
  for (const r of roles) if (!isText(m.roleDocs[r], ROLE_DOC_MAX)) fail(`roleDocs.${r}`, `every role needs a doc (≤${ROLE_DOC_MAX} chars)`);
  for (const k of Object.keys(m.roleDocs)) if (!roles.includes(k)) fail(`roleDocs.${k}`, 'not a role');
  checkTopics(m.topics);

  if (!isObj(m.intents) || Object.keys(m.intents).length === 0) fail('intents', 'at least one intent is required');
  for (const [kind, d] of Object.entries(m.intents as Record<string, unknown>)) {
    const path = `intents.${kind}`;
    if (!ENUM_LITERAL.test(kind)) fail(path, `intent name must match ${ENUM_LITERAL}`);
    if (!isObj(d)) fail(path, 'must be an object');
    if (!Array.isArray(d.roles) || d.roles.length === 0) fail(`${path}.roles`, 'must list at least one role');
    for (const r of d.roles) if (!roles.includes(r)) fail(`${path}.roles`, `unknown role ${JSON.stringify(r)}`);
    if (!isText(d.doc, 4000)) fail(`${path}.doc`, 'required');
    checkFieldsDef(`${path}.params`, d.params);
    if (isObj(d.params) && 'kind' in d.params) fail(`${path}.params`, '`kind` is reserved for the intent tag');
  }
  checkSchemaDef('observation', m.observation);
  if (m.observationScope !== undefined) checkObservationScope(m.observationScope, roles);
  if ((m.observation as Schema).t === 'obj' && 'phase' in (m.observation as ObjS).fields) fail('observation.phase', 'reserved: `phase` marks the lobby state');
  checkSchemaDef('view', m.view);
  if (m.observer !== undefined) checkSchemaDef('observer', m.observer);
  checkSchemaDef('report', m.report);
  if (m.matchData !== undefined) {
    checkSchemaDef('matchData', m.matchData);
    if (m.matchData.t !== 'obj') fail('matchData', 'must be a t.obj');
  }
  if (m.lobby !== undefined) {
    checkSchemaDef('lobby', m.lobby);
    if (m.lobby.t !== 'obj') fail('lobby', 'must be a t.obj');
  }
  checkSchemaDef('directive', m.directive);
  if (m.directive.t !== 'obj') fail('directive', 'must be a t.obj');
  if (m.limits !== undefined) {
    checkSchemaDef('limits', m.limits);
    if (m.limits.t !== 'obj') fail('limits', 'must be a t.obj');
    for (const [k, f] of Object.entries((m.limits as ObjS).fields)) {
      if (f.t !== 'opt') fail(`limits.${k}`, 'every limit must be t.opt (a missing limit means the game default)');
    }
  }
  checkSchemaDef('event', m.event);
  if (m.event.t !== 'obj') fail('event', 'must be a t.obj');
  const ef = (m.event as ObjS).fields;
  if (ef.tick?.t !== 'int') fail('event.tick', 'event must have a `tick: t.int` field');
  if (ef.kind?.t !== 'enum') fail('event.kind', 'event must have a `kind: t.enum` field');
  if (m.matchOptions !== undefined) {
    checkSchemaDef('matchOptions', m.matchOptions);
    if (m.matchOptions.t !== 'obj') fail('matchOptions', 'must be a t.obj');
    for (const [k, f] of Object.entries((m.matchOptions as ObjS).fields)) {
      if (f.t !== 'opt') fail(`matchOptions.${k}`, 'every option must be t.opt (a missing option means the game default)');
    }
  }

  if (!Array.isArray(m.skills)) fail('skills', 'must be an array');
  m.skills.forEach((s: unknown, i: number) => checkSkill(`skills[${i}]`, s));
  if (new Set(m.skills.map((s: SkillDef) => s.name)).size !== m.skills.length) fail('skills', 'duplicate skill name');
  const reference = `${m.id}-reference`;
  if (!SKILL_NAME.test(reference)) fail('id', 'must form a valid skill name `<id>-reference` (no trailing or doubled hyphens)');
  if (m.skills.some((s: SkillDef) => s.name === reference)) fail('skills', `${reference} is reserved for the generated reference skill`);
  if (m.skills.some((s: SkillDef) => s.name.startsWith('playerthree-'))) fail('skills', 'the playerthree- prefix is reserved for SDK default skills');
  checkControl(m.control, m.tickRate);
  if (m.starters !== undefined) checkStarters(m.starters, m.skills, roles, m.control);
  checkSignals(m, fail, checkFieldsDef);
  intentSchema(m);
  return m;
}
