/**
 * Spec §11 *Concurrent deploys*: a commander's lobby deploys (and a match seat's) queue and run in order, each to its
 * own result, instead of failing `busy`; the queue holds at most MAX_QUEUED_DEPLOYS.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { definition as tag, type TagManifest } from '../examples/tag/index.ts';
import type { AgentSession } from '../src/host/types.ts';
import { createPlayerThreeHost, PlayerThreeError, type PlayerThreeHost } from '../src/host/index.ts';
import { DeployQueue, MAX_QUEUED_DEPLOYS } from '../src/host/pipeline.ts';
import { defineManifest, t, type GameDefinition, type Seat } from '../src/index.ts';

const CREW_ROLES = ['helm', 'guns', 'engines', 'comms'] as const;
/** A two-team game whose one seat per team has four roles: one commander deploys a policy per role. */
const crewManifest = defineManifest({
  id: 'crew', version: '1.0.0', title: 'Crew', doc: 'Four stations per ship; every station pings.',
  roleDocs: { helm: 'Ping.', guns: 'Ping.', engines: 'Ping.', comms: 'Ping.' },
  tickRate: 10,
  teams: t.enum(['red', 'blue']),
  roles: t.enum(CREW_ROLES),
  intents: { ping: { roles: [...CREW_ROLES], params: {}, doc: 'Ping once.' } },
  observation: t.obj({ tick: t.int(0, 1_000_000) }),
  view: t.obj({ tick: t.int(0, 1_000_000) }),
  observer: t.obj({ tick: t.int(0, 1_000_000) }),
  directive: t.obj({ stance: t.enum(['any']) }),
  errors: t.enum(['out'], 'out: never'),
  event: t.obj({ tick: t.int(0, 1_000_000), kind: t.enum(['pinged']) }),
  opponents: t.enum(['idle'], 'idle does nothing'),
  report: t.obj({ outcome: t.enum(['win', 'loss', 'draw', 'running']) }),
  skills: [],
  topics: {},
  control: {
    intents: { perSecond: 100, burst: 100 },
    policy: { runtimes: ['js'], hz: 10, msPerCall: 200, memoryBytes: 16 << 20, maxArtifactBytes: 64 * 1024, maxIntentsPerCall: 4, maxLogLines: 10, maxLogLineBytes: 200 },
  },
});
type CrewManifest = typeof crewManifest;
const crew: GameDefinition<CrewManifest> = {
  manifest: crewManifest,
  create() {
    let tick = 0;
    return {
      manifest: crewManifest,
      get tick() { return tick; },
      step() { tick++; },
      outcome: () => 'running' as const,
      view: () => ({ tick }),
      observerView: () => ({ tick }),
      observe: (_seat: Seat<CrewManifest>) => ({ tick }),
      apply: () => ({ ok: true as const }),
      report: () => ({ outcome: 'running' as const }),
      events: () => [],
      setSeatInfo() {},
    };
  },
  createBot: () => ({ think: () => [] }),
};

const OWNER = 'alice_owner_0001';
const ping = (marker: string) => ({ runtime: 'js' as const, code: `function think(obs) { log('${marker}', obs.tick); return [{ kind: 'ping' }]; }` });
const hosts: Pick<PlayerThreeHost<CrewManifest>, 'dispose'>[] = [];
afterEach(() => { for (const h of hosts.splice(0)) h.dispose(); });

describe('concurrent deploys', () => {
  it('runs 4 concurrent lobby deploys of one commander, one per role: all succeed, numbered in queue order', async () => {
    const host = createPlayerThreeHost({ definition: crew });
    hosts.push(host);
    const commander = host.commanders.create(OWNER, { name: 'crew', kind: 'policy', roles: [...CREW_ROLES], isolation: { independentSessions: true } });
    const token = host.commanders.token(OWNER, commander.id);
    const results = await Promise.all(CREW_ROLES.map((role) => {
      const session = host.agentSession(token, role) as Extract<AgentSession, { kind: 'commander' }>;
      return session.control.policyDeploy(ping(role));
    }));
    expect(results.every((r) => r.ok)).toBe(true);
    const versions = results.map((r) => r.ok ? r.version : null);
    expect([...versions].sort()).toEqual([1, 2, 3, 4]);
    const roster = host.commanders.roster(OWNER).find((c) => c.id === commander.id)!;
    expect(CREW_ROLES.map((role) => roster.policy.activeByRole[role])).toEqual(versions);
    // The queue drained: the next deploy takes the next number.
    const session = host.agentSession(token, 'helm') as Extract<AgentSession, { kind: 'commander' }>;
    expect(await session.control.policyDeploy(ping('again'))).toMatchObject({ ok: true, version: 5 });
  });

  it('queues concurrent deploys of one match seat instead of failing busy', async () => {
    const host = createPlayerThreeHost({ definition: tag });
    hosts.push(host);
    const match = host.createMatch({ seed: 4, realtime: false, controllers: { blue: { runner: 'none', guard: 'none' }, red: { runner: 'none', guard: 'none' } } });
    const seat = match.seat('blue', 'runner');
    const move = (x: number) => ({ runtime: 'js' as const, code: `function think() { return [{ kind: 'move', x: ${x}, y: 0 }]; }` });
    const results = await Promise.all([seat.policyDeploy(move(1)), seat.policyDeploy(move(2)), seat.policyDeploy(move(3))]);
    expect(results.map((r) => r.ok && r.version)).toEqual([1, 2, 3]);
    expect(await seat.policyStatus()).toMatchObject({ version: 3 });
  });

  it('holds at most MAX_QUEUED_DEPLOYS calls, fails one more busy at once, and never lets a failure block the rest', async () => {
    const queue = new DeployQueue();
    const gates = Array.from({ length: MAX_QUEUED_DEPLOYS }, () => Promise.withResolvers<void>());
    const order: number[] = [];
    const runs = gates.map((gate, i) => queue.run(async () => {
      order.push(i);
      await gate.promise;
      if (i === 1) throw new PlayerThreeError('invalid');
      return i;
    }));
    expect(queue.size).toBe(MAX_QUEUED_DEPLOYS);
    await expect(queue.run(async () => -1)).rejects.toMatchObject({ code: 'busy' });
    // Only the head runs; releasing every gate runs the rest strictly in order.
    await Promise.resolve();
    expect(order).toEqual([0]);
    for (const gate of gates) gate.resolve();
    const settled = await Promise.allSettled(runs);
    expect(order).toEqual(gates.map((_, i) => i));
    expect(settled.map((s) => s.status === 'fulfilled' ? s.value : s.reason instanceof PlayerThreeError ? s.reason.code : s.reason)).toEqual([0, 'invalid', 2, 3, 4, 5, 6, 7]);
    expect(queue.size).toBe(0);
    expect(await queue.run(async () => 'next')).toBe('next');
  });
});
