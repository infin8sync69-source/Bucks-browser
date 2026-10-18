import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveBucksPath, contentTypeFor, cacheControlFor, handleBucksRequest } from '../../../src/main/protocols/bucks.js';

let dist;
let emptyDist;
before(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-ui-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>chrome</title>');
  fs.mkdirSync(path.join(dist, '_app', 'immutable', 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(dist, '_app', 'immutable', 'chunks', 'a.js'), 'export {}');
  fs.mkdirSync(path.join(dist, 'settings'));
  fs.writeFileSync(path.join(dist, 'settings', 'index.html'), '<p>settings</p>');
  fs.mkdirSync(path.join(dist, 'nodir'));
  fs.writeFileSync(path.join(dist, 'favicon.png'), Buffer.from([0x89, 0x50]));
  fs.writeFileSync(path.join(dist, 'spa ce.txt'), 'hi');
  emptyDist = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-empty-'));
});
after(() => {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.rmSync(emptyDist, { recursive: true, force: true });
});

test('serves existing files', () => {
  assert.deepEqual(resolveBucksPath(dist, '/_app/immutable/chunks/a.js'), { file: path.join(dist, '_app/immutable/chunks/a.js'), status: 200 });
  assert.deepEqual(resolveBucksPath(dist, '/favicon.png'), { file: path.join(dist, 'favicon.png'), status: 200 });
  assert.deepEqual(resolveBucksPath(dist, '/spa%20ce.txt'), { file: path.join(dist, 'spa ce.txt'), status: 200 });
});

test('directory → its index.html; root → index.html', () => {
  assert.deepEqual(resolveBucksPath(dist, '/settings'), { file: path.join(dist, 'settings/index.html'), status: 200 });
  assert.deepEqual(resolveBucksPath(dist, '/settings/'), { file: path.join(dist, 'settings/index.html'), status: 200 });
  assert.deepEqual(resolveBucksPath(dist, '/'), { file: path.join(dist, 'index.html'), status: 200 });
  assert.deepEqual(resolveBucksPath(dist, ''), { file: path.join(dist, 'index.html'), status: 200 });
});

test('SPA fallback: unknown routes and directories without index → root index.html with 200', () => {
  assert.deepEqual(resolveBucksPath(dist, '/wallet/send'), { file: path.join(dist, 'index.html'), status: 200 });
  assert.deepEqual(resolveBucksPath(dist, '/nodir'), { file: path.join(dist, 'index.html'), status: 200 });
  assert.deepEqual(resolveBucksPath(dist, '/%E0%A4%A'), { file: path.join(dist, 'index.html'), status: 200 }, 'malformed escapes fall back');
});

test('path traversal is rejected', () => {
  assert.equal(resolveBucksPath(dist, '/../../etc/passwd').status, 403);
  assert.equal(resolveBucksPath(dist, '/..%2F..%2Fetc/passwd').status, 403);
  assert.equal(resolveBucksPath(dist, '/_app/../../x').status, 403);
  assert.equal(resolveBucksPath(dist, '/a%00.html').status, 403);
  assert.equal(resolveBucksPath(dist, '/../' + path.basename(dist) + '/index.html').file, path.join(dist, 'index.html'), 'a path that normalises back inside is fine');
});

test('missing index.html → 503', () => {
  assert.deepEqual(resolveBucksPath(emptyDist, '/'), { file: null, status: 503 });
  assert.deepEqual(resolveBucksPath(emptyDist, '/anything'), { file: null, status: 503 });
});

test('content types and cache headers', () => {
  assert.equal(contentTypeFor('x.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('x.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('x.woff2'), 'font/woff2');
  assert.equal(contentTypeFor('x.wasm'), 'application/wasm');
  assert.equal(contentTypeFor('x.unknown'), 'application/octet-stream');
  assert.equal(cacheControlFor('/_app/immutable/chunks/a.js', '/dist/_app/immutable/chunks/a.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('/settings', '/dist/index.html'), 'no-cache');
  assert.equal(cacheControlFor('/favicon.png', '/dist/favicon.png'), null);
});

test('handleBucksRequest: only host "app", correct headers, 404 otherwise', async () => {
  const ok = await handleBucksRequest(dist, 'bucks://app/settings');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(ok.headers.get('cache-control'), 'no-cache');
  assert.equal(await ok.text(), '<p>settings</p>');

  const asset = await handleBucksRequest(dist, 'bucks://app/_app/immutable/chunks/a.js?v=1');
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(asset.headers.get('content-length'), '9');

  assert.equal((await handleBucksRequest(dist, 'bucks://other/')).status, 404);
  assert.equal((await handleBucksRequest(dist, 'bucks://app/../../etc/passwd')).status, 200, 'URL parser already normalises; served index');
  assert.equal((await handleBucksRequest(emptyDist, 'bucks://app/')).status, 503);
  assert.equal((await handleBucksRequest(dist, '::not a url')).status, 400);
});
