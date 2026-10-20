// @ts-check
// Form controls: <bucks-field>, <bucks-switch>, <bucks-progress>.

import { BucksElement, define, emit, h, uid } from './base.js';

/**
 * <bucks-field label="Address" placeholder="ipns://…" type="url" message="Help text" invalid multiline required>
 * A labelled text input. `value` is a property; `input` events bubble out of the shadow root as
 * usual and `change` is re-dispatched from the host. `invalid` turns the message into an error.
 */
export class BucksField extends BucksElement {
  static observedAttributes = ['label', 'placeholder', 'type', 'message', 'invalid', 'disabled', 'required', 'name', 'multiline', 'value'];

  constructor() {
    super();
    /** @type {string | undefined} */
    this._pendingValue = undefined;
    /** @type {string | null | undefined} */
    this._lastValueAttr = undefined;
  }
  static shadowOptions = /** @type {ShadowRootInit} */ ({ mode: 'open', delegatesFocus: true });
  static styles = `
:host { display: block; }
label { display: block; margin-bottom: calc(var(--bucks-space-unit) * 1.5); font-size: var(--bucks-font-size-xs); font-weight: var(--bucks-font-weight-medium); color: var(--bucks-color-fg-muted); }
input, textarea {
  width: 100%; font: inherit; font-size: var(--bucks-font-size-md); color: var(--bucks-color-fg);
  background: var(--bucks-color-surface-2); border: var(--bucks-size-hairline) solid var(--bucks-color-line-strong);
  border-radius: var(--bucks-radius-lg); padding: calc(var(--bucks-space-unit) * 2.5) calc(var(--bucks-space-unit) * 3);
  transition: border-color var(--bucks-duration-fast) var(--bucks-easing-standard);
}
textarea { min-height: 96px; resize: vertical; }
input::placeholder, textarea::placeholder { color: var(--bucks-color-fg-faint); }
input:focus, textarea:focus { outline: none; border-color: var(--bucks-color-focus); }
input:disabled, textarea:disabled { opacity: 0.5; }
:host([invalid]) input, :host([invalid]) textarea { border-color: var(--bucks-color-danger); }
.message { margin-top: calc(var(--bucks-space-unit) * 1.5); font-size: var(--bucks-font-size-xs); color: var(--bucks-color-fg-subtle); }
:host([invalid]) .message { color: var(--bucks-color-danger-fg); }
`;

  build() {
    const id = uid('field');
    this._label = h('label', { for: id, part: 'label' });
    this._message = h('div', { class: 'message', id: `${id}-msg`, part: 'message' });
    const multiline = this.bool('multiline');
    this._input = multiline
      ? h('textarea', { id, part: 'input', 'aria-describedby': `${id}-msg` })
      : h('input', { id, part: 'input', 'aria-describedby': `${id}-msg` });
    this._input.addEventListener('change', () => emit(this, 'change', { value: this.value }));
    if (this._pendingValue !== undefined) this._input.value = this._pendingValue;
    return [this._label, this._input, this._message];
  }

  sync() {
    const input = /** @type {HTMLInputElement} */ (this._input);
    /** @type {HTMLElement} */ (this._label).textContent = this.str('label');
    /** @type {HTMLElement} */ (this._label).hidden = !this.str('label');
    if (input instanceof HTMLInputElement) input.type = this.str('type', 'text');
    input.placeholder = this.str('placeholder');
    input.disabled = this.bool('disabled');
    input.required = this.bool('required');
    input.name = this.str('name');
    input.setAttribute('aria-invalid', String(this.bool('invalid')));
    if (this.hasAttribute('value') && this._lastValueAttr !== this.getAttribute('value')) {
      this._lastValueAttr = this.getAttribute('value');
      input.value = this._lastValueAttr ?? '';
    }
    const message = this.str('message');
    /** @type {HTMLElement} */ (this._message).textContent = message;
    /** @type {HTMLElement} */ (this._message).hidden = !message;
    /** @type {HTMLElement} */ (this._message).setAttribute('role', this.bool('invalid') ? 'alert' : 'none');
  }

  /** @returns {string} */
  get value() { return this._input ? /** @type {HTMLInputElement} */ (this._input).value : (this._pendingValue ?? ''); }
  /** @param {unknown} v */
  set value(v) {
    if (this._input) /** @type {HTMLInputElement} */ (this._input).value = String(v ?? '');
    else this._pendingValue = String(v ?? '');
  }
}

/**
 * <bucks-switch label="Notifications" checked disabled>
 * A switch (role=switch). Toggling dispatches `change` with { checked }; cancel it to refuse.
 */
export class BucksSwitch extends BucksElement {
  static observedAttributes = ['checked', 'disabled', 'label'];
  static shadowOptions = /** @type {ShadowRootInit} */ ({ mode: 'open', delegatesFocus: true });
  static styles = `
:host { display: inline-flex; }
button { all: unset; box-sizing: border-box; cursor: pointer; width: 36px; height: 20px; border-radius: var(--bucks-radius-full);
  background: var(--bucks-color-surface-6); position: relative; transition: background-color var(--bucks-duration-fast) var(--bucks-easing-standard); }
button::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: var(--bucks-radius-full);
  background: var(--bucks-color-fg); transition: transform var(--bucks-duration-fast) var(--bucks-easing-standard); box-shadow: var(--bucks-shadow-sm); }
button[aria-checked="true"] { background: var(--bucks-color-accent-emphasis); }
button[aria-checked="true"]::after { transform: translateX(16px); background: var(--bucks-color-on-emphasis); }
button:focus-visible { outline: 2px solid var(--bucks-color-focus); outline-offset: 2px; }
button:disabled { cursor: not-allowed; opacity: 0.5; }
`;

  build() {
    this._button = h('button', { role: 'switch', part: 'switch', type: 'button', onclick: () => this.toggle() });
    return this._button;
  }

  sync() {
    const b = /** @type {HTMLButtonElement} */ (this._button);
    b.setAttribute('aria-checked', String(this.checked));
    b.disabled = this.bool('disabled');
    const label = this.getAttribute('label');
    if (label) b.setAttribute('aria-label', label); else b.removeAttribute('aria-label');
  }

  get checked() { return this.bool('checked'); }
  set checked(v) { this.toggleAttr('checked', Boolean(v)); }

  /** Flip the switch as a user would (fires `change`, which a listener may cancel). */
  toggle() {
    if (this.bool('disabled')) return;
    const next = !this.checked;
    if (emit(this, 'change', { checked: next })) this.checked = next;
  }
}

/** <bucks-progress value="40" max="100" label="Installing"></bucks-progress>  No value: indeterminate. */
export class BucksProgress extends BucksElement {
  static observedAttributes = ['value', 'max', 'label'];
  static styles = `
:host { display: block; }
.track { height: 6px; border-radius: var(--bucks-radius-full); background: var(--bucks-color-surface-4); overflow: hidden; }
.bar { height: 100%; border-radius: inherit; background: var(--bucks-color-accent); transition: width var(--bucks-duration-base) var(--bucks-easing-standard); }
.bar.indeterminate { width: 40%; animation: bucks-indeterminate var(--bucks-duration-ambient) var(--bucks-easing-in-out) infinite; }
@keyframes bucks-indeterminate { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
`;

  build() {
    this._bar = h('div', { class: 'bar' });
    this._track = h('div', { class: 'track', role: 'progressbar', part: 'track' }, this._bar);
    return this._track;
  }

  sync() {
    const track = /** @type {HTMLElement} */ (this._track);
    const bar = /** @type {HTMLElement} */ (this._bar);
    const max = Number(this.getAttribute('max')) > 0 ? Number(this.getAttribute('max')) : 100;
    const raw = this.getAttribute('value');
    const value = raw === null || raw === '' ? null : Math.min(max, Math.max(0, Number(raw) || 0));
    track.setAttribute('aria-label', this.str('label', 'Progress'));
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(max));
    if (value === null) {
      track.removeAttribute('aria-valuenow');
      bar.classList.add('indeterminate');
      bar.style.width = '';
    } else {
      track.setAttribute('aria-valuenow', String(value));
      bar.classList.remove('indeterminate');
      bar.style.width = `${(value / max) * 100}%`;
    }
  }
}

define('bucks-field', BucksField);
define('bucks-switch', BucksSwitch);
define('bucks-progress', BucksProgress);
