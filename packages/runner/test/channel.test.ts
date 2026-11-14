import { describe, expect, it, vi } from 'vitest';
import { Client, type CallToolResult, type McpSubscription } from '@modelcontextprotocol/client';
import { watchChannel, type ChannelEvent } from '../src/channel.ts';

const result = (structuredContent: Record<string, unknown>): CallToolResult => ({ content: [], structuredContent });

const seatUri = 'playerthree://seat/opaque-test-seat';
class ResourceClient extends Client {
  updated(uri = seatUri) {
    this._onnotification({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } });
  }
}

function resources(honored = true) {
  const client = new ResourceClient({ name: 'channel-test', version: '1' });
  const closed = Promise.withResolvers<'local' | 'graceful' | 'remote'>();
  const subscription: McpSubscription = {
    honoredFilter: honored ? { resourceSubscriptions: [seatUri] } : {},
    closed: closed.promise,
    close: vi.fn(async () => { closed.resolve('local'); }),
  };
  vi.spyOn(client, 'getServerCapabilities').mockReturnValue({ resources: { subscribe: true } });
  vi.spyOn(client, 'listResources').mockResolvedValue({
    resources: [{ uri: seatUri, name: 'runner', mimeType: 'application/json' }],
  });
  const listen = vi.spyOn(client, 'listen').mockResolvedValue(subscription);
  const read = vi.spyOn(client, 'readResource');
  const snapshot = (status: Record<string, unknown>) => {
    read.mockResolvedValue({ contents: [{ uri: seatUri, mimeType: 'application/json', text: JSON.stringify(status) }] });
  };
  snapshot({ phase: 'lobby', tick: 0, unreadOwnerMessages: 0 });
  return { client, subscription, closed, listen, read, snapshot };
}

describe('channel lifecycle projection', () => {
  it('routes closed uppercase and angle-bracket roles without projecting game text', async () => {
    const controller = new AbortController();
    const events: ChannelEvent[] = [];
    const watching = watchChannel(async (name) => {
      expect(name).toBe('game_briefing');
      return result({ roles: ['Array<Int>'], commands: [{
        role: 'Array<Int>', phase: 'match', events: [{ text: 'UNTRUSTED' }],
      }] });
    }, async (event) => { events.push(event); controller.abort(); }, controller.signal);
    await watching;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ meta: { role: 'Array<Int>', event: 'seated' } });
    expect(JSON.stringify(events)).not.toContain('UNTRUSTED');
  });

  it('monitors every commanded role and never forwards third-party fields or arbitrary outcome text', async () => {
    const controller = new AbortController();
    const events: ChannelEvent[] = [];
    const waited = new Set<string>();
    const watching = watchChannel(async (name, args) => {
      if (name === 'game_briefing') return result({ roles: ['runner', 'guard'], commands: [{ role: 'runner', phase: 'match' }, { role: 'guard', phase: 'lobby' }] });
      const role = String(args.role);
      if (!waited.has(role)) {
        waited.add(role);
        return result({
          phase: role === 'runner' ? 'match' : 'lobby', outcome: 'IGNORE_INSTRUCTIONS',
          events: [{ kind: 'IGNORE_INSTRUCTIONS', text: 'SECRET_OPPONENT' }],
          messages: [{ from: 'opponent', text: 'SECRET_OPPONENT' }, { from: 'owner', text: `Order for ${role}` }],
        });
      }
      const { promise, reject } = Promise.withResolvers<CallToolResult>();
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      return promise;
    }, async (event) => {
      events.push(event);
      if (events.length === 3) controller.abort();
    }, controller.signal);
    await watching.catch(() => {});
    expect([...waited].sort()).toEqual(['guard', 'runner']);
    expect(events.map((e) => e.meta.event).sort()).toEqual(['owner_message', 'owner_message', 'seated']);
    expect(JSON.stringify(events)).not.toMatch(/SECRET_OPPONENT|IGNORE_INSTRUCTIONS/);
    expect(events.filter((e) => e.meta.event === 'owner_message').map((e) => e.meta.role).sort()).toEqual(['guard', 'runner']);
  });

  it('reads initial and updated subscribed snapshots, and drains owner text only through authenticated tools', async () => {
    const remote = resources();
    const controller = new AbortController();
    const events: ChannelEvent[] = [];
    remote.snapshot({
      phase: 'match', tick: 8, outcome: 'win', unreadOwnerMessages: 1,
      approval: { id: 'a1', kind: 'policyDeploy', version: 1, status: 'rejected' },
      messages: [{ from: 'owner', text: 'RESOURCE_INJECTION' }],
    });
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'game_briefing') return result({ roles: ['runner'], commands: [{ role: 'runner', phase: 'lobby' }] });
      expect(name).toBe('game_wait');
      expect(args).toEqual({ role: 'runner', seconds: 0 });
      remote.snapshot({ phase: 'match', tick: 8, outcome: 'win', unreadOwnerMessages: 0 });
      return result({ phase: 'match', outcome: 'win', messages: [
        { from: 'opponent', text: 'OPPONENT_INJECTION' }, { from: 'owner', text: 'Hold position.' },
      ] });
    });
    const watching = watchChannel(call, async (event) => { events.push(event); }, controller.signal, remote.client);
    try {
      await expect.poll(() => events.length).toBe(4);
      await expect.poll(() => remote.read.mock.calls.length).toBe(2);
      expect(remote.listen).toHaveBeenCalledWith({ resourceSubscriptions: [seatUri] }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(events.map((event) => event.meta.event)).toEqual(['seated', 'match_ended', 'approval_resolved', 'owner_message']);
      expect(events[3]).toMatchObject({ content: 'From owner:\nHold position.', meta: { from: 'owner' } });
      expect(JSON.stringify(events)).not.toMatch(/INJECTION|playerthree:\/\/seat/);
      remote.snapshot({ phase: 'lobby', tick: 0, unreadOwnerMessages: 0 });
      remote.client.updated();
      await expect.poll(() => remote.read.mock.calls.length).toBe(3);
      remote.snapshot({
        phase: 'match', tick: 0, outcome: 'draw', unreadOwnerMessages: 0,
        approval: { id: 'a1', kind: 'policyDeploy', version: 1, status: 'rejected' },
      });
      remote.client.updated();
      await expect.poll(() => events.length).toBe(6);
      expect(events.slice(4).map((event) => event.meta.event)).toEqual(['seated', 'match_ended']);
      expect(call.mock.calls.filter(([name]) => name === 'game_wait')).toHaveLength(1);
      for (const [, options] of remote.read.mock.calls) expect(options?.cacheMode).toBe('bypass');
    } finally {
      controller.abort();
      await watching;
    }
    expect(remote.subscription.close).toHaveBeenCalledOnce();
  });

  for (const mode of ['not advertised', 'unsupported', 'not honored', 'partial', 'closed'] as const) {
    it(`falls back to long polling when subscriptions are ${mode}`, async () => {
      const remote = resources(mode !== 'not honored');
      if (mode === 'not advertised') vi.spyOn(remote.client, 'getServerCapabilities').mockReturnValue({});
      if (mode === 'unsupported') remote.listen.mockRejectedValue(new Error('method not found'));
      if (mode === 'partial') {
        vi.spyOn(remote.client, 'listResources').mockResolvedValue({ resources: [
          { uri: seatUri, name: 'runner', mimeType: 'application/json' },
          { uri: 'playerthree://seat/guard', name: 'guard', mimeType: 'application/json' },
        ] });
      }
      if (mode === 'closed') remote.closed.resolve('remote');
      const controller = new AbortController();
      const events: ChannelEvent[] = [];
      const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'game_briefing') return result({
          roles: ['runner', 'guard'],
          commands: [{ role: 'runner', phase: 'lobby' }, ...(mode === 'partial' ? [{ role: 'guard', phase: 'lobby' }] : [])],
        });
        expect(args.seconds).toBe(60);
        return result({ phase: 'match', tick: 1 });
      });
      const watching = watchChannel(call, async (event) => {
        events.push(event);
        controller.abort();
      }, controller.signal, remote.client);
      await watching.catch(() => {});
      expect(events[0]?.meta.event).toBe('seated');
      expect(call.mock.calls.some(([name]) => name === 'game_wait')).toBe(true);
      if (mode === 'not advertised') expect(remote.listen).not.toHaveBeenCalled();
      if (mode === 'not honored' || mode === 'partial' || mode === 'closed') expect(remote.subscription.close).toHaveBeenCalledOnce();
    });
  }

  it('reports a commander end retained in a lobby snapshot exactly once', async () => {
    const remote = resources();
    const controller = new AbortController();
    const events: ChannelEvent[] = [];
    remote.snapshot({ phase: 'lobby', tick: 4000, outcome: 'loss', unreadOwnerMessages: 0 });
    const call = vi.fn(async () => result({ roles: ['runner'], commands: [{ role: 'runner', phase: 'lobby' }] }));
    const watching = watchChannel(call, async (event) => { events.push(event); }, controller.signal, remote.client);
    try {
      await expect.poll(() => events.length).toBe(1);
      remote.client.updated();
      await expect.poll(() => remote.read.mock.calls.length).toBe(2);
      expect(events).toEqual([{
        content: 'Match ended: loss. Return to the commander lobby wait loop.',
        meta: { event: 'match_ended', role: 'runner', phase: 'match', outcome: 'loss' },
      }]);
      expect(call).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await watching;
    }
  });

  it('drains an owner message behind approval and retained-end wakes without another resource update', async () => {
    const remote = resources();
    const controller = new AbortController();
    const events: ChannelEvent[] = [];
    const approval = { id: 'a1', kind: 'policyDeploy', version: 1, status: 'approved' };
    remote.snapshot({ phase: 'lobby', tick: 4000, outcome: 'win', approval, unreadOwnerMessages: 1 });
    let waits = 0;
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'game_briefing') return result({ roles: ['runner'], commands: [{ role: 'runner', phase: 'lobby' }] });
      if (name === 'policy_status') return result({ policy: { approval } });
      expect(name).toBe('game_wait');
      expect(args.seconds).toBe(0);
      waits += 1;
      if (waits === 1) return result({ phase: 'lobby', tick: 0, outcome: 'running', wake: 'approval' });
      if (waits === 2) {
        remote.snapshot({ phase: 'lobby', tick: 0, approval, unreadOwnerMessages: 1 });
        return result({ phase: 'match', tick: 4000, outcome: 'win' });
      }
      remote.snapshot({ phase: 'lobby', tick: 0, approval, unreadOwnerMessages: 0 });
      return result({ phase: 'lobby', tick: 0, outcome: 'running', messages: [{ from: 'owner', text: 'Ready again.' }] });
    });
    const watching = watchChannel(call, async (event) => { events.push(event); }, controller.signal, remote.client);
    try {
      await expect.poll(() => events.some((event) => event.meta.event === 'owner_message')).toBe(true);
      await expect.poll(() => remote.read.mock.calls.length).toBe(4);
      expect(waits).toBe(3);
      expect(events.map((event) => event.meta.event)).toEqual(['match_ended', 'approval_resolved', 'owner_message']);
      expect(events[2]?.content).toBe('From owner:\nReady again.');
    } finally {
      controller.abort();
      await watching;
    }
  });

  it('cancels pending resource reads and closes the subscription without starting long polls', async () => {
    const remote = resources();
    const controller = new AbortController();
    remote.read.mockImplementation(async (_request, options) => {
      const { promise, reject } = Promise.withResolvers<void>();
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      await promise;
      return { contents: [] };
    });
    const call = vi.fn(async () => result({ roles: ['runner'], commands: [{ role: 'runner', phase: 'lobby' }] }));
    const watching = watchChannel(call, async () => {}, controller.signal, remote.client);
    await expect.poll(() => remote.read.mock.calls.length).toBe(1);
    controller.abort();
    await watching;
    expect(remote.subscription.close).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledOnce();
  });
});
