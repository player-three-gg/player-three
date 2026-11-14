/** Messages and the wake-up slot shared by the host thread (`link.ts`) and the I/O thread (`link-worker.ts`). */
import type { MessagePort } from 'node:worker_threads';
import type { FatalCode, Msg, Transport } from './protocol.ts';

export interface LinkWorkerData {
  transport: Transport;
  /** Int32 slot 0: one of the SIGNAL_* states below. */
  ctrl: SharedArrayBuffer;
  /** Carries the pending call's result to the blocked host thread (read with `receiveMessageOnPort`). */
  sync: MessagePort;
}

/** Host thread → I/O thread. */
export type ToWorker = { t: 'send'; line: string } | { t: 'call'; id: number; line: string } | { t: 'close'; line?: string };

/** I/O thread → host thread. */
export type FromWorker =
  | { t: 'listening' }
  | { t: 'connected' }
  | { t: 'msg'; msg: Msg }
  | { t: 'closed'; reason: string; code?: FatalCode }
  | { t: 'failed'; message: string };

export const SIGNAL_WAITING = 0;
/** The pending call's result is on the sync port. */
export const SIGNAL_RESULT = 1;
export const SIGNAL_CLOSED = 2;
