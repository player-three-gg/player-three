/**
 * `playerthree types <module> [--role r] [--brief] [--out file] [--export name]`: the game's generated TypeScript
 * declarations (`manifestDts`, spec §11 *Generated types*), fully documented by default; `--brief` keeps bound notes
 * only, the exact text the `types` / `types/<role>` briefing topics serve.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { manifestDts, type EnumS } from 'playerthree';
import { loadDefinition } from './load.ts';
import type { Io } from './main.ts';
import { UsageError } from './usage.ts';

export async function typesCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      role: { type: 'string' },
      brief: { type: 'boolean' },
      out: { type: 'string' },
      export: { type: 'string' },
    },
  });
  const path = positionals[0];
  if (!path || positionals.length > 1) throw new UsageError('usage: playerthree types <module> [--role <role>] [--brief] [--out policy.d.ts] [--export definition]');
  const { manifest } = await loadDefinition(path, values.export);
  const roles = (manifest.roles as EnumS).values;
  if (values.role !== undefined && !roles.includes(values.role)) throw new UsageError(`--role must be one of ${roles.join(', ')}`);
  const dts = manifestDts(manifest, { ...(values.role === undefined ? {} : { role: values.role }), docs: values.brief ? 'bounds' : 'full' });
  if (values.out === undefined) {
    // `io.out` appends the newline the declarations already end with.
    io.out(dts.slice(0, -1));
    return 0;
  }
  await writeFile(values.out, dts);
  io.out(`wrote ${values.out}`);
  return 0;
}
