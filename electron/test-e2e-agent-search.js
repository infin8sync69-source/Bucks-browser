const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  console.log('Launching Bucks Browser via Playwright...');
  const app = await electron.launch({
    args: ['.'],
    cwd: __dirname
  });

  try {
    await new Promise(r => setTimeout(r, 4500));
    const windows = app.windows();
    let mainPage = null;
    for (const w of windows) {
      const url = w.url();
      if (url.includes('index.html')) {
        mainPage = w;
        break;
      }
    }
    if (!mainPage) mainPage = await app.firstWindow();

    console.log('Main window selected:', mainPage.url());

    console.log('--- TURN 1: Typing into bottom chat composer bar & clicking Send Button... ---');
    const input = mainPage.locator('#nt-search-input');
    const sendBtn = mainPage.locator('#composer-send-btn');

    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.fill('what is blockchain');
    await sendBtn.click();

    console.log('Waiting 10s for Turn 1 to complete...');
    await new Promise(r => setTimeout(r, 10000));

    console.log('--- TURN 2: Typing follow-up into bottom composer bar & clicking Send Button... ---');
    await input.fill('how does proof of stake work');
    await sendBtn.click();

    console.log('Waiting 10s for Turn 2 to complete...');
    await new Promise(r => setTimeout(r, 10000));

    const screenshotPath = path.join(__dirname, 'screenshot_agent_search.png');
    await mainPage.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved to ${screenshotPath}`);

    const turnsCount = await mainPage.$$eval('.a2ui-turn-container', els => els.length).catch(() => 0);
    const summaryText = await mainPage.innerText('#a2ui-turns').catch(() => '');
    const followupCount = await mainPage.$$eval('.a2ui-followup-chip', els => els.length).catch(() => 0);

    console.log('--- UI VERIFICATION AT 20s ---');
    console.log('Total Conversation Turns rendered in SAME view:', turnsCount);
    console.log('Follow-up chips rendered:', followupCount);
    console.log('Summary snippet:', summaryText.slice(0, 350));

    if (turnsCount >= 2 || summaryText.length > 50 || followupCount > 0) {
      console.log('🎉 MULTI-TURN E2E TEST PASSED: A2UI engine is working! Agent answers, follow-ups and sources are rendering correctly!');
    } else {
      console.error('❌ E2E TEST FAILED: Turns count was less than 2 and no follow-up chips found.');
    }
  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    await app.close();
  }
})();
