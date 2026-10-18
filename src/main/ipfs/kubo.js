// Kubo sidecar supervisor: locate/download the binary, init + configure the repo, spawn the
// daemon, wait for its API, watch for crashes, and expose a status machine to the rest of
// the app. Pure Node (no Electron imports) so it can run under `node --test`; the only
// Electron touch-point is the optional getMainWindow() callback used to push status events.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { KuboRpc } from './rpc.js';
import { downloadKubo, latestStableVersion, FALLBACK_KUBO_VERSION, kuboBinaryName, builderOsName } from './dist.js';
import { toGatewayUrl } from './cid.js';
import { createLogger } from '../log.js';

const API_WAIT_TIMEOUT_MS = 60_000;
const API_POLL_INTERVAL_MS = 500;
const RESTART_BACKOFF_MS = [2000, 5000, 15_000];
const MAX_RESTARTS = RESTART_BACKOFF_MS.length;
const STABLE_RESET_MS = 120_000;
const EXTERNAL_HEALTH_INTERVAL_MS = 30_000;
const KUBO_LOG_MAX_BYTES = 5 * 1024 * 1024;
const OUTPUT_TAIL_LINES = 40;
const DEFAULT_PUBLIC_GATEWAY = 'https://ipfs.io';
const DEFAULT_EXTERNAL_API = 'http://127.0.0.1:5001';
const DEFAULT_SWARM_ADDRS = ['/ip4/0.0.0.0/tcp/4001', '/ip6/::/tcp/4001', '/ip4/0.0.0.0/udp/4001/quic-v1', '/ip6/::/udp/4001/quic-v1'];

/* ───────────────────────────── pure helpers (unit-tested) ───────────────────────────── */

/**
 * Convert a Kubo listen multiaddr (/ip4/127.0.0.1/tcp/8080, /ip6/::1/tcp/8080,
 * /dns4/localhost/tcp/8080) into an HTTP base URL. Plain http(s) URLs pass through.
 * @param {string} addr
 * @returns {string} e.g. http://127.0.0.1:8080
 */
export function multiaddrToHttpUrl(addr) {
  const s = String(addr || '').trim();
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  const parts = s.replace(/^\/+/, '').split('/');
  if (parts.length < 4) throw new Error(`Unsupported multiaddr '${s}'`);
  const [proto, hostRaw, transport, port] = parts;
  let host;
  switch (proto) {
    case 'ip4':
    case 'dns':
    case 'dns4':
    case 'dns6':
    case 'dnsaddr':
      host = hostRaw === '0.0.0.0' ? '127.0.0.1' : hostRaw;
      break;
    case 'ip6':
      host = hostRaw === '::' ? '[::1]' : `[${hostRaw}]`;
      break;
    default:
      throw new Error(`Unsupported address protocol '${proto}' in '${s}'`);
  }
  if (transport !== 'tcp' || !/^\d+$/.test(port || '')) throw new Error(`Unsupported transport in multiaddr '${s}'`);
  const scheme = parts.slice(4).includes('https') || parts.slice(4).includes('tls') ? 'https' : 'http';
  return `${scheme}://${host}:${port}`;
}

/**
 * Apply Bucks' port assignments to a Kubo config object (idempotent, returns a copy).
 * API and Gateway are bound to loopback on the reserved ports; every Swarm listen address
 * keeps its transport but moves to the reserved swarm port so the embedded node never
 * fights a user's own Kubo over 4001. Everything else (profile, datastore, …) is untouched.
 * @param {object} config  parsed <repo>/config
 * @param {{ apiPort: number, gatewayPort: number, swarmPort?: number }} ports
 */
export function applyBucksConfig(config, { apiPort, gatewayPort, swarmPort }) {
  const out = structuredClone(config || {});
  out.Addresses = { ...(out.Addresses || {}) };
  out.Addresses.API = `/ip4/127.0.0.1/tcp/${apiPort}`;
  out.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${gatewayPort}`;
  if (Number.isInteger(swarmPort)) {
    const swarm = Array.isArray(out.Addresses.Swarm) && out.Addresses.Swarm.length ? out.Addresses.Swarm : DEFAULT_SWARM_ADDRS;
    out.Addresses.Swarm = [...new Set(swarm.map((a) => String(a).replace(/\/(tcp|udp)\/\d+/, `/$1/${swarmPort}`)))];
  }
  return out;
}

/**
 * Candidate locations for the Kubo binary, in lookup order.
 * @param {{ env?: object, resourcesDir: string, userData: string, platform?: string, arch?: string }} opts
 * @returns {string[]}
 */
export function candidateBinaryPaths({ env = process.env, resourcesDir, userData, platform = process.platform, arch = process.arch }) {
  const bin = kuboBinaryName(platform);
  const out = [];
  if (env.BUCKS_KUBO_BIN) out.push(env.BUCKS_KUBO_BIN);
  if (resourcesDir) {
    out.push(path.join(resourcesDir, 'kubo', bin)); // packaged layout (extraResources → resources/kubo/)
    try {
      out.push(path.join(resourcesDir, 'kubo', `${builderOsName(platform)}-${arch}`, bin)); // dev layout
    } catch { /* unsupported platform: skip the dev layout */ }
  }
  out.push(path.join(userData, 'kubo', 'bin', bin));
  return out;
}

/** True when a Kubo error output indicates the repo is locked by another process. */
export function isLockError(text) {
  return /repo\.lock|someone else has the lock|daemon is running|resource temporarily unavailable|lock .*already/i.test(String(text || ''));
}

/** Normalise a public gateway setting (strip trailing slashes and any /ipfs suffix). */
export function normalizeGatewayBase(url) {
  const s = String(url || '').trim() || DEFAULT_PUBLIC_GATEWAY;
  return s.replace(/\/+$/, '').replace(/\/(ipfs|ipns)$/, '');
}

/* ───────────────────────────── small node utilities ───────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** Append-only log with a single rotation at `maxBytes` (kubo.log → kubo.log.1). */
class RotatingLog {
  constructor(file, maxBytes = KUBO_LOG_MAX_BYTES) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.size = 0;
    this.stream = null;
  }

  open() {
    if (this.stream) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; }
      if (this.size > this.maxBytes) this.rotateFiles();
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', () => {});
    } catch {
      this.stream = null; // logging is best-effort
    }
  }

  rotateFiles() {
    try { fs.rmSync(`${this.file}.1`, { force: true }); } catch { /* ignore */ }
    try { fs.renameSync(this.file, `${this.file}.1`); } catch { /* ignore */ }
    this.size = 0;
  }

  write(chunk) {
    if (!this.stream) return;
    if (this.size + chunk.length > this.maxBytes) {
      this.stream.end();
      this.rotateFiles();
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', () => {});
    }
    this.stream.write(chunk);
    this.size += chunk.length;
  }

  close() {
    this.stream?.end();
    this.stream = null;
  }
}

/* ───────────────────────────── the supervisor ───────────────────────────── */

/**
 * Create the Kubo runtime supervisor.
 * @param {{
 *   settings: { get: () => any, onChange?: (cb: Function) => Function },
 *   userData: string,
 *   resourcesDir: string,
 *   getMainWindow?: () => any,
 *   log?: { info: Function, warn: Function, error: Function, debug?: Function }
 * }} opts
 */
export function createKubo({ settings, userData, resourcesDir, getMainWindow = () => null, log = createLogger('kubo') }) {
  const kuboDir = path.join(userData, 'kubo');
  const repoDir = path.join(kuboDir, 'repo');
  const binDir = path.join(kuboDir, 'bin');
  const runtimeFile = path.join(kuboDir, 'runtime.json');
  const logFile = path.join(userData, 'logs', 'kubo.log');

  const listeners = new Set();
  let status = {
    state: 'idle',
    source: 'embedded_kubo',
    message: 'IPFS node has not been started.',
    api_url: null,
    gateway_url: null,
    embedded: true,
    version: null,
    peer_id: null,
  };

  /** @type {KuboRpc|null} */
  let rpc = null;
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let binaryPath = null;
  let startPromise = null;
  let stopPromise = null;
  let stopRequested = false;
  let restartAttempts = 0;
  let restartTimer = null;
  let stableTimer = null;
  let healthTimer = null;
  let outputTail = [];
  const kuboLog = new RotatingLog(logFile);

  /* ---------- status ---------- */

  function setStatus(patch) {
    status = { ...status, ...patch };
    const snapshot = { ...status };
    log.debug?.(`status → ${snapshot.state}: ${snapshot.message}`);
    for (const cb of listeners) {
      try { cb(snapshot); } catch (e) { log.error('status listener failed:', e); }
    }
    try {
      const win = getMainWindow?.();
      if (win && !win.isDestroyed?.() && win.webContents && !win.webContents.isDestroyed?.()) {
        win.webContents.send('bucks:ipfs:status', snapshot);
      }
    } catch (e) {
      log.warn('could not push IPFS status to window:', e.message);
    }
  }

  function initializing(message, extra = {}) {
    setStatus({ state: 'initializing', message, api_url: null, gateway_url: null, version: null, peer_id: null, ...extra });
  }

  const OFFLINE = { api_url: null, gateway_url: null, version: null, peer_id: null };

  function ipfsSettings() {
    const s = settings.get?.() || {};
    return { ...(s.ipfs || {}) };
  }

  /* ---------- runtime.json (reserved ports, installed version) ---------- */

  async function loadRuntime() {
    try {
      const j = JSON.parse(await fsp.readFile(runtimeFile, 'utf8'));
      const port = (v) => (Number.isInteger(v) && v > 0 && v < 65536 ? v : null);
      return {
        apiPort: port(j.apiPort),
        gatewayPort: port(j.gatewayPort),
        swarmPort: port(j.swarmPort),
        version: typeof j.version === 'string' ? j.version : null,
      };
    } catch {
      return { apiPort: null, gatewayPort: null, swarmPort: null, version: null };
    }
  }

  async function saveRuntime(rt) {
    await fsp.mkdir(kuboDir, { recursive: true });
    const tmp = `${runtimeFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(rt, null, 2));
    await fsp.rename(tmp, runtimeFile);
  }

  /** Make sure every reserved port is set, distinct and currently free; re-reserve the ones that are not. */
  async function ensurePorts(rt) {
    let changed = false;
    const taken = new Set();
    for (const key of ['apiPort', 'gatewayPort', 'swarmPort']) {
      if (!rt[key] || taken.has(rt[key]) || !(await isPortFree(rt[key]))) {
        let fresh;
        do { fresh = await reservePort(); } while (taken.has(fresh));
        if (rt[key]) log.warn(`${key} ${rt[key]} is busy, re-reserved ${fresh}`);
        rt[key] = fresh;
        changed = true;
      }
      taken.add(rt[key]);
    }
    if (changed) await saveRuntime(rt);
    return rt;
  }

  /* ---------- binary ---------- */

  async function locateBinary() {
    for (const p of candidateBinaryPaths({ resourcesDir, userData })) {
      try {
        const st = await fsp.stat(p);
        if (st.isFile()) return p;
      } catch { /* next */ }
    }
    initializing('Downloading IPFS node…');
    let version;
    try {
      version = await latestStableVersion();
    } catch (e) {
      log.warn(`Could not determine latest Kubo version (${e.message}); using ${FALLBACK_KUBO_VERSION}`);
      version = FALLBACK_KUBO_VERSION;
    }
    let lastPct = -1;
    let installed;
    try {
      installed = await downloadKubo({
        version,
        destDir: binDir,
        log,
        onProgress: (received, total) => {
          if (!total) return;
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
            lastPct = pct;
            initializing(`Downloading IPFS node… ${pct}%`);
          }
        },
      });
    } catch (e) {
      throw new Error(`Could not download the IPFS node (Kubo ${version}): ${e.message}. Check your network connection, or place a Kubo binary at ${path.join(binDir, kuboBinaryName())} (or set BUCKS_KUBO_BIN).`);
    }
    const rt = await loadRuntime();
    await saveRuntime({ ...rt, version });
    return installed;
  }

  function runIpfs(args, { timeoutMs = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        binaryPath,
        args,
        { env: { ...process.env, IPFS_PATH: repoDir }, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = `${String(stderr || '').trim()} ${String(stdout || '').trim()}`.trim();
            const e = new Error(`ipfs ${args.join(' ')} failed: ${detail || err.message}`);
            e.output = detail;
            reject(e);
          } else resolve(String(stdout));
        },
      );
    });
  }

  /* ---------- repo ---------- */

  async function ensureRepo() {
    if (fs.existsSync(path.join(repoDir, 'config'))) return;
    initializing('Initializing IPFS repository…');
    await fsp.mkdir(repoDir, { recursive: true });
    await runIpfs(['init', '--profile=lowpower', '--empty-repo=true']);
  }

  async function patchConfig(rt) {
    const file = path.join(repoDir, 'config');
    let current;
    try {
      current = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
      throw new Error(`The IPFS repository config at ${file} is unreadable (${e.message}). Delete the ${repoDir} folder to start over.`);
    }
    const next = applyBucksConfig(current, rt);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    const tmp = `${file}.bucks.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
    await fsp.rename(tmp, file);
  }

  async function readRepoAddrFile(name) {
    try {
      const txt = (await fsp.readFile(path.join(repoDir, name), 'utf8')).trim();
      return txt ? multiaddrToHttpUrl(txt) : null;
    } catch {
      return null;
    }
  }

  async function clearStaleLock() {
    for (const f of ['repo.lock', 'api', 'gateway']) {
      await fsp.rm(path.join(repoDir, f), { force: true }).catch(() => {});
    }
  }

  async function apiAnswers(apiUrl) {
    try {
      await new KuboRpc(apiUrl, { timeoutMs: 2000 }).id();
      return true;
    } catch {
      return false;
    }
  }

  /** Reuse a daemon left running by a previous app instance (its API file still points at a live port). */
  async function tryAdopt(rt) {
    const apiUrl = await readRepoAddrFile('api');
    if (!apiUrl || !(await apiAnswers(apiUrl))) return false;
    const gatewayUrl = (await readRepoAddrFile('gateway')) || (rt.gatewayPort ? `http://127.0.0.1:${rt.gatewayPort}` : null);
    if (!gatewayUrl) return false;
    log.info(`Adopting already-running IPFS daemon at ${apiUrl}`);
    child = null;
    await becomeReady({ apiUrl, gatewayUrl, embedded: true, source: 'embedded_kubo', message: 'Embedded IPFS node is ready (reused running daemon).' });
    return true;
  }

  /* ---------- daemon ---------- */

  function spawnDaemon() {
    const proc = spawn(binaryPath, ['daemon', '--migrate=true', '--enable-gc'], {
      env: { ...process.env, IPFS_PATH: repoDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });
    outputTail = [];
    const onData = (chunk) => {
      kuboLog.write(chunk);
      const lines = chunk.toString('utf8').split('\n').filter((l) => l.trim());
      outputTail = outputTail.concat(lines).slice(-OUTPUT_TAIL_LINES);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => {
      log.error('ipfs daemon spawn error:', e.message);
      outputTail.push(`spawn error: ${e.message}`);
    });
    // Last resort: never leave an orphan daemon behind when the host process exits.
    const onHostExit = () => {
      if (!childExited(proc)) {
        try { process.platform === 'win32' ? forceKill(proc) : proc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    };
    process.once('exit', onHostExit);
    proc.on('exit', (code, signal) => {
      process.off('exit', onHostExit);
      onChildExit(proc, code, signal);
    });
    log.info(`ipfs daemon started (pid ${proc.pid}), repo ${repoDir}`);
    return proc;
  }

  function childExited(proc) {
    return proc.exitCode !== null || proc.signalCode !== null;
  }

  async function waitForApi(proc, apiUrl) {
    initializing('Waiting for the IPFS API…');
    const probe = new KuboRpc(apiUrl, { timeoutMs: 2000 });
    const deadline = Date.now() + API_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (stopRequested) throw new Error('IPFS start cancelled');
      if (childExited(proc)) {
        const e = new Error(`IPFS daemon exited (code ${proc.exitCode ?? proc.signalCode}) before its API came up: ${outputTail.slice(-5).join(' | ') || 'no output'}`);
        e.output = outputTail.join('\n');
        throw e;
      }
      try {
        await probe.id();
        return;
      } catch { /* not yet */ }
      await sleep(API_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out after ${API_WAIT_TIMEOUT_MS / 1000}s waiting for the IPFS API at ${apiUrl}`);
  }

  async function becomeReady({ apiUrl, gatewayUrl, embedded, source, message }) {
    const client = new KuboRpc(apiUrl);
    const [ver, ident] = await Promise.all([client.version(), client.id()]);
    rpc = client;
    clearRestartTimer();
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => { restartAttempts = 0; }, STABLE_RESET_MS);
    stableTimer.unref?.();
    setStatus({
      state: 'ready',
      source,
      message,
      api_url: apiUrl,
      gateway_url: gatewayUrl,
      embedded,
      version: ver?.Version || null,
      peer_id: ident?.ID || null,
    });
    if (!embedded) startExternalHealthCheck(client);
  }

  function clearRestartTimer() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  }

  function clearHealthTimer() {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  /** Node went away while ready: enter 'error' and schedule a restart with backoff (3 attempts). */
  function scheduleRestart(reason) {
    rpc = null;
    clearTimeout(stableTimer);
    clearHealthTimer();
    if (restartAttempts >= MAX_RESTARTS) {
      setStatus({ state: 'error', message: `${reason}; gave up after ${MAX_RESTARTS} restarts. Start it again from bucks://ipfs.`, ...OFFLINE });
      return;
    }
    const delay = RESTART_BACKOFF_MS[restartAttempts];
    restartAttempts += 1;
    setStatus({ state: 'error', message: `${reason}; restarting in ${delay / 1000}s (attempt ${restartAttempts}/${MAX_RESTARTS}).`, ...OFFLINE });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      kubo.start().catch((e) => log.error('IPFS auto-restart failed:', e.message));
    }, delay);
    restartTimer.unref?.();
  }

  function onChildExit(proc, code, signal) {
    if (proc !== child) return; // a process we already replaced
    child = null;
    log.warn(`ipfs daemon exited (code ${code}, signal ${signal})`);
    if (stopRequested || status.state === 'stopped') return; // stop() handles state
    if (status.state !== 'ready') return; // the start() wait loop reports this
    const tail = outputTail.slice(-3).join(' | ');
    scheduleRestart(`IPFS daemon exited unexpectedly (code ${code ?? signal})${tail ? `: ${tail}` : ''}`);
  }

  function startExternalHealthCheck(client) {
    clearHealthTimer();
    healthTimer = setInterval(async () => {
      if (rpc !== client || status.state !== 'ready') { clearHealthTimer(); return; }
      if (await apiAnswers(client.apiUrl)) return;
      if (rpc !== client || status.state !== 'ready') return;
      log.warn(`external IPFS node at ${client.apiUrl} stopped answering`);
      scheduleRestart(`Lost the connection to the IPFS node at ${client.apiUrl}`);
    }, EXTERNAL_HEALTH_INTERVAL_MS);
    healthTimer.unref?.();
  }

  async function startEmbedded() {
    initializing('Locating IPFS binary…', { source: 'embedded_kubo', embedded: true });
    binaryPath = await locateBinary();
    log.info(`Using Kubo binary ${binaryPath}`);
    kuboLog.open();

    const rt = await loadRuntime();
    if (await tryAdopt(rt)) return;

    await ensurePorts(rt);
    await ensureRepo();
    await patchConfig(rt);
    const apiUrl = `http://127.0.0.1:${rt.apiPort}`;
    const gatewayUrl = `http://127.0.0.1:${rt.gatewayPort}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      initializing('Starting IPFS daemon…');
      child = spawnDaemon();
      try {
        await waitForApi(child, apiUrl);
        break;
      } catch (e) {
        const proc = child;
        child = null;
        await killChild(proc);
        if (attempt === 0 && isLockError(e.output || e.message) && !(await apiAnswers(apiUrl))) {
          log.warn('Stale repo.lock detected; clearing it and retrying once');
          await clearStaleLock();
          continue;
        }
        throw e;
      }
    }
    await becomeReady({ apiUrl, gatewayUrl, embedded: true, source: 'embedded_kubo', message: 'Embedded IPFS node is ready.' });
  }

  async function startExternal(cfg) {
    const apiUrl = String(cfg.externalApiUrl || process.env.BUCKS_IPFS_API_URL || DEFAULT_EXTERNAL_API).trim().replace(/\/+$/, '');
    initializing(`Connecting to IPFS node at ${apiUrl}…`, { source: 'external_api', embedded: false });
    const client = new KuboRpc(apiUrl, { timeoutMs: 10_000 });
    await client.version();
    let gatewayUrl;
    try {
      let addr = await client.configGet('Addresses.Gateway');
      if (Array.isArray(addr)) addr = addr[0];
      gatewayUrl = multiaddrToHttpUrl(addr);
    } catch (e) {
      const host = new URL(apiUrl).hostname;
      gatewayUrl = `http://${host.includes(':') ? `[${host}]` : host}:8080`;
      log.warn(`Could not read Addresses.Gateway from the external node (${e.message}); assuming ${gatewayUrl}`);
    }
    await becomeReady({ apiUrl, gatewayUrl, embedded: false, source: 'external_api', message: `Connected to external IPFS node at ${apiUrl}.` });
  }

  /* ---------- stopping ---------- */

  function waitForExit(proc, ms) {
    return new Promise((resolve) => {
      if (childExited(proc)) return resolve(true);
      const t = setTimeout(() => { proc.off('exit', done); resolve(false); }, ms);
      const done = () => { clearTimeout(t); resolve(true); };
      proc.once('exit', done);
    });
  }

  function forceKill(proc) {
    if (!proc.pid || childExited(proc)) return;
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
    } else {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

  async function killChild(proc, { graceMs = 5000 } = {}) {
    if (!proc || childExited(proc)) return;
    if (process.platform === 'win32') {
      forceKill(proc); // no SIGTERM semantics on Windows; taskkill /T /F takes the tree down
    } else {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    if (!(await waitForExit(proc, graceMs))) {
      forceKill(proc);
      await waitForExit(proc, 2000);
    }
  }

  async function doStop() {
    stopRequested = true;
    clearRestartTimer();
    clearHealthTimer();
    clearTimeout(stableTimer);
    if (startPromise) await startPromise.catch(() => {});

    const proc = child;
    const client = rpc;
    const embedded = status.embedded;
    rpc = null;

    if (embedded && client) {
      try { await client.shutdown({ timeoutMs: 3000 }); } catch (e) { log.debug?.(`rpc shutdown: ${e.message}`); }
      if (proc) await waitForExit(proc, 3000);
      else {
        // adopted daemon: wait until its API stops answering
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && (await apiAnswers(client.apiUrl))) await sleep(250);
      }
    }
    if (proc) await killChild(proc);
    child = null;
    kuboLog.close();
    setStatus({
      state: 'stopped',
      message: embedded ? 'IPFS node stopped.' : 'Disconnected from the external IPFS node.',
      ...OFFLINE,
    });
  }

  /* ---------- public object ---------- */

  const kubo = {
    /** Start (or re-attach to) the node. Idempotent; concurrent calls share one in-flight promise. */
    start() {
      if (startPromise) return startPromise;
      if (status.state === 'ready' && rpc) return Promise.resolve({ ...status });
      clearRestartTimer();
      startPromise = (async () => {
        if (stopPromise) await stopPromise.catch(() => {});
        stopRequested = false;
        const cfg = ipfsSettings();
        try {
          if (cfg.mode === 'external') await startExternal(cfg);
          else await startEmbedded();
        } catch (e) {
          rpc = null;
          if (stopRequested) {
            setStatus({ state: 'stopped', message: 'IPFS node stopped.', ...OFFLINE });
          } else {
            log.error('IPFS start failed:', e.message);
            setStatus({ state: 'error', message: e.message || String(e), ...OFFLINE });
          }
          throw e;
        }
        return { ...status };
      })().finally(() => { startPromise = null; });
      return startPromise;
    },

    /** Stop the node: rpc shutdown (3 s) → SIGTERM → SIGKILL after 5 s. Resolves to the final status. */
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = doStop()
        .then(() => ({ ...status }))
        .finally(() => { stopPromise = null; });
      return stopPromise;
    },

    /** stop() followed by a fresh start() with the crash counter reset. */
    async restart() {
      await kubo.stop();
      restartAttempts = 0;
      return kubo.start();
    },

    /** Snapshot of the current IpfsStatus (see docs/IPC-CONTRACT.md). */
    status: () => ({ ...status }),

    /** Subscribe to status changes; returns an unsubscribe function. */
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    apiUrl: () => status.api_url,
    gatewayUrl: () => status.gateway_url,
    /** The live RPC client while the node is ready, else null. */
    get rpc() { return rpc; },
    isReady: () => status.state === 'ready' && rpc !== null,

    /** Pid of the spawned daemon (null when not running or when an existing daemon was adopted). */
    pid: () => (child && !childExited(child) ? child.pid : null),

    /** Path of the repo (useful for diagnostics). */
    repoPath: () => repoDir,

    /**
     * Map an ipfs:// or ipns:// URL to an HTTP gateway URL: the local gateway when the node is
     * ready (and the user prefers local), else settings.ipfs.publicGateway. Other URLs pass through.
     */
    gatewayUrlFor(url) {
      const cfg = ipfsSettings();
      const pub = normalizeGatewayBase(cfg.publicGateway);
      const useLocal = kubo.isReady() && status.gateway_url && cfg.preferredGateway !== 'public';
      const base = useLocal ? status.gateway_url : pub;
      return toGatewayUrl(String(url || '').trim(), base) ?? url;
    },
  };

  // Restart when the node configuration changes (mode or external API URL).
  let lastCfg = ipfsSettings();
  if (typeof settings.onChange === 'function') {
    settings.onChange((all) => {
      const cfg = { ...(all?.ipfs || {}) };
      const changed = cfg.mode !== lastCfg.mode || (cfg.externalApiUrl || '') !== (lastCfg.externalApiUrl || '');
      lastCfg = cfg;
      if (!changed) return;
      if (status.state === 'idle' || status.state === 'stopped') return; // not running: nothing to restart
      log.info('IPFS settings changed; restarting node');
      kubo.restart().catch((e) => log.error('IPFS restart failed:', e.message));
    });
  }

  return kubo;
}
