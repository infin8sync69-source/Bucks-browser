// The design-system linter: finds styling that bypasses the Bucks tokens. Pure: takes a file's
// text and kind, returns findings. scripts/lint-tokens.mjs walks the repository and reports.
//
// A line can opt out with a reason: `tokens-ignore: <why>` in a comment on that line or the line
// above (// …, /* … */ or <!-- … -->). A bare `tokens-ignore` without a reason is itself reported.

const HUES = 'white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const COLOR_UTILS = 'bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|divide|from|via|to|fill|stroke|shadow|placeholder|accent|caret|decoration';
const VARIANTS = '(?:[a-z0-9-]+(?:\\[[^\\]\\s]*\\])?:)*!?';

// Tailwind's palette: bg-zinc-900, text-white/70, hover:border-blue-500/[0.2]
const PALETTE_CLASS = new RegExp(`(?<![\\w-])${VARIANTS}(?:${COLOR_UTILS})-(?:${HUES})(?:-\\d{2,3})?(?:\\/(?:\\d+(?:\\.\\d+)?|\\[[^\\]\\s]+\\]))?(?![\\w-])`, 'g');
// Arbitrary values for things the design system owns. Geometry (w, h, inset, translate, ...) is allowed.
const OWNED_ARBITRARY = new RegExp(`(?<![\\w-])${VARIANTS}(?:${COLOR_UTILS}|text|font|tracking|leading|rounded(?:-[trblse]{1,2})?|blur|backdrop-[a-z-]+|drop-shadow|z|duration|delay|ease|opacity|p[trblxyse]?|m[trblxyse]?|-m[trblxyse]?|gap(?:-[xy])?|space-[xy])-\\[[^\\]\\s]+\\]`, 'g');
// A colour token with an arbitrary opacity: bg-surface-2/[0.06]. Use an integer percentage.
const ARBITRARY_ALPHA = new RegExp(`(?<![\\w-])${VARIANTS}(?:${COLOR_UTILS})-[a-z0-9-]+\\/\\[[^\\]\\s]+\\]`, 'g');
const RAW_Z = new RegExp(`(?<![\\w-])${VARIANTS}-?z-\\d+(?![\\w-])`, 'g');
const RAW_DURATION = new RegExp(`(?<![\\w-])${VARIANTS}(?:duration|delay)-\\d+(?![\\w-])`, 'g');
// Bare forms that mean "Tailwind's default": rounded, shadow, blur, backdrop-blur.
const BARE_SCALE = new RegExp(`(?<![\\w-])${VARIANTS}(?:rounded|shadow|blur|backdrop-blur|drop-shadow)(?![\\w-])(?!\\s*[:=(])`, 'g');

const RAW_COLOR = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
const NAMED_COLOR_DECL = /\b(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|border|outline(?:-color)?|fill|stroke|caret-color|text-decoration-color|box-shadow)\s*:\s*[^;"'}]*(?<![\w-])(?:white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink)(?![\w-])/gi;
// Design-owned CSS properties whose values must come from var(--bucks-…) or a keyword.
const OWNED_DECL = /\b(font-size|border-radius|box-shadow|z-index|letter-spacing|transition-duration|animation-duration)\s*:\s*([^;"'}]+)/gi;
const TIMED_DECL = /\b(transition|animation)\s*:\s*([^;"'}]+)/gi;
const BLUR_FN = /\bblur\(\s*[0-9.]+px\s*\)/g;
const JS_DURATION = /\bduration\s*:\s*\d+(?![\w.])/g;

const KEYWORD_VALUE = /^(?:inherit|initial|unset|revert|none|0|auto|normal|100%|50%|0px|1em|1|-1)$/i;

const IGNORE = /tokens-ignore(?::\s*(\S.*?))?\s*(?:\*\/|-->|$)/;

/**
 * @param {string} text file contents
 * @param {{ kind: 'markup'|'script'|'style'|'main' }} opts
 *   markup: .svelte/.html (classes, <style>, style=""); script: .ts/.js in the UI (class strings,
 *   colours, JS durations); style: .css; main: main-process code (raw colours only)
 * @returns {{ line: number, column: number, rule: string, match: string, message: string }[]}
 */
export function lintText(text, { kind }) {
  const lines = String(text).split('\n');
  const findings = [];
  const ignored = (i) => {
    for (const j of [i, i - 1]) {
      if (j < 0) continue;
      const m = IGNORE.exec(lines[j]);
      if (m && (j === i || /^\s*(\/\/|\/\*|<!--|\*)/.test(lines[j]))) return m[1] ? true : 'no-reason';
    }
    return false;
  };
  const add = (i, index, rule, match, message) => {
    const ig = ignored(i);
    if (ig === true) return;
    if (ig === 'no-reason') { findings.push({ line: i + 1, column: index + 1, rule: 'ignore-without-reason', match, message: 'tokens-ignore needs a reason: "tokens-ignore: <why>"' }); return; }
    findings.push({ line: i + 1, column: index + 1, rule, match, message });
  };
  const scan = (i, re, rule, message) => {
    re.lastIndex = 0;
    for (const m of lines[i].matchAll(re)) add(i, m.index, rule, m[0], typeof message === 'function' ? message(m) : message);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 5000) continue; // minified or generated data
    scan(i, RAW_COLOR, 'raw-color', 'Colour literal: use a semantic colour token (bg-surface-2, var(--bucks-color-fg), tokenRgba(...))');
    if (kind === 'main') continue;
    scan(i, NAMED_COLOR_DECL, 'raw-color', 'Named colour in CSS: use var(--bucks-color-…)');
    if (kind === 'markup' || kind === 'script') {
      scan(i, PALETTE_CLASS, 'palette-class', (m) => `Tailwind palette class "${m[0]}": use a semantic colour (see docs/DESIGN-SYSTEM.md)`);
      scan(i, OWNED_ARBITRARY, 'arbitrary-value', (m) => `Arbitrary value "${m[0]}" for a design-owned property: use a token utility`);
      scan(i, ARBITRARY_ALPHA, 'arbitrary-value', (m) => `Arbitrary opacity "${m[0]}": use an integer percentage (bg-surface-2/40) or a token`);
      scan(i, RAW_Z, 'raw-z-index', (m) => `Raw z-index "${m[0]}": use a layer token (z-raised, z-modal, …)`);
      scan(i, RAW_DURATION, 'raw-duration', (m) => `Raw duration "${m[0]}": use duration-fast / -base / -moderate / -slow`);
      // prose ("the shadow DOM", "a shadow root") is not a class
      if (!/^\s*(\/\/|\/?\*|<!--)/.test(line)) {
        BARE_SCALE.lastIndex = 0;
        for (const m of line.matchAll(BARE_SCALE)) {
          if (/^shadow\s+(dom|root|tree|boundar|host|part)/i.test(line.slice(m.index + m[0].length - 6))) continue;
          add(i, m.index, 'bare-scale', m[0], `"${m[0]}" without a size: name the token (rounded-sm, shadow-sm, blur-sm)`);
        }
      }
      scan(i, JS_DURATION, 'raw-duration', 'Animation duration in milliseconds: use duration.<name> from design/dist/tokens.js');
    }
    // CSS declarations (in .css, <style> blocks, style="" attributes and CSS-in-strings)
    OWNED_DECL.lastIndex = 0;
    for (const m of line.matchAll(OWNED_DECL)) {
      const value = m[2].trim().replace(/\s*!important$/, '');
      if (KEYWORD_VALUE.test(value) || /^var\(--bucks-/.test(value) || /^calc\(.*var\(--bucks-/.test(value)) continue;
      if (value.includes("{")) continue; // a template expression decides
      add(i, m.index, 'raw-css-value', m[0], `${m[1]} must use a token: var(--bucks-…)`);
    }
    TIMED_DECL.lastIndex = 0;
    for (const m of line.matchAll(TIMED_DECL)) {
      if (/\b\d+(?:\.\d+)?m?s\b/.test(m[2])) add(i, m.index, 'raw-duration', m[0], `${m[1]} with a literal time: use var(--bucks-duration-…)`);
    }
    scan(i, BLUR_FN, 'raw-css-value', 'blur() with a literal radius: use var(--bucks-blur-…)');
  }
  return findings;
}

/** Which rules apply to a path (relative, forward slashes), or null when the file is not checked. */
export function kindOf(rel) {
  if (/(^|\/)(node_modules|build|dist|\.svelte-kit)\//.test(rel)) return null;
  if (/tokens\.generated\.js$/.test(rel)) return null;
  if (rel.startsWith('ui/src/')) {
    if (/\.(svelte|html)$/.test(rel)) return 'markup';
    if (/\.(ts|js)$/.test(rel)) return 'script';
    if (/\.css$/.test(rel)) return 'style';
    return null;
  }
  if (rel.startsWith('design/components/') || rel.startsWith('design/runtime/') || rel.startsWith('design/gallery/') || rel.startsWith('chrome/src/')) {
    if (/\.(js|ts|html)$/.test(rel)) return rel.endsWith('.html') ? 'markup' : 'script';
    if (/\.css$/.test(rel)) return 'style';
    return null;
  }
  if ((rel.startsWith('src/main/') || rel.startsWith('src/preload/')) && /\.(js|cjs|mjs)$/.test(rel)) return 'main';
  return null;
}
