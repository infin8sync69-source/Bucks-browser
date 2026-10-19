'use strict';

/**
 * Real end-to-end test of electron/bucks-node.js (embedded wallet + mining +
 * transaction backend) — the real, unmodified production module, driven
 * through the exact RPC surface main.js's wallet-rpc handler calls
 * (handleRPC(method, endpoint, body)). No mocked chain logic.
 *
 * Stubs `electron` so the module runs under plain Node against an isolated
 * temp userData dir, same convention as scripts/test-two-users.js.
 *
 * Usage:
 *   cd "bucks browser"
 *   node scripts/test-bucks-node.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-node-test-'));

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => DATA_DIR } };
  }
  return originalLoad.apply(this, arguments);
};

const ELECTRON_DIR = path.join(__dirname, '..', 'electron');
const findings = [];
function record(area, status, detail) {
  findings.push({ area, status, detail });
  console.log(`${status === 'PASS' ? '✅' : '❌'} [${area}] ${detail}`);
}

async function main() {
  console.log('\n===============================================');
  console.log(' Bucks Node — Wallet + Mining E2E Test');
  console.log('===============================================\n');

  const bucksNode = require(path.join(ELECTRON_DIR, 'bucks-node.js'));
  const initResult = bucksNode.init({ dataDir: path.join(DATA_DIR, 'bucks-chain') });
  record('init', initResult.height === 0 && initResult.wallets === 0 ? 'PASS' : 'FAIL', `Fresh node: ${JSON.stringify(initResult)}`);

  const rpc = (method, endpoint, body) => bucksNode.handleRPC(method, endpoint, body);

  // ── Wallet creation ──
  const walletA = await rpc('POST', '/api/wallets/create', {});
  record('wallet-create-A', walletA.success && walletA.address?.startsWith('bx') && walletA.mnemonic ? 'PASS' : 'FAIL', JSON.stringify(walletA));

  const walletB = await rpc('POST', '/api/wallets/create', {});
  record('wallet-create-B', walletB.success && walletB.address?.startsWith('bx') ? 'PASS' : 'FAIL', JSON.stringify(walletB));

  if (walletA.address === walletB.address) {
    record('wallet-uniqueness', 'FAIL', 'Two independently created wallets produced the SAME address (mnemonic entropy bug)');
  } else {
    record('wallet-uniqueness', 'PASS', 'Two wallets have distinct addresses');
  }

  // ── Restore-by-mnemonic determinism ──
  const restoredA = await rpc('POST', '/api/wallets/restore', { mnemonic: walletA.mnemonic });
  record('wallet-restore-deterministic', restoredA.success && restoredA.address === walletA.address && restoredA.existing ? 'PASS' : 'FAIL',
    `Restoring A's own mnemonic -> ${JSON.stringify(restoredA)} (expected same address, existing:true)`);

  // ── GET /api/wallets before any mining ──
  const walletsListPre = await rpc('GET', '/api/wallets', null);
  record('wallets-list', walletsListPre.ok && walletsListPre.wallets.length === 2 ? 'PASS' : 'FAIL', JSON.stringify(walletsListPre));

  // ── Mine one block to A, verify coinbase reward lands ──
  await rpc('POST', '/api/mining/address', { address: walletA.address });
  const mine1 = await rpc('POST', '/api/mining/mine', {});
  record('mine-one-block', mine1.success && mine1.index === 1 && mine1.reward === 50 * 1e8 ? 'PASS' : 'FAIL', JSON.stringify(mine1));

  const balanceAfterMine1 = await rpc('GET', `/api/address/${walletA.address}`, null);
  record('balance-after-mine', balanceAfterMine1.balance === 50 * 1e8 ? 'PASS' : 'FAIL',
    `A's balance after 1 block: ${balanceAfterMine1.balance} (expected ${50 * 1e8})`);

  // ── Send a transaction A -> B ──
  const sendAmount = 10 * 1e8; // 10 BUCKS
  const sendRes = await rpc('POST', '/api/transactions/send', { from: walletA.address, to: walletB.address, amount: sendAmount });
  record('tx-send', sendRes.success && sendRes.txId ? 'PASS' : 'FAIL', JSON.stringify(sendRes));

  const statusAfterSend = await rpc('GET', '/api/status', null);
  record('mempool-has-pending-tx', statusAfterSend.mempool === 1 ? 'PASS' : 'FAIL', `mempool size: ${statusAfterSend.mempool}`);

  // Balance shouldn't move until the tx is actually mined into a block
  const balancePendingTx = await rpc('GET', `/api/address/${walletA.address}`, null);
  record('balance-unchanged-while-pending', balancePendingTx.balance === 50 * 1e8 ? 'PASS' : 'FAIL',
    `A's balance with tx still pending: ${balancePendingTx.balance} (should still be ${50 * 1e8})`);

  // ── Mine again — block.txs includes BOTH the coinbase reward tx and the
  // pending send, so txs===2 here is correct (not just the 1 real transfer).
  const mine2 = await rpc('POST', '/api/mining/mine', {});
  record('mine-second-block-includes-tx', mine2.success && mine2.txs === 2 ? 'PASS' : 'FAIL', JSON.stringify(mine2));

  const aFinal = await rpc('GET', `/api/address/${walletA.address}`, null);
  const bFinal = await rpc('GET', `/api/address/${walletB.address}`, null);
  const expectedA = 50 * 1e8 + 50 * 1e8 - sendAmount; // two block rewards minus the send
  const expectedB = sendAmount;
  record('balance-A-after-tx-mined', aFinal.balance === expectedA ? 'PASS' : 'FAIL', `A: ${aFinal.balance} (expected ${expectedA})`);
  record('balance-B-after-tx-mined', bFinal.balance === expectedB ? 'PASS' : 'FAIL', `B: ${bFinal.balance} (expected ${expectedB})`);

  // ── Reject: overspend ──
  const overspend = await rpc('POST', '/api/transactions/send', { from: walletB.address, to: walletA.address, amount: 999 * 1e8 });
  record('reject-overspend', overspend.success === false ? 'PASS' : 'FAIL', JSON.stringify(overspend));

  // ── Reject: negative/non-integer amount ──
  const badAmount = await rpc('POST', '/api/transactions/send', { from: walletA.address, to: walletB.address, amount: -5 });
  record('reject-invalid-amount', badAmount.success === false ? 'PASS' : 'FAIL', JSON.stringify(badAmount));

  // ── Reject: unknown sender wallet (not on this node) ──
  const unknownSender = await rpc('POST', '/api/transactions/send', { from: 'bx' + '0'.repeat(40), to: walletA.address, amount: 1 * 1e8 });
  record('reject-unknown-sender', unknownSender.success === false ? 'PASS' : 'FAIL', JSON.stringify(unknownSender));

  // ── Continuous mining mode: start, let it mine a couple blocks, stop ──
  const heightBeforeStart = (await rpc('GET', '/api/blockchain/info', null)).height;
  const startRes = bucksNode.startMining(walletA.address);
  record('mining-start', startRes.success ? 'PASS' : 'FAIL', JSON.stringify(startRes));

  await new Promise((r) => setTimeout(r, 1500));

  const statusRunning = await rpc('GET', '/api/mining/status', null);
  record('mining-status-running', statusRunning.running === true && statusRunning.height > heightBeforeStart ? 'PASS' : 'FAIL',
    `${JSON.stringify(statusRunning)} (height should have advanced past ${heightBeforeStart})`);

  const stopRes = bucksNode.stopMining();
  record('mining-stop', stopRes.success ? 'PASS' : 'FAIL', JSON.stringify(stopRes));
  await new Promise((r) => setTimeout(r, 400)); // let the in-flight loop actually exit
  const statusStopped = await rpc('GET', '/api/mining/status', null);
  record('mining-status-stopped', statusStopped.running === false ? 'PASS' : 'FAIL', JSON.stringify(statusStopped));

  // ── Economy / blockchain info sanity ──
  const economy = await rpc('GET', '/api/economy/status', null);
  record('economy-status', economy.ok && economy.supply > 0 && economy.max_supply === 21_000_000 * 1e8 ? 'PASS' : 'FAIL', JSON.stringify(economy));

  // ── Persistence: re-init from the same data dir and confirm chain + wallets survive ──
  const chainDir = path.join(DATA_DIR, 'bucks-chain');
  const heightBeforeRestart = (await rpc('GET', '/api/blockchain/info', null)).height;
  const reinit = bucksNode.init({ dataDir: chainDir }); // NOTE: re-calling init on the same module instance — see caveat below
  record('persistence-across-restart', reinit.height === heightBeforeRestart && reinit.wallets === 2 ? 'PASS' : 'FAIL',
    `Re-init reported height=${reinit.height} (expected ${heightBeforeRestart}), wallets=${reinit.wallets} (expected 2)`);

  console.log('\n===============================================');
  const passed = findings.filter((f) => f.status === 'PASS').length;
  const failed = findings.filter((f) => f.status === 'FAIL').length;
  console.log(`${failed === 0 ? '✅' : '❌'} Bucks Node test complete — ${passed} passed, ${failed} failed`);
  console.log('===============================================\n');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err.message, err.stack);
  process.exit(1);
});
