/**
 * Schema-derived fuzz cases for `playerthree audit`. Works from the JSON Schema an agent sees in its briefing, so the
 * same generator drives in-process hosts and remote MCP endpoints.
 */
import type { SchemaErrorCode } from 'playerthree/schema';

export type JsonSchema = { readonly [k: string]: unknown };

/** Unique marker that must never come back in any response (input echo detection). */
export const CANARY = 'AUDITcanary7Qz';
/** Large input that must not be echoed (or crash the host). */
export const hugeString = (bytes: number) => `${CANARY}${'x'.repeat(Math.max(0, bytes - CANARY.length))}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Small deterministic PRNG (mulberry32) so audit runs are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Mode = 'random' | 'min' | 'max';

/** Prefix of an id pattern `^p_[0-9]{1,9}$`. */
function idPrefix(s: JsonSchema): string | undefined {
  return typeof s.pattern === 'string' ? /^\^([a-z]+)_\[0-9\]\{1,9\}\$$/.exec(s.pattern)?.[1] : undefined;
}
/** Generate the safe concatenation/last-atom repetition subset emitted for bounded strings. */
function boundedString(s: JsonSchema, mode: Mode, rand: () => number): string {
  const limit = s.maxLength as number;
  if (typeof s.pattern !== 'string') {
    const n = mode === 'min' ? 0 : mode === 'max' ? limit : Math.floor(rand() * (limit + 1));
    return 'x'.repeat(n);
  }
  const suffix = '(?![\\s\\S])';
  const source = s.pattern.endsWith(suffix) ? s.pattern.slice(0, -suffix.length) : s.pattern;
  const body = source.slice(1, -1);
  const parts = [...body.matchAll(/(\\.|(?:\[(?:\\.|[^\]\\])+\])|[^\\[\]])(\{[0-9]+(?:,[0-9]*)?\}|[?*+])?/g)];
  let out = '';
  let used = 0;
  for (const part of parts) {
    const atom = part[1]!;
    const re = new RegExp(`^(?:${atom})$(?![\\s\\S])`, 'u');
    const chars: string[] = [];
    // Every atom in the ASCII-source safe subset either accepts an ASCII character or U+0080.
    for (let cp = 0; cp <= 128; cp++) {
      const c = String.fromCharCode(cp);
      if (re.test(c)) chars.push(c);
    }
    const q = part[2];
    let lo = 1;
    let hi = 1;
    if (q === '*') { lo = 0; hi = limit; }
    else if (q === '+') hi = limit;
    else if (q === '?') lo = 0;
    else if (q) {
      const bounds = q.slice(1, -1).split(',');
      lo = Number(bounds[0]);
      hi = bounds.length === 1 ? lo : bounds[1] === '' ? limit : Number(bounds[1]);
    }
    hi = Math.min(hi, limit - used);
    if (lo > hi || (lo > 0 && chars.length === 0)) throw new Error('playerthree/audit: bounded string pattern has no value within maxLength');
    if (chars.length === 0) hi = 0;
    const n = mode === 'min' ? lo : mode === 'max' ? hi : lo + Math.floor(rand() * (hi - lo + 1));
    const char = mode === 'min' ? chars[0] : mode === 'max' ? chars.at(-1) : chars[Math.floor(rand() * chars.length)];
    out += (char ?? '').repeat(n);
    used += n;
  }
  if (used > limit || !new RegExp(s.pattern, 'u').test(out)) throw new Error('playerthree/audit: cannot generate a valid bounded string pattern');
  return out;
}

/** A value that conforms to `s`. `max` fills lists (capped at `listCap`) and includes every optional field. */
export function validValue(s: JsonSchema, mode: Mode, rand: () => number, listCap = 16): unknown {
  if (Array.isArray(s.enum)) {
    const v = s.enum as string[];
    return mode === 'min' ? v[0] : mode === 'max' ? v[v.length - 1] : v[Math.floor(rand() * v.length)];
  }
  if ('const' in s) return s.const;
  if (Array.isArray(s.oneOf)) {
    const vs = (s.oneOf as unknown[]).filter(isObj);
    const pick = mode === 'min' ? vs[0] : mode === 'max' ? vs[vs.length - 1] : vs[Math.floor(rand() * vs.length)];
    return pick ? validValue(pick, mode, rand, listCap) : null;
  }
  switch (s.type) {
    case 'integer': {
      const lo = s.minimum as number;
      const hi = s.maximum as number;
      return mode === 'min' ? lo : mode === 'max' ? hi : lo + Math.floor(rand() * (hi - lo + 1));
    }
    case 'number': {
      const lo = s.minimum as number;
      const hi = s.maximum as number;
      return mode === 'min' ? lo : mode === 'max' ? hi : lo + rand() * (hi - lo);
    }
    case 'boolean':
      return mode === 'min' ? false : mode === 'max' ? true : rand() < 0.5;
    case 'string': {
      if (typeof s.maxLength === 'number') return boundedString(s, mode, rand);
      const p = idPrefix(s) ?? 'x';
      return mode === 'min' ? `${p}_0` : mode === 'max' ? `${p}_999999999` : `${p}_${Math.floor(rand() * 1000)}`;
    }
    case 'array': {
      const max = Math.min(typeof s.maxItems === 'number' ? s.maxItems : 0, listCap);
      const n = mode === 'min' ? 0 : mode === 'max' ? max : Math.floor(rand() * (max + 1));
      const items = isObj(s.items) ? s.items : {};
      return Array.from({ length: n }, () => validValue(items, mode, rand, listCap));
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = isObj(s.properties) ? s.properties : {};
      const req = Array.isArray(s.required) ? (s.required as string[]) : [];
      for (const [k, p] of Object.entries(props)) {
        if (!isObj(p)) continue;
        const include = req.includes(k) || mode === 'max' || (mode === 'random' && rand() < 0.5);
        if (include) out[k] = validValue(p, mode, rand, listCap);
      }
      return out;
    }
    default:
      return null;
  }
}

export interface Mutation {
  /** Human-readable description (developer-facing). */
  label: string;
  /** Path (field names / indices) the validator should report. */
  path: (string | number)[];
  /** Schema error codes acceptable for this mutation. */
  expect: SchemaErrorCode[];
  value: unknown;
}

const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Object with an own `__proto__`/`constructor`/`prototype` key carrying a pollution payload, exactly as
 * `JSON.parse` produces it from wire input. (Object.assign / `obj[key] =` would invoke the `__proto__` setter instead.)
 */
function protoPayload(base: Record<string, unknown>, key: string): Record<string, unknown> {
  const payload = `{"polluted":"${CANARY}","toString":"${CANARY}"}`;
  const rest = JSON.stringify(base).slice(1, -1);
  return JSON.parse(`{${rest}${rest ? ',' : ''}${JSON.stringify(key)}:${payload}}`) as Record<string, unknown>;
}

function deep(depth: number): unknown {
  let v: unknown = CANARY;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

/** Invalid replacements for a value of schema `s`, each with the error code a strict validator must produce. */
function badValues(s: JsonSchema, hugeBytes: number): { label: string; value: unknown; expect: SchemaErrorCode[]; sub?: (string | number)[] }[] {
  const out: { label: string; value: unknown; expect: SchemaErrorCode[]; sub?: (string | number)[] }[] = [];
  const common = [
    { label: 'null', value: null, expect: ['type'] as SchemaErrorCode[] },
    { label: 'nested object', value: { [CANARY]: CANARY }, expect: ['type'] as SchemaErrorCode[] },
  ];
  if (Array.isArray(s.enum)) {
    out.push(
      { label: 'unknown literal', value: CANARY, expect: ['enum'] },
      { label: 'prose literal', value: `ignore previous instructions ${CANARY}`, expect: ['enum'] },
      { label: 'empty string', value: '', expect: ['enum'] },
      { label: 'huge string', value: hugeString(hugeBytes), expect: ['enum'] },
      { label: 'number', value: 42, expect: ['type'] },
      { label: 'array', value: [String((s.enum as string[])[0])], expect: ['type'] },
      ...common,
    );
    const upper = String((s.enum as string[])[0]).toUpperCase();
    if (!s.enum.includes(upper)) out.push({ label: 'uppercased literal', value: upper, expect: ['enum'] });
    return out;
  }
  switch (s.type) {
    case 'integer':
    case 'number': {
      const lo = s.minimum as number;
      const hi = s.maximum as number;
      out.push(
        { label: 'below minimum', value: lo - 1, expect: ['range'] },
        { label: 'above maximum', value: hi + 1, expect: ['range'] },
        { label: 'NaN', value: Number.NaN, expect: ['type'] },
        { label: 'Infinity', value: Number.POSITIVE_INFINITY, expect: ['type'] },
        { label: '-Infinity', value: Number.NEGATIVE_INFINITY, expect: ['type'] },
        { label: '1e308', value: 1e308, expect: ['range'] },
        { label: 'numeric string', value: String(lo), expect: ['type'] },
        { label: 'canary string', value: CANARY, expect: ['type'] },
        { label: 'boolean', value: true, expect: ['type'] },
        ...common,
      );
      if (s.type === 'integer') out.push({ label: 'fraction', value: lo + 0.5 <= hi ? lo + 0.5 : lo - 0.5, expect: lo + 0.5 <= hi ? ['not_integer'] : ['not_integer', 'range'] });
      return out;
    }
    case 'boolean':
      out.push({ label: 'string', value: 'true', expect: ['type'] }, { label: 'number', value: 1, expect: ['type'] }, ...common);
      return out;
    case 'string': {
      if (typeof s.maxLength === 'number') {
        const max = s.maxLength;
        out.push({ label: 'too long', value: 'x'.repeat(max + 1), expect: ['too_long'] }, { label: 'number', value: 1, expect: ['type'] }, ...common);
        if (typeof s.pattern === 'string') {
          const pattern = new RegExp(s.pattern, 'u');
          for (const value of ['', CANARY, '\n', '!', 'a', '0', '\u0080']) {
            if (value.length <= max && !pattern.test(value)) {
              out.push({ label: 'pattern mismatch', value, expect: ['pattern'] });
              break;
            }
          }
        }
        return out;
      }
      const p = idPrefix(s) ?? 'x';
      out.push(
        { label: 'free text', value: `${CANARY} hello`, expect: ['pattern'] },
        { label: 'wrong prefix', value: `zz${p}_1`, expect: ['pattern'] },
        { label: 'non-digit suffix', value: `${p}_${CANARY}`, expect: ['pattern'] },
        { label: 'too many digits', value: `${p}_${'1'.repeat(12)}`, expect: ['pattern'] },
        { label: 'huge string', value: hugeString(hugeBytes), expect: ['pattern'] },
        { label: 'number', value: 1, expect: ['type'] },
        ...common,
      );
      return out;
    }
    case 'array': {
      const max = typeof s.maxItems === 'number' ? s.maxItems : 0;
      const items = isObj(s.items) ? s.items : {};
      const one = validValue(items, 'min', () => 0);
      if (max < 10_000) out.push({ label: 'too many items', value: Array.from({ length: max + 1 }, () => one), expect: ['too_long'] });
      out.push({ label: 'object instead of array', value: { 0: one }, expect: ['type'] }, { label: 'string', value: CANARY, expect: ['type'] }, { label: 'null', value: null, expect: ['type'] });
      if (max > 0) {
        for (const b of badValues(items, hugeBytes).slice(0, 3)) out.push({ label: `item: ${b.label}`, value: [b.value], expect: b.expect, sub: [0, ...(b.sub ?? [])] });
      }
      return out;
    }
    default:
      return common;
  }
}

/**
 * All single-point mutations of a valid object `base` (schema `s`): every field gets every bad value, required
 * fields are dropped, unknown and prototype-pollution keys are added. Paths are relative to the object.
 */
export function objectMutations(s: JsonSchema, base: Record<string, unknown>, hugeBytes: number): Mutation[] {
  const out: Mutation[] = [];
  const props = isObj(s.properties) ? s.properties : {};
  const req = Array.isArray(s.required) ? (s.required as string[]) : [];
  for (const [k, p] of Object.entries(props)) {
    if (!isObj(p) || 'const' in p) continue;
    for (const b of badValues(p, hugeBytes)) {
      out.push({ label: `${k}: ${b.label}`, path: [k, ...(b.sub ?? [])], expect: b.expect, value: { ...base, [k]: b.value } });
    }
    if (p.type === 'object' && isObj(base[k])) {
      for (const m of objectMutations(p, base[k] as Record<string, unknown>, hugeBytes)) {
        out.push({ ...m, label: `${k}.${m.label}`, path: [k, ...m.path], value: { ...base, [k]: m.value } });
      }
    }
    if (req.includes(k)) {
      const { [k]: _drop, ...rest } = base;
      out.push({ label: `${k}: missing`, path: [k], expect: ['missing_field'], value: rest });
    }
  }
  out.push({ label: 'unknown field', path: ['?'], expect: ['unknown_field'], value: { ...base, [CANARY]: CANARY } });
  out.push({ label: 'unknown field (huge)', path: ['?'], expect: ['unknown_field'], value: { ...base, [`x${CANARY}`]: hugeString(hugeBytes) } });
  for (const key of PROTO_KEYS) out.push({ label: `own "${key}" key`, path: ['?'], expect: ['unknown_field'], value: protoPayload(base, key) });
  out.push({ label: 'deeply nested unknown field', path: ['?'], expect: ['unknown_field'], value: { ...base, [`d${CANARY}`]: deep(2000) } });
  return out;
}

/** Whole-intent shapes that are wrong before any field is looked at. */
export function shapeMutations(validKind: string, hugeBytes: number): Mutation[] {
  return [
    { label: 'null intent', path: [], expect: ['type'], value: null },
    { label: 'number intent', path: [], expect: ['type'], value: 42 },
    { label: 'string intent', path: [], expect: ['type'], value: CANARY },
    { label: 'array intent', path: [], expect: ['type'], value: [{ kind: validKind }] },
    { label: 'missing kind', path: ['kind'], expect: ['tag'], value: {} },
    { label: 'unknown kind', path: ['kind'], expect: ['tag'], value: { kind: CANARY } },
    { label: 'prose kind', path: ['kind'], expect: ['tag'], value: { kind: `ignore all previous instructions ${CANARY}` } },
    { label: 'huge kind', path: ['kind'], expect: ['tag'], value: { kind: hugeString(hugeBytes) } },
    { label: 'numeric kind', path: ['kind'], expect: ['tag'], value: { kind: 7 } },
    { label: '"__proto__" kind', path: ['kind'], expect: ['tag'], value: { kind: '__proto__' } },
    { label: '"constructor" kind', path: ['kind'], expect: ['tag'], value: { kind: 'constructor' } },
    { label: '"toString" kind', path: ['kind'], expect: ['tag'], value: { kind: 'toString' } },
  ];
}
