/** `playerthree-bench campaign | publication | validate-publication | import-publication`: benchmark campaigns and their publications. */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateBenchmarkPublication } from 'playerthree/benchmark';
import { importBenchmarkPublication, jsonBenchmarkStore, writeBenchmarkJson } from 'playerthree/benchmark-store';
import { exportCampaignPublication, runCampaign, type CampaignConfig, type CampaignRecord } from './campaign.ts';

/** Config imports are trusted operator code, never an HTTP/community-upload interface. */
export async function campaignMain(command: string, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { config: { type: 'string' }, out: { type: 'string' }, input: { type: 'string' }, store: { type: 'string' }, consent: { type: 'string' }, 'max-campaign-usd': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('playerthree-bench campaign --config ./campaign.config.ts --out ./campaign-data [--max-campaign-usd USD]\nplayerthree-bench publication --input ./campaign-data/campaign.json --consent ./consent.json --out ./publication.json\nplayerthree-bench validate-publication --input ./publication.json\nplayerthree-bench import-publication --input ./publication.json --store ./publications\nCampaign configs execute trusted local code. Re-running campaign resumes it; it exits nonzero while incomplete. Imports validate evidence, never confer trusted model authorship.');
    return 0;
  }
  if (command === 'campaign') {
    if (!values.config || !values.out) throw new Error('campaign requires --config and --out');
    const maxCampaignUsd = values['max-campaign-usd'] === undefined ? undefined : Number(values['max-campaign-usd']);
    if (maxCampaignUsd !== undefined && (!Number.isFinite(maxCampaignUsd) || maxCampaignUsd < 0)) throw new Error('--max-campaign-usd must be a nonnegative number');
    const config = (await import(pathToFileURL(resolve(values.config)).href)).default as CampaignConfig;
    // SIGINT/SIGTERM stop cleanly: pending authoring stays retryable and evaluation resumes on the next invocation.
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const record = await runCampaign(config, { outDir: resolve(values.out), signal: controller.signal, maxCampaignUsd, log: message => console.error(message) });
      const publication = exportCampaignPublication(record, config.consent);
      const path = join(resolve(values.out), 'publication.json');
      let previous;
      try { previous = validateBenchmarkPublication(JSON.parse(await readFile(path, 'utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // The id names the evidence: only an identical re-export keeps the first timestamp; new evidence is newly published.
      const output = previous?.id === publication.id ? exportCampaignPublication(record, config.consent, previous.publishedAt) : publication;
      await writeBenchmarkJson(path, output);
      console.log(`${output.score.complete ? 'Complete' : 'Incomplete'} campaign; publication ${path}; score ${output.score.value ?? 'unavailable'}`);
      return output.score.complete ? 0 : 1;
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
  if (!values.input) throw new Error(`${command} requires --input`);
  const input: unknown = JSON.parse(await readFile(resolve(values.input), 'utf8'));
  if (command === 'publication') {
    if (!values.consent || !values.out) throw new Error('publication requires --consent and --out');
    const consent = JSON.parse(await readFile(resolve(values.consent), 'utf8'));
    const publication = exportCampaignPublication(input as CampaignRecord, consent);
    await writeBenchmarkJson(resolve(values.out), publication);
    console.log(`Publication ${publication.id}: ${publication.digest}`);
    return publication.score.complete ? 0 : 1;
  }
  const publication = validateBenchmarkPublication(input);
  if (command === 'import-publication') {
    if (!values.store) throw new Error('import-publication requires --store');
    await importBenchmarkPublication(jsonBenchmarkStore(resolve(values.store)), publication);
  } else if (command !== 'validate-publication') throw new Error('Unknown benchmark command');
  console.log(`Validated ${publication.id}: ${publication.digest}; provenance remains unverified on import`);
  return 0;
}
