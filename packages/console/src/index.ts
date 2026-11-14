/**
 * `@playerthree/console`: the player console. A headless client over the game's player API (the owner's own seats
 * only: status, mandate, scopes, limits, approvals, recent intents and ack codes, policy errors and logs, practice,
 * observation size and token estimate) plus an optional drop-in panel. Browser-safe: no Node built-ins.
 */
export {
  ackCode,
  createPlayerConsole,
  estimateTokens,
  mergeTrace,
  PlayerConsole,
  type CommanderInfo,
  type ConsoleActionTarget,
  type ConsoleIntent,
  type ConsoleObservation,
  type ConsolePolicy,
  type ConsolePolicyError,
  type ConsolePractice,
  type ConsoleReadiness,
  type ConsoleSeat,
  type ConsoleSnapshot,
  type ConsoleStatus,
  type Controller,
  type Outcome,
  type PlayerConsoleOptions,
  type PlayerConsoleTarget,
  type PlayerStateWire,
  type PlayerTraceEvent,
  type SeatInfo,
} from './client.ts';
export { mountConsolePanel, type ConsolePanel, type ConsolePanelOptions } from './panel.ts';
