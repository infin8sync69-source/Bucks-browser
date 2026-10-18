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
} from '../../../src/main/ipfs/dist.js';

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
  assert.equal(await latestStableVersion(fetchImpl, { baseUrl: 'https://dist.example/kubo' }), 'v0.43.1');
  assert.deepEqual(calls, ['https://dist.example/kubo/versions']);
  await assert.rejects(latestStableVersion(async () => new Response('x', { status: 503 })), /HTTP 503/);
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
    fetchImpl: good.fetchImpl, baseUrl: 'https://dist.example/kubo',
    onProgress: (r, total) => progress.push([r, total]),
  });
  assert.equal(installed, path.join(dest, 'ipfs'));
  assert.equal(await fsp.readFile(installed, 'utf8'), fakeBinary);
  assert.equal((await fsp.stat(installed)).mode & 0o755, 0o755);
  assert.equal(good.calls[0], 'https://dist.example/kubo/v9.9.9/kubo_v9.9.9_linux-amd64.tar.gz');
  assert.ok(progress.length > 0 && progress.at(-1)[0] === archiveBytes.length);

  // checksum mismatch is fatal
  const bad = serve({ 'kubo_v9.9.9_linux-amd64.tar.gz': archiveBytes, 'kubo_v9.9.9_linux-amd64.tar.gz.sha512': Buffer.from(`${'0'.repeat(128)}  x\n`) });
  await assert.rejects(
    downloadKubo({ platform: 'linux', arch: 'x64', version: 'v9.9.9', destDir: path.join(work, 'out2'), fetchImpl: bad.fetchImpl, baseUrl: 'https://dist.example/kubo' }),
    /SHA-512 mismatch/,
  );
  assert.equal(fs.existsSync(path.join(work, 'out2', 'ipfs')), false);

  // missing checksum file → refused by default (never install an unverified binary) …
  const noSum = serve({ 'kubo_v9.9.9_linux-amd64.tar.gz': archiveBytes });
  await assert.rejects(
    downloadKubo({ platform: 'linux', arch: 'x64', version: 'v9.9.9', destDir: path.join(work, 'out3'), fetchImpl: noSum.fetchImpl, baseUrl: 'https://dist.example/kubo' }),
    /No checksum available .*refusing to install an unverified binary/,
  );
  assert.equal(fs.existsSync(path.join(work, 'out3', 'ipfs')), false);
  // … unless the caller opts out, which only warns
  const warnings = [];
  await downloadKubo({ platform: 'linux', arch: 'x64', version: 'v9.9.9', destDir: path.join(work, 'out3'), fetchImpl: noSum.fetchImpl, baseUrl: 'https://dist.example/kubo', requireChecksum: false, log: { warn: (m) => warnings.push(m) } });
  assert.ok(warnings.some((w) => /No checksum available/.test(w)));
  assert.ok(fs.existsSync(path.join(work, 'out3', 'ipfs')));

  // 404 archive
  await assert.rejects(
    downloadKubo({ platform: 'linux', arch: 'x64', version: 'v9.9.8', destDir: path.join(work, 'out4'), fetchImpl: good.fetchImpl, baseUrl: 'https://dist.example/kubo' }),
    /HTTP 404/,
  );
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
  const installed = await downloadKubo({ platform: 'win32', arch: 'x64', version: 'v9.9.9', destDir: path.join(work, 'out'), fetchImpl: s.fetchImpl, baseUrl: 'https://dist.example/kubo', requireChecksum: false });
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
    downloadKubo({ platform: 'darwin', arch: 'arm64', version: 'v9.9.9', destDir: path.join(work, 'out'), fetchImpl: s.fetchImpl, baseUrl: 'https://dist.example/kubo', requireChecksum: false }),
    /did not contain kubo\/ipfs/,
  );
});
