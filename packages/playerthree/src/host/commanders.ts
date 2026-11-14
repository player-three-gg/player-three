/**
 * Named, owner-private commanders with compatible roles, versioned libraries and exclusive exact-seat leases.
 * A persistent credential routes only to its commander's execution lane. No owner-wide agent capability exists.
 *
 * Tokens are derived (HMAC) from a host key kept in the store and looked up by SHA-256 digest only. Rotation bumps
 * the commander's token generation, so the previous token stops resolving at once.
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { canonicalJson } from '../briefing.ts';
import { COMMANDER_LOG_FORMAT, COMMANDER_LOG_VERSION, type CommanderLogEntry, type CommanderLogSeatRef, type CommanderLogSealed, type CommanderLogUsage, type StoredCommanderLogEntry } from '../commander-log.ts';
import { commanderPublicId, newSalt, sealedDigest } from '../commander-log-integrity.ts';
import { buildBriefing, servedSkills, surfaceHash } from '../briefing.ts';
import { skillPage } from '../skill.ts';
import { topicPage } from '../topics.ts';
import type { DecisionUsage } from './types.ts';
import {
  LOBBY_INSTRUCTIONS,
  MATCH_INSTRUCTION,
  METHOD_MODE,
  METHOD_SCOPE,
  SCOPES,
  defaultScopes,
  type LobbyStart,
  type LobbyState,
  type MatchWait,
  type MatchReceipt,
  type ReadyResult,
  type WaitRequest,
  type Approval,
  type ApprovalRequest,
  type PolicyStatus,
  type Scope,
  type Briefing,
  type ControlMethod,
  type DeployResult,
  type OwnerMessage,
  type PolicyArtifact,
  type PolicyError,
  type PolicyImportResult,
  type PolicySource,
  type PolicyStats,
  type PracticeResult,
  type PublishResult,
  type Said,
  type SayResult,
  type StarterRef,
  type SeatControl,
  type SeatStatus,
  type WaitResult,
} from '../control.ts';
import { createGuard, validateUnknown } from '../guard.ts';
import { intentSchema, STARTER_KNOBS_MAX_BYTES, STARTER_PATH_MAX, type AnyManifest, type GameDefinition, type SkillDef } from '../manifest.ts';
import { LIMITS } from '../mcp/surface.ts';
import { TOKEN_RE } from '../protocol.ts';
import { t, type EnumS, type ObjS } from '../schema.ts';
import { createPolicyPackage, policyExportPage, validatePolicyPackage, type PolicyExportPage, type PolicyPackage, type PolicyPackageSource } from '../policy-package.ts';
import type { PolicyDetail } from '../policy/types.ts';
import { starterCatalog, type StarterCatalog } from '../policy/starters.ts';
import { MAX_INBOX, SAY_RATE, TELL_RATE, type CommanderLink, type LoggedMatch, type LoggedSeat, type Match, type PendingApproval } from './match.ts';
import type { CommanderLog } from './log.ts';
import {
  DeployQueue,
  artifactBytes,
  policyArtifactHash,
  annotateLoadError,
  checkIntent,
  defaultMandate,
  matchDataFor,
  mergeMatchOptions,
  parseMandate,
  looseDefinition,
  parseArgs,
  parseArtifact,
  parseChatRoles,
  parseChatText,
  starterOf,
  type LooseDefinition,
  type SeatKey,
} from './pipeline.ts';
import { emptyStats, loadSeatArtifact, PolicyRun } from './policy.ts';
import type { Pool } from './pool.ts';
import { parsePracticeRequest, runPractice } from './practice.ts';
import { DEPLOYED, OWNER_RE } from './store.ts';
import type {
  AgentSession,
  CreateCommander,
  ChatEntry,
  CommanderSaid,
  CommanderAgent,
  CommanderPracticeRequest,
  CommanderRegistry,
  CommanderSettings,
  CommanderSettingsPatch,
  CommanderStatus,
  CommanderStore,
  CommanderStoreData,
  PolicyExportOptions,
  StoredCommander,
  StoredCommanderArtifact,
  StoredOwner,
  LobbyReservation,
} from './types.ts';
import { PlayerThreeError, SerialWrites, snapshot, tokenDigest, TokenBucket } from './util.ts';
import { emptySeatSignals, withSignals } from '../signals.ts';


/** Library versions kept per commander (older ones are deleted). */
const MAX_VERSIONS = 10;
const LIVENESS_MS = 30_000;
const MAX_LOBBY_WAITERS = 4;
const MAX_SEED = 2 ** 31 - 1;
/** Chat log entries kept per owner (memory only). */
const MAX_CHAT_LOG = 100;

interface LobbyWaiter {
  finish(r: WaitResult): void;
  /** A match seated the lane: the wait continues there (held: until the start; running: its entry at once). */
  seated(): void;
}

interface Cmd {
  readonly owner: string;
  readonly id: string;
  readonly role: string;
  readonly stored: StoredCommander;
  /** Only the private registry identity owns this role -> execution lane map. */
  lanes?: Map<string, Cmd>;
  digest: string;
  lastSeen: number;
  activityGeneration: number;
  bindingGeneration: number;
  waiters: Set<LobbyWaiter>;
  seat: { match: Match<AnyManifest>; team: string; role: string } | undefined;
  /** Final match result retained until the commander's next wait. */
  endedWait?: MatchWait;
  /** A game lobby's reservation of this lane for the next match (`reserve`), and the agent's ready mark for it. */
  reservation?: { team: string; match?: unknown; start: LobbyReservation['start']; ready: boolean };
  /** The live match this lane's agent last saw (briefing, observe or wait), and whether it was running then. */
  observed?: { match: Match<AnyManifest>; running: boolean };
  /** Stats of the active version from its last probe or practice. */
  lastStats: PolicyStats | undefined;
  /** Lobby deploys, rollbacks and imports, one at a time in arrival order: the root's queue, shared by its lanes. */
  deploys: DeployQueue;
  inflight: number;
  approval: PendingApproval | undefined;
  approvalUnread: boolean;
  resolvingApproval?: string;
  /** Unread owner messages while in the lobby (moved into the seat when a match seats the commander). */
  inbox: OwnerMessage[];
  sayBucket: TokenBucket;
  /** The lane's last policy package export (`policyExport` page 1): later pages slice it, so they join. */
  exported?: { version: number; hash: string; text: string };
}

/** What a commander link stood for when its seat was prepared: the log's snapshot (later edits never rewrite it). */
interface LinkInfo {
  root: Cmd;
  owner: string;
  name: string;
  kind: 'agent' | 'policy';
  declared: CommanderLogSealed['declared'];
}

interface OwnerState {
  record: StoredOwner;
  cmds: Map<string, Cmd>;
  /** Owner ↔ commander chat, newest last (memory only; never persisted, replayed or pooled). */
  log: ChatEntry[];
  tellBucket: TokenBucket;
}

export interface CommanderHost {
  readonly definition: GameDefinition<AnyManifest>;
  readonly pool: Pool;
  readonly practices: Map<string, number>;
  /** Host default match options (validated); per-request practice options deep-merge over them. */
  readonly matchOptions: Record<string, unknown> | undefined;
  /** Host default match teams (validated): lobby probes and practice play these, the commander's seat on the first. */
  readonly teams: readonly string[];
  readonly resultMaxAgeMs: number;
  isDisposed(): boolean;
}

/** Per-principal limit key of a commander (shared by its lobby and in-match calls). */
function commanderKey(c: { owner: string; id: string; role: string }): string {
  return `commander:${c.owner}/${c.id}/${c.role}`;
}

export class Commanders implements CommanderRegistry {
  readonly ready: Promise<void>;
  private readonly host: CommanderHost;
  private readonly store: CommanderStore;
  private readonly m: AnyManifest;
  private readonly def: LooseDefinition;
  private readonly roles: readonly string[];
  private readonly opponents: readonly string[];
  private readonly skills: SkillDef[];
  private readonly starters: StarterCatalog;
  private readonly briefings = new Map<string, Briefing>();
  private readonly byOwner = new Map<string, OwnerState>();
  private readonly tokens = new Map<string, Cmd>();
  private readonly saidListeners = new Set<(owner: string, said: CommanderSaid) => void>();
  private readonly statusListeners = new Set<(owner: string, commanderId: string, role: string | null) => void>();
  private readonly links = new WeakMap<CommanderLink, LinkInfo>();
  private readonly commanderLog: CommanderLog;
  private readonly argSchemas;
  private key: Buffer | undefined;
  private loaded = false;
  private readonly writes = new SerialWrites(() => console.error('playerthree/commanders: store write failed'));

  constructor(host: CommanderHost, store: CommanderStore, log: CommanderLog) {
    this.host = host;
    this.store = store;
    this.commanderLog = log;
    this.def = looseDefinition(host.definition);
    this.m = this.def.manifest;
    this.roles = (this.m.roles as EnumS).values;
    this.opponents = (this.m.opponents as EnumS).values;
    this.skills = servedSkills(this.m);
    this.starters = starterCatalog(this.m);
    const eventKinds = ((this.m.event as ObjS).fields.kind as EnumS).values as [string, ...string[]];
    this.argSchemas = {
      wait: t.obj({ seconds: t.num(0, LIMITS.maxWaitSeconds), until: t.opt(t.list(t.enum(eventKinds), LIMITS.maxUntilKinds)) }),
      version: t.int(1, LIMITS.maxVersion),
      exportRequest: t.obj({ version: t.opt(t.int(1, LIMITS.maxVersion)), page: t.opt(t.int(1, LIMITS.maxPage)) }),
    };
    let data: CommanderStoreData | Promise<CommanderStoreData>;
    try {
      data = store.load();
    } catch (e) {
      data = Promise.reject(e);
    }
    if (data instanceof Promise) {
      this.ready = Promise.all([data.then((d) => this.init(d)), log.ready]).then(() => undefined);
      this.ready.catch(() => console.error('playerthree/commanders: store failed to load'));
    } else {
      this.init(data);
      this.ready = log.ready;
    }
  }

  // ------------------------------------------------------------------ load / persist

  private init(data: CommanderStoreData): void {
    if (typeof data.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(data.key)) this.key = Buffer.from(data.key, 'base64url');
    else {
      const key = randomBytes(32).toString('base64url');
      this.key = Buffer.from(key, 'base64url');
      this.writes.write(() => this.store.saveKey(key));
    }
    for (const raw of data.owners ?? []) {
      if (typeof raw?.owner !== 'string' || !OWNER_RE.test(raw.owner) || this.byOwner.has(raw.owner)) continue;
      const record: StoredOwner = { owner: raw.owner, createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(), commanders: [] };
      const state: OwnerState = { record, cmds: new Map(), log: [], tellBucket: new TokenBucket(TELL_RATE.perSecond, TELL_RATE.burst) };
      for (const found of raw.commanders) {
        if (!found || typeof found.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(found.id) || state.cmds.has(found.id)) throw new PlayerThreeError('invalid');
        if (Object.keys(found).some((key) => !['id', 'name', 'kind', 'roles', 'isolation', 'metadata', 'gen',
          'mandate', 'scopes', 'botLevel', 'versions', 'nextVersion', 'active', 'activeByRole', 'results', 'pendingMatches', 'lastPractice', 'lastSeenAt'].includes(key))) throw new PlayerThreeError('invalid');
        this.identity(found);
        const stored = this.sanitize(found);
        record.commanders.push(stored);
        this.attach(state, stored);
      }
      this.byOwner.set(record.owner, state);
      // Persist the one-time legacy role migration and crash-recovery conversion, never guess an ambiguous role.
      if (raw.commanders.some((c) => 'active' in c || Object.keys(c.pendingMatches ?? {}).length > 0)) this.save(record.owner);
    }
    this.loaded = true;
  }

  /** Stored data is re-validated against the current manifest; anything that does not fit falls back to defaults. */
  private sanitize(raw: StoredCommander): StoredCommander {
    const d = this.defaults();
    const c = raw;
    const runtimes: readonly string[] = this.m.control.policy?.runtimes ?? [];
    const versions = Array.isArray(c.versions)
      ? c.versions
          .filter((v) => isCount(v?.version, 1) && runtimes.includes(v.runtime) && Number.isFinite(v.createdAt) && typeof v.artifactHash === 'string' && /^[0-9a-f]{64}$/.test(v.artifactHash))
          .map((v) => ({ version: v.version, role: v.role === undefined && c.roles.length === 1 ? c.roles[0]! : typeof v.role === 'string' && c.roles.includes(v.role) ? v.role : null,
            runtime: v.runtime, createdAt: v.createdAt, bytes: isCount(v.bytes, 0) ? v.bytes : 0, surfaceHash: typeof v.surfaceHash === 'string' ? v.surfaceHash : '', artifactHash: v.artifactHash,
            ...storedStarter(v.from, v.knobs) }))
          .filter((v, i, all) => all.slice(i + 1).filter((other) => other.role === v.role).length < MAX_VERSIONS)
      : [];
    const maxVersion = versions.reduce((n, v) => Math.max(n, v.version), 0);
    const legacyActive = (c as StoredCommander & { active?: number | null }).active;
    const activeByRole = Object.fromEntries(c.roles.map((role) => {
      const active = c.activeByRole?.[role] ?? (c.roles.length === 1 ? legacyActive : null);
      return [role, versions.some((v) => v.version === active && v.role === role) ? active! : null];
    }));
    const results: StoredCommander['results'] = {};
    const now = Date.now();
    for (const role of c.roles) {
      const pending = c.pendingMatches?.[role];
      const saved = c.results?.[role];
      const source = pending ?? saved;
      if (!source || source.role !== role || typeof source.match !== 'string' || source.match.length > 128 ||
        !(this.m.teams as EnumS).values.includes(source.team) ||
        !Number.isFinite(source.at) || source.at < now - this.host.resultMaxAgeMs || source.at > now) continue;
      if (pending) {
        results[role] = { match: pending.match, team: pending.team, role, tick: null, outcome: 'unknown', disposition: 'interrupted', at: now };
      } else if (saved && (saved.tick === null || isCount(saved.tick, 0)) &&
        (saved.disposition === 'interrupted' && saved.outcome === 'unknown' ||
          saved.disposition === 'final' && saved.tick !== null && ['win', 'loss', 'draw'].includes(saved.outcome))) {
        results[role] = { match: saved.match, team: saved.team, role, tick: saved.tick, outcome: saved.outcome, disposition: saved.disposition, at: saved.at };
      }
    }
    let lastPractice = c.lastPractice ?? null;
    if (lastPractice !== null) {
      const ok =
        typeof lastPractice === 'object' &&
        this.opponents.includes(lastPractice.opponent) &&
        this.opponents.includes(lastPractice.allies) &&
        ['win', 'loss', 'draw', 'running'].includes(lastPractice.outcome) &&
        isCount(lastPractice.ticks, 0) &&
        isCount(lastPractice.seed, 0) &&
        typeof lastPractice.role === 'string' && c.roles.includes(lastPractice.role) &&
        isCount(lastPractice.version, 0) &&
        Number.isFinite(lastPractice.at) &&
        (lastPractice.report === null || validateUnknown(this.m.report, lastPractice.report).ok);
      lastPractice = ok ? { ...lastPractice } : null;
    }
    let mandate = d.mandate;
    try {
      if (c.mandate !== undefined) mandate = parseMandate(this.m, c.mandate);
    } catch {
      // Invalid persisted settings fall back to the current manifest's defaults.
    }
    return {
      id: c.id, ...this.identity(c),
      gen: isCount(c.gen, 1) ? c.gen : 1,
      mandate,
      scopes: Array.isArray(c.scopes) && c.scopes.every((s) => SCOPES.includes(s)) ? [...new Set(c.scopes)] : d.scopes,
      botLevel: this.opponents.includes(c.botLevel as string) ? (c.botLevel as string) : d.botLevel,
      versions,
      nextVersion: Math.max(isCount(c.nextVersion, 1) ? c.nextVersion : 1, maxVersion + 1),
      activeByRole,
      results,
      pendingMatches: {},
      lastPractice,
      lastSeenAt: Number.isFinite(c.lastSeenAt) ? (c.lastSeenAt as number) : null,
    };
  }

  private defaults(): CommanderSettings {
    return {
      mandate: defaultMandate(this.m),
      scopes: defaultScopes(this.m),
      botLevel: this.opponents[Math.max(0, this.opponents.length - 2)] as string,
    };
  }

  private attach(state: OwnerState, stored: StoredCommander): Cmd {
    const cmd: Cmd = {
      owner: state.record.owner,
      id: stored.id,
      get role() { return this.seat?.role ?? stored.roles[0]!; },
      stored,
      lanes: new Map(),
      digest: '',
      lastSeen: stored.lastSeenAt ?? 0,
      activityGeneration: 0,
      bindingGeneration: 0,
      waiters: new Set(),
      seat: undefined,
      lastStats: undefined,
      deploys: new DeployQueue(),
      inflight: 0,
      approval: undefined,
      approvalUnread: false,
      inbox: [],
      sayBucket: new TokenBucket(SAY_RATE.perSecond, SAY_RATE.burst),
    };
    this.setDigest(cmd);
    state.cmds.set(stored.id, cmd);
    return cmd;
  }

  private lane(root: Cmd, role: string): Cmd {
    if (!root.stored.roles.includes(role)) throw new PlayerThreeError('invalid');
    let lane = root.lanes!.get(role);
    if (!lane) {
      lane = {
        owner: root.owner, id: root.id, role, stored: root.stored, digest: '',
        lastSeen: 0, activityGeneration: 0, bindingGeneration: 0, waiters: new Set(), seat: undefined,
        lastStats: undefined, inflight: 0, approval: undefined, approvalUnread: false,
        inbox: [], sayBucket: new TokenBucket(SAY_RATE.perSecond, SAY_RATE.burst),
        deploys: root.deploys,
      };
      root.lanes!.set(role, lane);
    }
    return lane;
  }

  private liveSeats(root: Cmd): NonNullable<Cmd['seat']>[] {
    return [...root.lanes!.values()].flatMap((lane) => {
      const seat = this.liveSeat(lane);
      return seat ? [seat] : [];
    });
  }

  private setDigest(cmd: Cmd): void {
    if (cmd.digest) this.tokens.delete(cmd.digest);
    cmd.digest = tokenDigest(this.derive(cmd));
    this.tokens.set(cmd.digest, cmd);
  }

  /** Deterministic token for (owner, commander ID, generation), independent of execution role. */
  private derive(cmd: Cmd): string {
    const key = this.key as Buffer;
    for (let n = 0; ; n++) {
      const token = createHmac('sha256', key)
        .update(`playerthree/commander\0${this.m.id}\0${cmd.owner}\0${cmd.id}\0${cmd.stored.gen}\0${n}`)
        .digest()
        .subarray(0, 24)
        .toString('base64url');
      if (token[0] !== '-' && token[0] !== '_') return token;
    }
  }

  private save(owner: string): void {
    const state = this.byOwner.get(owner);
    if (!state) return;
    for (const c of state.cmds.values()) c.stored.lastSeenAt = Math.max(c.lastSeen, ...[...c.lanes!.values()].map((lane) => lane.lastSeen)) || null;
    const record = structuredClone(state.record);
    this.writes.write(() => this.store.saveOwner(record));
  }

  // ------------------------------------------------------------------ owner API

  private live(): void {
    if (!this.loaded || this.host.isDisposed()) throw new PlayerThreeError('busy');
  }

  private ownerState(owner: unknown): OwnerState {
    this.live();
    const state = typeof owner === 'string' ? this.byOwner.get(owner) : undefined;
    if (!state) throw new PlayerThreeError('invalid');
    return state;
  }

  private cmd(owner: unknown, id: unknown): Cmd {
    const cmd = typeof id === 'string' ? this.ownerState(owner).cmds.get(id) : undefined;
    if (!cmd) throw new PlayerThreeError('invalid');
    return cmd;
  }

  private settings(base: CommanderSettings, patch: unknown): CommanderSettings {
    const snap = snapshot(patch ?? {});
    if (!snap.ok || snap.value === null || typeof snap.value !== 'object' || Array.isArray(snap.value)) throw new PlayerThreeError('invalid');
    const p = snap.value as Record<string, unknown>;
    for (const k of Object.keys(p)) if (k !== 'mandate' && k !== 'scopes' && k !== 'botLevel') throw new PlayerThreeError('invalid');
    const out = { ...base };
    if (p.mandate !== undefined) {
      if (p.mandate === null || typeof p.mandate !== 'object' || Array.isArray(p.mandate)) throw new PlayerThreeError('invalid');
      out.mandate = parseMandate(this.m, { ...base.mandate, ...p.mandate });
    }
    if (p.scopes !== undefined) {
      if (!Array.isArray(p.scopes) || !p.scopes.every((s) => SCOPES.includes(s as Scope))) throw new PlayerThreeError('invalid');
      out.scopes = [...new Set(p.scopes as Scope[])];
    }
    if (p.botLevel !== undefined) {
      if (!this.opponents.includes(p.botLevel as string)) throw new PlayerThreeError('invalid');
      out.botLevel = p.botLevel as string;
    }
    return out;
  }

  ensure(owner: string): CommanderStatus[] {
    this.live();
    if (typeof owner !== 'string' || !OWNER_RE.test(owner)) throw new PlayerThreeError('invalid');
    if (!this.byOwner.has(owner)) {
      this.byOwner.set(owner, { record: { owner, createdAt: Date.now(), commanders: [] }, cmds: new Map(),
        log: [], tellBucket: new TokenBucket(TELL_RATE.perSecond, TELL_RATE.burst) });
      this.save(owner);
    }
    return this.roster(owner);
  }

  private identity(input: CreateCommander): CreateCommander {
    if (!input || typeof input !== 'object' ||
      typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.length > 80 ||
      !['agent', 'policy'].includes(input.kind) || !Array.isArray(input.roles) || input.roles.length < 1 ||
      input.roles.length > this.roles.length || new Set(input.roles).size !== input.roles.length ||
      input.roles.some((r) => !this.roles.includes(r)) || !input.isolation ||
      Object.keys(input.isolation).length !== 1 || typeof input.isolation.independentSessions !== 'boolean' ||
      input.metadata !== undefined && (input.metadata === null || typeof input.metadata !== 'object' || Array.isArray(input.metadata) ||
        Object.entries(input.metadata).some(([k, v]) => !['provider', 'model', 'scaffoldVersion'].includes(k) ||
          typeof v !== 'string' || v.length < 1 || v.length > 80))) throw new PlayerThreeError('invalid');
    return { name: input.name.trim(), kind: input.kind, roles: [...input.roles], isolation: { ...input.isolation },
      ...(input.metadata ? { metadata: { ...input.metadata } } : {}) };
  }

  create(owner: string, input: CreateCommander): CommanderStatus {
    this.ensure(owner);
    if (!input || Object.keys(input).some((key) => !['name', 'kind', 'roles', 'isolation', 'metadata'].includes(key))) throw new PlayerThreeError('invalid');
    const state = this.ownerState(owner);
    if (state.cmds.size >= 64) throw new PlayerThreeError('busy');
    const stored: StoredCommander = { ...this.identity(input), id: randomUUID(), ...this.defaults(),
      gen: 1, versions: [], nextVersion: 1, activeByRole: Object.fromEntries(input.roles.map((role) => [role, null])), results: {}, pendingMatches: {},
      lastPractice: null, lastSeenAt: null };
    state.record.commanders.push(stored);
    const c = this.attach(state, stored);
    this.save(owner);
    this.statusChanged(c);
    return this.status(c);
  }

  rename(owner: string, id: string, input: CreateCommander): CommanderStatus {
    const c = this.cmd(owner, id);
    if (!input || Object.keys(input).some((key) => !['name', 'kind', 'roles', 'isolation', 'metadata'].includes(key))) throw new PlayerThreeError('invalid');
    if (this.liveSeats(c).length > 0) throw new PlayerThreeError('busy');
    Object.assign(c.stored, this.identity(input), { metadata: input.metadata ? { ...input.metadata } : undefined });
    for (const [role, lane] of c.lanes!) if (!c.stored.roles.includes(role)) {
      for (const waiter of [...lane.waiters]) waiter.finish(unseated());
      c.lanes!.delete(role);
    }
    for (const role of Object.keys(c.stored.results)) if (!c.stored.roles.includes(role)) delete c.stored.results[role];
    for (const role of Object.keys(c.stored.pendingMatches)) if (!c.stored.roles.includes(role)) delete c.stored.pendingMatches[role];
    for (const role of Object.keys(c.stored.activeByRole)) if (!c.stored.roles.includes(role)) delete c.stored.activeByRole[role];
    for (const role of c.stored.roles) c.stored.activeByRole[role] ??= null;
    this.save(owner);
    this.statusChanged(c);
    return this.status(c);
  }

  async delete(owner: string, id: string): Promise<void> {
    const state = this.ownerState(owner);
    const c = this.cmd(owner, id);
    if (this.liveSeats(c).length > 0) throw new PlayerThreeError('busy');
    this.tokens.delete(c.digest);
    state.cmds.delete(id);
    state.record.commanders = state.record.commanders.filter((entry) => entry.id !== id);
    for (const lane of c.lanes!.values()) for (const w of [...lane.waiters]) w.finish(unseated());
    for (const v of c.stored.versions) this.writes.write(() => this.store.deleteArtifact(owner, id, v.version));
    this.save(owner);
    this.commanderLog.redact(id);
    this.statusChanged(c);
    await this.writes.flush();
  }

  has(owner: string): boolean {
    return this.loaded && typeof owner === 'string' && this.byOwner.has(owner);
  }

  owners(): string[] {
    return this.loaded ? [...this.byOwner.keys()].sort() : [];
  }
  roster(owner: string): CommanderStatus[] {
    return [...this.ownerState(owner).cmds.values()].map((c) => this.status(c));
  }

  async log(owner: string, id: string): Promise<StoredCommanderLogEntry[]> {
    return this.commanderLog.entries(this.cmd(owner, id).id);
  }

  publicId(owner: string, id: string): string {
    return commanderPublicId(this.m.id, this.cmd(owner, id).id);
  }

  private status(c: Cmd): CommanderStatus {
    const s = c.stored;
    const seats = this.liveSeats(c);
    const seat = seats[0];
    return {
      id: c.id, ...this.identity(s),
      mandate: structuredClone(s.mandate),
      scopes: [...s.scopes],
      botLevel: s.botLevel,
      policy: { activeByRole: { ...s.activeByRole }, versions: s.versions.map((v) => ({ ...v })) },
      record: this.commanderLog.record(c.id),
      lastPractice: s.lastPractice ? structuredClone(s.lastPractice) : null,
      connected: this.connected(c),
      lastSeenAt: Math.max(c.lastSeen, ...[...c.lanes!.values()].map((lane) => lane.lastSeen)) || null,
      seated: seat ? { match: seat.match.id, team: seat.team, roles: seats.map((entry) => entry.role) } : null,
      approvals: [...c.lanes!.values()].flatMap((lane) => lane.approval ? [{ role: lane.role, approval: { ...lane.approval.approval } }] : []),
      reservations: [...c.lanes!.values()].flatMap((lane) => lane.reservation ? [{ team: lane.reservation.team, role: lane.role, ready: lane.reservation.ready }] : []),
    };
  }

  reserve(owner: string, id: string, role: string, reservation: LobbyReservation | null): void {
    const root = this.cmd(owner, id);
    const lane = this.lane(root, role);
    let next: Cmd['reservation'];
    if (reservation !== null) {
      const keys = reservation !== undefined && typeof reservation === 'object' ? Object.keys(reservation) : ['?'];
      const start = reservation?.start;
      if (keys.some((key) => !['team', 'match', 'start'].includes(key)) || !(this.m.teams as EnumS).values.includes(reservation.team) ||
        start === null || typeof start !== 'object' || !['host', 'ready', 'countdown'].includes(start.kind) ||
        Object.keys(start).some((key) => key !== 'kind' && key !== 'at') ||
        start.at !== undefined && (typeof start.at !== 'number' || !Number.isFinite(start.at))) throw new PlayerThreeError('invalid');
      let match: unknown;
      if (reservation.match !== undefined) {
        if (!this.m.lobby) throw new PlayerThreeError('invalid');
        const r = createGuard({ onDrop: () => {} }).pass('lobby', this.m.lobby, reservation.match);
        if (!r.ok) throw new PlayerThreeError('invalid');
        match = r.value;
      }
      // One commander, one team: a lane reserved on another team would show its agent both sides' seats.
      if ([...root.lanes!.values()].some((other) => other !== lane && other.reservation && other.reservation.team !== reservation.team)) throw new PlayerThreeError('busy');
      // The agent's ready mark belongs to the seat: it survives updates of the summary or start, not a new seat.
      const ready = lane.reservation?.team === reservation.team && lane.reservation.ready;
      next = { team: reservation.team, ...(match !== undefined ? { match } : {}), start: { kind: start.kind, ...(start.at !== undefined ? { at: start.at } : {}) }, ready };
    }
    const moved = lane.reservation?.team !== next?.team;
    lane.reservation = next;
    if (moved) for (const w of [...lane.waiters]) w.finish(this.lobbyState(lane));
    this.statusChanged(lane);
  }

  private previousMatch(c: Cmd): { previousMatch?: MatchReceipt } {
    const result = c.stored.results[c.role];
    if (!result) return {};
    if (result.at < Date.now() - this.host.resultMaxAgeMs) {
      delete c.stored.results[c.role];
      this.save(c.owner);
      return {};
    }
    return { previousMatch: { ...result } };
  }

  /**
   * The lobby state of a lane while no match seats it: its reservation, if a game lobby made one. A lane that may deploy
   * (policy mode, policy scope) but has no active policy and no pending approval is told to deploy first (spec §4).
   */
  private lobbyState(c: Cmd): LobbyState {
    const noPolicy = this.m.control.policy !== undefined && c.stored.scopes.includes('policy') &&
      (c.stored.activeByRole[c.role] ?? null) === null && c.approval?.approval.status !== 'pending';
    const r = c.reservation;
    if (!r) return { ...unseated(), ...(noPolicy ? { instruction: LOBBY_INSTRUCTIONS.noPolicy } : {}), ...this.previousMatch(c) };
    const start: LobbyStart = r.start.at === undefined ? { kind: r.start.kind } : { kind: r.start.kind, inSeconds: Math.max(0, Math.ceil((r.start.at - Date.now()) / 1000)) };
    return {
      phase: 'lobby', seat: { team: r.team, role: c.role }, ...(r.match !== undefined ? { match: structuredClone(r.match) } : {}),
      you: { ready: r.ready }, startsWhen: start,
      instruction: noPolicy ? LOBBY_INSTRUCTIONS.noPolicy : r.ready ? LOBBY_INSTRUCTIONS.ready : LOBBY_INSTRUCTIONS.seated,
      ...this.previousMatch(c),
    };
  }

  /** `ready` while no match seats the lane: marks its reservation (nothing to mark without one). */
  private lobbyReady(c: Cmd): ReadyResult {
    if (c.reservation && !c.reservation.ready) {
      c.reservation.ready = true;
      this.statusChanged(c);
    }
    return this.lobbyState(c);
  }

  update(owner: string, id: string, patch: CommanderSettingsPatch): CommanderStatus {
    const c = this.cmd(owner, id);
    const seats = this.liveSeats(c);
    if (seats.some((seat) => !seat.match.coachingAllowed(owner))) throw new PlayerThreeError('forbidden');
    const next = this.settings(c.stored, patch);
    Object.assign(c.stored, next);
    for (const seat of seats) seat.match.updateCommanderSettings(seat.team, seat.role, structuredClone(next));
    this.save(owner);
    return this.status(c);
  }

  token(owner: string, id: string): string {
    return this.derive(this.cmd(owner, id));
  }

  rotate(owner: string, id: string): string {
    const c = this.cmd(owner, id);
    c.stored.gen += 1;
    this.setDigest(c);
    // Waits the old token is blocked in end now.
    for (const lane of c.lanes!.values()) for (const w of [...lane.waiters]) w.finish(unseated());
    this.save(owner);
    this.statusChanged(c);
    return this.derive(c);
  }

  practice(owner: string, id: string, req: CommanderPracticeRequest): Promise<PracticeResult> {
    const root = this.cmd(owner, id);
    if (!req || typeof req !== 'object' || 'artifact' in req || !root.stored.roles.includes(req.role)) throw new PlayerThreeError('invalid');
    const { role, ...request } = req;
    const c = this.lane(root, role);
    return this.lobbyPractice(c, request);
  }

  async rollback(owner: string, id: string, role: string, version: number): Promise<DeployResult> {
    const c = this.lane(this.cmd(owner, id), role);
    const v = parseArgs(this.argSchemas.version, version);
    const seat = this.liveSeat(c);
    // Seated: roll the live seat back with owner rights; the match reports the activation to the library.
    if (seat) return seat.match.seat(seat.team as never, c.role as never).policyRollback(v);
    return this.lobbyRollback(c, v);
  }

  async exportPolicy(owner: string, id: string, version: number, opts: PolicyExportOptions = {}): Promise<PolicyPackage> {
    const root = this.cmd(owner, id);
    if (opts === null || typeof opts !== 'object' || (opts.role !== undefined && !root.stored.roles.includes(opts.role))) throw new PlayerThreeError('invalid');
    return this.packageOf(root, parseArgs(this.argSchemas.version, version), opts);
  }

  async importPolicy(owner: string, id: string, pkg: unknown, opts: { role?: string } = {}): Promise<PolicyImportResult> {
    const root = this.cmd(owner, id);
    if (opts === null || typeof opts !== 'object') throw new PlayerThreeError('invalid');
    // The lane: the given role, else the first of the commander's roles the (valid) package drives.
    const roles = validatePolicyPackage(pkg, this.policyLimits(), this.m)?.roles ?? [];
    const role = opts.role ?? root.stored.roles.find((r) => roles.includes(r));
    if (role === undefined) throw new PlayerThreeError('invalid');
    const c = this.lane(root, role);
    const seat = this.liveSeat(c);
    // Seated: import with owner rights through the live seat, so the match can also roll back to the new version.
    if (seat) return seat.match.seat(seat.team as never, c.role as never).policyImport(pkg as PolicyPackage);
    return (await this.importInto(c, pkg)).result;
  }

  async resolveApproval(owner: string, commanderId: string, id: string, approve: boolean): Promise<DeployResult | PublishResult | void> {
    const root = this.cmd(owner, commanderId);
    if (typeof id !== 'string' || typeof approve !== 'boolean') throw new PlayerThreeError('invalid');
    const c = [...root.lanes!.values()].find((lane) => lane.approval?.approval.id === id);
    if (!c) throw new PlayerThreeError('approval_not_found');
    const seat = this.liveSeat(c);
    if (seat) return seat.match.resolveApproval(seat.team, c.role, id, approve);
    const pending = c.approval;
    if (!pending || pending.approval.id !== id || pending.approval.status !== 'pending') throw new PlayerThreeError('approval_not_found');
    if (c.resolvingApproval === id) throw new PlayerThreeError('approval_pending');
    if (!approve) {
      pending.approval.status = 'rejected';
      this.approvalChanged(c, pending);
      return;
    }
    c.resolvingApproval = id;
    try {
      const action = pending.action;
      if (action.kind === 'policyDeploy' && c.stored.nextVersion !== pending.approval.version) throw new PlayerThreeError('approval_failed');
      const result = action.kind === 'policyDeploy'
        ? await this.lobbyDeploy(c, action.artifact)
        : action.kind === 'policyRollback'
          ? await this.lobbyRollback(c, action.version)
          : await this.lobbyPublish(c, action.version);
      pending.approval.status = 'ok' in result && !result.ok ? 'failed' : 'approved';
      if (c.approval === pending) this.approvalChanged(c, pending);
      return result;
    } catch {
      pending.approval.status = 'failed';
      if (c.approval === pending) this.approvalChanged(c, pending);
      throw new PlayerThreeError('approval_failed');
    } finally {
      if (c.resolvingApproval === id) c.resolvingApproval = undefined;
    }
  }

  private requestApproval(c: Cmd, action: PendingApproval['action']): { ok: false; approval: ApprovalRequest } {
    if (c.resolvingApproval !== undefined || c.deploys.size > 0) throw new PlayerThreeError('approval_pending');
    const approval: Approval = { id: randomUUID(), kind: action.kind, version: action.kind === 'policyDeploy' ? c.stored.nextVersion : action.version, status: 'pending' };
    this.approvalChanged(c, { approval, action });
    return { ok: false, approval: { id: approval.id, kind: approval.kind, version: approval.version } };
  }

  private approvalChanged(c: Cmd, pending: PendingApproval, notify = true): void {
    if (!this.current(c)) return;
    c.approval = pending;
    c.approvalUnread = c.waiters.size === 0;
    for (const waiter of [...c.waiters]) waiter.finish({ ...this.lobbyState(c), wake: 'approval' });
    if (notify) this.statusChanged(c);
  }

  async remove(owner: string): Promise<void> {
    const state = this.ownerState(owner);
    for (const c of state.cmds.values()) {
      this.tokens.delete(c.digest);
      for (const lane of c.lanes!.values()) {
        for (const w of [...lane.waiters]) w.finish(unseated());
        const seat = this.liveSeat(lane);
        if (seat) seat.match.revokeSeat(seat.team, seat.role);
        lane.seat = undefined;
      }
    }
    this.byOwner.delete(owner);
    for (const id of state.cmds.keys()) this.commanderLog.redact(id);
    for (const c of state.cmds.values()) this.statusChanged(c);
    this.writes.write(() => this.store.deleteOwner(owner));
    await this.writes.flush();
  }

  // ------------------------------------------------------------------ owner chat

  private chatMode() {
    const chat = this.m.control.chat;
    if (!chat) throw new PlayerThreeError('mode_unavailable');
    return chat;
  }

  private logChat(state: OwnerState, entry: ChatEntry): void {
    state.log.push(entry);
    if (state.log.length > MAX_CHAT_LOG) state.log.splice(0, state.log.length - MAX_CHAT_LOG);
  }

  tell(owner: string, roles: readonly string[] | 'all', text: string, ping?: unknown): void {
    const state = this.ownerState(owner);
    const chat = this.chatMode();
    const targets = parseChatRoles(roles, [...state.cmds.keys()]);
    const active = [...state.cmds.values()].flatMap((c) => this.liveSeats(c));
    if (new Set(active.map((s) => `${s.match.id}/${s.team}`)).size > 1 ||
      active.some((s) => !s.match.coachingAllowed(owner))) throw new PlayerThreeError('forbidden');
    const body = parseChatText(text, chat.maxTellChars);
    let typedPing: unknown;
    if (ping !== undefined) {
      if (!chat.ping) throw new PlayerThreeError('invalid');
      const snap = snapshot(ping);
      const r = snap.ok ? validateUnknown(chat.ping, snap.value) : snap;
      if (!r.ok) throw new PlayerThreeError('invalid');
      typedPing = r.value;
    }
    if (!state.tellBucket.take()) throw new PlayerThreeError('rate_limited');
    const message: OwnerMessage = { from: 'owner', tick: 0, text: body, ...(typedPing !== undefined ? { ping: typedPing } : {}) };
    this.logChat(state, { at: Date.now(), from: 'owner', commanderIds: targets, tick: 0, text: body, ...(typedPing !== undefined ? { ping: typedPing } : {}) });
    for (const id of targets) {
      const root = state.cmds.get(id)!;
      for (const role of root.stored.roles) {
        const c = this.lane(root, role);
        const seat = this.liveSeat(c);
        if (seat) seat.match.deliverTo(seat.team, c.role, structuredClone(message));
        else this.lobbyDeliver(c, structuredClone(message));
      }
    }
  }

  chat(owner: string): ChatEntry[] {
    return structuredClone(this.ownerState(owner).log);
  }

  onSaid(listener: (owner: string, said: CommanderSaid) => void): () => void {
    this.saidListeners.add(listener);
    return () => this.saidListeners.delete(listener);
  }

  onStatus(listener: (owner: string, commanderId: string, role: string | null) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** A registry identity (it owns `lanes`) changed as a whole; an execution lane changed only its own role. */
  private statusChanged(c: Cmd): void {
    const role = c.lanes ? null : c.role;
    for (const listener of this.statusListeners) {
      try {
        listener(c.owner, c.id, role);
      } catch {
        // Status observers must not interrupt commander mutations.
      }
    }
  }

  private lobbyDeliver(c: Cmd, message: OwnerMessage): void {
    c.inbox.push(message);
    if (c.inbox.length > MAX_INBOX) c.inbox.splice(0, c.inbox.length - MAX_INBOX);
    const [w] = c.waiters;
    if (w) w.finish({ ...this.lobbyState(c), messages: c.inbox.splice(0, c.inbox.length), wake: 'owner_message' });
    this.statusChanged(c);
  }

  /** An agent reply (lobby or match) lands in the owner's chat log and goes to the registry's listeners. */
  private recordSaid(c: Cmd, said: Said): void {
    const state = this.byOwner.get(c.owner);
    if (!state || state.cmds.get(c.id)?.stored !== c.stored) return;
    this.logChat(state, { at: Date.now(), from: 'agent', commanderIds: [c.id], tick: said.tick, text: said.text });
    for (const l of this.saidListeners) {
      try {
        l(c.owner, { ...said, commanderId: c.id });
      } catch {
        // A listener must not break the agent's call.
      }
    }
  }

  private lobbySay(c: Cmd, raw: unknown): SayResult {
    const text = parseChatText(raw, this.chatMode().maxSayChars);
    if (!c.sayBucket.take()) throw new PlayerThreeError('rate_limited');
    this.recordSaid(c, { role: c.role, tick: 0, text });
    return { ok: true, tick: 0 };
  }

  // ------------------------------------------------------------------ agents

  agentSession(token: string, role?: string): AgentSession | undefined {
    if (!this.loaded || this.host.isDisposed() || typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
    const c = this.tokens.get(tokenDigest(token));
    if (!c) return undefined;
    const gen = c.stored.gen;
    const agent = this.agent(c.owner, c.id, () => c.stored.gen === gen, role);
    if (!agent) return undefined;
    return {
      kind: 'commander',
      control: agent.control,
      reportUsage: agent.reportUsage,
      owner: c.owner,
      commanderId: c.id,
      role: role ?? c.role,
      key: `${c.owner}/${c.id}/${gen}/${role ?? c.role}`,
      drain: agent.drain,
      seat: agent.seat,
      status: agent.status,
    };
  }

  agent(owner: string, id: string, valid: () => boolean, role?: string): CommanderAgent | undefined {
    if (!this.loaded || this.host.isDisposed() || typeof owner !== 'string' || typeof id !== 'string') return undefined;
    const root = this.byOwner.get(owner)?.cmds.get(id);
    const selectedRole = role ?? root?.stored.roles[0];
    if (!root || selectedRole === undefined || !root.stored.roles.includes(selectedRole)) return undefined;
    const c = this.lane(root, selectedRole);
    const allowed = () => valid() && root.lanes!.get(selectedRole) === c && root.stored.roles.includes(selectedRole);
    return {
      control: this.routing(c, allowed),
      reportUsage: (report: DecisionUsage) => {
        if (!allowed() || !this.current(c)) throw new PlayerThreeError('bad_token');
        const seat = this.liveSeat(c);
        if (!seat) throw new PlayerThreeError('not_in_match');
        seat.match.recordUsage(seat.team, seat.role, report);
      },
      drain: () => this.drain(c, allowed),
      seat: () => allowed() ? this.seatOf(c) : null,
      status: () => this.seatStatus(c, allowed),
      active: () => allowed() && this.current(c) && this.connected(c),
    };
  }

  private seatOf(c: Cmd): { match: string; team: string; role: string } | null {
    const seat = this.current(c) ? this.liveSeat(c) : undefined;
    return seat ? { match: seat.match.id, team: seat.team, role: seat.role } : null;
  }

  private seatStatus(c: Cmd, valid: () => boolean): SeatStatus {
    if (this.host.isDisposed() || !valid() || !this.current(c)) throw new PlayerThreeError('bad_token');
    const seat = this.liveSeat(c);
    if (seat) return { ...seat.match.status(seat.team, c.role), ...this.previousMatch(c) };
    return {
      phase: 'lobby',
      tick: c.endedWait?.tick ?? 0,
      ...(c.endedWait ? { outcome: c.endedWait.outcome } : {}),
      ...(c.approval ? { approval: { ...c.approval.approval } } : {}),
      unreadOwnerMessages: c.inbox.length,
      ...this.previousMatch(c),
    };
  }

  private drain(c: Cmd, valid: () => boolean): OwnerMessage[] {
    if (this.host.isDisposed() || !valid() || !this.current(c) || !this.m.control.chat) return [];
    const seat = this.liveSeat(c);
    if (seat) return seat.match.inboxFor({ kind: 'seat', match: seat.match.id, team: seat.team, role: c.role });
    return c.inbox.splice(0, c.inbox.length);
  }

  private connected(c: Cmd): boolean {
    const seat = this.liveSeat(c);
    return !!c.lanes && [...c.lanes.values()].some((lane) => this.connected(lane)) ||
      c.inflight > 0 || c.waiters.size > 0 || Date.now() - c.lastSeen < LIVENESS_MS || !!seat?.match.sequenceActive(seat.team, c.role);
  }

  private liveSeat(c: Cmd): Cmd['seat'] {
    const seat = c.seat;
    return seat && !seat.match.disposed && !seat.match.over ? seat : undefined;
  }

  /**
   * The control plane of one commander session (a token generation, or an OAuth connection holding the role): the
   * live seat while one exists, else lobby semantics. Stops working (bad_token) once `valid()` is false (token
   * rotated, connection revoked or role removed) or the roster is removed.
   */
  private routing(c: Cmd, valid: () => boolean): SeatControl {
    // Seating, and the start of a held match, are transitions until the lane's agent has seen them (any session of
    // the lane: MCP calls are stateless, so a session per call must not forget them): its next wait returns at once.
    const saw = (match: Match<AnyManifest> | undefined): void => {
      c.observed = match ? { match, running: match.phase() === 'match' } : undefined;
    };
    const route = <T>(method: ControlMethod, inMatch: (control: SeatControl) => Promise<T>, inLobby: () => Promise<T> | T): Promise<T> => {
      if (this.host.isDisposed() || !valid() || !this.current(c)) return Promise.reject(new PlayerThreeError('bad_token'));
      c.lastSeen = Date.now();
      c.activityGeneration++;
      const scope = METHOD_SCOPE[method];
      const track = async (call: () => Promise<T> | T): Promise<T> => {
        c.inflight++;
        try {
          return await call();
        } finally {
          c.inflight--;
        }
      };
      const seat = this.liveSeat(c);
      if (seat) {
        seat.match.commanderCall(seat.team, c.role);
        const bindingGeneration = c.bindingGeneration;
        const control = seat.match.controlFor({ kind: 'seat', match: seat.match.id, team: seat.team, role: c.role }, commanderKey(c),
          () => !this.host.isDisposed() && valid() && this.current(c) && c.bindingGeneration === bindingGeneration &&
            (this.liveSeat(c)?.match === seat.match || c.stored.results[c.role]?.match === seat.match.id));
        if (control) return track(() => inMatch(control));
      }
      const mode = METHOD_MODE[method];
      if (method !== 'policyStatus' && mode !== 'intents' && !this.m.control[mode]) return Promise.reject(new PlayerThreeError('mode_unavailable'));
      if (scope && method !== 'act' && !c.stored.scopes.includes(scope)) return Promise.reject(new PlayerThreeError('out_of_scope'));
      return track(inLobby);
    };
    return {
      briefing: ((topic?: string, page?: number) => route('briefing', async (x) => {
        const match = this.liveSeat(c)?.match;
        const result = topic === undefined ? await x.briefing() : await x.briefing(topic, page);
        saw(match);
        return result;
      }, () => (topic === undefined ? this.lobbyBriefing(c) : topicPage(this.m, topic, page)))) as SeatControl['briefing'],
      observe: (since, detail) =>
        route('observe', async (x) => {
          const match = this.liveSeat(c)?.match;
          const result = await x.observe(since, detail);
          saw(match);
          return result;
        }, () => this.lobbyState(c)),
      act: (intents) =>
        route('act', (x) => x.act(intents), () => {
          if (!Array.isArray(intents) || intents.length > LIMITS.maxIntentsPerCall) throw new PlayerThreeError('invalid');
          if (!c.stored.scopes.includes('act')) return intents.map(() => ({ ok: false as const, code: 'out_of_scope' as const }));
          throw new PlayerThreeError('not_in_match');
        }),
      sequence: (request) => route('sequence', (x) => x.sequence(request), () => {
        throw new PlayerThreeError('not_in_match');
      }),
      wait: (req) => {
        const routed = (request: unknown): Promise<WaitResult> => route('wait', async (x) => {
          const seat = this.liveSeat(c)!;
          const match = seat.match;
          const running = match.phase() === 'match';
          const newlySeated = c.observed?.match !== match || running && !c.observed.running;
          const parsed = newlySeated ? parseArgs(this.argSchemas.wait, request) : request as WaitRequest;
          // Let an owner message delivered alongside this call join the immediate transition result.
          if (newlySeated) await Promise.resolve();
          // Seated into (or started) a running match: its entry at once. Seated into a held one: an unready agent
          // learns its seat at once, a ready one keeps waiting for the start (which returns the entry).
          const immediate = newlySeated && (running || !match.agentReady(seat.team, c.role));
          const result = await x.wait(immediate ? { ...parsed, seconds: 0 } : parsed);
          saw(match);
          if (result.phase === 'match' && result.outcome !== 'running') c.endedWait = undefined;
          if (immediate && running && result.phase === 'match' && result.outcome === 'running' && result.observation === undefined) {
            return { ...result, observation: await x.observe(), instruction: MATCH_INSTRUCTION };
          }
          return result;
        }, async () => {
          let continued = false;
          const result = await this.lobbyWait(c, request, (rest) => {
            continued = true;
            return routed(rest);
          });
          if (!continued) saw(undefined);
          return result;
        });
        return routed(req).then((result) => ({ ...result, ...this.previousMatch(c) }));
      },
      ready: () => route('ready', (x) => x.ready(), () => this.lobbyReady(c)),
      skill: (name, path, offset) => route('skill', (x) => x.skill(name, path, offset), () => skillPage(this.skills, name, path, offset)),
      policyDeploy: (artifact) => route('policyDeploy', (x) => x.policyDeploy(artifact), () => this.lobbyDeploy(c, artifact, true)),
      policyStatus: () => route('policyStatus', (x) => x.policyStatus(), () => this.lobbyStatus(c)),
      policyRollback: (version) =>
        route('policyRollback', (x) => x.policyRollback(version), () => this.lobbyRollback(c, parseArgs(this.argSchemas.version, version), true)),
      policyExport: (request) => route('policyExport', (x) => x.policyExport(request), () => this.lobbyExport(c, request)),
      policyImport: (pkg) => route('policyImport', (x) => x.policyImport(pkg), async () => (await this.importInto(c, pkg)).result),
      practice: (req) => route('practice', (x) => x.practice(req), () => this.lobbyPractice(c, req)),
      publish: () => route('publish', (x) => x.publish(), () => this.lobbyPublish(c, c.stored.activeByRole[c.role] ?? null, true)),
      say: (text, disclosure) => route('say', (x) => x.say(text, disclosure), () => {
        if (disclosure) throw new PlayerThreeError('not_in_match');
        return this.lobbySay(c, text);
      }),
    };
  }

  // ------------------------------------------------------------------ lobby

  private lobbyBriefing(c: Cmd): Briefing {
    const role = c.role;
    let b = this.briefings.get(role);
    if (!b) {
      b = buildBriefing(this.m, { role });
      this.briefings.set(role, b);
    }
    return { ...structuredClone(b), scopes: [...c.stored.scopes], mandate: structuredClone(c.stored.mandate) };
  }

  /**
   * Blocks up to `seconds` (wall clock). When a match seats the lane meanwhile, the wait continues there for the time
   * left (`seated`): a running match returns its entry at once, a held one the start (or the seat, to an unready agent).
   */
  private lobbyWait(c: Cmd, raw: unknown, seated: (rest: WaitRequest) => Promise<WaitResult>): Promise<WaitResult> {
    const req = parseArgs(this.argSchemas.wait, raw);
    if (c.endedWait) {
      const result = c.endedWait;
      c.endedWait = undefined;
      const messages = this.m.control.chat ? c.inbox.splice(0, c.inbox.length) : [];
      return Promise.resolve({ ...result, ...(messages.length > 0 ? { messages, wake: 'owner_message' as const } : {}) });
    }
    if (c.waiters.size >= MAX_LOBBY_WAITERS) throw new PlayerThreeError('busy');
    if (c.approvalUnread) {
      c.approvalUnread = false;
      return Promise.resolve({ ...this.lobbyState(c), wake: 'approval' });
    }
    // Unread owner messages end the wait at once.
    if (this.m.control.chat && c.inbox.length > 0) return Promise.resolve({ ...this.lobbyState(c), messages: c.inbox.splice(0, c.inbox.length), wake: 'owner_message' });
    const { promise, resolve } = Promise.withResolvers<WaitResult>();
    const deadline = Date.now() + req.seconds * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const w: LobbyWaiter = {
      finish: (r) => {
        clearTimeout(timer);
        c.waiters.delete(w);
        c.lastSeen = Date.now();
        resolve(r);
      },
      seated: () => {
        if (!c.waiters.has(w)) return;
        clearTimeout(timer);
        c.waiters.delete(w);
        resolve(seated({ ...req, seconds: Math.max(0, (deadline - Date.now()) / 1000) }));
      },
    };
    c.waiters.add(w);
    timer = setTimeout(() => w.finish(this.lobbyState(c)), req.seconds * 1000);
    return promise;
  }

  private policyLimits() {
    const limits = this.m.control.policy;
    if (!limits) throw new PlayerThreeError('mode_unavailable');
    return limits;
  }

  /**
   * One dry-run call of an artifact against the commander's seat at tick 0 of a fresh game, and the observation detail
   * the artifact declares (once it loads). `source`: the request a fresh deploy came from, so a load failure names its
   * originating part (spec §11).
   */
  private async probe(c: Cmd, artifact: PolicyArtifact, version: number, source?: PolicySource): Promise<{ result: DeployResult; detail: PolicyDetail | null }> {
    const limits = this.policyLimits();
    const seed = randomInt(MAX_SEED);
    const teams = this.host.teams;
    const adapter = this.def.create({ seed, teams, ...(this.host.matchOptions ? { options: structuredClone(this.host.matchOptions) } : {}) });
    if (this.m.matchData && typeof adapter.matchData !== 'function') throw new PlayerThreeError('internal');
    const seat: SeatKey = { team: teams[0] as string, role: c.role };
    adapter.setSeatInfo(seat, { controller: 'agent', mandate: structuredClone(c.stored.mandate) });
    const guard = createGuard({ onDrop: () => {} });
    const matchData = matchDataFor({ manifest: this.m, adapter, guard }, seat);
    const loaded = await loadSeatArtifact(artifact, limits, seed, matchData, this.m, c.role);
    if (!loaded.ok) return { result: { ok: false, error: annotateLoadError(loaded.error, source, this.skills) }, detail: null };
    const detail = loaded.instance.detail ?? null;
    const fail = (error: PolicyError) => ({ result: { ok: false as const, error }, detail });
    const run = new PolicyRun(version, artifact, loaded.instance, limits, seed, matchData, loaded.detail);
    try {
      // A fresh game has an empty signal board.
      const raw = adapter.observe(seat, 0, run.detail);
      const obs = guard.pass('observation', this.m.observation, this.m.signals ? withSignals(raw, emptySeatSignals()) : raw);
      if (!obs.ok) throw new PlayerThreeError('internal');
      const out = await run.think(obs.value);
      if (out.error) return fail(out.error);
      const schema = intentSchema(this.m);
      for (const raw of out.intents) {
        const checked = checkIntent(this.m, schema, c.role, raw);
        if (!checked.ok) return fail({ code: 'bad_output', message: 'Policy emitted an invalid intent.' });
      }
      if (run.snapshot().intentsRejected.length > 0) return fail({ code: 'bad_output', message: 'Policy exceeded its intent budget.' });
      return { result: { ok: true, version, probe: run.snapshot() }, detail };
    } finally {
      run.dispose();
    }
  }

  private async lobbyDeploy(c: Cmd, raw: unknown, agent = false): Promise<DeployResult> {
    const parsed = await parseArtifact(raw, this.policyLimits(), { skills: this.skills, starters: this.starters, role: c.role });
    if (!parsed.ok) return { ok: false, error: parsed.error };
    // An approval keeps the request itself: the approved deploy re-parses it, so the stored version retains its source.
    if (agent && c.stored.mandate.autonomy === 'supervised') return this.requestApproval(c, { kind: 'policyDeploy', artifact: parsed.source });
    return c.deploys.run(async () => {
      // Taken once the earlier deploys of the commander have run, so concurrent deploys number in arrival order.
      const version = c.stored.nextVersion;
      const { result: r, detail } = await this.probe(c, parsed.artifact, version, parsed.source);
      if (!r.ok || !this.current(c)) return r;
      this.addVersion(c, version, {
        ...parsed.artifact, surfaceHash: surfaceHash(this.m), artifactHash: policyArtifactHash(parsed.artifact),
        source: parsed.source, detail, provenance: { ...DEPLOYED },
      }, r.probe);
      return r;
    });
  }

  private async lobbyRollback(c: Cmd, version: number, agent = false): Promise<DeployResult> {
    if (!c.stored.versions.some((v) => v.version === version && v.role === c.role)) throw new PlayerThreeError('invalid');
    if (agent && c.stored.mandate.autonomy === 'supervised') return this.requestApproval(c, { kind: 'policyRollback', version });
    return c.deploys.run(async () => {
      const artifact = await this.artifact(c, version);
      if (artifact.surfaceHash !== surfaceHash(this.m)) return { ok: false, error: { code: 'bad_module', message: 'Saved policy surface does not match this host.' } };
      const { result: r } = await this.probe(c, artifact, version);
      if (r.ok && this.current(c)) this.activate(c, version, r.probe);
      return r;
    });
  }

  private lobbyStatus(c: Cmd): PolicyStatus | null {
    const active = c.stored.activeByRole[c.role] ?? null;
    const approval = c.approval?.approval;
    if (active === null) {
      const ambiguous = c.stored.versions.some((v) => v.role === null);
      return approval || ambiguous ? { version: null, ...(approval ? { approval: { ...approval } } : {}),
        ...(ambiguous ? { activationError: 'needs_role_deploy' as const } : {}) } : null;
    }
    const v = c.stored.versions.find((x) => x.version === active)!;
    const stats = c.lastStats?.version === active ? structuredClone(c.lastStats) : emptyStats(active, v.runtime as PolicyArtifact['runtime']);
    return { ...stats, ...storedStarter(v.from, v.knobs), ...(approval ? { approval: { ...approval } } : {}) };
  }

  private async lobbyPractice(c: Cmd, raw: unknown): Promise<PracticeResult> {
    const req = await parsePracticeRequest(this.m, this.skills, raw, c.role);
    let artifact: PolicyArtifact;
    let version: number;
    if (req.artifact) {
      if (!req.artifact.ok) throw new PlayerThreeError('invalid');
      artifact = req.artifact.artifact;
      version = 0;
    } else if (c.stored.activeByRole[c.role] != null) {
      version = c.stored.activeByRole[c.role]!;
      artifact = await this.artifact(c, version);
    } else {
      throw new PlayerThreeError('invalid');
    }
    const key = commanderKey(c);
    const running = this.host.practices.get(key) ?? 0;
    if (running >= req.concurrent) throw new PlayerThreeError('busy');
    this.host.practices.set(key, running + 1);
    try {
      const seed = req.seed ?? randomInt(LIMITS.maxSeed);
      const allies = req.allies ?? req.opponent;
      const result = await runPractice({
        definition: this.def,
        seat: { team: this.host.teams[0] as string, role: c.role },
        teams: this.host.teams,
        opponent: req.opponent,
        allies,
        ticks: req.ticks,
        seed,
        options: mergeMatchOptions(this.m.matchOptions, this.host.matchOptions, req.options),
        artifact,
        ...(req.artifact?.ok ? { source: req.artifact.source } : {}),
        version,
        mandate: c.stored.mandate,
      });
      if (this.current(c) && result.ok) {
        c.stored.lastPractice = {
          at: Date.now(),
          role: c.role,
          opponent: req.opponent as string,
          allies,
          ticks: result.ticks,
          seed,
          version,
          outcome: result.outcome,
          report: result.report,
        };
        if (version !== 0 && version === c.stored.activeByRole[c.role]) c.lastStats = structuredClone(result.policy);
        this.save(c.owner);
      }
      return result;
    } finally {
      const n = (this.host.practices.get(key) ?? 1) - 1;
      if (n <= 0) this.host.practices.delete(key);
      else this.host.practices.set(key, n);
    }
  }

  private async lobbyPublish(c: Cmd, version: number | null, agent = false): Promise<PublishResult> {
    const pool = this.m.control.pool;
    if (!pool) throw new PlayerThreeError('mode_unavailable');
    if (version === null || !c.stored.versions.some((v) => v.version === version && v.role === c.role)) throw new PlayerThreeError('invalid');
    if (agent && c.stored.mandate.autonomy === 'supervised') return this.requestApproval(c, { kind: 'publish', version });
    const owner = `commander:${c.owner}`;
    if (this.host.pool.countBy(owner) >= pool.maxPublishedPerPrincipal) throw new PlayerThreeError('forbidden');
    const artifact = await this.artifact(c, version);
    return { policyId: this.host.pool.publish(c.role, artifact, owner).id };
  }

  // ------------------------------------------------------------------ library

  /** The commander still belongs to a live roster (not removed meanwhile). */
  private current(c: Cmd): boolean {
    return this.byOwner.get(c.owner)?.cmds.get(c.id)?.stored === c.stored;
  }

  private async artifact(c: Cmd, version: number): Promise<StoredCommanderArtifact> {
    await this.writes.flush();
    const a = await this.store.loadArtifact(c.owner, c.id, version);
    if (!a) throw new PlayerThreeError('internal');
    return a;
  }

  /**
   * Store a new library version of the lane's role and apply retention. With a `probe` (a deploy) it becomes active;
   * without (an import) it stays inactive, and retention then never drops the role's active version for it.
   */
  private addVersion(c: Cmd, version: number, artifact: StoredCommanderArtifact, probe: PolicyStats | null): void {
    const s = c.stored;
    const copy = structuredClone(artifact);
    this.writes.write(() => this.store.saveArtifact(c.owner, c.id, version, copy));
    s.versions = s.versions.filter((v) => v.version !== version);
    s.versions.push({ version, role: c.role, runtime: artifact.runtime, surfaceHash: artifact.surfaceHash, createdAt: Date.now(), bytes: artifactBytes(artifact), artifactHash: policyArtifactHash(artifact),
      ...starterOf(artifact.source) });
    s.versions.sort((a, b) => a.version - b.version);
    const keep = probe === null ? s.activeByRole[c.role] : undefined;
    while (s.versions.filter((v) => v.role === c.role).length > MAX_VERSIONS) {
      const index = s.versions.findIndex((v) => v.role === c.role && v.version !== keep);
      const [old] = s.versions.splice(index, 1);
      this.writes.write(() => this.store.deleteArtifact(c.owner, c.id, old!.version));
    }
    s.nextVersion = Math.max(s.nextVersion, version + 1);
    if (probe) {
      this.activate(c, version, probe);
    } else {
      this.statusChanged(c);
      this.save(c.owner);
    }
  }

  /**
   * A library version as a policy package (spec §13.1), exported now. `license`/`author` default to what an import
   * recorded; the result is validated like an import would, so a bad `license`/`author` is `invalid`.
   */
  private async packageOf(c: Cmd, version: number, opts: PolicyExportOptions): Promise<PolicyPackage> {
    const limits = this.policyLimits();
    const entry = c.stored.versions.find((v) => v.version === version);
    if (!entry || entry.role === null || (opts.role !== undefined && entry.role !== opts.role)) throw new PlayerThreeError('invalid');
    const a = await this.artifact(c, version);
    let source: PolicyPackageSource | null = null;
    if (a.source !== null) {
      const { runtime: _runtime, ...rest } = a.source;
      source = rest as PolicyPackageSource;
    }
    const pkg = createPolicyPackage({
      game: { id: this.m.id, version: this.m.version },
      surfaceHash: a.surfaceHash,
      roles: [entry.role],
      runtime: a.runtime,
      detail: a.detail === null || a.detail === 'all' ? a.detail : [...a.detail],
      source,
      script: a.code,
      scriptHash: policyArtifactHash(a),
      lineage: { parent: a.provenance.parent, version },
      license: opts.license ?? a.provenance.license ?? 'NOASSERTION',
      author: opts.author === undefined ? a.provenance.author : opts.author,
      createdAt: new Date().toISOString(),
    });
    if (!validatePolicyPackage(pkg, limits, this.m)) throw new PlayerThreeError('invalid');
    return pkg;
  }

  /** `policyExport`: page 1 exports afresh (and keeps it); later pages slice the lane's kept export of that version. */
  private async lobbyExport(c: Cmd, raw: unknown): Promise<PolicyExportPage> {
    const req = parseArgs(this.argSchemas.exportRequest, raw ?? {});
    const version = req.version ?? c.stored.activeByRole[c.role] ?? null;
    if (version === null) throw new PlayerThreeError('invalid');
    const page = req.page ?? 1;
    let exported = c.exported;
    if (page === 1 || exported?.version !== version) {
      const pkg = await this.packageOf(c, version, { role: c.role });
      exported = { version, hash: pkg.hash, text: canonicalJson(pkg) };
      c.exported = exported;
    }
    const out = policyExportPage(exported, page);
    if (!out) throw new PlayerThreeError('invalid');
    return out;
  }

  /**
   * Spec §13.1 import into the lane's library: the package checks (`validatePolicyPackage`), the lane's role among its
   * `roles`, then — when it carries `source` and was made against this surface — the rebuild, which must equal
   * `script` byte for byte. Another surface stores it stale (its own surfaceHash), unbuilt. The version stays inactive.
   * Every failure is `invalid` without detail: a build message would echo package content.
   */
  private async importInto(c: Cmd, raw: unknown): Promise<{ result: PolicyImportResult; artifact: StoredCommanderArtifact }> {
    const limits = this.policyLimits();
    const pkg = validatePolicyPackage(raw, limits, this.m);
    if (!pkg || !pkg.roles.includes(c.role)) throw new PlayerThreeError('invalid');
    const source = pkg.source === null ? null : ({ runtime: pkg.runtime, ...pkg.source } as PolicySource);
    const stale = pkg.surfaceHash !== surfaceHash(this.m);
    if (source && !stale) {
      const rebuilt = await parseArtifact(source, limits, { skills: this.skills, starters: this.starters, role: c.role }).catch(() => undefined);
      if (!rebuilt?.ok || rebuilt.artifact.code !== pkg.script) throw new PlayerThreeError('invalid');
    }
    // Queued with lobby deploys: a deploy holds its version number across its probe.
    return c.deploys.run(async () => {
      if (!this.current(c)) throw new PlayerThreeError('invalid');
      const version = c.stored.nextVersion;
      const artifact: StoredCommanderArtifact = {
        runtime: pkg.runtime, code: pkg.script, surfaceHash: pkg.surfaceHash, artifactHash: pkg.scriptHash,
        source, detail: pkg.detail, provenance: { parent: pkg.hash, license: pkg.license, author: pkg.author },
      };
      this.addVersion(c, version, artifact, null);
      return { result: { ok: true, version, stale }, artifact };
    });
  }

  private activate(c: Cmd, version: number, probe: PolicyStats): void {
    if (!c.stored.versions.some((v) => v.version === version && v.role === c.role)) return;
    c.stored.activeByRole[c.role] = version;
    c.lastStats = structuredClone(probe);
    this.statusChanged(c);
    this.save(c.owner);
  }

  // ------------------------------------------------------------------ matches

  /**
   * Prepare one named commander's exact role lane without mutating routing. Every preparation must
   * succeed before the host constructs and binds the match. `within`: a live match re-assigning a seat
   * (`PlayerThreeMatch.assign`) — the commander may already sit there, on the same team only.
   */
  prepareSeat(owner: string, id: string, team: string, role: string, activeVersion?: number, within?: Match<AnyManifest>): { links: Map<string, CommanderLink>; bind(match: Match<AnyManifest>): void } {
    const state = this.ownerState(owner);
    const root = this.cmd(owner, id);
    const commander = this.lane(root, role);
    if (this.liveSeats(root).some((seat) => seat.match !== within || seat.team !== team) || this.liveSeat(commander)) throw new PlayerThreeError('busy');
    const assignedGeneration = commander.activityGeneration;
    const links = new Map<string, CommanderLink>();
    let bound: Match<AnyManifest> | undefined;
    for (const c of [commander]) {
      const s = c.stored;
      const versions = s.versions.filter((v) => v.role === role).map((v) => v.version);
      if (activeVersion !== undefined && !versions.includes(activeVersion)) throw new PlayerThreeError('invalid');
      const link: CommanderLink = {
        settings: { mandate: structuredClone(s.mandate), scopes: [...s.scopes], botLevel: s.botLevel },
        active: activeVersion ?? s.activeByRole[role] ?? null,
        needsRoleDeploy: s.versions.some((v) => v.role === null),
        get nextVersion() { return s.nextVersion; },
        reserveVersion: () => {
          const version = s.nextVersion++;
          this.save(c.owner);
          return version;
        },
        library: async () => {
          const out: { version: number; artifact: StoredCommanderArtifact }[] = [];
          await this.writes.flush();
          for (const version of versions) {
            const artifact = await this.store.loadArtifact(c.owner, c.id, version);
            if (artifact) out.push({ version, artifact });
          }
          return out;
        },
        connected: () => this.current(c) && c.activityGeneration > assignedGeneration && this.connected(c),
        approval: () => c.approval,
        approvalChanged: (pending) => this.approvalChanged(c, pending, false),
        statusChanged: () => {
          if (this.current(c) && c.seat?.match === bound) this.statusChanged(c);
        },
        deployed: (version, artifact, probe) => {
          if (this.current(c)) this.addVersion(c, version, artifact, probe);
        },
        exportPage: (request) => this.lobbyExport(c, request),
        importPackage: (pkg) => this.importInto(c, pkg),
        activated: (version, probe) => {
          if (this.current(c)) this.activate(c, version, probe);
        },
        ended: (outcome) => {
          // Back to the lobby; the reservation that led here is used up.
          if (c.seat?.match === bound) {
            c.endedWait = { phase: 'match', tick: bound!.tick, outcome, events: [] };
            if (outcome !== 'running') {
              c.stored.results[role] = { match: bound!.id, team, role, tick: bound!.tick, outcome, disposition: 'final', at: Date.now() };
              delete c.stored.pendingMatches[role];
              this.save(c.owner);
            }
            c.seat = undefined;
            c.reservation = undefined;
            if (this.current(c)) this.statusChanged(c);
          }
        },
        released: (interrupted = false) => {
          if (c.seat?.match === bound) {
            if (interrupted && bound) c.stored.results[role] = { match: bound.id, team, role, tick: bound.tick, outcome: 'unknown', disposition: 'interrupted', at: Date.now() };
            else c.bindingGeneration++;
            delete c.stored.pendingMatches[role];
            c.reservation = undefined;
            this.save(c.owner);
            c.seat = undefined;
            if (this.current(c)) this.statusChanged(c);
          }
        },
        get ready() { return c.reservation?.team === team && c.reservation.ready; },
        readied: () => {
          if (!this.current(c) || c.reservation?.team !== team || c.reservation.ready) return;
          c.reservation.ready = true;
          this.statusChanged(c);
        },
        takeInbox: () => c.inbox.splice(0, c.inbox.length),
        told: (roles, message) => {
          if (this.current(c)) {
            const commanderIds = [...state.cmds.values()].filter((entry) => this.liveSeats(entry).some((seat) =>
              seat.match === bound && seat.team === team && roles.includes(seat.role))).map((entry) => entry.id);
            this.logChat(state, { at: Date.now(), from: 'owner', commanderIds, tick: message.tick, text: message.text, ...(message.ping !== undefined ? { ping: message.ping } : {}) });
          }
        },
        said: (said) => this.recordSaid(c, said),
      };
      links.set(`${team}/${role}`, link);
      this.links.set(link, { root, owner, name: s.name, kind: s.kind, declared: { ...s.metadata } });
    }
    return {
      links,
      bind: (match) => {
        bound = match;
        for (const c of [commander]) {
          if (!this.current(c)) continue;
          c.seat = { match, team, role };
          c.bindingGeneration++;
          c.stored.pendingMatches[role] = { match: match.id, team, role, at: Date.now() };
          this.save(c.owner);
          c.endedWait = undefined;
          // Waits in the lobby continue in the match: its entry at once, or (held) until the start. Deferred so the
          // game can establish its synchronous start gate (`holdStart`) before any agent call reaches the match.
          const seatedWaiters = [...c.waiters];
          queueMicrotask(() => {
            for (const w of seatedWaiters) w.seated();
          });
          this.statusChanged(c);
        }
      },
    };
  }

  flush(): Promise<void> {
    return Promise.all([this.writes.flush(), this.commanderLog.flush()]).then(() => undefined);
  }

  /**
   * One entry per named commander that held a seat of this match (several lanes of one commander share it), from the
   * host-observed facts. The game's verdict, the chain and the signature are the log's (`CommanderLog.write`).
   */
  logMatch(logged: LoggedMatch, context: { harness(team: string, role: string): string[]; kept: boolean }): void {
    const groups = new Map<Cmd, { info: LinkInfo; seats: { seat: LoggedSeat; fromTick: number; toTick: number; left: boolean }[] }>();
    for (const seat of logged.seats) for (const occupant of seat.occupants) {
      const info = this.links.get(occupant.link);
      if (!info) continue;
      let group = groups.get(info.root);
      if (!group) groups.set(info.root, (group = { info, seats: [] }));
      group.seats.push({ seat, fromTick: occupant.fromTick, toTick: occupant.toTick, left: occupant.left });
    }
    const sides = (team: string): string => Object.entries(logged.alliances ?? {}).find(([, members]) => members.includes(team))?.[0] ?? `team:${team}`;
    const holder = (seat: LoggedSeat): LinkInfo | undefined => {
      const last = seat.occupants.at(-1);
      return last && !last.left ? this.links.get(last.link) : undefined;
    };
    const version = (info: LinkInfo | undefined, role: string, v: number | undefined) =>
      v === undefined ? undefined : info?.root.stored.versions.find((entry) => entry.version === v && entry.role === role);
    for (const [root, { info, seats }] of groups) {
      const team = seats[0]!.seat.team;
      const publicId = commanderPublicId(this.m.id, root.id);
      const own = seats.filter((s) => s.seat.team === team);
      const roles = [...new Set(own.map((s) => s.seat.role))];
      const teamSeats = logged.seats.filter((s) => s.team === team);
      const byRole = <T>(pick: (seat: LoggedSeat) => T): Record<string, T> => Object.fromEntries(roles.map((role) => [role, pick(own.find((s) => s.seat.role === role)!.seat)]));
      const held = (role: string): number => own.filter((s) => s.seat.role === role).reduce((n, s) => n + Math.max(0, s.toTick - s.fromTick), 0);
      const absentShare = (seat: LoggedSeat): number => seat.fallbackTicks + (info.kind === 'agent' ? seat.absentPolicyTicks : 0);
      const outcome = logged.outcomes[team];
      // A commander replaced or revoked before the end did not play it out: its execution stopped without an outcome.
      const decided = (outcome === 'win' || outcome === 'loss' || outcome === 'draw') && own.some((s) => !s.left);
      const forfeit = logged.forfeited.get(team);
      const ownerIntents = teamSeats.reduce((n, s) => n + s.ownerIntents, 0);
      const ownerTells = teamSeats.reduce((n, s) => n + s.ownerTells, 0);
      const usage = own.reduce<CommanderLogUsage | undefined>((sum, { seat }) => {
        const u = seat.usage;
        if (!u) return sum;
        if (!sum) return { ...u };
        const add = (a: number | null, b: number | null) => a === null ? b : b === null ? a : a + b;
        return { decisions: sum.decisions + u.decisions, inputTokens: add(sum.inputTokens, u.inputTokens), outputTokens: add(sum.outputTokens, u.outputTokens),
          cacheReadTokens: add(sum.cacheReadTokens, u.cacheReadTokens), cacheWriteTokens: add(sum.cacheWriteTokens, u.cacheWriteTokens),
          coverage: sum.coverage === 'unknown' || u.coverage === 'unknown' ? 'unknown' : sum.coverage === 'partial' || u.coverage === 'partial' ? 'partial' : 'complete' };
      }, undefined);
      const sealed: CommanderLogSealed = { salt: newSalt(), ownerRef: info.owner, name: info.name, declared: info.declared, ...(usage ? { usage } : {}) };
      const policies = roles.flatMap((role) => {
        const v = version(info, role, own.find((s) => s.seat.role === role)!.seat.policyVersion);
        return v ? [{ role, version: v.version, runtime: v.runtime, surfaceHash: v.surfaceHash, artifactHash: v.artifactHash }] : [];
      });
      const harness = info.kind === 'agent' ? roles.flatMap((role) => context.harness(team, role))[0] : undefined;
      const fallbackShare = Math.max(0, ...roles.map((role) => absentShare(own.find((s) => s.seat.role === role)!.seat) / Math.max(1, held(role))));
      const facts = logged.facts;
      const entry: CommanderLogEntry = {
        format: COMMANDER_LOG_FORMAT, version: COMMANDER_LOG_VERSION, entryId: randomUUID(), seq: 0, prevDigest: null, digest: '',
        game: this.m.id, gameVersion: this.m.version, surfaceHash: surfaceHash(this.m), matchId: logged.id,
        host: { origin: this.commanderLog.origin, keyId: this.commanderLog.keyId, official: this.commanderLog.official },
        commander: publicId, kind: info.kind, sealed: sealedDigest(sealed),
        mode: facts?.mode ?? 'custom', queue: facts?.queue ?? null, rulesHash: facts?.rulesHash ?? null, customRules: facts?.customRules ?? false,
        map: facts?.map ? { id: facts.map.id, identity: facts.map.identity ?? null, seed: facts.map.seed ?? null, size: facts.map.size ?? null, layout: facts.map.layout ?? null } : null,
        seed: logged.seed, selfPlay: logged.selfPlay, team,
        seats: own.map((s) => ({ team, role: s.seat.role, fromTick: s.fromTick, toTick: s.toTick })),
        planesControlled: roles.length, planesTotal: this.roles.length, planeShare: roles.length / this.roles.length,
        lineup: teamSeats.map((s) => {
          const at = holder(s);
          const sameOwner = s.owner === info.owner;
          return { role: s.role, kind: s.kind, sameOwner, ...(sameOwner && at ? { commander: commanderPublicId(this.m.id, at.root.id) } : {}) };
        }),
        opponents: logged.teams.filter((other) => sides(other) !== sides(team)).map((other) => ({
          team: other, rank: logged.ranks?.[other] ?? null,
          seats: logged.seats.filter((s) => s.team === other).map((s): CommanderLogSeatRef => {
            const at = holder(s);
            const v = version(at, s.role, s.policyVersion);
            return {
              role: s.role, kind: s.kind, commander: at ? commanderPublicId(this.m.id, at.root.id) : null,
              ...(s.botLevel !== undefined ? { botLevel: s.botLevel } : {}),
              ...(s.botOptions ? { botOptionsHash: createHash('sha256').update(canonicalJson(s.botOptions)).digest('hex') } : {}),
              ...(s.botPackages ? { botPackages: [...s.botPackages] } : {}),
              ...(s.policyVersion !== undefined && at ? { policyVersion: s.policyVersion } : {}),
              ...(v ? { artifactHash: v.artifactHash } : {}),
            };
          }),
        })),
        control: own.flatMap((s) => s.seat.control.filter((c) => c.toTick > s.fromTick && c.fromTick < s.toTick || c.fromTick === s.fromTick)
          .map((c) => ({ role: s.seat.role, fromTick: Math.max(c.fromTick, s.fromTick), toTick: Math.min(c.toTick, s.toTick), controller: c.controller }))),
        ownerIntents, ownerTells,
        fallbackTicks: byRole((s) => s.fallbackTicks), absentPolicyTicks: byRole((s) => s.absentPolicyTicks),
        pausedMs: byRole((s) => s.pausedMs), acceptedIntents: byRole((s) => s.acceptedIntents),
        assist: teamSeats.some((s) => s.kind === 'human' || s.control.some((c) => c.controller === 'human')) ? 'takeover' : ownerIntents > 0 ? 'owner_intents' : ownerTells > 0 ? 'owner_chat' : 'none',
        fallbackShare,
        policies,
        policySwitches: own.flatMap((s) => s.seat.switches.map((sw) => ({ role: s.seat.role, tick: sw.tick, version: sw.version, artifactHash: version(info, s.seat.role, sw.version)?.artifactHash ?? null }))),
        executionKind: info.kind === 'policy' ? 'policy' : own.some((s) => s.seat.fallbackTicks + s.seat.absentPolicyTicks > 0) ? 'mixed' : 'live',
        harness: harness === undefined ? null : { label: harness, verified: false },
        outcome: decided ? outcome : 'unknown',
        disposition: !decided ? (logged.ticks === 0 ? 'aborted' : 'interrupted') : forfeit ?? 'final',
        rank: logged.ranks?.[team] ?? null,
        terminalReason: forfeit ?? (!decided ? 'released' : logged.declared ? 'declared' : 'game'),
        ticks: logged.ticks, simSeconds: logged.ticks / logged.tickRate, wallMs: Math.max(0, logged.endedAt - logged.startedAt),
        startedAt: logged.startedAt, endedAt: logged.endedAt,
        replayRef: { session: logged.id, digest: logged.replayDigest, kept: context.kept },
        verdict: { rated: false, pool: null, segmentId: null, weight: 0, badges: [], reasons: [] }, sig: null,
      };
      // A commander deleted meanwhile is logged already tombstoned.
      this.commanderLog.write({ commanderId: root.id, ownerRef: info.owner, declared: info.declared, entry, sealed: this.current(root) ? sealed : null });
    }
  }

  dispose(): void {
    for (const state of this.byOwner.values()) {
      for (const c of state.cmds.values()) for (const lane of c.lanes!.values()) for (const w of [...lane.waiters]) w.finish(unseated());
    }
    this.tokens.clear();
    for (const state of this.byOwner.values()) {
      for (const c of state.cmds.values()) this.statusChanged(c);
    }
    this.statusListeners.clear();
    this.saidListeners.clear();
  }
}

/** The lobby state of a lane nothing seats or reserves (also what a revoked or removed lane's waits return). */
function unseated(): LobbyState {
  return { phase: 'lobby', seat: null, you: { ready: false }, startsWhen: { kind: 'seat' }, instruction: LOBBY_INSTRUCTIONS.unseated };
}

function isCount(v: unknown, min: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
}

/** A stored version's starter reference (spec §11 *Starters*), kept only within its bounds; `{}` for anything else. */
function storedStarter(from: unknown, knobs: unknown): Partial<StarterRef> {
  if (typeof from !== 'string' || from.length === 0 || from.length > STARTER_PATH_MAX) return {};
  if (knobs === null || typeof knobs !== 'object' || Array.isArray(knobs)) return { from };
  const json = JSON.stringify(knobs);
  return Buffer.byteLength(json, 'utf8') <= STARTER_KNOBS_MAX_BYTES ? { from, knobs: JSON.parse(json) as Record<string, unknown> } : { from };
}
