/**
 * Headless `GameMatchHost` and `SeatBinder` for a game definition: each match runs on an in-process PlayerThreeHost,
 * LLM entrants play (or author policies) through a loopback MCP endpoint with the runner's agent loop, under the
 * series' shared token/USD budgets.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { canonicalJson, fitExpected, MCP_TOOL_NAMES, surfaceHash, type AnyManifest, type DeployResult, type GameDefinition, type GameMetrics, type MandateOf, type PolicyArtifact, type PolicySource } from 'playerthree';
import type { AbortReason, ArenaJsonSchema, BoundSeat, DecisionRow, EventDefinition, GameMatchHost, GameMatchResult, IntentRow, MatchSpec, MetricDefinition, MetricRow, ResultRows, SeatBinder, SeatRow, TimelineEvent, UsageRow } from 'playerthree/arena';
import { toJsonSchema, validate } from 'playerthree/schema';
import { PlayerThreeError, createPlayerThreeHost, type PlayerThreeHost, type PlayerThreeMatch } from 'playerthree/host';
import { mountMcp } from 'playerthree/mcp';
import { Budget, connectSeat, createAnthropicProvider, createOpenAiProvider, createScriptedProvider, llmTools, priceFor, ProviderError, RUNNER_HARNESS, runAgent, seatBrief, type Price, type Provider, type RemoteSeat, type RunSummary, type TranscriptEvent } from '@playerthree/runner';
import { watchKeyUsage, type BilledUsage, type KeyUsageWatch } from './billing.ts';
import { turnCostUsd, type AuthoringHarness, type HarnessIdentity, type HarnessOutcome, type MeteredTurn } from './harness.ts';
import { maxOutputTokensOf, modelWire, validateConfig, type BenchConfig, type BenchModel } from './config.ts';
import { botFail } from './bots-config.ts';

/** Shortest credential redacted from harness transcripts: real keys and tokens are far longer, and a shorter (test) value would redact ordinary text. */
const MIN_REDACTED_SECRET = 16;

/** Most telemetry rows per stored chunk: ~300 bytes per row keeps a chunk well under the default 1 MiB maxChunkBytes. */
const CHUNK_ROWS = 2048;

/** Validates and copies a game's metrics snapshot: plain maps of bounded keys and finite numbers, known teams only, at most 1 MiB of JSON. */
export function snapshotMetrics(raw: GameMetrics, teams: readonly string[]): GameMetrics {
  const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (!plain(raw) || !plain(raw.match) || !plain(raw.sides)) botFail('metrics must contain plain match and sides maps');
  const map = (value: Record<string, number>) => {
    if (!plain(value)) botFail('metric map must be a plain object');
    const entries = Object.entries(value);
    if (entries.length > 4096 || entries.some(([key, number]) => !key || key.length > 128 || !Number.isFinite(number))) botFail('metrics need bounded keys and finite numbers');
    return Object.fromEntries(entries);
  };
  if (Object.keys(raw.sides).some((team) => !teams.includes(team))) botFail('metrics contain an unknown team');
  const result = { match: map(raw.match), sides: Object.fromEntries(teams.map((team) => [team, map(raw.sides[team] ?? {})])) };
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) botFail('metrics exceed 1 MiB');
  return result;
}

/** `roles`: every role a lobby authoring commander commands (its usage rows name no single role). */
interface Lane { bound: BoundSeat; entrantId: string | null; commanderId?: string; artifact?: PolicyArtifact; roles?: readonly string[] }

/**
 * One entry of an authoring attempt's private timeline (SPEC §20.11 ledger): each deployment (`by` the harness for a
 * starter pre-deploy, else the model) and rollback with role, version and source digest, and each practice run.
 */
export type AuthoringEvent =
  | { kind: 'deploy'; at: string; role: string; version: number; digest: string; from: string | null; by: 'harness' | 'model' }
  | { kind: 'rollback'; at: string; role: string; version: number }
  | { kind: 'practice'; at: string; role: string; opponent: string; seed: number; ticks: number; outcome: string };

interface Environment {
  owner: string; host: PlayerThreeHost; lanes: Lane[]; close(): Promise<void>; connect(id: string): Promise<RemoteSeat>;
  /** Deployed sources by `<token>/<role>/<version>`: only versions deployed through this environment can be frozen. */
  artifacts: Map<string, PolicySource>; practiceSeedsUsed: number[]; timeline: AuthoringEvent[]; url: string;
  /** A harness deployment (starter pre-deploy) through the same guarded path the model's deployments take. */
  predeploy(token: string, role: string, source: PolicySource): Promise<DeployResult>;
  /** Authoring's deadline passed: deployments, rollbacks and practice are refused from now on. */
  freeze(): void;
}

/** A frozen artifact is what the host stores and hashes: the library version's composed script, never its sources. */
async function composedArtifact(env: Environment, commanderId: string, version: number, role: string): Promise<PolicyArtifact> {
  const pkg = await env.host.commanders.exportPolicy(env.owner, commanderId, version, { role });
  return { runtime: pkg.runtime, code: pkg.script };
}
const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

interface SeriesAccount { tokens: number; usd: number; turns: number; reservedTokens: number; reservedUsd: number; reservedTurns: number }

class SeriesBudget extends Budget {
  readonly account: SeriesAccount;
  readonly maxTurns: number;
  constructor(config: BenchConfig, model: BenchModel, account: SeriesAccount) {
    const limits = config.spec.budgets;
    super(limits.maxCostUsd === null ? Infinity : Number(limits.maxCostUsd), model.price ?? priceFor(model.model) ?? { inPerM: 0, outPerM: 0 }, limits.maxTokens ?? Infinity);
    this.account = account;
    this.maxTurns = limits.maxTurns ?? Infinity;
  }
  override canAfford(input: number, output: number): boolean {
    return this.account.tokens + this.account.reservedTokens + input + output <= this.maxTokens
      && this.account.usd + this.account.reservedUsd + this.cost({ inputTokens: input, outputTokens: output }) <= this.maxUsd
      && this.account.turns + this.account.reservedTurns < this.maxTurns;
  }
}

/** A turn's measured usage crossed a hard per-run ceiling: it is charged, but its tool calls never execute. */
export class BudgetExceeded extends Error {
  constructor() { super('budget'); this.name = 'BudgetExceeded'; }
}

/** The environment variable holding a model's provider key; null for the offline scripted provider. */
export function modelKeyEnv(model: BenchModel): string | null {
  return model.provider === 'scripted' ? null : model.apiKeyEnv ?? (model.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
}

/** Provider outages and network failures are infrastructure; other provider rejections are the request's own. */
function transientProviderFailure(error: unknown): boolean {
  return !(error instanceof ProviderError) || error.status === 408 || error.status === 429 || error.status >= 500;
}

/** Completed provider turns, failed provider requests and the last provider failure of one session, for infrastructure classification. */
interface SessionStats { turns: number; providerErrors: number; providerError: unknown }

/** The owner an authoring attempt binds its lobby under (`author`): its environment's endpoint serves authoring seats. */
const AUTHORING_OWNER = 'benchmark-author';

/** One bound match's host and MCP endpoint; `authoring`: its seats author policies in the lobby (`McpOptions.authoring`). */
async function environment(definition: GameDefinition, config: BenchConfig, owner: string, spec: MatchSpec, authoring: boolean): Promise<Environment> {
  const artifacts = new Map<string, PolicySource>();
  const practiceSeedsUsed: number[] = [];
  const timeline: AuthoringEvent[] = [];
  let deployer: 'harness' | 'model' = 'model';
  // An external harness can still be mid-call when the deadline kills it: what is active at the deadline is frozen.
  let frozen = false;
  const open = () => { if (frozen) throw new PlayerThreeError('mode_unavailable'); };
  // Lobby probes and practice must share the resolved match's layout-compatible team subset, not every manifest team.
  const host = createPlayerThreeHost({ definition, teams: spec.sides.map(side => side.id), matchOptions: definition.manifest.matchOptions ? spec.options : undefined, history: { maxSessions: 0 } });
  await host.commanders.ready;
  host.commanders.ensure(owner);
  // A multi-role commander's MCP calls select their role session by `role`; the guard keeps that selection.
  const guarded: PlayerThreeHost = { ...host, agentSession(token, role) {
    const session = host.agentSession(token, role);
    if (!session) return undefined;
    return { ...session, control: { ...session.control,
      async policyDeploy(artifact) {
        open();
        const result = await session.control.policyDeploy(artifact);
        if (result.ok) {
          artifacts.set(`${token}/${session.role}/${result.version}`, structuredClone(artifact));
          timeline.push({ kind: 'deploy', at: new Date().toISOString(), role: session.role, version: result.version, digest: sha256(artifact), from: 'from' in artifact && typeof artifact.from === 'string' ? artifact.from : null, by: deployer });
        }
        return result;
      },
      async policyRollback(version) {
        open();
        const result = await session.control.policyRollback(version);
        if (result.ok) timeline.push({ kind: 'rollback', at: new Date().toISOString(), role: session.role, version: result.version });
        return result;
      },
      async practice(req) {
        open();
        const allowed = config.spec.authoring?.practiceSeeds ?? [];
        // No allowlist: this benchmark offers no practice at all.
        if (!allowed.length) throw new PlayerThreeError('mode_unavailable');
        // Held-out seeds stay held out: name the allowlist so the model can retry with one of them (or omit the seed).
        if (req.seed !== undefined && !allowed.includes(req.seed)) {
          throw new PlayerThreeError('invalid', { schemaCode: 'enum', path: ['seed'], expected: fitExpected('PracticeRequest["seed"]', allowed.map(String), 'this benchmark\'s practice seeds; omit seed to rotate through them') });
        }
        const seed = req.seed ?? allowed[practiceSeedsUsed.length % allowed.length]!;
        practiceSeedsUsed.push(seed);
        const result = await session.control.practice({ ...req, seed });
        timeline.push({ kind: 'practice', at: new Date().toISOString(), role: session.role, opponent: req.opponent, seed, ticks: req.ticks, outcome: result.ok ? result.outcome : `failed:${result.code}` });
        return result;
      },
    } };
  } };
  const server = createServer((_req, res) => res.writeHead(404).end());
  const mcp = mountMcp(server, guarded, { authoring });
  try {
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', listening.reject); listening.resolve(); });
    await listening.promise;
  } catch (error) { host.dispose(); await mcp.close(); server.close(); throw error; }
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { owner, host, lanes: [], artifacts, practiceSeedsUsed, timeline, url,
    connect: (id) => connectSeat({ url, token: host.commanders.token(owner, id), expectHash: config.spec.surfaceHash }),
    async predeploy(token, role, source) {
      const session = guarded.agentSession(token, role);
      if (!session) throw new Error('predeploy: no commander session');
      deployer = 'harness';
      try { return await session.control.policyDeploy(source); } finally { deployer = 'model'; }
    },
    freeze() { frozen = true; },
    async close() { host.dispose(); await mcp.close(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; },
  };
}

/** Where one bench host's session transcripts go (JSONL, one file per model session) and what they summarise. */
interface SessionTrace {
  /** Directory for `<executionId>-<phase>.jsonl` transcripts; none are written without it. */
  dir: string | undefined;
  /** File names written, in session order. */
  files: string[];
  /** Model turns per upstream that served them, when the reply names it. */
  servedBy: Record<string, number>;
  /** Router generation ids of the turns whose reply did not name their upstream (looked up after the run). */
  generations: string[];
}

/** Live-play tools an authoring session never gets: it prepares policies in the lobby. */
const AUTHORING_BLOCKED_TOOLS: readonly string[] = [MCP_TOOL_NAMES.act, MCP_TOOL_NAMES.sequence, MCP_TOOL_NAMES.publish];
/** Policy tools a live session never gets: it plays through intents and sequences. */
const INFERENCE_BLOCKED_TOOLS: readonly string[] = [MCP_TOOL_NAMES.policyDeploy, MCP_TOOL_NAMES.policyRollback, MCP_TOOL_NAMES.policyImport, MCP_TOOL_NAMES.practice, MCP_TOOL_NAMES.publish];

/**
 * The runner-authored brief of a bench session: the seat's facts (the runner's seat brief, no play advice) plus the
 * benchmark phase; an authoring session then gets the series' own evaluation statement (`authoring.brief`). The harness
 * states rules and limits, never a strategy.
 */
async function sessionBrief(config: BenchConfig, seat: RemoteSeat, phase: UsageRow['phase']): Promise<string> {
  const limits = config.spec.budgets;
  const evaluation = config.spec.authoring?.brief;
  return `${seatBrief(seat, (await seat.briefing()).game)}\nBenchmark phase: ${phase}. Each reply is capped at ${maxOutputTokensOf(config.spec)} output tokens. ${phase === 'authoring' ? `Authoring runs until its deadline (${limits.maxTurns ?? 'unlimited'} model turns, ${Math.round((config.spec.authoring?.maxWallMs ?? config.spec.execution.maxWallMs) / 60_000)} minutes); the policies active at the deadline are the ones evaluated. Practice is restricted to a disjoint server allowlist.${evaluation === undefined ? '' : `\n${evaluation}`}` : 'Play through intents and sequences. Policy authoring is disabled.'}`;
}

/**
 * One measured model turn's usage row at {@link turnCostUsd}: the router-reported cost (`reported`), else the frozen
 * rates' cache-aware estimate (`runner`); `unpriced` when neither exists.
 */
function usageRow(lane: Lane, phase: UsageRow['phase'], matchId: string, decisionId: string, price: Price | undefined, usage: MeteredTurn | null): UsageRow {
  const amount = usage ? turnCostUsd(price, usage) : null;
  const reported = usage?.reportedUsd !== undefined;
  return { matchId: phase === 'authoring' ? null : matchId, phase, team: phase === 'authoring' ? null : lane.bound.seat.team, role: lane.roles && lane.roles.length > 1 ? null : lane.bound.seat.role, entrantId: lane.entrantId!, executionId: lane.bound.executionId, decisionId,
    reporter: reported ? 'reported' : usage && amount === null ? 'unpriced' : 'runner', inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, cacheReadTokens: usage?.cachedInputTokens ?? null, cacheWriteTokens: null,
    costAmount: amount === null ? null : amount.toFixed(18).replace(/0+$/, '').replace(/\.$/, ''), currency: amount === null ? null : 'USD',
    pricingVersion: reported ? 'router-reported' : amount !== null ? `runner-price:${sha256(price)}` : null, coverage: usage ? 'complete' : 'unknown' };
}

async function modelSession(config: BenchConfig, model: BenchModel, seat: RemoteSeat, lane: Lane, phase: UsageRow['phase'], matchId: string, signal: AbortSignal, rows: { usage: UsageRow[]; decisions: DecisionRow[] }, account: SeriesAccount, trace: SessionTrace, stats: SessionStats = { turns: 0, providerErrors: 0, providerError: undefined }): Promise<RunSummary> {
  const price = model.price ?? priceFor(model.model);
  const limits = config.spec.budgets;
  const budget = new SeriesBudget(config, model, account);
  const keyName = modelKeyEnv(model);
  const apiKey = keyName ? process.env[keyName] : undefined;
  if (keyName && !apiKey) throw new Error(`playerthree-bench: set ${keyName} for ${model.provider}/${model.model}`);
  const blocked = phase === 'authoring' ? AUTHORING_BLOCKED_TOOLS : INFERENCE_BLOCKED_TOOLS;
  const tools = llmTools(seat).filter((tool) => !blocked.includes(tool.name));
  const brief = await sessionBrief(config, seat, phase);
  // A series-fixed system prompt replaces the runner's own; the runner's brief then opens the conversation as its first user message.
  const fixed = phase === 'authoring' ? config.spec.authoring?.systemPrompt : undefined;
  const reasoningEffort = phase === 'authoring' ? config.spec.authoring?.reasoning : undefined;
  const options = { model: model.model, apiKey: apiKey ?? '', maxOutputTokens: maxOutputTokensOf(config.spec), tools, baseUrl: model.baseUrl, request: model.request, system: fixed ?? brief, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) };
  const underlying = model.provider === 'scripted' ? createScriptedProvider(model.script!, model.model) : model.provider === 'openai' ? createOpenAiProvider(options) : createAnthropicProvider(options);
  if (fixed !== undefined) underlying.addUser(brief);
  let index = 0;
  const provider: Provider = { name: underlying.name, model: underlying.model,
    addUser: (text) => underlying.addUser(text), addToolResults: (results) => underlying.addToolResults(results), compact: (keep) => underlying.compact(keep), estimateInputTokens: () => underlying.estimateInputTokens(),
    async turn(abort) {
      const decisionId = `${lane.bound.executionId}/${phase}/${++index}`;
      const started = Date.now();
      const input = underlying.estimateInputTokens();
      const output = options.maxOutputTokens;
      if (!budget.canAfford(input, output)) throw new BudgetExceeded();
      const reservationUsd = budget.cost({ inputTokens: input, outputTokens: output });
      account.reservedTokens += input + output;
      account.reservedUsd += reservationUsd;
      account.reservedTurns++;
      let turn;
      try {
        turn = await underlying.turn(abort);
        const row = usageRow(lane, phase, matchId, decisionId, price, turn.usage);
        account.tokens += turn.usage.inputTokens + turn.usage.outputTokens;
        account.usd += row.costAmount === null ? 0 : Number(row.costAmount);
        account.turns++;
        rows.usage.push(row);
        rows.decisions.push({ matchId, ...lane.bound.seat, decisionId, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), latencyMs: Date.now() - started, source: 'runner', status: 'completed' });
      } catch (error) {
        stats.providerError = error;
        if (!abort?.aborted) stats.providerErrors++;
        rows.decisions.push({ matchId, ...lane.bound.seat, decisionId, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), latencyMs: Date.now() - started, source: 'runner', status: abort?.aborted ? 'aborted' : 'provider_error' });
        rows.usage.push(usageRow(lane, phase, matchId, decisionId, price, null));
        throw error;
      }
      finally {
        account.reservedTokens -= input + output;
        account.reservedUsd -= reservationUsd;
        account.reservedTurns--;
      }
      stats.turns++;
      // Reservations bound estimated input; actual input can exceed it. Discard the overshooting turn before its tools run.
      if (account.tokens > budget.maxTokens || account.usd > budget.maxUsd) throw new BudgetExceeded();
      return turn;
    },
  };
  // The transcript holds what the model saw and did: prompts, replies, tool calls and results. The key never enters it.
  const file = trace.dir === undefined ? undefined : join(trace.dir, `${lane.bound.executionId}-${phase}.jsonl`);
  let out: WriteStream | undefined;
  if (file) {
    await mkdir(trace.dir!, { recursive: true, mode: 0o700 });
    out = createWriteStream(file, { flags: 'a', mode: 0o600 });
    trace.files.push(basename(file));
    out.write(`${JSON.stringify({ kind: 'session', at: new Date().toISOString(), harness: RUNNER_HARNESS, phase, entrantId: lane.entrantId, roles: lane.roles ?? [lane.bound.seat.role], provider: model.provider, model: model.model, request: model.request ?? null, maxOutputTokens: options.maxOutputTokens, reasoning: reasoningEffort ?? null, maxTurns: limits.maxTurns, system: options.system, tools: tools.map((tool) => tool.name) })}\n`);
    if (fixed !== undefined) out.write(`${JSON.stringify({ kind: 'user', at: new Date().toISOString(), text: brief })}\n`);
  }
  const transcript = (event: TranscriptEvent): void => {
    if (event.kind === 'turn' && event.servedBy) trace.servedBy[event.servedBy] = (trace.servedBy[event.servedBy] ?? 0) + 1;
    else if (event.kind === 'turn' && event.generationId) trace.generations.push(event.generationId);
    out?.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  };
  try {
    return await runAgent({ seat, provider, budget, maxOutputTokens: options.maxOutputTokens, maxTurns: limits.maxTurns ?? undefined, authoring: phase === 'authoring', signal, log: () => {}, transcript });
  } catch (error) {
    // A turn over a hard ceiling is discarded before its tools run; anything else thrown is the harness's or provider's.
    out?.write(`${JSON.stringify({ kind: 'end', at: new Date().toISOString(), thrown: error instanceof BudgetExceeded ? 'budget' : error instanceof ProviderError ? 'provider_error' : 'harness_error' })}\n`);
    throw error;
  } finally {
    await seat.close();
    if (out) {
      const closed = Promise.withResolvers<void>();
      out.end(closed.resolve);
      await closed.promise;
    }
  }
}

export interface AuthoredPolicies {
  policies: Record<string, PolicyArtifact> | null;
  reason: string;
  usage: UsageRow[];
  /** Not a model outcome: the run stays pending and unscored, and a later attempt re-authors it. */
  infrastructure: boolean;
  /** Transcript file names (in the host's transcript directory) of this attempt's model sessions. */
  transcripts: string[];
  /** Model turns per upstream that served them, when the reply names it. */
  servedBy: Record<string, number>;
  /** Router generation ids of the turns whose reply did not name their upstream (`lookupServedBy` resolves them). */
  generations: string[];
  /** The harness that authored. */
  harness: HarnessIdentity;
  /** Wall time of the model's authoring (after the starter pre-deploy), ms. */
  wallMs: number;
  /** Model turns completed, and their measured input and output tokens. */
  turns: number; inputTokens: number; outputTokens: number;
  /** Provider requests that failed (error statuses, unreachable, error events in a 200 reply), the harness's retries included. */
  providerErrors: number;
  /** USD the router reported charging per turn, summed (null when it reported none). */
  reportedUsd: number | null;
  /** The key's billed usage around the attempt (`billing: "openrouter-key"`), else null. */
  billed: BilledUsage | null;
  /** Deployments, rollbacks and practice runs, in order. */
  timeline: AuthoringEvent[];
  /** SHA-256 of each frozen role's composed artifact (canonical JSON). */
  policyDigests: Record<string, string>;
}

/**
 * A harness re-prompt's status: each role's active policy version (whether the harness pre-deployed it) and the last
 * practice result, read without model tokens. It names no starter file: the game's own docs say what each one is.
 */
function lobbyStatus(env: Environment, commanderId: string, roles: readonly string[]): string {
  const status = env.host.commanders.roster(env.owner).find((commander) => commander.id === commanderId);
  const active = roles.map((role) => {
    const version = status?.policy.activeByRole[role];
    if (version == null) return `${role}: none`;
    const deploy = env.timeline.findLast((event) => event.kind === 'deploy' && event.role === role && event.version === version);
    return `${role}: version ${version}${deploy?.kind === 'deploy' && deploy.by === 'harness' ? ' (pre-deployed by the harness)' : ''}`;
  });
  const practice = env.timeline.findLast((event) => event.kind === 'practice');
  return `Active policies: ${active.join('; ')}. Last practice: ${practice?.kind === 'practice' ? `${practice.outcome} vs ${practice.opponent} (${practice.role}, seed ${practice.seed}, ${practice.ticks} ticks)` : 'none yet'}.`;
}

/** Bench host options: `transcripts` is the directory for per-session JSONL transcripts (none without it). */
export interface GameMatchHostOptions { transcripts?: string }

/** One authoring attempt's options: an external `harness` (default the runner's loop) and its private `scratch` directory. */
export interface AuthorOptions { harness?: AuthoringHarness; scratch?: string }

/** Headless GameDefinition adapter. Scheduling, retries, storage and ratings belong exclusively to SeriesRunner. */
export function createGameMatchHost(definition: GameDefinition, config: BenchConfig, options: GameMatchHostOptions = {}): { host: GameMatchHost; binder: SeatBinder; author(candidateId: string, signal?: AbortSignal, authorOptions?: AuthorOptions): Promise<AuthoredPolicies>; close(): Promise<void> } {
  const environments = new Map<string, Environment>();
  const artifacts = new Map<string, string>();
  let artifactDirectory: Promise<string> | undefined;
  const prepared = new Map<string, Promise<PolicyArtifact>>();
  const manifestTeams: readonly string[] = definition.manifest.teams.values;
  const summaryUnits = new Map((config.spec.telemetry.metricDefinitions ?? []).map((definition) => [`${definition.scope}:${definition.metric}`, definition.unit]));
  const account: SeriesAccount = { tokens: 0, usd: 0, turns: 0, reservedTokens: 0, reservedUsd: 0, reservedTurns: 0 };
  const matches = new Map<string, PlayerThreeMatch>();
  const binder: SeatBinder = {
    async validate(_owner, spec) {
      validateConfig({ ...config, spec }, definition);
      if (spec.execution.state !== 'reset_each_match') botFail('headless adapter supports reset_each_match only');
    },
    async bind(owner, spec, context) {
      const env = await environment(definition, config, owner, spec, owner === AUTHORING_OWNER);
      try {
        for (const side of spec.sides) for (const slot of side.seats) {
          const kind = slot.occupant.kind === 'closed' ? 'none' : slot.occupant.kind === 'commander' ? slot.occupant.ref.kind : slot.occupant.kind;
          if (kind === 'open' || kind === 'human') botFail('headless series requires resolved bot/commander seats');
          const entrantId = spec.bindings.find((binding) => binding.seat.team === side.id && binding.seat.role === slot.role)?.entrantId ?? null;
          const bound: BoundSeat = { seat: { team: side.id, role: slot.role }, executionId: randomUUID(), kind };
          const lane: Lane = { bound, entrantId, artifact: entrantId ? config.policies?.[entrantId]?.[slot.role] : undefined };
          if (kind === 'agent' || kind === 'policy') {
            const commander = env.host.commanders.create(owner, { name: `${entrantId}/${side.id}/${slot.role}`, kind: kind === 'policy' ? 'policy' : 'agent', roles: [slot.role], isolation: { independentSessions: true } });
            lane.commanderId = commander.id;
            env.host.commanders.update(owner, commander.id, { scopes: kind === 'policy' ? (definition.manifest.control.practice ? ['policy', 'practice'] : ['policy']) : ['act'], mandate: { ...commander.mandate, autonomy: 'autonomous', whenAbsent: kind === 'policy' ? 'policy' : 'hold' } });
          }
          env.lanes.push(lane);
        }
        environments.set(context.attemptId, env);
        return { seats: env.lanes.map((lane) => lane.bound), async release() { if (environments.delete(context.attemptId)) await env.close(); } };
      } catch (error) { await env.close(); throw error; }
    },
  };
  const host: GameMatchHost = {
    async describe() {
      const supportedLayouts = new Map<string, { map: string; layout: string; sides: readonly string[] }>();
      // The adapter plays any set of distinct manifest teams (`resolve` checks), so the configured sides are its layout.
      const sides = config.spec.template.sides.map((side) => side.id);
      for (const scenario of config.spec.scenarios) supportedLayouts.set(`${scenario.map.id}/${scenario.map.layout}`, { map: scenario.map.id, layout: scenario.map.layout, sides });
      const metricDefinitions: MetricDefinition[] = [...(config.spec.telemetry.metricDefinitions ?? [])];
      for (const metric of ['policy.calls', 'policy.errors', 'policy.timeouts', 'policy.intentsEmitted']) metricDefinitions.push({ metric, scope: 'seat', unit: 'count', interpretation: 'cumulative' });
      const eventDefinitions = new Map<string, EventDefinition>((config.spec.telemetry.eventDefinitions ?? []).map((definition) => [definition.kind, definition]));
      eventDefinitions.set('game_report', { kind: 'game_report', dataSchema: { type: 'object', properties: { report: toJsonSchema(definition.manifest.report) as ArenaJsonSchema }, required: ['report'], additionalProperties: false } });
      eventDefinitions.set('practice_run', { kind: 'practice_run', dataSchema: { type: 'object', properties: { seed: { type: 'integer', minimum: 0, maximum: 2 ** 31 - 1 } }, required: ['seed'], additionalProperties: false } });
      eventDefinitions.set('intent_ack', { kind: 'intent_ack', dataSchema: { type: 'object', properties: { source: { type: 'string', maxLength: 64 }, code: { type: 'string', maxLength: 128 }, accepted: { type: 'boolean' } }, required: ['source', 'code', 'accepted'], additionalProperties: false } });
      eventDefinitions.set('authoring_end', { kind: 'authoring_end', dataSchema: { type: 'object', properties: { reason: { type: 'string', enum: ['match_over', 'budget', 'aborted', 'surface_changed', 'provider_error', 'max_turns'] } }, required: ['reason'], additionalProperties: false } });
      return { game: definition.manifest.id, gameVersion: definition.manifest.version, surfaceHash: surfaceHash(definition.manifest), supportedLayouts: [...supportedLayouts.values()], clocks: ['realtime', 'accelerated'], metricDefinitions, eventDefinitions: [...eventDefinitions.values()] };
    },
    async resolve(spec) {
      if (definition.manifest.matchOptions && !config.resolve) botFail('game matchOptions require a resolver that freezes actual defaults and rules');
      if (config.resolve) spec = await config.resolve(spec);
      if (spec.game !== definition.manifest.id || spec.gameVersion !== definition.manifest.version || spec.surfaceHash !== surfaceHash(definition.manifest)) botFail('game/version/surface pin mismatch');
      const sideIds = spec.sides.map((side) => side.id);
      if (!sideIds.length || new Set(sideIds).size !== sideIds.length || sideIds.some((team) => !manifestTeams.includes(team))) botFail('unsupported physical sides');
      // The host requires an alliance id that names a manifest team to name one of its own members.
      if (spec.sides.some((side) => side.alliance !== side.id && manifestTeams.includes(side.alliance) && !spec.sides.some((member) => member.id === side.alliance && member.alliance === side.alliance))) botFail('unsupported alliances');
      if (spec.sides.some((side) => side.seats.length !== definition.manifest.roles.values.length || side.seats.some((slot) => !definition.manifest.roles.values.includes(slot.role)))) botFail('unsupported seat roles');
      for (const side of spec.sides) for (const slot of side.seats) {
        const occupant = slot.occupant;
        if (occupant.kind === 'open' || occupant.kind === 'human') botFail('headless series requires resolved bot/commander seats');
        if (occupant.kind === 'bot') {
          if (!definition.manifest.opponents.values.includes(occupant.level)) botFail('unknown bot level');
          if (definition.botOptions ? !validate(definition.botOptions, occupant.options).ok : Object.keys(occupant.options).length > 0) botFail('invalid bot options');
        }
        if (occupant.kind !== 'commander') continue;
        const entrantId = spec.bindings.find((binding) => binding.seat.team === side.id && binding.seat.role === slot.role)?.entrantId;
        if (!entrantId) botFail('commander seat lacks entrant binding');
        const model = config.models?.[entrantId!];
        const artifact = config.policies?.[entrantId!]?.[slot.role];
        if (occupant.ref.kind === 'agent' && (!model || config.spec.track !== 'live')) botFail('live commanders require the live track and a model');
        if (occupant.ref.kind === 'policy' && (!definition.manifest.control.policy || (!artifact && (!model || config.spec.track !== 'policy')))) botFail('policy commanders require a pinned artifact or policy authoring model');
      }
      if (definition.manifest.matchOptions) {
        const result = validate(definition.manifest.matchOptions, spec.options);
        if (!result.ok) botFail('options do not match game matchOptions');
      } else if (Object.keys(spec.options).length) botFail('game declares no matchOptions');
      return config.resolve ? spec : { ...spec, rulesHash: createHash('sha256').update(canonicalJson(spec.options)).digest('hex') };
    },
    async create(spec, context) {
      const env = environments.get(context.attemptId);
      if (!env) throw new Error('unbound headless execution');
      if (context.bindings.length !== env.lanes.length || context.bindings.some((binding) => !env.lanes.some((lane) => lane.bound.executionId === binding.executionId && lane.bound.seat.team === binding.seat.team && lane.bound.seat.role === binding.seat.role && lane.bound.kind === binding.kind))) throw new Error('invalid headless execution bindings');
      const done = Promise.withResolvers<GameMatchResult>();
      // The match plays exactly the spec's sides; allied sides (same `side.alliance`) compete as one unit.
      const teams = spec.sides.map((side) => side.id);
      const allianceOf = new Map(spec.sides.map((side) => [side.id, side.alliance]));
      const units = new Map<string, string[]>();
      for (const side of spec.sides) units.set(side.alliance, [...(units.get(side.alliance) ?? []), side.id]);
      // Declared only when some sides are allied: lone sides need no alliance, and a duel stays a plain duel.
      const alliances = [...units.values()].some((members) => members.length > 1) ? Object.fromEntries(units) : undefined;
      const ended = new AbortController();
      const signal = AbortSignal.any([context.signal, ended.signal]);
      let started = false;
      let match: PlayerThreeMatch | undefined;
      let abortReason: AbortReason | undefined;
      const usage: UsageRow[] = [];
      const decisions: DecisionRow[] = [];
      const intents = new Map<string, IntentRow>();
      const policyErrors = new Map<string, number>();
      let sequence = 0;
      let pendingEvents: TimelineEvent[] = [];
      const untrace = env.host.onTrace((event) => {
        if (!match || event.match !== match.id || !('team' in event) || !('role' in event)) return;
        const key = `${event.team}/${event.role}`;
        if (event.type === 'policy_call' && event.error) policyErrors.set(key, (policyErrors.get(key) ?? 0) + 1);
        if (event.type !== 'intent') return;
        const code = event.ack.ok ? 'ok' : event.ack.code === 'invalid' ? `schema:${event.ack.schemaCode}` : event.ack.code === 'game' ? `game:${event.ack.gameCode}` : `host:${event.ack.code}`;
        const bucket = `${key}/${event.source}/${code}`;
        const row = intents.get(bucket) ?? { matchId: context.attemptId, team: event.team, role: event.role, source: event.source, code, submitted: 0, accepted: 0, rejected: 0 };
        row.submitted++; if (event.ack.ok) row.accepted++; else row.rejected++;
        intents.set(bucket, row);
        pendingEvents.push({ matchId: context.attemptId, sequence: ++sequence, tick: event.tick, atMs: event.tick * 1000 / definition.manifest.tickRate, kind: 'intent_ack', team: event.team, role: event.role, data: { source: event.source, code, accepted: event.ack.ok } });
      });
      async function flushAccounting(): Promise<void> {
        const rows = { usage: usage.splice(0), decisions: decisions.splice(0) };
        if (rows.usage.length || rows.decisions.length) await context.emitChunk(rows);
      }
      /**
       * Ends the match as the forfeit rows report it (the failed side's alliance loses, every other unit wins), so the
       * game's views, reports and replay agree. The host never changes an outcome the game already decided; a forfeit
       * contradicting one leaves the match to halt undecided and the rows alone carry the verdict.
       */
      function forfeit(live: PlayerThreeMatch, failed: string): void {
        const declared = Object.fromEntries(teams.map((team) => [team, allianceOf.get(team) === allianceOf.get(failed) ? 'loss' : 'win'] as const));
        if (teams.every((team) => live.outcome(team) === 'running' || live.outcome(team) === declared[team])) live.end(declared);
      }
      async function play(): Promise<GameMatchResult> {
        const wall = performance.now();
        let terminal: GameMatchResult['terminal'] = 'finished';
        let reason = 'game_over';
        let failedTeam: string | undefined;
        const sessions: Promise<RunSummary>[] = [];
        // Rows are stored once per metric sample (or sooner when a chunk grows large), not once per tick: every chunk is a
        // durable store transaction, and per-tick chunks dominated headless match time (four-team matches emit rows on
        // nearly every tick). The row bound keeps a chunk well under the series' maxChunkBytes.
        let buffered: Partial<ResultRows> = {};
        let bufferedRows = 0;
        const buffer = (rows: Partial<ResultRows>): void => {
          for (const key of Object.keys(rows) as (keyof ResultRows)[]) {
            const values = rows[key] as unknown[] | undefined;
            if (!values?.length) continue;
            ((buffered as Record<string, unknown[]>)[key] ??= []).push(...values);
            bufferedRows += values.length;
          }
        };
        const flush = async (): Promise<void> => {
          if (!bufferedRows) return;
          const rows = buffered;
          buffered = {};
          bufferedRows = 0;
          await context.emitChunk(rows);
        };
        try {
          signal.throwIfAborted();
          for (const lane of env!.lanes) if (lane.bound.kind === 'policy' && !lane.artifact) {
            failedTeam = lane.bound.seat.team;
            const key = `${lane.entrantId}/${lane.bound.seat.role}`;
            let artifact = prepared.get(key);
            if (!artifact) {
              artifact = (async () => {
                const model = lane.entrantId ? config.models?.[lane.entrantId] : undefined;
                if (!model || !lane.commanderId) throw new Error('missing policy artifact/model');
                const authorSignal = AbortSignal.any([signal, AbortSignal.timeout(config.spec.authoring?.maxWallMs ?? config.spec.execution.maxWallMs)]);
                let summary: RunSummary | undefined;
                // A turn over a hard ceiling ends authoring like the deadline does: the policy active then still plays.
                try { summary = await modelSession(config, model, await env!.connect(lane.commanderId), lane, 'authoring', context.attemptId, authorSignal, { usage, decisions }, account, { dir: options.transcripts, files: [], servedBy: {}, generations: [] }); }
                catch (error) { if (!(error instanceof BudgetExceeded)) throw error; }
                const ended = summary?.reason ?? 'budget';
                pendingEvents.push({ matchId: context.attemptId, sequence: ++sequence, tick: 0, atMs: 0, kind: 'authoring_end', team: null, role: lane.bound.seat.role, data: { reason: ended } });
                const status = env!.host.commanders.roster(env!.owner).find((commander) => commander.id === lane.commanderId)!;
                const token = env!.host.commanders.token(env!.owner, lane.commanderId);
                const version = status.policy.activeByRole[lane.bound.seat.role];
                const active = version == null || !env!.artifacts.has(`${token}/${lane.bound.seat.role}/${version}`) ? undefined : await composedArtifact(env!, lane.commanderId, version, lane.bound.seat.role);
                // Authoring has no early exit: the policy active at its end plays, unless the match itself was aborted.
                if (!active || signal.aborted || ended === 'surface_changed') throw new Error(`policy authoring ${ended}: no active artifact`);
                return active;
              })();
              prepared.set(key, artifact);
            }
            lane.artifact = await artifact;
          }
          failedTeam = undefined;
          const controllers = Object.fromEntries(spec.sides.map((side) => [side.id, Object.fromEntries(env!.lanes.filter((lane) => lane.bound.seat.team === side.id).map((lane) => [lane.bound.seat.role, lane.bound.kind === 'policy' ? 'agent' : lane.bound.kind]))]));
          const botLevel: Record<string, string> = {};
          for (const side of spec.sides) {
            const entrantId = spec.bindings.find((binding) => binding.seat.team === side.id)?.entrantId;
            const level = config.spec.entrants.find((entrant) => entrant.id === entrantId)?.botLevel;
            if (level) botLevel[side.id] = level;
          }
          for (const side of spec.sides) for (const slot of side.seats) if (slot.occupant.kind === 'bot') botLevel[side.id] = slot.occupant.level;
          const botSeats = spec.sides.flatMap((side) => side.seats.flatMap((slot) => slot.occupant.kind === 'bot' ? [{ team: side.id, role: slot.role, level: slot.occupant.level, options: slot.occupant.options }] : []));
          match = env!.host.createMatch({ seed: spec.seed, teams, alliances, observerPolicy: { ...spec.observerPolicy, public: false }, realtime: false, controllers, botLevel, botSeats, metricSampleEveryTicks: config.spec.telemetry.sampleEveryTicks,
            assignments: env!.lanes.filter((lane) => lane.bound.kind === 'agent').map((lane) => ({ ...lane.bound.seat, owner: env!.owner, kind: 'agent', commander: { id: lane.commanderId! } })) });
          matches.set(context.attemptId, match);
          for (const lane of env!.lanes) if (lane.artifact) {
            failedTeam = lane.bound.seat.team;
            const control = match.seat(lane.bound.seat.team, lane.bound.seat.role);
            const mandate = match.seats().find((seat) => seat.team === lane.bound.seat.team && seat.role === lane.bound.seat.role)!.mandate;
            match.setMandate(lane.bound.seat.team, lane.bound.seat.role, { ...mandate, autonomy: 'autonomous', whenAbsent: 'policy' } as MandateOf<AnyManifest>);
            const deployed = await control.policyDeploy(lane.artifact);
            if (!deployed.ok) throw new Error('policy deployment failed');
          }
          failedTeam = undefined;
          for (const lane of env!.lanes) if (lane.bound.kind === 'agent') {
            const model = lane.entrantId ? config.models?.[lane.entrantId] : undefined;
            if (!model) throw new Error('missing live model');
            const running = modelSession(config, model, await env!.connect(lane.commanderId!), lane, 'inference', context.attemptId, signal, { usage, decisions }, account, { dir: options.transcripts, files: [], servedBy: {}, generations: [] });
            void running.then((summary) => { if (!signal.aborted && ['budget', 'provider_error', 'surface_changed', 'max_turns'].includes(summary.reason)) { failedTeam = lane.bound.seat.team; reason = summary.reason; } }, (error) => { if (!signal.aborted) { failedTeam = lane.bound.seat.team; reason = error instanceof BudgetExceeded ? 'budget' : 'provider_error'; } }); sessions.push(running);
          }
          const clockStarted = performance.now();
          while (!signal.aborted && !failedTeam && match.tick < config.spec.execution.maxTicks && teams.some((team) => match!.outcome(team) === 'running')) {
            const before = match.tick;
            await match.step(1);
            if (match.tick !== before + 1) throw new Error('adapter must advance exactly one tick per step');
            const raw = match.metricRows();
            const remapped: Partial<ResultRows> = {};
            for (const key of Object.keys(raw) as (keyof ResultRows)[]) {
              const values = raw[key];
              if (key === 'intents') continue;
              if (values?.length) Object.assign(remapped, { [key]: values.filter((row) => key !== 'events' || !('kind' in row) || row.kind !== 'intent_ack').map((row) => ({ ...row, matchId: context.attemptId, ...('sequence' in row ? { sequence: ++sequence } : {}) })) });
            }
            if (pendingEvents.length) { remapped.events = [...(remapped.events ?? []), ...pendingEvents]; pendingEvents = []; }
            buffer(remapped);
            if (bufferedRows >= CHUNK_ROWS || match.tick % config.spec.telemetry.sampleEveryTicks === 0) await flush();
            await flushAccounting();
            const targetMs = match.tick * 1000 / definition.manifest.tickRate / config.spec.execution.speed;
            const remainingMs = targetMs - (performance.now() - clockStarted);
            if (remainingMs > 0) await setTimeout(remainingMs, undefined, { signal }).catch(() => {});
            else await setImmediate();
          }
          if (failedTeam && !signal.aborted) { terminal = 'forfeit'; forfeit(match, failedTeam); }
          else if (signal.aborted || teams.some((team) => match!.outcome(team) === 'running')) { terminal = 'aborted'; reason = abortReason ?? (signal.aborted ? (context.signal.reason as AbortReason | undefined) ?? 'owner' : 'tick_limit'); }
        } catch (error) {
          const infrastructure = error instanceof Error && 'infrastructure' in error && error.infrastructure === true;
          terminal = signal.aborted ? 'aborted' : failedTeam ? 'forfeit' : infrastructure ? 'infra_error' : 'aborted';
          reason = signal.aborted ? abortReason ?? (context.signal.reason as AbortReason | undefined) ?? 'owner' : failedTeam ? 'policy_failed' : 'adapter_error';
          if (terminal === 'forfeit' && failedTeam && match) forfeit(match, failedTeam);
        }
        finally { ended.abort(); await Promise.allSettled(sessions); await flushAccounting(); }
        // A halted match denies its control plane, so policy counters are read while it is still live.
        const policyStats: [Lane, Record<string, number>][] = [];
        if (match) for (const lane of env!.lanes) if (lane.artifact) {
          const stats = await match.seat(lane.bound.seat.team, lane.bound.seat.role).policyStatus();
          if (stats && stats.version !== null) policyStats.push([lane, { 'policy.calls': stats.calls, 'policy.errors': stats.errors, 'policy.timeouts': stats.timeouts, 'policy.intentsEmitted': stats.intentsEmitted }]);
        }
        await match?.halt();
        for (const seed of env!.practiceSeedsUsed.splice(0)) pendingEvents.push({ matchId: context.attemptId, sequence: ++sequence, tick: 0, atMs: 0, kind: 'practice_run', team: null, role: null, data: { seed } });
        const tick = match?.tick ?? 0;
        const metrics: MetricRow[] = [];
        const numeric = snapshotMetrics(match?.metrics() ?? { match: {}, sides: {} }, teams);
        if (match) {
          const raw = match.metricRows();
          const remapped: Partial<ResultRows> = {};
          for (const key of Object.keys(raw) as (keyof ResultRows)[]) {
            if (key === 'intents') continue;
            const values = raw[key];
            if (values?.length) Object.assign(remapped, { [key]: values.filter((row) => key !== 'events' || !('kind' in row) || row.kind !== 'intent_ack').map((row) => ({ ...row, matchId: context.attemptId, ...('sequence' in row ? { sequence: ++sequence } : {}) })) });
          }
          buffer(remapped);
        }
        await flush();
        for (const [metric, value] of Object.entries(numeric.match)) metrics.push({ matchId: context.attemptId, tick, sequence: ++sequence, scope: 'match', team: null, role: null, metric, value, unit: summaryUnits.get(`match:${metric}`) ?? 'game' });
        for (const [team, values] of Object.entries(numeric.sides)) for (const [metric, value] of Object.entries(values)) metrics.push({ matchId: context.attemptId, tick, sequence: ++sequence, scope: 'side', team, role: null, metric, value, unit: summaryUnits.get(`side:${metric}`) ?? 'game' });
        for (const [lane, values] of policyStats) for (const [metric, value] of Object.entries(values)) metrics.push({ matchId: context.attemptId, tick, sequence: ++sequence, scope: 'seat', ...lane.bound.seat, metric, value, unit: 'count' });
        const seats: SeatRow[] = env!.lanes.map((lane) => {
          const buckets = [...intents.values()].filter((row) => row.team === lane.bound.seat.team && row.role === lane.bound.seat.role);
          const submitted = buckets.reduce((sum, row) => sum + row.submitted, 0);
          const accepted = buckets.reduce((sum, row) => sum + row.accepted, 0);
          return { matchId: context.attemptId, ...lane.bound.seat, entrantId: lane.entrantId, executionKind: lane.bound.kind, fallbackKind: null, artifactVersion: lane.artifact ? 1 : null, artifactHash: lane.artifact ? createHash('sha256').update(canonicalJson(lane.artifact)).digest('hex') : null, readyState: match ? 'ready' : 'policy_failed', activeTicks: lane.bound.kind === 'none' ? 0 : tick, submittedIntents: submitted, acceptedIntents: accepted, rejectedIntents: submitted - accepted, commandApm: tick ? accepted * 60 * definition.manifest.tickRate / tick : 0, policyErrors: policyErrors.get(`${lane.bound.seat.team}/${lane.bound.seat.role}`) ?? 0 };
        });
        const refs: GameMatchResult['artifacts'][number][] = [];
        if (match) {
          for (const team of teams) pendingEvents.push({ matchId: context.attemptId, sequence: ++sequence, tick, atMs: tick * 1000 / definition.manifest.tickRate, kind: 'game_report', team, role: null, data: { report: match.report(team) } });
          const replay = match.replay();
          const bytes = new TextEncoder().encode(JSON.stringify(replay));
          const id = `${context.attemptId}/replay`;
          artifactDirectory ??= mkdtemp(join(tmpdir(), 'playerthree-series-artifacts-'));
          const path = join(await artifactDirectory, `${createHash('sha256').update(id).digest('hex')}.json`);
          await writeFile(path, bytes);
          artifacts.set(id, path);
          refs.push({ id, matchId: context.attemptId, kind: 'replay', format: replay.format, version: replay.version, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength, availability: 'available' });
        }
        const played = match;
        return { terminal, terminalReason: reason, ticks: tick, simulatedMs: tick * 1000 / definition.manifest.tickRate, wallMs: performance.now() - wall,
          outcomes: teams.map((team) => {
            // A forfeit is the bench's verdict: the failed side's alliance places last, every other unit shares first.
            if (terminal === 'forfeit' && failedTeam) return allianceOf.get(team) === allianceOf.get(failedTeam) ? { team, rank: units.size, outcome: 'loss', reason } : { team, rank: 1, outcome: 'win', reason };
            if (terminal !== 'finished' || !played || played.outcome(team) === 'running') return { team, rank: null, outcome: 'aborted', reason };
            // Allies report one outcome: their unit's best member's, as the host ranks units (a draw shares first place).
            const members = units.get(allianceOf.get(team)!)!.map((member) => played.outcome(member));
            return { team, rank: played.rank(team), outcome: members.includes('win') ? 'win' : members.includes('draw') ? 'draw' : 'loss', reason };
          }),
          metrics, artifacts: refs, rows: { seats, usage, decisions, intents: [...intents.values()], events: pendingEvents } };
      }
      return { id: context.attemptId, finished: done.promise,
        async start() { if (started) return; started = true; void play().then(done.resolve, done.reject); },
        async abort(reason) { abortReason = reason; ended.abort(); if (!started) { started = true; void play().then(done.resolve, done.reject); } await done.promise; },
        async dispose() { ended.abort(); untrace(); matches.delete(context.attemptId); match?.dispose(); },
      };
    },
    async *observe(matchId, grant, after) { const match = matches.get(matchId); if (!match) throw new Error('match unavailable'); yield* match.observerFrames(grant, after); },
    async artifact(id) { const path = artifacts.get(id); if (!path) throw new Error('artifact unavailable'); return createReadStream(path); },
  };
  return { host, binder,
    async author(candidateId, externalSignal, authorOptions = {}) {
      const attemptId = randomUUID();
      const harness = authorOptions.harness;
      const identity: HarnessIdentity = harness?.identity ?? { ...RUNNER_HARNESS };
      // Setup failures throw: the caller records them as infrastructure, never as a model failure. The wall clock
      // starts only after the starter pre-deploy, so binding runs under the operator's signal alone.
      // The lobby seats each entrant's frozen seat blueprint (`entrantSeats`), as its evaluation matches will.
      const template = { ...config.spec.template, sides: config.spec.template.sides.map((side) => ({ ...side, seats: side.seats.map((slot) => {
        const entrantId = config.spec.template.bindings.find((b) => b.seat.team === side.id && b.seat.role === slot.role)?.entrantId;
        return config.spec.entrantSeats?.find((e) => e.entrantId === entrantId)?.seats.find((s) => s.role === slot.role) ?? slot;
      }) })) };
      const binding = await binder.bind(AUTHORING_OWNER, await host.resolve(template), { attemptId, signal: externalSignal ?? new AbortController().signal, reset: true });
      const env = environments.get(attemptId)!;
      const usage: UsageRow[] = [];
      const decisions: DecisionRow[] = [];
      const budget: SeriesAccount = { tokens: 0, usd: 0, turns: 0, reservedTokens: 0, reservedUsd: 0, reservedTurns: 0 };
      const trace: SessionTrace = { dir: options.transcripts, files: [], servedBy: {}, generations: [] };
      let reportedUsd: number | null = null;
      let billed: BilledUsage | null = null;
      // Assigned inside the attempt below; read in its `finally`.
      let watch = null as KeyUsageWatch | null;
      let started = performance.now();
      let turns = 0;
      let providerErrors = 0;
      const result = (policies: Record<string, PolicyArtifact> | null, reason: string, infrastructure: boolean, policyDigests: Record<string, string> = {}): AuthoredPolicies => ({
        policies, reason, usage, infrastructure, transcripts: trace.files, servedBy: trace.servedBy, generations: trace.generations, harness: identity,
        wallMs: Math.round(performance.now() - started), turns, providerErrors, inputTokens: usage.reduce((n, row) => n + (row.inputTokens ?? 0), 0), outputTokens: usage.reduce((n, row) => n + (row.outputTokens ?? 0), 0),
        reportedUsd, billed, timeline: [...env.timeline], policyDigests });
      const infrastructure = (reason: string) => result(null, reason, true);
      let authored: AuthoredPolicies;
      try {
        authored = await (async (): Promise<AuthoredPolicies> => {
          const lanes = env.lanes.filter(l => l.entrantId === candidateId && l.bound.kind === 'policy');
          if (!lanes.length) return infrastructure('missing_policy_seats');
          const model = config.models?.[candidateId];
          if (!model) return infrastructure('missing_model');
          const keyName = modelKeyEnv(model);
          const apiKey = keyName ? process.env[keyName] ?? '' : '';
          const roles = lanes.map(l => l.bound.seat.role);
          // One persistent lobby commander commands every controlled role, one policy per role (SPEC §20.11).
          const commander = env.host.commanders.create(env.owner, { name: `${candidateId}/${lanes[0]!.bound.seat.team}/authoring`, kind: 'policy', roles, isolation: { independentSessions: true } });
          env.host.commanders.update(env.owner, commander.id, { scopes: definition.manifest.control.practice ? ['policy', 'practice'] : ['policy'], mandate: { ...commander.mandate, autonomy: 'autonomous', whenAbsent: 'policy' } });
          const token = env.host.commanders.token(env.owner, commander.id);
          const lane: Lane = { bound: lanes[0]!.bound, entrantId: candidateId, commanderId: commander.id, roles };
          // Before the clock: each named role's starter by reference with default knobs, so a policy is always active.
          for (const role of roles) {
            const from = config.spec.authoring?.starters?.[role];
            if (from === undefined) continue;
            const deployed = await env.predeploy(token, role, { from });
            if (!deployed.ok) return infrastructure('starter_predeploy_failed');
          }
          const stop = new AbortController();
          let billedStop = false;
          const maxUsd = config.spec.budgets.maxCostUsd === null ? null : Number(config.spec.budgets.maxCostUsd);
          if (model.billing === 'openrouter-key' && apiKey && maxUsd !== null) {
            watch = await watchKeyUsage({ baseUrl: model.baseUrl!, apiKey, ceilingUsd: maxUsd, onCeiling: () => { billedStop = true; stop.abort(); } });
          }
          started = performance.now();
          const wallMs = config.spec.authoring?.maxWallMs ?? config.spec.execution.maxWallMs;
          const deadlineAt = Date.now() + wallMs;
          const wall = AbortSignal.timeout(wallMs);
          const signal = AbortSignal.any([...(externalSignal ? [externalSignal] : []), wall, stop.signal]);
          signal.addEventListener('abort', () => env.freeze(), { once: true });
          let reason: string;
          if (!harness) {
            const stats: SessionStats = { turns: 0, providerErrors: 0, providerError: undefined };
            let summary: RunSummary | undefined;
            let thrown: unknown;
            try { summary = await modelSession(config, model, await env.connect(commander.id), lane, 'authoring', attemptId, signal, { usage, decisions }, budget, trace, stats); }
            catch (error) { thrown = error; }
            turns = stats.turns;
            providerErrors = stats.providerErrors;
            // Operator interruption is never a model outcome, even after a deploy.
            if (externalSignal?.aborted) return infrastructure('authoring_interrupted');
            if (thrown instanceof BudgetExceeded || billedStop) reason = 'budget';
            else if (thrown !== undefined || summary!.reason === 'provider_error') {
              const error = thrown ?? stats.providerError;
              // Harness/seat errors, failures before any completed turn and provider outages say nothing about the model.
              if (error !== stats.providerError) return infrastructure('harness_error');
              if (stats.turns === 0 || transientProviderFailure(error)) return infrastructure('provider_unavailable');
              reason = 'provider_error';
            } else if (summary!.reason === 'surface_changed') return infrastructure('surface_changed');
            // runAgent reports the wall-clock cutoff as `aborted`; the external signal was handled above.
            else reason = summary!.reason === 'aborted' ? 'cutoff' : summary!.reason;
          } else {
            const price = model.price ?? priceFor(model.model);
            const seriesBudget = new SeriesBudget(config, model, budget);
            const file = options.transcripts === undefined ? undefined : join(options.transcripts, `${lane.bound.executionId}-authoring.jsonl`);
            let out: WriteStream | undefined;
            if (file) {
              await mkdir(options.transcripts!, { recursive: true, mode: 0o700 });
              out = createWriteStream(file, { flags: 'a', mode: 0o600 });
              trace.files.push(basename(file));
            }
            // Credentials never enter the transcript, even if a harness event echoes them.
            const secrets = [token, apiKey].filter(secret => secret.length >= MIN_REDACTED_SECRET);
            const write = (event: Record<string, unknown>) => {
              let line = JSON.stringify({ at: new Date().toISOString(), ...event });
              for (const secret of secrets) line = line.replaceAll(secret, '[redacted]');
              out?.write(`${line}\n`);
            };
            const seat = await env.connect(commander.id);
            let brief: string;
            try { brief = await sessionBrief(config, seat, 'authoring'); }
            finally { await seat.close(); }
            const systemPrompt = config.spec.authoring?.systemPrompt;
            const contextTokens = config.spec.authoring?.contextTokens;
            const reasoning = config.spec.authoring?.reasoning;
            write({ kind: 'session', harness: identity, phase: 'authoring', entrantId: candidateId, roles, provider: model.provider, wire: modelWire(model), model: model.model, request: model.request ?? null, maxOutputTokens: maxOutputTokensOf(config.spec), reasoning: reasoning ?? null, maxTurns: config.spec.budgets.maxTurns, system: brief, systemPrompt: systemPrompt ?? null, contextTokens: contextTokens ?? null, blockedTools: AUTHORING_BLOCKED_TOOLS });
            if (authorOptions.scratch) await mkdir(authorOptions.scratch, { recursive: true, mode: 0o700 });
            const scratch = await mkdtemp(join(authorOptions.scratch ?? tmpdir(), 'playerthree-harness-'));
            let outcome: HarnessOutcome;
            try {
              outcome = await harness.author({ url: env.url, token, surfaceHash: config.spec.surfaceHash, roles, model, apiKey, maxOutputTokens: maxOutputTokensOf(config.spec), brief, ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(contextTokens !== undefined ? { contextTokens } : {}), ...(reasoning !== undefined ? { reasoning } : {}), blockedTools: AUTHORING_BLOCKED_TOOLS,
                status: () => lobbyStatus(env, commander.id, roles), transcript: write, scratch, signal, deadlineAt,
                canAfford: (input, output) => seriesBudget.canAfford(input, output),
                charge(turn) {
                  const row = usageRow(lane, 'authoring', attemptId, `${lane.bound.executionId}/authoring/${budget.turns + 1}`, price, turn);
                  budget.tokens += turn.inputTokens + turn.outputTokens;
                  budget.usd += row.costAmount === null ? 0 : Number(row.costAmount);
                  budget.turns++;
                  usage.push(row);
                  if (turn.reportedUsd !== undefined) reportedUsd = (reportedUsd ?? 0) + turn.reportedUsd;
                  if (turn.servedBy) trace.servedBy[turn.servedBy] = (trace.servedBy[turn.servedBy] ?? 0) + 1;
                  else if (turn.generationId) trace.generations.push(turn.generationId);
                  return budget.tokens <= seriesBudget.maxTokens && budget.usd <= seriesBudget.maxUsd && budget.turns <= seriesBudget.maxTurns;
                } });
            } catch (error) {
              write({ kind: 'end', thrown: 'harness_error', detail: error instanceof Error ? error.message : String(error) });
              outcome = { reason: 'harness_error', turns: budget.turns, providerErrors: 0 };
            } finally {
              await rm(scratch, { recursive: true, force: true });
            }
            turns = outcome.turns;
            providerErrors = outcome.providerErrors;
            write({ kind: 'end', reason: outcome.reason, turns: outcome.turns, providerErrors: outcome.providerErrors });
            if (out) { const closed = Promise.withResolvers<void>(); out.end(closed.resolve); await closed.promise; }
            if (externalSignal?.aborted) return infrastructure('authoring_interrupted');
            if (outcome.reason === 'budget' || billedStop) reason = 'budget';
            else if (outcome.reason === 'harness_error') return infrastructure('harness_error');
            else if (outcome.reason === 'surface_changed') return infrastructure('surface_changed');
            else if (outcome.reason === 'provider_error') {
              const status = outcome.providerStatus ?? null;
              if (outcome.turns === 0 || status === null || status === 408 || status === 429 || status >= 500) return infrastructure('provider_unavailable');
              reason = 'provider_error';
            } else reason = 'cutoff';
          }
          // A deadline reached without one completed model turn measured the provider or harness, never the model:
          // scoring it would score the pre-deployed starters as the model's work.
          if (reason === 'cutoff' && turns === 0) return infrastructure('no_model_turns');
          // The latest valid deployed artifact of every role is frozen at the deadline: authoring has no early exit.
          const policies: Record<string, PolicyArtifact> = {};
          const policyDigests: Record<string, string> = {};
          const status = env.host.commanders.roster(env.owner).find(c => c.id === commander.id)!;
          for (const role of roles) {
            const version = status.policy.activeByRole[role];
            const active = version == null || !env.artifacts.has(`${token}/${role}/${version}`) ? undefined : await composedArtifact(env, commander.id, version, role);
            if (!active) return result(null, reason === 'budget' || reason === 'provider_error' ? reason : 'no_valid_artifact', false);
            policies[role] = structuredClone(active);
            policyDigests[role] = sha256(active);
          }
          return result(policies, reason, false, policyDigests);
        })();
      } finally {
        // The billed delta is read after the run settles (at once after an operator stop), whatever the outcome.
        if (watch) billed = await watch.finish(!externalSignal?.aborted);
        await binding.release();
      }
      return { ...authored, billed };
    },
    async close() {
    try { await Promise.all([...environments.values()].map((env) => env.close())); }
    finally { environments.clear(); if (artifactDirectory) await rm(await artifactDirectory, { recursive: true, force: true }); }
  } };
}
