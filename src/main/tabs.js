// TabManager: one WebContentsView per external tab, placed over the chrome at the rectangle
// the renderer reports. The renderer owns the tab list; this module owns the views and pushes
// TabState changes back over 'bucks:tabs:updated' (see docs/IPC-CONTRACT.md).
//
// Pure helpers (navigation policy, URL canonicalisation, bounds clamping, TabState building)
// are exported for unit tests; everything touching Electron lives inside createTabManager.

import { WebContentsView, ipcMain } from 'electron';
import { normalizeIpfsUrl } from './ipfs/cid.js';
import { createLogger } from './log.js';

const log = createLogger('tabs');

/** Longest URL accepted over IPC. */
export const MAX_URL_LENGTH = 8 * 1024;
/** Schemes web content may navigate to (file: only for tabs the user opened on a file: URL). */
export const ALLOWED_SCHEMES = Object.freeze(['http:', 'https:', 'ipfs:', 'ipns:', 'file:', 'about:', 'data:', 'blob:']);
/** Route the chrome shows for a bare "ipfs://". */
export const IPFS_HOME_URL = 'bucks://ipfs';
/** Disposition used when a page asks to navigate its own tab to a bucks:// route. */
export const CURRENT_TAB_DISPOSITION = 'current-tab';

const EXTRACT_TEXT_LIMIT = 20_000;
const CAPTURE_WIDTH = 400;
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -7.5; // ≈ 25 %
const ZOOM_MAX = 9; // ≈ 500 %
const ISOLATED_WORLD_ID = 1013;
const ERR_ABORTED = -3;
const ERR_CONNECTION_REFUSED = -102;

/** "https://x" → "https:", "ipfs://…" → "ipfs:"; null when there is no scheme. */
export function schemeOf(url) {
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(String(url ?? ''));
  return m ? `${m[1].toLowerCase()}:` : null;
}

/** "ipfs://" / "ipns://" with no host. */
export function isBareIpfsUrl(url) {
  return /^\s*(ipfs|ipns):\/*\s*$/i.test(String(url ?? ''));
}

/** Canonical form reported to the chrome: ipfs/ipns URLs normalised (CIDv1 base32), others unchanged. */
export function canonicalUrl(url) {
  if (typeof url !== 'string') return '';
  const scheme = schemeOf(url);
  return scheme === 'ipfs:' || scheme === 'ipns:' ? normalizeIpfsUrl(url) : url;
}

/**
 * What to do with a navigation requested by web content.
 * @param {string} url
 * @param {{ allowFile?: boolean }} [opts] allowFile: the tab was opened on a file: URL by the user
 * @returns {'allow' | 'forward' | 'block'} forward = hand to the chrome as an open-request
 */
export function navigationDecision(url, { allowFile = false } = {}) {
  const scheme = schemeOf(url);
  if (!scheme) return 'block';
  if (scheme === 'bucks:') return 'forward';
  if (scheme === 'javascript:') return 'block';
  if (scheme === 'file:') return allowFile ? 'allow' : 'block';
  return ALLOWED_SCHEMES.includes(scheme) ? 'allow' : 'block';
}

/** Integer, non-negative rectangle. Missing / NaN values become 0. */
export function clampBounds(b) {
  const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return { x: n(b?.x), y: n(b?.y), width: n(b?.width), height: n(b?.height) };
}

/** did-fail-load errors for which an HTTPS-only upgrade should fall back to plain http. */
export function isHttpsFallbackError(code, description) {
  if (code === ERR_CONNECTION_REFUSED) return true;
  return /^ERR_(SSL_|CERT_)/.test(String(description ?? ''));
}

/** True when `failedUrl` (https) is the HTTPS-only upgrade of what was requested (http, same host). */
export function isUpgradedHttpsFailure(requestedUrl, failedUrl) {
  try {
    const r = new URL(requestedUrl);
    const f = new URL(failedUrl);
    return r.protocol === 'http:' && f.protocol === 'https:' && r.hostname === f.hostname;
  } catch {
    return false;
  }
}

/** https://host/path → http://host/path */
export function downgradeToHttp(url) {
  const u = new URL(url);
  u.protocol = 'http:';
  return u.href;
}

/**
 * Build a TabState from a WebContents-like object. Exported for tests.
 * @param {{ id: string, wc: object, favicon: string | null, error: object | null, requestedUrl?: string }} tab
 */
export function buildTabState({ id, wc, favicon, error, requestedUrl }) {
  const nav = wc.navigationHistory;
  const rawUrl = wc.getURL() || requestedUrl || '';
  return {
    id,
    url: canonicalUrl(rawUrl),
    title: wc.getTitle() || '',
    favicon: favicon ?? null,
    isLoading: !!wc.isLoading(),
    canGoBack: nav ? nav.canGoBack() : false,
    canGoForward: nav ? nav.canGoForward() : false,
    error: error ?? null,
    audible: typeof wc.isCurrentlyAudible === 'function' ? !!wc.isCurrentlyAudible() : false,
  };
}

function requireId(payload) {
  const id = payload?.id;
  if (typeof id !== 'string' || !id || id.length > 128) throw new Error('A tab id (string) is required');
  return id;
}

function requireUrl(payload) {
  const url = payload?.url;
  if (typeof url !== 'string' || !url.trim()) throw new Error('A url (string) is required');
  if (url.length > MAX_URL_LENGTH) throw new Error('URL is too long');
  return url.trim();
}

function pickFavicon(favicons) {
  if (!Array.isArray(favicons)) return null;
  return favicons.find((f) => typeof f === 'string' && f) ?? null;
}

const EXTRACT_TEXT_SCRIPT = `(() => {
  const body = document.body;
  const text = body ? body.innerText : '';
  return {
    title: String(document.title || ''),
    text: String(text || '').trim().slice(0, ${EXTRACT_TEXT_LIMIT}),
    url: String(location.href || ''),
  };
})()`;

/**
 * Create the tab manager and register every bucks:tabs:* channel.
 * @param {{
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   webSession: import('electron').Session,
 *   settings: { get(): any },
 *   security?: { allowHttpHost?: (host: string) => void },
 * }} opts
 */
export function createTabManager({ getMainWindow, webSession, settings, security }) {
  if (!webSession) throw new Error('createTabManager: webSession is required');

  /** @type {Map<string, Tab>} */
  const tabs = new Map();
  let activeId = null;
  let contentBounds = { x: 0, y: 0, width: 0, height: 0 };
  let contentVisible = true;
  let boundWindow = null;

  /**
   * @typedef {object} Tab
   * @property {string} id
   * @property {WebContentsView} view
   * @property {import('electron').WebContents} wc
   * @property {string | null} favicon
   * @property {{ code: number, description: string, url: string } | null} error
   * @property {boolean} attached   added to the window's contentView (lazily, on first activate)
   * @property {boolean} allowFile  opened by the user on a file: URL
   * @property {string} requestedUrl last URL asked for (by the chrome or a user click)
   * @property {boolean} closing    close() in progress → 'destroyed' is expected
   * @property {boolean} htmlFullscreen
   * @property {string | null} httpFallbackHost host already retried over http
   */

  // ── chrome messaging ──────────────────────────────────────────────────────────

  function send(channel, payload) {
    const win = getMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }

  function emitUpdated(tab) {
    if (!tabs.has(tab.id) || tab.wc.isDestroyed()) return;
    send('bucks:tabs:updated', buildTabState(tab));
  }

  function emitOpenRequest(openerId, url, disposition) {
    send('bucks:tabs:open-request', { openerId: openerId ?? null, url: canonicalUrl(url), disposition: disposition || 'foreground-tab' });
  }

  // ── window binding & geometry ─────────────────────────────────────────────────

  function fullBounds(win) {
    const { width, height } = win.getContentBounds();
    return { x: 0, y: 0, width, height };
  }

  function applyBounds(tab) {
    const win = boundWindow;
    if (!tab.attached || !win || win.isDestroyed()) return;
    tab.view.setBounds(tab.htmlFullscreen ? fullBounds(win) : contentBounds);
  }

  function updateVisibility() {
    for (const tab of tabs.values()) {
      if (!tab.attached) continue;
      tab.view.setVisible(tab.id === activeId && contentVisible);
    }
  }

  /** Attach lifecycle listeners to the current chrome window (once per window). */
  function bindWindow() {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    if (win === boundWindow) return win;
    boundWindow = win;
    win.on('resize', () => {
      const tab = tabs.get(activeId);
      if (tab?.htmlFullscreen) applyBounds(tab);
    });
    win.once('closed', () => {
      if (boundWindow === win) boundWindow = null;
      destroyAll();
    });
    return win;
  }

  function detach(tab) {
    if (!tab.attached) return;
    tab.attached = false;
    const win = boundWindow;
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(tab.view);
      } catch (e) {
        log.debug('removeChildView failed:', e.message);
      }
    }
  }

  function forget(tab) {
    tabs.delete(tab.id);
    detach(tab);
    if (activeId === tab.id) activeId = null;
  }

  function destroyView(tab) {
    tab.closing = true;
    forget(tab);
    const wc = tab.wc;
    if (wc.isDestroyed()) return;
    try {
      if (typeof wc.close === 'function') wc.close({ waitForBeforeUnload: false });
      else wc.destroy();
    } catch (e) {
      log.warn(`Failed to destroy tab ${tab.id}: ${e.message}`);
    }
  }

  function destroyAll() {
    for (const tab of [...tabs.values()]) destroyView(tab);
    activeId = null;
  }

  // ── tab lookup ────────────────────────────────────────────────────────────────

  function requireTab(id) {
    const tab = tabs.get(id);
    if (!tab || tab.wc.isDestroyed()) throw new Error(`Unknown tab: ${id}`);
    return tab;
  }

  function load(tab, url) {
    tab.requestedUrl = url;
    tab.wc.loadURL(url).catch((e) => log.debug(`loadURL(${url}) rejected: ${e?.message || e}`));
  }

  // ── web contents wiring ───────────────────────────────────────────────────────

  function handleNavigationIntent(tab, event, url, source) {
    const decision = navigationDecision(url, { allowFile: tab.allowFile });
    if (decision === 'allow') {
      if (source === 'will-navigate') tab.requestedUrl = url;
      return;
    }
    event.preventDefault();
    if (decision === 'forward') {
      emitOpenRequest(tab.id, url, CURRENT_TAB_DISPOSITION);
    } else {
      log.warn(`Blocked ${source} to ${url.slice(0, 200)} from tab ${tab.id}`);
    }
  }

  function handleFailLoad(tab, code, description, validatedURL, isMainFrame) {
    if (!isMainFrame || code === ERR_ABORTED) return;
    tab.error = { code, description: String(description || ''), url: validatedURL || tab.requestedUrl || '' };

    const httpsOnly = settings?.get?.()?.security?.httpsOnly !== false;
    if (
      httpsOnly &&
      validatedURL &&
      isHttpsFallbackError(code, description) &&
      isUpgradedHttpsFailure(tab.requestedUrl, validatedURL) &&
      typeof security?.allowHttpHost === 'function'
    ) {
      const host = new URL(validatedURL).hostname;
      if (tab.httpFallbackHost !== host) {
        tab.httpFallbackHost = host;
        try {
          security.allowHttpHost(host);
        } catch (e) {
          log.warn(`allowHttpHost(${host}) failed: ${e.message}`);
        }
        log.info(`HTTPS upgrade failed for ${host} (${description}); retrying over http`);
        tab.error = null;
        load(tab, downgradeToHttp(validatedURL));
        return;
      }
    }
    emitUpdated(tab);
  }

  function wire(tab) {
    const { wc, id } = tab;

    wc.setWindowOpenHandler(({ url, disposition }) => {
      emitOpenRequest(id, url, disposition);
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, url) => handleNavigationIntent(tab, event, url, 'will-navigate'));
    wc.on('will-redirect', (event, url) => handleNavigationIntent(tab, event, url, 'will-redirect'));

    wc.on('did-start-loading', () => {
      tab.error = null;
      emitUpdated(tab);
    });
    wc.on('did-stop-loading', () => emitUpdated(tab));
    wc.on('did-navigate', () => {
      tab.favicon = null;
      emitUpdated(tab);
    });
    wc.on('did-navigate-in-page', () => emitUpdated(tab));
    wc.on('page-title-updated', () => emitUpdated(tab));
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = pickFavicon(favicons);
      emitUpdated(tab);
    });
    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) =>
      handleFailLoad(tab, code, description, validatedURL, isMainFrame),
    );
    wc.on('media-started-playing', () => emitUpdated(tab));
    wc.on('media-paused', () => emitUpdated(tab));
    wc.on('render-process-gone', (_e, details) => {
      log.warn(`Tab ${id} renderer gone: ${details?.reason}`);
      tab.error = { code: -1, description: 'Page crashed', url: wc.isDestroyed() ? tab.requestedUrl : wc.getURL() };
      emitUpdated(tab);
    });
    wc.on('enter-html-full-screen', () => {
      tab.htmlFullscreen = true;
      applyBounds(tab);
    });
    wc.on('leave-html-full-screen', () => {
      tab.htmlFullscreen = false;
      applyBounds(tab);
    });
    wc.on('destroyed', () => {
      if (tab.closing) return;
      // The page closed itself (window.close()) — tell the chrome to drop the tab.
      forget(tab);
      send('bucks:tabs:closed', { id });
    });
  }

  function createView(id, url) {
    const view = new WebContentsView({
      webPreferences: {
        session: webSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
        backgroundColor: '#ffffff',
      },
    });
    if (typeof view.setBackgroundColor === 'function') view.setBackgroundColor('#ffffff');
    /** @type {Tab} */
    const tab = {
      id,
      view,
      wc: view.webContents,
      favicon: null,
      error: null,
      attached: false,
      allowFile: schemeOf(url) === 'file:',
      requestedUrl: url,
      closing: false,
      htmlFullscreen: false,
      httpFallbackHost: null,
    };
    tabs.set(id, tab);
    wire(tab);
    return tab;
  }

  /** The chrome asked for a URL. Returns the URL to load, or null when it was handed back as an open-request. */
  function prepareChromeUrl(id, url) {
    if (isBareIpfsUrl(url)) {
      emitOpenRequest(id, IPFS_HOME_URL, CURRENT_TAB_DISPOSITION);
      return null;
    }
    const decision = navigationDecision(url, { allowFile: true });
    if (decision === 'forward') throw new Error('bucks:// pages are rendered by the chrome, not in a web view');
    if (decision === 'block') throw new Error(`Cannot open "${schemeOf(url) || url.slice(0, 40)}" URLs in a tab`);
    return canonicalUrl(url);
  }

  function placeholderState(id, url) {
    return { id, url, title: '', favicon: null, isLoading: false, canGoBack: false, canGoForward: false, error: null, audible: false };
  }

  // ── public API ────────────────────────────────────────────────────────────────

  const manager = {
    /** Create the view for a renderer-side tab id and start loading `url`. */
    create(id, url) {
      if (tabs.has(id)) return manager.navigate(id, url);
      const target = prepareChromeUrl(id, url);
      if (target === null) return placeholderState(id, IPFS_HOME_URL);
      const tab = createView(id, target);
      bindWindow();
      load(tab, target);
      return buildTabState(tab);
    },

    /** Navigate an existing tab (creates the view when missing). */
    navigate(id, url) {
      const tab = tabs.get(id);
      if (!tab || tab.wc.isDestroyed()) return manager.create(id, url);
      const target = prepareChromeUrl(id, url);
      if (target === null) return buildTabState(tab);
      if (schemeOf(target) === 'file:') tab.allowFile = true;
      tab.httpFallbackHost = null;
      load(tab, target);
      if (id === activeId && contentVisible) tab.wc.focus();
      return buildTabState(tab);
    },

    /** Remove the view and destroy its web contents. Unknown ids are ignored. */
    close(id) {
      const tab = tabs.get(id);
      if (!tab) return;
      destroyView(tab);
      updateVisibility();
    },

    /** Show exactly this tab's view (attaching it on first use); null hides every view. */
    activate(id) {
      if (id !== null && id !== undefined && !tabs.has(id)) throw new Error(`Unknown tab: ${id}`);
      activeId = id ?? null;
      const win = bindWindow();
      const tab = tabs.get(activeId);
      if (tab && win) {
        if (!tab.attached) {
          win.contentView.addChildView(tab.view);
          tab.attached = true;
        }
        applyBounds(tab);
      }
      updateVisibility();
      if (tab && contentVisible && !tab.wc.isDestroyed()) tab.wc.focus();
    },

    back(id) {
      const { wc } = requireTab(id);
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    },
    forward(id) {
      const { wc } = requireTab(id);
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    },
    reload(id) {
      requireTab(id).wc.reload();
    },
    stop(id) {
      requireTab(id).wc.stop();
    },

    /** @returns {object | null} TabState, or null when the id has no live view */
    getState(id) {
      const tab = tabs.get(id);
      return tab && !tab.wc.isDestroyed() ? buildTabState(tab) : null;
    },

    /** Rectangle (CSS px, chrome viewport) where the active view is drawn. */
    setContentBounds(bounds) {
      contentBounds = clampBounds(bounds);
      const tab = tabs.get(activeId);
      if (tab) applyBounds(tab);
    },
    getContentBounds: () => ({ ...contentBounds }),

    /** Hide / show the active view without destroying it (chrome overlays). */
    setContentVisible(visible) {
      contentVisible = !!visible;
      updateVisibility();
    },

    /** @returns {Promise<string>} PNG data URL, at most 400 px wide */
    async capture(id) {
      const { wc } = requireTab(id);
      const image = await wc.capturePage();
      const { width, height } = image.getSize();
      if (!width || !height) throw new Error('Nothing to capture: the page has not been rendered yet');
      const scaled = width > CAPTURE_WIDTH ? image.resize({ width: CAPTURE_WIDTH }) : image;
      return scaled.toDataURL();
    },

    /** @returns {Promise<{ title: string, text: string, url: string }>} */
    async extractText(id) {
      const tab = requireTab(id);
      const state = buildTabState(tab);
      let result = null;
      try {
        result = await tab.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: EXTRACT_TEXT_SCRIPT }]);
      } catch (e) {
        log.debug(`extractText(${id}) failed: ${e?.message || e}`);
      }
      const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
      return {
        title: str(result?.title, 1024) || state.title,
        text: str(result?.text, EXTRACT_TEXT_LIMIT),
        url: str(result?.url, MAX_URL_LENGTH) || state.url,
      };
    },

    zoomIn(id) {
      const { wc } = requireTab(id);
      wc.setZoomLevel(Math.min(ZOOM_MAX, wc.getZoomLevel() + ZOOM_STEP));
    },
    zoomOut(id) {
      const { wc } = requireTab(id);
      wc.setZoomLevel(Math.max(ZOOM_MIN, wc.getZoomLevel() - ZOOM_STEP));
    },
    zoomReset(id) {
      requireTab(id).wc.setZoomLevel(0);
    },

    /** @returns {number} Chromium find request id */
    findInPage(id, text, { forward = true, findNext = false } = {}) {
      if (typeof text !== 'string' || !text) throw new Error('Search text is required');
      return requireTab(id).wc.findInPage(text, { forward: !!forward, findNext: !!findNext });
    },
    stopFindInPage(id, action = 'clearSelection') {
      requireTab(id).wc.stopFindInPage(action);
    },

    getActiveId: () => activeId,
    getWebContents: (id) => tabs.get(id)?.wc ?? null,
    getActiveWebContents: () => (activeId ? tabs.get(activeId)?.wc ?? null : null),
    ids: () => [...tabs.keys()],
    /** True when `wc` belongs to one of the tabs (used by the context menu). */
    ownsWebContents: (wc) => [...tabs.values()].some((t) => t.wc === wc),
    /** Tab id owning `wc`, or null. */
    idForWebContents: (wc) => [...tabs.values()].find((t) => t.wc === wc)?.id ?? null,
    /** Ask the chrome to open a URL (used by the context menu). */
    requestOpen: (openerId, url, disposition) => emitOpenRequest(openerId, url, disposition),
    /** Current settings snapshot (for modules that only receive the manager). */
    getSettings: () => settings?.get?.() ?? {},
    destroyAll,
  };

  // ── IPC ───────────────────────────────────────────────────────────────────────

  ipcMain.handle('bucks:tabs:create', (_e, p) => manager.create(requireId(p), requireUrl(p)));
  ipcMain.handle('bucks:tabs:navigate', (_e, p) => manager.navigate(requireId(p), requireUrl(p)));
  ipcMain.handle('bucks:tabs:close', (_e, p) => manager.close(requireId(p)));
  ipcMain.handle('bucks:tabs:activate', (_e, p) => {
    const id = p?.id;
    if (id !== null && id !== undefined) requireId(p);
    manager.activate(id ?? null);
  });
  ipcMain.handle('bucks:tabs:back', (_e, p) => manager.back(requireId(p)));
  ipcMain.handle('bucks:tabs:forward', (_e, p) => manager.forward(requireId(p)));
  ipcMain.handle('bucks:tabs:reload', (_e, p) => manager.reload(requireId(p)));
  ipcMain.handle('bucks:tabs:stop', (_e, p) => manager.stop(requireId(p)));
  ipcMain.handle('bucks:tabs:get-state', (_e, p) => manager.getState(requireId(p)));
  ipcMain.handle('bucks:tabs:set-content-bounds', (_e, b) => {
    if (!b || typeof b !== 'object') throw new Error('Bounds { x, y, width, height } are required');
    manager.setContentBounds(b);
  });
  ipcMain.handle('bucks:tabs:set-content-visible', (_e, p) => manager.setContentVisible(p?.visible !== false));
  ipcMain.handle('bucks:tabs:capture', (_e, p) => manager.capture(requireId(p)));
  ipcMain.handle('bucks:tabs:extract-text', (_e, p) => manager.extractText(requireId(p)));

  return manager;
}
