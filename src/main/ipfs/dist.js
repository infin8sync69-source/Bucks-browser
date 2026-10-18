// Kubo distribution helpers shared by the runtime (kubo.js) and scripts/fetch-kubo.mjs.
// Pure Node: no Electron imports. Downloads try an ordered list of mirrors (see kuboMirrors):
// env KUBO_DIST_URL (a dist.ipfs.tech-style mirror or local file server), then
// https://dist.ipfs.tech/kubo, then GitHub releases. Every mirror publishes the same asset
// names (kubo_<version>_<os>-<arch>.tar.gz, .zip on Windows) with a .sha512 next to each, and an
// archive is only ever verified against the checksum from the SAME mirror.

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
/** GitHub releases of ipfs/kubo (assets at <url>/download/<version>/<asset>). */
export const GITHUB_RELEASES_URL = 'https://github.com/ipfs/kubo/releases';
/** Used when no mirror can tell us the latest stable version. */
export const FALLBACK_KUBO_VERSION = 'v0.43.1';

const STABLE_VERSION_RE = /^v\d+\.\d+\.\d+$/;
const VERSION_TIMEOUT_MS = 15_000;
const CHECKSUM_TIMEOUT_MS = 30_000;
const ARCHIVE_HEADERS_TIMEOUT_MS = 30_000; // time to first byte of the archive response
const ARCHIVE_IDLE_TIMEOUT_MS = 60_000; // max gap between body chunks
const ARCHIVE_TOTAL_TIMEOUT_MS = 15 * 60_000;

function trimBase(url) {
  return String(url).trim().replace(/\/+$/, '');
}

/** Base URL of the dist.ipfs.tech-style distribution site (explicit override, then env KUBO_DIST_URL, then the default). */
export function distBaseUrl(override) {
  return trimBase(override || process.env.KUBO_DIST_URL || DEFAULT_DIST_BASE_URL);
}

/**
 * Ordered list of Kubo download mirrors, deduplicated:
 *   1. `baseUrl` (explicit override, dist layout) when given
 *   2. env KUBO_DIST_URL (dist layout) when set
 *   3. https://dist.ipfs.tech/kubo
 *   4. GitHub releases (https://github.com/ipfs/kubo/releases)
 * @param {{ baseUrl?: string, env?: Record<string, string|undefined> }} [opts]
 * @returns {Array<{ id: 'custom'|'env'|'dist'|'github', kind: 'dist'|'github', label: string, baseUrl: string }>}
 */
export function kuboMirrors({ baseUrl, env = process.env } = {}) {
  const out = [];
  const add = (m) => {
    if (!out.some((x) => x.kind === m.kind && x.baseUrl === m.baseUrl)) out.push(m);
  };
  if (baseUrl && String(baseUrl).trim()) {
    const b = trimBase(baseUrl);
    add({ id: 'custom', kind: 'dist', label: b, baseUrl: b });
  }
  if (env?.KUBO_DIST_URL && String(env.KUBO_DIST_URL).trim()) {
    const b = trimBase(env.KUBO_DIST_URL);
    add({ id: 'env', kind: 'dist', label: `KUBO_DIST_URL (${b})`, baseUrl: b });
  }
  add({ id: 'dist', kind: 'dist', label: 'dist.ipfs.tech', baseUrl: DEFAULT_DIST_BASE_URL });
  add({ id: 'github', kind: 'github', label: 'GitHub releases', baseUrl: GITHUB_RELEASES_URL });
  return out;
}

/**
 * URLs of a release asset and its checksum on one mirror.
 * @param {{ kind: 'dist'|'github', baseUrl: string }} mirror
 * @param {string} version  vX.Y.Z
 * @param {string} archiveName  e.g. kubo_v0.43.1_darwin-arm64.tar.gz
 * @returns {{ url: string, sha512Url: string }}
 */
export function mirrorAssetUrls(mirror, version, archiveName) {
  const v = normalizeVersion(version);
  const base = trimBase(mirror.baseUrl);
  const url = mirror.kind === 'github' ? `${base}/download/${v}/${archiveName}` : `${base}/${v}/${archiveName}`;
  return { url, sha512Url: `${url}.sha512` };
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

/** Normalise a version string to the vX.Y.Z form Kubo releases use. */
export function normalizeVersion(version) {
  const v = String(version || '').trim();
  if (!v) throw new Error('Kubo version is required');
  const withV = v.startsWith('v') ? v : `v${v}`;
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(withV)) throw new Error(`Invalid Kubo version: ${version}`);
  return withV;
}

/**
 * Resolve a Kubo release asset (names, plus URLs on the dist.ipfs.tech-style `baseUrl`).
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
  const url = `${distBaseUrl(baseUrl)}/${v}/${archiveName}`;
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
 * Extract the stable version from GitHub's /releases/latest redirect target
 * (…/ipfs/kubo/releases/tag/vX.Y.Z) or, failing that, from the release page's canonical link.
 * @param {string} url  final response URL
 * @param {string} [html]  response body
 * @returns {string|null}
 */
export function parseGithubLatestTag(url, html = '') {
  const fromUrl = /\/releases\/tag\/(v\d+\.\d+\.\d+)(?:[/?#]|$)/.exec(String(url || ''));
  if (fromUrl) return fromUrl[1];
  const fromHtml = /github\.com\/ipfs\/kubo\/releases\/tag\/(v\d+\.\d+\.\d+)["'?#/]/.exec(String(html || ''));
  return fromHtml ? fromHtml[1] : null;
}

/** Readable reason for a failed fetch (undici puts the real cause in err.cause). */
function describeFetchError(e, timeoutMs) {
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (e?.name === 'AbortError' && e?.cause?.message) return e.cause.message;
  const cause = e?.cause?.message || e?.cause?.code;
  const msg = e?.message || String(e);
  return cause && cause !== msg ? `${msg} (${cause})` : msg;
}

async function fetchText(fetchImpl, url, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (e) {
    const err = new Error(describeFetchError(e, timeoutMs));
    err.network = true;
    throw err;
  }
  const text = await res.text().catch(() => '');
  return { res, text };
}

/**
 * Find the latest stable Kubo version: the `versions` list of each dist-style mirror first, then
 * GitHub's /releases/latest redirect. Throws (listing every source tried) when none answers; the
 * caller is expected to fall back to FALLBACK_KUBO_VERSION.
 * @param {typeof fetch} [fetchImpl]
 * @param {{ baseUrl?: string, timeoutMs?: number, env?: object, mirrors?: ReturnType<typeof kuboMirrors> }} [opts]
 * @returns {Promise<string>} e.g. 'v0.43.1'
 */
export async function latestStableVersion(fetchImpl = globalThis.fetch, { baseUrl, timeoutMs = VERSION_TIMEOUT_MS, env, mirrors } = {}) {
  const list = mirrors || kuboMirrors({ baseUrl, env });
  const failures = [];
  for (const m of list) {
    const url = m.kind === 'github' ? `${trimBase(m.baseUrl)}/latest` : `${trimBase(m.baseUrl)}/versions`;
    try {
      const { res, text } = await fetchText(fetchImpl, url, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const v = m.kind === 'github' ? parseGithubLatestTag(res.url, text) : parseLatestStableVersion(text);
      if (!v) throw new Error(m.kind === 'github' ? `no release tag in ${res.url || url}` : 'no stable version listed');
      return v;
    } catch (e) {
      failures.push(`${m.label} (${url}): ${e.message}`);
    }
  }
  throw new Error(`Could not determine the latest Kubo version: ${failures.join('; ')}`);
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

/**
 * Stream `url` into `file` with a headers timeout, an idle (stall) timeout and an overall cap,
 * so an unreachable or stalled mirror fails fast and the next one is tried.
 */
async function downloadToFile(fetchImpl, url, file, { onProgress } = {}) {
  const ctrl = new AbortController();
  const abortWith = (why) => ctrl.abort(Object.assign(new Error(why), { name: 'TimeoutError' }));
  const total = setTimeout(() => abortWith(`timed out after ${ARCHIVE_TOTAL_TIMEOUT_MS / 60_000} min`), ARCHIVE_TOTAL_TIMEOUT_MS);
  let idle = setTimeout(() => abortWith(`no response within ${ARCHIVE_HEADERS_TIMEOUT_MS / 1000}s`), ARCHIVE_HEADERS_TIMEOUT_MS);
  const bumpIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => abortWith(`download stalled for ${ARCHIVE_IDLE_TIMEOUT_MS / 1000}s`), ARCHIVE_IDLE_TIMEOUT_MS);
  };
  const reason = (e) => (ctrl.signal.aborted && ctrl.signal.reason?.message) || describeFetchError(e, ARCHIVE_HEADERS_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' });
    } catch (e) {
      const err = new Error(reason(e));
      err.network = true;
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    if (!res.body) throw new Error(`empty response body from ${url}`);
    bumpIdle();
    const totalBytes = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.on('data', (chunk) => {
      received += chunk.length;
      bumpIdle();
      if (onProgress) onProgress(received, totalBytes);
    });
    try {
      await pipeline(nodeStream, fs.createWriteStream(file));
    } catch (e) {
      throw new Error(`download of ${url} failed: ${reason(e)}`);
    }
    if (totalBytes && received !== totalBytes) throw new Error(`download of ${url} was truncated (${received} of ${totalBytes} bytes)`);
    return received;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
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
 * Fetch, verify and extract the asset from ONE mirror into `work`; returns the extracted binary.
 * Throws with a short reason when this mirror cannot provide a verified archive.
 */
async function fetchFromMirror({ mirror, asset, work, fetchImpl, requireChecksum, onProgress, info, warn }) {
  const { url, sha512Url } = mirrorAssetUrls(mirror, asset.version, asset.archiveName);

  // Checksum first: it is tiny, so an unreachable mirror fails in seconds, not after a 40 MB download.
  let expected = null;
  let checksumProblem = null;
  const { res, text } = await fetchText(fetchImpl, sha512Url, CHECKSUM_TIMEOUT_MS).catch((e) => {
    throw new Error(`could not reach ${sha512Url}: ${e.message}`);
  });
  if (res.ok) {
    expected = parseChecksumFile(text);
    if (!expected) checksumProblem = `${sha512Url} did not contain a SHA-512 digest`;
  } else {
    checksumProblem = `no checksum available for ${asset.archiveName} (HTTP ${res.status} from ${sha512Url})`;
  }
  if (!expected && requireChecksum) throw new Error(`${checksumProblem}; refusing to install an unverified binary`);

  const dir = path.join(work, mirror.id);
  await fsp.mkdir(dir, { recursive: true });
  const archivePath = path.join(dir, asset.archiveName);
  info(`Downloading ${url}`);
  await downloadToFile(fetchImpl, url, archivePath, { onProgress });

  if (expected) {
    const actual = await sha512OfFile(archivePath);
    if (actual !== expected) {
      throw new Error(`SHA-512 mismatch for ${asset.archiveName}: expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…`);
    }
    info(`Checksum verified (${mirror.label})`);
  } else {
    warn(`${checksumProblem}; skipping verification`);
  }

  const extractDir = path.join(dir, 'extract');
  await fsp.mkdir(extractDir, { recursive: true });
  try {
    if (asset.archiveName.endsWith('.zip')) await extractZip(archivePath, { dir: extractDir });
    else await tar.x({ file: archivePath, cwd: extractDir, preserveOwner: false });
  } catch (e) {
    throw new Error(`could not extract ${asset.archiveName}: ${e.message}`);
  }
  const found = await findFile(extractDir, asset.binaryName);
  if (!found) throw new Error(`${asset.archiveName} did not contain kubo/${asset.binaryName}`);
  return { found, url };
}

/**
 * Download, verify and extract a Kubo release, trying each mirror in order (kuboMirrors) until
 * one yields a verified archive. A checksum mismatch, a missing required checksum, an HTTP error
 * or a network failure moves on to the next mirror; when every mirror fails, one Error lists each
 * mirror with its reason (and `err.attempts` holds them as data).
 * @param {{
 *   platform?: string, arch?: string, version: string, destDir: string,
 *   fetchImpl?: typeof fetch, log?: { info?: Function, warn?: Function }, baseUrl?: string,
 *   env?: object, mirrors?: ReturnType<typeof kuboMirrors>,
 *   onProgress?: (received: number, total: number) => void,
 *   onMirror?: (event: { mirror: object, url?: string, ok: boolean, error?: string }) => void,
 *   requireChecksum?: boolean   // default true: a mirror without <archive>.sha512 is skipped
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
  env,
  mirrors,
  onProgress,
  onMirror,
  requireChecksum = true,
}) {
  if (!destDir) throw new Error('downloadKubo: destDir is required');
  if (typeof fetchImpl !== 'function') throw new Error('downloadKubo: no fetch implementation available');
  const info = (...a) => log.info?.(...a);
  const warn = (...a) => log.warn?.(...a);
  const asset = resolveKuboAsset({ platform, arch, version, baseUrl });
  const list = mirrors || kuboMirrors({ baseUrl, env });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-kubo-'));
  const attempts = [];
  try {
    for (const mirror of list) {
      info(`Trying ${mirror.label}`);
      let result;
      try {
        result = await fetchFromMirror({ mirror, asset, work, fetchImpl, requireChecksum, onProgress, info, warn });
      } catch (e) {
        const reason = e?.message || String(e);
        attempts.push({ mirror: mirror.label, id: mirror.id, reason });
        warn(`${mirror.label} failed: ${reason}`);
        onMirror?.({ mirror, ok: false, error: reason });
        await fsp.rm(path.join(work, mirror.id), { recursive: true, force: true }).catch(() => {});
        continue;
      }

      await fsp.mkdir(destDir, { recursive: true });
      const dest = path.join(destDir, asset.binaryName);
      const tmpDest = `${dest}.${process.pid}.tmp`;
      await fsp.copyFile(result.found, tmpDest);
      if (platform !== 'win32') await fsp.chmod(tmpDest, 0o755);
      await fsp.rm(dest, { force: true });
      await fsp.rename(tmpDest, dest);
      onMirror?.({ mirror, url: result.url, ok: true });
      info(`Installed Kubo ${asset.version} from ${mirror.label} to ${dest}`);
      return dest;
    }
    const err = new Error(`Could not download Kubo ${asset.version} (${asset.archiveName}) from any mirror: ${attempts.map((a) => `${a.mirror}: ${a.reason}`).join('; ')}`);
    err.attempts = attempts;
    throw err;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
