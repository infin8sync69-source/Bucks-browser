// Bucks Browser — main process entry point.
// Wiring only: every subsystem lives in its own module and registers its own IPC
// handlers (see docs/IPC-CONTRACT.md for the full channel list and module interfaces).

import { app, BrowserWindow, ipcMain, session } from 'electron';
import { registerSchemePrivileges } from './protocols/index.js';
import { installBucksProtocol } from './protocols/bucks.js';
import { installIpfsProtocols } from './protocols/ipfs.js';
import { createSettings } from './settings.js';
import { createKubo } from './ipfs/kubo.js';
import { registerIpfsIpc } from './ipfs/ipc.js';
import { createMainWindow, registerWindowIpc } from './window.js';
import { createTabManager } from './tabs.js';
import { installAppMenu } from './menu.js';
import { installContextMenu } from './context-menu.js';
import { installDownloads } from './downloads.js';
import { registerShellIpc } from './shell.js';
import { installSecurity } from './security/index.js';
import { createAgent } from './agent/bridge.js';
import { createWalletProxy } from './wallet/proxy.js';
import { registerUpdater } from './updater.js';
import { appRoot, uiDist, preloadPath, resourcesDir, userDataDir } from './paths.js';
import { createLogger, initFileLogging } from './log.js';

const log = createLogger('main');

/** Web content (tabs) lives in its own persistent session, isolated from the chrome. */
export const WEB_PARTITION = 'persist:bucks-web';

// Allow tests and power users to isolate a profile: BUCKS_USER_DATA=/path
if (process.env.BUCKS_USER_DATA) {
  app.setPath('userData', process.env.BUCKS_USER_DATA);
}

registerSchemePrivileges();

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

let mainWindow = null;
let kubo = null;
let tabs = null;

const getMainWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

app.whenReady().then(async () => {
  const userData = userDataDir();
  initFileLogging(userData);
  log.info(`Bucks Browser ${app.getVersion()} starting (electron ${process.versions.electron})`);

  const settings = createSettings({ userData, getMainWindow });
  const webSession = session.fromPartition(WEB_PARTITION);

  // IPFS runtime (embedded Kubo or external node). Starts in the background; never blocks the UI.
  kubo = createKubo({ settings, userData, resourcesDir: resourcesDir(), getMainWindow });
  registerIpfsIpc({ kubo, settings, getMainWindow });
  if (settings.get().ipfs.autoStart) {
    kubo.start().catch((e) => log.error('IPFS start failed:', e));
  }

  // Custom schemes: bucks:// serves the chrome, ipfs:// & ipns:// stream from the node.
  installBucksProtocol({ session: session.defaultSession, uiDist });
  installIpfsProtocols({ sessions: [session.defaultSession, webSession], kubo, settings });

  // Network security for web content: HTTPS-only, blocklists, permission gating.
  const security = installSecurity({ sessions: [webSession], settings, userData });

  ipcMain.handle('bucks:app:info', () => ({ name: app.getName(), version: app.getVersion(), userData }));

  mainWindow = createMainWindow({ preloadPath, settings, devUrl: process.env.BUCKS_DEV_URL || null });
  registerWindowIpc({ getMainWindow });

  tabs = createTabManager({ getMainWindow, webSession, settings, security });
  installAppMenu({ getMainWindow, tabs });
  installContextMenu({ tabs, getMainWindow });
  installDownloads({ session: webSession, settings, getMainWindow });
  registerShellIpc();

  registerUpdater({ root: appRoot, getMainWindow });
  createAgent({ settings, tabs, kubo });
  createWalletProxy({ settings });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow({ preloadPath, settings, devUrl: process.env.BUCKS_DEV_URL || null });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown || !kubo) return;
  shuttingDown = true;
  event.preventDefault();
  Promise.race([kubo.stop(), new Promise((r) => setTimeout(r, 4000))])
    .catch(() => {})
    .finally(() => app.quit());
});
