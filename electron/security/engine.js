'use strict';
// Loads the Ghostery ad/tracker engine in the background and hands it to the request filter.
// Until it is ready the filter's pattern list blocks; a failed download falls back to a stale
// cache, then to the built-in list (see blocklist.js), and is retried while on the built-in list.

const { loadBlocker } = require('./blocklist');

const RETRY_BUILTIN_MS = 15 * 60 * 1000;

/**
 * @param {object} opts
 * @param {ReturnType<typeof import('./request-filter').createRequestFilter>} opts.filter
 * @param {string} opts.userData directory for the engine cache
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof loadBlocker} [opts.loadBlockerImpl] injectable for tests
 * @param {number} [opts.retryMs]
 * @returns {{ ensure(): void, dispose(): void }}
 */
function createEngineLoader({ filter, userData, fetchImpl, loadBlockerImpl = loadBlocker, retryMs = RETRY_BUILTIN_MS }) {
  let loading = false;
  let loaded = false;
  let timer = null;
  let disposed = false;

  function start() {
    if (loading || disposed) return;
    loading = true;
    loadBlockerImpl({ userData, trackerBlock: true, fetchImpl, log: console })
      .then((res) => {
        if (disposed) return;
        filter.setBlocker(res.blocker, res.source);
        loaded = true;
        console.log(`[Security] Ad blocker ready (${res.source})`);
        if (res.source === 'builtin') {
          loaded = false;
          clearTimeout(timer);
          timer = setTimeout(start, retryMs);
          timer.unref?.();
        }
      })
      .catch((e) => console.error('[Security] Ad blocker failed to initialise:', e))
      .finally(() => { loading = false; });
  }

  return {
    /** Start loading if it has not been (idempotent); call whenever ad blocking is switched on. */
    ensure() {
      if (!loaded) start();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

module.exports = { createEngineLoader };
