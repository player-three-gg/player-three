import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { watchKeyUsage } from '../src/billing.ts';
import { turnCostUsd, type AuthoringLobby, type MeteredTurn } from '../src/harness.ts';
import { openCodeHarness } from '../src/opencode.ts';

const API_KEY = 'sk-fake-router-key-0123456789';
const TOKEN = 'commander-token-'.padEnd(48, 'x');
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(done => { server.closeAllConnections(); server.close(done); })));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function directory() { const path = await mkdtemp(join(tmpdir(), 'playerthree-opencode-')); directories.push(path); return path; }

/** A stand-in `opencode`: `--version`, and `run` posting one chat completion to its configured provider, logging what it got. */
async function fakeOpenCode(dir: string): Promise<{ bin: string; calls: () => Promise<{ args: string[]; env: Record<string, string>; cwd: string; config: Record<string, any> }[]> }> {
  const log = join(dir, 'calls.jsonl');
  const bin = join(dir, 'opencode');
  await writeFile(bin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9'); process.exit(0); }
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: process.env, cwd: process.cwd(), config }) + '\\n');
const res = await fetch(config.provider.bench.options.baseURL + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + config.provider.bench.options.apiKey, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'opencode-side', max_tokens: 999999, max_completion_tokens: 5, stream: true, messages: [{ role: 'user', content: args.at(-1) }] }) });
await res.text();
console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_fake', status: res.status }));
`);
  await chmod(bin, 0o755);
  return { bin, calls: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

/** A router answering chat completions as OpenRouter streams them, or failing with `status`. */
async function fakeRouter(status = 200, reply: { cost?: boolean; cached?: number; generationCost?: number | null } = { cost: true }): Promise<{ url: string; requests: { authorization?: string; body: Record<string, any> }[]; lookups: string[] }> {
  const requests: { authorization?: string; body: Record<string, any> }[] = [];
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
      requests.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
      if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":{"message":"upstream down"}}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = `gen-${requests.length}`;
      res.write(`data: ${JSON.stringify({ id, provider: 'FakeHost', choices: [{ index: 0, delta: { content: 'thinking' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, provider: 'FakeHost', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 40, ...(reply.cost ? { cost: 0.0021 } : {}), ...(reply.cached !== undefined ? { prompt_tokens_details: { cached_tokens: reply.cached } } : {}) } })}\n\ndata: [DONE]\n\n`);
      res.end();
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
    expect(calls[0]!.args).toContain('--title');
    expect(calls[0]!.args.at(-1)).toContain('THE BRIEF');
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['--session', 'ses_fake']));
    expect(calls[1]!.args.at(-1)).toMatch(/^\[harness\] Authoring continues until its deadline.*Active policies: runner: version 1; guard: version 2\./);
    // OpenCode gets neither the key nor the operator's environment; the bridge alone gets the commander credential.
    for (const call of calls) {
      expect(JSON.stringify(call)).not.toContain(API_KEY);
      expect(call.env.HOME!.startsWith(dir)).toBe(true);
      expect(call.cwd.startsWith(dir)).toBe(true);
      expect(Object.keys(call.env).filter(key => /KEY|SECRET|TOKEN/.test(key))).toEqual([]);
      expect(call.config.mcp.game).toMatchObject({ type: 'local', command: ['bridge-command', '--url', value.url, '--expect-hash', value.surfaceHash], environment: { PLAYERTHREE_TOKEN: TOKEN } });
      expect(call.config.permission).toEqual({ bash: 'deny', webfetch: 'deny', websearch: 'deny', external_directory: 'deny' });
      expect(call.config.tools).toEqual({ bash: false, webfetch: false, websearch: false, game_game_act: false });
    }
    // The router sees the bench's key, model and pins, the capped output and the cost-reporting flag.
    for (const request of router.requests) {
      expect(request.authorization).toBe(`Bearer ${API_KEY}`);
      expect(request.body).toMatchObject({ model: 'vendor/model', max_tokens: 100, provider: { only: ['fakehost'], allow_fallbacks: false }, usage: { include: true } });
      expect(request.body['max_completion_tokens']).toBeUndefined();
    }
    expect(charged[0]).toEqual({ inputTokens: 1000, outputTokens: 40, servedBy: 'FakeHost', generationId: 'gen-1', reportedUsd: 0.0021 });
    // The run the deadline kills may end before it logs its call.
    expect(events.filter(e => e['kind'] === 'prompt').length - calls.length).toBeGreaterThanOrEqual(0);
    expect(events.filter(e => e['kind'] === 'prompt').length - calls.length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(events)).not.toContain(API_KEY);
  });

  it('withholds a reply that crosses a ceiling and ends authoring as budget', async () => {
    const dir = await directory();
    const fake = await fakeOpenCode(dir);
    const router = await fakeRouter();
    const harness = await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] });
    const { value, events } = lobby(router.url, dir, 10000, { charge: () => false });
    const outcome = await harness.author(value);
    expect(outcome).toEqual({ reason: 'budget', turns: 1 });
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
    expect(await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'] })).author(value)).toEqual({ reason: 'budget', turns: 0 });
    expect(router.requests).toHaveLength(0);
  });

  it('ends as a provider failure after consecutive runs without a completed turn', async () => {
    const dir = await directory();
    const fake = await fakeOpenCode(dir);
    const router = await fakeRouter(500);
    const { value } = lobby(router.url, dir, 20000);
    const outcome = await (await openCodeHarness({ bin: fake.bin, bridge: ['bridge-command'], retryPauseMs: 10 })).author(value);
    expect(outcome).toEqual({ reason: 'provider_error', turns: 0, providerStatus: 500 });
    expect(await fake.calls()).toHaveLength(3);
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
