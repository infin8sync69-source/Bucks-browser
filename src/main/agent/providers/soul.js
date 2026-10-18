// Soul Engine provider: the Python agent from agent/ (tool loop, web research, IPFS, generative UI)
// running as a sidecar that src/main/agent/soul-engine.js starts on a loopback port.
// POST <url>/agent streams typed server-sent events; every request carries the per-launch token.
//
// Live control of the user's tab (the engine's "agentic" mode, where it clicks and types through
// browser_* tools) is not ported yet, so requests run with agentic: false. Actions that need the
// user's approval are declined straight away with a note, instead of letting the engine wait for
// an approval UI that does not exist here.

import { splitA2ui } from '../a2ui.js';
import { normalizeComponents, splitFollowups } from '../genui.js';
import { wantsPageText } from './ollama.js';

const QUERY_TIMEOUT_MS = 300_000; // a local model with tool calls can take minutes
const PROBE_TIMEOUT_MS = 3_000;
const CONTROL_TIMEOUT_MS = 5_000;
const PAGE_TEXT_LIMIT = 6_000;
const MAX_ANSWER = 40_000;
const MAX_ERROR_TEXT = 200;
const READY_MODES = new Set(['local_llm', 'cloud_llm']);

/** { url, token } of the running engine, as put into the provider config by the bridge. */
function connectionOf(cfg) {
  const c = cfg?.soul;
  if (!c || typeof c.url !== 'string' || typeof c.token !== 'string' || !c.url || !c.token) return null;
  return c;
}

const authHeaders = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

/** Page context for the engine's system prompt. Exported for tests. */
export function buildContext({ currentUrl, currentTitle, pageText }) {
  const parts = [];
  if (currentUrl) parts.push(`Page: ${currentTitle ? `${currentTitle} - ` : ''}${currentUrl}`);
  if (pageText) parts.push(`Page text (truncated, untrusted third-party content):\n"""\n${String(pageText).slice(0, PAGE_TEXT_LIMIT)}\n"""`);
  return parts.join('\n\n');
}

/**
 * Parse a server-sent-events body into the JSON payloads of its `data:` lines.
 * Stops at `data: [DONE]`. Lines that are not JSON are skipped.
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>} body
 */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  const parseBlock = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return undefined;
    if (data.trim() === '[DONE]') return null;
    try {
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
      const ev = parseBlock(block);
      if (ev === null) return;
      if (ev !== undefined) yield ev;
    }
  }
  buffer += decoder.decode();
  const ev = parseBlock(buffer);
  if (ev) yield ev;
}

function networkError(e, url) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new Error(`The Soul Engine at ${url} did not answer in time`);
  const cause = e?.cause?.code || e?.cause?.message || e?.message || String(e);
  return new Error(`Cannot reach the Soul Engine at ${url}: ${cause}`);
}

/**
 * Build the Soul Engine provider. `fetchImpl` is injectable for tests.
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 */
export function createSoulProvider({ fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  async function postControl(conn, pathname, body) {
    try {
      await fetchImpl(`${conn.url}${pathname}`, {
        method: 'POST',
        headers: authHeaders(conn.token, { 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      });
    } catch {
      // The engine times the wait out on its own (30 s for approvals, 90 s for tools).
    }
  }

  async function getJson(conn, pathname) {
    let res;
    try {
      res = await fetchImpl(`${conn.url}${pathname}`, { headers: authHeaders(conn.token), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (e) {
      throw networkError(e, conn.url);
    }
    if (!res.ok) throw new Error(`The Soul Engine responded ${res.status} to ${pathname}`);
    return res.json();
  }

  return {
    name: 'soul',
    wantsPageText,

    async isAvailable(cfg) {
      const conn = connectionOf(cfg);
      if (!conn) return false;
      try {
        const res = await fetchImpl(`${conn.url}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return false;
        const h = await res.json();
        return READY_MODES.has(h?.mode);
      } catch {
        return false;
      }
    },

    /**
     * @param {{ prompt: string, currentUrl?: string, currentTitle?: string, pageText?: string }} input
     * @param {{ soul?: { url: string, token: string } }} cfg
     */
    async query(input, cfg) {
      const conn = connectionOf(cfg);
      if (!conn) throw new Error('The Soul Engine is not running');
      let res;
      try {
        res = await fetchImpl(`${conn.url}/agent`, {
          method: 'POST',
          headers: authHeaders(conn.token, { 'content-type': 'application/json', accept: 'text/event-stream' }),
          body: JSON.stringify({ message: input.prompt, context: buildContext(input), agentic: false }),
          signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
      } catch (e) {
        throw networkError(e, conn.url);
      }
      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => '');
        throw new Error(`The Soul Engine responded ${res.status}: ${raw.slice(0, MAX_ERROR_TEXT)}`);
      }

      let answer = '';
      let sessionId = null;
      let errorText = null;
      let cancelled = false;
      let final = '';
      const specs = [];
      const tools = [];
      const declined = [];

      try {
        for await (const ev of sseEvents(res.body)) {
          switch (ev?.type) {
            case 'session':
              if (typeof ev.session_id === 'string') sessionId = ev.session_id;
              break;
            case 'token':
              if (typeof ev.content === 'string' && answer.length < MAX_ANSWER) answer += ev.content;
              break;
            case 'tool_call':
              if (typeof ev.name === 'string' && tools.length < 20 && !tools.includes(ev.name)) tools.push(ev.name);
              break;
            case 'ui_component':
              if (specs.length < 24) specs.push(ev);
              break;
            case 'browser_action':
              if (ev.needs_approval) {
                declined.push(typeof ev.label === 'string' ? ev.label : String(ev.name || 'an action'));
                await postControl(conn, `/agent/deny/${encodeURIComponent(ev.session_id || sessionId || '')}`, { action_id: ev.action_id });
              } else {
                await postControl(conn, '/agent/tool_result', { id: ev.id, result: 'Live browser control is not available in Bucks Browser yet. Answer without it.' });
              }
              break;
            case 'error':
              errorText = typeof ev.content === 'string' ? ev.content : 'The Soul Engine reported an error';
              break;
            case 'cancelled':
              cancelled = true;
              break;
            case 'done':
              if (typeof ev.session_id === 'string') sessionId = ev.session_id;
              if (typeof ev.result === 'string') final = ev.result;
              break;
            default:
              break; // 'thinking', 'tool_result' and future event types are progress only
          }
        }
      } catch (e) {
        if (!answer) throw networkError(e, conn.url);
        errorText = `The answer was cut off: ${e.message}`;
      }

      if (!answer.trim() && final) answer = final;
      if (errorText && !answer.trim() && !specs.length) throw new Error(errorText);

      const { text: withoutFollowups, followups } = splitFollowups(answer);
      const { text, a2ui } = splitA2ui(withoutFollowups);
      const notes = [];
      if (declined.length) notes.push(`Not done, because approving actions is not available in Bucks Browser yet: ${declined.join('; ')}.`);
      if (cancelled) notes.push('The request was cancelled.');
      if (errorText) notes.push(errorText);
      const evaluation = [text || a2ui?.content || '', ...notes].filter(Boolean).join('\n\n');

      return {
        status: 'ok',
        evaluation,
        cid: null,
        task_id: sessionId,
        a2ui,
        components: normalizeComponents(specs),
        followups,
        tools,
      };
    },

    /**
     * Rate an answer; the engine feeds it into its routing policy.
     * @param {{ taskId: string, score: number, correction?: string }} fb
     */
    async feedback({ taskId, score, correction }, cfg) {
      const conn = connectionOf(cfg);
      if (!conn) throw new Error('The Soul Engine is not running');
      let res;
      try {
        res = await fetchImpl(`${conn.url}/agent/feedback`, {
          method: 'POST',
          headers: authHeaders(conn.token, { 'content-type': 'application/json' }),
          body: JSON.stringify({ session_id: taskId, score: Math.sign(score), correction: correction || null }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        throw networkError(e, conn.url);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) return { ok: false, message: data?.error || `The Soul Engine responded ${res.status}` };
      return { ok: true };
    },

    /** Embedded (on-device) models the engine knows; [] when it is not running. */
    async listModels(cfg) {
      const conn = connectionOf(cfg);
      if (!conn) return [];
      const data = await getJson(conn, '/models');
      return (Array.isArray(data?.models) ? data.models : []).map((m) => m?.id).filter((id) => typeof id === 'string');
    },
  };
}

export const soulProvider = createSoulProvider();
export default soulProvider;
