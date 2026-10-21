# Plan v2: Bucks-browser as the single Bucks browser, without Svelte

Date: 2026-10-19. Supersedes the earlier version of this file, which kept Svelte.

Decisions:
1. `infin8sync69-source/Bucks-browser` is the final repository.
2. Bucks Core (the `renderer.js` app, buckscore `Bucks-App/`, and the local
   `chore/production-cleanup` line) is frozen and used as a feature reference only.
3. **Svelte and SvelteKit are removed.** The chrome (the browser's own interface) is rebuilt without
   a UI framework. The main process, the Python Soul Engine, Kubo, the IPC contract and the
   Playwright tests are kept.

## 1. Is it feasible? Yes. Evidence from the repo (branch `claude/browser-repos-alignment-aew07f`)

| Fact | Why it matters |
|---|---|
| Svelte lives only in `ui/`: 60 `.svelte` files (8,224 lines) and 21 `.ts` files (4,685 lines). `src/main` (48 files), `agent/` and `src/preload` have no UI-framework code | The rewrite is a bounded job. Nothing else changes |
| The only link between UI and main process is the preload bridge `window.bucks`, typed in `ui/src/lib/bridge.ts` and specified in `docs/IPC-CONTRACT.md` | The new UI is built against a written contract. No main-process work is needed to start |
| `bucks://app/` serves `ui/build` as plain static files with an index.html fallback (`src/main/protocols/bucks.js`); the pure resolver takes one folder argument | The new chrome only has to produce a static folder. Old and new builds can be switched with one setting |
| Only 8 of the 21 `.ts` files import Svelte, all from `svelte/store`. 0 files use SvelteKit's `$app` modules | About 13 of 21 TypeScript files (bridge, crypto, search, omnibox, formatting) move over unchanged |
| The 7 Playwright e2e files select by role and accessible name (`getByRole('dialog', {name: 'Widget library'})`), not by Svelte internals | The e2e suite is a framework-independent acceptance test: the new chrome must pass the same files |
| Tailwind (`@tailwindcss/vite`), Vite, noble crypto and TypeScript are not Svelte-specific | They stay. Only `lucide-svelte` (42 import lines) changes, to the framework-free `lucide` package |
| The only Svelte-specific pieces outside components: SvelteKit's CSP hash mode (`svelte.config.js`), `svelte-check` in CI, `adapter-static` | Each has a direct replacement (section 3) |

Rough size: 60 components to rewrite, about 8k lines of markup and logic, the 8 store files, and
the CSP and CI changes. I estimate **5 to 7 weeks for one developer**, with the e2e suite as the safety net.
This is an estimate, not a measurement.

## 2. What it costs you (honest trade-offs)

- Svelte gives automatic re-rendering, scoped styles and compile-time accessibility warnings. Without a
  framework you write the rendering yourself and lose those checks. Mitigation: a small shared base class
  and store (section 3), an axe accessibility check in Playwright, and strict lint rules.
- Bucks Core's `renderer.js` (9,900 lines) is what framework-free code looks like when it has no
  structure. The rule that prevents a repeat: one component per file, a size limit per file, no
  globals, all state in typed stores.
- Security: hand-built DOM invites unsafe `innerHTML`. Rule: text goes in with `textContent`; HTML
  from the agent or the web only passes through the existing sanitiser in `src/main/agent/genui.js`.
- It is a rewrite of working, tested code. Features stop for the duration unless they are main-process work.

## 3. Replacement stack

| Concern | Now | New |
|---|---|---|
| Components | Svelte 5 | Native Web Components (custom elements) in TypeScript, on a ~150-line base class with a `render()` method and `store.subscribe` |
| State | `svelte/store` | A typed store module with the same `subscribe/set/update` shape, so the 8 store files change one import |
| Pages and routing | SvelteKit file routes, SPA fallback | One HTML entry per internal page (history, downloads, settings, ipfs, wallet, login) plus the main chrome, built with Vite multi-page. `bucks://` already serves static folders |
| Build | `vite` + `@sveltejs/kit` | `vite` alone |
| Styling | Tailwind 4 | Tailwind 4 (unchanged) |
| Icons | `lucide-svelte` | `lucide` (framework-free) |
| Type check in CI | `svelte-check` | `tsc --noEmit` |
| CSP | SvelteKit hash mode | Strict policy sent as a header by the `bucks://` protocol handler: `script-src 'self'`, no inline scripts. Simpler than before and testable in a unit test |
| Accessibility checks | Svelte compiler warnings | `@axe-core/playwright` run inside the existing e2e files |

Fallback: if the first three components show too much boilerplate, adopt **Lit** (about 5 KB, still
web components, no compiler). That is a gate at the end of Phase 1, not a default.

## 4. Migration method: replace the whole chrome behind one switch

No mixing of Svelte and the new code in the same window.

1. Create `chrome/` beside `ui/`. Build it to `chrome/dist`.
2. The main process picks the folder from a setting (default `ui/build`; `BUCKS_CHROME=next` selects `chrome/dist`).
3. Port in this order, running the e2e files against `next` after each step: bridge and stores,
   shell (header, tabs, spaces, find bar), new tab and widgets, agent chat and bar, internal pages.
4. Parity gate: all 7 e2e files and the 284 unit tests pass against `next`. Then flip the default,
   delete `ui/`, drop the Svelte dependencies, update CI and docs.

## 5. Phases

**Phase 0: Housekeeping (days)**
1. Merge `claude/browser-repos-alignment-aew07f` into `master` by pull request, after running e2e on a
   machine with Electron and Kubo. This freezes the baseline that the new chrome must match.
2. Rotate the leaked Supabase password (in buckscore history and in the local history).
3. Freeze new Svelte feature work. Protect `master`; keep the CI checks required.

**Phase 1: Foundation and spike (about 1 week)**
Base class, store, build config, the strict CSP header, bridge and the 13 reusable TypeScript files.
Port three components (find bar, tab context menu, space switcher) to test the approach.
Gate: keep going without a framework, or adopt Lit.

*Started (2026-10-20):* the design system ([DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)) is the shared
styling layer for both chromes: tokens, a Tailwind theme that admits nothing else, a linter, and
twelve framework-free components on a ~100-line base class (`design/components/base.js`). The Svelte
chrome is migrated onto the tokens, so screens look the same in both. `chrome/src/apps/` (the Apps
screens) is the first framework-free feature, mounted in the Svelte chrome at `bucks://apps`; it
answers the gate for now: no framework needed so far. Still to do in this phase: the store, the
Vite multi-page build of `chrome/` on its own, the CSP header, and the three spike components.

**Phase 2: Shell (about 2 weeks)**
Header (793 lines, the biggest), content area, tabs, spaces, window frame. Exit: `smoke` and
`browser-features` e2e pass on `next`.

**Phase 3: New tab, agent, internal pages (about 2 to 3 weeks)**
Home screen, widgets, profile panel, model picker, status cards, chat panel (545), agentic bar,
generative cards, ephemeral widget (464), then settings, wallet (704), downloads, history, IPFS and devices pages.
Exit: all 7 e2e files and axe checks pass. Flip the default, delete `ui/`.

**Phase 4: Bucks Core features, built straight into the new stack**
Order follows the earlier plan: spatial stage and agent dock, mini apps (calculator, clock,
converter, notes, QR), then encrypted chat, app store, dWeb publish and studio, feed, cluster,
split view, light theme, mining controls, maps.

**Phase 5: Hosting, chain and release**
OS keychain for wallet keys, pinning layer, `bucks://` name resolution, signed builds, auto-update.

### Runs in parallel with Phases 1 to 3 (main-process work, no UI)
Encrypted chat engine on Kubo pubsub, device-share encryption and pairing code, OS keychain
storage, cluster/pinning service, `open-url` handling. These touch `src/main`, `agent/` and
`docs/IPC-CONTRACT.md` only, so a second person can do them while the chrome is rebuilt.

## 6. Why Bucks Core's vanilla code helps
Bucks Core's feature modules (`app-store.js`, `messages-ui.js`, `ephemeral-ui.js`, `file-manager-ui.js`,
`nim-panel.js`) are already framework-free DOM code, so they are easier to port to web components
than to Svelte. They call `window.bucksAPI` (63 call sites, 132 channels in its preload); the new
chrome calls `window.bucks`. Port each as a component, mapping calls to the documented contract,
not as a global script.

## 7. Feature table (target is now "web component in `chrome/`")

| Feature | Source | Effort | Notes |
|---|---|---|---|
| Spatial stage + bottom agent dock | local commit `d69e902` | M | Only exists locally. Build on `WebContentsView` bounds |
| Ephemeral UI | `ephemeral-ui.js` 797 | S–M | Diff against `EphemeralWidget.svelte` first |
| Mini apps (5) | `bucks-*.html` ~1,600 | S | Self-contained; serve under `bucks://` |
| App store | `app-store.js` 982 + data 466 | M | Needs a per-app sandboxed `WebContentsView` and permission prompt |
| Encrypted chat | `messages-ui.js` 503 + `src/main/chat/` | L | Highest value; needs a two-machine test |
| Feed, dWeb publish and search, dWeb studio | main modules + `dweb-studio.html` | L | Define the content format first |
| Cluster, shared pins | `cluster-*.js` ~780 | L | Keep cluster secrets out of git |
| Split view, light theme | `pane-manager.js` 429 | M | Unlocks agent split panes |
| Mining controls | node HTTP API | M | Client only |
| Maps (universe, earth) | ~2,360 lines | M–L | Low priority; map tile hosts see queries |
| Benchmark and NIM panels | ~1,280 lines | S | NIM is a cloud backend: opt-in with user's key |
| Markets widget, bundled chain/miner binaries | – | – | Not carried over |

## 8. Rules from here
- One feature per branch off `master`, merged by pull request.
- Each feature: a unit test for pure logic plus one Playwright path, and a line in `FEATURE-PARITY.md`.
- No credentials in git. Cloud features are opt-in with the user's own key.
- No file over about 400 lines in `chrome/` without a stated reason.

## 9. Open questions
1. Framework-free from the start, or Lit as the base? My recommendation is framework-free with the Phase 1 gate.
2. Feature freeze during Phases 1 to 3, or keep shipping features in Svelte and rewrite them twice? I recommend the freeze.
3. The 82 uncommitted local files are not on GitHub. Review them for anything not in the snapshot branch?
