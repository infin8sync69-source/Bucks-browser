'use strict';

/**
 * Two-user identity + real E2E messaging test for the Bucks Browser
 * Soul Engine chat stack (Chain 8192 / BUCKS network).
 *
 * This does NOT reimplement identity or messaging with placeholder crypto.
 * It spawns two OS processes, each running the actual, unmodified
 * electron/chat-engine.js + electron/signal-store.js over a real Helia +
 * libp2p node (TCP/noise/yamux/gossipsub, same stack as ipfs-node.js), and
 * exercises the real X3DH handshake + Double Ratchet session end to end:
 * two real network identities, a real direct-stream dial, a real encrypted
 * send, and a real decrypt on the other side.
 *
 * Usage:
 *   cd "bucks browser"
 *   node scripts/test-two-users.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');

const WORKER_SCRIPT = path.join(__dirname, 'chat-worker.js');
const TIMEOUT_MS = 30000;

function makeWorker(role) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bucks-test-${role}-`));
  const child = fork(WORKER_SCRIPT, [], {
    env: { ...process.env, WORKER_ROLE: role, WORKER_DATA_DIR: dataDir },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  const queue = [];
  const waiters = [];

  child.on('message', (msg) => {
    const waiterIdx = waiters.findIndex((w) => w.predicate(msg));
    if (waiterIdx !== -1) {
      const [w] = waiters.splice(waiterIdx, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      queue.push(msg);
    }
  });

  function waitFor(predicate, timeoutMs = TIMEOUT_MS, label = 'message') {
    const idx = queue.findIndex(predicate);
    if (idx !== -1) {
      return Promise.resolve(queue.splice(idx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.resolve === resolve);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`Timed out waiting for ${label} (role ${role})`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  }

  return { role, child, dataDir, waitFor };
}

async function main() {
  console.log('\n===============================================');
  console.log(' Bucks Browser — Soul Engine Messaging Test');
  console.log(' Chain 8192 — Two-User E2E Identity + Chat Test');
  console.log('===============================================\n');

  const workers = { A: makeWorker('A'), B: makeWorker('B') };
  let allPassed = false;

  try {
    allPassed = await runTest(workers);
  } finally {
    // Always tear down, even on error/timeout, so a failed run doesn't leak
    // worker processes or temp userData directories.
    for (const w of Object.values(workers)) {
      try { w.child.send({ type: 'shutdown' }); } catch (_) { /* already dead */ }
    }
    await Promise.race([
      Promise.all(Object.values(workers).map((w) => new Promise((r) => w.child.once('exit', r)))),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    for (const w of Object.values(workers)) {
      w.child.kill();
      fs.rmSync(w.dataDir, { recursive: true, force: true });
    }
  }

  process.exit(allPassed ? 0 : 1);
}

async function runTest(workers) {
  const [readyA, readyB] = await Promise.all([
    workers.A.waitFor((m) => m.type === 'ready', TIMEOUT_MS, 'ready(A)'),
    workers.B.waitFor((m) => m.type === 'ready', TIMEOUT_MS, 'ready(B)'),
  ]);

  const identityA = readyA.identity;
  const identityB = readyB.identity;

  console.log('User A —', identityA.displayName);
  console.log('  soulId (did:bucks:...) :', identityA.soulId);
  console.log('  address                :', identityA.address);
  console.log('  peerId                 :', identityA.peerId);
  console.log('  identity pubkey (X25519):', identityA.identityPublicKey.slice(0, 20) + '...');
  console.log('');
  console.log('User B —', identityB.displayName);
  console.log('  soulId (did:bucks:...) :', identityB.soulId);
  console.log('  address                :', identityB.address);
  console.log('  peerId                 :', identityB.peerId);
  console.log('  identity pubkey (X25519):', identityB.identityPublicKey.slice(0, 20) + '...');
  console.log('');
  console.log('Note: private keys never leave their worker process and are not printed or persisted.\n');

  // Dial A -> B over a loopback multiaddr
  const targetAddr = readyB.multiaddrs.find((a) => a.includes('/p2p/')) || readyB.multiaddrs[0];
  console.log(`─── Network: dialing A -> B (${targetAddr}) ───────────────`);
  workers.A.child.send({ type: 'dial', multiaddr: targetAddr });
  await workers.A.waitFor((m) => m.type === 'dialed', TIMEOUT_MS, 'dialed');
  console.log('Connection established.\n');

  // Wait (briefly) for gossipsub pre-key bundle auto-exchange to complete.
  console.log('─── Key Exchange: waiting for X3DH pre-key bundles (gossipsub auto-broadcast) ───');
  async function checkBundle(from, aboutPeerId) {
    from.child.send({ type: 'has-bundle', peerId: aboutPeerId });
    const res = await from.waitFor((m) => m.type === 'has-bundle-result' && m.peerId === aboutPeerId, 5000, 'has-bundle-result');
    return res.hasBundle;
  }
  async function waitForBundle(from, aboutPeerId, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (await checkBundle(from, aboutPeerId)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  const [gossipBundleAtA, gossipBundleAtB] = await Promise.all([
    waitForBundle(workers.A, identityB.peerId, 10000),
    waitForBundle(workers.B, identityA.peerId, 10000),
  ]);
  console.log(`  A has B's bundle via gossipsub: ${gossipBundleAtA ? 'yes' : 'NO'}`);
  console.log(`  B has A's bundle via gossipsub: ${gossipBundleAtB ? 'yes' : 'NO'}`);

  let bundleAtA = gossipBundleAtA;
  let bundleAtB = gossipBundleAtB;

  if (!bundleAtA || !bundleAtB) {
    console.log('');
    console.log('  ⚠️  gossipsub auto-broadcast did not deliver the bundle (see KNOWN ISSUE');
    console.log('      in the report below). Falling back to the manual bundle-exchange path');
    console.log('      chat-engine.js already exposes for QR-code key exchange, so the actual');
    console.log('      X3DH handshake + Double Ratchet messaging below is still 100% real code.');
    workers.A.child.send({ type: 'get-own-bundle' });
    workers.B.child.send({ type: 'get-own-bundle' });
    const [ownBundleA, ownBundleB] = await Promise.all([
      workers.A.waitFor((m) => m.type === 'own-bundle-result', TIMEOUT_MS, 'own-bundle(A)'),
      workers.B.waitFor((m) => m.type === 'own-bundle-result', TIMEOUT_MS, 'own-bundle(B)'),
    ]);
    workers.A.child.send({ type: 'process-bundle', peerId: identityB.peerId, bundle: ownBundleB.bundle.bundle });
    workers.B.child.send({ type: 'process-bundle', peerId: identityA.peerId, bundle: ownBundleA.bundle.bundle });
    await Promise.all([
      workers.A.waitFor((m) => m.type === 'process-bundle-result' && m.peerId === identityB.peerId, TIMEOUT_MS, 'process-bundle(A)'),
      workers.B.waitFor((m) => m.type === 'process-bundle-result' && m.peerId === identityA.peerId, TIMEOUT_MS, 'process-bundle(B)'),
    ]);
    [bundleAtA, bundleAtB] = await Promise.all([
      checkBundle(workers.A, identityB.peerId),
      checkBundle(workers.B, identityA.peerId),
    ]);
    console.log(`  A has B's bundle via manual exchange: ${bundleAtA ? 'yes' : 'NO'}`);
    console.log(`  B has A's bundle via manual exchange: ${bundleAtB ? 'yes' : 'NO'}`);
  }

  if (!bundleAtA || !bundleAtB) {
    throw new Error('Pre-key bundle exchange did not complete (neither gossipsub nor manual path worked) — aborting message test.');
  }
  console.log('');

  // ─── Message exchange (real X3DH + Double Ratchet) ───
  console.log('─── Message Exchange (real X3DH handshake + Double Ratchet) ──\n');

  let reqId = 0;
  async function sendAndVerify(fromW, toW, fromIdentity, toIdentity, text) {
    const requestId = ++reqId;
    fromW.child.send({ type: 'send-message', peerId: toIdentity.peerId, text, requestId });

    const [sendRes, recvMsg] = await Promise.all([
      fromW.waitFor((m) => m.type === 'send-result' && m.requestId === requestId, TIMEOUT_MS, 'send-result'),
      toW.waitFor((m) => m.type === 'message-received' && m.from === fromIdentity.peerId, TIMEOUT_MS, 'message-received'),
    ]);

    const sendOk = !!(sendRes.result && sendRes.result.success);
    const decryptedText = recvMsg.message.text;
    const roundTripOk = decryptedText === text;

    console.log(`[${new Date().toISOString()}]`);
    console.log(`FROM: ${fromIdentity.displayName} (${fromIdentity.peerId.slice(0, 12)}...)`);
    console.log(`  TO: ${toIdentity.displayName} (${toIdentity.peerId.slice(0, 12)}...)`);
    console.log(` SENT: ${text}`);
    console.log(` RECV: ${decryptedText}`);
    console.log(` Send acknowledged: ${sendOk ? 'YES' : 'NO — ' + (sendRes.result && sendRes.result.error)}`);
    console.log(` Decrypted correctly on receiver (Double Ratchet round-trip): ${roundTripOk ? '✅ VALID' : '❌ MISMATCH'}`);
    console.log('');

    return sendOk && roundTripOk;
  }

  const results = [];
  results.push(
    await sendAndVerify(
      workers.A, workers.B, identityA, identityB,
      `Hello ${identityB.displayName} — Chain 8192 test message. Soul Engine online.`,
    ),
  );
  results.push(
    await sendAndVerify(
      workers.B, workers.A, identityB, identityA,
      `Acknowledged, ${identityA.displayName}. Soul Engine messaging online.`,
    ),
  );
  results.push(
    await sendAndVerify(
      workers.A, workers.B, identityA, identityB,
      'Sending BUCKS test transaction reference in 3... 2... 1...',
    ),
  );
  results.push(
    await sendAndVerify(
      workers.B, workers.A, identityB, identityA,
      'Ready to receive. IPFS node synced. Soul Engine session ratcheted forward.',
    ),
  );

  const allPassed = results.every(Boolean);

  console.log('===============================================');
  console.log(allPassed ? '✅ Identity + E2E messaging test PASSED' : '❌ Identity + E2E messaging test FAILED');
  console.log('   User A:', identityA.address, `(${identityA.displayName})`);
  console.log('   User B:', identityB.address, `(${identityB.displayName})`);
  console.log(`   Messages verified: ${results.filter(Boolean).length}/${results.length}`);
  console.log('===============================================\n');

  // Save PUBLIC identity info only — no private key material.
  const outFile = path.join(__dirname, '..', 'test-identities.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        warning: 'TEST IDENTITIES ONLY — public info only, no private keys, DO NOT USE IN PRODUCTION',
        userA: identityA,
        userB: identityB,
        messagingTest: { passed: allPassed, messagesVerified: results.filter(Boolean).length, totalMessages: results.length },
      },
      null,
      2,
    ),
  );
  console.log(`Test identities (public info only) saved to: ${outFile}\n`);

  return allPassed;
}

main().catch((err) => {
  console.error('\n❌ Test failed with error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
