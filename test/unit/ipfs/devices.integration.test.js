// End-to-end check of device pairing over real Kubo daemons: two embedded nodes (separate
// throw-away profiles), two devices services, pair them both ways, wait for presence, share a
// file from A, receive (and auto-pin) it on B, fetch it over bitswap, unpair, and verify that
// nothing (daemon, timer, child handle) is left behind. Skipped when no Kubo binary is available
// (BUCKS_KUBO_BIN or resources/kubo/linux-x64/ipfs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKubo } from '../../../src/main/ipfs/kubo.js';
import { createDevicesService } from '../../../src/main/ipfs/devices-service.js';
import { stripP2p } from '../../../src/main/ipfs/devices-core.js';
import { makeSettings } from '../devices/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bundled = path.join(repoRoot, 'resources', 'kubo', 'linux-x64', 'ipfs');
const binary = process.env.BUCKS_KUBO_BIN || (process.platform === 'linux' && process.arch === 'x64' ? bundled : null);
const haveBinary = Boolean(binary && fs.existsSync(binary));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLog(name, lines) {
  const rec = (level) => (...a) => lines.push(`${name} ${level}: ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')}`);
  return { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: () => {} };
}

async function waitFor(what, fn, timeoutMs, lines) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}\n${lines.slice(-60).join('\n')}`);
    await sleep(250);
  }
}

function countResources(kind) {
  return process.getActiveResourcesInfo().filter((r) => r === kind).length;
}

test('devices: two Kubo nodes pair over peering + pubsub, share a file, auto-pin, unpair', { skip: haveBinary ? false : 'no Kubo binary (set BUCKS_KUBO_BIN)', timeout: 150_000 }, async (t) => {
  const prevEnv = process.env.BUCKS_KUBO_BIN;
  process.env.BUCKS_KUBO_BIN = binary;
  t.after(() => { if (prevEnv === undefined) delete process.env.BUCKS_KUBO_BIN; else process.env.BUCKS_KUBO_BIN = prevEnv; });

  const lines = [];
  const t0 = Date.now();
  const phase = (name) => t.diagnostic(`${name} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const childrenBefore = countResources('ChildProcess');
  const timersBefore = countResources('Timeout');

  const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-devices-it-a-'));
  const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-devices-it-b-'));

  const settingsA = makeSettings({ devices: { name: 'ubuntu-laptop' } });
  const settingsB = makeSettings({ devices: { name: 'macbook-air', autoPin: true } });
  const kuboA = createKubo({ settings: settingsA, userData: dirA, resourcesDir: path.join(dirA, 'no-resources'), log: makeLog('kuboA', lines) });
  const kuboB = createKubo({ settings: settingsB, userData: dirB, resourcesDir: path.join(dirB, 'no-resources'), log: makeLog('kuboB', lines) });
  const emitsA = [];
  const emitsB = [];
  const svcA = createDevicesService({ kubo: kuboA, settings: settingsA, userData: dirA, appVersion: '2.0.0', platform: 'linux', hostname: 'host-a', emit: (s) => emitsA.push(s), log: makeLog('devA', lines) });
  const svcB = createDevicesService({ kubo: kuboB, settings: settingsB, userData: dirB, appVersion: '2.0.0', platform: 'darwin', hostname: 'host-b', emit: (s) => emitsB.push(s), log: makeLog('devB', lines) });
  // after hooks run in registration order: services, then daemons (never leave one running), then the repos
  t.after(() => Promise.all([svcA.stop(), svcB.stop()]));
  t.after(() => Promise.all([kuboA.stop(), kuboB.stop()]));
  t.after(() => Promise.all([fsp.rm(dirA, { recursive: true, force: true }), fsp.rm(dirB, { recursive: true, force: true })]));

  try {
    await Promise.all([kuboA.start(), kuboB.start()]);
  } catch (e) {
    throw new Error(`${e.message}\n${lines.join('\n')}`);
  }

  // both services subscribe as soon as their node is ready
  const [readyA, readyB] = await Promise.all([
    waitFor('A subscribed', () => { const s = svcA.status(); return s.ready && s.self.peerId ? s : null; }, 30_000, lines),
    waitFor('B subscribed', () => { const s = svcB.status(); return s.ready && s.self.peerId ? s : null; }, 30_000, lines),
  ]);
  assert.equal(readyA.error, null);
  assert.equal(readyA.self.name, 'ubuntu-laptop');
  assert.equal(readyB.self.platform, 'darwin');
  assert.notEqual(readyA.self.peerId, readyB.self.peerId);
  phase('both nodes ready and subscribed');

  // addresses to pair with: what each device advertises (non-loopback). In a container without a
  // LAN interface they can all be filtered; then (test only) use the node's 127.0.0.1 address.
  async function pairAddrs(kubo, status) {
    if (status.self.addrs.length) return { addrs: status.self.addrs, fallback: false };
    const ident = await kubo.rpc.id();
    const loop = ident.Addresses.filter((a) => a.startsWith('/ip4/127.0.0.1/tcp/')).map(stripP2p);
    return { addrs: loop.slice(0, 1), fallback: true };
  }
  const aAddrs = await pairAddrs(kuboA, readyA);
  const bAddrs = await pairAddrs(kuboB, readyB);
  if (aAddrs.fallback || bAddrs.fallback) t.diagnostic('no shareable (non-loopback) address: paired over 127.0.0.1 instead');
  assert.ok(aAddrs.addrs.length && bAddrs.addrs.length);

  const afterPairA = await svcA.pair({ peerId: readyB.self.peerId, addrs: bAddrs.addrs });
  await svcB.pair({ peerId: `${aAddrs.addrs[0]}/p2p/${readyA.self.peerId}` }); // the multiaddr form a user pastes
  assert.deepEqual(settingsA.get().ipfs.peers.map((p) => p.peerId), [readyB.self.peerId]);
  assert.deepEqual(settingsB.get().ipfs.peers.map((p) => [p.peerId, p.addrs]), [[readyA.self.peerId, [aAddrs.addrs[0]]]]);
  assert.equal(afterPairA.paired.length, 1);
  assert.equal(afterPairA.error, null, 'live peering calls succeeded');
  const peeringA = await kuboA.rpc.configGet('Peering.Peers');
  assert.deepEqual(peeringA.map((p) => p.ID), [readyB.self.peerId], 'pairing persisted in the node config');
  const liveA = await kuboA.rpc.call('swarm/peering/ls');
  assert.ok((liveA?.Peers || []).some((p) => p.ID === readyB.self.peerId), 'peer in the live peering set');

  // presence flows both ways (lost until the gossip mesh forms; re-announced every 30 s)
  await Promise.all([
    waitFor('A sees B online', () => svcA.status().paired[0]?.online, 60_000, lines),
    waitFor('B sees A online', () => svcB.status().paired[0]?.online, 60_000, lines),
  ]);
  phase('both see each other online');
  const seenByA = svcA.status().paired[0];
  assert.equal(seenByA.platform, 'darwin');
  assert.equal(seenByA.version, '2.0.0');
  assert.ok(seenByA.lastSeen > 0);
  assert.deepEqual(svcA.status().discovered, [], 'a paired device is not listed as discovered');

  // share a file from A
  const text = `hello from the linux laptop ${Date.now()}\n`;
  const bytes = new TextEncoder().encode(text);
  const added = await kuboA.rpc.add(bytes, { fileName: 'hello.txt', mimeType: 'text/plain' });
  const shareRes = await svcA.share({ cid: added.cid, name: 'hello.txt', size: bytes.length });
  assert.deepEqual(shareRes, { queued: true, onlinePeers: 1 });

  const got = await waitFor('B receives the share', () => svcB.status().received.find((r) => r.cid === added.cid), 60_000, lines);
  assert.equal(got.from, readyA.self.peerId);
  assert.equal(got.name, 'hello.txt');
  assert.equal(got.size, bytes.length);
  assert.equal(got.fromName, 'ubuntu-laptop');

  phase('share received on B');
  // B fetches the bytes from A over bitswap
  const back = await kuboB.rpc.cat(added.cid, { timeoutMs: 30_000 });
  assert.equal(new TextDecoder().decode(back), text);

  // autoPin on B → pinned
  await waitFor('B auto-pins the share', () => svcB.status().received.find((r) => r.cid === added.cid)?.pinned, 30_000, lines);
  const pinsB = await kuboB.rpc.pinLs();
  assert.ok(pinsB.some((p) => p.cid === added.cid), 'share pinned on B');
  await svcB._flush();
  const persisted = JSON.parse(await fsp.readFile(path.join(dirB, 'devices.json'), 'utf8'));
  assert.equal(persisted.received.find((r) => r.cid === added.cid)?.pinned, true, 'pinned flag persisted in devices.json');
  await svcA._flush();
  const outboxA = JSON.parse(await fsp.readFile(path.join(dirA, 'devices.json'), 'utf8')).outbox;
  assert.deepEqual(outboxA.map((s) => s.cid), [added.cid], 'share persisted in A\'s outbox');

  phase('share auto-pinned on B');
  // connected comes from swarm/peers (polled every 15 s)
  await waitFor('A reports B connected', () => svcA.status().paired[0]?.connected, 30_000, lines);

  // status events were emitted throughout
  assert.ok(emitsA.length > 0 && emitsB.length > 0);
  assert.ok(emitsB.some((s) => s.received.some((r) => r.cid === added.cid)));

  // unpair on A
  const afterUnpair = await svcA.unpair(readyB.self.peerId);
  assert.deepEqual(afterUnpair.paired, []);
  assert.equal(afterUnpair.error, null);
  assert.deepEqual(settingsA.get().ipfs.peers, []);
  assert.deepEqual((await kuboA.rpc.configGet('Peering.Peers')) || [], []);
  const liveAfter = await kuboA.rpc.call('swarm/peering/ls');
  assert.ok(!(liveAfter?.Peers || []).some((p) => p.ID === readyB.self.peerId), 'peer removed from the live peering set');
  // B keeps announcing: on A it now shows up as discovered, never as a trusted pairing
  await waitFor('A lists B as discovered after unpairing', () => svcA.status().discovered.some((d) => d.peerId === readyB.self.peerId), 45_000, lines);

  phase('unpaired, B listed as discovered on A');
  // shut everything down; nothing may be left running
  await Promise.all([svcA.stop(), svcB.stop()]);
  await Promise.all([kuboA.stop(), kuboB.stop()]);
  assert.equal(svcA.status().ready, false);
  await sleep(50);
  assert.equal(countResources('ChildProcess'), childrenBefore, 'no Kubo child process left behind');
  assert.ok(countResources('Timeout') <= timersBefore + 1, `no stray timers (have ${countResources('Timeout')}, had ${timersBefore})`); // +1: this test's own timeout
});
