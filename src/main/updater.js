// In-app updater: checks the git remote for new commits and, on explicit request,
// pulls them, reinstalls dependencies, rebuilds the interface and restarts the app.
// Only works when Bucks runs from a git checkout (developer and test installs).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { createLogger } from './log.js';
import { decideInstall, installPlan, isValidBranch, parseAheadBehind, parseDirty } from './updater-core.js';
import { electronOverrideFor } from './electron-compat.js';

const log = createLogger('updater');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function exec(cmd, args, { cwd, timeout }) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        // npm.cmd on Windows must run through the shell; the arguments are fixed, never user input.
        shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim().slice(0, 500);
          reject(new Error(`${cmd} ${args.join(' ')} failed: ${detail}`));
        } else {
          resolve(String(stdout).trim());
        }
      },
    );
  });
}

const git = (root, args) => exec('git', args, { cwd: root, timeout: 60_000 });

async function readStatus(root) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    return { supported: false, reason: 'Updates are only available when Bucks runs from a git checkout.' };
  }
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD' || !isValidBranch(branch)) {
    return { supported: false, reason: 'This checkout is on a detached HEAD. Switch to a branch to receive updates.' };
  }
  const head = await git(root, ['rev-parse', 'HEAD']);
  const subject = await git(root, ['log', '-1', '--format=%s']);
  const dirty = parseDirty(await git(root, ['status', '--porcelain', '--untracked-files=no']));

  let ahead = 0;
  let behind = 0;
  let remoteSubject = null;
  const hasRemote = await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).then(
    () => true,
    () => false,
  );
  if (hasRemote) {
    ({ ahead, behind } = parseAheadBehind(await git(root, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`])));
    remoteSubject = await git(root, ['log', '-1', '--format=%s', `origin/${branch}`]);
  }

  return {
    supported: true,
    branch,
    head: head.slice(0, 12),
    subject,
    dirty,
    ahead,
    behind,
    remoteSubject,
    remoteAvailable: hasRemote,
    checkedAt: Date.now(),
  };
}

/** Creates the updater and registers its IPC channels. Returns the programmatic API. */
export function registerUpdater({ root, getMainWindow }) {
  let busy = false;

  const emit = (event) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('bucks:updater:progress', event);
  };

  async function status() {
    return readStatus(root);
  }

  /** Fetches the remote branch and returns the fresh status. Never changes the working tree. */
  async function check() {
    const base = await readStatus(root);
    if (!base.supported) return base;
    await git(root, ['fetch', '--quiet', 'origin', base.branch]);
    return readStatus(root);
  }

  async function install() {
    if (busy) throw new Error('An update is already running.');
    busy = true;
    try {
      const before = await check();
      const decision = decideInstall(before);
      if (!decision.ok) throw new Error(decision.reason);
      if (!decision.updateAvailable) return { updated: false, message: decision.reason, status: before };

      log.info(`updating ${before.branch} from ${before.head} (${decision.reason})`);
      let electronOverride = null;
      try {
        electronOverride = electronOverrideFor({ platform: process.platform, release: os.release() }).override;
      } catch {
        // Too old to run any supported Electron: this app could not be running, keep the default plan.
      }
      for (const step of installPlan({ branch: before.branch, npmCommand, electronOverride })) {
        emit({ step: step.id, state: 'running', message: step.label });
        try {
          await exec(step.cmd, step.args, { cwd: root, timeout: step.timeout });
        } catch (e) {
          emit({ step: step.id, state: 'failed', message: e.message });
          throw e;
        }
        emit({ step: step.id, state: 'done', message: step.label });
      }

      const after = await readStatus(root);
      log.info(`updated to ${after.head}: ${after.subject}`);
      return { updated: true, from: before.head, to: after.head, subject: after.subject, message: 'Update installed. Restart Bucks to use it.' };
    } finally {
      busy = false;
    }
  }

  ipcMain.handle('bucks:updater:status', () => status());
  ipcMain.handle('bucks:updater:check', () => check());
  ipcMain.handle('bucks:updater:install', () => install());
  ipcMain.handle('bucks:updater:restart', () => {
    if (busy) throw new Error('Wait for the update to finish before restarting.');
    app.relaunch();
    app.exit(0);
  });

  return { status, check, install };
}
