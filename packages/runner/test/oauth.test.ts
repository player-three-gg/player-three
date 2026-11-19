import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { definition, type TagManifest } from '../../playerthree/examples/tag/index.ts';
import { createPlayerThreeHost } from 'playerthree/host';
import type { PlayerThreeHost } from 'playerthree/host';
import { createAuthorizationServer, fetchClientDocument, mountMcp, redirectMatches, type AuthorizationServer } from 'playerthree/mcp';
import { browserSignIn } from '../src/oauth.ts';
import { connectSeat, type RemoteSeat } from '../src/remote.ts';

const ALICE = 'alice_owner_0001';
const BOB = 'bob_owner_000002';
const REDIRECT = 'http://127.0.0.1:4444/cb';

let host: PlayerThreeHost<TagManifest>;
let server: Server;
let base: string;
let auth: AuthorizationServer;
let aliceCommander: string;
let bobCommander: string;
const closers: (() => unknown)[] = [];

async function listen(handler: RequestListener): Promise<{ server: Server; base: string }> {
  const s = createServer(handler);
  const ready = Promise.withResolvers<void>();
  s.listen(0, '127.0.0.1', () => ready.resolve());
  await ready.promise;
  closers.push(() => {
    s.closeAllConnections();
    s.close();
  });
  return { server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

async function startHost(extra: { allowLoopbackClients?: boolean } = {}): Promise<void> {
  host = createPlayerThreeHost({ definition });
  host.commanders.ensure(ALICE);
  aliceCommander = host.commanders.create(ALICE, { name: 'Alice', kind: 'agent', roles: ['runner', 'guard'], isolation: { independentSessions: true } }).id;
  host.commanders.ensure(BOB);
  bobCommander = host.commanders.create(BOB, { name: 'Bob', kind: 'agent', roles: ['runner', 'guard'], isolation: { independentSessions: true } }).id;
  ({ server, base } = await listen((_req, res) => res.writeHead(404).end()));
  auth = createAuthorizationServer(host, { issuer: base, consentUrl: (r) => `/connect?r=${r}`, ...extra });
  const mounted = mountMcp(server, host, { auth });
  closers.push(() => mounted.close(), () => auth.close(), () => host.dispose());
}

beforeEach(async () => {
  await startHost();
});

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(redirectUris: string[] = [REDIRECT], extra: Record<string, unknown> = {}, name = 'Test Harness'): Promise<Response> {
  return fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris, ...extra }),
  });
}

async function clientId(redirectUris?: string[], name?: string): Promise<string> {
  const r = await register(redirectUris, {}, name);
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

function authorizeUrl(params: Record<string, string | undefined>): string {
  const u = new URL(`${base}/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

const authorize = (params: Record<string, string | undefined>) => fetch(authorizeUrl(params), { redirect: 'manual' });

/** The browser half: follow /oauth/authorize to the consent page and answer as the game would. */
async function consent(location: string | null, roles: string[], owner = ALICE, approve = true): Promise<URL> {
  const r = new URL(location!, base).searchParams.get('r')!;
  expect(auth.consentRequest(r)).toBeDefined();
  return new URL(auth.resolveConsent(r, { owner, commander: owner === ALICE ? aliceCommander : bobCommander, roles, approve }).redirect);
}

async function token(params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

interface Grant {
  client: string;
  access: string;
  refresh: string;
  code: string;
  verifier: string;
}

async function grant(roles: string[], owner = ALICE, harness?: string): Promise<Grant> {
  const client = await clientId(undefined, harness);
  const { verifier, challenge } = pkce();
  const a = await authorize({ response_type: 'code', client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource: `${base}/mcp` });
  expect(a.status).toBe(302);
  const back = await consent(a.headers.get('location'), roles, owner);
  expect(back.searchParams.get('state')).toBe('s1');
  expect(back.searchParams.get('iss')).toBe(base);
  const code = back.searchParams.get('code')!;
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier, resource: `${base}/mcp` });
  expect(t.status).toBe(200);
  expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'play' });
  return { client, access: t.body['access_token'] as string, refresh: t.body['refresh_token'] as string, code, verifier };
}

/** Status of a bare current-revision (2026-07-28) MCP request with this bearer token (401 = not authenticated). */
async function mcpStatus(bearer: string | undefined): Promise<{ status: number; challenge: string | null }> {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_INFO_META_KEY]: { name: 'oauth-test', version: '1' }, [CLIENT_CAPABILITIES_META_KEY]: {} } } }),
  });
  await r.body?.cancel();
  return { status: r.status, challenge: r.headers.get('www-authenticate') };
}

async function seat(access: string): Promise<RemoteSeat> {
  const s = await connectSeat({ url: `${base}/mcp`, token: access });
  closers.push(() => s.close());
  return s;
}

const errorOf = (text: string) => (JSON.parse(text.split('\n')[0]!) as { error?: string; path?: unknown[] });

describe('discovery', () => {
  it('401 points at the protected resource metadata; metadata advertises PKCE S256, CIMD, DCR and RFC 9207 iss', async () => {
    const none = await mcpStatus(undefined);
    expect(none.status).toBe(401);
    expect(none.challenge).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="play"`);
    expect((await mcpStatus(`playerthree_at_${'A'.repeat(43)}`)).challenge).toMatch(/^Bearer error="invalid_token", resource_metadata="/);

    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      expect(await (await fetch(`${base}${path}`)).json()).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['play'] });
    }
    const m = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(m).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe('authorization code flow', () => {
  it('rejects unsupported scopes, confidential registration and malformed client authentication', async () => {
    expect((await register([REDIRECT], { token_endpoint_auth_method: 'client_secret_basic' })).status).toBe(400);
    const client = await clientId();
    const { challenge } = pkce();
    const response = await authorize({ response_type: 'code', client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'admin' });
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
    const malformed = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from('%:').toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'invalid' }),
    });
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toEqual({ error: 'invalid_client' });
    expect(() => createAuthorizationServer(host, { issuer: 'https://secret@game.example', consentUrl: () => '/connect' })).toThrow(TypeError);
  });

  it('SDK sign-in (DCR, PKCE, iss, loopback redirect): one named commander controls its compatible same-side roles with isolated execution lanes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'playerthree-oauth-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const urls: string[] = [];
    const signIn = await browserSignIn({
      url: `${base}/mcp`,
      clientName: 'playerthree-run',
      softwareId: 'dev.playerthree.runner',
      cacheFile: join(dir, 'oauth.json'),
      openBrowser: false,
      log: (line) => {
        const m = /(http\S+)/.exec(line);
        if (!m) return;
        urls.push(m[1]!);
        // The "browser": authorize → consent page → approve → loopback callback.
        void (async () => {
          const a = await fetch(m[1]!, { redirect: 'manual' });
          const back = await consent(a.headers.get('location'), ['runner', 'guard']);
          await fetch(back);
        })();
      },
    });
    closers.push(() => signIn.close());
    const s = await connectSeat({ url: `${base}/mcp`, signIn });
    closers.push(() => s.close());
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get('code_challenge_method')).toBe('S256');
    expect(statSync(join(dir, 'oauth.json')).mode & 0o777).toBe(0o600);

    const [conn] = auth.connections(ALICE);
    expect(conn).toMatchObject({ client: { registration: 'dcr', name: 'playerthree-run', softwareId: 'dev.playerthree.runner' }, roles: ['runner', 'guard'], active: true });

    const lobby = await s.call('game_briefing', {});
    expect(lobby.structured).toMatchObject({ phase: 'lobby', seat: { role: 'runner' }, commands: [{ role: 'runner', phase: 'lobby' }, { role: 'guard', phase: 'lobby' }] });
    const guardBriefing = await s.call('game_briefing', { role: 'guard' });
    expect(guardBriefing.structured).toMatchObject({ seat: { role: 'guard' } });
    // More than one role: seat tools need `role`.
    const missing = await s.call('game_wait', { seconds: 0 });
    expect(missing.isError).toBe(true);
    expect(errorOf(missing.text)).toEqual({ error: 'invalid', schemaCode: 'missing_field', path: ['role'] });
    expect(errorOf((await s.call('game_act', { role: 'runner', intents: [{ kind: 'stop' }] })).text).error).toBe('not_in_match');

    const match = host.createMatch({ assignments: [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: aliceCommander } },
      { team: 'blue', role: 'guard', owner: ALICE, kind: 'agent', commander: { id: aliceCommander } },
    ] });
    const seated = await s.call('game_briefing', { role: 'guard' });
    expect(seated.structured).toMatchObject({ phase: 'match', seat: { team: 'blue', role: 'guard' }, commands: [{ role: 'runner', phase: 'match', team: 'blue' }, { role: 'guard', phase: 'match', team: 'blue' }] });
    const runner = await s.call('game_act', { role: 'runner', intents: [{ kind: 'dash' }] });
    const guard = await s.call('game_act', { role: 'guard', intents: [{ kind: 'move', x: 3, y: 3 }] });
    expect(runner.structured).toEqual({ acks: [{ ok: true }] });
    expect(guard.structured).toEqual({ acks: [{ ok: true }] });
    // Compatible assignment does not bypass the held role's game authority.
    const wrongRole = await s.call('game_act', { role: 'guard', intents: [{ kind: 'dash' }] });
    expect(wrongRole.structured).toEqual({ acks: [{ ok: false, code: 'forbidden_role' }] });
    await match.step(1);
    expect(match.seats().filter((x) => x.team === 'blue').map((x) => [x.role, x.controller])).toEqual([['runner', 'agent'], ['guard', 'agent']]);
  });

  it('PKCE: S256 is required and a wrong verifier burns the code', async () => {
    const client = await clientId();
    const { verifier, challenge } = pkce();
    const plain = await authorize({ response_type: 'code', client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'plain', state: 'x' });
    expect(Object.fromEntries(new URL(plain.headers.get('location')!).searchParams)).toEqual({ error: 'invalid_request', state: 'x', iss: base });
    const noPkce = await authorize({ response_type: 'code', client_id: client, redirect_uri: REDIRECT });
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

    const a = await authorize({ response_type: 'code', client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    const code = (await consent(a.headers.get('location'), ['runner'])).searchParams.get('code')!;
    const wrong = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client, code_verifier: pkce().verifier });
    expect(wrong).toEqual({ status: 400, body: { error: 'invalid_grant' } });
    expect((await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier })).body).toEqual({ error: 'invalid_grant' });
    expect(auth.connections(ALICE)).toEqual([]);
  });

  it('redirect URIs: exact match (loopback port free per RFC 8252); unregistered ones are never redirected to', async () => {
    const client = await clientId();
    const { verifier, challenge } = pkce();
    const evil = await authorize({ response_type: 'code', client_id: client, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(evil.status).toBe(400);
    expect(evil.headers.get('location')).toBeNull();
    expect(await evil.text()).not.toContain('evil');
    const otherPath = await authorize({ response_type: 'code', client_id: client, redirect_uri: 'http://127.0.0.1:4444/other', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(otherPath.status).toBe(400);
    const unknownClient = await authorize({ response_type: 'code', client_id: 'dcr_nope', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    expect(unknownClient.status).toBe(400);

    // Another ephemeral port on the same loopback host and path is the same redirect URI.
    const port = await authorize({ response_type: 'code', client_id: client, redirect_uri: 'http://127.0.0.1:5555/cb', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(port.status).toBe(302);
    const code = (await consent(port.headers.get('location'), ['runner'])).searchParams.get('code')!;
    // The token request must repeat the exact redirect URI of the authorization request.
    expect((await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier })).body).toEqual({ error: 'invalid_grant' });

    expect(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:3118/callback')).toBe(true);
    expect(redirectMatches('http://localhost/callback', 'http://localhost:3118/callback')).toBe(true);
    expect(redirectMatches('http://localhost/callback', 'http://127.0.0.1:3118/callback')).toBe(false);
    expect(redirectMatches('https://app.example/cb', 'https://app.example:8443/cb')).toBe(false);
    expect(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:3118/callback?x=1')).toBe(false);

    // Registration only accepts https or loopback redirect URIs.
    expect((await register(['http://evil.example/cb'])).status).toBe(400);
    expect((await register(['https://app.example/cb#frag'])).status).toBe(400);
  });

  it('a declined consent returns access_denied with state and iss; consent requests are single use', async () => {
    const client = await clientId();
    const { challenge } = pkce();
    const a = await authorize({ response_type: 'code', client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st' });
    const r = new URL(a.headers.get('location')!, base).searchParams.get('r')!;
    expect(() => auth.resolveConsent(r, { owner: ALICE, commander: aliceCommander, roles: ['nope'], approve: true })).toThrow();
    expect(() => auth.resolveConsent(r, { owner: 'unknown_owner_01', commander: aliceCommander, roles: ['runner'], approve: true })).toThrow();
    const back = new URL(auth.resolveConsent(r, { owner: ALICE, commander: aliceCommander, roles: [], approve: false }).redirect);
    expect(Object.fromEntries(back.searchParams)).toEqual({ error: 'access_denied', state: 'st', iss: base });
    expect(auth.consentRequest(r)).toBeUndefined();
    expect(() => auth.resolveConsent(r, { owner: ALICE, commander: aliceCommander, roles: ['runner'], approve: true })).toThrow();
  });

  it('a replayed authorization code is refused and revokes what the first redemption issued', async () => {
    const g = await grant(['runner']);
    expect((await mcpStatus(g.access)).status).toBe(200);
    const again = await token({ grant_type: 'authorization_code', code: g.code, redirect_uri: REDIRECT, client_id: g.client, code_verifier: g.verifier });
    expect(again).toEqual({ status: 400, body: { error: 'invalid_grant' } });
    expect((await mcpStatus(g.access)).status).toBe(401);
    expect(auth.connections(ALICE)).toEqual([]);
  });
});

describe('origins', () => {
  it('one endpoint under two origins: metadata, challenge, iss and audience follow the origin the client used', async () => {
    for (const c of closers.splice(0).reverse()) await c();
    host = createPlayerThreeHost({ definition });
    host.commanders.ensure(ALICE);
    aliceCommander = host.commanders.create(ALICE, { name: 'Alice', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    ({ server, base } = await listen((_req, res) => res.writeHead(404).end()));
    const alias = base.replace('127.0.0.1', 'localhost');
    // The issuer is a third origin (like PUBLIC_URL on a dev proxy); this server's own origins are aliases.
    auth = createAuthorizationServer(host, { issuer: 'http://localhost:5173', aliases: [base, alias], consentUrl: (r) => `/connect?r=${r}` });
    const mounted = mountMcp(server, host, { auth });
    closers.push(() => mounted.close(), () => auth.close(), () => host.dispose());

    const prm = async (headers: Record<string, string> = {}) => (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, { headers })).json()) as { resource: string; authorization_servers: string[] };
    expect(await prm()).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    expect(await prm({ 'x-forwarded-host': 'localhost:5173', 'x-forwarded-proto': 'http' })).toMatchObject({ resource: 'http://localhost:5173/mcp', authorization_servers: ['http://localhost:5173'] });
    // Unconfigured origins never show up: the next configured candidate (here the Host) answers.
    expect(await prm({ 'x-forwarded-host': 'evil.example' })).toMatchObject({ resource: `${base}/mcp` });
    const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ issuer: base, token_endpoint: `${base}/oauth/token` });
    expect((await mcpStatus(undefined)).challenge).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);

    // A real SDK client configured with the alias URL signs in and plays (its own resource and issuer checks pass).
    const dir = mkdtempSync(join(tmpdir(), 'playerthree-oauth-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const signIn = await browserSignIn({
      url: `${alias}/mcp`,
      clientName: 'playerthree-mcp',
      softwareId: 'dev.playerthree.bridge',
      cacheFile: join(dir, 'oauth.json'),
      openBrowser: false,
      log: (line) => {
        const m = /(http\S+)/.exec(line);
        if (!m) return;
        expect(new URL(m[1]!).origin).toBe(alias);
        void (async () => {
          const a = await fetch(m[1]!, { redirect: 'manual' });
          // The consent page lives on the issuer.
          expect(new URL(a.headers.get('location')!).origin).toBe('http://localhost:5173');
          const back = await consent(a.headers.get('location'), ['runner']);
          expect(back.searchParams.get('iss')).toBe(alias);
          await fetch(back);
        })();
      },
    });
    closers.push(() => signIn.close());
    const s = await connectSeat({ url: `${alias}/mcp`, signIn });
    closers.push(() => s.close());
    expect((await s.call('game_briefing', {})).structured).toMatchObject({ phase: 'lobby', commands: [{ role: 'runner', phase: 'lobby' }] });
  });
});

describe('tokens', () => {
  it('refresh tokens rotate; presenting a rotated one revokes the connection', async () => {
    const g = await grant(['runner']);
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: g.refresh, client_id: g.client });
    expect(r1.status).toBe(200);
    const refresh2 = r1.body['refresh_token'] as string;
    const access2 = r1.body['access_token'] as string;
    expect(refresh2).not.toBe(g.refresh);
    expect((await mcpStatus(access2)).status).toBe(200);
    // Bound to its client.
    expect((await token({ grant_type: 'refresh_token', refresh_token: refresh2, client_id: await clientId() })).body).toEqual({ error: 'invalid_grant' });
    // Reuse of the old refresh token: someone has a copy → the whole grant is revoked.
    expect((await token({ grant_type: 'refresh_token', refresh_token: g.refresh, client_id: g.client })).body).toEqual({ error: 'invalid_grant' });
    expect((await mcpStatus(access2)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: refresh2, client_id: g.client })).body).toEqual({ error: 'invalid_grant' });
  });

  it('revocation: RFC 7009 endpoint and the owner revoking in the game both cut the connection off at once', async () => {
    const g = await grant(['runner']);
    const s = await seat(g.access);
    expect((await s.call('game_briefing', {})).isError).toBe(false);
    const revoke = (t: string) => fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t, client_id: g.client }) });
    expect((await revoke(`playerthree_rt_${'x'.repeat(43)}`)).status).toBe(200);
    expect((await revoke(g.refresh)).status).toBe(200);
    expect((await mcpStatus(g.access)).status).toBe(401);
    expect(auth.connections(ALICE)).toEqual([]);

    const h = await grant(['guard']);
    const [conn] = auth.connections(ALICE);
    expect(() => auth.revokeConnection(BOB, conn!.id)).toThrow();
    auth.revokeConnection(ALICE, conn!.id);
    expect((await mcpStatus(h.access)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: h.refresh, client_id: h.client })).body).toEqual({ error: 'invalid_grant' });
  });

  it('access tokens are bound to this MCP endpoint (resource)', async () => {
    const client = await clientId();
    const { challenge } = pkce();
    const a = await authorize({ response_type: 'code', client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' });
    expect(new URL(a.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
    const g = await grant(['runner']);
    expect((await token({ grant_type: 'refresh_token', refresh_token: g.refresh, client_id: g.client, resource: 'https://other.example/mcp' })).body).toEqual({ error: 'invalid_target' });
  });
});

describe('connections', () => {
  it('distinguishes signed in from active, including calls in flight past the presence window', async () => {
    const g = await grant(['runner']);
    expect(auth.connections(ALICE)[0]).toMatchObject({ commander: aliceCommander, active: false, lastSeenAt: null });
    const verified = auth.verify(g.access)!;
    expect(verified).toMatchObject({ owner: ALICE, commander: aliceCommander });
    expect(verified.roles()).toEqual(['runner']);
    verified.activity(1);
    expect(auth.connections(ALICE)[0]!.active).toBe(true);
    const realNow = Date.now;
    let now = realNow() + 60_000;
    Date.now = () => now;
    try {
      expect(auth.connections(ALICE)[0]!.active).toBe(true);
      verified.activity(-1);
      expect(auth.connections(ALICE)[0]!.active).toBe(true);
      now += 60_000;
      expect(auth.connections(ALICE)[0]!.active).toBe(false);
      expect(auth.connections(ALICE)).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });

  it('applies role scopes and supervised approvals to sign-in credentials in lobby and live match', async () => {
    const g = await grant(['runner']);
    const s = await seat(g.access);
    host.commanders.update(ALICE, aliceCommander, { scopes: [], mandate: { autonomy: 'supervised' } });
    expect((await s.call('game_briefing', {})).structured).toMatchObject({ scopes: [], mandate: { autonomy: 'supervised' } });
    expect(errorOf((await s.call('policy_deploy', { runtime: 'js', code: 'function think() { return []; }' })).text).error).toBe('out_of_scope');
    const match = host.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: aliceCommander } }] });
    expect((await s.call('game_act', { intents: [{ kind: 'stop' }] })).structured).toMatchObject({ acks: [{ ok: false, code: 'out_of_scope' }] });
    host.commanders.update(ALICE, aliceCommander, { scopes: ['policy'] });
    const proposed = await s.call('policy_deploy', { runtime: 'js', code: 'function think() { return []; }' });
    expect(proposed.structured).toMatchObject({ ok: false, approval: { kind: 'policyDeploy', id: expect.any(String) } });
    const id = host.commanders.roster(ALICE)[0]!.approvals.find((entry) => entry.role === 'runner')!.approval.id;
    await host.commanders.resolveApproval(ALICE, aliceCommander, id, false);
    expect((await s.call('policy_status', {})).structured).toMatchObject({ policy: { version: null, approval: { id, status: 'rejected' } } });
    match.dispose();
  });

  it('role edits take effect on the next call; independent connections retain overlapping compatible roles', async () => {
    const g = await grant(['runner', 'guard']);
    const s = await seat(g.access);
    const [conn] = auth.connections(ALICE);
    expect((await s.call('game_briefing', { role: 'guard' })).isError).toBe(false);

    auth.updateConnection(ALICE, conn!.id, { roles: ['runner'] });
    expect(errorOf((await s.call('game_briefing', { role: 'guard' })).text).error).toBe('forbidden');
    // One role left: `role` is optional again.
    expect((await s.call('game_wait', { seconds: 0 })).structured).toMatchObject({ phase: 'lobby' });
    expect((await s.call('game_briefing', {})).structured).toMatchObject({ commands: [{ role: 'runner', phase: 'lobby' }] });

    // Another consent does not steal the existing commander role grant.
    const h = await grant(['runner'], ALICE, 'Other Harness');
    expect(auth.connections(ALICE).map((c) => c.roles)).toEqual([['runner'], ['runner']]);
    expect((await s.call('game_wait', { seconds: 0 })).isError).toBe(false);
    const s2 = await seat(h.access);
    expect((await s2.call('game_wait', { seconds: 0 })).isError).toBe(false);

    expect(() => auth.updateConnection(ALICE, conn!.id, { roles: ['runner', 'runner'] })).toThrow();
    expect(() => auth.updateConnection(BOB, conn!.id, { roles: [] })).toThrow();
    auth.updateConnection(ALICE, conn!.id, { roles: ['guard', 'runner'] });
    expect(auth.connections(ALICE).map((c) => c.roles)).toEqual([['runner', 'guard'], ['runner']]);
    expect((await s2.call('game_wait', { seconds: 0 })).isError).toBe(false);
  });

  it('signing in again from the same harness creates an independent connection', async () => {
    const first = await grant(['runner', 'guard']);
    const [before] = auth.connections(ALICE);
    // The harness re-authenticates (a DCR client registers anew each time; a CIMD client keeps its URL).
    const again = await grant(['guard']);
    const after = auth.connections(ALICE);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ id: before!.id, commander: aliceCommander, roles: ['runner', 'guard'] });
    expect(after[1]).toMatchObject({ commander: aliceCommander, roles: ['guard'] });
    expect(after[1]!.id).not.toBe(before!.id);
    expect(after[0]!.authorizedAt).toBe(before!.authorizedAt);
    expect((await mcpStatus(first.access)).status).toBe(200);
    expect((await token({ grant_type: 'refresh_token', refresh_token: first.refresh, client_id: first.client })).status).toBe(200);
    // Refreshing one independent consent must not revoke the other sign-in.
    expect((await mcpStatus(again.access)).status).toBe(200);
  });

  it('seat tokens and commander tokens keep working next to OAuth', async () => {
    const single = host.commanders.create(ALICE, { name: 'Runner only', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const commander = await seat(host.commanders.token(ALICE, single));
    expect((await commander.call('game_briefing', {})).structured).toMatchObject({ phase: 'lobby', commands: [{ role: 'runner', phase: 'lobby' }] });
    // A token commanding one role may still name it, but not another one.
    expect((await commander.call('game_wait', { seconds: 0, role: 'runner' })).isError).toBe(false);
    expect(errorOf((await commander.call('game_wait', { seconds: 0, role: 'guard' })).text).error).toBe('forbidden');

    const match = host.createMatch();
    const seatToken = await seat(match.mintSeatToken('red', 'guard'));
    expect((await seatToken.call('game_briefing', {})).structured).toMatchObject({ phase: 'match', seat: { team: 'red', role: 'guard' }, commands: [{ role: 'guard', phase: 'match', team: 'red' }] });
    expect((await seatToken.call('game_act', { intents: [{ kind: 'stop' }] })).isError).toBe(false);
    expect((await mcpStatus('B'.repeat(32))).status).toBe(401);
  });
});

describe('client ID metadata documents', () => {
  it('refuses non-https, non-canonical and private client ids before connecting', async () => {
    for (const [id, code] of [
      ['http://example.com/client.json', 'invalid_client_id'],
      ['https://example.com/', 'invalid_client_id'],
      ['https://example.com/a/../client.json', 'invalid_client_id'],
      ['https://EXAMPLE.com/client.json', 'invalid_client_id'],
      ['https://user:pw@example.com/client.json', 'invalid_client_id'],
      ['https://10.0.0.1/client.json', 'blocked_address'],
      ['https://[::1]/client.json', 'blocked_address'],
      ['https://169.254.169.254/latest/meta-data', 'blocked_address'],
      // A host name resolving to a loopback address is refused at connect time (the vetted address is the one used).
      ['https://localhost:9/client.json', 'blocked_address'],
    ] as const) {
      const r = await fetchClientDocument(id);
      expect(r.ok ? 'ok' : r.code, id).toBe(code);
    }
  });

  it('no redirects, size and time limits, JSON only, client_id must match, no secrets', async () => {
    const docs: Record<string, (res: ServerResponse, id: string) => void> = {};
    const { base: doc } = await listen((req, res) => docs[req.url!]!(res, `${doc}${req.url}`));
    const send = (body: unknown, headers: Record<string, string> = {}) => (res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const good = (id: string) => ({ client_id: id, client_name: 'Good\u202e Client', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' });
    docs['/ok.json'] = (res, id) => send(good(id), { 'cache-control': 'max-age=300' })(res);
    docs['/redirect.json'] = (res) => res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
    docs['/big.json'] = (res, id) => send({ ...good(id), pad: 'x'.repeat(10_000) })(res);
    docs['/slow.json'] = () => {};
    docs['/html.json'] = (res, id) => send(good(id), { 'content-type': 'text/html' })(res);
    docs['/mismatch.json'] = (res) => send(good('https://other.example/ok.json'))(res);
    docs['/secret.json'] = (res, id) => send({ ...good(id), client_secret: 's' })(res);
    docs['/badredirect.json'] = (res, id) => send({ ...good(id), redirect_uris: ['http://evil.example/cb'] })(res);
    docs['/jwt.json'] = (res, id) => send({ ...good(id), token_endpoint_auth_method: 'private_key_jwt' })(res);

    // Without the development opt-in, loopback documents are refused outright.
    expect(await fetchClientDocument(`${doc}/ok.json`)).toEqual({ ok: false, code: 'invalid_client_id' });
    const ok = await fetchClientDocument(`${doc}/ok.json`, { allowLoopback: true });
    expect(ok).toEqual({ ok: true, maxAgeMs: 300_000, document: { info: { id: `${doc}/ok.json`, registration: 'cimd', name: 'Good Client' }, redirectUris: ['http://127.0.0.1/callback'] } });
    const code = async (path: string) => {
      const r = await fetchClientDocument(`${doc}${path}`, { allowLoopback: true, timeoutMs: 300 });
      return r.ok ? 'ok' : r.code;
    };
    expect(await code('/redirect.json')).toBe('redirect');
    expect(await code('/big.json')).toBe('too_large');
    expect(await code('/slow.json')).toBe('timeout');
    expect(await code('/html.json')).toBe('bad_content_type');
    expect(await code('/mismatch.json')).toBe('bad_document');
    expect(await code('/secret.json')).toBe('bad_document');
    expect(await code('/badredirect.json')).toBe('bad_document');
    expect(await code('/jwt.json')).toBe('bad_document');
  });

  it('a metadata-document client signs in with an ephemeral loopback port; its domain is shown on the consent page', async () => {
    for (const c of closers.splice(0).reverse()) await c();
    await startHost({ allowLoopbackClients: true });
    let fetched = 0;
    const { base: doc } = await listen((req, res) => {
      fetched++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ client_id: `${doc}${req.url}`, client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' }));
    });
    const client = `${doc}/oauth/claude-code-client-metadata`;
    const { verifier, challenge } = pkce();
    const redirect = 'http://127.0.0.1:3118/callback';
    const a = await authorize({ response_type: 'code', client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'cc' });
    expect(a.status).toBe(302);
    const r = new URL(a.headers.get('location')!, base).searchParams.get('r')!;
    expect(auth.consentRequest(r)).toMatchObject({
      client: { id: client, registration: 'cimd', name: 'Claude Code' },
      domain: new URL(doc).host,
      redirect: { uri: redirect, host: '127.0.0.1:3118', loopback: true },
      roles: ['runner', 'guard'],
    });
    const back = new URL(auth.resolveConsent(r, { owner: ALICE, commander: aliceCommander, roles: ['guard'], approve: true }).redirect);
    expect(`${back.origin}${back.pathname}`).toBe(redirect);
    const t = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: redirect, client_id: client, code_verifier: verifier });
    expect(t.status).toBe(200);
    // Cached: the document was fetched once.
    await authorize({ response_type: 'code', client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' });
    expect(fetched).toBe(1);
    expect(auth.connections(ALICE)).toMatchObject([{ commander: aliceCommander, client: { registration: 'cimd', name: 'Claude Code' }, roles: ['guard'] }]);
  });
});

describe('credential-scoped listen wake', () => {
  it('keeps connection status private and ends subscriptions on role removal and revocation', async () => {
    const alice = await grant(['runner', 'guard']);
    const bob = await grant(['runner'], BOB);
    const clients: Client[] = [];
    for (const access of [alice.access, bob.access]) {
      const client = new Client({ name: 'status-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: { token: async () => access } }));
      clients.push(client);
      closers.push(() => client.close());
    }
    const a = clients[0]!;
    const b = clients[1]!;
    const resources = (await a.listResources()).resources.filter((resource) => resource.uri.startsWith('playerthree://seat/'));
    expect(resources.map((resource) => resource.name).sort()).toEqual(['guard', 'runner']);
    const uri = resources.find((resource) => resource.name === 'runner')!.uri;
    expect((await b.listResources()).resources.map((resource) => resource.uri)).not.toContain(uri);
    await expect(b.readResource({ uri })).rejects.toThrow();
    await expect(b.listen({ resourceSubscriptions: [uri] })).rejects.toThrow();
    let updates = 0;
    a.setNotificationHandler('notifications/resources/updated', () => { updates++; });
    const sub = await a.listen({ resourceSubscriptions: [uri] });
    host.commanders.tell(ALICE, [aliceCommander], 'Owner only.');
    await expect.poll(() => updates).toBe(1);
    const connection = auth.connections(ALICE)[0]!.id;
    auth.updateConnection(ALICE, connection, { roles: ['guard'] });
    await sub.closed;
    await expect(a.readResource({ uri }, { cacheMode: 'bypass' })).rejects.toThrow();
    host.commanders.tell(ALICE, [aliceCommander], 'No delivery after role removal.');
    expect(updates).toBe(1);
    const guard = resources.find((resource) => resource.name === 'guard')!.uri;
    const guardSub = await a.listen({ resourceSubscriptions: [guard] });
    auth.revokeConnection(ALICE, connection);
    await guardSub.closed;
    host.commanders.tell(ALICE, [aliceCommander], 'No delivery after revocation.');
    expect(updates).toBe(1);
  });
});
