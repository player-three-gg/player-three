/**
 * Tag — a tiny capture-the-flag game used as PlayerThree's fixture and DX example.
 *
 * 16×16 grid, two teams (blue west, red east), two seats per team (`runner`, `guard`), one piece per seat.
 * Step on the enemy flag to pick it up, carry it to your base to score. A piece adjacent to an enemy while on
 * the enemy's half is tagged: it drops the flag and respawns at home. First to 3 captures wins.
 */
import { defineManifest, t } from 'playerthree';
import { tagSkill } from './skill.ts';

export const SIZE = 16;
export const WIN_CAPTURES = 3;
export const MAX_TICKS = 1200;
export const TICK_RATE = 10;

export const TEAMS = ['blue', 'red'] as const;
export const ROLES = ['runner', 'guard'] as const;
export const EVENT_KINDS = ['flag_taken', 'flag_returned', 'captured', 'tagged'] as const;
export const STANCES = ['balanced', 'attack', 'defend'] as const;

const team = t.enum(TEAMS);
const role = t.enum(ROLES);
const cell = { x: t.int(0, SIZE - 1, 'column'), y: t.int(0, SIZE - 1, 'row') };
const piece = t.obj({ role, ...cell, carrying: t.bool('holding the enemy flag'), respawning: t.bool() });
const flag = t.obj({ team, ...cell, carried: t.bool() }, 'a flag; `team` owns it');
const event = t.obj(
  { tick: t.int(0, 1_000_000), kind: t.enum(EVENT_KINDS), team: t.enum(TEAMS, 'team the event happened to'), role },
  'flag_taken: `team` picked up the enemy flag; flag_returned: `team` lost the flag it carried; captured: `team` scored; tagged: a `team` piece was tagged.',
);

export const manifest = defineManifest({
  id: 'tag',
  version: '1.0.0',
  title: 'Tag',
  doc:
    `Capture the flag on a ${SIZE}×${SIZE} grid. Blue's base is on the west edge, red's on the east edge; x < ${SIZE / 2} is blue's half. ` +
    'Each team has a runner and a guard; each seat drives one piece that walks one cell every 2 ticks (8 directions). ' +
    'Step on the enemy flag to carry it; bring it to your own base to capture. Your own base zone (cells within 2 of your base) is ' +
    'off-limits unless you carry the enemy flag, so nobody can camp next to their own flag. A piece standing on the enemy half next to an enemy piece ' +
    `(Chebyshev distance ≤ 1) is tagged: it drops the flag (which returns home) and respawns near its base 20 ticks later. ` +
    `First team to ${WIN_CAPTURES} captures wins; after ${MAX_TICKS} ticks the team with more captures wins, else draw. ` +
    'You see enemy pieces within 5 cells of any of your pieces; flags are always visible.',
  roleDocs: {
    runner: 'Fast attacker. Can `dash` (moves every tick for 10 ticks, 60 tick cooldown). Grab the enemy flag and bring it home.\n\nRead first: topic `tactics`.',
    guard: 'Defender. Stay on your half and tag intruders, especially an enemy carrying your flag.\n\nRead first: topic `tactics`.',
  },
  topics: {
    tactics: {
      summary: 'What wins Tag: tagging geometry, base zones, dash timing and stance',
      text:
        '# Tactics\n\n' +
        '- Tags only happen on the enemy half: your guard is safe at home and dangerous to intruders; your runner is at risk from the moment it crosses the middle (blue: x ≥ 8, red: x < 8).\n' +
        '- A tagged carrier drops the flag, which returns home at once, and respawns 20 ticks later: one tag undoes a whole run.\n' +
        '- Nobody may enter their own base zone without the enemy flag, so the defender cannot sit on its flag; guard the approach instead.\n' +
        '- Dash (runner only) doubles speed for 10 ticks and then cools down for 60: save it for the return trip with the flag, not the approach.\n' +
        '- Vision is 5 cells around your pieces: an enemy you do not see may still be close. Flags are always visible.\n' +
        '- The owner directive `stance` (attack / defend / balanced) says whether both pieces push, both defend, or each plays its role.',
    },
  },
  tickRate: TICK_RATE,
  teams: team,
  roles: role,
  intents: {
    move: { roles: ['runner', 'guard'], params: cell, doc: 'Walk toward a cell (diagonal steps allowed). Replaces the current target.' },
    stop: { roles: ['runner', 'guard'], params: {}, doc: 'Stop moving.' },
    dash: { roles: ['runner'], params: {}, doc: 'Runner only: move every tick for 10 ticks. Cooldown 60 ticks.' },
  },
  observation: t.obj({
    tick: t.int(0, 1_000_000),
    team,
    you: piece,
    dashReady: t.bool('runner: dash available'),
    allies: t.list(piece, 1),
    enemies: t.list(t.obj({ role, ...cell, carrying: t.bool() }), 2, 'enemy pieces you can see'),
    flags: t.list(flag, 2),
    bases: t.list(t.obj({ team, ...cell }), 2),
    score: t.obj({ mine: t.int(0, WIN_CAPTURES), theirs: t.int(0, WIN_CAPTURES) }),
    directive: t.obj({ stance: t.enum(STANCES) }),
    events: t.list(event, 32, 'events since the tick you passed to observe'),
  }),
  view: t.obj({
    tick: t.int(0, 1_000_000),
    pieces: t.list(t.obj({ team, role, ...cell, carrying: t.bool(), respawning: t.bool() }), 4),
    flags: t.list(flag, 2),
    score: t.obj({ blue: t.int(0, WIN_CAPTURES), red: t.int(0, WIN_CAPTURES) }),
    seats: t.list(t.obj({ role, controller: t.enum(['human', 'agent', 'policy', 'bot', 'none']) }), 2),
  }),
  directive: t.obj({ stance: t.enum(STANCES, 'attack: both pieces push; defend: both stay home; balanced: by role') }),
  errors: t.enum(['cooldown', 'respawning'], 'cooldown: dash not ready; respawning: piece is out until it respawns'),
  opponents: t.enum(['idle', 'easy', 'hard'], 'idle does nothing; easy walks straight in; hard dodges, dashes and intercepts'),
  report: t.obj({
    outcome: t.enum(['win', 'loss', 'draw', 'running']),
    ticks: t.int(0, 1_000_000),
    captures: t.int(0, WIN_CAPTURES),
    conceded: t.int(0, WIN_CAPTURES),
    flagPickups: t.int(0, 100_000),
    tagsMade: t.int(0, 100_000),
    timesTagged: t.int(0, 100_000),
  }),
  event,
  skills: [tagSkill],
  starters: {
    'tag-strategy/policies/starter.js': {
      summary: 'Baseline for both roles: follows the owner stance, flanks to the enemy flag, dashes home, guards in front of its flag',
    },
  },
  control: {
    intents: { perSecond: 4, burst: 8 },
    policy: {
      runtimes: ['js', 'wasm'],
      hz: 5,
      msPerCall: 20,
      memoryBytes: 16 << 20,
      maxArtifactBytes: 64 * 1024,
      maxIntentsPerCall: 4,
      maxLogLines: 50,
      maxLogLineBytes: 200,
    },
    stream: { maxHz: 10, intentsPerTick: 2 },
    practice: { maxTicks: MAX_TICKS, concurrent: 2 },
    pool: { maxPublishedPerPrincipal: 3 },
    chat: { maxTellChars: 500, maxSayChars: 280, ping: t.obj(cell, 'A cell the owner points at') },
  },
});

export type TagManifest = typeof manifest;
