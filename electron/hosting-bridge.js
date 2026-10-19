/**
 * Hosting bridge — publish a folder from Bucks over ipfs:// and ipns://.
 *
 * The implementation lives in ./hosting (ported from Bucks-browser, docs/HOSTING.md there) as an
 * ES-module island with its own package.json. This file is the CommonJS glue for main.js:
 *
 *   • It runs a pinned Kubo node, started only when the user publishes (or asks for node status).
 *     Your Helia node (ipfs-node.js) is untouched; the two never share a repo or a port.
 *   • It registers bucks:sites:* IPC handlers, callable only from this app's own shell page.
 *   • serves()/handle() let the ipfs:// and ipns:// protocol handlers hand requests for sites
 *     hosted by this browser to the ported handler (SPA fallback, headers, redirects, badges).
 *
 * State lives in <userData>/hosting. Kubo's binary comes from `npm run fetch:kubo` in ./hosting
 * (dev) or extraResources "kubo" (packaged).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const HOSTING_DIR = path.join(__dirname, 'hosting');
const importHosting = (rel) => import(pathToFileURL(path.join(HOSTING_DIR, rel)).href);

// Channels whose service call needs a running Kubo node.
const NEEDS_NODE = new Set([
  'bucks:sites:preview', 'bucks:sites:publish', 'bucks:sites:update', 'bucks:sites:status',
  'bucks:sites:rollback', 'bucks:sites:unpublish', 'bucks:sites:export-car', 'bucks:sites:restore-key',
]);

let state = null; // { kubo, service, handler, settings, userData }
let initPromise = null;

const isFileShell = (url) => {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && u.pathname === pathToFileURL(path.join(__dirname, 'index.html')).pathname;
  } catch (_) { return false; }
};

async function init({ app, ipcMain, getMainWindow }) {
  if (state) return state;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const [{ createKubo }, { createIpfsHandler }, { createSites }, { DEFAULT_SETTINGS, deepMerge }, { initFileLogging }] = await Promise.all([
      importHosting('src/main/ipfs/kubo.js'),
      importHosting('src/main/protocols/ipfs.js'),
      importHosting('src/main/sites/ipc.js'),
      importHosting('src/main/settings-defaults.js'),
      importHosting('src/main/log.js'),
    ]);

    const userData = path.join(app.getPath('userData'), 'hosting');
    fs.mkdirSync(userData, { recursive: true });
    try { initFileLogging(userData); } catch (_) { /* logging is best effort */ }

    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')); } catch (_) { /* defaults */ }
    const current = deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
    const settings = { get: () => structuredClone(current), onChange: () => () => {} };

    const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(HOSTING_DIR, 'resources');
    const kubo = createKubo({ settings, userData, resourcesDir, getMainWindow });
    const handler = createIpfsHandler({ kubo, settings });

    const ensureNode = async () => { if (!kubo.isReady()) await kubo.start(); };
    const { service } = createSites({
      kubo, settings, userData, handler, devices: null, getMainWindow,
      isAllowedSender: isFileShell,
      beforeCall: async (channel) => { if (NEEDS_NODE.has(channel)) await ensureNode(); },
    });

    ipcMain.removeHandler('bucks:sites:node-status');
    ipcMain.handle('bucks:sites:node-status', (event) => {
      if (!isFileShell(event?.senderFrame?.url)) throw new Error('bucks:sites:node-status denied for this origin');
      return kubo.status();
    });
    ipcMain.removeHandler('bucks:sites:node-start');
    ipcMain.handle('bucks:sites:node-start', async (event) => {
      if (!isFileShell(event?.senderFrame?.url)) throw new Error('bucks:sites:node-start denied for this origin');
      await ensureNode();
      return kubo.status();
    });

    state = { kubo, service, handler, settings, userData };
    return state;
  })();
  try { return await initPromise; } finally { initPromise = null; }
}

/** Does this ipfs:// or ipns:// URL belong to a site this browser hosts (and is the node up)? */
function serves(url) {
  if (!state || !state.kubo.isReady()) return false;
  const m = /^(ipfs|ipns):\/\/([^/?#]+)/i.exec(String(url || ''));
  if (!m) return false;
  const [, scheme, host] = m;
  const want = host.toLowerCase();
  let sites;
  try { sites = state.service.list(); } catch (_) { return false; }
  return sites.some((s) => (scheme.toLowerCase() === 'ipns'
    ? (s.ipns || '').toLowerCase() === want
    : [s.current, ...s.history].some((v) => v && String(v.cid).toLowerCase() === want)));
}

/** Serve a request for a hosted site through the ported handler. */
function handle(request) {
  return state.handler(request);
}

async function shutdown() {
  if (!state) return;
  try { await state.kubo.stop(); } catch (_) { /* quitting */ }
}

module.exports = { init, serves, handle, shutdown, isFileShell, get state() { return state; } };
