// The apps service (docs/APP-ENVIRONMENT.md §3): install an app from an ipfs:// or ipns:// address,
// a local folder, or a site this browser hosts; review what it asks for first; keep it pinned so
// it runs offline; update it after reviewing new permissions; roll back; uninstall (content,
// storage and all); publish a folder app as a site. Launching and agent tool calls go to the
// container (container.js). No Electron imports: Kubo, the sites service and the container are
// injected.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isCid, isPeerId } from '../ipfs/cid.js';
import { inspectFolder, detectProject, DEFAULT_QUOTA_BYTES, DEFAULT_MAX_FILES } from '../sites/folder.js';
import { MANIFEST_FILE, MAX_DESCRIPTOR_BYTES } from '../sites/package.js';
import { createAppStore } from './store.js';
import { parseAppManifest, permissionDiff, describePermission } from './manifest.js';

const TOKEN_TTL_MS = 30 * 60_000;
const MAX_TOKENS = 32;
const MAX_ICON_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const SIZE_TIMEOUT_MS = 60_000;
const IPNS_NAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;
const ICON_TYPES = { png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', ico: 'image/x-icon' };
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Read an address the user typed: ipfs://<cid>, ipns://<name>, /ipfs/<cid>, /ipns/<name>, or a
 * bare CID or k51… name.
 * @returns {{ kind: 'ipfs'|'ipns', ref: string }}
 */
export function parseAppAddress(address) {
  const a = String(address ?? '').trim();
  // A k51… key is a valid CID too (codec libp2p-key), but it names an IPNS record, not content.
  let m = /^(?:ipfs:\/\/|\/ipfs\/)([^/?#\s]+)\/?$/i.exec(a);
  if (m && isPeerId(m[1])) throw new Error(`${m[1].slice(0, 12)}… is an IPNS name: use ipns://${m[1]}`);
  if (m && isCid(m[1])) return { kind: 'ipfs', ref: m[1] };
  m = /^(?:ipns:\/\/|\/ipns\/)([^/?#\s]+)\/?$/i.exec(a);
  if (m && IPNS_NAME.test(m[1]) && m[1].length <= 253) return { kind: 'ipns', ref: m[1].toLowerCase() };
  if (isPeerId(a)) return { kind: 'ipns', ref: a.toLowerCase() };
  if (isCid(a)) return { kind: 'ipfs', ref: a };
  throw new Error('Enter an ipfs:// or ipns:// address (or a CID).');
}

/** What a person reads about an app's permissions. */
export function describeAll(permissions, tools = []) {
  return permissions.map((p) => describePermission(p, { tools })).filter(Boolean);
}

/**
 * @param {{
 *   kubo: { isReady(): boolean, rpc: any, gatewayUrl(): string|null, status(): any, start?(): Promise<any> },
 *   settings: { get(): any }, userData: string,
 *   sites?: { service: any, store?: { list(): any[], get(id: string): any } } | null,
 *   container?: { open(app: any): Promise<any>, close(id: string): void, reload(id: string): void,
 *     forget(id: string): Promise<void>, isRunning(id: string): boolean, invokeTool(app: any, name: string, input: any): Promise<any> } | null,
 *   emit?: (event: { type: string, id?: string, step?: string, message?: string }) => void,
 *   log?: object, now?: () => number, fetchImpl?: typeof fetch, openAsBlob?: typeof fs.openAsBlob, randomId?: () => string,
 * }} deps
 */
export function createAppsService({
  kubo, settings, userData, sites = null, container = null, emit = () => {}, log = noopLog,
  now = () => Date.now(), fetchImpl = (...a) => globalThis.fetch(...a), openAsBlob = fs.openAsBlob,
  randomId = () => randomBytes(5).toString('hex'),
}) {
  const store = createAppStore({ file: path.join(userData, 'apps.json'), log });
  const appsDir = path.join(userData, 'apps');
  const folders = new Map(); // folder token → { dir, name, expires }
  const reviews = new Map(); // review token → { expires, review data }
  const locks = new Map();
  let containerRef = container;

  const event = (e) => { try { emit(e); } catch (err) { log.warn(`apps event failed: ${err.message}`); } };

  function rpc() {
    if (!kubo.isReady() || !kubo.rpc) throw new Error('Your IPFS node is not running. Start it to install or update apps.');
    return kubo.rpc;
  }

  function gateway() {
    rpc();
    const gw = kubo.gatewayUrl?.();
    if (!gw) throw new Error('The IPFS gateway is not available.');
    return gw.replace(/\/+$/, '');
  }

  function prune(map) {
    const t = now();
    for (const [k, v] of map) if (v.expires < t) map.delete(k);
    while (map.size >= MAX_TOKENS) map.delete(map.keys().next().value);
  }

  async function withLock(id, fn) {
    while (locks.has(id)) await locks.get(id).catch(() => {});
    const p = (async () => fn())();
    locks.set(id, p);
    try { return await p; } finally { if (locks.get(id) === p) locks.delete(id); }
  }

  function requireApp(id) {
    const app = typeof id === 'string' ? store.get(id) : null;
    if (!app) throw new Error('No such app.');
    return app;
  }

  /** A small file inside a package, through the local gateway. null when it does not exist. */
  async function readPackageFile(cid, file, limit) {
    const res = await fetchImpl(`${gateway()}/ipfs/${cid}/${file.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) { await res.body?.cancel().catch(() => {}); return null; }
    if (res.status !== 200) { await res.body?.cancel().catch(() => {}); throw new Error(`The IPFS gateway answered ${res.status} for ${file}.`); }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) { await res.body?.cancel().catch(() => {}); throw new Error(`${file} is larger than ${Math.round(limit / 1024)} KB.`); }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error(`${file} is larger than ${Math.round(limit / 1024)} KB.`);
    return buf;
  }

  async function manifestOf(cid, fallbackName) {
    const buf = await readPackageFile(cid, MANIFEST_FILE, MAX_DESCRIPTOR_BYTES);
    return parseAppManifest(buf ? buf.toString('utf8') : null, { fallbackName });
  }

  async function sizeOf(cid) {
    try { return (await rpc().dagStat(cid, { timeoutMs: SIZE_TIMEOUT_MS })).size; } catch { return null; }
  }

  async function addFolder(dir) {
    const { quotaMiB, maxFiles } = settings.get?.()?.sites || {};
    const insp = await inspectFolder(dir, {
      quotaBytes: Number(quotaMiB) > 0 ? Number(quotaMiB) * 1024 * 1024 : DEFAULT_QUOTA_BYTES,
      maxFiles: Number(maxFiles) > 0 ? Number(maxFiles) : DEFAULT_MAX_FILES,
    });
    if (insp.blocked) {
      const first = insp.checks.find((c) => c.level === 'block' && !c.resolved);
      const err = new Error(first ? first.message : 'The checks found a problem that prevents installing this folder.');
      err.checks = insp.checks;
      throw err;
    }
    const parts = [];
    for (const f of insp.files) {
      if (f.content) { parts.push({ path: f.path, content: new Blob([f.content]) }); continue; }
      const st = await fsp.lstat(f.abs);
      if (!st.isFile() || st.size !== f.size) throw new Error(`${f.path} changed while it was being added. Try again.`);
      parts.push({ path: f.path, content: await openAsBlob(f.abs) });
    }
    const { cid } = await rpc().addDirectory(parts, { pin: false });
    return { cid, checks: insp.checks.filter((c) => c.level !== 'info'), name: path.basename(dir) };
  }

  /** Where a source's newest version is now. */
  async function resolveSource(source) {
    switch (source.kind) {
      case 'ipfs': return { cid: source.ref };
      case 'ipns': {
        const p = await rpc().nameResolve(source.ref, { timeoutMs: 60_000 });
        const m = /^\/ipfs\/([^/]+)/.exec(p);
        if (!m) throw new Error(`${source.ref} does not point to IPFS content.`);
        return { cid: m[1] };
      }
      case 'site': {
        const site = sites?.store?.get(source.ref) ?? null;
        if (!site?.current?.cid) throw new Error('That site is not hosted in this browser any more.');
        return { cid: site.current.cid, name: site.ipns };
      }
      case 'folder': return addFolder(source.ref);
      default: throw new Error('Unknown app source.');
    }
  }

  /** Content another app or a hosted site still uses must stay pinned. */
  function inUse(cid, exceptAppId) {
    for (const a of store.list()) {
      if (a.id === exceptAppId) continue;
      if ([a.current, ...a.history, a.pendingUpdate].some((v) => v?.cid === cid)) return true;
    }
    for (const s of sites?.store?.list?.() ?? []) {
      if (s.current?.cid === cid || (s.history || []).some((v) => v.cid === cid)) return true;
    }
    return false;
  }

  async function unpinIfUnused(cid, exceptAppId) {
    if (!cid || inUse(cid, exceptAppId) || !kubo.isReady()) return;
    try { await kubo.rpc.pinRm(cid); } catch (e) { if (!/not pinned/i.test(e.message)) log.warn(`unpin ${cid} failed: ${e.message}`); }
  }

  async function cacheIcon(id, cid, iconPath) {
    if (!iconPath) return null;
    try {
      const buf = await readPackageFile(cid, iconPath, MAX_ICON_BYTES);
      if (!buf) return null;
      const ext = iconPath.split('.').pop().toLowerCase();
      const name = `icon.${ext}`;
      await fsp.mkdir(path.join(appsDir, id), { recursive: true });
      await fsp.writeFile(path.join(appsDir, id, name), buf);
      return name;
    } catch (e) {
      log.warn(`icon for ${id}: ${e.message}`);
      return null;
    }
  }

  function summary(app) {
    return {
      id: app.id,
      name: app.name,
      description: app.description,
      version: app.current.version,
      cid: app.current.cid,
      source: app.source,
      permissions: describeAll(app.current.permissions, app.current.tools).map((p) => ({ ...p, granted: app.granted.includes(p.id) })),
      tools: app.current.tools.map((t) => ({ name: t.name, description: t.description })),
      hasIcon: Boolean(app.icon),
      running: Boolean(containerRef?.isRunning(app.id)),
      canUpdate: app.source.kind !== 'ipfs',
      pendingUpdate: app.pendingUpdate ? { version: app.pendingUpdate.version, cid: app.pendingUpdate.cid, ...diffText(app.current, app.pendingUpdate) } : null,
      previousVersion: app.history[0] ? { cid: app.history[0].cid, version: app.history[0].version } : null,
      installedAt: app.installedAt,
      updatedAt: app.updatedAt,
      urls: { app: `bucks-app://${app.id}/`, ipfs: `ipfs://${app.current.cid}/`, ...(app.source.kind === 'ipns' ? { ipns: `ipns://${app.source.ref}/` } : {}), ...(app.source.kind === 'site' && app.source.name ? { ipns: `ipns://${app.source.name}/` } : {}) },
    };
  }

  function diffText(from, to) {
    const { added, removed } = permissionDiff(from.permissions, to.permissions);
    return { added: describeAll(added, to.tools), removed: describeAll(removed, from.tools) };
  }

  const service = {
    store,

    /** The container is created after the service (it needs the service to look apps up). */
    attachContainer(c) { containerRef = c; },

    /**
     * A folder the main process got from its own dialog: a short-lived token for it.
     * @returns {Promise<{ token: string, name: string, hints: object }>}
     */
    async registerFolder(dir) {
      const project = await detectProject(dir);
      prune(folders);
      const token = randomBytes(24).toString('base64url');
      folders.set(token, { dir: project.siteDir, name: path.basename(dir), expires: now() + TOKEN_TTL_MS });
      return { token, name: path.basename(dir), hints: { suggestedDir: project.suggestedDir, framework: project.framework, note: project.note } };
    },

    /**
     * Fetch what an app is and asks for, before anything is installed. Exactly one of address,
     * folderToken or siteId.
     * @returns {Promise<object>} the review, with a `token` for install()
     */
    async inspect({ address, folderToken, siteId } = {}) {
      let source;
      if (address !== undefined) source = parseAppAddress(address);
      else if (folderToken !== undefined) {
        const f = folders.get(folderToken);
        if (!f || f.expires < now()) throw new Error('That folder choice has expired. Choose the folder again.');
        source = { kind: 'folder', ref: f.dir };
      } else if (siteId !== undefined) {
        if (!sites?.store?.get(siteId)) throw new Error('No such hosted site.');
        source = { kind: 'site', ref: siteId };
      } else throw new Error('Choose where to install the app from.');

      event({ type: 'progress', step: 'resolve', message: source.kind === 'folder' ? 'Adding the folder to your node' : 'Finding the app' });
      const resolved = await resolveSource(source);
      if (source.kind === 'site') source = { ...source, name: resolved.name || null };
      event({ type: 'progress', step: 'manifest', message: 'Reading the app manifest' });
      const fallbackName = resolved.name && source.kind === 'folder' ? resolved.name : (sites?.store?.get(source.ref)?.name || 'App');
      const manifest = await manifestOf(resolved.cid, fallbackName);
      event({ type: 'progress', step: 'size', message: 'Measuring' });
      const size = await sizeOf(resolved.cid);
      const existing = store.list().find((a) => a.source.kind === source.kind && a.source.ref === source.ref) || null;
      const review = {
        source: { kind: source.kind, ref: source.kind === 'folder' ? source.ref : source.ref, name: source.name ?? null },
        cid: resolved.cid,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        icon: manifest.icon,
        size,
        permissions: describeAll(manifest.permissions, manifest.tools),
        tools: manifest.tools.map((t) => ({ name: t.name, description: t.description })),
        warnings: [...manifest.warnings, ...(resolved.checks || []).map((c) => c.message)],
        alreadyInstalled: existing ? existing.id : null,
      };
      prune(reviews);
      const token = randomBytes(24).toString('base64url');
      reviews.set(token, { expires: now() + TOKEN_TTL_MS, review, manifest });
      return { token, ...review };
    },

    /**
     * Install what a review showed. `granted` may leave out permissions (they can be turned on
     * later); by default everything the app asks for is granted.
     */
    async install({ token, granted } = {}) {
      const entry = reviews.get(token);
      if (!entry || entry.expires < now()) throw new Error('This install review has expired. Start again.');
      reviews.delete(token);
      const { review, manifest } = entry;
      const requested = manifest.permissions;
      const grant = Array.isArray(granted) ? requested.filter((p) => granted.includes(p)) : [...requested];
      const id = review.alreadyInstalled || `a_${randomId()}`;
      return withLock(id, async () => {
        event({ type: 'progress', id, step: 'pin', message: 'Keeping a copy on this computer' });
        await rpc().pinAdd(review.cid);
        const previous = store.get(id);
        const at = new Date(now()).toISOString();
        const version = { cid: review.cid, version: manifest.version, installedAt: at, permissions: requested, tools: manifest.tools };
        const icon = await cacheIcon(id, review.cid, manifest.icon);
        let saved;
        try {
          saved = await store.put({
            id,
            name: manifest.name,
            description: manifest.description,
            source: review.source,
            current: version,
            history: previous && previous.current.cid !== review.cid ? [previous.current, ...previous.history].slice(0, 3) : (previous?.history ?? []),
            granted: grant,
            window: manifest.window,
            icon: icon ?? previous?.icon ?? null,
            pendingUpdate: null,
            installedAt: previous?.installedAt ?? at,
            updatedAt: at,
          });
        } catch (e) {
          if (!previous) await unpinIfUnused(review.cid, id);
          throw e;
        }
        if (previous) containerRef?.reload(id);
        event({ type: 'changed', id });
        return summary(saved);
      });
    },

    list() { return store.list().map(summary); },
    get({ id } = {}) { return summary(requireApp(id)); },

    /** The record the container needs (current CID, grants, window size). */
    record(id) { return store.get(id); },

    /** The cached icon as a data: URL (the chrome's CSP allows data: images), or null. */
    async iconDataUrl({ id } = {}) {
      const app = requireApp(id);
      if (!app.icon) return null;
      const ext = app.icon.split('.').pop();
      try {
        const buf = await fsp.readFile(path.join(appsDir, id, app.icon));
        return `data:${ICON_TYPES[ext] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
      } catch { return null; }
    },

    async launch({ id } = {}) {
      const app = requireApp(id);
      if (!containerRef) throw new Error('Apps cannot be opened here.');
      await containerRef.open(app);
      event({ type: 'changed', id });
      return summary(app);
    },

    /** Is a newer version available? Records it as pendingUpdate (nothing changes until update()). */
    async checkUpdate({ id } = {}) {
      return withLock(id, async () => {
        const app = requireApp(id);
        if (app.source.kind === 'ipfs') return { available: false, reason: 'This app was installed from an ipfs:// address, which is one exact version. Install its ipns:// address to receive updates.' };
        const resolved = await resolveSource(app.source);
        if (resolved.cid === app.current.cid) {
          if (app.pendingUpdate) await store.put({ ...app, pendingUpdate: null });
          return { available: false };
        }
        const manifest = await manifestOf(resolved.cid, app.name);
        const pending = { cid: resolved.cid, version: manifest.version, installedAt: null, permissions: manifest.permissions, tools: manifest.tools };
        const saved = await store.put({ ...app, pendingUpdate: pending });
        event({ type: 'changed', id });
        return { available: true, version: manifest.version, cid: resolved.cid, ...diffText(app.current, pending), warnings: manifest.warnings, app: summary(saved) };
      });
    },

    /**
     * Apply the pending update. Without `confirm` it only reports what would change; new
     * permissions are granted only with `confirm` (the user saw them).
     */
    async update({ id, confirm = false } = {}) {
      return withLock(id, async () => {
        const app = requireApp(id);
        const next = app.pendingUpdate;
        if (!next) throw new Error('There is no update to apply. Check for updates first.');
        const diff = diffText(app.current, next);
        if (!confirm) return { applied: false, version: next.version, cid: next.cid, ...diff };
        await rpc().pinAdd(next.cid);
        const { added } = permissionDiff(app.current.permissions, next.permissions);
        const at = new Date(now()).toISOString();
        const history = [app.current, ...app.history].slice(0, 3);
        const dropped = [app.current, ...app.history].slice(3);
        const icon = await cacheIcon(id, next.cid, (await manifestOf(next.cid, app.name)).icon);
        const saved = await store.put({
          ...app,
          current: { ...next, installedAt: at },
          history,
          granted: [...app.granted.filter((p) => next.permissions.includes(p)), ...added],
          icon: icon ?? app.icon,
          pendingUpdate: null,
          updatedAt: at,
        });
        for (const v of dropped) await unpinIfUnused(v.cid, null);
        containerRef?.reload(id);
        event({ type: 'changed', id });
        return { applied: true, app: summary(saved), ...diff };
      });
    },

    /** Go back to the previous version (its permissions; grants never widen). */
    async rollback({ id } = {}) {
      return withLock(id, async () => {
        const app = requireApp(id);
        const prev = app.history[0];
        if (!prev) throw new Error('There is no previous version.');
        await rpc().pinAdd(prev.cid);
        const saved = await store.put({
          ...app,
          current: prev,
          history: [app.current, ...app.history.slice(1)].slice(0, 3),
          granted: app.granted.filter((p) => prev.permissions.includes(p)),
          pendingUpdate: null,
          updatedAt: new Date(now()).toISOString(),
        });
        containerRef?.reload(id);
        event({ type: 'changed', id });
        return summary(saved);
      });
    },

    /** Turn one requested permission on or off. Revoking reloads a running app. */
    async setPermission({ id, permission, granted } = {}) {
      return withLock(id, async () => {
        const app = requireApp(id);
        if (!app.current.permissions.includes(permission)) throw new Error('The app does not ask for that permission.');
        const next = granted ? [...new Set([...app.granted, permission])] : app.granted.filter((p) => p !== permission);
        const saved = await store.put({ ...app, granted: next });
        if (!granted) containerRef?.reload(id);
        event({ type: 'changed', id });
        return summary(saved);
      });
    },

    /** Remove an app: its window, its storage, its icon and (unless shared) its pinned content. */
    async uninstall({ id } = {}) {
      return withLock(id, async () => {
        const app = requireApp(id);
        await containerRef?.forget(id);
        await store.remove(id);
        for (const v of [app.current, ...app.history, app.pendingUpdate].filter(Boolean)) await unpinIfUnused(v.cid, id);
        await fsp.rm(path.join(appsDir, id), { recursive: true, force: true });
        event({ type: 'changed', id });
        return { removed: true, id };
      });
    },

    /**
     * Host a folder app from this browser: publish its folder as a site (ipns:// address) and
     * make the app follow that address. Others install it from the address.
     */
    async publish({ id } = {}) {
      const app = requireApp(id);
      if (app.source.kind !== 'folder') throw new Error('Only an app installed from a folder can be published from here.');
      if (!sites?.service) throw new Error('Hosting is not available.');
      const { token } = await sites.service.registerFolder(app.source.ref);
      const published = await sites.service.publish({ token, name: app.name });
      await withLock(id, async () => {
        const fresh = requireApp(id);
        await store.put({ ...fresh, source: { kind: 'site', ref: published.id, name: published.ipns } });
      });
      const update = published.cid === app.current.cid ? { available: false } : await service.checkUpdate({ id });
      event({ type: 'changed', id });
      return { siteId: published.id, ipns: published.ipns, urls: published.urls, update, app: service.get({ id }) };
    },

    /** Run one of the app's agent tools inside its container. */
    async callTool({ id, tool, input } = {}) {
      const app = requireApp(id);
      if (!app.granted.includes('agent-tools')) throw new Error(`${app.name} is not allowed to offer tools to the agent (turn it on in Apps).`);
      if (!app.current.tools.some((t) => t.name === tool)) throw new Error(`${app.name} has no tool "${tool}".`);
      if (!containerRef) throw new Error('Apps cannot run here.');
      return containerRef.invokeTool(app, tool, input ?? {});
    },
  };
  return service;
}
