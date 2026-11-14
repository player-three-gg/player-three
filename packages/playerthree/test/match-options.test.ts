/** Match options (manifest.matchOptions): validated by the host, handed to create() for live, practice and replay. */
import { afterEach, describe, expect, it } from 'vitest';
import { definition as tag, EXAMPLE_POLICY, manifest as tagManifest, TagGame } from '../examples/tag/index.ts';
import { PlayerThreeError, createPlayerThreeHost, replayMatch } from '../src/host/index.ts';
import type { PlayerThreeHost } from '../src/host/types.ts';
import { defineManifest, type GameDefinition } from '../src/manifest.ts';
import { t } from '../src/schema.ts';

import { mergeMatchOptions } from '../src/host/pipeline.ts';
import { toJsonSchema, validate, type Infer } from '../src/schema.ts';
const manifest = { ...tagManifest, matchOptions: t.obj({ arena: t.opt(t.enum(['small', 'large'])) }) };
type M = typeof manifest;

/** Tag with an `arena` option; records what create() and view() were given. */
function withOptions(): { definition: GameDefinition<M>; created: unknown[]; snapshots: boolean[] } {
  const created: unknown[] = [];
  const snapshots: boolean[] = [];
  const definition: GameDefinition<M> = {
    manifest,
    create(opts) {
      created.push(opts.options);
      const game = new TagGame(opts.seed);
      const view = game.view.bind(game);
      return Object.assign(game, {
        manifest,
        view(team: Parameters<typeof view>[0], o?: { snapshot: boolean }) {
          snapshots.push(o?.snapshot === true);
          return view(team);
        },
      });
    },
    createBot: tag.createBot as GameDefinition<M>['createBot'],
  };
  return { definition, created, snapshots };
}

let host: PlayerThreeHost<M> | undefined;
afterEach(() => host?.dispose());

describe('match options', () => {
  it('defineManifest requires a t.obj whose fields are all t.opt', () => {
    expect(defineManifest(manifest)).toBe(manifest);
    expect(() => defineManifest({ ...manifest, matchOptions: t.obj({ arena: t.enum(['small']) }) })).toThrow(/matchOptions\.arena/);
  });

  it('validated options reach create(); bad or undeclared options are rejected before a match exists', () => {
    const d = withOptions();
    host = createPlayerThreeHost({ definition: d.definition });
    const match = host.createMatch({ seed: 3, realtime: false, options: { arena: 'large' } });
    expect(d.created).toEqual([{ arena: 'large' }]);
    expect(match.options).toEqual({ arena: 'large' });
    host.createMatch({ seed: 3, realtime: false });
    expect(d.created[1]).toBeUndefined();
    for (const bad of [{ arena: 'huge' }, { arena: 'small', extra: 1 }, 'large', null]) {
      expect(() => host!.createMatch({ seed: 3, realtime: false, options: bad as never })).toThrow(PlayerThreeError);
    }
    expect(d.created).toHaveLength(2);
    const plain = createPlayerThreeHost({ definition: tag });
    try {
      expect(() => plain.createMatch({ realtime: false, options: { arena: 'large' } as never })).toThrow(PlayerThreeError);
    } finally {
      plain.dispose();
    }
  });

  it('replays re-create the match with its options; practice defaults to the match options', async () => {
    const d = withOptions();
    host = createPlayerThreeHost({ definition: d.definition });
    const match = host.createMatch({ seed: 5, realtime: false, options: { arena: 'small' } });
    await match.step(30);
    const replay = match.replay();
    expect(replay.options).toEqual({ arena: 'small' });
    replayMatch(d.definition, replay);
    expect(d.created.at(-1)).toEqual({ arena: 'small' });
    expect(() => replayMatch(d.definition, { ...replay, options: { arena: 'huge' } })).toThrow(/options/);

    const seat = match.seat('blue', 'runner');
    const js = { runtime: 'js' as const, code: EXAMPLE_POLICY };
    await seat.practice({ opponent: 'easy', ticks: 40, seed: 1, artifact: js });
    expect(d.created.at(-1)).toEqual({ arena: 'small' });
    await seat.practice({ opponent: 'easy', ticks: 40, seed: 1, artifact: js, options: { arena: 'large' } });
    expect(d.created.at(-1)).toEqual({ arena: 'large' });
    await expect(seat.practice({ opponent: 'easy', ticks: 40, artifact: js, options: { arena: 'huge' } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a view stream asks the game for one bootstrap snapshot, then only periodic views', async () => {
    const d = withOptions();
    host = createPlayerThreeHost({ definition: d.definition });
    const match = host.createMatch({ seed: 5, realtime: false });
    const versions: number[] = [];
    match.onView('blue', (version) => versions.push(version));
    expect(d.snapshots.filter((snapshot) => snapshot)).toHaveLength(1);
    await match.step(3);
    expect(versions.length).toBeGreaterThan(0);
    expect(d.snapshots.filter((snapshot) => snapshot)).toHaveLength(1);
    match.view('blue');
    expect(d.snapshots.at(-1)).toBe(true);
  });
});

describe('atomic object option layering', () => {
  const selector = t.obj({
    id: t.opt(t.str(16)),
    document: t.opt(t.obj({ label: t.str(16), cells: t.ints(4, 0, 9) })),
  }, 'One whole selector per layer.', { merge: 'replace' });
  const economy = t.obj({ start: t.opt(t.int(0, 100)), rate: t.opt(t.int(0, 10)) });
  const options = t.obj({ map: t.opt(selector), economy: t.opt(economy) });
  const m = defineManifest({ ...tagManifest, matchOptions: options });
  const defaults = { map: { id: 'builtin' }, economy: { start: 10, rate: 2 } };
  const document = { label: 'custom', cells: [0, 9] };

  it('retains metadata through JSON/export without changing data validation or inference', () => {
    expect(JSON.parse(JSON.stringify(selector)).merge).toBe('replace');
    expect(toJsonSchema(selector)['x-playerthree-merge']).toBe('replace');
    expect(validate(selector, { document }).ok).toBe(true);
    const typed: Infer<typeof selector> = { document };
    expect(typed).toEqual({ document });
    expect(() => t.obj({}, undefined, { merge: 'deep' } as never)).toThrow(/merge/);
    expect(() => defineManifest({ ...tagManifest, observation: { t: 'obj', fields: {}, merge: 'deep' } } as never)).toThrow(/merge/);
  });

  it('replaces only annotated objects, retains omitted layers, and snapshots every result', () => {
    const over = { map: { document }, economy: { start: 20 } };
    const result = mergeMatchOptions(options, defaults, over);
    expect(result).toEqual({ map: { document }, economy: { start: 20, rate: 2 } });
    expect(mergeMatchOptions(options, result, { map: { id: 'other' } })).toEqual({ map: { id: 'other' }, economy: { start: 20, rate: 2 } });
    expect(mergeMatchOptions(options, defaults, {})).toEqual(defaults);
    expect(mergeMatchOptions(options, defaults, undefined)).toEqual(defaults);
    expect(mergeMatchOptions(options, undefined, over)).toEqual(over);
    expect(mergeMatchOptions(options, undefined, undefined)).toBeUndefined();
    document.cells[0] = 1;
    expect(result).toMatchObject({ map: { document: { cells: [0, 9] } } });
    document.cells[0] = 0;
  });

  it('finds atomic objects inside union variants and rejects invalid merged outputs', () => {
    const nested = t.obj({ choice: t.union('kind', { selected: { map: selector }, idle: {} }) });
    expect(mergeMatchOptions(nested, { choice: { kind: 'selected', map: { id: 'old' } } }, { choice: { kind: 'selected', map: { document } } })).toEqual({ choice: { kind: 'selected', map: { document } } });
    expect(() => mergeMatchOptions(options, defaults, { map: { document: { label: 'x', cells: [99] } } })).toThrow(PlayerThreeError);
  });

  it('applies whole-selector replacement to host defaults, live matches, and match/lobby practice', async () => {
    const created: unknown[] = [];
    const definition: GameDefinition<typeof m> = {
      ...tag, manifest: m,
      create(opts) {
        created.push(structuredClone(opts.options));
        return Object.assign(new TagGame(opts.seed), { manifest: m });
      },
    };
    const h = createPlayerThreeHost({ definition, matchOptions: defaults });
    try {
      const match = h.createMatch({ seed: 3, realtime: false, options: { map: { document }, economy: { start: 20 } } });
      expect(created.at(-1)).toEqual({ map: { document }, economy: { start: 20, rate: 2 } });
      const artifact = { runtime: 'js' as const, code: EXAMPLE_POLICY };
      const seat = match.seat('blue', 'runner');
      await seat.practice({ opponent: 'idle', ticks: 1, seed: 1, artifact });
      expect(created.at(-1)).toEqual(match.options);
      await seat.practice({ opponent: 'idle', ticks: 1, seed: 2, artifact, options: { map: { id: 'fresh' } } });
      expect(created.at(-1)).toEqual({ map: { id: 'fresh' }, economy: { start: 10, rate: 2 } });
      const commander = h.commanders.create('atomic_owner_0001', { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } });
      const lobby = h.agentSession(h.commanders.token('atomic_owner_0001', commander.id))!.control;
      await lobby.practice({ opponent: 'idle', ticks: 1, seed: 3, artifact, options: { map: { document } } });
      expect(created.at(-1)).toEqual({ map: { document }, economy: { start: 10, rate: 2 } });
      expect(match.replay().options).toEqual(match.options);
    } finally {
      h.dispose();
    }
  });
});
