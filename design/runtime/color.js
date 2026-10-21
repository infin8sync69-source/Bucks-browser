// @ts-check
// Token colours for code that cannot use CSS variables: <canvas> drawing, generated SVG.
// Reads the theme from the nearest data-theme (as the CSS does) and the values from the generated
// token data, so canvases follow the same palette and theme as the rest of the UI.

import { colors } from '../dist/tokens.js';

/** @typedef {import('../dist/tokens.js').Theme} Theme */
/** @typedef {import('../dist/tokens.js').ColorToken} ColorToken */

/**
 * The theme in effect for an element: its nearest data-theme ("system" follows the OS), else dark.
 * @param {Element | null} [el]
 * @returns {Theme}
 */
export function themeOf(el = globalThis.document?.documentElement ?? null) {
  const attr = el?.closest?.('[data-theme]')?.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  if (attr === 'system' && globalThis.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

/**
 * A token colour as a CSS rgba value, at `alpha` times the token's own opacity.
 * @param {ColorToken} name e.g. 'fg', 'agent', 'cat-sky'
 * @param {number} [alpha]
 * @param {Theme} [theme]
 */
export function tokenRgba(name, alpha = 1, theme = themeOf()) {
  const c = colors[theme]?.[name];
  if (!c) throw new Error(`Unknown colour token "${name}"`);
  const [r, g, b] = c.rgb;
  const a = Math.round(Math.max(0, Math.min(1, c.alpha * alpha)) * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${a})`; // tokens-ignore: this is the helper that turns tokens into canvas colours
}
