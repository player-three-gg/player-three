/**
 * Observation pages for game_observe. Large games (hundreds of units per seat) produce observations far beyond what a
 * harness keeps of one tool result, so an oversize observation is split into pages of whole JSON: keys in schema order,
 * plain nested objects split by key, lists split by items. Each page is a partial observation with the same shape
 * (see surface.ts `partialSchema`); policies and bots are unaffected (they get the object directly).
 */
import type { JsonSchema } from '../schema.ts';

/** One page: a partial observation, plus `[from, to)` item ranges (of `of`) of the lists it holds only part of. */
export interface ObservationPage {
  observation: Record<string, unknown>;
  items?: Record<string, { from: number; to: number; of: number }>;
}

interface Part {
  path: string[];
  value: unknown;
  range?: { from: number; to: number; of: number };
  size: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** JSON size of a part inside a page: its value plus the keys leading to it (and their punctuation). */
const partSize = (path: string[], json: number): number => json + path.reduce((n, k) => n + k.length + 4, 0);

function split(value: unknown, schema: JsonSchema | undefined, path: string[], budget: number, out: Part[]): void {
  const json = JSON.stringify(value).length;
  if (partSize(path, json) <= budget) {
    out.push({ path, value, size: partSize(path, json) });
    return;
  }
  if (Array.isArray(value) && path.length > 0) {
    // Items stay whole: a single item larger than the budget gets a page of its own.
    let from = 0;
    let size = partSize(path, 2);
    for (let i = 0; i < value.length; i++) {
      const item = JSON.stringify(value[i]).length + 1;
      if (i > from && size + item > budget) {
        out.push({ path, value: value.slice(from, i), range: { from, to: i, of: value.length }, size });
        from = i;
        size = partSize(path, 2);
      }
      size += item;
    }
    out.push({ path, value: value.slice(from), range: { from, to: value.length, of: value.length }, size });
    return;
  }
  const properties = schema?.type === 'object' && !schema.oneOf ? (schema.properties as Record<string, JsonSchema> | undefined) : undefined;
  if (isPlainObject(value) && properties) {
    // Schema order (the guard's output order), so page 1 starts with the observation's leading fields.
    for (const key of Object.keys(properties)) if (Object.hasOwn(value, key)) split(value[key], properties[key], [...path, key], budget, out);
    return;
  }
  out.push({ path, value, size: partSize(path, json) });
}

function place(target: Record<string, unknown>, part: Part): void {
  let node = target;
  for (const key of part.path.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[part.path.at(-1) as string] = part.value;
}

/**
 * Pages of `observation` whose JSON each fits `budget` code units (except an indivisible item larger than the budget).
 * One page when it already fits.
 */
export function pageObservation(observation: unknown, schema: JsonSchema, budget: number): ObservationPage[] {
  if (!isPlainObject(observation)) return [{ observation: observation as Record<string, unknown> }];
  const parts: Part[] = [];
  split(observation, schema, [], budget, parts);
  if (parts.length === 1 && parts[0]!.path.length === 0) return [{ observation }];
  const pages: ObservationPage[] = [];
  let current: ObservationPage | undefined;
  let size = 0;
  for (const part of parts) {
    if (!current || size + part.size > budget) {
      current = { observation: {} };
      pages.push(current);
      size = 2;
    }
    place(current.observation, part);
    if (part.range) (current.items ??= {})[part.path.join('.')] = part.range;
    size += part.size + 1;
  }
  return pages;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) mergeInto(current, value);
    else if (Array.isArray(current) && Array.isArray(value)) target[key] = [...current, ...value];
    else target[key] = value;
  }
}

/** Reassemble a full observation from all its pages, in page order (inverse of `pageObservation`). */
export function mergeObservationPages(pages: readonly { observation: Record<string, unknown> }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const page of pages) mergeInto(out, structuredClone(page.observation));
  return out;
}