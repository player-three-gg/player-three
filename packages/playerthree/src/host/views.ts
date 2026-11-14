/**
 * Team view streams (SPEC §4, view streams). Version `n` of a team's stream is its complete guarded view at the `n`-th push.
 * Each push is diffed against the previous version once (`playerthree/delta`); the newest `VIEW_MAX_BATCH` deltas stay
 * as shared frozen messages so a reader slightly behind catches up with exactly the deltas it missed, and every other
 * reader (a join, a new watch, one too far behind) gets one keyframe of the latest version, built once per version.
 * Fog: a stream only ever diffs consecutive views of its own team.
 */
import { diff } from '../delta.ts';
import type { ViewMessage } from '../protocol.ts';

/** A reader further behind than this many versions gets one keyframe instead of the deltas it missed. */
export const VIEW_MAX_BATCH = 20;

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key in value) freeze((value as Record<string, unknown>)[key]);
  return value;
}

export class ViewStream {
  readonly team: string;
  /** Latest version; 0 before the first push. Never reused, also across resets. */
  version = 0;
  /** Subscribers notified with each new version; the host computes the stream only while there are any. */
  readonly listeners = new Set<(version: number) => void>();
  /** The view at `version` (shared with the host's per-tick view; never mutated). */
  private head: unknown;
  /** Delta messages by `version % VIEW_MAX_BATCH`; an entry is valid only if its version matches. */
  private readonly deltas: (ViewMessage | undefined)[] = new Array<ViewMessage | undefined>(VIEW_MAX_BATCH);
  /** Keyframe of `version`, built on first demand. */
  private keyframe: ViewMessage | undefined;

  constructor(team: string) {
    this.team = team;
  }

  /** Forget everything older than the next push: nobody reads the old versions any more. */
  reset(): void {
    this.head = undefined;
    this.keyframe = undefined;
    this.deltas.fill(undefined);
  }

  /** Append the team's current complete view; false when it equals the latest version (no new version). */
  push(view: unknown): boolean {
    const first = this.head === undefined;
    const delta = first ? undefined : diff(this.head, view);
    if (!first && !delta) return false;
    this.version++;
    this.head = view;
    this.keyframe = undefined;
    this.deltas[this.version % VIEW_MAX_BATCH] = delta
      ? freeze<ViewMessage>({ op: 'view', team: this.team, version: this.version, delta })
      : undefined;
    return true;
  }

  /**
   * The messages that bring a reader at version `after` (undefined: a fresh reader) up to the latest version: every
   * missed delta in order, or one keyframe. Empty when the reader is current or nothing was pushed yet.
   */
  messages(after?: number): ViewMessage[] {
    if (this.version === 0 || after === this.version) return [];
    if (after !== undefined && after < this.version && this.version - after <= VIEW_MAX_BATCH) {
      const out: ViewMessage[] = [];
      for (let version = after + 1; version <= this.version; version++) {
        const message = this.deltas[version % VIEW_MAX_BATCH];
        // A reset (or a first push) leaves no delta into that version: only a keyframe reaches it.
        if (message?.version !== version) return [this.keyframeMessage()];
        out.push(message);
      }
      return out;
    }
    return [this.keyframeMessage()];
  }

  private keyframeMessage(): ViewMessage {
    return this.keyframe ??= freeze<ViewMessage>({ op: 'view', team: this.team, version: this.version, view: this.head });
  }
}
