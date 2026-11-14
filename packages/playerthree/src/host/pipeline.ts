/**
 * The intent pipeline steps shared by live matches, practice and replays, plus untrusted-argument parsing.
 * Order for every source: snapshot → schema → role → (controller, rate limit: caller) → adapter.apply.
 * Acks never echo input: they carry closed codes and schema paths (developer field names / indices) only.
 */
import { createHash } from 'node:crypto';
import type { IntentAck, Mandate, PolicyArtifact, PolicyError, PolicySource, StarterRef } from '../control.ts';
import { validateUnknown, type OutboundGuard } from '../guard.ts';
import type { AnyManifest, Controller, FinalOutcome, GameAdapter, GameDefinition, GameMetricRecorder, IntentContext, IntentDef, Outcome, PolicyLimits, SkillDef } from '../manifest.ts';
import { expectedAt, schemaExpected } from '../dts.ts';
import { buildPolicy, parseModules } from '../policy/build.ts';
import { buildStarter, parseStarterRef, type StarterCatalog } from '../policy/starters.ts';
import { composePolicy } from '../skill.ts';
import type { EnumS, Fields, Infer, ObjS, Schema, SchemaErrorCode, SchemaPath, UnionS } from '../schema.ts';
import type { PolicyPackage } from '../policy-package.ts';
import type { SignalLimits } from '../signals.ts';
import type { ReplayEntry } from './types.ts';
import { PlayerThreeError, snapshot } from './util.ts';

export type Checked = { ok: true; intent: { kind: string } & Record<string, unknown> } | { ok: false; ack: IntentAck };

/** Schema + role check of one untrusted intent. Invalid acks carry `expected` (spec §4) from the manifest and path only. */
export function checkIntent(manifest: AnyManifest, schema: UnionS, role: string, raw: unknown): Checked {
  const snap = snapshot(raw);
  if (!snap.ok) return { ok: false, ack: { ok: false, code: 'invalid', schemaCode: 'type', path: [], expected: expectedAt(manifest, []) } };
  const r = validateUnknown(schema, snap.value);
  if (!r.ok) {
    // The tag validates before any field, so a failure below it belongs to a declared kind: naming that kind's type
    // uses manifest vocabulary only, never the rejected value.
    const kind = (snap.value as { kind?: unknown } | null)?.kind;
    const declared = typeof kind === 'string' && Object.hasOwn(manifest.intents, kind) ? kind : undefined;
    return { ok: false, ack: { ok: false, code: 'invalid', schemaCode: r.code, path: r.path, expected: expectedAt(manifest, r.path, declared) } };
  }
  const intent = r.value as { kind: string } & Record<string, unknown>;
  const def = (manifest.intents as Record<string, IntentDef>)[intent.kind] as IntentDef;
  if (!def.roles.includes(role)) return { ok: false, ack: { ok: false, code: 'forbidden_role' } };
  return { ok: true, intent };
}

/** A seat as the host handles it internally (validated enum literals). */
export interface SeatKey {
  readonly team: string;
  readonly role: string;
}

/**
 * The adapter as seen by manifest-generic host code. Same object as `GameAdapter<M>`; the host validates every
 * team/role/intent before calling it, so the precise per-game types add nothing here and are too deep to expand.
 */
export interface LooseAdapter {
  readonly tick: number;
  step(): void;
  outcome(team: string): Outcome;
  view(team: string, opts?: { snapshot: boolean }): unknown;
  debugView?(): unknown;
  observerView?(): unknown;
  end?(outcomes: Record<string, FinalOutcome>, ranks: Record<string, number>): void;
  forfeit?(team: string): void;
  rank?(team: string): number;
  observe(seat: SeatKey, sinceTick: number, detail: readonly string[]): unknown;
  matchData?(seat: SeatKey): unknown;
  apply(seat: SeatKey, intent: unknown, context?: IntentContext): { ok: true } | { ok: false; code: unknown };
  report(team: string): unknown;
  events(seat: SeatKey, sinceTick: number): unknown[];
  setSeatInfo(seat: SeatKey, info: { controller: Controller; mandate: Mandate }): void;
  signalLimits?(): SignalLimits | null;
  clone?(): LooseAdapter;
}

/** A built-in bot as host code drives it (`BotCommander` without the per-game types). */
export interface LooseBot {
  init?(matchData: unknown): void;
  think(obs: unknown): unknown[];
}

export interface LooseDefinition {
  readonly manifest: AnyManifest;
  create(opts: { seed: number; options?: unknown; teams: readonly string[]; alliances?: Readonly<Record<string, readonly string[]>> }): LooseAdapter;
  createBot(seat: SeatKey, opponent: string, options?: Record<string, number | boolean>): LooseBot;
  readonly botOptions?: ObjS;
  botPackages?(level: string, role: string): PolicyPackage | undefined;
  metrics?(game: LooseAdapter, options?: { sampleEveryTicks?: number }): GameMetricRecorder;
}

export function looseDefinition<M extends AnyManifest>(definition: GameDefinition<M>): LooseDefinition {
  return definition as unknown as LooseDefinition;
}

export function looseAdapter<M extends AnyManifest>(adapter: GameAdapter<M>): LooseAdapter {
  return adapter as unknown as LooseAdapter;
}

/** Validated match sides as host code handles them (see `MatchSides`). */
export interface Sides {
  readonly teams: readonly string[];
  readonly alliances?: Readonly<Record<string, readonly string[]>>;
}

/** Longest alliance id, in UTF-16 code units (the arena's side-spec id bound). */
const MAX_ALLIANCE_ID = 256;

/**
 * Untrusted match sides → validated canonical sides: `teams` (default `fallback`, else every manifest team) in
 * manifest order, alliance members likewise and alliances ordered by their first member. Throws `invalid` for unknown,
 * duplicate or no teams, and for alliances that are not a partition of the match teams. An alliance id that names a
 * manifest team must name one of its own members, so an `end()` key is never ambiguous.
 */
export function parseMatchSides(manifest: AnyManifest, rawTeams: unknown, rawAlliances: unknown, fallback?: readonly string[]): Sides {
  const declared = (manifest.teams as EnumS).values as readonly string[];
  const picked = rawTeams === undefined ? fallback ?? declared : rawTeams;
  if (!Array.isArray(picked) || picked.length === 0 || picked.length > declared.length ||
    picked.some((team, i) => typeof team !== 'string' || !declared.includes(team) || picked.indexOf(team) !== i)) throw new PlayerThreeError('invalid');
  const teams = declared.filter((team) => picked.includes(team));
  if (rawAlliances === undefined) return { teams };
  if (!isPlain(rawAlliances)) throw new PlayerThreeError('invalid');
  const entries = Object.entries(rawAlliances);
  if (entries.length === 0 || entries.length > teams.length) throw new PlayerThreeError('invalid');
  const seen = new Set<string>();
  const alliances: [string, string[]][] = [];
  for (const [id, members] of entries) {
    if (id.length === 0 || id.length > MAX_ALLIANCE_ID || !Array.isArray(members) || members.length === 0) throw new PlayerThreeError('invalid');
    for (const team of members as unknown[]) {
      if (typeof team !== 'string' || !teams.includes(team) || seen.has(team)) throw new PlayerThreeError('invalid');
      seen.add(team);
    }
    if (declared.includes(id) && !members.includes(id)) throw new PlayerThreeError('invalid');
    alliances.push([id, teams.filter((team) => members.includes(team))]);
  }
  if (seen.size !== teams.length) throw new PlayerThreeError('invalid');
  alliances.sort(([, a], [, b]) => teams.indexOf(a[0]!) - teams.indexOf(b[0]!));
  // Object.fromEntries defines own properties, so an id such as `__proto__` stays plain data.
  return { teams, alliances: Object.fromEntries(alliances) };
}

/** The competing units of a match: each alliance, or each team on its own. */
export function sideUnits(sides: Sides): (readonly string[])[] {
  return sides.alliances ? Object.values(sides.alliances) : sides.teams.map((team) => [team]);
}

const TIER: Record<FinalOutcome, number> = { win: 0, draw: 1, loss: 2 };

/**
 * Standard competition ranking (1, 2, 2, 4) of the units by outcome: win, then draw, then loss. A unit ranks by its
 * best member, so allies always share one rank. Called only once every team's outcome is final.
 */
export function ranksByOutcome(sides: Sides, outcomes: Readonly<Record<string, Outcome>>): Record<string, number> {
  const units = sideUnits(sides);
  const tiers = units.map((members) => Math.min(...members.map((team) => TIER[outcomes[team] as FinalOutcome] ?? TIER.loss)));
  const ranks = new Map(units.flatMap((members, i) => {
    const rank = 1 + tiers.filter((tier) => tier < tiers[i]!).length;
    return members.map((team): [string, number] => [team, rank]);
  }));
  return Object.fromEntries(sides.teams.map((team) => [team, ranks.get(team)!]));
}

/** True when `ranks` is a standard competition ranking of the units in which allies share their unit's rank. */
export function validRanks(sides: Sides, ranks: Readonly<Record<string, unknown>>): boolean {
  const values: number[] = [];
  for (const members of sideUnits(sides)) {
    const rank = ranks[members[0]!];
    if (typeof rank !== 'number' || !Number.isSafeInteger(rank) || rank < 1 || members.some((team) => ranks[team] !== rank)) return false;
    values.push(rank);
  }
  return values.every((rank) => rank === 1 + values.filter((v) => v < rank).length);
}

/**
 * Untrusted `PlayerThreeMatch.end` argument → final outcomes and ranks for every match team. `'draw'`: every team draws
 * (rank 1). Otherwise an object keyed by match teams and/or alliance ids (an alliance key covers its members) whose
 * values are either all outcomes (ranked by `ranksByOutcome`) or all placements (`validRanks`; the single unit placed
 * first wins, units sharing first place draw, every other unit loses). Each team must be covered, every value
 * covering it must agree, and allies must agree; anything else throws `invalid`.
 */
export function parseEndOutcomes(sides: Sides, raw: unknown): { outcomes: Record<string, FinalOutcome>; ranks: Record<string, number> } {
  if (raw === 'draw') {
    return { outcomes: Object.fromEntries(sides.teams.map((team) => [team, 'draw' as const])), ranks: Object.fromEntries(sides.teams.map((team) => [team, 1])) };
  }
  if (!isPlain(raw)) throw new PlayerThreeError('invalid');
  const given = Object.entries(raw);
  if (given.length === 0) throw new PlayerThreeError('invalid');
  const placements = given.every(([, v]) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1);
  if (!placements && !given.every(([, v]) => v === 'win' || v === 'loss' || v === 'draw')) throw new PlayerThreeError('invalid');
  const values = new Map<string, FinalOutcome | number>();
  for (const [key, value] of given) {
    const alliance = sides.alliances && Object.hasOwn(sides.alliances, key) ? sides.alliances[key] : undefined;
    const covered = alliance ?? (sides.teams.includes(key) ? [key] : undefined);
    if (!covered) throw new PlayerThreeError('invalid');
    for (const team of covered) {
      if (values.has(team) && values.get(team) !== value) throw new PlayerThreeError('invalid');
      values.set(team, value as FinalOutcome | number);
    }
  }
  const units = sideUnits(sides);
  if (units.some((members) => members.some((team) => !values.has(team) || values.get(team) !== values.get(members[0]!)))) throw new PlayerThreeError('invalid');
  if (!placements) {
    const outcomes = Object.fromEntries(sides.teams.map((team) => [team, values.get(team) as FinalOutcome]));
    return { outcomes, ranks: ranksByOutcome(sides, outcomes) };
  }
  const ranks = Object.fromEntries(sides.teams.map((team) => [team, values.get(team) as number]));
  if (!validRanks(sides, ranks)) throw new PlayerThreeError('invalid');
  const first = units.filter((members) => ranks[members[0]!] === 1).length;
  const outcomes = Object.fromEntries(sides.teams.map((team): [string, FinalOutcome] => [team, ranks[team] !== 1 ? 'loss' : first === 1 ? 'win' : 'draw']));
  return { outcomes, ranks };
}

/** Guarded, independently bounded bootstrap; null is the initialization value for games without a schema. */
export function matchDataFor(sim: Pick<Sim, 'manifest' | 'adapter' | 'guard'>, seat: SeatKey): Record<string, unknown> | null {
  if (!sim.manifest.matchData) return null;
  if (typeof sim.adapter.matchData !== 'function') throw new PlayerThreeError('internal');
  const data = sim.guard.pass('matchData', sim.manifest.matchData, sim.adapter.matchData(seat));
  if (!data.ok) throw new PlayerThreeError('internal');
  return data.value as Record<string, unknown>;
}

/**
 * Untrusted match options → validated value (`undefined` = game defaults). Rejections are `invalid` with the closed
 * `{schemaCode, path, expected}` (spec §4) under `at` (e.g. `["options"]` for practice_run): `unknown_field` at `at`
 * itself when the game declares no options, else the first failure against `manifest.matchOptions`, its `expected`
 * rooted at `MatchOptions` (topic `schema/match-options`).
 */
export function parseMatchOptions(manifest: AnyManifest, raw: unknown, at: SchemaPath = []): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  const schema = manifest.matchOptions;
  if (!schema) throw new PlayerThreeError('invalid', { schemaCode: 'unknown_field', path: [...at], expected: 'MatchOptions: never' });
  const snap = snapshot(raw);
  if (!snap.ok) throw new PlayerThreeError('invalid', { schemaCode: 'type', path: [...at], expected: schemaExpected(schema, 'MatchOptions', []) });
  const r = validateUnknown(schema, snap.value);
  if (!r.ok) throw new PlayerThreeError('invalid', { schemaCode: r.code, path: [...at, ...r.path], expected: schemaExpected(schema, 'MatchOptions', r.path) });
  return r.value as Record<string, unknown>;
}

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Host defaults with later options on top: objects merge recursively unless their schema declares
 * merge:'replace'; arrays/scalars replace. Inputs and the merged result must conform to the options schema.
 * Returns fresh objects (inputs are never mutated); `undefined` when both are absent.
 */
export function mergeMatchOptions(
  schema: Schema | undefined,
  defaults: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (defaults === undefined) return overrides === undefined ? undefined : structuredClone(overrides);
  if (overrides === undefined) return structuredClone(defaults);
  const merge = (base: unknown, over: unknown, node: Schema | undefined): unknown => {
    if (over === undefined) return structuredClone(base);
    if (node?.t === 'opt') node = node.item;
    if (node?.t === 'obj' && node.merge === 'replace') return structuredClone(over);
    if (!isPlain(base) || !isPlain(over)) return structuredClone(over);
    let fields: Fields | undefined;
    if (node?.t === 'obj') fields = node.fields;
    else if (node?.t === 'union') {
      const tag = Object.hasOwn(over, node.tag) ? over[node.tag] : base[node.tag];
      if (typeof tag === 'string' && Object.hasOwn(node.variants, tag)) fields = node.variants[tag] as Fields;
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
      const child = fields && Object.hasOwn(fields, k) ? fields[k] : undefined;
      const v = merge(Object.hasOwn(base, k) ? base[k] : undefined, Object.hasOwn(over, k) ? over[k] : undefined, child);
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  const result = merge(defaults, overrides, schema) as Record<string, unknown>;
  if (schema && !validateUnknown(schema, result).ok) throw new PlayerThreeError('invalid');
  return result;
}

export interface Sim {
  readonly manifest: AnyManifest;
  readonly adapter: LooseAdapter;
  readonly guard: OutboundGuard;
  /** Replay recorder; receives every intent that reaches `adapter.apply`. */
  record(entry: ReplayEntry): void;
}

/** Apply a checked intent. Game error codes pass the outbound guard (unknown codes become `internal`). */
export function applyIntent(sim: Sim, seat: SeatKey, intent: { kind: string }, context: IntentContext): IntentAck {
  if (context.source === 'owner' && context.ownerRoles === undefined) throw new Error('playerthree: owner intent without owner roles');
  sim.record(context.source === 'owner'
    ? [sim.adapter.tick, seat.team, seat.role, 'intent', structuredClone(intent), 'owner', [...context.ownerRoles!]]
    : [sim.adapter.tick, seat.team, seat.role, 'intent', structuredClone(intent), context.source]);
  const r = sim.adapter.apply(seat, intent, context);
  if (r.ok) return { ok: true };
  const code = sim.guard.pass('game_error', sim.manifest.errors, r.code);
  return { ok: false, code: 'game', gameCode: code.ok ? (code.value as string) : 'internal' };
}

/** Closed code under which a rejected intent is counted in PolicyStats. */
export function rejectCode(ack: IntentAck): string | undefined {
  if (ack.ok) return undefined;
  return ack.code === 'game' ? `game:${ack.gameCode}` : ack.code === 'signal' ? `signal:${ack.signalCode}` : ack.code;
}

/** First value of each schema: initial directive for every seat. */
export function defaultOf(s: Schema): unknown {
  switch (s.t) {
    case 'enum':
      return s.values[0];
    case 'int':
    case 'num':
      return s.min <= 0 && s.max >= 0 ? 0 : s.min;
    case 'bool':
      return false;
    case 'list':
    case 'ints':
      return [];
    case 'obj': {
      const out: Record<string, unknown> = Object.create(null);
      for (const [k, f] of Object.entries(s.fields as Record<string, Schema>)) if (f.t !== 'opt') out[k] = defaultOf(f);
      return out;
    }
    case 'union': {
      const [tag, fields] = Object.entries(s.variants as Record<string, Record<string, Schema>>)[0] as [string, Record<string, Schema>];
      return { [s.tag]: tag, ...(defaultOf({ t: 'obj', fields }) as object) };
    }
    case 'opt':
      return undefined;
    case 'str': {
      const empty = validateUnknown(s, '');
      if (empty.ok) return '';
      throw new Error('playerthree/host: the directive schema needs a default; required patterned `t.str` fields rejecting empty text have none');
    }
    case 'id':
      throw new Error('playerthree/host: the directive schema needs a default; required `t.id` fields have none');
  }
}

export function defaultMandate(manifest: AnyManifest): Mandate {
  return { autonomy: 'autonomous', directive: defaultOf(manifest.directive), whenAbsent: 'policy' };
}

/**
 * Owner-authored mandate; only manifest-declared objective and limits cross into the adapter. `whenAbsent: 'pause'`
 * is `invalid` unless the game declares `control.pausable`.
 */
export function parseMandate(manifest: AnyManifest, raw: unknown): Mandate {
  const snap = snapshot(raw);
  if (!snap.ok || snap.value === null || typeof snap.value !== 'object' || Array.isArray(snap.value)) throw new PlayerThreeError('invalid');
  const value = snap.value as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['autonomy', 'directive', 'limits', 'whenAbsent'].includes(key))) throw new PlayerThreeError('invalid');
  if (value.autonomy !== 'autonomous' && value.autonomy !== 'supervised') throw new PlayerThreeError('invalid');
  if (value.whenAbsent !== 'policy' && value.whenAbsent !== 'bot' && value.whenAbsent !== 'hold' && !(value.whenAbsent === 'pause' && manifest.control.pausable)) {
    throw new PlayerThreeError('invalid');
  }
  const directive = validateUnknown(manifest.directive, value.directive);
  if (!directive.ok) throw new PlayerThreeError('invalid');
  let limits: unknown;
  if (value.limits !== undefined) {
    if (!manifest.limits) throw new PlayerThreeError('invalid');
    const result = validateUnknown(manifest.limits, value.limits);
    if (!result.ok) throw new PlayerThreeError('invalid');
    limits = result.value;
  }
  return { autonomy: value.autonomy, directive: directive.value, whenAbsent: value.whenAbsent, ...(limits === undefined ? {} : { limits }) };
}

/** Base64 (standard alphabet, padded) of a WASM module: deploy artifacts and policy package scripts. */
export const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Every artifact member (spec §4 `Artifact`); which ones combine depends on the body. */
const ARTIFACT_KEYS = ['runtime', 'code', 'modules', 'entry', 'include', 'from', 'knobs'] as const;
/** The bodies, in the order a mixture is judged: the first one present is the body, any later one is the extra field. */
const BODIES = ['from', 'code', 'modules'] as const;
type Body = (typeof BODIES)[number];
/** Members each body accepts besides itself. */
const BODY_KEYS: Record<Body, readonly string[]> = { from: ['runtime', 'knobs'], code: ['runtime', 'include'], modules: ['runtime', 'entry', 'include'] };

/**
 * The `expected` texts of artifact shape failures (spec §11), in the §4 vocabulary (`Artifact…: <type>`): the bodies the
 * game accepts (`modules` and `include` need js, `from` declared starters) and each body's own members.
 */
function artifactShapes(limits: PolicyLimits, ctx: ArtifactContext): { bodies: string; any: string; of: Record<Body, string> } {
  const js = limits.runtimes.includes('js');
  const starters = ctx.starters.size > 0;
  const of: Record<Body, string> = {
    from: '{ from; knobs?; runtime?: "js" }',
    code: js ? '{ runtime; code; include? }' : '{ runtime; code }',
    modules: '{ runtime: "js"; modules; entry; include? }',
  };
  const offered = BODIES.filter((b) => (b === 'from' ? starters : b === 'modules' ? js : true));
  return {
    bodies: `Artifact: one of ${['code', ...(js ? ['modules+entry'] : []), ...(starters ? ['from'] : [])].join(' | ')}`,
    any: `Artifact: ${offered.map((b) => of[b]).join(' | ')}`,
    of,
  };
}

/** A closed artifact shape failure at one developer field (`?` for an unknown key); never echoes the input. */
function shapeError(schemaCode: SchemaErrorCode, field: string | undefined, expected: string): PlayerThreeError {
  return new PlayerThreeError('invalid', { schemaCode, path: field === undefined ? [] : [field], expected });
}

/** What an artifact resolves against: the served skills, the game's starters and (for starters) the seat's role. */
export interface ArtifactContext {
  skills: readonly SkillDef[];
  starters: StarterCatalog;
  /** The seat's role: a starter must play it. Undefined: any starter (local builds without a seat). */
  role?: string;
}

/**
 * Parse an untrusted policy artifact (`{ runtime, code, include? }`, js only `{ runtime, modules, entry, include? }`, or
 * a starter reference `{ from, knobs?, runtime?: 'js' }`) into the composed artifact the host probes, stores and
 * hashes, plus the validated `source` it came from. Modules are bundled with `buildPolicy` (spec §11), `include` is
 * resolved against the served skills, and a starter reference is validated (`parseStarterRef`) and built as its
 * generated entry module (§11 *Starters*). A wrong shape is `invalid` with a closed `{schemaCode, path, expected}`
 * naming the field (§11 *Artifact shape*): no body → `missing_field` at `code` (at `from` / `modules` when only `knobs` /
 * `entry` came), a missing `runtime` or `entry` → `missing_field` there, a second body or a member its body does not
 * take → `unknown_field` at that member, an unknown key → `unknown_field` at `?`. Unknown includes and modules breaking
 * §11 → bare `invalid`; a build failure is `invalid` with own-text `detail` (esbuild's message and location); a
 * rejected starter reference is `invalid` with its closed detail. Policy-level problems (runtime, size of the composed
 * source) come back as a `PolicyError` so the agent sees them like any other deploy failure.
 */
export async function parseArtifact(
  raw: unknown,
  limits: PolicyLimits,
  ctx: ArtifactContext,
): Promise<{ ok: true; artifact: PolicyArtifact; source: PolicySource } | { ok: false; error: PolicyError }> {
  const { skills } = ctx;
  const shapes = artifactShapes(limits, ctx);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw shapeError('type', undefined, shapes.any);
  const keys = Object.keys(raw);
  if (keys.some((k) => !(ARTIFACT_KEYS as readonly string[]).includes(k))) throw shapeError('unknown_field', '?', shapes.any);
  const bodies = BODIES.filter((b) => keys.includes(b));
  const body = bodies[0];
  if (body === undefined) {
    // A body's companion alone (`knobs`, `entry`) points at the body it needs; otherwise name every alternative.
    if (keys.includes('knobs')) throw shapeError('missing_field', 'from', `Artifact: ${shapes.of.from}`);
    if (keys.includes('entry')) throw shapeError('missing_field', 'modules', `Artifact: ${shapes.of.modules}`);
    throw shapeError('missing_field', 'code', shapes.bodies);
  }
  const extra = bodies[1] ?? ARTIFACT_KEYS.find((k) => k !== body && keys.includes(k) && !BODY_KEYS[body].includes(k));
  if (extra !== undefined) throw shapeError('unknown_field', extra, `Artifact: ${shapes.of[body]}`);
  const { runtime, code: rawCode, modules: rawModules, entry, include: rawInclude, from, knobs } = raw as Record<string, unknown>;
  if (body === 'from') {
    if (runtime !== undefined && runtime !== 'js') throw shapeError('enum', 'runtime', 'Artifact["runtime"]: "js"');
    const ref = parseStarterRef(ctx.starters, from, knobs, ctx.role);
    if (!limits.runtimes.includes('js')) return { ok: false, error: { code: 'runtime_not_allowed' } };
    const built = await buildStarter(ref, skills);
    // The starter was evaluated when the host loaded its surface: a build failure is the game's, not the caller's.
    if (!built.ok) throw new PlayerThreeError('internal');
    return sized(limits, 'js', built.code, { runtime: 'js', ...ref });
  }
  if (runtime === undefined) throw shapeError('missing_field', 'runtime', body === 'modules' ? 'Artifact["runtime"]: "js"' : 'Artifact["runtime"]: "js" | "wasm"');
  if (body === 'modules' && entry === undefined) throw shapeError('missing_field', 'entry', 'Artifact["entry"]: string (one of the modules keys)');
  if (runtime !== 'js' && runtime !== 'wasm') throw shapeError('enum', 'runtime', body === 'modules' ? 'Artifact["runtime"]: "js"' : 'Artifact["runtime"]: "js" | "wasm"');
  if (rawInclude !== undefined && runtime !== 'js') throw shapeError('unknown_field', 'include', 'Artifact: { runtime: "wasm"; code }');
  if (rawInclude !== undefined && !Array.isArray(rawInclude)) throw shapeError('type', 'include', 'Artifact["include"]: string[] (served skill .js files)');
  const include = rawInclude === undefined ? undefined : [...(rawInclude as unknown[] as string[])];
  let source: PolicySource;
  let code: string;
  if (body === 'code') {
    if (typeof rawCode !== 'string' || rawCode.length === 0) throw shapeError(typeof rawCode === 'string' ? 'range' : 'type', 'code', 'Artifact["code"]: string (nonempty)');
    code = include === undefined ? rawCode : composePolicy(skills, rawCode, include);
    source = { runtime, code: rawCode, ...(include === undefined ? {} : { include }) };
    if (!limits.runtimes.includes(runtime)) return { ok: false, error: { code: 'runtime_not_allowed' } };
  } else {
    if (runtime !== 'js') throw shapeError('enum', 'runtime', 'Artifact["runtime"]: "js"');
    const modules = parseModules(rawModules, entry, skills);
    if (!modules) throw new PlayerThreeError('invalid');
    // Unknown includes are shape errors: reject them before spending a build.
    if (include !== undefined) composePolicy(skills, '', include);
    source = { runtime, modules: Object.fromEntries(modules), entry: entry as string, ...(include === undefined ? {} : { include }) };
    if (!limits.runtimes.includes(runtime)) return { ok: false, error: { code: 'runtime_not_allowed' } };
    const built = await buildPolicy({ entry: entry as string, load: (path) => modules.get(path), skills });
    if (!built.ok) throw new PlayerThreeError('invalid', { message: built.message, location: built.location });
    code = include === undefined ? built.code : composePolicy(skills, built.code, include);
  }
  return sized(limits, runtime, code, source);
}

/** The composed artifact within `maxArtifactBytes` (decoded bytes for base64 WASM), else its `PolicyError`. */
function sized(limits: PolicyLimits, runtime: PolicyArtifact['runtime'], code: string, source: PolicySource):
  { ok: true; artifact: PolicyArtifact; source: PolicySource } | { ok: false; error: PolicyError } {
  if (runtime === 'wasm') {
    if (code.length > Math.ceil(limits.maxArtifactBytes / 3) * 4 + 4) return { ok: false, error: { code: 'too_large' } };
    if (!BASE64.test(code)) return { ok: false, error: { code: 'bad_module' } };
    if (Buffer.byteLength(code, 'base64') > limits.maxArtifactBytes) return { ok: false, error: { code: 'too_large' } };
  } else if (code.length > limits.maxArtifactBytes || Buffer.byteLength(code, 'utf8') > limits.maxArtifactBytes) {
    return { ok: false, error: { code: 'too_large' } };
  }
  return { ok: true, artifact: { runtime, code }, source };
}

/**
 * The starter reference a deploy's source made (spec §11 *Starters*) as spreadable `{from, knobs?}` (a copy), for
 * library versions and `policy_status`; `{}` for any other source or none.
 */
export function starterOf(source: PolicySource | null | undefined): Partial<StarterRef> {
  if (!source || !('from' in source)) return {};
  return { from: source.from, ...(source.knobs === undefined ? {} : { knobs: structuredClone(source.knobs) }) };
}

/** Deploys, rollbacks and imports one commander (lobby) or seat (match) holds at once, running or waiting (spec §11). */
export const MAX_QUEUED_DEPLOYS = 8;

/**
 * Spec §11 *Concurrent deploys*: the policy deploys, rollbacks and imports of one commander in the lobby (they share
 * its version counter) or of one seat in a match run one at a time, in arrival order, each to its own result. A call
 * arriving with MAX_QUEUED_DEPLOYS already running or waiting fails `busy` at once, so a burst cannot grow without
 * bound; a failed call never blocks the ones behind it.
 */
export class DeployQueue {
  private tail: Promise<unknown> = Promise.resolve();
  /** Calls running or waiting. */
  size = 0;

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.size >= MAX_QUEUED_DEPLOYS) return Promise.reject(new PlayerThreeError('busy'));
    this.size++;
    const result = this.tail.then(work).finally(() => { this.size--; });
    this.tail = result.catch(() => {});
    return result;
  }
}

/** An engine location in the composed script, as the JS sandbox reports it in error messages. */
const COMPOSED_AT = /\(policy\.js:(\d+):(\d+)\)/;

/**
 * Spec §11: when a composed artifact (one with `include`) fails `compile`, or `threw` while loading, name the part the
 * engine location falls in by appending own text ` (in <skill>/<path>:<line>:<col>)` for an include file or
 * ` (in code:<line>:<col>)` for `code`. A bundle's location stays in the composed script (its esbuild module comments
 * name each module). Other errors, or sources without `include`, come back unchanged.
 */
export function annotateLoadError(error: PolicyError, source: PolicySource | undefined, skills: readonly SkillDef[]): PolicyError {
  if (!source?.include?.length || (error.code !== 'compile' && error.code !== 'threw') || error.message === undefined) return error;
  const at = COMPOSED_AT.exec(error.message);
  if (!at) return error;
  let line = Number(at[1]);
  const inPart = (part: string): PolicyError => ({ ...error, message: `${error.message} (in ${part}:${line}:${at[2]})` });
  for (const entry of source.include) {
    // Each include part is its file's lines, ended by the joining newline (`composePolicy`).
    const lines = composePolicy(skills, '', [entry]).split('\n').length - 1;
    if (line <= lines) return inPart(entry);
    line -= lines;
  }
  return 'code' in source ? inPart('code') : error;
}

/** Size of an artifact's module: UTF-8 bytes of JS source, decoded bytes of a base64 WASM module. */
export function artifactBytes(artifact: PolicyArtifact): number {
  return Buffer.byteLength(artifact.code, artifact.runtime === 'wasm' ? 'base64' : 'utf8');
}

/** SHA-256 hex of an artifact's module bytes (the composed JS source as UTF-8, or the decoded WASM module). */
export function policyArtifactHash(artifact: Pick<PolicyArtifact, 'runtime' | 'code'>): string {
  return createHash('sha256').update(Buffer.from(artifact.code, artifact.runtime === 'wasm' ? 'base64' : 'utf8')).digest('hex');
}

/** Validate untrusted args against a schema after snapshotting them; throws `PlayerThreeError('invalid')`. */
export function parseArgs<S extends Schema>(schema: S, raw: unknown): Infer<S> {
  const snap = snapshot(raw);
  if (!snap.ok) throw new PlayerThreeError('invalid');
  const r = validateUnknown(schema, snap.value);
  if (!r.ok) throw new PlayerThreeError('invalid');
  // Sound: `validate` just proved `r.value` conforms to `schema`.
  return r.value as Infer<S>;
}

/** C0/C1 controls (except tab and newline) and bidi overrides/isolates: never accepted in chat text. */
const CHAT_FORBIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

/** Untrusted chat text: a string of 1..max chars with something besides whitespace. Throws `PlayerThreeError('invalid')`. */
export function parseChatText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') throw new PlayerThreeError('invalid');
  const text = raw.normalize('NFC');
  if (text.length === 0 || text.length > max || text.trim().length === 0 || CHAT_FORBIDDEN.test(text)) throw new PlayerThreeError('invalid');
  return text;
}

/** Chat recipients: `all` or a non-empty list of distinct roles. Throws `PlayerThreeError('invalid')`. */
export function parseChatRoles(raw: unknown, roles: readonly string[]): string[] {
  if (raw === 'all') return [...roles];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > roles.length) throw new PlayerThreeError('invalid');
  const out = new Set<string>();
  for (const r of raw) {
    if (typeof r !== 'string' || !roles.includes(r) || out.has(r)) throw new PlayerThreeError('invalid');
    out.add(r);
  }
  return [...out];
}
