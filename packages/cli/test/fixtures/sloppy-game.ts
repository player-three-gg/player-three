// A game definition with an effectively unbounded list, used by the `playerthree lint` CLI test.
import { definition as tag } from '../../../playerthree/examples/tag/index.ts';
import type { GameDefinition } from 'playerthree';
import { t } from 'playerthree/schema';

export const definition: GameDefinition = {
  ...tag,
  manifest: { ...tag.manifest, report: t.obj({ history: t.list(t.int(0, 1), 50_000) }) },
} as GameDefinition;
