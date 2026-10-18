import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/electron-loader.mjs', import.meta.url);
const { buildContextMenuTemplate, searchUrlFor, SEARCH_ENGINES } = await import('../../../src/main/context-menu.js');

const labels = (items) => items.map((i) => i.label || i.role || i.type);

function actionsRecorder() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    actions: {
      openInNewTab: rec('openInNewTab'), copyText: rec('copyText'), saveImage: rec('saveImage'), copyImage: rec('copyImage'),
      search: rec('search'), inspect: rec('inspect'), back: rec('back'), forward: rec('forward'), reload: rec('reload'),
      canGoBack: true, canGoForward: false,
    },
  };
}

test('searchUrlFor uses the chrome engine map and falls back to DuckDuckGo', () => {
  assert.equal(searchUrlFor('google', 'ipfs browser'), 'https://google.com/search?q=ipfs%20browser');
  assert.equal(searchUrlFor('brave', 'a&b'), 'https://search.brave.com/search?q=a%26b');
  assert.equal(searchUrlFor('nope', ' x '), 'https://duckduckgo.com/?q=x');
  assert.deepEqual(Object.keys(SEARCH_ENGINES), ['duckduckgo', 'google', 'brave', 'bing']);
});

test('plain page: navigation items + inspect', () => {
  const { actions, calls } = actionsRecorder();
  const items = buildContextMenuTemplate({ x: 1, y: 2, mediaType: 'none', linkURL: '', selectionText: '', isEditable: false }, actions);
  assert.deepEqual(labels(items), ['Back', 'Forward', 'Reload', 'separator', 'Inspect Element']);
  assert.equal(items[0].enabled, true);
  assert.equal(items[1].enabled, false);
  items[4].click();
  assert.deepEqual(calls, [['inspect', 1, 2]]);
});

test('link: open in new tab (open-request) and copy address', () => {
  const { actions, calls } = actionsRecorder();
  const items = buildContextMenuTemplate({ x: 0, y: 0, mediaType: 'none', linkURL: 'https://a/', selectionText: '', isEditable: false }, actions);
  assert.deepEqual(labels(items), ['Open Link in New Tab', 'Copy Link Address', 'separator', 'Inspect Element']);
  items[0].click();
  items[1].click();
  assert.deepEqual(calls, [['openInNewTab', 'https://a/'], ['copyText', 'https://a/']]);
});

test('image: save / copy', () => {
  const { actions, calls } = actionsRecorder();
  const items = buildContextMenuTemplate({ x: 0, y: 0, mediaType: 'image', srcURL: 'https://a/i.png', linkURL: '', selectionText: '', isEditable: false }, actions);
  assert.ok(labels(items).includes('Save Image As…'));
  items.find((i) => i.label === 'Save Image As…').click();
  items.find((i) => i.label === 'Copy Image').click();
  assert.deepEqual(calls, [['saveImage', 'https://a/i.png'], ['copyImage']]);
});

test('editable: edit roles honouring editFlags', () => {
  const { actions } = actionsRecorder();
  const items = buildContextMenuTemplate({ x: 0, y: 0, mediaType: 'none', linkURL: '', selectionText: '', isEditable: true, editFlags: { canUndo: false, canPaste: true } }, actions);
  const roles = items.filter((i) => i.role).map((i) => i.role);
  assert.deepEqual(roles, ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  assert.equal(items.find((i) => i.role === 'undo').enabled, false);
  assert.equal(items.find((i) => i.role === 'paste').enabled, true);
});

test('selection: copy + search with configured engine, label truncated', () => {
  const { actions, calls } = actionsRecorder();
  const long = 'this is a rather long selected sentence that will be truncated';
  const items = buildContextMenuTemplate({ x: 0, y: 0, mediaType: 'none', linkURL: '', selectionText: `  ${long}  `, isEditable: false }, actions, { engine: 'bing' });
  assert.equal(items[0].role, 'copy');
  const search = items.find((i) => /^Search Bing for/.test(i.label || ''));
  assert.ok(search, 'search item present');
  assert.ok(search.label.length < 60);
  assert.ok(search.label.endsWith('…”'));
  search.click();
  assert.deepEqual(calls, [['search', long]]);
  assert.equal(labels(items).includes('Back'), false, 'no nav items when there is a selection');
});
