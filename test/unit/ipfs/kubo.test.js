import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  multiaddrToHttpUrl,
  applyBucksConfig,
  candidateBinaryPaths,
  isLockError,
  normalizeGatewayBase,
} from '../../../src/main/ipfs/kubo.js';

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
  // everything else is left alone, and the input is not mutated
  assert.deepEqual(out.Swarm, initConfig.Swarm);
  assert.deepEqual(out.Datastore, initConfig.Datastore);
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
