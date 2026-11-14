/**
 * Built-in bot seats (spec §11 *Bot packages*): wherever the host would call `createBot`, the game's `botPackages`
 * hook is asked first; a package made against the current surface plays the seat through the trusted runner, every
 * other case is the game's `createBot`. Both answer synchronously.
 */
import { surfaceHash } from '../briefing.ts';
import { guardedEach, loadTrustedPolicy } from '../policy/index.ts';
import type { TrustedInstance } from '../policy/types.ts';
import type { PolicyPackage } from '../policy-package.ts';
import type { AnyManifest, GameDefinition, OpponentOf, PolicyLimits, RoleOf, TeamOf } from '../manifest.ts';
import { looseDefinition, type LooseBot, type LooseDefinition, type SeatKey } from './pipeline.ts';

/** A bot playing one seat: a built-in bot, or a bot package through the trusted runner. */
export interface SeatBot {
  init?(matchData: unknown): void;
  think(obs: unknown): unknown[];
  dispose?(): void;
  /** The `hash` of the bot package playing the seat right now; undefined while a built-in bot plays it. */
  readonly packageHash?: string | undefined;
}

/**
 * The bot for `seat` at `level`: the game's registered package for that tier and role when its `surfaceHash` is the
 * current surface and the game has a policy mode (whose limits bound the runner), else `createBot`. `options` are the
 * seat's validated bot options: `createBot`'s third argument, or the package instance's `createPolicy(options)`
 * (`null` when absent). `seed` is the trusted runner's `Math.random` seed (the seed the seat's policy would get).
 */
export function createSeatBot(definition: LooseDefinition, seat: SeatKey, level: string, options: Record<string, number | boolean> | undefined, seed: number): SeatBot {
  const builtin = (): LooseBot => definition.createBot(seat, level, options);
  const pkg = definition.botPackages?.(level, seat.role);
  const limits = definition.manifest.control.policy;
  if (!pkg || !limits || pkg.surfaceHash !== surfaceHash(definition.manifest)) return builtin();
  return new PackageBot(pkg, limits, seed, options ?? null, builtin);
}

/**
 * `createSeatBot` for a typed game definition, for headless bot matches outside a host (tests, tools): the seat plays
 * exactly as a host would seat that bot tier. Drive a round of such bots with `eachBot`.
 */
export function seatBot<M extends AnyManifest>(definition: GameDefinition<M>, seat: { team: TeamOf<M>; role: RoleOf<M> }, level: OpponentOf<M>, options: Record<string, number | boolean> | undefined, seed: number): SeatBot {
  return createSeatBot(looseDefinition(definition), seat, level as string, options, seed);
}

/**
 * Runs `step(i)` for every bot of `bots` in order; with a live bot package among them, under one trusted hang guard
 * for the whole batch (`guardedEach`), so a think round pays the guard's fixed cost once rather than per seat.
 */
export function eachBot(bots: readonly { bot: SeatBot }[], step: (i: number) => void): void {
  if (bots.some((b) => b.bot instanceof PackageBot && b.bot.packageHash !== undefined)) {
    guardedEach(bots.length, step);
    return;
  }
  for (let i = 0; i < bots.length; i++) step(i);
}

/**
 * A bot package playing a seat, loaded by `init`. A package that fails to load or whose call the hang guard kills
 * (operator errors: the game registered it) hands the seat to the built-in bot, so the tier never goes idle. A call
 * that fails otherwise (it threw, bad output) answers no intents.
 */
class PackageBot implements SeatBot {
  readonly #pkg: PolicyPackage;
  readonly #limits: PolicyLimits;
  readonly #seed: number;
  readonly #options: Readonly<Record<string, number | boolean>> | null;
  readonly #builtin: () => LooseBot;
  #matchData: unknown = null;
  #instance: TrustedInstance | undefined;
  #fallback: LooseBot | undefined;

  constructor(pkg: PolicyPackage, limits: PolicyLimits, seed: number, options: Readonly<Record<string, number | boolean>> | null, builtin: () => LooseBot) {
    this.#pkg = pkg;
    this.#limits = limits;
    this.#seed = seed;
    this.#options = options;
    this.#builtin = builtin;
  }

  get packageHash(): string | undefined {
    return this.#instance ? this.#pkg.hash : undefined;
  }

  init(matchData: unknown): void {
    this.#matchData = matchData;
    const loaded = loadTrustedPolicy(this.#pkg, this.#limits, { seed: this.#seed, matchData, options: this.#options });
    if (loaded.ok) this.#instance = loaded.instance;
    else this.#fallBack();
  }

  think(obs: unknown): unknown[] {
    if (this.#fallback) return this.#fallback.think(obs);
    const instance = this.#instance;
    if (!instance) return [];
    const r = instance.call(obs);
    if (r.ok) return r.intents;
    if (instance.dead) this.#fallBack();
    return [];
  }

  dispose(): void {
    this.#instance?.dispose();
    this.#instance = undefined;
  }

  #fallBack(): void {
    this.#instance?.dispose();
    this.#instance = undefined;
    const bot = this.#builtin();
    bot.init?.(this.#matchData);
    this.#fallback = bot;
  }
}
