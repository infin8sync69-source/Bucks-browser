// Downloads: session 'will-download' → tracked DownloadItem records → bucks:downloads:* IPC
// and 'bucks:downloads:event' pushes to the chrome (start / throttled progress / done).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, ipcMain, shell } from 'electron';
import { createLogger } from './log.js';

const log = createLogger('downloads');

/** Most records kept in memory; finished ones are evicted oldest-first beyond this. */
export const MAX_DOWNLOAD_ITEMS = 200;
/** Minimum interval between two 'progressing' events for the same item (~4/s). */
export const PROGRESS_THROTTLE_MS = 250;

/**
 * Make a file name safe for every supported OS: strips path separators, control characters,
 * reserved characters and leading dots; caps the length.
 * @param {unknown} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  let out = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!out) out = 'download';
  if (out.length > 200) {
    const ext = path.extname(out).slice(0, 20);
    out = out.slice(0, 200 - ext.length) + ext;
  }
  return out;
}

/**
 * "report.pdf" → "report (1).pdf" → "report (2).pdf" … until the name is free in `dir`.
 * @param {string} dir
 * @param {string} name
 * @param {(fullPath: string) => boolean} [exists] injectable for tests (defaults to fs.existsSync)
 * @returns {string} a file name (not a path)
 */
export function uniqueFilename(dir, name, exists = (p) => fs.existsSync(p)) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 1; exists(path.join(dir, candidate)) && i < 10000; i++) {
    candidate = `${base} (${i})${ext}`;
  }
  return candidate;
}

/**
 * Install download handling on one or more sessions (the web session and the private one) and
 * register the bucks:downloads:* channels once.
 * @param {{ session?: import('electron').Session, sessions?: import('electron').Session[], settings: { get(): any }, getMainWindow: () => import('electron').BrowserWindow | null }} opts
 */
export function installDownloads({ session, sessions, settings, getMainWindow }) {
  const targets = (sessions && sessions.length ? sessions : [session]).filter(Boolean);
  if (!targets.length || !targets.every((ses) => typeof ses.on === 'function')) throw new Error('installDownloads: a session is required');

  /** @type {Map<string, { record: object, item: import('electron').DownloadItem | null, lastEmit: number }>} */
  const entries = new Map();

  function emit(record) {
    const win = getMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('bucks:downloads:event', { ...record });
    }
  }

  function downloadDirectory() {
    const configured = settings?.get?.()?.downloads?.directory;
    const dir = typeof configured === 'string' && configured.trim() ? configured.trim() : app.getPath('downloads');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      log.warn(`Cannot create download directory ${dir}: ${e.message}`);
    }
    return dir;
  }

  function evictIfNeeded() {
    if (entries.size < MAX_DOWNLOAD_ITEMS) return;
    const finished = [...entries.values()]
      .filter((e) => e.record.state !== 'progressing')
      .sort((a, b) => a.record.startedAt - b.record.startedAt);
    for (const e of finished) {
      if (entries.size < MAX_DOWNLOAD_ITEMS) break;
      entries.delete(e.record.id);
    }
  }

  function syncFromItem(entry) {
    const { item, record } = entry;
    if (!item) return;
    const savePath = item.getSavePath();
    if (savePath) {
      record.path = savePath;
      record.filename = path.basename(savePath);
    }
    record.receivedBytes = item.getReceivedBytes();
    record.totalBytes = item.getTotalBytes();
    record.mime = item.getMimeType() || record.mime;
  }

  const onWillDownload = (_event, item) => {
    const askWhereToSave = settings?.get?.()?.downloads?.askWhereToSave === true;
    const dir = downloadDirectory();
    const filename = uniqueFilename(dir, sanitizeFilename(item.getFilename()));
    const target = path.join(dir, filename);

    if (askWhereToSave) {
      // Chromium shows the native save dialog itself; cancelling it cancels the download.
      item.setSaveDialogOptions({ defaultPath: target, title: 'Save file' });
    } else {
      item.setSavePath(target);
    }

    const record = {
      id: crypto.randomUUID(),
      url: item.getURL(),
      filename,
      path: target,
      mime: item.getMimeType() || 'application/octet-stream',
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
    };
    const entry = { record, item, lastEmit: 0 };
    evictIfNeeded();
    entries.set(record.id, entry);
    log.info(`download started: ${record.url} → ${target}`);
    entry.lastEmit = Date.now();
    emit(record);

    item.on('updated', (_e, state) => {
      syncFromItem(entry);
      record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      const now = Date.now();
      if (state === 'interrupted' || now - entry.lastEmit >= PROGRESS_THROTTLE_MS) {
        entry.lastEmit = now;
        emit(record);
      }
    });

    item.once('done', (_e, state) => {
      syncFromItem(entry);
      record.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
      entry.item = null;
      log.info(`download ${record.state}: ${record.path}`);
      emit(record);
    });
  };
  for (const ses of targets) ses.on('will-download', onWillDownload);

  function requireEntry(payload) {
    const id = payload?.id;
    if (typeof id !== 'string' || !id) throw new Error('A download id is required');
    const entry = entries.get(id);
    if (!entry) throw new Error('Unknown download');
    return entry;
  }

  const api = {
    /** @returns {object[]} newest first */
    list: () => [...entries.values()].map((e) => ({ ...e.record })).sort((a, b) => b.startedAt - a.startedAt),
    async open(id) {
      const { record } = requireEntry({ id });
      if (record.state !== 'completed') throw new Error('This download has not finished');
      if (!fs.existsSync(record.path)) throw new Error('The file no longer exists on disk');
      const err = await shell.openPath(record.path);
      if (err) throw new Error(`Could not open file: ${err}`);
    },
    showInFolder(id) {
      const { record } = requireEntry({ id });
      if (!fs.existsSync(record.path)) throw new Error('The file no longer exists on disk');
      shell.showItemInFolder(record.path);
    },
    cancel(id) {
      const entry = requireEntry({ id });
      if (!entry.item || entry.record.state !== 'progressing') throw new Error('This download is not in progress');
      entry.item.cancel();
    },
    /** Removes finished / cancelled / interrupted records; in-progress ones stay. */
    clear() {
      for (const [id, e] of entries) if (e.record.state !== 'progressing') entries.delete(id);
    },
  };

  ipcMain.handle('bucks:downloads:list', () => api.list());
  ipcMain.handle('bucks:downloads:open', (_e, p) => api.open(p?.id));
  ipcMain.handle('bucks:downloads:show-in-folder', (_e, p) => api.showInFolder(p?.id));
  ipcMain.handle('bucks:downloads:cancel', (_e, p) => api.cancel(p?.id));
  ipcMain.handle('bucks:downloads:clear', () => api.clear());

  return api;
}
