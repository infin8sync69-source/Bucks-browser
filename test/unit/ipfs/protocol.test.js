import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildUpstreamUrl, rewriteLocation, renderErrorPage, createIpfsHandler } from '../../../src/main/protocols/ipfs.js';
import { parseIpfsUrl } from '../../../src/main/ipfs/cid.js';

const CID = 'bafybeiasb5vpmaounyilfuxbd3lryvosl4yefqrfahsb2esg46q6tu6y5q'; // QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB as CIDv1

test('buildUpstreamUrl', () => {
  assert.equal(buildUpstreamUrl('http://127.0.0.1:8080', parseIpfsUrl(`ipfs://${CID}/a/b.txt?x=1#h`)), `http://127.0.0.1:8080/ipfs/${CID}/a/b.txt?x=1`);
  assert.equal(buildUpstreamUrl('http://127.0.0.1:8080/', parseIpfsUrl(`ipfs://${CID}`)), `http://127.0.0.1:8080/ipfs/${CID}/`);
  assert.equal(buildUpstreamUrl('https://ipfs.io', parseIpfsUrl('ipns://en.wikipedia-on-ipfs.org/wiki/')), 'https://ipfs.io/ipns/en.wikipedia-on-ipfs.org/wiki/');
  assert.equal(buildUpstreamUrl('https://ipfs.io', { scheme: 'ipfs', host: CID, pathname: 'x', search: '' }), `https://ipfs.io/ipfs/${CID}/x`);
});

test('rewriteLocation: path-style, absolute and subdomain redirects → ipfs://', () => {
  assert.equal(rewriteLocation(`/ipfs/${CID}/dir/`, 'ipfs'), `ipfs://${CID}/dir/`);
  assert.equal(rewriteLocation(`/ipfs/${CID}`, 'ipfs'), `ipfs://${CID}/`);
  assert.equal(rewriteLocation('/ipns/example.com/x/?q=1', 'ipns'), 'ipns://example.com/x/?q=1');
  assert.equal(rewriteLocation(`http://127.0.0.1:8080/ipfs/${CID}/dir/`, 'ipfs'), `ipfs://${CID}/dir/`);
  assert.equal(rewriteLocation(`http://${CID}.ipfs.localhost:8080/dir/?a=b`, 'ipfs'), `ipfs://${CID}/dir/?a=b`);
  assert.equal(rewriteLocation('https://example-com.ipns.dweb.link/', 'ipns'), 'ipns://example-com/');
  assert.equal(rewriteLocation('https://example.com/other', 'ipfs'), 'https://example.com/other');
  assert.equal(rewriteLocation('dir/', 'ipfs'), 'dir/');
  assert.equal(rewriteLocation(`ipfs://${CID}/`, 'ipfs'), `ipfs://${CID}/`);
  assert.equal(rewriteLocation('', 'ipfs'), '');
});

test('renderErrorPage is self-contained and escapes details', () => {
  const html = renderErrorPage({ title: 'T', heading: 'H', message: 'm', detail: '<script>alert(1)</script>', refreshSeconds: 2 });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('http-equiv="refresh" content="2"'));
  assert.ok(!/src="http/.test(html));
});

function fakeKubo(state, { gateway = 'http://127.0.0.1:1' } = {}) {
  return {
    isReady: () => state === 'ready',
    gatewayUrl: () => (state === 'ready' ? gateway : null),
    status: () => ({ state, message: `state is ${state}` }),
  };
}
const settings = (ipfs = {}) => ({ get: () => ({ ipfs: { publicGateway: 'https://ipfs.io', preferredGateway: 'local', ...ipfs } }) });
/** Lets a loopback fake stand in for the public gateway (the real validator demands https on a public host). */
const anyGateway = (u) => ({ ok: true, base: String(u).replace(/\/+$/, '') });
/** Requests a fake gateway saw for one path (the handler also reads bucks-site.json and _redirects). */
const seenFor = (gw, path) => gw.seen.filter((r) => r.url.split('?')[0] === path);

test('handler: landing page, invalid CID pages, 405', async () => {
  const handler = createIpfsHandler({ kubo: fakeKubo('ready'), settings: settings() });
  const landing = await handler(new Request('ipfs://'));
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /InterPlanetary File System/);

  const v0 = await handler(new Request('ipfs://qmpz9gccepqkto6aq61g2nxguhm4icl3ewb6ldxzctioeb/'));
  assert.equal(v0.status, 400);
  assert.match(await v0.text(), /CIDv0 must be written as CIDv1/);

  const bad = await handler(new Request('ipfs://not-a-cid/'));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /not a valid content identifier/);

  const badIpns = await handler(new Request('ipns://bad_name!/'));
  assert.equal(badIpns.status, 400);

  const post = await handler(new Request(`ipfs://${CID}/`, { method: 'POST' }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('handler: 503 refresh page while initializing, 502 when the gateway is unreachable', async () => {
  const starting = createIpfsHandler({ kubo: fakeKubo('initializing'), settings: settings() });
  const res = await starting(new Request(`ipfs://${CID}/`));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '2');
  const html = await res.text();
  assert.match(html, /Starting local IPFS node/);
  assert.match(html, /state is initializing/);
  assert.match(html, /http-equiv="refresh"/);

  // ready, but the gateway port has nothing listening → 502 page (nothing escapes as an exception)
  const dead = createIpfsHandler({ kubo: fakeKubo('ready', { gateway: 'http://127.0.0.1:9' }), settings: settings() });
  const r2 = await dead(new Request(`ipfs://${CID}/`));
  assert.equal(r2.status, 502);
  assert.match(await r2.text(), /local IPFS gateway did not respond/);
});

/* ---------- proxying against a fake path gateway ---------- */

/** Start a tiny HTTP server that records requests and replies per path. Closed via t.after. */
async function fakeGateway(t, routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    const route = routes[req.url.split('?')[0]] || routes['*'];
    if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); return; }
    route(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

test('handler: streams from the local gateway, forwards request headers, copies response headers', async (t) => {
  const gw = await fakeGateway(t, {
    [`/ipfs/${CID}/a.txt`]: (req, res) => {
      const body = 'hello ipfs';
      if (req.headers.range === 'bytes=0-4') {
        res.writeHead(206, { 'content-type': 'text/plain', 'content-range': 'bytes 0-4/10', 'content-length': '5', etag: '"abc"', 'x-ipfs-path': `/ipfs/${CID}/a.txt`, 'set-cookie': 'nope=1' });
        res.end(body.slice(0, 5));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length), 'cache-control': 'public, max-age=29030400, immutable', etag: '"abc"' });
      res.end(body);
    },
  });
  const handler = createIpfsHandler({ kubo: fakeKubo('ready', { gateway: gw.base }), settings: settings() });

  const full = await handler(new Request(`ipfs://${CID}/a.txt?x=1`, { headers: { accept: 'text/plain', 'if-none-match': '"zzz"' } }));
  assert.equal(full.status, 200);
  assert.equal(await full.text(), 'hello ipfs');
  assert.equal(full.headers.get('content-type'), 'text/plain');
  assert.equal(full.headers.get('cache-control'), 'public, max-age=29030400, immutable');
  const first = seenFor(gw, `/ipfs/${CID}/a.txt`)[0];
  assert.equal(first.url, `/ipfs/${CID}/a.txt?x=1`);
  assert.equal(first.headers.accept, 'text/plain');
  assert.equal(first.headers['if-none-match'], '"zzz"');
  assert.equal(first.headers['accept-encoding'], 'identity');
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');

  const ranged = await handler(new Request(`ipfs://${CID}/a.txt`, { headers: { range: 'bytes=0-4' } }));
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-4/10');
  assert.equal(ranged.headers.get('x-ipfs-path'), `/ipfs/${CID}/a.txt`);
  assert.equal(ranged.headers.get('set-cookie'), null); // not on the copy list
  assert.equal(await ranged.text(), 'hello');

  const head = await handler(new Request(`ipfs://${CID}/a.txt`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(seenFor(gw, `/ipfs/${CID}/a.txt`).at(-1).method, 'HEAD');
});

test('handler: gateway redirects are rewritten back to ipfs://, 504 becomes the not-found page', async (t) => {
  const gw = await fakeGateway(t, {
    [`/ipfs/${CID}/dir`]: (_req, res) => { res.writeHead(301, { location: `/ipfs/${CID}/dir/` }); res.end(); },
    [`/ipfs/${CID}/slow`]: (_req, res) => { res.writeHead(504, { 'content-type': 'text/plain' }); res.end('gateway timeout'); },
    '/ipns/example.com/': (_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:1/ipfs/${CID}/x/` }); res.end(); },
  });
  const handler = createIpfsHandler({ kubo: fakeKubo('ready', { gateway: gw.base }), settings: settings() });

  const redirect = await handler(new Request(`ipfs://${CID}/dir`));
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), `ipfs://${CID}/dir/`);

  const abs = await handler(new Request('ipns://example.com/'));
  assert.equal(abs.status, 302);
  assert.equal(abs.headers.get('location'), `ipfs://${CID}/x/`);

  const slow = await handler(new Request(`ipfs://${CID}/slow`));
  assert.equal(slow.status, 504);
  const offline = await slow.text();
  assert.match(offline, /No online node has this content right now/);
  assert.match(offline, /The publisher's browser may be closed/);
  assert.match(offline, new RegExp(`CID: ${CID}`));
  assert.match(offline, new RegExp(`<a href="ipfs://${CID}/slow">Retry</a>`));
});

test('handler: the public gateway is used only with consent, or when preferredGateway=public', async (t) => {
  const pub = await fakeGateway(t, { [`/ipfs/${CID}/p`]: (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`public:${req.url}`); }, [`/ipfs/${CID}/q`]: (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`public:${req.url}`); } });
  const local = await fakeGateway(t, { [`/ipfs/${CID}/r`]: (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`local:${req.url}`); } });

  // stopped node: an interstitial, nothing sent to the public gateway
  const stopped = createIpfsHandler({ kubo: fakeKubo('stopped'), settings: settings({ publicGateway: `${pub.base}/` }), gatewayValidator: anyGateway });
  const ask = await stopped(new Request(`ipfs://${CID}/p?x=1`));
  assert.equal(ask.status, 503);
  assert.match(ask.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(ask.headers.get('x-frame-options'), 'DENY');
  const html = await ask.text();
  assert.match(html, /Your IPFS node is not running/);
  assert.match(html, /Start node/);
  assert.match(html, /Bucks always asks before using a public gateway/);
  assert.equal(pub.seen.length, 0);
  const once = /href="([^"]*bucks-gateway=once\.[^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
  assert.ok(once.startsWith(`ipfs://${CID}/p?x=1&bucks-gateway=once.`));

  // a forged or reused nonce only strips the parameter
  const forged = await stopped(new Request(`ipfs://${CID}/p?x=1&bucks-gateway=once.forged`));
  assert.equal(forged.status, 303);
  assert.equal(forged.headers.get('location'), `ipfs://${CID}/p?x=1`);
  assert.equal((await stopped(new Request(`ipfs://${CID}/p`))).status, 503, 'still asking');

  const granted = await stopped(new Request(once));
  assert.equal(granted.status, 303);
  assert.equal(granted.headers.get('location'), `ipfs://${CID}/p?x=1`);
  assert.equal(await (await stopped(new Request(`ipfs://${CID}/p`))).text(), `public:/ipfs/${CID}/p`);
  assert.equal(stopped.badgeFor(`ipfs://${CID}/p`).kind, 'unverified');
  assert.equal((await stopped(new Request(once))).status, 303, 'the nonce works once');
  // consent is per origin: another CID still asks
  assert.equal((await stopped(new Request('ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy/'))).status, 503);

  const prefersPublic = createIpfsHandler({ kubo: fakeKubo('ready', { gateway: local.base }), settings: settings({ publicGateway: pub.base, preferredGateway: 'public' }), gatewayValidator: anyGateway });
  assert.equal(await (await prefersPublic(new Request(`ipfs://${CID}/q`))).text(), `public:/ipfs/${CID}/q`);

  const prefersLocal = createIpfsHandler({ kubo: fakeKubo('ready', { gateway: local.base }), settings: settings({ publicGateway: pub.base }), gatewayValidator: anyGateway });
  assert.equal(await (await prefersLocal(new Request(`ipfs://${CID}/r`))).text(), `local:/ipfs/${CID}/r`);
  assert.equal(prefersLocal.badgeFor(`ipfs://${CID}/r`).kind, 'content-addressed');
  assert.equal(seenFor(local, `/ipfs/${CID}/r`).length, 1);
  assert.equal(seenFor(pub, `/ipfs/${CID}/p`).length, 1);
  assert.equal(seenFor(pub, `/ipfs/${CID}/q`).length, 1);

  // the node stops: the interstitial is not the site, so the badge goes away
  const node = fakeKubo('ready', { gateway: local.base });
  const sameHandler = createIpfsHandler({ kubo: node, settings: settings({ publicGateway: pub.base }), gatewayValidator: anyGateway });
  await (await sameHandler(new Request(`ipfs://${CID}/r`))).text();
  assert.equal(sameHandler.badgeFor(`ipfs://${CID}/`).kind, 'content-addressed');
  node.isReady = () => false;
  node.status = () => ({ state: 'stopped', message: 'stopped' });
  assert.equal((await sameHandler(new Request(`ipfs://${CID}/r`))).status, 503);
  assert.equal(sameHandler.badgeFor(`ipfs://${CID}/`), null);
});

test('handler: an invalid public gateway setting is never contacted', async () => {
  const handler = createIpfsHandler({ kubo: fakeKubo('stopped'), settings: settings({ publicGateway: 'http://192.168.1.10:8080' }) });
  const html = await (await handler(new Request(`ipfs://${CID}/`))).text();
  assert.match(html, /must use https/);
  assert.ok(!/Use public gateway once/.test(html));
  const explicit = createIpfsHandler({ kubo: fakeKubo('ready'), settings: settings({ publicGateway: 'https://localhost', preferredGateway: 'public' }) });
  const res = await explicit(new Request(`ipfs://${CID}/`));
  assert.equal(res.status, 502);
  assert.match(await res.text(), /public host/);
});

test('handler: "Start node" from the interstitial starts the node', async () => {
  let started = 0;
  const kubo = { ...fakeKubo('stopped'), start: async () => { started += 1; } };
  const handler = createIpfsHandler({ kubo, settings: settings() });
  const html = await (await handler(new Request(`ipfs://${CID}/`))).text();
  const start = /href="([^"]*bucks-gateway=start\.[^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
  const res = await handler(new Request(start));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `ipfs://${CID}/`);
  assert.equal(started, 1);
});

test('handler never throws: a kubo that explodes yields a 500 page', async () => {
  const broken = { isReady: () => { throw new Error('boom'); }, gatewayUrl: () => null, status: () => ({ state: 'error', message: 'x' }) };
  const handler = createIpfsHandler({ kubo: broken, settings: settings() });
  const res = await handler(new Request(`ipfs://${CID}/`));
  assert.equal(res.status, 500);
  assert.match(await res.text(), /boom/);
});

test('handler: a gateway redirect that points back at the same ipfs:// URL is followed, never looped', async (t) => {
  let calls = 0;
  const flaky = await fakeGateway(t, {
    [`/ipfs/${CID}/`]: (req, res) => {
      calls += 1;
      if (calls === 1) {
        // like ipfs.io bouncing a path request to the subdomain origin of the same content
        res.writeHead(301, { location: `http://${req.headers.host}/ipfs/${CID}/` });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('followed');
      }
    },
  });
  const handler = createIpfsHandler({ kubo: fakeKubo('ready', { gateway: flaky.base }), settings: settings() });
  const res = await handler(new Request(`ipfs://${CID}/`));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'followed');
  assert.equal(seenFor(flaky, `/ipfs/${CID}/`).length, 2);

  // a gateway that redirects to itself forever is cut off after a few hops and surfaced as a redirect
  const loop = await fakeGateway(t, {
    [`/ipfs/${CID}/`]: (req, res) => { res.writeHead(301, { location: `http://${req.headers.host}/ipfs/${CID}/` }); res.end(); },
  });
  const handler2 = createIpfsHandler({ kubo: fakeKubo('ready', { gateway: loop.base }), settings: settings() });
  const res2 = await handler2(new Request(`ipfs://${CID}/`));
  assert.equal(res2.status, 301);
  assert.equal(res2.headers.get('location'), `ipfs://${CID}/`);
  assert.equal(seenFor(loop, `/ipfs/${CID}/`).length, 4);
});
