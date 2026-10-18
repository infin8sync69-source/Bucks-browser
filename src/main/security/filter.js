// Request filtering for web-content sessions.
//
// Electron allows ONE webRequest.onBeforeRequest and ONE onHeadersReceived listener per session,
// so HTTPS-only upgrades, the ad/tracker blocker and the bucks:// hard block all share a single
// listener. The decision logic (decideRequest, blockerApplies, ...) is pure and unit-tested;
// the Electron glue in createFilterController().attach() is thin.

import { createLogger } from '../log.js';
import { loadBlocker } from './blocklist.js';
import { isThirdParty, stripSetCookie } from './cookies.js';

const log = createLogger('security');

/** Schemes the ad blocker may look at. Everything else (bucks, ipfs, ipns, file, devtools, ...) is never blocked. */
const BLOCKABLE_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

const BUCKS_CHROME_PREFIX = /^bucks:\/\/app(\/|$)/i;

/** True for RFC1918, loopback and link-local IPv4 literals. */
function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * Hosts that never get upgraded to HTTPS: localhost, 127.0.0.1, [::1], *.localhost, *.local,
 * private/link-local IPs, unique-local/link-local IPv6 and single-label intranet names.
 * @param {string} hostname as in URL.hostname (IPv6 literals keep their brackets)
 * @returns {boolean}
 */
export function isLocalHost(hostname) {
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

/** Does this chrome-originated request come from our own UI (bucks://app)? */
function isFromChrome(details) {
  try {
    const url = details.webContents?.getURL?.();
    return typeof url === 'string' && BUCKS_CHROME_PREFIX.test(url);
  } catch {
    return false;
  }
}

/**
 * Pure part of the request decision (everything except the ad blocker).
 *
 * - bucks:// requests coming from anything but the chrome are cancelled (belt and braces: the
 *   protocol is not even registered on the web session);
 * - http:// requests are redirected to https:// when `state.httpsOnly`, unless the host is local
 *   or the user/tab manager allowed plain http for it (`state.isHttpAllowed(host)`).
 *
 * @param {{ url: string, webContents?: any }} details Electron OnBeforeRequestDetails
 * @param {{ httpsOnly: boolean, isHttpAllowed: (host: string) => boolean }} state
 * @returns {{ redirectURL: string } | { cancel: true } | {}}
 */
export function decideRequest(details, state) {
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return {};
  }
  if (url.protocol === 'bucks:') {
    return isFromChrome(details) ? {} : { cancel: true };
  }
  if (url.protocol === 'http:' && state.httpsOnly) {
    if (isLocalHost(url.hostname) || state.isHttpAllowed(url.hostname)) return {};
    url.protocol = 'https:';
    return { redirectURL: url.href };
  }
  return {};
}

/**
 * Whether the ad/tracker blocker may look at this request: http(s)/ws(s) only, and never the
 * top-level document (blocking a navigation would leave the user on an error page).
 * @param {{ url: string, resourceType?: string }} details
 * @returns {boolean}
 */
export function blockerApplies(details) {
  if (details.resourceType === 'mainFrame') return false;
  return hasBlockableScheme(details.url);
}

/** http(s)/ws(s) URL? (the only schemes the blocker engine may act on) */
function hasBlockableScheme(url) {
  try {
    return BLOCKABLE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Best guess at the top-level page URL a response header belongs to. */
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

/**
 * Is this response a third-party response (cookies from a site other than the page's)?
 * Top-level documents are never third-party.
 * @param {object} details Electron OnHeadersReceivedDetails
 * @returns {boolean}
 */
export function isThirdPartyResponse(details) {
  if (details.resourceType === 'mainFrame') return false;
  return isThirdParty(details.url, firstPartyUrlOf(details));
}

/** Read the security.* settings with safe defaults. */
function readFlags(s) {
  const sec = s?.security || {};
  return {
    httpsOnly: sec.httpsOnly !== false,
    blockingEnabled: sec.adBlock !== false || sec.trackerBlock !== false,
    trackerBlock: sec.trackerBlock !== false,
    blockThirdPartyCookies: sec.blockThirdPartyCookies !== false,
  };
}

const RETRY_BUILTIN_MS = 15 * 60 * 1000;

/**
 * Stateful filter shared by all sessions of one installSecurity() call.
 *
 * @param {object} opts
 * @param {object} opts.settings initial Settings snapshot (only security.* is read)
 * @param {string} opts.userData
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof loadBlocker} [opts.loadBlockerImpl] injectable for tests
 * @param {number} [opts.retryMs] how often to retry the full lists while on the built-in list
 */
export function createFilterController({ settings, userData, fetchImpl, loadBlockerImpl = loadBlocker, retryMs = RETRY_BUILTIN_MS }) {
  let flags = readFlags(settings);
  let blocker = null;
  let source = null;
  let loadedVariant = null; // 'tracking' | 'ads'
  let loadingVariant = null;
  let loadSeq = 0;
  let retryTimer = null;
  const counters = { blockedRequests: 0, httpsUpgrades: 0 };
  /**
   * Hosts the user (or the tab manager) allowed to load over plain http.
   * The tab manager calls allowHttpHost(host) when the https attempt of an upgraded navigation fails
   * with an SSL/connection error, so http-only sites stay reachable; from then on requests to that host
   * are no longer upgraded. The list lives for the app session only.
   */
  const allowedHttp = new Set();

  const variant = () => (flags.trackerBlock ? 'tracking' : 'ads');
  const hostKey = (h) => String(h || '').toLowerCase().replace(/\.$/, '');
  const state = {
    get httpsOnly() { return flags.httpsOnly; },
    isHttpAllowed: (h) => allowedHttp.has(hostKey(h)),
  };

  function startLoad(want) {
    loadingVariant = want;
    const seq = ++loadSeq;
    loadBlockerImpl({ userData, trackerBlock: want === 'tracking', fetchImpl, log })
      .then((res) => {
        if (seq !== loadSeq) return;
        blocker = res.blocker;
        source = res.source;
        loadedVariant = want;
        log.info(`Ad blocker ready (${res.source}, ${want})`);
        if (res.source === 'builtin') scheduleRetry();
      })
      .catch((e) => log.error('Ad blocker failed to initialise:', e))
      .finally(() => {
        if (seq === loadSeq) loadingVariant = null;
      });
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (flags.blockingEnabled && source === 'builtin' && !loadingVariant) startLoad(variant());
      else if (source === 'builtin') scheduleRetry();
    }, retryMs);
    retryTimer.unref?.();
  }

  /** Start (or switch) the blocking engine when blocking is enabled. */
  function ensureBlocker() {
    if (!flags.blockingEnabled) return;
    const want = variant();
    if (loadedVariant === want || loadingVariant === want) return;
    startLoad(want);
  }

  /**
   * Single onBeforeRequest handler.
   * @param {object} details Electron OnBeforeRequestDetails
   * @param {(response: object) => void} callback
   */
  function handleBeforeRequest(details, callback) {
    let done = false;
    const finish = (response) => {
      if (done) return;
      done = true;
      callback(response || {});
    };
    try {
      const decision = decideRequest(details, state);
      if (decision.redirectURL) counters.httpsUpgrades++;
      if (decision.redirectURL || decision.cancel) return finish(decision);

      if (flags.blockingEnabled && blocker && blockerApplies(details)) {
        blocker.onBeforeRequest(details, (res) => {
          if (res && (res.cancel || res.redirectURL)) counters.blockedRequests++;
          finish(res);
        });
        return undefined;
      }
      return finish({});
    } catch (e) {
      log.error('onBeforeRequest handler failed:', e);
      return finish({});
    }
  }

  /**
   * Single onHeadersReceived handler: drops third-party Set-Cookie headers, then lets the
   * blocker add its CSP rules.
   * @param {object} details Electron OnHeadersReceivedDetails
   * @param {(response: object) => void} callback
   */
  function handleHeadersReceived(details, callback) {
    let done = false;
    const finish = (response) => {
      if (done) return;
      done = true;
      callback(response || {});
    };
    try {
      let headers = details.responseHeaders;
      let changed = false;
      if (flags.blockThirdPartyCookies && headers && isThirdPartyResponse(details)) {
        const stripped = stripSetCookie(headers);
        if (stripped.removed > 0) {
          headers = stripped.headers;
          changed = true;
        }
      }
      // The blocker only injects CSP rules for documents, so the mainFrame exclusion of
      // blockerApplies() does not apply here; the scheme restriction still does.
      if (flags.blockingEnabled && blocker && hasBlockableScheme(details.url)) {
        blocker.onHeadersReceived({ ...details, responseHeaders: headers }, (res) => {
          if (res && res.responseHeaders) finish(res);
          else finish(changed ? { responseHeaders: headers } : {});
        });
        return;
      }
      finish(changed ? { responseHeaders: headers } : {});
    } catch (e) {
      log.error('onHeadersReceived handler failed:', e);
      finish({});
    }
  }

  ensureBlocker();

  return {
    /** Install the two listeners on an Electron session (replacing any previous ones). */
    attach(ses) {
      const filter = { urls: ['<all_urls>'] };
      ses.webRequest.onBeforeRequest(filter, handleBeforeRequest);
      ses.webRequest.onHeadersReceived(filter, handleHeadersReceived);
    },
    /** Apply a new Settings snapshot immediately (no restart needed). */
    applySettings(next) {
      flags = readFlags(next);
      ensureBlocker();
    },
    /** @returns {{ blockedRequests: number, httpsUpgrades: number, adBlockReady: boolean }} */
    stats() {
      return {
        blockedRequests: counters.blockedRequests,
        httpsUpgrades: counters.httpsUpgrades,
        adBlockReady: flags.blockingEnabled && blocker !== null,
      };
    },
    /** Allow plain http for a host (see `allowedHttp`). */
    allowHttpHost(host) {
      const key = hostKey(host);
      if (key) allowedHttp.add(key);
    },
    isHttpAllowed: (host) => allowedHttp.has(hostKey(host)),
    /** Where the active engine came from, for diagnostics: 'prebuilt' | 'stale-cache' | 'builtin' | null. */
    engineSource: () => source,
    dispose() {
      clearTimeout(retryTimer);
      loadSeq++;
    },
    handleBeforeRequest,
    handleHeadersReceived,
  };
}
