// End-to-end smoke test: launches the real app under Electron (use xvfb-run on headless Linux),
// waits for the embedded Kubo node, publishes a file, opens it as an ipfs:// tab through the
// real protocol handler and checks what the tab reports back.
//
//   npm run build:ui && xvfb-run -a node --test test/e2e
//
// Requires a Kubo binary (resources/kubo/<os>-<arch>/ipfs or BUCKS_KUBO_BIN) because the sandbox
// cannot download one. Set BUCKS_E2E_TIMEOUT_MS to extend the node start timeout.

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

async function waitFor(fn, { timeout, interval = 500, label }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}: last=${JSON.stringify(last)}`);
}

test('ipfs:// end to end through the embedded node', { timeout: NODE_TIMEOUT + 60_000 }, async () => {
  assert.ok(fs.existsSync(path.join(root, 'ui', 'build', 'index.html')), 'ui/build missing — run npm run build:ui first');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-e2e-'));
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const app = await electron.launch({
    cwd: root,
    args: ['.', '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, BUCKS_DEBUG: '1', ELECTRON_ENABLE_LOGGING: '1', BUCKS_USER_DATA: userData },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.bucks === 'object' && typeof window.bucks.ipfs?.status === 'function', null, { timeout: 30_000 });

    const info = await page.evaluate(() => window.bucks.app.info());
    assert.equal(info.name, 'Bucks Browser');

    const status = await waitFor(
      async () => {
        const s = await page.evaluate(() => window.bucks.ipfs.status());
        if (s.state === 'error') throw new Error(`IPFS node failed: ${s.message}`);
        return s.state === 'ready' ? s : null;
      },
      { timeout: NODE_TIMEOUT, label: 'IPFS node ready' },
    );
    assert.ok(status.api_url?.startsWith('http://127.0.0.1:'), `api url ${status.api_url}`);
    assert.ok(status.gateway_url?.startsWith('http://127.0.0.1:'), `gateway url ${status.gateway_url}`);
    assert.ok(status.peer_id, 'peer id');

    const html = `<!doctype html><html><head><title>Bucks E2E Page</title></head><body><h1 id="h">hello from ipfs</h1><a id="l" href="./other.html">rel</a></body></html>`;
    const added = await page.evaluate((content) => window.bucks.ipfs.addText(content, 'index.html'), html);
    assert.match(added.cid, /^bafy/, 'CIDv1 base32 expected');
    assert.equal(added.ipfs_uri, `ipfs://${added.cid}`);

    const cat = await page.evaluate((cid) => window.bucks.ipfs.cat(cid), added.cid);
    assert.equal(Buffer.from(cat, 'base64').toString('utf8'), html);

    // Drive the tab manager directly through the bridge (bypasses the Svelte store on purpose).
    const id = 'e2e-tab-1';
    await page.evaluate(({ id, url }) => window.bucks.tabs.create(id, url), { id, url: added.ipfs_uri });
    await page.evaluate((id) => window.bucks.tabs.activate(id), id);
    await page.evaluate(() => window.bucks.tabs.setContentBounds({ x: 0, y: 96, width: 1000, height: 600 }));

    const state = await waitFor(
      () => page.evaluate((id) => window.bucks.tabs.getState(id), id).then((s) => (s && !s.isLoading && s.title ? s : null)),
      { timeout: 30_000, label: 'tab loaded' },
    );
    assert.equal(state.error, null, `tab error ${JSON.stringify(state.error)}`);
    assert.equal(state.title, 'Bucks E2E Page');
    assert.equal(state.url.replace(/\/$/, ''), added.ipfs_uri);

    const text = await page.evaluate((id) => window.bucks.tabs.extractText(id), id);
    assert.match(text.text, /hello from ipfs/);

    const shot = await page.evaluate((id) => window.bucks.tabs.capture(id), id);
    assert.match(shot, /^data:image\/png;base64,/);
    fs.writeFileSync(path.join(ARTIFACTS, 'tab-ipfs.png'), Buffer.from(shot.split(',')[1], 'base64'));
    await page.screenshot({ path: path.join(ARTIFACTS, 'chrome.png') });

    // CIDv0 typed by a user must be normalised to CIDv1 base32 by the tab manager.
    const v0 = await page.evaluate(() => window.bucks.ipfs.normalizeUrl('ipfs://QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB/x'));
    assert.equal(v0, 'ipfs://bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm/x');

    // Pinning round-trip
    await page.evaluate((cid) => window.bucks.ipfs.pinAdd(cid), added.cid);
    const pins = await page.evaluate(() => window.bucks.ipfs.pinLs());
    assert.ok(pins.some((p) => p.cid === added.cid), 'pinned cid listed');

    // Omnibox path: type an ipfs url in the chrome and expect a tab with that url to appear in storage
    const omnibox = page.locator('header input[type="text"]').first();
    await omnibox.fill(added.ipfs_uri);
    await omnibox.press('Enter');
    await waitFor(
      () => page.evaluate((uri) => {
        const raw = localStorage.getItem('bucks_browser_v2');
        if (!raw) return false;
        const s = JSON.parse(raw);
        return s.tabs.some((t) => t.url.replace(/\/$/, '') === uri && t.type === 'external');
      }, added.ipfs_uri),
      { timeout: 15_000, label: 'omnibox created an external ipfs tab' },
    );
    await page.screenshot({ path: path.join(ARTIFACTS, 'chrome-after-omnibox.png') });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
