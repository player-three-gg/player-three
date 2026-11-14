/**
 * Commander match log (`playerthree.commanderLog/1`): one append-only, host-observed entry per match × named commander,
 * hash-chained per commander and signed by the host (Ed25519). Types only (browser-safe); hashing, signing and
 * verification live in `commander-log-integrity.ts`.
 *
 * Privacy: owner-identifying and owner-declared facts live in a separate `sealed` part that the entry commits to only
 * by a salted SHA-256 (`entry.sealed`). A deletion tombstone drops the sealed part; the signed entry, and so the chain
 * and every opponent's rating input, stays verifiable.
 */

export const COMMANDER_LOG_FORMAT = 'playerthree.commanderLog' as const;
export const COMMANDER_LOG_VERSION = 1 as const;

export type CommanderLogOutcome = 'win' | 'loss' | 'draw' | 'unknown';
/**
 * `final`: the game decided the match; `forfeit` / `abandoned`: this commander's team left (the game said whether it
 * conceded or failed to show up); `interrupted`: execution stopped without an outcome; `aborted`: it stopped before
 * the first tick.
 */
export type CommanderLogDisposition = 'final' | 'forfeit' | 'abandoned' | 'interrupted' | 'aborted';
/** Assistance the host observed for this commander's team: owner chat, owner intents, or a human/owner-control seat. */
export type CommanderLogAssist = 'none' | 'owner_chat' | 'owner_intents' | 'takeover';

/** The game's rating decision, stamped into the entry before it is digested and signed (`commanderLog.verdict`). */
export interface CommanderLogVerdict {
  rated: boolean;
  /** Game-defined rated pool, or null. */
  pool: string | null;
  /** Game-defined rating segment, or null. */
  segmentId: string | null;
  /** Match weight in [0, 1]. */
  weight: number;
  /** Game-defined closed vocabularies. */
  badges: string[];
  reasons: string[];
}

/** A seat of the match as observed at the end: who held it and of what kind. */
export interface CommanderLogSeatRef {
  role: string;
  /** Assignment kind (else controller) at the end. */
  kind: 'human' | 'agent' | 'policy' | 'bot' | 'none';
  /** Public id of the named commander holding it at the end; null for other seats. */
  commander: string | null;
  botLevel?: string;
  /** SHA-256 of the canonical JSON of the seat's built-in bot options. */
  botOptionsHash?: string;
  /** `hash`es of the bot packages (spec §11 *Bot packages*) that played the seat, when any did. */
  botPackages?: string[];
  policyVersion?: number;
  artifactHash?: string;
}

export interface CommanderLogUsage {
  decisions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** The worst coverage any report declared. */
  coverage: 'complete' | 'partial' | 'unknown';
}

/** The signed entry: what verifiers and public projections see. */
export interface CommanderLogEntry {
  format: typeof COMMANDER_LOG_FORMAT;
  version: typeof COMMANDER_LOG_VERSION;
  entryId: string;
  /** Per commander, from 1. */
  seq: number;
  prevDigest: string | null;
  digest: string;
  game: string;
  gameVersion: string;
  surfaceHash: string;
  matchId: string;
  host: { origin: string; keyId: string | null; official: boolean };
  /** The commander's public id (`commanderPublicId`); its private id and owner never appear here. */
  commander: string;
  kind: 'agent' | 'policy';
  /** Salted SHA-256 of the sealed part (`sealedDigest`). */
  sealed: string;
  /** Game-supplied match facts (`CreateMatchOptions.log`, game vocabularies). */
  mode: string;
  queue: string | null;
  rulesHash: string | null;
  customRules: boolean;
  map: { id: string; identity: string | null; seed: number | null; size: number | null; layout: string | null } | null;
  /** The secret match seed: entries are written once the match is over or released. */
  seed: number;
  /** One owner played opposing sides (`sameOwnerOpposed`): practice, never a result. */
  selfPlay: boolean;
  team: string;
  seats: { team: string; role: string; fromTick: number; toTick: number }[];
  planesControlled: number;
  planesTotal: number;
  planeShare: number;
  /** This team's seats at the end. `commander` only for members of this commander's owner. */
  lineup: { role: string; kind: CommanderLogSeatRef['kind']; sameOwner: boolean; commander?: string }[];
  opponents: { team: string; rank: number | null; seats: CommanderLogSeatRef[] }[];
  /** Controller intervals of this commander's seats (from the replay's `seat` entries). */
  control: { role: string; fromTick: number; toTick: number; controller: string }[];
  ownerIntents: number;
  ownerTells: number;
  /** Ticks per role a fallback bot played for an absent agent. */
  fallbackTicks: Record<string, number>;
  /** Ticks per role the deployed policy played for an absent agent (`whenAbsent: 'policy'`). */
  absentPolicyTicks: Record<string, number>;
  /** Wall-clock ms per role this seat held the session paused (the simulation stands still meanwhile). */
  pausedMs: Record<string, number>;
  /** Accepted agent/policy intents per role. */
  acceptedIntents: Record<string, number>;
  assist: CommanderLogAssist;
  /** Max over this commander's seats of the ticks something other than the commander itself played / held ticks. */
  fallbackShare: number;
  policies: { role: string; version: number; runtime: string; surfaceHash: string; artifactHash: string }[];
  policySwitches: { role: string; tick: number; version: number; artifactHash: string | null }[];
  /** `live` (agent acting), `policy` (a policy commander), `mixed` (an agent with fallback or absent-policy ticks). */
  executionKind: 'live' | 'policy' | 'mixed';
  harness: { label: string; verified: boolean } | null;
  outcome: CommanderLogOutcome;
  disposition: CommanderLogDisposition;
  rank: number | null;
  terminalReason: string;
  ticks: number;
  simSeconds: number;
  wallMs: number;
  startedAt: number;
  endedAt: number;
  replayRef: { session: string; digest: string; kept: boolean };
  verdict: CommanderLogVerdict;
  /** base64url Ed25519 over `canonicalJson(entry without sig)`; null on unofficial hosts. */
  sig: string | null;
}

/** Private facts, owner-only; scrubbed (set to null) by a deletion tombstone. */
export interface CommanderLogSealed {
  salt: string;
  ownerRef: string;
  name: string;
  /** Owner-declared metadata snapshotted when the seat was prepared; later edits never rewrite it. */
  declared: { provider?: string; model?: string; scaffoldVersion?: string };
  usage?: CommanderLogUsage;
}

export interface StoredCommanderLogEntry {
  commanderId: string;
  entry: CommanderLogEntry;
  sealed: CommanderLogSealed | null;
}

/** A later verdict change (a review void): appended, never rewriting the entry. */
export interface CommanderLogVerdictRow {
  entryId: string;
  at: number;
  verdict: CommanderLogVerdict;
  reason: string;
  keyId: string | null;
  sig: string | null;
}

/** Chain head and casual tally (non-practice decided entries) of one commander. */
export interface CommanderLogHead {
  commanderId: string;
  seq: number;
  digest: string;
  wins: number;
  losses: number;
  draws: number;
}

/**
 * Storage behind the commander log. Every method may be sync or async; the host issues writes in order. Insert only:
 * `redact` (privacy tombstone) is the one rewrite, and it touches only the sealed part.
 */
export interface CommanderLogStore {
  heads(): CommanderLogHead[] | Promise<CommanderLogHead[]>;
  append(row: StoredCommanderLogEntry): void | Promise<void>;
  /** One commander's entries in seq order, after `afterSeq` (exclusive); `limit` newest-first trimming is the caller's. */
  entries(commanderId: string, afterSeq?: number): StoredCommanderLogEntry[] | Promise<StoredCommanderLogEntry[]>;
  /** Every commander's entry for one match. */
  match(matchId: string): StoredCommanderLogEntry[] | Promise<StoredCommanderLogEntry[]>;
  /** Every entry in (endedAt, matchId, commander) order: deterministic recomputes. */
  all(): StoredCommanderLogEntry[] | Promise<StoredCommanderLogEntry[]>;
  appendVerdict(row: CommanderLogVerdictRow): void | Promise<void>;
  verdicts(): CommanderLogVerdictRow[] | Promise<CommanderLogVerdictRow[]>;
  redact(commanderId: string): void | Promise<void>;
}

/**
 * Host signing capability: `keyId` is `resultsKeyId` of its public key (SPKI DER, base64url); `sign` returns the
 * base64url Ed25519 signature of a UTF-8 payload. The private key never leaves it (`parseResultsSigner`).
 */
export interface ResultsSigner {
  readonly keyId: string;
  readonly publicKey: string;
  sign(payload: string): string;
}

/** A published verification key with its validity window (ms since epoch; `until` exclusive, null = open). */
export interface ResultsKey {
  keyId: string;
  /** SPKI DER, base64url. */
  publicKey: string;
  from: number;
  until: number | null;
  /** Entries ending at or after this instant do not verify under this key. */
  revokedAt?: number | null;
}

/** The default verdict (no game hook): unrated. Consumers copy it. */
export const UNRATED: Readonly<CommanderLogVerdict> = { rated: false, pool: null, segmentId: null, weight: 0, badges: [], reasons: [] };

/** Order of deterministic recomputes: (endedAt, matchId, commander). */
export function compareLogEntries(a: CommanderLogEntry, b: CommanderLogEntry): number {
  return a.endedAt - b.endedAt || (a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0) || (a.commander < b.commander ? -1 : a.commander > b.commander ? 1 : 0);
}
