/**
 * Identity of the JS policy runtime (SPEC §11 "Engine identity", "Deterministic `Math`"). Dependency-free so that
 * `surfaceHash` (briefing.ts) can include it without loading the sandbox.
 */
import { DETERMINISTIC_MATH_VERSION } from './math.ts';

/** The one JS engine build every policy runs on: engine name and release. */
export const POLICY_JS_ENGINE = 'quickjs 2025-09-13';

/** What a JS policy's results depend on besides its own code and inputs; pinned by `surfaceHash`. */
export const POLICY_RUNTIME = { js: POLICY_JS_ENGINE, math: DETERMINISTIC_MATH_VERSION } as const;
