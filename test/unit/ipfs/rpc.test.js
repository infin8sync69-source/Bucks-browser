import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KuboRpc, mapLinkType, encodePubsubTopic, decodeMultibaseBase64url } from '../../../src/main/ipfs/rpc.js';

/** Fake fetch that records calls and replies from a table keyed by command. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const u = new URL(url);
    const cmd = u.pathname.replace(/^\/api\/v0\//, '');
    calls.push({ cmd, url: u, init });
    const r = routes[cmd];
    if (!r) return new Response(JSON.stringify({ Message: `unknown command ${cmd}`, Code: 0, Type: 'error' }), { status: 404 });
    return typeof r === 'function' ? r(u, init) : new Response(typeof r === 'string' ? r : JSON.stringify(r), { status: 200 });
  };
  return { impl, calls };
}

test('constructor validates and normalises the API URL', () => {
  assert.throws(() => new KuboRpc('127.0.0.1:5001'), /Invalid Kubo API URL/);
  assert.equal(new KuboRpc('http://127.0.0.1:5001/').apiUrl, 'http://127.0.0.1:5001');
  assert.equal(new KuboRpc('http://127.0.0.1:5001/api/v0').apiUrl, 'http://127.0.0.1:5001');
});

test('commands are POSTs with repeated ?arg= params', async () => {
  const f = fakeFetch({ 'pin/add': { Pins: ['bafy1'] } });
  const rpc = new KuboRpc('http://127.0.0.1:5001', { fetchImpl: f.impl });
  assert.equal(await rpc.pinAdd('bafy1'), 'bafy1');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].url.searchParams.get('arg'), 'bafy1');
  assert.equal(rpc.commandUrl('config', ['A', 'B'], { json: 'true' }), 'http://127.0.0.1:5001/api/v0/config?arg=A&arg=B&json=true');
});

test('non-2xx responses throw the Kubo Message', async () => {
  const f = fakeFetch({
    cat: () => new Response(JSON.stringify({ Message: 'invalid path "x"', Code: 0, Type: 'error' }), { status: 500 }),
    ls: () => new Response('plain text failure', { status: 500, statusText: 'Internal Server Error' }),
  });
  const rpc = new KuboRpc('http://127.0.0.1:5001', { fetchImpl: f.impl });
  await assert.rejects(rpc.cat('x'), /invalid path "x"/);
  await assert.rejects(rpc.ls('x'), /plain text failure/);
});

test('network failures and timeouts produce readable errors', async () => {
  const failing = new KuboRpc('http://127.0.0.1:5001', { fetchImpl: async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }); } });
  await assert.rejects(failing.id(), /Kubo RPC 'id' failed: ECONNREFUSED/);
  const slow = new KuboRpc('http://127.0.0.1:5001', {
    timeoutMs: 20,
    fetchImpl: (_u, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  });
  await assert.rejects(slow.statsBw(), /timed out after 20 ms/);
});

test('add sends multipart and returns the last CID (wrapping directory when wrapped)', async () => {
  const f = fakeFetch({
    add: '{"Name":"h.txt","Hash":"bafkfile","Size":"6"}\n{"Name":"","Hash":"bafydir","Size":"59"}\n',
  });
  const rpc = new KuboRpc('http://127.0.0.1:5001', { fetchImpl: f.impl });
  const res = await rpc.add(new TextEncoder().encode('hello\n'), { fileName: 'h.txt', mimeType: 'text/plain', wrapWithDirectory: true });
  assert.deepEqual(res, { cid: 'bafydir', size: 59, name: '' });
  const { url, init } = f.calls[0];
  assert.equal(url.searchParams.get('cid-version'), '1');
  assert.equal(url.searchParams.get('raw-leaves'), 'true');
  assert.equal(url.searchParams.get('wrap-with-directory'), 'true');
  assert.equal(url.searchParams.get('pin'), 'true');
  assert.ok(init.body instanceof FormData);
  const file = init.body.get('file');
  assert.equal(file.name, 'h.txt');
  assert.equal(file.type, 'text/plain');
  assert.equal(await file.text(), 'hello\n');
  await assert.rejects(rpc.add('not bytes'), /Uint8Array/);
});

test('cat returns bytes and enforces maxBytes (header and streamed)', async () => {
  const body = new TextEncoder().encode('0123456789');
  const f = fakeFetch({
    cat: (u) => {
      const headers = u.searchParams.get('arg') === 'with-length' ? { 'content-length': '10' } : {};
      return new Response(body, { status: 200, headers });
    },
  });
  const rpc = new KuboRpc('http://127.0.0.1:5001', { fetchImpl: f.impl });
  assert.deepEqual(await rpc.cat('x'), body);
  await assert.rejects(rpc.cat('with-length', { maxBytes: 5 }), /larger than the 5 byte limit/);
  await assert.rejects(rpc.cat('no-length', { maxBytes: 5 }), /exceeds the 5 byte limit/);
  assert.equal(f.calls[0].url.searchParams.get('offset'), null);
  await rpc.cat('x', { offset: 2, length: 3 });
  assert.equal(f.calls.at(-1).url.searchParams.get('offset'), '2');
  assert.equal(f.calls.at(-1).url.searchParams.get('length'), '3');
});

test('ls maps numeric and string link types', async () => {
  const f = fakeFetch({
    ls: {
      Objects: [{ Hash: 'bafydir', Links: [
        { Name: 'a.txt', Hash: 'bafya', Size: 6, Type: 2 },
        { Name: 'sub', Hash: 'bafyb', Size: 0, Type: 1 },
        { Name: 'shard', Hash: 'bafyc', Size: 0, Type: 'directory' },
        { Name: 'raw', Hash: 'bafyd', Size: 1, Type: 'file' },
        { Name: 'odd', Hash: 'bafye', Size: 1, Type: 9 },
      ] }],
    },
  });
  const rpc = new KuboRpc('http://127.0.0.1:5001', { fetchImpl: f.impl });
  const out = await rpc.ls('bafydir');
  assert.deepEqual(out.map((l) => l.type), ['file', 'dir', 'dir', 'file', 'unknown']);
  assert.deepEqual(out[0], { name: 'a.txt', cid: 'bafya', size: 6, type: 'file' });
  assert.equal(f.calls[0].url.searchParams.get('resolve-type'), 'true');
  assert.equal(f.calls[0].url.searchParams.get('size'), 'true');
  assert.equal(mapLinkType(5), 'dir');
  assert.equal(mapLinkType(undefined), 'unknown');
});

test('pinLs, swarmPeers, repoStat, statsBw, nameResolve, config, shutdown', async () => {
  const f = fakeFetch({
    'pin/ls': { Keys: { bafy1: { Type: 'recursive', Name: '' }, bafy2: { Type: 'recursive' } } },
    'swarm/peers': { Peers: [{ Addr: '/ip4/1.2.3.4/tcp/4001', Peer: '12D3KooW', Latency: '12ms' }] },
    'repo/stat': { RepoSize: 74596, StorageMax: 10000000000, NumObjects: 12 },
    'stats/bw': { TotalIn: 1, TotalOut: 2, RateIn: 3.5, RateOut: 4 },
    'name/resolve': { Path: '/ipfs/bafyresolved' },
    resolve: { Path: '/ipfs/bafydns' },
    config: (u) => new Response(JSON.stringify({ Key: u.searchParams.get('arg'), Value: u.searchParams.getAll('arg')[1] ? JSON.parse(u.searchParams.getAll('arg')[1]) : '/ip4/127.0.0.1/tcp/8080' })),
    shutdown: () => new Response('', { status: 200 }),
  });
  const rpc = new KuboRpc('http://127.0.0.1:5001', { fetchImpl: f.impl });
  assert.deepEqual(await rpc.pinLs(), [{ cid: 'bafy1', pin_type: 'recursive' }, { cid: 'bafy2', pin_type: 'recursive' }]);
  assert.equal(f.calls.at(-1).url.searchParams.get('stream'), 'false');
  assert.deepEqual(await rpc.swarmPeers(), [{ peer: '12D3KooW', addr: '/ip4/1.2.3.4/tcp/4001', latency: '12ms' }]);
  assert.deepEqual(await rpc.repoStat(), { repo_size: 74596, storage_max: 10000000000, num_objects: 12 });
  assert.deepEqual(await rpc.statsBw(), { rate_in: 3.5, rate_out: 4, total_in: 1, total_out: 2 });
  assert.equal(await rpc.nameResolve('example.com'), '/ipfs/bafyresolved');
  assert.equal(f.calls.at(-1).url.searchParams.get('recursive'), 'true');
  assert.equal(await rpc.dnsResolve('example.com'), '/ipfs/bafydns');
  assert.equal(f.calls.at(-1).url.searchParams.get('arg'), '/ipns/example.com');
  assert.equal(await rpc.configGet('Addresses.Gateway'), '/ip4/127.0.0.1/tcp/8080');
  assert.equal(await rpc.configSet('Gateway.NoFetch', false), false);
  assert.equal(f.calls.at(-1).url.searchParams.get('json'), 'true');
  await rpc.shutdown();
  assert.equal(f.calls.at(-1).cmd, 'shutdown');
});

test('swarmPeers tolerates Peers: null', async () => {
  const f = fakeFetch({ 'swarm/peers': { Peers: null } });
  const rpc = new KuboRpc('http://127.0.0.1:5001', { fetchImpl: f.impl });
  assert.deepEqual(await rpc.swarmPeers(), []);
});

test('pubsub topics are multibase base64url without padding', () => {
  assert.equal(encodePubsubTopic('bucks-devices-v1'), 'uYnVja3MtZGV2aWNlcy12MQ');
  assert.equal(encodePubsubTopic('a'), 'uYQ');
  assert.throws(() => encodePubsubTopic(''), /non-empty/);
  assert.equal(new TextDecoder().decode(decodeMultibaseBase64url('uYnVja3MtZGV2aWNlcy12MQ')), 'bucks-devices-v1');
  assert.throws(() => decodeMultibaseBase64url('mYQ=='), /base64url/);
});

test('swarm connect/peering and pubsubPub helpers', async () => {
  const peer = '12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN';
  const f = fakeFetch({
    'swarm/connect': { Strings: [`connect ${peer} success`] },
    'swarm/peering/add': { ID: peer, Status: 'success' },
    'swarm/peering/rm': { ID: peer, Status: 'success' },
    'swarm/peering/ls': { Peers: [{ ID: peer, Addrs: ['/ip4/127.0.0.1/tcp/4001'] }] },
    'pubsub/pub': () => new Response('', { status: 200 }),
  });
  const rpc = new KuboRpc('http://127.0.0.1:5001', { fetchImpl: f.impl });
  const addr = `/ip4/127.0.0.1/tcp/4001/p2p/${peer}`;
  assert.deepEqual(await rpc.swarmConnect(addr), [`connect ${peer} success`]);
  assert.equal(f.calls.at(-1).url.searchParams.get('arg'), addr);
  assert.deepEqual(await rpc.swarmPeeringAdd(addr), { id: peer, status: 'success' });
  assert.deepEqual(await rpc.swarmPeeringRm(peer), { id: peer, status: 'success' });
  assert.equal(f.calls.at(-1).url.searchParams.get('arg'), peer);
  assert.deepEqual(await rpc.swarmPeeringLs(), [{ id: peer, addrs: ['/ip4/127.0.0.1/tcp/4001'] }]);

  await rpc.pubsubPub('bucks-devices-v1', '{"v":1}');
  const { url, init } = f.calls.at(-1);
  assert.equal(url.pathname, '/api/v0/pubsub/pub');
  assert.equal(url.searchParams.get('arg'), 'uYnVja3MtZGV2aWNlcy12MQ');
  assert.equal(init.method, 'POST');
  assert.equal(await init.body.get('file').text(), '{"v":1}');
  await assert.rejects(rpc.pubsubPub('t', 42), /string or Uint8Array/);

  const empty = new KuboRpc('http://127.0.0.1:5001', { fetchImpl: fakeFetch({ 'swarm/peering/ls': { Peers: null } }).impl });
  assert.deepEqual(await empty.swarmPeeringLs(), []);
});
