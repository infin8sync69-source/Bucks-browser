import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight, isBlocked, findSecrets, externalHosts } from '../../../src/main/sites/preflight.js';
import { buildDescriptor } from '../../../src/main/sites/package.js';

const MiB = 1024 * 1024;
const base = { quotaBytes: 500 * MiB, maxFiles: 50_000 };
const run = (files, contents = {}, { descriptor = {}, ...extra } = {}) => runPreflight({
  files: files.map((f) => (typeof f === 'string' ? { path: f, size: 100 } : f)),
  contents: new Map(Object.entries(contents)),
  descriptor: buildDescriptor(descriptor),
  ...base,
  ...extra,
});
const ids = (checks) => checks.map((c) => c.id);

test('a clean static site has no checks', () => {
  const checks = run(['index.html', 'about.html', 'style.css'], { 'index.html': '<!doctype html><link rel=stylesheet href="style.css"><a href="about.html">about</a>' });
  assert.deepEqual(checks, []);
  assert.equal(isBlocked(checks), false);
});

test('P1: no entry blocks; _shell.html offers the one-click fix', () => {
  const none = run(['readme.txt']);
  assert.deepEqual(ids(none), ['P1']);
  assert.match(none[0].message, /no index\.html/);
  assert.equal(isBlocked(none), true);
  const shell = run(['_shell.html', 'assets/a.js']);
  assert.equal(shell[0].fix.action, 'use-shell-as-index');
  const custom = run(['app.html'], {}, { descriptor: { manifestText: '{"entry":"app.html"}' } });
  assert.ok(!ids(custom).includes('P1'));
});

test('P2 and P3 are blocks the default action already resolved', () => {
  const checks = run(['index.html'], {}, { excluded: [{ path: 'link', reason: 'symlink' }, { path: '.env', reason: 'secret' }, { path: 'id_rsa', reason: 'secret' }, { path: '.DS_Store', reason: 'hidden' }] });
  assert.deepEqual(ids(checks), ['P2', 'P3']);
  assert.ok(checks.every((c) => c.level === 'block' && c.resolved));
  assert.equal(checks[1].message, 'Found files that look like private keys or passwords: .env, id_rsa. They will not be published.');
  assert.equal(isBlocked(checks), false);
});

test('P4: secret-looking text is reported by file, line and kind, never the value', () => {
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
  const checks = run(['index.html', 'assets/app.js', 'config.json'], {
    'index.html': '<!doctype html>',
    'assets/app.js': `const a = 1;\nconst key = "${secret}";\n`,
    'config.json': '{ "db": "postgres://admin:hunter2@db.example.com/prod", "api_key": "a1b2c3d4e5f6g7h8i9j0" }',
  });
  const p4 = checks.find((c) => c.id === 'P4');
  assert.equal(p4.level, 'block');
  assert.equal(p4.fix.action, 'exclude');
  assert.deepEqual(p4.files.map((f) => [f.path, f.line]), [['assets/app.js', 2], ['config.json', 1], ['config.json', 1]]);
  assert.ok(!JSON.stringify(checks).includes(secret), 'the value never appears');
  assert.ok(!JSON.stringify(checks).includes('hunter2'));
  assert.equal(isBlocked(checks), true);
});

test('findSecrets: the documented patterns, and no false positives on prose or identifiers', () => {
  const kinds = (t) => findSecrets(t).map((f) => f.kind);
  assert.deepEqual(kinds('-----BEGIN OPENSSH PRIVATE KEY-----'), ['private key']);
  assert.deepEqual(kinds('-----BEGIN PRIVATE KEY-----'), ['private key']);
  assert.deepEqual(kinds(`k="AIza${'A1b2'.repeat(8)}xyz"`), ['Google API key']);
  assert.deepEqual(kinds(`t=ghp_${'a1'.repeat(18)}`), ['GitHub token']);
  assert.deepEqual(kinds('AKIAABCDEFGHIJKLMNOP'), ['AWS access key']);
  assert.deepEqual(kinds('mongodb+srv://u:p@cluster0.example.net'), ['database URL with a password']);
  assert.deepEqual(kinds('secret: "Zx81Qw92Er73Ty64Ui55"'), ['long value assigned to a secret name']);
  assert.deepEqual(kinds('password: "Enter your password here please"'), []);
  assert.deepEqual(kinds('token: "ABCDEFGHIJKLMNOPQRSTUV"'), [], 'no digits: an identifier, not a secret');
  assert.deepEqual(kinds('const task-management = desk-organizer;'), []);
  assert.deepEqual(kinds('postgres://localhost/db'), []);
  assert.equal(findSecrets(Array(20).fill('AKIAABCDEFGHIJKLMNOP').join('\n')).length, 5, 'capped per file');
});

test('P5: quota and file count', () => {
  assert.ok(ids(run([{ path: 'index.html', size: 600 * MiB }])).includes('P5'));
  const many = run(['index.html', 'a', 'b'], {}, { maxFiles: 2 });
  assert.match(many.find((c) => c.id === 'P5').message, /more than 2 files/);
  assert.ok(ids(run(['index.html'], {}, { truncated: true })).includes('P5'));
});

test('P6 server calls (the Legrand avatar case), P8 service worker', () => {
  const checks = run(['index.html', 'assets/index.js'], {
    'index.html': '<!doctype html><script type="module" src="/assets/index.js"></script>',
    'assets/index.js': 'fetch("/_serverFn/createAvatarEmbed");navigator.serviceWorker.register("/sw.js")',
  }, { descriptor: { manifestText: '{"spa":true}' } });
  const p6 = checks.find((c) => c.id === 'P6');
  assert.equal(p6.level, 'warn');
  assert.match(p6.message, /This app calls a server \(\/_serverFn\/…\)/);
  assert.deepEqual(p6.files, [{ path: 'assets/index.js' }]);
  assert.ok(ids(checks).includes('P8'));
  assert.ok(ids(run(['index.html', 'a.js'], { 'a.js': "fetch('/api/users')" })).includes('P6'));
});

test('P7: history-router SPA without fallback offers single-page-app mode', () => {
  const html = { 'index.html': '<!doctype html><div id=app></div><script type="module" src="./main.js"></script>' };
  const checks = run(['index.html', 'main.js'], html);
  assert.equal(checks.find((c) => c.id === 'P7').fix.action, 'enable-spa');
  assert.ok(!ids(run(['index.html', 'main.js'], html, { descriptor: { manifestText: '{"spa":true}' } })).includes('P7'));
  assert.ok(!ids(run(['index.html', 'main.js'], html, { descriptor: { redirectsText: '/* /index.html 200' } })).includes('P7'));
  assert.ok(!ids(run(['index.html', 'about.html', 'main.js'], html)).includes('P7'), 'a multi-page site');
});

test('P9 root-absolute URLs, P10 mixed content, P11 external hosts, P12 large media', () => {
  const checks = run(['index.html', 'style.css', { path: 'video.wav', size: 30 * MiB }], {
    'index.html': '<!doctype html><script src="/assets/a.js"></script><img src="http://cdn.example/x.png"><link rel=stylesheet href="https://fonts.googleapis.com/css"><a href="https://not-a-subresource.example/">x</a>',
    'style.css': 'body{background:url("https://images.example/bg.jpg")}',
  });
  assert.ok(ids(checks).includes('P9'));
  assert.ok(ids(checks).includes('P10'));
  assert.deepEqual(checks.find((c) => c.id === 'P11').hosts, ['cdn.example', 'fonts.googleapis.com', 'images.example']);
  assert.equal(checks.find((c) => c.id === 'P11').level, 'info');
  assert.match(checks.find((c) => c.id === 'P12').message, /video\.wav \(30 MiB\)/);
  assert.deepEqual(externalHosts('a.js', 'fetch(`https://api.example/v1`)'), ['api.example']);
});

test('configuration problems surface as a warning', () => {
  const checks = run(['index.html'], {}, { descriptor: { redirectsText: '/x /y 200!' } });
  assert.equal(checks.find((c) => c.id === 'config').level, 'warn');
  assert.match(checks.find((c) => c.id === 'config').message, /^_redirects: .*forced rules/);
});

test('Firebase web API keys (public by design) warn; every other AIza… key still blocks', async () => {
  const { inFirebaseConfig } = await import('../../../src/main/sites/preflight.js');
  const key = `AIza${'Sy0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV'}`;
  const gemini = `AIza${'Zz9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF9eD'}`;
  const minified = `var x=1;const fb={apiKey:"${key}",authDomain:"shop-123.firebaseapp.com",projectId:"shop-123",storageBucket:"shop-123.appspot.com",messagingSenderId:"1234",appId:"1:1234:web:ab12"};initializeApp(fb);`;
  const formatted = ['export const firebaseConfig = {', `  apiKey: "${key}",`, '  authDomain: "shop-123.firebaseapp.com",', '  projectId: "shop-123",', '};'].join('\n');
  assert.deepEqual(findSecrets(minified), [{ line: 1, kind: 'Firebase web API key', public: true }], 'no "assigned to a secret name" finding either');
  assert.deepEqual(findSecrets(formatted), [{ line: 2, kind: 'Firebase web API key', public: true }]);
  assert.deepEqual(findSecrets(`const MAPS_KEY = "${key}";`).map((f) => f.kind), ['Google API key']);
  assert.deepEqual(findSecrets(`const cfg = { apiKey: "${key}", projectId: "x" };`).map((f) => f.kind), ['Google API key', 'long value assigned to a secret name'], 'no authDomain: not a Firebase config');
  const both = `${minified}\n${'/* filler */'.repeat(80)}\nconst GEMINI_KEY = "${gemini}";`;
  assert.deepEqual(findSecrets(both).map((f) => [f.line, f.kind]), [[1, 'Firebase web API key'], [3, 'Google API key']], 'a key outside the config is not excused');
  const inside = `const fb={apiKey:"${key}",authDomain:"shop.firebaseapp.com",projectId:"shop",geminiKey:"${gemini}"};`;
  assert.deepEqual(findSecrets(inside).map((f) => f.kind), ['Google API key', 'Firebase web API key'], 'only the apiKey property is excused, even inside the config');
  assert.equal(inFirebaseConfig(minified, minified.indexOf(key), key.length), true);
  assert.equal(inFirebaseConfig(inside, inside.indexOf(gemini), gemini.length), false);

  const checks = run(['index.html', 'assets/index.js'], { 'index.html': '<!doctype html><script type="module" src="assets/index.js"></script>', 'assets/index.js': minified }, { descriptor: { manifestText: '{"spa":true}' } });
  assert.equal(isBlocked(checks), false, 'a Firebase app can be published');
  const warning = checks.find((c) => c.id === 'P4-firebase');
  assert.equal(warning.level, 'warn');
  assert.match(warning.message, /^Found a Firebase web API key in assets\/index\.js\. Firebase keys are public by design/);
  assert.match(warning.message, /restrict it to the Firebase APIs/);
  assert.deepEqual(warning.files, [{ path: 'assets/index.js', line: 1, kind: 'Firebase web API key' }]);
  assert.ok(!JSON.stringify(checks).includes(key), 'the key itself is never reported');
  const mixed = run(['index.html', 'app.js'], { 'index.html': '<!doctype html>', 'app.js': both });
  assert.equal(isBlocked(mixed), true);
  assert.deepEqual(mixed.find((c) => c.id === 'P4').files.map((f) => f.line), [3]);
  assert.ok(mixed.some((c) => c.id === 'P4-firebase'));
});
