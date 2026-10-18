// bucks:// protocol — serves the built SvelteKit chrome (ui/build) to the chrome window.
// Only `bucks://app/*` is served. Everything is read from `uiDist`; path traversal is rejected
// and unknown routes fall back to index.html (SPA). No Electron import: the resolver is pure
// and unit-tested, the session is injected by the caller.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

/** The only bucks:// host that serves files. */
export const BUCKS_APP_HOST = 'app';

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
});

const IMMUTABLE_PREFIX = '/_app/immutable/';
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_NO_CACHE = 'no-cache';

/**
 * Content-Type for a file name / path, by extension.
 * @param {string} file
 * @returns {string}
 */
export function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

/**
 * Cache-Control for a served file: hashed SvelteKit assets are immutable, HTML (and the SPA
 * fallback) is always revalidated, everything else is left to the browser's heuristics.
 * @param {string} pathname request pathname (e.g. "/_app/immutable/chunks/x.js")
 * @param {string} file     the file actually served
 * @returns {string | null}
 */
export function cacheControlFor(pathname, file) {
  if (String(pathname).startsWith(IMMUTABLE_PREFIX)) return CACHE_IMMUTABLE;
  if (/\.html?$/i.test(String(file))) return CACHE_NO_CACHE;
  return null;
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/**
 * Map a request pathname to a file under `uiDist`.
 *
 * - percent-decoded, then resolved against `uiDist`; anything that escapes `uiDist` → 403
 * - a directory → its `index.html` when present
 * - a missing file (SPA route) → `uiDist/index.html` with status 200
 * - a missing `index.html` (chrome not built) → 503
 *
 * @param {string} uiDist   absolute path of the built chrome
 * @param {string} pathname URL pathname, e.g. "/settings" or "/_app/immutable/x.js"
 * @returns {{ file: string | null, status: number }}
 */
export function resolveBucksPath(uiDist, pathname) {
  const root = path.resolve(uiDist);
  const fallback = path.join(root, 'index.html');
  const serveFallback = () => (statOrNull(fallback)?.isFile() ? { file: fallback, status: 200 } : { file: null, status: 503 });

  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname || '/'));
  } catch {
    return serveFallback();
  }
  if (decoded.includes('\0')) return { file: null, status: 403 };

  // Resolve relative to the root; path.resolve normalises "..", "." and duplicate slashes.
  const target = path.resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  const inside = target === root || target.startsWith(root + path.sep);
  if (!inside) return { file: null, status: 403 };

  const st = statOrNull(target);
  if (st?.isFile()) return { file: target, status: 200 };
  if (st?.isDirectory()) {
    const index = path.join(target, 'index.html');
    if (statOrNull(index)?.isFile()) return { file: index, status: 200 };
  }
  return serveFallback();
}

function textResponse(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': CACHE_NO_CACHE } });
}

/**
 * Build the Response for one bucks:// request. Exported for tests and for the handler.
 * @param {string} uiDist
 * @param {string} requestUrl
 * @returns {Promise<Response>}
 */
export async function handleBucksRequest(uiDist, requestUrl) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return textResponse(400, 'Bad request');
  }
  if (url.hostname !== BUCKS_APP_HOST) return textResponse(404, 'Not found');

  const { file, status } = resolveBucksPath(uiDist, url.pathname);
  if (!file) {
    if (status === 503) {
      return textResponse(503, 'The Bucks Browser chrome has not been built. Run "npm run build:ui" and restart.');
    }
    return textResponse(status, status === 403 ? 'Forbidden' : 'Not found');
  }

  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return textResponse(404, 'Not found');
  }

  const headers = { 'Content-Type': contentTypeFor(file), 'Content-Length': String(st.size) };
  const cache = cacheControlFor(url.pathname, file);
  if (cache) headers['Cache-Control'] = cache;

  const stream = fs.createReadStream(file);
  return new Response(Readable.toWeb(stream), { status, headers });
}

/**
 * Register the bucks:// handler on a session. Only host "app" is served, from `uiDist`.
 * @param {{ session: import('electron').Session, uiDist: string }} opts
 */
export function installBucksProtocol({ session, uiDist }) {
  if (!session?.protocol?.handle) throw new Error('installBucksProtocol: a session with protocol.handle is required');
  if (!uiDist) throw new Error('installBucksProtocol: uiDist is required');
  session.protocol.handle('bucks', (request) =>
    handleBucksRequest(uiDist, request.url).catch((e) => textResponse(500, `Internal error: ${e?.message || e}`)),
  );
}
