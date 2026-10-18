'use strict';
// Bucks Browser — preload for the chrome window (ui/).
// This file is the ONLY bridge between the SvelteKit chrome and the main process.
// Everything exposed here is documented in docs/IPC-CONTRACT.md. Keep the two in sync.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** Subscribe to a main → renderer event. Returns an unsubscribe function. */
const subscribe = (channel, callback) => {
  const handler = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const api = Object.freeze({
  platform: process.platform,
  versions: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }),

  app: Object.freeze({
    /** @returns {Promise<{ name: string, version: string, userData: string }>} */
    info: () => invoke('bucks:app:info'),
    /** Keyboard shortcuts routed through the native menu: ({ action: string }) */
    onShortcut: (cb) => subscribe('bucks:app:shortcut', cb),
    /** The chrome is wired up: links handed over by the OS before this are delivered now. */
    chromeReady: () => invoke('bucks:app:chrome-ready'),
    /** @returns {Promise<DefaultBrowserStatus>} */
    defaultBrowser: () => invoke('bucks:app:default-browser'),
    /** Ask the OS to make Bucks the default browser (Windows opens its settings). @returns {Promise<DefaultBrowserStatus>} */
    setDefaultBrowser: () => invoke('bucks:app:set-default-browser'),
  }),

  extensions: Object.freeze({
    /** @returns {Promise<{ folder: string, extensions: ExtensionInfo[] }>} */
    list: () => invoke('bucks:extensions:list'),
    /** Reload every extension from the folder. @returns {Promise<{ folder: string, extensions: ExtensionInfo[] }>} */
    reload: () => invoke('bucks:extensions:reload'),
    openFolder: () => invoke('bucks:extensions:open-folder'),
  }),

  browsingData: Object.freeze({
    /** Clear cookies / cache / site data of web pages (normal and private tabs). @returns {Promise<{ cleared: string[] }>} */
    clear: ({ cookies, cache, siteData }) => invoke('bucks:browsing-data:clear', { cookies, cache, siteData }),
  }),

  window: Object.freeze({
    minimize: () => invoke('bucks:window:minimize'),
    /** Toggles maximize / restore. */
    maximize: () => invoke('bucks:window:maximize'),
    close: () => invoke('bucks:window:close'),
    isMaximized: () => invoke('bucks:window:is-maximized'),
    /** (isMaximized: boolean) */
    onMaximized: (cb) => subscribe('bucks:window:maximized', cb),
  }),

  tabs: Object.freeze({
    /** Create a web content view for an existing renderer-side tab id. opts.private: in-memory private session. */
    create: (id, url, opts) => invoke('bucks:tabs:create', { id, url, private: opts?.private === true }),
    navigate: (id, url) => invoke('bucks:tabs:navigate', { id, url }),
    close: (id) => invoke('bucks:tabs:close', { id }),
    /** Show this tab's view (and hide the others). Pass null to hide all views. */
    activate: (id) => invoke('bucks:tabs:activate', { id }),
    back: (id) => invoke('bucks:tabs:back', { id }),
    forward: (id) => invoke('bucks:tabs:forward', { id }),
    reload: (id) => invoke('bucks:tabs:reload', { id }),
    stop: (id) => invoke('bucks:tabs:stop', { id }),
    /** @returns {Promise<TabState | null>} */
    getState: (id) => invoke('bucks:tabs:get-state', { id }),
    /** Where web content should be drawn, in CSS px of the chrome window: { x, y, width, height } */
    setContentBounds: (bounds) => invoke('bucks:tabs:set-content-bounds', bounds),
    /** Hide/show the active view (used while chrome overlays/modals are open). */
    setContentVisible: (visible) => invoke('bucks:tabs:set-content-visible', { visible }),
    /** @returns {Promise<string>} PNG data URL thumbnail of the tab. */
    capture: (id) => invoke('bucks:tabs:capture', { id }),
    /** Extract readable text of the page (for the agent). @returns {Promise<{ title: string, text: string, url: string }>} */
    extractText: (id) => invoke('bucks:tabs:extract-text', { id }),
    /** Find in page. opts: { forward = true, findNext = false (true: next match of the current search), matchCase = false }. @returns {Promise<number>} request id */
    find: (id, text, opts) => invoke('bucks:tabs:find', { id, text, ...(opts || {}) }),
    /** action: 'clearSelection' | 'keepSelection' | 'activateSelection' */
    stopFind: (id, action) => invoke('bucks:tabs:stop-find', { id, action }),
    /** ({ id, requestId, activeMatchOrdinal, matches, finalUpdate }) */
    onFoundInPage: (cb) => subscribe('bucks:tabs:found-in-page', cb),
    /** action: 'in' | 'out' | 'reset'. @returns {Promise<number>} zoom in percent */
    zoom: (id, action) => invoke('bucks:tabs:zoom', { id, action }),
    setMuted: (id, muted) => invoke('bucks:tabs:set-muted', { id, muted }),
    /** System print dialog. @returns {Promise<{ printed: boolean }>} */
    print: (id) => invoke('bucks:tabs:print', { id }),
    /** Save as PDF (asks where). @returns {Promise<{ path: string | null }>} */
    printToPdf: (id) => invoke('bucks:tabs:print-to-pdf', { id }),
    /** (state: TabState) */
    onUpdated: (cb) => subscribe('bucks:tabs:updated', cb),
    /** ({ openerId: string | null, url: string, disposition: string }) — renderer decides whether to open a tab. */
    onOpenRequest: (cb) => subscribe('bucks:tabs:open-request', cb),
    /** ({ id }) — the page closed itself (window.close()) or crashed beyond recovery. */
    onClosed: (cb) => subscribe('bucks:tabs:closed', cb),
  }),

  ipfs: Object.freeze({
    /** @returns {Promise<IpfsStatus>} */
    status: () => invoke('bucks:ipfs:status'),
    /** (Re)start the embedded node. */
    start: () => invoke('bucks:ipfs:start'),
    stop: () => invoke('bucks:ipfs:stop'),
    /** @returns {Promise<{ peer_id: string, addresses: string[], agent_version: string }>} */
    nodeInfo: () => invoke('bucks:ipfs:node-info'),
    /** @returns {Promise<IpfsAddResult>} */
    add: ({ fileName, mimeType, dataBase64 }) => invoke('bucks:ipfs:add', { fileName, mimeType, dataBase64 }),
    /** @returns {Promise<IpfsAddResult>} */
    addText: (content, fileName) => invoke('bucks:ipfs:add-text', { content, fileName }),
    /** @returns {Promise<string>} base64 of the content (capped by maxBytes, default 8 MiB). */
    cat: (path, opts) => invoke('bucks:ipfs:cat', { path, ...(opts || {}) }),
    /** @returns {Promise<Array<{ name: string, cid: string, size: number, type: 'file' | 'dir' | 'unknown' }>>} */
    ls: (path) => invoke('bucks:ipfs:ls', { path }),
    pinAdd: (cid) => invoke('bucks:ipfs:pin-add', { cid }),
    pinRm: (cid) => invoke('bucks:ipfs:pin-rm', { cid }),
    /** @returns {Promise<Array<{ cid: string, pin_type: string }>>} */
    pinLs: () => invoke('bucks:ipfs:pin-ls'),
    /** @returns {Promise<Array<{ peer: string, addr: string, latency?: string }>>} */
    peers: () => invoke('bucks:ipfs:peers'),
    /** @returns {Promise<{ repo_size: number, storage_max: number, num_objects: number, peers: number, bw?: { rate_in: number, rate_out: number, total_in: number, total_out: number } }>} */
    stats: () => invoke('bucks:ipfs:stats'),
    /** Resolve an IPNS name / DNSLink to an /ipfs/ path. @returns {Promise<string>} */
    resolve: (name) => invoke('bucks:ipfs:resolve', { name }),
    /** Map an ipfs:// or ipns:// URL to an HTTP gateway URL (local node when ready, else public gateway). */
    gatewayUrlFor: (url) => invoke('bucks:ipfs:gateway-url-for', { url }),
    /** Normalise a CID / ipfs url (CIDv0 → CIDv1 base32). @returns {Promise<string>} */
    normalizeUrl: (url) => invoke('bucks:ipfs:normalize-url', { url }),
    /** (status: IpfsStatus) */
    onStatus: (cb) => subscribe('bucks:ipfs:status', cb),
  }),

  settings: Object.freeze({
    /** @returns {Promise<Settings>} */
    get: () => invoke('bucks:settings:get'),
    /** Deep-merges a partial patch. @returns {Promise<Settings>} */
    set: (patch) => invoke('bucks:settings:set', patch),
    /** (settings: Settings) */
    onChange: (cb) => subscribe('bucks:settings:changed', cb),
  }),

  downloads: Object.freeze({
    /** @returns {Promise<DownloadItem[]>} */
    list: () => invoke('bucks:downloads:list'),
    open: (id) => invoke('bucks:downloads:open', { id }),
    showInFolder: (id) => invoke('bucks:downloads:show-in-folder', { id }),
    cancel: (id) => invoke('bucks:downloads:cancel', { id }),
    clear: () => invoke('bucks:downloads:clear'),
    /** (item: DownloadItem) */
    onEvent: (cb) => subscribe('bucks:downloads:event', cb),
  }),

  agent: Object.freeze({
    /** @returns {Promise<{ online: boolean, provider: string, model?: string, providers: string[] }>} */
    status: () => invoke('bucks:agent:status'),
    /** @returns {Promise<AgentResult>} */
    query: ({ prompt, currentUrl, currentTitle, tabId }) => invoke('bucks:agent:query', { prompt, currentUrl, currentTitle, tabId }),
    feedback: ({ taskId, score, correction }) => invoke('bucks:agent:feedback', { taskId, score, correction }),
    /** @returns {Promise<string[]>} models available for the current provider */
    listModels: () => invoke('bucks:agent:list-models'),
    /** Soul Engine sidecar. @returns {Promise<SoulStatus>} */
    soulStatus: () => invoke('bucks:agent:soul-status'),
    /** @returns {Promise<SoulStatus>} */
    soulStart: () => invoke('bucks:agent:soul-start'),
    /** @returns {Promise<SoulStatus>} */
    soulStop: () => invoke('bucks:agent:soul-stop'),
    /** Create the engine's private Python environment, then start it. @returns {Promise<SoulStatus>} */
    soulInstall: () => invoke('bucks:agent:soul-install'),
    /** (status: SoulStatus) */
    onSoulStatus: (cb) => subscribe('bucks:agent:soul-status', cb),
  }),

  wallet: Object.freeze({
    /** Proxied HTTP call to the configured Bucks node. @returns {Promise<any>} parsed JSON */
    rpc: ({ method, path, body }) => invoke('bucks:wallet:rpc', { method, path, body }),
  }),

  security: Object.freeze({
    /** @returns {Promise<{ blockedRequests: number, httpsUpgrades: number, adBlockReady: boolean }>} */
    stats: () => invoke('bucks:security:stats'),
  }),

  devices: Object.freeze({
    /** @returns {Promise<DevicesStatus>} this device, paired devices, discovered devices, received shares */
    status: () => invoke('bucks:devices:status'),
    /** Pair with another Bucks device. peerId is required; addrs are multiaddrs from its device card. */
    pair: ({ peerId, name, addrs }) => invoke('bucks:devices:pair', { peerId, name, addrs }),
    unpair: (peerId) => invoke('bucks:devices:unpair', { peerId }),
    /** Set this device's display name ('' resets to the host name). */
    rename: (name) => invoke('bucks:devices:rename', { name }),
    /** Offer a CID to every paired device. @returns {Promise<{ queued: boolean, onlinePeers: number }>} */
    share: ({ cid, name, size }) => invoke('bucks:devices:share', { cid, name, size }),
    /** Remove a received share from the list (does not unpin). */
    dismiss: ({ cid, from }) => invoke('bucks:devices:dismiss', { cid, from }),
    /** (status: DevicesStatus) */
    onUpdated: (cb) => subscribe('bucks:devices:updated', cb),
  }),

  updater: Object.freeze({
    /** @returns {Promise<UpdateStatus>} local checkout state, no network. */
    status: () => invoke('bucks:updater:status'),
    /** Fetches the remote branch. @returns {Promise<UpdateStatus>} */
    check: () => invoke('bucks:updater:check'),
    /** Pulls, installs dependencies and rebuilds. @returns {Promise<{ updated: boolean, from?: string, to?: string, subject?: string, message: string }>} */
    install: () => invoke('bucks:updater:install'),
    /** Relaunches the app so the new code runs. */
    restart: () => invoke('bucks:updater:restart'),
    /** ({ step: 'pull' | 'deps' | 'build', state: 'running' | 'done' | 'failed', message: string }) */
    onProgress: (cb) => subscribe('bucks:updater:progress', cb),
  }),

  shell: Object.freeze({
    /** Open http(s)/mailto URLs in the OS default handler. */
    openExternal: (url) => invoke('bucks:shell:open-external', { url }),
  }),
});

contextBridge.exposeInMainWorld('bucks', api);
