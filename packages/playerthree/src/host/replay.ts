/** Deterministic replays: re-simulate a match from its seed and recorded inputs. */
import { createGuard } from '../guard.ts';
import { CONTROLLERS, INTENT_SOURCES, intentSchema, type AnyManifest, type Controller, type GameAdapter, type GameDefinition, type MatchOptionsOf, type MatchSides, type Outcome } from '../manifest.ts';
import type { EnumS } from '../schema.ts';
import { isSignalIntent, SignalBoard } from '../signals.ts';
import { applyIntent, checkIntent, looseAdapter, parseMandate, parseMatchOptions, parseMatchSides, type Sides, type Sim } from './pipeline.ts';
import type { Replay, ReplayPosition } from './types.ts';

/** The state a replay re-simulated to: the isolated adapter and the outcomes and pauses at that point. */
export interface ReplayResult<M extends AnyManifest> {
  adapter: GameAdapter<M>;
  /** The replayed team signal boards (games declaring signals). */
  signals?: SignalBoard;
  outcomes: Record<string, Outcome>;
  /** Seats holding the session paused at the target tick (after its recorded entries), in recording order. */
  paused: { team: string; role: string }[];
}

const RESUME_REASONS: readonly unknown[] = ['present', 'owner', 'timeout'];

/** Re-simulate through tick (including recorded inputs at that tick), defaulting to the entire replay. */
export function replayMatch<M extends AnyManifest>(definition: GameDefinition<M>, replay: Replay, tick = replay.ticks, position?: ReplayPosition<M>): ReplayResult<M> {
  const simulation = replaySimulation(definition, replay, tick, position);
  for (;;) {
    const next = simulation.next();
    if (next.done) return next.value;
  }
}

/**
 * Cooperative replay cursor. Each yield is one step or input; positions are trusted, process-local only. A replay
 * with a `window` (persistent session) needs a `position` inside that window (`PlayerThreeMatch.checkpoint()`).
 */
export function* replaySimulation<M extends AnyManifest>(definition: GameDefinition<M>, replay: Replay, target = replay.ticks, position?: ReplayPosition<M>): Generator<ReplayPosition<M>, ReplayResult<M>> {
  const m = definition.manifest;
  if (replay?.format !== 'playerthree.replay' || replay.version !== 2) throw new Error('playerthree/replay: not a replay v2 (trusted intent source required)');
  if (replay.game !== m.id) throw new Error('playerthree/replay: replay is for a different game');
  if (replay.gameVersion !== m.version) throw new Error('playerthree/replay: game version mismatch');
  if (!Number.isSafeInteger(replay.seed) || !Number.isSafeInteger(replay.ticks) || replay.ticks < 0) throw new Error('playerthree/replay: bad header');
  if (!Array.isArray(replay.entries)) throw new Error('playerthree/replay: bad entries');
  const window = replay.window;
  if (window !== undefined && !(Number.isSafeInteger(window?.from) && Number.isSafeInteger(window.dropped) && window.from >= 0 && window.from <= replay.ticks && window.dropped >= 0)) {
    throw new Error('playerthree/replay: bad window');
  }
  const dropped = window?.dropped ?? 0;
  if (!Number.isSafeInteger(target) || target < (window?.from ?? 0) || target > replay.ticks) throw new Error('playerthree/replay: invalid target tick');
  if (window && !position) throw new Error('playerthree/replay: this replay starts at a checkpoint; pass the session checkpoint');
  let sides: Sides;
  try {
    if (!Array.isArray(replay.teams)) throw new Error('missing teams');
    sides = parseMatchSides(m, replay.teams, replay.alliances);
  } catch { throw new Error('playerthree/replay: bad match sides'); }
  const teams = sides.teams;
  const roles = (m.roles as EnumS).values as readonly string[];
  let options: Record<string, unknown> | undefined;
  try { options = parseMatchOptions(m, replay.options); }
  catch { throw new Error('playerthree/replay: bad match options'); }
  let cursor: ReplayPosition<M>;
  if (position) cursor = position;
  else {
    const created = definition.create({ seed: replay.seed, ...(options === undefined ? {} : { options: options as MatchOptionsOf<M> }), ...(sides as MatchSides<M>) });
    cursor = { adapter: created, entryIndex: 0, ...(m.signals ? { signals: new SignalBoard(m, teams, SignalBoard.limitsFor(m, created)) } : {}) };
  }
  const adapter = looseAdapter(cursor.adapter);
  const signals = cursor.signals;
  if (m.signals && !signals) throw new Error('playerthree/replay: this game\'s replay positions carry a signal board');
  if (adapter.tick > target) throw new Error('playerthree/replay: checkpoint after target');
  if (cursor.entryIndex < dropped || cursor.entryIndex > dropped + replay.entries.length) throw new Error('playerthree/replay: checkpoint outside the replay window');
  const sim: Sim = { manifest: m, adapter, guard: createGuard({ onDrop: () => {} }), record: () => {} };
  const schema = intentSchema(m);
  // Pauses do not touch the simulation; the seats holding one come from the pause/resume entries before the target.
  // Checkpoints are taken after a step, never inside a pause, so a window starts unpaused.
  const paused: { team: string; role: string }[] = [];
  // A team forfeits at most once; a checkpoint position already applied the forfeits before it.
  const forfeited = new Set<string>();
  for (const entry of replay.entries.slice(0, cursor.entryIndex - dropped)) {
    if (!Array.isArray(entry)) continue;
    trackPause(paused, entry);
    if (entry[3] === 'forfeit') forfeited.add(entry[1]);
  }
  yield cursor;
  for (; cursor.entryIndex - dropped < replay.entries.length;) {
    const entry = replay.entries[cursor.entryIndex - dropped]!;
    if (!Array.isArray(entry)) throw new Error('playerthree/replay: invalid entry');
    const [tick, team, role, op] = entry;
    if (!Number.isSafeInteger(tick) || tick < adapter.tick || tick > replay.ticks) throw new Error('playerthree/replay: entries out of order');
    if (!teams.includes(team) || !roles.includes(role)) throw new Error('playerthree/replay: unknown seat');
    if (tick > target) break;
    if (!(yield* stepTo(cursor, tick))) throw new Error('playerthree/replay: entry after the match ended');
    const seat = { team, role };
    if (op === 'intent') {
      const c = checkIntent(m, schema, role, entry[4]);
      if (!c.ok || isSignalIntent(m, c.intent)) throw new Error('playerthree/replay: invalid intent');
      if (!INTENT_SOURCES.includes(entry[5]) || entry.length !== (entry[5] === 'owner' ? 7 : 6)) throw new Error('playerthree/replay: invalid intent source');
      const ownerRoles = entry[6];
      if (entry[5] === 'owner' && (!Array.isArray(ownerRoles) || !ownerRoles.includes(role) ||
        new Set(ownerRoles).size !== ownerRoles.length || ownerRoles.some((value) => !roles.includes(value)))) {
        throw new Error('playerthree/replay: invalid owner roles');
      }
      applyIntent(sim, seat, c.intent, { source: entry[5], ...(ownerRoles === undefined ? {} : { ownerRoles }) });
    } else if (op === 'signal') {
      // Recorded only when accepted, so re-applying it to the replayed board must accept it again.
      const c = checkIntent(m, schema, role, entry[4]);
      if (!c.ok || !signals || !isSignalIntent(m, c.intent) || !signals.apply(team, role, c.intent, adapter.tick).ok) throw new Error('playerthree/replay: invalid signal entry');
    } else if (op === 'seat') {
      const controller = entry[4] as Controller;
      if (!CONTROLLERS.includes(controller)) throw new Error('playerthree/replay: invalid seat entry');
      adapter.setSeatInfo(seat, { controller, mandate: parseMandate(m, entry[5]) });
    } else if (op === 'pause' || op === 'resume') {
      trackPause(paused, entry);
    } else if (op === 'forfeit') {
      // Team-level: the role slot holds the manifest's first role and nothing follows the op.
      if (entry.length !== 4 || role !== roles[0] || forfeited.has(team) || !adapter.forfeit) throw new Error('playerthree/replay: invalid forfeit entry');
      forfeited.add(team);
      adapter.forfeit(team);
    } else throw new Error('playerthree/replay: unknown entry');
    cursor.entryIndex++;
    yield cursor;
  }
  yield* stepTo(cursor, target);
  return { adapter: cursor.adapter, ...(signals ? { signals } : {}), outcomes: Object.fromEntries(teams.map((t) => [t, adapter.outcome(t)])), paused };
}

/** Step until tick; false if the game stopped advancing (it ended) first. */
function* stepTo<M extends AnyManifest>(cursor: ReplayPosition<M>, tick: number): Generator<ReplayPosition<M>, boolean> {
  while (cursor.adapter.tick < tick) {
    const before = cursor.adapter.tick;
    cursor.adapter.step();
    if (cursor.adapter.tick === before) return false;
    // As live: the board turns over right after each step, before any input of the new tick.
    cursor.signals?.advance(cursor.adapter.tick);
    yield cursor;
  }
  return true;
}

function trackPause(paused: { team: string; role: string }[], entry: readonly unknown[]): void {
  const [, team, role, op, reason] = entry;
  if (op !== 'pause' && op !== 'resume') return;
  const held = paused.findIndex((p) => p.team === team && p.role === role);
  if (op === 'pause') {
    if (reason !== 'agent_absent' || held >= 0) throw new Error('playerthree/replay: invalid pause entry');
    paused.push({ team: team as string, role: role as string });
  } else {
    if (!RESUME_REASONS.includes(reason) || held < 0) throw new Error('playerthree/replay: invalid resume entry');
    paused.splice(held, 1);
  }
}
