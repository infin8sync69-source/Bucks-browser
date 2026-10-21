// @ts-check
// <bucks-spinner label="Loading"></bucks-spinner>  Size: --bucks-spinner-size (default 16px).

import { BucksElement, define, h } from './base.js';

export class BucksSpinner extends BucksElement {
  static observedAttributes = ['label'];
  static styles = `
:host { display: inline-block; width: var(--bucks-spinner-size, 16px); height: var(--bucks-spinner-size, 16px); flex: none; }
span {
  display: block; width: 100%; height: 100%; border-radius: var(--bucks-radius-full);
  border: 2px solid var(--bucks-color-line-emphasis); border-top-color: currentColor;
  animation: bucks-spin var(--bucks-duration-slowest) linear infinite;
}
@keyframes bucks-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { span { animation-duration: calc(var(--bucks-duration-slowest) * 3); } }
`;

  build() {
    return h('span', { role: 'status', part: 'spinner' });
  }

  sync() {
    const span = /** @type {HTMLElement} */ (this.shadowRoot?.firstElementChild);
    span.setAttribute('aria-label', this.str('label', 'Loading'));
  }
}

define('bucks-spinner', BucksSpinner);
