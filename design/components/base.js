// @ts-check
// The base of every Bucks web component: framework-free custom elements that work the same in the
// Svelte chrome, the framework-free chrome that replaces it, and any page Bucks serves.
//
// Rules (docs/DESIGN-SYSTEM.md): styles come only from design tokens (var(--bucks-…)); text goes
// into the DOM as text, never as HTML; each component builds its shadow DOM once and then syncs it
// when an attribute changes, so focus and caret survive updates.

/** Styles every component shares: box model, font, focus ring. */
export const BASE_CSS = `
:host { box-sizing: border-box; font-family: var(--bucks-font-family-sans); color: var(--bucks-color-fg); }
*, *::before, *::after { box-sizing: inherit; }
:focus-visible { outline: 2px solid var(--bucks-color-focus); outline-offset: 2px; }
[hidden] { display: none !important; }
`;

/** @type {WeakMap<Function, CSSStyleSheet>} */
const sheets = new WeakMap();

/** One constructed stylesheet per component class, shared by all its instances. @param {Function} ctor */
function sheetFor(ctor) {
  let sheet = sheets.get(ctor);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(`${BASE_CSS}\n${/** @type {any} */ (ctor).styles || ''}`);
    sheets.set(ctor, sheet);
  }
  return sheet;
}

/**
 * Create an element. Props: `class`, `part`, `text` (textContent), `on<event>` (listeners),
 * booleans (present when true), everything else as an attribute. Children: nodes or strings
 * (strings become text nodes: no HTML parsing, ever).
 * @template {string} K
 * @param {K} tag
 * @param {Record<string, any> | null} [props]
 * @param {...(Node | string | null | undefined | false)} children
 * @returns {K extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[K] : HTMLElement}
 */
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return /** @type {any} */ (el);
}

/**
 * Register a component once (several bundles may load the library).
 * @param {string} name
 * @param {CustomElementConstructor} ctor
 */
export function define(name, ctor) {
  if (!customElements.get(name)) customElements.define(name, ctor);
}

/**
 * Dispatch an event that crosses shadow boundaries. Returns false when a listener cancelled it.
 * @param {EventTarget} target @param {string} type @param {unknown} [detail]
 */
export function emit(target, type, detail) {
  return target.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable: true }));
}

let nextId = 0;
/** A document-unique id for aria wiring inside a shadow root. @param {string} prefix */
export const uid = (prefix) => `${prefix}-${(nextId += 1)}`;

export class BucksElement extends HTMLElement {
  /** CSS for this component, written against var(--bucks-…). */
  static styles = '';
  /** @type {ShadowRootInit} */
  static shadowOptions = { mode: 'open' };

  constructor() {
    super();
    const ctor = /** @type {typeof BucksElement} */ (this.constructor);
    const root = this.attachShadow(ctor.shadowOptions);
    root.adoptedStyleSheets = [sheetFor(ctor)];
    /** @type {boolean} */
    this._built = false;
  }

  connectedCallback() {
    if (!this._built) {
      this._built = true;
      const nodes = this.build();
      /** @type {ShadowRoot} */ (this.shadowRoot).replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]));
    }
    this.sync();
  }

  attributeChangedCallback() {
    if (this._built) this.sync();
  }

  /** Build the shadow DOM once. @returns {Node | Node[]} */
  build() { return []; }

  /** Bring the shadow DOM in line with the attributes and properties. */
  sync() {}

  /** @param {string} name */
  bool(name) { return this.hasAttribute(name); }

  /** @param {string} name @param {string} [fallback] */
  str(name, fallback = '') { return this.getAttribute(name) ?? fallback; }

  /** Set or remove a boolean attribute. @param {string} name @param {boolean} on */
  toggleAttr(name, on) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); }
}
