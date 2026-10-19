// Remote provider: a Bucks agent server (the "Solar Parsec" swarm) over HTTP.
// POST <remoteUrl>/api/v1/swarm/task, feedback to /api/v1/swarm/feedback.

import { extractA2ui } from '../a2ui.js';

const TASK_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 3_000;
const MAX_ERROR_TEXT = 200;

/** Normalise and validate the configured server URL (http/https only, no trailing slash). */
export function baseUrl(cfg) {
  const raw = String(cfg?.remoteUrl || '').trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid agent server URL "${raw}" (set it in Settings)`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Agent server URL must be http(s), got "${u.protocol}"`);
  return u.href.replace(/\/+$/, '');
}

function describeNetworkError(e, url) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new Error(`Agent server at ${url} did not answer in time`);
  const cause = e?.cause?.code || e?.cause?.message || e?.message || String(e);
  return new Error(`Cannot reach agent server at ${url}: ${cause}`);
}

async function postJson(url, body, timeoutMs, fetchImpl) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Build the remote provider. `fetchImpl` is injectable for tests.
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 */
export function createRemoteProvider({ fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  return {
    name: 'remote',

    /**
     * Reachability probe. The legacy UI pinged the task endpoint with prompt "__ping__";
     * servers that answer 404/405 there are probed with GET /health instead.
     */
    async isAvailable(cfg) {
      let base;
      try { base = baseUrl(cfg); } catch { return false; }
      try {
        const res = await postJson(`${base}/api/v1/swarm/task`, { prompt: '__ping__', current_url: null, current_title: null }, PING_TIMEOUT_MS, fetchImpl);
        if (res.ok) return true;
        if (res.status === 404 || res.status === 405) {
          const health = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
          return health.ok;
        }
        return false;
      } catch {
        return false;
      }
    },

    /**
     * @param {{ prompt: string, currentUrl?: string, currentTitle?: string, history?: object[], attachments?: string }} input
     * @param {{ remoteUrl: string }} cfg
     * @returns {Promise<{ status: string, evaluation: string, cid: string|null, task_id: string|null, a2ui: object|null }>}
     */
    async query({ prompt, currentUrl, currentTitle, history, attachments }, cfg) {
      const base = baseUrl(cfg);
      let res;
      try {
        res = await postJson(`${base}/api/v1/swarm/task`, {
          prompt: attachments ? `${prompt}\n\n${attachments}` : prompt,
          current_url: currentUrl || null,
          current_title: currentTitle || null,
          history: Array.isArray(history) ? history : [],
        }, TASK_TIMEOUT_MS, fetchImpl);
      } catch (e) {
        throw describeNetworkError(e, base);
      }
      const raw = await res.text();
      if (!res.ok) throw new Error(`Agent server responded ${res.status}: ${raw.slice(0, MAX_ERROR_TEXT)}`);
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Agent server returned invalid JSON: ${raw.slice(0, MAX_ERROR_TEXT)}`);
      }
      const evaluation = typeof data.evaluation === 'string' ? data.evaluation : '';
      if (String(data.status).toLowerCase() === 'error') throw new Error(evaluation || 'Agent server reported an error');
      return {
        status: 'ok',
        evaluation,
        cid: data.cid ?? null,
        task_id: data.task_id ?? null,
        a2ui: extractA2ui(evaluation),
      };
    },

    /**
     * Rate a previous answer.
     * @param {{ taskId: string, score: number, correction?: string }} fb
     * @param {{ remoteUrl: string }} cfg
     */
    async feedback({ taskId, score, correction }, cfg) {
      const base = baseUrl(cfg);
      let res;
      try {
        res = await postJson(`${base}/api/v1/swarm/feedback`, { task_id: taskId, score, correction: correction || '' }, 15_000, fetchImpl);
      } catch (e) {
        throw describeNetworkError(e, base);
      }
      if (!res.ok) throw new Error(`Agent server responded ${res.status}: ${(await res.text()).slice(0, MAX_ERROR_TEXT)}`);
      return { ok: true };
    },
  };
}

export const remoteProvider = createRemoteProvider();
export default remoteProvider;
