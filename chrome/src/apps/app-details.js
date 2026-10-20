// @ts-check
// <bucks-app-details>: one installed app. Permissions (each can be turned off or back on), its agent
// tools, version and addresses, and the actions: check for and review an update, roll back,
// publish (folder apps), uninstall (asks first). Dispatches `changed`.

import { BucksElement, define, emit, h } from '../../../design/components/index.js';
import { appsApi, errorText, sourceLabel, shortCid } from './shared.js';

/** The nodes of a list that may hold nulls (conditional buttons). @param {...(Node | null)} list @returns {Node[]} */
const nodes = (...list) => /** @type {Node[]} */ (list.filter((n) => n !== null));

export class BucksAppDetails extends BucksElement {
  static styles = `
.step { display: flex; flex-direction: column; gap: calc(var(--bucks-space-unit) * 4); }
.section { font-size: var(--bucks-font-size-xs); font-weight: var(--bucks-font-weight-semibold); color: var(--bucks-color-fg-subtle); text-transform: uppercase; letter-spacing: var(--bucks-font-tracking-wider); margin: 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: calc(var(--bucks-space-unit) * 1.5) calc(var(--bucks-space-unit) * 4); margin: 0; font-size: var(--bucks-font-size-sm); }
dt { color: var(--bucks-color-fg-subtle); }
dd { margin: 0; color: var(--bucks-color-fg-muted); overflow-wrap: anywhere; font-family: var(--bucks-font-family-mono); font-size: var(--bucks-font-size-xs); }
.tools { margin: 0; padding-left: calc(var(--bucks-space-unit) * 5); font-size: var(--bucks-font-size-sm); color: var(--bucks-color-fg-muted); }
.tools code { font-family: var(--bucks-font-family-mono); color: var(--bucks-color-agent-fg); }
.busy { display: flex; align-items: center; gap: calc(var(--bucks-space-unit) * 3); color: var(--bucks-color-fg-muted); font-size: var(--bucks-font-size-md); }
.spacer { flex: 1; }
`;

  constructor() {
    super();
    this.api = appsApi();
    /** @type {import('./shared.js').AppSummary | null} */
    this.app = null;
  }

  build() {
    this._dialog = h('bucks-dialog', { heading: 'App' });
    this._body = h('div');
    this._actions = h('div', { slot: 'actions', style: 'display:contents' });
    this._dialog.append(this._body, this._actions);
    return this._dialog;
  }

  /** @param {import('./shared.js').AppSummary} app */
  open(app) {
    this.app = app;
    /** @type {any} */ (this._dialog).show();
    this._render();
  }

  _changed() { emit(this, 'changed', this.app); }

  /** @param {string} message */
  _busy(message) {
    /** @type {HTMLElement} */ (this._body).replaceChildren(h('div', { class: 'busy', role: 'status' }, h('bucks-spinner'), h('span', { text: message })));
    /** @type {HTMLElement} */ (this._actions).replaceChildren();
  }

  /** @param {{ notice?: { tone: string, heading?: string, text: string } }} [opts] */
  _render(opts = {}) {
    const app = /** @type {import('./shared.js').AppSummary} */ (this.app);
    const d = /** @type {any} */ (this._dialog);
    d.setAttribute('heading', app.name);
    d.setAttribute('description', [app.version && `Version ${app.version}`, sourceLabel(app.source).text].filter(Boolean).join(' · '));
    const perms = h('bucks-permission-list', { editable: true, 'empty-text': 'This app asks for nothing.' });
    /** @type {any} */ (perms).items = app.permissions;
    perms.addEventListener('permission-change', async (e) => {
      const { id, granted } = /** @type {CustomEvent} */ (e).detail;
      try {
        this.app = await this.api.setPermission(app.id, id, granted);
        this._changed();
      } catch (err) {
        e.preventDefault();
        this._render({ notice: { tone: 'danger', text: errorText(err) } });
      }
    });
    const rows = [['App address', app.urls.app], ['Version', app.urls.ipfs], ...(app.urls.ipns ? [['Updates from', app.urls.ipns]] : [])];
    const body = h('div', { class: 'step' },
      opts.notice ? h('bucks-notice', { tone: opts.notice.tone, heading: opts.notice.heading, text: opts.notice.text }) : null,
      app.description ? h('p', { text: app.description }) : null,
      h('p', { class: 'section', text: 'Permissions' }),
      perms,
      app.tools.length ? h('p', { class: 'section', text: 'Tools for your agent' }) : null,
      app.tools.length ? h('ul', { class: 'tools' }, ...app.tools.map((t) => h('li', null, h('code', { text: t.name }), ` — ${t.description}`))) : null,
      h('p', { class: 'section', text: 'Details' }),
      h('dl', null, ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])));
    /** @type {HTMLElement} */ (this._body).replaceChildren(body);
    /** @type {HTMLElement} */ (this._actions).replaceChildren(...nodes(
      h('bucks-button', { variant: 'danger', onclick: () => this._confirmUninstall() }, h('bucks-icon', { slot: 'icon', name: 'trash' }), 'Uninstall'),
      h('span', { class: 'spacer' }),
      app.previousVersion ? h('bucks-button', { variant: 'ghost', onclick: () => this._rollback() }, h('bucks-icon', { slot: 'icon', name: 'undo' }), `Back to ${app.previousVersion.version || shortCid(app.previousVersion.cid)}`) : null,
      app.source.kind === 'folder' ? h('bucks-button', { variant: 'secondary', onclick: () => this._publish() }, h('bucks-icon', { slot: 'icon', name: 'upload' }), 'Host it') : null,
      app.canUpdate ? h('bucks-button', { variant: 'secondary', onclick: () => this._checkUpdate() }, h('bucks-icon', { slot: 'icon', name: 'refresh' }), app.source.kind === 'folder' ? 'Reload from folder' : 'Check for updates') : null,
      h('bucks-button', { variant: 'primary', onclick: () => this._launch() }, h('bucks-icon', { slot: 'icon', name: 'play' }), 'Open')));
  }

  async _launch() {
    try { await this.api.launch(/** @type {any} */ (this.app).id); /** @type {any} */ (this._dialog).close('open'); } catch (e) { this._render({ notice: { tone: 'danger', text: errorText(e) } }); }
  }

  async _checkUpdate() {
    const app = /** @type {import('./shared.js').AppSummary} */ (this.app);
    this._busy('Checking for a new version');
    try {
      const check = await this.api.checkUpdate(app.id);
      if (!check.available) { this._render({ notice: { tone: 'success', text: check.reason || 'This is the newest version.' } }); return; }
      this._renderUpdate(check);
    } catch (e) {
      this._render({ notice: { tone: 'danger', text: errorText(e) } });
    }
  }

  /** @param {import('../../../ui/src/lib/bridge').AppUpdateCheck} check */
  _renderUpdate(check) {
    const added = h('bucks-permission-list', { 'empty-text': 'No new permissions.' });
    /** @type {any} */ (added).items = check.added || [];
    /** @type {HTMLElement} */ (this._body).replaceChildren(h('div', { class: 'step' },
      h('bucks-notice', { tone: (check.added || []).length ? 'warning' : 'info', heading: `Version ${check.version || shortCid(check.cid || '')} is available`, text: (check.added || []).length ? 'It asks for more than the installed version. Updating allows the new permissions below.' : 'It asks for nothing new.' }),
      ...(check.warnings || []).map((w) => h('bucks-notice', { tone: 'warning', text: w })),
      h('p', { class: 'section', text: 'New permissions' }),
      added,
      (check.removed || []).length ? h('p', { text: `No longer asked for: ${(check.removed || []).map((p) => p.label).join(', ')}.` }) : null));
    /** @type {HTMLElement} */ (this._actions).replaceChildren(
      h('bucks-button', { variant: 'ghost', onclick: () => this._render() }, 'Not now'),
      h('bucks-button', { variant: 'primary', onclick: () => this._applyUpdate() }, 'Update'));
  }

  async _applyUpdate() {
    const app = /** @type {import('./shared.js').AppSummary} */ (this.app);
    this._busy('Updating');
    try {
      const r = await this.api.update(app.id, true);
      if (r.app) this.app = r.app;
      this._changed();
      this._render({ notice: { tone: 'success', text: `Updated to ${this.app?.version || 'the new version'}.` } });
    } catch (e) {
      this._render({ notice: { tone: 'danger', text: errorText(e) } });
    }
  }

  async _rollback() {
    this._busy('Going back');
    try {
      this.app = await this.api.rollback(/** @type {any} */ (this.app).id);
      this._changed();
      this._render({ notice: { tone: 'success', text: `Back on version ${this.app?.version || ''}.` } });
    } catch (e) {
      this._render({ notice: { tone: 'danger', text: errorText(e) } });
    }
  }

  async _publish() {
    const app = /** @type {import('./shared.js').AppSummary} */ (this.app);
    this._busy(`Publishing ${app.name} from this browser`);
    try {
      const r = await this.api.publish(app.id);
      this.app = r.app;
      this._changed();
      this._render({ notice: { tone: 'success', heading: 'Hosted from this browser', text: `Others can install it from ipns://${r.ipns}/ while Bucks runs here.` } });
    } catch (e) {
      this._render({ notice: { tone: 'danger', text: errorText(e) } });
    }
  }

  _confirmUninstall() {
    const app = /** @type {import('./shared.js').AppSummary} */ (this.app);
    /** @type {HTMLElement} */ (this._body).replaceChildren(h('bucks-notice', { tone: 'danger', heading: `Uninstall ${app.name}?`, text: 'Its window closes and everything it stored on this computer is deleted. Its files are unpinned unless another app or a site you host uses them.' }));
    /** @type {HTMLElement} */ (this._actions).replaceChildren(
      h('bucks-button', { variant: 'ghost', onclick: () => this._render() }, 'Keep it'),
      h('bucks-button', { variant: 'danger', onclick: () => this._uninstall() }, `Uninstall ${app.name}`));
  }

  async _uninstall() {
    const app = /** @type {import('./shared.js').AppSummary} */ (this.app);
    this._busy(`Uninstalling ${app.name}`);
    try {
      await this.api.uninstall(app.id);
      /** @type {any} */ (this._dialog).close('uninstalled');
      this._changed();
    } catch (e) {
      this._render({ notice: { tone: 'danger', text: errorText(e) } });
    }
  }
}

define('bucks-app-details', BucksAppDetails);
