import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { definition } from '../examples/tag/index.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import { createAuthorizationServer } from '../src/mcp/oauth/server.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

describe('named commander OAuth isolation', () => {
  it('keeps identical-client, same-role connections independent and validates compatible roles', async () => {
    const host = createPlayerThreeHost({ definition });
    cleanups.push(() => host.dispose());
    await host.ready;
    const owner = 'owner_named_test';
    const first = host.commanders.create(owner, { name: 'First', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } });
    const second = host.commanders.create(owner, { name: 'Second', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } });
    const auth = createAuthorizationServer(host, { issuer: 'https://game.example', consentUrl: (id) => `/consent?r=${id}` });
    cleanups.push(() => auth.close());
    await auth.ready;
    const registration = await auth.fetch(new Request('https://game.example/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Same harness', redirect_uris: ['https://client.example/callback'] }),
    }));
    const { client_id: client } = await registration!.json() as { client_id: string };
    const verifier = 'a'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const tokens: string[] = [];
    for (const commander of [first.id, second.id]) {
      const params = new URLSearchParams({ client_id: client, redirect_uri: 'https://client.example/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge });
      const authorization = await auth.fetch(new Request(`https://game.example/oauth/authorize?${params}`));
      const request = new URL(authorization!.headers.get('location')!).searchParams.get('r')!;
      expect(() => auth.resolveConsent(request, { owner, commander, roles: ['guard'], approve: true })).toThrow();
      const callback = new URL(auth.resolveConsent(request, { owner, commander, roles: ['runner'], approve: true }).redirect);
      const response = await auth.fetch(new Request('https://game.example/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client, redirect_uri: 'https://client.example/callback', code: callback.searchParams.get('code')!, code_verifier: verifier }),
      }));
      expect(response!.status).toBe(200);
      const token = await response!.json() as { access_token: string };
      tokens.push(token.access_token);
    }
    const connections = auth.connections(owner);
    expect(connections.map((connection) => connection.commander)).toEqual([first.id, second.id]);
    expect(auth.verify(tokens[0]!)?.commander).toBe(first.id);
    expect(auth.verify(tokens[1]!)?.commander).toBe(second.id);
    expect(() => auth.updateConnection(owner, connections[0]!.id, { roles: ['guard'] })).toThrow();
    auth.revokeConnection(owner, connections[0]!.id);
    expect(auth.verify(tokens[0]!)).toBeUndefined();
    expect(auth.verify(tokens[1]!)?.roles()).toEqual(['runner']);
    host.commanders.delete(owner, second.id);
    expect(auth.verify(tokens[1]!)).toBeUndefined();
  });
});
