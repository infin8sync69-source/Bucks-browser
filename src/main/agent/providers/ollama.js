// Ollama provider: a local LLM served by `ollama serve` (default http://127.0.0.1:11434).

import { splitA2ui } from '../a2ui.js';

const CHAT_TIMEOUT_MS = 120_000; // the first request may have to load the model into memory
const PROBE_TIMEOUT_MS = 3_000;
const PAGE_TEXT_LIMIT = 6_000;

export const SYSTEM_PROMPT = [
  'You are Bucks, the assistant built into the Bucks Browser, a decentralised IPFS-native web browser.',
  'Answer the user concisely and helpfully in plain text.',
  'When the user wants the browser to DO something, finish your answer with exactly one JSON object',
  'inside a fenced ```json block, and nothing after it. The JSON must match this schema:',
  '{ "type": "navigate" | "open_tab" | "search" | "action" | "text",',
  '  "url": string (http, https, ipfs or ipns URL; required for navigate and open_tab),',
  '  "action": "open_wallet" | "open_ipfs" | "open_settings" | "open_downloads" (required for action),',
  '  "content": string (the search query for search, or a short status message) }',
  'Use "navigate" to load a site in the current tab, "open_tab" for a new tab, "search" to search the web,',
  '"action" to open a built-in page. Do not emit a JSON block when no browser action is needed.',
  'Never invent URLs you are not sure of; prefer "search" when unsure.',
  'If page text is provided, use it to answer questions about the page.',
].join(' ');

const PAGE_QUESTION = /\b(?:this|current|the)\s+(?:page|site|website|article|tab|document|post)\b|\b(?:summari[sz]e|summary|tl;?dr|read|explain|what does|what is this|what's on)\b/i;

/** Does the prompt refer to the page the user is looking at? Then the page text is worth sending. */
export function wantsPageText(prompt) {
  return PAGE_QUESTION.test(String(prompt || ''));
}

function baseUrl(cfg) {
  const raw = String(cfg?.ollamaUrl || '').trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid Ollama URL "${raw}" (set it in Settings)`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Ollama URL must be http(s), got "${u.protocol}"`);
  return u.href.replace(/\/+$/, '');
}

function networkError(e, url) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new Error(`Ollama at ${url} did not answer in time`);
  const cause = e?.cause?.code || e?.cause?.message || e?.message || String(e);
  return new Error(`Cannot reach Ollama at ${url}: ${cause}`);
}

/** Build the chat messages for a request. Exported for tests. */
export function buildMessages({ prompt, currentUrl, currentTitle, pageText }) {
  const parts = [];
  if (currentUrl) parts.push(`Current page: ${currentTitle ? `${currentTitle} - ` : ''}${currentUrl}`);
  if (pageText) parts.push(`Page text (truncated):\n"""\n${String(pageText).slice(0, PAGE_TEXT_LIMIT)}\n"""`);
  parts.push(`User request: ${prompt}`);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/**
 * Build the Ollama provider. `fetchImpl` is injectable for tests.
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 */
export function createOllamaProvider({ fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  async function listModels(cfg) {
    const base = baseUrl(cfg);
    let res;
    try {
      res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (e) {
      throw networkError(e, base);
    }
    if (!res.ok) throw new Error(`Ollama responded ${res.status} listing models`);
    const data = await res.json();
    return (Array.isArray(data?.models) ? data.models : []).map((m) => m?.name || m?.model).filter((n) => typeof n === 'string');
  }

  return {
    name: 'ollama',
    wantsPageText,
    listModels,

    async isAvailable(cfg) {
      try {
        const base = baseUrl(cfg);
        const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return res.ok;
      } catch {
        return false;
      }
    },

    /**
     * @param {{ prompt: string, currentUrl?: string, currentTitle?: string, pageText?: string }} input
     * @param {{ ollamaUrl: string, ollamaModel: string }} cfg
     */
    async query(input, cfg) {
      const base = baseUrl(cfg);
      const model = String(cfg?.ollamaModel || '').trim();
      if (!model) throw new Error('No Ollama model selected (choose one in Settings)');
      let res;
      try {
        res = await fetchImpl(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, stream: false, messages: buildMessages(input) }),
          signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
        });
      } catch (e) {
        throw networkError(e, base);
      }
      const raw = await res.text();
      if (!res.ok) {
        let detail = raw.slice(0, 200);
        try { detail = JSON.parse(raw).error || detail; } catch { /* not JSON */ }
        const hint = res.status === 404 ? ` (try: ollama pull ${model})` : '';
        throw new Error(`Ollama responded ${res.status}: ${detail}${hint}`);
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error('Ollama returned invalid JSON');
      }
      const answer = data?.message?.content;
      if (typeof answer !== 'string' || !answer.trim()) throw new Error('Ollama returned an empty answer');
      const { text, a2ui } = splitA2ui(answer);
      return {
        status: 'ok',
        evaluation: text || a2ui?.content || '',
        cid: null,
        task_id: null,
        a2ui,
      };
    },
  };
}

export const ollamaProvider = createOllamaProvider();
export default ollamaProvider;
