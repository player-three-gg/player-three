/**
 * Build-time entry (Vite SSR bundle): renders each route to the HTML `scripts/build.ts` writes as `<route>index.html`.
 * The browser hydrates the same `Root` from the same route, so pages read fully without JavaScript.
 */
import { createElement as h } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { ColorSchemeScript } from '@mantine/core';
import { Root, titleFor } from './app.ts';
import { PAGES, pageFor } from './content.ts';
import { LANDING_DESCRIPTION } from './landing.ts';
import { COLOR_SCHEME_KEY } from './theme.ts';

/** Every route the site prerenders; `/404/` stands for any unknown path and is written as `404.html`. */
export const ROUTES: readonly string[] = ['/', ...PAGES.map((page) => page.route)];
export const NOT_FOUND_ROUTE = '/404/';

export interface RenderedPage {
  readonly html: string;
  readonly title: string;
  readonly description: string;
}

export async function render(path: string): Promise<RenderedPage> {
  const entry = pageFor(path);
  const page = entry ? await entry.load() : null;
  return {
    html: renderToString(h(Root, { path, page })),
    title: titleFor(path, page),
    description: entry?.description ?? LANDING_DESCRIPTION,
  };
}

/** Sets `data-mantine-color-scheme` from the saved choice before first paint, so dark mode never flashes light. */
export function colorSchemeScript(): string {
  return renderToStaticMarkup(h(ColorSchemeScript, { defaultColorScheme: 'auto', localStorageKey: COLOR_SCHEME_KEY }));
}
