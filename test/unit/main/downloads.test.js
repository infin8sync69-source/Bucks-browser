import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import path from 'node:path';

register('./helpers/electron-loader.mjs', import.meta.url);
const { sanitizeFilename, uniqueFilename, MAX_DOWNLOAD_ITEMS } = await import('../../../src/main/downloads.js');

test('sanitizeFilename strips separators, reserved and control characters', () => {
  assert.equal(sanitizeFilename('../../evil.sh'), '_.._evil.sh');
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j.txt'), 'a_b_c_d_e_f_g_h_i_j.txt');
  assert.equal(sanitizeFilename('.hidden'), 'hidden');
  assert.equal(sanitizeFilename('   '), 'download');
  assert.equal(sanitizeFilename(undefined), 'download');
  assert.equal(sanitizeFilename('bad\u0000name\u001f.bin'), 'bad_name_.bin');
  const long = sanitizeFilename('x'.repeat(500) + '.tar.gz');
  assert.ok(long.length <= 200);
  assert.ok(long.endsWith('.gz'));
});

test('uniqueFilename appends (n) before the extension until free', () => {
  const taken = new Set(['/dl/report.pdf', '/dl/report (1).pdf', '/dl/archive.tar.gz']);
  const exists = (p) => taken.has(p.split(path.sep).join('/'));
  assert.equal(uniqueFilename('/dl', 'report.pdf', exists), 'report (2).pdf');
  assert.equal(uniqueFilename('/dl', 'fresh.pdf', exists), 'fresh.pdf');
  assert.equal(uniqueFilename('/dl', 'archive.tar.gz', exists), 'archive.tar (1).gz');
  assert.equal(uniqueFilename('/dl', 'noext', () => false), 'noext');
});

test('memory cap is 200', () => {
  assert.equal(MAX_DOWNLOAD_ITEMS, 200);
});
