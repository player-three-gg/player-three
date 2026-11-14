/**
 * Tool-argument fidelity preflight: one tiny tool call through a model's configured route before any benchmark
 * session uses it. Routed upstreams can silently drop tool-call arguments: one OpenRouter upstream returned every
 * `policy_deploy` call as `{"runtime":"js","role":"surface"}`, keeping the enum arguments and dropping `code` and
 * `include`, which scores as a model failure. Failing fast keeps that out of results.
 */
import { isDeepStrictEqual } from 'node:util';
import { createAnthropicProvider, createOpenAiProvider, ProviderError, type LlmTool, type Turn } from '@playerthree/runner';
import type { BenchModel } from './config.ts';

/** Shaped like a deploy: one required enum, then optional string, array and multi-line code arguments. */
const TOOL: LlmTool = {
  name: 'echo_args',
  description: 'Echo the given arguments back unchanged.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['echo'] },
      text: { type: 'string', maxLength: 64 },
      items: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 64 } },
      code: { type: 'string', maxLength: 4096 },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};
const EXPECTED = { mode: 'echo', text: 'alpha beta', items: ['skill/one.js', 'skill/two.js'], code: 'function think(obs) {\n  return [];\n}' };
const PROMPT = `Call echo_args exactly once with mode "echo", text ${JSON.stringify(EXPECTED.text)}, items ${JSON.stringify(EXPECTED.items)} and code exactly:\n${EXPECTED.code}`;
/** Room for a reasoning model's thinking before its call; the probe itself is a few dozen tokens. */
const MAX_OUTPUT_TOKENS = 2048;
const ATTEMPTS = 2;

export interface PreflightResult {
  ok: boolean;
  /** The route could not be probed (network failure, 408, 429 or 5xx): an outage, not an unfaithful route. */
  unavailable?: boolean;
  /** The upstream that served the last attempt, when the API names it. */
  servedBy?: string;
  /** What went wrong on the last attempt, e.g. `dropped or changed text, items, code`; empty when ok. */
  detail: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Probes `model`'s route with `apiKey`; up to two attempts, since one model reply may simply skip the call. Any other
 * provider rejection (a bad routing request, an unknown model) propagates as the caller's configuration error.
 */
export async function preflightToolArguments(model: BenchModel, apiKey: string, signal?: AbortSignal): Promise<PreflightResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  let last: PreflightResult = { ok: false, detail: 'no attempt', ...usage };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const options = { model: model.model, apiKey, system: 'You call tools exactly as asked.', tools: [TOOL], maxOutputTokens: MAX_OUTPUT_TOKENS, baseUrl: model.baseUrl, request: model.request };
    const provider = model.provider === 'anthropic' ? createAnthropicProvider(options) : createOpenAiProvider(options);
    provider.addUser(PROMPT);
    let turn: Turn;
    try { turn = await provider.turn(signal); }
    catch (error) {
      if (signal?.aborted || (error instanceof ProviderError && error.status !== 408 && error.status !== 429 && error.status < 500)) throw error;
      return { ok: false, unavailable: true, detail: error instanceof ProviderError ? `HTTP ${error.status}` : 'unreachable', ...usage };
    }
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    const args = turn.toolCalls.find((call) => call.name === TOOL.name)?.args;
    // Code compares whitespace-insensitively (models may reflow it); every other argument must round-trip exactly.
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
    const missing = args === undefined ? ['the call'] : Object.keys(EXPECTED).filter((key) => key === 'code'
      ? typeof args[key] !== 'string' || flat(args[key]) !== flat(EXPECTED.code)
      : !isDeepStrictEqual(args[key], EXPECTED[key as keyof typeof EXPECTED]));
    last = { ok: missing.length === 0, ...(turn.servedBy ? { servedBy: turn.servedBy } : {}), detail: missing.length === 0 ? '' : `dropped or changed ${missing.join(', ')}`, ...usage };
    if (last.ok) return last;
  }
  return last;
}
