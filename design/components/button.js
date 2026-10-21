// @ts-check
// <bucks-button variant="primary|secondary|ghost|danger|agent" size="sm|md" disabled loading label="…">
//   <svg slot="icon">…</svg> Text
// </bucks-button>
// A native <button> inside, so keyboard and screen readers behave as for any button. `label` names
// an icon-only button. A disabled or loading button swallows clicks.

import { BucksElement, define, h } from './base.js';
import './spinner.js';

export class BucksButton extends BucksElement {
  static observedAttributes = ['variant', 'size', 'disabled', 'loading', 'label', 'type'];
  static shadowOptions = /** @type {ShadowRootInit} */ ({ mode: 'open', delegatesFocus: true });
  static styles = `
:host { display: inline-flex; vertical-align: middle; }
button {
  all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  gap: calc(var(--bucks-space-unit) * 2); width: 100%;
  padding: calc(var(--bucks-space-unit) * 2) calc(var(--bucks-space-unit) * 3.5);
  border-radius: var(--bucks-radius-lg); border: var(--bucks-size-hairline) solid transparent;
  font: inherit; font-size: var(--bucks-font-size-sm); font-weight: var(--bucks-font-weight-medium);
  line-height: var(--bucks-font-leading-tight); white-space: nowrap; cursor: pointer; user-select: none;
  transition: background-color var(--bucks-duration-fast) var(--bucks-easing-standard),
              border-color var(--bucks-duration-fast) var(--bucks-easing-standard),
              color var(--bucks-duration-fast) var(--bucks-easing-standard);
}
button:focus-visible { outline: 2px solid var(--bucks-color-focus); outline-offset: 2px; }
:host([size="sm"]) button { padding: calc(var(--bucks-space-unit) * 1.5) calc(var(--bucks-space-unit) * 2.5); font-size: var(--bucks-font-size-xs); border-radius: var(--bucks-radius-md); }
:host([icon-only]) button { padding: calc(var(--bucks-space-unit) * 2); }
:host([size="sm"][icon-only]) button { padding: calc(var(--bucks-space-unit) * 1.5); }

button { background: var(--bucks-color-surface-3); border-color: var(--bucks-color-line-strong); color: var(--bucks-color-fg); }
:host(:not([disabled]):not([loading])) button:hover { background: var(--bucks-color-surface-4); border-color: var(--bucks-color-line-emphasis); }
:host([variant="primary"]) button { background: var(--bucks-color-accent-emphasis); border-color: var(--bucks-color-accent-emphasis); color: var(--bucks-color-on-emphasis); }
:host([variant="primary"]:not([disabled]):not([loading])) button:hover { background: var(--bucks-color-accent-emphasis-hover); }
:host([variant="danger"]) button { background: var(--bucks-color-danger-emphasis); border-color: var(--bucks-color-danger-emphasis); color: var(--bucks-color-on-emphasis); }
:host([variant="danger"]:not([disabled]):not([loading])) button:hover { background: var(--bucks-color-danger-emphasis-hover); }
:host([variant="agent"]) button { background: var(--bucks-color-agent-emphasis); border-color: var(--bucks-color-agent-emphasis); color: var(--bucks-color-on-emphasis); }
:host([variant="agent"]:not([disabled]):not([loading])) button:hover { background: var(--bucks-color-agent-emphasis-hover); }
:host([variant="ghost"]) button { background: transparent; border-color: transparent; color: var(--bucks-color-fg-muted); }
:host([variant="ghost"]:not([disabled]):not([loading])) button:hover { background: var(--bucks-color-surface-3); color: var(--bucks-color-fg); }

:host([disabled]) button, :host([loading]) button { cursor: not-allowed; opacity: 0.5; }
::slotted([slot="icon"]) { width: 1em; height: 1em; flex: none; }
bucks-spinner { --bucks-spinner-size: 1em; }
`;

  build() {
    this._spinner = h('bucks-spinner', { hidden: true, label: 'Working' });
    this._button = h('button', { part: 'button', type: 'button', onclick: (/** @type {MouseEvent} */ e) => this._onClick(e) },
      this._spinner, h('slot', { name: 'icon' }), h('slot'));
    return this._button;
  }

  sync() {
    const b = /** @type {HTMLButtonElement} */ (this._button);
    const off = this.bool('disabled') || this.bool('loading');
    b.disabled = this.bool('disabled');
    b.setAttribute('aria-disabled', String(off));
    b.toggleAttribute('aria-busy', this.bool('loading'));
    /** @type {HTMLElement} */ (this._spinner).hidden = !this.bool('loading');
    const label = this.getAttribute('label');
    if (label) b.setAttribute('aria-label', label); else b.removeAttribute('aria-label');
    this.toggleAttr('icon-only', Boolean(label) && !this.textContent?.trim());
  }

  /** @param {MouseEvent} e */
  _onClick(e) {
    if (this.bool('disabled') || this.bool('loading')) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (this.getAttribute('type') === 'submit') this.closest('form')?.requestSubmit();
  }
}

define('bucks-button', BucksButton);
