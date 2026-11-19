/** `playerthree-bench models`: searches the OpenRouter model catalog for configuration hints; no inference or billing calls. */
import { parseArgs } from 'node:util';
import { fetchOpenRouterCatalog, MODEL_CATALOG_DISCLAIMER, searchCatalog, type CatalogFetchOptions, type ModelCatalogEntry } from './model-catalog.ts';

const HELP = `Usage: playerthree-bench models [--search text] [--tools] [--reasoning] [--limit 50] [--json] [--authenticated]
Lists current OpenRouter catalog hints for benchmark configuration; makes no inference or billing calls.
Anonymous by default. --authenticated uses only the existing OPENROUTER_API_KEY server/CLI environment variable.
Unknown fields remain null. A model missing from this catalog is not prohibited from benchmark execution.
${MODEL_CATALOG_DISCLAIMER}`;
export interface ModelsCliIo { out(text: string): void; err(text: string): void }
const defaultIo: ModelsCliIo = { out: text => console.log(text), err: text => console.error(text) };
function price(model: ModelCatalogEntry, parameter: string): string {
  const rate = model.pricing.rates?.find(rate => rate.parameter === parameter);
  return rate?.amount === null || rate?.amount === undefined ? 'unknown' : `${rate.amount} USD/${rate.unit ?? 'unknown unit'}`;
}

export async function modelsMain(argv: string[], io: ModelsCliIo = defaultIo, options: CatalogFetchOptions = {}): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: {
      search: { type: 'string' }, tools: { type: 'boolean' }, reasoning: { type: 'boolean' },
      limit: { type: 'string' }, json: { type: 'boolean' }, authenticated: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } }));
    if (values.help) { io.out(HELP); return 0; }
    const limit = values.limit === undefined ? 50 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000 || (values.search?.length ?? 0) > 200) throw new Error('Invalid catalog search');
  } catch {
    io.err('playerthree-bench models: invalid arguments; use --help (limit 1..5000, search at most 200 characters).');
    return 2;
  }
  // Never echo an environment value, argument or provider failure back into a public output/error.
  const apiKey = values.authenticated ? process.env.OPENROUTER_API_KEY : undefined;
  if (values.authenticated && !apiKey) { io.err('playerthree-bench models: OPENROUTER_API_KEY is not configured. Omit --authenticated for public discovery.'); return 2; }
  try {
    const catalog = await fetchOpenRouterCatalog({ ...options, apiKey });
    const result = searchCatalog(catalog, { query: values.search, tools: values.tools, reasoning: values.reasoning, limit: values.limit === undefined ? 50 : Number(values.limit) });
    if (values.json) {
      io.out(JSON.stringify({ ...catalog, ...result }, null, 2));
    } else {
      io.out(`OpenRouter model discovery · fetched ${catalog.fetchedAt}\nSource: ${catalog.source}\nScope: text-output catalog\n${MODEL_CATALOG_DISCLAIMER}`);
      io.out('ID\tNAME\tCONTEXT TOKENS\tTOOLS\tREASONING\tINPUT PRICE\tOUTPUT PRICE');
      for (const model of result.models) io.out([model.id, model.name ?? 'unknown', model.contextLength ?? 'unknown', model.supportsTools ?? 'unknown', model.supportsReasoning ?? 'unknown', price(model, 'prompt'), price(model, 'completion')].join('\t'));
      io.out(`${result.models.length} shown / ${result.total} matches${result.hasMore ? '; narrow --search or increase --limit' : ''}. Prices are not copied into execution configuration.`);
    }
    return 0;
  } catch {
    io.err('playerthree-bench models: catalog unavailable. Existing benchmark configurations and results remain usable; retry discovery later.');
    return 1;
  }
}
