// The Bucks container (docs/APP-ENVIRONMENT.md §4): each installed app runs in its own window, on
// its own session partition (its storage, cache and cookies are its own and survive updates),
// served from bucks-app://<id>/ (its pinned version on the local node). The session allows only
// the network origins the app was granted, refuses every Chromium permission it was not granted,
// and never reaches the local node's API or gateway ports. Links to the web open in a Bucks tab.
// The app's only bridge to Bucks is src/preload/app-preload.cjs (window.bucks.app), checked here.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain, session as electronSession } from 'electron';
import { allowRequest, allowPermission, navigationTarget, partitionOf, APP_SCHEME } from './policy.js';

export const TOOL_TIMEOUT_MS = 60_000;
export const TOOL_READY_TIMEOUT_MS = 20_000;
export const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_IPFS_BYTES = 16 * 1024 * 1024;

/**
 * @param {{
 *   getRecord: (id: string) => any,
 *   protocolHandler: (req: Request) => Promise<Response>,
 *   ipfsHandler: (req: Request) => Promise<Response>,
 *   kubo: { isReady(): boolean, rpc: any },
 *   preloadPath: string, userData: string,
 *   openInBrowser: (url: string) => void,
 *   nodeOrigins: () => string[],
 *   onChange?: (id: string) => void,
 *   log: { info: Function, warn: Function, error: Function },
 * }} deps
 */
export function createContainerManager({ getRecord, protocolHandler, ipfsHandler, kubo, preloadPath, userData, openInBrowser, nodeOrigins, onChange = () => {}, log }) {
  /** @type {Map<string, { win: BrowserWindow, tools: Set<string>, waiters: Set<Function>, calls: Map<string, { resolve: Function, reject: Function, timer: any }> }>} */
  const running = new Map();
  const byContents = new Map(); // webContents id → app id
  const configured = new Set();

  const grants = (id) => getRecord(id)?.granted ?? [];
  const forbidden = () => new Response('Not allowed for this app', { status: 403, headers: { 'content-type': 'text/plain' } });

  function sessionFor(id) {
    const ses = electronSession.fromPartition(partitionOf(id));
    if (configured.has(id)) return ses;
    configured.add(id);
    const own = (req) => {
      try { if (new URL(req.url).hostname !== id) return forbidden(); } catch { return forbidden(); }
      return protocolHandler(req);
    };
    for (const [scheme, handler] of [[APP_SCHEME, own], ['ipfs', (r) => (grants(id).includes('ipfs') ? ipfsHandler(r) : forbidden())], ['ipns', (r) => (grants(id).includes('ipfs') ? ipfsHandler(r) : forbidden())]]) {
      if (ses.protocol.isProtocolHandled(scheme)) ses.protocol.unhandle(scheme);
      ses.protocol.handle(scheme, handler);
    }
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const ok = allowRequest(details.url, { appId: id, granted: grants(id), nodeOrigins: nodeOrigins() });
      if (!ok) log.info(`app ${id}: blocked ${details.resourceType} ${details.url.slice(0, 160)}`);
      callback({ cancel: !ok });
    });
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      callback(allowPermission({ permission, granted: grants(id), kind: 'request', mediaTypes: details?.mediaTypes }));
    });
    ses.setPermissionCheckHandler((_wc, permission, _origin, details) => allowPermission({ permission, granted: grants(id), kind: 'check', mediaType: details?.mediaType }));
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_req, callback) => callback(null));
    ses.setBluetoothPairingHandler?.((_d, callback) => callback({ confirmed: false }));
    ses.setSpellCheckerEnabled?.(false);
    return ses;
  }

  function entryOf(event) {
    const id = byContents.get(event.sender.id);
    if (!id || event.senderFrame !== event.sender.mainFrame) return null;
    if (!String(event.senderFrame?.url || '').startsWith(`${APP_SCHEME}://${id}/`)) return null;
    const entry = running.get(id);
    return entry ? { id, entry } : null;
  }

  function guard(event) {
    const hit = entryOf(event);
    if (!hit) throw new Error('This channel is only for Bucks apps.');
    return hit;
  }

  // ── the bridge (src/preload/app-preload.cjs) ──
  ipcMain.removeHandler?.('bucks-app:info');
  ipcMain.handle('bucks-app:info', (event) => {
    const { id } = guard(event);
    const app = getRecord(id);
    return { id, name: app?.name, version: app?.current?.version || '', permissions: grants(id), tools: (app?.current?.tools || []).map((t) => t.name) };
  });
  ipcMain.removeHandler?.('bucks-app:ipfs-add');
  ipcMain.handle('bucks-app:ipfs-add', async (event, data, opts) => {
    const { id } = guard(event);
    if (!grants(id).includes('ipfs')) throw new Error('This app is not allowed to use your IPFS node.');
    if (!kubo.isReady()) throw new Error('Your IPFS node is not running.');
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8')
      : data instanceof Uint8Array ? Buffer.from(data)
        : data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.alloc(0);
    if (bytes.length === 0 || bytes.length > MAX_IPFS_BYTES) throw new Error(`Add between 1 byte and ${MAX_IPFS_BYTES / 1024 / 1024} MB.`);
    const fileName = typeof opts?.name === 'string' ? opts.name.replace(/[/\\\u0000]/g, '_').slice(0, 100) || 'file' : 'file';
    const r = await kubo.rpc.add(bytes, { fileName, pin: true });
    return { cid: r.cid, size: bytes.length };
  });
  ipcMain.removeHandler?.('bucks-app:ipfs-cat');
  ipcMain.handle('bucks-app:ipfs-cat', async (event, cidPath) => {
    const { id } = guard(event);
    if (!grants(id).includes('ipfs')) throw new Error('This app is not allowed to use your IPFS node.');
    if (!kubo.isReady()) throw new Error('Your IPFS node is not running.');
    if (typeof cidPath !== 'string' || !/^\/?(ipfs\/)?[a-zA-Z0-9]{20,}(\/[^\u0000]*)?$/.test(cidPath)) throw new Error('A CID (optionally with a path) is required.');
    return new Uint8Array(await kubo.rpc.cat(cidPath.replace(/^\/?(ipfs\/)?/, ''), { maxBytes: MAX_IPFS_BYTES }));
  });
  ipcMain.removeHandler?.('bucks-app:open-external');
  ipcMain.handle('bucks-app:open-external', (event, url) => {
    guard(event);
    if (typeof url !== 'string' || url.length > 4096 || !/^(https?|ipfs|ipns):\/\//i.test(url)) throw new Error('Only http(s), ipfs and ipns links can be opened.');
    openInBrowser(url);
    return true;
  });
  ipcMain.removeAllListeners?.('bucks-app:tools');
  ipcMain.on('bucks-app:tools', (event, names) => {
    const hit = entryOf(event);
    if (!hit || !Array.isArray(names)) return;
    const declared = new Set((getRecord(hit.id)?.current?.tools || []).map((t) => t.name));
    hit.entry.tools = new Set(names.filter((n) => typeof n === 'string' && declared.has(n)));
    for (const w of hit.entry.waiters) w();
  });
  ipcMain.removeAllListeners?.('bucks-app:tool-result');
  ipcMain.on('bucks-app:tool-result', (event, msg) => {
    const hit = entryOf(event);
    const call = hit && msg && typeof msg.callId === 'string' ? hit.entry.calls.get(msg.callId) : null;
    if (!call) return;
    hit.entry.calls.delete(msg.callId);
    clearTimeout(call.timer);
    if (!msg.ok) { call.reject(new Error(String(msg.error || 'The app reported an error.').slice(0, 1000))); return; }
    let json;
    try { json = JSON.stringify(msg.result ?? null); } catch { call.reject(new Error('The app returned something that is not JSON.')); return; }
    if (Buffer.byteLength(json) > MAX_TOOL_RESULT_BYTES) { call.reject(new Error(`The app's answer is larger than ${MAX_TOOL_RESULT_BYTES / 1024} KB.`)); return; }
    call.resolve(JSON.parse(json));
  });

  function cleanup(id, entry) {
    running.delete(id);
    for (const [wcId, appId] of byContents) if (appId === id) byContents.delete(wcId);
    for (const call of entry.calls.values()) { clearTimeout(call.timer); call.reject(new Error('The app was closed.')); }
    entry.calls.clear();
    onChange(id);
  }

  const manager = {
    /** Open (or focus) the app's window. @param {{ focus?: boolean }} [opts] */
    async open(app, { focus = true } = {}) {
      const existing = running.get(app.id);
      if (existing && !existing.win.isDestroyed()) {
        if (focus) { if (existing.win.isMinimized()) existing.win.restore(); existing.win.show(); existing.win.focus(); }
        return;
      }
      const ses = sessionFor(app.id);
      const win = new BrowserWindow({
        width: app.window?.width || 1100,
        height: app.window?.height || 760,
        minWidth: 360,
        minHeight: 320,
        title: app.name,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff', // tokens-ignore: an app is a web page; unstyled pages paint on white, as in tabs
        webPreferences: {
          session: ses,
          preload: preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webviewTag: false,
          spellcheck: false,
          navigateOnDragDrop: false,
          safeDialogs: true,
        },
      });
      win.setMenu?.(null);
      const wc = win.webContents;
      const entry = { win, tools: new Set(), waiters: new Set(), calls: new Map() };
      running.set(app.id, entry);
      byContents.set(wc.id, app.id);
      const route = (url) => {
        const t = navigationTarget(url, app.id);
        if (t === 'browser') openInBrowser(url);
        return t;
      };
      wc.setWindowOpenHandler(({ url }) => { route(url); return { action: 'deny' }; });
      wc.on('will-navigate', (e, url) => { if (navigationTarget(url, app.id) !== 'stay') { e.preventDefault(); route(url); } });
      wc.on('will-redirect', (e, url, _inPlace, isMainFrame) => { if (isMainFrame && navigationTarget(url, app.id) !== 'stay') { e.preventDefault(); route(url); } });
      wc.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => { if (isMainFrame) entry.tools = new Set(); });
      wc.on('page-title-updated', (e, title) => {
        e.preventDefault();
        const name = getRecord(app.id)?.name || app.name;
        win.setTitle(title && title !== name ? `${title.slice(0, 80)} — ${name}` : name);
      });
      wc.on('render-process-gone', (_e, details) => log.warn(`app ${app.id} renderer gone: ${details.reason}`));
      win.once('ready-to-show', () => { if (focus) win.show(); else win.showInactive(); });
      win.on('closed', () => cleanup(app.id, entry));
      onChange(app.id);
      win.loadURL(`${APP_SCHEME}://${app.id}/`).catch((e) => log.warn(`app ${app.id} load: ${e.message}`));
    },

    isRunning: (id) => Boolean(running.get(id) && !running.get(id).win.isDestroyed()),
    runningIds: () => [...running.keys()],

    /** Reload a running app (after an update, a rollback or a revoked permission). */
    reload(id) {
      const entry = running.get(id);
      if (entry && !entry.win.isDestroyed()) entry.win.webContents.reloadIgnoringCache();
    },

    close(id) {
      const entry = running.get(id);
      if (entry && !entry.win.isDestroyed()) entry.win.close();
    },

    /** Close the app and delete everything it stored. */
    async forget(id) {
      const entry = running.get(id);
      if (entry && !entry.win.isDestroyed()) entry.win.destroy();
      const ses = electronSession.fromPartition(partitionOf(id));
      try {
        await ses.clearStorageData();
        await ses.clearCache();
      } catch (e) { log.warn(`app ${id}: clearing storage failed: ${e.message}`); }
      configured.delete(id);
      await fs.rm(path.join(userData, 'Partitions', partitionOf(id).replace(/^persist:/, '')), { recursive: true, force: true }).catch(() => {});
    },

    /**
     * Run one of the app's agent tools: opens the app (without focus) if needed, waits for it to
     * register the tool, sends the call, and returns its JSON answer.
     */
    async invokeTool(app, name, input) {
      if (!manager.isRunning(app.id)) await manager.open(app, { focus: false });
      const entry = running.get(app.id);
      if (!entry) throw new Error(`${app.name} could not be started.`);
      if (!entry.tools.has(name)) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { entry.waiters.delete(check); reject(new Error(`${app.name} did not offer the tool "${name}" within ${TOOL_READY_TIMEOUT_MS / 1000} s.`)); }, TOOL_READY_TIMEOUT_MS);
          function check() { if (entry.tools.has(name)) { clearTimeout(timer); entry.waiters.delete(check); resolve(); } }
          entry.waiters.add(check);
        });
      }
      const callId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { entry.calls.delete(callId); reject(new Error(`${app.name} did not answer within ${TOOL_TIMEOUT_MS / 1000} s.`)); }, TOOL_TIMEOUT_MS);
        entry.calls.set(callId, { resolve, reject, timer });
        entry.win.webContents.send('bucks-app:tool-call', { callId, name, input });
      });
    },
  };
  return manager;
}
