// launch.js — Launches Electron by temporarily renaming node_modules/electron
// to prevent require('electron') from resolving to the npm package launcher
// instead of the built-in Electron API.

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const electronPkgDir = path.join(__dirname, 'node_modules', 'electron');
const electronPkgDirRenamed = path.join(__dirname, 'node_modules', '_electron_pkg');
const electronBinary = path.join(electronPkgDir, 'dist', 'electron.exe');

// Read the extra args (e.g. --dev)
const extraArgs = process.argv.slice(2);

// Ensure electron binary exists
if (!fs.existsSync(electronBinary)) {
  console.error('Electron binary not found. Run "npm install" first.');
  process.exit(1);
}

// Rename to avoid module collision
let renamed = false;
try {
  if (fs.existsSync(electronPkgDir) && !fs.existsSync(electronPkgDirRenamed)) {
    fs.renameSync(electronPkgDir, electronPkgDirRenamed);
    renamed = true;
  }
} catch (err) {
  console.error('Warning: Could not rename electron package:', err.message);
}

// Resolve the actual binary path (it's now under _electron_pkg)
const actualBinary = renamed
  ? path.join(electronPkgDirRenamed, 'dist', 'electron.exe')
  : electronBinary;

// Launch Electron
const child = spawn(actualBinary, ['.', ...extraArgs], {
  cwd: __dirname,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  // Restore the renamed directory
  if (renamed && fs.existsSync(electronPkgDirRenamed)) {
    try {
      fs.renameSync(electronPkgDirRenamed, electronPkgDir);
    } catch (err) {
      console.error('Warning: Could not restore electron package:', err.message);
    }
  }
  process.exit(code || 0);
});

child.on('error', (err) => {
  console.error('Failed to start Electron:', err.message);
  // Restore
  if (renamed && fs.existsSync(electronPkgDirRenamed)) {
    try {
      fs.renameSync(electronPkgDirRenamed, electronPkgDir);
    } catch (err2) { /* ignore */ }
  }
  process.exit(1);
});

// Handle termination signals
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    child.kill(signal);
  });
});
