/**
 * Knowledge budgets: every default tool result an agent receives (the MCP text content, as the endpoint serialises
 * it) stays within RESULT_TEXT_MAX and every topic page within TOPIC_TEXT_MAX — for the tag example and for a
 * synthetic game that maxes out docs, topics, schemas, match data, skill files and observations.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { definition as tag, EXAMPLE_POLICY } from '../examples/tag/index.ts';
import { buildBriefing, servedSkills } from '../src/briefing.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeMatch } from '../src/host/types.ts';
import {
  defineManifest,
  RESULT_TEXT_MAX,
  SKILL_PAGE_MAX,
  TOPIC_TEXT_MAX,
  type AnyManifest,
  type GameAdapter,
  type GameDefinition,
} from '../src/manifest.ts';
import { mergeObservationPages, mountMcp } from '../src/mcp/index.ts';
import { referenceSkill } from '../src/skill.ts';
import { t } from '../src/schema.ts';
import { briefingTopics } from '../src/topics.ts';

// ------------------------------------------------------------------ synthetic maximal game

/** Prose of exactly `n` code units with newlines, quotes and backslashes (JSON escaping grows it). */
const prose = (n: number, seed: string): string => {
  const line = `${seed}: "quoted" rule \\ with a path and some text that wraps the line. `;
  let out = '';
  while (out.length < n) out += out.length % 400 < line.length ? `${line}\n` : line;
  return out.slice(0, n);
};
const doc200 = (what: string): string => prose(200, what).replace(/\n/g, ' ');

const ROLES = ['alpha', 'beta', 'gamma'] as const;
const KINDS = Array.from({ length: 20 }, (_, i) => `order${i}`) as [string, ...string[]];
const UNIT_KINDS = Array.from({ length: 24 }, (_, i) => `Kind${i}`) as [string, ...string[]];
const unit = t.obj({
  id: t.id('u', doc200('unit id')),
  kind: t.enum(UNIT_KINDS, doc200('unit kind')),
  x: t.int(0, 1000, doc200('column')),
  y: t.int(0, 1000, doc200('row')),
  hp: t.int(0, 100_000, doc200('hit points')),
  order: t.obj({ kind: t.enum(KINDS), target: t.opt(t.id('u')), x: t.int(0, 1000), y: t.int(0, 1000) }, doc200('current order')),
});
const MAX_UNITS = 2_000;
const bigManifest = defineManifest({
  id: 'big',
  version: '1.0.0',
  title: 'Big',
  doc: prose(6_000, 'core'),
  roleDocs: Object.fromEntries(ROLES.map((r) => [r, prose(3_500, r)])),
  topics: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`guide/part-${i}`, { summary: doc200(`summary ${i}`).slice(0, 140), text: prose(8_000, `topic ${i}`) }])),
  tickRate: 20,
  teams: t.enum(['north', 'south']),
  roles: t.enum(ROLES),
  // Every intent's doc and params ride in game_act and game_sequence: one kind sits at the doc and param-doc limits,
  // the others stay small so the surface keeps within the tool-surface budget (spec §4) that every model turn carries.
  intents: Object.fromEntries(KINDS.map((kind, i) => [kind, i === 0 ? {
    roles: [...ROLES],
    params: Object.fromEntries(Array.from({ length: 12 }, (_, j) => [`p${j}`, j % 2 ? t.int(0, 1000, doc200(`param ${j}`)) : t.opt(t.enum(UNIT_KINDS, doc200(`param ${j}`)))])),
    doc: prose(4_000, `intent ${i}`),
  } : {
    roles: [...ROLES],
    params: { unit: t.id('u'), x: t.int(0, 1000), y: t.opt(t.int(0, 1000)) },
    doc: doc200(`intent ${i}`),
  }])),
  observation: t.obj({
    tick: t.int(0, 1_000_000),
    team: t.enum(['north', 'south']),
    stats: t.obj(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, t.int(0, 1_000_000, doc200(`stat ${i}`))]))),
    units: t.list(unit, MAX_UNITS, doc200('own units')),
    enemies: t.list(unit, MAX_UNITS, doc200('visible enemy units')),
    events: t.list(t.obj({ tick: t.int(0, 1_000_000), kind: t.enum(['hit', 'lost']) }), 64),
  }),
  view: t.obj({ tick: t.int(0, 1_000_000) }),
  matchData: t.obj({ seed: t.int(0, 1_000_000), cells: t.ints(12_000, 0, 999_999, 'terrain cells'), spawns: t.list(t.obj({ x: t.int(0, 1000), y: t.int(0, 1000) }), 500) }),
  directive: t.obj(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`d${i}`, t.enum(['low', 'mid', 'high'], doc200(`directive ${i}`))]))),
  limits: t.obj(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`l${i}`, t.opt(t.bool(doc200(`limit ${i}`)))]))),
  errors: t.enum(['blocked', 'busy_unit'], doc200('errors')),
  opponents: t.enum(['easy', 'hard']),
  report: t.obj(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`r${i}`, t.int(0, 1_000_000, doc200(`report ${i}`))]))),
  event: t.obj({ tick: t.int(0, 1_000_000), kind: t.enum(['hit', 'lost']), unit: t.id('u', doc200('event unit')) }),
  skills: [1, 2].map((n) => ({
    name: `big-strategy-${n}`,
    description: prose(1_024, `skill ${n}`).replace(/\n/g, ' '),
    files: {
      'SKILL.md': `---\nname: big-strategy-${n}\ndescription: "strategy ${n}"\n---\n\n${prose(7_900, 'strategy')}`,
      'guide/long.md': prose(65_000, 'long guide'),
      'guide/one-line.md': 'x'.repeat(45_000),
      'policies/lib.js': `// lib\n${prose(20_000, '// helper')}`,
    },
  })),
  control: {
    intents: { perSecond: 1000, burst: 64 },
    policy: { runtimes: ['js'], hz: 5, msPerCall: 50, memoryBytes: 32 << 20, maxArtifactBytes: 200_000, maxIntentsPerCall: 8, maxLogLines: 50, maxLogLineBytes: 200 },
    practice: { maxTicks: 100, concurrent: 1 },
    chat: { maxTellChars: 500, maxSayChars: 280 },
  },
});
type Big = typeof bigManifest;

const units = (team: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `u_${i + 1}`, kind: UNIT_KINDS[i % UNIT_KINDS.length]!, x: i % 1000, y: (i * 7) % 1000, hp: 99_999, order: { kind: KINDS[i % KINDS.length]!, x: 999, y: 999, ...(i % 2 ? { target: `u_${i}` } : {}) } }))
    .map((u) => (team === 'north' ? u : { ...u, hp: 1 }));

const bigDefinition: GameDefinition<Big> = {
  manifest: bigManifest,
  create: () => {
    const game = {
      manifest: bigManifest,
      tick: 0,
      step() { game.tick++; },
      outcome: () => 'running' as const,
      view: () => ({ tick: game.tick }),
      observe: (seat: { team: string }) => ({
        tick: game.tick,
        team: seat.team,
        stats: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, 999_999])),
        units: units(seat.team, MAX_UNITS),
        enemies: units(seat.team === 'north' ? 'south' : 'north', 600),
        events: [],
      }),
      matchData: () => ({ seed: 7, cells: Array.from({ length: 12_000 }, (_, i) => 900_000 + i), spawns: Array.from({ length: 500 }, (_, i) => ({ x: i, y: 999 })) }),
      apply: () => ({ ok: true as const }),
      report: () => Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`r${i}`, 999_999])),
      events: () => [],
      setSeatInfo() {},
    };
    return game as unknown as GameAdapter<Big>;
  },
  createBot: () => ({ think: () => [] }),
};

// ------------------------------------------------------------------ endpoint

interface Endpoint {
  host: PlayerThreeHost;
  match: PlayerThreeMatch;
  url: string;
  close(): Promise<void>;
}

async function startEndpoint(definition: GameDefinition, teams: [string, string]): Promise<Endpoint> {
  const host = createPlayerThreeHost({ definition });
  const roles = definition.manifest.roles.values as readonly string[];
  const seats = (controller: 'agent' | 'none') => Object.fromEntries(roles.map((r) => [r, controller]));
  const match = host.createMatch({ seed: 3, realtime: false, controllers: { [teams[0]]: seats('agent'), [teams[1]]: seats('none') } });
  const server: Server = createServer((_req, res) => res.writeHead(404).end());
  const mounted = mountMcp(server, host);
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  return {
    host, match,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    async close() {
      await mounted.close();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      host.dispose();
    },
  };
}

async function connect(url: string, token: string, protocol: 'modern' | 'legacy' = 'modern'): Promise<Client> {
  const client = new Client({ name: 'budget', version: '1.0.0' }, { versionNegotiation: { mode: protocol === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } });
  let sessionId: string | undefined;
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    authProvider: { token: async () => token },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (sessionId) headers.set('mcp-session-id', sessionId);
      const response = await fetch(input, { ...init, headers });
      if (response.ok) sessionId = response.headers.get('mcp-session-id') ?? sessionId;
      return response;
    },
  }));
  return client;
}

/** All text content of a result, as an agent receives it. */
const textOf = (r: CallToolResult): string => r.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');

/**
 * A successful call, with its text within budget. This test makes far more reads than the per-credential call budget
 * allows per second: a rate-limited call moves the (faked) clock past the refill instead of sleeping.
 */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; structured: Record<string, unknown> }> {
  for (;;) {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = textOf(r);
    if (r.isError && text.includes('rate_limited')) {
      vi.setSystemTime(Date.now() + 2_000);
      continue;
    }
    expect(r.isError, `${name} ${JSON.stringify(args)}: ${text.slice(0, 200)}`).toBeFalsy();
    expect(text.length, `${name} ${JSON.stringify(args)}`).toBeLessThanOrEqual(RESULT_TEXT_MAX);
    return { text, structured: r.structuredContent as Record<string, unknown> };
  }
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
});
afterAll(() => {
  vi.useRealTimers();
});

/** Reads every page of every topic in the index through game_briefing; returns the topics seen. */
async function readAllTopics(client: Client, manifest: AnyManifest, role: string): Promise<string[]> {
  const seen: string[] = [];
  for (const topic of briefingTopics(manifest)) {
    let page = 1;
    for (;;) {
      const r = await call(client, 'game_briefing', { topic: topic.name, page, role });
      const s = r.structured as { text: string; pages: number; next?: { page: number } };
      expect(s.text.length, `${topic.name} page ${page}`).toBeLessThanOrEqual(TOPIC_TEXT_MAX);
      if (s.pages > 1) expect(r.text).toMatch(/\n\[page \d+\/\d+.*\]$/);
      else expect(r.text).toBe(s.text);
      if (!s.next) break;
      page = s.next.page;
    }
    seen.push(topic.name);
  }
  return seen;
}

/** Reads every served skill file through game_skill windows; checks the windows reassemble the file. */
async function readAllSkills(client: Client, manifest: AnyManifest): Promise<number> {
  let windows = 0;
  for (const skill of servedSkills(manifest)) {
    for (const [path, content] of Object.entries(skill.files)) {
      let offset = 0;
      let text = '';
      for (;;) {
        const r = await call(client, 'game_skill', offset === 0 ? { name: skill.name, path } : { name: skill.name, path, offset });
        const s = r.structured as { text: string; next?: number; total: number };
        expect(s.text.length).toBeLessThanOrEqual(SKILL_PAGE_MAX);
        expect(s.total).toBe(content.length);
        if (s.next !== undefined) {
          expect(r.text).toContain(`[… continues: game_skill ${JSON.stringify({ name: skill.name, path, offset: s.next })}]`);
          // Cut after a newline whenever the window has one.
          if (s.text.includes('\n')) expect(s.text.endsWith('\n')).toBe(true);
        } else expect(r.text).toBe(s.text);
        text += s.text;
        windows++;
        if (s.next === undefined) break;
        offset = s.next;
      }
      expect(text, `${skill.name}/${path}`).toBe(content);
    }
  }
  return windows;
}

// ------------------------------------------------------------------ tests

describe('knowledge budgets: tag example', () => {
  let ep: Endpoint;
  let client: Client;
  beforeAll(async () => {
    ep = await startEndpoint(tag, ['blue', 'red']);
    client = await connect(ep.url, ep.match.mintSeatToken('blue', 'runner'));
  });
  afterAll(async () => {
    await client.close();
    await ep.close();
  });

  it('keeps every tool result within RESULT_TEXT_MAX', { timeout: 60_000 }, async () => {
    const core = await call(client, 'game_briefing', {});
    expect(core.structured['topics']).toEqual(expect.arrayContaining([expect.stringMatching(/^tactics — /)]));
    const topics = await readAllTopics(client, tag.manifest, 'runner');
    expect(topics).toContain('schema/observation');
    await readAllSkills(client, tag.manifest);
    for (const [name, args] of [
      ['game_observe', {}],
      ['game_act', { intents: [{ kind: 'stop' }] }],
      ['game_wait', { seconds: 0 }],
      ['policy_deploy', { runtime: 'js', code: EXAMPLE_POLICY }],
      ['policy_status', {}],
      ['practice_run', { opponent: 'easy', ticks: 20, seed: 1 }],
      ['game_say', { text: 'ok' }],
    ] as const) await call(client, name, args);
  });
});

describe('knowledge budgets: synthetic maximal game', () => {
  let ep: Endpoint;
  beforeAll(async () => {
    ep = await startEndpoint(bigDefinition as unknown as GameDefinition, ['north', 'south']);
  });
  afterAll(() => ep.close());

  it('validates a manifest at every knowledge limit and keeps the reference skill within its budgets', () => {
    const reference = referenceSkill(bigManifest);
    expect(reference.files['SKILL.md']!.length).toBeLessThanOrEqual(8_000);
    for (const [path, text] of Object.entries(reference.files)) expect(text.length, path).toBeLessThanOrEqual(TOPIC_TEXT_MAX);
    // Lobby core briefings (no MCP `commands` yet: allow for them) are within budget too.
    for (const role of ROLES) expect(JSON.stringify(buildBriefing(bigManifest, { role })).length + 200).toBeLessThanOrEqual(RESULT_TEXT_MAX);
    for (const topic of briefingTopics(bigManifest)) for (const page of topic.pages) expect(page.length, topic.name).toBeLessThanOrEqual(TOPIC_TEXT_MAX);
  });

  it('keeps the core briefing, every topic page and every skill window within budget over MCP', { timeout: 120_000 }, async () => {
    const clients = await Promise.all(ROLES.map((role) => connect(ep.url, ep.match.mintSeatToken('north', role))));
    try {
      for (const client of clients) {
        const core = await call(client, 'game_briefing', {});
        expect(core.structured['topics']).toHaveLength(30 + 13);
      }
      const seen = await readAllTopics(clients[0]!, bigManifest, 'alpha');
      expect(seen).toEqual(expect.arrayContaining(['guide/part-29', 'intent/order19', 'schema/intent/order19', 'observation/units', 'match-data/fields', 'types', 'types/alpha']));
      // The live match-data topic pages the seat's bootstrap (≈ 90 KB) by key and by list items.
      const first = await call(clients[1]!, 'game_briefing', { topic: 'match-data' });
      expect((first.structured as { pages: number }).pages).toBeGreaterThan(5);
      expect(await readAllSkills(clients[2]!, bigManifest)).toBeGreaterThan(20);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });

  it('pages an oversize observation from one snapshot and narrows it with fields', { timeout: 60_000 }, async () => {
    const client = await connect(ep.url, ep.match.mintSeatToken('north', 'alpha'));
    try {
      const full = await ep.match.seat('north', 'alpha').observe();
      expect(JSON.stringify(full).length).toBeGreaterThan(5 * RESULT_TEXT_MAX);
      const pages: { observation: Record<string, unknown> }[] = [];
      let r = await call(client, 'game_observe', {});
      const total = (r.structured as { pages: number }).pages;
      expect(total).toBeGreaterThan(5);
      expect(r.structured).toMatchObject({ page: 1, tick: 0, next: { page: 2 } });
      expect(Object.keys(r.structured['observation'] as object).slice(0, 3)).toEqual(['tick', 'team', 'stats']);
      expect(r.text).toMatch(/\n\[observation page 1\/\d+ of the snapshot at tick 0 — next: game_observe \{"page":2\}/);
      pages.push(r.structured as { observation: Record<string, unknown> });
      for (let page = 2; page <= total; page++) {
        r = await call(client, 'game_observe', { page });
        expect(r.structured['page']).toBe(page);
        pages.push(r.structured as { observation: Record<string, unknown> });
      }
      expect(mergeObservationPages(pages)).toEqual(full);
      const items = pages.flatMap((p) => Object.entries((p as { items?: Record<string, { from: number; to: number; of: number }> }).items ?? {}));
      expect(items.filter(([path]) => path === 'units').map(([, range]) => range.of)).toEqual(Array(items.filter(([path]) => path === 'units').length).fill(MAX_UNITS));
      const narrow = await call(client, 'game_observe', { fields: ['tick', 'stats'] });
      expect(narrow.structured).not.toHaveProperty('page');
      expect(Object.keys(narrow.structured['observation'] as object)).toEqual(['tick', 'stats']);
      // `fields` is a closed enum of top-level keys; a page past the snapshot is invalid.
      expect(textOf((await client.callTool({ name: 'game_observe', arguments: { fields: ['nope'] } })) as CallToolResult)).toContain('invalid');
      expect(textOf((await client.callTool({ name: 'game_observe', arguments: { page: 2 } })) as CallToolResult)).toContain('invalid');
    } finally {
      await client.close();
    }
  });

  it.each(['modern', 'legacy'] as const)('keeps owner messages outside %s observation pages and field projections', async (protocol) => {
    const client = await connect(ep.url, ep.match.mintSeatToken('north', 'alpha'), protocol);
    try {
      const sender = ep.host.authenticate(ep.match.tokens.teams['north']!)!.principal;
      expect(await ep.match.handleMessage(sender, { op: 'tell', seq: 1, roles: ['alpha'], text: 'Before page one' })).toMatchObject({ ok: true });
      const first = await call(client, 'game_observe', {});
      expect(first.structured).toMatchObject({
        page: 1, next: { page: 2 }, messages: [{ from: 'owner', text: 'Before page one' }],
      });
      expect(first.structured['observation']).not.toHaveProperty('messages');
      expect(first.text).toContain('Before page one');
      expect(ep.match.status('north', 'alpha').unreadOwnerMessages).toBe(0);

      expect(await ep.match.handleMessage(sender, { op: 'tell', seq: 2, roles: ['alpha'], text: 'While reading pages' })).toMatchObject({ ok: true });
      const uri = (await client.listResources()).resources.find((resource) => resource.name === 'alpha')!.uri;
      const status = await client.readResource({ uri }, { cacheMode: 'bypass' });
      expect(JSON.stringify(status)).not.toContain('While reading pages');
      const next = await call(client, 'game_observe', { page: 2 });
      expect(next.structured).toMatchObject({ page: 2, tick: first.structured['tick'] });
      expect(next.structured).not.toHaveProperty('messages');
      expect(ep.match.status('north', 'alpha').unreadOwnerMessages).toBe(1);

      const fresh = await call(client, 'game_observe', { fields: ['tick'] });
      expect(fresh.structured).toEqual({
        observation: { tick: ep.match.tick },
        messages: [{ from: 'owner', tick: ep.match.tick, text: 'While reading pages' }],
      });
      expect(fresh.text).toContain('While reading pages');
      expect(ep.match.status('north', 'alpha').unreadOwnerMessages).toBe(0);
    } finally {
      await client.close();
    }
  });
});
