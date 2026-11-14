/**
 * Built-in bots. They use exactly the intents agents use, so they double as practice opponents and as the
 * reference for the example policy in the skill.
 */
import type { BotCommander, IntentOf, ObservationOf, OpponentOf, Seat } from 'playerthree';
import { SIZE, type TagManifest } from './manifest.ts';

type Obs = ObservationOf<TagManifest>;
type Intent = IntentOf<TagManifest>;

const mid = SIZE / 2;
const onMyHalf = (obs: Obs, x: number): boolean => (obs.team === 'blue' ? x < mid : x >= mid);
const clampY = (y: number): number => Math.min(SIZE - 1, Math.max(0, y));

function bases(obs: Obs): { home: { x: number; y: number }; enemy: { x: number; y: number }; post: { x: number; y: number } } {
  const home = obs.bases.find((b) => b.team === obs.team)!;
  const enemy = obs.bases.find((b) => b.team !== obs.team)!;
  // Guard post: just outside the own base zone, in front of the flag.
  return { home, enemy, post: { x: home.x + (obs.team === 'blue' ? 3 : -3), y: home.y } };
}

/** Walks straight at the enemy flag and straight home; the guard stands on its post. Re-targets slowly. */
function easy(seat: Seat<TagManifest>): BotCommander<TagManifest> {
  let calls = 0;
  return {
    think(obs: Obs): Intent[] {
      if (obs.you.respawning || calls++ % 3 !== 0) return [];
      const { home, enemy, post } = bases(obs);
      if (seat.role === 'guard' && obs.directive.stance !== 'attack') return [{ kind: 'move', ...post }];
      const goal = obs.you.carrying ? home : enemy;
      return [{ kind: 'move', x: goal.x, y: goal.y }];
    },
  };
}

/** Approaches the flag from the flank, dashes away from defenders, and intercepts intruders (carriers first). */
function hard(seat: Seat<TagManifest>): BotCommander<TagManifest> {
  return {
    think(obs: Obs): Intent[] {
      if (obs.you.respawning) return [];
      const { home, enemy, post } = bases(obs);
      const defend = seat.role === 'guard' ? obs.directive.stance !== 'attack' : obs.directive.stance === 'defend';
      if (defend) {
        const intruders = obs.enemies.filter((e) => onMyHalf(obs, e.x));
        const target = intruders.find((e) => e.carrying) ?? intruders[0];
        return [{ kind: 'move', ...(target ? { x: target.x, y: target.y } : post) }];
      }
      const out: Intent[] = [];
      const threat = obs.enemies.find((e) => !onMyHalf(obs, obs.you.x) && Math.max(Math.abs(e.x - obs.you.x), Math.abs(e.y - obs.you.y)) <= 2);
      if (threat && obs.dashReady) out.push({ kind: 'dash' });
      if (obs.you.carrying) {
        out.push({ kind: 'move', x: home.x, y: home.y });
        return out;
      }
      // Flank: reach the enemy edge column on the side we are already on (never crossing the guard post in front
      // of the flag), switching sides if a visible defender holds that flank; then slide onto the flag.
      let side = obs.you.y >= enemy.y ? 1 : -1;
      if (obs.enemies.some((e) => !onMyHalf(obs, e.x) && Math.sign(e.y - enemy.y) === side && Math.abs(e.x - enemy.x) <= 3)) side = -side;
      const flank = { x: enemy.x, y: clampY(enemy.y + side * 4) };
      const atFlankColumn = obs.you.x === enemy.x;
      out.push({ kind: 'move', ...(atFlankColumn ? { x: enemy.x, y: enemy.y } : flank) });
      return out;
    },
  };
}

export function createBot(seat: Seat<TagManifest>, opponent: OpponentOf<TagManifest>): BotCommander<TagManifest> {
  switch (opponent) {
    case 'idle':
      return { think: () => [] };
    case 'easy':
      return easy(seat);
    case 'hard':
      return hard(seat);
  }
}
