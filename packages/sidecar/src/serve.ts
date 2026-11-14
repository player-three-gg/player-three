/** The sidecar with its MCP endpoint (and optional DevTools) on a local HTTP server: what the CLI and conformance run. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountDevtools } from 'playerthree/devtools';
import { mountMcp } from 'playerthree/mcp';
import { startSidecar, type Sidecar, type SidecarOptions } from './sidecar.ts';

export interface ServeSidecarOptions extends Omit<SidecarOptions, 'serve'> {
  /** MCP listen port (default 8787; 0 picks a free one). */
  port?: number;
  /** MCP listen address (default 127.0.0.1). */
  listen?: string;
  /** Also mount the operator console at /playerthree/devtools. */
  devtools?: boolean;
}

export interface ServedSidecar {
  readonly sidecar: Sidecar;
  readonly server: Server;
  /** `http://host:port/mcp`, also sent to the engine in `ready.mcp`. */
  readonly mcpUrl: string;
  /** Closes the engine connection and the HTTP server. */
  close(): Promise<void>;
}

export async function serveSidecar(opts: ServeSidecarOptions): Promise<ServedSidecar> {
  const mounted: { close(): unknown }[] = [];
  // MCP (and DevTools) take over their paths once the engine's manifest is known; everything else lands here.
  const server = createServer((_req, res) => {
    const waiting = mounted.length === 0;
    res.writeHead(waiting ? 503 : 404, { 'content-type': 'text/plain' });
    res.end(waiting ? 'playerthree-sidecar: waiting for the engine handshake\n' : 'playerthree-sidecar: try /mcp\n');
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(opts.port ?? 8787, opts.listen ?? '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const addr = server.address() as AddressInfo;
  const mcpUrl = `http://${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}/mcp`;
  const { port: _port, listen: _listen, devtools, ...sidecarOpts } = opts;
  let sidecar: Sidecar;
  try {
    sidecar = await startSidecar({
      ...sidecarOpts,
      serve: (host) => {
        mounted.push(mountMcp(server, host, { path: '/mcp' }));
        if (devtools) mounted.push(mountDevtools(server, host, { path: '/playerthree/devtools' }));
        return mcpUrl;
      },
    });
  } catch (e) {
    server.close();
    throw e;
  }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      sidecar.close();
      await sidecar.closed;
      for (const m of mounted) await m.close();
      server.closeAllConnections();
      const done = Promise.withResolvers<void>();
      server.close(() => done.resolve());
      await done.promise;
    })());
  return { sidecar, server, mcpUrl, close };
}
