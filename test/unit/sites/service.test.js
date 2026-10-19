// The sites service's logic with an in-memory Kubo (no binary needed): pipeline order, cleanup on
// failure, tokens, locks, update review, unpublish modes, hosting options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSitesService, gatewayLink, inspectOptions } from '../../../src/main/sites/service.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

function fakeRpc() {
  const pins = new Set();
  const keys = new Map([['self', `k51${'s'.repeat(50)}`]]);
  const names = new Map();
  const dags = new Map();
  const calls = [];
  let n = 0;
  const rpc = {
    online: false,
    pins, keys, names, calls,
    async addDirectory(parts, { pin }) {
      const files = new Map();
      for (const p of [...parts].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        const text = await p.content.text();
        files.set(p.path, { cid: `bafk${sha(text).slice(0, 40)}`, size: Buffer.byteLength(text) });
      }
      const cid = `bafy${sha([...files].map(([k, v]) => k + v.cid).join()).slice(0, 50)}`;
      dags.set(cid, files);
      if (pin) pins.add(cid);
      calls.push(['add', cid, pin]);
      return { cid, size: 1 };
    },
    async ls(cid) {
      return [...(dags.get(cid) || [])].map(([name, f]) => ({ name, cid: f.cid, size: f.size, type: 'file' }));
    },
    async refs(cid) { return [...(dags.get(cid)?.values() || [])].map((f) => f.cid); },
    async keyGen(name) {
      n += 1;
      const id = `k51${String(n).padStart(50, 'q')}`;
      keys.set(name, id);
      calls.push(['keyGen', name]);
      return { name, id };
    },
    async keyRm(name) { keys.delete(name); calls.push(['keyRm', name]); return [name]; },
    async keyList() { return [...keys].map(([name, id]) => ({ name, id })); },
    async namePublish(key, cid, { allowOffline }) {
      if (!rpc.online && !allowOffline) throw new Error("can't publish while offline");
      names.set(keys.get(key), cid);
      calls.push(['publish', key, cid, allowOffline]);
      return { name: keys.get(key), value: `/ipfs/${cid}` };
    },
    async isOnline() { return rpc.online; },
    async provide(cid) { if (!rpc.online) throw new Error('offline'); calls.push(['provide', cid]); },
    async pinAdd(cid) { pins.add(cid); return cid; },
    async pinRm(cid) { if (!pins.delete(cid)) throw new Error('not pinned'); calls.push(['pinRm', cid]); return cid; },
    async pinLs() { return [...pins].map((cid) => ({ cid, pin_type: 'recursive' })); },
    async swarmAddrsLocal() { return ['/ip4/203.0.113.5/tcp/4001']; },
    async provideStat() { return { connectivity: rpc.online ? 'online' : 'offline', keys: pins.size }; },
  };
  return rpc;
}

async function setup(t, { handler, devices = null, pinning = null, sites = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-sites-svc-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'my-site');
  await fsp.mkdir(path.join(src, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(src, 'index.html'), '<!doctype html><h1>hi</h1>');
  await fsp.writeFile(path.join(src, 'assets', 'app.js'), 'console.log(1)');
  const rpc = fakeRpc();
  const kubo = { isReady: () => true, rpc, status: () => ({ peer_id: '12D3KooWself', embedded: true }) };
  let clock = 1_800_000_000_000;
  const events = [];
  const previews = [];
  const okHandler = Object.assign(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }), { setPreview: (cid, on) => previews.push([cid, on]) });
  const svc = createSitesService({
    kubo,
    settings: { get: () => ({ ipfs: { publicGateway: 'https://ipfs.io' }, sites: { historyLimit: 2, ...sites } }) },
    userData: path.join(dir, 'profile'),
    handler: handler || okHandler,
    devices,
    pinning,
    emit: (e) => events.push(e),
    now: () => clock,
  });
  return { dir, src, rpc, kubo, svc, events, previews, advance: (ms) => { clock += ms; } };
}

test('publish: the pipeline in order, offline node publishes with allow-offline, record saved', async (t) => {
  const { src, rpc, svc, events, previews } = await setup(t);
  const { token, name, hints } = await svc.registerFolder(src);
  assert.equal(name, 'my-site');
  assert.equal(hints.suggestedDir, '');
  const res = await svc.publish({ token });
  assert.equal(res.id.startsWith('s_'), true);
  assert.deepEqual([...new Set(events.map((e) => e.step))], ['inspect', 'add', 'self-test', 'name', 'announce', 'record']);
  assert.ok(events.every((e) => e.id === res.id));
  assert.deepEqual(rpc.calls.map((c) => c[0]), ['add', 'keyGen', 'publish']);
  assert.equal(rpc.calls[2][3], true, 'allow-offline on an offline node');
  assert.equal(rpc.names.get(res.ipns), res.cid);
  assert.deepEqual(res.announce.ok, false);
  assert.deepEqual(previews, [[res.cid, false]]);
  const [site] = svc.list();
  assert.equal(site.name, 'my-site');
  assert.equal(site.folderName, 'my-site');
  assert.equal('sourceDir' in site, false);
  assert.equal(site.current.files, 2);
  assert.equal(site.keyBackedUp, false);
  assert.deepEqual(site.urls.ipfs, `ipfs://${res.cid}/`);

  rpc.online = true;
  const second = await svc.publish({ token, name: '  Second\u0007 site ', ipns: false });
  assert.equal(svc.store.get(second.id).name, 'Second site');
  assert.ok(rpc.calls.some((c) => c[0] === 'provide' && c[1] === second.cid));
  assert.equal(second.ipns, null);
});

test('publish: a failed self-test leaves nothing behind (no key, no pin, no record)', async (t) => {
  const failing = Object.assign(async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }), { setPreview() {} });
  const { src, rpc, svc } = await setup(t, { handler: failing });
  const { token } = await svc.registerFolder(src);
  await assert.rejects(svc.publish({ token }), /self-test failed: the home page answered 404/);
  assert.equal(rpc.pins.size, 0);
  assert.deepEqual(svc.list(), []);
  assert.deepEqual([...rpc.keys.keys()], ['self']);
});

test('publish: blocked checks, expired tokens and a stopped node are refused with readable errors', async (t) => {
  const { dir, src, svc, kubo, advance } = await setup(t);
  const empty = path.join(dir, 'empty');
  await fsp.mkdir(empty);
  const { token: emptyToken } = await svc.registerFolder(empty);
  const err = await svc.publish({ token: emptyToken }).catch((e) => e);
  assert.match(err.message, /no index\.html/);
  assert.equal(err.checks[0].id, 'P1');
  await assert.rejects(svc.inspect({ token: 'made-up' }), /Choose the folder again/);
  const { token } = await svc.registerFolder(src);
  advance(61 * 60_000);
  await assert.rejects(svc.inspect({ token }), /Choose the folder again/);
  kubo.isReady = () => false;
  await assert.rejects(svc.publish({ token }), /Your IPFS node is not running\. Start it to publish\./);
});

test('update: a dry run pins nothing; confirm checks the reviewed CID; history is trimmed and unpinned', async (t) => {
  const { src, rpc, svc } = await setup(t);
  const { token } = await svc.registerFolder(src);
  const v1 = await svc.publish({ token });
  await fsp.writeFile(path.join(src, 'assets', 'app.js'), 'console.log(2)');
  const review = await svc.update({ id: v1.id });
  assert.equal(rpc.pins.has(review.cid), false);
  assert.deepEqual(review.diff.counts, { added: 0, changed: 1, removed: 0 });
  assert.deepEqual(review.diff.blocks, { new: 2, reused: 1 });
  await assert.rejects(svc.update({ id: v1.id, confirm: true, expectCid: 'bafyother' }), /changed since you reviewed/);
  assert.equal(rpc.pins.has(review.cid), false, 'the mismatched add was unpinned again');
  const v2 = await svc.update({ id: v1.id, confirm: true, expectCid: review.cid });
  assert.equal(rpc.names.get(v1.ipns), v2.cid);
  assert.equal((await svc.update({ id: v1.id, confirm: true })).unchanged, true, 'same content: nothing to publish');
  await fsp.writeFile(path.join(src, 'assets', 'new.js'), 'x');
  const v3 = await svc.update({ id: v1.id, confirm: true });
  assert.deepEqual(v3.diff.counts, { added: 1, changed: 0, removed: 0 });
  assert.deepEqual(svc.store.get(v1.id).history.map((v) => v.cid), [v3.cid, v2.cid]);
  assert.equal(rpc.pins.has(v1.cid), false, 'the oldest version beyond the limit is unpinned');
});

test('one operation per site at a time', async (t) => {
  let hold = null; // when set, the self-test waits on it
  const slow = Object.assign(async () => {
    if (hold) await hold;
    return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
  }, { setPreview() {} });
  const { src, svc } = await setup(t, { handler: slow });
  const { token } = await svc.registerFolder(src);
  const site = await svc.publish({ token });
  let release;
  hold = new Promise((r) => { release = r; });
  await fsp.writeFile(path.join(src, 'index.html'), '<!doctype html>v2');
  const pending = svc.update({ id: site.id, confirm: true });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(svc.rollback({ id: site.id, cid: site.cid }), /already being published/);
  release();
  hold = null;
  assert.equal((await pending).unchanged, false);
  assert.deepEqual(await svc.rollback({ id: site.id, cid: site.cid }), { cid: site.cid }, 'free again afterwards');
});

test('rollback and unpublish modes', async (t) => {
  const { src, rpc, svc } = await setup(t);
  const { token } = await svc.registerFolder(src);
  const v1 = await svc.publish({ token, name: 'Docs' });
  await fsp.writeFile(path.join(src, 'index.html'), '<!doctype html>v2');
  const v2 = await svc.update({ id: v1.id, confirm: true });
  assert.deepEqual(await svc.rollback({ id: v1.id, cid: v1.cid }), { cid: v1.cid });
  assert.equal(rpc.names.get(v1.ipns), v1.cid);
  assert.equal(svc.store.get(v1.id).current.cid, v1.cid);
  await assert.rejects(svc.unpublish({ id: v1.id, mode: 'erase' }), /mode must be one of/);
  await assert.rejects(svc.unpublish({ id: v1.id, mode: 'delete-key', confirm: 'docs' }), /Type the site name \("Docs"\)/);

  const keyName = svc.store.get(v1.id).keyName;
  // another site shares v1's content: its pin must survive the unpublish
  const other = await svc.publish({ token, name: 'Other', ipns: false });
  await svc.unpublish({ id: v1.id, mode: 'delete-key', confirm: 'Docs' });
  assert.equal(rpc.keys.has(keyName), false);
  assert.equal(rpc.pins.has(v2.cid), true, 'still used by the other site');
  await svc.unpublish({ id: other.id, mode: 'stop' });
  assert.equal(rpc.pins.has(other.cid), true, '"stop" keeps the content');
  assert.deepEqual(svc.list(), []);
  await assert.rejects(svc.status({ id: v1.id }), /No such site/);
});

test('hosting options: devices and pinning services get the new version; invalid options are refused', async (t) => {
  const shared = [];
  const pinned = [];
  const devices = { share: async (s) => { shared.push(s); return { queued: true, onlinePeers: 1 }; } };
  const pinning = {
    list: () => [{ name: 'pinata', endpoint: 'https://api.pinata.example/psa' }],
    pin: async (service, cid, opts) => { pinned.push({ service, cid, opts }); return { status: 'queued' }; },
    status: async () => [{ status: 'pinned' }],
  };
  const { src, rpc, svc } = await setup(t, { devices, pinning });
  rpc.online = true;
  const { token } = await svc.registerFolder(src);
  await assert.rejects(svc.publish({ token, hosting: { keepOnline: false } }), /always keeps a copy/);
  await assert.rejects(svc.publish({ token, hosting: { pinningServices: ['unknown'] } }), /No pinning service called "unknown"/);
  const site = await svc.publish({ token, name: 'Shop', hosting: { pinToDevices: ['12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN'], pinningServices: ['pinata'] } });
  assert.deepEqual(shared, [{ cid: site.cid, name: 'Shop', size: '<!doctype html><h1>hi</h1>'.length + 'console.log(1)'.length }]);
  assert.equal(pinned[0].service, 'pinata');
  assert.deepEqual(pinned[0].opts.origins, ['/ip4/203.0.113.5/tcp/4001/p2p/12D3KooWself']);
  assert.deepEqual(site.copies.pinningServices, [{ service: 'pinata', status: 'queued' }]);
  const health = await svc.status({ id: site.id });
  assert.deepEqual(health.remotePins, [{ service: 'pinata', status: 'pinned' }]);
  assert.equal(health.state, 'redundant', 'no router configured, but a pinning service holds a copy');
});

test('helpers: gateway links and inspect options', () => {
  assert.equal(gatewayLink('https://ipfs.io', 'ipfs', 'bafyx'), 'https://bafyx.ipfs.dweb.link/');
  assert.equal(gatewayLink('https://w3s.link/', 'ipns', 'k51x'), 'https://k51x.ipns.w3s.link/');
  assert.equal(gatewayLink('http://192.168.1.2', 'ipfs', 'bafyx'), 'https://bafyx.ipfs.dweb.link/');
  assert.deepEqual(inspectOptions({ exclude: ['a/', 7, 'b'], useShellAsIndex: 'yes', enableSpa: true }), { exclude: ['a/', 'b'], useShellAsIndex: false, enableSpa: true });
});
