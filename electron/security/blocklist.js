'use strict';
// Ad / tracker blocking engine loader and the built-in fallback filter list.
// Ported from Bucks-browser (src/main/security/blocklist.js).
//
// Preferred path: Ghostery's prebuilt EasyList + EasyPrivacy engine, cached on disk and refreshed
// weekly. When the network is unreachable the engine falls back to a stale cache, and finally to
// the compact list below so blocking still works on a fresh offline install.

const fs = require('node:fs');
const path = require('node:path');

/** Domains blocked outright (any request type, any party). */
const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com',
  'adnxs.com', 'adsrvr.org', 'adform.net', 'rubiconproject.com', 'pubmatic.com', 'openx.net',
  'criteo.com', 'criteo.net', 'outbrain.com', 'taboola.com', 'amazon-adsystem.com', 'moatads.com',
  'advertising.com', 'adsafeprotected.com', 'casalemedia.com', 'contextweb.com', 'smartadserver.com',
  'yieldmo.com', 'sharethrough.com', 'teads.tv', '33across.com', 'bidswitch.net', 'serving-sys.com',
  'adtechus.com', 'zedo.com', 'revcontent.com', 'mgid.com', 'popads.net', 'propellerads.com',
  'exoclick.com', 'trafficjunky.net', 'juicyads.com', 'adcolony.com', 'applovin.com', 'unityads.unity3d.com',
  'ads-twitter.com', 'ads.linkedin.com', 'ads.tiktok.com',
];

/** Analytics / tracking domains blocked only when loaded from another site. */
const TRACKER_HOSTS = [
  'google-analytics.com', 'scorecardresearch.com', 'quantserve.com', 'quantcount.com', 'mathtag.com',
  'demdex.net', 'krxd.net', 'bluekai.com', 'exelator.com', 'rlcdn.com', 'agkn.com', 'hotjar.com',
  'fullstory.com', 'clarity.ms', 'bat.bing.com', 'analytics.tiktok.com', 'analytics.twitter.com',
  'px.ads.linkedin.com', 'mixpanel.com', 'segment.io', 'branch.io', 'adjust.com', 'appsflyer.com',
  'chartbeat.net', 'newrelic.com', 'omtrdc.net', 'sitescout.com',
];

/**
 * Compact EasyList-style (Adblock Plus syntax) list: the host lists above plus the URL patterns
 * of the legacy app (ads.*, ad.*, tracking.* hosts and the Facebook pixel).
 */
const BUILTIN_FILTER_LIST = [
  '! Bucks Browser built-in fallback list (used until the full EasyList engine is available)',
  ...AD_HOSTS.map((h) => `||${h}^`),
  ...TRACKER_HOSTS.map((h) => `||${h}^$third-party`),
  '||ads.$third-party',
  '||ad.$third-party',
  '||tracking.$third-party',
  '||facebook.net/*/fbevents.js',
  '||connect.facebook.net/signals/',
].join('\n');

/** How long a cached engine is used before the lists are fetched again. */
const ENGINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Atomic cache writer: write to a temp file, then rename over the target.
 * @param {string} file
 * @param {Uint8Array} data
 */
async function writeAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

/**
 * Build the blocking engine.
 *
 * Order of attempts: (1) fresh on-disk cache or the prebuilt lists fetched within `timeoutMs`
 * (the result is cached), (2) a stale cache of any age, (3) the built-in list.
 *
 * @param {object} opts
 * @param {string} opts.userData directory for the engine cache
 * @param {boolean} [opts.trackerBlock=true] include EasyPrivacy-style tracker lists
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs=20000]
 * @param {number} [opts.maxAgeMs]
 * @param {{ info?: Function, warn?: Function }} [opts.log]
 * @returns {Promise<{ blocker: ElectronBlocker, source: 'prebuilt' | 'stale-cache' | 'builtin' }>}
 */
async function loadBlocker({
  userData,
  trackerBlock = true,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  maxAgeMs = ENGINE_MAX_AGE_MS,
  log = {},
}) {
  // The two engine flavours have different contents, so they are cached separately.
  // Loaded lazily so the pure request-filter logic (and its tests) never needs the package.
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const file = path.join(userData, trackerBlock ? 'adblock-engine.bin' : 'adblock-engine-ads.bin');

  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  const fetchWithSignal = (input, init) => fetchImpl(input, { ...(init || {}), signal: controller.signal });
  const caching = {
    path: file,
    read: async (p) => {
      const st = await fs.promises.stat(p);
      if (Date.now() - st.mtimeMs > maxAgeMs) throw new Error('cached engine is stale');
      return fs.promises.readFile(p);
    },
    write: (p, buf) => writeAtomic(p, buf),
  };

  try {
    const build = trackerBlock
      ? ElectronBlocker.fromPrebuiltAdsAndTracking(fetchWithSignal, caching)
      : ElectronBlocker.fromPrebuiltAdsOnly(fetchWithSignal, caching);
    build.catch(() => {}); // a late rejection after the timeout must not become unhandled
    const blocker = await Promise.race([build, timeout]);
    return { blocker, source: 'prebuilt' };
  } catch (e) {
    log.warn?.(`Prebuilt ad-block lists unavailable (${e.message}); trying cache`);
  } finally {
    clearTimeout(timer);
  }

  try {
    const blocker = ElectronBlocker.deserialize(await fs.promises.readFile(file));
    return { blocker, source: 'stale-cache' };
  } catch {
    // no usable cache either
  }

  log.warn?.('Using the built-in ad-block list');
  return { blocker: ElectronBlocker.parse(BUILTIN_FILTER_LIST), source: 'builtin' };
}

module.exports = { loadBlocker, BUILTIN_FILTER_LIST, ENGINE_MAX_AGE_MS };
