// App manifests and the container's rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppManifest, normalizeNetworkOrigin, describePermission, permissionDiff } from '../../../src/main/apps/manifest.js';
import { allowRequest, allowPermission, navigationTarget, partitionOf } from '../../../src/main/apps/policy.js';
import { parseAppAddress } from '../../../src/main/apps/service.js';
import { sanitizeApp } from '../../../src/main/apps/store.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const NAME = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';

test('manifest: a site without an app section installs with no permissions', () => {
  const m = parseAppManifest(null, { fallbackName: 'my-folder' });
  assert.equal(m.name, 'my-folder');
  assert.deepEqual(m.permissions, []);
  assert.deepEqual(m.tools, []);
  assert.deepEqual(m.window, { width: 1100, height: 760 });
  assert.equal(parseAppManifest('{"name":"Site name"}').name, 'Site name');
});

test('manifest: permissions are normalised, unknown and duplicate ones dropped with a warning', () => {
  const m = parseAppManifest(JSON.stringify({
    app: {
      name: 'Notes', version: '1.2.0', description: 'Take notes', icon: '/icons/app.svg',
      permissions: ['network:https://API.example.com/', 'network:https://api.example.com', 'notifications', 'fullscreen', 'teleport', 'network:http://evil.com', 'network:https://x.com/path', 'agent-tools'],
      agent: { tools: [{ name: 'search_notes', description: 'Search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }, { name: 'Bad Name' }] },
      window: { width: 99999, height: 'x' },
    },
  }));
  assert.equal(m.name, 'Notes');
  assert.equal(m.version, '1.2.0');
  assert.equal(m.icon, 'icons/app.svg');
  assert.deepEqual(m.permissions, ['network:https://api.example.com', 'notifications', 'agent-tools'], 'agent-tools comes from declaring tools, not from the list');
  assert.deepEqual(m.tools.map((t) => t.name), ['search_notes']);
  assert.deepEqual(m.window, { width: 3840, height: 760 });
  assert.ok(m.warnings.some((w) => /teleport/.test(w)));
  assert.ok(m.warnings.some((w) => /http:\/\/evil\.com/.test(w)));
  assert.ok(m.warnings.some((w) => /x\.com\/path/.test(w)));
  assert.ok(m.warnings.some((w) => /valid name/.test(w)));
});

test('manifest: a broken bucks-site.json gives no permissions and says so', () => {
  const m = parseAppManifest('{ nope', { fallbackName: 'x' });
  assert.deepEqual(m.permissions, []);
  assert.match(m.warnings[0], /could not be read/);
});

test('network origins: https and wss only, http for localhost, wildcards for real domains', () => {
  assert.equal(normalizeNetworkOrigin('https://api.example.com'), 'https://api.example.com');
  assert.equal(normalizeNetworkOrigin('wss://chat.example.com:8443'), 'wss://chat.example.com:8443');
  assert.equal(normalizeNetworkOrigin('https://*.example.com'), 'https://*.example.com');
  assert.equal(normalizeNetworkOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeNetworkOrigin('http://example.com'), null);
  assert.equal(normalizeNetworkOrigin('https://*.com'), null);
  assert.equal(normalizeNetworkOrigin('https://example.com/api'), null);
  assert.equal(normalizeNetworkOrigin('ftp://example.com'), null);
  assert.equal(normalizeNetworkOrigin('https://exa mple.com'), null);
});

test('permission descriptions: what people read before granting', () => {
  assert.match(describePermission('network:https://api.example.com').label, /Connect to api\.example\.com/);
  assert.equal(describePermission('network:https://api.example.com').risk, 'medium');
  assert.equal(describePermission('network:http://localhost:3000').risk, 'high');
  assert.match(describePermission('agent-tools', { tools: [{ name: 'search_notes' }] }).description, /search_notes/);
  assert.equal(describePermission('camera').risk, 'high');
  assert.equal(describePermission('teleport'), null);
  assert.deepEqual(permissionDiff(['a', 'b'], ['b', 'c']), { added: ['c'], removed: ['a'] });
});

test('requests: own origin, granted network origins, never the node, never another app', () => {
  const ctx = { appId: 'a_0123456789', granted: ['network:https://api.example.com', 'network:https://*.cdn.net'], nodeOrigins: ['http://127.0.0.1:5001', 'http://127.0.0.1:8080'] };
  assert.equal(allowRequest('bucks-app://a_0123456789/assets/app.js', ctx), true);
  assert.equal(allowRequest('bucks-app://a_9999999999/secret.json', ctx), false);
  assert.equal(allowRequest('https://api.example.com/v1/x?y=1', ctx), true);
  assert.equal(allowRequest('wss://api.example.com/socket', ctx), true, 'https covers wss on the same host');
  assert.equal(allowRequest('https://api.example.com:8443/', ctx), false, 'another port');
  assert.equal(allowRequest('https://evil.example.com/', ctx), false);
  assert.equal(allowRequest('https://img.cdn.net/a.png', ctx), true);
  assert.equal(allowRequest('https://cdn.net/a.png', ctx), false, 'a wildcard is for subdomains');
  assert.equal(allowRequest('http://api.example.com/', ctx), false);
  assert.equal(allowRequest('data:image/png;base64,AAAA', ctx), true);
  assert.equal(allowRequest('ipfs://' + CID, ctx), false, 'ipfs:// needs the ipfs permission');
  assert.equal(allowRequest('ipfs://' + CID, { ...ctx, granted: ['ipfs'] }), true);
  assert.equal(allowRequest('file:///etc/passwd', ctx), false);
  const dev = { ...ctx, granted: ['network:http://127.0.0.1:5001'] };
  assert.equal(allowRequest('http://127.0.0.1:5001/api/v0/key/list', dev), false, 'the node API, whatever was granted');
  assert.equal(allowRequest('http://127.0.0.1:5001/api/v0/key/list', { ...dev, nodeOrigins: [] }), true);
});

test('chromium permissions: only what was granted', () => {
  const g = ['notifications', 'camera'];
  assert.equal(allowPermission({ permission: 'notifications', granted: g }), true);
  assert.equal(allowPermission({ permission: 'geolocation', granted: g }), false);
  assert.equal(allowPermission({ permission: 'media', granted: g, mediaTypes: ['video'] }), true);
  assert.equal(allowPermission({ permission: 'media', granted: g, mediaTypes: ['video', 'audio'] }), false, 'microphone not granted');
  assert.equal(allowPermission({ permission: 'media', granted: [], mediaTypes: [] }), true, 'playback');
  assert.equal(allowPermission({ permission: 'media', granted: g, kind: 'check', mediaType: 'audio' }), false);
  assert.equal(allowPermission({ permission: 'fullscreen', granted: [] }), true);
  assert.equal(allowPermission({ permission: 'clipboard-read', granted: [] }), false);
  assert.equal(allowPermission({ permission: 'hid', granted: g }), false);
});

test('navigation: stay in the app, web and IPFS links go to a Bucks tab', () => {
  assert.equal(navigationTarget('bucks-app://a_0123456789/settings', 'a_0123456789'), 'stay');
  assert.equal(navigationTarget('bucks-app://a_9999999999/', 'a_0123456789'), 'block');
  assert.equal(navigationTarget('https://example.com/', 'a_0123456789'), 'browser');
  assert.equal(navigationTarget(`ipns://${NAME}/`, 'a_0123456789'), 'browser');
  assert.equal(navigationTarget('file:///tmp/x', 'a_0123456789'), 'block');
  assert.equal(navigationTarget('javascript:alert(1)', 'a_0123456789'), 'block');
  assert.equal(partitionOf('a_0123456789'), 'persist:bucks-app-a_0123456789');
});

test('addresses: ipfs://, ipns://, paths and bare forms', () => {
  assert.deepEqual(parseAppAddress(`ipfs://${CID}/`), { kind: 'ipfs', ref: CID });
  assert.deepEqual(parseAppAddress(`/ipfs/${CID}`), { kind: 'ipfs', ref: CID });
  assert.deepEqual(parseAppAddress(CID), { kind: 'ipfs', ref: CID });
  assert.deepEqual(parseAppAddress(`ipns://${NAME}`), { kind: 'ipns', ref: NAME });
  assert.deepEqual(parseAppAddress(NAME), { kind: 'ipns', ref: NAME });
  assert.deepEqual(parseAppAddress('ipns://docs.ipfs.tech'), { kind: 'ipns', ref: 'docs.ipfs.tech' });
  assert.throws(() => parseAppAddress('https://example.com'), /ipfs:\/\/ or ipns:\/\//);
  assert.throws(() => parseAppAddress(`ipfs://${CID}/sub/path`), /ipfs:\/\//);
});

test('store records: grants never exceed what the current version asks for', () => {
  const rec = sanitizeApp({
    id: 'a_0123456789', name: 'Notes', source: { kind: 'ipns', ref: NAME },
    current: { cid: CID, version: '1', permissions: ['notifications', 'network:https://api.example.com', 'bogus'], tools: [] },
    granted: ['notifications', 'camera', 'bogus'],
  });
  assert.deepEqual(rec.current.permissions, ['notifications', 'network:https://api.example.com']);
  assert.deepEqual(rec.granted, ['notifications']);
  assert.equal(sanitizeApp({ id: '../x', source: { kind: 'ipfs', ref: CID }, current: { cid: CID } }), null);
  assert.equal(sanitizeApp({ id: 'a_0123456789', source: { kind: 'web', ref: 'x' }, current: { cid: CID } }), null);
});
