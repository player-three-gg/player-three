/**
 * The site's root component, rendered to HTML at build time (`entry-server.ts`) and hydrated in the browser
 * (`entry-client.ts`) from the same props. After hydration, same-site link clicks load the target page's module and
 * swap it in without a reload; anything the registry does not know falls through to a normal page load.
 */
import { createElement as h, useEffect, useState } from 'react';
import { Container, MantineProvider, Text as MantineText, Title, Typography, localStorageColorSchemeManager } from '@mantine/core';
import { ArrowLeft, ArrowRight, ChevronDown, SquarePen } from 'lucide-react';
import { mdxComponents } from './components.ts';
import { neighboursOf, pageFor, type PageEntry, type PageModule } from './content.ts';
import { LANDING_TITLE, Landing } from './landing.ts';
import { API_SOURCE_DIR, REPO_URL, normalizePath } from './routes.ts';
import { MIN_TOC_ENTRIES, Shell, TocLinks } from './shell.ts';
import { COLOR_SCHEME_KEY, cssVariablesResolver, theme } from './theme.ts';

// Fix the root element type so createElement does not infer every polymorphic variant.
const Text = MantineText<'p'>;

export interface RootProps {
  /** Normalized route (`/guides/cli/`); unknown routes render the 404 page. */
  readonly path: string;
  /** The route's loaded markdown module; null for the landing and 404 pages. */
  readonly page: PageModule | null;
}

export function titleFor(path: string, page: PageModule | null): string {
  if (path === '/') return LANDING_TITLE;
  const entry = pageFor(path);
  if (!entry || !page) return 'Page not found · PlayerThree';
  return `${page.title || entry.nav} · PlayerThree`;
}

const colorSchemeManager = localStorageColorSchemeManager({ key: COLOR_SCHEME_KEY });

function NotFound() {
  return h(Container, { size: 'sm', py: 80, className: 'not-found' },
    h(Title, { order: 1 }, 'Page not found'),
    h(Text, { c: 'dimmed', my: 'md' }, 'That page is not on playerthree.gg. Try the search, or start from the docs.'),
    h('p', null, h('a', { href: '/getting-started/' }, 'Getting started'), ' · ', h('a', { href: '/' }, 'Home')));
}

/** Edit link, then previous / next in sidebar order. Outside the article, so search does not index it. */
function PageFooter({ entry }: { entry: PageEntry }) {
  const { previous, next } = neighboursOf(entry.route);
  const generated = entry.source.startsWith(API_SOURCE_DIR);
  return h('div', { className: 'page-footer' },
    generated
      ? h('a', { href: `${REPO_URL}/tree/main/packages`, className: 'edit-link' }, 'Generated from the TSDoc comments in the package sources')
      : h('a', { href: `${REPO_URL}/edit/main/${entry.source}`, className: 'edit-link' }, h(SquarePen, { size: 15, 'aria-hidden': true }), 'Edit this page on GitHub'),
    (previous || next) && h('nav', { className: 'pager', 'aria-label': 'Previous and next page' },
      previous
        ? h('a', { href: previous.route, className: 'pager-link pager-previous', rel: 'prev' },
          h('span', { className: 'pager-dir' }, h(ArrowLeft, { size: 14, 'aria-hidden': true }), 'Previous'),
          h('span', { className: 'pager-title' }, previous.nav))
        : h('span', null),
      next && h('a', { href: next.route, className: 'pager-link pager-next', rel: 'next' },
        h('span', { className: 'pager-dir' }, 'Next', h(ArrowRight, { size: 14, 'aria-hidden': true })),
        h('span', { className: 'pager-title' }, next.nav))));
}

function DocPage({ entry, page }: { entry: PageEntry; page: PageModule }) {
  return h(Container, { size: 920, py: 'xl', className: 'doc' },
    // Narrow screens: the on-this-page rail is hidden (styles.css shows this list below 75em instead).
    page.toc.length >= MIN_TOC_ENTRIES && h('details', { className: 'toc-inline' },
      h('summary', null, 'On this page', h(ChevronDown, { size: 16, className: 'toc-inline-chevron', 'aria-hidden': true })),
      h(TocLinks, { toc: page.toc })),
    h('article', { 'data-pagefind-body': '', 'data-source': entry.source },
      h(Typography, null, h(page.default, { components: mdxComponents }))),
    h(PageFooter, { entry }));
}

function scrollToHash(hash: string): void {
  const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

function App(props: RootProps) {
  const [state, setState] = useState<RootProps>(props);

  useEffect(() => {
    let navigation = 0;
    const go = async (url: URL, push: boolean) => {
      const path = normalizePath(url.pathname);
      const entry = pageFor(path);
      const id = ++navigation;
      const page = entry ? await entry.load() : null;
      // A later click won the race; its own navigation renders.
      if (id !== navigation) return;
      if (push) history.pushState(null, '', `${path}${url.hash}`);
      setState({ path, page });
      document.title = titleFor(path, page);
      requestAnimationFrame(() => scrollToHash(url.hash));
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin) return;
      const path = normalizePath(url.pathname);
      // Same-page anchors scroll natively; unknown paths (search index, assets, 404s) load normally.
      if (path === normalizePath(location.pathname) || (path !== '/' && !pageFor(path))) return;
      event.preventDefault();
      void go(url, true);
    };
    const onPopState = () => void go(new URL(location.href), false);
    document.addEventListener('click', onClick);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  const entry = pageFor(state.path);
  if (state.path === '/') return h(Shell, { path: state.path, toc: [], sidebar: false }, h(Landing, null));
  if (!entry || !state.page) return h(Shell, { path: state.path, toc: [], sidebar: false }, h(NotFound, null));
  return h(Shell, { path: state.path, toc: state.page.toc, sidebar: true }, h(DocPage, { key: state.path, entry, page: state.page }));
}

export function Root(props: RootProps) {
  return h(MantineProvider, { theme, cssVariablesResolver, defaultColorScheme: 'auto', colorSchemeManager }, h(App, props));
}
