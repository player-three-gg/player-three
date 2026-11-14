import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { definition } from '../../playerthree/examples/tag/index.ts';
import { createPlayerThreeHost, type PlayerThreeHost, type PlayerThreeMatch } from 'playerthree/host';
import { createAuthorizationServer, createMcpRequestHandler, type AuthorizationServer, type McpRequestHandler } from 'playerthree/mcp';
import { connectSeat, MCP_PROTOCOL_VERSION, type RemoteSeat } from '../src/remote.ts';
import { connectClient } from '../src/oauth.ts';

interface WireRequest {
  http: string;
  method?: string;
  version?: string;
  session?: string;
  issuedSession?: string;
  status?: number;
}

let host: PlayerThreeHost;
let match: PlayerThreeMatch;
let server: Server;
let base: string;
let auth: AuthorizationServer;
let handler: McpRequestHandler;
let offer: string[] | undefined;
let deleteStatus: number | undefined;
const wire: WireRequest[] = [];
const seats: RemoteSeat[] = [];

beforeEach(async () => {
  wire.length = 0;
  offer = undefined;
  deleteStatus = undefined;
  host = createPlayerThreeHost({ definition });
  match = host.createMatch({ seed: 7, realtime: false, controllers: { blue: { runner: 'agent', guard: 'agent' } } });
  server = createServer((req, res) => {
    const request: WireRequest = {
      http: req.method ?? '',
      ...(typeof req.headers['mcp-protocol-version'] === 'string' ? { version: req.headers['mcp-protocol-version'] } : {}),
      ...(typeof req.headers['mcp-session-id'] === 'string' ? { session: req.headers['mcp-session-id'] } : {}),
    };
    wire.push(request);
    // writeHead's direct header argument is not cached by ServerResponse.getHeader().
    // Observe the actual emitted response header instead of inferring it from later requests.
    res.writeHead = new Proxy(res.writeHead, {
      apply(writeHead, response, args) {
        request.status = args[0];
        const headers = typeof args[1] === 'string' ? args[2] : args[1];
        if (headers && !Array.isArray(headers)) {
          const issued = Object.entries(headers).find(([name]) => name.toLowerCase() === 'mcp-session-id')?.[1];
          if (typeof issued === 'string') request.issuedSession = issued;
        }
        const cached = res.getHeader('mcp-session-id');
        if (typeof cached === 'string') request.issuedSession = cached;
        return Reflect.apply(writeHead, response, args);
      },
    });
    // Retain only protocol metadata, never bearer credentials, resource URIs, or request arguments.
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (!body) return;
      const parsed = JSON.parse(body) as { method?: string; params?: { protocolVersion?: string } };
      request.method = parsed.method;
      if (parsed.method === 'initialize') request.version = parsed.params?.protocolVersion;
    });
    if (req.method === 'DELETE' && deleteStatus !== undefined) {
      res.writeHead(deleteStatus).end();
      return;
    }
    if (offer !== undefined && req.method === 'POST' && req.headers['mcp-protocol-version'] === MCP_PROTOCOL_VERSION) {
      let probe = '';
      req.on('data', (chunk: Buffer) => { probe += chunk.toString(); });
      req.on('end', () => {
        const parsed = JSON.parse(probe) as { id: string | number };
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: parsed.id,
          error: { code: -32022, message: 'Unsupported protocol version', data: { supported: offer, requested: MCP_PROTOCOL_VERSION } },
        }));
      });
      return;
    }
    void handler(req, res);
  });
  const ready = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', ready.resolve);
  await ready.promise;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  auth = createAuthorizationServer(host, { issuer: base, consentUrl: (id) => `/consent?r=${id}` });
  handler = createMcpRequestHandler(host, { auth });
});

afterEach(async () => {
  for (const seat of seats.splice(0)) await seat.close().catch(() => {});
  await handler.close();
  await auth.close();
  server.closeAllConnections();
  const stopped = Promise.withResolvers<void>();
  server.close(() => stopped.resolve());
  await stopped.promise;
  host.dispose();
});

async function connect(token: string): Promise<RemoteSeat> {
  const seat = await connectSeat({ url: `${base}/mcp`, token });
  seats.push(seat);
  return seat;
}

describe('default remote protocol negotiation', () => {
  it('discovers the current revision, binds the first real request, retains its seat lease, rejects replay, and revokes on close', async () => {
    const token = match.mintSeatToken('blue', 'runner');
    const seat = await connect(token);
    await seat.briefing();
    await seat.observe();
    expect(wire[0]).toMatchObject({ http: 'POST', method: 'server/discover', version: MCP_PROTOCOL_VERSION });
    expect(wire[0]!.issuedSession).toBeUndefined();
    const binding = wire.find((request) => request.method === 'tools/list');
    expect(binding).toMatchObject({ version: MCP_PROTOCOL_VERSION, issuedSession: expect.any(String) });
    const session = binding!.issuedSession;
    expect(wire.some((request) => request.method === 'initialize' || request.method === 'notifications/initialized')).toBe(false);
    expect(wire.slice(wire.indexOf(binding!) + 1)
      .every((request) => request.session === session && request.version === MCP_PROTOCOL_VERSION)).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    await expect(seat.call('game_observe', {}, { signal: aborted.signal })).rejects.toMatchObject({ code: 'transport' });
    await expect(seat.observe()).resolves.toBeDefined();
    expect(wire.filter((request) => request.session === undefined && request.issuedSession !== undefined)).toHaveLength(1);

    await expect(connect(token)).rejects.toMatchObject({ code: 'bad_token' });
    // Denying another client must not disturb the first client's lease.
    await expect(seat.observe()).resolves.toBeDefined();
    await seat.close();
    expect(wire.find((request) => request.http === 'DELETE')).toMatchObject({ session, version: MCP_PROTOCOL_VERSION });
    await expect(connect(token)).rejects.toMatchObject({ code: 'bad_token' });
  });

  it('closes an already-revoked session idempotently after exact-seat revoke, without replaying its bearer', async () => {
    const token = match.mintSeatToken('blue', 'runner');
    const seat = await connect(token);
    const other = await connect(match.mintSeatToken('blue', 'guard'));
    await other.briefing();
    const session = wire.find((request) => request.method === 'tools/list')?.issuedSession;
    expect(session).toBeTruthy();
    const bound = wire.filter((request) => request.session === undefined && request.issuedSession !== undefined).length;
    match.revokeSeat('blue', 'runner');

    await expect(seat.close()).resolves.toBeUndefined();
    await expect(seat.close()).resolves.toBeUndefined();
    expect(wire.filter((request) => request.http === 'DELETE' && request.session === session))
      .toEqual([{ http: 'DELETE', session, version: MCP_PROTOCOL_VERSION, status: 401 }]);
    await expect(seat.observe()).rejects.toMatchObject({ code: 'transport' });
    await expect(connect(token)).rejects.toMatchObject({ code: 'bad_token' });
    expect(wire.filter((request) => request.session === undefined && request.issuedSession !== undefined)).toHaveLength(bound);
    await expect(other.observe()).resolves.toBeDefined();
  });

  it('keeps a claimed session readable after match end, then closes it once, without replaying its bearer', async () => {
    const token = match.mintSeatToken('blue', 'runner');
    const seat = await connect(token);
    const other = await connect(match.mintSeatToken('blue', 'guard'));
    await other.briefing();
    const session = wire.find((request) => request.method === 'tools/list')?.issuedSession;
    expect(session).toBeTruthy();
    const bound = wire.filter((request) => request.session === undefined && request.issuedSession !== undefined).length;
    match.end('draw');

    // Terminal delivery (docs/MCP.md): an already-claimed one-match lease reads its final observation until disposal,
    // expiry or close, so the close is an ordinary session deletion rather than a revoked one.
    await expect(seat.observe()).resolves.toBeDefined();
    await expect(seat.close()).resolves.toBeUndefined();
    await expect(seat.close()).resolves.toBeUndefined();
    expect(wire.filter((request) => request.http === 'DELETE' && request.session === session))
      .toEqual([{ http: 'DELETE', session, version: MCP_PROTOCOL_VERSION, status: 204 }]);
    await expect(seat.observe()).rejects.toMatchObject({ code: 'transport' });
    // Closing released the lease: a fresh claim after the end is rejected.
    await expect(connect(token)).rejects.toMatchObject({ code: 'bad_token' });
    expect(wire.filter((request) => request.session === undefined && request.issuedSession !== undefined)).toHaveLength(bound);
    await expect(other.close()).resolves.toBeUndefined();
  });

  for (const status of [403, 404, 410]) {
    it(`accepts explicit session deletion HTTP ${status} only during teardown`, async () => {
      const seat = await connect(match.mintSeatToken('blue', 'runner'));
      await seat.briefing();
      match.revokeSeat('blue', 'runner');
      // Exercise other terminal HTTP responses over the real connection to a revoked host lease.
      deleteStatus = status;
      await expect(seat.close()).resolves.toBeUndefined();
      await expect(seat.close()).resolves.toBeUndefined();
      expect(wire.filter((request) => request.http === 'DELETE')).toHaveLength(1);
      expect(wire.find((request) => request.http === 'DELETE')).toMatchObject({ status });
      expect(wire.filter((request) => request.session === undefined && request.issuedSession !== undefined)).toHaveLength(1);
    });
  }

  for (const status of [409, 503]) {
    it(`preserves nonterminal deletion HTTP ${status} while still closing the local transport`, async () => {
      const client = await connectClient(new URL(`${base}/mcp`), { token: match.mintSeatToken('blue', 'runner') }, () => new Client(
        { name: 'close-harness', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
      ));
      try {
        await client.listTools();
        expect(client.transport?.sessionId).toBeTruthy();
        deleteStatus = status;
        await expect(client.close()).rejects.toMatchObject({ name: 'SdkHttpError', status });
        expect(client.transport).toBeUndefined();
        await expect(client.close()).rejects.toMatchObject({ name: 'SdkHttpError', status });
        expect(wire.filter((request) => request.http === 'DELETE')).toHaveLength(1);
        expect(wire.filter((request) => request.session === undefined && request.issuedSession !== undefined)).toHaveLength(1);
      } finally {
        await client.close().catch(() => {});
      }
    });
  }

  it('rejects an unsupported revision without retrying or claiming a seat', async () => {
    offer = ['2025-11-25'];
    await expect(connect(match.mintSeatToken('blue', 'runner'))).rejects.toMatchObject({ code: 'protocol' });
    expect(wire.map((request) => request.method)).toEqual(['server/discover']);
    expect(wire.every((request) => request.issuedSession === undefined)).toBe(true);
  });

  it('rejects an empty discovery offer without a fallback request', async () => {
    offer = [];
    await expect(connect(match.mintSeatToken('blue', 'runner'))).rejects.toMatchObject({ code: 'transport' });
    expect(wire.map((request) => request.method)).toEqual(['server/discover']);
  });

  it('keeps persistent commander credentials modern and reusable across independent clients', async () => {
    host.commanders.ensure('negotiation_owner');
    const commander = host.commanders.create('negotiation_owner', { name: 'Negotiator', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const token = host.commanders.token('negotiation_owner', commander);
    const first = await connect(token);
    const second = await connect(token);
    await first.briefing();
    await second.briefing();
    await first.close();
    await expect(second.briefing()).resolves.toBeDefined();
    expect(wire.some((request) => request.method === 'initialize' || request.http === 'DELETE')).toBe(false);
    expect(wire.every((request) => request.version === MCP_PROTOCOL_VERSION && request.session === undefined)).toBe(true);
  });

  it('keeps a real OAuth access token on modern stateless MCP, without a seat lease or downgrade', async () => {
    const owner = 'negotiation_oauth_owner';
    host.commanders.ensure(owner);
    const commander = host.commanders.create(owner, { name: 'Negotiator', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const redirect = 'http://127.0.0.1:4444/callback';
    const registered = await auth.fetch(new Request(`${base}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Negotiation Harness', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
    }));
    expect(registered?.status).toBe(201);
    const { client_id: client } = await registered!.json() as { client_id: string };
    const verifier = 'v'.repeat(64);
    const params = new URLSearchParams({
      response_type: 'code', client_id: client, redirect_uri: redirect, state: 'negotiation',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${base}/mcp`,
    });
    const authorize = await auth.fetch(new Request(`${base}/oauth/authorize?${params}`));
    expect(authorize?.status).toBe(302);
    const consentId = new URL(authorize!.headers.get('location')!, base).searchParams.get('r')!;
    const callback = new URL(auth.resolveConsent(consentId, { owner, commander, roles: ['runner'], approve: true }).redirect);
    const redeemed = await auth.fetch(new Request(`${base}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code')!, client_id: client, redirect_uri: redirect, code_verifier: verifier, resource: `${base}/mcp` }),
    }));
    expect(redeemed?.status).toBe(200);
    const { access_token: access } = await redeemed!.json() as { access_token: string };
    const first = await connect(access);
    await first.briefing();
    await first.close();
    const second = await connect(access);
    await expect(second.briefing()).resolves.toBeDefined();
    expect(wire.some((request) => request.method === 'initialize' || request.http === 'DELETE')).toBe(false);
    expect(wire.every((request) => request.version === MCP_PROTOCOL_VERSION && request.session === undefined)).toBe(true);
  });
});
