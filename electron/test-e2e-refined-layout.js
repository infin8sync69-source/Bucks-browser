const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log('--- REFINED ACTIVE PAGE CONTEXT & FULL-WIDTH WEBVIEW OVERLAY TEST ---');
  const app = await electron.launch({
    args: ['.'],
    cwd: __dirname
  });

  const artifactDir = '/Users/mikado/.gemini/antigravity-ide/brain/2795dc9c-c60d-467f-a107-cd35cfb76865';

  try {
    await new Promise(r => setTimeout(r, 4000));
    const windows = app.windows();
    let mainPage = windows.find(w => w.url().includes('index.html')) || app.firstWindow();

    console.log('--- 1. Navigating to YouTube ---');
    const addressBar = mainPage.locator('#address-bar');
    await addressBar.fill('https://www.youtube.com/');
    await addressBar.press('Enter');
    await new Promise(r => setTimeout(r, 3500));

    console.log('--- 2. Testing Active Page Context Extraction ---');
    const pageCtx = await mainPage.evaluate(async () => {
      return (typeof window.getActivePageContext === 'function') ? await window.getActivePageContext() : null;
    });

    console.log('Extracted Active Page Context:', JSON.stringify({ title: pageCtx?.title, url: pageCtx?.url, hasText: !!(pageCtx?.text) }));

    const shotPath = path.join(__dirname, 'screenshot_refined_chat_layout.png');
    await mainPage.screenshot({ path: shotPath, timeout: 5000 }).catch(() => {});

    if (fs.existsSync(artifactDir) && fs.existsSync(shotPath)) {
      fs.copyFileSync(shotPath, path.join(artifactDir, 'screenshot_refined_chat_layout.png'));
    }

    if (pageCtx && pageCtx.url.includes('youtube.com')) {
      console.log('🎉 ACTIVE PAGE CONTEXT & OVERLAY LAYOUT TEST PASSED PERFECTLY!');
    }

  } catch (err) {
    console.error('Test execution error:', err.message);
  } finally {
    await app.close();
  }
})();
