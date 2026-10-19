'use strict';

/**
 * IPFS worker — runs ONE real Helia/libp2p node as its own OS process by
 * driving the actual, unmodified electron/ipfs-node.js (and, for the "A"
 * role, electron/ipfs-bridge.js) module. Same rationale as chat-worker.js:
 * ipfs-node.js holds module-level singleton state (heliaNode, gossip, feed,
 * etc.), so two independent nodes in one process need two OS processes.
 *
 * Before requiring ipfs-node.js, this stubs `electron` (app.getPath) so the
 * real main-process module runs under plain Node with an isolated userData
 * dir per worker.
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROLE = process.env.WORKER_ROLE; // 'A' | 'B'
const DATA_DIR = process.env.WORKER_DATA_DIR;
const WITH_BRIDGE = process.env.WORKER_BRIDGE === '1';
fs.mkdirSync(DATA_DIR, { recursive: true });

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => DATA_DIR },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return originalLoad.apply(this, arguments);
};

const ELECTRON_DIR = path.join(__dirname, '..', 'electron');
const ipfs = require(path.join(ELECTRON_DIR, 'ipfs-node.js'));
let bridge = null;

function send(type, payload) {
  process.send({ type, ...payload });
}

async function main() {
  const heliaNode = await ipfs.startNode();
  const info = ipfs.getNodeInfo();

  let bridgeInfo = null;
  if (WITH_BRIDGE) {
    bridge = require(path.join(ELECTRON_DIR, 'ipfs-bridge.js'));
    bridgeInfo = await bridge.start(ipfs);
  }

  send('ready', {
    role: ROLE,
    peerId: heliaNode.libp2p.peerId.toString(),
    multiaddrs: heliaNode.libp2p.getMultiaddrs().map((a) => a.toString()),
    nodeInfo: info,
    bridgeInfo,
  });

  process.on('message', async (msg) => {
    try {
      if (msg.type === 'connect-peer') {
        const result = await ipfs.connectPeer(msg.multiaddr);
        send('connect-peer-result', { requestId: msg.requestId, result });
      } else if (msg.type === 'publish-content') {
        const post = await ipfs.publishContent(msg.content, msg.metadata || {});
        send('publish-result', { requestId: msg.requestId, post });
      } else if (msg.type === 'get-content') {
        const start = Date.now();
        try {
          const bytes = await ipfs.getContent(msg.cid);
          send('get-content-result', {
            requestId: msg.requestId,
            ok: true,
            text: Buffer.from(bytes).toString('utf8'),
            byteLength: bytes.length,
            durationMs: Date.now() - start,
          });
        } catch (err) {
          send('get-content-result', {
            requestId: msg.requestId,
            ok: false,
            error: err.message,
            durationMs: Date.now() - start,
          });
        }
      } else if (msg.type === 'get-node-info') {
        send('node-info-result', { requestId: msg.requestId, nodeInfo: ipfs.getNodeInfo() });
      } else if (msg.type === 'get-peers') {
        send('peers-result', { requestId: msg.requestId, peers: ipfs.getPeers() });
      } else if (msg.type === 'get-storage-stats') {
        send('storage-stats-result', { requestId: msg.requestId, stats: ipfs.getStorageStats() });
      } else if (msg.type === 'raw-gossip-subscribe') {
        // Direct raw-libp2p gossipsub test, bypassing ipfs-node.js's own
        // topic handlers entirely — isolates "is pubsub wired at all" from
        // "do the app's specific topic handlers work".
        const gossip = ipfs.getGossip();
        gossip.subscribe(msg.topic);
        gossip.addEventListener('message', (evt) => {
          if (evt.detail.topic === msg.topic) {
            send('raw-gossip-message', { topic: msg.topic, text: new TextDecoder().decode(evt.detail.data) });
          }
        });
        send('raw-gossip-subscribe-result', { requestId: msg.requestId, ok: true });
      } else if (msg.type === 'raw-gossip-publish') {
        const gossip = ipfs.getGossip();
        try {
          await gossip.publish(msg.topic, new TextEncoder().encode(msg.text));
          send('raw-gossip-publish-result', { requestId: msg.requestId, ok: true });
        } catch (err) {
          send('raw-gossip-publish-result', { requestId: msg.requestId, ok: false, error: err.message });
        }
      } else if (msg.type === 'http-request') {
        const http = require('http');
        const start = Date.now();
        const req = http.request(msg.url, { method: msg.method || 'GET', headers: msg.headers }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            send('http-response', {
              requestId: msg.requestId,
              statusCode: res.statusCode,
              body: Buffer.concat(chunks).toString('utf8'),
              durationMs: Date.now() - start,
            });
          });
        });
        req.on('error', (err) => {
          send('http-response', { requestId: msg.requestId, error: err.message, durationMs: Date.now() - start });
        });
        if (msg.body) req.write(msg.body);
        req.end();
      } else if (msg.type === 'shutdown') {
        if (bridge) bridge.stop();
        await ipfs.stopNode();
        process.exit(0);
      }
    } catch (err) {
      send('worker-error', { requestId: msg.requestId, error: err.message, stack: err.stack });
    }
  });
}

main().catch((err) => {
  send('worker-error', { error: err.message, stack: err.stack });
  process.exit(1);
});
