// @ts-check
// <bucks-apps-page>: bucks://apps. The apps installed in this browser, each opened in its own Bucks
// container; installing (from an address, a folder or a hosted site) and managing them.

import { BucksElement, define, h } from '../../../design/components/index.js';
import { appsApi, errorText, sourceLabel } from './shared.js';
import './install-dialog.js';
import './app-details.js';

export class BucksAppsPage extends BucksElement {
  static styles = `
:host { display: block; }
.page { max-width: 980px; margin: 0 auto; padding: calc(var(--bucks-space-unit) * 10) calc(var(--bucks-space-unit) * 8); display: flex; flex-direction: column; gap: calc(var(--bucks-space-unit) * 6); }
header { display: flex; align-items: flex-end; gap: calc(var(--bucks-space-unit) * 4); }
header div { flex: 1; }
h1 { margin: 0; font-size: var(--bucks-font-size-2xl); font-weight: var(--bucks-font-weight-semibold); letter-spacing: var(--bucks-font-tracking-tight); }
header p { margin: calc(var(--bucks-space-unit) * 1.5) 0 0; font-size: var(--bucks-font-size-sm); color: var(--bucks-color-fg-subtle); max-width: 560px; line-height: var(--bucks-font-leading-relaxed); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: calc(var(--bucks-space-unit) * 4); }
.app { display: flex; flex-direction: column; gap: calc(var(--bucks-space-unit) * 3); height: 100%; }
.top { display: flex; gap: calc(var(--bucks-space-unit) * 3); align-items: center; }
.icon { width: 44px; height: 44px; flex: none; border-radius: var(--bucks-radius-xl); background: var(--bucks-color-surface-4); display: grid; place-items: center; color: var(--bucks-color-fg-muted); overflow: hidden; }
.icon img { width: 100%; height: 100%; object-fit: cover; }
.name { font-size: var(--bucks-font-size-md); font-weight: var(--bucks-font-weight-semibold); color: var(--bucks-color-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: var(--bucks-font-size-2xs); color: var(--bucks-color-fg-faint); }
.desc { margin: 0; flex: 1; font-size: var(--bucks-font-size-sm); line-height: var(--bucks-font-leading-relaxed); color: var(--bucks-color-fg-subtle); }
.badges { display: flex; gap: calc(var(--bucks-space-unit) * 1.5); flex-wrap: wrap; }
.actions { display: flex; gap: calc(var(--bucks-space-unit) * 2); }
.actions bucks-button { flex: 1; }
`;

  constructor() {
    super();
    this.api = appsApi();
    /** @type {(() => void) | null} */
    this._off = null;
  }

  build() {
    this._install = h('bucks-app-install');
    this._details = h('bucks-app-details');
    this._list = h('div', { class: 'grid', role: 'list', 'aria-label': 'Installed apps' });
    this._notice = h('div');
    this._install.addEventListener('installed', () => this.refresh());
    this._details.addEventListener('changed', () => this.refresh());
    const installButton = h('bucks-button', { variant: 'primary', onclick: () => /** @type {any} */ (this._install).open() }, h('bucks-icon', { slot: 'icon', name: 'plus' }), 'Install an app');
    return h('div', { class: 'page' },
      h('header', null,
        h('div', null,
          h('h1', { text: 'Apps' }),
          h('p', { text: 'Apps from IPFS, from a folder on this computer, or from a site you host. Each runs in its own container, keeps its own data, and gets only the network and features you allow.' })),
        installButton),
      this._notice,
      this._list,
      this._install,
      this._details);
  }

  connectedCallback() {
    super.connectedCallback();
    if (!this._off) this._off = this.api?.onEvent?.((ev) => { if (ev.type === 'changed') this.refresh(); }) ?? null;
    this.refresh();
  }

  disconnectedCallback() {
    this._off?.();
    this._off = null;
  }

  async refresh() {
    if (!this.api) return;
    let apps;
    try {
      apps = await this.api.list();
      /** @type {HTMLElement} */ (this._notice).replaceChildren();
    } catch (e) {
      /** @type {HTMLElement} */ (this._notice).replaceChildren(h('bucks-notice', { tone: 'danger', text: errorText(e) }));
      return;
    }
    const list = /** @type {HTMLElement} */ (this._list);
    if (!apps.length) {
      list.replaceChildren(h('bucks-empty-state', { heading: 'No apps yet', style: 'grid-column: 1 / -1' },
        h('bucks-icon', { slot: 'icon', name: 'package', size: '24' }),
        'Install one from an ipns:// address someone shared, or from a folder with its built files (index.html at the top).',
        h('bucks-button', { slot: 'actions', variant: 'primary', onclick: () => /** @type {any} */ (this._install).open() }, 'Install an app')));
      return;
    }
    list.replaceChildren(...apps.map((app) => this._card(app)));
  }

  /** @param {import('./shared.js').AppSummary} app */
  _card(app) {
    const icon = h('div', { class: 'icon' }, h('bucks-icon', { name: 'package', size: '22' }));
    if (app.hasIcon) {
      this.api.icon(app.id).then((url) => {
        if (url && /^data:image\//.test(url)) icon.replaceChildren(h('img', { src: url, alt: '' }));
      }).catch(() => {});
    }
    const src = sourceLabel(app.source);
    const card = h('bucks-card', { role: 'listitem', 'aria-label': app.name, 'data-app-id': app.id },
      h('div', { class: 'app' },
        h('div', { class: 'top' }, icon, h('div', { style: 'min-width:0' },
          h('div', { class: 'name', text: app.name }),
          h('div', { class: 'meta', text: app.version ? `Version ${app.version}` : 'No version' }))),
        h('div', { class: 'badges' },
          h('bucks-badge', { tone: src.tone, text: src.text }),
          app.running ? h('bucks-badge', { tone: 'success', dot: true, text: 'Running' }) : null,
          app.pendingUpdate ? h('bucks-badge', { tone: 'warning', text: 'Update ready' }) : null,
          app.tools.length ? h('bucks-badge', { tone: 'agent', text: `${app.tools.length} agent tool${app.tools.length === 1 ? '' : 's'}` }) : null),
        h('p', { class: 'desc', text: app.description || 'No description.' }),
        h('div', { class: 'actions' },
          h('bucks-button', { variant: 'primary', size: 'sm', onclick: () => this._launch(app) }, h('bucks-icon', { slot: 'icon', name: 'play' }), 'Open'),
          h('bucks-button', { variant: 'secondary', size: 'sm', onclick: () => /** @type {any} */ (this._details).open(app) }, 'Details'))));
    return card;
  }

  /** @param {import('./shared.js').AppSummary} app */
  async _launch(app) {
    try { await this.api.launch(app.id); } catch (e) {
      /** @type {HTMLElement} */ (this._notice).replaceChildren(h('bucks-notice', { tone: 'danger', heading: `${app.name} could not open`, text: errorText(e) }));
    }
  }
}

define('bucks-apps-page', BucksAppsPage);
