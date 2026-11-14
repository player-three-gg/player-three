#!/usr/bin/env node
// verify-pack: what npm would ship, checked as a consumer sees it, without publishing anything.
//
//   node scripts/verify-pack.mjs [--keep]
//
// 1. `pnpm -r pack` every public package under packages/ into a temporary directory (prepack builds dist/).
// 2. Checks each tarball: the allowlisted files only (dist, README, CHANGELOG, LICENSE, NOTICE); every TypeScript
//    source compiled and every non-TypeScript source asset copied into dist; exports, types and bins resolving
//    inside the tarball; no `workspace:` ranges; internal dependencies pinned to the release version; engines,
//    sideEffects, licence, public access and the repository URL trusted publishing matches; no checkout paths; size.
// 3. Installs the tarballs into a fresh project outside the workspace (pnpm, isolated node_modules, so an
//    undeclared dependency fails), imports every public export with `node -e`, runs every bin's `--help`, typechecks
//    a consumer file against the installed types, serves the README's Tug of War example and runs the sidecar
//    conformance runner over stdio and a socket, all from the installed packages.
//
// Exits 1 on any failure. --keep leaves the temporary directory in place.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false } }, strict: true });

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const REPOSITORY = 'git+https://github.com/player-three-gg/player-three.git';
const LICENSE = 'Apache-2.0';
/** A packed tarball above this is almost certainly shipping something by accident. */
const MAX_TARBALL_BYTES = 1024 * 1024;
/** Every tarball carries these besides dist/. */
const META_FILES = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE'];
const FORBIDDEN = [
  [/\.map$/, 'source map'],
  [/(^|\/)tests?\//, 'test directory'],
  [/\.(test|spec)\.[cm]?[jt]s$/, 'test file'],
  [/(^|\/)fixtures?\//, 'fixture directory'],
  [/\.tsbuildinfo$/, 'build info'],
  [/(^|\/)\.[^/]+$/, 'dotfile'],
  [/(?<!\.d)\.[cm]?ts$/, 'TypeScript source'],
];

const rootPkg = readJson(join(ROOT, 'package.json'));
const failures = [];
const fail = (what) => {
  failures.push(what);
  console.log(`  FAIL ${what}`);
};
const pass = (what) => console.log(`  ok   ${what}`);
const check = (ok, what) => (ok ? pass(what) : fail(what));
const section = (title) => console.log(`\n== ${title}`);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every file under `dir`, as `/`-separated paths relative to it. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, base));
    else out.push(relative(base, path).split(sep).join('/'));
  }
  return out.sort();
}

/** Runs a command to completion; throws with its output unless it exits 0. */
function run(cmd, args, { cwd = ROOT, timeoutMs = 600_000, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status ?? r.signal ?? r.error?.message}\n${output}`);
  return output;
}

/** Runs a command, resolving with its exit code and combined output; kills it after `timeoutMs`. */
function runAsync(cmd, args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? signal, output });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

// ------------------------------------------------------------------ workspace packages

const packages = readdirSync(join(ROOT, 'packages'))
  .map((dir) => ({ dir: join(ROOT, 'packages', dir), pkg: readJson(join(ROOT, 'packages', dir, 'package.json')) }))
  .filter(({ pkg }) => !pkg.private)
  .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
const names = new Set(packages.map(({ pkg }) => pkg.name));
const versions = new Set(packages.map(({ pkg }) => pkg.version));
const tmp = mkdtempSync(join(tmpdir(), 'p3-verify-pack-'));
const packDir = join(tmp, 'packs');
mkdirSync(packDir);

try {
  section(`packing ${packages.length} packages`);
  check(versions.size === 1, `one fixed version for every package (${[...versions].join(', ')})`);
  const version = packages[0].pkg.version;
  run('pnpm', ['-r', '--filter', './packages/*', 'pack', '--pack-destination', packDir]);
  const tarballs = new Map();
  for (const file of readdirSync(packDir).filter((f) => f.endsWith('.tgz'))) {
    const out = join(tmp, 'extract', file.replace(/\.tgz$/, ''));
    mkdirSync(out, { recursive: true });
    run('tar', ['-xzf', join(packDir, file), '-C', out]);
    const manifest = readJson(join(out, 'package', 'package.json'));
    tarballs.set(manifest.name, { file, path: join(packDir, file), root: join(out, 'package'), manifest });
  }
  check(tarballs.size === packages.length && [...names].every((n) => tarballs.has(n)), `one tarball per package (${tarballs.size})`);

  // ---------------------------------------------------------------- tarball contents

  const sizes = [];
  for (const { dir, pkg } of packages) {
    const t = tarballs.get(pkg.name);
    if (!t) continue;
    section(`${pkg.name}@${pkg.version} (${t.file})`);
    const files = walk(t.root);
    const has = new Set(files);
    const m = t.manifest;

    for (const f of META_FILES) check(has.has(f), `ships ${f}`);
    const allowed = [...META_FILES, ...(m.files ?? [])];
    const stray = files.filter((f) => !allowed.some((a) => f === a || f.startsWith(`${a}/`)));
    check(stray.length === 0, `only allowlisted files${stray.length ? `: ${stray.join(', ')}` : ''}`);
    for (const [re, what] of FORBIDDEN) {
      const hits = files.filter((f) => re.test(f));
      check(hits.length === 0, `no ${what}${hits.length ? `: ${hits.slice(0, 5).join(', ')}` : ''}`);
    }

    // Every source the build includes is in dist: TypeScript compiled (.js + .d.ts), anything else copied verbatim.
    const build = readJson(join(dir, 'tsconfig.build.json'));
    const missing = [];
    for (const inc of build.include) {
      for (const src of walk(join(dir, inc))) {
        const expect = src.endsWith('.ts') ? [src.replace(/\.ts$/, '.js'), src.replace(/\.ts$/, '.d.ts')] : [src];
        for (const e of expect) if (!has.has(`dist/${inc}/${e}`)) missing.push(`dist/${inc}/${e}`);
      }
    }
    check(missing.length === 0, `every source in ${build.include.join(', ')} built or copied into dist${missing.length ? `; missing ${missing.join(', ')}` : ''}`);

    const ranges = Object.entries({ ...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies, ...m.devDependencies });
    const workspaceRanges = ranges.filter(([, r]) => String(r).startsWith('workspace:'));
    check(workspaceRanges.length === 0, `no workspace: ranges${workspaceRanges.length ? `: ${workspaceRanges.map(([n]) => n).join(', ')}` : ''}`);
    const internal = Object.entries(m.dependencies ?? {}).filter(([n]) => names.has(n));
    const unpinned = internal.filter(([, r]) => r !== version);
    check(unpinned.length === 0, `internal dependencies pinned to ${version}${internal.length ? ` (${internal.map(([n]) => n).join(', ')})` : ''}${unpinned.length ? `; got ${unpinned.map(([n, r]) => `${n}@${r}`).join(', ')}` : ''}`);

    const targets = [];
    for (const [key, entry] of Object.entries(m.exports ?? {})) {
      if (typeof entry !== 'object' || !entry.types || !entry.default) fail(`export ${key} has types and default conditions`);
      else targets.push([`export ${key} types`, entry.types], [`export ${key}`, entry.default]);
    }
    check(targets.length > 0, `${Object.keys(m.exports ?? {}).length} exports point into dist`);
    for (const [bin, path] of Object.entries(m.bin ?? {})) targets.push([`bin ${bin}`, path]);
    for (const [what, path] of targets) {
      const rel = path.replace(/^\.\//, '');
      if (!rel.startsWith('dist/') || !has.has(rel)) fail(`${what} → ${path} is in the tarball`);
    }
    for (const [bin, path] of Object.entries(m.bin ?? {})) {
      const head = has.has(path.replace(/^\.\//, '')) ? readFileSync(join(t.root, path), 'utf8').split('\n', 1)[0] : '';
      check(head === '#!/usr/bin/env node', `bin ${bin} → ${path} with a node shebang`);
    }
    check(typeof m.engines?.node === 'string', `engines.node ${m.engines?.node}`);
    check(typeof m.sideEffects === 'boolean' || Array.isArray(m.sideEffects), `sideEffects ${JSON.stringify(m.sideEffects)}`);
    check(m.license === LICENSE, `license ${m.license}`);
    check(m.publishConfig?.access === 'public', 'publishConfig.access public');
    check(m.repository?.url === REPOSITORY, `repository.url ${m.repository?.url} (trusted publishing matches it exactly)`);

    const leaks = [];
    for (const f of files) {
      const text = readFileSync(join(t.root, f), 'utf8');
      if (text.includes(ROOT) || text.includes(homedir())) leaks.push(f);
    }
    check(leaks.length === 0, `no checkout or home paths${leaks.length ? `: ${leaks.join(', ')}` : ''}`);

    const bytes = statSync(t.path).size;
    const unpacked = files.reduce((s, f) => s + statSync(join(t.root, f)).size, 0);
    check(bytes <= MAX_TARBALL_BYTES, `tarball ${kb(bytes)} ≤ ${kb(MAX_TARBALL_BYTES)} (unpacked ${kb(unpacked)}, ${files.length} files)`);
    sizes.push({ name: pkg.name, bytes, unpacked, files: files.length });
  }

  // ---------------------------------------------------------------- consumer project

  section('installing the tarballs into a fresh project');
  const consumer = join(tmp, 'consumer');
  mkdirSync(consumer);
  const fromTarball = Object.fromEntries([...tarballs].map(([name, t]) => [name, `file:${t.path}`]));
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'playerthree-verify-consumer',
    private: true,
    type: 'module',
    dependencies: fromTarball,
    devDependencies: { typescript: rootPkg.devDependencies.typescript, '@types/node': rootPkg.devDependencies['@types/node'] },
    // The tarballs depend on each other by version; those versions are not on the registry yet.
    pnpm: { overrides: fromTarball },
  }, null, 2)}\n`);
  run('pnpm', ['install', '--ignore-workspace', '--no-frozen-lockfile', '--prefer-offline', '--reporter=append-only'], { cwd: consumer, timeoutMs: 900_000 });
  pass(`pnpm install of ${tarballs.size} tarballs (isolated node_modules)`);

  section('importing every public export (node -e)');
  const specifiers = packages.flatMap(({ pkg }) => Object.keys(tarballs.get(pkg.name)?.manifest.exports ?? {}).map((k) => (k === '.' ? pkg.name : `${pkg.name}${k.slice(1)}`)));
  const probe = `
    const out = {};
    for (const s of ${JSON.stringify(specifiers)}) {
      try { out[s] = { ok: true, exports: Object.keys(await import(s)).length }; }
      catch (e) { out[s] = { ok: false, error: String(e?.stack ?? e).split('\\n').slice(0, 3).join(' | ') }; }
    }
    process.stdout.write(JSON.stringify(out));`;
  const imported = JSON.parse(run(process.execPath, ['--input-type=module', '-e', probe], { cwd: consumer }));
  for (const s of specifiers) check(imported[s]?.ok, `import '${s}'${imported[s]?.ok ? ` (${imported[s].exports} exports)` : `: ${imported[s]?.error}`}`);

  section('running every bin with --help');
  for (const { pkg } of packages) {
    for (const bin of Object.keys(tarballs.get(pkg.name)?.manifest.bin ?? {})) {
      const r = spawnSync(join(consumer, 'node_modules', '.bin', bin), ['--help'], { cwd: consumer, encoding: 'utf8', timeout: 60_000 });
      const output = `${r.stdout}${r.stderr}`;
      check(r.status === 0 && output.includes(bin), `${bin} --help${r.status === 0 ? '' : ` exited ${r.status ?? r.signal}: ${output.slice(0, 400)}`}`);
    }
  }

  section('typechecking a consumer against the installed types');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const tug = /A whole agent-playable game[^\n]*\n+```ts\n([\s\S]*?)\n```/.exec(readme)?.[1];
  check(tug !== undefined && tug.includes('server.listen(8787);'), "README's Tug of War example found");
  if (tug) writeFileSync(join(consumer, 'tug.ts'), `${tug.replace('server.listen(8787);', "server.listen(Number(process.env.PORT), '127.0.0.1');")}\n`);
  writeFileSync(join(consumer, 'consumer.ts'), [
    ...specifiers.map((s, i) => `import * as m${i} from '${s}';`),
    `export const modules = [${specifiers.map((_, i) => `m${i}`).join(', ')}] as const;`,
    '',
  ].join('\n'));
  writeFileSync(join(consumer, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'es2024', module: 'nodenext', moduleResolution: 'nodenext', lib: ['es2024', 'dom'], types: ['node'],
      strict: true, noEmit: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true, skipLibCheck: false,
    },
    include: ['*.ts'],
  }, null, 2)}\n`);
  // skipLibCheck is off so our .d.ts files are checked in full; errors inside third-party declarations (for example
  // @colyseus/core referencing express types it does not depend on) are reported but are not ours to fail on.
  const tsc = spawnSync(join(consumer, 'node_modules', '.bin', 'tsc'), ['-p', '.'], { cwd: consumer, encoding: 'utf8', timeout: 300_000 });
  const diagnostics = `${tsc.stdout}${tsc.stderr}`.split('\n').filter((l) => /\): error TS\d+:/.test(l));
  const owner = (line) => {
    const file = line.slice(0, line.indexOf('('));
    const at = file.lastIndexOf('node_modules/');
    if (at === -1) return undefined;
    const [first, second] = file.slice(at + 'node_modules/'.length).split('/');
    return first.startsWith('@') ? `${first}/${second}` : first;
  };
  const ours = diagnostics.filter((l) => owner(l) === undefined || names.has(owner(l)));
  const foreign = diagnostics.filter((l) => !ours.includes(l));
  if (foreign.length) console.log(`  note ${foreign.length} errors inside third-party declarations (${[...new Set(foreign.map(owner))].join(', ')}), not ours`);
  check(tsc.status !== null && ours.length === 0 && (tsc.status === 0 || diagnostics.length > 0),
    `tsc (skipLibCheck false): consumer.ts imports all ${specifiers.length} entry points, tug.ts is the README example${ours.length ? `\n${ours.join('\n')}` : ''}${tsc.status !== 0 && diagnostics.length === 0 ? `\n${tsc.stdout}${tsc.stderr}` : ''}`);

  section("serving the README's Tug of War example");
  if (tug) {
    const port = await freePort();
    const child = spawn(process.execPath, ['tug.ts'], { cwd: consumer, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? signal)));
    const base = `http://127.0.0.1:${port}`;
    let devtools;
    for (let i = 0; i < 100 && devtools === undefined && child.exitCode === null; i++) {
      devtools = await fetch(`${base}/playerthree/devtools`).catch(() => undefined);
      if (devtools === undefined) await new Promise((r) => setTimeout(r, 200));
    }
    check(devtools?.status === 200 && (await devtools.text()).includes('<html'), `GET /playerthree/devtools → ${devtools?.status} HTML (the devtools assets shipped)`);
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'verify-pack', version: '0' } } }),
    }).catch((e) => ({ status: String(e), headers: new Headers() }));
    check(mcp.status === 401 && /^Bearer /.test(mcp.headers.get('www-authenticate') ?? ''), `POST /mcp initialize without a credential → ${mcp.status} Bearer challenge (the MCP endpoint is mounted)`);
    check(child.exitCode === null, `the example keeps serving${child.exitCode === null ? '' : ` (exited ${child.exitCode}):\n${log}`}`);
    child.kill('SIGTERM');
    await exited;
  }

  section('sidecar conformance from the installed @playerthree/sidecar');
  const conformance = join(consumer, 'node_modules', '@playerthree', 'sidecar', 'dist', 'conformance');
  const runner = join(conformance, 'run.js');
  const engine = join(conformance, 'mock-engine.mjs');
  for (const [mode, args] of [
    ['stdio (the engine spawns the runner)', [engine, '--', process.execPath, runner, '--stdio']],
    ['socket (the runner spawns the engine)', [runner, '--socket', '--', process.execPath, engine]],
  ]) {
    const r = await runAsync(process.execPath, args, { cwd: consumer, timeoutMs: 180_000 });
    const ok = r.code === 0 && r.output.includes('conformance: PASS');
    check(ok, `conformance over ${mode}${ok ? '' : ` exited ${r.code}:\n${r.output.slice(-4000)}`}`);
  }

  section('tarballs');
  console.log(`  ${'package'.padEnd(24)} ${'tarball'.padStart(10)} ${'unpacked'.padStart(10)} ${'files'.padStart(6)}`);
  for (const s of sizes) console.log(`  ${s.name.padEnd(24)} ${kb(s.bytes).padStart(10)} ${kb(s.unpacked).padStart(10)} ${String(s.files).padStart(6)}`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  if (opts.keep) console.log(`\nkept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nverify-pack: PASS' : `\nverify-pack: FAIL (${failures.length})`);
process.exitCode = failures.length === 0 ? 0 : 1;
