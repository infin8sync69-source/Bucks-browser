import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDevicesService, isPubsubDisabledError } from '../../../src/main/ipfs/devices-service.js';
import { encodeMultibase, TOPIC_ARG } from '../../../src/main/ipfs/devices-core.js';
import { makeSettings, makeClock, makeLog, settle } from './helpers.js';

const SELF = '12D3KooWHyA2SvAPPnrq3woSFacJ1ML37SMW1MM8sjSdCpdaJugs';
const MAC = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const STRANGER = '12D3KooWRBhwfeP2Y4TCx1SM6s9rUoHhR5nTnN4kLjy5oYm6bYjK';
const CID1 = 'bafkreigks6arfsq3xxfpvqrrwonchxcnu6do76auprhhfomao6c273sixm';
const CID2 = 'bafkreib6epubmabzlffdhckpmvsodmjuro6xuaei2qwevs3t52xnlhaatu';
const API = 'http://127.0.0.1:45001';

/** Fake Kubo supervisor + RPC client + pubsub HTTP endpoint. */
function makeKubo({ pubsubDisabled = false, embedded = true } = {}) {
  const listeners = new Set();
  const calls = [];
  const published = [];
  const subs = []; // { controller, signal }
  let ready = false;
  const state = { swarm: [], pinFails: false, failPeering: false, pubsubDisabled, configPeering: null, addresses: [
    `/ip4/127.0.0.1/tcp/4001/p2p/${SELF}`,
    `/ip4/192.168.1.10/tcp/4001/p2p/${SELF}`,
    `/ip4/192.168.1.10/udp/4001/quic-v1/p2p/${SELF}`,
  ] };
  const rpc = {
    async id() { calls.push(['id']); return { ID: SELF, Addresses: state.addresses }; },
    async swarmPeers() { calls.push(['swarm/peers']); return state.swarm.map((peer) => ({ peer, addr: '/ip4/192.168.1.20/tcp/4001', latency: '' })); },
    async pinAdd(cid) {
      calls.push(['pin/add', cid]);
      if (state.pinFails) throw new Error('pin failed');
      return cid;
    },
    async configGet(key) { calls.push(['configGet', key]); return key === 'Peering.Peers' ? state.configPeering : null; },
    async configSet(key, value) { calls.push(['configSet', key, value]); if (key === 'Peering.Peers') state.configPeering = value; return value; },
    async call(cmd, opts = {}) {
      calls.push([cmd, ...(opts.args || [])]);
      if (cmd === 'pubsub/pub') {
        const text = await opts.body.get('file').text();
        published.push(JSON.parse(text));
        return null;
      }
      if (cmd.startsWith('swarm/peering') && state.failPeering) {
        const e = new Error(`Kubo RPC '${cmd}' failed (500): boom`);
        e.kuboMessage = 'boom';
        throw e;
      }
      if (cmd === 'swarm/peering/add' || cmd === 'swarm/peering/rm') return { ID: opts.args[0], Status: 'success' };
      if (cmd === 'swarm/connect') return { Strings: ['connect success'] };
      throw new Error(`unexpected rpc ${cmd}`);
    },
  };
  const kubo = {
    calls, published, subs, state,
    isReady: () => ready,
    get rpc() { return ready ? rpc : null; },
    apiUrl: () => (ready ? API : null),
    status: () => ({ state: ready ? 'ready' : 'stopped', peer_id: ready ? SELF : null, embedded }),
    onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    listenerCount: () => listeners.size,
    setReady(v) { ready = v; for (const cb of listeners) cb(kubo.status()); },
  };
  const fetch = async (url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(url, `${API}/api/v0/pubsub/sub?arg=${TOPIC_ARG}`);
    calls.push(['fetch pubsub/sub']);
    if (state.pubsubDisabled) {
      return new Response(JSON.stringify({ Message: 'experimental pubsub feature not enabled, run daemon with --enable-pubsub-experiment to use', Code: 0, Type: 'error' }), { status: 500 });
    }
    const sub = { signal: init.signal, closed: false };
    const body = new ReadableStream({
      start(controller) {
        sub.controller = controller;
        init.signal.addEventListener('abort', () => { if (!sub.closed) { sub.closed = true; controller.error(new DOMException('aborted', 'AbortError')); } }, { once: true });
      },
    });
    subs.push(sub);
    return new Response(body, { status: 200 });
  };
  /** Push one raw NDJSON line (or a presence object from `from`) into every open subscription. */
  kubo.deliver = (payloadOrLine, from = MAC) => {
    const line = typeof payloadOrLine === 'string'
      ? payloadOrLine
      : JSON.stringify({ from, data: encodeMultibase(JSON.stringify(payloadOrLine)), seqno: 'uAQ', topicIDs: [TOPIC_ARG] });
    for (const s of subs) if (!s.closed) s.controller.enqueue(new TextEncoder().encode(`${line}\n`));
  };
  kubo.endStreams = () => { for (const s of subs) if (!s.closed) { s.closed = true; s.controller.close(); } };
  kubo.openSubs = () => subs.filter((s) => !s.closed).length;
  return { kubo, fetch };
}

function presenceOf(peerId, clock, extra = {}) {
  return { v: 1, type: 'presence', peerId, name: 'macbook-air', platform: 'darwin', version: '2.0.0', addrs: ['/ip4/192.168.1.20/tcp/4001'], shares: [], ts: clock.now(), ...extra };
}

async function setup(t, { settingsInit = {}, kuboOpts = {}, devicesJson } = {}) {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-devices-unit-'));
  if (devicesJson !== undefined) await fsp.writeFile(path.join(userData, 'devices.json'), devicesJson);
  const clock = makeClock();
  const settings = makeSettings(settingsInit);
  const { kubo, fetch } = makeKubo(kuboOpts);
  const log = makeLog();
  const emitted = [];
  const svc = createDevicesService({
    kubo, settings, userData, appVersion: '2.0.0', platform: 'linux', hostname: 'ubuntu-laptop',
    emit: (s) => emitted.push(s), log, now: clock.now, timers: clock.timers, fetch,
  });
  // after hooks run in order: stop (flushes devices.json) before the profile is removed
  t.after(() => svc.stop());
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));
  return { svc, kubo, settings, clock, log, emitted, userData };
}

async function goReady(env) {
  env.kubo.setReady(true);
  await settle(20);
}

test('isPubsubDisabledError', () => {
  assert.ok(isPubsubDisabledError('experimental pubsub feature not enabled, run daemon with --enable-pubsub-experiment to use'));
  assert.ok(!isPubsubDisabledError('connection refused'));
});

test('status before the node is ready', async (t) => {
  const { svc, kubo } = await setup(t);
  const s = svc.status();
  assert.deepEqual(s, {
    ready: false,
    error: null,
    topic: 'bucks-devices-v1',
    self: { peerId: null, name: 'ubuntu-laptop', platform: 'linux', version: '2.0.0', addrs: [] },
    paired: [],
    discovered: [],
    received: [],
  });
  assert.equal(kubo.calls.length, 0, 'nothing touches the node before it is ready');
});

test('when the node becomes ready: subscribe, publish presence, report self', async (t) => {
  const env = await setup(t);
  await goReady(env);
  const { svc, kubo } = env;
  const s = svc.status();
  assert.equal(s.ready, true);
  assert.equal(s.self.peerId, SELF);
  assert.deepEqual(s.self.addrs, ['/ip4/192.168.1.10/tcp/4001', '/ip4/192.168.1.10/udp/4001/quic-v1']);
  assert.equal(kubo.openSubs(), 1);
  assert.equal(kubo.published.length, 1, 'presence published right after subscribing');
  const p = kubo.published[0];
  assert.deepEqual(p, { v: 1, type: 'presence', peerId: SELF, name: 'ubuntu-laptop', platform: 'linux', version: '2.0.0', addrs: s.self.addrs, shares: [], ts: env.clock.now() });

  // one follow-up shortly after subscribing (covers the gossip mesh forming), then every 30 s
  await env.clock.advance(4_000);
  assert.equal(kubo.published.length, 2);
  await env.clock.advance(26_000);
  assert.equal(kubo.published.length, 3);
  await env.clock.advance(30_000);
  assert.equal(kubo.published.length, 4);
  // throttled emits happened and the last one reflects the ready state
  await env.clock.advance(300);
  assert.equal(env.emitted.at(-1).ready, true);
});

test('presence from unpaired peers is "discovered"; own and invalid messages are ignored', async (t) => {
  const env = await setup(t);
  await goReady(env);
  const { kubo, svc, clock } = env;
  kubo.deliver(presenceOf(SELF, clock), SELF); // our own message comes back from Kubo
  kubo.deliver('{"garbage":');
  kubo.deliver(presenceOf(MAC, clock), STRANGER); // peerId ≠ from
  kubo.deliver(presenceOf(STRANGER, clock, { name: 'neighbour', shares: [{ cid: CID1, name: 'x', size: 1, ts: clock.now() }] }), STRANGER);
  await settle(20);
  const s = svc.status();
  assert.deepEqual(s.discovered.map((d) => [d.peerId, d.name]), [[STRANGER, 'neighbour']]);
  assert.deepEqual(s.received, [], 'unpaired peers can never add shares');
  assert.deepEqual(s.paired, []);
  // discovered entries expire after 5 minutes
  await clock.advance(5 * 60_000 + 1000);
  assert.deepEqual(svc.status().discovered, []);
});

test('pairing: settings, live peering, config; presence makes the device online; shares are received and persisted', async (t) => {
  const env = await setup(t);
  await goReady(env);
  const { kubo, svc, clock, settings, userData } = env;

  // seen first as discovered → pairing by bare peer ID learns its name and addrs
  kubo.deliver(presenceOf(MAC, clock));
  await settle(20);
  assert.equal(svc.status().discovered.length, 1);
  const before = kubo.published.length;
  const st = await svc.pair({ peerId: MAC });
  assert.deepEqual(settings.get().ipfs.peers, [{ peerId: MAC, name: 'macbook-air', addrs: ['/ip4/192.168.1.20/tcp/4001'] }]);
  assert.deepEqual(st.discovered, []);
  assert.equal(st.paired.length, 1);
  assert.equal(st.paired[0].online, true);
  assert.equal(st.paired[0].platform, 'darwin');
  assert.ok(kubo.calls.some((c) => c[0] === 'swarm/peering/add' && c[1] === `/ip4/192.168.1.20/tcp/4001/p2p/${MAC}`));
  assert.deepEqual(kubo.state.configPeering, [{ ID: MAC, Addrs: ['/ip4/192.168.1.20/tcp/4001'] }]);
  await settle(20);
  assert.ok(kubo.published.length > before, 'presence published after pairing');

  // connected comes from swarm/peers (polled every 15 s, and shortly after pairing)
  await clock.advance(5000); // let the post-pair follow-up publish go out
  kubo.state.swarm = [MAC];
  const pubsBeforeConnect = kubo.published.length;
  await clock.advance(15_000);
  assert.equal(svc.status().paired[0].connected, true);
  assert.ok(kubo.published.length > pubsBeforeConnect, 'presence re-announced when a paired device connects');

  // a share from the paired device
  const shareTs = clock.now() - 5;
  kubo.deliver(presenceOf(MAC, clock, { shares: [{ cid: CID1, name: 'notes.txt', size: 12, ts: shareTs }] }));
  await settle(20);
  let s = svc.status();
  assert.deepEqual(s.received, [{ cid: CID1, name: 'notes.txt', size: 12, from: MAC, fromName: 'macbook-air', ts: shareTs, pinned: false }]);
  assert.equal(kubo.calls.filter((c) => c[0] === 'pin/add').length, 0, 'autoPin is off');
  // re-announcement does not duplicate
  kubo.deliver(presenceOf(MAC, clock, { shares: [{ cid: CID1, name: 'notes.txt', size: 12, ts: shareTs }] }));
  await settle(20);
  assert.equal(svc.status().received.length, 1);
  await svc._flush();
  const file = JSON.parse(await fsp.readFile(path.join(userData, 'devices.json'), 'utf8'));
  assert.equal(file.received.length, 1);
  assert.deepEqual(file.outbox, []);

  // goes offline after 90 s without presence
  await clock.advance(91_000);
  s = svc.status();
  assert.equal(s.paired[0].online, false);
  assert.ok(s.paired[0].lastSeen > 0);

  // dismiss removes it and it does not come back while the sender keeps announcing it
  s = await svc.dismiss({ cid: CID1, from: MAC });
  assert.deepEqual(s.received, []);
  kubo.deliver(presenceOf(MAC, clock, { shares: [{ cid: CID1, name: 'notes.txt', size: 12, ts: shareTs }] }));
  await settle(20);
  assert.deepEqual(svc.status().received, []);
});

test('pair input forms, validation and failure handling', async (t) => {
  const env = await setup(t);
  await goReady(env);
  const { kubo, svc, settings } = env;
  await assert.rejects(svc.pair({ peerId: SELF }), /this device/);
  await assert.rejects(svc.pair({ peerId: 'hello' }), /not a peer ID/);
  await assert.rejects(svc.pair({ peerId: MAC, addrs: 'x' }), /addrs must be an array/);
  await assert.rejects(svc.pair(null), /expects/);

  // multiaddr form + extra addrs + name
  await svc.pair({ peerId: `/ip4/10.0.0.5/tcp/4001/p2p/${MAC}`, name: '  Mac  ', addrs: [`/ip4/10.0.0.5/udp/4001/quic-v1/p2p/${MAC}`, 'junk'] });
  assert.deepEqual(settings.get().ipfs.peers, [{ peerId: MAC, name: 'Mac', addrs: ['/ip4/10.0.0.5/tcp/4001', '/ip4/10.0.0.5/udp/4001/quic-v1'] }]);
  assert.equal(kubo.calls.filter((c) => c[0] === 'swarm/peering/add').length, 2);

  // pairing again replaces the entry (no duplicates)
  await svc.pair({ peerId: MAC, name: 'Mac 2' });
  assert.deepEqual(settings.get().ipfs.peers.map((p) => [p.peerId, p.name, p.addrs.length]), [[MAC, 'Mac 2', 2]]);

  // unknown peer with no addrs → swarm/connect /p2p/<id>
  await svc.pair({ peerId: STRANGER });
  await settle(10);
  assert.ok(kubo.calls.some((c) => c[0] === 'swarm/connect' && c[1] === `/p2p/${STRANGER}`));
  assert.equal(settings.get().ipfs.peers.length, 2);
  assert.deepEqual(kubo.state.configPeering.map((p) => p.ID), [MAC, STRANGER]);

  // live calls fail → settings change kept, error surfaced briefly
  kubo.state.failPeering = true;
  const st = await svc.pair({ peerId: `/ip4/10.0.0.9/tcp/4001/p2p/${MAC}` });
  assert.match(st.error, /Paired, but the IPFS node rejected: peering \/ip4\/10.0.0.9\/tcp\/4001: boom/);
  assert.deepEqual(settings.get().ipfs.peers.find((p) => p.peerId === MAC).addrs, ['/ip4/10.0.0.9/tcp/4001']);
  await env.clock.advance(16_000);
  assert.equal(svc.status().error, null, 'transient error clears');

  // unpair
  kubo.state.failPeering = false;
  const after = await svc.unpair(MAC);
  assert.deepEqual(after.paired.map((p) => p.peerId), [STRANGER]);
  assert.ok(kubo.calls.some((c) => c[0] === 'swarm/peering/rm' && c[1] === MAC));
  assert.deepEqual(kubo.state.configPeering.map((p) => p.ID), [STRANGER]);
  await assert.rejects(svc.unpair('nope'), /valid peer ID/);
});

test('pairing while the node is offline only changes settings', async (t) => {
  const env = await setup(t);
  const st = await env.svc.pair({ peerId: `/ip4/10.0.0.5/tcp/4001/p2p/${MAC}` });
  assert.equal(st.paired.length, 1);
  assert.equal(env.kubo.calls.length, 0);
  // once the node is ready, the paired peers are put back in the live peering set
  await goReady(env);
  assert.ok(env.kubo.calls.some((c) => c[0] === 'swarm/peering/add' && c[1] === `/ip4/10.0.0.5/tcp/4001/p2p/${MAC}`));
});

test('a paired device advertising new addrs updates settings and peering, without rewriting unchanged settings', async (t) => {
  const env = await setup(t, { settingsInit: { ipfs: { peers: [{ peerId: MAC, name: 'Mac', addrs: ['/ip4/192.168.1.20/tcp/4001'] }] } } });
  await goReady(env);
  const { kubo, settings, clock } = env;
  const setsBefore = settings.sets.length;
  kubo.deliver(presenceOf(MAC, clock));
  await settle(20);
  assert.equal(settings.sets.length, setsBefore, 'same addrs → no settings write');
  kubo.deliver(presenceOf(MAC, clock, { addrs: ['/ip4/192.168.1.77/tcp/4001'] }));
  await settle(20);
  assert.equal(settings.sets.length, setsBefore + 1);
  assert.deepEqual(settings.get().ipfs.peers, [{ peerId: MAC, name: 'Mac', addrs: ['/ip4/192.168.1.77/tcp/4001'] }]);
  assert.ok(kubo.calls.some((c) => c[0] === 'swarm/peering/add' && c[1] === `/ip4/192.168.1.77/tcp/4001/p2p/${MAC}`));
  assert.deepEqual(kubo.state.configPeering, [{ ID: MAC, Addrs: ['/ip4/192.168.1.77/tcp/4001'] }]);
  // the user-chosen name is kept; the status shows it
  assert.equal(env.svc.status().paired[0].name, 'Mac');
  // empty advertised addrs never wipe the stored ones
  kubo.deliver(presenceOf(MAC, clock, { addrs: [] }));
  await settle(20);
  assert.equal(settings.sets.length, setsBefore + 1);
});

test('a device paired by bare peer ID gets its name from its first presence (one settings write)', async (t) => {
  const env = await setup(t);
  await goReady(env);
  const { kubo, settings, clock, svc } = env;
  await svc.pair({ peerId: `/ip4/192.168.1.20/tcp/4001/p2p/${MAC}` });
  assert.equal(settings.get().ipfs.peers[0].name, '');
  assert.match(svc.status().paired[0].name, /^12D3KooW…/);
  const setsBefore = settings.sets.length;
  kubo.deliver(presenceOf(MAC, clock));
  await settle(20);
  kubo.deliver(presenceOf(MAC, clock, { name: 'renamed-later' }));
  await settle(20);
  assert.equal(settings.sets.length, setsBefore + 1);
  assert.deepEqual(settings.get().ipfs.peers, [{ peerId: MAC, name: 'macbook-air', addrs: ['/ip4/192.168.1.20/tcp/4001'] }]);
  assert.equal(svc.status().paired[0].name, 'macbook-air');
});

test('autoPin pins shares from paired devices and marks them pinned; failures retry later', async (t) => {
  const env = await setup(t, { settingsInit: { devices: { autoPin: true }, ipfs: { peers: [{ peerId: MAC, name: 'Mac', addrs: [] }] } } });
  await goReady(env);
  const { kubo, svc, clock } = env;
  kubo.state.pinFails = true;
  const shares = [{ cid: CID1, name: 'a', size: 1, ts: clock.now() }];
  kubo.deliver(presenceOf(MAC, clock, { shares }));
  await settle(20);
  assert.equal(kubo.calls.filter((c) => c[0] === 'pin/add').length, 1);
  assert.equal(svc.status().received[0].pinned, false);
  kubo.deliver(presenceOf(MAC, clock, { shares }));
  await settle(20);
  assert.equal(kubo.calls.filter((c) => c[0] === 'pin/add').length, 1, 'no immediate retry');
  kubo.state.pinFails = false;
  await clock.advance(5 * 60_000 + 1);
  kubo.deliver(presenceOf(MAC, clock, { shares }));
  await settle(20);
  assert.equal(kubo.calls.filter((c) => c[0] === 'pin/add').length, 2);
  assert.equal(svc.status().received[0].pinned, true);
  // the emitted status shows the pin
  await clock.advance(300);
  assert.equal(env.emitted.at(-1).received[0].pinned, true);
});

test('share validates the CID, persists the outbox and announces it', async (t) => {
  const env = await setup(t, { settingsInit: { ipfs: { peers: [{ peerId: MAC, name: 'Mac', addrs: [] }] } } });
  await goReady(env);
  const { kubo, svc, clock, userData } = env;
  await assert.rejects(svc.share({ cid: 'not-a-cid' }), /Not a valid CID/);
  await assert.rejects(svc.share({ cid: CID1, size: -1 }), /size/);
  let r = await svc.share({ cid: CID1, name: 'photo.jpg', size: 2048 });
  assert.deepEqual(r, { queued: true, onlinePeers: 0 });
  await settle(20);
  assert.deepEqual(kubo.published.at(-1).shares, [{ cid: CID1, name: 'photo.jpg', size: 2048, ts: clock.now() }]);
  kubo.deliver(presenceOf(MAC, clock));
  await settle(20);
  r = await svc.share({ cid: CID2 });
  assert.equal(r.onlinePeers, 1);
  await settle(20);
  assert.deepEqual(kubo.published.at(-1).shares.map((s) => s.cid), [CID2, CID1]);
  await svc._flush();
  const file = JSON.parse(await fsp.readFile(path.join(userData, 'devices.json'), 'utf8'));
  assert.deepEqual(file.outbox.map((s) => s.cid), [CID2, CID1]);
  // shares older than 7 days drop out of the presence
  await clock.advance(7 * 24 * 3600_000 + 60_000);
  assert.deepEqual(kubo.published.at(-1).shares, []);
});

test('rename trims, caps at 64 chars and falls back to the host name', async (t) => {
  const env = await setup(t);
  await goReady(env);
  const { svc, settings, kubo } = env;
  let s = await svc.rename('  Studio Mac  ');
  assert.equal(s.self.name, 'Studio Mac');
  assert.equal(settings.get().devices.name, 'Studio Mac');
  await settle(20);
  assert.equal(kubo.published.at(-1).name, 'Studio Mac');
  s = await svc.rename('x'.repeat(100));
  assert.equal(s.self.name.length, 64);
  s = await svc.rename('');
  assert.equal(s.self.name, 'ubuntu-laptop');
  await assert.rejects(svc.rename(5), /must be a string/);
});

test('subscription: resubscribes with backoff when the stream ends; pubsub disabled → clear error and slow retry', async (t) => {
  const env = await setup(t, { kuboOpts: { pubsubDisabled: true, embedded: false } });
  await goReady(env);
  const { kubo, svc, clock } = env;
  let s = svc.status();
  assert.equal(s.ready, false);
  assert.match(s.error, /Pubsub is disabled on the external IPFS node/);
  const fetches = () => kubo.calls.filter((c) => c[0] === 'fetch pubsub/sub').length;
  assert.equal(fetches(), 1);
  await clock.advance(29_000);
  assert.equal(fetches(), 1, 'slow retry while pubsub is disabled');
  kubo.state.pubsubDisabled = false;
  await clock.advance(1_000);
  assert.equal(fetches(), 2);
  s = svc.status();
  assert.equal(s.ready, true);
  assert.equal(s.error, null);

  // stream ends → retry after 1 s; immediate failures back off 1 s, 2 s, 5 s, 10 s
  kubo.endStreams();
  await settle(20);
  assert.equal(svc.status().ready, false);
  await clock.advance(999);
  assert.equal(fetches(), 2);
  await clock.advance(1);
  assert.equal(fetches(), 3);
  assert.equal(svc.status().ready, true);
});

test('node stopping aborts the stream and timers; stop() leaves nothing scheduled', async (t) => {
  const env = await setup(t);
  await goReady(env);
  const { kubo, svc, clock } = env;
  assert.equal(kubo.openSubs(), 1);
  kubo.setReady(false);
  await settle(20);
  assert.equal(kubo.openSubs(), 0, 'stream aborted');
  assert.equal(svc.status().ready, false);
  await clock.advance(300); // let the throttled emit fire
  assert.equal(clock.pendingCount(), 0, 'no session timers while the node is down');
  // back up → new session
  await goReady(env);
  assert.equal(kubo.openSubs(), 1);
  await svc.stop();
  assert.equal(kubo.openSubs(), 0);
  assert.equal(clock.pendingCount(), 0, 'stop() clears every timer');
  assert.equal(kubo.listenerCount(), 0, 'kubo listener removed');
  assert.equal(env.settings.listenerCount(), 0, 'settings listener removed');
  assert.equal(env.emitted.at(-1).ready, false, 'final emit');
});

test('emits are throttled to at most 4 per second, with a trailing emit of the latest state', async (t) => {
  const env = await setup(t, { settingsInit: { ipfs: { peers: [{ peerId: MAC, name: 'Mac', addrs: [] }] } } });
  await goReady(env);
  const { kubo, clock } = env;
  await clock.advance(1000);
  const start = env.emitted.length;
  for (let i = 0; i < 40; i += 1) {
    kubo.deliver(presenceOf(MAC, clock, { name: `mac-${i}` }));
    await settle(3);
    await clock.advance(25); // 40 messages over 1 s
  }
  await clock.advance(1000);
  const n = env.emitted.length - start;
  assert.ok(n >= 3 && n <= 6, `expected ~4-5 emits for 1 s of changes, got ${n}`);
  assert.equal(env.emitted.at(-1).paired[0].lastSeen, clock.now() - 1025, 'trailing emit carries the last presence');
});

test('devices.json: loads valid data, tolerates a corrupt file, writes atomically', async (t) => {
  const corrupt = await setup(t, { devicesJson: '{not json' });
  assert.deepEqual(corrupt.svc.status().received, []);
  assert.ok(corrupt.log.lines.some(([lvl, l]) => lvl === 'warn' && /corrupt/.test(l)));

  const now = Date.now();
  const valid = await setup(t, {
    devicesJson: JSON.stringify({
      outbox: [{ cid: CID1, name: 'a', size: 1, ts: 1_792_300_000_000 - 1000 }],
      received: [{ cid: CID2, name: 'b', size: null, from: MAC, fromName: 'Mac', ts: now, pinned: true }, { cid: 'junk', from: MAC, ts: 1 }],
    }),
    settingsInit: { ipfs: { peers: [{ peerId: MAC, name: 'Mac', addrs: [] }] } },
  });
  assert.deepEqual(valid.svc.status().received.map((r) => [r.cid, r.pinned]), [[CID2, true]]);
  await goReady(valid);
  assert.deepEqual(valid.kubo.published.at(-1).shares.map((s) => s.cid), [CID1]);
  // a received share loaded from disk is not re-added when the sender announces it again
  valid.kubo.deliver(presenceOf(MAC, valid.clock, { shares: [{ cid: CID2, name: 'b', ts: now }] }));
  await settle(20);
  assert.equal(valid.svc.status().received.length, 1);
  await valid.svc.dismiss({ cid: CID2, from: MAC });
  await valid.svc.stop();
  const files = fs.readdirSync(valid.userData);
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
  const back = JSON.parse(fs.readFileSync(path.join(valid.userData, 'devices.json'), 'utf8'));
  assert.deepEqual(back.received, []);
  assert.ok(back.seen.some((x) => x.cid === CID2), 'dismissed share stays known as seen');
});
