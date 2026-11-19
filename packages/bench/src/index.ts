/**
 * `@playerthree/bench`: benchmark series for PlayerThree games — bench configs, the headless match host, the reference
 * series runner, guardrails and benchmark campaigns. CLI: `playerthree-bench`.
 */
export { loadBenchConfig, maxOutputTokensOf, modelWire, MODEL_WIRES, validateConfig, type BenchConfig, type BenchModel, type ModelWire } from './config.ts';
export { runBench, type RunBenchOptions } from './run.ts';
export { createGameMatchHost, snapshotMetrics, type AuthoredPolicies, type AuthoringEvent, type AuthorOptions, type GameMatchHostOptions } from './bot-match.ts';
export type { AuthoringHarness, AuthoringLobby, HarnessIdentity, HarnessOutcome, HarnessStop, MeteredTurn } from './harness.ts';
export { openCodeHarness, OPENCODE_HARNESS_ID, type OpenCodeOptions } from './opencode.ts';
export { routerKeyUsage, watchKeyUsage, type BilledUsage, type KeyUsageWatch } from './billing.ts';
export { preflightToolArguments, type PreflightResult } from './preflight.ts';
export { lookupServedBy, type LookupServedByOptions, type ServedBy } from './served-by.ts';
export { loadDefinition, type DefinitionModule, type Guardrail } from './bots-config.ts';
export { evaluateGuardrails, binomialTwoSided, type GuardrailResult } from './guardrails.ts';
export { createSeriesRunner, recoverSeriesRunner, DEFAULT_SERIES_LIMITS, type SeriesRunnerOptions, type ClosableSeriesRunner } from './series.ts';
export type { SeriesSpec, MatchSpec, ResultsEnvelope, GameMatchHost, MatchExecution, GameMatchResult, SeatBinder, BoundSeat } from 'playerthree/arena';
export { createBenchmarkSuite, runCampaign, exportCampaignPublication, type CampaignConfig, type CampaignRecord, type CampaignAttempt, type CampaignOptions, type BenchmarkSuiteMetadata } from './campaign.ts';
export { benchmarkSourceDigest, type BenchmarkSources } from './source-digest.ts';
