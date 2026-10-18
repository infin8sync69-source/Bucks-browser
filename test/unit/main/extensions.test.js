import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./helpers/electron-loader.mjs', import.meta.url);
const { scanExtensionDirs } = await import('../../../src/main/extensions.js');

test('scanExtensionDirs finds folders with a manifest.json only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-ext-'));
  for (const d of ['b-ublock', 'a-violentmonkey', 'no-manifest', '.hidden']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, 'b-ublock', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(dir, 'a-violentmonkey', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(dir, '.hidden', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(dir, 'stray-file.json'), '{}');
  assert.deepEqual(scanExtensionDirs(dir), [path.join(dir, 'a-violentmonkey'), path.join(dir, 'b-ublock')]);
  assert.deepEqual(scanExtensionDirs(path.join(dir, 'missing')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
