/**
 * The PlayerThree brand as a Mantine theme, sampled from `docs/brand` and the README plates: the logo's violet → blue →
 * cyan ring on deep navy, Poppins for headings (the wordmark's heavy geometric sans), Bangers and Special Elite for the
 * plate-style display lines. Both colour schemes share it; `styles.css` holds the few page-level rules.
 */
import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';

/** Logo violet `#762afa` at index 6. */
const brand: MantineColorsTuple = ['#f3ecff', '#e2d4ff', '#c3a6ff', '#a376ff', '#884dfd', '#7a35fb', '#762afa', '#6420de', '#561bc4', '#4613a1'];
/** Logo cyan `#00dafa` at index 5. */
const cyan: MantineColorsTuple = ['#e0fbff', '#c4f3fd', '#8ee8fb', '#52ddf9', '#24d4f8', '#00dafa', '#00b6da', '#00a2c3', '#008ca9', '#007893'];
/** Dark surfaces from the mark's navy `#0d0a1f` (index 7 is the dark body). */
const dark: MantineColorsTuple = ['#d5d3e6', '#b2afcc', '#8e8aae', '#6a6690', '#4b4772', '#363259', '#1c1835', '#0d0a1f', '#090716', '#05040d'];

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 4 },
  colors: { brand, cyan, dark },
  black: '#0d0a1f',
  defaultGradient: { from: 'brand.6', to: 'cyan.5', deg: 100 },
  defaultRadius: 'md',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
  headings: { fontFamily: 'Poppins, system-ui, sans-serif', fontWeight: '700' },
  cursorType: 'pointer',
});

/** Links in dark mode use brand 3 (6.1:1 on the navy body); the dark primary, brand 4, is only 4.2:1. */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {},
  dark: { '--mantine-color-anchor': 'var(--mantine-color-brand-3)' },
});

/** `localStorage` key shared by the pre-paint script and the provider. */
export const COLOR_SCHEME_KEY = 'playerthree-color-scheme';
