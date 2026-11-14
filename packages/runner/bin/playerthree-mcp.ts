#!/usr/bin/env node
/**
 * playerthree-mcp — local stdio MCP server that forwards to one remote PlayerThree MCP endpoint.
 *
 *   playerthree-mcp --url https://game.example/mcp                         sign in through the browser (cached)
 *   playerthree-mcp --url https://game.example/mcp --token <seat token>    or a pasted seat/commander token
 *
 * The token may also come from PLAYERTHREE_TOKEN (keeps it out of the process list).
 */
import { parseArgs } from 'node:util';
import { joinStringOptions } from '../src/argv.ts';
import { BridgeError, startBridge } from '../src/bridge.ts';
import { browserSignIn, configDir, SignInError, type EndpointAuth } from '../src/oauth.ts';
import { PlayerThreeSeatError, connectSeat } from '../src/remote.ts';

const USAGE = `usage: playerthree-mcp --url <https://…/mcp> [--token <seat token>] [--expect-hash <sha256 hex>] [--channel]
  without a token: sign in through the browser (the sign-in URL is printed too); cached in ${configDir()}
  --login        sign in (or check the cached sign-in) and exit
  --logout       forget the cached sign-in for this URL and exit
  --no-browser   only print the sign-in URL
  --channel      opt in to Claude Code lifecycle wakes (stdio research preview)
                 launch Claude with --dangerously-load-development-channels server:<name>`;

const options = {
  url: { type: 'string' },
  token: { type: 'string' },
  'expect-hash': { type: 'string' },
  login: { type: 'boolean' },
  logout: { type: 'boolean' },
  'no-browser': { type: 'boolean' },
  channel: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;
const { values } = parseArgs({ args: joinStringOptions(process.argv.slice(2), options), options, strict: true });

if (values.help) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(0);
}
const token = values.token ?? process.env['PLAYERTHREE_TOKEN'];
const expectHash = values['expect-hash'];
if (!values.url) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(64);
}
if (expectHash !== undefined && !/^[0-9a-f]{64}$/.test(expectHash)) {
  process.stderr.write('playerthree-mcp: --expect-hash must be 64 lowercase hex characters\n');
  process.exit(64);
}

const log = (line: string) => process.stderr.write(`${line}\n`);
const url = values.url;

let auth: EndpointAuth;
let signIn;
if (token !== undefined) auth = { token };
else {
  signIn = await browserSignIn({ url, clientName: 'playerthree-mcp', softwareId: 'dev.playerthree.bridge', openBrowser: !values['no-browser'], log: (l) => log(`playerthree-mcp: ${l}`) });
  auth = { signIn };
  if (values.logout) {
    signIn.forget();
    signIn.close();
    log(`playerthree-mcp: forgot the sign-in for ${url} (revoke the connection in the game to cut it off server-side)`);
    process.exit(0);
  }
  if (values.login) {
    try {
      const seat = await connectSeat({ url, signIn, clientName: 'playerthree-mcp' });
      await seat.close();
      log(`playerthree-mcp: signed in to ${new URL(url).origin}; the bridge will use this sign-in from now on`);
      process.exit(0);
    } catch (e) {
      log(`playerthree-mcp: sign-in failed (${e instanceof SignInError || e instanceof PlayerThreeSeatError ? e.code : 'transport'})`);
      process.exit(1);
    } finally {
      signIn.close();
    }
  }
}

try {
  const bridge = await startBridge({ url, auth, ...(expectHash ? { expectHash } : {}), ...(values.channel ? { channel: true } : {}), log });
  signIn?.close();
  log(
    `playerthree-mcp: forwarding ${bridge.tools.length} tools from ${new URL(url).origin}; surfaceHash ${bridge.surfaceHash} (${expectHash ? 'pinned by --expect-hash' : 'pinned for this session'})`,
  );
  const shutdown = () => {
    void bridge.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
} catch (e) {
  signIn?.close();
  if (e instanceof BridgeError) {
    const reason =
      e.code === 'surface_mismatch'
        ? e.remoteHash
          ? `remote surfaceHash ${e.remoteHash} differs from --expect-hash ${expectHash}; refusing to start`
          : 'remote is not an PlayerThree endpoint (no surfaceHash); refusing to start'
        : e.code === 'bad_token'
          ? token !== undefined
            ? 'the endpoint rejected the token (expired match or wrong token)'
            : 'the endpoint rejected the sign-in (revoked?); run again with --logout, then sign in again'
          : e.code === 'sign_in'
            ? 'sign-in was not completed'
            : e.code === 'skills'
              ? 'a skill file failed digest verification; refusing to start'
              : e.code === 'protocol'
                ? 'the endpoint offers no supported MCP protocol version'
                : 'could not reach the endpoint';
    log(`playerthree-mcp: ${reason}`);
    process.exit(e.code === 'surface_mismatch' ? 2 : 1);
  }
  throw e;
}
