'use strict';

/**
 * Device worker — runs ONE real "device" as its own OS process: a real
 * Helia/libp2p node (electron/ipfs-node.js, unmodified), a real Soul bridge
 * (electron/ipfs-agent-soul.js) backed by a tiny in-process fake agent
 * server standing in for soul_engine.py (implements just the HTTP contract
 * cluster-membership.js/device-sync.js actually call: GET /api/v1/soul,
 * POST /api/v1/soul/sign, POST /api/v1/soul/set_ipfs_cid, POST
 * /api/v1/soul/peer), and the real cluster-membership.js + device-sync.js
 * modules, all wired together exactly as main.js wires them.
 *
 * Same rationale as chat-worker.js/ipfs-worker.js: these modules hold
 * module-level singleton state, so independent "devices" need independent OS
 * processes. Each worker's fake agent server has its OWN Ed25519 keypair —
 * i.e. its own soulId — matching this codebase's real identity model (no
 * private-key export exists; "the same person's two devices" are two
 * different souls that mutually attest to each other via device-sync.js).
 *
 * Usage: driven via fork() + IPC by scripts/test-multi-device.js, not run directly.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const Module = require('module');

const ROLE = process.env.WORKER_ROLE; // 'A' | 'A2' | 'B' | 'C'
const DATA_DIR = process.env.WORKER_DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

function send(type, payload) {
  process.send({ type, ...payload });
}

// ─── Fake agent server (stands in for soul_engine.py's HTTP surface) ───
// Normally a random identity per worker; if WORKER_IDENTITY_SEED_DER (base64
// PKCS8 DER) is set, reconstruct that exact keypair instead — used by the
// orchestrator to pre-compute a genesis soulId before any worker starts (so
// it can hand every worker BUCKS_GENESIS_SOUL_IDS up front).
let identityKeyPair;
if (process.env.WORKER_IDENTITY_SEED_DER) {
  const der = Buffer.from(process.env.WORKER_IDENTITY_SEED_DER, 'base64');
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv);
  identityKeyPair = { publicKey: pub, privateKey: priv };
} else {
  identityKeyPair = crypto.generateKeyPairSync('ed25519');
}
const { publicKey, privateKey } = identityKeyPair;
const soulId = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

function signPayload(payload) {
  return crypto.sign(null, Buffer.from(payload), privateKey).toString('hex');
}

const fakeAgentServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/v1/soul') {
      res.end(JSON.stringify({ soulId, locality: `test-${ROLE}`, frozenMemoryCid: 'fake-cid-skip-pin' }));
    } else if (req.method === 'POST' && req.url === '/api/v1/soul/sign') {
      const { payload } = JSON.parse(body || '{}');
      if (!payload) { res.end(JSON.stringify({ ok: false, error: 'payload required' })); return; }
      res.end(JSON.stringify({ ok: true, signature: signPayload(payload) }));
    } else if (req.method === 'POST' && req.url === '/api/v1/soul/peer') {
      res.end(JSON.stringify({ trusted: true }));
    } else if (req.method === 'POST' && req.url === '/api/v1/soul/set_ipfs_cid') {
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
});

// ─── Stub `electron` so the real main-process modules run under plain Node ───
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

async function main() {
  await new Promise((resolve) => fakeAgentServer.listen(0, '127.0.0.1', resolve));
  const agentPort = fakeAgentServer.address().port;
  process.env.AGENT_SERVER_URL = `http://127.0.0.1:${agentPort}`;

  // Requiring AFTER AGENT_SERVER_URL is set — cluster-membership.js,
  // device-sync.js, and ipfs-agent-soul.js all read it as a top-level const.
  const ipfs = require(path.join(ELECTRON_DIR, 'ipfs-node.js'));
  const heliaNode = await ipfs.startNode();

  const soulBridge = require(path.join(ELECTRON_DIR, 'ipfs-agent-soul.js'));
  const clusterMembership = require(path.join(ELECTRON_DIR, 'cluster-membership.js'));
  const deviceSync = require(path.join(ELECTRON_DIR, 'device-sync.js'));

  await soulBridge.start(300); // short grace period (default 3000ms is fine too, but keep tests fast)
  clusterMembership.init(heliaNode, ipfs.getGossip());
  deviceSync.init(ipfs, heliaNode, ipfs.getGossip());

  send('ready', {
    role: ROLE,
    soulId,
    peerId: heliaNode.libp2p.peerId.toString(),
    multiaddrs: heliaNode.libp2p.getMultiaddrs().map((a) => a.toString()),
  });

  process.on('message', async (msg) => {
    try {
      switch (msg.type) {
        case 'connect-peer': {
          const result = await ipfs.connectPeer(msg.multiaddr);
          send('connect-peer-result', { requestId: msg.requestId, result });
          break;
        }
        case 'publish-content': {
          const post = await ipfs.publishContent(msg.content, msg.metadata || {});
          send('publish-result', { requestId: msg.requestId, post });
          break;
        }
        case 'get-feed': {
          const feed = ipfs.getFeed({ clusterOnly: msg.clusterOnly !== false });
          send('feed-result', { requestId: msg.requestId, feed });
          break;
        }
        case 'cluster-admit': {
          const result = await clusterMembership.admitMember(msg.soulId, { displayName: msg.displayName });
          send('cluster-admit-result', { requestId: msg.requestId, result });
          break;
        }
        case 'cluster-my-identity': {
          const identity = await clusterMembership.getMyIdentity();
          send('cluster-my-identity-result', { requestId: msg.requestId, identity });
          break;
        }
        case 'device-link-initiate': {
          const result = await deviceSync.initiateLinkDevice(msg.soulId);
          send('device-link-initiate-result', { requestId: msg.requestId, result });
          break;
        }
        case 'device-linked-list': {
          const linked = await deviceSync.getLinkedDevices();
          send('device-linked-list-result', { requestId: msg.requestId, linked });
          break;
        }
        case 'device-sync-publish': {
          const result = await deviceSync.publishStateSnapshot();
          send('device-sync-publish-result', { requestId: msg.requestId, result });
          break;
        }
        case 'device-sync-pins': {
          const pins = await deviceSync.getSyncedPins();
          send('device-sync-pins-result', { requestId: msg.requestId, pins });
          break;
        }
        case 'follow-peer': {
          const result = ipfs.followPeer(msg.peerId);
          send('follow-peer-result', { requestId: msg.requestId, result });
          break;
        }
        case 'get-following': {
          send('get-following-result', { requestId: msg.requestId, following: ipfs.getNodeInfo().following });
          break;
        }
        case 'shutdown': {
          deviceSync.stop();
          await ipfs.stopNode();
          fakeAgentServer.close();
          process.exit(0);
          break;
        }
        default:
          send('worker-error', { requestId: msg.requestId, error: `unknown message type: ${msg.type}` });
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
