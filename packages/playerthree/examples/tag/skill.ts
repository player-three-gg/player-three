/** Tag's developer strategy skill (`manifest.skills`) and the example JS policy it ships. */
import type { SkillDef } from 'playerthree';

/** Example policy shipped with the skill. Agents start from it, practice, read reports, and revise. */
export const EXAMPLE_POLICY = `// Tag example policy (PlayerThree JS ABI): define think(obs) -> intents[]; log(...) is your only output channel.
var calls = 0;

function think(obs) {
  calls++;
  if (obs.you.respawning) return [];
  var home = obs.bases.filter(function (b) { return b.team === obs.team; })[0];
  var enemyBase = obs.bases.filter(function (b) { return b.team !== obs.team; })[0];
  var defend = obs.directive.stance === 'defend' || (obs.directive.stance === 'balanced' && obs.you.role === 'guard');
  if (defend) {
    var intruder = obs.enemies.filter(function (e) { return obs.team === 'blue' ? e.x < 8 : e.x >= 8; })[0];
    if (intruder) return [{ kind: 'move', x: intruder.x, y: intruder.y }];
    return [{ kind: 'move', x: home.x + (obs.team === 'blue' ? 3 : -3), y: home.y }];
  }
  if (calls % 25 === 1) log('carrying', obs.you.carrying, 'score', obs.score.mine, obs.score.theirs);
  if (obs.you.carrying) return [{ kind: 'move', x: home.x, y: home.y }];
  // Defenders guard the front of the flag: reach the enemy edge 4 rows to the board-center side, then slide in.
  var flankY = enemyBase.y < 8 ? enemyBase.y + 4 : enemyBase.y - 4;
  if (obs.you.x !== enemyBase.x) return [{ kind: 'move', x: enemyBase.x, y: flankY }];
  return [{ kind: 'move', x: enemyBase.x, y: enemyBase.y }];
}
`;

/**
 * Tag's starter (spec §11 *Starters*): a tunable baseline agents deploy by reference,
 * `policy_deploy {"from":"tag-strategy/policies/starter.js","knobs":{…}}`. It imports a helper module like any skill file.
 */
export const STARTER_POLICY = `// Tag starter (PlayerThree starter ABI): createPolicy(knobs) returns one seat's { think, init? }.
import { ownHalf } from './lib/board.js';

export const knobs = {
  type: 'object',
  additionalProperties: false,
  description: 'How the Tag starter plays.',
  properties: {
    stance: { type: 'string', enum: ['owner', 'attack', 'defend', 'balanced'], default: 'owner', description: 'owner: follow the directive; otherwise override it.' },
    flank: { type: 'integer', minimum: 0, maximum: 7, default: 4, description: 'Rows toward the board centre from which the runner approaches the enemy flag.' },
    guardOffset: { type: 'integer', minimum: 3, maximum: 6, default: 3, description: 'Cells in front of its own flag where the guard posts.' },
    dashHome: { type: 'boolean', default: true, description: 'The runner dashes home while carrying the flag.' },
  },
};

export function createPolicy(options) {
  const k = { stance: 'owner', flank: 4, guardOffset: 3, dashHome: true, ...options };
  return {
    think(obs) {
      if (obs.you.respawning) return [];
      const home = obs.bases.find((b) => b.team === obs.team);
      const enemyBase = obs.bases.find((b) => b.team !== obs.team);
      const stance = k.stance === 'owner' ? obs.directive.stance : k.stance;
      if (stance === 'defend' || (stance === 'balanced' && obs.you.role === 'guard')) {
        const intruder = obs.enemies.find((e) => ownHalf(obs.team, e.x));
        if (intruder) return [{ kind: 'move', x: intruder.x, y: intruder.y }];
        return [{ kind: 'move', x: home.x + (obs.team === 'blue' ? k.guardOffset : -k.guardOffset), y: home.y }];
      }
      if (obs.you.carrying) {
        const intents = [{ kind: 'move', x: home.x, y: home.y }];
        if (k.dashHome && obs.you.role === 'runner' && obs.dashReady) intents.push({ kind: 'dash' });
        return intents;
      }
      const flankY = enemyBase.y < 8 ? enemyBase.y + k.flank : enemyBase.y - k.flank;
      if (obs.you.x !== enemyBase.x) return [{ kind: 'move', x: enemyBase.x, y: flankY }];
      return [{ kind: 'move', x: enemyBase.x, y: enemyBase.y }];
    },
  };
}
`;

const BOARD_LIB = `// Shared board geometry for Tag policies.
export function ownHalf(team, x) {
  return team === 'blue' ? x < 8 : x >= 8;
}
`;

export const tagSkill: SkillDef = {
  name: 'tag-strategy',
  description: 'How to win Tag (capture the flag): strategy notes and an example policy to start from.',
  files: {
    'SKILL.md': `---
name: tag-strategy
description: How to win Tag (capture the flag) - strategy notes and an example policy to start from.
---

# Tag strategy

- The runner scores; the guard keeps your flag home. A tagged carrier loses the flag instantly, so the
  carrier's path home matters more than the path in.
- Defenders only tag on their own half, and nobody may stand within 2 cells of their own flag, so guards post
  3 cells in front of it. Come in along the enemy's edge column from the flank instead of head-on, and \`dash\`
  when a defender gets close.
- The \`hard\` opponent flanks, dashes and intercepts intruders on its half (carriers first). Practice against it early.
- Directives: \`attack\` sends both pieces forward, \`defend\` keeps both home. Respect the owner's stance.

## Example policy

\`policies/simple.js\` is a working policy: it beats \`idle\` and \`easy\` but only draws against \`hard\`. Deploy it first, then practice
against \`hard\`, read the report (captures, tagsMade, timesTagged) and your logs, and revise.

## Starter

\`policies/starter.js\` is a tunable baseline (topic \`starters\`): deploy it with \`policy_deploy {"from":"tag-strategy/policies/starter.js"}\`
and tune its knobs (\`stance\`, \`flank\`, \`guardOffset\`, \`dashHome\`), or fork it into your own modules.
`,
    'policies/simple.js': EXAMPLE_POLICY,
    'policies/starter.js': STARTER_POLICY,
    'policies/lib/board.js': BOARD_LIB,
  },
};
