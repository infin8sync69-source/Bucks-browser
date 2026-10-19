/* test-battlefield.js — Hardcore Battlefield Testing for Bucks Soul Engine & A2UI
   Executes 12 diverse prompts across 4 complexity levels against the live /agent SSE endpoint.
*/
const http = require('http');

const SOUL_ENGINE_URL = process.env.BUCKS_SOUL_URL || 'http://127.0.0.1:8765';

const PROMPTS = [
  { level: 1, name: 'Factual - Blockchain', prompt: 'what is blockchain' },
  { level: 1, name: 'Factual - IPFS', prompt: 'explain IPFS in simple terms' },
  { level: 1, name: 'Factual - Open Source', prompt: 'what does open source mean' },
  { level: 2, name: 'Conceptual - P2P vs Client-Server', prompt: 'how does a peer-to-peer network differ from a client-server model' },
  { level: 2, name: 'Intent - Weather', prompt: 'weather in Tokyo' },
  { level: 2, name: 'Intent - Images', prompt: 'show me images of Mars rover' },
  { level: 3, name: 'Deep Research - Quantum Computing', prompt: 'deep research on quantum computing breakthroughs 2026' },
  { level: 3, name: 'Comparison - Solana vs Ethereum', prompt: 'compare Solana vs Ethereum for high throughput microtransactions' },
  { level: 3, name: 'Product - Headphones', prompt: 'best wireless noise cancelling headphones under $200' },
  { level: 4, name: 'Intent - Videos', prompt: 'top YouTube videos on AI agents' },
  { level: 4, name: 'Complex - Decentralised App Arch', prompt: 'I am building a decentralised browser app. What architecture decisions should I prioritize?' },
  { level: 4, name: 'Security - BIP-39 Seed Phrase', prompt: 'risks of storing a BIP-39 seed phrase digitally and mitigations' },
];

function runSingleTest(testCase) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const payload = JSON.stringify({
      message: testCase.prompt,
      agentic: true
    });

    const url = new URL('/agent', SOUL_ENGINE_URL);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      }
    }, (res) => {
      let events = [];
      let tokenCount = 0;
      let uiComponents = [];
      let toolCalls = [];
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') break;

          try {
            const ev = JSON.parse(dataStr);
            events.push(ev);
            if (ev.type === 'token') tokenCount++;
            if (ev.type === 'ui_component') uiComponents.push(ev.component);
            if (ev.type === 'tool_call') toolCalls.push(ev.name);
          } catch (_) {}
        }
      });

      res.on('end', () => {
        const latencyMs = Date.now() - t0;
        const passed = res.statusCode === 200 && (tokenCount > 0 || uiComponents.length > 0);
        resolve({
          ...testCase,
          statusCode: res.statusCode,
          passed,
          latencyMs,
          tokenCount,
          uiComponents,
          toolCalls: Array.from(new Set(toolCalls)),
          eventCount: events.length
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        ...testCase,
        statusCode: 0,
        passed: false,
        latencyMs: Date.now() - t0,
        error: err.message
      });
    });

    req.setTimeout(60000, () => {
      req.destroy();
      resolve({
        ...testCase,
        statusCode: 408,
        passed: false,
        latencyMs: Date.now() - t0,
        error: 'Timeout (60s)'
      });
    });

    req.write(payload);
    req.end();
  });
}

async function runBattlefieldSuite() {
  console.log('========================================================================');
  console.log(' 🔥 BUCKS SOUL ENGINE & A2UI — HARDCORE BATTLEFIELD TEST SUITE 🔥');
  console.log('========================================================================\n');

  const results = [];
  let passedCount = 0;

  for (let i = 0; i < PROMPTS.length; i++) {
    const testCase = PROMPTS[i];
    process.stdout.write(`[${i + 1}/${PROMPTS.length}] Level ${testCase.level} | ${testCase.name} ... `);
    const result = await runSingleTest(testCase);
    results.push(result);

    if (result.passed) {
      passedCount++;
      console.log(`✅ PASS (${(result.latencyMs / 1000).toFixed(2)}s, tokens: ${result.tokenCount}, UI: [${result.uiComponents.join(', ')}], tools: [${result.toolCalls.join(', ')}])`);
    } else {
      console.log(`❌ FAIL (${result.error || 'Status ' + result.statusCode})`);
    }
  }

  console.log('\n========================================================================');
  console.log(` 📊 BATTLEFIELD RESULTS: ${passedCount}/${PROMPTS.length} PASSED (${Math.round((passedCount / PROMPTS.length) * 100)}%)`);
  console.log('========================================================================\n');

  console.table(results.map(r => ({
    Level: `L${r.level}`,
    Prompt: r.prompt.slice(0, 35),
    Status: r.passed ? 'PASSED' : 'FAILED',
    Latency: `${(r.latencyMs / 1000).toFixed(2)}s`,
    Tokens: r.tokenCount,
    UIComponents: r.uiComponents.join(', ') || 'none',
    Tools: r.toolCalls.join(', ') || 'none'
  })));
}

runBattlefieldSuite();
