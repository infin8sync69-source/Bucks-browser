// End-to-end test of the agent acting in a tab, with the real Soul Engine from agent/: the user
// asks "/agent click the Buy now button", the engine reads the page and asks to click, Bucks shows
// the approval card, and the click happens in the page only after Allow. A second request is
// refused and the page is left alone. Then the engine writes a PDF report into Documents/Bucks.
// The model is a fake OpenAI-compatible server (the engine's "nim" backend), so nothing is
// downloaded.
//
//   npm run build:ui && BUCKS_SOUL_PYTHON=/path/to/venv/bin/python xvfb-run -a node --test test/e2e/agent-browser.test.mjs
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

async function waitFor(fn, { timeout = 15_000, interval = 200, label }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}: last=${JSON.stringify(last)}`);
}

/** A shop page whose "Buy now" button counts clicks in the title. */
function shop() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Shop</title><body><h1>Tea shop</h1><a href="/about">About us</a>
      <button id="buy" onclick="document.title = 'Bought ' + (++window.n || (window.n = 1))">Buy now</button></body>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

/**
 * The model: read the page, click the button it found, then answer. For a report request it calls
 * create_pdf. It sees every tool result, so the test can check what came back from the browser.
 */
async function fakeModel() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const messages = JSON.parse(body || '{}').messages || [];
      const user = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const toolResults = messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
      seen.push({ user, toolResults });
      const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: `c${seen.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      let message;
      if (/report/i.test(user)) {
        message = toolResults.length
          ? { role: 'assistant', content: 'Your report is ready.' }
          : call('create_pdf', { title: 'Tea report', content: '# Tea report\n\n- Green\n- Black' });
      } else if (toolResults.length === 0) {
        message = call('browser_read_page', {});
      } else if (toolResults.length === 1) {
        const ref = /\[(\d+)\] button: Buy now/.exec(toolResults[0])?.[1];
        message = ref ? call('browser_click', { ref: Number(ref) }) : { role: 'assistant', content: 'I could not find the button.' };
      } else {
        message = { role: 'assistant', content: /denied/i.test(toolResults[1]) ? 'Okay, I did not click it.' : 'Done: I clicked Buy now.' };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('agent acts in the tab only with approval, and writes a PDF report', { skip, timeout: 240_000 }, async () => {
  assert.ok(fs.existsSync(path.join(root, 'ui', 'build', 'index.html')), 'ui/build missing — run npm run build:ui first');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-e2e-act-'));
  const documents = path.join(userData, 'Documents');
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    ipfs: { autoStart: false },
    agent: { provider: 'soul', soul: { autoStart: true, backend: 'nim', python } },
  }));
  const site = await shop();
  const model = await fakeModel();

  const app = await electron.launch({
    cwd: root,
    args: ['.', '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, BUCKS_USER_DATA: userData, NIM_BASE_URL: model.url, NGC_API_KEY: 'e2e-key', NIM_MODEL: 'fake-model' },
  });
  await app.evaluate(({ app: a }, dir) => a.setPath('documents', dir), documents);
  const shopTitle = () => app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => w.getURL() === u)?.getTitle() ?? null, site.url);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.bucks?.agent?.approve === 'function', null, { timeout: 30_000 });
    await waitFor(async () => {
      const s = await page.evaluate(() => window.bucks.agent.soulStatus());
      if (s.state === 'error' || s.state === 'unavailable') throw new Error(`Soul Engine: ${s.state}: ${s.message}`);
      return s.state === 'ready';
    }, { timeout: 90_000, label: 'Soul Engine ready' });
    await waitFor(() => page.evaluate(() => window.bucks.agent.status()).then((s) => s.online), { label: 'agent online' });

    // Open the shop in a tab.
    const omnibox = page.getByLabel('Address or search');
    await omnibox.fill(site.url);
    await omnibox.press('Enter');
    await waitFor(async () => (await shopTitle()) === 'Shop', { label: 'shop loaded' });

    // Ask the agent to click; allow it.
    const bar = page.getByLabel('Ask the agent');
    await bar.fill('/agent click the Buy now button');
    await bar.press('Enter');
    const panel = page.getByRole('complementary', { name: 'Agent chat' });
    const card = panel.getByRole('alertdialog');
    await card.waitFor({ timeout: 60_000 });
    assert.match(await card.textContent(), /Click element \[\d+\]: button "Buy now"/);
    assert.equal(await shopTitle(), 'Shop', 'nothing is clicked before the user allows it');
    await page.screenshot({ path: path.join(ARTIFACTS, 'agent-approval.png') });
    await card.getByRole('button', { name: 'Allow' }).click();
    await panel.getByText('Done: I clicked Buy now.').waitFor({ timeout: 60_000 });
    assert.equal(await shopTitle(), 'Bought 1');
    const firstRun = model.seen.filter((s) => /Buy now/.test(s.user)).at(-1);
    assert.match(firstRun.toolResults[0], /^URL: http:\/\/127\.0\.0\.1:\d+\/\nTitle: Shop\n.*\n.*\n\[0\] a: About us/);
    assert.match(firstRun.toolResults[1], /^Clicked \[\d+\]\./);

    // Ask again; refuse.
    const box = panel.getByRole('textbox', { name: 'Message' });
    await box.fill('/agent click the Buy now button');
    await box.press('Enter');
    await card.waitFor({ timeout: 60_000 });
    await card.getByRole('button', { name: 'Refuse' }).click();
    await panel.getByText('Okay, I did not click it.').waitFor({ timeout: 60_000 });
    assert.equal(await shopTitle(), 'Bought 1', 'a refused click never happens');

    // A report: the engine writes a PDF through Bucks, and the chat links to it.
    await box.fill('Write a report on tea');
    await box.press('Enter');
    await panel.getByText('Your report is ready.').waitFor({ timeout: 60_000 });
    await panel.getByRole('button', { name: /Tea report\.pdf/ }).waitFor();
    assert.equal(fs.readFileSync(path.join(documents, 'Bucks', 'Tea report.pdf')).subarray(0, 5).toString(), '%PDF-');
    await page.screenshot({ path: path.join(ARTIFACTS, 'agent-report.png') });
  } finally {
    await app.close();
    model.server.close();
    site.server.close();
  }
});
