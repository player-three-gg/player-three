/**
 * Seat briefing (including owner settings) and the manifest's pinned tool-surface hash.
 */
import { createHash } from 'node:crypto';
import { defaultScopes, type Briefing, type Mandate, type Scope } from './control.ts';
import { defaultMandate } from './host/pipeline.ts';
import { CONTROL_PLANE_VERSION, observationSections, resolveDetail, type AnyManifest, type IntentDef, type SkillDef } from './manifest.ts';
import { toolSurface } from './mcp/surface.ts';
import { POLICY_RUNTIME } from './policy/runtime.ts';
import type { EnumS } from './schema.ts';
import { defaultSkills, referenceSkill } from './skill.ts';
import { topicIndex } from './topics.ts';

/** JSON with recursively sorted keys; `undefined` members dropped. Stable across engines and insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** Every skill: game strategy, generated reference, and mode-aware SDK defaults. */
export function servedSkills(manifest: AnyManifest): SkillDef[] {
  return [...(manifest.skills as readonly SkillDef[]), referenceSkill(manifest), ...defaultSkills(manifest)];
}

const hashes = new WeakMap<object, string>();

/**
 * sha256 (hex) over the canonical JSON of the full agent-facing surface: control-plane version, the manifest
 * (schemas, docs, limits, developer skills), the MCP tool definitions derived from it, all generated skills, and the
 * JS policy runtime (engine build and deterministic `Math` version, which policy results depend on).
 * Players pin it; any change to what an agent can see or call changes the hash.
 */
export function surfaceHash(manifest: AnyManifest): string {
  const cached = hashes.get(manifest);
  if (cached) return cached;
  const skills = servedSkills(manifest);
  const surface = {
    controlPlane: CONTROL_PLANE_VERSION,
    manifest,
    tools: toolSurface(manifest, skills),
    skills,
    policyRuntime: POLICY_RUNTIME,
    // Named commander identity and exact lane isolation are part of the pinned contract.
    sessions: {
      phases: ['lobby', 'match'],
      commanderIdentity: 'named-id',
      liveRouting: 'exclusive-session-team-role-lease',
      sameRoleConnections: 'independent',
      privateChat: 'exact-commander',
      observerDisclosure: 'explicit-opt-in',
      lobbyErrors: { game_observe: 'not_in_match', game_act: 'not_in_match', game_sequence: 'not_in_match' },
      roles: { argument: 'role', requiredAbove: 1, defaultFirst: ['game_briefing', 'game_skill'], notHeld: 'forbidden', missing: 'invalid' },
    },
  };
  const hash = createHash('sha256').update(canonicalJson(surface)).digest('hex');
  hashes.set(manifest, hash);
  return hash;
}

/** A role's default observation scope: sections in full and summarised, in manifest order. */
function observationScope(m: AnyManifest, role: string): { full: string[]; summary: string[] } {
  const full = resolveDetail(m, role, undefined) ?? [];
  return { full, summary: observationSections(m).filter((s) => !full.includes(s)) };
}

/**
 * Core briefing for a seat in a match, or (without `team`) for a commander in the lobby. `sides`: the match's teams
 * and alliances (default: every manifest team, none allied). Topics are served separately (`topicPage`).
 */
export function buildBriefing(manifest: AnyManifest, seat: { team?: string; role: string }, settings: { scopes?: Scope[]; mandate?: Mandate } = {}, sides?: { teams: readonly string[]; alliances?: Readonly<Record<string, readonly string[]>> }): Briefing {
  const m = manifest;
  return {
    controlPlane: CONTROL_PLANE_VERSION,
    phase: seat.team === undefined ? 'lobby' : 'match',
    game: { id: m.id, version: m.version, title: m.title, doc: m.doc, tickRate: m.tickRate },
    seat: seat.team === undefined ? { role: seat.role, roleDoc: m.roleDocs[seat.role] as string } : { team: seat.team, role: seat.role, roleDoc: m.roleDocs[seat.role] as string },
    ...(m.observationScope ? { observationScope: observationScope(m, seat.role) } : {}),
    teams: [...(sides?.teams ?? (m.teams as EnumS).values)],
    ...(sides?.alliances ? { alliances: structuredClone(sides.alliances) as Record<string, string[]> } : {}),
    roles: [...(m.roles as EnumS).values],
    scopes: [...(settings.scopes ?? defaultScopes(m))],
    mandate: structuredClone(settings.mandate ?? defaultMandate(m)),
    intents: Object.entries(m.intents as Record<string, IntentDef>).filter(([, d]) => d.roles.includes(seat.role)).map(([kind]) => kind),
    topics: topicIndex(m),
    skills: servedSkills(m).map((s) => ({ name: s.name, description: s.description })),
    surfaceHash: surfaceHash(m),
  };
}
