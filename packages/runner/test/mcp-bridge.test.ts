import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY, LATEST_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY, type ElicitResult } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definition } from '../../playerthree/examples/tag/index.ts';
import { createPlayerThreeHost } from 'playerthree/host';
import type { PlayerThreeHost, PlayerThreeMatch } from 'playerthree/host';
import { createMcpRequestHandler } from 'playerthree/mcp';
import { connectSeat } from '../src/remote.ts';
import type { ChannelEvent } from '../src/channel.ts';

const BIN = fileURLToPath(new URL('../bin/playerthree-mcp.ts', import.meta.url));

let host: PlayerThreeHost;
let match: PlayerThreeMatch;
let server: Server;
let url: string;
let close: () => Promise<void>;
const channelRequests: { method: string; tool?: string; seconds?: number; version?: string; session?: string }[] = [];

beforeAll(async () => {
  host = createPlayerThreeHost({ definition });
  match = host.createMatch({ seed: 1, realtime: false, controllers: { blue: { runner: 'agent', guard: 'agent' } } });
  const handler = createMcpRequestHandler(host);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (!body) {
        if (req.method === 'DELETE') channelRequests.push({
          method: 'http:DELETE',
          ...(typeof req.headers['mcp-session-id'] === 'string' ? { session: req.headers['mcp-session-id'] } : {}),
        });
        return;
      }
      try {
        const request = JSON.parse(body);
        // Retain protocol metadata only: resource URIs and bearer credentials are not diagnostics.
        channelRequests.push({
          method: request.method,
          ...(typeof req.headers['mcp-protocol-version'] === 'string' ? { version: req.headers['mcp-protocol-version'] } : {}),
          ...(typeof req.headers['mcp-session-id'] === 'string' ? { session: req.headers['mcp-session-id'] } : {}),
          ...(request.method === 'tools/call' ? { tool: request.params?.name, seconds: request.params?.arguments?.seconds } : {}),
        });
      } catch { /* Non-JSON transport traffic is irrelevant to this assertion. */ }
    });
    void handler(req, res);
  });
  close = handler.close;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await close();
  await new Promise<void>((r) => server.close(() => r()));
  host.dispose();
});

async function bridgeClient(args: string[], elicit?: () => ElicitResult, onChannel?: (event: ChannelEvent) => void): Promise<Client> {
  const client = new Client(
    { name: 'local-harness', version: '1.0.0' },
    { capabilities: elicit ? { elicitation: { form: {} } } : {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  if (elicit) client.setRequestHandler('elicitation/create', async () => elicit());
  if (onChannel) client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== 'notifications/claude/channel') return;
    const params = notification.params;
    if (!params || typeof params.content !== 'string' || !params.meta || typeof params.meta !== 'object') throw new Error('Invalid channel event');
    const meta: Record<string, string> = {};
    for (const [key, value] of Object.entries(params.meta)) {
      if (typeof value !== 'string') throw new Error('Invalid channel metadata');
      meta[key] = value;
    }
    onChannel({ content: params.content, meta });
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, ...args], stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  try {
    await client.connect(transport);
    // Discovery is side-effect-free; subscribing clients acquire the bridge through listing, not a kickoff tool.
    if (onChannel) await client.listTools();
  } catch (e) {
    throw new Error(`bridge did not start: ${String(e)}\n${stderr}`);
  }
  return client;
}

function run(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  // Acquiring credentials is intentionally deferred until a real local request, not process startup.
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/list',
    params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_INFO_META_KEY]: { name: 'cli-harness', version: '1.0.0' }, [CLIENT_CAPABILITIES_META_KEY]: {} } },
  })}\n`);
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; stderr: string }>();
  child.on('exit', (code) => resolve({ code, stderr }));
  return promise;
}

/** Sends one raw 2025-era `initialize` to a fresh bridge and returns its reply. */
async function handshake(args: string[], protocolVersion: string): Promise<{ id: number; result: { protocolVersion: string; instructions: string } }> {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-2025-client', version: '1.0.0' } },
  })}\n`);
  let out = '';
  const { promise, resolve, reject } = Promise.withResolvers<{ id: number; result: { protocolVersion: string; instructions: string } }>();
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString();
    const line = out.split('\n').find((l) => l.trim() !== '');
    if (line && out.includes('\n')) resolve(JSON.parse(line));
  });
  child.on('exit', (code) => reject(new Error(`bridge exited ${code} before answering initialize`)));
  try {
    return await promise;
  } finally {
    child.kill();
  }
}

// Each test spawns real bridge processes; allow for a loaded machine.
describe('playerthree-mcp stdio bridge', { timeout: 30_000 }, () => {
  it('forwards tools, calls and verified skills from the remote endpoint', async () => {
    const remote = await createRemoteListing();
    const client = await bridgeClient(['--url', url, '--token', match.mintSeatToken('blue', 'runner')]);
    const { tools } = await client.listTools();
    expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toBeUndefined();
    expect(tools.map((t) => t.name)).toEqual(remote);
    const r = await client.callTool({ name: 'game_observe', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { observation: { team: string } }).observation.team).toBe('blue');
    const act = await client.callTool({ name: 'game_act', arguments: { intents: [{ kind: 'dash' }] } });
    expect((act.structuredContent as { acks: unknown[] }).acks).toEqual([{ ok: true }]);
    const { skills } = await new SkillsClient(client).list();
    expect(skills.map((s) => s.frontmatter.name).sort()).toEqual(['playerthree-commander', 'playerthree-inputs', 'playerthree-owner', 'playerthree-policy-author', 'tag-reference', 'tag-strategy']);
    await client.close();
  });

  it('serves disposable modern discovery without consuming a seat and acquires exactly once for real requests', async () => {
    const start = channelRequests.length;
    const client = await bridgeClient(['--url', url, '--token', match.mintSeatToken('blue', 'runner')], undefined);
    try {
      expect(channelRequests.slice(start)).toEqual([]);
      expect(client.getInstructions()).toContain('Call game_briefing before acting');
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      const result = await client.callTool({ name: 'game_briefing', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ surfaceHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(channelRequests.slice(start).some((request) => request.method === 'initialize')).toBe(false);
      expect((await new SkillsClient(client).list()).skills.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('preserves owner messages beside observations without a channel or discovery-time inbox drains', async () => {
    const owner = 'bridge_envelope_owner';
    host.commanders.ensure(owner);
    const commander = host.commanders.create(owner, { name: 'Envelope runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const live = host.createMatch({ seed: 13, realtime: false, assignments: [{ team: 'blue', role: 'runner', owner, kind: 'agent', commander: { id: commander } }] });
    const client = await bridgeClient(['--url', url, '--token', host.commanders.token(owner, commander)]);
    try {
      const waitText = 'Keep the owner dispatch outside the observation summary.';
      live.tell('blue', ['runner'], waitText);
      await client.listTools();
      await new SkillsClient(client).list();
      await client.callTool({ name: 'game_briefing', arguments: { role: 'runner' } });
      await client.callTool({ name: 'policy_status', arguments: { role: 'runner' } });
      const waited = await client.callTool({ name: 'game_wait', arguments: { role: 'runner', seconds: 0 } });
      expect(waited.isError).toBeFalsy();
      expect(waited.structuredContent).toMatchObject({
        messages: [{ from: 'owner', text: waitText }],
      });
      expect(waited.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')).toContain(waitText);
      const afterWait = await client.callTool({ name: 'game_observe', arguments: { role: 'runner', fields: ['tick'] } });
      expect(afterWait.structuredContent).toMatchObject({ observation: { tick: 0 } });
      expect(JSON.stringify(afterWait)).not.toContain(waitText);

      const observeText = 'Keep messages even when requesting only the tick field.';
      live.tell('blue', ['runner'], observeText);
      const observed = await client.callTool({ name: 'game_observe', arguments: { role: 'runner', fields: ['tick'] } });
      expect(observed.isError).toBeFalsy();
      expect(observed.structuredContent).toMatchObject({
        observation: { tick: 0 },
        messages: [{ from: 'owner', text: observeText }],
      });
      expect(observed.structuredContent).not.toHaveProperty(['observation', 'messages']);
      expect(observed.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')).toContain(observeText);
    } finally {
      await client.close();
      live.dispose();
    }
  });

  it('negotiates the default temporary seat path and retains its bound session without allowing another bridge to replay it', async () => {
    const token = match.mintSeatToken('blue', 'runner');
    const start = channelRequests.length;
    const client = await bridgeClient(['--url', url, '--token', token]);
    try {
      await client.callTool({ name: 'game_observe', arguments: {} });
      await client.callTool({ name: 'policy_status', arguments: {} });
      const requests = channelRequests.slice(start);
      expect(requests[0]).toMatchObject({ method: 'server/discover', version: '2026-07-28' });
      expect(requests.some((request) => request.method === 'initialize')).toBe(false);
      const session = requests.find((request) => request.session !== undefined)?.session;
      expect(session).toBeTruthy();
      expect(requests.filter((request) => request.session !== undefined)
        .every((request) => request.session === session && request.version === '2026-07-28')).toBe(true);
      const duplicate = await run(['--url', url, '--token', token]);
      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toContain('rejected the token');
      expect((await client.callTool({ name: 'game_observe', arguments: {} })).isError).toBeFalsy();
    } finally {
      await client.close();
    }
    const requests = channelRequests.slice(start);
    const session = requests.find((request) => request.session !== undefined)?.session;
    expect(requests.find((request) => request.method === 'http:DELETE')).toMatchObject({ session });
    const replay = await run(['--url', url, '--token', token]);
    expect(replay.code).toBe(1);
    expect(replay.stderr).toContain('rejected the token');
  });

  it('passes the consent prompt through to a current-revision local client', async () => {
      let prompts = 0;
      const token = match.mintSeatToken('blue', 'guard');
      const client = await bridgeClient(
        ['--url', url, '--token', token],
        () => {
          prompts += 1;
          return { action: 'accept', content: { allow: true } };
        },
      );
      const r = await client.callTool({ name: 'policy_status', arguments: {} });
      expect(r.isError).toBeFalsy();
      await client.callTool({ name: 'policy_status', arguments: {} });
      expect(prompts).toBe(1);
      await client.close();
  });

  it('negotiates a 2025-era initialize per the MCP rule without acquiring the remote', async () => {
    const start = channelRequests.length;
    // The client's revision when supported (OpenCode 1.19.5 opens with 2025-11-25), else the latest supported one.
    for (const [requested, answered] of [['2025-11-25', '2025-11-25'], ['2025-06-18', '2025-06-18'], ['2099-01-01', LATEST_PROTOCOL_VERSION]]) {
      const reply = await handshake(['--url', url, '--token', match.mintSeatToken('blue', 'runner')], requested!);
      expect(reply).toMatchObject({ jsonrpc: '2.0', id: 0, result: { protocolVersion: answered, serverInfo: { name: 'playerthree-mcp' } } });
      expect(reply.result.instructions).toContain('Call game_briefing before acting');
    }
    expect(channelRequests.slice(start)).toEqual([]);
  });

  it('serves a 2025-11-25 client: tools, calls, skills and the consent prompt as elicitation', async () => {
    let prompts = 0;
    const remote = await createRemoteListing();
    const client = new Client({ name: 'legacy-harness', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'legacy' } });
    client.setRequestHandler('elicitation/create', async () => {
      prompts += 1;
      return { action: 'accept', content: { allow: true } };
    });
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, '--url', url, '--token', match.mintSeatToken('blue', 'guard')], stderr: 'pipe' });
    await client.connect(transport);
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(remote);
      const observed = await client.callTool({ name: 'game_observe', arguments: {} });
      expect(observed.structuredContent).toMatchObject({ observation: { team: 'blue' } });
      expect((await client.callTool({ name: 'policy_status', arguments: {} })).isError).toBeFalsy();
      await client.callTool({ name: 'policy_status', arguments: {} });
      expect(prompts).toBe(1);
      expect((await new SkillsClient(client).list()).skills.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('starts when --expect-hash matches the remote surfaceHash', async () => {
    const token = match.mintSeatToken('blue', 'runner');
    const probe = await bridgeClient(['--url', url, '--token', token]);
    const hash = ((await probe.callTool({ name: 'game_briefing', arguments: {} })).structuredContent as { surfaceHash: string }).surfaceHash;
    await probe.close();
    const pinned = await bridgeClient(['--url', url, '--token', match.mintSeatToken('blue', 'runner'), '--expect-hash', hash]);
    expect((await pinned.listTools()).tools.length).toBeGreaterThan(0);
    await pinned.close();
  });

  it('refuses to start when the remote surfaceHash differs from --expect-hash', async () => {
    const { code, stderr } = await run(['--url', url, '--token', match.mintSeatToken('blue', 'runner'), '--expect-hash', '0'.repeat(64)]);
    expect(code, stderr).toBe(2);
    expect(stderr).toMatch(/differs from --expect-hash 0{64}; refusing to start/);
  });

  it('refuses to start with a token the endpoint does not accept', async () => {
    // base64url tokens may start with '-': `--token -…` must still parse as the token.
    for (const token of ['B'.repeat(32), `-${'B'.repeat(31)}`]) {
      const { code, stderr } = await run(['--url', url, '--token', token]);
      expect(code, stderr).toBe(1);
      expect(stderr).toMatch(/rejected the token/);
    }
  });

  it('uses resource listen to push lifecycle and owner wakes without a kickoff tool call', async () => {
    const owner = 'channel_owner_00000000000000';
    host.commanders.ensure(owner);
    const commander = host.commanders.create(owner, { name: 'Channel runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    host.commanders.update(owner, commander, { mandate: { autonomy: 'supervised' } });
    const events: ChannelEvent[] = [];
    const requestStart = channelRequests.length;
    const client = await bridgeClient(['--url', url, '--token', host.commanders.token(owner, commander), '--channel'], undefined, (e) => events.push(e));
    let live: PlayerThreeMatch | undefined;
    try {
      expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toEqual({});
      host.commanders.tell(owner, [commander], 'Defend our flag.');
      await expect.poll(() => events.find((e) => e.meta.event === 'owner_message')).toMatchObject({
        content: 'From owner:\nDefend our flag.', meta: { from: 'owner', role: 'runner' },
      });
      const proposal = await client.callTool({ name: 'policy_deploy', arguments: { runtime: 'js', code: 'function think() { return []; }' } });
      const proposalBody = proposal.structuredContent;
      expect(proposal.isError).toBeFalsy();
      if (!proposalBody || typeof proposalBody !== 'object' || !('approval' in proposalBody) || !proposalBody.approval || typeof proposalBody.approval !== 'object' || !('id' in proposalBody.approval) || typeof proposalBody.approval.id !== 'string') throw new Error('Expected approval request');
      const approvalId = proposalBody.approval.id;
      await host.commanders.resolveApproval(owner, commander, approvalId, false);
      await expect.poll(() => events.find((e) => e.meta.event === 'approval_resolved')).toMatchObject({
        meta: { event: 'approval_resolved', status: 'rejected', kind: 'policyDeploy' },
      });
      live = host.createMatch({ seed: 11, realtime: false, assignments: [{ team: 'blue', role: 'runner', owner, kind: 'agent', commander: { id: commander } }] });
      await expect.poll(() => events.find((e) => e.meta.event === 'seated')).toMatchObject({ meta: { role: 'runner', phase: 'match' } });
      await live.step(4000);
      await expect.poll(() => events.find((e) => e.meta.event === 'match_ended')).toMatchObject({ meta: { outcome: live.outcome('blue') } });
      expect(events.filter((e) => e.meta.event === 'seated')).toHaveLength(1);
      for (const event of events) for (const key of Object.keys(event.meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
      const requests = channelRequests.slice(requestStart);
      expect(requests.some((request) => request.method === 'subscriptions/listen')).toBe(true);
      expect(requests.some((request) => request.method === 'resources/read')).toBe(true);
      expect(requests.filter((request) => request.tool === 'game_wait').every((request) => request.seconds === 0)).toBe(true);
    } finally {
      await client.close();
      live?.dispose();
    }
  });
});

async function createRemoteListing(): Promise<string[]> {
  const seat = await connectSeat({ url, token: match.mintSeatToken('red', 'runner') });
  const names = seat.tools.map((t) => t.name);
  await seat.close();
  return names;
}
