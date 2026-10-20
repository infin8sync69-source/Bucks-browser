// ipfs:// and ipns:// protocol handlers. Requests are proxied (streamed, never buffered) to the
// local Kubo path gateway when the node is ready. When it is not, the visitor is asked before a
// public gateway is used (gateway-consent.js). Each site is served by its descriptor
// (bucks-site.json or _redirects, site-serving.js): SPA fallback, custom 404 pages, redirects,
// extra headers, and HTML detection for extensionless files. Every error state has a small,
// self-contained HTML page.
// No Electron import on purpose: the pure helpers are unit-tested under plain node, and the
// session objects passed in carry everything we need (session.protocol.handle).

import { parseIpfsUrl, isCid, isPeerId } from '../ipfs/cid.js';
import { createLogger } from '../log.js';
import { buildDescriptor, headersFor, hasExtension, matchRedirect, DEFAULT_ENTRY } from '../sites/package.js';
import {
  looksLikeHtml, shouldServeFallback, fallbackCacheControl, guardContentLength, peekBody,
  createDescriptorCache, createRootResolver, rootFromHeaders, IPNS_CACHE_CONTROL, isSafeRequestPath,
} from './site-serving.js';
import { validatePublicGateway, createConsent, readConsentParam, consentUrl, renderInterstitial } from './gateway-consent.js';
import { pageStyle, CARD_PAGE_CSS } from '../design/page.js';

const log = createLogger('ipfs-protocol');

const UPSTREAM_HEADERS_TIMEOUT_MS = 60_000; // Kubo's own gateway timeout is 60 s for content not found on the network
const FORWARDED_REQUEST_HEADERS = ['range', 'accept', 'if-none-match', 'if-modified-since'];
const FORWARDED_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified',
  'cache-control', 'x-ipfs-path', 'x-ipfs-roots', 'content-disposition',
  // CORS headers set by the gateway so dapps on one CID can fetch from another.
  'access-control-allow-origin', 'access-control-expose-headers',
];
const MAX_REMEMBERED_ORIGINS = 1000;
const LOWERCASE_CIDV0 = /^qm[a-z0-9]{44}$/;
const IPNS_NAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_SELF_REDIRECTS = 3;

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

/** True when `rewritten` (an ipfs:// / ipns:// URL) addresses the same scheme, host, path and query as `parsed`. */
function isSameTarget(rewritten, parsed) {
  const r = parseIpfsUrl(rewritten);
  return Boolean(r) && r.scheme === parsed.scheme && r.host.toLowerCase() === parsed.host.toLowerCase()
    && r.pathname === (parsed.pathname || '/') && r.search === (parsed.search || '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Render a small self-contained HTML page in the Bucks dark theme (design tokens, src/main/design).
 * @param {{ title: string, heading?: string, message?: string, detail?: string, extraHtml?: string, refreshSeconds?: number }} opts
 */
export function renderErrorPage({ title, heading, message = '', detail = '', extraHtml = '', refreshSeconds }) {
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${Number(refreshSeconds)}">` : '';
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}
<title>${escapeHtml(title)}</title>
${pageStyle(`${CARD_PAGE_CSS}main{max-width:560px}`)}</head>
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
    extraHtml: '<p class="muted">Content is fetched from your local IPFS node. When it is not running, Bucks asks before using a public gateway. See <a href="bucks://ipfs">bucks://ipfs</a> for node status, pins and uploads.</p>',
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

function offlinePage(url, parsed, record) {
  const what = parsed.scheme === 'ipns' ? 'name' : 'CID';
  const recordLine = record
    ? `<p class="muted">Newest record found for this name: sequence ${record.sequence}${record.validity ? `, valid until ${escapeHtml(record.validity)}` : ''}${record.value ? `, pointing to <code>${escapeHtml(record.value)}</code>` : ''}.</p>`
    : '';
  return renderErrorPage({
    title: 'Content unavailable',
    heading: 'No online node has this content right now',
    message: `The publisher's browser may be closed, or no node that keeps a copy is reachable. Try again later.`,
    detail: `${what}: ${parsed.host}`,
    extraHtml: `${recordLine}<p><a href="${escapeHtml(url)}">Retry</a></p>`,
  });
}

function notInSitePage(parsed) {
  return renderErrorPage({
    title: 'Not found',
    heading: 'This page does not exist in this site',
    message: 'The site was found, but it has no file at this address.',
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

const isOctetStream = (type) => !type || /^application\/octet-stream\b/i.test(type);

/**
 * Build the request handler shared by ipfs:// and ipns://. The returned function also carries
 * badgeFor(url) (the address bar badge, §6.7), setPreview(cid, on) (unpublished previews) and
 * setNameTarget(name, cid) (what a name this browser publishes points to now).
 * @param {{ kubo: any, settings: any, fetchImpl?: typeof fetch, gatewayValidator?: typeof validatePublicGateway, now?: () => number }} deps
 *   gatewayValidator: checks settings.ipfs.publicGateway (tests swap it to allow a loopback fake)
 */
export function createIpfsHandler({ kubo, settings, fetchImpl = (...a) => globalThis.fetch(...a), gatewayValidator = validatePublicGateway, now = Date.now }) {
  const descriptors = createDescriptorCache({ fetchImpl });
  const roots = createRootResolver({ fetchImpl });
  const consent = createConsent({ now });
  const sources = new Map(); // origin → 'local' | 'public': where it was last served from
  const previews = new Set(); // CIDs opened as "Preview, not published"
  // Names this browser publishes, and the version each points to now. Kubo keeps serving a name's
  // previous version for up to the record TTL after a republish; we hold the key, so we know better.
  const ownNames = new Map();

  function remember(origin, source) {
    sources.delete(origin);
    sources.set(origin, source);
    if (sources.size > MAX_REMEMBERED_ORIGINS) sources.delete(sources.keys().next().value);
  }

  /**
   * Fetch one path of the site from the gateway. Resolves to { res } or, when the gateway failed,
   * to { response } (a ready error page).
   */
  async function fetchUpstream(request, parsed, base, { path = parsed.pathname, headers = forwardedHeaders(request), method = request.method.toUpperCase(), upstreamOverride = null, hops = 0, isLocal }) {
    const upstreamUrl = upstreamOverride || buildUpstreamUrl(base, { ...parsed, pathname: path });
    // The timeout only covers the response headers: once they are in, the body streams for as
    // long as it takes (large files), and Chromium cancels the stream if the tab goes away.
    const ctrl = new AbortController();
    const headersTimer = setTimeout(() => ctrl.abort(new DOMException('Upstream headers timed out', 'TimeoutError')), UPSTREAM_HEADERS_TIMEOUT_MS);
    headersTimer.unref?.();
    let res;
    try {
      res = await fetchImpl(upstreamUrl, { method, headers, redirect: 'manual', signal: ctrl.signal });
    } catch (e) {
      if (e?.name === 'TimeoutError') return { response: await offlineResponse(request, parsed, isLocal) };
      const reason = e?.cause?.message || e?.message || String(e);
      return {
        response: htmlResponse(renderErrorPage({
          title: isLocal ? 'Local gateway unreachable' : 'Gateway unreachable',
          heading: isLocal ? 'The local IPFS gateway did not respond' : 'The public IPFS gateway did not respond',
          message: 'Reload to try again. If the problem persists, restart the IPFS node from <a href="bucks://ipfs">bucks://ipfs</a>.',
          detail: reason,
        }), 502),
      };
    } finally {
      clearTimeout(headersTimer);
    }
    if (res.status === 504 || res.status === 502) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { response: await offlineResponse(request, parsed, isLocal) };
    }
    if (REDIRECT_STATUSES.has(res.status)) {
      const loc = res.headers.get('location');
      // Public gateways bounce path requests to their subdomain origin (ipfs.io/ipfs/<cid>/ →
      // <cid>.ipfs.dweb.link/). Rewritten, that is the very URL being served, so handing it to
      // Chromium would loop forever: follow such self-redirects here instead.
      if (loc && hops < MAX_SELF_REDIRECTS && /^https?:\/\//i.test(loc) && isSameTarget(rewriteLocation(loc, parsed.scheme), { ...parsed, pathname: path })) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return fetchUpstream(request, parsed, base, { path, headers, method, upstreamOverride: new URL(loc, upstreamUrl).toString(), hops: hops + 1, isLocal });
      }
    }
    return { res };
  }

  /** §6.6: nobody online has the content. For ipns:// names, say what the newest record is. */
  async function offlineResponse(request, parsed, isLocal) {
    let record = null;
    if (parsed.scheme === 'ipns' && isLocal && kubo.rpc && isPeerId(parsed.host)) {
      try { record = await kubo.rpc.ipnsRecord(parsed.host, { timeoutMs: 5000 }); } catch { /* no record either */ }
    }
    return htmlResponse(offlinePage(request.url, parsed, record), 504);
  }

  /** Response headers for a site response: the gateway's (CSP only from the local node), the site's own, nosniff. */
  function siteHeaders(res, parsed, descriptor, isLocal) {
    const headers = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const v = res.headers.get(name);
      if (v !== null) headers.set(name, v);
    }
    if (isLocal) {
      const csp = res.headers.get('content-security-policy');
      if (csp !== null) headers.set('content-security-policy', csp);
    }
    // An ipns:// name changes when its site is updated: never cache it (see IPNS_CACHE_CONTROL).
    // ipfs:// stays immutable.
    if (parsed.scheme === 'ipns' && headers.has('cache-control')) headers.set('cache-control', IPNS_CACHE_CONTROL);
    for (const [k, v] of Object.entries(headersFor(descriptor, parsed.pathname))) headers.set(k, v);
    return headers;
  }

  /** Stream a gateway response to the tab: type repair for extensionless HTML, length guard, nosniff. */
  async function respond(res, headers, { status = res.status, method, path, repairType = true }) {
    let body = method === 'HEAD' || status === 204 || status === 304 ? null : res.body;
    if (!body) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
    } else if (repairType && method === 'GET' && status === 200 && isOctetStream(headers.get('content-type')) && !hasExtension(path)) {
      const peeked = await peekBody(body);
      body = peeked.body;
      if (looksLikeHtml(peeked.head)) headers.set('content-type', 'text/html; charset=utf-8');
    }
    if (headers.get('content-type')) headers.set('x-content-type-options', 'nosniff');
    if (body && (status === 200 || status === 206 || status === 404)) {
      const length = Number(headers.get('content-length'));
      if (headers.has('content-length') && Number.isSafeInteger(length)) body = guardContentLength(body, length);
    }
    return new Response(body, { status, headers });
  }

  /** A path inside the same version of the site (for rewrites, the SPA fallback and 404 pages). */
  function fetchInside(request, parsed, base, root, path, isLocal) {
    const [pathname, query = ''] = path.split('?');
    if (!isSafeRequestPath(pathname)) return Promise.resolve({ res: null });
    const target = root ? { scheme: 'ipfs', host: root, pathname, search: query ? `?${query}` : '' } : { ...parsed, pathname, search: query ? `?${query}` : '' };
    const headers = new Headers({ accept: request.headers.get('accept') || '*/*', 'accept-encoding': 'identity' });
    return fetchUpstream(request, target, base, { headers, method: 'GET', isLocal });
  }

  /** §6.2 steps 2–5 and §6.3: what a site shows for a path the gateway does not have. */
  async function serveMissing(request, parsed, base, root, descriptor, isLocal) {
    const method = request.method.toUpperCase();
    const match = matchRedirect(descriptor.rules, parsed.pathname);
    if (match) {
      const { status } = match.rule;
      if (status === 301 || status === 302) {
        const location = /^https?:\/\//i.test(match.target) ? match.target : `${parsed.scheme}://${parsed.host}${match.target}`;
        return new Response(null, { status, headers: { location, 'cache-control': 'no-store' } });
      }
      const sub = await fetchInside(request, parsed, base, root, match.target, isLocal);
      if (sub.res?.status === 200) return respond(sub.res, siteHeaders(sub.res, parsed, descriptor, isLocal), { status, method, path: match.target.split('?')[0] });
      try { await sub.res?.body?.cancel(); } catch { /* ignore */ }
    }
    if (shouldServeFallback({ method, accept: request.headers.get('accept'), pathname: parsed.pathname, descriptor })) {
      const sub = await fetchInside(request, parsed, base, root, `/${descriptor.fallback}`, isLocal);
      if (sub.res?.status === 200) {
        const headers = siteHeaders(sub.res, parsed, descriptor, isLocal);
        headers.set('content-type', 'text/html; charset=utf-8');
        headers.set('cache-control', fallbackCacheControl(parsed.scheme));
        headers.delete('etag');
        return respond(sub.res, headers, { status: 200, method, path: parsed.pathname, repairType: false });
      }
      try { await sub.res?.body?.cancel(); } catch { /* ignore */ }
    }
    if (descriptor.notFound && method === 'GET') {
      const sub = await fetchInside(request, parsed, base, root, `/${descriptor.notFound}`, isLocal);
      if (sub.res?.status === 200) {
        const headers = siteHeaders(sub.res, parsed, descriptor, isLocal);
        headers.set('cache-control', 'no-store');
        return respond(sub.res, headers, { status: 404, method, path: descriptor.notFound });
      }
      try { await sub.res?.body?.cancel(); } catch { /* ignore */ }
    }
    return htmlResponse(notInSitePage(parsed), 404);
  }

  /** Serve one request of a site through `base` (the local node, or a public gateway with consent). */
  async function serveSite(request, parsed, base, { isLocal, origin }) {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return htmlResponse(renderErrorPage({ title: 'Method not allowed', message: `${escapeHtml(method)} is not supported for ${parsed.scheme}:// URLs.` }), 405, { Allow: 'GET, HEAD' });
    }
    remember(origin, isLocal ? 'local' : 'public');
    // For ipfs:// the descriptor lookup runs alongside the request. For ipns:// the root is the one
    // the answer came from, or (a 404 carries none) the one the name points to right now.
    let root = parsed.scheme === 'ipfs' ? parsed.host : null;
    const own = parsed.scheme === 'ipns' && isLocal ? ownNames.get(parsed.host.toLowerCase()) : null;
    if (own) root = own;
    let pending = root ? descriptors.get(base, root) : null;
    let up = own
      ? await fetchUpstream(request, { ...parsed, scheme: 'ipfs', host: own }, base, { isLocal })
      : await fetchUpstream(request, parsed, base, { isLocal });
    if (up.response) return up.response;
    if (own) {
      roots.record(parsed.host, own);
    } else if (parsed.scheme === 'ipns') {
      root = rootFromHeaders(up.res.headers);
      if (root) roots.record(parsed.host, root);
      else if (up.res.status === 404) root = await roots.lookup(base, parsed.host);
      if (root) pending = descriptors.get(base, root);
    }
    const descriptor = pending ? await pending : buildDescriptor({});
    let path = parsed.pathname;
    // A manifest `entry` other than index.html is what `/` shows.
    if (path === '/' && descriptor.entry !== DEFAULT_ENTRY && up.res.status === 200) {
      try { await up.res.body?.cancel(); } catch { /* ignore */ }
      path = `/${descriptor.entry}`;
      up = await fetchInside(request, parsed, base, root, path, isLocal);
      if (up.response) return up.response;
      if (!up.res) return htmlResponse(notInSitePage(parsed), 404);
    }
    const { res } = up;

    if (REDIRECT_STATUSES.has(res.status)) {
      const headers = siteHeaders(res, parsed, descriptor, isLocal);
      const loc = res.headers.get('location');
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (loc) {
        let location = rewriteLocation(loc, parsed.scheme);
        // served from the exact version of one of our names: keep the visitor on the ipns:// origin
        if (own && location.startsWith(`ipfs://${own}`)) location = `ipns://${parsed.host}${location.slice(`ipfs://${own}`.length)}`;
        headers.set('location', location);
      }
      return new Response(null, { status: res.status, headers });
    }
    if (res.status === 404) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return serveMissing(request, parsed, base, root, descriptor, isLocal);
    }
    return respond(res, siteHeaders(res, parsed, descriptor, isLocal), { method, path });
  }

  /** The interstitial's buttons come back here as ?bucks-gateway=<action>.<nonce>. */
  function handleConsent(parsed, origin, param, cfg) {
    const cleanUrl = `${parsed.scheme}://${parsed.host}${parsed.pathname}${param.search}`;
    if (consent.take(param.nonce, origin)) {
      if (param.action === 'once' && gatewayValidator(cfg.publicGateway).ok) consent.allow(origin);
      if (param.action === 'start') kubo.start?.().catch((e) => log.warn(`IPFS start from the interstitial failed: ${e.message}`));
    }
    return new Response(null, { status: 303, headers: { location: cleanUrl, 'cache-control': 'no-store' } });
  }

  function interstitial(request, parsed, origin, cfg, status) {
    const gw = gatewayValidator(cfg.publicGateway);
    const url = request.url.split('#')[0];
    const html = renderInterstitial({
      url,
      nodeMessage: status.message || status.state,
      startHref: consentUrl(url, 'start', consent.issue(origin)),
      onceHref: gw.ok ? consentUrl(url, 'once', consent.issue(origin)) : null,
      gatewayHost: gw.ok ? new URL(gw.base).host : null,
      gatewayProblem: gw.ok ? null : gw.reason,
    });
    return htmlResponse(html, 503, {
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    });
  }

  async function handleIpfsRequest(request) {
    try {
      const parsed = parseIpfsUrl(request.url);
      if (!parsed) return htmlResponse(renderErrorPage({ title: 'Bad request', message: 'Unrecognised URL.' }), 400);
      const { scheme, host } = parsed;

      if (!host) return htmlResponse(landingPage(scheme), 200);
      if (scheme === 'ipfs') {
        if (!isCid(host)) return htmlResponse(invalidHostPage(scheme, host), 400);
      } else if (!IPNS_NAME.test(host) || host.length > 253) {
        return htmlResponse(invalidHostPage(scheme, host), 400);
      }
      if (!isSafeRequestPath(parsed.pathname)) {
        return htmlResponse(renderErrorPage({ title: 'Invalid address', heading: 'This address is not valid', message: 'Its path tries to leave the site (an encoded "/" or "..").', detail: `${scheme}://${host}${parsed.pathname}` }), 400);
      }
      const origin = `${scheme}://${host.toLowerCase()}`;
      const cfg = (settings.get?.() || {}).ipfs || {};
      const param = readConsentParam(parsed.search);
      if (param) return handleConsent(parsed, origin, param, cfg);

      const preferPublic = cfg.preferredGateway === 'public';
      if (!preferPublic && kubo.isReady() && kubo.gatewayUrl()) {
        return await serveSite(request, parsed, kubo.gatewayUrl(), { isLocal: true, origin });
      }
      const status = kubo.status();
      if (!preferPublic && status.state === 'initializing') {
        sources.delete(origin); // the tab shows Bucks' page, not the site: no badge
        return htmlResponse(startingPage(status.message), 503, { 'Retry-After': '2' });
      }
      // preferredGateway = public is the user's standing choice; otherwise ask first (§6.5).
      if (preferPublic || consent.isAllowed(origin)) {
        const gw = gatewayValidator(cfg.publicGateway);
        if (!gw.ok) {
          return htmlResponse(renderErrorPage({ title: 'Public gateway not usable', heading: 'The public gateway setting is not usable', message: escapeHtml(gw.reason), detail: String(cfg.publicGateway || '') }), 502);
        }
        return await serveSite(request, parsed, gw.base, { isLocal: false, origin });
      }
      sources.delete(origin);
      return interstitial(request, parsed, origin, cfg, status);
    } catch (e) {
      log.error(`ipfs protocol handler failed for ${request?.url}:`, e);
      return htmlResponse(renderErrorPage({
        title: 'IPFS error',
        heading: 'Something went wrong while loading this address',
        detail: e?.message || String(e),
      }), 500);
    }
  }

  /**
   * The address bar badge for a URL (§6.7), from where its origin was last served; null for
   * other URLs or before anything was served.
   * @returns {{ kind: 'preview'|'unverified'|'content-addressed'|'signed-name'|'dnslink', label: string, cid?: string|null } | null}
   */
  handleIpfsRequest.badgeFor = (url) => {
    const p = parseIpfsUrl(String(url || ''));
    if (!p || !p.host) return null;
    const host = p.host.toLowerCase();
    if (p.scheme === 'ipfs' && previews.has(host)) return { kind: 'preview', label: 'Preview, not published' };
    const source = sources.get(`${p.scheme}://${host}`);
    if (!source) return null;
    if (source === 'public') return { kind: 'unverified', label: 'Unverified, via gateway' };
    if (p.scheme === 'ipfs') return { kind: 'content-addressed', label: 'Content-addressed' };
    if (isPeerId(host)) return { kind: 'signed-name', label: 'Signed name, updates allowed', cid: roots.current(host) };
    return { kind: 'dnslink', label: 'DNSLink name, updates allowed', cid: roots.current(host) };
  };
  /** A name this browser just published (or rolled back): serve it from `cid` from now on. */
  handleIpfsRequest.setNameTarget = (name, cid) => {
    if (typeof name !== 'string' || !name) return;
    if (typeof cid === 'string' && cid) ownNames.set(name.toLowerCase(), cid);
    else ownNames.delete(name.toLowerCase()); // the key was deleted
  };
  /** Mark a CID as an unpublished preview (or not any more). */
  handleIpfsRequest.setPreview = (cid, on = true) => {
    const c = String(cid || '').toLowerCase();
    if (on) previews.add(c); else previews.delete(c);
  };
  return handleIpfsRequest;
}

/**
 * Register ipfs:// and ipns:// on every given session (the default session serves the chrome,
 * persist:bucks-web serves tabs; Electron protocol handlers are per session).
 * @param {{ sessions: Array<import('electron').Session>, kubo: any, settings: any }} deps
 * @returns {ReturnType<typeof createIpfsHandler>} the handler (also used by the sites service's self-test)
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
