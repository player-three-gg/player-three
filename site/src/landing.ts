/**
 * The playerthree.gg home page: pitch, install, the 30-second quickstart, what the SDK gives a game, and the flagship.
 * Every claim here is backed by a guide or spec section it links to; snippets are markdown so Shiki highlights them
 * at build time like the docs.
 */
import { createElement as h, type ComponentType } from 'react';
import { Badge as MantineBadge, Button as MantineButton, Card as MantineCard, Container, Group, SimpleGrid, Text as MantineText, ThemeIcon, Title, Typography } from '@mantine/core';
import { ArrowRight, FileSignature, Gauge, Plug, Shield, Terminal } from 'lucide-react';
import fight from '../../docs/readme/fight.jpg';
import squareMark from '../../docs/brand/playerthree-square-dark.png';
import godotLogo from './logos/godot.svg?raw';
import mcpLogo from './logos/mcp.svg?raw';
import nodeLogo from './logos/nodejs.svg?raw';
import threeLogo from './logos/threejs.svg?raw';
import typescriptLogo from './logos/typescript.svg?raw';
import Game from '../content/snippets/game.md';
import Install from '../content/snippets/install.md';
import Quickstart from '../content/snippets/quickstart.md';
import { mdxComponents } from './components.ts';
import { AGENT_COMMAND_URL, API_ROUTE, REPO_URL } from './routes.ts';
import { AgentCommandIcon, GithubMark } from './shell.ts';

const Badge = MantineBadge<'div'>;
const Button = MantineButton<'a'>;
const Card = MantineCard<'a'>;
const Text = MantineText<'p'>;

export const LANDING_TITLE = 'PlayerThree · AI agent seats for multiplayer games';
export const LANDING_DESCRIPTION = 'PlayerThree is an open-source SDK and protocol that adds AI agent seats to a multiplayer game server. It includes an MCP seat server, sandboxed policies, a CLI, DevTools and signed match records.';

interface Feature {
  readonly icon: ComponentType<{ size?: number }>;
  readonly title: string;
  readonly body: string;
  readonly href: string;
}

const FEATURES: readonly Feature[] = [
  {
    icon: Plug,
    title: 'MCP seat server',
    body: 'One URL per game. Players add it to Claude Code, Codex, OpenCode or any MCP client and sign in with OAuth 2.1. One tool per control method, schema-guarded and rate limited; each seat sees only its own fogged view.',
    href: '/guides/mcp/',
  },
  {
    icon: Shield,
    title: 'Sandboxed policies',
    body: 'Agents write JS (QuickJS in WebAssembly) or WASM policies that play at tick rate with no model in the loop: no files, network, clock or entropy, with CPU, memory and output caps, versions and rollback.',
    href: '/guides/policies/',
  },
  {
    icon: Terminal,
    title: 'CLI',
    body: '`playerthree lint` sizes your observation and prices it per model, `audit` fuzzes every intent and writes a Safety Card, `dev` runs your game with MCP and DevTools, `db reset` rebuilds the Postgres schema after a schema change.',
    href: '/guides/cli/',
  },
  {
    icon: Gauge,
    title: 'DevTools',
    body: 'An operator console on your game server: every session’s trace, God, side and seat perspectives, replay scrubbing and export, commanders and connections.',
    href: '/guides/devtools/',
  },
  {
    icon: FileSignature,
    title: 'Ratings and a signed commander log',
    body: 'Every match appends one hash-chained entry per commander, Ed25519-signed by official hosts and checkable with `verifyCommanderLog`. Seed-paired series feed TrueSkill standings with bootstrap intervals.',
    href: '/spec/#20101-commander-match-log--implemented',
  },
];

/**
 * The "Works with" strip. Marks are Simple Icons 16.37.0 SVGs, vendored unmodified and drawn in `currentColor`:
 * Godot (CC BY 4.0, Andrea Calabró), Node.js and TypeScript (their projects' branding pages), Three.js (MIT) and
 * the Model Context Protocol mark (MIT). Unity, Unreal Engine, Colyseus, Phaser, Claude Code, Codex and OpenCode are
 * plain text: Unity's and Epic's guidelines restrict their logos, and the others have no permissively licensed mark.
 * Each entry links to the page that documents it.
 */
interface Integration {
  readonly name: string;
  readonly href: string;
  readonly logo?: string;
}

const WORKS_WITH: readonly { readonly label: string; readonly items: readonly Integration[] }[] = [
  {
    label: 'Engines',
    items: [
      { name: 'Godot', href: '/engines/godot/', logo: godotLogo },
      { name: 'Unity', href: '/engines/unity/' },
      { name: 'Unreal Engine', href: '/engines/unreal/' },
      { name: 'Node.js', href: '/getting-started/', logo: nodeLogo },
      { name: 'TypeScript', href: '/getting-started/', logo: typescriptLogo },
    ],
  },
  {
    label: 'Servers and web clients',
    items: [
      { name: 'Colyseus', href: '/packages/colyseus/' },
      { name: 'Three.js', href: '/packages/console/', logo: threeLogo },
      { name: 'Phaser', href: '/packages/console/' },
    ],
  },
  {
    label: 'Agent harnesses over MCP',
    items: [
      { name: 'Claude Code', href: '/guides/mcp/#claude-code' },
      { name: 'Codex', href: '/guides/mcp/#codex-cli' },
      { name: 'OpenCode', href: '/guides/mcp/#opencode' },
      { name: 'Any MCP client', href: '/guides/mcp/#any-mcp-client', logo: mcpLogo },
    ],
  },
];

function WorksWith() {
  return h('section', { className: 'works-with', 'aria-labelledby': 'works-with-title' },
    h(Container, { size: 'lg' },
      h('h2', { id: 'works-with-title', className: 'works-with-title' }, 'Works with'),
      h('div', { className: 'works-with-groups' },
        ...WORKS_WITH.map((group) =>
          h('div', { key: group.label, className: 'works-with-group' },
            h('h3', { className: 'works-with-label' }, group.label),
            h('ul', { className: 'works-with-list' },
              ...group.items.map((item) =>
                h('li', { key: item.name },
                  h('a', { href: item.href, className: 'works-with-item' },
                    item.logo ? h('span', { className: 'works-with-logo', 'aria-hidden': true, dangerouslySetInnerHTML: { __html: item.logo } }) : null,
                    h('span', { className: 'works-with-name' }, item.name))))))))));
}

/** Feature bodies use `code` spans; render them without pulling markdown into the landing bundle. */
function withCode(text: string) {
  return text.split('`').map((part, i) => (i % 2 ? h('code', { key: i }, part) : part));
}

function Snippet({ content: Content }: { content: ComponentType<{ components?: typeof mdxComponents }> }) {
  return h(Typography, { className: 'snippet' }, h(Content, { components: mdxComponents }));
}

export function Landing() {
  return h('div', { className: 'landing', 'data-pagefind-body': '' },
    h('section', { className: 'hero' },
      h(Container, { size: 'lg' },
        h('div', { className: 'hero-grid' },
          h('div', null,
            h(Text, { className: 'hero-eyebrow' }, 'open-source agent SDK · Apache-2.0'),
            h(Title, { order: 1, className: 'hero-title' }, 'Let ', h('span', { className: 'gradient-text' }, 'AI agents'), ' play your multiplayer game.'),
            h(Text, { className: 'hero-lede' },
              'PlayerThree runs on your game server and adds seats that AI agents can play. Players connect their own agent and pay for their own model. You mount one SDK on the server you already run.'),
            h(Group, { gap: 'sm', mt: 'xl' },
              h(Button, { component: 'a', href: '/getting-started/', size: 'md', variant: 'gradient', rightSection: h(ArrowRight, { size: 18 }) }, 'Get started'),
              h(Button, { component: 'a', href: '/spec/', size: 'md', variant: 'default' }, 'Read the spec'),
              h(Button, { component: 'a', href: REPO_URL, size: 'md', variant: 'subtle', leftSection: h(GithubMark, null) }, 'GitHub'))),
          h('div', { className: 'hero-art' }, h('img', { src: squareMark, alt: '', width: 1024, height: 1024 }))))),

    h(WorksWith, null),

    h(Container, { size: 'lg', className: 'landing-body' },
      h('section', { className: 'landing-section' },
        h(SimpleGrid, { cols: { base: 1, md: 2 }, spacing: 'xl' },
          h('div', null,
            h(Text, { className: 'eyebrow' }, 'Install'),
            h(Title, { order: 2 }, 'Install from a checkout'),
            h(Text, { c: 'dimmed', mb: 'md' }, ...withCode('The packages are `playerthree` and `@playerthree/*`, version 0.1.0. Clone the repository and install the workspace; Node.js 24 or later runs the TypeScript sources directly.')),
            h(Snippet, { content: Install })),
          h('div', null,
            h(Text, { className: 'eyebrow' }, 'For game developers'),
            h(Title, { order: 2 }, 'Describe the game, mount the host'),
            h(Text, { c: 'dimmed', mb: 'md' }, 'Describe your game’s screen and buttons as closed schemas, wrap the simulation you already have, and mount the host on your server.'),
            h(Snippet, { content: Game })))),

      h('section', { className: 'landing-section' },
        h(Text, { className: 'eyebrow' }, 'Quickstart'),
        h(Title, { order: 2 }, 'Connect an agent and play a match in 30 seconds'),
        h(Text, { c: 'dimmed', mb: 'md', maw: 760 }, ...withCode('The repository ships a small capture-the-flag game. `playerthree dev` hosts it with built-in bots on every seat but yours and prints the line that attaches your agent.')),
        h(Snippet, { content: Quickstart }),
        h(Button, { component: 'a', href: '/getting-started/', variant: 'light', mt: 'md', rightSection: h(ArrowRight, { size: 16 }) }, 'The full walkthrough')),

      h('section', { className: 'landing-section' },
        h(Text, { className: 'eyebrow' }, 'What you get'),
        h(Title, { order: 2, mb: 'lg' }, 'What one manifest gives you'),
        h(SimpleGrid, { cols: { base: 1, sm: 2, lg: 3 }, spacing: 'lg' },
          ...FEATURES.map((feature) =>
            h(Card, { key: feature.title, component: 'a', href: feature.href, withBorder: true, padding: 'lg', className: 'feature-card' },
              h(ThemeIcon, { size: 44, radius: 'md', variant: 'gradient' }, h(feature.icon, { size: 24 })),
              h(Title, { order: 3, mt: 'md', mb: 'xs' }, feature.title),
              h(Text, { size: 'sm', c: 'dimmed' }, ...withCode(feature.body)))),
          h(Card, { component: 'a', href: API_ROUTE, withBorder: true, padding: 'lg', className: 'feature-card feature-card-more' },
            h(Title, { order: 3, mb: 'xs' }, 'More in the API reference'),
            h(Text, { size: 'sm', c: 'dimmed' }, 'Practice against your bots, seed-paired benchmark series, delayed observer streams, typed team signals, a Colyseus binding and PostgreSQL storage.')))),

      h('section', { className: 'landing-section flagship' },
        h(SimpleGrid, { cols: { base: 1, md: 2 }, spacing: 'xl' },
          h('a', { href: AGENT_COMMAND_URL, className: 'flagship-shot' }, h('img', { src: fight, alt: 'A Surface fight in Agent Command', loading: 'lazy' })),
          h('div', null,
            h(Badge, { variant: 'gradient', size: 'lg' }, 'Built with PlayerThree'),
            h(Group, { gap: 'md', mt: 'md', wrap: 'nowrap', className: 'flagship-title' },
              h('a', { href: AGENT_COMMAND_URL, 'aria-label': 'Agent Command at agentcommand.gg', className: 'flagship-icon' }, h(AgentCommandIcon, { size: 56 })),
              h(Title, { order: 2 }, 'Agent Command')),
            h(Text, { c: 'dimmed', my: 'md' },
              'A free browser RTS on four stacked planes: Orbit, Sky, Surface and Depths. You play one plane and hand the others to your own agents or to bots. It uses PlayerThree for agent sign-in in the browser, policies, practice, series and the live observer.'),
            h(Group, { gap: 'sm' },
              h(Button, { component: 'a', href: AGENT_COMMAND_URL, variant: 'gradient', rightSection: h(ArrowRight, { size: 16 }) }, 'Play at agentcommand.gg'),
              h(Button, { component: 'a', href: 'https://github.com/agent-command/agent-command', variant: 'default', leftSection: h(GithubMark, null) }, 'Source')))))));
}
