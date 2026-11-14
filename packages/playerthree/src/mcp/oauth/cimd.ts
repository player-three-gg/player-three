/**
 * OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document, MCP 2026-07-28): fetching a
 * client's metadata from its `client_id` URL without becoming an SSRF proxy, and the redirect-URI rules shared with
 * Dynamic Client Registration.
 *
 * Fetch guards: https only (plain http only to loopback hosts, and only with `allowLoopback`, for local
 * development); the client_id must be in canonical form with a path; every resolved address must be public
 * (private, loopback, link-local, CGNAT, multicast, reserved, documentation, NAT64/6to4/Teredo ranges are refused;
 * the socket connects to the vetted address, so DNS rebinding cannot swap it); redirects are never followed;
 * a total time limit and a body size limit; JSON content type only.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { OAuthClientInfo } from './store.ts';

export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_MAX_BYTES = 5 * 1024;
const MAX_URL = 2048;
const MAX_REDIRECT_URIS = 20;
const MIN_CACHE_MS = 60_000;
const MAX_CACHE_MS = 86_400_000;
const DEFAULT_CACHE_MS = 3_600_000;

export type CimdErrorCode =
  | 'invalid_client_id'
  | 'blocked_address'
  | 'redirect'
  | 'status'
  | 'bad_content_type'
  | 'too_large'
  | 'timeout'
  | 'network'
  | 'bad_document';

export interface ClientDocument {
  info: OAuthClientInfo;
  redirectUris: string[];
}

export type CimdResult = { ok: true; document: ClientDocument; maxAgeMs: number } | { ok: false; code: CimdErrorCode };

export interface CimdOptions {
  /** Development only: accept `http://` client ids on loopback hosts and loopback addresses. */
  allowLoopback?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

/**
 * The IPv4 address embedded in an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), else undefined. Mapped addresses
 * are checked as the IPv4 address they reach: a BlockList rule for `::ffff:0:0/96` would match every IPv4 address.
 */
function mappedIpv4(address: string): string | undefined {
  const m = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(new URL(`http://[${address}]`).hostname);
  if (!m) return undefined;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** A resolved address the server may connect to. */
export function addressAllowed(address: string, allowLoopback = false): boolean {
  // Zone-scoped addresses (fe80::1%eth0) are link-local by definition.
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const v4 = mappedIpv4(address);
    if (v4 !== undefined) return addressAllowed(v4, allowLoopback);
  }
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (allowLoopback && loopback.check(address, type)) return true;
  return (family === 4 || globalIpv6.check(address, 'ipv6')) && !blocked.check(address, type);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** Removes control and bidi-override characters, collapses whitespace, trims, caps the length. */
export function cleanText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length === 0 ? undefined : s.slice(0, max);
}

/** An https URL (or nothing): for client_uri / logo_uri, which the game may render as links or images. */
export function httpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A redirect URI clients may register: absolute, no fragment, no credentials, and either https or plain http to a
 * loopback host (MCP: "All redirect URIs MUST be either localhost or use HTTPS").
 */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || raw.includes('#') || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopbackHost(u.hostname);
}

/**
 * Exact string match, except that a registered plain-http loopback redirect URI matches any port on the same
 * loopback host with the same path and query (RFC 8252 §7.3: native apps listen on an ephemeral port).
 */
export function redirectMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  let r: URL;
  let g: URL;
  try {
    r = new URL(registered);
    g = new URL(given);
  } catch {
    return false;
  }
  if (r.protocol !== 'http:' || g.protocol !== 'http:' || !isLoopbackHost(r.hostname) || r.hostname !== g.hostname) return false;
  if (g.hash || given.includes('#') || g.username || g.password) return false;
  return r.pathname === g.pathname && r.search === g.search;
}

/** The client_id as a fetchable URL, or undefined when it is not a valid metadata document URL. */
export function clientIdUrl(raw: string, allowLoopback = false): URL | undefined {
  if (raw.length > MAX_URL) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  // Canonical form only: dot segments, default ports, upper-case hosts etc. would not survive this.
  if (u.href !== raw || u.hash || u.username || u.password || u.pathname === '/' || u.pathname === '') return undefined;
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && allowLoopback && isLoopbackHost(u.hostname)) return u;
  return undefined;
}

function guardedLookup(allowLoopback: boolean): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number | string }, callback: (...args: unknown[]) => void) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err);
      // Every address must be acceptable: a mixed answer is how rebinding and split-horizon tricks look.
      if (addresses.length === 0 || !addresses.every((a) => addressAllowed(a.address, allowLoopback))) {
        return callback(Object.assign(new Error('blocked address'), { code: 'EAI_BLOCKED' }));
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as unknown as LookupFunction;
}

function cacheMs(header: string | undefined): number {
  if (!header) return DEFAULT_CACHE_MS;
  const h = header.toLowerCase();
  if (/(^|,)\s*(no-store|no-cache)\b/.test(h)) return 0;
  const m = /(^|,)\s*max-age\s*=\s*"?(\d{1,10})"?/.exec(h);
  if (!m) return DEFAULT_CACHE_MS;
  return Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, Number(m[2]) * 1000));
}

/** Validates a fetched document against its URL. */
export function parseClientDocument(url: string, body: unknown): ClientDocument | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const d = body as Record<string, unknown>;
  if (d['client_id'] !== url) return undefined;
  // A document is public: it can never carry a shared secret.
  if (d['client_secret'] !== undefined || d['client_secret_expires_at'] !== undefined) return undefined;
  const name = cleanText(d['client_name'], 100);
  if (!name) return undefined;
  const uris = d['redirect_uris'];
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(validRedirectUri)) return undefined;
  const auth = d['token_endpoint_auth_method'];
  if (auth !== undefined && auth !== 'none') return undefined;
  const grants = d['grant_types'];
  if (grants !== undefined && !(Array.isArray(grants) && grants.includes('authorization_code'))) return undefined;
  const responses = d['response_types'];
  if (responses !== undefined && !(Array.isArray(responses) && responses.includes('code'))) return undefined;
  const info: OAuthClientInfo = { id: url, registration: 'cimd', name };
  const uri = httpsUrl(d['client_uri']);
  const logoUri = httpsUrl(d['logo_uri']);
  const softwareId = cleanText(d['software_id'], 100);
  const softwareVersion = cleanText(d['software_version'], 100);
  if (uri) info.uri = uri;
  if (logoUri) info.logoUri = logoUri;
  if (softwareId) info.softwareId = softwareId;
  if (softwareVersion) info.softwareVersion = softwareVersion;
  return { info, redirectUris: [...(uris as string[])] };
}

/** Fetches and validates the metadata document a URL-formatted client_id points to. */
export function fetchClientDocument(clientId: string, opts: CimdOptions = {}): Promise<CimdResult> {
  const allowLoopback = opts.allowLoopback === true;
  const url = clientIdUrl(clientId, allowLoopback);
  if (!url) return Promise.resolve({ ok: false, code: 'invalid_client_id' });
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  // IP-literal hosts never reach the lookup function.
  if (isIP(literal) !== 0 && !addressAllowed(literal, allowLoopback)) return Promise.resolve({ ok: false, code: 'blocked_address' });
  const maxBytes = opts.maxBytes ?? CIMD_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? CIMD_TIMEOUT_MS;

  const { promise, resolve } = Promise.withResolvers<CimdResult>();
  let settled = false;
  const done = (r: CimdResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    req.destroy();
    resolve(r);
  };
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = request(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'playerthree-oauth' },
    lookup: guardedLookup(allowLoopback),
    // No connection reuse: every fetch re-resolves and re-vets the host.
    agent: false,
  });
  const timer = setTimeout(() => done({ ok: false, code: 'timeout' }), timeoutMs);
  req.on('error', (e: NodeJS.ErrnoException) => done({ ok: false, code: e.code === 'EAI_BLOCKED' ? 'blocked_address' : 'network' }));
  req.on('response', (res: IncomingMessage) => {
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) return done({ ok: false, code: 'redirect' });
    if (status !== 200) return done({ ok: false, code: 'status' });
    if (!/^application\/json\s*(;|$)/i.test(res.headers['content-type'] ?? '')) return done({ ok: false, code: 'bad_content_type' });
    if (Number(res.headers['content-length'] ?? 0) > maxBytes) return done({ ok: false, code: 'too_large' });
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) return done({ ok: false, code: 'too_large' });
      chunks.push(chunk);
    });
    res.on('error', () => done({ ok: false, code: 'network' }));
    res.on('end', () => {
      if (settled) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return done({ ok: false, code: 'bad_document' });
      }
      const document = parseClientDocument(clientId, body);
      done(document ? { ok: true, document, maxAgeMs: cacheMs(res.headers['cache-control']) } : { ok: false, code: 'bad_document' });
    });
  });
  req.end();
  return promise;
}
