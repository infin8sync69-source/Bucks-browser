// Remote pinning (docs/IPFS-HOSTING-IMPLEMENTATION.md §9.2 tier 4, §9.3): the IPFS Pinning Service
// API (POST /pins, GET /pins, DELETE /pins/{requestid}) spoken directly, so the access token stays
// sealed by the OS keychain (Electron safeStorage, injected as seal/unseal) and is never written in
// clear: Kubo's own `pin/remote/service add` would store it in plain text in the repo config.
// No Electron imports.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const NAME = /^[A-Za-z0-9._-]{1,40}$/;
const TIMEOUT_MS = 20_000;
export const PIN_STATUSES = ['queued', 'pinning', 'pinned', 'failed'];

/** The endpoint must be https:// (http only for loopback test servers). */
export function validateEndpoint(endpoint) {
  let u;
  try { u = new URL(String(endpoint || '').trim()); } catch { throw new Error('The pinning service endpoint is not a valid URL.'); }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('The pinning service endpoint must use https://.');
  if (u.username || u.password) throw new Error('Put the access token in the token field, not in the URL.');
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

/**
 * Registered services in <dir>/pinning-services.json: [{ name, endpoint, token: <sealed, base64> }].
 * @param {{ dir: string, seal: (text: string) => Buffer, unseal: (sealed: Buffer) => string, canSeal: () => boolean,
 *           fetchImpl?: typeof fetch }} opts
 */
export function createPinningServices({ dir, seal, unseal, canSeal, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  const file = path.join(dir, 'pinning-services.json');

  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(j) ? j.filter((s) => NAME.test(s?.name) && typeof s.endpoint === 'string' && typeof s.token === 'string') : [];
    } catch {
      return [];
    }
  }
  async function write(list) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  async function call(service, method, pathname, { body, query } = {}) {
    const entry = read().find((s) => s.name === service);
    if (!entry) throw new Error(`No pinning service called "${service}"`);
    const token = unseal(Buffer.from(entry.token, 'base64'));
    const url = new URL(`${entry.endpoint}${pathname}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`Cannot reach the pinning service "${service}": ${e?.cause?.message || e.message}`);
    }
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error(`The pinning service "${service}" answered ${res.status}${j?.error?.reason ? `: ${j.error.reason}` : ''}`);
    }
    return res.status === 202 && method === 'DELETE' ? null : res.json().catch(() => null);
  }

  const pinStatus = (j) => ({
    requestid: String(j?.requestid || ''),
    status: PIN_STATUSES.includes(j?.status) ? j.status : 'failed',
    cid: String(j?.pin?.cid || ''),
    created: typeof j?.created === 'string' ? j.created : null,
  });

  return {
    /** @returns {Array<{ name: string, endpoint: string }>} never the token */
    list: () => read().map(({ name, endpoint }) => ({ name, endpoint })),
    async add({ name, endpoint, token }) {
      if (!NAME.test(String(name || ''))) throw new Error('Name the service with letters, digits, "-", "_" or "." (at most 40).');
      const base = validateEndpoint(endpoint);
      if (typeof token !== 'string' || token.length < 8 || token.length > 8192) throw new Error('Paste the access token of the pinning service.');
      if (!canSeal()) throw new Error('This computer has no OS keychain available to protect the token, so it cannot be stored.');
      const list = read().filter((s) => s.name !== name);
      list.push({ name, endpoint: base, token: seal(token).toString('base64') });
      await write(list);
      return this.list();
    },
    async remove(name) {
      await write(read().filter((s) => s.name !== name));
      return this.list();
    },
    /** Ask a service to pin a CID; origins help it fetch from this node directly. */
    async pin(service, cid, { name, origins = [] } = {}) {
      return pinStatus(await call(service, 'POST', '/pins', { body: { cid, name: String(name || '').slice(0, 255), origins: origins.slice(0, 20) } }));
    },
    /** @returns {Promise<Array<ReturnType<typeof pinStatus>>>} the service's pins for one CID */
    async status(service, cid) {
      const j = await call(service, 'GET', '/pins', { query: { cid, status: PIN_STATUSES.join(',') } });
      return (Array.isArray(j?.results) ? j.results : []).map(pinStatus);
    },
    async unpin(service, cid) {
      for (const p of await this.status(service, cid)) {
        if (p.requestid) await call(service, 'DELETE', `/pins/${encodeURIComponent(p.requestid)}`);
      }
    },
  };
}
