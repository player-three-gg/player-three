import { describe, expect, it } from 'vitest';
import { addressAllowed, parseClientDocument, redirectMatches } from '../src/mcp/oauth/cimd.ts';

/** Claude Code's published Client ID Metadata Document (https://claude.ai/oauth/claude-code-client-metadata). */
const CLAUDE_CODE = {
  client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

describe('CIMD address guard', () => {
  it('allows public IPv4 and IPv6 addresses (an IPv4-mapped rule must not swallow all of IPv4)', () => {
    for (const a of ['160.79.104.10', '1.1.1.1', '8.8.8.8', '2607:6bc0::10', '2606:4700:4700::1111', '::ffff:160.79.104.10']) expect(addressAllowed(a), a).toBe(true);
  });

  it('refuses private, loopback, link-local, CGNAT, reserved and mapped-private addresses', () => {
    for (const a of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      'fe80::1%eth0',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      '2001:db8::1',
      '2001:2::1',
      '2001:20::1',
      '3fff::1',
      '4000::1',
      '::127.0.0.1',
      'not-an-ip',
    ]) {
      expect(addressAllowed(a), a).toBe(false);
    }
    expect(addressAllowed('127.0.0.1', true)).toBe(true);
    expect(addressAllowed('::ffff:127.0.0.1', true)).toBe(true);
    expect(addressAllowed('10.0.0.1', true)).toBe(false);
  });
});

describe("Claude Code's metadata document", () => {
  it('validates, and its portless loopback redirect URIs match any port at request time', () => {
    const doc = parseClientDocument(CLAUDE_CODE.client_id, CLAUDE_CODE);
    expect(doc).toEqual({
      info: { id: CLAUDE_CODE.client_id, registration: 'cimd', name: 'Claude Code', uri: 'https://claude.ai/' },
      redirectUris: CLAUDE_CODE.redirect_uris,
    });
    for (const given of ['http://localhost:54783/callback', 'http://127.0.0.1:54783/callback', 'http://localhost/callback']) {
      expect(doc!.redirectUris.some((r) => redirectMatches(r, given)), given).toBe(true);
    }
    for (const given of ['http://localhost:54783/other', 'http://evil.example:54783/callback', 'https://localhost:54783/callback']) {
      expect(doc!.redirectUris.some((r) => redirectMatches(r, given)), given).toBe(false);
    }
    // The document must be served from its own client_id URL.
    expect(parseClientDocument('https://claude.ai/other', CLAUDE_CODE)).toBeUndefined();
  });
});
