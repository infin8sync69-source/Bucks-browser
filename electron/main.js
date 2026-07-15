// Chromium's network location service (behind navigator.geolocation) needs a
// Google API key to resolve Wi-Fi/cell-based positions. Optional: without it
// pages fall back to coarse methods (the built-in map uses an IP fallback).
if (process.env.BUCKS_GOOGLE_GEO_KEY && !process.env.GOOGLE_API_KEY) {
  process.env.GOOGLE_API_KEY = process.env.BUCKS_GOOGLE_GEO_KEY;
}

// Prevent EPIPE errors from crashing the Electron main process (common when stdout/stderr are redirected/closed)
if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') {
      // Ignore EPIPE error
    }
  });
}
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', (err) => {
    if (err.code === 'EPIPE') {
      // Ignore EPIPE error
    }
  });
}

// Wrap console methods to catch synchronous EPIPE errors thrown during logging
const wrapConsole = (method) => {
  const original = console[method];
  if (typeof original === 'function') {
    console[method] = function(...args) {
      try {
        original.apply(console, args);
      } catch (err) {
        if (err && err.code === 'EPIPE') {
          // Ignore EPIPE (broken pipe) errors
        } else {
          throw err;
        }
      }
    };
  }
};
wrapConsole('log');
wrapConsole('error');
wrapConsole('warn');
wrapConsole('info');
wrapConsole('debug');

const { app, BrowserWindow, ipcMain, session, Menu, MenuItem, protocol, shell } = require('electron');
// app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');
const path = require('path');
// lazy load serve
let loadURL;

// Register IPFS protocols before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'bucks', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
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

  // Sanitize homepage - only allow bucks://, file://, ipfs://, ipns://, or localhost in dev
  const isValidHomepage = (url) => {
    return /^(bucks|ipfs|ipns|file):\/\//.test(url) || 
           /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url);
  };
  
  if (!isValidHomepage(settings.homepage)) {
    console.warn(`[Settings] Invalid homepage "${settings.homepage}" - resetting to default`);
    settings.homepage = 'bucks://newtab';
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
function createWindow(settings, opts = {}) {
  const isMac = process.platform === 'darwin';
  const isPrivate = !!opts.private;

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: !isMac, // Use standard frame for Mac if we want OS buttons, or false for custom
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    backgroundColor: isPrivate ? '#181024' : '#0a0f1f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  // The main (non-private) window is the canonical reference used by IPC handlers.
  if (!isPrivate) mainWindow = win;

  // Release this window's WebContentsView tabs with it. (Capture the id now —
  // the BrowserWindow is already destroyed inside its 'closed' handler.)
  const tabWinId = win.id;
  win.on('closed', () => {
    try { require('./tab-manager').destroyTabsForWindow(tabWinId); } catch (_) {}
  });

  const fallbackDevUrl = 'http://localhost:3000';
  const homepage = settings?.homepage || 'bucks://newtab';
  const isInternalHomepage = /^(bucks|ipfs|ipns|file):\/\//.test(homepage) || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(homepage);

  // Load local index.html as the Chrome shell UI.
  // Private windows pass a #private hash so the renderer runs in incognito mode
  // (in-memory webview partition, no history persistence, private badge).
  win.loadFile(path.join(__dirname, 'index.html'), isPrivate ? { hash: 'private' } : undefined).catch(err => {
    console.error('Failed to load local index.html:', err);
  });
  if (!app.isPackaged) {
    win.webContents.openDevTools();
  }

  if (!isPrivate) setupRequestFilters();

  // Prevent external window opening and route to internal tab system
  win.webContents.setWindowOpenHandler(({ url }) => {
    win.webContents.send('new-window', { url });
    return { action: 'deny' };
  });

  // Preventively block the shell frame from navigating off its allowed schemes
  // (the did-navigate handler below is reactive — it fires after load starts).
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = /^(bucks|ipfs|ipns|file):\/\//.test(url) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url) ||
      url.startsWith('data:');
    if (!allowed) {
      console.warn(`[Security] Blocked shell navigation to: ${url}`);
      event.preventDefault();
    }
  });

  // Forward renderer console logs to main terminal
  win.webContents.on('console-message', (event, level, message) => {
    try { process.stdout.write('[Renderer UI] ' + message + '\n'); } catch (e) { }
  });

  // Ensure app stays on Bucks pages only
  win.webContents.on('did-navigate', (event, url) => {
    // Block navigation to external domains unless whitelisted
    if (!url.includes('localhost') && !url.includes('127.0.0.1') && !url.startsWith('data:') &&
        !/^(bucks|ipfs|ipns|file):\/\//.test(url)) {
      console.warn(`[Security] Blocking navigation to external URL: ${url}`);
      win.webContents.goBack();
    }
  });

  return win;
}

/* ─── Request Filtering (Ad-block, HTTPS Upgrade & YouTube Embed Fix) ─── */
const COMPILED_AD_PATTERNS = AD_BLOCK_PATTERNS.map(pattern => new RegExp('^' + pattern.split('*').join('.*') + '$', 'i'));

function setupRequestFilters() {
  const sessions = [
    session.defaultSession,
    session.fromPartition('bucks-private')
  ];

  for (const sess of sessions) {
    // 1. YouTube Referrer / Origin Fix for embedding (Error 153)
    sess.webRequest.onBeforeSendHeaders(
      { urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'] },
      (details, callback) => {
        if (details.resourceType !== 'mainFrame') {
          details.requestHeaders['Referer'] = 'https://www.youtube.com/';
          details.requestHeaders['Origin'] = 'https://www.youtube.com';
        }
        callback({ requestHeaders: details.requestHeaders });
      }
    );

    // 2. HTTPS Upgrade & Ad-blocking
    sess.webRequest.onBeforeRequest(
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

  // Private (incognito) window
  ipcMain.on('open-private-window', () => {
    try {
      createWindow(loadSettings(), { private: true });
    } catch (e) {
      console.error('Failed to open private window:', e);
    }
  });

  // Downloads — open the OS downloads folder
  ipcMain.on('open-downloads-folder', () => {
    try { shell.openPath(app.getPath('downloads')); } catch (e) { console.error(e); }
  });
  ipcMain.on('show-download-in-folder', (_e, savePath) => {
    try { if (savePath) shell.showItemInFolder(savePath); } catch (e) { console.error(e); }
  });

  // Clear browsing data (cache, cookies, storage) — renderer clears its own history/bookmarks
  ipcMain.handle('clear-browsing-data', async (_e, opts = {}) => {
    try {
      await session.defaultSession.clearCache();
      const storages = ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'];
      await session.defaultSession.clearStorageData({ storages });
      return { ok: true };
    } catch (e) {
      console.error('Failed to clear browsing data:', e);
      return { ok: false, error: e.message };
    }
  });

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

  // Wallet Reset (delete stored wallets to allow creating a new one)
  ipcMain.handle('wallet-reset', async () => {
    return require('./bucks-node').resetWallets();
  });

  // ─── Phase 7: Security Hardening ───

  const ALLOWED_WALLET_METHODS = ['GET', 'POST'];
  const ALLOWED_WALLET_ENDPOINTS = [
    '/api/economy/status',
    '/api/wallets',
    '/api/wallets/create',
    '/api/wallets/restore',
    '/api/transactions/send',
    '/api/transactions/broadcast',
    '/api/wallets/mnemonic/generate',
    '/api/wallets/primary',
    '/api/blockchain/info',
    '/api/mining/mine',
    '/api/mining/start',
    '/api/mining/stop',
    '/api/mining/status',
    '/api/mining/address',
    '/api/wallets/sign'
  ];

  // Dynamic endpoints that match via prefix (for address-based routes)
  const ALLOWED_WALLET_PREFIXES = [
    '/api/address/'
  ];

  let originAllowlist = loadSettings().originAllowlist || [];

  function isInternalOrigin(sender) {
    const url = sender.getURL();
    // Trusted internal shell is allowed by default
    if (url.startsWith('file://') && (url.includes('index.html') || url.includes('bucks-browser'))) return true;
    // Allow Next.js dev server in development
    if (url.startsWith('http://localhost:3000')) return true;
    return false;
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

    // 1. Method/Endpoint Allowlist (exact match or prefix match)
    const endpointAllowed = ALLOWED_WALLET_ENDPOINTS.includes(endpoint) ||
      ALLOWED_WALLET_PREFIXES.some(p => endpoint.startsWith(p));
    if (!ALLOWED_WALLET_METHODS.includes(method) || !endpointAllowed) {
      console.error(`[ATTACK SIGNAL] Invalid Endpoint/Method: ${method} ${endpoint}`);
      return false;
    }

    // 2. Body Validation (Strict Schema)
    if (method === 'POST') {
      // Endpoints that don't require a body
      const bodyOptionalEndpoints = [
        '/api/wallets/create',
        '/api/mining/mine',
        '/api/mining/start',
        '/api/mining/stop'
      ];

      if (body && typeof body === 'object') {
        const keys = Object.keys(body);

        // Intent-specific schemas
        const schemas = {
          '/api/transactions/send': ['from', 'to', 'amount'],
          '/api/wallets/restore': ['mnemonic'],
          '/api/wallets/sign': ['address', 'message'],
          '/api/transactions/broadcast': ['rawTx'],
          '/api/mining/address': ['address']
        };

        const allowedKeys = schemas[endpoint];
        if (allowedKeys) {
          // Must contain ONLY allowed keys
          const hasExtra = keys.some(k => !allowedKeys.includes(k));
          if (hasExtra) {
            console.error(`[ATTACK SIGNAL] Unauthorized keys detected in ${endpoint}: ${keys}`);
            return false;
          }
        }
      } else if (!bodyOptionalEndpoints.includes(endpoint)) {
        console.error(`[ATTACK SIGNAL] Missing or invalid POST body for ${endpoint}`);
        return false;
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
      // Embedded Bucks Node — in-process, no localhost server needed
      return await require('./bucks-node').handleRPC(method, endpoint, body);
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

  /* ─── Web Intelligence: Fetch & Search (Agent Browser) ─── */
  const https = require('https');
  const http2 = http; // reuse existing http for http urls

  function httpGet(url, options = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
          'Accept-Language': 'en-US,en;q=0.9',
          ...options.headers
        },
        timeout: 8000
      }, (res) => {
        // Follow redirects up to 3 hops
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && (options._redirects || 0) < 3) {
          const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : `${parsed.origin}${res.headers.location}`;
          return resolve(httpGet(nextUrl, { ...options, _redirects: (options._redirects || 0) + 1 }));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { if (data.length < 500000) data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
  }

  // Strip HTML tags for clean text extraction
  function stripHtml(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // Extract meaningful text sections from HTML
  function extractPageContent(html, maxChars = 4000) {
    // Get title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // Get meta description
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) ||
                      html.match(/<meta[^>]+content=["']([^"']+)[^>]+name=["']description["']/i);
    const description = metaMatch ? metaMatch[1].trim() : '';

    // Get paragraphs and headings
    const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[0] : html;

    // Extract h1-h3 and p tags content
    const headings = [...(bodyHtml.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi))].map(m => stripHtml(m[1])).filter(t => t.length > 2).join('. ');
    const paragraphs = [...(bodyHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))].map(m => stripHtml(m[1])).filter(t => t.length > 30).join(' ');

    const content = [description, headings, paragraphs].filter(Boolean).join(' ').slice(0, maxChars);
    return { title, description, content };
  }

  // IPC: General URL fetch (text/HTML content)
  ipcMain.handle('web-fetch', async (_e, { url, maxChars }) => {
    if (!isInternalOrigin(_e.sender)) return { error: 'Unauthorized' };
    try {
      const result = await httpGet(url);
      const contentType = result.headers['content-type'] || '';
      if (contentType.includes('json')) {
        try { return { ok: true, json: JSON.parse(result.body), url }; } catch (_) {}
      }
      const { title, description, content } = extractPageContent(result.body, maxChars || 4000);
      return { ok: true, title, description, content, status: result.status, url };
    } catch (err) {
      return { ok: false, error: err.message, url };
    }
  });

  // IPC: Google search + top results fetched
  ipcMain.handle('web-search', async (_e, { query, maxResults }) => {
    if (!isInternalOrigin(_e.sender)) return { error: 'Unauthorized' };
    const results = [];
    let instant = null;
    try {
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };
      const response = await httpGet(googleUrl, { headers });
      const html = response.body;

      // 1. Extract organic search results
      const linkRegex = /<a\s+href="([^"]+)"[^>]*><h3[^>]*>([\s\S]*?)<\/h3>/gi;
      let match;
      const matches = [];
      while ((match = linkRegex.exec(html)) !== null) {
        const url = match[1];
        const title = stripHtml(match[2]).trim();
        if (url.startsWith('http') && !url.includes('google.com')) {
          matches.push({ url, title });
        }
      }

      // 2. Extract snippets for matched URLs
      for (let i = 0; i < Math.min(matches.length, maxResults || 5); i++) {
        const item = matches[i];
        let snippet = '';
        const escapedUrl = item.url.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const snippetRegex = new RegExp(`href="${escapedUrl}"[\\s\\S]*?<div[^>]+class="[^"]*(?:VwiC3b|yDJP4c|MUbB0c|s3xf6)[^"]*"[^>]*>([\\s\\S]*?)<\/div>`, 'i');
        const snippetMatch = snippetRegex.exec(html);
        if (snippetMatch) {
          snippet = stripHtml(snippetMatch[1]).trim();
        } else {
          const fallbackRegex = new RegExp(`href="${escapedUrl}"[\\s\\S]*?<(?:div|span)[^>]*class="[^"]*(?:VwiC3b|yDJP4c|MUbB0c|s3xf6|BNeawe)[^"]*"[^>]*>([\\s\\S]*?)<\/(?:div|span)>`, 'i');
          const fallbackMatch = fallbackRegex.exec(html);
          if (fallbackMatch) {
            snippet = stripHtml(fallbackMatch[1]).trim();
          }
        }
        results.push({
          title: item.title,
          snippet: snippet || 'Visit page for more details.',
          url: item.url,
          source: new URL(item.url).hostname.replace('www.', '')
        });
      }

      // 3. Try to extract a Quick Answer (Google featured snippet)
      const featuredRegex = /<div[^>]+class="[^"]*(?:hgKElc|zzzZ1e|LGOj8)[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
      const featuredMatch = featuredRegex.exec(html);
      if (featuredMatch && results.length > 0) {
        instant = {
          title: 'Google Quick Answer',
          snippet: stripHtml(featuredMatch[1]).trim(),
          url: results[0].url,
          source: 'Google'
        };
      }

      // 4. Wikipedia Fallback if < 2 results
      if (results.length < 2) {
        try {
          const wikiQuery = encodeURIComponent(query.replace(/\s+/g, '_').slice(0, 60));
          const wikiRes = await httpGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${wikiQuery}`, { headers: { Accept: 'application/json' } });
          const wiki = JSON.parse(wikiRes.body);
          if (wiki.extract && !wiki.type?.includes('disambig')) {
            results.unshift({ title: wiki.title, snippet: wiki.extract.slice(0, 400), url: wiki.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${wikiQuery}`, source: 'Wikipedia' });
          }
        } catch (_) {}
      }

      return { ok: true, query, instant, results: results.slice(0, maxResults || 5) };
    } catch (err) {
      return { ok: false, error: err.message, query, results };
    }
  });

  // IPC: Fetch a specific page and return its extracted content for agent context
  ipcMain.handle('web-fetch-summary', async (_e, { url }) => {
    if (!isInternalOrigin(_e.sender)) return { error: 'Unauthorized' };
    try {
      const result = await httpGet(url);
      const { title, description, content } = extractPageContent(result.body, 3000);
      return { ok: true, title, description, content: content.slice(0, 3000), url };
    } catch (err) {
      return { ok: false, error: err.message, url };
    }
  });
}

/**
 * Service Liveness Protection
 * Checks if key backends are responsive on startup
 */
async function checkServiceLiveness() {
  // Blockchain node is now embedded (bucks-node.js) — nothing to probe.
  // Soul Engine is optional; log its state for diagnostics.
  const services = [
    { name: 'Soul Engine (Agent AI)', port: 8765, path: '/health' }
  ];

  for (const s of services) {
    const req = http.get(`http://127.0.0.1:${s.port}${s.path}`, (res) => {
      const online = res.statusCode >= 200 && res.statusCode < 300;
      console.log(`[Liveness] ${s.name} is ${online ? 'ONLINE' : `RESPONDING (HTTP ${res.statusCode})`} (Port ${s.port})`);
      res.resume();
    });
    req.on('error', () => {
      console.warn(`[Liveness] ${s.name} is OFFLINE (Port ${s.port})`);
    });
  }
}

/* ─── IPFS Social IPC Handlers ─── */
function setupIPFS() {
  ipcMain.handle('ipfs-connect', async (_e, { multiaddr }) => {
    return await ipfs.connectPeer(multiaddr);
  });

  ipcMain.handle('ipfs-info', async () => {
    return ipfs.getNodeInfo();
  });

  ipcMain.handle('ipfs-peers', async () => {
    return ipfs.getPeers();
  });

  ipcMain.handle('ipfs-publish', async (_e, { content, metadata }) => {
    return await ipfs.publishContent(content, metadata);
  });

  ipcMain.handle('get-memory-usage', async () => {
    return process.memoryUsage();
  });

  ipcMain.on('send-telemetry', (_e, { event, data }) => {
    console.log(`[Telemetry] Event: ${event}, Data:`, data);
    try {
      const fs = require('fs');
      const path = require('path');
      const { app } = require('electron');
      const logPath = path.join(app.getPath('userData'), 'telemetry.log');
      fs.appendFileSync(logPath, JSON.stringify({ timestamp: new Date().toISOString(), event, data }) + '\n');
    } catch (e) {
      console.error('Failed to write telemetry log', e);
    }
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

  ipcMain.handle('ipfs-publish-dweb', async (_e, { name, cid, title, desc }) => {
    return await ipfs.publishDweb(name, cid, title, desc);
  });

  ipcMain.handle('ipfs-search-dweb', async (_e, { query }) => {
    return ipfs.searchDweb(query);
  });

  /* ─── P2P Encrypted Chat (Signal protocol over Gossipsub) ─── */
  const chatEngine = require('./chat-engine');
  ipcMain.handle('chat-send', (_e, { peerId, text, attachmentCid }) => chatEngine.sendMessage(peerId, text, attachmentCid || null));
  ipcMain.handle('chat-send-file', (_e, { peerId, fileData, filename }) => chatEngine.sendFile(peerId, fileData, filename));
  ipcMain.handle('chat-history', (_e, { peerId }) => chatEngine.getChatHistory(peerId));
  ipcMain.handle('chat-conversations', () => chatEngine.getConversations());
  ipcMain.handle('chat-mark-read', (_e, { peerId }) => chatEngine.markAsRead(peerId));
  ipcMain.handle('chat-own-bundle', () => chatEngine.getOwnBundle());
  ipcMain.handle('chat-process-bundle', (_e, { peerId, bundle }) => chatEngine.processPeerBundle(peerId, bundle));
  ipcMain.handle('chat-has-bundle', (_e, { peerId }) => chatEngine.hasPeerBundle(peerId));

  /* ─── File Manager state & download handlers ─── */
  ipcMain.handle('file-manager-get', async () => {
    const filePath = path.join(app.getPath('userData'), 'file-manager.json');
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      console.error('[FileManager] Failed to read file-manager.json:', e);
      return [];
    }
  });

  ipcMain.handle('file-manager-save', async (_e, data) => {
    const filePath = path.join(app.getPath('userData'), 'file-manager.json');
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      return { success: true };
    } catch (e) {
      console.error('[FileManager] Failed to write file-manager.json:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('file-manager-download', async (_e, { cid, name }) => {
    try {
      const dataArray = await ipfs.getContent(cid);
      const buffer = Buffer.from(dataArray);
      const { dialog } = require('electron');
      const { filePath } = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('downloads'), name),
        title: 'Save File from IPFS'
      });
      if (filePath) {
        fs.writeFileSync(filePath, buffer);
        return { success: true, filePath };
      }
      return { success: false, canceled: true };
    } catch (e) {
      console.error('[FileManager] Download failed:', e);
      return { success: false, error: e.message };
    }
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

  // Handle bucks:// protocol (internal app navigation)
  protocol.handle('bucks', async (request) => {
    const urlStr = request.url.replace(/^bucks:\/\//i, '').split('?')[0].split('#')[0].replace(/\/+$/, '');
    
    if (urlStr === 'newtab' || urlStr === '' || !urlStr) {
      // Redirect to home page
      if (mainWindow && mainWindow.webContents) {
        mainWindow.loadFile(path.join(__dirname, 'index.html')).catch(err => {
          console.error('[Bucks Protocol] Failed to load homepage:', err);
        });
      }
      return new Response('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"></head></html>', {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    if (urlStr === 'studio' || urlStr === 'dweb-studio') {
      const fs = require('fs');
      try {
        const filePath = path.join(__dirname, 'dweb-studio.html');
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath);
          return new Response(content, {
            headers: { 'Content-Type': 'text/html' }
          });
        }
      } catch (err) {
        console.error('[Bucks Protocol] Failed to load studio:', err);
      }
    }
    
    // Check if the requested urlStr corresponds to a file in __dirname
    const fileBasename = path.basename(urlStr);
    const ext = path.extname(fileBasename).toLowerCase();
    if (ext && mimeTypes[ext]) {
      const fs = require('fs');
      const filePath = path.join(__dirname, fileBasename);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath);
          return new Response(content, {
            headers: {
              'Content-Type': mimeTypes[ext] + '; charset=utf-8',
              'Access-Control-Allow-Origin': '*'
            }
          });
        } catch (err) {
          console.error(`[Bucks Protocol] Failed to load resource ${fileBasename}:`, err);
        }
      }
    }
    
    // Built-in mini apps
    const miniApps = { 
      calc: 'bucks-calc.html', 
      notes: 'bucks-notes.html', 
      clock: 'bucks-clock.html', 
      converter: 'bucks-converter.html', 
      qr: 'bucks-qr.html', 
      universe: 'bucks-universe.html',
      studio: 'dweb-studio.html',
      portfolio: 'bucks-template-portfolio.html',
      dashboard: 'bucks-template-dashboard.html',
      store: 'bucks-template-store.html',
      blog: 'bucks-template-blog.html',
      landing: 'bucks-template-landing.html'
    };
    console.log('[Bucks Protocol] route:', urlStr);
    const appFile = miniApps[urlStr];
    if (appFile) {
      try {
        const filePath = path.join(__dirname, appFile);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath);
          return new Response(content, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
      } catch (err) {
        console.error('[Bucks Protocol] Failed to load mini app:', err);
      }
    }

    // Other bucks:// routes
    return new Response(`<!DOCTYPE html><html><body>Bucks: ${urlStr}</body></html>`, {
      headers: { 'Content-Type': 'text/html' }
    });
  });

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

let ipfsServerProcess = null;

// Is something already listening on a local TCP port? Resolves quickly so we
// can skip spawning a helper that would just crash with EADDRINUSE.
function _portInUse(port) {
  return new Promise((resolve) => {
    const socket = require('net').connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

async function startIpfsServer() {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const serverPath = path.join(__dirname, '../ipfs/server.js');
  // Skip if the file-manager proxy is already up (a prior run or a standalone
  // cluster stack) — spawning a second one would EADDRINUSE-crash on :3939.
  if (await _portInUse(3939)) {
    console.log('[App] IPFS proxy server already running on :3939 — reusing it.');
    return;
  }
  if (fs.existsSync(serverPath)) {
    console.log('[App] Starting IPFS proxy server...');
    ipfsServerProcess = spawn('node', [serverPath], {
      cwd: path.join(__dirname, '../ipfs'),
      env: { ...process.env, PORT: '3939' }
    });
    ipfsServerProcess.stdout.on('data', (data) => {
      console.log(`[IPFS Server] ${data.toString().trim()}`);
    });
    ipfsServerProcess.stderr.on('data', (data) => {
      console.error(`[IPFS Server Error] ${data.toString().trim()}`);
    });
    ipfsServerProcess.on('close', (code) => {
      console.log(`[IPFS Server] closed with code ${code}`);
    });
  } else {
    console.error(`[App] IPFS server not found at ${serverPath}`);
  }
}

/* ─── App lifecycle ─── */
app.whenReady().then(async () => {
  // Lazy-load IPFS module after app is ready
  ipfs = require('./ipfs-node');
  const agentSwarm = require('./agent-swarm');
  const soulBridge = require('./ipfs-agent-soul');
  const nexusBridge = require('./nexus-ipc-bridge');
  // ── Soul Engine supervisor: Electron owns the local-AI lifecycle now ──
  const soulEngine = require('./soul-engine-supervisor');
  const ephemeralCommandCenter = require('./ephemeral-window');

  const settings = loadSettings();

  // Embedded blockchain node (wallets, mining, txs) — works offline,
  // syncs with peers once gossip attaches below.
  const bucksNode = require('./bucks-node');
  try {
    bucksNode.init({ dataDir: path.join(app.getPath('userData'), 'bucks-chain') });
  } catch (e) {
    console.error('[App] Bucks node failed to init:', e.message);
  }

  setupProtocols();

  setupIPC();
  // Tab hosting: WebContentsView-backed tabs (see tab-manager.js).
  require('./tab-manager').setupTabIPC();
  // Web permissions (geolocation, camera/mic, notifications, …) + Bluetooth.
  require('./permission-manager').setupPermissions();
  setupIPFS();
  startIpfsServer();
  createWindow(settings);

  ephemeralCommandCenter.createEphemeralWindow(mainWindow);
  ephemeralCommandCenter.setupEphemeralShortcuts();
  ephemeralCommandCenter.setupEphemeralIPC(mainWindow);

  app.on('will-quit', () => {
    ephemeralCommandCenter.cleanupEphemeralShortcuts();
  });

  // Register NEXUS bridge now that mainWindow exists
  nexusBridge.register(mainWindow, agentSwarm);

  // Bring the local AI up as part of core startup. Pushes status to the
  // renderer so the agent UI can show "warming up / ready / unavailable"
  // instead of the old silent "/health OFFLINE" failure.
  soulEngine.start((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('soul-engine-status', status);
    }
  }).catch((e) => console.error('[App] Soul Engine supervisor error:', e.message));
  ipcMain.handle('soul-engine-status', () => soulEngine.getStatus());

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
          state, // 'completed', 'cancelled', 'interrupted'
          savePath: item.getSavePath(),
          totalBytes: item.getTotalBytes()
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

    // 3. Start agent swarm layer (multi-browser coordination)
    const heliaNode = ipfs.getHeliaNode();
    const gossip    = ipfs.getGossip();
    if (heliaNode && gossip) {
      // Attach blockchain sync to the swarm mesh
      try {
        bucksNode.attachGossip(gossip);
      } catch (err) {
        console.error('[App] Bucks node gossip attach failed:', err.message);
      }
      // Swarm delegation targets an agent server on :3000 the app does not
      // start, and its gossip messages are unsigned (spoofable nodeId, forgeable
      // results, ballot-stuffable consensus). It stays OFF unless explicitly
      // enabled, so a future contributor can't silently ship the un-audited path.
      if (process.env.BUCKS_EXPERIMENTAL_SWARM === '1') {
        try {
          await agentSwarm.start(heliaNode, gossip);
          console.log('[App] Agent swarm layer started (EXPERIMENTAL — unsigned, unaudited).');
        } catch (err) {
          console.error('[App] Agent swarm failed to start:', err.message);
        }
      } else {
        console.log('[App] Agent swarm disabled (set BUCKS_EXPERIMENTAL_SWARM=1 to enable).');
      }

      // 4. Start soul bridge (advertise own soul, handle peer souls)
      try {
        await soulBridge.start(3000); // 3 s grace period for agent server
        console.log('[App] Soul bridge started.');
      } catch (err) {
        console.error('[App] Soul bridge failed to start:', err.message);
      }

      // 4b. Start IPFS content bridge: Kubo-compatible HTTP API over the
      // Helia node for the Python agent, plus Helia↔Kubo peering when a
      // local daemon is running (see ipfs-bridge.js).
      try {
        await require('./ipfs-bridge').start(ipfs);
        console.log('[App] IPFS content bridge started.');
      } catch (err) {
        console.error('[App] IPFS content bridge failed to start:', err.message);
      }

      // 5. Start E2E-encrypted P2P chat engine (Signal over gossipsub)
      try {
        const chatEngine = require('./chat-engine');
        await chatEngine.initChat(heliaNode, gossip, ipfs.getFsModule());
        chatEngine.setOnMessageCallback((payload) => {
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('chat-message', payload);
          }
        });
        console.log('[App] Chat engine started.');
      } catch (err) {
        console.error('[App] Chat engine failed to start:', err.message);
      }

      // 6. Check for updates and notify (electron-updater boilerplate)
      try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.checkForUpdatesAndNotify();
        console.log('[App] Auto-updater check initiated.');
      } catch (err) {
        console.error('[App] Auto-updater failed to initialize:', err.message);
      }
    }
  } catch (err) {
    console.error('[App] IPFS node failed to start:', err.message);
  }
});

app.on('before-quit', async () => {
  if (ipfsServerProcess) {
    try {
      ipfsServerProcess.kill();
      console.log('[App] IPFS proxy server stopped.');
    } catch (e) {
      console.error('[App] Failed to kill IPFS proxy server:', e);
    }
  }
  try { require('./soul-engine-supervisor').stop(); } catch (_) {}
  try { require('./agent-swarm').stop(); } catch (_) {}
  try { require('./ipfs-agent-soul').stop(); } catch (_) {}
  try { require('./ipfs-bridge').stop(); } catch (_) {}
  try { require('./bucks-node').stop(); } catch (_) {}
  if (ipfs) await ipfs.stopNode();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
