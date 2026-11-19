/**
 * The engine connection's I/O thread. The host's adapter calls are synchronous (§10), so the main thread blocks in
 * `Atomics.wait` while this thread keeps reading the engine's stream: the pending call's result goes back over the
 * dedicated sync port plus an `Atomics.notify`; every other engine message is posted to the main thread's event loop.
 */
import { createReadStream, createWriteStream, fstatSync, unlinkSync } from 'node:fs';
import { createServer, Socket, type Server } from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';
import type { Readable, Writable } from 'node:stream';
import { SIGNAL_CLOSED, SIGNAL_RESULT, type FromWorker, type LinkWorkerData, type ToWorker } from './link-messages.ts';
import { ENGINE_OPS, encodeLine, isId, LineDecoder, parseLine, type FatalCode } from './protocol.ts';

const data = workerData as LinkWorkerData;
const port = parentPort!;
const ctrl = new Int32Array(data.ctrl);
const ops: readonly string[] = ENGINE_OPS;

let input: Readable | undefined;
let output: Writable | undefined;
let server: Server | undefined;
let pending: number | undefined;
let closed = false;
const decoder = new LineDecoder();
const lines: string[] = [];

const post = (m: FromWorker): void => port.postMessage(m);

function signal(state: number): void {
  Atomics.store(ctrl, 0, state);
  Atomics.notify(ctrl, 0);
}

/** Closes once: a fatal notice (if any) is flushed before the stream ends. */
function close(reason: string, code?: FatalCode, message?: string): void {
  if (closed) return;
  closed = true;
  pending = undefined;
  signal(SIGNAL_CLOSED);
  if (code !== undefined && output && !output.destroyed) output.write(encodeLine(message === undefined ? { op: 'error', code } : { op: 'error', code, message }));
  output?.end();
  input?.destroy();
  closeServer();
  post(code === undefined ? { t: 'closed', reason } : { t: 'closed', reason, code });
}

function closeServer(): void {
  if (!server || data.transport.kind !== 'socket') return;
  server.close();
  server = undefined;
  if (process.platform !== 'win32') {
    try {
      unlinkSync(data.transport.path);
    } catch {
      // Already gone.
    }
  }
}

function onChunk(chunk: Buffer): void {
  if (closed) return;
  const status = decoder.push(chunk, lines);
  for (const line of lines) {
    if (closed) break;
    onLine(line);
  }
  lines.length = 0;
  if (status === 'too_large') close('engine sent an oversized line', 'too_large');
  else if (status === 'bad_utf8') close('engine sent invalid UTF-8', 'bad_frame', 'invalid UTF-8');
}

function onLine(line: string): void {
  const msg = parseLine(line);
  if (!msg) return close('engine sent a non-object line', 'bad_frame', 'not a JSON object');
  const op = msg.op;
  if (typeof op !== 'string' || !ops.includes(op)) return close('engine sent an unknown op', 'bad_frame', 'unknown op');
  if (op !== 'result') return post({ t: 'msg', msg });
  if (!isId(msg.id) || msg.id !== pending) return close('engine answered a call that is not outstanding', 'bad_frame', 'result id is not outstanding');
  pending = undefined;
  data.sync.postMessage(msg);
  signal(SIGNAL_RESULT);
}

function attach(read: Readable, write: Writable): void {
  input = read;
  output = write;
  read.on('data', (chunk: Buffer) => onChunk(chunk));
  read.once('end', () => close('engine closed the connection'));
  read.once('error', (e: Error) => close(`engine connection error: ${e.message}`));
  write.once('error', (e: Error) => close(`engine connection error: ${e.message}`));
  post({ t: 'connected' });
}

/** stdio: the engine spawned this process; its pipes are our fd 0 and fd 1. */
function stdioStream(fd: 0 | 1): { read?: Readable; write?: Writable } {
  const stat = fstatSync(fd);
  if (stat.isFIFO() || stat.isSocket()) {
    const socket = new Socket({ fd, readable: fd === 0, writable: fd === 1 });
    return fd === 0 ? { read: socket } : { write: socket };
  }
  return fd === 0 ? { read: createReadStream('', { fd, autoClose: false }) } : { write: createWriteStream('', { fd, autoClose: false }) };
}

port.on('message', (m: ToWorker) => {
  if (closed) {
    // A call posted after the close still needs its wake-up.
    if (m.t === 'call') signal(SIGNAL_CLOSED);
    return;
  }
  if (m.t === 'close') {
    if (m.line !== undefined && output && !output.destroyed) output.write(m.line);
    close('host closed the connection');
    return;
  }
  if (!output) {
    if (m.t === 'call') signal(SIGNAL_CLOSED);
    return;
  }
  if (m.t === 'call') pending = m.id;
  output.write(m.line);
});

if (data.transport.kind === 'stdio') {
  const read = stdioStream(0).read!;
  const write = stdioStream(1).write!;
  attach(read, write);
} else {
  const path = data.transport.path;
  server = createServer({ pauseOnConnect: false }, (socket) => {
    // Exactly one engine per sidecar: stop listening (and remove the socket file) once it connects.
    closeServer();
    attach(socket, socket);
  });
  server.once('error', (e: Error) => post({ t: 'failed', message: e.message }));
  server.listen({ path, exclusive: true }, () => post({ t: 'listening' }));
}
