# The Bucks design system

One set of design tokens styles everything Bucks draws: the chrome (today's Svelte UI and the
framework-free chrome that replaces it, [CONSOLIDATION-PLAN.md](CONSOLIDATION-PLAN.md)), the
shared web components, the pages the main process renders (IPFS error pages, the gateway
interstitial, exported documents) and the native window background. A colour, size, radius,
shadow, layer or duration that does not come from a token is a lint error.

## Layout

| Path | What |
|---|---|
| `design/tokens/color.json` | Primitive palette (Tailwind v4 values, plus the `ink` near-blacks). Never used directly |
| `design/tokens/scale.json` | Spacing unit, chrome skeleton sizes, radii, type, shadows, blurs, motion, layers |
| `design/tokens/semantic.json` | Semantic colours per theme (`dark`, `light`) and their contrast rules; categorical tones |
| `design/build/tokens.mjs` | Resolver, validator (references, themes, WCAG contrast) and renderers |
| `design/dist/` | Generated: `tokens.css`, `tailwind.css`, `tokens.js` + `.d.ts` (committed) |
| `src/main/design/tokens.generated.js` | Generated: the same CSS and hex colours for the main process |
| `src/main/design/page.js` | Base styles for pages the main process renders |
| `design/runtime/color.js` | `tokenRgba(name, alpha)` for `<canvas>` drawing |
| `design/components/` | Framework-free web components built only on tokens (see below) |
| `design/build/lint.mjs`, `scripts/lint-tokens.mjs` | The linter |
| `design/build/migrate.mjs`, `scripts/migrate-tokens.mjs` | Tailwind-palette-to-token codemod (for code ported from Bucks Core) |

```sh
npm run tokens         # rebuild design/dist and the main-process copy after editing design/tokens
npm run lint:design    # generated files current + no styling outside the tokens (part of npm run check)
node scripts/build-tokens.mjs --report   # every contrast ratio
```

## Tokens

Every token is a CSS variable `--bucks-<group>-<name>`; Tailwind utilities map onto them through
`design/dist/tailwind.css`, which also **removes Tailwind's own palette and scales**, so
`bg-zinc-900` or `text-[13px]` generate nothing.

**Colour roles** (`bg-*`, `text-*`, `border-*`, … with an optional `/NN` opacity):

| Role | Use |
|---|---|
| `canvas`, `canvas-deep` | Window and page background; hero areas |
| `surface-raised`, `surface-overlay` | Opaque panels, menus, drawers; a menu inside a panel |
| `surface-1` … `surface-6` | Glass fills, faintest to strongest (cards, hover, selected, pressed) |
| `fg`, `fg-muted`, `fg-subtle`, `fg-faint` | Text, strongest to quietest. All four pass WCAG AA on the canvas, raised surfaces and glass |
| `fg-disabled` | Disabled controls and decorative glyphs only |
| `fg-inverse`, `on-emphasis` | Text on an `fg` fill; text on any `*-emphasis` fill |
| `line-subtle`, `line`, `line-strong`, `line-emphasis` | Borders and dividers |
| `scrim`, `focus` | Backdrops (with an opacity); keyboard focus rings |
| `accent`, `agent`, `success`, `danger`, `warning`, `info` | Status hues. Each has `-fg` and `-fg-strong` (text), `-emphasis` and `-emphasis-hover` (solid fills under `on-emphasis` text); the bare name is for dots, tints (`bg-accent/15`) and borders |
| `cat-<hue>` (`-fg`, `-strong`, `-deep`) | Decorative tones with no meaning: tab groups, app icons, widget kinds. In code, a `Tone` (`ui/src/lib/tones.ts`) |

**Scales:** type `text-3xs` (10 px) `2xs` 11 `xs` 12 `sm` 13 `md` 14 `base` 16 … `7xl` 72; radii
`rounded-xs` … `4xl`, `full`; shadows `shadow-sm` … `2xl` plus `float`, `menu`, `popover`,
`dialog`, `glow-agent`, `glow`, `app-icon`, `thinking`; blurs `blur-2xs` … `4xl`; tracking
including `tracking-caps`, `caps-wide`, `display`; motion `duration-instant` … `slowest`, `ambient`,
`drift` and `ease-standard`, `out`, `in-out`, `emphasized`; `animate-spin|ping|pulse|bounce`.

**Layers** (`z-*`). Local: `behind`, `base`, `lift`, `raised`, `float`, `dropdown`, `popover`.
The chrome, lowest first: `chrome` (header), `find-bar`, `panel-backdrop`, `panel`, `dock`,
`drawer`, `drawer-raised`, `menu-backdrop`, `menu`, `modal-backdrop`, `modal`, `sheet-backdrop`,
`sheet`, `toast`.

**Chrome skeleton** (spacing names): `top-chrome-top`, `top-chrome-top-find`, `bottom-dock`,
`h-dock`, `right-chat-panel`, `max-w-chat-panel`, `right-chat-panel-gap`.

**Themes.** Dark is the default. `data-theme="light"` or `"system"` on any element switches that
subtree. The chrome sets `data-theme="dark"`; exported documents use `light`.

**JavaScript.** `import { duration as motion } from '$design/dist/tokens.js'` for Svelte
transitions (`duration: motion.moderate`); `tokenRgba('agent', 0.3)` from
`$design/runtime/color.js` for canvases. The main process imports `THEME_HEX` and `pageStyle()`
from `src/main/design/page.js`.

## Rules the linter enforces

In `ui/src`, `design/components`, `design/runtime`, and (colours only) `src/main`, `src/preload`:

- no colour literals (`#hex`, `rgb()`, `hsl()`, `oklch()`, named colours in CSS);
- no Tailwind palette classes (`bg-zinc-900`, `text-white/70`);
- no arbitrary values for design-owned properties (colour, type, tracking, leading, radius,
  shadow, blur, layer, duration, spacing). Arbitrary *geometry* (`w-[340px]`, `top-[10%]`) is allowed;
- no raw `z-50`, `duration-300`, bare `rounded`/`shadow`/`blur`, or `duration: 300` in JS;
- in CSS, `font-size`, `border-radius`, `box-shadow`, `z-index`, `letter-spacing` and timings use
  `var(--bucks-…)`.

An exception needs a reason on the line or the line above: `tokens-ignore: <why>`. There are
four, all in code that is not UI styling (a canvas helper, Chromium's white default for web
pages, a CSS mask).

## What the audit found, and what changed

The Svelte chrome had 2,881 styling values outside any system across 68 files. Measured before
the migration (`node scripts/lint-tokens.mjs --summary` on the old tree):

- **25 different text opacities** (white at 12 % to 92 %) where four roles are meant. Text at
  25–40 % (about 150 uses: labels, hints, timestamps) had a contrast of 2.4–3.6:1 on the canvas,
  below WCAG AA. They are now `fg-faint` (48 %, 5:1); placeholders included.
- **15 levels of glass fill** and **13 border opacities**, now 6 surfaces and 4 lines.
- **11 hand-picked near-black backgrounds** (`#030307` … `#1a1a24`), now `canvas`, `canvas-deep`,
  `surface-raised`, `surface-overlay`. The main process's pages used a third palette
  (`#0f1115`, `#171a21`) and its light window background (`#f5f5f8`) matched nothing.
- **14 hand-numbered z-index layers** (`z-[110]` … `z-[601]`) with the order only in comments,
  now named layers.
- **White text on `blue-500`, `emerald-500`, `red-500` fills** (3.4–3.8:1): solid fills under
  text are now the `*-emphasis` tones (≥ 4.7:1).
- Font sizes in 15 one-off pixel values (`text-[9px]` … `text-[64px]`), now the type scale.
- Mini-app icons, app-store categories and tab colours were hex strings in data; they are tones.
- Tailwind's `--font-*` reset does not cover `--font-weight-*`, and keyframes behind a variable are
  not emitted: both found by checking the built CSS, both handled in the generator.

The migration ran `design/build/migrate.mjs` (2,487 rewrites) and then by hand; the result was
compared with screenshots of the old chrome (`scripts/ui-screenshots.mjs --compare`). Intended
differences: brighter quiet text, darker-but-readable buttons, app icons on the token tones,
about 3 px of line-height change on the new-tab page. The e2e suite passes unchanged.
