/**
 * The MCP endpoint's OAuth 2.1 authorization server (MCP authorization, spec 2026-07-28): one static MCP URL for
 * every player; the harness signs in through the browser and the game's own consent page decides which roles the
 * resulting **connection** commands.
 *
 *   GET  /.well-known/oauth-protected-resource[/<mcp path>]  RFC 9728 protected resource metadata
 *   GET  /.well-known/oauth-authorization-server             RFC 8414 metadata (CIMD supported, S256 only, RFC 9207 iss)
 *   GET  /oauth/authorize                                     code flow + PKCE S256 → the game's consent page
 *   POST /oauth/token                                         authorization_code, refresh_token (rotated; reuse revokes)
 *   POST /oauth/register                                      RFC 7591 dynamic client registration (public clients)
 *   POST /oauth/revoke                                        RFC 7009
 *
 * Consent is delegated: `/oauth/authorize` validates the request and redirects the browser to
 * `consentUrl(requestId)`; the game authenticates its player, shows `consentRequest(id)` and answers with
 * `resolveConsent(id, { owner, commander, roles, approve })`, which returns the redirect back to the client.
 *
 * Every connection binds one named commander and compatible role subset. Same-role connections remain independent.
 * Tokens are opaque random strings stored as SHA-256 digests only; access tokens are short-lived and
 * audience-bound to the MCP endpoint; refresh tokens rotate on every use.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { PlayerThreeHost } from '../../host/types.ts';
import { PlayerThreeError } from '../../host/util.ts';
import type { AnyManifest } from '../../manifest.ts';
import type { EnumS } from '../../schema.ts';
import { toWebRequest, writeWebResponse } from '../http.ts';
import { cleanText, clientIdUrl, fetchClientDocument, httpsUrl, isLoopbackHost, redirectMatches, validRedirectUri, type CimdResult, type ClientDocument } from './cimd.ts';
import {
  jsonConnectionStore,
  memoryConnectionStore,
  type ConnectionStore,
  type OAuthClientInfo,
  type ConnectionStoreData,
  type StoredClient,
  type StoredConnection,
} from './store.ts';

/** The one scope this server grants: play the roles the owner picked on the consent page. */
export const OAUTH_SCOPE = 'play';
export const ACCESS_TOKEN_PREFIX = 'playerthree_at_';
const REFRESH_TOKEN_PREFIX = 'playerthree_rt_';
const CODE_PREFIX = 'playerthree_ac_';
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const CONNECTION_ID_RE = /^con_[A-Za-z0-9_-]{16}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{32}$/;

const CODE_TTL_MS = 60_000;
/**
 * How long a redeemed code is remembered after redemption so that a late replay still revokes the connection it
 * produced (OAuth 2.1 §4.1.3). Codes only come from owner-approved consents, so this cannot be grown by strangers.
 */
const CODE_REPLAY_MS = 60 * 60_000;
const CONSENT_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1000;
const MAX_CLIENTS = 10_000;
const MAX_CIMD_CACHE = 500;
const CIMD_FAILURE_CACHE_MS = 30_000;
const MAX_CONNECTIONS_PER_OWNER = 20;
const MAX_RETIRED = 8;
const MAX_ACCESS = 4;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_STATE = 1024;
const ACTIVE_MS = 30_000;
const SEEN_SAVE_MS = 60_000;
const SWEEP_MS = 10 * 60_000;
/** DCR clients that never got (or no longer have) a connection are forgotten after this long without use. */
const CLIENT_IDLE_MS = 30 * 86_400_000;

/** Options of {@link createAuthorizationServer}. */
export interface AuthorizationServerOptions {
  /** Public origin of the game server (the issuer), e.g. `https://game.example`. No path. */
  issuer: string | URL;
  /**
   * Other origins the same server is reached at (e.g. in development both the Vite dev server and the game server).
   * Metadata, challenges, `iss` and the tokens' audience follow the origin a request came in on (the `Host` or
   * `X-Forwarded-Host` header, honoured only when it names one of these origins); anything else gets `issuer`.
   * The consent page is always on `issuer`.
   */
  aliases?: readonly (string | URL)[];
  /** Pathname of the MCP endpoint (default `/mcp`). The tokens' audience is `issuer + mcpPath`. */
  mcpPath?: string;
  /** The game's consent page for a pending request (absolute URL, or a path on the issuer). */
  consentUrl(requestId: string): string;
  /** Connection storage (default: JSON files under `dataDir/oauth/<game id>`, else in memory). */
  store?: ConnectionStore;
  dataDir?: string;
  /** Development only: accept `http://localhost…` Client ID Metadata Document URLs. */
  allowLoopbackClients?: boolean;
  /** Access token lifetime (default 3600). */
  accessTokenSeconds?: number;
  /** Refresh token lifetime, renewed on every rotation (default 30 days). */
  refreshTokenSeconds?: number;
  /** Human-readable resource name in the protected resource metadata (default: the game title). */
  resourceName?: string;
  onError?: (error: Error) => void;
}

/** A connection as the game shows it to its owner. */
export interface ConnectionStatus {
  id: string;
  commander: string;
  client: OAuthClientInfo;
  roles: string[];
  createdAt: number;
  /** Last consent (sign-in) for this connection: a repeat sign-in from the same client updates it. */
  authorizedAt: number;
  lastSeenAt: number | null;
  /** A call in the last 30 s, or a call in flight (e.g. blocked in game_wait). */
  active: boolean;
}

/** A connection with its owner, as the operator console lists them across owners. */
export interface OwnedConnectionStatus extends ConnectionStatus {
  owner: string;
}

/** What the game's consent page shows. */
export interface ConsentRequest {
  id: string;
  client: OAuthClientInfo;
  /** Host of a metadata-document client_id: the document was served from there (verified). Absent for DCR clients (self-asserted). */
  domain?: string;
  /** Where the browser returns after the answer. MCP: the page MUST show the host; warn when it is loopback only. */
  redirect: { uri: string; host: string; loopback: boolean };
  /** Roles the owner can grant (every manifest role). */
  roles: string[];
  expiresAt: number;
}

export interface ConsentDecision {
  /** The game's authenticated player id (`OWNER_RE`), with an existing commander roster. */
  owner: string;
  /** Exact named commander selected by the authenticated owner. */
  commander: string;
  /** Roles to grant (at least one when approving). */
  roles: readonly string[];
  approve: boolean;
}

/** An authenticated OAuth access token, as the MCP binding uses it. Everything is read live. */
export interface OAuthGrant {
  readonly connection: string;
  readonly owner: string;
  readonly commander: string;
  /** Current roles (edits apply to the next call). */
  roles(): readonly string[];
  /** The connection still exists and holds `role`. */
  holds(role: string): boolean;
  /** Marks activity; `+1`/`-1` around calls in flight. */
  activity(delta: 0 | 1 | -1): void;
}

/** The authorization server: its metadata URLs, request handling and the owner-side connection and consent operations. */
export interface AuthorizationServer {
  readonly issuer: string;
  /** The MCP endpoint URL tokens are bound to. */
  readonly resource: string;
  readonly resourceMetadataUrl: string;
  /** Resolves once the store has loaded. */
  readonly ready: Promise<void>;
  /** Whether a pathname belongs to the authorization server (`/.well-known/oauth-*`, `/oauth/*`). */
  handles(pathname: string): boolean;
  /** node:http face: answers and returns true for authorization server paths, else returns false untouched. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Web-standard face: a Response for authorization server paths, else undefined. */
  fetch(request: Request): Promise<Response | undefined>;
  consentRequest(id: string): ConsentRequest | undefined;
  /** Answers a pending request (single use). Throws `PlayerThreeError('invalid')` for unknown/expired ids, owners or roles. */
  resolveConsent(id: string, answer: ConsentDecision): { redirect: string };
  connections(owner: string): ConnectionStatus[];
  /** Every owner's connections, oldest first. For operator tooling (the operator console); never show it to players. */
  allConnections(): OwnedConnectionStatus[];
  /** Sets this exact commander's granted compatible roles without modifying other connections. */
  updateConnection(owner: string, id: string, patch: { roles: readonly string[] }): ConnectionStatus;
  /** Revokes a connection and every token of it at once. Throws `PlayerThreeError('invalid')` for unknown ids. */
  revokeConnection(owner: string, id: string): void;
  /** Revokes every connection of an owner. */
  removeOwner(owner: string): void;
  /** Resource-server side: an access token issued for this endpoint (under any of its origins), or undefined. */
  verify(token: string): OAuthGrant | undefined;
  /** Connection credential or role changes. Listeners receive identifiers only, never tokens. */
  onChange(listener: (connection: string) => void): () => void;
  /** `WWW-Authenticate` value for a 401 (`invalid`: a token was presented but is not valid), for the request's origin. */
  challenge(invalid: boolean, request?: Request): string;
  close(): void;
}

interface PendingRequest {
  id: string;
  client: OAuthClientInfo;
  redirectUri: string;
  state: string | undefined;
  challenge: string;
  resource: string;
  /** The origin the authorization request came in on: its issuer identifier (`iss`). */
  issuer: string;
  expiresAt: number;
}

interface IssuedCode {
  request: PendingRequest;
  owner: string;
  commander: string;
  roles: string[];
  /** Unused: the redemption deadline. Used: when the replay memory of the redeemed code ends. */
  expiresAt: number;
  used: boolean;
  /** The connection the code was redeemed for (revoked if the code is replayed). */
  connection?: string;
}

interface LiveConnection {
  record: StoredConnection;
  inflight: number;
  lastSeen: number;
  savedSeenAt: number;
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const secret = (prefix: string): string => `${prefix}${randomBytes(32).toString('base64url')}`;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache', ...headers },
  });
}

function oauthError(status: number, error: string, headers: Record<string, string> = {}): Response {
  return json(status, { error }, headers);
}

/** Authorization requests that cannot be redirected back (unknown client, bad redirect URI) end here. No input is reflected. */
function errorPage(error: string): Response {
  return new Response(`This sign-in request is invalid (${error}). Start again from your agent.\n`, {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'", 'referrer-policy': 'no-referrer' },
  });
}

/** Single-valued parameters: a repeated parameter is an invalid request (RFC 6749 §3.1, §3.2). */
function single(params: URLSearchParams): Map<string, string> | undefined {
  const out = new Map<string, string>();
  for (const [k, v] of params) {
    if (out.has(k)) return undefined;
    out.set(k, v);
  }
  return out;
}

async function readBody(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return undefined;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The OAuth 2.1 authorization server for `typedHost`'s MCP endpoint (see the module comment for its routes). */
export function createAuthorizationServer<M extends AnyManifest>(typedHost: PlayerThreeHost<M>, opts: AuthorizationServerOptions): AuthorizationServer {
  const host = typedHost as unknown as PlayerThreeHost;
  const manifest = host.definition.manifest;
  const roleList: readonly string[] = (manifest.roles as EnumS).values;
  const originOf = (raw: string | URL): string => {
    const u = new URL(raw);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
      throw new TypeError('playerthree/oauth: issuer and aliases must be http(s) origins without path');
    }
    return u.origin;
  };
  const issuer = originOf(opts.issuer);
  const origins = new Set([issuer, ...(opts.aliases ?? []).map(originOf)]);
  const mcpPath = opts.mcpPath ?? '/mcp';
  if (!mcpPath.startsWith('/')) throw new TypeError('playerthree/oauth: mcpPath must start with /');
  const resource = `${issuer}${mcpPath}`;
  const resources = new Set([...origins].map((o) => `${o}${mcpPath}`));
  const prmPath = `/.well-known/oauth-protected-resource${mcpPath}`;
  const resourceMetadataUrl = `${issuer}${prmPath}`;
  /** The configured origin a request was addressed to (proxy header first, then Host, then the URL), else `issuer`. */
  const requestOrigin = (request: Request | undefined): string => {
    if (!request || origins.size === 1) return issuer;
    const h = request.headers;
    const candidates: string[] = [];
    const fwdHost = h.get('x-forwarded-host')?.split(',')[0]?.trim();
    const fwdProto = h.get('x-forwarded-proto')?.split(',')[0]?.trim();
    if (fwdHost) candidates.push(...(fwdProto ? [`${fwdProto}://${fwdHost}`] : [`https://${fwdHost}`, `http://${fwdHost}`]));
    const hostHeader = h.get('host');
    if (hostHeader) candidates.push(`https://${hostHeader}`, `http://${hostHeader}`);
    candidates.push(new URL(request.url).origin);
    for (const c of candidates) {
      try {
        const o = new URL(c).origin;
        if (origins.has(o)) return o;
      } catch {
        // not a host
      }
    }
    return issuer;
  };
  const accessMs = (opts.accessTokenSeconds ?? 3600) * 1000;
  const refreshMs = (opts.refreshTokenSeconds ?? 30 * 86_400) * 1000;
  const allowLoopback = opts.allowLoopbackClients === true;
  const store = opts.store ?? (opts.dataDir !== undefined ? jsonConnectionStore(join(opts.dataDir, 'oauth', manifest.id)) : memoryConnectionStore());
  const report = (e: unknown) => opts.onError?.(e instanceof Error ? e : new Error(String(e)));

  const live = new Map<string, LiveConnection>();
  const changeListeners = new Set<(connection: string) => void>();
  const changed = (connection: string): void => {
    for (const listener of changeListeners) {
      try { listener(connection); } catch { /* Observers cannot interrupt credential changes. */ }
    }
  };
  /** access/refresh digest → connection id; retired refresh digests are marked. */
  const accessIndex = new Map<string, string>();
  const refreshIndex = new Map<string, { connection: string; retired: boolean }>();
  const clients = new Map<string, StoredClient>();
  const pending = new Map<string, PendingRequest>();
  const codes = new Map<string, IssuedCode>();
  const cimdCache = new Map<string, { result: CimdResult; expiresAt: number }>();
  const cimdInflight = new Map<string, Promise<CimdResult>>();
  let loaded = false;
  let closed = false;

  // ------------------------------------------------------------------ persistence

  let writes: Promise<void> = Promise.resolve();
  let inflightWrites = 0;
  const write = (fn: () => void | Promise<void>): void => {
    const failed = (e: unknown) => report(e);
    if (inflightWrites === 0) {
      let r: void | Promise<void>;
      try {
        r = fn();
      } catch (e) {
        failed(e);
        return;
      }
      if (!(r instanceof Promise)) return;
      inflightWrites++;
      writes = r.catch(failed).finally(() => void inflightWrites--);
      return;
    }
    inflightWrites++;
    writes = writes.then(fn).catch(failed).finally(() => void inflightWrites--);
  };
  const save = (c: LiveConnection): void => {
    c.record.lastSeenAt = c.lastSeen || null;
    c.savedSeenAt = c.lastSeen;
    const copy = structuredClone(c.record);
    write(() => store.saveConnection(copy));
  };

  const index = (c: StoredConnection): void => {
    for (const a of c.access) accessIndex.set(a.digest, c.id);
    refreshIndex.set(c.refresh.digest, { connection: c.id, retired: false });
    for (const r of c.retired) refreshIndex.set(r, { connection: c.id, retired: true });
  };
  const unindex = (c: StoredConnection): void => {
    for (const a of c.access) accessIndex.delete(a.digest);
    refreshIndex.delete(c.refresh.digest);
    for (const r of c.retired) refreshIndex.delete(r);
  };

  const drop = (id: string): void => {
    const c = live.get(id);
    if (!c) return;
    unindex(c.record);
    live.delete(id);
    changed(id);
    write(() => store.deleteConnection(id));
  };


  const init = (data: ConnectionStoreData): void => {
    const now = Date.now();
    for (const raw of data.clients ?? []) {
      if (raw?.registration !== 'dcr' || typeof raw.id !== 'string' || !Array.isArray(raw.redirectUris) || !raw.redirectUris.every(validRedirectUri)) continue;
      clients.set(raw.id, raw);
    }
    for (const raw of data.connections ?? []) {
      if (typeof raw?.id !== 'string' || !CONNECTION_ID_RE.test(raw.id) || typeof raw.owner !== 'string' || typeof raw.commander !== 'string' || typeof raw.authorizedAt !== 'number' || !Array.isArray(raw.roles) || !Array.isArray(raw.retired) || !Array.isArray(raw.access) || typeof raw.refresh?.digest !== 'string') throw new Error('playerthree/oauth: incompatible connection storage; reset operator data');
      if (!(raw.refresh.expiresAt > now)) {
        write(() => store.deleteConnection(raw.id));
        continue;
      }
      const record: StoredConnection = {
        ...raw,
        roles: Array.isArray(raw.roles) ? [...new Set(raw.roles.filter((r) => roleList.includes(r)))] : [],
        retired: Array.isArray(raw.retired) ? raw.retired.slice(-MAX_RETIRED) : [],
        access: Array.isArray(raw.access) ? raw.access.filter((a) => a.expiresAt > now).slice(-MAX_ACCESS) : [],
      };
      const c: LiveConnection = { record, inflight: 0, lastSeen: record.lastSeenAt ?? 0, savedSeenAt: record.lastSeenAt ?? 0 };
      live.set(record.id, c);
      index(record);
    }
    loaded = true;
  };

  let data: ConnectionStoreData | Promise<ConnectionStoreData>;
  try {
    data = store.load();
  } catch (e) {
    data = Promise.reject(e);
  }
  let ready: Promise<void>;
  if (data instanceof Promise) {
    ready = data.then(init);
    ready.catch(report);
  } else {
    init(data);
    ready = Promise.resolve();
  }

  const sweep = (): void => {
    const now = Date.now();
    for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id);
    for (const [d, c] of codes) if (c.expiresAt <= now) codes.delete(d);
    for (const [url, e] of cimdCache) if (e.expiresAt <= now) cimdCache.delete(url);
    if (!loaded) return;
    for (const c of [...live.values()]) {
      if (c.record.refresh.expiresAt <= now) drop(c.record.id);
      else {
        const before = c.record.access.length;
        c.record.access = c.record.access.filter((a) => {
          if (a.expiresAt > now) return true;
          accessIndex.delete(a.digest);
          return false;
        });
        if (c.record.access.length !== before) save(c);
      }
    }
    const used = new Set([...live.values()].map((c) => c.record.client.id));
    for (const [id, cl] of clients) {
      if (!used.has(id) && now - (cl.lastUsedAt ?? cl.createdAt) > CLIENT_IDLE_MS) {
        clients.delete(id);
        write(() => store.deleteClient(id));
      }
    }
  };
  const sweeper = setInterval(sweep, SWEEP_MS);
  sweeper.unref();

  // ------------------------------------------------------------------ clients

  /** CIMD documents are cached as their Cache-Control allows (1 min … 24 h); failures for 30 s. Fetches are deduplicated. */
  const cimd = async (clientId: string): Promise<CimdResult> => {
    const now = Date.now();
    const cached = cimdCache.get(clientId);
    if (cached && cached.expiresAt > now) return cached.result;
    let p = cimdInflight.get(clientId);
    if (!p) {
      p = fetchClientDocument(clientId, { allowLoopback }).finally(() => cimdInflight.delete(clientId));
      cimdInflight.set(clientId, p);
    }
    const result = await p;
    const ttl = result.ok ? result.maxAgeMs : CIMD_FAILURE_CACHE_MS;
    if (ttl > 0) {
      if (cimdCache.size >= MAX_CIMD_CACHE) cimdCache.delete(cimdCache.keys().next().value as string);
      cimdCache.set(clientId, { result, expiresAt: Date.now() + ttl });
    }
    return result;
  };

  const resolveClient = async (clientId: string): Promise<ClientDocument | undefined> => {
    if (clientIdUrl(clientId, allowLoopback)) {
      const r = await cimd(clientId);
      return r.ok ? r.document : undefined;
    }
    const c = clients.get(clientId);
    if (!c) return undefined;
    const { redirectUris, createdAt: _c, lastUsedAt: _l, ...info } = c;
    return { info, redirectUris };
  };

  const touchClient = (clientId: string): void => {
    const c = clients.get(clientId);
    if (!c) return;
    c.lastUsedAt = Date.now();
    const copy = structuredClone(c);
    write(() => store.saveClient(copy));
  };

  /**
   * Registration is anonymous, so a full client table must not refuse every new harness until CLIENT_IDLE_MS passes:
   * forget the least recently used registration that no connection, pending consent or unredeemed code refers to.
   * Returns false when every registration is in use.
   */
  const evictClient = (): boolean => {
    const inUse = new Set<string>();
    for (const c of live.values()) inUse.add(c.record.client.id);
    for (const p of pending.values()) inUse.add(p.client.id);
    for (const code of codes.values()) if (!code.used) inUse.add(code.request.client.id);
    let victim: StoredClient | undefined;
    for (const c of clients.values()) {
      if (inUse.has(c.id)) continue;
      if (!victim || (c.lastUsedAt ?? c.createdAt) < (victim.lastUsedAt ?? victim.createdAt)) victim = c;
    }
    if (!victim) return false;
    const id = victim.id;
    clients.delete(id);
    write(() => store.deleteClient(id));
    return true;
  };

  // ------------------------------------------------------------------ connections

  const parseRoles = (raw: unknown, min: number): string[] => {
    if (!Array.isArray(raw) || raw.length > roleList.length) throw new PlayerThreeError('invalid');
    const roles = [...new Set(raw)];
    if (roles.length !== raw.length || roles.length < min || !roles.every((r) => typeof r === 'string' && roleList.includes(r))) throw new PlayerThreeError('invalid');
    return roleList.filter((r) => roles.includes(r));
  };


  const status = (c: LiveConnection): ConnectionStatus => ({
    id: c.record.id,
    commander: c.record.commander,
    client: { ...c.record.client },
    roles: [...c.record.roles],
    createdAt: c.record.createdAt,
    authorizedAt: c.record.authorizedAt,
    lastSeenAt: c.lastSeen || null,
    active: c.inflight > 0 || Date.now() - c.lastSeen < ACTIVE_MS,
  });

  const owned = (owner: string, id: string): LiveConnection => {
    if (!loaded || typeof id !== 'string' || !CONNECTION_ID_RE.test(id)) throw new PlayerThreeError('invalid');
    const c = live.get(id);
    if (!c || c.record.owner !== owner) throw new PlayerThreeError('invalid');
    return c;
  };

  const issueTokens = (c: LiveConnection): Record<string, unknown> => {
    const now = Date.now();
    const access = secret(ACCESS_TOKEN_PREFIX);
    const refresh = secret(REFRESH_TOKEN_PREFIX);
    const r = c.record;
    if (r.refresh.digest) {
      refreshIndex.set(r.refresh.digest, { connection: r.id, retired: true });
      r.retired.push(r.refresh.digest);
      while (r.retired.length > MAX_RETIRED) refreshIndex.delete(r.retired.shift()!);
    }
    r.refresh = { digest: digest(refresh), expiresAt: now + refreshMs };
    refreshIndex.set(r.refresh.digest, { connection: r.id, retired: false });
    r.access = r.access.filter((a) => {
      if (a.expiresAt > now) return true;
      accessIndex.delete(a.digest);
      return false;
    });
    r.access.push({ digest: digest(access), expiresAt: now + accessMs });
    while (r.access.length > MAX_ACCESS) accessIndex.delete(r.access.shift()!.digest);
    accessIndex.set(r.access[r.access.length - 1]!.digest, r.id);
    save(c);
    changed(r.id);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(accessMs / 1000), refresh_token: refresh, scope: r.scope };
  };

  /** Redemption creates an independent connection for precisely the consented named commander. */
  const connectionFor = (code: IssuedCode): LiveConnection => {
    const now = Date.now();
    const id = `con_${randomBytes(12).toString('base64url')}`;
    const commander = host.commanders.roster(code.owner).find((entry) => entry.id === code.commander);
    const record: StoredConnection = {
      id,
      owner: code.owner,
      commander: code.commander,
      client: { ...code.request.client },
      roles: commander ? code.roles.filter((role) => commander.roles.includes(role)) : [],
      resource: code.request.resource,
      scope: OAUTH_SCOPE,
      createdAt: now,
      authorizedAt: now,
      lastSeenAt: null,
      refresh: { digest: '', expiresAt: 0 },
      retired: [],
      access: [],
    };
    const c: LiveConnection = { record, inflight: 0, lastSeen: 0, savedSeenAt: 0 };
    live.set(id, c);
    changed(id);
    return c;
  };

  // ------------------------------------------------------------------ endpoints

  const redirectBack = (p: PendingRequest, params: Record<string, string>): string => {
    const u = new URL(p.redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (p.state !== undefined) u.searchParams.set('state', p.state);
    // RFC 9207: the client checks it against the issuer it started with (mix-up defence).
    u.searchParams.set('iss', p.issuer);
    return u.href;
  };

  const resourceOk = (raw: string | undefined): boolean => {
    if (raw === undefined) return true;
    try {
      const u = new URL(raw);
      if (u.hash || raw.includes('#')) return false;
      const href = u.href.endsWith('/') && u.pathname !== '/' ? u.href.slice(0, -1) : u.href;
      return resources.has(href);
    } catch {
      return false;
    }
  };

  async function authorize(request: Request): Promise<Response> {
    const params = single(new URL(request.url).searchParams);
    if (!params) return errorPage('invalid_request');
    const clientId = params.get('client_id');
    if (!clientId) return errorPage('invalid_request');
    const client = await resolveClient(clientId);
    if (!client) return errorPage('invalid_client');
    let redirectUri = params.get('redirect_uri');
    if (redirectUri === undefined) {
      // Only an unambiguous, fixed registration may be used implicitly.
      const [only] = client.redirectUris;
      if (client.redirectUris.length !== 1 || !only || (new URL(only).protocol === 'http:')) return errorPage('invalid_request');
      redirectUri = only;
    }
    if (!validRedirectUri(redirectUri) || !client.redirectUris.some((r) => redirectMatches(r, redirectUri!))) return errorPage('invalid_redirect_uri');

    const state = params.get('state');
    const origin = requestOrigin(request);
    const p: PendingRequest = {
      id: randomBytes(24).toString('base64url'),
      client: client.info,
      redirectUri,
      state: state !== undefined && state.length <= MAX_STATE ? state : undefined,
      challenge: params.get('code_challenge') ?? '',
      resource: `${origin}${mcpPath}`,
      issuer: origin,
      expiresAt: Date.now() + CONSENT_TTL_MS,
    };
    const fail = (error: string) => new Response(null, { status: 302, headers: { location: redirectBack(p, { error }), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    if (state !== undefined && state.length > MAX_STATE) return fail('invalid_request');
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type');
    // PKCE is mandatory and S256 only (an absent method would mean `plain`).
    if (params.get('code_challenge_method') !== 'S256' || !SECRET_RE.test(p.challenge)) return fail('invalid_request');
    if (!resourceOk(params.get('resource'))) return fail('invalid_target');
    const scope = params.get('scope');
    if (scope !== undefined && scope.split(' ').some((s) => s !== '' && s !== OAUTH_SCOPE)) return fail('invalid_scope');
    if (!loaded || closed) return fail('temporarily_unavailable');
    sweep();
    // Full: forget the oldest request rather than refusing. Refusing would let one client flooding /oauth/authorize
    // (no sign-in needed) lock every player out of signing in for CONSENT_TTL_MS; evicting makes a flood outpace
    // real consent pages instead.
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
    pending.set(p.id, p);
    if (client.info.registration === 'dcr') touchClient(client.info.id);
    return new Response(null, { status: 302, headers: { location: new URL(opts.consentUrl(p.id), issuer).href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }

  /** Public clients only: client_id in the body, or HTTP Basic with the client id and an empty secret. */
  const clientOf = (request: Request, params: Map<string, string>): { ok: true; id: string | undefined } | { ok: false } => {
    const header = request.headers.get('authorization');
    let id = params.get('client_id');
    if (header) {
      const m = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header.trim());
      if (!m) return { ok: false };
      const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      let user: string;
      try {
        user = decodeURIComponent((colon === -1 ? decoded : decoded.slice(0, colon)).replace(/\+/g, ' '));
      } catch {
        return { ok: false };
      }
      const pass = colon === -1 ? '' : decoded.slice(colon + 1);
      // This server never issues client secrets.
      if (pass !== '' || (id !== undefined && id !== user)) return { ok: false };
      id = user;
    }
    return { ok: true, id };
  };

  async function token(request: Request): Promise<Response> {
    if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return oauthError(400, 'invalid_request');
    const body = await readBody(request);
    if (body === undefined) return oauthError(400, 'invalid_request');
    const params = single(new URLSearchParams(body));
    if (!params) return oauthError(400, 'invalid_request');
    const who = clientOf(request, params);
    if (!who.ok || !who.id) return oauthError(401, 'invalid_client');
    if (!loaded || closed) return oauthError(503, 'temporarily_unavailable');
    if (!resourceOk(params.get('resource'))) return oauthError(400, 'invalid_target');

    const grant = params.get('grant_type');
    if (grant === 'authorization_code') {
      const raw = params.get('code');
      if (!raw || !raw.startsWith(CODE_PREFIX)) return oauthError(400, 'invalid_grant');
      const d = digest(raw);
      const code = codes.get(d);
      if (!code) return oauthError(400, 'invalid_grant');
      if (code.used) {
        // A replayed code: revoke what the first redemption produced (OAuth 2.1 §4.1.3).
        codes.delete(d);
        if (code.connection) drop(code.connection);
        return oauthError(400, 'invalid_grant');
      }
      if (code.expiresAt <= Date.now()) {
        codes.delete(d);
        return oauthError(400, 'invalid_grant');
      }
      const verifier = params.get('code_verifier');
      const redirectUri = params.get('redirect_uri');
      const okClient = who.id === code.request.client.id;
      const okRedirect = redirectUri === code.request.redirectUri;
      const okVerifier =
        verifier !== undefined &&
        /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) &&
        timingSafeEqual(Buffer.from(createHash('sha256').update(verifier).digest('base64url')), Buffer.from(code.request.challenge));
      if (!okClient || !okRedirect || !okVerifier) {
        // The code is burnt either way: a wrong verifier must not be retried against it.
        codes.delete(d);
        return oauthError(400, 'invalid_grant');
      }
      const commander = host.commanders.has(code.owner) ? host.commanders.roster(code.owner).find((entry) => entry.id === code.commander) : undefined;
      if (!commander || !code.roles.every((role) => commander.roles.includes(role))) return oauthError(400, 'invalid_grant');
      if ([...live.values()].filter((connection) => connection.record.owner === code.owner).length >= MAX_CONNECTIONS_PER_OWNER) return oauthError(400, 'invalid_grant');
      code.used = true;
      code.expiresAt = Date.now() + CODE_REPLAY_MS;
      const c = connectionFor(code);
      code.connection = c.record.id;
      if (code.request.client.registration === 'dcr') touchClient(code.request.client.id);
      return json(200, issueTokens(c));
    }
    if (grant === 'refresh_token') {
      const raw = params.get('refresh_token');
      if (!raw || !raw.startsWith(REFRESH_TOKEN_PREFIX)) return oauthError(400, 'invalid_grant');
      const found = refreshIndex.get(digest(raw));
      const c = found ? live.get(found.connection) : undefined;
      if (!found || !c) return oauthError(400, 'invalid_grant');
      if (found.retired) {
        // Refresh token reuse: someone holds a copy. Revoke the whole grant (OAuth 2.1 §4.3.1).
        drop(c.record.id);
        return oauthError(400, 'invalid_grant');
      }
      if (c.record.client.id !== who.id || c.record.refresh.expiresAt <= Date.now()) return oauthError(400, 'invalid_grant');
      const scope = params.get('scope');
      if (scope !== undefined && scope.split(' ').some((s) => s !== '' && s !== OAUTH_SCOPE)) return oauthError(400, 'invalid_scope');
      return json(200, issueTokens(c));
    }
    return oauthError(400, grant === undefined ? 'invalid_request' : 'unsupported_grant_type');
  }

  async function register(request: Request): Promise<Response> {
    if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return oauthError(400, 'invalid_client_metadata');
    const body = await readBody(request);
    if (body === undefined) return oauthError(400, 'invalid_client_metadata');
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return oauthError(400, 'invalid_client_metadata');
    }
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return oauthError(400, 'invalid_client_metadata');
    if (m['token_endpoint_auth_method'] !== undefined && m['token_endpoint_auth_method'] !== 'none') return oauthError(400, 'invalid_client_metadata');
    const uris = m['redirect_uris'];
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20 || !uris.every(validRedirectUri)) return oauthError(400, 'invalid_redirect_uri');
    const grants = m['grant_types'];
    if (grants !== undefined && !(Array.isArray(grants) && grants.includes('authorization_code') && grants.every((g) => g === 'authorization_code' || g === 'refresh_token'))) {
      return oauthError(400, 'invalid_client_metadata');
    }
    const responses = m['response_types'];
    if (responses !== undefined && !(Array.isArray(responses) && responses.every((r) => r === 'code'))) return oauthError(400, 'invalid_client_metadata');
    if (!loaded || closed) return oauthError(503, 'temporarily_unavailable');
    sweep();
    if (clients.size >= MAX_CLIENTS && !evictClient()) return oauthError(503, 'temporarily_unavailable');
    const now = Date.now();
    const client: StoredClient = {
      id: `dcr_${randomBytes(18).toString('base64url')}`,
      registration: 'dcr',
      name: cleanText(m['client_name'], 100) ?? 'MCP client',
      redirectUris: [...(uris as string[])],
      createdAt: now,
      lastUsedAt: null,
    };
    const uri = httpsUrl(m['client_uri']);
    const logoUri = httpsUrl(m['logo_uri']);
    const softwareId = cleanText(m['software_id'], 100);
    const softwareVersion = cleanText(m['software_version'], 100);
    if (uri) client.uri = uri;
    if (logoUri) client.logoUri = logoUri;
    if (softwareId) client.softwareId = softwareId;
    if (softwareVersion) client.softwareVersion = softwareVersion;
    clients.set(client.id, client);
    const copy = structuredClone(client);
    write(() => store.saveClient(copy));
    return json(201, {
      client_id: client.id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(client.uri ? { client_uri: client.uri } : {}),
      ...(client.logoUri ? { logo_uri: client.logoUri } : {}),
      ...(client.softwareId ? { software_id: client.softwareId } : {}),
      ...(client.softwareVersion ? { software_version: client.softwareVersion } : {}),
    });
  }

  async function revoke(request: Request): Promise<Response> {
    if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return oauthError(400, 'invalid_request');
    const body = await readBody(request);
    const params = body === undefined ? undefined : single(new URLSearchParams(body));
    if (!params) return oauthError(400, 'invalid_request');
    const who = clientOf(request, params);
    if (!who.ok) return oauthError(401, 'invalid_client');
    const raw = params.get('token');
    if (!raw) return oauthError(400, 'invalid_request');
    if (!loaded) return oauthError(503, 'temporarily_unavailable');
    const d = digest(raw);
    const viaRefresh = refreshIndex.get(d);
    const id = viaRefresh?.connection ?? accessIndex.get(d);
    const c = id ? live.get(id) : undefined;
    // Unknown tokens are not an error (RFC 7009 §2.2).
    if (!c) return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
    if (who.id !== undefined && who.id !== c.record.client.id) return oauthError(401, 'invalid_client');
    if (viaRefresh) drop(c.record.id);
    else {
      accessIndex.delete(d);
      c.record.access = c.record.access.filter((a) => a.digest !== d);
      save(c);
      changed(c.record.id);
    }
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
  }

  const metadataHeaders = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600', vary: 'host, x-forwarded-host, x-forwarded-proto' };
  const protectedResource = (origin: string) => ({
    resource: `${origin}${mcpPath}`,
    authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: opts.resourceName ?? manifest.title,
  });
  const serverMetadata = (origin: string) => ({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });

  const routes: Record<string, { method: 'GET' | 'POST'; run: (r: Request) => Promise<Response> | Response }> = {
    [prmPath]: { method: 'GET', run: (r) => json(200, protectedResource(requestOrigin(r)), metadataHeaders) },
    '/.well-known/oauth-protected-resource': { method: 'GET', run: (r) => json(200, protectedResource(requestOrigin(r)), metadataHeaders) },
    '/.well-known/oauth-authorization-server': { method: 'GET', run: (r) => json(200, serverMetadata(requestOrigin(r)), metadataHeaders) },
    '/oauth/authorize': { method: 'GET', run: authorize },
    '/oauth/token': { method: 'POST', run: token },
    '/oauth/register': { method: 'POST', run: register },
    '/oauth/revoke': { method: 'POST', run: revoke },
  };

  const fetchHandler = async (request: Request): Promise<Response | undefined> => {
    const route = routes[new URL(request.url).pathname];
    if (!route) return undefined;
    if (request.method === 'OPTIONS' && route.method === 'GET') {
      return new Response(null, { status: 204, headers: { ...metadataHeaders, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'mcp-protocol-version' } });
    }
    if (request.method !== route.method && !(route.method === 'GET' && request.method === 'HEAD')) {
      return json(405, { error: 'invalid_request' }, { allow: route.method });
    }
    try {
      return await route.run(request);
    } catch (e) {
      report(e);
      return oauthError(500, 'server_error');
    }
  };

  return {
    issuer,
    resource,
    resourceMetadataUrl,
    ready,
    handles: (pathname) => Object.hasOwn(routes, pathname),
    fetch: fetchHandler,
    async handle(req, res) {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!Object.hasOwn(routes, pathname)) return false;
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const response = await fetchHandler(toWebRequest(req, abort.signal));
      await writeWebResponse(res, response!);
      return true;
    },

    consentRequest(id) {
      if (typeof id !== 'string' || !REQUEST_ID_RE.test(id)) return undefined;
      const p = pending.get(id);
      if (!p || p.expiresAt <= Date.now()) return undefined;
      const redirect = new URL(p.redirectUri);
      const out: ConsentRequest = {
        id: p.id,
        client: { ...p.client },
        redirect: { uri: p.redirectUri, host: redirect.host, loopback: redirect.protocol === 'http:' && isLoopbackHost(redirect.hostname) },
        roles: [...roleList],
        expiresAt: p.expiresAt,
      };
      if (p.client.registration === 'cimd') out.domain = new URL(p.client.id).host;
      return out;
    },

    resolveConsent(id, answer) {
      if (typeof id !== 'string' || !REQUEST_ID_RE.test(id)) throw new PlayerThreeError('invalid');
      const p = pending.get(id);
      if (!p || p.expiresAt <= Date.now()) throw new PlayerThreeError('invalid');
      if (answer === null || typeof answer !== 'object' || typeof answer.approve !== 'boolean') throw new PlayerThreeError('invalid');
      if (!answer.approve) {
        pending.delete(id);
        return { redirect: redirectBack(p, { error: 'access_denied' }) };
      }
      if (!host.commanders.has(answer.owner)) throw new PlayerThreeError('invalid');
      const commander = host.commanders.roster(answer.owner).find((entry) => entry.id === answer.commander);
      const roles = parseRoles(answer.roles, 1);
      if (!commander || !roles.every((role) => commander.roles.includes(role))) throw new PlayerThreeError('invalid');
      pending.delete(id);
      const raw = secret(CODE_PREFIX);
      codes.set(digest(raw), { request: p, owner: answer.owner, commander: answer.commander, roles, expiresAt: Date.now() + CODE_TTL_MS, used: false });
      return { redirect: redirectBack(p, { code: raw }) };
    },

    allConnections() {
      if (!loaded) return [];
      return [...live.values()].sort((a, b) => a.record.createdAt - b.record.createdAt).map((c) => ({ ...status(c), owner: c.record.owner }));
    },

    connections(owner) {
      if (!loaded) return [];
      return [...live.values()].filter((c) => c.record.owner === owner).sort((a, b) => a.record.createdAt - b.record.createdAt).map(status);
    },

    updateConnection(owner, id, patch) {
      const c = owned(owner, id);
      if (patch === null || typeof patch !== 'object') throw new PlayerThreeError('invalid');
      const roles = parseRoles(patch.roles, 0);
      const commander = host.commanders.roster(owner).find((entry) => entry.id === c.record.commander);
      if (!commander || !roles.every((role) => commander.roles.includes(role))) throw new PlayerThreeError('invalid');
      c.record.roles = roles;
      save(c);
      changed(id);
      return status(c);
    },

    revokeConnection(owner, id) {
      owned(owner, id);
      drop(id);
    },

    removeOwner(owner) {
      for (const c of [...live.values()]) if (c.record.owner === owner) drop(c.record.id);
    },

    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },

    verify(raw) {
      if (!loaded || closed || typeof raw !== 'string' || !raw.startsWith(ACCESS_TOKEN_PREFIX) || raw.length !== ACCESS_TOKEN_PREFIX.length + 43) return undefined;
      const d = digest(raw);
      const id = accessIndex.get(d);
      const c = id ? live.get(id) : undefined;
      if (!c) return undefined;
      const entry = c.record.access.find((a) => a.digest === d);
      // Audience: only tokens issued for this MCP endpoint.
      if (!entry || entry.expiresAt <= Date.now() || !resources.has(c.record.resource)) return undefined;
      const alive = () => live.get(c.record.id) === c && host.commanders.has(c.record.owner) && host.commanders.roster(c.record.owner).some((entry) => entry.id === c.record.commander);
      if (!alive()) return undefined;
      return {
        connection: c.record.id,
        owner: c.record.owner,
        commander: c.record.commander,
        roles: () => {
          if (!alive()) return [];
          const commander = host.commanders.roster(c.record.owner).find((entry) => entry.id === c.record.commander)!;
          return c.record.roles.filter((role) => commander.roles.includes(role));
        },
        holds: (role) => alive() && c.record.roles.includes(role) && host.commanders.roster(c.record.owner).some((entry) => entry.id === c.record.commander && entry.roles.includes(role)),
        activity(delta) {
          c.inflight = Math.max(0, c.inflight + delta);
          c.lastSeen = Date.now();
          if (alive() && c.lastSeen - c.savedSeenAt > SEEN_SAVE_MS) save(c);
        },
      };
    },

    challenge(invalid, request) {
      const metadata = `${requestOrigin(request)}${prmPath}`;
      return invalid
        ? `Bearer error="invalid_token", resource_metadata="${metadata}", scope="${OAUTH_SCOPE}"`
        : `Bearer resource_metadata="${metadata}", scope="${OAUTH_SCOPE}"`;
    },

    close() {
      closed = true;
      for (const id of live.keys()) changed(id);
      changeListeners.clear();
      clearInterval(sweeper);
      pending.clear();
      codes.clear();
    },
  };
}
