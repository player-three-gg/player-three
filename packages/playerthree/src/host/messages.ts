/** Inbound transport shapes and named-argument dispatch; authority and lifecycle stay in Match. */
import { METHOD_MODE, SCOPES, type ControlMethod, type SeatControl, type SequenceRequest } from '../control.ts';
import { validateUnknown } from '../guard.ts';
import { CONTROLLERS, type Controller, type DetailRequest } from '../manifest.ts';
import { LIMITS } from '../mcp/surface.ts';
import type { ClientMsg } from '../protocol.ts';
import { t } from '../schema.ts';
import { PlayerThreeError } from './util.ts';

/** Largest supported interval between pushed observations, in simulation ticks (not milliseconds). */
export const MAX_STREAM_EVERY_TICKS = 100_000;

/** Strict shape check only. Authority, payload validation and closed error codes belong to the control plane. */
export function parseClientMessage(raw: unknown, roles: readonly string[]): ClientMsg | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const o = raw as Record<string, unknown>;
  const seq = o.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq > LIMITS.maxTick) return null;
  const keys = Object.keys(o);
  const only = (...allowed: string[]): boolean => keys.every((k) => allowed.includes(k));
  if (o.op === 'tell') {
    // Shape only; text and ping are validated by `tell` (closed error codes, never echoed).
    if (!only('op', 'seq', 'roles', 'text', 'ping') || typeof o.text !== 'string') return null;
    if (o.roles !== 'all' && !(Array.isArray(o.roles) && o.roles.every((r) => typeof r === 'string' && roles.includes(r)))) return null;
    return { op: 'tell', seq, roles: o.roles === 'all' ? 'all' : [...(o.roles as string[])], text: o.text, ...(o.ping !== undefined ? { ping: o.ping } : {}) };
  }
  if (typeof o.role !== 'string' || !roles.includes(o.role)) return null;
  switch (o.op) {
    case 'call':
      if (!only('op', 'seq', 'role', 'method', 'args') || typeof o.method !== 'string' || !Object.hasOwn(METHOD_MODE, o.method)) return null;
      return { op: 'call', seq, role: o.role, method: o.method as ControlMethod, args: o.args };
    case 'stream':
      if (!only('op', 'seq', 'role', 'everyTicks') || !validateUnknown(t.int(0, MAX_STREAM_EVERY_TICKS), o.everyTicks).ok) return null;
      return { op: 'stream', seq, role: o.role, everyTicks: o.everyTicks as number };
    case 'mandate':
      if (!only('op', 'seq', 'role', 'mandate')) return null;
      return { op: 'mandate', seq, role: o.role, mandate: o.mandate };
    case 'scopes':
      if (!only('op', 'seq', 'role', 'scopes') || !Array.isArray(o.scopes) || !o.scopes.every((scope) => SCOPES.includes(scope))) return null;
      return { op: 'scopes', seq, role: o.role, scopes: [...o.scopes] };
    case 'resolveApproval':
      if (!only('op', 'seq', 'role', 'id', 'approve') || typeof o.id !== 'string' || typeof o.approve !== 'boolean') return null;
      return { op: 'resolveApproval', seq, role: o.role, id: o.id, approve: o.approve };
    case 'controller':
      if (!only('op', 'seq', 'role', 'controller') || !(CONTROLLERS as readonly unknown[]).includes(o.controller)) return null;
      return { op: 'controller', seq, role: o.role, controller: o.controller as Controller };
    case 'mint':
      if (!only('op', 'seq', 'role')) return null;
      return { op: 'mint', seq, role: o.role };
    default:
      return null;
  }
}

/** Correlate malformed requests without reflecting an unsafe sequence value back to the client. */
export function safeSeq(raw: unknown): number {
  const seq = raw !== null && typeof raw === 'object' && 'seq' in raw ? raw.seq : undefined;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 && seq <= LIMITS.maxTick ? seq : 0;
}

/**
 * Map a protocol `call` onto the control plane. `args` is the method's named-parameter object (the same shape as
 * the MCP tool input): briefing `{ topic?, page? }`, act `{ intents }`, observe `{ since?, detail? }`, wait `{ seconds, until? }`,
 * skill `{ name, path, offset? }`, policyDeploy = PolicySource (`{ runtime, code | modules + entry, include? }` or a starter `{ from, knobs? }`), policyRollback `{ version }`, practice =
 * PracticeRequest, others `{}`.
 */
export async function callMethod(control: SeatControl, method: ControlMethod, args: unknown): Promise<unknown> {
  const a = args === undefined ? {} : args;
  if (a === null || typeof a !== 'object' || Array.isArray(a)) throw new PlayerThreeError('invalid');
  const o = a as Record<string, unknown>;
  const only = (...allowed: string[]): void => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new PlayerThreeError('invalid');
  };
  switch (method) {
    case 'briefing':
      only('topic', 'page');
      if (o.topic === undefined && o.page !== undefined) throw new PlayerThreeError('invalid');
      return o.topic === undefined ? control.briefing() : control.briefing(o.topic as string, o.page as number | undefined);
    case 'observe':
      only('since', 'detail');
      return control.observe(o.since as number | undefined, o.detail as DetailRequest | undefined);
    case 'act':
      only('intents');
      return control.act(o.intents as unknown[]);
    case 'sequence':
      return control.sequence(o as unknown as SequenceRequest);
    case 'wait':
      return control.wait(o as never);
    case 'ready':
      only();
      return control.ready();
    case 'skill':
      only('name', 'path', 'offset');
      return control.skill(o.name as string, o.path as string, o.offset as number | undefined);
    case 'policyDeploy':
      return control.policyDeploy(o as never);
    case 'policyStatus':
      only();
      return control.policyStatus();
    case 'policyRollback':
      only('version');
      return control.policyRollback(o.version as number);
    case 'policyExport':
      only('version', 'page');
      return control.policyExport({ ...(o.version === undefined ? {} : { version: o.version as number }), ...(o.page === undefined ? {} : { page: o.page as number }) });
    case 'policyImport':
      only('package');
      return control.policyImport(o.package as never);
    case 'practice':
      return control.practice(o as never);
    case 'publish':
      only();
      return control.publish();
    case 'say':
      only('text', 'disclosure', 'category');
      if (o.disclosure !== undefined && o.disclosure !== 'observers' ||
        o.category !== undefined && (o.disclosure !== 'observers' || !['summary', 'chat'].includes(o.category as string))) throw new PlayerThreeError('invalid');
      return control.say(o.text as string, o.disclosure === 'observers' ?
        { audience: 'observers', category: (o.category ?? 'chat') as 'summary' | 'chat' } : undefined);
  }
}
