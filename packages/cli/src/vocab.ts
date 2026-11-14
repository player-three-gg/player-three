/**
 * Vocabulary/key check for agent results. Explicit bounded-string positions additionally accept values
 * conforming to that position's schema, never a global regex/text exemption. Own policy text is separate. An invalid
 * ack's `expected` is generated text, accepted only when every token is declared vocabulary (see `expectedKnown`).
 */
import { intentTypeNames } from 'playerthree';
import type { JsonSchema } from './fuzz.ts';
import type { SeatSurface } from './seat-surface.ts';
import { nonConformance } from './conforms.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every literal PlayerThree itself may put into a control-plane response. */
const PROTOCOL_WORDS = [
  // IntentAck, SchemaErrorCode, PolicyErrorCode, ServerErrorCode, outcomes, runtimes, controllers
  'invalid', 'forbidden_role', 'rate_limited', 'not_controller', 'game_over', 'game', 'internal',
  'type', 'enum', 'range', 'not_integer', 'pattern', 'too_long', 'unknown_field', 'missing_field', 'tag',
  'runtime_not_allowed', 'too_large', 'compile', 'missing_export', 'bad_module', 'imports_not_allowed', 'memory_limit',
  'timeout', 'threw', 'bad_output',
  'bad_message', 'bad_token', 'forbidden', 'mode_unavailable', 'busy', 'not_in_match',
  'win', 'loss', 'draw', 'running', 'lobby', 'match', 'js', 'wasm', 'human', 'agent', 'policy', 'bot', 'none',
  'out_of_scope', 'approval_not_found', 'approval_pending', 'approval_failed',
  'autonomous', 'supervised', 'hold', 'pause', 'act', 'practice', 'publish', 'say',
  'policyDeploy', 'policyRollback', 'pending', 'approved', 'rejected', 'failed', 'approval', 'owner_message',
  // response field names
  'ok', 'code', 'schemaCode', 'path', 'expected', 'gameCode', 'tick', 'outcome', 'events', 'version', 'probe', 'calls', 'timeouts',
  'errors', 'meanMs', 'maxMs', 'intentsEmitted', 'intentsRejected', 'lastInvalid', 'count', 'lastError', 'logs', 'message', 'runtime',
  'error', 'report', 'ticks', 'wallMs', 'policyId', 'phase', '?',
  // policy build failure detail (spec §11)
  'location', 'file', 'line', 'column',
  'scopes', 'mandate', 'autonomy', 'directive', 'limits', 'whenAbsent', 'id', 'kind', 'status', 'acks', 'wake',
  // paged results (game_briefing topics, game_skill windows, game_observe pages, policy_export package pages)
  'topic', 'page', 'pages', 'text', 'next', 'name', 'offset', 'total', 'items', 'from', 'to', 'of',
  // policy packages (policy_export / policy_import)
  'hash', 'bytes', 'stale',
  // starter references (spec §11 Starters): policy_status `from` / `knobs`
  'knobs',
  // PolicyStats members a successful deploy's probe carries
  'successfulCalls', 'consecutiveFailures',
];

/**
 * Words an `expected` may use besides the game's vocabulary and generated intent type names: the generated
 * declarations' own type names and type syntax, and the words of its bound notes (`integer 0..9`, `at most 8 items,
 * each …`, `at most 40 code points, pattern …`).
 */
const EXPECTED_WORDS = ['Intent', 'IntentKind', 'number', 'string', 'boolean', 'never', 'Record', 'integer', 'integers', 'at', 'most', 'code', 'points', 'items', 'each', 'pattern',
  // a rejected starter reference (spec §11 Starters): `Starter (role r): "…"`, `Knobs["k"]: …`, `at least N`, `unique`
  'Starter', 'role', 'Knobs', 'least', 'unique'];

/** JSON Schema exports a string pattern `p` as `p(?![\s\S])` (a `$` that also rejects a final newline). */
const STRICT_SUFFIX = '(?![\\s\\S])';

export interface Vocabulary {
  words: Set<string>;
  idPatterns: RegExp[];
  /** Only inside `expected`: EXPECTED_WORDS and the intent type names `intentTypeNames` derives from the kinds. */
  typeWords: Set<string>;
  /** Declared string patterns as the game wrote them, which `expected` bound notes quote. */
  patterns: string[];
}

function collect(s: unknown, v: Vocabulary): void {
  if (Array.isArray(s)) {
    for (const x of s) collect(x, v);
    return;
  }
  if (!isObj(s)) return;
  if (Array.isArray(s.enum)) for (const e of s.enum) if (typeof e === 'string') v.words.add(e);
  if (typeof s.const === 'string') v.words.add(s.const);
  if (typeof s.pattern === 'string') {
    if (s.maxLength === undefined) v.idPatterns.push(new RegExp(s.pattern, 'u'));
    else v.patterns.push(s.pattern.endsWith(STRICT_SUFFIX) ? s.pattern.slice(0, -STRICT_SUFFIX.length) : s.pattern);
  }
  if (isObj(s.properties)) {
    for (const [k, p] of Object.entries(s.properties)) {
      v.words.add(k);
      collect(p, v);
    }
  }
  if (isObj(s.items)) collect(s.items, v);
  if (Array.isArray(s.oneOf)) collect(s.oneOf, v);
}

/** Vocabulary of one game as an agent learns it from its briefing and topics. */
export function vocabularyOf(s: SeatSurface): Vocabulary {
  const v: Vocabulary = {
    words: new Set(PROTOCOL_WORDS),
    idPatterns: [/^pol_[0-9]{1,12}$/, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
    // Kinds in manifest order (the `modes` surface line), so collision suffixes match the host's.
    typeWords: new Set([...EXPECTED_WORDS, ...intentTypeNames(s.intents.map((i) => i.kind)).values()]),
    patterns: [],
  };
  const b = s.briefing;
  for (const w of [...b.teams, ...b.roles, ...s.opponents, ...s.errors, ...s.eventKinds]) v.words.add(w);
  for (const i of s.intents) {
    v.words.add(i.kind);
    collect(i.params, v);
  }
  for (const schema of [s.observationSchema, s.directiveSchema, s.limitsSchema, s.reportSchema, s.eventSchema]) collect(schema, v);
  for (const k of Object.keys(s.modes)) v.words.add(k);
  for (const [path, starter] of Object.entries(s.starters)) {
    v.words.add(path);
    collect(starter.knobs, v);
  }
  return v;
}

/**
 * Whether an `expected` text is built from declared vocabulary only: quoted declared patterns, id template types
 * (`` `e_${number}` `` for a declared id prefix), string literals of declared words, numbers, identifiers from the
 * vocabulary or `typeWords`, and type punctuation. Anything else (such as echoed input) fails.
 */
function expectedKnown(text: string, vocab: Vocabulary): boolean {
  let ok = true;
  let rest = text;
  // Longest first: a shorter declared pattern may occur inside a longer one.
  for (const p of [...vocab.patterns].sort((a, b) => b.length - a.length)) rest = rest.replaceAll(p, ' ');
  rest = rest.replace(/`([a-z]{1,8})_\$\{number\}`/g, (_, prefix: string) => {
    if (!vocab.idPatterns.some((re) => re.test(`${prefix}_1`))) ok = false;
    return ' ';
  });
  rest = rest.replace(/"(?:[^"\\]|\\.)*"/g, (literal) => {
    try {
      if (!vocab.words.has(JSON.parse(literal) as string)) ok = false;
    } catch {
      ok = false;
    }
    return ' ';
  });
  rest = rest.replace(/(?<![A-Za-z0-9_])-?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?(?![A-Za-z0-9_])/gi, ' ');
  rest = rest.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => {
    if (!vocab.words.has(word) && !vocab.typeWords.has(word)) ok = false;
    return ' ';
  });
  return ok && /^[\s[\]{}()|:;?.,…<>+-]*$/.test(rest);
}

export interface VocabViolation {
  /** JSON path of the offending string/key (built from the response's own keys/indices). */
  path: string;
  kind: 'string' | 'key';
}

/**
 * Find strings/keys outside the vocabulary. `ownText(path)` marks positions whose strings are the principal's own
 * text (exempt). Returns at most `limit` violations.
 */
export function vocabularyViolations(value: unknown, vocab: Vocabulary, ownText: (path: string) => boolean = () => false, limit = 20, schema?: JsonSchema): VocabViolation[] {
  const out: VocabViolation[] = [];
  const known = (s: string) => vocab.words.has(s) || vocab.idPatterns.some((re) => re.test(s));
  const visit = (x: unknown, path: string, depth: number, node?: JsonSchema) => {
    if (out.length >= limit || depth > 64) return;
    if (Array.isArray(node?.oneOf)) node = (node.oneOf as unknown[]).filter(isObj).find((s) => nonConformance(s, x) === undefined);
    if (typeof x === 'string') {
      // An ack's `expected` (`$.expected`, `$[i].expected`, sequence `acks[i][j]`) or a policy's `lastInvalid.expected`.
      if (/(?:^\$|\])\.expected$|\.lastInvalid\.expected$/.test(path)) {
        if (!ownText(path) && !expectedKnown(x, vocab)) out.push({ path, kind: 'string' });
        return;
      }
      const bounded = node?.type === 'string' && typeof node.maxLength === 'number';
      if (!ownText(path) && (bounded ? nonConformance(node!, x) !== undefined : !known(x))) out.push({ path, kind: 'string' });
      return;
    }
    if (Array.isArray(x)) {
      x.forEach((y, i) => visit(y, `${path}[${i}]`, depth + 1, isObj(node?.items) ? node.items : undefined));
      return;
    }
    if (isObj(x)) {
      for (const [k, y] of Object.entries(x)) {
        const p = `${path}.${known(k) ? k : '<key>'}`;
        if (!known(k)) out.push({ path: p, kind: 'key' });
        const props = isObj(node?.properties) ? node.properties : {};
        visit(y, p, depth + 1, isObj(props[k]) ? props[k] : undefined);
      }
    }
  };
  visit(value, '$', 0, schema);
  return out;
}

/** Own-text positions in policy-related results: log lines and engine messages. */
export const policyOwnText = (path: string): boolean => /\.logs\[\d+\]$/.test(path) || /\.message$/.test(path);

/** A `policy_export` page: `text` is a slice of the caller's own package (own code and metadata), `hash` its digest. */
export const policyExportOwnText = (path: string): boolean => path === '$.text' || path === '$.hash';
