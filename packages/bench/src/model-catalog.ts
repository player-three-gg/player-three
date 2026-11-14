/**
 * OpenRouter model catalog for benchmark configuration discovery (server/CLI only): a bounded, allowlisted projection
 * of the public models list. Catalog membership is neither an execution whitelist nor model identity evidence.
 */

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const MODEL_CATALOG_DISCLAIMER = 'OpenRouter catalog metadata is a discovery hint, not a whitelist or model identity attestation. Listed prices are dated estimates, not billed costs; routing, caching and conditional rates can change actual charges.';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 5000;
const FRESH_MS = 15 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 30 * 1000;

export interface CatalogPrice {
  readonly parameter: string;
  /** Exact decimal string, never a floating-point dollar conversion. Null includes provider sentinels. */
  readonly amount: string | null;
  readonly raw: string | null;
  /** Unknown future price dimensions remain unknown, not implicitly per-token. */
  readonly unit: string | null;
}
export interface ModelCatalogEntry {
  readonly id: string;
  readonly name: string | null;
  readonly contextLength: number | null;
  readonly inputModalities: readonly string[] | null;
  readonly outputModalities: readonly string[] | null;
  readonly supportedParameters: readonly string[] | null;
  readonly supportsTools: boolean | null;
  readonly supportsReasoning: boolean | null;
  readonly pricing: {
    readonly currency: 'USD';
    readonly source: typeof OPENROUTER_MODELS_URL;
    readonly fetchedAt: string;
    readonly basis: 'catalog-list-price';
    readonly hasConditionalRates: boolean | null;
    readonly rates: readonly CatalogPrice[] | null;
  };
}
export interface ModelCatalog {
  readonly source: typeof OPENROUTER_MODELS_URL;
  readonly fetchedAt: string;
  /** The unfiltered endpoint defaults to text-output models, not every OpenRouter product. */
  readonly scope: 'default-text-output-catalog';
  readonly disclaimer: typeof MODEL_CATALOG_DISCLAIMER;
  readonly models: readonly ModelCatalogEntry[];
}
export interface ModelCatalogState {
  readonly status: 'available' | 'stale' | 'unavailable';
  readonly catalog: ModelCatalog | null;
}
export interface CatalogFetchOptions {
  /** Opt-in server-side credential only; public discovery never needs an environment lookup. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}
/** A catalog fetch failed; carries a closed code only, never the provider's error text. */
export class ModelCatalogError extends Error {
  readonly code: 'unavailable' | 'invalid_response' | 'response_too_large';
  constructor(code: ModelCatalogError['code']) {
    super(`OpenRouter model catalog ${code}`);
    this.name = 'ModelCatalogError';
    this.code = code;
  }
}

const units: Readonly<Record<string, string>> = {
  prompt: 'input token', completion: 'output token', request: 'request',
  image: 'input image', image_output: 'output image', image_token: 'image token',
  audio: 'audio input token', audio_output: 'audio output token', input_audio_cache: 'cached audio input token',
  input_cache_read: 'cached input token (read)', input_cache_write: 'cache-write token (default TTL)',
  input_cache_write_1h: 'cache-write token (1 hour TTL)', internal_reasoning: 'internal reasoning token', web_search: 'web search',
};
function invalid(): never { throw new ModelCatalogError('invalid_response'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return invalid();
  return value;
}
function texts(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 128) return invalid();
  return Object.freeze(value.map(item => text(item) ?? invalid()));
}
function context(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function prices(value: unknown, fetchedAt: string): ModelCatalogEntry['pricing'] {
  if (value === undefined || value === null) return Object.freeze({ currency: 'USD', source: OPENROUTER_MODELS_URL, fetchedAt, basis: 'catalog-list-price', hasConditionalRates: null, rates: null });
  const pricing = object(value);
  if (Object.keys(pricing).length > 64) return invalid();
  if (pricing.overrides !== undefined && pricing.overrides !== null && !Array.isArray(pricing.overrides)) return invalid();
  const rates: CatalogPrice[] = [];
  for (const [parameter, value] of Object.entries(pricing)) {
    // Discounts and override structures are not unit prices. Never flatten them into an apparent total cost.
    if (parameter === 'overrides' || parameter === 'discount') continue;
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(parameter)) return invalid();
    const raw = text(value, 128);
    const amount = raw !== null && /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw) && Number.isFinite(Number(raw)) ? raw : null;
    rates.push(Object.freeze({ parameter, raw, amount, unit: Object.hasOwn(units, parameter) ? units[parameter]! : null }));
  }
  return Object.freeze({ currency: 'USD', source: OPENROUTER_MODELS_URL, fetchedAt, basis: 'catalog-list-price', hasConditionalRates: pricing.overrides == null ? null : (pricing.overrides as unknown[]).length > 0, rates: Object.freeze(rates) });
}

/** Allowlisted projection: never copy descriptions, arbitrary provider properties, request headers or response errors. */
export function projectOpenRouterCatalog(value: unknown, fetchedAt: string): ModelCatalog {
  if (!Number.isFinite(Date.parse(fetchedAt))) return invalid();
  const data = object(value).data;
  if (!Array.isArray(data) || data.length > MAX_MODELS) return invalid();
  const seen = new Set<string>();
  const models = data.map((item): ModelCatalogEntry => {
    const model = object(item);
    const id = text(model.id) ?? invalid();
    if (/\s/u.test(id) || seen.has(id)) return invalid();
    seen.add(id);
    const architecture = model.architecture == null ? null : object(model.architecture);
    const supportedParameters = texts(model.supported_parameters);
    return Object.freeze({
      id, name: text(model.name, 512), contextLength: context(model.context_length),
      inputModalities: texts(architecture?.input_modalities), outputModalities: texts(architecture?.output_modalities),
      supportedParameters,
      supportsTools: supportedParameters === null ? null : supportedParameters.includes('tools'),
      supportsReasoning: supportedParameters === null ? null : supportedParameters.some(parameter => parameter === 'reasoning' || parameter === 'include_reasoning'),
      pricing: prices(model.pricing, fetchedAt),
    });
  });
  models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return Object.freeze({ source: OPENROUTER_MODELS_URL, fetchedAt, scope: 'default-text-output-catalog', disclaimer: MODEL_CATALOG_DISCLAIMER, models: Object.freeze(models) });
}

/** One fetch of the catalog (10 s timeout, at most 8 MiB, no redirects); `apiKey`, if given, is sent as a bearer token. */
export async function fetchOpenRouterCatalog(options: CatalogFetchOptions = {}): Promise<ModelCatalog> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  try {
    // A fixed origin and redirect rejection keep optional credentials away from arbitrary destinations.
    const response = await (options.fetch ?? globalThis.fetch)(OPENROUTER_MODELS_URL, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelCatalogError('unavailable');
    }
    if (!response.body) throw new ModelCatalogError('invalid_response');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body.cancel();
      throw new ModelCatalogError('response_too_large');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    const chunks: string[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new ModelCatalogError('response_too_large');
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(chunks.join('')); } catch { throw new ModelCatalogError('invalid_response'); }
    return projectOpenRouterCatalog(body, new Date((options.now ?? Date.now)()).toISOString());
  } catch (error) {
    // Fetch errors can contain URLs/headers; callers receive only closed local error codes.
    throw error instanceof ModelCatalogError ? error : new ModelCatalogError('unavailable');
  }
}

/** One bounded snapshot and one in-flight fetch per instance; outage cooldown also covers a cold cache. */
export function createOpenRouterCatalog(options: CatalogFetchOptions = {}): { get(): Promise<ModelCatalogState> } {
  const now = options.now ?? Date.now;
  let cached: ModelCatalog | null = null;
  let fetchedAt = 0;
  let retryAt = 0;
  let inflight: Promise<ModelCatalogState> | null = null;
  function fallback(): ModelCatalogState {
    if (cached && now() - fetchedAt <= STALE_MS) return { status: 'stale', catalog: cached };
    cached = null;
    return { status: 'unavailable', catalog: null };
  }
  return {
    get() {
      if (cached && now() - fetchedAt < FRESH_MS) return Promise.resolve({ status: 'available', catalog: cached });
      if (inflight) return inflight;
      if (now() < retryAt) return Promise.resolve(fallback());
      inflight = fetchOpenRouterCatalog(options).then(catalog => {
        cached = catalog; fetchedAt = Date.parse(catalog.fetchedAt); retryAt = 0;
        return { status: 'available' as const, catalog };
      }, () => {
        retryAt = now() + RETRY_MS;
        return fallback();
      }).finally(() => { inflight = null; });
      return inflight;
    },
  };
}

export interface CatalogSearch {
  query?: string;
  tools?: boolean;
  reasoning?: boolean;
  limit?: number;
}
/** Case-insensitive substring search over id and name, optionally only models known to support tools or reasoning; `limit` 1..5000 (default 50). */
export function searchCatalog(catalog: ModelCatalog, options: CatalogSearch = {}): { models: readonly ModelCatalogEntry[]; total: number; hasMore: boolean } {
  const query = (options.query ?? '').trim().toLowerCase();
  const limit = options.limit ?? 50;
  if (query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > MAX_MODELS) throw new RangeError('Catalog search requires query length <= 200 and limit 1..5000');
  const models: ModelCatalogEntry[] = [];
  let total = 0;
  for (const model of catalog.models) {
    if (query && !model.id.toLowerCase().includes(query) && !model.name?.toLowerCase().includes(query)) continue;
    if (options.tools && model.supportsTools !== true || options.reasoning && model.supportsReasoning !== true) continue;
    total++;
    if (models.length < limit) models.push(model);
  }
  return { models, total, hasMore: total > models.length };
}
