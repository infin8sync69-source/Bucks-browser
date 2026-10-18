import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { makeSettings, settle } from './helpers.js';

register('../main/helpers/electron-loader.mjs', import.meta.url);
const { ipcMain } = await import('electron');
const { createDevices, validatePairPayload, validateSharePayload } = await import('../../../src/main/ipfs/devices.js');

const MAC = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const CID1 = 'bafkreigks6arfsq3xxfpvqrrwonchxcnu6do76auprhhfomao6c273sixm';

test('payload validators', () => {
  assert.deepEqual(validatePairPayload({ peerId: MAC }), { peerId: MAC, name: undefined, addrs: undefined });
  assert.deepEqual(validatePairPayload({ peerId: MAC, name: 'Mac', addrs: ['/ip4/1.2.3.4/tcp/1'] }), { peerId: MAC, name: 'Mac', addrs: ['/ip4/1.2.3.4/tcp/1'] });
  assert.throws(() => validatePairPayload(null), /expects an object/);
  assert.throws(() => validatePairPayload({}), /peerId is required/);
  assert.throws(() => validatePairPayload({ peerId: 5 }), /peerId must be a string/);
  assert.throws(() => validatePairPayload({ peerId: MAC, addrs: '/ip4/1.2.3.4' }), /addrs must be an array/);
  assert.throws(() => validatePairPayload({ peerId: MAC, addrs: [1] }), /addrs\[0\] must be a string/);
  assert.throws(() => validatePairPayload({ peerId: 'x'.repeat(600) }), /too long/);
  assert.deepEqual(validateSharePayload({ cid: CID1 }), { cid: CID1, name: undefined, size: null });
  assert.deepEqual(validateSharePayload({ cid: CID1, name: 'a.txt', size: 3 }), { cid: CID1, name: 'a.txt', size: 3 });
  assert.throws(() => validateSharePayload({ cid: CID1, size: 1.5 }), /size/);
  assert.throws(() => validateSharePayload({ name: 'x' }), /cid is required/);
});

test('createDevices registers the six bucks:devices:* handlers and sends bucks:devices:updated', async (t) => {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-devices-ipc-'));
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (ch, payload) => sent.push([ch, payload]) } };
  const kubo = { isReady: () => false, rpc: null, apiUrl: () => null, status: () => ({ peer_id: null }), onStatus: () => () => {} };
  const settings = makeSettings();
  const service = createDevices({ kubo, settings, userData, getMainWindow: () => win });
  t.after(() => service.stop());
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));

  const h = ipcMain._handlers;
  for (const ch of ['status', 'pair', 'unpair', 'rename', 'share', 'dismiss']) assert.equal(typeof h.get(`bucks:devices:${ch}`), 'function', ch);

  const st = await h.get('bucks:devices:status')({});
  assert.equal(st.topic, 'bucks-devices-v1');
  assert.equal(st.self.version, '0.0.0-test'); // app.getVersion()
  assert.equal(st.self.platform, process.platform);
  assert.equal(st.self.name, os.hostname().replace(/\.local$/i, '').slice(0, 64));

  const paired = await h.get('bucks:devices:pair')({}, { peerId: `/ip4/192.168.1.20/tcp/4001/p2p/${MAC}`, name: 'Mac' });
  assert.deepEqual(paired.paired.map((p) => [p.peerId, p.name, p.addrs]), [[MAC, 'Mac', ['/ip4/192.168.1.20/tcp/4001']]]);
  await assert.rejects(async () => h.get('bucks:devices:pair')({}, 'nope'), /expects an object payload/);
  await assert.rejects(async () => h.get('bucks:devices:pair')({}, { peerId: 'nope' }), /not a peer ID/);

  const renamed = await h.get('bucks:devices:rename')({}, { name: 'Linux box' });
  assert.equal(renamed.self.name, 'Linux box');
  await assert.rejects(async () => h.get('bucks:devices:rename')({}, { name: 3 }), /name must be a string/);

  assert.deepEqual(await h.get('bucks:devices:share')({}, { cid: CID1, name: 'a.txt', size: 3 }), { queued: true, onlinePeers: 0 });
  await assert.rejects(async () => h.get('bucks:devices:share')({}, { cid: 'nope' }), /Not a valid CID/);

  const dismissed = await h.get('bucks:devices:dismiss')({}, { cid: CID1, from: MAC });
  assert.deepEqual(dismissed.received, []);
  await assert.rejects(async () => h.get('bucks:devices:dismiss')({}, { cid: CID1 }), /from is required/);

  const unpaired = await h.get('bucks:devices:unpair')({}, { peerId: MAC });
  assert.deepEqual(unpaired.paired, []);

  await new Promise((r) => setTimeout(r, 300));
  await settle();
  assert.ok(sent.length > 0, 'status events sent to the chrome window');
  assert.ok(sent.every(([ch]) => ch === 'bucks:devices:updated'));
  assert.deepEqual(sent.at(-1)[1].paired, []);
});
