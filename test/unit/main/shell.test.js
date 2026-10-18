import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/electron-loader.mjs', import.meta.url);
const { assertExternalUrl, isAllowedExternalUrl, registerShellIpc } = await import('../../../src/main/shell.js');
const { ipcMain } = await import('./helpers/electron-stub.mjs');

test('allows http, https and mailto', () => {
  assert.equal(isAllowedExternalUrl('https://example.com/a?b=c'), true);
  assert.equal(isAllowedExternalUrl('http://example.com'), true);
  assert.equal(isAllowedExternalUrl('mailto:someone@example.com'), true);
  assert.equal(assertExternalUrl('  https://example.com  '), 'https://example.com/');
});

test('rejects everything else with a readable error', () => {
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'bucks://app/', 'ipfs://bafy', 'ftp://x', 'not a url', '', null, 42]) {
    assert.equal(isAllowedExternalUrl(bad), false, String(bad));
    assert.throws(() => assertExternalUrl(bad), Error);
  }
  assert.throws(() => assertExternalUrl('x'.repeat(9000)), /too long/);
  assert.throws(() => assertExternalUrl('file:///x'), /only http, https and mailto/);
});

test('registerShellIpc registers the contract channel and validates payloads', async () => {
  registerShellIpc();
  const handler = ipcMain._handlers.get('bucks:shell:open-external');
  assert.equal(typeof handler, 'function');
  await assert.rejects(handler({}, { url: 'javascript:1' }), /Refusing/);
  await assert.rejects(handler({}, {}), /required/);
  await handler({}, { url: 'https://example.com' });
});
