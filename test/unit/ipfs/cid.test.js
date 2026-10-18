import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCid, normalizeIpnsName, isCid, normalizeIpfsUrl, parseIpfsUrl, toGatewayUrl } from '../../../src/main/ipfs/cid.js';

const CIDV0 = 'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB';
const CIDV1 = 'bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm';
// same multihash as CIDV1 but base58btc-encoded CIDv1
const CIDV1_B58 = 'zdj7WiLB6JF4v7PPCPG1MgX5hHxuyHnaqRh9jQ1zgj4Bz9w5p';
const PEER_ID = '12D3KooWBwSVa1Cm2m4K1gX5QcdJJhbkC9YD4YcFw8yR1VyXG6z8';
const K51 = 'k51qzi5uqu5dkkciu33khkzbcmxtyhn376i1e83tya8kuy7z9euedzyr5nhoew';

test('CIDv0 → CIDv1 base32', () => {
  const out = normalizeCid(CIDV0);
  assert.match(out, /^bafy[a-z2-7]+$/);
  assert.equal(out, CIDV1);
});

test('CIDv1 base32 passes through unchanged', () => {
  assert.equal(normalizeCid(CIDV1), CIDV1);
});

test('base58btc CIDv1 → base32', () => {
  assert.equal(normalizeCid(CIDV1_B58), CIDV1);
});

test('isCid', () => {
  assert.equal(isCid(CIDV0), true);
  assert.equal(isCid(CIDV1), true);
  assert.equal(isCid('nope'), false);
  assert.equal(isCid(''), false);
  assert.equal(isCid(CIDV0.toLowerCase()), false);
});

test('normalizeIpfsUrl: plain host', () => {
  assert.equal(normalizeIpfsUrl(`ipfs://${CIDV0}`), `ipfs://${CIDV1}/`);
  assert.equal(normalizeIpfsUrl(`IPFS://${CIDV1}`), `ipfs://${CIDV1}/`);
});

test('normalizeIpfsUrl: ipfs://ipfs/<cid> and ipfs:///ipfs/<cid> forms', () => {
  assert.equal(normalizeIpfsUrl(`ipfs://ipfs/${CIDV0}`), `ipfs://${CIDV1}/`);
  assert.equal(normalizeIpfsUrl(`ipfs:///ipfs/${CIDV0}/a.txt`), `ipfs://${CIDV1}/a.txt`);
  assert.equal(normalizeIpfsUrl(`ipfs://ipfs/${CIDV0}/dir/`), `ipfs://${CIDV1}/dir/`);
});

test('normalizeIpfsUrl: path, query and hash are preserved', () => {
  assert.equal(
    normalizeIpfsUrl(`ipfs://${CIDV0}/some/path.html?x=1&y=2#frag`),
    `ipfs://${CIDV1}/some/path.html?x=1&y=2#frag`,
  );
  assert.equal(normalizeIpfsUrl(`ipfs://${CIDV1}?q=1`), `ipfs://${CIDV1}/?q=1`);
  assert.equal(normalizeIpfsUrl(`ipfs://${CIDV1}#top`), `ipfs://${CIDV1}/#top`);
});

test('normalizeIpfsUrl: invalid CID returns the input unchanged', () => {
  const bad = 'ipfs://not-a-cid/path';
  assert.equal(normalizeIpfsUrl(bad), bad);
  assert.equal(normalizeIpfsUrl(`ipfs://${CIDV0.toLowerCase()}`), `ipfs://${CIDV0.toLowerCase()}`);
});

test('normalizeIpfsUrl: non-ipfs urls and empty host pass through', () => {
  assert.equal(normalizeIpfsUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeIpfsUrl('ipfs://'), 'ipfs://');
});

test('IPNS peer id 12D3Koo… → k51… base36', () => {
  const out = normalizeIpnsName(PEER_ID);
  assert.match(out, /^k51[a-z0-9]+$/);
  assert.equal(normalizeIpnsName(out), out); // idempotent
  assert.equal(normalizeIpnsName(K51), K51);
});

test('IPNS DNSLink name is lowercased and ipns urls normalise', () => {
  assert.equal(normalizeIpnsName('En.Wikipedia-on-IPFS.org'), 'en.wikipedia-on-ipfs.org');
  assert.equal(normalizeIpfsUrl('ipns://En.Wikipedia-on-IPFS.org/wiki/'), 'ipns://en.wikipedia-on-ipfs.org/wiki/');
  assert.equal(normalizeIpfsUrl(`ipns://ipns/${PEER_ID}/x`), `ipns://${normalizeIpnsName(PEER_ID)}/x`);
});

test('parseIpfsUrl', () => {
  assert.deepEqual(parseIpfsUrl(`ipfs://${CIDV1}/a/b?x=1#h`), {
    scheme: 'ipfs', host: CIDV1, pathname: '/a/b', search: '?x=1', hash: '#h',
  });
  assert.deepEqual(parseIpfsUrl('ipns://example.com'), {
    scheme: 'ipns', host: 'example.com', pathname: '/', search: '', hash: '',
  });
  assert.equal(parseIpfsUrl('https://example.com'), null);
});

test('toGatewayUrl', () => {
  assert.equal(toGatewayUrl(`ipfs://${CIDV1}/a.txt?x=1`, 'http://127.0.0.1:8080/'), `http://127.0.0.1:8080/ipfs/${CIDV1}/a.txt?x=1`);
  assert.equal(toGatewayUrl('ipns://example.com/', 'https://ipfs.io'), 'https://ipfs.io/ipns/example.com/');
  assert.equal(toGatewayUrl('https://x.y', 'https://ipfs.io'), null);
});
