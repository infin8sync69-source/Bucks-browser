import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { createSiteStore, sanitizeSite, migrate, STORE_VERSION } from '../../../src/main/sites/store.js';
import { keystoreFileName, readKeystoreKey, encryptKeyBackup, decryptKeyBackup } from '../../../src/main/sites/keys.js';
import { checkHealth, routerProviders, probeRootBlock } from '../../../src/main/sites/health.js';
import { createPinningServices, validateEndpoint } from '../../../src/main/sites/pinning.js';

const tmp = async (t) => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-sites-'));
  t.after(() => fsp.rm(d, { recursive: true, force: true }));
  return d;
};
const IPNS = `k51qzi5uqu5dkgrl13wuej153wszejcgpn7dvd2hdh6oj7fmwcnjpay3zgg8pq`;
const site = (over = {}) => ({ id: 's_0123456789', name: 'Site', sourceDir: '/x', keyName: 'site-s_0123456789', ipns: IPNS, current: { cid: 'bafyroot', publishedAt: '2026-10-19T10:00:00Z', bytes: 10, files: 1 }, history: [{ cid: 'bafyroot', publishedAt: '2026-10-19T10:00:00Z', bytes: 10, files: 1 }], hosting: { keepOnline: true, pinToDevices: [], pinningServices: [] }, ...over });

test('store: atomic, versioned writes; bad records dropped; corrupt and newer files handled', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'sites.json');
  const store = createSiteStore({ file });
  await store.put(site());
  await store.put(site({ name: 'Renamed' }));
  const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(onDisk.version, STORE_VERSION);
  assert.equal(onDisk.sites.length, 1);
  assert.equal(onDisk.sites[0].name, 'Renamed');
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['sites.json'], 'no temp file left behind');
  assert.equal(createSiteStore({ file }).get('s_0123456789').name, 'Renamed', 'reloads');
  await assert.rejects(store.put({ id: '../evil' }), /Invalid site record/);
  assert.equal(await store.remove('s_0123456789'), true);
  assert.equal(await store.remove('s_0123456789'), false);

  await fsp.writeFile(file, '{oops');
  const fresh = createSiteStore({ file, log: { warn() {}, error() {} } });
  assert.deepEqual(fresh.list(), []);
  assert.ok(fs.existsSync(`${file}.corrupt`), 'the unreadable file is kept aside');

  await fsp.writeFile(file, JSON.stringify({ version: STORE_VERSION + 1, sites: [site()] }));
  const newer = createSiteStore({ file, log: { warn() {}, error() {} } });
  assert.equal(newer.readOnly, true);
  assert.equal(newer.list().length, 1);
  await assert.rejects(newer.put(site({ name: 'x' })), /newer version of Bucks/);
});

test('store: a change made by another process (the CLI script) is picked up, not overwritten', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'sites.json');
  const app = createSiteStore({ file });
  const script = createSiteStore({ file });
  await app.put(site());
  await script.put(site({ id: 's_aaaaaaaaaa', name: 'From the script' }));
  assert.deepEqual(app.list().map((s) => s.name).sort(), ['From the script', 'Site']);
  await app.put(site({ name: 'Renamed in the app' }));
  assert.deepEqual(script.list().map((s) => s.name).sort(), ['From the script', 'Renamed in the app']);
  await script.remove('s_0123456789');
  assert.equal(app.get('s_0123456789'), null);
});

test('sanitizeSite and migrate', () => {
  assert.equal(sanitizeSite({ id: 'nope' }), null);
  const s = sanitizeSite({ ...site(), ipns: 'not-k51', keyName: 'self', extra: 1, history: [{ cid: 'bafy1' }, { cid: '<script>' }], hosting: { keepOnline: false, pinningServices: ['ok', 'bad name!'] } });
  assert.equal(s.ipns, null);
  assert.equal(s.keyName, null);
  assert.equal('extra' in s, false);
  assert.deepEqual(s.history.map((v) => v.cid), ['bafy1']);
  assert.deepEqual(s.hosting, { keepOnline: false, pinToDevices: [], pinningServices: ['ok'] });
  assert.deepEqual(migrate([site()]).sites.length, 1);
  assert.deepEqual(migrate(null), { version: STORE_VERSION, sites: [] });
});

test('keys: Kubo keystore file name, backup round trip, wrong passphrase, tampering, hostile settings', async (t) => {
  assert.equal(keystoreFileName('site-s_abc'), 'key_onuxizjnonpwcytd', 'measured on Kubo 0.43.1');
  assert.throws(() => keystoreFileName('self'), /invalid key name/);
  const dir = await tmp(t);
  await fsp.mkdir(path.join(dir, 'keystore'));
  const keyBytes = new Uint8Array([8, 1, 18, 64, ...Array(64).fill(7)]);
  await fsp.writeFile(path.join(dir, 'keystore', keystoreFileName('site-s_abc')), keyBytes);
  assert.deepEqual(await readKeystoreKey(dir, 'site-s_abc'), keyBytes);
  await assert.rejects(readKeystoreKey(dir, 'site-s_other'), /not in this node's keystore/);

  const meta = { siteName: 'Trainer', ipns: IPNS, keyName: 'site-s_abc' };
  await assert.rejects(encryptKeyBackup(keyBytes, 'short', meta), /at least 10/);
  const file = await encryptKeyBackup(keyBytes, 'correct horse battery', meta);
  const json = JSON.parse(file);
  assert.equal(json.format, 'bucks-site-key');
  assert.equal(json.meta.ipns, IPNS);
  assert.ok(!file.toString().includes(Buffer.from(keyBytes).toString('base64')), 'the key is not in clear');
  const back = await decryptKeyBackup(file, 'correct horse battery');
  assert.deepEqual(back.keyBytes, keyBytes);
  assert.equal(back.meta.siteName, 'Trainer');
  await assert.rejects(decryptKeyBackup(file, 'wrong horse battery'), /Wrong passphrase/);
  const tampered = Buffer.from(JSON.stringify({ ...json, meta: { ...json.meta, ipns: `k51${'x'.repeat(59)}` } }));
  await assert.rejects(decryptKeyBackup(tampered, 'correct horse battery'), /Wrong passphrase, or the backup file was changed/);
  const hostile = Buffer.from(JSON.stringify({ ...json, kdf: { ...json.kdf, N: 2 ** 30 } }));
  await assert.rejects(decryptKeyBackup(hostile, 'correct horse battery'), /unsupported encryption settings/);
  await assert.rejects(decryptKeyBackup(Buffer.from('{}'), 'x'), /not a Bucks site key backup/);
});

test('health: states in order, each failing check named', async () => {
  const cid = 'bafyroot';
  const node = { ready: true, online: true, peerId: 'Self', pinned: true, connectivity: 'online' };
  const router = (ids) => async (url) => {
    assert.match(String(url), /\/routing\/v1\/providers\/bafyroot$/);
    return new Response(JSON.stringify({ Providers: ids.map((ID) => ({ Schema: 'peer', ID, Addrs: [] })) }));
  };
  assert.equal((await checkHealth({ cid, node: { ...node, ready: false } })).failing.message, 'Your IPFS node is not running. Start it to host your sites.');
  assert.equal((await checkHealth({ cid, node: { ...node, online: false } })).state, 'local-only');
  const unreachable = await checkHealth({ cid, node: { ...node, connectivity: 'offline' }, lastAnnounce: { ok: false, error: 'cannot provide, no connected peers' } });
  assert.equal(unreachable.state, 'local-only');
  assert.match(unreachable.failing.message, /^Your site is saved on this computer but other people cannot reach it yet\./);
  const notListed = await checkHealth({ cid, node, routerUrl: 'https://router.example', fetchImpl: router(['Other']) });
  assert.equal(notListed.state, 'announcing');
  assert.equal(notListed.failing.id, 'discoverable');
  const alone = await checkHealth({ cid, node, routerUrl: 'https://router.example', fetchImpl: router(['Self']) });
  assert.equal(alone.state, 'discoverable');
  assert.equal(alone.failing.id, 'redundant');
  assert.match(alone.failing.message, /^Redundant: no\./);
  assert.equal(alone.checks.find((c) => c.id === 'reachable').ok, null, 'no probe configured: not tested');
  const two = await checkHealth({ cid, node, routerUrl: 'https://router.example', fetchImpl: router(['Self', 'Device']) });
  assert.equal(two.state, 'redundant');
  assert.equal(two.providers, 2);
  assert.equal(two.failing, null);
});

test('health: the outside probe must return the block the CID names', async () => {
  const bytes = new TextEncoder().encode('root block');
  const cid = CID.createV1(raw.code, await sha256.digest(bytes)).toString();
  const serve = (body) => async (url) => {
    assert.match(String(url), new RegExp(`/ipfs/${cid}\\?format=raw$`));
    return new Response(body);
  };
  assert.equal(await probeRootBlock(serve(bytes), 'https://probe.example', cid), true);
  await assert.rejects(probeRootBlock(serve(new TextEncoder().encode('forged')), 'https://probe.example', cid), /does not match the CID/);
  const fetchImpl = async (url) => (String(url).includes('/routing/') ? new Response(JSON.stringify({ Providers: [{ ID: 'Self' }] })) : new Response(bytes));
  const reached = await checkHealth({ cid, node: { ready: true, online: true, peerId: 'Self', pinned: true, connectivity: 'online' }, fetchImpl, routerUrl: 'https://r.example', probeUrl: 'https://probe.example' });
  assert.equal(reached.state, 'reachable');
  assert.deepEqual(await routerProviders(async () => new Response('', { status: 404 }), 'https://r.example', cid), []);
});

test('pinning services: tokens sealed at rest, Pinning Service API calls, endpoint rules', async (t) => {
  const dir = await tmp(t);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST') return new Response(JSON.stringify({ requestid: 'r1', status: 'queued', pin: { cid: 'bafyroot' } }), { status: 202 });
    if (init.method === 'GET') return new Response(JSON.stringify({ count: 1, results: [{ requestid: 'r1', status: 'pinned', pin: { cid: 'bafyroot' } }] }));
    return new Response(null, { status: 202 });
  };
  const seal = (s) => Buffer.from(`sealed:${Buffer.from(s).toString('hex')}`);
  const unseal = (b) => Buffer.from(b.toString().replace('sealed:', ''), 'hex').toString();
  const svc = createPinningServices({ dir, seal, unseal, canSeal: () => true, fetchImpl });
  await svc.add({ name: 'pinata', endpoint: 'https://api.pinata.example/psa/', token: 'secret-token-123' });
  assert.deepEqual(svc.list(), [{ name: 'pinata', endpoint: 'https://api.pinata.example/psa' }]);
  const disk = await fsp.readFile(path.join(dir, 'pinning-services.json'), 'utf8');
  assert.ok(!disk.includes('secret-token-123'), 'never in clear on disk');
  assert.deepEqual(await svc.pin('pinata', 'bafyroot', { name: 'Site', origins: ['/ip4/1.2.3.4/tcp/4001/p2p/x'] }), { requestid: 'r1', status: 'queued', cid: 'bafyroot', created: null });
  assert.equal(requests[0].url, 'https://api.pinata.example/psa/pins');
  assert.equal(requests[0].auth, 'Bearer secret-token-123');
  assert.deepEqual(requests[0].body, { cid: 'bafyroot', name: 'Site', origins: ['/ip4/1.2.3.4/tcp/4001/p2p/x'] });
  assert.equal((await svc.status('pinata', 'bafyroot'))[0].status, 'pinned');
  await svc.unpin('pinata', 'bafyroot');
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.equal(requests.at(-1).url, 'https://api.pinata.example/psa/pins/r1');
  await assert.rejects(svc.pin('nope', 'bafyroot'), /No pinning service called "nope"/);
  assert.deepEqual(await svc.remove('pinata'), []);

  const noKeychain = createPinningServices({ dir, seal, unseal, canSeal: () => false, fetchImpl });
  await assert.rejects(noKeychain.add({ name: 'x', endpoint: 'https://x.example', token: 'secret-token-123' }), /no OS keychain/);
  assert.throws(() => validateEndpoint('http://pins.example'), /must use https/);
  assert.throws(() => validateEndpoint('https://user:pw@pins.example'), /not in the URL/);
  assert.equal(validateEndpoint('http://127.0.0.1:9000/'), 'http://127.0.0.1:9000');
});
