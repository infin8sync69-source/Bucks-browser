const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');

test.describe('Bucks E2E & Visual Regression Suite', () => {
  let electronApp;
  let page;

  test.beforeAll(async () => {
    // Launch Electron and await the shell window. In dev the app also opens
    // a DevTools window, so firstWindow() is racy — select by URL instead.
    electronApp = await electron.launch({ args: ['.'] });
    const deadline = Date.now() + 20000;
    for (;;) {
      page = electronApp.windows().find(w => w.url().includes('index.html'));
      if (page) break;
      if (Date.now() > deadline) throw new Error('Shell window (index.html) never appeared');
      await new Promise(r => setTimeout(r, 250));
    }
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  test('Smoke Test: App boot and persistent elements', async () => {
    expect(await page.title()).toBe('Bucks Browser');

    // Verify address bar is present and functional
    const addressBar = page.locator('#address-bar');
    await expect(addressBar).toBeVisible();

    // The agent chat panel is on-demand: it must exist in the DOM but stay
    // hidden until the user opens it from the omnibar / new-tab zone.
    const agentPanel = page.locator('#nav-chat-panel');
    await expect(agentPanel).toBeAttached();
    await expect(agentPanel).toBeHidden();
  });

  test('Visual Regression: omnibar chrome', async () => {
    // The chat panel is transient (docks in and out around chat turns), so
    // the persistent omnibar area is the stable regression target.
    const omnibar = page.locator('#url-search-wrap');
    await expect(omnibar).toBeVisible();
    await expect(omnibar).toHaveScreenshot('omnibar-chrome.png', {
      maxDiffPixelRatio: 0.05
    });
  });

  test('Spatial layout: page renders in the stage, clear of the agent dock', async () => {
    // Navigate via the global agent bar (URL input → tab navigation).
    await page.fill('#nt-search-input', 'https://example.com');
    await page.press('#nt-search-input', 'Enter');
    await page.waitForTimeout(3500);

    const shell = await page.evaluate(() => {
      const bar = document.getElementById('agentic-search-bar');
      return {
        webMode: document.body.classList.contains('web-mode'),
        barTop: bar ? bar.getBoundingClientRect().top : null,
        inner: [innerWidth, innerHeight],
      };
    });
    expect(shell.webMode).toBe(true);
    expect(shell.barTop).not.toBeNull();

    // The native WebContentsView must stop above the agent dock band — the
    // dock is shell DOM and a native view would otherwise paint over it.
    const views = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
      return win.contentView.children.map((v) => ({ bounds: v.getBounds(), visible: v.getVisible() }));
    });
    const active = views.find((v) => v.visible);
    expect(active).toBeTruthy();
    expect(active.bounds.y + active.bounds.height).toBeLessThanOrEqual(shell.barTop);
  });

  test('Performance Benchmarks: Memory Limits', async () => {
    // Pull main process memory usage statistics via the bucksAPI preload bridge
    const memory = await page.evaluate(async () => {
      if (window.bucksAPI && typeof window.bucksAPI.getMemoryUsage === 'function') {
        return await window.bucksAPI.getMemoryUsage();
      }
      return null;
    });

    if (memory) {
      const heapUsedMB = memory.heapUsed / (1024 * 1024);
      console.log(`[Performance Benchmark] Current JS Heap Used: ${heapUsedMB.toFixed(2)} MB`);

      // Verify process matches Idle State Budget (< 80MB)
      expect(heapUsedMB).toBeLessThan(80);
    } else {
      console.warn('[Performance Benchmark] process.memoryUsage was not retrieved.');
    }
  });
});
