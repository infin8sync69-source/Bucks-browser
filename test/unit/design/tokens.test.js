// Design tokens: colour maths, reference resolution, theme completeness, contrast rules, renderers,
// and that the committed outputs are what the token files produce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseColor, toHex, contrast, composite, buildModel, loadTokenFiles, renderAll, renderTailwind, withAlpha,
} from '../../../design/build/tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const files = () => loadTokenFiles(path.join(root, 'design', 'tokens'));

test('oklch converts to the same sRGB Tailwind publishes', () => {
  assert.equal(toHex(parseColor('oklch(62.3% 0.214 259.815)')), '#2b7fff'); // blue-500
  assert.equal(toHex(parseColor('oklch(98.5% 0 0)')), '#fafafa'); // zinc-50
  assert.deepEqual(parseColor('#07070a'), { r: 7 / 255, g: 7 / 255, b: 10 / 255, a: 1 });
  assert.equal(withAlpha('#ffffff', 0.5), 'rgb(255 255 255 / 0.5)');
  assert.equal(withAlpha('oklch(62.3% 0.214 259.815)', 0.2), 'oklch(62.3% 0.214 259.815 / 0.2)');
  assert.throws(() => parseColor('tomato'), /Unsupported colour/);
});

test('contrast follows WCAG 2.1 and translucent colours are composited first', () => {
  const white = parseColor('#ffffff');
  const black = parseColor('#000000');
  assert.equal(Math.round(contrast(white, black) * 100) / 100, 21);
  const halfWhite = composite({ ...white, a: 0.5 }, black);
  assert.ok(Math.abs(halfWhite.r - 0.5) < 1e-9);
  assert.ok(contrast(halfWhite, black) > 5 && contrast(halfWhite, black) < 5.5);
});

test('the shipped tokens resolve with no problems and every contrast rule holds', () => {
  const { model, errors } = buildModel(files());
  assert.deepEqual(errors, []);
  assert.deepEqual(model.themes, ['dark', 'light']);
  for (const r of model.contrast) assert.ok(r.ratio >= r.min, `${r.name} on ${r.on} (${r.theme}) = ${r.ratio}`);
  // the readable-text floor: the quietest text still reaches AA on the canvas, in both themes
  const faint = model.contrast.filter((r) => r.name === 'fg-faint' && r.on === 'canvas');
  assert.equal(faint.length, 2);
  // categorical tones are generated for every hue and step
  assert.ok(model.colors.has('cat-violet') && model.colors.has('cat-violet-fg') && model.colors.has('cat-violet-deep'));
});

test('problems are reported: unknown reference, missing theme, failing contrast', () => {
  const f = files();
  const broken = structuredClone(f);
  broken.semantic.color.fg.$value = { dark: '{color.nope.500}', light: '{color.zinc.950}' };
  broken.semantic.color.canvas.$value = { dark: '{color.ink.1}' };
  broken.semantic.color['fg-faint'].$value = { dark: 'alpha({color.white}, 0.2)', light: '{color.zinc.600}' };
  const { errors } = buildModel(broken);
  assert.ok(errors.some((e) => /unknown colour reference \{color\.nope\.500\}/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /color\.canvas: no value for theme "light"/.test(e)));
  assert.ok(errors.some((e) => /color\.fg-faint on canvas \(dark\): contrast .* is below 4\.5/.test(e)));
});

test('the Tailwind theme replaces the default palette and scales with the tokens', () => {
  const { model } = buildModel(files());
  const tw = renderTailwind(model);
  for (const reset of ['--color-*: initial', '--text-*: initial', '--radius-*: initial', '--shadow-*: initial', '--font-weight-*: initial', '--animate-*: initial']) {
    assert.ok(tw.includes(reset), reset);
  }
  assert.match(tw, /--color-fg-faint: var\(--bucks-color-fg-faint\);/);
  assert.match(tw, /--text-sm: var\(--bucks-font-size-sm\);/);
  assert.match(tw, /--spacing-chrome-top: var\(--bucks-size-chrome-top\);/);
  assert.match(tw, /@utility z-modal \{ z-index: var\(--bucks-z-modal\); \}/);
  assert.match(tw, /--animate-spin: spin var\(--bucks-duration-slowest\) linear infinite;/, 'keyframe names stay visible to Tailwind');
});

test('the committed generated files are up to date', () => {
  const { model } = buildModel(files());
  for (const [rel, content] of Object.entries(renderAll(model))) {
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), content, `${rel} is stale: run node scripts/build-tokens.mjs`);
  }
});

test('the generated JS data matches the CSS', async () => {
  const js = await import('../../../design/dist/tokens.js');
  assert.equal(js.duration.moderate, 300);
  assert.equal(js.duration.drift, 26000);
  assert.equal(js.z.modal, 499);
  assert.deepEqual(js.colors.dark.canvas.rgb, [7, 7, 10]);
  assert.equal(js.cssVar('color', 'accent'), 'var(--bucks-color-accent)');
  const main = await import('../../../src/main/design/tokens.generated.js');
  assert.equal(main.THEME_HEX.dark.canvas, '#07070a');
  assert.match(main.TOKENS_CSS, /\[data-theme="light"\]/);
});
