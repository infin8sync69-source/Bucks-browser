import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createSoulEngine, soulSettings, agentDirCandidates, pythonCandidates, parseDotenv, engineEnv,
  describeHealth, settingsAction, pythonVersionOk, venvPython, modelEntry, pendingEntry,
} from '../../../src/main/agent/soul-engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = path.join(here, 'fixtures', 'fake-soul-engine.mjs');
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/* ---------- pure helpers ---------- */

test('soulSettings validates every field', () => {
  assert.deepEqual(soulSettings({}), { autoStart: true, backend: 'edge', port: 0, python: '', agentDir: '' });
  assert.deepEqual(
    soulSettings({ agent: { soul: { autoStart: false, backend: 'ollama', port: 9000, python: ' /py ', agentDir: '/a' } } }),
    { autoStart: false, backend: 'ollama', port: 9000, python: '/py', agentDir: '/a' },
  );
  assert.equal(soulSettings({ agent: { soul: { backend: 'gpt-9' } } }).backend, 'edge');
  assert.equal(soulSettings({ agent: { soul: { port: 70000 } } }).port, 0);
  assert.equal(soulSettings({ agent: { soul: { port: '8765' } } }).port, 8765);
});

test('agent directory and interpreter search order', () => {
  const dirs = agentDirCandidates({ soul: { agentDir: '/custom' }, env: { BUCKS_SOUL_DIR: '/env' }, resourcesDir: '/res', appRoot: '/app' });
  assert.deepEqual(dirs, ['/custom', '/env', path.join('/res', 'agent'), path.join('/app', 'agent')].map((d) => path.resolve(d)));
  assert.deepEqual(agentDirCandidates({ soul: {}, env: {}, resourcesDir: null, appRoot: '/app' }), [path.resolve('/app/agent')]);
  const py = pythonCandidates({ soul: { python: '/py' }, env: { BUCKS_SOUL_PYTHON: '/envpy' }, engineDir: '/data/soul-engine', agentDir: '/app/agent', platform: 'linux' });
  assert.deepEqual(py, ['/py', '/envpy', path.join('/data/soul-engine/venv', 'bin', 'python'), path.join('/app/agent/.venv', 'bin', 'python')]);
  assert.equal(venvPython('C:\\v', 'win32'), path.join('C:\\v', 'Scripts', 'python.exe'));
});

test('parseDotenv', () => {
  assert.deepEqual(parseDotenv('# keys\nNGC_API_KEY=nvapi-1 # mine\nexport A="quoted # kept"\nB=\'x\'\n\nbad line\nC='), { NGC_API_KEY: 'nvapi-1', A: 'quoted # kept', B: 'x', C: '' });
});

test('engineEnv: Bucks-owned values win over .env and the parent environment', () => {
  const env = engineEnv({
    baseEnv: { PATH: '/bin', BUCKS_SOUL_TOKEN: 'leaked', ELECTRON_RUN_AS_NODE: '1' },
    dotenv: { NGC_API_KEY: 'k', MODEL_PROVIDER: 'nim', BUCKS_DATA_DIR: '/elsewhere' },
    token: 'tok', engineDir: '/data/soul-engine', soul: { backend: 'ollama' }, agent: { ollamaUrl: 'http://o:1', ollamaModel: 'm' },
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.NGC_API_KEY, 'k', 'API keys come from the .env file');
  assert.equal(env.BUCKS_SOUL_TOKEN, 'tok');
  assert.equal(env.MODEL_PROVIDER, 'ollama');
  assert.equal(env.BUCKS_DATA_DIR, '/data/soul-engine');
  assert.equal(env.BUCKS_PROJECT_ROOT, path.join('/data/soul-engine', 'workspace'));
  assert.equal(env.OLLAMA_BASE_URL, 'http://o:1');
  assert.equal(env.BUCKS_MODEL, 'm');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.BUCKS_ALLOWED_ROOTS, undefined, 'no file access beyond the workspace unless the user set it');
});

test('describeHealth covers every engine mode', () => {
  const soul = { backend: 'edge' };
  const agent = { ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'llama3.2' };
  assert.equal(describeHealth({ mode: 'local_llm', model: 'q' }, soul, agent).state, 'ready');
  assert.equal(describeHealth({ mode: 'cloud_llm' }, soul, agent).state, 'ready');
  assert.match(describeHealth({ mode: 'loading', model: 'q' }, soul, agent).message, /downloads it/);
  assert.match(describeHealth({ mode: 'no_model' }, soul, agent).message, /ollama pull llama3\.2/);
  assert.match(describeHealth({ mode: 'unconfigured', provider: 'nim' }, soul, agent).message, /nim backend needs your API key/);
  assert.match(describeHealth({ mode: 'offline' }, soul, agent).message, /Cannot reach Ollama at http:\/\/127\.0\.0\.1:11434/);
  const err = describeHealth({ mode: 'error', error: "ModuleNotFoundError: No module named 'llama_cpp'" }, soul, agent);
  assert.equal(err.state, 'error');
  assert.match(err.message, /could not be loaded: .*llama_cpp.*Install/);
  assert.equal(describeHealth({ mode: 'weird' }, soul, agent).state, 'error');
});

test('settingsAction', () => {
  const s = (provider, soul = {}, agent = {}) => ({ agent: { provider, ollamaUrl: 'u', ollamaModel: 'm', ...agent, soul: { backend: 'edge', ...soul } } });
  assert.equal(settingsAction(s('offline'), s('soul'), false), 'start');
  assert.equal(settingsAction(s('offline'), s('soul', { autoStart: false }), false), null);
  assert.equal(settingsAction(s('soul'), s('ollama'), true), 'stop');
  assert.equal(settingsAction(s('soul'), s('ollama'), false), null);
  assert.equal(settingsAction(s('soul'), s('soul', { backend: 'ollama' }), true), 'restart');
  assert.equal(settingsAction(s('soul'), s('soul', { backend: 'ollama' }), false), null);
  assert.equal(settingsAction(s('soul', { backend: 'ollama' }), s('soul', { backend: 'ollama' }, { ollamaModel: 'other' }), true), 'restart');
  assert.equal(settingsAction(s('soul'), s('soul', {}, { ollamaModel: 'other' }), true), null, 'ollama model is irrelevant to the edge backend');
  assert.equal(settingsAction(s('soul'), s('soul', { autoStart: false }), true), null);
});

test('pythonVersionOk', () => {
  assert.equal(pythonVersionOk('(3, 12)'), true);
  assert.equal(pythonVersionOk('(3, 10)'), true);
  assert.equal(pythonVersionOk('(3, 9)'), false);
  assert.equal(pythonVersionOk('(4, 0)'), true);
  assert.equal(pythonVersionOk(''), false);
});

/* ---------- lifecycle against a fake engine process ---------- */

async function setup(t, { mode = 'ok', soul = {}, agent = {}, dotenv = '' } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-soul-'));
  const userData = path.join(root, 'profile');
  const agentDir = path.join(root, 'agent');
  await fsp.mkdir(agentDir, { recursive: true });
  await fsp.writeFile(path.join(agentDir, 'soul_engine.py'), '# fake\n');
  const python = path.join(root, 'python');
  await fsp.writeFile(python, '');
  if (dotenv) {
    await fsp.mkdir(path.join(userData, 'soul-engine'), { recursive: true });
    await fsp.writeFile(path.join(userData, 'soul-engine', '.env'), dotenv);
  }
  const snapshot = { agent: { provider: 'soul', ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'llama3.2', ...agent, soul: { agentDir, python, ...soul } } };
  const spawned = [];
  // Run the fake engine with this Node binary instead of python; keep the real arguments.
  const spawnImpl = (cmd, args, opts) => {
    const proc = spawn(process.execPath, [FAKE_ENGINE, ...args], opts);
    spawned.push({ cmd, args, opts, proc });
    return proc;
  };
  const statuses = [];
  const engine = createSoulEngine({
    settings: { get: () => structuredClone(snapshot) },
    userData,
    appRoot: null,
    resourcesDir: null,
    log: quietLog,
    spawnImpl,
    env: { PATH: process.env.PATH, FAKE_SOUL_MODE: mode },
  });
  engine.onStatus((s) => statuses.push(s.state));
  t.after(async () => {
    await engine.stop();
    for (const { proc } of spawned) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await fsp.rm(root, { recursive: true, force: true });
  });
  const call = async (pathname) => {
    const { url, token } = engine.connection();
    const res = await fetch(`${url}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
    return res.json();
  };
  return { engine, spawned, statuses, call, userData, agentDir, python, snapshot };
}

async function waitFor(fn, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

test('start → ready with a fresh token, aligned backend and confined environment; stop leaves nothing', { timeout: 30_000 }, async (t) => {
  const { engine, spawned, statuses, call, userData, agentDir, python } = await setup(t, { dotenv: 'NGC_API_KEY=user-key\nBUCKS_SOUL_TOKEN=nope\n' });
  const st = await engine.start();
  assert.equal(st.state, 'ready', st.message);
  assert.equal(st.python, python);
  assert.equal(st.agentDir, agentDir);
  assert.match(st.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(statuses[0], 'starting');
  assert.equal(statuses.at(-1), 'ready');

  const [{ cmd, args, opts }] = spawned;
  assert.equal(cmd, python);
  assert.deepEqual(args.slice(0, 6), ['-m', 'uvicorn', 'soul_engine:app', '--host', '127.0.0.1', '--port']);
  assert.equal(opts.cwd, agentDir);

  const conn = engine.connection();
  assert.equal(conn.token.length, 64);
  const env = await call('/_env');
  assert.equal(env.BUCKS_SOUL_TOKEN, conn.token, 'the .env file cannot override the token');
  assert.equal(env.NGC_API_KEY, 'user-key');
  assert.equal(env.MODEL_PROVIDER, 'edge');
  assert.equal(env.BUCKS_DATA_DIR, path.join(userData, 'soul-engine'));
  assert.ok(fs.existsSync(path.join(userData, 'soul-engine', 'workspace')));
  assert.deepEqual(await call('/_calls').then((c) => c.filter((x) => x.startsWith('POST'))), ['POST /providers/select {"provider":"edge"}'], 'remembered nim backend replaced by the Settings choice');

  assert.equal((await fetch(`${conn.url}/_calls`)).status, 401, 'no token, no access');
  assert.equal((await engine.start()).state, 'ready', 'start() on a running engine is a no-op');
  assert.equal(spawned.length, 1);

  const pid = spawned[0].proc.pid;
  await engine.stop();
  assert.equal(engine.status().state, 'stopped');
  assert.equal(engine.connection(), null);
  assert.equal(await waitFor(() => !isAlive(pid)), true, 'process gone');
  assert.ok(fs.readFileSync(path.join(userData, 'logs', 'soul-engine.log'), 'utf8').includes('fake soul engine on'));

  await engine.start();
  assert.notEqual(engine.connection().token, conn.token, 'a new token for every start');
});

test('a crash after ready is restarted with back-off', { timeout: 30_000 }, async (t) => {
  const { engine, spawned } = await setup(t, { mode: 'crash-after-ready' });
  assert.equal((await engine.start()).state, 'ready');
  assert.equal(await waitFor(() => engine.status().state === 'error'), true);
  assert.match(engine.status().message, /exited unexpectedly.*restarting in 2s \(attempt 1\/3\)/);
  assert.equal(engine.connection(), null);
  assert.equal(await waitFor(() => spawned.length === 2, 8000), true, 'respawned');
});

test('a failing start reports the engine output', { timeout: 30_000 }, async (t) => {
  const { engine } = await setup(t, { mode: 'exit-at-start' });
  const st = await engine.start();
  assert.equal(st.state, 'error');
  assert.match(st.message, /exited during start-up \(code 3\)/);
  assert.match(st.message, /No module named fastapi/);
});

test('loading, then ready; an unusable backend is reported but the engine is kept', { timeout: 30_000 }, async (t) => {
  const loading = await setup(t, { mode: 'loading-then-ready' });
  assert.equal((await loading.engine.start()).state, 'loading');
  assert.equal(await waitFor(() => loading.engine.status().state === 'ready', 15_000), true);

  const down = await setup(t, { mode: 'ollama-down', soul: { backend: 'ollama' } });
  const st = await down.engine.start();
  assert.equal(st.state, 'error');
  assert.match(st.message, /Cannot reach Ollama/);
  assert.ok(down.engine.connection(), 'still running: it recovers when Ollama comes up');
  assert.equal(down.engine.isRunning(), true);
});

test('no interpreter or no code: unavailable, with what to do', { timeout: 10_000 }, async (t) => {
  const noPython = await setup(t, { soul: { python: '/nonexistent/python' } });
  const st = await noPython.engine.start();
  assert.equal(st.state, 'unavailable');
  assert.match(st.message, /Python 3\.10 or newer/);
  assert.equal(noPython.spawned.length, 0);

  const noCode = await setup(t, { soul: { agentDir: '/nonexistent/agent' } });
  assert.equal((await noCode.engine.start()).state, 'unavailable');
  assert.match(noCode.engine.status().message, /soul_engine\.py\) was not found/);
});

test('model and pending-update entries are normalised', () => {
  assert.deepEqual(modelEntry({ id: 'q', size_gb: 1.5, fits_ram: false, downloaded: true, current: false }), { id: 'q', sizeGb: 1.5, fitsRam: false, downloaded: true, current: false });
  assert.equal(modelEntry({ size_gb: 1 }), null);
  const u = pendingEntry({ update_id: 'u1', kind: 'weird', cid: 'bafy', summary: 7, peer_soul_id: 'p', created_at: '12', peer: { locality: 'Lisbon', capabilities: ['a', 3, 'b'] } });
  assert.deepEqual(u, { id: 'u1', kind: 'fragment', cid: 'bafy', summary: '', peerSoulId: 'p', peer: { locality: 'Lisbon', capabilities: ['a', 'b'] }, createdAt: 12 });
  assert.equal(pendingEntry({}), null);
});

test('model picker and peer updates against the running engine', { timeout: 30_000 }, async (t) => {
  const { engine, snapshot, call } = await setup(t);
  await assert.rejects(engine.models(), /not running/);
  assert.deepEqual(await engine.pendingUpdates(), [], 'nothing pending while stopped');
  assert.equal((await engine.start()).state, 'ready');

  const m = await engine.models();
  assert.deepEqual(m.models.map((x) => [x.id, x.current, x.fitsRam]), [['qwen2.5-1.5b', true, true], ['qwen2.5-3b', false, true], ['huge-70b', false, false]]);
  assert.equal(m.provider, 'edge', 'the backend was aligned with Settings');

  const after = await engine.selectModel('qwen2.5-3b');
  assert.equal(after.current, 'qwen2.5-3b');
  assert.equal(await waitFor(() => engine.status().model === 'qwen2.5-3b'), true, 'the status follows the new model');
  await assert.rejects(engine.selectModel('nope'), /unknown model id: nope/);
  assert.deepEqual(await engine.downloadProgress(), { active: true, modelId: 'qwen2.5-3b', downloadedBytes: 500, totalBytes: 2000 });

  const pending = await engine.pendingUpdates();
  assert.deepEqual(pending.map((u) => [u.id, u.kind, u.peer?.locality ?? null]), [['abc123', 'fragment', 'Lisbon'], ['def456', 'adapter', null]]);
  assert.deepEqual((await engine.decideUpdate('abc123', 'approve')).map((u) => u.id), ['def456']);
  await assert.rejects(engine.decideUpdate('abc123', 'deny'), /no such pending update/);
  await assert.rejects(engine.decideUpdate('def456', 'delete'), /approve or deny/);
  await assert.rejects(engine.decideUpdate('../../x', 'deny'), /Invalid update id/);
  assert.ok((await call('/_calls')).includes('POST /agent/pending/abc123/approve'));

  snapshot.agent.soul.backend = 'ollama';
  await assert.rejects(engine.selectModel('qwen2.5-1.5b'), /on-device backend first/);
});

test('settingsAction at startup tolerates a broken soul section', () => {
  assert.equal(settingsAction({}, { agent: { provider: 'soul', soul: null } }, false), 'start');
  assert.equal(settingsAction({}, { agent: { provider: 'soul', soul: { autoStart: false } } }, false), null);
  assert.equal(settingsAction({}, { agent: { provider: 'offline' } }, false), null);
  assert.equal(settingsAction({}, {}, false), null);
});
