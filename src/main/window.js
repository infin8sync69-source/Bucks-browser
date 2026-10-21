// The chrome window: a frameless BrowserWindow that loads the SvelteKit chrome from
// bucks://app/ (or a Vite dev server) and remembers its bounds across launches.

import path from 'node:path';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { MIN_WINDOW_SIZE, readWindowState, sanitizeWindowState, writeWindowState } from './window-state.js';
import { createLogger } from './log.js';
import { THEME_HEX } from './design/page.js';

const log = createLogger('window');

/** Production chrome URL (served by protocols/bucks.js). */
export const CHROME_URL = 'bucks://app/';
export const CHROME_BACKGROUND_DARK = THEME_HEX.dark.canvas;
export const CHROME_BACKGROUND_LIGHT = THEME_HEX.light.canvas;

const DEV_RETRY_INTERVAL_MS = 500;
const DEV_RETRY_TOTAL_MS = 20_000;
const STATE_SAVE_DEBOUNCE_MS = 400;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Persist bounds on move/resize (debounced) and on close. */
function trackWindowState(win, file) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const bounds = maximized || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    writeWindowState(file, { ...bounds, maximized });
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(save, STATE_SAVE_DEBOUNCE_MS);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    clearTimeout(timer);
    save();
  });
}

/**
 * Load the chrome. In dev (Vite may still be starting) a failed main-frame load of the dev URL
 * is retried every 500 ms for up to 20 s.
 */
function loadChrome(win, devUrl) {
  const url = devUrl || CHROME_URL;
  const chromeOrigin = originOf(url);
  let waited = 0;

  win.webContents.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED */) return;
    if (chromeOrigin && originOf(validatedURL) !== chromeOrigin) return;
    if (devUrl && waited < DEV_RETRY_TOTAL_MS) {
      waited += DEV_RETRY_INTERVAL_MS;
      setTimeout(() => {
        if (!win.isDestroyed()) win.loadURL(url).catch(() => {});
      }, DEV_RETRY_INTERVAL_MS);
      return;
    }
    log.error(`Chrome failed to load ${validatedURL}: ${description} (${code})`);
  });

  // The chrome never navigates away from its own origin (links are opened as tabs by the renderer).
  win.webContents.on('will-navigate', (event, target) => {
    if (chromeOrigin && originOf(target) !== chromeOrigin) {
      event.preventDefault();
      log.warn(`Blocked chrome navigation to ${target}`);
    }
  });

  win.loadURL(url).catch(() => {});
}

/**
 * Create the frameless chrome window.
 * @param {{ preloadPath: string, settings?: { get(): any }, devUrl?: string | null }} opts
 * @returns {BrowserWindow}
 */
export function createMainWindow({ preloadPath, settings, devUrl = null }) {
  if (!preloadPath) throw new Error('createMainWindow: preloadPath is required');
  const isMac = process.platform === 'darwin';
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const state = sanitizeWindowState(readWindowState(stateFile), screen.getAllDisplays());
  const theme = settings?.get?.()?.ui?.theme;

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    title: 'Bucks Browser',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
    autoHideMenuBar: true,
    backgroundColor: theme === 'light' ? CHROME_BACKGROUND_LIGHT : CHROME_BACKGROUND_DARK,
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  if (!isMac) win.setMenuBarVisibility(false);
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('maximize', () => win.webContents.send('bucks:window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('bucks:window:maximized', false));

  trackWindowState(win, stateFile);
  loadChrome(win, devUrl);
  return win;
}

/**
 * bucks:window:minimize / maximize (toggle) / close / is-maximized.
 * @param {{ getMainWindow: () => BrowserWindow | null }} opts
 */
export function registerWindowIpc({ getMainWindow }) {
  const live = () => {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  };
  ipcMain.handle('bucks:window:minimize', () => {
    live()?.minimize();
  });
  ipcMain.handle('bucks:window:maximize', () => {
    const win = live();
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('bucks:window:close', () => {
    live()?.close();
  });
  ipcMain.handle('bucks:window:is-maximized', () => live()?.isMaximized() ?? false);
}
