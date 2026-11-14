/**
 * `playerthree policy practice`: local headless practice (SPEC §13) of a policy file, or with `--from` of one of the
 * game's starters (spec §11 *Starters*), against the game's built-in bots, through the host's own request parser and
 * runner (`practiceLocal`), so the result is exactly a `practice_run` result.
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Script } from 'node:vm';
import { servedSkills, type PolicySource, type PracticeResult, type SkillDef } from 'playerthree';
import { PlayerThreeError, practiceLocal } from 'playerthree/host';
import { buildPolicy } from 'playerthree/policy';
import type { EnumS } from 'playerthree/schema';
import { loadDefinition } from './load.ts';
import type { Io } from './main.ts';
import { diskLoader } from './policy-build.ts';
import { UsageError } from './usage.ts';

/** Largest practice seed (`practice_run` seed bound). */
const MAX_SEED = 2 ** 31 - 1;

/**
 * Whether a `.js` file is an ES module: it does not parse as a classic script and the engine blames module syntax.
 * Other syntax errors stay classic so the sandbox reports them as `compile` with their location.
 */
function hasModuleSyntax(code: string, file: string): boolean {
  try {
    new Script(code, { filename: file });
    return false;
  } catch (e) {
    return e instanceof SyntaxError && /\b(import|export)\b/.test(e.message);
  }
}

/**
 * Bundle `file` once with `buildPolicy`, reading only files under its directory, and return the modules the bundle
 * used: practice then submits them as a `modules` artifact, so the host's own parse (limits, includes, bundling) runs.
 */
async function moduleArtifact(file: string, skills: readonly SkillDef[]): Promise<{ modules: Record<string, string>; entry: string }> {
  const disk = diskLoader(file);
  const modules: Record<string, string> = {};
  const load = (path: string): string | undefined => {
    const source = disk.load(path);
    if (source !== undefined) modules[path] = source;
    return source;
  };
  const built = await buildPolicy({ entry: disk.entry, load, skills });
  if (!built.ok) throw new Error(`build failed: ${built.message}${at(built.location)}`);
  return { modules, entry: disk.entry };
}

function at(location: { file: string; line: number; column: number } | undefined): string {
  return location ? ` (${location.file}:${location.line}:${location.column})` : '';
}

function intFlag(flag: string, v: string | undefined, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < min || n > max) throw new UsageError(`${flag} must be an integer ${min}..${max}`);
  return n;
}

function tier(flag: string, v: string | undefined, tiers: readonly string[]): string | undefined {
  if (v !== undefined && !tiers.includes(v)) throw new UsageError(`${flag} must be one of ${tiers.join(', ')}; got ${JSON.stringify(v)}`);
  return v;
}

function formatResult(r: PracticeResult): string {
  const p = r.policy;
  const lines = [
    r.ok ? `outcome ${r.outcome} after ${r.ticks} ticks (${r.wallMs} ms)` : `practice failed: ${r.code} (${r.wallMs} ms)`,
    `policy v${p.version} ${p.runtime}: calls ${p.calls}, meanMs ${p.meanMs.toFixed(2)}, maxMs ${p.maxMs.toFixed(2)}, errors ${p.errors}, timeouts ${p.timeouts}, ` +
      `intentsEmitted ${p.intentsEmitted}, intentsRejected ${p.intentsRejected.length ? p.intentsRejected.map((x) => `${x.code}×${x.count}`).join(' ') : 'none'}`,
  ];
  if (p.lastInvalid) lines.push(`lastInvalid: ${p.lastInvalid.schemaCode} at ${JSON.stringify(p.lastInvalid.path)}, expected ${p.lastInvalid.expected}`);
  if (p.lastError) lines.push(`lastError: ${p.lastError.code}${p.lastError.message ? `: ${p.lastError.message}` : ''}`);
  lines.push(`logs (${p.logs.length}):`, ...p.logs.map((l) => `  ${l}`));
  if (r.ok) lines.push('report:', JSON.stringify(r.report, null, 2).replace(/^/gm, '  '));
  return lines.join('\n');
}

export async function policyPracticeCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      seat: { type: 'string' },
      teams: { type: 'string' },
      options: { type: 'string' },
      include: { type: 'string', multiple: true },
      opponent: { type: 'string' },
      allies: { type: 'string' },
      seed: { type: 'string' },
      ticks: { type: 'string' },
      json: { type: 'boolean' },
      export: { type: 'string' },
      from: { type: 'string' },
      knobs: { type: 'string' },
    },
  });
  const [modulePath, policyPath] = positionals;
  const fromStarter = values.from !== undefined;
  if (!modulePath || (fromStarter ? positionals.length > 1 || values.include?.length : !policyPath || positionals.length > 2)) {
    throw new UsageError('usage: playerthree policy practice <module> <file> [options] | playerthree policy practice <module> --from <skill>/<path>.js [--knobs <json>] [options]');
  }
  if (!fromStarter && values.knobs !== undefined) throw new UsageError('--knobs goes with --from');
  const def = await loadDefinition(modulePath, values.export);
  const m = def.manifest;
  const maxTicks = m.control.practice?.maxTicks;
  if (maxTicks === undefined || !m.control.policy) throw new Error(`${m.id} has no policy practice mode`);
  const tiers = (m.opponents as EnumS).values;
  let seat: { team: string; role: string } | undefined;
  if (values.seat !== undefined) {
    const [team, role, ...extra] = values.seat.split('/');
    const teams = (m.teams as EnumS).values;
    const roles = (m.roles as EnumS).values;
    if (!team || !role || extra.length || !teams.includes(team) || !roles.includes(role)) {
      throw new UsageError(`--seat must be team/role with team in ${teams.join(', ')} and role in ${roles.join(', ')}`);
    }
    seat = { team, role };
  }
  const declaredTeams = (m.teams as EnumS).values;
  const teams = values.teams?.split(',');
  if (teams && (teams.some((team) => !declaredTeams.includes(team)) || new Set(teams).size !== teams.length)) {
    throw new UsageError(`--teams must list distinct teams of ${declaredTeams.join(', ')}, comma-separated`);
  }
  if (teams && seat && !teams.includes(seat.team)) throw new UsageError('--seat must be on one of --teams');
  let options: Record<string, unknown> | undefined;
  if (values.options !== undefined) {
    try {
      options = JSON.parse(values.options) as Record<string, unknown>;
    } catch {
      throw new UsageError('--options must be a JSON object of match options');
    }
  }
  const opponent = tier('--opponent', values.opponent, tiers) ?? tiers[tiers.length - 1]!;
  const allies = tier('--allies', values.allies, tiers);
  const seed = intFlag('--seed', values.seed, 0, MAX_SEED);
  const ticks = intFlag('--ticks', values.ticks, 1, maxTicks) ?? maxTicks;

  let artifact: PolicySource;
  if (fromStarter) {
    let knobs: Record<string, unknown> | undefined;
    try {
      knobs = values.knobs === undefined ? undefined : JSON.parse(values.knobs) as Record<string, unknown>;
    } catch {
      throw new UsageError('--knobs must be a JSON object of the starter\'s knobs');
    }
    artifact = { from: values.from!, ...(knobs === undefined ? {} : { knobs }) };
  } else {
    const file = resolve(policyPath!);
    const code = await readFile(file, 'utf8');
    const include = values.include?.length ? { include: values.include } : {};
    const ext = extname(file);
    const isModule = ext === '.ts' || ext === '.mts' || ext === '.mjs' || hasModuleSyntax(code, file);
    artifact = isModule
      ? { runtime: 'js', ...(await moduleArtifact(file, servedSkills(m))), ...include }
      : { runtime: 'js', code, ...include };
  }
  let result: PracticeResult;
  try {
    result = await practiceLocal(def, {
      opponent,
      ticks,
      artifact,
      ...(allies === undefined ? {} : { allies }),
      ...(seed === undefined ? {} : { seed }),
      ...(options === undefined ? {} : { options }),
    }, { ...(seat ? { seat } : {}), ...(teams ? { teams } : {}) });
  } catch (e) {
    // The host's own build or artifact check rejected it: say why, where the host has an own-text or schema detail.
    if (e instanceof PlayerThreeError && e.detail) {
      const d = e.detail;
      throw new Error('schemaCode' in d ? `${e.code} (${d.schemaCode}) at ${JSON.stringify(d.path)}: expected ${d.expected}` : `${e.code}: ${d.message}${at(d.location)}`);
    }
    throw e;
  }
  io.out(values.json ? JSON.stringify(result) : formatResult(result));
  return result.ok ? 0 : 1;
}
