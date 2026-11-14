import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { benchmarkSourceDigest } from '../src/source-digest.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('pins actual dirty bytes independently of traversal order and ignores generated output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'playerthree-source-pin-')); directories.push(root);
  await writeFile(join(root, 'a.ts'), 'export const version = 1;');
  await writeFile(join(root, 'b.ts'), 'export const rules = 1;');
  const pin = await benchmarkSourceDigest({ root, paths: ['a.ts', 'b.ts'] });
  expect(await benchmarkSourceDigest({ root, paths: ['b.ts', 'a.ts'] })).toBe(pin);
  await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist', 'generated.js'), 'generated');
  expect(await benchmarkSourceDigest({ root, paths: ['.'] })).toBe(pin);
  await writeFile(join(root, 'b.ts'), 'export const rules = 2;');
  expect(await benchmarkSourceDigest({ root, paths: ['a.ts', 'b.ts'] })).not.toBe(pin);
  await expect(benchmarkSourceDigest({ root, paths: ['../outside'] })).rejects.toThrow('escapes');
  await symlink(join(root, 'a.ts'), join(root, 'link.ts'));
  await expect(benchmarkSourceDigest({ root, paths: ['link.ts'] })).rejects.toThrow('symlink');
});
