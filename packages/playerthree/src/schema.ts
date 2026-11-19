/**
 * Bounded, closed-shape schema DSL.
 *
 * Enum literals and ids remain closed vocabulary. Bounded strings explicitly admit trusted text;
 * their provenance must exclude third-party player text. No arbitrary JSON or unbounded string node exists.
 */

export interface EnumS<V extends readonly string[] = readonly string[]> {
  readonly t: 'enum';
  readonly values: V;
  readonly doc?: string;
}
export interface IdS {
  readonly t: 'id';
  readonly prefix: string;
  readonly doc?: string;
}
/** Trusted text, bounded in Unicode code points (the JSON Schema maxLength unit). */
export interface StrS {
  readonly t: 'str';
  readonly maxLength: number;
  readonly pattern?: string;
  readonly doc?: string;
}
/** A flat bounded integer array; no per-item schema is serialized. */
export interface IntsS {
  readonly t: 'ints';
  readonly maxItems: number;
  readonly min: number;
  readonly max: number;
  readonly doc?: string;
}
export interface IntS {
  readonly t: 'int';
  readonly min: number;
  readonly max: number;
  readonly doc?: string;
}
export interface NumS {
  readonly t: 'num';
  readonly min: number;
  readonly max: number;
  readonly doc?: string;
}
export interface BoolS {
  readonly t: 'bool';
  readonly doc?: string;
}
export interface ListS<I extends Schema = Schema> {
  readonly t: 'list';
  readonly item: I;
  readonly max: number;
  readonly doc?: string;
}
export interface ObjS<F extends Fields = Fields> {
  readonly t: 'obj';
  readonly fields: F;
  readonly doc?: string;
  /** Atomic replacement when this object appears in layered match options. */
  readonly merge?: 'replace';
}
/** Optional field marker. Only meaningful as a direct child of `obj` / `union` variant fields. */
export interface OptS<I extends Schema = Schema> {
  readonly t: 'opt';
  readonly item: I;
}
export interface UnionS<Tag extends string = string, V extends Record<string, Fields> = Record<string, Fields>> {
  readonly t: 'union';
  readonly tag: Tag;
  readonly variants: V;
  readonly doc?: string;
}

/** Named fields of an object schema or union variant. */
export type Fields = { readonly [k: string]: Schema };
/** Any schema node built with {@link t}. */
export type Schema = EnumS | IdS | StrS | IntS | IntsS | NumS | BoolS | ListS<any> | ObjS<any> | OptS<any> | UnionS<string, any>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OptKeys<F> = { [K in keyof F]: F[K] extends OptS<any> ? K : never }[keyof F];
type InferFields<F> = Simplify<
  { -readonly [K in Exclude<keyof F, OptKeys<F>>]: Infer<F[K]> } & {
    -readonly [K in OptKeys<F>]?: F[K] extends OptS<infer I> ? Infer<I> : never;
  }
>;

/** `any` in (e.g. `AnyManifest`) → `any` out; without this guard `Infer<any>` expands every branch forever. */
type IsAny<S> = 0 extends 1 & S ? true : false;

/** The TypeScript type of values a schema accepts. */
export type Infer<S> = IsAny<S> extends true
  ? any
  : S extends EnumS<infer V>
  ? V[number]
  : S extends IdS | StrS
    ? string
    : S extends IntS | NumS
      ? number
      : S extends BoolS
        ? boolean
        : S extends IntsS
          ? number[]
        : S extends ListS<infer I>
          ? Infer<I>[]
          : S extends ObjS<infer F>
            ? InferFields<F>
            : S extends OptS<infer I>
              ? Infer<I> | undefined
              : S extends UnionS<infer Tag, infer V>
                ? { [K in keyof V & string]: Simplify<{ -readonly [T in Tag]: K } & InferFields<V[K]>> }[keyof V & string]
                : never;

const ENUM_LITERAL = /^[A-Za-z][A-Za-z0-9_.<>]{0,47}$/;
const ID_PREFIX = /^[a-z]{1,8}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

function assertFields(fields: Fields): void {
  for (const k of Object.keys(fields)) {
    if (!FIELD_NAME.test(k)) throw new Error(`playerthree/schema: invalid field name ${JSON.stringify(k)}`);
  }
}
/** Counts surrogate pairs once and lone surrogates once, without allocating an array. */
export function codePointLength(value: string): number {
  let length = 0;
  for (let i = 0; i < value.length; i++, length++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
  }
  return length;
}

const MAX_STRING_LENGTH = 100_000;
const ESCAPES = 'dDwWsSnrt\\^$.*+?()[]{}|/-';

function checkBoundedDoc(doc: unknown): void {
  if (doc !== undefined && (typeof doc !== 'string' || doc.length > 4000)) throw new Error('playerthree/schema: doc must be at most 4000 UTF-16 code units');
}

/**
 * Linear-time regex subset: a sequence of fixed-width atoms, with optional variable repetition
 * on the last atom only. No branches, groups, backreferences, or ambiguous repeated partitions.
 */
function checkPattern(pattern: string): void {
  const bad = (): never => { throw new Error('playerthree/schema: pattern must use the bounded anchored safe regex subset'); };
  if (typeof pattern !== 'string' || pattern.length < 2 || pattern.length > 256 || !/^[\x20-\x7e]+$/.test(pattern) || pattern[0] !== '^' || pattern.at(-1) !== '$') bad();
  const end = pattern.length - 1;
  let i = 1;
  const escape = (): void => {
    i++;
    if (i >= end || !ESCAPES.includes(pattern[i]!)) bad();
    i++;
  };
  while (i < end) {
    const c = pattern[i]!;
    if (c === '\\') escape();
    else if (c === '[') {
      i++;
      if (pattern[i] === '^') i++;
      const start = i;
      while (i < end && pattern[i] !== ']') {
        if (pattern[i] === '\\') escape();
        else {
          if (pattern[i] === '[') bad();
          i++;
        }
      }
      if (i === start || i >= end) bad();
      i++;
    } else {
      if ('^$*+?(){}|]'.includes(c)) bad();
      i++;
    }
    const q = pattern[i];
    if (q === '*' || q === '+' || q === '?') {
      if (++i !== end) bad();
    } else if (q === '{') {
      const match = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(pattern.slice(i, end));
      if (!match) bad();
      const lo = Number(match![1]);
      const hi = match![2] === undefined ? lo : match![2] === '' ? MAX_STRING_LENGTH : Number(match![2]);
      if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo > hi || hi > MAX_STRING_LENGTH) bad();
      i += match![0].length;
      if (match![2] !== undefined && i !== end) bad();
    }
  }
  try { new RegExp(pattern, 'u'); } catch { bad(); }
}

/** `$` alone also matches before a final newline; the export must require the actual end. */
function strictPattern(pattern: string): string {
  return `${pattern}(?![\\s\\S])`;
}

const stringPatterns = new WeakMap<StrS, RegExp>();

function matchesString(s: StrS, value: string): boolean {
  if (s.pattern === undefined) return true;
  let pattern = stringPatterns.get(s);
  if (!pattern) {
    pattern = new RegExp(strictPattern(s.pattern), 'u');
    stringPatterns.set(s, pattern);
  }
  return pattern.test(value);
}

/** Schema node constructors. Each validates its own bounds when called, so an unsafe schema fails at definition time. */
export const t = {
  enum<const V extends readonly [string, ...string[]]>(values: V, doc?: string): EnumS<V> {
    for (const v of values) {
      if (!ENUM_LITERAL.test(v)) throw new Error(`playerthree/schema: enum literal must match ${ENUM_LITERAL}: ${JSON.stringify(v)}`);
    }
    if (new Set(values).size !== values.length) throw new Error('playerthree/schema: duplicate enum literal');
    return { t: 'enum', values, doc };
  },
  id(prefix: string, doc?: string): IdS {
    if (!ID_PREFIX.test(prefix)) throw new Error(`playerthree/schema: id prefix must match ${ID_PREFIX}`);
    return { t: 'id', prefix, doc };
  },
  str(maxLength: number, pattern?: string, doc?: string): StrS {
    if (!Number.isSafeInteger(maxLength) || maxLength < 0 || maxLength > MAX_STRING_LENGTH) throw new Error('playerthree/schema: bad string maxLength (0..100000 Unicode code points)');
    if (pattern !== undefined) checkPattern(pattern);
    checkBoundedDoc(doc);
    return { t: 'str', maxLength, pattern, doc };
  },
  ints(maxItems: number, min: number, max: number, doc?: string): IntsS {
    if (!Number.isSafeInteger(maxItems) || maxItems < 0) throw new Error('playerthree/schema: bad ints maxItems');
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) throw new Error('playerthree/schema: bad ints range');
    checkBoundedDoc(doc);
    return { t: 'ints', maxItems, min, max, doc };
  },
  int(min: number, max: number, doc?: string): IntS {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) throw new Error('playerthree/schema: bad int range');
    return { t: 'int', min, max, doc };
  },
  num(min: number, max: number, doc?: string): NumS {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error('playerthree/schema: bad num range');
    return { t: 'num', min, max, doc };
  },
  bool(doc?: string): BoolS {
    return { t: 'bool', doc };
  },
  list<I extends Schema>(item: I, max: number, doc?: string): ListS<I> {
    if (!Number.isSafeInteger(max) || max < 0) throw new Error('playerthree/schema: bad list max');
    return { t: 'list', item, max, doc };
  },
  obj<const F extends Fields>(fields: F, doc?: string, options?: { readonly merge?: 'replace' }): ObjS<F> {
    assertFields(fields);
    if (options?.merge !== undefined && options.merge !== 'replace') throw new Error('playerthree/schema: bad object merge mode');
    return { t: 'obj', fields, doc, ...(options?.merge === undefined ? {} : { merge: options.merge }) };
  },
  opt<I extends Schema>(item: I): OptS<I> {
    return { t: 'opt', item };
  },
  union<const Tag extends string, const V extends Record<string, Fields>>(tag: Tag, variants: V, doc?: string): UnionS<Tag, V> {
    if (!FIELD_NAME.test(tag)) throw new Error('playerthree/schema: invalid union tag');
    for (const [name, fields] of Object.entries(variants)) {
      if (!ENUM_LITERAL.test(name)) throw new Error(`playerthree/schema: union variant must match ${ENUM_LITERAL}: ${JSON.stringify(name)}`);
      if (Object.hasOwn(fields, tag)) throw new Error('playerthree/schema: variant fields must not redeclare the tag');
      assertFields(fields);
    }
    return { t: 'union', tag, variants, doc };
  },
} as const;

/** Closed set of validation failure codes. Never echoes input. */
export type SchemaErrorCode =
  | 'type'
  | 'enum'
  | 'range'
  | 'not_integer'
  | 'pattern'
  | 'too_long'
  | 'unknown_field'
  | 'missing_field'
  | 'tag';

/** Path segments are schema field names (developer-defined) or list indices — never input text. */
export type SchemaPath = (string | number)[];

/** Validation result: the value, or a closed error code and the schema path where it failed (never the input). */
export type ValidateResult<T> = { ok: true; value: T } | { ok: false; code: SchemaErrorCode; path: SchemaPath };

class Fail {
  readonly code: SchemaErrorCode;
  readonly path: SchemaPath;
  /** `path` is the validator's live stack: copy it, then add the failing segment if any. */
  constructor(code: SchemaErrorCode, path: SchemaPath, last?: string | number) {
    this.code = code;
    this.path = last === undefined ? path.slice() : [...path, last];
  }
}

const hasOwn = Object.prototype.hasOwnProperty;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Outbound guards validate every view at the tick rate: the path is one mutable stack (push/pop), copied only on
// failure, and object members are walked without key/entry arrays.
function checkFields(fields: Fields, v: Record<string, unknown>, path: SchemaPath, skip?: string): void {
  for (const k in v) {
    if (k === skip || !hasOwn.call(v, k)) continue;
    if (!hasOwn.call(fields, k)) throw new Fail('unknown_field', path, '?');
  }
  for (const k in fields) {
    if (!hasOwn.call(fields, k)) continue;
    const s = fields[k]!;
    const fv = hasOwn.call(v, k) ? v[k] : undefined;
    if (s.t === 'opt') {
      if (fv === undefined) continue;
      path.push(k);
      check(s.item, fv, path);
      path.pop();
    } else {
      if (fv === undefined) throw new Fail('missing_field', path, k);
      path.push(k);
      check(s, fv, path);
      path.pop();
    }
  }
}

function check(s: Schema, v: unknown, path: SchemaPath): void {
  switch (s.t) {
    case 'enum':
      if (typeof v !== 'string') throw new Fail('type', path);
      if (!s.values.includes(v)) throw new Fail('enum', path);
      return;
    case 'id': {
      if (typeof v !== 'string') throw new Fail('type', path);
      const p = s.prefix.length;
      if (v.length < p + 2 || v.length > p + 10 || !v.startsWith(s.prefix) || v[p] !== '_') throw new Fail('pattern', path);
      for (let i = p + 1; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c < 48 || c > 57) throw new Fail('pattern', path);
      }
      return;
    }
    case 'str':
      if (typeof v !== 'string') throw new Fail('type', path);
      if (codePointLength(v) > s.maxLength) throw new Fail('too_long', path);
      if (!matchesString(s, v)) throw new Fail('pattern', path);
      return;
    case 'ints':
      if (!Array.isArray(v)) throw new Fail('type', path);
      if (v.length > s.maxItems) throw new Fail('too_long', path);
      for (let i = 0; i < v.length; i++) {
        const item: unknown = v[i];
        if (typeof item !== 'number' || !Number.isFinite(item)) throw new Fail('type', path, i);
        if (!Number.isInteger(item)) throw new Fail('not_integer', path, i);
        if (item < s.min || item > s.max) throw new Fail('range', path, i);
      }
      return;
    case 'int':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Fail('type', path);
      if (!Number.isInteger(v)) throw new Fail('not_integer', path);
      if (v < s.min || v > s.max) throw new Fail('range', path);
      return;
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Fail('type', path);
      if (v < s.min || v > s.max) throw new Fail('range', path);
      return;
    case 'bool':
      if (typeof v !== 'boolean') throw new Fail('type', path);
      return;
    case 'list':
      if (!Array.isArray(v)) throw new Fail('type', path);
      if (v.length > s.max) throw new Fail('too_long', path);
      for (let i = 0; i < v.length; i++) {
        path.push(i);
        check(s.item, v[i], path);
        path.pop();
      }
      return;
    case 'obj':
      if (!isPlainObject(v)) throw new Fail('type', path);
      checkFields(s.fields, v, path);
      return;
    case 'opt':
      if (v !== undefined) check(s.item, v, path);
      return;
    case 'union': {
      if (!isPlainObject(v)) throw new Fail('type', path);
      const tag = v[s.tag];
      if (typeof tag !== 'string' || !hasOwn.call(s.variants, tag)) throw new Fail('tag', path, s.tag);
      checkFields(s.variants[tag] as Fields, v, path, s.tag);
      return;
    }
  }
}

/** Strict validation: rejects unknown fields, non-finite numbers, non-plain objects and out-of-bound data. */
export function validate<S extends Schema>(schema: S, value: unknown): ValidateResult<Infer<S>> {
  try {
    check(schema, value, []);
    return { ok: true, value: value as Infer<S> };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, code: e.code, path: e.path };
    throw e;
  }
}

/** A JSON Schema document as emitted by `toJsonSchema` (opaque to TypeScript). */
export type JsonSchema = { [k: string]: unknown };

/** JSON Schema (draft 2020-12 subset) for tool definitions. Only developer-declared text is emitted. */
export function toJsonSchema(s: Schema): JsonSchema {
  const withDoc = (o: JsonSchema, doc?: string): JsonSchema => (doc ? { ...o, description: doc } : o);
  const fieldsToProps = (fields: Fields): { properties: Record<string, JsonSchema>; required: string[] } => {
    const properties: Record<string, JsonSchema> = Object.create(null);
    const required: string[] = [];
    for (const [k, f] of Object.entries(fields)) {
      if (f.t === 'opt') properties[k] = toJsonSchema(f.item);
      else {
        properties[k] = toJsonSchema(f);
        required.push(k);
      }
    }
    return { properties, required };
  };
  switch (s.t) {
    case 'enum':
      return withDoc({ type: 'string', enum: [...s.values] }, s.doc);
    case 'id':
      return withDoc({ type: 'string', pattern: `^${s.prefix}_[0-9]{1,9}$` }, s.doc);
    case 'str':
      return withDoc({ type: 'string', maxLength: s.maxLength, ...(s.pattern === undefined ? {} : { pattern: strictPattern(s.pattern) }) }, s.doc);
    case 'ints':
      return withDoc({ type: 'array', maxItems: s.maxItems, items: { type: 'integer', minimum: s.min, maximum: s.max } }, s.doc);
    case 'int':
      return withDoc({ type: 'integer', minimum: s.min, maximum: s.max }, s.doc);
    case 'num':
      return withDoc({ type: 'number', minimum: s.min, maximum: s.max }, s.doc);
    case 'bool':
      return withDoc({ type: 'boolean' }, s.doc);
    case 'list':
      return withDoc({ type: 'array', items: toJsonSchema(s.item), maxItems: s.max }, s.doc);
    case 'obj':
      return withDoc({ type: 'object', ...fieldsToProps(s.fields), additionalProperties: false, ...(s.merge === undefined ? {} : { 'x-playerthree-merge': s.merge }) }, s.doc);
    case 'opt':
      return toJsonSchema(s.item);
    case 'union':
      return withDoc(
        {
          oneOf: Object.entries(s.variants as Record<string, Fields>).map(([name, fields]) => {
            const { properties, required } = fieldsToProps(fields);
            return {
              type: 'object',
              properties: { [s.tag]: { const: name }, ...properties },
              required: [s.tag, ...required],
              additionalProperties: false,
            };
          }),
        },
        s.doc,
      );
  }
}

/**
 * Bounds a TypeScript type cannot carry, as one phrase (empty for unconstrained nodes): JSDoc on generated fields and
 * the parenthesised note of an invalid ack's `expected`.
 */
export function schemaBoundNote(s: Schema): string {
  switch (s.t) {
    case 'int':
      return `integer ${s.min}..${s.max}`;
    case 'num':
      return `${s.min}..${s.max}`;
    case 'str':
      return `at most ${s.maxLength} code points${s.pattern === undefined ? '' : `, pattern ${s.pattern}`}`;
    case 'ints':
      return `at most ${s.maxItems} integers, each ${s.min}..${s.max}`;
    case 'list': {
      const item = s.item.t === 'list' || s.item.t === 'obj' || s.item.t === 'union' ? '' : schemaBoundNote(s.item);
      return `at most ${s.max} items${item ? `, each ${item}` : ''}`;
    }
    case 'opt':
      return schemaBoundNote(s.item);
    default:
      return '';
  }
}

/**
 * Static developer text as one JSDoc line (`indent` first, newline last; empty text → empty string). Newlines collapse
 * to spaces so a comment never spans page breaks, and `*\/` inside the text must not close the comment.
 */
export function tsDocComment(text: string | undefined, indent = ''): string {
  const line = (text ?? '').replaceAll('*/', '*\\/').replace(/\s*\n\s*/g, ' ').trim();
  return line ? `${indent}/** ${line} */\n` : '';
}

/**
 * How much text generated TypeScript carries: `full` puts developer docs and bound notes in JSDoc above each field;
 * `bounds` drops the prose and keeps only the bound notes, as a trailing `//` comment (compact enough to serve the
 * declarations of a large game as briefing topics).
 */
export type TsDocs = 'full' | 'bounds';

function jsDoc(s: Schema, indent: string): string {
  const doc = s.t === 'opt' ? s.item.doc : s.doc;
  return tsDocComment([doc, schemaBoundNote(s)].filter((x) => x).join(' — '), indent);
}

/** Longest single-line union, and the width wrapped union lines are packed to, in code units (keeps lines pageable). */
const UNION_LINE_MAX = 100;

/**
 * A union of type expressions (`never` when empty): one line when it fits UNION_LINE_MAX, else starting on a new line
 * with members packed into lines of at most that width, each continuation line led by `| ` (`indent` + two spaces).
 */
export function tsUnion(members: readonly string[], indent = ''): string {
  if (members.length === 0) return 'never';
  const line = members.join(' | ');
  if (line.length <= UNION_LINE_MAX) return line;
  const lines: string[] = [];
  let current = '';
  for (const member of members) {
    if (current && current.length + 3 + member.length > UNION_LINE_MAX) {
      lines.push(current);
      current = member;
    } else current = current ? `${current} | ${member}` : member;
  }
  lines.push(current);
  return lines.map((l) => `\n${indent}  | ${l}`).join('');
}

function fieldsToTs(fields: Fields, indent: string, docs: TsDocs, tag?: readonly [string, string]): string {
  const inner = `${indent}  `;
  const lines: string[] = tag ? [`${inner}${tag[0]}: ${JSON.stringify(tag[1])};`] : [];
  for (const [k, f] of Object.entries(fields)) {
    const optional = f.t === 'opt';
    const type = schemaToTs(optional ? f.item : f, inner, docs);
    const bounds = docs === 'bounds' ? schemaBoundNote(f) : '';
    // A long literal union starts on its own line (wrapped, `| `-led lines): no space after the colon then.
    lines.push(`${docs === 'full' ? jsDoc(f, inner) : ''}${inner}${k}${optional ? '?' : ''}:${type.startsWith('\n') ? '' : ' '}${type};${bounds ? ` // ${bounds}` : ''}`);
  }
  // `{}` would accept any non-nullish value; a closed empty object accepts no members.
  return lines.length === 0 ? 'Record<string, never>' : `{\n${lines.join('\n')}\n${indent}}`;
}

/**
 * TypeScript type expression for a schema node: the source text of `Infer<S>`, with the bounds a type cannot carry
 * (ranges, lengths, patterns) and, with `docs: 'full'`, developer docs as comments on object fields. `indent` prefixes
 * continuation lines. Only developer-declared text is emitted.
 */
export function schemaToTs(s: Schema, indent = '', docs: TsDocs = 'full'): string {
  switch (s.t) {
    case 'enum':
      return tsUnion(s.values.map((v) => JSON.stringify(v)), indent);
    case 'id':
      return `\`${s.prefix}_\${number}\``;
    case 'str':
      return 'string';
    case 'int':
    case 'num':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'ints':
      return 'number[]';
    case 'list': {
      const item = schemaToTs(s.item, indent, docs);
      const plain = s.item.t !== 'union' && !(s.item.t === 'enum' && s.item.values.length > 1);
      return plain ? `${item}[]` : `(${item})[]`;
    }
    case 'obj':
      return fieldsToTs(s.fields, indent, docs);
    case 'opt':
      return `${schemaToTs(s.item, indent, docs)} | undefined`;
    case 'union':
      return Object.entries(s.variants as Record<string, Fields>)
        .map(([name, fields]) => fieldsToTs(fields, indent, docs, [s.tag, name]))
        .join(` | `);
  }
}
