/**
 * Policy bundling (spec §11 `modules`): JavaScript/TypeScript ES modules → one classic script that satisfies the JS
 * policy ABI unchanged (global `think`, optional `init` and `detail`, no module syntax).
 *
 * esbuild (pinned version) runs with one internal virtual-filesystem plugin and nothing else: every specifier is
 * resolved here, against the caller's `load` and the served skills' `.js` files, so a build never touches the real
 * filesystem, the network or any package resolution. Equal inputs yield an equal script.
 */
import { posix } from 'node:path';
import { Script } from 'node:vm';
import * as esbuild from 'esbuild';
import { POLICY_MAX_MODULES, POLICY_MODULE_PATH_MAX, POLICY_MODULE_PATH_PATTERN, POLICY_MODULES_MAX_BYTES, type SkillDef } from '../manifest.ts';

/** ECMAScript level esbuild emits: the sandbox engine's (Bellard QuickJS 2025-09-13); newer syntax is lowered or rejected. */
export const POLICY_ES_TARGET = 'es2025';
/** Longest build error message, in UTF-16 code units. */
const BUILD_MESSAGE_MAX = 1024;
/** Global the bundle's IIFE assigns its exports to; the script then binds the ABI globals from it. */
const BUNDLE_GLOBAL = '__playerthree_policy';
/** ABI globals a bundle may provide, in binding order (`createPolicy`: the trusted runner's factory, spec §11). */
const ABI_EXPORTS = ['think', 'init', 'detail', 'createPolicy'] as const;
/**
 * Fixed virtual root: module paths become `${ROOT}/<path>` in esbuild's `file` namespace, so its module comments and
 * error locations print the root-relative path (`// lib/x.ts`). Nothing is ever read from this directory: the plugin
 * loads every file and `tsconfigRaw` replaces tsconfig lookup.
 */
const ROOT = '/playerthree-policy';
const MODULE_PATH = new RegExp(POLICY_MODULE_PATH_PATTERN);
const TS_PATH = /\.m?ts$/;

export interface PolicyBuildInput {
  /** Root-relative path of the entry module. */
  entry: string;
  /** Module source by root-relative path; `undefined` = no such module. */
  load(path: string): string | undefined;
  /** Served skills: their `.js` files are importable at `<skill>/<path>` (first segment = skill name). */
  skills?: readonly SkillDef[];
}

export interface PolicyBuildLocation {
  /** Module path (or `<skill>/<path>`). */
  file: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
}

export type PolicyBuildResult = { ok: true; code: string } | { ok: false; message: string; location: PolicyBuildLocation };

/** A module path per spec §11: file-key grammar, ≤ POLICY_MODULE_PATH_MAX, `.js`/`.mjs`/`.ts`/`.mts`. */
export function isModulePath(path: string): boolean {
  return path.length <= POLICY_MODULE_PATH_MAX && MODULE_PATH.test(path);
}

/**
 * Untrusted `modules` map and `entry` → validated sources by path, or `undefined` when they break spec §11: a plain
 * object of 1..POLICY_MAX_MODULES string sources totalling ≤ POLICY_MODULES_MAX_BYTES UTF-8 bytes, module paths whose
 * first segment names no served skill, and an `entry` among them. Each value is read once.
 */
export function parseModules(modules: unknown, entry: unknown, skills: readonly SkillDef[]): Map<string, string> | undefined {
  if (modules === null || typeof modules !== 'object' || Array.isArray(modules)) return undefined;
  const proto = Object.getPrototypeOf(modules);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const keys = Object.keys(modules);
  if (keys.length === 0 || keys.length > POLICY_MAX_MODULES) return undefined;
  const skillNames = new Set(skills.map((s) => s.name));
  const out = new Map<string, string>();
  let bytes = 0;
  for (const key of keys) {
    if (!isModulePath(key) || skillNames.has(key.slice(0, key.indexOf('/')))) return undefined;
    const source = (modules as Record<string, unknown>)[key];
    if (typeof source !== 'string') return undefined;
    bytes += Buffer.byteLength(source, 'utf8');
    if (bytes > POLICY_MODULES_MAX_BYTES) return undefined;
    out.set(key, source);
  }
  if (typeof entry !== 'string' || !out.has(entry)) return undefined;
  return out;
}

/** Cut to BUILD_MESSAGE_MAX code units without leaving a lone high surrogate. */
function capMessage(text: string): string {
  if (text.length <= BUILD_MESSAGE_MAX) return text;
  const cut = text.slice(0, BUILD_MESSAGE_MAX);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Bundle `entry` and its static relative imports into one classic script (spec §11): TypeScript types stripped
 * without type checking (TypeScript semantics: a `.ts` import used only as a type, or not at all, is elided before
 * resolution), the entry's `think` (required), `init`, `detail` and `createPolicy` exports bound to global `var`s. Bare,
 * absolute and URL specifiers, `require`, dynamic `import()`, import attributes, paths escaping the root, specifiers
 * without their file extension and unknown files are build errors; so is any module syntax left in the output.
 * Failures carry esbuild's first error (≤ 1024 code units) and its location (the entry's start when it has none).
 */
export async function buildPolicy(input: PolicyBuildInput): Promise<PolicyBuildResult> {
  const { entry } = input;
  const atEntry: PolicyBuildLocation = { file: entry, line: 1, column: 0 };
  const skills = new Map((input.skills ?? []).map((s) => [s.name, s]));
  const sources = new Map<string, string | undefined>();
  /** Source of a root-relative path: a served skill `.js` file when its first segment names a skill, else a module. */
  const read = (path: string): string | undefined => {
    if (sources.has(path)) return sources.get(path);
    let source: string | undefined;
    const slash = path.indexOf('/');
    const skill = slash > 0 ? skills.get(path.slice(0, slash)) : undefined;
    if (skill) {
      const file = path.slice(slash + 1);
      source = file.endsWith('.js') && Object.hasOwn(skill.files, file) ? skill.files[file] : undefined;
    } else if (isModulePath(path)) {
      source = input.load(path);
    }
    sources.set(path, source);
    return source;
  };
  const failed = (message: string, location: PolicyBuildLocation): PolicyBuildResult => ({ ok: false, message: capMessage(message), location });
  if (!isModulePath(entry) || skills.has(entry.slice(0, entry.indexOf('/'))) || read(entry) === undefined) {
    return failed(`entry ${JSON.stringify(entry)} is not a provided module (.js, .mjs, .ts or .mts)`, atEntry);
  }

  const plugin: esbuild.Plugin = {
    name: 'playerthree-policy-modules',
    setup(build) {
      const error = (text: string): esbuild.OnResolveResult => ({ errors: [{ text }] });
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return { path: `${ROOT}/${entry}`, namespace: 'file' };
        if (args.kind === 'dynamic-import') return error('dynamic import() is not supported; use a static import');
        if (args.kind === 'require-call' || args.kind === 'require-resolve') return error('require is not supported; use a static import');
        if (args.kind !== 'import-statement') return error(`${args.kind} imports are not supported`);
        if (Object.keys(args.with).length > 0) return error('import attributes are not supported');
        const specifier = args.path;
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          return error(`${JSON.stringify(specifier)} is not a relative import: bare, absolute and URL specifiers are not supported (use ./ or ../)`);
        }
        const target = posix.normalize(posix.join(posix.dirname(args.importer.slice(ROOT.length + 1)), specifier));
        if (target === '..' || target.startsWith('../')) return error(`${JSON.stringify(specifier)} escapes the policy root`);
        if (!/\.(js|mjs|ts|mts)$/.test(target)) return error(`${JSON.stringify(specifier)} must carry its file extension (.js, .mjs, .ts or .mts)`);
        if (read(target) === undefined) return error(`could not resolve ${JSON.stringify(specifier)}: no such module or served skill .js file`);
        return { path: `${ROOT}/${target}`, namespace: 'file' };
      });
      build.onLoad({ filter: /.*/, namespace: 'file' }, (args) => {
        const path = args.path.slice(ROOT.length + 1);
        return { contents: read(path)!, loader: TS_PATH.test(path) ? 'ts' : 'js' };
      });
    },
  };

  const options = {
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'neutral',
    target: POLICY_ES_TARGET,
    // A classic script cannot hold a top-level await; reject it with the module's own location.
    supported: { 'top-level-await': false },
    charset: 'utf8',
    sourcemap: false,
    minify: false,
    logLevel: 'silent',
    // Non-literal import()/require() are left unbundled by default (a warning): here they are build errors.
    logOverride: { 'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error' },
    absWorkingDir: ROOT,
    tsconfigRaw: {},
    plugins: [plugin],
  } satisfies esbuild.BuildOptions;
  const buildFailed = (e: unknown): PolicyBuildResult => {
    const first = (e as Partial<esbuild.BuildFailure>).errors?.[0];
    if (!first) throw e;
    const at = first.location;
    return failed(first.text, at ? { file: at.file, line: at.line, column: at.column } : atEntry);
  };

  // Pass 1 (ESM): the names the entry exports; esbuild's metafile lists them for ESM output only.
  let exported: string[];
  try {
    const result = await esbuild.build({ ...options, format: 'esm', metafile: true });
    exported = Object.values(result.metafile.outputs)[0]?.exports ?? [];
  } catch (e) {
    return buildFailed(e);
  }
  if (!exported.includes('think')) return failed(`${entry} must export think`, atEntry);

  // Pass 2 (IIFE): the same module graph as one classic script, keeping esbuild's `// <path>` module comments.
  let bundle: string;
  try {
    bundle = (await esbuild.build({ ...options, format: 'iife', globalName: BUNDLE_GLOBAL })).outputFiles[0]!.text;
  } catch (e) {
    return buildFailed(e);
  }
  const binds = ABI_EXPORTS.filter((name) => exported.includes(name)).map((name) => `var ${name} = ${BUNDLE_GLOBAL}.${name};\n`);
  const code = `${bundle}${binds.join('')}`;
  try {
    // Parse-only (never run): the output must be a classic script, without import/export left in it.
    new Script(code, { filename: 'policy.js' });
  } catch (e) {
    if (e instanceof SyntaxError) return failed(`the bundle is not a classic script: ${e.message}`, atEntry);
    throw e;
  }
  return { ok: true, code };
}
