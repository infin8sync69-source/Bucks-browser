// bucks:apps:* — Electron glue for the app environment (docs/IPC-CONTRACT.md, "Apps"). Builds the
// apps service, the bucks-app:// handler and the container, and registers the chrome's channels.
// Every channel checks that the sender is the chrome (bucks://app). The renderer never passes a
// path: folders come from this module's own dialog.

import { app as electronApp, dialog, ipcMain } from 'electron';
import { createAppsService } from './service.js';
import { createAppProtocolHandler } from './protocol.js';
import { createContainerManager } from './container.js';
import { isAllowedOrigin } from '../wallet/proxy.js';
import { createLogger } from '../log.js';
import { APP_ID } from './manifest.js';

const log = createLogger('apps');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (p) => {
  if (!isObj(p) || typeof p.id !== 'string' || !APP_ID.test(p.id)) throw new Error('id is required');
  return p.id;
};

/** Validate every bucks:apps:* payload. Exported for tests. */
export const validators = {
  inspect(p) {
    if (!isObj(p)) throw new Error('payload must be an object');
    const keys = ['address', 'folderToken', 'siteId'].filter((k) => p[k] !== undefined);
    if (keys.length !== 1) throw new Error('give exactly one of address, folderToken, siteId');
    const v = p[keys[0]];
    if (typeof v !== 'string' || !v || v.length > 2048) throw new Error(`${keys[0]} must be a non-empty string`);
    return { [keys[0]]: v };
  },
  install(p) {
    if (!isObj(p) || typeof p.token !== 'string' || p.token.length > 200) throw new Error('token is required');
    if (p.granted !== undefined && (!Array.isArray(p.granted) || p.granted.length > 64 || p.granted.some((g) => typeof g !== 'string' || g.length > 300))) throw new Error('granted must be a list of permission ids');
    return { token: p.token, ...(p.granted ? { granted: p.granted } : {}) };
  },
  byId: (p) => ({ id: id(p) }),
  update(p) { return { id: id(p), confirm: p.confirm === true }; },
  setPermission(p) {
    const appId = id(p);
    if (typeof p.permission !== 'string' || p.permission.length > 300) throw new Error('permission is required');
    if (typeof p.granted !== 'boolean') throw new Error('granted must be true or false');
    return { id: appId, permission: p.permission, granted: p.granted };
  },
};

/**
 * @param {{ kubo: any, settings: any, userData: string, sites: { service: any } | null,
 *   ipfsHandler: (req: Request) => Promise<Response>, getMainWindow: () => any,
 *   openInBrowser: (url: string) => void, nodeOrigins: () => string[], preloadPath: string }} deps
 * @returns {{ service: ReturnType<typeof createAppsService>, container: ReturnType<typeof createContainerManager>, chooseFolder: () => Promise<object|null> }}
 */
export function createApps({ kubo, settings, userData, sites, ipfsHandler, getMainWindow, openInBrowser, nodeOrigins, preloadPath }) {
  const send = (event) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('bucks:apps:event', event);
  };
  const service = createAppsService({
    kubo, settings, userData, log, emit: send,
    sites: sites ? { service: sites.service, store: sites.service.store } : null,
  });
  const protocolHandler = createAppProtocolHandler({ getApp: (appId) => service.record(appId), ipfsHandler, kubo, log });
  const container = createContainerManager({
    getRecord: (appId) => service.record(appId), protocolHandler, ipfsHandler, kubo, preloadPath, userData,
    openInBrowser, nodeOrigins, log, onChange: (appId) => send({ type: 'changed', id: appId }),
  });
  service.attachContainer(container);

  async function chooseFolder() {
    const win = getMainWindow();
    const r = await dialog.showOpenDialog(win, { title: 'Choose the app\'s folder (its built files)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths?.[0]) return null;
    return service.registerFolder(r.filePaths[0]);
  }

  const handle = (channel, fn) => {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, async (event, payload) => {
      if (!isAllowedOrigin(event?.senderFrame?.url, { packaged: Boolean(electronApp.isPackaged) })) throw new Error(`${channel} denied for this origin`);
      return fn(payload);
    });
  };
  handle('bucks:apps:choose-folder', () => chooseFolder());
  handle('bucks:apps:inspect', (p) => service.inspect(validators.inspect(p)));
  handle('bucks:apps:install', (p) => service.install(validators.install(p)));
  handle('bucks:apps:list', () => service.list());
  handle('bucks:apps:get', (p) => service.get(validators.byId(p)));
  handle('bucks:apps:icon', (p) => service.iconDataUrl(validators.byId(p)));
  handle('bucks:apps:launch', (p) => service.launch(validators.byId(p)));
  handle('bucks:apps:check-update', (p) => service.checkUpdate(validators.byId(p)));
  handle('bucks:apps:update', (p) => service.update(validators.update(p)));
  handle('bucks:apps:rollback', (p) => service.rollback(validators.byId(p)));
  handle('bucks:apps:set-permission', (p) => service.setPermission(validators.setPermission(p)));
  handle('bucks:apps:uninstall', (p) => service.uninstall(validators.byId(p)));
  handle('bucks:apps:publish', (p) => service.publish(validators.byId(p)));
  handle('bucks:apps:hosted-sites', () => (sites?.service?.store?.list?.() ?? []).map((s) => ({ id: s.id, name: s.name, ipns: s.ipns, cid: s.current?.cid ?? null })));

  return { service, container, chooseFolder };
}
