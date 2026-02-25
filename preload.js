const { contextBridge, ipcRenderer } = require("electron");

const bucksAPI = {
  /* ─── Window Controls ─── */
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),

  /* ─── Settings ─── */
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (s) => ipcRenderer.invoke("save-settings", s),

  /* ─── Ad-blocker & Events ─── */
  getBlockedCount: () => ipcRenderer.invoke("get-blocked-count"),
  toggleAdBlock: (enabled) => ipcRenderer.send("toggle-adblock", enabled),
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  onWalletAccessRequest: (callback) =>
    ipcRenderer.on("wallet-access-request", (_e, data) => callback(data)),
  respondToWalletAccess: (requestId, approved) =>
    ipcRenderer.send("wallet-access-response", { requestId, approved }),
  onDownloadEvent: (callback) =>
    ipcRenderer.on("download-event", (_e, data) => callback(data)),
  onWalletAccessRequest: (callback) =>
    ipcRenderer.on("wallet-access-request", (_e, data) => callback(data)),
  respondToWalletAccess: (requestId, approved) =>
    ipcRenderer.send("wallet-access-response", { requestId, approved }),

  /* ─── Wallet RPC (proxied through main process) ─── */
  walletRPC: (params) => ipcRenderer.invoke("wallet-rpc", params),

  /* ─── IPFS Social Network (Local Helia) ─── */
  ipfsInfo: () => ipcRenderer.invoke("ipfs-info"),
  ipfsPeers: () => ipcRenderer.invoke("ipfs-peers"),
  ipfsPublish: (content, metadata) =>
    ipcRenderer.invoke("ipfs-publish", { content, metadata }),
  ipfsFeed: () => ipcRenderer.invoke("ipfs-feed"),
  ipfsFollow: (peerId) => ipcRenderer.invoke("ipfs-follow", { peerId }),
  ipfsUnfollow: (peerId) => ipcRenderer.invoke("ipfs-unfollow", { peerId }),
  ipfsUpvote: (cid) => ipcRenderer.invoke("ipfs-upvote", { cid }),
  ipfsGet: (cid) => ipcRenderer.invoke("ipfs-get", { cid }),
  ipfsUnpin: (cid) => ipcRenderer.invoke("ipfs-unpin", { cid }),
  ipfsStorageStats: () => ipcRenderer.invoke("ipfs-storage-stats"),

  /* ─── Social RPC (proxied through main to port 8000) ─── */
  socialRPC: (params) => ipcRenderer.invoke("social-rpc", params),

  /* ─── E2E Encrypted Chat (IPFS + Signal Protocol) ─── */
  chatSend: (peerId, text, attachmentCid) =>
    ipcRenderer.invoke("chat-send", { peerId, text, attachmentCid }),
  chatHistory: (peerId) => ipcRenderer.invoke("chat-history", { peerId }),
  chatConversations: () => ipcRenderer.invoke("chat-conversations"),
  chatMarkRead: (peerId) => ipcRenderer.invoke("chat-mark-read", { peerId }),
  chatSendFile: (peerId, fileData, filename) =>
    ipcRenderer.invoke("chat-send-file", { peerId, fileData, filename }),
  onChatMessage: (callback) =>
    ipcRenderer.on("chat-message", (_e, data) => callback(data)),
  chatGetBundle: () => ipcRenderer.invoke("chat-key-bundle"),
  chatProcessBundle: (peerId, bundle) =>
    ipcRenderer.invoke("chat-process-bundle", { peerId, bundle }),
};

// STRIDE: Tampering Mitigation - Freeze the API to prevent prototype pollution
Object.freeze(bucksAPI);

contextBridge.exposeInMainWorld("bucksAPI", bucksAPI);
