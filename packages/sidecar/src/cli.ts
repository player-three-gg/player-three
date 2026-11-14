/** `playerthree-sidecar`: run the sidecar host for one engine process (SPEC §20.8 (a)). */
import { parseArgs } from 'node:util';
import { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_HELLO_TIMEOUT_MS, type Transport } from './protocol.ts';
import { serveSidecar } from './serve.ts';

export const HELP = `playerthree-sidecar — PlayerThree host for a non-JS game server

Usage:
  playerthree-sidecar --stdio          [options]   the engine spawned this process; NDJSON on stdin/stdout
  playerthree-sidecar --socket <path>  [options]   listen on a Unix socket (0600) or \\\\.\\pipe\\<name>; one engine connects

Options:
  --port <n>            MCP HTTP port (default 8787, 0 = any free port; the URL is sent in "ready")
  --listen <addr>       MCP HTTP address (default 127.0.0.1)
  --call-timeout <ms>   deadline for each adapter call (default ${DEFAULT_CALL_TIMEOUT_MS}); a miss closes the connection
  --hello-timeout <ms>  deadline for the engine's hello (default ${DEFAULT_HELLO_TIMEOUT_MS})
  --data-dir <dir>      persist commanders and the commander log under <dir> (default: in memory)
  --devtools            also serve the operator console at /playerthree/devtools

Logs go to stderr; stdout belongs to the engine in --stdio mode. Exits when the engine disconnects:
0 after an orderly close, 1 after a protocol error, a timeout or a failed handshake.
`;

function positiveMs(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${flag} expects a positive integer (ms)`);
  return n;
}

export async function main(argv: string[], err: (text: string) => void = (t) => process.stderr.write(`${t}\n`)): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        stdio: { type: 'boolean' },
        socket: { type: 'string' },
        port: { type: 'string' },
        listen: { type: 'string' },
        'call-timeout': { type: 'string' },
        'hello-timeout': { type: 'string' },
        'data-dir': { type: 'string' },
        devtools: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (e) {
    err(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) {
    err(HELP);
    return 0;
  }
  if ((values.stdio === true) === (values.socket !== undefined)) {
    err(`exactly one of --stdio or --socket <path> is required\n\n${HELP}`);
    return 2;
  }
  const transport: Transport = values.socket !== undefined ? { kind: 'socket', path: values.socket } : { kind: 'stdio' };
  let port: number;
  let callTimeoutMs: number | undefined;
  let helloTimeoutMs: number | undefined;
  try {
    port = values.port === undefined ? 8787 : Number(values.port);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('--port expects 0..65535');
    callTimeoutMs = positiveMs(values['call-timeout'], '--call-timeout');
    helloTimeoutMs = positiveMs(values['hello-timeout'], '--hello-timeout');
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const served = await serveSidecar({
    transport,
    port,
    ...(values.listen !== undefined ? { listen: values.listen } : {}),
    ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
    ...(helloTimeoutMs !== undefined ? { helloTimeoutMs } : {}),
    ...(values['data-dir'] !== undefined ? { host: { dataDir: values['data-dir'] } } : {}),
    ...(values.devtools ? { devtools: true } : {}),
  });
  err(`playerthree-sidecar: MCP ${served.mcpUrl}; engine on ${transport.kind === 'socket' ? transport.path : 'stdio'}`);
  served.sidecar.ready.then(
    (host) => err(`playerthree-sidecar: ${host.definition.manifest.id}@${host.definition.manifest.version} ready`),
    () => {},
  );
  const stop = (): void => served.sidecar.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const closed = await served.sidecar.closed;
  await served.close();
  const handshook = await served.sidecar.ready.then(() => true, () => false);
  err(`playerthree-sidecar: engine connection closed (${closed.code ?? 'ok'}: ${closed.reason})`);
  return closed.code === undefined && handshook ? 0 : 1;
}
