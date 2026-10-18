import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/electron-loader.mjs', import.meta.url);
const { buildMenuTemplate } = await import('../../../src/main/menu.js');

const CONTRACT_ACTIONS = new Set([
  'new-tab', 'close-tab', 'focus-omnibox', 'reload', 'back', 'forward', 'next-tab', 'prev-tab', 'find',
  'zoom-in', 'zoom-out', 'zoom-reset', 'toggle-devtools', 'open-settings', 'open-downloads', 'open-ipfs', 'open-wallet', 'toggle-agent',
]);

function flatten(template) {
  const out = [];
  const walk = (items) => {
    for (const i of items) {
      out.push(i);
      if (i.submenu) walk(i.submenu);
    }
  };
  walk(template);
  return out;
}

function fakeTabs(activeId = 'a') {
  const calls = [];
  return {
    calls,
    getActiveId: () => activeId,
    getActiveWebContents: () => null,
    zoomIn: (id) => calls.push(['zoomIn', id]),
    zoomOut: (id) => calls.push(['zoomOut', id]),
    zoomReset: (id) => calls.push(['zoomReset', id]),
  };
}

test('every accelerator emits a contract action (linux/windows)', () => {
  const emitted = [];
  const tabs = fakeTabs();
  const template = buildMenuTemplate({ platform: 'linux', emit: (a) => emitted.push(a), tabs, getMainWindow: () => null });
  const items = flatten(template);
  const byAccel = Object.fromEntries(items.filter((i) => i.accelerator).map((i) => [i.accelerator, i]));

  const expect = {
    'CmdOrCtrl+T': 'new-tab', 'CmdOrCtrl+W': 'close-tab', 'CmdOrCtrl+L': 'focus-omnibox', 'CmdOrCtrl+R': 'reload', F5: 'reload',
    'Alt+Left': 'back', 'Alt+Right': 'forward', 'Ctrl+Tab': 'next-tab', 'Ctrl+Shift+Tab': 'prev-tab', 'CmdOrCtrl+F': 'find',
    'CmdOrCtrl+=': 'zoom-in', 'CmdOrCtrl+-': 'zoom-out', 'CmdOrCtrl+0': 'zoom-reset', 'CmdOrCtrl+,': 'open-settings',
    'CmdOrCtrl+J': 'open-downloads', 'CmdOrCtrl+Shift+A': 'toggle-agent',
  };
  for (const [accel, action] of Object.entries(expect)) {
    assert.ok(byAccel[accel], `accelerator ${accel} present`);
    emitted.length = 0;
    byAccel[accel].click();
    assert.deepEqual(emitted, [action], accel);
    assert.ok(CONTRACT_ACTIONS.has(action));
  }
  assert.ok(byAccel.F12 && byAccel['CmdOrCtrl+Shift+I'], 'devtools accelerators present');
  assert.deepEqual(tabs.calls, [['zoomIn', 'a'], ['zoomOut', 'a'], ['zoomReset', 'a']], 'zoom applied to the active tab as well');
  assert.ok(items.some((i) => i.role === 'copy') && items.some((i) => i.role === 'paste'), 'edit roles');
  assert.ok(items.some((i) => i.role === 'quit'));
});

test('macOS layout: app menu, Cmd+[ / Cmd+] history', () => {
  const emitted = [];
  const template = buildMenuTemplate({ platform: 'darwin', emit: (a) => emitted.push(a), tabs: fakeTabs(null), getMainWindow: () => null, appName: 'Bucks Browser' });
  assert.equal(template[0].label, 'Bucks Browser');
  const roles = template[0].submenu.filter((i) => i.role).map((i) => i.role);
  assert.deepEqual(roles, ['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']);
  const items = flatten(template);
  assert.ok(items.some((i) => i.accelerator === 'Cmd+[' && (i.click(), emitted.at(-1) === 'back')));
  assert.ok(items.some((i) => i.accelerator === 'Cmd+]' && (i.click(), emitted.at(-1) === 'forward')));
  assert.ok(items.some((i) => i.role === 'pasteAndMatchStyle'));
});

test('devtools toggles the active tab, else the chrome window', () => {
  const opened = [];
  const wc = (name) => ({ isDestroyed: () => false, isDevToolsOpened: () => false, openDevTools: (o) => opened.push([name, o.mode]), closeDevTools: () => {} });
  const tabWc = wc('tab');
  let active = tabWc;
  const tabs = { ...fakeTabs('a'), getActiveWebContents: () => active };
  const template = buildMenuTemplate({ platform: 'linux', emit: () => {}, tabs, getMainWindow: () => ({ webContents: wc('chrome') }) });
  const dev = flatten(template).find((i) => i.accelerator === 'F12');
  dev.click();
  active = null;
  dev.click();
  assert.deepEqual(opened, [['tab', 'detach'], ['chrome', 'detach']]);
});
