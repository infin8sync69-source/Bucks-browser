// End-to-end device pairing test: two real Bucks instances at once (stand-ins for the Linux laptop
// and the MacBook), each with its own profile and embedded Kubo node, pair with each other through
// window.bucks.devices, see each other online over pubsub, and send a file from A to B.
//
//   npm run build:ui && xvfb-run -a node --test test/e2e/devices.test.mjs
//
// Requires a Kubo binary: resources/kubo/<os>-<arch>/ipfs, or BUCKS_KUBO_BIN. Both instances run
// on one host, so each pairs with the other's advertised addrs (self.addrs). If the sandbox has no
// non-loopback interface, self.addrs is empty (loopback is never advertised, by design); the test
// then pairs over the loopback address from window.bucks.ipfs.nodeInfo instead, and says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE_TIMEOUT = Number(process.env.BUCKS_E2E_TIMEOUT_MS || 120_000);
const PEER_TIMEOUT = 90_000;
const ARTIFACTS = process.env.BUCKS_E2E_ARTIFACTS || path.join(os.tmpdir(), 'bucks-e2e');
const PLATFORM_DIR = `${{ darwin: 'mac', win32: 'win' }[process.platform] || process.platform}-${process.arch}`;
const KUBO_BIN = process.env.BUCKS_KUBO_BIN
  || path.join(root, 'resources', 'kubo', PLATFORM_DIR, process.platform === 'win32' ? 'ipfs.exe' : 'ipfs');

async function waitFor(fn, { timeout, interval = 500, label }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${label}: last=${JSON.stringify(last)?.slice(0, 2000)}`);
}

/** PIDs of live processes (Electron and its helpers, the Kubo daemon) that belong to a profile dir. */
function processesUsing(userData) {
  if (process.platform !== 'linux') return [];
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    for (const f of ['cmdline', 'environ']) {
      let text;
      try { text = fs.readFileSync(`/proc/${entry}/${f}`, 'latin1'); } catch { continue; }
      if (text.includes(userData)) {
        let stat = '';
        try { stat = fs.readFileSync(`/proc/${entry}/stat`, 'latin1'); } catch { /* gone */ }
        if (/^\d+ \(.*\) Z /.test(stat)) break; // zombie: already exited, waiting to be reaped
        found.push(Number(entry));
        break;
      }
    }
  }
  return found;
}

async function launch(tag) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `bucks-e2e-dev-${tag}-`));
  const errors = [];
  const app = await electron.launch({
    cwd: root,
    args: ['.', '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, BUCKS_DEBUG: '1', BUCKS_USER_DATA: userData, BUCKS_KUBO_BIN: KUBO_BIN },
  });
  const page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.waitForFunction(() => typeof window.bucks?.devices?.status === 'function', null, { timeout: 30_000 });
  return { tag, app, page, userData, errors };
}

async function waitNodeReady(d) {
  await waitFor(async () => {
    const s = await d.page.evaluate(() => window.bucks.ipfs.status());
    if (s.state === 'error') throw new Error(`${d.tag}: IPFS node failed: ${s.message}`);
    return s.state === 'ready' ? s : null;
  }, { timeout: NODE_TIMEOUT, label: `${d.tag} IPFS node ready` });
  return waitFor(async () => {
    const s = await d.page.evaluate(() => window.bucks.devices.status());
    return s.ready && s.self.peerId ? s : null;
  }, { timeout: 60_000, label: `${d.tag} devices subscribed` });
}

/** The addrs another device should dial: advertised addrs, else (sandbox only) the loopback TCP addr. */
async function pairingAddrs(d, status) {
  if (status.self.addrs.length) return { addrs: status.self.addrs, loopback: false };
  const info = await d.page.evaluate(() => window.bucks.ipfs.nodeInfo());
  const addrs = info.addresses
    .filter((a) => /^\/ip4\/127\.0\.0\.1\/tcp\/\d+(\/p2p\/[^/]+)?$/.test(a))
    .map((a) => a.replace(/\/p2p\/[^/]+$/, ''));
  assert.ok(addrs.length, `${d.tag}: no shareable addrs and no loopback tcp addr in ${JSON.stringify(info.addresses)}`);
  return { addrs: [...new Set(addrs)], loopback: true };
}

test('two Bucks installs pair over Kubo peering + pubsub and send a file', { timeout: NODE_TIMEOUT + 6 * PEER_TIMEOUT }, async (t) => {
  assert.ok(fs.existsSync(path.join(root, 'ui', 'build', 'index.html')), 'ui/build missing — run npm run build:ui first');
  assert.ok(fs.existsSync(KUBO_BIN), `Kubo binary missing at ${KUBO_BIN} (set BUCKS_KUBO_BIN)`);
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const devices = [];
  try {
    // Launch both at once, like two machines booting independently.
    devices.push(...await Promise.all([launch('A'), launch('B')]));
    const [A, B] = devices;
    assert.notEqual(A.userData, B.userData);

    const [stA, stB] = await Promise.all([waitNodeReady(A), waitNodeReady(B)]);
    assert.notEqual(stA.self.peerId, stB.self.peerId, 'separate profiles must have separate peer IDs');
    assert.equal(stA.topic, 'bucks-devices-v1');
    assert.equal(stA.error, null, `A devices error: ${stA.error}`);
    assert.equal(stB.error, null, `B devices error: ${stB.error}`);

    // The leftover-process check at the end must be able to see each app's processes.
    if (process.platform === 'linux') {
      for (const d of devices) {
        const mainLog = fs.readFileSync(path.join(d.userData, 'logs', 'main.log'), 'utf8');
        const kuboPid = Number([...mainLog.matchAll(/ipfs daemon started \(pid (\d+)\)/g)].pop()?.[1]);
        assert.ok(kuboPid > 0, `${d.tag}: Kubo daemon pid not found in main.log`);
        const live = processesUsing(d.userData);
        assert.ok(live.includes(d.app.process().pid), `${d.tag}: Electron main process not detected`);
        assert.ok(live.includes(kuboPid), `${d.tag}: Kubo daemon ${kuboPid} not detected`);
      }
    }

    await A.page.evaluate((n) => window.bucks.devices.rename(n), 'linux-laptop');
    await B.page.evaluate((n) => window.bucks.devices.rename(n), 'macbook-air');

    const pa = await pairingAddrs(A, stA);
    const pb = await pairingAddrs(B, stB);
    for (const [d, p] of [[A, pa], [B, pb]]) {
      t.diagnostic(`${d.tag} pairing addrs (${p.loopback ? 'loopback fallback: the sandbox has no shareable addrs' : 'advertised self.addrs'}): ${p.addrs.join(', ')}`);
      for (const a of p.addrs) assert.ok(!a.includes('/p2p/'), `addrs must not carry /p2p: ${a}`);
    }

    // A pairs with B using peerId + addrs; B pairs back with the pasted pairing-address form.
    const afterA = await A.page.evaluate((p) => window.bucks.devices.pair(p), { peerId: stB.self.peerId, name: 'macbook-air', addrs: pb.addrs });
    assert.equal(afterA.paired.length, 1);
    assert.equal(afterA.paired[0].peerId, stB.self.peerId);
    const pasted = `${pa.addrs[0]}/p2p/${stA.self.peerId}`;
    const afterB = await B.page.evaluate((peerId) => window.bucks.devices.pair({ peerId }), pasted);
    assert.equal(afterB.paired.length, 1);
    assert.equal(afterB.paired[0].peerId, stA.self.peerId);
    assert.ok(afterB.paired[0].addrs.includes(pa.addrs[0]), `B stored A's addr without /p2p: ${JSON.stringify(afterB.paired[0].addrs)}`);

    // Pairings are persisted in settings.ipfs.peers.
    const settingsA = await A.page.evaluate(() => window.bucks.settings.get());
    assert.deepEqual(settingsA.ipfs.peers.map((p) => p.peerId), [stB.self.peerId]);

    // Both see each other online (presence over pubsub) and connected (swarm/peers).
    const [onA, onB] = await Promise.all([
      waitFor(() => A.page.evaluate(() => window.bucks.devices.status()).then((s) => (s.paired[0]?.online && s.paired[0]?.connected ? s : null)),
        { timeout: PEER_TIMEOUT, interval: 1000, label: 'A sees B online + connected' }),
      waitFor(() => B.page.evaluate(() => window.bucks.devices.status()).then((s) => (s.paired[0]?.online && s.paired[0]?.connected ? s : null)),
        { timeout: PEER_TIMEOUT, interval: 1000, label: 'B sees A online + connected' }),
    ]);
    assert.equal(onA.paired[0].name, 'macbook-air');
    assert.equal(onA.paired[0].platform, process.platform);
    assert.equal(onB.paired[0].platform, process.platform);
    assert.equal(onB.paired[0].name, 'linux-laptop', 'B learns the name from A\'s presence when paired by address');

    // A adds a small HTML page and offers it to its devices.
    const title = 'Bucks Devices E2E';
    const html = `<!doctype html><html><head><title>${title}</title></head><body><h1>sent from ${stA.self.peerId}</h1></body></html>`;
    const added = await A.page.evaluate((content) => window.bucks.ipfs.addText(content, 'shared.html'), html);
    assert.ok(added.cid, 'addText returned a CID');
    const shareRes = await A.page.evaluate((s) => window.bucks.devices.share(s), { cid: added.cid, name: 'shared.html', size: Buffer.byteLength(html) });
    assert.equal(shareRes.queued, true);
    assert.equal(shareRes.onlinePeers, 1);

    // B receives the share from its paired device A.
    const got = await waitFor(
      () => B.page.evaluate((cid) => window.bucks.devices.status().then((s) => s.received.find((r) => r.cid === cid) || null), added.cid),
      { timeout: PEER_TIMEOUT, interval: 1000, label: 'B received the share' },
    );
    assert.equal(got.from, stA.self.peerId);
    assert.equal(got.fromName, 'linux-laptop');
    assert.equal(got.name, 'shared.html');
    assert.equal(got.size, Buffer.byteLength(html));

    // B fetches the bytes through its own node (bitswap from A).
    const cat = await B.page.evaluate((cid) => window.bucks.ipfs.cat(cid), added.cid);
    assert.equal(Buffer.from(cat, 'base64').toString('utf8'), html);

    // B opens it in a tab through the ipfs:// protocol handler.
    const tabId = 'e2e-devices-tab';
    await B.page.evaluate(({ id, url }) => window.bucks.tabs.create(id, url), { id: tabId, url: `ipfs://${added.cid}` });
    await B.page.evaluate((id) => window.bucks.tabs.activate(id), tabId);
    await B.page.evaluate(() => window.bucks.tabs.setContentBounds({ x: 0, y: 96, width: 1000, height: 600 }));
    const tab = await waitFor(
      () => B.page.evaluate((id) => window.bucks.tabs.getState(id), tabId).then((s) => (s && !s.isLoading && s.title ? s : null)),
      { timeout: 30_000, label: 'B tab loaded' },
    );
    assert.equal(tab.error, null, `tab error ${JSON.stringify(tab.error)}`);
    assert.equal(tab.title, title);
    await B.page.evaluate((id) => window.bucks.tabs.close(id), tabId);
    await B.page.evaluate(() => window.bucks.tabs.activate(null));

    // B's IPFS page shows the received file in the Devices section.
    const omnibox = B.page.locator('header input[type="text"]').first();
    await omnibox.fill('bucks://ipfs');
    await omnibox.press('Enter');
    const section = B.page.getByTestId('devices-section');
    await section.waitFor({ timeout: 15_000 });
    const row = section.locator('#received-files-heading ~ ul li').filter({ hasText: 'shared.html' }).first();
    await row.waitFor({ timeout: 15_000 });
    const rowText = await row.innerText();
    assert.match(rowText, /linux-laptop/, `received row names the sender: ${rowText}`);
    await row.getByRole('button', { name: 'Open shared.html in a new tab' }).waitFor({ timeout: 5000 });
    await B.page.screenshot({ path: path.join(ARTIFACTS, 'devices-B-received.png') });

    // Unpair on both sides.
    const unA = await A.page.evaluate((id) => window.bucks.devices.unpair(id), stB.self.peerId);
    const unB = await B.page.evaluate((id) => window.bucks.devices.unpair(id), stA.self.peerId);
    assert.equal(unA.paired.length, 0);
    assert.equal(unB.paired.length, 0);
    assert.equal(unA.error, null, `A unpair error: ${unA.error}`);
    assert.equal(unB.error, null, `B unpair error: ${unB.error}`);
    const settingsB = await B.page.evaluate(() => window.bucks.settings.get());
    assert.deepEqual(settingsB.ipfs.peers, []);

    for (const d of devices) assert.deepEqual(d.errors, [], `${d.tag} console errors`);
  } finally {
    for (const d of devices) await d.app.close().catch(() => {});
    // No Electron helper or Kubo daemon may outlive its app.
    const leftovers = await waitFor(
      () => {
        const live = devices.flatMap((d) => processesUsing(d.userData));
        return live.length === 0 ? [] : null;
      },
      { timeout: 15_000, label: 'all app and Kubo processes to exit' },
    ).catch((e) => e);
    for (const d of devices) fs.rmSync(d.userData, { recursive: true, force: true });
    if (leftovers instanceof Error) {
      const live = devices.flatMap((d) => processesUsing(d.userData));
      for (const pid of live) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      throw leftovers;
    }
  }
});
