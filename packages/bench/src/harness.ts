/**
 * Authoring harnesses (SPEC §20.11): what drives a model through one replicate's lobby authoring. The default is
 * `@playerthree/runner`'s own loop, run in-process by the bench host; an {@link AuthoringHarness} replaces it with an
 * external agent (`openCodeHarness`). The host owns the lobby, the commander, the starter pre-deploy, the ceilings and
 * the frozen artifacts; a harness only connects the model to the commander and meters its turns through the lobby.
 */
import type { Price } from '@playerthree/runner';
import type { BenchModel } from './config.ts';

/** A harness's versioned identity: the suite's `harness` must equal it. */
export interface HarnessIdentity { id: string; version: string }

/** One completed model turn as the harness measured it. */
export interface MeteredTurn {
  inputTokens: number;
  outputTokens: number;
  /** The upstream that served it, when the router names it. */
  servedBy?: string;
  /** The router's generation id. */
  generationId?: string;
  /** Of `inputTokens`, those read from the provider's prompt cache (OpenRouter `prompt_tokens_details.cached_tokens`). */
  cachedInputTokens?: number;
  /** USD the router reports charging for it (OpenRouter `usage.cost`, else its generation's `total_cost`). */
  reportedUsd?: number;
}

/**
 * What a turn is charged against the run's ceilings: the router-reported cost when there is one, else a cache-aware
 * list-price estimate (cached input at `cacheReadPerM`, the rest at `inPerM`); null when neither is known.
 */
export function turnCostUsd(price: Price | undefined, turn: MeteredTurn): number | null {
  if (turn.reportedUsd !== undefined) return turn.reportedUsd;
  if (!price) return null;
  const cached = Math.min(turn.cachedInputTokens ?? 0, turn.inputTokens);
  return ((turn.inputTokens - cached) * price.inPerM + cached * (price.cacheReadPerM ?? price.inPerM) + turn.outputTokens * price.outPerM) / 1e6;
}

/** The lobby one authoring attempt runs in. Credentials here are never logged or written to a transcript. */
export interface AuthoringLobby {
  /** Loopback MCP endpoint of the lobby host. */
  url: string;
  /** The lobby commander's credential. */
  token: string;
  /** The pinned surface hash (`playerthree-mcp --expect-hash`). */
  surfaceHash: string;
  /** Every role the commander commands, each with its own policy. */
  roles: readonly string[];
  model: BenchModel;
  /** The model's provider key, read from its environment variable by the host. */
  apiKey: string;
  /** A model reply's output cap (`authoring.maxOutputTokens`). */
  maxOutputTokens: number;
  /** The runner-authored brief: the runner's system prompt for the kept tools plus the benchmark phase note. */
  brief: string;
  /** Game tools the harness must not expose (live play: act, sequence, publish). */
  blockedTools: readonly string[];
  /** Active policy per role and the last practice result, read by the host without model tokens. */
  status(): string;
  /** Whether a turn of up to `input` + `output` tokens fits every remaining ceiling. */
  canAfford(input: number, output: number): boolean;
  /** Charges a completed turn at {@link turnCostUsd}; false when the run is now over a ceiling, so the reply must be withheld. */
  charge(turn: MeteredTurn): boolean;
  /** Appends one event to the attempt's private JSONL transcript. */
  transcript(event: Record<string, unknown>): void;
  /** A private directory for this attempt; the host removes it afterwards. */
  scratch: string;
  /** Ends authoring: the wall clock, an operator stop or the billed-usage ceiling. */
  signal: AbortSignal;
  /** When the wall clock ends authoring (`Date.now()` ms), for the model's status. */
  deadlineAt: number;
}

/** Why a harness stopped: the deadline (`cutoff`), a ceiling, a provider failure or its own failure. */
export type HarnessStop = 'cutoff' | 'budget' | 'provider_error' | 'surface_changed' | 'harness_error';

export interface HarnessOutcome {
  reason: HarnessStop;
  /** Model turns charged. */
  turns: number;
  /** HTTP status of the last provider failure (null for a network failure), when `reason` is `provider_error`. */
  providerStatus?: number | null;
}

export interface AuthoringHarness {
  readonly identity: HarnessIdentity;
  author(lobby: AuthoringLobby): Promise<HarnessOutcome>;
}
