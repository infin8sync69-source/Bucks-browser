import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizeWindowState, isOnVisibleDisplay, readWindowState, writeWindowState, DEFAULT_WINDOW_SIZE } from '../../../src/main/window-state.js';

const displays = [
  { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } },
];

test('defaults when nothing was saved or the file is garbage', () => {
  assert.deepEqual(sanitizeWindowState(null, displays), { ...DEFAULT_WINDOW_SIZE, maximized: false });
  assert.deepEqual(sanitizeWindowState('junk', displays), { ...DEFAULT_WINDOW_SIZE, maximized: false });
  assert.deepEqual(sanitizeWindowState({ width: 'a', height: null }, displays), { ...DEFAULT_WINDOW_SIZE, maximized: false });
});

test('keeps a position that is on a connected display', () => {
  const s = sanitizeWindowState({ x: 100, y: 50, width: 1200, height: 800, maximized: true }, displays);
  assert.deepEqual(s, { x: 100, y: 50, width: 1200, height: 800, maximized: true });
  const second = sanitizeWindowState({ x: 2000, y: 10, width: 1000, height: 700 }, displays);
  assert.equal(second.x, 2000);
});

test('drops a position that is off-screen (monitor unplugged) but keeps the size', () => {
  const s = sanitizeWindowState({ x: 4000, y: 0, width: 1200, height: 800 }, displays);
  assert.equal(s.x, undefined);
  assert.equal(s.y, undefined);
  assert.equal(s.width, 1200);
  const belowScreen = sanitizeWindowState({ x: 10, y: 1030, width: 1200, height: 800 }, displays);
  assert.equal(belowScreen.x, undefined, 'title bar hidden below the work area');
  const noDisplays = sanitizeWindowState({ x: 10, y: 10, width: 1200, height: 800 }, []);
  assert.equal(noDisplays.x, undefined);
});

test('sizes below the minimum fall back to defaults; sizes above the largest display are clamped', () => {
  assert.equal(sanitizeWindowState({ width: 300, height: 200 }, displays).width, DEFAULT_WINDOW_SIZE.width);
  const big = sanitizeWindowState({ width: 5000, height: 4000 }, displays);
  assert.equal(big.width, 1920);
  assert.equal(big.height, 1040);
});

test('isOnVisibleDisplay needs a 64px overlap of the top strip', () => {
  assert.equal(isOnVisibleDisplay({ x: -1000, y: 0, width: 1064, height: 600 }, displays), true);
  assert.equal(isOnVisibleDisplay({ x: -1000, y: 0, width: 1050, height: 600 }, displays), false);
  assert.equal(isOnVisibleDisplay({ x: 0, y: -600, width: 900, height: 700 }, displays), false);
});

test('read/write round trip and tolerance of bad files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-ws-'));
  const file = path.join(dir, 'nested', 'window-state.json');
  assert.equal(readWindowState(file), null);
  assert.equal(writeWindowState(file, { x: 1, y: 2, width: 1000, height: 700, maximized: false }), true);
  assert.deepEqual(readWindowState(file), { x: 1, y: 2, width: 1000, height: 700, maximized: false });
  fs.writeFileSync(file, '{not json');
  assert.equal(readWindowState(file), null);
  fs.writeFileSync(file, '[1,2]');
  assert.equal(readWindowState(file), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
