import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRemoteProvider } from '../../../src/main/agent/providers/remote.js';
import { createOllamaProvider, buildMessages, wantsPageText, SYSTEM_PROMPT } from '../../../src/main/agent/providers/ollama.js';

let server;
let base;
const seen = [];
let mode = 'ok';

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/v1/swarm/task') {
        if (mode === 'ping404') return json(404, { error: 'nope' });
        if (mode === 'down') return json(503, { error: 'busy' });
        if (mode === 'error-status') return json(200, { status: 'error', evaluation: 'swarm exploded' });
        if (mode === 'badjson') { res.writeHead(200); return res.end('<html>'); }
        return json(200, {
          status: 'ok',
          evaluation: 'Here you go.\n```json\n{"type":"navigate","url":"https://example.com"}\n```',
          cid: 'bafyresult', task_id: 't-1',
        });
      }
      if (req.url === '/health') return json(mode === 'ping404' ? 200 : 500, { ok: true });
      if (req.url === '/api/v1/swarm/feedback') return json(200, { ok: true });
      if (req.url === '/api/tags') return json(200, { models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5:7b' }] });
      if (req.url === '/api/chat') {
        if (mode === 'no-model') return json(404, { error: "model 'x' not found" });
        if (mode === 'empty') return json(200, { message: { content: '  ' } });
        return json(200, { message: { role: 'assistant', content: 'Opening it.\n```json\n{"type":"action","action":"open_wallet"}\n```' } });
      }
      return json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const remote = createRemoteProvider();
const ollama = createOllamaProvider();

test('remote.query posts the task and extracts a2ui', async () => {
  mode = 'ok'; seen.length = 0;
  const r = await remote.query({ prompt: 'open example', currentUrl: 'https://a.b', currentTitle: 'A' }, { remoteUrl: `${base}/` });
  assert.deepEqual(seen[0].body, { prompt: 'open example', current_url: 'https://a.b', current_title: 'A', history: [] });
  assert.equal(r.status, 'ok');
  assert.equal(r.cid, 'bafyresult');
  assert.equal(r.task_id, 't-1');
  assert.deepEqual(r.a2ui, { type: 'navigate', url: 'https://example.com' });
  assert.match(r.evaluation, /Here you go/);
});

test('remote errors are descriptive', async () => {
  mode = 'down';
  await assert.rejects(remote.query({ prompt: 'x' }, { remoteUrl: base }), /Agent server responded 503: .*busy/);
  mode = 'error-status';
  await assert.rejects(remote.query({ prompt: 'x' }, { remoteUrl: base }), /swarm exploded/);
  mode = 'badjson';
  await assert.rejects(remote.query({ prompt: 'x' }, { remoteUrl: base }), /invalid JSON/);
  await assert.rejects(remote.query({ prompt: 'x' }, { remoteUrl: 'http://127.0.0.1:1' }), /Cannot reach agent server at http:\/\/127\.0\.0\.1:1/);
  await assert.rejects(remote.query({ prompt: 'x' }, { remoteUrl: 'ftp://x' }), /http\(s\)/);
  await assert.rejects(remote.query({ prompt: 'x' }, { remoteUrl: 'nonsense' }), /Invalid agent server URL/);
});

test('remote.isAvailable: ping, /health on 404, false when down', async () => {
  mode = 'ok'; seen.length = 0;
  assert.equal(await remote.isAvailable({ remoteUrl: base }), true);
  assert.equal(seen[0].body.prompt, '__ping__');
  mode = 'ping404';
  assert.equal(await remote.isAvailable({ remoteUrl: base }), true);
  assert.equal(seen.at(-1).url, '/health');
  mode = 'down';
  assert.equal(await remote.isAvailable({ remoteUrl: base }), false);
  assert.equal(await remote.isAvailable({ remoteUrl: 'http://127.0.0.1:1' }), false);
  assert.equal(await remote.isAvailable({ remoteUrl: 'garbage' }), false);
});

test('remote.feedback posts snake_case body', async () => {
  mode = 'ok'; seen.length = 0;
  assert.deepEqual(await remote.feedback({ taskId: 't-9', score: 1, correction: 'meh' }, { remoteUrl: base }), { ok: true });
  assert.deepEqual(seen[0].body, { task_id: 't-9', score: 1, correction: 'meh' });
});

test('ollama.query sends system+user messages and splits the a2ui block', async () => {
  mode = 'ok'; seen.length = 0;
  const r = await ollama.query({ prompt: 'open my wallet', currentUrl: 'https://a.b', currentTitle: 'A' }, { ollamaUrl: base, ollamaModel: 'llama3.2' });
  const body = seen[0].body;
  assert.equal(body.model, 'llama3.2');
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, SYSTEM_PROMPT);
  assert.match(body.messages[1].content, /Current page: A - https:\/\/a\.b/);
  assert.match(body.messages[1].content, /User request: open my wallet/);
  assert.equal(r.status, 'ok');
  assert.equal(r.evaluation, 'Opening it.');
  assert.deepEqual(r.a2ui, { type: 'action', action: 'open_wallet' });
});

test('ollama errors', async () => {
  mode = 'no-model';
  await assert.rejects(ollama.query({ prompt: 'x' }, { ollamaUrl: base, ollamaModel: 'x' }), /not found.*ollama pull x/);
  mode = 'empty';
  await assert.rejects(ollama.query({ prompt: 'x' }, { ollamaUrl: base, ollamaModel: 'x' }), /empty answer/);
  await assert.rejects(ollama.query({ prompt: 'x' }, { ollamaUrl: base, ollamaModel: '' }), /No Ollama model/);
  await assert.rejects(ollama.query({ prompt: 'x' }, { ollamaUrl: 'http://127.0.0.1:1', ollamaModel: 'x' }), /Cannot reach Ollama/);
});

test('ollama.listModels / isAvailable', async () => {
  assert.deepEqual(await ollama.listModels({ ollamaUrl: base }), ['llama3.2:latest', 'qwen2.5:7b']);
  assert.equal(await ollama.isAvailable({ ollamaUrl: base }), true);
  assert.equal(await ollama.isAvailable({ ollamaUrl: 'http://127.0.0.1:1' }), false);
  await assert.rejects(ollama.listModels({ ollamaUrl: 'http://127.0.0.1:1' }), /Cannot reach Ollama/);
});

test('page text: only for page-related prompts, capped at 6000 chars', () => {
  for (const p of ['summarize this page', 'explain this', 'what does this article say', 'read the page', 'tl;dr']) assert.equal(wantsPageText(p), true, p);
  for (const p of ['open my wallet', 'search for cats', 'hello']) assert.equal(wantsPageText(p), false, p);
  const msgs = buildMessages({ prompt: 'p', pageText: 'x'.repeat(10_000) });
  assert.ok(msgs[1].content.length < 6_300);
});
