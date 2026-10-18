// Minimal stand-in for the `electron` module so main-process modules can be imported under
// plain Node for unit tests of their pure helpers. Nothing here launches Electron.

const noop = () => {};
const handlers = new Map();

export const ipcMain = {
  handle: (channel, fn) => handlers.set(channel, fn),
  on: noop,
  removeHandler: (channel) => handlers.delete(channel),
  /** test helper: registered handlers by channel */
  _handlers: handlers,
};

export const app = {
  on: noop,
  once: noop,
  getName: () => 'Bucks Browser',
  getVersion: () => '0.0.0-test',
  getPath: () => '/tmp/bucks-test',
  isPackaged: false,
};

export const shell = { openExternal: async () => {}, openPath: async () => '', showItemInFolder: noop };
export const clipboard = { writeText: noop, writeImage: noop };
export const screen = { getAllDisplays: () => [] };
export const dialog = { showSaveDialog: async () => ({ canceled: true }) };
export const nativeImage = { createEmpty: () => ({ getSize: () => ({ width: 0, height: 0 }) }) };
export const session = { fromPartition: () => ({ on: noop, protocol: { handle: noop } }), defaultSession: { on: noop, protocol: { handle: noop } } };

export class BrowserWindow {
  constructor() {
    throw new Error('BrowserWindow is not available in unit tests');
  }
}
export class WebContentsView {
  constructor() {
    throw new Error('WebContentsView is not available in unit tests');
  }
}
export const Menu = {
  buildFromTemplate: (template) => ({ template, popup: noop }),
  setApplicationMenu: noop,
};
export class MenuItem {
  constructor(opts) {
    Object.assign(this, opts);
  }
}

export default { ipcMain, app, shell, clipboard, screen, dialog, nativeImage, session, BrowserWindow, WebContentsView, Menu, MenuItem };
