/**
 * The tool-surface budget (spec §4): toolSurface, and with it every host, surface hash and MCP mount, refuses a game
 * whose tool list would exceed the per-tool or model-facing limits that every model turn carries.
 */
import { describe, expect, it } from 'vitest';
import { definition, manifest } from '../examples/tag/index.ts';
import { servedSkills, surfaceHash } from '../src/briefing.ts';
import { createPlayerThreeHost } from '../src/host/index.ts';
import { defineManifest, type AnyManifest, type GameDefinition } from '../src/manifest.ts';
import {
  checkSurfaceBudget,
  toolSurface,
  TOOL_DESCRIPTION_MAX,
  TOOL_INPUT_SCHEMA_MAX,
  TOOL_OUTPUT_SCHEMA_MAX,
  TOOL_SURFACE_MAX,
  type ToolSpec,
} from '../src/mcp/surface.ts';
import { t } from '../src/schema.ts';

/** Tag plus twelve intent kinds with docs at the 4000-unit limit: game_act carries every one. */
const wide = defineManifest({
  ...manifest,
  intents: { ...manifest.intents, ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`order${i}`, { roles: ['runner'], params: {}, doc: 'x'.repeat(4_000) }])) },
} as AnyManifest);

describe('tool-surface budget', () => {
  it('admits the tag example within every limit', () => {
    const tools = toolSurface(manifest, servedSkills(manifest));
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX);
      expect(JSON.stringify(tool.inputSchema).length, tool.name).toBeLessThanOrEqual(TOOL_INPUT_SCHEMA_MAX);
      expect(JSON.stringify(tool.outputSchema).length, tool.name).toBeLessThanOrEqual(TOOL_OUTPUT_SCHEMA_MAX);
    }
  });

  it('refuses a game over a per-tool limit, naming the tool, the measure, the size and the limit', () => {
    const inputOver = /^playerthree\/surface: game_act inputSchema is \d+ code units, over the limit of 48000$/;
    expect(() => toolSurface(wide, servedSkills(wide))).toThrow(inputOver);
    // Hashing the surface, building a host and so mounting MCP all go through it.
    expect(() => surfaceHash(wide)).toThrow(inputOver);
    expect(() => createPlayerThreeHost({ definition: { ...definition, manifest: wide } as unknown as GameDefinition })).toThrow(inputOver);

    // Forty long tier names: practice_run lists them in its description.
    const opponents = Array.from({ length: 40 }, (_, i) => `opponent_tier_${String(i).padStart(2, '0')}_${'x'.repeat(20)}`) as [string, ...string[]];
    const tiers = defineManifest({ ...manifest, opponents: t.enum(opponents) } as AnyManifest);
    expect(() => toolSurface(tiers, servedSkills(tiers))).toThrow(/^playerthree\/surface: practice_run description is \d+ code units, over the limit of 1500$/);
  });

  it('refuses a surface whose name + description + inputSchema total exceeds the model-facing limit', () => {
    const tool = (name: string, size: number): ToolSpec => ({
      name, method: 'usage', title: name, description: 'd',
      inputSchema: { type: 'object', description: 'x'.repeat(size) }, outputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    });
    // Each within TOOL_INPUT_SCHEMA_MAX, together over TOOL_SURFACE_MAX.
    const tools = [tool('a', 40_000), tool('b', 40_000), tool('c', 40_000)];
    expect(() => checkSurfaceBudget(tools)).toThrow(/^playerthree\/surface: all tools' name \+ description \+ inputSchema is 120\d{3} code units, over the limit of 120000$/);
    expect(() => checkSurfaceBudget(tools.slice(0, 2))).not.toThrow();
    expect(TOOL_SURFACE_MAX).toBe(120_000);
  });
});
