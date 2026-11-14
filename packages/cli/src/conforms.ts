/**
 * Strict conformance check for the JSON Schema subset `toJsonSchema` emits. Used by `playerthree audit` on remote
 * endpoints, where only the briefing's JSON Schemas are available.
 */
import type { JsonSchema } from './fuzz.ts';
import { codePointLength } from 'playerthree/schema';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = Object.prototype.hasOwnProperty;
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


/** First failing path, or undefined when `value` conforms. */
export function nonConformance(s: JsonSchema, value: unknown, path = '$'): string | undefined {
  if (Array.isArray(s.enum)) return typeof value === 'string' && s.enum.includes(value) ? undefined : path;
  if ('const' in s) return value === s.const ? undefined : path;
  if (Array.isArray(s.oneOf)) {
    const matches = (s.oneOf as unknown[]).filter((v) => isObj(v) && nonConformance(v, value, path) === undefined).length;
    return matches === 1 ? undefined : path;
  }
  switch (s.type) {
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return path;
      if (s.type === 'integer' && !Number.isInteger(value)) return path;
      if (typeof s.minimum === 'number' && value < s.minimum) return path;
      if (typeof s.maximum === 'number' && value > s.maximum) return path;
      return undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : path;
    case 'string':
      if (typeof value !== 'string') return path;
      if (typeof s.maxLength === 'number' && codePointLength(value) > s.maxLength) return path;
      if (typeof s.minLength === 'number' && codePointLength(value) < s.minLength) return path;
      return matchesPattern(s, value) ? undefined : path;
    case 'array': {
      if (!Array.isArray(value)) return path;
      if (typeof s.maxItems === 'number' && value.length > s.maxItems) return path;
      const items = isObj(s.items) ? s.items : {};
      for (let i = 0; i < value.length; i++) {
        const bad = nonConformance(items, value[i], `${path}[${i}]`);
        if (bad) return bad;
      }
      return undefined;
    }
    case 'object': {
      if (!isObj(value)) return path;
      const props = isObj(s.properties) ? s.properties : {};
      const req = Array.isArray(s.required) ? (s.required as string[]) : [];
      for (const k of Object.keys(value)) if (!hasOwn.call(props, k)) return `${path}.?`;
      for (const k of req) if (!hasOwn.call(value, k)) return `${path}.${k}`;
      for (const [k, p] of Object.entries(props)) {
        if (!hasOwn.call(value, k) || !isObj(p)) continue;
        const bad = nonConformance(p, value[k], `${path}.${k}`);
        if (bad) return bad;
      }
      return undefined;
    }
    default:
      return path;
  }
}
