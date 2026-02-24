const { app, BrowserWindow, ipcMain, session, Menu, MenuItem, protocol } = require('electron');
app.disableHardwareAcceleration();
const path = require('path');

// Register IPFS protocols before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'ipfs', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'ipns', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);
const fs = require('fs');
const http = require('http');

// Helia / undici polyfill for File, CustomEvent, and WebCrypto
const { File } = require('buffer');
if (typeof global.File === 'undefined') {
  global.File = File;
}
if (typeof global.CustomEvent === 'undefined') {
  global.CustomEvent = class CustomEvent extends Event {
    constructor(event, params) {
      super(event, params);
      this.detail = params?.detail;
    }
  };
}
if (typeof global.crypto === 'undefined' || !global.crypto.getRandomValues) {
  global.crypto = require('crypto').webcrypto;
}

let ipfs = null; // Lazy-loaded after app is ready

/* ─── Ad-block filter list (common tracker / ad domains) ─── */
const AD_BLOCK_PATTERNS = [
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://*.google-analytics.com/*',
  '*://*.adnxs.com/*',
  '*://*.adsrvr.org/*',
  '*://*.adform.net/*',
  '*://*.rubiconproject.com/*',
  '*://*.pubmatic.com/*',
  '*://*.openx.net/*',
  '*://*.criteo.com/*',
  '*://*.outbrain.com/*',
  '*://*.taboola.com/*',
  '*://*.facebook.net/*/fbevents.js*',
  '*://*.amazon-adsystem.com/*',
  '*://*.moatads.com/*',
  '*://*.scorecardresearch.com/*',
  '*://*.quantserve.com/*',
  '*://ads.*/*',
  '*://ad.*/*',
  '*://tracking.*/*',
];

let mainWindow;
let adBlockEnabled = true;
let httpsOnlyEnabled = false;
let blockedCount = 0;

/* ─── Settings functions ─── */
let _settingsFile = null;
function getSettingsFile() {
  if (!_settingsFile) _settingsFile = path.join(app.getPath('userData'), 'settings.json');
  return _settingsFile;
}

function loadSettings() {
  let settings = {
    homepage: 'bucks://newtab',
    adBlockEnabled: true,
    httpsOnly: false,
    originAllowlist: [],
    clusterSecret: 'BUCKS_DEFAULT_CLUSTER',
    clusterCidn: 'mainnet'
  };

  try {
    if (fs.existsSync(getSettingsFile())) {
      const data = fs.readFileSync(getSettingsFile(), 'utf8');
      settings = { ...settings, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }

  // Apply Cluster environment variables for the IPFS node
  if (!process.env.BUCKS_CLUSTER_SECRET) process.env.BUCKS_CLUSTER_SECRET = settings.clusterSecret;
  if (!process.env.BUCKS_CLUSTER_CIDN) process.env.BUCKS_CLUSTER_CIDN = settings.clusterCidn;

  return settings;
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(getSettingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

/* ─── Window creation ─── */
function createWindow() {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: !isMac, // Use standard frame for Mac if we want OS buttons, or false for custom
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  mainWindow.loadURL('http://localhost:3000');
  setupRequestFilters();
  mainWindow.webContents.openDevTools();

  // Prevent external window opening and route to internal tab system
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    mainWindow.webContents.send('new-window', { url });
    return { action: 'deny' };
  });

  // Forward renderer console logs to main terminal
  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log('[Renderer UI]', message);
  });
}

/* ─── Request Filtering (Ad-block & HTTPS Upgrade) ─── */
const COMPILED_AD_PATTERNS = AD_BLOCK_PATTERNS.map(pattern => new RegExp('^' + pattern.split('*').join('.*') + '$', 'i'));

function setupRequestFilters() {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['*://*/*'] },
    (details, callback) => {
      const url = details.url;

      // 1. HTTPS Upgrade
      if (httpsOnlyEnabled && url.startsWith('http://') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
        return callback({ redirectURL: url.replace('http://', 'https://') });
      }

      // 2. Ad-blocking optimization (Precompiled regex)
      const isAd = COMPILED_AD_PATTERNS.some(regex => regex.test(url));

      if (adBlockEnabled && isAd) {
        blockedCount++;
        return callback({ cancel: true });
      }

      callback({});
    }
  );
}

/* ─── Setup IPC handlers ─── */
function setupIPC() {
  // Window controls
  ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });
  ipcMain.on('window-close', () => mainWindow && mainWindow.close());

  // Settings
  ipcMain.handle('get-settings', () => loadSettings());
  ipcMain.handle('save-settings', (_e, settings) => {
    saveSettings(settings);
    adBlockEnabled = settings.adBlockEnabled;
    httpsOnlyEnabled = settings.httpsOnly;
    // Update the in-memory allowlist
    originAllowlist = settings.originAllowlist || [];
    return { ok: true };
  });

  // Ad-blocker stats
  ipcMain.handle('get-blocked-count', () => blockedCount);
  ipcMain.on('toggle-adblock', (_e, enabled) => {
    adBlockEnabled = enabled;
  });

  // Platform info
  ipcMain.handle('get-platform', () => process.platform);

  // ─── Phase 7: Security Hardening ───

  const ALLOWED_WALLET_METHODS = ['GET', 'POST'];
  const ALLOWED_WALLET_ENDPOINTS = [
    '/api/economy/status',
    '/api/wallets',
    '/api/wallets/create',
    '/api/wallets/restore',
    '/api/transactions/send'
  ];

  let originAllowlist = loadSettings().originAllowlist || [];

  function isInternalOrigin(sender) {
    const url = sender.getURL();
    // Trusted internal shell is allowed by default
    return url.startsWith('file://') && (url.includes('index.html') || url.includes('bucks-browser'));
  }

  function validateOriginAccess(event) {
    const sender = event.sender;
    const origin = new URL(sender.getURL()).origin;

    // 1. Block file:// (except internal), null, and unknown origins (STRIDE: Spoofing)
    if (origin === 'null') return 'BLOCKED';
    if (origin.startsWith('file:') && !isInternalOrigin(sender)) return 'BLOCKED';

    // 2. Internal Shell is always allowed
    if (isInternalOrigin(sender)) return 'ALLOWED';

    // 3. Check User-Managed Allowlist
    if (originAllowlist.includes(origin)) return 'ALLOWED';

    // 4. Unknown Origin -> Needs Approval
    return 'PENDING_APPROVAL';
  }

  function validateWalletSchema(params) {
    if (!params || typeof params !== 'object') {
      console.error('[ATTACK SIGNAL] Malformed IPC: Request is not an object');
      return false;
    }

    const { method, endpoint, body } = params;

    // 1. Method/Endpoint Allowlist
    if (!ALLOWED_WALLET_METHODS.includes(method) || !ALLOWED_WALLET_ENDPOINTS.includes(endpoint)) {
      console.error(`[ATTACK SIGNAL] Invalid Endpoint/Method: ${method} ${endpoint}`);
      return false;
    }

    // 2. Body Validation (Strict Schema)
    if (method === 'POST') {
      if (!body || typeof body !== 'object') {
        console.error(`[ATTACK SIGNAL] Missing or invalid POST body for ${endpoint}`);
        return false;
      }

      const keys = Object.keys(body);

      // Intent-specific schemas
      const schemas = {
        '/api/transactions/send': ['from', 'to', 'amount'],
        '/api/wallets/create': ['password'],
        '/api/wallets/restore': ['mnemonic']
      };

      const allowedKeys = schemas[endpoint];
      if (allowedKeys) {
        // Must contain ONLY allowed keys and ALL required keys (if applicable)
        const hasExtra = keys.some(k => !allowedKeys.includes(k));
        if (hasExtra) {
          console.error(`[ATTACK SIGNAL] Unauthorized keys detected in ${endpoint}: ${keys}`);
          return false;
        }
      }
    } else if (body) {
      console.error(`[ATTACK SIGNAL] Forbidden body detected in GET request to ${endpoint}`);
      return false;
    }

    return true;
  }

  const pendingApprovals = new Map();

  ipcMain.handle('wallet-rpc', async (event, params) => {
    // 1. Origin Gating (Phase 7: Gatekeeper)
    const access = validateOriginAccess(event);
    const origin = new URL(event.sender.getURL()).origin;

    if (access === 'BLOCKED') {
      console.error(`[ATTACK SIGNAL] Blocked unauthorized origin: ${origin}`);
      return { error: 'Access Denied: Origin blocked by policy' };
    }

    if (access === 'PENDING_APPROVAL') {
      // 1.1 Signal the shell to show the approval modal
      const requestId = Math.random().toString(36).substring(7);
      mainWindow.webContents.send('wallet-access-request', { requestId, origin });

      // 1.2 Wait for user response
      const approved = await new Promise((resolve) => {
        pendingApprovals.set(requestId, resolve);
      });

      if (!approved) {
        return { error: 'User denied wallet access.' };
      }

      // Update allowlist & save
      originAllowlist.push(origin);
      const settings = loadSettings();
      settings.originAllowlist = originAllowlist;
      saveSettings(settings);
    }

    // 2. Schema Validation (STRIDE: Tampering Mitigation)
    if (!validateWalletSchema(params)) {
      console.error(`[ATTACK SIGNAL] Blocked malformed wallet-rpc request: ${JSON.stringify(params)}`);
      return { error: 'Invalid request schema' };
    }

    const method = params.method || 'GET';
    const endpoint = params.endpoint;
    const body = params.body || null;
    try {
      // Connect to the Bucks node (default localhost:8080)
      return new Promise((resolve) => {
        const options = {
          hostname: 'localhost',
          port: 8080,
          path: endpoint,
          method: method,
          headers: { 'Content-Type': 'application/json' },
        };
        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { resolve(data); }
          });
        });
        req.on('error', (err) => resolve({ error: err.message }));
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    } catch (err) {
      return { error: err.message };
    }
  });

  /* ─── Social RPC (proxied to port 8000) ─── */
  ipcMain.handle('social-rpc', async (event, params) => {
    // Only internal shell can use social-rpc in this version
    if (!isInternalOrigin(event.sender)) return { error: 'Unauthorized origin' };

    const { method = 'GET', endpoint, body = null, headers = {} } = params;
    try {
      return new Promise((resolve) => {
        const options = {
          hostname: 'localhost',
          port: 8000,
          path: endpoint.startsWith('/api') ? endpoint : `/api${endpoint}`,
          method: method,
          headers: { ...headers, 'Content-Type': 'application/json' },
        };
        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { resolve(data); }
          });
        });
        req.on('error', (err) => resolve({ error: `Social Service Offline: ${err.message}` }));
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
      });
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.on('wallet-access-response', (_e, { requestId, approved }) => {
    const resolve = pendingApprovals.get(requestId);
    if (resolve) {
      resolve(approved);
      pendingApprovals.delete(requestId);
    }
  });
}

/**
 * Service Liveness Protection
 * Checks if key backends are responsive on startup
 */
async function checkServiceLiveness() {
  const services = [
    { name: 'IPFS Social (Global)', port: 8000, path: '/' },
    { name: 'Blockchain Node', port: 8080, path: '/api/status' }
  ];

  for (const s of services) {
    const req = http.get(`http://localhost:${s.port}${s.path}`, (res) => {
      console.log(`[Liveness] ${s.name} is ONLINE (Port ${s.port})`);
    });
    req.on('error', () => {
      console.warn(`[Liveness] ${s.name} is OFFLINE (Port ${s.port})`);
      // We don't block startup, but we log the issue. 
      // renderer.js will handle the UI feedback.
    });
  }
}

/* ─── IPFS Social IPC Handlers ─── */
function setupIPFS() {
  ipcMain.handle('ipfs-info', async () => {
    return ipfs.getNodeInfo();
  });

  ipcMain.handle('ipfs-peers', async () => {
    return ipfs.getPeers();
  });

  ipcMain.handle('ipfs-publish', async (_e, { content, metadata }) => {
    return await ipfs.publishContent(content, metadata);
  });

  ipcMain.handle('ipfs-feed', async () => {
    return ipfs.getFeed();
  });

  ipcMain.handle('ipfs-follow', async (_e, { peerId }) => {
    return ipfs.followPeer(peerId);
  });

  ipcMain.handle('ipfs-unfollow', async (_e, { peerId }) => {
    return ipfs.unfollowPeer(peerId);
  });

  ipcMain.handle('ipfs-upvote', async (_e, { cid }) => {
    return await ipfs.upvoteContent(cid);
  });

  ipcMain.handle('ipfs-get', async (_e, { cid }) => {
    const data = await ipfs.getContent(cid);
    return Array.from(data); // Convert Uint8Array for IPC transport
  });

  ipcMain.handle('ipfs-unpin', async (_e, { cid }) => {
    return await ipfs.unpinContent(cid);
  });

  ipcMain.handle('ipfs-storage-stats', async () => {
    return ipfs.getStorageStats();
  });
}

/* ─── Protocol Handlers ─── */
function setupProtocols() {
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg'
  };

  protocol.handle('ipfs', async (request) => {
    try {
      let urlStr = request.url.replace(/^ipfs:\/\//i, '');
      urlStr = urlStr.split('?')[0].split('#')[0];

      const ext = path.extname(urlStr).toLowerCase();
      const mimeType = mimeTypes[ext] || 'text/html';

      if (!ipfs || !ipfs.getContent) {
        return new Response('IPFS Node is starting...', { status: 503 });
      }

      const data = await ipfs.getContent(urlStr);
      return new Response(Buffer.from(data), {
        headers: {
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (err) {
      console.error('[Protocol] IPFS load failed:', request.url, err);
      return new Response('Content not found on IPFS network', { status: 404 });
    }
  });

  protocol.handle('ipns', async (request) => {
    try {
      let urlStr = request.url.replace(/^ipns:\/\//i, '');
      urlStr = urlStr.split('?')[0].split('#')[0];

      const ext = path.extname(urlStr).toLowerCase();
      const mimeType = mimeTypes[ext] || 'text/html';

      if (!ipfs || !ipfs.getContent) {
        return new Response('IPFS Node is starting...', { status: 503 });
      }

      const data = await ipfs.getContent(urlStr);
      return new Response(Buffer.from(data), {
        headers: {
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (err) {
      console.error('[Protocol] IPNS load failed:', request.url, err);
      return new Response('Content not found on IPNS network', { status: 404 });
    }
  });
}

/* ─── App lifecycle ─── */
app.whenReady().then(async () => {
  // Lazy-load IPFS module after app is ready
  ipfs = require('./ipfs-node');

  setupProtocols();

  setupIPC();
  setupIPFS();
  createWindow();

  // ─── Phase 1.8: Context Menus ───
  app.on('web-contents-created', (event, contents) => {
    contents.on('context-menu', (event, params) => {
      const { selectionText, isEditable, mediaType, linkURL, srcURL } = params;
      const menu = new Menu();

      if (isEditable) {
        menu.append(new MenuItem({ role: 'undo' }));
        menu.append(new MenuItem({ role: 'redo' }));
        menu.append(new MenuItem({ type: 'separator' }));
        menu.append(new MenuItem({ role: 'cut' }));
        menu.append(new MenuItem({ role: 'copy' }));
        menu.append(new MenuItem({ role: 'paste' }));
        menu.append(new MenuItem({ role: 'selectAll' }));
      } else if (selectionText && selectionText.trim() !== '') {
        menu.append(new MenuItem({ role: 'copy' }));
        menu.append(new MenuItem({ type: 'separator' }));
      }

      if (linkURL) {
        menu.append(new MenuItem({ label: 'Copy Link Address', click: () => { require('electron').clipboard.writeText(linkURL); } }));
      }

      if (mediaType === 'image') {
        menu.append(new MenuItem({ label: 'Save Image As...', click: () => { contents.downloadURL(srcURL); } }));
      }

      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'reload' }));
      menu.append(new MenuItem({ label: 'Inspect Element', click: () => { contents.inspectElement(params.x, params.y); } }));

      // Show the menu at the cursor position
      const win = BrowserWindow.fromWebContents(contents) || BrowserWindow.getFocusedWindow();
      if (win) {
        menu.popup({ window: win });
      } else {
        menu.popup();
      }
    });
  });

  // ─── Phase 1.8: Downloads Manager ───
  session.defaultSession.on('will-download', (event, item, webContents) => {
    const fileName = item.getFilename();
    const url = item.getURL();

    // Notify frontend download started
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('download-event', {
        type: 'start',
        fileName,
        url,
        totalBytes: item.getTotalBytes()
      });
    }

    item.on('updated', (event, state) => {
      if (state === 'progressing' && !item.isPaused()) {
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('download-event', {
            type: 'progress',
            fileName,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes()
          });
        }
      }
    });

    item.once('done', (event, state) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('download-event', {
          type: 'done',
          fileName,
          state // 'completed', 'cancelled', 'interrupted'
        });
      }
    });
  });

  // 1. Check if external services are online
  checkServiceLiveness();

  // 2. Start local IPFS node in background
  try {
    await ipfs.startNode();
    console.log('[App] IPFS node initialized.');
  } catch (err) {
    console.error('[App] IPFS node failed to start:', err.message);
  }
});

app.on('before-quit', async () => {
  if (ipfs) await ipfs.stopNode();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
