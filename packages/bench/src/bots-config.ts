/** Game definition references and guardrail declarations for bench configs, and their validation. */
import type { GameDefinition } from 'playerthree';

/** A game definition loaded by dynamic import: `module` is an absolute `file:` URL, `export` the export name (default `default`). */
export interface DefinitionModule { module: string; export?: string }
/**
 * A pass/fail check over a series: `metric` (`ticks`, `truncated`, `outcome.win|loss|draw` or a game metric) per accepted
 * match, optionally of one `scenario`, at `scope`, aggregated and compared with `threshold`.
 */
export interface Guardrail {
  id: string;
  scenario?: string;
  metric: string;
  scope: 'match' | `entrant:${string}` | `team:${string}`;
  aggregation: 'mean' | 'median' | 'min' | 'max' | 'sum' | 'binomialTwoSided';
  comparator: '<' | '<=' | '>' | '>=' | '==' | '!=' | 'between';
  threshold: number | readonly [number, number];
}
export function validateGuardrails(guardrails: readonly Guardrail[]): void {
  const ids = new Set<string>();
  for (const guard of guardrails) {
    if (!guard || typeof guard.id !== 'string' || !guard.id || ids.has(guard.id)) botFail('guardrail ids must be nonempty and unique');
    ids.add(guard.id);
    if (Object.keys(guard).some((key) => !['id', 'scenario', 'metric', 'scope', 'aggregation', 'comparator', 'threshold'].includes(key))) botFail('unknown guardrail field');
    if (typeof guard.metric !== 'string' || !guard.metric || guard.metric.length > 128) botFail('invalid guardrail metric');
    if (typeof guard.scope !== 'string' || (guard.scope !== 'match' && !/^entrant:.+|^team:.+/.test(guard.scope))) botFail('invalid guardrail scope');
    if (!['mean', 'median', 'min', 'max', 'sum', 'binomialTwoSided'].includes(guard.aggregation)) botFail('invalid guardrail aggregation');
    if (!['<', '<=', '>', '>=', '==', '!=', 'between'].includes(guard.comparator)) botFail('invalid guardrail comparator');
    if (guard.comparator === 'between') {
      if (!Array.isArray(guard.threshold) || guard.threshold.length !== 2 || !guard.threshold.every(Number.isFinite) || guard.threshold[0] > guard.threshold[1]) botFail('between needs ordered finite thresholds');
    } else if (typeof guard.threshold !== 'number' || !Number.isFinite(guard.threshold)) botFail('guardrail threshold must be finite');
    if (guard.aggregation === 'binomialTwoSided' && (guard.scope === 'match' || guard.metric !== 'outcome.win')) botFail('binomialTwoSided requires a side outcome.win');
  }
}
export function botFail(message: string): never { throw new Error(`playerthree-bench: ${message}`); }
/** Returns an inline definition as is, or imports a {@link DefinitionModule} and checks its export is a game definition. */
export async function loadDefinition(ref: GameDefinition | DefinitionModule): Promise<GameDefinition> {
  if ('manifest' in ref) return ref;
  if (typeof ref.module !== 'string' || !ref.module.startsWith('file:')) botFail('definition.module must be an absolute file URL');
  // This module URL is selected by the caller at runtime, not known at author time.
  const definition = (await import(ref.module))[ref.export ?? 'default'] as GameDefinition;
  if (!definition?.manifest || typeof definition.create !== 'function' || typeof definition.createBot !== 'function') botFail('module export is not a game definition');
  return definition;
}
