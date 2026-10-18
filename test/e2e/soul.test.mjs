// End-to-end test of the Soul Engine in the real app: Bucks starts the Python engine from agent/,
// the user asks through the command dock, and the answer arrives in the chat panel with its card
// and follow-up suggestion. The model is a fake OpenAI-compatible server (the engine's "nim"
// backend pointed at localhost), so nothing is downloaded and no key is needed. IPFS is off: this
// test does not need Kubo.
//
//   npm run build:ui && BUCKS_SOUL_PYTHON=/path/to/venv/bin/python xvfb-run -a node --test test/e2e/soul.test.mjs
//
// Skipped unless BUCKS_SOUL_PYTHON names a Python with agent/requirements-engine.txt installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = process.env.BUCKS_E2E_ARTIFACTS || path.join(os.tmpdir(), 'bucks-e2e');
const python = process.env.BUCKS_SOUL_PYTHON;
const skip = python && fs.existsSync(python) ? false : 'set BUCKS_SOUL_PYTHON to a Python with agent/requirements-engine.txt';

async function waitFor(fn, { timeout, interval = 250, label }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}: last=${JSON.stringify(last)}`);
}

/** First call: render a table. After the tool result: answer with a follow-up. */
async function fakeModel() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const messages = JSON.parse(body || '{}').messages || [];
      const afterTool = messages.some((m) => m.role === 'tool');
      const message = afterTool
        ? { role: 'assistant', content: 'Kubo and Helia both speak IPFS. See [the IPFS docs](https://docs.ipfs.tech/).\n<followup>How do I pin a file?</followup>' }
        : {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'render_component', arguments: JSON.stringify({ component: 'table', title: 'IPFS implementations', data: { columns: ['Name', 'Language'], rows: [['Kubo', 'Go'], ['Helia', 'TypeScript']] } }) },
          }],
        };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test('Soul Engine: started by Bucks, answers in the chat panel with a card', { skip, timeout: 180_000 }, async () => {
  assert.ok(fs.existsSync(path.join(root, 'ui', 'build', 'index.html')), 'ui/build missing — run npm run build:ui first');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-e2e-soul-'));
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    ipfs: { autoStart: false },
    agent: { provider: 'soul', soul: { autoStart: true, backend: 'nim', python } },
  }));
  const model = await fakeModel();

  const app = await electron.launch({
    cwd: root,
    args: ['.', '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, BUCKS_USER_DATA: userData, NIM_BASE_URL: model.url, NGC_API_KEY: 'e2e-key', NIM_MODEL: 'fake-model' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.bucks?.agent?.soulStatus === 'function', null, { timeout: 30_000 });

    const st = await waitFor(async () => {
      const s = await page.evaluate(() => window.bucks.agent.soulStatus());
      if (s.state === 'error' || s.state === 'unavailable') throw new Error(`Soul Engine: ${s.state}: ${s.message}`);
      return s.state === 'ready' ? s : null;
    }, { timeout: 90_000, label: 'Soul Engine ready' });
    assert.match(st.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(st.python, python);
    assert.equal(st.agentDir, path.join(root, 'agent'));

    const status = await waitFor(() => page.evaluate(() => window.bucks.agent.status()).then((s) => (s.online ? s : null)), { timeout: 15_000, label: 'agent online' });
    assert.equal(status.provider, 'soul');

    // A web page cannot reach the engine: no token.
    const anonymous = await fetch(`${st.url}/agent`, { method: 'POST', body: '{"message":"hi"}' });
    assert.equal(anonymous.status, 401);

    // Ask through the command dock, as a user would.
    const dock = page.getByPlaceholder(/Command the swarm|Ask Bucks/);
    await dock.fill('Greet me and put two IPFS implementations in a table.');
    await dock.press('Enter');

    await page.getByText('Kubo and Helia both speak IPFS.').waitFor({ timeout: 60_000 });
    await page.getByText('IPFS implementations', { exact: true }).waitFor();
    assert.equal(await page.getByRole('cell', { name: 'TypeScript' }).count(), 1, 'the table card is rendered');
    assert.equal(await page.locator('a[data-href="https://docs.ipfs.tech/"]').count(), 1, 'markdown link rendered as a link');
    await page.getByRole('button', { name: 'How do I pin a file?' }).waitFor();
    await page.screenshot({ path: path.join(ARTIFACTS, 'soul-chat.png') });

    // Settings shows the engine as ready.
    const shortcut = (action) => app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0].webContents.send('bucks:app:shortcut', { action: a }), action);
    await shortcut('toggle-agent'); // close the chat panel
    await shortcut('open-settings');
    const ready = page.getByText('Soul Engine is ready');
    await ready.waitFor({ timeout: 15_000 });
    await ready.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(ARTIFACTS, 'soul-settings.png') });
  } finally {
    await app.close();
    model.server.close();
  }
  // Quitting stops the engine: nothing answers on its port any more.
  const st = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  assert.equal(st.agent.provider, 'soul');
  const logText = fs.readFileSync(path.join(userData, 'logs', 'soul-engine.log'), 'utf8');
  assert.match(logText, /Uvicorn running on http:\/\/127\.0\.0\.1:\d+/);
  const port = /127\.0\.0\.1:(\d+)/.exec(logText)[1];
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }));
});
