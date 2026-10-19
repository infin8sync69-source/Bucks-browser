import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  multiaddrToHttpUrl,
  applyBucksConfig,
  candidateBinaryPaths,
  isLockError,
  normalizeGatewayBase,
  isValidMultiaddr,
  splitP2pSuffix,
  normalizePeeringPeers,
  ipfsSettingsNeedRestart,
  storageMaxValue,
  HOSTING_CONN_MGR,
} from '../../../src/main/ipfs/kubo.js';

const PEER_A = '12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN';
const PEER_B = 'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N';
const PEER_C = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const SELF = '12D3KooWDTgzAwwNkcfUX8KryUS5veDMAdSFwLfsstMJEKpyyWdW';

test('multiaddrToHttpUrl', () => {
  assert.equal(multiaddrToHttpUrl('/ip4/127.0.0.1/tcp/5001'), 'http://127.0.0.1:5001');
  assert.equal(multiaddrToHttpUrl('/ip4/0.0.0.0/tcp/8080'), 'http://127.0.0.1:8080');
  assert.equal(multiaddrToHttpUrl('/ip6/::1/tcp/8080'), 'http://[::1]:8080');
  assert.equal(multiaddrToHttpUrl('/ip6/::/tcp/8080'), 'http://[::1]:8080');
  assert.equal(multiaddrToHttpUrl('/dns4/localhost/tcp/8080/http'), 'http://localhost:8080');
  assert.equal(multiaddrToHttpUrl('/dns4/gw.example/tcp/443/https'), 'https://gw.example:443');
  assert.equal(multiaddrToHttpUrl('http://127.0.0.1:5001/'), 'http://127.0.0.1:5001');
  assert.throws(() => multiaddrToHttpUrl('/unix/tmp/ipfs.sock'), /Unsupported/);
  assert.throws(() => multiaddrToHttpUrl('/ip4/127.0.0.1/udp/5001'), /Unsupported transport/);
  assert.throws(() => multiaddrToHttpUrl(''), /Unsupported multiaddr/);
});

test('applyBucksConfig pins API/Gateway to loopback and moves every swarm listener to the reserved port', () => {
  const initConfig = {
    Identity: { PeerID: '12D3KooW' },
    Addresses: {
      Swarm: ['/ip4/0.0.0.0/tcp/4001', '/ip6/::/tcp/4001', '/ip4/0.0.0.0/udp/4001/quic-v1', '/ip4/0.0.0.0/udp/4001/quic-v1/webtransport', '/ip6/::/udp/4001/webrtc-direct'],
      Announce: [], NoAnnounce: [], API: '/ip4/127.0.0.1/tcp/5001', Gateway: '/ip4/127.0.0.1/tcp/8080',
    },
    Swarm: { ConnMgr: { LowWater: 20, HighWater: 40 } },
    Datastore: { StorageMax: '10GB' },
  };
  const out = applyBucksConfig(initConfig, { apiPort: 41001, gatewayPort: 41002, swarmPort: 41003 });
  assert.equal(out.Addresses.API, '/ip4/127.0.0.1/tcp/41001');
  assert.equal(out.Addresses.Gateway, '/ip4/127.0.0.1/tcp/41002');
  assert.deepEqual(out.Addresses.Swarm, ['/ip4/0.0.0.0/tcp/41003', '/ip6/::/tcp/41003', '/ip4/0.0.0.0/udp/41003/quic-v1', '/ip4/0.0.0.0/udp/41003/quic-v1/webtransport', '/ip6/::/udp/41003/webrtc-direct']);
  // the input is not mutated
  assert.deepEqual(initConfig.Swarm, { ConnMgr: { LowWater: 20, HighWater: 40 } });
  assert.equal(initConfig.Addresses.API, '/ip4/127.0.0.1/tcp/5001');
  // idempotent
  assert.deepEqual(applyBucksConfig(out, { apiPort: 41001, gatewayPort: 41002, swarmPort: 41003 }), out);
  // no swarm list at all → sensible defaults on the reserved port
  const bare = applyBucksConfig({}, { apiPort: 1, gatewayPort: 2, swarmPort: 3 });
  assert.ok(bare.Addresses.Swarm.includes('/ip4/0.0.0.0/tcp/3'));
  // without a swarm port the swarm list is untouched
  assert.equal(applyBucksConfig({ Addresses: { Swarm: ['/ip4/0.0.0.0/tcp/4001'] } }, { apiPort: 1, gatewayPort: 2 }).Addresses.Swarm[0], '/ip4/0.0.0.0/tcp/4001');
});

test('candidateBinaryPaths follows the documented lookup order', () => {
  const linux = candidateBinaryPaths({ env: { BUCKS_KUBO_BIN: '/opt/ipfs' }, resourcesDir: '/res', userData: '/ud', platform: 'linux', arch: 'x64' });
  assert.deepEqual(linux, ['/opt/ipfs', path.join('/res', 'kubo', 'ipfs'), path.join('/res', 'kubo', 'linux-x64', 'ipfs'), path.join('/ud', 'kubo', 'bin', 'ipfs')]);
  const win = candidateBinaryPaths({ env: {}, resourcesDir: '/res', userData: '/ud', platform: 'win32', arch: 'arm64' });
  assert.deepEqual(win, [path.join('/res', 'kubo', 'ipfs.exe'), path.join('/res', 'kubo', 'win-arm64', 'ipfs.exe'), path.join('/ud', 'kubo', 'bin', 'ipfs.exe')]);
  const mac = candidateBinaryPaths({ env: {}, resourcesDir: '/res', userData: '/ud', platform: 'darwin', arch: 'arm64' });
  assert.ok(mac.includes(path.join('/res', 'kubo', 'mac-arm64', 'ipfs')));
  const odd = candidateBinaryPaths({ env: {}, resourcesDir: '/res', userData: '/ud', platform: 'freebsd', arch: 'x64' });
  assert.deepEqual(odd, [path.join('/res', 'kubo', 'ipfs'), path.join('/ud', 'kubo', 'bin', 'ipfs')]);
});

test('isLockError and normalizeGatewayBase', () => {
  assert.equal(isLockError('Error: lock /x/repo.lock: someone else has the lock'), true);
  assert.equal(isLockError('Error: ipfs daemon is running. please stop it to run this command'), true);
  assert.equal(isLockError('listen tcp4 127.0.0.1:1: bind: address already in use'), false);
  assert.equal(isLockError(null), false);
  assert.equal(normalizeGatewayBase('https://ipfs.io/'), 'https://ipfs.io');
  assert.equal(normalizeGatewayBase('https://dweb.link/ipfs/'), 'https://dweb.link');
  assert.equal(normalizeGatewayBase(''), 'https://ipfs.io');
  assert.equal(normalizeGatewayBase(undefined), 'https://ipfs.io');
});

test('applyBucksConfig enables pubsub (gossipsub) and mDNS and maps settings.ipfs.peers to Peering.Peers', () => {
  const init = {
    Identity: { PeerID: SELF },
    Pubsub: { DisableSigning: false, Router: '' },
    Discovery: { MDNS: { Enabled: false } },
    Peering: { Peers: null },
  };
  const peers = [
    { peerId: PEER_A, name: 'mac', addrs: ['/ip4/192.168.1.20/tcp/40785', `/ip4/192.168.1.20/udp/40785/quic-v1/p2p/${PEER_A}`, 'not-a-multiaddr'] },
    { peerId: 'garbage', name: 'bad', addrs: ['/ip4/10.0.0.1/tcp/1'] },
    { peerId: SELF, name: 'me', addrs: ['/ip4/127.0.0.1/tcp/1'] },
  ];
  const out = applyBucksConfig(init, { apiPort: 1, gatewayPort: 2, swarmPort: 3, peers });
  assert.deepEqual(out.Pubsub, { DisableSigning: false, Router: 'gossipsub', Enabled: true });
  assert.deepEqual(out.Discovery, { MDNS: { Enabled: true } });
  assert.deepEqual(out.Peering, { Peers: [{ ID: PEER_A, Addrs: ['/ip4/192.168.1.20/tcp/40785', '/ip4/192.168.1.20/udp/40785/quic-v1'] }] });
  assert.equal(init.Pubsub.Router, '', 'input is not mutated');
  // idempotent, including the peering part
  assert.deepEqual(applyBucksConfig(out, { apiPort: 1, gatewayPort: 2, swarmPort: 3, peers }), out);
  // an empty list clears Peering.Peers; omitting `peers` leaves it untouched
  assert.deepEqual(applyBucksConfig(out, { apiPort: 1, gatewayPort: 2, peers: [] }).Peering.Peers, []);
  assert.deepEqual(applyBucksConfig(out, { apiPort: 1, gatewayPort: 2 }).Peering, out.Peering);
  // a bare init config without these sections still gets them
  const bare = applyBucksConfig({}, { apiPort: 1, gatewayPort: 2, peers: [] });
  assert.equal(bare.Pubsub.Enabled, true);
  assert.equal(bare.Pubsub.Router, 'gossipsub');
  assert.equal(bare.Discovery.MDNS.Enabled, true);
});

test('normalizePeeringPeers validates peer IDs and multiaddrs', () => {
  const out = normalizePeeringPeers([
    { peerId: PEER_A, addrs: ['/ip4/192.168.1.20/tcp/4001', '/ip4/192.168.1.20/tcp/4001/', '/ip6/fe80::1/tcp/4001'] },
    { peerId: ` ${PEER_B} `, addrs: [`/dns4/laptop.local/tcp/4001/p2p/${PEER_A}`, '/dns4/laptop.local/tcp/4001'] }, // addr naming another peer is dropped
    { peerId: PEER_C, addrs: 'not-an-array' },
    { peerId: `/ip4/10.0.0.5/tcp/4001/p2p/${PEER_A}` }, // full multiaddr in the peerId field → merged into PEER_A
    { peerId: 'bafzaajaiaejcb5ipbu3uucqb56l5l4azzcjpbxehrsodrmpbsegt3zyvonhc4l4a', addrs: [] },
    { peerId: 'QmNotAPeer', addrs: ['/ip4/1.2.3.4/tcp/1'] },
    { peerId: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', addrs: [] }, // a CID, but not libp2p-key
    null,
    'x',
    { addrs: ['/ip4/1.2.3.4/tcp/1'] },
  ], { selfId: SELF });
  assert.deepEqual(out, [
    { ID: PEER_A, Addrs: ['/ip4/192.168.1.20/tcp/4001', '/ip6/fe80::1/tcp/4001', '/ip4/10.0.0.5/tcp/4001'] },
    { ID: PEER_B, Addrs: ['/dns4/laptop.local/tcp/4001'] },
    { ID: PEER_C, Addrs: [] },
    { ID: 'bafzaajaiaejcb5ipbu3uucqb56l5l4azzcjpbxehrsodrmpbsegt3zyvonhc4l4a', Addrs: [] },
  ]);
  assert.deepEqual(normalizePeeringPeers(undefined), []);
  assert.deepEqual(normalizePeeringPeers({}), []);
});

test('isValidMultiaddr only accepts addresses Kubo can parse', () => {
  for (const ok of [
    '/ip4/192.168.1.20/tcp/40785',
    '/ip6/::1/tcp/4001',
    '/ip4/1.2.3.4/udp/4001/quic-v1',
    '/ip4/1.2.3.4/udp/4001/quic-v1/webtransport/certhash/uEiDDq4_xNyDorZBH3TlGazyJdOWSwvo4PUo5YHFMrvDE8g',
    '/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiDDq4_xNyDorZBH3TlGazyJdOWSwvo4PUo5YHFMrvDE8g',
    '/dns4/example.com/tcp/443/wss',
    '/dnsaddr/bootstrap.libp2p.io',
    `/ip4/1.2.3.4/tcp/4001/p2p/${PEER_A}/p2p-circuit`,
  ]) assert.equal(isValidMultiaddr(ok), true, ok);
  for (const bad of [
    '', 'ip4/1.2.3.4/tcp/1', '/ip4/1.2.3.4/tcp/9/garbage', '/ip4/999.1.1.1/tcp/1', '/ip4/1.2.3.4/tcp/70000',
    '/ip4/1.2.3.4/tcp', '/tcp/4001', '/ip6/zz::1/tcp/1', '/dns4/bad host/tcp/1', '/ip4/1.2.3.4/udp/1/quic-v1/certhash/xnotbase',
    '/ip4/1.2.3.4/tcp/1/p2p/notapeer', '/unix/tmp/sock', null, 42,
  ]) assert.equal(isValidMultiaddr(bad), false, String(bad));
});

test('splitP2pSuffix', () => {
  assert.deepEqual(splitP2pSuffix(`/ip4/1.2.3.4/tcp/1/p2p/${PEER_A}`), { addr: '/ip4/1.2.3.4/tcp/1', peerId: PEER_A });
  assert.deepEqual(splitP2pSuffix(`/ip4/1.2.3.4/tcp/1/ipfs/${PEER_B}/`), { addr: '/ip4/1.2.3.4/tcp/1', peerId: PEER_B });
  assert.deepEqual(splitP2pSuffix('/ip4/1.2.3.4/tcp/1'), { addr: '/ip4/1.2.3.4/tcp/1', peerId: null });
});

test('ipfsSettingsNeedRestart: only mode and (in external mode) the API URL restart the node', () => {
  const base = { mode: 'embedded', externalApiUrl: '', publicGateway: 'https://ipfs.io', preferredGateway: 'local', autoStart: true, peers: [] };
  assert.equal(ipfsSettingsNeedRestart(base, { ...base, peers: [{ peerId: PEER_A, name: 'mac', addrs: [] }] }), false);
  assert.equal(ipfsSettingsNeedRestart(base, { ...base, publicGateway: 'https://dweb.link', preferredGateway: 'public', autoStart: false }), false);
  assert.equal(ipfsSettingsNeedRestart(base, { ...base, externalApiUrl: 'http://127.0.0.1:5001' }), false, 'unused while embedded');
  assert.equal(ipfsSettingsNeedRestart(base, { ...base, mode: 'external' }), true);
  const ext = { ...base, mode: 'external', externalApiUrl: 'http://127.0.0.1:5001' };
  assert.equal(ipfsSettingsNeedRestart(ext, { ...ext, externalApiUrl: 'http://127.0.0.1:5002' }), true);
  assert.equal(ipfsSettingsNeedRestart(ext, { ...ext, externalApiUrl: ' http://127.0.0.1:5001 ' }), false);
  assert.equal(ipfsSettingsNeedRestart(ext, { ...ext, peers: [{ peerId: PEER_B }] }), false);
  assert.equal(ipfsSettingsNeedRestart(undefined, { mode: 'embedded' }), false);
  assert.equal(ipfsSettingsNeedRestart(ext, base), true);
});

test('applyBucksConfig sets the hosting keys and keeps a lowpower repo on autoclient', () => {
  // what `ipfs init --profile=lowpower` (Kubo 0.43.1) writes for the keys we touch
  const lowpower = {
    Routing: { Type: 'autoclient', DelegatedRouters: ['auto'] },
    Swarm: { ConnMgr: { Type: 'basic', LowWater: 20, HighWater: 40, GracePeriod: '1m0s' }, RelayService: { Enabled: false } },
    AutoNAT: { ServiceMode: 'disabled' },
    Provide: { DHT: {} },
    Datastore: { StorageMax: '10GB', GCPeriod: '1h' },
    Gateway: { NoFetch: true, HTTPHeaders: {} },
    Ipns: { RecordLifetime: '', RepublishPeriod: '' },
  };
  const out = applyBucksConfig(lowpower, { apiPort: 1, gatewayPort: 2, storageMaxGB: 25 });
  assert.equal(out.Routing.Type, 'autoclient', 'an existing repo keeps its profile');
  assert.deepEqual(out.Routing.DelegatedRouters, ['auto']);
  assert.equal(out.Routing.AcceleratedDHTClient, false);
  assert.deepEqual(out.Provide, { DHT: {}, Strategy: 'pinned' });
  assert.deepEqual(out.Swarm.ConnMgr, { Type: 'basic', LowWater: 50, HighWater: 150, GracePeriod: '1m0s' });
  assert.deepEqual(out.Swarm.RelayService, { Enabled: false }, 'relay settings are Kubo\'s');
  assert.deepEqual(out.AutoNAT, { ServiceMode: 'disabled' });
  assert.deepEqual(out.Datastore, { StorageMax: '25GB', GCPeriod: '1h' });
  assert.deepEqual(out.Gateway, { NoFetch: false, HTTPHeaders: {} });
  assert.deepEqual(out.Ipns, lowpower.Ipns);
  assert.deepEqual(applyBucksConfig(out, { apiPort: 1, gatewayPort: 2, storageMaxGB: 25 }), out, 'idempotent');
  assert.deepEqual(HOSTING_CONN_MGR, { LowWater: 50, HighWater: 150 });

  // a repo from the default profile (no Routing.Type) gets `auto`
  const fresh = applyBucksConfig({ Routing: { DelegatedRouters: ['auto'] } }, { apiPort: 1, gatewayPort: 2 });
  assert.equal(fresh.Routing.Type, 'auto');
  assert.equal(fresh.Datastore.StorageMax, '10GB');
});

test('storageMaxValue: whole gigabytes, 10 GB when unset or invalid', () => {
  assert.equal(storageMaxValue(10), '10GB');
  assert.equal(storageMaxValue('64'), '64GB');
  assert.equal(storageMaxValue(2.7), '2GB');
  for (const bad of [undefined, null, 0, -5, 'lots', Number.NaN]) assert.equal(storageMaxValue(bad), '10GB');
  assert.equal(storageMaxValue(1e9), '100000GB');
});
