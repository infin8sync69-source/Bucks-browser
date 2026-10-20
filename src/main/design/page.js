// Pages the main process renders itself (IPFS error pages, the gateway interstitial, exported
// documents) are styled from the same design tokens as the chrome. Each page is self-contained:
// it carries the token variables and the shared base styles in one <style> element, because its
// Content-Security-Policy allows inline styles and nothing else.

import { TOKENS_CSS, THEME_HEX } from './tokens.generated.js';

export { THEME_HEX };

/** Base styles for a centred card page: error pages and the gateway interstitial. */
export const CARD_PAGE_CSS = `
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bucks-color-canvas);color:var(--bucks-color-fg);font:var(--bucks-font-size-base)/var(--bucks-font-leading-normal) var(--bucks-font-family-sans)}
main{max-width:600px;padding:32px 36px;margin:24px;background:var(--bucks-color-surface-raised);border:var(--bucks-size-hairline) solid var(--bucks-color-line-strong);border-radius:var(--bucks-radius-2xl);box-shadow:var(--bucks-shadow-xl)}
h1{font-size:var(--bucks-font-size-xl);margin:0 0 12px}
p{margin:8px 0;color:var(--bucks-color-fg-muted)}
code{background:var(--bucks-color-canvas);border:var(--bucks-size-hairline) solid var(--bucks-color-line-strong);border-radius:var(--bucks-radius-md);padding:2px 6px;font-family:var(--bucks-font-family-mono);font-size:var(--bucks-font-size-sm);word-break:break-all}
a{color:var(--bucks-color-accent-fg)}
.muted{color:var(--bucks-color-fg-subtle);font-size:var(--bucks-font-size-sm)}
.row{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 6px}
.btn{display:inline-block;padding:9px 16px;border-radius:var(--bucks-radius-lg);border:var(--bucks-size-hairline) solid var(--bucks-color-line-emphasis);color:var(--bucks-color-fg);text-decoration:none}
.btn:hover{background:var(--bucks-color-surface-3)}
.btn.primary{background:var(--bucks-color-accent-emphasis);border-color:var(--bucks-color-accent-emphasis);color:var(--bucks-color-on-emphasis)}
.btn.primary:hover{background:var(--bucks-color-accent-emphasis-hover)}
.btn:focus-visible{outline:2px solid var(--bucks-color-focus);outline-offset:2px}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--bucks-color-line-emphasis);border-top-color:var(--bucks-color-accent-fg);border-radius:var(--bucks-radius-full);animation:bucks-spin var(--bucks-duration-slowest) linear infinite;vertical-align:-2px;margin-right:8px}
@keyframes bucks-spin{to{transform:rotate(360deg)}}
`;

/** Base styles for a long-form document (exported notes and reports). */
export const DOCUMENT_CSS = `
body{font:var(--bucks-font-size-base)/var(--bucks-font-leading-relaxed) var(--bucks-font-family-sans);color:var(--bucks-color-fg);background:var(--bucks-color-canvas-deep);max-width:760px;margin:40px auto;padding:0 24px}
h1{font-size:var(--bucks-font-size-3xl);margin:0 0 16px}h2{font-size:var(--bucks-font-size-2xl);margin:28px 0 10px}h3{font-size:var(--bucks-font-size-lg);margin:22px 0 8px}
pre{background:var(--bucks-color-surface-2);padding:12px 14px;border-radius:var(--bucks-radius-lg);overflow-x:auto;font-size:var(--bucks-font-size-sm)}
code{font-family:var(--bucks-font-family-mono);font-size:.92em}
table{border-collapse:collapse;margin:14px 0;width:100%}th,td{border:var(--bucks-size-hairline) solid var(--bucks-color-line-emphasis);padding:6px 10px;text-align:left}th{background:var(--bucks-color-surface-2)}
blockquote{margin:12px 0;padding:4px 14px;border-left:3px solid var(--bucks-color-line-emphasis);color:var(--bucks-color-fg-muted)}
a{color:var(--bucks-color-accent-fg)}hr{border:0;border-top:var(--bucks-size-hairline) solid var(--bucks-color-line-strong);margin:24px 0}
`;

/**
 * The <style> element for a page: the token variables, then `css`.
 * @param {string} css page styles written against var(--bucks-…)
 */
export function pageStyle(css) {
  return `<style>\n${TOKENS_CSS}\n${css}\n</style>`;
}
