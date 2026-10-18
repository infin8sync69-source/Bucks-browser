import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPIC,
  TOPIC_ARG,
  MAX_PAYLOAD_BYTES,
  encodeTopicArg,
  encodeMultibase,
  decodeMultibaseData,
  normalizePeerId,
  isValidCid,
  stripP2p,
  sanitizeAddrs,
  shareableAddrs,
  parsePairInput,
  parseMessage,
  buildPresence,
  encodePresence,
  pruneOutbox,
  addToOutbox,
  sanitizeReceived,
  sanitizeSeen,
  mergeReceived,
  dismissReceived,
  isOnline,
  isDiscoveredFresh,
  pruneDiscovered,
  sameAddrSet,
  mergePeeringPeers,
  OUTBOX_MAX_AGE_MS,
} from '../../../src/main/ipfs/devices-core.js';

const A = '12D3KooWHyA2SvAPPnrq3woSFacJ1ML37SMW1MM8sjSdCpdaJugs';
const B = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const A_K51 = 'k51qzi5uqu5dj79gxu5ohkq8tc31lqxzvxi30p7jzeuidxbyfo4qzxdq6uv3kg';
const CID1 = 'bafkreigks6arfsq3xxfpvqrrwonchxcnu6do76auprhhfomao6c273sixm';
const CID2 = 'bafkreib6epubmabzlffdhckpmvsodmjuro6xuaei2qwevs3t52xnlhaatu';
const CID3 = 'bafkreibopuwahkkqplrgl3hvwu2wrbnfgoj2eau5eqjzjglsmwq2ewxpyy';
const NOW = 1_792_300_000_000;

async function makeCids(n) {
  const { CID } = await import('multiformats/cid');
  const { sha256 } = await import('multiformats/hashes/sha2');
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(CID.create(1, 0x55, await sha256.digest(new TextEncoder().encode(`share-${i}`))).toString());
  return out;
}

function presence(overrides = {}) {
  return { v: 1, type: 'presence', peerId: B, name: 'mac', platform: 'darwin', version: '2.0.0', addrs: ['/ip4/192.168.1.20/tcp/40785'], shares: [], ts: NOW, ...overrides };
}

function line(payload, { from = B, topicIDs = [TOPIC_ARG] } = {}) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.stringify({ from, data: encodeMultibase(data), seqno: 'uAAAAAQ', topicIDs });
}

test('topic encoding matches what Kubo expects', () => {
  assert.equal(TOPIC, 'bucks-devices-v1');
  assert.equal(encodeTopicArg(), 'uYnVja3MtZGV2aWNlcy12MQ');
  assert.equal(TOPIC_ARG, 'uYnVja3MtZGV2aWNlcy12MQ');
  assert.equal(encodeTopicArg('a?'), 'uYT8'); // base64url alphabet, no padding
  assert.ok(!encodeTopicArg('ab').includes('='));
});

test('decodeMultibaseData', () => {
  assert.equal(decodeMultibaseData('uaGVsbG8').toString(), 'hello');
  assert.equal(decodeMultibaseData('u').length, 0);
  assert.equal(decodeMultibaseData(encodeMultibase('ünï~?>')).toString(), 'ünï~?>');
  assert.equal(decodeMultibaseData('aGVsbG8'), null); // no multibase prefix
  assert.equal(decodeMultibaseData('maGVsbG8='), null); // other bases are not used by Kubo here
  assert.equal(decodeMultibaseData('uaGV+bG8'), null); // '+' is not base64url
  assert.equal(decodeMultibaseData(null), null);
});

test('normalizePeerId / isValidCid', () => {
  assert.equal(normalizePeerId(A), A);
  assert.equal(normalizePeerId(` ${A} `), A);
  assert.equal(normalizePeerId(A_K51), A); // CIDv1 libp2p-key → base58btc
  assert.equal(normalizePeerId(CID1), null); // a content CID is not a peer id
  assert.equal(normalizePeerId('12D3KooWnotreal'), null);
  assert.equal(normalizePeerId(`${A}x`), null);
  assert.equal(normalizePeerId(''), null);
  assert.equal(normalizePeerId(42), null);
  assert.ok(isValidCid(CID1));
  assert.ok(isValidCid('QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB'));
  assert.ok(!isValidCid('bafy-not-a-cid'));
  assert.ok(!isValidCid(''));
  assert.ok(!isValidCid(undefined));
});

test('stripP2p and sanitizeAddrs', () => {
  assert.equal(stripP2p(`/ip4/10.0.0.2/tcp/4001/p2p/${A}`), '/ip4/10.0.0.2/tcp/4001');
  assert.equal(stripP2p(`/ip4/10.0.0.2/tcp/4001/ipfs/${A}`), '/ip4/10.0.0.2/tcp/4001');
  assert.equal(stripP2p('/ip4/10.0.0.2/tcp/4001'), '/ip4/10.0.0.2/tcp/4001');
  assert.equal(stripP2p(`/ip4/1.2.3.4/tcp/1/p2p/${B}/p2p-circuit/p2p/${A}`), `/ip4/1.2.3.4/tcp/1/p2p/${B}/p2p-circuit`);
  assert.deepEqual(
    sanitizeAddrs(['/ip4/10.0.0.2/tcp/4001', `/ip4/10.0.0.2/tcp/4001/p2p/${A}`, 'nope', 7, '/ip4/1.1.1.1/tcp/1 x', `/${'a'.repeat(400)}`, '/ip6/fd00::1/udp/1/quic-v1']),
    ['/ip4/10.0.0.2/tcp/4001', '/ip6/fd00::1/udp/1/quic-v1'],
  );
  assert.equal(sanitizeAddrs(Array.from({ length: 40 }, (_, i) => `/ip4/10.0.0.${i}/tcp/1`)).length, 16);
  assert.deepEqual(sanitizeAddrs('not an array'), []);
});

test('shareableAddrs drops loopback, unspecified, link-local, relay and certhash addrs, strips /p2p, dedupes, caps at 16', () => {
  const id = [
    `/ip4/127.0.0.1/tcp/4001/p2p/${A}`,
    `/ip4/127.8.9.1/udp/4001/quic-v1/p2p/${A}`,
    `/ip6/::1/tcp/4001/p2p/${A}`,
    `/ip4/192.168.1.20/tcp/4001/p2p/${A}`,
    `/ip4/192.168.1.20/tcp/4001/p2p/${A}`,
    `/ip4/192.168.1.20/udp/4001/quic-v1/p2p/${A}`,
    `/ip6/fe80::1/tcp/4001/p2p/${A}`,
    `/ip6/2001:db8::5/tcp/4001/p2p/${A}`,
    `/ip4/1.2.3.4/tcp/4001/p2p/${B}/p2p-circuit/p2p/${A}`,
    '/ip4/0.0.0.0/tcp/4001',
    `/ip4/192.168.1.20/udp/4001/quic-v1/webtransport/certhash/uEiDvqTw2e3UMyiGQvOxDo2d-zC0DNZTB61yi-v1A9i3BXg/p2p/${A}`,
    '/ip4/192.168.1.20/udp/4001/webrtc-direct/certhash/uEiC09KTW--VIU9UbeGz0OHHQmSrhAWyXw7yroPGT1N587A',
  ];
  assert.deepEqual(shareableAddrs(id), ['/ip4/192.168.1.20/tcp/4001', '/ip4/192.168.1.20/udp/4001/quic-v1', '/ip6/2001:db8::5/tcp/4001']);
  assert.equal(shareableAddrs(Array.from({ length: 30 }, (_, i) => `/ip4/10.1.0.${i}/tcp/4001`)).length, 16);
  assert.deepEqual(shareableAddrs(null), []);
  assert.deepEqual(shareableAddrs([`/ip4/127.0.0.1/tcp/1/p2p/${A}`]), []);
});

test('parsePairInput accepts a peer id or a /p2p multiaddr', () => {
  assert.deepEqual(parsePairInput(A), { peerId: A, addrs: [] });
  assert.deepEqual(parsePairInput(`  ${A_K51} `), { peerId: A, addrs: [] });
  assert.deepEqual(parsePairInput(`/ip4/192.168.1.20/tcp/40785/p2p/${A}`), { peerId: A, addrs: ['/ip4/192.168.1.20/tcp/40785'] });
  assert.deepEqual(parsePairInput(`/ip4/192.168.1.20/tcp/40785/ipfs/${A}`), { peerId: A, addrs: ['/ip4/192.168.1.20/tcp/40785'] });
  assert.deepEqual(parsePairInput(`/p2p/${A}`), { peerId: A, addrs: [] });
  assert.deepEqual(parsePairInput(`/dns4/mac.local/udp/4001/quic-v1/p2p/${A}`), { peerId: A, addrs: ['/dns4/mac.local/udp/4001/quic-v1'] });
  assert.deepEqual(parsePairInput(`/ip4/1.2.3.4/tcp/1/p2p/${B}/p2p-circuit/p2p/${A}`), { peerId: A, addrs: [`/ip4/1.2.3.4/tcp/1/p2p/${B}/p2p-circuit`] });
  assert.throws(() => parsePairInput(''), /must not be empty/);
  assert.throws(() => parsePairInput(undefined), /must be a string/);
  assert.throws(() => parsePairInput('/ip4/192.168.1.20/tcp/40785'), /must end with \/p2p\/<peer ID>/);
  assert.throws(() => parsePairInput('/ip4/1.2.3.4/tcp/1/p2p/notapeer'), /not a valid peer ID/);
  assert.throws(() => parsePairInput(CID1), /not a peer ID or a \/p2p\/ multiaddr/);
  assert.throws(() => parsePairInput('hello world'), /not a peer ID/);
});

test('parseMessage accepts a valid presence and normalises it', () => {
  const shares = [{ cid: CID1, name: 'notes.txt', size: 1234, ts: NOW - 10 }, { cid: CID2, ts: NOW - 5 }];
  const msg = parseMessage(line(presence({ shares, addrs: [`/ip4/192.168.1.20/tcp/40785/p2p/${B}`] })), { selfPeerId: A });
  assert.deepEqual(msg, {
    from: B,
    peerId: B,
    name: 'mac',
    platform: 'darwin',
    version: '2.0.0',
    addrs: ['/ip4/192.168.1.20/tcp/40785'],
    shares: [{ cid: CID1, name: 'notes.txt', size: 1234, ts: NOW - 10 }, { cid: CID2, name: CID2, size: null, ts: NOW - 5 }],
    ts: NOW,
  });
  // object input works too, topicIDs optional, platform/version optional
  const raw = JSON.parse(line(presence({ platform: undefined, version: undefined })));
  delete raw.topicIDs;
  const m2 = parseMessage(raw);
  assert.equal(m2.platform, '');
  assert.equal(m2.version, '');
  assert.ok(parseMessage(line(presence(), { topicIDs: [TOPIC] })));
});

test('parseMessage rejects invalid or untrusted messages', () => {
  const bad = [
    ['own message', line(presence({ peerId: A }), { from: A }), { selfPeerId: A }],
    ['peerId ≠ from', line(presence({ peerId: A }))],
    ['bad from', line(presence(), { from: 'nope' })],
    ['other topic', line(presence(), { topicIDs: ['uZm9v'] })],
    ['not json line', '{nope'],
    ['payload not json', line('hello')],
    ['payload array', line([1, 2])],
    ['wrong type', line(presence({ type: 'chat' }))],
    ['wrong version', line(presence({ v: 2 }))],
    ['name too long', line(presence({ name: 'x'.repeat(65) }))],
    ['name missing', line(presence({ name: undefined }))],
    ['ts missing', line(presence({ ts: undefined }))],
    ['too many addrs', line(presence({ addrs: Array.from({ length: 17 }, (_, i) => `/ip4/10.0.0.${i}/tcp/1`) }))],
    ['addr without slash', line(presence({ addrs: ['ip4/10.0.0.1/tcp/1'] }))],
    ['addr too long', line(presence({ addrs: [`/${'a'.repeat(300)}`] }))],
    ['addr not a string', line(presence({ addrs: [5] }))],
    ['too many shares', line(presence({ shares: Array.from({ length: 21 }, (_, i) => ({ cid: CID1, ts: NOW + i })) }))],
    ['share with bad cid', line(presence({ shares: [{ cid: 'bafy-nope', ts: NOW }] }))],
    ['share with bad size', line(presence({ shares: [{ cid: CID1, ts: NOW, size: -1 }] }))],
    ['share without ts', line(presence({ shares: [{ cid: CID1 }] }))],
    ['platform too long', line(presence({ platform: 'p'.repeat(40) }))],
  ];
  for (const [label, l, opts] of bad) assert.equal(parseMessage(l, opts), null, label);
  // oversized payload (> 16 KiB)
  const huge = line(presence({ name: 'ok', pad: 'x'.repeat(MAX_PAYLOAD_BYTES) }));
  assert.equal(parseMessage(huge), null, 'oversized payload');
  // data field not multibase
  const notMb = JSON.stringify({ from: B, data: Buffer.from(JSON.stringify(presence())).toString('base64'), topicIDs: [TOPIC_ARG] });
  assert.equal(parseMessage(notMb), null, 'non-multibase data');
  // invalid utf-8
  assert.equal(parseMessage(JSON.stringify({ from: B, data: `u${Buffer.from([0xff, 0xfe]).toString('base64url')}` })), null);
});

test('buildPresence produces a payload parseMessage accepts, within 16 KiB', async () => {
  const shares = Array.from({ length: 25 }, (_, i) => ({ cid: [CID1, CID2, CID3][i % 3], name: `f${i}`, size: i, ts: NOW - i }));
  const p = buildPresence({ peerId: B, name: '  mac\u0000book  ', platform: 'darwin', version: '2.0.0', addrs: [`/ip4/10.0.0.2/tcp/1/p2p/${B}`, '/ip4/10.0.0.2/tcp/1'], shares, ts: NOW });
  assert.equal(p.v, 1);
  assert.equal(p.type, 'presence');
  assert.equal(p.name, 'macbook');
  assert.deepEqual(p.addrs, ['/ip4/10.0.0.2/tcp/1']);
  assert.equal(p.shares.length, 3); // deduped on cid (newest kept)
  assert.equal(p.shares[0].ts, NOW); // newest first
  const back = parseMessage(line(encodePresence(p)));
  assert.equal(back.peerId, B);
  assert.equal(back.name, 'macbook');

  // shares with huge names get dropped until the payload fits
  // (only multi-byte names can push a payload within the per-field limits over 16 KiB)
  const fatShares = (await makeCids(20)).map((cid, i) => ({ cid, name: '€'.repeat(255), ts: NOW - i }));
  const fp = buildPresence({ peerId: B, name: 'x', addrs: Array.from({ length: 16 }, (_, i) => `/ip4/10.0.0.${i}/tcp/1/${'a'.repeat(250)}`), shares: fatShares, ts: NOW });
  assert.ok(Buffer.byteLength(encodePresence(fp)) <= MAX_PAYLOAD_BYTES);
  assert.ok(fp.shares.length < 20 && fp.shares.length > 0);
  assert.ok(parseMessage(line(encodePresence(fp))));

  assert.throws(() => buildPresence({ peerId: 'nope', ts: NOW }), /valid peerId/);
});

test('outbox: 7 days, max 20, newest first, dedupe on cid', async () => {
  const old = { cid: CID1, name: 'old', size: 1, ts: NOW - OUTBOX_MAX_AGE_MS - 1 };
  const keep = { cid: CID2, name: 'keep', size: 2, ts: NOW - 1000 };
  assert.deepEqual(pruneOutbox([old, keep, { junk: true }, null], NOW), [keep]);
  let ob = [];
  ob = addToOutbox(ob, { cid: CID1, name: 'a.txt', size: 3 }, NOW - 10);
  ob = addToOutbox(ob, { cid: CID2, name: '', size: undefined }, NOW - 5);
  ob = addToOutbox(ob, { cid: CID1, name: 'a2.txt', size: 4 }, NOW); // re-share refreshes ts
  assert.deepEqual(ob.map((s) => [s.cid, s.name, s.size, s.ts]), [[CID1, 'a2.txt', 4, NOW], [CID2, CID2, null, NOW - 5]]);
  const dupes = Array.from({ length: 30 }, (_, i) => ({ cid: i % 2 ? CID1 : CID2, ts: NOW - i }));
  assert.equal(pruneOutbox(dupes, NOW).length, 2); // deduped
  const distinct = (await makeCids(30)).map((cid, i) => ({ cid, ts: NOW - i }));
  const pruned = pruneOutbox(distinct, NOW);
  assert.equal(pruned.length, 20);
  assert.equal(pruned[0].cid, distinct[0].cid);
  assert.deepEqual(pruneOutbox('x', NOW), []);
});

test('received: merge dedupes on (from, cid), keeps dismissed shares away, refreshes re-offers, caps at 100', async () => {
  const shares = [{ cid: CID1, name: 'a', size: 1, ts: NOW - 2 }, { cid: CID2, name: 'b', size: null, ts: NOW - 1 }];
  let st = { received: [], seen: [] };
  let r = mergeReceived(st, shares, { from: B, fromName: 'mac', now: NOW });
  assert.equal(r.added.length, 2);
  assert.deepEqual(r.received.map((x) => x.cid), [CID2, CID1]);
  assert.deepEqual(r.received[0], { cid: CID2, name: 'b', size: null, from: B, fromName: 'mac', ts: NOW - 1, pinned: false });
  st = { received: r.received, seen: r.seen };

  // the same presence again: nothing new, same arrays returned
  r = mergeReceived(st, shares, { from: B, fromName: 'mac', now: NOW });
  assert.equal(r.added.length, 0);
  assert.equal(r.received, st.received);

  // same cid from another device is a different share
  r = mergeReceived(st, [shares[0]], { from: A, fromName: 'linux', now: NOW });
  assert.equal(r.added.length, 1);
  assert.equal(r.received.length, 3);

  // dismissed share does not come back while it is still in the sender's outbox
  const dismissed = { received: dismissReceived(st.received, { cid: CID1, from: B }), seen: st.seen };
  assert.deepEqual(dismissed.received.map((x) => x.cid), [CID2]);
  r = mergeReceived(dismissed, shares, { from: B, fromName: 'mac', now: NOW });
  assert.equal(r.added.length, 0);

  // ... unless the sender re-shares it (newer ts): then it is offered again, pinned flag kept
  const pinnedState = { received: st.received.map((x) => (x.cid === CID2 ? { ...x, pinned: true } : x)), seen: st.seen };
  r = mergeReceived(pinnedState, [{ ...shares[1], ts: NOW + 5 }], { from: B, fromName: 'mac', now: NOW });
  assert.equal(r.added.length, 1);
  assert.equal(r.received.length, 2);
  assert.equal(r.received[0].ts, NOW + 5);
  assert.equal(r.received[0].pinned, true);

  // cap at 100, newest first
  let big = { received: [], seen: [] };
  const many = await makeCids(130);
  for (let i = 0; i < many.length; i += 1) {
    big = mergeReceived(big, [{ cid: many[i], name: `n${i}`, size: i, ts: NOW + i }], { from: B, fromName: '', now: NOW + i });
  }
  assert.equal(big.received.length, 100);
  assert.equal(big.received[0].cid, many[129]);
  assert.equal(big.received[99].cid, many[30]);
  // an evicted share stays "seen", so the sender's re-announcement does not bring it back
  const again = mergeReceived(big, [{ cid: many[0], name: 'n0', size: 0, ts: NOW }], { from: B, fromName: '', now: NOW + 200 });
  assert.equal(again.added.length, 0);
  const filler = Array.from({ length: 130 }, (_, i) => ({ cid: CID1, name: 'x', size: 1, from: B, fromName: '', ts: NOW - i, pinned: false }));
  assert.equal(sanitizeReceived(filler).length, 1); // deduped on (from, cid)
});

test('sanitizeReceived / sanitizeSeen validate persisted data', () => {
  const rec = sanitizeReceived([
    { cid: CID1, name: 'a', size: 5, from: B, fromName: 'mac', ts: NOW - 1, pinned: true },
    { cid: 'nope', from: B, ts: NOW },
    { cid: CID2, from: 'nope', ts: NOW },
    { cid: CID2, from: B, ts: 'x' },
    { cid: CID3, from: A, ts: NOW, size: -4, name: 7 },
  ]);
  assert.deepEqual(rec, [
    { cid: CID3, name: CID3, size: null, from: A, fromName: '', ts: NOW, pinned: false },
    { cid: CID1, name: 'a', size: 5, from: B, fromName: 'mac', ts: NOW - 1, pinned: true },
  ]);
  assert.deepEqual(sanitizeReceived({}), []);
  const seen = sanitizeSeen([{ from: B, cid: CID1, ts: NOW }, { from: B, cid: CID1, ts: NOW - 5 }, { from: B, cid: CID2, ts: NOW - 9 * 86400000 }, { from: 'x', cid: CID1, ts: NOW }], NOW);
  assert.deepEqual(seen, [{ from: B, cid: CID1, ts: NOW }]);
});

test('online / discovered windows', () => {
  assert.equal(isOnline(NOW - 90_000, NOW), true);
  assert.equal(isOnline(NOW - 90_001, NOW), false);
  assert.equal(isOnline(null, NOW), false);
  assert.equal(isDiscoveredFresh(NOW - 300_000, NOW), true);
  assert.equal(isDiscoveredFresh(NOW - 300_001, NOW), false);
  const m = new Map([[A, { lastSeen: NOW - 1000 }], [B, { lastSeen: NOW - 400_000 }]]);
  pruneDiscovered(m, NOW);
  assert.deepEqual([...m.keys()], [A]);
});

test('sameAddrSet and mergePeeringPeers', () => {
  assert.ok(sameAddrSet(['/a', '/b'], ['/b', '/a']));
  assert.ok(!sameAddrSet(['/a'], ['/a', '/b']));
  assert.ok(sameAddrSet([], undefined));
  const existing = [{ ID: 'QmUserOwnPeer', Addrs: ['/ip4/9.9.9.9/tcp/4001'] }, { ID: B, Addrs: ['/old'] }, { ID: A, Addrs: [] }];
  assert.deepEqual(
    mergePeeringPeers(existing, [{ peerId: B, addrs: [`/ip4/10.0.0.2/tcp/1/p2p/${B}`] }], [A]),
    [{ ID: 'QmUserOwnPeer', Addrs: ['/ip4/9.9.9.9/tcp/4001'] }, { ID: B, Addrs: ['/ip4/10.0.0.2/tcp/1'] }],
  );
  assert.deepEqual(mergePeeringPeers(null, []), []);
});
