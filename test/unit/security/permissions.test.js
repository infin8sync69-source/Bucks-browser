import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../main/helpers/electron-loader.mjs', import.meta.url);
const { decidePermission, installPermissions, allowPermission, revokePermission, clearPermissions, listPermissions, originOf } =
  await import('../../../src/main/security/permissions.js');

beforeEach(() => clearPermissions());

const ask = (permission, extra = {}) => decidePermission({ permission, origin: 'https://example.com/page', kind: 'request', ...extra });

test('allowed by default: fullscreen, pointerLock, sanitized clipboard write, background sync', () => {
  for (const p of ['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'background-sync']) assert.equal(ask(p), true, p);
});

test('denied by default: hardware, location, notifications, clipboard read, capture, unknown', () => {
  for (const p of ['geolocation', 'notifications', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'bluetooth', 'clipboard-read',
    'idle-detection', 'openExternal', 'speaker-selection', 'storage-access', 'top-level-storage-access', 'display-capture',
    'keyboardLock', 'window-management', 'fileSystem', 'something-new', 'unknown']) {
    assert.equal(ask(p), false, p);
  }
});

test('media: capture requests are denied, playback-only checks allowed', () => {
  assert.equal(ask('media', { mediaTypes: ['video', 'audio'] }), false);
  assert.equal(ask('media', { mediaTypes: ['audio'] }), false);
  assert.equal(ask('media', { mediaTypes: [] }), true);
  assert.equal(ask('media'), true);
  assert.equal(decidePermission({ permission: 'media', origin: 'https://e.com', kind: 'check', mediaType: 'video' }), false);
  assert.equal(decidePermission({ permission: 'media', origin: 'https://e.com', kind: 'check', mediaType: 'audio' }), false);
  assert.equal(decidePermission({ permission: 'media', origin: 'https://e.com', kind: 'check', mediaType: 'unknown' }), true);
});

test('the chrome is trusted only when flagged', () => {
  assert.equal(decidePermission({ permission: 'media', origin: 'bucks://app/', kind: 'request', mediaTypes: ['audio'], trustedChrome: true }), true);
  assert.equal(decidePermission({ permission: 'media', origin: 'bucks://app/', kind: 'request', mediaTypes: ['audio'] }), false);
});

test('per-origin grants', () => {
  allowPermission('https://example.com/some/page', 'geolocation');
  assert.equal(ask('geolocation'), true);
  assert.equal(decidePermission({ permission: 'geolocation', origin: 'https://other.com', kind: 'request' }), false);
  assert.equal(decidePermission({ permission: 'notifications', origin: 'https://example.com', kind: 'request' }), false);
  assert.deepEqual(listPermissions(), [{ origin: 'https://example.com', permissions: ['geolocation'] }]);
  revokePermission('https://example.com', 'geolocation');
  assert.equal(ask('geolocation'), false);
  assert.deepEqual(listPermissions(), []);
  assert.throws(() => allowPermission('', 'geolocation'));
});

test('originOf supports custom standard schemes', () => {
  assert.equal(originOf('ipfs://bafyabc/x/y'), 'ipfs://bafyabc');
  assert.equal(originOf('https://a.com:8443/x'), 'https://a.com:8443');
  assert.equal(originOf('garbage'), '');
});

function fakeSession() {
  const s = {};
  s.setPermissionRequestHandler = (fn) => { s.request = fn; };
  s.setPermissionCheckHandler = (fn) => { s.check = fn; };
  s.setDevicePermissionHandler = (fn) => { s.device = fn; };
  s.setBluetoothPairingHandler = (fn) => { s.pairing = fn; };
  s.setDisplayMediaRequestHandler = (fn) => { s.display = fn; };
  return s;
}

test('installPermissions wires every handler on a web session', () => {
  const s = fakeSession();
  installPermissions(s, { isDefaultSession: false });
  const results = [];
  s.request({ getURL: () => 'https://example.com/' }, 'geolocation', (v) => results.push(v), { requestingUrl: 'https://example.com/' });
  s.request(null, 'fullscreen', (v) => results.push(v), { requestingUrl: 'https://example.com/' });
  s.request(null, 'media', (v) => results.push(v), { requestingUrl: 'https://example.com/', mediaTypes: ['video'] });
  assert.deepEqual(results, [false, true, false]);
  assert.equal(s.check(null, 'notifications', 'https://example.com', {}), false);
  assert.equal(s.check(null, 'fullscreen', 'https://example.com', {}), true);
  assert.equal(s.device({}), false);
  let pairing; s.pairing({}, (r) => { pairing = r; });
  assert.deepEqual(pairing, { confirmed: false });
  let display = 'unset'; s.display({}, (r) => { display = r; });
  assert.equal(display, null);
  // a web page cannot claim to be the chrome
  assert.equal(s.check(null, 'geolocation', 'bucks://app', {}), false);
});

test('the default session trusts bucks://app only', () => {
  const s = fakeSession();
  installPermissions(s, { isDefaultSession: true });
  assert.equal(s.check(null, 'media', 'bucks://app', { mediaType: 'audio' }), true);
  assert.equal(s.check(null, 'geolocation', 'https://example.com', {}), false);
  assert.equal(s.display, undefined, 'display media handler left alone on the chrome session');
  let allowed; s.request(null, 'clipboard-read', (v) => { allowed = v; }, { requestingUrl: 'bucks://app/wallet' });
  assert.equal(allowed, true);
});
