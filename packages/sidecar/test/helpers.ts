import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export const RAW_ENGINE = fileURLToPath(new URL('./fixtures/raw-engine.mjs', import.meta.url));
export const MOCK_ENGINE = fileURLToPath(new URL('../conformance/mock-engine.mjs', import.meta.url));
export const RUNNER = fileURLToPath(new URL('../conformance/run.ts', import.meta.url));

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh socket path in a private temporary directory. */
export function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p3-sidecar-test-'));
  dirs.push(dir);
  return join(dir, 'engine.sock');
}

export interface RawEngine {
  child: ChildProcess;
  /** Every line the engine received, once it exited. */
  received: Promise<Record<string, unknown>[]>;
}

/** Starts `fixtures/raw-engine.mjs` in one of its modes against a listening socket. */
export function rawEngine(path: string, mode: string): RawEngine {
  const child = spawn(process.execPath, [RAW_ENGINE, path, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  let out = '';
  child.stdout!.setEncoding('utf8').on('data', (t: string) => (out += t));
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown>[]>();
  child.once('exit', () => resolve(out.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>)));
  return { child, received: promise };
}

/** Runs a command to completion; resolves with its exit code and stderr. */
export function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
  children.push(child);
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (t: string) => (stderr += t));
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; stderr: string }>();
  child.once('exit', (code) => resolve({ code, stderr }));
  return promise;
}
