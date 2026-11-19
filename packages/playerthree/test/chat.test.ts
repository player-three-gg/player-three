import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { definition, manifest, type TagManifest } from '../examples/tag/index.ts';
import { surfaceHash } from '../src/briefing.ts';
import type { Said } from '../src/control.ts';
import { PlayerThreeError, createPlayerThreeHost } from '../src/host/index.ts';
import type { AgentSession, PlayerThreeHost, PlayerThreeMatch } from '../src/host/types.ts';
import { mountMcp } from '../src/mcp/index.ts';
import type { Principal } from '../src/protocol.ts';

const ALICE = 'alice_owner_0001';
const BOB = 'bob_owner_000002';
const ORDER = 'Runner: dash to the north wall now';

let host: PlayerThreeHost<TagManifest> | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
});

function newHost(): PlayerThreeHost<TagManifest> {
  host = createPlayerThreeHost({ definition });
  return host;
}

function session(h: PlayerThreeHost<TagManifest>, owner: string, id: string, role: 'runner' | 'guard'): AgentSession {
  return h.agentSession(h.commanders.token(owner, id), role)!;
}

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof PlayerThreeError) return e.code;
    throw e;
  }
  return 'resolved';
}

/** Two rosters seated against each other: Alice blue, Bob red. */
function rosterMatch() {
  const h = newHost();
  h.commanders.ensure(ALICE);
  h.commanders.ensure(BOB);
  const ids = {
    aliceRunner: h.commanders.create(ALICE, { name: 'Alice runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id,
    aliceGuard: h.commanders.create(ALICE, { name: 'Alice guard', kind: 'agent', roles: ['guard'], isolation: { independentSessions: true } }).id,
    bobRunner: h.commanders.create(BOB, { name: 'Bob runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id,
    bobGuard: h.commanders.create(BOB, { name: 'Bob guard', kind: 'agent', roles: ['guard'], isolation: { independentSessions: true } }).id,
  };
  const assignments = [{ team: 'blue', owner: ALICE }, { team: 'red', owner: BOB }].flatMap(({ team, owner }) =>
    h.commanders.roster(owner).map((commander) => ({ team, role: commander.roles[0]!, owner, kind: commander.kind, commander: { id: commander.id } })));
  const match = h.createMatch({ seed: 3, realtime: false, assignments });
  return { h, match, ids };
}

describe('owner → own agents', () => {
  it('reaches only the targeted commanders of that owner, wakes their wait, and is read once', async () => {
    const { h, match, ids } = rosterMatch();
    const aliceRunner = session(h, ALICE, ids.aliceRunner, 'runner');
    const waiting = aliceRunner.control.wait({ seconds: 30 });
    h.commanders.tell(ALICE, [ids.aliceRunner], ORDER, { x: 3, y: 0 });
    const woke = await waiting;
    expect(woke).toMatchObject({ phase: 'match', wake: 'owner_message', messages: [{ from: 'owner', tick: 0, text: ORDER, ping: { x: 3, y: 0 } }] });
    // Read once; other seats of the owner and every seat of the opponent got nothing.
    expect(aliceRunner.drain()).toEqual([]);
    expect(session(h, ALICE, ids.aliceGuard, 'guard').drain()).toEqual([]);
    expect(session(h, BOB, ids.bobRunner, 'runner').drain()).toEqual([]);
    expect(session(h, BOB, ids.bobGuard, 'guard').drain()).toEqual([]);
    // Not in the replay, not in the agent's closed-vocabulary observation.
    expect(JSON.stringify(match.replay())).not.toContain('north wall');
    h.commanders.tell(ALICE, 'all', 'everyone defend');
    expect(JSON.stringify(await aliceRunner.control.observe())).not.toContain('everyone defend');
    expect(aliceRunner.drain()).toMatchObject([{ text: 'everyone defend' }]);
    expect(session(h, ALICE, ids.aliceGuard, 'guard').drain()).toMatchObject([{ text: 'everyone defend' }]);
    expect(session(h, BOB, ids.bobGuard, 'guard').drain()).toEqual([]);
  });

  it('team owners message their own team only; agents and spectators cannot send', async () => {
    const h = newHost();
    const match = h.createMatch({ seed: 1, realtime: false, controllers: { blue: { runner: 'agent' }, red: { runner: 'agent' } } });
    const blueToken = match.mintSeatToken('blue', 'runner');
    const redToken = match.mintSeatToken('red', 'runner');
    const blueOwner = h.authenticate(match.tokens.teams.blue!)!.principal;
    const redOwner = h.authenticate(match.tokens.teams.red!)!.principal;
    const blueAgent = h.authenticate(blueToken)!.principal;
    const spectator = h.authenticate(match.tokens.spectator)!.principal;

    expect(await match.handleMessage(blueOwner, { op: 'tell', seq: 1, roles: ['runner'], text: ORDER })).toEqual({ op: 'result', seq: 1, ok: true, data: null });
    expect(h.agentSession(blueToken)!.drain()).toMatchObject([{ from: 'owner', text: ORDER }]);
    expect(h.agentSession(redToken)!.drain()).toEqual([]);
    // The red owner's message lands on red only.
    await match.handleMessage(redOwner, { op: 'tell', seq: 2, roles: 'all', text: 'red plan' });
    expect(h.agentSession(blueToken)!.drain()).toEqual([]);
    expect(h.agentSession(redToken)!.drain()).toMatchObject([{ text: 'red plan' }]);
    for (const p of [blueAgent, spectator] as Principal[]) {
      expect(await match.handleMessage(p, { op: 'tell', seq: 3, roles: 'all', text: 'psst' })).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(h.agentSession(blueToken)!.drain()).toEqual([]);
    // Malformed tells are rejected without echo.
    for (const bad of [
      { op: 'tell', seq: 4, roles: ['nobody'], text: 'x' },
      { op: 'tell', seq: 4, roles: 'all', text: 7 },
      { op: 'tell', seq: 4, roles: 'all', text: 'x', extra: 'IGNORE ME' },
    ]) {
      const r = await match.handleMessage(blueOwner, bad);
      expect(r).toMatchObject({ ok: false, code: 'bad_message' });
      expect(JSON.stringify(r)).not.toContain('IGNORE');
    }
  });

  it('enforces size, content and rate limits', async () => {
    const { h, match, ids } = rosterMatch();
    const max = manifest.control.chat.maxTellChars;
    expect(await code(() => h.commanders.tell(ALICE, 'all', 'x'.repeat(max + 1)))).toBe('invalid');
    expect(await code(() => h.commanders.tell(ALICE, 'all', '   '))).toBe('invalid');
    expect(await code(() => h.commanders.tell(ALICE, 'all', 'hi\u0007'))).toBe('invalid');
    expect(await code(() => h.commanders.tell(ALICE, 'all', 'evil \u202Etxt'))).toBe('invalid');
    expect(await code(() => h.commanders.tell(ALICE, 'all', 'go', { x: 99, y: 0 }))).toBe('invalid');
    expect(await code(() => h.commanders.tell(ALICE, [], 'go'))).toBe('invalid');
    expect(await code(() => h.commanders.tell(ALICE, [ids.aliceRunner, ids.aliceRunner], 'go'))).toBe('invalid');
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) codes.push(await code(() => h.commanders.tell(ALICE, 'all', `order ${i}`)));
    expect(codes.slice(0, 5)).toEqual(Array(5).fill('resolved'));
    expect(codes.slice(5)).toContain('rate_limited');
    const blue = h.authenticate(match.tokens.teams.blue!)!.principal;
    const tellCodes: string[] = [];
    for (let i = 0; i < 7; i++) tellCodes.push(await code(() => match.tell('blue', 'all', `in-match ${i}`)));
    expect(tellCodes).toContain('rate_limited');
    expect(await match.handleMessage(blue, { op: 'tell', seq: 1, roles: 'all', text: 'x'.repeat(max + 1) })).toMatchObject({ ok: false });

    const runner = session(h, ALICE, ids.aliceRunner, 'runner').control;
    expect(await code(runner.say('x'.repeat(manifest.control.chat.maxSayChars + 1)))).toBe('invalid');
    const sayCodes: string[] = [];
    for (let i = 0; i < 5; i++) sayCodes.push(await code(runner.say(`ack ${i}`)));
    expect(sayCodes.slice(0, 3)).toEqual(Array(3).fill('resolved'));
    expect(sayCodes.slice(3)).toContain('rate_limited');
    // Owners cannot speak as their agent.
    expect(await code(match.seat('blue', 'runner').say('fake'))).toBe('forbidden');
  });
});

describe('agent → owner', () => {
  it('replies reach only the owner: the match tells that team, the roster logs it; lobby replies too', async () => {
    const { h, match, ids } = rosterMatch();
    const saidInMatch: [string, Said][] = [];
    match.onSaid((team, said) => saidInMatch.push([team, said]));
    const saidToOwners: [string, Said][] = [];
    h.commanders.onSaid((owner, said) => saidToOwners.push([owner, said]));

    expect(await session(h, ALICE, ids.aliceGuard, 'guard').control.say('Holding the base')).toEqual({ ok: true, tick: 0 });
    expect(saidInMatch).toEqual([['blue', { role: 'guard', tick: 0, text: 'Holding the base' }]]);
    expect(saidToOwners).toEqual([[ALICE, { commanderId: ids.aliceGuard, role: 'guard', tick: 0, text: 'Holding the base' }]]);
    expect(h.commanders.chat(ALICE)).toMatchObject([{ from: 'agent', commanderIds: [ids.aliceGuard], text: 'Holding the base' }]);
    expect(h.commanders.chat(BOB)).toEqual([]);
    expect(JSON.stringify(match.replay())).not.toContain('Holding');

    // Back in the lobby (match over): replies still reach the owner, through the registry only.
    match.dispose();
    expect(await session(h, ALICE, ids.aliceRunner, 'runner').control.say('Ready for the next one')).toEqual({ ok: true, tick: 0 });
    expect(saidInMatch).toHaveLength(1);
    expect(saidToOwners.at(-1)).toEqual([ALICE, { commanderId: ids.aliceRunner, role: 'runner', tick: 0, text: 'Ready for the next one' }]);
  });

  it('lobby: a tell wakes the commander’s wait; unread lobby messages follow it into the match', async () => {
    const h = newHost();
    h.commanders.ensure(ALICE);
    const runnerId = h.commanders.create(ALICE, { name: 'Lobby runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
    const runner = session(h, ALICE, runnerId, 'runner');
    const waiting = runner.control.wait({ seconds: 30 });
    h.commanders.tell(ALICE, [runnerId], 'practice vs hard first');
    expect(await waiting).toEqual({
      phase: 'lobby', seat: null, you: { ready: false }, startsWhen: { kind: 'seat' }, instruction: expect.any(String),
      wake: 'owner_message', messages: [{ from: 'owner', tick: 0, text: 'practice vs hard first' }],
    });
    h.commanders.tell(ALICE, [runnerId], 'all-in at 5:00');
    const match = h.createMatch({ seed: 1, realtime: false, assignments: h.commanders.roster(ALICE).map((commander) => ({ team: 'blue', role: commander.roles[0]!, owner: ALICE, kind: commander.kind, commander: { id: commander.id } })) });
    expect(await runner.control.wait({ seconds: 10 })).toMatchObject({ phase: 'match', wake: 'owner_message', messages: [{ text: 'all-in at 5:00' }] });
    expect(h.commanders.chat(ALICE).map((e) => [e.from, e.commanderIds, e.text])).toEqual([
      ['owner', [runnerId], 'practice vs hard first'],
      ['owner', [runnerId], 'all-in at 5:00'],
    ]);
    // In-match tells through the team owner land in the roster's log as well.
    match.tell('blue', ['runner'], 'cover the guard');
    expect(h.commanders.chat(ALICE).at(-1)).toMatchObject({ from: 'owner', commanderIds: [runnerId], text: 'cover the guard' });
  });
});

describe('MCP surface', () => {
  it('game_say + messages next to the observation; the surfaceHash covers chat', async () => {
    const withoutChat = { ...manifest, control: { ...manifest.control, chat: undefined } };
    expect(surfaceHash(withoutChat as never)).not.toBe(surfaceHash(manifest));

    const { h, ids } = rosterMatch();
    const server: Server = createServer((_q, r) => void r.writeHead(404).end());
    const mounted = mountMcp(server, h);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      const token = h.commanders.token(ALICE, ids.aliceRunner);
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } }));
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('game_say');
      const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
      h.commanders.tell(ALICE, [ids.aliceRunner], ORDER);
      const obs = await call('game_observe');
      expect(obs.structuredContent).toMatchObject({ observation: { tick: 0 }, messages: [{ from: 'owner', text: ORDER }] });
      expect((await call('game_observe')).structuredContent).not.toHaveProperty('messages');
      expect((await call('game_say', { text: 'On it' })).structuredContent).toEqual({ ok: true, tick: 0 });
      expect(h.commanders.chat(ALICE).at(-1)).toMatchObject({ from: 'agent', text: 'On it' });
      expect((await call('game_say', { text: 'x'.repeat(281) })).isError).toBe(true);
    } finally {
      await client.close();
      await mounted.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
