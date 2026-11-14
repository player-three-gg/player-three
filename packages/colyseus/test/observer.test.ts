import { describe, expect, it, vi } from 'vitest';
import { ClientState, type Client } from '@colyseus/core';
import { MSG, type ObserverMessage, type Principal } from 'playerthree';
import type { AuthorizationLease } from 'playerthree/host';
import { bindPlayerThreeRoom, type PlayerThreeHostPort, type PlayerThreeMatchPort, type PlayerThreeRoomLike } from '../src/index.ts';

function fixture(teams: readonly string[] = ['blue', 'red']) {
  const principal: Extract<Principal, { kind: 'observer' }> = {
    kind: 'observer', match: 'match', grant: { kind: 'omniscient', teams: ['blue', 'red'], delayMs: 180_000 },
  };
  const lease: AuthorizationLease = { id: 'lease', principal };
  let valid = true;
  let revoke: ((lease: AuthorizationLease) => void) | undefined;
  const host: PlayerThreeHostPort = {
    authenticate: () => valid ? { match: { id: 'match' }, principal } : undefined,
    claimToken: () => valid ? lease : undefined,
    authorizeLease: vi.fn(() => valid ? principal : undefined),
    disconnectLease: vi.fn(),
    onLeaseRevoked: (listener) => { revoke = listener; return () => {}; },
  };
  const callbacks = new Map<string, (client: Client, message: unknown) => unknown>();
  const timers: (() => void)[] = [];
  const room: PlayerThreeRoomLike = {
    onMessage: (type, callback) => callbacks.set(type, callback),
    clock: { setInterval: (callback) => { timers.push(callback); return { clear: vi.fn() }; } },
  };
  let observer: ObserverMessage[] = [{ op: 'observer', state: 'buffering' }];
  const match: PlayerThreeMatchPort = {
    id: 'match', teams, seats: () => [], cards: () => [], humanJoined: vi.fn(),
    readiness: () => ({ mode: 'none', pending: false, seats: [] }), setHumanReady: vi.fn(),
    outcome: () => 'running', report: vi.fn(),
    observerMessages: vi.fn((_principal: unknown, _perspective: string, after?: number) => observer.filter((message) => !message.frame || after === undefined || message.frame.sequence > after)),
    onView: vi.fn(() => () => {}), viewMessages: vi.fn(() => []), onEnd: () => () => {},
    handleMessage: vi.fn(async () => undefined), release: vi.fn(), dispose: vi.fn(),
  };
  const connect = (sessionId: string) => {
    const socket = { sessionId, state: ClientState.JOINED, ref: undefined, enqueueRaw: vi.fn(), raw: vi.fn(), leave: vi.fn() };
    // The binding consumes this documented structural subset of the Colyseus client.
    const client = socket as unknown as Client;
    expect(binding.onAuth(client, { token: 'a'.repeat(32) })).toEqual(principal);
    binding.onJoin(client);
    return { socket, client };
  };
  const binding = bindPlayerThreeRoom(room, { host, match, viewIntervalMs: 0 });
  const { socket, client } = connect('client');
  return {
    socket, client, binding, match, host, principal, connect,
    receive(type: string, message: unknown) { return callbacks.get(type)?.(client, message); },
    tick() { for (const timer of timers) timer(); },
    frame(...messages: ObserverMessage[]) { observer = messages; },
    revoke() { valid = false; revoke?.(lease); },
    expire() { valid = false; },
  };
}

describe('observer capability transport', () => {
  it('has no live bootstrap, report, seat or owner channel', () => {
    const f = fixture();
    // An observer never subscribes to (or reads) a live team view stream.
    expect(f.match.onView).not.toHaveBeenCalled();
    expect(f.match.viewMessages).not.toHaveBeenCalled();
    expect(f.match.report).not.toHaveBeenCalled();
    expect(f.socket.enqueueRaw).toHaveBeenCalledTimes(1); // admission metadata + buffering only
    f.tick();
    expect(f.socket.enqueueRaw).toHaveBeenCalledTimes(1);
    for (const [type, op] of [[MSG.call, 'call'], [MSG.tell, 'tell'], [MSG.mint, 'mint'], [MSG.controller, 'controller'], [MSG.mandate, 'mandate'], [MSG.stream, 'stream']]) {
      f.receive(type!, { op, seq: 1, role: 'role', method: 'deploy', args: {} });
    }
    expect(f.match.handleMessage).not.toHaveBeenCalled();
    f.binding.dispose();
  });

  it('accepts only declared perspectives and never player watch expansion', () => {
    const f = fixture();
    const observe = vi.mocked(f.match.observerMessages);
    observe.mockClear();
    f.receive(MSG.watch, { op: 'watch', teams: ['blue', 'red'] });
    f.receive(MSG.observer, { perspective: 'unknown' });
    f.receive(MSG.observer, { perspective: 'red', noFog: true });
    expect(observe).not.toHaveBeenCalled();
    f.receive(MSG.observer, { perspective: 'red', after: 0 });
    expect(observe).toHaveBeenCalledWith(f.principal, 'red', 0);
    f.binding.dispose();
  });

  it('never serves a perspective outside the match teams, even if a grant names it', () => {
    const f = fixture(['blue']);
    const observe = vi.mocked(f.match.observerMessages);
    observe.mockClear();
    f.receive(MSG.observer, { perspective: 'red' });
    expect(observe).not.toHaveBeenCalled();
    f.receive(MSG.observer, { perspective: 'blue' });
    expect(observe).toHaveBeenCalledWith(f.principal, 'blue', undefined);
    f.binding.dispose();
  });

  it('rechecks active leases on requests and timer deliveries and closes revocations', () => {
    const expired = fixture();
    expired.expire();
    expired.frame({ op: 'observer', state: 'ready', frame: { sequence: 1, tick: 10, recordedAt: 0, releaseAt: 180_000, perspective: 'all', world: {} } });
    expired.tick();
    expect(expired.socket.enqueueRaw).toHaveBeenCalledTimes(1);
    expect(expired.socket.leave).toHaveBeenCalledWith(4001);
    expect(expired.binding.principal(expired.client)).toBeUndefined();
    expired.binding.dispose();
    const revoked = fixture();
    revoked.revoke();
    revoked.receive(MSG.observer, { perspective: 'all' });
    expect(revoked.socket.leave).toHaveBeenCalledWith(4001);
    expect(revoked.match.observerMessages).toHaveBeenCalledTimes(1);
    revoked.binding.dispose();
  });

  it('fans out one encoding per released frame to every observer, in order, after one batch', () => {
    const f = fixture();
    const second = f.connect('second');
    const frame = (sequence: number, body: { world: unknown } | { delta: { v: Record<string, number> } }): ObserverMessage =>
      Object.freeze({ op: 'observer', state: 'ready', frame: { sequence, tick: sequence, recordedAt: sequence * 50, releaseAt: 180_000 + sequence * 50, perspective: 'all', ...body } });
    f.frame(frame(1, { world: { tick: 1 } }), frame(2, { delta: { v: { tick: 2 } } }), frame(3, { delta: { v: { tick: 3 } } }));
    f.socket.enqueueRaw.mockClear(); second.socket.enqueueRaw.mockClear();
    f.tick();
    const sent = f.socket.enqueueRaw.mock.calls.map(([bytes]) => bytes as Buffer);
    expect(sent).toHaveLength(3);
    // Same Buffer instances: the frame was encoded once, not per observer.
    expect(second.socket.enqueueRaw.mock.calls.map(([bytes]) => bytes)).toEqual(sent);
    for (const [index, bytes] of sent.entries()) expect(bytes).toBe(second.socket.enqueueRaw.mock.calls[index]![0]);
    // Frames carry no per-observer admission metadata, so one encoding fits every grant of the scope.
    expect(sent.some((bytes) => bytes.includes('grant'))).toBe(false);
    f.tick();
    expect(f.socket.enqueueRaw).toHaveBeenCalledTimes(3);
    expect(vi.mocked(f.match.observerMessages)).toHaveBeenLastCalledWith(f.principal, 'all', 3);
    f.binding.dispose();
  });
});
