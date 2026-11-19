/**
 * Code fences, highlighted once at build time; the browser never runs a highlighter.
 *
 * - `remarkCodeFences` fails the build on a fence with no language or one Shiki does not load here (directory trees
 *   and console output are fenced `text`), and passes the fence's meta string through `rehype-raw` to Shiki.
 * - `SHIKI_OPTIONS` (for `@shikijs/rehype`) loads the languages, applies the `p3-light` / `p3-dark` themes and the
 *   notation transformers: `// [!code highlight]`, `// [!code ++]`, `// [!code --]` and `{1,3-4}` in the meta. Its
 *   transformer stamps each `pre` with `data-language`, `data-label` (the badge), and the meta's `title="…"` and
 *   `tab="…"`, which `src/components.ts` renders as the block header.
 * - `rehypeCodeGroups` wraps consecutive fences that carry `tab="…"` in one `div[data-code-group]`, rendered as tabs.
 *
 * On GitHub the meta is ignored, so a code group reads as consecutive blocks there.
 */
import type { Element, ElementContent, Root } from 'hast';
import type { Code, Root as MdastRoot } from 'mdast';
import { bundledLanguagesInfo, type ShikiTransformer } from 'shiki';
import { transformerMetaHighlight, transformerNotationDiff, transformerNotationHighlight } from '@shikijs/transformers';
import type { RehypeShikiOptions } from '@shikijs/rehype';
import { SKIP, visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import { P3_DARK, P3_LIGHT } from './shiki-themes.ts';

/** Shiki language ids the docs may fence; each one's own aliases (`sh`, `ts`, `c#`, `gd`…) come with it. */
const LANGUAGES = [
  'typescript', 'tsx', 'javascript', 'jsx', 'json', 'jsonc', 'yaml', 'toml', 'ini', 'shellscript', 'powershell', 'http',
  'diff', 'sql', 'rust', 'gdscript', 'csharp', 'cpp', 'c', 'cmake', 'wasm',
] as const;

/** Extra fence names. Shiki calls the WebAssembly text format `wasm`; the docs fence it as `wat`. */
const LANG_ALIAS: Record<string, string> = { wat: 'wasm' };

/** Badge text where Shiki's display name is not what the fence holds. */
const LABELS: Record<string, string> = { shellscript: 'Shell', wasm: 'WAT' };

const INFO = new Map(bundledLanguagesInfo.map((info) => [info.id, info]));

/** Fence name → Shiki language id, for every name a fence may use; `text` is plain and gets no badge. */
const FENCE_LANGUAGES = new Map<string, string>([['text', 'text']]);
for (const id of LANGUAGES) {
  const info = INFO.get(id);
  if (!info) throw new Error(`code: Shiki has no bundled language ${id}`);
  for (const name of [id, ...(info.aliases ?? [])]) FENCE_LANGUAGES.set(name, id);
}
for (const [alias, id] of Object.entries(LANG_ALIAS)) FENCE_LANGUAGES.set(alias, id);

const FENCE_HINT = 'Fence it with a language; directory trees and console output are `text`.';

/** Fails on a missing or unknown fence language; copies the meta onto `code` so it survives `rehype-raw`. */
export function remarkCodeFences() {
  return (tree: MdastRoot, file: VFile): void => {
    visit(tree, 'code', (node: Code) => {
      const where = `${file.path}:${node.position?.start.line ?? '?'}`;
      if (!node.lang) throw new Error(`${where}: code fence has no language. ${FENCE_HINT}`);
      if (!FENCE_LANGUAGES.has(node.lang)) {
        throw new Error(`${where}: unknown code fence language "${node.lang}". Known: ${[...FENCE_LANGUAGES.keys()].sort().join(', ')}. Add it to LANGUAGES in site/plugins/code.ts if Shiki bundles it.`);
      }
      // `@shikijs/rehype` reads the meta from `code.data.meta`, which `rehype-raw` drops, or from this property.
      if (node.meta) node.data = { ...node.data, hProperties: { ...node.data?.hProperties, metastring: node.meta } };
    });
  };
}

/** `key="value"` pairs from a fence's meta string. */
function parseMeta(meta: string): Record<string, string> {
  return Object.fromEntries([...meta.matchAll(/([a-z]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

const codeMeta: ShikiTransformer = {
  name: 'playerthree:code-meta',
  pre(node) {
    const id = FENCE_LANGUAGES.get(this.options.lang) ?? 'text';
    const meta = this.options.meta ?? {};
    node.properties.dataLanguage = id;
    if (id !== 'text') node.properties.dataLabel = LABELS[id] ?? INFO.get(id)?.name ?? id;
    if (typeof meta.title === 'string') node.properties.dataTitle = meta.title;
    if (typeof meta.tab === 'string') node.properties.dataTab = meta.tab;
    // Shiki copies parsed meta onto `pre` as attributes; a `title` would become a hover tooltip over the whole block.
    delete node.properties.title;
    delete node.properties.tab;
  },
};

export const SHIKI_OPTIONS: RehypeShikiOptions = {
  themes: { light: P3_LIGHT, dark: P3_DARK },
  langs: [...LANGUAGES],
  langAlias: LANG_ALIAS,
  parseMetaString: parseMeta,
  transformers: [transformerNotationHighlight(), transformerNotationDiff(), transformerMetaHighlight(), codeMeta],
};

const isPre = (node: ElementContent): node is Element => node.type === 'element' && node.tagName === 'pre';

/** Wraps each run of adjacent `pre[data-tab]` siblings in `div[data-code-group]`; tab names must differ within a run. */
export function rehypeCodeGroups() {
  return (tree: Root, file: VFile): void => {
    visit(tree, (node) => {
      if (node.type !== 'root' && node.type !== 'element') return;
      // A group's own fences are already grouped.
      if (node.type === 'element' && node.properties.dataCodeGroup !== undefined) return SKIP;
      // `@shikijs/rehype` replaces each `pre` with a root fragment; inline those so fences are siblings again.
      const children = (node.children as (ElementContent | Root)[]).flatMap((child) => (child.type === 'root' ? child.children : [child])) as ElementContent[];
      const out: ElementContent[] = [];
      const groups: Element[][] = [];
      let group: Element[] | undefined;
      // Whitespace between two tabbed fences belongs to neither; it is kept only when the run ends.
      let blanks: ElementContent[] = [];
      for (const child of children) {
        if (isPre(child) && typeof child.properties.dataTab === 'string') {
          if (!group) {
            group = [];
            groups.push(group);
            out.push({ type: 'element', tagName: 'div', properties: { dataCodeGroup: '' }, children: group });
          }
          group.push(child);
          blanks = [];
        } else if (group && child.type === 'text' && !child.value.trim()) {
          blanks.push(child);
        } else {
          out.push(...blanks, child);
          blanks = [];
          group = undefined;
        }
      }
      out.push(...blanks);
      for (const tabs of groups.map((pres) => pres.map((pre) => pre.properties.dataTab as string))) {
        const duplicate = tabs.find((tab, at) => tabs.indexOf(tab) !== at);
        if (duplicate) throw new Error(`${file.path}: code group has two tabs named "${duplicate}"`);
      }
      node.children = out as typeof node.children;
    });
  };
}
