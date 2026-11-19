#!/usr/bin/env node
/**
 * playerthree-run — play a seat with your own LLM key.
 *
 *   OPENAI_API_KEY=… playerthree-run --url https://game.example/mcp --model gpt-5-mini --max-usd 0.50   (browser sign-in)
 *   ANTHROPIC_API_KEY=… playerthree-run --url … --token <seat token> --model claude-sonnet-5-5 --max-usd 2
 *
 * Env: PLAYERTHREE_TOKEN, PLAYERTHREE_MODEL, OPENAI_API_KEY, ANTHROPIC_API_KEY.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/client';
import type { ReasoningEffort } from 'playerthree/arena';
import { llmTools, runAgent, systemPrompt } from '../src/agent.ts';
import { joinStringOptions } from '../src/argv.ts';
import { Budget, createAnthropicProvider, createOpenAiProvider, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_REASONING_EFFORT, priceFor, type Price } from '../src/providers.ts';
import { browserSignIn, configDir, SignInError, type BrowserSignIn } from '../src/oauth.ts';
import { PlayerThreeSeatError, connectSeat } from '../src/remote.ts';

const USAGE = `usage: playerthree-run --url <https://…/mcp> [--token <seat token>] [options]
  without a token: sign in through the browser (the sign-in URL is printed too); cached in ${configDir()}
  --model <id>              model (env PLAYERTHREE_MODEL; default gpt-5-mini with OPENAI_API_KEY, claude-haiku-5-5 with ANTHROPIC_API_KEY)
  --provider openai|anthropic  default: inferred from the model id
  --max-usd <n>             hard spend limit (default 1.00)
  --max-output-tokens <n>   per model turn (default ${DEFAULT_MAX_OUTPUT_TOKENS})
  --reasoning-effort low|medium|high|xhigh|off  every model turn (default ${DEFAULT_REASONING_EFFORT}); off sends none, for models without reasoning
  --max-turns <n>           stop after n model turns
  --idle-wait <seconds>     game seconds to wait when the model idles (default 30)
  --price-in/--price-out <usd per 1M tokens>  required for models without a built-in price
  --expect-hash <sha256>    refuse unless the endpoint's surfaceHash matches
  --no-browser              only print the sign-in URL
  --yes                     answer the endpoint's consent prompt with "allow" (otherwise asked on the terminal)`;

const options = {
  url: { type: 'string' },
  token: { type: 'string' },
  model: { type: 'string' },
  provider: { type: 'string' },
  'max-usd': { type: 'string' },
  'max-output-tokens': { type: 'string' },
  'reasoning-effort': { type: 'string' },
  'max-turns': { type: 'string' },
  'idle-wait': { type: 'string' },
  'price-in': { type: 'string' },
  'price-out': { type: 'string' },
  'expect-hash': { type: 'string' },
  yes: { type: 'boolean' },
  'no-browser': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;
const { values } = parseArgs({ args: joinStringOptions(process.argv.slice(2), options), options, strict: true });

const log = (line: string) => process.stderr.write(`${line}\n`);
const fail = (msg: string, code = 64): never => {
  log(`playerthree-run: ${msg}`);
  process.exit(code);
};
const num = (v: string | undefined, name: string, fallback?: number): number | undefined => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative number`);
  return n;
};

if (values.help) {
  log(USAGE);
  process.exit(0);
}
const url = values.url;
const token = values.token ?? process.env['PLAYERTHREE_TOKEN'];
if (!url) fail(`--url is required\n${USAGE}`);

const openaiKey = process.env['OPENAI_API_KEY'];
const anthropicKey = process.env['ANTHROPIC_API_KEY'];
const model = values.model ?? process.env['PLAYERTHREE_MODEL'] ?? (openaiKey ? 'gpt-5-mini' : anthropicKey ? 'claude-haiku-5-5' : undefined);
if (!model) fail('set OPENAI_API_KEY or ANTHROPIC_API_KEY (and optionally --model)');
const providerName = values.provider ?? (model!.startsWith('claude') ? 'anthropic' : 'openai');
if (providerName !== 'openai' && providerName !== 'anthropic') fail('--provider must be openai or anthropic');
const apiKey = providerName === 'openai' ? openaiKey : anthropicKey;
if (!apiKey) fail(`${providerName === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} is not set`);

const priceIn = num(values['price-in'], 'price-in');
const priceOut = num(values['price-out'], 'price-out');
const price: Price | undefined = priceIn !== undefined && priceOut !== undefined ? { inPerM: priceIn, outPerM: priceOut } : priceFor(model!);
if (!price) fail(`no built-in price for ${model}; pass --price-in and --price-out (USD per 1M tokens) so the budget is enforceable`);
const maxUsd = num(values['max-usd'], 'max-usd', 1)!;
const maxOutputTokens = Math.floor(num(values['max-output-tokens'], 'max-output-tokens', DEFAULT_MAX_OUTPUT_TOKENS)!);
const maxTurns = num(values['max-turns'], 'max-turns');
const idleWaitSeconds = num(values['idle-wait'], 'idle-wait', 30)!;
const effortArg = values['reasoning-effort'] ?? DEFAULT_REASONING_EFFORT;
if (!['low', 'medium', 'high', 'xhigh', 'off'].includes(effortArg)) fail('--reasoning-effort must be low, medium, high, xhigh or off');
const reasoningEffort = effortArg === 'off' ? undefined : (effortArg as ReasoningEffort);

async function askConsent(params: ElicitRequestFormParams): Promise<ElicitResult> {
  if (values.yes) return { action: 'accept', content: { allow: true } };
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`\n${params.message}\nAllow? [y/N] `);
    return /^y(es)?$/i.test(answer.trim()) ? { action: 'accept', content: { allow: true } } : { action: 'decline' };
  } finally {
    rl.close();
  }
}

const abort = new AbortController();
process.once('SIGINT', () => {
  log('\nplayerthree-run: interrupted — finishing the current step and shutting down');
  abort.abort();
});

let seat;
let signIn: BrowserSignIn | undefined;
try {
  if (token === undefined) {
    signIn = await browserSignIn({ url: url!, clientName: 'playerthree-run', softwareId: 'dev.playerthree.runner', openBrowser: !values['no-browser'], log: (l) => log(`playerthree-run: ${l}`) });
  }
  seat = await connectSeat({
    url: url!,
    ...(signIn ? { signIn } : { token: token! }),
    clientName: 'playerthree-run',
    ...(values['expect-hash'] ? { expectHash: values['expect-hash'] } : {}),
    // Without a terminal or --yes there is nobody to ask: do not advertise elicitation (launching the runner is the consent).
    ...(values.yes || process.stdin.isTTY ? { elicit: askConsent } : {}),
  });
} catch (e) {
  if (e instanceof PlayerThreeSeatError || e instanceof SignInError) fail(`could not connect (${e.code})`, 1);
  throw e;
} finally {
  signIn?.close();
}

// A sign-in connection may command several roles.
const briefing = await seat.call('game_briefing', {});
const brief = briefing.structured as { game?: { title: string; doc: string }; commands?: { role: string }[] } | undefined;
const roles = (brief?.commands ?? []).map((c) => c.role);
if (!brief?.game) fail('game_briefing returned no game', 1);
if (roles.length === 0) fail('this connection commands no roles yet: grant it roles in the game, then run again', 1);

log(`playerthree-run: ${model} via ${providerName}, reasoning effort ${effortArg}, budget $${maxUsd.toFixed(2)}, ${seat.tools.length} tools, roles ${roles.join(', ')}, surfaceHash ${seat.surfaceHash}`);
const providerOpts = { model: model!, apiKey: apiKey!, system: systemPrompt(seat, brief!.game!), tools: llmTools(seat), maxOutputTokens, ...(reasoningEffort ? { reasoningEffort } : {}) };
const provider = providerName === 'openai' ? createOpenAiProvider(providerOpts) : createAnthropicProvider(providerOpts);
const budget = new Budget(maxUsd, price!);

try {
  const summary = await runAgent({
    seat,
    provider,
    budget,
    maxOutputTokens,
    log,
    signal: abort.signal,
    idleWaitSeconds,
    roles,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  });
  log(
    `playerthree-run: stopped (${summary.reason}); outcome ${summary.outcome}; ${summary.turns} turns, ${summary.toolCalls} tool calls; ` +
      `${summary.inputTokens} input + ${summary.outputTokens} output tokens = $${summary.spentUsd.toFixed(4)} of $${maxUsd.toFixed(2)}`,
  );
  process.exitCode = summary.reason === 'match_over' || summary.reason === 'aborted' || summary.reason === 'max_turns' ? 0 : 3;
} finally {
  await seat.close();
}
