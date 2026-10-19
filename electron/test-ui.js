const { _electron: electron } = require('playwright');
(async () => {
  const app = await electron.launch({ args: ['.'] });
  const page = await app.firstWindow();
  await page.waitForLoadState('networkidle');
  console.log("App loaded.");
  
  // Try to click theme toggle
  try {
    await page.click('#btn-theme-toggle', { timeout: 2000 });
    console.log("Clicked theme toggle.");
    const bodyClass = await page.evaluate(() => document.body.className);
    console.log("Body classes:", bodyClass);
  } catch (e) {
    console.log("Failed to click theme toggle:", e.message);
  }

  // Try to type in agentic interface
  try {
    await page.click('#nt-search-input', { timeout: 2000 });
    await page.fill('#nt-search-input', 'Hello');
    await page.press('#nt-search-input', 'Enter');
    console.log("Typed in agentic interface.");
  } catch (e) {
    console.log("Failed to use agentic interface:", e.message);
  }

  await app.close();
})();
