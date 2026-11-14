/**
 * The page frame: header (logo, sections, search, colour scheme, GitHub), the docs sidebar, the on-this-page rail
 * and the footer. Every link is a plain `<a href>`, so prerendered pages work without JavaScript; `app.ts` upgrades
 * same-site clicks to client-side navigation.
 */
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { ActionIcon as MantineActionIcon, Anchor as MantineAnchor, AppShell, Burger, Group, NavLink as MantineNavLink, ScrollArea, Stack, Text as MantineText, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Moon, Sun } from 'lucide-react';
// The DevTools header mark (201×64 WebP, 4 KB) rather than the 1600 px README logo.
import logo from '../../packages/playerthree/src/devtools/logo.webp';
// Agent Command's square icon (docs/brand in agent-command/agent-command), 64/128/256 px WebP, light and dark.
import agentCommand64 from './brand/agent-command-64.webp';
import agentCommand128 from './brand/agent-command-128.webp';
import agentCommand256 from './brand/agent-command-256.webp';
import agentCommandDark64 from './brand/agent-command-dark-64.webp';
import agentCommandDark128 from './brand/agent-command-dark-128.webp';
import agentCommandDark256 from './brand/agent-command-dark-256.webp';
import { NAV_GROUPS, type TocEntry } from './content.ts';
import { AGENT_COMMAND_URL, API_ROUTE, DISCORD_URL, REPO_URL } from './routes.ts';
import { Search } from './search.ts';

const ActionIcon = MantineActionIcon<'a'>;
const ThemeIcon = MantineActionIcon<'button'>;
const Anchor = MantineAnchor<'a'>;
const NavLink = MantineNavLink<'a'>;
const Text = MantineText<'p'>;

const SECTIONS = [
  { label: 'Docs', href: '/getting-started/', match: (path: string) => path.startsWith('/getting-started/') || path.startsWith('/guides/') || path.startsWith('/packages/') },
  { label: 'Spec', href: '/spec/', match: (path: string) => path === '/spec/' },
  { label: 'API', href: API_ROUTE, match: (path: string) => path.startsWith(API_ROUTE) },
  { label: 'Changelog', href: '/changelog/', match: (path: string) => path === '/changelog/' },
];

/** The GitHub mark (Octicons `mark-github`); Lucide ships no brand icons. */
export function GithubMark({ size = 18 }: { size?: number }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
    h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' }));
}

/**
 * Agent Command's icon at `size` CSS px, decorative (the name sits next to it). Both variants render and CSS shows the
 * one for the colour scheme, as with the scheme toggle's icons.
 */
export function AgentCommandIcon({ size }: { size: number }) {
  const variant = (className: string, x1: string, x2: string, x4: string) =>
    h('img', { className: `agent-command-icon ${className}`, src: x2, srcSet: `${x1} 64w, ${x2} 128w, ${x4} 256w`, sizes: `${size}px`, width: size, height: size, alt: '', loading: 'lazy', decoding: 'async' });
  return h('span', { className: 'agent-command-icons' },
    variant('icon-light', agentCommand64, agentCommand128, agentCommand256),
    variant('icon-dark', agentCommandDark64, agentCommandDark128, agentCommandDark256));
}

function ColorSchemeToggle() {
  const { toggleColorScheme } = useMantineColorScheme();
  // Both icons render; CSS shows the one for the scheme the pre-paint script chose, so hydration never mismatches.
  return h(ThemeIcon, { variant: 'default', size: 'lg', onClick: toggleColorScheme, 'aria-label': 'Toggle colour scheme' },
    h(Sun, { size: 18, className: 'icon-light' }), h(Moon, { size: 18, className: 'icon-dark' }));
}

function Sidebar({ path }: { path: string }) {
  return h(ScrollArea, { type: 'auto', className: 'sidebar' },
    ...NAV_GROUPS.map((group) => {
      const links = group.pages.map((page) => h(NavLink, { key: page.route, component: 'a', href: page.route, label: page.nav, active: page.route === path, className: 'nav-link' }));
      if (group.label === 'API') {
        return h(NavLink, { key: group.label, label: 'API reference', defaultOpened: path.startsWith(API_ROUTE), childrenOffset: 'sm', className: 'nav-group-toggle' }, ...links);
      }
      return h('div', { key: group.label, className: 'nav-group' }, h(Text, { className: 'nav-group-label' }, group.label), ...links);
    }));
}

/** Below the header (64 px) plus a little: the heading at or above this line is the one being read. */
const READING_LINE = 96;

/** The TOC entry whose section is on screen, tracked on scroll; undefined until the page has hydrated. */
function useActiveHeading(toc: readonly TocEntry[]): string | undefined {
  const [active, setActive] = useState<string>();
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let current = toc[0]?.id;
      for (const entry of toc) {
        const top = document.getElementById(entry.id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= READING_LINE) current = entry.id;
      }
      // The last sections may be too short to reach the reading line.
      setActive(atBottom ? toc.at(-1)?.id : current);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [toc]);
  return active;
}

/** The page's `h2`/`h3` links: the desktop rail here and the collapsible list at the top of narrow pages (`app.ts`). */
export function TocLinks({ toc, active }: { toc: readonly TocEntry[]; active?: string | undefined }) {
  return h('nav', { 'aria-label': 'On this page', className: 'toc-links' },
    ...toc.map((entry) => h('a', {
      key: entry.id,
      href: `#${entry.id}`,
      className: `${entry.depth === 3 ? 'toc-link toc-sub' : 'toc-link'}${entry.id === active ? ' active' : ''}`,
      'aria-current': entry.id === active ? 'location' : undefined,
    }, entry.text)));
}

function Toc({ toc }: { toc: readonly TocEntry[] }) {
  const active = useActiveHeading(toc);
  return h(ScrollArea, { type: 'auto', className: 'toc' },
    h(Text, { className: 'nav-group-label' }, 'On this page'),
    h(TocLinks, { toc, active }));
}

function Footer() {
  return h('footer', { className: 'site-footer' },
    h(Group, { gap: 'md', justify: 'space-between', className: 'footer-row' },
      h(Text, { size: 'sm', c: 'dimmed' }, 'PlayerThree · Apache-2.0 · The PlayerThree and Agent Command names and logos are trademarks.'),
      h(Group, { gap: 'md' },
        h(Anchor, { href: REPO_URL, size: 'sm' }, 'GitHub'),
        h(Anchor, { href: DISCORD_URL, size: 'sm' }, 'Discord'),
        h(Anchor, { href: AGENT_COMMAND_URL, size: 'sm', className: 'footer-agent-command' }, h(AgentCommandIcon, { size: 16 }), 'Agent Command'))),
    h(Text, { size: 'xs', c: 'dimmed', className: 'trademark-note' },
      'Other names and logos are trademarks of their owners and do not imply endorsement. This site is not sponsored by or affiliated with Unity Technologies or Epic Games. Unity is a trademark or registered trademark of Unity Technologies or its affiliates in the U.S. and elsewhere. Unreal and Unreal Engine are trademarks or registered trademarks of Epic Games, Inc. in the U.S. and elsewhere. Godot logo by Andrea Calabró, CC BY 4.0. Logos from Simple Icons.'));
}

export interface ShellProps {
  readonly path: string;
  readonly toc: readonly TocEntry[];
  /** Docs pages get the sidebar; the landing and 404 pages do not. */
  readonly sidebar: boolean;
  readonly children?: ReactNode;
}

/** Pages with at least this many headings get the on-this-page rail (and, when narrow, the collapsible list). */
export const MIN_TOC_ENTRIES = 2;

export function Shell({ path, toc, sidebar, children }: ShellProps) {
  const [opened, { toggle, close }] = useDisclosure(false);
  // A navigation closes the mobile drawer it started from.
  useEffect(close, [path]);
  const showToc = toc.length >= MIN_TOC_ENTRIES;
  return h(AppShell, {
    header: { height: 64 },
    navbar: sidebar ? { width: 280, breakpoint: 'md', collapsed: { mobile: !opened } } : undefined,
    // The rail needs 1200 px (lg) next to the sidebar; narrower pages show the list above the article instead.
    aside: showToc ? { width: 240, breakpoint: 'lg', collapsed: { desktop: false, mobile: true } } : undefined,
    padding: 0,
  },
  h(AppShell.Header, { className: 'site-header' },
    h(Group, { h: '100%', px: 'md', justify: 'space-between', wrap: 'nowrap' },
      h(Group, { gap: 'sm', wrap: 'nowrap' },
        sidebar && h(Burger, { opened, onClick: toggle, hiddenFrom: 'md', size: 'sm', 'aria-label': 'Toggle navigation' }),
        h('a', { href: '/', className: 'brand', 'aria-label': 'PlayerThree home' }, h('img', { src: logo, alt: 'PlayerThree', width: 201, height: 64, className: 'brand-logo' })),
        h('nav', { className: 'sections', 'aria-label': 'Sections' },
          ...SECTIONS.map((section) => h('a', { key: section.label, href: section.href, className: section.match(path) ? 'section-link active' : 'section-link' }, section.label)))),
      h(Group, { gap: 'xs', wrap: 'nowrap' },
        h(Search, null),
        h(ColorSchemeToggle, null),
        h(ActionIcon, { component: 'a', href: REPO_URL, variant: 'default', size: 'lg', 'aria-label': 'PlayerThree on GitHub' }, h(GithubMark, null))))),
  sidebar && h(AppShell.Navbar, { p: 'sm' }, h(Sidebar, { path })),
  showToc && h(AppShell.Aside, { p: 'md' }, h(Toc, { toc })),
  h(AppShell.Main, null,
    h(Stack, { gap: 0, className: sidebar ? 'page page-doc' : 'page' }, children, h(Footer, null))));
}
