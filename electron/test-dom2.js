const { _electron: electron } = require('playwright');
(async () => {
  const app = await electron.launch({ args: ['.'] });
  const page = await app.firstWindow();
  await page.waitForLoadState('networkidle');
  console.log("App loaded.");

  const result = await page.evaluate(() => {
    return {
      bodyPointerEvents: window.getComputedStyle(document.body).pointerEvents,
      htmlPointerEvents: window.getComputedStyle(document.documentElement).pointerEvents,
      bodyWidth: document.body.offsetWidth,
      bodyHeight: document.body.offsetHeight,
      htmlWidth: document.documentElement.offsetWidth,
      htmlHeight: document.documentElement.offsetHeight,
      topElementRaw: document.elementFromPoint(100, 100) ? document.elementFromPoint(100, 100).tagName : 'null'
    };
  });
  
  console.log(JSON.stringify(result, null, 2));
  await app.close();
})();
