/**
 * The page registry: every route, its lazily loaded markdown module and its sidebar entry.
 *
 * Markdown is compiled at build time (see `vite.config.ts`); each module exports the page component plus the `title`
 * and `toc` that `plugins/rehype-site.ts` extracts. Pages load on demand, so the 190 KB spec only ships to `/spec/`.
 */
import type { ComponentType } from 'react';
import type { TocEntry } from '../plugins/rehype-site.ts';
import { API_ROUTE, API_SOURCE_DIR, DOC_PAGES, apiRoute, type NavGroup } from './routes.ts';

export type { TocEntry };

export type MdxComponents = Record<string, ComponentType<never>>;

export interface PageModule {
  readonly default: ComponentType<{ components?: MdxComponents }>;
  readonly title: string;
  readonly toc: readonly TocEntry[];
}

export interface PageEntry {
  readonly route: string;
  readonly source: string;
  readonly nav: string;
  readonly group: NavGroup | 'API';
  readonly description: string;
  readonly load: () => Promise<PageModule>;
}

const DOCS = import.meta.glob<PageModule>([
  '../../docs/*.md',
  '../../spec/SPEC.md',
  '../../CHANGELOG.md',
  '../../packages/colyseus/README.md',
  '../../packages/console/README.md',
  '../../packages/sidecar/README.md',
  '../../sdks/*/README.md',
  '../content/*.md',
]);
const API = import.meta.glob<PageModule>('../generated/api/**/*.md');

/** Glob keys are relative to this file; sources are relative to the repository root. */
function sourceOf(key: string): string {
  if (key.startsWith('../../')) return key.slice('../../'.length);
  return `site/${key.slice('../'.length)}`;
}

const loaders = new Map(Object.entries({ ...DOCS, ...API }).map(([key, load]) => [sourceOf(key), load]));

function loader(source: string): () => Promise<PageModule> {
  const load = loaders.get(source);
  if (!load) throw new Error(`No markdown module for ${source}`);
  return load;
}

const docEntries: PageEntry[] = DOC_PAGES.map((page) => ({ ...page, load: loader(page.source) }));

/** `index` first, then `playerthree` before the companion `@playerthree/*` packages, alphabetical within each. */
const apiEntries: PageEntry[] = [...loaders.keys()]
  .filter((source) => source.startsWith(API_SOURCE_DIR))
  .map((source) => {
    const name = source.slice(API_SOURCE_DIR.length).replace(/\.md$/, '');
    const route = apiRoute(source);
    return { route, source, nav: name === 'index' ? 'Overview' : name, group: 'API' as const, description: name === 'index' ? 'API reference for every PlayerThree package entry point.' : `API reference for ${name}.`, load: loader(source) };
  })
  .sort((a, b) => {
    const rank = (entry: PageEntry) => (entry.route === API_ROUTE ? 0 : entry.nav.startsWith('@') ? 2 : 1);
    return rank(a) - rank(b) || a.nav.localeCompare(b.nav);
  });

export const PAGES: readonly PageEntry[] = [...docEntries, ...apiEntries];

const BY_ROUTE = new Map(PAGES.map((page) => [page.route, page]));

export function pageFor(route: string): PageEntry | undefined {
  return BY_ROUTE.get(route);
}

export const NAV_GROUPS: readonly { readonly label: NavGroup | 'API'; readonly pages: readonly PageEntry[] }[] = (['Start', 'Guides', 'Game engines', 'Packages', 'Reference', 'API'] as const).map((label) => ({ label, pages: PAGES.filter((page) => page.group === label) }));

/** Sidebar order, which the previous / next links at the foot of each page follow. */
const READING_ORDER = NAV_GROUPS.flatMap((group) => group.pages);

export function neighboursOf(route: string): { readonly previous: PageEntry | undefined; readonly next: PageEntry | undefined } {
  const at = READING_ORDER.findIndex((page) => page.route === route);
  return at < 0 ? { previous: undefined, next: undefined } : { previous: READING_ORDER[at - 1], next: READING_ORDER[at + 1] };
}
