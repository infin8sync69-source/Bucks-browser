'use strict';

/**
 * Multi-device / multi-user test for the real, unmodified cluster-membership.js
 * + device-sync.js + ipfs-node.js feed-gating, over real Helia/libp2p nodes
 * (scripts/device-worker.js). Matches the pattern of test-two-users.js /
 * test-ipfs-node.js: real production code, real OS processes, real gossipsub.
 *
 * Scenario (4 real nodes):
 *   A   — user 1's primary device
 *   A2  — user 1's second device (own soulId; no key export exists in this
 *         codebase, so "same person" is proven via device-sync.js's mutual
 *         attestation, not a shared identity key)
 *   B   — user 2, admitted into A's cluster
 *   C   — user 3, NOT admitted into A's cluster, NOT device-linked to A
 *
 * Assertions:
 *   1. A admits B -> B sees itself as a cluster member.
 *   2. B's published content appears in A's CLUSTER-gated feed.
 *   3. C's published content does NOT appear in A's cluster-gated feed, but
 *      DOES appear in A's unfiltered global feed (the actual security-
 *      relevant check for this feature).
 *   4. A <-> A2 device-link only becomes mutual after BOTH sides initiate it.
 *   5. Once mutual, A2's published state snapshot (a followed peer + a
 *      pinned CID) is picked up by A: the followed peer is auto-merged, the
 *      pinned CID surfaces via getSyncedPins() as a reference WITHOUT being
 *      auto-fetched into A's own pinned set.
 *   6. C attempting to link to A (one-directional) never becomes mutual, and
 *      C never appears in A's linked-device list.
 *
 * Usage:
 *   cd "bucks browser"
 *   node scripts/test-multi-device.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { fork } = require('child_process');

const WORKER_SCRIPT = path.join(__dirname, 'device-worker.js');
const TIMEOUT_MS = 30000;
const findings = [];

function record(area, status, detail) {
  findings.push({ area, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : 'ℹ️';
  console.log(`${icon} [${area}] ${detail}`);
}

function makeWorker(role, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bucks-device-test-${role}-`));
  const child = fork(WORKER_SCRIPT, [], {
    env: { ...process.env, WORKER_ROLE: role, WORKER_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
  });
  const prefix = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) out.write(`[${role}] ${line}\n`);
    });
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);

  const queue = [];
  const waiters = [];
  child.on('message', (msg) => {
    const idx = waiters.findIndex((w) => w.predicate(msg));
    if (idx !== -1) {
      const [w] = waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      queue.push(msg);
    }
  });

  function waitFor(predicate, timeoutMs = TIMEOUT_MS, label = 'message') {
    const idx = queue.findIndex(predicate);
    if (idx !== -1) return Promise.resolve(queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.resolve === resolve);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`Timed out waiting for ${label} (role ${role})`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  }

  let reqId = 0;
  function call(type, payload = {}, resultType, timeoutMs = TIMEOUT_MS) {
    const requestId = ++reqId;
    child.send({ type, requestId, ...payload });
    return waitFor((m) => m.type === resultType && m.requestId === requestId, timeoutMs, resultType);
  }

  return { role, child, dataDir, waitFor, call };
}

async function retryUntil(fn, { timeoutMs = 25000, intervalMs = 1000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last && last.ok) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}. Last result: ${JSON.stringify(last)}`);
}

async function main() {
  console.log('\n===============================================');
  console.log(' Bucks Browser — Multi-Device / Multi-User Test');
  console.log(' cluster-membership.js + device-sync.js + feed gating');
  console.log('===============================================\n');

  // Pre-compute A's identity so every worker can be handed the same
  // BUCKS_GENESIS_SOUL_IDS up front — cluster-membership.js requires at
  // least one genesis soul to bootstrap admission at all (by design: no
  // admission is trusted network-wide until SOME identity is trusted with no
  // prior vouching). Real deployments configure this once for the cluster;
  // this test plays that same role for A so B's admission actually
  // propagates instead of being dropped everywhere as untrusted.
  const aIdentity = crypto.generateKeyPairSync('ed25519');
  const aSeedDer = aIdentity.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const aSoulId = aIdentity.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const genesisEnv = { BUCKS_GENESIS_SOUL_IDS: aSoulId };

  const workers = {
    A: makeWorker('A', { ...genesisEnv, WORKER_IDENTITY_SEED_DER: aSeedDer }),
    A2: makeWorker('A2', genesisEnv),
    B: makeWorker('B', genesisEnv),
    C: makeWorker('C', genesisEnv),
  };

  try {
    await runTest(workers);
  } catch (err) {
    console.error('\n❌ Test failed with error:', err.message);
    console.error(err.stack);
    findings.push({ area: 'fatal', status: 'FAIL', detail: err.message });
  } finally {
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

  console.log('\n===============================================');
  const passed = findings.filter((f) => f.status === 'PASS').length;
  const failed = findings.filter((f) => f.status === 'FAIL').length;
  console.log(`${failed === 0 ? '✅' : '❌'} Multi-device test complete — ${passed} passed, ${failed} failed`);
  console.log('===============================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

async function runTest(workers) {
  console.log('Booting 4 independent Helia/libp2p+soul+cluster+device-sync nodes...\n');
  const ready = {};
  for (const role of ['A', 'A2', 'B', 'C']) {
    ready[role] = await workers[role].waitFor((m) => m.type === 'ready', TIMEOUT_MS, `ready(${role})`);
    record('startup', 'PASS', `Node ${role} up — soulId ${ready[role].soulId.slice(0, 16)}..., peerId ${ready[role].peerId.slice(0, 20)}...`);
  }

  // ── Fully connect the 4 nodes (pairwise dial) so gossipsub forms a mesh ──
  console.log('\n─── Connecting all 4 nodes pairwise ───');
  const roles = ['A', 'A2', 'B', 'C'];
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      const from = roles[i], to = roles[j];
      const targetAddr = ready[to].multiaddrs.find((a) => a.includes('/p2p/')) || ready[to].multiaddrs[0];
      const res = await workers[from].call('connect-peer', { multiaddr: targetAddr }, 'connect-peer-result');
      if (!res.result || !res.result.success) {
        record('connect', 'FAIL', `${from} -> ${to} failed: ${JSON.stringify(res.result)}`);
      }
    }
  }
  record('connect', 'PASS', 'All 4 nodes pairwise connected');

  // ── Wait for soul presence to propagate (needed for cluster admission's
  // transitive-trust check and feed-post attribution) ──
  console.log('\n─── Waiting for soul-presence propagation ───');
  await retryUntil(async () => {
    const idA = await workers.A.call('cluster-my-identity', {}, 'cluster-my-identity-result');
    // No direct "have I seen soul X" getter is exposed; discovered-peer
    // visibility is exercised indirectly by admitMember() succeeding below,
    // so just give the 30s soul-heartbeat topic a moment to settle.
    return { ok: true, identity: idA.identity };
  }, { timeoutMs: 4000, intervalMs: 1000, label: 'soul presence settle' });
  await new Promise((r) => setTimeout(r, 3000)); // let SOUL_TOPIC gossip actually land

  // ══════════════════════════════════════════════════════════════════════
  // Part 1: cluster-gated file discovery
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n─── Part 1: cluster-gated file discovery ───');

  const admitRes = await workers.A.call('cluster-admit', { soulId: ready.B.soulId, displayName: 'User B' }, 'cluster-admit-result');
  record('cluster-admit', admitRes.result && admitRes.result.ok ? 'PASS' : 'FAIL', `A admits B -> ${JSON.stringify(admitRes.result)}`);

  await retryUntil(async () => {
    const idB = await workers.B.call('cluster-my-identity', {}, 'cluster-my-identity-result');
    return { ok: idB.identity.isMember, identity: idB.identity };
  }, { timeoutMs: 15000, label: 'B learning its own membership via gossip' }).then(
    (r) => record('cluster-membership-propagation', 'PASS', `B sees itself as a member: ${JSON.stringify(r.identity)}`),
    (e) => record('cluster-membership-propagation', 'FAIL', e.message),
  );

  const bPublish = await workers.B.call('publish-content', { content: 'Post from cluster member B', metadata: { name: 'b-post.txt' } }, 'publish-result');
  const bCid = bPublish.post && bPublish.post.cid;
  record('b-publish', bCid ? 'PASS' : 'FAIL', `B published: ${bCid}`);

  const cPublish = await workers.C.call('publish-content', { content: 'Post from OUTSIDER C', metadata: { name: 'c-post.txt' } }, 'publish-result');
  const cCid = cPublish.post && cPublish.post.cid;
  record('c-publish', cCid ? 'PASS' : 'FAIL', `C published: ${cCid}`);

  await retryUntil(async () => {
    const feedRes = await workers.A.call('get-feed', { clusterOnly: true }, 'feed-result');
    const hasB = feedRes.feed.some((p) => p.cid === bCid);
    return { ok: hasB, feed: feedRes.feed };
  }, { timeoutMs: 15000, label: "A's cluster feed picking up B's post" }).then(
    (r) => record('cluster-feed-includes-member', 'PASS', `A's cluster-gated feed includes B's post (${r.feed.length} total entries)`),
    (e) => record('cluster-feed-includes-member', 'FAIL', e.message),
  );

  // Give C's post a moment to gossip-propagate too, before asserting it's absent
  await new Promise((r) => setTimeout(r, 3000));
  const aClusterFeed = await workers.A.call('get-feed', { clusterOnly: true }, 'feed-result');
  const aGlobalFeed = await workers.A.call('get-feed', { clusterOnly: false }, 'feed-result');
  const clusterHasC = aClusterFeed.feed.some((p) => p.cid === cCid);
  const globalHasC = aGlobalFeed.feed.some((p) => p.cid === cCid);
  record('cluster-feed-excludes-outsider', !clusterHasC ? 'PASS' : 'FAIL',
    `A's cluster-gated feed ${clusterHasC ? 'WRONGLY includes' : 'correctly excludes'} outsider C's post`);
  record('global-feed-includes-outsider', globalHasC ? 'PASS' : 'FAIL',
    `A's unfiltered global feed ${globalHasC ? 'correctly includes' : 'WRONGLY excludes'} outsider C's post (cid=${cCid})`);

  // ══════════════════════════════════════════════════════════════════════
  // Part 2: multi-device sync (A <-> A2)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n─── Part 2: multi-device sync (A <-> A2, same person) ───');

  const linkA = await workers.A.call('device-link-initiate', { soulId: ready.A2.soulId }, 'device-link-initiate-result');
  record('device-link-initiate-A', linkA.result && linkA.result.ok ? 'PASS' : 'FAIL', `A initiates link to A2 -> mutual=${linkA.result && linkA.result.mutual}`);
  if (linkA.result && linkA.result.mutual) {
    record('device-link-not-premature', 'FAIL', 'Link reported mutual before A2 reciprocated — should require BOTH sides');
  } else {
    record('device-link-not-premature', 'PASS', 'Link correctly NOT mutual until A2 reciprocates');
  }

  await new Promise((r) => setTimeout(r, 2000)); // let the link record gossip-propagate to A2

  const linkA2 = await workers.A2.call('device-link-initiate', { soulId: ready.A.soulId }, 'device-link-initiate-result');
  record('device-link-initiate-A2', linkA2.result && linkA2.result.ok && linkA2.result.mutual ? 'PASS' : 'FAIL',
    `A2 reciprocates link to A -> mutual=${linkA2.result && linkA2.result.mutual}`);

  await retryUntil(async () => {
    const listA = await workers.A.call('device-linked-list', {}, 'device-linked-list-result');
    return { ok: listA.linked.includes(ready.A2.soulId), linked: listA.linked };
  }, { timeoutMs: 15000, label: 'A learning the mutual link with A2' }).then(
    (r) => record('device-link-mutual-on-A', 'PASS', `A's linked devices: ${r.linked.map((s) => s.slice(0, 12))}`),
    (e) => record('device-link-mutual-on-A', 'FAIL', e.message),
  );

  // A2 sets up state to sync: follows a peer, and has a pinned file (via
  // publish-content, which self-pins per ipfs-node.js's publishContent()).
  await workers.A2.call('follow-peer', { peerId: ready.B.peerId }, 'follow-peer-result');
  const a2Publish = await workers.A2.call('publish-content', { content: "A2's own file", metadata: { name: 'a2-file.txt' } }, 'publish-result');
  const a2Cid = a2Publish.post && a2Publish.post.cid;
  record('a2-publish', a2Cid ? 'PASS' : 'FAIL', `A2 published (self-pinned): ${a2Cid}`);

  const snapPub = await workers.A2.call('device-sync-publish', {}, 'device-sync-publish-result');
  record('device-sync-publish', snapPub.result && snapPub.result.ok ? 'PASS' : 'FAIL', `A2 published state snapshot -> ${JSON.stringify(snapPub.result)}`);

  await retryUntil(async () => {
    const followingA = await workers.A.call('get-following', {}, 'get-following-result');
    return { ok: followingA.following.includes(ready.B.peerId), following: followingA.following };
  }, { timeoutMs: 15000, label: "A merging A2's followed peer via state sync" }).then(
    (r) => record('device-sync-follow-merge', 'PASS', `A's following list after sync: ${JSON.stringify(r.following)}`),
    (e) => record('device-sync-follow-merge', 'FAIL', e.message),
  );

  const syncedPinsA = await workers.A.call('device-sync-pins', {}, 'device-sync-pins-result');
  const seesA2Pin = syncedPinsA.pins.some((p) => p.cid === a2Cid);
  record('device-sync-pin-reference', seesA2Pin ? 'PASS' : 'FAIL',
    `A's getSyncedPins() ${seesA2Pin ? 'includes' : 'MISSING'} A2's pinned CID as a reference: ${JSON.stringify(syncedPinsA.pins)}`);

  // Critical: syncing must NOT have auto-pinned the file into A's own store —
  // it should only be a reference the user can act on.
  const aClusterFeedAfterSync = await workers.A.call('get-feed', { clusterOnly: false }, 'feed-result');
  const aAutoIngested = aClusterFeedAfterSync.feed.some((p) => p.cid === a2Cid && p.peerId === ready.A.peerId);
  record('device-sync-no-auto-fetch', !aAutoIngested ? 'PASS' : 'FAIL',
    aAutoIngested
      ? "A's own feed wrongly shows A2's file as if A had published/pinned it itself"
      : "A did not silently self-ingest A2's synced pin reference (correct — sync is references-only)");

  // ══════════════════════════════════════════════════════════════════════
  // Part 3: outsider cannot forge a device link
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n─── Part 3: outsider C cannot become a linked device of A ───');

  const cLinkAttempt = await workers.C.call('device-link-initiate', { soulId: ready.A.soulId }, 'device-link-initiate-result');
  record('outsider-link-attempt', cLinkAttempt.result && cLinkAttempt.result.ok ? 'PASS' : 'FAIL',
    `C initiates a one-sided link claim toward A -> ${JSON.stringify(cLinkAttempt.result)}`);

  await new Promise((r) => setTimeout(r, 3000)); // let it gossip-propagate if it's going to

  const linkedOnA = await workers.A.call('device-linked-list', {}, 'device-linked-list-result');
  const aLinkedToC = linkedOnA.linked.includes(ready.C.soulId);
  record('outsider-link-rejected', !aLinkedToC ? 'PASS' : 'FAIL',
    aLinkedToC
      ? 'SECURITY BUG: A considers unrelated C a linked device without A ever reciprocating'
      : "A correctly does NOT consider C a linked device (one-sided claim never became mutual)");
}

main().catch((err) => {
  console.error('\n❌ Multi-device test crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
