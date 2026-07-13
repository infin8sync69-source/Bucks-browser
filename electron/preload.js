const { contextBridge, ipcRenderer } = require('electron');

const bucksAPI = {
  /* ─── Window Controls ─── */
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  /* ─── Settings ─── */
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  /* ─── Ad-blocker & Events ─── */
  getBlockedCount: () => ipcRenderer.invoke('get-blocked-count'),
  toggleAdBlock: (enabled) => ipcRenderer.send('toggle-adblock', enabled),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  onWalletAccessRequest: (callback) => ipcRenderer.on('wallet-access-request', (_e, data) => callback(data)),
  respondToWalletAccess: (requestId, approved) => ipcRenderer.send('wallet-access-response', { requestId, approved }),
  onDownloadEvent: (callback) => ipcRenderer.on('download-event', (_e, data) => callback(data)),
  openDownloadsFolder: () => ipcRenderer.send('open-downloads-folder'),
  showDownloadInFolder: (savePath) => ipcRenderer.send('show-download-in-folder', savePath),

  /* ─── Core browser ─── */
  openPrivateWindow: () => ipcRenderer.send('open-private-window'),
  clearBrowsingData: (opts) => ipcRenderer.invoke('clear-browsing-data', opts),

  /* ─── Wallet RPC (proxied through main process) ─── */
  walletRPC: (params) => ipcRenderer.invoke('wallet-rpc', params),
  walletReset: () => ipcRenderer.invoke('wallet-reset'),

  /* ─── IPFS Social Network (Local Helia) ─── */
  ipfsInfo: () => ipcRenderer.invoke('ipfs-info'),
  ipfsConnect: (multiaddr) => ipcRenderer.invoke('ipfs-connect', { multiaddr }),
  ipfsPeers: () => ipcRenderer.invoke('ipfs-peers'),
  ipfsPublish: (content, metadata) => ipcRenderer.invoke('ipfs-publish', { content, metadata }),
  ipfsFeed: () => ipcRenderer.invoke('ipfs-feed'),
  ipfsFollow: (peerId) => ipcRenderer.invoke('ipfs-follow', { peerId }),
  ipfsUnfollow: (peerId) => ipcRenderer.invoke('ipfs-unfollow', { peerId }),
  ipfsUpvote: (cid) => ipcRenderer.invoke('ipfs-upvote', { cid }),
  ipfsGet: (cid) => ipcRenderer.invoke('ipfs-get', { cid }),
  ipfsUnpin: (cid) => ipcRenderer.invoke('ipfs-unpin', { cid }),
  ipfsStorageStats: () => ipcRenderer.invoke('ipfs-storage-stats'),
  ipfsPublishDweb: (name, cid, title, desc) => ipcRenderer.invoke('ipfs-publish-dweb', { name, cid, title, desc }),
  ipfsSearchDweb: (query) => ipcRenderer.invoke('ipfs-search-dweb', { query }),

  /* ─── File Manager API ─── */
  fileManagerGet: () => ipcRenderer.invoke('file-manager-get'),
  fileManagerSave: (data) => ipcRenderer.invoke('file-manager-save', data),
  fileManagerDownload: (cid, name) => ipcRenderer.invoke('file-manager-download', { cid, name }),

  /* ─── Social RPC (proxied through main to port 8000) ─── */
  socialRPC: (params) => ipcRenderer.invoke('social-rpc', params),

  /* ─── P2P Encrypted Chat (Signal over Gossipsub, no server) ─── */
  chatSend: (peerId, text, attachmentCid) => ipcRenderer.invoke('chat-send', { peerId, text, attachmentCid }),
  chatSendFile: (peerId, fileData, filename) => ipcRenderer.invoke('chat-send-file', { peerId, fileData, filename }),
  chatHistory: (peerId) => ipcRenderer.invoke('chat-history', { peerId }),
  chatConversations: () => ipcRenderer.invoke('chat-conversations'),
  chatMarkRead: (peerId) => ipcRenderer.invoke('chat-mark-read', { peerId }),
  chatOwnBundle: () => ipcRenderer.invoke('chat-own-bundle'),
  chatProcessBundle: (peerId, bundle) => ipcRenderer.invoke('chat-process-bundle', { peerId, bundle }),
  chatHasBundle: (peerId) => ipcRenderer.invoke('chat-has-bundle', { peerId }),
  onChatMessage: (callback) => ipcRenderer.on('chat-message', (_e, data) => callback(data)),

  /* ─── Web Intelligence (Agent Browser — proxied through main) ─── */
  webSearch: (query, maxResults) => ipcRenderer.invoke('web-search', { query, maxResults: maxResults || 5 }),
  webFetch: (url, maxChars) => ipcRenderer.invoke('web-fetch', { url, maxChars: maxChars || 4000 }),
  webFetchSummary: (url) => ipcRenderer.invoke('web-fetch-summary', { url }),
  showWallet: process.env.BUCKS_SHOW_WALLET === '1',
};

// ── Project NEXUS — Agentic Interface API ─────────────────────────────────────
const nexusAPI = {
  /**
   * Start an agent goal. Streams typed events back via onStep().
   * @param {string} prompt - The user's natural language goal
   * @param {object} [opts] - { context, agentic, sessionId }
   * @returns {Promise<{ok: boolean, session_id: string}>}
   */
  startGoal: (prompt, opts = {}) =>
    ipcRenderer.invoke('nexus:start-goal', { prompt, ...opts }),

  /**
   * Approve a pending browser action (e.g. browser_click).
   * @param {string} sessionId
   * @param {string} actionId
   */
  approveAction: (sessionId, actionId) =>
    ipcRenderer.invoke('nexus:approve-action', { sessionId, actionId }),

  /**
   * Deny a pending browser action.
   * @param {string} sessionId
   * @param {string} actionId
   */
  denyAction: (sessionId, actionId) =>
    ipcRenderer.invoke('nexus:deny-action', { sessionId, actionId }),

  /**
   * Cancel an in-flight agent session.
   * @param {string} sessionId
   */
  cancelGoal: (sessionId) =>
    ipcRenderer.invoke('nexus:cancel-goal', { sessionId }),

  /** Get swarm peer topology and load status. */
  getSwarmStatus: () => ipcRenderer.invoke('nexus:swarm-status'),

  /** List all persisted goals from the DB. */
  listGoals: () => ipcRenderer.invoke('nexus:list-goals'),

  /** Current Soul Engine lifecycle status (starting/loading/ready/unavailable). */
  soulEngineStatus: () => ipcRenderer.invoke('soul-engine-status'),

  /**
   * Subscribe to Soul Engine status changes pushed from the supervisor.
   * @param {function} cb - Receives { state, model?, provider?, detail? }
   * @returns {function} Unsubscribe function
   */
  onSoulEngineStatus: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('soul-engine-status', handler);
    return () => ipcRenderer.removeListener('soul-engine-status', handler);
  },

  /**
   * Subscribe to typed agent step events.
   * @param {function} cb - Receives a NEXUS step event object
   * @returns {function} Unsubscribe function
   */
  onStep: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('nexus:step', handler);
    return () => ipcRenderer.removeListener('nexus:step', handler);
  },

  /**
   * Subscribe to browser action approval requests.
   * @param {function} cb - Receives { sessionId, actionId, name, args, label }
   * @returns {function} Unsubscribe function
   */
  onApprovalRequired: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('nexus:action-approval-required', handler);
    return () => ipcRenderer.removeListener('nexus:action-approval-required', handler);
  },
};

// STRIDE: Tampering Mitigation - Freeze the APIs to prevent prototype pollution
Object.freeze(bucksAPI);
Object.freeze(nexusAPI);

contextBridge.exposeInMainWorld('bucksAPI', bucksAPI);
contextBridge.exposeInMainWorld('nexusAPI', nexusAPI);
