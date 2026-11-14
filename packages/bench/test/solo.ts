import { defineManifest, t, type GameDefinition } from 'playerthree';
import { manifest as tag } from '../../playerthree/examples/tag/index.ts';

const manifest = defineManifest({
  ...tag,
  id: 'solo', title: 'Solo counter', teams: t.enum(['player']), roles: t.enum(['counter']), roleDocs: { counter: 'Increment the counter.' },
  intents: { increment: { roles: ['counter'], params: {}, doc: 'Increase score.' } },
  observation: t.obj({ tick: t.int(0, 100), score: t.int(0, 100) }),
  view: t.obj({ tick: t.int(0, 100) }),
  report: t.obj({ score: t.int(0, 100) }),
  event: t.obj({ tick: t.int(0, 100), kind: t.enum(['incremented']) }),
  directive: t.obj({}), skills: [], starters: undefined,
});

export const solo: GameDefinition<typeof manifest> = {
  manifest,
  create() {
    let tick = 0;
    let score = 0;
    return {
      manifest,
      get tick() { return tick; },
      step() { tick++; },
      outcome() { return tick < 4 ? 'running' : score > 0 ? 'win' : 'loss'; },
      view() { return { tick }; },
      observe() { return { tick, score }; },
      apply() { score++; return { ok: true }; },
      report() { return { score }; },
      events() { return []; },
      setSeatInfo() {},
    };
  },
  createBot() { return { think() { return []; } }; },
};
