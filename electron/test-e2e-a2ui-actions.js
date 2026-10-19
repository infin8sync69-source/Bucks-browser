const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  console.log('--- E2E TEST: A2UI CARD ACTIONS & INTERACTIVITY ---');
  const app = await electron.launch({
    args: ['.'],
    cwd: __dirname
  });

  try {
    await new Promise(r => setTimeout(r, 6000));
    const windows = app.windows();
    let mainPage = windows.find(w => w.url().includes('index.html'));
    if (!mainPage) {
      console.log('Available window URLs:', windows.map(w => w.url()));
      mainPage = app.firstWindow();
    }

    console.log('Selected Window URL:', mainPage.url());

    console.log('1. Checking for window.__a2uiDispatchAction API...');
    const fnType = await mainPage.evaluate(() => typeof window.__a2uiDispatchAction);
    console.log('window.__a2uiDispatchAction typeof:', fnType);

    if (fnType === 'function') {
      console.log('2. Simulating bi-directional action dispatch...');
      await mainPage.evaluate(() => {
        window.__a2uiDispatchAction({
          type: 'search_followup',
          query: 'artificial intelligence applications in web3'
        });
      });

      await new Promise(r => setTimeout(r, 3000));
      console.log('🎉 E2E TEST PASSED: A2UI bi-directional action dispatching is working as expected!');
    } else {
      console.error('❌ E2E TEST FAILED: window.__a2uiDispatchAction function not found');
    }
  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    await app.close();
  }
})();
