'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shortcutChord } = require('../../shortcuts');

const mac = (o) => shortcutChord({ meta: true, ...o }, 'darwin');
const win = (o) => shortcutChord({ control: true, ...o }, 'linux');

test('browser chords are forwarded with the platform modifier', () => {
  for (const key of ['t', 'w', 'l', 'r', 'f', 'p', 'j', 'n', '0', '-', '=']) {
    assert.ok(mac({ key }), `mac ${key}`);
    assert.ok(win({ key }), `win ${key}`);
  }
  assert.ok(mac({ key: 'T', shift: true }));
  assert.ok(win({ key: 'N', shift: true }));
});

test('the wrong modifier for the platform stays with the page', () => {
  assert.equal(shortcutChord({ control: true, key: 't' }, 'darwin'), null);
  assert.equal(shortcutChord({ meta: true, key: 't' }, 'linux'), null);
});

test('editing and page keys are never taken from the page', () => {
  for (const key of ['c', 'v', 'x', 'a', 'z', 's', 'k', 'd']) {
    assert.equal(mac({ key }), null, key);
    assert.equal(win({ key }), null, key);
  }
  assert.equal(mac({ key: 't', alt: true }), null);
  assert.equal(mac({ key: 'w', shift: true }), null);
  assert.equal(shortcutChord({ key: 'a' }, 'darwin'), null);
});

test('F5 and Alt+arrows navigate; modified variants do not', () => {
  assert.ok(shortcutChord({ key: 'F5' }, 'linux'));
  assert.equal(shortcutChord({ key: 'F5', shift: true }, 'linux'), null);
  assert.ok(shortcutChord({ key: 'ArrowLeft', alt: true }, 'linux'));
  assert.ok(shortcutChord({ key: 'ArrowRight', alt: true }, 'darwin'));
  assert.equal(shortcutChord({ key: 'ArrowLeft' }, 'linux'), null);
});
