// Kubo HTTP RPC client (/api/v0/*). Pure Node (global fetch), no Electron imports.
// Every Kubo command is a POST to {apiUrl}/api/v0/<cmd>?arg=…; errors come back as
// JSON { Message, Code, Type: 'error' } with a non-2xx status.

const DEFAULT_TIMEOUT_MS = 30_000;

/** Kubo's unixfs link types (numeric in `ls` output) plus the string forms newer builds emit. */
function mapLinkType(t) {
  if (typeof t === 'number') {
    if (t === 1 || t === 5) return 'dir'; // TDirectory, THAMTShard
    if (t === 2 || t === 0) return 'file'; // TFile, TRaw
    return 'unknown';
  }
  if (typeof t === 'string') {
    const s = t.toLowerCase();
    if (s === 'dir' || s === 'directory' || s === 'hamt-sharded-directory' || s === 'hamtshard') return 'dir';
    if (s === 'file' || s === 'raw') return 'file';
  }
  return 'unknown';
}

/** Extract a human-readable message from a Kubo error body. */
async function errorMessageFrom(res) {
  let text = '';
  try { text = await res.text(); } catch { /* body unreadable */ }
  if (text) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j.Message === 'string' && j.Message) return j.Message;
    } catch { /* not JSON */ }
    const trimmed = text.trim();
    if (trimmed && trimmed.length < 512) return trimmed;
  }
  return res.statusText || `HTTP ${res.status}`;
}

function toNumber(v, fallback = 0) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Minimal, dependency-free client for the Kubo RPC API.
 *
 * @example
 *   const rpc = new KuboRpc('http://127.0.0.1:5001');
 *   const { ID } = await rpc.id();
 */
export class KuboRpc {
  /**
   * @param {string} apiUrl  e.g. http://127.0.0.1:5001 (trailing slash and /api/v0 suffix tolerated)
   * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
   */
  constructor(apiUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    if (typeof apiUrl !== 'string' || !/^https?:\/\//i.test(apiUrl.trim())) {
      throw new Error(`Invalid Kubo API URL: ${String(apiUrl)}`);
    }
    this.apiUrl = apiUrl.trim().replace(/\/+$/, '').replace(/\/api\/v0$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /** Build the full URL for a command. `args` become repeated ?arg= params. */
  commandUrl(cmd, args = [], query = {}) {
    const params = new URLSearchParams();
    for (const a of args) params.append('arg', String(a));
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      params.append(k, String(v));
    }
    const qs = params.toString();
    return `${this.apiUrl}/api/v0/${cmd}${qs ? `?${qs}` : ''}`;
  }

  /**
   * Low-level call. Returns the raw Response (already checked for 2xx).
   * @param {string} cmd
   * @param {{ args?: any[], query?: object, body?: any, timeoutMs?: number, signal?: AbortSignal }} [opts]
   */
  async request(cmd, { args = [], query = {}, body, timeoutMs, signal } = {}) {
    const url = this.commandUrl(cmd, args, query);
    const signals = [AbortSignal.timeout(timeoutMs ?? this.timeoutMs)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        body,
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      const name = e?.name || '';
      if (name === 'TimeoutError') throw new Error(`Kubo RPC '${cmd}' timed out after ${timeoutMs ?? this.timeoutMs} ms`);
      if (name === 'AbortError') throw new Error(`Kubo RPC '${cmd}' aborted`);
      throw new Error(`Kubo RPC '${cmd}' failed: ${e?.cause?.message || e?.message || String(e)}`);
    }
    if (!res.ok) {
      const msg = await errorMessageFrom(res);
      const err = new Error(`Kubo RPC '${cmd}' failed (${res.status}): ${msg}`);
      err.status = res.status;
      err.kuboMessage = msg;
      throw err;
    }
    return res;
  }

  /** Call a command and parse the JSON body. */
  async call(cmd, opts) {
    const res = await this.request(cmd, opts);
    const text = await res.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Kubo RPC '${cmd}' returned non-JSON output`);
    }
  }

  /** Call a command that streams newline-delimited JSON; returns the parsed objects. */
  async callNdjson(cmd, opts) {
    const res = await this.request(cmd, opts);
    const text = await res.text();
    const out = [];
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* ignore partial/garbage lines */ }
    }
    return out;
  }

  /** @returns {Promise<{ ID: string, Addresses: string[], AgentVersion: string, PublicKey?: string, Protocols?: string[] }>} */
  id() {
    return this.call('id', { timeoutMs: Math.min(this.timeoutMs, 5000) });
  }

  /** @returns {Promise<{ Version: string, Commit: string, Repo: string, System: string, Golang: string }>} */
  version() {
    return this.call('version', { timeoutMs: Math.min(this.timeoutMs, 5000) });
  }

  /**
   * Add bytes as a single file (optionally wrapped in a directory).
   * @param {Uint8Array} bytes
   * @param {{ fileName?: string, mimeType?: string, pin?: boolean, cidVersion?: number, rawLeaves?: boolean, wrapWithDirectory?: boolean }} [opts]
   * @returns {Promise<{ cid: string, size: number, name: string }>} the CID of the added file (or of the wrapping directory when wrapped)
   */
  async add(bytes, {
    fileName = 'file',
    mimeType = 'application/octet-stream',
    pin = true,
    cidVersion = 1,
    rawLeaves = true,
    wrapWithDirectory = false,
  } = {}) {
    if (!(bytes instanceof Uint8Array)) throw new Error('add(): bytes must be a Uint8Array');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType || 'application/octet-stream' }), fileName || 'file');
    const entries = await this.callNdjson('add', {
      query: {
        pin: String(Boolean(pin)),
        'cid-version': String(cidVersion),
        'raw-leaves': String(Boolean(rawLeaves)),
        'wrap-with-directory': String(Boolean(wrapWithDirectory)),
        progress: 'false',
      },
      body: form,
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
    const results = entries.filter((e) => e && typeof e.Hash === 'string');
    if (results.length === 0) throw new Error('Kubo add returned no CID');
    // With wrap-with-directory the final entry is the wrapping directory (Name === '').
    const last = results[results.length - 1];
    return { cid: last.Hash, size: toNumber(last.Size), name: last.Name ?? '' };
  }

  /**
   * Read a file's bytes.
   * @param {string} path  CID or /ipfs/… path
   * @param {{ offset?: number, length?: number, maxBytes?: number, timeoutMs?: number }} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async cat(path, { offset, length, maxBytes = Infinity, timeoutMs } = {}) {
    const res = await this.request('cat', { args: [path], query: { offset, length }, timeoutMs });
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new Error(`Content is ${declared} bytes, larger than the ${maxBytes} byte limit`);
    }
    const chunks = [];
    let total = 0;
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`Content exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }

  /**
   * List a directory.
   * @param {string} path
   * @returns {Promise<Array<{ name: string, cid: string, size: number, type: 'file' | 'dir' | 'unknown' }>>}
   */
  async ls(path, { timeoutMs } = {}) {
    const j = await this.call('ls', { args: [path], query: { 'resolve-type': 'true', size: 'true' }, timeoutMs });
    const links = j?.Objects?.[0]?.Links || [];
    return links.map((l) => ({
      name: l.Name ?? '',
      cid: l.Hash,
      size: toNumber(l.Size),
      type: mapLinkType(l.Type),
    }));
  }

  /** @returns {Promise<string>} the pinned CID as reported by Kubo */
  async pinAdd(cid) {
    const j = await this.call('pin/add', { args: [cid], query: { recursive: 'true' }, timeoutMs: Math.max(this.timeoutMs, 120_000) });
    return j?.Pins?.[0] ?? cid;
  }

  /** @returns {Promise<string>} the unpinned CID as reported by Kubo */
  async pinRm(cid) {
    const j = await this.call('pin/rm', { args: [cid], query: { recursive: 'true' } });
    return j?.Pins?.[0] ?? cid;
  }

  /** @returns {Promise<Array<{ cid: string, pin_type: string }>>} */
  async pinLs({ type = 'recursive' } = {}) {
    const j = await this.call('pin/ls', { query: { type, stream: 'false' } });
    const keys = j?.Keys || {};
    return Object.entries(keys).map(([cid, v]) => ({ cid, pin_type: v?.Type || type }));
  }

  /** @returns {Promise<Array<{ peer: string, addr: string, latency: string }>>} */
  async swarmPeers() {
    const j = await this.call('swarm/peers', { query: { latency: 'true' } });
    return (j?.Peers || []).map((p) => ({ peer: p.Peer, addr: p.Addr, latency: p.Latency || '' }));
  }

  /** @returns {Promise<{ repo_size: number, storage_max: number, num_objects: number }>} */
  async repoStat() {
    const j = await this.call('repo/stat', { timeoutMs: Math.max(this.timeoutMs, 60_000) });
    return {
      repo_size: toNumber(j?.RepoSize),
      storage_max: toNumber(j?.StorageMax),
      num_objects: toNumber(j?.NumObjects),
    };
  }

  /** @returns {Promise<{ rate_in: number, rate_out: number, total_in: number, total_out: number }>} */
  async statsBw() {
    const j = await this.call('stats/bw');
    return {
      rate_in: toNumber(j?.RateIn),
      rate_out: toNumber(j?.RateOut),
      total_in: toNumber(j?.TotalIn),
      total_out: toNumber(j?.TotalOut),
    };
  }

  /**
   * Resolve an IPNS name or DNSLink domain.
   * @returns {Promise<string>} '/ipfs/<cid>…'
   */
  async nameResolve(name, { recursive = true, timeoutMs } = {}) {
    const j = await this.call('name/resolve', {
      args: [name],
      query: { recursive: String(Boolean(recursive)) },
      timeoutMs: timeoutMs ?? Math.max(this.timeoutMs, 60_000),
    });
    if (!j?.Path) throw new Error(`Could not resolve ${name}`);
    return j.Path;
  }

  /**
   * Resolve a DNSLink domain one step (the old `ipfs dns` command was removed from Kubo,
   * so this uses `resolve` with recursive=false on /ipns/<domain>).
   * @returns {Promise<string>} '/ipfs/…' or '/ipns/…'
   */
  async dnsResolve(domain, { recursive = false, timeoutMs } = {}) {
    const d = String(domain).trim().replace(/^\/ipns\//, '');
    const j = await this.call('resolve', {
      args: [`/ipns/${d}`],
      query: { recursive: String(Boolean(recursive)) },
      timeoutMs: timeoutMs ?? Math.max(this.timeoutMs, 60_000),
    });
    if (!j?.Path) throw new Error(`Could not resolve DNSLink for ${d}`);
    return j.Path;
  }

  /** Read a config key. @returns {Promise<any>} the value */
  async configGet(key) {
    const j = await this.call('config', { args: [key] });
    return j?.Value;
  }

  /** Write a config key. With json=true the value is sent JSON-encoded (objects, booleans, numbers). */
  async configSet(key, value, { json = true } = {}) {
    const encoded = json ? JSON.stringify(value) : String(value);
    const j = await this.call('config', { args: [key, encoded], query: { json: String(Boolean(json)) } });
    return j?.Value;
  }

  /** Ask the daemon to shut down gracefully. */
  async shutdown({ timeoutMs = 3000 } = {}) {
    await this.request('shutdown', { timeoutMs });
  }
}

export { mapLinkType };
