/** `createPlayerThreeHost`: the in-process host — matches, tokens and authorization leases, commanders, pool, session history and commander log. */
import { randomInt, randomUUID } from 'node:crypto';
import type { SeatControl } from '../control.ts';
import { surfaceHash } from '../briefing.ts';
import { defineManifest, type AnyManifest } from '../manifest.ts';
import { TOKEN_RE, type Principal } from '../protocol.ts';
import { join } from 'node:path';
import type { EnumS } from '../schema.ts';
import { Commanders } from './commanders.ts';
import { Match, type CommanderLink, type MatchHost } from './match.ts';
import { defaultOf, mergeMatchOptions, parseMatchOptions, parseMatchSides } from './pipeline.ts';
import { History } from './history.ts';
import { Pool } from './pool.ts';
import { jsonCommanderStore, jsonlCommanderLogStore, jsonPoolStore, memoryCommanderLogStore, memoryCommanderStore, memoryPoolStore } from './store.ts';
import { CommanderLog } from './log.ts';
import type { AgentSession, PlayerThreeHost, PlayerThreeHostOptions, PlayerThreeMatch, PlayerThreeTraceEvent, AuthorizationLease, CommanderRegistry, CreateMatchOptions } from './types.ts';
import { PlayerThreeError, tokenDigest } from './util.ts';
import type { UsageEvent } from './types.ts';

const MAX_SEED = 2 ** 31 - 1;
const MAX_READY_SECONDS = 600;

/**
 * Create the in-process host for one game. Validates the manifest up front (throws on anything unsafe).
 * Tokens are kept only as SHA-256 digests; lookups go by digest, so a guessed token never takes a timing-dependent
 * string comparison against a real one.
 */
export function createPlayerThreeHost<M extends AnyManifest>(opts: PlayerThreeHostOptions<M>): PlayerThreeHost<M> {
  const definition = opts.definition;
  defineManifest(definition.manifest);
  defaultOf(definition.manifest.directive);
  // Builds (and caches) the pinned surface now: a game over the tool-surface budget (spec §4) fails here, not at first use.
  surfaceHash(definition.manifest);
  const matchOptions = parseMatchOptions(definition.manifest, opts.matchOptions);
  const defaultTeams = parseMatchSides(definition.manifest, opts.teams, undefined).teams;
  const pool = new Pool(definition.manifest.id, opts.poolStore ?? (opts.poolDir !== undefined ? jsonPoolStore(opts.poolDir) : memoryPoolStore()));
  const matches = new Map<string, Match<M>>();
  type TokenRecord = { match: string; principal: Principal; expiresAt?: number; singleUse: boolean; claimed: boolean; leases: Set<AuthorizationLease>; timer?: NodeJS.Timeout };
  const tokens = new Map<string, TokenRecord>();
  const principalRecords = new WeakMap<Principal, { record: TokenRecord; digest: string }>();
  const leases = new Map<string, { lease: AuthorizationLease; digest: string }>();
  const leaseListeners = new Set<(lease: AuthorizationLease) => void>();
  const revokeDigest = (digest: string): void => {
    const record = tokens.get(digest);
    if (!record) return;
    tokens.delete(digest);
    clearTimeout(record.timer);
    matches.get(record.match)?.revokePrincipal(`token:${digest}`);
    for (const lease of record.leases) {
      leases.delete(lease.id);
      for (const listener of leaseListeners) {
        try { listener(lease); } catch { /* Revocation cannot be interrupted by observers. */ }
      }
    }
  };
  const traceListeners = new Set<(e: PlayerThreeTraceEvent) => void>();
  const usageListeners = new Set<(event: UsageEvent) => void>();
  const practices = new Map<string, number>();
  let disposed = false;
  const history = new History(definition.manifest, opts.history);
  const store = opts.commanderStore ?? (opts.dataDir !== undefined ? jsonCommanderStore(join(opts.dataDir, 'commanders', definition.manifest.id)) : memoryCommanderStore());
  const log = new CommanderLog(
    opts.commanderLog?.store ?? (opts.dataDir !== undefined ? jsonlCommanderLogStore(join(opts.dataDir, 'commander-log', `${definition.manifest.id}.jsonl`)) : memoryCommanderLogStore()),
    opts.commanderLog,
  );
  const commanders = new Commanders(
    { definition: definition as never, pool, practices, isDisposed: () => disposed, matchOptions, teams: defaultTeams, resultMaxAgeMs: history.limits.maxAgeMs },
    store,
    log,
  );
  // Each component logs its own load failure; `ready` still rejects for the game awaiting it.
  const ready = Promise.all([commanders.ready, pool.ready, history.ready]).then(() => undefined);
  ready.catch(() => {});

  const ctx: MatchHost<M> = {
    definition,
    pool,
    practices,
    matchOptions,
    teams: defaultTeams,
    // The session history counts rejections and policy errors from the trace, so it keeps tracing on.
    tracing: () => traceListeners.size > 0 || history.enabled,
    emit(event) {
      history.track(event);
      for (const l of traceListeners) {
        try {
          l(event);
        } catch {
          // DevTools must never break a match.
        }
      }
    },
    registerToken(token, match, principal, expiresAt) {
      const scoped = principal.kind === 'observer' || principal.kind === 'human' || principal.kind === 'seat' || (principal.kind === 'spectator' && principal.team !== undefined);
      const expiry = expiresAt ?? (scoped ? Date.now() + 120_000 : undefined);
      const digest = tokenDigest(token);
      const frozenPrincipal: Principal = principal.kind === 'observer' ? Object.freeze({
        ...principal,
        grant: Object.freeze(principal.grant.kind === 'omniscient' ?
          { ...principal.grant, teams: Object.freeze([...principal.grant.teams]) } : { ...principal.grant }),
      }) : Object.freeze({ ...principal });
      const record: TokenRecord = { match, principal: frozenPrincipal, singleUse: scoped, claimed: false, leases: new Set(), expiresAt: expiry };
      tokens.set(digest, record);
      principalRecords.set(record.principal, { record, digest });
      if (expiry !== undefined) {
        record.timer = setTimeout(() => revokeDigest(digest), Math.max(0, expiry - Date.now()));
        record.timer.unref?.();
      }
    },
    extendToken(token, expiresAt) {
      const digest = tokenDigest(token);
      const record = tokens.get(digest);
      // Only a credential bound to a live connection: an unclaimed bearer keeps its short admission window.
      if (!record || !record.claimed || record.leases.size === 0 || record.expiresAt === undefined || Date.now() >= record.expiresAt) return false;
      clearTimeout(record.timer);
      record.expiresAt = expiresAt;
      record.timer = setTimeout(() => revokeDigest(digest), Math.max(0, expiresAt - Date.now()));
      record.timer.unref?.();
      return true;
    },
    revokeToken(token) {
      revokeDigest(tokenDigest(token));
    },
    principalAccess(principal) {
      const registered = principalRecords.get(principal);
      if (!registered) return undefined;
      const { record, digest } = registered;
      return {
        key: `token:${digest}`,
        valid: () => {
          const match = matches.get(record.match);
          return tokens.get(digest) === record && !disposed && !!match && !match.disposed &&
            (!match.over || principal.kind === 'observer' || principal.kind === 'seat' && record.claimed && record.leases.size > 0) &&
            (principal.kind !== 'observer' || record.claimed && record.leases.size > 0) &&
            (record.expiresAt === undefined || Date.now() < record.expiresAt);
        },
      };
    },
    revokeMatch(match, keepObservers = false) {
      for (const [digest, record] of tokens) if (record.match === match &&
        !(keepObservers && (record.principal.kind === 'observer' ||
          record.principal.kind === 'seat' && matches.get(match)?.over && record.claimed && record.leases.size > 0))) revokeDigest(digest);
    },
    prepareCommander(match, assignment, crossTeam) {
      const { team, role, owner, kind, policy, commander } = assignment;
      const entry = commander ? commanders.roster(owner).find((c) => c.id === commander.id) : undefined;
      if (!commander || !entry || !entry.roles.includes(role) || entry.kind !== kind) throw new PlayerThreeError('invalid');
      if (policy && 'version' in policy && !entry.policy.versions.some((v) => v.version === policy.version && v.role === role)) throw new PlayerThreeError('invalid');
      if (crossTeam && !entry.isolation.independentSessions) throw new PlayerThreeError('forbidden');
      const prepared = commanders.prepareSeat(owner, commander.id, team, role, policy && 'version' in policy ? policy.version : undefined, match);
      return { link: prepared.links.get(`${team}/${role}`)!, bind: () => prepared.bind(match) };
    },
    logMatch(match, logged) {
      commanders.logMatch(logged, { harness: (team, role) => history.harnesses(match.id, team, role), kept: history.enabled });
    },
    assigned(match, team, role, owner) {
      history.assigned(match.id, `${team}/${role}`, owner);
    },
    disposed(match) {
      matches.delete(match.id);
      history.released(match);
    },
  };

  const authenticate = (token: string): { match: Match<M>; principal: Principal } | undefined => {
    if (disposed || typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
    const found = tokens.get(tokenDigest(token));
    if (!found) return undefined;
    if (found.principal.kind === 'observer' && found.claimed) return undefined;
    if (found.expiresAt !== undefined && Date.now() >= found.expiresAt) {
      revokeDigest(tokenDigest(token));
      return undefined;
    }
    const match = matches.get(found.match);
    if (!match || match.disposed) return undefined;
    if (found.principal.kind === 'seat' && match.outcome(found.principal.team as never) !== 'running') {
      if (!found.claimed || found.leases.size === 0) return undefined;
    } else if (match.over && found.principal.kind !== 'observer') return undefined;
    return { match, principal: found.principal };
  };

  const tokenControl = (token: string, control: SeatControl): SeatControl => {
    const wrapped = {} as SeatControl;
    for (const method of Object.keys(control) as (keyof SeatControl)[]) {
      const invoke = control[method] as (...args: never[]) => Promise<unknown>;
      wrapped[method] = (async (...args: never[]) => {
        if (!authenticate(token)) throw new PlayerThreeError('bad_token');
        const result = await invoke(...args);
        if (!authenticate(token)) throw new PlayerThreeError('bad_token');
        return result;
      }) as never;
    }
    return wrapped;
  };

  return {
    commanderLog: log,
    definition,
    ready,
    pool,
    matchOptions: matchOptions as PlayerThreeHost<M>['matchOptions'],
    createMatch(o: CreateMatchOptions<M> = {}): PlayerThreeMatch<M> {
      if (disposed) throw new PlayerThreeError('forbidden');
      if (opts.maxMatches !== undefined && matches.size >= opts.maxMatches) throw new PlayerThreeError('busy');
      if (o.seed !== undefined && (!Number.isSafeInteger(o.seed) || o.seed < 0)) throw new PlayerThreeError('invalid');
      if (o.readySeconds !== undefined && !(typeof o.readySeconds === 'number' && o.readySeconds >= 0 && o.readySeconds <= MAX_READY_SECONDS)) {
        throw new PlayerThreeError('invalid');
      }
      const options = mergeMatchOptions(definition.manifest.matchOptions, matchOptions, parseMatchOptions(definition.manifest, o.options));
      const sides = parseMatchSides(definition.manifest, o.teams, o.alliances, defaultTeams);
      const links = new Map<string, CommanderLink>();
      const binds: ((match: Match<M>) => void)[] = [];
      const seats = new Set<string>();
      const placements = new Map<string, string>();
      for (const assignment of o.assignments ?? []) {
        const { team, role, owner, kind, policy, commander } = assignment;
        const key = `${team}/${role}`;
        const placement = commander ? `${owner}/${commander.id}` : `${owner}/${team}/${role}`;
        if (!sides.teams.includes(team) ||
          !(definition.manifest.roles as EnumS).values.includes(role) || typeof owner !== 'string' || !owner || owner.length > 128 ||
          !['human', 'agent', 'policy', 'bot', 'none'].includes(kind) || seats.has(key) ||
          placements.has(placement) && placements.get(placement) !== team) throw new PlayerThreeError('invalid');
        if (assignment.ownerControl !== undefined && typeof assignment.ownerControl !== 'boolean') throw new PlayerThreeError('invalid');
        if (commander && (!['agent', 'policy'].includes(kind) || typeof commander.id !== 'string' || Object.keys(commander).length !== 1)) throw new PlayerThreeError('invalid');
        if (policy !== undefined && (kind !== 'policy' || policy === null || typeof policy !== 'object' ||
          Object.keys(policy).length !== 1 || !('policyId' in policy ? typeof policy.policyId === 'string' : 'version' in policy && Number.isSafeInteger(policy.version) && policy.version > 0))) throw new PlayerThreeError('invalid');
        const entry = commander ? commanders.roster(owner).find((c) => c.id === commander.id) : undefined;
        if (commander && (!entry || !entry.roles.includes(role) || entry.kind !== kind)) throw new PlayerThreeError('invalid');
        if (policy && 'version' in policy && !entry?.policy.versions.some((v) => v.version === policy.version && v.role === role)) throw new PlayerThreeError('invalid');
        if (commander && kind === 'agent' && (o.assignments ?? []).some((a) =>
          a.commander && a.kind === 'agent' && a.owner === owner && a.team !== team) &&
          !entry?.isolation.independentSessions) throw new PlayerThreeError('forbidden');
        seats.add(key);
        placements.set(placement, team);
        if (commander) {
          const prepared = commanders.prepareSeat(owner, commander.id, team, role, policy && 'version' in policy ? policy.version : undefined);
          for (const [k, link] of prepared.links) links.set(k, link);
          binds.push(prepared.bind as (match: Match<M>) => void);
        }
      }
      const match = new Match<M>(ctx, o, o.seed ?? randomInt(MAX_SEED), options, sides, links);
      matches.set(match.id, match);
      history.opened(match.id, Object.fromEntries((o.assignments ?? []).map((a) => [`${a.team}/${a.role}`, a.owner])));
      for (const bind of binds) bind(match);
      match.onUsage((event) => {
        for (const listener of usageListeners) {
          try { listener(event); } catch { /* Telemetry cannot interrupt play. */ }
        }
      });
      return match;
    },
    getMatch: (id) => matches.get(id),
    history,
    matches: () => [...matches.values()],
    authenticate,
    claimToken(token, connectionId) {
      if (typeof connectionId !== 'string' || !connectionId || connectionId.length > 256) return undefined;
      const auth = authenticate(token);
      if (!auth) return undefined;
      const digest = tokenDigest(token);
      const record = tokens.get(digest)!;
      if (record.singleUse && record.claimed) return undefined;
      record.claimed = true;
      // Observer ticket expiry bounds admission, not the independently revocable delayed-playback lease.
      if (auth.principal.kind === 'observer') {
        clearTimeout(record.timer);
        record.timer = undefined;
        record.expiresAt = undefined;
      }
      const lease = Object.freeze({ id: randomUUID(), principal: auth.principal });
      record.leases.add(lease);
      leases.set(lease.id, { lease, digest });
      return lease;
    },
    authorizeLease(lease) {
      const bound = leases.get(lease.id);
      if (!bound || bound.lease !== lease) return undefined;
      const record = tokens.get(bound.digest);
      if (!record || (record.expiresAt !== undefined && Date.now() >= record.expiresAt)) {
        revokeDigest(bound.digest);
        return undefined;
      }
      const match = matches.get(record.match);
      if (!match || match.disposed) return undefined;
      return record.principal;
    },
    disconnectLease(lease) {
      const bound = leases.get(lease.id);
      if (bound?.lease !== lease) return;
      const record = tokens.get(bound.digest);
      if (record?.singleUse) revokeDigest(bound.digest);
      else {
        record?.leases.delete(lease);
        leases.delete(lease.id);
      }
    },
    onLeaseRevoked(listener) {
      leaseListeners.add(listener);
      return () => leaseListeners.delete(listener);
    },
    seatControl(token: string): SeatControl | undefined {
      const auth = authenticate(token);
      const control = auth?.match.controlFor(auth.principal);
      return control ? tokenControl(token, control) : undefined;
    },
    agentSession(token: string, role?: string): AgentSession | undefined {
      const auth = authenticate(token);
      if (auth) {
        const { principal } = auth;
        const control = principal.kind === 'seat' ? auth.match.controlFor(principal) : undefined;
        if (!control || principal.kind !== 'seat' || role !== undefined && principal.role !== role) return undefined;
        const match = auth.match as Match<M>;
        return { kind: 'seat', control: tokenControl(token, control), match, team: principal.team, role: principal.role,
          reportUsage: (report) => {
            if (!authenticate(token)) throw new PlayerThreeError('bad_token');
            match.recordUsage(principal.team, principal.role, report);
          },
          drain: () => authenticate(token) ? match.inboxFor(principal) : [] };
      }
      return commanders.agentSession(token, role);
    },
    commanders: commanders as unknown as CommanderRegistry<M>,
    onTrace(listener) {
      traceListeners.add(listener);
      return () => traceListeners.delete(listener);
    },
    onUsage(listener) {
      usageListeners.add(listener);
      return () => usageListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      for (const m of [...matches.values()]) m.dispose();
      disposed = true;
      commanders.dispose();
      for (const digest of tokens.keys()) revokeDigest(digest);
      leaseListeners.clear();
      traceListeners.clear();
      usageListeners.clear();
    },
  };
}
