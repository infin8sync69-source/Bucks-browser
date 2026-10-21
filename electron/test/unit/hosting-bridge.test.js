'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loopbackAddr, serves, linkLocalNode } = require('../../hosting-bridge');

const PEER = '12D3KooWBqNWAVor6qX21a66VC3KE6TfCUUDfmwzAEWoE9JBfGEW';

test('loopbackAddr: picks the loopback TCP address of the Helia node, never ws or other hosts', () => {
  const info = {
    peerId: PEER,
    addresses: [
      `/ip4/192.168.1.20/tcp/4020/p2p/${PEER}`,
      `/ip4/127.0.0.1/tcp/4021/ws/p2p/${PEER}`,
      `/ip4/127.0.0.1/tcp/4020/p2p/${PEER}`,
    ],
  };
  assert.equal(loopbackAddr(info), `/ip4/127.0.0.1/tcp/4020/p2p/${PEER}`);
  assert.equal(loopbackAddr({ peerId: PEER, addresses: ['/ip4/127.0.0.1/tcp/40211'] }), `/ip4/127.0.0.1/tcp/40211/p2p/${PEER}`, 'adds /p2p when missing');
  assert.equal(loopbackAddr({ peerId: PEER, addresses: [`/ip4/10.0.0.2/tcp/4020/p2p/${PEER}`] }), null);
  assert.equal(loopbackAddr({ status: 'offline' }), null);
  assert.equal(loopbackAddr(null), null);
});

test('before init nothing is routed to the ported handler and linking is a no-op', () => {
  assert.equal(serves('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/'), false);
  assert.equal(serves('ipns://en.wikipedia-on-ipfs.org/'), false);
  assert.equal(serves('https://example.com/'), false);
  assert.equal(linkLocalNode({ status: 'offline' }), false);
  assert.equal(linkLocalNode({ peerId: PEER, addresses: [`/ip4/127.0.0.1/tcp/4020/p2p/${PEER}`] }), true);
});
