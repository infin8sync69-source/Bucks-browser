const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log('--- STARTING MULTIPLE COMPLEX PROMPT E2E TEST ---');
  const app = await electron.launch({
    args: ['.'],
    cwd: __dirname
  });

  const artifactDir = '/Users/mikado/.gemini/antigravity-ide/brain/2795dc9c-c60d-467f-a107-cd35cfb76865';

  try {
    await new Promise(r => setTimeout(r, 4500));
    const windows = app.windows();
    let mainPage = windows.find(w => w.url().includes('index.html')) || app.firstWindow();

    console.log('Main window selected:', mainPage.url());

    const input = mainPage.locator('#nt-search-input');
    const sendBtn = mainPage.locator('#composer-send-btn');

    // ─── PROMPT 1: Deep Quantum Computing Research ───
    console.log('--- EXECUTING COMPLEX PROMPT 1: Quantum Computing Breakthroughs ---');
    const prompt1 = 'Research quantum computing breakthroughs in 2026 and compare topological vs superconducting qubits with key papers, sources, and video guides';
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.fill(prompt1);
    await sendBtn.click();

    console.log('Waiting 12s for Prompt 1 processing...');
    await new Promise(r => setTimeout(r, 12000));

    const shot1Path = path.join(__dirname, 'screenshot_complex_prompt1.png');
    await mainPage.screenshot({ path: shot1Path });
    console.log(`Screenshot 1 saved to ${shot1Path}`);
    if (fs.existsSync(artifactDir)) {
      fs.copyFileSync(shot1Path, path.join(artifactDir, 'screenshot_complex_prompt1.png'));
    }

    // ─── PROMPT 2: Web3 Layer-2 Infrastructure Synthesis ───
    console.log('--- EXECUTING COMPLEX PROMPT 2: Web3 L2 Scaling Synthesis ---');
    const prompt2 = 'Analyze top Ethereum Layer-2 scaling solutions (Arbitrum, Optimism, ZKsync, Base) comparing TPS, transaction fees, finality latency, and security architecture';
    await input.fill(prompt2);
    await sendBtn.click();

    console.log('Waiting 12s for Prompt 2 processing...');
    await new Promise(r => setTimeout(r, 12000));

    const shot2Path = path.join(__dirname, 'screenshot_complex_prompt2.png');
    await mainPage.screenshot({ path: shot2Path });
    console.log(`Screenshot 2 saved to ${shot2Path}`);
    if (fs.existsSync(artifactDir)) {
      fs.copyFileSync(shot2Path, path.join(artifactDir, 'screenshot_complex_prompt2.png'));
    }

    // ─── PROMPT 3: Generative Floating Overlay on Active Website ───
    console.log('--- EXECUTING COMPLEX PROMPT 3: Floating Overlay on Active Website ---');
    await mainPage.evaluate(() => {
      const activeTabId = window.activeTabId;
      if (typeof window.navigateTab === 'function') {
        window.navigateTab(activeTabId, 'https://en.wikipedia.org/wiki/Artificial_intelligence');
      }
    });

    await new Promise(r => setTimeout(r, 4000));

    const prompt3 = 'Summarize key milestones of Artificial Intelligence and extract top sources and structured takeaways';
    await input.fill(prompt3);
    await sendBtn.click();

    console.log('Waiting 12s for Overlay Prompt 3 processing...');
    await new Promise(r => setTimeout(r, 12000));

    const shot3Path = path.join(__dirname, 'screenshot_complex_prompt3_overlay.png');
    await mainPage.screenshot({ path: shot3Path });
    console.log(`Screenshot 3 saved to ${shot3Path}`);
    if (fs.existsSync(artifactDir)) {
      fs.copyFileSync(shot3Path, path.join(artifactDir, 'screenshot_complex_prompt3_overlay.png'));
    }

    console.log('🎉 ALL COMPLEX PROMPT TESTS EXECUTED AND SCREENSHOTS CAPTURED SUCCESSFULLY!');

  } catch (err) {
    console.error('Test execution error:', err.message);
  } finally {
    await app.close();
  }
})();
