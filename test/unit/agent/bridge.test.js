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
  assert.deepEqual(await invoke('bucks:agent:status'), { online: true, provider: 'offline', providers: ['offline', 'remote', 'ollama'] });
  current.agent.provider = 'ollama';
  assert.deepEqual(await invoke('bucks:agent:status'), { online: true, provider: 'ollama', model: 'llama3.2', providers: ['offline', 'remote', 'ollama'] });
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
  assert.deepEqual(queries[0], { prompt: 'hello', currentUrl: 'https://a.b', currentTitle: 'A' });
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
