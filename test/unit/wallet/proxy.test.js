import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { register } from 'node:module';

register('../main/helpers/electron-loader.mjs', import.meta.url);
const { ipcMain } = await import('electron');
const { validatePath, validateNodeUrl, buildTargetUrl, isAllowedOrigin, createWalletProxy } = await import('../../../src/main/wallet/proxy.js');

test('validatePath accepts normal node paths', () => {
  for (const p of ['/', '/api/v1/balance', '/api/v1/tx?from=a&limit=5', '/a%20b', '/x/y.json']) assert.equal(validatePath(p), p);
});

test('validatePath rejects traversal, schemes, protocol-relative, junk', () => {
  for (const p of ['', 'api', 'http://evil.example/', '//evil.example/x', '/a/../b', '/..', '/%2e%2e/x', '/%252e%252e/x', '/a\\b', '/a b',
    '/x\n', '/redirect?u=http://evil', '/%zz', `/${'a'.repeat(3000)}`, null, undefined, 42]) {
    assert.throws(() => validatePath(p), Error, String(p));
  }
});

test('validateNodeUrl', () => {
  assert.equal(validateNodeUrl('http://127.0.0.1:8080').origin, 'http://127.0.0.1:8080');
  assert.equal(validateNodeUrl(' https://node.bucks.example/ ').origin, 'https://node.bucks.example');
  for (const u of ['', 'nope', 'ftp://x', 'file:///x', 'http://user:pw@host/', undefined]) assert.throws(() => validateNodeUrl(u), Error, String(u));
});

test('buildTargetUrl joins and stays on origin', () => {
  assert.equal(buildTargetUrl('http://127.0.0.1:8080', '/api/v1/balance'), 'http://127.0.0.1:8080/api/v1/balance');
  assert.equal(buildTargetUrl('http://127.0.0.1:8080/', '/x?y=1'), 'http://127.0.0.1:8080/x?y=1');
  assert.equal(buildTargetUrl('https://h.example/base/', '/x'), 'https://h.example/base/x');
  assert.throws(() => buildTargetUrl('http://127.0.0.1:8080', '//evil.example'));
  assert.throws(() => buildTargetUrl('http://127.0.0.1:8080', '/a/../../b'));
  assert.throws(() => buildTargetUrl('bad', '/x'));
});

test('isAllowedOrigin', () => {
  assert.equal(isAllowedOrigin('bucks://app/wallet'), true);
  assert.equal(isAllowedOrigin('bucks://app'), true);
  assert.equal(isAllowedOrigin('bucks://application/'), false);
  assert.equal(isAllowedOrigin('bucks://app.evil/'), false);
  assert.equal(isAllowedOrigin('http://localhost:5173/'), true);
  assert.equal(isAllowedOrigin('http://localhost:5173/', { packaged: true }), false);
  assert.equal(isAllowedOrigin('https://example.com/'), false);
  assert.equal(isAllowedOrigin('http://localhost.evil.com/'), false);
  assert.equal(isAllowedOrigin(undefined), false);
});

// ---- end to end against a local node ----------------------------------------------------------
let server; let nodeUrl; const seen = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, ct: req.headers['content-type'] });
      if (req.url === '/api/balance') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"balance":42}'); }
      if (req.url === '/api/text') { res.writeHead(200); return res.end('pong'); }
      if (req.url === '/api/empty') { res.writeHead(204); return res.end(); }
      if (req.url === '/api/redirect') { res.writeHead(302, { location: 'http://evil.example/' }); return res.end(); }
      if (req.url === '/api/slow') return; // never answers
      res.writeHead(500); res.end('x'.repeat(500));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  nodeUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const settings = () => ({ get: () => ({ wallet: { nodeUrl } }) });
const ipc = (event, req) => ipcMain._handlers.get('bucks:wallet:rpc')(event, req);
const chrome = { senderFrame: { url: 'bucks://app/wallet' } };

test('rpc: GET/POST JSON round trip', async () => {
  createWalletProxy({ settings: settings() });
  assert.deepEqual(await ipc(chrome, { method: 'GET', path: '/api/balance' }), { balance: 42 });
  seen.length = 0;
  await ipc(chrome, { method: 'post', path: '/api/balance', body: { tx: 'signed' } });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].body, '{"tx":"signed"}');
  assert.equal(seen[0].ct, 'application/json');
});

test('rpc: non-JSON and empty bodies', async () => {
  const { rpc } = createWalletProxy({ settings: settings() });
  assert.deepEqual(await rpc({ method: 'GET', path: '/api/text' }), { ok: true, text: 'pong' });
  assert.deepEqual(await rpc({ method: 'GET', path: '/api/empty' }), { ok: true, text: '' });
});

test('rpc: errors', async () => {
  const { rpc } = createWalletProxy({ settings: settings() });
  await assert.rejects(rpc({ method: 'GET', path: '/api/missing' }), (e) => /^Node responded 500: x{200}$/.test(e.message));
  await assert.rejects(rpc({ method: 'GET', path: '/api/redirect' }), /^Error: Node responded 302|Node responded 302/);
  await assert.rejects(rpc({ method: 'DELETE', path: '/x' }), /GET or POST/);
  await assert.rejects(rpc({ method: 'GET', path: '/a/../b' }), /\.\./);
  const dead = createWalletProxy({ settings: { get: () => ({ wallet: { nodeUrl: 'http://127.0.0.1:1' } }) } });
  await assert.rejects(dead.rpc({ method: 'GET', path: '/x' }), /^Error: Cannot reach Bucks node at http:\/\/127\.0\.0\.1:1/);
  const bad = createWalletProxy({ settings: { get: () => ({ wallet: { nodeUrl: 'javascript:1' } }) } });
  await assert.rejects(bad.rpc({ method: 'GET', path: '/x' }), /Invalid Bucks node URL|must be http/);
});

test('rpc: a timeout is reported as an unreachable node', async () => {
  const timedOut = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  const { rpc } = createWalletProxy({ settings: settings(), fetchImpl: timedOut });
  await assert.rejects(rpc({ method: 'GET', path: '/api/slow' }), /Cannot reach Bucks node at .*no answer within 15 s/);
});

test('ipc: origin gate', async () => {
  createWalletProxy({ settings: settings() });
  const req = { method: 'GET', path: '/api/balance' };
  await assert.rejects(ipc({ senderFrame: { url: 'https://evil.example/' } }, req), /^Error: Wallet RPC denied for origin$/);
  await assert.rejects(ipc({ senderFrame: null }, req), /Wallet RPC denied for origin/);
  await assert.rejects(ipc({}, req), /Wallet RPC denied for origin/);
  assert.deepEqual(await ipc({ senderFrame: { url: 'bucks://app/' } }, req), { balance: 42 });
  assert.deepEqual(await ipc({ senderFrame: { url: 'http://localhost:5173/' } }, req), { balance: 42 });
});
