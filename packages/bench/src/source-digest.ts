/** Benchmark source digest: one digest over the SHA-256 of every file under the given root-relative paths. */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { benchmarkDigest } from 'playerthree/benchmark';

/** `paths` are relative to `root`; directories are walked, skipping `node_modules`, `.git`, `dist` and `.cache`; symlinks are refused. */
export interface BenchmarkSources { root: string; paths: readonly string[] }
/** Hash actual source bytes (including dirty edits), never infer a clean build from a commit label. */
export async function benchmarkSourceDigest(input: BenchmarkSources): Promise<string> {
  if (!input.paths.length) throw new Error('Source digest requires explicit inputs');
  const root = resolve(input.root);
  const files = new Map<string, string>();
  const visit = async (path: string): Promise<void> => {
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Source input escapes root');
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Source input cannot be a symlink');
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        if (['node_modules', '.git', 'dist', '.cache'].includes(entry)) continue;
        await visit(join(path, entry));
      }
    } else if (stat.isFile()) files.set(rel.split(sep).join('/'), createHash('sha256').update(await readFile(path)).digest('hex'));
    else throw new Error('Source input must be a file or directory');
  };
  for (const path of input.paths) { if (isAbsolute(path)) throw new Error('Source paths must be root-relative'); await visit(resolve(root, path)); }
  if (!files.size) throw new Error('Source inputs contain no files');
  return benchmarkDigest([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
