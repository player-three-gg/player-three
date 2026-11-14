import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EngineLink, SidecarCallError } from '../src/link.ts';
import { MAX_LINE_BYTES, type Msg } from '../src/protocol.ts';
import { rawEngine, socketPath } from './helpers.ts';

async function linked(mode: string, callTimeoutMs = 2000) {
  const path = socketPath();
  const messages: Msg[] = [];
  const link = await EngineLink.open({ transport: { kind: 'socket', path }, callTimeoutMs });
  link.onMessage = (m) => messages.push(m);
  const engine = rawEngine(path, mode);
  await link.connected;
  return { path, link, engine, messages };
}

const failure = (fn: () => unknown): SidecarCallError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SidecarCallError) return e;
    throw e;
  }
  throw new Error('expected the call to fail');
};

describe('engine link', () => {
  it('listens owner-only and takes exactly one engine', async () => {
    const path = socketPath();
    const link = await EngineLink.open({ transport: { kind: 'socket', path } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rawEngine(path, 'echo');
    await link.connected;
    // The listener is gone with its socket file: nobody else can connect.
    expect(existsSync(path)).toBe(false);
    link.close();
    expect(await link.closed).toEqual({ reason: 'host closed the connection' });
  });

  it('frames messages split across writes and batched in one', async () => {
    const { link, messages } = await linked('split');
    await expect.poll(() => messages.length).toBe(3);
    expect(messages.map((m) => [m.id, m.method])).toEqual([[1, 'first'], [2, 'second'], [3, 'third']]);
    link.close();
  });

  it('correlates synchronous calls with their results by id', async () => {
    const { link, engine } = await linked('echo');
    const seat = { team: 'north', role: 'puller' };
    expect(link.call('s1', 'observe', [seat, 0, []])).toEqual({ method: 'observe', args: [seat, 0, []] });
    expect(link.call('s1', 'outcome', ['north'])).toEqual({ method: 'outcome', args: ['north'] });
    link.close();
    const calls = (await engine.received).filter((m) => m.op === 'call');
    expect(calls).toEqual([
      { op: 'call', id: 1, session: 's1', method: 'observe', args: [seat, 0, []] },
      { op: 'call', id: 2, session: 's1', method: 'outcome', args: ['north'] },
    ]);
  });

  it('turns ok:false into the engine code', async () => {
    const { link } = await linked('refuse');
    const e = failure(() => link.call('s1', 'nope', []));
    expect([e.code, e.message]).toEqual(['unknown_method', 'nope']);
    expect(link.isClosed).toBe(false);
    link.close();
  });

  it('closes on a result for an id that is not outstanding', async () => {
    const { link, engine } = await linked('wrong-id');
    expect(failure(() => link.call('s1', 'step', [])).code).toBe('engine_closed');
    expect((await link.closed).code).toBe('bad_frame');
    expect((await engine.received).at(-1)).toMatchObject({ op: 'error', code: 'bad_frame' });
  });

  it('times out a call, then tells the engine and closes', async () => {
    const { link, engine } = await linked('silent', 150);
    const started = Date.now();
    expect(failure(() => link.call('s1', 'step', [])).code).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect((await link.closed).code).toBe('timeout');
    expect((await engine.received).at(-1)).toMatchObject({ op: 'error', code: 'timeout' });
    expect(failure(() => link.call('s1', 'step', [])).code).toBe('engine_closed');
  });

  it('fails the pending call when the engine disconnects', async () => {
    const { link } = await linked('hangup');
    expect(failure(() => link.call('s1', 'step', [])).code).toBe('engine_closed');
    expect(await link.closed).toEqual({ reason: 'engine closed the connection' });
    expect(failure(() => link.call('s1', 'step', [])).code).toBe('engine_closed');
  });

  it(`accepts an engine line of exactly ${MAX_LINE_BYTES} bytes`, async () => {
    const { link, messages } = await linked('exact');
    await expect.poll(() => messages.length, { timeout: 5000 }).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(messages[0]))).toBe(MAX_LINE_BYTES);
    link.close();
  });

  it('closes with too_large on a longer engine line', async () => {
    const { link, engine, messages } = await linked('oversize');
    expect((await link.closed).code).toBe('too_large');
    expect(messages).toEqual([]);
    expect(await engine.received).toEqual([{ op: 'error', code: 'too_large' }]);
  });

  it('closes with bad_frame on a non-JSON line', async () => {
    const { link, engine } = await linked('garbage');
    expect((await link.closed).code).toBe('bad_frame');
    expect((await engine.received)[0]).toMatchObject({ op: 'error', code: 'bad_frame' });
  });

  it('refuses to send a host message over the limit without closing', async () => {
    const { link } = await linked('echo');
    expect(() => link.call('s1', 'think', ['x'.repeat(MAX_LINE_BYTES)])).toThrow(/exceeds/);
    expect(link.call('s1', 'step', [])).toEqual({ method: 'step', args: [] });
    link.close();
  });
});
