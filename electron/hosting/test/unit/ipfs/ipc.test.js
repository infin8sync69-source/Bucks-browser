import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../main/helpers/electron-loader.mjs', import.meta.url);
const { ipcMain } = await import('electron');
const { registerIpfsIpc, validateIpfsSettingsPatch, pickIpfsSettings } = await import('../../../src/main/ipfs/ipc.js');
const { DEFAULT_SETTINGS, deepMerge } = await import('../../../src/main/settings-defaults.js');

const SHELL = 'file:///opt/bucks/electron/index.html';
const shell = { senderFrame: { url: SHELL } };
const call = (channel, payload, event = shell) => ipcMain._handlers.get(channel)(event, payload);

function setup() {
  let current = structuredClone(DEFAULT_SETTINGS);
  const settings = {
    get: () => structuredClone(current),
    set(patch) { current = deepMerge(current, patch); return structuredClone(current); },
  };
  const kubo = {
    isReady: () => false,
    rpc: null,
    status: () => ({ state: 'stopped', message: 'IPFS node stopped.' }),
    start: async () => ({ state: 'ready' }),
    stop: async () => ({ state: 'stopped' }),
    restart: async () => ({ state: 'ready' }),
    gatewayUrlFor: (u) => u,
  };
  registerIpfsIpc({ kubo, settings, isAllowedSender: (url) => url === SHELL });
  return { settings };
}

test('only the shell page may call bucks:ipfs:*', async () => {
  setup();
  for (const ch of ['status', 'start', 'stop', 'restart', 'settings', 'set-settings', 'add-text', 'ls', 'pin-ls', 'stats']) {
    assert.ok(ipcMain._handlers.has(`bucks:ipfs:${ch}`), ch);
  }
  for (const event of [{ senderFrame: { url: 'https://evil.example/' } }, { senderFrame: { url: 'ipfs://bafyx/' } }, {}, { senderFrame: null }]) {
    await assert.rejects(call('bucks:ipfs:settings', undefined, event), /denied for this origin/);
    await assert.rejects(call('bucks:ipfs:set-settings', { autoStart: false }, event), /denied for this origin/);
  }
  assert.equal((await call('bucks:ipfs:status')).state, 'stopped');
  assert.equal((await call('bucks:ipfs:restart')).state, 'ready');
  await assert.rejects(call('bucks:ipfs:add-text', { content: 'x' }), /IPFS node is not ready/);
});

test('settings: the panel reads and saves only the node options, validated', async () => {
  const { settings } = setup();
  assert.deepEqual(Object.keys(await call('bucks:ipfs:settings')).sort(), ['autoStart', 'externalApiUrl', 'mode', 'preferredGateway', 'publicGateway', 'storageMaxGB']);
  const saved = await call('bucks:ipfs:set-settings', {
    autoStart: false, mode: 'external', externalApiUrl: ' http://192.168.1.20:5001/ ', publicGateway: 'https://dweb.link/ipfs/', preferredGateway: 'public', storageMaxGB: '25',
  });
  assert.deepEqual(saved, { mode: 'external', externalApiUrl: 'http://192.168.1.20:5001', publicGateway: 'https://dweb.link', preferredGateway: 'public', autoStart: false, storageMaxGB: 25 });
  assert.deepEqual(pickIpfsSettings(settings.get().ipfs), saved);
  assert.deepEqual(settings.get().ipfs.peers, [], 'paired devices are untouched');
  await assert.rejects(call('bucks:ipfs:set-settings', { peers: [{ peerId: 'x' }] }), /Unknown IPFS setting: peers/);
});

test('validateIpfsSettingsPatch refuses bad values with a readable reason', () => {
  const bad = [
    [{ mode: 'cluster' }, /mode must be/],
    [{ externalApiUrl: 'not a url' }, /not a valid URL/],
    [{ externalApiUrl: 'ftp://127.0.0.1:5001' }, /http:\/\/ or https:\/\//],
    [{ externalApiUrl: 'http://user:pw@127.0.0.1:5001' }, /user name or password/],
    [{ externalApiUrl: 'http://127.0.0.1:5001/api/v0' }, /only the node API address/],
    [{ publicGateway: 'http://ipfs.io' }, /must use https/],
    [{ publicGateway: 'https://192.168.1.1' }, /public host/],
    [{ preferredGateway: 'cloud' }, /preferredGateway must be/],
    [{ autoStart: 'yes' }, /autoStart must be true or false/],
    [{ storageMaxGB: 0 }, /whole number of GB/],
    [{ storageMaxGB: 2.5 }, /whole number of GB/],
    [{ storageMaxGB: 100_001 }, /whole number of GB/],
    [null, /must be an object/],
    [[], /must be an object/],
  ];
  for (const [patch, re] of bad) assert.throws(() => validateIpfsSettingsPatch(patch), re, JSON.stringify(patch));
  assert.deepEqual(validateIpfsSettingsPatch({ externalApiUrl: '' }), { externalApiUrl: '' }, 'empty means the default address');
  assert.deepEqual(validateIpfsSettingsPatch({}), {});
});
