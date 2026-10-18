// ipfs:// and ipns:// protocol handlers. Requests are proxied (streamed, never buffered) to
// the local Kubo path gateway when the node is ready, otherwise to the configured public
// gateway, with small self-contained HTML pages for every error state.
// No Electron import on purpose: the pure helpers are unit-tested under plain node, and the
// session objects passed in carry everything we need (session.protocol.handle).

import { parseIpfsUrl, isCid } from '../ipfs/cid.js';
import { normalizeGatewayBase } from '../ipfs/kubo.js';
import { createLogger } from '../log.js';

const log = createLogger('ipfs-protocol');

const UPSTREAM_HEADERS_TIMEOUT_MS = 60_000; // Kubo's own gateway timeout is 60 s for content not found on the network
const FORWARDED_REQUEST_HEADERS = ['range', 'accept', 'if-none-match', 'if-modified-since'];
const FORWARDED_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified',
  'cache-control', 'x-ipfs-path', 'x-ipfs-roots', 'content-disposition', 'content-security-policy',
  // CORS headers set by the gateway so dapps on one CID can fetch from another.
  'access-control-allow-origin', 'access-control-expose-headers',
];
const LOWERCASE_CIDV0 = /^qm[a-z0-9]{44}$/;
const IPNS_NAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/* ───────────────────────────── pure helpers ───────────────────────────── */

/**
 * Build the upstream path-gateway URL for a parsed ipfs/ipns URL.
 * @param {string} base  gateway base, e.g. http://127.0.0.1:8080 (trailing slash tolerated)
 * @param {{ scheme: 'ipfs'|'ipns', host: string, pathname: string, search: string }} parsed
 */
export function buildUpstreamUrl(base, parsed) {
  const b = String(base).replace(/\/+$/, '');
  const pathname = parsed.pathname && parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname || ''}`;
  return `${b}/${parsed.scheme}/${parsed.host}${pathname}${parsed.search || ''}`;
}

/**
 * Rewrite a gateway Location header back into ipfs:// / ipns:// form.
 * Handles path-style (/ipfs/<cid>/dir/), absolute path-style (http://gw/ipns/name/) and
 * subdomain-style (http://<cid>.ipfs.gw/) redirects. Anything else is returned unchanged.
 * @param {string} location
 * @param {'ipfs'|'ipns'} scheme  scheme of the original request (used for relative redirects)
 */
export function rewriteLocation(location, scheme) {
  const loc = String(location || '').trim();
  if (!loc) return loc;
  let m = /^\/(ipfs|ipns)\/([^/?#]+)(.*)$/i.exec(loc);
  if (m) return `${m[1].toLowerCase()}://${m[2]}${m[3] || '/'}`;
  if (/^https?:\/\//i.test(loc)) {
    let u;
    try { u = new URL(loc); } catch { return loc; }
    m = /^\/(ipfs|ipns)\/([^/?#]+)(.*)$/i.exec(u.pathname + u.search + u.hash);
    if (m) return `${m[1].toLowerCase()}://${m[2]}${m[3] || '/'}`;
    const sub = /^([^.]+)\.(ipfs|ipns)\./i.exec(u.hostname);
    if (sub) return `${sub[2].toLowerCase()}://${sub[1]}${u.pathname}${u.search}${u.hash}`;
    return loc;
  }
  if (/^(ipfs|ipns):\/\//i.test(loc)) return loc;
  // relative redirect (rare): keep it relative so Chromium resolves it against the ipfs:// URL
  void scheme;
  return loc;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Render a tiny dark-themed, self-contained HTML page.
 * @param {{ title: string, heading?: string, message?: string, detail?: string, extraHtml?: string, refreshSeconds?: number }} opts
 */
export function renderErrorPage({ title, heading, message = '', detail = '', extraHtml = '', refreshSeconds }) {
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${Number(refreshSeconds)}">` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e6e6;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:560px;padding:32px 36px;margin:24px;background:#171a21;border:1px solid #262a33;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{font-size:20px;margin:0 0 12px}p{margin:8px 0;color:#c3c7d1}code{background:#0f1115;border:1px solid #262a33;border-radius:6px;padding:2px 6px;font-size:13px;word-break:break-all}
a{color:#7cc4ff}.muted{color:#8a90a0;font-size:13px}.spinner{display:inline-block;width:14px;height:14px;border:2px solid #3a3f4c;border-top-color:#7cc4ff;border-radius:50%;animation:s 1s linear infinite;vertical-align:-2px;margin-right:8px}
@keyframes s{to{transform:rotate(360deg)}}
</style></head>
<body><main><h1>${escapeHtml(heading || title)}</h1>${message ? `<p>${message}</p>` : ''}${detail ? `<p class="muted"><code>${escapeHtml(detail)}</code></p>` : ''}${extraHtml}</main></body></html>`;
}

function htmlResponse(html, status, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      ...extraHeaders,
    },
  });
}

function landingPage(scheme) {
  return renderErrorPage({
    title: scheme === 'ipns' ? 'IPNS' : 'IPFS',
    heading: scheme === 'ipns' ? 'Browse the InterPlanetary Name System' : 'Browse the InterPlanetary File System',
    message: scheme === 'ipns'
      ? 'Type an IPNS name or DNSLink domain after the scheme, for example <code>ipns://en.wikipedia-on-ipfs.org/</code> or <code>ipns://k51…</code>.'
      : 'Type a content identifier after the scheme, for example <code>ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/</code>.',
    extraHtml: '<p class="muted">Content is fetched from your local IPFS node when it is running, otherwise from a public gateway. See <a href="bucks://ipfs">bucks://ipfs</a> for node status, pins and uploads.</p>',
  });
}

function invalidHostPage(scheme, host) {
  if (scheme === 'ipfs' && LOWERCASE_CIDV0.test(host)) {
    return renderErrorPage({
      title: 'Invalid IPFS address',
      heading: 'CIDv0 must be written as CIDv1',
      message: 'Browsers lowercase the host part of a URL, which breaks case-sensitive <code>Qm…</code> (CIDv0) identifiers. Convert it to a CIDv1 (<code>bafy…</code>) address first.',
      detail: `ipfs://${host}`,
      extraHtml: '<p class="muted">Paste the CID on the <a href="bucks://ipfs">bucks://ipfs</a> page to convert it, or type <code>ipfs://ipfs/Qm…</code> in the address bar so Bucks can normalise it for you.</p>',
    });
  }
  return renderErrorPage({
    title: `Invalid ${scheme.toUpperCase()} address`,
    heading: scheme === 'ipfs' ? 'That is not a valid content identifier' : 'That is not a valid IPNS name',
    message: scheme === 'ipfs'
      ? 'The host part of an <code>ipfs://</code> URL must be a CID such as <code>bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi</code>.'
      : 'The host part of an <code>ipns://</code> URL must be a peer id (<code>k51…</code>, <code>12D3Koo…</code>) or a DNSLink domain.',
    detail: `${scheme}://${host}`,
  });
}

function notFoundPage(parsed) {
  return renderErrorPage({
    title: 'Content not found',
    heading: 'Content not found on the IPFS network within the timeout',
    message: 'No peer that holds this content could be reached. It may be unpinned, still propagating, or your node may have no connectivity. Reload to try again.',
    detail: `${parsed.scheme}://${parsed.host}${parsed.pathname}`,
  });
}

function startingPage(statusMessage) {
  return renderErrorPage({
    title: 'Starting IPFS node',
    heading: '<span class="spinner"></span>Starting local IPFS node…',
    message: escapeHtml(statusMessage || 'Please wait.'),
    extraHtml: '<p class="muted">This page refreshes automatically.</p>',
    refreshSeconds: 2,
  });
}

/* ───────────────────────────── proxying ───────────────────────────── */

function forwardedHeaders(request) {
  const h = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = request.headers.get(name);
    if (v) h.set(name, v);
  }
  h.set('accept-encoding', 'identity');
  return h;
}

async function proxy(request, parsed, gatewayBase, { isLocal }) {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return htmlResponse(renderErrorPage({ title: 'Method not allowed', message: `${escapeHtml(method)} is not supported for ${parsed.scheme}:// URLs.` }), 405, { Allow: 'GET, HEAD' });
  }
  const upstreamUrl = buildUpstreamUrl(gatewayBase, parsed);
  // The timeout only covers the response headers: once they are in, the body streams for as
  // long as it takes (large files), and Chromium cancels the stream if the tab goes away.
  const ctrl = new AbortController();
  const headersTimer = setTimeout(() => ctrl.abort(new DOMException('Upstream headers timed out', 'TimeoutError')), UPSTREAM_HEADERS_TIMEOUT_MS);
  headersTimer.unref?.();
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers: forwardedHeaders(request),
      redirect: 'manual',
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') return htmlResponse(notFoundPage(parsed), 504);
    const reason = e?.cause?.message || e?.message || String(e);
    return htmlResponse(renderErrorPage({
      title: isLocal ? 'Local gateway unreachable' : 'Gateway unreachable',
      heading: isLocal ? 'The local IPFS gateway did not respond' : 'The public IPFS gateway did not respond',
      message: 'Reload to try again. If the problem persists, restart the IPFS node from <a href="bucks://ipfs">bucks://ipfs</a>.',
      detail: reason,
    }), 502);
  } finally {
    clearTimeout(headersTimer);
  }

  if (upstream.status === 504 || upstream.status === 502) {
    try { await upstream.body?.cancel(); } catch { /* ignore */ }
    return htmlResponse(notFoundPage(parsed), 504);
  }

  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  if (REDIRECT_STATUSES.has(upstream.status)) {
    const loc = upstream.headers.get('location');
    if (loc) headers.set('location', rewriteLocation(loc, parsed.scheme));
    try { await upstream.body?.cancel(); } catch { /* ignore */ }
    return new Response(null, { status: upstream.status, headers });
  }
  const noBody = method === 'HEAD' || upstream.status === 204 || upstream.status === 304;
  if (noBody) {
    try { await upstream.body?.cancel(); } catch { /* ignore */ }
  }
  return new Response(noBody ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/* ───────────────────────────── handler ───────────────────────────── */

/**
 * Build the request handler shared by ipfs:// and ipns://.
 * @param {{ kubo: any, settings: any }} deps
 */
export function createIpfsHandler({ kubo, settings }) {
  return async function handleIpfsRequest(request) {
    try {
      const parsed = parseIpfsUrl(request.url);
      if (!parsed) return htmlResponse(renderErrorPage({ title: 'Bad request', message: 'Unrecognised URL.' }), 400);
      const scheme = parsed.scheme;
      const host = parsed.host;

      if (!host) return htmlResponse(landingPage(scheme), 200);
      if (scheme === 'ipfs') {
        if (!isCid(host)) return htmlResponse(invalidHostPage(scheme, host), 400);
      } else if (!IPNS_NAME.test(host) || host.length > 253) {
        return htmlResponse(invalidHostPage(scheme, host), 400);
      }

      const cfg = (settings.get?.() || {}).ipfs || {};
      const preferPublic = cfg.preferredGateway === 'public';
      if (!preferPublic && kubo.isReady() && kubo.gatewayUrl()) {
        return await proxy(request, parsed, kubo.gatewayUrl(), { isLocal: true });
      }
      const status = kubo.status();
      if (!preferPublic && status.state === 'initializing') {
        return htmlResponse(startingPage(status.message), 503, { 'Retry-After': '2' });
      }
      // error / stopped / idle, or the user prefers the public gateway
      return await proxy(request, parsed, normalizeGatewayBase(cfg.publicGateway), { isLocal: false });
    } catch (e) {
      log.error(`ipfs protocol handler failed for ${request?.url}:`, e);
      return htmlResponse(renderErrorPage({
        title: 'IPFS error',
        heading: 'Something went wrong while loading this address',
        detail: e?.message || String(e),
      }), 500);
    }
  };
}

/**
 * Register ipfs:// and ipns:// on every given session (the default session serves the chrome,
 * persist:bucks-web serves tabs; Electron protocol handlers are per session).
 * @param {{ sessions: Array<import('electron').Session>, kubo: any, settings: any }} deps
 */
export function installIpfsProtocols({ sessions, kubo, settings }) {
  const handler = createIpfsHandler({ kubo, settings });
  for (const ses of sessions) {
    for (const scheme of ['ipfs', 'ipns']) {
      if (ses.protocol.isProtocolHandled(scheme)) ses.protocol.unhandle(scheme);
      ses.protocol.handle(scheme, handler);
    }
  }
  log.info(`ipfs:// and ipns:// registered on ${sessions.length} session(s)`);
  return handler;
}
