/* ╔══════════════════════════════════════════════════════════╗
   ║  BUCKS TAB VIEW — renderer-side shim for WebContentsView    ║
   ║                                                            ║
   ║  Drop-in replacement for the legacy <webview> element used ║
   ║  for tab hosting. Each TabView owns a placeholder <div      ║
   ║  class="webview-host"> that participates in normal layout/ ║
   ║  CSS (`.active` toggles it like the old webview) while the ║
   ║  actual page renders in a main-process WebContentsView     ║
   ║  whose bounds/visibility mirror the placeholder.           ║
   ║                                                            ║
   ║  Implements exactly the webview API surface renderer.js /  ║
   ║  agent-browser-control.js use: setAttribute('src'), src,   ║
   ║  remove, classList, dataset, addEventListener, goBack/     ║
   ║  goForward/canGoBack/canGoForward, reload, findInPage,     ║
   ║  stopFindInPage, setZoomFactor, print, executeJavaScript,  ║
   ║  capturePageBase64.                                        ║
   ╚══════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';

  if (!window.bucksTabs) {
    console.warn('[TabView] bucksTabs preload API missing — tab shim disabled.');
    return;
  }

  let SEQ = 0;
  const instances = new Map(); // tabViewId -> TabView

  // Overlay panels that slide OVER the content area. A native view would
  // otherwise paint above them, so their footprint is subtracted from the
  // view bounds ("push" behavior) — and full-screen overlays hide the view.
  const SIDE_OVERLAYS = ['#wallet-sidebar', '#ipfs-sidebar', '#settings-panel'];
  const TOP_OVERLAYS = ['#find-bar'];
  const FULLSCREEN_OVERLAYS = ['#store-overlay'];

  function overlayVisible(el) {
    if (!el) return false;
    if (el.classList.contains('hidden') || el.classList.contains('sidebar-hidden')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  class TabView {
    constructor(opts = {}) {
      this.tabViewId = 'tv-' + Date.now().toString(36) + '-' + (SEQ++);
      this._events = {};
      this._url = '';
      this._canGoBack = false;
      this._canGoForward = false;
      this._destroyed = false;
      this._lastSig = '';

      this.el = document.createElement('div');
      this.el.className = 'webview-host';
      this.el.__tabView = this;

      const partition = opts.partition || undefined;
      this._ready = window.bucksTabs.create(this.tabViewId, '', partition);
      instances.set(this.tabViewId, this);
    }

    /* ── DOM-ish surface (renderer.js treats us like an element) ── */
    get classList() { return this.el.classList; }
    get dataset() { return this.el.dataset; }
    get style() { return this.el.style; }

    setAttribute(name, value) {
      if (name === 'src') { this.src = value; return; }
      if (name === 'partition' || name === 'allowpopups') return; // constructor-time / N/A
      this.el.setAttribute(name, value);
    }
    getAttribute(name) {
      if (name === 'src') return this._url;
      return this.el.getAttribute(name);
    }

    get src() { return this._url; }
    set src(url) {
      this._url = String(url || '');
      this._call('navigate', this._url);
    }

    remove() {
      this._destroyed = true;
      instances.delete(this.tabViewId);
      window.bucksTabs.close(this.tabViewId).catch(() => {});
      this.el.remove();
      scheduleSync();
    }

    /* ── events ── */
    addEventListener(type, fn, options) {
      const wrapped = (options && options.once)
        ? (ev) => { this.removeEventListener(type, wrapped); fn(ev); }
        : fn;
      (this._events[type] = this._events[type] || []).push(wrapped);
    }
    removeEventListener(type, fn) {
      const l = this._events[type];
      if (l) this._events[type] = l.filter((f) => f !== fn);
    }
    _emit(type, ev) {
      (this._events[type] || []).forEach((fn) => { try { fn(ev); } catch (err) { console.error('[TabView]', type, err); } });
    }

    /* ── navigation / page API ── */
    loadURL(url) { this.src = url; }
    getURL() { return this._url; }
    canGoBack() { return this._canGoBack; }
    canGoForward() { return this._canGoForward; }
    goBack() { this._call('goBack'); }
    goForward() { this._call('goForward'); }
    reload() { this._call('reload'); }
    stop() { this._call('stop'); }
    print() { this._call('print'); }
    openDevTools() { this._call('openDevTools'); }
    setZoomFactor(f) { window.bucksTabs.setZoom(this.tabViewId, f).catch(() => {}); }
    findInPage(text, options) { window.bucksTabs.find(this.tabViewId, text, options).catch(() => {}); }
    stopFindInPage(action) { window.bucksTabs.stopFind(this.tabViewId, action).catch(() => {}); }
    executeJavaScript(code, userGesture) {
      return window.bucksTabs.execJS(this.tabViewId, code, !!userGesture);
    }
    capturePageBase64() { return window.bucksTabs.capture(this.tabViewId); }

    _call(method, arg) {
      const p = this._ready.then(() => (arg !== undefined
        ? window.bucksTabs[method](this.tabViewId, arg)
        : window.bucksTabs[method](this.tabViewId)));
      p.catch(() => {});
      return p;
    }

    /* ── geometry/visibility mirroring ── */
    _sync() {
      if (this._destroyed) return;
      const visible = this.el.isConnected &&
        this.el.classList.contains('active') &&
        getComputedStyle(this.el).display !== 'none' &&
        !FULLSCREEN_OVERLAYS.some((sel) => overlayVisible(document.querySelector(sel)));

      if (!visible) {
        if (this._lastSig !== 'hidden') {
          this._lastSig = 'hidden';
          window.bucksTabs.setVisible(this.tabViewId, false).catch(() => {});
        }
        return;
      }

      const r = this.el.getBoundingClientRect();
      let { left, top, right, bottom } = r;

      // Push behavior for slide-over panels.
      for (const sel of SIDE_OVERLAYS) {
        const el = document.querySelector(sel);
        if (!overlayVisible(el)) continue;
        const o = el.getBoundingClientRect();
        if (o.left < right && o.right > left && o.width > 0) {
          if (o.left > left + 40) right = Math.min(right, o.left); // docks right
          else left = Math.max(left, o.right);                     // docks left
        }
      }
      for (const sel of TOP_OVERLAYS) {
        const el = document.querySelector(sel);
        if (!overlayVisible(el)) continue;
        const o = el.getBoundingClientRect();
        if (o.bottom > top && o.top < bottom) top = Math.max(top, o.bottom + 8);
      }

      const bounds = {
        x: left, y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
      const sig = [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(',');
      if (sig !== this._lastSig) {
        this._lastSig = sig;
        window.bucksTabs.setBounds(this.tabViewId, bounds).catch(() => {});
        window.bucksTabs.setVisible(this.tabViewId, true).catch(() => {});
        // web-mode pages are square-cornered; the dashboard look is rounded.
        window.bucksTabs.setBorderRadius(
          this.tabViewId, document.body.classList.contains('web-mode') ? 0 : 32
        ).catch(() => {});
      }
    }
  }

  /* ── shared sync loop ──
     One rAF-debounced pass over all instances, kicked by layout-affecting
     signals and a low-frequency safety interval (covers CSS transitions). */
  let syncQueued = false;
  function syncAll() {
    syncQueued = false;
    for (const tv of instances.values()) tv._sync();
  }
  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(syncAll);
  }

  window.addEventListener('resize', scheduleSync);
  document.addEventListener('transitionend', scheduleSync, true);
  document.addEventListener('animationend', scheduleSync, true);
  setInterval(scheduleSync, 250);

  const mo = new MutationObserver(scheduleSync);
  window.addEventListener('DOMContentLoaded', () => {
    mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
  });

  /* ── main-process events → per-instance webview-style events ── */
  window.bucksTabs.onEvent((evt) => {
    const tv = instances.get(evt.tabId);
    if (!tv) return;
    switch (evt.type) {
      case 'nav-state':
        tv._canGoBack = !!evt.canGoBack;
        tv._canGoForward = !!evt.canGoForward;
        break;
      case 'did-navigate':
      case 'did-navigate-in-page':
        tv._url = evt.url || tv._url;
        tv._emit(evt.type, { url: evt.url });
        break;
      case 'page-title-updated':
        tv._emit(evt.type, { title: evt.title });
        break;
      case 'page-favicon-updated':
        tv._emit(evt.type, { favicons: evt.favicons });
        break;
      case 'found-in-page':
        tv._emit(evt.type, { result: evt.result });
        break;
      case 'new-window':
        tv._emit(evt.type, { url: evt.url });
        break;
      case 'did-fail-load':
        tv._emit(evt.type, { errorCode: evt.errorCode, errorDescription: evt.errorDescription, validatedURL: evt.validatedURL });
        break;
      default:
        tv._emit(evt.type, evt);
    }
  });

  window.BucksTabView = TabView;
})();
