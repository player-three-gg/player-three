/**
 * The OpenCode authoring harness (SPEC §20.11): `opencode run` headless in a fresh isolated home and an empty working
 * directory, reaching the game only through the `playerthree-mcp` stdio bridge with the lobby commander's credential.
 * Bash, web fetch, web search, files outside the working directory and the game's live-play tools are denied.
 *
 * OpenCode never sees the provider key: its only provider is a loopback metering proxy on the model's own wire
 * (`model.wire`: Anthropic Messages, OpenAI Responses, OpenRouter chat or plain Chat Completions, each through
 * OpenCode's adapter for it, so the model's signed or encrypted reasoning goes back to it with its tool results). The
 * proxy adds the key and the model's private request extras (router pinning), caps each reply's output, buffers each
 * reply whole, charges its actual cost (`turnCostUsd`) against the run's ceilings and withholds a reply that crosses one,
 * so its tool calls never run.
 * It records the upstream, generation id, cost and reasoning the router reports. With a series system prompt, the proxy
 * replaces every system message OpenCode sends with it, so OpenCode's own prompt never reaches the model. When a run ends
 * before the deadline, the harness continues the same OpenCode session with the seat's status (never the time left: a
 * model that paces itself to a stated budget wraps up early): authoring has no early exit.
 *
 * OpenCode compacts the conversation (summarizes it, then continues from the summary) against the series' common
 * window (`authoring.contextTokens`, capped at the model's own), so models differ in how often they are summarized only
 * by their own work. What else OpenCode puts in front of the model, and how the harness handles it:
 * - its synthetic "Continue if you have next steps, or stop and ask for clarification…" message after a compaction
 *   (`compaction_continue`): rewritten by the proxy to the harness's own neutral re-prompt ({@link continuationPrompt});
 * - the compaction request itself (no tools; one user message with OpenCode's summary template and the flattened history):
 *   forwarded with the series system prompt in place of OpenCode's summarizer prompt, its embedded continue texts rewritten;
 * - "What did we do so far?", the user turn OpenCode renders before each summary: kept (a question, no instruction);
 * - `opencode run`'s quoting of a message argument (wrapped in quotes, its quotes escaped): avoided, prompts go on stdin;
 * - its truncation notice on a long tool result: never triggered, OpenCode's limits sit above the game's result cap;
 * - its built-in tools' descriptions (file, search, todo and task tools): kept, fixed by the harness version.
 * The title agent never runs (every session is titled), and no other synthetic text reaches the model in this configuration.
 */
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RESULT_TEXT_MAX } from 'playerthree';
import { ANTHROPIC_EFFORT_BETA, ANTHROPIC_VERSION, anthropicAuthHeaders, priceFor } from '@playerthree/runner';
import { routerGenerationCost } from './billing.ts';
import { modelWire, type ModelWire } from './config.ts';
import type { AuthoringHarness, AuthoringLobby, HarnessOutcome, HarnessStop } from './harness.ts';

export const OPENCODE_HARNESS_ID = 'opencode';
/**
 * The window OpenCode compacts against when the series names none (`authoring.contextTokens`), tokens: about where
 * StarSkirmish compacts every harness. OpenCode summarizes once a turn's context reaches it less the output cap.
 */
export const OPENCODE_CONTEXT_TOKENS = 250_000;
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

/** OpenCode 1.19's synthetic user message after an automatic compaction (its part metadata `compaction_continue`), verbatim. */
export const OPENCODE_COMPACTION_CONTINUE = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
/** The note OpenCode puts before it when the compacted request had exceeded the provider's size limit. */
const OPENCODE_OVERFLOW_NOTE = "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n";
/** How every harness re-prompt ends; alone, it stands in for OpenCode's continue text inside a summarized history. */
const AUTHORING_CONTINUES = 'Authoring continues until the deadline; the policies active then are evaluated.';

export interface OpenCodeOptions {
  /** The `opencode` platform binary, e.g. `<prefix>/node_modules/opencode-linux-x64/bin/opencode`. */
  bin: string;
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
  /** `inputTokens` counts cached input too (`cachedInputTokens`); `reasoningTokens` only where the API reports them. */
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number; costUsd?: number };
  /** Reasoning the reply carried: thinking blocks, reasoning items, or a Chat Completions reasoning stream (one block); its visible text, characters. */
  thinking: { blocks: number; chars: number };
  error?: { status: number | null; message: string };
}

/** The `data:` payloads of an SSE body, or the one JSON body. */
function replyChunks(text: string, streamed: boolean, reply: Reply): Record<string, unknown>[] {
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
  return chunks.filter((chunk): chunk is Record<string, unknown> => chunk !== null && typeof chunk === 'object' && !Array.isArray(chunk));
}

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const errorText = (error: { type?: unknown; message?: unknown }) => String(error.message ?? error.type ?? 'provider error').slice(0, TRANSCRIPT_CLIP);

/** Parses a Chat Completions reply (streamed or not), keeping only accounting and identity fields. */
function parseChatReply(text: string, streamed: boolean): Reply {
  const reply: Reply = { toolCalls: [], thinking: { blocks: 0, chars: 0 } };
  for (const chunk of replyChunks(text, streamed, reply)) {
    const c = chunk as { id?: unknown; provider?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null; completion_tokens_details?: { reasoning_tokens?: unknown } | null } | null; error?: { code?: unknown; message?: unknown }; choices?: { finish_reason?: unknown; delta?: { reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: { function?: { name?: unknown } }[] }; message?: { tool_calls?: { function?: { name?: unknown } }[] } }[] };
    if (typeof c.id === 'string') reply.id = c.id;
    if (typeof c.provider === 'string' && c.provider) reply.provider = c.provider;
    if (c.error) reply.error = { status: typeof c.error.code === 'number' ? c.error.code : null, message: errorText(c.error) };
    const input = count(c.usage?.prompt_tokens), output = count(c.usage?.completion_tokens);
    if (c.usage && input !== undefined && output !== undefined) {
      const cached = count(c.usage.prompt_tokens_details?.cached_tokens), reasoning = count(c.usage.completion_tokens_details?.reasoning_tokens), cost = count(c.usage.cost);
      reply.usage = { inputTokens: input, outputTokens: output, ...(cached !== undefined ? { cachedInputTokens: cached } : {}), ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) };
    }
    for (const choice of c.choices ?? []) {
      if (typeof choice.finish_reason === 'string') reply.finishReason = choice.finish_reason;
      const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (typeof reasoning === 'string' && reasoning) reply.thinking.chars += reasoning.length;
      if ((typeof reasoning === 'string' && reasoning) || (Array.isArray(choice.delta?.reasoning_details) && choice.delta.reasoning_details.length > 0)) reply.thinking.blocks = 1;
      for (const call of [...choice.delta?.tool_calls ?? [], ...choice.message?.tool_calls ?? []]) if (typeof call.function?.name === 'string' && call.function.name) reply.toolCalls.push(call.function.name);
    }
  }
  return reply;
}

/** A Responses output item or Messages content block: the fields the proxy reads. */
interface ReplyItem { type?: unknown; name?: unknown; thinking?: unknown; summary?: { text?: unknown }[] }

/**
 * Parses an OpenAI Responses reply (streamed or not). Its finish reason is `tool_calls` when it called a tool, else
 * `stop`, else the incomplete reason (e.g. `max_output_tokens`), as in Chat Completions.
 */
function parseResponsesReply(text: string, streamed: boolean): Reply {
  const reply: Reply = { toolCalls: [], thinking: { blocks: 0, chars: 0 } };
  let final: { id?: unknown; status?: unknown; usage?: Record<string, unknown> & { input_tokens_details?: { cached_tokens?: unknown }; output_tokens_details?: { reasoning_tokens?: unknown } }; incomplete_details?: { reason?: unknown } | null; error?: { message?: unknown } | null; output?: ReplyItem[] } | undefined;
  const items: ReplyItem[] = [];
  for (const chunk of replyChunks(text, streamed, reply)) {
    const c = chunk as { type?: unknown; object?: unknown; item?: ReplyItem; response?: typeof final; error?: { type?: unknown; message?: unknown }; message?: unknown };
    if (c.type === 'response.output_item.done' && c.item) items.push(c.item);
    if (c.response && typeof c.response.id === 'string') reply.id = c.response.id;
    if (c.type === 'response.completed' || c.type === 'response.incomplete' || c.type === 'response.failed') final = c.response;
    if (c.object === 'response') final = c as typeof final;
    if (c.type === 'error') reply.error = { status: null, message: errorText(c.error ?? { message: c.message }) };
  }
  if (final?.error) reply.error = { status: null, message: errorText(final.error) };
  for (const item of items.length > 0 ? items : final?.output ?? []) {
    if (item.type === 'function_call' && typeof item.name === 'string' && item.name) reply.toolCalls.push(item.name);
    if (item.type === 'reasoning') { reply.thinking.blocks++; for (const part of item.summary ?? []) if (typeof part.text === 'string') reply.thinking.chars += part.text.length; }
  }
  reply.finishReason = reply.toolCalls.length > 0 ? 'tool_calls' : final?.status === 'completed' ? 'stop' : typeof final?.incomplete_details?.reason === 'string' ? final.incomplete_details.reason : typeof final?.status === 'string' ? final.status : undefined;
  const u = final?.usage;
  const input = count(u?.['input_tokens']), output = count(u?.['output_tokens']);
  if (u && input !== undefined && output !== undefined) {
    const cached = count(u.input_tokens_details?.cached_tokens), reasoning = count(u.output_tokens_details?.reasoning_tokens), cost = count(u['cost']);
    reply.usage = { inputTokens: input, outputTokens: output, ...(cached !== undefined ? { cachedInputTokens: cached } : {}), ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) };
  }
  return reply;
}

/**
 * Parses an Anthropic Messages reply (streamed or not). Input is reported as Chat Completions does: uncached, cache
 * writes and cache reads together, cache reads also as `cachedInputTokens`; thinking tokens where the usage names
 * them (`output_tokens_details.thinking_tokens`), a router's billed cost as `cost`.
 */
function parseMessagesReply(text: string, streamed: boolean): Reply {
  const reply: Reply = { toolCalls: [], thinking: { blocks: 0, chars: 0 } };
  let usage: Record<string, unknown> & { output_tokens_details?: { thinking_tokens?: unknown } } = {};
  const block = (b: ReplyItem | undefined) => {
    if (b?.type === 'tool_use' && typeof b.name === 'string' && b.name) reply.toolCalls.push(b.name);
    if (b?.type === 'thinking' || b?.type === 'redacted_thinking') { reply.thinking.blocks++; if (typeof b.thinking === 'string') reply.thinking.chars += b.thinking.length; }
  };
  for (const chunk of replyChunks(text, streamed, reply)) {
    const c = chunk as { type?: unknown; id?: unknown; message?: { id?: unknown; usage?: Record<string, unknown> }; usage?: Record<string, unknown>; content?: ReplyItem[]; content_block?: ReplyItem; delta?: { type?: unknown; thinking?: unknown; stop_reason?: unknown }; stop_reason?: unknown; error?: { type?: unknown; message?: unknown } };
    if (c.type === 'error' && c.error) reply.error = { status: null, message: errorText(c.error) };
    if (c.type === 'message_start' && c.message) { if (typeof c.message.id === 'string') reply.id = c.message.id; usage = { ...usage, ...c.message.usage }; }
    if (c.type === 'content_block_start') block(c.content_block);
    if (c.type === 'content_block_delta' && c.delta?.type === 'thinking_delta' && typeof c.delta.thinking === 'string') reply.thinking.chars += c.delta.thinking.length;
    if (c.type === 'message_delta') { usage = { ...usage, ...c.usage }; if (typeof c.delta?.stop_reason === 'string') reply.finishReason = c.delta.stop_reason; }
    if (c.type === 'message') {
      if (typeof c.id === 'string') reply.id = c.id;
      usage = { ...usage, ...c.usage };
      if (typeof c.stop_reason === 'string') reply.finishReason = c.stop_reason;
      for (const b of c.content ?? []) block(b);
    }
  }
  const input = count(usage['input_tokens']), output = count(usage['output_tokens']);
  if (input !== undefined && output !== undefined) {
    const read = count(usage['cache_read_input_tokens']) ?? 0, thinking = count(usage.output_tokens_details?.thinking_tokens), cost = count(usage['cost']);
    reply.usage = { inputTokens: input + (count(usage['cache_creation_input_tokens']) ?? 0) + read, outputTokens: output, cachedInputTokens: read, ...(thinking !== undefined ? { reasoningTokens: thinking } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) };
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

/** Message roles that carry a system prompt (Chat Completions, Responses input). */
const SYSTEM_ROLES: readonly unknown[] = ['system', 'developer'];
/** Text content part types: Chat Completions and Anthropic `text`, Responses `input_text`. */
const TEXT_PARTS: readonly unknown[] = ['text', 'input_text'];
/** The fields of a Chat Completions message (or content part) the proxy reads; any other field passes through untouched. */
interface ChatMessage { role?: unknown; content?: unknown; cache_control?: unknown }
const chatMessage = (value: unknown): ChatMessage | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ChatMessage : undefined;
/** The prompt-cache breakpoint (`cache_control`) OpenCode put on a message or on one of its content parts, if any. */
function cacheMark(message: ChatMessage): unknown {
  if (message.cache_control !== undefined) return message.cache_control;
  return Array.isArray(message.content) ? message.content.map(chatMessage).find((part) => part?.cache_control !== undefined)?.cache_control : undefined;
}
/**
 * `messages` with every system message dropped and `text` as the one system message, first; the rest unchanged and in
 * order. A breakpoint OpenCode put on a dropped system message moves onto the series prompt's text part, so the tools and
 * system prefix stay a cached prefix of their own.
 */
function withSystemPrompt(messages: readonly unknown[], text: string): unknown[] {
  const system = (message: unknown) => SYSTEM_ROLES.includes(chatMessage(message)?.role);
  const mark = messages.filter(system).map((message) => cacheMark(message as ChatMessage)).find((value) => value !== undefined);
  return [{ role: 'system', content: mark === undefined ? text : [{ type: 'text', text, cache_control: mark }] }, ...messages.filter((message) => !system(message))];
}
/**
 * An Anthropic Messages `system` that is `text` alone, as one text block; a breakpoint OpenCode put on one of its own
 * system blocks moves onto it, as {@link withSystemPrompt} does.
 */
function anthropicSystem(system: unknown, text: string): unknown[] {
  const mark = Array.isArray(system) ? system.map(chatMessage).find((block) => block?.cache_control !== undefined)?.cache_control : undefined;
  return [{ type: 'text', text, ...(mark === undefined ? {} : { cache_control: mark }) }];
}
/** A Responses `input` without its system and developer messages: the series prompt goes in `instructions`. */
function withoutSystemItems(input: readonly unknown[]): unknown[] {
  return input.filter((item) => !SYSTEM_ROLES.includes(chatMessage(item)?.role));
}
/**
 * `messages` with each message-level breakpoint of a user or system message with plain string content moved onto its one
 * text part (same text, same block for the provider). OpenCode marks the last two messages on the message itself; a router
 * that translates Chat Completions to Anthropic Messages (OpenRouter) reads a breakpoint on a content part and drops one on
 * a plain-text user message. The first request of every `opencode run`, whose only marked messages are the previous reply's
 * text and the new prompt, then neither read nor wrote the cache and was billed in full. Tool and assistant messages keep
 * their marks as OpenCode sent them.
 */
function partBreakpoints(messages: readonly unknown[]): unknown[] {
  return messages.map((value) => {
    const message = chatMessage(value);
    if (!message || (message.role !== 'user' && message.role !== 'system') || typeof message.content !== 'string' || message.cache_control === undefined) return value;
    const { cache_control: mark, content, ...rest } = message;
    return { ...rest, content: [{ type: 'text', text: content, cache_control: mark }] };
  });
}

/** The user turn OpenCode renders for each compaction in a conversation, followed by that compaction's summary. */
const OPENCODE_COMPACTION_TURN = 'What did we do so far?';
/**
 * `messages` with OpenCode's compaction-continue text rewritten in every user message. In a conversation request
 * (`conversation`), a user text that ends with it is OpenCode's synthetic message, whatever note leads it: the whole text
 * becomes `neutral(summary)`, `summary` naming its compaction. OpenCode first sends a continue last, after its
 * compaction's summary and the recent turns kept; a later compaction moves that pair and the continue into its own kept
 * turns. So a continue's summary is the latest one before it that no earlier continue took (else the message before it).
 * Anywhere else (a summarizer request's flattened history) the text and its note become the time-free `[harness]` line.
 */
function neutralizeContinue(messages: readonly unknown[], conversation: boolean, neutral: (summary: unknown) => string): unknown[] {
  const isMessage = (value: unknown): value is { role: unknown } => value !== null && typeof value === 'object' && 'role' in value;
  const summaries = messages.flatMap((message, index) => {
    const next = messages[index + 1];
    if (!isMessage(message) || message.role !== 'user' || !('content' in message) || !isMessage(next) || next.role !== 'assistant') return [];
    // Chat Completions sends the question as a string, Anthropic Messages and Responses as one text part.
    const block = Array.isArray(message.content) && message.content.length === 1 ? chatMessage(message.content[0]) : undefined;
    const asked = message.content === OPENCODE_COMPACTION_TURN || (block !== undefined && 'type' in block && TEXT_PARTS.includes(block.type) && 'text' in block && block.text === OPENCODE_COMPACTION_TURN);
    return asked ? [index + 1] : [];
  });
  const taken = new Set<number>();
  return messages.map((message, index) => {
    if (!isMessage(message) || message.role !== 'user' || !('content' in message)) return message;
    const rewrite = (text: string) => {
      if (!text.includes(OPENCODE_COMPACTION_CONTINUE)) return text;
      if (!conversation || !text.endsWith(OPENCODE_COMPACTION_CONTINUE)) return text.replaceAll(OPENCODE_OVERFLOW_NOTE + OPENCODE_COMPACTION_CONTINUE, `[harness] ${AUTHORING_CONTINUES}`).replaceAll(OPENCODE_COMPACTION_CONTINUE, `[harness] ${AUTHORING_CONTINUES}`);
      const summary = summaries.findLast((at) => at < index && !taken.has(at));
      if (summary !== undefined) taken.add(summary);
      return neutral(messages[summary ?? index - 1]);
    };
    const { content } = message;
    if (typeof content === 'string') return { ...message, content: rewrite(content) };
    if (!Array.isArray(content)) return message;
    return { ...message, content: content.map((part: unknown) => part !== null && typeof part === 'object' && 'type' in part && TEXT_PARTS.includes(part.type) && 'text' in part && typeof part.text === 'string' ? { ...part, text: rewrite(part.text) } : part) };
  });
}

interface MeteringProxy {
  url: string;
  /** Model turns charged, provider requests forwarded and those that failed. */
  turns(): number; requests(): number; errors(): number;
  /** HTTP status of the last provider failure (null: network), undefined when the last request succeeded. */
  providerStatus(): number | null | undefined;
  close(): Promise<void>;
}

/** Per wire: OpenCode's provider adapter, the API path the proxy serves and forwards to, and its reply parser. */
const WIRES: Readonly<Record<ModelWire, { npm: string; path: string; parse: (text: string, streamed: boolean) => Reply }>> = {
  messages: { npm: '@ai-sdk/anthropic', path: '/messages', parse: parseMessagesReply },
  responses: { npm: '@ai-sdk/openai', path: '/responses', parse: parseResponsesReply },
  'openrouter-chat': { npm: '@openrouter/ai-sdk-provider', path: '/chat/completions', parse: parseChatReply },
  'chat-completions': { npm: '@ai-sdk/openai-compatible', path: '/chat/completions', parse: parseChatReply },
};

/**
 * The loopback endpoint OpenCode talks to, on the model's own wire ({@link ModelWire}): whatever reasoning the model
 * returns (signed thinking blocks, encrypted reasoning items, `reasoning_details`) OpenCode's adapter replays with the
 * tool results, and the proxy passes it through untouched. `onBudget` fires when a ceiling stops authoring.
 */
async function meteringProxy(lobby: AuthoringLobby, onBudget: () => void, options: { generationCost?: (id: string) => Promise<number | null> }): Promise<MeteringProxy> {
  const { model } = lobby;
  if (model.provider !== 'openai' && model.provider !== 'anthropic') throw new Error(`the OpenCode harness needs an OpenAI-compatible or Anthropic model route, not ${model.provider}`);
  const wire = modelWire(model);
  const { path, parse } = WIRES[wire];
  // Responses keeps the conversation in `input` and caps a reply at `max_output_tokens`.
  const conversation = wire === 'responses' ? 'input' : 'messages';
  const capField = wire === 'responses' ? 'max_output_tokens' : 'max_tokens';
  const chat = wire === 'chat-completions' || wire === 'openrouter-chat';
  const upstream = `${model.baseUrl ?? (wire === 'messages' ? 'https://api.anthropic.com' : 'https://api.openai.com')}/v1${path}`;
  const cap = lobby.maxOutputTokens;
  let turns = 0;
  let requests = 0;
  let errors = 0;
  let over = false;
  let providerStatus: number | null | undefined;
  const failed = (status: number | null, detail: string) => {
    errors++;
    providerStatus = status;
    lobby.transcript({ kind: 'provider_error', status, detail });
  };
  const refuse = (res: ServerResponse) => sendJson(res, 402, 'benchmark authoring budget exhausted');
  // One neutral re-prompt per compaction, fixed when the proxy first forwards it: every later request repeats it verbatim.
  const continuations = new Map<string, string>();
  const neutralContinue = (summary: unknown) => {
    const key = createHash('sha256').update(JSON.stringify(summary ?? null)).digest('hex');
    let text = continuations.get(key);
    if (text === undefined) {
      text = continuationPrompt(lobby.status());
      continuations.set(key, text);
      lobby.transcript({ kind: 'harness_text', source: 'opencode_compaction_continue', text });
    }
    return text;
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST' || !new URL(req.url ?? '/', 'http://proxy').pathname.endsWith(path)) { res.writeHead(404).end(); return; }
    const raw = await readBody(req);
    if (raw === null) { sendJson(res, 413, 'request too large'); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw.toString('utf8')); } catch { sendJson(res, 400, 'request is not JSON'); return; }
    if (lobby.systemPrompt !== undefined) {
      if (!Array.isArray(body[conversation])) { sendJson(res, 400, `request has no ${conversation}`); return; }
      body = wire === 'messages' ? { ...body, system: anthropicSystem(body['system'], lobby.systemPrompt) }
        : wire === 'responses' ? { ...body, instructions: lobby.systemPrompt, input: withoutSystemItems(body['input'] as unknown[]) }
        : { ...body, messages: withSystemPrompt(body['messages'] as unknown[], lobby.systemPrompt) };
    }
    if (over || lobby.signal.aborted) { refuse(res); return; }
    // Tool-less requests are OpenCode's compaction summarizer (the only one this configuration runs): history, not conversation.
    const compaction = !Array.isArray(body['tools']) || body['tools'].length === 0;
    const history = body[conversation];
    if (Array.isArray(history)) {
      const messages = neutralizeContinue(history, !compaction, neutralContinue);
      body = { ...body, [conversation]: chat ? partBreakpoints(messages) : messages };
    }
    const estimate = Math.ceil(raw.byteLength / CHARS_PER_TOKEN);
    if (!lobby.canAfford(estimate, cap)) { over = true; lobby.transcript({ kind: 'budget', detail: 'next turn could cross a ceiling' }); onBudget(); refuse(res); return; }
    const requested = typeof body[capField] === 'number' ? body[capField] : cap;
    const { max_completion_tokens: _completion, max_tokens: _tokens, max_output_tokens: _output, ...rest } = body;
    // The model id, router extras and reasoning effort are the bench's, never OpenCode's, each in its wire's own field:
    // Chat Completions `reasoning_effort` (OpenAI, omp's auth-gateway), OpenRouter and Responses `reasoning.effort`,
    // Anthropic adaptive thinking at `output_config.effort`. OpenRouter `usage.include` reports each turn's cost.
    const effort = lobby.reasoning === undefined ? {}
      : wire === 'messages' ? { thinking: { ...chatMessage(rest['thinking']), type: 'adaptive' }, output_config: { ...chatMessage(rest['output_config']), effort: lobby.reasoning } }
      : wire === 'chat-completions' ? { reasoning_effort: lobby.reasoning }
      : { reasoning: { ...chatMessage(rest['reasoning']), effort: lobby.reasoning } };
    // Responses replays reasoning only as encrypted items, which a stateless request (`store: false`) must ask for.
    const replay = wire === 'responses' ? { store: false, include: [...new Set([...Array.isArray(rest['include']) ? rest['include'] : [], 'reasoning.encrypted_content'])] } : {};
    const sent: Record<string, unknown> = { ...rest, ...model.request, model: model.model, [capField]: Math.min(requested, cap), ...(chat ? { usage: { include: true } } : {}), ...replay, ...effort };
    const streamed = sent['stream'] === true;
    requests++;
    let upstreamRes: Response;
    let bytes: Buffer;
    try {
      // Anthropic betas are the harness's (OpenCode names the ones its request uses), plus effort when the bench sets it.
      const betas = [...new Set([...String(req.headers['anthropic-beta'] ?? '').split(',').map((beta) => beta.trim()).filter(Boolean), ...(lobby.reasoning !== undefined ? [ANTHROPIC_EFFORT_BETA] : [])])];
      const headers: Record<string, string> = wire === 'messages'
        ? { ...anthropicAuthHeaders(lobby.apiKey, model.baseUrl), 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json', ...(betas.length > 0 ? { 'anthropic-beta': betas.join(',') } : {}) }
        : { authorization: `Bearer ${lobby.apiKey}`, 'content-type': 'application/json' };
      upstreamRes = await fetch(upstream, { method: 'POST', headers, body: JSON.stringify(sent), signal: lobby.signal });
      bytes = Buffer.from(await upstreamRes.arrayBuffer());
    } catch {
      if (lobby.signal.aborted) { refuse(res); return; }
      failed(null, 'unreachable');
      sendJson(res, 502, 'provider unreachable');
      return;
    }
    if (!upstreamRes.ok) {
      failed(upstreamRes.status, bytes.toString('utf8').slice(0, TRANSCRIPT_CLIP));
      res.writeHead(upstreamRes.status, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' }).end(bytes);
      return;
    }
    const reply = parse(bytes.toString('utf8'), streamed);
    if (reply.error && !reply.usage) {
      failed(reply.error.status, reply.error.message);
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
    lobby.transcript({ kind: 'turn', turn: turns, generationId: reply.id ?? null, servedBy: reply.provider ?? null, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens ?? null, reasoningTokens: usage.reasoningTokens ?? null, reportedUsd: costUsd ?? null, costFrom: usage.costUsd !== undefined ? 'reply' : costUsd !== undefined ? 'generation' : 'estimate', usageReported: reply.usage !== undefined, finishReason: reply.finishReason ?? null, toolCalls: reply.toolCalls, thinkingBlocks: reply.thinking.blocks, thinkingChars: reply.thinking.chars, compaction, withheld: !within });
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
    turns: () => turns, requests: () => requests, errors: () => errors, providerStatus: () => providerStatus,
    async close() { server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; },
  };
}

/** One `opencode run` with `prompt` on stdin; its whole process group (OpenCode and the bridge it spawned) is killed when `signal` aborts and reaped after exit. */
function runOnce(bin: string, args: readonly string[], prompt: string, env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal, onEvent: (event: Record<string, unknown>) => void): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  // A process that exits before reading its prompt reports through `close`; the broken pipe says nothing more.
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
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
  return `${lobby.brief}\n\nIn this harness the game's tools come from the MCP server "${MCP_SERVER}" and are named \`${MCP_SERVER}_<tool>\` (for example \`${MCP_SERVER}_policy_deploy\`).${lobby.roles.length > 1 ? ` You command ${lobby.roles.length} roles: ${lobby.roles.join(', ')}. Each is its own seat with its own policy; every game tool call (game_skill excepted) takes \`role\`.` : ''} You are a persistent commander in the lobby: no match is running yet. ${lobby.status()} Authoring runs until its deadline (about ${minutesLeft(lobby.deadlineAt)} minutes); the policies active then are the ones evaluated. Begin.`;
}

/**
 * The no-early-exit re-prompt, sent whenever the model ends its turn before the deadline (and in place of OpenCode's
 * own after a compaction): the seat's status, nothing else. It names no time left (the first prompt states the deadline
 * once): a model that paces itself to a stated budget wraps up early. It carries no advice: models that end their turn
 * often would otherwise be coached more often.
 */
export function continuationPrompt(status: string): string {
  return ['[harness]', status, AUTHORING_CONTINUES].filter(Boolean).join(' ');
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
    const wire = modelWire(lobby.model);
    const { npm } = WIRES[wire];
    // The series' common window, capped at the model's own: OpenCode compacts once a turn's context reaches it less the output cap.
    const limit = { context: Math.min(lobby.contextTokens ?? OPENCODE_CONTEXT_TOKENS, lobby.model.contextTokens ?? Number.POSITIVE_INFINITY), output: lobby.maxOutputTokens };
    if (limit.context <= limit.output) throw new Error(`the OpenCode context window (${limit.context} tokens) must exceed the output cap (${limit.output})`);
    const config = {
      $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', snapshot: false,
      // Each wire's own OpenCode adapter, which replays the model's reasoning with its tool results (`reasoning`: the
      // adapter keeps it); plain Chat Completions has no such field.
      provider: { [PROVIDER_ID]: { npm, name: 'PlayerThree bench metering proxy', options: { baseURL: `${proxy.url}/v1`, apiKey: 'metered-by-proxy' },
        models: { [lobby.model.model]: { name: lobby.model.model, tool_call: true, ...(wire === 'chat-completions' ? {} : { reasoning: true }), limit, ...(price ? { cost: { input: price.inPerM, output: price.outPerM } } : {}) } } } },
      model: modelRef, small_model: modelRef,
      mcp: { [MCP_SERVER]: { type: 'local', command: [...options.bridge ?? defaultBridge(), '--url', lobby.url, '--expect-hash', lobby.surfaceHash], environment: { PLAYERTHREE_TOKEN: lobby.token }, enabled: true, timeout: MCP_TIMEOUT_MS } },
      permission: { bash: 'deny', webfetch: 'deny', websearch: 'deny', external_directory: 'deny' },
      tools: Object.fromEntries(['bash', 'webfetch', 'websearch', ...lobby.blockedTools.map((tool) => `${MCP_SERVER}_${tool}`)].map((tool) => [tool, false])),
      // Above any game tool result (at most RESULT_TEXT_MAX characters), so OpenCode never cuts one or appends its notice.
      tool_output: { max_lines: 2 * RESULT_TEXT_MAX, max_bytes: 4 * RESULT_TEXT_MAX },
    };
    // Nothing of the operator's environment reaches OpenCode: no keys, no user config, plugins, skills or project files.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local', 'state'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_PURE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    };
    lobby.transcript({ kind: 'harness', bin: options.bin, config: { ...config, mcp: { [MCP_SERVER]: { type: 'local', bridge: true, url: lobby.url } }, provider: { [PROVIDER_ID]: { proxy: true, npm, wire, model: lobby.model.model, limit, reasoning: lobby.reasoning ?? null } } } });
    let session: string | undefined;
    let idle = 0;
    const outcome = (reason: HarnessStop): HarnessOutcome => ({ reason, turns: proxy.turns(), providerErrors: proxy.errors(), ...(reason === 'provider_error' ? { providerStatus: proxy.providerStatus() ?? null } : {}) });
    // No provider request at all is OpenCode's (or its setup's) failure; failed requests are the provider's.
    const failure = (requestsBefore: number) => outcome(proxy.requests() === requestsBefore ? 'harness_error' : 'provider_error');
    for (let run = 0; !signal.aborted; run++) {
      const prompt = session === undefined ? firstPrompt(lobby) : continuationPrompt(lobby.status());
      const turnsBefore = proxy.turns();
      const requestsBefore = proxy.requests();
      lobby.transcript({ kind: 'prompt', run, session: session ?? null, text: prompt });
      // `--auto` approves what is not explicitly denied (no one answers a prompt headless); the config denies the rest.
      // The prompt goes on stdin: `opencode run` would wrap a message argument in quotes and escape its quotes.
      const args = ['run', '--pure', '--auto', '--format', 'json', ...(session === undefined ? ['--title', 'benchmark authoring'] : ['--session', session])];
      const exit = await runOnce(options.bin, args, prompt, env, work, signal, (event) => {
        if (session === undefined && typeof event['sessionID'] === 'string') session = event['sessionID'];
        lobby.transcript({ kind: 'opencode', run, event });
      });
      const charged = proxy.turns() - turnsBefore;
      lobby.transcript({ kind: 'run_end', run, exit: exit.code, signal: exit.signal, turns: charged, ...(exit.code !== 0 && !signal.aborted ? { stderr: exit.stderr } : {}) });
      if (signal.aborted) break;
      if (charged > 0) { idle = 0; continue; }
      if (++idle >= OPENCODE_MAX_IDLE_RUNS) return failure(requestsBefore);
      await sleep(options.retryPauseMs ?? OPENCODE_RETRY_PAUSE_MS, undefined, { signal }).catch(() => {});
    }
    if (budget.signal.aborted) return outcome('budget');
    // OpenCode retries a failing request for minutes, so a short clock can run out before the idle runs above do:
    // a deadline without one completed turn is still the provider's (or OpenCode's) failure, never the model's.
    if (proxy.turns() === 0) return failure(0);
    return outcome('cutoff');
  } finally {
    await proxy.close();
  }
}
