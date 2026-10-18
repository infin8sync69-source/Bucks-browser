import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideInstall,
  installPlan,
  isValidBranch,
  parseAheadBehind,
  parseDirty,
} from '../../../src/main/updater-core.js';

test('isValidBranch accepts normal names and rejects argv-injection and traversal', () => {
  assert.ok(isValidBranch('electron-main'));
  assert.ok(isValidBranch('feature/ipfs-2.0'));
  assert.equal(isValidBranch('-rf'), false);
  assert.equal(isValidBranch('a..b'), false);
  assert.equal(isValidBranch('main; rm -rf /'), false);
  assert.equal(isValidBranch(''), false);
  assert.equal(isValidBranch(undefined), false);
});

test('parseAheadBehind reads rev-list output', () => {
  assert.deepEqual(parseAheadBehind('0\t3\n'), { ahead: 0, behind: 3 });
  assert.deepEqual(parseAheadBehind('2 0'), { ahead: 2, behind: 0 });
  assert.throws(() => parseAheadBehind('fatal: bad revision'), /Unexpected git rev-list output/);
});

test('parseDirty ignores blank output and detects any change', () => {
  assert.equal(parseDirty(''), false);
  assert.equal(parseDirty('\n'), false);
  assert.equal(parseDirty(' M src/main/index.js\n'), true);
  assert.equal(parseDirty('?? new-file.js'), true);
});

test('decideInstall refuses unsupported checkouts, local changes and local-only commits', () => {
  assert.equal(decideInstall({ supported: false, reason: 'packaged app' }).ok, false);
  assert.equal(decideInstall({ supported: false, reason: 'packaged app' }).reason, 'packaged app');
  assert.equal(decideInstall({ supported: true, dirty: true, ahead: 0, behind: 2 }).ok, false);
  assert.equal(decideInstall({ supported: true, dirty: false, ahead: 1, behind: 2 }).ok, false);
});

test('decideInstall reports up-to-date and update-available states', () => {
  const upToDate = decideInstall({ supported: true, dirty: false, ahead: 0, behind: 0 });
  assert.equal(upToDate.ok, true);
  assert.equal(upToDate.updateAvailable, false);
  const one = decideInstall({ supported: true, dirty: false, ahead: 0, behind: 1 });
  assert.equal(one.updateAvailable, true);
  assert.equal(one.reason, '1 new commit available.');
  assert.equal(decideInstall({ supported: true, dirty: false, ahead: 0, behind: 4 }).reason, '4 new commits available.');
});

test('installPlan uses fixed argv arrays and validates the branch', () => {
  const plan = installPlan({ branch: 'electron-main', npmCommand: 'npm' });
  assert.deepEqual(plan.map((s) => s.id), ['pull', 'deps', 'build']);
  assert.deepEqual(plan[0].args, ['pull', '--ff-only', 'origin', 'electron-main']);
  assert.deepEqual(plan[2].args, ['run', 'build:ui']);
  assert.throws(() => installPlan({ branch: '--upload-pack=evil', npmCommand: 'npm' }), /invalid branch/);
});

test('installPlan on macOS 12 installs the Electron override directly and the UI deps explicitly', () => {
  const plan = installPlan({ branch: 'electron-main', npmCommand: 'npm', electronOverride: '43' });
  assert.deepEqual(plan.map((s) => s.id), ['pull', 'deps', 'ui-deps', 'build']);
  assert.deepEqual(plan[1].args, ['install', '--no-save', '--no-audit', '--no-fund', 'electron@43']);
  assert.deepEqual(plan[2].args, ['--prefix', 'ui', 'install', '--no-audit', '--no-fund']);
  assert.deepEqual(plan[3].args, ['run', 'build:ui']);
});

test('installPlan without an override is unchanged and rejects a malformed override', () => {
  assert.deepEqual(installPlan({ branch: 'electron-main', npmCommand: 'npm', electronOverride: null }).map((s) => s.id), ['pull', 'deps', 'build']);
  assert.throws(() => installPlan({ branch: 'electron-main', npmCommand: 'npm', electronOverride: '43; rm -rf /' }), /invalid Electron version/);
});
