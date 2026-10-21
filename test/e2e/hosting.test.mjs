// End-to-end: hosting a site from the browser (docs/IPFS-HOSTING-IMPLEMENTATION.md §14). Launches
// the real app, publishes a generated single-page app through window.bucks.sites (the folder dialog
// is answered by the test), and opens it in real tabs:
//   - a deep link on the ipns:// address renders the app (F1: it used to download as octet-stream);
//   - the address bar badge says "signed name";
//   - localStorage on the ipns:// origin survives an update, while the ipfs:// version changes;
//   - an unpublished preview is badged as such;
//   - with the node stopped, a page asks before using a public gateway.
//
//   npm run build:ui && xvfb-run -a node --test test/e2e/hosting.test.mjs

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

async function waitFor(fn, { timeout, interval = 300, label }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}: last=${JSON.stringify(last)}`);
}

/** A tiny history-router app: shows its path and counts visits in localStorage. */
function writeApp(dir, version) {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><title>loading</title></head><body><div id="app"></div><script type="module" src="/assets/app.js"></script></body></html>`);
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), `
    const n = Number(localStorage.getItem('visits') || 0) + 1;
    localStorage.setItem('visits', String(n));
    document.title = '${version} visits=' + n;
    document.getElementById('app').textContent = 'route ' + location.pathname + ' (${version})';
  `);
}

test('host a site: publish, deep links, badge, storage across an update, preview, consent', { timeout: NODE_TIMEOUT + 120_000 }, async () => {
  assert.ok(fs.existsSync(path.join(root, 'ui', 'build', 'index.html')), 'ui/build missing — run npm run build:ui first');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-e2e-host-'));
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-e2e-site-'));
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  writeApp(site, 'v1');

  const app = await electron.launch({
    cwd: root,
    args: ['.', '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, BUCKS_USER_DATA: userData, BUCKS_KUBO_OFFLINE: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.bucks?.sites?.publish === 'function', null, { timeout: 30_000 });
    await waitFor(async () => {
      const s = await page.evaluate(() => window.bucks.ipfs.status());
      if (s.state === 'error') throw new Error(`IPFS node failed: ${s.message}`);
      return s.state === 'ready';
    }, { timeout: NODE_TIMEOUT, label: 'IPFS node ready' });

    // The folder dialog runs in main; the test answers it.
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, site);
    const chosen = await page.evaluate(() => window.bucks.sites.chooseFolder());
    assert.equal(chosen.hints.suggestedDir, '');
    const inspection = await page.evaluate((token) => window.bucks.sites.inspect(token), chosen.token);
    assert.equal(inspection.blocked, false);
    assert.ok(inspection.checks.some((c) => c.fix?.action === 'enable-spa'), 'P7 suggests single-page-app mode');

    const progress = [];
    await page.exposeFunction('recordProgress', (p) => progress.push(p.step));
    await page.evaluate(() => window.bucks.sites.onProgress((p) => window.recordProgress(p)));
    const published = await page.evaluate((token) => window.bucks.sites.publish({ token, name: 'E2E app', enableSpa: true }), chosen.token);
    assert.match(published.urls.ipns, /^ipns:\/\/k51/);
    await waitFor(() => progress.includes('record'), { timeout: 5000, label: 'progress events' });

    const setBounds = () => page.evaluate(() => window.bucks.tabs.setContentBounds({ x: 0, y: 96, width: 1000, height: 600 }));
    const open = async (id, url) => {
      await page.evaluate(({ id, url }) => window.bucks.tabs.create(id, url), { id, url });
      await page.evaluate((id) => window.bucks.tabs.activate(id), id);
      await setBounds();
    };
    const stateWhen = async (id, pred, label) => {
      let seen = null;
      try {
        return await waitFor(
          () => page.evaluate((id) => window.bucks.tabs.getState(id), id).then((s) => { seen = s; return s && !s.isLoading && pred(s) ? s : null; }),
          { timeout: 30_000, label },
        );
      } catch (e) {
        throw new Error(`${e.message}; the tab was at ${JSON.stringify(seen)}`);
      }
    };

    // Deep link on the updatable address renders the app; nothing is downloaded.
    const deepUrl = `${published.urls.ipns}trainer/step-2`;
    await open('host-1', deepUrl);
    const first = await stateWhen('host-1', (s) => /^v1 visits=/.test(s.title), 'the deep link renders');
    assert.equal(first.title, 'v1 visits=1');
    assert.equal(first.badge?.kind, 'signed-name');
    assert.equal(first.badge?.cid, published.cid);
    const text = await page.evaluate(() => window.bucks.tabs.extractText('host-1'));
    assert.match(text.text, /route \/trainer\/step-2 \(v1\)/);
    assert.deepEqual(await page.evaluate(() => window.bucks.downloads.list()), [], 'the deep link did not download');
    fs.writeFileSync(path.join(ARTIFACTS, 'hosting-deep-link.png'), Buffer.from((await page.evaluate(() => window.bucks.tabs.capture('host-1'))).split(',')[1], 'base64'));

    // Update: the ipns:// origin keeps its storage; the old ipfs:// version still serves v1.
    writeApp(site, 'v2');
    const review = await page.evaluate((id) => window.bucks.sites.update({ id, enableSpa: true }), published.id);
    assert.deepEqual(review.diff.counts, { added: 0, changed: 1, removed: 0 });
    const updated = await page.evaluate(({ id, cid }) => window.bucks.sites.update({ id, enableSpa: true, confirm: true, expectCid: cid }), { id: published.id, cid: review.cid });
    assert.notEqual(updated.cid, published.cid);
    // Nothing on an ipns:// name is cached and the browser knows its own name's new target, so a
    // reload right after the update shows the new version (Kubo alone would serve the old one for
    // up to the record TTL on an online node).
    await page.evaluate(() => window.bucks.tabs.reload('host-1'));
    const second = await stateWhen('host-1', (s) => /^v2 visits=/.test(s.title), 'the updated version on the same address');
    assert.equal(second.title, 'v2 visits=2', 'localStorage survived the update on the ipns:// origin');

    await open('host-2', `ipfs://${published.cid}/somewhere`);
    const old = await stateWhen('host-2', (s) => /visits=/.test(s.title), 'the old version by CID');
    assert.equal(old.title, 'v1 visits=1', 'the CID address is its own origin and keeps the old version');
    assert.equal(old.badge?.kind, 'content-addressed');

    // An unpublished preview is badged.
    writeApp(site, 'v3');
    const again = await page.evaluate(() => window.bucks.sites.chooseFolder());
    const preview = await page.evaluate((token) => window.bucks.sites.preview(token, { enableSpa: true }), again.token);
    await open('host-3', preview.url);
    const previewed = await stateWhen('host-3', (s) => /^v3 /.test(s.title), 'the preview');
    assert.equal(previewed.badge?.kind, 'preview');

    // A crafted link cannot make this site's origin serve another CID (Kubo would follow '..%2F').
    const evil = await page.evaluate(() => window.bucks.ipfs.addText('<!doctype html><title>EVIL</title>', 'evil.html'));
    await open('host-5', `ipfs://${published.cid}/..%2F${evil.cid}`);
    const refused = await stateWhen('host-5', (s) => s.title === 'Invalid address', 'the traversal refused');
    assert.notEqual(refused.title, 'EVIL');

    // Node stopped: a page asks before any public gateway is used.
    await page.evaluate(() => window.bucks.ipfs.stop());
    await open('host-4', `ipfs://${updated.cid}/`);
    const asked = await stateWhen('host-4', (s) => s.title === 'Your IPFS node is not running', 'the consent interstitial');
    assert.equal(asked.badge, undefined);
    const interstitial = await page.evaluate(() => window.bucks.tabs.extractText('host-4'));
    assert.match(interstitial.text, /Start node/);
    assert.match(interstitial.text, /Use public gateway once/);
    await page.screenshot({ path: path.join(ARTIFACTS, 'hosting-chrome.png') });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(site, { recursive: true, force: true });
  }
});
