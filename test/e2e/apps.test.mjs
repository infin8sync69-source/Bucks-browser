// End-to-end: an app installed from a folder, run in a real Bucks container (docs/APP-ENVIRONMENT.md):
//   - installed through window.bucks.apps (the folder dialog is answered by the test);
//   - bucks://apps lists it (design-system components), and Open starts its own window on
//     bucks-app://<id>/ with the app bridge, its own storage, and no network it was not granted
//     (the web and the node's gateway are both blocked);
//   - the agent's app_call reaches the tool the app registered, after its approval;
//   - revoking a permission reloads the app without it; uninstalling from the UI removes it.
//
//   npm run build:ui && xvfb-run -a node --test test/e2e/apps.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE_TIMEOUT = Number(process.env.BUCKS_E2E_TIMEOUT_MS || 120_000);
const ARTIFACTS = process.env.BUCKS_E2E_ARTIFACTS || path.join(os.tmpdir(), 'bucks-e2e');

async function waitFor(fn, { timeout = 30_000, interval = 250, label }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}: last=${JSON.stringify(last)}`);
}

/** A small app: reports what it can reach in its title, counts its opens, offers one agent tool. */
function writeApp(dir, gatewayUrl) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>loading</title></head><body><div id="app">Notes</div><script type="module" src="/app.js"></script></body></html>');
  fs.writeFileSync(path.join(dir, 'app.js'), `
    const out = { bridge: typeof window.bucks?.app?.info === 'function' };
    const n = Number(localStorage.getItem('opens') || 0) + 1;
    localStorage.setItem('opens', String(n));
    out.opens = n;
    try { await fetch('https://example.com/', { mode: 'no-cors' }); out.web = 'reached'; } catch { out.web = 'blocked'; }
    try { await fetch(${JSON.stringify(`${gatewayUrl}/ipfs/bafkqaaa`)}, { mode: 'no-cors' }); out.node = 'reached'; } catch { out.node = 'blocked'; }
    if (out.bridge) {
      out.info = await window.bucks.app.info();
      window.bucks.app.agent.handle('count_opens', async (input) => ({ opens: n, echo: input?.note ?? null }));
    }
    document.title = 'ready ' + JSON.stringify(out);
  `);
  fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#888"/></svg>'); // tokens-ignore: test fixture
  fs.writeFileSync(path.join(dir, 'bucks-site.json'), JSON.stringify({
    app: {
      name: 'E2E Notes', version: '1.0.0', description: 'Counts how often it was opened.', icon: 'icon.svg',
      permissions: ['notifications'],
      agent: { tools: [{ name: 'count_opens', description: 'How many times the app was opened', input_schema: { type: 'object', properties: { note: { type: 'string' } } } }] },
    },
  }));
}

const readyState = async (appPage) => {
  const title = await appPage.title();
  return title.startsWith('ready ') ? JSON.parse(title.slice(6)) : null;
};

test('apps: install from a folder, run in a container, agent tool, revoke, uninstall', { timeout: NODE_TIMEOUT + 180_000 }, async () => {
  assert.ok(fs.existsSync(path.join(root, 'ui', 'build', 'index.html')), 'ui/build missing — run npm run build:ui first');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-e2e-apps-'));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-e2e-app-'));
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const app = await electron.launch({
    cwd: root,
    args: ['.', '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, BUCKS_USER_DATA: userData, BUCKS_KUBO_OFFLINE: '1', BUCKS_TEST_HOOKS: '1' },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setBounds({ x: 0, y: 0, width: 1280, height: 860 }); });
    await page.waitForFunction(() => typeof window.bucks?.apps?.inspect === 'function', null, { timeout: 30_000 });
    const status = await waitFor(async () => {
      const s = await page.evaluate(() => window.bucks.ipfs.status());
      if (s.state === 'error') throw new Error(`IPFS node failed: ${s.message}`);
      return s.state === 'ready' ? s : null;
    }, { timeout: NODE_TIMEOUT, label: 'IPFS node ready' });
    writeApp(appDir, status.gateway_url);

    // ── install from a folder (the dialog runs in main; the test answers it) ──
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, appDir);
    const chosen = await page.evaluate(() => window.bucks.apps.chooseFolder());
    const review = await page.evaluate((token) => window.bucks.apps.inspect({ folderToken: token }), chosen.token);
    assert.equal(review.name, 'E2E Notes');
    assert.deepEqual(review.permissions.map((p) => p.id), ['notifications', 'agent-tools']);
    const installed = await page.evaluate((token) => window.bucks.apps.install(token), review.token);
    assert.match(installed.id, /^a_[a-f0-9]{10}$/);

    // ── bucks://apps lists it ──
    const omnibox = page.getByLabel('Address or search');
    await omnibox.fill('bucks://apps');
    await omnibox.press('Enter');
    const card = page.getByRole('listitem', { name: 'E2E Notes' });
    await card.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(ARTIFACTS, 'apps-page.png') });

    // ── Open: its own window, its own origin, the bridge, no network it was not granted ──
    const opened = app.waitForEvent('window', { timeout: 20_000 });
    await card.getByRole('button', { name: 'Open' }).click();
    const appPage = await opened;
    assert.equal(new URL(appPage.url()).protocol, 'bucks-app:');
    assert.equal(new URL(appPage.url()).hostname, installed.id);
    const first = await waitFor(() => readyState(appPage), { label: 'the app reports its state' });
    assert.equal(first.bridge, true, 'window.bucks.app exists in the container');
    assert.equal(first.opens, 1);
    assert.equal(first.web, 'blocked', 'no network permission: the web is unreachable');
    assert.equal(first.node, 'blocked', 'the node\'s gateway is never reachable from an app');
    assert.equal(first.info.id, installed.id);
    assert.deepEqual(first.info.permissions, ['notifications', 'agent-tools'], 'everything it asked for (the default)');
    assert.deepEqual(first.info.tools, ['count_opens']);
    assert.equal(await appPage.evaluate(() => typeof window.bucks.tabs), 'undefined', 'the chrome\'s API is not there');
    await appPage.screenshot({ path: path.join(ARTIFACTS, 'apps-container.png') });

    // ── the agent's app_call reaches the app's tool, after the user allows it ──
    await page.evaluate(() => {}); // keep the chrome page alive
    const agentAnswer = await app.evaluate(async (_e, id) => {
      const asked = [];
      const text = await globalThis.__bucksTest.appTools.execute('app_call', { id, tool: 'count_opens', input: { note: 'hi' } }, { requestApproval: async (card) => { asked.push(card.name); return true; } });
      return { text, asked };
    }, installed.id);
    assert.deepEqual(agentAnswer.asked, ['app_call']);
    assert.match(agentAnswer.text, /untrusted/);
    assert.match(agentAnswer.text, /"opens":1,"echo":"hi"/);

    // ── storage is the app's own and survives a relaunch ──
    await appPage.close();
    const reopened = app.waitForEvent('window', { timeout: 20_000 });
    await card.getByRole('button', { name: 'Open' }).click();
    const appPage2 = await reopened;
    const second = await waitFor(() => readyState(appPage2), { label: 'the app reopened' });
    assert.equal(second.opens, 2, 'localStorage persisted in the app\'s own partition');
    const tabStorage = await page.evaluate(() => localStorage.getItem('opens'));
    assert.equal(tabStorage, null, 'the chrome does not see the app\'s storage');

    // ── revoking a permission reloads the app without it ──
    await page.evaluate((id) => window.bucks.apps.setPermission(id, 'notifications', false), installed.id);
    const third = await waitFor(async () => { const s = await readyState(appPage2); return s && s.opens === 3 ? s : null; }, { label: 'the app reloaded' });
    assert.deepEqual(third.info.permissions, ['agent-tools']);

    // ── uninstall from the UI: Details → Uninstall → confirm ──
    await card.getByRole('button', { name: 'Details' }).click();
    const dialog = page.getByRole('dialog', { name: 'E2E Notes' });
    await dialog.waitFor();
    await page.screenshot({ path: path.join(ARTIFACTS, 'apps-details.png') });
    // The dialog's buttons are slotted into it: Playwright scopes by DOM, not the flattened tree.
    await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await page.getByRole('button', { name: 'Uninstall E2E Notes' }).click();
    await waitFor(async () => (await page.getByRole('listitem', { name: 'E2E Notes' }).count()) === 0, { label: 'the card is gone' });
    await waitFor(() => appPage2.isClosed(), { label: 'the app window closed' });
    assert.deepEqual(await page.evaluate(() => window.bucks.apps.list()), []);
    await page.getByText('No apps yet').waitFor();
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
