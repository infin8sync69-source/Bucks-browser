import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { walkFolder, inspectFolder, detectProject, isSecretName } from '../../../src/main/sites/folder.js';

async function tree(t, files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-site-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
  return dir;
}

test('isSecretName covers the P3 list', () => {
  for (const n of ['.env', '.env.local', 'server.pem', 'tls.key', 'id_rsa', 'id_ed25519.pub', '.npmrc', '.git', 'credentials.json', 'cert.p12']) assert.equal(isSecretName(n), true, n);
  for (const n of ['index.html', 'environment.js', 'keyboard.js', 'monkey.png', 'id.txt']) assert.equal(isSecretName(n), false, n);
});

test('walkFolder: lstat walk, links never followed, hidden and secret entries left out', async (t) => {
  const outside = await tree(t, { 'secret.txt': 'outside the site' });
  const dir = await tree(t, {
    'index.html': '<h1>hi</h1>', 'assets/app.js': 'x', '.well-known/security.txt': 'contact', '_redirects': '/* /index.html 200',
    '.DS_Store': 'junk', '.env': 'KEY=1', '.git/config': '[core]', '.claude/settings.json': '{}', 'keys/server.pem': 'pem', 'node/id_rsa': 'k',
  });
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'escape.txt'));
  fs.symlinkSync(outside, path.join(dir, 'linked-dir'));
  const w = await walkFolder(dir);
  assert.deepEqual(w.files.map((f) => f.path).sort(), ['.well-known/security.txt', '_redirects', 'assets/app.js', 'index.html']);
  assert.equal(w.files.find((f) => f.path === 'index.html').size, 11);
  const reasons = Object.fromEntries(w.excluded.map((e) => [e.path, e.reason]));
  assert.deepEqual(reasons, {
    '.DS_Store': 'hidden', '.env': 'secret', '.git/': 'secret', '.claude/': 'hidden', 'keys/server.pem': 'secret', 'node/id_rsa': 'secret',
    'escape.txt': 'symlink', 'linked-dir': 'symlink',
  });
  assert.equal(w.truncated, false);
  assert.ok(w.files.every((f) => f.abs.startsWith(w.root)));
  await assert.rejects(walkFolder(path.join(dir, 'index.html')), /not a folder/);
});

test('walkFolder stops past maxFiles and says so', async (t) => {
  const dir = await tree(t, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, 'x'])));
  const w = await walkFolder(dir, { maxFiles: 5 });
  assert.equal(w.truncated, true);
  assert.ok(w.files.length <= 6);
});

test('inspectFolder: the TanStack SPA shell case with both one-click fixes, applied to the published copy only', async (t) => {
  const dir = await tree(t, {
    '_shell.html': '<!doctype html><div id=app></div><script type="module" src="/assets/index.js"></script>',
    'assets/index.js': 'fetch("/_serverFn/createAvatarEmbed")',
  });
  const before = await inspectFolder(dir);
  assert.equal(before.blocked, true);
  assert.equal(before.checks.find((c) => c.id === 'P1').fix.action, 'use-shell-as-index');

  const fixed = await inspectFolder(dir, { useShellAsIndex: true, enableSpa: true });
  assert.equal(fixed.blocked, false);
  assert.deepEqual(fixed.files.map((f) => f.path).sort(), ['_shell.html', 'assets/index.js', 'bucks-site.json', 'index.html']);
  const index = fixed.files.find((f) => f.path === 'index.html');
  assert.equal(index.abs, path.join(fixed.root, '_shell.html'), 'index.html is served from the shell file, not a copy on disk');
  assert.deepEqual(JSON.parse(fixed.files.find((f) => f.path === 'bucks-site.json').content), { spa: true });
  assert.equal(fixed.descriptor.spa, true);
  assert.deepEqual(fixed.checks.map((c) => c.id).sort(), ['P6', 'P9']);
  assert.deepEqual(fixed.options, { exclude: [], useShellAsIndex: true, enableSpa: true });
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['_shell.html', 'assets'], 'the folder itself is untouched');
});

test('inspectFolder: enableSpa keeps an existing manifest, user exclusions resolve P4', async (t) => {
  const dir = await tree(t, {
    'index.html': '<!doctype html><script type="module" src="main.js"></script>',
    'main.js': 'console.log(1)',
    'bucks-site.json': '{"name":"Demo","notFound":"404.html"}',
    'debug/config.js': 'const api_key = "q1w2e3r4t5y6u7i8o9p0";',
  });
  const first = await inspectFolder(dir);
  assert.equal(first.blocked, true);
  assert.deepEqual(first.checks.find((c) => c.id === 'P4').files.map((f) => f.path), ['debug/config.js']);
  const next = await inspectFolder(dir, { exclude: ['debug/', '../escape', '/abs'], enableSpa: true });
  assert.equal(next.blocked, false);
  assert.deepEqual(next.options.exclude, ['debug/']);
  assert.ok(next.excluded.some((e) => e.path === 'debug/config.js' && e.reason === 'user'));
  assert.deepEqual(JSON.parse(next.files.find((f) => f.path === 'bucks-site.json').content), { name: 'Demo', notFound: '404.html', spa: true });
  assert.equal(next.count, 3);
  assert.equal(next.bytes, next.files.reduce((n, f) => n + f.size, 0));
});

test('detectProject: suggests the build output, recognises the framework and server builds', async (t) => {
  const project = await tree(t, {
    'package.json': JSON.stringify({ dependencies: { '@tanstack/react-start': '1.168.0', react: '19' }, devDependencies: { vite: '7' } }),
    'dist/client/_shell.html': '<!doctype html>',
    '.output/server/index.mjs': 'export {}',
  });
  const p = await detectProject(project);
  assert.equal(p.framework, 'tanstack-start');
  assert.equal(p.suggestedDir, 'dist/client');
  assert.equal(p.siteDir, path.join(project, 'dist', 'client'));
  assert.equal(p.isStatic, true);
  assert.match(p.note, /also has a server build/);

  const site = await tree(t, { 'index.html': 'x' });
  assert.deepEqual(await detectProject(site), { siteDir: site, suggestedDir: '', framework: null, isStatic: true, note: null });

  const serverOnly = await tree(t, { 'package.json': '{"dependencies":{"next":"15"}}', '.next/server/app.js': '' });
  const s = await detectProject(serverOnly);
  assert.equal(s.suggestedDir, null);
  assert.equal(s.isStatic, false);
  assert.match(s.note, /IPFS cannot run a server/);
  assert.match((await detectProject(await tree(t, { 'src/main.js': '' }))).note, /No built site found/);
});
