/**
 * The OpenCode authoring harness (SPEC §20.11): `opencode run` headless in a fresh isolated home and an empty working
 * directory, reaching the game only through the `playerthree-mcp` stdio bridge with the lobby commander's credential.
 * Bash, web fetch, web search, files outside the working directory and the game's live-play tools are denied.
 *
 * OpenCode never sees the provider key: its only provider is a loopback metering proxy, which adds the key and the
 * model's private request extras (router pinning), caps each reply's output, buffers each reply whole, charges its
 * actual cost (`turnCostUsd`) against the run's ceilings and withholds a reply that crosses one, so its tool calls never run.
 * It records the upstream, generation id and cost the router reports. When a run ends before the deadline, the harness
 * continues the same OpenCode session with the seat's status: authoring has no early exit.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { priceFor } from '@playerthree/runner';
import { routerGenerationCost } from './billing.ts';
import type { AuthoringHarness, AuthoringLobby, HarnessOutcome } from './harness.ts';

export const OPENCODE_HARNESS_ID = 'opencode';
/** Context window OpenCode compacts against when the operator names none, tokens. */
export const OPENCODE_CONTEXT_TOKENS = 128_000;
/** Pause before the next run after a run that completed no model turn. */
export const OPENCODE_RETRY_PAUSE_MS = 10_000;
/** Consecutive runs without a completed model turn that end authoring as a provider (or harness) failure. */
export const OPENCODE_MAX_IDLE_RUNS = 3;
/** OpenCode's wait for the bridge's tool listing, ms: the bridge acquires the endpoint on that first request. */
const MCP_TIMEOUT_MS = 60_000;
/** Between SIGTERM and SIGKILL of an OpenCode process group at the deadline. */
const KILL_GRACE_MS = 5_000;
/** The runner's input-estimate convention: characters of request JSON per token. */
const CHARS_PER_TOKEN = 3;
/** Largest request body the proxy accepts, bytes. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
/** Clip of a provider error body or a non-JSON OpenCode line in the transcript, characters. */
const TRANSCRIPT_CLIP = 2_000;
/** The generated config's provider id (its only provider: the metering proxy). */
const PROVIDER_ID = 'bench';
/** The bridge's MCP server name: OpenCode names its tools `game_<tool>`. */
const MCP_SERVER = 'game';

export interface OpenCodeOptions {
  /** The `opencode` platform binary, e.g. `<prefix>/node_modules/opencode-linux-x64/bin/opencode`. */
  bin: string;
  /** Context window OpenCode compacts against, tokens (default {@link OPENCODE_CONTEXT_TOKENS}). */
  contextTokens?: number;
  /** The stdio bridge command (default: the linked runner's `playerthree-mcp` under this Node). */
  bridge?: readonly string[];
  /** Pause after a run that completed no model turn, ms (default {@link OPENCODE_RETRY_PAUSE_MS}). */
  retryPauseMs?: number;
  /** Pause between lookups of a generation's billed cost not yet published, ms (default `GENERATION_LOOKUP_RETRY_MS`). */
  generationRetryMs?: number;
}

/** The linked runner's `playerthree-mcp` bin beside its resolved entry (`src/index.ts` → `bin/playerthree-mcp.ts`; dist alike). */
function defaultBridge(): string[] {
  const entry = import.meta.resolve('@playerthree/runner');
  return [process.execPath, fileURLToPath(new URL(`../bin/playerthree-mcp${entry.endsWith('.ts') ? '.ts' : '.js'}`, entry))];
}

/** Reads the binary's version (the harness identity) before any authoring; a binary that reports none is refused. */
export async function openCodeHarness(options: OpenCodeOptions): Promise<AuthoringHarness> {
  const { stdout } = await promisify(execFile)(options.bin, ['--version'], { timeout: 30_000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(version)) throw new Error(`opencode --version reported no version: ${JSON.stringify(version.slice(0, 64))}`);
  return { identity: { id: OPENCODE_HARNESS_ID, version }, author: (lobby) => authorWithOpenCode(options, lobby) };
}

/** What the proxy read from one reply (SSE stream or JSON body). */
interface Reply {
  id?: string; provider?: string; finishReason?: string; toolCalls: string[];
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; costUsd?: number };
  error?: { status: number | null; message: string };
}

/** Parses an OpenAI-compatible chat completion (streamed or not), keeping only accounting and identity fields. */
function parseReply(text: string, streamed: boolean): Reply {
  const reply: Reply = { toolCalls: [] };
  const chunks: unknown[] = [];
  if (streamed) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { chunks.push(JSON.parse(data)); } catch { /* A malformed chunk carries no accounting. */ }
    }
  } else {
    try { chunks.push(JSON.parse(text)); } catch { reply.error = { status: null, message: 'unparseable reply' }; }
  }
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue;
    const c = chunk as { id?: unknown; provider?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null } | null; error?: { code?: unknown; message?: unknown }; choices?: { finish_reason?: unknown; delta?: { tool_calls?: { function?: { name?: unknown } }[] }; message?: { tool_calls?: { function?: { name?: unknown } }[] } }[] };
    if (typeof c.id === 'string') reply.id = c.id;
    if (typeof c.provider === 'string' && c.provider) reply.provider = c.provider;
    if (c.error) reply.error = { status: typeof c.error.code === 'number' ? c.error.code : null, message: String(c.error.message ?? 'provider error').slice(0, TRANSCRIPT_CLIP) };
    if (c.usage && typeof c.usage.prompt_tokens === 'number' && typeof c.usage.completion_tokens === 'number') {
      const cached = c.usage.prompt_tokens_details?.cached_tokens;
      reply.usage = { inputTokens: c.usage.prompt_tokens, outputTokens: c.usage.completion_tokens, ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}), ...(typeof c.usage.cost === 'number' ? { costUsd: c.usage.cost } : {}) };
    }
    for (const choice of c.choices ?? []) {
      if (typeof choice.finish_reason === 'string') reply.finishReason = choice.finish_reason;
      for (const call of [...choice.delta?.tool_calls ?? [], ...choice.message?.tool_calls ?? []]) if (typeof call.function?.name === 'string' && call.function.name) reply.toolCalls.push(call.function.name);
    }
  }
  return reply;
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += (part as Buffer).byteLength;
    if (size > MAX_REQUEST_BYTES) return null;
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

const sendJson = (res: ServerResponse, status: number, message: string) => {
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message, code: status } }));
};

interface MeteringProxy {
  url: string;
  /** Model turns charged and provider requests forwarded. */
  turns(): number; requests(): number;
  /** HTTP status of the last provider failure (null: network), undefined when the last request succeeded. */
  providerStatus(): number | null | undefined;
  close(): Promise<void>;
}

/** The loopback OpenAI-compatible endpoint OpenCode talks to; `onBudget` fires when a ceiling stops authoring. */
async function meteringProxy(lobby: AuthoringLobby, onBudget: () => void, options: { generationCost?: (id: string) => Promise<number | null> }): Promise<MeteringProxy> {
  const { model } = lobby;
  if (model.provider !== 'openai') throw new Error(`the OpenCode harness needs an OpenAI-compatible model route, not ${model.provider}`);
  const upstream = `${model.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`;
  const cap = lobby.maxOutputTokens;
  let turns = 0;
  let requests = 0;
  let over = false;
  let providerStatus: number | null | undefined;
  const refuse = (res: ServerResponse) => sendJson(res, 402, 'benchmark authoring budget exhausted');
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST' || !new URL(req.url ?? '/', 'http://proxy').pathname.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    const raw = await readBody(req);
    if (raw === null) { sendJson(res, 413, 'request too large'); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw.toString('utf8')); } catch { sendJson(res, 400, 'request is not JSON'); return; }
    if (over || lobby.signal.aborted) { refuse(res); return; }
    const estimate = Math.ceil(raw.byteLength / CHARS_PER_TOKEN);
    if (!lobby.canAfford(estimate, cap)) { over = true; lobby.transcript({ kind: 'budget', detail: 'next turn could cross a ceiling' }); onBudget(); refuse(res); return; }
    const requested = typeof body['max_tokens'] === 'number' ? body['max_tokens'] : cap;
    const { max_completion_tokens: _ignored, ...rest } = body;
    // The model id and router extras are the bench's, never OpenCode's; OpenRouter `usage.include` reports each turn's cost.
    const sent: Record<string, unknown> = { ...rest, ...model.request, model: model.model, max_tokens: Math.min(requested, cap), usage: { include: true } };
    const streamed = sent['stream'] === true;
    requests++;
    let upstreamRes: Response;
    let bytes: Buffer;
    try {
      upstreamRes = await fetch(upstream, { method: 'POST', headers: { authorization: `Bearer ${lobby.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(sent), signal: lobby.signal });
      bytes = Buffer.from(await upstreamRes.arrayBuffer());
    } catch {
      if (lobby.signal.aborted) { refuse(res); return; }
      providerStatus = null;
      lobby.transcript({ kind: 'provider_error', status: null, detail: 'unreachable' });
      sendJson(res, 502, 'provider unreachable');
      return;
    }
    if (!upstreamRes.ok) {
      providerStatus = upstreamRes.status;
      lobby.transcript({ kind: 'provider_error', status: upstreamRes.status, detail: bytes.toString('utf8').slice(0, TRANSCRIPT_CLIP) });
      res.writeHead(upstreamRes.status, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' }).end(bytes);
      return;
    }
    const reply = parseReply(bytes.toString('utf8'), streamed);
    if (reply.error && !reply.usage) {
      providerStatus = reply.error.status;
      lobby.transcript({ kind: 'provider_error', status: reply.error.status, detail: reply.error.message });
      sendJson(res, reply.error.status ?? 502, reply.error.message);
      return;
    }
    // A reply without reported usage is charged at its reservation: never undercounted.
    const usage = reply.usage ?? { inputTokens: estimate, outputTokens: cap };
    // Charged at its actual cost: the reply's own, else its generation's billed cost, else the cache-aware estimate.
    const costUsd = usage.costUsd ?? (reply.id && options.generationCost ? await options.generationCost(reply.id) ?? undefined : undefined);
    const within = lobby.charge({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}), ...(reply.provider ? { servedBy: reply.provider } : {}), ...(reply.id ? { generationId: reply.id } : {}), ...(costUsd !== undefined ? { reportedUsd: costUsd } : {}) });
    turns++;
    providerStatus = undefined;
    lobby.transcript({ kind: 'turn', turn: turns, generationId: reply.id ?? null, servedBy: reply.provider ?? null, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens ?? null, reportedUsd: costUsd ?? null, costFrom: usage.costUsd !== undefined ? 'reply' : costUsd !== undefined ? 'generation' : 'estimate', usageReported: reply.usage !== undefined, finishReason: reply.finishReason ?? null, toolCalls: reply.toolCalls, withheld: !within });
    if (!within) { over = true; onBudget(); refuse(res); return; }
    res.writeHead(200, { 'content-type': upstreamRes.headers.get('content-type') ?? (streamed ? 'text/event-stream' : 'application/json') }).end(bytes);
  };
  const server = createServer((req, res) => { handle(req, res).catch(() => sendJson(res, 500, 'proxy failure')); });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    turns: () => turns, requests: () => requests, providerStatus: () => providerStatus,
    async close() { server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; },
  };
}

/** One `opencode run`; its whole process group (OpenCode and the bridge it spawned) is killed when `signal` aborts and reaped after exit. */
function runOnce(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal, onEvent: (event: Record<string, unknown>) => void): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr = (stderr + text).slice(-TRANSCRIPT_CLIP); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    try { onEvent(JSON.parse(line)); } catch { onEvent({ type: 'stdout', text: line.slice(0, TRANSCRIPT_CLIP) }); }
  });
  const group = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { /* Already gone. */ } };
  const kill = () => { group('SIGTERM'); setTimeout(() => group('SIGKILL'), KILL_GRACE_MS).unref(); };
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; signal: string | null; stderr: string }>();
  child.once('error', reject);
  child.once('spawn', () => { signal.addEventListener('abort', kill, { once: true }); if (signal.aborted) kill(); });
  child.once('close', (code, exitSignal) => {
    signal.removeEventListener('abort', kill);
    // Leftover bridge processes never outlive their run.
    group('SIGKILL');
    resolve({ code, signal: exitSignal, stderr });
  });
  return promise;
}

const minutesLeft = (deadlineAt: number) => Math.max(0, Math.round((deadlineAt - Date.now()) / 60_000));

/** The first prompt: the runner-authored brief, plus how this harness names the game's tools and the pre-deployed state. */
function firstPrompt(lobby: AuthoringLobby): string {
  return `${lobby.brief}\n\nIn this harness the game's tools come from the MCP server "${MCP_SERVER}" and are named \`${MCP_SERVER}_<tool>\` (for example \`${MCP_SERVER}_policy_deploy\`).${lobby.roles.length > 1 ? ` You command ${lobby.roles.length} roles: ${lobby.roles.join(', ')}. Each is its own seat with its own policy: pass \`role\` to every game tool call (game_skill excepted), and prepare a policy for each role.` : ''} You are a persistent commander in the lobby: no match is running yet. ${lobby.status()} Authoring runs until its deadline (about ${minutesLeft(lobby.deadlineAt)} minutes); the policies active then are the ones evaluated. Begin.`;
}

/** The no-early-exit re-prompt: the seat's status and the time left. */
function statusPrompt(lobby: AuthoringLobby): string {
  return `[harness] Authoring continues until its deadline (about ${minutesLeft(lobby.deadlineAt)} minutes left); ending your turn does not end it, and the policies active at the deadline are the ones evaluated. ${lobby.status()} Keep improving them: practice against the strongest opponent, read the report and your policies' logs, tune the starters' knobs or fork them, and redeploy only what does at least as well.`;
}

async function authorWithOpenCode(options: OpenCodeOptions, lobby: AuthoringLobby): Promise<HarnessOutcome> {
  const budget = new AbortController();
  // OpenRouter-style routers (billing `openrouter-key`) publish each generation's billed cost by id.
  const generationCost = lobby.model.billing === 'openrouter-key' && lobby.model.baseUrl
    ? (id: string) => routerGenerationCost(lobby.model.baseUrl!, lobby.apiKey, id, { signal: lobby.signal, ...(options.generationRetryMs !== undefined ? { retryMs: options.generationRetryMs } : {}) })
    : undefined;
  const proxy = await meteringProxy(lobby, () => budget.abort(), { generationCost });
  const signal = AbortSignal.any([lobby.signal, budget.signal]);
  try {
    const home = join(lobby.scratch, 'home');
    const work = join(lobby.scratch, 'work');
    await mkdir(work, { recursive: true, mode: 0o700 });
    await mkdir(home, { recursive: true, mode: 0o700 });
    const price = lobby.model.price ?? priceFor(lobby.model.model);
    const modelRef = `${PROVIDER_ID}/${lobby.model.model}`;
    const limit = { context: options.contextTokens ?? OPENCODE_CONTEXT_TOKENS, output: lobby.maxOutputTokens };
    const config = {
      $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', snapshot: false,
      provider: { [PROVIDER_ID]: { npm: '@ai-sdk/openai-compatible', name: 'PlayerThree bench metering proxy', options: { baseURL: `${proxy.url}/v1`, apiKey: 'metered-by-proxy' },
        models: { [lobby.model.model]: { name: lobby.model.model, tool_call: true, limit, ...(price ? { cost: { input: price.inPerM, output: price.outPerM } } : {}) } } } },
      model: modelRef, small_model: modelRef,
      mcp: { [MCP_SERVER]: { type: 'local', command: [...options.bridge ?? defaultBridge(), '--url', lobby.url, '--expect-hash', lobby.surfaceHash], environment: { PLAYERTHREE_TOKEN: lobby.token }, enabled: true, timeout: MCP_TIMEOUT_MS } },
      permission: { bash: 'deny', webfetch: 'deny', websearch: 'deny', external_directory: 'deny' },
      tools: Object.fromEntries(['bash', 'webfetch', 'websearch', ...lobby.blockedTools.map((tool) => `${MCP_SERVER}_${tool}`)].map((tool) => [tool, false])),
    };
    // Nothing of the operator's environment reaches OpenCode: no keys, no user config, plugins, skills or project files.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local', 'state'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_PURE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    };
    lobby.transcript({ kind: 'harness', bin: options.bin, config: { ...config, mcp: { [MCP_SERVER]: { type: 'local', bridge: true, url: lobby.url } }, provider: { [PROVIDER_ID]: { proxy: true, model: lobby.model.model, limit } } } });
    let session: string | undefined;
    let idle = 0;
    for (let run = 0; !signal.aborted; run++) {
      const prompt = session === undefined ? firstPrompt(lobby) : statusPrompt(lobby);
      const turnsBefore = proxy.turns();
      const requestsBefore = proxy.requests();
      lobby.transcript({ kind: 'prompt', run, session: session ?? null, text: prompt });
      // `--auto` approves what is not explicitly denied (no one answers a prompt headless); the config denies the rest.
      const args = ['run', '--pure', '--auto', '--format', 'json', ...(session === undefined ? ['--title', 'benchmark authoring'] : ['--session', session]), prompt];
      const exit = await runOnce(options.bin, args, env, work, signal, (event) => {
        if (session === undefined && typeof event['sessionID'] === 'string') session = event['sessionID'];
        lobby.transcript({ kind: 'opencode', run, event });
      });
      const charged = proxy.turns() - turnsBefore;
      lobby.transcript({ kind: 'run_end', run, exit: exit.code, signal: exit.signal, turns: charged, ...(exit.code !== 0 && !signal.aborted ? { stderr: exit.stderr } : {}) });
      if (signal.aborted) break;
      if (charged > 0) { idle = 0; continue; }
      if (++idle >= OPENCODE_MAX_IDLE_RUNS) {
        // No provider request at all is OpenCode's (or its setup's) failure; failed requests are the provider's.
        return proxy.requests() === requestsBefore
          ? { reason: 'harness_error', turns: proxy.turns() }
          : { reason: 'provider_error', turns: proxy.turns(), providerStatus: proxy.providerStatus() ?? null };
      }
      await sleep(options.retryPauseMs ?? OPENCODE_RETRY_PAUSE_MS, undefined, { signal }).catch(() => {});
    }
    return { reason: budget.signal.aborted ? 'budget' : 'cutoff', turns: proxy.turns() };
  } finally {
    await proxy.close();
  }
}
