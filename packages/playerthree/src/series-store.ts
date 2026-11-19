/** Durable series stores: the transaction semantics shared by every backend (`durableSeriesStore`) and the single-process JSON-file store (`jsonSeriesStore`). */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ActiveMatchRow, ArtifactRef, MatchCommit, ResultChunk, SeriesState, SeriesStore, ShareRecord, StoredResultChunk, StoredSeries } from './arena.ts';
import { exportMatchSpec } from './results.ts';

/** Durable stores reject conflicts and quota failures; callers must stop scheduling on write failure. */
export class SeriesStoreError extends Error {
  readonly code: 'conflict' | 'quota' | 'not_found' | 'invalid';
  constructor(code: SeriesStoreError['code'], message: string) {
    super(`playerthree/series: ${message}`);
    this.name = 'SeriesStoreError';
    this.code = code;
  }
}

/** Records are metadata only (`chunkStats` per attempt); raw chunk payloads are stored separately. */
export interface SeriesTransaction {
  get(id: string): Promise<StoredSeries | undefined>;
  list(owner?: string): Promise<StoredSeries[]>;
  expired(now: number, limit: number): Promise<StoredSeries[]>;
  recoverable(now: number): Promise<StoredSeries[]>;
  resolveShare(digest: string, now: number): Promise<ShareRecord | undefined>;
  save(record: StoredSeries): Promise<void>;
  delete(id: string): Promise<void>;
  /** A chunk written earlier, including one written earlier in this transaction. */
  readChunk(id: string, attemptId: string, index: number): Promise<ResultChunk>;
  /** `payload` is the verified `seriesChunkJson(chunk.rows)`. */
  writeChunk(id: string, attemptId: string, chunk: ResultChunk, payload: string): Promise<void>;
  readArtifact(id: string, artifactId: string): Promise<Uint8Array | undefined>;
  writeArtifact(id: string, artifact: ArtifactRef, data: Uint8Array): Promise<void>;
  shares(id: string): Promise<ShareRecord[]>;
  saveShares(id: string, shares: ShareRecord[]): Promise<void>;
}
export interface SeriesBackend {
  transaction<T>(fn: (tx: SeriesTransaction) => Promise<T>): Promise<T>;
  /** One committed (immutable) chunk outside any metadata transaction, checksum-verified; missing data rejects. */
  readChunk(id: string, attemptId: string, index: number): Promise<ResultChunk>;
}

const TERMINAL: Record<SeriesState, boolean> = { queued: false, running: false, aborting: false, completed: true, aborted: true, failed: true };
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DEFAULT_ATTEMPT_BYTES = 256 * 1024 * 1024;
const DEFAULT_OWNER_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PAGE = 100;
const MAX_PRUNE = 100;

/** Canonical JSON used for raw chunk byte counts and SHA-256 checksums. */
export function seriesChunkJson(rows: ResultChunk['rows']): string {
  const encode = (value: unknown): string => {
    if (value === null) return 'null';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new SeriesStoreError('invalid', 'non-finite result number');
      return JSON.stringify(value);
    }
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new SeriesStoreError('invalid', 'result must be plain JSON');
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key])}`).join(',')}}`;
  };
  return encode(rows);
}

function required(record: StoredSeries | undefined): StoredSeries {
  if (!record) throw new SeriesStoreError('not_found', 'series not found');
  return record;
}
function revision(record: StoredSeries, expected: number): void {
  if (record.revision !== expected) throw new SeriesStoreError('conflict', 'revision conflict');
}
function safeId(id: string): void {
  if (!ID.test(id)) throw new SeriesStoreError('invalid', 'unsafe series or attempt identifier');
}
function artifactFileId(id: string): string {
  if (typeof id !== 'string' || id.length < 1 || id.length > 256) throw new SeriesStoreError('invalid', 'invalid artifact identifier');
  return createHash('sha256').update(id).digest('hex');
}
function current(record: StoredSeries): void {
  if (Date.parse(record.expiresAt) <= Date.now()) throw new SeriesStoreError('not_found', 'series expired');
}
/** A stored chunk must still be the exact canonical payload it was accepted as. */
function checkedChunk(chunk: ResultChunk, index: number): ResultChunk {
  const json = seriesChunkJson(chunk.rows);
  if (chunk.index !== index || chunk.bytes !== Buffer.byteLength(json) || chunk.checksum !== createHash('sha256').update(json).digest('hex')) throw new SeriesStoreError('invalid', 'corrupt raw result chunk');
  return chunk;
}

function executionLease(record: StoredSeries, holder: string): void {
  if (!holder || record.lease?.holder !== holder || record.lease.expiresAt <= Date.now()) throw new SeriesStoreError('conflict', 'execution lease lost');
}

function completedTrials(record: StoredSeries): number {
  return record.trials.filter((trial) => {
    const attempts = record.attempts.filter((attempt) => attempt.trialId === trial.trialId);
    return attempts.some((attempt) => attempt.acceptedAttempt || attempt.status === 'aborted') || attempts.length > record.spec.execution.maxInfraRetries;
  }).length;
}


function activeMatches(record: StoredSeries): ActiveMatchRow[] {
  const matches: ActiveMatchRow[] = [];
  if (TERMINAL[record.state]) return matches;
  for (const trial of record.trials) {
    const attempt = record.activeAttempts.find((entry) => entry.trialId === trial.trialId);
    if (attempt?.matchId !== null && attempt?.matchId !== undefined) matches.push({ matchId: attempt.matchId, attemptId: attempt.attemptId, trialId: attempt.trialId, attemptNumber: attempt.attemptNumber, startedAt: attempt.startedAt, spec: exportMatchSpec(trial.spec), releaseAt: attempt.releaseAt });
  }
  return matches;
}
/** Shared transaction semantics for PostgreSQL and the explicit single-process local store. */
export function durableSeriesStore(backend: SeriesBackend): SeriesStore {
  const addChunk = async (tx: SeriesTransaction, record: StoredSeries, attemptId: string, chunk: ResultChunk, holder: string): Promise<void> => {
    safeId(attemptId);
    if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) throw new SeriesStoreError('invalid', 'invalid chunk index');
    const json = seriesChunkJson(chunk.rows);
    if (Buffer.byteLength(json) !== chunk.bytes || createHash('sha256').update(json).digest('hex') !== chunk.checksum) throw new SeriesStoreError('invalid', 'chunk checksum or byte count mismatch');
    const stats = record.chunkStats.find((entry) => entry.attemptId === attemptId);
    if (stats && chunk.index < stats.count) {
      const previous = await tx.readChunk(record.id, attemptId, chunk.index);
      if (previous.checksum !== chunk.checksum || previous.bytes !== chunk.bytes) throw new SeriesStoreError('conflict', 'chunk key already contains different bytes');
      return;
    }
    executionLease(record, holder);
    if (TERMINAL[record.state]) throw new SeriesStoreError('conflict', 'series is terminal');
    if (!record.activeAttempts.some((attempt) => attempt.attemptId === attemptId)) throw new SeriesStoreError('conflict', 'attempt is not active');
    if (chunk.index !== (stats?.count ?? 0)) throw new SeriesStoreError('conflict', 'chunks must append in index order');
    const maxChunk = record.limits.maxChunkBytes;
    const attemptMatchIds = new Set([attemptId, ...record.activeAttempts.filter((attempt) => attempt.attemptId === attemptId && attempt.matchId !== null).map((attempt) => attempt.matchId), ...record.attempts.filter((attempt) => attempt.attemptId === attemptId).map((attempt) => attempt.matchId)]);
    const attemptBytes = (stats?.bytes ?? 0) + record.artifacts.filter((artifact) => artifact.matchId !== undefined && attemptMatchIds.has(artifact.matchId)).reduce((total, artifact) => total + artifact.bytes, 0);
    const ownerBytes = (await tx.list(record.owner)).filter((entry) => entry.id !== record.id).reduce((total, entry) => total + entry.bytes, record.bytes);
    if (chunk.bytes > maxChunk || record.bytes + chunk.bytes > record.limits.maxBytes || attemptBytes + chunk.bytes > (record.limits.maxAttemptBytes ?? DEFAULT_ATTEMPT_BYTES) || ownerBytes + chunk.bytes > (record.limits.maxOwnerBytes ?? DEFAULT_OWNER_BYTES)) throw new SeriesStoreError('quota', 'artifact_limit');
    await tx.writeChunk(record.id, attemptId, chunk, json);
    record.chunkStats = stats
      ? record.chunkStats.map((entry) => entry === stats ? { attemptId, count: stats.count + 1, bytes: stats.bytes + chunk.bytes } : entry)
      : [...record.chunkStats, { attemptId, count: 1, bytes: chunk.bytes }];
    record.bytes += chunk.bytes;
  };
  return {
    create: (record) => backend.transaction(async (tx) => {
      safeId(record.id);
      if (await tx.get(record.id)) throw new SeriesStoreError('conflict', 'series exists');
      const records = await tx.list(record.owner);
      if (records.filter((entry) => !TERMINAL[entry.state] && Date.parse(entry.expiresAt) > Date.now()).length >= (record.limits.maxActiveSeries ?? 2)) throw new SeriesStoreError('quota', 'active series quota');
      if (record.revision !== 0 || record.state !== 'queued' || record.bytes !== 0 || record.chunkStats.length || record.artifacts.length || record.attempts.length || record.activeAttempts.length || record.updates.length || record.lease !== null || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now() || Date.parse(record.expiresAt) > Date.parse(record.createdAt) + record.limits.retentionMs || Object.values(record.limits).some((value) => !Number.isSafeInteger(value) || value <= 0) || record.trials.length > record.limits.maxGames || new Set(record.trials.map((trial) => trial.trialId)).size !== record.trials.length) throw new SeriesStoreError('invalid', 'invalid initial series');
      if (records.filter((entry) => entry.owner === record.owner).reduce((bytes, entry) => bytes + entry.bytes, 0) >= (record.limits.maxOwnerBytes ?? DEFAULT_OWNER_BYTES)) throw new SeriesStoreError('quota', 'owner retention quota');
      const commentaryConsents = record.spec.telemetry.commentaryConsents ?? [];
      if (new Set(commentaryConsents.map((consent) => consent.entrantId)).size !== commentaryConsents.length || commentaryConsents.some((consent) => !record.spec.entrants.some((entrant) => entrant.id === consent.entrantId) || typeof consent.summaries !== 'boolean' || typeof consent.chat !== 'boolean')) throw new SeriesStoreError('invalid', 'invalid commentary consent');
      await tx.save({ ...structuredClone(record), commentaryConsents: structuredClone(commentaryConsents) });
    }),
    get: (id) => backend.transaction(async (tx) => {
      safeId(id);
      const record = await tx.get(id);
      return record && Date.parse(record.expiresAt) > Date.now() ? record : undefined;
    }),
    list: (owner, cursor) => backend.transaction(async (tx) => {
      return (await tx.list(owner)).filter((record) => (!cursor || record.id > cursor) && Date.parse(record.expiresAt) > Date.now()).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, MAX_PAGE);
    }),
    iterateChunks: (id, revision) => ({
      // Every iteration takes a fresh committed snapshot, then reads one immutable chunk at a time outside the metadata lock.
      async *[Symbol.asyncIterator](): AsyncGenerator<StoredResultChunk> {
        const plan = await backend.transaction(async (tx) => {
          safeId(id);
          const record = required(await tx.get(id));
          current(record);
          const selected = revision ?? record.revision;
          if (!Number.isSafeInteger(selected) || selected < 0 || selected > record.revision) throw new SeriesStoreError('invalid', 'results revision unavailable');
          const order = new Map(record.trials.map((trial) => [trial.trialId, trial.scheduleIndex]));
          return record.attempts.filter((attempt) => attempt.revision <= selected)
            .sort((a, b) => order.get(a.trialId)! - order.get(b.trialId)! || a.attemptNumber - b.attemptNumber || (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0))
            .map((attempt) => ({ attemptId: attempt.attemptId, committedRevision: attempt.revision, count: record.chunkStats.find((entry) => entry.attemptId === attempt.attemptId)?.count ?? 0 }));
        });
        for (const attempt of plan) {
          for (let index = 0; index < attempt.count; index++) yield { attemptId: attempt.attemptId, committedRevision: attempt.committedRevision, chunk: await backend.readChunk(id, attempt.attemptId, index) };
        }
      },
    }),
    appendChunk: (id, attemptId, chunk, holder) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      current(record);
      await addChunk(tx, record, attemptId, chunk, holder);
      await tx.save(record);
    }),
    beginAttempt: (id, expectedRevision, attempt, holder) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      current(record);
      revision(record, expectedRevision);
      executionLease(record, holder);
      if (record.state !== 'running') throw new SeriesStoreError('conflict', 'attempt requires running series');
      safeId(attempt.attemptId);
      if (!record.trials.some((trial) => trial.trialId === attempt.trialId) || record.attempts.some((row) => row.trialId === attempt.trialId && row.acceptedAttempt) || record.activeAttempts.some((row) => row.trialId === attempt.trialId)) throw new SeriesStoreError('conflict', 'trial is unavailable');
      const previous = record.attempts.filter((row) => row.trialId === attempt.trialId);
      if (attempt.matchId !== null || attempt.releaseAt !== 0 || attempt.attemptNumber !== previous.length + 1 || previous.some((row) => row.attemptId === attempt.attemptId || row.status !== 'infra_error') || attempt.attemptNumber > record.spec.execution.maxInfraRetries + 1 || !Number.isFinite(Date.parse(attempt.startedAt))) throw new SeriesStoreError('invalid', 'invalid attempt sequence');
      record.activeAttempts = [...record.activeAttempts, structuredClone(attempt)];
      await tx.save(record);
    }),
    attachMatch: (id, expectedRevision, attemptId, matchId, releaseAt, holder) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      current(record);
      executionLease(record, holder);
      if (typeof matchId !== 'string' || matchId.length < 1 || matchId.length > 256) throw new SeriesStoreError('invalid', 'invalid match identifier');
      const active = record.activeAttempts.find((attempt) => attempt.attemptId === attemptId);
      if (!active || TERMINAL[record.state] || !Number.isFinite(releaseAt) || releaseAt < 0) throw new SeriesStoreError('conflict', 'attempt cannot attach a match');
      if (active.matchId !== null) {
        const previous = record.updates.find((update) => update.revision === expectedRevision + 1);
        if (active.matchId === matchId && active.releaseAt === releaseAt && previous?.activeMatches.some((match) => match.attemptId === attemptId && match.matchId === matchId && match.releaseAt === releaseAt)) return previous.revision;
        throw new SeriesStoreError('conflict', 'attempt already attached');
      }
      revision(record, expectedRevision);
      if (record.activeAttempts.some((attempt) => attempt.matchId === matchId) || record.attempts.some((attempt) => attempt.matchId === matchId)) throw new SeriesStoreError('conflict', 'match is already attached');
      record.activeAttempts = record.activeAttempts.map((attempt) => attempt.attemptId === attemptId ? { ...attempt, matchId, releaseAt } : attempt);
      record.revision++;
      record.updatedAt = new Date().toISOString();
      const previous = record.updates.at(-1);
      record.updates = [...record.updates, { seriesId: id, revision: record.revision, at: record.updatedAt, state: record.state, completed: completedTrials(record), total: record.trials.length, standings: previous?.standings ?? [], releaseAt: Math.max(previous?.releaseAt ?? 0, releaseAt), activeMatches: activeMatches(record) }];
      await tx.save(record);
      return record.revision;
    }),
    commitMatch: (id, expectedRevision, commit: MatchCommit) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      current(record);
      const existing = record.attempts.find((attempt) => attempt.attemptId === commit.attempt.attemptId);
      if (existing) {
        if (seriesChunkJson(existing as unknown as ResultChunk['rows']) !== seriesChunkJson(commit.attempt as unknown as ResultChunk['rows'])) throw new SeriesStoreError('conflict', 'attempt already committed differently');
        const update = record.updates.find((entry) => entry.revision === expectedRevision + 1);
        if (!update || seriesChunkJson(update as unknown as ResultChunk['rows']) !== seriesChunkJson(commit.update as unknown as ResultChunk['rows'])) throw new SeriesStoreError('conflict', 'duplicate commit differs');
        return update.revision;
      }
      revision(record, expectedRevision);
      executionLease(record, commit.leaseHolder);
      const active = record.activeAttempts.find((entry) => entry.attemptId === commit.attempt.attemptId);
      if (!active || active.trialId !== commit.attempt.trialId || active.attemptNumber !== commit.attempt.attemptNumber || active.startedAt !== commit.attempt.startedAt || (active.matchId !== null && active.matchId !== commit.attempt.matchId) || TERMINAL[record.state]) throw new SeriesStoreError('conflict', 'attempt is not active');
      if (commit.attempt.acceptedAttempt && (commit.attempt.status === 'infra_error' || commit.attempt.status === 'aborted' || record.attempts.some((entry) => entry.trialId === commit.attempt.trialId && entry.acceptedAttempt))) throw new SeriesStoreError('conflict', 'invalid accepted trial result');
      const completed = completedTrials({ ...record, attempts: [...record.attempts, commit.attempt] });
      if (commit.attempt.revision !== expectedRevision + 1 || commit.update.seriesId !== id || commit.update.revision !== expectedRevision + 1 || commit.update.state !== record.state || commit.update.total !== record.trials.length || commit.update.completed !== completed || !Number.isFinite(commit.update.releaseAt) || !Number.isFinite(Date.parse(commit.update.at)) || !Number.isFinite(Date.parse(commit.attempt.endedAt))) throw new SeriesStoreError('invalid', 'inconsistent update');
      for (const chunk of commit.chunks ?? []) await addChunk(tx, record, commit.attempt.attemptId, chunk, commit.leaseHolder);
      record.attempts = [...record.attempts, structuredClone(commit.attempt)];
      record.activeAttempts = record.activeAttempts.filter((entry) => entry.attemptId !== commit.attempt.attemptId);
      record.revision++;
      if (seriesChunkJson(commit.update.activeMatches as unknown as ResultChunk['rows']) !== seriesChunkJson(activeMatches(record) as unknown as ResultChunk['rows'])) throw new SeriesStoreError('invalid', 'inconsistent active match snapshot');
      record.state = commit.update.state;
      record.updatedAt = commit.update.at;
      record.updates = [...record.updates, structuredClone(commit.update)];
      if (TERMINAL[record.state]) { record.completedAt = record.updatedAt; record.lease = null; }
      await tx.save(record);
      return record.revision;
    }),
    transition: (id, expectedRevision, state, recording, holder) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      current(record);
      revision(record, expectedRevision);
      if (holder !== undefined) executionLease(record, holder);
      const allowed: Record<SeriesState, readonly SeriesState[]> = { queued: ['running', 'aborted', 'failed'], running: ['aborting', 'completed', 'failed', 'aborted'], aborting: ['aborted', 'failed'], completed: [], aborted: [], failed: [] };
      if (!allowed[record.state].includes(state) || (state === 'completed' && (record.activeAttempts.length > 0 || completedTrials(record) !== record.trials.length)) || (TERMINAL[state] && record.activeAttempts.length > 0 && !recording)) throw new SeriesStoreError('conflict', 'invalid state transition');
      record.revision++;
      record.state = state;
      record.updatedAt = new Date().toISOString();
      const previous = record.updates.at(-1);
      record.updates = [...record.updates, { seriesId: id, revision: record.revision, at: record.updatedAt, state, completed: completedTrials(record), total: record.trials.length, standings: previous?.standings ?? [], releaseAt: previous?.releaseAt ?? 0, activeMatches: activeMatches(record), ...(recording ? { recording: structuredClone(recording) } : {}) }];
      if (recording) { record.rawComplete = false; record.missing = [...new Set([...(record.missing ?? []), ...recording.missing])]; }
      if (TERMINAL[state]) { record.completedAt = record.updatedAt; record.lease = null; }
      await tx.save(record);
      return record.revision;
    }),
    claim: (id, holder, expiresAt) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      current(record);
      if (!holder || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new SeriesStoreError('invalid', 'invalid execution lease');
      if (TERMINAL[record.state] || (record.lease && record.lease.expiresAt > Date.now() && record.lease.holder !== holder)) return false;
      record.lease = { holder, expiresAt };
      await tx.save(record);
      return true;
    }),
    release: (id, holder) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      if (record.lease === null) return;
      if (record.lease?.holder !== holder) throw new SeriesStoreError('conflict', 'lease holder mismatch');
      record.lease = null;
      await tx.save(record);
    }),
    recoverable: (now) => backend.transaction(async (tx) => tx.recoverable(now)),
    share: (id, owner, share) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      current(record);
      if (record.owner !== owner) throw new SeriesStoreError('not_found', 'series not found');
      const shares = await tx.shares(id);
      const generation = shares.reduce((highest, entry) => Math.max(highest, entry.generation), 0) + 1;
      if (share && (share.seriesId !== id || share.owner !== owner || !DIGEST.test(share.digest) || shares.some((entry) => entry.digest === share.digest) || share.revokedAt !== null || !Number.isFinite(Date.parse(share.policy.expiresAt)) || Date.parse(share.policy.expiresAt) > Date.parse(record.expiresAt) || Date.parse(share.policy.expiresAt) <= Date.now() || !Number.isFinite(share.policy.notBefore))) throw new SeriesStoreError('invalid', 'invalid share generation or expiry');
      const consentedEntrants = record.spec.entrants.filter((entrant) => record.commentaryConsents.some((consent) => consent.entrantId === entrant.id && (consent.summaries || consent.chat))).map((entrant) => entrant.id);
      if (share?.policy.commentary && consentedEntrants.length === 0) throw new SeriesStoreError('invalid', 'commentary requires emitter category consent');
      for (const old of shares) if (old.revokedAt === null) old.revokedAt = new Date().toISOString();
      const created = share ? { ...structuredClone(share), generation, policy: { ...structuredClone(share.policy), consentedEntrants: share.policy.commentary ? consentedEntrants : [] } } : null;
      if (created) shares.push(created);
      await tx.saveShares(id, shares);
      return created;
    }),
    setCommentaryConsent: (id, owner, entrantId, consent) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      current(record);
      if (record.owner !== owner) throw new SeriesStoreError('not_found', 'series not found');
      if (!record.spec.entrants.some((entrant) => entrant.id === entrantId) || typeof consent.summaries !== 'boolean' || typeof consent.chat !== 'boolean') throw new SeriesStoreError('invalid', 'invalid commentary consent');
      const previous = record.commentaryConsents.find((entry) => entry.entrantId === entrantId);
      record.commentaryConsents = [...record.commentaryConsents.filter((entry) => entry.entrantId !== entrantId), { entrantId, ...consent }];
      if ((previous?.summaries && !consent.summaries) || (previous?.chat && !consent.chat)) {
        const shares = await tx.shares(id);
        for (const share of shares) if (share.policy.commentary && share.revokedAt === null) share.revokedAt = new Date().toISOString();
        await tx.saveShares(id, shares);
      }
      await tx.save(record);
    }),
    resolveShare: (digest) => backend.transaction(async (tx) => {
      if (!DIGEST.test(digest)) return undefined;
      return tx.resolveShare(digest, Date.now());
    }),
    delete: (id, owner) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      if (record.owner !== owner) throw new SeriesStoreError('not_found', 'series not found');
      await tx.delete(id);
    }),
    prune: (now) => backend.transaction(async (tx) => {
      const expired = await tx.expired(now, MAX_PRUNE);
      for (const record of expired) await tx.delete(record.id);
    }),
    putArtifact: (id, artifact, data, holder) => backend.transaction(async (tx) => {
      const record = required(await tx.get(id));
      current(record);
      if (typeof artifact.id !== 'string' || artifact.id.length < 1 || artifact.id.length > 256) throw new SeriesStoreError('invalid', 'invalid artifact identifier');
      if (artifact.availability !== 'available' || artifact.bytes !== data.byteLength || artifact.sha256 !== createHash('sha256').update(data).digest('hex') || (artifact.expiresAt !== undefined && (!Number.isFinite(Date.parse(artifact.expiresAt)) || Date.parse(artifact.expiresAt) > Date.parse(record.expiresAt) || Date.parse(artifact.expiresAt) <= Date.now()))) throw new SeriesStoreError('invalid', 'artifact metadata does not match bytes or retention');
      const existing = record.artifacts.find((entry) => entry.id === artifact.id);
      if (existing) {
        if (existing.sha256 !== artifact.sha256 || existing.bytes !== artifact.bytes) throw new SeriesStoreError('conflict', 'artifact already contains different bytes');
        return;
      }
      executionLease(record, holder);
      if (TERMINAL[record.state]) throw new SeriesStoreError('conflict', 'series is terminal');
      const ownerBytes = (await tx.list(record.owner)).filter((entry) => entry.id !== record.id).reduce((total, entry) => total + entry.bytes, record.bytes);
      const artifactAttempts = new Set([...record.attempts.filter((attempt) => attempt.matchId === artifact.matchId).map((attempt) => attempt.attemptId), ...record.activeAttempts.filter((attempt) => attempt.matchId === artifact.matchId || attempt.attemptId === artifact.matchId).map((attempt) => attempt.attemptId)]);
      const attemptBytes = record.chunkStats.filter((entry) => artifactAttempts.has(entry.attemptId)).reduce((total, entry) => total + entry.bytes, 0) + record.artifacts.filter((entry) => entry.matchId === artifact.matchId).reduce((total, entry) => total + entry.bytes, 0);
      if (record.bytes + data.byteLength > record.limits.maxBytes || attemptBytes + data.byteLength > (record.limits.maxAttemptBytes ?? DEFAULT_ATTEMPT_BYTES) || ownerBytes + data.byteLength > (record.limits.maxOwnerBytes ?? DEFAULT_OWNER_BYTES)) throw new SeriesStoreError('quota', 'artifact_limit');
      await tx.writeArtifact(id, artifact, data);
      record.artifacts = [...record.artifacts, structuredClone(artifact)];
      record.bytes += data.byteLength;
      await tx.save(record);
    }),
    getArtifact: (id, artifactId) => backend.transaction(async (tx) => {
      const record = await tx.get(id);
      const artifact = record?.artifacts.find((entry) => entry.id === artifactId);
      if (!record || Date.parse(record.expiresAt) <= Date.now() || !artifact || artifact.availability !== 'available' || (artifact.expiresAt && Date.parse(artifact.expiresAt) <= Date.now())) return undefined;
      const bytes = await tx.readArtifact(id, artifactId);
      if (!bytes || bytes.byteLength !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new SeriesStoreError('invalid', 'missing or corrupt durable artifact');
      return bytes;
    }),
  };
}

interface FileIndex { format: 'playerthree.series-store'; version: 1; records: StoredSeries[]; shares: ShareRecord[] }
interface FileJournal { format: 'playerthree.series-journal'; version: 1; index: FileIndex; chunks: { path: string; chunk: ResultChunk }[]; artifacts: { path: string; base64: string }[]; deleted: string[] }
const fileQueues = new Map<string, Promise<unknown>>();

function validateFileIndex(index: FileIndex): void {
  if (index.format !== 'playerthree.series-store' || index.version !== 1 || !Array.isArray(index.records) || !Array.isArray(index.shares) || index.records.some((record) => !ID.test(record.id) || record.spec?.format !== 'playerthree.series' || record.spec.version !== 1 || !Array.isArray(record.activeAttempts) || !Array.isArray(record.attempts) || !Array.isArray(record.artifacts) || !Array.isArray(record.chunkStats) || !Array.isArray(record.updates) || !Array.isArray(record.commentaryConsents))) throw new SeriesStoreError('invalid', 'obsolete or malformed series store; explicit reset required');
  if (index.records.some((record) => record.activeAttempts.some((attempt) => (attempt.matchId !== null && (typeof attempt.matchId !== 'string' || attempt.matchId.length < 1 || attempt.matchId.length > 256)) || !Number.isFinite(attempt.releaseAt) || attempt.releaseAt < 0) || record.updates.some((update) => !Array.isArray(update.activeMatches) || !Number.isFinite(Date.parse(update.at))))) throw new SeriesStoreError('invalid', 'obsolete active-match revision metadata; explicit reset required');
}

function chunkFile(id: string, attemptId: string, ordinal: number): string {
  safeId(id); safeId(attemptId);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new SeriesStoreError('invalid', 'invalid chunk ordinal');
  return `${id}.${attemptId}.${ordinal}.chunk.json`;
}

/** Explicit local fallback, one process per directory. Journal replay finishes interrupted atomic commits. */
export function jsonSeriesStore(dir: string): SeriesStore {
  const root = resolve(dir);
  const indexPath = join(root, 'series.json');
  const journalPath = join(root, 'journal.json');
  const atomic = async (path: string, contents: string | Uint8Array): Promise<void> => {
    const tmp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, path);
    const directory = await open(root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const apply = async (journal: FileJournal): Promise<void> => {
    if (journal.format !== 'playerthree.series-journal' || journal.version !== 1 || journal.index.format !== 'playerthree.series-store' || journal.index.version !== 1) throw new SeriesStoreError('invalid', 'obsolete or corrupt revision journal');
    validateFileIndex(journal.index);
    if (!Array.isArray(journal.chunks) || !Array.isArray(journal.artifacts) || !Array.isArray(journal.deleted)) throw new SeriesStoreError('invalid', 'corrupt revision journal');
    for (const entry of journal.chunks) {
      if (!/^[A-Za-z0-9_-]{1,160}\.[A-Za-z0-9_-]{1,160}\.[0-9]+\.chunk\.json$/.test(entry.path)) throw new SeriesStoreError('invalid', 'unsafe journal chunk path');
      const json = seriesChunkJson(entry.chunk.rows);
      if (entry.chunk.bytes !== Buffer.byteLength(json) || entry.chunk.checksum !== createHash('sha256').update(json).digest('hex')) throw new SeriesStoreError('invalid', 'corrupt journal chunk');
      await atomic(join(root, entry.path), JSON.stringify(entry.chunk));
    }
    for (const entry of journal.artifacts) {
      if (!/^[A-Za-z0-9_-]{1,160}\.[A-Za-z0-9_-]{1,160}\.artifact$/.test(entry.path)) throw new SeriesStoreError('invalid', 'unsafe journal artifact path');
      const [seriesId, artifactId] = entry.path.split('.');
      const ref = journal.index.records.find((record) => record.id === seriesId)?.artifacts.find((artifact) => artifactFileId(artifact.id) === artifactId);
      const bytes = Buffer.from(entry.base64, 'base64');
      if (!ref || ref.bytes !== bytes.byteLength || ref.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new SeriesStoreError('invalid', 'corrupt journal artifact');
      await atomic(join(root, entry.path), bytes);
    }
    await atomic(indexPath, JSON.stringify(journal.index));
    for (const id of journal.deleted) {
      safeId(id);
      for (const name of await readdir(root)) if (name.startsWith(`${id}.`) && (name.endsWith('.chunk.json') || name.endsWith('.artifact'))) await rm(join(root, name), { force: true });
    }
    await rm(journalPath);
    const directory = await open(root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  };
  return durableSeriesStore({
    // Committed chunk files are immutable (atomic rename) and their series snapshot already replayed the journal.
    async readChunk(id, attemptId, ordinal) {
      let text: string;
      try { text = await readFile(join(root, chunkFile(id, attemptId, ordinal)), 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SeriesStoreError('not_found', 'missing durable raw chunk');
        throw error;
      }
      let chunk: ResultChunk;
      try { chunk = JSON.parse(text) as ResultChunk; } catch { throw new SeriesStoreError('invalid', 'corrupt raw result chunk'); }
      return checkedChunk(chunk, ordinal);
    },
    transaction<T>(fn: (tx: SeriesTransaction) => Promise<T>): Promise<T> {
    const queued = (fileQueues.get(root) ?? Promise.resolve()).then(async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      let journalText: string | undefined;
      try { journalText = await readFile(journalPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (journalText !== undefined) await apply(JSON.parse(journalText) as FileJournal);
      let index: FileIndex;
      for (const name of await readdir(root)) if (name.endsWith('.tmp')) await rm(join(root, name), { force: true });
      try { index = JSON.parse(await readFile(indexPath, 'utf8')) as FileIndex; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if ((await readdir(root)).some((name) => name.endsWith('.chunk.json') || name.endsWith('.artifact'))) throw new SeriesStoreError('invalid', 'missing series index; explicit reset required');
        index = { format: 'playerthree.series-store', version: 1, records: [], shares: [] };
      }
      validateFileIndex(index);
      const chunks: FileJournal['chunks'] = [];
      const artifacts: FileJournal['artifacts'] = [];
      const deleted: string[] = [];
      let dirty = false;
      const result = await fn({
        get: async (id) => index.records.find((record) => record.id === id),
        list: async (owner) => index.records.filter((record) => owner === undefined || record.owner === owner),
        expired: async (now, limit) => index.records.filter((record) => Date.parse(record.expiresAt) <= now).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)).slice(0, limit),
        recoverable: async (now) => index.records.filter((record) => !TERMINAL[record.state] && Date.parse(record.expiresAt) > now && (!record.lease || record.lease.expiresAt <= now)),
        resolveShare: async (digest, now) => index.shares.find((share) => share.digest === digest && share.revokedAt === null && Date.parse(share.policy.expiresAt) > now && share.policy.notBefore <= now && index.records.some((record) => record.id === share.seriesId && Date.parse(record.expiresAt) > now)),
        save: async (record) => {
          const at = index.records.findIndex((entry) => entry.id === record.id);
          if (at === -1) index.records.push(record); else index.records[at] = record;
          dirty = true;
        },
        delete: async (id) => { index.records = index.records.filter((record) => record.id !== id); index.shares = index.shares.filter((share) => share.seriesId !== id); deleted.push(id); dirty = true; },
        readChunk: async (id, attemptId, ordinal) => {
          const path = chunkFile(id, attemptId, ordinal);
          const pending = chunks.find((entry) => entry.path === path);
          return checkedChunk(pending?.chunk ?? JSON.parse(await readFile(join(root, path), 'utf8')) as ResultChunk, ordinal);
        },
        writeChunk: async (id, attemptId, chunk) => { chunks.push({ path: chunkFile(id, attemptId, chunk.index), chunk }); dirty = true; },
        readArtifact: async (id, artifactId) => {
          safeId(id);
          const path = `${id}.${artifactFileId(artifactId)}.artifact`;
          const pending = artifacts.find((entry) => entry.path === path);
          if (pending) return Buffer.from(pending.base64, 'base64');
          try { return await readFile(join(root, path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
        },
        writeArtifact: async (id, artifact, data) => { artifacts.push({ path: `${id}.${artifactFileId(artifact.id)}.artifact`, base64: Buffer.from(data).toString('base64') }); dirty = true; },
        shares: async (id) => index.shares.filter((share) => share.seriesId === id),
        saveShares: async (id, shares) => {
          if (shares.some((share) => index.shares.some((other) => other.seriesId !== id && other.digest === share.digest))) throw new SeriesStoreError('conflict', 'share digest exists');
          index.shares = [...index.shares.filter((share) => share.seriesId !== id), ...shares]; dirty = true;
        },
      });
      if (dirty) {
        const journal: FileJournal = { format: 'playerthree.series-journal', version: 1, index, chunks, artifacts, deleted };
        await atomic(journalPath, JSON.stringify(journal));
        await apply(journal);
      }
      return structuredClone(result);
    });
    fileQueues.set(root, queued.catch(() => {}));
    return queued;
  } });
}
