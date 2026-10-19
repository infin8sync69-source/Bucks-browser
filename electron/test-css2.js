const { _electron: electron } = require('playwright');
(async () => {
  const app = await electron.launch({ args: ['.'] });
  const page = await app.firstWindow();
  await page.waitForLoadState('networkidle');

  const result = await page.evaluate(() => {
    return Array.from(document.styleSheets).map(s => s.href);
  });
  
  console.log(JSON.stringify(result, null, 2));
  await app.close();
})();
