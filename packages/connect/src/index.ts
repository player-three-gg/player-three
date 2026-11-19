/**
 * Headless connection setup: the catalog of agent harnesses a player can attach to a game's MCP endpoint, the exact
 * copy-paste command or config for each one, and the wire types games use for connections and consent requests.
 * DOM-free and UI-free: games render their own buttons, icons and pages from this.
 *
 * With MCP authorization (OAuth 2.1, see docs/MCP.md) nothing here carries a secret: one static URL for everyone, and
 * the harness signs the player in through the browser. `token` (a per-match seat token or a persistent commander
 * token) is the bearer fallback for harnesses or hosts without OAuth; it is embedded only when it has the opaque
 * PlayerThree token format. Output is only built from a well-formed http(s) URL and a `[a-z0-9-]` server name, so no
 * command line is ever assembled from unexpected input.
 */
import type { Mandate, Scope } from 'playerthree/control';
import { TOKEN_RE } from 'playerthree/protocol';

/** Harness families a connection can come from (detected by the host from the OAuth client's metadata). */
export const CLIENT_KINDS = ['claude-code', 'claude-api', 'codex', 'opencode', 'pi', 'oh-my-pi', 'hermes', 'generic', 'playerthree-runner', 'playerthree-bridge'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** Narrows an untrusted value to a known {@link ClientKind}. */
export function isClientKind(v: unknown): v is ClientKind {
  return typeof v === 'string' && (CLIENT_KINDS as readonly string[]).includes(v);
}

/** Catalog entry of one harness family. */
export interface Harness {
  readonly kind: ClientKind;
  /** Display name. */
  readonly name: string;
  /** One line on what it is. */
  readonly blurb: string;
  /** The harness's own MCP documentation, when it has a public page. */
  readonly docsUrl?: string;
}

/** Every harness with a setup recipe, in the order games should offer them. */
export const HARNESSES: readonly Harness[] = [
  { kind: 'claude-code', name: 'Claude Code', blurb: "Anthropic's agentic coding CLI", docsUrl: 'https://code.claude.com/docs/en/mcp' },
  { kind: 'claude-api', name: 'Claude API / Managed Agents', blurb: 'Hosted MCP connector · commander token and public HTTPS required', docsUrl: 'https://platform.claude.com/docs/en/agents-and-tools/mcp-connector' },
  { kind: 'codex', name: 'Codex', blurb: "OpenAI's coding agent CLI", docsUrl: 'https://developers.openai.com/codex/mcp' },
  { kind: 'opencode', name: 'OpenCode', blurb: 'Open-source terminal coding agent', docsUrl: 'https://opencode.ai/docs/mcp-servers/' },
  { kind: 'pi', name: 'Pi', blurb: 'Minimal, extensible terminal coding agent', docsUrl: 'https://pi.dev/docs/latest/mcp' },
  { kind: 'oh-my-pi', name: 'oh-my-pi', blurb: 'Pi-based terminal coding agent · also auto-imports your Claude Code and Cursor MCP configs', docsUrl: 'https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md' },
  { kind: 'hermes', name: 'Hermes Agent', blurb: "Nous Research's open agent", docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp' },
  { kind: 'generic', name: 'Generic MCP', blurb: 'Any MCP client with remote HTTP + OAuth', docsUrl: 'https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization' },
  { kind: 'playerthree-runner', name: 'Runner', blurb: 'playerthree-run plays with your own API key and a hard budget' },
  { kind: 'playerthree-bridge', name: 'stdio bridge', blurb: 'playerthree-mcp, for harnesses that only speak stdio' },
];

/** The catalog entry of `kind`. */
export function harness(kind: ClientKind): Harness {
  return HARNESSES.find((h) => h.kind === kind)!;
}

/** Where a setup goes: `sh` runs in a terminal, `slash` is typed into the harness's own session; otherwise it is
 *  pasted into `file` (or the client's MCP settings when no file). */
export interface SetupText {
  readonly language: 'sh' | 'slash' | 'toml' | 'yaml' | 'json';
  readonly file?: string;
  readonly text: string;
}

/** The copy-paste setup for one harness. */
export interface HarnessSetup extends SetupText {
  readonly kind: ClientKind;
  /** Plain-language next step after pasting (how the harness signs in). */
  readonly then: string;
  /** The same server as a config-file entry, for players who prefer editing the file. */
  readonly alternative?: SetupText;
}

/** Inputs of {@link harnessSetup}. */
export interface SetupOptions {
  /** The game's MCP endpoint, e.g. `https://game.example/mcp`. */
  readonly mcpUrl: string;
  /** MCP server name inside the harness (`[a-z0-9-]`, ≤ 64), e.g. from {@link serverName}. */
  readonly serverName: string;
  /** Bearer fallback: a seat or commander token instead of OAuth sign-in. */
  readonly token?: string;
  /** Claude Code only: opt in to the stdio bridge's research-preview wake channel. */
  readonly channel?: boolean;
}

/** MCP server name from identifiers: lower-case, `[a-z0-9-]`, joined with `-`, ≤ 64 chars. */
export function serverName(...parts: string[]): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  return parts.map(clean).filter(Boolean).join('-').slice(0, 64).replace(/-+$/, '') || 'game';
}

const SAFE_URL = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
const SERVER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** POSIX single-quote a string for a shell command line. */
function shq(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Setup for `kind`, or `undefined` when the URL is not http(s), the server name is not `[a-z0-9-]` or the token is
 * malformed (callers render nothing rather than a broken command).
 */
export function harnessSetup(kind: ClientKind, opts: SetupOptions): HarnessSetup | undefined {
  const { mcpUrl: url, serverName: name, token } = opts;
  if (!SAFE_URL.test(url) || !SERVER_NAME.test(name) || (token !== undefined && !TOKEN_RE.test(token))) return undefined;
  const bearer = token === undefined ? undefined : `Bearer ${token}`;
  switch (kind) {
    case 'claude-code':
      if (opts.channel) return {
        kind,
        language: 'sh',
        text: `claude mcp add --transport stdio ${name} -- npx --package @playerthree/runner playerthree-mcp --url ${shq(url)}${token ? ` --token ${token}` : ''} --channel`,
        then: `Launch Claude Code with claude --dangerously-load-development-channels server:${name}. This channel is a research preview; notifications are silently dropped unless the channel is loaded.${token ? '' : ' On first start the bridge opens your browser to sign in.'}`,
      };
      return {
        kind,
        language: 'sh',
        text: `claude mcp add --transport http ${name} ${shq(url)}${bearer ? ` --header ${shq(`Authorization: ${bearer}`)}` : ''}`,
        then: bearer ? 'Restart Claude Code; it connects with the token.' : `In Claude Code run /mcp, pick ${name} and choose Authenticate: your browser opens to sign in.`,
      };
    case 'claude-api':
      return {
        kind,
        language: 'json',
        text: url.startsWith('https://') && token ? JSON.stringify({
          mcp_servers: [{ type: 'url', url, name, authorization_token: token }],
          tools: [{ type: 'mcp_toolset', mcp_server_name: name }],
        }, null, 2) : '',
        then: `${url.startsWith('https://') ? 'Requires a publicly reachable HTTPS endpoint.' : 'Requires a public HTTPS deployment; local HTTP URLs are not reachable by hosted Claude agents.'} ${token ? 'Merge this snippet into your Messages API request' : 'Select a commander token in Advanced to generate the Messages API snippet'} and send the anthropic-beta header mcp-client-2025-11-20 (or mcp-client-2026-09-15 for tool-list pinning). Managed Agents declare the MCP server on the agent and supply credentials via a vault. Plays via game_skill and tools only: no resources, skills protocol or channels. The caller supplies and refreshes OAuth tokens if using OAuth instead of a commander token.`,
      };
    case 'codex':
      return bearer
        ? {
            kind,
            language: 'toml',
            file: '~/.codex/config.toml',
            text: [`[mcp_servers.${name}]`, `url = ${JSON.stringify(url)}`, `http_headers = { "Authorization" = ${JSON.stringify(bearer)} }`].join('\n'),
            then: 'Restart Codex; it connects with the token.',
          }
        : {
            kind,
            language: 'sh',
            text: `codex mcp add ${name} --url ${shq(url)} && codex mcp login ${name}`,
            then: 'Codex opens your browser to sign in.',
          };
    case 'opencode':
      // `opencode mcp add <name> --url` writes the global ~/.config/opencode/opencode.json non-interactively.
      return {
        kind,
        language: 'sh',
        text: `opencode mcp add ${name} --url ${shq(url)}${bearer ? ` --header ${shq(`Authorization=${bearer}`)}` : ` && opencode mcp auth ${name}`}`,
        then: bearer ? 'Restart OpenCode; it connects with the token.' : 'OpenCode opens your browser to sign in.',
      };
    case 'pi':
      // `pi mcp add` only takes a bearer token from an environment variable, so a pasted token goes into the file.
      return bearer
        ? {
            kind,
            language: 'json',
            file: '~/.pi/agent/mcp.json',
            text: JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: bearer } } } }, null, 2),
            then: 'Run /reload in Pi (or restart it); it connects with the token.',
          }
        : {
            kind,
            language: 'sh',
            text: `pi mcp add ${name} --url ${shq(url)} && pi mcp login ${name}`,
            then: 'Pi opens your browser to sign in. Run /reload in a running Pi session.',
          };
    case 'oh-my-pi': {
      // oh-my-pi has no shell `mcp add`: its `/mcp add` quick-add runs inside the session, tests the connection and
      // starts OAuth itself. Its argument splitter is not a shell, so the (space-free) URL stays unquoted.
      const entry = { type: 'http', url, ...(bearer ? { headers: { Authorization: bearer } } : {}) };
      return {
        kind,
        language: 'slash',
        text: `/mcp add ${name} --scope user --url ${url} --transport http${token ? ` --token ${token}` : ''}`,
        then: `${token ? 'oh-my-pi connects with the token.' : `oh-my-pi opens your browser to sign in; if it does not, run /mcp reauth ${name}.`} Owner messages arrive in game_wait/game_observe tool results; keep the per-role monitor loop running. This HTTP setup does not install a push-to-prompt extension.`,
        alternative: {
          language: 'json',
          file: '~/.omp/agent/mcp.json',
          text: JSON.stringify({ $schema: 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json', mcpServers: { [name]: entry } }, null, 2),
        },
      };
    }
    case 'hermes':
      return {
        kind,
        language: 'yaml',
        file: '~/.hermes/config.yaml',
        text: ['mcp_servers:', `  ${name}:`, `    url: ${JSON.stringify(url)}`, ...(bearer ? ['    headers:', `      Authorization: ${JSON.stringify(bearer)}`] : ['    auth: oauth'])].join('\n'),
        then: bearer ? 'Restart Hermes (or /reload-mcp); it connects with the token.' : `Run hermes mcp login ${name} (or just start Hermes): your browser opens to sign in.`,
      };
    case 'generic':
      return {
        kind,
        language: 'json',
        text: JSON.stringify({ mcpServers: { [name]: { type: 'http', url, ...(bearer ? { headers: { Authorization: bearer } } : {}) } } }, null, 2),
        then: bearer ? "Add it to your client's MCP settings; it connects with the token." : "Add it to your client's MCP settings; the client opens your browser to sign in (MCP OAuth).",
      };
    case 'playerthree-runner':
      return {
        kind,
        language: 'sh',
        text: `npx --package @playerthree/runner playerthree-run --url ${shq(url)}${token ? ` --token ${token}` : ''} --model gpt-5-mini --max-usd 0.25`,
        then: `Uses your own OPENAI_API_KEY (or ANTHROPIC_API_KEY with another --model) and stops at the budget.${token ? '' : ' Opens your browser to sign in; the sign-in is cached.'}`,
      };
    case 'playerthree-bridge':
      return {
        kind,
        language: 'json',
        text: JSON.stringify({ mcpServers: { [name]: { command: 'npx', args: ['--package', '@playerthree/runner', 'playerthree-mcp', '--url', url, ...(token ? ['--token', token] : [])] } } }, null, 2),
        then: token ? "Add it to your harness's stdio MCP servers." : "Add it to your harness's stdio MCP servers. On first start the bridge opens your browser (and prints the link) to sign in.",
      };
  }
}

/** UI shortcuts; intersect their scopes with the modes supported by the game's manifest. */
export const MANDATE_PRESETS = {
  autonomous: { scopes: ['act', 'policy', 'practice', 'publish', 'say'], autonomy: 'autonomous' },
  author: { scopes: ['policy', 'practice', 'publish', 'say'], autonomy: 'autonomous' },
  advisor: { scopes: ['practice', 'policy', 'say'], autonomy: 'supervised' },
} satisfies Record<string, { scopes: Scope[]; autonomy: Mandate['autonomy'] }>;

/** Inputs of {@link kickoffPrompt}: the game title, the seat roles and their mandate. */
export interface KickoffOptions {
  readonly gameTitle: string;
  readonly roles: readonly string[];
  readonly mandate: Mandate;
}

/** The player-pasted first message for a turn-based harness; live briefing remains authoritative. */
export function kickoffPrompt({ gameTitle, roles, mandate }: KickoffOptions): string {
  return [
    `Help me play ${gameTitle} as my agent for these roles: ${roles.join(', ')}.`,
    "Start with game_briefing for every role you command, then the topics its role doc lists under READ BEFORE PLAYING (game_briefing with topic), then read and follow game_skill(name: 'playerthree-commander', path: 'SKILL.md') and the game's strategy skill SKILL.md; fetch other topics just in time. Follow that seat's current scopes and mandate.",
    mandate.autonomy === 'autonomous'
      ? 'Your mandate is autonomous: decide and act without asking, within your scopes and limits.'
      : 'Your mandate is supervised: propose policy deploys, rollbacks and publishing; your owner approves them. Check policy_status and game_wait for approval outcomes.',
    `Directive: ${JSON.stringify(mandate.directive)}.`,
    ...(mandate.limits === undefined ? [] : [`Limits: ${JSON.stringify(mandate.limits)}.`]),
    `When you are absent: ${mandate.whenAbsent}.`,
    'Deploy a working policy fast for every role you command when your scopes allow it.',
    'Keep the monitor loop going while a match is live: observe, act within your mandate, and use game_wait between updates for every commanded role, passing role when you command several.',
    'Read top-level messages from every game_wait and game_observe result before summarizing its observation: messages sit beside observation, not inside it, and are consumed when returned. Do not discard a wait result or expect a later observe to repeat its messages. Handle messages labelled from owner promptly and reply with game_say when allowed.',
  ].join('\n');
}

// ---------------------------------------------------------------- wire types (host app ↔ its web client)

/** The OAuth client behind a connection, as the host describes it. Name and URI come from the client: show as text. */
export interface ConnectionClient {
  readonly name: string;
  readonly kind: ClientKind;
  /** Client ID Metadata Document URL (CIMD clients) or the client's declared homepage. */
  readonly uri?: string;
  readonly logoUri?: string;
  /** Host of a CIMD `client_id` URL: the name is vouched for by that domain. Absent (DCR): self-asserted, unverified. */
  readonly domain?: string;
}

/** One independently authorised harness connection to one named commander. */
export interface ConnectionInfo {
  readonly id: string;
  readonly commander: string;
  readonly client: ConnectionClient;
  readonly roles: readonly string[];
  /** A recent call, a call in flight, or an active sequence; signed in alone does not mean active now. */
  readonly active: boolean;
  /** ms epoch of the last authenticated request, `null` if never used. */
  readonly lastSeen: number | null;
  /** ms epoch of the consent that created it. */
  readonly createdAt: number;
  /** ms epoch of the latest explicit consent for this exact connection. */
  readonly authorizedAt: number;
}

/** A pending authorization request the owner is asked to approve. */
export interface ConsentRequestInfo {
  readonly client: ConnectionClient;
  /** Roles the owner can grant. */
  readonly roles: readonly string[];
  /** Where the browser returns after consent; consent pages must show the host and flag loopback-only redirects. */
  readonly redirect: { readonly host: string; readonly loopback: boolean };
  /** ms epoch after which the request is gone (start the sign-in again from the harness). */
  readonly expiresAt: number;
}

/** The owner's answer to a {@link ConsentRequestInfo}: approve or deny, binding the connection to one commander and its roles. */
export interface ConsentAnswer {
  readonly commander: string;
  readonly roles: readonly string[];
  readonly approve: boolean;
  /** Alternative to profile authentication: a code consumed by this approval, or a request-bound exchange token. */
  readonly pairingCode?: string;
  readonly pairingToken?: string;
}

/** Where to send the browser next (the client's redirect URI with the code, or with `error=access_denied`). */
export interface ConsentResult {
  readonly redirect: string;
}

/** A single-use code minted in the owner's browser; expires after ten minutes. */
export interface PairingCode {
  readonly code: string;
  readonly expiresAt: number;
}

/** Safe named commander details returned after pairing; never includes profile or commander secrets. */
export interface ConsentCommander {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly kind: 'agent' | 'policy';
  readonly isolation: { readonly independentSessions: boolean };
  readonly metadata?: { readonly provider?: string; readonly model?: string; readonly scaffoldVersion?: string };
  readonly holder: Pick<ConnectionClient, 'name' | 'kind'> | null;
  /** What this named commander may do and is asked to do (shown so consent is informed). */
  readonly scopes: readonly Scope[];
  readonly mandate: Mandate;
}

/** A capability for one consent request, not a profile login. Keep it only in the consent page's memory. */
export interface PairingResult {
  readonly commanders: readonly ConsentCommander[];
  readonly pairingToken: string;
  readonly expiresAt: number;
}
