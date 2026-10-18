// Agent bridge: bucks:agent:* IPC. Dispatches chat requests to the configured provider
// (offline rules, a remote Bucks agent server, or a local Ollama model) and falls back to the
// offline rules, with an explanatory note, when the chosen provider is unreachable.

import { ipcMain } from 'electron';
import { createLogger } from '../log.js';
import { offlineProvider } from './providers/offline.js';
import { remoteProvider } from './providers/remote.js';
import { ollamaProvider } from './providers/ollama.js';

const log = createLogger('agent');

export const PROVIDER_NAMES = ['offline', 'remote', 'ollama'];
const AVAILABILITY_TTL_MS = 10_000;
const PAGE_TEXT_LIMIT = 6_000;
const MAX_PROMPT = 8_000;

const LABELS = { remote: 'Remote agent', ollama: 'Ollama', offline: 'Offline agent' };

/** Flat provider config from a Settings snapshot. */
function providerConfig(s) {
  return { ...(s?.agent || {}), searchEngine: s?.searchEngine || 'duckduckgo' };
}

/** The part of the config that decides which server is probed (cache key). */
function endpointOf(name, cfg) {
  if (name === 'remote') return cfg.remoteUrl || '';
  if (name === 'ollama') return `${cfg.ollamaUrl || ''}`;
  return '';
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Create the agent and register its IPC handlers.
 *
 * @param {object} deps
 * @param {{ get(): object }} deps.settings
 * @param {{ extractText(id: string): Promise<{ title: string, text: string, url: string }> }} deps.tabs
 * @param {object} [deps.kubo] accepted for interface parity with index.js (not needed by the current providers)
 * @param {Record<string, object>} [deps.providers] override providers (tests)
 * @param {() => number} [deps.now] clock (tests)
 * @returns {{ status(): Promise<object>, query(p: object): Promise<object>, feedback(p: object): Promise<object>, listModels(): Promise<string[]> }}
 */
export function createAgent({ settings, tabs, kubo: _kubo, providers, now = Date.now }) {
  const registry = { offline: offlineProvider, remote: remoteProvider, ollama: ollamaProvider, ...(providers || {}) };
  const availability = new Map(); // `${name}|${endpoint}` -> { at, value }

  const selected = () => {
    const s = settings.get();
    const name = PROVIDER_NAMES.includes(s?.agent?.provider) ? s.agent.provider : 'offline';
    return { name, provider: registry[name], cfg: providerConfig(s) };
  };

  async function isAvailable(name, provider, cfg) {
    if (name === 'offline') return true;
    const key = `${name}|${endpointOf(name, cfg)}`;
    const hit = availability.get(key);
    if (hit && now() - hit.at < AVAILABILITY_TTL_MS) return hit.value;
    let value = false;
    try {
      value = Boolean(await provider.isAvailable(cfg));
    } catch (e) {
      log.debug(`${name} availability probe failed: ${e.message}`);
    }
    availability.set(key, { at: now(), value });
    return value;
  }

  /** Run the offline rules and explain why the configured provider was not used. */
  async function offlineWithNote(name, cfg, input, reason) {
    const res = await registry.offline.query(input, cfg);
    const note = `${LABELS[name] || name} unavailable: ${reason}. Using built-in offline rules.`;
    const out = { ...res, status: 'offline_fallback', evaluation: `${note}\n\n${res.evaluation || ''}`.trim() };
    if (out.a2ui?.type === 'text' && out.a2ui.content) out.a2ui = { ...out.a2ui, content: out.evaluation };
    return out;
  }

  const api = {
    /** @returns {Promise<{ online: boolean, provider: string, model?: string, providers: string[] }>} */
    async status() {
      const { name, provider, cfg } = selected();
      const status = { online: await isAvailable(name, provider, cfg), provider: name, providers: [...PROVIDER_NAMES] };
      if (name === 'ollama') status.model = cfg.ollamaModel;
      return status;
    },

    /**
     * @param {{ prompt: string, currentUrl?: string, currentTitle?: string, tabId?: string | null }} payload
     * @returns {Promise<object>} AgentResult
     */
    async query(payload) {
      const prompt = str(payload?.prompt, MAX_PROMPT).trim();
      if (!prompt) throw new Error('Type a question or command for the agent');
      const input = {
        prompt,
        currentUrl: str(payload?.currentUrl, 2048),
        currentTitle: str(payload?.currentTitle, 512),
      };
      const { name, provider, cfg } = selected();
      if (name === 'offline') return registry.offline.query(input, cfg);

      if (!(await isAvailable(name, provider, cfg))) {
        return offlineWithNote(name, cfg, input, `cannot reach ${endpointOf(name, cfg) || 'the server'}`);
      }

      try {
        if (typeof provider.wantsPageText === 'function' && provider.wantsPageText(prompt) && payload?.tabId) {
          try {
            const page = await tabs.extractText(payload.tabId);
            if (page?.text) input.pageText = page.text.slice(0, PAGE_TEXT_LIMIT);
            if (page?.title && !input.currentTitle) input.currentTitle = page.title;
          } catch (e) {
            log.debug(`page text unavailable: ${e.message}`); // internal tab or page not ready: answer without it
          }
        }
        return await provider.query(input, cfg);
      } catch (e) {
        log.warn(`${name} query failed: ${e.message}`);
        availability.delete(`${name}|${endpointOf(name, cfg)}`);
        return offlineWithNote(name, cfg, input, e.message);
      }
    },

    /** Rate an answer. Only providers that learn from feedback (remote) accept it. */
    async feedback(payload) {
      const { name, provider, cfg } = selected();
      if (typeof provider.feedback !== 'function') {
        return { ok: false, message: `The ${name} provider does not collect feedback` };
      }
      const taskId = str(payload?.taskId, 256);
      if (!taskId) return { ok: false, message: 'This answer has no task id to attach feedback to' };
      const score = Number(payload?.score);
      if (!Number.isFinite(score)) throw new Error('Feedback score must be a number');
      return provider.feedback({ taskId, score, correction: str(payload?.correction, 4000) }, cfg);
    },

    /** Models the current provider can use (Ollama's installed models); [] for other providers. */
    async listModels() {
      const { provider, cfg } = selected();
      return typeof provider.listModels === 'function' ? provider.listModels(cfg) : [];
    },
  };

  ipcMain.removeHandler?.('bucks:agent:status');
  ipcMain.handle('bucks:agent:status', () => api.status());
  ipcMain.removeHandler?.('bucks:agent:query');
  ipcMain.handle('bucks:agent:query', (_e, payload) => api.query(payload));
  ipcMain.removeHandler?.('bucks:agent:feedback');
  ipcMain.handle('bucks:agent:feedback', (_e, payload) => api.feedback(payload));
  ipcMain.removeHandler?.('bucks:agent:list-models');
  ipcMain.handle('bucks:agent:list-models', () => api.listModels());

  return api;
}
