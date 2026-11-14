/** Inside the sandbox worker: the interface each runtime (QuickJS, core wasm) implements. */
import type { PolicyErrorCode } from '../control.ts';
import type { Budget } from './channel.ts';
import { MAX_MESSAGE_BYTES, truncateUtf8 } from './text.ts';

export interface GuestFailure {
  ok: false;
  code: PolicyErrorCode;
  /** Engine text about the policy's own artifact. */
  message?: string;
  /** The instance cannot continue (memory exhaustion, engine state lost, a timeout the runtime cannot recover from). */
  fatal: boolean;
}

export type GuestResult = { ok: true; out: string | Uint8Array; logs: readonly string[] } | (GuestFailure & { logs: readonly string[] });

export interface Guest {
  /**
   * `data[0, len)` is the observation as UTF-8 JSON. The guest judges `budget` itself: a call over it fails `timeout`,
   * fatal unless the runtime can stop the policy and keep its state (QuickJS's interrupt, spec §11).
   */
  call(data: Uint8Array, len: number, budget: Budget): GuestResult;
}

/** `detail`: JS only, the policy's declared global `detail` as JSON text (wasm declares it in a custom section). */
export type GuestLoad = { ok: true; guest: Guest; detail?: string } | GuestFailure;

export function failure(code: PolicyErrorCode, message: string | undefined, fatal: boolean): GuestFailure {
  return message === undefined ? { ok: false, code, fatal } : { ok: false, code, message: truncateUtf8(message, MAX_MESSAGE_BYTES), fatal };
}

/** Message of an exception raised by the engine while running the policy (wasm traps, stack exhaustion). */
export function engineMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
