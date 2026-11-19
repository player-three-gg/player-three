import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { definition, type TagManifest } from '../examples/tag/index.ts';
import { commanderPublicId, entryDigest, sealedDigest } from '../src/commander-log-integrity.ts';
import { createPlayerThreeHost, memoryCommanderStore } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeHostOptions, StoredCommanderLogEntry } from '../src/host/types.ts';

const ALICE = 'alice_owner_0001';
const BOB = 'bob_owner_000002';

const hosts: PlayerThreeHost<TagManifest>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newHost(opts: Partial<PlayerThreeHostOptions<TagManifest>> = {}): PlayerThreeHost<TagManifest> {
  const h = createPlayerThreeHost({ definition, ...opts });
  hosts.push(h);
  return h;
}

function commander(h: PlayerThreeHost<TagManifest>, owner: string, roles: ('runner' | 'guard')[], metadata?: { model: string }): string {
  h.commanders.ensure(owner);
  return h.commanders.create(owner, { name: `${owner} ${roles.join('+')}`, kind: 'agent', roles, isolation: { independentSessions: true }, ...(metadata ? { metadata } : {}) }).id;
}

/** Alice's two-lane commander on blue against Bob's one-lane commander on red. */
function duel(h: PlayerThreeHost<TagManifest>, alice: string, bob: string) {
  return h.createMatch({ realtime: false, log: { mode: 'duel_1v1', queue: null, rulesHash: 'sha256:abc', customRules: false, map: { id: 'arena', layout: '1v1' } }, assignments: [
    { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice } },
    { team: 'blue', role: 'guard', owner: ALICE, kind: 'agent', commander: { id: alice } },
    { team: 'red', role: 'runner', owner: BOB, kind: 'agent', commander: { id: bob } },
  ] });
}

/** Controller intervals of a seat re-derived from the replay's `seat` entries alone. */
function replayControl(entries: readonly unknown[][], team: string, role: string, ticks: number) {
  const out: { fromTick: number; toTick: number; controller: string }[] = [];
  for (const e of entries) {
    if (e[1] !== team || e[2] !== role || e[3] !== 'seat') continue;
    const [tick, , , , controller] = e as [number, string, string, string, string];
    const last = out.at(-1);
    if (last?.fromTick === tick) last.controller = controller;
    else if (last?.controller !== controller) {
      if (last) last.toTick = tick;
      out.push({ fromTick: tick, toTick: ticks, controller });
    }
  }
  return out;
}

describe('commander match log', () => {
  it('writes one entry per match × commander, crediting a multi-lane commander once and deriving the record from the log', async () => {
    const h = newHost();
    const alice = commander(h, ALICE, ['runner', 'guard']);
    const bob = commander(h, BOB, ['runner']);
    const match = duel(h, alice, bob);
    await match.step(4);
    match.end({ blue: 'win', red: 'loss' });
    await h.commanderLog.flush();
    const rows = await h.commanderLog.match(match.id);
    expect(rows).toHaveLength(2);
    const mine = rows.find((r) => r.commanderId === alice)!.entry;
    expect(mine).toMatchObject({
      format: 'playerthree.commanderLog', version: 1, seq: 1, prevDigest: null, matchId: match.id, team: 'blue', kind: 'agent',
      commander: commanderPublicId('tag', alice), mode: 'duel_1v1', queue: null, rulesHash: 'sha256:abc', map: { id: 'arena', layout: '1v1' },
      planesControlled: 2, planesTotal: 2, planeShare: 1, outcome: 'win', disposition: 'final', rank: 1, terminalReason: 'declared', ticks: 4,
      host: { official: false, keyId: null }, sig: null, assist: 'none', executionKind: 'mixed',
    });
    expect(mine.seats.map((s) => s.role).sort()).toEqual(['guard', 'runner']);
    expect(mine.lineup).toEqual(expect.arrayContaining([{ role: 'runner', kind: 'agent', sameOwner: true, commander: commanderPublicId('tag', alice) }]));
    expect(mine.opponents).toEqual([{ team: 'red', rank: 2, seats: expect.arrayContaining([{ role: 'runner', kind: 'agent', commander: commanderPublicId('tag', bob) }]) }]);
    expect(mine.replayRef).toEqual({ session: match.id, digest: expect.stringMatching(/^[0-9a-f]{64}$/), kept: true });
    expect(h.commanders.roster(ALICE)[0]!.record).toEqual({ wins: 1, losses: 0, draws: 0 });
    expect(h.commanders.roster(BOB)[0]!.record).toEqual({ wins: 0, losses: 1, draws: 0 });
    match.dispose();
    // Disposing an ended match writes nothing more.
    await h.commanderLog.flush();
    expect(await h.commanderLog.match(match.id)).toHaveLength(2);
  });

  it('logs an interrupted match as unknown/interrupted and one released before its first tick as aborted', async () => {
    const h = newHost();
    const alice = commander(h, ALICE, ['runner', 'guard']);
    const bob = commander(h, BOB, ['runner']);
    const running = duel(h, alice, bob);
    await running.step(3);
    await running.releaseBindings();
    const held = duel(h, alice, bob);
    held.dispose();
    running.dispose();
    const [interrupted, aborted] = (await h.commanders.log(ALICE, alice)).map((r) => r.entry);
    expect(interrupted).toMatchObject({ matchId: running.id, outcome: 'unknown', disposition: 'interrupted', rank: null, terminalReason: 'released', ticks: 3 });
    expect(aborted).toMatchObject({ matchId: held.id, outcome: 'unknown', disposition: 'aborted', ticks: 0, seq: 2 });
    expect(h.commanders.roster(ALICE)[0]!.record).toEqual({ wins: 0, losses: 0, draws: 0 });
  });

  it('chains every commander’s entries and commits to the sealed part', async () => {
    const h = newHost();
    const alice = commander(h, ALICE, ['runner', 'guard']);
    const bob = commander(h, BOB, ['runner']);
    for (const outcome of ['win', 'draw', 'loss'] as const) {
      const match = duel(h, alice, bob);
      await match.step(2);
      match.end(outcome === 'draw' ? 'draw' : { blue: outcome, red: outcome === 'win' ? 'loss' : 'win' });
    }
    const rows = await h.commanders.log(ALICE, alice);
    expect(rows.map((r) => r.entry.seq)).toEqual([1, 2, 3]);
    rows.forEach((row, i) => {
      expect(entryDigest(row.entry)).toBe(row.entry.digest);
      expect(row.entry.prevDigest).toBe(i === 0 ? null : rows[i - 1]!.entry.digest);
      expect(sealedDigest(row.sealed!)).toBe(row.entry.sealed);
    });
    expect(h.commanders.roster(ALICE)[0]!.record).toEqual({ wins: 1, losses: 1, draws: 1 });
    // Tampering with any signed field breaks the digest.
    const tampered = { ...rows[1]!.entry, outcome: 'win' as const };
    expect(entryDigest(tampered)).not.toBe(rows[1]!.entry.digest);
  });

  it('records control intervals, owner input and fallback that a replay re-derivation reproduces', async () => {
    const h = newHost();
    const alice = commander(h, ALICE, ['runner', 'guard']);
    const bob = commander(h, BOB, ['runner']);
    const match = duel(h, alice, bob);
    await match.step(2);
    match.setController('blue', 'runner', 'bot');
    await match.step(3);
    match.setController('blue', 'runner', 'agent');
    await match.step(2);
    match.tell('blue', ['guard'], 'hold the base');
    match.end({ blue: 'loss', red: 'win' });
    await h.commanderLog.flush();
    const entry = (await h.commanderLog.match(match.id)).find((r) => r.commanderId === alice)!.entry;
    const replay = match.replay();
    for (const role of ['runner', 'guard']) {
      expect(entry.control.filter((c) => c.role === role).map(({ role: _role, ...c }) => c)).toEqual(replayControl(replay.entries as unknown as unknown[][], 'blue', role, replay.ticks));
    }
    expect(entry.control.filter((c) => c.role === 'runner').map((c) => c.controller)).toEqual(['agent', 'bot', 'agent']);
    expect(entry).toMatchObject({ ownerTells: 1, assist: 'owner_chat', ownerIntents: 0 });
    // Absent agents played by fallback bots the whole time.
    expect(entry.fallbackShare).toBeGreaterThan(0.5);
    expect(entry.fallbackTicks.guard).toBeGreaterThan(0);
  });

  it('snapshots declared metadata at seat time; later edits never rewrite it', async () => {
    const h = newHost();
    const alice = commander(h, ALICE, ['runner', 'guard'], { model: 'model-a' });
    const bob = commander(h, BOB, ['runner']);
    const match = duel(h, alice, bob);
    await match.step(1);
    match.end({ blue: 'win', red: 'loss' });
    h.commanders.rename(ALICE, alice, { name: 'Renamed', kind: 'agent', roles: ['runner', 'guard'], isolation: { independentSessions: true }, metadata: { model: 'model-b' } });
    const [row] = await h.commanders.log(ALICE, alice);
    expect(row!.sealed).toMatchObject({ ownerRef: ALICE, declared: { model: 'model-a' }, name: `${ALICE} runner+guard` });
  });

  it('keeps owner refs, private ids and declared metadata out of the signed entry; a tombstone keeps the chain', async () => {
    const h = newHost();
    const alice = commander(h, ALICE, ['runner', 'guard'], { model: 'secret-model' });
    const bob = commander(h, BOB, ['runner']);
    for (let i = 0; i < 2; i++) {
      const match = duel(h, alice, bob);
      await match.step(1);
      match.end({ blue: 'win', red: 'loss' });
    }
    const rows = await h.commanders.log(ALICE, alice);
    for (const row of rows) {
      const text = JSON.stringify(row.entry);
      for (const secret of [ALICE, BOB, alice, bob, 'secret-model']) expect(text).not.toContain(secret);
    }
    await h.commanders.delete(ALICE, alice);
    await h.commanderLog.flush();
    const kept: StoredCommanderLogEntry[] = await h.commanderLog.entries(alice);
    expect(kept.map((r) => r.sealed)).toEqual([null, null]);
    expect(kept.map((r) => r.entry)).toEqual(rows.map((r) => r.entry));
    // Bob's record and chain do not depend on Alice's privacy.
    expect(h.commanders.roster(BOB)[0]!.record).toEqual({ wins: 0, losses: 2, draws: 0 });
  });

  it('never credits a revoked commander and keeps self-play out of the record', async () => {
    const h = newHost();
    const alice = commander(h, ALICE, ['runner']);
    const alt = commander(h, ALICE, ['runner']);
    const match = h.createMatch({ realtime: false, assignments: [
      { team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice } },
      { team: 'red', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alt } },
    ] });
    await match.step(1);
    match.end({ blue: 'win', red: 'loss' });
    const [selfPlay] = await h.commanders.log(ALICE, alice);
    expect(selfPlay!.entry).toMatchObject({ selfPlay: true, outcome: 'win' });
    expect(h.commanders.roster(ALICE).map((c) => c.record)).toEqual([{ wins: 0, losses: 0, draws: 0 }, { wins: 0, losses: 0, draws: 0 }]);
    const revoked = h.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: ALICE, kind: 'agent', commander: { id: alice } }] });
    await revoked.step(1);
    revoked.revokeSeat('blue', 'runner');
    revoked.end({ blue: 'win', red: 'loss' });
    const [, gone] = await h.commanders.log(ALICE, alice);
    expect(gone!.entry).toMatchObject({ outcome: 'unknown', disposition: 'interrupted' });
  });

  it('hashes the composed policy source at deploy', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const id = h.commanders.create(ALICE, { name: 'Policy', kind: 'policy', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const code = 'function think() { return []; }';
    expect(await h.agentSession(h.commanders.token(ALICE, id), 'runner')!.control.policyDeploy({ runtime: 'js', code })).toMatchObject({ ok: true, version: 1 });
    expect(h.commanders.roster(ALICE)[0]!.policy.versions[0]!.artifactHash).toBe(createHash('sha256').update(code).digest('hex'));
    const match = h.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: ALICE, kind: 'policy', commander: { id }, policy: { version: 1 } }] });
    await match.step(2);
    match.end({ blue: 'win', red: 'loss' });
    const [row] = await h.commanders.log(ALICE, id);
    expect(row!.entry).toMatchObject({ kind: 'policy', executionKind: 'policy', policies: [{ role: 'runner', version: 1, artifactHash: createHash('sha256').update(code).digest('hex') }] });
  });

  it('persists to JSONL under dataDir and continues each chain after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'playerthree-log-'));
    dirs.push(dir);
    const commanders = memoryCommanderStore();
    let h = newHost({ dataDir: dir, commanderStore: commanders });
    const alice = commander(h, ALICE, ['runner', 'guard']);
    const bob = commander(h, BOB, ['runner']);
    let match = duel(h, alice, bob);
    await match.step(1);
    match.end({ blue: 'win', red: 'loss' });
    await h.commanders.flush();
    h.dispose();
    expect(readdirSync(join(dir, 'commander-log'))).toEqual(['tag.jsonl']);
    h = newHost({ dataDir: dir, commanderStore: { ...commanders, load: () => commanders.load() } });
    await h.ready;
    expect(h.commanders.roster(ALICE)[0]!.record).toEqual({ wins: 1, losses: 0, draws: 0 });
    match = duel(h, alice, bob);
    await match.step(1);
    match.end('draw');
    const rows = await h.commanders.log(ALICE, alice);
    expect(rows.map((r) => r.entry.seq)).toEqual([1, 2]);
    expect(rows[1]!.entry.prevDigest).toBe(rows[0]!.entry.digest);
    expect(readFileSync(join(dir, 'commander-log', 'tag.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('refuses stored commanders that still carry `stats` (D11: records come from the log only)', () => {
    const store = memoryCommanderStore();
    store.saveOwner({ owner: ALICE, createdAt: 1, commanders: [{
      id: randomUUID(), name: 'Old', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true }, gen: 1, versions: [], nextVersion: 1,
      activeByRole: { runner: null }, results: {}, pendingMatches: {}, lastPractice: null, lastSeenAt: null, mandate: undefined as never, scopes: [], botLevel: 'novice',
      ...{ stats: { wins: 1, losses: 0, draws: 0 } },
    }] });
    expect(() => createPlayerThreeHost({ definition, commanderStore: store })).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});
