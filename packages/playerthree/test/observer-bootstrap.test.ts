/** Team-perspective observer keyframes keep snapshot-only members for observers who join after the first tick. */
import { afterEach, expect, it } from 'vitest';
import { definition as tag, manifest as tagManifest, TagGame } from '../examples/tag/index.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import type { PlayerThreeHost } from '../src/host/types.ts';
import type { GameDefinition } from '../src/manifest.ts';
import { t } from '../src/schema.ts';

/** Tag whose view carries a static `setup` member like a game's match data: on snapshots and the first incremental view only. */
const manifest = { ...tagManifest, view: t.obj({ ...tagManifest.view.fields, setup: t.opt(t.int(0, 100)) }) };
type M = typeof manifest;
const definition: GameDefinition<M> = {
  manifest,
  create(opts) {
    const game = new TagGame(opts.seed);
    const view = game.view.bind(game);
    const sent = new Set<string>();
    return Object.assign(game, {
      manifest,
      view(team: Parameters<typeof view>[0], o?: { snapshot: boolean }) {
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

it('a late-joining team observer gets the snapshot-only members in its keyframe and every later frame', async () => {
  host = createPlayerThreeHost({ definition });
  const match = host.createMatch({ seed: 3, realtime: false, observerPolicy: { allowOmniscient: false, public: false, minDelayMs: 1 } });
  // A delayed team-only policy records both teams every real-time tick (at most one capture per ~30 ms).
  for (let i = 0; i < 3; i++) { await new Promise((resolve) => setTimeout(resolve, 40)); await match.step(1); }
  const frames = match.observerFrames({ kind: 'team', team: 'blue', delayMs: 1 })[Symbol.asyncIterator]();
  const keyframe = (await frames.next()).value;
  expect(keyframe.tick).toBeGreaterThan(0);
  expect(keyframe.world).toMatchObject({ setup: 7 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await match.step(1);
  const next = (await frames.next()).value;
  // A delta must never drop the static member the keyframe carried.
  expect(JSON.stringify(next.delta ?? {})).not.toContain('setup');
  await frames.return?.();
});
