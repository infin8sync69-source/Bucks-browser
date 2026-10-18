// Bucks Browser — main process entry point.
// Wiring only: every subsystem lives in its own module and registers its own IPC
// handlers (see docs/IPC-CONTRACT.md for the full channel list and module interfaces).

import { app, BrowserWindow, ipcMain, net, nativeImage, session } from 'electron';
import path from 'node:path';
import { registerSchemePrivileges } from './protocols/index.js';
import { installBucksProtocol } from './protocols/bucks.js';
import { installIpfsProtocols } from './protocols/ipfs.js';
import { createSettings } from './settings.js';
import { createKubo } from './ipfs/kubo.js';
import { registerIpfsIpc } from './ipfs/ipc.js';
import { createDevices } from './ipfs/devices.js';
import { createMainWindow, registerWindowIpc } from './window.js';
import { createTabManager } from './tabs.js';
import { installAppMenu } from './menu.js';
import { installContextMenu } from './context-menu.js';
import { installDownloads } from './downloads.js';
import { registerShellIpc } from './shell.js';
import { installSecurity } from './security/index.js';
import { createAgent } from './agent/bridge.js';
import { createSoulEngine, settingsAction } from './agent/soul-engine.js';
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
let soul = null;

const getMainWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

app.whenReady().then(async () => {
  const userData = userDataDir();
  // Running from source on macOS shows Electron's dock icon; use ours instead.
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    const icon = nativeImage.createFromPath(path.join(appRoot, 'build', 'icons', 'icon.png'));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
  initFileLogging(userData);
  log.info(`Bucks Browser ${app.getVersion()} starting (electron ${process.versions.electron})`);

  const settings = createSettings({ userData, getMainWindow });
  const webSession = session.fromPartition(WEB_PARTITION);

  // IPFS runtime (embedded Kubo or external node). Starts in the background; never blocks the UI.
  // net.fetch goes through Chromium's network stack, so it honours the OS proxy settings
  // (Node's global fetch does not). Used for the one-off Kubo download.
  const fetchImpl = (url, init) => net.fetch(url, init);
  kubo = createKubo({ settings, userData, resourcesDir: resourcesDir(), getMainWindow, fetchImpl });
  registerIpfsIpc({ kubo, settings, getMainWindow });
  // Device pairing and file sharing between Bucks installs over Kubo peering + pubsub.
  createDevices({ kubo, settings, userData, getMainWindow });
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
  // Soul Engine: the Python agent in agent/, run as a token-protected loopback sidecar while it is
  // the selected agent provider.
  soul = createSoulEngine({ settings, userData, appRoot, resourcesDir: app.isPackaged ? resourcesDir() : null, getMainWindow });
  createAgent({ settings, tabs, kubo, soul });
  {
    const s = settings.get();
    // Same rule as a settings change from "nothing selected" (validates a hand-edited settings.json).
    if (settingsAction({}, s, false) === 'start') soul.start().catch((e) => log.error('Soul Engine start failed:', e));
    let previous = s;
    settings.onChange((next) => {
      const action = settingsAction(previous, next, soul.isRunning());
      previous = next;
      if (action) soul[action]().catch((e) => log.error(`Soul Engine ${action} failed:`, e));
    });
  }
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
  if (shuttingDown || (!kubo && !soul)) return;
  shuttingDown = true;
  event.preventDefault();
  const stops = [kubo?.stop(), soul?.stop()].filter(Boolean);
  Promise.race([Promise.allSettled(stops), new Promise((r) => setTimeout(r, 4000))])
    .catch(() => {})
    .finally(() => app.quit());
});
