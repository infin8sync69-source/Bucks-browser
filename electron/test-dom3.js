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

  console.log("App loaded.");
  const result = await appPage.evaluate(() => {
    return {
      bodyPointerEvents: window.getComputedStyle(document.body).pointerEvents,
      topElementRaw: document.elementFromPoint(100, 100) ? document.elementFromPoint(100, 100).className : 'null'
    };
  });
  console.log(JSON.stringify(result, null, 2));

  // Try to click theme toggle
  try {
    await appPage.click('#btn-theme-toggle', { timeout: 2000 });
    console.log("Clicked theme toggle.");
  } catch (e) {
    console.log("Failed to click theme toggle:", e.message);
  }

  await app.close();
})();
