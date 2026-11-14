// PlayerThree DevTools: the operator console. Plain DOM, no dependencies. Data is rendered with textContent only.
(() => {
  'use strict';
  const BASE = '__BASE__';
  const MODE = '__MODE__';
  const TOKEN_KEY = 'playerthree.operator:' + BASE;
  const POLL_MS = 2000;
  const FEED_KEEP = 400;
  const FEED_SHOW = 200;
  const SECTIONS = ['overview', 'sessions', 'agents', 'policies', 'bench', 'safety', 'settings'];
  const SECTION_LABEL = { overview: 'Overview', sessions: 'Sessions', agents: 'Agents', policies: 'Policies', bench: 'Bench', safety: 'Safety', settings: 'Game settings' };
  const SECTION_TITLE = { overview: 'ovTitle', sessions: 'slTitle', session: 'sdTitle', agents: 'agTitle', policies: 'poTitle', bench: 'bnTitle', safety: 'sfTitle', settings: 'stTitle' };
  const ACCESS = {
    local: ['Local', 'Loopback only: this machine, no proxies'],
    token: ['Operator token', 'Bearer token, kept in this tab only'],
    authorize: ['Host authorization', "The game's authorize hook decides each request"],
  };
  const TEAM_COLORS = ['#5cc8ff', '#ff6b6b', '#3ddc97', '#ffb547', '#b69cff', '#f28fd0'];

  // ================================================================ utilities
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function svg(tag, attrs) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  }
  function link(href, text, cls) {
    const a = el('a', cls, text);
    a.href = href;
    return a;
  }
  function button(text, cls, onClick) {
    const b = el('button', cls || 'ghost', text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  // Same heuristic as `playerthree lint` (o200k-class BPE approximation).
  const TOKEN_RE = /[A-Z]?[a-z]{1,8}|[A-Z]{1,4}|[0-9]{1,3}|[^A-Za-z0-9\s]{1,3}|\s+/g;
  const tokens = (s) => (s.match(TOKEN_RE) || []).length;
  const bytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(1) + ' MiB');
  const utf8Length = (s) => new TextEncoder().encode(s).length;
  const clock = (at) => new Date(at).toTimeString().slice(0, 8);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const uniq = (list) => Array.from(new Set(list));
  const isAbort = (err) => Boolean(err) && err.name === 'AbortError';
  const seatKey = (s) => s.team + '/' + s.role;
  const shortId = (id) => (id.length > 14 ? id.slice(0, 12) + '…' : id);
  function sleep(ms, signal) {
    return new Promise((resolve) => {
      let t = 0;
      const done = () => {
        clearTimeout(t);
        if (signal) signal.removeEventListener('abort', done);
        resolve();
      };
      t = setTimeout(done, ms);
      if (signal) signal.addEventListener('abort', done, { once: true });
    });
  }

  // Server clock offset (from /api/overview) so "12 s ago" is right even if this machine's clock drifts.
  let skew = 0;
  const now = () => Date.now() + skew;
  function ago(at) {
    const s = Math.max(0, Math.round((now() - at) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + ' s ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 48) return h + ' h ago';
    return Math.floor(h / 24) + ' d ago';
  }
  function relTime(at, prefix) {
    const t = el('time', 'rel', (prefix || '') + ago(at));
    t.dateTime = new Date(at).toISOString();
    t.title = new Date(at).toLocaleString();
    t.dataset.at = String(at);
    t.dataset.prefix = prefix || '';
    return t;
  }
  setInterval(() => {
    if (document.hidden) return;
    for (const t of document.querySelectorAll('#main time.rel')) t.textContent = t.dataset.prefix + ago(Number(t.dataset.at));
  }, 1000);
  function gameTime(seconds) {
    if (!Number.isFinite(seconds)) return '';
    const s = Math.max(0, seconds);
    if (s < 60) return s.toFixed(1) + ' s';
    const m = Math.floor(s / 60);
    const r = String(Math.floor(s % 60)).padStart(2, '0');
    if (m < 60) return m + ':' + r;
    return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + r;
  }
  function compact(v, max) {
    const limit = max || 120;
    let s;
    if (v === null || v === undefined) s = '—';
    else if (typeof v !== 'object') s = String(v);
    else if (Array.isArray(v)) s = JSON.stringify(v);
    else {
      const parts = [];
      for (const k of Object.keys(v)) {
        const x = v[k];
        parts.push(k + ': ' + (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x)));
      }
      s = parts.join(', ') || '{}';
    }
    return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
  }
  function mandateText(m) {
    if (!m) return '—';
    const parts = [m.autonomy, 'when absent: ' + m.whenAbsent];
    if (m.directive !== undefined && m.directive !== null) parts.push(compact(m.directive, 90));
    return parts.join(' · ');
  }
  function outcomeSummary(outcomes) {
    const entries = Object.entries(outcomes || {});
    if (!entries.length || entries.every(([, o]) => o === 'running')) return '';
    const winners = entries.filter(([, o]) => o === 'win').map(([t]) => t);
    if (winners.length) return winners.join(', ') + ' won';
    if (entries.every(([, o]) => o === 'draw')) return 'draw';
    return entries.map(([t, o]) => t + ' ' + o).join(', ');
  }
  /** One outcome pill; `rank` (final placement) is shown once the match is over. */
  function outcomePill(team, o, rank) {
    return el('span', 'pill ' + o, team + ' ' + o + (typeof rank === 'number' ? ' #' + rank : ''));
  }
  function teamColor(team) {
    const teams = (GAME && GAME.teams) || [];
    let i = teams.indexOf(team);
    if (i < 0) {
      i = 0;
      for (const c of String(team)) i = (i * 31 + c.charCodeAt(0)) >>> 0;
    }
    return TEAM_COLORS[i % TEAM_COLORS.length];
  }
  function tint(node, team) {
    node.style.setProperty('--team', teamColor(team));
    return node;
  }
  function activity(on, at, never) {
    const s = el('span', 'activity' + (on ? ' on' : ''));
    s.append(el('span', 'live-dot' + (on ? ' on' : '')));
    if (on) s.append(document.createTextNode('active now'));
    else if (at) s.append(relTime(at, 'last seen '));
    else s.append(el('span', 'muted', never));
    return s;
  }
  // Re-render `container` without stealing keyboard focus: focusable nodes carry data-fkey.
  function keepFocus(container, fn) {
    const a = document.activeElement;
    const key = a && a !== document.body && container.contains(a) && a.dataset ? a.dataset.fkey : undefined;
    fn();
    if (key) {
      const n = container.querySelector('[data-fkey="' + CSS.escape(key) + '"]');
      if (n) n.focus({ preventScroll: true });
    }
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = el('textarea', 'sr');
      ta.value = text;
      ta.setAttribute('readonly', '');
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    }
  }
  function flashLabel(btn, text, back) {
    btn.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = back; }, 1600);
  }
  const anyDialogOpen = () => Boolean(document.querySelector('dialog[open]'));
  function closeDialogs() {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
  }

  // ================================================================ render scheduling (rAF-batched)
  const ORDER = ['overview', 'sessions', 'agents', 'policies', 'bench', 'safety', 'settings', 'frame', 'head', 'record', 'persp', 'timeline', 'seats', 'tabs', 'view', 'policy', 'practice', 'feed', 'feedAppend'];
  // Never swap these under a pressed pointer (a click whose target vanishes between down and up is lost).
  const DEFERRABLE = new Set(['overview', 'sessions', 'agents', 'policies', 'bench', 'safety', 'settings', 'seats', 'view']);
  const RENDER = {};
  const dirty = new Set();
  const deferred = new Set();
  let raf = 0;
  let pointerHeld = false;
  function schedule(...parts) {
    for (const p of parts) dirty.add(p);
    if (!raf) raf = requestAnimationFrame(flush);
  }
  function flush() {
    raf = -1;
    for (let pass = 0; pass < 3 && dirty.size; pass++) {
      const d = new Set(dirty);
      dirty.clear();
      for (const k of ORDER) {
        if (!d.has(k)) continue;
        if (pointerHeld && DEFERRABLE.has(k)) deferred.add(k);
        else {
          try { RENDER[k](); } catch (err) { console.error('[devtools] render ' + k + ' failed', err); }
        }
      }
    }
    raf = 0;
    if (dirty.size) raf = requestAnimationFrame(flush);
  }
  document.addEventListener('pointerdown', (e) => {
    if (e.target && e.target.id !== 'tlRange') pointerHeld = true;
  }, true);
  const releasePointer = () => {
    if (!pointerHeld) return;
    pointerHeld = false;
    if (deferred.size) {
      const parts = Array.from(deferred);
      deferred.clear();
      schedule(...parts);
    }
  };
  document.addEventListener('pointerup', releasePointer, true);
  document.addEventListener('pointercancel', releasePointer, true);
  function selectionInside(container) {
    const s = window.getSelection();
    return Boolean(s) && !s.isCollapsed && container.contains(s.anchorNode);
  }

  // ================================================================ API + auth
  let token = null;
  let everConnected = false;
  let gateState = 'loading';
  const net = { down: false };
  class ApiError extends Error {
    constructor(status, code, message, data) {
      super(message || code);
      this.status = status;
      this.code = code;
      this.serverMessage = message || '';
      this.handled = false;
      this.data = data || null;
    }
  }
  function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
  }
  function storeToken(v) {
    try {
      if (v) sessionStorage.setItem(TOKEN_KEY, v);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (_) { /* storage disabled: the token lives for this page load only */ }
  }
  function setNet(down) {
    if (net.down === down) return;
    net.down = down;
    $('netBanner').hidden = !(down && everConnected && gateState === null);
    updateConn();
  }
  async function api(path, opts) {
    const o = opts || {};
    const headers = {};
    if (MODE === 'token' && token) headers.authorization = 'Bearer ' + token;
    let body;
    if (o.text !== undefined) body = o.text;
    else if (o.json !== undefined) body = JSON.stringify(o.json);
    if (body !== undefined) headers['content-type'] = 'application/json';
    let r;
    try {
      r = await fetch(BASE + '/api' + path, {
        method: body !== undefined ? 'POST' : 'GET',
        headers,
        body,
        signal: o.signal,
        cache: 'no-store',
        credentials: 'same-origin',
        referrerPolicy: 'same-origin',
      });
    } catch (err) {
      if (isAbort(err) || (o.signal && o.signal.aborted)) throw err;
      setNet(true);
      throw new ApiError(0, 'network', '');
    }
    setNet(false);
    if (r.ok && o.raw) return r;
    let data = null;
    try { data = await r.json(); } catch (err) { if (isAbort(err)) throw err; }
    if (!r.ok) {
      const err = new ApiError(r.status, data && typeof data.error === 'string' ? data.error : 'http_' + r.status, data && typeof data.message === 'string' ? data.message : '', data);
      if (r.status === 401 || r.status === 403) {
        err.handled = true;
        denied(err);
      }
      throw err;
    }
    if (data === null) throw new ApiError(r.status, 'bad_response', 'The server sent a response the console could not read.');
    return data;
  }
  function errText(err) {
    if (!err) return '';
    if (err.code === 'network') return 'cannot reach the server';
    return (err.serverMessage || 'HTTP ' + err.status) + ' (' + err.code + ')';
  }
  function actionError(err) {
    switch (err.code) {
      case 'network': return 'Cannot reach the server. Check the game is running, then try again.';
      case 'commander_not_found': return 'That commander no longer exists (it was deleted). The list refreshes in a moment.';
      case 'oauth_not_mounted': return 'The game did not pass its OAuth server to the console, so sign-ins cannot be revoked here.';
      case 'session_over': return 'This session had already ended.';
      case 'session_not_found': return 'The host no longer holds this session.';
      default: return 'The server refused: ' + errText(err);
    }
  }
  function describe(err) {
    switch (err.code) {
      case 'loopback_only': return {
        title: 'Open the console on the game server itself',
        body: 'This console runs in local mode, which only answers requests made directly on the machine running the game: no proxies, tunnels or other devices. Open it from that machine, or configure an operator token or an authorization hook on the game server to use it remotely.',
      };
      case 'forbidden_host': return {
        title: 'Use localhost in the address bar',
        body: 'In local mode the console only answers when the address is localhost, 127.0.0.1 or [::1]; this protects it from DNS-rebinding attacks. You reached it as ' + location.host + '.',
        link: { href: location.protocol + '//localhost' + (location.port ? ':' + location.port : '') + location.pathname, text: 'Open on localhost' },
      };
      case 'forbidden_origin': return {
        title: 'Cross-site request blocked',
        body: "The server refused a request that did not come from the console's own page. Reload the console from its own address. If it sits behind a proxy, make sure the proxy forwards the original Host and Origin headers.",
      };
      case 'https_required': return {
        title: 'HTTPS required',
        body: 'Operator tokens are only accepted over HTTPS when the console is reached from another machine, so the token cannot be read in transit. Serve the console behind TLS, or open it on the game server via localhost.',
      };
      case 'forbidden': return {
        title: 'Not authorized',
        body: "The game's authorization hook refused this request. Sign in to the game with an account that may operate it (or ask its admin for access), then try again.",
      };
      case 'unauthorized': return {
        title: 'Not signed in',
        body: "The server did not accept this request's credentials. Sign in to the game again, then try again.",
      };
      case 'network': return {
        title: 'Cannot reach the server',
        body: 'The console could not contact the game server at ' + location.origin + '. Check that the game process is running and reachable, then try again.',
      };
      default: return {
        title: 'The server could not answer',
        body: 'The console asked the game server for its data and got an unexpected error (HTTP ' + err.status + '). Check the game server logs, then try again.',
      };
    }
  }
  function denied(err) {
    stopAll();
    if (err.status === 401 && MODE === 'token') {
      token = null;
      storeToken(null);
      showToken('The console did not accept that operator token. Check it and paste it again.');
      return;
    }
    showGateError(describe(err), err);
  }

  // ---------------------------------------------------------------- gate (token form, error screens)
  for (const img of document.querySelectorAll('.card-logo')) img.src = $('logo').src;
  function showGate(which) {
    gateState = which === 'tokenForm' ? 'token' : which === 'gateError' ? 'error' : 'loading';
    $('shell').hidden = true;
    $('netBanner').hidden = true;
    $('gate').hidden = false;
    for (const id of ['gateLoading', 'tokenForm', 'gateError']) $(id).hidden = id !== which;
    $('signOut').hidden = true;
    updateConn();
  }
  function showToken(msg) {
    showGate('tokenForm');
    $('tokenErr').textContent = msg || '';
    $('tokenInput').focus();
  }
  function showGateError(info, err) {
    showGate('gateError');
    $('gateTitle').textContent = info.title;
    $('gateBody').textContent = info.body;
    const detail = err && err.serverMessage ? err.serverMessage + ' (' + err.code + ')' : err && err.code !== 'network' ? 'code: ' + err.code : '';
    $('gateDetail').textContent = detail;
    $('gateDetail').hidden = !detail;
    const a = $('gateLink');
    a.hidden = !info.link;
    if (info.link) {
      a.href = info.link.href;
      a.textContent = info.link.text;
    }
    $('gateRetry').focus();
  }
  $('gateRetry').addEventListener('click', () => boot());
  $('tokenForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('tokenInput').value.trim();
    if (!v) {
      $('tokenErr').textContent = 'Paste the operator token first.';
      return;
    }
    if (!/^[\x21-\x7e]+$/.test(v)) {
      $('tokenErr').textContent = 'Operator tokens contain no spaces or special characters. Check what you pasted.';
      return;
    }
    token = v;
    storeToken(v);
    $('tokenInput').value = '';
    boot();
  });
  $('signOut').addEventListener('click', () => {
    stopAll();
    token = null;
    storeToken(null);
    showToken('Signed out. The token was removed from this tab.');
  });

  // ---------------------------------------------------------------- connection indicator
  function updateConn() {
    let kind = '';
    let label = 'connecting';
    let tip = '';
    if (gateState === 'token') label = 'signed out';
    else if (gateState === 'error') { kind = 'down'; label = 'not connected'; }
    else if (gateState === 'loading') label = 'connecting';
    else if (net.down) { kind = 'down'; label = 'offline · retrying'; tip = 'The last request could not reach the game server.'; }
    else if (current.id && (current.section === 'sessions' || current.mode === 'bench')) {
      if (D.replay && D.replay.kind === 'recent') { kind = 'replay'; label = 'recent session'; tip = "Scrubbing a released session's recorded replay: an isolated re-simulation."; }
      else if (D.replay && D.replay.kind === 'bench') { kind = 'replay'; label = 'bench replay'; tip = 'Scrubbing a bench replay: an isolated re-simulation.'; }
      else if (D.replay) { kind = 'replay'; label = 'replay file'; tip = 'Viewing an uploaded replay: an isolated re-simulation.'; }
      else if (D.phase === 'gone') label = 'session gone';
      else if (D.phase === 'recent') label = 'recent session';
      else if (D.stream === 'live') { kind = 'live'; label = 'live'; tip = "Streaming this session's events as they happen."; }
      else if (D.stream === 'reconnecting') { kind = 'warn'; label = 'reconnecting'; tip = 'The event stream dropped; reconnecting with backoff.'; }
      else { kind = 'warn'; label = 'connecting'; }
    } else if (current.section === 'bench') { label = 'on demand'; tip = 'Bench results are read when you open this section or press Reload.'; }
    else if (document.hidden) { label = 'paused'; tip = 'Polling pauses while this tab is hidden.'; }
    else { kind = 'poll'; label = 'polling · 2 s'; tip = 'This page refreshes every 2 seconds while it is visible.'; }
    const c = $('conn');
    c.className = 'conn' + (kind ? ' ' + kind : '');
    c.title = tip;
    $('connLabel').textContent = label;
  }

  // ---------------------------------------------------------------- polling (one loop, paused while the tab is hidden)
  let pollGen = 0;
  let pollTimer = 0;
  let pollFn = null;
  let pollBusy = 0;
  function setPoll(fn) {
    pollGen++;
    clearTimeout(pollTimer);
    pollFn = fn;
    pollBusy = 0;
    if (fn) runPoll(pollGen);
  }
  async function runPoll(gen) {
    if (gen !== pollGen || !pollFn || document.hidden || pollBusy === gen) return;
    clearTimeout(pollTimer);
    pollBusy = gen;
    try { await pollFn(); } catch (_) { /* each poll function reports its own errors */ }
    if (gen !== pollGen) return;
    pollBusy = 0;
    pollTimer = setTimeout(() => runPoll(gen), POLL_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) runPoll(pollGen);
    updateConn();
  });

  // ================================================================ boot + routing
  let OV = null;
  let GAME = null;
  let ovError = null;
  let current = { section: null, id: null, q: '', mode: null };
  let navCtl = null;
  let focusFilterOnEnter = false;

  function stopAll() {
    setPoll(null);
    if (navCtl) navCtl.abort();
    navCtl = null;
    detailLeave();
    closeDialogs();
    current = { section: null, id: null, q: '', mode: null };
  }
  async function boot() {
    stopAll();
    if (MODE === 'token') {
      if (!token) token = readToken();
      if (!token) {
        showToken('');
        return;
      }
    }
    showGate('gateLoading');
    let ov;
    try {
      ov = await api('/overview');
    } catch (err) {
      if (!err.handled) showGateError(describe(err), err);
      return;
    }
    everConnected = true;
    gateState = null;
    applyOverview(ov);
    $('gate').hidden = true;
    $('shell').hidden = false;
    $('signOut').hidden = MODE !== 'token';
    $('netBanner').hidden = !net.down;
    route(false);
  }
  /**
   * #overview · #sessions · #sessions/<id> (live or held session) · #recent/<id> (released session, from the history)
   * #agents?q= · #policies · #bench · #bench?dir=<key>&replay=<path> (bench replay in the timeline) · #safety · #settings
   */
  function parseHash() {
    const raw = location.hash.replace(/^#/, '');
    const qi = raw.indexOf('?');
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
    const parts = path.split('/');
    const rest = parts.slice(1).join('/');
    let id = null;
    if (rest) {
      try { id = decodeURIComponent(rest); } catch (_) { id = rest; }
    }
    if (parts[0] === 'recent' && id) return { section: 'sessions', id, q: '', mode: 'recent' };
    if (parts[0] === 'bench' && query.get('dir') && query.get('replay')) {
      return { section: 'bench', id: query.get('dir') + '|' + query.get('replay'), q: '', mode: 'bench', bench: { dir: query.get('dir'), path: query.get('replay') } };
    }
    const section = SECTIONS.includes(parts[0]) ? parts[0] : 'overview';
    return { section, id: section === 'sessions' ? id : null, q: section === 'agents' ? query.get('q') || '' : '', mode: null };
  }
  const viewOf = (r) => ((r.section === 'sessions' && r.id) || r.mode === 'bench' ? 'session' : r.section);
  function route(fromUser) {
    if (gateState !== null) return;
    const r = parseHash();
    const prev = current;
    current = r;
    if (prev.section === r.section && prev.id === r.id && prev.mode === r.mode) {
      if (r.section === 'agents') agentsSetQuery(r.q);
      return;
    }
    setPoll(null);
    if (navCtl) navCtl.abort();
    navCtl = new AbortController();
    if (prev.section && viewOf(prev) === 'session') detailLeave();
    for (const a of document.querySelectorAll('.nav-list a')) {
      if (a.dataset.section === r.section) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const view = viewOf(r);
    for (const v of ['overview', 'sessions', 'session', 'agents', 'policies', 'bench', 'safety', 'settings']) $('view-' + v).hidden = v !== view;
    if (view === 'overview') { schedule('overview'); setPoll(pollOverview); }
    else if (view === 'sessions') { schedule('sessions'); setPoll(pollSessions); }
    else if (view === 'session') detailEnter(r.id, r.mode, r.bench);
    else if (view === 'agents') agentsEnter(r.q);
    else if (view === 'policies') { schedule('policies'); setPoll(pollPolicies); }
    else if (view === 'bench') benchEnter();
    else if (view === 'safety') { schedule('safety'); setPoll(pollSafety); }
    else { schedule('settings'); setPoll(pollSettings); }
    updateTitle();
    updateConn();
    window.scrollTo(0, 0);
    if (focusFilterOnEnter && view === 'agents') {
      focusFilterOnEnter = false;
      $('agFilter').focus();
      $('agFilter').select();
    } else if (fromUser) {
      $(SECTION_TITLE[view]).focus({ preventScroll: true });
    }
  }
  window.addEventListener('hashchange', () => route(true));
  function updateTitle() {
    let label = SECTION_LABEL[current.section] || 'Overview';
    if (current.mode === 'bench') label = 'Bench replay';
    else if (current.mode === 'recent') label = 'Recent ' + shortId(current.id);
    else if (current.section === 'sessions' && current.id) label = (D.replay ? 'Replay · ' : 'Session ') + shortId(current.id);
    document.title = label + ' · ' + (GAME ? GAME.title + ' · ' : '') + 'PlayerThree DevTools';
  }

  // ================================================================ shared states
  function errorCard(title, err, retry) {
    const c = el('div', 'empty-card');
    c.setAttribute('role', 'alert');
    c.append(el('h2', '', title), el('p', '', err.code === 'network' ? 'The console cannot reach the game server right now. It keeps retrying.' : 'The server answered: ' + errText(err) + '.'));
    const row = el('div', 'row');
    row.append(button('Try again', 'primary', retry));
    c.append(row);
    return c;
  }
  function staleNote(err) {
    return el('p', 'note-line bad', 'Could not refresh (' + errText(err) + '). Showing the last data received.');
  }
  function skeleton(blocks, lines) {
    const wrap = el('div');
    wrap.setAttribute('aria-busy', 'true');
    wrap.append(el('span', 'sr', 'Loading…'));
    if (blocks) {
      const g = el('div', 'skel-grid');
      for (let i = 0; i < blocks; i++) g.append(el('span', 'skel block'));
      wrap.append(g);
    }
    for (let i = 0; i < lines; i++) {
      const l = el('span', 'skel line');
      l.style.width = 60 + ((i * 37) % 40) + '%';
      wrap.append(l);
    }
    return wrap;
  }

  // ================================================================ overview
  function applyOverview(ov) {
    OV = ov;
    ovError = null;
    if (typeof ov.serverTime === 'number') skew = ov.serverTime - Date.now();
    GAME = ov.game;
    const g = GAME;
    $('topGame').replaceChildren(el('b', '', g.title), document.createTextNode(' ' + g.version));
    $('ovTitle').textContent = g.title;
    $('ovId').textContent = g.id + '@' + g.version;
    $('ovRate').textContent = g.tickRate + ' ticks/s';
    $('ovHash').textContent = g.surfaceHash;
    $('ovHash').title = 'Surface hash: ' + g.surfaceHash + '. Agents can pin it to detect any change to the tool surface.';
    const modes = $('ovModes');
    if (modes.dataset.sig !== (g.modes || []).join(',')) {
      modes.dataset.sig = (g.modes || []).join(',');
      modes.replaceChildren(...(g.modes || []).map((m) => el('span', 'chip on', m)));
      if (!(g.modes || []).length) modes.append(el('span', 'muted', 'none'));
    }
    const a = ACCESS[ov.access] || [ov.access, ''];
    $('ovAccess').replaceChildren(el('span', '', 'Access'), el('b', '', a[0]), el('span', '', a[1]));
    $('navAccess').replaceChildren(el('span', '', 'Access'), el('b', '', a[0]), el('span', '', a[1]));
    updateTitle();
  }
  $('ovCopy').addEventListener('click', async () => {
    if (!GAME) return;
    flashLabel($('ovCopy'), (await copyText(GAME.surfaceHash)) ? 'Copied' : 'Copy failed', 'Copy');
  });
  async function pollOverview() {
    const signal = navCtl.signal;
    try {
      const ov = await api('/overview', { signal });
      applyOverview(ov);
    } catch (err) {
      if (isAbort(err) || err.handled) return;
      ovError = err;
    }
    schedule('overview');
  }
  function card(href, label, value, sub, tone, fkey) {
    const a = link(href, null, 'card-link');
    a.dataset.fkey = fkey;
    a.append(el('span', 'card-label', label), el('b', 'card-value' + (tone ? ' ' + tone : ''), value));
    if (sub) a.append(typeof sub === 'string' ? el('span', 'card-sub', sub) : sub);
    return a;
  }
  RENDER.overview = () => {
    const box = $('ovBody');
    if (!OV || selectionInside(box)) return;
    keepFocus(box, () => {
      const nodes = [];
      if (ovError && ovError.code !== 'network') nodes.push(staleNote(ovError));
      const s = OV.sessions;
      const ag = OV.agents;
      const w = OV.window;
      const cards = el('div', 'cards');
      cards.append(
        card('#sessions', 'Live sessions', s.live, (s.ended ? s.ended + ' ended, still held' : 'no ended sessions held') + ' · ' + s.recent + ' recent', '', 'c-sessions'),
        card('#agents', 'Active agents now', ag.activeNow,
          plural(ag.owners, 'owner') + ' · ' + plural(ag.commanders, 'commander') + ' · ' + (ag.connections === null ? 'OAuth server not passed' : plural(ag.connections, 'connection')),
          ag.activeNow ? 'ok' : '', 'c-agents'),
        card('#safety', 'Rejections · last ' + w.minutes + ' min', w.rejections, 'intents refused by validation, permissions or game rules', w.rejections ? 'bad' : '', 'c-rej'),
        card('#policies', 'Policy errors · last ' + w.minutes + ' min', w.policyErrors, 'failed policy calls and deploys', w.policyErrors ? 'bad' : '', 'c-pol'),
      );
      nodes.push(cards);

      const problems = el('section', 'box');
      problems.setAttribute('aria-labelledby', 'ovProblemsTitle');
      const head = el('div', 'box-head');
      const h = el('h2', '', 'Recent problems');
      h.id = 'ovProblemsTitle';
      head.append(h);
      if (w.codes.length) {
        const chips = el('div', 'chips');
        chips.append(el('span', 'hash-label', 'Top codes'));
        for (const c of w.codes) chips.append(el('span', 'chip bad', c.code + ' ×' + c.count));
        head.append(chips);
      } else head.append(el('span', 'muted', 'last ' + w.minutes + ' min'));
      problems.append(head);
      const list = el('ol', 'problems');
      for (const p of w.recent) list.append(problemRow(p));
      if (!w.recent.length) {
        list.append(el('li', 'empty', 'Nothing went wrong in the last ' + w.minutes + " minutes. When an agent's intent is refused or a policy call fails, it shows up here with links to its session and owner."));
      }
      problems.append(list);
      nodes.push(problems);
      box.replaceChildren(...nodes);
    });
  };
  function problemRow(p) {
    const li = el('li');
    const kind = p.kind === 'rejection' ? ['rejection', 'rejected'] : ['policy_error', 'policy error'];
    const where = el('span', 'where', p.team + '/' + p.role + ' · tick ' + p.tick + (p.source ? ' · via ' + p.source : ''));
    const links = el('span', 'links');
    const key = p.at + '|' + p.session + '|' + p.tick + '|' + p.code + '|' + p.role;
    const sa = link('#sessions/' + encodeURIComponent(p.session), 'session ' + shortId(p.session), 'mono');
    sa.title = 'Open session ' + p.session;
    sa.dataset.fkey = 'ps|' + key;
    links.append(sa);
    if (p.owner) {
      const oa = link('#agents?q=' + encodeURIComponent(p.owner), p.owner, 'mono');
      oa.title = "Show this owner's agents";
      oa.dataset.fkey = 'po|' + key;
      links.append(oa);
    }
    li.append(el('span', 'when'), el('span', 'kind ' + kind[0], kind[1]), el('span', 'code', p.code), where, links);
    li.firstChild.append(relTime(p.at));
    return li;
  }

  // ================================================================ sessions list
  const SL = { data: null, error: null };
  async function pollSessions() {
    try {
      SL.data = await api('/sessions', { signal: navCtl.signal });
      SL.error = null;
    } catch (err) {
      if (isAbort(err) || err.handled) return;
      SL.error = err;
    }
    schedule('sessions');
  }
  RENDER.sessions = () => {
    const box = $('slBody');
    if (selectionInside(box)) return;
    if (!SL.data) {
      box.replaceChildren(SL.error ? errorCard('Could not load sessions', SL.error, () => setPoll(pollSessions)) : skeleton(0, 6));
      return;
    }
    keepFocus(box, () => {
      const list = SL.data.sessions;
      const recent = SL.data.recent || [];
      const nodes = [];
      if (SL.error && SL.error.code !== 'network') nodes.push(staleNote(SL.error));
      if (!list.length && !recent.length) {
        const c = el('div', 'empty-card');
        c.append(
          el('h2', '', 'No sessions yet'),
          el('p', '', 'Sessions appear here as soon as your game creates a match (host.createMatch), for example when a player presses Play. Start one from your game; this list refreshes every 2 seconds.'),
          el('p', '', 'Ended matches stay listed until the host releases them; then they move to Recent, where you can still scrub and export them.'),
        );
        nodes.push(c);
      } else {
        const live = list.filter((s) => s.status !== 'ended');
        const ended = list.filter((s) => s.status === 'ended');
        nodes.push(sessionsTable('Live', live, 'No live sessions right now.'));
        if (ended.length) nodes.push(sessionsTable('Ended · still held by the host', ended, ''));
        nodes.push(recentTable(recent, SL.data.history));
      }
      box.replaceChildren(...nodes);
    });
  };
  function historyLimits(h) {
    if (!h) return '';
    if (!h.maxSessions) return 'The session history is off (maxSessions: 0).';
    return 'Keeps the last ' + plural(h.maxSessions, 'session') + ' for ' + Math.round(h.maxAgeMs / 3600000) + ' h, up to ' + bytes(h.maxBytes) + ' of replays, ' + (h.persistent ? 'on disk (survives restarts).' : 'in memory (lost on restart).');
  }
  function recentTable(list, h) {
    const box = el('section', 'box');
    const head = el('div', 'box-head');
    head.append(el('h2', '', 'Recent · released by the host'), el('span', 'muted', plural(list.length, 'session')));
    box.append(head);
    if (!list.length) {
      box.append(el('div', 'empty', 'No released sessions yet. When the game releases a session (some time after it ends, or on an idle or duration cap) its record and replay land here. ' + historyLimits(h)));
      return box;
    }
    box.append(el('p', 'quiet', historyLimits(h)));
    const rows = list.map((r) => {
      const href = '#recent/' + encodeURIComponent(r.id);
      const tr = el('tr', 'row-link');
      const out = el('td');
      const pills = el('div', 'chips');
      for (const [team, o] of Object.entries(r.outcomes || {})) pills.append(outcomePill(team, o, r.ranks && r.ranks[team]));
      out.append(pills);
      const idCell = el('td');
      const a = link(href, shortId(r.id), 'mono');
      a.title = r.id;
      a.dataset.fkey = 'r|' + r.id;
      idCell.append(a);
      const len = el('td', 'num', 'tick ' + r.ticks);
      len.append(el('span', 'sub-text', gameTime(r.seconds)));
      const when = el('td');
      when.append(relTime(r.releasedAt, 'released '));
      if (r.endedAt) {
        const sub = el('span', 'sub-text');
        sub.append(relTime(r.endedAt, 'ended '));
        when.append(sub);
      } else when.append(el('span', 'sub-text', 'released before it ended'));
      const seats = el('td');
      const sl = el('div', 'seatlist');
      for (const s of r.seats) {
        const c = tint(el('span', 'seatchip'), s.team);
        c.title = seatKey(s) + ': ' + s.controller + (s.harnesses.length ? ' · held by ' + s.harnesses.join(', ') : '');
        c.append(el('span', '', seatKey(s)), el('span', 'ctl ' + s.controller, s.controller));
        sl.append(c);
      }
      seats.append(sl);
      const holders = uniq([].concat(...r.seats.map((s) => s.harnesses)));
      if (holders.length) seats.append(el('span', 'sub-text', 'agents: ' + holders.join(', ')));
      const owners = el('td');
      const entries = Object.entries(r.owners || {});
      for (const [team, owner] of entries) {
        const row = el('div');
        const oa = link('#agents?q=' + encodeURIComponent(owner), owner, 'mono');
        oa.dataset.fkey = 'ro|' + r.id + '|' + team;
        row.append(el('span', '', team + ': '), oa);
        owners.append(row);
      }
      if (!entries.length) owners.append(el('span', 'muted', '—'));
      const probs = el('td', 'num' + (r.rejections || r.policyErrors ? ' bad' : ''), r.rejections + ' · ' + r.policyErrors);
      probs.title = r.rejections + ' rejected agent inputs, ' + r.policyErrors + ' policy errors';
      const rep = el('td');
      rep.append(el('span', r.scrubbable ? 'chip on' : 'chip warn', r.scrubbable ? 'scrub' : r.replay ? 'other version' : 'no replay'), el('span', 'sub-text', bytes(r.replayBytes)));
      tr.append(out, idCell, len, when, seats, owners, probs, rep);
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a') || selectionInside(tr)) return;
        location.hash = href;
      });
      return tr;
    });
    box.append(table(['Outcome', 'Session', 'Length', 'Released', 'Seats · holders', 'Owners', 'Rejections · policy errors', 'Replay'], rows));
    return box;
  }
  function sessionsTable(title, list, emptyText) {
    const box = el('section', 'box');
    const head = el('div', 'box-head');
    head.append(el('h2', '', title), el('span', 'muted', plural(list.length, 'session')));
    box.append(head);
    if (!list.length) {
      box.append(el('div', 'empty', emptyText));
      return box;
    }
    const minutes = OV ? OV.window.minutes : 15;
    const wrap = el('div', 'table-wrap');
    const t = el('table', 'table');
    const hr = el('tr');
    for (const h of ['Status', 'Session', 'Tick', 'Created', 'Seats', 'Owners', 'Rejections · ' + minutes + ' min']) {
      const th = el('th', '', h);
      th.scope = 'col';
      hr.append(th);
    }
    const thead = el('thead');
    thead.append(hr);
    const tbody = el('tbody');
    for (const s of list) tbody.append(sessionRow(s));
    t.append(thead, tbody);
    wrap.append(t);
    box.append(wrap);
    return box;
  }
  function sessionRow(s) {
    const href = '#sessions/' + encodeURIComponent(s.id);
    const tr = el('tr', 'row-link');
    const status = el('td');
    status.append(el('span', 'pill status ' + s.status, s.status));
    const out = outcomeSummary(s.outcomes);
    if (out) status.append(el('span', 'sub-text', out));
    const idCell = el('td');
    const a = link(href, shortId(s.id), 'mono');
    a.title = s.id;
    a.dataset.fkey = 's|' + s.id;
    idCell.append(a);
    const tick = el('td', 'num', 'tick ' + s.tick);
    tick.append(el('span', 'sub-text', gameTime(s.seconds)));
    const created = el('td');
    if (s.createdAt) created.append(relTime(s.createdAt));
    else {
      const dash = el('span', 'muted', '—');
      dash.title = 'Created before the console was mounted';
      created.append(dash);
    }
    if (s.endedAt) {
      const sub = el('span', 'sub-text');
      sub.append(relTime(s.endedAt, 'ended '));
      created.append(sub);
    }
    const seats = el('td');
    const sl = el('div', 'seatlist');
    for (const seat of s.seats) sl.append(seatChip(seat));
    if (!s.seats.length) sl.append(el('span', 'muted', 'no seats'));
    seats.append(sl);
    if (s.activeAgents) seats.append(el('span', 'sub-text', plural(s.activeAgents, 'agent') + ' active now'));
    const owners = el('td');
    const ol = el('div', 'owners');
    const entries = Object.entries(s.owners || {});
    for (const [team, owner] of entries) {
      const row = el('div');
      const oa = link('#agents?q=' + encodeURIComponent(owner), owner, 'mono');
      oa.dataset.fkey = 'o|' + s.id + '|' + team;
      row.append(el('span', '', team + ': '), oa);
      ol.append(row);
    }
    if (!entries.length) {
      const dash = el('span', 'muted', '—');
      dash.title = 'No team was seated from a commander roster';
      ol.append(dash);
    }
    owners.append(ol);
    const rej = el('td', 'num' + (s.rejections ? ' bad' : ''), s.rejections);
    tr.append(status, idCell, tick, created, seats, owners, rej);
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a') || selectionInside(tr)) return;
      location.hash = href;
    });
    return tr;
  }
  function seatChip(seat) {
    const c = tint(el('span', 'seatchip'), seat.team);
    const dot = el('span', 'live-dot' + (seat.agentActive ? ' on' : ''));
    c.title = seatKey(seat) + ': ' + seat.controller + (seat.agentActive ? ', agent active now' : ', no agent active');
    c.append(dot, el('span', '', seatKey(seat)), el('span', 'ctl ' + seat.controller, seat.controller));
    return c;
  }

  // ================================================================ session detail
  const FEED = { filter: 'agent', onlySeat: false, paused: false };
  const TABS = ['view', 'policy', 'practice'];
  function newDetail(id) {
    return {
      id, phase: 'idle', error: null, ctl: null, stream: 'off',
      // teams/alliances: this match's sides (a subset of the game's teams); ranks: final placements once over.
      game: null, tick: 0, status: 'waiting', teams: null, alliances: null, outcomes: {}, ranks: null, seats: [], seatSig: '',
      obs: {}, policies: {}, calls: {}, logs: {}, practice: [], feed: [], last: {}, pending: [],
      selected: null, persp: 'god', tab: 'view', frozen: false, collapsed: new Set(), runSel: -1,
      scrubTick: null, scrub: null, view: null, viewError: '', viewReq: 0, viewCtl: null, viewBusy: false, shown: null, nearOf: null,
      replay: null, uploadCtl: null, exporting: false, policyBusy: false, switcherAt: 0,
      // mode: null (live/held session), 'recent' (released, from the history) or 'bench' (a bench replay).
      mode: null, record: null, recordReason: null, goneRecent: false,
      // First tick a persistent session still keeps (its rolling replay window); 0 otherwise.
      windowFrom: 0,
    };
  }
  let D = newDetail(null);
  const sessPath = (sub, d) => '/sessions/' + encodeURIComponent((d || D).id) + sub;
  const isSeatPersp = (p) => p.startsWith('seat:');
  const perspSeats = () => (D.replay ? D.replay.seats : D.seats);
  function validPersp(p) {
    const seats = perspSeats();
    if (p === 'god') return true;
    if (p.startsWith('side:')) return seats.some((s) => 'side:' + s.team === p);
    return seats.some((s) => 'seat:' + seatKey(s) === p);
  }
  function perspLabel(p) {
    if (p === 'god') return 'God (unfogged)';
    if (p.startsWith('side:')) return p.slice(5) + ' side';
    return p.slice(5);
  }
  function sessionTeams() {
    if (D.teams && D.teams.length) return D.teams;
    const teams = uniq(D.seats.map((s) => s.team).concat(Object.keys(D.outcomes || {})));
    return teams.length ? teams : (GAME && GAME.teams) || [];
  }
  /** Units that win or lose together: [id, members] per alliance, then each unallied team alone. */
  function sessionUnits() {
    const alliances = Object.entries(D.alliances || {});
    const allied = new Set(alliances.flatMap(([, members]) => members));
    return alliances.concat(sessionTeams().filter((t) => !allied.has(t)).map((t) => [t, [t]]));
  }
  function sdNote(text, bad) {
    const n = $('sdNote');
    n.textContent = text;
    n.className = 'note-line' + (bad ? ' bad' : '');
    clearTimeout(n._t);
    if (text) n._t = setTimeout(() => { n.textContent = ''; }, bad ? 15000 : 8000);
  }

  async function detailEnter(id, mode, bench) {
    detailLeave();
    D = newDetail(id);
    D.mode = mode || null;
    D.ctl = new AbortController();
    D.phase = 'loading';
    sdNote('');
    const crumb = $('sdCrumb');
    crumb.href = mode === 'bench' ? '#bench' : '#sessions';
    crumb.textContent = mode === 'bench' ? 'Bench' : 'Sessions';
    $('sdSwitchWrap').hidden = Boolean(mode);
    fillSwitcher(null);
    RENDER.frame();
    const d = D;
    if (mode === 'recent') return enterRecent(d);
    if (mode === 'bench') return enterBench(d, bench);
    loadSwitcher();
    try {
      const s = await api(sessPath('/state', d), { signal: d.ctl.signal });
      if (d !== D) return;
      applySnapshot(s);
      d.phase = 'live';
      schedule('frame');
      startStream(d);
      refreshView();
    } catch (err) {
      if (d !== D || isAbort(err) || err.handled) return;
      if (err.status === 404) {
        d.phase = 'gone';
        d.goneRecent = Boolean(err.data && err.data.recent);
      } else {
        d.phase = 'error';
        d.error = err;
      }
      schedule('frame');
    }
  }
  async function enterRecent(d) {
    try {
      const r = await api('/recent/' + encodeURIComponent(d.id), { signal: d.ctl.signal });
      if (d !== D) return;
      d.record = r.record;
      d.recordReason = r.reason;
      d.game = r.game;
      d.tick = r.record.ticks;
      d.teams = r.record.teams;
      d.alliances = r.record.alliances;
      d.outcomes = r.record.outcomes;
      d.ranks = r.record.ranks;
      d.status = 'released';
      d.phase = 'recent';
      if (r.scrubbable) {
        d.replay = { kind: 'recent', src: '/recent/' + encodeURIComponent(d.id), ticks: r.record.ticks, seats: r.seats, game: r.game, name: d.id };
        d.scrubTick = 0;
      }
      schedule('frame');
      if (d.replay) refreshView();
    } catch (err) {
      if (d !== D || isAbort(err) || err.handled) return;
      d.phase = err.status === 404 ? 'missing' : 'error';
      d.error = err;
      schedule('frame');
    }
  }
  async function enterBench(d, bench) {
    try {
      const r = await api('/bench/replay', { json: { dir: bench.dir, path: bench.path }, signal: d.ctl.signal });
      if (d !== D) return;
      d.game = r.game;
      d.phase = 'bench';
      d.replay = { kind: 'bench', src: '/replays/' + encodeURIComponent(r.replay), ticks: r.ticks, seats: r.seats || [], game: r.game, name: r.name, dir: bench.dir };
      d.scrubTick = 0;
      schedule('frame');
      refreshView();
    } catch (err) {
      if (d !== D || isAbort(err) || err.handled) return;
      d.phase = 'error';
      d.error = err;
      schedule('frame');
    }
  }
  function detailLeave() {
    if (D.ctl) D.ctl.abort();
    if (D.viewCtl) D.viewCtl.abort();
    if (D.uploadCtl) D.uploadCtl.abort();
    D.phase = 'idle';
    D.stream = 'off';
    if ($('endDialog').open) $('endDialog').close();
  }
  async function markGone(d) {
    if (d !== D || d.phase === 'gone') return;
    d.phase = 'gone';
    d.stream = 'off';
    schedule('frame');
    // Released sessions move to the host's history: link to the record when it is there.
    try {
      await api('/recent/' + encodeURIComponent(d.id), { signal: d.ctl.signal });
      if (d !== D) return;
      d.goneRecent = true;
      schedule('frame');
    } catch (_) {
      /* not in the history (pruned, history off, or never released here) */
    }
  }
  function applySnapshot(s) {
    D.game = s.game;
    D.tick = s.tick;
    D.status = s.status;
    D.persistent = s.persistent === true;
    D.teams = s.teams || null;
    D.alliances = s.alliances || null;
    D.outcomes = s.outcomes || {};
    D.ranks = s.ranks || null;
    setSeats(s.seats || []);
    D.obs = s.observations || {};
    D.policies = s.policies || {};
    D.calls = {};
    for (const k in s.calls || {}) D.calls[k] = s.calls[k].slice(-120);
    D.logs = {};
    for (const k in D.policies) {
      const p = D.policies[k];
      D.logs[k] = p && p.logs ? p.logs.slice() : [];
    }
    D.practice = (s.practice || []).slice().reverse();
    D.feed = [];
    D.last = {};
    D.pending = [];
    for (const e of s.events || []) {
      if (e.type === 'observe' || e.type === 'policy_call') continue;
      noteIntent(e);
      D.feed.push(e);
    }
    if (D.feed.length > FEED_KEEP) D.feed = D.feed.slice(-FEED_KEEP);
  }
  function setSeats(seats) {
    D.seats = seats;
    const sig = seats.map(seatKey).join(',');
    if (sig !== D.seatSig) {
      D.seatSig = sig;
      schedule('persp');
    }
    if (!D.selected || !seats.some((x) => seatKey(x) === D.selected)) D.selected = seats.length ? seatKey(seats[0]) : null;
    if (!validPersp(D.persp)) D.persp = 'god';
  }
  function noteIntent(e) {
    if (e.type === 'intent' && e.source !== 'bot') D.last[seatKey(e)] = e;
  }

  // ---------------------------------------------------------------- stream (fetch + SSE parsing; EventSource cannot send headers)
  async function startStream(d) {
    const signal = d.ctl.signal;
    let delay = 500;
    for (;;) {
      let got = false;
      try {
        const r = await api(sessPath('/stream', d), { signal, raw: true });
        if (!r.body) throw new Error('stream without body');
        d.stream = 'live';
        updateConn();
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let ev = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) ev = line.slice(6).trim();
              else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(line.charAt(5) === ' ' ? 6 : 5);
            }
            if (!data) continue;
            let payload;
            try { payload = JSON.parse(data); } catch (_) { continue; }
            if (d !== D) return;
            got = true;
            if (ev === 'trace') onTrace(payload);
            else if (ev === 'status') onStatus(payload);
          }
        }
      } catch (err) {
        if (signal.aborted || d !== D || err.handled) return;
        if (err.status === 404) return markGone(d);
      }
      if (signal.aborted || d !== D) return;
      if (got) delay = 500;
      d.stream = 'reconnecting';
      updateConn();
      await sleep(delay, signal);
      if (signal.aborted) return;
      delay = Math.min(delay * 2, 8000);
      try {
        const s = await api(sessPath('/state', d), { signal });
        if (d !== D) return;
        applySnapshot(s);
        schedule('frame');
      } catch (err) {
        if (signal.aborted || err.handled) return;
        if (err.status === 404) return markGone(d);
      }
    }
  }
  function onStatus(s) {
    if (typeof s.tick === 'number') D.tick = s.tick;
    if (s.status) D.status = s.status;
    if (s.outcomes) D.outcomes = s.outcomes;
    if (s.ranks) D.ranks = s.ranks;
    if (s.seats) setSeats(s.seats);
    schedule('head', 'seats', 'timeline');
    refreshView(true);
  }
  function onTrace(e) {
    if (typeof e.tick === 'number' && e.tick > D.tick) {
      D.tick = e.tick;
      schedule('head', 'timeline');
    }
    const key = e.team !== undefined && e.role !== undefined ? seatKey(e) : null;
    switch (e.type) {
      case 'observe':
        D.obs[key] = e;
        schedule('seats');
        if (!D.replay && D.scrubTick === null && D.persp === 'seat:' + key && D.tab === 'view' && !D.frozen) schedule('view');
        return;
      case 'policy_call': {
        const list = (D.calls[key] = D.calls[key] || []);
        list.push(e);
        if (list.length > 120) list.shift();
        const p = D.policies[key];
        if (p && p.version === e.version) {
          p.meanMs = (p.meanMs * p.calls + e.ms) / (p.calls + 1);
          p.calls += 1;
          p.maxMs = Math.max(p.maxMs, e.ms);
          p.intentsEmitted += e.intents;
          if (e.error === 'timeout') p.timeouts += 1;
          else if (e.error) p.errors += 1;
          if (e.error) p.lastError = { code: e.error };
        }
        if (e.logs && e.logs.length) {
          const logs = (D.logs[key] = D.logs[key] || []);
          for (const l of e.logs) logs.push('[t' + e.tick + '] ' + l);
          if (logs.length > 300) logs.splice(0, logs.length - 300);
        }
        if (key === D.selected && D.tab === 'policy') schedule('policy');
        return;
      }
      case 'policy_deploy':
        if (e.ok) refreshPolicy();
        break;
      case 'practice':
        D.practice.unshift(e);
        if (D.practice.length > 20) D.practice.pop();
        if (D.tab === 'practice') schedule('practice');
        break;
      case 'match_ended':
        D.outcomes = e.outcomes;
        if (e.ranks) D.ranks = e.ranks;
        D.status = 'ended';
        schedule('head', 'timeline');
        break;
      default:
        break;
    }
    noteIntent(e);
    D.feed.push(e);
    if (D.feed.length > FEED_KEEP) D.feed.splice(0, D.feed.length - FEED_KEEP);
    if (e.type === 'intent' && e.source !== 'bot') schedule('seats');
    if (!FEED.paused && passes(e)) {
      D.pending.push(e);
      if (D.pending.length > FEED_SHOW) D.pending.splice(0, D.pending.length - FEED_SHOW);
      schedule('feedAppend');
    }
  }
  // A deploy changes the version and resets its stats: re-read them from the snapshot.
  async function refreshPolicy() {
    const d = D;
    if (d.policyBusy) return;
    d.policyBusy = true;
    try {
      const s = await api(sessPath('/state', d), { signal: d.ctl.signal });
      if (d !== D) return;
      d.policies = s.policies || {};
      for (const k in d.policies) {
        const p = d.policies[k];
        d.logs[k] = p && p.logs ? p.logs.slice() : [];
      }
      schedule('policy', 'seats');
    } catch (_) {
      /* the next deploy or reconnect refreshes again */
    } finally {
      d.policyBusy = false;
    }
  }

  // ---------------------------------------------------------------- frame (loading / error / gone / live / replay / recent / bench)
  const REPLAY_KIND = { upload: 'Replay file', recent: 'Recent session', bench: 'Bench replay' };
  RENDER.frame = () => {
    const st = $('sdState');
    const showMain = D.phase === 'live' || Boolean(D.replay);
    $('sdMain').hidden = !showMain;
    if (showMain) {
      st.replaceChildren();
      const banner = $('sdReplayBanner');
      banner.hidden = !D.replay;
      if (D.replay) {
        const r = D.replay;
        let text;
        let exit;
        if (r.kind === 'recent') {
          text = 'Recent session: the host released it ' + ago(D.record.releasedAt) + '. You are scrubbing its recorded replay (' + r.ticks + ' ticks), an isolated re-simulation.';
          exit = 'Back to sessions';
        } else if (r.kind === 'bench') {
          text = 'Bench replay “' + r.name + '” (' + r.game.title + ' ' + r.game.version + ', ' + r.ticks + ' ticks), re-simulated in isolation from the bench results directory.';
          exit = 'Back to bench';
        } else {
          text = 'Viewing uploaded replay “' + r.name + '” (' + r.game.title + ' ' + r.game.version + ', ' + r.ticks + ' ticks). This is an isolated re-simulation; ' +
            (D.phase === 'live' ? 'the live session keeps running.' : 'session ' + shortId(D.id) + ' is no longer held by the host.');
          exit = D.phase === 'live' ? 'Back to live session' : D.phase === 'recent' ? 'Close file' : 'Close replay';
        }
        $('sdReplayText').textContent = text;
        $('sdReplayExit').textContent = exit;
      }
      $('tlLoad').hidden = D.phase === 'bench' || D.phase === 'recent';
      $('sdGrid').classList.toggle('replay', Boolean(D.replay));
      $('feedCol').hidden = Boolean(D.replay);
      schedule('head', 'record', 'persp', 'timeline', 'seats', 'tabs', 'view', 'policy', 'practice', 'feed');
    } else if (D.phase === 'loading') {
      st.replaceChildren(skeleton(3, 8));
    } else if (D.phase === 'recent') {
      // Released, but its replay cannot be re-simulated here (too large to keep, or another game version).
      const c = el('div', 'empty-card');
      c.append(el('h2', '', 'Recent session ' + shortId(D.id)), el('p', '', D.recordReason || 'Its replay is not available.'));
      const row = el('div', 'row');
      row.append(link('#sessions', 'Back to sessions', 'primary'));
      if (D.record.replay) row.append(button('Export replay', 'ghost', () => exportReplay(D)));
      c.append(row);
      const box = el('section', 'box record');
      box.append(...recordNodes(D.record));
      st.replaceChildren(c, box);
    } else if (D.phase === 'gone') {
      const c = el('div', 'empty-card');
      c.append(el('h2', '', 'This session is no longer held by the host'));
      if (D.goneRecent) {
        c.append(el('p', '', 'The game released session ' + D.id + '. Its record and replay are in the recent sessions history: open it there to scrub every perspective or export the replay.'));
      } else {
        c.append(
          el('p', '', 'Session ' + D.id + ' is not on this server anymore: the game released it and the history no longer keeps it (pruned, history off, or a restart with an in-memory history), or the id is wrong. Its live data, event stream and replay export are gone.'),
          el('p', '', 'If you exported its replay earlier, you can still load the file and scrub through it here.'),
        );
      }
      const row = el('div', 'row');
      if (D.goneRecent) row.append(link('#recent/' + encodeURIComponent(D.id), 'Open its recent record', 'primary'), link('#sessions', 'Back to sessions', 'ghost btn'));
      else row.append(link('#sessions', 'Back to sessions', 'primary'), button('Load replay file…', 'ghost', () => $('tlFile').click()));
      c.append(row);
      st.replaceChildren(c);
    } else if (D.phase === 'missing') {
      const c = el('div', 'empty-card');
      c.append(
        el('h2', '', 'Not in the recent sessions history'),
        el('p', '', 'Session ' + D.id + ' is not in the host\'s history: it was pruned (count, age or size bounds), the history is in memory and the server restarted, or the id is wrong.'),
      );
      const row = el('div', 'row');
      row.append(link('#sessions', 'Back to sessions', 'primary'));
      c.append(row);
      st.replaceChildren(c);
    } else if (D.phase === 'error') {
      const id = D.id;
      const mode = D.mode;
      const bench = current.bench;
      st.replaceChildren(errorCard((mode === 'bench' ? 'Could not open bench replay ' : 'Could not load session ') + shortId(id), D.error, () => detailEnter(id, mode, bench)));
    }
    updateTitle();
    updateConn();
  };

  /** Facts of a released session (host history record). */
  function recordNodes(rec) {
    const head = el('div', 'box-head');
    head.append(el('h2', '', 'Session record'), el('span', 'muted', 'kept by the host after release'));
    const facts = el('dl', 'kv');
    const fact = (k, v) => {
      const dd = el('dd');
      if (v instanceof Node) dd.append(v);
      else dd.textContent = String(v);
      facts.append(el('dt', '', k), dd);
    };
    const created = el('span');
    created.append(relTime(rec.createdAt), document.createTextNode(' · ' + new Date(rec.createdAt).toLocaleString()));
    fact('Created', created);
    fact('Ended', rec.endedAt ? new Date(rec.endedAt).toLocaleString() + ' (' + gameTime((rec.endedAt - rec.createdAt) / 1000) + ' wall)' : 'released before an outcome');
    fact('Released', new Date(rec.releasedAt).toLocaleString());
    fact('Length', 'tick ' + rec.ticks + ' · ' + gameTime(rec.seconds));
    fact('Seed', rec.seed);
    fact('Options', rec.options === null ? 'game defaults' : compact(rec.options, 200));
    fact('Game version', rec.gameVersion);
    fact('Replay', rec.replay ? bytes(rec.replayBytes) : 'not kept (' + bytes(rec.replayBytes) + ', over the byte limit)');
    fact('Problems', rec.rejections + ' rejected agent inputs · ' + rec.policyErrors + ' policy errors');
    const nodes = [head, facts];
    const codes = el('div', 'chips');
    for (const c of rec.codes.rejections) codes.append(el('span', 'chip bad', c.code + ' ×' + c.count));
    for (const c of rec.codes.policyErrors) codes.append(el('span', 'chip warn', c.code + ' ×' + c.count));
    if (codes.childNodes.length) nodes.push(codes);
    const rows = rec.seats.map((s) => {
      const tr = el('tr');
      const seat = tint(el('span', 'seatchip'), s.team);
      seat.append(el('span', '', seatKey(s)));
      const owner = s.owner ? link('#agents?q=' + encodeURIComponent(s.owner), s.owner, 'mono') : el('span', 'muted', '—');
      const pol = s.poolPolicy ? 'pool ' + s.poolPolicy : s.policyVersion !== undefined ? 'v' + s.policyVersion : '—';
      tr.append(td(seat), td(el('span', 'ctl ' + s.controller, s.controller)), td(owner), td(s.harnesses.length ? s.harnesses.join(', ') : '—', s.harnesses.length ? '' : 'muted'), td(pol), td(s.commander ? 'commander roster' : '—', s.commander ? '' : 'muted'));
      return tr;
    });
    nodes.push(table(['Seat', 'Controller at release', 'Owner', 'Held by', 'Policy', 'Set up from'], rows));
    return nodes;
  }
  RENDER.record = () => {
    const box = $('sdRecord');
    const show = Boolean(D.record) && D.phase === 'recent' && Boolean(D.replay);
    box.hidden = !show;
    if (show) box.replaceChildren(...recordNodes(D.record));
  };

  // ---------------------------------------------------------------- header, actions, switcher
  RENDER.head = () => {
    const meta = $('sdMeta');
    if (D.replay && D.replay.kind === 'recent') {
      const rec = D.record;
      $('sdTitle').textContent = D.id;
      const nodes = [el('span', 'pill status ended', 'released')];
      for (const [team, o] of Object.entries(rec.outcomes || {})) nodes.push(outcomePill(team, o, rec.ranks && rec.ranks[team]));
      nodes.push(el('span', 'chip', rec.ticks + ' ticks · ' + gameTime(rec.seconds)));
      const rel = el('span', 'chip');
      rel.append(relTime(rec.releasedAt, 'released '));
      nodes.push(rel);
      meta.replaceChildren(...nodes);
      $('sdActions').hidden = false;
      $('sdEnd').hidden = true;
      $('sdEndHint').hidden = true;
      $('sdExport').disabled = D.exporting;
      $('sdExport').textContent = D.exporting ? 'Exporting…' : 'Export replay';
    } else if (D.replay) {
      const r = D.replay;
      $('sdTitle').textContent = (r.kind === 'bench' ? 'Bench replay: ' : 'Replay: ') + r.name;
      meta.replaceChildren(
        el('span', 'pill', r.kind === 'bench' ? 'bench results' : 'uploaded file'),
        el('span', 'chip', r.game.id + '@' + r.game.version),
        el('span', 'chip', r.ticks + ' ticks · ' + gameTime(r.ticks / r.game.tickRate)),
        el('span', 'chip', plural(r.seats.length, 'seat')),
      );
      $('sdActions').hidden = true;
    } else {
      $('sdTitle').textContent = D.id;
      // The switcher list loads lazily; keep this session's own entry in step with the header.
      const current = $('sdSwitch').querySelector('option:checked');
      if (current && current.value === D.id) current.textContent = shortId(D.id) + ' · ' + D.status + ' · tick ' + D.tick;
      const nodes = [el('span', 'pill status ' + D.status, D.status)];
      for (const [team, o] of Object.entries(D.outcomes || {})) if (o !== 'running') nodes.push(outcomePill(team, o, D.ranks && D.ranks[team]));
      nodes.push(el('span', 'chip', 'tick ' + D.tick + (D.game ? ' · ' + gameTime(D.tick / D.game.tickRate) : '')));
      if (D.game) nodes.push(el('span', 'chip', D.game.tickRate + ' ticks/s'));
      meta.replaceChildren(...nodes);
      $('sdActions').hidden = false;
      $('sdEnd').hidden = D.persistent;
      const ended = D.status === 'ended';
      $('sdEnd').disabled = ended;
      $('sdEnd').title = ended ? 'This session has already ended.' : 'End this match now with an outcome you pick';
      $('sdEndHint').hidden = !ended;
      $('sdExport').disabled = D.exporting;
      $('sdExport').textContent = D.exporting ? 'Exporting…' : 'Export replay';
    }
    updateTitle();
  };
  async function loadSwitcher() {
    const d = D;
    if (Date.now() - d.switcherAt < 3000 || !d.ctl) return;
    d.switcherAt = Date.now();
    try {
      const r = await api('/sessions', { signal: d.ctl.signal });
      if (d === D) fillSwitcher(r.sessions);
    } catch (_) {
      /* the switcher keeps its last list */
    }
  }
  function fillSwitcher(list) {
    const sel = $('sdSwitch');
    const opts = [];
    let found = false;
    for (const s of list || []) {
      if (s.id === D.id) found = true;
      const o = el('option', '', shortId(s.id) + ' · ' + s.status + ' · tick ' + s.tick);
      o.value = s.id;
      opts.push(o);
    }
    if (!found && D.id) {
      const o = el('option', '', shortId(D.id) + (list ? ' · not held' : ''));
      o.value = D.id;
      opts.unshift(o);
    }
    sel.replaceChildren(...opts);
    sel.value = D.id || '';
  }
  $('sdSwitch').addEventListener('mouseenter', loadSwitcher);
  $('sdSwitch').addEventListener('focus', loadSwitcher);
  $('sdSwitch').addEventListener('change', () => {
    const v = $('sdSwitch').value;
    if (v && v !== D.id) location.hash = '#sessions/' + encodeURIComponent(v);
  });
  function filenameFrom(cd) {
    if (!cd) return '';
    let m = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
    let name = '';
    if (m) {
      try { name = decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch (_) { name = ''; }
    }
    if (!name) {
      m = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(cd);
      name = m ? (m[1] || m[2] || '').trim() : '';
    }
    return name.replace(/[\\/]/g, '_');
  }
  /** Download a live session's replay so far, or a recent session's recorded replay. */
  async function exportReplay(d) {
    if (d.exporting || (d.phase !== 'live' && d.phase !== 'recent')) return;
    d.exporting = true;
    schedule('head');
    try {
      const path = d.phase === 'recent' ? '/recent/' + encodeURIComponent(d.id) + '/replay' : sessPath('/replay', d);
      const r = await api(path, { raw: true, signal: d.ctl.signal });
      const blob = await r.blob();
      const name = filenameFrom(r.headers.get('content-disposition')) || (d.game ? d.game.id : 'session') + '-' + d.id + '.replay.json';
      const url = URL.createObjectURL(blob);
      const a = link(url, null);
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (d === D) sdNote('Saved ' + name + ' (' + bytes(blob.size) + '). Load it here later with “Load replay file…”.');
    } catch (err) {
      if (isAbort(err) || err.handled || d !== D) return;
      sdNote('Export failed: ' + (err instanceof ApiError ? actionError(err) : 'the download was interrupted.'), true);
    } finally {
      d.exporting = false;
      if (d === D) schedule('head');
    }
  }
  $('sdExport').addEventListener('click', () => exportReplay(D));

  // ---------------------------------------------------------------- end session dialog
  $('sdEnd').addEventListener('click', () => {
    if (D.status === 'ended' || D.phase !== 'live') return;
    const units = sessionUnits();
    const box = $('endChoices');
    box.replaceChildren();
    const choices = [['draw', 'Draw (every team still playing draws)']];
    for (const [id, members] of units) {
      const others = units.filter(([x]) => x !== id).map(([x]) => x);
      const name = members.length > 1 || members[0] !== id ? id + ' (' + members.join(', ') + ')' : id;
      choices.push([id, name + ' wins' + (others.length ? ' (' + others.join(', ') + ' lose' + (others.length === 1 ? 's' : '') + ')' : '')]);
    }
    choices.forEach(([value, label], i) => {
      const l = el('label');
      const input = el('input');
      input.type = 'radio';
      input.name = 'endOutcome';
      input.value = value;
      input.checked = i === 0;
      l.append(input, document.createTextNode(label));
      box.append(l);
    });
    $('endTitle').textContent = 'End session ' + shortId(D.id) + '?';
    $('endErr').textContent = '';
    $('endConfirm').disabled = false;
    $('endConfirm').textContent = 'End session';
    $('endDialog').showModal();
  });
  $('endCancel').addEventListener('click', () => $('endDialog').close());
  $('endConfirm').addEventListener('click', async () => {
    const d = D;
    const picked = $('endChoices').querySelector('input:checked');
    if (!picked || d.phase !== 'live') return;
    const units = sessionUnits();
    const outcomes = picked.value === 'draw' ? 'draw' : Object.fromEntries(units.map(([id]) => [id, id === picked.value ? 'win' : 'loss']));
    const btn = $('endConfirm');
    btn.disabled = true;
    btn.textContent = 'Ending…';
    try {
      const r = await api(sessPath('/end', d), { json: { outcomes } });
      if (d !== D) return;
      d.status = 'ended';
      if (r.outcomes) d.outcomes = r.outcomes;
      if (r.ranks) d.ranks = r.ranks;
      if (typeof r.tick === 'number') d.tick = r.tick;
      $('endDialog').close();
      sdNote('Session ended at tick ' + d.tick + ': ' + (outcomeSummary(d.outcomes) || 'outcome recorded') + '.');
      schedule('head', 'timeline');
    } catch (err) {
      if (err.handled) return;
      if (err.code === 'session_over' && d === D) {
        d.status = 'ended';
        schedule('head');
      }
      $('endErr').textContent = actionError(err);
      btn.disabled = err.code === 'session_over';
      btn.textContent = 'End session';
    }
  });

  // ---------------------------------------------------------------- perspective
  function perspOptions() {
    const seats = perspSeats();
    const opts = [['god', 'God (unfogged)', "Everything, unfogged (the game adapter's debugView)"]];
    for (const t of uniq(seats.map((s) => s.team))) opts.push(['side:' + t, t + ' side', 'What the ' + t + ' team sees: its fogged view']);
    for (const s of seats) opts.push(['seat:' + seatKey(s), seatKey(s), 'The observation delivered to this seat']);
    return opts;
  }
  RENDER.persp = () => {
    const box = $('sdPersp');
    const focusIn = box.contains(document.activeElement);
    box.replaceChildren();
    let prevKind = null;
    for (const [value, label, tip] of perspOptions()) {
      const kind = value.split(':')[0];
      if (prevKind && kind !== prevKind) {
        const sep = el('span', 'seg-sep');
        sep.setAttribute('aria-hidden', 'true');
        box.append(sep);
      }
      prevKind = kind;
      const b = button(label, '');
      b.setAttribute('role', 'radio');
      b.dataset.p = value;
      b.title = tip;
      const on = value === D.persp;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      box.append(b);
    }
    if (focusIn) {
      const on = box.querySelector('[aria-checked="true"]');
      if (on) on.focus();
    }
  };
  function resetShown() {
    D.frozen = false;
    D.view = null;
    D.viewError = '';
    D.scrub = null;
    D.nearOf = null;
  }
  function setPersp(p) {
    if (p === D.persp && D.tab === 'view') return;
    if (p !== D.persp) {
      D.persp = p;
      if (isSeatPersp(p)) D.selected = p.slice(5);
      D.runSel = -1;
      resetShown();
    }
    D.tab = 'view';
    schedule('persp', 'seats', 'tabs', 'view', 'timeline', 'policy', 'practice');
    if (FEED.onlySeat) schedule('feed');
    refreshView();
  }
  function selectSeat(key) {
    if (D.selected === key && D.persp === 'seat:' + key) return;
    D.selected = key;
    D.runSel = -1;
    if (D.persp !== 'seat:' + key) {
      D.persp = 'seat:' + key;
      resetShown();
    }
    schedule('persp', 'seats', 'tabs', 'view', 'timeline', 'policy', 'practice');
    if (FEED.onlySeat) schedule('feed');
    if (D.tab === 'view') refreshView();
  }
  $('sdPersp').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]');
    if (b) setPersp(b.dataset.p);
  });
  function roving(container, selector, isOn, pick) {
    container.addEventListener('keydown', (e) => {
      const items = Array.from(container.querySelectorAll(selector)).filter((b) => !b.hidden);
      if (!items.length) return;
      const i = Math.max(0, items.findIndex(isOn));
      let n = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % items.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i + items.length - 1) % items.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = items.length - 1;
      if (n < 0) return;
      e.preventDefault();
      items[n].focus();
      pick(items[n]);
    });
  }
  roving($('sdPersp'), 'button[data-p]', (b) => b.getAttribute('aria-checked') === 'true', (b) => setPersp(b.dataset.p));

  // ---------------------------------------------------------------- timeline + scrubbing
  RENDER.timeline = () => {
    const scrubbing = Boolean(D.replay) || D.scrubTick !== null;
    const max = D.replay ? D.replay.ticks : D.tick;
    const at = scrubbing ? D.scrubTick || 0 : D.tick;
    const r = $('tlRange');
    r.min = String(D.windowFrom);
    r.max = String(max);
    r.value = String(at);
    r.setAttribute('aria-valuetext', 'tick ' + at + (scrubbing ? '' : ', live'));
    $('tlBack').disabled = at <= 0;
    $('tlFwd').disabled = at >= max;
    const live = $('tlLive');
    live.textContent = D.replay ? (D.phase === 'live' ? 'Back to live' : 'Close') : 'Live';
    live.title = D.replay ? (D.phase === 'live' ? 'Back to the live session ( l )' : 'Close this replay ( l )') : 'Back to live ( l )';
    live.setAttribute('aria-pressed', String(!scrubbing));
    const rate = D.replay ? D.replay.game.tickRate : D.game ? D.game.tickRate : 0;
    let status;
    if (scrubbing) {
      const s = D.scrub;
      if (D.viewError) status = D.viewError;
      else if (s && s.tick === D.scrubTick && s.persp === D.persp) {
        status = (D.replay ? REPLAY_KIND[D.replay.kind] : 'Re-simulated') + ' · tick ' + s.tick + ' / ' + s.ticks + (rate ? ' · ' + gameTime(s.tick / rate) : '');
        if (s.paused.length) status += ' · paused by ' + s.paused.map(seatKey).join(', ');
      } else status = 'Re-simulating tick ' + D.scrubTick + '…';
    } else {
      status = (D.status === 'ended' ? 'Ended' : 'Live') + ' · tick ' + D.tick + (rate ? ' · ' + gameTime(D.tick / rate) : '');
    }
    $('tlStatus').textContent = status;
  };
  function seek(t) {
    if (D.phase !== 'live' && !D.replay) return;
    const max = D.replay ? D.replay.ticks : D.tick;
    D.scrubTick = Math.max(D.windowFrom, Math.min(max, Math.round(t)));
    D.frozen = false;
    D.viewError = '';
    if (D.tab !== 'view') {
      D.tab = 'view';
      schedule('tabs');
    }
    schedule('timeline', 'view');
    refreshView();
  }
  function step(delta) {
    const base = D.scrubTick !== null ? D.scrubTick : D.replay ? 0 : D.tick;
    seek(base + delta);
  }
  function goLive() {
    if (D.replay) return exitReplay();
    if (D.scrubTick === null) return;
    if (D.viewCtl) D.viewCtl.abort();
    D.viewBusy = false;
    D.scrubTick = null;
    resetShown();
    schedule('timeline', 'view');
    refreshView();
  }
  $('tlRange').addEventListener('input', () => seek(Number($('tlRange').value)));
  $('tlBack').addEventListener('click', () => step(-1));
  $('tlFwd').addEventListener('click', () => step(1));
  $('tlLive').addEventListener('click', goLive);
  $('sdReplayExit').addEventListener('click', exitReplay);

  // Live god/side views come from /view (refreshed on status ticks); seat views from the stream's observations;
  // any other tick is an isolated re-simulation (/scrub), never the running match.
  async function refreshView(fromStatus) {
    const d = D;
    if (d.phase !== 'live' && !d.replay) return;
    const scrubbing = Boolean(d.replay) || d.scrubTick !== null;
    if (!scrubbing) {
      if (isSeatPersp(d.persp)) {
        if (!fromStatus) schedule('view');
        return;
      }
      if (fromStatus) {
        if (d.viewBusy || d.frozen || d.tab !== 'view') return;
        if (d.view && d.view.persp === d.persp && d.view.tick === d.tick) return;
      }
    } else if (fromStatus) return;
    if (d.viewCtl) d.viewCtl.abort();
    const ctl = new AbortController();
    d.viewCtl = ctl;
    const req = ++d.viewReq;
    d.viewBusy = true;
    const persp = d.persp;
    const path = scrubbing
      ? (d.replay ? d.replay.src : sessPath('', d)) + '/scrub?tick=' + d.scrubTick + '&perspective=' + encodeURIComponent(persp)
      : sessPath('/view?perspective=' + encodeURIComponent(persp), d);
    try {
      let v;
      for (;;) {
        try {
          v = await api(path, { signal: ctl.signal });
          break;
        } catch (err) {
          if (err.status !== 429) throw err;
          await sleep(150, ctl.signal);
          if (ctl.signal.aborted) return;
        }
      }
      if (req !== d.viewReq || d !== D) return;
      d.viewError = '';
      if (scrubbing) {
        d.scrub = { persp, tick: v.tick, ticks: v.ticks, data: v.data, entries: v.entries || [], events: v.events || [], paused: v.paused || [] };
        if ((v.from || 0) !== d.windowFrom) {
          d.windowFrom = v.from || 0;
          schedule('timeline');
        }
      } else d.view = { persp, tick: v.tick, data: v.data };
    } catch (err) {
      if (isAbort(err) || ctl.signal.aborted || req !== d.viewReq || d !== D || err.handled) return;
      if (err.code === 'session_not_found' && d.mode === 'recent') {
        d.phase = 'missing';
        d.replay = null;
        return schedule('frame');
      }
      if (err.code === 'session_not_found') return markGone(d);
      if (err.code === 'replay_not_found') {
        d.viewError = d.replay && d.replay.kind === 'upload' ? 'This uploaded replay has expired (the server keeps the last 4 uploads). Load the file again.'
          : d.replay && d.replay.kind === 'bench' ? 'This bench replay was evicted (the server keeps the last 4 opened replays). Open it again from Bench.'
          : 'This replay is not available anymore: ' + errText(err) + '.';
      } else d.viewError = 'Could not load this view: ' + errText(err) + '.';
    } finally {
      if (req === d.viewReq) d.viewBusy = false;
    }
    schedule('view', 'timeline');
  }

  // ---------------------------------------------------------------- replay files
  $('tlLoad').addEventListener('click', () => $('tlFile').click());
  $('tlFile').addEventListener('change', () => {
    const file = $('tlFile').files[0];
    $('tlFile').value = '';
    if (file) loadReplay(file);
  });
  async function loadReplay(file) {
    const d = D;
    if (file.size > 5 * 1024 * 1024) {
      sdNote(file.name + ' is ' + bytes(file.size) + '; replay uploads are limited to 5 MiB.', true);
      return;
    }
    let text;
    try {
      text = await file.text();
      JSON.parse(text);
    } catch (_) {
      sdNote(file.name + ' is not JSON. Load a replay file saved with “Export replay”.', true);
      return;
    }
    if (d.uploadCtl) d.uploadCtl.abort();
    const ctl = new AbortController();
    d.uploadCtl = ctl;
    sdNote('Uploading ' + file.name + '…');
    try {
      const r = await api('/replays', { text, signal: ctl.signal });
      if (d !== D) return;
      if (d.viewCtl) d.viewCtl.abort();
      d.replay = { kind: 'upload', src: '/replays/' + encodeURIComponent(r.replay), ticks: r.ticks, seats: r.seats || [], game: r.game, name: file.name };
      d.scrubTick = 0;
      d.tab = 'view';
      resetShown();
      if (!validPersp(d.persp)) d.persp = 'god';
      d.seatSig = '';
      sdNote('');
      schedule('frame');
      refreshView();
    } catch (err) {
      if (isAbort(err) || err.handled || d !== D) return;
      let msg;
      if (err.status === 413) msg = 'That replay is too large (at most 5 MiB and 36,000 ticks).';
      else if (err.code === 'invalid') msg = 'Not a replay this console can load: ' + (err.serverMessage || 'it does not match this game') + '.';
      else msg = 'Could not load the replay: ' + errText(err) + '.';
      sdNote(msg, true);
    } finally {
      if (d.uploadCtl === ctl) d.uploadCtl = null;
    }
  }
  function exitReplay() {
    if (!D.replay) return;
    if (D.replay.kind === 'recent') return void (location.hash = '#sessions');
    if (D.replay.kind === 'bench') return void (location.hash = '#bench');
    if (D.viewCtl) D.viewCtl.abort();
    D.viewBusy = false;
    D.replay = null;
    D.scrubTick = null;
    resetShown();
    if (!validPersp(D.persp)) D.persp = 'god';
    schedule('frame');
    refreshView();
  }

  // ---------------------------------------------------------------- seats column
  RENDER.seats = () => {
    const box = $('sdSeats');
    keepFocus(box, () => {
      const nodes = [];
      if (D.replay) for (const s of D.replay.seats) nodes.push(seatCard(s, true));
      else for (const s of D.seats) nodes.push(seatCard(s, false));
      if (!nodes.length) nodes.push(el('div', 'empty', D.replay ? 'This replay has no seats.' : 'This session has no seats.'));
      box.replaceChildren(...nodes);
    });
  };
  function seatCard(s, recorded) {
    const key = seatKey(s);
    const b = tint(button(null, 'seat', () => selectSeat(key)), s.team);
    b.dataset.fkey = 'seat|' + key;
    b.setAttribute('aria-pressed', String(key === D.selected));
    const top = el('div', 'seat-top');
    top.append(el('span', 'seat-name', key));
    b.append(top);
    if (recorded) {
      const rec = D.record && D.replay && D.replay.kind === 'recent' ? D.record.seats.find((x) => seatKey(x) === key) : null;
      if (rec) {
        top.append(el('span', 'ctl ' + rec.controller, rec.controller));
        const meta = el('div', 'seat-meta');
        if (rec.owner) meta.append(el('span', '', 'owner ' + rec.owner));
        meta.append(el('span', '', rec.poolPolicy ? 'pool ' + rec.poolPolicy : rec.policyVersion !== undefined ? 'policy v' + rec.policyVersion : 'no policy'));
        b.append(meta);
        if (rec.harnesses.length) b.append(el('div', 'seat-dir', 'held by ' + rec.harnesses.join(', ')));
      }
      b.append(el('div', 'seat-last', 'Recorded seat: select it to see its observation at the chosen tick.'));
      return b;
    }
    top.append(el('span', 'live-dot' + (s.agentActive ? ' on' : '')), el('span', 'sr', s.agentActive ? 'agent active now' : 'no agent active'), el('span', 'ctl ' + s.controller, s.controller));
    top.firstChild.nextSibling.title = s.agentActive ? 'Agent active now' : 'No agent active';
    const meta = el('div', 'seat-meta');
    if (s.commander) meta.append(el('span', '', 'commander'));
    meta.append(el('span', '', s.policyVersion !== undefined ? 'policy v' + s.policyVersion : 'no policy'));
    if (s.poolPolicy) meta.append(el('span', '', 'pool ' + s.poolPolicy));
    const o = D.obs[key];
    if (o) meta.append(el('span', '', 'obs ' + bytes(o.bytes)));
    b.append(meta, el('div', 'seat-dir', mandateText(s.mandate)));
    const li = D.last[key];
    const last = el('div', 'seat-last');
    if (li) last.append(el('span', '', 'last: ' + intentText(li) + ' '), ackBadge(li.ack), el('span', '', ' · '), relTime(li.at));
    else last.textContent = 'no agent or owner intent yet';
    b.append(last);
    return b;
  }

  // ---------------------------------------------------------------- tabs
  RENDER.tabs = () => {
    if (D.replay && D.tab !== 'view') D.tab = 'view';
    for (const t of TABS) {
      const b = $('tab-' + t);
      const on = t === D.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.hidden = Boolean(D.replay) && t !== 'view';
      $('panel-' + t).hidden = !on;
    }
    $('panelTitle').textContent = D.tab === 'view' ? perspLabel(D.persp) : D.selected || 'Seat';
  };
  function setTab(t) {
    if (t === D.tab) return;
    D.tab = t;
    RENDER.tabs();
    schedule(t);
    if (t === 'view') refreshView();
  }
  for (const t of TABS) $('tab-' + t).addEventListener('click', () => setTab(t));
  roving($('sdTabs'), 'button[role="tab"]', (b) => b.getAttribute('aria-selected') === 'true', (b) => setTab(b.dataset.tab));

  // ---------------------------------------------------------------- JSON tree with change flash
  function leaf(v) {
    if (typeof v === 'string') return el('span', 's', JSON.stringify(v));
    if (typeof v === 'number') return el('span', 'n', String(v));
    if (typeof v === 'boolean') return el('span', 'b', String(v));
    return el('span', 'z', 'null');
  }
  const pick = (o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined);
  function tree(v, prev, path, key, collapsed) {
    if (v !== null && typeof v === 'object') {
      const isArr = Array.isArray(v);
      const d = document.createElement('details');
      const n = isArr ? v.length : Object.keys(v).length;
      d.open = !collapsed.has(path) && !(isArr && n > 16 && !collapsed.has('+' + path));
      const sum = document.createElement('summary');
      sum.dataset.fkey = path;
      if (key !== undefined) sum.append(el('span', 'k', key), document.createTextNode(': '));
      sum.append(document.createTextNode(isArr ? '[' + n + ']' : '{' + n + '}'));
      d.append(sum);
      d.addEventListener('toggle', () => {
        if (d.open) {
          collapsed.delete(path);
          collapsed.add('+' + path);
        } else {
          collapsed.add(path);
          collapsed.delete('+' + path);
        }
      });
      if (isArr) v.forEach((x, i) => d.append(tree(x, pick(prev, i), path + '.' + i, String(i), collapsed)));
      else for (const k in v) d.append(tree(v[k], pick(prev, k), path + '.' + k, k, collapsed));
      return d;
    }
    const row = el('div', 'row');
    if (key !== undefined) row.append(el('span', 'k', key), document.createTextNode(': '));
    const lv = leaf(v);
    if (prev !== undefined && prev !== v) lv.classList.add('chg');
    row.append(lv);
    return row;
  }
  function metric(label, value) {
    const m = el('div', 'metric');
    m.append(el('b', '', value), el('span', '', label));
    return m;
  }

  // ---------------------------------------------------------------- view panel
  RENDER.view = () => {
    const meta = $('viewMeta');
    const box = $('viewTree');
    const scrubbing = Boolean(D.replay) || D.scrubTick !== null;
    let src = null;
    let msg = '';
    if (scrubbing) {
      const s = D.scrub;
      if (D.viewError) msg = D.viewError;
      else if (s && s.persp === D.persp) src = { data: s.data, tick: s.tick, source: D.replay ? 'replay file' : 're-simulated' };
      else msg = 'Re-simulating tick ' + D.scrubTick + '…';
      if (src && (src.data === null || src.data === undefined)) {
        msg = D.persp === 'god' ? 'This game adapter has no debugView(), so there is no unfogged view. Pick a side or a seat.' : 'Nothing recorded for this perspective at tick ' + s.tick + '.';
        src = null;
      }
    } else if (isSeatPersp(D.persp)) {
      const o = D.obs[D.persp.slice(5)];
      if (o) src = { data: o.data, tick: o.tick, source: o.source, bytes: o.bytes };
      else msg = 'No observation delivered to ' + D.persp.slice(5) + ' yet. It appears as soon as its agent, policy or bot observes.';
    } else {
      const v = D.view;
      if (D.viewError) msg = D.viewError;
      else if (!v || v.persp !== D.persp) msg = 'Loading view…';
      else if (v.data === null || v.data === undefined) {
        msg = D.persp === 'god' ? 'This game adapter has no debugView(), so there is no unfogged view. Pick a side or a seat.' : 'No view for this side yet.';
      } else src = { data: v.data, tick: v.tick, source: D.persp === 'god' ? 'debugView' : 'side view' };
    }
    renderNear(scrubbing);
    if (D.frozen && !scrubbing && D.shown && D.shown.persp === D.persp) src = D.shown.src;
    if (!src) {
      meta.replaceChildren();
      box.replaceChildren(el('div', 'empty', msg));
      D.shown = null;
      return;
    }
    const same = Boolean(D.shown) && D.shown.persp === D.persp && D.shown.data === src.data;
    let size;
    let tok;
    if (same) {
      size = D.shown.size;
      tok = D.shown.tok;
    } else {
      const text = JSON.stringify(src.data);
      size = src.bytes !== undefined ? src.bytes : utf8Length(text);
      tok = tokens(text);
    }
    keepFocus(meta, () => {
      meta.replaceChildren(metric('tick', src.tick), metric('source', src.source), metric('size', bytes(size)), metric('≈ tokens', tok));
      if (!scrubbing) {
        const freeze = button(D.frozen ? 'Frozen' : 'Freeze', 'ghost', () => {
          D.frozen = !D.frozen;
          schedule('view');
          if (!D.frozen) refreshView();
        });
        freeze.setAttribute('aria-pressed', String(D.frozen));
        freeze.title = D.frozen ? 'Resume live updates' : 'Stop updating this view so you can read it';
        freeze.dataset.fkey = 'freeze';
        meta.append(freeze);
      }
      const copy = button('Copy JSON', 'ghost', async () => {
        flashLabel(copy, (await copyText(JSON.stringify(src.data, null, 2))) ? 'Copied' : 'Copy failed', 'Copy JSON');
      });
      copy.dataset.fkey = 'copy';
      meta.append(copy);
    });
    if (!same || !box.firstElementChild || box.firstElementChild.classList.contains('empty')) {
      const prev = D.shown && D.shown.persp === D.persp ? D.shown.data : undefined;
      keepFocus(box, () => box.replaceChildren(tree(src.data, prev, '$', undefined, D.collapsed)));
    }
    D.shown = { persp: D.persp, data: src.data, src, size, tok };
  };
  function renderNear(scrubbing) {
    const near = $('viewNear');
    const s = D.scrub;
    if (!scrubbing || !s || s.persp !== D.persp || D.viewError) {
      near.hidden = true;
      return;
    }
    near.hidden = false;
    if (D.nearOf === s) return;
    D.nearOf = s;
    $('viewNearSum').textContent = 'Recorded inputs (' + s.entries.length + ') and trace (' + s.events.length + ') near tick ' + s.tick + ' (±1)';
    const rows = s.entries.map(entryRow).concat(s.events.map(feedRow));
    if (!rows.length) rows.push(el('li', 'empty', 'Nothing recorded within one tick of here.'));
    $('viewNearList').replaceChildren(...rows);
  }
  function entryRow(en) {
    const [tick, team, role, op] = en;
    const li = el('li');
    li.append(el('span', 't', 'input'), el('span', 'tick', tick));
    const body = el('span', 'body');
    const who = el('span', 'who', op === 'forfeit' ? team : team + '/' + role);
    who.style.color = teamColor(team);
    body.append(who);
    if (op === 'intent') body.append(el('span', 'what', intentDesc(en[4])));
    else if (op === 'forfeit') body.append(el('span', 'what', 'forfeited'));
    else body.append(el('span', 'what', 'seat → ' + en[4] + ' · ' + mandateText(en[5])));
    li.append(body);
    return li;
  }

  // ---------------------------------------------------------------- policy panel
  RENDER.policy = () => {
    const statsBox = $('policyStats');
    statsBox.replaceChildren();
    const p = D.selected ? D.policies[D.selected] : null;
    const policyMode = Boolean(D.game && D.game.policy);
    if (!p || p.version === null) {
      $('policyMore').hidden = true;
      let msg;
      if (!D.selected) msg = 'Select a seat to see its policy.';
      else if (!policyMode) msg = 'This game has no policy mode, so seats never run deployed policies.';
      else msg = 'No policy deployed on ' + D.selected + '. An agent deploys one with policy_deploy; its calls, timings and logs then appear here.';
      statsBox.append(el('div', 'empty', msg));
      if (p && p.approval && p.approval.status === 'pending') statsBox.append(el('span', 'badge-pending', 'approval pending · ' + p.approval.kind + ' v' + p.approval.version));
      return;
    }
    $('policyMore').hidden = false;
    const budget = policyMode ? D.game.policy.msPerCall : null;
    statsBox.append(
      metric('version', 'v' + p.version + ' ' + p.runtime),
      metric('calls', p.calls),
      metric('mean ms', p.meanMs.toFixed(2)),
      metric('max ms' + (budget ? ' / ' + budget : ''), p.maxMs.toFixed(1)),
      metric('intents', p.intentsEmitted),
      metric('errors', p.errors),
      metric('timeouts', p.timeouts),
    );
    if (p.lastError) statsBox.append(metric('last error', p.lastError.code));
    if (p.approval && p.approval.status === 'pending') statsBox.append(metric('approval pending', p.approval.kind + ' v' + p.approval.version));
    const rej = $('policyRejected');
    rej.replaceChildren(...(p.intentsRejected || []).map((r) => el('span', 'chip bad', r.code + ' ×' + r.count)));
    if (!(p.intentsRejected || []).length) rej.append(el('span', 'chip', 'none'));
    const calls = D.calls[D.selected] || [];
    const sp = $('spark');
    sp.replaceChildren();
    const max = Math.max(budget || 0, ...calls.map((c) => c.ms), 1);
    const y = (ms) => 90 - (ms / max) * 84;
    if (budget) sp.append(svg('line', { x1: 0, x2: 600, y1: y(budget), y2: y(budget), stroke: '#ff6b6b', 'stroke-dasharray': '4 4', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
    if (calls.length > 1) {
      const x = (i) => (i / (calls.length - 1)) * 600;
      sp.append(svg('polyline', { points: calls.map((c, i) => x(i) + ',' + y(c.ms)).join(' '), fill: 'none', stroke: '#5cc8ff', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }));
      calls.forEach((c, i) => {
        if (c.error) sp.append(svg('circle', { cx: x(i), cy: y(c.ms), r: 3, fill: '#ff6b6b' }));
      });
    }
    sp.setAttribute('aria-label', calls.length ? 'Policy call time: last ' + calls.length + ' calls, max ' + Math.max(...calls.map((c) => c.ms)).toFixed(1) + ' ms' : 'No policy calls yet');
    const logs = D.logs[D.selected] || [];
    const pre = $('policyLogs');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = logs.length ? logs.join('\n') : '(no log output yet)';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  };

  // ---------------------------------------------------------------- practice panel
  RENDER.practice = () => {
    const body = $('runs');
    body.replaceChildren();
    $('runReport').replaceChildren();
    const runs = D.practice.filter((r) => seatKey(r) === D.selected);
    if (!runs.length) {
      const tr = el('tr');
      const td = el('td', 'empty', D.selected ? 'No practice runs for ' + D.selected + ' yet. Agents start one with practice_run; results land here.' : 'Select a seat to see its practice runs.');
      td.colSpan = 6;
      tr.append(td);
      body.append(tr);
      return;
    }
    runs.forEach((r, i) => {
      const res = r.result;
      const tr = el('tr', i === D.runSel ? 'sel' : '');
      tr.tabIndex = 0;
      tr.setAttribute('aria-selected', String(i === D.runSel));
      const out = el('td');
      out.append(res.ok ? el('span', 'pill ' + res.outcome, res.outcome) : el('span', 'pill failed', 'failed · ' + res.code));
      tr.append(
        el('td', '', clock(r.at)),
        el('td', '', r.opponent + (r.allies && r.allies !== r.opponent ? ' (allies ' + r.allies + ')' : '')),
        el('td', '', (res.ok ? res.ticks : '—') + ' / ' + r.ticks),
        out,
        el('td', '', res.policy.calls + (res.policy.errors ? ' · ' + res.policy.errors + ' err' : '')),
        el('td', '', (res.wallMs / 1000).toFixed(2) + ' s'),
      );
      const open = () => {
        D.runSel = i;
        RENDER.practice();
        const again = $('runs').children[i];
        if (again) again.focus();
      };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
      body.append(tr);
    });
    const sel = runs[D.runSel];
    if (sel) {
      $('runReport').append(el('div', 'sub', 'After-action report'));
      if (sel.result.ok) $('runReport').append(tree(sel.result.report, undefined, 'run' + D.runSel, undefined, D.collapsed));
      else $('runReport').append(el('div', 'empty', sel.result.code === 'policy' ? 'The policy failed to load, so there is no report.' : "The game's report failed closed-vocabulary validation and was withheld."));
    }
  };

  // ---------------------------------------------------------------- feed
  function intentDesc(it) {
    if (it === null || typeof it !== 'object') return String(it);
    const parts = [];
    for (const k in it) if (k !== 'kind') parts.push(k + '=' + (typeof it[k] === 'object' ? JSON.stringify(it[k]) : it[k]));
    return (it.kind !== undefined ? it.kind : '?') + (parts.length ? ' ' + parts.join(' ') : '');
  }
  function intentText(e) {
    if (e.intent === undefined || e.intent === null) return e.ack && e.ack.code === 'invalid' ? '(input withheld: failed validation)' : '(not evaluated)';
    return intentDesc(e.intent);
  }
  function ackBadge(a) {
    if (!a) return el('span');
    if (a.ok) return el('span', 'ack ok', '✓ ok');
    let t = '✗ ' + a.code;
    if (a.code === 'invalid') t += ' · ' + a.schemaCode + (a.path && a.path.length ? ' @ ' + a.path.join('.') : '') + (a.expected ? ' · expected ' + a.expected : '');
    if (a.code === 'game') t += ' · ' + a.gameCode;
    return el('span', a.code === 'rate_limited' ? 'ack warn' : 'ack bad', t);
  }
  const CONTROL = { controller: 1, mandate: 1, policy_deploy: 1, practice: 1, match_created: 1, match_ended: 1, forfeit: 1, guard_drop: 1 };
  function passes(e) {
    if (FEED.onlySeat && e.role !== undefined && seatKey(e) !== D.selected) return false;
    switch (FEED.filter) {
      case 'all': return true;
      case 'rejected': return (e.type === 'intent' && !e.ack.ok) || e.type === 'guard_drop' || (e.type === 'policy_deploy' && !e.ok);
      case 'control': return e.type in CONTROL;
      case 'policy': return e.type === 'intent' && e.source === 'policy';
      default: return (e.type === 'intent' && (e.source === 'agent' || e.source === 'owner' || e.source === 'stream')) || e.type in CONTROL;
    }
  }
  function feedRow(e) {
    const li = el('li');
    li.append(el('span', 't', clock(e.at)), el('span', 'tick', e.tick));
    const body = el('span', 'body');
    if (e.role !== undefined) {
      const who = el('span', 'who', seatKey(e));
      who.style.color = teamColor(e.team);
      body.append(who);
    }
    if (e.source) body.append(el('span', 'src ' + e.source, e.source));
    switch (e.type) {
      case 'intent':
        body.append(el('span', 'what', intentText(e)), ackBadge(e.ack));
        break;
      case 'observe':
        body.append(el('span', 'what', 'observation delivered · ' + bytes(e.bytes)));
        break;
      case 'policy_call':
        body.append(el('span', 'what', 'policy v' + e.version + ' call · ' + e.ms.toFixed(1) + ' ms · ' + plural(e.intents, 'intent')));
        if (e.error) body.append(el('span', 'ack bad', e.error));
        break;
      case 'controller':
        body.append(el('span', 'what', 'controller ' + e.previous + ' → ' + e.controller + (e.poolPolicy ? ' (' + e.poolPolicy + ')' : '')));
        break;
      case 'mandate':
        body.append(el('span', 'what', 'mandate ' + mandateText(e.mandate)));
        break;
      case 'policy_deploy':
        body.append(el('span', 'what', e.ok ? (e.rollback ? 'rolled back to policy v' : 'deployed policy v') + e.version : 'policy deploy failed'));
        if (!e.ok && e.error) body.append(el('span', 'ack bad', e.error.code));
        break;
      case 'practice':
        body.append(el('span', 'what', 'practice vs ' + e.opponent + ' · ' + (e.result.ok ? e.result.ticks + ' ticks · ' + e.result.outcome : 'failed (' + e.result.code + ')') + ' (' + (e.result.wallMs / 1000).toFixed(1) + ' s)'));
        break;
      case 'match_created':
        li.className = 'sys';
        body.append(el('span', 'what', 'match created'));
        break;
      case 'match_ended':
        li.className = 'sys';
        body.append(el('span', 'what', 'match ended · ' + (outcomeSummary(e.outcomes) || compact(e.outcomes))));
        break;
      case 'forfeit':
        li.className = 'sys';
        body.append(el('span', 'what', e.team + ' forfeited'));
        break;
      case 'guard_drop':
        li.className = 'sys';
        body.append(el('span', 'what', 'outbound guard dropped ' + e.channel), el('span', 'ack warn', e.code + (e.path && e.path.length ? ' @ ' + e.path.join('.') : '')));
        break;
      default:
        body.append(el('span', 'what', e.type));
    }
    li.append(body);
    return li;
  }
  function feedEmptyText() {
    const scope = FEED.onlySeat && D.selected ? ' for ' + D.selected : '';
    switch (FEED.filter) {
      case 'policy': return 'No policy intents yet' + scope + '. They appear once a seat runs a deployed policy.';
      case 'rejected': return 'Nothing rejected' + scope + '. Refused intents, failed deploys and guard drops show up here.';
      case 'control': return 'No control events yet' + scope + ': controller and mandate changes, deploys, practice runs and match start/end.';
      case 'all': return 'Nothing has happened in this session yet' + scope + '.';
      default: return 'No agent activity yet' + scope + '. Intents from agents and owners, and control changes, appear here as they happen.';
    }
  }
  RENDER.feed = () => {
    D.pending = [];
    const list = $('feed');
    const rows = [];
    for (let i = D.feed.length - 1; i >= 0 && rows.length < FEED_SHOW; i--) if (passes(D.feed[i])) rows.push(feedRow(D.feed[i]));
    if (!rows.length) rows.push(el('li', 'empty', feedEmptyText()));
    list.replaceChildren(...rows);
    $('feedTitle').textContent = FEED.paused ? 'Feed · paused' : 'Feed';
  };
  RENDER.feedAppend = () => {
    if (!D.pending.length || FEED.paused) return;
    const list = $('feed');
    const empty = list.querySelector('li.empty');
    if (empty) empty.remove();
    const keep = list.scrollTop > 4;
    const before = list.scrollHeight;
    const frag = document.createDocumentFragment();
    for (let i = D.pending.length - 1; i >= 0; i--) {
      const li = feedRow(D.pending[i]);
      li.classList.add('new');
      frag.append(li);
    }
    D.pending = [];
    list.prepend(frag);
    while (list.childElementCount > FEED_SHOW) list.lastElementChild.remove();
    if (keep) list.scrollTop += list.scrollHeight - before;
  };
  const fButtons = Array.from($('filters').querySelectorAll('button'));
  function setFilter(f) {
    FEED.filter = f;
    for (const b of fButtons) {
      const on = b.dataset.f === f;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    schedule('feed');
  }
  for (const b of fButtons) b.addEventListener('click', () => setFilter(b.dataset.f));
  roving($('filters'), 'button', (b) => b.getAttribute('aria-checked') === 'true', (b) => setFilter(b.dataset.f));
  $('onlySeat').addEventListener('change', (e) => {
    FEED.onlySeat = e.target.checked;
    schedule('feed');
  });
  function togglePause() {
    FEED.paused = !FEED.paused;
    const b = $('pause');
    b.setAttribute('aria-pressed', String(FEED.paused));
    b.textContent = FEED.paused ? 'Resume' : 'Pause';
    b.title = FEED.paused ? 'Resume the feed ( p )' : 'Pause the feed ( p )';
    schedule('feed');
  }
  $('pause').addEventListener('click', togglePause);

  // ================================================================ agents
  const AG = { data: null, dataQ: null, error: null, q: '', limit: 100, req: 0, deferred: false };
  function agentsEnter(q) {
    AG.q = q;
    if ($('agFilter').value !== q) $('agFilter').value = q;
    schedule('agents');
    setPoll(pollAgents);
  }
  function agentsSetQuery(q) {
    if (q === AG.q) return;
    AG.q = q;
    if ($('agFilter').value.trim() !== q) $('agFilter').value = q;
    schedule('agents');
    setPoll(pollAgents);
  }
  async function pollAgents() {
    const req = ++AG.req;
    const q = AG.q;
    try {
      const data = await api('/agents?q=' + encodeURIComponent(q) + '&limit=' + AG.limit, { signal: navCtl.signal });
      if (req !== AG.req) return;
      AG.data = data;
      AG.dataQ = q;
      AG.error = null;
    } catch (err) {
      if (isAbort(err) || err.handled || req !== AG.req) return;
      AG.error = err;
    }
    schedule('agents');
  }
  let filterTimer = 0;
  function onFilterInput() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      if (current.section !== 'agents') return;
      const q = $('agFilter').value.trim();
      history.replaceState(null, '', '#agents' + (q ? '?q=' + encodeURIComponent(q) : ''));
      current.q = q;
      agentsSetQuery(q);
    }, 250);
  }
  $('agFilter').addEventListener('input', onFilterInput);
  $('agFilter').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if ($('agFilter').value) {
      $('agFilter').value = '';
      onFilterInput();
    } else $('agFilter').blur();
  });
  $('agMore').addEventListener('click', () => {
    AG.limit = 500;
    $('agMore').hidden = true;
    setPoll(pollAgents);
  });
  function agNotice(text, bad) {
    const n = $('agNotice');
    n.textContent = text;
    n.className = 'note-line' + (bad ? ' bad' : '');
    clearTimeout(n._t);
    n._t = setTimeout(() => { n.textContent = ''; }, 10000);
  }
  RENDER.agents = () => {
    if (anyDialogOpen()) {
      AG.deferred = true;
      return;
    }
    const box = $('agBody');
    if (selectionInside(box)) return;
    const d = AG.data;
    const count = $('agCount');
    if (!d) {
      count.textContent = '';
      box.replaceChildren(AG.error ? errorCard('Could not load agents', AG.error, () => setPoll(pollAgents)) : skeleton(0, 8));
      return;
    }
    $('agOauthNote').hidden = d.oauth;
    let countText = '';
    if (AG.dataQ !== AG.q) countText = 'Filtering…';
    else if (d.total) countText = 'Showing ' + d.owners.length + ' of ' + plural(d.total, 'owner') + ' · limit ' + AG.limit;
    if (count.textContent !== countText) count.textContent = countText;
    $('agMore').hidden = !(d.owners.length < d.total && AG.limit < 500);
    keepFocus(box, () => {
      const nodes = [];
      if (AG.error && AG.error.code !== 'network') nodes.push(staleNote(AG.error));
      if (!d.owners.length) {
        const c = el('div', 'empty-card');
        if (AG.dataQ) {
          c.append(el('h2', '', 'No owner matches “' + AG.dataQ + '”'), el('p', '', 'The filter matches any part of the owner id.'));
          const row = el('div', 'row');
          row.append(button('Clear filter', 'ghost', () => {
            $('agFilter').value = '';
            onFilterInput();
            $('agFilter').focus();
          }));
          c.append(row);
        } else {
          c.append(
            el('h2', '', 'No agent owners yet'),
            el('p', '', 'Create named commanders through host.commanders.create(owner, { name, kind, roles, isolation }). Each entry has its own persistent token and compatible roles; multiple entries may support the same role. host.commanders.ensure(owner) creates only an empty registry.'),
          );
        }
        nodes.push(c);
      }
      for (const o of d.owners) nodes.push(ownerBox(o, d));
      box.replaceChildren(...nodes);
    });
  };
  function table(headers, rows) {
    const wrap = el('div', 'table-wrap');
    const t = el('table', 'table');
    const tr = el('tr');
    for (const h of headers) {
      const th = el('th', '', h || '');
      th.scope = 'col';
      if (!h) th.append(el('span', 'sr', 'Actions'));
      tr.append(th);
    }
    const thead = el('thead');
    thead.append(tr);
    const tbody = el('tbody');
    tbody.append(...rows);
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }
  function td(content, cls) {
    const c = el('td', cls);
    if (content instanceof Node) c.append(content);
    else if (content !== undefined && content !== null) c.textContent = String(content);
    return c;
  }
  function ownerBox(o, d) {
    const box = el('article', 'box owner');
    const head = el('div', 'box-head');
    const h = el('h2', '', o.owner);
    head.append(h, activity(o.activeNow, o.lastSeenAt, 'never seen'), el('span', 'muted', plural(o.commanders.length, 'commander') + (d.oauth ? ' · ' + plural(o.connections.length, 'connection') : '')));
    box.append(head);
    box.append(el('div', 'table-title', 'Commanders'));
    if (o.commanders.length) {
      box.append(table(['Role', 'Preference', 'Seat', 'Mandate', 'Scopes', 'Activity', 'Policy', 'Rejections · ' + d.window.minutes + ' min', ''], o.commanders.map((c) => commanderRow(o.owner, c))));
    } else box.append(el('div', 'none', 'No commanders in this roster.'));
    if (d.oauth) {
      box.append(el('div', 'table-title', 'Sign-in connections'));
      if (o.connections.length) box.append(table(['Client', 'Registered as', 'Software', 'Roles', 'Signed in', 'Activity', ''], o.connections.map((c) => connectionRow(o.owner, c))));
      else box.append(el('div', 'none', 'No agent has signed in for this owner yet.'));
    }
    return box;
  }
  function commanderRow(owner, c) {
    const tr = el('tr');
    const pref = el('span', 'ctl ' + c.kind, c.kind);
    let seat;
    if (c.seated) {
      seat = link('#sessions/' + encodeURIComponent(c.seated.session), c.seated.team + ' · ' + shortId(c.seated.session), 'mono');
      seat.title = 'Open session ' + c.seated.session;
      seat.dataset.fkey = 'cs|' + owner + '|' + c.id;
    } else seat = el('span', 'muted', 'not in a session');
    const scopes = el('div', 'chips');
    for (const s of c.scopes) scopes.append(el('span', 'chip on', s));
    if (!c.scopes.length) scopes.append(el('span', 'muted', 'none'));
    const policy = el('div');
    policy.append(el('span', 'mono', Object.entries(c.policy.activeByRole).map(([role, version]) => role + ': ' + (version === null ? 'none' : 'v' + version)).join(' · ')), el('span', 'sub-text', plural(c.policy.versions, 'version') + ' in library'));
    for (const entry of c.approvals) if (entry.approval.status === 'pending') policy.append(el('span', 'badge-pending', entry.role + ' · approval pending · ' + entry.approval.kind + ' v' + entry.approval.version));
    const rej = el('div', 'chips');
    for (const r of c.rejections) rej.append(el('span', 'chip bad', r.code + ' ×' + r.count));
    if (!c.rejections.length) rej.append(el('span', 'muted', '—'));
    const rotate = button('Rotate token', 'ghost sm', () => confirmAction({
      title: 'Rotate commander token?',
      target: owner + ' · ' + c.name,
      body: "The current token for this commander stops working immediately, including inside a live match: the agent using it is cut off on its next call. The owner gets the new token from your game's own UI; the console never shows it.",
      ok: 'Rotate token',
      run: () => api('/agents/rotate', { json: { owner, commander: c.id } }),
      done: 'Rotated the ' + c.name + ' token for ' + owner + '. The old token no longer works.',
    }));
    rotate.setAttribute('aria-label', 'Rotate token for ' + owner + ' ' + c.name);
    rotate.dataset.fkey = 'rot|' + owner + '|' + c.id;
    const mandate = el('div', 'mandate', mandateText(c.mandate));
    mandate.title = compact(c.mandate && c.mandate.directive, 2000);
    tr.append(
      td(el('b', 'mono', c.name + ' · ' + c.roles.join(', '))),
      td(pref),
      td(seat),
      td(mandate),
      td(scopes),
      td(activity(c.connected, c.lastSeenAt, 'never connected')),
      td(policy),
      td(rej),
      td(rotate),
    );
    return tr;
  }
  function connectionRow(owner, c) {
    const tr = el('tr');
    const name = el('div');
    name.append(el('b', '', c.client.name));
    if (c.client.uri) name.append(el('span', 'sub-text mono', c.client.uri));
    const reg = c.client.registration === 'cimd'
      ? (() => {
        const x = el('div');
        x.append(el('span', 'mono', c.domain || 'unknown domain'), el('span', 'sub-text', 'client metadata document (CIMD)'));
        return x;
      })()
      : el('span', 'muted', 'self-registered (DCR)');
    const sw = [c.client.softwareId, c.client.softwareVersion].filter(Boolean).join(' ');
    const roles = el('div', 'chips');
    for (const r of c.roles) roles.append(el('span', 'chip', r));
    if (!c.roles.length) roles.append(el('span', 'muted', 'none'));
    const signed = el('div');
    signed.append(relTime(c.authorizedAt));
    const revoke = button('Revoke', 'danger sm', () => confirmAction({
      title: 'Revoke this sign-in?',
      target: c.client.name + ' · ' + owner,
      body: 'The agent is signed out right away and loses access to ' + owner + "'s commanders. It must sign in again before it can observe or act.",
      ok: 'Revoke sign-in',
      run: () => api('/agents/revoke', { json: { owner, connection: c.id } }),
      done: 'Revoked ' + c.client.name + ' for ' + owner + '. It must sign in again.',
    }));
    revoke.setAttribute('aria-label', 'Revoke ' + c.client.name + ' for ' + owner);
    revoke.dataset.fkey = 'rev|' + owner + '|' + c.id;
    tr.append(
      td(name),
      td(reg),
      td(sw || '—', sw ? 'mono' : 'muted'),
      td(roles),
      td(signed),
      td(activity(c.active, c.lastSeenAt, 'not seen since sign-in')),
      td(revoke),
    );
    return tr;
  }

  // ---------------------------------------------------------------- confirm dialog
  let confirmRun = null;
  function confirmAction(o) {
    confirmRun = o;
    $('cfTitle').textContent = o.title;
    $('cfTarget').textContent = o.target;
    $('cfBody').textContent = o.body;
    $('cfErr').textContent = '';
    $('cfOk').textContent = o.ok;
    $('cfOk').disabled = false;
    $('confirmDialog').showModal();
  }
  $('cfCancel').addEventListener('click', () => $('confirmDialog').close());
  $('cfOk').addEventListener('click', async () => {
    const o = confirmRun;
    if (!o) return;
    const btn = $('cfOk');
    btn.disabled = true;
    btn.textContent = 'Working…';
    try {
      await o.run();
      if (confirmRun === o) $('confirmDialog').close();
      (o.notice || agNotice)(o.done);
      if (o.after) o.after();
      else if (current.section === 'agents') setPoll(pollAgents);
    } catch (err) {
      if (err.handled) return;
      if (confirmRun !== o) {
        (o.notice || agNotice)(actionError(err), true);
        return;
      }
      $('cfErr').textContent = actionError(err);
      btn.disabled = false;
      btn.textContent = o.ok;
    }
  });
  $('confirmDialog').addEventListener('close', () => {
    confirmRun = null;
    if (AG.deferred) {
      AG.deferred = false;
      schedule('agents');
    }
    if (PO.deferred) {
      PO.deferred = false;
      schedule('policies');
    }
  });

  // ================================================================ shared bits for the part-2 sections
  function stat(label, value, sub, tone) {
    const c = el('div', 'card-link stat');
    c.append(el('span', 'card-label', label), el('b', 'card-value' + (tone ? ' ' + tone : ''), value));
    if (sub) c.append(el('span', 'card-sub', sub));
    return c;
  }
  function boxOf(title, aside, ...children) {
    const box = el('section', 'box');
    const head = el('div', 'box-head');
    head.append(el('h2', '', title));
    if (aside) head.append(typeof aside === 'string' ? el('span', 'muted', aside) : aside);
    box.append(head, ...children);
    return box;
  }
  function noteIn(id, text, bad) {
    const n = $(id);
    n.textContent = text;
    n.className = 'note-line' + (bad ? ' bad' : '');
    clearTimeout(n._t);
    n._t = setTimeout(() => { n.textContent = ''; }, 10000);
  }
  const wld = (s) => s.wins + '/' + s.losses + '/' + s.draws;
  const pct = (x) => (x * 100).toFixed(1) + '%';
  function codeChips(codes, cls, emptyText) {
    const chips = el('div', 'chips');
    for (const c of codes) chips.append(el('span', 'chip ' + (typeof cls === 'function' ? cls(c) : cls), c.code + ' ×' + c.count));
    if (!codes.length) chips.append(el('span', 'muted', emptyText));
    return chips;
  }
  /** Markdown subset (headings, paragraphs, lists, tables, code, bold, links) built with textContent only. */
  function inlineMd(text, onLink) {
    const frag = document.createDocumentFragment();
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) frag.append(el('code', '', m[1].slice(1, -1)));
      else if (m[2]) frag.append(el('b', '', m[2].slice(2, -2)));
      else frag.append((onLink && onLink(m[3], m[4])) || el('span', 'md-link', m[3]));
      last = re.lastIndex;
    }
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
    return frag;
  }
  function markdown(src, onLink) {
    const out = el('div', 'md');
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    const block = /^(#{1,6}\s|```|\s*\||\s*[-*]\s+)/;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('```')) {
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
        i++;
        out.append(el('pre', 'logs', buf.join('\n')));
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const n = el('h' + Math.min(6, h[1].length + 2));
        n.append(inlineMd(h[2], onLink));
        out.append(n);
        i++;
        continue;
      }
      if (/^\s*\|/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const body = rows.slice(rows.length > 1 && /^[\s|:-]+$/.test(rows[1]) ? 2 : 1).map((r) => {
          const tr = el('tr');
          for (const c of cells(r)) {
            const cell = el('td');
            cell.append(inlineMd(c, onLink));
            tr.append(cell);
          }
          return tr;
        });
        out.append(table(cells(rows[0]), body));
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const ul = el('ul');
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          const li = el('li');
          li.append(inlineMd(lines[i++].replace(/^\s*[-*]\s+/, ''), onLink));
          ul.append(li);
        }
        out.append(ul);
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !block.test(lines[i])) buf.push(lines[i++]);
      const p = el('p');
      p.append(inlineMd(buf.join(' '), onLink));
      out.append(p);
    }
    return out;
  }

  // ================================================================ policies
  const PO = { data: null, error: null, deferred: false };
  async function pollPolicies() {
    try {
      PO.data = await api('/policies', { signal: navCtl.signal });
      PO.error = null;
    } catch (err) {
      if (isAbort(err) || err.handled) return;
      PO.error = err;
    }
    schedule('policies');
  }
  const ERROR_KIND_TONE = { crash: 'bad', timeout: 'warn', error: '' };
  RENDER.policies = () => {
    if (anyDialogOpen()) {
      PO.deferred = true;
      return;
    }
    const box = $('poBody');
    if (selectionInside(box)) return;
    if (!PO.data) {
      box.replaceChildren(PO.error ? errorCard('Could not load policies', PO.error, () => setPoll(pollPolicies)) : skeleton(4, 6));
      return;
    }
    keepFocus(box, () => {
      const d = PO.data;
      const nodes = [];
      if (PO.error && PO.error.code !== 'network') nodes.push(staleNote(PO.error));
      if (!d.modes.policy && !d.modes.pool) {
        const c = el('div', 'empty-card');
        c.append(el('h2', '', 'This game has no policy mode'), el('p', '', 'Agents can only act through intents here: the manifest declares neither control.policy (deployed code) nor control.pool (published policies). Add them to your manifest to let agents author bots.'));
        box.replaceChildren(...nodes, c);
        return;
      }
      const w = d.errors.window;
      const byKind = { crash: 0, timeout: 0, error: 0 };
      for (const c of w.codes) byKind[c.kind] += c.count;
      const versions = d.libraries.reduce((n, l) => n + l.versions.length, 0);
      const cards = el('div', 'cards');
      cards.append(
        stat('Libraries', d.libraries.length, plural(versions, 'version') + ' across owners and roles'),
        stat('Pool entries', d.pool.length, d.modes.pool ? d.pool.filter((p) => p.disabled).length + ' disabled' : 'pool mode off'),
        stat('Crashes · ' + w.minutes + ' min', byKind.crash, 'threw or ran out of memory', byKind.crash ? 'bad' : ''),
        stat('Timeouts · ' + w.minutes + ' min', byKind.timeout, d.modes.policy ? 'over the ' + d.modes.policy.msPerCall + ' ms per-call budget' : '', byKind.timeout ? 'bad' : ''),
        stat('Other errors · ' + w.minutes + ' min', byKind.error, 'bad output, failed deploys', byKind.error ? 'bad' : ''),
      );
      nodes.push(cards);
      nodes.push(librariesBox(d));
      nodes.push(poolBox(d));
      nodes.push(policyErrorsBox(d));
      box.replaceChildren(...nodes);
    });
  };
  /** Save one library version as its `playerthree.policy/1` package (spec §13.1): `<commander>-v<version>.json`. */
  async function downloadPackage(l, v, btn) {
    btn.disabled = true;
    try {
      const r = await api('/policies/package?owner=' + encodeURIComponent(l.owner) + '&commander=' + encodeURIComponent(l.commander) + '&version=' + v.version, { raw: true });
      const blob = await r.blob();
      const name = filenameFrom(r.headers.get('content-disposition')) || l.commander + '-v' + v.version + '.json';
      const url = URL.createObjectURL(blob);
      const a = link(url, null);
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      noteIn('poNotice', 'Saved ' + name + ' (' + bytes(blob.size) + ').');
    } catch (err) {
      if (isAbort(err) || err.handled) return;
      noteIn('poNotice', 'Download failed: ' + (err instanceof ApiError ? actionError(err) : 'the download was interrupted.'), true);
    } finally {
      btn.disabled = false;
    }
  }
  function librariesBox(d) {
    if (!d.libraries.length) {
      return boxOf('Libraries · owner × role', '0', el('div', 'empty', 'No commander has a policy library yet. A library version is created each time an owner\'s agent deploys a policy (game_policy_deploy); the active one plays every match the commander is seated in.'));
    }
    const rows = d.libraries.map((l) => {
      const tr = el('tr');
      const owner = link('#agents?q=' + encodeURIComponent(l.owner), l.owner, 'mono');
      owner.dataset.fkey = 'lo|' + l.owner + '|' + l.commander;
      const vs = el('div', 'versions');
      for (const v of l.versions) {
        const active = v.role !== null && v.version === l.activeByRole[v.role];
        const row = el('div', 'version' + (active ? ' active' : ''));
        row.append(el('span', 'chip' + (active ? ' on' : ''), 'v' + v.version + (active ? ' · active' : '')), el('span', '', v.role ?? 'Unassigned legacy role: redeploy'), el('span', 'mono', v.runtime), el('span', 'mono', bytes(v.bytes)));
        const created = el('span', 'muted');
        created.append(relTime(v.createdAt, 'created '));
        row.append(created);
        if (v.role !== null) {
          const dl = button('Download', 'ghost sm', () => downloadPackage(l, v, dl));
          dl.title = 'Save this version as a portable policy package (' + l.commander + '-v' + v.version + '.json)';
          dl.dataset.fkey = 'lv|' + l.commander + '|' + v.version;
          row.append(dl);
        }
        vs.append(row);
      }
      if (!l.versions.length) vs.append(el('span', 'muted', 'no versions'));
      const practice = el('td');
      if (l.lastPractice) {
        const p = l.lastPractice;
        practice.append(el('span', 'pill ' + p.outcome, p.outcome), el('span', 'sub-text', 'v' + p.version + ' vs ' + p.opponent + ' · ' + p.ticks + ' ticks · seed ' + p.seed));
        const when = el('span', 'sub-text');
        when.append(relTime(p.at));
        practice.append(when);
      } else practice.append(el('span', 'muted', 'never'));
      const seated = l.seated ? link('#sessions/' + encodeURIComponent(l.seated.session), l.seated.team + ' · ' + shortId(l.seated.session), 'mono') : el('span', 'muted', 'lobby');
      tr.append(td(owner), td(l.name + ' · ' + l.roles.join(', '), 'mono'), td(l.active === null ? el('span', 'muted', 'none') : el('span', 'chip on', 'v' + l.active)), td(vs), practice, td(wld(l.record), 'num'), td(seated));
      return tr;
    });
    return boxOf('Libraries · named commander', plural(d.libraries.length, 'commander'), table(['Owner', 'Commander / compatible roles', 'Active', 'Versions (runtime · size · created · package)', 'Last practice', 'W/L/D', 'Seated'], rows));
  }
  function poolBox(d) {
    if (!d.modes.pool) return boxOf('Bot pool', 'off', el('div', 'empty', 'This game has no pool mode (manifest.control.pool): agents cannot publish policies for others to fight.'));
    if (!d.pool.length) return boxOf('Bot pool', '0', el('div', 'empty', 'Nothing published yet. Agents publish their policy with game_publish; drafted entries play seats with controller "policy" (async opponents, ladders).'));
    const rows = d.pool.map((p) => {
      const tr = el('tr');
      const pub = el('td');
      if (p.publisherOwner) {
        const a = link('#agents?q=' + encodeURIComponent(p.publisherOwner), p.publisherOwner, 'mono');
        a.dataset.fkey = 'pp|' + p.id;
        pub.append(a);
      } else pub.append(el('span', 'muted', 'no owner roster'));
      pub.append(el('span', 'sub-text', p.publisher.kind === 'commander' ? 'commander' : 'session ' + shortId(p.publisher.session) + ' · ' + p.publisher.team));
      const created = el('td');
      created.append(relTime(p.createdAt));
      const status = td(el('span', 'pill ' + (p.disabled ? 'failed' : 'running'), p.disabled ? 'disabled' : 'draftable'));
      const actions = el('td');
      const toggle = button(p.disabled ? 'Enable' : 'Disable', 'ghost sm', () => confirmAction({
        title: p.disabled ? 'Enable this pool entry?' : 'Disable this pool entry?',
        target: p.id + ' · ' + p.role,
        body: p.disabled ? 'The pool can draft it into seats again.' : 'The pool stops drafting it into new seats and it cannot be picked explicitly. Seats already running it keep playing; you can enable it again.',
        ok: p.disabled ? 'Enable' : 'Disable',
        run: () => api('/policies/pool', { json: { id: p.id, action: p.disabled ? 'enable' : 'disable' } }),
        done: (p.disabled ? 'Enabled ' : 'Disabled ') + p.id + '.',
        notice: (t, bad) => noteIn('poNotice', t, bad),
        after: () => setPoll(pollPolicies),
      }));
      toggle.dataset.fkey = 'pt|' + p.id;
      const remove = button('Unpublish', 'danger sm', () => confirmAction({
        title: 'Unpublish this pool entry?',
        target: p.id + ' · ' + p.role,
        body: 'The entry and its artifact are deleted from the pool for good; its results are lost. Seats that already loaded it keep playing until their match ends.',
        ok: 'Unpublish',
        run: () => api('/policies/pool', { json: { id: p.id, action: 'unpublish' } }),
        done: 'Unpublished ' + p.id + '.',
        notice: (t, bad) => noteIn('poNotice', t, bad),
        after: () => setPoll(pollPolicies),
      }));
      remove.dataset.fkey = 'pu|' + p.id;
      const row = el('div', 'row-actions');
      row.append(toggle, remove);
      actions.append(row);
      tr.append(td(p.id, 'mono'), td(p.role, 'mono'), td(p.runtime, 'mono'), pub, td(p.drafts, 'num'), td(wld(p), 'num'), created, status, actions);
      return tr;
    });
    return boxOf('Bot pool', d.pool.length + (d.pool.length === 1 ? ' entry' : ' entries'), table(['Entry', 'Role', 'Runtime', 'Publisher', 'Drafts', 'W/L/D', 'Published', 'Status', ''], rows));
  }
  function policyErrorsBox(d) {
    const e = d.errors;
    const parts = [];
    parts.push(el('p', 'quiet', 'Last ' + e.window.minutes + ' min: ' + plural(e.window.total, 'policy error') + '. Recent sessions (' + plural(e.history.sessions, 'session') + '): ' + plural(e.history.total, 'policy error') + '.'));
    const kindTone = (c) => ERROR_KIND_TONE[c.kind] || '';
    const codes = el('div', 'kv-wide');
    codes.append(el('span', 'hash-label', 'Last ' + e.window.minutes + ' min'), codeChips(e.window.codes, kindTone, 'none'), el('span', 'hash-label', 'Recent sessions'), codeChips(e.history.codes, kindTone, 'none'));
    parts.push(codes);
    if (e.window.seats.length) {
      const rows = e.window.seats.map((s) => {
        const tr = el('tr');
        tr.append(td(link('#sessions/' + encodeURIComponent(s.session), shortId(s.session), 'mono')), td(s.team + '/' + s.role, 'mono'), td(s.owner ? link('#agents?q=' + encodeURIComponent(s.owner), s.owner, 'mono') : el('span', 'muted', '—')), td(s.crash, 'num' + (s.crash ? ' bad' : '')), td(s.timeout, 'num' + (s.timeout ? ' bad' : '')), td(s.error, 'num'));
        return tr;
      });
      parts.push(table(['Session', 'Seat', 'Owner', 'Crashes', 'Timeouts', 'Other'], rows));
    }
    if (e.live.length) {
      const rows = e.live.map((s) => {
        const tr = el('tr');
        tr.append(
          td(link('#sessions/' + encodeURIComponent(s.session), shortId(s.session), 'mono')),
          td(s.team + '/' + s.role, 'mono'),
          td(s.poolPolicy ? 'pool ' + s.poolPolicy : 'v' + s.version + ' · ' + s.runtime, 'mono'),
          td(s.calls, 'num'),
          td(s.timeouts, 'num' + (s.timeouts ? ' bad' : '')),
          td(s.errors, 'num' + (s.errors ? ' bad' : '')),
          td(s.meanMs.toFixed(2) + ' / ' + s.maxMs.toFixed(2), 'num'),
          td(s.lastError || '—', s.lastError ? 'mono' : 'muted'),
        );
        return tr;
      });
      parts.push(el('h3', 'sub', 'Policies running in live sessions'), table(['Session', 'Seat', 'Policy', 'Calls', 'Timeouts', 'Errors', 'Mean / max ms', 'Last error'], rows));
    } else parts.push(el('div', 'empty', 'No policy is running in a live session right now.'));
    return boxOf('Crashes, timeouts and errors', null, ...parts);
  }

  // ================================================================ bench (read-only: runs start from the CLI)
  const BN = { data: null, error: null, loading: false, reports: {} };
  const BENCH_CLI = 'playerthree-bench --config <bench.config.ts> --out <benchResultsDir>';
  function benchEnter() {
    schedule('bench');
    if (!BN.data && !BN.loading) loadBench();
  }
  async function loadBench() {
    BN.loading = true;
    BN.reports = {};
    schedule('bench');
    try {
      BN.data = await api('/bench', { signal: navCtl.signal });
      BN.error = null;
    } catch (err) {
      if (!isAbort(err) && !err.handled) BN.error = err;
    } finally {
      BN.loading = false;
      schedule('bench');
    }
  }
  $('bnReload').addEventListener('click', () => loadBench());
  RENDER.bench = () => {
    const box = $('bnBody');
    $('bnReload').disabled = BN.loading;
    $('bnReload').textContent = BN.loading ? 'Reading…' : 'Reload';
    if (selectionInside(box)) return;
    if (!BN.data) {
      box.replaceChildren(BN.error ? errorCard('Could not read bench results', BN.error, () => loadBench()) : skeleton(0, 6));
      return;
    }
    keepFocus(box, () => {
      const d = BN.data;
      const nodes = [];
      if (BN.error && BN.error.code !== 'network') nodes.push(staleNote(BN.error));
      if (!d.configured || !d.results.length) {
        const c = el('div', 'empty-card');
        c.append(
          el('h2', '', d.configured ? 'No bench results yet' : 'No bench results directory configured'),
          el('p', '', d.configured
            ? 'Nothing with a results.json in ' + d.root + ' or its immediate subdirectories.'
            : 'Pass the directory your bench runs write to as the console\'s benchResultsDir option to list them here.'),
          el('p', '', 'Bench runs are started from the command line, not from this console (the model key stays with whoever runs it):'),
        );
        const cmd = el('pre', 'logs', BENCH_CLI);
        c.append(cmd, el('p', 'quiet', 'Then press Reload. Canonical series standings, entrant usage, latency and completeness appear here; available replay artifacts open in the timeline.'));
        nodes.push(c);
      } else {
        nodes.push(el('p', 'quiet', 'Results from ' + d.root + '. Runs are started from the command line (' + BENCH_CLI + '); this console only reads them.'));
        for (const r of d.results) nodes.push(benchResult(r));
      }
      box.replaceChildren(...nodes);
    });
  };
  function benchResult(r) {
    if (r.error) return boxOf(r.name, el('span', 'chip bad', 'unreadable'), el('div', 'empty', r.error));
    const aside = el('div', 'chips');
    aside.append(el('span', 'pill', r.state), el('span', 'chip' + (r.currentSurface ? ' on' : ' warn'), r.currentSurface ? 'current surface' : 'other surface'), el('span', 'chip', r.game + '@' + r.gameVersion));
    if (r.createdAt) aside.append(el('span', 'chip', new Date(r.createdAt).toLocaleString()));
    const parts = [
      el('p', 'quiet', 'Series ' + r.seriesId + ' · revision ' + r.revision + ' · ' + r.track + ' · held-out seeds ' + r.seeds.join(', ') + ' · tick cap ' + r.ticks),
      el('p', 'quiet', 'Budgets ' + compact(r.budgets, 160) + (r.authoring ? ' · authoring ' + compact(r.authoring, 160) : '')),
      el('p', 'quiet mono', 'Comparison identity ' + r.comparisonHash),
    ];
    if (!r.completeness.scheduleComplete || !r.completeness.rawComplete) parts.push(el('p', 'note-line bad', 'Incomplete recording: ' + (r.completeness.missing.join('; ') || 'schedule or raw data incomplete')));
    if (!r.currentSurface) parts.push(el('p', 'note-line bad', 'Measured against surface ' + r.surfaceHash.slice(0, 12) + '…, not this server\'s: results describe another tool surface.'));
    if (!r.sameGame) parts.push(el('p', 'note-line bad', 'Recorded with ' + r.game + '@' + r.gameVersion + '; replays only re-simulate on the same game version.'));
    const entrants = new Map(r.entrants.map((entrant) => [entrant.entrantId, entrant]));
    const standingRows = r.standings.map((standing) => {
      const entrant = entrants.get(standing.entrantId);
      const tr = el('tr');
      tr.append(td(standing.entrantId, 'mono'), td(entrant ? entrant.label : '—'), td(entrant ? entrant.kind : '—'),
        td(wld(standing), 'num'), td(standing.games, 'num'), td(standing.winRate === null ? '—' : pct(standing.winRate), 'num'),
        td(standing.scoreRate === null ? '—' : pct(standing.scoreRate), 'num'),
        td(standing.rating === null ? '—' : standing.rating.toFixed(1), 'num'), td(standing.provisional ? 'provisional' : 'rated'));
      return tr;
    });
    parts.push(el('h3', 'sub', 'Entrant standings'), standingRows.length
      ? table(['Entrant ID', 'Label', 'Kind', 'W/L/D', 'Games', 'Win rate', 'Score rate', 'Rating', 'Status'], standingRows)
      : el('div', 'empty', 'No committed matches yet.'));
    const usageRows = r.usage.map((usage) => {
      const tr = el('tr');
      tr.append(td(usage.entrantId, 'mono'), td(usage.phase), td(usage.reporter || 'unknown'),
        td(usage.inputTokens === null ? 'unknown' : usage.inputTokens, 'num'),
        td(usage.outputTokens === null ? 'unknown' : usage.outputTokens, 'num'),
        td(usage.costAmount === null ? 'unknown' : usage.costAmount + ' ' + (usage.currency || ''), 'num'), td(usage.coverage));
      return tr;
    });
    if (usageRows.length) parts.push(el('h3', 'sub', 'Usage'), table(['Entrant ID', 'Phase', 'Reporter', 'Input tokens', 'Output tokens', 'Cost', 'Coverage'], usageRows));
    const latencyRows = r.latency.map((latency) => {
      const tr = el('tr');
      tr.append(td(latency.entrantId, 'mono'), td(latency.source), td(latency.samples, 'num'),
        td(latency.p50Ms === null ? 'unknown' : latency.p50Ms, 'num'), td(latency.p95Ms === null ? 'unknown' : latency.p95Ms, 'num'));
      return tr;
    });
    if (latencyRows.length) parts.push(el('h3', 'sub', 'Decision latency'), table(['Entrant ID', 'Source', 'Samples', 'p50 ms', 'p95 ms'], latencyRows));
    const replays = el('details', 'bench-replays');
    replays.append(el('summary', '', 'Matches / attempts (' + r.matches.length + ')'));
    const rows = r.matches.map((m) => {
      const tr = el('tr');
      const open = r.sameGame && m.replay ? link('#bench?dir=' + encodeURIComponent(r.key) + '&replay=' + encodeURIComponent(m.replay), 'Open in timeline', 'ghost sm btn') : el('span', 'muted', m.replay ? 'other game version' : 'no replay');
      open.dataset.fkey = 'br|' + r.key + '|' + m.matchId;
      tr.append(td(m.matchId, 'mono'), td(m.attemptNumber, 'num'), td(m.acceptedAttempt ? 'accepted' : 'excluded'),
        td(m.seed === null ? '—' : m.seed, 'num'), td(m.mapId || '—', 'mono'),
        td(m.sideBindings.map((binding) => binding.entrantId + ' → ' + binding.team).join(', '), 'mono'),
        td(m.status + (m.terminalReason ? ': ' + m.terminalReason : '')),
        td(m.outcomes.map((outcome) => outcome.team + ': ' + outcome.outcome).join(', ')), td(m.ticks, 'num'), td(open));
      return tr;
    });
    replays.append(table(['Match', 'Attempt', 'Accounting', 'Seed', 'Map', 'Entrant → side', 'Status', 'Outcomes', 'Ticks', ''], rows));
    replays.open = Boolean(BN.reports['replays|' + r.key]);
    replays.addEventListener('toggle', () => {
      if (replays.open) BN.reports['replays|' + r.key] = { open: true };
      else delete BN.reports['replays|' + r.key];
    });
    parts.push(replays);
    if (r.report) {
      const rep = el('details', 'bench-report');
      rep.append(el('summary', '', 'report.md'));
      const body = el('div');
      rep.append(body);
      const cached = BN.reports[r.key];
      if (cached) body.append(cached.text !== undefined ? benchMarkdown(r, cached.text) : el('p', 'note-line bad', cached.error));
      else body.append(el('p', 'muted', 'Open to read the report.'));
      rep.open = Boolean(cached && cached.open);
      rep.addEventListener('toggle', () => {
        const c = BN.reports[r.key] || {};
        c.open = rep.open;
        BN.reports[r.key] = c;
        if (rep.open && c.text === undefined && !c.loading) loadReport(r.key);
      });
      parts.push(rep);
    }
    return boxOf(r.name, aside, ...parts);
  }
  function benchMarkdown(r, text) {
    // Canonical report links refer to persisted artifact files.
    return markdown(text, (label, href) => (r.sameGame && /^artifacts\//.test(href) ? link('#bench?dir=' + encodeURIComponent(r.key) + '&replay=' + encodeURIComponent(href), label) : null));
  }
  async function loadReport(key) {
    const c = BN.reports[key];
    c.loading = true;
    try {
      const r = await api('/bench/' + encodeURIComponent(key) + '/report', { signal: navCtl.signal });
      c.text = r.text;
    } catch (err) {
      if (isAbort(err) || err.handled) return;
      c.error = 'Could not read report.md: ' + errText(err) + '.';
    } finally {
      c.loading = false;
      schedule('bench');
    }
  }

  // ================================================================ safety
  const SF = { data: null, error: null };
  async function pollSafety() {
    try {
      SF.data = await api('/safety', { signal: navCtl.signal });
      SF.error = null;
    } catch (err) {
      if (isAbort(err) || err.handled) return;
      SF.error = err;
    }
    schedule('safety');
  }
  const SCOPE_TEXT = { act: 'intents and sequences', policy: 'deploy and roll back policies', practice: 'practice matches', publish: 'publish to the pool', say: 'reply to the owner' };
  RENDER.safety = () => {
    const box = $('sfBody');
    if (selectionInside(box)) return;
    if (!SF.data) {
      box.replaceChildren(SF.error ? errorCard('Could not load safety data', SF.error, () => setPoll(pollSafety)) : skeleton(3, 6));
      return;
    }
    keepFocus(box, () => {
      const d = SF.data;
      const nodes = [];
      if (SF.error && SF.error.code !== 'network') nodes.push(staleNote(SF.error));
      const hashRow = el('div', 'hash');
      const copy = button('Copy', 'ghost sm', async () => flashLabel(copy, (await copyText(d.surfaceHash)) ? 'Copied' : 'Copy failed', 'Copy'));
      copy.dataset.fkey = 'sf-copy';
      hashRow.append(el('span', 'hash-label', 'surface'), el('code', '', d.surfaceHash), copy);
      const hashBox = el('div', 'pad');
      hashBox.append(hashRow);
      nodes.push(boxOf('Surface', d.game.id + '@' + d.game.version, hashBox, el('p', 'quiet pad', 'Agents and the bench pin this hash: any change to the manifest, tools or skills changes it. A Safety Card describes exactly one surface.')));
      nodes.push(cardBox(d));
      // Modes and limits.
      const modeRows = Object.entries(d.modes).filter(([, v]) => v !== undefined && v !== null).map(([mode, cfg]) => {
        const tr = el('tr');
        const limits = el('div', 'chips');
        if (cfg && typeof cfg === 'object') for (const [k, v] of Object.entries(cfg)) limits.append(el('span', 'chip', k + ' ' + compact(v, 60)));
        tr.append(td(mode, 'mono'), td(limits));
        return tr;
      });
      nodes.push(boxOf('Enabled modes and limits', plural(modeRows.length, 'mode'), table(['Mode', 'Limits'], modeRows)));
      const scopeRows = d.scopes.all.map((s) => {
        const tr = el('tr');
        const on = d.scopes.defaults.includes(s);
        tr.append(td(s, 'mono'), td(SCOPE_TEXT[s] || ''), td(el('span', 'chip' + (on ? ' on' : ''), on ? 'granted by default' : 'unavailable (mode off)')));
        return tr;
      });
      nodes.push(boxOf('Seat scopes · defaults', 'owners can narrow them per commander', table(['Scope', 'Allows', 'Default for new seats'], scopeRows), el('p', 'quiet pad', 'Reading (briefing, observe, wait, skills, policy status) is always allowed. Out-of-scope calls fail with out_of_scope.')));
      const rw = d.rejections.window;
      const rh = d.rejections.history;
      const cards = el('div', 'cards');
      cards.append(
        stat('Rejections · last ' + rw.minutes + ' min', rw.rejections, 'agent, policy and stream inputs refused', rw.rejections ? 'bad' : ''),
        stat('Rejections · recent sessions', rh.rejections, rh.sessions ? plural(rh.sessions, 'session') + (rh.since ? ' since ' + new Date(rh.since).toLocaleString() : '') : 'no released sessions yet', rh.rejections ? 'bad' : ''),
        stat('Policy errors · recent sessions', rh.policyErrors, 'see Policies for crash and timeout details', rh.policyErrors ? 'bad' : ''),
      );
      const codeRows = (codes) => codes.map((c) => {
        const tr = el('tr');
        tr.append(td(c.code, 'mono'), td(c.count, 'num'));
        return tr;
      });
      const windows = el('div', 'split');
      windows.append(
        boxOf('Rejection codes · last ' + rw.minutes + ' min', null, rw.codes.length ? table(['Code', 'Count'], codeRows(rw.codes)) : el('div', 'empty', 'No rejected inputs in this window.')),
        boxOf('Rejection codes · recent sessions', historyLimits(rh), rh.codes.length ? table(['Code', 'Count'], codeRows(rh.codes)) : el('div', 'empty', 'No rejected inputs in the recent sessions history.')),
      );
      nodes.push(cards, windows);
      box.replaceChildren(...nodes);
    });
  };
  function cardBox(d) {
    const c = d.card;
    if (!c || c.error) {
      const parts = [];
      parts.push(el('p', 'pad', c ? c.error + ' (' + c.path + ')' : 'No Safety Card is configured for this console.'));
      parts.push(el('p', 'pad', 'Generate one with the PlayerThree CLI, publish it with your game, and pass its path as the console\'s safetyCard option:'));
      parts.push(el('pre', 'logs pad-block', d.audit));
      return boxOf('Safety Card', el('span', 'chip warn', c ? 'missing' : 'not configured'), ...parts);
    }
    const aside = el('div', 'chips');
    aside.append(el('span', 'chip' + (c.matchesSurface ? ' on' : ' bad'), c.matchesSurface ? 'matches this surface' : 'stale: generated for another surface'));
    const when = el('span', 'chip');
    when.append(relTime(c.modifiedAt, 'written '));
    aside.append(when);
    const parts = [el('p', 'quiet pad', c.path)];
    if (!c.matchesSurface) parts.push(el('p', 'note-line bad pad', 'The card does not mention this server\'s surface hash: run the audit again (' + d.audit + ').'));
    const md = markdown(c.text);
    md.classList.add('pad');
    parts.push(md);
    return boxOf('Safety Card', aside, ...parts);
  }

  // ================================================================ game settings (read-only)
  const ST = { data: null, error: null };
  async function pollSettings() {
    try {
      ST.data = await api('/settings', { signal: navCtl.signal });
      ST.error = null;
    } catch (err) {
      if (isAbort(err) || err.handled) return;
      ST.error = err;
    }
    schedule('settings');
  }
  function schemaType(s) {
    if (!s || typeof s !== 'object') return '—';
    if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
    if (s.const !== undefined) return JSON.stringify(s.const);
    if (Array.isArray(s.anyOf)) return s.anyOf.map(schemaType).join(' | ');
    let t = Array.isArray(s.type) ? s.type.join(' | ') : s.type || 'any';
    if (t === 'array' && s.items) t = schemaType(s.items) + '[]';
    const range = [];
    if (s.minimum !== undefined) range.push('≥ ' + s.minimum);
    if (s.maximum !== undefined) range.push('≤ ' + s.maximum);
    if (s.maxLength !== undefined) range.push('≤ ' + s.maxLength + ' chars');
    if (s.maxItems !== undefined) range.push('≤ ' + s.maxItems + ' items');
    return t + (range.length ? ' (' + range.join(', ') + ')' : '');
  }
  RENDER.settings = () => {
    const box = $('stBody');
    if (selectionInside(box)) return;
    if (!ST.data) {
      box.replaceChildren(ST.error ? errorCard('Could not load game settings', ST.error, () => setPoll(pollSettings)) : skeleton(0, 6));
      return;
    }
    keepFocus(box, () => {
      const d = ST.data;
      const nodes = [];
      if (ST.error && ST.error.code !== 'network') nodes.push(staleNote(ST.error));
      const props = d.schema && d.schema.properties ? Object.entries(d.schema.properties) : [];
      if (!d.schema) {
        const c = el('div', 'empty-card');
        c.append(el('h2', '', 'This game declares no match options'), el('p', '', 'Every session runs with the game\'s fixed rules. Declare manifest.matchOptions (an object of optional fields) to let your server pick rules per match; they show up here with their defaults and per-session values.'));
        box.replaceChildren(...nodes, c);
        return;
      }
      const defaults = d.defaults || {};
      const fieldRows = props.map(([name, s]) => {
        const tr = el('tr');
        const has = Object.prototype.hasOwnProperty.call(defaults, name);
        tr.append(td(name, 'mono'), td(schemaType(s), 'mono'), td(s.description || '—', s.description ? '' : 'muted'), td(has ? compact(defaults[name], 80) : 'game default', has ? 'mono' : 'muted'));
        return tr;
      });
      nodes.push(boxOf('Match options schema', 'manifest.matchOptions', table(['Option', 'Type', 'Description', 'Host default'], fieldRows), el('p', 'quiet pad', d.defaults ? 'Host defaults are the matchOptions the server passes to createPlayerThreeHost; each match merges its own options over them.' : 'The server sets no host defaults (createPlayerThreeHost matchOptions): unset options use the game\'s own defaults.')));
      const sessionRows = d.sessions.map((s) => {
        const tr = el('tr');
        const href = s.status === 'released' ? '#recent/' + encodeURIComponent(s.id) : '#sessions/' + encodeURIComponent(s.id);
        const a = link(href, shortId(s.id), 'mono');
        a.title = s.id;
        a.dataset.fkey = 'so|' + s.id;
        const cells = [td(a), td(el('span', 'pill status ' + (s.status === 'released' ? 'ended' : s.status), s.status))];
        for (const [name] of props) {
          const set = s.options && Object.prototype.hasOwnProperty.call(s.options, name);
          cells.push(td(set ? compact(s.options[name], 60) : 'game default', set ? 'mono' : 'muted'));
        }
        tr.append(...cells);
        return tr;
      });
      nodes.push(boxOf('Effective options per session', plural(d.sessions.length, 'session'), sessionRows.length ? table(['Session', 'Status'].concat(props.map(([n]) => n)), sessionRows) : el('div', 'empty', 'No live or recent sessions yet.')));
      const raw = el('details', 'bench-report');
      raw.append(el('summary', '', 'JSON Schema'), el('pre', 'logs', JSON.stringify(d.schema, null, 2)));
      nodes.push(raw);
      box.replaceChildren(...nodes);
    });
  };

  // ================================================================ keyboard
  let gAt = 0;
  function isTyping(t) {
    if (!t || !t.tagName) return false;
    if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    return t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'file'].includes(t.type);
  }
  function go(section) {
    const target = '#' + section;
    if (location.hash !== target) location.hash = target;
  }
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || gateState !== null || anyDialogOpen() || isTyping(e.target)) return;
    const k = e.key;
    if (gAt && Date.now() - gAt < 1200) {
      gAt = 0;
      const s = { o: 'overview', s: 'sessions', a: 'agents', p: 'policies', b: 'bench', y: 'safety', t: 'settings' }[k];
      if (s) {
        e.preventDefault();
        go(s);
      }
      return;
    }
    gAt = 0;
    if (k === 'g') {
      gAt = Date.now();
      return;
    }
    if (k >= '1' && k <= String(SECTIONS.length) && k.length === 1) {
      e.preventDefault();
      go(SECTIONS[Number(k) - 1]);
      return;
    }
    if (k === '/') {
      e.preventDefault();
      if (current.section === 'agents') {
        $('agFilter').focus();
        $('agFilter').select();
      } else {
        focusFilterOnEnter = true;
        go('agents');
      }
      return;
    }
    if (viewOf(current) !== 'session') return;
    if (k === '[' || k === ']') {
      e.preventDefault();
      step(k === '[' ? -1 : 1);
    } else if (k === 'l') {
      e.preventDefault();
      goLive();
    } else if (k === 'p' && !D.replay && D.phase === 'live') {
      e.preventDefault();
      togglePause();
    }
  });

  // ================================================================ start
  setFilter(FEED.filter);
  boot();
})();
