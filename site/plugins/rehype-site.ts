/**
 * Build-time rehype plugins that turn repository markdown into site pages.
 *
 * The docs stay plain GitHub markdown with repository-relative links, so they read the same on GitHub and here:
 * `rehypeRepoLinks` maps each relative link to the page that renders its target (or to the file on GitHub) and marks
 * links that leave the site, `rehypeAlerts` turns GitHub alerts (`> [!NOTE]`) into callouts, and `rehypeExportMeta`
 * exports the page title and table of contents for the shell. A link to a missing file fails the build; anchors are
 * checked after prerendering by `scripts/check-links.ts`.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { Element, Root, RootContent } from 'hast';
import { toString } from 'hast-util-to-string';
import { valueToEstree } from 'estree-util-value-to-estree';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import { REPO_URL, SITE_URL, routeForSource } from '../src/routes.ts';

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Images referenced by docs are copied from the repository into `dist/repo/` by `scripts/build.ts`. */
export const REPO_ASSET_PREFIX = '/repo/';

function siteUrl(url: string, file: VFile, repoRoot: string, asset: boolean): string | undefined {
  if (EXTERNAL.test(url)) return undefined;
  const hashAt = url.indexOf('#');
  const path = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const target = resolve(dirname(file.path), decodeURI(path));
  const rel = relative(repoRoot, target).split(sep).join('/');
  if (rel.startsWith('..')) throw new Error(`${file.path}: link leaves the repository: ${url}`);
  if (!existsSync(target)) throw new Error(`${file.path}: broken link to a missing file: ${url}`);
  if (asset) return `${REPO_ASSET_PREFIX}${rel}`;
  const directory = statSync(target).isDirectory();
  const route = routeForSource(rel) ?? (directory ? routeForSource(`${rel}/README.md`) : undefined);
  if (route) return `${route}${hash}`;
  return `${REPO_URL}/${directory ? 'tree' : 'blob'}/main/${rel}${hash}`;
}

/** Links that leave playerthree.gg (other than image links) get `.external-link`, which `styles.css` marks with ↗. */
export function rehypeRepoLinks({ repoRoot }: { repoRoot: string }) {
  return (tree: Root, file: VFile): void => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'a' && typeof node.properties.href === 'string') {
        const href = siteUrl(node.properties.href, file, repoRoot, false) ?? node.properties.href;
        node.properties.href = href;
        const image = node.children.some((child) => child.type === 'element' && child.tagName === 'img');
        if (/^https?:\/\//.test(href) && !href.startsWith(SITE_URL) && !image) {
          node.properties.className = [...(Array.isArray(node.properties.className) ? node.properties.className : []), 'external-link'];
        }
      } else if (node.tagName === 'img' && typeof node.properties.src === 'string') {
        const src = siteUrl(node.properties.src, file, repoRoot, true);
        if (src !== undefined) node.properties.src = src;
      }
    });
  };
}

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

/**
 * GitHub alerts: a blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`
 * loses the marker and gains `data-alert="note"` (…), which `src/components.ts` renders as a callout.
 */
export function rehypeAlerts() {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'blockquote') return;
      const first = node.children.find((child): child is Element => child.type === 'element');
      const head = first?.tagName === 'p' ? first.children[0] : undefined;
      const match = head?.type === 'text' ? ALERT.exec(head.value) : null;
      if (!first || head?.type !== 'text' || !match) return;
      head.value = head.value.slice(match[0].length);
      if (!head.value) first.children.shift();
      if (!first.children.length) node.children.splice(node.children.indexOf(first), 1);
      node.properties.dataAlert = (match[1] ?? 'note').toLowerCase();
    });
  };
}

export interface TocEntry {
  readonly depth: number;
  readonly id: string;
  readonly text: string;
}

/**
 * Adds `export const title` (the first `h1`) and `export const toc` (every `h2`/`h3` with an id) to the compiled page.
 * Runs after `rehype-slug` and before heading anchors are appended, so the text is the heading's own.
 */
export function rehypeExportMeta() {
  return (tree: Root): void => {
    let title = '';
    const toc: TocEntry[] = [];
    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'h1' && !title) title = toString(node).trim();
      if ((node.tagName === 'h2' || node.tagName === 'h3') && typeof node.properties.id === 'string') {
        toc.push({ depth: node.tagName === 'h2' ? 2 : 3, id: node.properties.id, text: toString(node).trim() });
      }
    });
    const declaration = (name: string, value: unknown) => ({ type: 'VariableDeclarator', id: { type: 'Identifier', name }, init: valueToEstree(value) });
    const esm = {
      type: 'mdxjsEsm',
      value: '',
      data: {
        estree: {
          type: 'Program',
          sourceType: 'module',
          body: [{
            type: 'ExportNamedDeclaration',
            specifiers: [],
            source: null,
            attributes: [],
            declaration: { type: 'VariableDeclaration', kind: 'const', declarations: [declaration('title', title), declaration('toc', toc)] },
          }],
        },
      },
    };
    tree.children.unshift(esm as unknown as RootContent);
  };
}
