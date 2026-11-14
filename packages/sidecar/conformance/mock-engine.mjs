#!/usr/bin/env node
// Copyright 2026 The PlayerThree authors. Licensed under the Apache License, Version 2.0 (see LICENSE).
//
// mock-engine: the engine side of the PlayerThree sidecar protocol (SPEC §20.8 (a)) for the Tug of War sample,
// in plain Node with no PlayerThree imports — exactly what a Unity, Unreal or Godot server does natively.
//
//   node mock-engine.mjs                      connect to $PLAYERTHREE_SIDECAR_SOCKET, or else spawn the sidecar (stdio)
//   node mock-engine.mjs -- <host command…>   spawn <host command> and speak on its stdin/stdout
//
// Flow: hello → createMatch → mintSeatToken (written to an owner-only file, never logged) → advance one tick every
// 100 ms until the `ended` push → dispose → close. Logs go to stderr.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINE_BYTES = 1_048_576;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const manifest = JSON.parse(readFileSync(here('./tug.manifest.json'), 'utf8'));
const log = (text) => process.stderr.write(`mock-engine: ${text}\n`);

// ------------------------------------------------------------------ transport

let input;
let output;
let child;
const dash = process.argv.indexOf('--');
if (dash !== -1) {
  const [cmd, ...args] = process.argv.slice(dash + 1);
  child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  ({ stdout: input, stdin: output } = child);
} else if (process.env.PLAYERTHREE_SIDECAR_SOCKET) {
  const socket = connect(process.env.PLAYERTHREE_SIDECAR_SOCKET);
  input = output = socket;
} else {
  // A checkout runs the TypeScript bin; the published package ships this file in dist/conformance beside dist/bin.
  const sidecar = [here('../bin/playerthree-sidecar.ts'), here('../bin/playerthree-sidecar.js')].find((p) => existsSync(p));
  child = spawn(process.execPath, [sidecar, '--stdio', '--port', '0'], { stdio: ['pipe', 'pipe', 'inherit'] });
  ({ stdout: input, stdin: output } = child);
}

// A host we spawned decides our exit status (a conformance runner exits 1 on failure).
child?.once('exit', (code) => process.exit(code ?? 1));

let closed = false;
function close(code) {
  if (closed) return;
  closed = true;
  if (code) output.write(`${JSON.stringify({ op: 'error', code })}\n`);
  output.end();
  input.destroy();
}
const send = (msg) => {
  if (!closed) output.write(`${JSON.stringify(msg)}\n`);
};

// Framing: one JSON object per line, at most MAX_LINE_BYTES bytes before the "\n".
let parts = [];
let size = 0;
input.on('data', (chunk) => {
  let start = 0;
  for (let nl = chunk.indexOf(10); nl !== -1 && !closed; nl = chunk.indexOf(10, start)) {
    if (size + nl - start > MAX_LINE_BYTES) return close('too_large');
    parts.push(chunk.subarray(start, nl));
    const line = Buffer.concat(parts).toString('utf8');
    parts = [];
    size = 0;
    start = nl + 1;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return close('bad_frame');
    }
    onMessage(msg);
  }
  if (closed || start >= chunk.length) return;
  size += chunk.length - start;
  if (size > MAX_LINE_BYTES) return close('too_large');
  parts.push(chunk.subarray(start));
});
input.on('end', () => {
  closed = true;
  output.end();
  for (const p of pending.values()) p.reject(new Error('host closed the connection'));
  pending.clear();
});
input.on('error', () => {});
output.on('error', () => {});

// ------------------------------------------------------------------ the game: README Tug of War

const sessions = new Map(); // session id → { tick, rope } for matches, { bot: true } for bots

function outcome(game, team) {
  if (Math.abs(game.rope) < 10) return 'running';
  return game.rope > 0 === (team === 'north') ? 'win' : 'loss';
}

const methods = {
  create: (_g, [opts], session) => {
    sessions.set(session, { tick: 0, rope: 0, seed: opts.seed });
    return { tick: 0 };
  },
  step: (g) => {
    g.tick += 1;
    return { tick: g.tick };
  },
  outcome: (g, [team]) => outcome(g, team),
  view: (g) => ({ rope: g.rope }),
  observe: (g) => ({ tick: g.tick, rope: g.rope }),
  apply: (g, [seat, intent]) => {
    if (intent.kind !== 'pull') return { ok: false, code: 'tired' };
    g.rope = Math.max(-10, Math.min(10, g.rope + (seat.team === 'north' ? intent.strength : -intent.strength)));
    return { ok: true };
  },
  report: (g, [team]) => ({ outcome: outcome(g, team) }),
  events: () => [],
  setSeatInfo: () => null,
  createBot: (_g, [seat], session) => {
    sessions.set(session, { bot: true, seat });
    return null;
  },
  init: () => null,
  think: () => [{ kind: 'pull', strength: 1 }],
  dispose: (_g, _args, session) => {
    sessions.delete(session);
    return null;
  },
};
// Calls that open a new session instead of addressing an existing one.
const OPENS = new Set(['create', 'createBot']);

function answer(msg) {
  const { id, session, method, args } = msg;
  const fail = (code, message) => send({ op: 'result', id, ok: false, code, message });
  if (!Object.hasOwn(methods, method)) return fail('unknown_method', `no method ${method}`);
  const game = sessions.get(session);
  if (!OPENS.has(method) && game === undefined) return fail('unknown_session', `no session ${session}`);
  if (OPENS.has(method) && game !== undefined) return fail('invalid', `session ${session} exists`);
  try {
    send({ op: 'result', id, ok: true, data: methods[method](game, args, session) });
  } catch (e) {
    fail('engine_error', String(e?.message ?? e));
  }
}

// ------------------------------------------------------------------ protocol

let nextId = 0;
const pending = new Map(); // engine request id → { resolve, reject }
let ready;
const readyPromise = new Promise((resolve, reject) => (ready = { resolve, reject }));
const ended = new Set();

function request(msg) {
  const id = ++nextId;
  const { promise, resolve, reject } = Promise.withResolvers();
  pending.set(id, { resolve, reject });
  send({ ...msg, id });
  return promise;
}
const host = async (method, ...args) => {
  const r = await request({ op: 'host', method, args });
  if (!r.ok) throw new Error(`host ${method} failed: ${r.code}`);
  return r.data;
};

function onMessage(msg) {
  switch (msg.op) {
    case 'call':
      return answer(msg);
    case 'result': {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      return p?.resolve(msg);
    }
    case 'ready':
      return ready.resolve(msg);
    case 'push':
      if (msg.kind === 'ended') ended.add(msg.session);
      return;
    case 'error':
      log(`host closed with ${msg.code}${msg.message ? `: ${msg.message}` : ''}`);
      return ready.reject(new Error(msg.code));
    default:
  }
}

async function run() {
  send({ op: 'hello', protocol: 1, manifest, hooks: [] });
  const { surfaceHash, mcp } = await readyPromise;
  log(`ready, surfaceHash ${surfaceHash}`);
  const { session } = await host('createMatch', { seed: 1, controllers: { north: { puller: 'agent' }, south: { puller: 'bot' } }, botLevel: { south: 'easy' } });
  const { token } = await host('mintSeatToken', session, 'north', 'puller');
  // Seat tokens are never logged: hand it over in a file only this OS user can read.
  const dir = mkdtempSync(join(tmpdir(), 'playerthree-tug-'));
  const tokenFile = join(dir, 'north-puller.token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  log(`match ${session}: attach your agent to north/puller with`);
  log(`  claude mcp add --transport http tug ${mcp} --header "Authorization: Bearer $(cat ${tokenFile})"`);
  while (!ended.has(session)) {
    await new Promise((r) => setTimeout(r, 1000 / manifest.tickRate));
    const r = await request({ op: 'advance', session, n: 1 });
    if (!r.ok) log(`advance failed: ${r.code}`);
  }
  await host('dispose', session);
  log('match over, closing');
  close();
}

run().catch((e) => {
  log(e.message);
  close();
  process.exitCode = 1;
});
