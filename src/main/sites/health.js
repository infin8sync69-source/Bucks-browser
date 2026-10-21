// Health of a hosted site (docs/IPFS-HOSTING-IMPLEMENTATION.md §9.1): the highest state reached,
// in order, and the one check that failed. Run only when asked; the outside checks send the CID
// (and nothing else) to a public delegated router and, when configured, an outside probe.
// No Electron imports.

import { createHash } from 'node:crypto';
import { CID } from 'multiformats/cid';

export const HEALTH_STATES = Object.freeze(['local-only', 'announcing', 'discoverable', 'reachable', 'redundant']);
const TIMEOUT_MS = 15_000;
const SHA2_256 = 0x12;
const MAX_PROBE_BYTES = 2 * 1024 * 1024;

const LABELS = {
  'local-only': 'Only this computer can open it.',
  announcing: 'Others may find it soon.',
  discoverable: 'Others can find the host.',
  reachable: 'Others can fetch the content.',
  redundant: 'Survives this computer going to sleep.',
};

/** Providers a delegated router (/routing/v1/providers/<cid>) lists for a CID. @returns {Promise<string[]>} peer IDs */
export async function routerProviders(fetchImpl, routerUrl, cid) {
  const res = await fetchImpl(`${String(routerUrl).replace(/\/+$/, '')}/routing/v1/providers/${cid}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`the router answered ${res.status}`);
  const j = await res.json();
  return [...new Set((Array.isArray(j?.Providers) ? j.Providers : []).map((p) => p?.ID).filter((id) => typeof id === 'string'))];
}

/**
 * Fetch the root block from outside through a trustless gateway (?format=raw) and check it hashes
 * to the CID, so a gateway cannot fake success.
 */
export async function probeRootBlock(fetchImpl, probeUrl, cid) {
  const res = await fetchImpl(`${String(probeUrl).replace(/\/+$/, '')}/ipfs/${cid}?format=raw`, {
    headers: { accept: 'application/vnd.ipld.raw' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`the probe answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_PROBE_BYTES) throw new Error('the probe returned too much data');
  const parsed = CID.parse(cid);
  if (parsed.multihash.code !== SHA2_256) return true; // only sha2-256 is checked here
  const digest = createHash('sha256').update(bytes).digest();
  if (!Buffer.from(parsed.multihash.digest).equals(digest)) throw new Error('the probe returned a block that does not match the CID');
  return true;
}

/**
 * @param {{
 *   cid: string,
 *   node: { ready: boolean, online: boolean, peerId: string|null, pinned: boolean, connectivity: string|null },
 *   lastAnnounce?: { ok: boolean, error?: string|null } | null,
 *   fetchImpl?: typeof fetch, routerUrl?: string, probeUrl?: string,
 *   remotePins?: Array<{ service: string, status: string }>,
 * }} input
 * @returns {Promise<{ state: string|null, label: string, checks: Array<{ id: string, ok: boolean|null, detail: string }>,
 *   failing: { id: string, message: string } | null, providers: number|null, remotePins: Array<{ service: string, status: string }> }>}
 */
export async function checkHealth({ cid, node, lastAnnounce = null, fetchImpl = (...a) => globalThis.fetch(...a), routerUrl, probeUrl, remotePins = [] }) {
  const checks = [];
  let state = null;
  let failing = null;
  let providers = null;
  const fail = (id, message) => { failing = { id, message }; checks.push({ id, ok: false, detail: message }); };
  const done = () => ({ state, label: state ? LABELS[state] : 'Not stored on this computer.', checks, failing, providers, remotePins });

  // 1. local copy
  if (!node.ready) { fail('local', 'Your IPFS node is not running. Start it to host your sites.'); return done(); }
  if (!node.pinned) { fail('local', 'This version is not pinned on this computer any more.'); return done(); }
  checks.push({ id: 'local', ok: true, detail: 'Pinned on this computer.' });
  state = 'local-only';

  // 2. announcing
  if (!node.online) { fail('announcing', 'Your node runs offline, so nothing is announced to the network.'); return done(); }
  if (node.connectivity === 'offline' && !lastAnnounce?.ok) {
    fail('announcing', `Your site is saved on this computer but other people cannot reach it yet. Check your network or add a pinning option.${lastAnnounce?.error ? ` (${lastAnnounce.error})` : ''}`);
    return done();
  }
  checks.push({ id: 'announcing', ok: true, detail: 'This node announces the site to the network.' });
  state = 'announcing';

  // 3. discoverable: a public delegated router lists this node as a provider
  let listed = [];
  if (!routerUrl) {
    checks.push({ id: 'discoverable', ok: null, detail: 'No delegated router configured (Settings: sites.routerUrl).' });
  } else {
    try {
      listed = await routerProviders(fetchImpl, routerUrl, cid);
      providers = listed.length;
    } catch (e) {
      fail('discoverable', `Could not ask the public router (${e.message}).`);
      return done();
    }
    if (!node.peerId || !listed.includes(node.peerId)) {
      fail('discoverable', 'The public router does not list this computer for your site yet. Announcing can take a few minutes.');
      return done();
    }
    checks.push({ id: 'discoverable', ok: true, detail: `Listed by the public router (${listed.length} provider${listed.length === 1 ? '' : 's'}).` });
    state = 'discoverable';
  }

  // 4. reachable: fetched from outside
  if (!probeUrl) {
    checks.push({ id: 'reachable', ok: null, detail: 'No outside probe configured (Settings: sites.probeUrl), so this was not tested.' });
  } else {
    try {
      await probeRootBlock(fetchImpl, probeUrl, cid);
    } catch (e) {
      fail('reachable', `Other people could not fetch your site from outside (${e.message}). Check your network or add a pinning option.`);
      return done();
    }
    checks.push({ id: 'reachable', ok: true, detail: 'Fetched from outside and verified.' });
    state = 'reachable';
  }

  // 5. redundant: another independent copy
  const others = listed.filter((id) => id !== node.peerId).length;
  const pinnedRemotely = remotePins.filter((p) => p.status === 'pinned').length;
  if (others + pinnedRemotely >= 1) {
    checks.push({ id: 'redundant', ok: true, detail: `${others + pinnedRemotely} other cop${others + pinnedRemotely === 1 ? 'y' : 'ies'}.` });
    state = 'redundant';
  } else {
    fail('redundant', 'Redundant: no. Only this computer keeps the site; add another device or a pinning service.');
  }
  return done();
}
