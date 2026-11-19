/**
 * `@playerthree/runner`: play a seat with your own LLM key — the remote MCP seat client, the stdio bridge, LLM
 * providers, the agent loop and browser sign-in. CLIs: `playerthree-run`, `playerthree-mcp`.
 */
export {
  PlayerThreeSeatError,
  connectSeat,
  MCP_PROTOCOL_VERSION,
  type ConnectSeatOptions,
  type RemoteSeat,
  type SeatErrorCode,
  type ToolOutcome,
} from './remote.ts';
export { BridgeError, startBridge, type Bridge, type BridgeErrorCode, type BridgeOptions } from './bridge.ts';
export {
  ANTHROPIC_EFFORT_BETA,
  ANTHROPIC_VERSION,
  anthropicAuthHeaders,
  Budget,
  createAnthropicProvider,
  createOpenAiProvider,
  createScriptedProvider,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REASONING_EFFORT,
  PRICES,
  priceFor,
  ProviderError,
  type LlmTool,
  type Price,
  type Provider,
  type ProviderOptions,
  type Turn,
  type ToolCall,
  type ToolResultInput,
  type Usage,
} from './providers.ts';
export { llmTools, runAgent, RUNNER_HARNESS, seatBrief, systemPrompt, type RunAgentOptions, type RunSummary, type StopReason, type TranscriptEvent } from './agent.ts';
export { joinStringOptions } from './argv.ts';
export {
  browserSignIn,
  configDir,
  connectClient,
  SignInError,
  type BrowserSignIn,
  type BrowserSignInOptions,
  type EndpointAuth,
  type SignInErrorCode,
} from './oauth.ts';
