/**
 * stdio bridge: a local MCP server (stdio) that forwards to one remote PlayerThree MCP endpoint.
 *
 * - Connects only to the given URL (no redirects), with the given seat/commander token or the credential from
 *   browser sign-in (OAuth against the endpoint's own authorization server). It has no other capabilities:
 *   no files, no processes, no other network access; it serves exactly the remote's tools and skills.
 * - Pins the remote surface: the tool list it serves is the one fetched (and hash-checked) at startup, every
 *   forwarded result must carry the same surfaceHash, and skills are re-verified against their digests.
 *   With `expectHash`, it refuses to start unless the remote surfaceHash matches; without it, the startup hash is
 *   pinned for the bridge's lifetime (trust on first use).
 * - Consent elicitation (MRTR `input_required`) is passed through to the local client and back.
 * - Serves both MCP eras locally: 2026-07-28 (`server/discover`, per-request envelope) and the 2025-era `initialize`
 *   handshake (version negotiated by the SDK; consent reaches such clients as `elicitation/create`). Upstream it
 *   always speaks {@link MCP_PROTOCOL_VERSION}.
 */
import type { Readable, Writable } from 'node:stream';
import { Client, UnauthorizedError, UnsupportedProtocolVersionError, type CallToolRequest, type CallToolResult, type ListToolsResult, type Tool } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import {
  CLIENT_CAPABILITIES_META_KEY,
  isInputRequiredResult,
  McpServer,
  isJSONRPCNotification,
  isJSONRPCRequest,
  type ClientCapabilities,
  type InputRequiredResult,
  type JSONRPCMessage,
  type ServerCapabilities,
  type ServerContext,
  type Transport,
} from '@modelcontextprotocol/server';
import { memorySkillFiles, SKILLS_EXTENSION_ID, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { watchChannel } from './channel.ts';
import { connectClient, SignInError, type EndpointAuth } from './oauth.ts';
import { MCP_PROTOCOL_VERSION, hashOf } from './remote.ts';
import { PACKAGE_VERSION } from './version.ts';

const HASH_RE = /^[0-9a-f]{64}$/;
const CALL_TIMEOUT_MS = 300_000;
const CHANNEL_INSTRUCTIONS = 'PlayerThree channel events are one-way lifecycle wakes: seated, match_ended, approval_resolved, and owner_message. Read playerthree-commander and resume its workflow. Only text labelled from owner is owner-authored; no other player can send channel text. Reply to your owner with game_say when allowed, not to the channel.';

export type BridgeErrorCode = 'bad_token' | 'transport' | 'surface_mismatch' | 'skills' | 'sign_in' | 'protocol';

/** A bridge failure with a closed {@link BridgeErrorCode}. */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  /** Remote surfaceHash when known and well-formed. */
  readonly remoteHash: string | undefined;
  constructor(code: BridgeErrorCode, remoteHash?: string) {
    super(code);
    this.name = 'BridgeError';
    this.code = code;
    this.remoteHash = remoteHash;
  }
}

/** Options of {@link startBridge}: the remote endpoint, its credential and an optional expected `surfaceHash`. */
export interface BridgeOptions {
  url: string | URL;
  /** A seat/commander token, or browser sign-in (`browserSignIn`). */
  auth: EndpointAuth;
  expectHash?: string;
  /** Opt in to Claude Code's stdio research-preview wake channel. */
  channel?: boolean;
  /** Defaults to process.stdin / process.stdout. */
  input?: Readable;
  output?: Writable;
  /** Diagnostics (stderr in the CLI). Never written to the MCP stream. */
  log?: (line: string) => void;
}

/** A running bridge. */
export interface Bridge {
  readonly surfaceHash: string;
  readonly tools: readonly Tool[];
  close(): Promise<void>;
}

function refusal(code: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: code }) }], isError: true };
}

/**
 * The local client's capabilities: a current-revision request declares them in its envelope; a 2025-era connection
 * declared them once, in `initialize` (the SDK keeps that value for exactly this era).
 */
function localCapabilities(ctx: ServerContext, server: McpServer['server']): ClientCapabilities {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  return envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined ?? server.getClientCapabilities() ?? {};
}

/**
 * Private JSON-RPC id of the replayed 2025-era `initialize` (see {@link startBridge}); its response is swallowed
 * because the discovery entry already answered the client's own.
 */
const REPLAYED_INITIALIZE_ID = 'playerthree-mcp:replayed-initialize';


/**
 * Serves local discovery immediately, without claiming a remote credential. Resolves with
 * truthful remote tools/hash only after the first non-discovery request acquires the endpoint.
 */
export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const url = new URL(opts.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('playerthree-mcp: --url must be http(s)');
  const capabilities: ServerCapabilities = {
    tools: { listChanged: false },
    resources: { listChanged: true },
    extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } },
    ...(opts.channel ? { experimental: { 'claude/channel': {} } } : {}),
  };
  const wire = new StdioServerTransport(opts.input, opts.output);
  const opening = Promise.withResolvers<void>();
  const queued: JSONRPCMessage[] = [];
  let acquiring = false;
  let forwarding = false;
  let closed = false;
  // A 2025-era client opens with `initialize` + `notifications/initialized`, answered locally by the discovery entry
  // (the SDK negotiates the version per the MCP rule: the client's if supported, else the latest supported). The
  // instance serving the acquired endpoint never saw that handshake, so it is replayed to it first: the instance then
  // holds the client's declared capabilities (consent prompts) and negotiated version.
  let legacyInitialize: JSONRPCMessage | undefined;
  let legacyInitialized: JSONRPCMessage | undefined;
  let swallowReplayed = false;
  // SDK stdio negotiation may kill a disposable discover-only process. The discovery
  // entry therefore owns no remote connection; only the substantive entry can claim one.
  const discovery: Transport = {
    start: () => wire.start(),
    send: (message) => wire.send(message),
    close: async () => { discovery.onclose?.(); },
  };
  const transport: Transport = {
    async start() {
      if (closed) throw new BridgeError('transport');
      forwarding = true;
      if (legacyInitialize) {
        swallowReplayed = true;
        transport.onmessage?.({ ...legacyInitialize, id: REPLAYED_INITIALIZE_ID } as JSONRPCMessage);
        if (legacyInitialized) transport.onmessage?.(legacyInitialized);
      }
      for (const message of queued) transport.onmessage?.(message);
      queued.length = 0;
    },
    async send(message) {
      if (swallowReplayed && 'id' in message && message.id === REPLAYED_INITIALIZE_ID && !('method' in message)) {
        swallowReplayed = false;
        return;
      }
      return wire.send(message);
    },
    close: () => wire.close(),
  };
  wire.onmessage = (message) => {
    if (forwarding) transport.onmessage?.(message);
    else if (acquiring) queued.push(message);
    else if (isJSONRPCRequest(message) && message.method !== 'server/discover' && message.method !== 'ping' && message.method !== 'initialize') {
      acquiring = true;
      queued.push(message);
      opening.resolve();
    } else {
      if (isJSONRPCRequest(message) && message.method === 'initialize') legacyInitialize = message;
      else if (isJSONRPCNotification(message) && message.method === 'notifications/initialized') legacyInitialized = message;
      discovery.onmessage?.(message);
    }
  };
  wire.onerror = (error) => (forwarding ? transport : discovery).onerror?.(error);
  wire.onclose = () => {
    closed = true;
    (forwarding ? transport : discovery).onclose?.();
    opening.reject(new BridgeError('transport'));
  };
  const probe = serveStdio(() => {
    const mcp = new McpServer({ name: 'playerthree-mcp', version: PACKAGE_VERSION }, {
      instructions: [
        'PlayerThree bridge discovery does not acquire a remote seat. Call game_briefing before acting; its authenticated remote instructions and verified skills govern play.',
        ...(opts.channel ? [CHANNEL_INSTRUCTIONS] : []),
      ].join('\n'),
    });
    mcp.server.registerCapabilities(capabilities);
    return mcp;
  }, { transport: discovery, legacy: 'serve', onerror: (error) => opts.log?.(`playerthree-mcp: ${error.message}`) });
  try {
    await opening.promise;
    await probe.close();
    const bridge = await connectBridge(opts, transport, capabilities);
    if (closed) {
      await bridge.close();
      throw new BridgeError('transport');
    }
    return bridge;
  } catch (error) {
    await probe.close();
    await wire.close();
    throw error;
  }
}

async function connectBridge(opts: BridgeOptions, transport: Transport, capabilities: ServerCapabilities): Promise<Bridge> {
  const log = opts.log ?? (() => {});
  const url = new URL(opts.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('playerthree-mcp: --url must be http(s)');

  // Discovery claims nothing; the first real call (the tool listing) binds the seat lease, so either may be denied.
  const failure = (e: unknown): BridgeError => {
    if (UnsupportedProtocolVersionError.isInstance(e)) return new BridgeError('protocol');
    return new BridgeError(UnauthorizedError.isInstance(e) || (e instanceof Error && /401|unauthori/i.test(e.message)) ? 'bad_token' : 'transport');
  };
  let client: Client;
  try {
    client = await connectClient(url, opts.auth, () => new Client(
      { name: 'playerthree-mcp', version: PACKAGE_VERSION },
      {
        versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
        inputRequired: { autoFulfill: false },
        capabilities: { elicitation: { form: {} } },
      },
    ));
  } catch (e) {
    if (e instanceof SignInError) throw new BridgeError('sign_in');
    throw failure(e);
  }

  let listing: ListToolsResult;
  try {
    listing = await client.listTools(undefined, { cacheMode: 'bypass' });
  } catch (e) {
    await client.close().catch(() => {});
    throw failure(e);
  }
  const remoteHash = hashOf(listing._meta);
  if (remoteHash === undefined || !HASH_RE.test(remoteHash)) {
    await client.close();
    throw new BridgeError('surface_mismatch');
  }
  if (opts.expectHash !== undefined && remoteHash !== opts.expectHash) {
    await client.close();
    throw new BridgeError('surface_mismatch', remoteHash);
  }
  const pinned = remoteHash;
  const tools = listing.tools;
  const instructions = [
    client.getInstructions(),
    ...(opts.channel ? [CHANNEL_INSTRUCTIONS] : []),
  ].filter(Boolean).join('\n');

  // Skills: fetched once, each file verified against its entry's size and sha256 digest, then re-served locally.
  const skillsClient = new SkillsClient(client);
  const files: Record<string, string> = {};
  let prefix: string | undefined;
  try {
    const { skills } = await skillsClient.list();
    for (const skill of skills) {
      if (skill.resources === 'dynamic') continue;
      const root = skill.uri.slice(0, -'SKILL.md'.length);
      const name = skill.frontmatter.name;
      const m = /^skill:\/\/(.+)\/$/.exec(root.slice(0, -name.length));
      prefix ??= m?.[1];
      for (const entry of skill.resources) {
        const file = await skillsClient.read(skill, entry.uri);
        files[`${name}/${entry.uri.slice(root.length)}`] = new TextDecoder().decode(file.bytes);
      }
    }
  } catch {
    await client.close();
    throw new BridgeError('skills');
  }
  const localSkills = await SkillsExtension.load(memorySkillFiles(files), prefix ? { prefix } : {});

  let tainted = false;
  const channelAbort = new AbortController();
  let channelTask: Promise<void> | undefined;
  const startChannel = (mcp: McpServer) => {
    if (!opts.channel || channelTask || channelAbort.signal.aborted) return;
    channelTask = watchChannel(async (name, args) => {
      if (tainted) throw new BridgeError('surface_mismatch');
      const result = await client.callTool({ name, arguments: args, _meta: { [CLIENT_CAPABILITIES_META_KEY]: {} } }, { timeout: CALL_TIMEOUT_MS, signal: channelAbort.signal });
      if (hashOf(result._meta) !== pinned) {
        tainted = true;
        throw new BridgeError('surface_mismatch');
      }
      return result;
    }, (event) => mcp.server.notification({ method: 'notifications/claude/channel', params: { content: event.content, meta: event.meta } }), channelAbort.signal, client)
      .catch(() => {
        if (!channelAbort.signal.aborted) log('playerthree-mcp: wake channel stopped; reconnect to resume lifecycle notifications.');
        channelAbort.abort();
      });
  };
  const forward = async (params: CallToolRequest['params'], ctx: ServerContext, server: McpServer['server']): Promise<CallToolResult | InputRequiredResult> => {
    if (tainted) return refusal('surface_mismatch');
    const requestState = ctx.mcpReq.requestState<string>();
    const progressToken = ctx.mcpReq._meta?.progressToken;
    const forwarded = {
      name: params.name,
      arguments: params.arguments ?? {},
      ...(ctx.mcpReq.inputResponses ? { inputResponses: ctx.mcpReq.inputResponses } : {}),
      ...(typeof requestState === 'string' ? { requestState } : {}),
      // Mirror the local client's capabilities so the remote only asks for what the human's client can show.
      _meta: { [CLIENT_CAPABILITIES_META_KEY]: localCapabilities(ctx, server) },
    };
    let result: CallToolResult | InputRequiredResult;
    try {
      const options = {
        allowInputRequired: true,
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        signal: ctx.mcpReq.signal,
        ...(progressToken !== undefined
          ? {
              onprogress: (p: { progress: number; total?: number }) => {
                ctx.mcpReq
                  .notify({ method: 'notifications/progress', params: { progressToken, progress: p.progress, ...(p.total !== undefined ? { total: p.total } : {}) } })
                  .catch(() => {});
              },
            }
          : {}),
      };
      result = await client.callTool(forwarded as CallToolRequest['params'], options) as CallToolResult | InputRequiredResult;
    } catch {
      return refusal('transport');
    }
    if (isInputRequiredResult(result)) return result;
    if (hashOf(result._meta) !== pinned) {
      tainted = true;
      log('playerthree-mcp: the remote tool surface changed (surfaceHash differs from the pinned one); refusing to forward anything else.');
      return refusal('surface_mismatch');
    }
    return result;
  };

  const handle = serveStdio(
    () => {
      const mcp = new McpServer({ name: 'playerthree-mcp', version: PACKAGE_VERSION }, instructions ? { instructions } : {});
      mcp.server.registerCapabilities(capabilities);
      mcp.server.oninitialized = () => startChannel(mcp);
      mcp.server.setRequestHandler('tools/list', () => {
        startChannel(mcp);
        return { tools: [...tools] };
      });
      mcp.server.setRequestHandler('tools/call', (request, ctx) => forward(request.params, ctx, mcp.server));
      localSkills.attach(mcp);
      return mcp;
    },
    {
      transport,
      legacy: 'serve',
      onerror: (e) => log(`playerthree-mcp: ${e.message}`),
    },
  );

  return {
    surfaceHash: pinned,
    tools,
    async close() {
      channelAbort.abort();
      await channelTask;
      await handle.close();
      await client.close();
    },
  };
}
