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
 *   • It registers bucks:ipfs:* (the IPFS node panel), bucks:sites:*, bucks:devices:* (pairing
 *     your other installs) and bucks:apps:* (apps installed from IPFS, each in its own container)
 *     IPC handlers, callable only from this app's own shell page, and runs the agent's site_* and
 *     app_* tools with a native approval dialog.
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
    const [{ createKubo }, { registerIpfsIpc }, { createDevices }, { createIpfsHandler }, { createSites }, { createSiteTools, SITE_TOOLS }, { createApps }, { createAppTools, APP_TOOLS }, { DEFAULT_SETTINGS, deepMerge }, { initFileLogging }] = await Promise.all([
      importHosting('src/main/ipfs/kubo.js'),
      importHosting('src/main/ipfs/ipc.js'),
      importHosting('src/main/ipfs/devices.js'),
      importHosting('src/main/protocols/ipfs.js'),
      importHosting('src/main/sites/ipc.js'),
      importHosting('src/main/sites/agent-tools.js'),
      importHosting('src/main/apps/ipc.js'),
      importHosting('src/main/apps/agent-tools.js'),
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
    // bucks:ipfs:* for the IPFS node panel (ipfs-panel.js): status, start/stop/restart, add, browse,
    // pins, peers, storage and the node's settings.
    registerIpfsIpc({ kubo, settings, getMainWindow, isAllowedSender: isFileShell });
    // Pairing with your other Bucks installs (bucks:devices:*). Quiet until the node is running.
    const devices = createDevices({ kubo, settings, userData, getMainWindow, isAllowedSender: isFileShell });
    const sites = createSites({
      kubo, settings, userData, handler, devices, getMainWindow,
      isAllowedSender: isFileShell,
      beforeCall: async (channel) => { if (NEEDS_NODE.has(channel)) await ensureNode(); },
    });
    const { service, chooseFolder } = sites;

    // Installed apps (bucks:apps:*, apps-panel.js), each in its own container: a bucks-app://<id>
    // origin, its own session and window. Their files and ipfs:// requests come from the local
    // node only, never a public gateway. Links to the web open in a Bucks tab.
    const localOnlySettings = { get: () => { const s = settings.get(); return { ...s, ipfs: { ...(s.ipfs || {}), preferredGateway: 'local' } }; } };
    const apps = createApps({
      kubo, settings, userData, sites, getMainWindow,
      preloadPath: path.join(HOSTING_DIR, 'src', 'preload', 'app-preload.cjs'),
      ipfsHandler: createIpfsHandler({ kubo, settings: localOnlySettings }),
      openInBrowser: (url) => {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send('new-window', { url });
        win.focus();
      },
      nodeOrigins: () => [kubo.status().api_url, kubo.status().gateway_url].filter(Boolean),
      isAllowedSender: isFileShell,
      sessionDataPath: app.getPath('userData'),
    });
    const appTools = createAppTools({ apps });
    ipcMain.removeHandler('bucks:apps:agent-tool');
    ipcMain.handle('bucks:apps:agent-tool', async (event, payload) => {
      if (!isFileShell(event?.senderFrame?.url)) throw new Error('bucks:apps:agent-tool denied for this origin');
      const name = String(payload?.name || '');
      if (!APP_TOOLS.has(name)) return `Unknown app tool: ${name}`;
      if (name !== 'app_list') {
        try { await ensureNode(); } catch (e) { return `The IPFS node could not start: ${e.message}`; }
      }
      return appTools.execute(name, payload?.args, { requestApproval: (card, opts) => askApproval(getMainWindow(), card, opts) });
    });

    // The Soul Engine's hosting tools (site_*), forwarded by the renderer from the agent
    // (agent-browser-control.js). The engine only proposes: publishing and updating wait for the
    // user's answer to a native dialog whose text Bucks builds from its own inspection.
    const siteTools = createSiteTools({ sites: { service, chooseFolder } });
    ipcMain.removeHandler('bucks:sites:agent-tool');
    ipcMain.handle('bucks:sites:agent-tool', async (event, payload) => {
      if (!isFileShell(event?.senderFrame?.url)) throw new Error('bucks:sites:agent-tool denied for this origin');
      const name = String(payload?.name || '');
      if (!SITE_TOOLS.has(name)) return `Unknown site tool: ${name}`;
      if (name !== 'site_inspect') {
        try { await ensureNode(); } catch (e) { return `The IPFS node could not start: ${e.message}`; }
      }
      return siteTools.execute(name, payload?.args, { requestApproval: (card, opts) => askApproval(getMainWindow(), card, opts) });
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

    state = { kubo, service, handler, settings, userData, devices, apps, appTools };
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

// What the approval dialog says for each agent action: [button, title, message].
const APPROVALS = {
  site_publish: ['Publish', 'Publish a site', 'The assistant wants to publish a site from this computer.'],
  site_update: ['Update', 'Update a site', 'The assistant wants to update a site you host.'],
  app_install: ['Install', 'Install an app', 'The assistant wants to install an app.'],
  app_call: ['Allow', 'Let the assistant use an app', 'The assistant wants to use an app’s tools.'],
  app_update: ['Update', 'Update an app', 'The assistant wants to update an app.'],
  app_uninstall: ['Uninstall', 'Uninstall an app', 'The assistant wants to remove an app.'],
};

/**
 * Ask before the agent publishes or updates a site, or installs, uses, updates or removes an app.
 * A native dialog, so no page can draw or click it; card.label comes from approvalCard() /
 * installCard() (hosting/src/main/sites|apps/agent-tools.js), built from main-process data only.
 * Unanswered after timeoutMs counts as a no.
 */
async function askApproval(win, card, { timeoutMs = 120000 } = {}) {
  const { dialog } = require('electron');
  const [button, title, message] = APPROVALS[card.name] || ['Allow', 'Allow this action', 'The assistant wants to do something that needs your approval.'];
  const signal = AbortSignal.timeout(timeoutMs);
  const opts = {
    type: 'question',
    buttons: [button, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title,
    message,
    detail: card.label,
    signal,
  };
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return response === 0 && !signal.aborted;
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
