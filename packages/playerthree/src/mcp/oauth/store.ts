/**
 * Storage behind the MCP authorization server: OAuth connections (owner + roles + token digests) and dynamically
 * registered clients. In memory by default, JSON files under `dataDir`, or the game's own database.
 * Tokens are never stored, only their SHA-256 digests.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** How the client identified itself: a Client ID Metadata Document URL, or Dynamic Client Registration. */
export type ClientRegistration = 'cimd' | 'dcr';

/** Client metadata as the authorization server validated it. Self-asserted for `dcr`; `cimd` is served by `id`'s host. */
export interface OAuthClientInfo {
  /** The OAuth `client_id`: the metadata document URL (`cimd`) or the id this server issued (`dcr`). */
  id: string;
  registration: ClientRegistration;
  /** `client_name`, control characters removed, at most 100 characters. */
  name: string;
  uri?: string;
  logoUri?: string;
  softwareId?: string;
  softwareVersion?: string;
}

export interface StoredTokenDigest {
  /** SHA-256 hex of the token. */
  digest: string;
  /** ms since epoch */
  expiresAt: number;
}

export interface StoredConnection {
  /** `con_` + 16 base64url characters. */
  id: string;
  /** The game's owner id (`OWNER_RE`): the player who approved the connection. */
  owner: string;
  client: OAuthClientInfo;
  /** Exact named commander selected on the authenticated consent page. */
  commander: string;
  /** Granted subset of that commander's compatible manifest roles. */
  roles: string[];
  /** The resource (MCP endpoint URL) the tokens are bound to. */
  resource: string;
  scope: string;
  createdAt: number;
  /** Last consent for this exact named commander connection. */
  authorizedAt: number;
  lastSeenAt: number | null;
  /** The current refresh token. */
  refresh: StoredTokenDigest;
  /** Rotated-away refresh tokens: presenting one again revokes the connection (refresh token reuse). */
  retired: string[];
  /** Live access tokens (newest last). */
  access: StoredTokenDigest[];
}

/** A client registered through `POST /oauth/register` (RFC 7591). */
export interface StoredClient extends OAuthClientInfo {
  registration: 'dcr';
  redirectUris: string[];
  createdAt: number;
  /** Last authorization or token request (ms since epoch), or null. */
  lastUsedAt: number | null;
}

export interface ConnectionStoreData {
  connections: StoredConnection[];
  clients: StoredClient[];
}

/** Every method may be sync or async; writes are issued in order. */
export interface ConnectionStore {
  load(): ConnectionStoreData | Promise<ConnectionStoreData>;
  saveConnection(connection: StoredConnection): void | Promise<void>;
  deleteConnection(id: string): void | Promise<void>;
  saveClient(client: StoredClient): void | Promise<void>;
  deleteClient(id: string): void | Promise<void>;
}

/** In-memory connection store (the default): connections and registered clients are lost on restart. */
export function memoryConnectionStore(): ConnectionStore {
  const connections = new Map<string, StoredConnection>();
  const clients = new Map<string, StoredClient>();
  return {
    load: () => ({ connections: [...connections.values()].map((c) => structuredClone(c)), clients: [...clients.values()].map((c) => structuredClone(c)) }),
    saveConnection(c) {
      connections.set(c.id, structuredClone(c));
    },
    deleteConnection(id) {
      connections.delete(id);
    },
    saveClient(c) {
      clients.set(c.id, structuredClone(c));
    },
    deleteClient(id) {
      clients.delete(id);
    },
  };
}

/** `<dir>/connections.json`, written atomically (temp file + rename) with mode 0600. */
export function jsonConnectionStore(dir: string): ConnectionStore {
  const file = join(dir, 'connections.json');
  const connections = new Map<string, StoredConnection>();
  const clients = new Map<string, StoredClient>();
  const flush = (): void => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, connections: [...connections.values()], clients: [...clients.values()] }), { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    load() {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!existsSync(file)) return { connections: [], clients: [] };
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { connections?: unknown; clients?: unknown };
      if (!Array.isArray(raw.connections) || !Array.isArray(raw.clients)) throw new Error('playerthree/oauth: malformed connections.json');
      for (const c of raw.connections as StoredConnection[]) if (typeof c?.id === 'string') connections.set(c.id, c);
      for (const c of raw.clients as StoredClient[]) if (typeof c?.id === 'string') clients.set(c.id, c);
      return { connections: [...connections.values()].map((c) => structuredClone(c)), clients: [...clients.values()].map((c) => structuredClone(c)) };
    },
    saveConnection(c) {
      connections.set(c.id, structuredClone(c));
      flush();
    },
    deleteConnection(id) {
      if (connections.delete(id)) flush();
    },
    saveClient(c) {
      clients.set(c.id, structuredClone(c));
      flush();
    },
    deleteClient(id) {
      if (clients.delete(id)) flush();
    },
  };
}
