/**
 * `@playerthree/sidecar`: the PlayerThree host for non-JS game servers (SPEC §20.8 (a)). The engine speaks
 * newline-delimited JSON over stdio or a local socket; this process serves MCP through a normal `PlayerThreeHost`.
 */
export {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_HELLO_TIMEOUT_MS,
  encodeLine,
  HOOKS,
  LineDecoder,
  MAX_LINE_BYTES,
  member,
  parseLine,
  PROTOCOL,
  SOCKET_ENV,
  type FatalCode,
  type Hook,
  type Msg,
  type Transport,
} from './protocol.ts';
export { EngineLink, SidecarCallError, type EngineLinkOptions, type LinkClosed } from './link.ts';
export { MAX_ADVANCE, startSidecar, type Sidecar, type SidecarOptions } from './sidecar.ts';
export { serveSidecar, type ServedSidecar, type ServeSidecarOptions } from './serve.ts';
export { main } from './cli.ts';
