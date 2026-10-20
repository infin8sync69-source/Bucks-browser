// @ts-check
// <bucks-permission-list editable></bucks-permission-list>
//   el.items = [{ id, label, description, risk: 'low'|'medium'|'high', icon, granted }]
// What something may do, with its risk. `editable` adds a switch per item; flipping one
// dispatches `permission-change` with { id, granted } (cancel it to keep the switch as it was).

import { BucksElement, define, emit, h } from './base.js';
import './surface.js';
import './controls.js';
import './icon.js';

const RISK = { low: { tone: 'neutral', text: 'Low risk' }, medium: { tone: 'warning', text: 'Medium risk' }, high: { tone: 'danger', text: 'High risk' } };

/** @typedef {{ id: string, label: string, description?: string, risk?: 'low'|'medium'|'high', icon?: string, granted?: boolean }} PermissionItem */

export class BucksPermissionList extends BucksElement {
  static observedAttributes = ['editable', 'empty-text'];
  static styles = `
:host { display: block; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: calc(var(--bucks-space-unit) * 2); }
li { display: flex; align-items: flex-start; gap: calc(var(--bucks-space-unit) * 3); padding: calc(var(--bucks-space-unit) * 3);
  border: var(--bucks-size-hairline) solid var(--bucks-color-line); border-radius: var(--bucks-radius-xl); background: var(--bucks-color-surface-1); }
.icon { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: var(--bucks-radius-lg); background: var(--bucks-color-surface-3); color: var(--bucks-color-fg-muted); }
.text { flex: 1; min-width: 0; }
.row { display: flex; align-items: center; gap: calc(var(--bucks-space-unit) * 2); flex-wrap: wrap; }
.label { font-size: var(--bucks-font-size-md); font-weight: var(--bucks-font-weight-medium); color: var(--bucks-color-fg); overflow-wrap: anywhere; }
.description { margin-top: var(--bucks-space-unit); font-size: var(--bucks-font-size-xs); line-height: var(--bucks-font-leading-relaxed); color: var(--bucks-color-fg-subtle); }
.empty { font-size: var(--bucks-font-size-sm); color: var(--bucks-color-fg-subtle); }
bucks-switch { margin-top: 6px; }
`;

  constructor() {
    super();
    /** @type {PermissionItem[]} */
    this._items = [];
  }

  /** @param {PermissionItem[]} items */
  set items(items) { this._items = Array.isArray(items) ? items : []; if (this._built) this.sync(); }
  get items() { return this._items; }

  build() {
    this._list = h('ul', { part: 'list' });
    this._empty = h('p', { class: 'empty' });
    return [this._list, this._empty];
  }

  sync() {
    const list = /** @type {HTMLElement} */ (this._list);
    const empty = /** @type {HTMLElement} */ (this._empty);
    empty.textContent = this.str('empty-text', 'Nothing.');
    empty.hidden = this._items.length > 0;
    list.hidden = this._items.length === 0;
    list.replaceChildren(...this._items.map((item) => this._row(item)));
  }

  /** @param {PermissionItem} item */
  _row(item) {
    const risk = RISK[item.risk || 'low'] || RISK.low;
    const text = h('div', { class: 'text' },
      h('div', { class: 'row' }, h('span', { class: 'label', text: item.label }), h('bucks-badge', { tone: risk.tone, text: risk.text })),
      item.description ? h('div', { class: 'description', text: item.description }) : null);
    const li = h('li', { 'data-id': item.id }, h('span', { class: 'icon' }, h('bucks-icon', { name: item.icon || 'shield' })), text);
    if (this.bool('editable')) {
      const sw = h('bucks-switch', { label: `Allow: ${item.label}`, checked: item.granted !== false });
      sw.addEventListener('change', (e) => {
        const granted = /** @type {CustomEvent} */ (e).detail.checked;
        e.stopPropagation();
        if (!emit(this, 'permission-change', { id: item.id, granted })) e.preventDefault();
        else item.granted = granted;
      });
      li.append(sw);
    }
    return li;
  }
}

define('bucks-permission-list', BucksPermissionList);
