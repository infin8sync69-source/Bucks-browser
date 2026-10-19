// Soul Engine sidecar supervisor: find the agent code (agent/soul_engine.py) and a Python that has
// its packages, spawn `python -m uvicorn soul_engine:app` on a loopback port with a bearer token
// that is new at every start, wait for /health, keep the engine's model backend in line with
// Settings, restart after crashes, and expose a status machine to the rest of the app.
// Pure Node (no Electron imports) so it runs under `node --test`; the only Electron touch-point
// is the optional getMainWindow() callback used to push status events.
//
// Unlike the Bucks-App launcher this never adopts an engine it did not start and never kills a
// process it did not spawn: a server already on a port could be anything, and an engine without
// our token could be driven by any web page.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { createLogger } from '../log.js';

export const SOUL_BACKENDS = Object.freeze(['edge', 'ollama', 'nim', 'litai']);
export const DEFAULT_SOUL_SETTINGS = Object.freeze({ autoStart: true, backend: 'edge', port: 0, python: '', agentDir: '' });

const HEALTH_POLL_MS = 1000;
const HEALTH_RETRY_MS = 10_000; // engine up but not usable (model missing, Ollama down): keep checking
const SPAWN_WAIT_MS = 60_000; // from spawn until /health first answers
const REQUEST_TIMEOUT_MS = 5000;
const MODEL_SWITCH_TIMEOUT_MS = 60 * 60_000; // a first switch downloads the model (GBs)
const DECIDE_TIMEOUT_MS = 60_000; // approving fetches the CID from IPFS
const RESTART_BACKOFF_MS = [2000, 5000, 15_000];
const STABLE_RESET_MS = 120_000;
const STOP_GRACE_MS = 5000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const OUTPUT_TAIL_LINES = 40;
const MIN_PYTHON = [3, 10];

/** /health modes in which the engine can answer questions. */
const READY_MODES = new Set(['local_llm', 'cloud_llm']);

/* ───────────────────────────── pure helpers (unit-tested) ───────────────────────────── */

/** Settings.agent.soul merged over the defaults, with every value validated. */
export function soulSettings(settingsSnapshot) {
  const raw = settingsSnapshot?.agent?.soul || {};
  const port = Number(raw.port);
  return {
    autoStart: raw.autoStart !== false,
    backend: SOUL_BACKENDS.includes(raw.backend) ? raw.backend : DEFAULT_SOUL_SETTINGS.backend,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
    python: typeof raw.python === 'string' ? raw.python.trim() : '',
    agentDir: typeof raw.agentDir === 'string' ? raw.agentDir.trim() : '',
  };
}

/** Path of the interpreter inside a venv directory. */
export function venvPython(venvDir, platform = process.platform) {
  return platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
}

/**
 * Candidate agent directories, in order; the first that contains soul_engine.py wins.
 * Explicit choices (Settings, then $BUCKS_SOUL_DIR) come first, then the copy shipped with the
 * app (packaged: <resources>/agent) and the source checkout (<appRoot>/agent).
 */
export function agentDirCandidates({ soul, env = process.env, resourcesDir, appRoot }) {
  return [soul?.agentDir, env.BUCKS_SOUL_DIR, resourcesDir && path.join(resourcesDir, 'agent'), appRoot && path.join(appRoot, 'agent')]
    .filter((d) => typeof d === 'string' && d.trim())
    .map((d) => path.resolve(d));
}

/**
 * Candidate Python interpreters, in order: Settings, $BUCKS_SOUL_PYTHON, the private venv that
 * install() creates in the profile, then a `.venv` next to the agent code (what
 * agent/start_soul_engine.sh creates in a source checkout).
 */
export function pythonCandidates({ soul, env = process.env, engineDir, agentDir, platform = process.platform }) {
  return [
    soul?.python,
    env.BUCKS_SOUL_PYTHON,
    engineDir && venvPython(path.join(engineDir, 'venv'), platform),
    agentDir && venvPython(path.join(agentDir, '.venv'), platform),
  ].filter((p) => typeof p === 'string' && p.trim());
}

/** Parse a dotenv file body into an object (KEY=value, optional quotes, # comments). */
export function parseDotenv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

/**
 * Environment for the engine process. Starts from the app's environment, adds the user's own
 * `<engineDir>/.env` (API keys for opt-in cloud backends live there, not in settings.json), then
 * the values Bucks owns, which always win: the token, the data directories and the backend.
 */
export function engineEnv({ baseEnv = process.env, dotenv = {}, token, engineDir, soul, agent }) {
  const env = { ...baseEnv, ...dotenv };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    BUCKS_SOUL_TOKEN: token,
    BUCKS_DATA_DIR: engineDir,
    BUCKS_HOME: engineDir,
    // File tools (read_file, list_directory) are confined to this folder unless the user grants
    // more with BUCKS_ALLOWED_ROOTS themselves. Bucks-App granted the whole home directory.
    BUCKS_PROJECT_ROOT: path.join(engineDir, 'workspace'),
    MODEL_PROVIDER: soul.backend,
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1', // the packaged agent/ is read-only
  });
  if (agent?.ollamaUrl) env.OLLAMA_BASE_URL = agent.ollamaUrl;
  if (agent?.ollamaModel) env.BUCKS_MODEL = agent.ollamaModel;
  return env;
}

/**
 * Map one /health payload to a status patch.
 * @returns {{ state: string, message: string, model: string|null, mode: string|null }}
 */
export function describeHealth(h, soul, agent) {
  const mode = typeof h?.mode === 'string' ? h.mode : null;
  const model = typeof h?.model === 'string' ? h.model : null;
  const label = model ? ` (${model})` : '';
  switch (mode) {
    case 'local_llm':
    case 'cloud_llm':
      return { state: 'ready', message: `Soul Engine is ready${label}.`, model, mode };
    case 'loading':
      return {
        state: 'loading',
        message: `Loading the on-device model${label}. The first start downloads it, which can take several minutes.`,
        model, mode,
      };
    case 'no_model':
      return { state: 'error', message: `Ollama is running but the model is not installed. Run: ollama pull ${agent?.ollamaModel || model || '<model>'}`, model, mode };
    case 'unconfigured':
      return {
        state: 'error',
        message: `The ${h?.provider || soul.backend} backend needs your API key in the Soul Engine .env file.`,
        model, mode,
      };
    case 'offline':
      return { state: 'error', message: `Cannot reach Ollama at ${agent?.ollamaUrl || 'its URL'}. Start it with: ollama serve`, model, mode };
    case 'error': {
      const detail = typeof h?.error === 'string' ? h.error.slice(0, 300) : 'unknown error';
      const hint = /llama_cpp|huggingface_hub/.test(detail) ? ' Install the on-device model packages with Install in Settings → Agent.' : '';
      return { state: 'error', message: `The on-device model could not be loaded: ${detail}.${hint}`, model, mode };
    }
    default:
      return { state: 'error', message: `Soul Engine reported an unknown state "${mode}".`, model, mode };
  }
}

/**
 * What a settings change means for the engine.
 * @param {object} prev  settings snapshot before the change
 * @param {object} next  settings snapshot after the change
 * @param {boolean} running  an engine process exists (or is starting)
 * @returns {'start'|'stop'|'restart'|null}
 */
export function settingsAction(prev, next, running) {
  const isSoul = next?.agent?.provider === 'soul';
  if (!isSoul) return running ? 'stop' : null; // do not keep a model in memory nobody uses
  const b = soulSettings(next);
  if (prev?.agent?.provider !== 'soul') return b.autoStart && !running ? 'start' : null;
  if (!running) return null;
  const a = soulSettings(prev);
  const engineChanged = ['backend', 'port', 'python', 'agentDir'].some((k) => a[k] !== b[k]);
  const ollamaChanged = b.backend === 'ollama'
    && (prev?.agent?.ollamaUrl !== next?.agent?.ollamaUrl || prev?.agent?.ollamaModel !== next?.agent?.ollamaModel);
  return engineChanged || ollamaChanged ? 'restart' : null;
}

/** True for a Python version (from `python -c 'print(sys.version_info[:2])'`, e.g. "(3, 12)") that is new enough. */
export function pythonVersionOk(text) {
  const m = /(\d+)\D+(\d+)/.exec(String(text || ''));
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > MIN_PYTHON[0] || (maj === MIN_PYTHON[0] && min >= MIN_PYTHON[1]);
}

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One entry of the engine's /models catalogue, in the chrome's shape (null when unusable). */
export function modelEntry(m) {
  const id = str(m?.id, 120);
  if (!id) return null;
  return { id, sizeGb: Number(m.size_gb) || 0, fitsRam: m.fits_ram !== false, downloaded: m.downloaded === true, current: m.current === true };
}

/** One pending peer update from /agent/pending, in the chrome's shape (null when unusable). */
export function pendingEntry(u) {
  const id = str(u?.update_id, 128);
  if (!id) return null;
  const peer = u.peer && typeof u.peer === 'object'
    ? { locality: str(u.peer.locality, 80), capabilities: Array.isArray(u.peer.capabilities) ? u.peer.capabilities.map((c) => str(c, 60)).filter(Boolean).slice(0, 8) : [] }
    : null;
  return {
    id,
    kind: u.kind === 'adapter' ? 'adapter' : 'fragment',
    cid: str(u.cid, 200),
    summary: str(u.summary, 500),
    peerSoulId: str(u.peer_soul_id, 128),
    peer,
    createdAt: Number(u.created_at) || 0,
  };
}

/* ───────────────────────────── small node utilities ───────────────────────────── */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function childExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/* ───────────────────────────── supervisor ───────────────────────────── */

/**
 * @param {object} deps
 * @param {{ get(): object, onChange?(cb: (s: object) => void): () => void }} deps.settings
 * @param {string} deps.userData
 * @param {string} [deps.appRoot]       source checkout root (agent/ next to package.json)
 * @param {string} [deps.resourcesDir]  packaged resources (agent/ copied by electron-builder)
 * @param {() => any} [deps.getMainWindow]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {typeof nodeSpawn} [deps.spawnImpl]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {string} [deps.platform]
 */
export function createSoulEngine({
  settings,
  userData,
  appRoot,
  resourcesDir,
  getMainWindow = () => null,
  log = createLogger('soul'),
  fetchImpl = (...a) => globalThis.fetch(...a),
  spawnImpl = nodeSpawn,
  env = process.env,
  platform = process.platform,
}) {
  const engineDir = path.join(userData, 'soul-engine');
  const logFile = path.join(userData, 'logs', 'soul-engine.log');
  const listeners = new Set();

  let status = {
    state: 'idle',
    message: 'The Soul Engine has not been started.',
    url: null,
    backend: soulSettings(settings.get?.()).backend,
    model: null,
    mode: null,
    python: null,
    agentDir: null,
    dataDir: engineDir,
  };

  let child = null;
  let token = null;
  let url = null;
  let startPromise = null;
  let stopPromise = null;
  let installPromise = null;
  let stopRequested = false;
  let restartAttempts = 0;
  let restartTimer = null;
  let stableTimer = null;
  let healthTimer = null;
  let outputTail = [];
  let logStream = null;
  let reconciled = false;

  /* ---------- status ---------- */

  function setStatus(patch) {
    status = { ...status, ...patch };
    const snapshot = { ...status };
    log.debug?.(`status → ${snapshot.state}: ${snapshot.message}`);
    for (const cb of listeners) {
      try { cb(snapshot); } catch (e) { log.error('status listener failed:', e); }
    }
    try {
      const win = getMainWindow?.();
      if (win && !win.isDestroyed?.() && win.webContents && !win.webContents.isDestroyed?.()) {
        win.webContents.send('bucks:agent:soul-status', snapshot);
      }
    } catch (e) {
      log.warn('could not push Soul Engine status to window:', e.message);
    }
  }

  const OFFLINE = { url: null, model: null, mode: null };

  function current() {
    const snapshot = settings.get?.() || {};
    return { soul: soulSettings(snapshot), agent: snapshot.agent || {} };
  }

  /* ---------- logging of the child's output ---------- */

  function openLog() {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      try {
        if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, `${logFile}.1`);
      } catch { /* no file yet */ }
      logStream = fs.createWriteStream(logFile, { flags: 'a' });
    } catch (e) {
      log.warn(`cannot open ${logFile}: ${e.message}`);
      logStream = null;
    }
  }

  function closeLog() {
    try { logStream?.end(); } catch { /* ignore */ }
    logStream = null;
  }

  function onOutput(chunk) {
    const text = chunk.toString();
    try { logStream?.write(text); } catch { /* ignore */ }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      outputTail.push(line.trim());
      if (outputTail.length > OUTPUT_TAIL_LINES) outputTail.shift();
    }
  }

  /* ---------- locating code and interpreter ---------- */

  function locateAgentDir(soul) {
    const candidates = agentDirCandidates({ soul, env, resourcesDir, appRoot });
    return candidates.find((d) => exists(path.join(d, 'soul_engine.py'))) || null;
  }

  function locatePython(soul, agentDir) {
    return pythonCandidates({ soul, env, engineDir, agentDir, platform }).find(exists) || null;
  }

  async function readDotenv() {
    try {
      return parseDotenv(await fsp.readFile(path.join(engineDir, '.env'), 'utf8'));
    } catch {
      return {};
    }
  }

  /* ---------- talking to the engine ---------- */

  async function request(pathname, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const res = await fetchImpl(`${url}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Soul Engine responded ${res.status} to ${pathname}`);
    return res.json();
  }

  async function health() {
    try {
      const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  /**
   * The engine persists the last provider it was switched to, which outranks MODEL_PROVIDER.
   * Settings is the source of truth here, so align the engine with it once it answers.
   */
  async function reconcileBackend(soul) {
    try {
      const info = await request('/providers');
      if (info?.current !== soul.backend) {
        await request('/providers/select', { method: 'POST', body: { provider: soul.backend } });
        log.info(`Soul Engine backend switched from ${info?.current} to ${soul.backend}`);
      }
      reconciled = true;
    } catch (e) {
      log.warn(`could not align the Soul Engine backend: ${e.message}`);
    }
  }

  /* ---------- health loop ---------- */

  function clearTimers() {
    if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
  }

  /** Keep polling /health while the engine runs; move between loading, ready and error. */
  function scheduleHealth(delay) {
    if (healthTimer) clearTimeout(healthTimer);
    healthTimer = setTimeout(async () => {
      healthTimer = null;
      if (!child || stopRequested) return;
      const { soul, agent } = current();
      const h = await health();
      if (!child || stopRequested) return;
      if (!h) {
        scheduleHealth(HEALTH_RETRY_MS);
        return;
      }
      if (!reconciled) {
        await reconcileBackend(soul);
        if (!child || stopRequested) return;
      }
      const next = describeHealth(h, soul, agent);
      if (next.state !== status.state || next.message !== status.message || next.model !== status.model) setStatus(next);
      if (next.state === 'ready' && !stableTimer) {
        stableTimer = setTimeout(() => { restartAttempts = 0; }, STABLE_RESET_MS);
        stableTimer.unref?.();
      }
      scheduleHealth(next.state === 'loading' ? HEALTH_POLL_MS * 2 : HEALTH_RETRY_MS);
    }, delay);
    healthTimer.unref?.();
  }

  function scheduleRestart(reason) {
    clearTimers();
    url = null;
    token = null;
    if (restartAttempts >= RESTART_BACKOFF_MS.length) {
      setStatus({ state: 'error', message: `${reason}; gave up after ${RESTART_BACKOFF_MS.length} restarts. Start it again from Settings.`, ...OFFLINE });
      return;
    }
    const delay = RESTART_BACKOFF_MS[restartAttempts];
    restartAttempts += 1;
    setStatus({ state: 'error', message: `${reason}; restarting in ${delay / 1000}s (attempt ${restartAttempts}/${RESTART_BACKOFF_MS.length}).`, ...OFFLINE });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      engine.start().catch((e) => log.error('Soul Engine auto-restart failed:', e.message));
    }, delay);
    restartTimer.unref?.();
  }

  function onChildExit(proc, code, signal) {
    if (proc !== child) return;
    child = null;
    closeLog();
    log.warn(`Soul Engine exited (code ${code}, signal ${signal})`);
    if (stopRequested) return;
    if (startPromise) return; // the start() wait loop reports this
    const tail = outputTail.slice(-3).join(' | ');
    scheduleRestart(`The Soul Engine exited unexpectedly (code ${code ?? signal})${tail ? `: ${tail}` : ''}`);
  }

  /* ---------- starting ---------- */

  async function waitForFirstAnswer(proc) {
    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < deadline) {
      if (stopRequested) throw new Error('stopped');
      if (childExited(proc)) {
        const tail = outputTail.slice(-6).join('\n');
        throw new Error(`The Soul Engine exited during start-up (code ${proc.exitCode ?? proc.signalCode})${tail ? `:\n${tail}` : ''}`);
      }
      const h = await health();
      if (h) return h;
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error(`The Soul Engine did not answer within ${SPAWN_WAIT_MS / 1000}s`);
  }

  async function doStart() {
    const { soul, agent } = current();
    setStatus({ state: 'starting', message: 'Starting the Soul Engine…', backend: soul.backend, ...OFFLINE });

    const agentDir = locateAgentDir(soul);
    if (!agentDir) {
      setStatus({ state: 'unavailable', message: 'The Soul Engine code (agent/soul_engine.py) was not found.', agentDir: null, python: null });
      return;
    }
    const python = locatePython(soul, agentDir);
    if (!python) {
      setStatus({
        state: 'unavailable',
        message: 'The Soul Engine needs Python 3.10 or newer with its packages. Use Install in Settings → Agent, or run agent/start_soul_engine.sh once.',
        agentDir,
        python: null,
      });
      return;
    }

    await fsp.mkdir(path.join(engineDir, 'workspace'), { recursive: true });
    const port = soul.port || (await freePort());
    token = crypto.randomBytes(32).toString('hex');
    url = `http://127.0.0.1:${port}`;
    reconciled = false;
    outputTail = [];
    openLog();

    const childEnv = engineEnv({ baseEnv: env, dotenv: await readDotenv(), token, engineDir, soul, agent });
    log.info(`Starting Soul Engine: ${python} (agent ${agentDir}, backend ${soul.backend}, ${url})`);
    const proc = spawnImpl(python, ['-m', 'uvicorn', 'soul_engine:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: agentDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = proc;
    setStatus({ python, agentDir });
    proc.stdout?.on('data', onOutput);
    proc.stderr?.on('data', onOutput);
    proc.on('exit', (code, signal) => onChildExit(proc, code, signal));
    proc.on('error', (e) => onOutput(Buffer.from(`spawn error: ${e.message}\n`)));

    try {
      const h = await waitForFirstAnswer(proc);
      await reconcileBackend(soul);
      setStatus({ url, ...describeHealth(h, soul, agent) });
    } catch (e) {
      child = null;
      await killChild(proc);
      closeLog();
      url = null;
      token = null;
      throw e;
    }
    scheduleHealth(status.state === 'ready' ? HEALTH_RETRY_MS : HEALTH_POLL_MS * 2);
  }

  /* ---------- stopping ---------- */

  function waitForExit(proc, ms) {
    return new Promise((resolve) => {
      if (childExited(proc)) return resolve(true);
      const t = setTimeout(() => { proc.off?.('exit', done); resolve(false); }, ms);
      const done = () => { clearTimeout(t); resolve(true); };
      proc.once('exit', done);
    });
  }

  function forceKill(proc) {
    if (!proc?.pid || childExited(proc)) return;
    if (platform === 'win32') {
      try { spawnImpl('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
    } else {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

  async function killChild(proc) {
    if (!proc || childExited(proc)) return;
    if (platform === 'win32') forceKill(proc);
    else {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    if (!(await waitForExit(proc, STOP_GRACE_MS))) {
      forceKill(proc);
      await waitForExit(proc, 2000);
    }
  }

  async function doStop() {
    stopRequested = true;
    clearTimers();
    if (startPromise) await startPromise.catch(() => {});
    const proc = child;
    child = null;
    url = null;
    token = null;
    if (proc) await killChild(proc);
    closeLog();
    setStatus({ state: 'stopped', message: 'Soul Engine stopped.', ...OFFLINE });
  }

  /* ---------- installing a private Python environment ---------- */

  function run(cmd, args, { cwd, onLine } = {}) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawnImpl(cmd, args, { cwd, env: { ...env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        reject(e);
        return;
      }
      const tail = [];
      const collect = (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          tail.push(line.trim());
          if (tail.length > 20) tail.shift();
          onLine?.(line.trim());
        }
      };
      proc.stdout?.on('data', collect);
      proc.stderr?.on('data', collect);
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve(tail);
        else reject(new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(' ')} failed (exit ${code}):\n${tail.slice(-6).join('\n')}`));
      });
    });
  }

  /** A system Python 3.10+ to build the venv from. */
  async function findSystemPython() {
    const names = platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
    for (const [cmd, pre] of names) {
      try {
        const out = await run(cmd, [...pre, '-c', 'import sys; print(sys.version_info[:2])']);
        if (pythonVersionOk(out.join(' '))) return [cmd, pre];
      } catch { /* try the next one */ }
    }
    return null;
  }

  async function doInstall() {
    const { soul } = current();
    const agentDir = locateAgentDir(soul);
    if (!agentDir) throw new Error('The Soul Engine code (agent/soul_engine.py) was not found.');
    const say = (message) => setStatus({ state: 'installing', message, ...OFFLINE, agentDir });

    say('Looking for Python 3.10 or newer…');
    const sys = await findSystemPython();
    if (!sys) throw new Error('Python 3.10 or newer was not found. Install it from python.org (or your package manager) and try again.');
    const venvDir = path.join(engineDir, 'venv');
    await fsp.mkdir(engineDir, { recursive: true });
    say(`Creating a private Python environment in ${venvDir}…`);
    await run(sys[0], [...sys[1], '-m', 'venv', venvDir]);
    const py = venvPython(venvDir, platform);
    const reqs = ['requirements-engine.txt', ...(soul.backend === 'edge' ? ['requirements-edge.txt'] : [])];
    say(`Installing packages (${reqs.join(', ')}). This can take a few minutes…`);
    const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input'];
    for (const r of reqs) pipArgs.push('-r', path.join(agentDir, r));
    await run(py, pipArgs, { cwd: agentDir, onLine: (line) => { if (/^(Collecting|Building|Installing|Successfully)/.test(line)) say(line.slice(0, 200)); } });
    setStatus({ state: 'stopped', message: 'Python environment installed.', python: py });
    return py;
  }

  /* ---------- public object ---------- */

  const engine = {
    /** Start the engine. Idempotent; concurrent calls share one in-flight promise. */
    start() {
      if (startPromise) return startPromise;
      // A running engine stays put whatever its health; the health loop tracks it.
      if (child) return Promise.resolve({ ...status });
      if (installPromise) return installPromise.then(() => engine.start());
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      startPromise = (async () => {
        if (stopPromise) await stopPromise.catch(() => {});
        stopRequested = false;
        try {
          await doStart();
        } catch (e) {
          if (stopRequested) {
            setStatus({ state: 'stopped', message: 'Soul Engine stopped.', ...OFFLINE });
          } else {
            log.error('Soul Engine start failed:', e.message);
            setStatus({ state: 'error', message: e.message, ...OFFLINE });
          }
        } finally {
          startPromise = null;
        }
        return { ...status };
      })();
      return startPromise;
    },

    /** Stop the engine (SIGTERM, then SIGKILL after 5 s). */
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = doStop().finally(() => { stopPromise = null; });
      return stopPromise;
    },

    async restart() {
      await engine.stop();
      restartAttempts = 0;
      return engine.start();
    },

    /** Create the private venv and install the engine's packages, then start it. */
    install() {
      if (installPromise) return installPromise;
      installPromise = (async () => {
        if (child || startPromise) await engine.stop();
        try {
          await doInstall();
        } catch (e) {
          setStatus({ state: 'error', message: `Install failed: ${e.message}`, ...OFFLINE });
          throw e;
        } finally {
          installPromise = null;
        }
        return engine.start();
      })();
      return installPromise;
    },

    status: () => ({ ...status }),
    /** An engine process exists or is being started. */
    isRunning: () => Boolean(child || startPromise),
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isReady: () => status.state === 'ready' && Boolean(child && url && token),
    /** Where and how to reach the running engine; null unless it has been spawned and answered. */
    connection: () => (child && url && token && status.url ? { url, token } : null),
    engineDir,

    /* ---------- model picker and peer updates (new-tab page) ---------- */

    /** The on-device model catalogue plus the active backend and model label. */
    async models() {
      requireConnection();
      const r = await request('/models');
      const models = Array.isArray(r?.models) ? r.models.map(modelEntry).filter(Boolean) : [];
      return { models, current: str(r?.current), provider: str(r?.provider), activeModel: str(r?.activeModel) };
    },

    /**
     * Switch the on-device model (downloads it on first use, which can take many minutes). Only
     * for the edge backend: the engine would otherwise switch backends behind Settings' back.
     */
    async selectModel(id) {
      requireConnection();
      if (soulSettings(settings.get?.()).backend !== 'edge') {
        throw new Error('Choose the on-device backend first: other backends pick their model in Settings');
      }
      const r = await request('/models/select', { method: 'POST', body: { model: String(id) }, timeoutMs: MODEL_SWITCH_TIMEOUT_MS });
      if (r?.ok === false) throw new Error(str(r.error) || 'The Soul Engine could not switch models');
      if (child && !stopRequested) scheduleHealth(0); // show the new model in the status right away
      return engine.models();
    },

    /** Byte progress of a model download in flight ({ active: false } otherwise). */
    async downloadProgress() {
      requireConnection();
      const r = await request('/models/download-progress');
      return {
        active: r?.active === true,
        modelId: str(r?.model_id),
        downloadedBytes: Number(r?.downloaded_bytes) || 0,
        totalBytes: Number(r?.total_bytes) || 0,
      };
    },

    /** Knowledge fragments and adapters trusted peers proposed, waiting for the user's decision. */
    async pendingUpdates() {
      if (!engine.connection()) return [];
      const r = await request('/agent/pending?status=pending');
      return (Array.isArray(r?.updates) ? r.updates : []).map(pendingEntry).filter(Boolean);
    },

    /** Approve (adopt or pin the CID) or deny one pending update. */
    async decideUpdate(id, action) {
      requireConnection();
      if (action !== 'approve' && action !== 'deny') throw new Error('action must be approve or deny');
      const updateId = String(id || '');
      if (!/^[\w-]{1,128}$/.test(updateId)) throw new Error('Invalid update id');
      const r = await request(`/agent/pending/${encodeURIComponent(updateId)}/${action}`, { method: 'POST', timeoutMs: DECIDE_TIMEOUT_MS });
      if (r?.ok === false) throw new Error(str(r.error) || `Could not ${action} the update`);
      return engine.pendingUpdates();
    },
  };

  function requireConnection() {
    if (!engine.connection()) throw new Error('The Soul Engine is not running');
  }


  return engine;
}
