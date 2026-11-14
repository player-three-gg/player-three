import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { definition as tag, manifest, TagGame, type TagManifest } from '../examples/tag/index.ts';
import { ReplayScrubber } from '../src/devtools/replay.ts';
import { replayMatch } from '../src/host/replay.ts';
import type { Replay, ReplayEntry } from '../src/host/types.ts';
import type { GameDefinition, Outcome } from '../src/manifest.ts';

/** Small deterministic movement simulation using Tag's real intent, seat and presentation contract. */
function fixture() {
  const calls = { steps: 0, creates: 0, clones: 0 };
  class CheckpointGame extends TagGame {
    random: number;
    checksum = 0;

    constructor(seed: number) {
      super(seed);
      this.random = seed >>> 0;
    }

    override step(): void {
      calls.steps++;
      this.tick++;
      this.random = (Math.imul(this.random, 1664525) + 1013904223) >>> 0;
      this.checksum = (Math.imul(this.checksum, 31) ^ this.random) >>> 0;
      for (const piece of this.pieces) {
        if (!piece.target) continue;
        piece.x += Math.sign(piece.target.x - piece.x);
        piece.y += Math.sign(piece.target.y - piece.y);
        if (piece.x === piece.target.x && piece.y === piece.target.y) piece.target = null;
      }
    }

    // Unlike the short example match, this fixture intentionally continues through the replay cap.
    override outcome(): Outcome { return 'running'; }

    private state(): Record<string, unknown> {
      return Object.fromEntries(Object.entries(this).filter(([key]) => key !== 'manifest'));
    }

    stateHash(): string {
      // V8 serialization is not canonical (equal cloned arrays can have different wire encodings).
      return createHash('sha256').update(JSON.stringify(this.state(), (_key, value: unknown) => value instanceof Map ? [...value] : value)).digest('hex');
    }

    clone(): CheckpointGame {
      calls.clones++;
      return Object.assign(Object.create(CheckpointGame.prototype) as CheckpointGame, {
        manifest,
        ...structuredClone(this.state()),
      });
    }
  }
  const definition: GameDefinition<TagManifest> = {
    ...tag,
    create({ seed }) {
      calls.creates++;
      return new CheckpointGame(seed);
    },
  };
  return { definition, calls, CheckpointGame };
}

function recording(): Replay {
  const entries: ReplayEntry[] = [];
  for (const tick of [0, 1, 499, 500, 501, 999, 1000, 1499, 1500, 1501, 10_000, 20_000, 35_500, 35_999, 36_000]) {
    entries.push(
      [tick, 'blue', 'runner', 'seat', tick % 2 ? 'agent' : 'bot', {
        autonomy: 'autonomous', directive: { stance: tick % 2 ? 'attack' : 'defend' }, whenAbsent: 'policy',
      }],
      [tick, 'blue', 'runner', 'intent', { kind: 'move', x: tick % 16, y: (tick * 7) % 16 }, 'owner', ['runner']],
      [tick, 'red', 'guard', 'intent', { kind: 'move', x: (tick * 3) % 16, y: (tick * 5) % 16 }, 'owner', ['guard']],
      [tick, 'blue', 'runner', 'intent', { kind: 'dash' }, 'owner', ['runner']],
    );
    // Multiple inputs exactly on checkpoint boundaries must be applied once and in recorded order.
    if (tick % 500 === 0) entries.push(
      [tick, 'blue', 'runner', 'intent', { kind: 'stop' }, 'owner', ['runner']],
      [tick, 'blue', 'runner', 'intent', { kind: 'move', x: 13, y: 2 }, 'owner', ['runner']],
    );
  }
  return {
    format: 'playerthree.replay', version: 2, game: manifest.id, gameVersion: manifest.version,
    seed: 73, ticks: 36_000, entries, teams: ['blue', 'red'], outcomes: { blue: 'running', red: 'running' },
  };
}

const signal = () => new AbortController().signal;
function hash(adapter: unknown): string {
  if (!adapter || typeof adapter !== 'object' || !('stateHash' in adapter) || typeof adapter.stateHash !== 'function') throw new Error('Expected checkpoint fixture');
  return adapter.stateHash() as string;
}

describe('ReplayScrubber checkpoints', () => {
  it('matches a fresh replay at nonmonotonic targets through all 36,000 ticks', async () => {
    const { definition, calls } = fixture();
    const scrubber = new ReplayScrubber(definition);
    const replay = recording();
    const original = structuredClone(replay);
    let previous = 0;
    try {
      for (const tick of [0, 1, 499, 500, 501, 1499, 1500, 1501, 36_000, 35_555, 505, 1500, 0, 36_000]) {
        const before = calls.steps;
        const actual = await scrubber.run(replay, tick, signal(), 'match');
        const simulated = calls.steps - before;
        if (tick < previous) expect(simulated).toBeLessThanOrEqual(500);
        previous = tick;
        const expected = replayMatch(definition, replay, tick);
        expect(actual.adapter.tick).toBe(tick);
        expect(actual.adapter).toEqual(expected.adapter);
        expect(hash(actual.adapter)).toBe(hash(expected.adapter));
        expect(actual.outcomes).toEqual(expected.outcomes);
        for (const team of ['blue', 'red'] as const) {
          expect(actual.adapter.view(team)).toEqual(expected.adapter.view(team));
          for (const role of ['runner', 'guard'] as const) {
            expect(actual.adapter.observe({ team, role }, Math.max(0, tick - 500), [])).toEqual(expected.adapter.observe({ team, role }, Math.max(0, tick - 500), []));
          }
        }
      }
      expect(replay).toEqual(original);
      expect(calls.clones).toBeGreaterThanOrEqual(73);
    } finally {
      scrubber.close();
    }
  });

  it('resumes forward and restores a nearby checkpoint for backward seeks', async () => {
    const { definition, calls } = fixture();
    const scrubber = new ReplayScrubber(definition);
    const replay = recording();
    try {
      await scrubber.run(replay, 1250, signal());
      expect(calls.steps).toBe(1250);
      expect(calls.creates).toBe(1);
      let before = calls.steps;
      await scrubber.run(replay, 1333, signal());
      expect(calls.steps - before).toBe(83);
      expect(calls.creates).toBe(1);
      before = calls.steps;
      const backward = await scrubber.run(replay, 750, signal());
      expect(calls.steps - before).toBe(250);
      expect(calls.creates).toBe(1);
      expect(hash(backward.adapter)).toBe(hash(replayMatch(definition, replay, 750).adapter));
      before = calls.steps;
      const repeated = await scrubber.run(replay, 750, signal());
      expect(calls.steps - before).toBe(0);
      expect(hash(repeated.adapter)).toBe(hash(backward.adapter));
    } finally {
      scrubber.close();
    }
  });

  it('keeps stored checkpoints isolated from returned cursors and restored clones', async () => {
    const { definition, calls, CheckpointGame } = fixture();
    const scrubber = new ReplayScrubber(definition);
    const replay = recording();
    const corrupt = (game: InstanceType<typeof CheckpointGame>) => {
      game.random = 0;
      game.checksum = 123;
      game.pieces[0]!.x = 15;
      game.pieces[0]!.target = { x: 0, y: 0 };
      game.setSeatInfo({ team: 'blue', role: 'runner' }, {
        controller: 'human', mandate: { autonomy: 'autonomous', directive: { stance: 'balanced' }, whenAbsent: 'hold' },
      });
    };
    try {
      const current = await scrubber.run(replay, 1200, signal());
      corrupt(current.adapter as InstanceType<typeof CheckpointGame>);
      let before = calls.steps;
      const restored = await scrubber.run(replay, 625, signal());
      expect(calls.steps - before).toBe(125);
      expect(hash(restored.adapter)).toBe(hash(replayMatch(definition, replay, 625).adapter));
      corrupt(restored.adapter as InstanceType<typeof CheckpointGame>);
      before = calls.steps;
      const checkpoint = await scrubber.run(replay, 500, signal());
      expect(calls.steps - before).toBe(0);
      expect(hash(checkpoint.adapter)).toBe(hash(replayMatch(definition, replay, 500).adapter));
      const originalHash = hash(checkpoint.adapter);
      const independent = checkpoint.adapter.clone!() as InstanceType<typeof CheckpointGame>;
      corrupt(independent);
      independent.step();
      expect(hash(checkpoint.adapter)).toBe(originalHash);
    } finally {
      scrubber.close();
    }
  });

  it('rejects a third simulation and releases an aborted job slot for another request', async () => {
    const { definition, calls } = fixture();
    const scrubber = new ReplayScrubber(definition);
    const replay = recording();
    const abort = new AbortController();
    const first = scrubber.run(replay, 36_000, abort.signal, 'first');
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = scrubber.run(replay, 36_000, signal(), 'second');
    try {
      await expect(scrubber.run(replay, 10, signal(), 'third')).rejects.toMatchObject({ status: 429 });
      await setImmediate();
      expect(calls.steps).toBeGreaterThan(0);
      expect(calls.steps).toBeLessThan(36_000);
      abort.abort();
      await rejected;
      const replacement = await scrubber.run(replay, 125, signal(), 'third');
      expect(replacement.adapter.tick).toBe(125);
      expect(hash(replacement.adapter)).toBe(hash(replayMatch(definition, replay, 125).adapter));
      const completed = await second;
      expect(completed.adapter.tick).toBe(36_000);
      // A cancelled partial cursor remains usable, and its per-timeline lock is released too.
      const resumed = await scrubber.run(replay, 1000, signal(), 'first');
      expect(hash(resumed.adapter)).toBe(hash(replayMatch(definition, replay, 1000).adapter));
    } finally {
      scrubber.close();
      await Promise.allSettled([first, second]);
    }
  });

  it('releases the slot even when the caller was already aborted', async () => {
    const { definition, calls } = fixture();
    const scrubber = new ReplayScrubber(definition);
    const replay = recording();
    const abort = new AbortController();
    abort.abort();
    try {
      await expect(scrubber.run(replay, 1000, abort.signal, 'same')).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls.steps).toBe(0);
      expect((await scrubber.run(replay, 1000, signal(), 'same')).adapter.tick).toBe(1000);
    } finally {
      scrubber.close();
    }
  });
});
