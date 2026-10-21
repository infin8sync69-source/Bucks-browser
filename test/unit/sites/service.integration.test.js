// The hosting pipeline against a real Kubo, offline on loopback (docs/IPFS-HOSTING-IMPLEMENTATION.md
// §14): generated sites only (the Legrand build is never committed). Skipped without a Kubo binary
// (BUCKS_KUBO_BIN or resources/kubo/linux-x64/ipfs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createKubo } from '../../../src/main/ipfs/kubo.js';
import { createIpfsHandler } from '../../../src/main/protocols/ipfs.js';
import { createSitesService } from '../../../src/main/sites/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bundled = path.join(repoRoot, 'resources', 'kubo', 'linux-x64', 'ipfs');
const binary = process.env.BUCKS_KUBO_BIN || (process.platform === 'linux' && process.arch === 'x64' ? bundled : null);
const skip = binary && fs.existsSync(binary) ? false : 'no Kubo binary (set BUCKS_KUBO_BIN)';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const MiB = 1024 * 1024;

async function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
}

const nav = (url, extra = {}) => new Request(url, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, ...extra });

async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-sites-it-'));
  const prev = { bin: process.env.BUCKS_KUBO_BIN, offline: process.env.BUCKS_KUBO_OFFLINE };
  process.env.BUCKS_KUBO_BIN = binary;
  process.env.BUCKS_KUBO_OFFLINE = '1';
  t.after(() => {
    for (const [k, v] of [['BUCKS_KUBO_BIN', prev.bin], ['BUCKS_KUBO_OFFLINE', prev.offline]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const settings = { get: () => ({ ipfs: { mode: 'embedded', publicGateway: 'https://ipfs.io', preferredGateway: 'local', peers: [] }, sites: { quotaMiB: 500, historyLimit: 2, routerUrl: '', probeUrl: '' } }), onChange: () => () => {} };
  const kubo = createKubo({ settings, userData: path.join(root, 'profile'), resourcesDir: path.join(root, 'none'), log: quiet });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => kubo.stop());
  await kubo.start();
  const handler = createIpfsHandler({ kubo, settings });
  const events = [];
  const shared = [];
  const devices = { share: async (s) => { shared.push(s); return { queued: true, onlinePeers: 0 }; } };
  const sites = createSitesService({ kubo, settings, userData: path.join(root, 'profile'), handler, devices, emit: (e) => events.push(e), log: quiet });
  return { root, kubo, handler, sites, events, shared };
}

test('publish a history-router SPA, serve deep links, update it, roll back, export, unpublish', { skip, timeout: 240_000 }, async (t) => {
  const { root, kubo, handler, sites, events, shared } = await setup(t);
  const src = path.join(root, 'project');
  // A TanStack-style SPA build: no index.html, only the shell, a server call, a secret file and a link.
  await writeTree(src, {
    'package.json': JSON.stringify({ dependencies: { '@tanstack/react-start': '1' } }),
    'dist/client/_shell.html': '<!doctype html><html><head><title>Trainer</title></head><body><div id=app></div><script type="module" src="/assets/index.js"></script></body></html>',
    'dist/client/assets/index.js': 'fetch("/_serverFn/createAvatarEmbed"); history.pushState({}, "", "/trainer");',
    'dist/client/assets/style.css': 'body{margin:0}',
    'dist/client/brand/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'dist/client/.env': 'LIVEAVATAR_API_KEY=never-published',
    'dist/client/big.bin': randomBytes(3 * MiB),
  });
  fs.symlinkSync('/etc/passwd', path.join(src, 'dist', 'client', 'passwd'));

  const chosen = await sites.registerFolder(src);
  assert.equal(chosen.name, 'project');
  assert.deepEqual(chosen.hints, { suggestedDir: 'dist/client', framework: 'tanstack-start', isStatic: true, note: null });
  const first = await sites.inspect({ token: chosen.token });
  assert.equal(first.blocked, true);
  assert.equal(first.checks.find((c) => c.id === 'P1').fix.action, 'use-shell-as-index');
  const fixes = { useShellAsIndex: true, enableSpa: true };
  const checked = await sites.inspect({ token: chosen.token, ...fixes });
  assert.equal(checked.blocked, false);
  assert.deepEqual(checked.checks.map((c) => c.id).sort(), ['P2', 'P3', 'P6', 'P9']);

  // preview: added unpinned, marked as a preview
  const preview = await sites.preview({ token: chosen.token, ...fixes });
  assert.equal(handler.badgeFor(preview.url).kind, 'preview');
  assert.ok(!(await kubo.rpc.pinLs()).some((p) => p.cid === preview.previewCid), 'a preview is not pinned');

  const published = await sites.publish({ token: chosen.token, name: 'Trainer', ...fixes, hosting: { pinToDevices: ['12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN'] } });
  assert.equal(published.cid, preview.previewCid, 'same content, same CID');
  assert.match(published.ipns, /^k51/);
  assert.deepEqual(published.urls, {
    ipfs: `ipfs://${published.cid}/`, ipns: `ipns://${published.ipns}/`,
    gateway: `https://${published.cid}.ipfs.dweb.link/`, gatewayIpns: `https://${published.ipns}.ipns.dweb.link/`,
  });
  assert.deepEqual(published.announce, { ok: false, at: published.announce.at, error: 'The node runs offline.' });
  assert.deepEqual(shared, [{ cid: published.cid, name: 'Trainer', size: checked.bytes }]);
  assert.deepEqual([...new Set(events.filter((e) => e.id === published.id).map((e) => e.step))], ['inspect', 'add', 'self-test', 'name', 'announce', 'record']);
  assert.equal(handler.badgeFor(`ipfs://${published.cid}/`).kind, 'content-addressed', 'no longer a preview');
  assert.ok((await kubo.rpc.pinLs()).some((p) => p.cid === published.cid));

  // serving: entry, SPA deep link (F1: renders, never downloads), missing asset, range on a large file
  for (const scheme of [`ipfs://${published.cid}`, `ipns://${published.ipns}`]) {
    const home = await handler(nav(`${scheme}/`));
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /^text\/html/);
    assert.match(await home.text(), /<title>Trainer<\/title>/);
    const deep = await handler(nav(`${scheme}/deep/link`));
    assert.equal(deep.status, 200, `${scheme}/deep/link`);
    assert.equal(deep.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await deep.text(), /<div id=app>/);
    assert.equal((await handler(nav(`${scheme}/assets/missing.js`))).status, 404);
    const js = await handler(nav(`${scheme}/assets/index.js`));
    assert.match(js.headers.get('content-type'), /javascript/);
    await js.text();
    const range = await handler(new Request(`${scheme}/big.bin`, { headers: { range: 'bytes=100-199' } }));
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 100);
  }
  assert.equal((await handler(nav(`ipfs://${published.cid}/.env`))).status, 404, 'the secret file was not published');
  // Kubo itself answers /ipfs/<A>/..%2F<B>/x with B's file; the handler must never put B on A's origin
  const other = await kubo.rpc.add(new TextEncoder().encode('<!doctype html>EVIL'), { fileName: 'evil.html', wrapWithDirectory: true });
  for (const url of [`ipfs://${published.cid}/..%2F${other.cid}/evil.html`, `ipns://${published.ipns}/..%2F..%2Fipfs%2F${other.cid}/evil.html`]) {
    const res = await handler(nav(url));
    assert.equal(res.status, 400, url);
    assert.doesNotMatch(await res.text(), /EVIL/);
  }
  const link = await handler(nav(`ipfs://${published.cid}/passwd`));
  assert.doesNotMatch(await link.text(), /root:/, 'the link was not followed (SPA mode answers with the app shell)');
  assert.ok(!(await kubo.rpc.ls(published.cid)).some((e) => e.name === 'passwd' || e.name === '.env'));
  assert.equal(handler.badgeFor(`ipns://${published.ipns}/`).cid, published.cid);

  // update one file: a dry run shows the diff; exactly one new leaf plus its directories
  await fsp.writeFile(path.join(src, 'dist', 'client', 'assets', 'style.css'), 'body{margin:1px}');
  const review = await sites.update({ id: published.id, ...fixes });
  assert.equal(review.unchanged, false);
  assert.deepEqual(review.diff.counts, { added: 0, changed: 1, removed: 0 });
  assert.deepEqual(review.diff.changed, [{ path: 'assets/style.css', size: 16, previousSize: 14 }]);
  assert.equal(review.diff.blocks.new, 3, 'style.css + assets/ + the root directory');
  assert.ok(review.diff.blocks.reused > 3);
  assert.equal((await sites.list())[0].current.cid, published.cid, 'a dry run publishes nothing');
  await assert.rejects(sites.update({ id: published.id, ...fixes, confirm: true, expectCid: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' }), /changed since you reviewed/);
  const updated = await sites.update({ id: published.id, ...fixes, confirm: true, expectCid: review.cid });
  assert.equal(updated.cid, review.cid);
  const v2css = await handler(nav(`ipns://${published.ipns}/assets/style.css`));
  assert.equal(await v2css.text(), 'body{margin:1px}', 'the ipns address serves the new version');
  assert.equal(await (await handler(nav(`ipfs://${published.cid}/assets/style.css`))).text(), 'body{margin:0}', 'the old CID still serves the old one');

  // rollback
  assert.deepEqual(await sites.rollback({ id: published.id, cid: published.cid }), { cid: published.cid });
  assert.equal(await (await handler(nav(`ipns://${published.ipns}/assets/style.css`))).text(), 'body{margin:0}');
  await assert.rejects(sites.rollback({ id: published.id, cid: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' }), /not in this site's history/);

  // history limit 2: a third version trims the oldest one that is not current
  await sites.rollback({ id: published.id, cid: updated.cid });
  await fsp.writeFile(path.join(src, 'dist', 'client', 'assets', 'style.css'), 'body{margin:2px}');
  const third = await sites.update({ id: published.id, ...fixes, confirm: true });
  const [listed] = sites.list();
  assert.deepEqual(listed.history.map((v) => v.cid), [third.cid, updated.cid]);
  assert.equal(listed.folderName, 'client');
  assert.ok(!('sourceDir' in listed), 'the chrome never gets the folder path');
  assert.ok(!(await kubo.rpc.pinLs()).some((p) => p.cid === published.cid), 'the trimmed version was unpinned');

  // status: the node runs offline
  const health = await sites.status({ id: published.id });
  assert.equal(health.state, 'local-only');
  assert.equal(health.failing.id, 'announcing');

  // CAR export
  const car = path.join(root, 'site.car');
  const exported = await sites.exportCar({ id: published.id, file: car });
  assert.equal(exported.cid, third.cid);
  assert.ok(exported.bytes > 3 * MiB);

  // unpublish: 'delete-key' needs the typed name; 'unpin' keeps the key
  await assert.rejects(sites.unpublish({ id: published.id, mode: 'delete-key', confirm: 'nope' }), /Type the site name/);
  assert.deepEqual(await sites.unpublish({ id: published.id, mode: 'unpin' }), { ok: true });
  assert.deepEqual(sites.list(), []);
  const pins = (await kubo.rpc.pinLs()).map((p) => p.cid);
  assert.ok(![third.cid, updated.cid].some((c) => pins.includes(c)), 'every version unpinned');
  assert.ok((await kubo.rpc.keyList()).some((k) => k.id === published.ipns), 'the key is kept');
});

test('key backup and restore round-trip; a missing block is an error, never a truncated page', { skip, timeout: 240_000 }, async (t) => {
  const { root, kubo, handler, sites } = await setup(t);
  const src = path.join(root, 'site');
  await writeTree(src, { 'index.html': '<!doctype html><h1>Static</h1><a href="about.html">About</a>', 'about.html': '<!doctype html>about', 'file.bin': randomBytes(2 * MiB) });
  const { token } = await sites.registerFolder(src);
  const site = await sites.publish({ token, name: 'Static' });
  assert.equal(sites.list()[0].keyBackedUp, false);

  // backup → delete the key → restore into the same site
  const backup = path.join(root, 'static.bucks-key');
  await assert.rejects(sites.backupKey({ id: site.id, passphrase: 'short', file: backup }), /at least 10 characters/);
  await sites.backupKey({ id: site.id, passphrase: 'correct horse battery', file: backup });
  assert.equal(sites.list()[0].keyBackedUp, true);
  const fileText = await fsp.readFile(backup, 'utf8');
  assert.ok(fileText.includes(site.ipns) && !fileText.includes('PRIVATE'), 'the address is readable, the key is not');
  const keyName = sites.store.get(site.id).keyName;
  await kubo.rpc.keyRm(keyName);
  await assert.rejects(sites.restoreKey({ id: site.id, passphrase: 'wrong passphrase!', fileBytes: await fsp.readFile(backup) }), /Wrong passphrase/);
  assert.deepEqual(await sites.restoreKey({ id: site.id, passphrase: 'correct horse battery', fileBytes: await fsp.readFile(backup) }), { ok: true, id: site.id, ipns: site.ipns });
  assert.equal((await kubo.rpc.keyList()).find((k) => k.name === keyName)?.id, site.ipns);
  await assert.rejects(sites.restoreKey({ passphrase: 'correct horse battery', fileBytes: await fsp.readFile(backup) }), /already in your list/);

  // "Restore a site" on a new computer: forget the site, then restore from the key and a CAR
  const car = path.join(root, 'static.car');
  await sites.exportCar({ id: site.id, file: car });
  await sites.unpublish({ id: site.id, mode: 'stop' });
  await kubo.rpc.keyRm(keyName);
  const restored = await sites.restoreKey({ passphrase: 'correct horse battery', fileBytes: await fsp.readFile(backup), carFile: car });
  assert.equal(restored.ipns, site.ipns);
  assert.equal(restored.cid, site.cid);
  assert.equal(sites.list()[0].name, 'Static');
  assert.equal(sites.list()[0].current.cid, site.cid);

  // a missing block: Kubo answers 200 with the full Content-Length and cuts the body; the handler errors it
  await sites.unpublish({ id: restored.id, mode: 'unpin' });
  const fileCid = (await kubo.rpc.ls(site.cid)).find((e) => e.name === 'file.bin').cid;
  const leaves = await kubo.rpc.refs(fileCid);
  await kubo.rpc.call('block/rm', { args: [leaves[3]] });
  const res = await handler(new Request(`ipfs://${site.cid}/file.bin`));
  assert.equal(res.status, 200);
  await assert.rejects(res.arrayBuffer(), 'the body must fail, not end short');
});

test('a hash-router site with 2,000 files and one 50 MB file', { skip, timeout: 300_000 }, async (t) => {
  const { root, handler, sites } = await setup(t);
  const src = path.join(root, 'big-site');
  const files = { 'index.html': '<!doctype html><a href="#/route">hash router</a><script src="app.js"></script>', 'app.js': 'onhashchange = () => {}' };
  for (let i = 0; i < 2000; i += 1) files[`data/${String(i % 40).padStart(2, '0')}/item-${i}.json`] = JSON.stringify({ i });
  await writeTree(src, files);
  await fsp.writeFile(path.join(src, 'video.mp4'), randomBytes(50 * MiB));
  const { token } = await sites.registerFolder(src);
  const inspected = await sites.inspect({ token });
  assert.equal(inspected.files, 2003);
  assert.deepEqual(inspected.checks.map((c) => c.id), ['P12']);
  const site = await sites.publish({ token, name: 'Big', ipns: false });
  assert.equal(site.ipns, null);
  assert.equal(site.urls.ipns, null);
  const item = await handler(new Request(`ipfs://${site.cid}/data/07/item-1007.json`));
  assert.deepEqual(await item.json(), { i: 1007 });
  const tail = await handler(new Request(`ipfs://${site.cid}/video.mp4`, { headers: { range: `bytes=${50 * MiB - 10}-` } }));
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 10);
  await assert.rejects(sites.rollback({ id: site.id, cid: site.cid }), /no updatable address/);
});
