import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { createLogger } from './log.js';

const log = createLogger('settings');

export const DEFAULT_SETTINGS = Object.freeze({
  searchEngine: 'duckduckgo', // duckduckgo | google | brave | bing
  homepage: 'bucks://newtab',
  ipfs: {
    mode: 'embedded', // embedded | external
    externalApiUrl: '', // e.g. http://127.0.0.1:5001 when mode === 'external'
    publicGateway: 'https://ipfs.io', // fallback when the local node is not ready
    preferredGateway: 'local', // local | public
    autoStart: true,
    // Paired Bucks devices: [{ peerId, name, addrs: ['/ip4/…/tcp/…'] }]. Kept connected via Kubo Peering.
    peers: [],
  },
  devices: {
    name: '', // '' → the computer's host name
    autoPin: false, // pin files shared by paired devices automatically
  },
  security: {
    httpsOnly: true,
    adBlock: true,
    trackerBlock: true,
    blockThirdPartyCookies: true,
  },
  wallet: {
    nodeUrl: 'http://127.0.0.1:8080',
  },
  agent: {
    provider: 'offline', // offline | remote | ollama
    remoteUrl: 'http://localhost:3000',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.2',
  },
  downloads: {
    directory: '', // '' → OS default downloads dir
    askWhereToSave: false,
  },
  ui: {
    theme: 'dark',
  },
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(base?.[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
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
