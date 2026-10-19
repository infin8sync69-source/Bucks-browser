const { BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');

let ephemeralWindow = null;

const EPHEMERAL_WIDTH  = 620;
const EPHEMERAL_HEIGHT_INPUT = 72;   // collapsed: input only
const EPHEMERAL_HEIGHT_MAX   = 480;  // expanded: input + response + chips

function createEphemeralWindow(parentWindow) {
  if (ephemeralWindow) return ephemeralWindow;

  ephemeralWindow = new BrowserWindow({
    width:  EPHEMERAL_WIDTH,
    height: EPHEMERAL_HEIGHT_INPUT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    resizable: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'ephemeral-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  ephemeralWindow.loadFile(path.join(__dirname, 'ephemeral.html'));

  ephemeralWindow.on('blur', () => {
    // Hide when clicking away (only collapse, not destroy)
    if (ephemeralWindow && !ephemeralWindow.isDestroyed()) {
      ephemeralWindow.hide();
    }
  });

  ephemeralWindow.on('closed', () => {
    ephemeralWindow = null;
  });

  return ephemeralWindow;
}

function toggleEphemeralWindow() {
  if (!ephemeralWindow) return;
  if (ephemeralWindow.isVisible()) {
    ephemeralWindow.hide();
  } else {
    // Center it, then shift upward for Spotlight feel
    ephemeralWindow.center();
    const bounds = ephemeralWindow.getBounds();
    ephemeralWindow.setBounds({
      ...bounds,
      width: EPHEMERAL_WIDTH,
      height: EPHEMERAL_HEIGHT_INPUT,
      y: bounds.y - 160
    });
    ephemeralWindow.show();
    ephemeralWindow.focus();
    ephemeralWindow.webContents.send('focus-input');
  }
}

function setupEphemeralShortcuts() {
  globalShortcut.register('CommandOrControl+K', () => {
    toggleEphemeralWindow();
  });
}

function cleanupEphemeralShortcuts() {
  globalShortcut.unregister('CommandOrControl+K');
}

// IPC Handlers
function setupEphemeralIPC(mainBrowserWindow) {
  // "Open in chat" — route to main window and hide
  ipcMain.handle('ephemeral:submit', (event, { query }) => {
    if (ephemeralWindow && !ephemeralWindow.isDestroyed()) {
      ephemeralWindow.hide();
    }
    if (mainBrowserWindow && !mainBrowserWindow.isDestroyed()) {
      mainBrowserWindow.webContents.send('agent:ephemeral-query', { query });
    }
  });

  ipcMain.on('ephemeral:hide', () => {
    if (ephemeralWindow && !ephemeralWindow.isDestroyed()) {
      ephemeralWindow.hide();
      // Reset to input-only height so next open is clean
      ephemeralWindow.setBounds({
        ...ephemeralWindow.getBounds(),
        height: EPHEMERAL_HEIGHT_INPUT
      });
    }
  });

  // Renderer calls this to expand/shrink the window during streaming
  ipcMain.on('ephemeral:resize', (event, { height }) => {
    if (!ephemeralWindow || ephemeralWindow.isDestroyed()) return;
    const clamped = Math.max(EPHEMERAL_HEIGHT_INPUT, Math.min(height, EPHEMERAL_HEIGHT_MAX));
    const bounds = ephemeralWindow.getBounds();
    // Grow upward so the input row stays anchored at the bottom
    const dy = bounds.height - clamped;
    ephemeralWindow.setBounds({
      x: bounds.x,
      y: bounds.y + dy,
      width: bounds.width,
      height: clamped
    });
  });
}

module.exports = {
  createEphemeralWindow,
  setupEphemeralShortcuts,
  cleanupEphemeralShortcuts,
  setupEphemeralIPC,
  toggleEphemeralWindow
};
