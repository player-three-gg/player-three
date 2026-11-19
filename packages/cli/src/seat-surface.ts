/**
 * What an agent can learn about a seat's game, read the way an agent reads it: the core briefing plus the generated
 * briefing topics (`modes` for the machine-readable limits line, `schema/<name>` for JSON Schemas). The audit, its
 * vocabulary check and the Safety Card work from this, so they exercise exactly the agent-visible surface.
 */
import { STARTERS_JSON_PREFIX, SURFACE_JSON_PREFIX, type Briefing, type TopicPage } from 'playerthree';
import type { JsonSchema } from './fuzz.ts';

export interface SeatSurface {
  /** The seat's core briefing. */
  briefing: Briefing;
  /** Control modes with their limits (manifest.control). */
  modes: Record<string, unknown>;
  opponents: string[];
  /** Game error codes an ack can carry, plus `internal`. */
  errors: string[];
  eventKinds: string[];
  /** Every intent kind with the roles that may send it, its developer doc and its parameter schema (without `kind`). */
  intents: { kind: string; roles: string[]; doc: string; params: JsonSchema }[];
  observationSchema: JsonSchema;
  directiveSchema: JsonSchema;
  limitsSchema: JsonSchema;
  reportSchema: JsonSchema;
  eventSchema: JsonSchema;
  /** The game's starters by path (topic `starters`, spec §11): roles and knobs JSON Schema (null: none). Empty without. */
  starters: Record<string, { roles: string[]; knobs: JsonSchema | null }>;
}

/** Reads one page of a briefing topic (game_briefing `{ topic, page }`). */
export type TopicReader = (topic: string, page: number) => Promise<TopicPage>;

async function topicText(read: TopicReader, topic: string): Promise<string> {
  const first = await read(topic, 1);
  const pages = [first.text];
  for (let page = 2; page <= first.pages; page++) pages.push((await read(topic, page)).text);
  return pages.join('\n');
}

/** A `schema/<name>` topic's JSON Schema (the first line is a header). */
async function schemaTopic(read: TopicReader, name: string): Promise<JsonSchema> {
  const text = await topicText(read, `schema/${name}`);
  return JSON.parse(text.slice(text.indexOf('\n') + 1)) as JsonSchema;
}

export async function readSurface(briefing: Briefing, read: TopicReader): Promise<SeatSurface> {
  const modes = await topicText(read, 'modes');
  const line = modes.split('\n').find((l) => l.startsWith(SURFACE_JSON_PREFIX));
  if (!line) throw new Error('briefing topic `modes` has no machine-readable surface line');
  const surface = JSON.parse(line.slice(SURFACE_JSON_PREFIX.length)) as {
    control: Record<string, unknown>;
    opponents: string[];
    errors: string[];
    eventKinds: string[];
    intentRoles: Record<string, string[]>;
  };
  const intents: SeatSurface['intents'] = [];
  for (const [kind, roles] of Object.entries(surface.intentRoles)) {
    const schema = await schemaTopic(read, `intent/${kind}`);
    const { kind: _kind, ...properties } = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((k) => k !== 'kind') : [];
    // The intent schema's description is the developer doc followed by ` Roles: a, b.`.
    const description = typeof schema.description === 'string' ? schema.description : '';
    const doc = description.includes(' Roles: ') ? description.slice(0, description.lastIndexOf(' Roles: ')) : description;
    intents.push({ kind, roles, doc, params: { type: 'object', properties, required, additionalProperties: false } });
  }
  let starters: SeatSurface['starters'] = {};
  if (briefing.topics.some((t) => t.startsWith('starters — '))) {
    const line = (await topicText(read, 'starters')).split('\n').find((l) => l.startsWith(STARTERS_JSON_PREFIX));
    if (!line) throw new Error('briefing topic `starters` has no machine-readable line');
    starters = JSON.parse(line.slice(STARTERS_JSON_PREFIX.length)) as SeatSurface['starters'];
  }
  return {
    briefing,
    modes: surface.control,
    opponents: surface.opponents,
    errors: surface.errors,
    eventKinds: surface.eventKinds,
    intents,
    observationSchema: await schemaTopic(read, 'observation'),
    directiveSchema: await schemaTopic(read, 'directive'),
    limitsSchema: await schemaTopic(read, 'limits'),
    reportSchema: await schemaTopic(read, 'report'),
    eventSchema: await schemaTopic(read, 'event'),
    starters,
  };
}
