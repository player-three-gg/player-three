/**
 * `playerthree lint`: design-time checks for a game definition — affordability (observation size and $/hour),
 * documentation, vocabulary hygiene and schema bounds. Errors fail CI; warnings are advice.
 */
import { createGuard, isSignalIntent, observationSections, resolveDetail, SignalBoard, withSignals, type AnyManifest, type BotCommander, type GameDefinition, type IntentDef, type Seat } from 'playerthree';
import { validate, type Fields, type Schema } from 'playerthree/schema';
import { estimateTokens, measure, worstCase, type Size } from './size.ts';

export type Level = 'error' | 'warn' | 'info';

/** One lint result; any `error` fails the report. */
export interface Finding {
  level: Level;
  /** Stable machine code, e.g. `obs.too_large`. */
  code: string;
  /** Manifest path the finding is about. */
  path: string;
  message: string;
}

/** Input price per million tokens, USD: each provider's list price. */
export const DEFAULT_PRICES: Readonly<Record<string, number>> = {
  'claude-opus-5.5': 4,
  'claude-sonnet-5.5': 2,
  'claude-haiku-5.5': 0.1,
  'gpt-6.1-sol': 2,
  'gpt-6-luna': 0.1,
  'gemini-4-argon': 2,
  'gemini-3.8-flash': 0.75,
};

export interface LintOptions {
  /** Agent polling cadence for the cost estimate, seconds of real time. Default 10. */
  everySeconds?: number;
  /** Override / extend the price table ($/Mtok input). */
  prices?: Record<string, number>;
  /** Ticks of bot-vs-bot play to sample typical observations from. Default 600. */
  sampleTicks?: number;
  seed?: number;
  /** Worst-case observation tokens above this warn (default 8 000) … */
  warnTokens?: number;
  /** … and above this fail (default 64 000). */
  maxTokens?: number;
}

export interface ObservationStats {
  worst: Size;
  /** Mean over sampled observations. Undefined if sampling failed. */
  typical?: Size;
  /** Largest sampled observation. */
  sampledMax?: Size;
  samples: number;
}

export interface CostRow {
  model: string;
  usdPerMtok: number;
  typicalPerHour?: number;
  worstPerHour: number;
}

export interface LintReport {
  game: { id: string; version: string; title: string };
  ok: boolean;
  findings: Finding[];
  observation: ObservationStats;
  cost: { everySeconds: number; observationsPerHour: number; rows: CostRow[] };
}

/** Words that read as instructions/prose rather than identifiers when they appear inside an enum literal. */
const PROSE_WORDS = new Set([
  'the', 'you', 'your', 'yours', 'please', 'ignore', 'disregard', 'must', 'should', 'always', 'never', 'instruction',
  'instructions', 'system', 'assistant', 'prompt', 'say', 'tell', 'reply', 'respond', 'now', 'previous', 'above',
  'is', 'are', 'was', 'this', 'that', 'it', 'to', 'of', 'and', 'or', 'if', 'then', 'do', 'not', 'dont', 'we', 'i', 'me',
]);

/** Heuristic: an enum literal "looks like prose" when it has many words or contains sentence/instruction words. */
export function prosiness(literal: string): string | undefined {
  const words = literal.toLowerCase().split(/[_.<>]+/).filter(Boolean);
  if (literal.length > 32) return `${literal.length} chars long`;
  if (words.length >= 5) return `${words.length} words`;
  const hit = words.find((w) => PROSE_WORDS.has(w));
  if (hit) return `contains the word "${hit}"`;
  return undefined;
}

const LIST_WARN = 256;
const LIST_ERROR = 4096;
const NESTED_WARN = 4096;

/** Walk every schema node with a printable path; `mult` is the product of enclosing list maxima. */
function walk(s: Schema, path: string, mult: number, visit: (s: Schema, path: string, mult: number) => void): void {
  visit(s, path, mult);
  const fields = (f: Fields, prefix: string) => {
    for (const [k, c] of Object.entries(f)) walk(c, `${prefix}.${k}`, mult, visit);
  };
  switch (s.t) {
    case 'list':
      return walk(s.item, `${path}[]`, mult * Math.max(1, s.max), visit);
    case 'opt':
      return walk(s.item, path, mult, visit);
    case 'obj':
      return fields(s.fields, path);
    case 'union':
      for (const [name, f] of Object.entries(s.variants as Record<string, Fields>)) fields(f, `${path}<${name}>`);
      return;
    default:
      return;
  }
}

function schemaChecks(root: Schema, rootPath: string, out: Finding[]): void {
  walk(root, rootPath, 1, (s, path, mult) => {
    if (s.t === 'enum') {
      for (const v of s.values as readonly string[]) {
        const why = prosiness(v);
        if (why) out.push({ level: 'warn', code: 'enum.prose', path, message: `enum literal "${v}" looks like prose (${why}); literals reach agents verbatim — keep them short identifiers` });
      }
    }
    if (s.t === 'str') {
      out.push({ level: 'warn', code: 'str.provenance', path, message: 'bounded strings admit prose; verify only trusted developer or authorized owner data reaches agents, never third-party player text' });
    }
    if (s.t === 'list' || s.t === 'ints') {
      const max = s.t === 'ints' ? s.maxItems : s.max;
      if (max > LIST_ERROR) {
        out.push({ level: 'error', code: 'list.unbounded', path, message: `list max ${max} is effectively unbounded (> ${LIST_ERROR}); cap it to what an agent can use` });
      } else if (max > LIST_WARN) {
        out.push({ level: 'warn', code: 'list.large', path, message: `list max ${max} is large (> ${LIST_WARN}); consider summarising or paging` });
      }
      const total = mult * Math.max(1, max);
      if (mult > 1 && total > NESTED_WARN) {
        out.push({ level: 'warn', code: 'list.nested', path, message: `nested lists allow up to ${total} items in total` });
      }
    }
  });
}

function docChecks(m: AnyManifest, out: Finding[]): void {
  if (!m.doc?.trim()) out.push({ level: 'error', code: 'doc.game', path: 'doc', message: 'game has no rules briefing (manifest.doc)' });
  for (const role of m.roles.values as readonly string[]) {
    if (!m.roleDocs?.[role]?.trim()) out.push({ level: 'error', code: 'doc.role', path: `roleDocs.${role}`, message: `role "${role}" has no doc` });
  }
  for (const [kind, d] of Object.entries(m.intents as Record<string, IntentDef>)) {
    if (!d.doc?.trim()) out.push({ level: 'error', code: 'doc.intent', path: `intents.${kind}.doc`, message: `intent "${kind}" has no doc` });
    else if (d.doc.trim().length < 12) out.push({ level: 'warn', code: 'doc.intent_short', path: `intents.${kind}.doc`, message: `intent "${kind}" doc is very short; say what it does and when it fails` });
    for (const [k, p] of Object.entries(d.params)) {
      const inner = p.t === 'opt' ? (p.item as Schema) : p;
      const undocumented = !('doc' in inner) || !inner.doc;
      // Self-explanatory enum params are fine; numbers need units/meaning.
      if (undocumented && inner.t !== 'enum' && inner.t !== 'bool') {
        out.push({ level: 'warn', code: 'doc.param', path: `intents.${kind}.params.${k}`, message: `parameter "${k}" of "${kind}" has no doc (units / meaning)` });
      }
    }
  }
  const docTokens = estimateTokens(m.doc ?? '');
  if (docTokens > 6000) out.push({ level: 'warn', code: 'doc.long', path: 'doc', message: `rules briefing is ~${docTokens} tokens; agents re-read it often — move detail into skills` });
}

function skillChecks(m: AnyManifest, out: Finding[]): void {
  const skills = m.skills ?? [];
  if (skills.length === 0) {
    out.push({ level: 'warn', code: 'skills.none', path: 'skills', message: 'no skills: agents only get the generated reference. Ship a skill with strategy notes and example bots' });
    return;
  }
  if (m.control.policy) {
    const example = skills.some((s: { files: Record<string, string> }) =>
      Object.keys(s.files).some((p) => /(^|\/)examples?\//.test(p) || /\.(js|mjs|ts|wat|wasm|rs|zig|c|as)$/.test(p)),
    );
    if (!example) out.push({ level: 'warn', code: 'skills.no_examples', path: 'skills', message: 'policy mode is on but no skill ships an example policy; agents write much better bots starting from one' });
  }
}

function eventChecks(m: AnyManifest, out: Finding[]): void {
  const f = m.event?.fields as Fields | undefined;
  if (f?.tick?.t !== 'int') out.push({ level: 'error', code: 'event.tick', path: 'event.tick', message: 'event schema needs `tick: t.int`' });
  if (f?.kind?.t !== 'enum') out.push({ level: 'error', code: 'event.kind', path: 'event.kind', message: 'event schema needs `kind: t.enum`' });
}

/** Play bots against each other on a fresh match and measure what `observe()` actually returns. */
function sampleObservations(def: GameDefinition, ticks: number, seed: number, out: Finding[]): { samples: Size[] } {
  const m = def.manifest;
  const teams = m.teams.values as readonly string[];
  const game = def.create({ seed, teams });
  const roles = m.roles.values as readonly string[];
  const opponents = m.opponents.values as readonly string[];
  const level = opponents[opponents.length - 1] as string;
  const seats: { seat: Seat; bot: BotCommander; since: number }[] = [];
  const guard = createGuard({ onDrop: () => {} });
  for (const team of teams) for (const role of roles) {
    const seat = { team, role };
    const bot = def.createBot(seat, level);
    let matchData: Record<string, unknown> | null = null;
    if (m.matchData) {
      const checked = guard.pass('matchData', m.matchData, game.matchData?.(seat));
      if (!checked.ok) throw new Error('invalid match bootstrap');
      matchData = checked.value as Record<string, unknown>;
    }
    bot.init?.(matchData);
    seats.push({ seat, bot, since: -1 });
  }
  const samples: Size[] = [];
  const every = Math.max(1, Math.round(m.tickRate));
  let reported = false;
  // Bots read and answer team signals like in a live match; the measured observation includes the board slice.
  const board = m.signals ? new SignalBoard(m, teams, SignalBoard.limitsFor(m, game)) : undefined;
  const observe = (seat: Seat, since: number, detail: readonly string[]): unknown => board ? withSignals(game.observe(seat, since, detail), board.seat(seat.team, seat.role)) : game.observe(seat, since, detail);
  for (let i = 0; i < ticks; i++) {
    for (const s of seats) {
      // Built-in bots read every section; the size sample is what an agent's default observation carries.
      const obs = observe(s.seat, Math.max(0, game.tick - 1), observationSections(m));
      for (const intent of s.bot.think(obs as never)) {
        if (board && isSignalIntent(m, intent)) board.apply(s.seat.team, s.seat.role, intent as { kind: string } & Record<string, unknown>, game.tick);
        else game.apply(s.seat, intent);
      }
      if (i % every === 0) {
        const polled = observe(s.seat, s.since, resolveDetail(m, s.seat.role, undefined) ?? []);
        s.since = game.tick;
        const r = validate(m.observation, polled);
        if (!r.ok && !reported) {
          reported = true;
          out.push({ level: 'error', code: 'obs.nonconforming', path: `observation${r.path.map((p) => `.${p}`).join('')}`, message: `observe() returned data that violates manifest.observation (${r.code}); the outbound guard will drop it` });
        }
        samples.push(measure(JSON.stringify(polled)));
      }
    }
    if (teams.some((t) => game.outcome(t) !== 'running')) break;
    game.step();
    board?.advance(game.tick);
  }
  return { samples };
}

/** Runs every design-time check on a game definition; `ok` is false when any finding is an error. */
export function lintDefinition(def: GameDefinition, opts: LintOptions = {}): LintReport {
  const m = def.manifest;
  const findings: Finding[] = [];
  docChecks(m, findings);
  eventChecks(m, findings);
  skillChecks(m, findings);
  for (const key of ['observation', 'view', 'directive', 'report', 'event'] as const) schemaChecks(m[key], key, findings);
  if (m.matchData) schemaChecks(m.matchData, 'matchData', findings);
  if (m.observer) schemaChecks(m.observer, 'observer', findings);
  if (m.matchOptions) schemaChecks(m.matchOptions, 'matchOptions', findings);
  if (m.limits) schemaChecks(m.limits, 'limits', findings);
  if (m.control.chat?.ping) schemaChecks(m.control.chat.ping, 'control.chat.ping', findings);
  for (const [kind, d] of Object.entries(m.intents as Record<string, IntentDef>)) {
    for (const [k, p] of Object.entries(d.params)) schemaChecks(p, `intents.${kind}.params.${k}`, findings);
  }
  for (const key of ['teams', 'roles', 'errors', 'opponents'] as const) schemaChecks(m[key], key, findings);
  for (const kind of Object.keys(m.intents)) {
    const why = prosiness(kind);
    if (why) findings.push({ level: 'warn', code: 'enum.prose', path: `intents.${kind}`, message: `intent name "${kind}" looks like prose (${why})` });
  }

  const worst = worstCase(m.observation);
  const warnTokens = opts.warnTokens ?? 8000;
  const maxTokens = opts.maxTokens ?? 64_000;
  if (worst.tokens > maxTokens) {
    findings.push({ level: 'error', code: 'obs.too_large', path: 'observation', message: `worst-case observation is ~${worst.tokens} tokens (> ${maxTokens}); lower list maxima or split it` });
  } else if (worst.tokens > warnTokens) {
    findings.push({ level: 'warn', code: 'obs.large', path: 'observation', message: `worst-case observation is ~${worst.tokens} tokens (> ${warnTokens}); agents polling it get expensive` });
  }

  const observation: ObservationStats = { worst, samples: 0 };
  try {
    const { samples } = sampleObservations(def, opts.sampleTicks ?? 600, opts.seed ?? 1, findings);
    if (samples.length) {
      observation.samples = samples.length;
      const sum = samples.reduce((a, b) => ({ bytes: a.bytes + b.bytes, tokens: a.tokens + b.tokens }));
      observation.typical = { bytes: Math.round(sum.bytes / samples.length), tokens: Math.round(sum.tokens / samples.length) };
      observation.sampledMax = samples.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    }
  } catch (e) {
    findings.push({ level: 'error', code: 'sample.crashed', path: 'definition', message: `sampling a bot-vs-bot match threw: ${e instanceof Error ? e.message : String(e)}` });
  }

  const everySeconds = opts.everySeconds ?? 10;
  const observationsPerHour = 3600 / everySeconds;
  const prices = { ...DEFAULT_PRICES, ...opts.prices };
  const rows: CostRow[] = Object.entries(prices).map(([model, usdPerMtok]) => ({
    model,
    usdPerMtok,
    worstPerHour: (observationsPerHour * worst.tokens * usdPerMtok) / 1e6,
    typicalPerHour: observation.typical ? (observationsPerHour * observation.typical.tokens * usdPerMtok) / 1e6 : undefined,
  }));

  const order: Record<Level, number> = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return {
    game: { id: m.id, version: m.version, title: m.title },
    ok: !findings.some((f) => f.level === 'error'),
    findings,
    observation,
    cost: { everySeconds, observationsPerHour, rows },
  };
}

const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const kb = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KiB`);

/** Human-readable lint report (ANSI colours when `color`). */
export function formatLintReport(r: LintReport, color = false): string {
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const tag: Record<Level, string> = { error: c('31;1', 'error'), warn: c('33', 'warn '), info: c('36', 'info ') };
  const lines: string[] = [];
  lines.push(c('1', `playerthree lint — ${r.game.title} (${r.game.id}@${r.game.version})`), '');
  const o = r.observation;
  lines.push(c('1', 'Observation size'));
  lines.push(`  worst case   ${kb(o.worst.bytes).padStart(10)}   ~${o.worst.tokens} tokens   (every list full, every optional present)`);
  if (o.typical && o.sampledMax) {
    lines.push(`  typical      ${kb(o.typical.bytes).padStart(10)}   ~${o.typical.tokens} tokens   (mean of ${o.samples} samples from a bot-vs-bot match)`);
    lines.push(`  sampled max  ${kb(o.sampledMax.bytes).padStart(10)}   ~${o.sampledMax.tokens} tokens`);
  }
  lines.push('');
  lines.push(c('1', `Cost of an agent reading one observation every ${r.cost.everySeconds}s (${Math.round(r.cost.observationsPerHour)}/h, input tokens only)`));
  const w = Math.max(...r.cost.rows.map((x) => x.model.length));
  lines.push(`  ${'model'.padEnd(w)}   $/Mtok    typical/h    worst/h`);
  for (const row of r.cost.rows) {
    lines.push(
      `  ${row.model.padEnd(w)}   ${row.usdPerMtok.toFixed(2).padStart(6)}   ${(row.typicalPerHour === undefined ? '—' : usd(row.typicalPerHour)).padStart(10)}   ${usd(row.worstPerHour).padStart(8)}`,
    );
  }
  lines.push('  (built-in list prices; override with --price model=usdPerMtok)', '');
  if (r.findings.length === 0) lines.push(c('32', '✓ no findings'));
  for (const f of r.findings) lines.push(`${tag[f.level]}  ${c('2', f.path)}  ${f.message}  ${c('2', `[${f.code}]`)}`);
  const errors = r.findings.filter((f) => f.level === 'error').length;
  const warns = r.findings.filter((f) => f.level === 'warn').length;
  lines.push('', r.ok ? c('32', `✓ passed with ${warns} warning(s)`) : c('31;1', `✗ ${errors} error(s), ${warns} warning(s)`));
  return lines.join('\n');
}
