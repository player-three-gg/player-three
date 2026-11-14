/**
 * `playerthree policy export|import` (spec §13.1, §17): move one commander library version out of, or into, a JSON
 * commander store directory (`jsonCommanderStore`, e.g. a local dev host's) as a `playerthree.policy/1` package, through
 * a host built over that store and its own `exportPolicy` / `importPolicy`. Never run while another process serves the
 * store: both would write its files.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalJson, type PolicyImportResult, type PolicyPackage } from 'playerthree';
import { createPlayerThreeHost, jsonCommanderStore, PlayerThreeError, type PlayerThreeHost } from 'playerthree/host';
import { loadDefinition } from './load.ts';
import type { Io } from './main.ts';
import { UsageError } from './usage.ts';

const STORE_OPTIONS = {
  store: { type: 'string' },
  owner: { type: 'string' },
  commander: { type: 'string' },
  export: { type: 'string' },
} as const;

function required(flag: string, v: string | undefined): string {
  if (v === undefined || v.length === 0) throw new UsageError(`${flag} is required`);
  return v;
}

/** Run `fn` on a host over the store directory; its writes are flushed before the host goes away. */
async function withStoreHost<T>(modulePath: string, exportName: string | undefined, store: string, fn: (host: PlayerThreeHost) => Promise<T>, failure: string): Promise<T> {
  const definition = await loadDefinition(modulePath, exportName);
  const host = createPlayerThreeHost({ definition, commanderStore: jsonCommanderStore(resolve(store)) }) as unknown as PlayerThreeHost;
  try {
    await host.ready;
    return await fn(host);
  } catch (e) {
    // Registry errors are closed codes without detail; say which inputs they can be about.
    if (e instanceof PlayerThreeError) throw new Error(`${e.code}: ${failure}`);
    throw e;
  } finally {
    await host.commanders.flush();
    host.dispose();
  }
}

export async function policyExportCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...STORE_OPTIONS, version: { type: 'string' }, license: { type: 'string' }, author: { type: 'string' }, out: { type: 'string' } },
  });
  const [modulePath, ...extra] = positionals;
  if (!modulePath || extra.length) throw new UsageError('usage: playerthree policy export <module> --store <dir> --owner <owner> --commander <id> [--version N] [--license <spdx>] [--author <name>] [--out policy.json]');
  const store = required('--store', values.store);
  const owner = required('--owner', values.owner);
  const commander = required('--commander', values.commander);
  let version: number | undefined;
  if (values.version !== undefined) {
    version = Number(values.version);
    if (!/^\d+$/.test(values.version) || !Number.isSafeInteger(version) || version < 1) throw new UsageError('--version must be a positive integer');
  }
  const pkg = await withStoreHost(modulePath, values.export, store, async (host) => {
    // Default: the active version of the commander's first role that has one (spec §13.1 seat default).
    const status = host.commanders.roster(owner).find((c) => c.id === commander);
    const chosen = version ?? status?.roles.map((role) => status.policy.activeByRole[role]).find((v) => typeof v === 'number');
    if (chosen === undefined || chosen === null) throw new PlayerThreeError('invalid');
    return host.commanders.exportPolicy(owner, commander, chosen, {
      ...(values.license === undefined ? {} : { license: values.license }),
      ...(values.author === undefined ? {} : { author: values.author }),
    });
  }, 'unknown owner, commander or version (or no active version), or a --license/--author the package format rejects');
  const text = canonicalJson(pkg);
  if (values.out === undefined) {
    io.out(text);
  } else {
    await writeFile(resolve(values.out), text);
    io.out(`wrote ${values.out}: v${pkg.lineage.version} ${pkg.roles.join(', ')} ${pkg.runtime}, ${Buffer.byteLength(text, 'utf8')} bytes, hash ${pkg.hash}`);
  }
  return 0;
}

export async function policyImportCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: STORE_OPTIONS });
  const [modulePath, packagePath, ...extra] = positionals;
  if (!modulePath || !packagePath || extra.length) throw new UsageError('usage: playerthree policy import <module> <package.json> --store <dir> --owner <owner> --commander <id>');
  const store = required('--store', values.store);
  const owner = required('--owner', values.owner);
  const commander = required('--commander', values.commander);
  let pkg: unknown;
  try {
    pkg = JSON.parse(await readFile(resolve(packagePath), 'utf8')) as unknown;
  } catch (e) {
    throw new Error(`${packagePath} is not a readable JSON file${e instanceof SyntaxError ? '' : `: ${e instanceof Error ? e.message : String(e)}`}`);
  }
  const result: PolicyImportResult = await withStoreHost(modulePath, values.export, store, (host) => host.commanders.importPolicy(owner, commander, pkg as PolicyPackage),
    'unknown owner or commander, or the package failed verification (format, hash, game, role, runtime, script hash or rebuild)');
  io.out(`imported as v${result.version} (inactive${result.stale ? '; stale: made for another host surface, redeploy its source to use it' : ''}); activate it with a rollback to v${result.version}`);
  return 0;
}
