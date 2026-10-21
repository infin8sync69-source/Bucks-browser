/**
 * YOUR DEVICES — slide-in panel for pairing your other Bucks installs and sending them files.
 *
 * Talks to window.bucksDevices (preload.js → hosting-bridge.js → electron/hosting/…/devices.js),
 * which runs over a Kubo node's peering and pubsub (docs: Bucks-browser docs/DEVICES.md). Devices
 * on the same network show up under "Nearby" and are paired explicitly on BOTH machines; a device
 * is only trusted after you pair it, and only paired devices can send you files.
 *
 * Everything that comes from another device (names, file names, peer IDs) is inserted with
 * textContent, never innerHTML.
 *
 * Opened from the menu ("Your devices") or window.devicesPanel.toggle().
 */
(function DevicesPanel() {
  'use strict';

  if (window.__devicesPanelInit) return;
  window.__devicesPanelInit = true;

  const api = () => window.bucksDevices;

  let root = null;
  let isOpen = false;
  let status = null;
  let message = null; // { text, bad }
  let unsubscribe = null;

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

  function injectStyles() {
    if (document.getElementById('devices-panel-styles')) return;
    const s = document.createElement('style');
    s.id = 'devices-panel-styles';
    s.textContent = `
      #devices-panel-root { position: fixed; top: 0; right: -500px; bottom: 0; width: 480px; max-width: 100vw;
        z-index: 99996; background: rgba(8,10,18,.97); border-left: 1px solid rgba(82,182,255,.2);
        box-shadow: -20px 0 60px rgba(0,0,0,.6); backdrop-filter: blur(24px);
        font-family: 'Inter','SF Pro Display',system-ui,sans-serif; color: #e0e8ff; font-size: 13px;
        display: flex; flex-direction: column; transition: right .32s cubic-bezier(.16,1,.3,1); }
      #devices-panel-root.dp-open { right: 0; }
      .dp-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid rgba(82,182,255,.14); }
      .dp-head h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; }
      .dp-body { flex: 1; overflow-y: auto; padding: 16px 18px 28px; display: flex; flex-direction: column; gap: 18px; }
      .dp-sec h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8b95b8; font-weight: 600; }
      .dp-card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; padding: 12px; }
      .dp-card + .dp-card { margin-top: 8px; }
      .dp-btn { border: 1px solid rgba(82,182,255,.4); background: rgba(82,182,255,.16); color: #e0e8ff; border-radius: 8px;
        padding: 6px 12px; font: inherit; cursor: pointer; }
      .dp-btn:hover:not(:disabled) { background: rgba(82,182,255,.3); }
      .dp-btn:disabled { opacity: .45; cursor: default; }
      .dp-btn.dp-ghost { background: transparent; border-color: rgba(255,255,255,.14); padding: 4px 9px; font-size: 12px; }
      .dp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dp-row + .dp-row { margin-top: 8px; }
      .dp-grow { flex: 1; min-width: 0; }
      .dp-input { flex: 1; min-width: 0; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12); color: inherit;
        border-radius: 8px; padding: 7px 10px; font: inherit; }
      .dp-muted { color: #8b95b8; font-size: 12px; }
      .dp-chip { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: rgba(255,255,255,.08); }
      .dp-chip.ok { background: rgba(46,213,115,.18); color: #2ed573; }
      .dp-chip.bad { background: rgba(255,71,87,.18); color: #ff6b81; }
      .dp-chip.warn { background: rgba(255,179,71,.18); color: #ffb347; }
      .dp-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; word-break: break-all; color: #b9c4ff; }
      .dp-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dp-msg { padding: 8px 10px; border-radius: 8px; background: rgba(82,182,255,.12); }
      .dp-msg.bad { background: rgba(255,71,87,.14); color: #ff9aa6; }
    `;
    document.head.append(s);
  }

  const shortId = (id) => (id && id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id || '');
  const platformLabel = (p) => ({ darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[p] || p || '');
  const fmtSize = (n) => (Number.isFinite(n) ? (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`) : '');

  /** The address another device can paste to pair with this one: first non-loopback addr + /p2p/<id>. */
  function pairingAddress(self) {
    if (!self || !self.peerId) return '';
    const addrs = Array.isArray(self.addrs) ? self.addrs : [];
    const pick = addrs.find((a) => !/\/ip4\/127\.|\/ip6\/::1/.test(a)) || addrs[0];
    return pick ? `${pick.replace(/\/p2p\/.*$/, '')}/p2p/${self.peerId}` : '';
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      flash(`${what} copied.`);
    } catch (_) {
      flash(`Could not copy ${what.toLowerCase()}.`, true);
    }
  }

  function flash(text, bad = false) {
    message = text ? { text, bad } : null;
    render();
  }

  /** Run an action, show its error, and re-render from the status it returns. */
  async function act(fn, okText) {
    try {
      const res = await fn();
      if (res && typeof res === 'object' && Array.isArray(res.paired)) status = res;
      message = okText ? { text: okText, bad: false } : null;
    } catch (e) {
      const text = String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      message = { text, bad: true };
    }
    render();
  }

  /* ── Build / render ─────────────────────────────────────────────────── */
  function build() {
    injectStyles();
    root = h('div', { id: 'devices-panel-root', role: 'dialog', 'aria-label': 'Your devices' },
      h('div', { class: 'dp-head' },
        h('h2', { text: 'Your devices' }),
        h('span', { class: 'dp-chip', id: 'dp-state', text: '…' }),
        h('button', { class: 'dp-btn dp-ghost', 'aria-label': 'Close', text: '✕', onclick: close })),
      h('div', { class: 'dp-body', id: 'dp-body' }));
    document.body.append(root);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close(); });
  }

  function renderState() {
    const chip = root.querySelector('#dp-state');
    if (!status) { chip.textContent = 'starting…'; chip.className = 'dp-chip warn'; return; }
    if (status.ready) { chip.textContent = 'listening'; chip.className = 'dp-chip ok'; }
    else if (status.error) { chip.textContent = 'problem'; chip.className = 'dp-chip bad'; }
    else { chip.textContent = 'starting…'; chip.className = 'dp-chip warn'; }
  }

  function sectionThis() {
    const self = status.self || {};
    const nameInput = h('input', { class: 'dp-input', maxlength: '64', value: self.name || '', 'aria-label': 'Device name' });
    const addr = pairingAddress(self);
    return h('section', { class: 'dp-sec' }, h('h3', { text: 'This device' }),
      h('div', { class: 'dp-card' },
        h('div', { class: 'dp-row' }, nameInput,
          h('button', { class: 'dp-btn', text: 'Save name', onclick: () => act(() => api().rename(nameInput.value.trim()), 'Name saved.') })),
        h('div', { class: 'dp-row' }, h('span', { class: 'dp-muted', text: [platformLabel(self.platform), self.version].filter(Boolean).join(' · ') })),
        h('div', { class: 'dp-row' }, h('span', { class: 'dp-muted', text: 'Peer ID' }),
          h('span', { class: 'dp-mono dp-grow', text: self.peerId || '—' }),
          self.peerId ? h('button', { class: 'dp-btn dp-ghost', text: 'Copy', onclick: () => copy(self.peerId, 'Peer ID') }) : null),
        h('div', { class: 'dp-row' }, h('span', { class: 'dp-muted', text: 'Pairing address' }),
          h('span', { class: 'dp-mono dp-grow', text: addr || 'No network address yet. Connect to Wi-Fi or a cable.' }),
          addr ? h('button', { class: 'dp-btn dp-ghost', text: 'Copy', onclick: () => copy(addr, 'Pairing address') }) : null)));
  }

  function sectionNearby() {
    const list = status.discovered || [];
    return h('section', { class: 'dp-sec' }, h('h3', { text: 'Nearby Bucks devices' }),
      list.length === 0
        ? h('div', { class: 'dp-muted', text: 'None found yet. Both computers need Bucks open on the same network. Otherwise pair manually below.' })
        : list.map((d) => h('div', { class: 'dp-card' }, h('div', { class: 'dp-row' },
          h('div', { class: 'dp-grow' },
            h('div', { class: 'dp-name', text: d.name || shortId(d.peerId) }),
            h('div', { class: 'dp-muted', text: [platformLabel(d.platform), shortId(d.peerId)].filter(Boolean).join(' · ') })),
          h('button', { class: 'dp-btn', text: 'Pair', onclick: () => act(() => api().pair({ peerId: d.peerId, name: d.name, addrs: d.addrs }), `Paired with ${d.name || shortId(d.peerId)}. Pair on the other computer too.`) })))));
  }

  function sectionPaired() {
    const list = status.paired || [];
    return h('section', { class: 'dp-sec' }, h('h3', { text: 'Paired devices' }),
      list.length === 0
        ? h('div', { class: 'dp-muted', text: 'No paired devices yet.' })
        : list.map((d) => h('div', { class: 'dp-card' }, h('div', { class: 'dp-row' },
          h('div', { class: 'dp-grow' },
            h('div', { class: 'dp-name', text: d.name }),
            h('div', { class: 'dp-muted', text: [platformLabel(d.platform), shortId(d.peerId)].filter(Boolean).join(' · ') })),
          h('span', { class: `dp-chip ${d.connected ? 'ok' : d.online ? 'warn' : ''}`, text: d.connected ? 'connected' : d.online ? 'online' : 'offline' }),
          h('button', { class: 'dp-btn dp-ghost', text: 'Unpair', onclick: () => act(() => api().unpair(d.peerId), 'Unpaired.') })))));
  }

  function sectionManual() {
    const input = h('input', { class: 'dp-input', placeholder: '/ip4/…/tcp/…/p2p/12D3Koo… or a peer ID', maxlength: '512', 'aria-label': 'Pairing address or peer ID' });
    const go = () => {
      const v = input.value.trim();
      if (!v) return;
      act(() => api().pair(/^12D3Koo|^Qm|^k51/.test(v) ? { peerId: v } : { peerId: v.split('/p2p/')[1] || v, addrs: [v] }), 'Paired. Pair on the other computer too.');
    };
    return h('section', { class: 'dp-sec' }, h('h3', { text: 'Pair manually' }),
      h('div', { class: 'dp-row' }, input, h('button', { class: 'dp-btn', text: 'Pair', onclick: go })),
      h('div', { class: 'dp-muted', text: 'Paste the other computer’s pairing address. Pairing is one-way until you pair on both.' }));
  }

  function sectionShare() {
    const cid = h('input', { class: 'dp-input', placeholder: 'CID of a file on this node', maxlength: '200', 'aria-label': 'CID to send' });
    const name = h('input', { class: 'dp-input', placeholder: 'File name (optional)', maxlength: '255', 'aria-label': 'File name' });
    const paired = (status.paired || []).length;
    return h('section', { class: 'dp-sec' }, h('h3', { text: 'Send to my devices' }),
      h('div', { class: 'dp-row' }, cid),
      h('div', { class: 'dp-row' }, name,
        h('button', { class: 'dp-btn', text: 'Send', disabled: paired === 0, onclick: () => {
          const v = cid.value.trim();
          if (!v) return;
          act(() => api().share({ cid: v, name: name.value.trim() || undefined }), 'Offered to your paired devices.');
        } })),
      h('div', { class: 'dp-muted', text: paired === 0 ? 'Pair a device first.' : `Offered to ${paired} paired ${paired === 1 ? 'device' : 'devices'}; they fetch it when online.` }));
  }

  function sectionReceived() {
    const list = status.received || [];
    if (!list.length) return h('section', { class: 'dp-sec' }, h('h3', { text: 'Received files' }), h('div', { class: 'dp-muted', text: 'Nothing received yet.' }));
    return h('section', { class: 'dp-sec' }, h('h3', { text: 'Received files' }),
      list.map((r) => h('div', { class: 'dp-card' },
        h('div', { class: 'dp-row' },
          h('div', { class: 'dp-grow' },
            h('div', { class: 'dp-name', text: r.name || shortId(r.cid) }),
            h('div', { class: 'dp-muted', text: [`from ${r.fromName || shortId(r.from)}`, fmtSize(r.size)].filter(Boolean).join(' · ') })),
          typeof window.createTab === 'function'
            ? h('button', { class: 'dp-btn', text: 'Open', onclick: () => { window.createTab(`ipfs://${r.cid}`); close(); } })
            : null,
          h('button', { class: 'dp-btn dp-ghost', text: 'Copy CID', onclick: () => copy(r.cid, 'CID') }),
          h('button', { class: 'dp-btn dp-ghost', text: 'Dismiss', onclick: () => act(() => api().dismiss(r.cid, r.from)) })))));
  }

  function render() {
    if (!root) return;
    renderState();
    const body = root.querySelector('#dp-body');
    // Keep what the user is typing: the status event fires every few seconds.
    const typing = body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    if (typing && !message) return;
    body.textContent = '';
    if (message) body.append(h('div', { class: `dp-msg${message.bad ? ' bad' : ''}`, text: message.text }));
    if (!status) { body.append(h('div', { class: 'dp-muted', text: 'Starting the device node. The first start can take a minute.' })); return; }
    if (status.error) body.append(h('div', { class: 'dp-msg bad', text: status.error }));
    body.append(sectionThis(), sectionNearby(), sectionPaired(), sectionManual(), sectionShare(), sectionReceived());
  }

  /* ── Open / close ───────────────────────────────────────────────────── */
  async function open() {
    if (!api()) { console.warn('[DevicesPanel] window.bucksDevices is not available'); return; }
    if (!root) build();
    isOpen = true;
    render();
    requestAnimationFrame(() => root.classList.add('dp-open'));
    if (!unsubscribe) unsubscribe = api().onUpdated((s) => { status = s; render(); });
    try { status = await api().status(); } catch (_) { /* node not up yet */ }
    render();
    // Pairing needs the Kubo node; it normally starts only when you publish a site.
    if (window.bucksSites && window.bucksSites.nodeStart) {
      window.bucksSites.nodeStart().then(async () => {
        try { status = await api().status(); } catch (_) { /* shown as starting */ }
        render();
      }).catch((e) => {
        message = { text: `The device node could not start: ${String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`, bad: true };
        render();
      });
    }
  }
  function close() { isOpen = false; root?.classList.remove('dp-open'); }
  function toggle() { isOpen ? close() : open(); }

  function wireMenu() {
    document.getElementById('menu-item-devices')?.addEventListener('click', () => {
      document.getElementById('hamburger-menu-dropdown')?.classList.add('hidden');
      open();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireMenu);
  else wireMenu();

  window.devicesPanel = { open, close, toggle };
})();
