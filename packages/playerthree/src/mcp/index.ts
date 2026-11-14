/** `playerthree/mcp`: the remote MCP binding (Streamable HTTP endpoint), its tool surface, observation paging and the OAuth 2.1 authorization server. */
export {
  createMcpRequestHandler,
  mountMcp,
  serverInstructions,
  type ConsentEvent,
  type McpOptions,
  type McpRequestHandler,
  type MountMcpOptions,
} from './server.ts';
export { SURFACE_HASH_META, type ToolErrorCode } from './meta.ts';
export {
  toolSurface,
  methodEnabled,
  TOOL_ORDER,
  LIMITS,
  TOOL_DESCRIPTION_MAX,
  TOOL_INPUT_SCHEMA_MAX,
  TOOL_OUTPUT_SCHEMA_MAX,
  TOOL_SURFACE_MAX,
  type ToolSpec,
  type ToolAnnotationsSpec,
} from './surface.ts';
export { mergeObservationPages, pageObservation, type ObservationPage } from './paging.ts';
export {
  createAuthorizationServer,
  OAUTH_SCOPE,
  type AuthorizationServer,
  type AuthorizationServerOptions,
  type ConnectionStatus,
  type ConsentDecision,
  type ConsentRequest,
  type OAuthGrant,
  type OwnedConnectionStatus,
} from './oauth/server.ts';
export {
  jsonConnectionStore,
  memoryConnectionStore,
  type ClientRegistration,
  type ConnectionStore,
  type ConnectionStoreData,
  type OAuthClientInfo,
  type StoredClient,
  type StoredConnection,
  type StoredTokenDigest,
} from './oauth/store.ts';
export { addressAllowed, fetchClientDocument, redirectMatches, type CimdErrorCode, type CimdOptions, type CimdResult } from './oauth/cimd.ts';
