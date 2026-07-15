const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');

test.describe('Bucks E2E & Visual Regression Suite', () => {
  let electronApp;
  let page;

  test.beforeAll(async () => {
    // Launch Electron and await the main window
    electronApp = await electron.launch({ args: ['.'] });
    page = await electronApp.firstWindow();
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  test('Smoke Test: App boot and persistent elements', async () => {
    expect(await page.title()).toBe('bucks');
    
    // Verify address bar is present and functional
    const addressBar = page.locator('#address-bar');
    await expect(addressBar).toBeVisible();
    
    // Verify persistent agent chat panel is present
    const agentPanel = page.locator('#nav-chat-panel');
    await expect(agentPanel).toBeVisible();
  });

  test('Visual Regression: Agent Panel states', async () => {
    const agentPanel = page.locator('#nav-chat-panel');
    await expect(agentPanel).toBeVisible();

    // 1. Verify default expanded state screenshot matches baseline
    await expect(agentPanel).toHaveScreenshot('agent-panel-expanded.png', {
      maxDiffPixelRatio: 0.05
    });

    // 2. Minimize state
    const minBtn = page.locator('#btn-nav-chat-minimize');
    if (await minBtn.isVisible()) {
      await minBtn.click();
      await page.waitForTimeout(600); // Wait for transition animation
      
      // Verify minimized bubble screenshot matches baseline
      await expect(agentPanel).toHaveScreenshot('agent-panel-minimized.png', {
        maxDiffPixelRatio: 0.05
      });
      
      // Restore panel
      await agentPanel.click();
      await page.waitForTimeout(600);
    }
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
