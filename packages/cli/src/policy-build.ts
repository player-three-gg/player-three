/**
 * `playerthree policy build <entry> [--game <module>] [--include <skill>/<path>]... [--out file] [--export name]`
 * (spec §17): bundle an ES-module or TypeScript policy with the host's own `buildPolicy`, reading only files under the
 * entry's directory, compose `include` like the host does, and with `--game` check the composed size against the
 * game's `maxArtifactBytes` and resolve includes and skill imports against its served skills.
 * `playerthree policy build --from <skill>/<path>.js [--knobs <json>] [--role <role>] --game <module>` builds one of the
 * game's starters (spec §11 *Starters*) exactly as `policy_deploy {from, knobs}` does: the same reference check and
 * the same generated entry through `buildPolicy`.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { composePolicy, MAX_POLICY_INCLUDES, PlayerThreeError, servedSkills, type EnumS, type SkillDef, type StarterRef } from 'playerthree';
import { buildPolicy, buildStarter, parseStarterRef, starterCatalog, type PolicyBuildResult } from 'playerthree/policy';
import { loadDefinition } from './load.ts';
import type { Io } from './main.ts';
import { UsageError } from './usage.ts';

const USAGE = 'usage: playerthree policy build <entry> [--game <definition-module>] [--include <skill>/<path>]... [--out policy.js] [--export definition]\n' +
  '       playerthree policy build --from <skill>/<path>.js [--knobs <json>] [--role <role>] --game <definition-module> [--out policy.js] [--export definition]';

/**
 * The module root of an entry file: its directory. `load(path)` reads a root-relative POSIX path as UTF-8 when it names
 * a regular file whose real path stays inside the root (no symlink escapes); anything else is `undefined`.
 * `buildPolicy` only asks for paths that already passed the module path grammar (no `..`, no absolute paths).
 */
export function diskLoader(entryFile: string): { entry: string; load(path: string): string | undefined } {
  const root = realpathSync(dirname(resolve(entryFile)));
  return {
    entry: basename(entryFile),
    load(path) {
      try {
        const file = realpathSync(join(root, ...path.split('/')));
        if (!file.startsWith(root + sep) || !lstatSync(file).isFile()) return undefined;
        return readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

export async function policyBuildCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      game: { type: 'string' },
      include: { type: 'string', multiple: true },
      out: { type: 'string' },
      export: { type: 'string' },
      from: { type: 'string' },
      knobs: { type: 'string' },
      role: { type: 'string' },
    },
  });
  const fromStarter = values.from !== undefined;
  const entryFile = positionals[0];
  if (fromStarter ? positionals.length > 0 : !entryFile || positionals.length > 1) throw new UsageError(USAGE);
  const include = values.include ?? [];
  if (fromStarter && (include.length > 0 || values.game === undefined)) throw new UsageError('--from needs --game (starters are the game\'s served skill files) and takes no --include');
  if (!fromStarter && (values.knobs !== undefined || values.role !== undefined)) throw new UsageError('--knobs and --role go with --from');
  if (include.length > 0 && values.game === undefined) throw new UsageError('--include needs --game (includes are the game\'s served skill files)');
  if (values.export !== undefined && values.game === undefined) throw new UsageError('--export needs --game');
  let knobs: unknown;
  if (values.knobs !== undefined) {
    try {
      knobs = JSON.parse(values.knobs);
    } catch {
      throw new UsageError('--knobs must be a JSON object of the starter\'s knobs');
    }
  }

  let skills: readonly SkillDef[] = [];
  let maxBytes: number | undefined;
  let ref: StarterRef | undefined;
  if (values.game !== undefined) {
    const { manifest } = await loadDefinition(values.game, values.export);
    if (!manifest.control.policy) {
      io.err(`${values.game}: this game has no policy mode`);
      return 1;
    }
    skills = servedSkills(manifest);
    maxBytes = manifest.control.policy.maxArtifactBytes;
    if (fromStarter) {
      const starters = starterCatalog(manifest);
      const roles = (manifest.roles as EnumS).values;
      if (values.role !== undefined && !roles.includes(values.role)) throw new UsageError(`--role must be one of ${roles.join(', ')}`);
      try {
        ref = parseStarterRef(starters, values.from, knobs, values.role ?? starters.get(values.from!)?.roles[0]);
      } catch (e) {
        if (!(e instanceof PlayerThreeError) || !e.detail || !('schemaCode' in e.detail)) throw e;
        const { schemaCode, path, expected } = e.detail;
        io.err(`invalid (${schemaCode}) at ${JSON.stringify(path)}: expected ${expected}`);
        return 1;
      }
    }
  }

  let built: PolicyBuildResult;
  if (ref) {
    built = await buildStarter(ref, skills);
  } else {
    const disk = diskLoader(entryFile!);
    built = await buildPolicy({ entry: disk.entry, load: disk.load, skills });
  }
  if (!built.ok) {
    const at = built.location;
    io.err(`${at.file}:${at.line}:${at.column}: ${built.message}`);
    return 1;
  }
  let code: string;
  try {
    code = composePolicy(skills, built.code, include);
  } catch (e) {
    if (!(e instanceof PlayerThreeError)) throw e;
    io.err(`--include: every entry must be a distinct served skill .js file (<skill>/<path>), at most ${MAX_POLICY_INCLUDES}`);
    return 1;
  }
  const bytes = Buffer.byteLength(code, 'utf8');
  if (maxBytes !== undefined && bytes > maxBytes) {
    io.err(`the composed policy is ${bytes} bytes; ${values.game} allows at most ${maxBytes} (maxArtifactBytes)`);
    return 1;
  }
  if (values.out === undefined) {
    // `io.out` appends a newline; the script already ends with one.
    io.out(code.endsWith('\n') ? code.slice(0, -1) : code);
    return 0;
  }
  await writeFile(values.out, code);
  io.out(`wrote ${values.out} (${bytes} bytes)`);
  return 0;
}
