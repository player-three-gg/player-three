/**
 * Outbound guard: every piece of game data that leaves the server (observations, match bootstrap, views, events,
 * reports, game error codes) is snapshotted and validated against its closed-vocabulary schema first.
 *
 * Fail closed: non-conforming data is dropped, never "repaired" or partially forwarded. Drops are counted and
 * logged with the schema path + code only — never the data itself (it may contain whatever leaked into it).
 */
import { validate, type Schema, type SchemaErrorCode, type SchemaPath, type ValidateResult } from './schema.ts';
import { MATCH_DATA_MAX_BYTES } from './manifest.ts';

/**
 * `validate` for a schema only known at runtime (manifest-generic code). Pinning `S` to `never` skips the
 * `Infer<S>` result type, which the compiler cannot expand for an unconstrained manifest.
 */
export function validateUnknown(schema: Schema, value: unknown): ValidateResult<unknown> {
  return validate(schema as never, value);
}

export type GuardResult<T> = { ok: true; value: T; /** Wire JSON of `value` (byte accounting, transports). */ json: string } | { ok: false };

export interface GuardDrop {
  channel: string;
  code: SchemaErrorCode;
  path: SchemaPath;
}

export interface GuardStats {
  passed: number;
  dropped: number;
  droppedByChannel: Record<string, number>;
}

export interface OutboundGuard {
  /**
   * Snapshot `data` (JSON round trip, so getters/toJSON/prototype tricks cannot change it after the check),
   * validate the snapshot, and return it. The snapshot is what must be sent.
   */
  pass(channel: string, schema: Schema, data: unknown): GuardResult<unknown>;
  stats(): GuardStats;
}

export interface GuardOptions {
  /** Called once per drop. Default: `console.warn` with channel, path and code. */
  onDrop?: (drop: GuardDrop) => void;
}

const defaultOnDrop = (d: GuardDrop): void => {
  console.warn(`playerthree guard: dropped ${d.channel} (${d.code} at /${d.path.join('/')})`);
};

/** A new outbound guard with its own drop counters. */
export function createGuard(opts: GuardOptions = {}): OutboundGuard {
  const onDrop = opts.onDrop ?? defaultOnDrop;
  let passed = 0;
  let dropped = 0;
  const droppedByChannel: Record<string, number> = {};

  const drop = (channel: string, code: SchemaErrorCode, path: SchemaPath): { ok: false } => {
    dropped++;
    droppedByChannel[channel] = (droppedByChannel[channel] ?? 0) + 1;
    try {
      onDrop({ channel, code, path });
    } catch {
      // A broken logger must not turn a drop into a leak or a crash.
    }
    return { ok: false };
  };

  return {
    pass(channel: string, schema: Schema, data: unknown): GuardResult<unknown> {
      let json: string | undefined;
      let snapshot: unknown;
      try {
        json = JSON.stringify(data);
        if (json === undefined) return drop(channel, 'type', []);
        if (channel === 'matchData' && Buffer.byteLength(json, 'utf8') > MATCH_DATA_MAX_BYTES) return drop(channel, 'too_long', []);
        snapshot = JSON.parse(json);
      } catch {
        return drop(channel, 'type', []);
      }
      const r = validateUnknown(schema, snapshot);
      if (!r.ok) return drop(channel, r.code, r.path);
      passed++;
      return { ok: true, value: r.value, json };
    },
    stats: () => ({ passed, dropped, droppedByChannel: { ...droppedByChannel } }),
  };
}
