/**
 * Sidecar wire protocol 1 (SPEC §20.8 (a)): newline-delimited UTF-8 JSON between a non-JS engine and this host.
 * Shared by the host, the conformance runner, the mock engine's expectations and the tests.
 */

export const PROTOCOL = 1;
/** Largest line in UTF-8 bytes, excluding the terminating "\n". */
export const MAX_LINE_BYTES = 1_048_576;
export const DEFAULT_CALL_TIMEOUT_MS = 5_000;
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
/** Environment variable a launcher uses to hand the socket path to the engine. */
export const SOCKET_ENV = 'PLAYERTHREE_SIDECAR_SOCKET';

/** Optional adapter calls an engine declares in `hello.hooks`; everything else in §10 is always forwarded. */
export const HOOKS = ['matchData', 'debugView', 'observerView', 'end', 'forfeit', 'rank', 'clone', 'signalLimits'] as const;
export type Hook = (typeof HOOKS)[number];

/** Fatal `{"op":"error"}` codes: the sender closes the connection right after. */
export type FatalCode = 'too_large' | 'bad_frame' | 'timeout' | 'invalid_manifest' | 'protocol';

/** Engine-initiated message ops; `result` answers a host `call`. */
export const ENGINE_OPS = ['hello', 'host', 'advance', 'result'] as const;
export type EngineOp = (typeof ENGINE_OPS)[number];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Msg = Record<string, unknown>;

export type Transport = { kind: 'stdio' } | { kind: 'socket'; path: string };

/** A positive safe integer: request ids and tick counts on the wire. */
export function isId(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) > 0;
}

/** One member of a JSON object; `undefined` when `v` is not an object or lacks it. */
export function member(v: unknown, key: string): unknown {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined;
}

/** Serialises one message to a line (with its "\n"); throws when the JSON exceeds the line limit. */
export function encodeLine(msg: Msg): string {
  const json = JSON.stringify(msg);
  // Byte length only matters once the UTF-16 length could exceed the limit (≤ 3 UTF-8 bytes per code unit).
  if (json.length * 3 > MAX_LINE_BYTES && Buffer.byteLength(json, 'utf8') > MAX_LINE_BYTES) {
    throw new Error(`playerthree/sidecar: message exceeds ${MAX_LINE_BYTES} bytes`);
  }
  return `${json}\n`;
}

/** Parses one line into a message object, or `undefined` for anything that is not a JSON object. */
export function parseLine(line: string): Msg | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Msg) : undefined;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Splits a byte stream into lines. Holds at most one open line (≤ MAX_LINE_BYTES) and never scans a byte twice.
 * `push` returns `'too_large'` once a line, terminated or not, exceeds the limit and `'bad_utf8'` for an
 * undecodable line; the stream is unusable afterwards.
 */
export class LineDecoder {
  #parts: Buffer[] = [];
  #size = 0;

  push(chunk: Buffer, out: string[]): 'ok' | 'too_large' | 'bad_utf8' {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) break;
      const size = this.#size + nl - start;
      if (size > MAX_LINE_BYTES) return 'too_large';
      const piece = chunk.subarray(start, nl);
      const bytes = this.#size === 0 ? piece : Buffer.concat([...this.#parts, piece], size);
      this.#parts = [];
      this.#size = 0;
      start = nl + 1;
      try {
        out.push(utf8.decode(bytes));
      } catch {
        return 'bad_utf8';
      }
    }
    if (start < chunk.length) {
      this.#size += chunk.length - start;
      if (this.#size > MAX_LINE_BYTES) return 'too_large';
      this.#parts.push(chunk.subarray(start));
    }
    return 'ok';
  }
}
