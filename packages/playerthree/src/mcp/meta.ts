/** Wire constants shared by the MCP endpoint and its clients (bridge, runner). Leaf module: no imports beyond types. */
import type { ServerErrorCode } from '../protocol.ts';

/** `_meta` key carrying the surfaceHash on tools/list and every tools/call result (clients pin it). */
export const SURFACE_HASH_META = 'dev.playerthree/surfaceHash';

/** Closed set of tool-level error codes (`{"error": code}` in an `isError` result). */
export type ToolErrorCode = ServerErrorCode | 'consent_declined';
