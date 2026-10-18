import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTEREY_ELECTRON_MAJOR,
  electronOverrideFor,
  macosMajorFromDarwin,
  overrideInstallArgs,
} from '../../../src/main/electron-compat.js';

test('macosMajorFromDarwin maps Darwin kernel releases to macOS majors', () => {
  assert.equal(macosMajorFromDarwin('20.6.0'), 11);
  assert.equal(macosMajorFromDarwin('21.6.0'), 12); // macOS 12.7.6 reports Darwin 21.6.0
  assert.equal(macosMajorFromDarwin('22.1.0'), 13);
  assert.equal(macosMajorFromDarwin('24.0.0'), 15);
  assert.equal(macosMajorFromDarwin('19.6.0'), null); // macOS 10.15 is not "macOS 10"
  assert.equal(macosMajorFromDarwin(''), null);
  assert.equal(macosMajorFromDarwin('garbage'), null);
});

test('no override off macOS or on macOS 13 and newer', () => {
  assert.equal(electronOverrideFor({ platform: 'linux', release: '6.8.0-45-generic' }).override, null);
  assert.equal(electronOverrideFor({ platform: 'win32', release: '10.0.22631' }).override, null);
  assert.equal(electronOverrideFor({ platform: 'darwin', release: '22.6.0' }).override, null);
  assert.equal(electronOverrideFor({ platform: 'darwin', release: '24.1.0' }).override, null);
});

test('macOS 12 gets Electron 43 with a reason that names the security window', () => {
  const d = electronOverrideFor({ platform: 'darwin', release: '21.6.0' });
  assert.equal(d.override, MONTEREY_ELECTRON_MAJOR);
  assert.equal(d.override, '43');
  assert.equal(d.macosMajor, 12);
  assert.match(d.reason, /Electron 43/);
  assert.match(d.reason, /security fixes/);
});

test('macOS 11 and older, or an unreadable release, are refused', () => {
  assert.throws(() => electronOverrideFor({ platform: 'darwin', release: '20.6.0' }), /macOS 12 \(Monterey\) or newer/);
  assert.throws(() => electronOverrideFor({ platform: 'darwin', release: '19.6.0' }), /macOS 12/);
  assert.throws(() => electronOverrideFor({ platform: 'darwin', release: '' }), /macOS 12/);
});

test('overrideInstallArgs never saves to package.json', () => {
  assert.deepEqual(overrideInstallArgs('43'), ['install', '--no-save', '--no-audit', '--no-fund', 'electron@43']);
});
