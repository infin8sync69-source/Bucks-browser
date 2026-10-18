// Unpacked Chrome extensions from <userData>/extensions/<name>/ (each with a manifest.json),
// loaded into the web-tab session at start-up. Never into the chrome's own session: an extension
// must not be able to script Bucks' interface. Electron supports part of the chrome.* API
// (content scripts, storage, basic tabs), enough for content blockers and userscript managers; it
// does not draw extension toolbar buttons or popups.
//
//   bucks:extensions:list         → ExtensionInfo[]
//   bucks:extensions:reload       → ExtensionInfo[]  (after adding or removing folders)
//   bucks:extensions:open-folder  opens the folder in the file manager

import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import { createLogger } from './log.js';

const log = createLogger('extensions');

/**
 * Sub-folders of `dir` that look like unpacked extensions (contain manifest.json), sorted.
 * @param {string} dir
 * @param {typeof fs} [fsImpl]
 * @returns {string[]} absolute paths
 */
export function scanExtensionDirs(dir, fsImpl = fs) {
  let entries = [];
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .filter((p) => fsImpl.existsSync(path.join(p, 'manifest.json')))
    .sort();
}

/**
 * @param {{ session: import('electron').Session, userData: string }} deps
 */
export function installExtensions({ session, userData }) {
  const dir = path.join(userData, 'extensions');
  /** @type {Array<{ id: string|null, name: string, version: string, path: string, error: string|null }>} */
  let loaded = [];
  const api = session.extensions ?? session; // Electron ≥ 36 moved the API to session.extensions

  async function loadAll() {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      log.warn(`Cannot create ${dir}: ${e.message}`);
    }
    for (const ext of api.getAllExtensions?.() ?? []) {
      try { api.removeExtension(ext.id); } catch { /* already gone */ }
    }
    const out = [];
    for (const p of scanExtensionDirs(dir)) {
      try {
        const ext = await api.loadExtension(p, { allowFileAccess: false });
        out.push({ id: ext.id, name: ext.name, version: ext.version, path: p, error: null });
        log.info(`Loaded extension ${ext.name} ${ext.version} (${ext.id})`);
      } catch (e) {
        out.push({ id: null, name: path.basename(p), version: '', path: p, error: e.message });
        log.warn(`Could not load extension ${p}: ${e.message}`);
      }
    }
    loaded = out;
    return list();
  }

  const list = () => loaded.map((e) => ({ ...e }));

  ipcMain.removeHandler?.('bucks:extensions:list');
  ipcMain.handle('bucks:extensions:list', () => ({ folder: dir, extensions: list() }));
  ipcMain.removeHandler?.('bucks:extensions:reload');
  ipcMain.handle('bucks:extensions:reload', async () => ({ folder: dir, extensions: await loadAll() }));
  ipcMain.removeHandler?.('bucks:extensions:open-folder');
  ipcMain.handle('bucks:extensions:open-folder', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });

  return { folder: dir, loadAll, list };
}
