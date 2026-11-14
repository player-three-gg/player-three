/**
 * Briefing topics: the on-demand half of progressive disclosure. The core briefing carries the rules, the seat's role
 * doc and a one-line index; everything else is a topic fetched with game_briefing `{ topic, page }`. Game topics come
 * from `manifest.topics`; generated topics are rendered from the manifest (intents, observation fields, events,
 * report, mandate, modes and policy ABI, JSON Schemas) so they can never drift from what the host enforces. The
 * generated `<id>-reference` skill serves the very same pages as files.
 */
import { MCP_TOOL_NAMES, type ControlMethod, type TopicPage } from './control.ts';
import { PlayerThreeError } from './host/util.ts';
import { MAX_POLICY_INCLUDES, POLICY_MAX_MODULES, POLICY_MODULES_MAX_BYTES, RESULT_TEXT_MAX, SKILL_PAGE_MAX, TOPIC_TEXT_MAX, observationSections, type AnyManifest, type ControlModes, type IntentDef, type ObservationScope, type TopicDef } from './manifest.ts';
import { expectedAt, intentTypeNames, manifestDts } from './dts.ts';
import { knobLines, starterCatalog } from './policy/starters.ts';
import { toJsonSchema, type EnumS, type JsonSchema, type ObjS } from './schema.ts';

const tool = (m: ControlMethod): string => `\`${MCP_TOOL_NAMES[m]}\``;
/** Generated topic pages: TOPIC_TEXT_MAX less room for a reference file's `[continues in …]` trailer. */
const GENERATED_PAGE_MAX = TOPIC_TEXT_MAX - 100;
/**
 * Prefix of the one machine-readable line in topic `modes`:
 * `{ control, opponents, errors, eventKinds, intentRoles }` as JSON (what tools such as `playerthree audit` read).
 */
export const SURFACE_JSON_PREFIX = 'Surface JSON: ';
/** Prefix of the `starters` topic's machine-readable line: each starter's roles and exact knobs JSON Schema. */
export const STARTERS_JSON_PREFIX = 'Starters JSON: ';

export interface BriefingTopic {
  readonly name: string;
  /** One line, shown in the index (generated topics are indexed per family; see `topicIndex`). */
  readonly summary: string;
  /** Each ≤ TOPIC_TEXT_MAX. */
  readonly pages: readonly string[];
}

/**
 * Seat context for dynamic topics. `matchData`: the seat's guarded match bootstrap while in a match (`null` when the
 * game declares none); omitted in the lobby, where `match-data` documents its fields instead.
 */
export interface TopicContext {
  readonly matchData?: Record<string, unknown> | null;
}

// ------------------------------------------------------------------ text helpers

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** Cut point ≤ `end` in `text` after `start`: just after the last newline, else `end` (never inside a surrogate pair). */
function cutAt(text: string, start: number, end: number): number {
  const newline = text.lastIndexOf('\n', end - 1);
  if (newline >= start) return newline + 1;
  return isHighSurrogate(text.charCodeAt(end - 1)) && end - 1 > start ? end - 1 : end;
}

/** Split text into pages of ≤ `max` code units, breaking after newlines where possible (the newline is dropped). */
export function pageText(text: string, max: number = TOPIC_TEXT_MAX): string[] {
  const pages: string[] = [];
  let start = 0;
  while (text.length - start > max) {
    const cut = cutAt(text, start, start + max);
    pages.push(text.slice(start, text[cut - 1] === '\n' ? cut - 1 : cut));
    start = cut;
  }
  pages.push(text.slice(start));
  return pages;
}

/** A window of a skill file starting at `offset`: ≤ `max` code units, cut just after a newline when the file continues. */
export function skillWindow(content: string, offset: number, max: number = SKILL_PAGE_MAX): { text: string; next?: number } {
  if (!Number.isSafeInteger(offset) || offset < 0 || (offset >= content.length && offset !== 0)) throw new PlayerThreeError('invalid');
  if (content.length - offset <= max) return { text: content.slice(offset) };
  const cut = cutAt(content, offset, offset + max);
  return { text: content.slice(offset, cut), next: cut };
}

/** Compact one-line type from a JSON Schema node (the same schema agents get in tool definitions). */
function typeOf(js: JsonSchema): string {
  if (Array.isArray(js.enum)) return js.enum.map((v) => `\`${String(v)}\``).join(' \\| ');
  if (js.const !== undefined) return `\`${String(js.const)}\``;
  if (Array.isArray(js.oneOf)) return `one of ${js.oneOf.length} variants`;
  switch (js.type) {
    case 'integer':
    case 'number':
      return `${js.type} ${String(js.minimum)}..${String(js.maximum)}`;
    case 'boolean':
      return 'boolean';
    case 'string':
      return typeof js.maxLength === 'number'
        ? `string (max ${js.maxLength} Unicode code points)${typeof js.pattern === 'string' ? ` matching \`${js.pattern}\`` : ''}`
        : typeof js.pattern === 'string' ? `id \`${js.pattern}\`` : 'string';
    case 'array':
      return `list (max ${String(js.maxItems)}) of ${typeOf(js.items as JsonSchema)}`;
    case 'object':
      return 'object';
    default:
      return 'value';
  }
}

function fieldLine(js: JsonSchema, path: string, required: boolean): string {
  const doc = typeof js.description === 'string' ? ` — ${js.description}` : '';
  return `- \`${path}\`${required ? '' : ' (optional)'}: ${typeOf(js)}${doc}`;
}

/** Flatten a JSON Schema into `- path — type — doc` bullet lines. */
function fieldLines(js: JsonSchema, path: string, out: string[], depth = 0): void {
  if (depth > 8) return;
  const required = new Set(Array.isArray(js.required) ? (js.required as string[]) : []);
  if (js.type === 'object' && js.properties) {
    for (const [k, child] of Object.entries(js.properties as Record<string, JsonSchema>)) {
      const p = path ? `${path}.${k}` : k;
      out.push(fieldLine(child, p, required.has(k)));
      fieldLines(child, p, out, depth + 1);
    }
  } else if (js.type === 'array' && js.items) {
    fieldLines(js.items as JsonSchema, `${path}[]`, out, depth + 1);
  } else if (Array.isArray(js.oneOf)) {
    for (const variant of js.oneOf as JsonSchema[]) {
      const tag = Object.values(variant.properties as Record<string, JsonSchema>).find((p) => p.const !== undefined);
      out.push(`- \`${path}\` variant \`${String(tag?.const)}\`:`);
      fieldLines({ ...variant, properties: Object.fromEntries(Object.entries(variant.properties as Record<string, JsonSchema>).filter(([, p]) => p.const === undefined)) }, path, out, depth + 1);
    }
  }
}

function schemaSection(js: JsonSchema): string {
  const lines: string[] = [];
  fieldLines(js, '', lines);
  return lines.length > 0 ? lines.join('\n') : `- ${typeOf(js)}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
}

/** Canonical (sorted keys) JSON, one-space indented so pages break between lines. */
const schemaText = (js: JsonSchema): string => JSON.stringify(sortKeys(js), null, 1);

const firstSentence = (doc: string): string => {
  const flat = doc.trim().replace(/\s+/g, ' ');
  const s = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
};

/** One intent's JSON Schema, exactly as game_act validates it. */
export function intentJsonSchema(kind: string, def: IntentDef): JsonSchema {
  const params = toJsonSchema({ t: 'obj', fields: def.params });
  return {
    type: 'object',
    description: `${def.doc} Roles: ${def.roles.join(', ')}.`,
    properties: { kind: { type: 'string', const: kind }, ...(params['properties'] as Record<string, JsonSchema>) },
    required: ['kind', ...(params['required'] as string[])],
    additionalProperties: false,
  };
}

// ------------------------------------------------------------------ sections

function modesSection(c: ControlModes, tickRate: number): string {
  const lines = [
    `- **intents** (always): ${tool('act')} — token bucket of ${c.intents.perSecond} intents/s per seat, burst ${c.intents.burst}. ` +
      `${tool('observe')} returns your seat's fogged observation; ${tool('wait')} sleeps in game time until events happen.`,
  ];
  if (c.policy) {
    const p = c.policy;
    lines.push(
      `- **policy**: ${tool('policyDeploy')} uploads code (${p.runtimes.join(', ')}) that runs sandboxed at ${p.hz} calls per game second ` +
        `(${p.msPerCall} ms and ${Math.round(p.memoryBytes / 1048576)} MiB per call, artifact ≤ ${p.maxArtifactBytes} bytes, ≤ ${p.maxIntentsPerCall} intents per call, ` +
        `≤ ${p.maxLogLines} log lines of ≤ ${p.maxLogLineBytes} bytes). Each deploy runs one probe call on your current observation and is rejected if it fails. ` +
        `${tool('policyStatus')} shows calls, timeouts, errors, timings, rejected intent codes and your logs; ${tool('policyRollback')} restores one of the last 10 versions. ` +
        'The policy runs while the seat controller is `agent` or `policy`.',
    );
  }
  if (c.stream) {
    lines.push(
      `- **stream**: observations pushed every N ticks (at most ${c.stream.maxHz} per game second; the game runs at ${tickRate} ticks/s), ` +
        `≤ ${c.stream.intentsPerTick} intents per tick while streaming.`,
    );
  }
  if (c.practice) {
    lines.push(
      `- **practice**: ${tool('practice')} runs a headless match (≤ ${c.practice.maxTicks} ticks, fast-forward) of your policy against a built-in opponent; ` +
        `your other seats are bots. Returns outcome, the after-action report and your policy stats/logs. ≤ ${c.practice.concurrent} concurrent runs.`,
    );
  }
  if (c.pool) {
    lines.push(
      `- **pool**: ${tool('publish')} publishes your deployed policy; it can be drafted into other players' matches (seats with controller \`policy\`) ` +
        `and its wins/losses are recorded. ≤ ${c.pool.maxPublishedPerPrincipal} published per team owner.`,
    );
  }
  if (c.sequence) {
    lines.push(`- **sequence**: ${tool('sequence')} schedules up to ${c.sequence.maxSteps} steps, each \`{ in, intents }\`, ` +
      `at most ${c.sequence.maxTicksAhead} ticks ahead with at least ${c.sequence.minSpacingTicks} ticks between steps. ` +
      `One plan per seat; a new plan replaces it, empty steps cancel, and \`cancelOn\` lists visible event kinds that cancel it. ` +
      `The whole plan is validated first; scheduled intents still pass controller and rate gates at execution.`);
  }
  if (c.chat) lines.push(`- **chat**: your owner's messages arrive in ${tool('wait')} / ${tool('observe')} as \`messages\`; reply with ${tool('say')} (≤ ${c.chat.maxSayChars} characters, owner only).`);
  if (c.pausable) lines.push(`- **pausable**: with mandate \`whenAbsent: "pause"\` the session stands still while you are away${c.pausable.maxPauseSeconds !== undefined ? ` (at most ${c.pausable.maxPauseSeconds} s)` : ''}.`);
  if (c.signals) {
    lines.push(`- **signals**: typed team requests (topic \`signals\`) — ≤ ${c.signals.perSecond} new signals/s per seat (burst ${c.signals.burst}), ≤ ${c.signals.maxOpen} open per seat, ` +
      `open ones expire after ${c.signals.ttlTicks} ticks, closed ones stay visible ${c.signals.keepTicks} ticks. A match may narrow these or turn signals off.`);
  }
  return lines.join('\n');
}

function policyAbi(m: AnyManifest): string {
  const p = m.control.policy;
  if (!p) return '';
  return `## Policy API

- **js**: a classic script (no \`import\`/\`export\`). Define a global \`function think(obs)\` that returns an array of intent objects
  (same shape as ${tool('act')}); optional \`function init(matchData)\` receives separate bootstrap once at load. \`log(...args)\` is your only output (shown back to you in
  ${tool('policyStatus')} and practice results). Globals persist between calls within one match. No I/O, timers, network or clock
  (\`Date.now()\` is frozen, \`Math.random\` is seeded per match).
- **include** (js only): ${m.control.practice ? `${tool('policyDeploy')} and ${tool('practice')} \`artifact\` accept` : `${tool('policyDeploy')} accepts`} \`include: ["<skill>/<path>", …]\`: up to ${MAX_POLICY_INCLUDES} served skill \`.js\` files
  (for example a game's policy library). The host prepends their contents, joined by newlines, then a newline, to \`code\`. That composed source is what is
  size-checked (≤ ${p.maxArtifactBytes} bytes), probed, stored, versioned and hashed; unknown entries are \`invalid\`. So send only your own code plus the include list.
- **modules** (js only): instead of \`code\`, send \`modules: {"<path>": source, …}\` and \`entry: "<path>"\` — ES modules in JavaScript or TypeScript
  (\`.js\`, \`.mjs\`, \`.ts\`, \`.mts\`; at most ${POLICY_MAX_MODULES} modules, ${POLICY_MODULES_MAX_BYTES} bytes of source in total). The host bundles them with esbuild into
  one classic script: types are stripped without type checking; imports must be relative (\`./\`, \`../\`) with their file extension and name
  another module or a served skill \`.js\` file at \`<skill>/<path>\`. The entry exports \`think\` and optionally \`init\` and \`detail\`. \`include\` still works.
${m.starters ? `- **starters**: \`{ from: "<skill>/<path>.js", knobs? }\` instead of \`code\`/\`modules\` deploys one of the game's ready-made policies with
  its knobs (topic \`starters\`).
` : ''}- **types**: topic \`types\` (\`types/<role>\`: \`Intent\` narrowed to one role) holds the game's TypeScript declarations (\`Observation\`, \`MatchData\`,
  one type per intent kind, \`Intent\`, \`Think\`, \`Init\`, \`Detail\`, \`log\`) for a \`// @ts-check\` script or TypeScript modules.
- **wasm**: a core WebAssembly module (any language), uploaded base64-encoded. Exports \`memory\` (with a declared maximum),
  \`alloc(len: i32) -> i32\`, \`think(ptr: i32, len: i32) -> i64\` and optionally \`init(ptr: i32, len: i32) -> ()\`. At initialization the host writes separate bootstrap JSON into checked \`alloc\` memory and calls \`init\`. Each call the host \`alloc\`s and writes the
  observation as UTF-8 JSON, calls \`think\`, and reads the returned \`(outPtr << 32) | outLen\` as UTF-8 JSON of an intent array.
  The only permitted import is \`env.log(ptr: i32, len: i32)\` (one UTF-8 line); WASI or any other import is rejected.
- Output is validated exactly like ${tool('act')}: invalid intents are rejected with codes, never applied; ${tool('policyStatus')} \`lastInvalid\` shows the latest
  schema failure with its \`expected\` type.

Match bootstrap never appears in observations, including the first. Optional \`init(matchData)\` (JS) or
\`init(ptr,len)\` (WASM) receives it once per instance, independently bounded to 128 KiB of UTF-8 JSON. Retain
needed data in policy state. Without a declared match-data schema initialization receives JSON \`null\`.
Deployment probes, practice, benchmarks and crash restarts initialize fresh instances the same way.`;
}

/** The `starters` topic (spec §11 *Starters*): the deploy call, then each starter's path, roles, summary and knobs. */
function startersTopic(m: AnyManifest): string {
  const starters = [...starterCatalog(m).values()];
  const first = starters[0]!;
  const knob = first.knobs ? Object.entries(first.knobs.properties as Record<string, JsonSchema>)[0] : undefined;
  const example = JSON.stringify({ from: first.path, ...(knob ? { knobs: { [knob[0]]: knob[1].default } } : {}) });
  return `# Starters

Ready-made baseline policies this game serves as skill files. Deploy one by reference, with no code to write:
${tool('policyDeploy')} \`${example}\`${m.control.practice ? ` (${tool('practice')} takes the same as \`artifact\`)` : ''}.
Every knob is optional (omitted: the starter's default). The host validates \`knobs\` against the starter's schema (a failure is
\`invalid\` with \`schemaCode\`, \`path\` and \`expected\`), builds \`createPolicy(knobs)\` from the served file and probes, versions and
stores it like any deploy; ${tool('policyStatus')}, your library version and ${tool('policyExport')} record \`from\` and \`knobs\`. To change
more than the knobs, read the file (${tool('skill')}) and fork it: send \`modules\` whose entry imports it at \`./<path>\` and calls
\`createPolicy\` itself.

${starters.map((s) => `## \`${s.path}\` (roles: ${s.roles.join(', ')})\n\n${s.summary}\n\nKnobs:\n${knobLines(s.knobs).join('\n')}`).join('\n\n')}

## Machine-readable

Each starter's roles and exact knobs JSON Schema (\`null\`: it takes no knobs), as one JSON line:
${STARTERS_JSON_PREFIX}${JSON.stringify(Object.fromEntries(starters.map((s) => [s.path, { roles: s.roles, knobs: s.knobs }])))}`;
}

/** The `signals` topic: lifecycle, the game's kinds with their docs and params, and each role's card. */
function signalsTopic(m: AnyManifest): string {
  const vocab = m.signals!;
  const limits = m.control.signals!;
  const roles = (m.roles as EnumS).values;
  const kinds = Object.entries(vocab.kinds).map(([kind, d]) => {
    const params = Object.keys(d.params).length > 0 ? schemaSection(toJsonSchema({ t: 'obj', fields: d.params })) : '- no payload';
    const to = roles.filter((r) => (vocab.cards[r] ?? []).some((s) => s.kind === kind));
    return `## \`${kind}\` (sent by ${d.roles.join(', ')}; to ${to.join(', ')} or team)\n\n${d.doc}\n\n${params}`;
  });
  const cards = roles.map((r) => {
    const skills = vocab.cards[r] ?? [];
    return `- \`${r}\`: ${skills.length === 0 ? 'answers nothing' : skills.map((s) => `\`${s.kind}\`${s.where ? ` (${Object.entries(s.where).map(([f, v]) => `${f}: ${v.join(' / ')}`).join('; ')})` : ''}`).join(', ')}`;
  });
  return `# Team signals

Teammates — humans, agents, policies and bots alike — ask each other for help with typed signals. They carry no text:
only the game's kinds and their typed payload. They reach only your team, never an opponent.

**Send** \`{"kind":"signal","signal":{"kind":"<signal kind>","to":"<role>|team", …payload}}\` with ${tool('act')} (or from a policy or
sequence). \`to: "team"\` reaches every teammate whose card answers it; the first to ack takes it. Ask only roles whose card
answers that kind (below); anything else is refused \`unsupported\`.

**Receive**: every observation (${tool('observe')}, a policy's \`think(obs)\`) has \`signals: { inbox, sent }\` — what teammates sent you and
what you sent, each entry \`{ kind, id, from, to, tick, expires, state, by?, …payload }\`. ${tool('wait')} returns early with \`wake: "signal"\` and your
\`signals\` when one reaches you or one you sent changes. Human teammates see them in the game's UI.

**Answer** \`{"kind":"signal_update","id":"sg_…","update":"ack"|"decline"|"done"|"fail"|"cancel"}\`: ack when you take it, then done
(or fail); decline if you will not. Only the requester cancels. States (A2A task states): \`submitted\` → \`working\` (acked) →
\`completed\` | \`rejected\` | \`failed\` | \`canceled\` | \`expired\` (open ${limits.ttlTicks} ticks without an ending). Closed signals stay
visible ${limits.keepTicks} ticks. Each seat may send ${limits.perSecond}/s (burst ${limits.burst}) and keep ${limits.maxOpen} open.

Refusals: ack \`{ok:false, code:"signal", signalCode}\` with \`disabled\` (off in this match), \`unsupported\` (no teammate answers that
there), \`unknown_signal\`, \`not_recipient\` (not yours, or a teammate already took it), \`closed\` (already ended),
\`too_many_open\`; or \`rate_limited\`.

## Role cards (who answers what)

${cards.join('\n')}

${kinds.join('\n\n')}`;
}

const PAGING = `## Reading large results

Every tool result's text is at most ${RESULT_TEXT_MAX} characters. Topics come in pages of at most ${TOPIC_TEXT_MAX} characters
(${tool('briefing')} \`{ topic, page }\`; each page names the next). Skill files come in windows of at most ${SKILL_PAGE_MAX} characters cut at a line
(${tool('skill')} \`{ name, path, offset }\`; the result's \`next\` is the offset to continue at). A ${tool('observe')} result that would be larger is
paged: the call snapshots the observation and returns page 1 with \`page\`, \`pages\`, \`tick\` and \`next\`; ${tool('observe')} \`{ page: n }\` returns
page n of that same snapshot (however old: check \`tick\`) until the next unpaged call replaces it. Keys come in schema order and an oversize
list is split by items (\`items\` gives each split list's \`[from, to)\` range and length). Pass \`fields\` (top-level observation keys) to fetch
only what you need, usually in one page.`;

// ------------------------------------------------------------------ generated topics

interface Family {
  /** Index line. */
  line: string;
  /** Reference skill index line (file pattern). */
  file: string;
}

/** The observation topic's scope paragraph between two sentences (games declaring `observationScope`; else a space). */
function scopeNote(m: AnyManifest): string {
  const scope = m.observationScope as ObservationScope | undefined;
  if (!scope) return ' ';
  const roles = Object.entries(scope.defaults).map(([role, full]) => `${role}: ${full.length > 0 ? full.join(', ') : 'none'}`).join('; ');
  return `

**Observation scope.** Sections: ${observationSections(m).join(', ')}. Each role sees its default sections in full (${roles}); every other section comes as the game's compact summary. ${tool('observe')} \`detail\` (a list of sections, or "all") adds sections in full for that call; a policy declares the sections it reads once (JS global \`detail\`, wasm custom section \`playerthree.detail\`: a list or "all"); built-in bots see every section.

`;
}

function observationFields(m: AnyManifest): [string, JsonSchema, boolean][] {
  const js = toJsonSchema(m.observation);
  if (js.type !== 'object' || !js.properties) return [];
  const required = new Set(Array.isArray(js.required) ? (js.required as string[]) : []);
  return Object.entries(js.properties as Record<string, JsonSchema>).map(([k, v]) => [k, v, required.has(k)]);
}

function schemaTargets(m: AnyManifest): [string, string, JsonSchema][] {
  return [
    ['observation', 'the observation (game_observe, policy think input)', toJsonSchema(m.observation)],
    ...(m.matchData ? [['match-data', 'match bootstrap (topic match-data, policy init input)', toJsonSchema(m.matchData)] as [string, string, JsonSchema]] : []),
    ['event', 'one visible event', toJsonSchema(m.event)],
    ['report', 'the after-action report', toJsonSchema(m.report)],
    ['directive', 'the mandate directive', toJsonSchema(m.directive)],
    ['limits', 'the mandate limits (house rules)', toJsonSchema(m.limits ?? { t: 'obj', fields: {} })],
    // practice_run (and the host's match options) take this; the tool schema carries only an opaque object.
    ...(m.matchOptions ? [['match-options', 'the match options (practice_run `options`; every field optional)', toJsonSchema(m.matchOptions)] as [string, string, JsonSchema]] : []),
    ...Object.entries(m.intents as Record<string, IntentDef>).map(([kind, def]): [string, string, JsonSchema] => [`intent/${kind}`, `intent \`${kind}\``, intentJsonSchema(kind, def)]),
  ];
}

function families(m: AnyManifest): Family[] {
  const roles = (m.roles as EnumS).values;
  const out: Family[] = [
    { line: `role/<role> — any role's doc (${roles.join(', ')})`, file: '`role/<role>.md` — any role\'s doc' },
    { line: 'intents — every intent kind with its roles and rule; ack and error codes', file: '`intents.md` — every intent kind with its roles and rule; ack and error codes' },
    { line: 'intent/<kind> — params, rules and shape of one intent', file: '`intent/<kind>.md` — params, rules and shape of one intent (kinds: `intents.md`)' },
    { line: 'observation — top-level observation fields, one line each', file: '`observation.md` — top-level observation fields, one line each' },
  ];
  if (observationFields(m).length > 0) out.push({ line: 'observation/<field> — nested fields of one top-level observation field', file: '`observation/<field>.md` — nested fields of one observation field' });
  out.push(m.matchData
    ? { line: "match-data — your seat's immutable match bootstrap (live JSON in a match, paged)", file: '`match-data.md` — match bootstrap: what it is, how policies get it' }
    : { line: 'match-data — match bootstrap (this game declares none) and policy init', file: '`match-data.md` — match bootstrap (none in this game) and policy init' });
  if (m.matchData) out.push({ line: 'match-data/fields — match bootstrap field docs', file: '`match-data/fields.md` — match bootstrap field docs' });
  out.push(
    { line: 'events — event kinds and payload fields (game_wait until)', file: '`events.md` — event kinds and payload fields' },
    { line: 'report — after-action report fields', file: '`report.md` — after-action report fields' },
    { line: 'mandate — owner mandate: autonomy, directive and limits fields, whenAbsent, approvals', file: '`mandate.md` — owner mandate, directive and limits fields, approvals' },
    { line: `modes — control modes and limits, opponents, result paging${m.control.policy ? ', policy ABI, include, modules' : ''}`, file: `\`modes.md\` — control modes and limits, opponents, result paging${m.control.policy ? ', policy ABI, include and modules' : ''}` },
    ...(m.signals ? [{ line: 'signals — team signals: who answers what, asking, answering', file: '`signals.md` — team signals: kinds, role cards, lifecycle' }] : []),
    ...(m.starters ? [{ line: 'starters — ready baseline policies: deploy one by reference with knobs', file: '`starters.md` — ready baseline policies to deploy by reference: roles and knobs' }] : []),
    { line: `schema/<name> — canonical JSON Schema text, paged (${schemaTargets(m).filter(([n]) => !n.startsWith('intent/')).map(([n]) => n).join(', ')}, intent/<kind>)`, file: '`schema/<name>.md` — canonical JSON Schema text (observation, event, report, directive, limits, intent/<kind>…)' },
    { line: 'types — TypeScript .d.ts of observation, match data and intents, paged; types/<role>: Intent of one role', file: '`types.md` — TypeScript declarations (.d.ts) of observation, match data and intents; `types/<role>.md` narrows `Intent` to one role' },
  );
  return out;
}

/** The core briefing's topic index: game topics (`name — summary`), then one line per generated family. */
export function topicIndex(manifest: AnyManifest): string[] {
  return [
    ...Object.entries(manifest.topics as Record<string, TopicDef>).map(([name, def]) => `${name} — ${def.summary}`),
    ...families(manifest).map((f) => f.line),
  ];
}

function lobbyMatchData(m: AnyManifest): string {
  const intro = m.matchData
    ? `# Match bootstrap

In a match, this topic is your seat's immutable match bootstrap (restricted to your seat's perspective), as paged JSON.
Lobby briefings have none. ${tool('observe')} never resends it. Fields (also topic \`match-data/fields\`, schema \`schema/match-data\`):

${schemaSection(toJsonSchema(m.matchData))}`
    : `# Match bootstrap

This game declares no match bootstrap data.`;
  return `${intro}

Match bootstrap never appears in observations, including the first. A policy's optional \`init(matchData)\` (JS) or
\`init(ptr,len)\` (WASM) receives it once per instance, independently bounded to 128 KiB of UTF-8 JSON${m.matchData ? '' : ' (here always JSON `null`)'}.
Retain needed data in policy state.`;
}

/** `label: JSON` lines, each ≤ max: arrays split as `label[i..j]`, objects as `label.key`, long scalars in parts. */
function jsonLines(label: string, value: unknown, max: number, out: string[]): void {
  const json = JSON.stringify(value) ?? 'null';
  if (label.length + 2 + json.length <= max) {
    out.push(`${label}: ${json}`);
    return;
  }
  if (Array.isArray(value)) {
    const overhead = label.length + 32;
    let start = 0;
    let chunk: string[] = [];
    let size = 2;
    const flush = (end: number): void => {
      if (chunk.length > 0) out.push(`${label}[${start}..${end - 1}]: [${chunk.join(',')}]`);
      chunk = [];
      size = 2;
    };
    value.forEach((item, i) => {
      const s = JSON.stringify(item) ?? 'null';
      if (s.length + overhead > max) {
        flush(i);
        jsonLines(`${label}[${i}]`, item, max, out);
        start = i + 1;
        return;
      }
      if (size + s.length + 1 + overhead > max) {
        flush(i);
        start = i;
      }
      chunk.push(s);
      size += s.length + 1;
    });
    flush(value.length);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) jsonLines(`${label}.${k}`, v, max, out);
    return;
  }
  const room = max - label.length - 32;
  const parts = Math.ceil(json.length / room);
  for (let i = 0; i < parts; i++) out.push(`${label} (part ${i + 1}/${parts}): ${json.slice(i * room, (i + 1) * room)}`);
}

function liveMatchData(data: Record<string, unknown>): string[] {
  const lines = [
    "# Your match bootstrap\n\nImmutable for this match and restricted to your seat's perspective; game_observe never resends it. One line per " +
      'top-level key (`key: JSON`); a long list continues as `key[i..j]`, a large object as `key.sub`. Field docs: topic `match-data/fields`.\n',
  ];
  for (const [k, v] of Object.entries(data)) jsonLines(k, v, TOPIC_TEXT_MAX - 1, lines);
  return pageText(lines.join('\n'));
}

const statics = new WeakMap<object, Map<string, BriefingTopic>>();

function staticTopics(m: AnyManifest): Map<string, BriefingTopic> {
  const cached = statics.get(m);
  if (cached) return cached;
  const map = new Map<string, BriefingTopic>();
  // Generated pages leave room for the reference skill's one-line `[continues in …]` trailer (files ≤ TOPIC_TEXT_MAX).
  const add = (name: string, summary: string, text: string): void => {
    map.set(name, { name, summary, pages: pageText(text, GENERATED_PAGE_MAX) });
  };
  // Game topic text is validated ≤ TOPIC_TEXT_MAX: always one page.
  for (const [name, def] of Object.entries(m.topics as Record<string, TopicDef>)) map.set(name, { name, summary: def.summary, pages: [def.text] });

  const roles = (m.roles as EnumS).values;
  for (const r of roles) add(`role/${r}`, `doc of role \`${r}\``, `# Role \`${r}\`\n\n${m.roleDocs[r] as string}`);

  const intents = Object.entries(m.intents as Record<string, IntentDef>);
  const typeNames = intentTypeNames(Object.keys(m.intents));
  const withParams = intents.find(([, d]) => Object.keys(d.params).length > 0);
  const expectedExample = withParams ? expectedAt(m, [Object.keys(withParams[1].params)[0]!], withParams[0]) : expectedAt(m, ['kind']);
  add('intents', 'every intent kind with its roles and rule; ack and error codes', `# Intents

Send with ${tool('act')} as \`{ "intents": [ … ] }\`. Each intent is an object whose \`kind\` selects one of the kinds below
(roles that may send it, then its rule; full params: topic \`intent/<kind>\`):

${intents.map(([kind, d]) => `- \`${kind}\` (${d.roles.join(', ')}) — ${firstSentence(d.doc)}`).join('\n')}

Every intent gets an ack: \`ok\`, or a code — \`invalid\` (with the schema \`path\`, \`schemaCode\` and \`expected\`: what the schema wanted at
that path, as a type reference into topic \`types\` and that type on one line, e.g. \`\` ${expectedExample} \`\`), \`forbidden_role\`,
\`out_of_scope\` (the owner did not grant acting rights), \`not_controller\` (the owner has not given this seat to an agent), \`rate_limited\`, \`game_over\`, ${m.signals ? '`signal` with a `signalCode` (topic `signals`), ' : ''}or \`game\` with one of:
${typeOf(toJsonSchema(m.errors))}${m.errors.doc ? ` — ${m.errors.doc}` : ''}.`);
  for (const [kind, d] of intents) {
    const params = Object.keys(d.params).length > 0 ? schemaSection(toJsonSchema({ t: 'obj', fields: d.params })) : '- no parameters';
    const example = JSON.stringify({ kind, ...Object.fromEntries(Object.keys(d.params).map((k) => [k, '…'])) });
    add(`intent/${kind}`, `intent \`${kind}\``, `# Intent \`${kind}\` (roles: ${d.roles.join(', ')})\n\n${d.doc}\n\n${params}\n\nShape: \`${example}\` (JSON Schema: topic \`schema/intent/${kind}\`; TypeScript: \`${typeNames.get(kind)!}\` in topic \`types\`)`);
  }

  const fields = observationFields(m);
  add('observation', 'top-level observation fields', `# Observation

${tool('observe')} returns your seat's fogged observation (pass \`since\` = the last tick you saw to get only newer events). The same
object is a policy's \`think(obs)\` input.${scopeNote(m)}Top-level fields${fields.length > 0 ? ' (nested fields: topic `observation/<field>`)' : ''}:

${fields.length > 0 ? fields.map(([k, js, req]) => fieldLine(js, k, req)).join('\n') : schemaSection(toJsonSchema(m.observation))}

Match bootstrap never appears in observations: see topic \`match-data\`. JSON Schema: topic \`schema/observation\`; TypeScript: \`Observation\` in topic \`types\`.`);
  for (const [k, js, req] of fields) {
    const lines = [fieldLine(js, k, req)];
    fieldLines(js, k, lines, 1);
    add(`observation/${k}`, `observation field \`${k}\``, `# Observation field \`${k}\`\n\n${lines.join('\n')}`);
  }

  add('match-data', 'match bootstrap', lobbyMatchData(m));
  if (m.matchData) add('match-data/fields', 'match bootstrap field docs', `# Match bootstrap fields\n\n${schemaSection(toJsonSchema(m.matchData))}`);

  const eventKinds = ((m.event as ObjS).fields.kind as EnumS).values;
  add('events', 'event kinds and payload fields', `# Events

Kinds: ${eventKinds.map((k: string) => `\`${k}\``).join(', ')}. ${tool('wait')} with \`until\` returns early on these; ${tool('observe')} with \`since\` returns newer ones.

${schemaSection(toJsonSchema(m.event))}`);

  add('report', 'after-action report fields', `# After-action report

Returned by ${tool('practice')} and recorded at the end of a match, for your team:

${schemaSection(toJsonSchema(m.report))}`);

  add('mandate', 'owner mandate', `# Mandate (from your team owner)

Read \`mandate\` and \`scopes\` in ${tool('briefing')}. The mandate contains \`autonomy\`, \`directive\`, optional game-enforced
\`limits\`, and \`whenAbsent\` (\`policy\`, \`bot\`, ${m.control.pausable ? '`hold`, or `pause`' : 'or `hold`'}). Reading is always allowed; mutations require the corresponding
\`act\`, \`policy\`, \`practice\`, \`publish\`, or \`say\` scope. Supervised deploy, rollback and publish calls return
\`{ ok: false, approval: { id, kind, version } }\` instead of taking effect. The owner resolves them; ${tool('policyStatus')} exposes
\`approval.status\` and ${tool('wait')} wakes with \`approval\`. A newer proposal replaces the previous pending one.

An agent is present during a call, for 30 seconds afterward, or while a sequence is active. When absent, \`policy\` keeps the
deployed policy running (or uses the fallback bot); \`bot\` pauses the policy and uses the fallback bot; \`hold\` does neither.${m.control.pausable ? `
\`pause\` stops the session's clock until your next call${m.control.pausable.maxPauseSeconds !== undefined ? ` (at most ${m.control.pausable.maxPauseSeconds} s; then it continues like \`policy\` until you are back)` : ''}.` : ''}
The controller badge remains \`agent\` throughout.

Directive fields:

${schemaSection(toJsonSchema(m.directive))}

Limits (house rules; every field optional, a missing limit means the game default):

${m.limits ? schemaSection(toJsonSchema(m.limits)) : '- this game declares none'}`);

  add('modes', 'control modes and limits, opponents, result paging, policy ABI', `# Control modes and limits

The game runs at ${m.tickRate} ticks per second. Teams: ${(m.teams as EnumS).values.map((v) => `\`${v}\``).join(', ')}.${(m.teams as EnumS).values.length > 1 ? ' A match may seat only some of them, and may ally some; the core briefing lists the match\'s `teams` and `alliances`.' : ''}

${modesSection(m.control, m.tickRate)}

## Opponents (weakest first)

${typeOf(toJsonSchema(m.opponents))}${m.opponents.doc ? ` — ${m.opponents.doc}` : ''}

## Machine-readable

Modes with their limits, opponents, game error codes (plus \`internal\`), event kinds and the roles of each intent kind, as one JSON line:
${SURFACE_JSON_PREFIX}${JSON.stringify({
    control: m.control,
    opponents: (m.opponents as EnumS).values,
    errors: [...(m.errors as EnumS).values, 'internal'],
    eventKinds: ((m.event as ObjS).fields.kind as EnumS).values,
    intentRoles: Object.fromEntries(Object.entries(m.intents as Record<string, IntentDef>).map(([kind, d]) => [kind, d.roles])),
  })}

${PAGING}${m.control.policy ? `\n\n${policyAbi(m)}` : ''}`);

  if (m.signals) add('signals', 'team signals', signalsTopic(m));
  if (m.starters) add('starters', 'ready baseline policies', startersTopic(m));

  for (const [name, what, js] of schemaTargets(m)) add(`schema/${name}`, `JSON Schema of ${what}`, `JSON Schema (draft 2020-12 subset, keys sorted) of ${what} (as TypeScript: topic \`types\`); pages joined by newlines after this line form the JSON:\n${schemaText(js)}`);

  // The header line keeps the declarations themselves page-joinable, exactly like `schema/<name>`. Topics serve the
  // bounds-only declarations: prose docs would multiply a large game's page count and already live in other topics.
  const dtsHeader = (narrowed: string): string => `TypeScript declarations of ${m.id} ${m.version} (manifestDts, bound notes only)${narrowed}; a global script for \`/// <reference path>\` or a .d.ts beside your policy. Prose docs: topics \`intent/<kind>\` and \`observation\`; \`playerthree types\` writes the fully documented version. Pages joined by newlines after this line form the .d.ts:\n`;
  add('types', 'TypeScript declarations', `${dtsHeader('')}${manifestDts(m, { docs: 'bounds' })}`);
  for (const r of roles) add(`types/${r}`, `TypeScript declarations for role \`${r}\``, `${dtsHeader(` with \`Intent\` narrowed to role \`${r}\``)}${manifestDts(m, { role: r, docs: 'bounds' })}`);

  statics.set(m, map);
  return map;
}

/**
 * Every topic in index order: game topics (manifest order), then generated ones. With `ctx.matchData` (in a match)
 * `match-data` is the seat's live bootstrap; otherwise its field docs.
 */
export function briefingTopics(manifest: AnyManifest, ctx?: TopicContext): BriefingTopic[] {
  const all = [...staticTopics(manifest).values()];
  if (!ctx?.matchData) return all;
  const live = liveMatchData(ctx.matchData);
  return all.map((t) => (t.name === 'match-data' ? { ...t, pages: live } : t));
}

/** One page of a topic; unknown topic or page → PlayerThreeError('invalid'). */
export function topicPage(manifest: AnyManifest, topic: string, page = 1, ctx?: TopicContext): TopicPage {
  if (typeof topic !== 'string' || !Number.isSafeInteger(page) || page < 1) throw new PlayerThreeError('invalid');
  const found = staticTopics(manifest).get(topic);
  if (!found) throw new PlayerThreeError('invalid');
  const pages = topic === 'match-data' && ctx?.matchData ? liveMatchData(ctx.matchData) : found.pages;
  if (page > pages.length) throw new PlayerThreeError('invalid');
  return { topic, page, pages: pages.length, text: pages[page - 1] as string, ...(page < pages.length ? { next: { topic, page: page + 1 } } : {}) };
}

/** Reference skill file path of a topic page: `<topic>.md`, later pages `<topic>.<n>.md`; segments made path-safe. */
export function topicFile(name: string, page: number): string {
  const base = name.split('/').map((s) => s.replace(/[^A-Za-z0-9_-]/g, '_')).join('/');
  return page === 1 ? `${base}.md` : `${base}.${page}.md`;
}

/** Reference skill index lines for generated families (file patterns). */
export function familyFiles(manifest: AnyManifest): string[] {
  return families(manifest).map((f) => f.file);
}
