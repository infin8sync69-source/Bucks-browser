// Agent bridge: bucks:agent:* IPC. Dispatches chat requests to the configured provider
// (offline rules, a remote Bucks agent server, a local Ollama model, or the Soul Engine sidecar)
// and falls back to the offline rules, with an explanatory note, when the chosen provider is
// unreachable. Also exposes the Soul Engine supervisor (status, start, stop, install).

import { ipcMain } from 'electron';
import { createLogger } from '../log.js';
import { offlineProvider } from './providers/offline.js';
import { remoteProvider } from './providers/remote.js';
import { ollamaProvider } from './providers/ollama.js';
import { soulProvider } from './providers/soul.js';

const log = createLogger('agent');

export const PROVIDER_NAMES = ['offline', 'remote', 'ollama', 'soul'];
const AVAILABILITY_TTL_MS = 10_000;
const PAGE_TEXT_LIMIT = 6_000;
const MAX_PROMPT = 8_000;

const LABELS = { remote: 'Remote agent', ollama: 'Ollama', soul: 'Soul Engine', offline: 'Offline agent' };

/** Flat provider config from a Settings snapshot, plus where the Soul Engine runs right now. */
function providerConfig(s, soul) {
  return { ...(s?.agent || {}), searchEngine: s?.searchEngine || 'duckduckgo', soul: soul?.connection?.() || null };
}

/** The part of the config that decides which server is probed (cache key). */
function endpointOf(name, cfg) {
  if (name === 'remote') return cfg.remoteUrl || '';
  if (name === 'ollama') return `${cfg.ollamaUrl || ''}`;
  if (name === 'soul') return cfg.soul?.url || '';
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
 * @param {{ status(): object, start(): Promise<object>, stop(): Promise<void>, install(): Promise<object>, connection(): object|null }} [deps.soul]
 *        the Soul Engine supervisor (soul-engine.js); without it the soul provider is never available
 * @param {Record<string, object>} [deps.providers] override providers (tests)
 * @param {() => number} [deps.now] clock (tests)
 * @returns {{ status(): Promise<object>, query(p: object): Promise<object>, feedback(p: object): Promise<object>, listModels(): Promise<string[]> }}
 */
export function createAgent({ settings, tabs, kubo: _kubo, soul = null, providers, now = Date.now }) {
  const registry = { offline: offlineProvider, remote: remoteProvider, ollama: ollamaProvider, soul: soulProvider, ...(providers || {}) };
  const availability = new Map(); // `${name}|${endpoint}` -> { at, value }

  const selected = () => {
    const s = settings.get();
    const name = PROVIDER_NAMES.includes(s?.agent?.provider) ? s.agent.provider : 'offline';
    return { name, provider: registry[name], cfg: providerConfig(s, soul) };
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

  // A cached "unreachable" must not outlive the engine becoming ready (or the other way round).
  soul?.onStatus?.(() => {
    for (const key of availability.keys()) if (key.startsWith('soul|')) availability.delete(key);
  });

  /** Why the Soul Engine cannot answer, in the words of its status message. */
  function soulReason() {
    const st = soul.status();
    return st.state === 'idle' || st.state === 'stopped' ? 'it is not running (start it in Settings)' : st.message.replace(/\.$/, '');
  }

  const api = {
    /** @returns {Promise<{ online: boolean, provider: string, model?: string, detail?: string, providers: string[] }>} */
    async status() {
      const { name, provider, cfg } = selected();
      const status = { online: await isAvailable(name, provider, cfg), provider: name, providers: [...PROVIDER_NAMES] };
      if (name === 'ollama') status.model = cfg.ollamaModel;
      if (name === 'soul' && soul) {
        const st = soul.status();
        if (st.model) status.model = st.model;
        if (!status.online) status.detail = st.message;
      }
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
        const reason = name === 'soul' && soul ? soulReason() : `cannot reach ${endpointOf(name, cfg) || 'the server'}`;
        return offlineWithNote(name, cfg, input, reason);
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

  // Soul Engine supervisor. Status changes are also pushed as the bucks:agent:soul-status event.
  const soulMissing = () => { throw new Error('The Soul Engine is not available in this build'); };
  const soulControl = {
    'bucks:agent:soul-status': () => (soul ? soul.status() : soulMissing()),
    'bucks:agent:soul-start': () => (soul ? soul.start() : soulMissing()),
    'bucks:agent:soul-stop': async () => { if (!soul) soulMissing(); await soul.stop(); return soul.status(); },
    'bucks:agent:soul-install': () => (soul ? soul.install() : soulMissing()),
  };
  for (const [channel, fn] of Object.entries(soulControl)) {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, () => {
      const result = fn();
      availability.clear(); // the engine's reachability is about to change
      return result;
    });
  }

  return api;
}
