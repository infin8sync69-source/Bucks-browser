const { _electron: electron } = require('playwright');
const path = require('path');
(async () => {
  const electronAppPath = path.join(__dirname, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const app = await electron.launch({ executablePath: electronAppPath, args: ['.'] });
  const page = await app.firstWindow();
  await page.waitForLoadState('networkidle');
  console.log("App loaded.");
  
  try {
    await page.click('#nt-search-input', { timeout: 2000 });
    await page.fill('#nt-search-input', 'Hello Soul Engine');
    await page.press('#nt-search-input', 'Enter');
    console.log("Typed in agentic interface.");
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log("Failed to use agentic interface:", e.message);
  }

  await page.screenshot({ path: '../screenshot_a2ui.png' });
  await app.close();
})();
