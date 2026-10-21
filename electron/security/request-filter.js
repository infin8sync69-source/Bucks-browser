'use strict';
// Request filtering for web-content sessions: HTTPS-only upgrades, ad/tracker blocking and
// cookie policy. Electron allows ONE webRequest.onBeforeRequest and ONE onHeadersReceived listener
// per session, so everything shares the two handlers built here. The decision logic is pure and
// unit-tested (electron/test/unit/security.test.js); main.js only wires it to the sessions.
// Ported from Bucks-browser (src/main/security/filter.js), minus the Ghostery engine: the
// existing pattern list is the blocker.

const { isThirdParty, stripSetCookie } = require('./cookies');

const COOKIE_POLICIES = new Set(['allow', 'block-third-party', 'block-all']);

/** True for RFC1918, loopback and link-local IPv4 literals. */
function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Hosts that never get upgraded to HTTPS: localhost, 127.0.0.1, [::1], *.localhost, *.local,
 * private/link-local IPs, unique-local/link-local IPv6 and single-label intranet names.
 * @param {string} hostname as in URL.hostname (IPv6 literals keep their brackets)
 */
function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return v6 === '::1' || v6 === '::' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
  }
  if (isPrivateIPv4(host)) return true;
  return !host.includes('.') && !/^\d+$/.test(host);
}

/**
 * http:// requests are redirected to https:// when `state.httpsOnly`, unless the host is local
 * or plain http was allowed for it (`state.isHttpAllowed(host)`).
 * @returns {{ redirectURL: string } | {}}
 */
function decideRequest(details, state) {
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return {};
  }
  if (url.protocol === 'http:' && state.httpsOnly) {
    if (isLocalHost(url.hostname) || state.isHttpAllowed(url.hostname)) return {};
    url.protocol = 'https:';
    return { redirectURL: url.href };
  }
  return {};
}

/** Best guess at the top-level page URL a response belongs to. */
function firstPartyUrlOf(details) {
  const candidates = [
    () => details.frame?.top?.url,
    () => details.webContents?.getURL?.(),
    () => details.frame?.url,
    () => details.referrer,
  ];
  for (const get of candidates) {
    try {
      const v = get();
      if (typeof v === 'string' && v) return v;
    } catch {
      // frame or webContents already destroyed
    }
  }
  return '';
}

/** Third-party response (cookie from a site other than the page's)? Top-level documents never are. */
function isThirdPartyResponse(details) {
  if (details.resourceType === 'mainFrame') return false;
  return isThirdParty(details.url, firstPartyUrlOf(details));
}

/** Only http(s) responses carry web cookies; the shell (file://) and bucks:// are never touched. */
function isWebUrl(url) {
  return /^https?:/i.test(String(url || ''));
}

/**
 * @param {object} opts
 * @param {RegExp[]} opts.adPatterns compiled ad/tracker URL patterns
 * @param {(details: object, callback: Function) => void} [opts.chainHeadersReceived] runs after the
 *   cookie policy, so one listener can also add the shell's CSP
 */
function createRequestFilter({ adPatterns = [], chainHeadersReceived } = {}) {
  const flags = { httpsOnly: false, adBlock: true, cookiePolicy: 'allow' };
  const counters = { blockedRequests: 0, httpsUpgrades: 0, blockedCookies: 0 };
  const allowedHttp = new Set();
  const upgradedHosts = new Set();
  const hostKey = (h) => String(h || '').toLowerCase().replace(/\.$/, '');
  const state = {
    get httpsOnly() { return flags.httpsOnly; },
    isHttpAllowed: (h) => allowedHttp.has(hostKey(h)),
  };

  function applySettings(s = {}) {
    flags.httpsOnly = s.httpsOnly === true;
    flags.adBlock = s.adBlockEnabled !== false;
    flags.cookiePolicy = COOKIE_POLICIES.has(s.cookiePolicy) ? s.cookiePolicy : 'allow';
  }

  function handleBeforeRequest(details, callback) {
    try {
      const decision = decideRequest(details, state);
      if (decision.redirectURL) {
        counters.httpsUpgrades++;
        if (details.resourceType === 'mainFrame') upgradedHosts.add(hostKey(new URL(details.url).hostname));
        return callback(decision);
      }
      if (flags.adBlock && details.resourceType !== 'mainFrame' && adPatterns.some((re) => re.test(details.url))) {
        counters.blockedRequests++;
        return callback({ cancel: true });
      }
    } catch (e) {
      console.error('[Security] onBeforeRequest failed:', e);
    }
    return callback({});
  }

  function handleHeadersReceived(details, callback) {
    let headers = details.responseHeaders;
    try {
      if (headers && isWebUrl(details.url)) {
        const blockAll = flags.cookiePolicy === 'block-all';
        const blockThird = flags.cookiePolicy === 'block-third-party' && isThirdPartyResponse(details);
        if (blockAll || blockThird) {
          const stripped = stripSetCookie(headers);
          if (stripped.removed > 0) {
            counters.blockedCookies += stripped.removed;
            headers = stripped.headers;
          }
        }
      }
    } catch (e) {
      console.error('[Security] onHeadersReceived failed:', e);
    }
    const next = { ...details, responseHeaders: headers };
    if (chainHeadersReceived) return chainHeadersReceived(next, callback);
    return callback({ responseHeaders: headers });
  }

  return {
    applySettings,
    handleBeforeRequest,
    handleHeadersReceived,
    /** Install the two listeners on an Electron session (replacing any previous ones). */
    attach(ses) {
      ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, handleBeforeRequest);
      ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, handleHeadersReceived);
    },
    stats: () => ({ ...counters }),
    /** Allow plain http for a host (set when an https upgrade failed to connect). */
    allowHttpHost(host) {
      const key = hostKey(host);
      if (key) allowedHttp.add(key);
    },
    isHttpAllowed: (host) => allowedHttp.has(hostKey(host)),
    /** Was this host's main-frame navigation upgraded to https by us? */
    wasUpgraded: (host) => upgradedHosts.has(hostKey(host)),
  };
}

let _shared = null;
/** The filter main.js installed (null before startup). tab-manager uses it for the http fallback. */
function setSharedFilter(f) { _shared = f; }
function getSharedFilter() { return _shared; }

module.exports = { setSharedFilter, getSharedFilter, createRequestFilter, decideRequest, isLocalHost, isThirdPartyResponse };
