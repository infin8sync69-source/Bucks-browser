// Ported from Bucks-browser (src/main/ipfs/ipc.js); handlers can be limited to the app's own shell
// page with `isAllowedSender`, and bucks:ipfs:restart, bucks:ipfs:settings and
// bucks:ipfs:set-settings (the node's options, validated) are additions for the IPFS node panel.
// bucks:ipfs:* IPC handlers (see docs/IPC-CONTRACT.md). Thin validation + mapping layer
// over the Kubo supervisor and its RPC client. Every handler throws Error with a readable
// message; the renderer sees it as a rejected promise.

import { ipcMain } from 'electron';
import { normalizeIpfsUrl, isCid, normalizeCid } from './cid.js';
import { validatePublicGateway } from '../protocols/gateway-consent.js';
import { createLogger } from '../log.js';

const log = createLogger('ipfs-ipc');

const DEFAULT_CAT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CAT_BYTES = 256 * 1024 * 1024;
const MAX_ADD_BYTES = 512 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_FILENAME_LENGTH = 255;
const MAX_TEXT_LENGTH = 64 * 1024 * 1024;

function requireString(value, name, { max = MAX_PATH_LENGTH, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const s = value.trim();
  if (!allowEmpty && !s) throw new Error(`${name} must not be empty`);
  if (s.length > max) throw new Error(`${name} is too long (max ${max} characters)`);
  return s;
}

function sanitizeFileName(name, fallback) {
  if (name === undefined || name === null || name === '') return fallback;
  const s = requireString(name, 'fileName', { max: MAX_FILENAME_LENGTH });
  // keep the basename only, never let a path sneak into the multipart filename
  return s.replace(/[\\/]+/g, '_').replace(/[\u0000-\u001f]/g, '') || fallback;
}

/**
 * Decode `dataBase64`, which may be raw base64 or a data: URL (data:<mime>;base64,<payload>).
 * @returns {{ bytes: Uint8Array, mimeType: string|null }}
 */
export function decodeDataPayload(dataBase64) {
  if (typeof dataBase64 !== 'string') throw new Error('dataBase64 must be a string');
  let payload = dataBase64.trim();
  let mimeType = null;
  if (/^data:/i.test(payload)) {
    const comma = payload.indexOf(',');
    if (comma === -1) throw new Error('Malformed data: URL');
    const meta = payload.slice(5, comma);
    const body = payload.slice(comma + 1);
    const parts = meta.split(';');
    mimeType = parts[0] || null;
    if (!parts.slice(1).some((p) => p.toLowerCase() === 'base64')) {
      // percent-encoded textual data URL
      const text = decodeURIComponent(body);
      return { bytes: new TextEncoder().encode(text), mimeType };
    }
    payload = body;
  }
  payload = payload.replace(/\s+/g, '');
  if (payload.length > Math.ceil(MAX_ADD_BYTES / 3) * 4) throw new Error(`File is too large (max ${MAX_ADD_BYTES} bytes)`);
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(payload)) throw new Error('dataBase64 is not valid base64');
  const bytes = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mimeType };
}

/** The settings.ipfs fields the node panel shows and may change (paired devices are devices.js's). */
export const IPFS_SETTING_KEYS = Object.freeze(['mode', 'externalApiUrl', 'publicGateway', 'preferredGateway', 'autoStart', 'storageMaxGB']);

/** The user-editable part of settings.ipfs. */
export function pickIpfsSettings(ipfs) {
  const src = ipfs && typeof ipfs === 'object' ? ipfs : {};
  return Object.fromEntries(IPFS_SETTING_KEYS.map((k) => [k, src[k]]));
}

/**
 * Validate a patch for settings.ipfs from the node panel. Returns the clean patch; throws a
 * readable Error on the first bad field. Unknown keys are refused (peers are paired, not typed).
 */
export function validateIpfsSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings must be an object');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'mode':
        if (value !== 'embedded' && value !== 'external') throw new Error('mode must be "embedded" or "external"');
        out.mode = value;
        break;
      case 'externalApiUrl': {
        const s = typeof value === 'string' ? value.trim() : '';
        if (value !== undefined && value !== null && typeof value !== 'string') throw new Error('externalApiUrl must be a string');
        if (!s) { out.externalApiUrl = ''; break; }
        let u;
        try { u = new URL(s); } catch { throw new Error('The external node address is not a valid URL, for example http://127.0.0.1:5001'); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The external node address must start with http:// or https://');
        if (u.username || u.password) throw new Error('The external node address must not contain a user name or password');
        if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new Error('Enter only the node API address, for example http://127.0.0.1:5001');
        out.externalApiUrl = `${u.protocol}//${u.host}`;
        break;
      }
      case 'publicGateway': {
        const r = validatePublicGateway(value);
        if (!r.ok) throw new Error(r.reason);
        out.publicGateway = r.base;
        break;
      }
      case 'preferredGateway':
        if (value !== 'local' && value !== 'public') throw new Error('preferredGateway must be "local" or "public"');
        out.preferredGateway = value;
        break;
      case 'autoStart':
        if (typeof value !== 'boolean') throw new Error('autoStart must be true or false');
        out.autoStart = value;
        break;
      case 'storageMaxGB': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new Error('The storage limit must be a whole number of GB from 1 to 100000');
        out.storageMaxGB = n;
        break;
      }
      default:
        throw new Error(`Unknown IPFS setting: ${key}`);
    }
  }
  return out;
}

function normalizeCidArg(cid) {
  const s = requireString(cid, 'cid', { max: 512 }).replace(/^\/ipfs\//, '');
  if (!isCid(s)) throw new Error(`Invalid CID: ${s}`);
  return s;
}

/**
 * Register every bucks:ipfs:* channel.
 * @param {{ kubo: ReturnType<import('./kubo.js').createKubo>, settings: any, getMainWindow?: Function, isAllowedSender?: (url: string) => boolean }} deps
 */
export function registerIpfsIpc({ kubo, settings, getMainWindow = () => null, isAllowedSender = () => true }) {
  function ready() {
    if (!kubo.isReady() || !kubo.rpc) {
      const st = kubo.status();
      throw new Error(`IPFS node is not ready: ${st.message}`);
    }
    return kubo.rpc;
  }

  function addResult({ cid, size }) {
    const canonical = (() => { try { return normalizeCid(cid); } catch { return cid; } })();
    return {
      cid: canonical,
      ipfs_uri: `ipfs://${canonical}`,
      gateway_url: kubo.gatewayUrlFor(`ipfs://${canonical}`),
      size,
    };
  }

  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, payload) => {
      // Only the app's own shell page may call these (web content never can).
      if (!isAllowedSender(event?.senderFrame?.url)) throw new Error(`${channel} denied for this origin`);
      try {
        return await fn(payload ?? {});
      } catch (e) {
        const msg = e?.message || String(e);
        log.warn(`${channel} failed: ${msg}`);
        throw new Error(msg);
      }
    });
  };

  handle('bucks:ipfs:status', () => kubo.status());

  handle('bucks:ipfs:start', async () => {
    try {
      return await kubo.start();
    } catch (e) {
      throw new Error(`Could not start the IPFS node: ${e.message}`);
    }
  });

  handle('bucks:ipfs:stop', () => kubo.stop());

  handle('bucks:ipfs:restart', async () => {
    try {
      return await kubo.restart();
    } catch (e) {
      throw new Error(`Could not restart the IPFS node: ${e.message}`);
    }
  });

  handle('bucks:ipfs:settings', () => pickIpfsSettings(settings.get().ipfs));

  // A new mode or external address restarts a running node (kubo.js); the storage limit applies at
  // the next start.
  handle('bucks:ipfs:set-settings', (patch) => pickIpfsSettings(settings.set({ ipfs: validateIpfsSettingsPatch(patch) }).ipfs));

  handle('bucks:ipfs:node-info', async () => {
    const info = await ready().id();
    return {
      peer_id: info?.ID || null,
      addresses: Array.isArray(info?.Addresses) ? info.Addresses : [],
      agent_version: info?.AgentVersion || '',
    };
  });

  handle('bucks:ipfs:add', async ({ fileName, mimeType, dataBase64 }) => {
    const rpc = ready();
    const { bytes, mimeType: embeddedMime } = decodeDataPayload(dataBase64);
    const name = sanitizeFileName(fileName, 'file');
    const type = mimeType ? requireString(mimeType, 'mimeType', { max: 255 }) : embeddedMime || 'application/octet-stream';
    const res = await rpc.add(bytes, { fileName: name, mimeType: type, pin: true });
    return addResult({ cid: res.cid, size: res.size || bytes.byteLength });
  });

  handle('bucks:ipfs:add-text', async ({ content, fileName }) => {
    const rpc = ready();
    if (typeof content !== 'string') throw new Error('content must be a string');
    if (content.length > MAX_TEXT_LENGTH) throw new Error(`content is too long (max ${MAX_TEXT_LENGTH} characters)`);
    const bytes = new TextEncoder().encode(content);
    const name = sanitizeFileName(fileName, 'note.txt');
    const res = await rpc.add(bytes, { fileName: name, mimeType: 'text/plain; charset=utf-8', pin: true });
    return addResult({ cid: res.cid, size: res.size || bytes.byteLength });
  });

  handle('bucks:ipfs:cat', async ({ path, maxBytes }) => {
    const rpc = ready();
    const p = requireString(path, 'path');
    let limit = DEFAULT_CAT_MAX_BYTES;
    if (maxBytes !== undefined && maxBytes !== null) {
      if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive number');
      limit = Math.min(Math.floor(maxBytes), MAX_CAT_BYTES);
    }
    let bytes;
    try {
      bytes = await rpc.cat(p, { maxBytes: limit });
    } catch (e) {
      if (/limit/.test(e.message)) throw new Error(`Content exceeds the ${limit} byte limit (pass a larger maxBytes or open it in a tab)`);
      throw e;
    }
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  });

  handle('bucks:ipfs:ls', async ({ path }) => ready().ls(requireString(path, 'path')));

  handle('bucks:ipfs:pin-add', async ({ cid }) => ready().pinAdd(normalizeCidArg(cid)));

  handle('bucks:ipfs:pin-rm', async ({ cid }) => ready().pinRm(normalizeCidArg(cid)));

  handle('bucks:ipfs:pin-ls', async () => ready().pinLs({ type: 'recursive' }));

  handle('bucks:ipfs:peers', async () => ready().swarmPeers());

  handle('bucks:ipfs:stats', async () => {
    const rpc = ready();
    const [repo, peers, bw] = await Promise.all([
      rpc.repoStat(),
      rpc.swarmPeers().catch(() => []),
      rpc.statsBw().catch(() => undefined),
    ]);
    return { ...repo, peers: peers.length, ...(bw ? { bw } : {}) };
  });

  handle('bucks:ipfs:resolve', async ({ name }) => {
    const rpc = ready();
    const n = requireString(name, 'name', { max: 1024 }).replace(/^ipns:\/\//i, '').replace(/^\/ipns\//, '').replace(/\/+$/, '');
    return rpc.nameResolve(n, { recursive: true, timeoutMs: 60_000 });
  });

  handle('bucks:ipfs:gateway-url-for', ({ url }) => kubo.gatewayUrlFor(requireString(url, 'url')));

  handle('bucks:ipfs:normalize-url', ({ url }) => normalizeIpfsUrl(requireString(url, 'url')));

  void getMainWindow;
}
