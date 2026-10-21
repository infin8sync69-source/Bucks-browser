import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('../main/helpers/electron-loader.mjs', import.meta.url);
const { isLocalHost, decideRequest, blockerApplies, isThirdPartyResponse, createFilterController } = await import('../../../src/main/security/filter.js');
const { loadBlocker, BUILTIN_FILTER_LIST } = await import('../../../src/main/security/blocklist.js');

const state = (over = {}) => ({ httpsOnly: true, isHttpAllowed: () => false, ...over });
const req = (url, extra = {}) => ({ url, resourceType: 'script', ...extra });

test('isLocalHost', () => {
  for (const h of ['localhost', 'foo.localhost', '127.0.0.1', '127.5.5.5', '[::1]', 'printer.local', '10.1.2.3', '192.168.0.9',
    '172.16.0.1', '172.31.255.255', '169.254.1.1', '[fd12:3456::1]', '[fe80::1]', 'intranet']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1', 'localhost.example.com', '', '[2001:db8::1]']) {
    assert.equal(isLocalHost(h), false, h);
  }
});

test('decideRequest upgrades remote http to https and keeps path/query/port', () => {
  assert.deepEqual(decideRequest(req('http://example.com/x?y=1#z'), state()), { redirectURL: 'https://example.com/x?y=1#z' });
  assert.deepEqual(decideRequest(req('http://example.com:8080/'), state()), { redirectURL: 'https://example.com:8080/' });
});

test('decideRequest passes local hosts, allow-listed hosts, https, and httpsOnly=false', () => {
  assert.deepEqual(decideRequest(req('http://localhost:1234'), state()), {});
  assert.deepEqual(decideRequest(req('http://192.168.1.5/admin'), state()), {});
  assert.deepEqual(decideRequest(req('http://example.com/'), state({ isHttpAllowed: (h) => h === 'example.com' })), {});
  assert.deepEqual(decideRequest(req('https://example.com/'), state()), {});
  assert.deepEqual(decideRequest(req('http://example.com/'), state({ httpsOnly: false })), {});
  assert.deepEqual(decideRequest(req('not a url'), state()), {});
});

test('decideRequest hard-blocks bucks:// from web content but not from the chrome', () => {
  assert.deepEqual(decideRequest(req('bucks://app/'), state()), { cancel: true });
  const web = { webContents: { getURL: () => 'https://evil.example/' } };
  assert.deepEqual(decideRequest(req('bucks://app/', web), state()), { cancel: true });
  const chrome = { webContents: { getURL: () => 'bucks://app/settings' } };
  assert.deepEqual(decideRequest(req('bucks://wallet', chrome), state()), {});
});

test('blockerApplies skips mainFrame and non-web schemes', () => {
  assert.equal(blockerApplies(req('https://ads.example/x.js')), true);
  assert.equal(blockerApplies(req('wss://x.example/')), true);
  assert.equal(blockerApplies(req('https://example.com/', { resourceType: 'mainFrame' })), false);
  for (const u of ['bucks://app/', 'ipfs://bafy/x', 'ipns://x/y', 'file:///etc/hosts', 'devtools://devtools/bundled/x.js', 'data:text/plain,hi']) {
    assert.equal(blockerApplies(req(u)), false, u);
  }
});

test('isThirdPartyResponse uses top frame, then webContents, then referrer', () => {
  assert.equal(isThirdPartyResponse({ url: 'https://t.net/p', resourceType: 'image', frame: { top: { url: 'https://example.com/' } } }), true);
  assert.equal(isThirdPartyResponse({ url: 'https://cdn.example.com/a', resourceType: 'image', webContents: { getURL: () => 'https://example.com/' } }), false);
  assert.equal(isThirdPartyResponse({ url: 'https://t.net/p', resourceType: 'xhr', referrer: 'https://example.com/page' }), true);
  assert.equal(isThirdPartyResponse({ url: 'https://t.net/p', resourceType: 'mainFrame', referrer: 'https://example.com/' }), false);
  assert.equal(isThirdPartyResponse({ url: 'https://t.net/p', resourceType: 'xhr' }), false);
  const dead = { get url() { throw new Error('destroyed'); } };
  assert.equal(isThirdPartyResponse({ url: 'https://t.net/p', resourceType: 'xhr', frame: dead, referrer: 'https://example.com/' }), true);
});

// ---- built-in list ---------------------------------------------------------------------------

async function builtinBlocker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-sec-'));
  const failingFetch = async () => { throw new Error('offline'); };
  const res = await loadBlocker({ userData: dir, fetchImpl: failingFetch, timeoutMs: 2000 });
  return { dir, ...res };
}

test('loadBlocker falls back to the built-in list when offline', async () => {
  const { dir, blocker, source } = await builtinBlocker();
  try {
    assert.equal(source, 'builtin');
    assert.ok(BUILTIN_FILTER_LIST.split('\n').length > 60);
    const run = (url, referrer = 'https://news.example/') => new Promise((resolve) =>
      blocker.onBeforeRequest({ id: 1, url, resourceType: 'script', referrer, method: 'GET' }, resolve));
    assert.deepEqual(await run('https://stats.g.doubleclick.net/j.js'), { cancel: true });
    assert.deepEqual(await run('https://connect.facebook.net/en_US/fbevents.js'), { cancel: true });
    assert.deepEqual(await run('https://ads.somesite.org/banner.js'), { cancel: true });
    assert.deepEqual(await run('https://www.google-analytics.com/analytics.js'), { cancel: true });
    assert.deepEqual(await run('https://news.example/app.js'), {});
    assert.deepEqual(await run('https://cdn.example.org/lib.js'), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadBlocker caches a fetched engine on disk and reuses it offline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-sec-'));
  try {
    const okFetch = async (url) => ({ ok: true, status: 200, text: async () => (String(url).endsWith('.json') ? '{}' : '||unique-ad-host.test^\n'), json: async () => ({}) });
    const first = await loadBlocker({ userData: dir, fetchImpl: okFetch, timeoutMs: 5000 });
    assert.equal(first.source, 'prebuilt');
    assert.ok(fs.existsSync(path.join(dir, 'adblock-engine.bin')));
    const offline = await loadBlocker({ userData: dir, fetchImpl: async () => { throw new Error('offline'); }, timeoutMs: 2000 });
    assert.equal(offline.source, 'prebuilt', 'fresh cache is used without the network');
    const blocked = await new Promise((resolve) => offline.blocker.onBeforeRequest(
      { id: 1, url: 'https://unique-ad-host.test/a.js', resourceType: 'script', referrer: 'https://p.example/', method: 'GET' }, resolve));
    assert.deepEqual(blocked, { cancel: true });
    // stale cache beats the built-in list
    const stale = await loadBlocker({ userData: dir, fetchImpl: async () => { throw new Error('offline'); }, timeoutMs: 2000, maxAgeMs: -1 });
    assert.equal(stale.source, 'stale-cache');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadBlocker times out a hanging fetch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-sec-'));
  try {
    const hang = (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const t0 = Date.now();
    const res = await loadBlocker({ userData: dir, fetchImpl: hang, timeoutMs: 150 });
    assert.equal(res.source, 'builtin');
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- controller -------------------------------------------------------------------------------

function fakeSession() {
  const s = { before: null, headers: null };
  s.webRequest = {
    onBeforeRequest: (filter, fn) => { s.before = { filter, fn }; },
    onHeadersReceived: (filter, fn) => { s.headers = { filter, fn }; },
  };
  return s;
}
const call = (fn, details) => new Promise((resolve) => fn(details, resolve));
const settingsWith = (sec) => ({ security: { httpsOnly: true, adBlock: true, trackerBlock: true, blockThirdPartyCookies: true, ...sec } });
const tick = () => new Promise((r) => setTimeout(r, 20));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached');
    await tick();
  }
}

async function makeController(sec = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-sec-'));
  const loads = [];
  const ctl = createFilterController({
    settings: settingsWith(sec),
    userData: dir,
    loadBlockerImpl: async (opts) => {
      loads.push(opts);
      const { blocker } = await loadBlocker({ userData: dir, fetchImpl: async () => { throw new Error('offline'); }, timeoutMs: 1000 });
      return { blocker, source: 'builtin' };
    },
    retryMs: 3_600_000,
  });
  const ses = fakeSession();
  ctl.attach(ses);
  await until(() => ctl.stats().adBlockReady);
  return { ctl, ses, loads, cleanup: () => { ctl.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('controller installs exactly one listener of each kind and filters through it', async () => {
  const { ctl, ses, cleanup } = await makeController();
  try {
    assert.ok(ses.before && ses.headers);
    assert.deepEqual(ses.before.filter, { urls: ['<all_urls>'] });
    assert.equal(ctl.stats().adBlockReady, true);

    assert.deepEqual(await call(ses.before.fn, req('http://example.com/x')), { redirectURL: 'https://example.com/x' });
    assert.deepEqual(await call(ses.before.fn, req('http://localhost:1234/')), {});
    assert.deepEqual(await call(ses.before.fn, req('https://ad.doubleclick.net/x.js', { referrer: 'https://news.example/' })), { cancel: true });
    assert.deepEqual(await call(ses.before.fn, req('https://doubleclick.net/', { resourceType: 'mainFrame' })), {});
    assert.deepEqual(await call(ses.before.fn, req('ipfs://bafy/ad.js')), {});
    assert.deepEqual(await call(ses.before.fn, req('bucks://app/')), { cancel: true });
    assert.deepEqual(ctl.stats(), { blockedRequests: 1, httpsUpgrades: 1, adBlockReady: true });
  } finally { cleanup(); }
});

test('allowHttpHost stops the upgrade for that host only', async () => {
  const { ctl, ses, cleanup } = await makeController();
  try {
    ctl.allowHttpHost('Old-Site.example');
    assert.equal(ctl.isHttpAllowed('old-site.example'), true);
    assert.deepEqual(await call(ses.before.fn, req('http://old-site.example/')), {});
    assert.deepEqual(await call(ses.before.fn, req('http://other.example/')), { redirectURL: 'https://other.example/' });
  } finally { cleanup(); }
});

test('settings apply live: httpsOnly and blocking toggle without reinstalling', async () => {
  const { ctl, ses, loads, cleanup } = await makeController();
  try {
    ctl.applySettings(settingsWith({ httpsOnly: false }));
    assert.deepEqual(await call(ses.before.fn, req('http://example.com/')), {});
    ctl.applySettings(settingsWith({ adBlock: false, trackerBlock: false }));
    assert.deepEqual(await call(ses.before.fn, req('https://ad.doubleclick.net/x.js', { referrer: 'https://news.example/' })), {});
    assert.equal(ctl.stats().adBlockReady, false);
    ctl.applySettings(settingsWith({ adBlock: true, trackerBlock: false }));
    await until(() => ctl.stats().adBlockReady && loads.length === 2);
    await tick();
    assert.equal(loads.at(-1).trackerBlock, false, 'ads-only engine requested');
    assert.deepEqual(await call(ses.before.fn, req('https://ad.doubleclick.net/x.js', { referrer: 'https://news.example/' })), { cancel: true });
  } finally { cleanup(); }
});

test('headers: third-party Set-Cookie dropped, first-party kept, setting honoured', async () => {
  const { ctl, ses, cleanup } = await makeController();
  try {
    const headers = () => ({ 'Set-Cookie': ['id=1'], 'Content-Type': ['image/gif'] });
    const third = { url: 'https://tracker.net/p.gif', resourceType: 'image', referrer: 'https://example.com/', responseHeaders: headers() };
    const out = await call(ses.headers.fn, third);
    assert.deepEqual(out, { responseHeaders: { 'Content-Type': ['image/gif'] } });

    const first = { url: 'https://cdn.example.com/p.gif', resourceType: 'image', referrer: 'https://example.com/', responseHeaders: headers() };
    assert.deepEqual(await call(ses.headers.fn, first), {});

    const main = { url: 'https://tracker.net/', resourceType: 'mainFrame', referrer: 'https://example.com/', responseHeaders: headers() };
    assert.deepEqual(await call(ses.headers.fn, main), {});

    ctl.applySettings(settingsWith({ blockThirdPartyCookies: false }));
    assert.deepEqual(await call(ses.headers.fn, { ...third, responseHeaders: headers() }), {});
  } finally { cleanup(); }
});

test('handlers never throw or hang on malformed details', async () => {
  const { ses, cleanup } = await makeController();
  try {
    assert.deepEqual(await call(ses.before.fn, {}), {});
    assert.deepEqual(await call(ses.headers.fn, {}), {});
  } finally { cleanup(); }
});

test('decideRequest: web pages cannot call the IPFS node directly; a typed navigation can', async () => {
  const { isNodeAddress } = await import('../../../src/main/security/filter.js');
  const nodes = ['http://127.0.0.1:45001', 'http://127.0.0.1:45002'];
  const s = { ...state(), nodeUrls: () => nodes };
  const sub = (url) => ({ url, resourceType: 'xhr' });
  assert.deepEqual(decideRequest(sub('http://127.0.0.1:45002/ipfs/bafyx'), s), { cancel: true });
  assert.deepEqual(decideRequest(sub('http://127.0.0.1:45001/api/v0/id'), s), { cancel: true });
  assert.deepEqual(decideRequest(sub('http://localhost:45002/ipfs/bafyx'), s), { cancel: true });
  assert.deepEqual(decideRequest(sub('http://bafyx.ipfs.localhost:45002/'), s), { cancel: true });
  assert.deepEqual(decideRequest({ url: 'http://127.0.0.1:45001/webui', resourceType: 'mainFrame' }, s), {});
  assert.deepEqual(decideRequest(sub('http://127.0.0.1:3000/'), s), {}, 'other local ports are fine');
  assert.deepEqual(decideRequest(sub('http://127.0.0.1:45002/'), { ...state(), nodeUrls: () => [null, null] }), {}, 'node not running');
  assert.equal(isNodeAddress(new URL('https://example.com:45002/'), nodes), false);
  assert.equal(isNodeAddress(new URL('ipfs://bafyx/'), nodes), false);
});
