import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definition } from '../../playerthree/examples/tag/index.ts';
import { quadDefinition } from '../../playerthree/test/quad-fixture.ts';
import { startDevServer, type DevServer } from '../src/index.ts';
import { createDevtoolsHandler, createPlayerApiHandler, mountDevtools, type DevtoolsHandler, type DevtoolsOptions } from 'playerthree/devtools';
import { createPlayerThreeHost, replayMatch } from 'playerthree/host';
import type { PlayerThreeHost, PlayerThreeMatch, PlayerThreeTraceEvent, Replay, ReplayEntry, SeatInfo } from 'playerthree/host';
import { createAuthorizationServer, type ConnectionStore, type StoredConnection } from 'playerthree/mcp';
import { t } from 'playerthree/schema';
import type { MatchSpec, ResultChunk, ResultsEnvelope, StoredResultChunk, StoredSeries } from 'playerthree/arena';
import { exportMatchSpec, exportStoredResults } from 'playerthree/results';

interface Rig {
  server: Server;
  host: PlayerThreeHost;
  match: PlayerThreeMatch;
  base: string;
  close(): Promise<void>;
}

async function rig(opts: DevtoolsOptions = {}, host: PlayerThreeHost = createPlayerThreeHost({ definition })): Promise<Rig> {
  const player = createPlayerApiHandler(host);
  const server = createServer((req, res) => {
    void player.handle(req, res).then((handled) => {
      if (handled) return;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('game server');
    });
  });
  const devtools = mountDevtools(server, host, { path: '/playerthree/devtools', ...opts });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const match = host.createMatch({ seed: 5, realtime: false, controllers: { blue: { runner: 'agent' } } });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    host,
    match,
    base,
    async close() {
      devtools.close();
      player.close();
      host.dispose();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const o of open) await o.close();
  open = [];
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const teamOf = (e: PlayerThreeTraceEvent): string | undefined => ('team' in e ? e.team : undefined);
const API = '/playerthree/devtools/api';
const LOCAL_ORIGIN = { origin: 'http://localhost:5173' };
const OPERATOR_TOKEN = 'operator-secret-0123456789-abcdefghijklmnop';

interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  text: string;
  json<T = Record<string, unknown>>(): T;
}

/** Raw node:http request (fetch cannot set Host and adds no browser headers, so every header here is explicit). */
function call(base: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  const url = new URL(path, base);
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  const headers = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers };
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const req = request(url, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode!, headers: res.headers, text, json: <T>() => JSON.parse(text) as T });
    });
  });
  req.on('error', reject);
  req.end(body);
  return promise;
}

/** A local browser POST: loopback Origin + same-origin fetch metadata. */
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(base, path, { body, headers: { ...LOCAL_ORIGIN, 'sec-fetch-site': 'same-origin', ...headers } });

/** Shape of the session state used by these tests (the server builds it from SeatInfo and PlayerThreeTraceEvent). */
interface SessionState {
  session: string;
  status: string;
  seats: SeatInfo[];
  observations: Record<string, { data: { team: string } } | undefined>;
  events: PlayerThreeTraceEvent[];
}
interface PlayerState {
  team: string;
  seats: SeatInfo[];
  observations: Record<string, { data: { team: string } } | undefined>;
  events: PlayerThreeTraceEvent[];
}
interface Frame {
  event: string;
  data: PlayerThreeTraceEvent;
}
interface ScrubFrame {
  tick: number;
  data: unknown;
  entries: ReplayEntry[];
  events: PlayerThreeTraceEvent[];
}

async function scrub(base: string, source: string, tick: number, perspective: string): Promise<ScrubFrame> {
  const r = await call(base, `${API}/${source}/scrub?tick=${tick}&perspective=${encodeURIComponent(perspective)}`);
  expect(r.status).toBe(200);
  return r.json<ScrubFrame>();
}

async function playerState(base: string, token: string): Promise<PlayerState> {
  return (await call(base, '/playerthree/player/state', { headers: bearer(token) })).json<PlayerState>();
}

/**
 * Read SSE frames while `during` runs, then for `ms` more. A real delay is needed: the server coalesces observations
 * on a 250 ms wall-clock pump, which is exactly what the stream test exercises.
 */
async function readStream(url: string, headers: Record<string, string>, ms: number, during: () => Promise<void>): Promise<Frame[]> {
  const ctl = new AbortController();
  const res = await fetch(url, { headers, signal: ctl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
  const frames: Frame[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message';
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (data) frames.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  await during();
  await new Promise((r) => setTimeout(r, ms));
  ctl.abort();
  await pump;
  return frames;
}

/** Calls the handler with a fake request from `remoteAddress` (tests cannot open sockets from other addresses). */
async function fake(
  handler: DevtoolsHandler,
  init: { url: string; remoteAddress: string; headers?: Record<string, string>; method?: string; encrypted?: boolean },
): Promise<{ status: number; body: string }> {
  const writeHead = vi.fn();
  const end = vi.fn();
  await handler.handle({
    method: init.method ?? 'GET', url: init.url, headers: init.headers ?? {},
    socket: { remoteAddress: init.remoteAddress, ...(init.encrypted ? { encrypted: true } : {}) },
  } as unknown as IncomingMessage, { writeHead, end, headersSent: false } as unknown as ServerResponse);
  return { status: writeHead.mock.calls[0]?.[0] as number, body: String(end.mock.calls[0]?.[0] ?? '') };
}

describe('operator console: page and access', () => {
  it('serves a self-contained page with a strict CSP and the access mode, and passes other requests through', async () => {
    const r = await rig();
    open.push(r);
    const page = await call(r.base, '/playerthree/devtools', { headers: { host: 'localhost' } });
    expect(page.status).toBe(200);
    const csp = String(page.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(page.text).toContain(`<script nonce="${nonce}">`);
    expect(page.text).not.toMatch(/(src|href)=["']https?:/);
    for (const placeholder of ['__NONCE__', '__MODE__', '__BASE__']) expect(page.text).not.toContain(placeholder);
    expect(page.text).toContain("'local'");
    expect((await call(r.base, '/somewhere/else')).text).toBe('game server');
  });

  it('local mode: direct loopback with a localhost Host only; rejects proxies, foreign hosts and cross-site requests', async () => {
    const r = await rig();
    open.push(r);
    expect((await call(r.base, `${API}/overview`)).status).toBe(200);
    expect((await call(r.base, `${API}/overview`, { headers: { host: 'localhost:2567', ...LOCAL_ORIGIN, 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect((await call(r.base, `${API}/overview`, { headers: { host: '[::1]:2567' } })).status).toBe(200);
    for (const header of ['forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) {
      const denied = await call(r.base, `${API}/overview`, { headers: { [header]: '127.0.0.1' } });
      expect(denied.status).toBe(403);
      expect(denied.json()).toMatchObject({ error: 'loopback_only' });
    }
    // DNS rebinding: a hostile domain resolving to 127.0.0.1 reaches us with its own Host.
    for (const host of ['evil.example', 'evil.example:2567', 'localhost.evil.example', '127.0.0.1.nip.io']) {
      const denied = await call(r.base, `${API}/overview`, { headers: { host } });
      expect(denied.status).toBe(403);
      expect(denied.json()).toMatchObject({ error: 'forbidden_host' });
      expect((await call(r.base, '/playerthree/devtools', { headers: { host } })).status).toBe(403);
    }
    // Cross-site reads and writes (CSRF): foreign Origin, cross-site fetch metadata, `null` origin.
    const crossSite: Record<string, string>[] = [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }];
    for (const headers of crossSite) {
      const read = await call(r.base, `${API}/sessions`, { headers });
      expect(read.status).toBe(403);
      expect(read.json()).toMatchObject({ error: 'forbidden_origin' });
      expect((await call(r.base, `${API}/sessions/${r.match.id}/end`, { body: { outcomes: 'draw' }, headers })).status).toBe(403);
    }
    // Writes need an Origin or fetch metadata, and a JSON body.
    expect((await call(r.base, `${API}/sessions/${r.match.id}/end`, { body: { outcomes: 'draw' } })).json()).toMatchObject({ error: 'forbidden_origin' });
    const form = await post(r.base, `${API}/sessions/${r.match.id}/end`, 'outcomes=draw', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
    expect(r.match.over).toBe(false);
    // Another machine.
    const handler = createDevtoolsHandler(r.host);
    try {
      expect(await fake(handler, { url: `${API}/overview`, remoteAddress: '192.168.1.2', headers: { host: 'localhost' } })).toMatchObject({ status: 403 });
      expect(await fake(handler, { url: `${API}/overview`, remoteAddress: '::ffff:127.0.0.1', headers: { host: 'localhost' } })).toMatchObject({ status: 200 });
    } finally { handler.close(); }
  });

  it('never accepts player credentials as operator access', async () => {
    const r = await rig({ operatorToken: OPERATOR_TOKEN });
    open.push(r);
    r.host.commanders.ensure('owner-alice');
    const commander = r.host.commanders.create('owner-alice', { name: 'Alice', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    for (const token of [
      r.match.tokens.teams.blue!, r.match.tokens.spectator, r.match.mintSeatToken('blue', 'runner'), r.host.commanders.token('owner-alice', commander),
    ]) {
      const denied = await call(r.base, `${API}/overview`, { headers: bearer(token) });
      expect(denied.status).toBe(401);
      expect(denied.json()).toMatchObject({ error: 'unauthorized' });
    }
  });

  it('token mode: Bearer only, constant-time match, HTTPS or loopback, misconfiguration fails at mount', async () => {
    const host = createPlayerThreeHost({ definition });
    expect(() => createDevtoolsHandler(host, { operatorToken: 'short' })).toThrow(/operatorToken/);
    expect(() => createDevtoolsHandler(host, { operatorToken: `${'x'.repeat(40)} y` })).toThrow(/operatorToken/);
    expect(() => createDevtoolsHandler(host, { operatorToken: OPERATOR_TOKEN, authorize: () => true })).toThrow(/not both/);
    expect(() => createDevtoolsHandler(host, { authorize: 'yes' as never })).toThrow(/authorize/);
    host.dispose();

    const r = await rig({ operatorToken: OPERATOR_TOKEN });
    open.push(r);
    const page = await call(r.base, '/playerthree/devtools');
    expect(page.status).toBe(200);
    expect(page.text).toContain("'token'");
    expect(page.text).not.toContain(OPERATOR_TOKEN);
    expect((await call(r.base, `${API}/overview`)).status).toBe(401);
    expect((await call(r.base, `${API}/overview`, { headers: bearer(`${OPERATOR_TOKEN}x`) })).status).toBe(401);
    expect((await call(r.base, `${API}/overview?token=${OPERATOR_TOKEN}`)).status).toBe(401);
    const ok = await call(r.base, `${API}/overview`, { headers: bearer(OPERATOR_TOKEN) });
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ access: 'token' });
    // No Origin needed with a bearer token (not ambient), but a JSON body is.
    expect((await call(r.base, `${API}/sessions/${r.match.id}/end`, { body: 'x', headers: { ...bearer(OPERATOR_TOKEN), 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await call(r.base, `${API}/sessions/${r.match.id}/end`, { body: { outcomes: 'draw' }, headers: bearer(OPERATOR_TOKEN) })).status).toBe(200);
    expect((await call(r.base, `${API}/overview`, { headers: { ...bearer(OPERATOR_TOKEN), 'sec-fetch-site': 'cross-site' } })).status).toBe(403);

    const handler = createDevtoolsHandler(r.host, { operatorToken: OPERATOR_TOKEN });
    try {
      const remote = { url: `${API}/overview`, remoteAddress: '203.0.113.9', headers: bearer(OPERATOR_TOKEN) };
      expect(await fake(handler, remote)).toMatchObject({ status: 403, body: expect.stringContaining('https_required') });
      // Through a proxy on the same machine without TLS: still plain http.
      expect(await fake(handler, { ...remote, remoteAddress: '127.0.0.1', headers: { ...bearer(OPERATOR_TOKEN), 'x-forwarded-for': '203.0.113.9' } })).toMatchObject({ status: 403 });
      expect(await fake(handler, { ...remote, headers: { ...bearer(OPERATOR_TOKEN), 'x-forwarded-proto': 'https' } })).toMatchObject({ status: 200 });
      expect(await fake(handler, { ...remote, encrypted: true })).toMatchObject({ status: 200 });
      expect(await fake(handler, { ...remote, encrypted: true, headers: bearer('nope') })).toMatchObject({ status: 401 });
    } finally { handler.close(); }
  });

  it('authorize mode: the host hook decides; ambient credentials still need a same-origin request', async () => {
    const seen: string[] = [];
    const r = await rig({
      authorize: async (req) => {
        seen.push(req.url ?? '');
        return req.headers.cookie === 'admin=1';
      },
    });
    open.push(r);
    expect((await call(r.base, '/playerthree/devtools')).status).toBe(403);
    expect((await call(r.base, `${API}/overview`)).json()).toMatchObject({ error: 'forbidden' });
    const admin = { cookie: 'admin=1', host: 'game.example' };
    expect((await call(r.base, `${API}/overview`, { headers: admin })).json()).toMatchObject({ access: 'authorize' });
    expect(seen).toContain(`${API}/overview`);
    const end = `${API}/sessions/${r.match.id}/end`;
    expect((await call(r.base, end, { body: { outcomes: 'draw' }, headers: { ...admin, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call(r.base, end, { body: { outcomes: 'draw' }, headers: { ...admin, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await call(r.base, end, { body: { outcomes: 'draw' }, headers: admin })).status).toBe(403);
    expect(r.match.over).toBe(false);
    expect((await call(r.base, end, { body: { outcomes: 'draw' }, headers: { ...admin, origin: 'https://game.example', 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    const failing = await rig({ authorize: () => { throw new Error('session store down'); } });
    open.push(failing);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call(failing.base, `${API}/overview`)).status).toBe(500);
    errors.mockRestore();
  });
});

describe('operator console: overview and sessions', () => {
  it('summarizes the game, sessions, active agents and recent agent rejections', async () => {
    const r = await rig();
    open.push(r);
    const control = r.host.seatControl(r.match.mintSeatToken('blue', 'runner'))!;
    await control.act([{ kind: 'move', x: 99, y: 0 }]);
    await r.match.step(10);
    const o = (await call(r.base, `${API}/overview`)).json<{
      game: { id: string; surfaceHash: string; modes: string[] };
      sessions: { live: number; ended: number };
      agents: { activeNow: number; connections: number | null };
      window: { minutes: number; rejections: number; codes: { code: string; count: number }[]; recent: { session: string; role: string; code: string }[] };
    }>();
    expect(o.game).toMatchObject({ id: definition.manifest.id, surfaceHash: expect.stringMatching(/^[0-9a-f]{16,}$/) });
    expect(o.game.modes).toContain('intents');
    expect(o.sessions).toEqual({ live: 1, ended: 0, recent: 0 });
    expect(o.agents).toMatchObject({ activeNow: 1, connections: null });
    expect(o.window).toMatchObject({ minutes: 15, rejections: 1, codes: [{ code: 'invalid:range', count: 1 }] });
    expect(o.window.recent[0]).toMatchObject({ session: r.match.id, role: 'runner', code: 'invalid:range' });
  });

  it('lists sessions and serves state, god/side/seat perspectives and an all-sides stream', async () => {
    const r = await rig();
    open.push(r);
    const list = (await call(r.base, `${API}/sessions`)).json<{ sessions: { id: string; status: string; createdAt: number | null }[] }>();
    expect(list.sessions).toEqual([expect.objectContaining({ id: r.match.id, status: 'running', createdAt: expect.any(Number) })]);
    const root = `${API}/sessions/${r.match.id}`;
    expect((await call(r.base, `${root}/view`)).json()).toMatchObject({ data: null });
    await r.match.seat('blue', 'runner').observe();
    await r.match.seat('red', 'runner').observe();
    await r.match.step(20);
    const all = (await call(r.base, `${root}/state`)).json<SessionState>();
    expect(all).toMatchObject({ session: r.match.id, status: 'running' });
    expect(new Set(all.seats.map((s) => s.team))).toEqual(new Set(['blue', 'red']));
    expect(all.observations['blue/runner']?.data.team).toBe('blue');
    expect(all.observations['red/runner']?.data.team).toBe('red');
    expect(all.events.some((e) => teamOf(e) === 'red')).toBe(true);
    for (const team of ['blue', 'red']) {
      expect((await call(r.base, `${root}/view?perspective=side:${team}`)).json()).toMatchObject({ data: r.match.view(team) });
      expect((await call(r.base, `${root}/view?perspective=seat:${team}/runner`)).json()).toMatchObject({ observation: { team, role: 'runner' } });
    }
    expect((await call(r.base, `${root}/view?perspective=side:unknown`)).status).toBe(400);
    expect((await call(r.base, `${API}/sessions/nope/state`)).json()).toMatchObject({ error: 'session_not_found' });
    expect((await call(r.base, `${API}/nope`)).status).toBe(404);
    expect((await call(r.base, `${root}/state`, { method: 'POST', body: {}, headers: LOCAL_ORIGIN })).status).toBe(405);
    const frames = await readStream(`${r.base}${root}/stream`, {}, 300, async () => {
      await r.match.seat('blue', 'runner').observe();
      await r.match.seat('red', 'runner').observe();
      await r.match.step(20);
    });
    expect(frames[0]).toMatchObject({ event: 'status', data: { status: 'running' } });
    const traces = frames.filter((f) => f.event === 'trace').map((f) => f.data);
    expect(new Set(traces.map(teamOf).filter(Boolean))).toEqual(new Set(['blue', 'red']));
  });

  it('ends a session with a winner or a draw, once', async () => {
    const r = await rig();
    open.push(r);
    const ended: unknown[] = [];
    r.match.onEnd((o) => ended.push(o));
    const end = `${API}/sessions/${r.match.id}/end`;
    for (const outcomes of [undefined, 'win', { blue: 'win' }, { blue: 'win', red: 'running' }, { blue: 'win', red: 'loss', green: 'loss' }]) {
      expect((await post(r.base, end, { outcomes })).json()).toMatchObject({ error: 'invalid' });
    }
    const done = await post(r.base, end, { outcomes: { blue: 'win', red: 'loss' } });
    expect(done.json()).toEqual({ id: r.match.id, tick: 0, status: 'ended', outcomes: { blue: 'win', red: 'loss' }, ranks: { blue: 1, red: 2 } });
    expect(ended).toEqual([{ blue: 'win', red: 'loss' }]);
    expect(r.match.outcome('blue')).toBe('win');
    expect(r.match.replay().outcomes).toEqual({ blue: 'win', red: 'loss' });
    const again = await post(r.base, end, { outcomes: 'draw' });
    expect(again.status).toBe(409);
    expect(again.json()).toMatchObject({ error: 'session_over' });
    const list = (await call(r.base, `${API}/sessions`)).json<{ sessions: { status: string; endedAt: number | null }[] }>();
    expect(list.sessions[0]).toMatchObject({ status: 'ended', endedAt: expect.any(Number) });
    const draw = r.host.createMatch({ realtime: false });
    expect((await post(r.base, `${API}/sessions/${draw.id}/end`, { outcomes: 'draw' })).json()).toMatchObject({ outcomes: { blue: 'draw', red: 'draw' } });
  });

  it('serves a subset match with its own teams and alliances, and ends it by alliance', async () => {
    // Own server: `rig` seats a tag `blue` agent, which this four-team game does not have.
    const host = createPlayerThreeHost({ definition: quadDefinition });
    const server = createServer((_req, res) => res.end());
    const devtools = mountDevtools(server, host, { path: '/playerthree/devtools' });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    const r = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    open.push({
      async close() {
        devtools.close();
        host.dispose();
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        await closed.promise;
      },
    });
    const m = host.createMatch({ realtime: false, teams: ['north', 'east', 'south'], alliances: { cold: ['north', 'east'], south: ['south'] } });
    const summary = () => call(r.base, `${API}/sessions`).then((x) => x.json<{ sessions: Record<string, unknown>[] }>().sessions.find((s) => s.id === m.id));
    expect(await summary()).toMatchObject({
      teams: ['north', 'east', 'south'], alliances: { cold: ['north', 'east'], south: ['south'] },
      outcomes: { north: 'running', east: 'running', south: 'running' }, ranks: null,
    });
    expect((await call(r.base, `${API}/sessions/${m.id}/view?perspective=side:west`)).status).toBe(400);
    expect((await call(r.base, `${API}/sessions/${m.id}/view?perspective=side:east`)).status).toBe(200);
    const end = `${API}/sessions/${m.id}/end`;
    const bad = await post(r.base, end, { outcomes: { north: 'win', east: 'loss', south: 'loss' } });
    expect(bad.status).toBe(400);
    expect(bad.json<{ message: string }>().message).toContain('(north, east, south, cold)');
    expect((await post(r.base, end, { outcomes: { cold: 'win', south: 'win', west: 'loss' } })).status).toBe(400);
    const done = await post(r.base, end, { outcomes: { cold: 2, south: 1 } });
    expect(done.json()).toMatchObject({ status: 'ended', outcomes: { north: 'loss', east: 'loss', south: 'win' }, ranks: { north: 2, east: 2, south: 1 } });
    expect(await summary()).toMatchObject({ status: 'ended', ranks: { north: 2, east: 2, south: 1 } });
  });

  it('exports the session replay as a download', async () => {
    const r = await rig();
    open.push(r);
    await r.match.seat('blue', 'runner').act([{ kind: 'move', x: 15, y: 4 }]);
    await r.match.step(12);
    const res = await call(r.base, `${API}/sessions/${r.match.id}/replay`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${definition.manifest.id}-${r.match.id}.replay.json"`);
    expect(res.json()).toEqual(r.match.replay());
  });
});

describe('operator console: agents', () => {
  const OWNER = 'owner-alice';

  function connectionStore(connection: StoredConnection): ConnectionStore {
    const connections = new Map([[connection.id, connection]]);
    return {
      load: () => ({ connections: [...connections.values()].map((c) => structuredClone(c)), clients: [] }),
      saveConnection: (c) => void connections.set(c.id, structuredClone(c)),
      deleteConnection: (id) => void connections.delete(id),
      saveClient: () => {},
      deleteClient: () => {},
    } as ConnectionStore;
  }

  it('lists every owner\'s commanders with seat and rejections, and rotates a commander token', async () => {
    const host = createPlayerThreeHost({ definition });
    await host.commanders.ready;
    host.commanders.ensure(OWNER);
    const commander = host.commanders.create(OWNER, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    host.commanders.ensure('owner-bobby');
    const r = await rig({}, host);
    open.push(r);
    const seated = host.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: commander } }] });
    const oldToken = host.commanders.token(OWNER, commander);
    const session = host.agentSession(oldToken)!;
    await session.control.act([{ kind: 'move', x: 99, y: 0 }]);
    const agents = (await call(r.base, `${API}/agents`)).json<{
      oauth: boolean; total: number;
      owners: { owner: string; activeNow: boolean; commanders: { id: string; name: string; roles: string[]; connected: boolean; seated: unknown; rejections: unknown[] }[] }[];
    }>();
    expect(agents).toMatchObject({ oauth: false, total: 2 });
    expect(agents.owners[0]).toMatchObject({ owner: OWNER, activeNow: true });
    expect(agents.owners[0]!.commanders.find((c) => c.id === commander)).toMatchObject({
      connected: true, seated: { session: seated.id, team: 'blue', roles: ['runner'] }, rejections: [{ code: 'invalid:range', count: 1 }],
    });
    expect((await call(r.base, `${API}/agents?q=bob`)).json()).toMatchObject({ total: 1, owners: [{ owner: 'owner-bobby' }] });
    expect((await call(r.base, `${API}/agents?limit=1`)).json<{ total: number; owners: unknown[] }>()).toMatchObject({ total: 2, owners: [expect.anything()] });
    const overview = (await call(r.base, `${API}/overview`)).json<{ window: { recent: { owner: string | null }[] } }>();
    expect(overview.window.recent[0]).toMatchObject({ owner: OWNER });

    const rotated = await post(r.base, `${API}/agents/rotate`, { owner: OWNER, commander });
    expect(rotated.json()).toEqual({ ok: true });
    expect(host.agentSession(oldToken)).toBeUndefined();
    expect(host.agentSession(host.commanders.token(OWNER, commander))).toBeDefined();
    expect((await post(r.base, `${API}/agents/rotate`, { owner: 'owner-nobody', commander })).status).toBe(404);
    expect((await post(r.base, `${API}/agents/rotate`, { owner: OWNER })).status).toBe(400);
    expect((await post(r.base, `${API}/agents/revoke`, { owner: OWNER, connection: 'con_aaaaaaaaaaaaaaaa' })).json()).toMatchObject({ error: 'oauth_not_mounted' });
  });

  it('lists sign-in connections across owners and revokes one', async () => {
    const host = createPlayerThreeHost({ definition });
    await host.commanders.ready;
    host.commanders.ensure(OWNER);
    const commander = host.commanders.create(OWNER, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const access = `playerthree_at_${'a'.repeat(43)}`;
    const digest = (t: string) => createHash('sha256').update(t).digest('hex');
    const later = Date.now() + 3_600_000;
    const oauth = createAuthorizationServer(host, {
      issuer: 'http://127.0.0.1:1',
      consentUrl: (id) => `/connect?request=${id}`,
      store: connectionStore({
        id: 'con_AAAAAAAAAAAAAAAA',
        owner: OWNER,
        commander,
        client: { id: 'https://claude.ai/oauth/claude-code-client-metadata', registration: 'cimd', name: 'Claude Code' },
        roles: ['runner'],
        resource: 'http://127.0.0.1:1/mcp',
        scope: 'play',
        createdAt: 1,
        authorizedAt: 2,
        lastSeenAt: null,
        refresh: { digest: digest('refresh'), expiresAt: later },
        retired: [],
        access: [{ digest: digest(access), expiresAt: later }],
      }),
    });
    await oauth.ready;
    const r = await rig({ oauth }, host);
    open.push({ close: async () => { await r.close(); oauth.close(); } });
    expect(oauth.allConnections()).toEqual([expect.objectContaining({ id: 'con_AAAAAAAAAAAAAAAA', owner: OWNER })]);
    const agents = (await call(r.base, `${API}/agents`)).json<{ oauth: boolean; owners: { connections: unknown[] }[] }>();
    expect(agents.oauth).toBe(true);
    expect(agents.owners[0]!.connections).toEqual([{
      id: 'con_AAAAAAAAAAAAAAAA',
      commander,
      client: { id: 'https://claude.ai/oauth/claude-code-client-metadata', name: 'Claude Code', registration: 'cimd' },
      domain: 'claude.ai',
      roles: ['runner'],
      createdAt: 1,
      authorizedAt: 2,
      lastSeenAt: null,
      active: false,
    }]);
    expect((await call(r.base, `${API}/overview`)).json()).toMatchObject({ agents: { connections: 1 } });
    expect(oauth.verify(access)).toBeDefined();
    expect((await post(r.base, `${API}/agents/revoke`, { owner: 'owner-bobby', connection: 'con_AAAAAAAAAAAAAAAA' })).status).toBe(404);
    expect((await post(r.base, `${API}/agents/revoke`, { owner: OWNER, connection: 'con_AAAAAAAAAAAAAAAA' })).json()).toEqual({ ok: true });
    expect(oauth.verify(access)).toBeUndefined();
    expect(oauth.allConnections()).toEqual([]);
  });
});

describe('operator console: replay scrubbing', () => {
  it('scrubs backward and forward to fresh replay perspectives without changing the live session', async () => {
    const r = await rig();
    open.push(r);
    const runner = r.match.seat('blue', 'runner');
    await runner.act([{ kind: 'move', x: 15, y: 8 }]);
    await r.match.step(10);
    await runner.act([{ kind: 'dash' }]);
    r.match.setMandate('blue', 'runner', {
      autonomy: 'autonomous', directive: { stance: 'attack' }, whenAbsent: 'hold',
    });
    await r.match.step(14);
    r.match.setController('red', 'guard', 'none');
    await r.match.step(12);
    const replay = r.match.replay();
    const before = {
      tick: r.match.tick,
      seats: r.match.seats(),
      blue: r.match.view('blue'),
      red: r.match.view('red'),
      replay,
    };
    const statePath = `${API}/sessions/${r.match.id}/state`;
    const liveState = (await call(r.base, statePath)).json<SessionState>();
    const source = `sessions/${r.match.id}`;
    for (const tick of [24, 0, 10, 36, 10, 20]) {
      const fresh = replayMatch(definition, replay, tick).adapter;
      for (const team of ['blue', 'red'] as const) {
        const side = await scrub(r.base, source, tick, `side:${team}`);
        expect(side.tick).toBe(tick);
        expect(side.data).toEqual(fresh.view(team, { snapshot: true }));
        expect(side.entries).toEqual(replay.entries.filter(([at]) => Math.abs(at - tick) <= 1));
        expect(side.events).toEqual(liveState.events.filter((event) => Math.abs(event.tick - tick) <= 1));
        for (const role of ['runner', 'guard'] as const) {
          const seat = await scrub(r.base, source, tick, `seat:${team}/${role}`);
          expect(seat.tick).toBe(tick);
          expect(seat.data).toEqual(fresh.observe({ team, role }, Math.max(-1, tick - 1), []));
          expect(seat.entries).toEqual(side.entries);
          expect(seat.events).toEqual(side.events);
        }
      }
    }
    expect(await scrub(r.base, source, 10, 'god')).toMatchObject({ tick: 10, data: null });
    expect({
      tick: r.match.tick,
      seats: r.match.seats(),
      blue: r.match.view('blue'),
      red: r.match.view('red'),
      replay: r.match.replay(),
    }).toEqual(before);
    expect((await call(r.base, statePath)).json()).toEqual(liveState);
    await r.match.step(4);
    const continued = replayMatch(definition, r.match.replay()).adapter;
    expect(r.match.view('blue')).toEqual(continued.view('blue', { snapshot: true }));
    expect(r.match.view('red')).toEqual(continued.view('red', { snapshot: true }));
  });

  it('imports an exported replay and scrubs it independently after the original session is disposed', async () => {
    const r = await rig();
    open.push(r);
    await r.match.seat('blue', 'runner').act([{ kind: 'move', x: 15, y: 4 }]);
    await r.match.step(30);
    const replay = r.match.replay();
    const response = await post(r.base, `${API}/replays`, replay);
    expect(response.status).toBe(200);
    const imported = response.json<{
      replay: string;
      ticks: number;
      seats: { team: string; role: string }[];
      game: { id: string; version: string };
    }>();
    expect(imported.replay).toMatch(/^[0-9a-f]{32}$/);
    expect(imported.ticks).toBe(replay.ticks);
    expect(imported.game).toMatchObject({ id: definition.manifest.id, version: definition.manifest.version });
    expect(imported.seats).toHaveLength(4);
    expect(imported.seats).toEqual(expect.arrayContaining([
      { team: 'blue', role: 'runner' }, { team: 'blue', role: 'guard' },
      { team: 'red', role: 'runner' }, { team: 'red', role: 'guard' },
    ]));
    r.match.dispose();
    for (const tick of [30, 0, 12, 30]) {
      const fresh = replayMatch(definition, replay, tick).adapter;
      for (const team of ['blue', 'red'] as const) {
        const frame = await scrub(r.base, `replays/${imported.replay}`, tick, `side:${team}`);
        expect(frame).toEqual({
          tick,
          ticks: replay.ticks,
          from: 0,
          paused: [],
          data: fresh.view(team, { snapshot: true }),
          entries: replay.entries.filter(([at]) => Math.abs(at - tick) <= 1),
          events: [],
        });
        const seat = await scrub(r.base, `replays/${imported.replay}`, tick, `seat:${team}/runner`);
        expect(seat.data).toEqual(fresh.observe({ team, role: 'runner' }, Math.max(-1, tick - 1), []));
        expect(seat.events).toEqual([]);
      }
    }
    expect((await call(r.base, `${API}/replays/unknown/scrub?tick=0`)).json()).toMatchObject({ error: 'replay_not_found' });
  });

  it('limits simultaneous HTTP scrubs to two and releases a canceled simulation', async () => {
    const r = await rig();
    open.push(r);
    // Inputs at tick 1 leave imports cheap while keeping each requested simulation cooperative and busy.
    const replay: Replay = {
      ...r.match.replay(),
      ticks: 1,
      entries: [
        ...r.match.replay().entries,
        ...Array.from({ length: 80_000 }, (): ReplayEntry => [1, 'blue', 'runner', 'intent', { kind: 'stop' }, 'owner', ['runner']]),
      ],
    };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await post(r.base, `${API}/replays`, replay);
      expect(response.status).toBe(200);
      ids.push(response.json<{ replay: string }>().replay);
    }
    const controllers = ids.map(() => new AbortController());
    const requests = ids.map((id, index) => fetch(
      `${r.base}${API}/replays/${id}/scrub?tick=1&perspective=side:blue`,
      { signal: controllers[index]!.signal },
    ).then(
      async (response) => ({ index, status: response.status, body: await response.json() as unknown }),
      (error: unknown) => ({ index, status: error instanceof Error ? error.name : String(error), body: null }),
    ));
    try {
      const rejected = await Promise.race(requests);
      expect(rejected.status).toBe(429);
      const canceled = (rejected.index + 1) % requests.length;
      controllers[canceled]!.abort();
      const outcomes = await Promise.all(requests);
      expect(outcomes[canceled]!.status).toBe('AbortError');
      expect(outcomes.filter((outcome) => outcome.status === 200)).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 429)).toHaveLength(1);
      // The surviving simulation has finished, so cancellation must also have released its source and slot.
      const fresh = replayMatch(definition, replay, 1).adapter;
      for (const id of ids) {
        const frame = await scrub(r.base, `replays/${id}`, 1, 'side:blue');
        expect(frame.tick).toBe(1);
        expect(frame.data).toEqual(fresh.view('blue', { snapshot: true }));
        expect(frame.entries).toHaveLength(200);
      }
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.all(requests);
    }
  }, 15_000);

  it('rejects replay uploads beyond the simulation and HTTP body caps', async () => {
    const r = await rig();
    open.push(r);
    for (const body of [
      JSON.stringify({ ...r.match.replay(), ticks: 36_001 }),
      JSON.stringify({ ...r.match.replay(), padding: 'x'.repeat(5 * 1024 * 1024) }),
    ]) {
      expect((await post(r.base, `${API}/replays`, body)).status).toBe(413);
    }
  });

  it('rejects incompatible replay uploads and missing or invalid scrub targets', async () => {
    const r = await rig();
    open.push(r);
    await r.match.step(5);
    for (const changes of [
      { game: 'another-game' },
      { gameVersion: `${definition.manifest.version}-incompatible` },
      { version: 999 },
    ]) {
      expect((await post(r.base, `${API}/replays`, { ...r.match.replay(), ...changes })).status).toBe(400);
    }
    for (const query of [
      '',
      'tick=',
      'tick=-1',
      'tick=1.5',
      'tick=NaN',
      'tick=6',
      'tick=0&perspective=side:unknown',
      'tick=0&perspective=seat:blue/unknown',
      'tick=0&perspective=unknown',
    ]) {
      expect((await call(r.base, `${API}/sessions/${r.match.id}/scrub?${query}`)).status).toBe(400);
    }
  });
});

describe('operator console: recent sessions', () => {
  it('lists a released session under recent, links its gone page, scrubs it like a fresh replay and exports it', async () => {
    const r = await rig();
    open.push(r);
    const runner = r.host.seatControl(r.match.mintSeatToken('blue', 'runner'))!;
    await runner.act([{ kind: 'move', x: 15, y: 8 }]);
    await runner.act([{ kind: 'move', x: 99, y: 0 }]);
    await r.match.step(20);
    await r.match.seat('blue', 'runner').act([{ kind: 'dash' }]);
    await r.match.step(10);
    r.match.end({ blue: 'loss', red: 'win' });
    const replay = r.match.replay();
    expect((await call(r.base, `${API}/sessions`)).json()).toMatchObject({ recent: [], history: { maxSessions: 50, persistent: false } });
    r.match.dispose();

    const list = (await call(r.base, `${API}/sessions`)).json<{ sessions: unknown[]; recent: Record<string, unknown>[] }>();
    expect(list.sessions).toEqual([]);
    expect(list.recent).toEqual([expect.objectContaining({
      id: r.match.id, status: 'released', teams: ['blue', 'red'], alliances: null, outcomes: { blue: 'loss', red: 'win' }, ranks: { blue: 2, red: 1 },
      ticks: 30, rejections: 1, policyErrors: 0, replay: true, scrubbable: true,
    })]);
    const blueRunner = (list.recent[0]!.seats as { team: string; role: string; harnesses: string[] }[]).find((s) => s.team === 'blue' && s.role === 'runner');
    expect(blueRunner?.harnesses).toEqual(['seat token']);
    expect((await call(r.base, `${API}/overview`)).json()).toMatchObject({ sessions: { live: 0, ended: 0, recent: 1 } });

    // The live endpoints are gone; the 404 says the history has it.
    const gone = await call(r.base, `${API}/sessions/${r.match.id}/state`);
    expect(gone.status).toBe(404);
    expect(gone.json()).toMatchObject({ error: 'session_not_found', recent: true });
    expect((await call(r.base, `${API}/sessions/unknown-id/state`)).json()).toMatchObject({ recent: false });

    const detail = (await call(r.base, `${API}/recent/${r.match.id}`)).json<{ record: { id: string; seed: number }; scrubbable: boolean; seats: unknown[]; reason: string | null }>();
    expect(detail).toMatchObject({ record: { id: r.match.id, seed: 5 }, scrubbable: true, reason: null });
    expect(detail.seats).toHaveLength(4);
    const source = `recent/${r.match.id}`;
    for (const tick of [30, 0, 17, 9, 30]) {
      const fresh = replayMatch(definition, replay, tick).adapter;
      for (const team of ['blue', 'red'] as const) {
        const side = await scrub(r.base, source, tick, `side:${team}`);
        expect(side).toEqual({ tick, ticks: 30, from: 0, paused: [], data: fresh.view(team, { snapshot: true }), entries: replay.entries.filter(([at]) => Math.abs(at - tick) <= 1), events: [] });
        const seat = await scrub(r.base, source, tick, `seat:${team}/guard`);
        expect(seat.data).toEqual(fresh.observe({ team, role: 'guard' }, Math.max(-1, tick - 1), []));
      }
    }
    const exported = await call(r.base, `${API}/recent/${r.match.id}/replay`);
    expect(exported.headers['content-disposition']).toBe(`attachment; filename="${definition.manifest.id}-${r.match.id}.replay.json"`);
    expect(exported.json()).toEqual(replay);
    expect((await call(r.base, `${API}/recent/unknown-id`)).status).toBe(404);
    expect((await call(r.base, `${API}/recent/unknown-id/scrub?tick=0`)).json()).toMatchObject({ error: 'session_not_found' });
    expect((await call(r.base, `${API}/recent/${r.match.id}/scrub?tick=31`)).status).toBe(400);
  });

  it('is operator-only like every console route', async () => {
    const host = createPlayerThreeHost({ definition });
    const handler = createDevtoolsHandler(host);
    open.push({ close: async () => { handler.close(); host.dispose(); } });
    const match = host.createMatch({ realtime: false });
    match.dispose();
    for (const url of [`${API}/recent/${match.id}`, `${API}/recent/${match.id}/scrub?tick=0`, `${API}/recent/${match.id}/replay`, `${API}/policies`, `${API}/bench`, `${API}/safety`, `${API}/settings`]) {
      expect((await fake(handler, { url, remoteAddress: '203.0.113.9', headers: { host: 'localhost' } })).status).toBe(403);
    }
    expect((await fake(handler, { url: `${API}/policies/pool`, method: 'POST', remoteAddress: '203.0.113.9', headers: { host: 'localhost' } })).status).toBe(403);
    const token = await rig({ operatorToken: OPERATOR_TOKEN });
    open.push(token);
    token.match.dispose();
    expect((await call(token.base, `${API}/recent/${token.match.id}`)).status).toBe(401);
    expect((await call(token.base, `${API}/recent/${token.match.id}`, { headers: bearer(OPERATOR_TOKEN) })).status).toBe(200);
    expect((await call(token.base, `${API}/policies/pool`, { body: { id: 'pol_1', action: 'disable' }, headers: bearer(OPERATOR_TOKEN) })).status).toBe(404);
    expect((await call(token.base, `${API}/policies/pool`, { body: { id: 'pol_1', action: 'disable' }, headers: { ...bearer('x'.repeat(40)) } })).status).toBe(401);
  });
});

describe('operator console: policies, bench, safety, game settings', () => {
  const OWNER = 'owner-alice';
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'playerthree-console-'));
    open.push({ close: async () => rmSync(d, { recursive: true, force: true }) });
    return d;
  };

  it('policies: libraries per named commander, the pool with operator controls, and crash/timeout/error stats', async () => {
    const host = createPlayerThreeHost({ definition });
    await host.commanders.ready;
    host.commanders.ensure(OWNER);
    const commander = host.commanders.create(OWNER, { name: 'Guard', kind: 'agent', roles: ['guard'], isolation: { independentSessions: true } }).id;
    const r = await rig({}, host);
    open.push(r);
    const lobby = host.commanders.agent(OWNER, commander, () => true, 'guard')!.control;
    const code = 'function think(obs) { return []; }';
    expect(await lobby.policyDeploy({ runtime: 'js', code })).toMatchObject({ ok: true, version: 1 });
    const author = r.match.seat('red', 'runner');
    await author.policyDeploy({ runtime: 'js', code: 'function think(obs) { return []; }' });
    const published = await author.publish();
    if (!('policyId' in published)) throw new Error('expected a published policy');
    // A policy that crashes once the match runs.
    expect(await r.match.seat('blue', 'runner').policyDeploy({ runtime: 'js', code: 'function think(obs) { if (obs.tick > 0) throw new Error("boom"); return []; }' })).toMatchObject({ ok: true });
    await r.match.step(5);

    type Policies = {
      modes: { policy: unknown; pool: unknown };
      libraries: { owner: string; commander: string; name: string; roles: string[]; activeByRole: Record<string, number | null>; versions: { version: number; role: string | null; runtime: string; bytes: number }[]; record: unknown; lastPractice: unknown }[];
      pool: { id: string; publisher: unknown; publisherOwner: string | null; drafts: number; disabled: boolean }[];
      errors: { window: { codes: { code: string; kind: string; count: number }[]; seats: { session: string; crash: number }[] }; live: { team: string; role: string; errors: number }[]; history: { sessions: number } };
    };
    const p = (await call(r.base, `${API}/policies`)).json<Policies>();
    expect(p.modes.policy).toBeTruthy();
    expect(p.libraries).toEqual([expect.objectContaining({ owner: OWNER, commander, name: 'Guard', roles: ['guard'], activeByRole: { guard: 1 }, versions: [{ version: 1, role: 'guard', runtime: 'js', createdAt: expect.any(Number), bytes: code.length, surfaceHash: expect.any(String), artifactHash: expect.stringMatching(/^[0-9a-f]{64}$/) }], record: { wins: 0, losses: 0, draws: 0 }, lastPractice: null })]);
    expect(p.pool).toEqual([expect.objectContaining({ id: published.policyId, publisher: { kind: 'session', session: r.match.id, team: 'red' }, publisherOwner: null, drafts: 0, disabled: false })]);
    expect(p.errors.window.codes).toContainEqual({ code: 'threw', kind: 'crash', count: expect.any(Number) });
    expect(p.errors.window.seats[0]).toMatchObject({ session: r.match.id, crash: expect.any(Number) });
    expect(p.errors.live).toContainEqual(expect.objectContaining({ team: 'blue', role: 'runner', errors: expect.any(Number) }));

    const pool = `${API}/policies/pool`;
    expect((await post(r.base, pool, { id: published.policyId, action: 'disable' })).json()).toMatchObject({ ok: true, entry: { id: published.policyId, disabled: true } });
    expect(host.pool.list()).toEqual([]);
    expect((await post(r.base, pool, { id: published.policyId, action: 'enable' })).json()).toMatchObject({ entry: { disabled: false } });
    expect((await post(r.base, pool, { id: published.policyId, action: 'explode' })).status).toBe(400);
    expect((await post(r.base, pool, { id: '../etc', action: 'disable' })).status).toBe(400);
    expect((await post(r.base, pool, { id: published.policyId, action: 'unpublish' })).json()).toEqual({ ok: true, id: published.policyId, unpublished: true });
    expect(host.pool.entries()).toEqual([]);
    expect((await post(r.base, pool, { id: published.policyId, action: 'unpublish' })).status).toBe(404);
    expect((await call(r.base, pool, { body: { id: published.policyId, action: 'disable' }, headers: { ...LOCAL_ORIGIN, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  });

  it('bench: lists result directories, renders their report and opens listed replays in the timeline', async () => {
    const none = await rig();
    open.push(none);
    expect((await call(none.base, `${API}/bench`)).json()).toEqual({ configured: false, root: null, results: [] });

    const root = tmp();
    const run = join(root, 'nightly');
    mkdirSync(join(run, 'artifacts'), { recursive: true });
    const host = createPlayerThreeHost({ definition });
    const r = await rig({ benchResultsDir: root }, host);
    open.push(r);
    await r.match.seat('blue', 'runner').act([{ kind: 'move', x: 15, y: 4 }]);
    await r.match.step(25);
    const replay = r.match.replay();
    const artifactId = 'attempt-1/replay';
    const artifactPath = `artifacts/${encodeURIComponent(artifactId)}.json`;
    const replayJson = JSON.stringify(replay);
    writeFileSync(join(run, artifactPath), replayJson);
    writeFileSync(join(run, 'secret.json'), JSON.stringify(replay));
    const hash = (await call(r.base, `${API}/overview`)).json<{ game: { surfaceHash: string } }>().game.surfaceHash;
    const createdAt = '2000-01-03T10:00:00.000Z';
    const template: MatchSpec = {
      format: 'playerthree.match', version: 1, game: 'tag', gameVersion: definition.manifest.version, surfaceHash: hash,
      rulesHash: 'rules-tag', seed: 7, map: { id: 'tag', identity: 'tag-map', seed: 7, layout: 'duel' }, options: {},
      sides: ['blue', 'red'].map((team) => ({ id: team, spawnSlot: team, alliance: team,
        seats: [{ role: 'runner', occupant: { kind: 'bot' as const, level: 'easy', options: {} } }] })),
      bindings: [{ seat: { team: 'blue', role: 'runner' }, entrantId: 'baseline' }, { seat: { team: 'red', role: 'runner' }, entrantId: 'opponent' }],
      observerPolicy: { allowOmniscient: false, minDelayMs: 0 }, rules: { ranked: false, coaching: 'off', practiceReasons: ['test'] },
    };
    const outcome = [{ team: 'blue', rank: 1, outcome: 'win' as const, reason: 'tag' }, { team: 'red', rank: 2, outcome: 'loss' as const, reason: 'tag' }];
    const sideBindings = [{ team: 'blue', entrantId: 'baseline' }, { team: 'red', entrantId: 'opponent' }];
    const record: StoredSeries = {
      id: 'nightly-series', owner: OWNER, revision: 1, state: 'completed', createdAt, updatedAt: createdAt, completedAt: createdAt,
      comparisonHash: 'comparison-tag', limits: { maxGames: 10, maxConcurrency: 1, maxBytes: 1000000, maxChunkBytes: 100000, retentionMs: 1000000, maxWallMs: 60000 },
      expiresAt: '2099-01-01T00:00:00.000Z', bytes: 0, activeAttempts: [],
      updates: [{ seriesId: 'nightly-series', revision: 1, at: createdAt, state: 'completed', completed: 1, total: 1, standings: [], activeMatches: [], releaseAt: 0 }],
      lease: null, commentaryConsents: [],
      spec: {
        format: 'playerthree.series', version: 1, game: 'tag', gameVersion: definition.manifest.version, surfaceHash: hash, track: 'bots',
        entrants: ['baseline', 'opponent'].map((id) => ({ id, label: id, kind: 'bot' as const, aiPlayer: true, botLevel: 'easy' })),
        template, scenarios: [{ id: 'heldout', seed: 7, map: template.map, options: {} }],
        permutations: [{ id: 'first', sideEntrants: sideBindings }], repetitions: 1,
        execution: { concurrency: 1, speed: 1000, clock: 'accelerated', maxTicks: 25, maxWallMs: 60000, maxInfraRetries: 0, state: 'reset_each_match' },
        budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null }, rating: { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 },
        telemetry: { sampleEveryTicks: 20, includeCommentary: false },
      },
      trials: [{ trialId: 'trial-1', scenarioId: 'heldout', permutationId: 'first', repetition: 0, scheduleIndex: 0,
        seed: 7, mapId: 'tag', mapIdentity: 'tag-map', mapSeed: 7, layoutId: 'duel', rulesHash: 'rules-tag', surfaceHash: hash,
        resolvedOptions: {}, sideBindings, spec: template }],
      attempts: [{ matchId: 'attempt-1', trialId: 'trial-1', attemptId: 'attempt-1', attemptNumber: 1, revision: 1, status: 'finished',
        acceptedAttempt: true, startedAt: createdAt, endedAt: createdAt, ticks: 25, simulatedMs: 1250, wallMs: 1200,
        terminalReason: 'tag', outcomes: outcome, spec: exportMatchSpec(template), releaseAt: 0 }],
      artifacts: [{ id: artifactId, matchId: 'attempt-1', kind: 'replay', format: 'playerthree.replay', version: 1,
        sha256: createHash('sha256').update(replayJson).digest('hex'), bytes: Buffer.byteLength(replayJson), availability: 'available' }],
      chunkStats: [{ attemptId: 'attempt-1', count: 1, bytes: 1 }],
    };
    const usage: ResultChunk = { index: 0, checksum: 'usage-fixture', bytes: 1, rows: {
      usage: [{ matchId: 'attempt-1', phase: 'inference', team: 'blue', role: 'runner', entrantId: 'baseline', executionId: 'execution-1',
        decisionId: null, reporter: 'unpriced', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
        costAmount: null, currency: null, pricingVersion: null, coverage: 'unknown' }],
    } };
    const parts: Uint8Array[] = [];
    for await (const part of exportStoredResults(record, async function* (): AsyncIterable<StoredResultChunk> { yield { attemptId: 'attempt-1', committedRevision: 1, chunk: usage }; }, 'json')) parts.push(part);
    const exported = Buffer.concat(parts).toString('utf8');
    writeFileSync(join(run, 'results.json'), exported);
    writeFileSync(join(run, 'report.md'), '# PlayerThree benchmark — tag\n\nValidity: **valid**\n');
    writeFileSync(join(root, 'not-a-run.txt'), 'x');

    type Bench = { configured: boolean; results: { key: string; name: string; state: string; currentSurface: boolean; sameGame: boolean; report: boolean; standings: { entrantId: string; wins: number }[]; usage: { inputTokens: number | null; costAmount: string | null }[]; matches: { replay: string }[] }[] };
    const b = (await call(r.base, `${API}/bench`)).json<Bench>();
    expect(b.configured).toBe(true);
    expect(b.results).toEqual([expect.objectContaining({ name: 'nightly', state: 'completed', currentSurface: true, sameGame: true, report: true })]);
    const [result] = b.results;
    expect(result!.standings).toEqual(expect.arrayContaining([expect.objectContaining({ entrantId: 'baseline', wins: 1 })]));
    expect(result!.usage[0]).toMatchObject({ inputTokens: null, costAmount: null });
    expect(result!.matches[0]!.replay).toBe(artifactPath);
    expect(result).not.toHaveProperty('runs');
    expect((await call(r.base, `${API}/bench/${result!.key}/report`)).json()).toEqual({ name: 'nightly', text: '# PlayerThree benchmark — tag\n\nValidity: **valid**\n' });
    expect((await call(r.base, `${API}/bench/0123456789abcdef/report`)).status).toBe(404);

    const opened = await post(r.base, `${API}/bench/replay`, { dir: result!.key, path: artifactPath });
    expect(opened.status).toBe(200);
    const key = opened.json<{ replay: string; ticks: number; name: string }>();
    expect(key).toMatchObject({ ticks: 25, name: `nightly/${artifactPath}` });
    const fresh = replayMatch(definition, replay, 12).adapter;
    expect((await scrub(r.base, `replays/${key.replay}`, 12, 'side:red')).data).toEqual(fresh.view('red', { snapshot: true }));
    // Only replays results.json lists, inside the directory.
    for (const path of ['secret.json', `../nightly/${artifactPath}`, '/etc/passwd', 'artifacts/unlisted.json']) {
      expect((await post(r.base, `${API}/bench/replay`, { dir: result!.key, path })).status).toBe(404);
    }
    const expired = JSON.parse(exported) as ResultsEnvelope;
    writeFileSync(join(run, 'results.json'), JSON.stringify({ ...expired,
      tables: { ...expired.tables, artifacts: expired.tables.artifacts.map((artifact) => ({ ...artifact, availability: 'expired' })) } }));
    expect((await post(r.base, `${API}/bench/replay`, { dir: result!.key, path: artifactPath })).status).toBe(404);
    writeFileSync(join(run, 'results.json'), JSON.stringify({ ...expired, tables: { ...expired.tables, entrants: [{ id: 'baseline' }] } }));
    expect((await post(r.base, `${API}/bench/replay`, { dir: result!.key, path: artifactPath })).status).toBe(422);
    const malformed = (await call(r.base, `${API}/bench`)).json<{ results: { error: string }[] }>();
    expect(malformed.results[0]!.error).toContain('valid playerthree.results');
  });

  it('safety: surface, modes, scopes, the Safety Card and rejection stats over the window and the history', async () => {
    const dir = tmp();
    const cardPath = join(dir, 'SAFETY.md');
    const missing = await rig({ safetyCard: join(dir, 'nope.md') });
    open.push(missing);
    expect((await call(missing.base, `${API}/safety`)).json()).toMatchObject({ card: { error: expect.any(String) }, audit: expect.stringContaining('playerthree audit') });

    const r = await rig({ safetyCard: cardPath });
    open.push(r);
    const hash = (await call(r.base, `${API}/overview`)).json<{ game: { surfaceHash: string } }>().game.surfaceHash;
    writeFileSync(cardPath, `# Safety Card\n\n\`\`\`\n${hash}\n\`\`\`\n`);
    const control = r.host.seatControl(r.match.mintSeatToken('blue', 'runner'))!;
    await control.act([{ kind: 'move', x: 99, y: 0 }]);
    r.match.dispose();
    const s = (await call(r.base, `${API}/safety`)).json<Record<string, unknown>>();
    expect(s).toMatchObject({
      surfaceHash: hash,
      modes: { intents: expect.any(Object), policy: expect.any(Object), pool: expect.any(Object) },
      scopes: { all: ['act', 'policy', 'practice', 'publish', 'say'], defaults: expect.arrayContaining(['act', 'policy', 'publish']) },
      card: { path: cardPath, matchesSurface: true, text: expect.stringContaining(hash) },
      rejections: {
        window: { minutes: 15, rejections: 1, codes: [{ code: 'invalid:range', count: 1 }] },
        history: { sessions: 1, rejections: 1, codes: [{ code: 'invalid:range', count: 1 }], persistent: false },
      },
    });
    writeFileSync(cardPath, '# Safety Card\n\nold surface\n');
    expect((await call(r.base, `${API}/safety`)).json()).toMatchObject({ card: { matchesSurface: false } });
  });

  it('game settings: the match options schema, host defaults and options per live and recent session', async () => {
    const plain = await rig();
    open.push(plain);
    expect((await call(plain.base, `${API}/settings`)).json()).toMatchObject({ schema: null, defaults: null, sessions: [{ id: plain.match.id, status: 'running', options: null }] });

    const manifest = { ...definition.manifest, matchOptions: t.obj({ arena: t.opt(t.enum(['small', 'large'], 'Board size')) }) };
    const withOptions = { ...definition, manifest } as unknown as typeof definition;
    const host = createPlayerThreeHost({ definition: withOptions, matchOptions: { arena: 'small' } as never });
    const r = await rig({}, host);
    open.push(r);
    const large = host.createMatch({ realtime: false, options: { arena: 'large' } as never });
    large.dispose();
    const s = (await call(r.base, `${API}/settings`)).json<{ schema: { properties: Record<string, unknown> }; defaults: unknown; sessions: unknown[] }>();
    expect(s.schema.properties.arena).toMatchObject({ enum: ['small', 'large'], description: 'Board size' });
    expect(s.defaults).toEqual({ arena: 'small' });
    expect(s.sessions).toEqual([
      expect.objectContaining({ id: r.match.id, status: 'running', options: { arena: 'small' } }),
      expect.objectContaining({ id: large.id, status: 'released', options: { arena: 'large' } }),
    ]);
  });
});

describe('player API', () => {
  it('only lets a team owner in, and only shows that team', async () => {
    const r = await rig();
    open.push(r);
    const seatToken = r.match.mintSeatToken('blue', 'runner');
    expect((await call(r.base, '/playerthree/player/state')).status).toBe(401);
    expect((await call(r.base, '/playerthree/player/state', { headers: bearer('x'.repeat(32)) })).status).toBe(401);
    expect((await call(r.base, '/playerthree/player/state', { headers: bearer(seatToken) })).status).toBe(403);
    expect((await call(r.base, '/playerthree/player/state', { headers: bearer(r.match.tokens.spectator) })).status).toBe(403);
    expect((await call(r.base, '/playerthree/player/stream', { headers: bearer(seatToken) })).status).toBe(403);
    // Team owner tokens never open the operator console API... (local mode needs no credential, token mode refuses them)
    expect((await call(r.base, '/playerthree/player/state', { method: 'POST', headers: bearer(r.match.tokens.teams.blue!) })).status).toBe(405);

    const control = r.host.seatControl(seatToken)!;
    await control.observe(0);
    await control.act([{ kind: 'move', x: 15, y: 0 }, { kind: 'move', x: 99, y: 0 }]);
    await r.match.step(30); // red bots act too
    const blue = await playerState(r.base, r.match.tokens.teams.blue!);
    expect(blue.team).toBe('blue');
    expect(blue.seats.map((s) => s.team)).toEqual(['blue', 'blue']);
    expect(blue.observations.runner?.data.team).toBe('blue');
    expect(blue.events.some((e) => teamOf(e) === 'red')).toBe(false);
    const agentIntents = blue.events.filter((e) => e.type === 'intent' && e.source === 'agent');
    expect(agentIntents.map((e) => e.type === 'intent' && e.ack.ok)).toEqual([true, false]);
    // Rejected input is never stored or shown, only its closed code and schema path.
    expect(agentIntents[1]).not.toHaveProperty('intent');
    expect(agentIntents[1]).toMatchObject({ ack: { ok: false, code: 'invalid', schemaCode: 'range', path: ['x'] } });

    const red = await playerState(r.base, r.match.tokens.teams.red!);
    expect(red.team).toBe('red');
    expect(red.events.some((e) => teamOf(e) === 'blue')).toBe(false);
    expect(red.observations.runner?.data.team ?? 'red').toBe('red');
  });

  it('streams live trace events for the owner team only', async () => {
    const r = await rig();
    open.push(r);
    const control = r.host.seatControl(r.match.mintSeatToken('blue', 'runner'))!;
    const frames = await readStream(`${r.base}/playerthree/player/stream`, bearer(r.match.tokens.teams.blue!), 400, async () => {
      await new Promise((res) => setTimeout(res, 100)); // let the subscription register before events fire
      await control.observe(0);
      await control.act([{ kind: 'dash' }]);
      await r.match.step(20);
    });
    expect(frames[0]!.event).toBe('status');
    const traces = frames.filter((f) => f.event === 'trace').map((f) => f.data);
    expect(traces.some((e) => e.type === 'intent' && e.source === 'agent' && (e.intent as { kind?: string } | undefined)?.kind === 'dash')).toBe(true);
    expect(traces.some((e) => e.type === 'intent' && e.source === 'bot' && e.role === 'guard')).toBe(true);
    expect(traces.some((e) => e.type === 'observe' && e.role === 'runner')).toBe(true);
    expect(traces.every((e) => teamOf(e) === undefined || teamOf(e) === 'blue')).toBe(true);
  });
});

describe('playerthree dev', () => {
  let dev: DevServer | undefined;
  afterEach(async () => {
    await dev?.close();
    dev = undefined;
  });

  it('waits for the agent before starting the clock, and links the operator console to the session', async () => {
    dev = await startDevServer(definition, { port: 0 });
    expect(dev.devtoolsUrl).toBe(`${dev.url}/playerthree/devtools#sessions/${dev.match.id}`);
    expect(dev.match.seats().find((s) => s.role === 'runner')?.controller).toBe('agent');
    // Real-time tick loop: the only way to show the clock is *not* running is to let wall time pass.
    await new Promise((r) => setTimeout(r, 300));
    expect(dev.match.tick).toBe(0);
    await dev.host.seatControl(dev.seat.token)!.observe();
    const d = dev;
    await vi.waitFor(() => expect(d.match.tick).toBeGreaterThan(0), { timeout: 10_000, interval: 50 });
    const page = await call(dev.url, '/playerthree/devtools', { headers: { host: 'localhost' } });
    expect(page.status).toBe(200);
  });
});
