// @ts-check
// <bucks-app-install>: install an app. Step 1, where from: an ipfs:// or ipns:// address, a local
// folder, or a site this browser hosts. Step 2, the review: what the app is and asks for (each
// permission can be left off), its warnings. Nothing is installed or pinned before "Install".
// Dispatches `installed` with the app summary.

import { BucksElement, define, emit, h } from '../../../design/components/index.js';
import { appsApi, errorText, size, sourceLabel, shortCid } from './shared.js';

export class BucksAppInstall extends BucksElement {
  static styles = `
.step { display: flex; flex-direction: column; gap: calc(var(--bucks-space-unit) * 4); }
.row { display: flex; gap: calc(var(--bucks-space-unit) * 2); align-items: flex-end; }
.row bucks-field { flex: 1; }
.or { font-size: var(--bucks-font-size-xs); color: var(--bucks-color-fg-faint); text-transform: uppercase; letter-spacing: var(--bucks-font-tracking-caps); }
.sites { display: flex; flex-direction: column; gap: calc(var(--bucks-space-unit) * 2); }
.site { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--bucks-space-unit) * 3); }
.site span { font-size: var(--bucks-font-size-md); color: var(--bucks-color-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head { display: flex; gap: calc(var(--bucks-space-unit) * 3); align-items: center; }
.head h3 { margin: 0; font-size: var(--bucks-font-size-lg); font-weight: var(--bucks-font-weight-semibold); }
.meta { font-size: var(--bucks-font-size-xs); color: var(--bucks-color-fg-subtle); }
.desc { margin: 0; font-size: var(--bucks-font-size-md); color: var(--bucks-color-fg-muted); }
.section { font-size: var(--bucks-font-size-xs); font-weight: var(--bucks-font-weight-semibold); color: var(--bucks-color-fg-subtle); text-transform: uppercase; letter-spacing: var(--bucks-font-tracking-wider); margin: 0; }
.busy { display: flex; align-items: center; gap: calc(var(--bucks-space-unit) * 3); color: var(--bucks-color-fg-muted); font-size: var(--bucks-font-size-md); }
`;

  constructor() {
    super();
    /** @type {import('./shared.js').AppReview | null} */
    this.review = null;
    /** @type {Set<string>} */
    this.granted = new Set();
    this.api = appsApi();
    /** @type {(() => void) | null} */
    this._unsubscribe = null;
  }

  build() {
    this._dialog = h('bucks-dialog', { heading: 'Install an app', description: 'Apps run in their own container: their own storage, and only the network and features you allow.' });
    this._body = h('div');
    this._actions = h('div', { slot: 'actions', style: 'display:contents' });
    this._dialog.append(this._body, this._actions);
    this._dialog.addEventListener('close', () => this._reset());
    return this._dialog;
  }

  /** Open at step 1. */
  async open() {
    this._reset();
    /** @type {any} */ (this._dialog).show();
    this._unsubscribe = this.api?.onEvent?.((ev) => { if (ev.type === 'progress' && this._busyText) this._busyText.textContent = ev.message; }) ?? null;
    await this._renderSource();
  }

  _reset() {
    this.review = null;
    this.granted = new Set();
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  /** @param {string} message */
  _busy(message) {
    this._busyText = h('span', { text: message });
    /** @type {HTMLElement} */ (this._body).replaceChildren(h('div', { class: 'busy', role: 'status' }, h('bucks-spinner'), this._busyText));
    /** @type {HTMLElement} */ (this._actions).replaceChildren(h('bucks-button', { variant: 'ghost', onclick: () => /** @type {any} */ (this._dialog).close('cancel') }, 'Cancel'));
  }

  /** @param {string} [error] */
  async _renderSource(error) {
    const address = h('bucks-field', { label: 'Address', placeholder: 'ipns://k51… or ipfs://bafy…', type: 'url', name: 'address' });
    const review = () => this._inspect({ address: /** @type {any} */ (address).value.trim() });
    address.addEventListener('keydown', (e) => { if (/** @type {KeyboardEvent} */ (e).key === 'Enter') review(); });
    const folder = h('bucks-button', { variant: 'secondary', onclick: () => this._chooseFolder() }, h('bucks-icon', { slot: 'icon', name: 'folder' }), 'Choose a folder…');
    const sitesBox = h('div', { class: 'sites' });
    const children = [
      error ? h('bucks-notice', { tone: 'danger', heading: 'That did not work', text: error }) : null,
      h('div', { class: 'row' }, address, h('bucks-button', { variant: 'primary', onclick: review }, 'Review')),
      h('p', { class: 'or', text: 'Or' }),
      h('div', null, folder),
      sitesBox,
    ];
    /** @type {HTMLElement} */ (this._body).replaceChildren(h('div', { class: 'step' }, ...children));
    /** @type {HTMLElement} */ (this._actions).replaceChildren(h('bucks-button', { variant: 'ghost', onclick: () => /** @type {any} */ (this._dialog).close('cancel') }, 'Cancel'));
    try {
      const hosted = (await this.api.hostedSites()).filter((s) => s.cid);
      if (hosted.length) {
        sitesBox.append(h('p', { class: 'section', text: 'Sites you host' }), ...hosted.map((s) => h('div', { class: 'site' },
          h('span', { text: s.name }),
          h('bucks-button', { size: 'sm', variant: 'secondary', onclick: () => this._inspect({ siteId: s.id }) }, 'Review'))));
      }
    } catch { /* hosting unavailable: no list */ }
    queueMicrotask(() => /** @type {any} */ (address).focus?.());
  }

  async _chooseFolder() {
    try {
      const chosen = await this.api.chooseFolder();
      if (chosen) await this._inspect({ folderToken: chosen.token });
    } catch (e) {
      await this._renderSource(errorText(e));
    }
  }

  /** @param {{ address: string } | { folderToken: string } | { siteId: string }} source */
  async _inspect(source) {
    if ('address' in source && !source.address) { await this._renderSource('Enter an address first.'); return; }
    this._busy('Finding the app');
    try {
      this.review = await this.api.inspect(source);
      this.granted = new Set(this.review.permissions.map((p) => p.id));
      this._renderReview();
    } catch (e) {
      await this._renderSource(errorText(e));
    }
  }

  _renderReview() {
    const r = /** @type {import('./shared.js').AppReview} */ (this.review);
    const src = sourceLabel(r.source);
    const perms = h('bucks-permission-list', { editable: true, 'empty-text': 'This app asks for nothing: no network, no devices, no access to your node.' });
    /** @type {any} */ (perms).items = r.permissions.map((p) => ({ ...p, granted: true }));
    perms.addEventListener('permission-change', (e) => {
      const { id, granted } = /** @type {CustomEvent} */ (e).detail;
      if (granted) this.granted.add(id); else this.granted.delete(id);
    });
    const body = h('div', { class: 'step' },
      h('div', { class: 'head' },
        h('bucks-icon', { name: 'package', size: '28' }),
        h('div', null,
          h('h3', { text: r.name }),
          h('div', { class: 'meta', text: [r.version && `Version ${r.version}`, size(r.size), shortCid(r.cid)].filter(Boolean).join(' · ') }))),
      h('div', null, h('bucks-badge', { tone: src.tone, text: src.text })),
      r.description ? h('p', { class: 'desc', text: r.description }) : null,
      r.alreadyInstalled ? h('bucks-notice', { tone: 'info', heading: 'Already installed', text: 'Installing replaces the installed version. Its data stays.' }) : null,
      ...r.warnings.map((w) => h('bucks-notice', { tone: 'warning', text: w })),
      h('p', { class: 'section', text: 'What it asks for' }),
      perms);
    /** @type {HTMLElement} */ (this._body).replaceChildren(body);
    /** @type {HTMLElement} */ (this._actions).replaceChildren(
      h('bucks-button', { variant: 'ghost', onclick: () => this._renderSource() }, 'Back'),
      h('bucks-button', { variant: 'primary', onclick: () => this._install() }, h('bucks-icon', { slot: 'icon', name: 'check' }), `Install ${r.name}`));
  }

  async _install() {
    const r = /** @type {import('./shared.js').AppReview} */ (this.review);
    this._busy(`Installing ${r.name}`);
    try {
      const app = await this.api.install(r.token, [...this.granted]);
      /** @type {any} */ (this._dialog).close('installed');
      emit(this, 'installed', app);
    } catch (e) {
      await this._renderSource(errorText(e));
    }
  }
}

define('bucks-app-install', BucksAppInstall);
