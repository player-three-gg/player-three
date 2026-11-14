/**
 * The host side of one engine connection: synchronous `call`s (the main thread blocks until the engine answers or
 * the call times out) and asynchronous engine requests, replies and pushes. Socket I/O runs on a worker thread
 * (`link-worker.ts`) so it keeps flowing while the main thread is blocked.
 */
import { chmodSync } from 'node:fs';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import { SIGNAL_RESULT, SIGNAL_WAITING, type FromWorker, type LinkWorkerData, type ToWorker } from './link-messages.ts';
import { DEFAULT_CALL_TIMEOUT_MS, encodeLine, type FatalCode, type Msg, type Transport } from './protocol.ts';

const WORKER_URL = new URL(import.meta.url.endsWith('.ts') ? './link-worker.ts' : './link-worker.js', import.meta.url);
const CODE_RE = /^[a-z][a-z0-9_]{0,47}$/;
const MESSAGE_MAX = 200;

/** A failed call: the engine answered `ok:false`, or the connection timed out or closed. */
export class SidecarCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SidecarCallError';
    this.code = code;
  }
}

export interface EngineLinkOptions {
  transport: Transport;
  /** Per-call deadline; a missed deadline closes the connection. Default 5000 ms. */
  callTimeoutMs?: number;
  /** Sees every message in wire order of this thread: `in` from the engine, `out` to it. */
  tap?: (dir: 'in' | 'out', msg: Msg) => void;
}

export interface LinkClosed {
  reason: string;
  code?: FatalCode;
}

export class EngineLink {
  readonly transport: Transport;
  /** Resolves when the engine connected (at once for stdio). */
  readonly connected: Promise<void>;
  /** Resolves once the connection is gone, for any reason. */
  readonly closed: Promise<LinkClosed>;
  /** Engine-initiated messages: `hello`, `host`, `advance`. */
  onMessage: (msg: Msg) => void = () => {};

  readonly #worker: Worker;
  readonly #ctrl: Int32Array;
  readonly #sync: MessagePort;
  readonly #timeoutMs: number;
  readonly #tap: EngineLinkOptions['tap'];
  #nextId = 0;
  #gone: LinkClosed | undefined;
  /** The I/O thread reported the connection closed while a call waited; its `closed` message (with the cause) follows. */
  #dropped = false;

  private constructor(opts: EngineLinkOptions, ready: (error?: Error) => void) {
    this.transport = opts.transport;
    this.#timeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.#tap = opts.tap;
    const ctrl = new SharedArrayBuffer(4);
    this.#ctrl = new Int32Array(ctrl);
    const channel = new MessageChannel();
    this.#sync = channel.port1;
    const init: LinkWorkerData = { transport: opts.transport, ctrl, sync: channel.port2 };
    // The worker owns fd 0/1 in stdio mode: nothing of the host may reach them.
    this.#worker = new Worker(WORKER_URL, { workerData: init, transferList: [channel.port2], stdout: false, stderr: false, stdin: false });
    const connected = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<LinkClosed>();
    this.connected = connected.promise;
    this.closed = closed.promise;
    this.connected.catch(() => {});
    const gone = (c: LinkClosed): void => {
      this.#gone ??= c;
      connected.reject(new Error(this.#gone.reason));
      closed.resolve(this.#gone);
      void this.#worker.terminate();
    };
    this.#worker.on('message', (m: FromWorker) => {
      if (m.t === 'listening') ready();
      else if (m.t === 'failed') {
        ready(new Error(`playerthree/sidecar: cannot listen on ${opts.transport.kind === 'socket' ? opts.transport.path : 'stdio'}: ${m.message}`));
        gone({ reason: m.message });
      } else if (m.t === 'connected') {
        ready();
        connected.resolve();
      } else if (m.t === 'msg') {
        if (this.#gone) return;
        this.#tap?.('in', m.msg);
        this.onMessage(m.msg);
      } else gone(m.code === undefined ? { reason: m.reason } : { reason: m.reason, code: m.code });
    });
    this.#worker.once('error', (e: Error) => {
      ready(e);
      gone({ reason: `link thread failed: ${e.message}` });
    });
    this.#worker.once('exit', () => gone({ reason: 'link thread exited' }));
  }

  /** Starts the link; for a socket, resolves once it listens (owner-only) and the engine may connect. */
  static open(opts: EngineLinkOptions): Promise<EngineLink> {
    const { promise, resolve, reject } = Promise.withResolvers<EngineLink>();
    const socket = opts.transport.kind === 'socket' && process.platform !== 'win32' ? opts.transport.path : undefined;
    // The socket file is created by bind(2) under the process umask: owner-only from its first instant.
    const umask = socket !== undefined ? process.umask(0o177) : undefined;
    let link: EngineLink | undefined;
    let settled = false;
    const ready = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (umask !== undefined) process.umask(umask);
      if (error) return reject(error);
      if (socket !== undefined) chmodSync(socket, 0o600);
      resolve(link!);
    };
    link = new EngineLink(opts, ready);
    return promise;
  }

  get isClosed(): boolean {
    return this.#gone !== undefined || this.#dropped;
  }

  /**
   * One synchronous adapter call. Returns the engine's `data`; throws `SidecarCallError` for `ok:false` (its code),
   * a timeout (`timeout`, and the connection is closed) or a closed connection (`engine_closed`).
   */
  call(session: string, method: string, args: unknown[]): unknown {
    return this.#exchange({ op: 'call', id: this.#nextId + 1, session, method, args }, method);
  }

  /**
   * Conformance probe: a `call` whose line is exactly `lineBytes` long (excluding "\n"), filled up by an ignored
   * `pad` member. Engines must answer lines up to MAX_LINE_BYTES.
   */
  callPadded(session: string, method: string, args: unknown[], lineBytes: number): unknown {
    const msg: Msg = { op: 'call', id: this.#nextId + 1, session, method, args, pad: '' };
    const fill = lineBytes - Buffer.byteLength(JSON.stringify(msg), 'utf8');
    if (fill < 0) throw new Error('playerthree/sidecar: padded call is already longer than requested');
    msg.pad = 'x'.repeat(fill);
    return this.#exchange(msg, method);
  }

  /** Conformance probe: writes one line verbatim, without the size check (`line` excludes the "\n"). */
  sendRawLine(line: string): void {
    if (this.isClosed) return;
    this.#tap?.('out', { op: 'raw', bytes: Buffer.byteLength(line, 'utf8') });
    this.#worker.postMessage({ t: 'send', line: `${line}\n` } satisfies ToWorker);
  }

  #exchange(msg: Msg, method: string): unknown {
    if (this.isClosed) throw new SidecarCallError('engine_closed', `engine connection closed${this.#gone ? `: ${this.#gone.reason}` : ''}`);
    const id = ++this.#nextId;
    const line = encodeLine(msg);
    this.#tap?.('out', msg);
    Atomics.store(this.#ctrl, 0, SIGNAL_WAITING);
    this.#worker.postMessage({ t: 'call', id, line } satisfies ToWorker);
    const woke = Atomics.wait(this.#ctrl, 0, SIGNAL_WAITING, this.#timeoutMs);
    const state = Atomics.load(this.#ctrl, 0);
    if (state === SIGNAL_RESULT) {
      Atomics.store(this.#ctrl, 0, SIGNAL_WAITING);
      const result = receiveMessageOnPort(this.#sync)!.message as Msg;
      this.#tap?.('in', result);
      return this.#unwrap(result, method);
    }
    if (woke === 'timed-out' && state === SIGNAL_WAITING) {
      this.close('timeout', `${method} not answered within ${this.#timeoutMs} ms`);
      throw new SidecarCallError('timeout', `engine did not answer ${method} within ${this.#timeoutMs} ms`);
    }
    this.#dropped = true;
    throw new SidecarCallError('engine_closed', `engine connection closed during ${method}`);
  }

  /** Fire-and-forget host → engine message (replies to engine requests, pushes, `ready`). */
  send(msg: Msg): void {
    if (this.isClosed) return;
    const line = encodeLine(msg);
    this.#tap?.('out', msg);
    this.#worker.postMessage({ t: 'send', line } satisfies ToWorker);
  }

  /** Closes the connection, after a fatal `{"op":"error"}` notice when `code` is given. */
  close(code?: FatalCode, message?: string): void {
    if (this.#gone) return;
    let line: string | undefined;
    if (code !== undefined) {
      const notice: Msg = message === undefined ? { op: 'error', code } : { op: 'error', code, message };
      this.#tap?.('out', notice);
      line = encodeLine(notice);
    }
    this.#gone = code === undefined ? { reason: message ?? 'host closed the connection' } : { reason: message ?? code, code };
    this.#worker.postMessage(line === undefined ? ({ t: 'close' } satisfies ToWorker) : ({ t: 'close', line } satisfies ToWorker));
  }

  #unwrap(result: Msg, method: string): unknown {
    if (result.ok === true) return result.data === undefined ? null : result.data;
    if (result.ok === false) {
      const code = typeof result.code === 'string' && CODE_RE.test(result.code) ? result.code : 'engine_error';
      const message = typeof result.message === 'string' ? result.message.slice(0, MESSAGE_MAX) : `engine failed ${method}`;
      throw new SidecarCallError(code, message);
    }
    this.close('bad_frame', 'result needs ok:true or ok:false');
    throw new SidecarCallError('engine_closed', `engine sent a malformed result for ${method}`);
  }
}
