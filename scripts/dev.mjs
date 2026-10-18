#!/usr/bin/env node
// Developer runner: starts the Vite dev server for the chrome (ui/) and, once it answers,
// launches Electron pointed at it. Closing the Electron window, pressing Ctrl+C or the
// dev server dying stops everything.
//
//   npm run dev                      start Vite + Electron
//   npm run dev -- --inspect=9229    extra arguments are passed to Electron
//   node scripts/dev.mjs --check     validate the setup (Electron binary, ui/) and exit
//
// Main-process code (src/main) is not hot-reloaded: restart this script after changing it.
// The chrome (ui/src) hot-reloads through Vite.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = path.join(repoRoot, 'ui');

const DEV_PORT = 1420; // fixed in ui/vite.config.js (strictPort)
const DEV_URL = `http://localhost:${DEV_PORT}`;
/** Only a Vite dev server serves this, so a foreign process holding the port is never mistaken for it. */
const VITE_CLIENT_URL = `${DEV_URL}/@vite/client`;
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 1_000;
const KILL_GRACE_MS = 5_000;

const isWindows = process.platform === 'win32';
const log = (msg) => console.log(`[dev] ${msg}`);
const fail = (msg) => {
  console.error(`[dev] ${msg}`);
  process.exit(1);
};

/* ───────────────────────────── arguments ───────────────────────────── */

const rawArgs = process.argv.slice(2);
const checkOnly = rawArgs.includes('--check');
const wantsHelp = rawArgs.includes('--help') || rawArgs.includes('-h');
const passthrough = rawArgs.filter((a) => a !== '--check' && a !== '--help' && a !== '-h' && a !== '--');

if (wantsHelp) {
  console.log(`Usage: node scripts/dev.mjs [--check] [electron arguments...]

Starts "npm run dev" in ui/ (Vite on ${DEV_URL}, strict port), waits up to ${READY_TIMEOUT_MS / 1000} s for it to answer,
then launches Electron with BUCKS_DEV_URL=${DEV_URL} and BUCKS_DEBUG=1.

  --check   verify that the Electron binary and ui/ are in place, print what would run, exit 0
  -h        show this help

Any other argument is passed to Electron. On Linux, --no-sandbox is added automatically when
running as root (containers, CI).`);
  process.exit(0);
}

/* ───────────────────────────── environment checks ───────────────────────────── */

/**
 * Path of the Electron executable. The npm package "electron" exports it when required from Node.
 * Never triggers a download from here: a missing binary is reported instead.
 * @returns {string}
 */
function resolveElectron() {
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve('electron/package.json'));
  } catch {
    throw new Error('The "electron" package is not installed. Run "npm install" in the repository root.');
  }
  if (!process.env.ELECTRON_OVERRIDE_DIST_PATH && !fs.existsSync(path.join(pkgDir, 'path.txt'))) {
    throw new Error('The Electron binary has not been downloaded. Run "node node_modules/electron/install.js" (or "npm install" again).');
  }
  const bin = require('electron');
  if (typeof bin !== 'string' || !fs.existsSync(bin)) {
    throw new Error(`Electron executable not found at ${String(bin)}. Reinstall it with "npm install".`);
  }
  return bin;
}

/**
 * Check ui/ is a usable Vite project. Returns a list of problems (empty = fine).
 * @returns {string[]}
 */
function checkUiDir() {
  const problems = [];
  if (!fs.existsSync(path.join(uiDir, 'package.json'))) {
    problems.push(`ui/package.json is missing (looked in ${uiDir}).`);
    return problems;
  }
  if (!fs.existsSync(path.join(uiDir, 'node_modules'))) {
    problems.push('ui/node_modules is missing. Run "npm install" in the repository root (its postinstall installs ui/ too) or "npm --prefix ui install".');
  } else if (!fs.existsSync(path.join(uiDir, 'node_modules', 'vite'))) {
    problems.push('Vite is not installed in ui/node_modules. Run "npm --prefix ui install".');
  }
  return problems;
}

/** Arguments for `electron`, with --no-sandbox added for root on Linux (Chromium refuses to run sandboxed as root). */
function electronArgs() {
  const args = ['.'];
  const root = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
  if (root && !passthrough.includes('--no-sandbox')) args.push('--no-sandbox');
  return [...args, ...passthrough];
}

/* ───────────────────────────── helpers ───────────────────────────── */

/** Resolve with the HTTP status code of GET url, or null when nothing answers. */
function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Is a Vite dev server already answering on the dev port? */
async function viteAlreadyRunning() {
  return (await probe(VITE_CLIENT_URL)) === 200;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the Vite dev server answers on the dev port.
 * @param {() => boolean} aborted returns true when the server process has died
 */
async function waitForServer(aborted) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (aborted()) return false;
    if (await viteAlreadyRunning()) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${READY_TIMEOUT_MS / 1000} s waiting for ${DEV_URL}. Is something else using port ${DEV_PORT}?`);
}

/* ───────────────────────────── --check ───────────────────────────── */

if (checkOnly) {
  const problems = [];
  let electronBin = null;
  try {
    electronBin = resolveElectron();
  } catch (e) {
    problems.push(e.message);
  }
  problems.push(...checkUiDir());

  log(`repository root : ${repoRoot}`);
  log(`electron binary : ${electronBin ?? 'NOT FOUND'}`);
  log(`ui directory    : ${uiDir}`);
  log(`would run       : npm run dev (cwd ui/), then ${path.basename(electronBin ?? 'electron')} ${electronArgs().join(' ')}`);
  const portState = (await viteAlreadyRunning()) ? 'a Vite server is already running and will be reused' : (await probe(DEV_URL)) === null ? 'port free' : 'port in use by another program (Vite will refuse to start)';
  log(`dev server      : ${DEV_URL} (${portState})`);

  if (problems.length) {
    for (const p of problems) console.error(`[dev] problem: ${p}`);
    process.exit(1);
  }
  log('OK');
  process.exit(0);
}

/* ───────────────────────────── run ───────────────────────────── */

let electronBin;
try {
  electronBin = resolveElectron();
} catch (e) {
  fail(e.message);
}
const uiProblems = checkUiDir();
if (uiProblems.length) fail(uiProblems.join('\n[dev] '));

/** @type {{ name: string, child: import('node:child_process').ChildProcess, exited: boolean }[]} */
const running = [];
let shuttingDown = false;
let exitCode = 0;

/**
 * Terminate a child and everything it spawned.
 * POSIX: children are started as process-group leaders, so the whole group gets the signal.
 * Windows: taskkill /T takes the tree down.
 */
function terminate(entry, signal = 'SIGTERM') {
  const { child } = entry;
  if (entry.exited || !child.pid) return;
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else if (entry.groupLeader) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // already gone
  }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  for (const entry of running) terminate(entry, 'SIGTERM');
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && running.some((e) => !e.exited)) await sleep(100);
  for (const entry of running) terminate(entry, 'SIGKILL');
  process.exit(exitCode);
}

/** Start a child process and make its exit stop the whole session. */
function launch(name, command, args, options) {
  const child = spawn(command, args, options);
  const entry = { name, child, exited: false, groupLeader: Boolean(options.detached) };
  running.push(entry);
  child.on('error', (e) => {
    entry.exited = true;
    console.error(`[dev] could not start ${name}: ${e.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    entry.exited = true;
    if (shuttingDown) return;
    log(`${name} exited (${signal ? `signal ${signal}` : `code ${code}`})`);
    shutdown(signal ? 1 : (code ?? 0));
  });
  return entry;
}

for (const sig of isWindows ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (!shuttingDown) log(`${sig} received, shutting down`);
    shutdown(0);
  });
}
// Last resort if this process dies abruptly: do not leave Vite behind.
process.on('exit', () => {
  for (const entry of running) terminate(entry, 'SIGKILL');
});

let vite = null;
if (await viteAlreadyRunning()) {
  log(`A Vite server is already running on ${DEV_URL}; reusing it.`);
} else {
  log(`Starting the chrome dev server (npm run dev in ui/) on ${DEV_URL}`);
  vite = launch('vite', 'npm', ['run', 'dev'], {
    cwd: uiDir,
    // stdin is ignored: Vite's interactive shortcuts must not read the terminal of a background group.
    stdio: ['ignore', 'inherit', 'inherit'],
    // npm is npm.cmd on Windows and Node refuses to spawn .cmd files without a shell. The arguments are fixed.
    shell: isWindows,
    detached: !isWindows,
    windowsHide: true,
  });
}

let ready = false;
try {
  ready = await waitForServer(() => vite?.exited === true);
  if (!ready) console.error('[dev] The dev server stopped before it became ready (see its output above).');
} catch (e) {
  console.error(`[dev] ${e.message}`);
}
if (!ready) await shutdown(1);

if (!shuttingDown) {
  log(`Dev server is up. Launching Electron (${path.basename(electronBin)} ${electronArgs().join(' ')})`);
  launch('electron', electronBin, electronArgs(), {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, BUCKS_DEV_URL: DEV_URL, BUCKS_DEBUG: '1' },
  });
}
