/**
 * Observation size accounting for `playerthree lint`: exact JSON bytes, estimated LLM tokens.
 */
import type { Fields, Schema } from 'playerthree/schema';

/**
 * Token estimate for JSON text, modelled on modern BPE tokenizers (o200k-class): a word piece per ≤8 lowercase
 * letters (camelCase splits), numbers in ≤3-digit groups, short punctuation runs (`{"`, `":`, `","`) as one token.
 * It is a heuristic: use it to compare designs and budget, not to bill.
 */
const TOKEN_RE = /[A-Z]?[a-z]{1,8}|[A-Z]{1,4}|[0-9]{1,3}|[^A-Za-z0-9\s]{1,3}|\s+/g;

/** Estimated LLM tokens of `text` (see `TOKEN_RE`). */
export function estimateTokens(text: string): number {
  let n = 0;
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.exec(text)) n++;
  return n;
}

export interface Size {
  bytes: number;
  tokens: number;
}

const size = (text: string): Size => ({ bytes: Buffer.byteLength(text), tokens: estimateTokens(text) });
const add = (a: Size, b: Size): Size => ({ bytes: a.bytes + b.bytes, tokens: a.tokens + b.tokens });
const scale = (a: Size, k: number): Size => ({ bytes: a.bytes * k, tokens: a.tokens * k });
const larger = (a: Size, b: Size): Size => (b.bytes > a.bytes || (b.bytes === a.bytes && b.tokens > a.tokens) ? b : a);

/** Longest JSON rendering of any finite double in [min, max]: 17 significant digits plus sign/point/exponent-free form. */
function worstNumber(min: number, max: number): string {
  const mag = Math.max(Math.abs(min), Math.abs(max));
  const intDigits = Math.max(1, Math.floor(mag).toString().length);
  const frac = Math.max(1, 17 - intDigits);
  return `${min < 0 ? '-' : ''}${'9'.repeat(intDigits)}.${'9'.repeat(frac)}`;
}

function worstFields(fields: Fields, extra?: { tag: string; value: string }): Size {
  let total = size('{}');
  let first = true;
  if (extra) {
    total = add(total, size(`${JSON.stringify(extra.tag)}:${JSON.stringify(extra.value)}`));
    first = false;
  }
  for (const [name, s] of Object.entries(fields)) {
    total = add(total, add(size(`${first ? '' : ','}${JSON.stringify(name)}:`), worstCase(s)));
    first = false;
  }
  return total;
}

/**
 * Conservative JSON encoding bound (every optional field present, every array full).
 * Bounded text includes worst-case escaping; integer arrays use exact integer endpoint widths.
 */
export function worstCase(s: Schema): Size {
  switch (s.t) {
    case 'enum':
      return (s.values as readonly string[]).map((v) => size(JSON.stringify(v))).reduce(larger, { bytes: 0, tokens: 0 });
    case 'id':
      return size(`"${s.prefix}_999999999"`);
    case 'str':
      // Control characters and lone surrogates may require six ASCII JSON escape bytes each.
      return { bytes: 2 + 6 * s.maxLength, tokens: 2 + 6 * s.maxLength };
    case 'ints': {
      const width = Math.max(String(s.min).length, String(s.max).length);
      const bytes = s.maxItems === 0 ? 2 : 2 + s.maxItems * width + s.maxItems - 1;
      // Keep integer/punctuation token estimates consistent with the equivalent generic list.
      return s.maxItems === 0 ? size('[]') : {
        bytes,
        tokens: 1 + s.maxItems * Math.max(estimateTokens(String(s.min)), estimateTokens(String(s.max))) + s.maxItems - 1,
      };
    }
    case 'int':
      return [size(String(s.min)), size(String(s.max))].reduce(larger);
    case 'num':
      return size(worstNumber(s.min, s.max));
    case 'bool':
      return size('false');
    case 'list':
      return s.max === 0 ? size('[]') : add(size('[]'), add(scale(worstCase(s.item), s.max), scale(size(','), s.max - 1)));
    case 'obj':
      return worstFields(s.fields);
    case 'opt':
      return worstCase(s.item);
    case 'union':
      return Object.entries(s.variants as Record<string, Fields>)
        .map(([name, fields]) => worstFields(fields, { tag: s.tag, value: name }))
        .reduce(larger, { bytes: 0, tokens: 0 });
  }
}

export { size as measure };
