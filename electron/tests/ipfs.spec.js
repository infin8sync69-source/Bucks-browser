// ipfs:// and ipns:// in the real app with the Bucks-browser handler (hosting/) in front of them:
//   - Kubo starts at launch (ipfs.autoStart) and is peered with the in-process Helia node;
//   - every address goes through the ported handler, including content only Helia has;
//   - a site published from the browser loads in a tab over ipfs:// and ipns://;
//   - with autoStart off, ipfs:// falls back to Helia and ipns:// offers to start the node.
// The handler is told apart from the Helia fallback by x-content-type-options: nosniff, which only
// the ported handler sends.
const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const kuboBinary = path.join(__dirname, '..', 'hosting', 'resources', 'kubo', `${{ darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform]}-${process.arch}`, process.platform === 'win32' ? 'ipfs.exe' : 'ipfs');

async function poll(fn, { timeout = 60000, interval = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function launch(userData) {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, BUCKS_TESTING: '1' } });
  const page = await poll(() => app.windows().find((w) => w.url().includes('index.html')), { timeout: 20000, interval: 250, label: 'shell window' });
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Fetch through the app's own protocol handlers (main process, default session). */
const fetchVia = (app, url) => app.evaluate(async ({ net }, u) => {
  const r = await net.fetch(u);
  return { status: r.status, headers: Object.fromEntries(r.headers), body: (await r.text()).slice(0, 4000) };
}, url);

/** Open a real tab and wait until it has loaded `url`. */
async function openTab(app, page, url) {
  await page.evaluate((u) => window.createTab(u), url);
  return poll(() => app.evaluate(async ({ webContents }, u) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(u));
    if (!wc || wc.isLoading()) return null;
    return { url: wc.getURL(), title: wc.getTitle(), text: await wc.executeJavaScript('document.body.innerText') };
  }, url), { timeout: 60000, label: `tab ${url}` });
}

test.describe('ipfs:// and ipns:// through the embedded Kubo node', () => {
  test.skip(!fs.existsSync(kuboBinary), 'no Kubo binary (npm run fetch:kubo in electron/hosting)');
  test.setTimeout(240000);

  let app, page, userData, siteDir;

  test.beforeAll(async () => {
    test.setTimeout(60000);
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-ipfs-e2e-'));
    siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-ipfs-site-'));
    fs.writeFileSync(path.join(siteDir, 'index.html'), '<!doctype html><html><head><title>E2E hosted site</title></head><body><h1>hosted by Bucks</h1></body></html>');
    ({ app, page } = await launch(userData));
  });

  test.afterAll(async () => {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(siteDir, { recursive: true, force: true });
  });

  test('Kubo starts at launch and is peered with the Helia node', async () => {
    const status = await poll(async () => {
      const s = await page.evaluate(() => window.bucksSites.nodeStatus());
      return s.state === 'ready' ? s : null;
    }, { timeout: 120000, label: 'Kubo ready' });
    expect(status.api_url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const helia = await poll(async () => {
      const i = await page.evaluate(() => window.bucksAPI.ipfsInfo());
      return i && i.status === 'online' ? i : null;
    }, { timeout: 60000, label: 'Helia online' });
    await poll(async () => {
      const r = await fetch(`${status.api_url}/api/v0/swarm/peers`, { method: 'POST' });
      const peers = (await r.json()).Peers || [];
      return peers.some((p) => p.Peer === helia.peerId);
    }, { timeout: 60000, label: 'Kubo connected to Helia' });
  });

  test('content published to Helia loads through the ported handler and Kubo', async () => {
    const text = `hello from helia ${Date.now()}`;
    const post = await page.evaluate((t) => window.bucksAPI.ipfsPublish(t, { name: 'e2e' }), text);
    expect(post.cid).toMatch(/^baf/);
    const r = await fetchVia(app, `ipfs://${post.cid}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain(text);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    // Private tabs use the 'bucks-private' session, which serves ipfs:// as well.
    const priv = await app.evaluate(async ({ session }, u) => {
      const res = await session.fromPartition('bucks-private').fetch(u);
      return { status: res.status, body: await res.text() };
    }, `ipfs://${post.cid}`);
    expect(priv.status).toBe(200);
    expect(priv.body).toContain(text);
  });

  test('a site published from the browser loads in a tab over ipfs:// and ipns://', async () => {
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, siteDir);
    const chosen = await page.evaluate(() => window.bucksSites.chooseFolder());
    const inspection = await page.evaluate((token) => window.bucksSites.inspect({ token }), chosen.token);
    expect(inspection.blocked).toBe(false);
    const published = await page.evaluate((token) => window.bucksSites.publish({ token, name: 'E2E hosted site' }), chosen.token);
    expect(published.urls.ipfs).toBe(`ipfs://${published.cid}/`);
    expect(published.urls.ipns).toMatch(/^ipns:\/\/k51/);

    const viaIpfs = await openTab(app, page, published.urls.ipfs);
    expect(viaIpfs.title).toBe('E2E hosted site');
    expect(viaIpfs.text).toContain('hosted by Bucks');
    const viaIpns = await openTab(app, page, published.urls.ipns);
    expect(viaIpns.title).toBe('E2E hosted site');
  });

  test("the agent's site tools run in the main process and publish only after the user approves", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-agent-site-'));
    fs.writeFileSync(path.join(agentDir, 'index.html'), '<!doctype html><title>Agent site</title><p>from the agent</p>');
    try {
      // The folder dialog picks agentDir; the approval dialog answers from globalThis.__answer and
      // records what it showed.
      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
        globalThis.__asked = [];
        dialog.showMessageBox = async (...a) => {
          const opts = a.length > 1 ? a[1] : a[0];
          globalThis.__asked.push({ message: opts.message, detail: opts.detail, buttons: opts.buttons });
          return { response: globalThis.__answer };
        };
      }, agentDir);
      const run = (name, args) => page.evaluate(({ n, a }) => window.__bucksBrowserControl.execute(n, a), { n: name, a: args });

      expect(await run('site_status', {})).toContain('E2E hosted site');
      const inspected = await run('site_inspect', {});
      expect(inspected).toContain('Can be published: yes');
      const token = /Folder token: (\S+)/.exec(inspected)[1];

      await app.evaluate(() => { globalThis.__answer = 1; }); // Cancel
      expect(await run('site_publish', { token, name: 'Agent site' })).toContain('did not approve');
      await app.evaluate(() => { globalThis.__answer = 0; }); // Publish
      const done = await run('site_publish', { token, name: 'Agent site' });
      expect(done).toContain('Published "Agent site"');
      expect(done).toMatch(/ipns:\/\/k51/);

      const asked = await app.evaluate(() => globalThis.__asked);
      expect(asked).toHaveLength(2);
      expect(asked[0].buttons).toEqual(['Publish', 'Cancel']);
      expect(asked[0].detail).toMatch(/^Publish the folder "bucks-agent-site-\w+" as the site "Agent site"/);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test('the address bar turns a CIDv0 into its CIDv1 origin', async () => {
    // QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn is the empty UnixFS directory, which every Kubo repo has.
    await page.locator('#address-bar').fill('ipfs://QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn');
    await page.locator('#address-bar').press('Enter');
    const tab = await poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .map((w) => w.getURL()).find((u) => u.startsWith('ipfs://bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354'))), { label: 'CIDv1 tab' });
    expect(tab).toBe('ipfs://bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354/');
  });
});

test.describe('with ipfs.autoStart off', () => {
  test.setTimeout(180000);

  let app, page, userData;

  test.beforeAll(async () => {
    test.setTimeout(120000);
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-ipfs-off-e2e-'));
    fs.mkdirSync(path.join(userData, 'hosting'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'hosting', 'settings.json'), JSON.stringify({ ipfs: { autoStart: false } }));
    ({ app, page } = await launch(userData));
    await poll(async () => {
      const i = await page.evaluate(() => window.bucksAPI.ipfsInfo());
      return i && i.status === 'online';
    }, { timeout: 60000, label: 'Helia online' });
  });

  test.afterAll(async () => {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test('Kubo stays off, ipfs:// is served by Helia', async () => {
    const status = await page.evaluate(() => window.bucksSites.nodeStatus());
    expect(status.state).not.toBe('ready');
    const text = `helia only ${Date.now()}`;
    const post = await page.evaluate((t) => window.bucksAPI.ipfsPublish(t, { name: 'e2e' }), text);
    const r = await fetchVia(app, `ipfs://${post.cid}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain(text);
    expect(r.headers['x-content-type-options']).toBeUndefined();
  });

  test('ipns:// offers to start the node instead of failing', async () => {
    const r = await fetchVia(app, 'ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8/');
    expect(r.body).toContain('Your IPFS node is not running');
  });
});
