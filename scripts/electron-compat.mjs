#!/usr/bin/env node
// Makes node_modules/electron a version this machine can run (see src/main/electron-compat.js).
// Used by scripts/install-macos.sh after `npm install`. Does nothing on Linux, Windows and macOS 13+.
//
//   node scripts/electron-compat.mjs          install the override if one is needed
//   node scripts/electron-compat.mjs --check  print what would happen, change nothing
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronOverrideFor, overrideInstallArgs } from '../src/main/electron-compat.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

function installedElectronVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

let decision;
try {
  decision = electronOverrideFor({ platform: process.platform, release: os.release() });
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(2);
}

if (!decision.override) {
  console.log('Electron: the version from package.json runs on this system.');
  process.exit(0);
}

console.log(decision.reason);
const installed = installedElectronVersion();
if (installed && installed.split('.')[0] === decision.override) {
  console.log(`Electron ${installed} is already installed.`);
  process.exit(0);
}
if (checkOnly) {
  console.log(`Would install electron@${decision.override} (installed: ${installed || 'none'}).`);
  process.exit(0);
}

console.log(`Installing Electron ${decision.override} (installed: ${installed || 'none'})`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, overrideInstallArgs(decision.override), {
  cwd: root,
  stdio: 'inherit',
  // Electron is a devDependency; omit=dev in a user's npm config would otherwise remove the
  // interface build tools while installing the override.
  env: { ...process.env, npm_config_include: 'dev' },
  shell: process.platform === 'win32',
});
if (result.status !== 0) {
  console.error(`error: npm could not install electron@${decision.override}.`);
  process.exit(result.status || 1);
}
const now = installedElectronVersion();
if (!now || now.split('.')[0] !== decision.override) {
  console.error(`error: expected Electron ${decision.override}.x after installing, found ${now || 'nothing'}.`);
  process.exit(1);
}
console.log(`Electron ${now} installed.`);
