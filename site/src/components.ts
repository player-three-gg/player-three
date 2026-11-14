/**
 * Elements the markdown pages render through. The build already highlighted every block and stamped it with
 * `data-language`, `data-label`, `data-title` and `data-tab` (`plugins/code.ts`); these components only add the
 * chrome: a header with the title, language badge and copy button, tabs for code groups, Mantine callouts for GitHub
 * alerts, and a scroll box for wide tables. The server renders all of it, so hydration changes nothing on screen.
 */
import { Children, cloneElement, createElement as h, isValidElement, useSyncExternalStore, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { ActionIcon as MantineActionIcon, Alert, CopyButton, Tabs, Tooltip } from '@mantine/core';
import { Check, CircleAlert, Copy, Info, Lightbulb, MessageSquareWarning, OctagonAlert, type LucideIcon } from 'lucide-react';
import type { MdxComponents } from './content.ts';

// Fix the root element type so createElement does not infer every polymorphic variant.
const ActionIcon = MantineActionIcon<'button'>;

interface PreProps extends ComponentProps<'pre'> {
  readonly 'data-language'?: string;
  readonly 'data-label'?: string;
  readonly 'data-title'?: string;
  readonly 'data-tab'?: string;
}

interface Block {
  readonly label: string | undefined;
  readonly title: string | undefined;
  readonly tab: string | undefined;
  readonly pre: ComponentProps<'pre'>;
  readonly text: string;
}

/** The text a block copies: Shiki splits it into nested spans; lines a diff marks removed (`[!code --]`) are left out. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isValidElement<{ children?: ReactNode; className?: string }>(node)) return '';
  if (node.props.className?.split(' ').includes('remove')) return '\u0000';
  return textOf(node.props.children);
}

function blockOf(props: PreProps): Block {
  const { 'data-label': label, 'data-title': title, 'data-tab': tab, ...pre } = props;
  // A removed line leaves a marker plus its newline; drop both.
  const text = textOf(pre.children).replace(/\u0000\n?/g, '').replace(/\n$/, '');
  return { label, title, tab, pre, text };
}

function CopyCode({ text }: { text: string }) {
  return h(CopyButton, {
    value: text,
    timeout: 1500,
    children: ({ copied, copy }) =>
      h(Tooltip, { label: copied ? 'Copied' : 'Copy', withArrow: true, position: 'left' },
        h(ActionIcon, { className: 'code-copy', variant: 'subtle', color: copied ? 'cyan' : 'gray', size: 'md', onClick: copy, 'aria-label': copied ? 'Copied' : 'Copy code' }, h(copied ? Check : Copy, { size: 15 }))),
  });
}

/** A header with the title and language badge; untitled `text` blocks (trees, output) float the copy button instead. */
export function CodeBlock(props: PreProps) {
  const block = blockOf(props);
  if (!block.title && !block.label) {
    return h('div', { className: 'code-block code-block-plain' }, h('div', { className: 'code-tools' }, h(CopyCode, { text: block.text })), h('pre', block.pre));
  }
  return h('div', { className: 'code-block' },
    h('div', { className: 'code-header' },
      block.title ? h('span', { className: 'code-title' }, block.title) : h('span', { className: 'code-lang' }, block.label),
      h('div', { className: 'code-tools' }, block.title && block.label && h('span', { className: 'code-lang' }, block.label), h(CopyCode, { text: block.text }))),
    h('pre', block.pre));
}

/**
 * The tab a code group shows: the most recently chosen tab name it has, else its first. Choosing a tab moves every
 * group on the page that has a tab of that name, and the choice holds across in-site navigation. It starts empty on
 * every full page load, so the hydrated page matches the prerendered HTML.
 */
let tabChoices: readonly string[] = [];
const tabListeners = new Set<() => void>();
const NO_CHOICES: readonly string[] = [];

function chooseTab(tab: string): void {
  tabChoices = [tab, ...tabChoices.filter((choice) => choice !== tab)];
  for (const listener of tabListeners) listener();
}

function subscribeTabs(listener: () => void): () => void {
  tabListeners.add(listener);
  return () => tabListeners.delete(listener);
}

function CodeGroup({ children }: { children?: ReactNode }) {
  const blocks = Children.toArray(children).filter(isValidElement<PreProps>).map((child) => blockOf(child.props));
  const tabs = blocks.map((block) => block.tab ?? block.label ?? 'Code');
  const choices = useSyncExternalStore(subscribeTabs, () => tabChoices, () => NO_CHOICES);
  const value = choices.find((choice) => tabs.includes(choice)) ?? tabs[0] ?? '';
  const active = blocks[Math.max(0, tabs.indexOf(value))];
  const extra = [active?.title, active?.label && active.label.toLowerCase() !== value.toLowerCase() ? active.label : undefined].filter(Boolean);
  return h(Tabs, { value, onChange: (tab) => tab && chooseTab(tab), keepMountedMode: 'display-none', className: 'code-block code-group', classNames: { list: 'code-tabs', tab: 'code-tab' } },
    h('div', { className: 'code-header' },
      h(Tabs.List, null, ...tabs.map((tab) => h(Tabs.Tab, { key: tab, value: tab }, tab))),
      h('div', { className: 'code-tools' }, ...extra.map((text) => h('span', { key: text, className: 'code-lang' }, text)), active && h(CopyCode, { text: active.text }))),
    ...blocks.map((block, i) => h(Tabs.Panel, { key: tabs[i], value: tabs[i] ?? '', children: h('pre', block.pre) })));
}

/** `rehypeCodeGroups` marks each group's wrapper; every other `div` renders as itself. */
function Div(props: ComponentProps<'div'> & { 'data-code-group'?: string }) {
  const { 'data-code-group': group, ...rest } = props;
  return group === undefined ? h('div', rest) : h(CodeGroup, null, rest.children);
}

const ALERTS: Record<string, { readonly title: string; readonly color: string; readonly icon: LucideIcon }> = {
  note: { title: 'Note', color: 'blue', icon: Info },
  tip: { title: 'Tip', color: 'teal', icon: Lightbulb },
  important: { title: 'Important', color: 'brand', icon: MessageSquareWarning },
  warning: { title: 'Warning', color: 'yellow', icon: CircleAlert },
  caution: { title: 'Caution', color: 'red', icon: OctagonAlert },
};

/** `rehypeAlerts` turns `> [!NOTE]` and friends into `blockquote[data-alert]`; plain quotes stay quotes. */
function Blockquote(props: ComponentProps<'blockquote'> & { 'data-alert'?: string }) {
  const { 'data-alert': kind, ...rest } = props;
  const alert = kind ? ALERTS[kind] : undefined;
  if (!alert) return h('blockquote', rest);
  return h(Alert, { role: 'note', variant: 'light', color: alert.color, title: alert.title, icon: h(alert.icon, { size: 18 }), className: 'doc-alert' }, rest.children);
}

export function TableScroll(props: ComponentProps<'table'>) {
  return h('div', { className: 'table-scroll' }, h('table', props));
}

/** Longest code span kept on one line in a table; longer ones (signatures, schemas, regexes) wrap. */
const SHORT_CODE = 48;

function codeText(node: ReactNode): string | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node) || node.type !== 'code') return undefined;
  return typeof node.props.children === 'string' ? node.props.children : undefined;
}

/** True when a cell holds only short inline code (plus whitespace), like `policy_deploy` or `playerthree dev <module>`. */
function isCodeOnly(children: ReactNode): boolean {
  let code = false;
  for (const child of Children.toArray(children)) {
    if (typeof child === 'string' && child.trim() === '') continue;
    const text = codeText(child);
    if (text === undefined || text.length > SHORT_CODE) return false;
    code = true;
  }
  return code;
}

/** A `code` element holding one short token with no spaces, like `policy_deploy` or `--expect-hash`. */
function isName(node: ReactNode): node is ReactElement<{ children?: ReactNode; className?: string }> {
  const text = codeText(node);
  return text !== undefined && text.length <= SHORT_CODE && !/\s/.test(text);
}

/** Marks short code names, directly or inside a link, so they never split across lines. */
function markNames(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (isName(child)) return cloneElement(child, { className: 'code-name' });
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === 'a') return cloneElement(child, undefined, markNames(child.props.children));
    return child;
  });
}

/** Cells that are only inline code stay on one line (`.code-cell`); short code names never split (`.code-name`). */
function TableCell(tag: 'td' | 'th') {
  return function Cell(props: ComponentProps<'td'>) {
    const children = markNames(props.children);
    return h(tag, isCodeOnly(props.children) ? { ...props, className: 'code-cell', children } : { ...props, children });
  };
}

export const mdxComponents: MdxComponents = { pre: CodeBlock, div: Div, blockquote: Blockquote, table: TableScroll, td: TableCell('td'), th: TableCell('th') } as MdxComponents;
