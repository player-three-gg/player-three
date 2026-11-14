/** Guardrail evaluation over a finished series' canonical results: one value per accepted match, aggregated, compared with the threshold. */
import type { ResultsEnvelope } from 'playerthree/arena';
import type { Guardrail } from './bots-config.ts';

/** A guardrail's verdict. `value` is the aggregate (the p-value for `binomialTwoSided`), or `null` with a `reason` when it cannot be computed. */
export interface GuardrailResult extends Guardrail {
  value: number | null;
  samples: number;
  passed: boolean;
  reason?: string;
}

/** Exact two-sided fair-coin tail, accumulated in log space to avoid underflow at large n. */
export function binomialTwoSided(wins: number, total: number): number {
  if (total === 0) return 1;
  const k = Math.min(wins, total - wins);
  let logProbability = -total * Math.LN2;
  let logSum = logProbability;
  for (let i = 1; i <= k; i++) {
    logProbability += Math.log(total - i + 1) - Math.log(i);
    const larger = Math.max(logSum, logProbability);
    logSum = larger + Math.log(Math.exp(logSum - larger) + Math.exp(logProbability - larger));
  }
  return Math.min(1, 2 * Math.exp(logSum));
}

/** Evaluates each guardrail; a guardrail that lacks any sample fails. */
export function evaluateGuardrails(results: ResultsEnvelope, guardrails: readonly Guardrail[]): GuardrailResult[] {
  return guardrails.map((guard) => {
    const schedule = new Map(results.tables.schedule.map((row) => [row.trialId, row]));
    const selected = results.tables.matches.filter((match) => match.acceptedAttempt && (guard.scenario === undefined || schedule.get(match.trialId)?.scenarioId === guard.scenario));
    const values: number[] = [];
    let missing = false;
    for (const match of selected) {
      const trial = schedule.get(match.trialId);
      const team = guard.scope.startsWith('team:') ? guard.scope.slice(5)
        : guard.scope.startsWith('entrant:') ? trial?.sideBindings.find((binding) => binding.entrantId === guard.scope.slice(8))?.team : undefined;
      const outcome = match.outcomes.find((row) => row.team === team)?.outcome;
      if (guard.aggregation === 'binomialTwoSided') {
        if (!team) { missing = true; continue; }
        if (outcome === 'win' || outcome === 'loss') values.push(outcome === 'win' ? 1 : 0);
        continue;
      }
      let value: number | undefined;
      if (guard.metric === 'ticks') value = match.ticks;
      else if (guard.metric === 'truncated') value = match.status === 'aborted' ? 1 : 0;
      else if (team && guard.metric.startsWith('outcome.')) {
        if (outcome !== 'aborted' && ['outcome.win', 'outcome.loss', 'outcome.draw'].includes(guard.metric)) value = guard.metric === `outcome.${outcome}` ? 1 : 0;
      } else {
        const samples = results.tables.metrics.filter((row) => row.matchId === match.matchId && row.metric === guard.metric && (guard.scope === 'match' ? row.scope === 'match' : row.scope === 'side' && row.team === team));
        value = samples.at(-1)?.value;
      }
      if (value === undefined || !Number.isFinite(value)) missing = true;
      else values.push(value);
    }
    if (missing || !selected.length || (!values.length && guard.aggregation !== 'binomialTwoSided')) return { ...guard, value: null, samples: values.length, passed: false, reason: missing ? 'missing metric' : 'no samples' };
    const sum = values.reduce((total, value) => total + value, 0);
    let value: number;
    switch (guard.aggregation) {
      case 'binomialTwoSided': value = binomialTwoSided(sum, values.length); break;
      case 'sum': value = sum; break;
      case 'mean': value = sum / values.length; break;
      case 'min': value = values.reduce((a, b) => Math.min(a, b), Infinity); break;
      case 'max': value = values.reduce((a, b) => Math.max(a, b), -Infinity); break;
      case 'median': {
        values.sort((a, b) => a - b);
        const mid = Math.floor(values.length / 2);
        value = values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
        break;
      }
    }
    if (!Number.isFinite(value)) return { ...guard, value: null, samples: values.length, passed: false, reason: 'non-finite aggregation' };
    const threshold = guard.threshold as number;
    let passed: boolean;
    switch (guard.comparator) {
      case '<': passed = value < threshold; break;
      case '<=': passed = value <= threshold; break;
      case '>': passed = value > threshold; break;
      case '>=': passed = value >= threshold; break;
      case '==': passed = value === threshold; break;
      case '!=': passed = value !== threshold; break;
      case 'between': { const [lo, hi] = guard.threshold as readonly [number, number]; passed = value >= lo && value <= hi; break; }
    }
    return { ...guard, value, samples: values.length, passed };
  });
}
