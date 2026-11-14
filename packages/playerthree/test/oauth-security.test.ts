import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definition } from '../examples/tag/index.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import type { PlayerThreeHost } from '../src/host/types.ts';
import { createAuthorizationServer, type AuthorizationServer } from '../src/mcp/oauth/server.ts';
import { memoryConnectionStore, type ConnectionStore, type StoredClient } from '../src/mcp/oauth/store.ts';

const ISSUER = 'https://game.example';
const REDIRECT = 'https://client.example/callback';
const OWNER = 'owner_oauth_sec01';
/** The server's DCR table size (MAX_CLIENTS in oauth/server.ts). */
const MAX_CLIENTS = 10_000;
/** Pending consent requests kept at once (MAX_PENDING in oauth/server.ts). */
const MAX_PENDING = 1000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) close();
});

interface Rig {
  host: PlayerThreeHost;
  auth: AuthorizationServer;
  commander: string;
}

async function rig(store?: ConnectionStore): Promise<Rig> {
  const host = createPlayerThreeHost({ definition }) as unknown as PlayerThreeHost;
  cleanups.push(() => host.dispose());
  await host.ready;
  const commander = host.commanders.create(OWNER, { name: 'Sec', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
  const auth = createAuthorizationServer(host, { issuer: ISSUER, consentUrl: (id) => `/consent?r=${id}`, ...(store ? { store } : {}) });
  cleanups.push(() => auth.close());
  await auth.ready;
  return { host, auth, commander };
}

async function register(auth: AuthorizationServer): Promise<Response> {
  return (await auth.fetch(new Request(`${ISSUER}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Harness', redirect_uris: [REDIRECT] }),
  })))!;
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const authorize = async (auth: AuthorizationServer, client: string, challenge: string) =>
  (await auth.fetch(new Request(`${ISSUER}/oauth/authorize?${new URLSearchParams({
    client_id: client, redirect_uri: REDIRECT, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge,
  })}`)))!;

const token = async (auth: AuthorizationServer, params: Record<string, string>) => {
  const r = (await auth.fetch(new Request(`${ISSUER}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  })))!;
  return { status: r.status, body: await r.json() as Record<string, string> };
};

/** Consent id of a successful /oauth/authorize redirect. */
const requestId = (r: Response): string => new URL(r.headers.get('location')!).searchParams.get('r')!;

async function signIn({ auth, commander }: Rig): Promise<{ client: string; code: string; verifier: string; access: string; refresh: string }> {
  const { client_id: client } = await (await register(auth)).json() as { client_id: string };
  const { verifier, challenge } = pkce();
  const id = requestId(await authorize(auth, client, challenge));
  const code = new URL(auth.resolveConsent(id, { owner: OWNER, commander, roles: ['runner'], approve: true }).redirect).searchParams.get('code')!;
  const t = await token(auth, { grant_type: 'authorization_code', client_id: client, redirect_uri: REDIRECT, code, code_verifier: verifier });
  expect(t.status).toBe(200);
  return { client, code, verifier, access: t.body['access_token']!, refresh: t.body['refresh_token']! };
}

describe('OAuth authorization code abuse', () => {
  it('fix: a replay after the code lifetime still revokes the connection the code produced', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const r = await rig();
    const g = await signIn(r);
    expect(r.auth.verify(g.access)).toBeDefined();
    // Well past the 60 s redemption window: an intercepted code surfacing later is still a replay.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const replay = await token(r.auth, { grant_type: 'authorization_code', client_id: g.client, redirect_uri: REDIRECT, code: g.code, code_verifier: g.verifier });
    expect(replay).toEqual({ status: 400, body: { error: 'invalid_grant' } });
    expect(r.auth.verify(g.access)).toBeUndefined();
    expect(r.auth.connections(OWNER)).toEqual([]);
  });

  it('coverage: an unredeemed code expires, and a code is bound to its client and verifier grammar', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const r = await rig();
    const { client_id: client } = await (await register(r.auth)).json() as { client_id: string };
    const { client_id: other } = await (await register(r.auth)).json() as { client_id: string };
    const issue = async () => {
      const { verifier, challenge } = pkce();
      const id = requestId(await authorize(r.auth, client, challenge));
      return { verifier, code: new URL(r.auth.resolveConsent(id, { owner: OWNER, commander: r.commander, roles: ['runner'], approve: true }).redirect).searchParams.get('code')! };
    };
    const late = await issue();
    vi.setSystemTime(Date.now() + 61_000);
    expect((await token(r.auth, { grant_type: 'authorization_code', client_id: client, redirect_uri: REDIRECT, code: late.code, code_verifier: late.verifier })).body).toEqual({ error: 'invalid_grant' });

    const stolen = await issue();
    expect((await token(r.auth, { grant_type: 'authorization_code', client_id: other, redirect_uri: REDIRECT, code: stolen.code, code_verifier: stolen.verifier })).body).toEqual({ error: 'invalid_grant' });
    // Burnt by the foreign attempt: the rightful client cannot redeem it afterwards either.
    expect((await token(r.auth, { grant_type: 'authorization_code', client_id: client, redirect_uri: REDIRECT, code: stolen.code, code_verifier: stolen.verifier })).body).toEqual({ error: 'invalid_grant' });

    // RFC 7636 §4.1: 43–128 unreserved characters. A 42-character verifier is refused even if its hash matched.
    const short = 'v'.repeat(42);
    const id = requestId(await authorize(r.auth, client, createHash('sha256').update(short).digest('base64url')));
    const code = new URL(r.auth.resolveConsent(id, { owner: OWNER, commander: r.commander, roles: ['runner'], approve: true }).redirect).searchParams.get('code')!;
    expect((await token(r.auth, { grant_type: 'authorization_code', client_id: client, redirect_uri: REDIRECT, code, code_verifier: short })).body).toEqual({ error: 'invalid_grant' });
    expect(r.auth.connections(OWNER)).toEqual([]);
  });

  it('coverage: persisted connections carry token digests only, never the tokens', async () => {
    const saved: string[] = [];
    const inner = memoryConnectionStore();
    const store: ConnectionStore = { ...inner, saveConnection: (c) => { saved.push(JSON.stringify(c)); return inner.saveConnection(c); } };
    const r = await rig(store);
    const g = await signIn(r);
    const rotated = await token(r.auth, { grant_type: 'refresh_token', client_id: g.client, refresh_token: g.refresh });
    expect(rotated.status).toBe(200);
    expect(saved.length).toBeGreaterThan(0);
    for (const record of saved) {
      for (const secret of [g.access, g.refresh, rotated.body['access_token']!, rotated.body['refresh_token']!]) expect(record).not.toContain(secret);
      expect(record).not.toContain('playerthree_rt_');
      expect(record).not.toContain('playerthree_at_');
    }
  });
});

describe('OAuth resource exhaustion', () => {
  it('fix: a flood of authorization requests evicts the oldest pending request instead of locking out sign-in', async () => {
    const r = await rig();
    const { client_id: client } = await (await register(r.auth)).json() as { client_id: string };
    const { challenge } = pkce();
    const first = requestId(await authorize(r.auth, client, challenge));
    for (let i = 1; i < MAX_PENDING; i++) await authorize(r.auth, client, challenge);
    // The table is full: a further request is still served (not `temporarily_unavailable`) and the oldest goes.
    const next = await authorize(r.auth, client, challenge);
    expect(next.status).toBe(302);
    expect(new URL(next.headers.get('location')!).searchParams.get('error')).toBeNull();
    expect(r.auth.consentRequest(requestId(next))).toBeDefined();
    expect(r.auth.consentRequest(first)).toBeUndefined();
  });

  it('fix: a full client table forgets the least recently used idle registration instead of refusing for 30 days', async () => {
    const now = Date.now();
    const clients: StoredClient[] = Array.from({ length: MAX_CLIENTS }, (_, i) => ({
      id: `dcr_${String(i).padStart(24, '0')}`, registration: 'dcr', name: 'Flood', redirectUris: [REDIRECT],
      // Index 0 is the least recently used, then 1, …
      createdAt: now - 1000, lastUsedAt: now - (MAX_CLIENTS - i),
    }));
    const deleted: string[] = [];
    const inner = memoryConnectionStore();
    const store: ConnectionStore = { ...inner, load: () => ({ connections: [], clients }), deleteClient: (id) => void deleted.push(id) };
    const r = await rig(store);
    // The oldest registration has a sign-in in progress, so it must survive: the next oldest is forgotten.
    const pending = requestId(await authorize(r.auth, clients[0]!.id, pkce().challenge));
    const registered = await register(r.auth);
    expect(registered.status).toBe(201);
    expect(deleted).toEqual([clients[1]!.id]);
    expect(r.auth.consentRequest(pending)).toBeDefined();
    expect((await authorize(r.auth, clients[1]!.id, pkce().challenge)).status).toBe(400);
  });
});
