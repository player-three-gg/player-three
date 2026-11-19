import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definition, EXAMPLE_POLICY } from '../../playerthree/examples/tag/index.ts';
import { createPlayerThreeHost } from 'playerthree/host';
import type { PlayerThreeHost, PlayerThreeMatch } from 'playerthree/host';
import { mountMcp } from 'playerthree/mcp';
import { llmTools, runAgent, systemPrompt } from '../src/agent.ts';
import { Budget, createAnthropicProvider, createOpenAiProvider, priceFor } from '../src/providers.ts';
import { connectSeat } from '../src/remote.ts';

/** Scripted model: briefing → deploy the example policy → a full practice match → policy_status forever. */
const SCRIPT: [string, Record<string, unknown>][] = [
  ['game_briefing', {}],
  ['policy_deploy', { runtime: 'js', code: EXAMPLE_POLICY }],
  ['practice_run', { opponent: 'idle', ticks: 1200, seed: 1 }],
];
const next = (turn: number): [string, Record<string, unknown>] => SCRIPT[turn] ?? ['policy_status', {}];

let host: PlayerThreeHost;
let match: PlayerThreeMatch;
let server: Server;
let base: string;
let close: () => Promise<void>;
const requests: { path: string; body: Record<string, unknown> }[] = [];
const OWNER = 'runner_test_owner';
let lobbyMatch: PlayerThreeMatch | undefined;
let lobbyCommander: string;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

beforeAll(async () => {
  host = createPlayerThreeHost({ definition });
  match = host.createMatch({ seed: 2, realtime: false, controllers: { blue: { runner: 'agent', guard: 'agent' } } });
  // One http server: the game's MCP endpoint plus fake OpenAI / Anthropic APIs.
  server = createServer(async (req, res) => {
    const b = await body(req);
    requests.push({ path: req.url ?? '', body: b });
    const turn = requests.filter((r) => r.path === req.url).length - 1;
    const [name, args] = next(turn);
    if (req.url === '/lobby/v1/responses') {
      // Commander in the lobby: deploy, then idle (no tool call) — the owner starts a match meanwhile — then brief.
      const call = (n: string, a: Record<string, unknown>) => ({ type: 'function_call', call_id: `call_${turn}`, name: n, arguments: JSON.stringify(a) });
      const output =
        turn === 0
          ? [call('policy_deploy', { runtime: 'js', code: EXAMPLE_POLICY })]
          : turn === 1
            ? [{ type: 'message', content: [{ type: 'output_text', text: 'Ready.' }] }]
            : [call(turn === 2 ? 'game_briefing' : 'policy_status', {})];
      if (turn === 1) lobbyMatch = host.createMatch({ seed: 3, realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: lobbyCommander } }] });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ output, usage: { input_tokens: 1000, output_tokens: 100 } }));
    } else if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          output: [{ type: 'function_call', call_id: `call_${turn}`, name, arguments: JSON.stringify(args) }],
          usage: { input_tokens: 1000, output_tokens: 100 },
        }),
      );
    } else if (req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ content: [{ type: 'tool_use', id: `tu_${turn}`, name, input: args }], usage: { input_tokens: 1000, output_tokens: 100 } }),
      );
    } else res.writeHead(404).end();
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

describe('playerthree-run agent loop', { timeout: 30_000 }, () => {
  for (const provider of ['openai', 'anthropic'] as const) {
    it(`${provider}: drives the seat through the MCP tools and stops at the hard budget`, async () => {
      const role = provider === 'openai' ? 'runner' : 'guard';
      const seat = await connectSeat({ url: `${base}/mcp`, token: match.mintSeatToken('blue', role) });
      const model = provider === 'openai' ? 'gpt-5-mini' : 'claude-haiku-4-5';
      const opts = { model, apiKey: 'test-key', system: systemPrompt(seat, (await seat.briefing()).game), tools: llmTools(seat), maxOutputTokens: 100, baseUrl: base };
      expect(opts.system).toContain((await seat.briefing()).game.title);
      expect(opts.system).toContain('Deploy a working policy right away: policy_deploy');
      expect(opts.system).toContain('A policy is a program you can write or fork, not only a starter to deploy: policy_deploy `{code}` or `{modules, entry}`');
      expect(opts.system).toContain('Turns: a reply without a tool call ends your turn');
      expect(opts.system).not.toMatch(/only when a decision needs them|before reading anything else|keep reading short/);
      const llm = provider === 'openai' ? createOpenAiProvider(opts) : createAnthropicProvider(opts);
      const budget = new Budget(0.01, { inPerM: 0.25, outPerM: 2 });
      const lines: string[] = [];
      const summary = await runAgent({ seat, provider: llm, budget, maxOutputTokens: 100, log: (l) => lines.push(l) });
      await seat.close();

      // A finished practice match must not be mistaken for the end of the live match.
      expect(summary.reason).toBe('budget');
      expect(summary.outcome).toBe('running');
      expect(summary.spentUsd).toBeLessThanOrEqual(0.01);
      expect(summary.turns).toBeGreaterThanOrEqual(3);
      expect(summary.inputTokens).toBe(summary.turns * 1000);
      expect(lines.some((l) => /→ policy_deploy \{.* ok \(/.test(l))).toBe(true);
      const sent = requests.filter((r) => r.path === (provider === 'openai' ? '/v1/responses' : '/v1/messages'));
      const second = JSON.stringify(sent[1]!.body);
      // Tool results of the previous turn go back to the model, keyed by its call id.
      expect(second).toContain(provider === 'openai' ? '"call_id":"call_0"' : '"tool_use_id":"tu_0"');
      expect(second).toContain('surfaceHash');
      expect(JSON.stringify(sent[0]!.body)).toContain('game_act');
      expect(JSON.stringify(sent[3]!.body)).toMatch(/\\"outcome\\":\\"(win|loss|draw)\\"/);
      // The deploy result reached the model as a DeployResult (its probe may legitimately time out on a loaded machine).
      expect(JSON.stringify(sent[2]!.body)).toMatch(/\\"ok\\":true,\\"version\\":1|\\"code\\":\\"timeout\\"/);
    });
  }

  it('a commander token prepares in the lobby, idles without spending tokens, and is woken when a match seats it', async () => {
    host.commanders.ensure(OWNER);
    lobbyCommander = host.commanders.create(OWNER, { name: 'Lobby runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const seat = await connectSeat({ url: `${base}/mcp`, token: host.commanders.token(OWNER, lobbyCommander), role: 'runner' });
    const llm = createOpenAiProvider({ model: 'gpt-5-mini', apiKey: 'test-key', system: systemPrompt(seat, (await seat.briefing()).game), tools: llmTools(seat), maxOutputTokens: 100, baseUrl: `${base}/lobby` });
    const lines: string[] = [];
    const summary = await runAgent({ seat, provider: llm, budget: new Budget(0.005, { inPerM: 0.25, outPerM: 2 }), maxOutputTokens: 100, log: (l) => lines.push(l) });
    await seat.close();

    expect(summary.reason).toBe('budget');
    const sent = requests.filter((r) => r.path === '/lobby/v1/responses').map((r) => JSON.stringify(r.body));
    expect(sent[0]).toContain('in the lobby');
    expect(sent[2]).toContain('A match that seats you has started');
    expect(sent[3]).toMatch(/\\"phase\\":\\"match\\"/);
    expect(lines).toContain('  a match seated this commander');
    // The library policy deployed in the lobby was seated and the agent took the seat over.
    await lobbyMatch!.step(1);
    expect(lobbyMatch!.seats().find((s) => s.team === 'blue' && s.role === 'runner')).toMatchObject({ controller: 'agent', commander: true, policyVersion: 1 });
  });

  it('prices dated model snapshots like their base model and knows no price for unknown models', () => {
    expect(priceFor('gpt-5-mini-2025-08-07')).toEqual(priceFor('gpt-5-mini'));
    expect(priceFor('some-unknown-model')).toBeUndefined();
  });
});
