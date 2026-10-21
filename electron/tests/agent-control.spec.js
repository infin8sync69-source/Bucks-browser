// The agent's hands, end to end: browser_* tools run on a real WebContentsView tab in an
// isolated world, and state-changing tools are refused unless the user approved them.
const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const http = require('http');

const PAGE = `<!doctype html><title>Agent fixture</title>
<button id="buy" onclick="document.title='clicked'">Buy now</button>
<input id="q" placeholder="Search">
<script>
  // A hostile page: tries to read anything the agent leaves behind, and to lie about the DOM.
  window.__pageSawAgent = () => typeof window.__agentSecret !== 'undefined';
  Element.prototype.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 });
</script>`;

test.describe('Agent browser control', () => {
  let server, app, page, base;

  test.beforeAll(async () => {
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
    app = await electron.launch({ args: ['.'], env: { ...process.env, BUCKS_TESTING: '1' } });
    const deadline = Date.now() + 20000;
    for (;;) {
      page = app.windows().find((w) => w.url().includes('index.html'));
      if (page) break;
      if (Date.now() > deadline) throw new Error('Shell window never appeared');
      await new Promise((r) => setTimeout(r, 250));
    }
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
    // A real tab hosted by tab-manager, bound as the agent's active view.
    await page.evaluate(async (url) => {
      await window.bucksTabs.create('agent-e2e', url, undefined);
      window.__agentView = { tabViewId: 'agent-e2e', executeAgentJavaScript: (c, g) => window.bucksTabs.execAgentJS('agent-e2e', c, g) };
      window.__bucksBrowserControl.bind(() => window.__agentView);
    }, base);
    await page.waitForTimeout(1500);
  });

  test.afterAll(async () => {
    await app.close();
    server.close();
  });

  test('requiresApproval covers click, type and navigate', async () => {
    const r = await page.evaluate(() => ['browser_click', 'browser_type', 'browser_navigate', 'browser_read_page', 'browser_scroll']
      .map((n) => window.__bucksBrowserControl.requiresApproval(n)));
    expect(r).toEqual([true, true, true, false, false]);
  });

  test('reads the page and clicks a ref', async () => {
    const snap = await page.evaluate(() => window.__bucksBrowserControl.execute('browser_read_page', {}));
    expect(String(snap)).toContain('Buy now');
    const ref = /\[(\d+)\][^\n]*Buy now/.exec(String(snap))?.[1];
    expect(ref).toBeDefined();
    const out = await page.evaluate((r) => window.__bucksBrowserControl.execute('browser_click', { ref: Number(r) }), ref);
    expect(String(out)).toContain('Clicked');
    const title = await page.evaluate(() => window.bucksTabs.execJS('agent-e2e', 'document.title', false));
    expect(title).toBe('clicked');
  });

  test('agent scripts run in an isolated world the page cannot see', async () => {
    await page.evaluate(() => window.bucksTabs.execAgentJS('agent-e2e', 'window.__agentSecret = 42; 1', false));
    // Same DOM, different JS world: the page's own context never sees the agent's variable...
    const seen = await page.evaluate(() => window.bucksTabs.execJS('agent-e2e', 'window.__pageSawAgent()', false));
    expect(seen).toBe(false);
    // ...and the agent is not fooled by the page's patched prototypes.
    const w = await page.evaluate(() => window.bucksTabs.execAgentJS('agent-e2e', 'document.getElementById("buy").getBoundingClientRect().width > 0', false));
    expect(w).toBe(true);
  });
});
