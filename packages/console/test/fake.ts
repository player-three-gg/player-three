/** A fake player API behind a `fetch` function: serves `/state` from a mutable object and a controllable `/stream`. */
import type { CommanderInfo, PlayerStateWire, PlayerTraceEvent, SeatInfo } from '../src/index.ts';

export const TOKEN = 'blue-owner-token';

export function commander(id: string, extra: Partial<CommanderInfo> = {}): CommanderInfo {
  return {
    id, name: id, kind: 'agent', roles: ['runner'], isolation: { independentSessions: true },
    botLevel: 'standard', scopes: ['policy', 'practice'],
    mandate: { autonomy: 'autonomous', directive: { stance: 'attack' }, whenAbsent: 'bot' },
    policy: { activeByRole: { runner: 4 }, versions: [1, 2, 3, 4].map((version) => ({ version, role: 'runner', runtime: 'js', createdAt: version })) },
    record: { wins: 1, losses: 0, draws: 0 },
    approvals: [],
    lastPractice: { at: 99, role: 'runner', opponent: 'novice', allies: 'novice', ticks: 600, seed: 7, version: 4, outcome: 'win', report: null },
    connected: false, lastSeenAt: 5, seated: null, reservations: [], ...extra,
  };
}

export function seat(role: string, extra: Partial<SeatInfo> = {}): SeatInfo {
  return {
    team: 'blue',
    role,
    controller: 'agent',
    mandate: { autonomy: 'supervised', directive: { stance: 'defend' }, limits: { asteroidDrops: false, collapses: true }, whenAbsent: 'policy' },
    scopes: ['act', 'policy', 'practice'],
    agentActive: true,
    ...extra,
  };
}

export function intent(role: string, at: number, ack: Extract<PlayerTraceEvent, { type: 'intent' }>['ack'], kind?: string): PlayerTraceEvent {
  return { type: 'intent', at, match: 'm1', tick: at, team: 'blue', role, source: 'agent', ...(kind ? { intent: { kind } } : {}), ack };
}

export function matchState(): PlayerStateWire {
  return {
    game: { id: 'tag', title: 'Tag', version: '1', tickRate: 20, policy: null },
    match: 'm1',
    team: 'blue',
    target: null,
    readiness: { runner: 'ready', guard: 'consent_required' },
    tick: 40,
    outcome: 'running',
    seats: [seat('runner'), seat('guard', { controller: 'policy', agentActive: false, policyVersion: 2 })],
    observations: { runner: { type: 'observe', at: 30, match: 'm1', tick: 30, team: 'blue', role: 'runner', source: 'agent', bytes: 1000 } },
    policies: {
      runner: null,
      guard: {
        version: 2,
        runtime: 'js',
        calls: 10,
        successfulCalls: 7,
        consecutiveFailures: 1,
        timeouts: 1,
        errors: 2,
        meanMs: 0.5,
        maxMs: 3,
        intentsEmitted: 8,
        intentsRejected: [{ code: 'game', count: 1 }],
        lastError: { code: 'threw', message: 'boom at think' },
        logs: ['hello', 'world'],
        approval: { id: 'ap1', kind: 'policyDeploy', version: 3, status: 'pending' },
      },
    },
    calls: { runner: [], guard: [{ type: 'policy_call', at: 35, match: 'm1', tick: 35, team: 'blue', role: 'guard', version: 2, pool: false, ms: 3, intents: 0, rejected: 0, logs: [], error: 'timeout' }] },
    practice: [],
    events: [
      intent('runner', 10, { ok: true }, 'move'),
      intent('runner', 11, { ok: false, code: 'invalid', schemaCode: 'range', path: ['x'], expected: 'MoveIntent["x"]: number (integer 0..15)' }),
      intent('runner', 12, { ok: false, code: 'game', gameCode: 'no_energy' }),
      intent('runner', 13, { ok: false, code: 'invalid', schemaCode: 'range', path: ['x'], expected: 'MoveIntent["x"]: number (integer 0..15)' }),
      { type: 'policy_deploy', at: 20, match: 'm1', tick: 20, team: 'blue', role: 'guard', ok: false, rollback: false, error: { code: 'compile', message: 'SyntaxError' } },
    ],
  };
}

export interface FakeApi {
  fetch: typeof fetch;
  state: PlayerStateWire | { status: number; error: string };
  /** Push one SSE frame to every open stream. */
  push(event: 'status' | 'trace', data: unknown): void;
  /** Requests seen, as `METHOD path auth`. */
  requests: string[];
  streams: number;
  /** Status answered by `/stream` (200 opens it). */
  streamStatus: number;
}

export function fakeApi(state: FakeApi['state'] = matchState()): FakeApi {
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const api: FakeApi = {
    state,
    requests: [],
    streams: 0,
    streamStatus: 200,
    push(event, data) {
      for (const c of controllers) c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    fetch: async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      api.requests.push(`GET ${url} ${auth}`);
      if (auth !== `Bearer ${TOKEN}`) return Response.json({ error: 'bad_token' }, { status: 401 });
      if (new URL(url, 'http://console.test').pathname.endsWith('/state')) {
        const s = api.state;
        return 'status' in s ? Response.json({ error: s.error }, { status: s.status }) : Response.json(structuredClone(s));
      }
      if (new URL(url, 'http://console.test').pathname.endsWith('/stream')) {
        if (api.streamStatus !== 200) return Response.json({ error: 'not_in_match' }, { status: api.streamStatus });
        api.streams++;
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            ctl = c;
            controllers.add(c);
          },
          cancel() {
            controllers.delete(ctl);
          },
        });
        init?.signal?.addEventListener('abort', () => {
          controllers.delete(ctl);
          try {
            ctl.error(new DOMException('aborted', 'AbortError'));
          } catch {
            /* already closed */
          }
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({ error: 'bad_message' }, { status: 404 });
    },
  };
  return api;
}

/** Let pending promise chains and stream reads settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 0);
    await tick.promise;
  }
}
