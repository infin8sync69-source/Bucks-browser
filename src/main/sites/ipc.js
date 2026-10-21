// bucks:sites:* — Electron glue for hosting sites (docs/IPC-CONTRACT.md, "Sites"). Every channel
// checks that the sender is the chrome (bucks://app), as the wallet proxy does. The renderer never
// passes a file system path: folders, key backups and CAR files come from this module's own
// dialogs. Pinning-service tokens are sealed with the OS keychain (safeStorage).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, ipcMain, safeStorage } from 'electron';
import { createSitesService } from './service.js';
import { createPinningServices } from './pinning.js';
import { isAllowedOrigin } from '../wallet/proxy.js';
import { createLogger } from '../log.js';

const MAX_TEXT = 512;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const str = (v, name, { max = MAX_TEXT, optional = false } = {}) => {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new Error(`${name} is required`);
  }
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  if (v.length > max) throw new Error(`${name} is too long`);
  return v;
};

/** The one-click fixes and exclusions a payload may carry (validated again by the service). */
function fixes(p) {
  return {
    ...(Array.isArray(p.exclude) ? { exclude: p.exclude.slice(0, 500).map((e, i) => str(e, `exclude[${i}]`, { max: 1024 })) } : {}),
    useShellAsIndex: p.useShellAsIndex === true,
    enableSpa: p.enableSpa === true,
  };
}

/** Validate every bucks:sites:* payload. Exported for tests. */
export const validators = {
  inspect: (p) => ({ token: str(p.token, 'token', { max: 64 }), ...fixes(p) }),
  preview: (p) => ({ token: str(p.token, 'token', { max: 64 }), ...fixes(p) }),
  publish: (p) => ({
    token: str(p.token, 'token', { max: 64 }),
    name: str(p.name, 'name', { max: 200, optional: true }),
    ipns: p.ipns !== false,
    hosting: isPlainObject(p.hosting) ? p.hosting : {},
    ...fixes(p),
  }),
  update: (p) => ({
    id: str(p.id, 'id', { max: 64 }),
    token: str(p.token, 'token', { max: 64, optional: true }),
    confirm: p.confirm === true,
    expectCid: str(p.expectCid, 'expectCid', { max: 200, optional: true }) ?? null,
    ...fixes(p),
  }),
  id: (p) => ({ id: str(p.id, 'id', { max: 64 }) }),
  rollback: (p) => ({ id: str(p.id, 'id', { max: 64 }), cid: str(p.cid, 'cid', { max: 200 }) }),
  unpublish: (p) => ({ id: str(p.id, 'id', { max: 64 }), mode: str(p.mode, 'mode', { max: 20 }), confirm: str(p.confirm, 'confirm', { max: 200, optional: true }) }),
  passphrase: (p) => ({ id: str(p.id, 'id', { max: 64, optional: true }) ?? null, passphrase: str(p.passphrase, 'passphrase', { max: 1024 }), withCar: p.withCar === true }),
  pinningService: (p) => ({ name: str(p.name, 'name', { max: 40 }), endpoint: str(p.endpoint, 'endpoint', { max: 2048 }), token: str(p.token, 'token', { max: 8192 }) }),
};

const safeFileName = (name, ext) => `${String(name || 'site').replace(/[^\w .-]+/g, '_').trim().slice(0, 80) || 'site'}${ext}`;

/**
 * Create the sites service and register its channels.
 * @param {{ kubo: object, settings: object, userData: string, handler: Function, devices?: object|null,
 *           getMainWindow: () => import('electron').BrowserWindow|null }} deps
 * @returns {{ service: ReturnType<typeof createSitesService>, chooseFolder: () => Promise<object|null> }}
 */
export function createSites({ kubo, settings, userData, handler, devices = null, getMainWindow }) {
  const log = createLogger('sites');
  const send = (channel, payload) => {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  };
  const pinning = createPinningServices({
    dir: path.join(userData, 'sites'),
    seal: (text) => safeStorage.encryptString(text),
    unseal: (sealed) => safeStorage.decryptString(sealed),
    canSeal: () => safeStorage.isEncryptionAvailable(),
  });
  const service = createSitesService({ kubo, settings, userData, handler, devices, pinning, log, emit: (p) => send('bucks:sites:progress', p) });

  const parent = () => getMainWindow?.() || undefined;

  /** The native folder dialog; the folder becomes a token the renderer can use. */
  async function chooseFolder() {
    const r = await dialog.showOpenDialog(parent(), { title: 'Choose the folder of your built site (or its project)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths?.[0]) return null;
    return service.registerFolder(r.filePaths[0]);
  }

  async function saveTo(title, defaultName, filters) {
    const r = await dialog.showSaveDialog(parent(), { title, defaultPath: path.join(app.getPath('documents'), defaultName), filters });
    return r.canceled || !r.filePath ? null : r.filePath;
  }

  async function openFile(title, filters) {
    const r = await dialog.showOpenDialog(parent(), { title, properties: ['openFile'], filters });
    return r.canceled || !r.filePaths?.[0] ? null : r.filePaths[0];
  }

  const handle = (channel, fn) => {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, async (event, payload) => {
      if (!isAllowedOrigin(event?.senderFrame?.url, { packaged: Boolean(app.isPackaged) })) throw new Error(`${channel} denied for this origin`);
      try {
        return await fn(isPlainObject(payload) ? payload : {});
      } catch (e) {
        const msg = e?.message || String(e);
        log.warn(`${channel} failed: ${msg}`);
        throw new Error(msg);
      }
    });
  };

  handle('bucks:sites:choose-folder', () => chooseFolder());
  handle('bucks:sites:inspect', (p) => service.inspect(validators.inspect(p)));
  handle('bucks:sites:preview', (p) => service.preview(validators.preview(p)));
  handle('bucks:sites:publish', (p) => service.publish(validators.publish(p)));
  handle('bucks:sites:update', (p) => service.update(validators.update(p)));
  handle('bucks:sites:list', () => service.list());
  handle('bucks:sites:status', (p) => service.status(validators.id(p)));
  handle('bucks:sites:rollback', (p) => service.rollback(validators.rollback(p)));
  handle('bucks:sites:unpublish', (p) => service.unpublish(validators.unpublish(p)));
  handle('bucks:sites:backup-key', async (p) => {
    const { id, passphrase } = validators.passphrase(p);
    const site = service.store.get(id);
    if (!site) throw new Error('No such site.');
    const file = await saveTo('Save the key backup of your site', safeFileName(site.name, '.bucks-key'), [{ name: 'Bucks site key', extensions: ['bucks-key'] }]);
    if (!file) return { ok: false };
    return { ...(await service.backupKey({ id, passphrase, file })), path: file };
  });
  handle('bucks:sites:restore-key', async (p) => {
    const { id, passphrase, withCar } = validators.passphrase(p);
    const keyFile = await openFile('Choose the key backup of your site', [{ name: 'Bucks site key', extensions: ['bucks-key'] }]);
    if (!keyFile) return { ok: false };
    const carFile = withCar ? await openFile('Choose the CAR file of your site', [{ name: 'CAR file', extensions: ['car'] }]) : null;
    if (withCar && !carFile) return { ok: false };
    return service.restoreKey({ id, passphrase, fileBytes: await fsp.readFile(keyFile), carFile });
  });
  handle('bucks:sites:export-car', async (p) => {
    const { id } = validators.id(p);
    const site = service.store.get(id);
    if (!site) throw new Error('No such site.');
    const file = await saveTo('Export your site as a CAR file', safeFileName(site.name, '.car'), [{ name: 'CAR file', extensions: ['car'] }]);
    if (!file) return { path: null };
    return service.exportCar({ id, file });
  });
  handle('bucks:sites:pinning-services', () => pinning.list());
  handle('bucks:sites:add-pinning-service', (p) => pinning.add(validators.pinningService(p)));
  handle('bucks:sites:remove-pinning-service', (p) => pinning.remove(str(p.name, 'name', { max: 40 })));

  return { service, chooseFolder };
}
