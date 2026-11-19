/** Host utilities: the closed-code `PlayerThreeError`, token minting and digests, a token bucket, serialized store writes and input snapshots. */
import { createHash, randomBytes } from 'node:crypto';
import type { ServerErrorCode } from '../protocol.ts';
import type { SchemaErrorCode, SchemaPath } from '../schema.ts';

/**
 * Detail an error may carry about the caller's own input: own text about a policy build failure (spec §11), or a
 * closed schema failure (§4) of a deploy artifact's shape, a starter reference (§11 *Starters*: `from` or `knobs`) or
 * match options, derived from the schema and path only and never from the rejected value.
 */
export type PlayerThreeErrorDetail =
  | {
    /** Own text about the caller's artifact (e.g. esbuild's first error); never host internals. */
    message: string;
    /** `line` 1-based, `column` 0-based; `file` a module path or include entry. */
    location?: { file: string; line: number; column: number };
  }
  | {
    schemaCode: SchemaErrorCode;
    /** Developer field names and indices, e.g. `["knobs", …]`, `["options", …]` or `["code"]` (`?` for an unknown key). */
    path: SchemaPath;
    /** What the schema wanted at `path`, e.g. `Knobs["aggression"]: number (integer 0..10)`. */
    expected: string;
  };

/**
 * The only error the control plane throws on purpose. Carries a closed code and, only for errors about the caller's
 * own artifact, an own-text `detail`, so bindings can forward it verbatim; anything else is an internal failure and
 * must be reported as `internal`.
 */
export class PlayerThreeError extends Error {
  readonly code: ServerErrorCode;
  readonly detail: PlayerThreeErrorDetail | undefined;
  constructor(code: ServerErrorCode, detail?: PlayerThreeErrorDetail) {
    super(code);
    this.name = 'PlayerThreeError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 24 random bytes → 32 base64url chars (matches `TOKEN_RE`). Redrawn while the first char is `-` or `_`
 * (1 in 32) so pasted tokens never look like a CLI flag to the many arg parsers that reject `--token -x…`.
 */
export function newToken(): string {
  for (;;) {
    const token = randomBytes(24).toString('base64url');
    if (token[0] !== '-' && token[0] !== '_') return token;
  }
}

/** Tokens are stored and looked up by digest only; the raw token is never kept. */
export const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Rate limiter: `burst` tokens, refilled at `perSecond`; `take()` spends one or returns false. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly perSecond: number;
  private readonly burst: number;
  constructor(perSecond: number, burst: number) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.tokens = burst;
    this.last = performance.now();
  }
  take(): boolean {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Store writes in issue order. A failed write goes to `failed` and never stops later ones; the caller's in-memory
 * state stays authoritative for the process. With nothing in flight a write runs synchronously, so sync stores (JSON
 * files, memory) are durable when the call returns.
 */
export class SerialWrites {
  private chain: Promise<void> = Promise.resolve();
  private inflight = 0;
  private readonly failed: (e: unknown) => void;

  constructor(failed: (e: unknown) => void) {
    this.failed = failed;
  }

  write(fn: () => void | Promise<void>): void {
    const done = () => {
      this.inflight--;
    };
    if (this.inflight === 0) {
      let r: void | Promise<void>;
      try {
        r = fn();
      } catch (e) {
        this.failed(e);
        return;
      }
      if (!(r instanceof Promise)) return;
      this.inflight++;
      this.chain = r.catch(this.failed).finally(done);
      return;
    }
    this.inflight++;
    this.chain = this.chain.then(fn).catch(this.failed).finally(done);
  }

  /** Resolves once every write issued so far has settled (never rejects). */
  flush(): Promise<void> {
    return this.chain;
  }
}

/** JSON snapshot of untrusted in-process input so accessors/prototypes cannot change it after validation. */
export function snapshot(v: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    const json = JSON.stringify(v);
    return json === undefined ? { ok: false } : { ok: true, value: JSON.parse(json) };
  } catch {
    return { ok: false };
  }
}
