import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definition, type TagManifest } from '../examples/tag/index.ts';
import { entryDigest, parseResultsSigner, resultsPublicKey, verifyCommanderLog, verifyVerdictRow } from '../src/results.ts';
import { createPlayerThreeHost, memoryCommanderLogStore, memoryCommanderStore } from '../src/host/index.ts';
import type { CommanderLogEntry, CommanderLogStore, CommanderStore, PlayerThreeHost, ResultsSigner } from '../src/host/types.ts';

const ALICE = 'alice_owner_0001';
const hosts: PlayerThreeHost<TagManifest>[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  vi.restoreAllMocks();
});

function signer(format: 'pem' | 'der' = 'pem'): ResultsSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return parseResultsSigner(format === 'pem' ? privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() : privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'));
}

function host(store: CommanderLogStore, commanders: CommanderStore, results?: ResultsSigner): PlayerThreeHost<TagManifest> {
  const h = createPlayerThreeHost({ definition, commanderStore: commanders, commanderLog: { store, origin: 'https://example.test', ...(results ? { signer: results } : {}) } });
  hosts.push(h);
  return h;
}

async function play(h: PlayerThreeHost<TagManifest>, id: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const match = h.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id } }] });
    await match.step(1);
    match.end({ blue: i % 2 ? 'loss' : 'win', red: i % 2 ? 'win' : 'loss' });
  }
}

function setup(results?: ResultsSigner) {
  const store = memoryCommanderLogStore();
  const commanders = memoryCommanderStore();
  const h = host(store, commanders, results);
  h.commanders.ensure(ALICE);
  const id = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
  return { store, commanders, h, id };
}

const entriesOf = async (h: PlayerThreeHost<TagManifest>, id: string): Promise<CommanderLogEntry[]> => (await h.commanders.log(ALICE, id)).map((r) => r.entry);

describe('commander log signing', () => {
  it('signs official entries and verifies them with the published key; PEM and DER secrets agree', async () => {
    const key = signer();
    const { h, id } = setup(key);
    await play(h, id, 3);
    const entries = await entriesOf(h, id);
    expect(entries.every((e) => e.host.official && e.host.keyId === key.keyId && e.host.origin === 'https://example.test' && typeof e.sig === 'string')).toBe(true);
    expect(key.keyId).toMatch(/^k_[0-9a-f]{16}$/);
    expect(verifyCommanderLog(entries, [resultsPublicKey(key, 0)])).toEqual({ ok: true, entries: 3 });
    // Owner copies of the sealed parts must match their commitments.
    const rows = await h.commanders.log(ALICE, id);
    expect(verifyCommanderLog(entries, [resultsPublicKey(key, 0)], rows.map((r) => r.sealed))).toMatchObject({ ok: true });
    expect(verifyCommanderLog(entries, [resultsPublicKey(key, 0)], [{ ...rows[0]!.sealed!, ownerRef: 'someone_else_01' }])).toEqual({ ok: false, index: 0, reason: 'sealed' });
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(parseResultsSigner(privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')).keyId)
      .toBe(parseResultsSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).keyId);
    expect(() => parseResultsSigner(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).toThrow(/Ed25519/);
  });

  it('detects tampering: an edited field fails the digest, a re-digested edit fails the signature', async () => {
    const key = signer('der');
    const { h, id } = setup(key);
    await play(h, id, 2);
    const entries = await entriesOf(h, id);
    const keys = [resultsPublicKey(key, 0)];
    const edited = { ...entries[1]!, outcome: 'win' as const };
    expect(verifyCommanderLog([entries[0]!, edited], keys)).toEqual({ ok: false, index: 1, reason: 'digest' });
    const redigested = { ...edited, digest: entryDigest(edited) };
    expect(verifyCommanderLog([entries[0]!, redigested], keys)).toEqual({ ok: false, index: 1, reason: 'signature' });
    const reweighted = { ...entries[0]!, verdict: { ...entries[0]!.verdict, rated: true, weight: 1 } };
    expect(verifyCommanderLog([{ ...reweighted, digest: entryDigest(reweighted) }], keys)).toEqual({ ok: false, index: 0, reason: 'signature' });
  });

  it('detects reordering, gaps and a missing chain start', async () => {
    const key = signer();
    const { h, id } = setup(key);
    await play(h, id, 3);
    const [a, b, c] = await entriesOf(h, id);
    const keys = [resultsPublicKey(key, 0)];
    expect(verifyCommanderLog([b!, a!, c!], keys)).toMatchObject({ ok: false, reason: 'chain' });
    expect(verifyCommanderLog([a!, c!], keys)).toEqual({ ok: false, index: 1, reason: 'chain' });
    // A contiguous segment verifies on its own.
    expect(verifyCommanderLog([b!, c!], keys)).toEqual({ ok: true, entries: 2 });
    expect(verifyCommanderLog([{ ...a!, prevDigest: b!.digest, digest: entryDigest({ ...a!, prevDigest: b!.digest }) }], keys)).toMatchObject({ ok: false, reason: 'chain' });
  });

  it('refuses foreign keys and unsigned entries', async () => {
    const key = signer();
    const other = signer();
    const { h, id } = setup(key);
    await play(h, id, 1);
    const entries = await entriesOf(h, id);
    expect(verifyCommanderLog(entries, [resultsPublicKey(other, 0)])).toEqual({ ok: false, index: 0, reason: 'unknown_key' });
    // A foreign public key published under this key id does not match it.
    expect(verifyCommanderLog(entries, [{ ...resultsPublicKey(other, 0), keyId: key.keyId }])).toEqual({ ok: false, index: 0, reason: 'unknown_key' });
    const unofficial = setup();
    await play(unofficial.h, unofficial.id, 1);
    const [plain] = await entriesOf(unofficial.h, unofficial.id);
    expect(plain).toMatchObject({ sig: null, host: { official: false, keyId: null } });
    expect(verifyCommanderLog([plain!], [resultsPublicKey(key, 0)])).toEqual({ ok: false, index: 0, reason: 'unsigned' });
  });

  it('rotates keys by validity window and honours revocation', async () => {
    const first = signer();
    const second = signer();
    const store = memoryCommanderLogStore();
    const commanders = memoryCommanderStore();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let h = host(store, commanders, first);
    h.commanders.ensure(ALICE);
    const id = h.commanders.create(ALICE, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    await play(h, id, 2);
    await h.commanders.flush();
    h.dispose();
    // The operator rotates at `now + 1000`: the old key's window closes there and the new one opens.
    clock.mockReturnValue(now + 2000);
    h = host(store, { ...commanders, load: () => commanders.load() }, second);
    await h.ready;
    await play(h, id, 2);
    const entries = await entriesOf(h, id);
    expect(entries.map((e) => e.host.keyId)).toEqual([first.keyId, first.keyId, second.keyId, second.keyId]);
    const rotated = [resultsPublicKey(first, 0, now + 1000), resultsPublicKey(second, now + 1000)];
    expect(verifyCommanderLog(entries, rotated)).toEqual({ ok: true, entries: 4 });
    // Entries dated outside their key's window do not verify.
    expect(verifyCommanderLog(entries, [resultsPublicKey(first, 0, now - 1), resultsPublicKey(second, now + 1000)])).toEqual({ ok: false, index: 0, reason: 'unknown_key' });
    // Revoking the old key from `now` invalidates what it signed from then on.
    expect(verifyCommanderLog(entries, [{ ...rotated[0]!, revokedAt: now }, rotated[1]!])).toEqual({ ok: false, index: 0, reason: 'unknown_key' });
    // Amendments are signed by the current key.
    const row = await h.commanderLog.amend(entries[0]!.entryId, { rated: false, pool: null, segmentId: null, weight: 0, badges: [], reasons: ['voided_review'] }, 'review');
    expect(row.keyId).toBe(second.keyId);
    expect(verifyVerdictRow(row, rotated)).toBe(true);
    expect(verifyVerdictRow({ ...row, reason: 'other' }, rotated)).toBe(false);
  });
});
