/**
 * Structural deltas between two JSON values, for streams of full-state frames (observer playback).
 *
 * Consecutive projections share almost everything (terrain, rules, idle entities). `diff` encodes only what changed;
 * `patch` rebuilds the next value from the previous one with structural sharing, so unchanged subtrees keep their
 * identity and are never serialized or shipped again. Game-agnostic: arrays whose elements are all objects with a
 * unique string/number `id` are matched by id (entity lists), every other array by index.
 *
 * Values are JSON: `undefined` object members are absent, and every value a delta carries is detached from `next`.
 */
export type JsonPrimitive = null | boolean | number | string;
export type JsonDelta =
  /** Replace the whole value. */
  | { s: unknown }
  /** Array of objects keyed by `id`: changed or new elements by id; `i` is the new id order when membership or order changed. */
  | { k: 1; i?: (string | number)[]; u?: Record<string, JsonDelta> }
  /** Array by index: new length, primitive replacements as flat `[index, value, …]` pairs, nested deltas by index. */
  | { n: number; x?: unknown[]; p?: Record<string, JsonDelta> }
  /** Object: new primitive member values, nested member deltas, removed member names. */
  | { v?: Record<string, JsonPrimitive>; o?: Record<string, JsonDelta>; d?: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Detached JSON copy (drops `undefined` members exactly as the wire would). */
function detach(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;
}

/** Element ids when every element is an object with a unique string/number `id`; otherwise undefined. */
function ids(list: readonly unknown[]): (string | number)[] | undefined {
  const out: (string | number)[] = new Array(list.length);
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!isObject(item)) return undefined;
    const id = item.id;
    if (typeof id !== 'string' && typeof id !== 'number') return undefined;
    const key = String(id);
    if (seen.has(key)) return undefined;
    seen.add(key);
    out[i] = id;
  }
  return out;
}

function diffArray(prev: readonly unknown[], next: readonly unknown[]): JsonDelta | undefined {
  const nextIds = next.length > 0 ? ids(next) : undefined;
  const prevIds = nextIds && ids(prev);
  if (nextIds && prevIds) {
    const byId = new Map<string, unknown>();
    for (let i = 0; i < prev.length; i++) byId.set(String(prevIds[i]), prev[i]);
    let u: Record<string, JsonDelta> | undefined;
    let reordered = prev.length !== next.length;
    for (let i = 0; i < next.length; i++) {
      const key = String(nextIds[i]);
      if (!reordered && String(prevIds[i]) !== key) reordered = true;
      const before = byId.get(key);
      const change = before === undefined ? { s: detach(next[i]) } : diff(before, next[i]);
      if (change) (u ??= {})[key] = change;
    }
    if (!reordered && !u) return undefined;
    return { k: 1, ...(reordered ? { i: nextIds } : {}), ...(u ? { u } : {}) };
  }
  let x: unknown[] | undefined;
  let p: Record<string, JsonDelta> | undefined;
  let changed = 0;
  for (let i = 0; i < next.length; i++) {
    const item = next[i];
    const change = i < prev.length ? diff(prev[i], item) : { s: detach(item) };
    if (!change) continue;
    changed++;
    if ('s' in change && (typeof change.s !== 'object' || change.s === null)) (x ??= []).push(i, change.s);
    else (p ??= {})[i] = change;
  }
  if (!changed && prev.length === next.length) return undefined;
  // Mostly rewritten: the whole array is smaller than per-index edits.
  if (next.length > 8 && changed * 2 > next.length) return { s: detach(next) };
  return { n: next.length, ...(x ? { x } : {}), ...(p ? { p } : {}) };
}

/** The delta from `prev` to `next`, or undefined when they are equal JSON. Never mutates or retains either argument. */
export function diff(prev: unknown, next: unknown): JsonDelta | undefined {
  if (prev === next) return undefined;
  if (Array.isArray(next)) return Array.isArray(prev) ? diffArray(prev, next) : { s: detach(next) };
  if (!isObject(next)) return { s: next };
  if (!isObject(prev)) return { s: detach(next) };
  let v: Record<string, JsonPrimitive> | undefined;
  let o: Record<string, JsonDelta> | undefined;
  let d: string[] | undefined;
  for (const key in next) {
    const value = next[key];
    if (value === undefined) continue;
    const change = diff(prev[key], value);
    if (!change) continue;
    if ('s' in change && (typeof change.s !== 'object' || change.s === null)) (v ??= {})[key] = change.s as JsonPrimitive;
    else (o ??= {})[key] = change;
  }
  for (const key in prev) if (prev[key] !== undefined && next[key] === undefined) (d ??= []).push(key);
  if (!v && !o && !d) return undefined;
  return { ...(v ? { v } : {}), ...(o ? { o } : {}), ...(d ? { d } : {}) };
}

/** `prev` with `delta` applied. `prev` is not mutated; unchanged subtrees are shared with it. */
export function patch(prev: unknown, delta: JsonDelta): unknown {
  if ('s' in delta) return delta.s;
  if ('k' in delta) {
    const list = Array.isArray(prev) ? prev as Record<string, unknown>[] : [];
    const u = delta.u;
    if (!delta.i) return u ? list.map((item) => {
      const change = u[String(item.id)];
      return change ? patch(item, change) : item;
    }) : list.slice();
    const byId = new Map<string, unknown>();
    for (const item of list) byId.set(String(item.id), item);
    return delta.i.map((id) => {
      const key = String(id);
      const change = u?.[key];
      const before = byId.get(key);
      if (change) return patch(before, change);
      if (before === undefined) throw new Error('playerthree/delta: missing keyed element');
      return before;
    });
  }
  if ('n' in delta) {
    const out = Array.isArray(prev) ? prev.slice(0, delta.n) : [];
    if (delta.x) for (let i = 0; i < delta.x.length; i += 2) out[delta.x[i] as number] = delta.x[i + 1];
    if (delta.p) for (const index in delta.p) out[Number(index)] = patch(out[Number(index)], delta.p[index]!);
    if (out.length !== delta.n) throw new Error('playerthree/delta: sparse array');
    return out;
  }
  const out: Record<string, unknown> = isObject(prev) ? { ...prev } : {};
  if (delta.d) for (const key of delta.d) delete out[key];
  if (delta.v) for (const key in delta.v) out[key] = delta.v[key];
  if (delta.o) for (const key in delta.o) out[key] = patch(out[key], delta.o[key]!);
  return out;
}
