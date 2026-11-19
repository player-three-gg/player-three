/**
 * Policy packages (spec §13.1): the portable, self-verifying form of one commander library version, format
 * `playerthree.policy/1`, exchanged as its canonical JSON (`canonicalJson`). Everything here derives from the manifest
 * and its policy limits; the import checks that need a seat (the caller's role, the rebuild from `source` against the
 * served skills) belong to the commander registry.
 *
 * Validation is closed and never echoes: a rejected package is just `undefined`, whatever was wrong with it.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './briefing.ts';
import { BASE64, policyArtifactHash } from './host/pipeline.ts';
import {
  GAME_ID,
  MAX_POLICY_INCLUDES,
  POLICY_EXPORT_PAGE,
  POLICY_MAX_MODULES,
  POLICY_MODULES_MAX_BYTES,
  POLICY_PACKAGE_FORMAT,
  POLICY_PACKAGE_MAX_BYTES,
  STARTER_KNOBS_MAX_BYTES,
  STARTER_PATH_MAX,
  observationSections,
  type AnyManifest,
  type PolicyLimits,
  type PolicyRuntime,
} from './manifest.ts';
import { isModulePath } from './policy/build.ts';
import { codePointLength, type EnumS } from './schema.ts';

export type { PolicyExportPage, PolicyPackage, PolicyPackageSource } from './control.ts';
import type { PolicyExportPage, PolicyPackage, PolicyPackageSource } from './control.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_INT = 2 ** 31 - 1;
/** One SPDX identifier (optionally `LicenseRef-`), one to four joined by ` AND ` / ` OR `. */
const LICENSE = /^(?:LicenseRef-)?[A-Za-z0-9][A-Za-z0-9.+-]{0,63}(?: (?:AND|OR) (?:LicenseRef-)?[A-Za-z0-9][A-Za-z0-9.+-]{0,63}){0,3}$/;
const LICENSE_MAX = 256;
const AUTHOR_MAX = 64;
/** C0/C1 controls and bidi controls (marks, embeddings, overrides, isolates): never in an author name. */
const AUTHOR_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** `include` entries (`"<skill>/<path>"`, `.js`), as the `policy_deploy` input schema bounds them. */
const INCLUDE = /^[a-z0-9]+(-[a-z0-9]+)*\/.+\.js$/;
const INCLUDE_MAX = 265;
/** Keys that could reach an object prototype when a consumer merges or indexes package data. */
const PROTO_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

const REQUIRED_KEYS = ['format', 'game', 'surfaceHash', 'roles', 'runtime', 'detail', 'source', 'script', 'scriptHash', 'lineage', 'license', 'author', 'createdAt', 'hash'];

class Reject extends Error {}
const reject = (): never => {
  throw new Reject();
};

function isPlain(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Exactly `required` keys, plus any of `optional`. */
function keysOf(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isPlain(v)) return reject();
  const keys = Object.keys(v);
  for (const k of required) if (!Object.hasOwn(v, k)) reject();
  for (const k of keys) if (!required.includes(k) && !optional.includes(k)) reject();
  return v;
}

const hex64 = (v: unknown): string => (typeof v === 'string' && HEX64.test(v) ? v : reject());
const int = (v: unknown, min: number, max: number): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : reject());

/** Own prototype-reaching keys anywhere in a JSON value (a parsed wire object may carry them as own data properties). */
function hasProtoKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasProtoKey);
  if (v === null || typeof v !== 'object') return false;
  for (const k of Object.keys(v)) if (PROTO_KEYS.includes(k) || hasProtoKey((v as Record<string, unknown>)[k])) return true;
  return false;
}

/** A composed `script` or WASM `source.code` within `maxArtifactBytes` (decoded bytes for base64 WASM). */
function code(v: unknown, runtime: PolicyRuntime, maxBytes: number): string {
  if (typeof v !== 'string' || v.length === 0) return reject();
  if (runtime === 'wasm') {
    if (v.length > Math.ceil(maxBytes / 3) * 4 + 4 || !BASE64.test(v) || Buffer.byteLength(v, 'base64') > maxBytes) reject();
  } else if (v.length > maxBytes || Buffer.byteLength(v, 'utf8') > maxBytes) {
    reject();
  }
  return v;
}

function source(v: unknown, runtime: PolicyRuntime, maxBytes: number): PolicyPackageSource | null {
  if (v === null) return null;
  if (!isPlain(v)) return reject();
  if (Object.hasOwn(v, 'from')) {
    // A starter reference (spec §11 *Starters*): the importing host rebuilds it against its own declared starters.
    const s = keysOf(v, ['from'], ['knobs']);
    const from = s['from'];
    if (runtime !== 'js' || typeof from !== 'string' || from.length > STARTER_PATH_MAX || !INCLUDE.test(from)) return reject();
    if (s['knobs'] === undefined) return { from };
    const knobs = s['knobs'];
    if (!isPlain(knobs) || Buffer.byteLength(JSON.stringify(knobs), 'utf8') > STARTER_KNOBS_MAX_BYTES) return reject();
    return { from, knobs };
  }
  const modular = Object.hasOwn(v, 'modules');
  const s = modular ? keysOf(v, ['modules', 'entry'], ['include']) : keysOf(v, ['code'], ['include']);
  let include: string[] | undefined;
  if (s['include'] !== undefined) {
    const list = s['include'];
    if (runtime !== 'js' || !Array.isArray(list) || list.length > MAX_POLICY_INCLUDES || new Set(list).size !== list.length) return reject();
    include = list.map((e: unknown) => (typeof e === 'string' && e.length >= 3 && e.length <= INCLUDE_MAX && INCLUDE.test(e) ? e : reject()));
  }
  const withInclude = include === undefined ? {} : { include };
  if (!modular) return { code: code(s['code'], runtime, maxBytes), ...withInclude };
  if (runtime !== 'js' || !isPlain(s['modules'])) return reject();
  const modules = s['modules'] as Record<string, unknown>;
  const paths = Object.keys(modules);
  if (paths.length === 0 || paths.length > POLICY_MAX_MODULES) reject();
  let bytes = 0;
  const out: Record<string, string> = {};
  for (const path of paths) {
    const text = modules[path];
    if (!isModulePath(path) || typeof text !== 'string') reject();
    bytes += Buffer.byteLength(text as string, 'utf8');
    if (bytes > POLICY_MODULES_MAX_BYTES) reject();
    out[path] = text as string;
  }
  const entry = s['entry'];
  if (typeof entry !== 'string' || !Object.hasOwn(out, entry)) reject();
  return { modules: out, entry: entry as string, ...withInclude };
}

function detail(v: unknown, sections: readonly string[]): PolicyPackage['detail'] {
  if (v === null || v === 'all') return v;
  if (!Array.isArray(v) || v.length > sections.length || new Set(v).size !== v.length) return reject();
  return v.map((s: unknown) => (typeof s === 'string' && sections.includes(s) ? s : reject()));
}

/** SPDX license expression (spec §13.1 grammar). */
export function isPolicyLicense(v: unknown): v is string {
  return typeof v === 'string' && v.length <= LICENSE_MAX && LICENSE.test(v);
}

/** A package author display name: 1–64 code points without control or bidi characters. */
export function isPolicyAuthor(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || AUTHOR_FORBIDDEN.test(v)) return false;
  const n = codePointLength(v);
  return n >= 1 && n <= AUTHOR_MAX;
}

/** SHA-256 hex of the canonical JSON of a package without its `hash`. */
export function policyPackageHash(pkg: Omit<PolicyPackage, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(pkg), 'utf8').digest('hex');
}

/** A package from its members: adds `format` and `hash`. Members are taken as given (validate what you emit). */
export function createPolicyPackage(members: Omit<PolicyPackage, 'format' | 'hash'>): PolicyPackage {
  const unhashed: Omit<PolicyPackage, 'hash'> = { format: POLICY_PACKAGE_FORMAT, ...members };
  return { ...unhashed, hash: policyPackageHash(unhashed) };
}

/**
 * Untrusted package → the validated package, or `undefined`. In spec §13.1 order: a JSON snapshot (accessors and
 * prototypes cannot change it after the checks), no own `__proto__`/`constructor`/`prototype` key anywhere, the closed
 * schema (bounded by the policy `limits` and the manifest's roles and observation sections), the canonical size, the
 * `hash`, `game.id` = the manifest id, `runtime` allowed by `limits`, and `scriptHash` of `script`. The caller's role
 * and the rebuild from `source` are the importing host's checks.
 */
export function validatePolicyPackage(raw: unknown, limits: PolicyLimits, manifest: AnyManifest): PolicyPackage | undefined {
  let snapshot: unknown;
  try {
    const json = JSON.stringify(raw);
    // Compact JSON of a package has the canonical form's length (same members, other order), and UTF-8 never takes
    // fewer bytes than UTF-16 code units: a longer snapshot is oversize before any parsing.
    if (json === undefined || json.length > POLICY_PACKAGE_MAX_BYTES) return undefined;
    snapshot = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    if (hasProtoKey(snapshot)) return undefined;
    const p = keysOf(snapshot, REQUIRED_KEYS, ['record']);
    if (p['format'] !== POLICY_PACKAGE_FORMAT) reject();
    const game = keysOf(p['game'], ['id', 'version']);
    const id = typeof game['id'] === 'string' && GAME_ID.test(game['id']) ? game['id'] : reject();
    const version = game['version'];
    if (typeof version !== 'string' || version.length === 0 || codePointLength(version) > 64) reject();
    const roles = (manifest.roles as EnumS).values;
    const rawRoles = p['roles'];
    if (!Array.isArray(rawRoles) || rawRoles.length === 0 || new Set(rawRoles).size !== rawRoles.length) reject();
    const packageRoles = (rawRoles as unknown[]).map((r) => (typeof r === 'string' && roles.includes(r) ? r : reject()));
    const runtime = p['runtime'] === 'js' || p['runtime'] === 'wasm' ? p['runtime'] : reject();
    const lineage = keysOf(p['lineage'], ['parent', 'version']);
    const license = p['license'];
    if (!isPolicyLicense(license)) reject();
    const author = p['author'];
    if (author !== null && !isPolicyAuthor(author)) reject();
    const createdAt = p['createdAt'];
    if (typeof createdAt !== 'string' || !CREATED_AT.test(createdAt) || Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) reject();
    let record: PolicyPackage['record'];
    if (p['record'] !== undefined) {
      const r = keysOf(p['record'], ['wins', 'losses', 'draws']);
      record = { wins: int(r['wins'], 0, MAX_INT), losses: int(r['losses'], 0, MAX_INT), draws: int(r['draws'], 0, MAX_INT) };
    }
    const pkg: PolicyPackage = {
      format: POLICY_PACKAGE_FORMAT,
      game: { id, version: version as string },
      surfaceHash: hex64(p['surfaceHash']),
      roles: packageRoles,
      runtime,
      detail: detail(p['detail'], observationSections(manifest)),
      source: source(p['source'], runtime, limits.maxArtifactBytes),
      script: code(p['script'], runtime, limits.maxArtifactBytes),
      scriptHash: hex64(p['scriptHash']),
      lineage: { parent: lineage['parent'] === null ? null : hex64(lineage['parent']), version: int(lineage['version'], 1, MAX_INT) },
      license: license as string,
      author: author as string | null,
      createdAt: createdAt as string,
      ...(record === undefined ? {} : { record }),
      hash: hex64(p['hash']),
    };
    const { hash, ...unhashed } = pkg;
    if (Buffer.byteLength(canonicalJson(pkg), 'utf8') > POLICY_PACKAGE_MAX_BYTES) reject();
    if (policyPackageHash(unhashed) !== hash) reject();
    if (id !== manifest.id) reject();
    if (!limits.runtimes.includes(runtime)) reject();
    if (policyArtifactHash({ runtime, code: pkg.script }) !== pkg.scriptHash) reject();
    return pkg;
  } catch (e) {
    if (e instanceof Reject) return undefined;
    throw e;
  }
}

/** Page boundaries of `text`: at most POLICY_EXPORT_PAGE code units each, never between a surrogate pair. */
function pageStarts(text: string): number[] {
  const starts = [0];
  let at = 0;
  while (text.length - at > POLICY_EXPORT_PAGE) {
    let end = at + POLICY_EXPORT_PAGE;
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
    starts.push(end);
    at = end;
  }
  return starts;
}

/** Page `page` (1-based) of a package's canonical JSON `text`, or `undefined` past its end. */
export function policyExportPage(exported: { version: number; hash: string; text: string }, page: number): PolicyExportPage | undefined {
  const starts = pageStarts(exported.text);
  if (!Number.isSafeInteger(page) || page < 1 || page > starts.length) return undefined;
  const pages = starts.length;
  return {
    version: exported.version,
    hash: exported.hash,
    bytes: Buffer.byteLength(exported.text, 'utf8'),
    page,
    pages,
    text: exported.text.slice(starts[page - 1], page < pages ? starts[page] : undefined),
    ...(page < pages ? { next: { version: exported.version, page: page + 1 } } : {}),
  };
}
