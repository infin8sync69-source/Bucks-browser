import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCid, normalizeIpnsName, isCid, isPeerId, normalizeIpfsUrl, parseIpfsUrl, toGatewayUrl } from '../../../src/main/ipfs/cid.js';

// Every expected value below was computed with multiformats (CID.parse(...).toV1().toString(base)),
// not guessed. CIDV0 → CIDV1 / CIDV1_B58 share one sha2-256 multihash; PEER_ID → K51 is the same
// ed25519 identity multihash as a bare base58btc peer id and as a base36 CIDv1 libp2p-key.
const CIDV0 = 'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB';
const CIDV1 = 'bafybeiasb5vpmaounyilfuxbd3lryvosl4yefqrfahsb2esg46q6tu6y5q';
const CIDV1_B58 = 'zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7';
const PEER_ID = '12D3KooWBwSVa1Cm2m4K1gX5QcdJJhbkC9YD4YcFw8yR1VyXG6z8';
const K51 = 'k51qzi5uqu5dgyvmvgql0nj58n4xnp7e3od4z635hhljqrxqifa7bpdb52zrod';
// legacy RSA-style peer id (sha2-256 multihash, Qm…) → base36 libp2p-key CID starts with k2k4
const QM_PEER_K2K4 = 'k2k4r8jv7wf2wizyu2zao33iv1f3gg57gu4kxrgjw975a47avoiijb3g';

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
  assert.equal(out, K51);
  assert.equal(normalizeIpnsName(out), out); // idempotent
  assert.equal(normalizeIpnsName(K51), K51);
  assert.equal(normalizeIpnsName(` ${PEER_ID} `), K51);
  // legacy Qm… peer ids are libp2p keys too (never confused with a CIDv0 of content)
  assert.equal(normalizeIpnsName(CIDV0), QM_PEER_K2K4);
  assert.equal(normalizeIpnsName(QM_PEER_K2K4), QM_PEER_K2K4);
});

test('isPeerId recognises every textual form and rejects DNSLink names', () => {
  assert.equal(isPeerId(PEER_ID), true);
  assert.equal(isPeerId(K51), true);
  assert.equal(isPeerId(CIDV0), true);
  assert.equal(isPeerId(CIDV1), false); // dag-pb content CID, not a key
  assert.equal(isPeerId('en.wikipedia-on-ipfs.org'), false);
  assert.equal(isPeerId('12D3KooWnotreallyapeerid'), false);
  assert.equal(isPeerId(''), false);
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
