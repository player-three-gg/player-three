import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definition, EXAMPLE_POLICY } from '../../playerthree/examples/tag/index.ts';
import { createPlayerThreeHost, type PlayerThreeHost, type PlayerThreeMatch } from 'playerthree/host';
import { mountMcp } from 'playerthree/mcp';
import { llmTools, runAgent, systemPrompt, type TranscriptEvent } from '../src/agent.ts';
import { Budget, createAnthropicProvider, createOpenAiProvider } from '../src/providers.ts';
import { connectSeat } from '../src/remote.ts';

const OWNER = 'authoring_test_owner';
let host: PlayerThreeHost;
let server: Server;
let base: string;
let close: () => Promise<void>;
/** Per fake-API path: the reply to the n-th request, and every request body received. */
const replies = new Map<string, (turn: number) => unknown>();
const received = new Map<string, Record<string, unknown>[]>();
let seatedMatch: PlayerThreeMatch | undefined;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}
const call = (id: string, name: string, args: Record<string, unknown>, status = 'completed') => ({ type: 'function_call', status, call_id: id, name, arguments: JSON.stringify(args) });
const say = (text: string) => ({ type: 'message', content: [{ type: 'output_text', text }] });
const usage = { input_tokens: 1000, output_tokens: 100 };

beforeAll(async () => {
  host = createPlayerThreeHost({ definition });
  await host.commanders.ready;
  host.commanders.ensure(OWNER);
  server = createServer(async (req, res) => {
    const path = req.url ?? '';
    const list = received.get(path) ?? [];
    list.push(await body(req));
    received.set(path, list);
    const reply = replies.get(path)?.(list.length - 1);
    if (reply === undefined) return void res.writeHead(404).end();
    // OpenRouter-style route headers: the upstream's name and the generation id to look it up by.
    res.writeHead(200, { 'content-type': 'application/json', 'x-provider-name': 'FakeUpstream', 'x-generation-id': `gen-fake-${list.length}` }).end(JSON.stringify(reply));
  });
  close = mountMcp(server, host).close;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await close();
  await new Promise<void>((r) => server.close(() => r()));
  host.dispose();
});

async function lobbySeat(name: string) {
  const id = host.commanders.create(OWNER, { name, kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
  const seat = await connectSeat({ url: `${base}/mcp`, token: host.commanders.token(OWNER, id), role: 'runner' });
  return { id, seat };
}

describe('runner authoring', { timeout: 30_000 }, () => {
  it('a reply cut at the output cap is re-prompted, its partial call never runs, and authoring runs to its deadline', async () => {
    replies.set('/cut/v1/responses', (turn) =>
      turn === 0
        ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1000, output_tokens: 100 },
          output: [say('Deploying the example policy.'), call('partial', 'policy_deploy', { runtime: 'js' }, 'incomplete')] }
        : turn === 1
          ? { output: [call('deploy', 'policy_deploy', { runtime: 'js', code: EXAMPLE_POLICY })], usage }
          : { output: [say('Done preparing.')], usage });
    const { seat } = await lobbySeat('Cut runner');
    const llm = createOpenAiProvider({ model: 'gpt-5-mini', apiKey: 'test-key', system: systemPrompt(seat, (await seat.briefing()).game), tools: llmTools(seat), maxOutputTokens: 100, baseUrl: `${base}/cut` });
    const events: TranscriptEvent[] = [];
    const summary = await runAgent({ seat, provider: llm, budget: new Budget(1, { inPerM: 0.25, outPerM: 2 }), maxOutputTokens: 100, maxTurns: 4, authoring: true, log: () => {}, transcript: (e) => events.push(e) });
    await seat.close();

    // Never "prepared": the session runs to its turn deadline with the deploy active.
    expect(summary.reason).toBe('max_turns');
    expect(summary.turns).toBe(4);
    const sent = received.get('/cut/v1/responses')!.map((b) => JSON.stringify(b));
    expect(sent[1]).toContain('100-token output cap before any tool call completed');
    expect(sent[1]).not.toContain('"call_id":"partial"');
    expect(sent[3]).toContain('Authoring runs until its deadline');
    expect(sent[3]).toContain('Active policy: version 1');
    const turns = events.filter((e) => e.kind === 'turn');
    expect(turns.map((e) => [e.truncated, e.servedBy, e.generationId])).toEqual([[true, 'FakeUpstream', 'gen-fake-1'], [false, 'FakeUpstream', 'gen-fake-2'], [false, 'FakeUpstream', 'gen-fake-3'], [false, 'FakeUpstream', 'gen-fake-4']]);
    expect(events.filter((e) => e.kind === 'tool').map((e) => e.name)).toEqual(['policy_deploy']);
    expect(events.at(-1)).toEqual({ kind: 'stop', reason: 'max_turns' });
  });

  it('a lobby turn ending without an active policy is answered with the deploy step before the runner waits for a match', async () => {
    let commander = '';
    replies.set('/nudge/v1/responses', (turn) => {
      if (turn === 2) seatedMatch = host.createMatch({ seed: 4, realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: commander } }] });
      return turn === 1 ? { output: [call('deploy', 'policy_deploy', { runtime: 'js', code: EXAMPLE_POLICY })], usage } : { output: [say('Ready.')], usage };
    });
    const { id, seat } = await lobbySeat('Nudged runner');
    commander = id;
    const llm = createOpenAiProvider({ model: 'gpt-5-mini', apiKey: 'test-key', system: systemPrompt(seat, (await seat.briefing()).game), tools: llmTools(seat), maxOutputTokens: 100, baseUrl: `${base}/nudge` });
    const lines: string[] = [];
    const summary = await runAgent({ seat, provider: llm, budget: new Budget(1, { inPerM: 0.25, outPerM: 2 }), maxOutputTokens: 100, maxTurns: 3, log: (l) => lines.push(l) });
    await seat.close();

    expect(summary.reason).toBe('max_turns');
    const sent = received.get('/nudge/v1/responses')!.map((b) => JSON.stringify(b));
    expect(sent[0]).toContain('Deploy a working policy first');
    expect(sent[1]).toContain('No policy is active (none)');
    expect(lines).toContain('  a match seated this commander');
    await seatedMatch!.step(1);
    expect(seatedMatch!.seats().find((s) => s.team === 'blue' && s.role === 'runner')).toMatchObject({ commander: true, policyVersion: 1 });
  });

  it('anthropic: a tool_use cut off by max_tokens is dropped from the calls and the history', async () => {
    replies.set('/anth/v1/messages', () => ({
      stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 100 },
      content: [{ type: 'text', text: 'Deploying.' }, { type: 'tool_use', id: 'tu_cut', name: 'policy_deploy', input: { runtime: 'js' } }],
    }));
    const llm = createAnthropicProvider({ model: 'claude-haiku-4-5', apiKey: 'test-key', system: 'test', tools: [], maxOutputTokens: 100, baseUrl: `${base}/anth` });
    llm.addUser('Go.');
    const turn = await llm.turn();
    expect(turn).toMatchObject({ text: 'Deploying.', toolCalls: [], truncated: true, servedBy: 'FakeUpstream', generationId: 'gen-fake-1' });
    llm.addUser('Again.');
    await llm.turn();
    expect(JSON.stringify(received.get('/anth/v1/messages')![1])).not.toContain('tu_cut');
  });
});
