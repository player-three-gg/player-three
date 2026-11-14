/**
 * Canonical series results for the operator console. Read-only; execution stays with the CLI.
 * Directories use server-derived keys. Replay paths are derived only from available typed artifact
 * rows in results.json and must stay inside that result directory.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Replay } from '../host/types.ts';
import type { ResultsEnvelope } from '../arena.ts';
import { validateResultsEnvelope } from '../results.ts';
import { REPLAY_LIMITS } from './replay.ts';

const MAX_RESULTS_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_DIRS = 50;

export interface BenchDir {
  key: string;
  /** Path relative to the configured root (`.` for the root itself). */
  name: string;
  path: string;
}

export class BenchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}


async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The root itself and its immediate subdirectories that hold a `results.json`. */
export async function benchDirs(root: string): Promise<BenchDir[]> {
  const base = resolve(root);
  const candidates = [base];
  try {
    for (const entry of await readdir(base, { withFileTypes: true })) if (entry.isDirectory()) candidates.push(join(base, entry.name));
  } catch {
    return [];
  }
  const dirs: BenchDir[] = [];
  for (const path of candidates) {
    if (dirs.length >= MAX_DIRS) break;
    if (!(await exists(join(path, 'results.json')))) continue;
    dirs.push({ key: createHash('sha256').update(path).digest('hex').slice(0, 16), name: relative(base, path) || basename(base), path });
  }
  return dirs;
}

async function readLimited(path: string, limit: number): Promise<string> {
  const s = await stat(path);
  if (s.size > limit) throw new BenchError(413, `${basename(path)} is larger than ${Math.round(limit / 1024 / 1024)} MiB.`);
  return readFile(path, 'utf8');
}

async function results(dir: BenchDir): Promise<ResultsEnvelope> {
  let data: unknown;
  try {
    data = JSON.parse(await readLimited(join(dir.path, 'results.json'), MAX_RESULTS_BYTES));
  } catch (error) {
    if (error instanceof BenchError) throw error;
    throw new BenchError(422, 'results.json is not readable JSON.');
  }
  try {
    return validateResultsEnvelope(data);
  } catch {
    throw new BenchError(422, 'results.json is not a valid playerthree.results v1 envelope.');
  }
}

/** Closed summary of one results.json: only the fields the console shows, type-checked. */
export async function benchSummary(dir: BenchDir) {
  const r = await results(dir);
  const schedule = new Map(r.tables.schedule.map((trial) => [trial.trialId, trial]));
  return {
    key: dir.key, name: dir.name, seriesId: r.seriesId, revision: r.revision, state: r.state,
    game: r.spec.game, gameVersion: r.spec.gameVersion, surfaceHash: r.spec.surfaceHash,
    comparisonHash: r.comparisonHash, track: r.spec.track,
    createdAt: r.createdAt, completedAt: r.completedAt,
    completeness: r.completeness, seeds: r.spec.scenarios.map((scenario) => scenario.seed),
    authoring: r.spec.authoring ?? null, ticks: r.spec.execution.maxTicks, budgets: r.spec.budgets,
    entrants: r.tables.entrants, standings: r.tables.standings,
    usage: r.summaries.usage, latency: r.summaries.latency,
    matches: r.tables.matches.map((match) => {
      const trial = schedule.get(match.trialId);
      const replay = r.tables.artifacts.find((artifact) => artifact.matchId === match.matchId
        && artifact.kind === 'replay' && artifact.format === 'playerthree.replay' && artifact.availability === 'available');
      return {
        matchId: match.matchId, trialId: match.trialId, attemptNumber: match.attemptNumber,
        status: match.status, acceptedAttempt: match.acceptedAttempt, ticks: match.ticks, wallMs: match.wallMs,
        terminalReason: match.terminalReason, outcomes: match.outcomes,
        seed: trial?.seed ?? null, mapId: trial?.mapId ?? null, mapIdentity: trial?.mapIdentity ?? null,
        rulesHash: trial?.rulesHash ?? null, sideBindings: trial?.sideBindings ?? [],
        replay: replay ? `artifacts/${encodeURIComponent(replay.id)}.json` : null,
      };
    }),
    report: await exists(join(dir.path, 'report.md')),
  };
}

export async function benchReport(dir: BenchDir): Promise<string> {
  const path = join(dir.path, 'report.md');
  if (!(await exists(path))) throw new BenchError(404, 'This bench directory has no report.md.');
  return readLimited(path, MAX_REPORT_BYTES);
}

/** A replay results.json lists, read from inside the directory. */
export async function benchReplay(dir: BenchDir, rel: string): Promise<Replay> {
  const r = await results(dir);
  const listed = r.tables.artifacts.some((artifact) => artifact.kind === 'replay'
    && artifact.format === 'playerthree.replay' && artifact.availability === 'available' && `artifacts/${encodeURIComponent(artifact.id)}.json` === rel);
  if (!listed || isAbsolute(rel)) throw new BenchError(404, 'results.json does not list this replay.');
  const path = resolve(dir.path, rel);
  if (!path.startsWith(dir.path + sep)) throw new BenchError(404, 'results.json does not list this replay.');
  let text: string;
  try {
    text = await readLimited(path, REPLAY_LIMITS.bytes);
  } catch (error) {
    if (error instanceof BenchError) throw error;
    throw new BenchError(404, 'The replay file is missing.');
  }
  try {
    return JSON.parse(text) as Replay;
  } catch {
    throw new BenchError(422, 'The replay file is not valid JSON.');
  }
}
