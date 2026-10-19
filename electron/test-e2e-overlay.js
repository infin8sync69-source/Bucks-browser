const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  console.log('Launching Bucks Browser for A2UI Floating Overlay test...');
  const app = await electron.launch({
    args: ['.'],
    cwd: __dirname
  });

  try {
    await new Promise(r => setTimeout(r, 4500));
    const windows = app.windows();
    let mainPage = windows.find(w => w.url().includes('index.html')) || app.firstWindow();

    console.log('Main window selected:', mainPage.url());

    console.log('--- 1. Navigating to website wikipedia.org... ---');
    await mainPage.evaluate(() => {
      const activeTabId = window.activeTabId;
      if (typeof window.navigateTab === 'function') {
        window.navigateTab(activeTabId, 'https://en.wikipedia.org/wiki/Artificial_intelligence');
      }
    });

    await new Promise(r => setTimeout(r, 4000));

    console.log('--- 2. Submitting search prompt in bottom composer bar while on website... ---');
    const input = mainPage.locator('#nt-search-input');
    const sendBtn = mainPage.locator('#composer-send-btn');

    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill('what is artificial intelligence');
    await sendBtn.click();

    console.log('Waiting 10s for A2UI Floating Glass Overlay to render on top of website...');
    await new Promise(r => setTimeout(r, 10000));

    const screenshotPath = path.join(__dirname, 'screenshot_agent_overlay.png');
    await mainPage.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved to ${screenshotPath}`);

    const overlayVisible = await mainPage.isVisible('#a2ui-floating-overlay');
    const overlayText = await mainPage.innerText('#a2ui-floating-overlay').catch(() => '');

    console.log('--- A2UI FLOATING OVERLAY VERIFICATION ---');
    console.log('Overlay visible on top of website:', overlayVisible);
    console.log('Overlay snippet:', overlayText.slice(0, 300));

    if (overlayVisible && overlayText.length > 30) {
      console.log('🎉 A2UI FLOATING OVERLAY TEST PASSED: Generative UI card renders directly ON TOP of active open website tabs!');
    } else {
      console.error('❌ A2UI OVERLAY TEST FAILED');
    }
  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    await app.close();
  }
})();
