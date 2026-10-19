import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/electron-loader.mjs', import.meta.url);
const { urlsFromArgv, clearOptions, clearSessions, SITE_DATA_STORAGES } = await import('../../../src/main/browsing.js');

test('urlsFromArgv keeps openable URLs only', () => {
  const argv = ['/opt/bucks/bucks-browser', '.', '--no-sandbox', '--user-data-dir=/tmp/x', 'https://example.com/a?b=1',
    'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', 'IPNS://docs.ipfs.tech', 'file:///home/u/a.html',
    'javascript:alert(1)', 'mailto:x@y', 'https://example.com/a?b=1', 'x'.repeat(9000), 42];
  assert.deepEqual(urlsFromArgv(argv), [
    'https://example.com/a?b=1',
    'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    'IPNS://docs.ipfs.tech',
    'file:///home/u/a.html',
  ]);
  assert.deepEqual(urlsFromArgv(undefined), []);
});

test('clearOptions defaults everything to off', () => {
  assert.deepEqual(clearOptions(undefined), { cookies: false, cache: false, siteData: false });
  assert.deepEqual(clearOptions({ cookies: true, cache: 'yes', siteData: true }), { cookies: true, cache: false, siteData: true });
});

test('clearSessions clears the chosen storages on every session', async () => {
  const calls = [];
  const ses = (name) => ({
    clearStorageData: async (o) => calls.push([name, 'storage', o.storages]),
    clearCache: async () => calls.push([name, 'cache']),
    clearHostResolverCache: async () => calls.push([name, 'dns']),
  });
  const r = await clearSessions([ses('web'), null, ses('private')], { cookies: true, cache: true, siteData: false });
  assert.deepEqual(r.cleared, ['cookies', 'cache']);
  assert.deepEqual(calls, [
    ['web', 'storage', ['cookies']], ['web', 'cache'], ['web', 'dns'],
    ['private', 'storage', ['cookies']], ['private', 'cache'], ['private', 'dns'],
  ]);
  calls.length = 0;
  await clearSessions([ses('web')], { cookies: false, cache: false, siteData: true });
  assert.deepEqual(calls, [['web', 'storage', SITE_DATA_STORAGES]]);
  calls.length = 0;
  await clearSessions([ses('web')], { cookies: false, cache: false, siteData: false });
  assert.deepEqual(calls, [], 'nothing selected, nothing touched');
});
