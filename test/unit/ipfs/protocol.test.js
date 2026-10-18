import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamUrl, rewriteLocation, renderErrorPage, createIpfsHandler } from '../../../src/main/protocols/ipfs.js';
import { parseIpfsUrl } from '../../../src/main/ipfs/cid.js';

const CID = 'bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm';

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
