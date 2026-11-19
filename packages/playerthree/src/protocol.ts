/**
 * PlayerThree message conventions — transport-agnostic.
 *
 * PlayerThree does not own the game's netcode. A game carries these messages over whatever it already uses
 * (the `playerthree/colyseus` interop maps them onto Colyseus room messages; a custom WebSocket game can do the same).
 * Agents normally connect through MCP instead (see `mcp/`), which needs no game transport at all.
 *
 * Inbound messages are untrusted: size-capped, strictly shaped, rate-limited.
 * Outbound game data always passes the closed-vocabulary guard first.
 */
import { patch, type JsonDelta } from './delta.ts';
import type { EntrantCard } from './arena.ts';
import type { ControlMethod, Scope } from './control.ts';
import type { Controller, DetailRequest, Outcome } from './manifest.ts';
import type { PublicSeatCard, SeatInfo } from './host/types.ts';

export const PROTOCOL_VERSION = 1;
export type ObserverGrant =
  | { kind: 'team'; team: string; delayMs: number }
  | { kind: 'omniscient'; teams: readonly string[]; delayMs: number };
/** Only voluntarily disclosed agent-emitted game chat or summaries, never owner messages or harness logs. */
export interface ObserverCommentary {
  id: string;
  team: string;
  role: string;
  tick: number;
  category: 'summary' | 'chat';
  text: string;
}
/** Public series-scoped identity only; never a private commander or owner identifier. */
export interface ObserverAgentCard {
  team: string;
  role: string;
  card: EntrantCard;
}
/**
 * One released observer frame. A frame carries exactly one of `world` (a keyframe: the full projection, sent on join,
 * perspective change, resume beyond the batch bound or resynchronization) or `delta` (`playerthree/delta` from frame
 * `sequence - 1` of the same perspective, sent only directly after it). Frames are shared by every observer at the
 * same cursor and are immutable.
 */
export interface ObserverFrame {
  sequence: number;
  tick: number;
  recordedAt: number;
  releaseAt: number;
  perspective: string;
  world?: unknown;
  delta?: JsonDelta;
  outcomes?: Record<string, Outcome>;
  commentary?: readonly ObserverCommentary[];
  agentCards?: readonly ObserverAgentCard[];
}
export type ObserverMessage = {
  op: 'observer';
  state: 'buffering' | 'ready' | 'closed';
  /** Admission metadata only: never contains a live tick or completion signal. */
  grant?: ObserverGrant;
  frame?: ObserverFrame;
};

/** Observer transport request; the server, never the client, chooses the projection and release watermark. */
export interface ObserverRequest {
  perspective: string;
  after?: number;
}


/** A token encodes exactly one principal. Presented once when joining (e.g. Colyseus join options). */
export type Principal =
  /** Trusted private team-root capability (every seat of the team); never issue to a public-lobby participant. */
  | { kind: 'team'; match: string; team: string }
  /** Human owner capability for exactly one seat, with own-side fogged viewing. */
  | { kind: 'human'; match: string; team: string; role: string }
  /** Agent bound to exactly one seat. Cannot change controllers or mint tokens. */
  | { kind: 'seat'; match: string; team: string; role: string }
  /** Read-only; receives per-team fogged views. */
  | { kind: 'spectator'; match: string; team?: string }
  /** Observer admission is independent of player, agent and operator authority. */
  | { kind: 'observer'; match: string; grant: ObserverGrant };

/** Message type names on the game transport. */
export const MSG = {
  call: 'playerthree:call',
  observer: 'playerthree:observer',
  stream: 'playerthree:stream',
  mandate: 'playerthree:mandate',
  scopes: 'playerthree:scopes',
  resolveApproval: 'playerthree:resolveApproval',
  controller: 'playerthree:controller',
  mint: 'playerthree:mint',
  result: 'playerthree:result',
  view: 'playerthree:view',
  obs: 'playerthree:obs',
  /** Server → owners/spectators: seat list (controllers, liveness, policy versions) whenever it changes. */
  seats: 'playerthree:seats',
  cards: 'playerthree:cards',
  /** Server → owners/spectators: a team's after-action report once its outcome is decided. */
  report: 'playerthree:report',
  /** Spectator → transport: choose which teams' views to receive (`WatchMsg`). Handled by the transport binding. */
  watch: 'playerthree:watch',
  /** Owner → own agents (chat mode). */
  tell: 'playerthree:tell',
  /** Server → that team's owners only: an agent's reply (`Said`). */
  said: 'playerthree:said',
} as const;

export type ClientMsg =
  /** Control-plane RPC for a seat (agents: their seat; owners: any seat of their team). Omitted args means `{}`. */
  | { op: 'call'; seq: number; role: string; method: ControlMethod; args?: unknown }
  /** Stream mode: push observations every `everyTicks` ticks. `everyTicks: 0` stops. */
  /** `detail`: observation sections pushed in full besides the role's defaults, or `'all'` (unknown → `invalid`). */
  | { op: 'stream'; seq: number; role: string; everyTicks: number; detail?: DetailRequest }
  /** Owner only. */
  | { op: 'mandate'; seq: number; role: string; mandate: unknown }
  /** Owner only: replace this live seat's agent permissions. */
  | { op: 'scopes'; seq: number; role: string; scopes: Scope[] }
  /** Owner only: resolve a supervised proposal. */
  | { op: 'resolveApproval'; seq: number; role: string; id: string; approve: boolean }
  /** Owner only. */
  | { op: 'controller'; seq: number; role: string; controller: Controller }
  /** Owner only: mint a seat token for an agent. */
  | { op: 'mint'; seq: number; role: string }
  /** Owner only (chat mode): message own agents — some roles of the owner's team, or `all`. */
  | { op: 'tell'; seq: number; roles: string[] | 'all'; text: string; ping?: unknown };

/** Transport-level spectator message (not routed to `PlayerThreeMatch.handleMessage`). */
export interface WatchMsg {
  op: 'watch';
  teams: string[];
}

export type ServerErrorCode =
  | 'bad_message'
  | 'bad_token'
  | 'forbidden'
  | 'out_of_scope'
  | 'approval_not_found'
  | 'approval_pending'
  | 'approval_failed'
  | 'mode_unavailable'
  | 'rate_limited'
  | 'invalid'
  | 'busy'
  | 'internal'
  /** Commander token in the lobby: the method needs a running match (game_observe, game_act). */
  | 'not_in_match'
  /** In-process `PlayerThreeMatch.step()` on a paused session (a seat with `whenAbsent: 'pause'` has no present agent). */
  | 'paused';
/**
 * One step of a team's view stream: a keyframe (`view`, the full guarded view at `version`) or a `playerthree/delta`
 * structural delta from `version - 1` of the same team's stream. Built once, shared by every reader of the team, frozen.
 */
export type ViewMessage =
  | { op: 'view'; team: string; version: number; view: unknown }
  | { op: 'view'; team: string; version: number; delta: JsonDelta };

/** A reader's state of one team's view stream. */
export interface ViewState {
  version: number;
  view: unknown;
}

/**
 * Apply one `playerthree:view` message: a keyframe replaces the state, a delta applies only to exactly the previous version.
 * Returns undefined for a delta without its base version (a protocol error: rejoin for a keyframe). `state` is not
 * mutated and unchanged subtrees are shared with it, so a reader MUST treat views as immutable.
 */
export function applyView(state: ViewState | undefined, message: ViewMessage): ViewState | undefined {
  if ('view' in message) return { version: message.version, view: message.view };
  if (!state || message.version !== state.version + 1) return undefined;
  return { version: message.version, view: patch(state.view, message.delta) };
}

export type ServerMsg =
  | ObserverMessage
  | { op: 'result'; seq: number; ok: true; data: unknown }
  | { op: 'result'; seq: number; ok: false; code: ServerErrorCode }
  /** Pushed to team owners/spectators at the view rate. */
  | ViewMessage
  /** Stream mode push. */
  | { op: 'obs'; role: string; data: unknown }
  /** Seats of the recipient's team (owners) or of the watched teams (spectators). */
  | { op: 'seats'; seats: SeatInfo[] }
  | { op: 'cards'; cards: PublicSeatCard[] }
  /** Guarded after-action report for `team` (manifest.report). */
  | { op: 'report'; team: string; data: unknown }
  /** An agent's reply, to that team's owners only. Agent-authored: plain text. */
  | { op: 'said'; role: string; tick: number; text: string };

/** Tokens: 32 chars base64url (24 random bytes). Validated as an opaque format before lookup. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
/** Inbound message cap. Policy uploads are the largest legitimate message. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
