import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { definition } from '../examples/tag/index.ts';
import { createPlayerThreeHost, memoryCommanderStore } from '../src/host/index.ts';
import type { PlayerThreeHost, StoredCommander } from '../src/host/types.ts';
import { mountMcp } from '../src/mcp/index.ts';
import { quadDefinition } from './quad-fixture.ts';

const OWNER = 'lifecycle_owner';
const roles = ['runner', 'guard'] as const;

async function endpoint(host: PlayerThreeHost) {
  const server = createServer((_req, res) => res.writeHead(404).end());
  const mounted = mountMcp(server, host);
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  return {
    async connect(token: string) {
      const client = new Client({ name: 'lifecycle-smoke', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
      let sessionId: string | undefined;
      await client.connect(new StreamableHTTPClientTransport(url, {
        authProvider: { token: async () => token },
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          if (sessionId) headers.set('mcp-session-id', sessionId);
          const response = await fetch(input, { ...init, headers });
          if (response.ok) sessionId = response.headers.get('mcp-session-id') ?? sessionId;
          return response;
        },
      }));
      await client.listTools();
      return client;
    },
    async close() {
      await mounted.close();
      const closing = Promise.withResolvers<void>();
      server.close(() => closing.resolve());
      await closing.promise;
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent;
}

describe('HTTP terminal recovery and role restoration', () => {
  it('delivers pending direct-seat final waits, permits only terminal reads, and honors revoke/expiry', async () => {
    const host = createPlayerThreeHost({ definition });
    const ep = await endpoint(host);
    const match = host.createMatch({ realtime: false, controllers: { blue: { runner: 'agent', guard: 'agent' } } });
    const runnerToken = match.mintSeatToken('blue', 'runner');
    const guardToken = match.mintSeatToken('blue', 'guard');
    const unclaimed = match.mintSeatToken('red', 'runner');
    const runner = await ep.connect(runnerToken);
    const guard = await ep.connect(guardToken);
    try {
      const waits = roles.map((_, i) => call(i === 0 ? runner : guard, 'game_wait', { seconds: 60 }));
      await expect.poll(() => match.seats().filter((seat) => seat.team === 'blue' && seat.agentActive).length).toBe(2);
      await match.step(2);
      // An explicit authoritative game end, not an inferred win from the last observation.
      match.end({ blue: 'win', red: 'loss' });
      for (const result of await Promise.all(waits)) expect(result).toMatchObject({ phase: 'match', tick: 2, outcome: 'win' });
      expect(await call(runner, 'game_wait', { seconds: 60 })).toMatchObject({ tick: 2, outcome: 'win' });
      expect(await call(guard, 'game_observe')).toMatchObject({ observation: { tick: 2 } });
      for (const [name, args] of [
        ['game_act', { intents: [{ kind: 'stop' }] }],
        ['policy_deploy', { runtime: 'js', code: 'function think() { return []; }' }],
        ['game_ready', {}],
      ] as const) expect((await runner.callTool({ name, arguments: args })).isError).toBe(true);
      await expect(ep.connect(unclaimed)).rejects.toThrow();
      await expect(ep.connect(runnerToken)).rejects.toThrow();
      match.revokeSeat('blue', 'runner');
      await expect(call(runner, 'game_wait', { seconds: 0 })).rejects.toThrow();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000);
      try { await expect(call(guard, 'game_observe')).rejects.toThrow(); } finally { clock.mockRestore(); }
    } finally {
      await runner.close(); await guard.close(); await ep.close(); host.dispose();
    }
  });

  it('freezes an eliminated seat while survivors continue and returns its commander receipt', async () => {
    const host = createPlayerThreeHost({ definition: quadDefinition });
    const ep = await endpoint(host);
    const commander = host.commanders.create(OWNER, { name: 'North', kind: 'agent', roles: ['pilot'], isolation: { independentSessions: true } });
    const match = host.createMatch({ realtime: false, assignments: [{ owner: OWNER, commander: { id: commander.id }, team: 'north', role: 'pilot', kind: 'agent' }] });
    const direct = await ep.connect(match.mintSeatToken('north', 'pilot'));
    const persistent = await ep.connect(host.commanders.token(OWNER, commander.id));
    try {
      await call(persistent, 'game_observe');
      const pending = call(persistent, 'game_wait', { seconds: 60 });
      const directPending = call(direct, 'game_wait', { seconds: 60 });
      await call(direct, 'policy_status');
      match.forfeit('north');
      await match.step(1);
      expect(match.over).toBe(false);
      expect(await pending).toMatchObject({ outcome: 'loss', previousMatch: { match: match.id, role: 'pilot', team: 'north', tick: 1, disposition: 'final', outcome: 'loss' } });
      expect(await directPending).toMatchObject({ outcome: 'loss', tick: 1 });
      const frozen = await call(direct, 'game_observe');
      await match.step(3);
      expect(await call(direct, 'game_observe')).toEqual(frozen);
      expect(await call(direct, 'game_wait', { seconds: 0 })).toMatchObject({ tick: 1, outcome: 'loss' });
      expect(await call(persistent, 'game_observe')).toMatchObject({ phase: 'lobby', previousMatch: { match: match.id, outcome: 'loss' } });
      match.dispose();
      expect(await call(persistent, 'game_observe')).toMatchObject({ previousMatch: { outcome: 'loss', disposition: 'final' } });
    } finally { await direct.close(); await persistent.close(); await ep.close(); host.dispose(); }
  });

  it('restores independent role artifacts through two matches, HTTP reconnect, and host restart without model-state reuse', async () => {
    const store = memoryCommanderStore();
    let host = createPlayerThreeHost({ definition, commanderStore: store });
    let ep = await endpoint(host);
    const commander = host.commanders.create(OWNER, { name: 'Both', kind: 'agent', roles: [...roles], isolation: { independentSessions: true } });
    const token = host.commanders.token(OWNER, commander.id);
    let client = await ep.connect(token);
    try {
      for (const [index, role] of roles.entries()) {
        expect(await call(client, 'policy_deploy', { role, runtime: 'js', code: `let n = 0; function think() { log('${role}', ++n); return []; }` })).toMatchObject({ version: index + 1 });
      }
      expect(host.commanders.roster(OWNER)[0]!.policy.activeByRole).toEqual({ runner: 1, guard: 2 });
      let previous: string | undefined;
      for (let round = 0; round < 2; round++) {
        for (const role of roles) {
          host.commanders.reserve(OWNER, commander.id, role, { team: 'blue', start: { kind: 'host' } });
          await call(client, 'game_ready', { role });
        }
        const match = host.createMatch({ realtime: false, assignments: roles.map((role) => ({ owner: OWNER, commander: { id: commander.id }, team: 'blue', role, kind: 'agent' as const })) });
        for (const [index, role] of roles.entries()) {
          // No step or polling before status: it must await the actual library restoration.
          expect(await call(client, 'policy_status', { role })).toMatchObject({ policy: { version: index + 1, calls: 0, successfulCalls: 0 } });
          const entry = await call(client, 'game_wait', { role, seconds: 0 });
          expect(entry).toMatchObject({ phase: 'match', outcome: 'running', observation: { tick: 0 } });
          if (previous) expect(entry).toMatchObject({ previousMatch: { match: previous, outcome: 'win' } });
        }
        await match.step(1);
        for (const [index, role] of roles.entries()) expect(await call(client, 'policy_status', { role })).toMatchObject({ policy: { version: index + 1, logs: [`${role} 1`], successfulCalls: 1 } });
        match.end({ blue: 'win', red: 'loss' });
        for (const role of roles) expect(await call(client, 'game_wait', { role, seconds: 0 })).toMatchObject({ outcome: 'win', previousMatch: { match: match.id, role, disposition: 'final' } });
        // A response can disappear after the server returned it. Neither wait consumption nor detach deletes the receipt.
        await client.close(); match.dispose(); client = await ep.connect(token);
        for (const role of roles) expect(await call(client, 'game_wait', { role, seconds: 0 })).toMatchObject({ previousMatch: { match: match.id, role, outcome: 'win' } });
        previous = match.id;
      }
      await client.close(); await ep.close(); host.dispose(); await host.commanders.flush();
      host = createPlayerThreeHost({ definition, commanderStore: store });
      await host.ready; ep = await endpoint(host); client = await ep.connect(token);
      for (const [index, role] of roles.entries()) {
        expect(await call(client, 'policy_status', { role })).toMatchObject({ policy: { version: index + 1 } });
        expect(await call(client, 'game_observe', { role })).toMatchObject({ previousMatch: { match: previous, role, outcome: 'win' } });
      }
      const other = host.commanders.create('other_lifecycle_owner', { name: 'Other', kind: 'agent', roles: [...roles], isolation: { independentSessions: true } });
      const stranger = await ep.connect(host.commanders.token('other_lifecycle_owner', other.id));
      try { expect(await call(stranger, 'game_observe', { role: 'runner' })).not.toHaveProperty('previousMatch'); } finally { await stranger.close(); }
      host.commanders.rename(OWNER, commander.id, { name: 'Runner only', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } });
      expect((await client.callTool({ name: 'game_observe', arguments: { role: 'guard' } })).isError).toBe(true);
      host.commanders.rotate(OWNER, commander.id);
      await expect(call(client, 'game_observe', { role: 'runner' })).rejects.toThrow();
    } finally { await client.close(); await ep.close(); host.dispose(); await host.commanders.flush(); }
  });

  it('reports interrupted/unknown after release and restart, expires receipts, and never credits a revoked assignment', async () => {
    const store = memoryCommanderStore();
    const host = createPlayerThreeHost({ definition, commanderStore: store, history: { maxAgeMs: 1000 } });
    const ep = await endpoint(host);
    const commander = host.commanders.create(OWNER, { name: 'Both', kind: 'agent', roles: [...roles], isolation: { independentSessions: true } });
    const token = host.commanders.token(OWNER, commander.id);
    const client = await ep.connect(token);
    let restored: PlayerThreeHost | undefined;
    try {
      const match = host.createMatch({ realtime: false, assignments: roles.map((role) => ({ owner: OWNER, commander: { id: commander.id }, team: 'blue', role, kind: 'agent' as const })) });
      await match.step(2);
      await host.commanders.flush();
      const crashSnapshot = await store.load();
      await match.releaseBindings();
      for (const role of roles) expect(await call(client, 'game_observe', { role })).toMatchObject({ phase: 'lobby', previousMatch: { match: match.id, disposition: 'interrupted', outcome: 'unknown', tick: 2 } });
      restored = createPlayerThreeHost({ definition, commanderStore: { ...memoryCommanderStore(), load: () => crashSnapshot } });
      await restored.ready;
      const restarted = await endpoint(restored);
      const reconnect = await restarted.connect(token);
      try {
        for (const role of roles) expect(await call(reconnect, 'game_observe', { role })).toMatchObject({ previousMatch: { match: match.id, disposition: 'interrupted', outcome: 'unknown', tick: null } });
      } finally { await reconnect.close(); await restarted.close(); }
      const next = host.createMatch({ realtime: false, assignments: [{ owner: OWNER, commander: { id: commander.id }, team: 'blue', role: 'runner', kind: 'agent' }] });
      next.revokeSeat('blue', 'runner');
      next.end({ blue: 'win', red: 'loss' });
      expect(await call(client, 'game_observe', { role: 'runner' })).toMatchObject({ previousMatch: { match: match.id, outcome: 'unknown' } });
      expect(host.commanders.roster(OWNER)[0]!.record).toEqual({ wins: 0, losses: 0, draws: 0 });
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1001);
      try { expect(await call(client, 'game_observe', { role: 'runner' })).not.toHaveProperty('previousMatch'); } finally { clock.mockRestore(); }
    } finally { await client.close(); await ep.close(); host.dispose(); restored?.dispose(); }
  });

  it('migrates unambiguous legacy role records once and preserves ambiguous artifacts unassigned', async () => {
    const store = memoryCommanderStore();
    let host = createPlayerThreeHost({ definition, commanderStore: store });
    const single = host.commanders.create(OWNER, { name: 'Single', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } });
    const multi = host.commanders.create(OWNER, { name: 'Multi', kind: 'agent', roles: [...roles], isolation: { independentSessions: true } });
    for (const id of [single.id, multi.id]) {
      const session = host.agentSession(host.commanders.token(OWNER, id), 'runner')!;
      expect(await session.control.policyDeploy({ runtime: 'js', code: 'function think() { return []; }' })).toMatchObject({ ok: true });
    }
    await host.commanders.flush(); host.dispose();
    const data = await store.load();
    const owner = data.owners[0]!;
    owner.commanders = owner.commanders.map(({ activeByRole, results: _results, pendingMatches: _pending, ...saved }) => ({
      ...saved, active: activeByRole.runner, versions: saved.versions.map(({ role: _role, ...v }) => v),
    } as unknown as StoredCommander));
    await store.saveOwner(owner);
    host = createPlayerThreeHost({ definition, commanderStore: store });
    try {
      await host.ready;
      const roster = host.commanders.roster(OWNER);
      expect(roster.find((c) => c.id === single.id)!.policy).toMatchObject({ activeByRole: { runner: 1 }, versions: [{ version: 1, role: 'runner' }] });
      expect(roster.find((c) => c.id === multi.id)!.policy).toMatchObject({ activeByRole: { runner: null, guard: null }, versions: [{ version: 1, role: null }] });
      const ambiguous = host.agentSession(host.commanders.token(OWNER, multi.id), 'guard')!;
      expect(await ambiguous.control.policyStatus()).toEqual({ version: null, activationError: 'needs_role_deploy' });
      await expect(ambiguous.control.policyRollback(1)).rejects.toThrow();
      await host.commanders.flush();
      expect((await store.load()).owners[0]!.commanders.every((c) => !('active' in c))).toBe(true);
      expect(await store.loadArtifact(OWNER, multi.id, 1)).toMatchObject({ runtime: 'js', code: 'function think() { return []; }' });
    } finally { host.dispose(); }
  });
});
