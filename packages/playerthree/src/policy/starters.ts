/**
 * Starters (spec §11 *Starters*): ready-made baseline policies a game serves as skill `.js` files, deployed by reference
 * (`{from, knobs?}`). This module reads each declared starter's exports once per manifest (`starterCatalog`), validates
 * a deploy's reference and knobs with closed errors (`parseStarterRef`), and builds the reference through the one
 * policy build path (`buildStarter` → `buildPolicy` with a generated entry module).
 */
import { posix } from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import type { StarterRef } from '../control.ts';
import { fitExpected } from '../dts.ts';
import { PlayerThreeError } from '../host/util.ts';
import {
  STARTER_KNOBS_MAX_BYTES,
  STARTER_KNOBS_SCHEMA_MAX_BYTES,
  STARTER_MAX_KNOBS,
  type AnyManifest,
  type SkillDef,
  type StarterDef,
} from '../manifest.ts';
import { checkArgs } from '../mcp/args.ts';
import type { EnumS, JsonSchema, SchemaErrorCode, SchemaPath } from '../schema.ts';
import { buildPolicy, POLICY_ES_TARGET, type PolicyBuildResult } from './build.ts';

/** Module path of the generated entry that binds a starter's instance to the sandbox globals. */
export const STARTER_ENTRY = 'starter.js';
/** Objects in a knobs schema nest at most this deep (the root object is depth 1). */
const KNOBS_DEPTH = 4;
const KNOB_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Keys that would reach an object prototype when a starter indexes or merges its knobs. */
const PROTO_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
const DESCRIPTION_MAX = 512;
const ENUM_MAX = 64;
const ENUM_VALUE_MAX = 64;
const STRING_MAX = 256;
const ITEMS_MAX = 256;
/** The schema of a starter that exports no `knobs`: only `{}`. */
const NO_KNOBS: JsonSchema = { type: 'object', additionalProperties: false, properties: {} };

/** One declared starter with what its module exports. */
export interface Starter {
  /** `"<skill>/<path>.js"`. */
  readonly path: string;
  readonly summary: string;
  /** The roles it plays, in manifest order of declaration (default every role). */
  readonly roles: readonly string[];
  /** Its `knobs` JSON Schema (validated, host-realm copy); null when the module exports none. */
  readonly knobs: JsonSchema | null;
}

/** Declared starters by path, in manifest order. */
export type StarterCatalog = ReadonlyMap<string, Starter>;

const EMPTY: StarterCatalog = new Map();
const catalogs = new WeakMap<AnyManifest, StarterCatalog>();

/**
 * The manifest's starters with their exports, read once per manifest: the declared modules and their static relative
 * imports are evaluated outside the sandbox (trusted developer skill text, never player input) in one fresh realm with
 * a no-op `log`. A starter that fails to evaluate, lacks `createPolicy` or exports an invalid `knobs` schema throws a
 * developer error naming it.
 */
export function starterCatalog(manifest: AnyManifest): StarterCatalog {
  if (manifest.starters === undefined) return EMPTY;
  const cached = catalogs.get(manifest);
  if (cached) return cached;
  const roles = (manifest.roles as EnumS).values;
  const load = moduleLoader(manifest.skills as readonly SkillDef[]);
  const out = new Map<string, Starter>();
  for (const [path, def] of Object.entries(manifest.starters as Record<string, StarterDef>)) {
    let exports: Record<string, unknown>;
    try {
      exports = load(path);
    } catch (e) {
      // Errors thrown by starter code come from the evaluation realm: `instanceof Error` does not hold for them.
      const message = typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string' ? e.message : String(e);
      throw new Error(`playerthree/starters: ${path}: evaluation failed: ${message}`);
    }
    if (typeof exports.createPolicy !== 'function') throw new Error(`playerthree/starters: ${path}: must export createPolicy(knobs)`);
    const knobs = exports.knobs === undefined ? null : checkKnobsSchema(path, exports.knobs);
    out.set(path, { path, summary: def.summary, roles: def.roles ? [...def.roles] : [...roles], knobs });
  }
  catalogs.set(manifest, out);
  return out;
}

/**
 * A synchronous CommonJS-style loader over the skills' `.js` files: each file is transformed by esbuild (ESM → CJS,
 * the sandbox's ES level) and run once in a shared fresh realm. Imports resolve exactly like served skill imports in
 * `buildPolicy`: relative, with the `.js` extension, inside the root, naming a skill `.js` file.
 */
function moduleLoader(skills: readonly SkillDef[]): (path: string) => Record<string, unknown> {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const context = vm.createContext({ log: () => {} }, { codeGeneration: { strings: false, wasm: false } });
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  const source = (path: string): string | undefined => {
    const slash = path.indexOf('/');
    const skill = slash > 0 ? byName.get(path.slice(0, slash)) : undefined;
    const file = path.slice(slash + 1);
    return skill && file.endsWith('.js') && Object.hasOwn(skill.files, file) ? skill.files[file] : undefined;
  };
  const load = (path: string): Record<string, unknown> => {
    const known = modules.get(path);
    // A cycle sees the partial exports, as CommonJS does.
    if (known) return known.exports;
    const text = source(path);
    if (text === undefined) throw new Error(`no served skill .js file ${JSON.stringify(path)}`);
    const module = { exports: {} as Record<string, unknown> };
    modules.set(path, module);
    const { code } = transformSync(text, { format: 'cjs', loader: 'js', target: POLICY_ES_TARGET, sourcefile: path, logLevel: 'silent' });
    const run = new vm.Script(`(function (exports, require, module) {${code}\n})`, { filename: path }).runInContext(context) as
      (exports: unknown, require: (specifier: string) => unknown, module: unknown) => void;
    run(module.exports, (specifier: string) => {
      if (typeof specifier !== 'string' || !(specifier.startsWith('./') || specifier.startsWith('../'))) {
        throw new Error(`${path}: ${JSON.stringify(specifier)} is not a relative import`);
      }
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (target === '..' || target.startsWith('../')) throw new Error(`${path}: ${JSON.stringify(specifier)} escapes the skill root`);
      return load(target);
    }, module);
    return module.exports;
  };
  return load;
}

/** A plain object of any realm (starter exports come from the evaluation realm, whose `Object.prototype` differs). */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.prototype.toString.call(v) === '[object Object]';

/** Plain JSON data only (objects of any realm, arrays, strings, finite numbers, booleans, null), at most 64 deep. */
function isJsonData(v: unknown, depth: number): boolean {
  if (depth > 64) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonData(x, depth + 1));
  return isRecord(v) && Object.values(v).every((x) => isJsonData(x, depth + 1));
}

/** Spec §11 *Starters* knobs rules → the host-realm schema copy, or a developer error naming the starter and the node. */
function checkKnobsSchema(starter: string, raw: unknown): JsonSchema {
  const fail = (at: string, why: string): never => {
    throw new Error(`playerthree/starters: ${starter}: knobs${at}: ${why}`);
  };
  if (!isJsonData(raw, 0)) fail('', 'must be plain JSON data');
  const json = JSON.stringify(raw);
  if (Buffer.byteLength(json, 'utf8') > STARTER_KNOBS_SCHEMA_MAX_BYTES) fail('', `at most ${STARTER_KNOBS_SCHEMA_MAX_BYTES} bytes of JSON`);
  const schema = JSON.parse(json) as JsonSchema;
  const only = (s: Record<string, unknown>, at: string, keys: readonly string[]): void => {
    for (const k of Object.keys(s)) if (!keys.includes(k)) fail(at, `unsupported keyword ${JSON.stringify(k)}`);
  };
  const checkObject = (s: Record<string, unknown>, at: string, depth: number, extra: readonly string[]): void => {
    only(s, at, ['type', 'additionalProperties', 'properties', 'description', ...extra]);
    if (s.type !== 'object' || s.additionalProperties !== false || !isRecord(s.properties)) fail(at, 'must be {type:"object", additionalProperties:false, properties}');
    if (depth > KNOBS_DEPTH) fail(at, `objects nest at most ${KNOBS_DEPTH} deep`);
    const props = Object.entries(s.properties as Record<string, unknown>);
    if (props.length === 0 || props.length > STARTER_MAX_KNOBS) fail(at, `1..${STARTER_MAX_KNOBS} properties`);
    for (const [name, p] of props) {
      const pat = `${at}.${name}`;
      if (!KNOB_NAME.test(name) || PROTO_KEYS.includes(name)) fail(pat, `name must match ${KNOB_NAME} and not be __proto__, constructor or prototype`);
      if (!isRecord(p) || !Object.hasOwn(p, 'default') || p.default === null) fail(pat, 'every knob needs a non-null default');
      checkNode(p as Record<string, unknown>, pat, depth, true);
      if (!checkArgs(p as JsonSchema, (p as Record<string, unknown>).default).ok) fail(pat, 'default must satisfy its own schema');
    }
  };
  const checkNode = (s: Record<string, unknown>, at: string, depth: number, property: boolean): void => {
    const base = property ? ['type', 'description', 'default'] : ['type', 'description'];
    if (s.description !== undefined && !(typeof s.description === 'string' && s.description.length > 0 && s.description.length <= DESCRIPTION_MAX)) {
      fail(at, `description: 1..${DESCRIPTION_MAX} chars`);
    }
    const bound = (v: unknown, integer: boolean): boolean => typeof v === 'number' && (integer ? Number.isSafeInteger(v) : Number.isFinite(v));
    switch (s.type) {
      case 'integer':
      case 'number': {
        only(s, at, [...base, 'minimum', 'maximum']);
        const integer = s.type === 'integer';
        if (!bound(s.minimum, integer) || !bound(s.maximum, integer) || (s.minimum as number) > (s.maximum as number)) {
          fail(at, `needs ${integer ? 'safe integer' : 'finite'} minimum ≤ maximum`);
        }
        return;
      }
      case 'boolean':
        only(s, at, base);
        return;
      case 'string':
        if (s.enum !== undefined) {
          only(s, at, [...base, 'enum']);
          const values = s.enum;
          if (!Array.isArray(values) || values.length === 0 || values.length > ENUM_MAX || new Set(values).size !== values.length ||
            values.some((v) => typeof v !== 'string' || v.length === 0 || v.length > ENUM_VALUE_MAX)) {
            fail(at, `enum: 1..${ENUM_MAX} unique strings of 1..${ENUM_VALUE_MAX} chars`);
          }
        } else {
          only(s, at, [...base, 'maxLength']);
          if (!Number.isSafeInteger(s.maxLength) || (s.maxLength as number) < 1 || (s.maxLength as number) > STRING_MAX) fail(at, `a string needs an enum or maxLength 1..${STRING_MAX}`);
        }
        return;
      case 'array': {
        only(s, at, [...base, 'items', 'maxItems', 'minItems', 'uniqueItems']);
        const max = s.maxItems;
        if (!Number.isSafeInteger(max) || (max as number) < 0 || (max as number) > ITEMS_MAX) fail(at, `maxItems 0..${ITEMS_MAX}`);
        if (s.minItems !== undefined && (!Number.isSafeInteger(s.minItems) || (s.minItems as number) < 0 || (s.minItems as number) > (max as number))) fail(at, 'minItems 0..maxItems');
        if (s.uniqueItems !== undefined && typeof s.uniqueItems !== 'boolean') fail(at, 'uniqueItems must be a boolean');
        if (!isRecord(s.items) || s.items.type === 'array') fail(`${at}[]`, 'items: any knob shape except an array');
        checkNode(s.items as Record<string, unknown>, `${at}[]`, depth, false);
        return;
      }
      case 'object':
        checkObject(s, at, depth + 1, property ? ['default'] : []);
        return;
      default:
        fail(at, 'type must be integer, number, boolean, string, array or object');
    }
  };
  // The root is an object node (depth 1) with no default of its own.
  if (schema.type !== 'object') fail('', 'must be {type:"object", additionalProperties:false, properties}');
  checkNode(schema, '', 0, false);
  return schema;
}

// ------------------------------------------------------------------ deploy references

/** `Knobs[...]: <type> (<bounds>)` at `path` (the knobs-relative schema path), from the schema and path only. */
function knobExpected(schema: JsonSchema, path: SchemaPath): string {
  let node = schema;
  let ref = 'Knobs';
  for (const seg of path) {
    if (seg === '?') break;
    const props = node.properties as Record<string, JsonSchema> | undefined;
    const next = typeof seg === 'number'
      ? (node.type === 'array' ? (node.items as JsonSchema) : undefined)
      : (node.type === 'object' && props && Object.hasOwn(props, seg) ? props[seg] : undefined);
    if (!next) break;
    node = next;
    ref += typeof seg === 'number' ? '[number]' : `[${JSON.stringify(seg)}]`;
  }
  return fitExpected(ref, knobMembers(node), knobBounds(node));
}

/** A knob node's type as union members, in the generated declarations' vocabulary (objects as field-name shapes). */
function knobMembers(s: JsonSchema): string[] {
  switch (s.type) {
    case 'integer':
    case 'number':
      return ['number'];
    case 'boolean':
      return ['boolean'];
    case 'string':
      return Array.isArray(s.enum) ? (s.enum as string[]).map((v) => JSON.stringify(v)) : ['string'];
    case 'array': {
      const item = knobMembers(s.items as JsonSchema);
      return [`${item.length > 1 ? `(${item.join(' | ')})` : item[0]}[]`];
    }
    default: {
      const keys = Object.keys((s.properties ?? {}) as Record<string, unknown>).map((k) => `${k}?`);
      return [keys.length === 0 ? 'Record<string, never>' : `{ ${keys.join('; ')} }`];
    }
  }
}

/** A knob node's bounds note (`integer 0..10`, `at most 8 items, each 0..3`), empty when its type says it all. */
function knobBounds(s: JsonSchema): string {
  switch (s.type) {
    case 'integer':
      return `integer ${s.minimum}..${s.maximum}`;
    case 'number':
      return `${s.minimum}..${s.maximum}`;
    case 'string':
      return Array.isArray(s.enum) ? '' : `at most ${s.maxLength} code points`;
    case 'array': {
      const item = (s.items as JsonSchema).type === 'object' ? '' : knobBounds(s.items as JsonSchema);
      return `at most ${s.maxItems} items${typeof s.minItems === 'number' && s.minItems > 0 ? `, at least ${s.minItems}` : ''}${s.uniqueItems === true ? ', unique' : ''}${item ? `, each ${item}` : ''}`;
    }
    default:
      return '';
  }
}

/** One line per knob (nested knobs indented): `` - `name`: type (bounds), default D — description ``. */
export function knobLines(schema: JsonSchema | null): string[] {
  if (schema === null) return ['- none: deploy it without knobs'];
  const out: string[] = [];
  const walk = (s: JsonSchema, indent: string): void => {
    for (const [name, p] of Object.entries(s.properties as Record<string, JsonSchema>)) {
      const bounds = knobBounds(p);
      out.push(`${indent}- \`${name}\`: ${knobMembers(p).join(' | ')}${bounds ? ` (${bounds})` : ''}, default \`${JSON.stringify(p.default)}\`${typeof p.description === 'string' ? ` — ${p.description}` : ''}`);
      if (p.type === 'object') walk(p, `${indent}  `);
      else if (p.type === 'array' && (p.items as JsonSchema).type === 'object') walk(p.items as JsonSchema, `${indent}  `);
    }
  };
  walk(schema, '');
  return out;
}

/** `Starter: "a" | "b"` — the starters the seat's role may deploy. */
function fromExpected(catalog: StarterCatalog, role: string | undefined): string {
  const paths = [...catalog.values()].filter((s) => role === undefined || s.roles.includes(role)).map((s) => JSON.stringify(s.path));
  return fitExpected(role === undefined ? 'Starter' : `Starter (role ${role})`, paths.length > 0 ? paths : ['never'], '');
}

/** The validated knobs rebuilt with keys in schema order (nested objects and object items too): equal knobs, equal JSON. */
function ordered(schema: JsonSchema, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => ordered(schema.items as JsonSchema, item));
  if (schema.type !== 'object' || value === null || typeof value !== 'object') return value;
  const props = schema.properties as Record<string, JsonSchema>;
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(props)) if (Object.hasOwn(v, k)) out[k] = ordered(s, v[k]);
  return out;
}

/**
 * A deploy's starter reference → its normalized source `{from, knobs?}` (spec §11 *Starters*): `from` a declared starter
 * that plays `role` (when given), `knobs` a JSON object of at most STARTER_KNOBS_MAX_BYTES that the starter's schema
 * accepts, rebuilt in schema key order. Failures are `PlayerThreeError('invalid')` with a closed `{schemaCode, path,
 * expected}` detail, never echoing the rejected key or value.
 */
export function parseStarterRef(catalog: StarterCatalog, from: unknown, knobs: unknown, role?: string): StarterRef {
  const starter = typeof from === 'string' ? catalog.get(from) : undefined;
  if (!starter || (role !== undefined && !starter.roles.includes(role))) {
    throw new PlayerThreeError('invalid', { schemaCode: 'enum', path: ['from'], expected: fromExpected(catalog, role) });
  }
  if (knobs === undefined) return { from: starter.path };
  const schema = starter.knobs ?? NO_KNOBS;
  const invalid = (schemaCode: SchemaErrorCode, path: SchemaPath): PlayerThreeError =>
    new PlayerThreeError('invalid', { schemaCode, path: ['knobs', ...path], expected: knobExpected(schema, path) });
  let json: string | undefined;
  try {
    json = JSON.stringify(knobs);
  } catch {
    json = undefined;
  }
  // Before parsing: an oversize (or deeply nested) object never reaches the validator.
  if (json !== undefined && (json.length > STARTER_KNOBS_MAX_BYTES || Buffer.byteLength(json, 'utf8') > STARTER_KNOBS_MAX_BYTES)) throw invalid('too_long', []);
  const value: unknown = json === undefined ? undefined : JSON.parse(json);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('type', []);
  const checked = checkArgs(schema, value);
  if (!checked.ok) throw invalid(checked.code, checked.path);
  return { from: starter.path, knobs: ordered(schema, value) as Record<string, unknown> };
}

/**
 * The generated entry module (spec §11 *Starters*): one instance per sandbox instance, made with the knobs (re-parsed
 * from a JSON string literal, so a key is always data), bound to the ABI globals.
 */
export function starterModule(ref: StarterRef): string {
  const knobs = ref.knobs === undefined ? 'null' : `JSON.parse(${JSON.stringify(JSON.stringify(ref.knobs))})`;
  return `import * as starter from ${JSON.stringify(`./${ref.from}`)};
const seat = starter.createPolicy(${knobs});
export function think(obs) { return seat.think(obs); }
export function init(matchData) { if (typeof seat.init === 'function') seat.init(matchData); }
export const detail = starter.detail;
`;
}

/** Build a validated reference exactly as a `modules` artifact whose only module is the generated entry. */
export function buildStarter(ref: StarterRef, skills: readonly SkillDef[]): Promise<PolicyBuildResult> {
  const entry = starterModule(ref);
  return buildPolicy({ entry: STARTER_ENTRY, load: (path) => (path === STARTER_ENTRY ? entry : undefined), skills });
}
