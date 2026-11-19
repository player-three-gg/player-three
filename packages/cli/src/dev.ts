/**
 * `playerthree dev`: run a game definition locally with everything an agent needs — PlayerThreeHost, the MCP endpoint and
 * DevTools — and print the links/commands to use them.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { surfaceHash } from 'playerthree';
import { mountDevtools } from 'playerthree/devtools';
import { createPlayerThreeHost } from 'playerthree/host';
import type { PlayerThreeHost, PlayerThreeMatch } from 'playerthree/host';
import type { GameDefinition } from 'playerthree';
import { mountMcp } from 'playerthree/mcp';

/** Listen address (default `127.0.0.1:8787`), the agent's seat and the match seed (default 1). */
export interface DevServerOptions {
  port?: number;
  host?: string;
  /** Seat handed to an agent: `team/role`. Default: first team, first role. */
  seat?: string;
  seed?: number;
  /** Start the clock immediately instead of when the agent first observes or acts. */
  startNow?: boolean;
}

export interface DevServer {
  readonly server: Server;
  readonly host: PlayerThreeHost;
  readonly match: PlayerThreeMatch;
  readonly url: string;
  readonly mcpUrl: string;
  /** Operator console (DevTools) deep link to this session; local mode, no credential (loopback only). */
  readonly devtoolsUrl: string;
  readonly seat: { team: string; role: string; token: string };
  /** True until the agent's first observe/act starts the match clock. */
  readonly waitsForAgent: boolean;
  close(): Promise<void>;
}

/** Serves `def` on one HTTP server — MCP at `/mcp`, DevTools at `/playerthree/devtools` — with one match whose seat `opts.seat` is agent-controlled and has a minted seat token. */
export async function startDevServer(def: GameDefinition, opts: DevServerOptions = {}): Promise<DevServer> {
  const m = def.manifest;
  const teams = m.teams.values as readonly string[];
  const roles = m.roles.values as readonly string[];
  const [team, role] = (opts.seat ?? `${teams[0]}/${roles[0]}`).split('/');
  if (!team || !role || !teams.includes(team) || !roles.includes(role)) {
    throw new Error(`--seat must be team/role with team in [${teams.join(', ')}] and role in [${roles.join(', ')}]`);
  }
  const host = createPlayerThreeHost({ definition: def });
  const server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('playerthree dev: try /playerthree/devtools or /mcp\n');
  });
  const mcp = mountMcp(server, host, { path: '/mcp' });
  const devtools = mountDevtools(server, host, { path: '/playerthree/devtools' });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8787, opts.host ?? '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const url = `http://${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}`;

  const match = host.createMatch({ seed: opts.seed ?? 1, realtime: false, controllers: { [team]: { [role]: 'agent' } } });
  const token = match.mintSeatToken(team, role);
  // The clock starts when the agent shows up, so setting up the harness does not burn the match.
  const stopWaiting = host.onTrace((e) => {
    if (e.match === match.id && (e.type === 'observe' || e.type === 'intent') && e.source === 'agent') {
      stopWaiting();
      match.start();
    }
  });
  if (opts.startNow) {
    stopWaiting();
    match.start();
  }
  return {
    server,
    host,
    match,
    url,
    mcpUrl: `${url}/mcp`,
    devtoolsUrl: `${url}/playerthree/devtools#sessions/${match.id}`,
    seat: { team, role, token },
    waitsForAgent: !opts.startNow,
    async close() {
      stopWaiting();
      devtools.close();
      await mcp.close();
      host.dispose();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** The terminal banner `playerthree dev` prints: the match, its links and harness setup for the seat. */
export function devBanner(d: DevServer, def: GameDefinition, color = false): string {
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const name = `${def.manifest.id}-${d.seat.role}`.replace(/[^a-z0-9-]+/g, '-');
  return [
    c('1', `playerthree dev — ${def.manifest.title} (${def.manifest.id}@${def.manifest.version})`),
    '',
    `  match        ${d.match.id}  (${def.manifest.tickRate} ticks/s; ${d.waitsForAgent ? 'the clock starts when your agent first observes or acts' : 'running'})`,
    `  your seat    ${d.seat.team}/${d.seat.role} → controller: agent (all other seats: built-in bots)`,
    `  MCP          ${d.mcpUrl}`,
    `  surfaceHash  ${surfaceHash(def.manifest)}`,
    '',
    c('1', '  DevTools (operator console, this machine only):'),
    `    ${c('36', d.devtoolsUrl)}`,
    '',
    c('1', '  Attach your agent:'),
    `    ${c('36', `claude mcp add --transport http ${name} ${d.mcpUrl} --header "Authorization: Bearer ${d.seat.token}"`)}`,
    `    or: npx --package @playerthree/runner playerthree-mcp --url ${d.mcpUrl} --token ${d.seat.token}`,
    '',
    '  Ctrl-C to stop.',
  ].join('\n');
}
