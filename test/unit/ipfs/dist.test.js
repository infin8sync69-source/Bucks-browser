import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import * as tar from 'tar';
import {
  resolveKuboAsset,
  parseLatestStableVersion,
  latestStableVersion,
  downloadKubo,
  normalizeVersion,
  builderOsName,
  kuboBinaryName,
  parseChecksumFile,
  distBaseUrl,
  kuboMirrors,
  mirrorAssetUrls,
  parseGithubLatestTag,
  FALLBACK_KUBO_VERSION,
} from '../../../src/main/ipfs/dist.js';

/** Only the mirror under test, so a fake fetch never sees the real dist/GitHub URLs. */
const ONLY = (baseUrl) => [{ id: 'custom', kind: 'dist', label: baseUrl, baseUrl }];

const VERSIONS = `v0.4.22
v0.5.0-rc1
v0.42.0
v0.43.0-rc2
v0.43.1
v0.44.0-rc1
`;

test('resolveKuboAsset builds dist.ipfs.tech URLs', () => {
  const linux = resolveKuboAsset({ platform: 'linux', arch: 'x64', version: 'v0.43.1' });
  assert.equal(linux.url, 'https://dist.ipfs.tech/kubo/v0.43.1/kubo_v0.43.1_linux-amd64.tar.gz');
  assert.equal(linux.archiveName, 'kubo_v0.43.1_linux-amd64.tar.gz');
  assert.equal(linux.sha512Url, `${linux.url}.sha512`);
  assert.equal(linux.binaryName, 'ipfs');

  const win = resolveKuboAsset({ platform: 'win32', arch: 'arm64', version: '0.43.1' });
  assert.equal(win.url, 'https://dist.ipfs.tech/kubo/v0.43.1/kubo_v0.43.1_windows-arm64.zip');
  assert.equal(win.binaryName, 'ipfs.exe');

  const mac = resolveKuboAsset({ platform: 'darwin', arch: 'arm64', version: 'v0.43.1', baseUrl: 'http://mirror.local/kubo/' });
  assert.equal(mac.url, 'http://mirror.local/kubo/v0.43.1/kubo_v0.43.1_darwin-arm64.tar.gz');

  assert.throws(() => resolveKuboAsset({ platform: 'freebsd', arch: 'x64', version: 'v1.0.0' }), /Unsupported platform/);
  assert.throws(() => resolveKuboAsset({ platform: 'linux', arch: 'ia32', version: 'v1.0.0' }), /Unsupported architecture/);
  assert.throws(() => resolveKuboAsset({ platform: 'linux', arch: 'x64', version: 'latest' }), /Invalid Kubo version/);
});

test('KUBO_DIST_URL overrides the base URL', () => {
  const prev = process.env.KUBO_DIST_URL;
  process.env.KUBO_DIST_URL = 'https://mirror.example/kubo/';
  try {
    assert.equal(distBaseUrl(), 'https://mirror.example/kubo');
    assert.equal(resolveKuboAsset({ platform: 'linux', arch: 'x64', version: 'v0.43.1' }).url, 'https://mirror.example/kubo/v0.43.1/kubo_v0.43.1_linux-amd64.tar.gz');
  } finally {
    if (prev === undefined) delete process.env.KUBO_DIST_URL; else process.env.KUBO_DIST_URL = prev;
  }
});

test('version parsing picks the last stable line', () => {
  assert.equal(parseLatestStableVersion(VERSIONS), 'v0.43.1');
  assert.equal(parseLatestStableVersion('v0.1.0-rc1\n'), null);
  assert.equal(normalizeVersion('0.43.1'), 'v0.43.1');
  assert.throws(() => normalizeVersion(''), /required/);
});

test('latestStableVersion uses the fake fetch', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return new Response(VERSIONS); };
  assert.equal(await latestStableVersion(fetchImpl, { baseUrl: 'https://dist.example/kubo', env: {} }), 'v0.43.1');
  assert.deepEqual(calls, ['https://dist.example/kubo/versions']);
  const err = await latestStableVersion(async () => new Response('x', { status: 503 }), { env: {} }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /dist\.ipfs\.tech \(https:\/\/dist\.ipfs\.tech\/kubo\/versions\): HTTP 503/);
  assert.match(err.message, /GitHub releases \(https:\/\/github\.com\/ipfs\/kubo\/releases\/latest\): HTTP 503/);
  assert.equal(FALLBACK_KUBO_VERSION, 'v0.43.1');
});

test('latestStableVersion falls back to the GitHub /releases/latest redirect', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init?.redirect]);
    if (url.startsWith('https://dist.ipfs.tech/')) throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND dist.ipfs.tech') });
    const res = new Response('<html></html>', { status: 200 });
    Object.defineProperty(res, 'url', { value: 'https://github.com/ipfs/kubo/releases/tag/v0.44.2' });
    return res;
  };
  assert.equal(await latestStableVersion(fetchImpl, { env: {} }), 'v0.44.2');
  assert.deepEqual(calls, [['https://dist.ipfs.tech/kubo/versions', 'follow'], ['https://github.com/ipfs/kubo/releases/latest', 'follow']]);

  // a fetch that does not expose the redirect target: the canonical link in the page is used
  const noUrl = async (url) => (url.includes('github.com')
    ? new Response('<link rel="canonical" href="https://github.com/ipfs/kubo/releases/tag/v0.45.0">')
    : new Response('nope', { status: 404 }));
  assert.equal(await latestStableVersion(noUrl, { env: {} }), 'v0.45.0');

  // a pre-release redirect target is not "stable" → error (the caller falls back to the pinned version)
  const rc = async (url) => {
    if (!url.includes('github.com')) return new Response('', { status: 404 });
    const res = new Response('');
    Object.defineProperty(res, 'url', { value: 'https://github.com/ipfs/kubo/releases/tag/v0.46.0-rc1' });
    return res;
  };
  await assert.rejects(latestStableVersion(rc, { env: {} }), /no release tag/);

  assert.equal(parseGithubLatestTag('https://github.com/ipfs/kubo/releases/tag/v0.43.1'), 'v0.43.1');
  assert.equal(parseGithubLatestTag('https://github.com/ipfs/kubo/releases/tag/v0.43.1?x=1'), 'v0.43.1');
  assert.equal(parseGithubLatestTag('https://github.com/ipfs/kubo/releases'), null);
  assert.equal(parseGithubLatestTag('', 'href="https://github.com/other/repo/releases/tag/v1.0.0"'), null);
  // Electron's net.fetch reports url '' after redirects: only the page's own og:url / canonical
  // counts, never the many other tags its release notes link to
  const page = `<a href="https://github.com/ipfs/kubo/releases/tag/v0.13.0">old</a>
    <meta property="og:url" content="/ipfs/kubo/releases/tag/v0.43.1" />
    <a href="https://github.com/ipfs/kubo/releases/tag/v0.42.2">prev</a>`;
  assert.equal(parseGithubLatestTag('', page), 'v0.43.1');
  assert.equal(parseGithubLatestTag('', '<a href="https://github.com/ipfs/kubo/releases/tag/v0.13.0">x</a>'), null);
  assert.equal(parseGithubLatestTag('', '<meta content="https://github.com/ipfs/kubo/releases/tag/v0.50.0" property="og:url">'), 'v0.50.0');
});

test('kuboMirrors: KUBO_DIST_URL, then dist.ipfs.tech, then GitHub releases', () => {
  assert.deepEqual(kuboMirrors({ env: {} }).map((m) => m.id), ['dist', 'github']);
  const withEnv = kuboMirrors({ env: { KUBO_DIST_URL: 'http://mirror.lan/kubo/' } });
  assert.deepEqual(withEnv.map((m) => [m.id, m.kind, m.baseUrl]), [
    ['env', 'dist', 'http://mirror.lan/kubo'],
    ['dist', 'dist', 'https://dist.ipfs.tech/kubo'],
    ['github', 'github', 'https://github.com/ipfs/kubo/releases'],
  ]);
  // explicit override first; duplicates collapse
  assert.deepEqual(kuboMirrors({ baseUrl: 'https://dist.ipfs.tech/kubo/', env: { KUBO_DIST_URL: 'https://dist.ipfs.tech/kubo' } }).map((m) => m.id), ['custom', 'github']);
  assert.deepEqual(kuboMirrors({ baseUrl: 'http://a/kubo', env: { KUBO_DIST_URL: 'http://b/kubo' } }).map((m) => m.id), ['custom', 'env', 'dist', 'github']);
  assert.deepEqual(kuboMirrors({ env: { KUBO_DIST_URL: '  ' } }).map((m) => m.id), ['dist', 'github']);

  const [, dist, gh] = withEnv;
  assert.deepEqual(mirrorAssetUrls(dist, '0.43.1', 'kubo_v0.43.1_darwin-arm64.tar.gz'), {
    url: 'https://dist.ipfs.tech/kubo/v0.43.1/kubo_v0.43.1_darwin-arm64.tar.gz',
    sha512Url: 'https://dist.ipfs.tech/kubo/v0.43.1/kubo_v0.43.1_darwin-arm64.tar.gz.sha512',
  });
  assert.deepEqual(mirrorAssetUrls(gh, 'v0.43.1', 'kubo_v0.43.1_windows-amd64.zip'), {
    url: 'https://github.com/ipfs/kubo/releases/download/v0.43.1/kubo_v0.43.1_windows-amd64.zip',
    sha512Url: 'https://github.com/ipfs/kubo/releases/download/v0.43.1/kubo_v0.43.1_windows-amd64.zip.sha512',
  });
});

test('helpers: builderOsName, kuboBinaryName, parseChecksumFile', () => {
  assert.equal(builderOsName('linux'), 'linux');
  assert.equal(builderOsName('win32'), 'win');
  assert.equal(builderOsName('darwin'), 'mac');
  assert.throws(() => builderOsName('sunos'));
  assert.equal(kuboBinaryName('win32'), 'ipfs.exe');
  assert.equal(kuboBinaryName('linux'), 'ipfs');
  const hex = 'a'.repeat(128);
  assert.equal(parseChecksumFile(`${hex}  kubo_v0.43.1_linux-amd64.tar.gz\n`), hex);
  assert.equal(parseChecksumFile('garbage'), null);
});

/* ---------- end-to-end download with a fake fetch serving a locally built archive ---------- */

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

/** Minimal "stored" zip writer (enough for extract-zip to read it). */
function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

function serve(files) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const name = url.split('/').pop();
    if (!(name in files)) return new Response('not found', { status: 404 });
    return new Response(files[name], { status: 200, headers: { 'content-length': String(files[name].length) } });
  };
  return { fetchImpl, calls };
}

test('downloadKubo: tar.gz download, sha512 verification, extraction, chmod', async (t) => {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-dist-test-'));
  t.after(() => fsp.rm(work, { recursive: true, force: true }));
  const src = path.join(work, 'src', 'kubo');
  await fsp.mkdir(src, { recursive: true });
  const fakeBinary = '#!/bin/sh\necho fake-kubo\n';
  await fsp.writeFile(path.join(src, 'ipfs'), fakeBinary);
  await fsp.writeFile(path.join(src, 'README.md'), 'readme');
  const archive = path.join(work, 'kubo_v9.9.9_linux-amd64.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: path.join(work, 'src') }, ['kubo']);
  const archiveBytes = await fsp.readFile(archive);
  const sha = createHash('sha512').update(archiveBytes).digest('hex');

  const good = serve({ 'kubo_v9.9.9_linux-amd64.tar.gz': archiveBytes, 'kubo_v9.9.9_linux-amd64.tar.gz.sha512': Buffer.from(`${sha}  kubo_v9.9.9_linux-amd64.tar.gz\n`) });
  const dest = path.join(work, 'out');
  const progress = [];
  const installed = await downloadKubo({
    platform: 'linux', arch: 'x64', version: 'v9.9.9', destDir: dest,
    fetchImpl: good.fetchImpl, mirrors: ONLY('https://dist.example/kubo'),
    onProgress: (r, total) => progress.push([r, total]),
  });
  assert.equal(installed, path.join(dest, 'ipfs'));
  assert.equal(await fsp.readFile(installed, 'utf8'), fakeBinary);
  assert.equal((await fsp.stat(installed)).mode & 0o755, 0o755);
  // the small checksum is fetched first, then the archive, both from the same mirror
  assert.deepEqual(good.calls, ['https://dist.example/kubo/v9.9.9/kubo_v9.9.9_linux-amd64.tar.gz.sha512', 'https://dist.example/kubo/v9.9.9/kubo_v9.9.9_linux-amd64.tar.gz']);
  assert.ok(progress.length > 0 && progress.at(-1)[0] === archiveBytes.length);

  // checksum mismatch is fatal
  const bad = serve({ 'kubo_v9.9.9_linux-amd64.tar.gz': archiveBytes, 'kubo_v9.9.9_linux-amd64.tar.gz.sha512': Buffer.from(`${'0'.repeat(128)}  x\n`) });
  await assert.rejects(
    downloadKubo({ platform: 'linux', arch: 'x64', version: 'v9.9.9', destDir: path.join(work, 'out2'), fetchImpl: bad.fetchImpl, mirrors: ONLY('https://dist.example/kubo') }),
    /SHA-512 mismatch/,
  );
  assert.equal(fs.existsSync(path.join(work, 'out2', 'ipfs')), false);

  // missing checksum file → refused by default (never install an unverified binary) …
  const noSum = serve({ 'kubo_v9.9.9_linux-amd64.tar.gz': archiveBytes });
  await assert.rejects(
    downloadKubo({ platform: 'linux', arch: 'x64', version: 'v9.9.9', destDir: path.join(work, 'out3'), fetchImpl: noSum.fetchImpl, mirrors: ONLY('https://dist.example/kubo') }),
    /no checksum available .*refusing to install an unverified binary/i,
  );
  assert.equal(fs.existsSync(path.join(work, 'out3', 'ipfs')), false);
  // … unless the caller opts out, which only warns
  const warnings = [];
  await downloadKubo({ platform: 'linux', arch: 'x64', version: 'v9.9.9', destDir: path.join(work, 'out3'), fetchImpl: noSum.fetchImpl, mirrors: ONLY('https://dist.example/kubo'), requireChecksum: false, log: { warn: (m) => warnings.push(m) } });
  assert.ok(warnings.some((w) => /no checksum available/i.test(w)));
  assert.ok(fs.existsSync(path.join(work, 'out3', 'ipfs')));

  // 404 archive
  await assert.rejects(
    downloadKubo({ platform: 'linux', arch: 'x64', version: 'v9.9.8', destDir: path.join(work, 'out4'), fetchImpl: good.fetchImpl, mirrors: ONLY('https://dist.example/kubo') }),
    /HTTP 404/,
  );
});

async function buildTarGz(work, binaryText) {
  const src = path.join(work, 'src-mirror', 'kubo');
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(path.join(src, 'ipfs'), binaryText);
  const archive = path.join(work, 'mirror.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: path.join(work, 'src-mirror') }, ['kubo']);
  const bytes = await fsp.readFile(archive);
  return { bytes, sha: createHash('sha512').update(bytes).digest('hex') };
}

/** Fake fetch keyed by full URL; a function value can throw to simulate a network failure. */
function routes(table) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const r = table[url];
    if (typeof r === 'function') return r();
    if (r === undefined) return new Response('not found', { status: 404 });
    return new Response(r, { status: 200, headers: { 'content-length': String(Buffer.byteLength(r)) } });
  };
  return { fetchImpl, calls };
}

const ARCHIVE = 'kubo_v0.43.1_darwin-arm64.tar.gz';
const MIRROR_ENV = { KUBO_DIST_URL: 'http://mirror.lan/kubo' };
const URLS = {
  env: `http://mirror.lan/kubo/v0.43.1/${ARCHIVE}`,
  dist: `https://dist.ipfs.tech/kubo/v0.43.1/${ARCHIVE}`,
  github: `https://github.com/ipfs/kubo/releases/download/v0.43.1/${ARCHIVE}`,
};
const unreachable = () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') }); };

test('downloadKubo: falls back through the mirrors in order (env → dist.ipfs.tech → GitHub)', async (t) => {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-dist-mirrors-'));
  t.after(() => fsp.rm(work, { recursive: true, force: true }));
  const { bytes, sha } = await buildTarGz(work, 'github binary');
  const f = routes({
    [`${URLS.env}.sha512`]: unreachable,
    [`${URLS.dist}.sha512`]: unreachable, // the user's network blocks dist.ipfs.tech
    [`${URLS.github}.sha512`]: `${sha}  ${ARCHIVE}\n`,
    [URLS.github]: bytes,
  });
  const events = [];
  const installed = await downloadKubo({ platform: 'darwin', arch: 'arm64', version: 'v0.43.1', destDir: path.join(work, 'out'), fetchImpl: f.fetchImpl, env: MIRROR_ENV, onMirror: (e) => events.push([e.mirror.id, e.ok]) });
  assert.equal(await fsp.readFile(installed, 'utf8'), 'github binary');
  assert.deepEqual(f.calls, [`${URLS.env}.sha512`, `${URLS.dist}.sha512`, `${URLS.github}.sha512`, URLS.github]);
  assert.deepEqual(events, [['env', false], ['dist', false], ['github', true]]);
});

test('downloadKubo: a checksum mismatch fails that mirror and the next one is tried', async (t) => {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-dist-mismatch-'));
  t.after(() => fsp.rm(work, { recursive: true, force: true }));
  const good = await buildTarGz(work, 'verified binary');
  const f = routes({
    [`${URLS.dist}.sha512`]: `${'0'.repeat(128)}  ${ARCHIVE}\n`,
    [URLS.dist]: Buffer.from('tampered archive'),
    [`${URLS.github}.sha512`]: `${good.sha}  ${ARCHIVE}\n`,
    [URLS.github]: good.bytes,
  });
  const warnings = [];
  const installed = await downloadKubo({ platform: 'darwin', arch: 'arm64', version: 'v0.43.1', destDir: path.join(work, 'out'), fetchImpl: f.fetchImpl, env: {}, log: { warn: (m) => warnings.push(m) } });
  assert.equal(await fsp.readFile(installed, 'utf8'), 'verified binary');
  assert.ok(warnings.some((w) => /dist\.ipfs\.tech failed: SHA-512 mismatch/.test(w)), warnings.join('\n'));
  // the checksum of one mirror is never used for another mirror's archive
  assert.deepEqual(f.calls, [`${URLS.dist}.sha512`, URLS.dist, `${URLS.github}.sha512`, URLS.github]);
});

test('downloadKubo: a missing checksum skips the mirror by default, or warns and continues with requireChecksum: false', async (t) => {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-dist-nosum-'));
  t.after(() => fsp.rm(work, { recursive: true, force: true }));
  const distBuild = await buildTarGz(work, 'dist binary, no checksum');
  const distBytes = distBuild.bytes;
  const gh = await buildTarGz(path.join(work, 'gh'), 'github binary');
  const table = {
    [URLS.dist]: distBytes, // archive present, .sha512 404
    [`${URLS.github}.sha512`]: `${gh.sha}  ${ARCHIVE}\n`,
    [URLS.github]: gh.bytes,
  };
  const strict = routes(table);
  const a = await downloadKubo({ platform: 'darwin', arch: 'arm64', version: 'v0.43.1', destDir: path.join(work, 'strict'), fetchImpl: strict.fetchImpl, env: {} });
  assert.equal(await fsp.readFile(a, 'utf8'), 'github binary');
  assert.ok(!strict.calls.includes(URLS.dist), 'the unverifiable archive is not even downloaded');

  const lax = routes(table);
  const warnings = [];
  const b = await downloadKubo({ platform: 'darwin', arch: 'arm64', version: 'v0.43.1', destDir: path.join(work, 'lax'), fetchImpl: lax.fetchImpl, env: {}, requireChecksum: false, log: { warn: (m) => warnings.push(m) } });
  assert.equal(await fsp.readFile(b, 'utf8'), 'dist binary, no checksum');
  assert.ok(warnings.some((w) => /no checksum available .*skipping verification/.test(w)));
});

test('downloadKubo: when every mirror fails, one error lists each mirror and its reason', async (t) => {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-dist-allfail-'));
  t.after(() => fsp.rm(work, { recursive: true, force: true }));
  const f = routes({
    [`${URLS.env}.sha512`]: unreachable,
    [`${URLS.dist}.sha512`]: () => new Response('forbidden', { status: 403 }),
    [`${URLS.github}.sha512`]: `${'a'.repeat(128)}  ${ARCHIVE}\n`,
    [URLS.github]: Buffer.from('not the right bytes'),
  });
  const err = await downloadKubo({ platform: 'darwin', arch: 'arm64', version: 'v0.43.1', destDir: path.join(work, 'out'), fetchImpl: f.fetchImpl, env: MIRROR_ENV }).catch((e) => e);
  assert.ok(err instanceof Error, 'downloadKubo must reject');
  assert.match(err.message, /^Could not download Kubo v0\.43\.1 \(kubo_v0\.43\.1_darwin-arm64\.tar\.gz\) from any mirror: /);
  assert.match(err.message, /KUBO_DIST_URL \(http:\/\/mirror\.lan\/kubo\): could not reach .*ENOTFOUND/);
  assert.match(err.message, /dist\.ipfs\.tech: no checksum available .*HTTP 403/);
  assert.match(err.message, /GitHub releases: SHA-512 mismatch/);
  assert.deepEqual(err.attempts.map((x) => x.id), ['env', 'dist', 'github']);
  assert.equal(fs.existsSync(path.join(work, 'out', 'ipfs')), false);
});

test('downloadKubo: windows zip archives are extracted to ipfs.exe', async (t) => {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-dist-zip-'));
  t.after(() => fsp.rm(work, { recursive: true, force: true }));
  const exe = Buffer.from('MZ fake windows binary');
  const zipBytes = buildStoredZip([
    { name: 'kubo/README.md', data: Buffer.from('readme') },
    { name: 'kubo/ipfs.exe', data: exe },
  ]);
  const s = serve({ 'kubo_v9.9.9_windows-amd64.zip': zipBytes });
  const installed = await downloadKubo({ platform: 'win32', arch: 'x64', version: 'v9.9.9', destDir: path.join(work, 'out'), fetchImpl: s.fetchImpl, mirrors: ONLY('https://dist.example/kubo'), requireChecksum: false });
  assert.equal(installed, path.join(work, 'out', 'ipfs.exe'));
  assert.deepEqual(await fsp.readFile(installed), exe);
});

test('downloadKubo: archive without the binary fails clearly', async (t) => {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bucks-dist-empty-'));
  t.after(() => fsp.rm(work, { recursive: true, force: true }));
  await fsp.mkdir(path.join(work, 'src', 'kubo'), { recursive: true });
  await fsp.writeFile(path.join(work, 'src', 'kubo', 'README.md'), 'x');
  const archive = path.join(work, 'a.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: path.join(work, 'src') }, ['kubo']);
  const s = serve({ 'kubo_v9.9.9_darwin-arm64.tar.gz': await fsp.readFile(archive) });
  await assert.rejects(
    downloadKubo({ platform: 'darwin', arch: 'arm64', version: 'v9.9.9', destDir: path.join(work, 'out'), fetchImpl: s.fetchImpl, mirrors: ONLY('https://dist.example/kubo'), requireChecksum: false }),
    /did not contain kubo\/ipfs/,
  );
});
