// Serving a site through the ipfs:// and ipns:// handler (docs/IPFS-HOSTING-IMPLEMENTATION.md
// §6.2–§6.4): the site descriptor per root CID, the root behind an ipns:// name, the SPA-fallback
// decision, HTML sniffing for extensionless files, and a body guard that turns a short upstream
// body into an error instead of a silently truncated 200. No Electron imports.

import { CID } from 'multiformats/cid';
import {
  buildDescriptor, hasExtension, MANIFEST_FILE, REDIRECTS_FILE, MAX_DESCRIPTOR_BYTES,
} from '../sites/package.js';

const DAG_PB = 0x70;

/** Only a dag-pb root can be a UnixFS directory, so only it can carry bucks-site.json or _redirects. */
export function canBeDirectory(cid) {
  try { return CID.parse(String(cid)).code === DAG_PB; } catch { return false; }
}

const SIDE_FETCH_TIMEOUT_MS = 15_000;
const MAX_SIDE_REDIRECTS = 3;
const SNIFF_BYTES = 512;
// WHATWG MIME sniffing: an HTML document starts (after whitespace) with one of these, followed by a
// space or '>'.
const HTML_SIGNATURES = ['<!doctype html', '<html', '<head', '<script', '<iframe', '<h1', '<div', '<font', '<table', '<a', '<style', '<title', '<b', '<body', '<br', '<p', '<!--'];

/**
 * False for a path that could leave the requested root on the gateway. Kubo's path gateway decodes
 * %2F and cleans dot segments, so /ipfs/<A>/..%2F<B>/x.html is answered with B's file — which would
 * then run on A's origin (measured on Kubo 0.43.1). Chromium leaves '..%2F' alone, so the handler
 * must refuse it: no decoded segment may be '.' or '..' or contain '/', '\\' or NUL.
 */
export function isSafeRequestPath(pathname) {
  for (const seg of String(pathname || '').split('/')) {
    if (!seg) continue;
    let d;
    try { d = decodeURIComponent(seg); } catch { return false; }
    if (d === '.' || d === '..' || /[/\\\u0000]/.test(d)) return false;
  }
  return true;
}

/** True when the first bytes of a body are an HTML document (the browser's own sniffing rule). */
export function looksLikeHtml(bytes) {
  const head = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString('latin1').replace(/^ï»¿/, '').replace(/^[\t\n\f\r ]+/, '').toLowerCase();
  return HTML_SIGNATURES.some((sig) => head.startsWith(sig) && (head.length === sig.length || /[ \t\n\f\r>]/.test(head[sig.length]) || sig === '<!--'));
}

/**
 * §6.2 step 2: serve the descriptor's fallback for a 404? Only for page navigations (GET, Accept
 * text/html, no file extension) on a site that enabled single-page-app mode.
 */
export function shouldServeFallback({ method, accept, pathname, descriptor }) {
  return method === 'GET'
    && /\btext\/html\b/i.test(accept || '')
    && !hasExtension(pathname)
    && Boolean(descriptor?.spa);
}

/**
 * Cache-Control for everything served on an ipns:// name. A name changes when its site is updated,
 * and Chromium's in-memory cache reuses subresources of custom schemes without revalidating them
 * (measured on Electron 44: after an update a reload still ran the old script under
 * `max-age=0, must-revalidate`), so nothing on a name is stored. Each request is a loopback call to
 * the local node.
 */
export const IPNS_CACHE_CONTROL = 'no-store';

/** Cache-Control of a fallback page: an ipfs:// version never changes, an ipns:// name does. */
export function fallbackCacheControl(scheme) {
  return scheme === 'ipns' ? IPNS_CACHE_CONTROL : 'public, max-age=31536000, immutable';
}

/**
 * Pass a body through unchanged, but error the stream when it ends before `expectedLength` bytes
 * (or goes past it). Kubo answers 200 with the full Content-Length and then cuts the connection
 * when a block is missing; without this the page would silently show a truncated file.
 * @param {ReadableStream<Uint8Array>} body
 * @param {number|null} expectedLength
 */
export function guardContentLength(body, expectedLength) {
  if (!body || !Number.isSafeInteger(expectedLength) || expectedLength < 0) return body;
  let seen = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      seen += chunk.byteLength;
      if (seen > expectedLength) ctrl.error(new Error(`IPFS response longer than its Content-Length (${expectedLength})`));
      else ctrl.enqueue(chunk);
    },
    flush(ctrl) {
      if (seen < expectedLength) ctrl.error(new Error(`IPFS response truncated: ${seen} of ${expectedLength} bytes (a block is missing)`));
    },
  }));
}

/**
 * Read up to `n` bytes from the start of a body without losing them.
 * @returns {Promise<{ head: Uint8Array, body: ReadableStream<Uint8Array> }>} body replays `head` first
 */
export async function peekBody(body, n = SNIFF_BYTES) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  let done = false;
  while (size < n) {
    const r = await reader.read();
    if (r.done) { done = true; break; }
    chunks.push(r.value);
    size += r.value.byteLength;
  }
  const head = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { head.set(c, off); off += c.byteLength; }
  let replayed = false;
  const replay = new ReadableStream({
    async pull(ctrl) {
      if (!replayed) {
        replayed = true;
        if (head.byteLength) ctrl.enqueue(head);
        if (done) ctrl.close();
        return;
      }
      try {
        const r = await reader.read();
        if (r.done) ctrl.close(); else ctrl.enqueue(r.value);
      } catch (e) {
        ctrl.error(e);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { head, body: replay };
}

/** Read a small text body, refusing anything over `limit` bytes. */
async function readLimitedText(res, limit) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) { await res.body?.cancel().catch(() => {}); return null; }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Site descriptors by root CID (§6.3): /bucks-site.json, else /_redirects, each at most 64 KiB,
 * parsed once per root for the life of the process. A root is immutable, so the gateway it was read
 * through does not matter. Transient failures are not cached.
 * @param {{ fetchImpl?: typeof fetch, max?: number }} [opts]
 */
export function createDescriptorCache({ fetchImpl = (...a) => globalThis.fetch(...a), max = 256 } = {}) {
  const cache = new Map(); // root → Promise<descriptor>

  /** @returns {Promise<string|null>} null when the site has no such file; throws when unsure */
  async function readFile(base, root, name) {
    let url = `${base}/ipfs/${root}/${name}`;
    let res;
    // Public gateways redirect path requests to their subdomain origin: follow a few hops, no more.
    for (let hop = 0; ; hop += 1) {
      res = await fetchImpl(url, { headers: { accept: '*/*', 'accept-encoding': 'identity' }, redirect: 'manual', signal: AbortSignal.timeout(SIDE_FETCH_TIMEOUT_MS) });
      const loc = res.headers.get('location');
      if (!(res.status >= 300 && res.status < 400 && loc) || hop >= MAX_SIDE_REDIRECTS) break;
      await res.body?.cancel().catch(() => {});
      url = new URL(loc, url).toString();
    }
    if (res.status === 200) return readLimitedText(res, MAX_DESCRIPTOR_BYTES);
    await res.body?.cancel().catch(() => {});
    if (res.status >= 400 && res.status < 500) return null;
    throw new Error(`gateway answered ${res.status} for ${name}`);
  }

  return {
    /** @returns {Promise<ReturnType<typeof buildDescriptor>>} never rejects */
    async get(base, root) {
      if (!canBeDirectory(root)) return buildDescriptor({});
      if (!cache.has(root)) {
        const p = (async () => {
          const manifestText = await readFile(base, root, MANIFEST_FILE);
          const redirectsText = manifestText === null ? await readFile(base, root, REDIRECTS_FILE) : null;
          return buildDescriptor({ manifestText, redirectsText });
        })();
        cache.set(root, p);
        p.catch(() => cache.delete(root));
        if (cache.size > max) cache.delete(cache.keys().next().value);
      }
      try {
        return await cache.get(root);
      } catch {
        return buildDescriptor({});
      }
    },
    has: (root) => cache.has(root),
  };
}

/** The root CID a gateway response was served from (first X-Ipfs-Roots entry), or null. */
export function rootFromHeaders(headers) {
  const first = String(headers?.get?.('x-ipfs-roots') || '').split(',')[0].trim();
  return /^[a-z0-9]{20,}$/i.test(first) ? first : null;
}

/**
 * The CID an ipns:// name points to: learned from responses (X-Ipfs-Roots), and looked up afresh
 * with a HEAD of the name's root when a 404 does not carry it, so a fallback page always comes from
 * the version the name points to now, right after an update too.
 */
export function createRootResolver({ fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const names = new Map(); // name → last root seen (for the address bar badge)
  const remember = (name, cid) => {
    if (!cid) return;
    names.delete(name);
    names.set(name, cid);
    if (names.size > 1000) names.delete(names.keys().next().value);
  };
  return {
    record: remember,
    /** Last root seen for a name, for display only. */
    current: (name) => names.get(name) ?? null,
    async lookup(base, name) {
      try {
        const res = await fetchImpl(`${base}/ipns/${name}/`, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(SIDE_FETCH_TIMEOUT_MS) });
        await res.body?.cancel().catch(() => {});
        const cid = rootFromHeaders(res.headers);
        remember(name, cid);
        return cid;
      } catch {
        return null;
      }
    },
  };
}
