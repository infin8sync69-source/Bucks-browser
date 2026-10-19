/**
 * HOST A SITE — slide-in panel for publishing a folder over ipfs:// and ipns://.
 *
 * Talks to window.bucksSites (preload.js → hosting-bridge.js → electron/hosting). The page never
 * sees a file path: "Choose folder" opens a native dialog in the main process and returns a token.
 *
 *   1. Choose folder  → inspect → checks (blocking problems, warnings, one-click fixes)
 *   2. Publish        → progress → the addresses to share
 *   3. Your sites     → ipfs:// (this exact version) and ipns:// (follows your updates)
 *
 * Opened from the menu ("Host a site") or window.sitesPanel.toggle(). All text from the main
 * process (file names, check messages) is inserted with textContent, never innerHTML.
 */
(function SitesPanel() {
  'use strict';

  if (window.__sitesPanelInit) return;
  window.__sitesPanelInit = true;

  const api = () => window.bucksSites;

  /* ── State ──────────────────────────────────────────────────────────── */
  let root = null;
  let isOpen = false;
  let chosen = null;     // { token, name } from the native folder dialog
  let options = {};      // one-click fixes: { useShellAsIndex, enableSpa, exclude }
  let inspection = null; // last inspect() result
  let publishing = false;
  let unsubscribeProgress = null;

  /* ── DOM helper ─────────────────────────────────────────────────────── */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`);
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  /* ── Styles ─────────────────────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('sites-panel-styles')) return;
    const s = document.createElement('style');
    s.id = 'sites-panel-styles';
    s.textContent = `
      #sites-panel-root { position: fixed; top: 0; right: -500px; bottom: 0; width: 480px; max-width: 100vw;
        z-index: 99996; background: rgba(8,10,18,.97); border-left: 1px solid rgba(124,92,252,.18);
        box-shadow: -20px 0 60px rgba(0,0,0,.6); backdrop-filter: blur(24px);
        font-family: 'Inter','SF Pro Display',system-ui,sans-serif; color: #e0e8ff; font-size: 13px;
        display: flex; flex-direction: column; transition: right .32s cubic-bezier(.16,1,.3,1); }
      #sites-panel-root.sp-open { right: 0; }
      .sp-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid rgba(124,92,252,.12); }
      .sp-head h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; }
      .sp-body { flex: 1; overflow-y: auto; padding: 16px 18px 28px; display: flex; flex-direction: column; gap: 18px; }
      .sp-sec h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8b95b8; font-weight: 600; }
      .sp-card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; padding: 12px; }
      .sp-btn { border: 1px solid rgba(124,92,252,.4); background: rgba(124,92,252,.16); color: #e0e8ff; border-radius: 8px;
        padding: 7px 12px; font: inherit; cursor: pointer; }
      .sp-btn:hover:not(:disabled) { background: rgba(124,92,252,.3); }
      .sp-btn:disabled { opacity: .45; cursor: default; }
      .sp-btn.sp-primary { background: #7c5cfc; border-color: #7c5cfc; color: #fff; font-weight: 600; }
      .sp-btn.sp-ghost { background: transparent; border-color: rgba(255,255,255,.14); padding: 4px 9px; font-size: 12px; }
      .sp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .sp-input { flex: 1; min-width: 0; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12); color: inherit;
        border-radius: 8px; padding: 7px 10px; font: inherit; }
      .sp-muted { color: #8b95b8; font-size: 12px; }
      .sp-chip { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: rgba(255,255,255,.08); }
      .sp-chip.ok { background: rgba(46,213,115,.18); color: #2ed573; }
      .sp-chip.bad { background: rgba(255,71,87,.18); color: #ff6b81; }
      .sp-check { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-top: 1px solid rgba(255,255,255,.05); }
      .sp-check:first-child { border-top: 0; }
      .sp-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; background: #8b95b8; }
      .sp-dot.block { background: #ff4757; } .sp-dot.warn { background: #ffb347; } .sp-dot.done { background: #2ed573; }
      .sp-addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; word-break: break-all; color: #b9c4ff; }
      .sp-site + .sp-site { margin-top: 10px; }
      .sp-err { color: #ff6b81; }
      .sp-bar { height: 4px; border-radius: 2px; background: rgba(255,255,255,.1); overflow: hidden; margin-top: 8px; }
      .sp-bar > i { display: block; height: 100%; background: #7c5cfc; width: 0; transition: width .2s; }
    `;
    document.head.append(s);
  }

  /* ── Build / render ─────────────────────────────────────────────────── */
  function build() {
    injectStyles();
    root = h('div', { id: 'sites-panel-root', role: 'dialog', 'aria-label': 'Host a site' },
      h('div', { class: 'sp-head' },
        h('h2', { text: 'Host a site' }),
        h('span', { class: 'sp-chip', id: 'sp-node', text: 'node: …' }),
        h('button', { class: 'sp-btn sp-ghost', 'aria-label': 'Close', text: '✕', onclick: close })),
      h('div', { class: 'sp-body' },
        h('section', { class: 'sp-sec', id: 'sp-publish' }),
        h('section', { class: 'sp-sec', id: 'sp-sites' })));
    document.body.append(root);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close(); });
  }

  const $ = (sel) => root.querySelector(sel);

  function renderNode(status) {
    const chip = $('#sp-node');
    const state = status?.state || 'idle';
    chip.textContent = `node: ${state}`;
    chip.className = `sp-chip ${state === 'ready' ? 'ok' : state === 'failed' ? 'bad' : ''}`;
  }

  async function refreshNode() {
    try { renderNode(await api().nodeStatus()); } catch (_) { renderNode({ state: 'unavailable' }); }
  }

  /** Publish section: pick a folder, review checks, publish. */
  function renderPublish(extra) {
    const sec = $('#sp-publish');
    sec.replaceChildren(h('h3', { text: 'Publish a folder' }));

    const pick = h('div', { class: 'sp-card' },
      h('div', { class: 'sp-row' },
        h('button', { class: 'sp-btn', text: chosen ? 'Choose another folder…' : 'Choose folder…', disabled: publishing, onclick: chooseFolder }),
        h('span', { class: 'sp-muted', text: chosen ? `Folder: ${chosen.name}` : 'A built website, or a project that builds into one.' })));
    sec.append(pick);

    if (inspection) {
      const blocked = inspection.blocked && inspection.checks.some((c) => c.level === 'block' && !c.resolved);
      pick.append(
        h('div', { class: 'sp-muted', style: 'margin-top:8px', text: `${inspection.files} files · ${fmtBytes(inspection.bytes)} · entry ${inspection.entry}${inspection.spa ? ' · single-page app' : ''}` }),
        h('div', { style: 'margin-top:8px' }, inspection.checks.map(renderCheck)));
      const nameInput = h('input', { class: 'sp-input', id: 'sp-name', maxlength: '100', value: chosen.name, 'aria-label': 'Site name' });
      pick.append(h('div', { class: 'sp-row', style: 'margin-top:10px' }, nameInput,
        h('button', { class: 'sp-btn sp-primary', text: publishing ? 'Publishing…' : 'Publish', disabled: publishing || blocked, onclick: () => publish(nameInput.value) })));
      if (blocked) pick.append(h('div', { class: 'sp-muted sp-err', style: 'margin-top:6px', text: 'Fix the blocking problems above before publishing.' }));
      pick.append(h('div', { class: 'sp-bar', id: 'sp-bar', hidden: true }, h('i')), h('div', { class: 'sp-muted', id: 'sp-step', style: 'margin-top:4px' }));
    }

    if (extra?.error) sec.append(h('div', { class: 'sp-card sp-err', style: 'margin-top:10px', text: extra.error }));
    if (extra?.published) sec.append(renderSiteCard({ name: extra.published.name, urls: extra.published.urls, announce: extra.published.announce }, true));
  }

  function renderCheck(c) {
    const kind = c.resolved ? 'done' : c.level;
    const kids = [h('span', { class: `sp-dot ${kind}` }), h('div', { style: 'flex:1' }, h('div', { text: c.message }))];
    if (c.fix && !c.resolved) {
      kids[1].append(h('button', { class: 'sp-btn sp-ghost', style: 'margin-top:4px', text: c.fix.label || 'Fix', disabled: publishing, onclick: () => applyFix(c) }));
    }
    return h('div', { class: 'sp-check' }, ...kids);
  }

  /** Sites section: everything this browser hosts. */
  async function renderSites() {
    const sec = $('#sp-sites');
    sec.replaceChildren(h('h3', { text: 'Your sites' }));
    let list = [];
    try { list = await api().list(); } catch (e) { sec.append(h('div', { class: 'sp-muted sp-err', text: errText(e) })); return; }
    if (!list.length) { sec.append(h('div', { class: 'sp-muted', text: 'Nothing published yet.' })); return; }
    for (const s of list) {
      const cid = s.current?.cid;
      sec.append(renderSiteCard({
        name: s.name,
        urls: { ipfs: cid ? `ipfs://${cid}/` : null, ipns: s.ipns ? `ipns://${s.ipns}/` : null },
        announce: s.announce,
        versions: s.history?.length,
        keyBackedUp: s.keyBackedUp,
      }, false));
    }
  }

  function addrRow(label, url, hint) {
    if (!url) return null;
    return h('div', { style: 'margin-top:8px' },
      h('div', { class: 'sp-muted', text: label }),
      h('div', { class: 'sp-addr', text: url }),
      h('div', { class: 'sp-row', style: 'margin-top:4px' },
        h('button', { class: 'sp-btn sp-ghost', text: 'Open in tab', onclick: () => { if (typeof window.createTab === 'function') window.createTab(url); } }),
        h('button', { class: 'sp-btn sp-ghost', text: 'Copy', onclick: (e) => copy(url, e.currentTarget) }),
        hint ? h('span', { class: 'sp-muted', text: hint }) : null));
  }

  function renderSiteCard(site, fresh) {
    const card = h('div', { class: 'sp-card sp-site' },
      h('div', { class: 'sp-row' }, h('strong', { text: site.name || 'Site' }),
        fresh ? h('span', { class: 'sp-chip ok', text: 'published' }) : null,
        site.announce && site.announce.ok === false ? h('span', { class: 'sp-chip bad', text: 'not announced yet' }) : null,
        site.versions != null ? h('span', { class: 'sp-chip', text: `${site.versions + 1} version${site.versions ? 's' : ''}` }) : null),
      addrRow('Updatable address — follows your updates', site.urls.ipns, null),
      addrRow('This exact version', site.urls.ipfs, null));
    if (site.urls.gatewayIpns) card.append(addrRow('Without Bucks (public gateway, availability not guaranteed)', site.urls.gatewayIpns, null));
    if (fresh) card.append(h('div', { class: 'sp-muted', style: 'margin-top:8px', text: 'Back up the address key so you can keep publishing to this address: node scripts/site.mjs backup-key (in electron/hosting).' }));
    return card;
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1200); } catch (_) {}
  }

  /* ── Actions ────────────────────────────────────────────────────────── */
  async function chooseFolder() {
    try {
      const picked = await api().chooseFolder();
      if (!picked) return;
      chosen = picked; options = {}; inspection = null;
      renderPublish();
      await runInspect();
    } catch (e) { renderPublish({ error: errText(e) }); }
  }

  async function runInspect() {
    try {
      inspection = await api().inspect({ token: chosen.token, ...options });
      renderPublish();
    } catch (e) { inspection = null; renderPublish({ error: errText(e) }); }
  }

  async function applyFix(check) {
    const action = check.fix.action;
    if (action === 'use-shell-as-index') options.useShellAsIndex = true;
    else if (action === 'enable-spa') options.enableSpa = true;
    else if (action === 'exclude') options.exclude = [...new Set([...(options.exclude || []), ...(check.files || []).map((f) => f.path)])];
    else return;
    await runInspect();
  }

  async function publish(name) {
    if (publishing || !chosen) return;
    publishing = true;
    renderPublish();
    unsubscribeProgress = api().onProgress((p) => {
      const bar = $('#sp-bar'); const step = $('#sp-step');
      if (step && p?.message) step.textContent = p.message;
      if (bar) { bar.hidden = false; const total = Number(p?.total) || 0; bar.firstChild.style.width = total ? `${Math.min(100, (Number(p.done) / total) * 100)}%` : '15%'; }
    });
    try {
      const result = await api().publish({ token: chosen.token, name: (name || chosen.name).trim().slice(0, 100), ipns: true, hosting: {}, ...options });
      publishing = false;
      chosen = null; inspection = null; options = {};
      renderPublish({ published: { name: (name || '').trim() || result.id, urls: result.urls, announce: result.announce } });
      await Promise.all([renderSites(), refreshNode()]);
    } catch (e) {
      publishing = false;
      renderPublish({ error: errText(e) });
    } finally {
      if (unsubscribeProgress) { unsubscribeProgress(); unsubscribeProgress = null; }
    }
  }

  /* ── Open / close ───────────────────────────────────────────────────── */
  function open() {
    if (!api()) { console.warn('[SitesPanel] window.bucksSites is not available'); return; }
    if (!root) build();
    isOpen = true;
    renderPublish();
    renderSites();
    refreshNode();
    requestAnimationFrame(() => root.classList.add('sp-open'));
  }
  function close() { isOpen = false; root?.classList.remove('sp-open'); }
  function toggle() { isOpen ? close() : open(); }

  function wireMenu() {
    document.getElementById('menu-item-sites')?.addEventListener('click', () => {
      document.getElementById('hamburger-menu-dropdown')?.classList.add('hidden');
      open();
    });
  }
  // Scripts load at the end of <body>, so the menu normally exists already.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireMenu);
  else wireMenu();

  window.sitesPanel = { open, close, toggle };
})();
