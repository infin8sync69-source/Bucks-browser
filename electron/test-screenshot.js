const { _electron: electron } = require('playwright');
(async () => {
  const app = await electron.launch({ args: ['.'] });
  let appPage = null;
  while (!appPage) {
    for (const p of app.windows()) {
      if (p.url().includes('index.html')) {
        appPage = p;
        break;
      }
    }
    if (!appPage) await new Promise(r => setTimeout(r, 500));
  }
  await appPage.waitForLoadState('networkidle');
  await new Promise(r => setTimeout(r, 2000));
  
  await appPage.screenshot({ path: 'screenshot.png' });
  console.log("Screenshot saved to screenshot.png");

  await app.close();
})();
