#!/usr/bin/env node
// Fetch the Kubo binary used as the embedded IPFS node and place it where electron-builder's
// extraResources picks it up: resources/kubo/<os>-<arch>/ipfs[.exe], where <os> is the
// electron-builder ${os} macro (linux | win | mac).
//
//   node scripts/fetch-kubo.mjs [--platform linux|win32|darwin] [--arch x64|arm64]
//                               [--version vX.Y.Z] [--all-arch] [--force] [--skip-checksum]
//
// Set KUBO_DIST_URL to download from a mirror. HTTPS_PROXY is honoured on Node ≥ 22.21 by
// re-executing with NODE_USE_ENV_PROXY=1 (no proxy library needed).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import {
  downloadKubo,
  latestStableVersion,
  normalizeVersion,
  builderOsName,
  kuboBinaryName,
  FALLBACK_KUBO_VERSION,
  distBaseUrl,
} from '../src/main/ipfs/dist.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const resourcesKubo = path.join(repoRoot, 'resources', 'kubo');

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const proxyVar = PROXY_VARS.find((k) => process.env[k]);

// Node's global fetch ignores proxy env vars unless NODE_USE_ENV_PROXY=1 is set at startup.
// Re-exec ourselves once so the download goes through the configured proxy.
if (proxyVar && !process.env.NODE_USE_ENV_PROXY && !process.env.BUCKS_FETCH_KUBO_REEXEC) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', BUCKS_FETCH_KUBO_REEXEC: '1' },
  });
  process.exit(r.status ?? 1);
}

const { values: opts } = parseArgs({
  options: {
    platform: { type: 'string', default: process.platform },
    arch: { type: 'string', default: process.arch },
    version: { type: 'string' },
    'all-arch': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'skip-checksum': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (opts.help) {
  console.log(`Usage: node scripts/fetch-kubo.mjs [--platform linux|win32|darwin] [--arch x64|arm64] [--version vX.Y.Z] [--all-arch] [--force] [--skip-checksum]
Downloads Kubo from ${distBaseUrl()} into resources/kubo/<os>-<arch>/ (os = linux | win | mac).
Every archive is verified against its published .sha512; --skip-checksum only proceeds with a warning (mirrors without checksums).`);
  process.exit(0);
}

function proxyHint(err) {
  const base = `Download failed: ${err.message}`;
  if (!proxyVar) return base;
  return `${base}\nA proxy is configured via ${proxyVar}. Node's fetch only honours it with NODE_USE_ENV_PROXY=1 (Node >= 22.21 / 24); this script re-executes with that flag, so if it still fails the proxy may be refusing ${distBaseUrl()}. You can also set KUBO_DIST_URL to a mirror you can reach.`;
}

async function main() {
  const platform = String(opts.platform);
  const archesRequested = opts['all-arch'] ? ['x64', 'arm64'] : [String(opts.arch)];
  for (const a of archesRequested) {
    if (!['x64', 'arm64'].includes(a)) throw new Error(`Unsupported --arch ${a} (x64 | arm64)`);
  }
  const osName = builderOsName(platform); // validates the platform
  const binaryName = kuboBinaryName(platform);

  // Decide which versions still need a download before touching the network.
  const targets = archesRequested.map((arch) => ({ arch, dir: path.join(resourcesKubo, `${osName}-${arch}`), file: path.join(resourcesKubo, `${osName}-${arch}`, binaryName) }));
  const pending = targets.filter((t) => opts.force || !fs.existsSync(t.file));
  for (const t of targets) {
    if (!pending.includes(t)) console.log(`✓ ${path.relative(repoRoot, t.file)} already present (use --force to re-download)`);
  }
  if (pending.length === 0) return;

  let version;
  if (opts.version) {
    version = normalizeVersion(opts.version);
  } else {
    try {
      version = await latestStableVersion();
      console.log(`Latest stable Kubo: ${version}`);
    } catch (e) {
      version = FALLBACK_KUBO_VERSION;
      console.warn(`Could not read the Kubo versions list (${e.message}); falling back to ${version}`);
    }
  }

  for (const t of pending) {
    console.log(`Fetching Kubo ${version} for ${platform}/${t.arch} → ${path.relative(repoRoot, t.file)}`);
    let lastShown = -1;
    try {
      await downloadKubo({
        platform,
        arch: t.arch,
        version,
        destDir: t.dir,
        requireChecksum: !opts['skip-checksum'],
        log: { info: (m) => console.log(`  ${m}`), warn: (m) => console.warn(`  warning: ${m}`) },
        onProgress: (received, total) => {
          if (!total || !process.stdout.isTTY) return;
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastShown && pct % 10 === 0) {
            lastShown = pct;
            process.stdout.write(`  ${pct}%\r`);
          }
        },
      });
    } catch (e) {
      throw new Error(proxyHint(e));
    }
    console.log(`✓ installed ${path.relative(repoRoot, t.file)}`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
