// Kubo HTTP RPC client (/api/v0/*). Pure Node (global fetch), no Electron imports.
// Every Kubo command is a POST to {apiUrl}/api/v0/<cmd>?arg=…; errors come back as
// JSON { Message, Code, Type: 'error' } with a non-2xx status.

const DEFAULT_TIMEOUT_MS = 30_000;
const ADD_DIRECTORY_TIMEOUT_MS = 60 * 60_000; // a 500 MiB site on a slow disk
const SAFE_SEGMENT = /^[^/\\\u0000-\u001f\u007f]+$/;
const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Throw unless `p` is a clean relative POSIX path: no leading '/', no '.', '..' or empty segments,
 * no backslashes or control characters.
 */
export function assertRelativePath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096) throw new Error('file path must be a non-empty string');
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..' || !SAFE_SEGMENT.test(s))) throw new Error(`unsafe file path: ${JSON.stringify(p)}`);
  return p;
}

function assertKeyName(name) {
  if (typeof name !== 'string' || !KEY_NAME.test(name) || name === 'self') throw new Error(`invalid key name: ${JSON.stringify(name)}`);
  return name;
}

/** Parse a streamed NDJSON body line by line (Kubo's progress output). */
async function* ndjsonStream(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* partial or garbage line */ }
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) {
    try { yield JSON.parse(rest); } catch { /* ignore */ }
  }
}

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
 * An AbortSignal that fires with a TimeoutError after `ms` (and mirrors `outer` when given).
 * Unlike AbortSignal.timeout() the timer is ref'd and must be released by the caller, so a
 * finished request never leaves a stray timer behind and a pending one keeps the loop alive.
 */
function timeoutSignal(ms, outer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException(`Timed out after ${ms} ms`, 'TimeoutError')), ms);
  const onOuterAbort = () => ctrl.abort(outer.reason);
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  };
  return { signal: ctrl.signal, release };
}

/** Wrap a Response so `release` runs once its body is fully read, errored or cancelled. */
function releaseWhenConsumed(res, release) {
  if (!res.body) {
    release();
    return res;
  }
  const reader = res.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        release();
        throw e;
      }
      if (chunk.done) {
        release();
        controller.close();
      } else {
        controller.enqueue(chunk.value);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
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
   * Low-level call. Returns the raw Response (already checked for 2xx). The timeout covers
   * the headers and the body: it is released as soon as the body has been fully read or
   * cancelled, so a finished call never keeps a timer (and the event loop) alive.
   * @param {string} cmd
   * @param {{ args?: any[], query?: object, body?: any, timeoutMs?: number, signal?: AbortSignal }} [opts]
   */
  async request(cmd, { args = [], query = {}, body, timeoutMs, signal } = {}) {
    const url = this.commandUrl(cmd, args, query);
    const ms = timeoutMs ?? this.timeoutMs;
    const { signal: abortSignal, release } = timeoutSignal(ms, signal);
    let res;
    try {
      res = await this.fetchImpl(url, { method: 'POST', body, signal: abortSignal });
    } catch (e) {
      release();
      const name = e?.name || '';
      if (name === 'TimeoutError') throw new Error(`Kubo RPC '${cmd}' timed out after ${ms} ms`);
      if (name === 'AbortError') throw new Error(`Kubo RPC '${cmd}' aborted`);
      throw new Error(`Kubo RPC '${cmd}' failed: ${e?.cause?.message || e?.message || String(e)}`);
    }
    if (!res.ok) {
      let msg;
      try { msg = await errorMessageFrom(res); } finally { release(); }
      const err = new Error(`Kubo RPC '${cmd}' failed (${res.status}): ${msg}`);
      err.status = res.status;
      err.kuboMessage = msg;
      throw err;
    }
    return releaseWhenConsumed(res, release);
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

  /**
   * Connect to a peer now (swarm/connect).
   * @param {string} addr  multiaddr ending in /p2p/<peerId>
   * @returns {Promise<string[]>} Kubo's status strings
   */
  async swarmConnect(addr, { timeoutMs } = {}) {
    const j = await this.call('swarm/connect', { args: [addr], timeoutMs: timeoutMs ?? Math.max(this.timeoutMs, 30_000) });
    return Array.isArray(j?.Strings) ? j.Strings : [];
  }

  /**
   * Add a peer to the live peering set (kept connected, reconnected on drop). Not persisted to the
   * repo config; write Peering.Peers with configSet for that.
   * @param {string} addr  multiaddr ending in /p2p/<peerId>
   * @returns {Promise<{ id: string, status: string }>}
   */
  async swarmPeeringAdd(addr) {
    const j = await this.call('swarm/peering/add', { args: [addr] });
    return { id: j?.ID ?? '', status: j?.Status ?? '' };
  }

  /** Remove a peer from the live peering set. @returns {Promise<{ id: string, status: string }>} */
  async swarmPeeringRm(peerId) {
    const j = await this.call('swarm/peering/rm', { args: [peerId] });
    return { id: j?.ID ?? '', status: j?.Status ?? '' };
  }

  /** @returns {Promise<Array<{ id: string, addrs: string[] }>>} the live peering set */
  async swarmPeeringLs() {
    const j = await this.call('swarm/peering/ls');
    return (j?.Peers || []).map((p) => ({ id: p.ID, addrs: Array.isArray(p.Addrs) ? p.Addrs : [] }));
  }

  /**
   * Publish a message on a pubsub topic (requires Pubsub.Enabled on the node).
   * @param {string} topic  plain topic name; multibase-encoded for the HTTP API automatically
   * @param {Uint8Array|string} data
   */
  async pubsubPub(topic, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (!(bytes instanceof Uint8Array)) throw new Error('pubsubPub(): data must be a string or Uint8Array');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'data');
    await this.request('pubsub/pub', { args: [encodePubsubTopic(topic)], body: form }).then((res) => res.text());
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

  /* ───────────── hosting (docs/IPFS-HOSTING-IMPLEMENTATION.md §7.2) ───────────── */

  /**
   * Add a directory tree in one multipart request and pin it. Each file is one part named
   * `<rootName>/<path>` (percent-encoded); Kubo builds the directories from the paths and its last
   * NDJSON entry is the root directory. Contents are streamed from the Blobs (use fs.openAsBlob),
   * never buffered here. Empty directories are not represented.
   * @param {Array<{ path: string, content: Blob }>} files  relative POSIX paths ('assets/app.js')
   * @param {{ pin?: boolean, rootName?: string, onProgress?: (bytes: number) => void, signal?: AbortSignal, timeoutMs?: number }} [opts]
   *   onProgress: bytes read by Kubo so far, summed over all files
   * @returns {Promise<{ cid: string, size: number }>}
   */
  async addDirectory(files, { pin = true, rootName = 'site', onProgress, signal, timeoutMs = ADD_DIRECTORY_TIMEOUT_MS } = {}) {
    if (!Array.isArray(files) || files.length === 0) throw new Error('addDirectory(): no files to add');
    if (!SAFE_SEGMENT.test(rootName)) throw new Error('addDirectory(): invalid rootName');
    const seen = new Set();
    for (const f of files) {
      assertRelativePath(f?.path);
      if (!(f.content instanceof Blob)) throw new Error(`addDirectory(): ${f.path} has no Blob content`);
      if (seen.has(f.path)) throw new Error(`addDirectory(): duplicate path ${f.path}`);
      seen.add(f.path);
    }
    // Lexical order keeps every directory's entries contiguous, as Kubo's multipart reader expects.
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const form = new FormData();
    for (const f of sorted) form.append('file', f.content, encodeURIComponent(`${rootName}/${f.path}`));
    const res = await this.request('add', {
      query: {
        recursive: 'true',
        'cid-version': '1',
        'raw-leaves': 'true',
        pin: String(Boolean(pin)),
        'wrap-with-directory': 'false',
        progress: String(typeof onProgress === 'function'),
      },
      body: form,
      timeoutMs,
      signal,
    });
    const perFile = new Map();
    let root = null;
    let errorText = null;
    for await (const entry of ndjsonStream(res.body)) {
      if (typeof entry?.Message === 'string' && entry.Type === 'error') errorText = entry.Message;
      if (typeof entry?.Name !== 'string') continue;
      if (entry.Bytes !== undefined && typeof onProgress === 'function') {
        perFile.set(entry.Name, toNumber(entry.Bytes));
        let total = 0;
        for (const v of perFile.values()) total += v;
        onProgress(total);
      }
      if (typeof entry.Hash === 'string' && entry.Name === rootName) root = { cid: entry.Hash, size: toNumber(entry.Size) };
    }
    if (errorText) throw new Error(`Kubo add failed: ${errorText}`);
    if (!root) throw new Error('Kubo add did not report the root directory');
    return root;
  }

  /** Create an IPNS key. @returns {Promise<{ name: string, id: string }>} id is the base36 k51… name */
  async keyGen(name, { type = 'ed25519' } = {}) {
    const j = await this.call('key/gen', { args: [assertKeyName(name)], query: { type, 'ipns-base': 'base36' } });
    return { name: j?.Name ?? name, id: j?.Id ?? '' };
  }

  /** @returns {Promise<Array<{ name: string, id: string }>>} every key, ids in base36 (k51…) */
  async keyList() {
    const j = await this.call('key/list', { query: { l: 'true', 'ipns-base': 'base36' } });
    return (j?.Keys || []).map((k) => ({ name: k.Name, id: k.Id }));
  }

  /** Delete a key: its ipns:// name can never be updated again. @returns {Promise<string[]>} removed names */
  async keyRm(name) {
    const j = await this.call('key/rm', { args: [assertKeyName(name)], query: { 'ipns-base': 'base36' } });
    return (j?.Keys || []).map((k) => k.Name);
  }

  /**
   * Import a private key (the bytes of a Kubo keystore file).
   * @param {string} name
   * @param {Uint8Array} bytes  libp2p protobuf-encoded private key
   * @returns {Promise<{ name: string, id: string }>}
   */
  async keyImport(name, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 8192) throw new Error('keyImport(): key bytes must be a non-empty Uint8Array');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'key');
    const j = await this.call('key/import', {
      args: [assertKeyName(name)],
      query: { format: 'libp2p-protobuf-cleartext', 'ipns-base': 'base36' },
      body: form,
    });
    return { name: j?.Name ?? name, id: j?.Id ?? '' };
  }

  /**
   * Point an IPNS name (key) at a CID.
   * @param {string} keyName
   * @param {string} cid
   * @param {{ lifetime?: string, ttl?: string, allowOffline?: boolean, timeoutMs?: number }} [opts]
   *   allowOffline: only for a node started with --offline (Kubo refuses to publish there otherwise)
   * @returns {Promise<{ name: string, value: string }>}
   */
  async namePublish(keyName, cid, { lifetime = '48h', ttl = '5m', allowOffline = false, timeoutMs } = {}) {
    const j = await this.call('name/publish', {
      args: [`/ipfs/${cid}`],
      query: {
        key: assertKeyName(keyName),
        lifetime,
        ttl,
        resolve: 'false',
        'ipns-base': 'base36',
        ...(allowOffline ? { 'allow-offline': 'true' } : {}),
      },
      timeoutMs: timeoutMs ?? Math.max(this.timeoutMs, 120_000),
    });
    return { name: j?.Name ?? '', value: j?.Value ?? '' };
  }

  /**
   * Announce a CID (and, recursively, its blocks) to the routing system. Needs an online node with
   * peers; Kubo answers "cannot provide, no connected peers" otherwise.
   */
  async provide(cid, { recursive = true, timeoutMs } = {}) {
    await this.callNdjson('routing/provide', { args: [cid], query: { recursive: String(Boolean(recursive)) }, timeoutMs: timeoutMs ?? Math.max(this.timeoutMs, 120_000) });
  }

  /**
   * Size and block count of a DAG. With offline=true Kubo never fetches missing blocks, so this also
   * proves the whole DAG is stored locally (it fails otherwise).
   * @returns {Promise<{ size: number, blocks: number }>}
   */
  async dagStat(cid, { offline = false, timeoutMs } = {}) {
    const j = await this.call('dag/stat', { args: [cid], query: { progress: 'false', ...(offline ? { offline: 'true' } : {}) }, timeoutMs });
    return { size: toNumber(j?.TotalSize), blocks: toNumber(j?.UniqueBlocks) };
  }

  /** Stream a DAG as a CAR file. @returns {Promise<Response>} body: application/vnd.ipld.car */
  dagExport(cid, { signal, timeoutMs = ADD_DIRECTORY_TIMEOUT_MS } = {}) {
    return this.request('dag/export', { args: [cid], signal, timeoutMs });
  }

  /**
   * Import a CAR file and pin its roots (restoring a site on another computer).
   * @param {Blob} car
   * @returns {Promise<{ roots: string[] }>}
   */
  async dagImport(car, { timeoutMs = ADD_DIRECTORY_TIMEOUT_MS } = {}) {
    if (!(car instanceof Blob)) throw new Error('dagImport(): car must be a Blob');
    const form = new FormData();
    form.append('file', car, 'site.car');
    const lines = await this.callNdjson('dag/import', { query: { 'pin-roots': 'true' }, body: form, timeoutMs });
    const failed = lines.find((l) => l?.Root?.PinErrorMsg);
    if (failed) throw new Error(`Kubo could not pin the CAR's root: ${failed.Root.PinErrorMsg}`);
    return { roots: lines.map((l) => l?.Root?.Cid?.['/']).filter((c) => typeof c === 'string') };
  }

  /**
   * CIDs of every block below a root (not the root itself), each once.
   * @returns {Promise<string[]>}
   */
  async refs(cid, { offline = true, timeoutMs } = {}) {
    const lines = await this.callNdjson('refs', {
      args: [cid],
      query: { recursive: 'true', unique: 'true', ...(offline ? { offline: 'true' } : {}) },
      timeoutMs: timeoutMs ?? Math.max(this.timeoutMs, 120_000),
    });
    const failed = lines.find((l) => l?.Err);
    if (failed) throw new Error(`Kubo refs failed: ${failed.Err}`);
    return lines.map((l) => l?.Ref).filter((r) => typeof r === 'string' && r);
  }

  /** @returns {Promise<string[]>} the node's listen addresses (fails on a node started with --offline) */
  async swarmAddrsLocal() {
    const j = await this.call('swarm/addrs/local', { timeoutMs: Math.min(this.timeoutMs, 5000) });
    return Array.isArray(j?.Strings) ? j.Strings : [];
  }

  /** False when the daemon runs with --offline (no routing, no swarm), true otherwise. */
  async isOnline() {
    try {
      await this.swarmAddrsLocal();
      return true;
    } catch (e) {
      if (/online mode/i.test(e.kuboMessage || e.message)) return false;
      throw e;
    }
  }

  /** @returns {Promise<{ peers: number, blocksSent: number, dataSent: number, blocksReceived: number, dataReceived: number }>} */
  async bitswapStat() {
    const j = await this.call('bitswap/stat', { timeoutMs: Math.min(this.timeoutMs, 5000) });
    return {
      peers: Array.isArray(j?.Peers) ? j.Peers.length : 0,
      blocksSent: toNumber(j?.BlocksSent),
      dataSent: toNumber(j?.DataSent),
      blocksReceived: toNumber(j?.BlocksReceived),
      dataReceived: toNumber(j?.DataReceived),
    };
  }

  /**
   * The reprovider's view (Kubo ≥ 0.39 sweep provider): whether it can reach the DHT, and how many
   * keys it keeps announcing.
   * @returns {Promise<{ connectivity: string|null, keys: number|null }>}
   */
  async provideStat() {
    const j = await this.call('provide/stat', { timeoutMs: Math.min(this.timeoutMs, 5000) });
    const sweep = j?.Sweep;
    return {
      connectivity: typeof sweep?.connectivity?.status === 'string' ? sweep.connectivity.status : null,
      keys: Number.isFinite(sweep?.schedule?.keys) ? sweep.schedule.keys : null,
    };
  }

  /**
   * The newest IPNS record the routing system has for a name, decoded.
   * @returns {Promise<{ value: string, sequence: number, validity: string|null }>}
   */
  async ipnsRecord(name, { timeoutMs = 10_000 } = {}) {
    const lines = await this.callNdjson('routing/get', { args: [`/ipns/${name}`], timeoutMs });
    const extra = lines.map((l) => l?.Extra).filter((x) => typeof x === 'string' && x).at(-1);
    if (!extra) throw new Error(`No IPNS record found for ${name}`);
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(extra, 'base64')], { type: 'application/octet-stream' }), 'record');
    const j = await this.call('name/inspect', { body: form, timeoutMs });
    const entry = j?.Entry || {};
    return { value: String(entry.Value ?? ''), sequence: toNumber(entry.Sequence), validity: typeof entry.Validity === 'string' ? entry.Validity : null };
  }

  /** Ask the daemon to shut down gracefully. */
  async shutdown({ timeoutMs = 3000 } = {}) {
    await this.request('shutdown', { timeoutMs });
  }
}

/**
 * Encode a pubsub topic the way Kubo's HTTP API expects it: multibase base64url, no padding
 * ('u' prefix). 'bucks-devices-v1' → 'uYnVja3MtZGV2aWNlcy12MQ'.
 * @param {string} topic
 */
export function encodePubsubTopic(topic) {
  if (typeof topic !== 'string' || !topic) throw new Error('pubsub topic must be a non-empty string');
  return `u${Buffer.from(topic, 'utf8').toString('base64url')}`;
}

/**
 * Decode a multibase base64url ('u…') pubsub field (data, seqno, topicIDs) into bytes.
 * @param {string} value
 * @returns {Uint8Array}
 */
export function decodeMultibaseBase64url(value) {
  if (typeof value !== 'string' || !value.startsWith('u')) throw new Error('expected a multibase base64url string (u…)');
  return new Uint8Array(Buffer.from(value.slice(1), 'base64url'));
}

export { mapLinkType };
