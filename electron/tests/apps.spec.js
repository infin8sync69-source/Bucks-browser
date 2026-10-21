// Apps installed from IPFS, run in a real Bucks container (Bucks-browser docs/APP-ENVIRONMENT.md):
//   - installed from a folder through window.bucksApps (the folder dialog is answered by the test);
//   - the Installed apps panel lists it; Open starts its own window on bucks-app://<id>/ with the
//     app bridge, its own storage, and no network it was not granted (the node's gateway too);
//   - the agent's app_call, through the shell like a Soul Engine tool call, reaches the tool the
//     app registered after the user allows it in the native dialog;
//   - revoking a permission reloads the app without it; uninstalling from the panel removes it.
const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const kuboBinary = path.join(__dirname, '..', 'hosting', 'resources', 'kubo', `${{ darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform]}-${process.arch}`, process.platform === 'win32' ? 'ipfs.exe' : 'ipfs');

async function poll(fn, { timeout = 30000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** A small app: reports what it can reach in its title, counts its opens, offers one agent tool. */
function writeApp(dir, gatewayUrl) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>loading</title></head><body><div id="app">Notes</div><script type="module" src="/app.js"></script></body></html>');
  fs.writeFileSync(path.join(dir, 'app.js'), `
    const out = { bridge: typeof window.bucks?.app?.info === 'function', shellApi: typeof window.bucksAPI + '/' + typeof window.bucksApps };
    const n = Number(localStorage.getItem('opens') || 0) + 1;
    localStorage.setItem('opens', String(n));
    out.opens = n;
    try { await fetch(${JSON.stringify(`${gatewayUrl}/ipfs/bafkqaaa`)}, { mode: 'no-cors' }); out.node = 'reached'; } catch { out.node = 'blocked'; }
    if (out.bridge) {
      out.info = await window.bucks.app.info();
      window.bucks.app.agent.handle('count_opens', async (input) => ({ opens: n, echo: input?.note ?? null }));
    }
    document.title = 'ready ' + JSON.stringify(out);
  `);
  fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#a78bfa"/></svg>');
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

test.describe('Installed apps', () => {
  test.skip(!fs.existsSync(kuboBinary), 'no Kubo binary (npm run fetch:kubo in electron/hosting)');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  let app, page, userData, appDir, installed, appWindow;

  test.beforeAll(async () => {
    test.setTimeout(180000);
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-apps-e2e-'));
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-apps-e2e-app-'));
    app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, BUCKS_TESTING: '1' } });
    page = await poll(() => app.windows().find((w) => w.url().includes('index.html')), { timeout: 20000, label: 'shell window' });
    await page.waitForLoadState('domcontentloaded');
    const status = await poll(async () => {
      const s = await page.evaluate(() => window.bucksIpfs.status());
      return s.state === 'ready' ? s : null;
    }, { timeout: 120000, label: 'IPFS node ready' });
    writeApp(appDir, status.gateway_url);
  });

  test.afterAll(async () => {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  });

  test('install from a folder: the review lists what the app asks for', async () => {
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, appDir);
    await page.evaluate(() => window.appsPanel.open());
    const panel = page.getByRole('dialog', { name: 'Installed apps' });
    await expect(panel).toContainText('No apps yet.');
    await panel.getByRole('button', { name: 'Install an app' }).click();
    await panel.getByRole('button', { name: 'Choose a folder…' }).click();
    await expect(panel).toContainText('What it asks for');
    await expect(panel).toContainText('E2E Notes');
    await expect(panel.getByRole('checkbox')).toHaveCount(2); // notifications, agent tools
    await panel.getByRole('button', { name: 'Install E2E Notes' }).click();
    await expect(panel.getByRole('status')).toHaveText('Installed E2E Notes.');
    const list = await page.evaluate(() => window.bucksApps.list());
    expect(list).toHaveLength(1);
    installed = list[0];
    expect(installed.id).toMatch(/^a_[a-f0-9]{10}$/);
    expect(installed.permissions.map((p) => [p.id, p.granted])).toEqual([['notifications', true], ['agent-tools', true]]);
  });

  test('Open: its own window and origin, the app bridge only, no node access', async () => {
    const panel = page.getByRole('dialog', { name: 'Installed apps' });
    await panel.getByRole('button', { name: 'All apps' }).click();
    const opened = app.waitForEvent('window', { timeout: 20000 });
    await panel.getByRole('button', { name: 'Open E2E Notes' }).click();
    appWindow = await opened;
    expect(new URL(appWindow.url()).protocol).toBe('bucks-app:');
    expect(new URL(appWindow.url()).hostname).toBe(installed.id);
    const first = await poll(() => readyState(appWindow), { label: 'the app reports its state' });
    expect(first.bridge).toBe(true);
    expect(first.shellApi).toBe('undefined/undefined');
    expect(first.opens).toBe(1);
    expect(first.node).toBe('blocked');
    expect(first.info).toMatchObject({ id: installed.id, name: 'E2E Notes', permissions: ['notifications', 'agent-tools'], tools: ['count_opens'] });
  });

  test("the agent's app_call reaches the app's tool after the user allows it", async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.__asked = [];
      dialog.showMessageBox = async (...a) => { const o = a.length > 1 ? a[1] : a[0]; globalThis.__asked.push(o.buttons[0]); return { response: 0 }; };
    });
    const text = await page.evaluate((id) => window.__bucksBrowserControl.execute('app_call', { id, tool: 'count_opens', input: { note: 'hi' } }), installed.id);
    expect(text).toContain('untrusted');
    expect(text).toContain('"opens":1,"echo":"hi"');
    expect(await app.evaluate(() => globalThis.__asked)).toEqual(['Allow']);
    // Asked once per app per session.
    await page.evaluate((id) => window.__bucksBrowserControl.execute('app_call', { id, tool: 'count_opens', input: {} }), installed.id);
    expect(await app.evaluate(() => globalThis.__asked)).toEqual(['Allow']);
    expect(await page.evaluate(() => window.__bucksBrowserControl.execute('app_list', {}))).toContain('E2E Notes');
  });

  test("storage is the app's own and survives reopening", async () => {
    await appWindow.close();
    const reopened = app.waitForEvent('window', { timeout: 20000 });
    await page.evaluate((id) => window.bucksApps.launch(id), installed.id);
    appWindow = await reopened;
    const second = await poll(() => readyState(appWindow), { label: 'the app reopened' });
    expect(second.opens).toBe(2);
    expect(await page.evaluate(() => localStorage.getItem('opens'))).toBeNull();
  });

  test('revoking a permission in the panel reloads the app without it', async () => {
    const panel = page.getByRole('dialog', { name: 'Installed apps' });
    await panel.getByRole('button', { name: 'Details of E2E Notes' }).click();
    await panel.getByRole('checkbox', { name: 'Show notifications' }).uncheck();
    await expect(panel.getByRole('status')).toContainText('turned off');
    const third = await poll(async () => { const s = await readyState(appWindow); return s && s.opens === 3 ? s : null; }, { label: 'the app reloaded' });
    expect(third.info.permissions).toEqual(['agent-tools']);
  });

  test('uninstall from the panel closes the app and removes it', async () => {
    const panel = page.getByRole('dialog', { name: 'Installed apps' });
    await panel.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await panel.getByRole('button', { name: 'Uninstall E2E Notes' }).click();
    await expect(panel.getByRole('status')).toHaveText('E2E Notes was uninstalled.');
    await poll(() => appWindow.isClosed(), { label: 'the app window closed' });
    expect(await page.evaluate(() => window.bucksApps.list())).toEqual([]);
    await expect(panel).toContainText('No apps yet.');
  });
});
