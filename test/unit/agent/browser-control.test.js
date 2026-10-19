import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createBrowserControl, formatSnapshot, agentUrl, describeAction, STATE_CHANGING, REMOTE_TOOLS, TAB_TOOLS,
} from '../../../src/main/agent/browser-control.js';

const SNAP = { url: 'https://shop.test/', title: 'Shop', scrollY: 0, scrollHeight: 2000, elements: [
  { ref: 0, role: 'a', type: '', name: 'Pricing', href: 'https://shop.test/pricing' },
  { ref: 1, role: 'input', type: 'search', name: 'Search', href: '' },
] };

/** A stand-in for a tab's WebContents that records what was run in it. */
function fakeWebContents() {
  const wc = new EventEmitter();
  wc.calls = [];
  wc.isDestroyed = () => false;
  wc.getTitle = () => 'Shop';
  wc.executeJavaScriptInIsolatedWorld = async (world, [{ code }], gesture) => {
    wc.calls.push({ world, gesture, code });
    if (code.includes('data-bucks-ref]')) return SNAP; // the snapshot script
    if (code.includes('data-bucks-ref="99"')) return { ok: false, error: 'No element [99] on the page any more. Read the page again.' };
    if (code.includes('data-bucks-ref=')) return { ok: true };
    return undefined;
  };
  wc.insertText = async (t) => wc.calls.push({ insertText: t });
  wc.capturePage = async () => ({ getSize: () => ({ width: 2560 }), resize: ({ width }) => ({ toPNG: () => Buffer.from(`png-${width}`) }) });
  wc.printToPDF = async () => Buffer.from('%PDF-');
  return wc;
}

function setup() {
  const wc = fakeWebContents();
  const navigated = [];
  const files = [];
  const tabs = {
    getWebContents: (id) => (id === 't1' ? wc : null),
    navigate: (id, url) => { navigated.push([id, url]); setTimeout(() => wc.emit('did-stop-loading'), 5); },
  };
  const docs = {
    create: async ({ title, format }) => ({ path: `/Docs/Bucks/${title}.${format}` }),
    savePdf: async (title) => ({ path: `/Docs/Bucks/${title}.pdf` }),
  };
  const control = createBrowserControl({ tabs, docs, wait: async () => {} });
  const run = (name, args = {}, ctx = {}) => control.execute(name, args, { tabId: 't1', tabTools: true, onFile: (f) => files.push(f), ...ctx });
  return { wc, navigated, files, run };
}

test('tool sets: what changes the page needs approval; everything here is run by the browser', () => {
  assert.deepEqual([...STATE_CHANGING].sort(), ['browser_click', 'browser_navigate', 'browser_type', 'pane_close', 'pane_open']);
  for (const t of TAB_TOOLS) assert.ok(REMOTE_TOOLS.has(t));
  assert.ok(REMOTE_TOOLS.has('create_pdf'));
  assert.ok(!REMOTE_TOOLS.has('cluster_pin'), 'engine-side tools are not run here');
});

test('formatSnapshot and agentUrl', () => {
  assert.equal(formatSnapshot(SNAP), [
    'URL: https://shop.test/', 'Title: Shop', 'Scroll: 0/2000', 'Interactive elements:',
    '[0] a: Pricing → https://shop.test/pricing', '[1] input(search): Search',
  ].join('\n'));
  assert.equal(formatSnapshot(null), 'No page loaded.');
  assert.equal(agentUrl('example.com/a'), 'https://example.com/a');
  assert.equal(agentUrl('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'), 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'bucks://settings', 'data:text/html,x', '']) {
    assert.throws(() => agentUrl(bad), /may only open|needs a url|Not a valid/);
  }
  assert.equal(describeAction('browser_type', { ref: 2, text: 'hello' }), 'Type "hello" into [2]');
  assert.equal(describeAction('browser_navigate', { url: 'https://a.b' }), 'Open https://a.b');
});

test('read, click, type, scroll run in an isolated world; clicks and typing count as user input', async () => {
  const { wc, run } = setup();
  assert.match(await run('browser_read_page'), /\[1\] input\(search\): Search/);
  assert.equal(wc.calls[0].world, 1017);

  const click = await run('browser_click', { ref: 0 });
  assert.match(click, /^Clicked \[0\]\.\n\nURL: https:\/\/shop\.test\//);
  const clickCall = wc.calls.find((c) => c.code?.includes('el.click()'));
  assert.equal(clickCall.gesture, true);
  assert.match(clickCall.code, /data-bucks-ref="0"/);

  assert.equal(await run('browser_click', { ref: 99 }), 'Click failed: No element [99] on the page any more. Read the page again.');
  assert.equal(await run('browser_click', { ref: '0"]); alert(1); //' }), 'browser_click needs the [ref] number of an element from browser_read_page.', 'refs are numbers, never code');

  assert.equal(await run('browser_type', { ref: 1, text: 'kubo' }), 'Typed into [1].');
  assert.deepEqual(wc.calls.at(-1), { insertText: 'kubo' }, 'typed as real text input');

  assert.match(await run('browser_scroll', { direction: 'up' }), /^URL:/);
  assert.match(wc.calls.find((c) => c.code?.startsWith('scrollBy')).code, /-1 \*/);
});

test('navigate waits for the load; bad URLs are refused as text for the model', async () => {
  const { navigated, run } = setup();
  assert.match(await run('browser_navigate', { url: 'shop.test/pricing' }), /^Opened https:\/\/shop\.test\/pricing\n\nURL:/);
  assert.deepEqual(navigated, [['t1', 'https://shop.test/pricing']]);
  assert.equal(await run('browser_navigate', { url: 'file:///etc/passwd' }), 'Tool error: The agent may only open http, https, ipfs and ipns addresses, not file:');
  assert.equal(navigated.length, 1);
});

test('tab tools need permission for this request and a web tab; panes are explained', async () => {
  const { run } = setup();
  assert.match(await run('browser_read_page', {}, { tabTools: false }), /not enabled for this request/);
  assert.match(await run('browser_read_page', {}, { tabId: null }), /Tool error: No web page is open/);
  assert.match(await run('pane_open', { url: 'https://a.b' }), /no split panes yet/);
  assert.equal(await run('rm_rf'), 'Unknown browser tool: rm_rf');
});

test('screenshots are scaled; documents are written and reported', async () => {
  const { files, run } = setup();
  const shot = await run('browser_screenshot');
  assert.equal(Buffer.from(shot.screenshot_b64, 'base64').toString(), 'png-1280');
  assert.equal(shot.media_type, 'image/png');
  assert.equal(await run('create_pdf', { title: 'Report', content: '# R' }, { tabTools: false }), 'PDF report saved to /Docs/Bucks/Report.pdf', 'documents do not need the tab');
  assert.equal(await run('create_document', { title: 'Notes', content: 'x', format: 'exe' }), 'Document saved to /Docs/Bucks/Notes.md');
  assert.equal(await run('page_to_pdf'), 'Page saved as PDF: /Docs/Bucks/Shop.pdf');
  assert.deepEqual(files, ['/Docs/Bucks/Report.pdf', '/Docs/Bucks/Notes.md', '/Docs/Bucks/Shop.pdf']);
});
