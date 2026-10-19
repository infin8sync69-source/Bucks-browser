const { _electron: electron } = require('playwright');
(async () => {
  const app = await electron.launch({ args: ['.'] });
  const page = await app.firstWindow();
  await page.waitForLoadState('networkidle');

  const result = await page.evaluate(() => {
    return {
      styleSheetsCount: document.styleSheets.length,
      hasStylesCss: Array.from(document.styleSheets).some(s => s.href && s.href.includes('styles.css'))
    };
  });
  
  console.log(JSON.stringify(result, null, 2));
  await app.close();
})();
