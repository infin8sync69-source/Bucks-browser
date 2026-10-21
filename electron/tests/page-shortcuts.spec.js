// Browser shortcuts must work while a web page has the keyboard (it lives in its own
// WebContentsView), not only when the shell UI is focused.
const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const http = require('http');

test.describe('Shortcuts from page content', () => {
  let server, app, page, base;

  const tabCount = () => page.evaluate(() => document.querySelectorAll('#tab-bar .tab, .tab-bar .tab, .tab').length);
  // Press a chord in the page's own web contents, the way a real keystroke arrives.
  const pressInPage = (keyCode, modifiers) => app.evaluate(({ webContents }, [kc, mods, origin]) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin));
    if (!wc) throw new Error('page web contents not found');
    wc.sendInputEvent({ type: 'keyDown', keyCode: kc, modifiers: mods });
  }, [keyCode, modifiers, base]);

  test.beforeAll(async () => {
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Page</title><input id="x">'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
    app = await electron.launch({ args: ['.'], env: { ...process.env, BUCKS_TESTING: '1' } });
    const deadline = Date.now() + 20000;
    for (;;) {
      page = app.windows().find((w) => w.url().includes('index.html'));
      if (page) break;
      if (Date.now() > deadline) throw new Error('Shell window never appeared');
      await new Promise((r) => setTimeout(r, 250));
    }
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
    await page.fill('#nt-search-input', base);
    await page.press('#nt-search-input', 'Enter');
    await page.waitForTimeout(3000);
  });

  test.afterAll(async () => {
    await app.close();
    server.close();
  });

  const MOD = process.platform === 'darwin' ? 'meta' : 'control';

  test('new tab, close tab and reopen closed tab work with the page focused', async () => {
    const before = await tabCount();
    await pressInPage('T', [MOD]);
    await page.waitForTimeout(800);
    expect(await tabCount()).toBe(before + 1);

    await pressInPage('W', [MOD]);
    await page.waitForTimeout(800);
    expect(await tabCount()).toBe(before);

    // Close the page tab, then bring it back.
    await pressInPage('W', [MOD]);
    await page.waitForTimeout(800);
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+T`);
    await page.waitForTimeout(1500);
    const urls = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));
    expect(urls.some((u) => u.startsWith(base))).toBe(true);
  });

  test('ordinary editing chords stay with the page', async () => {
    // Open the page again so there is page content to type into.
    await page.fill('#nt-search-input', base).catch(() => {});
    await page.press('#nt-search-input', 'Enter').catch(() => {});
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      window.__sawA = false;
      document.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'a') window.__sawA = true; });
    });
    await pressInPage('A', [MOD]);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.__sawA)).toBe(false);
  });
});
