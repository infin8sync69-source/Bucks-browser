import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('../main/helpers/electron-loader.mjs', import.meta.url);
const { ipcMain, dialog, safeStorage } = await import('electron');
const { createSites, validators } = await import('../../../src/main/sites/ipc.js');

const CHANNELS = [
  'choose-folder', 'inspect', 'preview', 'publish', 'update', 'list', 'status', 'rollback', 'unpublish',
  'backup-key', 'restore-key', 'export-car', 'pinning-services', 'add-pinning-service', 'remove-pinning-service',
].map((c) => `bucks:sites:${c}`);
const chrome = { senderFrame: { url: 'bucks://app/sites' } };
const call = (channel, payload, event = chrome) => ipcMain._handlers.get(channel)(event, payload);

async function setup(t) {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-sites-ipc-'));
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));
  const site = path.join(userData, 'my-site');
  await fsp.mkdir(site);
  await fsp.writeFile(path.join(site, 'index.html'), '<!doctype html>hi');
  const kubo = { isReady: () => false, rpc: null, status: () => ({ peer_id: null }) };
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (ch, p) => sent.push([ch, p]) } };
  const sites = createSites({ kubo, settings: { get: () => ({ sites: {} }) }, userData, handler: async () => new Response(''), getMainWindow: () => win });
  return { userData, site, sites, sent };
}

test('every bucks:sites:* channel is registered and refuses senders other than the chrome', async (t) => {
  await setup(t);
  for (const ch of CHANNELS) assert.ok(ipcMain._handlers.has(ch), ch);
  for (const event of [{ senderFrame: { url: 'https://evil.example/' } }, { senderFrame: { url: `ipfs://bafyx/` } }, {}, { senderFrame: null }]) {
    await assert.rejects(call('bucks:sites:list', {}, event), /denied for this origin/);
  }
  assert.deepEqual(await call('bucks:sites:list'), []);
});

test('folders come only from the main-process dialog, as tokens', async (t) => {
  const { site } = await setup(t);
  assert.equal(await call('bucks:sites:choose-folder'), null, 'cancelled');
  const prev = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [site] });
  t.after(() => { dialog.showOpenDialog = prev; });
  const chosen = await call('bucks:sites:choose-folder');
  assert.equal(chosen.name, 'my-site');
  assert.match(chosen.token, /^[A-Za-z0-9_-]{32}$/);
  const inspection = await call('bucks:sites:inspect', { token: chosen.token });
  assert.equal(inspection.files, 1);
  assert.equal(inspection.blocked, false);
  assert.equal(inspection.folderName, 'my-site');
  await assert.rejects(call('bucks:sites:inspect', { token: site }), /Choose the folder again|token is too long/, 'a path is not a token');
  await assert.rejects(call('bucks:sites:publish', { token: chosen.token }), /Your IPFS node is not running/);
});

test('payload validation', () => {
  assert.throws(() => validators.inspect({}), /token is required/);
  assert.throws(() => validators.inspect({ token: 5 }), /token must be a string/);
  assert.throws(() => validators.publish({ token: 'x'.repeat(65) }), /too long/);
  assert.deepEqual(validators.publish({ token: 't', ipns: 'no', hosting: [], exclude: ['a/'], enableSpa: 1 }), { token: 't', name: undefined, ipns: true, hosting: {}, exclude: ['a/'], useShellAsIndex: false, enableSpa: false });
  assert.deepEqual(validators.update({ id: 's_1', confirm: 'yes' }), { id: 's_1', token: undefined, confirm: false, expectCid: null, useShellAsIndex: false, enableSpa: false });
  assert.throws(() => validators.inspect({ token: 't', exclude: [1] }), /exclude\[0\] must be a string/);
  assert.throws(() => validators.passphrase({}), /passphrase is required/);
});

test('backup and export dialogs run in main; cancelling is not an error; tokens need a keychain', async (t) => {
  const { userData } = await setup(t);
  await assert.rejects(call('bucks:sites:backup-key', { id: 's_0000000000', passphrase: 'correct horse battery' }), /No such site/);
  assert.deepEqual(await call('bucks:sites:restore-key', { passphrase: 'correct horse battery' }), { ok: false });
  safeStorage.available = false;
  await assert.rejects(call('bucks:sites:add-pinning-service', { name: 'pinata', endpoint: 'https://pins.example', token: 'secret-token-123' }), /no OS keychain/);
  safeStorage.available = true;
  t.after(() => { safeStorage.available = false; });
  assert.deepEqual(await call('bucks:sites:add-pinning-service', { name: 'pinata', endpoint: 'https://pins.example', token: 'secret-token-123' }), [{ name: 'pinata', endpoint: 'https://pins.example' }]);
  const disk = await fsp.readFile(path.join(userData, 'sites', 'pinning-services.json'), 'utf8');
  assert.ok(!disk.includes('secret-token-123'));
  assert.deepEqual(await call('bucks:sites:pinning-services'), [{ name: 'pinata', endpoint: 'https://pins.example' }]);
  assert.deepEqual(await call('bucks:sites:remove-pinning-service', { name: 'pinata' }), []);
});
