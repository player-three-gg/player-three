/** Validation of self-reported decision usage (`game_usage`) before the host records it (commander log facts, usage listeners). */
import type { DecisionUsage } from './types.ts';
import { PlayerThreeError } from './util.ts';

/** Validate the complete telemetry envelope before it can reach a recorder or an export. */
export function parseDecisionUsage(input: unknown): DecisionUsage {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new PlayerThreeError('invalid');
  const value = input as Record<string, unknown>;
  const allowed = ['decisionId', 'latencyMs', 'source', 'reporter', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costAmount', 'currency', 'pricingVersion', 'coverage'];
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof value.decisionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value.decisionId) ||
    typeof value.latencyMs !== 'number' || !Number.isFinite(value.latencyMs) || value.latencyMs < 0 || value.latencyMs > 3_600_000 ||
    !['provider', 'self_report'].includes(value.source as string) ||
    !['reported', 'estimated', 'unpriced'].includes(value.reporter as string) ||
    !['complete', 'partial', 'unknown'].includes(value.coverage as string)) throw new PlayerThreeError('invalid');
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const count = value[key];
    if (count !== undefined && count !== null && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000)) throw new PlayerThreeError('invalid');
  }
  if (value.costAmount !== undefined && value.costAmount !== null &&
    (typeof value.costAmount !== 'string' || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/.test(value.costAmount))) throw new PlayerThreeError('invalid');
  if (value.currency !== undefined && value.currency !== null &&
    (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))) throw new PlayerThreeError('invalid');
  if (value.pricingVersion !== undefined && value.pricingVersion !== null &&
    (typeof value.pricingVersion !== 'string' || !/^[A-Za-z0-9_.:/-]{1,80}$/.test(value.pricingVersion))) throw new PlayerThreeError('invalid');
  if (value.costAmount != null && (value.currency == null || value.reporter === 'unpriced') ||
    value.reporter === 'estimated' && value.costAmount != null && value.pricingVersion == null) throw new PlayerThreeError('invalid');
  return structuredClone(value) as unknown as DecisionUsage;
}
