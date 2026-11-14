import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineManifest, MCP_TOOL_NAMES, surfaceHash, type GameDefinition } from 'playerthree';
import { connectSeat, RUNNER_HARNESS } from '@playerthree/runner';
import { benchmarkDigest, validateBenchmarkPublication } from 'playerthree/benchmark';
import { writeBenchmarkJson } from 'playerthree/benchmark-store';
import { createBenchmarkSuite, exportCampaignPublication, runCampaign, type CampaignConfig } from '../src/campaign.ts';
import { createGameMatchHost } from '../src/bot-match.ts';
import type { AuthoringHarness } from '../src/harness.ts';
import { benchmarkSourceDigest } from '../src/source-digest.ts';
import { fixture } from './series-fixture.ts';
import { definition } from './bots-fixture.ts';
import { quadBots, quadSeries } from './quad-bots-fixture.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'playerthree-campaign-')); directories.push(path); return path; }
/** `starters` makes the candidate command every role in `roles`, each pre-deployed with its starter; the model then ends after one tool-free turn. */
async function config(fail = false, bench = fixture(), roles: readonly string[] = definition.manifest.roles.values, practice = false, starters?: Record<string, string>): Promise<CampaignConfig> {
  const candidateId = 'entrant-0';
  const role = roles[0]!;
  const controlled = starters ? roles : [role];
  bench.spec = { ...bench.spec, track: 'policy', authoring: { practiceSeeds: [13], maxOutputTokens: 100, maxWallMs: 20000, ...(starters ? { starters } : {}) }, execution: { ...bench.spec.execution, maxInfraRetries: 1 },
    budgets: { maxTurns: starters ? 1 : practice ? 3 : 2, maxTokens: 10000, maxCostUsd: '1' },
    entrants: bench.spec.entrants.map(e => e.id === candidateId ? { id: e.id, label: 'Offline fixture', kind: 'policy', aiPlayer: true, model: 'offline', provider: 'scripted' } : e),
    entrantSeats: bench.spec.entrants.map(e => ({ entrantId: e.id, seats: roles.map(r => ({ role: r, occupant: e.id === candidateId && controlled.includes(r) ? { kind: 'commander' as const, ref: { id: e.id, kind: 'policy' as const } } : { kind: 'bot' as const, level: 'idle', options: {} } })) })) };
  bench.models = { [candidateId]: { provider: 'scripted', model: 'offline', price: { inPerM: 1, outPerM: 2 }, script: starters ? [{ text: 'The starters are active.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }] : fail ? [{ text: 'No policy', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }] : [
    { text: '', toolCalls: [{ id: 'deploy', name: MCP_TOOL_NAMES.policyDeploy, args: { runtime: 'js', code: 'function think(){return [{kind:"increment",amount:2}];}' } }], usage: { inputTokens: 10, outputTokens: 5 } },
    ...(practice ? [{ text: '', toolCalls: [{ id: 'practice', name: MCP_TOOL_NAMES.practice, args: { opponent: 'idle', seed: 13, ticks: 4 } }], usage: { inputTokens: 10, outputTokens: 5 } }] : []),
    { text: 'Prepared.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } },
  ] } };
  const build = { game: { root: import.meta.dirname, paths: ['bots-fixture.ts', 'series-fixture.ts', 'quad-bots-fixture.ts', 'campaign.test.ts'] }, runner: { root: join(import.meta.dirname, '..'), paths: ['src'] } };
  const pins = { gameDigest: await benchmarkSourceDigest(build.game), runnerDigest: await benchmarkSourceDigest(build.runner) };
  const suite = createBenchmarkSuite(bench, { id: 'offline-fixture', version: 1, title: 'Offline integration fixture, not a model ranking', track: 'authored-policy', candidateId, roles: [...controlled],
    references: bench.spec.entrants.filter(e => e.id !== candidateId).map(e => ({ id: e.id, digest: benchmarkDigest({ entrant: e, policies: null, gameVersion: bench.spec.gameVersion }) })),
    strata: [{ id: 'idle', weight: 1 }], blocks: bench.spec.scenarios.map(s => ({ scenarioId: s.id, blockId: `world-${s.seed}`, stratumId: 'idle' })), replicates: 2, harness: { ...RUNNER_HARNESS }, build: pins, bootstrapReplicates: 100 });
  return { bench, suite, candidateId, build, pricing: { version: 'fixture-prices/1', asOf: '2000-01-01T00:00:00.000Z' }, system: { id: 'offline', label: 'Offline fixture', provider: 'scripted', model: 'offline', harness: `${RUNNER_HARNESS.id}/${RUNNER_HARNESS.version}`, configurationDigest: benchmarkDigest('offline-profile') }, consent: { results: true, attribution: true, artifacts: false, research: false, training: false, license: 'CC0-1.0' } };
}

describe('fixed-reference campaigns', { timeout: 60000 }, () => {
  it('keeps lobby deployment, practice and evaluation on the frozen subset of a multi-role four-team game', async () => {
    const seen: { teams: readonly string[]; seed: number }[] = [];
    const bench = quadSeries([{ team: 'north', alliance: 'north' }, { team: 'south', alliance: 'south' }], ['easy', 'idle'], { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 });
    bench.definition = {
      ...quadBots,
      create(options: Parameters<typeof quadBots.create>[0]) {
        if (options.teams.length !== 2 || options.teams.some(team => team !== 'north' && team !== 'south')) throw new Error('Selected layout only supports north and south');
        seen.push({ teams: [...options.teams], seed: options.seed });
        return quadBots.create(options);
      },
    } as GameDefinition;
    const input = await config(false, bench, quadBots.manifest.roles.values, true);
    const record = await runCampaign(input, { outDir: await directory() });
    expect(record.runs.map(run => run.status)).toEqual(['evaluated', 'evaluated']);
    expect(record.runs.every(run => run.artifactDigest !== null && run.trials.length === 4)).toBe(true);
    expect(seen.filter(game => game.seed === 13)).toHaveLength(2);
    expect(seen.some(game => game.seed === 3)).toBe(true);
    expect(seen.some(game => game.seed === 4)).toBe(true);
    expect(seen.every(game => game.teams.join(',') === 'north,south')).toBe(true);
  });
  it('authors every controlled role with one lobby commander after the harness pre-deploys their starters, and ledgers the timeline', async () => {
    const starter = 'quad-strategy/policies/starter.js';
    const skill = { name: 'quad-strategy', description: 'Quad starter.', files: {
      'SKILL.md': '---\nname: quad-strategy\ndescription: Quad starter.\n---\n\nDeploy policies/starter.js by reference.\n',
      'policies/starter.js': 'export function createPolicy() { return { think() { return [{ kind: "increment", amount: 3 }]; } }; }\n',
    } };
    const manifest = defineManifest({ ...quadBots.manifest, skills: [skill], starters: { [starter]: { summary: 'Adds 3 every decision.' } } });
    const bench = quadSeries([{ team: 'north', alliance: 'north' }, { team: 'south', alliance: 'south' }], ['easy', 'idle'], { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 });
    bench.definition = { ...quadBots, manifest } as GameDefinition;
    bench.spec = { ...bench.spec, surfaceHash: surfaceHash(manifest), template: { ...bench.spec.template, surfaceHash: surfaceHash(manifest) } };
    const roles = manifest.roles.values;
    const input = await config(false, bench, roles, false, Object.fromEntries(roles.map(role => [role, starter])));
    const out = await directory();
    const record = await runCampaign(input, { outDir: out });
    expect(record.runs.map(run => run.status)).toEqual(['evaluated', 'evaluated']);
    // The starters (score +3 a decision) beat the easy bot (+1) from either side.
    expect(record.runs.every(run => run.trials.every(trial => trial.status === 'win'))).toBe(true);
    const ledger = JSON.parse(await readFile(join(out, 'authoring', 'run-1-1.json'), 'utf8'));
    expect(ledger.deploys.map((d: { role: string; by: string; from: string | null; version: number }) => [d.role, d.by, d.from])).toEqual(roles.map(role => [role, 'harness', starter]));
    expect(Object.keys(ledger.policyDigests).sort()).toEqual([...roles].sort());
    expect(ledger).toMatchObject({ harness: { id: RUNNER_HARNESS.id }, turns: 1, reason: 'max_turns' });
    // One model session for both roles: one transcript, whose header names every role.
    expect(ledger.transcripts).toHaveLength(1);
    const header = JSON.parse((await readFile(join(out, ledger.transcripts[0]), 'utf8')).split('\n')[0]!);
    expect(header.roles).toEqual(roles);
    expect(JSON.parse(await readFile(join(out, 'results', 'run-1', 'results.json'), 'utf8')).tables.matches).toHaveLength(4);
  });
  it('drives an external harness through the lobby and refuses policy changes once authoring has ended', async () => {
    const input = await config();
    input.bench.spec = { ...input.bench.spec, authoring: { ...input.bench.spec.authoring!, maxWallMs: 1500 } };
    const role = definition.manifest.roles.values[0]!;
    const code = 'function think(){return [{kind:"increment",amount:2}];}';
    const late: { isError: boolean; text: string }[] = [];
    const harness: AuthoringHarness = { identity: { id: 'fake-harness', version: '1.0.0' }, async author(lobby) {
      const seat = await connectSeat({ url: lobby.url, token: lobby.token, expectHash: lobby.surfaceHash });
      try {
        expect(lobby.charge({ inputTokens: 100, outputTokens: 10, servedBy: 'FakeHost' })).toBe(true);
        expect((await seat.call(MCP_TOOL_NAMES.policyDeploy, { role, runtime: 'js', code })).isError).toBe(false);
        const ended = Promise.withResolvers<void>();
        lobby.signal.addEventListener('abort', () => ended.resolve(), { once: true });
        await ended.promise;
        late.push(await seat.call(MCP_TOOL_NAMES.policyDeploy, { role, runtime: 'js', code: 'function think(){return [];}' }));
      } finally { await seat.close(); }
      return { reason: 'cutoff', turns: 1 };
    } };
    const host = createGameMatchHost(definition, input.bench);
    try {
      const authored = await host.author(input.candidateId, undefined, { harness, scratch: await directory() });
      expect(authored).toMatchObject({ reason: 'cutoff', infrastructure: false, harness: { id: 'fake-harness', version: '1.0.0' }, turns: 1, inputTokens: 100, outputTokens: 10, servedBy: { FakeHost: 1 } });
      expect(authored.policies?.[role]?.code).toContain('amount:2');
      expect(late).toHaveLength(1);
      expect(late[0]!.isError).toBe(true);
      expect(late[0]!.text).toContain('mode_unavailable');
      expect(authored.timeline.filter(event => event.kind === 'deploy')).toHaveLength(1);
    } finally { await host.close(); }
  });
  it('authors independently under per-run ceilings, then resumes without authoring or evaluation', async () => {
    const input = await config(); const outDir = await directory();
    const record = await runCampaign(input, { outDir });
    expect(record.runs.map(r => r.status)).toEqual(['evaluated', 'evaluated']);
    expect(record.runs.every(r => r.cost.coverage === 'complete' && Number(r.cost.amount) > 0)).toBe(true);
    expect(record.runs[0]!.cost.amount).toBe(record.runs[1]!.cost.amount);
    expect(new Set(record.runs.map(r => r.seriesId)).size).toBe(2);
    for (const run of record.runs) expect(benchmarkDigest(JSON.parse(await readFile(join(outDir, 'artifacts', `${run.artifactDigest}.json`), 'utf8')))).toBe(run.artifactDigest);
    // Each attempt names its harness and keeps the session transcript: the model's turns and every tool result it saw.
    const authoring = JSON.parse(await readFile(join(outDir, 'authoring', 'run-1-1.json'), 'utf8'));
    expect(authoring).toMatchObject({ harness: RUNNER_HARNESS, preflight: null, servedBy: {}, servedByUnresolved: 0, reason: 'max_turns' });
    const transcript = (await readFile(join(outDir, authoring.transcripts[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(transcript[0]).toMatchObject({ kind: 'session', harness: RUNNER_HARNESS, phase: 'authoring', model: 'offline' });
    expect(transcript.filter(e => e.kind === 'tool').map(e => e.name)).toEqual([MCP_TOOL_NAMES.policyDeploy]);
    expect(transcript.at(-1)).toMatchObject({ kind: 'stop', reason: 'max_turns' });
    expect(await runCampaign(input, { outDir })).toEqual(record);
    const publication = exportCampaignPublication(record, input.consent);
    expect(publication.score.complete).toBe(true);
    expect(publication.score.expectedTrials).toBe(8);
    expect(validateBenchmarkPublication(publication)).toEqual(publication);
    // The id names the public evidence: a later re-export of the same evidence keeps it; an anonymous export cannot reuse it.
    expect(exportCampaignPublication(record, input.consent, '2099-01-01T00:00:00.000Z').id).toBe(publication.id);
    const anonymous = exportCampaignPublication(record, { ...input.consent, attribution: false });
    expect(anonymous.experiment).toMatchObject({ id: 'anonymous', executionDigest: null, system: { provider: null, model: null } });
    expect(anonymous.id).not.toBe(publication.id);
    expect(JSON.stringify(anonymous)).not.toContain(record.experiment.executionDigest!);
    input.bench.models![input.candidateId]!.model = 'changed';
    await expect(runCampaign(input, { outDir })).rejects.toThrow();
  });
  it('answers a held-out practice seed with a closed error naming the allowed seeds', async () => {
    const input = await config(false, fixture(), definition.manifest.roles.values, true);
    const model = input.bench.models![input.candidateId]!;
    // Seed 3 is an evaluation scenario's seed: held out from practice.
    input.bench.models = { [input.candidateId]: { ...model, script: model.script!.map(turn => ({ ...turn, toolCalls: turn.toolCalls.map(call => call.id === 'practice' ? { ...call, args: { ...call.args, seed: 3 } } : call) })) } };
    const outDir = await directory();
    await runCampaign(input, { outDir });
    const authoring = JSON.parse(await readFile(join(outDir, 'authoring', 'run-1-1.json'), 'utf8'));
    const transcript = (await readFile(join(outDir, authoring.transcripts[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const practice = transcript.find(e => e.kind === 'tool' && e.name === MCP_TOOL_NAMES.practice);
    expect(practice.isError).toBe(true);
    expect(JSON.parse(practice.output)).toEqual({ error: 'invalid', schemaCode: 'enum', path: ['seed'], expected: 'PracticeRequest["seed"]: 13 (this benchmark\'s practice seeds; omit seed to rotate through them)' });
  });
  it('includes failed authoring and its cost rather than dropping runs', async () => {
    const input = await config(true); const record = await runCampaign(input, { outDir: await directory() });
    const publication = exportCampaignPublication(record, input.consent);
    expect(record.runs.every(r => r.status === 'failed' && Number(r.cost.amount) > 0)).toBe(true);
    expect(publication.score).toMatchObject({ complete: true, failedRuns: 2, value: 0, runScores: [0, 0], expectedTrials: 8 });
  });
  it('re-authors a run whose process died mid-authoring as a fresh ledgered attempt; completed runs are reused', async () => {
    const input = await config(); const outDir = await directory(); const record = await runCampaign(input, { outDir });
    expect(record.attempts.map(a => [a.runId, a.outcome])).toEqual([['run-1', 'artifact'], ['run-2', 'artifact']]);
    record.runs[0] = { ...record.runs[0]!, status: 'authoring', artifactDigest: null, seriesId: null, seriesRevision: null, trials: [] };
    record.attempts[0] = { ...record.attempts[0]!, finishedAt: null, outcome: null, reason: null, costUsd: null };
    await writeBenchmarkJson(join(outDir, 'campaign.json'), record);
    // The crashed attempt's unknown spend is charged at the full $1 per-run ceiling, so $2 cannot fund a re-authoring.
    expect((await runCampaign(input, { outDir, maxCampaignUsd: 2 })).runs[0]).toMatchObject({ status: 'pending', authoringAttempts: 1 });
    const resumed = await runCampaign(input, { outDir, maxCampaignUsd: 3 });
    expect(resumed.runs[0]).toMatchObject({ status: 'evaluated', authoringAttempts: 2 });
    expect(resumed.attempts.filter(a => a.runId === 'run-1').map(a => [a.outcome, a.reason, a.costUsd === null])).toEqual([['interrupted', 'process_interrupted', true], ['artifact', 'max_turns', false]]);
    expect(resumed.runs[1]).toEqual(record.runs[1]);
  });
  it('keeps provider outages pending and unscored, stops authoring, and caps retries at the frozen limit', async () => {
    let requests = 0; let probes = 0;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      // The tool-argument preflight cannot reach the route either; it leaves the outage to authoring.
      if (Buffer.concat(chunks).includes('echo_args')) probes++; else requests++;
      res.writeHead(503).end('overloaded');
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
    process.env.PLAYERTHREE_CAMPAIGN_TEST_KEY = 'test-only';
    try {
      const input = await config(); const outDir = await directory();
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected port');
      input.bench.models = { [input.candidateId]: { provider: 'openai', model: 'offline', apiKeyEnv: 'PLAYERTHREE_CAMPAIGN_TEST_KEY', baseUrl: `http://127.0.0.1:${address.port}`, price: { inPerM: 1, outPerM: 2 } } };
      input.system = { ...input.system, provider: 'openai' };
      for (let invocation = 1; invocation <= 3; invocation++) {
        const record = await runCampaign(input, { outDir });
        expect(record.runs.map(r => [r.status, r.authoringAttempts])).toEqual([['pending', Math.min(invocation, 2)], ['pending', 0]]);
        expect(exportCampaignPublication(record, input.consent).score).toMatchObject({ complete: false, value: null, failedRuns: 0 });
      }
      expect([requests, probes]).toEqual([2, 2]);
      delete process.env.PLAYERTHREE_CAMPAIGN_TEST_KEY;
      const fresh = await directory();
      await expect(runCampaign(input, { outDir: fresh })).rejects.toThrow('PLAYERTHREE_CAMPAIGN_TEST_KEY');
      await expect(stat(join(fresh, 'campaign.json'))).rejects.toThrow();
    } finally { delete process.env.PLAYERTHREE_CAMPAIGN_TEST_KEY; server.close(); }
  });
  it('refuses to author through a route that drops tool-call arguments, before recording any attempt', async () => {
    // A lossy route: the upstream keeps the enum argument and drops the rest.
    const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json', 'x-provider-name': 'LossyUpstream' }).end(JSON.stringify({
      output: [{ type: 'function_call', status: 'completed', call_id: 'c', name: 'echo_args', arguments: '{"mode":"echo"}' }], usage: { input_tokens: 10, output_tokens: 5 },
    })));
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
    process.env.PLAYERTHREE_CAMPAIGN_TEST_KEY = 'test-only';
    try {
      const input = await config(); const outDir = await directory();
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected port');
      input.bench.models = { [input.candidateId]: { provider: 'openai', model: 'offline', apiKeyEnv: 'PLAYERTHREE_CAMPAIGN_TEST_KEY', baseUrl: `http://127.0.0.1:${address.port}`, price: { inPerM: 1, outPerM: 2 } } };
      input.system = { ...input.system, provider: 'openai' };
      await expect(runCampaign(input, { outDir })).rejects.toThrow('Tool-argument preflight failed for offline via LossyUpstream: dropped or changed text, items, code');
      const record = JSON.parse(await readFile(join(outDir, 'campaign.json'), 'utf8'));
      expect(record.attempts).toEqual([]);
    } finally { delete process.env.PLAYERTHREE_CAMPAIGN_TEST_KEY; server.close(); }
  });
  it('discards a turn that crosses the hard per-run budget, freezing the last artifact deployed within it', async () => {
    const input = await config(); const outDir = await directory();
    const deploy = (amount: number, outputTokens: number) => ({ text: '', toolCalls: [{ id: `deploy-${amount}`, name: MCP_TOOL_NAMES.policyDeploy, args: { runtime: 'js', code: `function think(){return [{kind:"increment",amount:${amount}}];}` } }], usage: { inputTokens: 10, outputTokens } });
    input.bench.models![input.candidateId]!.script = [deploy(2, 5), deploy(3, 20000)];
    const record = await runCampaign(input, { outDir });
    expect(record.runs.map(r => [r.status, r.reason])).toEqual([['evaluated', 'budget'], ['evaluated', 'budget']]);
    const artifact = JSON.parse(await readFile(join(outDir, 'artifacts', `${record.runs[0]!.artifactDigest}.json`), 'utf8'));
    expect(JSON.stringify(artifact)).toContain('amount:2');
    // The overshooting turn is still charged: (10 in, 5 out) and (10 in, 20000 out) tokens at $1/$2 per million.
    expect(Number(record.runs[0]!.cost.amount)).toBeCloseTo((10 + 5 * 2 + 10 + 20000 * 2) / 1e6, 12);
  });
  it('can re-evaluate a frozen run on its original series without new model calls', async () => {
    const input = await config(); const outDir = await directory(); const record = await runCampaign(input, { outDir });
    const original = structuredClone(record.runs[0]);
    record.runs[0]!.status = 'frozen'; record.runs[0]!.trials = [];
    await writeBenchmarkJson(join(outDir, 'campaign.json'), record);
    const resumed = await runCampaign(input, { outDir });
    expect(resumed.runs[0]!.seriesId).toBe(original!.seriesId);
    expect(resumed.runs[0]!.artifactDigest).toBe(original!.artifactDigest);
    expect(resumed.runs[0]!.cost).toEqual(original!.cost);
    expect(resumed.runs[0]!.trials).toEqual(original!.trials);
  });
});
