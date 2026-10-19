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
import { downloadKubo, PINNED_KUBO_VERSION, pinnedSha512, kuboBinaryName, builderOsName } from './dist.js';
import { toGatewayUrl, isPeerId } from './cid.js';
import { bases } from 'multiformats/basics';
import * as Digest from 'multiformats/hashes/digest';
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
/** Connection limits for a node that hosts sites (the lowpower profile's 20/40 starve a host). */
export const HOSTING_CONN_MGR = Object.freeze({ LowWater: 50, HighWater: 150 });
export const DEFAULT_STORAGE_MAX_GB = 10;

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

/* ---------- multiaddr / peer validation (Peering.Peers must never break daemon start-up) ---------- */

// Kubo refuses to start when its config holds a multiaddr it cannot parse, so peering addresses
// coming from settings are validated against the protocols a Bucks peer can realistically use.
// Value kinds: null = no value, 'ip4' | 'ip6' | 'host' | 'port' | 'uint8' | 'str' | 'certhash' | 'peer'.
const MULTIADDR_PROTOCOLS = {
  ip4: 'ip4', ip6: 'ip6', ip6zone: 'str', ipcidr: 'uint8',
  dns: 'host', dns4: 'host', dns6: 'host', dnsaddr: 'host',
  tcp: 'port', udp: 'port', sctp: 'port', dccp: 'port',
  quic: null, 'quic-v1': null, webtransport: null, certhash: 'certhash',
  webrtc: null, 'webrtc-direct': null, ws: null, wss: null, tls: null, sni: 'host', noise: null,
  http: null, https: null, 'p2p-circuit': null, p2p: 'peer', ipfs: 'peer', utp: null, udt: null,
};
const MULTIADDR_FIRST = new Set(['ip4', 'ip6', 'ip6zone', 'dns', 'dns4', 'dns6', 'dnsaddr']);
const HOSTNAME_RE = /^(?=.{1,253}$)([A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?$/;
const MULTIBASE_DECODERS = new Map(Object.values(bases).map((b) => [b.prefix, b]));
const MAX_PEERING_ADDRS = 32;

function validMultiaddrValue(kind, value) {
  switch (kind) {
    case 'ip4': return net.isIPv4(value);
    case 'ip6': return net.isIPv6(value);
    case 'host': return HOSTNAME_RE.test(value);
    case 'port': return /^\d{1,5}$/.test(value) && Number(value) <= 65535;
    case 'uint8': return /^\d{1,3}$/.test(value) && Number(value) <= 255;
    case 'str': return value.length > 0;
    case 'peer': return isPeerId(value);
    case 'certhash': {
      const base = MULTIBASE_DECODERS.get(value[0]);
      if (!base) return false;
      try {
        const bytes = base.decode(value);
        return Digest.decode(bytes).bytes.length === bytes.length;
      } catch {
        return false;
      }
    }
    default: return false;
  }
}

/**
 * True when `addr` is a multiaddr Kubo will accept in Peering.Peers: it starts with an address
 * component (/ip4, /ip6, /dns*), and every component is a known protocol with a valid value.
 * @param {string} addr
 */
export function isValidMultiaddr(addr) {
  if (typeof addr !== 'string' || !addr.startsWith('/') || addr.length > 1024) return false;
  const parts = addr.slice(1).split('/');
  if (parts.at(-1) === '') parts.pop(); // tolerate one trailing slash
  if (!parts.length || !MULTIADDR_FIRST.has(parts[0])) return false;
  for (let i = 0; i < parts.length; i += 1) {
    const proto = parts[i];
    if (!Object.hasOwn(MULTIADDR_PROTOCOLS, proto)) return false;
    const kind = MULTIADDR_PROTOCOLS[proto];
    if (kind === null) continue;
    i += 1;
    if (i >= parts.length || !validMultiaddrValue(kind, parts[i])) return false;
  }
  return true;
}

/**
 * Split a trailing /p2p/<id> (or legacy /ipfs/<id>) off a multiaddr.
 * @param {string} addr
 * @returns {{ addr: string, peerId: string|null }}
 */
export function splitP2pSuffix(addr) {
  const s = String(addr || '').trim().replace(/\/+$/, '');
  const m = /^(.*)\/(?:p2p|ipfs)\/([^/]+)$/.exec(s);
  return m ? { addr: m[1], peerId: m[2] } : { addr: s, peerId: null };
}

/**
 * Turn settings.ipfs.peers ([{ peerId, name, addrs }]) into Kubo Peering.Peers entries
 * ([{ ID, Addrs }]). Entries with an invalid peer ID (or our own ID) are dropped, a trailing
 * /p2p/<id> is removed from each address, and addresses that are not valid multiaddrs (or name
 * a different peer) are dropped. Duplicate peer IDs are merged.
 * @param {unknown} peers
 * @param {{ selfId?: string|null }} [opts]
 * @returns {Array<{ ID: string, Addrs: string[] }>}
 */
export function normalizePeeringPeers(peers, { selfId = null } = {}) {
  if (!Array.isArray(peers)) return [];
  const byId = new Map();
  for (const p of peers) {
    if (!p || typeof p !== 'object') continue;
    let id = typeof p.peerId === 'string' ? p.peerId.trim() : '';
    const extraAddrs = [];
    if (id.startsWith('/')) {
      // tolerate a full multiaddr ending in /p2p/<id> in the peerId field
      const split = splitP2pSuffix(id);
      id = split.peerId || '';
      extraAddrs.push(split.addr);
    }
    if (!id || !isPeerId(id) || (selfId && id === selfId)) continue;
    const entry = byId.get(id) || { ID: id, Addrs: [] };
    const rawAddrs = [...extraAddrs, ...(Array.isArray(p.addrs) ? p.addrs : [])];
    for (const raw of rawAddrs) {
      if (typeof raw !== 'string' || !raw.trim().startsWith('/')) continue;
      const { addr, peerId } = splitP2pSuffix(raw);
      if (peerId && peerId !== id) continue;
      if (!isValidMultiaddr(addr) || entry.Addrs.includes(addr)) continue;
      if (entry.Addrs.length < MAX_PEERING_ADDRS) entry.Addrs.push(addr);
    }
    byId.set(id, entry);
  }
  return [...byId.values()];
}

/** settings.ipfs.storageMaxGB → Kubo's Datastore.StorageMax ('10GB'); invalid values use the default. */
export function storageMaxValue(gb) {
  const n = Number(gb);
  const whole = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 100_000) : DEFAULT_STORAGE_MAX_GB;
  return `${whole}GB`;
}

/**
 * Apply Bucks' settings to a Kubo config object (idempotent, returns a copy).
 * - API and Gateway are bound to loopback on the reserved ports; every Swarm listen address keeps
 *   its transport but moves to the reserved swarm port so the embedded node never fights a user's
 *   own Kubo over 4001.
 * - Pubsub is enabled with the gossipsub router and LAN mDNS discovery is on (device pairing).
 * - When `peers` is given (settings.ipfs.peers), Peering.Peers is replaced by the valid entries
 *   (see normalizePeeringPeers) so paired devices stay connected.
 * - Hosting: no accelerated DHT client (it crawls the DHT hourly), only pinned content is announced
 *   (Provide.Strategy = pinned), connection limits fit a host, Datastore.StorageMax is the user's
 *   quota, and the gateway fetches from the network (visitors load through it). Routing.Type is set
 *   to `auto` only when the repo has none, so a repo created with the lowpower profile keeps its
 *   `autoclient`.
 * Everything else (relay, hole punching, AutoNAT, IPNS lifetimes, delegated routers) keeps Kubo's
 * value.
 * @param {object} config  parsed <repo>/config
 * @param {{ apiPort: number, gatewayPort: number, swarmPort?: number, peers?: unknown, storageMaxGB?: number }} opts
 */
export function applyBucksConfig(config, { apiPort, gatewayPort, swarmPort, peers, storageMaxGB }) {
  const out = structuredClone(config || {});
  out.Addresses = { ...(out.Addresses || {}) };
  out.Addresses.API = `/ip4/127.0.0.1/tcp/${apiPort}`;
  out.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${gatewayPort}`;
  if (Number.isInteger(swarmPort)) {
    const swarm = Array.isArray(out.Addresses.Swarm) && out.Addresses.Swarm.length ? out.Addresses.Swarm : DEFAULT_SWARM_ADDRS;
    out.Addresses.Swarm = [...new Set(swarm.map((a) => String(a).replace(/\/(tcp|udp)\/\d+/, `/$1/${swarmPort}`)))];
  }
  out.Pubsub = { ...(isObject(out.Pubsub) ? out.Pubsub : {}), Enabled: true, Router: 'gossipsub' };
  const discovery = isObject(out.Discovery) ? out.Discovery : {};
  out.Discovery = { ...discovery, MDNS: { ...(isObject(discovery.MDNS) ? discovery.MDNS : {}), Enabled: true } };
  if (peers !== undefined) {
    const selfId = typeof out.Identity?.PeerID === 'string' ? out.Identity.PeerID : null;
    out.Peering = { ...(isObject(out.Peering) ? out.Peering : {}), Peers: normalizePeeringPeers(peers, { selfId }) };
  }
  const routing = isObject(out.Routing) ? out.Routing : {};
  out.Routing = { ...routing, AcceleratedDHTClient: false };
  if (typeof routing.Type !== 'string' || !routing.Type) out.Routing.Type = 'auto';
  out.Provide = { ...(isObject(out.Provide) ? out.Provide : {}), Strategy: 'pinned' };
  const swarm = isObject(out.Swarm) ? out.Swarm : {};
  out.Swarm = { ...swarm, ConnMgr: { ...(isObject(swarm.ConnMgr) ? swarm.ConnMgr : {}), Type: 'basic', ...HOSTING_CONN_MGR } };
  out.Datastore = { ...(isObject(out.Datastore) ? out.Datastore : {}), StorageMax: storageMaxValue(storageMaxGB) };
  out.Gateway = { ...(isObject(out.Gateway) ? out.Gateway : {}), NoFetch: false };
  return out;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * True when a settings change requires restarting the IPFS node: only the node mode
 * (embedded | external) and the external API URL do. Pairing changes (ipfs.peers), device
 * settings, gateways and everything else are applied live or on the next start.
 * @param {object|undefined} prevIpfs  previous settings.ipfs
 * @param {object|undefined} nextIpfs  new settings.ipfs
 */
export function ipfsSettingsNeedRestart(prevIpfs, nextIpfs) {
  const a = prevIpfs || {};
  const b = nextIpfs || {};
  const modeA = a.mode === 'external' ? 'external' : 'embedded';
  const modeB = b.mode === 'external' ? 'external' : 'embedded';
  if (modeA !== modeB) return true;
  // The external API URL only matters while connected to an external node.
  return modeB === 'external' && String(a.externalApiUrl || '').trim() !== String(b.externalApiUrl || '').trim();
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
 *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
 *   fetchImpl?: typeof fetch   // used for internet downloads only (Electron passes net.fetch for proxy support)
 * }} opts
 */
export function createKubo({ settings, userData, resourcesDir, getMainWindow = () => null, log = createLogger('kubo'), fetchImpl = globalThis.fetch }) {
  const kuboDir = path.join(userData, 'kubo');
  const repoDir = path.join(kuboDir, 'repo');
  const binDir = path.join(kuboDir, 'bin');
  const runtimeFile = path.join(kuboDir, 'runtime.json');
  const logFile = path.join(userData, 'logs', 'kubo.log');

  const listeners = new Set();
  const startsExternal = (settings.get?.()?.ipfs?.mode) === 'external';
  let status = {
    state: 'idle',
    source: startsExternal ? 'external_api' : 'embedded_kubo',
    message: 'IPFS node has not been started.',
    api_url: null,
    gateway_url: null,
    embedded: !startsExternal,
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
    // Always the pinned release, verified against the digest built into Bucks (never "latest").
    const version = PINNED_KUBO_VERSION;
    let lastPct = -1;
    let installed;
    try {
      installed = await downloadKubo({
        version,
        destDir: binDir,
        fetchImpl,
        log,
        expectedSha512: pinnedSha512({ platform: process.platform, arch: process.arch, version }),
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
    // Kubo's default profile: the node can be a DHT server when reachable, which hosting needs.
    // Repos created earlier with --profile=lowpower keep it (applyBucksConfig leaves Routing.Type).
    await runIpfs(['init', '--empty-repo=true']);
  }

  async function patchConfig(rt) {
    const file = path.join(repoDir, 'config');
    let current;
    try {
      current = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
      throw new Error(`The IPFS repository config at ${file} is unreadable (${e.message}). Delete the ${repoDir} folder to start over.`);
    }
    // settings.ipfs.peers → Peering.Peers; pubsub + mDNS always on (device pairing); hosting keys.
    const { peers: configured, storageMaxGB } = ipfsSettings();
    const peers = Array.isArray(configured) ? configured : [];
    const next = applyBucksConfig(current, { ...rt, peers, storageMaxGB });
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
    // A daemon started by an older Bucks (or by hand) may lack pubsub, which device pairing needs
    // and which only takes effect at daemon start: shut it down and start a correctly configured one.
    const probe = new KuboRpc(apiUrl, { timeoutMs: 5000 });
    let pubsubOn = false;
    try { pubsubOn = (await probe.configGet('Pubsub.Enabled')) === true; } catch { /* treat as off */ }
    if (!pubsubOn) {
      log.info(`Running IPFS daemon at ${apiUrl} has pubsub disabled; restarting it with the Bucks configuration`);
      try { await probe.shutdown({ timeoutMs: 3000 }); } catch (e) { log.debug?.(`shutdown of stale daemon: ${e.message}`); }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await apiAnswers(apiUrl))) await sleep(250);
      if (await apiAnswers(apiUrl)) throw new Error(`An IPFS daemon at ${apiUrl} is using the Bucks repository (${repoDir}) and did not shut down; stop it and start the node again.`);
      return false;
    }
    log.info(`Adopting already-running IPFS daemon at ${apiUrl}`);
    child = null;
    await becomeReady({ apiUrl, gatewayUrl, embedded: true, source: 'embedded_kubo', message: 'Embedded IPFS node is ready (reused running daemon).' });
    return true;
  }

  /* ---------- daemon ---------- */

  function spawnDaemon() {
    // BUCKS_KUBO_OFFLINE=1: no network at all (integration tests, air-gapped machines).
    const offline = process.env.BUCKS_KUBO_OFFLINE === '1' ? ['--offline'] : [];
    const proc = spawn(binaryPath, ['daemon', '--migrate=true', '--enable-gc', ...offline], {
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
    // External nodes and adopted daemons have no child process to watch: poll their API instead.
    if (!child) startExternalHealthCheck(client);
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
    try {
      await becomeReady({ apiUrl, gatewayUrl, embedded: true, source: 'embedded_kubo', message: 'Embedded IPFS node is ready.' });
    } catch (e) {
      // The API answered once but version/id failed: do not leave a half-started daemon behind.
      const proc = child;
      child = null;
      await killChild(proc);
      throw e;
    }
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

  // Restart only when the node configuration changes (mode or external API URL). Pairing changes
  // (settings.ipfs.peers) are applied live by devices.js and written to the repo on the next start.
  let lastCfg = ipfsSettings();
  if (typeof settings.onChange === 'function') {
    settings.onChange((all) => {
      const cfg = { ...(all?.ipfs || {}) };
      const changed = ipfsSettingsNeedRestart(lastCfg, cfg);
      lastCfg = cfg;
      if (!changed) return;
      if (status.state === 'idle' || status.state === 'stopped') return; // not running: nothing to restart
      log.info('IPFS settings changed; restarting node');
      kubo.restart().catch((e) => log.error('IPFS restart failed:', e.message));
    });
  }

  return kubo;
}
