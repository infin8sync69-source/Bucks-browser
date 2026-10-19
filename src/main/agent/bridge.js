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
import { validateAttachments, attachmentText } from './attachments.js';

const log = createLogger('agent');

export const PROVIDER_NAMES = ['offline', 'remote', 'ollama', 'soul'];
const AVAILABILITY_TTL_MS = 10_000;
const PAGE_TEXT_LIMIT = 6_000;
const MAX_PROMPT = 8_000;

const LABELS = { remote: 'Remote agent', ollama: 'Ollama', soul: 'Soul Engine', offline: 'Offline agent' };
const MAX_HISTORY = 12;
const HISTORY_TEXT = 2000;
const APPROVAL_TIMEOUT_MS = 25_000; // the engine gives up (and denies) after 30 s

/** Earlier turns of the conversation, as { role: 'user'|'assistant', content }. Exported for tests. */
export function cleanHistory(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, HISTORY_TEXT) }));
}

/**
 * Pending approvals for actions the agent wants to take. request() asks the chrome and resolves
 * with the user's answer, or false after the timeout. Exported for tests.
 * @param {{ send: (event: object) => void, timeoutMs?: number, now?: () => number }} deps
 */
export function createApprovals({ send, timeoutMs = APPROVAL_TIMEOUT_MS, now = Date.now }) {
  const pending = new Map(); // requestId -> { queryId, finish }
  let counter = 0;
  return {
    request(queryId, { name, label }) {
      const requestId = `ap-${now().toString(36)}-${(counter += 1)}`;
      return new Promise((resolve) => {
        const finish = (approved) => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          clearTimeout(timer);
          send({ queryId, type: 'approval-done', requestId, approved });
          resolve(approved);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        pending.set(requestId, { queryId, finish });
        send({ queryId, type: 'approval', requestId, name, label, expiresAt: now() + timeoutMs });
      });
    },
    /** @returns {boolean} false when the request is unknown or already answered */
    decide(requestId, approved) {
      const p = pending.get(requestId);
      if (!p) return false;
      p.finish(approved === true);
      return true;
    },
    /** Deny everything a query is still waiting for (it was stopped). */
    denyAll(queryId) {
      for (const p of [...pending.values()]) if (p.queryId === queryId) p.finish(false);
    },
  };
}

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
 * @param {{ isReady(): boolean, rpc: { cat(cid: string, o: { maxBytes: number }): Promise<Uint8Array> } | null }} [deps.kubo]
 *        reads CIDs attached to a question
 * @param {{ status(): object, start(): Promise<object>, stop(): Promise<void>, install(): Promise<object>, connection(): object|null }} [deps.soul]
 *        the Soul Engine supervisor (soul-engine.js); without it the soul provider is never available
 * @param {{ execute(name: string, args: object, ctx: { tabId: string|null, tabTools: boolean }): Promise<unknown> }} [deps.browserControl]
 *        runs the Soul Engine's browser and document tools (browser-control.js)
 * @param {() => import('electron').BrowserWindow | null} [deps.getMainWindow] receives bucks:agent:event
 * @param {Record<string, object>} [deps.providers] override providers (tests)
 * @param {() => number} [deps.now] clock (tests)
 * @returns {{ status(): Promise<object>, query(p: object): Promise<object>, feedback(p: object): Promise<object>, listModels(): Promise<string[]> }}
 */
export function createAgent({ settings, tabs, kubo = null, soul = null, providers, now = Date.now, browserControl = null, getMainWindow = () => null }) {
  const registry = { offline: offlineProvider, remote: remoteProvider, ollama: ollamaProvider, soul: soulProvider, ...(providers || {}) };
  const availability = new Map(); // `${name}|${endpoint}` -> { at, value }
  const running = new Map(); // queryId -> AbortController

  /** Progress, approval requests and their outcome go to the chrome as bucks:agent:event. */
  function sendEvent(event) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('bucks:agent:event', event);
  }
  const approvals = createApprovals({ send: sendEvent, now });

  const catCid = (cid, maxBytes) => {
    if (!kubo?.isReady?.() || !kubo.rpc) throw new Error('the IPFS node is not running');
    return kubo.rpc.cat(cid, { maxBytes });
  };

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

  async function runQuery(name, provider, cfg, input, tabId) {
    if (name === 'offline') return registry.offline.query(input, cfg);

    if (!(await isAvailable(name, provider, cfg))) {
      const reason = name === 'soul' && soul ? soulReason() : `cannot reach ${endpointOf(name, cfg) || 'the server'}`;
      return offlineWithNote(name, cfg, input, reason);
    }

    try {
      if (typeof provider.wantsPageText === 'function' && provider.wantsPageText(input.prompt) && tabId && !input.agentic) {
        try {
          const page = await tabs.extractText(tabId);
          if (page?.text) input.pageText = page.text.slice(0, PAGE_TEXT_LIMIT);
          if (page?.title && !input.currentTitle) input.currentTitle = page.title;
        } catch (e) {
          log.debug(`page text unavailable: ${e.message}`); // internal tab or page not ready: answer without it
        }
      }
      // Every provider stops at once; one that cannot abort its request finishes in the background, unheard.
      const stopped = new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
      stopped.catch(() => {});
      return await Promise.race([provider.query(input, cfg), stopped]);
    } catch (e) {
      if (input.signal.aborted) return { status: 'ok', evaluation: 'Stopped.', cid: null, task_id: null, a2ui: null, components: [], followups: [] };
      log.warn(`${name} query failed: ${e.message}`);
      availability.delete(`${name}|${endpointOf(name, cfg)}`);
      return offlineWithNote(name, cfg, input, e.message);
    }
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
     * @param {{ prompt: string, currentUrl?: string, currentTitle?: string, tabId?: string | null,
     *           queryId?: string, history?: object[], attachments?: object[], agentic?: boolean }} payload
     *   agentic: let the agent act in the tab `tabId` (Soul Engine only; changes need approval)
     * @returns {Promise<object>} AgentResult
     */
    async query(payload) {
      const prompt = str(payload?.prompt, MAX_PROMPT).trim();
      if (!prompt) throw new Error('Type a question or command for the agent');
      const queryId = str(payload?.queryId, 64) || `q-${now().toString(36)}`;
      const tabId = typeof payload?.tabId === 'string' ? payload.tabId : null;
      const files = validateAttachments(payload?.attachments);
      const attachments = files.length ? await attachmentText(files, { catCid }) : '';
      const { name, provider, cfg } = selected();
      const controller = new AbortController();
      running.set(queryId, controller);
      const input = {
        prompt,
        currentUrl: str(payload?.currentUrl, 2048),
        currentTitle: str(payload?.currentTitle, 512),
        history: cleanHistory(payload?.history),
        attachments,
        agentic: payload?.agentic === true && name === 'soul' && Boolean(tabId),
        signal: controller.signal,
        onEvent: (ev) => sendEvent({ queryId, ...ev }),
        requestApproval: (action) => approvals.request(queryId, action),
        runTool: (tool, args, ctx) => (browserControl
          ? browserControl.execute(tool, args, { ...ctx, tabId })
          : Promise.resolve('Browser tools are not available.')),
      };
      try {
        return await runQuery(name, provider, cfg, input, tabId);
      } finally {
        running.delete(queryId);
        approvals.denyAll(queryId);
      }
    },

    /** Stop a running query: the provider is told to cancel and pending approvals are denied. */
    cancel(queryId) {
      const c = running.get(str(queryId, 64));
      if (!c) return false;
      c.abort();
      approvals.denyAll(queryId);
      return true;
    },

    /** The user's answer to an approval request. */
    approve(requestId, approved) {
      return approvals.decide(str(requestId, 64), approved === true);
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
  ipcMain.removeHandler?.('bucks:agent:cancel');
  ipcMain.handle('bucks:agent:cancel', (_e, p) => api.cancel(p?.queryId));
  ipcMain.removeHandler?.('bucks:agent:approve');
  ipcMain.handle('bucks:agent:approve', (_e, p) => api.approve(p?.requestId, p?.approve));

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

  // Model picker and peer-update approvals (the new-tab page's agent card).
  const soulData = {
    'bucks:agent:soul-models': () => soul.models(),
    'bucks:agent:soul-select-model': (p) => soul.selectModel(str(p?.id, 120)),
    'bucks:agent:soul-download-progress': () => soul.downloadProgress(),
    'bucks:agent:soul-pending': () => soul.pendingUpdates(),
    'bucks:agent:soul-decide': (p) => soul.decideUpdate(str(p?.id, 128), p?.action),
  };
  for (const [channel, fn] of Object.entries(soulData)) {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, (_e, p) => (soul ? fn(p) : soulMissing()));
  }

  return api;
}
