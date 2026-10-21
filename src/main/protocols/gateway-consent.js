// Consent before a public gateway is used (docs/IPFS-HOSTING-IMPLEMENTATION.md §6.5). When the local
// node is not running, an ipfs:// or ipns:// page shows an interstitial instead of silently loading
// through a public gateway (which sees the address and the visitor's IP). Its buttons are links
// back to the same URL with a one-time nonce bound to that origin, so another page cannot grant
// consent on the user's behalf: it cannot read the nonce (no CORS on these pages) and the page
// refuses to be framed. No Electron imports.

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { pageStyle, CARD_PAGE_CSS } from '../design/page.js';

export const CONSENT_PARAM = 'bucks-gateway';
const NONCE_TTL_MS = 10 * 60_000;
const MAX_NONCES = 200;

function isPrivateAddress(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(h)) {
    return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  }
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.');
}

/**
 * settings.ipfs.publicGateway must be an https:// URL on a public host, without credentials.
 * @returns {{ ok: true, base: string } | { ok: false, reason: string }}
 */
export function validatePublicGateway(url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    return { ok: false, reason: 'The public gateway setting is not a valid URL.' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'The public gateway must use https://.' };
  if (u.username || u.password) return { ok: false, reason: 'The public gateway URL must not contain a user name or password.' };
  if (isPrivateAddress(u.hostname)) return { ok: false, reason: 'The public gateway must be on a public host, not a local or private address.' };
  const base = `${u.origin}${u.pathname}`.replace(/\/+$/, '').replace(/\/(ipfs|ipns)$/, '');
  return { ok: true, base };
}

/**
 * Consent state for this session: one-time nonces and the origins the user allowed to load through
 * the public gateway ("Use public gateway once" lasts until Bucks restarts).
 */
export function createConsent({ now = Date.now, random = () => randomBytes(18).toString('base64url') } = {}) {
  const nonces = new Map(); // nonce → { origin, expires }
  const allowed = new Set();
  function prune() {
    const t = now();
    for (const [k, v] of nonces) if (v.expires <= t) nonces.delete(k);
    while (nonces.size > MAX_NONCES) nonces.delete(nonces.keys().next().value);
  }
  return {
    issue(origin) {
      prune();
      const nonce = random();
      nonces.set(nonce, { origin, expires: now() + NONCE_TTL_MS });
      return nonce;
    },
    /** Use a nonce once; true when it was issued for this origin and has not expired. */
    take(nonce, origin) {
      const e = nonces.get(nonce);
      if (!e) return false;
      nonces.delete(nonce);
      return e.origin === origin && e.expires > now();
    },
    allow(origin) { allowed.add(origin); },
    isAllowed: (origin) => allowed.has(origin),
  };
}

/**
 * Split our consent parameter off a request's query.
 * @param {string} search  '?a=1&bucks-gateway=once.NONCE'
 * @returns {{ action: string, nonce: string, search: string } | null}  search: the query without it
 */
export function readConsentParam(search) {
  if (!search || !search.includes(CONSENT_PARAM)) return null;
  const params = new URLSearchParams(search.slice(1));
  const value = params.get(CONSENT_PARAM);
  if (!value) return null;
  params.delete(CONSENT_PARAM);
  const [action, nonce = ''] = value.split('.', 2);
  const rest = params.toString();
  return { action, nonce, search: rest ? `?${rest}` : '' };
}

/** The same URL with our consent parameter appended. */
export function consentUrl(url, action, nonce) {
  const hashless = url.split('#')[0];
  return `${hashless}${hashless.includes('?') ? '&' : '?'}${CONSENT_PARAM}=${action}.${nonce}`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The interstitial shown while the local node is not running.
 * @param {{ url: string, nodeMessage: string, startHref: string, onceHref: string|null, gatewayHost: string|null, gatewayProblem: string|null }} p
 */
export function renderInterstitial({ url, nodeMessage, startHref, onceHref, gatewayHost, gatewayProblem }) {
  const once = onceHref
    ? `<a class="btn" href="${escapeHtml(onceHref)}">Use public gateway once</a>`
    : '';
  const gatewayNote = gatewayProblem
    ? `<p class="muted">${escapeHtml(gatewayProblem)} Change it in Settings (IPFS, public gateway).</p>`
    : `<p class="muted">The public gateway (<code>${escapeHtml(gatewayHost)}</code>) will see the address you request and your IP address, and Bucks cannot verify what it sends back. "Once" lasts for this site until Bucks restarts.</p>`;
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your IPFS node is not running</title>
${pageStyle(CARD_PAGE_CSS)}</head>
<body><main>
<h1>Your IPFS node is not running</h1>
<p>Start it to load this page from your own node, or load it through a public gateway.</p>
<p class="muted"><code>${escapeHtml(url)}</code></p>
<p class="muted">Node: ${escapeHtml(nodeMessage)}</p>
<div class="row"><a class="btn primary" href="${escapeHtml(startHref)}" autofocus>Start node</a>${once}</div>
${gatewayNote}
<p class="muted">Bucks always asks before using a public gateway.</p>
</main></body></html>`;
}
