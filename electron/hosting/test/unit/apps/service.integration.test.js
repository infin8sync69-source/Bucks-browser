// The app environment against a real Kubo, offline on loopback (docs/APP-ENVIRONMENT.md §9):
// install from a folder, an ipfs:// and an ipns:// address; serve through bucks-app://; update
// with a permission diff; roll back; publish a folder app as a site and follow it; uninstall.
// Skipped without a Kubo binary (BUCKS_KUBO_BIN or resources/kubo/linux-x64/ipfs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKubo } from '../../../src/main/ipfs/kubo.js';
import { createIpfsHandler } from '../../../src/main/protocols/ipfs.js';
import { createSitesService } from '../../../src/main/sites/service.js';
import { createAppsService } from '../../../src/main/apps/service.js';
import { createAppProtocolHandler } from '../../../src/main/apps/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bundled = path.join(repoRoot, 'resources', 'kubo', 'linux-x64', 'ipfs');
const binary = process.env.BUCKS_KUBO_BIN || (process.platform === 'linux' && process.arch === 'x64' ? bundled : null);
const skip = binary && fs.existsSync(binary) ? false : 'no Kubo binary (set BUCKS_KUBO_BIN)';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
}

const manifest = (extra = {}) => JSON.stringify({
  spa: true,
  app: {
    name: 'Notes', version: '1.0.0', description: 'Take notes', icon: 'icon.svg',
    permissions: ['notifications'],
    agent: { tools: [{ name: 'count_notes', description: 'How many notes there are', input_schema: { type: 'object', properties: {} } }] },
    ...extra,
  },
});

const notesApp = (version, extra) => ({
  'index.html': `<!doctype html><html><head><title>Notes</title></head><body><div id=app></div><script type="module" src="/assets/app.js"></script></body></html>`,
  'assets/app.js': `document.getElementById('app').textContent = 'notes ${version}';`,
  'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>',
  'bucks-site.json': manifest({ version, ...extra }),
});

const nav = (url) => new Request(url, { headers: { accept: 'text/html,*/*;q=0.8' } });

function fakeContainer() {
  const calls = [];
  return {
    calls,
    open: async (a) => { calls.push(['open', a.id]); },
    close: () => {},
    reload: (id) => { calls.push(['reload', id]); },
    forget: async (id) => { calls.push(['forget', id]); },
    isRunning: () => false,
    invokeTool: async (a, name, input) => { calls.push(['tool', a.id, name]); return { ok: true, name, input }; },
  };
}

async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-apps-it-'));
  const prev = { bin: process.env.BUCKS_KUBO_BIN, offline: process.env.BUCKS_KUBO_OFFLINE };
  process.env.BUCKS_KUBO_BIN = binary;
  process.env.BUCKS_KUBO_OFFLINE = '1';
  t.after(() => {
    for (const [k, v] of [['BUCKS_KUBO_BIN', prev.bin], ['BUCKS_KUBO_OFFLINE', prev.offline]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const settings = { get: () => ({ ipfs: { mode: 'embedded', publicGateway: 'https://ipfs.io', preferredGateway: 'local', peers: [] }, sites: { quotaMiB: 500, historyLimit: 2, routerUrl: '', probeUrl: '' } }), onChange: () => () => {} };
  const userData = path.join(root, 'profile');
  const kubo = createKubo({ settings, userData, resourcesDir: path.join(root, 'none'), log: quiet });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => kubo.stop());
  await kubo.start();
  const handler = createIpfsHandler({ kubo, settings });
  const sites = createSitesService({ kubo, settings, userData, handler, log: quiet });
  const container = fakeContainer();
  const events = [];
  const apps = createAppsService({ kubo, settings, userData, sites: { service: sites, store: sites.store }, container, emit: (e) => events.push(e), log: quiet });
  const serve = createAppProtocolHandler({ getApp: (id) => apps.record(id), ipfsHandler: handler, kubo });
  const pinned = async () => new Set((await kubo.rpc.pinLs()).map((p) => p.cid));
  return { root, kubo, sites, apps, container, serve, events, pinned };
}

test('a folder app: review, install, serve, tools, update with new permissions, roll back, publish, uninstall', { skip, timeout: 240_000 }, async (t) => {
  const { root, sites, apps, container, serve, events, pinned } = await setup(t);
  const dir = path.join(root, 'notes');
  await writeTree(dir, notesApp('1.0.0'));

  // review before anything is installed
  const chosen = await apps.registerFolder(dir);
  const review = await apps.inspect({ folderToken: chosen.token });
  assert.equal(review.name, 'Notes');
  assert.equal(review.version, '1.0.0');
  assert.equal(review.source.kind, 'folder');
  assert.deepEqual(review.permissions.map((p) => p.id), ['notifications', 'agent-tools']);
  assert.match(review.permissions[1].description, /count_notes/);
  assert.ok(review.size > 0);
  assert.ok(!(await pinned()).has(review.cid), 'nothing is pinned by a review');
  assert.ok(events.some((e) => e.type === 'progress'));

  // install, leaving the agent tools off
  const installed = await apps.install({ token: review.token, granted: ['notifications'] });
  assert.match(installed.id, /^a_[a-f0-9]{10}$/);
  assert.deepEqual(installed.permissions.map((p) => [p.id, p.granted]), [['notifications', true], ['agent-tools', false]]);
  assert.ok((await pinned()).has(review.cid), 'installed apps are pinned');
  assert.match(await apps.iconDataUrl({ id: installed.id }), /^data:image\/svg\+xml;base64,/);
  await assert.rejects(apps.install({ token: review.token }), /expired/, 'a review token is single-use');

  // served from its own origin: entry, assets, SPA deep links, directory redirects, refusals
  const base = `bucks-app://${installed.id}`;
  let res = await serve(nav(`${base}/`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /<title>Notes<\/title>/);
  res = await serve(nav(`${base}/notes/42`));
  assert.equal(res.status, 200, 'single-page-app deep link');
  assert.match(await res.text(), /<div id=app>/);
  res = await serve(new Request(`${base}/assets/app.js`));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /notes 1\.0\.0/);
  res = await serve(new Request(`${base}/assets`, { redirect: 'manual' }));
  if (res.status >= 300 && res.status < 400) assert.equal(res.headers.get('location'), `${base}/assets/`, 'redirects stay on the app origin');
  else await res.body?.cancel();
  res = await serve(nav(`${base}/..%2F${review.cid}/index.html`));
  assert.equal(res.status, 400);
  res = await serve(nav('bucks-app://a_ffffffffff/'));
  assert.equal(res.status, 404);
  await res.body?.cancel();

  // agent tools only once allowed
  await assert.rejects(apps.callTool({ id: installed.id, tool: 'count_notes', input: {} }), /not allowed to offer tools/);
  await apps.setPermission({ id: installed.id, permission: 'agent-tools', granted: true });
  assert.deepEqual(await apps.callTool({ id: installed.id, tool: 'count_notes', input: {} }), { ok: true, name: 'count_notes', input: {} });
  await assert.rejects(apps.callTool({ id: installed.id, tool: 'rm_rf', input: {} }), /no tool "rm_rf"/);
  await assert.rejects(apps.setPermission({ id: installed.id, permission: 'camera', granted: true }), /does not ask/);

  // the folder changed: v2 asks for the network
  await writeTree(dir, notesApp('2.0.0', { permissions: ['notifications', 'network:https://api.example.com'] }));
  const check = await apps.checkUpdate({ id: installed.id });
  assert.equal(check.available, true);
  assert.equal(check.version, '2.0.0');
  assert.deepEqual(check.added.map((p) => p.id), ['network:https://api.example.com']);
  const dry = await apps.update({ id: installed.id });
  assert.equal(dry.applied, false, 'new permissions need a confirmation');
  const done = await apps.update({ id: installed.id, confirm: true });
  assert.equal(done.applied, true);
  assert.equal(done.app.version, '2.0.0');
  assert.ok(done.app.permissions.find((p) => p.id === 'network:https://api.example.com').granted);
  assert.ok(container.calls.some(([op, id]) => op === 'reload' && id === installed.id), 'a running app is reloaded');
  res = await serve(new Request(`${base}/assets/app.js`));
  assert.match(await res.text(), /notes 2\.0\.0/, 'the same origin serves the new version');
  const v2 = done.app.cid;

  // roll back: v1 again, and grants never wider than v1 asked for
  const back = await apps.rollback({ id: installed.id });
  assert.equal(back.version, '1.0.0');
  assert.equal(back.cid, review.cid);
  assert.ok(!back.permissions.some((p) => p.id.startsWith('network:')));
  assert.equal(back.previousVersion.cid, v2);

  // host it: the folder becomes a site and the app follows the site's ipns:// address
  const pub = await apps.publish({ id: installed.id });
  assert.match(pub.ipns, /^k51/);
  const afterPublish = apps.get({ id: installed.id });
  assert.equal(afterPublish.source.kind, 'site');
  assert.equal(afterPublish.urls.ipns, `ipns://${pub.ipns}/`);
  const site = sites.store.get(pub.siteId);
  assert.equal(site.current.cid, v2, 'the folder (v2) was published');
  assert.equal(pub.update.available, true, 'the app (rolled back to v1) sees the published v2 as an update');

  // uninstall: storage cleared, icon gone, content unpinned unless a site still uses it
  const before = await pinned();
  assert.ok(before.has(review.cid) && before.has(v2));
  await apps.uninstall({ id: installed.id });
  assert.ok(container.calls.some(([op, id]) => op === 'forget' && id === installed.id));
  assert.deepEqual(apps.list(), []);
  const after = await pinned();
  assert.ok(!after.has(review.cid), 'v1 was only the app\'s: unpinned');
  assert.ok(after.has(v2), 'v2 is the hosted site: still pinned');
  assert.equal(fs.existsSync(path.join(root, 'profile', 'apps', installed.id)), false);
});

test('install from ipfs:// (one version) and from ipns:// (follows updates)', { skip, timeout: 240_000 }, async (t) => {
  const { root, kubo, sites, apps } = await setup(t);
  const dir = path.join(root, 'site');
  await writeTree(dir, notesApp('1.0.0', { name: 'Hosted notes', permissions: [] }));
  const chosen = await sites.registerFolder(dir);
  const published = await sites.publish({ token: chosen.token, name: 'Hosted notes' });

  const byCid = await apps.install({ token: (await apps.inspect({ address: `ipfs://${published.cid}/` })).token });
  assert.equal(byCid.source.kind, 'ipfs');
  assert.equal(byCid.canUpdate, false);
  assert.match((await apps.checkUpdate({ id: byCid.id })).reason, /one exact version/);

  const review = await apps.inspect({ address: `ipns://${published.ipns}` });
  assert.equal(review.cid, published.cid);
  assert.equal(review.alreadyInstalled, null, 'a different source is a different app');
  const byName = await apps.install({ token: review.token });
  assert.equal(byName.source.kind, 'ipns');
  assert.equal((await apps.checkUpdate({ id: byName.id })).available, false);

  // the publisher updates the site; the ipns app sees it
  await writeTree(dir, notesApp('1.1.0', { name: 'Hosted notes', permissions: [] }));
  const dry = await sites.update({ id: published.id, token: (await sites.registerFolder(dir)).token });
  await sites.update({ id: published.id, token: (await sites.registerFolder(dir)).token, confirm: true, expectCid: dry.cid });
  const check = await apps.checkUpdate({ id: byName.id });
  assert.equal(check.available, true);
  assert.deepEqual(check.added, [], 'no new permissions');
  const done = await apps.update({ id: byName.id, confirm: true });
  assert.equal(done.app.version, '1.1.0');
  assert.equal(apps.get({ id: byCid.id }).version, '1.0.0', 'the ipfs:// app stays on its version');

  // a bare k51… name is an IPNS name, not content
  await assert.rejects(apps.inspect({ address: `ipfs://${published.ipns}` }), /is an IPNS name/);
  assert.equal(kubo.isReady(), true);
});
