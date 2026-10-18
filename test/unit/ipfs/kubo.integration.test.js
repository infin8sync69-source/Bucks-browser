// End-to-end check of the Kubo supervisor against a real Kubo binary. Skipped when no binary
// is available (BUCKS_KUBO_BIN or resources/kubo/linux-x64/ipfs). Uses a throw-away userData
// directory, so it never touches a real profile, and verifies that stop() leaves no daemon,
// timers or child-process handles behind (the test process must exit on its own).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKubo } from '../../../src/main/ipfs/kubo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bundled = path.join(repoRoot, 'resources', 'kubo', 'linux-x64', 'ipfs');
const binary = process.env.BUCKS_KUBO_BIN || (process.platform === 'linux' && process.arch === 'x64' ? bundled : null);
const haveBinary = Boolean(binary && fs.existsSync(binary));

const fakeSettings = {
  get: () => ({ ipfs: { mode: 'embedded', externalApiUrl: '', publicGateway: 'https://ipfs.io', preferredGateway: 'local', autoStart: true } }),
  onChange: () => () => {},
};
const quietLog = { lines: [], info: (...a) => quietLog.lines.push(['info', a.join(' ')]), warn: (...a) => quietLog.lines.push(['warn', a.join(' ')]), error: (...a) => quietLog.lines.push(['error', a.join(' ')]), debug: () => {} };

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function countResources(kind) {
  return process.getActiveResourcesInfo().filter((r) => r === kind).length;
}

test('embedded Kubo: start → add/cat/ls/pin → gateway → stop leaves nothing behind', { skip: haveBinary ? false : 'no Kubo binary (set BUCKS_KUBO_BIN)', timeout: 180_000 }, async (t) => {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-kubo-it-'));
  const prevEnv = process.env.BUCKS_KUBO_BIN;
  process.env.BUCKS_KUBO_BIN = binary;
  t.after(() => { if (prevEnv === undefined) delete process.env.BUCKS_KUBO_BIN; else process.env.BUCKS_KUBO_BIN = prevEnv; });

  const exitListenersBefore = process.listenerCount('exit');
  const childrenBefore = countResources('ChildProcess');
  const timersBefore = countResources('Timeout');

  const kubo = createKubo({ settings: fakeSettings, userData, resourcesDir: path.join(userData, 'no-resources'), getMainWindow: () => null, log: quietLog });
  // Hooks run in order: stop the daemon first, then delete its repo.
  t.after(() => kubo.stop()); // whatever happens, never leave a daemon behind (it would also keep this process alive)
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));
  const statuses = [];
  kubo.onStatus((s) => statuses.push(s));
  assert.equal(kubo.status().state, 'idle');
  assert.equal(kubo.isReady(), false);
  assert.equal(kubo.gatewayUrlFor('ipfs://bafybeiasb5vpmaounyilfuxbd3lryvosl4yefqrfahsb2esg46q6tu6y5q/'), 'https://ipfs.io/ipfs/bafybeiasb5vpmaounyilfuxbd3lryvosl4yefqrfahsb2esg46q6tu6y5q/');

  // start() is idempotent: concurrent callers share the in-flight promise
  const p1 = kubo.start();
  const p2 = kubo.start();
  assert.equal(p1, p2);
  let ready;
  try {
    ready = await Promise.race([p1, new Promise((_, rej) => setTimeout(() => rej(new Error('node did not become ready within 60 s')), 60_000).unref())]);
  } catch (e) {
    await kubo.stop().catch(() => {});
    throw new Error(`${e.message}\nkubo log:\n${quietLog.lines.map((l) => l.join(': ')).join('\n')}`);
  }
  assert.equal(ready.state, 'ready');
  assert.equal(ready.source, 'embedded_kubo');
  assert.equal(ready.embedded, true);
  assert.match(ready.version, /^\d+\.\d+\.\d+/);
  assert.match(ready.peer_id, /^12D3Koo/);
  assert.match(ready.api_url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(ready.gateway_url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(ready.api_url, ready.gateway_url);
  assert.equal(kubo.isReady(), true);
  assert.ok(kubo.rpc, 'rpc client exposed while ready');
  assert.equal((await kubo.start()).state, 'ready'); // already ready → resolves immediately

  // status transitions: idle → initializing (several messages) → ready
  const states = statuses.map((s) => s.state);
  assert.equal(states[0], 'initializing');
  assert.equal(states.at(-1), 'ready');
  assert.ok(states.slice(0, -1).every((s) => s === 'initializing'), `unexpected states ${states.join(' → ')}`);
  const messages = statuses.map((s) => s.message);
  for (const expected of ['Locating IPFS binary…', 'Initializing IPFS repository…', 'Starting IPFS daemon…', 'Waiting for the IPFS API…', 'Embedded IPFS node is ready.']) {
    assert.ok(messages.includes(expected), `missing status message "${expected}" in ${JSON.stringify(messages)}`);
  }

  // runtime.json persisted the reserved ports and the config was patched to match them
  const runtime = JSON.parse(await fsp.readFile(path.join(userData, 'kubo', 'runtime.json'), 'utf8'));
  assert.equal(ready.api_url, `http://127.0.0.1:${runtime.apiPort}`);
  assert.equal(ready.gateway_url, `http://127.0.0.1:${runtime.gatewayPort}`);
  assert.ok(Number.isInteger(runtime.swarmPort) && runtime.swarmPort !== 4001);
  const repoConfig = JSON.parse(await fsp.readFile(path.join(kubo.repoPath(), 'config'), 'utf8'));
  assert.equal(repoConfig.Addresses.API, `/ip4/127.0.0.1/tcp/${runtime.apiPort}`);
  assert.ok(repoConfig.Addresses.Swarm.every((a) => a.includes(`/${runtime.swarmPort}`)), JSON.stringify(repoConfig.Addresses.Swarm));
  assert.ok(fs.existsSync(path.join(userData, 'logs', 'kubo.log')), 'daemon output is logged to <userData>/logs/kubo.log');

  const pid = kubo.pid();
  assert.ok(Number.isInteger(pid) && isAlive(pid), 'daemon pid is alive');

  // RPC round trip
  const rpc = kubo.rpc;
  const text = `hello from bucks ${Date.now()}\n`;
  const added = await rpc.add(new TextEncoder().encode(text), { fileName: 'hello.txt', mimeType: 'text/plain' });
  assert.match(added.cid, /^bafkrei/); // CIDv1, raw leaves
  assert.equal(added.name, 'hello.txt');
  const back = await rpc.cat(added.cid);
  assert.equal(new TextDecoder().decode(back), text);
  await assert.rejects(rpc.cat(added.cid, { maxBytes: 4 }), /byte limit/);
  assert.equal(new TextDecoder().decode(await rpc.cat(added.cid, { offset: 6, length: 4 })), 'from');

  const wrapped = await rpc.add(new TextEncoder().encode(text), { fileName: 'hello.txt', wrapWithDirectory: true });
  assert.match(wrapped.cid, /^bafybei/); // dag-pb directory
  const listing = await rpc.ls(wrapped.cid);
  assert.deepEqual(listing, [{ name: 'hello.txt', cid: added.cid, size: text.length, type: 'file' }]);

  const pins = await rpc.pinLs();
  assert.ok(pins.some((p) => p.cid === added.cid && p.pin_type === 'recursive'), 'added file is pinned');
  assert.ok(pins.some((p) => p.cid === wrapped.cid), 'wrapping directory is pinned');
  assert.equal(await rpc.pinRm(wrapped.cid), wrapped.cid);
  assert.ok(!(await rpc.pinLs()).some((p) => p.cid === wrapped.cid));

  const ident = await rpc.id();
  assert.equal(ident.ID, ready.peer_id);
  const stat = await rpc.repoStat();
  assert.ok(stat.num_objects >= 2 && stat.storage_max > 0);
  assert.equal(Array.isArray(await rpc.swarmPeers()), true);
  assert.equal(await rpc.configGet('Addresses.API'), `/ip4/127.0.0.1/tcp/${runtime.apiPort}`);

  // gateway mapping + the HTTP path the protocol handler proxies
  const gatewayUrl = kubo.gatewayUrlFor(`ipfs://${added.cid}/`);
  assert.equal(gatewayUrl, `${ready.gateway_url}/ipfs/${added.cid}/`);
  const res = await fetch(`${ready.gateway_url}/ipfs/${added.cid}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), text);
  const dirRes = await fetch(`${ready.gateway_url}/ipfs/${wrapped.cid}/hello.txt`, { headers: { range: 'bytes=0-4' } });
  assert.equal(dirRes.status, 206);
  assert.equal(await dirRes.text(), 'hello');

  // stop: graceful shutdown, pid gone, nothing left running
  const stopped = await kubo.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.message, 'IPFS node stopped.');
  assert.equal(kubo.isReady(), false);
  assert.equal(kubo.rpc, null);
  assert.equal(kubo.pid(), null);
  assert.equal(isAlive(pid), false, 'daemon process must be gone after stop()');
  assert.equal(kubo.gatewayUrlFor(`ipfs://${added.cid}/`), `https://ipfs.io/ipfs/${added.cid}/`);
  await assert.rejects(fetch(`${ready.api_url}/api/v0/id`, { method: 'POST' }), 'API port must be closed');
  assert.equal(await kubo.stop().then((s) => s.state), 'stopped'); // idempotent

  assert.equal(countResources('ChildProcess'), childrenBefore, 'no child process handle left behind');
  assert.ok(countResources('Timeout') <= timersBefore + 1, 'no stray kubo timers'); // +1: this test's own timeout
  assert.equal(process.listenerCount('exit'), exitListenersBefore, 'exit listeners cleaned up with the child');
});

test('embedded Kubo: a second start() after stop() reuses the persisted ports and repo', { skip: haveBinary ? false : 'no Kubo binary (set BUCKS_KUBO_BIN)', timeout: 180_000 }, async (t) => {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-kubo-it2-'));
  const prevEnv = process.env.BUCKS_KUBO_BIN;
  process.env.BUCKS_KUBO_BIN = binary;
  t.after(() => { if (prevEnv === undefined) delete process.env.BUCKS_KUBO_BIN; else process.env.BUCKS_KUBO_BIN = prevEnv; });
  const kubo = createKubo({ settings: fakeSettings, userData, resourcesDir: path.join(userData, 'no-resources'), getMainWindow: () => null, log: quietLog });
  t.after(() => kubo.stop());
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));
  const first = await kubo.start();
  const cid = (await kubo.rpc.add(new TextEncoder().encode('persist me'), { fileName: 'p.txt' })).cid;
  await kubo.stop();
  const second = await kubo.restart();
  assert.equal(second.state, 'ready');
  assert.equal(second.api_url, first.api_url);
  assert.equal(second.gateway_url, first.gateway_url);
  assert.equal(second.peer_id, first.peer_id);
  assert.equal(new TextDecoder().decode(await kubo.rpc.cat(cid)), 'persist me');
  const pid = kubo.pid();
  await kubo.stop();
  assert.equal(isAlive(pid), false);
});

test('embedded Kubo: a killed daemon is restarted automatically; an external-mode client attaches without owning the node', { skip: haveBinary ? false : 'no Kubo binary (set BUCKS_KUBO_BIN)', timeout: 180_000 }, async (t) => {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-kubo-it3-'));
  const prevEnv = process.env.BUCKS_KUBO_BIN;
  process.env.BUCKS_KUBO_BIN = binary;
  t.after(() => { if (prevEnv === undefined) delete process.env.BUCKS_KUBO_BIN; else process.env.BUCKS_KUBO_BIN = prevEnv; });
  const kubo = createKubo({ settings: fakeSettings, userData, resourcesDir: path.join(userData, 'no-resources'), getMainWindow: () => null, log: quietLog });
  t.after(() => kubo.stop());
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));

  const first = await kubo.start();
  const oldPid = kubo.pid();
  const seen = [];
  kubo.onStatus((s) => seen.push(s));
  process.kill(oldPid, 'SIGKILL');

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !(seen.some((s) => s.state === 'error') && kubo.isReady())) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const crash = seen.find((s) => s.state === 'error');
  assert.ok(crash, 'a crash is reported as state "error"');
  assert.match(crash.message, /IPFS daemon exited unexpectedly .*restarting in 2s \(attempt 1\/3\)/);
  assert.equal(crash.api_url, null);
  assert.equal(kubo.isReady(), true, 'node is back after the automatic restart');
  assert.notEqual(kubo.pid(), oldPid);
  assert.equal(kubo.status().api_url, first.api_url);
  assert.equal(kubo.status().peer_id, first.peer_id);

  // external mode against the node we just restarted
  const external = createKubo({
    settings: { get: () => ({ ipfs: { mode: 'external', externalApiUrl: `${first.api_url}/`, publicGateway: 'https://ipfs.io', preferredGateway: 'local' } }), onChange: () => () => {} },
    userData: path.join(userData, 'external-profile'),
    resourcesDir: path.join(userData, 'no-resources'),
    getMainWindow: () => null,
    log: quietLog,
  });
  assert.equal(external.status().source, 'external_api');
  const attached = await external.start();
  assert.equal(attached.state, 'ready');
  assert.equal(attached.source, 'external_api');
  assert.equal(attached.embedded, false);
  assert.equal(attached.api_url, first.api_url);
  assert.equal(attached.gateway_url, first.gateway_url);
  assert.equal(attached.peer_id, first.peer_id);
  assert.equal((await external.stop()).message, 'Disconnected from the external IPFS node.');
  assert.equal((await kubo.rpc.id()).ID, first.peer_id, 'stopping the external client must not shut the node down');

  // external node unreachable → clear error status, start() rejects
  const dead = createKubo({
    settings: { get: () => ({ ipfs: { mode: 'external', externalApiUrl: 'http://127.0.0.1:9' } }), onChange: () => () => {} },
    userData: path.join(userData, 'dead-profile'),
    resourcesDir: path.join(userData, 'no-resources'),
    getMainWindow: () => null,
    log: quietLog,
  });
  await assert.rejects(dead.start(), /Kubo RPC 'version' failed/);
  assert.equal(dead.status().state, 'error');
  assert.equal(dead.isReady(), false);

  await kubo.stop();
});
