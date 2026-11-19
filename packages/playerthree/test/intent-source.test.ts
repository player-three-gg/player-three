import { afterEach, expect, it } from 'vitest';
import { definition, TagGame, type TagManifest } from '../examples/tag/index.ts';
import { createPlayerThreeHost, replayMatch } from '../src/host/index.ts';
import type { PlayerThreeHost, Replay } from '../src/host/types.ts';
import type { IntentContext, IntentSource } from '../src/manifest.ts';

let host: PlayerThreeHost<TagManifest> | undefined;
afterEach(() => host?.dispose());

it('delivers trusted owner, agent, policy, bot and fallback origins independently of seat controller and replays them', async () => {
  class SourcedGame extends TagGame {
    readonly sources: IntentSource[] = [];
    readonly contexts: (IntentContext | undefined)[] = [];
    override apply(seat: Parameters<TagGame['apply']>[0], intent: Parameters<TagGame['apply']>[1], context?: IntentContext) {
      this.sources.push(context?.source ?? 'owner');
      this.contexts.push(context);
      return super.apply(seat, intent);
    }
  }
  let live: SourcedGame | undefined;
  const sourced = { ...definition, create: ({ seed }: { seed: number }) => (live = new SourcedGame(seed)) };
  host = createPlayerThreeHost({ definition: sourced });
  const match = host.createMatch({ seed: 9, realtime: false });
  match.setController('blue', 'runner', 'agent');
  const owner = match.seat('blue', 'runner');
  expect(await owner.act([{ kind: 'stop' }])).toEqual([{ ok: true }]);
  const agent = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
  expect(await agent.act([{ kind: 'stop' }])).toEqual([{ ok: true }]);
  expect((await owner.policyDeploy({ runtime: 'js', code: 'function think(){return [{kind:"stop"}];}' })).ok).toBe(true);
  match.setController('blue', 'guard', 'agent');
  match.setMandate('blue', 'guard', { autonomy: 'autonomous', directive: { stance: 'defend' }, whenAbsent: 'bot' });
  await match.step(1);
  const delivered = [...live!.sources];
  expect(delivered.slice(0, 2)).toEqual(['owner', 'agent']);
  expect(delivered).toEqual(expect.arrayContaining(['policy', 'bot', 'fallback']));
  expect(live!.contexts[0]).toEqual({ source: 'owner', ownerRoles: ['runner'] });
  expect(live!.contexts.filter(context => context?.source !== 'owner').every(context => context?.ownerRoles === undefined)).toBe(true);
  const replay = match.replay();
  expect(replay.version).toBe(2);
  expect(replay.entries.filter(e => e[3] === 'intent').map(e => e[5])).toEqual(delivered);
  const rerun = replayMatch(sourced, replay).adapter as SourcedGame;
  expect(rerun.sources).toEqual(delivered);
  expect(() => replayMatch(sourced, { ...replay, version: 1 } as unknown as Replay)).toThrow('trusted intent source required');
  const ambiguous = structuredClone(replay);
  const entry = ambiguous.entries.find(e => e[3] === 'intent')!;
  entry.splice(5);
  expect(() => replayMatch(sourced, ambiguous)).toThrow('invalid intent source');
});

it('scopes owner priority to current same-team human-authorized assignments, not shared private identities', async () => {
  class ScopedGame extends TagGame {
    readonly contexts: (IntentContext | undefined)[] = [];
    override apply(seat: Parameters<TagGame['apply']>[0], intent: Parameters<TagGame['apply']>[1], context?: IntentContext) {
      this.contexts.push(structuredClone(context));
      return super.apply(seat, intent);
    }
  }
  let live: ScopedGame | undefined;
  const scoped = { ...definition, create: ({ seed }: { seed: number }) => (live = new ScopedGame(seed)) };
  host = createPlayerThreeHost({ definition: scoped });
  const match = host.createMatch({ realtime: false, seed: 9, assignments: [
    { team: 'blue', role: 'guard', owner: 'alice', kind: 'bot', ownerControl: true },
    { team: 'blue', role: 'runner', owner: 'alice', kind: 'human' },
    { team: 'red', role: 'runner', owner: 'alice', kind: 'agent' },
  ] });
  const owner = match.seat('blue', 'runner');
  await owner.act([{ kind: 'stop' }]);
  expect(live!.contexts.at(-1)).toEqual({ source: 'owner', ownerRoles: ['runner', 'guard'] });
  match.assign({ team: 'blue', role: 'guard', owner: 'bob', kind: 'human' });
  await owner.act([{ kind: 'stop' }]);
  expect(live!.contexts.at(-1)).toEqual({ source: 'owner', ownerRoles: ['runner'] });
  match.assign({ team: 'blue', role: 'guard', owner: 'alice', kind: 'agent' });
  await owner.act([{ kind: 'stop' }]);
  expect(live!.contexts.at(-1)).toEqual({ source: 'owner', ownerRoles: ['runner'] });
  const agent = host.seatControl(match.mintSeatToken('blue', 'guard'))!;
  await agent.act([{ kind: 'stop' }]);
  expect(live!.contexts.at(-1)).toEqual({ source: 'agent' });
  match.assign({ team: 'blue', role: 'guard', owner: 'alice', kind: 'agent', ownerControl: true });
  await owner.act([{ kind: 'stop' }]);
  expect(live!.contexts.at(-1)).toEqual({ source: 'owner', ownerRoles: ['runner', 'guard'] });
  match.revokeSeat('blue', 'guard');
  await owner.act([{ kind: 'stop' }]);
  expect(live!.contexts.at(-1)).toEqual({ source: 'owner', ownerRoles: ['runner'] });

  const delivered = structuredClone(live!.contexts);
  const replay = match.replay();
  expect(JSON.stringify(replay)).not.toMatch(/alice|bob/);
  expect((replayMatch(scoped, replay).adapter as ScopedGame).contexts).toEqual(delivered);
  // Owner entries always carry the owner-role scope: a six-field owner entry is malformed, never seat-local.
  const seatLocal = structuredClone(replay);
  seatLocal.entries.find(entry => entry[3] === 'intent')!.splice(6);
  expect(() => replayMatch(scoped, seatLocal)).toThrow('invalid intent source');
  for (const roles of [[], ['guard'], ['runner', 'runner'], ['runner', 'unknown']]) {
    const malformed = structuredClone(replay);
    const intent = malformed.entries.find(entry => entry[3] === 'intent')!;
    intent[6] = roles;
    expect(() => replayMatch(scoped, malformed)).toThrow('invalid owner roles');
  }
  const forged = structuredClone(replay);
  const agentEntry = forged.entries.find(entry => entry[3] === 'intent' && entry[5] === 'agent')!;
  agentEntry[6] = ['guard'];
  expect(() => replayMatch(scoped, forged)).toThrow('invalid intent source');
});
