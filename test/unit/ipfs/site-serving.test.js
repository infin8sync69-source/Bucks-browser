import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  looksLikeHtml, shouldServeFallback, fallbackCacheControl, guardContentLength, peekBody, rootFromHeaders, canBeDirectory, isSafeRequestPath,
} from '../../../src/main/protocols/site-serving.js';
import { validatePublicGateway, readConsentParam, consentUrl, createConsent } from '../../../src/main/protocols/gateway-consent.js';
import { createIpfsHandler } from '../../../src/main/protocols/ipfs.js';
import { buildDescriptor } from '../../../src/main/sites/package.js';

const enc = (s) => new TextEncoder().encode(s);
const streamOf = (...chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc(x)); c.close(); } });

test('looksLikeHtml follows the browser sniffing signatures', () => {
  for (const yes of ['<!DOCTYPE html><html>', '  \n<html lang=en>', '﻿<!doctype html>', '<head>', '<script>x</script>', '<div id=app>', '<p>hi', '<!-- c -->', '<body>']) {
    assert.equal(looksLikeHtml(enc(yes)), true, yes);
  }
  for (const no of ['{"a":1}', 'plain text', '<abbr>', '<svg xmlns="http://www.w3.org/2000/svg">', '', '<?xml version="1.0"?>', 'PK\u0003\u0004']) {
    assert.equal(looksLikeHtml(enc(no)), false, no);
  }
});

test('shouldServeFallback only for GET page navigations without extension on SPA sites', () => {
  const spa = buildDescriptor({ manifestText: '{"spa":true}' });
  const ok = { method: 'GET', accept: 'text/html,application/xhtml+xml', pathname: '/deep/link', descriptor: spa };
  assert.equal(shouldServeFallback(ok), true);
  assert.equal(shouldServeFallback({ ...ok, method: 'HEAD' }), false);
  assert.equal(shouldServeFallback({ ...ok, accept: '*/*' }), false);
  assert.equal(shouldServeFallback({ ...ok, pathname: '/assets/missing.js' }), false);
  assert.equal(shouldServeFallback({ ...ok, descriptor: buildDescriptor({}) }), false);
  assert.equal(fallbackCacheControl('ipfs'), 'public, max-age=31536000, immutable');
  assert.equal(fallbackCacheControl('ipns'), 'no-store');
});

test('guardContentLength errors a short body instead of ending it quietly', async () => {
  assert.equal(await new Response(guardContentLength(streamOf('hello'), 5)).text(), 'hello');
  await assert.rejects(new Response(guardContentLength(streamOf('hel'), 5)).text(), /truncated: 3 of 5 bytes/);
  await assert.rejects(new Response(guardContentLength(streamOf('hello!'), 5)).text(), /longer than/);
  const s = streamOf('x');
  assert.equal(guardContentLength(s, null), s, 'unknown length: untouched');
});

test('peekBody returns the first bytes and replays them', async () => {
  const { head, body } = await peekBody(streamOf('<!doc', 'type html>', 'rest of the page'), 8);
  assert.equal(new TextDecoder().decode(head), '<!doctype html>');
  assert.equal(await new Response(body).text(), '<!doctype html>rest of the page');
  const short = await peekBody(streamOf('ab'), 512);
  assert.equal(new TextDecoder().decode(short.head), 'ab');
  assert.equal(await new Response(short.body).text(), 'ab');
});

test('isSafeRequestPath refuses anything that could leave the requested root on the gateway', () => {
  for (const ok of ['/', '/a/b.html', '/a%20b/c', '/.well-known/x', '/a..b/', '/%E2%9C%93.html']) assert.equal(isSafeRequestPath(ok), true, ok);
  for (const bad of ['/%2e%2e/x', '/..%2Fb', '/a/%2F', '/a%5Cb', '/%00', '/%E0%A4%A', '/./x', '/../x']) assert.equal(isSafeRequestPath(bad), false, bad);
});

test('an encoded "../" never makes one site serve another CID on its origin', async (t) => {
  const gw = await siteGateway(t, { [ROOT]: SPA, [ROOT2]: { 'evil.html': '<!doctype html>EVIL' } }, { names: { [NAME]: ROOT } });
  const handler = createIpfsHandler({ kubo: kuboAt(gw.base), settings });
  for (const url of [`ipfs://${ROOT}/..%2F${ROOT2}/evil.html`, `ipfs://${ROOT}/%2e%2e%2F${ROOT2}/evil.html`, `ipns://${NAME}/..%2F..%2Fipfs%2F${ROOT2}/evil.html`]) {
    const res = await handler(nav(url));
    assert.equal(res.status, 400, url);
    assert.match(await res.text(), /tries to leave the site/);
  }
  assert.equal(gw.seen.length, 0, 'nothing reached the gateway');
});

test('canBeDirectory: only dag-pb roots are looked up for a descriptor', () => {
  assert.equal(canBeDirectory('bafybeia323rffnezepk522uc4nq3qa6fsxhaxeqsaebnik2xlql54ovjh4'), true);
  assert.equal(canBeDirectory('bafkreie335bg43sw4q5iawiaqkajqffkcakku3ncn4ofcptzimlknywsp4'), false, 'raw leaf');
  assert.equal(canBeDirectory('not a cid'), false);
});

test('rootFromHeaders, validatePublicGateway, consent parameters and nonces', () => {
  assert.equal(rootFromHeaders(new Headers({ 'x-ipfs-roots': 'bafyroot1234567890abcdef,bafkfile' })), 'bafyroot1234567890abcdef');
  assert.equal(rootFromHeaders(new Headers()), null);

  assert.deepEqual(validatePublicGateway('https://ipfs.io/'), { ok: true, base: 'https://ipfs.io' });
  assert.deepEqual(validatePublicGateway('https://dweb.link/ipfs/'), { ok: true, base: 'https://dweb.link' });
  for (const bad of ['http://ipfs.io', 'https://localhost:8080', 'https://127.0.0.1', 'https://192.168.0.2', 'https://10.1.2.3', 'https://[::1]', 'https://gateway', 'https://box.local', 'https://u:p@ipfs.io', 'nonsense', '']) {
    assert.equal(validatePublicGateway(bad).ok, false, bad);
  }

  assert.equal(readConsentParam('?a=1'), null);
  assert.deepEqual(readConsentParam('?a=1&bucks-gateway=once.abc'), { action: 'once', nonce: 'abc', search: '?a=1' });
  assert.deepEqual(readConsentParam('?bucks-gateway=start.xyz'), { action: 'start', nonce: 'xyz', search: '' });
  assert.equal(consentUrl('ipfs://c/p?a=1#frag', 'once', 'n'), 'ipfs://c/p?a=1&bucks-gateway=once.n');
  assert.equal(consentUrl('ipfs://c/p', 'start', 'n'), 'ipfs://c/p?bucks-gateway=start.n');

  let t = 0;
  const c = createConsent({ now: () => t });
  const n = c.issue('ipfs://a');
  assert.equal(c.take(n, 'ipfs://b'), false, 'bound to its origin');
  const n2 = c.issue('ipfs://a');
  t = 11 * 60_000;
  assert.equal(c.take(n2, 'ipfs://a'), false, 'expires');
  const n3 = c.issue('ipfs://a');
  assert.equal(c.take(n3, 'ipfs://a'), true);
  assert.equal(c.take(n3, 'ipfs://a'), false, 'one use');
});

/* ---------- a whole site behind a fake path gateway ---------- */

const ROOT = 'bafybeia323rffnezepk522uc4nq3qa6fsxhaxeqsaebnik2xlql54ovjh4';
const ROOT2 = 'bafybeiclkf7tluijj56h7kw45fxecafcklg3c7ngsawhttj46kb4xzzdyu';
const NAME = 'k51qzi5uqu5dkgrl13wuej153wszejcgpn7dvd2hdh6oj7fmwcnjpay3zgg8pq';
const TYPES = { html: 'text/html', js: 'text/javascript; charset=utf-8', json: 'application/json', css: 'text/css' };

async function siteGateway(t, sites, { names = {}, truncate = null, csp = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, accept: req.headers.accept });
    const m = /^\/(ipfs|ipns)\/([^/]+)(\/[^?]*)?/.exec(req.url);
    let root = m && (m[1] === 'ipns' ? names[m[2]] : m[2]);
    const files = root && sites[root];
    if (!files) { res.writeHead(504); res.end(); return; }
    let p = decodeURIComponent((m[3] || '/').slice(1));
    if (p === '' || p.endsWith('/')) p += 'index.html';
    const body = files[p];
    if (body === undefined) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no link'); return; }
    const ext = /\.([a-z]+)$/.exec(p)?.[1];
    const headers = { 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'public, max-age=29030400, immutable', 'x-ipfs-roots': root };
    if (csp) headers['content-security-policy'] = csp;
    res.writeHead(200, headers);
    if (truncate === p) { res.flushHeaders(); res.write(body.slice(0, 3)); setTimeout(() => res.destroy(), 30); return; }
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

const kuboAt = (gateway) => ({ isReady: () => true, gatewayUrl: () => gateway, status: () => ({ state: 'ready', message: 'ready' }), rpc: null });
const settings = { get: () => ({ ipfs: { publicGateway: 'https://ipfs.io', preferredGateway: 'local' } }) };
const nav = (url, extra = {}) => new Request(url, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, ...extra });

const SPA = {
  'index.html': '<!doctype html><div id=app></div><script type=module src="/assets/app.js"></script>',
  'assets/app.js': 'console.log(1)',
  'bucks-site.json': JSON.stringify({ spa: true, headers: { '/*': { 'X-Site': 'yes', 'Set-Cookie': 'no=1' } }, csp: "default-src 'self'" }),
  'deep': '<!doctype html><p>an extensionless page</p>',
  'data': '{"not":"html"}',
};

test('SPA fallback: deep links render the entry (F1), missing assets stay 404, HEAD and non-HTML requests do not fall back', async (t) => {
  const gw = await siteGateway(t, { [ROOT]: SPA });
  const handler = createIpfsHandler({ kubo: kuboAt(gw.base), settings });

  const deep = await handler(nav(`ipfs://${ROOT}/deep/link`));
  assert.equal(deep.status, 200);
  assert.equal(deep.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(deep.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(deep.headers.get('x-site'), 'yes');
  assert.equal(deep.headers.get('set-cookie'), null);
  assert.equal(deep.headers.get('content-security-policy'), "default-src 'self'");
  assert.equal(deep.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await deep.text(), SPA['index.html']);

  const asset = await handler(nav(`ipfs://${ROOT}/assets/missing.js`));
  assert.equal(asset.status, 404);
  assert.match(await asset.text(), /This page does not exist in this site/);
  assert.equal((await handler(new Request(`ipfs://${ROOT}/deep/link`, { headers: { accept: 'application/json' } }))).status, 404);
  assert.equal((await handler(nav(`ipfs://${ROOT}/deep/link`, { method: 'HEAD' }))).status, 404);

  // the manifest was read once for this root, however many requests came in
  assert.equal(gw.seen.filter((r) => r.url.endsWith('/bucks-site.json')).length, 1);
});

test('content-type repair: an extensionless file served as octet-stream that is HTML becomes text/html', async (t) => {
  const gw = await siteGateway(t, { [ROOT]: SPA });
  const handler = createIpfsHandler({ kubo: kuboAt(gw.base), settings });
  const page = await handler(nav(`ipfs://${ROOT}/deep`));
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await page.text(), SPA.deep);
  const data = await handler(nav(`ipfs://${ROOT}/data`));
  assert.equal(data.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await data.text(), SPA.data);
  const js = await handler(nav(`ipfs://${ROOT}/assets/app.js`));
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('a body cut off before its Content-Length is an error, not a silently truncated 200', async (t) => {
  const gw = await siteGateway(t, { [ROOT]: { 'index.html': 'x', 'big.bin': 'abcdefghij' } }, { truncate: 'big.bin' });
  const handler = createIpfsHandler({ kubo: kuboAt(gw.base), settings });
  const res = await handler(new Request(`ipfs://${ROOT}/big.bin`));
  assert.equal(res.status, 200);
  await assert.rejects(res.text());
});

test('_redirects: rewrites, redirects, custom 404, and the /* rule as SPA mode; forced rules ignored', async (t) => {
  const gw = await siteGateway(t, { [ROOT]: {
    'index.html': '<!doctype html>home',
    'posts/hello.html': '<!doctype html>hello post',
    '404.html': '<!doctype html>custom not found',
    _redirects: '/old /new-place 301\n/blog/:slug /posts/:slug.html 200\n/ext https://example.com/x 302\n/gone /404.html 404\n/forced /index.html 200!\n/* /index.html 200\n',
  } });
  const handler = createIpfsHandler({ kubo: kuboAt(gw.base), settings });
  const moved = await handler(nav(`ipfs://${ROOT}/old`));
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get('location'), `ipfs://${ROOT}/new-place`);
  assert.equal((await handler(nav(`ipfs://${ROOT}/ext`))).headers.get('location'), 'https://example.com/x');
  const rewritten = await handler(nav(`ipfs://${ROOT}/blog/hello`));
  assert.equal(rewritten.status, 200);
  assert.equal(await rewritten.text(), '<!doctype html>hello post');
  const gone = await handler(nav(`ipfs://${ROOT}/gone`));
  assert.equal(gone.status, 404);
  assert.equal(await gone.text(), '<!doctype html>custom not found');
  const spa = await handler(nav(`ipfs://${ROOT}/forced`));
  assert.equal(spa.status, 200, 'the forced rule is ignored; the /* rule (SPA mode) answers');
  assert.equal(await spa.text(), '<!doctype html>home');
  assert.equal((await handler(nav(`ipfs://${ROOT}/missing.png`))).status, 404);
});

test('manifest notFound and entry; neither changes plain sites', async (t) => {
  const gw = await siteGateway(t, {
    [ROOT]: { 'app.html': '<!doctype html>the app', 'index.html': 'old index', 'oops.html': '<!doctype html>oops', 'bucks-site.json': '{"entry":"app.html","notFound":"oops.html"}' },
    [ROOT2]: { 'index.html': 'plain' },
  });
  const handler = createIpfsHandler({ kubo: kuboAt(gw.base), settings });
  const home = await handler(nav(`ipfs://${ROOT}/`));
  assert.equal(await home.text(), '<!doctype html>the app');
  const missing = await handler(nav(`ipfs://${ROOT}/nope`));
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), '<!doctype html>oops');
  assert.equal(await (await handler(nav(`ipfs://${ROOT2}/`))).text(), 'plain');
  assert.equal((await handler(nav(`ipfs://${ROOT2}/deep/link`))).status, 404, 'no descriptor: no fallback');
});

test('ipns:// serves the fallback from the version the name points to now, right after an update', async (t) => {
  const names = { [NAME]: ROOT };
  const gw = await siteGateway(t, { [ROOT]: SPA, [ROOT2]: { ...SPA, 'index.html': '<!doctype html>version 2' } }, { names });
  const handler = createIpfsHandler({ kubo: kuboAt(gw.base), settings });
  const deep = await handler(nav(`ipns://${NAME}/deep/link`));
  assert.equal(deep.status, 200);
  assert.equal(deep.headers.get('cache-control'), 'no-store');
  assert.equal(await deep.text(), SPA['index.html']);
  assert.deepEqual(handler.badgeFor(`ipns://${NAME}/x`), { kind: 'signed-name', label: 'Signed name, updates allowed', cid: ROOT });

  names[NAME] = ROOT2; // the publisher updated the site; the very next navigation must see it
  const after = await handler(nav(`ipns://${NAME}/other/route`));
  assert.equal(await after.text(), '<!doctype html>version 2');
  assert.equal(handler.badgeFor(`ipns://${NAME}/`).cid, ROOT2);
  // nothing on a name is cached (Chromium would reuse old scripts after an update)
  const asset = await handler(nav(`ipns://${NAME}/assets/app.js`));
  assert.equal(asset.headers.get('cache-control'), 'no-store');
  assert.equal((await handler(nav(`ipfs://${ROOT2}/assets/app.js`))).headers.get('cache-control'), 'public, max-age=29030400, immutable', 'ipfs:// stays immutable');
});

test('a name this browser published is served from its new version at once, even while the gateway still resolves the old one', async (t) => {
  const names = { [NAME]: ROOT }; // the gateway's (stale) view of the name
  const gw = await siteGateway(t, { [ROOT]: SPA, [ROOT2]: { ...SPA, 'index.html': '<!doctype html>version 2', 'docs/index.html': 'docs' } }, { names });
  const handler = createIpfsHandler({ kubo: kuboAt(gw.base), settings });
  handler.setNameTarget(NAME.toUpperCase(), ROOT2);
  assert.equal(await (await handler(nav(`ipns://${NAME}/`))).text(), '<!doctype html>version 2');
  assert.equal(await (await handler(nav(`ipns://${NAME}/deep/link`))).text(), '<!doctype html>version 2');
  assert.equal(handler.badgeFor(`ipns://${NAME}/`).cid, ROOT2);
  assert.ok(!gw.seen.some((r) => r.url.startsWith(`/ipns/${NAME}`)), 'the stale name was never asked for');
  handler.setNameTarget(NAME, null);
  assert.equal(await (await handler(nav(`ipns://${NAME}/`))).text(), SPA['index.html'], 'forgotten: back to the gateway');
});

test('CSP from a public gateway is never forwarded; from the local node it is', async (t) => {
  const gw = await siteGateway(t, { [ROOT]: { 'index.html': '<!doctype html>x' } }, { csp: "script-src 'none'" });
  const local = createIpfsHandler({ kubo: kuboAt(gw.base), settings });
  assert.equal((await local(nav(`ipfs://${ROOT}/`))).headers.get('content-security-policy'), "script-src 'none'");
  const pub = createIpfsHandler({
    kubo: kuboAt(gw.base),
    settings: { get: () => ({ ipfs: { publicGateway: gw.base, preferredGateway: 'public' } }) },
    gatewayValidator: (u) => ({ ok: true, base: u }),
  });
  const res = await pub(nav(`ipfs://${ROOT}/`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), null);
  assert.equal(pub.badgeFor(`ipfs://${ROOT}/`).kind, 'unverified');
});

test('badges: nothing before a page was served, preview marks win', async (t) => {
  const gw = await siteGateway(t, { [ROOT]: { 'index.html': 'x' } });
  const handler = createIpfsHandler({ kubo: kuboAt(gw.base), settings });
  assert.equal(handler.badgeFor(`ipfs://${ROOT}/`), null);
  assert.equal(handler.badgeFor('https://example.com/'), null);
  handler.setPreview(ROOT);
  assert.deepEqual(handler.badgeFor(`ipfs://${ROOT}/a`), { kind: 'preview', label: 'Preview, not published' });
  handler.setPreview(ROOT, false);
  await (await handler(nav(`ipfs://${ROOT}/`))).text();
  assert.equal(handler.badgeFor(`ipfs://${ROOT}/`).kind, 'content-addressed');
  assert.equal(handler.badgeFor('ipns://en.wikipedia-on-ipfs.org/'), null);
});

test('offline ipns name: the newest record found is shown', async (t) => {
  const gw = await siteGateway(t, {});
  const kubo = { ...kuboAt(gw.base), rpc: { ipnsRecord: async () => ({ value: `/ipfs/${ROOT}`, sequence: 7, validity: '2026-10-21T11:16:21Z' }) } };
  const handler = createIpfsHandler({ kubo, settings });
  const res = await handler(nav(`ipns://${NAME}/`));
  assert.equal(res.status, 504);
  const html = await res.text();
  assert.match(html, /No online node has this content right now/);
  assert.match(html, /sequence 7, valid until 2026-10-21T11:16:21Z/);
  assert.match(html, new RegExp(`name: ${NAME}`));
});
