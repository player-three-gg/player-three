// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlayerConsole, mountConsolePanel, type ConsolePanel, type ConsolePanelOptions } from '../src/index.ts';
import { TOKEN, commander, fakeApi, matchState, settle } from './fake.ts';

const panels: ConsolePanel[] = [];
afterEach(() => {
  for (const p of panels.splice(0)) p.destroy();
  document.body.replaceChildren();
});

function key(code: string, init: KeyboardEventInit = {}, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'Backslash' ? '\\' : code, bubbles: true, ...init }));
}

function setup(extra: Partial<ConsolePanelOptions> = {}) {
  const api = fakeApi();
  const client = createPlayerConsole({ credential: TOKEN, fetch: api.fetch, stream: false, pollMs: 60_000 });
  const mount = document.createElement('div');
  document.body.append(mount);
  const panel = mountConsolePanel({ console: client, mount, roleLabel: (r) => r.toUpperCase(), ...extra });
  panels.push(panel);
  return { api, client, panel, mount };
}

describe('console panel', () => {
  it('is hidden until toggled, and does not poll while hidden', async () => {
    const { api, panel, mount } = setup();
    expect(mount.querySelector('.playerthree-console')).toBe(panel.el);
    expect(panel.el.hidden).toBe(true);
    await settle();
    expect(api.requests).toEqual([]);

    key('Backslash');
    expect(panel.isOpen).toBe(true);
    await vi.waitFor(() => expect(panel.el.textContent).toContain('RUNNER'));
    expect(api.requests).toHaveLength(1);
    const text = panel.el.textContent ?? '';
    expect(text).toContain('RUNNER');
    expect(text).toContain('GUARD');
    expect(text).toContain('no_energy ×1');
    expect(text).toContain('1000 B ≈ 250 tokens');
    expect(text).toContain('Policy deploy v3 · approval needed');
    expect(text).toContain('boom at think');
    expect(text).toContain('consent required');

    key('Backslash');
    expect(panel.isOpen).toBe(false);
  });

  it('ignores the toggle while typing or with modifiers; the key is configurable or off', () => {
    const { panel } = setup({ toggleKey: 'KeyK' });
    const input = document.createElement('input');
    document.body.append(input);
    key('KeyK', {}, input);
    key('KeyK', { ctrlKey: true });
    key('Backslash');
    expect(panel.isOpen).toBe(false);
    key('KeyK');
    expect(panel.isOpen).toBe(true);

    const off = setup({ toggleKey: null });
    key('Backslash');
    expect(off.panel.isOpen).toBe(false);
    off.panel.toggle();
    expect(off.panel.isOpen).toBe(true);
  });

  it('renders policy text as text, offers approvals through the game action, and cleans up', async () => {
    const resolveApproval = vi.fn(async () => undefined);
    const { api, panel, mount } = setup({ actions: { resolveApproval } });
    const st = api.state as Exclude<typeof api.state, { status: number }>;
    const guard = st.policies.guard;
    if (guard && guard.version !== null) guard.logs = ['<img src=x onerror=alert(1)>'];
    panel.open();
    await vi.waitFor(() => expect(panel.el.textContent).toContain('<img src=x onerror=alert(1)>'));
    expect(panel.el.querySelector('img')).toBeNull();
    expect(panel.el.textContent).toContain('<img src=x onerror=alert(1)>');
    const approve = [...panel.el.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!;
    approve.click();
    await settle();
    expect(resolveApproval).toHaveBeenCalledWith({ kind: 'seat', match: 'm1', team: 'blue', role: 'guard' }, 'ap1', true);

    panel.destroy();
    expect(mount.querySelector('.playerthree-console')).toBeNull();
    key('Backslash');
    expect(panel.isOpen).toBe(false);
  });

  it('renders and targets two named commanders with identical compatible roles independently', async () => {
    const resolveApproval = vi.fn(async () => undefined);
    const { api, panel } = setup({ actions: { resolveApproval } });
    api.state = { ...matchState(), match: null, team: null, seats: [], commanders: [
      commander('first', { name: 'DeepSeek', approvals: [{ role: 'runner', approval: { id: 'same', kind: 'publish', version: 4, status: 'pending' } }] }),
      commander('second', { name: 'Claude', roles: ['runner', 'guard'], approvals: [
        { role: 'runner', approval: { id: 'same', kind: 'publish', version: 4, status: 'pending' } },
        { role: 'guard', approval: { id: 'guard-proposal', kind: 'policyDeploy', version: 5, status: 'pending' } },
      ] }),
    ] };
    panel.open();
    await vi.waitFor(() => expect(panel.el.querySelectorAll('[data-commander]')).toHaveLength(2));
    const cards = [...panel.el.querySelectorAll('[data-commander]')];
    expect(cards.map((card) => card.getAttribute('data-commander'))).toEqual(['first', 'second']);
    expect(cards[0]!.textContent).toContain('DeepSeek');
    expect(cards[1]!.textContent).toContain('Claude');
    expect(cards[1]!.querySelectorAll('.playerthree-console__approval')).toHaveLength(2);
    expect(cards[1]!.textContent).toContain('approval needed · GUARD');
    const approve = [...cards[1]!.querySelectorAll('button')].find((button) => button.textContent === 'Approve')!;
    approve.click();
    await settle();
    expect(resolveApproval).toHaveBeenCalledWith({ kind: 'commander', commander: 'second' }, 'same', true);
    const guardApprove = [...panel.el.querySelector('[data-commander=\"second\"]')!.querySelectorAll('button')].filter((button) => button.textContent === 'Approve')[1]!;
    guardApprove.click();
    await settle();
    expect(resolveApproval).toHaveBeenCalledWith({ kind: 'commander', commander: 'second' }, 'guard-proposal', true);
  });
});
