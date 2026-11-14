import { describe, expect, it } from 'vitest';
import { CLIENT_KINDS, HARNESSES, MANDATE_PRESETS, harness, harnessSetup, isClientKind, serverName } from '../src/index.ts';

const URL_ = 'https://game.example/mcp';
const TOKEN = 'abcDEF0123456789_-abcDEF01234567';
const opts = { mcpUrl: URL_, serverName: 'agent-command' };

describe('harness catalog', () => {
  it('covers every client kind once', () => {
    expect(HARNESSES.map((h) => h.kind).sort()).toEqual([...CLIENT_KINDS].sort());
    expect(isClientKind('codex')).toBe(true);
    expect(isClientKind('claude')).toBe(false);
  });

  it('server names are [a-z0-9-]', () => {
    expect(serverName('Agent Command')).toBe('agent-command');
    expect(serverName('Agent Command', 'sky')).toBe('agent-command-sky');
    expect(serverName('$(id)')).toBe('id');
    expect(serverName('')).toBe('game');
  });
});

describe('harnessSetup (OAuth: no secrets)', () => {
  it('Claude Code: one http add, sign in via /mcp', () => {
    const s = harnessSetup('claude-code', opts)!;
    expect(s.text).toBe('claude mcp add --transport http agent-command https://game.example/mcp');
    expect(s.language).toBe('sh');
    expect(s.then).toContain('/mcp');
  });

  it('Claude Code channels explicitly use stdio and the development-channel launch flag', () => {
    const s = harnessSetup('claude-code', { ...opts, channel: true })!;
    expect(s.text).toBe('claude mcp add --transport stdio agent-command -- npx --package @playerthree/runner playerthree-mcp --url https://game.example/mcp --channel');
    expect(s.then).toContain('claude --dangerously-load-development-channels server:agent-command');
    expect(s.then).toContain('silently dropped unless the channel is loaded');
  });

  it('Codex: add + login', () => {
    expect(harnessSetup('codex', opts)!.text).toBe('codex mcp add agent-command --url https://game.example/mcp && codex mcp login agent-command');
  });

  it('OpenCode: non-interactive add to the global config, then auth', () => {
    const s = harnessSetup('opencode', opts)!;
    expect(s.language).toBe('sh');
    expect(s.text).toBe('opencode mcp add agent-command --url https://game.example/mcp && opencode mcp auth agent-command');
    expect(s.then).toContain('browser');
  });

  it('Pi: add + login', () => {
    const s = harnessSetup('pi', opts)!;
    expect(s.language).toBe('sh');
    expect(s.text).toBe('pi mcp add agent-command --url https://game.example/mcp && pi mcp login agent-command');
    expect(harness('pi').blurb).not.toMatch(/oh-my-pi/i);
  });

  it('oh-my-pi: in-session /mcp quick-add (user scope, http) with the mcp.json entry as the alternative', () => {
    const s = harnessSetup('oh-my-pi', { ...opts, serverName: 'agent-command-2', channel: true })!;
    expect(s.language).toBe('slash');
    expect(s.file).toBeUndefined();
    expect(s.text).toBe('/mcp add agent-command-2 --scope user --url https://game.example/mcp --transport http');
    expect(s.then).toContain('/mcp reauth agent-command-2');
    expect(s.alternative?.file).toBe('~/.omp/agent/mcp.json');
    expect(JSON.parse(s.alternative!.text)).toEqual({
      $schema: 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json',
      mcpServers: { 'agent-command-2': { type: 'http', url: URL_ } },
    });
    expect(harness('oh-my-pi').blurb).toContain('Claude Code and Cursor');
  });

  it('Hermes: config.yaml with auth: oauth', () => {
    const s = harnessSetup('hermes', opts)!;
    expect(s.file).toBe('~/.hermes/config.yaml');
    expect(s.text).toBe(['mcp_servers:', '  agent-command:', '    url: "https://game.example/mcp"', '    auth: oauth'].join('\n'));
  });

  it('generic MCP JSON and the stdio bridge', () => {
    expect(JSON.parse(harnessSetup('generic', opts)!.text)).toEqual({ mcpServers: { 'agent-command': { type: 'http', url: URL_ } } });
    expect(JSON.parse(harnessSetup('playerthree-bridge', opts)!.text)).toEqual({ mcpServers: { 'agent-command': { command: 'npx', args: ['--package', '@playerthree/runner', 'playerthree-mcp', '--url', URL_] } } });
  });

  it('runner: --url only', () => {
    expect(harnessSetup('playerthree-runner', opts)!.text).toBe('npx --package @playerthree/runner playerthree-run --url https://game.example/mcp --model gpt-5-mini --max-usd 0.25');
  });

  it('no output carries a token unless one is given', () => {
    for (const k of CLIENT_KINDS) expect(harnessSetup(k, opts)!.text).not.toMatch(/Bearer|--token/);
  });
});

describe('harnessSetup (bearer fallback)', () => {
  const t = { ...opts, token: TOKEN };
  it('embeds a well-formed token', () => {
    expect(harnessSetup('claude-code', t)!.text).toBe(`claude mcp add --transport http agent-command https://game.example/mcp --header 'Authorization: Bearer ${TOKEN}'`);
    expect(harnessSetup('codex', t)!.text).toContain(`http_headers = { "Authorization" = "Bearer ${TOKEN}" }`);
    expect(harnessSetup('hermes', t)!.text).toContain(`Authorization: "Bearer ${TOKEN}"`);
    expect(harnessSetup('hermes', t)!.text).not.toContain('oauth');
    expect(JSON.parse(harnessSetup('generic', t)!.text).mcpServers['agent-command'].headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(harnessSetup('playerthree-runner', t)!.text).toContain(`--token ${TOKEN}`);
    expect(JSON.parse(harnessSetup('playerthree-bridge', t)!.text).mcpServers['agent-command'].args).toEqual(['--package', '@playerthree/runner', 'playerthree-mcp', '--url', URL_, '--token', TOKEN]);
    expect(harnessSetup('opencode', t)!.text).toBe(`opencode mcp add agent-command --url https://game.example/mcp --header 'Authorization=Bearer ${TOKEN}'`);
    expect(harnessSetup('pi', t)!.file).toBe('~/.pi/agent/mcp.json');
    expect(JSON.parse(harnessSetup('pi', t)!.text)).toEqual({ mcpServers: { 'agent-command': { url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } } });
    const omp = harnessSetup('oh-my-pi', t)!;
    expect(omp.text).toBe(`/mcp add agent-command --scope user --url https://game.example/mcp --transport http --token ${TOKEN}`);
    expect(JSON.parse(omp.alternative!.text).mcpServers['agent-command']).toEqual({ type: 'http', url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } });
  });

  it('hosted Claude uses a token and tools over public HTTPS, never local HTTP', () => {
    const s = harnessSetup('claude-api', t)!;
    expect(JSON.parse(s.text)).toEqual({
      mcp_servers: [{ type: 'url', url: URL_, name: 'agent-command', authorization_token: TOKEN }],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'agent-command' }],
    });
    expect(s.then).toContain('mcp-client-2025-11-20');
    expect(s.then).toContain('game_skill and tools only');
    expect(s.then).toContain('vault');
    const local = harnessSetup('claude-api', { ...t, mcpUrl: 'http://localhost:5173/mcp' })!;
    expect(local.text).toBe('');
    expect(local.then).toContain('Requires a public HTTPS deployment');
  });

  it('refuses unexpected input instead of building a command from it', () => {
    expect(harnessSetup('claude-code', { ...opts, token: 'abc; rm -rf ~' })).toBeUndefined();
    expect(harnessSetup('claude-code', { ...opts, token: `${TOKEN}x` })).toBeUndefined();
    expect(harnessSetup('claude-code', { ...opts, mcpUrl: 'javascript:alert(1)' })).toBeUndefined();
    expect(harnessSetup('claude-code', { ...opts, mcpUrl: 'https://x.test/$(id) x' })).toBeUndefined();
    expect(harnessSetup('codex', { ...opts, serverName: 'a b' })).toBeUndefined();
    expect(harnessSetup('codex', { ...opts, serverName: 'x]\nevil = 1' })).toBeUndefined();
  });

  it('shell-quotes URLs with query strings', () => {
    expect(harnessSetup('claude-code', { ...opts, mcpUrl: 'https://x.test/mcp?a=1&b=2' })!.text).toBe("claude mcp add --transport http agent-command 'https://x.test/mcp?a=1&b=2'");
  });
});

describe('mandate onboarding', () => {
  it('offers independent autonomous, author and supervised advisor presets', () => {
    expect(MANDATE_PRESETS.autonomous).toEqual({ scopes: ['act', 'policy', 'practice', 'publish', 'say'], autonomy: 'autonomous' });
    expect(MANDATE_PRESETS.author).toEqual({ scopes: ['policy', 'practice', 'publish', 'say'], autonomy: 'autonomous' });
    expect(MANDATE_PRESETS.advisor).toEqual({ scopes: ['practice', 'policy', 'say'], autonomy: 'supervised' });
  });

});
