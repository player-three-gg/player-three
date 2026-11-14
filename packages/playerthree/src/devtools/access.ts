/**
 * Who may use the operator console. Exactly one mode is active per mount:
 *
 * - `local` (default, no credential): for development on the developer's own machine.
 * - `authorize`: the game passes `authorize(req)`, backed by its own admin authentication (session cookie, SSO, …).
 * - `token`: the game passes a long static `operatorToken`, sent as `Authorization: Bearer …`.
 *
 * Player credentials (team owner, seat, spectator, commander tokens, OAuth access tokens) never grant access in any
 * mode: they are never looked up here.
 *
 * Threat model
 * ------------
 * The console shows every side's unfogged state and can end sessions, rotate commander tokens and revoke agent
 * connections, so it must only answer the developer/operator.
 *
 * Local mode trusts "a process on this machine talking to us directly". It rejects:
 * - remote peers: the TCP peer must be loopback (127.0.0.0/8, ::1, ::ffff:127.x);
 * - anything that came through a proxy (Forwarded, Via, X-Forwarded-*, X-Real-IP, …): a reverse proxy on the same
 *   machine would otherwise make every public request look local. A same-host proxy MUST add one of these headers
 *   (all common proxies can), or the deployment must mount the console with `authorize`/`operatorToken`;
 * - DNS rebinding: a hostile page whose domain resolves to 127.0.0.1 is same-origin with itself, so its requests reach
 *   us carrying its own `Host`. Only `localhost`, `127.0.0.1` and `[::1]` (any port) are accepted;
 * - cross-site requests from pages the developer visits (CSRF, drive-by reads): `Sec-Fetch-Site` (set by the browser,
 *   unforgeable by scripts), when present, must be `same-origin`; `Origin`, when present, must be a loopback origin
 *   (any port: dev servers such as Vite proxy the console from another local port). State-changing requests must carry
 *   one of the two and a JSON body, which a cross-origin page cannot send without a CORS preflight we never answer.
 * Local non-browser tools (curl, scripts) send neither header and may read; to change state they send an `Origin`.
 *
 * Token mode: the bearer token is not ambient (no cookie), so cross-site pages cannot use it. It is compared in
 * constant time (SHA-256 digests + timingSafeEqual) and only accepted over HTTPS (TLS socket, or `X-Forwarded-Proto:
 * https` from the TLS-terminating proxy) or from a direct loopback peer, so it is never sent in clear over a network.
 * It never appears in URLs: the page asks for it once and keeps it in sessionStorage (this tab only).
 *
 * Authorize mode: the game's hook decides (typically from its admin session cookie). Because cookies are ambient,
 * state-changing requests additionally need a same-origin `Sec-Fetch-Site`/`Origin` and a JSON body.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';

/** The active operator access mode (see the module comment). */
export type OperatorAccessMode = 'local' | 'token' | 'authorize';

/** Operator console access: at most one of `authorize` or `operatorToken` (production); neither means `local`. */
export interface OperatorAccessOptions {
  /**
   * Production: your own admin authentication. Resolve true to let the request in (for example: a valid admin session
   * cookie). Called for the page and every API request.
   */
  authorize?: (req: IncomingMessage) => boolean | Promise<boolean>;
  /**
   * Production fallback: a long static secret (32–512 printable ASCII characters, e.g. `openssl rand -base64 32`).
   * Accepted only over HTTPS or from a direct loopback peer.
   */
  operatorToken?: string;
}

/** `page`: the static console page; `read`: GET API/stream; `write`: state-changing POST. */
export type RequestKind = 'page' | 'read' | 'write';

export interface Denial {
  status: number;
  error: string;
  message: string;
}

export interface OperatorAccess {
  readonly mode: OperatorAccessMode;
  /** undefined: allowed. */
  check(req: IncomingMessage, kind: RequestKind): Promise<Denial | undefined>;
}

const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const PROXY_HEADERS = ['forwarded', 'via', 'x-real-ip', 'x-client-ip', 'true-client-ip', 'cf-connecting-ip', 'fastly-client-ip'];
const TOKEN_RE = /^[\x21-\x7e]{32,512}$/;

function loopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function proxied(req: IncomingMessage): boolean {
  return Object.keys(req.headers).some((h) => h.startsWith('x-forwarded-') || PROXY_HEADERS.includes(h));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/** Host part (`name[:port]`) of an Origin header, or undefined when absent/unparseable/`null`. */
function originHost(origin: string): string | undefined {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : undefined;
  } catch {
    return undefined;
  }
}

const deny = (status: number, error: string, message: string): Denial => ({ status, error, message });

const CROSS_SITE = deny(403, 'forbidden_origin', 'Cross-site request refused: open the console page itself and use it from there.');
const JSON_REQUIRED = deny(415, 'json_required', 'State-changing requests must send a JSON body (content-type: application/json).');
const JSON_BODY = /^application\/json\s*(?:;|$)/i;

/**
 * Browser context checks shared by every mode. `sameHost(host)` decides whether an Origin's host belongs to us.
 * Reads: a present Sec-Fetch-Site must be same-origin, a present Origin must be ours. Writes: additionally require one
 * of the two (browsers always send them on POST) and a JSON body (cross-origin JSON POSTs need a CORS preflight).
 */
function browserCheck(req: IncomingMessage, kind: RequestKind, sameHost: (host: string) => boolean): Denial | undefined {
  if (kind === 'page') return undefined;
  const site = header(req, 'sec-fetch-site');
  const origin = header(req, 'origin');
  if (site !== undefined && site !== 'same-origin') return CROSS_SITE;
  if (origin !== undefined) {
    const host = originHost(origin);
    if (!host || !sameHost(host)) return CROSS_SITE;
  }
  if (kind === 'write') {
    if (site === undefined && origin === undefined) return CROSS_SITE;
    if (!JSON_BODY.test(header(req, 'content-type') ?? '')) return JSON_REQUIRED;
  }
  return undefined;
}

/** Validates the options (throws on misconfiguration, at mount time) and returns the active access mode. */
export function createOperatorAccess(opts: OperatorAccessOptions): OperatorAccess {
  if (opts.authorize !== undefined && opts.operatorToken !== undefined) {
    throw new TypeError('playerthree/devtools: pass either `authorize` or `operatorToken`, not both (exactly one access mode is active).');
  }
  if (opts.authorize !== undefined && typeof opts.authorize !== 'function') {
    throw new TypeError('playerthree/devtools: `authorize` must be a function (req) => boolean | Promise<boolean>.');
  }
  if (opts.operatorToken !== undefined && (typeof opts.operatorToken !== 'string' || !TOKEN_RE.test(opts.operatorToken))) {
    throw new TypeError('playerthree/devtools: `operatorToken` must be 32–512 printable ASCII characters without spaces (e.g. `openssl rand -base64 32`).');
  }

  if (opts.authorize) {
    const authorize = opts.authorize;
    return {
      mode: 'authorize',
      async check(req, kind) {
        let ok: boolean;
        try {
          ok = (await authorize(req)) === true;
        } catch (error) {
          console.error('playerthree/devtools: authorize() threw; request refused', error);
          return deny(500, 'internal', 'The game\'s authorize() hook failed. See the server log.');
        }
        if (!ok) return deny(403, 'forbidden', 'Your account is not allowed to use the operator console.');
        const ours = new Set([header(req, 'host'), header(req, 'x-forwarded-host')?.split(',')[0]?.trim()].filter((h) => h).map((h) => h!.toLowerCase()));
        return browserCheck(req, kind, (host) => ours.has(host.toLowerCase()));
      },
    };
  }

  if (opts.operatorToken !== undefined) {
    const expected = createHash('sha256').update(opts.operatorToken).digest();
    return {
      mode: 'token',
      async check(req, kind) {
        const tls = (req.socket as TLSSocket).encrypted === true;
        const forwardedHttps = header(req, 'x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https';
        if (!tls && !forwardedHttps && !(loopbackPeer(req) && !proxied(req))) {
          return deny(403, 'https_required', 'The operator token is only accepted over HTTPS (or directly from this machine).');
        }
        if (kind === 'page') return undefined;
        const site = header(req, 'sec-fetch-site');
        if (site !== undefined && site !== 'same-origin') return CROSS_SITE;
        const given = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header(req, 'authorization') ?? '')?.[1];
        if (!given || !timingSafeEqual(createHash('sha256').update(given).digest(), expected)) {
          return deny(401, 'unauthorized', 'Operator token missing or wrong.');
        }
        // The bearer token is not ambient (cross-site pages cannot send it), so only the body type is checked.
        if (kind === 'write' && !JSON_BODY.test(header(req, 'content-type') ?? '')) return JSON_REQUIRED;
        return undefined;
      },
    };
  }

  return {
    mode: 'local',
    async check(req, kind) {
      if (!loopbackPeer(req) || proxied(req)) {
        return deny(403, 'loopback_only', 'Without `authorize` or `operatorToken` the operator console only answers direct requests from this machine (http://localhost).');
      }
      if (!LOOPBACK_HOST.test(header(req, 'host') ?? '')) {
        return deny(403, 'forbidden_host', 'Open the console at http://localhost (or 127.0.0.1 / [::1]); other host names are refused.');
      }
      return browserCheck(req, kind, (host) => LOOPBACK_HOST.test(host));
    },
  };
}
