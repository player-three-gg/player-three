/** View-stream fan-out: keyframe on join/watch, shared encodings, and team streams subscribed only while watched. */
import { describe, expect, it, vi } from 'vitest';
import { ClientState, type Client } from '@colyseus/core';
import { MSG, type Principal, type ViewMessage } from 'playerthree';
import type { AuthorizationLease } from 'playerthree/host';
import { bindPlayerThreeRoom, type PlayerThreeHostPort, type PlayerThreeMatchPort, type PlayerThreeRoomLike } from '../src/index.ts';

function fixture() {
  const principals: Record<string, Principal> = {
    ['b'.repeat(32)]: { kind: 'team', match: 'match', team: 'blue' },
    ['c'.repeat(32)]: { kind: 'team', match: 'match', team: 'blue' },
    ['s'.repeat(32)]: { kind: 'spectator', match: 'match' },
  };
  let leases = 0;
  const host: PlayerThreeHostPort = {
    authenticate: (token) => principals[token] ? { match: { id: 'match' }, principal: principals[token]! } : undefined,
    claimToken: (token) => principals[token] ? { id: `lease-${++leases}`, principal: principals[token]! } satisfies AuthorizationLease : undefined,
    authorizeLease: (lease) => lease.principal,
    disconnectLease: vi.fn(),
    onLeaseRevoked: () => () => {},
  };
  const callbacks = new Map<string, (client: Client, message: unknown) => unknown>();
  const timers: (() => void)[] = [];
  const room: PlayerThreeRoomLike = {
    onMessage: (type, callback) => callbacks.set(type, callback),
    clock: { setInterval: (callback) => { timers.push(callback); return { clear: vi.fn() }; } },
  };
  /** Per team: its messages by version, and its live subscriptions. */
  const streams = new Map<string, { messages: ViewMessage[]; listeners: Set<(version: number) => void> }>();
  const stream = (team: string) => {
    let s = streams.get(team);
    if (!s) streams.set(team, s = { messages: [], listeners: new Set() });
    return s;
  };
  const push = (team: string, keyframe: unknown, delta?: unknown) => {
    const s = stream(team);
    const version = s.messages.length + 1;
    s.messages.push(Object.freeze(delta === undefined
      ? { op: 'view', team, version, view: keyframe } as ViewMessage
      : { op: 'view', team, version, delta } as ViewMessage));
    for (const listener of s.listeners) listener(version);
  };
  const match: PlayerThreeMatchPort = {
    id: 'match', teams: ['blue', 'red'], seats: () => [], cards: () => [], humanJoined: vi.fn(),
    readiness: () => ({ mode: 'none', pending: false, seats: [] }), setHumanReady: vi.fn(),
    outcome: () => 'running', report: vi.fn(), observerMessages: vi.fn(() => []),
    onView: vi.fn((team: string, listener: (version: number) => void) => {
      stream(team).listeners.add(listener);
      return () => { stream(team).listeners.delete(listener); };
    }),
    // Fresh readers get the latest keyframe; others the messages after their version.
    viewMessages: vi.fn((team: string, after?: number) => {
      const all = stream(team).messages;
      if (after === undefined) return all.length ? [{ op: 'view', team, version: all.length, view: { fresh: all.length } } as ViewMessage] : [];
      return all.slice(after);
    }),
    onEnd: () => () => {},
    handleMessage: vi.fn(async () => undefined), release: vi.fn(), dispose: vi.fn(),
  };
  const binding = bindPlayerThreeRoom(room, { host, match, viewIntervalMs: 0 });
  const connect = (sessionId: string, token: string, options?: unknown) => {
    const socket = { sessionId, state: ClientState.JOINED, ref: undefined, enqueueRaw: vi.fn(), raw: vi.fn(), leave: vi.fn() };
    const client = socket as unknown as Client;
    expect(binding.onAuth(client, { token })).toBeTruthy();
    binding.onJoin(client, options);
    return { socket, client };
  };
  return {
    binding, match, streams, push, connect,
    receive(client: Client, type: string, message: unknown) { return callbacks.get(type)?.(client, message); },
    async flush() { await Promise.resolve(); for (const timer of timers) timer(); },
  };
}

describe('view stream fan-out', () => {
  it('readers of one team share one subscription and one encoding per message', async () => {
    const f = fixture();
    f.push('blue', { tick: 1 });
    const a = f.connect('a', 'b'.repeat(32));
    const b = f.connect('b', 'c'.repeat(32));
    expect(f.match.onView).toHaveBeenCalledTimes(1);
    // Each joiner starts from a keyframe of the latest version.
    expect(f.match.viewMessages).toHaveBeenNthCalledWith(1, 'blue');
    f.push('blue', undefined, { v: { tick: 2 } });
    await f.flush();
    const sent = (s: { enqueueRaw: { mock: { calls: unknown[][] } } }) => s.enqueueRaw.mock.calls.map((call) => call[0]);
    const delta = sent(a.socket).at(-1);
    expect(delta).toBeInstanceOf(Buffer);
    // The very same bytes object went to both readers: encoded once, fanned out.
    expect(sent(b.socket).at(-1)).toBe(delta);
    expect(f.match.viewMessages).toHaveBeenCalledWith('blue', 1);
    f.binding.onLeave(a.client);
    expect(f.streams.get('blue')!.listeners.size).toBe(1);
    f.binding.onLeave(b.client);
    // Nobody watches blue any more: its stream is no longer computed.
    expect(f.streams.get('blue')!.listeners.size).toBe(0);
  });

  it('a spectator switching teams moves its subscription and restarts the new team from a keyframe', async () => {
    const f = fixture();
    f.push('red', { tick: 1 });
    f.push('blue', { tick: 1 });
    const s = f.connect('s', 's'.repeat(32), { watch: ['red'] });
    expect(f.streams.get('red')!.listeners.size).toBe(1);
    expect(f.streams.get('blue')!.listeners.size).toBe(0);
    f.receive(s.client, MSG.watch, { op: 'watch', teams: ['blue'] });
    expect(f.streams.get('red')!.listeners.size).toBe(0);
    expect(f.streams.get('blue')!.listeners.size).toBe(1);
    expect(f.match.viewMessages).toHaveBeenLastCalledWith('blue');
    // Back to red later: its old version is forgotten, so it gets a keyframe again, not a delta from the past.
    f.receive(s.client, MSG.watch, { op: 'watch', teams: ['red'] });
    expect(f.match.viewMessages).toHaveBeenLastCalledWith('red');
    f.binding.dispose();
    expect(f.streams.get('red')!.listeners.size).toBe(0);
  });
});
