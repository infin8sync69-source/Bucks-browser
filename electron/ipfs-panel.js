/**
 * IPFS NODE — slide-in panel for the Kubo node behind ipfs://, ipns://, hosting and devices: its
 * state, start / stop / restart, peers and storage, adding a file or text, browsing a path, the pin
 * list and the node's settings. Bucks-browser's bucks://ipfs dashboard, in this app's panel style.
 *
 * Talks to window.bucksIpfs (preload.js → hosting-bridge.js → electron/hosting/…/ipfs/ipc.js).
 * Everything shown comes from the node (names, CIDs, messages) and is inserted with textContent.
 *
 * Opened from the menu ("IPFS node") or window.ipfsPanel.toggle().
 */
(function IpfsPanel() {
  'use strict';

  if (window.__ipfsPanelInit) return;
  window.__ipfsPanelInit = true;

  const api = () => window.bucksIpfs;

  let root = null;
  let isOpen = false;
  let status = null;     // kubo status: { state, message, version, peer_id, gateway_url, embedded, … }
  let stats = null;      // { repo_size, storage_max, num_objects, peers }
  let pins = null;       // [{ cid, pin_type }]
  let siteCids = new Map(); // cid → site name (pins a hosted site needs)
  let settings = null;   // the editable settings.ipfs
  let added = null;      // last add result { cid, ipfs_uri, gateway_url, size, name }
  let browse = { path: '', entries: null };
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
    if (document.getElementById('ipfs-panel-styles')) return;
    const s = document.createElement('style');
    s.id = 'ipfs-panel-styles';
    s.textContent = `
      #ipfs-panel-root { position: fixed; top: 0; right: -540px; bottom: 0; width: 520px; max-width: 100vw;
        z-index: 99996; background: rgba(8,10,18,.97); border-left: 1px solid rgba(46,213,115,.22);
        box-shadow: -20px 0 60px rgba(0,0,0,.6); backdrop-filter: blur(24px);
        font-family: 'Inter','SF Pro Display',system-ui,sans-serif; color: #e0e8ff; font-size: 13px;
        display: flex; flex-direction: column; transition: right .32s cubic-bezier(.16,1,.3,1); }
      #ipfs-panel-root.ip-open { right: 0; }
      .ip-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid rgba(46,213,115,.16); }
      .ip-head h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; }
      .ip-body { flex: 1; overflow-y: auto; padding: 16px 18px 28px; display: flex; flex-direction: column; gap: 18px; }
      .ip-sec h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8b95b8; font-weight: 600; }
      .ip-card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; padding: 12px; }
      .ip-card + .ip-card { margin-top: 8px; }
      .ip-btn { border: 1px solid rgba(46,213,115,.4); background: rgba(46,213,115,.14); color: #e0e8ff; border-radius: 8px;
        padding: 6px 12px; font: inherit; cursor: pointer; }
      .ip-btn:hover:not(:disabled) { background: rgba(46,213,115,.28); }
      .ip-btn:disabled { opacity: .45; cursor: default; }
      .ip-btn.ip-ghost { background: transparent; border-color: rgba(255,255,255,.14); padding: 4px 9px; font-size: 12px; }
      .ip-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .ip-row + .ip-row { margin-top: 8px; }
      .ip-grow { flex: 1; min-width: 0; }
      .ip-input, .ip-select, .ip-text { flex: 1; min-width: 0; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12);
        color: inherit; border-radius: 8px; padding: 7px 10px; font: inherit; }
      .ip-text { width: 100%; min-height: 70px; resize: vertical; box-sizing: border-box; }
      .ip-muted { color: #8b95b8; font-size: 12px; }
      .ip-chip { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: rgba(255,255,255,.08); }
      .ip-chip.ok { background: rgba(46,213,115,.18); color: #2ed573; }
      .ip-chip.bad { background: rgba(255,71,87,.18); color: #ff6b81; }
      .ip-chip.warn { background: rgba(255,179,71,.18); color: #ffb347; }
      .ip-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; word-break: break-all; color: #b9c4ff; }
      .ip-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ip-msg { padding: 8px 10px; border-radius: 8px; background: rgba(46,213,115,.12); }
      .ip-msg.bad { background: rgba(255,71,87,.14); color: #ff9aa6; }
      .ip-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
      .ip-stat { background: rgba(0,0,0,.25); border-radius: 8px; padding: 8px; }
      .ip-stat b { display: block; font-size: 15px; }
      .ip-label { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 180px; }
    `;
    document.head.append(s);
  }

  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  const shortCid = (c) => (c && c.length > 18 ? `${c.slice(0, 10)}…${c.slice(-6)}` : c || '');
  /** Decimal units, as Kubo counts its storage limit ("10GB" is 10^10 bytes). */
  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '—';
    const u = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i += 1; }
    return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  }
  const ready = () => status && status.state === 'ready';

  /** Open in a tab. CIDv0 (Qm…) hosts are converted first: Chromium lowercases the host. */
  function openTab(url) {
    const target = window.BucksIpfsUrl ? window.BucksIpfsUrl.normalizeIpfsUrl(url) : url;
    if (typeof window.createTab === 'function') { window.createTab(target); close(); }
  }

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); flash(`${what} copied.`); } catch (_) { flash(`Could not copy ${what.toLowerCase()}.`, true); }
  }
  function flash(text, bad = false) { message = text ? { text, bad } : null; render(); }

  /** Run an action, show its error or okText, then refresh what it may have changed. */
  async function act(fn, okText, { refresh = false } = {}) {
    try {
      const res = await fn();
      message = okText ? { text: typeof okText === 'function' ? okText(res) : okText, bad: false } : null;
      if (refresh) await refreshData();
      return res;
    } catch (e) {
      message = { text: errText(e), bad: true };
      return undefined;
    } finally {
      render();
    }
  }

  async function refreshData() {
    try { status = await api().status(); } catch (_) { /* keep the last one */ }
    try { settings = await api().settings(); } catch (_) { /* shown as not loaded */ }
    if (!ready()) { stats = null; pins = null; return; }
    const [st, pl, sites] = await Promise.all([
      api().stats().catch(() => null),
      api().pinLs().catch(() => null),
      window.bucksSites ? window.bucksSites.list().catch(() => []) : Promise.resolve([]),
    ]);
    stats = st;
    pins = pl;
    siteCids = new Map();
    for (const site of sites || []) {
      for (const v of [site.current, ...(site.history || [])]) if (v && v.cid) siteCids.set(String(v.cid), site.name);
    }
  }

  /* ── Build / render ─────────────────────────────────────────────────── */
  function build() {
    injectStyles();
    root = h('div', { id: 'ipfs-panel-root', role: 'dialog', 'aria-label': 'IPFS node' },
      h('div', { class: 'ip-head' },
        h('h2', { text: 'IPFS node' }),
        h('span', { class: 'ip-chip', id: 'ip-state', text: '…' }),
        h('button', { class: 'ip-btn ip-ghost', 'aria-label': 'Refresh', text: '↻', onclick: () => act(() => refreshData()) }),
        h('button', { class: 'ip-btn ip-ghost', 'aria-label': 'Close', text: '✕', onclick: close })),
      h('div', { class: 'ip-body', id: 'ip-body' }));
    document.body.append(root);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close(); });
  }

  function renderState() {
    const chip = root.querySelector('#ip-state');
    const state = status ? status.state : 'idle';
    const label = { ready: 'running', initializing: 'starting…', error: 'problem', stopped: 'stopped', idle: 'not started' }[state] || state;
    chip.textContent = label;
    chip.className = `ip-chip ${state === 'ready' ? 'ok' : state === 'error' ? 'bad' : 'warn'}`;
  }

  function sectionNode() {
    const s = status || {};
    const running = ready();
    const starting = s.state === 'initializing';
    return h('section', { class: 'ip-sec' }, h('h3', { text: 'Node' }),
      h('div', { class: 'ip-card' },
        h('div', { class: 'ip-row' }, h('span', { class: 'ip-grow', text: s.message || 'IPFS node has not been started.' })),
        h('div', { class: 'ip-row' },
          h('span', { class: 'ip-muted', text: [s.embedded === false ? 'External node' : 'Embedded Kubo', s.version ? `v${s.version}` : ''].filter(Boolean).join(' · ') })),
        s.peer_id ? h('div', { class: 'ip-row' }, h('span', { class: 'ip-muted', text: 'Peer ID' }),
          h('span', { class: 'ip-mono ip-grow', text: s.peer_id }),
          h('button', { class: 'ip-btn ip-ghost', text: 'Copy', onclick: () => copy(s.peer_id, 'Peer ID') })) : null,
        h('div', { class: 'ip-row' },
          running || starting
            ? h('button', { class: 'ip-btn', text: 'Stop', disabled: starting, onclick: () => act(() => api().stop(), 'IPFS node stopped. ipfs:// pages now load from the built-in Helia node.', { refresh: true }) })
            : h('button', { class: 'ip-btn', text: 'Start', onclick: () => act(() => api().start(), 'IPFS node started.', { refresh: true }) }),
          h('button', { class: 'ip-btn ip-ghost', text: 'Restart', disabled: starting, onclick: () => act(() => api().restart(), 'IPFS node restarted.', { refresh: true }) })),
        running && stats ? h('div', { class: 'ip-stats' },
          h('div', { class: 'ip-stat' }, h('b', { text: String(stats.peers ?? 0) }), h('span', { class: 'ip-muted', text: 'peers' })),
          h('div', { class: 'ip-stat' }, h('b', { text: fmtBytes(stats.repo_size) }), h('span', { class: 'ip-muted', text: `of ${fmtBytes(stats.storage_max)} used` })),
          h('div', { class: 'ip-stat' }, h('b', { text: String(stats.num_objects ?? 0) }), h('span', { class: 'ip-muted', text: 'blocks' }))) : null));
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error || new Error('Could not read the file'));
      r.readAsDataURL(file);
    });
  }

  function sectionAdd() {
    const file = h('input', { type: 'file', 'aria-label': 'File to add', style: 'display:none' });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const res = await act(async () => api().add(f.name, f.type || undefined, await readFileAsDataUrl(f)), `Added ${f.name} to your node (pinned).`, { refresh: true });
      if (res) { added = { ...res, name: f.name }; render(); }
    });
    const text = h('textarea', { class: 'ip-text', placeholder: 'Text or HTML to add', 'aria-label': 'Text to add' });
    const name = h('input', { class: 'ip-input', placeholder: 'File name (optional, e.g. note.txt)', maxlength: '255', 'aria-label': 'Text file name' });
    const result = added ? h('div', { class: 'ip-card', role: 'group', 'aria-label': 'Added to your node' },
      h('div', { class: 'ip-row' }, h('div', { class: 'ip-grow' },
        h('div', { class: 'ip-name', text: added.name || 'Added' }),
        h('div', { class: 'ip-mono', text: added.cid }),
        h('div', { class: 'ip-muted', text: fmtBytes(added.size) }))),
      h('div', { class: 'ip-row' },
        h('button', { class: 'ip-btn', text: 'Open', onclick: () => openTab(added.ipfs_uri) }),
        h('button', { class: 'ip-btn ip-ghost', text: 'Copy CID', onclick: () => copy(added.cid, 'CID') }),
        added.gateway_url ? h('button', { class: 'ip-btn ip-ghost', text: 'Copy gateway link', onclick: () => copy(added.gateway_url, 'Gateway link') }) : null)) : null;
    return h('section', { class: 'ip-sec' }, h('h3', { text: 'Add to your node' }),
      h('div', { class: 'ip-card' },
        h('div', { class: 'ip-row' }, file,
          h('button', { class: 'ip-btn', text: 'Choose a file…', disabled: !ready(), onclick: () => file.click() }),
          h('span', { class: 'ip-muted ip-grow', text: 'Pinned on this node, so it stays available.' })),
        h('div', { class: 'ip-row' }, text),
        h('div', { class: 'ip-row' }, name,
          h('button', { class: 'ip-btn', text: 'Add text', disabled: !ready(), onclick: async () => {
            if (!text.value) return;
            const res = await act(() => api().addText(text.value, name.value.trim() || undefined), 'Text added to your node (pinned).', { refresh: true });
            if (res) { added = { ...res, name: name.value.trim() || 'Text' }; render(); }
          } }))),
      result);
  }

  /** ipfs://cid/a, /ipfs/cid/a, cid/a, ipns://name/a → the RPC path (/ipfs/… or /ipns/…). */
  function toRpcPath(input) {
    const s = String(input || '').trim();
    const m = /^(ipfs|ipns):\/\/+(.+)$/i.exec(s);
    if (m) return `/${m[1].toLowerCase()}/${m[2].replace(/^\/+/, '')}`;
    if (/^\/(ipfs|ipns)\//i.test(s)) return s;
    return `/ipfs/${s.replace(/^\/+/, '')}`;
  }
  const toUrl = (rpcPath) => rpcPath.replace(/^\/(ipfs|ipns)\//i, (_, sch) => `${sch.toLowerCase()}://`);

  async function browseTo(input) {
    const path = toRpcPath(input).replace(/\/+$/, '');
    const entries = await act(() => api().ls(path));
    if (entries) browse = { path, entries };
    render();
  }

  function sectionBrowse() {
    const input = h('input', { class: 'ip-input', placeholder: 'CID, ipfs:// or ipns:// address of a folder', maxlength: '2048', value: browse.path ? toUrl(browse.path) : '', 'aria-label': 'Path to browse' });
    const list = browse.entries;
    const up = browse.path && browse.path.split('/').length > 3 ? browse.path.split('/').slice(0, -1).join('/') : null;
    return h('section', { class: 'ip-sec' }, h('h3', { text: 'Browse' }),
      h('div', { class: 'ip-row' }, input,
        h('button', { class: 'ip-btn', text: 'Browse', disabled: !ready(), onclick: () => input.value.trim() && browseTo(input.value) })),
      list ? h('div', { class: 'ip-card' },
        h('div', { class: 'ip-row' }, h('span', { class: 'ip-mono ip-grow', text: toUrl(browse.path) }),
          up ? h('button', { class: 'ip-btn ip-ghost', text: 'Up', onclick: () => browseTo(up) }) : null,
          h('button', { class: 'ip-btn ip-ghost', text: 'Open', onclick: () => openTab(`${toUrl(browse.path)}/`) })),
        list.length === 0 ? h('div', { class: 'ip-muted', text: 'Empty folder, or a file (open it instead).' }) : null,
        list.map((e) => h('div', { class: 'ip-row' },
          h('span', { class: 'ip-grow ip-name', text: `${e.type === 'dir' ? '📁 ' : ''}${e.name}` }),
          h('span', { class: 'ip-muted', text: e.type === 'dir' ? 'folder' : fmtBytes(e.size) }),
          e.type === 'dir'
            ? h('button', { class: 'ip-btn ip-ghost', text: 'Open folder', onclick: () => browseTo(`${browse.path}/${e.name}`) })
            : h('button', { class: 'ip-btn ip-ghost', text: 'Open', onclick: () => openTab(`${toUrl(browse.path)}/${encodeURIComponent(e.name)}`) })))) : null);
  }

  function sectionPins() {
    const input = h('input', { class: 'ip-input', placeholder: 'CID to pin on this node', maxlength: '512', 'aria-label': 'CID to pin' });
    const rows = (pins || []).slice(0, 200).map((p) => {
      const site = siteCids.get(p.cid);
      return h('div', { class: 'ip-row' },
        h('span', { class: 'ip-mono ip-grow', title: p.cid, text: shortCid(p.cid) }),
        site ? h('span', { class: 'ip-chip', text: `site: ${site}` }) : null,
        h('button', { class: 'ip-btn ip-ghost', text: 'Open', onclick: () => openTab(`ipfs://${p.cid}/`) }),
        h('button', { class: 'ip-btn ip-ghost', text: 'Copy', onclick: () => copy(p.cid, 'CID') }),
        h('button', { class: 'ip-btn ip-ghost', text: 'Unpin', disabled: Boolean(site), title: site ? 'Used by a site you host: manage it in Host a site' : 'Unpin',
          onclick: () => act(() => api().pinRm(p.cid), 'Unpinned. Garbage collection may now remove it.', { refresh: true }) }));
    });
    return h('section', { class: 'ip-sec' }, h('h3', { text: `Pinned on this node${pins ? ` (${pins.length})` : ''}` }),
      h('div', { class: 'ip-row' }, input,
        h('button', { class: 'ip-btn', text: 'Pin', disabled: !ready(), onclick: () => input.value.trim() && act(() => api().pinAdd(input.value.trim()), 'Pinned.', { refresh: true }) })),
      !ready() ? h('div', { class: 'ip-muted', text: 'Start the node to see its pins.' })
        : pins && pins.length === 0 ? h('div', { class: 'ip-muted', text: 'Nothing pinned yet.' })
          : h('div', { class: 'ip-card' }, rows, pins && pins.length > 200 ? h('div', { class: 'ip-muted', text: `and ${pins.length - 200} more` }) : null));
  }

  function sectionSettings() {
    if (!settings) return h('section', { class: 'ip-sec' }, h('h3', { text: 'Settings' }), h('div', { class: 'ip-muted', text: 'Settings are not available yet.' }));
    const autoStart = h('input', { type: 'checkbox', checked: settings.autoStart !== false, 'aria-label': 'Start the node when Bucks starts' });
    const mode = h('select', { class: 'ip-select', 'aria-label': 'Node' },
      h('option', { value: 'embedded', text: 'Embedded Kubo (run by Bucks)' }),
      h('option', { value: 'external', text: 'An IPFS node I already run' }));
    mode.value = settings.mode === 'external' ? 'external' : 'embedded';
    const external = h('input', { class: 'ip-input', placeholder: 'http://127.0.0.1:5001', maxlength: '512', value: settings.externalApiUrl || '', 'aria-label': 'External node API address' });
    const gateway = h('input', { class: 'ip-input', placeholder: 'https://ipfs.io', maxlength: '512', value: settings.publicGateway || '', 'aria-label': 'Public gateway' });
    const prefer = h('select', { class: 'ip-select', 'aria-label': 'Load ipfs:// from' },
      h('option', { value: 'local', text: 'This node (private)' }),
      h('option', { value: 'public', text: 'The public gateway' }));
    prefer.value = settings.preferredGateway === 'public' ? 'public' : 'local';
    const storage = h('input', { class: 'ip-input', type: 'number', min: '1', max: '100000', step: '1', value: String(settings.storageMaxGB ?? 10), 'aria-label': 'Storage limit in GB' });
    const syncExternal = () => { external.disabled = mode.value !== 'external'; };
    mode.addEventListener('change', syncExternal);
    syncExternal();
    const save = () => act(async () => {
      settings = await api().setSettings({
        autoStart: autoStart.checked,
        mode: mode.value,
        externalApiUrl: external.value.trim(),
        publicGateway: gateway.value.trim(),
        preferredGateway: prefer.value,
        storageMaxGB: Number(storage.value),
      });
    }, 'Settings saved. A new node choice restarts the node; the storage limit applies at the next start.', { refresh: true });
    return h('section', { class: 'ip-sec' }, h('h3', { text: 'Settings' }),
      h('div', { class: 'ip-card' },
        h('label', { class: 'ip-row' }, autoStart, h('span', { text: 'Start the node when Bucks starts' })),
        h('div', { class: 'ip-row' }, h('label', { class: 'ip-label' }, h('span', { class: 'ip-muted', text: 'Node' }), mode)),
        h('div', { class: 'ip-row' }, h('label', { class: 'ip-label' }, h('span', { class: 'ip-muted', text: 'External node API address' }), external)),
        h('div', { class: 'ip-row' }, h('label', { class: 'ip-label' }, h('span', { class: 'ip-muted', text: 'Load ipfs:// pages from' }), prefer),
          h('label', { class: 'ip-label' }, h('span', { class: 'ip-muted', text: 'Storage limit (GB)' }), storage)),
        h('div', { class: 'ip-row' }, h('label', { class: 'ip-label' }, h('span', { class: 'ip-muted', text: 'Public gateway (used only when you allow it)' }), gateway)),
        h('div', { class: 'ip-row' }, h('button', { class: 'ip-btn', text: 'Save settings', onclick: save }))));
  }

  function render() {
    if (!root) return;
    renderState();
    const body = root.querySelector('#ip-body');
    // Keep what the user is typing: node status events re-render the panel.
    const active = document.activeElement;
    const typing = body.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) && active.type !== 'file';
    if (typing && !message) return;
    body.textContent = '';
    if (message) body.append(h('div', { class: `ip-msg${message.bad ? ' bad' : ''}`, role: 'status', text: message.text }));
    body.append(sectionNode(), sectionAdd(), sectionBrowse(), sectionPins(), sectionSettings());
  }

  /* ── Open / close ───────────────────────────────────────────────────── */
  async function open() {
    if (!api()) { console.warn('[IpfsPanel] window.bucksIpfs is not available'); return; }
    if (!root) build();
    isOpen = true;
    render();
    requestAnimationFrame(() => root.classList.add('ip-open'));
    if (!unsubscribe) {
      unsubscribe = api().onStatus(async (s) => {
        const wasReady = ready();
        status = s;
        if (s.state === 'ready' && !wasReady) await refreshData();
        render();
      });
    }
    await refreshData();
    render();
  }
  function close() { isOpen = false; root?.classList.remove('ip-open'); }
  function toggle() { isOpen ? close() : open(); }

  function wireMenu() {
    document.getElementById('menu-item-ipfs')?.addEventListener('click', () => {
      document.getElementById('hamburger-menu-dropdown')?.classList.add('hidden');
      open();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireMenu);
  else wireMenu();

  window.ipfsPanel = { open, close, toggle };
})();
