// @ts-check
// <bucks-dialog heading="Install Notes?" open>
//   body …
//   <bucks-button slot="actions">Cancel</bucks-button>
// </bucks-dialog>
// A modal dialog on the native <dialog> element: top layer, focus kept inside, Escape closes.
// show() / close(returnValue); `close` is dispatched from the host with { returnValue }.

import { BucksElement, define, emit, h, uid } from './base.js';

export class BucksDialog extends BucksElement {
  static observedAttributes = ['open', 'heading', 'description'];
  static styles = `
:host { display: contents; }
dialog {
  width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 64px); padding: 0; overflow: hidden;
  color: var(--bucks-color-fg); background: var(--bucks-color-surface-raised);
  border: var(--bucks-size-hairline) solid var(--bucks-color-line-strong); border-radius: var(--bucks-radius-2xl);
  box-shadow: var(--bucks-shadow-dialog);
}
dialog[open] { display: flex; flex-direction: column; }
dialog::backdrop { background: color-mix(in srgb, var(--bucks-color-scrim) 60%, transparent); backdrop-filter: blur(var(--bucks-blur-sm)); }
header { padding: calc(var(--bucks-space-unit) * 5) calc(var(--bucks-space-unit) * 6) 0; }
h2 { margin: 0; font-size: var(--bucks-font-size-lg); font-weight: var(--bucks-font-weight-semibold); }
header p { margin: calc(var(--bucks-space-unit) * 1.5) 0 0; font-size: var(--bucks-font-size-sm); color: var(--bucks-color-fg-subtle); }
.body { padding: calc(var(--bucks-space-unit) * 4) calc(var(--bucks-space-unit) * 6); overflow-y: auto; font-size: var(--bucks-font-size-md); line-height: var(--bucks-font-leading-relaxed); }
footer { display: flex; justify-content: flex-end; gap: calc(var(--bucks-space-unit) * 2); padding: calc(var(--bucks-space-unit) * 4) calc(var(--bucks-space-unit) * 6);
  border-top: var(--bucks-size-hairline) solid var(--bucks-color-line-subtle); background: var(--bucks-color-surface-1); }
`;

  build() {
    const id = uid('dialog');
    this._heading = h('h2', { id: `${id}-h` });
    this._description = h('p', { id: `${id}-d` });
    this._dialog = h('dialog', { part: 'dialog', 'aria-labelledby': `${id}-h`, 'aria-describedby': `${id}-d` },
      h('header', null, this._heading, this._description),
      h('div', { class: 'body', part: 'body' }, h('slot')),
      h('footer', { part: 'actions' }, h('slot', { name: 'actions' })));
    this._dialog.addEventListener('close', () => {
      this._syncing = true;
      this.removeAttribute('open');
      this._syncing = false;
      emit(this, 'close', { returnValue: /** @type {HTMLDialogElement} */ (this._dialog).returnValue });
    });
    return this._dialog;
  }

  sync() {
    const d = /** @type {HTMLDialogElement} */ (this._dialog);
    /** @type {HTMLElement} */ (this._heading).textContent = this.str('heading');
    const description = this.str('description');
    /** @type {HTMLElement} */ (this._description).textContent = description;
    /** @type {HTMLElement} */ (this._description).hidden = !description;
    if (this._syncing) return;
    if (this.bool('open') && !d.open) d.showModal();
    else if (!this.bool('open') && d.open) d.close();
  }

  get open() { return this.bool('open'); }

  show() { this.setAttribute('open', ''); }

  /** @param {string} [returnValue] */
  close(returnValue = '') {
    const d = /** @type {HTMLDialogElement | undefined} */ (this._dialog);
    if (d?.open) d.close(returnValue);
    else this.removeAttribute('open');
  }
}

define('bucks-dialog', BucksDialog);
