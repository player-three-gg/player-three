/**
 * The upstream that served each model turn, for authoring records. A router names it on the reply when it can
 * (`X-Provider-Name`); OpenRouter's Responses API does not, but every reply carries `X-Generation-Id`, and
 * `GET <baseUrl>/v1/generation?id=` returns that generation's `provider_name`. The lookups run after the run, a few at
 * a time; a generation's stats can lag its reply, so missing or rate-limited lookups are retried. The key is the
 * model's own (read from its env var by the caller) and goes only to the model's own base URL as the bearer; it is
 * never logged, stored or returned.
 */

import { setTimeout as sleep } from 'node:timers/promises';

/** Generation lookups in flight at once. */
export const GENERATION_LOOKUP_CONCURRENCY = 4;
/** Rounds over the still-unresolved ids; a round retries only lookups that may succeed later (404, 408, 429, 5xx, network). */
export const GENERATION_LOOKUP_ROUNDS = 4;
/** Pause between rounds: OpenRouter usually publishes a generation's stats within seconds of the reply. */
export const GENERATION_LOOKUP_RETRY_MS = 3_000;
/** Bound on a reported upstream name: an identifier, never request data. */
const PROVIDER_NAME_MAX = 64;

/** Served-host counts: model turns per upstream, plus turns whose upstream stayed unknown. */
export interface ServedBy {
  servedBy: Record<string, number>;
  unresolved: number;
}

export interface LookupServedByOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /** Pause between rounds; tests shorten it. */
  retryMs?: number;
}

/** One lookup: the upstream name, `retry` when it may appear later, or `null` when it never will. */
async function lookup(id: string, baseUrl: string, apiKey: string, options: LookupServedByOptions): Promise<string | 'retry' | null> {
  let res: Response;
  try {
    res = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/v1/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: options.signal });
  } catch {
    return options.signal?.aborted ? null : 'retry';
  }
  if (!res.ok) {
    await res.body?.cancel();
    return res.status === 404 || res.status === 408 || res.status === 429 || res.status >= 500 ? 'retry' : null;
  }
  try {
    const body: unknown = await res.json();
    const data = body !== null && typeof body === 'object' && 'data' in body ? body.data : undefined;
    const name = data !== null && typeof data === 'object' && 'provider_name' in data ? data.provider_name : undefined;
    return typeof name === 'string' && name !== '' ? name.slice(0, PROVIDER_NAME_MAX) : null;
  } catch {
    return null;
  }
}

/**
 * Adds the looked-up upstream of every turn in `generationIds` to `named` (turns whose reply already named it).
 * Without a base URL or key nothing is looked up and those turns stay unresolved.
 */
export async function lookupServedBy(named: Readonly<Record<string, number>>, generationIds: readonly string[], baseUrl: string | undefined, apiKey: string | undefined, options: LookupServedByOptions = {}): Promise<ServedBy> {
  const servedBy = { ...named };
  if (generationIds.length === 0) return { servedBy, unresolved: 0 };
  if (!baseUrl || !apiKey) return { servedBy, unresolved: generationIds.length };
  let pending = [...generationIds];
  let resolved = 0;
  for (let round = 0; round < GENERATION_LOOKUP_ROUNDS && pending.length > 0 && !options.signal?.aborted; round++) {
    if (round > 0) await sleep(options.retryMs ?? GENERATION_LOOKUP_RETRY_MS, undefined, { signal: options.signal }).catch(() => {});
    const retry: string[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const id = pending[next++]!;
        const found = await lookup(id, baseUrl, apiKey, options);
        if (found === 'retry') retry.push(id);
        else if (found !== null) {
          servedBy[found] = (servedBy[found] ?? 0) + 1;
          resolved++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(GENERATION_LOOKUP_CONCURRENCY, pending.length) }, worker));
    pending = retry;
  }
  return { servedBy, unresolved: generationIds.length - resolved };
}
