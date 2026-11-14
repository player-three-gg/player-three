/**
 * Remote seat: a SeatControl backed by a PlayerThree MCP endpoint (negotiated Streamable HTTP).
 * Used by the runner, the stdio bridge's tests, `playerthree audit` and `@playerthree/bench`.
 */
import { Client, SdkError, UnauthorizedError, UnsupportedProtocolVersionError, type CallToolResult, type ElicitRequestFormParams, type ElicitResult, type ListToolsResult, type Tool } from '@modelcontextprotocol/client';
import type {
  Briefing,
  ControlMethod,
  DeployResult,
  IntentAck,
  PolicyExportPage,
  PolicyExportRequest,
  PolicyImportResult,
  PolicyPackage,
  PolicySource,
  PolicyStatus,
  PracticeRequest,
  PracticeResult,
  PublishResult,
  ReadyResult,
  SayResult,
  SeatControl,
  SequenceRequest,
  SequenceResult,
  SkillPage,
  TopicPage,
  WaitRequest,
  WaitResult,
} from 'playerthree';
import { MCP_TOOL_NAMES } from 'playerthree';
import { mergeObservationPages, SURFACE_HASH_META, type ToolErrorCode } from 'playerthree/mcp';
import { connectClient, SignInError, type BrowserSignIn, type EndpointAuth } from './oauth.ts';
import { PACKAGE_VERSION } from './version.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28';

export type SeatErrorCode = ToolErrorCode | 'surface_mismatch' | 'transport' | 'protocol';

/** A failed remote call. `code` is closed; no remote text is carried. */
export class PlayerThreeSeatError extends Error {
  readonly code: SeatErrorCode;
  constructor(code: SeatErrorCode) {
    super(code);
    this.name = 'PlayerThreeSeatError';
    this.code = code;
  }
}

/** A tool call result as the runner sees it. */
export interface ToolOutcome {
  isError: boolean;
  /** The text content blocks, joined. */
  text: string;
  structured: unknown;
}

/** A {@link SeatControl} over a remote MCP endpoint, plus its pinned surface. */
export interface RemoteSeat extends SeatControl {
  readonly surfaceHash: string;
  readonly tools: readonly Tool[];
  readonly instructions: string | undefined;
  /** Raw tool call (for agents that drive the MCP tools directly). Throws only on transport failure or surface change. */
  call(name: string, args: Record<string, unknown>, opts?: { onProgress?: () => void; signal?: AbortSignal }): Promise<ToolOutcome>;
  close(): Promise<void>;
}

/** Options of {@link connectSeat}: the endpoint URL and exactly one of `token` or `signIn`. */
export interface ConnectSeatOptions {
  url: string | URL;
  /** A seat or commander token. Exactly one of `token` / `signIn`. */
  token?: string;
  /** Browser sign-in (OAuth) instead of a pasted token: the endpoint's authorization server issues the credential. */
  signIn?: BrowserSignIn;
  /**
   * For credentials commanding several roles (sign-in connections): the role the SeatControl methods act for.
   * `call()` passes arguments through as given.
   */
  role?: string;
  /** Refuse to connect (and later refuse results) unless the endpoint's surfaceHash equals this. */
  expectHash?: string;
  /** Answer the endpoint's consent form. Omit to not advertise elicitation (the endpoint then treats connecting as consent). */
  elicit?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
  clientName?: string;
}

const LONG_CALL_MS = 300_000;

export function hashOf(meta: unknown): string | undefined {
  const v = (meta as Record<string, unknown> | undefined)?.[SURFACE_HASH_META];
  return typeof v === 'string' ? v : undefined;
}

function errorCodeOf(result: CallToolResult): ToolErrorCode {
  const text = result.content.find((c) => c.type === 'text');
  if (text && text.type === 'text') {
    try {
      const parsed = JSON.parse(text.text) as { error?: unknown };
      if (typeof parsed.error === 'string') return parsed.error as ToolErrorCode;
    } catch {
      // fall through
    }
  }
  return 'internal';
}

/** Connects to a remote seat over MCP (protocol revision pinned to {@link MCP_PROTOCOL_VERSION}). */
export async function connectSeat(opts: ConnectSeatOptions): Promise<RemoteSeat> {
  const auth: EndpointAuth | undefined = opts.signIn ? { signIn: opts.signIn } : opts.token !== undefined ? { token: opts.token } : undefined;
  if (!auth || (opts.signIn && opts.token !== undefined)) throw new TypeError('playerthree: connectSeat needs exactly one of token / signIn');
  const makeClient = (): Client => {
    const client = new Client(
      { name: opts.clientName ?? 'playerthree-seat', version: PACKAGE_VERSION },
      {
        versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
        capabilities: opts.elicit ? { elicitation: { form: {} } } : {},
      },
    );
    if (opts.elicit) {
      const elicit = opts.elicit;
      client.setRequestHandler('elicitation/create', async (request) => {
        const params = request.params;
        if (params.mode === 'url') return { action: 'decline' };
        return elicit(params as ElicitRequestFormParams);
      });
    }
    return client;
  };
  // Discovery claims nothing; the first real call (the tool listing) binds the seat lease, so either may be denied.
  const failure = (e: unknown): PlayerThreeSeatError => {
    if (UnsupportedProtocolVersionError.isInstance(e)) return new PlayerThreeSeatError('protocol');
    const unauthorized = UnauthorizedError.isInstance(e) || (SdkError.isInstance(e) && /401|unauthori/i.test(e.message)) || (e instanceof Error && /401|unauthori/i.test(e.message));
    return new PlayerThreeSeatError(unauthorized ? 'bad_token' : 'transport');
  };
  const open = async (): Promise<Client> => {
    try {
      return await connectClient(new URL(opts.url), auth, makeClient);
    } catch (e) {
      if (e instanceof SignInError) throw e;
      throw failure(e);
    }
  };

  let client = await open();
  let listing: ListToolsResult;
  try {
    listing = await client.listTools(undefined, { cacheMode: 'bypass' });
  } catch (e) {
    await client.close().catch(() => {});
    throw failure(e);
  }
  const surfaceHash = hashOf(listing._meta);
  if (!surfaceHash || (opts.expectHash !== undefined && surfaceHash !== opts.expectHash)) {
    await client.close();
    throw new PlayerThreeSeatError('surface_mismatch');
  }
  const tools = listing.tools;
  const names = new Set(tools.map((t) => t.name));
  // Stateless commander/OAuth connections may reconnect after a transport failure.
  // A temporary seat must retain its first-use-bound session; opening another would replay its bearer.
  const stateful = client.transport?.sessionId !== undefined;
  let closed = false;
  let broken = false;

  const rawCall = async (name: string, args: Record<string, unknown>, onProgress?: () => void, signal?: AbortSignal): Promise<CallToolResult> => {
    if (closed) throw new PlayerThreeSeatError('transport');
    const long = name === MCP_TOOL_NAMES.practice || name === MCP_TOOL_NAMES.wait;
    if (broken && !stateful) {
      await client.close().catch(() => {});
      client = await open();
      broken = false;
    }
    let result: CallToolResult;
    try {
      result = await client.callTool(
        { name, arguments: args },
        long ? { timeout: LONG_CALL_MS, resetTimeoutOnProgress: true, onprogress: () => onProgress?.(), signal } : { signal },
      );
    } catch {
      broken = true;
      throw new PlayerThreeSeatError('transport');
    }
    if (hashOf(result._meta) !== surfaceHash) throw new PlayerThreeSeatError('surface_mismatch');
    return result;
  };

  const call = async (name: string, args: Record<string, unknown>, callOpts?: { onProgress?: () => void; signal?: AbortSignal }): Promise<ToolOutcome> => {
    const result = await rawCall(name, args, callOpts?.onProgress, callOpts?.signal);
    const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
    return { isError: result.isError === true, text, structured: result.structuredContent };
  };

  const invoke = async <T>(method: ControlMethod, args: Record<string, unknown>): Promise<T> => {
    const name = MCP_TOOL_NAMES[method];
    if (!names.has(name)) throw new PlayerThreeSeatError('mode_unavailable');
    const result = await rawCall(name, opts.role !== undefined && method !== 'skill' ? { ...args, role: opts.role } : args);
    if (result.isError) throw new PlayerThreeSeatError(errorCodeOf(result));
    return result.structuredContent as T;
  };

  return {
    surfaceHash,
    tools,
    instructions: client.getInstructions(),
    call,
    briefing: ((topic?: string, page?: number) =>
      topic === undefined ? invoke<Briefing>('briefing', {}) : invoke<TopicPage>('briefing', page === undefined ? { topic } : { topic, page })) as SeatControl['briefing'],
    // SeatControl returns the whole observation: a paged result is reassembled from its snapshot's pages.
    observe: async (since?: number) => {
      const first = await invoke<{ observation?: Record<string, unknown>; pages?: number; phase?: 'lobby' }>('observe', since === undefined ? {} : { since });
      // Before the start: the lobby state itself.
      if (first.phase === 'lobby') return first;
      if (first.pages === undefined) return first.observation;
      const pages = [first as { observation: Record<string, unknown> }];
      for (let page = 2; page <= first.pages; page++) pages.push(await invoke<{ observation: Record<string, unknown> }>('observe', { page }));
      return mergeObservationPages(pages);
    },
    act: async (intents: unknown[]) => (await invoke<{ acks: IntentAck[] }>('act', { intents })).acks,
    sequence: (req: SequenceRequest) => invoke<SequenceResult>('sequence', { ...req }),
    // A match entry's paged first observation is reassembled like observe's.
    wait: async (req: WaitRequest) => {
      const result = await invoke<WaitResult & { page?: number; pages?: number; next?: unknown; items?: unknown }>('wait', { ...req });
      if (result.phase !== 'match' || result.pages === undefined) return result;
      const { page: _page, pages, next: _next, items: _items, ...rest } = result;
      const parts = [{ observation: rest.observation as Record<string, unknown> }];
      for (let page = 2; page <= pages; page++) parts.push(await invoke<{ observation: Record<string, unknown> }>('observe', { page }));
      return { ...rest, observation: mergeObservationPages(parts) };
    },
    ready: () => invoke<ReadyResult>('ready', {}),
    skill: (name: string, path: string, offset?: number) => invoke<SkillPage>('skill', offset === undefined ? { name, path } : { name, path, offset }),
    // The tool input is exactly the request artifact (`code` or `modules` + `entry`, optional `include`).
    policyDeploy: (artifact: PolicySource) => invoke<DeployResult>('policyDeploy', { ...artifact }),
    policyStatus: async () => (await invoke<{ policy: PolicyStatus | null }>('policyStatus', {})).policy,
    policyRollback: (version: number) => invoke<DeployResult>('policyRollback', { version }),
    policyExport: (request: PolicyExportRequest = {}) => invoke<PolicyExportPage>('policyExport', { ...request }),
    policyImport: (pkg: PolicyPackage) => invoke<PolicyImportResult>('policyImport', { package: pkg }),
    practice: (req: PracticeRequest) => invoke<PracticeResult>('practice', { ...req }),
    publish: () => invoke<PublishResult>('publish', {}),
    say: (text: string) => invoke<SayResult>('say', { text }),
    close: async () => {
      closed = true;
      await client.close();
    },
  };
}
