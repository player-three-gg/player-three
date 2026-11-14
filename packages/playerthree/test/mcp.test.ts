import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY, StreamableHTTPClientTransport, UnauthorizedError, type CallToolResult, type ElicitResult, type Tool } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { definition, EXAMPLE_POLICY, manifest } from '../examples/tag/index.ts';
import { servedSkills } from '../src/briefing.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeMatch } from '../src/host/types.ts';
import { mountMcp, SURFACE_HASH_META, type ConsentEvent } from '../src/mcp/index.ts';

const ALL_TOOLS = [
  'game_briefing',
  'game_observe',
  'game_act',
  'game_wait',
  'game_ready',
  'game_skill',
  'policy_deploy',
  'policy_status',
  'policy_rollback',
  'policy_export',
  'policy_import',
  'practice_run',
  'pool_publish',
  'game_say',
  'game_usage',
];

interface Endpoint {
  url: string;
  host: PlayerThreeHost;
  match: PlayerThreeMatch;
  consents: ConsentEvent[];
  close(): Promise<void>;
}

async function startEndpoint(def = definition): Promise<Endpoint> {
  const host = createPlayerThreeHost({ definition: def });
  const match = host.createMatch({
    seed: 7,
    realtime: false,
    controllers: { blue: { runner: 'agent', guard: 'agent' }, red: { runner: 'bot', guard: 'bot' } },
  });
  const consents: ConsentEvent[] = [];
  const server: Server = createServer((_req, res) => {
    res.writeHead(404).end('not mcp');
  });
  const mounted = mountMcp(server, host, { onConsent: (e) => consents.push(e) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    host,
    match,
    consents,
    async close() {
      await mounted.close();
      await new Promise<void>((r) => server.close(() => r()));
      host.dispose();
    },
  };
}

async function connect(url: string, token: string, opts: { elicit?: (message: string) => ElicitResult; protocol?: 'modern' | 'legacy' } = {}) {
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { versionNegotiation: { mode: opts.protocol === 'legacy' ? 'legacy' : { pin: '2026-07-28' } }, capabilities: opts.elicit ? { elicitation: { form: {} } } : {} },
  );
  if (opts.elicit) {
    const elicit = opts.elicit;
    client.setRequestHandler('elicitation/create', async (req) => elicit((req.params as { message: string }).message));
  }
  let sessionId: string | undefined;
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    authProvider: { token: async () => token },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (sessionId) headers.set('mcp-session-id', sessionId);
      const response = await fetch(input, { ...init, headers });
      if (response.ok) sessionId = response.headers.get('mcp-session-id') ?? sessionId;
      return response;
    },
  }));
  await client.listTools();
  return client;
}

const json = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe('MCP endpoint', () => {
  let ep: Endpoint;
  let token: string;
  let client: Client;
  beforeAll(async () => {
    ep = await startEndpoint();
    token = ep.match.mintSeatToken('blue', 'runner');
    client = await connect(ep.url, token);
  });
  afterAll(async () => {
    await client.close();
    await ep.close();
  });

  it('lists one tool per enabled control method, in a stable order, with annotations and the surfaceHash', async () => {
    const listing = await client.listTools(undefined, { cacheMode: 'bypass' });
    expect(listing.tools.map((t) => t.name)).toEqual(ALL_TOOLS);
    const readOnly = new Set(['game_briefing', 'game_observe', 'game_wait', 'game_skill', 'policy_status', 'policy_export']);
    for (const tool of listing.tools) {
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(tool.annotations?.readOnlyHint).toBe(readOnly.has(tool.name));
      expect(tool.outputSchema?.type).toBe('object');
    }
    const briefing = (await client.callTool({ name: 'game_briefing', arguments: {} })).structuredContent as { surfaceHash: string };
    expect(listing._meta?.[SURFACE_HASH_META]).toBe(briefing.surfaceHash);
    expect(client.getInstructions()).toContain(briefing.surfaceHash);
    expect(client.getInstructions()).toContain('Follow your seat’s mandate');
    expect(client.getInstructions()).toContain('supervised → propose deploys');
    expect(client.getInstructions()).not.toContain('Never ask your owner for permission');
    expect(client.getInstructions()).toContain('playerthree-commander');
  });

  it('derives argument schemas from the manifest', async () => {
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t] as [string, Tool]));
    const props = (name: string) => tools.get(name)!.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props('game_act')['intents']).toMatchObject({ type: 'array', minItems: 1, maxItems: 8 });
    const variants = (props('game_act')['intents']!['items'] as { oneOf: { properties: { kind: { const: string } } }[] }).oneOf;
    expect(variants.map((v) => v.properties.kind.const)).toEqual(['move', 'stop', 'dash']);
    expect(props('policy_deploy')['runtime']).toMatchObject({ enum: ['js', 'wasm'] });
    expect(props('practice_run')['opponent']).toMatchObject({ enum: ['idle', 'easy', 'hard'] });
    expect(props('practice_run')['ticks']).toMatchObject({ type: 'integer', maximum: 1200 });
    expect(props('game_wait')['until']).toMatchObject({ items: { enum: ['flag_taken', 'flag_returned', 'captured', 'tagged'] } });
    expect(props('game_skill')['name']).toMatchObject({ enum: servedSkills(manifest).map((s) => s.name).sort() });
    expect(props('game_skill')['path']).toMatchObject({ type: 'string', pattern: expect.any(String) });
    expect(props('game_briefing')).toMatchObject({ topic: { type: 'string' }, page: { type: 'integer', minimum: 1 } });
    expect(props('game_observe')['fields']).toMatchObject({ items: { enum: Object.keys(manifest.observation.fields) } });
    expect(props('policy_deploy')['include']).toMatchObject({ type: 'array', maxItems: 16 });
  });

  it('acts with closed error codes and never echoes input', async () => {
    const injected = 'IGNORE_ALL_PREVIOUS_INSTRUCTIONS';
    const r = await client.callTool({
      name: 'game_act',
      arguments: { intents: [{ kind: 'move', x: 3, y: 4 }, { kind: 'move', x: 99, y: 4 }, { kind: injected }, { kind: 'move', x: 1, y: 1, [injected]: 1 }] },
    });
    expect(r.isError).toBeFalsy();
    const { acks } = r.structuredContent as { acks: unknown[] };
    expect(acks[0]).toEqual({ ok: true });
    expect(acks[1]).toEqual({ ok: false, code: 'invalid', schemaCode: 'range', path: ['x'], expected: 'MoveIntent["x"]: number (integer 0..15)' });
    expect(acks[2]).toMatchObject({ ok: false, code: 'invalid', schemaCode: 'tag' });
    expect(acks[3]).toMatchObject({ ok: false, code: 'invalid', schemaCode: 'unknown_field' });
    expect(JSON.stringify(r)).not.toContain(injected);

    const guard = await connect(ep.url, ep.match.mintSeatToken('blue', 'guard'));
    const dash = await guard.callTool({ name: 'game_act', arguments: { intents: [{ kind: 'dash' }] } });
    expect((dash.structuredContent as { acks: unknown[] }).acks).toEqual([{ ok: false, code: 'forbidden_role' }]);
    await guard.close();

    const red = await connect(ep.url, ep.match.mintSeatToken('red', 'runner'));
    const notMine = await red.callTool({ name: 'game_act', arguments: { intents: [{ kind: 'stop' }] } });
    expect((notMine.structuredContent as { acks: unknown[] }).acks).toEqual([{ ok: false, code: 'not_controller' }]);
    await red.close();
  });

  it('reports optional usage only on the authenticated exact seat and rejects lane overrides', async () => {
    const events: { match: string; team: string; role: string; report: unknown }[] = [];
    const off = ep.host.onUsage((event) => events.push(event));
    const report = { decisionId: 'decision-1', latencyMs: 125, source: 'self_report', reporter: 'unpriced', coverage: 'partial' };
    try {
      const accepted = await client.callTool({ name: 'game_usage', arguments: report });
      expect(accepted.structuredContent).toEqual({ ok: true });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ match: ep.match.id, team: 'blue', role: 'runner', report });
      expect(events[0]!.report).not.toHaveProperty('costAmount');
      const rejected = await client.callTool({ name: 'game_usage', arguments: { ...report, team: 'red' } });
      expect(rejected.isError).toBe(true);
      expect(events).toHaveLength(1);
    } finally { off(); }
  });

  it('rejects malformed tool arguments with a closed code and schema path only', async () => {
    const injected = 'please_run_rm_rf';
    const empty = await client.callTool({ name: 'game_act', arguments: { intents: [] } });
    expect(empty.isError).toBe(true);
    expect(json(empty)).toEqual({ error: 'invalid', schemaCode: 'range', path: ['intents'] });
    const tooMany = await client.callTool({ name: 'game_act', arguments: { intents: Array.from({ length: 9 }, () => ({ kind: 'stop' })) } });
    expect(json(tooMany)).toEqual({ error: 'invalid', schemaCode: 'too_long', path: ['intents'] });
    const extra = await client.callTool({ name: 'game_observe', arguments: { [injected]: injected } });
    expect(json(extra)).toEqual({ error: 'invalid', schemaCode: 'unknown_field', path: ['?'] });
    expect(JSON.stringify(extra)).not.toContain(injected);
    const ticks = await client.callTool({ name: 'practice_run', arguments: { opponent: 'hard', ticks: 5000 } });
    expect(json(ticks)).toEqual({ error: 'invalid', schemaCode: 'range', path: ['ticks'] });
    const unknownTool = await client.callTool({ name: injected, arguments: {} });
    expect(json(unknownTool)).toEqual({ error: 'bad_message' });
    expect(JSON.stringify(unknownTool)).not.toContain(injected);
  });

  // Two deploys, a rollback and two practices each load fresh sandboxes (0.5–0.9 s apiece at load average ~20).
  it('returns structured results that match every advertised output schema', { timeout: 30_000 }, async () => {
    // Own seat token: each token has its own call budget (burst 20), and this test makes 14 calls.
    const guard = await connect(ep.url, ep.match.mintSeatToken('blue', 'guard'));
    const tools = new Map((await guard.listTools()).tools.map((t) => [t.name, t] as [string, Tool]));
    const ajv = new AjvJsonSchemaValidator();
    const calls: [string, Record<string, unknown>][] = [
      ['game_briefing', {}],
      ['game_briefing', { topic: 'intents' }],
      ['game_observe', { since: 0 }],
      ['game_observe', { fields: ['tick', 'you'] }],
      ['game_act', { intents: [{ kind: 'move', x: 8, y: 8 }] }],
      ['game_wait', { seconds: 0 }],
      ['game_skill', { name: 'tag-strategy', path: 'policies/simple.js' }],
      ['policy_status', {}],
      ['policy_deploy', { runtime: 'js', code: EXAMPLE_POLICY }],
      ['policy_deploy', { runtime: 'js', code: 'function think( {' }],
      ['policy_status', {}],
      ['policy_rollback', { version: 1 }],
      ['practice_run', { opponent: 'easy', ticks: 60, seed: 3 }],
      ['practice_run', { opponent: 'easy', ticks: 60, artifact: { runtime: 'js', code: EXAMPLE_POLICY } }],
      ['practice_run', { opponent: 'easy', ticks: 60, artifact: { runtime: 'js', code: '// own code', include: ['tag-strategy/policies/simple.js'] } }],
      ['pool_publish', {}],
    ];
    const seen: Record<string, unknown> = {};
    for (const [name, args] of calls) {
      const r = await guard.callTool({ name, arguments: args });
      expect(r.isError, `${name} ${JSON.stringify(r.content)}`).toBeFalsy();
      const valid = ajv.getValidator(tools.get(name)!.outputSchema as never)(r.structuredContent);
      expect(valid.errorMessage, name).toBeUndefined();
      // Topic and skill pages are raw text; everything else is the JSON of structuredContent.
      if (name === 'game_skill') expect((r.content[0] as { text: string }).text).toBe(EXAMPLE_POLICY);
      else if (name === 'game_briefing' && 'topic' in args) expect((r.content[0] as { text: string }).text).toBe((r.structuredContent as { text: string }).text);
      else expect(json(r)).toEqual(r.structuredContent);
      expect(r._meta?.[SURFACE_HASH_META]).toMatch(/^[0-9a-f]{64}$/);
      seen[name] = r.structuredContent;
    }
    expect(seen['game_skill']).toEqual({ name: 'tag-strategy', path: 'policies/simple.js', offset: 0, total: EXAMPLE_POLICY.length, text: EXAMPLE_POLICY });
    expect(Object.keys((seen['game_observe'] as { observation: object }).observation)).toEqual(['tick', 'you']);
    expect((seen['practice_run'] as { ticks: number }).ticks).toBeGreaterThan(0);
    expect((seen['pool_publish'] as { policyId: string }).policyId).toMatch(/^pol_\d+$/);
    await guard.close();
  });

  it('serves developer, reference and default skills over MCP skills and game_skill with correct digests and sizes', async () => {
    const skills = new SkillsClient(client);
    const { skills: entries } = await skills.list();
    const served = servedSkills(manifest);
    expect(entries.map((e) => e.frontmatter.name).sort()).toEqual(served.map((s) => s.name).sort());
    for (const entry of entries) {
      const def = served.find((s) => s.name === entry.frontmatter.name)!;
      expect(entry.resources).not.toBe('dynamic');
      const resources = entry.resources as { uri: string; digest: string; size: number }[];
      expect(resources.length).toBe(Object.keys(def.files).length);
      for (const res of resources) {
        const path = Object.keys(def.files).find((p) => res.uri.endsWith(`/${def.name}/${p}`))!;
        const bytes = Buffer.from(def.files[path]!, 'utf8');
        expect(res.size).toBe(bytes.length);
        expect(res.digest).toContain(createHash('sha256').update(bytes).digest('hex'));
        // SkillsClient re-verifies size + digest of what the server actually sends.
        const file = await skills.read(entry, res.uri);
        expect(file.verified).toBe(true);
        expect(new TextDecoder().decode(file.bytes)).toBe(def.files[path]);
      }
      if (def.name.startsWith('playerthree-')) {
        const read = await client.callTool({ name: 'game_skill', arguments: { name: def.name, path: 'SKILL.md' } });
        expect(read.isError).toBeFalsy();
        expect(read.structuredContent).toMatchObject({ text: def.files['SKILL.md'], offset: 0 });
      }
    }
  });
});

describe('MCP endpoint auth', () => {
  let ep: Endpoint;
  beforeAll(async () => {
    ep = await startEndpoint();
  });
  afterAll(() => ep.close());

  const discover = (url: string, headers: Record<string, string>) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
    });

  it('answers 401 identically whether the token is missing, malformed, unknown, or not a seat token', async () => {
    const unknown = 'A'.repeat(32);
    const cases: Record<string, string>[] = [
      {},
      { authorization: 'Basic abc' },
      { authorization: 'Bearer not-a-token' },
      { authorization: `Bearer ${unknown}` },
      { authorization: `Bearer ${ep.match.tokens.spectator}` },
      { authorization: `Bearer ${ep.match.tokens.teams['blue']}` },
    ];
    const responses = await Promise.all(cases.map(async (h) => {
      const r = await discover(ep.url, h);
      return { status: r.status, auth: r.headers.get('www-authenticate'), body: await r.text() };
    }));
    for (const r of responses) expect(r).toEqual(responses[0]);
    expect(responses[0]!.status).toBe(401);
    expect(responses[0]!.body).not.toContain(unknown);
  });

  it('rejects browser origins it was not configured for', async () => {
    const r = await discover(ep.url, { authorization: `Bearer ${ep.match.mintSeatToken('blue', 'runner')}`, origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });

  it('only intercepts the MCP path on the shared http server', async () => {
    const r = await fetch(ep.url.replace('/mcp', '/other'));
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('not mcp');
  });

  it('stops serving a seat token once its match is gone', async () => {
    const token = ep.match.mintSeatToken('blue', 'guard');
    const ok = await discover(ep.url, { authorization: `Bearer ${token}` });
    expect(ok.status).not.toBe(401);
    ep.match.dispose();
    const gone = await discover(ep.url, { authorization: `Bearer ${token}` });
    expect(gone.status).toBe(401);
  });
});

describe('MCP consent', () => {
  let ep: Endpoint;
  const clients: Client[] = [];
  beforeAll(async () => {
    ep = await startEndpoint();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });
  afterAll(() => ep.close());

  it('asks the human once per token via elicitation, naming the seat and game', async () => {
    const messages: string[] = [];
    const client = await connect(ep.url, ep.match.mintSeatToken('blue', 'runner'), {
      elicit: (message) => {
        messages.push(message);
        return { action: 'accept', content: { allow: true } };
      },
    });
    clients.push(client);
    const first = await client.callTool({ name: 'game_observe', arguments: {} });
    expect(first.isError).toBeFalsy();
    await client.callTool({ name: 'policy_status', arguments: {} });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('blue/runner');
    expect(messages[0]).toContain('Tag');
    expect(messages[0]).toContain('closed-vocabulary');
    expect(ep.consents).toContainEqual({ match: ep.match.id, team: 'blue', role: 'runner', via: 'elicitation', granted: true });
  });

  it('refuses with consent_declined when the human declines, and asks again next time', async () => {
    let calls = 0;
    const client = await connect(ep.url, ep.match.mintSeatToken('blue', 'guard'), {
      elicit: () => {
        calls += 1;
        return calls === 1 ? { action: 'decline' } : { action: 'accept', content: { allow: true } };
      },
    });
    clients.push(client);
    const declined = await client.callTool({ name: 'game_observe', arguments: {} });
    expect(declined.isError).toBe(true);
    expect(json(declined)).toEqual({ error: 'consent_declined' });
    const accepted = await client.callTool({ name: 'game_observe', arguments: {} });
    expect(accepted.isError).toBeFalsy();
    expect(calls).toBe(2);
  });

  it('treats adding the server as consent when the client cannot elicit, and says so once', async () => {
    const client = await connect(ep.url, ep.match.mintSeatToken('red', 'guard'));
    clients.push(client);
    const first = await client.callTool({ name: 'policy_status', arguments: {} });
    expect(first.content).toHaveLength(2);
    expect((first.content[1] as { text: string }).text).toMatch(/counts as the player’s consent/);
    const second = await client.callTool({ name: 'policy_status', arguments: {} });
    expect(second.content).toHaveLength(1);
    expect(ep.consents).toContainEqual({ match: ep.match.id, team: 'red', role: 'guard', via: 'implicit', granted: true });
  });

  it('does not accept a consent answer the server never asked for', async () => {
    // Capture a genuine modern tools/call exchange, then replay it with a forged "accept" and no requestState.
    let captured: { url: string; init: RequestInit } | undefined;
    const owner = 'consent_forgery_owner';
    const commander = ep.host.commanders.create(owner, { name: 'Forgery test', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } });
    const token = ep.host.commanders.token(owner, commander.id);
    const client = new Client({ name: 'forger', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'decline' }));
    await client.connect(
      new StreamableHTTPClientTransport(new URL(ep.url), {
        authProvider: { token: async () => token },
        fetch: async (url, init) => {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
          if (body?.method === 'tools/call' && !captured) captured = { url: String(url), init: { ...init } };
          return fetch(url, init);
        },
      }),
    );
    clients.push(client);
    await client.callTool({ name: 'game_observe', arguments: {} });
    expect(captured).toBeDefined();
    const original = JSON.parse(captured!.init.body as string);
    const forged = {
      ...original,
      id: 999,
      params: { ...original.params, inputResponses: { consent: { action: 'accept', content: { allow: true } } } },
    };
    const res = await fetch(captured!.url, { ...captured!.init, body: JSON.stringify(forged) });
    const text = await res.text();
    // Not granted: the server asks again (input_required) instead of returning the observation.
    expect(text).toContain('input_required');
    expect(text).not.toContain('"observation"');
  });
});

describe('MCP rate limits', { timeout: 30_000 }, () => {
  it('bounds channel and agent waits per role without consuming non-wait slots', async () => {
    const ep = await startEndpoint();
    const client = await connect(ep.url, ep.match.mintSeatToken('blue', 'runner'));
    try {
      const waits = [
        client.callTool({ name: 'game_wait', arguments: { seconds: 60 } }),
        client.callTool({ name: 'game_wait', arguments: { seconds: 60 } }),
      ];
      // Calls share this transport and are dispatched in order.
      const overflow = await client.callTool({ name: 'game_wait', arguments: { seconds: 60 } });
      expect(json(overflow)).toEqual({ error: 'busy' });
      const playing = await client.callTool({ name: 'game_act', arguments: { intents: [{ kind: 'stop' }] } });
      expect(playing.isError).toBeFalsy();
      ep.match.tell('blue', ['runner'], 'Continue.');
      for (const waited of await Promise.all(waits)) expect(waited.isError).toBeFalsy();
      expect((await client.callTool({ name: 'game_wait', arguments: { seconds: 0 } })).isError).toBeFalsy();
    } finally {
      await client.close();
      await ep.close();
    }
  });
  it('rate-limits a flooding seat with a closed code', async () => {
    const ep = await startEndpoint();
    const client = await connect(ep.url, ep.match.mintSeatToken('blue', 'runner'));
    const codes: string[] = [];
    // 100 back-to-back calls outrun a 10/s refill (burst 20) unless each call takes > ~25 ms.
    for (let i = 0; i < 100; i++) {
      const r = await client.callTool({ name: 'policy_status', arguments: {} });
      codes.push(r.isError ? json(r).error : 'ok');
    }
    expect(codes.slice(0, 20).every((c) => c === 'ok')).toBe(true);
    expect(codes).toContain('rate_limited');
    expect(new Set(codes)).toEqual(new Set(['ok', 'rate_limited']));
    await client.close();
    await ep.close();
  });
});

describe('MCP tool surface per control modes', () => {
  it('advertises and routes bounded sequences when enabled', async () => {
    const sequenced = { ...manifest, control: { ...manifest.control, sequence: { maxSteps: 4, maxTicksAhead: 20, minSpacingTicks: 2 } } };
    const ep = await startEndpoint({ ...definition, manifest: sequenced });
    const client = await connect(ep.url, ep.match.mintSeatToken('blue', 'runner'));
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'game_sequence')!;
      expect(tool).toBeDefined();
      expect(tool.inputSchema.properties).toMatchObject({
        steps: { maxItems: 4, items: { properties: { in: { minimum: 0, maximum: 20 } } } },
        cancelOn: { items: { enum: ['flag_taken', 'flag_returned', 'captured', 'tagged'] } },
      });
      const r = await client.callTool({ name: 'game_sequence', arguments: { steps: [{ in: 0, intents: [{ kind: 'stop' }] }] } });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ ok: true, id: expect.any(String), acks: [[{ ok: true }]] });
      const ajv = new AjvJsonSchemaValidator();
      expect(ajv.getValidator(tool.outputSchema as never)(r.structuredContent).errorMessage).toBeUndefined();
      const cancel = await client.callTool({ name: 'game_sequence', arguments: { steps: [] } });
      expect(cancel.structuredContent).toMatchObject({ ok: true, acks: [] });
    } finally {
      await client.close();
      await ep.close();
    }
  });

  it.each(['policy', 'guard'] as const)('returns a schema-valid %s practice failure without a fabricated report', async (code) => {
    const ep = await startEndpoint({
      ...definition,
      create(options) {
        const adapter = definition.create(options);
        const report = adapter.report.bind(adapter);
        adapter.report = (team) => ({ ...report(team), injected: 'THIRD_PARTY_TEXT' });
        return adapter;
      },
    });
    const client = await connect(ep.url, ep.match.mintSeatToken('blue', 'runner'));
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'practice_run')!;
      const result = await client.callTool({
        name: 'practice_run',
        arguments: { opponent: 'idle', ticks: 1, artifact: { runtime: 'js', code: code === 'policy' ? 'function think( {' : 'function think() { return []; }' } },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ ok: false, code, policy: { version: 0 }, wallMs: expect.any(Number) });
      expect(result.structuredContent).not.toHaveProperty('report');
      expect(result.structuredContent).not.toHaveProperty('outcome');
      expect(JSON.stringify(result)).not.toContain('THIRD_PARTY_TEXT');
      const ajv = new AjvJsonSchemaValidator();
      expect(ajv.getValidator(tool.outputSchema as never)(result.structuredContent).errorMessage).toBeUndefined();
    } finally {
      await client.close();
      await ep.close();
    }
  });

  it('returns schema-valid supervised proposals, status and approval wakes', async () => {
    const ep = await startEndpoint();
    ep.match.setMandate('blue', 'runner', { autonomy: 'supervised', directive: { stance: 'attack' }, whenAbsent: 'policy' });
    const client = await connect(ep.url, ep.match.mintSeatToken('blue', 'runner'));
    try {
      const { tools } = await client.listTools();
      const ajv = new AjvJsonSchemaValidator();
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError).toBeFalsy();
        const tool = tools.find((t) => t.name === name)!;
        expect(ajv.getValidator(tool.outputSchema as never)(r.structuredContent).errorMessage).toBeUndefined();
        return r.structuredContent!;
      };
      const proposed = await call('policy_deploy', { runtime: 'js', code: EXAMPLE_POLICY });
      expect(proposed).toMatchObject({ ok: false, approval: { id: expect.any(String), kind: 'policyDeploy', version: 1 } });
      if (typeof proposed !== 'object' || proposed === null || !('approval' in proposed)) throw new Error('missing approval');
      const approval = proposed.approval;
      if (typeof approval !== 'object' || approval === null || !('id' in approval) || typeof approval.id !== 'string') throw new Error('missing approval id');
      expect(await call('policy_status')).toMatchObject({ policy: { version: null, approval: { id: approval.id, status: 'pending' } } });
      await ep.match.resolveApproval('blue', 'runner', approval.id, true);
      expect(await call('policy_status')).toMatchObject({ policy: { version: 1, approval: { status: 'approved' } } });
      expect(await call('game_wait', { seconds: 0 })).toMatchObject({ wake: 'approval' });
      const publish = await call('pool_publish');
      expect(publish).toMatchObject({ ok: false, approval: { kind: 'publish' } });
      if (typeof publish !== 'object' || publish === null || !('approval' in publish)) throw new Error('missing approval');
      const publication = publish.approval;
      if (typeof publication !== 'object' || publication === null || !('id' in publication) || typeof publication.id !== 'string') throw new Error('missing approval id');
      await ep.match.resolveApproval('blue', 'runner', publication.id, false);
      expect(await call('policy_status')).toMatchObject({ policy: { approval: { status: 'rejected' } } });
    } finally {
      await client.close();
      await ep.close();
    }
  });

  it('exposes only the methods the game enables', async () => {
    const intentsOnly = { ...manifest, starters: undefined, control: { intents: manifest.control.intents } } as unknown as typeof manifest;
    const ep = await startEndpoint({ ...definition, manifest: intentsOnly });
    const client = await connect(ep.url, ep.match.mintSeatToken('blue', 'runner'));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['game_briefing', 'game_observe', 'game_act', 'game_wait', 'game_ready', 'game_skill', 'game_usage']);
    const r = await client.callTool({ name: 'policy_deploy', arguments: { runtime: 'js', code: 'x' } });
    expect(json(r)).toEqual({ error: 'mode_unavailable' });
    await client.close();
    await ep.close();
  });
});

describe('multi-role MCP readiness', () => {
  it('readies only the selected seat and waits for each role’s own match entry', async () => {
    const ep = await startEndpoint();
    const owner = 'readiness_owner_0001';
    const commander = ep.host.commanders.create(owner, {
      name: 'Two roles', kind: 'agent', roles: ['runner', 'guard'], isolation: { independentSessions: true },
    });
    const other = ep.host.commanders.create(owner, {
      name: 'Other participant', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true },
    });
    const client = await connect(ep.url, ep.host.commanders.token(owner, commander.id));
    const otherClient = await connect(ep.url, ep.host.commanders.token(owner, other.id));
    try {
      const { tools } = await client.listTools();
      for (const name of ['game_ready', 'game_wait']) {
        const schema = tools.find((tool) => tool.name === name)!.inputSchema;
        expect(schema.properties?.['role']).toMatchObject({ type: 'string', enum: ['runner', 'guard'] });
        expect(schema.required ?? []).not.toContain('role');
      }
      const live = ep.host.createMatch({ realtime: false, readySeconds: 60, assignments: [
        { team: 'blue', role: 'runner', owner, kind: 'agent', commander: { id: commander.id } },
        { team: 'blue', role: 'guard', owner, kind: 'agent', commander: { id: commander.id } },
        { team: 'red', role: 'runner', owner, kind: 'agent', commander: { id: other.id } },
      ] });
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBeFalsy();
        return result.structuredContent;
      };
      expect(await call('game_briefing', {})).toMatchObject({
        commands: [
          { role: 'runner', team: 'blue', phase: 'lobby' },
          { role: 'guard', team: 'blue', phase: 'lobby' },
        ],
      });
      for (const role of ['runner', 'guard']) {
        expect(await call('game_briefing', { role })).toMatchObject({ phase: 'lobby', seat: { team: 'blue', role } });
      }
      expect(await call('game_ready', { role: 'runner' })).toMatchObject({
        phase: 'lobby', seat: { team: 'blue', role: 'runner' }, you: { ready: true },
      });
      expect(await call('game_wait', { seconds: 0, role: 'guard' })).toMatchObject({
        phase: 'lobby', seat: { team: 'blue', role: 'guard' }, you: { ready: false },
      });
      expect(live.readiness().seats.filter((seat) => seat.kind === 'agent').map((seat) => seat.state)).toEqual(['ready', 'online', 'absent']);
      expect(await call('game_ready', { role: 'guard' })).toMatchObject({
        phase: 'lobby', seat: { team: 'blue', role: 'guard' }, you: { ready: true },
      });
      expect(live.readiness().pending).toBe(true);
      expect(await call('game_wait', { seconds: 0, role: 'runner' })).toMatchObject({ phase: 'lobby', you: { ready: true } });
      expect((await otherClient.callTool({ name: 'game_ready', arguments: {} })).isError).toBeFalsy();
      expect(live.readiness().pending).toBe(false);
      for (const role of ['runner', 'guard']) {
        expect(await call('game_wait', { seconds: 0, role })).toMatchObject({
          phase: 'match', tick: 0, outcome: 'running', observation: { team: 'blue', you: { role } },
        });
      }
    } finally {
      await client.close();
      await otherClient.close();
      await ep.close();
    }
  });
});

describe('owner dispatch protocol smoke', () => {
  it.each(['modern', 'legacy'] as const)('preserves exact-role messages through %s polling, status activity and reconnect', async (protocol) => {
    const ep = await startEndpoint();
    const owner = 'dispatch_owner';
    const opponent = 'dispatch_opponent';
    const commander = ep.host.commanders.create(owner, {
      name: 'Whole team', kind: 'agent', roles: ['runner', 'guard'], isolation: { independentSessions: true },
    });
    const other = ep.host.commanders.create(opponent, {
      name: 'Other team', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true },
    });
    const token = ep.host.commanders.token(owner, commander.id);
    let client = await connect(ep.url, token, { protocol });
    const otherClient = await connect(ep.url, ep.host.commanders.token(opponent, other.id), { protocol });
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args }) as CallToolResult;
        expect(result.isError).toBeFalsy();
        expect(json(result)).toEqual(result.structuredContent);
        return result.structuredContent;
      };
      const resources = (await client.listResources()).resources.filter((resource) => resource.uri.startsWith('playerthree://seat/'));
      const readStatus = async (role: string) => {
        const uri = resources.find((resource) => resource.name === role)!.uri;
        const resource = await client.readResource({ uri }, { cacheMode: 'bypass' });
        const content = resource.contents[0]!;
        if (!('text' in content) || typeof content.text !== 'string') throw new Error('Expected status JSON');
        return JSON.parse(content.text);
      };
      const notifications: string[] = [];
      client.setNotificationHandler('notifications/resources/updated', (notification) => { notifications.push(notification.params.uri); });
      const subscription = protocol === 'modern'
        ? await client.listen({ resourceSubscriptions: resources.map((resource) => resource.uri) })
        : undefined;

      ep.host.commanders.tell(owner, [commander.id], 'Prepare both roles');
      for (const role of ['runner', 'guard']) expect(await readStatus(role)).toMatchObject({ phase: 'lobby', unreadOwnerMessages: 1 });
      await call('policy_status', { role: 'runner' });
      expect(await call('game_wait', { role: 'runner', seconds: 0 })).toMatchObject({
        phase: 'lobby', wake: 'owner_message', messages: [{ from: 'owner', text: 'Prepare both roles' }],
      });
      const live = ep.host.createMatch({ realtime: false, assignments: [
        { team: 'blue', role: 'runner', owner, kind: 'agent', commander: { id: commander.id } },
        { team: 'blue', role: 'guard', owner, kind: 'agent', commander: { id: commander.id } },
        { team: 'red', role: 'runner', owner: opponent, kind: 'agent', commander: { id: other.id } },
      ] });
      expect(await call('game_wait', { role: 'guard', seconds: 0 })).toMatchObject({
        phase: 'match', observation: { team: 'blue', you: { role: 'guard' } },
        messages: [{ from: 'owner', text: 'Prepare both roles' }],
      });
      expect(await call('game_wait', { role: 'runner', seconds: 0 })).not.toHaveProperty('messages');
      const sender = ep.host.authenticate(live.tokens.teams['blue']!)!.principal;
      let seq = 0;
      const tell = async (role: string, text: string) => {
        expect(await live.handleMessage(sender, { op: 'tell', seq: ++seq, roles: [role], text })).toMatchObject({ ok: true });
      };

      await tell('runner', 'Runner before observe');
      expect(await readStatus('runner')).toMatchObject({ unreadOwnerMessages: 1 });
      expect(await readStatus('guard')).toMatchObject({ unreadOwnerMessages: 0 });
      expect(JSON.stringify(await readStatus('runner'))).not.toContain('Runner before observe');
      if (subscription) await expect.poll(() => notifications).toContain(resources.find((resource) => resource.name === 'runner')!.uri);
      await call('policy_status', { role: 'runner' });
      expect(await call('game_observe', { role: 'guard', fields: ['tick'] })).not.toHaveProperty('messages');
      expect((await otherClient.callTool({ name: 'game_observe', arguments: {} })).structuredContent).not.toHaveProperty('messages');
      expect(await call('game_observe', { role: 'runner', fields: ['tick'] })).toEqual({
        observation: { tick: 0 }, messages: [{ from: 'owner', tick: 0, text: 'Runner before observe' }],
      });
      expect(await call('game_observe', { role: 'runner', fields: ['tick'] })).not.toHaveProperty('messages');

      const progress = Promise.withResolvers<void>();
      const waiting = client.callTool({ name: 'game_wait', arguments: { role: 'runner', seconds: 30 } }, {
        onprogress: () => progress.resolve(),
      });
      await progress.promise; // The wait is in flight, not merely queued by the client.
      await Promise.all([readStatus('runner'), call('policy_status', { role: 'runner' })]);
      await tell('guard', 'Guard during runner wait');
      await tell('runner', 'Runner during wait');
      const woke = await waiting as CallToolResult;
      expect(woke.isError).toBeFalsy();
      expect(json(woke)).toEqual(woke.structuredContent);
      expect(woke.structuredContent).toMatchObject({
        wake: 'owner_message', messages: [{ from: 'owner', text: 'Runner during wait' }],
      });
      expect(await call('game_observe', { role: 'runner', fields: ['tick'] })).not.toHaveProperty('messages');
      expect(await call('game_observe', { role: 'guard', fields: ['tick'] })).toMatchObject({
        messages: [{ from: 'owner', text: 'Guard during runner wait' }],
      });

      await subscription?.close();
      await client.close();
      await tell('runner', 'Unread across reconnect');
      client = await connect(ep.url, token, { protocol });
      expect(await readStatus('runner')).toMatchObject({ unreadOwnerMessages: 1 });
      expect((await client.callTool({ name: 'game_observe', arguments: {} })).isError).toBe(true);
      expect(await call('game_observe', { role: 'runner', fields: ['tick'] })).toMatchObject({
        messages: [{ from: 'owner', text: 'Unread across reconnect' }],
      });
      expect((await otherClient.callTool({ name: 'game_observe', arguments: {} })).structuredContent).not.toHaveProperty('messages');
      expect(JSON.stringify(live.replay())).not.toContain('Runner before observe');
    } finally {
      await client.close();
      await otherClient.close();
      await ep.close();
    }
  });
});

describe('private MCP status resources', () => {
  it('isolates stateful seat resource lists, reads and subscriptions and closes a rotated token stream', async () => {
    const ep = await startEndpoint();
    const a = await connect(ep.url, ep.match.mintSeatToken('blue', 'runner'));
    const b = await connect(ep.url, ep.match.mintSeatToken('red', 'runner'));
    try {
      const uri = (await a.listResources()).resources.find((resource) => resource.uri.startsWith('playerthree://seat/'))!.uri;
      expect(uri).toMatch(/^playerthree:\/\/seat\/[A-Za-z0-9_-]{43}$/);
      const bResources = (await b.listResources()).resources;
      expect(bResources.map((resource) => resource.uri)).not.toContain(uri);
      await expect(b.readResource({ uri })).rejects.toThrow();
      await expect(b.listen({ resourceSubscriptions: [uri] })).rejects.toThrow();
      const otherReceived: string[] = [];
      b.setNotificationHandler('notifications/resources/updated', (notification) => { otherReceived.push(notification.params.uri); });
      const bSubscription = await b.listen({ resourceSubscriptions: [bResources.find((resource) => resource.name === 'runner')!.uri] });
      const received: string[] = [];
      a.setNotificationHandler('notifications/resources/updated', (notification) => { received.push(notification.params.uri); });
      const aSubscription = await a.listen({ resourceSubscriptions: [uri] });
      ep.match.tell('blue', ['runner'], 'Owner text never enters status.');
      await expect.poll(() => received).toEqual([uri]);
      const resource = await a.readResource({ uri });
      const content = resource.contents[0]!;
      if (!('text' in content) || typeof content.text !== 'string') throw new Error('Expected status JSON');
      const status = JSON.parse(content.text);
      expect(status).toMatchObject({ phase: 'match', team: 'blue', tick: 0, unreadOwnerMessages: 1 });
      expect(JSON.stringify(resource)).not.toContain('Owner text');
      expect((await a.callTool({ name: 'game_wait', arguments: { seconds: 0 } })).structuredContent).toMatchObject({
        messages: [{ from: 'owner', text: 'Owner text never enters status.' }],
      });
      ep.match.mintSeatToken('blue', 'runner');
      await expect(a.readResource({ uri }, { cacheMode: 'bypass' })).rejects.toThrow();
      ep.match.tell('blue', ['runner'], 'After rotation.');
      expect(await aSubscription.closed).toBe('remote');
      expect(received).toEqual([uri]);
      expect(otherReceived).toEqual([]);
      await bSubscription.close();
    } finally {
      await a.close();
      await b.close();
      await ep.close();
    }
  });

  it('wakes commanders for seating, approvals, owner messages and match end without consuming waits', async () => {
    const ep = await startEndpoint({
      ...definition,
      create(options) {
        const adapter = definition.create(options);
        adapter.outcome = () => adapter.tick >= 1 ? 'draw' : 'running';
        return adapter;
      },
    });
    const owner = 'status_owner_0001';
    const commander = ep.host.commanders.create(owner, { name: 'Status test', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } });
    ep.host.commanders.update(owner, commander.id, { mandate: { autonomy: 'supervised' } });
    const client = await connect(ep.url, ep.host.commanders.token(owner, commander.id));
    try {
      const uri = (await client.listResources()).resources.find((resource) => resource.name === 'runner')!.uri;
      const readStatus = async () => {
        const content = (await client.readResource({ uri }, { cacheMode: 'bypass' })).contents[0]!;
        if (!('text' in content) || typeof content.text !== 'string') throw new Error('Expected status JSON');
        return JSON.parse(content.text);
      };
      let updates = 0;
      client.setNotificationHandler('notifications/resources/updated', () => { updates++; });
      const sub = await client.listen({ resourceSubscriptions: [uri] });
      expect(await readStatus()).toMatchObject({ phase: 'lobby', tick: 0, unreadOwnerMessages: 0 });
      const live = ep.host.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner, kind: 'agent', commander: { id: commander.id } }] });
      await expect.poll(() => updates).toBe(1);
      expect(await readStatus()).toMatchObject({ phase: 'match', team: 'blue' });
      expect((await client.callTool({ name: 'game_wait', arguments: { seconds: 0 } })).structuredContent).toMatchObject({ phase: 'match' });
      const proposal = (await client.callTool({ name: 'policy_deploy', arguments: { runtime: 'js', code: EXAMPLE_POLICY } })).structuredContent as { approval: { id: string } };
      await expect.poll(() => updates).toBe(2);
      expect(await readStatus()).toMatchObject({ approval: { id: proposal.approval.id, status: 'pending' } });
      expect((await client.callTool({ name: 'game_wait', arguments: { seconds: 0 } })).structuredContent).toMatchObject({ wake: 'approval' });
      await ep.host.commanders.resolveApproval(owner, commander.id, proposal.approval.id, false);
      await expect.poll(() => updates).toBe(3);
      expect(await readStatus()).toMatchObject({ approval: { status: 'rejected' } });
      ep.host.commanders.tell(owner, [commander.id], 'Private direction.');
      await expect.poll(() => updates).toBe(4);
      expect(await readStatus()).toMatchObject({ unreadOwnerMessages: 1 });
      await live.step();
      await expect.poll(() => updates).toBe(5);
      expect(await readStatus()).toMatchObject({ phase: 'lobby', outcome: 'draw', tick: 1 });
      expect((await client.callTool({ name: 'game_wait', arguments: { seconds: 0 } })).structuredContent).toMatchObject({ phase: 'match', outcome: 'draw', tick: 1 });
      ep.host.commanders.rotate(owner, commander.id);
      await sub.closed;
      expect(updates).toBe(5);
    } finally {
      await client.close();
      await ep.close();
    }
  });
});

describe('stateful match-seat authorization', () => {
  it('uses current discovery without claiming and binds the first real call to one exact lease', async () => {
    const ep = await startEndpoint();
    const token = ep.match.mintSeatToken('blue', 'runner');
    let sessionId: string | undefined;
    const client = new Client({ name: 'seat-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StreamableHTTPClientTransport(new URL(ep.url), {
      authProvider: { token: async () => token },
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        if (sessionId) headers.set('mcp-session-id', sessionId);
        const response = await fetch(url, { ...init, headers });
        if (response.ok) sessionId = response.headers.get('mcp-session-id') ?? sessionId;
        return response;
      },
    });
    try {
      await client.connect(transport);
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(sessionId).toBeUndefined();
      await client.listTools();
      expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await client.callTool({ name: 'game_observe', arguments: {} })).isError).toBeFalsy();
      await expect(connect(ep.url, token)).rejects.toThrow();
      const response = await fetch(ep.url, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sessionId! } });
      expect(response.status).toBe(204);
      await expect(client.callTool({ name: 'game_observe', arguments: {} })).rejects.toThrow();
    } finally {
      await client.close();
      await ep.close();
    }
  });

  it('answers malformed first seat requests without consuming the credential or issuing a session', async () => {
    const ep = await startEndpoint();
    const token = ep.match.mintSeatToken('blue', 'runner');
    const meta = { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_INFO_META_KEY]: { name: 'raw-seat', version: '1' }, [CLIENT_CAPABILITIES_META_KEY]: {} };
    const post = (body: unknown, headers: Record<string, string>) => fetch(ep.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', ...headers },
      body: JSON.stringify(body),
    });
    const malformed: [string, unknown, Record<string, string>][] = [
      ['missing Mcp-Method header', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, {}],
      ['Mcp-Method/body mismatch', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, { 'mcp-method': 'resources/list' }],
      ['missing per-request envelope', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'mcp-method': 'tools/list' }],
      ['not a JSON-RPC message', { jsonrpc: '1.0', id: 1, method: 'tools/list', params: { _meta: meta } }, { 'mcp-method': 'tools/list' }],
      ['unknown method', { jsonrpc: '2.0', id: 1, method: 'seat/steal', params: { _meta: meta } }, { 'mcp-method': 'seat/steal' }],
      ['invalid params', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: meta } }, { 'mcp-method': 'tools/call' }],
      ['notification', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: meta, requestId: 1 } }, { 'mcp-method': 'notifications/cancelled' }],
    ];
    try {
      for (const [label, body, headers] of malformed) {
        const response = await post(body, headers);
        const text = await response.text();
        // Ladder rejections are HTTP 4xx; the SDK's request-param validation is an in-band JSON-RPC error (HTTP 200).
        const rejected = response.status === 200 ? 'error' in JSON.parse(text) : response.status >= 400 && response.status < 500 && response.status !== 401;
        expect({ label, rejected, session: response.headers.get('mcp-session-id') }).toEqual({ label, rejected: true, session: null });
      }
      const client = await connect(ep.url, token);
      try {
        expect((await client.callTool({ name: 'game_observe', arguments: {} })).isError).toBeFalsy();
        await expect(connect(ep.url, token)).rejects.toThrow();
      } finally { await client.close(); }
    } finally {
      await ep.close();
    }
  });

  it('reads the seat protocol version from params._meta and requires the MCP-Protocol-Version header to agree', async () => {
    const ep = await startEndpoint();
    const token = ep.match.mintSeatToken('blue', 'runner');
    const envelope = { [CLIENT_INFO_META_KEY]: { name: 'raw-seat', version: '1' }, [CLIENT_CAPABILITIES_META_KEY]: {} };
    const post = async (header: string | undefined, body: Record<string, unknown>) => {
      const response = await fetch(ep.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-method': 'tools/list', ...(header === undefined ? {} : { 'mcp-protocol-version': header }) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', ...body }),
      });
      return { status: response.status, session: response.headers.get('mcp-session-id'), error: (await response.json() as { error?: { code: number; data?: unknown } }).error };
    };
    const current = { _meta: { ...envelope, [PROTOCOL_VERSION_META_KEY]: '2026-07-28' } };
    try {
      expect(await post('2025-11-25', { params: current })).toMatchObject({ status: 400, session: null, error: { code: -32020 } });
      expect(await post(undefined, { params: current })).toMatchObject({ status: 400, session: null, error: { code: -32020 } });
      // A top-level _meta is not the per-request envelope: with no params._meta claim the request is 2025-era, and a
      // 2025-era request naming the modern revision in its header is malformed: rejected, no session, no lease.
      expect(await post('2026-07-28', { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' }, params: { _meta: envelope } }))
        .toMatchObject({ status: 400, session: null, error: { code: expect.any(Number) } });
      // An envelope claim always names the modern revision; 2025-era clients negotiate through initialize instead.
      expect(await post('2025-11-25', { params: { _meta: { ...envelope, [PROTOCOL_VERSION_META_KEY]: '2025-11-25' } } }))
        .toMatchObject({ status: 400, session: null, error: { code: -32022, data: { supported: expect.arrayContaining(['2026-07-28', '2025-11-25']), requested: '2025-11-25' } } });
      const bound = await post('2026-07-28', { params: current });
      expect(bound).toMatchObject({ status: 200, session: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
      expect(bound.error).toBeUndefined();
    } finally {
      await ep.close();
    }
  });

  it('serves a 2025-11-25 client (initialize handshake) on a seat credential, binding the same single lease', async () => {
    const ep = await startEndpoint();
    const token = ep.match.mintSeatToken('blue', 'runner');
    const rpc = async (body: Record<string, unknown>, extra: Record<string, string> = {}) => {
      const response = await fetch(ep.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra },
        body: JSON.stringify({ jsonrpc: '2.0', ...body }),
      });
      const text = await response.text();
      const json = !text ? undefined : text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
      return { status: response.status, session: response.headers.get('mcp-session-id'), json };
    };
    try {
      const init = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'omp', version: '18.16.0' } } });
      expect(init).toMatchObject({ status: 200, session: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), json: { result: { protocolVersion: '2025-11-25' } } });
      const session = { 'mcp-session-id': init.session!, 'mcp-protocol-version': '2025-11-25' };
      expect((await rpc({ method: 'notifications/initialized' }, session)).status).toBeLessThan(300);
      const listed = await rpc({ id: 2, method: 'tools/list' }, session);
      expect(listed.json.result.tools.map((tool: { name: string }) => tool.name)).toContain('game_briefing');
      const briefing = await rpc({ id: 3, method: 'tools/call', params: { name: 'game_briefing', arguments: {} } }, session);
      expect(briefing.json.result.isError).toBeFalsy();
      await expect.poll(() => ep.match.seats().find((seat) => seat.team === 'blue' && seat.role === 'runner')?.agentActive).toBe(true);
      // The credential's one lease is held by that session: a second handshake with the same token is refused.
      const second = await rpc({ id: 4, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'other', version: '1' } } });
      expect(second.status).toBe(401);
    } finally {
      await ep.close();
    }
  });

  it('serves a commander credential to a 2025-era SDK client (oh-my-pi, pi, OpenCode)', async () => {
    const ep = await startEndpoint();
    const owner = 'legacy_client_owner';
    const commander = ep.host.commanders.create(owner, { name: 'Legacy client', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } });
    const token = ep.host.commanders.token(owner, commander.id);
    const client = new Client({ name: 'omp', version: '18.16.0' }, { versionNegotiation: { mode: 'legacy' } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ep.url), { authProvider: { token: async () => token } }));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('game_briefing');
      expect((await client.callTool({ name: 'game_briefing', arguments: {} })).isError).toBeFalsy();
    } finally {
      await client.close();
      await ep.close();
    }
  });

  it('revokes an existing session and its pending private response, allowing only an owner-minted replacement', async () => {
    const ep = await startEndpoint();
    const old = ep.match.mintSeatToken('blue', 'runner');
    const client = await connect(ep.url, old);
    try {
      const pending = client.callTool({ name: 'game_wait', arguments: { seconds: 60 } });
      const rejected = expect(pending).rejects.toBeInstanceOf(UnauthorizedError);
      await expect.poll(() => ep.match.seats().find((seat) => seat.team === 'blue' && seat.role === 'runner')?.agentActive).toBe(true);
      const replacement = ep.match.mintSeatToken('blue', 'runner');
      await rejected;
      await expect(client.callTool({ name: 'game_observe', arguments: {} })).rejects.toThrow();
      await expect(connect(ep.url, old)).rejects.toThrow();
      const recovered = await connect(ep.url, replacement);
      try {
        expect((await recovered.callTool({ name: 'game_briefing', arguments: {} })).isError).toBeFalsy();
        ep.match.tell('blue', ['runner'], 'REPLACEMENT_PRIVATE_MESSAGE');
        expect((await recovered.callTool({ name: 'game_observe', arguments: {} })).structuredContent).toMatchObject({
          messages: [{ from: 'owner', text: 'REPLACEMENT_PRIVATE_MESSAGE' }],
        });
      } finally { await recovered.close(); }
    } finally {
      await client.close();
      await ep.close();
    }
  });

  it('reauthorizes an existing MCP session when its seat ticket expires', async () => {
    const ep = await startEndpoint();
    const token = ep.match.mintSeatToken('blue', 'runner');
    const client = await connect(ep.url, token);
    try {
      expect((await client.callTool({ name: 'game_briefing', arguments: {} })).isError).toBeFalsy();
      const expiredTime = Date.now() + 121_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(expiredTime);
      try {
        await expect(client.callTool({ name: 'game_observe', arguments: {} })).rejects.toThrow();
        await expect(connect(ep.url, token)).rejects.toThrow();
      } finally { clock.mockRestore(); }
    } finally {
      await client.close();
      await ep.close();
    }
  });

  it('never treats scoped human or spectator tickets as agent/MCP authority', async () => {
    const ep = await startEndpoint();
    const scoped = ep.host.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: 'scoped_human_owner', kind: 'human' }] });
    try {
      for (const token of [scoped.mintHumanToken('blue', 'runner').token, scoped.mintSpectatorToken('blue').token]) {
        const response = await fetch(ep.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
        });
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain(token);
      }
    } finally {
      scoped.dispose();
      await ep.close();
    }
  });

  it('rejects foreign roles and never shares owner text, policy source or status resources across seats', async () => {
    const ep = await startEndpoint();
    const runner = await connect(ep.url, ep.match.mintSeatToken('blue', 'runner'));
    const guard = await connect(ep.url, ep.match.mintSeatToken('blue', 'guard'));
    const red = await connect(ep.url, ep.match.mintSeatToken('red', 'runner'));
    const privateText = 'PRIVATE_RUNNER_REASONING_SENTINEL';
    try {
      ep.match.tell('blue', ['runner'], privateText);
      for (const intruder of [guard, red]) {
        const wrongRole = intruder === guard ? 'runner' : 'guard';
        for (const name of ['game_observe', 'policy_status', 'game_act']) {
          const result = await intruder.callTool({ name, arguments: { role: wrongRole, ...(name === 'game_act' ? { intents: [{ kind: 'stop' }] } : {}) } });
          expect(json(result)).toEqual({ error: 'forbidden' });
          expect(JSON.stringify(result)).not.toContain(privateText);
        }
        const own = await intruder.callTool({ name: 'game_observe', arguments: {} });
        expect(JSON.stringify(own)).not.toContain(privateText);
        const uri = (await runner.listResources()).resources[0]!.uri;
        await expect(intruder.readResource({ uri })).rejects.toThrow();
      }
      const own = await runner.callTool({ name: 'game_observe', arguments: {} });
      expect(JSON.stringify(own)).toContain(privateText);
      const source = 'function think(){ /* PRIVATE_POLICY_SOURCE_SENTINEL */ return []; }';
      await runner.callTool({ name: 'policy_deploy', arguments: { runtime: 'js', code: source } });
      for (const intruder of [guard, red]) {
        expect(JSON.stringify(await intruder.callTool({ name: 'policy_status', arguments: {} }))).not.toContain('PRIVATE_POLICY_SOURCE_SENTINEL');
      }
    } finally {
      await runner.close();
      await guard.close();
      await red.close();
      await ep.close();
    }
  });
});
