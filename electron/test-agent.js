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

  console.log("App loaded. Invoking agent...");
  try {
    const result = await appPage.evaluate(async () => {
      let output = [];
      await window.runAgenticTask('Summarize the theory of relativity in one sentence.', (ev) => {
        output.push(ev);
      }, "No context");
      return output;
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.log("Agent failed:", e.message);
  }

  await app.close();
})();
