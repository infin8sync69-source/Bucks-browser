'use strict';

/**
 * Chat worker — runs ONE Soul Engine test identity as its own OS process,
 * so it gets a genuinely independent copy of the real chat-engine.js /
 * signal-store.js module state (both hold module-level singletons and can't
 * safely be instantiated twice inside one process). Driven by the parent
 * (test-two-users.js) over the Node IPC channel that `fork()` provides.
 *
 * Before requiring any app code, this stubs `electron` (app.getPath /
 * safeStorage) so the real, unmodified main-process modules run under plain
 * Node. Everything else — Helia, libp2p, X3DH, Double Ratchet — is the real
 * production code path.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROLE = process.env.WORKER_ROLE; // 'A' | 'B'
const DATA_DIR = process.env.WORKER_DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Stub `electron` so chat-engine.js / signal-store.js load under plain node ───
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => DATA_DIR },
      // Report encryption unavailable -> signal-store falls back to its
      // plaintext-on-disk path, which is fine for an ephemeral test dir.
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return originalLoad.apply(this, arguments);
};

const ELECTRON_DIR = path.join(__dirname, '..', 'electron');
const chatEngine = require(path.join(ELECTRON_DIR, 'chat-engine.js'));

function send(type, payload) {
  process.send({ type, ...payload });
}

// This worker lives in scripts/, a sibling of electron/ — bare dynamic
// import()s here would resolve node_modules by walking UP from scripts/ and
// land on the root bucks-browser/node_modules (a separate, stale copy of
// this stack), NOT electron/node_modules that chat-engine.js itself
// resolves against. That mismatch was reproduced firsthand: it silently
// built a libp2p node from one major version while chat-engine.js read its
// streams assuming another, i.e. https://github.com internal — same failure
// mode as any dual-package-instance bug. Force every import to resolve
// against electron/node_modules explicitly instead of trusting cwd-relative
// resolution.
function resolveElectronModule(specifier) {
  const m = specifier.match(/^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/);
  const pkgName = m[1];
  const subpath = m[2] ? `.${m[2]}` : '.';
  const pkgDir = path.join(ELECTRON_DIR, 'node_modules', pkgName);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const exp = pkgJson.exports && pkgJson.exports[subpath];
  const rel = (exp && (exp.import || exp.default)) || pkgJson.main;
  return path.join(pkgDir, rel);
}
async function importFromElectron(specifier) {
  const { pathToFileURL } = require('url');
  return import(pathToFileURL(resolveElectronModule(specifier)).href);
}

async function main() {
  const { gossipsub } = await importFromElectron('@chainsafe/libp2p-gossipsub');
  const { identify } = await importFromElectron('@libp2p/identify');
  const { tcp } = await importFromElectron('@libp2p/tcp');
  const { createLibp2p } = await importFromElectron('libp2p');
  const { noise } = await importFromElectron('@chainsafe/libp2p-noise');
  const { yamux } = await importFromElectron('@chainsafe/libp2p-yamux');
  const { generateKeyPair } = await importFromElectron('@libp2p/crypto/keys');

  // Ed25519 network identity — same primitive & derivation the real app uses
  // for its libp2p PeerId (ipfs-node.js) and its "soul" identity
  // (agent/soul/generator.py: soulId = hex of the raw Ed25519 public key).
  const peerPrivateKey = await generateKeyPair('Ed25519');
  const soulId = Buffer.from(peerPrivateKey.publicKey.raw).toString('hex');
  const displayName = 'SoulUser_' + soulId.slice(0, 6);

  const libp2pNode = await createLibp2p({
    privateKey: peerPrivateKey,
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [], // deterministic test — dial explicitly, no mDNS/bootstrap
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  });

  // chat-engine.js only touches heliaNode.libp2p (peerId, event listeners,
  // protocol handler, dialProtocol) — the full Helia blockstore/unixfs stack
  // is only needed for file attachments, which this identity+messaging test
  // doesn't exercise, so a real libp2p node wrapped in a minimal shim is
  // enough and avoids an unrelated ESM interop failure in Helia's default-
  // config path (helia -> @libp2p/webrtc -> @peculiar/webcrypto import,
  // broken under this Node version — see test report).
  const heliaNode = { libp2p: libp2pNode };
  const fsModule = null;

  await chatEngine.initChat(heliaNode, heliaNode.libp2p.services.pubsub, fsModule);

  chatEngine.setOnMessageCallback(({ peerId, message }) => {
    send('message-received', { from: peerId, message });
  });

  const peerId = heliaNode.libp2p.peerId.toString();
  const multiaddrs = heliaNode.libp2p
    .getMultiaddrs()
    .map((ma) => ma.toString());

  send('ready', {
    role: ROLE,
    identity: {
      soulId,
      address: '0x' + soulId.slice(0, 40),
      displayName,
      peerId,
      identityPublicKey: require(path.join(ELECTRON_DIR, 'signal-store.js')).getIdentityPublicKey(),
      createdAt: new Date().toISOString(),
    },
    multiaddrs,
  });

  process.on('message', async (msg) => {
    try {
      if (msg.type === 'dial') {
        const { multiaddr: parseMultiaddr } = await importFromElectron('@multiformats/multiaddr');
        await heliaNode.libp2p.dial(parseMultiaddr(msg.multiaddr));
        send('dialed', { target: msg.multiaddr });
      } else if (msg.type === 'has-bundle') {
        send('has-bundle-result', { peerId: msg.peerId, hasBundle: chatEngine.hasPeerBundle(msg.peerId) });
      } else if (msg.type === 'get-own-bundle') {
        send('own-bundle-result', { bundle: chatEngine.getOwnBundle() });
      } else if (msg.type === 'process-bundle') {
        // Same manual exchange path the app uses for QR-code key exchange —
        // used here because the gossipsub auto-broadcast path is broken (see
        // test report).
        const result = chatEngine.processPeerBundle(msg.peerId, msg.bundle);
        send('process-bundle-result', { peerId: msg.peerId, result });
      } else if (msg.type === 'send-message') {
        const result = await chatEngine.sendMessage(msg.peerId, msg.text);
        send('send-result', { requestId: msg.requestId, result });
      } else if (msg.type === 'shutdown') {
        await heliaNode.stop();
        process.exit(0);
      }
    } catch (err) {
      send('worker-error', { error: err.message, stack: err.stack });
    }
  });
}

main().catch((err) => {
  send('worker-error', { error: err.message, stack: err.stack });
  process.exit(1);
});
