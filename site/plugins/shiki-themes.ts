/**
 * The code themes, `p3-light` and `p3-dark`: GitHub's scope rules (the bundled `github-light` / `github-dark`) recoloured
 * with the PlayerThree palette from `docs/brand`: violet keywords, cyan names, sky constants, pink strings, on the
 * site's violet-tinted surfaces. Each colour clears WCAG AA (4.5:1) on its block background and on the highlighted,
 * added and removed line tints in `src/styles.css`. A GitHub colour with no role here fails the build, so a Shiki
 * upgrade that changes the source themes cannot silently drop a token colour.
 */
import type { ThemeRegistration } from 'shiki';
import githubDark from 'shiki/themes/github-dark.mjs';
import githubLight from 'shiki/themes/github-light.mjs';

type Role = 'fg' | 'comment' | 'keyword' | 'entity' | 'constant' | 'string' | 'regexp' | 'variable' | 'tag' | 'invalid' | 'inserted' | 'deleted' | 'changed';

interface Palette extends Record<Role, string> {
  readonly bg: string;
}

export const P3_LIGHT_PALETTE: Palette = {
  bg: '#f7f5fd',
  fg: '#1d1938',
  comment: '#625e88',
  keyword: '#6420de',
  entity: '#00687f',
  constant: '#1c57c9',
  string: '#b5146b',
  regexp: '#8d1052',
  variable: '#3d3fc9',
  tag: '#3a40c4',
  invalid: '#b42136',
  inserted: '#13723c',
  deleted: '#b42136',
  changed: '#9a4a00',
};

export const P3_DARK_PALETTE: Palette = {
  bg: '#131030',
  fg: '#e6e3f7',
  comment: '#8d89b4',
  keyword: '#c49dff',
  entity: '#55dcf2',
  constant: '#82b4ff',
  string: '#ff92c9',
  regexp: '#ffc2e1',
  variable: '#a9adff',
  tag: '#8fa3ff',
  invalid: '#ff8da1',
  inserted: '#6fe3a5',
  deleted: '#ff8da1',
  changed: '#ffb36b',
};

/** Each GitHub foreground colour and the role it plays in that theme. */
const LIGHT_ROLES: Record<string, Role> = {
  '#24292e': 'fg', '#586069': 'fg', '#6a737d': 'comment', '#d73a49': 'keyword', '#6f42c1': 'entity', '#005cc5': 'constant',
  '#032f62': 'string', '#e36209': 'variable', '#22863a': 'tag', '#b31d28': 'invalid',
};
const DARK_ROLES: Record<string, Role> = {
  '#e1e4e8': 'fg', '#d1d5da': 'fg', '#6a737d': 'comment', '#f97583': 'keyword', '#b392f0': 'entity', '#79b8ff': 'constant',
  '#9ecbff': 'string', '#dbedff': 'regexp', '#ffab70': 'variable', '#85e89d': 'tag', '#fdaeb7': 'invalid',
};

type TokenRule = NonNullable<ThemeRegistration['tokenColors']>[number];

function scopesOf(rule: TokenRule): readonly string[] {
  return rule.scope === undefined ? [] : typeof rule.scope === 'string' ? rule.scope.split(',').map((scope) => scope.trim()) : rule.scope;
}

function recolour(source: ThemeRegistration, name: string, type: 'light' | 'dark', palette: Palette, roles: Record<string, Role>): ThemeRegistration {
  const tokenColors = (source.tokenColors ?? [])
    // GitHub paints carriage returns and ignored/untracked markup as inverted blocks; nothing in the docs needs them.
    .filter((rule) => !scopesOf(rule).some((scope) => scope === 'carriage-return' || scope === 'markup.ignored' || scope === 'markup.untracked'))
    .map((rule): TokenRule => {
      const scopes = scopesOf(rule);
      const { foreground, background: _background, ...settings } = rule.settings;
      // Diff lines keep their meaning (green, red, amber) rather than GitHub's per-role colour.
      const diff: Role | undefined = scopes.some((scope) => scope.startsWith('markup.inserted')) ? 'inserted'
        : scopes.some((scope) => scope.startsWith('markup.deleted')) ? 'deleted'
          : scopes.some((scope) => scope.startsWith('markup.changed')) ? 'changed' : undefined;
      if (foreground === undefined) return { ...rule, settings };
      const role = diff ?? roles[foreground.toLowerCase()];
      if (!role) throw new Error(`shiki-themes: ${source.name} colour ${foreground} (${scopes.join(', ')}) has no ${name} role`);
      return { ...rule, settings: { ...settings, foreground: palette[role] } };
    });
  return {
    name,
    displayName: name,
    type,
    fg: palette.fg,
    bg: palette.bg,
    colors: { 'editor.background': palette.bg, 'editor.foreground': palette.fg },
    tokenColors,
  };
}

export const P3_LIGHT = recolour(githubLight, 'p3-light', 'light', P3_LIGHT_PALETTE, LIGHT_ROLES);
export const P3_DARK = recolour(githubDark, 'p3-dark', 'dark', P3_DARK_PALETTE, DARK_ROLES);
