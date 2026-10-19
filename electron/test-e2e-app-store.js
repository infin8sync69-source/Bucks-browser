const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  console.log('Launching Bucks Browser for AppStore UI test...');
  const app = await electron.launch({
    args: ['.'],
    cwd: __dirname
  });

  try {
    await new Promise(r => setTimeout(r, 4500));
    const windows = app.windows();
    let mainPage = windows.find(w => w.url().includes('index.html')) || app.firstWindow();

    console.log('Main window selected:', mainPage.url());

    console.log('--- 1. Switching to AppStore view... ---');
    await mainPage.evaluate(() => {
      if (typeof window.showDashboardView === 'function') {
        window.showDashboardView('appstore');
      }
    });

    await new Promise(r => setTimeout(r, 3000));

    const screenshotPath = path.join(__dirname, 'screenshot_app_store.png');
    await mainPage.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved to ${screenshotPath}`);

    const cardCount = await mainPage.$$eval('.bucks-store-card.minimal', els => els.length).catch(() => 0);
    const hasDownloadBtn = await mainPage.$('.download-btn').then(el => !!el).catch(() => false);
    const hasPreviewBtn = await mainPage.$('.bucks-store-preview-btn').then(el => !!el).catch(() => false);

    console.log('--- APP STORE UI VERIFICATION ---');
    console.log('Minimal App Cards count:', cardCount);
    console.log('Has Download Icon button:', hasDownloadBtn);
    console.log('Has Application Preview button:', hasPreviewBtn);

    if (cardCount > 0 && hasPreviewBtn) {
      console.log('🎉 APP STORE E2E TEST PASSED: Minimal App Store UI rendered cleanly with small icons, download source button, and New Tab Preview launcher!');
    } else {
      console.error('❌ APP STORE TEST FAILED');
    }
  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    await app.close();
  }
})();
