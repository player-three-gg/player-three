/**
 * `runBench`: one benchmark series from a {@link BenchConfig} — validated, run by the series runner over a JSON series
 * store in `<outDir>/store`, exported to `outDir`, with every model session's transcript in `<outDir>/transcripts`.
 */
import { join } from 'node:path';
import type { ResultsEnvelope, SeriesAccess } from 'playerthree/arena';
import { jsonSeriesStore } from 'playerthree/host';
import { loadDefinition } from './bots-config.ts';
import { validateConfig, type BenchConfig } from './config.ts';
import { createGameMatchHost, modelKeyEnv } from './bot-match.ts';
import { preflightToolArguments } from './preflight.ts';
import { createSeriesRunner } from './series.ts';
import { writeResults } from './report.ts';

/** `outDir` receives the store and the exports; `owner` names the series owner (default `benchmark_owner`); aborting `signal` aborts the series. */
export interface RunBenchOptions { outDir: string; owner?: string; signal?: AbortSignal; onProgress?: (completed: number, total: number) => void }

/** All tracks use the same accepted schedule, lifecycle, durable store and export service; returns the full canonical download. */
export async function runBench(config: BenchConfig, options: RunBenchOptions): Promise<ResultsEnvelope> {
  validateConfig(config);
  const definition = await loadDefinition(config.definition);
  validateConfig(config, definition);
  // Every model's route must keep tool-call arguments intact before a series spends anything on it; an unreachable
  // route is left to the series, whose provider outages are infrastructure.
  for (const model of Object.values(config.models ?? {})) {
    const keyName = modelKeyEnv(model);
    if (keyName === null) continue;
    const apiKey = process.env[keyName];
    if (!apiKey) throw new Error(`playerthree-bench: set ${keyName} for ${model.provider}/${model.model}`);
    const preflight = await preflightToolArguments(model, apiKey, options.signal);
    if (!preflight.ok && !preflight.unavailable) throw new Error(`playerthree-bench: tool-argument preflight failed for ${model.model}${preflight.servedBy ? ` via ${preflight.servedBy}` : ''}: ${preflight.detail}; pin a faithful upstream in the model's request`);
  }
  const adapter = createGameMatchHost(definition, config, { transcripts: join(options.outDir, 'transcripts') });
  const runner = createSeriesRunner({ host: adapter.host, binder: adapter.binder, store: jsonSeriesStore(join(options.outDir, 'store')) });
  const owner = options.owner ?? 'benchmark_owner';
  let access: SeriesAccess | undefined;
  let aborting: Promise<void> | undefined;
  let settled = false;
  const abort = () => { if (access?.kind === 'owner') { aborting = runner.abort(owner, access.seriesId); void aborting.catch(() => {}); } };
  try {
    const created = await runner.create(owner, config.spec);
    access = { kind: 'owner', owner, seriesId: created.id };
    options.signal?.addEventListener('abort', abort, { once: true });
    const updates = (async () => { for await (const update of runner.updates(access!)) options.onProgress?.(update.completed, update.total); })();
    void updates.catch(() => {});
    if (options.signal?.aborted) await runner.abort(owner, created.id);
    else await runner.start(owner, created.id);
    await updates;
    settled = true;
    await aborting;
    return await writeResults(options.outDir, runner, access, adapter.host, config.guardrails ?? []);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try { if (!settled && access?.kind === 'owner') await runner.abort(owner, access.seriesId); }
    finally { await adapter.close(); }
  }
}
