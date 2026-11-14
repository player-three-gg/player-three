/**
 * Headless practice: a fresh match of the given sides where the seat under test is driven by a policy and every other
 * seat by a built-in bot (its own team and allied teams at `allies`, everyone else at `opponent`). Runs as fast as the
 * policy allows, yielding to the event loop regularly so live matches on the same server keep their tick rate.
 */
import { setImmediate as yieldTick } from 'node:timers/promises';
import { servedSkills } from '../briefing.ts';
import type { Mandate, PolicyArtifact, PolicyError, PolicySource, PracticeRequest, PracticeResult } from '../control.ts';
import { createGuard } from '../guard.ts';
import { intentSchema, observationSections, type AnyManifest, type GameDefinition, type IntentSource, type SkillDef } from '../manifest.ts';
import { LIMITS } from '../mcp/surface.ts';
import { starterCatalog } from '../policy/starters.ts';
import { t, type EnumS } from '../schema.ts';
import { isSignalIntent, SignalBoard, withSignals } from '../signals.ts';
import {
  annotateLoadError,
  applyIntent,
  checkIntent,
  defaultMandate,
  looseDefinition,
  matchDataFor,
  mergeMatchOptions,
  parseArgs,
  parseArtifact,
  parseMatchOptions,
  rejectCode,
  type LooseDefinition,
  type SeatKey,
  type Sides,
  type Sim,
} from './pipeline.ts';
import { emptyStats, loadSeatArtifact, PolicyRun } from './policy.ts';
import { createSeatBot, eachBot, type SeatBot } from './seat-bot.ts';
import { PlayerThreeError } from './util.ts';

/** Max wall time between event-loop yields. */
const SLICE_MS = 8;

export interface PracticeSpec extends Sides {
  definition: LooseDefinition;
  /** On one of `teams`. */
  seat: SeatKey;
  opponent: string;
  allies: string;
  ticks: number;
  seed: number;
  /** Validated match options (undefined: game defaults). */
  options?: Record<string, unknown> | undefined;
  artifact: PolicyArtifact;
  /** The request an inline artifact came from (absent for deployed versions): load failures name their part (§11). */
  source?: PolicySource | undefined;
  version: number;
  mandate: Mandate;
}

/** Ticks between bot/policy decisions: policy hz (or every tick without a policy mode). */
export function thinkPeriod(m: AnyManifest): number {
  return Math.max(1, Math.round(m.tickRate / (m.control.policy?.hz ?? m.tickRate)));
}

/** A validated `practice_run` request; the caller resolves a missing artifact and applies its own defaults. */
export interface ParsedPracticeRequest {
  opponent: string;
  /** Undefined: the same tier as `opponent`. */
  allies: string | undefined;
  /** 1..`control.practice.maxTicks`. */
  ticks: number;
  seed: number | undefined;
  /** Validated against `manifest.matchOptions`, unmerged; undefined when not given. */
  options: Record<string, unknown> | undefined;
  /** Concurrent practice runs allowed per principal (`control.practice.concurrent`). */
  concurrent: number;
  /**
   * The inline artifact parsed by `parseArtifact` (§11); undefined: practice the seat's active policy. A rejected
   * artifact keeps its PolicyError so local practice can report it; hosts answer `invalid`.
   */
  artifact: { ok: true; artifact: PolicyArtifact; source: PolicySource } | { ok: false; error: PolicyError } | undefined;
}

/**
 * The one validation of a practice request shared by every entry point (live seat, commander lobby, local practice):
 * the `practice_run` argument schema bounded by `maxTicks`, the manifest's opponents and options, and the artifact
 * rules (a starter reference must play `role`, the tested seat's). Throws `mode_unavailable` without practice and
 * policy modes, `invalid` for malformed arguments; `options` and artifact shape failures carry their closed
 * `{schemaCode, path, expected}` under `["options", …]` / `["artifact", …]` (the tool schema leaves the options schema
 * and the artifact's member combinations to the host).
 */
export async function parsePracticeRequest(manifest: AnyManifest, skills: readonly SkillDef[], raw: unknown, role: string): Promise<ParsedPracticeRequest> {
  const practice = manifest.control.practice;
  if (!practice) throw new PlayerThreeError('mode_unavailable');
  const limits = manifest.control.policy;
  if (!limits) throw new PlayerThreeError('mode_unavailable');
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new PlayerThreeError('invalid');
  const { artifact, options, ...rest } = raw as Record<string, unknown>;
  const opponents = manifest.opponents as EnumS;
  const req = parseArgs(
    t.obj({
      opponent: opponents,
      ticks: t.int(1, practice.maxTicks),
      seed: t.opt(t.int(0, LIMITS.maxSeed)),
      allies: t.opt(opponents),
    }),
    rest,
  ) as { opponent: string; ticks: number; seed?: number; allies?: string };
  const parsedOptions = parseMatchOptions(manifest, options, ['options']);
  let parsedArtifact: ParsedPracticeRequest['artifact'];
  try {
    parsedArtifact = artifact === undefined ? undefined : await parseArtifact(artifact, limits, { skills, starters: starterCatalog(manifest), role });
  } catch (e) {
    if (e instanceof PlayerThreeError && e.detail && 'schemaCode' in e.detail) throw new PlayerThreeError(e.code, { ...e.detail, path: ['artifact', ...e.detail.path] });
    throw e;
  }
  return {
    opponent: req.opponent,
    allies: req.allies,
    ticks: req.ticks,
    seed: req.seed,
    options: parsedOptions,
    concurrent: practice.concurrent,
    artifact: parsedArtifact,
  };
}

/** A practice that never got a running policy: no outcome, ticks or report (§4 `PracticeResult`). */
function policyFailure(version: number, runtime: PolicyArtifact['runtime'], error: PolicyError, started: number): PracticeResult {
  const policy = emptyStats(version, runtime);
  policy.errors = 1;
  policy.lastError = error;
  return { ok: false, code: 'policy', policy, wallMs: Math.round(performance.now() - started) };
}

/**
 * Practice without a host (§13): the given teams (default every manifest team; a nonempty subset in manifest order,
 * as a host's match sides are), `seat` (default the first of those teams and the first role) on the game's default
 * mandate, statistics version 0, seed 1 unless given, no concurrency bound. Same parser and runner as `practice_run`,
 * so the result has exactly its shape; a rejected artifact is a `policy` failure carrying its PolicyError.
 */
export async function practiceLocal<M extends AnyManifest>(
  definition: GameDefinition<M>,
  request: Omit<PracticeRequest, 'artifact'> & { artifact: PolicySource },
  opts: { seat?: SeatKey; teams?: readonly string[] } = {},
): Promise<PracticeResult> {
  const started = performance.now();
  const m: AnyManifest = definition.manifest;
  const declared = (m.teams as EnumS).values;
  const teams = opts.teams === undefined ? declared : declared.filter((team) => opts.teams!.includes(team));
  if (teams.length === 0 || (opts.teams !== undefined && teams.length !== new Set(opts.teams).size)) throw new PlayerThreeError('invalid');
  const roles = (m.roles as EnumS).values;
  const seat = opts.seat ?? { team: teams[0]!, role: roles[0]! };
  if (!teams.includes(seat.team) || !roles.includes(seat.role)) throw new PlayerThreeError('invalid');
  const req = await parsePracticeRequest(m, servedSkills(m), request, seat.role);
  if (!req.artifact) throw new PlayerThreeError('invalid');
  if (!req.artifact.ok) return policyFailure(0, request.artifact.runtime ?? 'js', req.artifact.error, started);
  return runPractice({
    definition: looseDefinition(definition),
    seat: { team: seat.team, role: seat.role },
    teams,
    opponent: req.opponent,
    allies: req.allies ?? req.opponent,
    ticks: req.ticks,
    seed: req.seed ?? 1,
    options: mergeMatchOptions(m.matchOptions, undefined, req.options),
    artifact: req.artifact.artifact,
    source: req.artifact.source,
    version: 0,
    mandate: defaultMandate(m),
  });
}

export async function runPractice(spec: PracticeSpec): Promise<PracticeResult> {
  const started = performance.now();
  const { definition, seat } = spec;
  const m = definition.manifest;
  const limits = m.control.policy!;
  let run: PolicyRun | undefined;
  const bots: { seat: SeatKey; bot: SeatBot; since: number }[] = [];
  try {
    const sides: Sides = spec.alliances ? { teams: spec.teams, alliances: spec.alliances } : { teams: spec.teams };
    const adapter = definition.create({ seed: spec.seed, ...(spec.options === undefined ? {} : { options: spec.options }), ...sides });
    const friends = Object.values(spec.alliances ?? {}).find((members) => members.includes(seat.team)) ?? [seat.team];
    const sim: Sim = { manifest: m, adapter, guard: createGuard({ onDrop: () => {} }), record: () => {} };
    // Practice teammates are bots that answer (and send) team signals exactly as in a live match.
    const signals = m.signals ? new SignalBoard(m, spec.teams, SignalBoard.limitsFor(m, adapter)) : undefined;
    const observe = (s: SeatKey, since: number, detail: readonly string[]): unknown => {
      const raw = adapter.observe(s, since, detail);
      return signals ? withSignals(raw, signals.seat(s.team, s.role)) : raw;
    };
    const apply = (s: SeatKey, intent: { kind: string } & Record<string, unknown>, source: IntentSource) =>
      signals && isSignalIntent(m, intent) ? signals.apply(s.team, s.role, intent, adapter.tick) : applyIntent(sim, s, intent, { source });
    const schema = intentSchema(m);
    const period = thinkPeriod(m);
    const fallbackMandate = defaultMandate(m);
    for (const team of spec.teams) {
      for (const role of (m.roles as EnumS).values) {
        const s: SeatKey = { team, role };
        const testee = team === seat.team && role === seat.role;
        adapter.setSeatInfo(s, { controller: testee ? 'agent' : 'bot', mandate: structuredClone(testee ? spec.mandate : fallbackMandate) });
        if (testee) continue;
        const bot = createSeatBot(definition, s, friends.includes(team) ? spec.allies : spec.opponent, undefined, spec.seed);
        bot.init?.(matchDataFor(sim, s));
        bots.push({ seat: s, bot, since: 0 });
      }
    }
    const matchData = matchDataFor(sim, seat);
    const loaded = await loadSeatArtifact(spec.artifact, limits, spec.seed, matchData, m, seat.role);
    if (!loaded.ok) return policyFailure(spec.version, spec.artifact.runtime, annotateLoadError(loaded.error, spec.source, servedSkills(m)), started);
    run = new PolicyRun(spec.version, spec.artifact, loaded.instance, limits, spec.seed, matchData, loaded.detail);
    // Built-in bots are game code: every observation section in full.
    const botDetail = observationSections(m);
    let policySince = 0;
    let lastYield = performance.now();
    while (adapter.tick < spec.ticks && adapter.outcome(seat.team) === 'running') {
      const tick = adapter.tick;
      if (tick % period === 0) {
        // Bot packages answer synchronously, under one trusted hang guard for the round (spec §11 *Trusted runner*).
        let guardFailed = false;
        eachBot(bots, (i) => {
          const b = bots[i]!;
          if (guardFailed) return;
          const obs = sim.guard.pass('observation', m.observation, observe(b.seat, b.since, botDetail));
          b.since = tick;
          if (!obs.ok) {
            guardFailed = true;
            return;
          }
          for (const raw of b.bot.think(obs.value)) {
            const c = checkIntent(m, schema, b.seat.role, raw);
            if (c.ok) apply(b.seat, c.intent, 'bot');
          }
        });
        if (guardFailed) return { ok: false, code: 'guard', policy: run.snapshot(), wallMs: Math.round(performance.now() - started) };
        if (run.active) {
          const obs = sim.guard.pass('observation', m.observation, observe(seat, policySince, run.detail));
          policySince = tick;
          if (!obs.ok) return { ok: false, code: 'guard', policy: run.snapshot(), wallMs: Math.round(performance.now() - started) };
          if (obs.ok) {
            const out = await run.think(obs.value);
            for (const raw of out.intents) {
              const c = checkIntent(m, schema, seat.role, raw);
              const ack = c.ok ? apply(seat, c.intent, 'policy') : c.ack;
              const code = rejectCode(ack);
              if (code) run.reject(code, 1, !ack.ok && ack.code === 'invalid' ? ack : undefined);
            }
          }
        }
      }
      adapter.step();
      signals?.advance(adapter.tick);
      if (performance.now() - lastYield > SLICE_MS) {
        await yieldTick();
        lastYield = performance.now();
      }
    }
    const report = sim.guard.pass('report', m.report, adapter.report(seat.team));
    if (!report.ok) return { ok: false, code: 'guard', policy: run.snapshot(), wallMs: Math.round(performance.now() - started) };
    return {
      ok: true,
      outcome: adapter.outcome(seat.team),
      ticks: adapter.tick,
      report: report.value,
      policy: run.snapshot(),
      wallMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    if (!(error instanceof PlayerThreeError) || error.code !== 'internal') throw error;
    return { ok: false, code: 'guard', policy: run?.snapshot() ?? emptyStats(spec.version, spec.artifact.runtime), wallMs: Math.round(performance.now() - started) };
  } finally {
    run?.dispose();
    for (const b of bots) b.bot.dispose?.();
  }
}
