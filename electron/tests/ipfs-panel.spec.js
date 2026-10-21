// "IPFS node" in the real app: the panel opens from the menu, shows the running Kubo node, adds
// text, lists and protects pins (a hosted site's CID cannot be unpinned here), browses a folder,
// unpins, saves validated settings and stops / starts the node.
const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const kuboBinary = path.join(__dirname, '..', 'hosting', 'resources', 'kubo', `${{ darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform]}-${process.arch}`, process.platform === 'win32' ? 'ipfs.exe' : 'ipfs');

test.describe('IPFS node panel', () => {
  test.skip(!fs.existsSync(kuboBinary), 'no Kubo binary (npm run fetch:kubo in electron/hosting)');
  test.setTimeout(180000);

  let app, page, userData, siteDir, site;

  test.beforeAll(async () => {
    test.setTimeout(120000);
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-ipfs-panel-e2e-'));
    siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-ipfs-panel-site-'));
    fs.writeFileSync(path.join(siteDir, 'index.html'), '<!doctype html><title>Panel site</title>');
    fs.mkdirSync(path.join(siteDir, 'docs'));
    fs.writeFileSync(path.join(siteDir, 'docs', 'guide.html'), '<!doctype html><title>Guide</title>');
    app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, BUCKS_TESTING: '1' } });
    const deadline = Date.now() + 20000;
    for (;;) {
      page = app.windows().find((w) => w.url().includes('index.html'));
      if (page) break;
      if (Date.now() > deadline) throw new Error('Shell window never appeared');
      await new Promise((r) => setTimeout(r, 250));
    }
    await page.waitForLoadState('domcontentloaded');
    // A hosted site, so its pin is protected in the panel.
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, siteDir);
    const chosen = await page.evaluate(() => window.bucksSites.chooseFolder());
    site = await page.evaluate((token) => window.bucksSites.publish({ token, name: 'Panel site', ipns: false }), chosen.token);
  });

  /** Open the panel (idempotent) and wait for the running node. */
  async function openPanel() {
    await page.evaluate(() => window.ipfsPanel.open());
    await expect(page.locator('#ip-state')).toHaveText('running', { timeout: 120000 });
    return page.getByRole('dialog', { name: 'IPFS node' });
  }

  test.afterAll(async () => {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(siteDir, { recursive: true, force: true });
  });

  test('opens from the menu and shows the running node', async () => {
    await page.locator('#btn-hamburger').click();
    await page.locator('#menu-item-ipfs').click();
    const panel = page.getByRole('dialog', { name: 'IPFS node' });
    await expect(panel).toBeVisible();
    await expect(page.locator('#ip-state')).toHaveText('running', { timeout: 120000 });
    await expect(panel).toContainText('Embedded Kubo');
    await expect(panel).toContainText('12D3Koo');
    await expect(panel).toContainText('peers');
  });

  test('adds text, pins it, protects the site pin, unpins', async () => {
    const panel = await openPanel();
    await panel.getByLabel('Text to add').fill(`note from the panel ${Date.now()}`);
    await panel.getByLabel('Text file name').fill('note.txt');
    await panel.getByRole('button', { name: 'Add text' }).click();
    await expect(panel.getByRole('status')).toHaveText('Text added to your node (pinned).');
    const cid = await panel.getByRole('group', { name: 'Added to your node' }).locator('.ip-mono').textContent();
    expect(cid).toMatch(/^baf/);
    const pinned = await page.evaluate(() => window.bucksIpfs.pinLs());
    expect(pinned.map((p) => p.cid)).toContain(cid);

    const siteRow = panel.locator('.ip-row', { hasText: 'site: Panel site' });
    await expect(siteRow.getByRole('button', { name: 'Unpin' })).toBeDisabled();

    const short = `${cid.slice(0, 10)}…${cid.slice(-6)}`;
    await panel.locator('.ip-row', { hasText: short }).getByRole('button', { name: 'Unpin' }).click();
    await expect(panel.getByRole('status')).toHaveText('Unpinned. Garbage collection may now remove it.');
    expect((await page.evaluate(() => window.bucksIpfs.pinLs())).map((p) => p.cid)).not.toContain(cid);
  });

  test('browses a folder and goes into a subfolder', async () => {
    const panel = await openPanel();
    await panel.getByLabel('Path to browse').fill(`ipfs://${site.cid}`);
    await panel.getByRole('button', { name: 'Browse' }).click();
    await expect(panel).toContainText('index.html');
    await panel.locator('.ip-row', { hasText: 'docs' }).getByRole('button', { name: 'Open folder' }).click();
    await expect(panel).toContainText('guide.html');
    await expect(panel.getByRole('button', { name: 'Up' })).toBeVisible();
  });

  test('saves settings, refuses a bad gateway', async () => {
    const panel = await openPanel();
    await panel.getByLabel('Public gateway').fill('http://insecure.example');
    await panel.getByRole('button', { name: 'Save settings' }).click();
    await expect(panel.getByRole('status')).toHaveText('The public gateway must use https://.');

    await panel.getByLabel('Public gateway').fill('https://dweb.link');
    await panel.getByLabel('Start the node when Bucks starts').uncheck();
    await panel.getByLabel('Storage limit in GB').fill('20');
    await panel.getByRole('button', { name: 'Save settings' }).click();
    await expect(panel.getByRole('status')).toContainText('Settings saved.');
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'hosting', 'settings.json'), 'utf8'));
    expect(saved.ipfs).toMatchObject({ autoStart: false, storageMaxGB: 20, publicGateway: 'https://dweb.link', mode: 'embedded' });
  });

  test('stops and starts the node', async () => {
    const panel = await openPanel();
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('#ip-state')).toHaveText('stopped', { timeout: 30000 });
    await panel.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.locator('#ip-state')).toHaveText('running', { timeout: 120000 });
  });
});
