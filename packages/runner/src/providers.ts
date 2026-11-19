/**
 * LLM providers for the runner: OpenAI (Responses API, function tools) and Anthropic (Messages API, tools).
 * Plain fetch — no SDK dependencies. Each provider owns its conversation history.
 */
import type { ReasoningEffort } from 'playerthree/arena';
import type { JsonSchema } from 'playerthree/schema';

/** The Anthropic beta that enables `output_config.effort`, and the Messages API version the runner asks for. */
export const ANTHROPIC_EFFORT_BETA = 'effort-2025-11-24';
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Anthropic Messages auth for `apiKey`: `x-api-key` on Anthropic's own API, a bearer token when a `baseUrl` names a
 * router or gateway (OpenRouter's `/api/v1/messages`, an auth gateway), which read only `Authorization`.
 */
export function anthropicAuthHeaders(apiKey: string, baseUrl: string | undefined): Record<string, string> {
  return baseUrl === undefined ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` };
}

export interface LlmTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; `undefined` when the model produced invalid JSON. */
  args: Record<string, unknown> | undefined;
}

export interface Turn {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /**
   * The reply stopped at the output-token cap (OpenAI `status: "incomplete"` for `max_output_tokens`, Anthropic
   * `stop_reason: "max_tokens"`). A tool call cut off mid-arguments is dropped from `toolCalls` and the history: never run.
   */
  truncated?: boolean;
  /** The upstream that served the turn when the API names it (OpenRouter's `X-Provider-Name` header); diagnostics only. */
  servedBy?: string;
  /**
   * The router's id for this generation (OpenRouter's `X-Generation-Id` header, sent where `X-Provider-Name` is not,
   * e.g. on its Responses API), so the serving upstream can be looked up after the run; diagnostics only.
   */
  generationId?: string;
}

export interface ToolResultInput {
  id: string;
  output: string;
  isError: boolean;
}

/** One model conversation: the provider owns its history; the agent loop adds user text and tool results and asks for turns. */
export interface Provider {
  readonly name: 'openai' | 'anthropic' | 'scripted';
  readonly model: string;
  addUser(text: string): void;
  addToolResults(results: ToolResultInput[]): void;
  turn(signal?: AbortSignal): Promise<Turn>;
  /** Conservative estimate of the next turn's input tokens. */
  estimateInputTokens(): number;
  /** Replace tool outputs older than the last `keep` with a short marker to bound context growth. */
  compact(keep: number): void;
}

/**
 * Default per-turn output cap. Writing a policy is the main job: a reasoning model's thinking plus a few hundred lines
 * of code must fit in one reply, and a cut-off reply runs nothing.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * `playerthree-run`'s reasoning effort when `--reasoning-effort` is not given: Anthropic's default for its current
 * models, sent explicitly so no API or gateway picks its own (an auth gateway was seen to fall back to `low`).
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

/** Options shared by the OpenAI and Anthropic providers. */
export interface ProviderOptions {
  model: string;
  apiKey: string;
  system: string;
  tools: LlmTool[];
  maxOutputTokens: number;
  /** Override the API base URL (tests, proxies). */
  baseUrl?: string;
  /**
   * Extra top-level request fields, e.g. OpenRouter provider routing (`{ provider: { only: [...], allow_fallbacks: false,
   * require_parameters: true } }`). The runner's own fields (model, conversation, tools, output cap) always win.
   */
  request?: Readonly<Record<string, unknown>>;
  /**
   * One reasoning effort for every request: OpenAI Responses `reasoning.effort` (any model), Anthropic adaptive thinking
   * at `output_config.effort`. Absent: OpenAI reasoning models (gpt-5*, o*) at `low`, other models at the provider's default.
   */
  reasoningEffort?: ReasoningEffort;
}

/** Deterministic offline provider; each instance owns a fresh script cursor and records its inputs. */
export function createScriptedProvider(turns: readonly Turn[], model = 'scripted'): Provider & { users: string[]; results: ToolResultInput[] } {
  let cursor = 0;
  const users: string[] = [];
  const results: ToolResultInput[] = [];
  return {
    name: 'scripted',
    model,
    users,
    results,
    addUser(text) { users.push(text); },
    addToolResults(items) { results.push(...items); },
    async turn(signal) {
      signal?.throwIfAborted();
      return structuredClone(turns[cursor++] ?? { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } });
    },
    estimateInputTokens() { return turns[cursor]?.usage.inputTokens ?? 0; },
    compact() {},
  };
}

const ELIDED = '[older tool output elided by the runner to save tokens]';
const CHARS_PER_TOKEN = 3;

/** A provider API call failed with HTTP `status`; the message carries at most 500 characters of the response. */
export class ProviderError extends Error {
  readonly status: number;
  constructor(provider: string, status: number, detail: string) {
    super(`${provider} API error ${status}: ${detail.slice(0, 500)}`);
    this.name = 'ProviderError';
    this.status = status;
  }
}

// Minimal views of the provider wire formats (only the fields the runner reads or rewrites).
interface OpenAiItem {
  type?: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  content?: unknown;
  status?: string;
}
interface OpenAiResponse {
  output?: OpenAiItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
  status?: string;
  incomplete_details?: { reason?: string } | null;
}
interface AnthropicBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}
interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

/** OpenRouter's generation id shape (`GET /api/v1/generation?id=` accepts at most 128 characters). */
const GENERATION_ID_RE = /^gen-[0-9A-Za-z-]{1,124}$/;
/** Bound on a router-reported upstream name: an identifier, never request data. */
const SERVED_BY_MAX = 64;

/** The provider's own API response; trusted to the extent of its documented shape (fields are read defensively). */
async function postJson<T>(url: string, headers: Record<string, string>, body: unknown, provider: string, signal?: AbortSignal): Promise<{ body: T; route: Pick<Turn, 'servedBy' | 'generationId'> }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) throw new ProviderError(provider, res.status, text);
  // Routers name the upstream that actually served the request, or the generation to look it up by.
  const servedBy = res.headers.get('x-provider-name')?.slice(0, SERVED_BY_MAX) || undefined;
  const generationId = res.headers.get('x-generation-id') ?? '';
  return { body: JSON.parse(text) as T, route: { ...(servedBy ? { servedBy } : {}), ...(GENERATION_ID_RE.test(generationId) ? { generationId } : {}) } };
}

function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return undefined;
  try {
    const v = JSON.parse(raw === '' ? '{}' : raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** OpenAI function parameters: `oneOf` → `anyOf` (our variants are mutually exclusive by their `kind` const anyway). */
function openAiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(openAiSchema);
  if (s === null || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) out[k === 'oneOf' ? 'anyOf' : k] = openAiSchema(v);
  return out;
}

/** OpenAI Responses API provider (function tools). */
export function createOpenAiProvider(opts: ProviderOptions): Provider {
  const input: OpenAiItem[] = [];
  const tools = opts.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: openAiSchema(t.parameters), strict: false }));
  const effort = opts.reasoningEffort ?? (/^(gpt-5|o\d)/.test(opts.model) ? 'low' : undefined);
  const fixedChars = opts.system.length + JSON.stringify(tools).length;
  return {
    name: 'openai',
    model: opts.model,
    addUser(text) {
      input.push({ role: 'user', content: text });
    },
    addToolResults(results) {
      for (const r of results) input.push({ type: 'function_call_output', call_id: r.id, output: r.output });
    },
    async turn(signal) {
      const body: Record<string, unknown> = {
        ...opts.request,
        model: opts.model,
        instructions: opts.system,
        input,
        tools,
        max_output_tokens: opts.maxOutputTokens,
        store: false,
      };
      if (effort) {
        body['reasoning'] = { effort };
        body['include'] = ['reasoning.encrypted_content'];
      }
      const { body: res, route } = await postJson<OpenAiResponse>(`${opts.baseUrl ?? 'https://api.openai.com'}/v1/responses`, { authorization: `Bearer ${opts.apiKey}` }, body, 'OpenAI', signal);
      const truncated = res.status === 'incomplete' && res.incomplete_details?.reason === 'max_output_tokens';
      const toolCalls: ToolCall[] = [];
      const texts: string[] = [];
      for (const item of res.output ?? []) {
        // A call the output cap cut off carries partial arguments: it neither runs nor stays in the history (an
        // unanswered call would also make the next request invalid).
        if (item.type === 'function_call' && ((item.status !== undefined && item.status !== 'completed') || (truncated && parseArgs(item.arguments) === undefined))) continue;
        // Every other output item (reasoning, messages, calls) goes back as input so the model keeps its own context.
        input.push(item);
        if (item.type === 'function_call' && item.call_id && item.name) toolCalls.push({ id: item.call_id, name: item.name, args: parseArgs(item.arguments) });
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content as { type?: string; text?: string }[]) if (c.type === 'output_text' && typeof c.text === 'string') texts.push(c.text);
        }
      }
      return {
        text: texts.join('\n'),
        toolCalls,
        usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
        ...(truncated ? { truncated } : {}),
        ...route,
      };
    },
    estimateInputTokens() {
      return Math.ceil((fixedChars + JSON.stringify(input).length) / CHARS_PER_TOKEN);
    },
    compact(keep) {
      const outputs = input.filter((i) => i.type === 'function_call_output');
      for (const o of outputs.slice(0, Math.max(0, outputs.length - keep))) o.output = ELIDED;
    },
  };
}

/** Anthropic Messages API provider (tools). */
export function createAnthropicProvider(opts: ProviderOptions): Provider {
  const messages: AnthropicMessage[] = [];
  const tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const fixedChars = opts.system.length + JSON.stringify(tools).length;
  return {
    name: 'anthropic',
    model: opts.model,
    addUser(text) {
      messages.push({ role: 'user', content: [{ type: 'text', text }] });
    },
    addToolResults(results) {
      messages.push({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.output, ...(r.isError ? { is_error: true } : {}) })),
      });
    },
    async turn(signal) {
      const { body: res, route } = await postJson<AnthropicResponse>(
        `${opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
        { ...anthropicAuthHeaders(opts.apiKey, opts.baseUrl), 'anthropic-version': ANTHROPIC_VERSION, ...(opts.reasoningEffort ? { 'anthropic-beta': ANTHROPIC_EFFORT_BETA } : {}) },
        { ...opts.request, model: opts.model, max_tokens: opts.maxOutputTokens, system: opts.system, tools, messages, ...(opts.reasoningEffort ? { thinking: { type: 'adaptive' }, output_config: { effort: opts.reasoningEffort } } : {}) },
        'Anthropic',
        signal,
      );
      const truncated = res.stop_reason === 'max_tokens';
      const content = [...(res.content ?? [])];
      // The block being written when the cap hit is the last one: a tool_use there has partial input, so it is dropped.
      if (truncated && content.at(-1)?.type === 'tool_use') content.pop();
      if (content.length > 0) messages.push({ role: 'assistant', content });
      const toolCalls: ToolCall[] = [];
      const texts: string[] = [];
      for (const block of content) {
        if (block.type === 'tool_use' && block.id && block.name) toolCalls.push({ id: block.id, name: block.name, args: parseArgs(block.input) });
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
      const u = res.usage ?? {};
      return {
        text: texts.join('\n'),
        toolCalls,
        usage: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
        },
        ...(truncated ? { truncated } : {}),
        ...route,
      };
    },
    estimateInputTokens() {
      return Math.ceil((fixedChars + JSON.stringify(messages).length) / CHARS_PER_TOKEN);
    },
    compact(keep) {
      const results = messages.flatMap((m) => (m.role === 'user' ? m.content.filter((c) => c.type === 'tool_result') : []));
      for (const r of results.slice(0, Math.max(0, results.length - keep))) r.content = ELIDED;
    },
  };
}

/**
 * USD per million tokens. The runner's own loop sees no cached-token counts, so it ignores cached-input discounts and
 * over- rather than under-counts spend. `cacheReadPerM` prices cached input where a caller does see the cached count
 * (the bench's OpenCode proxy); absent, cached input is priced at `inPerM`.
 */
export interface Price {
  inPerM: number;
  outPerM: number;
  cacheReadPerM?: number;
}

/** List prices (standard tier). Override with --price-in/--price-out for anything else. */
export const PRICES: Readonly<Record<string, Price>> = {
  'gpt-5.5': { inPerM: 5, outPerM: 30 },
  'gpt-5.4': { inPerM: 2.5, outPerM: 15 },
  'gpt-5.4-mini': { inPerM: 0.75, outPerM: 4.5 },
  'gpt-5.4-nano': { inPerM: 0.2, outPerM: 1.25 },
  'gpt-5.2': { inPerM: 1.75, outPerM: 14 },
  'gpt-5.1': { inPerM: 1.25, outPerM: 10 },
  'gpt-5': { inPerM: 1.25, outPerM: 10 },
  'gpt-5-mini': { inPerM: 0.25, outPerM: 2 },
  'gpt-5-nano': { inPerM: 0.05, outPerM: 0.4 },
  'gpt-4.1': { inPerM: 2, outPerM: 8 },
  'gpt-4.1-mini': { inPerM: 0.4, outPerM: 1.6 },
  'gpt-4o-mini': { inPerM: 0.15, outPerM: 0.6 },
  'claude-opus-5-5': { inPerM: 4, outPerM: 20 },
  'claude-sonnet-5-5': { inPerM: 2, outPerM: 10 },
  // Haiku 5.5 is $0.10/$0.50 up to 100k-token prompts; the long-prompt rate is used so the budget stays hard.
  'claude-haiku-5-5': { inPerM: 0.5, outPerM: 2.5 },
  'claude-opus-4-5': { inPerM: 5, outPerM: 25 },
  'claude-sonnet-4-5': { inPerM: 3, outPerM: 15 },
  'claude-haiku-4-5': { inPerM: 1, outPerM: 5 },
};

/** Price for a model id, accepting dated snapshots (`gpt-5-mini-2025-08-07`). */
export function priceFor(model: string): Price | undefined {
  if (PRICES[model]) return PRICES[model];
  const undated = model.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, '');
  return PRICES[undated];
}

/** Hard spend limit with token accounting. */
export class Budget {
  readonly maxUsd: number;
  readonly price: Price;
  readonly maxTokens: number;
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;
  constructor(maxUsd: number, price: Price, maxTokens = Infinity) {
    this.maxUsd = maxUsd;
    this.price = price;
    this.maxTokens = maxTokens;
  }
  cost(usage: Usage): number {
    return (usage.inputTokens * this.price.inPerM + usage.outputTokens * this.price.outPerM) / 1e6;
  }
  get spentUsd(): number {
    return this.cost({ inputTokens: this.inputTokens, outputTokens: this.outputTokens });
  }
  /** Whether a call with this many input tokens and up to `maxOutput` output tokens stays within the limit. */
  canAfford(estimatedInput: number, maxOutput: number): boolean {
    return this.inputTokens + this.outputTokens + estimatedInput + maxOutput <= this.maxTokens
      && this.spentUsd + this.cost({ inputTokens: estimatedInput, outputTokens: maxOutput }) <= this.maxUsd;
  }
  add(usage: Usage): number {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.calls += 1;
    return this.cost(usage);
  }
}
