// Bucks design tokens: load the token files (design/tokens/*.json), resolve references, check them
// (every theme defined, every reference known, WCAG contrast rules) and render the outputs.
// Pure functions, no file writes: scripts/build-tokens.mjs does the I/O. Used by the unit tests.

import fs from 'node:fs';
import path from 'node:path';

export const PREFIX = 'bucks';
const REF = /\{([a-z0-9.-]+)\}/gi;
const ALPHA = /alpha\(\s*\{([a-z0-9.-]+)\}\s*,\s*([0-9.]+)\s*\)/gi;

/* ───────────────────────────── colour maths ───────────────────────────── */

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** OKLCH (L 0..1, C, H degrees) to gamma-encoded sRGB 0..1, clipped to the sRGB gamut. */
export function oklchToSrgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((c) => clamp01(toGamma(clamp01(c))));
}

/**
 * Parse a primitive colour: #rgb, #rrggbb, #rrggbbaa or oklch(L% C H [/ a]).
 * @returns {{ r: number, g: number, b: number, a: number }} gamma-encoded sRGB, 0..1
 */
export function parseColor(str) {
  const s = String(str).trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
    const n = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 1 };
  }
  m = /^oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*([0-9.]+)\s*)?\)$/i.exec(s);
  if (m) {
    const L = Number(m[1]) / (m[2] ? 100 : 1);
    const [r, g, b] = oklchToSrgb(L, Number(m[3]), Number(m[4]));
    return { r, g, b, a: m[5] === undefined ? 1 : Number(m[5]) };
  }
  throw new Error(`Unsupported colour "${s}" (use #hex or oklch())`);
}

/** Source-over compositing in gamma-encoded sRGB, as browsers do. */
export function composite(top, bottom) {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t, u) => (t * top.a + u * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

export function luminance({ r, g, b }) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.1 contrast ratio of two opaque colours. */
export function contrast(x, y) {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

export function toHex({ r, g, b, a = 1 }) {
  const h = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a) : ''}`;
}

/* ───────────────────────────── loading ───────────────────────────── */

export function loadTokenFiles(dir) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return { color: read('color.json'), scale: read('scale.json'), semantic: read('semantic.json') };
}

/** Leaves of a DTCG tree: path → { value, type, description, extensions }. Keys starting with $ are metadata. */
export function flatten(tree, prefix = [], inheritedType = undefined, out = new Map()) {
  const type = tree.$type ?? inheritedType;
  if (Object.prototype.hasOwnProperty.call(tree, '$value')) {
    out.set(prefix.join('.'), { value: tree.$value, type, description: tree.$description, extensions: tree.$extensions || {} });
    return out;
  }
  for (const [k, v] of Object.entries(tree)) {
    if (k.startsWith('$') || v === null || typeof v !== 'object') continue;
    flatten(v, [...prefix, k], type, out);
  }
  return out;
}

const cssName = (tokenPath) => `--${PREFIX}-${tokenPath.replace(/\./g, '-')}`;

/* ───────────────────────────── the model ───────────────────────────── */

/**
 * Resolve everything. Returns the model the renderers use and the problems found.
 * @returns {{ model: object, errors: string[] }}
 */
export function buildModel({ color, scale, semantic }) {
  const errors = [];
  const primitives = flatten(color);
  const scales = flatten(scale);
  const themes = semantic.$themes;
  if (!Array.isArray(themes) || themes.length === 0) errors.push('semantic.json: $themes must list the themes');

  const primitive = (ref, where) => {
    const p = primitives.get(ref);
    if (!p) { errors.push(`${where}: unknown colour reference {${ref}}`); return null; }
    return p.value;
  };

  /** A colour expression ({ref} or alpha({ref}, a)) → { css, rgba }. */
  function evalColor(expr, where) {
    const s = String(expr).trim();
    let m = /^\{([a-z0-9.-]+)\}$/i.exec(s);
    if (m) {
      const v = primitive(m[1], where);
      if (v === null) return null;
      return { css: v, rgba: parseColor(v) };
    }
    m = /^alpha\(\s*\{([a-z0-9.-]+)\}\s*,\s*([0-9.]+)\s*\)$/i.exec(s);
    if (m) {
      const v = primitive(m[1], where);
      if (v === null) return null;
      const a = Number(m[2]);
      if (!(a >= 0 && a <= 1)) { errors.push(`${where}: alpha must be between 0 and 1`); return null; }
      return { css: withAlpha(v, a), rgba: { ...parseColor(v), a } };
    }
    errors.push(`${where}: a colour must be {reference} or alpha({reference}, a), got "${s}"`);
    return null;
  }

  // Semantic colours, then the categorical tones generated from semantic.$categorical.
  const semanticColors = new Map(); // name → { description, values: { theme: { css, rgba } }, contrast }
  for (const [name, t] of flatten({ color: semantic.color })) {
    const short = name.replace(/^color\./, '');
    const values = {};
    if (!t.value || typeof t.value !== 'object') { errors.push(`color.${short}: $value must be an object with one entry per theme`); continue; }
    for (const theme of themes || []) {
      if (!(theme in t.value)) { errors.push(`color.${short}: no value for theme "${theme}"`); continue; }
      values[theme] = evalColor(t.value[theme], `color.${short} (${theme})`);
    }
    for (const extra of Object.keys(t.value)) if (!(themes || []).includes(extra)) errors.push(`color.${short}: unknown theme "${extra}"`);
    semanticColors.set(short, { description: t.description, values, contrast: t.extensions['bucks.contrast'] || null });
  }
  const cat = semantic.$categorical;
  if (cat) {
    for (const hue of cat.hues) {
      for (const [step, spec] of Object.entries(cat.steps)) {
        const name = step ? `cat-${hue}-${step}` : `cat-${hue}`;
        const values = {};
        for (const theme of themes) values[theme] = evalColor(`{color.${hue}.${spec[theme]}}`, `color.${name} (${theme})`);
        semanticColors.set(name, { description: step ? undefined : `Categorical tone: ${hue}`, values, contrast: spec.contrast || null });
      }
    }
  }

  // Contrast rules, per theme. A translucent background is composited over the canvas first.
  const results = [];
  for (const [name, tok] of semanticColors) {
    if (!tok.contrast) continue;
    for (const theme of themes) {
      const fg = tok.values[theme];
      if (!fg) continue;
      const canvas = semanticColors.get('canvas')?.values[theme]?.rgba;
      for (const bgName of tok.contrast.on) {
        const bgTok = semanticColors.get(bgName);
        if (!bgTok) { errors.push(`color.${name}: contrast rule names unknown colour "${bgName}"`); continue; }
        const bgRaw = bgTok.values[theme]?.rgba;
        if (!bgRaw || !canvas) continue;
        const bg = bgRaw.a < 1 ? composite(bgRaw, canvas) : bgRaw;
        const fgOpaque = composite(fg.rgba, bg);
        const ratio = contrast(fgOpaque, bg);
        results.push({ name, theme, on: bgName, ratio, min: tok.contrast.min });
        if (ratio + 1e-9 < tok.contrast.min) {
          errors.push(`color.${name} on ${bgName} (${theme}): contrast ${ratio.toFixed(2)} is below ${tok.contrast.min}`);
        }
      }
    }
  }

  // Scale tokens: { ref } inside a value points at another scale token (emitted as var()).
  const scaleTokens = new Map();
  for (const [p, t] of scales) {
    let value = t.value;
    if (t.type === 'cubicBezier') {
      if (!Array.isArray(value) || value.length !== 4) errors.push(`${p}: a cubicBezier is [x1, y1, x2, y2]`);
      value = `cubic-bezier(${value.join(', ')})`;
    } else if (typeof value === 'string') {
      value = value.replace(ALPHA, (_, ref, a) => {
        const v = primitive(ref, p);
        return v === null ? '' : withAlpha(v, Number(a));
      }).replace(REF, (_, ref) => {
        if (scales.has(ref)) return `var(${cssName(ref)})`;
        if (primitives.has(ref)) return primitives.get(ref).value;
        errors.push(`${p}: unknown reference {${ref}}`);
        return '';
      });
    } else {
      value = String(value);
    }
    scaleTokens.set(p, { value, type: t.type, description: t.description, extensions: t.extensions, raw: t.value });
  }

  return { model: { themes, colors: semanticColors, scales: scaleTokens, contrast: results }, errors };
}

/** A primitive at opacity a, in its own colour space. */
export function withAlpha(value, a) {
  const v = String(value).trim();
  const ok = /^oklch\(\s*([^/)]+?)\s*(?:\/[^)]*)?\)$/i.exec(v);
  if (ok) return `oklch(${ok[1]} / ${a})`;
  const { r, g, b } = parseColor(v);
  const c = (x) => Math.round(x * 255);
  return `rgb(${c(r)} ${c(g)} ${c(b)} / ${a})`;
}

/* ───────────────────────────── renderers ───────────────────────────── */

const HEADER = (what) => `/* ${what}. Generated by scripts/build-tokens.mjs from design/tokens/*.json: do not edit. */\n`;

function colorDeclarations(model, theme, indent) {
  return [...model.colors].map(([name, t]) => `${indent}${cssName(`color.${name}`)}: ${t.values[theme].css};`).join('\n');
}

/** tokens.css: the variables. Dark is the default; data-theme="light" or "system" switch per subtree. */
export function renderCss(model) {
  const [first, ...rest] = model.themes;
  const scaleDecls = [];
  for (const [p, t] of model.scales) {
    scaleDecls.push(`  ${cssName(p)}: ${t.value};`);
    const lh = t.extensions?.['bucks.lineHeight'];
    if (lh !== undefined) scaleDecls.push(`  ${cssName(p)}-line-height: ${lh};`);
  }
  let css = HEADER('Bucks design tokens');
  css += `:root {\n${scaleDecls.join('\n')}\n}\n\n`;
  css += `:root,\n[data-theme="${first}"] {\n  color-scheme: ${first};\n${colorDeclarations(model, first, '  ')}\n}\n`;
  for (const theme of rest) {
    css += `\n[data-theme="${theme}"] {\n  color-scheme: ${theme};\n${colorDeclarations(model, theme, '  ')}\n}\n`;
    css += `\n@media (prefers-color-scheme: ${theme}) {\n  [data-theme="system"] {\n    color-scheme: ${theme};\n${colorDeclarations(model, theme, '    ')}\n  }\n}\n`;
  }
  return css;
}

const group = (model, prefix) => [...model.scales].filter(([p]) => p.startsWith(`${prefix}.`)).map(([p, t]) => [p.slice(prefix.length + 1), t, p]);

/**
 * tailwind.css: Tailwind CSS v4 theme mapped onto the tokens. Tailwind's own palette, type scale,
 * radii, shadows, blurs and easings are removed (namespace: initial), so a class outside the
 * design system (bg-zinc-900, text-blue-400) generates nothing; scripts/lint-tokens.mjs reports it.
 */
export function renderTailwind(model) {
  const v = (p) => `var(${cssName(p)})`;
  const L = [HEADER('Tailwind CSS v4 theme for the Bucks design tokens'), '@theme inline {'];
  L.push('  --color-*: initial;');
  for (const name of model.colors.keys()) L.push(`  --color-${name}: ${v(`color.${name}`)};`);
  L.push('', `  --spacing: ${v('space.unit')};`);
  for (const [n, , p] of group(model, 'size')) L.push(`  --spacing-${n}: ${v(p)};`);
  L.push('', '  --radius-*: initial;');
  for (const [n, , p] of group(model, 'radius')) L.push(`  --radius-${n}: ${v(p)};`);
  L.push('', '  --font-*: initial;');
  for (const [n, , p] of group(model, 'font.family')) L.push(`  --font-${n}: ${v(p)};`);
  L.push('', '  --text-*: initial;');
  for (const [n, t, p] of group(model, 'font.size')) {
    L.push(`  --text-${n}: ${v(p)};`);
    if (t.extensions?.['bucks.lineHeight'] !== undefined) L.push(`  --text-${n}--line-height: var(${cssName(p)}-line-height);`);
  }
  L.push('', '  --font-weight-*: initial;');
  for (const [n, , p] of group(model, 'font.weight')) L.push(`  --font-weight-${n}: ${v(p)};`);
  L.push('', '  --tracking-*: initial;');
  for (const [n, , p] of group(model, 'font.tracking')) L.push(`  --tracking-${n}: ${v(p)};`);
  L.push('', '  --leading-*: initial;');
  for (const [n, , p] of group(model, 'font.leading')) L.push(`  --leading-${n}: ${v(p)};`);
  L.push('', '  --shadow-*: initial;');
  for (const [n, , p] of group(model, 'shadow')) L.push(`  --shadow-${n}: ${v(p)};`);
  L.push('', '  --drop-shadow-*: initial;');
  for (const [n, , p] of group(model, 'drop-shadow')) L.push(`  --drop-shadow-${n}: ${v(p)};`);
  L.push('', '  --animate-*: initial;');
  // The keyframe name must be visible to Tailwind, which only emits @keyframes it sees used.
  for (const [n, t] of group(model, 'animation')) L.push(`  --animate-${n}: ${t.value};`);
  L.push('', '  --blur-*: initial;');
  for (const [n, , p] of group(model, 'blur')) L.push(`  --blur-${n}: ${v(p)};`);
  L.push('', '  --ease-*: initial;');
  for (const [n, , p] of group(model, 'easing')) L.push(`  --ease-${n}: ${v(p)};`);
  L.push('', `  --default-transition-duration: ${v('duration.fast')};`);
  L.push(`  --default-transition-timing-function: ${v('easing.standard')};`);
  L.push(`  --default-font-family: ${v('font.family.sans')};`);
  L.push(`  --default-mono-font-family: ${v('font.family.mono')};`);
  L.push('}', '');
  L.push('/* Tailwind has no theme namespace for z-index and durations: one utility per token. */');
  for (const [n, , p] of group(model, 'z')) L.push(`@utility z-${n} { z-index: ${v(p)}; }`);
  for (const [n, , p] of group(model, 'duration')) L.push(`@utility duration-${n} { --tw-duration: ${v(p)}; transition-duration: ${v(p)}; }`);
  return `${L.join('\n')}\n`;
}

/** Plain values for JavaScript: canvas drawing, JS-driven animation, the main process. */
export function renderJs(model) {
  const colors = {};
  for (const theme of model.themes) {
    colors[theme] = {};
    for (const [name, t] of model.colors) {
      const { r, g, b, a } = t.values[theme].rgba;
      colors[theme][name] = { css: t.values[theme].css, rgb: [r, g, b].map((x) => Math.round(x * 255)), alpha: a };
    }
  }
  const pick = (prefix, conv = (x) => x) => Object.fromEntries(group(model, prefix).map(([n, t]) => [n, conv(t)]));
  const ms = (t) => { const s = String(t.raw); return s.endsWith('ms') ? Number(s.slice(0, -2)) : s.endsWith('s') ? Number(s.slice(0, -1)) * 1000 : Number(s); };
  const data = {
    themes: model.themes,
    colors,
    duration: pick('duration', ms),
    easing: pick('easing', (t) => t.raw),
    z: pick('z', (t) => Number(t.raw)),
    radius: pick('radius', (t) => t.value),
    size: pick('size', (t) => t.value),
  };
  let js = HEADER('Bucks design tokens as data');
  for (const [k, val] of Object.entries(data)) js += `export const ${k} = Object.freeze(${JSON.stringify(val)});\n`;
  js += `\n/** The CSS variable of a token, e.g. cssVar('color', 'accent') → "var(--${PREFIX}-color-accent)". */\n`;
  js += `export function cssVar(groupName, name) {\n  return \`var(--${PREFIX}-\${groupName}-\${String(name).replace(/\\./g, '-')})\`;\n}\n`;
  return js;
}

export function renderDts(model) {
  const names = [...model.colors.keys()].map((n) => `'${n}'`).join(' | ');
  const keys = (prefix) => group(model, prefix).map(([n]) => `'${n}'`).join(' | ');
  return `${HEADER('Types for tokens.js').replace('/*', '//').replace(' */', '')}export type Theme = ${model.themes.map((t) => `'${t}'`).join(' | ')};
export type ColorToken = ${names};
export interface ResolvedColor { css: string; rgb: [number, number, number]; alpha: number }
export declare const themes: readonly Theme[];
export declare const colors: Readonly<Record<Theme, Readonly<Record<ColorToken, ResolvedColor>>>>;
export declare const duration: Readonly<Record<${keys('duration')}, number>>;
export declare const easing: Readonly<Record<${keys('easing')}, readonly [number, number, number, number]>>;
export declare const z: Readonly<Record<${keys('z')}, number>>;
export declare const radius: Readonly<Record<${keys('radius')}, string>>;
export declare const size: Readonly<Record<${keys('size')}, string>>;
export declare function cssVar(group: string, name: string): string;
`;
}

/**
 * The main process's copy (src/ is what gets packaged): the CSS for pages it renders itself (error
 * pages, the gateway interstitial, exported documents) and hex colours for native surfaces
 * (window and view backgrounds).
 */
export function renderMainModule(model, css) {
  const hex = {};
  for (const theme of model.themes) {
    hex[theme] = {};
    for (const [name, t] of model.colors) hex[theme][name] = toHex(t.values[theme].rgba);
  }
  return `// Bucks design tokens for the main process. Generated by scripts/build-tokens.mjs from\n// design/tokens/*.json: do not edit.\n\n`
    + `export const TOKENS_CSS = ${JSON.stringify(css)};\n\n`
    + `/** Colour tokens as #rrggbb (or #rrggbbaa when translucent), per theme. */\n`
    + `export const THEME_HEX = Object.freeze(${JSON.stringify(hex)});\n`;
}

/** Every generated file, keyed by its path relative to the repository root. */
export function renderAll(model) {
  const css = renderCss(model);
  return {
    'design/dist/tokens.css': css,
    'design/dist/tailwind.css': renderTailwind(model),
    'design/dist/tokens.js': renderJs(model),
    'design/dist/tokens.d.ts': renderDts(model),
    'src/main/design/tokens.generated.js': renderMainModule(model, css),
  };
}
