/**
 * The remote MCP binding. Serves both protocol eras every current harness speaks: 2026-07-28 (per-request `_meta`
 * envelope, `server/discover`) and 2025-era clients (the `initialize` handshake: oh-my-pi, pi, OpenCode and other
 * clients on the 2025-11-25 SDKs) through the SDK's stateless legacy serving, from the same server factory.
 * Temporary match-seat credentials keep an exact authority lease via mcp-session-id in either era.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  McpServer,
  ProtocolErrorCode,
  type CallToolResult,
  ResourceNotFoundError,
  type ClientCapabilities,
  type InputRequiredResult,
  type ServerContext,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Tool,
} from '@modelcontextprotocol/server';
import { memorySkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { servedSkills, surfaceHash } from '../briefing.ts';
import { MCP_TOOL_NAMES, type ControlMethod, type LobbyState, type OwnerMessage, type PolicySource, type PracticeRequest, type SeatControl, type SeatStatus } from '../control.ts';
import { PlayerThreeError } from '../host/index.ts';
import type { PlayerThreeHost, PlayerThreeMatch, AuthorizationLease, CommanderAgent, DecisionUsage } from '../host/types.ts';
import { RESULT_TEXT_MAX, type AnyManifest, type DetailRequest, type PolicyRuntime, type SkillDef } from '../manifest.ts';
import { MAX_MESSAGE_BYTES, TOKEN_RE } from '../protocol.ts';
import { toJsonSchema } from '../schema.ts';
import type { PolicyPackage } from '../policy-package.ts';
import { checkArgs } from './args.ts';
import { toWebRequest, writeWebResponse } from './http.ts';
import { SURFACE_HASH_META, type ToolErrorCode } from './meta.ts';
import { ACCESS_TOKEN_PREFIX, type AuthorizationServer, type OAuthGrant } from './oauth/server.ts';
import { pageObservation, type ObservationPage } from './paging.ts';
import { toolSurface } from './surface.ts';

export interface ConsentEvent {
  /** Empty for a commander token (it is not bound to one match). */
  match: string;
  /** Empty for a commander token. */
  team: string;
  role: string;
  /** Commander tokens: the roster owner id the game registered. */
  owner?: string;
  /** `elicitation`: the human answered the consent form. `implicit`: the client cannot elicit; adding the server with the token is the consent. */
  via: 'elicitation' | 'implicit';
  granted: boolean;
}

/** Options of the MCP endpoint. */
export interface McpOptions {
  /**
   * Exact `Origin` values allowed to call the endpoint (DNS-rebinding protection). Requests carrying any other
   * Origin are rejected with 403. Non-browser MCP clients send no Origin. Default: none.
   */
  allowedOrigins?: readonly string[];
  /**
   * The OAuth authorization server (`createAuthorizationServer`): its access tokens authenticate OAuth
   * connections (one named commander + compatible role grants), and 401s carry its challenge. Seat/commander tokens keep
   * working next to it.
   */
  auth?: AuthorizationServer;
  /** Observe consent decisions (e.g. to log them or show them in the owner's UI). */
  onConsent?: (event: ConsentEvent) => void;
  /** Out-of-band errors (SDK errors, internal failures). Never forwarded to agents. */
  onError?: (error: Error) => void;
  /**
   * Every seat on this endpoint authors policies in the lobby ahead of play (a benchmark's authoring phase): the server
   * instructions orient a policy author with facts (tools, where the docs are, what a policy is) instead of the live
   * commander's play order. Needs policy mode; ignored without it.
   */
  authoring?: boolean;
}

/** The MCP endpoint as a request handler with a node:http face and a web-standard `fetch` face. */
export interface McpRequestHandler {
  /** node:http face: fully handles the response. Does not check the path — route before calling. */
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Web-standard face. */
  fetch(request: Request): Promise<Response>;
  /** Aborts in-flight exchanges. */
  close(): Promise<void>;
  readonly surfaceHash: string;
}

interface SeatState {
  /** `oauth`: the owner approved the connection on the game's consent page. */
  consent?: 'elicitation' | 'implicit' | 'oauth';
  implicitNoted: boolean;
  tokens: number;
  refilledAt: number;
  inflight: number;
  waits: Map<string, number>;
  /** Per role: the last paged game_observe snapshot, served by `{ page: n }` until the next unpaged call. */
  observations: Map<string, { tick: number; pages: ObservationPage[] }>;
}

/** One role a credential commands, and where it is. */
interface Command {
  role: string;
  phase: 'lobby' | 'match';
  team?: string;
}

interface Target {
  control: SeatControl;
  drain(): OwnerMessage[];
  status(): SeatStatus;
  reportUsage(report: DecisionUsage): void;
}

interface SeatSession {
  /** The roles the credential commands right now (read live: connection role edits apply to the next call). */
  commands(): Command[];
  target(role: string): Target | undefined;
  /** Consent event identity (match/team empty and owner set for commander tokens). */
  who: { match: string; team: string; role: string; owner?: string; commanderId?: string };
  /** Consent prompt subject. */
  subject: string;
  commander: boolean;
  state: SeatState;
  grant?: OAuthGrant;
  authorized(): boolean;
}

const CACHE_HINT = { ttlMs: 3_600_000, cacheScope: 'private' } as const;
/** Room in a paged game_observe result for page metadata, the trailer line and a consent note. */
const OBSERVE_RESERVE = 2_000;
const CALLS_PER_SECOND = 10;
const CALL_BURST = 20;
const MAX_INFLIGHT = 4;
const MAX_WAITS_PER_ROLE = 2;
const PROGRESS_EVERY_MS = 1000;
const MODERN_PROTOCOL_VERSION = '2026-07-28';
/** Negotiable revisions: the legacy `initialize` handshake offers the first 2025-era entry; 2026-07-28 via `server/discover`. */
const PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS];
/** The 2026-07-28 HeaderMismatch error code (not in the SDK's exported ProtocolErrorCode enum). */
const HEADER_MISMATCH = -32020;

const UNAUTHORIZED_BODY = JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });

function unauthorized(challenge: string): Response {
  return new Response(UNAUTHORIZED_BODY, {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': challenge },
  });
}

/** Whether a complete JSON response body is a JSON-RPC error response (no result). */
function isErrorResponse(text: string): boolean {
  try {
    const message: unknown = JSON.parse(text);
    return typeof message === 'object' && message !== null && 'error' in message && !('result' in message);
  } catch {
    return false;
  }
}

function toolError(code: ToolErrorCode, hash: string, extra?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, ...extra }) }],
    isError: true,
    _meta: { [SURFACE_HASH_META]: hash },
  };
}

/**
 * The text content of a successful result. Topic and skill pages are raw text (not JSON-escaped: harnesses show it
 * as written and count it once), followed by a one-line paging trailer; a paged observation is JSON plus a trailer;
 * everything else is the JSON of `structuredContent`.
 */
function resultText(method: ControlMethod | 'usage', s: Record<string, unknown>, a: ToolArgs): string {
  const role = a.role === undefined ? {} : { role: a.role };
  if (method === 'briefing' && a.topic !== undefined) {
    const { topic, page, pages, text } = s as { topic: string; page: number; pages: number; text: string };
    if (pages === 1) return text;
    return `${text}\n[page ${page}/${pages}${page < pages ? ` — next: game_briefing ${JSON.stringify({ topic, page: page + 1, ...role })}` : ' — end of topic'}]`;
  }
  if (method === 'skill') {
    const { name, path, text, next } = s as { name: string; path: string; text: string; next?: number };
    if (next === undefined) return text;
    return `${text}${text.endsWith('\n') ? '' : '\n'}[… continues: game_skill ${JSON.stringify({ name, path, offset: next })}]`;
  }
  if (method === 'policyExport') {
    // Like a topic page: the raw slice of the package JSON, then where the package continues (or that it ends).
    const { version, page, pages, text } = s as { version: number; page: number; pages: number; text: string };
    return `${text}\n[page ${page}/${pages}${page < pages ? ` — next: policy_export ${JSON.stringify({ version, page: page + 1, ...role })}` : ' — end of package'}]`;
  }
  const json = JSON.stringify(s);
  if ((method === 'observe' || method === 'wait') && typeof s['page'] === 'number') {
    const { page, pages, tick } = s as { page: number; pages: number; tick: number };
    return `${json}\n[observation page ${page}/${pages} of the snapshot at tick ${tick}${page < pages ? ` — next: game_observe ${JSON.stringify({ page: page + 1, ...role })}` : ''}; pass fields (top-level keys) to fetch less]`;
  }
  return json;
}

/** One page of a paged observation snapshot, with its paging metadata. */
function observationPage(snapshot: { tick: number; pages: ObservationPage[] }, page: number): Record<string, unknown> {
  const p = snapshot.pages[page - 1]!;
  return {
    observation: p.observation, page, pages: snapshot.pages.length, tick: snapshot.tick,
    ...(page < snapshot.pages.length ? { next: { page: page + 1 } } : {}),
    ...(p.items ? { items: p.items } : {}),
  };
}

/** The control plane's pre-match result (control.ts `LobbyState`): manifests reserve a top-level observation `phase`. */
function isLobbyState(value: unknown): value is LobbyState {
  return value !== null && typeof value === 'object' && 'phase' in value && value.phase === 'lobby';
}

function formElicitationAdvertised(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const elicitation = (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined)?.elicitation;
  if (!elicitation) return false;
  // A bare `elicitation: {}` declares form support.
  return elicitation.form !== undefined || elicitation.url === undefined;
}

/**
 * Static server instructions. Only PlayerThree text and developer-declared manifest data. `authoring`: every seat
 * authors policies ahead of play ({@link McpOptions.authoring}).
 */
export function serverInstructions(manifest: AnyManifest, hash: string, opts: { authoring?: boolean } = {}): string {
  if (opts.authoring && manifest.control.policy) return authoringInstructions(manifest, hash);
  const c = manifest.control;
  const loop: string[] = [
    'Follow your seat’s mandate (game_briefing `mandate`): autonomous → decide and act without asking; supervised → propose deploys, your owner approves. Stay within your seat’s scopes and limits.',
    `Order: 1. game_briefing (core: rules, your role doc, mandate, one-line topic index; the role doc may name one topic to read first); ${c.policy ? `2. with policy scope, deploy a working policy for every role you command next${manifest.starters ? ' (a starter by reference is one call: policy_deploy {from,role}, topic `starters`)' : ''}; 3.` : '2.'} topics (game_briefing {topic}; follow \`next\` through pages) and skill files (${manifest.skills.length > 0 ? `the game's strategy skill: game_skill name ${(manifest.skills as readonly SkillDef[]).map((s) => s.name).join(' / ')}, path SKILL.md` : `the ${manifest.id}-reference skill`}). Follow playerthree-commander (game_skill name playerthree-commander, path SKILL.md, or the MCP skills extension) for the lifecycle; the PlayerThree default skills carry workflows, the game’s own skills carry strategy.`,
    `Every tool result is at most ${RESULT_TEXT_MAX} characters: topics and skill files are paged (follow the trailer line), and an oversize game_observe is paged from a snapshot (game_observe {page}) or narrowed with {fields}.`,
  ];
  if (c.policy) {
    loop.push(
      'A deployed policy plays at tick rate while you think; supervised deploys await owner approval. When you are absent, your mandate’s whenAbsent setting controls whether the policy, fallback bot, or nothing plays.',
      `${policyProgram(manifest)} Writing one: skill playerthree-policy-author, topic \`modes\` (the policy API).${manifest.starters ? ' A starter is a baseline to tune or fork.' : ''} Improving your policy is how you play well.`,
    );
    if (c.practice) loop.push('Practice early and often against the strongest opponents (practice_run); read the report and policy_status logs; revise and redeploy.');
    loop.push('Keep the deployed policy working: if a change breaks it, policy_rollback.');
  } else if (c.practice) {
    loop.push('Practice early against the strongest opponents (practice_run) and read the reports.');
  }
  if (c.pausable) loop.push('This game can pause: when your mandate’s whenAbsent is pause, the session stands still while you are away and resumes at your next call, so do not leave a seat idle mid-session.');
  loop.push('Then monitor cheaply with game_wait / game_observe, and use game_act for decisive moments. While a match is live, keep that loop going until it ends instead of stopping to report.');
  if (c.sequence) loop.push('Use game_sequence for bounded tick-relative plans; a new sequence replaces the previous one, and empty steps cancels it.');
  loop.push('A supervised policy deploy, rollback or publish returns an approval request rather than taking effect. Check policy_status for its outcome; game_wait wakes with approval when your owner resolves it.');
  if (c.chat) {
    loop.push(
      'Your owner (the player you work for) may message you: game_wait returns early and game_observe includes them as `messages` from "owner". Follow their orders unless the rules forbid it, and answer briefly with game_say (only your owner sees it).',
    );
  }
  if (manifest.signals) {
    loop.push(
      'Teammates (humans, agents, policies, bots) ask each other for help with typed team signals (briefing topic `signals`): read your `signals.inbox` in game_observe (game_wait wakes with `wake: signal`), answer with a `signal_update` intent (ack, then done, or decline / fail), and ask with a `signal` intent when your plan needs a teammate. Your policy sees the same `signals` member in think().',
    );
  }
  return [
    `PlayerThree seat server for "${manifest.title}" (${manifest.id} ${manifest.version}). surfaceHash: ${hash}`,
    `How to play well: ${loop.join(' ')}`,
    `Turns: a reply without a tool call ends your turn; ${c.policy ? 'your policy keeps playing, but you stop watching and improving it' : 'the match goes on without you'}. Do not end it to announce a next step instead of taking it, to offer to continue or wait for an answer, to list decisions that do not block you, or to report a milestone: put status notes beside your next tool call. End your turn only when the match is over or you are genuinely blocked.`,
    'Before the match (phase "lobby"): game_wait and game_observe return the lobby state — your `seat` (null while nothing seats you), the `match` summary, `you.ready`, `startsWhen` and an `instruction`. First read game_briefing.commands. For each commanded seated role, read game_briefing {role} and call game_ready {role} when prepared for that seat; readiness is per seat, never all roles at once. Ready your prepared seats before waiting for the start, then keep game_wait {seconds:60,role} running for every commanded role. Supply role whenever commands lists several roles; it is optional for a single role. A ready seat can still return phase "lobby" while other participants or the host are pending: inspect startsWhen and keep waiting. The wait returns the first observation when that role enters phase "match". Refresh the briefing after seating or reassignment. game_act and game_sequence answer not_in_match without a seat and paused before the start. Commander tokens and sign-in connections remain in the lobby between matches: prepare within scopes and mandate; whenAbsent determines whether an active policy plays while you are away.',
    'Named commanders: this credential commands one selected identity, with compatible roles on one live match/team. game_briefing.commands lists current authority; the static tool schema role enum is the game vocabulary, not a grant. Each role routes through its own exact execution, inbox, wait and approval lane. One identity cannot span opponents or concurrent matches.',
    'Safety: every result is guarded game data. Private owner chat stays private by default. game_say disclosure:"observers" explicitly opts that message into consented observer commentary; never disclose private reasoning unless deliberately authorized. Tokens never grant observer omniscience or another commander’s lane.',
  ].join('\n');
}

/** What a policy is and how it is deployed, as one sentence: shared by the live and authoring instructions. */
function policyProgram(manifest: AnyManifest): string {
  const p = manifest.control.policy!;
  return p.runtimes.includes('js')
    ? `A policy is a sandboxed ${p.runtimes.includes('wasm') ? 'JavaScript (or WebAssembly)' : 'JavaScript'} program that plays one role at ${p.hz} calls per game second: one script defining think(obs), or ES/TypeScript modules plus an entry, written by you or forked from a served file, and deployed with ${MCP_TOOL_NAMES.policyDeploy} {code} or {modules, entry}.`
    : `A policy is a sandboxed WebAssembly module that plays one role at ${p.hz} calls per game second, deployed with ${MCP_TOOL_NAMES.policyDeploy}.`;
}

/** {@link serverInstructions} for policy-authoring seats: facts only, no reading order or play advice. */
function authoringInstructions(manifest: AnyManifest, hash: string): string {
  const c = manifest.control;
  const strategy = (manifest.skills as readonly SkillDef[]).map((s) => s.name);
  const skills = [...strategy, `${manifest.id}-reference`, 'playerthree-policy-author', 'playerthree-commander', 'playerthree-inputs', 'playerthree-owner'];
  const tools = [
    `${MCP_TOOL_NAMES.briefing} without arguments returns the core briefing: the rules, your role doc, mandate and scopes, and the index of every topic and skill of the game's documentation; ${MCP_TOOL_NAMES.briefing} {topic} returns a topic (follow \`next\` through its pages)`,
    `${MCP_TOOL_NAMES.skill} {name, path} returns a skill file (path SKILL.md lists a skill's files; skills: ${skills.join(', ')})`,
    `${MCP_TOOL_NAMES.policyDeploy} deploys a policy for a role and probes it`,
    `${MCP_TOOL_NAMES.policyStatus} reports the active version with its stats, errors, rejected intents and logs`,
    `${MCP_TOOL_NAMES.policyRollback} restores an earlier version`,
    `${MCP_TOOL_NAMES.policyExport} and ${MCP_TOOL_NAMES.policyImport} move policies in and out of your library`,
    ...(c.practice ? [`${MCP_TOOL_NAMES.practice} plays a practice match of a policy against a built-in opponent (at most ${c.practice.maxTicks} ticks) and returns its report`] : []),
    `${MCP_TOOL_NAMES.observe} and ${MCP_TOOL_NAMES.wait} return the lobby state while no match is running`,
  ];
  const starters = manifest.starters
    ? ` The game's starters (topic \`starters\`) are complete built-in policies served as skill files: deploy one by reference (${MCP_TOOL_NAMES.policyDeploy} {from, role}) or read it and fork it.`
    : '';
  const guide = ` Writing one: skill playerthree-policy-author; topics \`modes\` (the policy API), \`observation\`, \`intents\` and \`types\`${strategy.length > 0 ? `; the game's strategy skill${strategy.length > 1 ? 's' : ''} ${strategy.join(', ')}` : ''}.`;
  const facts = [
    'This seat authors policies in the lobby: the policies you deploy play your roles in later matches without you.',
    `Tools: ${tools.join('; ')}.`,
    `${policyProgram(manifest)}${starters}${guide}`,
    'Follow your seat’s mandate (game_briefing `mandate`): autonomous → decide and act without asking; supervised → propose deploys, your owner approves. Stay within your seat’s scopes and limits.',
    `Every tool result is at most ${RESULT_TEXT_MAX} characters: topics and skill files are paged (follow the trailer line).`,
    'Supply role on every seat call whenever game_briefing.commands lists several roles; it is optional for a single role.',
  ];
  if (manifest.signals) facts.push('Team signals (topic `signals`): a policy sees them as the `signals` member of think(obs) and answers or sends them as `signal_update` / `signal` intents.');
  return [
    `PlayerThree seat server for "${manifest.title}" (${manifest.id} ${manifest.version}). surfaceHash: ${hash}`,
    `Policy authoring: ${facts.join(' ')}`,
    'Safety: every result is guarded game data. Private owner chat stays private by default. Tokens never grant observer omniscience or another commander’s lane.',
  ].join('\n');
}

/** Union of every tool's arguments. Each call's arguments were checked against that tool's input schema first. */
interface ToolArgs {
  topic?: string;
  page?: number;
  since?: number;
  fields?: string[];
  detail?: DetailRequest;
  intents?: unknown[];
  steps?: { in: number; intents: unknown[] }[];
  cancelOn?: string[];
  seconds?: number;
  until?: string[];
  name?: string;
  path?: string;
  offset?: number;
  runtime?: PolicyRuntime;
  code?: string;
  modules?: Record<string, string>;
  entry?: string;
  include?: string[];
  from?: string;
  knobs?: Record<string, unknown>;
  version?: number;
  opponent?: string;
  ticks?: number;
  seed?: number;
  allies?: string;
  artifact?: PolicySource;
  options?: Record<string, unknown>;
  text?: string;
  disclosure?: 'observers';
  category?: 'summary' | 'chat';
  package?: PolicyPackage;
  /** Which of the credential's roles the call is for. */
  role?: string;
}

/** Request-shaped artifact: only the artifact members that were given (the host rejects unknown keys and mixtures). */
const artifactOf = (a: Pick<ToolArgs, 'runtime' | 'code' | 'modules' | 'entry' | 'include' | 'from' | 'knobs'>): PolicySource => {
  const out: Record<string, unknown> = {};
  for (const key of ['runtime', 'code', 'modules', 'entry', 'include', 'from', 'knobs'] as const) if (a[key] !== undefined) out[key] = a[key];
  return out as PolicySource;
};

async function invoke(target: Target, method: ControlMethod, a: ToolArgs): Promise<Record<string, unknown>> {
  const control = target.control;
  switch (method) {
    case 'briefing':
      return { ...(a.topic === undefined ? await control.briefing() : await control.briefing(a.topic, a.page)) };
    case 'observe':
      throw new Error('unreachable: game_observe is paged by the endpoint');
    case 'act':
      return { acks: await control.act(a.intents!) };
    case 'sequence':
      return { ...(await control.sequence(a.cancelOn === undefined ? { steps: a.steps! } : { steps: a.steps!, cancelOn: a.cancelOn })) };
    case 'wait':
      throw new Error('unreachable: game_wait bounds its entry observation at the endpoint');
    case 'ready':
      return { ...(await control.ready()) };
    case 'skill':
      // `name` is enum-validated against the served skills and `path` against the skill path grammar; the host
      // resolves both (unknown file → invalid).
      return { ...(await control.skill(a.name!, a.path!, a.offset)) };
    case 'policyDeploy':
      return { ...(await control.policyDeploy(artifactOf(a))) };
    case 'policyStatus':
      return { policy: await control.policyStatus() };
    case 'policyRollback':
      return { ...(await control.policyRollback(a.version!)) };
    case 'policyExport':
      return { ...(await control.policyExport({ ...(a.version === undefined ? {} : { version: a.version }), ...(a.page === undefined ? {} : { page: a.page }) })) };
    case 'policyImport':
      return { ...(await control.policyImport(a.package!)) };
    case 'practice': {
      const req: PracticeRequest = { opponent: a.opponent!, ticks: a.ticks! };
      if (a.seed !== undefined) req.seed = a.seed;
      if (a.allies !== undefined) req.allies = a.allies;
      if (a.artifact !== undefined) req.artifact = artifactOf(a.artifact);
      if (a.options !== undefined) req.options = a.options;
      return { ...(await control.practice(req)) };
    }
    case 'publish':
      return { ...(await control.publish()) };
    case 'say':
      return { ...(await control.say(a.text!, a.disclosure === 'observers' ? { audience: 'observers', category: a.category ?? 'chat' } : undefined)) };
  }
}

/** The remote MCP endpoint for `typedHost`, unmounted; {@link mountMcp} wires it (and the authorization server) into a node:http server. */
export function createMcpRequestHandler<M extends AnyManifest>(typedHost: PlayerThreeHost<M>, opts: McpOptions = {}): McpRequestHandler {
  // The endpoint is manifest-agnostic; erasing M here avoids deep instantiation of concrete manifest types.
  const host = typedHost as unknown as PlayerThreeHost;
  const manifest = host.definition.manifest;
  const skills: readonly SkillDef[] = servedSkills(manifest);
  const surface = toolSurface(manifest, skills);
  const hash = surfaceHash(manifest);
  const instructions = serverInstructions(manifest, hash, { authoring: opts.authoring === true });
  const byName = new Map(surface.map((s) => [s.name, s]));
  const knownNames = new Set(Object.values(MCP_TOOL_NAMES));
  const ajv = new AjvJsonSchemaValidator();
  const outputValidators = new Map(surface.map((s) => [s.name, ajv.getValidator<unknown>(s.outputSchema as never)]));
  // Input and output schema roots are always `{ type: 'object', … }` (surface.ts).
  const listed = surface.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    outputSchema,
    annotations,
  })) as Tool[];
  const allowedOrigins = new Set(opts.allowedOrigins ?? []);
  // SDK/adapter errors can contain request URLs, schemas, policy text or credentials. Never relay their text.
  const report = (_error: unknown) => opts.onError?.(new Error('playerthree/mcp: internal failure'));
  const statusKey = randomBytes(32);
  const statusUri = (key: string, role: string): string =>
    `playerthree://seat/${createHmac('sha256', statusKey).update(JSON.stringify([key, role])).digest('base64url')}`;

  const skillFiles: Record<string, string> = {};
  for (const s of skills) for (const [path, content] of Object.entries(s.files)) skillFiles[`${s.name}/${path}`] = content;
  // Built once; strict so malformed developer skills fail loudly at startup instead of being served half-valid.
  const skillsExtension = SkillsExtension.load(memorySkillFiles(skillFiles), { prefix: manifest.id, cacheHint: CACHE_HINT, strict: true });
  skillsExtension.catch(report);

  const newState = (): SeatState => ({ implicitNoted: false, tokens: CALL_BURST, refilledAt: Date.now(), inflight: 0, waits: new Map(), observations: new Map() });
  const observationSchema = toJsonSchema(manifest.observation);

  /**
   * game_observe with bounded results. Without `page` (or page 1) it observes now; a result too large for one tool
   * result is snapshotted per role and page 1 returned. `page` ≥ 2 serves that snapshot, however old (its `tick` says
   * so), until the next unpaged call replaces it; without one → invalid.
   */
  async function observe(target: Target, state: SeatState, role: string, a: ToolArgs): Promise<Record<string, unknown>> {
    if (a.page !== undefined && a.page > 1) {
      const snapshot = state.observations.get(role);
      if (!snapshot || a.page > snapshot.pages.length) throw new PlayerThreeError('invalid');
      return observationPage(snapshot, a.page);
    }
    const full = await target.control.observe(a.since, a.detail);
    // Owner messages travel next to (never inside) the closed-vocabulary observation.
    const messages = target.drain();
    const extra = messages.length > 0 ? { messages } : {};
    // Before the start the seat has no observation yet: its lobby state (observation schemas reserve `phase`).
    if (isLobbyState(full)) return { ...full, ...extra };
    const observation = a.fields && full !== null && typeof full === 'object'
      ? Object.fromEntries(a.fields.filter((k) => Object.hasOwn(full, k)).map((k) => [k, (full as Record<string, unknown>)[k]]))
      : full;
    return { ...bounded(state, role, observation, target.status().tick, messages.length > 0 ? JSON.stringify(messages).length + 12 : 0), ...extra };
  }

  /**
   * An observation within one tool result: whole when it fits the budget (less `reserved` characters for what rides
   * along), else page 1 of a per-role snapshot that game_observe {page} serves on.
   */
  function bounded(state: SeatState, role: string, observation: unknown, tick: number, reserved: number): Record<string, unknown> {
    const budget = RESULT_TEXT_MAX - OBSERVE_RESERVE - reserved;
    if ((JSON.stringify(observation) ?? '').length <= budget) {
      state.observations.delete(role);
      return { observation };
    }
    const snapshot = { tick, pages: pageObservation(observation, observationSchema, budget) };
    state.observations.set(role, snapshot);
    return observationPage(snapshot, 1);
  }

  /** game_wait: the match entry's first observation is bounded like game_observe (later pages via game_observe {page}). */
  async function wait(target: Target, state: SeatState, role: string, a: ToolArgs): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = { ...(await target.control.wait(a.until ? { seconds: a.seconds!, until: a.until } : { seconds: a.seconds! })) };
    if (result['phase'] !== 'match' || result['observation'] === undefined) return result;
    const { observation, ...rest } = result;
    return { ...rest, ...bounded(state, role, observation, rest['tick'] as number, JSON.stringify(rest).length) };
  }
  const seatStates = new WeakMap<PlayerThreeMatch, Map<string, SeatState>>();
  const stateFor = (match: PlayerThreeMatch, key: string): SeatState => {
    let perMatch = seatStates.get(match);
    if (!perMatch) seatStates.set(match, (perMatch = new Map()));
    let state = perMatch.get(key);
    if (!state) perMatch.set(key, (state = newState()));
    return state;
  };
  // Commander tokens outlive matches: their state (consent, rate limit) is kept per token generation; OAuth
  // connections per connection (consent was given on the game's page).
  const longStates = new Map<string, SeatState>();
  const longState = (key: string, consent?: 'oauth'): SeatState => {
    let state = longStates.get(key);
    if (!state) longStates.set(key, (state = { ...newState(), ...(consent ? { consent } : {}) }));
    return state;
  };

  const consentCodec = createRequestStateCodec<{ consent: 1 }>({
    key: randomBytes(32),
    ttlSeconds: 900,
    bind: (ctx) => `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`,
  });

  /** OAuth grants route only the named commander and its selected compatible role. */
  function connectionSession(grant: OAuthGrant, token: string): SeatSession {
    const agents = new Map<string, CommanderAgent | undefined>();
    const agent = (role: string): CommanderAgent | undefined => {
      if (!agents.has(role)) agents.set(role, host.commanders.agent(grant.owner, grant.commander, () => grant.holds(role), role));
      return agents.get(role);
    };
    return {
      commands: () =>
        grant.roles().flatMap((role): Command[] => {
          const seat = agent(role)?.seat();
          if (seat === undefined) return [];
          if (seat && seat.role !== role) return [];
          return [seat ? { role, phase: agent(role)!.status().phase, team: seat.team } : { role, phase: 'lobby' }];
        }),
      target: (role) => (grant.holds(role) ? agent(role) : undefined),
      who: { match: '', team: '', role: '', owner: grant.owner, commanderId: grant.commander },
      subject: 'your selected commander',
      commander: true,
      state: longState(`oauth:${grant.connection}`, 'oauth'),
      grant,
      authorized: () => opts.auth?.verify(token) !== undefined,
    };
  }

  /** `missing`: no credential (or not a bearer one); `invalid`: a credential that does not authenticate. */
  function authenticate(request: Request, binding?: SeatBinding): { session: SeatSession; key: string; token: string } | 'missing' | 'invalid' {
    const header = request.headers.get('authorization');
    const m = header ? /^Bearer ([^\s]+)$/i.exec(header.trim()) : null;
    const token = m?.[1];
    if (!token) return 'missing';
    if (opts.auth && token.startsWith(ACCESS_TOKEN_PREFIX)) {
      const grant = opts.auth.verify(token);
      if (!grant) return 'invalid';
      grant.activity(0);
      return { session: connectionSession(grant, token), key: `oauth:${grant.connection}`, token };
    }
    if (!TOKEN_RE.test(token)) return 'invalid';
    const auth = host.agentSession(token);
    if (!auth) return 'invalid';
    const key = createHash('sha256').update(token).digest('hex').slice(0, 32);
    const lease = auth.kind === 'seat' && !binding ? seatConnections.get(request.headers.get('mcp-session-id') ?? '')?.lease : undefined;
    if (auth.kind === 'seat' && !binding && (!lease || host.authorizeLease(lease)?.kind !== 'seat')) return 'invalid';
    if (auth.kind === 'seat' && !binding && seatConnections.get(request.headers.get('mcp-session-id') ?? '')?.key !== key) return 'invalid';
    const session: SeatSession =
      auth.kind === 'seat'
        ? {
            commands: () => [{ role: auth.role, phase: auth.match.status(auth.team, auth.role).phase, team: auth.team }],
            target: (role) => (role === auth.role ? { ...auth, status: () => auth.match.status(auth.team, auth.role) } : undefined),
            who: { match: auth.match.id, team: auth.team, role: auth.role },
            subject: `${auth.team}/${auth.role}`,
            commander: false,
            state: stateFor(auth.match, key),
            // A binding request claims its lease on first use: only after the SDK validated and dispatched it.
            authorized: binding
              ? () => {
                  const bound = binding.lease ?? binding.bind(key);
                  return !!bound && host.authorizeLease(bound)?.kind === 'seat';
                }
              : () => !!lease && host.authorizeLease(lease)?.kind === 'seat',
          }
        : {
            commands: () => {
              const commander = host.commanders.roster(auth.owner).find((entry) => entry.id === auth.commanderId);
              return commander?.roles.flatMap((role): Command[] => {
                const lane = host.agentSession(token, role);
                if (lane?.kind !== 'commander') return [];
                const seat = lane.seat();
                return [seat ? { role, phase: lane.status().phase, team: seat.team } : { role, phase: 'lobby' }];
              }) ?? [];
            },
            target: (role) => {
              const selected = host.agentSession(token, role);
              return selected?.kind === 'commander' && selected.commanderId === auth.commanderId ? selected : undefined;
            },
            who: { match: '', team: '', role: auth.role, owner: auth.owner, commanderId: auth.commanderId },
            subject: `your ${auth.role} commander`,
            commander: true,
            state: longState(auth.key),
            authorized: () => host.agentSession(token)?.kind === 'commander',
          };
    return { session, key, token };
  }

  async function callTool(session: SeatSession, name: string, args: unknown, ctx: ServerContext): Promise<CallToolResult | InputRequiredResult> {
    if (!session.authorized()) return toolError('bad_token', hash);
    const spec = byName.get(name);
    if (!spec) return toolError(knownNames.has(name) ? 'mode_unavailable' : 'bad_message', hash);
    const { state } = session;

    let note: string | undefined;
    if (!state.consent) {
      const answer = inputResponse(ctx.mcpReq.inputResponses, 'consent');
      // An answer only counts when it comes back with the state we minted for this token's consent request.
      const issued = ctx.mcpReq.requestState<{ consent: 1 }>()?.consent === 1;
      if (answer.kind === 'elicit' && issued) {
        if (answer.action === 'accept' && answer.content?.['allow'] === true) {
          state.consent = 'elicitation';
          opts.onConsent?.({ ...session.who, via: 'elicitation', granted: true });
        } else {
          opts.onConsent?.({ ...session.who, via: 'elicitation', granted: false });
          return toolError('consent_declined', hash);
        }
      } else if (formElicitationAdvertised(ctx)) {
        return inputRequired({
          inputRequests: {
            consent: inputRequired.elicit({
              mode: 'form',
              message: session.commander
                ? `Allow an AI agent to be ${session.subject} in ${manifest.title}? It will be seated in your matches automatically, will only receive closed-vocabulary game data (no text from other players) and can only act through the game's typed commands for that seat.`
                : `Allow an AI agent to command ${session.subject} in ${manifest.title}? It will only receive closed-vocabulary game data (no text from other players) and can only act through the game's typed commands for this one seat.`,
              requestedSchema: {
                type: 'object',
                properties: { allow: { type: 'boolean', title: `Allow this agent to command ${session.subject}`, default: false } },
                required: ['allow'],
              },
            }),
          },
          requestState: await consentCodec.mint({ consent: 1 }, ctx),
        });
      } else {
        state.consent = 'implicit';
        opts.onConsent?.({ ...session.who, via: 'implicit', granted: true });
      }
    }
    if (state.consent === 'implicit' && !state.implicitNoted) {
      state.implicitNoted = true;
      note = `PlayerThree: this MCP client does not support consent prompts, so adding this server with the ${session.commander ? 'commander' : 'seat'} token counts as the player’s consent.`;
    }

    const now = Date.now();
    state.tokens = Math.min(CALL_BURST, state.tokens + ((now - state.refilledAt) / 1000) * CALLS_PER_SECOND);
    state.refilledAt = now;
    if (state.tokens < 1) return toolError('rate_limited', hash);
    if (spec.method !== 'wait' && state.inflight >= MAX_INFLIGHT) return toolError('busy', hash);
    state.tokens -= 1;

    const checked = checkArgs(spec.inputSchema, args);
    if (!checked.ok) return toolError('invalid', hash, { schemaCode: checked.code, path: checked.path });

    // Which seat: the `role` argument, else the only role; briefing and skills default to the first one.
    const a = (args ?? {}) as ToolArgs;
    const commands = session.commands();
    let role = a.role;
    if (role === undefined) {
      if (commands.length === 0) return toolError('forbidden', hash);
      if (commands.length > 1 && spec.method !== 'briefing' && spec.method !== 'skill') return toolError('invalid', hash, { schemaCode: 'missing_field', path: ['role'] });
      role = commands[0]!.role;
    }
    const target = commands.some((c) => c.role === role) ? session.target(role) : undefined;
    if (!target) return toolError('forbidden', hash);
    if (spec.method === 'wait' && (state.waits.get(role) ?? 0) >= MAX_WAITS_PER_ROLE) return toolError('busy', hash);

    const progressToken = ctx.mcpReq._meta?.progressToken;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (progressToken !== undefined && (spec.method === 'practice' || spec.method === 'wait')) {
      let progress = 0;
      heartbeat = setInterval(() => {
        if (!session.authorized()) return;
        progress += 1;
        ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress } }).catch(report);
      }, PROGRESS_EVERY_MS);
    }

    if (spec.method === 'wait') state.waits.set(role, (state.waits.get(role) ?? 0) + 1);
    else state.inflight += 1;
    session.grant?.activity(1);
    let structured: Record<string, unknown>;
    try {
      if (spec.method === 'usage') {
        const { role: _role, ...usage } = (args ?? {}) as DecisionUsage & { role?: string };
        target.reportUsage(usage);
        structured = { ok: true };
      } else if (spec.method === 'observe') structured = await observe(target, state, role, a);
      else if (spec.method === 'wait') structured = await wait(target, state, role, a);
      else structured = await invoke(target, spec.method, a);
      // Every role this credential commands, after the call (a briefing in the lobby may already be seated).
      if (spec.method === 'briefing' && a.topic === undefined) structured['commands'] = session.commands();
    } catch (e) {
      // A build failure's detail is own text about the caller's artifact (spec §11), never host internals.
      if (e instanceof PlayerThreeError) return toolError(e.code, hash, e.detail === undefined ? undefined : { ...e.detail });
      report(e);
      return toolError('internal', hash);
    } finally {
      if (spec.method === 'wait') {
        const remaining = (state.waits.get(role) ?? 1) - 1;
        if (remaining) state.waits.set(role, remaining);
        else state.waits.delete(role);
      } else state.inflight -= 1;
      session.grant?.activity(-1);
      clearInterval(heartbeat);
    }

    if (!session.authorized()) return toolError('bad_token', hash);
    const valid = outputValidators.get(spec.name)!(structured);
    if (!valid.valid) {
      report(new Error(`playerthree/mcp: ${spec.name} output does not match its outputSchema: ${valid.errorMessage}`));
      return toolError('internal', hash);
    }
    const content: CallToolResult['content'] = [{ type: 'text', text: resultText(spec.method, structured, a) }];
    if (note) content.push({ type: 'text', text: note });
    return { content, structuredContent: structured, _meta: { [SURFACE_HASH_META]: hash } };
  }

  async function makeServer(session: SeatSession | undefined, key: string): Promise<McpServer> {
      const mcp = new McpServer(
        { name: `playerthree-${manifest.id}`, version: manifest.version },
        {
          instructions,
          cacheHints: { 'tools/list': CACHE_HINT, 'server/discover': CACHE_HINT, 'resources/list': { ttlMs: 0, cacheScope: 'private' }, 'resources/templates/list': CACHE_HINT },
          requestState: { verify: consentCodec.verify },
          supportedProtocolVersions: PROTOCOL_VERSIONS,
        },
      );
      mcp.server.onerror = report;
      mcp.server.registerCapabilities({ tools: { listChanged: false }, resources: { subscribe: true } });
      mcp.server.setRequestHandler('tools/list', () => ({ tools: listed, _meta: { [SURFACE_HASH_META]: hash } }));
      mcp.server.setRequestHandler('tools/call', async (request, hctx) => {
        if (!session) return toolError('bad_token', hash);
        const result = await callTool(session, request.params.name, request.params.arguments, hctx);
        if ('structuredContent' in result && result.structuredContent !== undefined) {
          return mcp.server.projectCallToolResult(result as CallToolResult, byName.get(request.params.name)?.outputSchema);
        }
        return result;
      });
      (await skillsExtension).attach(mcp);
      if (session) {
        for (const command of session.commands()) {
          const uri = statusUri(key, command.role);
          mcp.registerResource(command.role, uri, { mimeType: 'application/json', description: 'Private, non-consuming seat lifecycle status.' }, async () => {
            if (!session.authorized() || !session.commands().some((c) => c.role === command.role)) {
              throw new ResourceNotFoundError('', 'Resource not found');
            }
            const target = session.target(command.role);
            if (!target) throw new ResourceNotFoundError('', 'Resource not found');
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(target.status()) }] };
          });
        }
      }
      return mcp;
  }

  const inner = createMcpHandler(
    async (ctx) => makeServer(ctx.authInfo?.extra?.['session'] as SeatSession | undefined, ctx.authInfo?.clientId ?? ''),
    { legacy: 'stateless', maxRequestBodySize: MAX_MESSAGE_BYTES, onerror: report },
  );

  interface SeatConnection {
    id: string;
    lease: AuthorizationLease;
    key: string;
    exchanges: Set<AbortController>;
  }
  const seatConnections = new Map<string, SeatConnection>();
  /**
   * A seat credential's first request. Its single-use lease is claimed only when the request is dispatched (or
   * answered successfully): the SDK first validates headers, envelope, method and params, so a malformed first
   * request gets its 4xx without consuming the credential or issuing an mcp-session-id.
   */
  interface SeatBinding {
    readonly id: string;
    readonly exchanges: Set<AbortController>;
    lease: AuthorizationLease | undefined;
    bind(key: string): AuthorizationLease | undefined;
  }
  const dropSeat = (id: string): void => {
    const connection = seatConnections.get(id);
    if (!connection) return;
    seatConnections.delete(id);
    host.disconnectLease(connection.lease);
    for (const abort of connection.exchanges) abort.abort();
    connection.exchanges.clear();
  };
  const offLeases = host.onLeaseRevoked((lease) => {
    for (const [id, connection] of seatConnections) if (connection.lease.id === lease.id) dropSeat(id);
  });
  // Expiry must close idle/paused sessions too, not wait for another agent request or match event.
  const leaseTimer = setInterval(() => {
    for (const [id, connection] of seatConnections) if (!host.authorizeLease(connection.lease)) dropSeat(id);
  }, 250);
  leaseTimer.unref();

  interface Listening {
    request: Request;
    key: string;
    who: SeatSession['who'];
    roles: Map<string, string>;
    abort: AbortController;
  }
  const listening = new Set<Listening>();
  const watchedMatches = new Map<PlayerThreeMatch, { users: number; off(): void }>();
  const publish = (affected: (entry: Listening) => boolean, role: string): void => {
    const updated = new Set<string>();
    for (const entry of listening) {
      if (!affected(entry)) continue;
      const current = authenticate(entry.request);
      if (typeof current === 'string') {
        entry.abort.abort();
        continue;
      }
      const uri = entry.roles.get(role);
      if (uri && current.session.commands().some((command) => command.role === role)) updated.add(uri);
    }
    for (const uri of updated) inner.notify.resourceUpdated(uri);
  };
  const offCommanders = host.commanders.onStatus((owner, commanderId, role) => {
    for (const entry of listening) {
      if (entry.who.owner !== owner || entry.who.commanderId !== commanderId) continue;
      if (role !== null) {
        if (entry.roles.has(role)) publish((candidate) => candidate === entry, role);
      } else for (const held of entry.roles.keys()) publish((candidate) => candidate === entry, held);
    }
  });
  const offAuth = opts.auth?.onChange((connection) => {
    for (const entry of listening) if (entry.key === `oauth:${connection}`) entry.abort.abort();
  });

  const rpcError = (status: number, code: number, message: string, id: unknown = null, data?: unknown): Response =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }), { status, headers: { 'content-type': 'application/json' } });

  const fetchHandler = async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    if (origin !== null && !allowedOrigins.has(origin)) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden origin' }, id: null }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Authenticate after the bounded body read; the first real call atomically claims one exact lease.
    // The SDK's listen router has no auth context. Validate its entire URI filter here, before it
    // reaches the shared bus, and retain a request abort handle for credential revocation.
    const abort = new AbortController();
    const forwarded = new Request(request, { signal: AbortSignal.any([request.signal, abort.signal]) });
    let parsedBody: unknown;
    if (forwarded.method === 'POST' && forwarded.body) {
      const reader = forwarded.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = '';
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_MESSAGE_BYTES) {
            await reader.cancel();
            return rpcError(413, -32000, 'Request body too large');
          }
          text += decoder.decode(part.value, { stream: true });
        }
        parsedBody = JSON.parse(text + decoder.decode());
      } catch {
        return rpcError(400, -32700, 'Parse error');
      } finally {
        reader.releaseLock();
      }
    }
    const body = parsedBody as { method?: unknown; id?: unknown; params?: { _meta?: Record<string, unknown>; notifications?: { resourceSubscriptions?: unknown } } } | null;
    const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1];
    const agent = bearer && TOKEN_RE.test(bearer) ? host.agentSession(bearer) : undefined;
    const suppliedId = request.headers.get('mcp-session-id');
    let seatConnection: SeatConnection | undefined;
    let binding: SeatBinding | undefined;
    let auth = authenticate(forwarded);
    if (agent?.kind === 'seat') {
      // Discovery is a side-effect-free public surface probe, never a lease claim.
      if (body?.method === 'server/discover') return inner.fetch(forwarded, { parsedBody });
      if (request.method === 'POST') {
        // A 2026-07-28 request names its revision in the params._meta envelope, and the MCP-Protocol-Version
        // header must carry exactly the same one. A claim-less request is 2025-era (initialize, then the
        // negotiated session) and is served by the SDK's legacy leg; either era binds the seat lease below.
        const claimed = body?.params?._meta?.[PROTOCOL_VERSION_META_KEY];
        if (claimed !== undefined && claimed !== MODERN_PROTOCOL_VERSION) {
          return rpcError(400, ProtocolErrorCode.UnsupportedProtocolVersion, 'Unsupported protocol version', body?.id ?? null, { supported: PROTOCOL_VERSIONS, ...(typeof claimed === 'string' ? { requested: claimed } : {}) });
        }
        const header = request.headers.get('mcp-protocol-version');
        if (claimed !== undefined && header !== claimed) {
          return rpcError(400, HEADER_MISMATCH, 'Bad Request: the MCP-Protocol-Version header and the body envelope disagree', body?.id ?? null, { mismatch: { header: header ?? '(missing)', body: claimed } });
        }
      }
      if (suppliedId) seatConnection = seatConnections.get(suppliedId);
      else if (request.method === 'POST') {
        // Only a request binds: a notification has no result to authorize and never claims the credential.
        if (typeof body?.method !== 'string' || (typeof body.id !== 'string' && typeof body.id !== 'number')) return rpcError(400, -32600, 'Invalid Request');
        const id = randomBytes(32).toString('base64url');
        const pending: SeatBinding = {
          id,
          exchanges: new Set<AbortController>(),
          lease: undefined,
          bind(key) {
            const lease = host.claimToken(bearer!, `mcp:${id}`);
            if (!lease) return undefined;
            pending.lease = lease;
            seatConnections.set(id, { id, lease, key, exchanges: pending.exchanges });
            forwarded.headers.set('mcp-session-id', id);
            return lease;
          },
        };
        binding = pending;
      }
      if (!seatConnection && !binding) return unauthorized('Bearer realm="playerthree"');
      auth = authenticate(forwarded, binding);
      if (request.method === 'DELETE' && seatConnection) {
        if (typeof auth === 'string') return unauthorized('Bearer realm="playerthree"');
        dropSeat(seatConnection.id);
        return new Response(null, { status: 204 });
      }
    }
    if (typeof auth === 'string') return unauthorized(opts.auth ? opts.auth.challenge(auth === 'invalid', request) : 'Bearer realm="playerthree"');
    const exchanges = seatConnection?.exchanges ?? binding?.exchanges;
    const authorized = auth.session.authorized;
    let entry: Listening | undefined;
    let match: PlayerThreeMatch | undefined;
    const cleanup = (): void => {
      exchanges?.delete(abort);
      if (!entry || !listening.delete(entry)) return;
      forwarded.signal.removeEventListener('abort', cleanup);
      if (match) {
        const watcher = watchedMatches.get(match);
        if (watcher && --watcher.users === 0) {
          watcher.off();
          watchedMatches.delete(match);
        }
      }
    };
    if (body?.method === 'subscriptions/listen') {
      // Recheck after reading the body: consent may have changed while it arrived.
      const current = authenticate(forwarded, binding);
      if (typeof current === 'string') return unauthorized(opts.auth ? opts.auth.challenge(true, forwarded) : 'Bearer realm="playerthree"');
      const owned = new Map(current.session.commands().map((command) => [statusUri(current.key, command.role), command.role]));
      const requested = body.params?.notifications?.resourceSubscriptions;
      if (requested !== undefined && (!Array.isArray(requested) || requested.some((uri) => typeof uri !== 'string' || !owned.has(uri)))) {
        return rpcError(200, -32602, 'Resource not found', body.id);
      }
      entry = { request: forwarded, key: current.key, who: current.session.who, roles: new Map((requested as string[] | undefined ?? []).map((uri) => [owned.get(uri)!, uri])), abort };
      listening.add(entry);
      forwarded.signal.addEventListener('abort', cleanup, { once: true });
      if (!current.session.commander) {
        match = host.getMatch(current.session.who.match);
        if (match) {
          let watcher = watchedMatches.get(match);
          if (!watcher) {
            const id = match.id;
            watcher = { users: 0, off: match.onStatus((team, role) => publish((item) => item.who.match === id && item.who.team === team, role)) };
            watchedMatches.set(match, watcher);
          }
          watcher.users++;
        }
      }
      if (forwarded.signal.aborted) cleanup();
    }
    try {
      // A binding request is authorized (and claims its lease) only once the SDK has validated it.
      if (!binding && !auth.session.authorized()) return unauthorized('Bearer realm="playerthree"');
      exchanges?.add(abort);
      const info = { token: auth.token, clientId: auth.key, scopes: [], extra: { session: auth.session } };
      const headers = new Headers(forwarded.headers);
      headers.delete('mcp-session-id');
      const transportRequest = new Request(forwarded.url, { method: forwarded.method, headers, signal: forwarded.signal });
      const response = await inner.fetch(transportRequest, { parsedBody, authInfo: info });
      if (binding && !binding.lease) {
        // Not yet dispatched to a handler. Ladder rejections (4xx) and the SDK's in-band request validation errors
        // (JSON-RPC error with HTTP 200, e.g. invalid params) leave the credential unclaimed and issue no session.
        if (response.status >= 400) {
          cleanup();
          response.headers.delete('mcp-session-id');
          return response;
        }
        if (response.headers.get('content-type')?.startsWith('application/json')) {
          const text = await response.text();
          const headers = new Headers(response.headers);
          headers.delete('mcp-session-id');
          cleanup();
          if (isErrorResponse(text)) return new Response(text, { status: response.status, headers });
          if (!auth.session.authorized()) return unauthorized('Bearer realm="playerthree"');
          headers.set('mcp-session-id', binding.id);
          return new Response(text, { status: response.status, headers });
        }
      }
      if (!auth.session.authorized()) {
        await response.body?.cancel();
        cleanup();
        return unauthorized('Bearer realm="playerthree"');
      }
      const sessionId = seatConnection?.id ?? binding?.id;
      if (sessionId) response.headers.set('mcp-session-id', sessionId);
      if (!response.body) {
        cleanup();
        return response;
      }
      const reader = response.body.getReader();
      let ended = false;
      let onAbort: (() => void) | undefined;
      const detach = (): void => {
        if (onAbort) forwarded.signal.removeEventListener('abort', onAbort);
        cleanup();
      };
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          onAbort = () => {
            if (ended) return;
            ended = true;
            detach();
            // EOF alone does not settle an ordinary MCP request in the client SDK. A revoked exchange
            // receives only a terminal public denial, never the pending private tool result.
            if (exchanges && !authorized() && typeof body?.method === 'string' && (typeof body.id === 'string' || typeof body.id === 'number')) {
              const error = JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Unauthorized' } });
              const frame = response.headers.get('content-type')?.startsWith('text/event-stream') ? `event: message\ndata: ${error}\n\n` : error;
              controller.enqueue(new TextEncoder().encode(frame));
            }
            controller.close();
            reader.cancel().catch(report);
          };
          forwarded.signal.addEventListener('abort', onAbort, { once: true });
          if (forwarded.signal.aborted) onAbort();
        },
        async pull(controller) {
          try {
            const result = await reader.read();
            if (ended) return;
            if (!authorized()) { abort.abort(); return; }
            if (result.done) {
              ended = true;
              detach();
              controller.close();
            } else controller.enqueue(result.value);
          } catch {
            if (ended) return;
            ended = true;
            detach();
            controller.error(new Error('Subscription stream closed'));
          }
        },
        async cancel() {
          ended = true;
          detach();
          abort.abort();
          await reader.cancel();
        },
      }), { status: response.status, headers: response.headers });
    } catch (error) {
      cleanup();
      throw error;
    }
  };

  const nodeHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      await writeWebResponse(res, await fetchHandler(toWebRequest(req, abort.signal)));
    } catch (e) {
      if (!abort.signal.aborted) report(e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end();
    }
  };

  return Object.assign(nodeHandler, {
    fetch: fetchHandler,
    close: async () => {
      offCommanders();
      offAuth?.();
      offLeases();
      clearInterval(leaseTimer);
      for (const id of seatConnections.keys()) dropSeat(id);
      for (const entry of listening) entry.abort.abort();
      await inner.close();
    },
    surfaceHash: hash,
  });
}

export interface MountMcpOptions extends McpOptions {
  /** Default `/mcp`. Matched exactly against the request pathname. */
  path?: string;
}

/**
 * Serve MCP on an existing node:http server: requests whose pathname equals `path` — and, with `auth`, the
 * authorization server's paths (`/.well-known/oauth-*`, `/oauth/*`) — are handled here and never reach the
 * server's other `request` listeners (regardless of registration order); everything else passes through.
 */
export function mountMcp<M extends AnyManifest>(
  httpServer: HttpServer,
  host: PlayerThreeHost<M>,
  opts: MountMcpOptions = {},
): { handler: McpRequestHandler; close(): Promise<void> } {
  const path = opts.path ?? '/mcp';
  const handler = createMcpRequestHandler(host, opts);
  const auth = opts.auth;
  const originalEmit = httpServer.emit;
  httpServer.emit = function (this: HttpServer, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'request') {
      const req = args[0] as IncomingMessage;
      const res = args[1] as ServerResponse;
      const url = req.url ?? '/';
      const q = url.indexOf('?');
      const pathname = q === -1 ? url : url.slice(0, q);
      if (pathname === path) {
        void handler(req, res);
        return true;
      }
      if (auth?.handles(pathname)) {
        auth.handle(req, res).catch((e: unknown) => {
          opts.onError?.(new Error('playerthree/mcp: authorization handler failed'));
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        return true;
      }
    }
    return originalEmit.call(this, event, ...args);
  } as HttpServer['emit'];
  return {
    handler,
    async close() {
      httpServer.emit = originalEmit;
      await handler.close();
    },
  };
}
