/**
 * Optional drop-in panel for a {@link PlayerConsole}: framework-free DOM, mounted into any element, hidden by
 * default, toggled by a configurable key. Every value is rendered as text (never markup): game data is closed
 * vocabulary, and the only free text (policy logs and engine messages) is the owner's own policy's.
 *
 * Theme it with CSS custom properties on the panel or any ancestor (defaults in parentheses):
 *   --playerthree-console-bg (#14161a)        --playerthree-console-fg (#e8e6e1)      --playerthree-console-muted (#9a978f)
 *   --playerthree-console-panel (#1d2026)     --playerthree-console-border (#30343c)  --playerthree-console-accent (#7fd6ff)
 *   --playerthree-console-ok (#8fd18f)        --playerthree-console-bad (#ff8a7a)     --playerthree-console-warn (#ffc861)
 *   --playerthree-console-font (system-ui)    --playerthree-console-mono (ui-monospace) --playerthree-console-size (12px)
 *   --playerthree-console-radius (6px)        --playerthree-console-width (380px)     --playerthree-console-shadow
 *   --playerthree-console-position (fixed)    --playerthree-console-inset (12px 12px 12px auto: top right bottom left)
 *   --playerthree-console-z (1000)
 * Styles use zero-specificity `:where()` selectors, so any game rule on the `playerthree-console*` classes wins.
 */
import type { ConsoleActionTarget, ConsoleSeat, PlayerConsole } from './client.ts';

/** Options of {@link mountConsolePanel}. */
export interface ConsolePanelOptions {
  console: PlayerConsole;
  /** Where the panel is appended. Default `document.body`. */
  mount?: HTMLElement;
  /**
   * Toggle key, matched against `KeyboardEvent.code` or `KeyboardEvent.key` (no Ctrl/Alt/Meta, never while typing
   * in a field). Default `Backslash`; null: no keyboard toggle (call `toggle()` yourself).
   */
  toggleKey?: string | null;
  /** Panel title. Default `Agent console`. */
  title?: string;
  /** Display name of a role. Default: the role id. */
  roleLabel?: (role: string) => string;
  /** Extra class names on the root (theme hooks). */
  className?: string;
  /** Keep the client polling while the panel is hidden. Default false: it runs only while open. */
  pollWhileHidden?: boolean;
  /** Owner actions the panel may offer. Without `resolveApproval`, approvals are shown read-only. */
  actions?: { resolveApproval?: (target: ConsoleActionTarget, id: string, approve: boolean) => Promise<void> };
  /** Called after the panel opens or closes. */
  onToggle?: (open: boolean) => void;
  /** Prefix for cost figures (the console's `pricePerMTok` currency), e.g. `$`. Default none. */
  currency?: string;
}

/** A mounted panel. */
export interface ConsolePanel {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Remove the panel, its key listener and its subscription (stops the client unless `pollWhileHidden`). */
  destroy(): void;
}

const STYLE_ID = 'playerthree-console-style';
const CSS = `
:where(.playerthree-console){position:var(--playerthree-console-position,fixed);inset:var(--playerthree-console-inset,12px 12px 12px auto);width:var(--playerthree-console-width,380px);max-width:calc(100% - 24px);z-index:var(--playerthree-console-z,1000);display:flex;flex-direction:column;background:var(--playerthree-console-bg,#14161a);color:var(--playerthree-console-fg,#e8e6e1);border:1px solid var(--playerthree-console-border,#30343c);border-radius:var(--playerthree-console-radius,6px);box-shadow:var(--playerthree-console-shadow,0 8px 30px rgba(0,0,0,.45));font:var(--playerthree-console-size,12px)/1.45 var(--playerthree-console-font,system-ui,sans-serif);overflow:hidden}
:where(.playerthree-console[hidden]){display:none}
:where(.playerthree-console__head){display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--playerthree-console-border,#30343c)}
:where(.playerthree-console__title){font-weight:700;flex:1}
:where(.playerthree-console__state){color:var(--playerthree-console-muted,#9a978f);font-family:var(--playerthree-console-mono,ui-monospace,monospace)}
:where(.playerthree-console__close){background:none;border:0;color:inherit;font:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0 2px}
:where(.playerthree-console__body){overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:8px;flex:1}
:where(.playerthree-console__empty){color:var(--playerthree-console-muted,#9a978f);padding:8px 0}
:where(.playerthree-console__seat){background:var(--playerthree-console-panel,#1d2026);border:1px solid var(--playerthree-console-border,#30343c);border-radius:var(--playerthree-console-radius,6px);padding:8px;display:flex;flex-direction:column;gap:5px}
:where(.playerthree-console__seat-head){display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
:where(.playerthree-console__role){font-weight:700;color:var(--playerthree-console-accent,#7fd6ff)}
:where(.playerthree-console__badge){border:1px solid currentColor;border-radius:999px;padding:0 6px;font-size:.9em}
:where(.playerthree-console__presence){margin-left:auto;color:var(--playerthree-console-muted,#9a978f)}
:where(.playerthree-console__presence[data-present]){color:var(--playerthree-console-ok,#8fd18f)}
:where(.playerthree-console__row){display:grid;grid-template-columns:76px 1fr;gap:6px}
:where(.playerthree-console__key){color:var(--playerthree-console-muted,#9a978f)}
:where(.playerthree-console__chips){display:flex;flex-wrap:wrap;gap:4px}
:where(.playerthree-console__chip){border:1px solid var(--playerthree-console-border,#30343c);border-radius:999px;padding:0 6px}
:where(.playerthree-console__chip[data-off]){opacity:.55;text-decoration:line-through}
:where(.playerthree-console__approval){border:1px solid var(--playerthree-console-warn,#ffc861);border-radius:var(--playerthree-console-radius,6px);padding:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
:where(.playerthree-console__approval b){color:var(--playerthree-console-warn,#ffc861);flex:1}
:where(.playerthree-console__btn){background:none;border:1px solid currentColor;border-radius:4px;color:inherit;font:inherit;padding:1px 8px;cursor:pointer}
:where(.playerthree-console__btn:disabled){opacity:.5;cursor:default}
:where(.playerthree-console__list){margin:0;padding:0;list-style:none;font-family:var(--playerthree-console-mono,ui-monospace,monospace);font-size:.95em;max-height:9.5em;overflow:auto}
:where(.playerthree-console__list li){display:flex;gap:6px;white-space:nowrap}
:where(.playerthree-console__list li > :last-child){margin-left:auto}
:where(.playerthree-console [data-ok]){color:var(--playerthree-console-ok,#8fd18f)}
:where(.playerthree-console [data-bad]){color:var(--playerthree-console-bad,#ff8a7a)}
:where(.playerthree-console__logs){margin:0;padding:4px 6px;background:rgba(0,0,0,.2);border-radius:4px;font-family:var(--playerthree-console-mono,ui-monospace,monospace);font-size:.95em;white-space:pre-wrap;word-break:break-word;max-height:7em;overflow:auto}
:where(.playerthree-console__foot){padding:6px 10px;border-top:1px solid var(--playerthree-console-border,#30343c);color:var(--playerthree-console-muted,#9a978f)}
`;

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string | undefined, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

function num(n: number, digits = 0): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : `${num(n / 1024, 1)} KB`;
}

/** Compact one-line JSON of closed-vocabulary game data (directives, limits). */
function compact(v: unknown): string {
  if (typeof v !== 'object' || v === null) return String(v);
  return Object.entries(v)
    .map(([k, x]) => `${k}: ${typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)}`)
    .join(' · ');
}

function row(key: string, ...value: Child[]): HTMLElement {
  return el('div', 'playerthree-console__row', el('span', 'playerthree-console__key', key), el('span', undefined, ...value));
}

function flag<T extends HTMLElement>(e: T, name: string, on = true): T {
  if (on) e.setAttribute(name, '');
  return e;
}

function isTyping(t: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
}

/** Mounts the panel (hidden) for `opts.console`, injecting its stylesheet once per document. */
export function mountConsolePanel(opts: ConsolePanelOptions): ConsolePanel {
  const client = opts.console;
  const label = opts.roleLabel ?? ((r: string) => r);
  const toggleKey = opts.toggleKey === undefined ? 'Backslash' : opts.toggleKey;
  const currency = opts.currency ?? '';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }

  const state = el('span', 'playerthree-console__state');
  const close = el('button', 'playerthree-console__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the agent console');
  const body = el('div', 'playerthree-console__body');
  const foot = el('div', 'playerthree-console__foot');
  const root = el('aside', `playerthree-console${opts.className ? ` ${opts.className}` : ''}`, el('div', 'playerthree-console__head', el('span', 'playerthree-console__title', opts.title ?? 'Agent console'), state, close), body, foot);
  root.hidden = true;
  root.setAttribute('aria-label', opts.title ?? 'Agent console');
  (opts.mount ?? document.body).append(root);

  const busy = new Set<string>();
  let frame = 0;
  let destroyed = false;

  function seatEl(s: ConsoleSeat): HTMLElement {
    const presence = flag(el('span', 'playerthree-console__presence', s.present ? 'Active now' : s.paused ? 'Not active · session paused' : 'Not active'), 'data-present', s.present);
    const displayName = s.name ?? (s.role === null ? '' : label(s.role));
    const head = el('div', 'playerthree-console__seat-head', el('span', 'playerthree-console__role', displayName), el('span', 'playerthree-console__badge', s.controller), presence);
    const out = el('section', 'playerthree-console__seat', head);
    if (s.commander) out.dataset.commander = s.commander;
    if (s.role !== null) out.dataset.role = s.role;
    if (s.name) out.append(row(s.live ? 'Seat' : 'Roles', s.live ? `${s.team} · ${label(s.role!)}` : s.roles.map(label).join(' · ')));
    if (s.readiness) out.append(row('Readiness', s.readiness.replaceAll('_', ' ')));
    if (s.mandate) {
      out.append(row('Mandate', `${s.mandate.autonomy} · when away: ${s.mandate.whenAbsent}`));
      if (s.mandate.directive !== undefined && s.mandate.directive !== null) out.append(row('Directive', compact(s.mandate.directive)));
    }
    out.append(row('Scopes', el('span', 'playerthree-console__chips', ...(s.scopes.length ? s.scopes.map((x) => el('span', 'playerthree-console__chip', x)) : ['none']))));
    if (s.limits && Object.keys(s.limits).length) {
      out.append(row('Limits', el('span', 'playerthree-console__chips', ...Object.entries(s.limits).map(([k, v]) => flag(el('span', 'playerthree-console__chip', typeof v === 'boolean' ? k : `${k}: ${String(v)}`), 'data-off', v === false)))));
    }
    for (const { role: approvalRole, approval: a } of s.approvals) {
      const approvalKey = JSON.stringify([s.target, approvalRole, a.id]);
      const kind = { policyDeploy: 'Policy deploy', policyRollback: 'Policy rollback', publish: 'Publish' }[a.kind];
      const box = el('div', 'playerthree-console__approval', el('b', undefined, `${kind} v${a.version} · approval needed · ${label(approvalRole)}`));
      const resolve = opts.actions?.resolveApproval;
      if (resolve) {
        for (const [text, approve] of [['Approve', true], ['Reject', false]] as const) {
          const b = el('button', 'playerthree-console__btn', text);
          b.type = 'button';
          b.disabled = busy.has(approvalKey);
          b.addEventListener('click', () => {
            busy.add(approvalKey);
            schedule();
            void resolve(s.target, a.id, approve)
              .catch(() => undefined)
              .finally(() => {
                busy.delete(approvalKey);
                void client.refresh();
              });
          });
          box.append(b);
        }
      }
      out.append(box);
    }
    const p = s.policy;
    if (p) {
      const parts = [p.version === null ? 'none' : `v${p.version}${p.runtime ? ` (${p.runtime})` : ''}`];
      if (p.calls !== undefined) parts.push(`${num(p.calls)} calls`, `${num(p.errors ?? 0)} errors`, `${num(p.timeouts ?? 0)} timeouts`, `${num(p.meanMs ?? 0, 1)}/${num(p.maxMs ?? 0, 1)} ms`);
      if (p.versions !== undefined) parts.push(`${p.versions} in library`);
      out.append(row('Policy', parts.join(' · ')));
    }
    if (s.observation) {
      const o = s.observation;
      out.append(row('Observation', `${bytes(o.bytes)} ≈ ${num(o.tokens)} tokens${o.cost !== null ? ` ≈ ${currency}${num(o.cost, 5)} per read` : ''}`));
    }
    if (s.rejections.length) {
      out.append(row('Rejected', el('span', 'playerthree-console__chips', ...s.rejections.map((r) => flag(el('span', 'playerthree-console__chip', `${r.code} ×${r.count}`), 'data-bad')))));
    }
    if (s.intents.length) {
      const list = el('ul', 'playerthree-console__list');
      list.setAttribute('aria-label', `${displayName} recent intents`);
      for (const it of s.intents.slice(0, 12)) {
        list.append(el('li', undefined, el('span', undefined, `t${it.tick}`), el('span', undefined, it.source), el('span', undefined, it.kind ?? '—'), flag(flag(el('span', undefined, it.code), 'data-ok', it.ack.ok), 'data-bad', !it.ack.ok)));
      }
      out.append(row('Intents', list));
    } else if (s.live) out.append(row('Intents', 'none yet'));
    if (s.errors.length) {
      const list = el('ul', 'playerthree-console__list');
      for (const e of s.errors.slice(0, 6)) list.append(flag(el('li', undefined, el('span', undefined, e.at ? `t${e.tick}` : 'last'), el('span', undefined, `${e.phase} ${e.code}`), el('span', undefined, e.message ?? '')), 'data-bad'));
      out.append(row('Policy errors', list));
    }
    if (s.logs.length) out.append(row('Policy log', el('pre', 'playerthree-console__logs', s.logs.slice(-8).join('\n'))));
    if (s.practice.length) {
      const list = el('ul', 'playerthree-console__list');
      for (const r of s.practice.slice(0, 4)) {
        list.append(el('li', undefined, el('span', undefined, `${label(r.role)} vs ${r.opponent}`), el('span', undefined, `${num(r.ticks)} ticks · seed ${r.seed}`), flag(el('span', undefined, r.outcome ?? `failed: ${r.code ?? 'error'}`), 'data-bad', r.outcome === null)));
      }
      out.append(row('Practice', list));
    }
    return out;
  }

  /** Markup of the rendered seats: the DOM is swapped only when it would change (keeps hover, focus and selection). */
  let shown = '';
  let lastRender = 0;

  function render(): void {
    frame = 0;
    if (destroyed || root.hidden) return;
    lastRender = Date.now();
    const s = client.snapshot;
    const where = s.phase === 'match' ? `${s.team ?? ''} · tick ${num(s.tick)}${s.outcome && s.outcome !== 'running' ? ` · ${s.outcome}` : ''}` : 'lobby';
    state.textContent = s.status === 'error' ? `error: ${s.error ?? 'unknown'}` : s.status === 'live' ? `${s.streaming ? '● ' : ''}${where}` : s.status;
    const next = el('div', undefined, ...(s.seats.length ? s.seats.map(seatEl) : [el('div', 'playerthree-console__empty', s.status === 'live' ? 'No seats of yours yet.' : 'Connecting…')]));
    if (next.innerHTML !== shown) {
      shown = next.innerHTML;
      const scroll = body.scrollTop;
      body.replaceChildren(...next.childNodes);
      body.scrollTop = scroll;
    }
    foot.textContent = `Token estimate ≈ bytes ÷ ${s.estimate.bytesPerToken}${s.estimate.pricePerMTok !== null ? ` · ${currency}${num(s.estimate.pricePerMTok, 2)} per 1M input tokens` : ''}. Only your own seats are shown.`;
  }

  /** At most 4 renders a second, on an animation frame. */
  function schedule(): void {
    if (frame || destroyed || root.hidden) return;
    const wait = Math.max(0, lastRender + 250 - Date.now());
    frame = window.setTimeout(() => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(render);
      else render();
    }, wait);
  }

  const unsubscribe = client.subscribe(schedule);
  if (opts.pollWhileHidden) client.start();

  const panel: ConsolePanel = {
    el: root,
    get isOpen() {
      return !root.hidden;
    },
    open() {
      if (destroyed || !root.hidden) return;
      root.hidden = false;
      client.start();
      render();
      opts.onToggle?.(true);
    },
    close() {
      if (destroyed || root.hidden) return;
      root.hidden = true;
      if (!opts.pollWhileHidden) client.stop();
      opts.onToggle?.(false);
    },
    toggle() {
      if (root.hidden) panel.open();
      else panel.close();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.hidden = true;
      unsubscribe();
      window.removeEventListener('keydown', onKey);
      client.stop();
      root.remove();
    },
  };

  function onKey(e: KeyboardEvent): void {
    if (toggleKey === null || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.code !== toggleKey && e.key !== toggleKey) return;
    if (isTyping(e.target)) return;
    e.preventDefault();
    panel.toggle();
  }
  close.addEventListener('click', () => panel.close());
  window.addEventListener('keydown', onKey);
  return panel;
}
