/**
 * INSTALLED APPS — slide-in panel for apps installed from IPFS, each running in its own Bucks
 * container (bucks-app://<id>, its own storage and window, only the network and features you
 * allow). Bucks-browser's bucks://apps screens (chrome/src/apps), in this app's panel style.
 *
 *   list → install (address, folder or a site you host) → review (each permission can be left
 *   off) → installed; details: open, permissions, tools, check for updates (new permissions are
 *   shown before updating), back to the previous version, host it (folder apps), uninstall.
 *
 * Talks to window.bucksApps (preload.js → hosting-bridge.js → electron/hosting/…/apps). Everything
 * an app supplies (name, description, tool names, warnings) is inserted with textContent.
 *
 * Opened from the menu ("Installed apps") or window.appsPanel.toggle().
 */
(function AppsPanel() {
  'use strict';

  if (window.__appsPanelInit) return;
  window.__appsPanelInit = true;

  const api = () => window.bucksApps;

  let root = null;
  let isOpen = false;
  let view = { name: 'list' }; // list | source | review | details | update | uninstall | busy
  let apps = [];
  let icons = new Map(); // app id → data: URL
  let message = null;    // { text, bad }
  let unsubscribe = null;

  /* ── DOM helper ─────────────────────────────────────────────────────── */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = Boolean(v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  function injectStyles() {
    if (document.getElementById('apps-panel-styles')) return;
    const s = document.createElement('style');
    s.id = 'apps-panel-styles';
    s.textContent = `
      #apps-panel-root { position: fixed; top: 0; right: -540px; bottom: 0; width: 520px; max-width: 100vw;
        z-index: 99996; background: rgba(8,10,18,.97); border-left: 1px solid rgba(167,139,250,.24);
        box-shadow: -20px 0 60px rgba(0,0,0,.6); backdrop-filter: blur(24px);
        font-family: 'Inter','SF Pro Display',system-ui,sans-serif; color: #e0e8ff; font-size: 13px;
        display: flex; flex-direction: column; transition: right .32s cubic-bezier(.16,1,.3,1); }
      #apps-panel-root.ap-open { right: 0; }
      .ap-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid rgba(167,139,250,.16); }
      .ap-head h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; }
      .ap-body { flex: 1; overflow-y: auto; padding: 16px 18px 28px; display: flex; flex-direction: column; gap: 14px; }
      .ap-sec h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8b95b8; font-weight: 600; }
      .ap-card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; padding: 12px; }
      .ap-card + .ap-card { margin-top: 8px; }
      .ap-btn { border: 1px solid rgba(167,139,250,.45); background: rgba(167,139,250,.16); color: #e0e8ff; border-radius: 8px;
        padding: 6px 12px; font: inherit; cursor: pointer; }
      .ap-btn:hover:not(:disabled) { background: rgba(167,139,250,.3); }
      .ap-btn:disabled { opacity: .45; cursor: default; }
      .ap-btn.ap-ghost { background: transparent; border-color: rgba(255,255,255,.14); padding: 4px 9px; font-size: 12px; }
      .ap-btn.ap-danger { border-color: rgba(255,71,87,.5); background: rgba(255,71,87,.14); }
      .ap-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .ap-row + .ap-row { margin-top: 8px; }
      .ap-grow { flex: 1; min-width: 0; }
      .ap-input { flex: 1; min-width: 0; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12); color: inherit;
        border-radius: 8px; padding: 7px 10px; font: inherit; }
      .ap-muted { color: #8b95b8; font-size: 12px; }
      .ap-chip { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: rgba(255,255,255,.08); white-space: nowrap; }
      .ap-chip.ok { background: rgba(46,213,115,.18); color: #2ed573; }
      .ap-chip.high { background: rgba(255,71,87,.18); color: #ff6b81; }
      .ap-chip.medium { background: rgba(255,179,71,.18); color: #ffb347; }
      .ap-chip.low { background: rgba(82,182,255,.16); color: #8fd0ff; }
      .ap-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; word-break: break-all; color: #b9c4ff; }
      .ap-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ap-title { font-size: 16px; font-weight: 650; }
      .ap-msg { padding: 8px 10px; border-radius: 8px; background: rgba(167,139,250,.14); }
      .ap-msg.bad { background: rgba(255,71,87,.14); color: #ff9aa6; }
      .ap-warn { padding: 8px 10px; border-radius: 8px; background: rgba(255,179,71,.12); color: #ffd08a; }
      .ap-icon { width: 36px; height: 36px; border-radius: 9px; flex-shrink: 0; object-fit: cover; background: rgba(167,139,250,.22);
        display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px; }
      .ap-perm { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-top: 1px solid rgba(255,255,255,.06); }
      .ap-perm:first-child { border-top: none; }
      .ap-perm input { margin-top: 3px; }
      .ap-dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; }
      .ap-dl dt { color: #8b95b8; font-size: 12px; }
      .ap-dl dd { margin: 0; }
    `;
    document.head.append(s);
  }

  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  const shortCid = (c) => (c && c.length > 16 ? `${c.slice(0, 8)}…${c.slice(-6)}` : c || '');
  const size = (b) => (!Number.isFinite(b) ? 'unknown size' : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);
  const sourceLabel = (src) => ({ ipns: 'Follows updates', ipfs: 'Fixed version', folder: 'From a folder', site: 'Hosted here' }[src && src.kind] || (src && src.kind) || '');

  /** Show a busy line, run fn (which sets the next view), or go back to where it started with its error. */
  async function run(busyText, fn) {
    const before = view;
    view = { name: 'busy', text: busyText };
    message = null;
    render();
    try {
      await fn();
    } catch (e) {
      message = { text: errText(e), bad: true };
      if (view.name === 'busy') view = before;
    }
    render();
  }

  async function loadApps() {
    apps = await api().list();
    await Promise.all(apps.filter((a) => a.hasIcon && !icons.has(a.id)).map(async (a) => {
      try { const url = await api().icon(a.id); if (url) icons.set(a.id, url); } catch (_) { /* letter avatar */ }
    }));
  }

  function iconOf(app) {
    const url = icons.get(app.id);
    if (url && /^data:image\//.test(url)) return h('img', { class: 'ap-icon', src: url, alt: '' });
    return h('div', { class: 'ap-icon', 'aria-hidden': 'true', text: (app.name || '?').trim().charAt(0).toUpperCase() || '?' });
  }

  function permissionRow(p, { editable, onChange }) {
    const box = h('input', { type: 'checkbox', checked: p.granted !== false, disabled: !editable, 'aria-label': p.label });
    if (onChange) box.addEventListener('change', () => onChange(p, box.checked, box));
    return h('label', { class: 'ap-perm' }, box,
      h('div', { class: 'ap-grow' },
        h('div', { class: 'ap-row' }, h('span', { class: 'ap-name', text: p.label }), p.risk ? h('span', { class: `ap-chip ${p.risk}`, text: `${p.risk} risk` }) : null),
        p.description ? h('div', { class: 'ap-muted', text: p.description }) : null));
  }

  /* ── Views ──────────────────────────────────────────────────────────── */
  function viewList() {
    const list = apps.length === 0
      ? h('div', { class: 'ap-card' }, h('div', { class: 'ap-muted', text: 'No apps yet. Install one from an ipfs:// or ipns:// address, a folder with its built files, or a site you host. Each app gets its own container: its own storage, and only the network and features you allow.' }))
      : apps.map((a) => h('div', { class: 'ap-card' }, h('div', { class: 'ap-row' },
        iconOf(a),
        h('div', { class: 'ap-grow' },
          h('div', { class: 'ap-name', text: a.name }),
          h('div', { class: 'ap-muted', text: [a.version && `Version ${a.version}`, sourceLabel(a.source)].filter(Boolean).join(' · ') })),
        a.running ? h('span', { class: 'ap-chip ok', text: 'running' }) : null,
        a.pendingUpdate ? h('span', { class: 'ap-chip medium', text: 'update' }) : null,
        h('button', { class: 'ap-btn', text: 'Open', 'aria-label': `Open ${a.name}`, onclick: () => run(`Opening ${a.name}`, async () => { await api().launch(a.id); await loadApps(); view = { name: 'list' }; }) }),
        h('button', { class: 'ap-btn ap-ghost', text: 'Details', 'aria-label': `Details of ${a.name}`, onclick: () => { message = null; view = { name: 'details', id: a.id }; render(); } }))));
    return [h('div', { class: 'ap-row' },
      h('button', { class: 'ap-btn', text: 'Install an app', onclick: () => { message = null; view = { name: 'source' }; render(); } }),
      h('span', { class: 'ap-muted ap-grow', text: 'Apps travel over IPFS and run offline once installed.' })), list];
  }

  function viewSource() {
    const address = h('input', { class: 'ap-input', placeholder: 'ipns://k51… or ipfs://bafy…', maxlength: '2048', 'aria-label': 'App address' });
    const review = (source) => run('Finding the app', async () => {
      const r = await api().inspect(source);
      view = { name: 'review', review: r, granted: new Set(r.permissions.map((p) => p.id)) };
    });
    const go = () => {
      const v = address.value.trim();
      if (!v) { message = { text: 'Enter an address first.', bad: true }; render(); return; }
      review({ address: v });
    };
    address.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const sitesBox = h('div', { class: 'ap-sec' });
    api().hostedSites().then((sites) => {
      const hosted = (sites || []).filter((s) => s.cid);
      if (!hosted.length) return;
      sitesBox.append(h('h3', { text: 'Sites you host' }), ...hosted.map((s) => h('div', { class: 'ap-card' }, h('div', { class: 'ap-row' },
        h('span', { class: 'ap-grow ap-name', text: s.name }),
        h('button', { class: 'ap-btn ap-ghost', text: 'Review', 'aria-label': `Review ${s.name}`, onclick: () => review({ siteId: s.id }) })))));
    }).catch(() => { /* hosting unavailable: no list */ });
    queueMicrotask(() => address.focus());
    return [
      h('div', { class: 'ap-sec' }, h('h3', { text: 'Install an app' }),
        h('div', { class: 'ap-row' }, address, h('button', { class: 'ap-btn', text: 'Review', onclick: go })),
        h('div', { class: 'ap-muted', text: 'An ipns:// address follows the app’s updates; an ipfs:// address installs that exact version. Nothing is installed or pinned before you review it.' })),
      h('div', { class: 'ap-row' },
        h('button', { class: 'ap-btn ap-ghost', text: 'Choose a folder…', onclick: () => run('Reading the folder', async () => {
          const chosen = await api().chooseFolder();
          if (!chosen) { view = { name: 'source' }; return; }
          const r = await api().inspect({ folderToken: chosen.token });
          view = { name: 'review', review: r, granted: new Set(r.permissions.map((p) => p.id)) };
        }) }),
        h('span', { class: 'ap-muted', text: 'A folder with the app’s built files (index.html and bucks-site.json).' })),
      sitesBox,
      h('div', { class: 'ap-row' }, h('button', { class: 'ap-btn ap-ghost', text: 'Back', onclick: () => { message = null; view = { name: 'list' }; render(); } })),
    ];
  }

  function viewReview() {
    const { review: r, granted } = view;
    return [
      h('div', { class: 'ap-card' },
        h('div', { class: 'ap-title', text: r.name }),
        h('div', { class: 'ap-muted', text: [r.version && `Version ${r.version}`, size(r.size), shortCid(r.cid), sourceLabel(r.source)].filter(Boolean).join(' · ') }),
        r.description ? h('p', { text: r.description }) : null),
      r.alreadyInstalled ? h('div', { class: 'ap-msg', text: 'Already installed: installing replaces the installed version. Its data stays.' }) : null,
      (r.warnings || []).map((w) => h('div', { class: 'ap-warn', role: 'note', text: w })),
      h('div', { class: 'ap-sec' }, h('h3', { text: 'What it asks for' }),
        h('div', { class: 'ap-card' }, r.permissions.length === 0
          ? h('div', { class: 'ap-muted', text: 'This app asks for nothing: no network, no devices, no access to your node.' })
          : r.permissions.map((p) => permissionRow({ ...p, granted: granted.has(p.id) }, { editable: true, onChange: (perm, on) => { if (on) granted.add(perm.id); else granted.delete(perm.id); } })))),
      h('div', { class: 'ap-muted', text: 'Untick anything you do not want to allow. You can change this later in the app’s details.' }),
      h('div', { class: 'ap-row' },
        h('button', { class: 'ap-btn ap-ghost', text: 'Back', onclick: () => { view = { name: 'source' }; render(); } }),
        h('span', { class: 'ap-grow' }),
        h('button', { class: 'ap-btn', text: `Install ${r.name}`, onclick: () => run(`Installing ${r.name}`, async () => {
          const app = await api().install(r.token, [...granted]);
          await loadApps();
          message = { text: `Installed ${app.name}.`, bad: false };
          view = { name: 'details', id: app.id };
        }) })),
    ];
  }

  function viewDetails() {
    const a = apps.find((x) => x.id === view.id);
    if (!a) { view = { name: 'list' }; return viewList(); }
    const rows = [['App address', a.urls.app], ['This version', a.urls.ipfs], ...(a.urls.ipns ? [['Updates from', a.urls.ipns]] : [])];
    const setPerm = (p, on, box) => run(on ? `Allowing ${p.label}` : `Turning off ${p.label}`, async () => {
      await api().setPermission(a.id, p.id, on);
      await loadApps();
      view = { name: 'details', id: a.id };
      message = { text: on ? `${p.label}: allowed.` : `${p.label}: turned off.${a.running ? ' The app was reloaded.' : ''}`, bad: false };
    }).finally(() => { if (box) box.disabled = false; });
    return [
      h('div', { class: 'ap-row' }, iconOf(a), h('div', { class: 'ap-grow' },
        h('div', { class: 'ap-title', text: a.name }),
        h('div', { class: 'ap-muted', text: [a.version && `Version ${a.version}`, sourceLabel(a.source), a.running ? 'running' : ''].filter(Boolean).join(' · ') }))),
      a.description ? h('p', { text: a.description }) : null,
      h('div', { class: 'ap-row' },
        h('button', { class: 'ap-btn', text: 'Open', onclick: () => run(`Opening ${a.name}`, async () => { await api().launch(a.id); await loadApps(); view = { name: 'details', id: a.id }; }) }),
        a.canUpdate ? h('button', { class: 'ap-btn ap-ghost', text: a.source.kind === 'folder' ? 'Reload from folder' : 'Check for updates', onclick: () => run('Checking for a new version', async () => {
          const check = await api().checkUpdate(a.id);
          if (!check.available) { view = { name: 'details', id: a.id }; message = { text: check.reason || 'This is the newest version.', bad: false }; return; }
          view = { name: 'update', id: a.id, check };
        }) }) : null,
        a.previousVersion ? h('button', { class: 'ap-btn ap-ghost', text: `Back to ${a.previousVersion.version || shortCid(a.previousVersion.cid)}`, onclick: () => run('Going back', async () => {
          await api().rollback(a.id);
          await loadApps();
          const now = apps.find((x) => x.id === a.id);
          view = { name: 'details', id: a.id };
          message = { text: `Back on version ${(now && now.version) || ''}.`, bad: false };
        }) }) : null,
        a.source.kind === 'folder' ? h('button', { class: 'ap-btn ap-ghost', text: 'Host it', onclick: () => run(`Publishing ${a.name} from this browser`, async () => {
          const r = await api().publish(a.id);
          await loadApps();
          view = { name: 'details', id: a.id };
          message = { text: `Hosted from this browser. Others can install it from ipns://${r.ipns}/ while Bucks runs here.`, bad: false };
        }) }) : null),
      h('div', { class: 'ap-sec' }, h('h3', { text: 'Permissions' }),
        h('div', { class: 'ap-card' }, a.permissions.length === 0
          ? h('div', { class: 'ap-muted', text: 'This app asks for nothing.' })
          : a.permissions.map((p) => permissionRow(p, { editable: true, onChange: (perm, on, box) => { box.disabled = true; setPerm(perm, on, box); } })))),
      a.tools.length ? h('div', { class: 'ap-sec' }, h('h3', { text: 'Tools for your agent' }),
        h('div', { class: 'ap-card' }, a.tools.map((t) => h('div', { class: 'ap-row' }, h('span', { class: 'ap-mono', text: t.name }), h('span', { class: 'ap-muted ap-grow', text: t.description }))))) : null,
      h('div', { class: 'ap-sec' }, h('h3', { text: 'Details' }),
        h('dl', { class: 'ap-dl' }, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { class: 'ap-mono', text: v })]))),
      h('div', { class: 'ap-row' },
        h('button', { class: 'ap-btn ap-ghost', text: 'All apps', onclick: () => { message = null; view = { name: 'list' }; render(); } }),
        h('span', { class: 'ap-grow' }),
        h('button', { class: 'ap-btn ap-danger', text: 'Uninstall', onclick: () => { message = null; view = { name: 'uninstall', id: a.id }; render(); } })),
    ];
  }

  function viewUpdate() {
    const a = apps.find((x) => x.id === view.id);
    const { check } = view;
    const added = check.added || [];
    return [
      h('div', { class: added.length ? 'ap-warn' : 'ap-msg', text: `Version ${check.version || shortCid(check.cid || '')} of ${a ? a.name : 'this app'} is available. ${added.length ? 'It asks for more than the installed version: updating allows the new permissions below.' : 'It asks for nothing new.'}` }),
      (check.warnings || []).map((w) => h('div', { class: 'ap-warn', text: w })),
      added.length ? h('div', { class: 'ap-sec' }, h('h3', { text: 'New permissions' }),
        h('div', { class: 'ap-card' }, added.map((p) => permissionRow({ ...p, granted: true }, { editable: false })))) : null,
      (check.removed || []).length ? h('div', { class: 'ap-muted', text: `No longer asked for: ${(check.removed || []).map((p) => p.label).join(', ')}.` }) : null,
      h('div', { class: 'ap-row' },
        h('button', { class: 'ap-btn ap-ghost', text: 'Not now', onclick: () => { view = { name: 'details', id: view.id }; render(); } }),
        h('span', { class: 'ap-grow' }),
        h('button', { class: 'ap-btn', text: 'Update', onclick: () => run('Updating', async () => {
          await api().update(view.id, true);
          await loadApps();
          const now = apps.find((x) => x.id === view.id);
          message = { text: `Updated to ${(now && now.version) || 'the new version'}.`, bad: false };
          view = { name: 'details', id: view.id };
        }) })),
    ];
  }

  function viewUninstall() {
    const a = apps.find((x) => x.id === view.id);
    if (!a) { view = { name: 'list' }; return viewList(); }
    return [
      h('div', { class: 'ap-msg bad', text: `Uninstall ${a.name}? Its window closes and everything it stored on this computer is deleted. Its files are unpinned unless another app or a site you host uses them.` }),
      h('div', { class: 'ap-row' },
        h('button', { class: 'ap-btn ap-ghost', text: 'Keep it', onclick: () => { view = { name: 'details', id: a.id }; render(); } }),
        h('span', { class: 'ap-grow' }),
        h('button', { class: 'ap-btn ap-danger', text: `Uninstall ${a.name}`, onclick: () => run(`Uninstalling ${a.name}`, async () => {
          await api().uninstall(a.id);
          icons.delete(a.id);
          await loadApps();
          message = { text: `${a.name} was uninstalled.`, bad: false };
          view = { name: 'list' };
        }) })),
    ];
  }

  /* ── Build / render ─────────────────────────────────────────────────── */
  function build() {
    injectStyles();
    root = h('div', { id: 'apps-panel-root', role: 'dialog', 'aria-label': 'Installed apps' },
      h('div', { class: 'ap-head' },
        h('h2', { text: 'Installed apps' }),
        h('button', { class: 'ap-btn ap-ghost', 'aria-label': 'Close', text: '✕', onclick: close })),
      h('div', { class: 'ap-body', id: 'ap-body' }));
    document.body.append(root);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close(); });
  }

  function render() {
    if (!root) return;
    const body = root.querySelector('#ap-body');
    body.textContent = '';
    if (message) body.append(h('div', { class: `ap-msg${message.bad ? ' bad' : ''}`, role: 'status', text: message.text }));
    const views = { list: viewList, source: viewSource, review: viewReview, details: viewDetails, update: viewUpdate, uninstall: viewUninstall };
    if (view.name === 'busy') body.append(h('div', { class: 'ap-muted', role: 'status', 'aria-live': 'polite', id: 'ap-busy', text: `${view.text}…` }));
    else body.append(...[].concat(views[view.name]()).flat().filter(Boolean));
  }

  /* ── Open / close ───────────────────────────────────────────────────── */
  async function open() {
    if (!api()) { console.warn('[AppsPanel] window.bucksApps is not available'); return; }
    if (!root) build();
    isOpen = true;
    requestAnimationFrame(() => root.classList.add('ap-open'));
    if (!unsubscribe) {
      unsubscribe = api().onEvent(async (ev) => {
        if (ev && ev.type === 'progress' && view.name === 'busy') {
          const line = root.querySelector('#ap-busy');
          if (line && ev.message) line.textContent = `${ev.message}…`;
          return;
        }
        if (ev && ev.type === 'changed' && (view.name === 'list' || view.name === 'details')) {
          try { await loadApps(); } catch (_) { /* keep the last list */ }
          render();
        }
      });
    }
    try { await loadApps(); } catch (e) { message = { text: errText(e), bad: true }; }
    if (view.name === 'busy') view = { name: 'list' };
    render();
  }
  function close() { isOpen = false; root?.classList.remove('ap-open'); }
  function toggle() { isOpen ? close() : open(); }

  function wireMenu() {
    document.getElementById('menu-item-installed-apps')?.addEventListener('click', () => {
      document.getElementById('hamburger-menu-dropdown')?.classList.add('hidden');
      open();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireMenu);
  else wireMenu();

  window.appsPanel = { open, close, toggle };
})();
