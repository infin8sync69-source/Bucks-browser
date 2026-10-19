const { _electron: electron } = require('playwright');
(async () => {
  const app = await electron.launch({ args: ['.'] });
  const page = await app.firstWindow();
  await page.waitForLoadState('networkidle');
  console.log("App loaded. Checking overlapping elements...");

  const result = await page.evaluate(() => {
    // 1. Get element at top bar (center, 20px from top)
    const topEl = document.elementFromPoint(window.innerWidth / 2, 20);
    // 2. Get element at bottom search bar (center, 30px from bottom)
    const botEl = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 30);
    
    // 3. Find any element that covers the whole screen
    const overlays = Array.from(document.querySelectorAll('*')).filter(el => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= window.innerWidth && rect.height >= window.innerHeight;
    }).map(el => el.id || el.className || el.tagName);

    return {
      topElement: topEl ? (topEl.id || topEl.className || topEl.tagName) : 'none',
      botElement: botEl ? (botEl.id || botEl.className || botEl.tagName) : 'none',
      fullscreenOverlays: overlays
    };
  });
  
  console.log(JSON.stringify(result, null, 2));
  await app.close();
})();
