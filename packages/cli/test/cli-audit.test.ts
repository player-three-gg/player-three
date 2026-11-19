import { describe, expect, it } from 'vitest';
import { definition, TagGame } from '../../playerthree/examples/tag/index.ts';
import { auditDefinition, auditSeats, localInvoke, safetyCard, type AuditReport, type Invoke } from '../src/index.ts';
import { createPlayerThreeHost } from 'playerthree/host';
import { surfaceHash } from 'playerthree';
import type { GameDefinition } from 'playerthree';
import { t } from 'playerthree/schema';

const check = (r: AuditReport, id: string) => r.checks.find((c) => c.id === id)!;

/** A tag seat on a fresh in-process match (rate limits lifted so the fuzz is not throttled). */
function tagSeat(wrap: (inner: Invoke) => Invoke) {
  const relaxed: GameDefinition = {
    ...definition,
    manifest: { ...definition.manifest, control: { ...definition.manifest.control, intents: { perSecond: 1000, burst: 10_000 } } },
  } as GameDefinition;
  const host = createPlayerThreeHost({ definition: relaxed });
  // Realtime so `wait` calls resolve on game time instead of timing out.
  const match = host.createMatch({ seed: 3, realtime: true, controllers: { blue: { runner: 'agent' } } });
  const control = host.seatControl(match.mintSeatToken('blue', 'runner'))!;
  return { host, seat: { team: 'blue', role: 'runner', invoke: wrap(localInvoke(control)) } };
}

describe('auditDefinition (tag example)', () => {
  it('audits bounded trusted text and integer arrays without weakening poisoned-output checks', async () => {
    const base = definition.manifest;
    const manifest = {
      ...base,
      observation: t.obj({ ...base.observation.fields, label: t.str(16, '^[A-Za-z]+$'), cells: t.ints(4, 0, 9) }),
      intents: { ...base.intents, stop: { ...base.intents.stop, params: { label: t.opt(t.str(8, '^[A-Z]+$')), cells: t.opt(t.ints(2, 0, 9)) } } },
    };
    const bounded: GameDefinition<typeof manifest> = {
      ...definition, manifest,
      create(opts) {
        const game = new TagGame(opts.seed);
        const observe = game.observe.bind(game);
        return Object.assign(game, { manifest, observe: (seat: Parameters<typeof observe>[0], since: number) => ({ ...observe(seat, since), label: 'Trusted', cells: [0, 9] }) });
      },
    };
    const report = await auditDefinition(bounded);
    expect(check(report, 'vocabulary').failures).toEqual([]);
    expect(check(report, 'outbound_guard').failures).toEqual([]);
    expect(check(report, 'invalid_rejected').failures).toEqual([]);
    expect(check(report, 'valid_accepted').failures).toEqual([]);
    expect(report.ok).toBe(true);
  }, 60_000);

  it('passes every check, including the in-process-only ones, and writes a Safety Card', async () => {
    const r = await auditDefinition(definition);
    for (const c of r.checks) {
      expect(c.failures, c.id).toEqual([]);
      expect(c.skipped, c.id).toBeUndefined();
      expect(c.passed, c.id).toBeGreaterThan(0);
    }
    expect(r.ok).toBe(true);
    expect(r.surfaceHash).toBe(surfaceHash(definition.manifest));
    const card = safetyCard(r);
    expect(card).toContain(r.surfaceHash);
    expect(card).toContain('| `move` | runner, guard | `x`: integer 0…15, `y`: integer 0…15 |');
    expect(card).toMatch(/Audit: \*\*passed\*\*/);
    expect(card).toContain('only from its seat’s own owner, labeled `from: owner`');
    expect(card).toContain('Replies to its own owner require chat mode and the `say` scope');
    expect(card).toContain('seeded deterministic `Math.random()`');
    expect(card).toContain('frozen at the Unix epoch');
    expect(card).not.toContain('cannot** chat with anyone');
    expect(card).not.toContain('no network, files, clock or randomness');
  }, 60_000);
});

describe('auditSeats catches broken bindings', () => {
  it('flags an endpoint whose errors echo the input', async () => {
    const { host, seat } = tagSeat((inner) => async (method, args) => {
      try {
        return await inner(method, args);
      } catch (e) {
        const err = new Error(`bad request: ${JSON.stringify(args)?.slice(0, 200)}`) as Error & { code: string };
        err.code = 'invalid';
        throw err;
      }
    });
    try {
      const r = await auditSeats([seat], { label: 'echoing binding' });
      expect(r.ok).toBe(false);
      expect(check(r, 'no_echo').failed).toBeGreaterThan(0);
    } finally {
      host.dispose();
    }
  }, 60_000);

  it('flags a lenient binding that strips unknown fields instead of rejecting them', async () => {
    const strip = (v: unknown): unknown => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
      const { kind, x, y } = v as Record<string, unknown>;
      return Object.fromEntries(Object.entries({ kind, x, y }).filter(([, val]) => val !== undefined));
    };
    const { host, seat } = tagSeat((inner) => (method, args) => {
      if (method === 'act' && args && typeof args === 'object' && Array.isArray((args as { intents?: unknown }).intents)) {
        return inner(method, { intents: (args as { intents: unknown[] }).intents.map(strip) });
      }
      return inner(method, args);
    });
    try {
      const r = await auditSeats([seat], { label: 'lenient binding' });
      const rejected = check(r, 'invalid_rejected');
      expect(rejected.failed).toBeGreaterThan(0);
      expect(rejected.failures.some((f) => /unknown field/.test(f.case) && /ACCEPTED/.test(f.detail))).toBe(true);
    } finally {
      host.dispose();
    }
  }, 60_000);

  it('flags out-of-vocabulary strings in responses', async () => {
    const { host, seat } = tagSeat((inner) => async (method, args) => {
      const out = await inner(method, args);
      return method === 'observe' && out && typeof out === 'object' ? { ...out, chat: 'gg ez' } : out;
    });
    try {
      const r = await auditSeats([seat], { label: 'chatty binding' });
      expect(check(r, 'vocabulary').failed).toBeGreaterThan(0);
      expect(check(r, 'observation_schema').failed).toBeGreaterThan(0);
    } finally {
      host.dispose();
    }
  }, 60_000);
});
