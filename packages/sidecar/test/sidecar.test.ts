import { describe, expect, it } from 'vitest';
import { member, type Msg } from '../src/protocol.ts';
import { startSidecar } from '../src/sidecar.ts';
import { rawEngine, socketPath } from './helpers.ts';

async function sidecarWith(mode: string, opts: { helloTimeoutMs?: number } = {}) {
  const path = socketPath();
  const records: { dir: 'in' | 'out'; msg: Msg }[] = [];
  const sidecar = await startSidecar({ transport: { kind: 'socket', path }, tap: (dir, msg) => records.push({ dir, msg }), ...opts });
  const engine = rawEngine(path, mode);
  return { sidecar, engine, records };
}

describe('sidecar handshake', () => {
  it('rejects an invalid manifest and closes', async () => {
    const { sidecar, engine } = await sidecarWith('bad-manifest');
    await expect(sidecar.ready).rejects.toThrow();
    expect((await sidecar.closed).code).toBe('invalid_manifest');
    expect((await engine.received)[0]).toMatchObject({ op: 'error', code: 'invalid_manifest' });
  });

  it('rejects another protocol version', async () => {
    const { sidecar, engine } = await sidecarWith('bad-protocol');
    expect((await sidecar.closed).code).toBe('protocol');
    expect((await engine.received)[0]).toMatchObject({ op: 'error', code: 'protocol' });
  });

  it('closes an engine that never says hello', async () => {
    const { sidecar } = await sidecarWith('silent', { helloTimeoutMs: 200 });
    expect(await sidecar.closed).toEqual({ reason: 'no hello in time', code: 'protocol' });
  });
});

describe('engine disconnect', () => {
  it('disposes every session and revokes its seat tokens', async () => {
    const { sidecar, engine, records } = await sidecarWith('tug-then-hangup');
    const host = await sidecar.ready;
    await expect.poll(() => records.some((r) => typeof member(r.msg.data, 'token') === 'string')).toBe(true);
    const minted = records.map((r) => member(r.msg.data, 'token')).find((t) => typeof t === 'string') as string;
    const created = records.find((r) => r.dir === 'out' && r.msg.op === 'result' && typeof member(r.msg.data, 'session') === 'string');
    const session = member(created?.msg.data, 'session') as string;
    expect(records.find((r) => r.msg.op === 'call' && r.msg.method === 'create')?.msg).toMatchObject({ session, args: [{ seed: 1, teams: ['north', 'south'] }] });
    expect(sidecar.match(session)).toBeDefined();
    expect(host.authenticate(minted)).toBeDefined();
    expect((await engine.received)[0]).toMatchObject({ op: 'ready', surfaceHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await sidecar.closed).toEqual({ reason: 'engine closed the connection' });
    expect(sidecar.match(session)).toBeUndefined();
    expect(host.matches()).toEqual([]);
    expect(host.authenticate(minted)).toBeUndefined();
  });
});
