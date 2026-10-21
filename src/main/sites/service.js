// Sites service (docs/IPFS-HOSTING-IMPLEMENTATION.md §8): publish a folder from this browser as an
// ipfs:// version and an ipns:// address, update it after reviewing a diff, roll back, unpublish,
// preview, back up and restore the address key, export a CAR, and check health.
//
// The renderer never touches the file system or Kubo: it holds a folder token (issued after the
// main process's own folder dialog) or a site id. No Electron imports; Kubo, the ipfs:// handler,
// the devices service and the pinning services are injected.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inspectFolder, detectProject, DEFAULT_QUOTA_BYTES, DEFAULT_MAX_FILES } from './folder.js';
import { createSiteStore } from './store.js';
import { checkHealth } from './health.js';
import { readKeystoreKey, encryptKeyBackup, decryptKeyBackup } from './keys.js';
import { validatePublicGateway } from '../protocols/gateway-consent.js';

export const PUBLISH_STEPS = Object.freeze(['inspect', 'add', 'self-test', 'name', 'announce', 'record']);
export const UNPUBLISH_MODES = Object.freeze(['stop', 'unpin', 'delete-key']);
const MiB = 1024 * 1024;
const TOKEN_TTL_MS = 60 * 60_000;
const MAX_TOKENS = 32;
const PROVIDE_TIMEOUT_MS = 90_000;
const MAX_TREE_ENTRIES = 60_000;
const MAX_DIFF_LISTED = 200;
const MAX_NAME = 100;
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

const versionOf = (v) => ({ cid: v.cid, publishedAt: v.publishedAt, bytes: v.bytes, files: v.files, note: v.note || '' });

/** Readable error for a blocked inspection (the first unresolved blocking check). */
function blockedError(insp) {
  const first = insp.checks.find((c) => c.level === 'block' && !c.resolved);
  const err = new Error(first ? first.message : 'The checks found a problem that prevents publishing.');
  err.checks = insp.checks;
  return err;
}

/** Clean the one-click fixes and exclusions a request may carry. */
export function inspectOptions(p = {}) {
  const exclude = Array.isArray(p.exclude) ? p.exclude.filter((e) => typeof e === 'string' && e.length <= 1024).slice(0, 500) : [];
  return { exclude, useShellAsIndex: p.useShellAsIndex === true, enableSpa: p.enableSpa === true };
}

/** A gateway link for visitors without Bucks (§12.3): subdomain form, ipfs.io → dweb.link. */
export function gatewayLink(publicGateway, kind, value) {
  const gw = validatePublicGateway(publicGateway);
  let host = gw.ok ? new URL(gw.base).host : 'dweb.link';
  if (host === 'ipfs.io') host = 'dweb.link';
  return `https://${value}.${kind}.${host}/`;
}

/**
 * @param {{
 *   kubo: { isReady(): boolean, rpc: any, status(): any, repoPath?: () => string },
 *   settings: { get(): any },
 *   userData: string,
 *   handler: ((req: Request) => Promise<Response>) & { setPreview?: Function },   // the ipfs:// handler
 *   devices?: { share(s: { cid: string, name?: string, size?: number }): Promise<object> } | null,
 *   pinning?: ReturnType<typeof import('./pinning.js').createPinningServices> | null,
 *   emit?: (progress: { id: string, step: string, done: number, total: number, message: string }) => void,
 *   log?: object, now?: () => number, fetchImpl?: typeof fetch, openAsBlob?: typeof fs.openAsBlob, randomId?: () => string,
 * }} deps
 */
export function createSitesService({
  kubo, settings, userData, handler, devices = null, pinning = null, emit = () => {}, log = noopLog,
  now = () => Date.now(), fetchImpl = (...a) => globalThis.fetch(...a), openAsBlob = fs.openAsBlob,
  randomId = () => randomBytes(5).toString('hex'),
}) {
  const store = createSiteStore({ file: path.join(userData, 'sites.json'), log });
  const tokens = new Map(); // token → { dir, name, expires }
  const locks = new Map(); // site id → promise of the running operation

  function config() {
    const s = settings.get?.()?.sites || {};
    const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo ? Math.min(Math.floor(Number(v)), hi) : d);
    return {
      quotaBytes: num(s.quotaMiB, DEFAULT_QUOTA_BYTES / MiB, 1, 1024 * 1024) * MiB,
      maxFiles: num(s.maxFiles, DEFAULT_MAX_FILES, 1, 1_000_000),
      historyLimit: num(s.historyLimit, 5, 1, 50),
      routerUrl: typeof s.routerUrl === 'string' ? s.routerUrl.trim() : '',
      probeUrl: typeof s.probeUrl === 'string' ? s.probeUrl.trim() : '',
      publicGateway: settings.get?.()?.ipfs?.publicGateway,
    };
  }

  function rpc() {
    if (!kubo.isReady() || !kubo.rpc) throw new Error('Your IPFS node is not running. Start it to publish.');
    return kubo.rpc;
  }

  function requireSite(id) {
    const site = typeof id === 'string' ? store.get(id) : null;
    if (!site) throw new Error('No such site.');
    return site;
  }

  const progress = (id, step, done, total, message) => {
    try { emit({ id, step, done, total, message }); } catch (e) { log.warn(`progress event failed: ${e.message}`); }
  };

  async function withLock(id, fn) {
    if (locks.has(id)) throw new Error('This site is already being published. Wait for it to finish.');
    const p = fn();
    locks.set(id, p);
    try { return await p; } finally { locks.delete(id); }
  }

  /* ---------- folder tokens ---------- */

  function pruneTokens() {
    const t = now();
    for (const [k, v] of tokens) if (v.expires <= t) tokens.delete(k);
    while (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value);
  }

  function chosen(token) {
    const entry = typeof token === 'string' ? tokens.get(token) : null;
    if (!entry || entry.expires <= now()) throw new Error('Choose the folder again (the choice expired).');
    return entry;
  }
  const folderOf = (token) => chosen(token).dir;

  /* ---------- building blocks ---------- */

  async function inspect(dir, opts) {
    const { quotaBytes, maxFiles } = config();
    return inspectFolder(dir, { ...inspectOptions(opts), quotaBytes, maxFiles });
  }

  function inspectionSummary(insp) {
    return {
      files: insp.count,
      bytes: insp.bytes,
      checks: insp.checks,
      blocked: insp.blocked,
      excluded: insp.excluded.slice(0, MAX_DIFF_LISTED),
      entry: insp.descriptor.entry,
      spa: insp.descriptor.spa,
      folderName: path.basename(insp.root),
      options: insp.options,
    };
  }

  /** Blob for a file found by the walk; refused when it changed into something else since. */
  async function blobFor(f) {
    if (f.content) return new Blob([f.content]);
    const st = await fsp.lstat(f.abs);
    if (!st.isFile() || st.size !== f.size) throw new Error(`${f.path} changed while publishing. Try again.`);
    return openAsBlob(f.abs);
  }

  async function addPackage(insp, { pin, onProgress }) {
    const parts = [];
    for (const f of insp.files) parts.push({ path: f.path, content: await blobFor(f) });
    return rpc().addDirectory(parts, { pin, onProgress });
  }

  /** §8.2 step 3: the new version, fetched through the same handler tabs use, must render. */
  async function selfTest(cid, descriptor) {
    const probe = async (urlPath, what) => {
      const res = await handler(new Request(`ipfs://${cid}${urlPath}`, { headers: { accept: 'text/html,*/*;q=0.8' } }));
      const type = res.headers.get('content-type') || '';
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (res.status !== 200 || !/^text\/html\b/i.test(type)) {
        throw new Error(`The self-test failed: ${what} answered ${res.status}${type ? ` (${type})` : ''}. Nothing was published.`);
      }
    };
    await probe('/', 'the home page');
    await probe(`/${descriptor.entry.split('/').map(encodeURIComponent).join('/')}`, descriptor.entry);
    if (descriptor.spa) await probe('/__bucks_probe__/x', 'a single-page-app link');
  }

  async function isOnline(r) {
    try { return await r.isOnline(); } catch { return false; }
  }

  async function publishName(r, site, cid) {
    await r.namePublish(site.keyName, cid, { allowOffline: !(await isOnline(r)) });
    // Kubo serves the name's previous version until its cache expires; tabs here must not.
    handler.setNameTarget?.(site.ipns, cid);
  }

  async function announce(r, cid) {
    const at = new Date(now()).toISOString();
    if (!(await isOnline(r))) return { ok: false, at, error: 'The node runs offline.' };
    try {
      await r.provide(cid, { timeoutMs: PROVIDE_TIMEOUT_MS });
      return { ok: true, at, error: null };
    } catch (e) {
      return { ok: false, at, error: e.kuboMessage || e.message };
    }
  }

  function referenced(sites = store.list()) {
    const set = new Set();
    for (const s of sites) {
      if (s.current) set.add(s.current.cid);
      for (const v of s.history) set.add(v.cid);
    }
    return set;
  }

  /** Unpin a version no site refers to any more. */
  async function unpinIfUnused(r, cid, sites) {
    if (referenced(sites).has(cid)) return false;
    try { await r.pinRm(cid); return true; } catch (e) {
      if (!/not pinned/i.test(e.message)) log.warn(`unpin ${cid} failed: ${e.message}`);
      return false;
    }
  }

  /** Extra copies (§9.2): offer the version to paired devices and ask pinning services to pin it. */
  async function shareCopies(site, cid, size) {
    const result = { devices: null, pinningServices: [] };
    if (site.hosting.pinToDevices.length && devices) {
      try { result.devices = await devices.share({ cid, name: site.name, size }); } catch (e) { result.devices = { error: e.message }; }
    }
    if (site.hosting.pinningServices.length && pinning) {
      let origins = [];
      try { origins = (await rpc().swarmAddrsLocal()).map((a) => `${a}/p2p/${kubo.status().peer_id}`); } catch { /* offline */ }
      for (const service of site.hosting.pinningServices) {
        try {
          const p = await pinning.pin(service, cid, { name: `${site.name} (${cid.slice(0, 12)}…)`, origins });
          result.pinningServices.push({ service, status: p.status });
        } catch (e) {
          result.pinningServices.push({ service, status: 'failed', error: e.message });
        }
      }
    }
    return result;
  }

  function urlsFor(site, cid = site.current?.cid) {
    const { publicGateway } = config();
    return {
      ipfs: cid ? `ipfs://${cid}/` : null,
      ipns: site.ipns ? `ipns://${site.ipns}/` : null,
      gateway: cid ? gatewayLink(publicGateway, 'ipfs', cid) : null,
      gatewayIpns: site.ipns ? gatewayLink(publicGateway, 'ipns', site.ipns) : null,
    };
  }

  /** Every file of a version: path → { cid, size }. */
  async function listTree(r, root) {
    const out = new Map();
    const queue = [['', root]];
    while (queue.length) {
      const [prefix, cid] = queue.shift();
      for (const entry of await r.ls(cid)) {
        const p = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.type === 'dir') queue.push([p, entry.cid]);
        else out.set(p, { cid: entry.cid, size: entry.size });
        if (out.size + queue.length > MAX_TREE_ENTRIES) throw new Error('The site is too large to compare.');
      }
    }
    return out;
  }

  /** §8.3: files added, changed and removed, and blocks new versus reused. */
  async function computeDiff(r, oldCid, newCid) {
    const newTree = await listTree(r, newCid);
    const oldTree = oldCid ? await listTree(r, oldCid).catch(() => new Map()) : new Map();
    const added = [];
    const changed = [];
    const removed = [];
    for (const [p, f] of newTree) {
      const before = oldTree.get(p);
      if (!before) added.push({ path: p, size: f.size });
      else if (before.cid !== f.cid) changed.push({ path: p, size: f.size, previousSize: before.size });
    }
    for (const [p, f] of oldTree) if (!newTree.has(p)) removed.push({ path: p, size: f.size });
    const newBlocks = [newCid, ...(await r.refs(newCid))];
    const oldBlocks = new Set(oldCid ? [oldCid, ...(await r.refs(oldCid).catch(() => []))] : []);
    const fresh = newBlocks.filter((b) => !oldBlocks.has(b)).length;
    const cap = (list) => list.sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, MAX_DIFF_LISTED);
    return {
      counts: { added: added.length, changed: changed.length, removed: removed.length },
      added: cap(added),
      changed: cap(changed),
      removed: cap(removed),
      blocks: { new: fresh, reused: newBlocks.length - fresh },
    };
  }

  function cleanName(name, fallback) {
    const n = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME) : '';
    return n || fallback;
  }

  function cleanHosting(h = {}) {
    if (h.keepOnline === false) throw new Error('For now this computer always keeps a copy of the sites it publishes.');
    const configured = new Set(pinning ? pinning.list().map((s) => s.name) : []);
    const services = Array.isArray(h.pinningServices) ? h.pinningServices.filter((n) => typeof n === 'string') : [];
    for (const n of services) if (!configured.has(n)) throw new Error(`No pinning service called "${n}". Add it first.`);
    return {
      keepOnline: true,
      pinToDevices: Array.isArray(h.pinToDevices) ? h.pinToDevices.filter((d) => typeof d === 'string').slice(0, 32) : [],
      pinningServices: services.slice(0, 8),
    };
  }

  /* ---------- public API ---------- */

  const api = {
    store,

    /**
     * A folder the main process got from its own dialog. Returns a short-lived token for it.
     * @returns {Promise<{ token: string, name: string, hints: { suggestedDir: string|null, framework: string|null, isStatic: boolean|null, note: string|null } }>}
     */
    async registerFolder(dir) {
      const project = await detectProject(dir);
      pruneTokens();
      const token = randomBytes(24).toString('base64url');
      const name = path.basename(dir);
      tokens.set(token, { dir: project.siteDir, name, expires: now() + TOKEN_TTL_MS });
      return {
        token,
        name,
        hints: { suggestedDir: project.suggestedDir, framework: project.framework, isStatic: project.isStatic, note: project.note },
      };
    },

    /** Run P1–P12 on a chosen folder. */
    async inspect({ token, ...opts } = {}) {
      return inspectionSummary(await inspect(folderOf(token), opts));
    },

    /** §12.1 step 3: add the folder unpinned and mark it as a preview. */
    async preview({ token, ...opts } = {}) {
      rpc();
      const insp = await inspect(folderOf(token), opts);
      if (insp.blocked) throw blockedError(insp);
      const { cid } = await addPackage(insp, { pin: false });
      handler.setPreview?.(cid, true);
      return { previewCid: cid, url: `ipfs://${cid}/` };
    },

    /** §8.2: the publish pipeline. */
    async publish({ token, name, ipns = true, hosting, ...opts } = {}) {
      const r = rpc();
      const { dir, name: folderName } = chosen(token);
      const id = `s_${randomId()}`;
      const host = cleanHosting(hosting);
      return withLock(id, async () => {
        progress(id, 'inspect', 0, 1, 'Checking');
        const insp = await inspect(dir, opts);
        if (insp.blocked) throw blockedError(insp);
        progress(id, 'inspect', 1, 1, 'Checked');
        progress(id, 'add', 0, insp.bytes, 'Adding files');
        const { cid } = await addPackage(insp, { pin: true, onProgress: (b) => progress(id, 'add', Math.min(b, insp.bytes), insp.bytes, 'Adding files') });
        progress(id, 'add', insp.bytes, insp.bytes, 'Files added');
        let keyCreated = null;
        let saved;
        try {
          progress(id, 'self-test', 0, 1, 'Testing');
          await selfTest(cid, insp.descriptor);
          progress(id, 'self-test', 1, 1, 'Tested');
          const at = new Date(now()).toISOString();
          const site = {
            id,
            name: cleanName(name, cleanName(insp.descriptor.name, folderName)),
            sourceDir: insp.root,
            keyName: null,
            ipns: null,
            current: null,
            history: [],
            hosting: host,
            quotaBytes: config().quotaBytes,
            backup: { keyBackedUpAt: null },
            createdAt: at,
          };
          if (ipns !== false) {
            progress(id, 'name', 0, 1, 'Creating address');
            const key = await r.keyGen(`site-${id}`);
            keyCreated = key.name;
            site.keyName = key.name;
            site.ipns = key.id;
            await publishName(r, site, cid);
            progress(id, 'name', 1, 1, 'Address created');
          }
          progress(id, 'announce', 0, 1, 'Announcing');
          site.announce = await announce(r, cid);
          progress(id, 'announce', 1, 1, site.announce.ok ? 'Announced' : 'Not announced yet');
          progress(id, 'record', 0, 1, 'Saving');
          const version = { cid, publishedAt: at, bytes: insp.bytes, files: insp.count, note: '' };
          site.current = version;
          site.history = [version];
          saved = await store.put(site);
        } catch (e) {
          if (keyCreated) await r.keyRm(keyCreated).catch(() => {});
          await unpinIfUnused(r, cid);
          throw e;
        }
        handler.setPreview?.(cid, false);
        const copies = await shareCopies(saved, cid, insp.bytes);
        progress(id, 'record', 1, 1, 'Published');
        return { id, cid, ipns: saved.ipns, urls: urlsFor(saved), announce: saved.announce, copies, checks: insp.checks };
      });
    },

    /**
     * §8.3 update. Without `confirm` it is a dry run: the new version is added unpinned and the
     * diff returned. With `confirm` (and `expectCid` from the dry run) it publishes.
     */
    async update({ id, token, confirm = false, expectCid = null, ...opts } = {}) {
      const r = rpc();
      const site = requireSite(id);
      const dir = token ? folderOf(token) : site.sourceDir;
      if (!dir) throw new Error('Choose the folder to publish from.');
      if (!confirm) {
        const insp = await inspect(dir, opts);
        if (insp.blocked) throw blockedError(insp);
        const { cid } = await addPackage(insp, { pin: false });
        return { cid, unchanged: cid === site.current?.cid, diff: await computeDiff(r, site.current?.cid, cid), checks: insp.checks, files: insp.count, bytes: insp.bytes };
      }
      return withLock(id, async () => {
        progress(id, 'inspect', 0, 1, 'Checking');
        const insp = await inspect(dir, opts);
        if (insp.blocked) throw blockedError(insp);
        progress(id, 'inspect', 1, 1, 'Checked');
        progress(id, 'add', 0, insp.bytes, 'Adding files');
        const { cid } = await addPackage(insp, { pin: true, onProgress: (b) => progress(id, 'add', Math.min(b, insp.bytes), insp.bytes, 'Adding files') });
        progress(id, 'add', insp.bytes, insp.bytes, 'Files added');
        if (expectCid && cid !== expectCid) {
          await unpinIfUnused(r, cid);
          throw new Error('The folder changed since you reviewed the changes. Review them again.');
        }
        const previous = site.current?.cid ?? null;
        if (cid === previous) return { cid, unchanged: true, diff: await computeDiff(r, previous, cid), urls: urlsFor(site) };
        let diff;
        try {
          diff = await computeDiff(r, previous, cid);
          progress(id, 'self-test', 0, 1, 'Testing');
          await selfTest(cid, insp.descriptor);
          progress(id, 'self-test', 1, 1, 'Tested');
          if (site.keyName) {
            progress(id, 'name', 0, 1, 'Updating address');
            await publishName(r, site, cid);
            progress(id, 'name', 1, 1, 'Address updated');
          }
        } catch (e) {
          await unpinIfUnused(r, cid);
          throw e;
        }
        progress(id, 'announce', 0, 1, 'Announcing');
        const announced = await announce(r, cid);
        progress(id, 'announce', 1, 1, announced.ok ? 'Announced' : 'Not announced yet');
        progress(id, 'record', 0, 1, 'Saving');
        const version = { cid, publishedAt: new Date(now()).toISOString(), bytes: insp.bytes, files: insp.count, note: '' };
        const history = [version, ...site.history.filter((v) => v.cid !== cid)];
        const keep = history.slice(0, config().historyLimit);
        const trimmed = history.slice(config().historyLimit).filter((v) => v.cid !== version.cid);
        const saved = await store.put({ ...site, current: version, history: keep, sourceDir: token ? insp.root : site.sourceDir, announce: announced });
        for (const v of trimmed) await unpinIfUnused(r, v.cid);
        handler.setPreview?.(cid, false);
        const copies = await shareCopies(saved, cid, insp.bytes);
        progress(id, 'record', 1, 1, 'Published');
        return { cid, unchanged: false, diff, urls: urlsFor(saved), announce: announced, copies, checks: insp.checks };
      });
    },

    /** Sites, as the chrome shows them (folder name only, never the path). */
    list() {
      return store.list().map((s) => ({
        id: s.id,
        name: s.name,
        folderName: s.sourceDir ? path.basename(s.sourceDir) : null,
        ipns: s.ipns,
        current: s.current,
        history: s.history.map(versionOf),
        hosting: s.hosting,
        backup: s.backup,
        keyBackedUp: Boolean(s.backup.keyBackedUpAt),
        announce: s.announce,
        createdAt: s.createdAt,
        urls: urlsFor(s),
      }));
    },

    /** §8.3 rollback: point the address at an earlier version. */
    async rollback({ id, cid } = {}) {
      const r = rpc();
      return withLock(id, async () => {
        const site = requireSite(id);
        if (!site.keyName) throw new Error('This site has no updatable address, so there is nothing to roll back.');
        const target = site.history.find((v) => v.cid === cid);
        if (!target) throw new Error('That version is not in this site\'s history.');
        await r.pinAdd(cid);
        await publishName(r, site, cid);
        await store.put({ ...site, current: target });
        return { cid };
      });
    },

    /**
     * §8.3 unpublish: 'stop' (Bucks forgets the site; content and key stay), 'unpin' (also unpin
     * every version from this node; other copies remain), 'delete-key' (also delete the key: the
     * ipns:// address is dead for good; `confirm` must be the site's name).
     */
    async unpublish({ id, mode, confirm } = {}) {
      if (!UNPUBLISH_MODES.includes(mode)) throw new Error(`mode must be one of ${UNPUBLISH_MODES.join(', ')}`);
      const site = requireSite(id);
      if (mode === 'delete-key' && confirm !== site.name) throw new Error(`Type the site name ("${site.name}") to delete its address for good.`);
      const r = mode === 'stop' ? null : rpc();
      return withLock(id, async () => {
        await store.remove(id);
        if (r) {
          const rest = store.list();
          for (const cid of new Set([site.current?.cid, ...site.history.map((v) => v.cid)].filter(Boolean))) await unpinIfUnused(r, cid, rest);
          if (mode === 'delete-key' && site.keyName) {
            await r.keyRm(site.keyName);
            handler.setNameTarget?.(site.ipns, null);
          }
        }
        return { ok: true };
      });
    },

    /** §9.1 health, with the one check that failed. */
    async status({ id } = {}) {
      const site = requireSite(id);
      const { routerUrl, probeUrl } = config();
      const ready = kubo.isReady() && Boolean(kubo.rpc);
      const node = { ready, online: false, peerId: kubo.status?.()?.peer_id ?? null, pinned: false, connectivity: null };
      if (ready && site.current) {
        const r = kubo.rpc;
        node.online = await isOnline(r);
        try { node.pinned = (await r.pinLs()).some((p) => p.cid === site.current.cid); } catch { node.pinned = false; }
        try { node.connectivity = (await r.provideStat()).connectivity; } catch { node.connectivity = null; }
      }
      const remotePins = [];
      if (pinning && site.current) {
        for (const service of site.hosting.pinningServices) {
          try {
            const pins = await pinning.status(service, site.current.cid);
            remotePins.push({ service, status: pins.find((p) => p.status === 'pinned')?.status || pins[0]?.status || 'not pinned' });
          } catch (e) {
            remotePins.push({ service, status: 'unknown', error: e.message });
          }
        }
      }
      if (!site.current) return { state: null, label: 'Not published yet.', checks: [], failing: { id: 'local', message: 'This site has no published version yet.' }, providers: null, remotePins };
      return checkHealth({ cid: site.current.cid, node, lastAnnounce: site.announce, fetchImpl, routerUrl, probeUrl, remotePins });
    },

    /** §8.4: encrypt the site's key with a passphrase into `file` (a path from a save dialog). */
    async backupKey({ id, passphrase, file } = {}) {
      const site = requireSite(id);
      if (!site.keyName) throw new Error('This site has no updatable address, so it has no key to back up.');
      const st = kubo.status?.() || {};
      if (!st.embedded || typeof kubo.repoPath !== 'function') throw new Error('Key backup needs the IPFS node Bucks runs itself (not an external node).');
      const keyBytes = await readKeystoreKey(kubo.repoPath(), site.keyName);
      const data = await encryptKeyBackup(keyBytes, passphrase, { siteName: site.name, ipns: site.ipns, keyName: site.keyName });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, data, { mode: 0o600 });
      await fsp.rename(tmp, file);
      const backedUp = await store.put({ ...site, backup: { keyBackedUpAt: new Date(now()).toISOString() } });
      return { ok: true, keyBackedUpAt: backedUp.backup.keyBackedUpAt };
    },

    /**
     * §8.4 / §12.4: import a key backup. For an existing site the backup must be its key; without
     * `id` a site record is created ("Restore a site") pointing at the address's current version,
     * from `carFile` when given, else fetched from the network in the background.
     */
    async restoreKey({ id = null, passphrase, fileBytes, carFile = null } = {}) {
      const r = rpc();
      const { keyBytes, meta } = await decryptKeyBackup(fileBytes, passphrase);
      if (!/^k51[a-z0-9]{40,80}$/.test(String(meta.ipns))) throw new Error('This key backup does not name an address.');
      let site = id ? requireSite(id) : null;
      if (site && site.ipns !== meta.ipns) throw new Error(`This backup is for another site (${meta.ipns}).`);
      if (!site && store.list().some((s) => s.ipns === meta.ipns)) throw new Error('This site is already in your list.');
      const siteId = site ? site.id : `s_${randomId()}`;
      const keyName = site?.keyName || `site-${siteId}`;
      const keys = await r.keyList();
      const existing = keys.find((k) => k.id === meta.ipns);
      if (!existing) {
        if (keys.some((k) => k.name === keyName)) throw new Error(`A different key called ${keyName} already exists on this node.`);
        await r.keyImport(keyName, keyBytes);
        const imported = (await r.keyList()).find((k) => k.name === keyName);
        if (imported?.id !== meta.ipns) {
          await r.keyRm(keyName).catch(() => {});
          throw new Error('The imported key does not match the address recorded in the backup.');
        }
      } else if (existing.name !== keyName) {
        throw new Error(`This node already holds the key under the name ${existing.name}.`);
      }
      if (site) {
        await store.put({ ...site, keyName });
        return { ok: true, id: site.id, ipns: meta.ipns };
      }
      let current = null;
      if (carFile) {
        const { roots } = await r.dagImport(await openAsBlob(carFile));
        if (roots[0]) current = { cid: roots[0], publishedAt: null, bytes: 0, files: 0, note: 'restored from a CAR file' };
      } else {
        try {
          const p = await r.nameResolve(meta.ipns, { recursive: true, timeoutMs: 30_000 });
          const cid = /^\/ipfs\/([^/]+)/.exec(p)?.[1];
          if (cid) {
            current = { cid, publishedAt: null, bytes: 0, files: 0, note: 'restored from the network' };
            r.pinAdd(cid).catch((e) => log.warn(`pinning the restored site ${cid} failed: ${e.message}`));
          }
        } catch (e) {
          log.warn(`could not resolve ${meta.ipns} while restoring: ${e.message}`);
        }
      }
      await store.put({
        id: siteId, name: cleanName(meta.siteName, 'Restored site'), sourceDir: null, keyName, ipns: meta.ipns,
        current, history: current ? [current] : [], hosting: { keepOnline: true, pinToDevices: [], pinningServices: [] },
        quotaBytes: config().quotaBytes, backup: { keyBackedUpAt: meta.createdAt || null }, createdAt: new Date(now()).toISOString(),
      });
      return { ok: true, id: siteId, ipns: meta.ipns, cid: current?.cid ?? null };
    },

    /** Export the current version as a CAR file (an offline backup, §F8). */
    async exportCar({ id, file } = {}) {
      const r = rpc();
      const site = requireSite(id);
      if (!site.current) throw new Error('This site has no published version yet.');
      const { cid } = site.current;
      await r.dagStat(cid, { offline: true }); // every block must be on this computer
      const res = await r.dagExport(cid);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp, { mode: 0o600 }));
        await fsp.rename(tmp, file);
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw new Error(`Could not export the CAR file: ${e.message}`);
      }
      return { path: file, bytes: (await fsp.stat(file)).size, cid };
    },
  };
  return api;
}
