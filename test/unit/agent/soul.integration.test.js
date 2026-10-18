// End-to-end check of the Soul Engine path against the real Python engine in agent/: the
// supervisor starts it, the provider streams an answer through its tool loop, and the token gate
// keeps everyone else out. The model is a fake OpenAI-compatible server (the engine's "nim"
// backend pointed at localhost), so no model download or API key is involved.
//
// Skipped unless BUCKS_SOUL_PYTHON names a Python 3.10+ that has agent/requirements-engine.txt
// installed, for example:
//   python3 -m venv /tmp/soul-venv && /tmp/soul-venv/bin/pip install -r agent/requirements-engine.txt
//   BUCKS_SOUL_PYTHON=/tmp/soul-venv/bin/python npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSoulEngine } from '../../../src/main/agent/soul-engine.js';
import { createSoulProvider } from '../../../src/main/agent/providers/soul.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, '..', '..', '..', 'agent');
const python = process.env.BUCKS_SOUL_PYTHON;
const skip = python && fs.existsSync(python) ? false : 'set BUCKS_SOUL_PYTHON to a Python with agent/requirements-engine.txt';
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** A model that first asks for a table, then answers. */
async function fakeModel() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, auth: req.headers.authorization || null, body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      const afterTool = (parsed.messages || []).some((m) => m.role === 'tool');
      const message = afterTool
        ? { role: 'assistant', content: 'Hello! Here are two fruits.\n<followup>Which fruit has more fibre?</followup>' }
        : {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'render_component', arguments: JSON.stringify({ component: 'table', title: 'Fruits', data: { columns: ['Fruit', 'Colour'], rows: [['Apple', 'Red'], ['Pear', 'Green']] } }) },
          }],
        };
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test('real Soul Engine: start, token gate, tool loop with a card, stop', { skip, timeout: 120_000 }, async (t) => {
  const model = await fakeModel();
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-soul-it-'));
  const snapshot = { agent: { provider: 'soul', ollamaUrl: 'http://127.0.0.1:9', ollamaModel: 'none', soul: { backend: 'nim', python, agentDir } } };
  const engine = createSoulEngine({
    settings: { get: () => structuredClone(snapshot) },
    userData,
    log: quietLog,
    env: { ...process.env, NIM_BASE_URL: model.url, NGC_API_KEY: 'test-key', NIM_MODEL: 'fake-model' },
  });
  t.after(async () => {
    await engine.stop();
    model.server.close();
    await fsp.rm(userData, { recursive: true, force: true });
  });

  const st = await engine.start();
  assert.equal(st.state, 'ready', st.message);
  const conn = engine.connection();

  const anonymous = await fetch(`${conn.url}/agent`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"message":"hi"}' });
  assert.equal(anonymous.status, 401, 'a web page cannot drive the agent');
  assert.equal((await fetch(`${conn.url}/health`)).status, 200);

  const soul = createSoulProvider();
  assert.equal(await soul.isAvailable({ soul: conn }), true);
  const r = await soul.query({ prompt: 'Greet me and list two fruits in a table.', currentUrl: 'https://fruit.example', currentTitle: 'Fruit' }, { soul: conn });
  assert.equal(r.status, 'ok');
  assert.match(r.evaluation, /^Hello! Here are two fruits\.$/);
  assert.deepEqual(r.followups, ['Which fruit has more fibre?']);
  assert.deepEqual(r.components, [{ component: 'table', title: 'Fruits', columns: ['Fruit', 'Colour'], rows: [['Apple', 'Red'], ['Pear', 'Green']] }]);
  assert.ok(r.task_id, 'session id for feedback');

  const first = model.requests.find((q) => q.url === '/v1/chat/completions');
  assert.equal(first.auth, 'Bearer test-key', 'the key from the environment reaches the provider');
  assert.match(JSON.stringify(first.body.messages), /fruit\.example/, 'page context is in the prompt');

  const fb = await soul.feedback({ taskId: r.task_id, score: 1 }, { soul: conn });
  assert.equal(fb.ok, true, fb.message);

  await engine.stop();
  assert.equal(engine.status().state, 'stopped');
  await assert.rejects(fetch(`${conn.url}/health`, { signal: AbortSignal.timeout(2000) }));
  assert.ok(fs.existsSync(path.join(userData, 'soul-engine', 'nexus_goals.db')), 'engine state lives in the profile');
});
