'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequestFilter, decideRequest, isLocalHost } = require('../../security/request-filter');
const { registrableDomain, isThirdParty, stripSetCookie } = require('../../security/cookies');

const run = (fn, details) => new Promise((resolve) => fn(details, resolve));

test('isLocalHost: loopback, private ranges and intranet names stay on http', () => {
  for (const h of ['localhost', 'a.localhost', 'printer.local', '127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.9', '169.254.1.1', '[::1]', 'intranet']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', 'localhost.evil.com']) {
    assert.equal(isLocalHost(h), false, h);
  }
});

test('decideRequest: https-only upgrades remote http, not local or allowed hosts', () => {
  const state = { httpsOnly: true, isHttpAllowed: (h) => h === 'oldsite.org' };
  assert.deepEqual(decideRequest({ url: 'http://example.com/a?x=1' }, state), { redirectURL: 'https://example.com/a?x=1' });
  assert.deepEqual(decideRequest({ url: 'http://192.168.1.5/' }, state), {});
  assert.deepEqual(decideRequest({ url: 'http://oldsite.org/' }, state), {});
  // The old check was url.includes('localhost'); a remote URL merely containing it must still upgrade.
  assert.deepEqual(decideRequest({ url: 'http://evil.com/?r=localhost' }, state), { redirectURL: 'https://evil.com/?r=localhost' });
  assert.deepEqual(decideRequest({ url: 'http://example.com/' }, { ...state, httpsOnly: false }), {});
});

test('registrableDomain / isThirdParty', () => {
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
  assert.equal(isThirdParty('https://cdn.example.com/x', 'https://www.example.com/'), false);
  assert.equal(isThirdParty('https://tracker.net/x', 'https://www.example.com/'), true);
  assert.equal(isThirdParty('https://tracker.net/x', ''), false);
});

test('stripSetCookie removes cookie headers case-insensitively', () => {
  const { headers, removed } = stripSetCookie({ 'Set-Cookie': ['a=1', 'b=2'], 'set-cookie2': 'c', 'Content-Type': ['text/html'] });
  assert.equal(removed, 3);
  assert.deepEqual(headers, { 'Content-Type': ['text/html'] });
});

test('filter: https upgrade is counted and remembered; fallback allows http', async () => {
  const f = createRequestFilter();
  f.applySettings({ httpsOnly: true });
  const res = await run(f.handleBeforeRequest, { url: 'http://site.test.example/', resourceType: 'mainFrame' });
  assert.equal(res.redirectURL, 'https://site.test.example/');
  assert.equal(f.stats().httpsUpgrades, 1);
  assert.equal(f.wasUpgraded('site.test.example'), true);
  f.allowHttpHost('site.test.example');
  assert.deepEqual(await run(f.handleBeforeRequest, { url: 'http://site.test.example/', resourceType: 'mainFrame' }), {});
});

test('filter: ad patterns block subresources, never the top-level page, and respect the toggle', async () => {
  const f = createRequestFilter({ adPatterns: [/^https?:\/\/.*\.doubleclick\.net\/.*$/i] });
  f.applySettings({ adBlockEnabled: true });
  assert.deepEqual(await run(f.handleBeforeRequest, { url: 'https://ad.doubleclick.net/x', resourceType: 'script' }), { cancel: true });
  assert.deepEqual(await run(f.handleBeforeRequest, { url: 'https://ad.doubleclick.net/x', resourceType: 'mainFrame' }), {});
  assert.equal(f.stats().blockedRequests, 1);
  f.applySettings({ adBlockEnabled: false });
  assert.deepEqual(await run(f.handleBeforeRequest, { url: 'https://ad.doubleclick.net/x', resourceType: 'script' }), {});
});

test('filter: cookie policy', async () => {
  const keys = async (policy, url, resourceType, top) => {
    const f = createRequestFilter();
    f.applySettings({ cookiePolicy: policy });
    const res = await run(f.handleHeadersReceived, {
      url, resourceType, responseHeaders: { 'Set-Cookie': ['id=1'], 'X-A': ['b'] }, frame: { top: { url: top } },
    });
    return Object.keys(res.responseHeaders);
  };
  assert.deepEqual(await keys('allow', 'https://t.net/p', 'image', 'https://site.com/'), ['Set-Cookie', 'X-A']);
  assert.deepEqual(await keys('block-third-party', 'https://t.net/p', 'image', 'https://site.com/'), ['X-A']);
  assert.deepEqual(await keys('block-third-party', 'https://www.site.com/p', 'image', 'https://site.com/'), ['Set-Cookie', 'X-A']);
  assert.deepEqual(await keys('block-third-party', 'https://t.net/', 'mainFrame', 'https://site.com/'), ['Set-Cookie', 'X-A']);
  assert.deepEqual(await keys('block-all', 'https://site.com/', 'mainFrame', 'https://site.com/'), ['X-A']);
  assert.deepEqual(await keys('block-all', 'file:///app/index.html', 'mainFrame', ''), ['Set-Cookie', 'X-A']);
});

test('filter: headers are chained to the shell CSP hook after cookie stripping', async () => {
  let seen;
  const f = createRequestFilter({ chainHeadersReceived: (d, cb) => { seen = d; cb({ responseHeaders: { chained: ['1'] } }); } });
  f.applySettings({ cookiePolicy: 'block-all' });
  const res = await run(f.handleHeadersReceived, { url: 'https://a.com/', resourceType: 'mainFrame', responseHeaders: { 'Set-Cookie': ['x'] } });
  assert.deepEqual(seen.responseHeaders, {});
  assert.deepEqual(res, { responseHeaders: { chained: ['1'] } });
});

test('filter: a loaded engine decides blocking; patterns are only the fallback', async () => {
  const f = createRequestFilter({ adPatterns: [/^https:\/\/pattern\.example\/.*$/] });
  f.applySettings({ adBlockEnabled: true });
  assert.equal(f.stats().adBlockReady, false);
  const engine = {
    onBeforeRequest: (d, cb) => cb(d.url.includes('engine-blocked') ? { cancel: true } : {}),
    onHeadersReceived: (d, cb) => cb({ responseHeaders: { ...d.responseHeaders, 'x-engine': ['1'] } }),
  };
  f.setBlocker(engine, 'prebuilt');
  assert.equal(f.stats().adBlockReady, true);
  assert.deepEqual(await run(f.handleBeforeRequest, { url: 'https://x.example/engine-blocked.js', resourceType: 'script' }), { cancel: true });
  assert.deepEqual(await run(f.handleBeforeRequest, { url: 'https://pattern.example/a.js', resourceType: 'script' }), {});
  assert.deepEqual(await run(f.handleBeforeRequest, { url: 'https://x.example/engine-blocked.js', resourceType: 'mainFrame' }), {});
  assert.deepEqual(await run(f.handleBeforeRequest, { url: 'ipfs://bafy/engine-blocked.js', resourceType: 'script' }), {});
  assert.equal(f.stats().blockedRequests, 1);
  const res = await run(f.handleHeadersReceived, { url: 'https://x.example/', resourceType: 'mainFrame', responseHeaders: { a: ['1'] } });
  assert.deepEqual(res.responseHeaders, { a: ['1'], 'x-engine': ['1'] });
  f.setBlocker(null);
  assert.deepEqual(await run(f.handleBeforeRequest, { url: 'https://pattern.example/a.js', resourceType: 'script' }), { cancel: true });
});

test('engine loader: installs the engine, loads once, retries on the built-in list', async () => {
  const { createEngineLoader } = require('../../security/engine');
  const f = createRequestFilter();
  let calls = 0;
  const loader = createEngineLoader({
    filter: f, userData: '/x', retryMs: 20,
    loadBlockerImpl: async () => { calls++; return { blocker: { n: calls }, source: calls === 1 ? 'builtin' : 'prebuilt' }; },
  });
  loader.ensure(); loader.ensure();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1);
  assert.equal(f.engineSource(), 'builtin');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 2);
  assert.equal(f.engineSource(), 'prebuilt');
  loader.ensure();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2);
  loader.dispose();
});
