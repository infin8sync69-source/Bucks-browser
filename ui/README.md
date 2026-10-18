# Bucks Browser chrome (SvelteKit SPA)

The browser UI: header island, tab strip, omnibox, internal `bucks://` pages (settings, IPFS,
downloads, wallet, history, bookmarks) and the agent chat. It is built as a static SPA
(`adapter-static`, `index.html` fallback) and served by the Electron main process from
`bucks://app/`.

- External pages are **not** rendered here: they are `WebContentsView`s owned by the main process.
  `src/lib/ContentArea.svelte` reports the rectangle where the active one is drawn.
- All main-process access goes through `window.bucks` (`src/preload/preload.cjs`), typed in
  `src/lib/bridge.ts`. Outside Electron a labelled in-memory mock is used so `npm run dev` still renders.
- The IPC contract lives in `docs/IPC-CONTRACT.md` at the repository root.

```
npm run dev     # vite on http://localhost:1420 (use scripts/dev.mjs from the root to run it inside Electron)
npm run check   # svelte-check, must report 0 errors
npm run build   # writes ui/build (index.html + _app/**), reproducible byte for byte
```
