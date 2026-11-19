/** The bridge's opt-in Claude Code wake channel: watches the remote seat (resource subscription, else long-poll waits) and emits closed lifecycle events (seated, match_ended, approval_resolved, owner_message). */
import { setTimeout as delay } from 'node:timers/promises';
import type { CallToolResult, Client, McpSubscription } from '@modelcontextprotocol/client';

export interface ChannelEvent {
  content: string;
  meta: Record<string, string>;
}
type Call = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

type ResourceClient = Pick<Client, 'getServerCapabilities' | 'listResources' | 'readResource' | 'listen' | 'setNotificationHandler' | 'removeNotificationHandler'>;

/** Subscribe before reading so a change between discovery and the first snapshot cannot be missed. */
async function watchResources(
  client: ResourceClient,
  receivers: Map<string, (value: Record<string, unknown>) => Promise<void>>,
  call: Call,
  signal: AbortSignal,
): Promise<void> {
  if (!client.getServerCapabilities()?.resources?.subscribe || signal.aborted) return;
  const reads = new AbortController();
  const readSignal = AbortSignal.any([signal, reads.signal]);
  let subscription: McpSubscription | undefined;
  let registered = false;
  let active = false;
  const queues = new Map<string, Promise<void>>();
  const failed = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const stop = () => stopped.resolve();
  signal.addEventListener('abort', stop, { once: true });
  try {
    const { resources } = await client.listResources(undefined, { signal: readSignal, cacheMode: 'bypass' });
    const seats = new Map<string, string>();
    for (const role of receivers.keys()) {
      const matches = resources.filter((resource) =>
        resource.name === role && resource.uri.startsWith('playerthree://seat/') && resource.mimeType === 'application/json');
      if (matches.length !== 1) return;
      seats.set(matches[0]!.uri, role);
    }
    if (!seats.size) return;
    const refresh = (uri: string) => {
      const role = seats.get(uri);
      if (!active || !role || readSignal.aborted) return;
      const next = (queues.get(role) ?? Promise.resolve()).then(async () => {
        let drained = false;
        while (!readSignal.aborted) {
          const result = await client.readResource({ uri }, { signal: readSignal, cacheMode: 'bypass' });
          const content = result.contents.find((item) => item.uri === uri && item.mimeType === 'application/json' && 'text' in item);
          if (!content || !('text' in content)) throw new Error('channel_resource');
          const value = record(JSON.parse(content.text));
          if (!value || !['lobby', 'match'].includes(String(value.phase))) throw new Error('channel_status');
          if (readSignal.aborted) return;
          // A status resource is only a wake hint. In particular, never trust messages embedded in it.
          await receivers.get(role)!({ phase: value.phase, tick: value.tick, outcome: value.outcome, approval: value.approval });
          if (typeof value.unreadOwnerMessages !== 'number' || value.unreadOwnerMessages <= 0) return;
          // Approval/end wakes can precede the inbox. Re-read after each wait rather than
          // relying on another update, and bound retries if unread status does not advance.
          if (drained) await delay(250, undefined, { signal: readSignal });
          if (readSignal.aborted) return;
          const inbox = await call('game_wait', { role, seconds: 0 });
          if (inbox.isError) throw new Error('channel_wait');
          const body = record(inbox.structuredContent);
          if (!body) throw new Error('channel_result');
          if (!readSignal.aborted) await receivers.get(role)!(body);
          drained = true;
        }
      });
      queues.set(role, next);
      // Notification callbacks must not leave detached rejected promises.
      void next.catch(() => failed.resolve());
    };
    client.setNotificationHandler('notifications/resources/updated', async (notification) => {
      refresh(notification.params.uri);
    });
    registered = true;
    subscription = await client.listen({ resourceSubscriptions: [...seats.keys()] }, { signal: readSignal });
    if (!Array.isArray(subscription.honoredFilter.resourceSubscriptions) ||
        ![...seats.keys()].every((uri) => subscription!.honoredFilter.resourceSubscriptions!.includes(uri))) return;
    active = true;
    for (const uri of seats.keys()) refresh(uri);
    if (signal.aborted) return;
    await Promise.race([subscription.closed, failed.promise, stopped.promise]);
  } catch {
    // Missing/unsupported subscriptions and dropped streams use the authenticated long-poll path.
  } finally {
    active = false;
    reads.abort();
    signal.removeEventListener('abort', stop);
    if (registered) client.removeNotificationHandler('notifications/resources/updated');
    await subscription?.close();
    await Promise.allSettled(queues.values());
  }
}

/** Only project closed lifecycle fields and explicitly labelled owner text, never observations/events/logs. */
export async function watchChannel(call: Call, emit: (event: ChannelEvent) => Promise<void>, signal: AbortSignal, client?: ResourceClient): Promise<void> {
  const briefing = await call('game_briefing', {});
  if (briefing.isError) throw new Error('channel_briefing');
  const body = record(briefing.structuredContent);
  const declared = Array.isArray(body?.roles) ? body.roles.filter((r): r is string => typeof r === 'string' && /^[A-Za-z][A-Za-z0-9_.<>]{0,47}$/.test(r)) : [];
  const commands = Array.isArray(body?.commands) ? body.commands : [];
  const receivers = new Map<string, (value: Record<string, unknown>) => Promise<void>>();
  const initial = commands.map(async (raw) => {
    const command = record(raw);
    const role = command?.role;
    if (!command || typeof role !== 'string' || !declared.includes(role)) return;
    let phase: 'lobby' | 'match' = 'lobby';
    let ended = false;
    let approvalSeen: string | undefined;
    const send = (event: string, content: string, meta: Record<string, string> = {}) =>
      signal.aborted ? Promise.resolve() : emit({ content, meta: { event, role, ...meta } });
    const receive = async (value: Record<string, unknown>) => {
      if (signal.aborted) return;
      const terminal = ['win', 'loss', 'draw'].includes(String(value.outcome));
      if (value.phase === 'match' && phase !== 'match' && !(terminal && ended)) {
        phase = 'match';
        ended = false;
        await send('seated', `Seated in a match as ${role}. Read playerthree-commander and resume the monitor loop.`, { phase });
      }
      if (terminal && !ended) {
        ended = true;
        const outcome = value.outcome as string;
        await send('match_ended', `Match ended: ${outcome}. Return to the commander lobby wait loop.`, { phase: 'match', outcome });
      }
      if (value.phase === 'lobby') {
        phase = 'lobby';
        if (!terminal && value.wake !== 'approval') ended = false;
      }
      if (Array.isArray(value.messages)) {
        for (const rawMessage of value.messages) {
          const message = record(rawMessage);
          if (message?.from === 'owner' && typeof message.text === 'string') {
            await send('owner_message', `From owner:\n${message.text}`, { from: 'owner' });
          }
        }
      }
      let a = record(value.approval);
      if (!a && value.wake === 'approval') {
        const result = await call('policy_status', { role });
        if (result.isError) return;
        a = record(record(record(result.structuredContent)?.policy)?.approval);
      }
      if (a && typeof a.id === 'string' && ['approved', 'rejected', 'failed'].includes(String(a.status)) &&
          ['policyDeploy', 'policyRollback', 'publish'].includes(String(a.kind))) {
        const key = `${a.id}:${a.status}`;
        if (key !== approvalSeen) {
          approvalSeen = key;
          await send('approval_resolved', `Owner approval ${a.status}: ${a.kind}. Read policy_status before continuing.`, { status: a.status as string, kind: a.kind as string });
        }
      }
    };
    // Waits, snapshots and the fallback phase poll share one ordered lifecycle projection per role.
    let queue = Promise.resolve();
    const ordered = (value: Record<string, unknown>) => {
      queue = queue.then(() => receive(value));
      return queue;
    };
    receivers.set(role, ordered);
    await ordered(command);
  });
  await Promise.all(initial);
  if (client) await watchResources(client, receivers, call, signal);
  if (signal.aborted) return;
  const waiting = [...receivers].map(async ([role, receive]) => {
    while (!signal.aborted) {
      const result = await call('game_wait', { role, seconds: 60 });
      if (signal.aborted) return;
      if (result.isError) throw new Error('channel_wait');
      const value = record(result.structuredContent);
      if (!value) throw new Error('channel_result');
      await receive(value);
      // A finished one-match seat returns immediately forever; avoid spinning until the bridge closes.
      // Also bound request rate for accelerated/non-realtime games and repeatedly waking messages.
      await delay(250, undefined, { signal });
    }
  });
  // A match can seat a commander between two waits. The next wait then blocks in that match
  // (even indefinitely if paused). One cheap briefing poll covers all roles without consuming inboxes.
  const phases = async () => {
    while (!signal.aborted) {
      await delay(1000, undefined, { signal });
      const result = await call('game_briefing', {});
      if (result.isError) throw new Error('channel_briefing');
      const current = record(result.structuredContent)?.commands;
      if (!Array.isArray(current)) throw new Error('channel_commands');
      for (const raw of current) {
        const command = record(raw);
        if (command && typeof command.role === 'string') await receivers.get(command.role)?.(command);
      }
    }
  };
  await Promise.all([...waiting, phases()]);
}
