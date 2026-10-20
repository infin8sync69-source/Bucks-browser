// @ts-check
// Containers and status: <bucks-card>, <bucks-badge>, <bucks-notice>, <bucks-empty-state>.

import { BucksElement, define, h } from './base.js';

const TONES = ['neutral', 'accent', 'agent', 'success', 'danger', 'warning', 'info'];

/** CSS that gives :host([tone=x]) the --tone (identity) and --tone-fg (text) of role x. */
const TONE_CSS = `
:host { --tone: var(--bucks-color-fg-subtle); --tone-fg: var(--bucks-color-fg-muted); }
${TONES.filter((t) => t !== 'neutral').map((t) => `:host([tone="${t}"]) { --tone: var(--bucks-color-${t}); --tone-fg: var(--bucks-color-${t}-fg-strong); }`).join('\n')}
`;

/**
 * <bucks-card interactive padding="none|sm|md|lg">…</bucks-card>
 * A glass surface. `interactive` adds hover feedback (the content carries the actual control).
 */
export class BucksCard extends BucksElement {
  static styles = `
:host {
  display: block; background: var(--bucks-color-surface-2); border: var(--bucks-size-hairline) solid var(--bucks-color-line);
  border-radius: var(--bucks-radius-2xl); padding: calc(var(--bucks-space-unit) * 4);
  transition: background-color var(--bucks-duration-fast) var(--bucks-easing-standard), border-color var(--bucks-duration-fast) var(--bucks-easing-standard);
}
:host([padding="none"]) { padding: 0; }
:host([padding="sm"]) { padding: calc(var(--bucks-space-unit) * 3); }
:host([padding="lg"]) { padding: calc(var(--bucks-space-unit) * 6); }
:host([interactive]:hover) { background: var(--bucks-color-surface-3); border-color: var(--bucks-color-line-strong); }
:host([selected]) { border-color: var(--bucks-color-accent); background: color-mix(in srgb, var(--bucks-color-accent) 8%, var(--bucks-color-surface-2)); }
`;
  build() { return h('slot'); }
}

/** <bucks-badge tone="success" dot>Running</bucks-badge> */
export class BucksBadge extends BucksElement {
  static observedAttributes = ['tone', 'dot'];
  static styles = `${TONE_CSS}
:host {
  display: inline-flex; align-items: center; gap: calc(var(--bucks-space-unit) * 1.5);
  padding: 1px calc(var(--bucks-space-unit) * 2); border-radius: var(--bucks-radius-full);
  font-size: var(--bucks-font-size-2xs); font-weight: var(--bucks-font-weight-medium); line-height: var(--bucks-font-leading-normal);
  color: var(--tone-fg); background: color-mix(in srgb, var(--tone) 14%, transparent);
  border: var(--bucks-size-hairline) solid color-mix(in srgb, var(--tone) 30%, transparent); white-space: nowrap;
}
i { width: 6px; height: 6px; border-radius: var(--bucks-radius-full); background: var(--tone); }
`;
  build() {
    this._dot = h('i', { 'aria-hidden': 'true', hidden: true });
    return [this._dot, h('slot')];
  }
  sync() { /** @type {HTMLElement} */ (this._dot).hidden = !this.bool('dot'); }
}

/**
 * <bucks-notice tone="warning" heading="Public key">Body text</bucks-notice>
 * An inline message. Danger notices are announced at once (role=alert), others politely.
 */
export class BucksNotice extends BucksElement {
  static observedAttributes = ['tone', 'heading'];
  static styles = `${TONE_CSS}
:host { --tone: var(--bucks-color-info); --tone-fg: var(--bucks-color-info-fg-strong); display: block; }
div {
  border: var(--bucks-size-hairline) solid color-mix(in srgb, var(--tone) 30%, transparent);
  background: color-mix(in srgb, var(--tone) 10%, transparent); border-radius: var(--bucks-radius-xl);
  padding: calc(var(--bucks-space-unit) * 3) calc(var(--bucks-space-unit) * 4);
  font-size: var(--bucks-font-size-sm); line-height: var(--bucks-font-leading-relaxed); color: var(--bucks-color-fg-muted);
}
strong { display: block; color: var(--tone-fg); font-weight: var(--bucks-font-weight-semibold); margin-bottom: var(--bucks-space-unit); }
`;
  build() {
    this._heading = h('strong', { part: 'heading' });
    this._box = h('div', { part: 'notice' }, this._heading, h('slot'));
    return this._box;
  }
  sync() {
    const heading = this.str('heading');
    /** @type {HTMLElement} */ (this._heading).textContent = heading;
    /** @type {HTMLElement} */ (this._heading).hidden = !heading;
    /** @type {HTMLElement} */ (this._box).setAttribute('role', this.str('tone') === 'danger' ? 'alert' : 'status');
  }
}

/** <bucks-empty-state heading="No apps yet"><svg slot="icon"/>Text<div slot="actions">…</div></bucks-empty-state> */
export class BucksEmptyState extends BucksElement {
  static observedAttributes = ['heading'];
  static styles = `
:host { display: flex; flex-direction: column; align-items: center; text-align: center; gap: calc(var(--bucks-space-unit) * 3); padding: calc(var(--bucks-space-unit) * 10) calc(var(--bucks-space-unit) * 6); }
.icon { width: 48px; height: 48px; display: grid; place-items: center; border-radius: var(--bucks-radius-2xl); background: var(--bucks-color-surface-3); color: var(--bucks-color-fg-subtle); }
h2 { margin: 0; font-size: var(--bucks-font-size-lg); font-weight: var(--bucks-font-weight-semibold); color: var(--bucks-color-fg); }
p { margin: 0; max-width: 420px; font-size: var(--bucks-font-size-sm); line-height: var(--bucks-font-leading-relaxed); color: var(--bucks-color-fg-subtle); }
.actions { display: flex; gap: calc(var(--bucks-space-unit) * 2); flex-wrap: wrap; justify-content: center; margin-top: calc(var(--bucks-space-unit) * 2); }
`;
  build() {
    this._h = h('h2');
    return [h('div', { class: 'icon', 'aria-hidden': 'true' }, h('slot', { name: 'icon' })), this._h, h('p', null, h('slot')), h('div', { class: 'actions' }, h('slot', { name: 'actions' }))];
  }
  sync() { /** @type {HTMLElement} */ (this._h).textContent = this.str('heading'); }
}

define('bucks-card', BucksCard);
define('bucks-badge', BucksBadge);
define('bucks-notice', BucksNotice);
define('bucks-empty-state', BucksEmptyState);
