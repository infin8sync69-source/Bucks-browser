// Devices service: pairing Bucks installs over Kubo peering + pubsub (docs/IPC-CONTRACT.md,
// "Devices"). No Electron import; every dependency is injected so it runs under plain node.
//
// While the Kubo node is ready the service
//   * subscribes to the 'bucks-devices-v1' topic with a streaming POST (pubsub/sub) and reads
//     NDJSON incrementally, resubscribing with backoff when the stream ends;
//   * publishes this device's presence (name, platform, version, addrs, outbox) right after
//     subscribing, every 30 s, and after pair / unpair / rename / share (plus one follow-up a few
//     seconds after subscribing, pairing or a paired device connecting, since messages sent
//     before the gossip mesh forms are lost);
//   * polls swarm/peers every 15 s to know which paired devices are connected;
//   * records shares from paired devices into `received` (and pins them when autoPin is on).
// Pairings live in settings.ipfs.peers; the outbox / received lists in <userData>/devices.json.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  TOPIC,
  TOPIC_ARG,
  MAX_NAME_LENGTH,
  MAX_SHARE_NAME_LENGTH,
  buildPresence,
  encodePresence,
  parseMessage,
  parsePairInput,
  shareableAddrs,
  sanitizeAddrs,
  sameAddrSet,
  pruneOutbox,
  addToOutbox,
  sanitizeReceived,
  sanitizeSeen,
  mergeReceived,
  dismissReceived,
  isOnline,
  pruneDiscovered,
  mergePeeringPeers,
  isValidCid,
  normalizePeerId,
  cleanText,
  cleanSize,
} from './devices-core.js';

export const PRESENCE_INTERVAL_MS = 30_000;
export const SWARM_POLL_INTERVAL_MS = 15_000;
export const SUBSCRIBE_BACKOFF_MS = [1000, 2000, 5000, 10_000];
export const PUBSUB_DISABLED_RETRY_MS = 30_000;
export const EMIT_MIN_INTERVAL_MS = 250; // ≤ 4 status events per second
export const TRANSIENT_ERROR_MS = 15_000;
const PIN_RETRY_MS = 5 * 60 * 1000;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_DISCOVERED = 64;
const LIVE_CALL_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 30_000;
/**
 * Messages published before the gossip mesh forms (1-3 s after two peers connect and subscribe)
 * are lost, so a presence sent on subscribe / pair / new connection is repeated once after this.
 */
export const FOLLOW_UP_PUBLISH_MS = 4000;

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
};

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** True when a Kubo error says pubsub is not enabled on the node. */
export function isPubsubDisabledError(message) {
  return /pubsub.*not enabled|enable-pubsub-experiment|pubsub is disabled/i.test(String(message || ''));
}

/** Readable message from a Kubo error body ({ Message } JSON or plain text). */
async function kuboErrorText(res) {
  let text = '';
  try { text = await res.text(); } catch { /* unreadable */ }
  try {
    const j = JSON.parse(text);
    if (j && typeof j.Message === 'string' && j.Message) return j.Message;
  } catch { /* not JSON */ }
  return text.trim().slice(0, 300) || res.statusText || `HTTP ${res.status}`;
}

/**
 * Create the devices service.
 * @param {{
 *   kubo: { isReady(): boolean, onStatus(cb: Function): Function, apiUrl(): string|null, rpc: any, status?(): any },
 *   settings: { get(): any, set(patch: object): any, onChange?(cb: Function): Function },
 *   userData: string,
 *   appVersion: string,
 *   platform: string,
 *   hostname: string,
 *   emit?: (status: object) => void,
 *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
 *   now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
 *   fetch?: typeof fetch,
 * }} deps
 * @returns {{ status(): object, pair(input: { peerId: string, name?: string, addrs?: string[] }): Promise<object>,
 *             unpair(peerId: string): Promise<object>, rename(name: string): Promise<object>,
 *             share(s: { cid: string, name?: string, size?: number }): Promise<{ queued: true, onlinePeers: number }>,
 *             dismiss(d: { cid: string, from: string }): Promise<object>, stop(): Promise<void> }}
 */
export function createDevicesService({
  kubo,
  settings,
  userData,
  appVersion = '',
  platform = process.platform,
  hostname = 'bucks',
  emit = () => {},
  log = noopLog,
  now = () => Date.now(),
  timers = defaultTimers,
  fetch: fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const file = path.join(userData, 'devices.json');

  /* ---------- state ---------- */
  let selfPeerId = kubo.status?.()?.peer_id || null;
  let selfAddrs = [];
  let subscribed = false;
  let subscribeError = null; // persistent (e.g. pubsub disabled)
  let transientError = null; // brief (failed live peering call…)
  let transientTimer = null;
  /** paired peerId → { name, platform, version, addrs, lastSeen, shareCids } learned from presence */
  const presences = new Map();
  /** unpaired peerId → { peerId, name, platform, version, lastSeen, addrs } */
  const discovered = new Map();
  let connected = new Set();
  const pinning = new Map(); // `${from} ${cid}` → last attempt time
  let stopped = false;

  let { outbox, received, seen } = loadState();

  /* ---------- persistence ---------- */

  function loadState() {
    const empty = { outbox: [], received: [], seen: [] };
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn(`Could not read ${file}: ${e.message}; starting with no shares`);
      return empty;
    }
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
      const t = now();
      const rec = sanitizeReceived(j.received);
      return {
        outbox: pruneOutbox(j.outbox, t),
        received: rec,
        // every received share counts as seen, so a dismissed share never comes back
        seen: sanitizeSeen([...(Array.isArray(j.seen) ? j.seen : []), ...rec.map((r) => ({ from: r.from, cid: r.cid, ts: r.ts }))], t),
      };
    } catch (e) {
      log.warn(`${file} is corrupt (${e.message}); starting with no shares`);
      return empty;
    }
  }

  let writing = null;
  let writeAgain = false;
  function persist() {
    if (writing) { writeAgain = true; return writing; }
    writing = (async () => {
      do {
        writeAgain = false;
        const data = JSON.stringify({ outbox, received, seen }, null, 2);
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          await fsp.mkdir(path.dirname(file), { recursive: true });
          await fsp.writeFile(tmp, data);
          await fsp.rename(tmp, file);
        } catch (e) {
          log.error(`Failed to write ${file}: ${e.message}`);
          try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
        }
      } while (writeAgain);
    })().finally(() => { writing = null; });
    return writing;
  }

  /* ---------- status + throttled emit ---------- */

  function selfName() {
    const n = cleanText(settings.get()?.devices?.name, MAX_NAME_LENGTH);
    return n || cleanText(hostname, MAX_NAME_LENGTH) || 'Bucks device';
  }

  function pairedPeers() {
    const list = settings.get()?.ipfs?.peers;
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const p of list) {
      const peerId = normalizePeerId(p?.peerId);
      if (!peerId || out.some((x) => x.peerId === peerId)) continue;
      out.push({ peerId, name: cleanText(p.name, MAX_NAME_LENGTH), addrs: sanitizeAddrs(p.addrs) });
    }
    return out;
  }

  function status() {
    const t = now();
    pruneDiscovered(discovered, t);
    const paired = pairedPeers().map((p) => {
      const pr = presences.get(p.peerId);
      return {
        peerId: p.peerId,
        name: p.name || pr?.name || `${p.peerId.slice(0, 8)}…${p.peerId.slice(-4)}`,
        platform: pr?.platform || null,
        version: pr?.version || null,
        online: isOnline(pr?.lastSeen, t),
        connected: connected.has(p.peerId),
        lastSeen: pr?.lastSeen ?? null,
        addrs: p.addrs,
      };
    });
    return {
      ready: subscribed && kubo.isReady(),
      error: subscribeError || transientError || null,
      topic: TOPIC,
      self: { peerId: selfPeerId, name: selfName(), platform, version: appVersion, addrs: selfAddrs.slice() },
      paired,
      discovered: [...discovered.values()].sort((a, b) => b.lastSeen - a.lastSeen).map((d) => ({ ...d, addrs: d.addrs.slice() })),
      received: received.map((r) => ({ ...r })),
    };
  }

  let emitTimer = null;
  let lastEmit = -Infinity;
  let lastEmitted = '';
  function doEmit() {
    emitTimer = null;
    const st = status();
    const json = JSON.stringify(st);
    if (json === lastEmitted) return; // nothing visible changed (e.g. a no-op swarm poll)
    lastEmitted = json;
    lastEmit = now();
    try { emit(st); } catch (e) { log.error('devices status listener failed:', e?.message || e); }
  }
  /** Schedule a status event: at most one per 250 ms, always followed by a trailing one. */
  function changed() {
    if (stopped || emitTimer) return;
    const wait = Math.max(0, EMIT_MIN_INTERVAL_MS - (now() - lastEmit));
    emitTimer = timers.setTimeout(doEmit, wait);
  }

  function setTransientError(message) {
    transientError = message;
    if (transientTimer) timers.clearTimeout(transientTimer);
    transientTimer = timers.setTimeout(() => { transientTimer = null; transientError = null; changed(); }, TRANSIENT_ERROR_MS);
    changed();
  }

  function onlinePeers() {
    const t = now();
    return pairedPeers().filter((p) => isOnline(presences.get(p.peerId)?.lastSeen, t)).length;
  }

  /* ---------- session (one per "node ready" period) ---------- */

  /** @type {null | { rpc: any, apiUrl: string, abort: AbortController, timers: Set<any>, intervals: Set<any>, alive: boolean, followUp: any }} */
  let session = null;

  function sessionTimeout(s, fn, ms) {
    const t = timers.setTimeout(() => { s.timers.delete(t); if (s.alive) fn(); }, ms);
    s.timers.add(t);
    return t;
  }

  function sessionInterval(s, fn, ms) {
    const t = timers.setInterval(() => { if (s.alive) fn(); }, ms);
    s.intervals.add(t);
    return t;
  }

  function onKuboStatus() {
    if (stopped) return;
    const ready = kubo.isReady() && kubo.rpc && kubo.apiUrl();
    if (ready && session && (session.rpc !== kubo.rpc || session.apiUrl !== kubo.apiUrl())) endSession();
    if (ready && !session) startSession();
    else if (!ready && session) endSession();
  }

  function startSession() {
    const s = { rpc: kubo.rpc, apiUrl: kubo.apiUrl(), abort: new AbortController(), timers: new Set(), intervals: new Set(), alive: true, followUp: null };
    session = s;
    log.info('IPFS node ready: joining the devices topic');
    (async () => {
      await refreshSelf(s, { retryUntilKnown: true });
      if (!s.alive) return;
      applyPeeringOnStart(s);
      subscribeLoop(s, 0);
      pollSwarm(s);
      sessionInterval(s, () => pollSwarm(s), SWARM_POLL_INTERVAL_MS);
      sessionInterval(s, async () => {
        await refreshSelf(s);
        publishPresence();
      }, PRESENCE_INTERVAL_MS);
    })().catch((e) => log.error('devices session failed to start:', e?.message || e));
  }

  function endSession() {
    const s = session;
    if (!s) return;
    session = null;
    s.alive = false;
    s.abort.abort();
    for (const t of s.timers) timers.clearTimeout(t);
    for (const t of s.intervals) timers.clearInterval(t);
    s.timers.clear();
    s.intervals.clear();
    subscribed = false;
    subscribeError = null;
    connected = new Set();
    changed();
  }

  async function refreshSelf(s, { retryUntilKnown = false } = {}) {
    for (let attempt = 0; s.alive; attempt += 1) {
      try {
        const ident = await s.rpc.id();
        if (!s.alive) return;
        const id = normalizePeerId(ident?.ID);
        const addrs = shareableAddrs(ident?.Addresses);
        if (id !== selfPeerId || !sameAddrSet(addrs, selfAddrs)) {
          selfPeerId = id;
          selfAddrs = addrs;
          changed();
        }
        return;
      } catch (e) {
        if (!retryUntilKnown) { log.debug?.(`id refresh failed: ${e.message}`); return; }
        log.warn(`Could not read the node identity (${e.message}); retrying`);
        await new Promise((r) => sessionTimeout(s, r, SUBSCRIBE_BACKOFF_MS[Math.min(attempt, SUBSCRIBE_BACKOFF_MS.length - 1)]));
      }
    }
  }

  /** Make sure the paired peers are in the live peering set (covers external nodes, whose config kubo.js does not manage). */
  async function applyPeeringOnStart(s) {
    for (const p of pairedPeers()) {
      if (!s.alive) return;
      await peeringAdd(s, p).catch((e) => log.warn(`peering ${p.peerId}: ${e.message}`));
    }
  }

  /** swarm/peering/add every known addr; with none, ask Kubo to find the peer (mDNS / routing) in the background. */
  async function peeringAdd(s, { peerId, addrs }) {
    if (addrs.length === 0) {
      s.rpc.call('swarm/connect', { args: [`/p2p/${peerId}`], timeoutMs: CONNECT_TIMEOUT_MS })
        .catch((e) => log.debug?.(`swarm/connect ${peerId}: ${e.message}`));
      return;
    }
    for (const a of addrs) {
      await s.rpc.call('swarm/peering/add', { args: [`${a}/p2p/${peerId}`], timeoutMs: LIVE_CALL_TIMEOUT_MS });
    }
  }

  /* ---------- subscription ---------- */

  async function subscribeLoop(s, failures) {
    if (!s.alive) return;
    let retryMs = SUBSCRIBE_BACKOFF_MS[Math.min(failures, SUBSCRIBE_BACKOFF_MS.length - 1)];
    let nextFailures = failures + 1;
    try {
      const res = await fetchImpl(`${s.apiUrl}/api/v0/pubsub/sub?arg=${TOPIC_ARG}`, { method: 'POST', signal: s.abort.signal });
      if (!res.ok) {
        const msg = await kuboErrorText(res);
        if (isPubsubDisabledError(msg)) {
          const external = kubo.status?.()?.embedded === false;
          subscribeError = external
            ? 'Pubsub is disabled on the external IPFS node. Set Pubsub.Enabled to true in its config and restart it.'
            : 'Pubsub is disabled on the IPFS node. Restart the node so Bucks can enable it.';
          retryMs = PUBSUB_DISABLED_RETRY_MS;
          nextFailures = failures;
        } else {
          subscribeError = `Could not subscribe to the devices topic: ${msg}`;
        }
        changed();
        throw Object.assign(new Error(msg), { handled: true });
      }
      if (!s.alive) { try { await res.body?.cancel(); } catch { /* ignore */ } return; }
      subscribed = true;
      subscribeError = null;
      nextFailures = 0;
      retryMs = SUBSCRIBE_BACKOFF_MS[0];
      changed();
      log.info(`Subscribed to pubsub topic ${TOPIC}`);
      announce();
      await readStream(s, res);
      if (s.alive) log.warn('pubsub subscription stream ended; resubscribing');
    } catch (e) {
      if (!s.alive) return;
      if (!e.handled) log.warn(`pubsub subscription failed: ${e?.cause?.message || e?.message || e}`);
    }
    if (!s.alive) return;
    if (subscribed) { subscribed = false; changed(); }
    sessionTimeout(s, () => subscribeLoop(s, nextFailures), retryMs);
  }

  async function readStream(s, res) {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let skipping = false; // inside an over-long line: drop until the next newline
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !s.alive) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (skipping) { skipping = false; continue; }
          if (line.trim()) handleLine(line);
        }
        if (buf.length > MAX_LINE_BYTES) { buf = ''; skipping = true; }
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
  }

  function handleLine(line) {
    const msg = parseMessage(line, { selfPeerId });
    if (!msg) return;
    const t = now();
    const paired = pairedPeers().find((p) => p.peerId === msg.peerId);
    if (!paired) {
      discovered.set(msg.peerId, { peerId: msg.peerId, name: msg.name, platform: msg.platform, version: msg.version, lastSeen: t, addrs: msg.addrs });
      if (discovered.size > MAX_DISCOVERED) {
        const oldest = [...discovered.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        discovered.delete(oldest.peerId);
      }
      changed();
      return;
    }
    discovered.delete(msg.peerId);
    presences.set(msg.peerId, {
      name: msg.name, platform: msg.platform, version: msg.version, addrs: msg.addrs, lastSeen: t,
      shareCids: new Set(msg.shares.map((x) => x.cid)),
    });

    const merged = mergeReceived({ received, seen }, msg.shares, { from: msg.peerId, fromName: paired.name || msg.name, now: t });
    if (merged.added.length) {
      received = merged.received;
      seen = merged.seen;
      log.info(`Received ${merged.added.length} share(s) from ${paired.name || msg.name || msg.peerId}`);
      persist();
    }
    if (settings.get()?.devices?.autoPin) autoPin(msg.peerId, presences.get(msg.peerId).shareCids);

    // Keep the stored addrs (and so Kubo's Peering) in step with what the device advertises.
    if (msg.addrs.length && !sameAddrSet(msg.addrs, paired.addrs)) {
      updatePeers((peers) => peers.map((p) => (p.peerId === msg.peerId ? { ...p, addrs: msg.addrs } : p)));
      const s = session;
      if (s) {
        (async () => {
          await peeringAdd(s, { peerId: msg.peerId, addrs: msg.addrs });
          await writePeeringConfig(s, []);
        })().catch((e) => log.warn(`Could not update peering for ${msg.peerId}: ${e.message}`));
      }
    }
    changed();
  }

  function autoPin(from, offered) {
    const s = session;
    if (!s) return;
    const t = now();
    for (const r of received) {
      if (r.from !== from || r.pinned || !offered.has(r.cid)) continue;
      const key = `${r.from} ${r.cid}`;
      const last = pinning.get(key);
      if (last !== undefined && (last === Infinity || t - last < PIN_RETRY_MS)) continue;
      pinning.set(key, Infinity); // in flight
      s.rpc.pinAdd(r.cid).then(() => {
        pinning.delete(key);
        const entry = received.find((x) => x.from === r.from && x.cid === r.cid);
        if (entry && !entry.pinned) {
          received = received.map((x) => (x === entry ? { ...x, pinned: true } : x));
          persist();
          changed();
        }
        log.info(`Pinned ${r.cid} shared by ${r.fromName || r.from}`);
      }, (e) => {
        pinning.set(key, now());
        log.warn(`Auto-pin of ${r.cid} failed: ${e.message}`);
      });
    }
  }

  /* ---------- publishing ---------- */

  let publishing = null;
  let publishAgain = false;
  /** Publish presence now (coalesced: concurrent requests collapse into one follow-up publish). */
  function publishPresence() {
    if (!session || !subscribed) return Promise.resolve(false);
    if (publishing) { publishAgain = true; return publishing; }
    publishing = (async () => {
      let ok = false;
      do {
        publishAgain = false;
        const s = session;
        if (!s || !subscribed || !selfPeerId) break;
        outbox = pruneOutbox(outbox, now());
        const presence = buildPresence({
          peerId: selfPeerId,
          name: selfName(),
          platform,
          version: appVersion,
          addrs: selfAddrs,
          shares: outbox,
          ts: now(),
        });
        const form = new FormData();
        form.append('file', new Blob([encodePresence(presence)], { type: 'application/json' }), 'presence.json');
        try {
          await s.rpc.call('pubsub/pub', { args: [TOPIC_ARG], body: form, timeoutMs: LIVE_CALL_TIMEOUT_MS });
          ok = true;
        } catch (e) {
          if (s.alive) log.warn(`Could not publish presence: ${e.message}`);
        }
      } while (publishAgain);
      return ok;
    })().finally(() => { publishing = null; });
    return publishing;
  }

  /** Publish now and once more shortly after, to cover messages lost while the gossip mesh forms. */
  function announce() {
    publishPresence();
    const s = session;
    if (!s || s.followUp) return;
    s.followUp = sessionTimeout(s, () => { s.followUp = null; publishPresence(); }, FOLLOW_UP_PUBLISH_MS);
  }

  /* ---------- swarm ---------- */

  async function pollSwarm(s) {
    try {
      const peers = await s.rpc.swarmPeers();
      if (!s.alive) return;
      const next = new Set(peers.map((p) => p.peer).filter(Boolean));
      const newlyConnected = pairedPeers().some((p) => next.has(p.peerId) && !connected.has(p.peerId));
      connected = next;
      if (newlyConnected) announce(); // a paired device just (re)connected: tell it about us soon
    } catch (e) {
      if (s.alive) log.debug?.(`swarm/peers failed: ${e.message}`);
    }
    // Also re-evaluates the time-based online / discovered flags; emits only if something changed.
    if (s.alive) changed();
  }

  /* ---------- settings helpers ---------- */

  function updatePeers(fn) {
    const current = pairedPeers();
    const next = fn(current);
    settings.set({ ipfs: { peers: next.map((p) => ({ peerId: p.peerId, name: p.name, addrs: p.addrs })) } });
  }

  async function writePeeringConfig(s, removedIds) {
    let existing = null;
    try { existing = await s.rpc.configGet('Peering.Peers'); } catch { existing = null; }
    const value = mergePeeringPeers(existing, pairedPeers(), removedIds);
    await s.rpc.configSet('Peering.Peers', value);
  }

  /* ---------- public API ---------- */

  async function pair(input) {
    if (!input || typeof input !== 'object') throw new Error('pair() expects { peerId, name?, addrs? }');
    const parsed = parsePairInput(input.peerId);
    const { peerId } = parsed;
    if (selfPeerId && peerId === selfPeerId) throw new Error('This is the peer ID of this device; pair with the other device\'s peer ID');
    if (input.addrs !== undefined && !Array.isArray(input.addrs)) throw new Error('addrs must be an array of multiaddrs');
    if (input.name !== undefined && input.name !== null && typeof input.name !== 'string') throw new Error('name must be a string');
    const learned = presences.get(peerId) || discovered.get(peerId);
    const existing = pairedPeers().find((p) => p.peerId === peerId);
    let addrs = sanitizeAddrs([...parsed.addrs, ...(input.addrs || [])]);
    if (!addrs.length) addrs = learned?.addrs?.slice() || existing?.addrs || [];
    const name = cleanText(input.name, MAX_NAME_LENGTH) || learned?.name || existing?.name || '';

    updatePeers((peers) => [...peers.filter((p) => p.peerId !== peerId), { peerId, name, addrs }]);
    if (learned && !presences.has(peerId)) {
      presences.set(peerId, { name: learned.name, platform: learned.platform, version: learned.version, addrs: learned.addrs, lastSeen: learned.lastSeen, shareCids: new Set() });
    }
    discovered.delete(peerId);
    log.info(`Paired with ${name || peerId} (${addrs.length} address${addrs.length === 1 ? '' : 'es'})`);
    changed();

    const s = session;
    if (s) {
      const failures = [];
      for (const a of addrs) {
        try {
          await s.rpc.call('swarm/peering/add', { args: [`${a}/p2p/${peerId}`], timeoutMs: LIVE_CALL_TIMEOUT_MS });
        } catch (e) {
          failures.push(`peering ${a}: ${e.kuboMessage || e.message}`);
        }
      }
      if (!addrs.length) {
        // No address known: let Kubo find the peer (mDNS / routing) in the background.
        s.rpc.call('swarm/connect', { args: [`/p2p/${peerId}`], timeoutMs: CONNECT_TIMEOUT_MS })
          .then(() => pollSwarm(s))
          .catch((e) => { if (s.alive) setTransientError(`Paired, but could not reach ${name || peerId} yet: ${e.kuboMessage || e.message}`); });
      }
      try {
        await writePeeringConfig(s, []);
      } catch (e) {
        failures.push(`config Peering.Peers: ${e.kuboMessage || e.message}`);
      }
      if (failures.length) setTransientError(`Paired, but the IPFS node rejected: ${failures.join('; ')}`);
      announce();
      sessionTimeout(s, () => pollSwarm(s), 3000);
    }
    return status();
  }

  async function unpair(peerIdInput) {
    const peerId = normalizePeerId(peerIdInput);
    if (!peerId) throw new Error('unpair() needs a valid peer ID');
    updatePeers((peers) => peers.filter((p) => p.peerId !== peerId));
    presences.delete(peerId);
    for (const key of [...pinning.keys()]) if (key.startsWith(`${peerId} `)) pinning.delete(key);
    log.info(`Unpaired ${peerId}`);
    changed();
    const s = session;
    if (s) {
      const failures = [];
      try {
        await s.rpc.call('swarm/peering/rm', { args: [peerId], timeoutMs: LIVE_CALL_TIMEOUT_MS });
      } catch (e) {
        failures.push(`peering rm: ${e.kuboMessage || e.message}`);
      }
      try {
        await writePeeringConfig(s, [peerId]);
      } catch (e) {
        failures.push(`config Peering.Peers: ${e.kuboMessage || e.message}`);
      }
      if (failures.length) setTransientError(`Unpaired, but the IPFS node rejected: ${failures.join('; ')}`);
      publishPresence();
    }
    return status();
  }

  async function rename(nameInput) {
    if (typeof nameInput !== 'string') throw new Error('name must be a string');
    const name = cleanText(nameInput, MAX_NAME_LENGTH);
    settings.set({ devices: { name } });
    changed();
    if (!unsubscribeSettings) publishPresence(); // otherwise the settings listener below publishes
    return status();
  }

  async function share({ cid, name, size } = {}) {
    const c = typeof cid === 'string' ? cid.trim() : '';
    if (!isValidCid(c)) throw new Error(`Not a valid CID: ${String(cid).slice(0, 100)}`);
    if (name !== undefined && name !== null && typeof name !== 'string') throw new Error('name must be a string');
    if (size !== undefined && size !== null && cleanSize(size) === null) throw new Error('size must be a non-negative integer');
    outbox = addToOutbox(outbox, { cid: c, name: cleanText(name, MAX_SHARE_NAME_LENGTH) || c, size: cleanSize(size) }, now());
    persist();
    changed();
    publishPresence();
    return { queued: true, onlinePeers: onlinePeers() };
  }

  async function dismiss({ cid, from } = {}) {
    if (typeof cid !== 'string' || !cid) throw new Error('dismiss() needs a cid');
    if (typeof from !== 'string' || !from) throw new Error('dismiss() needs the sender peer ID (from)');
    const next = dismissReceived(received, { cid: cid.trim(), from: from.trim() });
    if (next.length !== received.length) {
      received = next;
      persist();
      changed();
    }
    return status();
  }

  async function stop() {
    if (stopped) return writing || undefined;
    endSession();
    stopped = true;
    unsubscribeKubo?.();
    unsubscribeSettings?.();
    if (emitTimer) { timers.clearTimeout(emitTimer); emitTimer = null; }
    if (transientTimer) { timers.clearTimeout(transientTimer); transientTimer = null; }
    try { emit(status()); } catch { /* listener gone */ }
    if (publishing) await publishing.catch(() => {});
    if (writing) await writing;
  }

  const unsubscribeKubo = kubo.onStatus(() => onKuboStatus());
  // A paired device's addrs or the device name may change from elsewhere (settings page).
  let lastSettingsKey = JSON.stringify([settings.get()?.ipfs?.peers, settings.get()?.devices]);
  const unsubscribeSettings = typeof settings.onChange === 'function'
    ? settings.onChange((all) => {
      const key = JSON.stringify([all?.ipfs?.peers, all?.devices]);
      if (key === lastSettingsKey) return;
      const nameChanged = JSON.stringify(all?.devices?.name) !== JSON.stringify(JSON.parse(lastSettingsKey)[1]?.name);
      lastSettingsKey = key;
      changed();
      if (nameChanged) publishPresence();
    })
    : null;
  onKuboStatus();

  return {
    status, pair, unpair, rename, share, dismiss, stop,
    /** @internal resolves once pending devices.json writes are on disk (tests, diagnostics) */
    _flush: () => writing || Promise.resolve(),
  };
}
