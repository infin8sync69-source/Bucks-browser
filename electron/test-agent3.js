const { _electron: electron } = require('playwright');
(async () => {
  const app = await electron.launch({ args: ['.'] });
  
  app.on('window', async (page) => {
    page.on('pageerror', exception => {
      console.log(`Uncaught exception: "${exception}"`);
    });
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`Console error: "${msg.text()}"`);
    });
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('networkidle');
  await new Promise(r => setTimeout(r, 1000));
  
  await app.close();
})();
