/**
 * Hosting bridge — publish a folder from Bucks over ipfs:// and ipns://.
 *
 * The implementation lives in ./hosting (ported from Bucks-browser, docs/HOSTING.md there) as an
 * ES-module island with its own package.json. This file is the CommonJS glue for main.js:
 *
 *   • It runs a pinned Kubo node, started at launch as in Bucks-browser unless ipfs.autoStart is
 *     false in <userData>/hosting/settings.json (then only when the user publishes or asks for
 *     node status). Your Helia node (ipfs-node.js) keeps its own repo and ports; linkLocalNode()
 *     peers Kubo with it, so a CID that either node has loads through the other (bitswap).
 *   • It registers bucks:sites:* and bucks:devices:* (pairing your other installs) IPC handlers,
 *     callable only from this app's own shell page.
 *   • serves()/handle() let the ipfs:// and ipns:// protocol handlers hand requests to the ported
 *     handler (per-CID origins, the local gateway, _redirects and SPA fallback, range requests,
 *     the public gateway only with consent).
 *
 * State lives in <userData>/hosting. Kubo's binary comes from `npm run fetch:kubo` in ./hosting
 * (dev) or extraResources "kubo" (packaged); without either, Kubo downloads it on first start.
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
let localNodeAddr = null; // loopback multiaddr of the in-process Helia node (linkLocalNode)

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
    const [{ createKubo }, { createDevices }, { createIpfsHandler }, { createSites }, { DEFAULT_SETTINGS, deepMerge }, { initFileLogging }] = await Promise.all([
      importHosting('src/main/ipfs/kubo.js'),
      importHosting('src/main/ipfs/devices.js'),
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
    let current = deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
    const listeners = new Set();
    const settingsFile = path.join(userData, 'settings.json');
    // get / set / onChange, persisted to <userData>/hosting/settings.json. Device pairings
    // (settings.ipfs.peers) and the device name are written through set().
    const settings = {
      get: () => structuredClone(current),
      set(patch) {
        current = deepMerge(current, patch);
        try { fs.writeFileSync(settingsFile, JSON.stringify(current, null, 2)); } catch (e) { console.error('[Hosting] settings not saved:', e.message); }
        const snap = structuredClone(current);
        for (const cb of listeners) { try { cb(snap); } catch (_) { /* a listener must not break set() */ } }
        return snap;
      },
      onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    };

    const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(HOSTING_DIR, 'resources');
    const kubo = createKubo({ settings, userData, resourcesDir, getMainWindow });
    const handler = createIpfsHandler({ kubo, settings });

    const ensureNode = async () => { if (!kubo.isReady()) await kubo.start(); };
    // Pairing with your other Bucks installs (bucks:devices:*). Quiet until the node is running.
    const devices = createDevices({ kubo, settings, userData, getMainWindow, isAllowedSender: isFileShell });
    const { service } = createSites({
      kubo, settings, userData, handler, devices, getMainWindow,
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

    state = { kubo, service, handler, settings, userData, devices };
    kubo.onStatus((s) => { if (s.state === 'ready') peerWithLocalNode(); });
    // Device pairing and ipfs:// through Kubo need the node running, so start it now like
    // Bucks-browser does, unless the user turned that off.
    if (settings.get().ipfs?.autoStart !== false) {
      kubo.start().catch((e) => console.error('[Hosting] IPFS node did not start:', e.message));
    }
    return state;
  })();
  try { return await initPromise; } finally { initPromise = null; }
}

/** The /ip4/127.0.0.1/tcp/… address of a libp2p node, from ipfs-node.js getNodeInfo(). */
function loopbackAddr(info) {
  if (!info || !info.peerId || !Array.isArray(info.addresses)) return null;
  const tcp = info.addresses.map(String).find((a) => /^\/ip4\/127\.0\.0\.1\/tcp\/\d+(\/p2p\/[^/]+)?$/.test(a));
  if (!tcp) return null;
  return tcp.includes('/p2p/') ? tcp : `${tcp}/p2p/${info.peerId}`;
}

/** Keep the embedded Kubo node connected to the in-process Helia node (Kubo Peering reconnects). */
function peerWithLocalNode() {
  if (!state || !localNodeAddr || !state.kubo.isReady() || state.settings.get().ipfs?.mode === 'external') return;
  state.kubo.rpc.swarmPeeringAdd(localNodeAddr)
    .then(() => console.log('[Hosting] Kubo peered with the local Helia node'))
    .catch((e) => console.warn('[Hosting] could not peer Kubo with the local Helia node:', e.message));
}

/** Called by main.js once Helia runs: content published to either node then loads from the other. */
function linkLocalNode(info) {
  const addr = loopbackAddr(info);
  if (!addr) return false;
  localNodeAddr = addr;
  peerWithLocalNode();
  return true;
}

/**
 * Should the ipfs:// or ipns:// handler pass this request to the ported Bucks-browser handler?
 * Every address while Kubo runs. While it does not, ipns:// still goes there (it offers to start
 * the node or, with consent, a public gateway: Helia cannot resolve names) and ipfs:// falls back
 * to the in-process Helia node.
 */
function serves(url) {
  if (!state) return false;
  const m = /^(ipfs|ipns):\/\//i.exec(String(url || ''));
  if (!m) return false;
  return state.kubo.isReady() || m[1].toLowerCase() === 'ipns';
}

/** Serve an ipfs:// or ipns:// request through the ported handler. */
function handle(request) {
  return state.handler(request);
}

async function shutdown() {
  if (!state) return;
  try { await state.kubo.stop(); } catch (_) { /* quitting */ }
}

module.exports = { init, serves, handle, linkLocalNode, loopbackAddr, shutdown, isFileShell, get state() { return state; } };
