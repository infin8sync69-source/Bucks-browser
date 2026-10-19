// Native application menu. Its main job is to own the keyboard accelerators: each one is
// forwarded to the chrome as 'bucks:app:shortcut' { action } (the renderer owns the tab model),
// Zoom and devtools are applied here as well (only main can reach a tab's web contents); the
// action is still emitted so the chrome can react (e.g. update a zoom indicator).

import { app, Menu, shell } from 'electron';
import { createLogger } from './log.js';

const log = createLogger('menu');

const isMac = process.platform === 'darwin';

/**
 * Build the menu template. Pure apart from the closures it stores in `click`, so it can be
 * unit-tested by inspecting labels / accelerators and invoking click handlers.
 * @param {{
 *   platform?: string,
 *   emit: (action: string) => void,
 *   tabs: { getActiveId(): string | null, getActiveWebContents(): any, zoomIn(id: string): void, zoomOut(id: string): void, zoomReset(id: string): void },
 *   getMainWindow: () => any,
 *   appName?: string,
 *   openExternal?: (url: string) => void,
 * }} deps
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function buildMenuTemplate({ platform = process.platform, emit, tabs, getMainWindow, appName = 'Bucks Browser', openExternal = () => {} }) {
  const mac = platform === 'darwin';
  const item = (label, accelerator, action, extra = {}) => ({ label, accelerator, click: () => emit(action), ...extra });

  const zoom = (action, fn) => () => {
    const id = tabs.getActiveId();
    if (id) {
      try {
        fn(id);
      } catch (e) {
        log.warn(`${action} failed: ${e.message}`);
      }
    }
    emit(action);
  };

  const toggleDevTools = () => {
    const wc = tabs.getActiveWebContents() || getMainWindow()?.webContents;
    if (wc && !wc.isDestroyed()) {
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: 'detach' });
    }
    emit('toggle-devtools');
  };

  const settingsItem = item('Settings…', 'CmdOrCtrl+,', 'open-settings');

  const fileMenu = {
    label: 'File',
    submenu: [
      item('New Tab', 'CmdOrCtrl+T', 'new-tab'),
      item('New Private Tab', 'CmdOrCtrl+Shift+N', 'new-private-tab'),
      item('Reopen Closed Tab', 'CmdOrCtrl+Shift+T', 'reopen-closed-tab'),
      item('Close Tab', 'CmdOrCtrl+W', 'close-tab'),
      { type: 'separator' },
      item('Print…', 'CmdOrCtrl+P', 'print'),
      item('Save Page as PDF…', 'CmdOrCtrl+Shift+S', 'save-pdf'),
      { type: 'separator' },
      item('Open Location', 'CmdOrCtrl+L', 'focus-omnibox'),
      item('Downloads', 'CmdOrCtrl+J', 'open-downloads'),
      ...(mac ? [] : [{ type: 'separator' }, settingsItem, { type: 'separator' }, { role: 'quit' }]),
    ],
  };

  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' }] : []),
      { role: 'delete' },
      { role: 'selectAll' },
      { type: 'separator' },
      {
        label: 'Find in Page…',
        accelerator: 'CmdOrCtrl+F',
        // The find field lives in the chrome: take keyboard focus from the page first.
        click: () => {
          const wc = getMainWindow()?.webContents;
          if (wc && !wc.isDestroyed()) wc.focus();
          emit('find');
        },
      },
    ],
  };

  const viewMenu = {
    label: 'View',
    submenu: [
      item('Reload', 'CmdOrCtrl+R', 'reload'),
      item('Reload', 'F5', 'reload', { visible: false }),
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: zoom('zoom-in', tabs.zoomIn) },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: zoom('zoom-in', tabs.zoomIn), visible: false },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+numadd', click: zoom('zoom-in', tabs.zoomIn), visible: false },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: zoom('zoom-out', tabs.zoomOut) },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+numsub', click: zoom('zoom-out', tabs.zoomOut), visible: false },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: zoom('zoom-reset', tabs.zoomReset) },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      item('Toggle Agent Sidebar', 'CmdOrCtrl+Shift+A', 'toggle-agent'),
      item('IPFS Node', undefined, 'open-ipfs'),
      item('Wallet', undefined, 'open-wallet'),
      { type: 'separator' },
      { label: 'Toggle Developer Tools', accelerator: mac ? 'Alt+Cmd+I' : 'F12', click: toggleDevTools },
      { label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: toggleDevTools, visible: false },
    ],
  };

  const historyMenu = {
    label: 'History',
    submenu: [
      item('Back', mac ? 'Cmd+[' : 'Alt+Left', 'back'),
      item('Forward', mac ? 'Cmd+]' : 'Alt+Right', 'forward'),
      { type: 'separator' },
      item('Next Tab', 'Ctrl+Tab', 'next-tab'),
      item('Previous Tab', 'Ctrl+Shift+Tab', 'prev-tab'),
    ],
  };

  const windowMenu = {
    label: 'Window',
    submenu: mac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }],
  };

  const helpMenu = {
    label: 'Help',
    role: 'help',
    submenu: [
      { label: 'Learn about IPFS', click: () => openExternal('https://docs.ipfs.tech/') },
      { label: 'Keyboard Shortcuts', click: () => emit('open-settings') },
      ...(mac ? [] : [{ type: 'separator' }, { role: 'about' }]),
    ],
  };

  const appMenu = {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  return [...(mac ? [appMenu] : []), fileMenu, editMenu, viewMenu, historyMenu, windowMenu, helpMenu];
}

/**
 * Install the application menu.
 * @param {{ getMainWindow: () => import('electron').BrowserWindow | null, tabs: object }} deps
 * @returns {Electron.Menu}
 */
export function installAppMenu({ getMainWindow, tabs }) {
  const emit = (action) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('bucks:app:shortcut', { action });
    }
  };
  const openExternal = (url) => shell.openExternal(url).catch((e) => log.warn(`openExternal failed: ${e.message}`));
  const template = buildMenuTemplate({ platform: process.platform, emit, tabs, getMainWindow, appName: app.getName(), openExternal });
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  if (isMac) log.debug('application menu installed (macOS)');
  return menu;
}
