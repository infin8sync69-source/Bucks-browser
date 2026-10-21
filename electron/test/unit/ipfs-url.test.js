'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeIpfsUrl } = require('../../ipfs-url');

// Bucks-browser's own implementation (multiformats), ported in hosting/: the renderer's copy must agree.
const reference = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'hosting', 'src', 'main', 'ipfs', 'cid.js')).href);

const INPUTS = [
  'ipfs://QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
  'ipfs://QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn/docs/a.html?x=1#top',
  'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  'ipfs://bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4',
  'ipfs://ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
  'ipfs:///ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/x',
  'ipns://12D3KooWBqNWAVor6qX21a66VC3KE6TfCUUDfmwzAEWoE9JBfGEW',
  'ipns://12D3KooWBqNWAVor6qX21a66VC3KE6TfCUUDfmwzAEWoE9JBfGEW/blog/',
  'ipns://QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  'ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8',
  'ipns://En.Wikipedia-on-IPFS.org/wiki/',
  'ipns://ipns/docs.ipfs.tech',
];

test('normalizeIpfsUrl matches Bucks-browser (hosting/src/main/ipfs/cid.js) on the forms people type', async () => {
  const ref = await reference();
  for (const input of INPUTS) assert.equal(normalizeIpfsUrl(input), ref.normalizeIpfsUrl(input), input);
});

test('normalizeIpfsUrl: the results survive a lowercased URL host', () => {
  assert.equal(normalizeIpfsUrl('ipfs://QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'), 'ipfs://bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354/');
  assert.match(normalizeIpfsUrl('ipns://12D3KooWBqNWAVor6qX21a66VC3KE6TfCUUDfmwzAEWoE9JBfGEW'), /^ipns:\/\/k51[0-9a-z]+\/$/);
  // cid.js leaves base32upper as typed (Chromium lowercases the host); lowercasing it first is the same address
  assert.equal(normalizeIpfsUrl('ipfs://BAFYBEIGDYRZT5SFP7UDM7HU76UH7Y26NF3EFUYLQABF3OCLGTQY55FBZDI/'), 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/');
  assert.equal(normalizeIpfsUrl('https://example.com/'), 'https://example.com/');
  assert.equal(normalizeIpfsUrl('ipfs://not-a-cid/x'), 'ipfs://not-a-cid/x');
});
