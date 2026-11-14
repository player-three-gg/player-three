/**
 * Safety Card: a short markdown page a game publishes so players can decide whether to point their agent at it.
 * Built from the audited seat surface (core briefing, generated topics and schemas) and the audit results.
 */
import { MCP_TOOL_NAMES, METHOD_MODE, type ControlMethod } from 'playerthree';
import type { AuditReport } from './audit.ts';

type JsonSchema = { readonly [k: string]: unknown };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One-line type summary of a JSON Schema node. */
function typeOf(s: JsonSchema): string {
  if (Array.isArray(s.enum)) return (s.enum as string[]).length <= 6 ? (s.enum as string[]).map((e) => `\`${e}\``).join(' | ') : `one of ${(s.enum as string[]).length} literals`;
  if (Array.isArray(s.oneOf)) return `one of ${(s.oneOf as unknown[]).length} shapes`;
  switch (s.type) {
    case 'integer':
      return `integer ${s.minimum}…${s.maximum}`;
    case 'number':
      return `number ${s.minimum}…${s.maximum}`;
    case 'boolean':
      return 'boolean';
    case 'string':
      return typeof s.maxLength === 'number'
        ? `string (≤ ${s.maxLength} Unicode code points)${typeof s.pattern === 'string' ? ` matching \`${s.pattern}\`` : ''}`
        : typeof s.pattern === 'string' ? `id \`${s.pattern}\`` : 'string';
    case 'array':
      return `list (≤ ${s.maxItems}) of ${isObj(s.items) ? typeOf(s.items) : '?'}`;
    case 'object':
      return isObj(s.properties) ? `{ ${Object.keys(s.properties).join(', ')} }` : 'object';
    default:
      return '?';
  }
}

function params(s: JsonSchema): string {
  const props = isObj(s.properties) ? s.properties : {};
  const req = Array.isArray(s.required) ? (s.required as string[]) : [];
  const parts = Object.entries(props).map(([k, p]) => `\`${k}${req.includes(k) ? '' : '?'}\`: ${isObj(p) ? typeOf(p) : '?'}`);
  return parts.length ? parts.join(', ') : '—';
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** Renders the Safety Card markdown from an audit report. */
export function safetyCard(r: AuditReport): string {
  const s = r.surface;
  const b = s.briefing;
  const modes = Object.keys(s.modes);
  const tools = (Object.keys(MCP_TOOL_NAMES) as ControlMethod[]).filter((m) => modes.includes(METHOD_MODE[m])).map((m) => `\`${MCP_TOOL_NAMES[m]}\``);
  const obs = isObj(s.observationSchema.properties) ? s.observationSchema.properties : {};
  const intents = s.modes.intents as { perSecond?: number; burst?: number } | undefined;
  const policy = s.modes.policy as { runtimes?: string[]; hz?: number; msPerCall?: number; memoryBytes?: number; maxArtifactBytes?: number } | undefined;
  const passed = r.checks.filter((c) => !c.skipped && c.failed === 0).length;
  const ran = r.checks.filter((c) => !c.skipped).length;

  const lines: string[] = [];
  lines.push(`# Safety Card — ${b.game.title}`, '');
  lines.push(`Game \`${b.game.id}\` version \`${b.game.version}\` · PlayerThree control plane v${b.controlPlane}`, '');
  lines.push('**Surface hash** (pin it; it changes whenever anything your agent can see or call changes):', '', '```', r.surfaceHash, '```', '');
  lines.push(`Audit: **${r.ok ? 'passed' : 'FAILED'}** — ${passed}/${ran} checks, ${r.cases} fuzz cases, \`playerthree audit\` on ${r.generatedAt.slice(0, 10)} (${r.mode}).`, '');

  lines.push('## What your agent receives', '');
  lines.push('- **Typed game data.** Game observations, events and reports use declared schemas, including explicitly bounded trusted text where declared. Bounds and regexes are not sanitizers: the game must exclude third-party player text.');
  lines.push('- **Only your seat’s perspective.** Observations are filtered by the game on the server.');
  lines.push('- **Own-owner chat only.** When chat mode is enabled, your agent can receive messages only from its seat’s own owner, labeled `from: owner`, and reply only to that owner. Opponents, teammates and spectators cannot send it chat. Your agent also receives its own policy’s log lines and engine errors about its own code.');
  lines.push('- **Developer docs.** The core rules briefing, its on-demand topics and the skills are static text written by the game developer (or generated from its manifest) and covered by the surface hash.', '');
  lines.push('Observation fields:', '');
  lines.push('| field | type |', '|---|---|');
  for (const [k, p] of Object.entries(obs)) lines.push(`| \`${k}\` | ${isObj(p) ? cell(typeOf(p)) : '?'} |`);
  lines.push('');

  lines.push('## What your agent can do', '');
  lines.push(`MCP tools: ${tools.join(', ')}.`, '');
  lines.push('| intent | seats | parameters | what it does |', '|---|---|---|---|');
  for (const i of s.intents) lines.push(`| \`${i.kind}\` | ${i.roles.join(', ')} | ${cell(params(i.params as JsonSchema))} | ${cell(i.doc)} |`);
  lines.push('');
  lines.push('It **cannot** chat with other players, read other players’ text, mint tokens, change who controls a seat, or act for any seat but its own. Replies to its own owner require chat mode and the `say` scope.', '');

  lines.push('## Limits', '');
  if (intents) lines.push(`- Intents: ${intents.perSecond}/s per seat, bursts of ${intents.burst}. Every intent is schema-checked, role-checked and controller-checked; errors are fixed codes that never repeat your input.`);
  if (policy) {
    lines.push(`- Policies (bots your agent writes) run sandboxed (${(policy.runtimes ?? []).join(', ')}) with no network, files or wall-clock access: ${policy.msPerCall} ms and ${Math.round((policy.memoryBytes ?? 0) / 2 ** 20)} MiB per instance, ${policy.hz} calls/s, ≤ ${Math.round((policy.maxArtifactBytes ?? 0) / 1024)} KiB of code.`);
    if (policy.runtimes?.includes('js')) lines.push('- JavaScript policies receive seeded deterministic `Math.random()` (sfc32, 32 bits per draw). `Date.now()` and zero-argument `new Date()` are frozen at the Unix epoch; explicit date arguments still work. No unseeded random source is provided.');
  }
  lines.push('- Seat tokens drive exactly one seat in one match and expire with the match. Your team owner can take the seat back at any time.', '');

  lines.push('## Audit results', '');
  lines.push('| check | result |', '|---|---|');
  for (const c of r.checks) lines.push(`| ${cell(c.title)} | ${c.skipped ? `n/a (${c.skipped})` : c.failed ? `**failed** (${c.failed}/${c.passed + c.failed})` : `passed (${c.passed})`} |`);
  lines.push('');
  lines.push('Reproduce: `npx --package @playerthree/cli playerthree audit --url <mcp url> --token <your seat token>`.', '');
  return lines.join('\n');
}
