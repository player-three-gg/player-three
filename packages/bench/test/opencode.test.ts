import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { watchKeyUsage } from '../src/billing.ts';
import { turnCostUsd, type AuthoringLobby, type MeteredTurn } from '../src/harness.ts';
import { continuationPrompt, openCodeHarness, OPENCODE_COMPACTION_CONTINUE, OPENCODE_CONTEXT_TOKENS } from '../src/opencode.ts';

const API_KEY = 'sk-fake-router-key-0123456789';
const TOKEN = 'commander-token-'.padEnd(48, 'x');
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(done => { server.closeAllConnections(); server.close(done); })));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function directory() { const path = await mkdtemp(join(tmpdir(), 'playerthree-opencode-')); directories.push(path); return path; }
/** Coaching a harness must never add: what to practise against, how to improve, when to deploy. */
const ADVICE = /strongest|weakest|improv|tune|fork|redeploy|knob|should|keep|\btry\b|consider|instead|better|first|before you|at least as well|read the report|logs/i;

/** What the fake sends besides the prompt: OpenCode's own system prompt (a leading system and a later developer message), history and tools. */
const OPENCODE_SYSTEM = ['You are opencode, an interactive CLI agent. OPENCODE-PROVIDER-PROMPT', 'Here is some useful information about the environment you are running in. OPENCODE-ENV'];
const OPENCODE_HISTORY = [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'game_policy_status', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'version 1' }];
const OPENCODE_TOOLS = [{ type: 'function', function: { name: 'game_policy_deploy', description: 'Deploys a policy.', parameters: { type: 'object', properties: { from: { type: 'string' } } } } }];
const sentMessages = (prompt: string) => [{ role: 'system', content: OPENCODE_SYSTEM[0] }, { role: 'user', content: prompt }, ...OPENCODE_HISTORY, { role: 'developer', content: OPENCODE_SYSTEM[1] }];
/** One OpenCode turn as the fake sends it, `@@PROMPT@@` standing for the prompt it read on stdin. */
const DEFAULT_BODIES = [{ tools: OPENCODE_TOOLS, messages: sentMessages('@@PROMPT@@') }];

/** A stand-in `opencode`: `--version`, and `run` posting `bodies` in order to its configured provider, logging what it got. */
async function fakeOpenCode(dir: string, bodies: readonly Record<string, unknown>[] = DEFAULT_BODIES): Promise<{ bin: string; calls: () => Promise<{ args: string[]; prompt: string; env: Record<string, string>; cwd: string; config: Record<string, any> }[]> }> {
  const log = join(dir, 'calls.jsonl');
  const bin = join(dir, 'opencode');
  await writeFile(bin, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9'); process.exit(0); }
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const prompt = readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt, env: process.env, cwd: process.cwd(), config }) + '\\n');
const path = { '@ai-sdk/anthropic': '/messages', '@ai-sdk/openai': '/responses' }[config.provider.bench.npm] ?? '/chat/completions';
for (const body of ${JSON.stringify(bodies)}) {
  const res = await fetch(config.provider.bench.options.baseURL + path, { method: 'POST', headers: { authorization: 'Bearer ' + config.provider.bench.options.apiKey, 'content-type': 'application/json', 'anthropic-beta': 'opencode-beta-1' },
    body: JSON.stringify({ model: 'opencode-side', max_tokens: 999999, max_completion_tokens: 5, stream: true, ...body }).replaceAll('@@PROMPT@@', () => JSON.stringify(prompt).slice(1, -1)) });
  await res.text();
  console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_fake', status: res.status }));
}
`);
  await chmod(bin, 0o755);
  return { bin, calls: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

/** One reply's events in a wire's own stream format: chat a text delta then usage; Messages and Responses a reasoning block, a tool call, then usage. */
function streamed(wire: 'chat' | 'messages' | 'responses', id: string, reply: { cost?: boolean; cached?: number }): string {
  const data = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
  if (wire === 'messages') return [
    { type: 'message_start', message: { id, usage: { input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: reply.cached ?? 0, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check status.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_2', name: 'game_policy_status', input: {} } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40, output_tokens_details: { thinking_tokens: 25 }, ...(reply.cost ? { cost: 0.0021 } : {}) } },
  ].map(data).join('');
  if (wire === 'responses') return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'Check status.' }], encrypted_content: 'ENC2' } },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c2', name: 'game_policy_status', arguments: '{}' } },
    { type: 'response.completed', response: { id, status: 'completed', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: reply.cached ?? 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 25 }, ...(reply.cost ? { cost: 0.0021 } : {}) } } },
  ].map(data).join('');
  return data({ id, provider: 'FakeHost', choices: [{ index: 0, delta: { content: 'thinking' }, finish_reason: null }] })
    + data({ id, provider: 'FakeHost', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 40, ...(reply.cost ? { cost: 0.0021 } : {}), ...(reply.cached !== undefined ? { prompt_tokens_details: { cached_tokens: reply.cached } } : {}) } }) + 'data: [DONE]\n\n';
}

interface RouterRequest { url: string; authorization?: string; headers: Record<string, string | string[] | undefined>; body: Record<string, any> }
/** A router answering in `wire`'s stream format (default chat completions, as OpenRouter streams them), failing with `status` (only the first `failFirst` requests, when set), or streaming `errorEvent` as an in-band error inside a 200 reply. */
async function fakeRouter(status = 200, reply: { cost?: boolean; cached?: number; generationCost?: number | null; failFirst?: number; errorEvent?: string; wire?: 'chat' | 'messages' | 'responses' } = { cost: true }): Promise<{ url: string; requests: RouterRequest[]; lookups: string[] }> {
  const requests: RouterRequest[] = [];
  const lookups: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (req.url!.startsWith('/v1/generation')) {
        lookups.push(req.url!);
        if (reply.generationCost === null || reply.generationCost === undefined) res.writeHead(404).end();
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { total_cost: reply.generationCost } }));
        return;
      }
      requests.push({ url: req.url!, authorization: req.headers.authorization, headers: req.headers, body: JSON.parse(raw) });
      if (status !== 200 && requests.length <= (reply.failFirst ?? Infinity)) { res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":{"message":"upstream down"}}'); return; }
      if (reply.errorEvent) { res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ error: { message: reply.errorEvent } })}\n\n`); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(streamed(reply.wire ?? 'chat', `gen-${requests.length}`, reply));
    });
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, lookups };
}

function lobby(router: string, scratch: string, wallMs: number, overrides: Partial<AuthoringLobby> = {}) {
  const charged: MeteredTurn[] = [];
  const events: Record<string, unknown>[] = [];
  const value: AuthoringLobby = {
    url: 'http://127.0.0.1:9/mcp', token: TOKEN, surfaceHash: 'a'.repeat(64), roles: ['runner', 'guard'],
    model: { provider: 'openai', model: 'vendor/model', baseUrl: router, request: { provider: { only: ['fakehost'], allow_fallbacks: false } }, price: { inPerM: 1, outPerM: 2 } },
    apiKey: API_KEY, maxOutputTokens: 100, brief: 'THE BRIEF', blockedTools: ['game_act'], status: () => 'Active policies: runner: version 1; guard: version 2.',
    canAfford: () => true, charge: turn => { charged.push(turn); return true; }, transcript: event => { events.push(event); }, scratch,
    signal: AbortSignal.timeout(wallMs), deadlineAt: Date.now() + wallMs, ...overrides,
  };
  return { value, charged, events };
}

describe('OpenCode authoring harness', { timeout: 30000 }, () => {
  it('names its version, isolates OpenCode, meters every turn through the proxy and re-prompts with status until the deadline', async () => {
    const dir = await directory();
    const fake = await fakeOpenCode(dir);
    const router = await fakeRouter();
    const harness = await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] });
    expect(harness.identity).toEqual({ id: 'opencode', version: '9.9.9' });
    const { value, charged, events } = lobby(router.url, dir, 2500);
    const outcome = await harness.author(value);
    expect(outcome.reason).toBe('cutoff');
    const calls = await fake.calls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(outcome.turns).toBe(charged.length);
    // First run: the brief and a fresh titled session; then the same session, continued with the seat's status.
    // Prompts go on stdin, never as a message argument (which `opencode run` would quote).
    expect(calls[0]!.args).toEqual(['run', '--pure', '--auto', '--format', 'json', '--title', 'benchmark authoring']);
    expect(calls[0]!.prompt).toContain('THE BRIEF');
    expect(calls[1]!.args).toEqual(['run', '--pure', '--auto', '--format', 'json', '--session', 'ses_fake']);
    // The continuation is the neutral template: the seat's status, no time left (the first prompt states the deadline once) and no advice.
    const status = 'Active policies: runner: version 1; guard: version 2.';
    expect(calls[1]!.prompt).toBe(continuationPrompt(status));
    expect(continuationPrompt(status)).toBe(`[harness] ${status} Authoring continues until the deadline; the policies active then are evaluated.`);
    expect(continuationPrompt('')).toBe('[harness] Authoring continues until the deadline; the policies active then are evaluated.');
    expect(continuationPrompt(status)).not.toMatch(ADVICE);
    expect(calls[0]!.prompt).toMatch(/Authoring runs until its deadline \(about \d+ minutes\)/);
    expect(calls[0]!.prompt.replace('THE BRIEF', '')).not.toMatch(ADVICE);
    // OpenCode gets neither the key nor the operator's environment; the bridge alone gets the commander credential.
    for (const call of calls) {
      expect(JSON.stringify(call)).not.toContain(API_KEY);
      expect(call.env.HOME!.startsWith(dir)).toBe(true);
      expect(call.cwd.startsWith(dir)).toBe(true);
      expect(Object.keys(call.env).filter(key => /KEY|SECRET|TOKEN/.test(key))).toEqual([]);
      expect(call.config.mcp.game).toMatchObject({ type: 'local', command: ['bridge-command', '--url', value.url, '--expect-hash', value.surfaceHash], environment: { PLAYERTHREE_TOKEN: TOKEN } });
      expect(call.config.permission).toEqual({ bash: 'deny', webfetch: 'deny', websearch: 'deny', external_directory: 'deny' });
      expect(call.config.tools).toEqual({ bash: false, webfetch: false, websearch: false, game_game_act: false });
      // Without a series window OpenCode compacts at the harness default; it never truncates a game result.
      expect(call.config.provider.bench.models['vendor/model'].limit).toEqual({ context: OPENCODE_CONTEXT_TOKENS, output: 100 });
      expect(call.config.tool_output).toEqual({ max_lines: 48_000, max_bytes: 96_000 });
    }
    // The router sees the bench's key, model and pins, the capped output and the cost-reporting flag.
    for (const request of router.requests) {
      expect(request.authorization).toBe(`Bearer ${API_KEY}`);
      expect(request.body).toMatchObject({ model: 'vendor/model', max_tokens: 100, provider: { only: ['fakehost'], allow_fallbacks: false }, usage: { include: true } });
      expect(request.body['max_completion_tokens']).toBeUndefined();
      // No series effort: the provider's default applies.
      expect(request.body['reasoning_effort']).toBeUndefined();
    }
    // Without a series system prompt, OpenCode's messages and tools pass through as sent.
    expect(router.requests[0]!.body['messages']).toEqual(sentMessages(calls[0]!.prompt));
    expect(router.requests[0]!.body['tools']).toEqual(OPENCODE_TOOLS);
    expect(charged[0]).toEqual({ inputTokens: 1000, outputTokens: 40, servedBy: 'FakeHost', generationId: 'gen-1', reportedUsd: 0.0021 });
    // The run the deadline kills may end before it logs its call.
    expect(events.filter(e => e['kind'] === 'prompt').length - calls.length).toBeGreaterThanOrEqual(0);
    expect(events.filter(e => e['kind'] === 'prompt').length - calls.length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(events)).not.toContain(API_KEY);
  });

  it('replaces OpenCode\'s system prompt with the series one in every request, leaving messages and tools untouched', async () => {
    const dir = await directory();
    const fake = await fakeOpenCode(dir);
    const router = await fakeRouter();
    const systemPrompt = 'You are the benchmark candidate.\nUse the game tools.';
    const { value } = lobby(router.url, dir, 2500, { systemPrompt });
    expect((await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] })).author(value)).reason).toBe('cutoff');
    const calls = await fake.calls();
    expect(router.requests.length).toBeGreaterThanOrEqual(2);
    router.requests.forEach((request, index) => {
      const prompt = calls[index]!.prompt;
      // Exactly one system message, first and exactly ours; the conversation follows in order, without OpenCode's system text.
      expect(request.body['messages']).toEqual([{ role: 'system', content: systemPrompt }, ...sentMessages(prompt).filter(message => message.role !== 'system' && message.role !== 'developer')]);
      expect(request.body['tools']).toEqual(OPENCODE_TOOLS);
      for (const text of [...OPENCODE_SYSTEM, 'OPENCODE-', 'opencode']) expect(JSON.stringify(request.body)).not.toContain(text);
    });
    // The brief still opens the conversation, in the first user message.
    expect(router.requests[0]!.body['messages'][1]).toMatchObject({ role: 'user', content: expect.stringContaining('THE BRIEF') });
  });

  it('asks every request for the series reasoning effort and keeps OpenCode\'s prompt-cache breakpoints on text parts', async () => {
    const dir = await directory();
    const mark = { type: 'ephemeral' };
    const marked = [{ role: 'system', content: OPENCODE_SYSTEM[0], cache_control: mark }, ...OPENCODE_HISTORY.slice(0, 1), { ...OPENCODE_HISTORY[1]!, cache_control: mark }, { role: 'user', content: '@@PROMPT@@', cache_control: mark }];
    const fake = await fakeOpenCode(dir, [{ tools: OPENCODE_TOOLS, messages: marked }]);
    const router = await fakeRouter();
    const systemPrompt = 'You are the benchmark candidate.';
    const { value, events } = lobby(router.url, dir, 2500, { systemPrompt, reasoning: 'high' });
    await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] })).author(value);
    const calls = await fake.calls();
    expect(router.requests.length).toBeGreaterThanOrEqual(2);
    router.requests.forEach((request, index) => {
      expect(request.body['reasoning_effort']).toBe('high');
      // The dropped system message's breakpoint marks the series prompt; the new prompt's moves onto its text part; the
      // tool message keeps its own.
      expect(request.body['messages']).toEqual([
        { role: 'system', content: [{ type: 'text', text: systemPrompt, cache_control: mark }] },
        OPENCODE_HISTORY[0], { ...OPENCODE_HISTORY[1], cache_control: mark },
        { role: 'user', content: [{ type: 'text', text: calls[index]!.prompt, cache_control: mark }] },
      ]);
    });
    expect(events.find(e => e['kind'] === 'harness')).toMatchObject({ config: { provider: { bench: { reasoning: 'high' } } } });
  });

  it('compacts every model against the series window, capped at the model\'s own', async () => {
    for (const [series, own, expected] of [[300_000, 200_000, 200_000], [100_000, 1_000_000, 100_000], [undefined, 120_000, 120_000]] as const) {
      const dir = await directory();
      const fake = await fakeOpenCode(dir);
      const router = await fakeRouter();
      const { value, events } = lobby(router.url, dir, 10000, { ...(series !== undefined ? { contextTokens: series } : {}), charge: () => false });
      value.model = { ...value.model, contextTokens: own };
      await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] })).author(value);
      // What OpenCode is configured with, and what the transcript records.
      expect((await fake.calls())[0]!.config.provider.bench.models['vendor/model'].limit).toEqual({ context: expected, output: 100 });
      expect(events.find(e => e['kind'] === 'harness')).toMatchObject({ config: { provider: { bench: { limit: { context: expected, output: 100 } } } } });
    }
  });

  it('never lets OpenCode\'s compaction-continue text reach the model: the harness\'s own re-prompt, fixed per compaction, stands in', async () => {
    const dir = await directory();
    const overflow = "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n";
    const summary = { role: 'assistant', content: '## Objective\n- Author policies.' };
    const later = { role: 'assistant', content: '## Objective\n- Author better policies.' };
    const turn = { role: 'user', content: 'What did we do so far?' };
    const reply = { role: 'assistant', content: 'Working.' };
    // As OpenCode 1.19.5 sent them in a real run: the tool-less summarizer request (its history quoting an earlier
    // continue); the conversation after a compaction (its summary, the recent turns kept, the continue last); the same a
    // turn later; then after a second compaction (its summary first, the first compaction's summary and continue now
    // among the turns kept, its own continue last, after an overflow note).
    const bodies = [
      { messages: [{ role: 'system', content: 'You are a context summarization agent.' }, { role: 'user', content: `Here is the conversation so far:\n\n<conversation>\n[User]: @@PROMPT@@\n\n[User]: ${OPENCODE_COMPACTION_CONTINUE}\n\n[User]: ${overflow}${OPENCODE_COMPACTION_CONTINUE}\n</conversation>\n\nCreate a new anchored summary.` }] },
      { tools: OPENCODE_TOOLS, messages: [{ role: 'system', content: OPENCODE_SYSTEM[0] }, turn, summary, ...OPENCODE_HISTORY, reply, { role: 'user', content: OPENCODE_COMPACTION_CONTINUE }] },
      { tools: OPENCODE_TOOLS, messages: [{ role: 'system', content: OPENCODE_SYSTEM[0] }, turn, summary, ...OPENCODE_HISTORY, reply, { role: 'user', content: OPENCODE_COMPACTION_CONTINUE }, reply] },
      { tools: OPENCODE_TOOLS, messages: [{ role: 'system', content: OPENCODE_SYSTEM[0] }, turn, later, ...OPENCODE_HISTORY, turn, summary, { role: 'user', content: OPENCODE_COMPACTION_CONTINUE }, reply, { role: 'user', content: [{ type: 'text', text: `${overflow}${OPENCODE_COMPACTION_CONTINUE}` }] }] },
    ];
    const fake = await fakeOpenCode(dir, bodies);
    const router = await fakeRouter();
    const systemPrompt = 'You are the benchmark candidate.';
    let reads = 0;
    const { value, events } = lobby(router.url, dir, 3000, { systemPrompt, status: () => `Status read ${++reads}.` });
    expect((await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] })).author(value)).reason).toBe('cutoff');
    expect(router.requests.length).toBeGreaterThanOrEqual(8);
    for (const request of router.requests) {
      for (const text of ['Continue if you have next steps', 'stop and ask', 'media attachments']) expect(JSON.stringify(request.body)).not.toContain(text);
      expect(request.body['messages'][0]).toEqual({ role: 'system', content: systemPrompt });
    }
    const [summarizer, first, next, second] = router.requests.map(request => request.body['messages'] as Record<string, any>[]);
    // The summarizer keeps the series system prompt; its quoted continues (with their note) read as the time-free harness line.
    const quoted = '[harness] Authoring continues until the deadline; the policies active then are evaluated.';
    expect(summarizer![1]!['content']).toBe(`Here is the conversation so far:\n\n<conversation>\n[User]: ${(await fake.calls())[0]!.prompt}\n\n[User]: ${quoted}\n\n[User]: ${quoted}\n</conversation>\n\nCreate a new anchored summary.`);
    // After a compaction: the harness's continuation, with the status when first forwarded and no time left.
    const rePrompt = first!.at(-1)!['content'] as string;
    expect(rePrompt).toMatch(/^\[harness\] Status read \d+\. Authoring continues until the deadline; the policies active then are evaluated\.$/);
    expect(rePrompt).not.toMatch(ADVICE);
    expect(first!.slice(1, -1)).toEqual([turn, summary, ...OPENCODE_HISTORY, reply]);
    // Later requests repeat it verbatim (the status has moved on since): a turn later, in the next run, and after the
    // next compaction moved it among the turns kept.
    expect(next![6]).toEqual({ role: 'user', content: rePrompt });
    expect(router.requests[5]!.body['messages'].at(-1)).toEqual({ role: 'user', content: rePrompt });
    expect(second![7]).toEqual({ role: 'user', content: rePrompt });
    // The second compaction gets its own, the note OpenCode led it with gone too; content parts stay parts.
    const secondText = second!.at(-1)!['content'][0]['text'] as string;
    expect(second!.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: secondText }] });
    expect(secondText).toMatch(/^\[harness\] Status read \d+\. Authoring continues/);
    expect(secondText).not.toBe(rePrompt);
    expect(router.requests[7]!.body['messages'].at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: secondText }] });
    // The transcript marks the summarizer turns and records each stand-in once.
    expect(events.filter(e => e['kind'] === 'turn').map(e => e['compaction']).slice(0, 4)).toEqual([true, false, false, false]);
    expect(events.filter(e => e['kind'] === 'harness_text')).toEqual([{ kind: 'harness_text', source: 'opencode_compaction_continue', text: rePrompt }, { kind: 'harness_text', source: 'opencode_compaction_continue', text: secondText }]);
  });

  it('speaks Anthropic Messages to Claude: signed thinking passes through untouched, adaptive thinking at the series effort, bearer auth through a router', async () => {
    const dir = await directory();
    const mark = { type: 'ephemeral' };
    const thinking = { type: 'thinking', thinking: 'Status first.', signature: 'SIGNED' };
    const history = [
      { role: 'user', content: [{ type: 'text', text: '@@PROMPT@@' }] },
      { role: 'assistant', content: [thinking, { type: 'tool_use', id: 'tu_1', name: 'game_policy_status', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'version 1' }] },
    ];
    const tools = [{ name: 'game_policy_status', description: 'Status.', input_schema: { type: 'object', properties: {} } }];
    const fake = await fakeOpenCode(dir, [{ system: [{ type: 'text', text: OPENCODE_SYSTEM[0], cache_control: mark }], tools, messages: history, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }]);
    const router = await fakeRouter(200, { wire: 'messages', cost: true, cached: 300 });
    const systemPrompt = 'You are the benchmark candidate.';
    const { value, charged, events } = lobby(router.url, dir, 2500, { systemPrompt, reasoning: 'high' });
    value.model = { ...value.model, provider: 'anthropic', model: 'anthropic/claude' };
    await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] })).author(value);
    const calls = await fake.calls();
    expect(calls[0]!.config.provider.bench).toMatchObject({ npm: '@ai-sdk/anthropic', models: { 'anthropic/claude': { reasoning: true } } });
    expect(router.requests.length).toBeGreaterThanOrEqual(2);
    router.requests.forEach((request, index) => {
      expect(request.url).toBe('/v1/messages');
      expect(request.authorization).toBe(`Bearer ${API_KEY}`);
      expect(request.headers['x-api-key']).toBeUndefined();
      expect(request.headers['anthropic-version']).toBe('2023-06-01');
      expect(request.headers['anthropic-beta']).toBe('opencode-beta-1,effort-2025-11-24');
      expect(request.body['system']).toEqual([{ type: 'text', text: systemPrompt, cache_control: mark }]);
      expect(request.body['messages']).toEqual(JSON.parse(JSON.stringify(history).replaceAll('@@PROMPT@@', JSON.stringify(calls[index]!.prompt).slice(1, -1))));
      expect(request.body).toMatchObject({ model: 'anthropic/claude', max_tokens: 100, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, provider: { only: ['fakehost'] } });
      for (const field of ['usage', 'reasoning_effort', 'max_completion_tokens']) expect(request.body[field]).toBeUndefined();
    });
    // Input as Chat Completions counts it (uncached, cache writes and reads); the router's cost; thinking accounted.
    expect(charged[0]).toEqual({ inputTokens: 500, outputTokens: 40, cachedInputTokens: 300, generationId: 'gen-1', reportedUsd: 0.0021 });
    expect(events.find(e => e['kind'] === 'turn')).toMatchObject({ finishReason: 'tool_use', toolCalls: ['game_policy_status'], thinkingBlocks: 1, thinkingChars: 13, reasoningTokens: 25 });
    expect(events.find(e => e['kind'] === 'harness')).toMatchObject({ config: { provider: { bench: { npm: '@ai-sdk/anthropic', wire: 'messages' } } } });
  });

  it('speaks OpenAI Responses on the responses wire: encrypted reasoning items pass through, the series prompt is the instructions', async () => {
    const dir = await directory();
    const input = [
      { role: 'developer', content: OPENCODE_SYSTEM[0] },
      { role: 'user', content: [{ type: 'input_text', text: '@@PROMPT@@' }] },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC1' },
      { type: 'function_call', call_id: 'c1', name: 'game_policy_status', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'version 1' },
    ];
    const tools = [{ type: 'function', name: 'game_policy_status', description: 'Status.', parameters: { type: 'object', properties: {} }, strict: false }];
    const fake = await fakeOpenCode(dir, [{ input, tools, max_output_tokens: 999999, include: ['reasoning.encrypted_content'] }]);
    const router = await fakeRouter(200, { wire: 'responses', cost: true, cached: 800 });
    const systemPrompt = 'You are the benchmark candidate.';
    const { value, charged, events } = lobby(router.url, dir, 2500, { systemPrompt, reasoning: 'high' });
    value.model = { ...value.model, wire: 'responses' };
    await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] })).author(value);
    const calls = await fake.calls();
    expect(calls[0]!.config.provider.bench).toMatchObject({ npm: '@ai-sdk/openai', models: { 'vendor/model': { reasoning: true } } });
    expect(router.requests.length).toBeGreaterThanOrEqual(2);
    router.requests.forEach((request, index) => {
      expect(request.url).toBe('/v1/responses');
      expect(request.authorization).toBe(`Bearer ${API_KEY}`);
      expect(request.body['instructions']).toBe(systemPrompt);
      expect(request.body['input']).toEqual(JSON.parse(JSON.stringify(input.slice(1)).replaceAll('@@PROMPT@@', JSON.stringify(calls[index]!.prompt).slice(1, -1))));
      expect(request.body).toMatchObject({ model: 'vendor/model', max_output_tokens: 100, store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'high' }, tools });
      for (const field of ['max_tokens', 'max_completion_tokens', 'usage', 'reasoning_effort']) expect(request.body[field]).toBeUndefined();
      for (const text of [...OPENCODE_SYSTEM, 'OPENCODE-']) expect(JSON.stringify(request.body)).not.toContain(text);
    });
    expect(charged[0]).toEqual({ inputTokens: 1000, outputTokens: 40, cachedInputTokens: 800, generationId: 'gen-1', reportedUsd: 0.0021 });
    expect(events.find(e => e['kind'] === 'turn')).toMatchObject({ finishReason: 'tool_calls', toolCalls: ['game_policy_status'], thinkingBlocks: 1, thinkingChars: 13, reasoningTokens: 25 });
  });

  it('speaks OpenRouter chat on the openrouter-chat wire: reasoning_details pass through, effort in `reasoning`', async () => {
    const dir = await directory();
    const details = [{ type: 'reasoning.text', text: 'Status first.', format: 'unknown', index: 0 }];
    const messages = [{ role: 'system', content: OPENCODE_SYSTEM[0] }, { role: 'user', content: '@@PROMPT@@' }, { ...OPENCODE_HISTORY[0], reasoning: 'Status first.', reasoning_details: details }, OPENCODE_HISTORY[1]];
    const fake = await fakeOpenCode(dir, [{ tools: OPENCODE_TOOLS, messages, reasoning: { enabled: true } }]);
    const router = await fakeRouter();
    const { value } = lobby(router.url, dir, 2500, { systemPrompt: 'You are the benchmark candidate.', reasoning: 'high' });
    value.model = { ...value.model, wire: 'openrouter-chat' };
    await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] })).author(value);
    expect((await fake.calls())[0]!.config.provider.bench.npm).toBe('@openrouter/ai-sdk-provider');
    expect(router.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of router.requests) {
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.body).toMatchObject({ reasoning: { enabled: true, effort: 'high' }, usage: { include: true }, max_tokens: 100 });
      expect(request.body['reasoning_effort']).toBeUndefined();
      expect(request.body['messages'][2]).toEqual({ ...OPENCODE_HISTORY[0], reasoning: 'Status first.', reasoning_details: details });
    }
  });

  it('withholds a reply that crosses a ceiling and ends authoring as budget', async () => {
    const dir = await directory();
    const fake = await fakeOpenCode(dir);
    const router = await fakeRouter();
    const harness = await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] });
    const { value, events } = lobby(router.url, dir, 10000, { charge: () => false });
    const outcome = await harness.author(value);
    expect(outcome).toEqual({ reason: 'budget', turns: 1, providerErrors: 0 });
    expect(router.requests).toHaveLength(1);
    expect(events.find(e => e['kind'] === 'turn')).toMatchObject({ withheld: true });
    // The budget stop kills OpenCode at once: no further run starts.
    expect(events.filter(e => e['kind'] === 'prompt')).toHaveLength(1);
  });

  it('never forwards a turn that could not be afforded', async () => {
    const dir = await directory();
    const fake = await fakeOpenCode(dir);
    const router = await fakeRouter();
    const { value } = lobby(router.url, dir, 10000, { canAfford: () => false });
    expect(await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] })).author(value)).toEqual({ reason: 'budget', turns: 0, providerErrors: 0 });
    expect(router.requests).toHaveLength(0);
  });

  it('ends as a provider failure after consecutive runs without a completed turn', async () => {
    const dir = await directory();
    const fake = await fakeOpenCode(dir);
    const router = await fakeRouter(500);
    const { value } = lobby(router.url, dir, 20000);
    const outcome = await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'], retryPauseMs: 10 })).author(value);
    expect(outcome).toEqual({ reason: 'provider_error', turns: 0, providerErrors: 3, providerStatus: 500 });
    expect(await fake.calls()).toHaveLength(3);
  });
  it('ends a deadline reached without one completed turn as a provider failure, counting error events inside 200 replies', async () => {
    const dir = await directory();
    const fake = await fakeOpenCode(dir);
    const error = 'Codex error event: Invalid schema for tools[1].parameters';
    const router = await fakeRouter(200, { errorEvent: error });
    const { value, events } = lobby(router.url, dir, 1500);
    // The pause outlasts the clock: the deadline ends authoring long before the idle runs could.
    const outcome = await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'], retryPauseMs: 60_000 })).author(value);
    expect(outcome).toEqual({ reason: 'provider_error', turns: 0, providerErrors: 1, providerStatus: null });
    expect(await fake.calls()).toHaveLength(1);
    expect(events.filter(e => e['kind'] === 'provider_error')).toEqual([{ kind: 'provider_error', status: null, detail: error }]);
  });
  it('ends a run whose provider failures sit beside completed turns at the deadline, with the failures counted', async () => {
    const dir = await directory();
    const fake = await fakeOpenCode(dir);
    const router = await fakeRouter(503, { cost: true, failFirst: 1 });
    const { value, charged } = lobby(router.url, dir, 2500);
    const outcome = await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'], retryPauseMs: 10 })).author(value);
    expect(outcome).toEqual({ reason: 'cutoff', turns: charged.length, providerErrors: 1 });
    expect(charged.length).toBeGreaterThan(0);
  });
  it('charges the generation\'s billed cost when the reply carries none, else the cache-aware estimate', async () => {
    for (const generationCost of [0.0042, null]) {
      const dir = await directory();
      const fake = await fakeOpenCode(dir);
      const router = await fakeRouter(200, { cost: false, cached: 800, generationCost });
      const { value, charged } = lobby(router.url, dir, 10000);
      // One turn is enough: it is charged, then the run stops at the ceiling.
      value.charge = turn => { charged.push(turn); return false; };
      value.model = { ...value.model, billing: 'openrouter-key' };
      await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'], generationRetryMs: 1 })).author(value);
      expect(router.lookups[0]).toBe('/v1/generation?id=gen-1');
      expect(charged[0]).toEqual({ inputTokens: 1000, outputTokens: 40, cachedInputTokens: 800, servedBy: 'FakeHost', generationId: 'gen-1', ...(generationCost === null ? {} : { reportedUsd: generationCost }) });
    }
  });
});

describe('turn cost', () => {
  const price = { inPerM: 1, outPerM: 2, cacheReadPerM: 0.1 };
  it('is the router-reported cost when there is one', () => {
    expect(turnCostUsd(price, { inputTokens: 1000, outputTokens: 40, cachedInputTokens: 800, reportedUsd: 0.5 })).toBe(0.5);
  });
  it('else prices cached input at the cache-read rate, or at the input rate without one', () => {
    expect(turnCostUsd(price, { inputTokens: 1000, outputTokens: 40, cachedInputTokens: 800 })).toBeCloseTo((200 + 80 + 80) / 1e6, 12);
    expect(turnCostUsd({ inPerM: 1, outPerM: 2 }, { inputTokens: 1000, outputTokens: 40, cachedInputTokens: 800 })).toBeCloseTo((1000 + 80) / 1e6, 12);
    expect(turnCostUsd(undefined, { inputTokens: 1000, outputTokens: 40 })).toBeNull();
  });
});

describe('router key billing', () => {
  it('stops at the billed ceiling and reports the settled delta', async () => {
    const usage = [10, 10.4, 11.2, 11.3];
    let reads = 0;
    const fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://router.test/api/v1/key');
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
      return new Response(JSON.stringify({ data: { usage: usage[Math.min(reads++, usage.length - 1)] } }));
    }) as typeof globalThis.fetch;
    let tripped = 0;
    const ceiling = Promise.withResolvers<void>();
    const watch = await watchKeyUsage({ baseUrl: 'https://router.test/api', apiKey: API_KEY, ceilingUsd: 1, onCeiling: () => { tripped++; ceiling.resolve(); }, pollMs: 1, settleMs: 1, fetch });
    await ceiling.promise;
    expect(tripped).toBe(1);
    expect(await watch!.finish(true)).toEqual({ beforeUsd: 10, afterUsd: 11.3, deltaUsd: 1.3 });
  });

  it('is unavailable when the router does not report key usage', async () => {
    const fetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof globalThis.fetch;
    expect(await watchKeyUsage({ baseUrl: 'https://router.test/api', apiKey: API_KEY, ceilingUsd: 1, onCeiling: () => {}, fetch })).toBeNull();
  });
});
