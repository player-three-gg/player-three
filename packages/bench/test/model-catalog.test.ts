import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenRouterCatalog, fetchOpenRouterCatalog, ModelCatalogError, OPENROUTER_MODELS_URL, projectOpenRouterCatalog, searchCatalog } from '../src/model-catalog.ts';
import { modelsMain } from '../src/models-cli.ts';

const at = '2000-01-10T00:00:00.000Z';
function fixture() {
  return { data: [{ id: 'fixture/tool-model', name: 'Fixture Tool Model', context_length: 8192,
    architecture: { input_modalities: ['text', 'future-modality'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'reasoning', 'future-parameter'],
    pricing: { prompt: '0.000001', completion: '0', request: '-1', future_price: '0.02', overrides: [{ min_prompt_tokens: 10000, prompt: '0.000002' }] },
    description: 'DO_NOT_PROJECT_PROVIDER_TEXT', arbitrary_secret: 'DO_NOT_PROJECT_PROVIDER_TEXT',
  }, { id: 'fixture/unknown-model' }] };
}
function response() { return Response.json(fixture()); }
afterEach(() => { vi.unstubAllEnvs(); });

describe('OpenRouter catalog projection', () => {
  it('preserves exact dated units, missing values, sentinels and future capability labels without raw metadata', () => {
    const catalog = projectOpenRouterCatalog(fixture(), at);
    const model = catalog.models[0]!;
    expect(model.pricing).toMatchObject({ currency: 'USD', fetchedAt: at, source: OPENROUTER_MODELS_URL, basis: 'catalog-list-price', hasConditionalRates: true });
    expect(model.pricing.rates).toEqual([
      { parameter: 'prompt', raw: '0.000001', amount: '0.000001', unit: 'input token' },
      { parameter: 'completion', raw: '0', amount: '0', unit: 'output token' },
      { parameter: 'request', raw: '-1', amount: null, unit: 'request' },
      { parameter: 'future_price', raw: '0.02', amount: '0.02', unit: null },
    ]);
    expect(model.inputModalities).toContain('future-modality');
    expect(model.supportedParameters).toContain('future-parameter');
    expect(model.supportsTools).toBe(true);
    expect(model.supportsReasoning).toBe(true);
    expect(catalog.models[1]).toMatchObject({ name: null, contextLength: null, supportedParameters: null, supportsTools: null, supportsReasoning: null, pricing: { rates: null } });
    expect(JSON.stringify(catalog)).not.toContain('DO_NOT_PROJECT_PROVIDER_TEXT');
    expect(Object.isFrozen(catalog.models)).toBe(true);
    expect(Object.isFrozen(model.pricing.rates)).toBe(true);
  });

  it('keeps explicit unsupported distinct from unknown and searches without becoming an allowlist', () => {
    const body = fixture();
    body.data[0]!.supported_parameters = [];
    const catalog = projectOpenRouterCatalog(body, at);
    expect(catalog.models[0]).toMatchObject({ supportsTools: false, supportsReasoning: false });
    expect(searchCatalog(catalog, { tools: true }).total).toBe(0);
    expect(searchCatalog(catalog, { query: 'TOOL MODEL' }).total).toBe(1);
    expect(searchCatalog(catalog, { query: 'not-in-catalog' })).toEqual({ models: [], total: 0, hasMore: false });
    expect(searchCatalog(catalog, { limit: 1 })).toMatchObject({ total: 2, hasMore: true });
    expect(() => searchCatalog(catalog, { limit: 0 })).toThrow(RangeError);
  });

  it.each([
    {}, { data: 'wrong' }, { data: [{ id: 'duplicate' }, { id: 'duplicate' }] },
    { data: [{ id: 'fixture/control\u001b' }] }, { data: [{ id: 'fixture/bad', context_length: -1 }] },
    { data: [{ id: 'fixture/bad', supported_parameters: [4] }] }, { data: [{ id: 'fixture/bad', pricing: { prompt: 4 } }] },
  ])('rejects malformed responses without echoing their contents', body => {
    expect(() => projectOpenRouterCatalog(body, at)).toThrow('OpenRouter model catalog invalid_response');
  });
});

describe('bounded catalog transport and caching', () => {
  it('defaults to anonymous fixed-origin GET and never returns request credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const catalog = await fetchOpenRouterCatalog({ fetch: fetcher, now: () => Date.parse(at) });
    expect(fetcher).toHaveBeenCalledWith(OPENROUTER_MODELS_URL, expect.objectContaining({ redirect: 'error', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) }));
    expect(catalog.fetchedAt).toBe(at);
    const authenticated = await fetchOpenRouterCatalog({ fetch: fetcher, apiKey: 'fixture-not-a-secret', now: () => Date.parse(at) });
    expect(fetcher.mock.calls[1]![1]?.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer fixture-not-a-secret' });
    expect(JSON.stringify(authenticated)).not.toContain('fixture-not-a-secret');
  });

  it('redacts network failures and upstream bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture-sensitive-upstream-detail'));
    await expect(fetchOpenRouterCatalog({ fetch: fetcher })).rejects.toThrow('OpenRouter model catalog unavailable');
    fetcher.mockImplementation(async () => new Response('fixture-sensitive-upstream-detail', { status: 401 }));
    await expect(fetchOpenRouterCatalog({ fetch: fetcher })).rejects.toEqual(new ModelCatalogError('unavailable'));
    fetcher.mockImplementation(async () => new Response('not json'));
    await expect(fetchOpenRouterCatalog({ fetch: fetcher })).rejects.toEqual(new ModelCatalogError('invalid_response'));
  });

  it('bounds both declared and streamed response bytes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }));
    await expect(fetchOpenRouterCatalog({ fetch: fetcher })).rejects.toEqual(new ModelCatalogError('response_too_large'));
    fetcher.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); } })));
    await expect(fetchOpenRouterCatalog({ fetch: fetcher })).rejects.toEqual(new ModelCatalogError('response_too_large'));
  });

  it('singleflights concurrent requests, bounds stale lifetime and backs off outages', async () => {
    let time = Date.parse(at);
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => pending.promise);
    const cache = createOpenRouterCatalog({ fetch: fetcher, now: () => time });
    const first = cache.get();
    const second = cache.get();
    expect(first).toBe(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
    pending.resolve(response());
    expect((await first).status).toBe('available');
    expect((await cache.get()).status).toBe('available');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockRejectedValue(new Error('private'));
    time += 15 * 60 * 1000;
    const stale = await cache.get();
    expect(stale.status).toBe('stale');
    expect(stale.catalog?.fetchedAt).toBe(at);
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
    time += 30 * 1000;
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(3);
    time += 24 * 60 * 60 * 1000;
    expect(await cache.get()).toEqual({ status: 'unavailable', catalog: null });
  });

  it('throttles cold-cache failures and recovers without a static fallback list', async () => {
    let time = Date.parse(at);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private'));
    const cache = createOpenRouterCatalog({ fetch: fetcher, now: () => time });
    expect(await cache.get()).toEqual({ status: 'unavailable', catalog: null });
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    time += 30 * 1000;
    fetcher.mockImplementation(async () => response());
    expect((await cache.get()).status).toBe('available');
  });
});

describe('models CLI', () => {
  it('lists/searches metadata without configuring execution or reading a key by default', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'fixture-not-a-secret');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const out: string[] = [], err: string[] = [];
    const status = await modelsMain(['--search', 'tool', '--tools', '--json'], { out: line => out.push(line), err: line => err.push(line) }, { fetch: fetcher, now: () => Date.parse(at) });
    expect(status).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out[0]!)).toMatchObject({ total: 1, fetchedAt: at, models: [{ id: 'fixture/tool-model' }] });
    expect(out.join('')).not.toContain('fixture-not-a-secret');
    expect(fetcher.mock.calls[0]![1]?.headers).toEqual({ Accept: 'application/json' });
  });

  it('fails optional discovery safely and rejects bad flags before fetching', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private upstream'));
    const out: string[] = [], err: string[] = [];
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
    expect(await modelsMain(['--limit', '0'], io, { fetch: fetcher })).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await modelsMain([], io, { fetch: fetcher })).toBe(1);
    expect(err.join('')).toContain('Existing benchmark configurations and results remain usable');
    expect(err.join('')).not.toContain('private upstream');
    expect(await modelsMain(['--help'], io, { fetch: fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
