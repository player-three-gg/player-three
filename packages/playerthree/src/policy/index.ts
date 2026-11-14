/**
 * Policy sandbox: loads agent-written policies (`js` source run in QuickJS-in-WASM, or a core `wasm` module) into an
 * isolated worker thread per instance, and host-registered first-party packages into V8 in the host's own thread
 * (`loadTrustedPolicy`, trusted.ts). See docs/POLICY_ABI.md.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PolicyError, PolicyErrorCode } from '../control.ts';
import type { PolicyPackage } from '../policy-package.ts';
import { MATCH_DATA_MAX_BYTES, type PolicyLimits } from '../manifest.ts';
import { DETAIL_ERROR, parseDetail, spawnPolicy } from './sandbox.ts';
import { MAX_MESSAGE_BYTES, truncateUtf8 } from './text.ts';
import { instantiateTrusted } from './trusted.ts';
import type { LoadOptions, LoadPolicy, LoadResult, PolicyDetail, TrustedLoadOptions, TrustedLoadResult } from './types.ts';
import { formatSignature, funcTypeOf, parseWasm, sameSignature, type ValType, type WasmInfo } from './wasm-binary.ts';

export type * from './types.ts';
export {
  buildPolicy,
  isModulePath,
  POLICY_ES_TARGET,
  type PolicyBuildInput,
  type PolicyBuildLocation,
  type PolicyBuildResult,
} from './build.ts';
export { DETERMINISTIC_MATH_FUNCTIONS, DETERMINISTIC_MATH_SOURCE, DETERMINISTIC_MATH_VERSION } from './math.ts';
export { POLICY_JS_ENGINE, POLICY_RUNTIME } from './runtime.ts';
export { guardedEach, TRUSTED_HANG_MS } from './trusted.ts';
export {
  buildStarter,
  knobLines,
  parseStarterRef,
  starterCatalog,
  starterModule,
  STARTER_ENTRY,
  type Starter,
  type StarterCatalog,
} from './starters.ts';

const WASM_PAGE = 65536;
/** Custom section a wasm policy declares its observation detail in (UTF-8 JSON, POLICY_ABI.md). */
export const WASM_DETAIL_SECTION = 'playerthree.detail';
/** Total table entries a wasm policy may declare (tables are allocated on the worker's V8 heap). */
export const MAX_TABLE_ENTRIES = 65536;

function fail(code: PolicyErrorCode, message?: string): { ok: false; error: PolicyError } {
  const error: PolicyError = { code };
  if (message !== undefined) error.message = truncateUtf8(message, MAX_MESSAGE_BYTES);
  return { ok: false, error };
}

/**
 * Loads one policy instance in its own sandbox worker: checks the runtime is allowed and `matchData` is JSON within
 * `MATCH_DATA_MAX_BYTES`, then compiles (`js`: QuickJS source; `wasm`: module bytes, ABI-checked). Never throws for a
 * bad artifact: the result carries a closed error code.
 */
export const loadPolicy: LoadPolicy = async (runtime, code, limits, opts) => {
  const seed = opts?.seed ?? 0;
  if (!Number.isFinite(seed)) throw new RangeError('policy seed must be a finite number');
  if (!limits.runtimes.includes(runtime)) return fail('runtime_not_allowed');
  const matchDataJson = matchDataText(opts);
  if (typeof matchDataJson !== 'string') return matchDataJson;
  return runtime === 'js' ? loadJs(code, limits, seed, matchDataJson) : loadWasm(code, limits, seed, matchDataJson);
};

/**
 * One seat's instance of a policy package in V8 (spec §11 *Trusted runner*): the package's realm, shared by every seat
 * using that package (`pkg.hash`) for the life of the process, runs its composed `script` once; the seat gets its own
 * instance from the script's global `createPolicy(options)` (`opts.options`, the seat's bot options, or `null`), its
 * own seeded `Math.random` stream and its own `log`, with the sandbox's determinism and output checks. Calls are
 * synchronous, take the observation object as it is, and have no CPU budget: one wall-clock hang guard
 * (`TRUSTED_HANG_MS`) bounds each call, or each batch run by `guardedEach`.
 * Only `js` packages qualify.
 *
 * Host-registered first-party packages only (operator code, e.g. `GameDefinition.botPackages`), never uploads:
 * `node:vm` is not a security boundary, so nothing from `policy_deploy`, `policy_import`, `practice_run`, the pool or
 * any other seat or owner input may reach this function. `pkg` must already be validated (`validatePolicyPackage`);
 * its `surfaceHash` is the caller's check.
 */
export function loadTrustedPolicy(pkg: PolicyPackage, limits: PolicyLimits, opts?: TrustedLoadOptions): TrustedLoadResult {
  const seed = opts?.seed ?? 0;
  if (!Number.isFinite(seed)) throw new RangeError('policy seed must be a finite number');
  if (pkg.runtime !== 'js' || !limits.runtimes.includes('js')) return fail('runtime_not_allowed');
  const matchDataJson = matchDataText(opts);
  if (typeof matchDataJson !== 'string') return matchDataJson;
  const bytes = Buffer.byteLength(pkg.script, 'utf8');
  if (bytes > limits.maxArtifactBytes) return fail('too_large', `artifact is ${bytes} bytes; the limit is ${limits.maxArtifactBytes}`);
  // Host-validated bot options (finite numbers and booleans): their JSON is parsed in the realm per seat.
  return instantiateTrusted(pkg.hash, pkg.script, limits, seed, matchDataJson, JSON.stringify(opts?.options ?? null));
}

/** The bounded JSON text of `opts.matchData` (`null` when absent), or the load failure it causes. */
function matchDataText(opts: LoadOptions | undefined): string | { ok: false; error: PolicyError } {
  let matchDataJson: string;
  try {
    const json = JSON.stringify(opts?.matchData === undefined ? null : opts.matchData, (_key, value: unknown) => {
      if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ||
        (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('invalid match data');
      return value;
    });
    if (json === undefined) return fail('bad_output', 'match data must be JSON-compatible');
    matchDataJson = json;
  } catch {
    return fail('bad_output', 'match data must be JSON-compatible');
  }
  if (Buffer.byteLength(matchDataJson, 'utf8') > MATCH_DATA_MAX_BYTES) return fail('too_large', 'match data exceeds its 128 KiB limit');
  return matchDataJson;
}

async function loadJs(code: string | Uint8Array, limits: PolicyLimits, seed: number, matchDataJson: string): Promise<LoadResult> {
  const bytes = typeof code === 'string' ? Buffer.byteLength(code, 'utf8') : code.byteLength;
  if (bytes > limits.maxArtifactBytes) return fail('too_large', `artifact is ${bytes} bytes; the limit is ${limits.maxArtifactBytes}`);
  let source: string;
  try {
    source = typeof code === 'string' ? code : new TextDecoder('utf-8', { fatal: true }).decode(code);
  } catch {
    return fail('compile', 'source is not valid UTF-8');
  }
  const e = await quickjsEngine();
  const maximum = Math.min(e.maxPages, Math.max(e.minPages, Math.ceil((e.heapBase + limits.memoryBytes) / WASM_PAGE)));
  return spawnPolicy({ runtime: 'js', limits, seed, matchDataJson, module: e.module, source, enginePages: { initial: e.minPages, maximum } });
}

async function loadWasm(code: string | Uint8Array, limits: PolicyLimits, seed: number, matchDataJson: string): Promise<LoadResult> {
  if (typeof code === 'string') return fail('bad_module', 'a wasm artifact must be the module bytes');
  if (code.byteLength > limits.maxArtifactBytes) return fail('too_large', `artifact is ${code.byteLength} bytes; the limit is ${limits.maxArtifactBytes}`);
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(code as Uint8Array<ArrayBuffer>);
  } catch (e) {
    return fail('bad_module', e instanceof Error ? e.message : 'invalid module');
  }
  let info: WasmInfo;
  try {
    info = parseWasm(code);
  } catch (e) {
    return fail('bad_module', e instanceof Error ? e.message : 'invalid module');
  }
  const abiError = checkWasmAbi(info, limits);
  if (abiError) return { ok: false, error: abiError };
  // The declared observation detail is static data, read before any module code runs.
  const sections = WebAssembly.Module.customSections(module, WASM_DETAIL_SECTION);
  if (sections.length > 1) return fail('bad_output', `at most one ${WASM_DETAIL_SECTION} custom section`);
  if (sections.length === 0) return spawnPolicy({ runtime: 'wasm', limits, seed, matchDataJson, module });
  let detail: PolicyDetail | null;
  try {
    detail = parseDetail(new TextDecoder('utf-8', { fatal: true }).decode(sections[0]));
  } catch {
    detail = null;
  }
  if (detail === null) return fail('bad_output', DETAIL_ERROR);
  return spawnPolicy({ runtime: 'wasm', limits, seed, matchDataJson, module, detail });
}

const LOG_SIG: [readonly ValType[], readonly ValType[]] = [['i32', 'i32'], []];
const REQUIRED_EXPORTS: readonly { name: string; sig: [readonly ValType[], readonly ValType[]]; optional?: boolean }[] = [
  { name: 'alloc', sig: [['i32'], ['i32']] },
  { name: 'think', sig: [['i32', 'i32'], ['i64']] },
  { name: 'init', sig: [['i32', 'i32'], []], optional: true },
];

/** Enforces the policy ABI: imports, memory bounds and export signatures. */
export function checkWasmAbi(info: WasmInfo, limits: PolicyLimits): PolicyError | null {
  const err = (code: PolicyErrorCode, message: string): PolicyError => ({ code, message: truncateUtf8(message, MAX_MESSAGE_BYTES) });
  for (const imp of info.imports) {
    const where = `import "${imp.module}"."${imp.name}" (${imp.kind})`;
    if (imp.module !== 'env' || imp.name !== 'log' || imp.kind !== 'func') {
      return err('imports_not_allowed', `${where} is not allowed; the only permitted import is env.log ${formatSignature(...LOG_SIG)}`);
    }
    const t = info.types[imp.typeIndex!] ?? null;
    if (!sameSignature(t, ...LOG_SIG)) return err('imports_not_allowed', `env.log must have type ${formatSignature(...LOG_SIG)}`);
  }

  // Linear memory lives outside the worker's V8 heap, so its bound comes from the module itself: the declared
  // maxima of all memories together must fit the budget.
  const maxPages = Math.floor(limits.memoryBytes / WASM_PAGE);
  if (info.memories.length === 0) return err('missing_export', 'module must define and export its memory');
  let totalPages = 0;
  for (const [i, m] of info.memories.entries()) {
    if (m.is64) return err('bad_module', `memory ${i}: 64-bit memories are not supported`);
    if (m.customPageSize) return err('bad_module', `memory ${i}: custom page sizes are not supported`);
    if (m.shared) return err('bad_module', `memory ${i}: shared memories are not supported`);
    if (m.max === undefined) return err('memory_limit', `memory ${i} must declare a maximum of at most ${maxPages} pages`);
    if (m.max > maxPages) return err('memory_limit', `memory ${i} declares a maximum of ${m.max} pages; the limit is ${maxPages} pages`);
    totalPages += m.max;
  }
  if (totalPages > maxPages) return err('memory_limit', `memories declare ${totalPages} pages in total; the limit is ${maxPages} pages`);

  // Tables and GC objects live on the V8 heap, where one oversized allocation is fatal to the whole process rather
  // than to the worker. Tables must therefore be statically bounded, and GC struct/array types are not accepted.
  let totalEntries = 0;
  for (const [i, t] of info.tables.entries()) {
    if (t.is64) return err('bad_module', `table ${i}: 64-bit tables are not supported`);
    if (t.max === undefined) return err('memory_limit', `table ${i} must declare a maximum (at most ${MAX_TABLE_ENTRIES} entries)`);
    totalEntries += t.max;
  }
  if (totalEntries > MAX_TABLE_ENTRIES) {
    return err('memory_limit', `tables declare ${totalEntries} entries in total; the limit is ${MAX_TABLE_ENTRIES}`);
  }
  if (info.types.some((t) => t === null)) return err('bad_module', 'GC struct and array types are not supported');

  const memExport = info.exports.find((e) => e.name === 'memory');
  if (!memExport || memExport.kind !== 'memory') return err('missing_export', 'module must export its memory as "memory"');
  for (const want of REQUIRED_EXPORTS) {
    const ex = info.exports.find((e) => e.name === want.name);
    const sig = formatSignature(...want.sig);
    if (!ex) {
      if (want.optional) continue;
      return err('missing_export', `module must export function ${want.name} ${sig}`);
    }
    if (ex.kind !== 'func' || !sameSignature(funcTypeOf(info, ex.index), ...want.sig)) {
      return err('missing_export', `export ${want.name} must be a function of type ${sig}`);
    }
  }
  return null;
}

interface QuickJsEngine {
  module: WebAssembly.Module;
  /** Bounds the engine module declares for its imported memory, in pages. */
  minPages: number;
  maxPages: number;
  /** End of static data + shadow stack: the heap starts here. */
  heapBase: number;
}

let engine: Promise<QuickJsEngine> | undefined;

/** Compiles the QuickJS engine once per process; every JS instance instantiates it with its own bounded memory. */
function quickjsEngine(): Promise<QuickJsEngine> {
  engine ??= (async () => {
    const require = createRequire(import.meta.url);
    const variantPkg = createRequire(require.resolve('quickjs-emscripten')).resolve('@jitl/quickjs-wasmfile-release-sync/package.json');
    const bytes = await readFile(join(dirname(variantPkg), 'dist', 'emscripten-module.wasm'));
    const info = parseWasm(bytes);
    const mem = info.imports.find((i) => i.kind === 'memory')?.limits;
    if (!mem || mem.max === undefined || info.global0I32 === undefined) throw new Error('unexpected QuickJS engine layout');
    return { module: await WebAssembly.compile(bytes), minPages: mem.min, maxPages: mem.max, heapBase: info.global0I32 };
  })();
  return engine;
}
