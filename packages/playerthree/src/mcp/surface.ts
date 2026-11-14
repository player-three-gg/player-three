/**
 * The MCP tool surface of a game, derived purely from its manifest (and the skills it serves).
 *
 * Everything here is static: names, titles, descriptions and schemas are PlayerThree text or developer-declared
 * manifest data. Nothing depends on match state, seat or request, so the surface can be hashed (`surfaceHash`)
 * and pinned by players. Keep this module free of SDK imports and of imports from briefing.ts / skill.ts
 * (briefing.ts hashes this surface); topics.ts shares the one intent JSON Schema renderer.
 */
import { MCP_TOOL_NAMES, METHOD_MODE, SCOPES, type ControlMethod, type PolicyErrorCode } from '../control.ts';
import { EXPECTED_MAX } from '../dts.ts';
import {
  GAME_ID,
  MAX_POLICY_INCLUDES,
  POLICY_EXPORT_PAGE,
  POLICY_MAX_MODULES,
  POLICY_MODULE_PATH_MAX,
  POLICY_MODULE_PATH_PATTERN,
  POLICY_MODULES_MAX_BYTES,
  POLICY_PACKAGE_FORMAT,
  POLICY_PACKAGE_MAX_BYTES,
  SKILL_PAGE_MAX,
  SKILL_PATH_PATTERN,
  STARTER_KNOBS_MAX_BYTES,
  STARTER_MAX_KNOBS,
  TOPIC_TEXT_MAX,
  observationSections,
  type AnyManifest,
  type IntentDef,
  type SkillDef,
} from '../manifest.ts';
import { toJsonSchema, type EnumS, type Fields, type JsonSchema, type ObjS, type Schema, type SchemaErrorCode } from '../schema.ts';
import { SIGNAL_CODES, SIGNALS_FIELD } from '../signals.ts';
import { intentJsonSchema } from '../topics.ts';

export interface ToolAnnotationsSpec {
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: false;
}

export interface ToolSpec {
  readonly name: string;
  readonly method: ControlMethod | 'usage';
  readonly title: string;
  /** Static PlayerThree text plus developer-declared numbers/identifiers from the manifest. */
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly annotations: ToolAnnotationsSpec;
}

/** Deterministic tool order. */
export const TOOL_ORDER: readonly ControlMethod[] = [
  'briefing',
  'observe',
  'act',
  'sequence',
  'wait',
  'ready',
  'skill',
  'policyDeploy',
  'policyStatus',
  'policyRollback',
  'policyExport',
  'policyImport',
  'practice',
  'publish',
  'say',
];

/** Limits shared with the host's own argument validation. */
export const LIMITS = {
  maxIntentsPerCall: 64,
  maxWaitSeconds: 60,
  maxUntilKinds: 16,
  maxTick: 2 ** 31 - 1,
  maxVersion: 2 ** 31 - 1,
  maxSeed: 2 ** 31 - 1,
  /** Topic and observation page numbers. */
  maxPage: 10_000,
  maxTopicChars: 128,
  /** game_skill offsets (UTF-16 code units). */
  maxOffset: 2 ** 31 - 1,
} as const;

/*
 * Tool-surface budget (spec §4 *Tool-surface budget*). Every model turn carries the whole tool list, so the surface is
 * the always-on part of progressive disclosure: details belong in topics and skills, fetched on demand. Sizes are UTF-16
 * code units of compact JSON (`JSON.stringify(...).length`; a description: its own length). Set from the reference
 * game with modest headroom so it passes and a regression (an inlined schema, a paragraph-long description) fails.
 */
/** Longest tool description. */
export const TOOL_DESCRIPTION_MAX = 1_500;
/** Largest tool inputSchema. */
export const TOOL_INPUT_SCHEMA_MAX = 48_000;
/** Largest tool outputSchema (structured results; clients may show it to models too). */
export const TOOL_OUTPUT_SCHEMA_MAX = 70_000;
/** Model-facing total: the sum over tools of name + description + inputSchema. */
export const TOOL_SURFACE_MAX = 120_000;

/** Throws naming the tool, the measure, its size and the limit when a surface exceeds the budget (toolSurface runs it). */
export function checkSurfaceBudget(tools: readonly ToolSpec[]): void {
  let total = 0;
  for (const tool of tools) {
    const input = JSON.stringify(tool.inputSchema).length;
    const measures: [string, number, number][] = [
      ['description', tool.description.length, TOOL_DESCRIPTION_MAX],
      ['inputSchema', input, TOOL_INPUT_SCHEMA_MAX],
      ['outputSchema', JSON.stringify(tool.outputSchema).length, TOOL_OUTPUT_SCHEMA_MAX],
    ];
    for (const [measure, size, limit] of measures) {
      if (size > limit) throw new Error(`playerthree/surface: ${tool.name} ${measure} is ${size} code units, over the limit of ${limit}`);
    }
    total += tool.name.length + tool.description.length + input;
  }
  if (total > TOOL_SURFACE_MAX) {
    throw new Error(`playerthree/surface: all tools' name + description + inputSchema is ${total} code units, over the limit of ${TOOL_SURFACE_MAX}`);
  }
}

const SCHEMA_ERROR_CODES = [
  'type',
  'enum',
  'range',
  'not_integer',
  'pattern',
  'too_long',
  'unknown_field',
  'missing_field',
  'tag',
] as const satisfies readonly SchemaErrorCode[];

export const POLICY_ERROR_CODES = [
  'runtime_not_allowed',
  'too_large',
  'compile',
  'missing_export',
  'bad_module',
  'imports_not_allowed',
  'memory_limit',
  'timeout',
  'threw',
  'bad_output',
] as const satisfies readonly PolicyErrorCode[];

// Exhaustiveness: adding a code to the contract without listing it here is a type error.
type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : Exclude<All, Listed>;
const _schemaCodesExhaustive: Missing<SchemaErrorCode, (typeof SCHEMA_ERROR_CODES)[number]> = true;
const _policyCodesExhaustive: Missing<PolicyErrorCode, (typeof POLICY_ERROR_CODES)[number]> = true;
void _schemaCodesExhaustive;
void _policyCodesExhaustive;

/** Whether the manifest enables the mode that gates a control method. */
export function methodEnabled(manifest: AnyManifest, method: ControlMethod): boolean {
  const mode = METHOD_MODE[method];
  return mode === 'intents' || manifest.control[mode] !== undefined;
}

/** Literal values of the manifest's event `kind` field. */
export function eventKinds(manifest: AnyManifest): readonly string[] {
  const kind = (manifest.event as ObjS).fields['kind'];
  if (kind === undefined || kind.t !== 'enum') throw new Error('playerthree/mcp: manifest.event must have a `kind: enum` field');
  return (kind as EnumS).values;
}

const HEX64 = '^[0-9a-f]{64}$';
const REJECT_CODE = '^(game:|signal:)?[A-Za-z][A-Za-z0-9_.<>]{0,47}$';
const FIELD = '^([A-Za-z_][A-Za-z0-9_]{0,47}|\\?)$';

const obj = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties), extra: JsonSchema = {}): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...extra,
});
const int = (minimum: number, maximum?: number): JsonSchema => (maximum === undefined ? { type: 'integer', minimum } : { type: 'integer', minimum, maximum });
const str = (extra: JsonSchema = {}): JsonSchema => ({ type: 'string', ...extra });
const strEnum = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values] });
const OUTCOME = strEnum(['win', 'loss', 'draw', 'running']);
/** Members of an `invalid` ack, also a policy's `lastInvalid` (spec §4). */
const INVALID_INTENT: Record<string, JsonSchema> = {
  schemaCode: strEnum(SCHEMA_ERROR_CODES),
  path: { type: 'array', items: { anyOf: [str({ pattern: FIELD }), int(0)] } },
  expected: str({ maxLength: EXPECTED_MAX }),
};
const PHASE = strEnum(['lobby', 'match']);

const MATCH_RECEIPT = obj({
  match: str(), team: str(), role: str(), tick: { anyOf: [int(0), { type: 'null' }] }, at: int(0),
  outcome: strEnum(['win', 'loss', 'draw', 'unknown']), disposition: strEnum(['final', 'interrupted']),
});

/** The lobby state (phase `lobby`): what wait, observe and ready return before the match starts. */
function lobbyFields(manifest: AnyManifest): Record<string, JsonSchema> {
  return {
    phase: { type: 'string', const: 'lobby' },
    seat: { oneOf: [obj({ team: strEnum((manifest.teams as EnumS).values), role: strEnum((manifest.roles as EnumS).values) }), { type: 'null' }] },
    ...(manifest.lobby ? { match: toJsonSchema(manifest.lobby) } : {}),
    you: obj({ ready: { type: 'boolean' } }),
    startsWhen: obj({ kind: strEnum(['seat', 'host', 'ready', 'countdown']), inSeconds: int(0) }, ['kind']),
    instruction: str(),
    previousMatch: MATCH_RECEIPT,
  };
}
const LOBBY_REQUIRED = ['phase', 'seat', 'you', 'startsWhen', 'instruction'];

function policyErrorSchema(): JsonSchema {
  return obj({ code: strEnum(POLICY_ERROR_CODES), message: str() }, ['code']);
}

function approvalSchema(status = false): JsonSchema {
  return obj({
    id: str(),
    kind: strEnum(['policyDeploy', 'policyRollback', 'publish']),
    version: int(1),
    ...(status ? { status: strEnum(['pending', 'approved', 'rejected', 'failed']) } : {}),
  });
}

function approvalResultSchema(): JsonSchema {
  return obj({ ok: { type: 'boolean', const: false }, approval: approvalSchema() });
}

function policyStatusSchema(manifest: AnyManifest): JsonSchema {
  const stats = policyStatsSchema(manifest);
  const extra = { approval: approvalSchema(true), activationError: strEnum(['stale_policy', 'policy_failed', 'needs_role_deploy']) };
  // The active version's starter reference, when it was deployed from one (spec §11 *Starters*).
  const starter = { from: str({ minLength: 1 }), knobs: { type: 'object', additionalProperties: {} } };
  return {
    anyOf: [
      { ...stats, properties: { ...(stats.properties as Record<string, JsonSchema>), ...extra, ...starter } },
      obj({ version: { type: 'null' }, ...extra }, ['version']),
      { type: 'null' },
    ],
  };
}

function policyStatsSchema(manifest: AnyManifest): JsonSchema {
  const runtimes = manifest.control.policy?.runtimes ?? [];
  return obj(
    {
      // 0: an inline practice artifact that was never deployed.
      version: int(0),
      runtime: strEnum(runtimes),
      calls: int(0),
      successfulCalls: int(0),
      consecutiveFailures: int(0),
      timeouts: int(0),
      errors: int(0),
      meanMs: { type: 'number', minimum: 0 },
      maxMs: { type: 'number', minimum: 0 },
      intentsEmitted: int(0),
      // Ack codes, `too_many`, or `game:<game error code>`.
      intentsRejected: { type: 'array', items: obj({ code: str({ pattern: REJECT_CODE }), count: int(0) }) },
      lastInvalid: obj(INVALID_INTENT),
      lastError: policyErrorSchema(),
      logs: { type: 'array', items: str() },
    },
    ['version', 'runtime', 'calls', 'successfulCalls', 'consecutiveFailures', 'timeouts', 'errors', 'meanMs', 'maxMs', 'intentsEmitted', 'intentsRejected', 'logs'],
  );
}

function deployResultSchema(manifest: AnyManifest): JsonSchema {
  // Object root: MCP clients treat a non-object outputSchema root as `{ result: … }`-wrapped.
  return {
    type: 'object',
    oneOf: [
      obj({ ok: { type: 'boolean', const: true }, version: int(1), probe: policyStatsSchema(manifest) }),
      obj({ ok: { type: 'boolean', const: false }, error: policyErrorSchema() }),
      approvalResultSchema(),
    ],
  };
}

function intentAckSchema(manifest: AnyManifest): JsonSchema {
  const gameErrors = (manifest.errors as EnumS).values;
  return {
    oneOf: [
      obj({ ok: { type: 'boolean', const: true } }),
      obj({ ok: { type: 'boolean', const: false }, code: { type: 'string', const: 'invalid' }, ...INVALID_INTENT }),
      obj({ ok: { type: 'boolean', const: false }, code: strEnum(['forbidden_role', 'rate_limited', 'not_controller', 'game_over', 'out_of_scope']) }),
      obj({ ok: { type: 'boolean', const: false }, code: { type: 'string', const: 'game' }, gameCode: strEnum(gameErrors) }),
      ...(manifest.signals ? [obj({ ok: { type: 'boolean', const: false }, code: { type: 'string', const: 'signal' }, signalCode: strEnum(SIGNAL_CODES) })] : []),
    ],
  };
}

function intentVariants(manifest: AnyManifest): JsonSchema[] {
  return Object.entries(manifest.intents as Record<string, IntentDef>).map(([kind, def]) => intentJsonSchema(kind, def));
}

function briefingSchema(manifest: AnyManifest): JsonSchema {
  const strList: JsonSchema = { type: 'array', items: str() };
  const core = obj({
    controlPlane: int(1),
    phase: PHASE,
    game: obj({ id: str(), version: str(), title: str(), doc: str(), tickRate: { type: 'number', exclusiveMinimum: 0 } }),
    seat: obj({ team: str(), role: str(), roleDoc: str() }, ['role', 'roleDoc']),
    ...(observationSections(manifest).length > 0 ? { observationScope: obj({ full: { type: 'array', items: strEnum(observationSections(manifest)) }, summary: { type: 'array', items: strEnum(observationSections(manifest)) } }, ['full', 'summary']) } : {}),
    teams: strList,
    roles: strList,
    scopes: { type: 'array', items: strEnum(SCOPES) },
    mandate: obj({
      autonomy: strEnum(['autonomous', 'supervised']),
      directive: toJsonSchema(manifest.directive),
      limits: toJsonSchema(manifest.limits ?? { t: 'obj', fields: {} }),
      whenAbsent: strEnum(manifest.control.pausable ? ['policy', 'bot', 'hold', 'pause'] : ['policy', 'bot', 'hold']),
    }, ['autonomy', 'directive', 'whenAbsent']),
    intents: { type: 'array', items: strEnum(Object.keys(manifest.intents)) },
    topics: strList,
    skills: { type: 'array', items: obj({ name: str(), description: str() }) },
    surfaceHash: str({ pattern: '^[0-9a-f]{64}$' }),
    // Every role the credential commands (seat/commander tokens: one; sign-in connections: those the owner granted).
    commands: {
      type: 'array',
      items: obj({ role: strEnum((manifest.roles as EnumS).values), phase: PHASE, team: strEnum((manifest.teams as EnumS).values) }, ['role', 'phase']),
    },
  });
  // Present only in a match that declares alliances: alliance id → member teams.
  (core['properties'] as Record<string, JsonSchema>)['alliances'] = { type: 'object', additionalProperties: { type: 'array', items: strEnum((manifest.teams as EnumS).values), minItems: 1 } };
  const page = obj({
    topic: str(),
    page: int(1),
    pages: int(1),
    text: str({ maxLength: TOPIC_TEXT_MAX }),
    next: obj({ topic: str(), page: int(2) }),
  }, ['topic', 'page', 'pages', 'text']);
  return { type: 'object', oneOf: [core, page] };
}

/**
 * A paged or `fields`-filtered observation is partial: top-level keys (and keys of plain nested objects reached through
 * object properties, which the pager may split) become optional. List items and union variants stay whole.
 */
function partialSchema(js: JsonSchema): JsonSchema {
  if (js.type !== 'object' || !js.properties || js.oneOf) return js;
  const properties = Object.fromEntries(Object.entries(js.properties as Record<string, JsonSchema>).map(([k, v]) => [k, partialSchema(v)]));
  return { ...js, properties, required: [] };
}

/** `role`: which of the credential's roles a call is for (optional; required while it commands more than one). */
function withRole(manifest: AnyManifest, input: JsonSchema): JsonSchema {
  const role: JsonSchema = {
    type: 'string',
    enum: [...(manifest.roles as EnumS).values],
    description: 'Choose a role from the current game_briefing.commands (this enum is the game vocabulary, not your authority). Required for seat calls, including game_ready and game_wait, when commands lists several roles; optional for a single role. game_briefing without role discovers commands and defaults to the first role.',
  };
  return { ...input, properties: { ...(input['properties'] as Record<string, JsonSchema>), role } };
}

const READ: ToolAnnotationsSpec = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotationsSpec = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/**
 * The tool surface for a game. `skills` must be every skill the server serves
 * (developer skills, generated reference and SDK defaults) — game_skill's `name` enum comes from it.
 * Throws when the surface exceeds the tool-surface budget, so no host, hash or MCP mount exists for such a game.
 */
export function toolSurface(manifest: AnyManifest, skills: readonly SkillDef[]): ToolSpec[] {
  const m = manifest;
  const opponents = (m.opponents as EnumS).values;
  const burst = Math.min(m.control.intents.burst, LIMITS.maxIntentsPerCall);
  const kinds = eventKinds(m);
  const policy = m.control.policy;
  const practice = m.control.practice;
  const chat = m.control.chat;
  const sequence = m.control.sequence;
  // Owner messages ride next to (never inside) the closed-vocabulary game data.
  const messagesSchema = (): Record<string, JsonSchema> =>
    chat
      ? {
          messages: {
            type: 'array',
            description: 'Unread messages from your own owner (the player you work for). Owner-authored text; no other player can send these.',
            items: obj(
              {
                from: { type: 'string', const: 'owner' },
                tick: int(0),
                text: str({ minLength: 1, maxLength: chat.maxTellChars }),
                ...(chat.ping ? { ping: toJsonSchema(chat.ping) } : {}),
              },
              ['from', 'tick', 'text'],
            ),
          },
        }
      : {};
  const chatNote = chat ? ' `messages` carries unread messages from your owner (then marked read).' : '';

  // Exactly one body (`code`, `modules`+`entry`, each with `runtime`, or `from`) is the host's rule, not this schema's:
  // the host names the missing or extra member with `expected` (spec §11 *Artifact shape*), a schema path alone would not.
  const artifactSchema = (): JsonSchema => {
    if (!policy) throw new Error('unreachable');
    // `code` is JS source or base64 of a WASM module; base64 inflates by 4/3.
    const maxLength = policy.runtimes.includes('wasm') ? Math.ceil(policy.maxArtifactBytes / 3) * 4 : policy.maxArtifactBytes;
    const props: Record<string, JsonSchema> = { runtime: strEnum(policy.runtimes), code: str({ minLength: 1, maxLength }) };
    if (!policy.runtimes.includes('js')) return obj(props, []);
    props['include'] = {
      type: 'array', maxItems: MAX_POLICY_INCLUDES, uniqueItems: true,
      items: str({ minLength: 3, maxLength: 265, pattern: '^[a-z0-9]+(-[a-z0-9]+)*/.+\\.js$' }),
      description: 'js only: served skill `.js` files ("<skill>/<path>") prepended to `code` or the bundle (joined by newlines, then a newline). The composed source is what is size-checked, stored and versioned.',
    };
    const modulePath = str({ minLength: 4, maxLength: POLICY_MODULE_PATH_MAX, pattern: POLICY_MODULE_PATH_PATTERN });
    props['modules'] = {
      type: 'object', minProperties: 1, maxProperties: POLICY_MAX_MODULES,
      propertyNames: modulePath,
      additionalProperties: str({ maxLength: POLICY_MODULES_MAX_BYTES }),
      description: `js only, instead of \`code\`: ES module source by path (.js, .mjs, .ts or .mts; first segment not a skill name), at most ${POLICY_MAX_MODULES} modules and ${POLICY_MODULES_MAX_BYTES} UTF-8 bytes in total. The host bundles them from \`entry\` into one classic script (static relative imports only; served skill .js files import at "<skill>/<path>"); TypeScript types are stripped unchecked. The entry must export think and may export init and detail.`,
    };
    props['entry'] = { ...modulePath, description: 'With `modules`: the entry module path (one of its keys).' };
    const starters = Object.keys(m.starters ?? {});
    if (starters.length === 0) return obj(props, []);
    props['from'] = {
      ...strEnum(starters),
      description: 'Instead of `code`/`modules`: deploy one of the game\'s starters by reference (topic `starters`: what each plays, its roles and knobs). The host builds `createPolicy(knobs)` from that served file; no `include`, `code` or `modules` with it.',
    };
    props['knobs'] = {
      type: 'object', maxProperties: STARTER_MAX_KNOBS,
      propertyNames: str({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' }),
      additionalProperties: {},
      description: `With \`from\`: the starter's knobs (topic \`starters\`), every one optional; at most ${STARTER_KNOBS_MAX_BYTES} bytes of JSON. A value the starter's schema rejects is invalid with schemaCode, path and expected.`,
    };
    return obj(props, []);
  };
  /** Leads with the one-call deploy (a starter by reference, else a minimal script), then own code, then the rules. */
  const deployDescription = (): string => {
    if (!policy) throw new Error('unreachable');
    const js = policy.runtimes.includes('js');
    const starter = Object.keys(m.starters ?? {})[0];
    const example = starter !== undefined
      ? `Fastest: a starter by reference, e.g. ${JSON.stringify({ from: starter })}, optionally with \`knobs\` (topic \`starters\`). `
      : `Smallest: ${js ? JSON.stringify({ runtime: 'js', code: 'function think(obs){return []}' }) : '{"runtime":"wasm","code":"<base64 module>"}'}. `;
    const own = js
      ? 'Own code: `code` (a classic script defining think(obs)), or `modules`+`entry` (ES/TypeScript the host bundles; a build error is invalid with message and location); `include` prepends served skill .js files. Never paste served files: reference them (`from`, `include`, "<skill>/<path>" imports). '
      : '`code`: base64 of a core WebAssembly module. ';
    return `Deploy a policy for your role (policy scope); it plays at ${policy.hz} Hz while you think. ${example}${own}A malformed artifact is invalid with schemaCode, path and expected. Limits: ${policy.runtimes.join(', ')}; ${policy.maxArtifactBytes} bytes (composed source), ${policy.msPerCall} ms and ${policy.maxIntentsPerCall} intents per call; ABI: topic \`modes\`. Autonomous: probes one call, returns the new version with stats or an error about your code. Supervised: returns an approval request; the owner approves. Versions persist in your library (lobby deploys too); your mandate's whenAbsent decides whether the policy plays while you are away.`;
  };
  const observation = toJsonSchema(m.observation);
  const observationKeys = observation.type === 'object' && observation.properties ? Object.keys(observation.properties as Record<string, JsonSchema>) : [];
  const sections = observationSections(m);
  const detailNote = sections.length > 0
    ? ` Observation scope: your role's sections (briefing \`observationScope.full\`) come in full, the others (${sections.join(', ')}) as compact summaries; pass \`detail\` = a list of sections to add them in full, or "all".`
    : '';
  /**
   * policy_import's `package`: the spec §13.1 members, closed. Unions (`detail`, `source`, nullable members) are left to
   * the host's validator, which also checks every bound, hash and pattern this schema does not express.
   */
  const packageSchema = (): JsonSchema => {
    if (!policy) throw new Error('unreachable');
    const roles = (m.roles as EnumS).values;
    const hex = str({ pattern: HEX64 });
    const count = int(0, LIMITS.maxVersion);
    return obj({
      format: { type: 'string', const: POLICY_PACKAGE_FORMAT },
      game: obj({ id: str({ minLength: 1, maxLength: 48, pattern: GAME_ID.source }), version: str({ minLength: 1, maxLength: 64 }) }),
      surfaceHash: hex,
      roles: { type: 'array', minItems: 1, maxItems: roles.length, uniqueItems: true, items: strEnum(roles) },
      runtime: strEnum(['js', 'wasm']),
      detail: { oneOf: [{ type: 'string', const: 'all' }, { type: 'array', maxItems: sections.length, uniqueItems: true, items: strEnum(sections) }, { type: 'null' }] },
      source: {
        oneOf: [{ type: 'object' }, { type: 'null' }],
        description: 'The artifact as deployed, without runtime: {code, include?}, (js) {modules, entry, include?} or (js) a starter reference {from, knobs?}; null when not retained.',
      },
      script: str({ minLength: 1, maxLength: policy.runtimes.includes('wasm') ? Math.ceil(policy.maxArtifactBytes / 3) * 4 : policy.maxArtifactBytes }),
      scriptHash: hex,
      lineage: obj({ parent: { oneOf: [hex, { type: 'null' }] }, version: int(1, LIMITS.maxVersion) }),
      license: str({ minLength: 1, maxLength: 256 }),
      author: { oneOf: [str({ minLength: 1, maxLength: 64 }), { type: 'null' }] },
      createdAt: str({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
      record: obj({ wins: count, losses: count, draws: count }),
      hash: hex,
    }, ['format', 'game', 'surfaceHash', 'roles', 'runtime', 'detail', 'source', 'script', 'scriptHash', 'lineage', 'license', 'author', 'createdAt', 'hash']);
  };

  const specs: Record<ControlMethod, () => Omit<ToolSpec, 'name' | 'method'>> = {
    briefing: () => ({
      title: 'Game briefing',
      description:
        `Read this first. Without \`topic\`: the core briefing — \`phase\` (\`match\` while your match runs; \`lobby\` before it starts or between matches), the rules (game.doc), your seat and role doc, scopes, mandate, the intent kinds your role may send, the one-line \`topics\` index, skills, pinned surfaceHash, and \`commands\`: every role you currently command. Without \`role\`, defaults to the first role so you can discover \`commands\`; then read each commanded role's briefing with \`{role}\`. Before the start, call game_ready \`{role}\` separately for each prepared, seated role, then game_wait \`{seconds:60,role}\` for every commanded role. In a match, \`teams\` lists the sides taking part and \`alliances\` (when present) which of them are allied: allies share their outcome. With \`topic\` (a name from the index, e.g. \`intent/move\`, \`observation\`, \`modes\`, \`match-data\`, \`schema/observation\`): that topic's text, at most ${TOPIC_TEXT_MAX} characters per page; \`page\` (default 1) and \`next\` page through long ones. ${policy ? `With policy scope, deploy a policy for each commanded role first${m.starters ? ' (a starter is one call: policy_deploy {from})' : ''}. ` : ''}Your role doc may name one topic to read first; fetch the rest just in time. Follow your seat’s mandate: autonomous means decide and act without asking; supervised means propose deploys for your owner to approve.`,
      inputSchema: {
        ...obj({ topic: str({ minLength: 1, maxLength: LIMITS.maxTopicChars }), page: int(1, LIMITS.maxPage) }, []),
        dependentRequired: { page: ['topic'] },
      },
      outputSchema: briefingSchema(m),
      annotations: READ,
    }),
    observe: () => ({
      title: 'Observe',
      description:
        `Your seat’s current fogged observation (bounded closed-shape data; fields: briefing topic \`observation\`). Pass \`since\` = the last tick you already saw to receive only newer events${observationKeys.length > 0 ? ', and `fields` to receive only those top-level keys' : ''}.${detailNote} A result that would exceed the tool result budget is paged: page 1 of a snapshot comes with \`page\`, \`pages\`, \`tick\` and \`next\`; call again with \`page\` for later pages of that same snapshot (\`items\` gives the range of a split list). Before the match starts: the lobby state (phase \`lobby\`, as game_wait returns it) instead.${chatNote}`,
      inputSchema: obj({
        since: int(0, LIMITS.maxTick),
        ...(sections.length > 0 ? {
          detail: {
            oneOf: [
              { type: 'array', minItems: 1, maxItems: sections.length, uniqueItems: true, items: strEnum(sections) },
              { type: 'string', const: 'all' },
            ],
            description: 'Observation sections to receive in full besides your role\'s defaults, or "all".',
          },
        } : {}),
        ...(observationKeys.length > 0 ? { fields: { type: 'array', minItems: 1, maxItems: observationKeys.length, uniqueItems: true, items: strEnum(observationKeys) } } : {}),
        page: int(1, LIMITS.maxPage),
      }, []),
      outputSchema: {
        type: 'object',
        oneOf: [
          obj({
            observation: partialSchema(observation),
            ...messagesSchema(),
            page: int(1),
            pages: int(2),
            tick: int(0),
            next: obj({ page: int(2) }),
            items: { type: 'object', additionalProperties: obj({ from: int(0), to: int(1), of: int(1) }) },
          }, ['observation']),
          obj({ ...lobbyFields(m), ...messagesSchema() }, LOBBY_REQUIRED),
        ],
      },
      annotations: READ,
    }),
    act: () => ({
      title: 'Act',
      description: `Issue 1–${burst} intents now (rate limit: ${m.control.intents.perSecond}/s, burst ${m.control.intents.burst}). Requires act scope. Returns one ack per intent, in order: ok, or a closed error code (invalid + schema path, forbidden_role, rate_limited, not_controller, game_over, out_of_scope, game + game error code${m.signals ? ', signal + signal code' : ''}).${m.signals ? ' Team signals are the `signal` / `signal_update` intents (briefing topic `signals`).' : ''} Before the match starts: error \`not_in_match\` (no seat yet) or \`paused\` (seated, not started).`,
      inputSchema: obj({ intents: { type: 'array', minItems: 1, maxItems: burst, items: { oneOf: intentVariants(m) } } }),
      outputSchema: obj({ acks: { type: 'array', items: intentAckSchema(m) } }),
      annotations: WRITE,
    }),
    sequence: () => ({
      title: 'Schedule sequence',
      description: `Schedule a tick-relative plan (act scope): at most ${sequence?.maxSteps} steps, ${sequence?.maxTicksAhead} ticks ahead, at least ${sequence?.minSpacingTicks} ticks apart. Validated as a whole before scheduling; one plan per seat, a new plan replaces it. Empty steps cancels. Optional cancelOn cancels on the first visible event of those kinds. Before the match starts: error \`not_in_match\` (no seat yet) or \`paused\` (seated, not started).`,
      inputSchema: obj({
        steps: {
          type: 'array', maxItems: sequence?.maxSteps,
          items: obj({
            in: int(0, sequence?.maxTicksAhead),
            intents: { type: 'array', minItems: 1, maxItems: burst, items: { oneOf: intentVariants(m) } },
          }),
        },
        cancelOn: { type: 'array', items: strEnum(kinds), maxItems: LIMITS.maxUntilKinds },
      }, ['steps']),
      outputSchema: {
        type: 'object',
        oneOf: [
          obj({ ok: { type: 'boolean', const: true }, id: str(), acks: { type: 'array', items: { type: 'array', items: intentAckSchema(m) } } }),
          obj({ ok: { type: 'boolean', const: false }, code: strEnum(['invalid', 'out_of_scope', 'not_controller', 'game_over']), acks: { type: 'array', items: { type: 'array', items: intentAckSchema(m) } } }),
        ],
      },
      annotations: WRITE,
    }),
    wait: () => ({
      title: 'Wait',
      description: `Wait for one role, not all commanded roles: pass \`{seconds,role}\` using game_briefing.commands; \`role\` is optional only with a single commanded role. Monitor each commanded role separately. Block for up to \`seconds\` of game time (max ${LIMITS.maxWaitSeconds}), returning early when an event of one of the \`until\` kinds happens or a supervised proposal is resolved (\`wake: approval\`). In a running match returns phase \`match\`, the current tick, outcome and events: the cheap way to monitor it. Before the match starts (phase \`lobby\`) it waits in wall-clock time and returns the lobby state (\`seat\`, \`match\` summary, \`you.ready\`, \`startsWhen\`, \`instruction\`) — at once when a lobby seats you or your seat changes — and, the moment your match starts (or your owner hands you a seat mid-match), phase \`match\` with your first \`observation\` and an \`instruction\`. Waiting does not mark a seat ready. Ready each prepared, seated role with game_ready \`{role}\` first. \`you.ready: true\` in the lobby means this seat is ready while others or the host may be pending; keep waiting after a timeout.${m.control.pausable ? ' While the session is paused (a seat whose mandate says whenAbsent pause has no active agent) game time stands still, so the wait ends after `seconds` of wall-clock time.' : ''}${chat ? ' Also returns early when your owner sends a message (`wake: owner_message`).' : ''}${m.signals ? ' Also returns early when a teammate\'s signal reaches you or one you sent changes state (`wake: signal`, with your `signals` slice).' : ''}${chatNote}`,
      inputSchema: obj(
        {
          seconds: { type: 'number', minimum: 0, maximum: LIMITS.maxWaitSeconds },
          until: { type: 'array', items: strEnum(kinds), maxItems: LIMITS.maxUntilKinds },
        },
        ['seconds'],
      ),
      outputSchema: {
        type: 'object',
        oneOf: [
          obj(
            {
              phase: { type: 'string', const: 'match' },
              tick: int(0),
              outcome: OUTCOME,
              previousMatch: MATCH_RECEIPT,
              events: { type: 'array', items: toJsonSchema(m.event) },
              observation: partialSchema(observation),
              page: int(1),
              pages: int(2),
              next: obj({ page: int(2) }),
              items: { type: 'object', additionalProperties: obj({ from: int(0), to: int(1), of: int(1) }) },
              instruction: str(),
              ...messagesSchema(),
              ...(m.signals ? { signals: toJsonSchema(((m.observation as ObjS).fields as Fields)[SIGNALS_FIELD] as Schema) } : {}),
              wake: strEnum([...(chat ? ['owner_message'] : []), 'approval', ...(m.signals ? ['signal'] : [])]),
            },
            ['phase', 'tick', 'outcome', 'events'],
          ),
          obj({ ...lobbyFields(m), ...messagesSchema(), wake: strEnum(chat ? ['owner_message', 'approval'] : ['approval']) }, LOBBY_REQUIRED),
        ],
      },
      annotations: READ,
    }),
    ready: () => ({
      title: 'Ready',
      description: 'Before the match starts (phase `lobby`, seated): mark one seat ready after preparing for its role and mandate. Call game_ready {role} separately for each prepared, seated role in game_briefing.commands; role is optional only with a single commanded role. This never readies other roles or participants. Returns this seat’s lobby state: you.ready true with phase lobby is success, but others or the host may still be pending (see startsWhen). Then keep game_wait {seconds:60,role} running for every commanded role until phase is `match`. Without a seat it changes nothing; once the match runs it is a no-op returning phase `match`.',
      inputSchema: obj({}),
      outputSchema: {
        type: 'object',
        oneOf: [
          obj(lobbyFields(m), LOBBY_REQUIRED),
          obj({ phase: { type: 'string', const: 'match' }, you: obj({ ready: { type: 'boolean', const: true } }) }),
        ],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }),
    skill: () => ({
      title: 'Read skill file',
      description:
        `Read a file of an PlayerThree default workflow, generated reference or developer strategy skill, at most ${SKILL_PAGE_MAX} characters per call cut after a line; \`next\` is the \`offset\` to continue at. Start with playerthree-commander. Skill names are listed in the briefing; each skill's SKILL.md lists its files (also served over the MCP skills extension). Unknown files: error \`invalid\`.`,
      inputSchema: obj({
        name: strEnum(skills.map((s) => s.name).sort()),
        path: str({ minLength: 1, maxLength: 200, pattern: SKILL_PATH_PATTERN }),
        offset: int(0, LIMITS.maxOffset),
      }, ['name', 'path']),
      outputSchema: obj({ name: str(), path: str(), offset: int(0), total: int(0), text: str({ maxLength: SKILL_PAGE_MAX }), next: int(1) }, ['name', 'path', 'offset', 'total', 'text']),
      annotations: READ,
    }),
    policyDeploy: () => ({
      title: 'Deploy policy',
      description: deployDescription(),
      inputSchema: artifactSchema(),
      outputSchema: deployResultSchema(m),
      annotations: WRITE,
    }),
    policyStatus: () => ({
      title: 'Policy status',
      description:
        `Your deployed policy for this role: version, runtime, calls, timeouts, errors, meanMs/maxMs, intentsEmitted, intentsRejected by code, lastInvalid (your latest schema-invalid intent, with expected), lastError and your logs${m.starters ? '; from/knobs when it came from a starter' : ''}. \`approval\`: your latest supervised proposal (pending, approved, rejected or failed); \`activationError\`: why a saved version cannot run. \`policy: null\` means nothing is deployed, so no policy plays this role: deploy one first${m.starters ? ' (a starter is one call: policy_deploy {from})' : ''}. With an approval but no deployed policy, version is null.`,
      inputSchema: obj({}),
      outputSchema: obj({ policy: policyStatusSchema(m) }),
      annotations: READ,
    }),
    policyRollback: () => ({
      title: 'Roll back policy',
      description: 'Re-deploy an earlier policy version (policy scope). For commanders it becomes the active library version. Supervised seats return an approval request without changing the policy until the owner approves.',
      inputSchema: obj({ version: int(1, LIMITS.maxVersion) }),
      outputSchema: deployResultSchema(m),
      annotations: WRITE,
    }),
    policyExport: () => ({
      title: 'Export policy package',
      description: `Export one of your library versions (policy scope; default your active version) as a portable \`${POLICY_PACKAGE_FORMAT}\` package: canonical JSON with the deployed source, the composed script, hashes, lineage and license, never logs or identities. Paged: each page's \`text\` is at most ${POLICY_EXPORT_PAGE} characters of the package; page 1 exports afresh, later pages (\`next\`) slice that same export, and joined in order the pages are the package. Unknown version: error \`invalid\`.`,
      inputSchema: obj({ version: int(1, LIMITS.maxVersion), page: int(1, LIMITS.maxPage) }, []),
      outputSchema: obj({
        version: int(1, LIMITS.maxVersion),
        hash: str({ pattern: HEX64 }),
        bytes: int(1, POLICY_PACKAGE_MAX_BYTES),
        page: int(1),
        pages: int(1),
        text: str({ maxLength: POLICY_EXPORT_PAGE }),
        next: obj({ version: int(1, LIMITS.maxVersion), page: int(2) }),
      }, ['version', 'hash', 'bytes', 'page', 'pages', 'text']),
      annotations: READ,
    }),
    policyImport: () => ({
      title: 'Import policy package',
      description: `Add a \`${POLICY_PACKAGE_FORMAT}\` package (as policy_export joins it) to your library as a new, inactive version (policy scope). The host verifies its hash, game, your role, runtime and script hash, and rebuilds its source when it was made for this surface (\`stale\`: made for another surface, so activating it fails until you redeploy). Activate it with policy_rollback. Any problem with the package: error \`invalid\`.`,
      inputSchema: obj({ package: packageSchema() }),
      outputSchema: obj({ ok: { type: 'boolean', const: true }, version: int(1, LIMITS.maxVersion), stale: { type: 'boolean' } }),
      annotations: WRITE,
    }),
    practice: () => {
      const props: Record<string, JsonSchema> = {
        opponent: strEnum(opponents),
        ticks: int(1, practice?.maxTicks),
        seed: int(0, LIMITS.maxSeed),
        allies: strEnum(opponents),
      };
      if (policy) props['artifact'] = artifactSchema();
      // The full options schema can dwarf every other tool (spec §4 *Tool-surface budget*): it is a topic instead.
      if (m.matchOptions) {
        props['options'] = {
          // Open (any member, any value), so the argument check passes everything on to the host's options validation.
          type: 'object',
          additionalProperties: {},
          description: 'The game\'s match options for this run, every field optional (omitted: the game\'s defaults). JSON Schema: game_briefing {topic:"schema/match-options"}. The host validates them: a failure is invalid with schemaCode, path and expected.',
        };
      }
      // One game minute (bounded by maxTicks) keeps the example run short.
      const example = JSON.stringify({ opponent: opponents[opponents.length - 1], ticks: Math.min(practice?.maxTicks ?? 1, 60 * m.tickRate) });
      return {
        title: 'Practice match',
        description: `Run a headless practice match at fast-forward (max ${practice?.maxTicks} ticks) against a built-in opponent (weakest first: ${opponents.join(', ')}), e.g. ${example}. Plays your deployed policy${policy ? `, or \`artifact\`: any policy_deploy shape${m.starters ? ', including {from, knobs}' : ''}` : ''}.${m.matchOptions ? ' `options`: topic schema/match-options.' : ''} Returns the outcome, the after-action report and your policy’s stats and logs. Practice early, against the strongest opponent.`,
        inputSchema: obj(props, ['opponent', 'ticks']),
        outputSchema: {
          type: 'object',
          oneOf: [
            obj({
              ok: { type: 'boolean', const: true },
              outcome: OUTCOME, ticks: int(0), report: toJsonSchema(m.report),
              policy: policyStatsSchema(m), wallMs: { type: 'number', minimum: 0 },
            }),
            obj({
              ok: { type: 'boolean', const: false }, code: strEnum(['policy', 'guard']),
              policy: policyStatsSchema(m), wallMs: { type: 'number', minimum: 0 },
            }),
          ],
        },
        annotations: WRITE,
      };
    },
    say: () => ({
      title: 'Message your owner',
      description: `Send a short message (max ${chat?.maxSayChars} chars) to your owner — the player you work for, and only them (never opponents or teammates). Use it to acknowledge orders and report what you are doing. Works in the lobby too. Rate-limited.`,
      inputSchema: { ...obj({ text: str({ minLength: 1, maxLength: chat?.maxSayChars ?? 1 }), disclosure: strEnum(['observers']), category: strEnum(['summary', 'chat']) }, ['text']), dependentRequired: { category: ['disclosure'] } },
      outputSchema: obj({ ok: { type: 'boolean', const: true }, tick: int(0) }),
      annotations: WRITE,
    }),
    publish: () => ({
      title: 'Publish policy',
      description:
        'Publish your deployed policy to the game’s pool (publish scope) for other players’ matches while you are offline. Supervised seats return an approval request without publishing until the owner approves.',
      inputSchema: obj({}),
      outputSchema: { type: 'object', oneOf: [obj({ policyId: str({ pattern: '^pol_[0-9]{1,12}$' }) }), approvalResultSchema()] },
      annotations: WRITE,
    }),
  };

  const tools: ToolSpec[] = TOOL_ORDER.filter((method) => methodEnabled(m, method)).map((method) => {
    const spec = specs[method]();
    // Skill files are the same for every role.
    return { name: MCP_TOOL_NAMES[method], method, ...spec, inputSchema: method === 'skill' ? spec.inputSchema : withRole(m, spec.inputSchema) };
  });
  tools.push({
    name: 'game_usage',
    method: 'usage',
    title: 'Report decision usage',
    description: 'Optionally report bounded self-reported usage for this exact live seat only. Missing values are unknown, never zero. Declared latency is not measured latency.',
    inputSchema: withRole(m, obj({
      decisionId: str({ minLength: 1, maxLength: 128 }),
      latencyMs: { type: 'number', minimum: 0, maximum: 86400000 },
      source: strEnum(['provider', 'self_report']),
      reporter: strEnum(['reported', 'estimated', 'unpriced']),
      coverage: strEnum(['complete', 'partial', 'unknown']),
      inputTokens: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      outputTokens: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      cacheReadTokens: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      cacheWriteTokens: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      costAmount: { type: ['string', 'null'], maxLength: 64 },
      currency: { type: ['string', 'null'], maxLength: 16 },
      pricingVersion: { type: ['string', 'null'], maxLength: 128 },
    }, ['decisionId', 'latencyMs', 'source', 'reporter', 'coverage'])),
    outputSchema: obj({ ok: { type: 'boolean', const: true } }),
    annotations: WRITE,
  });
  checkSurfaceBudget(tools);
  return tools;
}
