#!/usr/bin/env node
// release: publish the fixed-version PlayerThree packages, choosing the npm dist-tag from the version.
//
//   node scripts/release.mjs                       `changeset publish` every package version not yet on npm
//   node scripts/release.mjs --dry-run             the same through `pnpm -r publish --dry-run`; nothing is uploaded
//   node scripts/release.mjs --set-version <v>     set the one fixed version (package.json + CHANGELOG heading) and exit
//
// Dist-tag: a suffixed version (0.2.0-next.0) publishes to `next`, a release version (0.1.0) to `latest`. In
// Changesets pre mode (.changeset/pre.json) Changesets picks the pre tag itself. The release workflow runs this
// after scripts/verify-pack.mjs; locally, run `pnpm verify-pack && pnpm release` after `npm login`.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, 'set-version': { type: 'string' } }, strict: true });

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

const packages = readdirSync(join(ROOT, 'packages'))
  .map((dir) => join(ROOT, 'packages', dir))
  .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))
  .filter(({ pkg }) => !pkg.private);
const versions = new Set(packages.map(({ pkg }) => pkg.version));
if (versions.size !== 1) {
  console.error(`release: the packages must share one fixed version, found ${[...versions].join(', ')}`);
  process.exit(1);
}
const [version] = versions;

if (opts['set-version'] !== undefined) {
  const next = opts['set-version'];
  if (!SEMVER.test(next)) {
    console.error(`release: ${next} is not a semver version`);
    process.exit(1);
  }
  for (const { dir, pkg } of packages) {
    // Textual replacement keeps each manifest's formatting.
    const manifest = join(dir, 'package.json');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(`"version": "${version}"`, `"version": "${next}"`));
    const changelog = join(dir, 'CHANGELOG.md');
    if (existsSync(changelog)) writeFileSync(changelog, readFileSync(changelog, 'utf8').replace(`\n## ${version}\n`, `\n## ${next}\n`));
    console.log(`${pkg.name}: ${version} → ${next}`);
  }
  process.exit(0);
}

const run = (cmd, args) => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
};

const prePath = join(ROOT, '.changeset', 'pre.json');
const pre = existsSync(prePath) ? JSON.parse(readFileSync(prePath, 'utf8')) : undefined;
const preMode = pre?.mode === 'pre';
const tag = preMode ? pre.tag : SEMVER.exec(version)[4] ? 'next' : 'latest';
console.log(`release: ${packages.length} packages at ${version}, dist-tag ${tag}${preMode ? ' (Changesets pre mode)' : ''}${process.env.NPM_CONFIG_PROVENANCE === 'true' ? ', with provenance' : ''}`);

if (opts['dry-run']) run('pnpm', ['-r', '--filter', './packages/*', 'publish', '--dry-run', '--no-git-checks', '--access', 'public', '--tag', tag]);
else run('pnpm', ['exec', 'changeset', 'publish', ...(preMode ? [] : ['--tag', tag])]);
