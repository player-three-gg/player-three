import { defineManifest, t, type GameDefinition } from 'playerthree';
import { manifest as tag } from '../../playerthree/examples/tag/manifest.ts';

const matchData = t.obj({ increment: t.int(1, 10) });
const manifest = defineManifest({
  ...tag, id: 'bench-counter', title: 'Benchmark counter',
  matchOptions: t.obj({ endAt: t.opt(t.int(1, 100)), increment: t.opt(t.int(1, 10)) }),
  intents: { increment: { roles: ['runner', 'guard'], params: { amount: t.int(1, 10000) }, doc: 'Increment the team score.' } },
  matchData,
  observation: t.obj({ tick: t.int(0, 100), score: t.int(0, 10000), other: t.int(0, 10000) }),
  view: t.obj({ tick: t.int(0, 100) }),
  report: t.obj({ score: t.int(0, 10000) }),
  event: t.obj({ tick: t.int(0, 100), kind: t.enum(['incremented']) }),
  directive: t.obj({}), skills: [], starters: undefined,
});
export const definition: GameDefinition<typeof manifest> = {
  manifest,
  create({ seed, options }) {
    let tick = 0;
    const score = { blue: seed % 3, red: seed % 3 };
    const other = (team: 'blue' | 'red') => team === 'blue' ? 'red' : 'blue';
    return {
      manifest,
      get tick() { return tick; },
      step() { tick++; },
      outcome(team) { return tick < (options?.endAt ?? 4) ? 'running' : score[team] === score[other(team)] ? 'draw' : score[team] > score[other(team)] ? 'win' : 'loss'; },
      view() { return { tick }; },
      observe({ team }) { return { tick, score: score[team], other: score[other(team)] }; },
      matchData() { return { increment: options?.increment ?? 1 }; },
      apply({ team }, intent) { score[team] += intent.amount; return { ok: true }; },
      report(team) { return { score: score[team] }; },
      events() { return []; },
      setSeatInfo() {},
    };
  },
  createBot(_seat, opponent) {
    let increment: number | undefined;
    return {
      init(data) {
        if (increment !== undefined) throw new Error('repeated bot initialization');
        if (!data) throw new Error('missing bot bootstrap');
        increment = data.increment;
      },
      think(obs) {
        if (increment === undefined) throw new Error('missing bot bootstrap');
        if ('match' in obs) throw new Error('static observation');
        return opponent === 'idle' ? [] : [{ kind: 'increment', amount: (obs.other + 1) * increment }];
      },
    };
  },
  metrics(game) {
    let collected = 0;
    let tickSum = 0;
    return {
      collect() { collected++; tickSum += game.tick; },
      finish() { return { match: { collected, tickSum, minutes: game.tick / manifest.tickRate / 60 }, sides: {
        blue: { score: game.report('blue').score }, red: { score: game.report('red').score },
      } }; },
    };
  },
};
export const invalidMetrics: GameDefinition<typeof manifest> = {
  ...definition, metrics() { return { collect() {}, finish() { return { match: { broken: NaN }, sides: {} }; } }; },
};
export default definition;
