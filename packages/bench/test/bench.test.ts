import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { defineManifest, MCP_TOOL_NAMES, surfaceHash, t, type GameDefinition } from 'playerthree';
import { loadBenchConfig, runBench, validateConfig, type BenchConfig } from '../src/index.ts';
import { definition } from './bots-fixture.ts';
import { fixture } from './series-fixture.ts';
import { solo } from './solo.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'playerthree-model-series-')); directories.push(path); return path; }
function config(track: 'policy' | 'live' = 'policy'): BenchConfig {
  const config = fixture();
  const role = definition.manifest.roles.values[0]!;
  config.spec = { ...config.spec, track,
    entrants: config.spec.entrants.map((entrant, index) => index === 0 ? { ...entrant, kind: track === 'policy' ? 'policy' : 'agent', provider: 'scripted', model: 'offline' } : entrant),
    authoring: { practiceSeeds: [13], maxOutputTokens: 100, maxWallMs: 20000 },
    entrantSeats: config.spec.entrants.map((entrant, index) => ({ entrantId: entrant.id, seats: definition.manifest.roles.values.map((seatRole) => ({ role: seatRole, occupant: index === 0 && seatRole === role ? { kind: 'commander' as const, ref: { id: entrant.id, kind: track === 'policy' ? 'policy' as const : 'agent' as const } } : { kind: 'bot' as const, level: 'idle', options: {} } })) })),
    budgets: { maxTurns: 8, maxTokens: 10000, maxCostUsd: '1' },
    execution: { ...config.spec.execution, speed: track === 'live' ? 1 : 1000, clock: track === 'live' ? 'realtime' : 'accelerated' },
  };
  config.models = { 'entrant-0': { provider: 'scripted', model: 'offline', price: { inPerM: 1, outPerM: 2 }, script: [
    { text: '', toolCalls: [{ id: 'deploy', name: MCP_TOOL_NAMES.policyDeploy, args: { runtime: 'js', code: 'function think(){return [{kind:"increment",amount:2}];}' } }], usage: { inputTokens: 10, outputTokens: 5 } },
    { text: '', toolCalls: [{ id: 'practice', name: MCP_TOOL_NAMES.practice, args: { opponent: 'idle', ticks: 4 } }], usage: { inputTokens: 20, outputTokens: 10 } },
    { text: 'Prepared.', toolCalls: [], usage: { inputTokens: 30, outputTokens: 15 } },
  ] } };
  return config;
}

describe('provider-backed series execution', { timeout: 30000 }, () => {
  it('authors exactly once, pins its policy, and retains real runner token/cost rows across side swaps', async () => {
    const outDir = await directory();
    const results = await runBench(config(), { outDir });
    expect(results.tables.matches).toHaveLength(4);
    expect(results.tables.usage.every((row) => row.phase === 'authoring' && row.matchId === null)).toBe(true);
    expect(results.tables.usage.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0)).toBe(60);
    expect(results.tables.usage.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0)).toBe(30);
    expect(results.tables.usage.reduce((sum, row) => sum + Number(row.costAmount ?? 0), 0)).toBeCloseTo(0.00012);
    const policies = results.tables.seats.filter((row) => row.executionKind === 'policy');
    expect(policies).toHaveLength(4);
    expect(new Set(policies.map((row) => row.artifactHash)).size).toBe(1);
    expect(results.spec.authoring?.practiceSeeds).toEqual([13]);
    expect(JSON.parse(await readFile(join(outDir, 'results.json'), 'utf8'))).toEqual(results);
    expect(results.tables.usage.every((row) => !JSON.stringify(row).includes('apiKey'))).toBe(true);
  });

  it('keeps series options for evaluation but atomically replaces a selector in practice overrides', async () => {
    const selector = t.obj({
      id: t.opt(t.str(16)),
      document: t.opt(t.obj({ label: t.str(16), cells: t.ints(4, 0, 9) })),
    }, 'Atomic benchmark map selector.', { merge: 'replace' });
    const manifest = { ...definition.manifest, matchOptions: t.obj({
      endAt: t.opt(t.int(1, 100)), increment: t.opt(t.int(1, 10)),
      map: t.opt(selector),
      economy: t.opt(t.obj({ start: t.opt(t.int(0, 100)), rate: t.opt(t.int(0, 10)) })),
    }) };
    const created: unknown[] = [];
    const game = {
      ...definition, manifest,
      create(opts: Parameters<typeof definition.create>[0]) {
        created.push(structuredClone(opts.options));
        return Object.assign(definition.create(opts), { manifest });
      },
    } as unknown as GameDefinition;
    const c = config();
    const pinned = fixture(game);
    c.definition = game;
    c.resolve = pinned.resolve;
    c.spec = { ...c.spec, surfaceHash: pinned.spec.surfaceHash, template: { ...c.spec.template, surfaceHash: pinned.spec.surfaceHash, options: { map: { id: 'builtin' }, economy: { start: 10, rate: 2 } } } };
    const document = { label: 'custom', cells: [0, 9] };
    c.models = { 'entrant-0': { ...c.models!['entrant-0']!, script: [
      { text: '', toolCalls: [{ id: 'deploy', name: MCP_TOOL_NAMES.policyDeploy, args: { runtime: 'js', code: 'function think(){return [{kind:"increment",amount:2}];}' } }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: '', toolCalls: [{ id: 'practice', name: MCP_TOOL_NAMES.practice, args: { opponent: 'idle', ticks: 1, options: { map: { document }, economy: { start: 20 } } } }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'Prepared.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ] } };
    const results = await runBench(c, { outDir: await directory() });
    const evaluation = { endAt: 4, increment: 1, map: { id: 'builtin' }, economy: { start: 10, rate: 2 } };
    expect(created).toContainEqual({ ...evaluation, map: { document }, economy: { start: 20, rate: 2 } });
    expect(created.filter((options) => isDeepStrictEqual(options, evaluation)).length).toBeGreaterThanOrEqual(results.tables.matches.length);
    expect(results.tables.matches).toHaveLength(4);
  });

  it('rejects heldout practice at the server boundary and records failed authoring rather than an infrastructure retry', async () => {
    const c = config();
    c.models = { 'entrant-0': { ...c.models!['entrant-0']!, script: [
      { text: '', toolCalls: [{ id: 'leak', name: MCP_TOOL_NAMES.practice, args: { seed: 3, opponent: 'idle', ticks: 4, artifact: { runtime: 'js', code: 'function think(){return [];}' } } }], usage: { inputTokens: 7, outputTokens: 3 } },
      { text: 'Prepared.', toolCalls: [], usage: { inputTokens: 2, outputTokens: 1 } },
    ] } };
    const results = await runBench(c, { outDir: await directory() });
    expect(results.tables.matches.every((match) => match.status === 'forfeit' && match.attemptNumber === 1)).toBe(true);
    expect(results.tables.usage.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0)).toBe(9);
    expect(results.tables.standings.find((standing) => standing.entrantId === 'entrant-0')?.draws).toBe(0);
  });

  it('uses live intent tools with provider instrumentation and no authoring calls', async () => {
    const c = config('live');
    c.models = { 'entrant-0': { ...c.models!['entrant-0']!, script: [{ text: '', toolCalls: [{ id: 'act', name: MCP_TOOL_NAMES.act, args: { intents: [{ kind: 'increment', amount: 1 }] } }], usage: { inputTokens: 3, outputTokens: 2 } }] } };
    const results = await runBench(c, { outDir: await directory() });
    expect(results.tables.usage.length).toBeGreaterThan(0);
    expect(results.tables.usage.every((row) => row.phase === 'inference')).toBe(true);
    expect(results.tables.decisions.every((row) => row.source === 'runner')).toBe(true);
  });
});

it('validates fixed surface pins, heldout separation and shared provider budgets before execution', () => {
  const c = config();
  expect(() => validateConfig({ ...c, spec: { ...c.spec, surfaceHash: 'changed' } }, definition)).toThrow('surfaceHash');
  expect(() => validateConfig({ ...c, spec: { ...c.spec, authoring: { ...c.spec.authoring!, practiceSeeds: [3] } } })).toThrow('overlap');
  expect(() => validateConfig({ ...c, models: { 'entrant-0': { provider: 'openai', model: 'unpriced' } } })).toThrow('no price');
  Object.assign(c.models!['entrant-0']!, { budgets: {} });
  expect(() => validateConfig(c)).toThrow('per-model budgets');
});

it('scores a one-side game once per scenario and retains its guarded game report', async () => {
  const c = fixture(solo);
  c.spec = { ...c.spec, track: 'policy', scenarios: c.spec.scenarios.slice(0, 1), entrantSeats: [{ entrantId: 'entrant-0', seats: [{ role: 'counter', occupant: { kind: 'commander', ref: { id: 'solo-policy', kind: 'policy' } } }] }] };
  c.policies = { 'entrant-0': { counter: { runtime: 'js', code: 'function think(){return [{kind:"increment"}];}' } } };
  const results = await runBench(c, { outDir: await directory() });
  expect(results.tables.matches).toHaveLength(1);
  expect(results.tables.matches[0]!.outcomes).toEqual([{ team: 'player', rank: 1, outcome: 'win', reason: 'game_over' }]);
  expect(results.tables.events.find((event) => event.kind === 'game_report')?.data).toEqual({ report: { score: 2 } });
});

it('supports four physical sides and explicit cyclic assignments without A/B containers', async () => {
  const manifest = defineManifest({ ...definition.manifest, id: 'four-side-counter', teams: t.enum(['north', 'east', 'south', 'west']) });
  const game: GameDefinition<typeof manifest> = { manifest, create() { let tick = 0; return { manifest, get tick() { return tick; }, step() { tick++; }, outcome() { return tick < 2 ? 'running' : 'draw'; }, view() { return { tick }; }, observe() { return { tick, score: 0, other: 0 }; }, matchData() { return { increment: 1 }; }, apply() { return { ok: true }; }, report() { return { score: 0 }; }, events() { return []; }, setSeatInfo() {} }; }, createBot() { return { think() { return []; } }; } };
  const c = fixture(game);
  c.spec = { ...c.spec, rating: { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: 0.1 } };
  const results = await runBench(c, { outDir: await directory() });
  expect(results.spec.surfaceHash).toBe(surfaceHash(manifest));
  expect(results.tables.schedule).toHaveLength(8);
  expect(results.tables.matches.every((match) => match.outcomes.length === 4)).toBe(true);
});

it('loads only the current module contract and arrays of independent series', async () => {
  const file = join(await directory(), 'bench.config.ts');
  await writeFile(file, 'export default { definition: null };\n');
  await expect(loadBenchConfig(file)).rejects.toThrow('SeriesSpec');
});
