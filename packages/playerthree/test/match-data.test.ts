import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { afterEach, describe, expect, it } from 'vitest';
import { manifest as tag } from '../examples/tag/index.ts';
import { surfaceHash } from '../src/briefing.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import type { PlayerThreeHost, PlayerThreeTraceEvent } from '../src/host/types.ts';
import type { SeatControl } from '../src/control.ts';
import { defineManifest, MATCH_DATA_MAX_BYTES, type GameDefinition, type Seat } from '../src/manifest.ts';
import { toolSurface } from '../src/mcp/surface.ts';
import { t } from '../src/schema.ts';

const bootstrap = t.obj({ team: tag.teams, cells: t.list(t.int(0, 10), 4) });
const manifest = defineManifest({
  ...tag,
  matchData: bootstrap,
  observation: t.obj({ tick: t.int(0, 2000), team: tag.teams, rulesHash: t.int(0, 0xffffffff) }),
  view: t.obj({ tick: t.int(0, 2000) }),
  report: t.obj({ score: t.int(0, 10) }),
  control: { ...tag.control, policy: { ...tag.control.policy, msPerCall: 100 } },
});
type Manifest = typeof manifest;
const OWNER = 'bootstrap_owner_0001';
const policy = {
  runtime: 'js' as const,
  code: `var match, initialized = 0;
  function init(data) { if (initialized++) throw new Error('repeated init'); match = data; }
  function think(obs) {
    if (obs.match !== undefined || obs.rules !== undefined) throw new Error('static observation');
    if (!match || match.team !== obs.team || obs.rulesHash !== 17) throw new Error('missing bootstrap');
    log(obs.tick, match.team); return [];
  }`,
};
const idle = { blue: { runner: 'none', guard: 'none' }, red: { runner: 'none', guard: 'none' } } as const;
const period = Math.max(1, Math.round(manifest.tickRate / manifest.control.policy.hz));
const hosts: PlayerThreeHost<Manifest>[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); });

function fixture() {
  const observations: { seat: Seat<Manifest>; tick: number; argc: number }[] = [];
  const bots: { seat: Seat<Manifest>; inits: number; calls: number }[] = [];
  const data = { blue: { team: 'blue' as const, cells: [1, 2] }, red: { team: 'red' as const, cells: [3, 4] } };
  let poison = false;
  let poisonObservation = false;
  const definition: GameDefinition<Manifest> = {
    manifest,
    create() {
      let tick = 0;
      return {
        manifest,
        get tick() { return tick; },
        step() { tick++; },
        outcome() { return 'running'; },
        view() { return { tick }; },
        observe(seat, _since) {
          observations.push({ seat, tick, argc: arguments.length });
          return { tick, team: seat.team, rulesHash: 17, ...(poisonObservation ? { injected: 'SECRET' } : {}) };
        },
        matchData(seat) { return poison ? { ...data[seat.team], injected: 'SECRET' } : data[seat.team]; },
        apply() { return { ok: true }; },
        report() { return { score: 0 }; },
        events() { return []; },
        setSeatInfo() {},
      };
    },
    createBot(seat) {
      const record = { seat, inits: 0, calls: 0 };
      bots.push(record);
      let cached: typeof data.blue | typeof data.red | undefined;
      return {
        init(matchData) {
          expect(record.inits++).toBe(0);
          expect(matchData?.team).toBe(seat.team);
          cached = matchData ?? undefined;
        },
        think(obs) {
          expect(record.inits).toBe(1);
          expect(cached?.team).toBe(seat.team);
          expect(obs).toEqual({ tick: obs.tick, team: seat.team, rulesHash: 17 });
          record.calls++;
          return [];
        },
      };
    },
  };
  const host = createPlayerThreeHost({ definition });
  hosts.push(host);
  return { host, definition, data, observations, bots, poison: () => { poison = true; }, poisonObservation: (value: boolean) => { poisonObservation = value; } };
}
/** A named runner commander of OWNER (the named-commander API addresses commanders by id, not role). */
function runnerCommander(host: PlayerThreeHost<Manifest>): { id: string; control: SeatControl } {
  host.commanders.ensure(OWNER);
  const id = host.commanders.create(OWNER, { name: 'Runner', kind: 'agent', roles: ['runner'], isolation: { independentSessions: true } }).id;
  return { id, control: host.agentSession(host.commanders.token(OWNER, id))!.control };
}

/** The `key: JSON` lines of a one-page match-data topic, as an object. */
function topicData(text: string): Record<string, unknown> {
  return Object.fromEntries(text.split('\n').flatMap((line) => {
    const m = /^([A-Za-z_]\w*): (.*)$/.exec(line);
    return m ? [[m[1]!, JSON.parse(m[2]!) as unknown]] : [];
  }));
}

describe('separate match bootstrap protocol', () => {
  it('serves guarded seat-visible snapshots as the match-data topic only in a match; even first observations stay dynamic', async () => {
    const f = fixture();
    const commander = runnerCommander(f.host).control;
    const lobby = await commander.briefing();
    expect(lobby).not.toHaveProperty('matchData');
    expect((await commander.briefing('match-data')).text).toContain('`cells`');
    const match = f.host.createMatch({ realtime: false, controllers: idle });
    const blue = await match.seat('blue', 'runner').briefing('match-data');
    const red = await match.seat('red', 'guard').briefing('match-data');
    expect(topicData(blue.text)).toEqual(f.data.blue);
    expect(topicData(red.text)).toEqual(f.data.red);
    f.data.blue.cells[0] = 9;
    expect(topicData(blue.text)).toEqual({ team: 'blue', cells: [1, 2] });
    expect(await match.seat('blue', 'runner').observe()).toEqual({ tick: 0, team: 'blue', rulesHash: 17 });
    // (seat, since, detail): the bootstrap never rides along as an extra argument.
    expect(f.observations.at(-1)?.argc).toBe(3);
    const core = await match.seat('blue', 'runner').briefing();
    expect(core).not.toHaveProperty('matchData');
    expect(core.surfaceHash).toBe(lobby.surfaceHash);
    expect(core.surfaceHash).toBe(surfaceHash(manifest));
  });

  it('rejects invalid bootstrap without leaking its contents', async () => {
    const f = fixture();
    const traces: PlayerThreeTraceEvent[] = [];
    f.host.onTrace((event) => traces.push(event));
    const match = f.host.createMatch({ realtime: false, controllers: idle });
    await match.seat('blue', 'runner').briefing('match-data');
    f.poison();
    await expect(match.seat('blue', 'runner').briefing('match-data')).rejects.toMatchObject({ code: 'internal' });
    expect(traces).toContainEqual(expect.objectContaining({ type: 'guard_drop', channel: 'matchData', code: 'unknown_field', path: ['?'] }));
    expect(JSON.stringify(traces)).not.toContain('SECRET');
  });

  it('enforces the independent bootstrap byte bound for briefings, deployment, bots and practice', async () => {
    const f = fixture();
    const traces: PlayerThreeTraceEvent[] = [];
    f.host.onTrace((event) => traces.push(event));
    const match = f.host.createMatch({ realtime: false, controllers: idle });
    f.data.blue.cells = Array<number>(MATCH_DATA_MAX_BYTES).fill(1);
    await expect(match.seat('blue', 'runner').briefing('match-data')).rejects.toMatchObject({ code: 'internal' });
    await expect(match.seat('blue', 'runner').policyDeploy(policy)).rejects.toMatchObject({ code: 'internal' });
    expect(() => match.setController('blue', 'runner', 'bot')).toThrow('internal');
    expect(await match.seat('blue', 'runner').practice({ opponent: 'idle', ticks: 1, artifact: policy })).toMatchObject({ ok: false, code: 'guard' });
    expect(traces).toContainEqual(expect.objectContaining({ type: 'guard_drop', channel: 'matchData', code: 'too_long', path: [] }));
    expect(f.observations).toEqual([]);
  });

  it('requires the adapter method in matches, lobby probes and practice', async () => {
    const f = fixture();
    const definition: GameDefinition<Manifest> = { ...f.definition, create(options) {
      const game = f.definition.create(options);
      delete game.matchData;
      return game;
    } };
    const host = createPlayerThreeHost({ definition });
    hosts.push(host);
    expect(() => host.createMatch({ realtime: false })).toThrow('internal');
    const commander = runnerCommander(host).control;
    await expect(commander.policyDeploy(policy)).rejects.toMatchObject({ code: 'internal' });
    expect(await commander.practice({ opponent: 'idle', ticks: 1, artifact: policy })).toMatchObject({ ok: false, code: 'guard' });
  });

  it('declares a closed MCP briefing output without bootstrap data in either phase', async () => {
    const f = fixture();
    const lobby = await runnerCommander(f.host).control.briefing();
    const match = f.host.createMatch({ realtime: false, controllers: idle });
    const briefing = await match.seat('blue', 'runner').briefing();
    const schema = toolSurface(manifest, []).find((tool) => tool.method === 'briefing')!.outputSchema;
    const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
    const commands = [{ role: 'runner', phase: 'match', team: 'blue' }];
    expect(validate({ ...briefing, commands }).valid).toBe(true);
    expect(validate({ ...lobby, commands: [{ role: 'runner', phase: 'lobby' }] }).valid).toBe(true);
    expect(validate({ ...briefing, matchData: f.data.blue, commands }).valid).toBe(false);
    expect(validate(await match.seat('blue', 'runner').briefing('match-data')).valid).toBe(true);
  });

  it('keeps every stream observation dynamic-only, including new subscriptions', async () => {
    const f = fixture();
    const match = f.host.createMatch({ realtime: false, controllers: idle });
    const received: unknown[] = [];
    const stop = match.stream('blue', 'runner', 1, (obs) => received.push(obs));
    await match.step(4);
    stop();
    expect(received).toEqual([1, 2, 3, 4].map((tick) => ({ tick, team: 'blue', rulesHash: 17 })));
    match.stream('blue', 'runner', 1, (obs) => received.push(obs));
    await match.step(1);
    expect(received.at(-1)).toEqual({ tick: 5, team: 'blue', rulesHash: 17 });
    expect(f.observations.every((obs) => obs.argc === 3)).toBe(true);
  });

  it('initializes native bots once per instance, including fallback and controller resets', async () => {
    const f = fixture();
    const match = f.host.createMatch({ realtime: false, controllers: { ...idle, blue: { runner: 'bot', guard: 'none' } } });
    await match.step(period * 2);
    const first = f.bots.find((bot) => bot.seat.team === 'blue' && bot.seat.role === 'runner')!;
    expect(first).toMatchObject({ inits: 1, calls: 2 });
    match.setController('blue', 'runner', 'agent');
    await match.step(period * 2);
    const fresh = f.bots.filter((bot) => bot.seat.team === 'blue' && bot.seat.role === 'runner').at(-1)!;
    expect(fresh).not.toBe(first);
    expect(fresh).toMatchObject({ inits: 1, calls: 2 });
  });

  it('initializes bots recreated by a commander bot-level change', async () => {
    const f = fixture();
    const runner = runnerCommander(f.host);
    const match = f.host.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: runner.id } }, { team: 'blue', role: 'guard', owner: OWNER, kind: 'agent' }] });
    await match.step(period * 2);
    f.host.commanders.update(OWNER, runner.id, { botLevel: 'idle' });
    await match.step(period * 2);
    const fresh = f.bots.filter((bot) => bot.seat.team === 'blue' && bot.seat.role === 'runner').at(-1)!;
    expect(fresh).toMatchObject({ inits: 1, calls: 2 });
  });

  it('fails closed on bot observation guards without reinitializing the consumer', async () => {
    const f = fixture();
    const match = f.host.createMatch({ realtime: false, controllers: { ...idle, blue: { runner: 'bot', guard: 'none' } } });
    f.poisonObservation(true);
    await match.step(period);
    const bot = f.bots.find((bot) => bot.seat.team === 'blue' && bot.seat.role === 'runner')!;
    expect(bot).toMatchObject({ inits: 1, calls: 0 });
    f.poisonObservation(false);
    await match.step(period * 2);
    expect(bot).toMatchObject({ inits: 1, calls: 2 });
  });

  it('initializes deployment probes, live activations, redeploys and rollbacks', async () => {
    const f = fixture();
    const match = f.host.createMatch({ realtime: false, controllers: { ...idle, blue: { runner: 'agent', guard: 'none' } } });
    const seat = match.seat('blue', 'runner');
    expect(await seat.policyDeploy(policy)).toMatchObject({ ok: true, probe: { errors: 0, logs: ['0 blue'] } });
    await match.step(period * 2);
    expect(await seat.policyStatus()).toMatchObject({ calls: 2, errors: 0, logs: ['0 blue', `${period} blue`] });
    expect(await seat.policyDeploy(policy)).toMatchObject({ ok: true, version: 2 });
    await match.step(period);
    expect(await seat.policyStatus()).toMatchObject({ calls: 1, errors: 0, logs: [`${period * 2} blue`] });
    expect(await seat.policyRollback(1)).toMatchObject({ ok: true, version: 1 });
    await match.step(period);
    expect(await seat.policyStatus()).toMatchObject({ calls: 1, errors: 0, logs: [`${period * 3} blue`] });
    expect(f.observations.every((obs) => obs.argc === 3)).toBe(true);
  });

  it('initializes lobby probes, library reloads, practice policies and practice bots', async () => {
    const f = fixture();
    const runner = runnerCommander(f.host);
    const commander = runner.control;
    expect(await commander.policyDeploy(policy)).toMatchObject({ ok: true, probe: { logs: ['0 blue'] } });
    expect(await commander.practice({ opponent: 'idle', ticks: period * 2, seed: 1 })).toMatchObject({ ok: true, policy: { calls: 2, errors: 0, logs: ['0 blue', `${period} blue`] } });
    for (const bot of f.bots.filter((bot) => bot.calls)) expect(bot).toMatchObject({ inits: 1, calls: 2 });
    for (let i = 0; i < 2; i++) {
      const match = f.host.createMatch({ realtime: false, assignments: [{ team: 'blue', role: 'runner', owner: OWNER, kind: 'agent', commander: { id: runner.id } }, { team: 'blue', role: 'guard', owner: OWNER, kind: 'agent' }] });
      await match.step(period * 2);
      expect(await commander.policyStatus()).toMatchObject({ calls: 2, errors: 0, logs: ['0 blue', `${period} blue`] });
      match.dispose();
    }
  });

  it('initializes drafted pool policies', async () => {
    const f = fixture();
    const author = f.host.createMatch({ realtime: false, controllers: idle });
    const seat = author.seat('blue', 'runner');
    expect(await seat.policyDeploy(policy)).toMatchObject({ ok: true });
    const published = await seat.publish();
    if (!('policyId' in published)) throw new Error('expected published policy');
    const match = f.host.createMatch({ realtime: false, controllers: idle });
    match.setController('red', 'runner', 'policy', { poolPolicy: published.policyId });
    await match.step(period * 2);
    expect(f.observations.filter((obs) => obs.seat.team === 'red' && obs.seat.role === 'runner')).toHaveLength(3); // activation probe + two live calls
    expect(f.observations.every((obs) => obs.argc === 3)).toBe(true);
  });

  it('uses a clean live VM after the seat probe, with init once and an isolated bootstrap per instance', async () => {
    const f = fixture();
    const match = f.host.createMatch({ realtime: false, controllers: { ...idle, blue: { runner: 'agent', guard: 'none' } } });
    const artifact = {
      runtime: 'js' as const,
      code: `var data, inits = 0, calls = 0;
        function init(value) { if (++inits !== 1) throw new Error('repeated init'); data = value; data.cells[0] = 9; }
        function think(obs) {
          if (data.team !== obs.team || obs.match !== undefined || inits !== 1) throw new Error('bootstrap violation');
          log(++calls, data.team, data.cells[0]); return [];
        }`,
    };
    expect(await match.seat('blue', 'runner').policyDeploy(artifact)).toMatchObject({ ok: true, probe: { calls: 1, logs: ['1 blue 9'] } });
    expect(f.data.blue.cells).toEqual([1, 2]);
    await match.step(period);
    expect(await match.seat('blue', 'runner').policyStatus()).toMatchObject({ calls: 1, logs: ['1 blue 9'] });
    expect(f.data.blue.cells).toEqual([1, 2]);
  });

  it('reinitializes from separate match data after a policy instance crashes', async () => {
    const f = fixture();
    const match = f.host.createMatch({ realtime: false, controllers: { ...idle, blue: { runner: 'agent', guard: 'none' } } });
    // A timeout whose leftover promise job overruns as well kills the instance (a plain loop's instance survives).
    const crash = `if (obs.tick === ${period}) { Promise.resolve().then(() => { while (true) {} }); while (true) {} }`;
    const artifact = { ...policy, code: policy.code.replace('log(obs.tick, match.team);', `log(obs.tick, match.team); ${crash}`) };
    expect(await match.seat('blue', 'runner').policyDeploy(artifact)).toMatchObject({ ok: true });
    await match.step(period * 3);
    expect(await match.seat('blue', 'runner').policyStatus()).toMatchObject({ calls: 3, errors: 0, timeouts: 1 });
    expect(f.observations.every((obs) => obs.argc === 3)).toBe(true);
  });
});
