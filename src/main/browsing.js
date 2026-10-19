// Browsing data and the operating system's "default browser" integration.
//
//   bucks:browsing-data:clear      { cookies, cache, siteData } → clears the web sessions
//   bucks:app:default-browser      → DefaultBrowserStatus
//   bucks:app:set-default-browser  → DefaultBrowserStatus (asks the OS; Windows opens its settings)
//
// Links the OS hands to Bucks (the command line of a first or second launch, macOS 'open-url')
// are forwarded to the chrome as open-requests once its window has loaded.

import path from 'node:path';
import { app, ipcMain, shell } from 'electron';
import { createLogger } from './log.js';

const log = createLogger('browsing');

/** Web storages cleared for "site data" (Electron's names). */
export const SITE_DATA_STORAGES = Object.freeze(['filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']);
/** Schemes Bucks registers for as a browser. */
export const BROWSER_PROTOCOLS = Object.freeze(['http', 'https']);
const OPENABLE = /^(https?|ipfs|ipns|file):/i;
const MAX_URL = 8 * 1024;

/**
 * URLs on a command line (first launch, or a second launch forwarded by the single-instance
 * lock): http(s), ipfs, ipns and file URLs; flags, the app path and anything else are ignored.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function urlsFromArgv(argv) {
  if (!Array.isArray(argv)) return [];
  const out = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.startsWith('-') || arg.length > MAX_URL) continue;
    const s = arg.trim();
    if (OPENABLE.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** What to clear, with every flag defaulting to false. */
export function clearOptions(payload) {
  return {
    cookies: payload?.cookies === true,
    cache: payload?.cache === true,
    siteData: payload?.siteData === true,
  };
}

/**
 * Clear browsing data from the given sessions.
 * @param {Array<import('electron').Session>} sessions
 * @param {{ cookies: boolean, cache: boolean, siteData: boolean }} what
 */
export async function clearSessions(sessions, what) {
  const storages = [...(what.cookies ? ['cookies'] : []), ...(what.siteData ? SITE_DATA_STORAGES : [])];
  for (const ses of sessions) {
    if (!ses) continue;
    if (storages.length) await ses.clearStorageData({ storages });
    if (what.cache) {
      await ses.clearCache();
      await ses.clearHostResolverCache?.();
    }
  }
  return { cleared: Object.keys(what).filter((k) => what[k]) };
}

/**
 * @param {{
 *   sessions: Array<import('electron').Session>,
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   platform?: string,
 * }} deps
 */
export function installBrowsing({ sessions, getMainWindow, platform = process.platform }) {
  // In a source checkout Electron runs as "electron <app dir>"; the OS must start it the same way.
  const registration = process.defaultApp ? [process.execPath, [path.resolve(process.argv[1] || '.')]] : [];

  function defaultStatus() {
    const protocols = {};
    for (const p of [...BROWSER_PROTOCOLS, 'ipfs', 'ipns']) {
      try {
        protocols[p] = app.isDefaultProtocolClient(p, ...registration);
      } catch {
        protocols[p] = false;
      }
    }
    return {
      isDefault: BROWSER_PROTOCOLS.every((p) => protocols[p]),
      protocols,
      // Windows 10+ only lets the user change it, in Settings.
      opensSystemSettings: platform === 'win32',
    };
  }

  async function setDefault() {
    if (platform === 'win32') {
      for (const p of [...BROWSER_PROTOCOLS, 'ipfs', 'ipns']) app.setAsDefaultProtocolClient(p, ...registration);
      await shell.openExternal('ms-settings:defaultapps');
      return defaultStatus();
    }
    for (const p of [...BROWSER_PROTOCOLS, 'ipfs', 'ipns']) {
      const ok = app.setAsDefaultProtocolClient(p, ...registration);
      if (!ok) log.warn(`The system refused to make Bucks the handler for ${p}:`);
    }
    return defaultStatus();
  }

  // ── links from the OS ──────────────────────────────────────────────────────
  const pending = [];
  let chromeReady = false;

  function deliver(url) {
    const win = getMainWindow();
    if (!chromeReady || !win || win.isDestroyed() || win.webContents.isDestroyed()) {
      if (pending.length < 50) pending.push(url);
      return;
    }
    win.webContents.send('bucks:tabs:open-request', { openerId: null, url, disposition: 'foreground-tab' });
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  const api = {
    defaultStatus,
    setDefault,
    clear: (payload) => clearSessions(sessions, clearOptions(payload)),
    /** Open URLs given on a command line (first launch or a forwarded second launch). */
    openFromArgv(argv) {
      for (const url of urlsFromArgv(argv)) deliver(url);
    },
    /** macOS 'open-url'. */
    openUrl(url) {
      for (const u of urlsFromArgv([url])) deliver(u);
    },
    /** Call once the chrome window has loaded: flushes links that arrived before it. */
    chromeLoaded() {
      chromeReady = true;
      for (const url of pending.splice(0)) deliver(url);
    },
  };

  ipcMain.removeHandler?.('bucks:browsing-data:clear');
  ipcMain.handle('bucks:browsing-data:clear', (_e, p) => api.clear(p));
  ipcMain.removeHandler?.('bucks:app:default-browser');
  ipcMain.handle('bucks:app:default-browser', () => api.defaultStatus());
  ipcMain.removeHandler?.('bucks:app:set-default-browser');
  ipcMain.handle('bucks:app:set-default-browser', () => api.setDefault());

  return api;
}
