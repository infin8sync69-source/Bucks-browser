// Ported from Bucks-browser (src/main/ipfs/devices.js); handlers can be limited to the app's own
// shell page with `isAllowedSender`.
// bucks:devices:* — Electron glue for device pairing over IPFS peering + pubsub
// (docs/IPC-CONTRACT.md, "Devices"). The behaviour lives in devices-service.js (no Electron) and
// devices-core.js (pure); this module only supplies app facts, the renderer event and IPC handlers.

import os from 'node:os';
import { app, ipcMain } from 'electron';
import { createDevicesService } from './devices-service.js';
import { createLogger } from '../log.js';

const MAX_INPUT_LENGTH = 512;
const MAX_FILE_NAME_LENGTH = 255;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function requireObject(payload, channel) {
  if (!isPlainObject(payload)) throw new Error(`${channel} expects an object payload`);
  return payload;
}

function requireString(value, name, { max = MAX_INPUT_LENGTH, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new Error(`${name} is required`);
  }
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (value.length > max) throw new Error(`${name} is too long (max ${max} characters)`);
  return value;
}

/** Validate the bucks:devices:pair payload `{ peerId, name?, addrs? }`. */
export function validatePairPayload(payload) {
  const p = requireObject(payload, 'bucks:devices:pair');
  const peerId = requireString(p.peerId, 'peerId');
  const name = requireString(p.name, 'name', { max: 256, optional: true });
  let addrs;
  if (p.addrs !== undefined && p.addrs !== null) {
    if (!Array.isArray(p.addrs)) throw new Error('addrs must be an array of multiaddr strings');
    if (p.addrs.length > 64) throw new Error('Too many addrs (max 64)');
    addrs = p.addrs.map((a, i) => requireString(a, `addrs[${i}]`));
  }
  return { peerId, name, addrs };
}

/** Validate the bucks:devices:share payload `{ cid, name?, size? }`. */
export function validateSharePayload(payload) {
  const p = requireObject(payload, 'bucks:devices:share');
  const cid = requireString(p.cid, 'cid', { max: 200 });
  const name = requireString(p.name, 'name', { max: MAX_FILE_NAME_LENGTH, optional: true });
  let size = null;
  if (p.size !== undefined && p.size !== null) {
    if (!Number.isSafeInteger(p.size) || p.size < 0) throw new Error('size must be a non-negative integer');
    size = p.size;
  }
  return { cid, name, size };
}

/**
 * Create the devices feature and register its IPC handlers:
 * bucks:devices:status | pair | unpair | rename | share | dismiss, and the
 * bucks:devices:updated event to the chrome window.
 * @param {{ kubo: object, settings: object, userData: string, getMainWindow: () => import('electron').BrowserWindow|null, isAllowedSender?: (url: string) => boolean }} opts
 * @returns {ReturnType<typeof createDevicesService>}
 */
export function createDevices({ kubo, settings, userData, getMainWindow, isAllowedSender = () => true }) {
  const log = createLogger('devices');
  // Only the app's own shell page may call these (web content never can).
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, payload) => {
      if (!isAllowedSender(event?.senderFrame?.url)) throw new Error(`${channel} denied for this origin`);
      return fn(payload);
    });
  };
  const service = createDevicesService({
    kubo,
    settings,
    userData,
    appVersion: app.getVersion(),
    platform: process.platform,
    // macOS host names usually end in the mDNS suffix (Johns-MacBook-Air.local); drop it.
    hostname: os.hostname().replace(/\.local$/i, ''),
    log,
    emit: (status) => {
      const win = getMainWindow?.();
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send('bucks:devices:updated', status);
    },
  });

  handle('bucks:devices:status', () => service.status());
  handle('bucks:devices:pair', (payload) => service.pair(validatePairPayload(payload)));
  handle('bucks:devices:unpair', (payload) => {
    const p = requireObject(payload, 'bucks:devices:unpair');
    return service.unpair(requireString(p.peerId, 'peerId'));
  });
  handle('bucks:devices:rename', (payload) => {
    const p = requireObject(payload, 'bucks:devices:rename');
    return service.rename(requireString(p.name ?? '', 'name', { max: 256 }));
  });
  handle('bucks:devices:share', (payload) => service.share(validateSharePayload(payload)));
  handle('bucks:devices:dismiss', (payload) => {
    const p = requireObject(payload, 'bucks:devices:dismiss');
    return service.dismiss({ cid: requireString(p.cid, 'cid', { max: 200 }), from: requireString(p.from, 'from', { max: 200 }) });
  });

  app.on('before-quit', () => {
    service.stop().catch((e) => log.warn(`devices stop failed: ${e.message}`));
  });

  return service;
}
