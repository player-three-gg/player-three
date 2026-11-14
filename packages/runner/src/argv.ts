/**
 * Seat tokens are base64url and may start with `-`, which `node:util` parseArgs rejects as an ambiguous option
 * value in `--token -abc…`. Rewrite `--name value` to `--name=value` for string options so pasted commands work.
 */
export function joinStringOptions(argv: readonly string[], options: Readonly<Record<string, { type: 'string' | 'boolean' }>>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const name = arg.startsWith('--') && !arg.includes('=') ? arg.slice(2) : undefined;
    if (name !== undefined && options[name]?.type === 'string' && i + 1 < argv.length) {
      out.push(`${arg}=${argv[i + 1]}`);
      i += 1;
    } else out.push(arg);
  }
  return out;
}
