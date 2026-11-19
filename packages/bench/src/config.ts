/** Benchmark configuration (the default export of a `bench.config.ts`): private execution settings around a frozen SeriesSpec, plus validation and loading. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { surfaceHash, type GameDefinition, type PolicyArtifact } from 'playerthree';
import type { MatchSpec, SeriesSpec } from 'playerthree/arena';
import { DEFAULT_MAX_OUTPUT_TOKENS, priceFor, type Price, type Turn } from '@playerthree/runner';
import { validateGuardrails, type DefinitionModule, type Guardrail } from './bots-config.ts';

/**
 * The API an authoring harness speaks to the model with (the OpenCode harness: its provider adapter and the proxy's
 * upstream API). Each model gets its own family's wire, so the reasoning it returns goes back to it with its tool
 * results as that API defines (Chat Completions has no field for signed or encrypted reasoning):
 * - `messages`: Anthropic Messages (`/v1/messages`), signed `thinking` blocks; `provider: 'anthropic'` only (its default);
 * - `responses`: OpenAI Responses (`/v1/responses`), encrypted `reasoning` items;
 * - `openrouter-chat`: OpenRouter Chat Completions with its `reasoning_details` replayed;
 * - `chat-completions`: plain Chat Completions, no reasoning replay (the `openai` default).
 */
export type ModelWire = 'messages' | 'responses' | 'openrouter-chat' | 'chat-completions';
export const MODEL_WIRES: readonly ModelWire[] = ['messages', 'responses', 'openrouter-chat', 'chat-completions'];
/** `model.wire`, else its provider's default. */
export function modelWire(model: Pick<BenchModel, 'provider' | 'wire'>): ModelWire {
  return model.wire ?? (model.provider === 'anthropic' ? 'messages' : 'chat-completions');
}

/** An LLM entrant's provider and model. The key is read from env `apiKeyEnv` (default `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`); `scripted` replays `script` without a provider. */
export interface BenchModel {
  provider: 'openai' | 'anthropic' | 'scripted';
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  /** The authoring harness's API to the model ({@link ModelWire}); defaults per provider. Part of the execution digest. */
  wire?: ModelWire;
  /**
   * Extra top-level provider request fields, merged under the runner's own. Pin a router's upstream here so the
   * benchmark measures the model, not whichever host the router picked, e.g. OpenRouter
   * `{ provider: { only: ['z-ai'], allow_fallbacks: false, require_parameters: true } }`. Part of the execution
   * digest; never credentials.
   */
  request?: Readonly<Record<string, unknown>>;
  /** USD per million tokens; defaults to the runner's price table. Required when the spec caps `maxCostUsd` and the model is not priced. */
  price?: Price;
  script?: readonly Turn[];
  /**
   * The model's own context window on its route, tokens (the router catalog's `context_length` for the pinned hosts):
   * caps the series' `authoring.contextTokens` for a model whose window is smaller. Part of the execution digest.
   */
  contextTokens?: number;
  /**
   * Where the router reports the key's billed usage: `openrouter-key` reads the cumulative USD of
   * `GET <baseUrl>/v1/key`, so authoring also stops when the billed delta reaches the per-run cost ceiling.
   */
  billing?: 'openrouter-key';
}

/** A model turn's output cap: the spec's authoring cap, else the runner default, never above the shared token budget. */
export function maxOutputTokensOf(spec: SeriesSpec): number {
  return spec.authoring?.maxOutputTokens ?? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, spec.budgets.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
}

/** Private execution configuration. Only spec is persisted/exported; never provider endpoints or credentials. */
export interface BenchConfig {
  definition: GameDefinition | DefinitionModule;
  spec: SeriesSpec;
  /** By entrant id. */
  models?: Readonly<Record<string, BenchModel>>;
  /** By entrant id, then role. */
  policies?: Readonly<Record<string, Readonly<Record<string, PolicyArtifact>>>>;
  /** Game hook freezes actual defaults, map identity and canonical rulesHash. Required for games with matchOptions. */
  resolve?: (spec: MatchSpec) => MatchSpec | Promise<MatchSpec>;
  guardrails?: readonly Guardrail[];
}

/** Throws `playerthree-bench: …` on an invalid config. With `definition`, also checks the pinned `surfaceHash` and policy roles against the game. */
export function validateConfig(config: BenchConfig, definition?: GameDefinition): void {
  const fail = (message: string): never => { throw new Error(`playerthree-bench: ${message}`); };
  if (!config?.definition || !config.spec || config.spec.format !== 'playerthree.series' || config.spec.version !== 1) fail('config needs a game definition and SeriesSpec');
  if (Object.keys(config).some((key) => !['definition', 'spec', 'models', 'policies', 'resolve', 'guardrails'].includes(key))) fail('unknown config field');
  if (config.guardrails !== undefined && !Array.isArray(config.guardrails)) fail('guardrails must be a list');
  validateGuardrails(config.guardrails ?? []);
  for (const guard of config.guardrails ?? []) {
    if (guard.scenario !== undefined && !config.spec.scenarios.some((scenario) => scenario.id === guard.scenario)) fail('guardrail references unknown scenario');
    if (guard.scope.startsWith('entrant:') && !config.spec.entrants.some((entrant) => entrant.id === guard.scope.slice(8))) fail('guardrail references unknown entrant');
    if (guard.scope.startsWith('team:') && !config.spec.template.sides.some((side) => side.id === guard.scope.slice(5))) fail('guardrail references unknown team');
  }
  const spec = config.spec;
  if (definition && surfaceHash(definition.manifest) !== spec.surfaceHash) fail('pinned surfaceHash does not match the game');
  const practice = config.spec.authoring?.practiceSeeds ?? [];
  if (!Array.isArray(practice) || new Set(practice).size !== practice.length || practice.some((seed) => !Number.isSafeInteger(seed) || seed < 0 || seed > 2 ** 31 - 1)) fail('practiceSeeds must be unique integers in [0, 2^31 - 1]');
  if (spec.scenarios.some((scenario) => practice.includes(scenario.seed))) fail('held-out seeds overlap practice seeds');
  const output = maxOutputTokensOf(spec);
  if (!Number.isSafeInteger(output) || output < 1 || (spec.budgets.maxTokens !== null && output > spec.budgets.maxTokens)) fail('maxOutputTokens exceeds shared token budget');
  if (spec.authoring && (!Number.isSafeInteger(spec.authoring.maxWallMs) || spec.authoring.maxWallMs < 1)) fail('authoring maxWallMs must be a positive integer');
  const fixed = spec.authoring?.systemPrompt;
  if (fixed !== undefined && (typeof fixed !== 'string' || !fixed.trim() || fixed.length > 4096)) fail('authoring systemPrompt must be nonblank text of at most 4096 characters');
  const window = spec.authoring?.contextTokens;
  if (window !== undefined && (!Number.isSafeInteger(window) || window <= output)) fail('authoring contextTokens must be an integer above maxOutputTokens');
  const reasoning = spec.authoring?.reasoning;
  if (reasoning !== undefined && !(['low', 'medium', 'high', 'xhigh'] as unknown[]).includes(reasoning)) fail('authoring reasoning must be low, medium, high or xhigh');
  for (const [role, path] of Object.entries(spec.authoring?.starters ?? {})) {
    const declared = definition?.manifest.starters?.[path];
    if (definition && (!definition.manifest.roles.values.includes(role) || !declared || (declared.roles !== undefined && !declared.roles.includes(role)))) fail(`authoring starter ${path} is not a declared starter for role ${role}`);
  }
  for (const [id, model] of Object.entries(config.models ?? {})) {
    if (!spec.entrants.some((entrant) => entrant.id === id)) fail('model references unknown entrant');
    if ('budgets' in model) fail('per-model budgets are forbidden; use the shared series budgets');
    if (!['openai', 'anthropic', 'scripted'].includes(model.provider) || !model.model) fail('invalid provider/model');
    if (model.provider === 'scripted' && !Array.isArray(model.script)) fail('scripted provider requires script');
    if (model.wire !== undefined && (!MODEL_WIRES.includes(model.wire) || (model.wire === 'messages') !== (model.provider === 'anthropic'))) fail('model wire must be messages for anthropic and responses, openrouter-chat or chat-completions for openai');
    if (model.request !== undefined && (model.request === null || typeof model.request !== 'object' || Array.isArray(model.request))) fail('model request must be an object of extra request fields');
    if (model.billing !== undefined && (model.billing !== 'openrouter-key' || !model.baseUrl)) fail('model billing must be openrouter-key with the router baseUrl');
    if (model.contextTokens !== undefined && (!Number.isSafeInteger(model.contextTokens) || model.contextTokens <= output)) fail('model contextTokens must be an integer above maxOutputTokens');
    const price = model.price ?? priceFor(model.model);
    if (price && [price.inPerM, price.outPerM, price.cacheReadPerM ?? 0].some((p) => !Number.isFinite(p) || p < 0)) fail('invalid model price');
    if (spec.budgets.maxCostUsd !== null && !price) fail(`no price for ${model.model}; supply price to enforce maxCostUsd`);
  }
  for (const [id, policies] of Object.entries(config.policies ?? {})) {
    if (!spec.entrants.some((entrant) => entrant.id === id)) fail('policy references unknown entrant');
    for (const [role, artifact] of Object.entries(policies)) {
      if (definition && !definition.manifest.roles.values.includes(role)) fail('unknown policy role');
      if (!artifact || !['js', 'wasm'].includes(artifact.runtime) || typeof artifact.code !== 'string' || !artifact.code) fail('invalid policy artifact');
    }
  }
}

/** Imports the config module at `file` (trusted operator code; Node runs TypeScript directly) and validates its default export: one config or a nonempty list. */
export async function loadBenchConfig(file: string): Promise<BenchConfig | readonly BenchConfig[]> {
  // The configuration path is selected by the operator at runtime.
  const config = (await import(pathToFileURL(resolve(file)).href)).default as BenchConfig | readonly BenchConfig[];
  if (Array.isArray(config) && !config.length) throw new Error('playerthree-bench: configuration array must not be empty');
  for (const item of Array.isArray(config) ? config : [config]) validateConfig(item);
  return config;
}
