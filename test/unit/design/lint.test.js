// The design-system linter and the Tailwind-to-token migration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintText, kindOf } from '../../../design/build/lint.mjs';
import { mapClass, migrateText } from '../../../design/build/migrate.mjs';

const rules = (text, kind = 'markup') => lintText(text, { kind }).map((f) => `${f.rule}:${f.match}`);

test('lint: palette classes, arbitrary design values, raw layers and durations', () => {
  assert.deepEqual(rules('<div class="p-2 bg-zinc-900 hover:text-white/70 text-[11px] rounded-[18px] z-50 duration-300 w-[340px]">'), [
    'palette-class:bg-zinc-900', 'palette-class:hover:text-white/70', 'arbitrary-value:text-[11px]', 'arbitrary-value:rounded-[18px]',
    'raw-z-index:z-50', 'raw-duration:duration-300',
  ], 'geometry (w-[340px]) is allowed');
  assert.deepEqual(rules('<div class="bg-surface-2 text-fg-faint text-2xs rounded-2xl z-modal duration-moderate border-line/40">'), []);
  assert.deepEqual(rules('<div class="bg-surface-2/[0.06]">'), ['arbitrary-value:bg-surface-2/[0.06]']);
  assert.deepEqual(rules('<i class="rounded shadow blur">'), ['bare-scale:rounded', 'bare-scale:shadow', 'bare-scale:blur']);
  assert.deepEqual(rules('in:fly={{ y: 8, duration: 200 }}'), ['raw-duration:duration: 200']);
});

test('lint: colours and design-owned CSS values anywhere, not inside token names', () => {
  assert.deepEqual(rules('<style>.a{color:#fff;background:rgba(0,0,0,.4);border-color:white}</style>'), [
    'raw-color:#fff', 'raw-color:rgba(', 'raw-color:border-color:white',
  ]);
  assert.deepEqual(rules('.a{background:radial-gradient(circle, var(--bucks-color-cat-pink-strong), transparent)}', 'style'), []);
  assert.deepEqual(rules('.a{font-size:13px;border-radius:var(--bucks-radius-lg);z-index:10;transition:opacity .3s}', 'style'), [
    'raw-css-value:font-size:13px', 'raw-css-value:z-index:10', 'raw-duration:transition:opacity .3s',
  ]);
  assert.deepEqual(rules('style="font-size:{size * 0.55}px"'), [], 'a template expression decides');
  assert.deepEqual(rules("ctx.fillStyle = '#000';", 'main'), ['raw-color:#000']);
  assert.deepEqual(rules("const c = 'bg-zinc-900';", 'main'), [], 'main-process code is only checked for colours');
});

test('lint: tokens-ignore needs a reason', () => {
  assert.deepEqual(rules("x = '#fff'; // tokens-ignore: the platform default", 'script'), []);
  assert.deepEqual(rules("// tokens-ignore: drawn on a canvas\nx = '#fff';", 'script'), []);
  assert.deepEqual(rules("x = '#fff'; // tokens-ignore", 'script'), ['ignore-without-reason:#fff']);
});

test('lint: which files are checked', () => {
  assert.equal(kindOf('ui/src/lib/Header.svelte'), 'markup');
  assert.equal(kindOf('ui/src/lib/stores.ts'), 'script');
  assert.equal(kindOf('ui/src/app.css'), 'style');
  assert.equal(kindOf('design/components/button.js'), 'script');
  assert.equal(kindOf('src/main/protocols/ipfs.js'), 'main');
  assert.equal(kindOf('src/main/design/tokens.generated.js'), null);
  assert.equal(kindOf('ui/build/index.html'), null);
});

test('migrate: white opacities become text roles, readable at least', () => {
  assert.equal(mapClass('text-white'), 'text-fg');
  assert.equal(mapClass('text-white/70'), 'text-fg-muted');
  assert.equal(mapClass('text-white/60'), 'text-fg-subtle');
  assert.equal(mapClass('text-white/30'), 'text-fg-faint', 'raised to the AA floor');
  assert.equal(mapClass('text-white/15'), 'text-fg-disabled');
  assert.equal(mapClass('hover:text-white/40'), 'hover:text-fg-faint');
  assert.equal(mapClass('placeholder-white/20'), 'placeholder-fg-faint');
});

test('migrate: glass surfaces, lines, scrims and greys', () => {
  assert.equal(mapClass('bg-white/[0.03]'), 'bg-surface-1');
  assert.equal(mapClass('bg-white/5'), 'bg-surface-2');
  assert.equal(mapClass('bg-white/[0.06]'), 'bg-surface-3');
  assert.equal(mapClass('hover:bg-white/10'), 'hover:bg-surface-4');
  assert.equal(mapClass('border-white/5'), 'border-line-subtle');
  assert.equal(mapClass('border-white/10'), 'border-line-strong');
  assert.equal(mapClass('bg-black/60'), 'bg-scrim/60');
  assert.equal(mapClass('bg-white'), 'bg-fg');
  assert.equal(mapClass('text-black'), 'text-fg-inverse');
  assert.equal(mapClass('bg-zinc-900'), 'bg-surface-3');
  assert.equal(mapClass('hover:bg-zinc-800'), 'hover:bg-surface-4');
  assert.equal(mapClass('hover:bg-zinc-200'), 'hover:bg-fg/85', 'the hover of a white button stays light');
  assert.equal(mapClass('bg-zinc-500'), 'bg-fg-faint', 'an inactive status dot');
  assert.equal(mapClass('text-zinc-400'), 'text-fg-subtle');
});

test('migrate: hues map to roles; a solid fill under white text becomes the readable emphasis', () => {
  assert.equal(mapClass('text-blue-400'), 'text-accent-fg');
  assert.equal(mapClass('text-violet-300'), 'text-agent-fg-strong');
  assert.equal(mapClass('bg-emerald-500/20'), 'bg-success/20');
  assert.equal(mapClass('bg-red-500'), 'bg-danger', 'a dot');
  assert.equal(mapClass('bg-blue-500', { whiteText: true }), 'bg-accent-emphasis', 'a button');
  assert.equal(mapClass('hover:bg-blue-600', { whiteText: true }), 'hover:bg-accent-emphasis-hover');
  assert.equal(mapClass('text-fuchsia-300/80'), 'text-cat-fuchsia-fg/80');
  assert.equal(mapClass('to-indigo-900'), 'to-cat-indigo-deep');
});

test('migrate: sizes, radii, layers, motion, shadows, the chrome skeleton', () => {
  assert.equal(mapClass('text-sm'), 'text-md', "Tailwind's 14px is md on the token scale");
  assert.equal(mapClass('text-[13px]'), 'text-sm');
  assert.equal(mapClass('text-[10px]'), 'text-3xs');
  assert.equal(mapClass('rounded-[26px]'), 'rounded-3xl');
  assert.equal(mapClass('rounded'), 'rounded-sm');
  assert.equal(mapClass('z-[499]'), 'z-modal');
  assert.equal(mapClass('z-10'), 'z-raised');
  assert.equal(mapClass('duration-300'), 'duration-moderate');
  assert.equal(mapClass('tracking-[0.3em]'), 'tracking-caps-wide');
  assert.equal(mapClass('shadow-[0_25px_50px_-12px_rgba(0,0,0,0.9)]'), 'shadow-popover');
  assert.equal(mapClass('bg-[#0a0a0c]/80'), 'bg-surface-raised/80');
  assert.equal(mapClass('pl-[70px]'), 'pl-17.5');
  assert.equal(mapClass('bottom-[88px]'), null, 'layout values only with { skeleton: true }');
  assert.equal(mapClass('bottom-[88px]', { skeleton: true }), 'bottom-dock');
  assert.equal(mapClass('w-[340px]'), null);
});

test('migrate: whole text, CSS functions untouched, motion durations', () => {
  const { text, changes, usedMotion } = migrateText('<div class="bg-blue-500 text-white px-3">\n<style>.a{filter:blur(4px) drop-shadow(0 0 2px)}</style>\nin:fade={{ duration: 300 }}', { jsDurations: true });
  assert.equal(text, '<div class="bg-accent-emphasis text-fg px-3">\n<style>.a{filter:blur(4px) drop-shadow(0 0 2px)}</style>\nin:fade={{ duration: motion.moderate }}');
  assert.equal(changes.length, 3);
  assert.equal(usedMotion, true);
});
