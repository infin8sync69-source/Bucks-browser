// Rewrites Tailwind palette classes and one-off values to Bucks design tokens. Used once to
// migrate the Svelte chrome, and kept for code ported from Bucks Core, which uses the same
// classes. Pure: migrateText(text) → { text, changes, unknown }. scripts/migrate-tokens.mjs runs it.
//
// The mapping follows docs/DESIGN-SYSTEM.md. Text opacities below the readable minimum are raised
// to fg-faint (WCAG AA); a solid hue fill under white text becomes the *-emphasis tone that keeps
// white text readable.

const ROLE = { blue: 'accent', violet: 'agent', emerald: 'success', green: 'success', red: 'danger', amber: 'warning', yellow: 'warning', sky: 'info' };
const NEUTRAL = new Set(['zinc', 'gray', 'neutral', 'stone']);
const CATEGORICAL = new Set(['slate', 'orange', 'lime', 'teal', 'cyan', 'indigo', 'purple', 'fuchsia', 'pink', 'rose']);
const FOREGROUND_UTILS = new Set(['text', 'placeholder', 'caret', 'decoration', 'fill', 'stroke']);
const LINE_UTILS = /^(border(-[trblxyse])?|divide|ring|ring-offset|outline)$/;

const TOKEN = /(?<![\w\-[\]/.#])((?:[a-z0-9-]+(?:\[[^\]\s]*\])?:)*!?-?[a-z][a-z0-9-]*(?:-\[[^\]\s]+\])?(?:\/(?:\d+(?:\.\d+)?|\[[^\]\s]+\]))?)(?![\w\-[\]/(])/g; // never a CSS function: blur( drop-shadow(
const COLOR_CLASS = /^(bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|divide|from|via|to|fill|stroke|shadow|placeholder|accent|caret|decoration)-(white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-(\d{2,3}))?(?:\/(\d+(?:\.\d+)?|\[[^\]]+\]))?$/;

const SIZE_PX = [[9, '3xs'], [10, '3xs'], [11, '2xs'], [12, 'xs'], [13, 'sm'], [14, 'md'], [15, 'md'], [16, 'base'], [18, 'lg'], [20, 'xl'], [22, '2xl'], [24, '2xl'], [26, '3xl'], [28, '3xl'], [30, '3xl'], [36, '4xl'], [48, '5xl'], [60, '6xl'], [64, '6xl'], [72, '7xl']];
const NAMED_TEXT = { 'text-sm': 'text-md' }; // Tailwind's 14px is the token scale's md; sm is 13px
const RADIUS_PX = [[2, 'xs'], [4, 'sm'], [6, 'md'], [8, 'lg'], [12, 'xl'], [16, '2xl'], [18, '2xl'], [20, '2xl'], [24, '3xl'], [26, '3xl'], [28, '3xl'], [32, '4xl'], [40, '4xl']];
const Z = { '-1': 'behind', 0: 'base', 5: 'lift', 10: 'raised', 20: 'float', 30: 'dropdown', 40: 'popover', 50: 'popover', 110: 'chrome', 120: 'find-bar', 150: 'panel-backdrop', 160: 'panel', 200: 'dock', 300: 'drawer', 301: 'drawer-raised', 400: 'menu-backdrop', 401: 'menu', 498: 'modal-backdrop', 499: 'modal', 600: 'sheet-backdrop', 601: 'sheet' };
const DURATIONS = [[75, 'instant'], [100, 'instant'], [150, 'fast'], [200, 'base'], [250, 'base'], [300, 'moderate'], [400, 'moderate'], [500, 'slow'], [600, 'slow'], [700, 'slower'], [1000, 'slowest'], [2000, 'ambient']];
const SHADOWS = {
  '0_20px_60px_rgba(0,0,0,0.6)': 'float',
  '0_20px_50px_-15px_rgba(0,0,0,0.8)': 'menu',
  '0_25px_50px_-12px_rgba(0,0,0,0.9)': 'popover',
  '0_48px_120px_-20px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.04)': 'dialog',
  '0_30px_80px_rgba(139,92,246,0.15)': 'glow-agent',
  '0_20px_60px_-10px_var(--glow)': 'glow',
};
const INK = { '#030307': 'canvas-deep', '#04040a': 'canvas-deep', '#050507': 'canvas', '#07070a': 'canvas', '#0a0a0c': 'surface-raised', '#0c0c10': 'surface-raised', '#0d0d10': 'surface-raised', '#0d0d12': 'surface-raised', '#0d0d14': 'surface-raised', '#111117': 'surface-overlay', '#1a1a24': 'surface-overlay', '#111': 'fg-inverse', '#000': 'scrim', '#000000': 'scrim' };
const BLUR_PX = [[2, '2xs'], [4, 'xs'], [6, 'sm'], [8, 'sm'], [12, 'md'], [16, 'lg'], [24, 'xl'], [40, '2xl'], [64, '3xl'], [80, '4xl'], [90, '4xl'], [100, '4xl'], [120, '4xl']];
const TRACKING = (em) => (em <= -0.035 ? 'display' : em < 0 ? 'tight' : em < 0.12 ? 'widest' : em < 0.27 ? 'caps' : 'caps-wide');

const nearest = (table, v) => table.reduce((best, [k, name]) => (Math.abs(k - v) < Math.abs(best[0] - v) ? [k, name] : best))[1];

function alphaOf(raw) {
  if (raw === undefined) return 1;
  const m = /^\[(0?\.\d+|1(?:\.0+)?)\]$/.exec(raw);
  if (m) return Number(m[1]);
  return Number(raw) / 100;
}
const pct = (a) => Math.round(a * 100);
const withAlpha = (name, a) => (a >= 0.999 ? name : `${name}/${pct(a)}`);

/** The token class for one colour utility, or null when it is not a palette colour. */
function mapColor(util, hue, shade, alphaRaw, ctx) {
  const a = alphaOf(alphaRaw);
  const s = shade ? Number(shade) : null;
  const fgLike = FOREGROUND_UTILS.has(util);
  const line = LINE_UTILS.test(util);
  const out = (name) => `${util}-${name}`;

  if (hue === 'white') {
    if (fgLike) {
      if (a >= 0.88) return out('fg');
      if (a >= 0.68) return out('fg-muted');
      if (a >= 0.54) return out('fg-subtle');
      if (a > 0.2 || util === 'placeholder') return out('fg-faint'); // placeholders are text: never below the AA floor
      return out('fg-disabled');
    }
    if (line) {
      if (a < 0.055) return out('line-subtle');
      if (a < 0.085) return out('line');
      if (a < 0.13) return out('line-strong');
      if (a < 0.4) return out('line-emphasis');
      return out(withAlpha('fg', a));
    }
    // fills: bg, from, via, to, shadow, accent
    if (a >= 0.4) return out(withAlpha('fg', a));
    if (a < 0.04) return out('surface-1');
    if (a < 0.058) return out('surface-2');
    if (a < 0.075) return out('surface-3');
    if (a < 0.13) return out('surface-4');
    if (a < 0.22) return out('surface-5');
    return out('surface-6');
  }
  if (hue === 'black') {
    if (fgLike) return out(withAlpha('fg-inverse', a));
    return out(withAlpha('scrim', a));
  }
  if (NEUTRAL.has(hue)) {
    if (fgLike) {
      const name = s <= 200 ? 'fg' : s <= 300 ? 'fg-muted' : s <= 400 ? 'fg-subtle' : s <= 600 ? 'fg-faint' : 'fg-disabled';
      return out(withAlpha(name, a));
    }
    if (line) return out(withAlpha(s >= 800 ? 'line' : s >= 700 ? 'line-strong' : 'line-emphasis', a));
    // Grey fills on the dark canvas are glass of that lightness: zinc-900 ≈ white 6 %, zinc-800 ≈ 10 %.
    // Light greys are the hover of a white (bg-fg) button; mid greys are inactive status dots.
    if (s >= 950) return out(withAlpha('surface-raised', a));
    if (s >= 900) return out(withAlpha('surface-3', a));
    if (s >= 800) return out(withAlpha('surface-4', a));
    if (s >= 700) return out(withAlpha('surface-5', a));
    if (a < 0.999) return out(s >= 500 ? 'surface-3' : 'surface-4');
    if (s >= 600) return out('fg-disabled');
    if (s >= 400) return out('fg-faint');
    return out('fg/85');
  }
  const role = ROLE[hue];
  const cat = role ? null : `cat-${hue}`;
  if (fgLike) {
    if (role) return out(withAlpha(s !== null && s <= 300 ? `${role}-fg-strong` : `${role}-fg`, a));
    return out(withAlpha(`${cat}-fg`, a));
  }
  if (a < 0.999) return out(withAlpha(role || cat, a)); // tints and coloured borders
  if (role) {
    const sh = s ?? 500;
    if (ctx.hoverVariant) {
      if (sh >= 600) return out(`${role}-emphasis-hover`);
      return out(ctx.whiteText ? `${role}-emphasis` : role);
    }
    if (sh <= 400) return out(role);
    if (sh === 500) return out(ctx.whiteText && util === 'bg' ? `${role}-emphasis` : role);
    if (sh === 600) return out(`${role}-emphasis`);
    return out(`${role}-emphasis-hover`);
  }
  if (s === null || s <= 500) return out(cat);
  if (s <= 700) return out(`${cat}-strong`);
  return out(`${cat}-deep`);
}

/**
 * Map one class token (with its variants) to its design-token form.
 * @returns {string|null} the replacement, or null to leave it as is
 */
export function mapClass(token, ctx = {}) {
  const m = /^((?:[a-z0-9-]+(?:\[[^\]\s]*\])?:)*)(!?)(.*)$/.exec(token);
  const [, variants, bang, base] = m;
  const hoverVariant = /(^|:)(hover|active|group-hover|peer-hover|focus|focus-visible):/.test(variants);
  const wrap = (b) => (b === null ? null : `${variants}${bang}${b}`);

  let c = COLOR_CLASS.exec(base);
  if (c) return wrap(mapColor(c[1], c[2], c[3], c[4], { ...ctx, hoverVariant }));

  if (NAMED_TEXT[base]) return wrap(NAMED_TEXT[base]);
  if ((c = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(base))) return wrap(`text-${nearest(SIZE_PX, Number(c[1]))}`);
  if ((c = /^(rounded(?:-[trblse]{1,2})?)-\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(base))) {
    const px = Number(c[2]) * (c[3] === 'rem' ? 16 : 1);
    return wrap(`${c[1]}-${nearest(RADIUS_PX, px)}`);
  }
  if ((c = /^(rounded|shadow|blur|backdrop-blur|drop-shadow)$/.exec(base))) return wrap(`${c[1]}-sm`);
  if ((c = /^shadow-\[(.+)\]$/.exec(base)) && SHADOWS[c[1]]) return wrap(`shadow-${SHADOWS[c[1]]}`);
  if ((c = /^tracking-\[(-?\d*\.?\d+)em\]$/.exec(base))) return wrap(`tracking-${TRACKING(Number(c[1]))}`);
  if ((c = /^(-?)z-(\d+)$/.exec(base)) || (c = /^()z-\[(-?\d+)\]$/.exec(base))) {
    const v = Number(`${c[1] || ''}${c[2]}`);
    return Z[v] ? wrap(`z-${Z[v]}`) : null;
  }
  if ((c = /^(duration|delay)-(\d+)$/.exec(base))) return c[1] === 'duration' ? wrap(`duration-${nearest(DURATIONS, Number(c[2]))}`) : null;
  if ((c = /^(bg|from|via|to|border(?:-[trblxyse])?|text)-\[(#[0-9a-fA-F]{3,8})\](?:\/(\d+))?$/.exec(base)) && INK[c[2].toLowerCase()]) {
    return wrap(`${c[1]}-${INK[c[2].toLowerCase()]}${c[3] ? `/${c[3]}` : ''}`);
  }
  if ((c = /^(blur|backdrop-blur)-\[(\d+)px\]$/.exec(base))) return wrap(`${c[1]}-${nearest(BLUR_PX, Number(c[2]))}`);
  if ((c = /^duration-\[(\d+)ms\]$/.exec(base))) return wrap(`duration-${nearest(DURATIONS, Number(c[1]))}`);
  // spacing in px or rem → the spacing scale (one unit = 4px)
  if ((c = /^(-?)(p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?|space-[xy])-\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(base))) {
    const units = (Number(c[3]) * (c[4] === 'rem' ? 16 : 1)) / 4;
    if (Number.isInteger(units * 4)) return wrap(`${c[1]}${c[2]}-${units}`);
  }
  // chrome skeleton
  const SKELETON = { 'top-24': 'top-chrome-top', 'bottom-[88px]': 'bottom-dock', 'h-[88px]': 'h-dock', 'right-[448px]': 'right-chat-panel', 'max-w-[448px]': 'max-w-chat-panel', 'right-[472px]': 'right-chat-panel-gap', 'top-[140px]': 'top-chrome-top-find' };
  if (SKELETON[base] && ctx.skeleton) return wrap(SKELETON[base]);
  return null;
}

const JS_DURATION = /\bduration\s*:\s*(\d+)(?![\w.])/g;

/**
 * Migrate a file's text. ctx flags per line: whiteText (the line also sets text-white), so a solid
 * fill becomes the emphasis tone.
 * @param {string} text
 * @param {{ skeleton?: boolean, jsDurations?: boolean }} [opts] skeleton: also map the chrome's
 *   layout values (top-24, bottom-[88px], ...); jsDurations: rewrite `duration: 300` to motion tokens
 */
export function migrateText(text, { skeleton = false, jsDurations = false } = {}) {
  const changes = [];
  let usedMotion = false;
  const lines = String(text).split('\n').map((line, i) => {
    const whiteText = /(?<![\w-])text-white(?:\/(?:9\d|8[5-9]|100))?(?![\w-/])/.test(line);
    let next = line.replace(TOKEN, (tok) => {
      const rep = mapClass(tok, { whiteText, skeleton });
      if (rep && rep !== tok) { changes.push({ line: i + 1, from: tok, to: rep }); return rep; }
      return tok;
    });
    if (jsDurations) {
      next = next.replace(JS_DURATION, (all, ms) => {
        usedMotion = true;
        const name = nearest(DURATIONS, Number(ms));
        changes.push({ line: i + 1, from: all, to: `duration: motion.${name}` });
        return `duration: motion.${name}`;
      });
    }
    return next;
  });
  return { text: lines.join('\n'), changes, usedMotion };
}
