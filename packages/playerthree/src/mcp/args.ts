/**
 * Strict validation of tool arguments against the generated input JSON Schemas (the subset `surface.ts` emits:
 * type, const, enum, properties/required/no additional properties, dependentRequired, maps (additionalProperties as a
 * value schema, propertyNames, minProperties/maxProperties), items/minItems/maxItems/uniqueItems,
 * minLength/maxLength/pattern, minimum/maximum). Every keyword the advertised schema carries is enforced here, before
 * any state is touched. Failures are closed codes + schema paths (field names, indices, or `?` for a map key) — input
 * is never echoed. `oneOf` subtrees (the intent union of game_act) are left to the host, which acks each intent individually.
 */
import { codePointLength, type JsonSchema, type SchemaErrorCode, type SchemaPath } from '../schema.ts';

export type ArgsResult = { ok: true } | { ok: false; code: SchemaErrorCode; path: SchemaPath };

class Fail {
  readonly code: SchemaErrorCode;
  readonly path: SchemaPath;
  constructor(code: SchemaErrorCode, path: SchemaPath) {
    this.code = code;
    this.path = path;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const patterns = new WeakMap<JsonSchema, RegExp>();

function matchesPattern(schema: JsonSchema, value: string): boolean {
  if (typeof schema.pattern !== 'string') return true;
  let pattern = patterns.get(schema);
  if (!pattern) {
    pattern = new RegExp(schema.pattern, 'u');
    patterns.set(schema, pattern);
  }
  return pattern.test(value);
}


function check(s: JsonSchema, v: unknown, path: SchemaPath): void {
  if (s['oneOf'] !== undefined) return;
  if (s['const'] !== undefined && v !== s['const']) throw new Fail('enum', path);
  switch (s['type']) {
    case 'object': {
      if (!isPlainObject(v)) throw new Fail('type', path);
      const props = (s['properties'] ?? {}) as Record<string, JsonSchema>;
      // A map (`additionalProperties` is a value schema): its keys are input, so failures point at `?`, never the key.
      const values = typeof s['additionalProperties'] === 'object' ? (s['additionalProperties'] as JsonSchema) : undefined;
      const keys = Object.keys(v);
      if (typeof s['maxProperties'] === 'number' && keys.length > s['maxProperties']) throw new Fail('too_long', path);
      if (typeof s['minProperties'] === 'number' && keys.length < s['minProperties']) throw new Fail('range', path);
      for (const k of keys) {
        if (Object.hasOwn(props, k)) continue;
        if (!values) throw new Fail('unknown_field', [...path, '?']);
        if (s['propertyNames'] !== undefined) check(s['propertyNames'] as JsonSchema, k, [...path, '?']);
        check(values, v[k], [...path, '?']);
      }
      for (const k of (s['required'] ?? []) as string[]) if (v[k] === undefined) throw new Fail('missing_field', [...path, k]);
      for (const [k, ps] of Object.entries(props)) if (v[k] !== undefined) check(ps, v[k], [...path, k]);
      for (const [k, deps] of Object.entries((s['dependentRequired'] ?? {}) as Record<string, string[]>)) {
        if (v[k] === undefined) continue;
        for (const dep of deps) if (v[dep] === undefined) throw new Fail('missing_field', [...path, dep]);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(v)) throw new Fail('type', path);
      if (typeof s['maxItems'] === 'number' && v.length > s['maxItems']) throw new Fail('too_long', path);
      if (typeof s['minItems'] === 'number' && v.length < s['minItems']) throw new Fail('range', path);
      const items = s['items'] as JsonSchema | undefined;
      if (items) for (let i = 0; i < v.length; i++) check(items, v[i], [...path, i]);
      if (s['uniqueItems'] === true) {
        // Items are already schema-checked primitives or closed objects, so their JSON is a faithful identity.
        const seen = new Set<string>();
        for (let i = 0; i < v.length; i++) {
          const id = JSON.stringify(v[i]);
          if (seen.has(id)) throw new Fail('range', [...path, i]);
          seen.add(id);
        }
      }
      return;
    }
    case 'string': {
      if (typeof v !== 'string') throw new Fail('type', path);
      const values = s['enum'] as string[] | undefined;
      if (values && !values.includes(v)) throw new Fail('enum', path);
      const length = codePointLength(v);
      if (typeof s['maxLength'] === 'number' && length > s['maxLength']) throw new Fail('too_long', path);
      if (typeof s['minLength'] === 'number' && length < s['minLength']) throw new Fail('range', path);
      if (!matchesPattern(s, v)) throw new Fail('pattern', path);
      return;
    }
    case 'integer':
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Fail('type', path);
      if (s['type'] === 'integer' && !Number.isInteger(v)) throw new Fail('not_integer', path);
      if (typeof s['minimum'] === 'number' && v < s['minimum']) throw new Fail('range', path);
      if (typeof s['maximum'] === 'number' && v > s['maximum']) throw new Fail('range', path);
      return;
    }
    case 'boolean':
      if (typeof v !== 'boolean') throw new Fail('type', path);
      return;
  }
}

/** `undefined` arguments count as `{}` (MCP clients may omit `arguments` for argument-less tools). */
export function checkArgs(schema: JsonSchema, args: unknown): ArgsResult {
  try {
    check(schema, args ?? {}, []);
    return { ok: true };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, code: e.code, path: e.path };
    throw e;
  }
}
