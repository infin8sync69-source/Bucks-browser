// Device pairing core: the pure, I/O-free half of the devices feature (see the "Devices" section
// of docs/IPC-CONTRACT.md). Topic encoding, presence (de)serialisation and validation, multiaddr
// helpers, outbox / received list maintenance and the online / discovered windows.
// No Electron, no network, no file system: everything here is unit-tested under plain node.

import { CID } from 'multiformats/cid';
import { base58btc } from 'multiformats/bases/base58';
import * as Digest from 'multiformats/hashes/digest';

/** Pubsub topic shared by every Bucks install. */
export const TOPIC = 'bucks-devices-v1';
/** Presence payload version. */
export const PROTOCOL_VERSION = 1;

export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_NAME_LENGTH = 64;
export const MAX_ADDRS = 16;
export const MAX_ADDR_LENGTH = 300;
export const MAX_SHARES = 20;
export const MAX_SHARE_NAME_LENGTH = 255;
export const MAX_CID_LENGTH = 200;
export const MAX_PLATFORM_LENGTH = 32;
export const MAX_VERSION_LENGTH = 64;
export const MAX_RECEIVED = 100;
export const MAX_SEEN = 500;
export const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Seen keys outlive the senders' 7-day outbox window by a day (absorbs clock skew). */
export const SEEN_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const ONLINE_WINDOW_MS = 90 * 1000;
export const DISCOVERED_WINDOW_MS = 5 * 60 * 1000;

const LIBP2P_KEY_CODEC = 0x72;
const BARE_PEER_ID = /^(1|Qm)[1-9A-HJ-NP-Za-km-z]{40,100}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/* ---------------- multibase / topic ---------------- */

/** Multibase 'u' (base64url, no padding) encoding of a UTF-8 string or bytes. */
export function encodeMultibase(value) {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return `u${buf.toString('base64url')}`;
}

/** The `arg=` value Kubo's pubsub HTTP API wants for a topic: 'u' + base64url(topic), no padding. */
export function encodeTopicArg(topic = TOPIC) {
  return encodeMultibase(String(topic));
}

/** Precomputed `arg=` for {@link TOPIC} ('uYnVja3MtZGV2aWNlcy12MQ'). */
export const TOPIC_ARG = encodeTopicArg(TOPIC);

/**
 * Decode Kubo's multibase pubsub `data` field ('u' + base64url) into a Buffer.
 * @param {string} data
 * @returns {Buffer|null} null when the value is not 'u'-prefixed base64url
 */
export function decodeMultibaseData(data) {
  if (typeof data !== 'string' || data[0] !== 'u') return null;
  const body = data.slice(1);
  if (!/^[A-Za-z0-9_-]*$/.test(body)) return null;
  return Buffer.from(body, 'base64url');
}

/* ---------------- identifiers ---------------- */

/**
 * Normalise a libp2p peer ID to its base58btc form (12D3Koo… / Qm…), which is what pubsub `from`
 * fields and Kubo's Peering config use. Also accepts the CIDv1 libp2p-key forms (k51…, bafzaa…).
 * @returns {string|null} null when the string is not a peer ID
 */
export function normalizePeerId(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s || s.length > 200) return null;
  if (BARE_PEER_ID.test(s)) {
    try {
      const bytes = base58btc.baseDecode(s);
      const mh = Digest.decode(bytes);
      return mh.bytes.length === bytes.length ? s : null;
    } catch {
      return null;
    }
  }
  try {
    const cid = CID.parse(s);
    if (cid.version !== 1 || cid.code !== LIBP2P_KEY_CODEC) return null;
    return base58btc.baseEncode(cid.multihash.bytes);
  } catch {
    return null;
  }
}

/** True when `value` parses as a CID (v0 or v1, any codec). */
export function isValidCid(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_CID_LENGTH) return false;
  try {
    CID.parse(value);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- multiaddrs ---------------- */

/** Remove a trailing /p2p/<id> (or legacy /ipfs/<id>) component from a multiaddr. */
export function stripP2p(addr) {
  return String(addr ?? '').trim().replace(/\/(p2p|ipfs)\/[^/]+$/, '');
}

/** A syntactically plausible multiaddr: starts with '/', bounded length, no whitespace/control chars. */
export function isValidAddr(addr) {
  return typeof addr === 'string'
    && addr.length > 1
    && addr.length <= MAX_ADDR_LENGTH
    && addr[0] === '/'
    && !/[\s\u0000-\u001f\u007f]/.test(addr);
}

/**
 * Validate, strip /p2p suffixes, dedupe and cap a list of multiaddrs (invalid entries dropped).
 * @param {unknown} addrs
 * @returns {string[]}
 */
export function sanitizeAddrs(addrs) {
  if (!Array.isArray(addrs)) return [];
  const out = [];
  for (const a of addrs) {
    if (typeof a !== 'string') continue;
    const s = stripP2p(a);
    if (!isValidAddr(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_ADDRS) break;
  }
  return out;
}

function isLoopbackAddr(addr) {
  return /^\/ip4\/127\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/|$)/.test(addr)
    || /^\/ip6\/(::1|0:0:0:0:0:0:0:1)(\/|$)/i.test(addr);
}

function isUnusableAddr(addr) {
  return /^\/ip4\/0\.0\.0\.0(\/|$)/.test(addr) // unspecified (listen-only)
    || /^\/ip6\/::(\/|$)/.test(addr)
    || /^\/ip6\/fe80:/i.test(addr) // link-local: needs a zone id the other machine cannot know
    || /^\/ip6zone\//i.test(addr);
}

/**
 * The addresses this device advertises to others: Kubo `id` Addresses minus loopback
 * (127.0.0.0/8, ::1), unspecified and link-local IPv6, relay (/p2p-circuit) addresses, with the
 * /p2p suffix stripped, deduped, at most 16.
 * @param {unknown} idAddresses  e.g. (await rpc.id()).Addresses
 * @returns {string[]}
 */
export function shareableAddrs(idAddresses) {
  if (!Array.isArray(idAddresses)) return [];
  const out = [];
  for (const raw of idAddresses) {
    if (typeof raw !== 'string') continue;
    if (raw.includes('/p2p-circuit')) continue;
    const a = stripP2p(raw);
    if (!isValidAddr(a) || isLoopbackAddr(a) || isUnusableAddr(a) || out.includes(a)) continue;
    out.push(a);
    if (out.length >= MAX_ADDRS) break;
  }
  return out;
}

/**
 * Parse what a user pastes into the pair box: a peer ID (12D3Koo…, k51…) or a multiaddr ending in
 * /p2p/<id> (e.g. '/ip4/192.168.1.20/tcp/40785/p2p/12D3Koo…', or just '/p2p/12D3Koo…').
 * @param {string} input
 * @returns {{ peerId: string, addrs: string[] }}  addrs without the /p2p suffix
 * @throws {Error} with a readable message when the input is neither
 */
export function parsePairInput(input) {
  if (typeof input !== 'string') throw new Error('Peer ID must be a string');
  const s = input.trim();
  if (!s) throw new Error('Peer ID must not be empty');
  if (s.length > MAX_ADDR_LENGTH + 120) throw new Error('Peer ID or address is too long');
  if (s[0] === '/') {
    const m = /\/(p2p|ipfs)\/([^/]+)$/.exec(s);
    if (!m) throw new Error('A device address must end with /p2p/<peer ID>');
    const peerId = normalizePeerId(m[2]);
    if (!peerId) throw new Error(`"${m[2]}" is not a valid peer ID`);
    const base = s.slice(0, m.index);
    if (!base) return { peerId, addrs: [] };
    if (base.includes('/p2p-circuit')) {
      // relay address: keep it whole minus the final /p2p (that is the Peering form)
      if (!isValidAddr(base)) throw new Error('The device address is not a valid multiaddr');
      return { peerId, addrs: [base] };
    }
    if (!isValidAddr(base) || /\/(p2p|ipfs)\//.test(base)) throw new Error('The device address is not a valid multiaddr');
    return { peerId, addrs: [base] };
  }
  const peerId = normalizePeerId(s);
  if (!peerId) throw new Error(`"${s.length > 80 ? `${s.slice(0, 80)}…` : s}" is not a peer ID or a /p2p/ multiaddr`);
  return { peerId, addrs: [] };
}

/* ---------------- presence ---------------- */

/** Trim, drop control characters, cap length. Returns '' for non-strings. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, '').trim().slice(0, max);
}

/** Normalise a share size: non-negative safe integer or null. */
export function cleanSize(size) {
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function validShare(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (!isValidCid(s.cid)) return null;
  if (s.name !== undefined && typeof s.name !== 'string') return null;
  if (typeof s.name === 'string' && s.name.length > MAX_SHARE_NAME_LENGTH) return null;
  if (s.size !== undefined && s.size !== null && cleanSize(s.size) === null) return null;
  if (typeof s.ts !== 'number' || !Number.isFinite(s.ts) || s.ts <= 0) return null;
  return { cid: s.cid, name: cleanText(s.name, MAX_SHARE_NAME_LENGTH) || s.cid, size: cleanSize(s.size), ts: s.ts };
}

/**
 * Parse and validate one NDJSON line from `pubsub/sub`.
 * Returns null for anything invalid: bad JSON, wrong topic, oversized payload, wrong type or
 * version, peerId ≠ from, names > 64 chars, more than 16 addrs or addrs not starting with '/'
 * (or > 300 chars), more than 20 shares or a share whose CID does not parse, and our own messages.
 * @param {string|object} line
 * @param {{ selfPeerId?: string|null }} [opts]
 * @returns {null | { from: string, peerId: string, name: string, platform: string, version: string,
 *                    addrs: string[], shares: Array<{ cid: string, name: string, size: number|null, ts: number }>, ts: number }}
 */
export function parseMessage(line, { selfPeerId = null } = {}) {
  let msg = line;
  if (typeof line === 'string') {
    if (line.length > MAX_PAYLOAD_BYTES * 2 + 4096) return null;
    try { msg = JSON.parse(line); } catch { return null; }
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const from = typeof msg.from === 'string' ? msg.from : null;
  if (!from || !normalizePeerId(from) || normalizePeerId(from) !== from) return null;
  if (selfPeerId && from === selfPeerId) return null;
  if (Array.isArray(msg.topicIDs) && msg.topicIDs.length && !msg.topicIDs.some((t) => t === TOPIC_ARG || t === TOPIC)) return null;
  if (typeof msg.data !== 'string' || msg.data.length > Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3) + 2) return null;
  const bytes = decodeMultibaseData(msg.data);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_PAYLOAD_BYTES) return null;
  let p;
  try { p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (p.v !== PROTOCOL_VERSION || p.type !== 'presence') return null;
  if (p.peerId !== from) return null;
  if (typeof p.name !== 'string' || p.name.length > MAX_NAME_LENGTH) return null;
  if (p.platform !== undefined && (typeof p.platform !== 'string' || p.platform.length > MAX_PLATFORM_LENGTH)) return null;
  if (p.version !== undefined && (typeof p.version !== 'string' || p.version.length > MAX_VERSION_LENGTH)) return null;
  if (typeof p.ts !== 'number' || !Number.isFinite(p.ts) || p.ts <= 0) return null;
  const addrsIn = p.addrs === undefined ? [] : p.addrs;
  if (!Array.isArray(addrsIn) || addrsIn.length > MAX_ADDRS) return null;
  if (!addrsIn.every(isValidAddr)) return null;
  const sharesIn = p.shares === undefined ? [] : p.shares;
  if (!Array.isArray(sharesIn) || sharesIn.length > MAX_SHARES) return null;
  const shares = [];
  for (const s of sharesIn) {
    const v = validShare(s);
    if (!v) return null;
    if (!shares.some((x) => x.cid === v.cid)) shares.push(v);
  }
  return {
    from,
    peerId: from,
    name: cleanText(p.name, MAX_NAME_LENGTH),
    platform: cleanText(p.platform, MAX_PLATFORM_LENGTH),
    version: cleanText(p.version, MAX_VERSION_LENGTH),
    addrs: sanitizeAddrs(addrsIn),
    shares,
    ts: p.ts,
  };
}

/**
 * Build this device's presence payload. Inputs are normalised to the contract limits; when the
 * JSON would exceed 16 KiB the oldest shares are dropped until it fits.
 * @param {{ peerId: string, name?: string, platform?: string, version?: string, addrs?: string[],
 *           shares?: Array<{ cid: string, name?: string, size?: number|null, ts: number }>, ts: number }} p
 * @returns {object} the payload object (serialise with {@link encodePresence})
 */
export function buildPresence({ peerId, name = '', platform = '', version = '', addrs = [], shares = [], ts }) {
  if (!normalizePeerId(peerId)) throw new Error('buildPresence(): a valid peerId is required');
  if (typeof ts !== 'number' || !Number.isFinite(ts)) throw new Error('buildPresence(): ts must be a number');
  const presence = {
    v: PROTOCOL_VERSION,
    type: 'presence',
    peerId,
    name: cleanText(name, MAX_NAME_LENGTH),
    platform: cleanText(platform, MAX_PLATFORM_LENGTH),
    version: cleanText(version, MAX_VERSION_LENGTH),
    addrs: sanitizeAddrs(addrs),
    shares: (Array.isArray(shares) ? shares : [])
      .map(validShare)
      .filter(Boolean)
      .sort((a, b) => b.ts - a.ts)
      .filter((s, i, all) => all.findIndex((x) => x.cid === s.cid) === i)
      .slice(0, MAX_SHARES),
    ts,
  };
  while (Buffer.byteLength(JSON.stringify(presence)) > MAX_PAYLOAD_BYTES && presence.shares.length) {
    presence.shares.pop();
  }
  return presence;
}

/** Serialise a presence object to the UTF-8 JSON string that goes on the wire. */
export function encodePresence(presence) {
  return JSON.stringify(presence);
}

/* ---------------- outbox ---------------- */

/**
 * Outbox maintenance: drop entries older than 7 days (or invalid), dedupe on CID (newest wins),
 * newest first, at most 20.
 * @param {unknown} outbox
 * @param {number} now
 * @returns {Array<{ cid: string, name: string, size: number|null, ts: number }>}
 */
export function pruneOutbox(outbox, now) {
  if (!Array.isArray(outbox)) return [];
  const sorted = outbox.map(validShare).filter((s) => s && now - s.ts <= OUTBOX_MAX_AGE_MS).sort((a, b) => b.ts - a.ts);
  const out = [];
  for (const s of sorted) {
    if (out.some((x) => x.cid === s.cid)) continue;
    out.push(s);
    if (out.length >= MAX_SHARES) break;
  }
  return out;
}

/** Add (or refresh) a share in the outbox and prune it. Returns a new array. */
export function addToOutbox(outbox, { cid, name, size }, now) {
  const entry = { cid, name: cleanText(name, MAX_SHARE_NAME_LENGTH) || cid, size: cleanSize(size), ts: now };
  return pruneOutbox([entry, ...(Array.isArray(outbox) ? outbox.filter((s) => s?.cid !== cid) : [])], now);
}

/* ---------------- received ---------------- */

function validReceived(r) {
  if (!r || typeof r !== 'object') return null;
  if (!isValidCid(r.cid) || !normalizePeerId(r.from) || normalizePeerId(r.from) !== r.from) return null;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null;
  return {
    cid: r.cid,
    name: cleanText(r.name, MAX_SHARE_NAME_LENGTH) || r.cid,
    size: cleanSize(r.size),
    from: r.from,
    fromName: cleanText(r.fromName, MAX_NAME_LENGTH),
    ts: r.ts,
    pinned: r.pinned === true,
  };
}

/** Validate a persisted received list: invalid entries dropped, deduped on (from, cid), newest first, ≤ 100. */
export function sanitizeReceived(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list.map(validReceived).filter(Boolean).sort((a, b) => b.ts - a.ts)) {
    if (out.some((x) => x.from === r.from && x.cid === r.cid)) continue;
    out.push(r);
    if (out.length >= MAX_RECEIVED) break;
  }
  return out;
}

/** Validate a persisted seen list ([{ from, cid, ts }], ts = the sender's share ts). */
export function sanitizeSeen(list, now) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const sorted = list
    .filter((s) => s && isValidCid(s.cid) && normalizePeerId(s.from) === s.from && typeof s.ts === 'number' && Number.isFinite(s.ts))
    .sort((a, b) => b.ts - a.ts);
  for (const s of sorted) {
    if (now - s.ts > SEEN_MAX_AGE_MS) continue;
    if (out.some((x) => x.from === s.from && x.cid === s.cid)) continue;
    out.push({ from: s.from, cid: s.cid, ts: s.ts });
    if (out.length >= MAX_SEEN) break;
  }
  return out;
}

/**
 * Merge the shares of one presence into the received list.
 * Dedupe is on (from, cid): a share already received — or received earlier and dismissed (it is
 * still in `seen`) — is not added again, unless the sender re-offered it with a newer ts, in which
 * case the entry is refreshed (keeping its pinned flag) and reported as added.
 * @param {{ received: object[], seen: object[] }} state
 * @param {Array<{ cid: string, name: string, size: number|null, ts: number }>} shares  validated shares
 * @param {{ from: string, fromName: string, now: number }} ctx
 * @returns {{ received: object[], seen: object[], added: object[] }} new arrays; `added` are the new/refreshed received entries
 */
export function mergeReceived({ received = [], seen = [] }, shares, { from, fromName, now }) {
  let nextReceived = received.slice();
  let nextSeen = seen.slice();
  const added = [];
  for (const s of shares) {
    const prior = nextSeen.find((x) => x.from === from && x.cid === s.cid);
    if (prior && prior.ts >= s.ts) continue;
    const existing = nextReceived.find((x) => x.from === from && x.cid === s.cid);
    const entry = {
      cid: s.cid,
      name: cleanText(s.name, MAX_SHARE_NAME_LENGTH) || s.cid,
      size: cleanSize(s.size),
      from,
      fromName: cleanText(fromName, MAX_NAME_LENGTH),
      ts: s.ts,
      pinned: existing?.pinned === true,
    };
    nextReceived = [entry, ...nextReceived.filter((x) => x !== existing)];
    nextSeen = [{ from, cid: s.cid, ts: s.ts }, ...nextSeen.filter((x) => x !== prior)];
    added.push(entry);
  }
  if (!added.length) return { received, seen, added };
  nextReceived.sort((a, b) => b.ts - a.ts);
  const capped = nextReceived.slice(0, MAX_RECEIVED);
  return { received: capped, seen: sanitizeSeen(nextSeen, now), added: added.filter((a) => capped.includes(a)) };
}

/** Remove one received entry (does not touch `seen`, so the share does not come back). */
export function dismissReceived(received, { cid, from }) {
  return received.filter((r) => !(r.cid === cid && r.from === from));
}

/* ---------------- windows ---------------- */

/** A device is online when its presence arrived within the last 90 s. */
export function isOnline(lastSeen, now) {
  return typeof lastSeen === 'number' && now - lastSeen <= ONLINE_WINDOW_MS;
}

/** A discovered (unpaired) device stays listed for 5 min after its last presence. */
export function isDiscoveredFresh(lastSeen, now) {
  return typeof lastSeen === 'number' && now - lastSeen <= DISCOVERED_WINDOW_MS;
}

/**
 * Drop stale entries from a discovered map (peerId → { lastSeen, … }) in place; returns the map.
 * @template {{ lastSeen: number }} T
 * @param {Map<string, T>} map
 * @param {number} now
 */
export function pruneDiscovered(map, now) {
  for (const [id, d] of map) if (!isDiscoveredFresh(d.lastSeen, now)) map.delete(id);
  return map;
}

/** True when two address lists contain the same set of strings. */
export function sameAddrSet(a, b) {
  const A = new Set(a || []);
  const B = new Set(b || []);
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

/**
 * Kubo `Peering.Peers` entries for the paired devices, merged into an existing list: entries for
 * peer IDs we manage (`managedIds`, i.e. paired now or just unpaired) are replaced, others kept.
 * @param {unknown} existing  current config value (may be null)
 * @param {Array<{ peerId: string, addrs: string[] }>} peers
 * @param {Iterable<string>} [managedIds]
 * @returns {Array<{ ID: string, Addrs: string[] }>}
 */
export function mergePeeringPeers(existing, peers, managedIds = []) {
  const managed = new Set([...managedIds, ...peers.map((p) => p.peerId)]);
  const kept = (Array.isArray(existing) ? existing : []).filter((e) => e && typeof e.ID === 'string' && !managed.has(e.ID));
  return [...kept, ...peers.map((p) => ({ ID: p.peerId, Addrs: sanitizeAddrs(p.addrs) }))];
}
