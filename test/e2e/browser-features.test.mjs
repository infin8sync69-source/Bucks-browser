// End-to-end checks of the everyday browser features ported from Bucks Core: find in page,
// private tabs (isolated and wiped), mute, zoom, save as PDF, the tab menu (duplicate, pin,
// rename), spaces, clearing cookies, and omnibox suggestions from history. A local HTTP server
// provides the pages; IPFS is switched off, so no Kubo binary is needed.
//
//   npm run build:ui && xvfb-run -a node --test test/e2e/browser-features.test.mjs

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

async function waitFor(fn, { timeout = 15_000, interval = 150, label }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}: last=${JSON.stringify(last)}`);
}

function site() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/cookie') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `seen=${url.searchParams.get('v') || '1'}; Path=/; Max-Age=3600` });
      res.end('<!doctype html><title>Cookie page</title><p>cookie set</p>');
      return;
    }
    if (url.pathname === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cookie: req.headers.cookie || '' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Fruit stand</title><body><h1>Fruit stand</h1>
      <p>apple banana apple cherry apple</p><p id="ls"></p>
      <script>localStorage.setItem('k', localStorage.getItem('k') || 'v-' + Math.random()); document.getElementById('ls').textContent = localStorage.getItem('k');</script></body>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test('find, private tabs, mute, zoom, PDF, tab menu, spaces, clearing cookies, suggestions', { timeout: 180_000 }, async () => {
  assert.ok(fs.existsSync(path.join(root, 'ui', 'build', 'index.html')), 'ui/build missing — run npm run build:ui first');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-e2e-browser-'));
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ipfs: { autoStart: false } }));
  // A minimal unpacked extension: its content script marks every local page.
  const extDir = path.join(userData, 'extensions', 'marker');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Bucks test marker', version: '1.0',
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['mark.js'], run_at: 'document_end' }],
  }));
  fs.writeFileSync(path.join(extDir, 'mark.js'), "document.documentElement.dataset.bucksExtension = 'loaded';");
  const { server, base } = await site();

  const app = await electron.launch({
    cwd: root,
    args: ['.', '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, BUCKS_USER_DATA: userData },
  });
  const shortcut = (action) => app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0].webContents.send('bucks:app:shortcut', { action: a }), action);
  const state = (id) => page.evaluate((i) => window.bucks.tabs.getState(i), id);
  const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('bucks_browser_v2') || '{}'));
  let page;
  try {
    page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.bucks?.tabs?.find === 'function', null, { timeout: 30_000 });

    // ── open a page through the omnibox ──
    const omnibox = page.getByLabel('Address or search');
    await omnibox.fill(`${base}/fruit`);
    await omnibox.press('Enter');
    const tabId = await waitFor(async () => {
      const s = await store();
      const t = (s.tabs || []).find((x) => x.url === `${base}/fruit`);
      return t?.id;
    }, { label: 'tab for the fruit page' });
    await waitFor(async () => (await state(tabId))?.title === 'Fruit stand', { label: 'page loaded' });

    // ── the extension ran in the page, and is listed ──
    const marked = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/fruit'));
      return wc.executeJavaScript('document.documentElement.dataset.bucksExtension || ""');
    });
    assert.equal(marked, 'loaded', 'content script of the unpacked extension ran');
    const listed = await page.evaluate(() => window.bucks.extensions.list());
    assert.deepEqual(listed.extensions.map((e) => [e.name, e.error]), [['Bucks test marker', null]]);

    // ── find in page ──
    await shortcut('find');
    const findField = page.getByLabel('Find in page');
    await findField.waitFor();
    await findField.fill('apple');
    await page.getByText('1/3').waitFor({ timeout: 10_000 });
    await findField.press('Enter');
    await page.getByText('2/3').waitFor({ timeout: 10_000 });
    await page.screenshot({ path: path.join(ARTIFACTS, 'browser-find.png') });
    await findField.press('Escape');
    await waitFor(async () => (await findField.count()) === 0, { label: 'find bar closed' });

    // ── zoom and mute are reported back ──
    assert.equal(await page.evaluate((id) => window.bucks.tabs.zoom(id, 'in'), tabId), 110);
    await page.getByRole('button', { name: '110%' }).waitFor();
    await page.getByRole('button', { name: '110%' }).click();
    await waitFor(async () => (await state(tabId)).zoom === 100, { label: 'zoom reset by the pill' });
    await page.evaluate((id) => window.bucks.tabs.setMuted(id, true), tabId);
    assert.equal((await state(tabId)).muted, true);
    await page.evaluate((id) => window.bucks.tabs.setMuted(id, false), tabId);

    // ── save as PDF (the save dialog is answered by the test) ──
    const pdfPath = path.join(userData, 'fruit.pdf');
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, pdfPath);
    assert.deepEqual(await page.evaluate((id) => window.bucks.tabs.printToPdf(id), tabId), { path: pdfPath });
    assert.equal(fs.readFileSync(pdfPath).subarray(0, 5).toString(), '%PDF-');

    // ── cookies in a normal tab ──
    await omnibox.fill(`${base}/cookie?v=normal`);
    await omnibox.press('Enter');
    await waitFor(async () => (await state(tabId))?.title === 'Cookie page', { label: 'cookie page' });

    // ── a private tab does not see it, and is wiped when closed ──
    await shortcut('new-private-tab');
    await page.getByText('Private', { exact: true }).first().waitFor();
    await omnibox.fill(`${base}/echo`);
    await omnibox.press('Enter');
    const privId = await waitFor(async () => {
      const all = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));
      return all.some((u) => u.endsWith('/echo')) ? 'ok' : null;
    }, { label: 'private tab loaded' });
    assert.ok(privId);
    const privateCookie = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/echo'));
      return wc.executeJavaScript('document.body.innerText');
    });
    assert.equal(JSON.parse(privateCookie).cookie, '', 'private tab does not get the normal cookie');
    const saved = await store();
    assert.ok(!(saved.tabs || []).some((t) => t.private), 'private tabs are not persisted');
    assert.ok(!(saved.history || []).some((h) => h.url.endsWith('/echo')), 'private browsing is not in history');
    await page.screenshot({ path: path.join(ARTIFACTS, 'browser-private.png') });
    await shortcut('close-tab');

    // ── clearing cookies clears them in the normal session ──
    const echoInNormal = async () => app.evaluate(async ({ session }, u) => {
      const res = await session.fromPartition('persist:bucks-web').fetch(u);
      return (await res.json()).cookie;
    }, `${base}/echo`);
    assert.match(await echoInNormal(), /seen=normal/);
    assert.deepEqual(await page.evaluate(() => window.bucks.browsingData.clear({ cookies: true })), { cleared: ['cookies'] });
    assert.equal(await echoInNormal(), '');

    // ── tab menu: duplicate, pin, rename ──
    const tabButton = page.getByRole('button', { name: 'Cookie page' }).first();
    await tabButton.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await waitFor(async () => (await store()).tabs.filter((t) => t.url === `${base}/cookie?v=normal`).length === 2, { label: 'duplicated' });
    await page.getByRole('button', { name: 'Cookie page' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename…' }).click();
    await page.getByPlaceholder('Tab name (empty: page title)').fill('My cookie tab');
    await page.getByPlaceholder('Tab name (empty: page title)').press('Enter');
    await page.getByRole('button', { name: 'My cookie tab' }).waitFor();
    await page.getByRole('button', { name: 'My cookie tab' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin' }).click();
    await waitFor(async () => (await store()).tabs.some((t) => t.pinned && t.customTitle === 'My cookie tab'), { label: 'pinned' });

    // ── reopen a closed tab ──
    const before = (await store()).tabs.length;
    await shortcut('close-tab');
    await waitFor(async () => (await store()).tabs.length === before - 1, { label: 'closed' });
    await shortcut('reopen-closed-tab');
    await waitFor(async () => (await store()).tabs.length === before, { label: 'reopened' });

    // ── spaces ──
    await page.getByRole('button', { name: 'Spaces' }).click();
    await page.getByRole('button', { name: 'New space' }).click();
    await page.getByPlaceholder('Space name').fill('Work');
    await page.getByRole('button', { name: 'Create' }).click();
    await waitFor(async () => {
      const s = await store();
      const work = (s.spaces || []).find((sp) => sp.name === 'Work');
      return work && s.activeSpaceId === work.id && s.tabs.some((t) => t.spaceId === work.id);
    }, { label: 'switched to the new space' });
    await waitFor(async () => (await page.getByRole('button', { name: 'My cookie tab' }).count()) === 0, { label: 'the other space\'s tabs are hidden (after their exit transition)' });
    await page.screenshot({ path: path.join(ARTIFACTS, 'browser-spaces.png') });
    await page.getByRole('button', { name: 'Spaces' }).click();
    await page.getByRole('button', { name: /^Personal/ }).click();
    await page.getByRole('button', { name: 'My cookie tab' }).waitFor();

    // ── omnibox suggestions from history ──
    await omnibox.fill('fruit');
    await page.getByRole('button', { name: /Fruit stand/ }).waitFor();
    await page.screenshot({ path: path.join(ARTIFACTS, 'browser-suggestions.png') });
    await omnibox.press('Escape');
  } finally {
    await app.close();
    server.close();
  }
});
