import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { createLogger } from './log.js';
import { DEFAULT_SETTINGS, deepMerge } from './settings-defaults.js';

export { DEFAULT_SETTINGS, deepMerge };

const log = createLogger('settings');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * JSON-file backed settings store with IPC bindings.
 * @param {{ userData: string, getMainWindow?: () => import('electron').BrowserWindow | null }} opts
 */
export function createSettings({ userData, getMainWindow = () => null }) {
  const file = path.join(userData, 'settings.json');
  let current = structuredClone(DEFAULT_SETTINGS);
  const listeners = new Set();

  try {
    if (fs.existsSync(file)) {
      current = deepMerge(current, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  } catch (e) {
    log.warn('Could not read settings file, using defaults:', e.message);
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(current, null, 2));
    } catch (e) {
      log.error('Failed to persist settings:', e.message);
    }
  }

  const settings = {
    get: () => structuredClone(current),
    /** Deep-merge a partial patch, persist, notify. Returns the new settings. */
    set(patch) {
      current = deepMerge(current, patch);
      persist();
      const snapshot = settings.get();
      for (const cb of listeners) {
        try { cb(snapshot); } catch (e) { log.error('settings listener failed:', e); }
      }
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('bucks:settings:changed', snapshot);
      return snapshot;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    file,
  };

  ipcMain.handle('bucks:settings:get', () => settings.get());
  ipcMain.handle('bucks:settings:set', (_e, patch) => settings.set(isPlainObject(patch) ? patch : {}));

  return settings;
}
