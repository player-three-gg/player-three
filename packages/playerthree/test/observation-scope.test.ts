/**
 * Observation scope (spec §3): sections, per-role defaults, requested detail, `'all'`, policy declarations (js and
 * wasm), stream detail, built-in bots at full detail, invalid sections rejected, and fog untouched by detail.
 */
import { afterEach, describe, expect, it } from 'vitest';
import wabt from 'wabt';
import { callMethod, createPlayerThreeHost } from '../src/host/index.ts';
import type { PlayerThreeHost } from '../src/host/types.ts';
import { buildBriefing } from '../src/briefing.ts';
import { topicPage } from '../src/topics.ts';
import { toolSurface } from '../src/mcp/surface.ts';
import { defineManifest, resolveDetail, t, type GameAdapter, type GameDefinition, type MatchSides, type Seat } from '../src/index.ts';
import { loadPolicy, WASM_DETAIL_SECTION } from '../src/policy/index.ts';
import { limits } from './policy-fixtures.ts';

const TEAMS = ['north', 'south'] as const;
const SECTIONS = ['air', 'ground', 'deep'] as const;
type Team = (typeof TEAMS)[number];
type Section = (typeof SECTIONS)[number];
const team = t.enum(TEAMS);
const section = t.enum(SECTIONS);

const manifest = defineManifest({
  id: 'scoped',
  version: '1.0.0',
  title: 'Scoped',
  doc: 'Each role watches its own layer; the others arrive summarised.',
  roleDocs: { air: 'Fly.', ground: 'Walk.' },
  tickRate: 10,
  teams: team,
  roles: t.enum(['air', 'ground']),
  intents: { noop: { roles: ['air', 'ground'], params: {}, doc: 'Nothing.' } },
  observation: t.obj({
    tick: t.int(0, 1_000_000),
    team,
    detail: t.list(section, SECTIONS.length),
    /** Own units of sections in full; summaries are counts. */
    units: t.list(t.obj({ section, id: t.int(0, 1000) }), 100),
    counts: t.list(t.obj({ section, own: t.int(0, 1000) }), SECTIONS.length),
  }),
  observationScope: { sections: section, defaults: { air: ['air'], ground: ['ground'] } },
  view: t.obj({ tick: t.int(0, 1_000_000) }),
  directive: t.obj({ stance: t.enum(['any']) }),
  errors: t.enum(['out']),
  event: t.obj({ tick: t.int(0, 1_000_000), kind: t.enum(['ping']) }),
  opponents: t.enum(['idle']),
  report: t.obj({ outcome: t.enum(['win', 'loss', 'draw', 'running']) }),
  skills: [],
  topics: {},
  control: {
    intents: { perSecond: 100, burst: 100 },
    stream: { maxHz: 10, intentsPerTick: 4 },
    policy: { runtimes: ['js', 'wasm'], hz: 10, msPerCall: 200, memoryBytes: 16 << 20, maxArtifactBytes: 64 * 1024, maxIntentsPerCall: 4, maxLogLines: 20, maxLogLineBytes: 200 },
    practice: { maxTicks: 50, concurrent: 2 },
  },
});
type Scoped = typeof manifest;

/** Each team owns two units per section: north ids 0–5, south ids 10–15. Nobody sees the other team's units. */
const UNITS: Record<Team, { section: Section; id: number }[]> = {
  north: SECTIONS.flatMap((s, i) => [{ section: s, id: 2 * i }, { section: s, id: 2 * i + 1 }]),
  south: SECTIONS.flatMap((s, i) => [{ section: s, id: 10 + 2 * i }, { section: s, id: 11 + 2 * i }]),
};

class ScopedGame implements GameAdapter<Scoped> {
  readonly manifest = manifest;
  tick = 0;
  /** Every detail the adapter was asked for, as `role:sections`. */
  readonly asked: string[] = [];
  step(): void { this.tick++; }
  outcome() { return 'running' as const; }
  view() { return { tick: this.tick }; }
  observe(seat: Seat<Scoped>, _since: number, detail: readonly Section[]) {
    this.asked.push(`${seat.role}:${detail.join(',')}`);
    const own = UNITS[seat.team];
    return {
      tick: this.tick, team: seat.team, detail: [...detail],
      units: own.filter((u) => detail.includes(u.section)),
      counts: SECTIONS.filter((s) => !detail.includes(s)).map((s) => ({ section: s, own: own.filter((u) => u.section === s).length })),
    };
  }
  apply() { return { ok: true as const }; }
  report() { return { outcome: 'running' as const }; }
  events() { return []; }
  setSeatInfo(): void {}
}

const games: ScopedGame[] = [];
const botSaw: string[] = [];
const definition: GameDefinition<Scoped> = {
  manifest,
  create(_opts: { seed: number } & MatchSides<Scoped>) {
    const g = new ScopedGame();
    games.push(g);
    return g;
  },
  createBot: (seat) => ({ think: (obs) => (botSaw.push(`${seat.role}:${obs.detail.join(',')}`), []) }),
};

let host: PlayerThreeHost<Scoped> | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
  games.length = 0;
  botSaw.length = 0;
});
const idle = () => {
  host = createPlayerThreeHost({ definition });
  return host.createMatch({ seed: 1, realtime: false, controllers: { north: { air: 'none', ground: 'none' }, south: { air: 'none', ground: 'none' } } });
};
const js = (code: string) => ({ runtime: 'js' as const, code });
const LOG_DETAIL = 'function think(obs) { log(obs.detail.join(",")); return []; }';

describe('observation scope declaration', () => {
  it('validates sections and per-role defaults', () => {
    const base = { ...manifest } as Record<string, unknown>;
    const define = (scope: unknown) => () => defineManifest({ ...base, observationScope: scope } as never);
    expect(define({ sections: section, defaults: { air: ['air'] } })).toThrow(/defaults\.ground/);
    expect(define({ sections: section, defaults: { air: ['sea'], ground: [] } })).toThrow(/unknown section/);
    expect(define({ sections: section, defaults: { air: ['air', 'air'], ground: [] } })).toThrow(/duplicate/);
    expect(define({ sections: section, defaults: { air: [], ground: [], sea: [] } })).toThrow(/not a role/);
    expect(define({ sections: t.enum([] as never), defaults: { air: [], ground: [] } })).toThrow(/sections/);
    expect(define({ sections: section, defaults: { air: [], ground: [] } })).not.toThrow();
  });

  it('resolves role defaults, requested sections (manifest order) and all; rejects unknown or repeated sections', () => {
    expect(resolveDetail(manifest, 'air', undefined)).toEqual(['air']);
    expect(resolveDetail(manifest, 'ground', undefined)).toEqual(['ground']);
    expect(resolveDetail(manifest, 'ground', ['deep', 'air'])).toEqual(['air', 'ground', 'deep']);
    expect(resolveDetail(manifest, 'air', ['air'])).toEqual(['air']);
    expect(resolveDetail(manifest, 'air', 'all')).toEqual(['air', 'ground', 'deep']);
    for (const bad of [['sea'], ['air', 'air'], 'everything', [1], {}]) expect(resolveDetail(manifest, 'air', bad)).toBeNull();
  });

  it('briefs what is in full, what is summarised and how to ask for more', () => {
    const b = buildBriefing(manifest, { team: 'north', role: 'ground' });
    expect(b.observationScope).toEqual({ full: ['ground'], summary: ['air', 'deep'] });
    const topic = topicPage(manifest, 'observation').text;
    expect(topic).toContain('**Observation scope.** Sections: air, ground, deep.');
    expect(topic).toContain('air: air; ground: ground');
    const observe = toolSurface(manifest, []).find((s) => s.name === 'game_observe')!;
    expect(observe.description).toContain('`detail`');
    expect((observe.inputSchema['properties'] as Record<string, unknown>)['detail']).toBeDefined();
  });
});

describe('observation detail through the host', () => {
  it('serves role defaults, requested detail and all to observe; rejects unknown sections', async () => {
    const match = idle();
    const seat = match.seat('north', 'ground');
    expect(await seat.observe()).toMatchObject({ detail: ['ground'], counts: [{ section: 'air', own: 2 }, { section: 'deep', own: 2 }] });
    expect(await seat.observe(0, ['air'])).toMatchObject({ detail: ['air', 'ground'] });
    expect(await callMethod(seat, 'observe', { since: 0, detail: 'all' })).toMatchObject({ detail: ['air', 'ground', 'deep'], counts: [] });
    await expect(seat.observe(0, ['sea'])).rejects.toMatchObject({ code: 'invalid' });
    await expect(callMethod(seat, 'observe', { detail: ['air', 'air'] })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('never widens fog: every section in full still shows only the seat team\'s own units', async () => {
    const match = idle();
    const all = await match.seat('north', 'air').observe(0, 'all') as { units: { id: number }[] };
    expect(all.units.map((u) => u.id).sort((a, b) => a - b)).toEqual(UNITS.north.map((u) => u.id));
  });

  it('pushes stream observations at the subscription detail', async () => {
    const match = idle();
    const pushed: unknown[] = [];
    const stop = match.stream('north', 'air', 1, (obs) => pushed.push(obs), ['deep']);
    await match.step(2);
    stop();
    expect(pushed.length).toBeGreaterThan(0);
    for (const obs of pushed) expect(obs).toMatchObject({ detail: ['air', 'deep'] });
    expect(() => match.stream('north', 'air', 1, () => {}, ['sea'])).toThrow();
  });

  it('gives built-in bots every section', async () => {
    host = createPlayerThreeHost({ definition });
    const match = host.createMatch({ seed: 1, realtime: false, botLevel: { north: 'idle', south: 'idle' } });
    await match.step(2);
    expect(botSaw.length).toBeGreaterThan(0);
    expect(new Set(botSaw)).toEqual(new Set(['air:air,ground,deep', 'ground:air,ground,deep']));
  });
});

describe('policy detail', () => {
  it('scopes policies to role defaults unless they declare more (deploy probe, live think, practice)', async () => {
    const match = idle();
    const seat = match.seat('north', 'ground');
    const scoped = await seat.policyDeploy(js(LOG_DETAIL));
    expect(scoped).toMatchObject({ ok: true, probe: { logs: ['ground'] } });
    const wide = await seat.policyDeploy(js(`const detail = ['deep']; ${LOG_DETAIL}`));
    expect(wide).toMatchObject({ ok: true, probe: { logs: ['ground,deep'] } });
    match.setController('north', 'ground', 'agent');
    await match.step(2);
    const status = await seat.policyStatus();
    expect(status && 'logs' in status ? status.logs.at(-1) : undefined).toBe('ground,deep');
    const all = await seat.practice({ opponent: 'idle', ticks: 3, artifact: js(`var detail = 'all'; ${LOG_DETAIL}`) });
    expect(all).toMatchObject({ ok: true, policy: { logs: expect.arrayContaining(['air,ground,deep']) } });
  });

  it('rejects malformed or unknown declared sections at load', async () => {
    const match = idle();
    const seat = match.seat('north', 'air');
    for (const decl of [`var detail = ['sea'];`, 'var detail = 5;', `var detail = ['air', 'air'];`, 'var detail = function () {};']) {
      expect(await seat.policyDeploy(js(`${decl} ${LOG_DETAIL}`)), decl).toMatchObject({ ok: false, error: { code: 'bad_output' } });
    }
  });

  it('reads a wasm policy\'s detail from its custom section, before any code runs', async () => {
    const w = await wabt();
    const body = `(memory (export "memory") 1 1) (func (export "alloc") (param i32) (result i32) (i32.const 0))
      (func (export "think") (param i32 i32) (result i64) (i64.const 0))`;
    const module = (custom: string | null) => {
      const m = w.parseWat('p.wat', `(module ${body})`);
      const bytes = m.toBinary({}).buffer;
      m.destroy();
      if (custom === null) return bytes;
      const name = new TextEncoder().encode(WASM_DETAIL_SECTION);
      const data = new TextEncoder().encode(custom);
      const payload = [name.length, ...name, ...data];
      return new Uint8Array([...bytes, 0, payload.length, ...payload]);
    };
    const lim = limits({ runtimes: ['wasm'] });
    const none = await loadPolicy('wasm', module(null), lim);
    const declared = await loadPolicy('wasm', module('["deep"]'), lim);
    const all = await loadPolicy('wasm', module('"all"'), lim);
    try {
      expect(none.ok && none.instance.detail).toBeUndefined();
      expect(declared.ok && declared.instance.detail).toEqual(['deep']);
      expect(all.ok && all.instance.detail).toBe('all');
    } finally {
      for (const r of [none, declared, all]) if (r.ok) r.instance.dispose();
    }
    expect(await loadPolicy('wasm', module('{"x":1}'), lim)).toMatchObject({ ok: false, error: { code: 'bad_output' } });
  });

  it('reads a js policy\'s detail as a global binding of any kind', async () => {
    for (const decl of ["var detail = ['air'];", "let detail = ['air'];", "globalThis.detail = ['air'];"]) {
      const r = await loadPolicy('js', `${decl} function think() { return []; }`, limits());
      expect(r.ok && r.instance.detail, decl).toEqual(['air']);
      if (r.ok) r.instance.dispose();
    }
  });
});
