/** Tag's `GameDefinition` (`definition`, the export `playerthree dev|lint|audit` load by default): manifest, simulation and built-in bots. */
import type { GameDefinition } from 'playerthree';
import { createBot } from './bots.ts';
import { TagGame } from './game.ts';
import { manifest, TEAMS, type TagManifest } from './manifest.ts';

export const definition: GameDefinition<TagManifest> = {
  manifest,
  create: ({ seed, teams, alliances }) => {
    // Tag is a duel: both teams, never allied.
    if (teams.length !== TEAMS.length || Object.values(alliances ?? {}).some((members) => members.length > 1)) throw new Error('tag: a match is blue against red');
    return new TagGame(seed);
  },
  createBot,
};

export { manifest, TagGame, type TagManifest };
export { EXAMPLE_POLICY } from './skill.ts';
