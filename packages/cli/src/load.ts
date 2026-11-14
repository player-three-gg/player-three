/** Loads a game definition module for the CLI commands. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GameDefinition } from 'playerthree';

/** Import a game module and return its `definition` export (or the named export). */
export async function loadDefinition(modulePath: string, exportName = 'definition'): Promise<GameDefinition> {
  // The module path is supplied by the user at runtime, so this import cannot be static.
  const mod = (await import(pathToFileURL(resolve(modulePath)).href)) as Record<string, unknown>;
  const def = mod[exportName] as GameDefinition | undefined;
  if (!def || typeof def !== 'object' || !def.manifest || typeof def.create !== 'function' || typeof def.createBot !== 'function') {
    throw new Error(`${modulePath} does not export a GameDefinition named \`${exportName}\` ({ manifest, create, createBot })`);
  }
  return def;
}
