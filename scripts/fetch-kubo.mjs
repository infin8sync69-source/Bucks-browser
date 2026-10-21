#!/usr/bin/env node
// Fetch the Kubo binary used as the embedded IPFS node and place it where electron-builder's
// extraResources picks it up: resources/kubo/<os>-<arch>/ipfs[.exe], where <os> is the
// electron-builder ${os} macro (linux | win | mac).
//
//   node scripts/fetch-kubo.mjs [--platform linux|win32|darwin] [--arch x64|arm64]
//                               [--version vX.Y.Z] [--all-arch] [--force] [--skip-checksum]
//                               [--out-dir <dir>]   (default resources/kubo; same <os>-<arch> layout)
//                               [--check-latest]    (only report whether a newer Kubo exists)
//
// The version defaults to PINNED_KUBO_VERSION (src/main/ipfs/dist.js), whose archives are verified
// against the SHA-512 digests built into the repository. Another --version is verified against the
// .sha512 of the mirror it came from only, and says so. Mirrors are tried in order: env KUBO_DIST_URL
// (dist.ipfs.tech layout), https://dist.ipfs.tech/kubo, then GitHub releases.
// HTTPS_PROXY is honoured on Node ≥ 22.21 by re-executing with NODE_USE_ENV_PROXY=1 (no proxy
// library needed).

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
  PINNED_KUBO_VERSION,
  pinnedSha512,
  kuboMirrors,
} from '../src/main/ipfs/dist.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const defaultOutDir = path.join(repoRoot, 'resources', 'kubo');

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
    'out-dir': { type: 'string' },
    'check-latest': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (opts.help) {
  console.log(`Usage: node scripts/fetch-kubo.mjs [--platform linux|win32|darwin] [--arch x64|arm64] [--version vX.Y.Z] [--all-arch] [--force] [--skip-checksum] [--out-dir <dir>] [--check-latest]
Downloads Kubo ${PINNED_KUBO_VERSION} (the pinned version, verified against the SHA-512 digests built into Bucks) into
resources/kubo/<os>-<arch>/ (os = linux | win | mac; --out-dir replaces resources/kubo), trying these mirrors in order:
${kuboMirrors().map((m, i) => `  ${i + 1}. ${m.label}: ${m.baseUrl}`).join('\n')}
Set KUBO_DIST_URL to put your own mirror (dist.ipfs.tech layout) first.
Every archive is verified against the .sha512 published by the same mirror; --skip-checksum only proceeds with a warning (mirrors without checksums).`);
  process.exit(0);
}

/** Repo-relative path for files under the repo, absolute otherwise. */
function shown(file) {
  const rel = path.relative(repoRoot, file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
}

function failureReport(err) {
  const lines = [];
  if (Array.isArray(err.attempts) && err.attempts.length) {
    lines.push('Download failed: no mirror could provide a verified Kubo archive.');
    for (const a of err.attempts) lines.push(`  - ${a.mirror}: ${a.reason}`);
  } else {
    lines.push(`Download failed: ${err.message}`);
  }
  if (proxyVar) {
    lines.push(`A proxy is configured via ${proxyVar}. Node's fetch only honours it with NODE_USE_ENV_PROXY=1 (Node >= 22.21 / 24); this script re-executes with that flag, so if it still fails the proxy may be refusing these hosts.`);
  }
  lines.push('Set KUBO_DIST_URL to a mirror you can reach (same layout as https://dist.ipfs.tech/kubo), or place the binary at the path above by hand.');
  return lines.join('\n');
}

async function main() {
  if (opts['check-latest']) {
    const latest = await latestStableVersion();
    console.log(latest === PINNED_KUBO_VERSION
      ? `Pinned Kubo ${PINNED_KUBO_VERSION} is the latest stable release.`
      : `Pinned Kubo is ${PINNED_KUBO_VERSION}; the latest stable release is ${latest}. Update PINNED_KUBO_VERSION and PINNED_KUBO_SHA512 in src/main/ipfs/dist.js deliberately.`);
    return;
  }
  const platform = String(opts.platform);
  const archesRequested = opts['all-arch'] ? ['x64', 'arm64'] : [String(opts.arch)];
  for (const a of archesRequested) {
    if (!['x64', 'arm64'].includes(a)) throw new Error(`Unsupported --arch ${a} (x64 | arm64)`);
  }
  const osName = builderOsName(platform); // validates the platform
  const binaryName = kuboBinaryName(platform);
  const resourcesKubo = opts['out-dir'] ? path.resolve(String(opts['out-dir'])) : defaultOutDir;

  // Decide which versions still need a download before touching the network.
  const targets = archesRequested.map((arch) => ({ arch, dir: path.join(resourcesKubo, `${osName}-${arch}`), file: path.join(resourcesKubo, `${osName}-${arch}`, binaryName) }));
  const pending = targets.filter((t) => opts.force || !fs.existsSync(t.file));
  for (const t of targets) {
    if (!pending.includes(t)) console.log(`✓ ${shown(t.file)} already present (use --force to re-download)`);
  }
  if (pending.length === 0) return;

  const version = opts.version ? normalizeVersion(opts.version) : PINNED_KUBO_VERSION;
  if (version !== PINNED_KUBO_VERSION) {
    console.warn(`warning: Kubo ${version} is not the pinned ${PINNED_KUBO_VERSION}; it is verified only against its mirror's own .sha512`);
  }

  for (const t of pending) {
    console.log(`Fetching Kubo ${version} for ${platform}/${t.arch} → ${shown(t.file)}`);
    let lastShown = -1;
    try {
      await downloadKubo({
        platform,
        arch: t.arch,
        version,
        destDir: t.dir,
        requireChecksum: !opts['skip-checksum'],
        expectedSha512: pinnedSha512({ platform, arch: t.arch, version }),
        log: { info: (m) => console.log(`  ${m}`), warn: (m) => console.warn(`  warning: ${m}`) },
        onMirror: ({ mirror, url, ok }) => {
          if (ok) console.log(`  mirror used: ${mirror.label} (${url})`);
        },
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
      throw new Error(failureReport(e));
    }
    console.log(`✓ installed ${shown(t.file)}`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
