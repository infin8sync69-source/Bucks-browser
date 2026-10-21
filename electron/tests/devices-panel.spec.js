// "Your devices" in the real app: the panel starts the Kubo node, shows this device's identity,
// saves its name, and refuses a bad pairing address. (Two-node pairing, sharing and auto-pin are
// covered by hosting/test/unit/ipfs/devices.integration.test.js with real Kubo daemons.)
const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const kuboBinary = path.join(__dirname, '..', 'hosting', 'resources', 'kubo', `${{ darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform]}-${process.arch}`, process.platform === 'win32' ? 'ipfs.exe' : 'ipfs');

test.describe('Devices panel', () => {
  test.skip(!fs.existsSync(kuboBinary), 'no Kubo binary (npm run fetch:kubo in electron/hosting)');
  test.setTimeout(180000);

  let app, page, userData;

  test.beforeAll(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-devices-e2e-'));
    app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, BUCKS_TESTING: '1' } });
    const deadline = Date.now() + 20000;
    for (;;) {
      page = app.windows().find((w) => w.url().includes('index.html'));
      if (page) break;
      if (Date.now() > deadline) throw new Error('Shell window never appeared');
      await new Promise((r) => setTimeout(r, 250));
    }
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test.afterAll(async () => {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test('opening the panel starts the node and shows this device', async () => {
    await page.evaluate(() => window.devicesPanel.open());
    await expect(page.locator('#dp-state')).toHaveText('listening', { timeout: 120000 });
    const body = page.locator('#dp-body');
    await expect(body).toContainText('This device');
    await expect(body).toContainText('12D3Koo');
    await expect(body).toContainText('No paired devices yet');
    await expect(body).toContainText('Nothing received yet');
  });

  test('the device name is saved', async () => {
    await page.locator('#dp-body input[aria-label="Device name"]').fill('E2E laptop');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.locator('#dp-body')).toContainText('Name saved.');
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'hosting', 'settings.json'), 'utf8'));
    expect(saved.devices.name).toBe('E2E laptop');
  });

  test('a bad pairing address is refused with a message and nothing is stored', async () => {
    await page.locator('#dp-body input[aria-label="Pairing address or peer ID"]').fill('not-a-peer');
    await page.locator('#dp-body section', { hasText: 'Pair manually' }).getByRole('button', { name: 'Pair' }).click();
    await expect(page.locator('#dp-body .dp-msg.bad')).toBeVisible();
    await expect(page.locator('#dp-body')).toContainText('No paired devices yet');
  });

  test('web pages cannot call the devices channels', async () => {
    // The channels check the sender: only the app's own shell page is allowed.
    const err = await app.evaluate(async ({ ipcMain }) => {
      // Simulate a call from a web page's frame by invoking the registered handler directly.
      const h = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get('bucks:devices:status');
      if (!h) return 'no-handler';
      try { await h({ senderFrame: { url: 'https://evil.example/' } }); return 'allowed'; } catch (e) { return String(e.message); }
    });
    expect(err).toMatch(/denied for this origin/);
  });
});
