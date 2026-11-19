/** Programmatic API of the `playerthree` CLI (use it from CI scripts or tests). */
export {
  auditDefinition,
  auditRemote,
  auditSeats,
  formatAuditReport,
  localInvoke,
  type AuditOptions,
  type AuditReport,
  type AuditSeat,
  type AuditSeatsOptions,
  type CheckResult,
  type Invoke,
} from './audit.ts';
export { devBanner, startDevServer, type DevServer, type DevServerOptions } from './dev.ts';
export {
  DEFAULT_PRICES,
  formatLintReport,
  lintDefinition,
  prosiness,
  type CostRow,
  type Finding,
  type LintOptions,
  type LintReport,
  type ObservationStats,
} from './lint.ts';
export { loadDefinition } from './load.ts';
export { main, type Io } from './main.ts';
export { safetyCard } from './safety.ts';
export { estimateTokens, worstCase, type Size } from './size.ts';
