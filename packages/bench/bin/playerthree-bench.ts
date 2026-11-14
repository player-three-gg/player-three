#!/usr/bin/env node
// playerthree-bench: run the benchmark series of a bench config (`--config`), or the `models`, `campaign` and publication subcommands.
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { joinStringOptions } from '@playerthree/runner';
import { evaluateGuardrails, loadBenchConfig, runBench, type BenchConfig } from '../src/index.ts';
import { campaignMain } from '../src/campaign-cli.ts';
import { modelsMain } from '../src/models-cli.ts';

const options = { config: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } as const;
try {
  const command = process.argv[2];
  if (command === 'models') process.exitCode = await modelsMain(process.argv.slice(3));
  else if (command && ['campaign', 'publication', 'validate-publication', 'import-publication'].includes(command)) process.exitCode = await campaignMain(command, process.argv.slice(3));
  else {
  const { values } = parseArgs({ args: joinStringOptions(process.argv.slice(2), options), options, strict: true });
  if (values.help) {
    console.log('Usage: playerthree-bench --config ./bench.config.ts [--out ./bench-results]\nThe module must default-export BenchConfig or BenchConfig[]. Each config freezes an explicit SeriesSpec. All tracks use the same runner; outputs are playerthree.results JSON, table CSVs and authorized replay artifacts. Model keys are read from environment variables. Failed series or guardrails exit nonzero.');
  } else {
    if (!values.config) throw new Error('--config is required (use --help)');
    const loaded = await loadBenchConfig(values.config);
    const configs: readonly BenchConfig[] = Array.isArray(loaded) ? loaded : [loaded as BenchConfig];
    const outDir = resolve(values.out ?? 'bench-results');
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      for (const [index, config] of configs.entries()) {
        if (abort.signal.aborted) { process.exitCode = 1; break; }
        const directory = configs.length === 1 ? outDir : join(outDir, `series-${index + 1}`);
        const results = await runBench(config, { outDir: directory, signal: abort.signal });
        const valid = results.state === 'completed' && results.tables.matches.filter((match) => match.acceptedAttempt).every((match) => match.status === 'finished') && evaluateGuardrails(results, config.guardrails ?? []).every((guard) => guard.passed);
        console.log(`${valid ? 'Completed' : 'INVALID'} series ${results.seriesId}: ${directory}/results.json and ${directory}/results.zip`);
        if (!valid) process.exitCode = 1;
      }
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
