/**
 * Commander match log integrity (SPEC §20.10.1): public ids, sealed commitments, entry digests, Ed25519 signing and
 * `verifyCommanderLog`. Node-only; the entry types are in `commander-log.ts`.
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from './briefing.ts';
import { COMMANDER_LOG_FORMAT, COMMANDER_LOG_VERSION, type CommanderLogEntry, type CommanderLogSealed, type CommanderLogVerdict, type CommanderLogVerdictRow, type ResultsKey, type ResultsSigner } from './commander-log.ts';

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** Public, non-reversible id of a commander (its private id is a random UUID). */
export function commanderPublicId(game: string, commanderId: string): string {
  return `c_${createHash('sha256').update(`playerthree/commander-public\0${game}\0${commanderId}`).digest('base64url').slice(0, 20)}`;
}

export function newSalt(): string {
  return randomBytes(16).toString('base64url');
}

/** SHA-256 hex of the canonical sealed part: the commitment an entry carries as `sealed`. */
export function sealedDigest(sealed: CommanderLogSealed): string {
  return sha256(canonicalJson(sealed));
}

function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const out = { ...value };
  for (const key of keys) delete out[key];
  return out;
}

/** SHA-256 hex of the canonical entry without `digest` and `sig` (it covers `prevDigest`: the chain). */
export function entryDigest(entry: Omit<CommanderLogEntry, 'digest' | 'sig'> & Partial<Pick<CommanderLogEntry, 'digest' | 'sig'>>): string {
  return sha256(canonicalJson(without(entry, 'digest', 'sig')));
}

export function verdictRowPayload(row: CommanderLogVerdictRow): string {
  return canonicalJson(without(row, 'sig'));
}

/** `k_` + the first 16 hex of SHA-256 over the SPKI DER public key. */
export function resultsKeyId(publicKey: KeyObject): string {
  return `k_${sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16)}`;
}

/** An Ed25519 private key as PKCS#8 PEM, or base64/base64url PKCS#8 DER (single-line secrets). */
export function parseResultsSigner(text: string): ResultsSigner {
  const trimmed = text.trim();
  const privateKey = trimmed.startsWith('-----BEGIN')
    ? createPrivateKey(trimmed)
    : createPrivateKey({ key: Buffer.from(trimmed.replaceAll('-', '+').replaceAll('_', '/'), 'base64'), format: 'der', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('playerthree/results: signing key must be Ed25519');
  const publicKey = createPublicKey(privateKey);
  return Object.freeze({
    keyId: resultsKeyId(publicKey),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    sign: (payload: string) => sign(null, Buffer.from(payload), privateKey).toString('base64url'),
  });
}

/** The published form of a signer's public key. */
export function resultsPublicKey(signer: ResultsSigner, from: number, until: number | null = null): ResultsKey {
  return { keyId: signer.keyId, publicKey: signer.publicKey, from, until };
}

export function signEntry(entry: Omit<CommanderLogEntry, 'sig'>, signer: ResultsSigner): string {
  return signer.sign(canonicalJson(entry));
}

export function signVerdictRow(row: Omit<CommanderLogVerdictRow, 'sig'>, signer: ResultsSigner): string {
  return signer.sign(canonicalJson(row));
}

function keyFor(keys: readonly ResultsKey[], keyId: string | null, at: number): KeyObject | undefined {
  const key = keys.find((k) => k.keyId === keyId && k.from <= at && (k.until === null || at < k.until) && (k.revokedAt == null || at < k.revokedAt));
  if (!key) return undefined;
  const object = createPublicKey({ key: Buffer.from(key.publicKey, 'base64url'), format: 'der', type: 'spki' });
  return resultsKeyId(object) === key.keyId ? object : undefined;
}

export type CommanderLogCheck =
  | { ok: true; entries: number }
  | { ok: false; index: number; reason: 'format' | 'digest' | 'chain' | 'unsigned' | 'unknown_key' | 'signature' | 'sealed' };

/**
 * Verify one commander's entries, given in seq order (a contiguous segment of its chain; a full log starts at seq 1
 * with a null `prevDigest`): format, digest, chain links, and the Ed25519 signature under a key valid at the entry's
 * `endedAt`. `sealed` (optional, same order): owner copies whose commitments must match; null = tombstoned.
 */
export function verifyCommanderLog(entries: readonly CommanderLogEntry[], keys: readonly ResultsKey[], sealed?: readonly (CommanderLogSealed | null)[]): CommanderLogCheck {
  let previous: CommanderLogEntry | undefined;
  for (const [index, entry] of entries.entries()) {
    if (!entry || entry.format !== COMMANDER_LOG_FORMAT || entry.version !== COMMANDER_LOG_VERSION || !Number.isSafeInteger(entry.seq) || entry.seq < 1) return { ok: false, index, reason: 'format' };
    if (entryDigest(entry) !== entry.digest) return { ok: false, index, reason: 'digest' };
    if (previous ? entry.commander !== previous.commander || entry.seq !== previous.seq + 1 || entry.prevDigest !== previous.digest
      : entry.seq === 1 ? entry.prevDigest !== null : typeof entry.prevDigest !== 'string') return { ok: false, index, reason: 'chain' };
    if (entry.sig === null || entry.host.keyId === null) return { ok: false, index, reason: 'unsigned' };
    const key = keyFor(keys, entry.host.keyId, entry.endedAt);
    if (!key) return { ok: false, index, reason: 'unknown_key' };
    if (!verify(null, Buffer.from(canonicalJson(without(entry, 'sig'))), key, Buffer.from(entry.sig, 'base64url'))) return { ok: false, index, reason: 'signature' };
    const owned = sealed?.[index];
    if (owned && sealedDigest(owned) !== entry.sealed) return { ok: false, index, reason: 'sealed' };
    previous = entry;
  }
  return { ok: true, entries: entries.length };
}

/** A verdict row's signature under a key valid at its `at`. */
export function verifyVerdictRow(row: CommanderLogVerdictRow, keys: readonly ResultsKey[]): boolean {
  const key = row.sig === null ? undefined : keyFor(keys, row.keyId, row.at);
  return !!key && verify(null, Buffer.from(verdictRowPayload(row)), key, Buffer.from(row.sig!, 'base64url'));
}

/** The entry's effective verdict: its own, or the newest later verdict row for it. */
export function effectiveVerdict(entry: CommanderLogEntry, rows: readonly CommanderLogVerdictRow[]): CommanderLogVerdict {
  let latest: CommanderLogVerdictRow | undefined;
  for (const row of rows) if (row.entryId === entry.entryId && (!latest || row.at >= latest.at)) latest = row;
  return latest?.verdict ?? entry.verdict;
}
