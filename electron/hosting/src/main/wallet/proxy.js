// Wallet proxy: bucks:wallet:rpc forwards already-signed requests from the chrome's wallet page
// to the configured Bucks node. Private keys never reach the main process.

import { app, ipcMain } from 'electron';

const TIMEOUT_MS = 15_000;
const MAX_PATH = 2048;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST']);

/**
 * Validate the node-relative request path. Must start with a single "/", contain no ".." (raw or
 * percent-encoded), no scheme, no backslash, whitespace or control characters.
 * @param {unknown} path
 * @returns {string} the path
 */
export function validatePath(path) {
  if (typeof path !== 'string' || !path) throw new Error('Wallet RPC path must be a non-empty string');
  if (path.length > MAX_PATH) throw new Error('Wallet RPC path is too long');
  if (!path.startsWith('/')) throw new Error('Wallet RPC path must start with "/"');
  if (path.startsWith('//')) throw new Error('Wallet RPC path must not start with "//"');
  if (/[\s\\\u0000-\u001f\u007f]/.test(path)) throw new Error('Wallet RPC path contains illegal characters');
  if (path.includes('://')) throw new Error('Wallet RPC path must not contain a scheme');
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error('Wallet RPC path is not valid percent-encoding');
  }
  // Decode twice to catch %252e%252e as well.
  let twice = decoded;
  try { twice = decodeURIComponent(decoded); } catch { /* single-encoded is enough */ }
  if (path.includes('..') || decoded.includes('..') || twice.includes('..')) throw new Error('Wallet RPC path must not contain ".."');
  if (decoded.includes('\\') || twice.includes('\\') || twice.includes('://')) throw new Error('Wallet RPC path contains illegal characters');
  return path;
}

/**
 * Validate the configured node URL (http/https, no credentials).
 * @param {unknown} nodeUrl
 * @returns {URL}
 */
export function validateNodeUrl(nodeUrl) {
  let u;
  try {
    u = new URL(String(nodeUrl || '').trim());
  } catch {
    throw new Error(`Invalid Bucks node URL "${nodeUrl ?? ''}" (set it in Settings > Wallet)`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Bucks node URL must be http(s), got "${u.protocol}"`);
  if (u.username || u.password) throw new Error('Bucks node URL must not contain credentials');
  return u;
}

/**
 * Join the node URL and a validated path. The result is guaranteed to stay on the node's origin.
 * @param {string} nodeUrl
 * @param {string} path
 * @returns {string}
 */
export function buildTargetUrl(nodeUrl, path) {
  const base = validateNodeUrl(nodeUrl);
  validatePath(path);
  const prefix = base.pathname.replace(/\/+$/, '');
  const target = new URL(`${base.origin}${prefix}${path}`);
  if (target.origin !== base.origin) throw new Error('Wallet RPC path escapes the node origin');
  return target.href;
}

/** Is this IPC sender the chrome (or, unpackaged, a local dev server)? */
export function isAllowedOrigin(url, { packaged = false } = {}) {
  if (typeof url !== 'string') return false;
  if (/^bucks:\/\/app(\/|$|\?|#)/i.test(url)) return true;
  return !packaged && url.startsWith('http://localhost:');
}

/**
 * Create the wallet proxy and register bucks:wallet:rpc.
 * @param {object} deps
 * @param {{ get(): { wallet?: { nodeUrl?: string } } }} deps.settings
 * @param {typeof fetch} [deps.fetchImpl] injectable for tests
 * @returns {{ rpc(req: { method: string, path: string, body?: any }): Promise<any> }}
 */
export function createWalletProxy({ settings, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  async function rpc({ method, path, body } = {}) {
    const verb = String(method || '').toUpperCase();
    if (!ALLOWED_METHODS.has(verb)) throw new Error(`Wallet RPC method must be GET or POST, got "${method}"`);
    const nodeUrl = settings.get()?.wallet?.nodeUrl;
    const url = buildTargetUrl(nodeUrl, path);
    const origin = new URL(url).origin;

    const init = {
      method: verb,
      headers: { accept: 'application/json' },
      redirect: 'manual', // a redirect could leave the node's origin
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (verb === 'POST' && body !== undefined && body !== null) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const unreachable = (e) => {
      const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `no answer within ${TIMEOUT_MS / 1000} s`
        : e?.cause?.code || e?.cause?.message || e?.message || String(e);
      return new Error(`Cannot reach Bucks node at ${origin}: ${reason}`);
    };
    let res;
    let text;
    try {
      res = await fetchImpl(url, init);
      text = await readLimited(res);
    } catch (e) {
      throw unreachable(e);
    }
    if (!res.ok) throw new Error(`Node responded ${res.status}: ${text.slice(0, 200)}`);
    if (!text.trim()) return { ok: true, text: '' };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, text };
    }
  }

  ipcMain.removeHandler?.('bucks:wallet:rpc');
  ipcMain.handle('bucks:wallet:rpc', async (event, req) => {
    const from = event?.senderFrame?.url;
    if (!isAllowedOrigin(from, { packaged: Boolean(app?.isPackaged) })) throw new Error('Wallet RPC denied for origin');
    return rpc(req || {});
  });

  return { rpc };
}

/** Read a response body as text, refusing absurdly large ones. */
async function readLimited(res) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (declared > MAX_RESPONSE_BYTES) throw new Error('response is too large');
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('response is too large');
  return text;
}
