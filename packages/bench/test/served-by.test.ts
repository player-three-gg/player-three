import { describe, expect, it, vi } from 'vitest';
import { GENERATION_LOOKUP_CONCURRENCY, GENERATION_LOOKUP_ROUNDS, lookupServedBy } from '../src/served-by.ts';

const BASE = 'https://router.test/api';
const KEY = 'sk-fixture-secret';
const generation = (provider: string) => new Response(JSON.stringify({ data: { id: 'x', provider_name: provider } }), { status: 200 });

describe('served-host lookup by generation id', () => {
  it('looks every id up after the run, a few at a time, adding to the upstreams replies named', async () => {
    let inFlight = 0, peak = 0;
    const urls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      urls.push(String(url));
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
      inFlight++; peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return generation(String(url).endsWith('gen-3') ? 'Z.AI' : 'DeepInfra');
    });
    const ids = Array.from({ length: 10 }, (_, i) => `gen-${i}`);
    const served = await lookupServedBy({ Named: 2 }, ids, BASE, KEY, { fetch: fetcher, retryMs: 0 });
    expect(served).toEqual({ servedBy: { Named: 2, DeepInfra: 9, 'Z.AI': 1 }, unresolved: 0 });
    expect(urls[0]).toBe(`${BASE}/v1/generation?id=gen-0`);
    expect(peak).toBeLessThanOrEqual(GENERATION_LOOKUP_CONCURRENCY);
  });

  it('retries stats that are not published yet, counts what stays unknown and never echoes the key', async () => {
    const calls = new Map<string, number>();
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const id = new URL(String(url)).searchParams.get('id')!;
      const n = (calls.get(id) ?? 0) + 1;
      calls.set(id, n);
      if (id === 'gen-late') return n < 3 ? new Response(`{"error":{"message":"Generation ${id} not found"}}`, { status: 404 }) : generation('DeepInfra');
      if (id === 'gen-forbidden') return new Response('{}', { status: 401 });
      if (id === 'gen-down') throw new Error(`network down ${KEY}`);
      return new Response('{"data":{}}', { status: 200 });
    });
    const served = await lookupServedBy({}, ['gen-late', 'gen-forbidden', 'gen-down', 'gen-nameless'], BASE, KEY, { fetch: fetcher, retryMs: 0 });
    expect(served).toEqual({ servedBy: { DeepInfra: 1 }, unresolved: 3 });
    expect(JSON.stringify(served)).not.toContain(KEY);
    // A rejected key or a nameless record is final; a missing record or an outage is retried each round.
    expect(Object.fromEntries(calls)).toEqual({ 'gen-late': 3, 'gen-forbidden': 1, 'gen-down': GENERATION_LOOKUP_ROUNDS, 'gen-nameless': 1 });
  });

  it('looks nothing up without ids, a base URL or a key', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await lookupServedBy({ A: 1 }, [], BASE, KEY, { fetch: fetcher })).toEqual({ servedBy: { A: 1 }, unresolved: 0 });
    expect(await lookupServedBy({}, ['gen-1'], undefined, KEY, { fetch: fetcher })).toEqual({ servedBy: {}, unresolved: 1 });
    expect(await lookupServedBy({}, ['gen-1'], BASE, undefined, { fetch: fetcher })).toEqual({ servedBy: {}, unresolved: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
