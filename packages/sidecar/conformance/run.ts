#!/usr/bin/env node
/**
 * Sidecar conformance runner: the real sidecar host plus checks, driving one engine through the Tug of War sample.
 *
 *   node run.ts --stdio                       the engine spawned this process in place of playerthree-sidecar
 *   node run.ts --socket -- <engine cmd…>     spawn the engine with PLAYERTHREE_SIDECAR_SOCKET set
 *
 * Options: --transcript <file> (default tug.transcript.jsonl next to this file), --record <file> (write the
 * normalized transcript instead of comparing), --timeout <s> (default 60). Verdict on stderr; exit 0 pass, 1 fail.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { canonicalJson, surfaceHash, defineManifest, type AnyManifest } from 'playerthree';
import { MAX_LINE_BYTES, member, serveSidecar, SidecarCallError, SOCKET_ENV, type Msg, type ServedSidecar, type Transport } from '../src/index.ts';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const err = (t: string): void => void process.stderr.write(`${t}\n`);

/** What every engine's Tug sample sends in its `createMatch`. */
export const TUG_CREATE = { seed: 1, controllers: { north: { puller: 'agent' }, south: { puller: 'bot' } }, botLevel: { south: 'easy' } };
/**
 * The agent pulls 3 on each of the first AGENT_ACTS ticks while the south bot pulls 1 every tick: the rope goes
 * 2, 4, 6, then back one per tick until south wins at -10 (the agent applies at once, the bot on the tick).
 */
const AGENT_PULL = 3;
const AGENT_ACTS = 3;
const EXPECTED_ROPES = [2, 4, 6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6, -7, -8, -9, -10];
const MAX_CYCLES = 40;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceOptions {
  transport: Transport;
  /** Expected normalized transcript lines; omitted = no comparison. */
  expected?: string[];
  timeoutMs?: number;
  /** Starts the engine once the sidecar listens (socket mode). */
  launch?: () => ChildProcess | undefined;
}

export interface ConformanceReport {
  ok: boolean;
  checks: CheckResult[];
  /** The normalized transcript of this run, one canonical JSON message per line. */
  transcript: string[];
}

class Timeout extends Error {}

/**
 * Normalizes a recorded exchange so runs compare: ids renumbered by order per id space, tokens and the MCP URL
 * redacted, free-text messages dropped, host pushes and GC-driven bot disposal (timing-dependent) left out.
 */
export function normalize(records: { dir: 'in' | 'out'; msg: Msg }[]): string[] {
  const hostIds = new Map<number, number>();
  const engineIds = new Map<number, number>();
  const dropped = new Set<number>();
  const renumber = (ids: Map<number, number>, id: unknown): unknown => {
    if (typeof id !== 'number') return id;
    if (!ids.has(id)) ids.set(id, ids.size + 1);
    return ids.get(id);
  };
  const lines: string[] = [];
  for (const { dir, msg } of records) {
    const m: Msg = { ...msg };
    delete m.message;
    if (m.op === 'push' || m.op === 'raw') continue;
    if (m.op === 'call') {
      if (m.method === 'dispose' && typeof m.session === 'string' && m.session.startsWith('b')) {
        dropped.add(m.id as number);
        continue;
      }
      m.id = renumber(hostIds, m.id);
      if (typeof m.pad === 'string') m.pad = m.pad.length;
    } else if (m.op === 'result' && dir === 'in') {
      if (dropped.has(m.id as number)) continue;
      m.id = renumber(hostIds, m.id);
    } else if (m.op === 'result') {
      m.id = renumber(engineIds, m.id);
      if (typeof member(m.data, 'token') === 'string') m.data = { ...(m.data as object), token: '<token>' };
    } else if (m.op === 'host' || m.op === 'advance') {
      m.id = renumber(engineIds, m.id);
    } else if (m.op === 'ready' && typeof m.mcp === 'string') {
      m.mcp = '<mcp>';
    }
    lines.push(canonicalJson({ from: dir === 'in' ? 'engine' : 'host', ...m }));
  }
  return lines;
}

interface Held {
  msg: Msg;
  release: () => void;
}

/** Runs the Tug of War conformance scenario against one engine connection. */
export async function runConformance(opts: ConformanceOptions): Promise<ConformanceReport> {
  const checks: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail?: string): boolean => {
    checks.push(detail === undefined || ok ? { name, ok } : { name, ok, detail });
    return ok;
  };
  const records: { dir: 'in' | 'out'; msg: Msg }[] = [];
  const held: Held[] = [];
  let wake: (() => void) | undefined;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const within = async <T>(what: string, p: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout(`timed out waiting for ${what}`)), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([p, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  // Every engine request waits here until the scenario releases it: the order of engine ticks and agent calls is fixed.
  const next = async (what: string): Promise<Held> => {
    while (held.length === 0) {
      if (served.sidecar.link.isClosed) throw new Timeout(`engine closed the connection while the runner waited for ${what}`);
      const woken = Promise.withResolvers<void>();
      wake = woken.resolve;
      await within(what, Promise.race([woken.promise, served.sidecar.closed.then(() => {})]));
    }
    return held.shift()!;
  };

  const served: ServedSidecar = await serveSidecar({
    transport: opts.transport,
    port: 0,
    tap: (dir, msg) => records.push({ dir, msg }),
    gate: (msg) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      held.push({ msg, release: resolve });
      wake?.();
      return promise;
    },
  });
  const engine = opts.launch?.();
  let client: Client | undefined;
  try {
    const expectedHash = surfaceHash(defineManifest(JSON.parse(readFileSync(here('./tug.manifest.json'), 'utf8')) as AnyManifest));
    const host = await within('hello', served.sidecar.ready);
    check('hello: the Tug of War manifest (surfaceHash)', surfaceHash(host.definition.manifest) === expectedHash, `got ${surfaceHash(host.definition.manifest)}`);

    const create = await next('createMatch');
    check('createMatch request', create.msg.op === 'host' && create.msg.method === 'createMatch' && canonicalJson(create.msg.args) === canonicalJson([TUG_CREATE]), canonicalJson(create.msg));
    create.release();
    const mint = await next('mintSeatToken');
    const mintArgs = Array.isArray(mint.msg.args) ? mint.msg.args : [];
    const session = mintArgs[0];
    check('mintSeatToken request', mint.msg.method === 'mintSeatToken' && typeof session === 'string' && canonicalJson(mintArgs.slice(1)) === canonicalJson(['north', 'puller']), canonicalJson(mint.msg));
    mint.release();
    if (typeof session !== 'string') throw new Error('no session to play');

    let pending = await next('the first advance');
    check('advance request', pending.msg.op === 'advance' && pending.msg.session === session && pending.msg.n === 1, canonicalJson(pending.msg));

    // Error cases and the line limit, while the engine waits on its advance (it must keep answering calls).
    const link = served.sidecar.link;
    const codeOf = (fn: () => unknown): string => {
      try {
        return `ok:${canonicalJson(fn())}`;
      } catch (e) {
        return e instanceof SidecarCallError ? e.code : String(e);
      }
    };
    const unknownMethod = codeOf(() => link.call(session, 'noSuchMethod', []));
    check('unknown method → ok:false unknown_method', unknownMethod === 'unknown_method', unknownMethod);
    const unknownSession = codeOf(() => link.call('s999', 'outcome', ['north']));
    check('unknown session → ok:false unknown_session', unknownSession === 'unknown_session', unknownSession);
    const padded = codeOf(() => link.callPadded(session, 'outcome', ['north'], MAX_LINE_BYTES));
    check(`a ${MAX_LINE_BYTES}-byte call is answered`, padded === 'ok:"running"', padded);

    // An MCP agent takes the north seat, observes and acts; the engine applies its pulls and the bot's.
    const seatToken = records.map((r) => (r.dir === 'out' && r.msg.op === 'result' ? member(r.msg.data, 'token') : undefined)).findLast((t) => typeof t === 'string');
    if (typeof seatToken !== 'string') throw new Error('no seat token was minted');
    client = new Client({ name: 'playerthree-sidecar-conformance', version: '1' });
    await within('the MCP connection', client.connect(new StreamableHTTPClientTransport(new URL(served.mcpUrl), { authProvider: { token: async () => seatToken } })));
    const tool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const r = await within(name, client!.callTool({ name, arguments: args }));
      if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
      return r.structuredContent as Record<string, unknown>;
    };
    const rope = async (): Promise<unknown> => {
      const observed = await tool('game_observe', {});
      return member(observed.observation, 'rope') ?? observed.rope;
    };
    check('agent observes the start (rope 0)', (await rope()) === 0);
    const ropes: unknown[] = [];
    let dispose: Held | undefined;
    for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
      if (cycle < AGENT_ACTS) {
        const acted = await tool('game_act', { intents: [{ kind: 'pull', strength: AGENT_PULL }] });
        const acks = acted.acks;
        if (!check(`act ${cycle + 1} accepted`, Array.isArray(acks) && member(acks[0], 'ok') === true, JSON.stringify(acted))) break;
      }
      pending.release();
      const following = await next('the next engine request');
      ropes.push(await rope());
      if (following.msg.op === 'host' && following.msg.method === 'dispose') {
        dispose = following;
        break;
      }
      pending = following;
    }
    check('the engine applies the agent and bot pulls tick by tick', canonicalJson(ropes) === canonicalJson(EXPECTED_ROPES), canonicalJson(ropes));
    const ended = records.find((r) => r.msg.op === 'push' && r.msg.kind === 'ended' && r.msg.session === session)?.msg.data;
    check('match ends: south wins', canonicalJson(member(ended, 'outcomes')) === canonicalJson({ north: 'loss', south: 'win' }), canonicalJson(ended));
    if (!check('engine disposes its match after the end', dispose !== undefined && canonicalJson(dispose.msg.args) === canonicalJson([session]), dispose && canonicalJson(dispose.msg))) {
      throw new Error('no dispose');
    }

    // Oversized line while the engine waits on its dispose: it must close the connection.
    const before = records.length;
    const probe = `{"op":"call","id":999999,"session":${JSON.stringify(session)},"method":"outcome","args":["north"],"pad":"`;
    link.sendRawLine(`${probe}${'x'.repeat(MAX_LINE_BYTES + 1 - probe.length - 2)}"}`);
    const closed = await within('the engine to close after an oversized line', served.sidecar.closed).then(() => true, () => false);
    const after = records.slice(before + 1).filter((r) => r.dir === 'in');
    check(`a ${MAX_LINE_BYTES + 1}-byte line makes the engine close the connection`, closed && after.every((r) => r.msg.op === 'error' && r.msg.code === 'too_large'), canonicalJson(after.map((r) => r.msg)));
  } catch (e) {
    check('scenario completed', false, e instanceof Error ? e.message : String(e));
  } finally {
    await client?.close().catch(() => {});
    await served.close();
    if (engine && engine.exitCode === null) {
      const exited = new Promise((r) => engine.once('exit', r));
      const kill = setTimeout(() => engine.kill(), 3000);
      await exited;
      clearTimeout(kill);
    }
  }
  const transcript = normalize(records);
  if (opts.expected) {
    const at = transcript.findIndex((line, i) => line !== opts.expected![i]);
    const same = at === -1 && transcript.length === opts.expected.length;
    const index = at === -1 ? Math.min(transcript.length, opts.expected.length) : at;
    check(
      'transcript matches tug.transcript.jsonl',
      same,
      `first difference at message ${index + 1}:\n  expected ${opts.expected[index]?.slice(0, 400) ?? '(end)'}\n  actual   ${transcript[index]?.slice(0, 400) ?? '(end)'}`,
    );
  }
  return { ok: checks.every((c) => c.ok), checks, transcript };
}

async function cli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { stdio: { type: 'boolean' }, socket: { type: 'boolean' }, transcript: { type: 'string' }, record: { type: 'string' }, timeout: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  if (values.stdio === values.socket || (values.socket === true) !== positionals.length > 0) {
    err('usage: run.ts --stdio | run.ts --socket -- <engine command…>  [--transcript file] [--record file] [--timeout s]');
    return 2;
  }
  const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
  // A Windows checkout with core.autocrlf turns the fixture's line ends into CRLF; the wire lines themselves never carry \r.
  const expected = values.record !== undefined ? undefined : readFileSync(values.transcript ?? here('./tug.transcript.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l !== '');
  let dir: string | undefined;
  let transport: Transport = { kind: 'stdio' };
  let launch: (() => ChildProcess) | undefined;
  if (values.socket) {
    let path: string;
    if (process.platform === 'win32') path = `\\\\.\\pipe\\playerthree-conformance-${randomBytes(8).toString('hex')}`;
    else {
      dir = mkdtempSync(join(tmpdir(), 'p3-conformance-'));
      path = join(dir, 'engine.sock');
    }
    transport = { kind: 'socket', path };
    const [cmd, ...args] = positionals;
    // The engine's stdout is not ours to speak on; keep it with stderr.
    launch = () => spawn(cmd!, args, { stdio: ['ignore', 2, 2], env: { ...process.env, [SOCKET_ENV]: path } });
  }
  try {
    const report = await runConformance({ transport, ...(expected ? { expected } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(launch ? { launch } : {}) });
    for (const c of report.checks) err(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail !== undefined ? `\n      ${c.detail}` : ''}`);
    if (values.record !== undefined) {
      writeFileSync(values.record, `${report.transcript.join('\n')}\n`);
      err(`recorded ${report.transcript.length} messages to ${values.record}`);
    }
    err(report.ok ? 'conformance: PASS' : 'conformance: FAIL');
    return report.ok ? 0 : 1;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// realpath: under pnpm (or any symlinked node_modules) argv[1] is the link, import.meta.url the target.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await cli(process.argv.slice(2));
