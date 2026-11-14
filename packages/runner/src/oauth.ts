/**
 * Browser sign-in for the bridge and the runner: `--url` only, no token to paste.
 *
 * An OAuth 2.1 public client (PKCE S256, RFC 9207 `iss` check, refresh token rotation — all done by the MCP SDK's
 * `auth()`), registered dynamically with the game's authorization server and redirected to a one-shot loopback
 * listener on 127.0.0.1 (RFC 8252). The sign-in URL is opened in the browser and printed. Client registration and
 * tokens are cached per server in the user config dir (`oauth.json`, mode 0600), so later runs start silently.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  SdkHttpError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { PACKAGE_VERSION } from './version.ts';

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export type SignInErrorCode = 'declined' | 'timeout' | 'bad_callback' | 'rejected';

/** Sign-in failed. `code` is closed; no remote text is carried. */
export class SignInError extends Error {
  readonly code: SignInErrorCode;
  constructor(code: SignInErrorCode) {
    super(code);
    this.name = 'SignInError';
    this.code = code;
  }
}

/** The playerthree config dir: `PLAYERTHREE_CONFIG_DIR`, else the platform's user config dir. */
export function configDir(): string {
  const override = process.env['PLAYERTHREE_CONFIG_DIR'];
  if (override) return override;
  if (process.platform === 'win32') return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'playerthree');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'playerthree');
  return join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'playerthree');
}

interface CacheEntry {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

function readCache(file: string): CacheFile {
  if (!existsSync(file)) return { version: 1, entries: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheFile>;
    return raw.version === 1 && raw.entries && typeof raw.entries === 'object' ? (raw as CacheFile) : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeCache(file: string, cache: CacheFile): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}

/** Opens a URL in the default browser without a shell. Failures are ignored (the URL is printed as well). */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // printed below
  }
}

/** Options of {@link browserSignIn}. */
export interface BrowserSignInOptions {
  /** The MCP endpoint. */
  url: string | URL;
  /** `client_name` registered with the server (e.g. `playerthree-mcp`). */
  clientName: string;
  /** `software_id` registered with the server (e.g. `dev.playerthree.bridge`): how the game recognizes the client. */
  softwareId: string;
  /** Default `<configDir>/oauth.json`. */
  cacheFile?: string;
  /** Default true. */
  openBrowser?: boolean;
  /** Where the sign-in URL is printed (stderr in the CLIs). */
  log(line: string): void;
}

/** An OAuth client for one MCP endpoint with a loopback redirect listener. */
export interface BrowserSignIn {
  readonly provider: OAuthClientProvider;
  /** Whether a sign-in is cached for this endpoint. */
  readonly signedIn: boolean;
  /** Resolves with the authorization callback's parameters (state checked) once the browser returns. */
  callback(): Promise<URLSearchParams>;
  /** Forget the cached registration and tokens for this endpoint. */
  forget(): void;
  /** Stops the loopback listener. */
  close(): void;
}

/** Prepares browser sign-in for one MCP endpoint: a cached OAuth client provider plus a loopback listener on 127.0.0.1 for the redirect. */
export async function browserSignIn(opts: BrowserSignInOptions): Promise<BrowserSignIn> {
  const file = opts.cacheFile ?? join(configDir(), 'oauth.json');
  const key = `${opts.clientName} ${new URL(opts.url).href}`;
  const entry = (): CacheEntry => readCache(file).entries[key] ?? {};
  const update = (patch: (e: CacheEntry) => void): void => {
    const cache = readCache(file);
    const e = cache.entries[key] ?? {};
    patch(e);
    cache.entries[key] = e;
    writeCache(file, cache);
  };

  let expectedState: string | undefined;
  let verifier: string | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  const waiting = Promise.withResolvers<URLSearchParams>();
  waiting.promise.catch(() => {});

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || u.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const page = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`${text}\n`);
    };
    // Only the response to the request this process started counts.
    if (expectedState === undefined || u.searchParams.get('state') !== expectedState) return page(400, 'This sign-in response does not belong to the running playerthree session.');
    expectedState = undefined;
    if (u.searchParams.has('error')) {
      page(200, 'Sign-in was not completed. You can close this tab.');
      waiting.reject(new SignInError(u.searchParams.get('error') === 'access_denied' ? 'declined' : 'rejected'));
      return;
    }
    if (!u.searchParams.get('code')) {
      page(400, 'The sign-in response is incomplete.');
      waiting.reject(new SignInError('bad_callback'));
      return;
    }
    page(200, 'Signed in. You can close this tab and return to your agent.');
    waiting.resolve(u.searchParams);
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const redirectUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  const clientMetadata: OAuthClientMetadata = {
    client_name: opts.clientName,
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    software_id: opts.softwareId,
    software_version: PACKAGE_VERSION,
    application_type: 'native',
  } as OAuthClientMetadata;

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata;
    },
    state() {
      expectedState = randomBytes(24).toString('base64url');
      return expectedState;
    },
    clientInformation: () => entry().client,
    saveClientInformation(info) {
      update((e) => {
        e.client = info;
      });
    },
    tokens: () => entry().tokens,
    saveTokens(tokens) {
      update((e) => {
        e.tokens = tokens;
      });
    },
    redirectToAuthorization(authorizationUrl) {
      const href = authorizationUrl.href;
      opts.log(`Sign in to command your roles: ${href}`);
      if (opts.openBrowser !== false) openBrowser(href);
    },
    saveCodeVerifier(v) {
      verifier = v;
    },
    codeVerifier() {
      if (verifier === undefined) throw new SignInError('bad_callback');
      return verifier;
    },
    saveDiscoveryState(state) {
      discovery = state;
    },
    discoveryState: () => discovery,
    invalidateCredentials(scope) {
      if (scope === 'verifier') verifier = undefined;
      else if (scope === 'discovery') discovery = undefined;
      else {
        update((e) => {
          if (scope === 'all' || scope === 'tokens') delete e.tokens;
          if (scope === 'all' || scope === 'client') delete e.client;
        });
      }
    },
  };

  return {
    provider,
    get signedIn() {
      return entry().tokens !== undefined;
    },
    callback() {
      const timer = setTimeout(() => waiting.reject(new SignInError('timeout')), SIGN_IN_TIMEOUT_MS);
      timer.unref();
      return waiting.promise.finally(() => clearTimeout(timer));
    },
    forget() {
      update((e) => {
        delete e.tokens;
        delete e.client;
      });
    },
    close() {
      server.close();
    },
  };
}

/** How a client authenticates to the endpoint: a pasted seat/commander token, or browser sign-in. */
export type EndpointAuth = { token: string } | { signIn: BrowserSignIn };

/**
 * Modern MCP discovery is stateless; a temporary seat acquires its authority lease on the first real request.
 * The SDK only manages session headers for initialize handshakes, so retain this endpoint lease explicitly.
 */
class SeatLeaseTransport extends StreamableHTTPClientTransport {
  private readonly lease: { id?: string; headers?: Headers };
  private readonly endpoint: URL;

  constructor(url: URL, auth: EndpointAuth) {
    const lease: { id?: string; headers?: Headers } = {};
    super(url, {
      authProvider: 'token' in auth ? { token: async () => auth.token } : auth.signIn.provider,
      requestInit: { redirect: 'error' },
      fetch: async (input, init) => {
        const target = input instanceof Request ? input.url : input.toString();
        if (target !== url.href) return fetch(input, init);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (lease.id !== undefined) headers.set('mcp-session-id', lease.id);
        const response = await fetch(input, { ...init, headers });
        if (response.ok) {
          const issued = response.headers.get('mcp-session-id');
          if (issued !== null) {
            if (lease.id !== undefined && lease.id !== issued) throw new Error('playerthree: seat lease changed');
            lease.id = issued;
          }
          lease.headers = headers;
        }
        return response;
      },
    });
    this.lease = lease;
    this.endpoint = url;
  }

  override get sessionId(): string | undefined {
    return this.lease.id;
  }

  override async terminateSession(): Promise<void> {
    if (this.lease.id === undefined) return;
    const headers = new Headers(this.lease.headers);
    headers.set('mcp-session-id', this.lease.id);
    const response = await fetch(this.endpoint, { method: 'DELETE', headers, redirect: 'error' });
    if (!response.ok) {
      throw new SdkHttpError(SdkErrorCode.ClientHttpFailedToTerminateSession, 'Failed to release seat lease', { status: response.status });
    }
    this.lease.id = undefined;
  }
}
/**
 * Connects a fresh client from `makeClient()` to `url`. With browser sign-in, an endpoint answering 401 starts the
 * sign-in (once): after the browser returns, the code is redeemed and a fresh client connects.
 * Throws `UnauthorizedError` when the endpoint rejects the credential, `SignInError` when sign-in fails.
 */
export async function connectClient(url: URL, auth: EndpointAuth, makeClient: () => Client): Promise<Client> {
  const attempt = async (): Promise<{ client: Client; transport: StreamableHTTPClientTransport } | { unauthorized: StreamableHTTPClientTransport }> => {
    const client = makeClient();
    const transport = new SeatLeaseTransport(url, auth);
    const close = client.close.bind(client);
    let closing: Promise<void> | undefined;
    client.close = () => closing ??= (async () => {
      try {
        // SDK close only drops the local streams. DELETE releases the server's first-use-bound lease.
        if (transport.sessionId !== undefined) await transport.terminateSession();
      } catch (error) {
        // A revoked/expired credential or an absent/gone session is already released.
        // Match end can revoke the lease before this explicit DELETE reaches the endpoint.
        if (!SdkHttpError.isInstance(error) ||
            (error.status !== 401 && error.status !== 403 && error.status !== 404 && error.status !== 410)) throw error;
      } finally {
        await close();
      }
    })();
    try {
      await client.connect(transport);
      return { client, transport };
    } catch (e) {
      await client.close().catch(() => {});
      if ('signIn' in auth && UnauthorizedError.isInstance(e)) return { unauthorized: transport };
      throw e;
    }
  };
  const first = await attempt();
  if ('client' in first) return first.client;
  if ('token' in auth) throw new UnauthorizedError();
  const params = await auth.signIn.callback();
  await first.unauthorized.finishAuth(params);
  const second = await attempt();
  if ('client' in second) return second.client;
  throw new UnauthorizedError();
}
