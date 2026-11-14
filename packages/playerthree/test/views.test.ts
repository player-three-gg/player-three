/** Team view streams: one keyframe, then structural deltas that rebuild every version exactly (SPEC: team views). */
import { afterEach, describe, expect, it } from 'vitest';
import { definition as tag, manifest as tagManifest, TagGame } from '../examples/tag/index.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeMatch } from '../src/host/types.ts';
import { VIEW_MAX_BATCH, ViewStream } from '../src/host/views.ts';
import type { GameDefinition } from '../src/manifest.ts';
import { applyView, type ViewMessage, type ViewState } from '../src/protocol.ts';
import { t } from '../src/schema.ts';

/** Tag whose view carries a static `setup` member like a game's match data: on snapshots and the first incremental view only. */
const manifest = { ...tagManifest, view: t.obj({ ...tagManifest.view.fields, setup: t.opt(t.int(0, 100)) }) };
type M = typeof manifest;
let viewCalls = 0;
const definition: GameDefinition<M> = {
  manifest,
  create(opts) {
    const game = new TagGame(opts.seed);
    const view = game.view.bind(game);
    const sent = new Set<string>();
    return Object.assign(game, {
      manifest,
      view(team: Parameters<typeof view>[0], o?: { snapshot: boolean }) {
        viewCalls++;
        const first = !sent.has(team);
        sent.add(team);
        return o?.snapshot === true || first ? { ...view(team), setup: 7 } : view(team);
      },
    });
  },
  createBot: tag.createBot as GameDefinition<M>['createBot'],
};

let host: PlayerThreeHost<M> | undefined;
afterEach(() => host?.dispose());

function match(): PlayerThreeMatch<M> {
  host = createPlayerThreeHost({ definition });
  return host.createMatch({ seed: 4, realtime: false, controllers: { blue: { runner: 'bot', guard: 'bot' }, red: { runner: 'bot', guard: 'bot' } } });
}

function read(state: ViewState | undefined, messages: readonly ViewMessage[]): ViewState | undefined {
  for (const message of messages) state = applyView(state, message);
  return state;
}

describe('view streams', () => {
  it('a reader rebuilds exactly the snapshot view at every version, static members included', async () => {
    const m = match();
    // The adapter already sent `setup` once (this snapshot): its incremental views omit it from here on.
    m.view('blue');
    await m.step(5);
    const versions: number[] = [];
    m.onView('blue', (version) => versions.push(version));
    let state = read(undefined, m.viewMessages('blue'));
    expect(state?.view).toEqual(m.view('blue'));
    for (let i = 0; i < 30; i++) {
      await m.step(1);
      const messages = m.viewMessages('blue', state!.version);
      // Consecutive versions travel as deltas, never as a second keyframe.
      expect(messages.every((message) => 'delta' in message)).toBe(true);
      state = read(state, messages);
      expect(state?.version).toBe(versions.at(-1));
      expect(state?.view).toEqual(m.view('blue'));
    }
  });

  it('a reader too far behind gets one keyframe; within the batch, exactly the deltas it missed', async () => {
    const m = match();
    m.onView('red', () => {});
    const start = read(undefined, m.viewMessages('red'))!;
    for (let i = 0; i < VIEW_MAX_BATCH; i++) await m.step(1);
    const caught = m.viewMessages('red', start.version);
    expect(caught).toHaveLength(VIEW_MAX_BATCH);
    expect(read(start, caught)?.view).toEqual(m.view('red'));
    await m.step(1);
    const behind = m.viewMessages('red', start.version);
    expect(behind).toHaveLength(1);
    expect('view' in behind[0]!).toBe(true);
    expect(read(start, behind)?.view).toEqual(m.view('red'));
    // Shared and frozen: every reader gets the same message objects.
    expect(m.viewMessages('red', start.version)[0]).toBe(behind[0]);
    expect(Object.isFrozen(behind[0])).toBe(true);
  });

  it('a multi-tick step adds one version, not one per game tick nobody could have seen', async () => {
    const m = match();
    const versions: number[] = [];
    m.onView('blue', (version) => versions.push(version));
    await m.step(50);
    expect(versions).toHaveLength(1);
    const state = read(undefined, m.viewMessages('blue'))!;
    expect(state.view).toEqual(m.view('blue'));
  });

  it('streams are computed only while subscribed and restart from a fresh keyframe', async () => {
    const m = match();
    await m.step(3);
    const idle = viewCalls;
    await m.step(10);
    expect(viewCalls).toBe(idle);
    const off = m.onView('blue', () => {});
    const first = read(undefined, m.viewMessages('blue'))!;
    off();
    const paused = viewCalls;
    await m.step(10);
    expect(viewCalls).toBe(paused);
    m.onView('blue', () => {});
    const resumed = m.viewMessages('blue', first.version);
    // No delta bridges the idle gap: the old reader resynchronizes from a keyframe of the current state.
    expect(resumed).toHaveLength(1);
    expect('view' in resumed[0]!).toBe(true);
    expect(resumed[0]!.version).toBeGreaterThan(first.version);
    expect(read(first, resumed)?.view).toEqual(m.view('blue'));
  });
});

describe('ViewStream', () => {
  it('adds a version only for a changed view and keeps deltas bounded', () => {
    const stream = new ViewStream('blue');
    expect(stream.messages()).toEqual([]);
    expect(stream.push({ tick: 1, units: [{ id: 'a', x: 1 }] })).toBe(true);
    expect(stream.push({ tick: 1, units: [{ id: 'a', x: 1 }] })).toBe(false);
    expect(stream.version).toBe(1);
    expect(stream.push({ tick: 2, units: [{ id: 'a', x: 2 }, { id: 'b', x: 0 }] })).toBe(true);
    expect(stream.messages(1)).toEqual([{ op: 'view', team: 'blue', version: 2, delta: { v: { tick: 2 }, o: { units: { k: 1, i: ['a', 'b'], u: { a: { v: { x: 2 } }, b: { s: { id: 'b', x: 0 } } } } } } }]);
    expect(stream.messages(2)).toEqual([]);
    expect(stream.messages()).toEqual([{ op: 'view', team: 'blue', version: 2, view: { tick: 2, units: [{ id: 'a', x: 2 }, { id: 'b', x: 0 }] } }]);
  });

  it('readers treat a delta without its base version as a gap', () => {
    const delta: ViewMessage = { op: 'view', team: 'blue', version: 3, delta: { v: { tick: 3 } } };
    expect(applyView(undefined, delta)).toBeUndefined();
    expect(applyView({ version: 1, view: { tick: 1 } }, delta)).toBeUndefined();
    expect(applyView({ version: 2, view: { tick: 2 } }, delta)).toEqual({ version: 3, view: { tick: 3 } });
  });
});
