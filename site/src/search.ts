/**
 * Site search over the Pagefind index that `scripts/build.ts` writes into `dist/pagefind/` after prerendering.
 * The index exists only in a build, so `pnpm dev` shows a hint instead of results.
 */
import { createElement as h, useEffect, useState } from 'react';
import { Button as MantineButton, Kbd, Modal, Stack, Text as MantineText, TextInput, UnstyledButton as MantineUnstyledButton } from '@mantine/core';
import { useDisclosure, useHotkeys } from '@mantine/hooks';
import { Search as SearchIcon } from 'lucide-react';

const Button = MantineButton<'button'>;
const UnstyledButton = MantineUnstyledButton<'a'>;
const Text = MantineText<'p'>;
/** Mantine's Modal focuses the element carrying this attribute when it opens. */
const AUTOFOCUS = { 'data-autofocus': true };

interface PagefindHit {
  readonly url: string;
  readonly excerpt: string;
  readonly meta: { readonly title?: string };
  readonly sub_results?: readonly { readonly title: string; readonly url: string; readonly excerpt: string }[];
}

interface Pagefind {
  init(): Promise<void>;
  debouncedSearch(query: string, options?: object, debounceMs?: number): Promise<{ results: { data(): Promise<PagefindHit> }[] } | null>;
}

let pagefind: Promise<Pagefind | null> | undefined;

function loadPagefind(): Promise<Pagefind | null> {
  // Generated after the bundle is built, so it cannot be a static import; Vite must leave the specifier alone.
  const url = '/pagefind/pagefind.js';
  pagefind ??= import(/* @vite-ignore */ url).then(async (module: Pagefind) => {
    await module.init();
    return module;
  }, () => null);
  return pagefind;
}

const MAX_RESULTS = 8;

export function Search() {
  const [opened, { open, close }] = useDisclosure(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly PagefindHit[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useHotkeys([['mod+K', open], ['/', open]]);

  useEffect(() => {
    if (!opened || !query.trim()) {
      setHits(null);
      return;
    }
    let current = true;
    void loadPagefind().then(async (index) => {
      if (!index) {
        if (current) setUnavailable(true);
        return;
      }
      const search = await index.debouncedSearch(query, {}, 150);
      // null: a newer query superseded this one.
      if (!search || !current) return;
      const data = await Promise.all(search.results.slice(0, MAX_RESULTS).map((result) => result.data()));
      if (current) setHits(data);
    });
    return () => {
      current = false;
    };
  }, [opened, query]);

  return h('div', null,
    h(Button, { variant: 'default', size: 'sm', onClick: open, leftSection: h(SearchIcon, { size: 16 }), rightSection: h(Kbd, { size: 'xs' }, '/'), className: 'search-button', 'aria-label': 'Search the docs' },
      h('span', { className: 'search-label' }, 'Search')),
    h(Modal, { opened, onClose: close, title: 'Search playerthree.gg', size: 'lg', trapFocus: true },
      h(TextInput, { ...AUTOFOCUS, value: query, onChange: (event) => setQuery(event.currentTarget.value), placeholder: 'game_wait, policy limits, commander log…', leftSection: h(SearchIcon, { size: 16 }), 'aria-label': 'Search query' }),
      unavailable
        ? h(Text, { mt: 'md', c: 'dimmed', size: 'sm' }, 'Search works in a built site: run pnpm site:build, then pnpm --filter @playerthree/site preview.')
        : hits && hits.length === 0
          ? h(Text, { mt: 'md', c: 'dimmed', size: 'sm' }, 'No results.')
          : h(Stack, { gap: 'xs', mt: 'md' }, ...(hits ?? []).map((hit) =>
            h(UnstyledButton, { key: hit.url, component: 'a', href: hit.url, onClick: close, className: 'search-hit' },
              h(Text, { fw: 600, size: 'sm' }, hit.meta.title ?? hit.url),
              // Pagefind excerpts are this site's own page text, HTML-escaped, with only <mark> added around matches.
              h(Text, { size: 'xs', c: 'dimmed', dangerouslySetInnerHTML: { __html: hit.excerpt } }))))));
}
