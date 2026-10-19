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
  
  appPage.on('pageerror', exception => {
    console.log(`Uncaught exception: "${exception}"`);
  });
  appPage.on('console', msg => {
    if (msg.type() === 'error') console.log(`Console error: "${msg.text()}"`);
  });

  await appPage.waitForLoadState('networkidle');
  await new Promise(r => setTimeout(r, 1000));
  
  await app.close();
})();
