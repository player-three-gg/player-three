/**
 * Router key billing (SPEC §20.11): a model with `billing: "openrouter-key"` has its key's cumulative billed USD
 * (`GET <baseUrl>/v1/key`, `data.usage`) read before authoring and polled during it, so authoring also stops when the
 * billed delta reaches the per-run cost ceiling. Key usage is account-wide (concurrent use of the key counts) and lags
 * generation by seconds, so the runner's own estimate stays the first line and the billed delta a second, independent
 * one. The key goes only to the model's own base URL as the bearer; it is never logged, stored or returned.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { GENERATION_LOOKUP_ROUNDS, GENERATION_LOOKUP_RETRY_MS } from './served-by.ts';

/** Poll period while authoring runs. */
export const KEY_USAGE_POLL_MS = 20_000;
/** Wait after authoring before the final read: OpenRouter usually bills a generation within seconds of its reply. */
export const KEY_USAGE_SETTLE_MS = 30_000;

export interface KeyUsageOptions { signal?: AbortSignal; fetch?: typeof globalThis.fetch }

/** The key's cumulative billed USD, or null when the router does not report it (any failure). */
export async function routerKeyUsage(baseUrl: string, apiKey: string, options: KeyUsageOptions = {}): Promise<number | null> {
  try {
    const res = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/v1/key`, { headers: { authorization: `Bearer ${apiKey}` }, signal: options.signal });
    if (!res.ok) { await res.body?.cancel(); return null; }
    const body: unknown = await res.json();
    const data = body !== null && typeof body === 'object' && 'data' in body ? body.data : undefined;
    const usage = data !== null && typeof data === 'object' && 'usage' in data ? Number(data.usage) : NaN;
    return Number.isFinite(usage) && usage >= 0 ? usage : null;
  } catch {
    return null;
  }
}

/** Billed USD around one attempt: the key's usage before, after settling, and their difference (null when unread). */
export interface BilledUsage { beforeUsd: number; afterUsd: number | null; deltaUsd: number | null }

export interface KeyUsageWatch {
  /** Stops polling and reads the settled usage (`settle: false` reads at once, e.g. after an operator stop). */
  finish(settle: boolean): Promise<BilledUsage>;
}

export interface WatchKeyUsageOptions extends Omit<KeyUsageOptions, 'signal'> {
  baseUrl: string; apiKey: string; ceilingUsd: number;
  /** Called once when the billed delta reaches `ceilingUsd`. */
  onCeiling: () => void;
  pollMs?: number;
  settleMs?: number;
}

/** Starts watching the key; null when the router does not report its usage (the runner estimate alone then caps the run). */
export async function watchKeyUsage(options: WatchKeyUsageOptions): Promise<KeyUsageWatch | null> {
  const read = (signal?: AbortSignal) => routerKeyUsage(options.baseUrl, options.apiKey, { fetch: options.fetch, signal });
  const beforeUsd = await read();
  if (beforeUsd === null) return null;
  const stop = new AbortController();
  let tripped = false;
  const polling = (async () => {
    while (!stop.signal.aborted) {
      await sleep(options.pollMs ?? KEY_USAGE_POLL_MS, undefined, { signal: stop.signal }).catch(() => {});
      if (stop.signal.aborted) return;
      const now = await read(stop.signal);
      if (now !== null && !tripped && now - beforeUsd >= options.ceilingUsd) { tripped = true; options.onCeiling(); }
    }
  })();
  return {
    async finish(settle) {
      stop.abort();
      await polling;
      if (settle) await sleep(options.settleMs ?? KEY_USAGE_SETTLE_MS);
      const afterUsd = await read();
      return { beforeUsd, afterUsd, deltaUsd: afterUsd === null ? null : +(afterUsd - beforeUsd).toFixed(9) };
    },
  };
}

export interface GenerationCostOptions extends KeyUsageOptions {
  /** Pause between lookups of a generation not yet published; tests shorten it. */
  retryMs?: number;
}

/**
 * The USD the router billed for one generation (OpenRouter `GET <baseUrl>/v1/generation?id=`, `data.total_cost`), for a
 * reply that carried no `usage.cost`. A generation's stats can lag its reply, so 404, 408, 429, 5xx and network
 * failures are retried a few times; null when it stays unknown.
 */
export async function routerGenerationCost(baseUrl: string, apiKey: string, id: string, options: GenerationCostOptions = {}): Promise<number | null> {
  for (let round = 0; round < GENERATION_LOOKUP_ROUNDS && !options.signal?.aborted; round++) {
    if (round > 0) await sleep(options.retryMs ?? GENERATION_LOOKUP_RETRY_MS, undefined, { signal: options.signal }).catch(() => {});
    let res: Response;
    try { res = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/v1/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: options.signal }); }
    catch { continue; }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 404 || res.status === 408 || res.status === 429 || res.status >= 500) continue;
      return null;
    }
    try {
      const body: unknown = await res.json();
      const data = body !== null && typeof body === 'object' && 'data' in body ? body.data : undefined;
      const cost = data !== null && typeof data === 'object' && 'total_cost' in data ? Number(data.total_cost) : NaN;
      return Number.isFinite(cost) && cost >= 0 ? cost : null;
    } catch { return null; }
  }
  return null;
}
