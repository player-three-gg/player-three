import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runConformance } from '../conformance/run.ts';
import { SOCKET_ENV } from '../src/protocol.ts';
import { MOCK_ENGINE, RUNNER, run, socketPath } from './helpers.ts';

const expected = readFileSync(new URL('../conformance/tug.transcript.jsonl', import.meta.url), 'utf8').split('\n').filter((l) => l !== '');

describe('Tug of War end to end', () => {
  it('an MCP agent takes the seat, observes and acts; the mock engine applies it (socket)', async () => {
    const path = socketPath();
    const report = await runConformance({
      transport: { kind: 'socket', path },
      expected,
      timeoutMs: 30_000,
      launch: () => spawn(process.execPath, [MOCK_ENGINE], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, [SOCKET_ENV]: path } }),
    });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    const lines = report.transcript.map((l) => JSON.parse(l) as Record<string, unknown>);
    // The agent's pull reaches the engine's apply with the trusted agent context, and the engine steps the match.
    expect(lines).toContainEqual(expect.objectContaining({ from: 'host', op: 'call', method: 'apply', args: [{ team: 'north', role: 'puller' }, { kind: 'pull', strength: 3 }, { source: 'agent' }] }));
    expect(lines.filter((l) => l.method === 'step')).toHaveLength(19);
    expect(lines.filter((l) => l.method === 'think' && l.session === 'b2')).toHaveLength(19);
  }, 40_000);

  it('passes the same conformance with the engine spawning the runner over stdio', async () => {
    const { code, stderr } = await run(process.execPath, [MOCK_ENGINE, '--', process.execPath, RUNNER, '--stdio', '--timeout', '30']);
    expect(stderr).toContain('conformance: PASS');
    expect(code).toBe(0);
  }, 40_000);
});
