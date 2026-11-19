import { readFileSync } from 'node:fs';

/**
 * This package's version as released, read from its own package.json (one level above `src/` in a checkout, two
 * above `dist/src/` when installed), so client identities follow every Changesets version bump.
 */
export const PACKAGE_VERSION: string = (() => {
  for (const path of ['../package.json', '../../package.json']) {
    let pkg: { name?: unknown; version?: unknown };
    try {
      pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as typeof pkg;
    } catch {
      continue;
    }
    if (pkg.name === '@playerthree/runner' && typeof pkg.version === 'string') return pkg.version;
  }
  throw new Error('@playerthree/runner: its package.json is missing');
})();
