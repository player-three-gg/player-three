/**
 * `playerthree` CLI: lint, audit, dev, db reset, types, policy build/practice/export/import.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { planPostgresReset, resetPostgresStorage } from 'playerthree/postgres/reset';
import { auditDefinition, auditRemote, formatAuditReport } from './audit.ts';
import { devBanner, startDevServer } from './dev.ts';
import { formatLintReport, lintDefinition } from './lint.ts';
import { loadDefinition } from './load.ts';
import { policyBuildCommand } from './policy-build.ts';
import { policyPracticeCommand } from './policy-practice.ts';
import { policyExportCommand, policyImportCommand } from './policy-package.ts';
import { typesCommand } from './types.ts';
import { joinStringOptions } from '@playerthree/runner';
import { safetyCard } from './safety.ts';
import { UsageError } from './usage.ts';

const HELP = `playerthree — tools for games with agent seats

Usage:
  playerthree lint  <module> [--every 10] [--price model=usdPerMtok]... [--ticks 600] [--seed 1] [--warn-tokens 8000] [--max-tokens 64000] [--json] [--export definition]
  playerthree audit <module> [--out SAFETY.md] [--json] [--seed 1] [--export definition]
  playerthree audit --url <mcp url> --token <seat token> [--expect-hash <sha256>] [--out SAFETY.md] [--json]
  playerthree dev   <module> [--port 8787] [--host 127.0.0.1] [--seat team/role] [--now] [--seed 1] [--export definition]
  playerthree db reset [--migrations <scope>=<dir>]... --yes [--confirm <database>]
  playerthree types <module> [--role <role>] [--brief] [--out policy.d.ts] [--export definition]
  playerthree policy build <entry> [--game <module>] [--include <skill>/<path>]... [--out policy.js] [--export definition]
  playerthree policy practice <module> <file> [--seat team/role] [--teams t1,t2] [--options <json>] [--include <skill>/<path>]... [--opponent <tier>]
                              [--allies <tier>] [--seed 1] [--ticks N] [--json] [--export definition]
  playerthree policy export <module> --store <dir> --owner <owner> --commander <id> [--version N] [--license <spdx>]
                            [--author <name>] [--out policy.json] [--export definition]
  playerthree policy import <module> <package.json> --store <dir> --owner <owner> --commander <id> [--export definition]

<module> is a file exporting a GameDefinition (default export name: \`definition\`).

lint   Worst-case and typical observation size, $/hour for a polling agent, docs, vocabulary and list-bound checks.
       Exits 1 on errors.
audit  Fuzzes every intent and control method against a live host (in-process, or a remote MCP endpoint), checks
       that responses stay inside the closed vocabulary and never echo input, prints the surface hash and writes a
       Safety Card. Exits 1 on failures.
dev    Runs the game on a local PlayerThreeHost with MCP (/mcp) and DevTools, the operator console (/playerthree/devtools), creates
       a match with your agent on one seat and built-in bots everywhere else, and prints the console link and a ready-to-paste
       agent command. The match clock starts when the agent first observes or acts (--now: immediately).
db reset  Drops an obsolete PlayerThree PostgreSQL database's tables (DATABASE_URL; playerthree_*, the migration
       ledger and each given scope's recorded tables, nothing else) in one transaction, then re-applies the migrations.
       Needs --yes and the database name, typed at the prompt or as --confirm. Exits 1 on any mismatch.
types  TypeScript declarations for the game's policy vocabulary (Observation, Intent, MatchData, Think, Init, log).
policy build     Bundles an ES-module or TypeScript policy entry into one classic script for policy_deploy.
policy practice  Local headless practice_run against built-in bots; prints the report and the policy's log lines.
policy export    Writes a commander library version (default: its active one) from a JSON commander store directory
                 (a host's <dataDir>/commanders/<game id>) as a portable playerthree.policy/1 package (canonical JSON).
policy import    Verifies a package (hash, game, role, runtime, script hash; rebuilds its source on this surface) and
                 adds it to the commander's library as a new, inactive version. Never run export/import while another
                 process serves the store.

--out -  skips writing the Safety Card.
`;

/** Output and terminal capabilities of one CLI run, injectable for tests. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  color: boolean;
  /** Environment for `db` (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** stdin and stdout are both terminals (default false). */
  interactive?: boolean;
  /** Reads one answer line (required when interactive). */
  prompt?(question: string): Promise<string>;
}

const defaultIo: Io = {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  env: process.env,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
};

function parsePrices(list: string[] | undefined): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const item of list ?? []) {
    const m = /^([^=]+)=([0-9]*\.?[0-9]+)$/.exec(item);
    if (!m) throw new UsageError(`--price expects model=usdPerMtok, got ${JSON.stringify(item)}`);
    prices[m[1]!.trim()] = Number(m[2]);
  }
  return prices;
}

function positiveNumber(flag: string, v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number`);
  return n;
}

async function lint(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      every: { type: 'string' },
      price: { type: 'string', multiple: true },
      ticks: { type: 'string' },
      seed: { type: 'string' },
      json: { type: 'boolean' },
      export: { type: 'string' },
      'warn-tokens': { type: 'string' },
      'max-tokens': { type: 'string' },
    },
  });
  const path = positionals[0];
  if (!path) throw new UsageError('lint needs a module path');
  const def = await loadDefinition(path, values.export);
  const report = lintDefinition(def, {
    everySeconds: positiveNumber('--every', values.every, 10),
    prices: parsePrices(values.price),
    sampleTicks: positiveNumber('--ticks', values.ticks, 600),
    seed: positiveNumber('--seed', values.seed, 1),
    warnTokens: positiveNumber('--warn-tokens', values['warn-tokens'], 8000),
    maxTokens: positiveNumber('--max-tokens', values['max-tokens'], 64_000),
  });
  io.out(values.json ? JSON.stringify(report, null, 2) : formatLintReport(report, io.color));
  return report.ok ? 0 : 1;
}

async function audit(argv: string[], io: Io): Promise<number> {
  const options = {
    url: { type: 'string' },
    token: { type: 'string' },
    'expect-hash': { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean' },
    export: { type: 'string' },
    seed: { type: 'string' },
  } as const;
  // Seat tokens are base64url and may start with '-'; parseArgs would read `--token -abc` as a missing value.
  const { values, positionals } = parseArgs({ args: joinStringOptions(argv, options), allowPositionals: true, options });
  const path = positionals[0];
  if (path && values.url) throw new UsageError('give either a module path or --url, not both');
  const seed = positiveNumber('--seed', values.seed, 1);
  let report;
  if (values.url) {
    if (!values.token) throw new UsageError('--url needs --token <seat token>');
    report = await auditRemote(values.url, values.token, { seed, expectHash: values['expect-hash'] });
  } else if (path) {
    report = await auditDefinition(await loadDefinition(path, values.export), { seed });
  } else {
    throw new UsageError('audit needs a module path or --url');
  }
  const out = values.out ?? 'SAFETY.md';
  if (out !== '-') await writeFile(out, safetyCard(report));
  if (values.json) {
    const { surface: _s, ...rest } = report;
    io.out(JSON.stringify(rest, null, 2));
  } else {
    io.out(formatAuditReport(report, io.color));
    if (out !== '-') io.out(`\nSafety Card written to ${out}`);
  }
  return report.ok ? 0 : 1;
}

async function dev(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      seat: { type: 'string' },
      now: { type: 'boolean' },
      seed: { type: 'string' },
      export: { type: 'string' },
    },
  });
  const path = positionals[0];
  if (!path) throw new UsageError('dev needs a module path');
  const def = await loadDefinition(path, values.export);
  const port = values.port === undefined ? 8787 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be 0..65535');
  const d = await startDevServer(def, { port, host: values.host, seat: values.seat, seed: positiveNumber('--seed', values.seed, 1), startNow: values.now });
  io.out(devBanner(d, def, io.color));
  d.match.onEnd((outcomes) => {
    io.out(`\nmatch ${d.match.id} ended: ${Object.entries(outcomes).map(([t, o]) => `${t} ${o}`).join(', ')} (DevTools stays up; Ctrl-C to stop)`);
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  process.once('SIGINT', () => resolve());
  process.once('SIGTERM', () => resolve());
  await promise;
  await d.close();
  return 0;
}

async function db(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      migrations: { type: 'string', multiple: true },
      yes: { type: 'boolean' },
      confirm: { type: 'string' },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== 'reset') throw new UsageError('usage: playerthree db reset [--migrations <scope>=<dir>]... --yes [--confirm <database>]');
  const url = (io.env ?? process.env).DATABASE_URL;
  if (!url) throw new UsageError('DATABASE_URL is not set (the connection string is read from the environment only)');
  const migrations = (values.migrations ?? []).map((item) => {
    const m = /^([^=]+)=(.+)$/.exec(item);
    if (!m) throw new UsageError(`--migrations expects <scope>=<dir>, got ${JSON.stringify(item)}`);
    return { scope: m[1]!, dir: resolve(m[2]!) };
  });
  const plan = await planPostgresReset({ url, migrations });
  io.out(`host ${plan.host}, database ${plan.database}, schema ${plan.schema}`);
  io.out(`drop ${plan.tables.length} table(s):${plan.tables.map((t) => `\n  ${t}`).join('')}`);
  io.out(`drop ${plan.ledger.length} migration-ledger row(s):${plan.ledger.map((r) => `\n  ${r.scope}/${r.name}`).join('')}`);
  io.out(`then migrate: ${['playerthree', ...migrations.map((s) => s.scope)].join(', ')}`);
  if (!values.yes) {
    io.err('playerthree db: refusing without --yes; nothing was dropped');
    return 1;
  }
  let typed = values.confirm;
  if (typed === undefined) {
    if (!io.interactive || !io.prompt) {
      io.err('playerthree db: not a terminal; pass --confirm <database> to confirm non-interactively; nothing was dropped');
      return 1;
    }
    typed = (await io.prompt(`Type the database name (${plan.database}) to drop these tables: `)).trim();
  }
  if (typed !== plan.database) {
    io.err(`playerthree db: confirmation does not match database ${plan.database}; nothing was dropped`);
    return 1;
  }
  const ledger = await resetPostgresStorage({ url, migrations, plan });
  io.out(`reset ${plan.database}: dropped ${plan.tables.length} table(s); applied ${ledger.map((r) => `${r.scope}/${r.name}`).join(', ')}`);
  return 0;
}

/** Runs one CLI invocation (`argv` without the node and script paths); resolves to the process exit code. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'lint':
        return await lint(rest, io);
      case 'audit':
        return await audit(rest, io);
      case 'dev':
        return await dev(rest, io);
      case 'db':
        return await db(rest, io);
      case 'types':
        return await typesCommand(rest, io);
      case 'policy': {
        const [sub, ...args] = rest;
        if (sub === 'build') return await policyBuildCommand(args, io);
        if (sub === 'practice') return await policyPracticeCommand(args, io);
        if (sub === 'export') return await policyExportCommand(args, io);
        if (sub === 'import') return await policyImportCommand(args, io);
        throw new UsageError('usage: playerthree policy build|practice|export|import …');
      }
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        io.out(HELP);
        return cmd === undefined ? 1 : 0;
      default:
        io.err(`unknown command ${JSON.stringify(cmd)}\n\n${HELP}`);
        return 1;
    }
  } catch (e) {
    if (e instanceof UsageError || (e instanceof Error && 'code' in e && typeof e.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS'))) {
      io.err(`playerthree ${cmd}: ${e.message}`);
      return 2;
    }
    io.err(`playerthree ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
