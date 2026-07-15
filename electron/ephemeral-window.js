const { BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');

let ephemeralWindow = null;

function createEphemeralWindow(parentWindow) {
  if (ephemeralWindow) return ephemeralWindow;

  ephemeralWindow = new BrowserWindow({
    width: 600,
    height: 80,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    show: false, // Don't show until triggered
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
    // Hide when clicking away
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
    // Center it on screen
    ephemeralWindow.center();
    // Slightly move it up for better Spotlight feel
    const bounds = ephemeralWindow.getBounds();
    ephemeralWindow.setBounds({ ...bounds, y: bounds.y - 150 });
    ephemeralWindow.show();
    ephemeralWindow.focus();
    // Tell renderer to focus input
    ephemeralWindow.webContents.send('focus-input');
  }
}

function setupEphemeralShortcuts() {
  // Register Cmd+K or Ctrl+K
  globalShortcut.register('CommandOrControl+K', () => {
    toggleEphemeralWindow();
  });
}

function cleanupEphemeralShortcuts() {
  globalShortcut.unregister('CommandOrControl+K');
}

// IPC Handlers
function setupEphemeralIPC(mainBrowserWindow) {
  ipcMain.handle('ephemeral:submit', (event, { query }) => {
    if (ephemeralWindow && !ephemeralWindow.isDestroyed()) {
      ephemeralWindow.hide();
    }
    
    // Route query to the main browser window's current active tab
    if (mainBrowserWindow && !mainBrowserWindow.isDestroyed()) {
      mainBrowserWindow.webContents.send('agent:ephemeral-query', { query });
    }
  });

  ipcMain.on('ephemeral:hide', () => {
    if (ephemeralWindow) ephemeralWindow.hide();
  });
}

module.exports = {
  createEphemeralWindow,
  setupEphemeralShortcuts,
  cleanupEphemeralShortcuts,
  setupEphemeralIPC,
  toggleEphemeralWindow
};
