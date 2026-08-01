# Bucks Browser — Chromium Engine Architecture

*Last updated: 2026-07-16*

## The engine decision

Bucks runs on **the actual Chromium engine — Chromium 148.0.7778.265, embedded via Electron 42.4.1**. Every tab is a real Chromium renderer process with full site isolation, the V8 JIT, Blink layout, and the complete web platform (WebGL, WebRTC, WASM, Service Workers, media codecs).

Three ways exist to "have a Chromium engine"; Bucks uses the only one that fits its constraints:

| Approach | What you get | Cost | Verdict |
|---|---|---|---|
| **Chromium fork** (Brave/Edge model) | Full control incl. UI toolkit, sync, extensions store | ~100 GB disk, 32 GB+ RAM builds, hours per compile, a team to track 4-week upstream releases | Not feasible (dev machine: 16 GB RAM, disk chronically full) |
| **CEF** | Embedded engine, C++ shell | C++ shell rewrite, loses the whole existing JS shell + agent stack | No benefit over Electron for Bucks |
| **Electron embed** (current) | Same Chromium, 8-week upgrade cadence via `npm`, shell stays JS, main-process API for tabs/permissions/downloads | An `npm install` per engine upgrade | ✅ Current architecture |

**Engine upgrades = bumping the `electron` version in `electron/package.json`.** Electron tracks Chromium's stable channel; staying within 1–2 majors keeps the engine as current as Chrome itself.

## Process & layer architecture

```
┌────────────────────────────  main process (Node + Chromium browser process)
│ main.js                 boot, windows, IPC hub, downloads, ad-block
│ tab-manager.js          WebContentsView host: one Chromium renderer per tab/pane
│ permission-manager.js   per-origin permission broker (prompt + persist)
│ web-security.js         TLS interstitial, HTTP auth dialog, Chrome UA
│ extension-loader.js     unpacked Chrome extensions from ~/.bucks/extensions
│ ipfs-node.js / bridge   Helia node + Kubo-compat API (ipfs://, ipns://, bucks://)
│ soul-engine-supervisor  local-AI lifecycle (:8765)
├────────────────────────────  shell renderer (index.html, sandboxed, no Node)
│ renderer.js             omnibox, tab strip, session restore, downloads UI,
│                         history/bookmarks, A2UI component library
│ tab-view.js             TabView shim: placeholder <div> ↔ native view bounds
│ pane-manager.js         spatial multi-pane workspaces inside one tab
│ agent-browser-control.js  agent actuation: snapshots, clicks, pane tools
├────────────────────────────  page renderers (one Chromium process per pane)
│ sandbox: true, contextIsolation: true, nodeIntegration: false
│ partitions: default (persistent) · bucks-private (in-memory)
└────────────────────────────
```

The invariant that shapes the UI: **native WebContentsViews always paint above shell DOM**. All chrome that must appear "over" a page (agent dock, pane headers, find bar) exists as reserved bands the view bounds are inset from — see `TOP_OVERLAYS`/`BOTTOM_OVERLAYS` in tab-view.js and the pane-stage layout.

## End-to-end capability matrix

| Capability | Status | Where |
|---|---|---|
| Tabs w/ site isolation, sandbox | ✅ | tab-manager.js (WebContentsView) |
| Spatial multi-pane tabs + agent sweep | ✅ | pane-manager.js, agent-browser-control.js |
| Omnibox + suggestions, find-in-page, zoom, print, devtools | ✅ | renderer.js |
| Session restore (lazy-hydrating tabs) | ✅ 2026-07-16 | renderer.js `restoreSession()` |
| **Durable shell storage** (bookmarks/history/profile) | ✅ 2026-07-16 (was lost on quit) | preload.js + main.js `shell-storage` |
| **TLS validation + interstitial** | ✅ 2026-07-16 (was globally OFF) | web-security.js |
| HTTP Basic/Digest & proxy auth | ✅ 2026-07-16 | web-security.js |
| Web permissions (geo/camera/mic/notifications/HID/serial/BT) | ✅ | permission-manager.js |
| Downloads manager | ✅ | main.js + renderer.js |
| Private windows (in-memory partition) | ✅ | main.js / renderer.js |
| Ad blocking | ✅ | main.js |
| Chrome-compatible UA (Electron token stripped) | ✅ 2026-07-16 | web-security.js |
| Spellcheck + menu suggestions | ✅ 2026-07-16 | web-security.js + tab-manager.js |
| Chrome extensions (content scripts / MV3 subset) | ✅ loader 2026-07-16 | extension-loader.js (`~/.bucks/extensions`) |
| Default-browser registration + OS link handling | ✅ opt-in IPC | main.js (`set-default-browser`, open-url) |
| dweb: ipfs:// ipns:// bucks:// | ✅ | main.js protocols + ipfs-bridge.js |
| Local AI agent over live tabs | ✅ | soul_engine.py + agent-browser-control.js |
| Extension toolbar/popup UI | ⬜ roadmap | needs shell UI for browser actions |
| Password manager / autofill | ⬜ roadmap | needs Keychain-backed store + form detection |
| Per-site zoom memory, PiP button, media hub | ⬜ roadmap | renderer.js |
| Sync (bookmarks/history via P2P) | ⬜ roadmap | natural fit for the Helia/gossipsub layer |

## Security posture

- Renderers: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` — a compromised page cannot reach Node.
- TLS: Chromium's verdict stands. The former global `ignore-certificate-errors` switch (which silently disabled HTTPS security for every request) was removed 2026-07-16; invalid certs show a Chrome-style interstitial whose override is per-origin and dies with the app session. **Never re-add that switch.**
- Permissions: default-deny; privacy-sensitive types prompt per origin and persist in `userData/permissions.json`; the private partition never persists grants.
- Extensions load only from the user's own `~/.bucks/extensions` folder, with `allowFileAccess: false`.
- The shell renderer is sandboxed too; all privileged operations cross a typed IPC surface in preload.js.

## Known engine gotcha: file:// shell storage

Modern Chromium gives `file://` documents an **opaque origin whose DOM storage is ephemeral** — the shell's `localStorage` (bookmarks, history, profile, contacts, session) silently reset on every quit once the engine passed ~Chromium 115. Fixed 2026-07-16: preload.js hydrates `localStorage` from `userData/shell-storage.json` before any shell script runs and streams dirty-checked snapshots back to main (in-memory authoritative copy, atomic file writes). If the shell ever moves to the privileged `bucks://` scheme (a real origin with persistent storage), this shim can be retired — the hydration path doubles as the migration.

## Upgrade playbook (engine refresh)

1. `cd electron && npm install electron@latest`
2. `node --check` the main-process files; skim the Electron breaking-changes list for `WebContentsView`, `session`, and `permission` APIs (the surfaces Bucks touches).
3. `npx playwright test tests/` — the e2e suite asserts boot, spatial geometry, panes, agent tools, and TLS behavior.
4. Package + install per the existing build config.
