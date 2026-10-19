#!/usr/bin/env node
// Host a site from the command line (docs/IPFS-HOSTING-IMPLEMENTATION.md §15, milestone M1): the
// same sites service, profile and IPFS node as the browser, so what you publish here shows up in
// Bucks and is served at ipfs:// and ipns:// there.
//
//   node scripts/site.mjs inspect <folder> [--spa] [--shell-as-index] [--exclude <path>]…
//   node scripts/site.mjs preview <folder> [fixes]
//   node scripts/site.mjs publish <folder> [--name <name>] [--no-ipns] [fixes]
//   node scripts/site.mjs update <site-id> [--folder <folder>] [--yes] [fixes]
//   node scripts/site.mjs list
//   node scripts/site.mjs status <site-id>
//   node scripts/site.mjs rollback <site-id> <cid>
//   node scripts/site.mjs export-car <site-id> <file.car>
//   node scripts/site.mjs backup-key <site-id> <file.bucks-key>     (passphrase: BUCKS_KEY_PASSPHRASE, or asked)
//   node scripts/site.mjs unpublish <site-id> stop|unpin|delete-key [--confirm <site name>]
//
// Options: --user-data <dir> (default: BUCKS_USER_DATA, else the Bucks profile of this OS user),
//          --offline (start the node without network, when this script starts it).
// When Bucks is running, its node is used and left running; otherwise the script starts the node
// on the Bucks profile and stops it at the end.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createKubo } from '../src/main/ipfs/kubo.js';
import { createIpfsHandler } from '../src/main/protocols/ipfs.js';
import { createSitesService } from '../src/main/sites/service.js';
import { DEFAULT_SETTINGS, deepMerge } from '../src/main/settings-defaults.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'user-data': { type: 'string' },
    offline: { type: 'boolean', default: false },
    name: { type: 'string' },
    'no-ipns': { type: 'boolean', default: false },
    spa: { type: 'boolean', default: false },
    'shell-as-index': { type: 'boolean', default: false },
    exclude: { type: 'string', multiple: true, default: [] },
    folder: { type: 'string' },
    yes: { type: 'boolean', short: 'y', default: false },
    confirm: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const usage = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
const [command, ...args] = positionals;
if (opts.help || !command) {
  console.log(usage);
  process.exit(command || opts.help ? 0 : 1);
}

/** Electron's userData for productName "Bucks Browser". */
function defaultUserData() {
  if (process.env.BUCKS_USER_DATA) return process.env.BUCKS_USER_DATA;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Bucks Browser');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Bucks Browser');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Bucks Browser');
}

function loadSettings(userData) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')); } catch { /* defaults */ }
  const current = deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
  return { get: () => structuredClone(current), onChange: () => () => {} };
}

const fixes = () => ({ useShellAsIndex: opts['shell-as-index'], enableSpa: opts.spa, exclude: opts.exclude });
const mib = (b) => `${(b / (1024 * 1024)).toFixed(2)} MiB`;
const need = (v, what) => {
  if (!v) throw new Error(`Missing ${what}. Run with --help for usage.`);
  return v;
};

function printChecks(checks) {
  if (!checks.length) { console.log('  no problems found'); return; }
  for (const c of checks) {
    const tag = c.level === 'block' ? (c.resolved ? 'handled' : 'BLOCK') : c.level;
    console.log(`  [${tag}] ${c.id}: ${c.message}`);
    for (const f of (c.files || []).slice(0, 5)) console.log(`      ${f.path}${f.line ? `:${f.line}` : ''}${f.kind ? ` (${f.kind})` : ''}`);
    if (c.fix && !c.resolved) console.log(`      fix: ${c.fix.label} (${c.fix.action === 'enable-spa' ? '--spa' : c.fix.action === 'use-shell-as-index' ? '--shell-as-index' : '--exclude <path>'})`);
  }
}

function printDiff(diff) {
  console.log(`  ${diff.counts.added} added, ${diff.counts.changed} changed, ${diff.counts.removed} removed; blocks: ${diff.blocks.new} new, ${diff.blocks.reused} reused`);
  for (const f of diff.added.slice(0, 20)) console.log(`    + ${f.path} (${f.size} B)`);
  for (const f of diff.changed.slice(0, 20)) console.log(`    ~ ${f.path} (${f.previousSize} → ${f.size} B)`);
  for (const f of diff.removed.slice(0, 20)) console.log(`    - ${f.path}`);
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

async function main() {
  const userData = path.resolve(opts['user-data'] || defaultUserData());
  if (opts.offline) process.env.BUCKS_KUBO_OFFLINE = '1';
  const settings = loadSettings(userData);
  const quiet = { info() {}, warn: (...a) => console.warn('warning:', ...a), error: (...a) => console.error(...a), debug() {} };
  // Kubo's own log is noise here (a deliberate stop logs the daemon's exit); failures reject start().
  const kubo = createKubo({ settings, userData, resourcesDir: path.join(repoRoot, 'resources'), log: { ...quiet, warn() {} } });
  const needsNode = !['list'].includes(command);
  let startedHere = false;
  try {
    if (needsNode) {
      process.stdout.write('Starting the IPFS node… ');
      await kubo.start();
      startedHere = kubo.pid() !== null;
      console.log(startedHere ? `started (profile ${userData})` : 'using the node of the running Bucks');
    }
    const handler = createIpfsHandler({ kubo, settings });
    let lastStep = null;
    const sites = createSitesService({
      kubo, settings, userData, handler, log: quiet,
      emit: (p) => {
        if (p.step !== lastStep && p.done === 0) { lastStep = p.step; console.log(`  · ${p.message}`); }
      },
    });
    const folder = async (dir) => {
      const chosen = await sites.registerFolder(path.resolve(need(dir, 'the folder')));
      if (chosen.hints.suggestedDir) console.log(`Using the build output ${chosen.hints.suggestedDir}/${chosen.hints.framework ? ` (${chosen.hints.framework})` : ''}`);
      if (chosen.hints.note) console.log(`Note: ${chosen.hints.note}`);
      return chosen;
    };

    switch (command) {
      case 'inspect': {
        const { token } = await folder(args[0]);
        const r = await sites.inspect({ token, ...fixes() });
        console.log(`${r.folderName}: ${r.files} files, ${mib(r.bytes)}, entry ${r.entry}${r.spa ? ', single-page app' : ''}`);
        printChecks(r.checks);
        console.log(r.blocked ? 'Cannot be published until the blocking problems are fixed.' : 'Ready to publish.');
        if (r.blocked) process.exitCode = 2;
        break;
      }
      case 'preview': {
        const { token } = await folder(args[0]);
        const r = await sites.preview({ token, ...fixes() });
        console.log(`Preview (not published, not pinned): ${r.url}`);
        break;
      }
      case 'publish': {
        const { token } = await folder(args[0]);
        const r = await sites.publish({ token, name: opts.name, ipns: !opts['no-ipns'], ...fixes() });
        printChecks(r.checks);
        console.log(`\nPublished (site id ${r.id})`);
        if (r.urls.ipns) console.log(`  updatable address  ${r.urls.ipns}`);
        console.log(`  this version       ${r.urls.ipfs}`);
        console.log(`  without Bucks      ${r.urls.gatewayIpns || r.urls.gateway}  (public gateway; availability not guaranteed)`);
        console.log(`  announced          ${r.announce.ok ? 'yes' : `not yet (${r.announce.error})`}`);
        if (r.ipns) console.log(`\nBack up the address key now: node scripts/site.mjs backup-key ${r.id} <file>`);
        break;
      }
      case 'update': {
        const id = need(args[0], 'the site id');
        const token = opts.folder ? (await folder(opts.folder)).token : undefined;
        const review = await sites.update({ id, token, ...fixes() });
        if (review.unchanged) { console.log('Nothing changed since the last version.'); break; }
        printChecks(review.checks);
        printDiff(review.diff);
        if (!opts.yes && (await ask('Publish this update? [y/N] ')).trim().toLowerCase() !== 'y') { console.log('Not published.'); break; }
        const r = await sites.update({ id, token, ...fixes(), confirm: true, expectCid: review.cid });
        console.log(`Updated: ${r.urls.ipfs}${r.urls.ipns ? `\n${r.urls.ipns} now serves it.` : ''}`);
        break;
      }
      case 'list': {
        const list = sites.list();
        if (!list.length) console.log('No sites yet.');
        for (const s of list) console.log(`${s.id}  ${s.name}\n    ${s.urls.ipns || '(no ipns address)'}\n    ${s.urls.ipfs || '(not published)'}  ${s.history.length} version(s)${s.ipns && !s.keyBackedUp ? '  — key not backed up' : ''}`);
        break;
      }
      case 'status': {
        const h = await sites.status({ id: need(args[0], 'the site id') });
        console.log(`${h.state || 'unavailable'}: ${h.label}`);
        for (const c of h.checks) console.log(`  ${c.ok === null ? '–' : c.ok ? '✓' : '✗'} ${c.id}: ${c.detail}`);
        break;
      }
      case 'rollback':
        console.log(`Rolled back to ${(await sites.rollback({ id: need(args[0], 'the site id'), cid: need(args[1], 'the cid') })).cid}`);
        break;
      case 'export-car': {
        const r = await sites.exportCar({ id: need(args[0], 'the site id'), file: path.resolve(need(args[1], 'the CAR file')) });
        console.log(`Wrote ${r.path} (${mib(r.bytes)}, root ${r.cid})`);
        break;
      }
      case 'backup-key': {
        const id = need(args[0], 'the site id');
        const file = path.resolve(need(args[1], 'the backup file'));
        const passphrase = process.env.BUCKS_KEY_PASSPHRASE || await ask('Passphrase for the backup (at least 10 characters): ', { hidden: true });
        await sites.backupKey({ id, passphrase, file });
        console.log(`Key backed up to ${file}. Keep the file and the passphrase: without both, the address can never be updated again.`);
        break;
      }
      case 'unpublish':
        await sites.unpublish({ id: need(args[0], 'the site id'), mode: need(args[1], 'the mode (stop, unpin, delete-key)'), confirm: opts.confirm });
        console.log('Done.');
        break;
      default:
        throw new Error(`Unknown command "${command}". Run with --help for usage.`);
    }
  } finally {
    // Never stop a node that belongs to a running Bucks.
    if (startedHere) await kubo.stop();
  }
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  if (e.checks) printChecks(e.checks);
  process.exit(1);
});
