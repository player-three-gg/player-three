/**
 * Generates the API reference: TypeDoc + typedoc-plugin-markdown over every package's public `exports`, one markdown
 * page per entry point under `site/generated/api/`, rendered by the same pipeline as the docs.
 *
 * TypeDoc 0.28 drives the TypeScript 5–6 compiler API, while the workspace pins TypeScript 7 (native, no JS API). The
 * site depends on `typescript-for-typedoc` (an npm alias of TypeScript 6) and routes TypeDoc's `typescript` imports to
 * it; nothing else sees that compiler.
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DeclarationReflection } from 'typedoc';

const site = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(site, '..');
export const API_OUT = join(site, 'generated', 'api');

interface PackageJson {
  name: string;
  private?: boolean;
  exports?: Record<string, string>;
}

/** Each public entry point: `playerthree/host` → `packages/playerthree/src/host/index.ts`. */
export function entryPoints(): Map<string, string> {
  const entries = new Map<string, string>();
  const packages = join(repo, 'packages');
  for (const dir of readdirSync(packages).sort()) {
    const pkg = JSON.parse(readFileSync(join(packages, dir, 'package.json'), 'utf8')) as PackageJson;
    for (const [subpath, file] of Object.entries(pkg.exports ?? {})) {
      entries.set(subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`, resolve(packages, dir, file));
    }
  }
  return entries;
}

function routeTypeScriptToV6(): void {
  const v6 = dirname(fileURLToPath(import.meta.resolve('typescript-for-typedoc/package.json')));
  const file = (path: string) => ({ url: pathToFileURL(join(v6, path)).href, shortCircuit: true });
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'typescript') return file('lib/typescript.js');
      if (specifier.startsWith('typescript/')) return file(specifier.slice('typescript/'.length));
      return next(specifier, context);
    },
  });
}

/** The text of a file's leading `/** … *\/` header, which TypeDoc only treats as the module comment with an `@module` tag. */
function headerComment(file: string): string | undefined {
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(readFileSync(file, 'utf8'));
  return match?.[1]?.split('\n').map((line) => line.replace(/^\s*\* ?/, '')).join('\n').trim() || undefined;
}

export async function generateApi(): Promise<void> {
  routeTypeScriptToV6();
  // Imported after the hook so TypeDoc binds to TypeScript 6.
  const { Application, Comment, ReflectionKind } = await import('typedoc');
  const entries = entryPoints();
  const names = new Map([...entries].map(([name, file]) => [file, name]));
  rmSync(API_OUT, { recursive: true, force: true });
  const app = await Application.bootstrapWithPlugins({
    name: 'PlayerThree API',
    entryPoints: [...entries.values()],
    entryPointStrategy: 'resolve',
    tsconfig: join(site, 'tsconfig.api.json'),
    plugin: ['typedoc-plugin-markdown'],
    out: API_OUT,
    readme: 'none',
    skipErrorChecking: true,
    excludePrivate: true,
    excludeInternal: true,
    excludeExternals: true,
    // Link every declaration to GitHub without asking git (worktrees and CI checkouts differ); {path} is relative to basePath.
    disableGit: true,
    basePath: repo,
    sourceLinkTemplate: 'https://github.com/player-three-gg/player-three/blob/main/{path}#L{line}',
    validation: { notExported: false, invalidLink: true, notDocumented: false },
    logLevel: 'Warn',
    // typedoc-plugin-markdown
    outputFileStrategy: 'modules',
    entryFileName: 'index',
    fileExtension: '.md',
    hideBreadcrumbs: true,
    hidePageHeader: true,
    useCodeBlocks: true,
    parametersFormat: 'table',
    interfacePropertiesFormat: 'table',
    classPropertiesFormat: 'table',
    typeDeclarationFormat: 'table',
    sanitizeComments: true,
  } as Record<string, unknown>);
  // Name each module by its import specifier (`playerthree/host`), not its file path, and describe it with its header.
  app.converter.on('resolveBegin', (context) => {
    for (const module of context.project.getReflectionsByKind(ReflectionKind.Module) as DeclarationReflection[]) {
      const file = module.sources?.[0]?.fullFileName;
      const name = file ? names.get(resolve(file)) : undefined;
      if (!file || !name) continue;
      module.name = name;
      const header = module.comment ? undefined : headerComment(file);
      if (header) module.comment = new Comment([{ kind: 'text', text: header }]);
    }
  });
  const project = await app.convert();
  if (!project) throw new Error('TypeDoc could not convert the packages');
  await app.generateOutputs(project);
  if (app.logger.hasErrors()) throw new Error('TypeDoc reported errors');
  console.log(`api: ${entries.size} entry points → ${relative(repo, API_OUT)}`);
}

if (import.meta.main) await generateApi();
