// Kubo distribution helpers shared by the runtime (kubo.js) and scripts/fetch-kubo.mjs.
// Pure Node: no Electron imports. Downloads come from https://dist.ipfs.tech/kubo
// (override with env KUBO_DIST_URL, e.g. a mirror or a local file server).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import extractZip from 'extract-zip';

export const DEFAULT_DIST_BASE_URL = 'https://dist.ipfs.tech/kubo';
/** Used when the versions list cannot be fetched. */
export const FALLBACK_KUBO_VERSION = 'v0.43.1';

const STABLE_VERSION_RE = /^v\d+\.\d+\.\d+$/;

/** Base URL of the Kubo distribution site (env KUBO_DIST_URL wins). */
export function distBaseUrl(override) {
  const v = override || process.env.KUBO_DIST_URL || DEFAULT_DIST_BASE_URL;
  return String(v).trim().replace(/\/+$/, '');
}

/** Name of the Kubo executable for a platform. */
export function kuboBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'ipfs.exe' : 'ipfs';
}

/** electron-builder ${os} macro value for a Node platform string (used for resources/kubo/<os>-<arch>). */
export function builderOsName(platform) {
  switch (platform) {
    case 'linux': return 'linux';
    case 'win32': return 'win';
    case 'darwin': return 'mac';
    default: throw new Error(`Unsupported platform for Kubo: ${platform}`);
  }
}

/** Normalise a version string to the vX.Y.Z form dist.ipfs.tech uses. */
export function normalizeVersion(version) {
  const v = String(version || '').trim();
  if (!v) throw new Error('Kubo version is required');
  const withV = v.startsWith('v') ? v : `v${v}`;
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(withV)) throw new Error(`Invalid Kubo version: ${version}`);
  return withV;
}

/**
 * Resolve the download URL for a Kubo release asset.
 * @param {{ platform: 'linux'|'darwin'|'win32', arch: 'x64'|'arm64', version: string, baseUrl?: string }} opts
 * @returns {{ url: string, archiveName: string, sha512Url: string, version: string, binaryName: string }}
 */
export function resolveKuboAsset({ platform, arch, version, baseUrl }) {
  const osName = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[platform];
  if (!osName) throw new Error(`Unsupported platform for Kubo: ${platform}`);
  const archName = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!archName) throw new Error(`Unsupported architecture for Kubo: ${arch}`);
  const v = normalizeVersion(version);
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const archiveName = `kubo_${v}_${osName}-${archName}.${ext}`;
  const base = distBaseUrl(baseUrl);
  const url = `${base}/${v}/${archiveName}`;
  return { url, archiveName, sha512Url: `${url}.sha512`, version: v, binaryName: kuboBinaryName(platform) };
}

/**
 * Parse the dist.ipfs.tech `versions` listing: the last line matching vX.Y.Z is the latest stable.
 * @param {string} text
 * @returns {string|null}
 */
export function parseLatestStableVersion(text) {
  let latest = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (STABLE_VERSION_RE.test(line)) latest = line;
  }
  return latest;
}

/**
 * Fetch the latest stable Kubo version from the distribution site.
 * @param {typeof fetch} [fetchImpl]
 * @param {{ baseUrl?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<string>} e.g. 'v0.43.1'
 */
export async function latestStableVersion(fetchImpl = globalThis.fetch, { baseUrl, timeoutMs = 15_000 } = {}) {
  const url = `${distBaseUrl(baseUrl)}/versions`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Could not fetch ${url}: HTTP ${res.status}`);
  const text = await res.text();
  const v = parseLatestStableVersion(text);
  if (!v) throw new Error(`${url} did not list a stable Kubo version`);
  return v;
}

/** Parse "<hex>  <filename>" style checksum files; returns the hex digest. */
export function parseChecksumFile(text) {
  const first = String(text).trim().split(/\s+/)[0] || '';
  return /^[0-9a-f]{128}$/i.test(first) ? first.toLowerCase() : null;
}

async function sha512OfFile(file) {
  const hash = createHash('sha512');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function downloadToFile(fetchImpl, url, file, { onProgress, timeoutMs = 10 * 60_000 } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed for ${url}: HTTP ${res.status}`);
  if (!res.body) throw new Error(`Download failed for ${url}: empty body`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const nodeStream = Readable.fromWeb(res.body);
  nodeStream.on('data', (chunk) => {
    received += chunk.length;
    if (onProgress) onProgress(received, total);
  });
  await pipeline(nodeStream, fs.createWriteStream(file));
  return received;
}

/** Depth-first search for a file called `name` under `dir`. */
async function findFile(dir, name) {
  const direct = path.join(dir, 'kubo', name);
  if (fs.existsSync(direct)) return direct;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name === name) return p;
    }
  }
  return null;
}

/**
 * Download, verify and extract a Kubo release; returns the path of the installed binary.
 * @param {{
 *   platform?: string, arch?: string, version: string, destDir: string,
 *   fetchImpl?: typeof fetch, log?: { info?: Function, warn?: Function }, baseUrl?: string,
 *   onProgress?: (received: number, total: number) => void
 * }} opts
 * @returns {Promise<string>} absolute path to <destDir>/ipfs[.exe]
 */
export async function downloadKubo({
  platform = process.platform,
  arch = process.arch,
  version,
  destDir,
  fetchImpl = globalThis.fetch,
  log = {},
  baseUrl,
  onProgress,
}) {
  if (!destDir) throw new Error('downloadKubo: destDir is required');
  const info = (...a) => log.info?.(...a);
  const warn = (...a) => log.warn?.(...a);
  const asset = resolveKuboAsset({ platform, arch, version, baseUrl });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-kubo-'));
  try {
    const archivePath = path.join(work, asset.archiveName);
    info(`Downloading ${asset.url}`);
    await downloadToFile(fetchImpl, asset.url, archivePath, { onProgress });

    // Integrity: dist.ipfs.tech publishes <archive>.sha512 next to every asset.
    let expected = null;
    try {
      const res = await fetchImpl(asset.sha512Url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) expected = parseChecksumFile(await res.text());
      else warn(`No checksum available for ${asset.archiveName} (HTTP ${res.status}); skipping verification`);
    } catch (e) {
      warn(`Could not fetch checksum for ${asset.archiveName}: ${e.message}; skipping verification`);
    }
    if (expected) {
      const actual = await sha512OfFile(archivePath);
      if (actual !== expected) {
        throw new Error(`SHA-512 mismatch for ${asset.archiveName}: expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…`);
      }
      info('Checksum verified');
    }

    const extractDir = path.join(work, 'extract');
    await fsp.mkdir(extractDir, { recursive: true });
    if (asset.archiveName.endsWith('.zip')) {
      await extractZip(archivePath, { dir: extractDir });
    } else {
      await tar.x({ file: archivePath, cwd: extractDir });
    }

    const found = await findFile(extractDir, asset.binaryName);
    if (!found) throw new Error(`${asset.archiveName} did not contain kubo/${asset.binaryName}`);

    await fsp.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, asset.binaryName);
    const tmpDest = `${dest}.${process.pid}.tmp`;
    await fsp.copyFile(found, tmpDest);
    if (platform !== 'win32') await fsp.chmod(tmpDest, 0o755);
    await fsp.rm(dest, { force: true });
    await fsp.rename(tmpDest, dest);
    info(`Installed Kubo ${asset.version} to ${dest}`);
    return dest;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
