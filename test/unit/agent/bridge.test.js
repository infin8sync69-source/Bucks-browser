import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../main/helpers/electron-loader.mjs', import.meta.url);
const { ipcMain } = await import('electron');
const { createAgent } = await import('../../../src/main/agent/bridge.js');

let current;
let clock;
let probes;
let queries;
let providerMode;
let tabCalls;

const settings = { get: () => current };
const tabs = { extractText: async (id) => { tabCalls.push(id); if (id === 'bad') throw new Error('no such tab'); return { title: 'T', text: 'page body '.repeat(1000), url: 'https://p.example' }; } };
const providers = {
  remote: {
    name: 'remote',
    isAvailable: async () => { probes.push('remote'); return providerMode !== 'down'; },
    query: async (input) => { queries.push(input); if (providerMode === 'throw') throw new Error('boom'); return { status: 'ok', evaluation: 'remote says hi', cid: null, task_id: 'k', a2ui: null }; },
    feedback: async (fb) => ({ ok: true, got: fb }),
  },
  ollama: {
    name: 'ollama',
    isAvailable: async () => { probes.push('ollama'); return providerMode !== 'down'; },
    query: async (input) => { queries.push(input); return { status: 'ok', evaluation: 'llm says hi', a2ui: null }; },
    wantsPageText: (p) => /page/.test(p),
    listModels: async () => ['m1', 'm2'],
  },
};
const makeAgent = () => createAgent({ settings, tabs, kubo: null, providers, now: () => clock });
const invoke = (channel, payload) => ipcMain._handlers.get(channel)({}, payload);

beforeEach(() => {
  current = { searchEngine: 'duckduckgo', agent: { provider: 'offline', remoteUrl: 'http://r', ollamaUrl: 'http://o', ollamaModel: 'llama3.2' } };
  clock = 1_000_000; probes = []; queries = []; providerMode = 'up'; tabCalls = [];
});

test('registers the four channels', () => {
  makeAgent();
  for (const c of ['status', 'query', 'feedback', 'list-models']) assert.ok(ipcMain._handlers.has(`bucks:agent:${c}`), c);
});

test('status', async () => {
  makeAgent();
  assert.deepEqual(await invoke('bucks:agent:status'), { online: true, provider: 'offline', providers: ['offline', 'remote', 'ollama', 'soul'] });
  current.agent.provider = 'ollama';
  assert.deepEqual(await invoke('bucks:agent:status'), { online: true, provider: 'ollama', model: 'llama3.2', providers: ['offline', 'remote', 'ollama', 'soul'] });
  providerMode = 'down'; clock += 11_000;
  assert.equal((await invoke('bucks:agent:status')).online, false);
});

test('availability is cached for 10 s per endpoint', async () => {
  makeAgent();
  current.agent.provider = 'remote';
  await invoke('bucks:agent:status'); await invoke('bucks:agent:status');
  assert.equal(probes.length, 1);
  clock += 10_001;
  await invoke('bucks:agent:status');
  assert.equal(probes.length, 2);
  current.agent.remoteUrl = 'http://other';
  await invoke('bucks:agent:status');
  assert.equal(probes.length, 3, 'changing the url bypasses the cache');
});

test('offline provider answers directly', async () => {
  makeAgent();
  const r = await invoke('bucks:agent:query', { prompt: 'go to example.com' });
  assert.equal(r.status, 'offline_fallback');
  assert.equal(r.a2ui.url, 'https://example.com');
  assert.ok(!/unavailable/.test(r.evaluation));
});

test('configured provider is used when available', async () => {
  makeAgent();
  current.agent.provider = 'remote';
  const r = await invoke('bucks:agent:query', { prompt: 'hello', currentUrl: 'https://a.b', currentTitle: 'A', tabId: 't1' });
  assert.equal(r.status, 'ok');
  assert.equal(r.evaluation, 'remote says hi');
  const { onEvent, requestApproval, runTool, signal, ...plain } = queries[0];
  assert.deepEqual(plain, { prompt: 'hello', currentUrl: 'https://a.b', currentTitle: 'A', history: [], attachments: '', agentic: false });
  assert.equal(typeof onEvent, 'function');
  assert.equal(typeof requestApproval, 'function');
  assert.equal(typeof runTool, 'function');
  assert.equal(signal.aborted, false);
  assert.deepEqual(tabCalls, []);
});

test('falls back to offline rules with a note when unavailable', async () => {
  makeAgent();
  current.agent.provider = 'remote';
  providerMode = 'down';
  const r = await invoke('bucks:agent:query', { prompt: 'wallet' });
  assert.equal(r.status, 'offline_fallback');
  assert.equal(r.a2ui.action, 'open_wallet');
  assert.match(r.evaluation, /^Remote agent unavailable: cannot reach http:\/\/r/);
  assert.equal(queries.length, 0);
});

test('falls back when the provider throws, and re-probes next time', async () => {
  makeAgent();
  current.agent.provider = 'remote';
  providerMode = 'throw';
  const r = await invoke('bucks:agent:query', { prompt: 'tell me a joke' });
  assert.equal(r.status, 'offline_fallback');
  assert.match(r.evaluation, /^Remote agent unavailable: boom/);
  assert.match(r.a2ui.content, /boom/, 'text a2ui carries the note too');
  providerMode = 'up';
  assert.equal((await invoke('bucks:agent:query', { prompt: 'hi' })).status, 'ok');
});

test('page text is fetched for page questions only and capped', async () => {
  makeAgent();
  current.agent.provider = 'ollama';
  await invoke('bucks:agent:query', { prompt: 'summarize this page', tabId: 't1' });
  assert.equal(queries[0].pageText.length, 6000);
  assert.equal(queries[0].currentTitle, 'T');
  queries.length = 0;
  await invoke('bucks:agent:query', { prompt: 'what is a CID', tabId: 't1' });
  assert.equal(queries[0].pageText, undefined);
  queries.length = 0;
  const r = await invoke('bucks:agent:query', { prompt: 'summarize this page', tabId: 'bad' });
  assert.equal(r.status, 'ok', 'a missing tab does not fail the query');
  assert.equal(queries[0].pageText, undefined);
});

test('rejects empty prompts; unknown provider names behave as offline', async () => {
  makeAgent();
  await assert.rejects(invoke('bucks:agent:query', { prompt: '   ' }), /Type a question/);
  await assert.rejects(invoke('bucks:agent:query', undefined), /Type a question/);
  current.agent.provider = 'skynet';
  assert.equal((await invoke('bucks:agent:status')).provider, 'offline');
});

test('feedback and list-models', async () => {
  makeAgent();
  assert.equal((await invoke('bucks:agent:feedback', { taskId: 'x', score: 1 })).ok, false, 'offline cannot take feedback');
  current.agent.provider = 'remote';
  assert.deepEqual((await invoke('bucks:agent:feedback', { taskId: 'x', score: 1, correction: 'c' })).got, { taskId: 'x', score: 1, correction: 'c' });
  assert.equal((await invoke('bucks:agent:feedback', { score: 1 })).ok, false);
  await assert.rejects(invoke('bucks:agent:feedback', { taskId: 'x', score: 'high' }), /number/);
  assert.deepEqual(await invoke('bucks:agent:list-models'), []);
  current.agent.provider = 'ollama';
  assert.deepEqual(await invoke('bucks:agent:list-models'), ['m1', 'm2']);
});

/* ---------- Soul Engine ---------- */

function fakeSoul() {
  const listeners = new Set();
  const calls = [];
  const s = {
    st: { state: 'stopped', message: 'Soul Engine stopped.', model: null },
    conn: null,
    calls,
    status: () => ({ ...s.st }),
    connection: () => s.conn,
    onStatus: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    emit(patch) { Object.assign(s.st, patch); for (const cb of listeners) cb(s.status()); },
    start: async () => { calls.push('start'); return s.status(); },
    stop: async () => { calls.push('stop'); },
    install: async () => { calls.push('install'); return s.status(); },
    models: async () => { calls.push('models'); return { models: [], current: '', provider: 'edge', activeModel: '' }; },
    selectModel: async (id) => { calls.push(`select ${id}`); return { models: [], current: id, provider: 'edge', activeModel: id }; },
    downloadProgress: async () => ({ active: false, modelId: '', downloadedBytes: 0, totalBytes: 0 }),
    pendingUpdates: async () => { calls.push('pending'); return []; },
    decideUpdate: async (id, action) => { calls.push(`${action} ${id}`); return []; },
  };
  return s;
}

const soulProvider = {
  name: 'soul',
  isAvailable: async (cfg) => { probes.push(`soul ${cfg.soul?.url}`); return Boolean(cfg.soul) && providerMode !== 'down'; },
  query: async (input, cfg) => { queries.push({ input, cfg }); return { status: 'ok', evaluation: 'soul says hi', task_id: 's1', a2ui: null, components: [] }; },
};

test('soul: status carries the engine message while it cannot answer', async () => {
  const soul = fakeSoul();
  createAgent({ settings, tabs, soul, providers: { ...providers, soul: soulProvider }, now: () => clock });
  current.agent.provider = 'soul';
  assert.deepEqual(await invoke('bucks:agent:status'), { online: false, provider: 'soul', detail: 'Soul Engine stopped.', providers: ['offline', 'remote', 'ollama', 'soul'] });
  soul.conn = { url: 'http://127.0.0.1:5555', token: 't' };
  soul.emit({ state: 'ready', message: 'Soul Engine is ready.', model: 'qwen2.5:3b' });
  assert.deepEqual(await invoke('bucks:agent:status'), { online: true, provider: 'soul', model: 'qwen2.5:3b', providers: ['offline', 'remote', 'ollama', 'soul'] });
});

test('soul: a status change drops the cached availability', async () => {
  const soul = fakeSoul();
  createAgent({ settings, tabs, soul, providers: { ...providers, soul: soulProvider }, now: () => clock });
  current.agent.provider = 'soul';
  soul.conn = { url: 'http://127.0.0.1:5555', token: 't' };
  providerMode = 'down';
  assert.equal((await invoke('bucks:agent:status')).online, false);
  providerMode = 'up';
  assert.equal((await invoke('bucks:agent:status')).online, false, 'still cached');
  soul.emit({ state: 'ready', message: 'Soul Engine is ready.' });
  assert.equal((await invoke('bucks:agent:status')).online, true, 'cache cleared by the status event');
});

test('soul: queries get the connection; the fallback note quotes the engine', async () => {
  const soul = fakeSoul();
  createAgent({ settings, tabs, soul, providers: { ...providers, soul: soulProvider }, now: () => clock });
  current.agent.provider = 'soul';
  let r = await invoke('bucks:agent:query', { prompt: 'wallet' });
  assert.equal(r.status, 'offline_fallback');
  assert.match(r.evaluation, /^Soul Engine unavailable: it is not running \(start it in Settings\)/);
  soul.emit({ state: 'loading', message: 'Loading the on-device model (qwen2.5:3b). The first start downloads it.' });
  r = await invoke('bucks:agent:query', { prompt: 'wallet' });
  assert.match(r.evaluation, /^Soul Engine unavailable: Loading the on-device model/);
  soul.conn = { url: 'http://127.0.0.1:5555', token: 't' };
  soul.emit({ state: 'ready', message: 'Soul Engine is ready.' });
  r = await invoke('bucks:agent:query', { prompt: 'hello' });
  assert.equal(r.evaluation, 'soul says hi');
  assert.deepEqual(queries.at(-1).cfg.soul, { url: 'http://127.0.0.1:5555', token: 't' });
});

test('soul: control channels reach the supervisor, or fail clearly without one', async () => {
  const soul = fakeSoul();
  createAgent({ settings, tabs, soul, providers, now: () => clock });
  assert.equal((await invoke('bucks:agent:soul-status')).state, 'stopped');
  await invoke('bucks:agent:soul-start');
  await invoke('bucks:agent:soul-stop');
  await invoke('bucks:agent:soul-install');
  assert.deepEqual(soul.calls, ['start', 'stop', 'install']);
  assert.equal((await invoke('bucks:agent:soul-select-model', { id: 'qwen' })).current, 'qwen');
  await invoke('bucks:agent:soul-models');
  await invoke('bucks:agent:soul-pending');
  await invoke('bucks:agent:soul-decide', { id: 'u1', action: 'deny' });
  assert.deepEqual(soul.calls.slice(3), ['select qwen', 'models', 'pending', 'deny u1']);
  createAgent({ settings, tabs, providers, now: () => clock });
  assert.throws(() => invoke('bucks:agent:soul-status'), /not available/);
  assert.throws(() => invoke('bucks:agent:soul-models'), /not available/);
});

/* ---------- conversation, attachments, approvals, stop ---------- */

const { cleanHistory, createApprovals } = await import('../../../src/main/agent/bridge.js');

test('cleanHistory keeps the last 12 user/assistant turns, bounded', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const h = cleanHistory([...many, { role: 'system', content: 'evil' }, { role: 'user', content: '  ' }, { role: 'user', content: 'x'.repeat(5000) }]);
  assert.equal(h.length, 12);
  assert.equal(h.at(-1).content.length, 2000);
  assert.ok(h.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.deepEqual(cleanHistory('nope'), []);
});

test('history and attachments reach the provider; agentic only for the Soul Engine with a tab', async () => {
  const cats = [];
  createAgent({ settings, tabs, providers, now: () => clock, kubo: { isReady: () => true, rpc: { cat: async (cid) => { cats.push(cid); return new TextEncoder().encode('cid text'); } } } });
  current.agent.provider = 'remote';
  await invoke('bucks:agent:query', {
    prompt: 'summarise these', tabId: 't1', agentic: true,
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    attachments: [{ kind: 'file', name: 'a.txt', mime: 'text/plain', dataBase64: Buffer.from('file text').toString('base64') },
      { kind: 'cid', cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }],
  });
  const q = queries[0];
  assert.deepEqual(q.history, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  assert.match(q.attachments, /BEGIN ATTACHMENT: a\.txt -----\nfile text/);
  assert.match(q.attachments, /cid text/);
  assert.equal(cats.length, 1);
  assert.equal(q.agentic, false, 'only the Soul Engine can act in a tab');
  await assert.rejects(Promise.resolve().then(() => invoke('bucks:agent:query', { prompt: 'x', attachments: [{ kind: 'cid', cid: 'bad' }] })), /not a valid IPFS CID/);
});

test('approvals: asked in the chrome, answered once, denied on timeout or stop', async () => {
  const sent = [];
  let t = 0;
  const approvals = createApprovals({ send: (e) => sent.push(e), timeoutMs: 40, now: () => t });
  const a = approvals.request('q1', { name: 'browser_click', label: 'Click [3]' });
  assert.deepEqual(sent[0], { queryId: 'q1', type: 'approval', requestId: sent[0].requestId, name: 'browser_click', label: 'Click [3]', expiresAt: 40 });
  assert.equal(approvals.decide(sent[0].requestId, true), true);
  assert.equal(approvals.decide(sent[0].requestId, false), false, 'answered already');
  assert.equal(await a, true);
  assert.deepEqual(sent[1], { queryId: 'q1', type: 'approval-done', requestId: sent[0].requestId, approved: true });

  assert.equal(await approvals.request('q1', { name: 'browser_type', label: 'Type' }), false, 'no answer: denied');
  const c = approvals.request('q2', { name: 'browser_navigate', label: 'Open' });
  const d = approvals.request('q3', { name: 'browser_navigate', label: 'Open' });
  const q3Request = sent.find((e) => e.queryId === 'q3' && e.type === 'approval').requestId;
  approvals.denyAll('q2');
  assert.equal(await c, false);
  approvals.decide(q3Request, true);
  assert.equal(await d, true, 'other queries are not affected');
});

test('stop: the running query is aborted and its approvals denied, through IPC', async () => {
  let release;
  const slow = {
    name: 'remote',
    isAvailable: async () => true,
    query: (input) => new Promise((resolve, reject) => {
      queries.push(input);
      input.requestApproval({ name: 'browser_click', label: 'Click' }).then((ok) => { release = ok; });
      input.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  };
  createAgent({ settings, tabs, providers: { ...providers, remote: slow }, now: () => clock });
  current.agent.provider = 'remote';
  const p = invoke('bucks:agent:query', { prompt: 'long task', queryId: 'q-stop' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await invoke('bucks:agent:cancel', { queryId: 'q-stop' }), true);
  const r = await p;
  assert.equal(r.evaluation, 'Stopped.');
  assert.equal(release, false);
  assert.equal(await invoke('bucks:agent:cancel', { queryId: 'q-stop' }), false, 'finished queries cannot be stopped');
  assert.equal(await invoke('bucks:agent:approve', { requestId: 'nope', approve: true }), false);
});

test('site tools go to the site executor with an approval that carries the trusted card', async () => {
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, e) => sent.push([ch, e]) } };
  const ran = [];
  const siteTools = {
    execute: async (name, args, ctx) => {
      ran.push(name);
      const ok = await ctx.requestApproval({ name: 'site_publish', label: 'Publish the folder "client"…', site: { folder: 'client', files: 3 } }, { timeoutMs: 50 });
      return ok ? 'published' : 'not approved';
    },
  };
  const browserControl = { execute: async (name) => { ran.push(`browser:${name}`); return 'ok'; } };
  let result;
  const remote = {
    name: 'remote',
    isAvailable: async () => true,
    query: async (input) => {
      result = [await input.runTool('site_publish', { token: 't' }, {}), await input.runTool('browser_read_page', {}, { tabTools: false })];
      return { status: 'ok', evaluation: 'done', a2ui: null };
    },
  };
  createAgent({ settings, tabs, providers: { remote }, now: () => clock, siteTools, browserControl, getMainWindow: () => win });
  current.agent.provider = 'remote';
  await invoke('bucks:agent:query', { prompt: 'publish my site', queryId: 'q-site' });
  assert.deepEqual(ran, ['site_publish', 'browser:browser_read_page']);
  const approval = sent.map((s) => s[1]).find((e) => e.type === 'approval');
  assert.deepEqual(approval.site, { folder: 'client', files: 3 });
  assert.equal(approval.expiresAt - clock, 50, 'the site card gets its own timeout');
  assert.deepEqual(result, ['not approved', 'ok']);

  createAgent({ settings, tabs, providers: { remote }, now: () => clock });
  await invoke('bucks:agent:query', { prompt: 'publish my site' });
  assert.equal(result[0], 'Hosting sites is not available.');
});
