// The design-system web components, under happy-dom: structure, accessibility wiring, events.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let lib;
before(async () => {
  GlobalRegistrator.register();
  lib = await import('../../../design/components/index.js');
});
after(async () => { await GlobalRegistrator.unregister(); });

const mount = (html) => {
  const host = document.createElement('div');
  host.innerHTML = html; // test fixture only
  document.body.append(host);
  return host.firstElementChild;
};

test('h() puts strings in as text, never as markup', () => {
  const el = lib.h('p', { class: 'x', text: '<b>hi</b>' }, ' <i>more</i>');
  assert.equal(el.textContent, '<b>hi</b> <i>more</i>');
  assert.equal(el.querySelector('b'), null);
  assert.equal(el.className, 'x');
});

test('every component shares one stylesheet per class, written against the tokens', () => {
  const a = mount('<bucks-button>One</bucks-button>');
  const b = mount('<bucks-button>Two</bucks-button>');
  assert.equal(a.shadowRoot.adoptedStyleSheets[0], b.shadowRoot.adoptedStyleSheets[0]);
  assert.match(lib.BucksButton.styles, /var\(--bucks-color-accent-emphasis\)/);
});

test('button: a native button inside; label, loading and disabled', () => {
  const el = mount('<bucks-button variant="primary" label="Install"></bucks-button>');
  const inner = el.shadowRoot.querySelector('button');
  assert.equal(inner.getAttribute('aria-label'), 'Install');
  assert.ok(el.hasAttribute('icon-only'), 'a labelled button without text is icon-only');
  let clicks = 0;
  el.addEventListener('click', () => { clicks += 1; });
  inner.click();
  assert.equal(clicks, 1);
  el.setAttribute('loading', '');
  assert.equal(inner.getAttribute('aria-busy'), '');
  assert.equal(el.shadowRoot.querySelector('bucks-spinner').hidden, false);
  inner.click();
  assert.equal(clicks, 1, 'a loading button swallows the click');
  el.removeAttribute('loading');
  el.setAttribute('disabled', '');
  assert.equal(inner.disabled, true);
  assert.equal(inner.getAttribute('aria-disabled'), 'true');
});

test('switch: role=switch, toggles, and a cancelled change keeps it as it was', () => {
  const el = mount('<bucks-switch label="Notifications"></bucks-switch>');
  const b = el.shadowRoot.querySelector('button');
  assert.equal(b.getAttribute('role'), 'switch');
  assert.equal(b.getAttribute('aria-label'), 'Notifications');
  assert.equal(b.getAttribute('aria-checked'), 'false');
  const seen = [];
  el.addEventListener('change', (e) => seen.push(e.detail.checked));
  b.click();
  assert.equal(el.checked, true);
  assert.equal(b.getAttribute('aria-checked'), 'true');
  el.addEventListener('change', (e) => e.preventDefault(), { once: true });
  b.click();
  assert.equal(el.checked, true, 'refused by a listener');
  assert.deepEqual(seen, [true, false]);
});

test('field: label wiring, value before and after connecting, errors', () => {
  const el = document.createElement('bucks-field');
  el.setAttribute('label', 'Address');
  el.value = 'ipns://k51';
  document.body.append(el);
  const input = el.shadowRoot.querySelector('input');
  const label = el.shadowRoot.querySelector('label');
  assert.equal(label.getAttribute('for'), input.id);
  assert.equal(label.textContent, 'Address');
  assert.equal(el.value, 'ipns://k51');
  input.value = 'ipfs://bafy';
  assert.equal(el.value, 'ipfs://bafy');
  el.setAttribute('invalid', '');
  el.setAttribute('message', 'Not an IPFS address');
  const msg = el.shadowRoot.querySelector('.message');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(msg.getAttribute('role'), 'alert');
  assert.equal(input.getAttribute('aria-describedby'), msg.id);
  let changed = null;
  el.addEventListener('change', (e) => { changed = e.detail.value; });
  input.dispatchEvent(new Event('change'));
  assert.equal(changed, 'ipfs://bafy');
});

test('dialog: opens modally, closes with a return value, reflects it on the host', () => {
  const el = mount('<bucks-dialog heading="Install Notes?" description="From ipns://k51">Body<bucks-button slot="actions">OK</bucks-button></bucks-dialog>');
  const d = el.shadowRoot.querySelector('dialog');
  assert.equal(el.shadowRoot.querySelector('h2').textContent, 'Install Notes?');
  assert.equal(d.getAttribute('aria-labelledby'), el.shadowRoot.querySelector('h2').id);
  el.show();
  assert.equal(d.open, true);
  let returned = null;
  el.addEventListener('close', (e) => { returned = e.detail.returnValue; });
  el.close('install');
  assert.equal(d.open, false);
  assert.equal(el.hasAttribute('open'), false);
  assert.equal(returned, 'install');
});

test('progress, notice, badge, icon: accessibility attributes', () => {
  const p = mount('<bucks-progress value="40" label="Installing"></bucks-progress>');
  const track = p.shadowRoot.querySelector('[role=progressbar]');
  assert.equal(track.getAttribute('aria-valuenow'), '40');
  assert.equal(track.getAttribute('aria-label'), 'Installing');
  p.removeAttribute('value');
  assert.equal(track.hasAttribute('aria-valuenow'), false, 'indeterminate');
  const n = mount('<bucks-notice tone="danger" heading="Blocked">Text</bucks-notice>');
  assert.equal(n.shadowRoot.querySelector('div').getAttribute('role'), 'alert');
  n.setAttribute('tone', 'warning');
  assert.equal(n.shadowRoot.querySelector('div').getAttribute('role'), 'status');
  const badge = mount('<bucks-badge tone="success" dot>Running</bucks-badge>');
  assert.equal(badge.shadowRoot.querySelector('i').hidden, false);
  const icon = mount('<bucks-icon name="trash" label="Remove"></bucks-icon>');
  const svg = icon.shadowRoot.querySelector('svg');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.getAttribute('aria-label'), 'Remove');
  assert.ok(svg.querySelectorAll('path,line').length >= 3);
  const deco = mount('<bucks-icon name="plus"></bucks-icon>');
  assert.equal(deco.shadowRoot.querySelector('svg').getAttribute('aria-hidden'), 'true');
});

test('permission list: rows with risk, editable switches that can be refused', () => {
  const el = mount('<bucks-permission-list editable></bucks-permission-list>');
  el.items = [
    { id: 'network:https://api.example.com', label: 'Connect to api.example.com', risk: 'medium', icon: 'wifi' },
    { id: 'camera', label: 'Use the camera', risk: 'high', icon: 'camera', granted: false },
  ];
  const rows = el.shadowRoot.querySelectorAll('li');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('.label').textContent, 'Connect to api.example.com');
  assert.equal(rows[1].querySelector('bucks-badge').textContent, 'High risk');
  const sw = rows[1].querySelector('bucks-switch');
  assert.equal(sw.checked, false);
  const changes = [];
  el.addEventListener('permission-change', (e) => changes.push(e.detail));
  sw.toggle();
  assert.deepEqual(changes, [{ id: 'camera', granted: true }]);
  assert.equal(sw.checked, true);
  el.addEventListener('permission-change', (e) => e.preventDefault(), { once: true });
  sw.toggle();
  assert.equal(sw.checked, true, 'refused');
  el.items = [];
  assert.equal(el.shadowRoot.querySelector('.empty').hidden, false);
});
