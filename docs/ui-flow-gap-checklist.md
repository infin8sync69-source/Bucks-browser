# UI Flow Gap Checklist — prioritized

**Status:** Audit complete, grounded in actual code (file:line references throughout — nothing here is speculative). Fixes not yet applied unless noted. Companion to `production-distribution-plan.md`.

**How to read this:** every item is tagged **P0** (broken, misleading, or blocks a core flow — fix before wider distribution), **P1** (missing, real gap, not blocking), or **P2** (polish). Two design questions the user explicitly asked to have defined and validated get their own sections (§2, §3) rather than being buried in the table.

---

## 0. The one finding worth reading even if nothing else gets read

**A fully-wired feature is silently dead.** `Cmd/Ctrl+K` opens a "Spotlight"-style popup (`electron/ephemeral-window.js`) with a real input field, a real IPC round-trip back to the main window (`agent:ephemeral-query`), and a real preload API waiting to receive it (`bucksTabs.onEphemeralQuery`, `electron/preload.js:244-248`). **Nothing in `renderer.js` ever calls that listener.** Typing a query and pressing Enter does nothing observable — no error, no fallback, just silence. This is exactly the kind of half-finished feature a UI audit exists to catch: every piece was built except the last one connecting it to anything visible. Fixing it is small (wire the listener to `sendChat()` or a dedicated ephemeral-result renderer) and directly serves the "ephemeral popups with clickable CTA" goal in §3. **P0.**

---

## 1. Prioritized checklist

### P0 — fix before wider distribution

| # | Gap | Where | Why it's P0 |
|---|---|---|---|
| 1 | ~~Cmd+K ephemeral popup is fully wired but has no receiving listener~~ **FIXED** — routed into the same `sendChat()` pipeline as the main chat box | `electron/renderer.js` (new `onEphemeralQuery` listener) | Verified: syntax-checked; not yet interactively clicked through in the running app |
| 2 | ~~Model download has no progress indicator~~ **FIXED** — `edge_llm.py` now tracks real on-disk byte progress via a background monitor thread during `_download()`; exposed via `GET /models/download-progress`; both model-switcher UIs (chat header selector + New Tab picker) poll it and show live "Downloading X% (Y/Z MB)" | `agent/edge_llm.py` (`_download_progress`, `_watch_download_progress`, `get_download_progress`), `agent/soul_engine.py` (new endpoint), `electron/renderer.js` (`startModelDownloadPolling`/`formatDownloadProgress`, both call sites) | Verified: real threaded test confirms byte-progress tracking is accurate (mid-download and at completion); Python + JS syntax-checked |
| 3 | ~~"Agent" status card shows ready/green during first-run model download~~ **FIXED** — the poller now branches on `mode:"loading"` and shows the live download percentage (or "Loading model…") instead of "Soul Engine ready" | `electron/renderer.js` (`updateNewtabStatus`'s health-check block) | Verified: syntax-checked; logic mirrors the already-correct server-side `mode` field |
| 4 | ~~Core clickable CTA surfaces are keyboard-unreachable~~ **FIXED** — product cards, checklist items, New Tab status cards, and conversation list items now carry `role="button"`/`tabindex="0"`/keydown (Enter+Space) handling | `electron/renderer.js` (feed-cid, both `gu-product` cards, `gu-check-item`, status-card wiring), `electron/index.html` (3 status cards), `electron/messages-ui.js` (conversation list) | Verified: DOM attributes confirmed present via live inspection. Not yet click-through tested in the full running app (needs the Electron/agent-server bridge, not just a static preview) |
| 5 | ~~No first-run onboarding of any kind~~ **FIXED** — a dismissible overlay now explains Soul Agent, P2P/IPFS, wallet/mining, and Cmd+K on first launch, gated on a persisted `onboardingSeen` setting (reuses the existing get/save-settings IPC, no new plumbing) | `electron/index.html` (`#onboarding-overlay`), `electron/renderer.js` (`init()`), `electron/main.js` (`onboardingSeen` default) | Verified: syntax-checked, DOM structure/attributes confirmed via live browser inspection. **Not yet verified interactively** — a static file preview has no `window.bucksAPI` (no Electron preload bridge), so the actual show-once/dismiss/persist behavior needs confirming in the real running app |

### P1 — real gaps, not blocking

| # | Gap | Where |
|---|---|---|
| 6 | Model/engine picker has exactly one entry point (chat panel header), duplicated in two DOM locations kept in sync manually; the Settings dashboard has no model/provider control at all | `electron/index.html:371-384,1400-1407`, sync logic `electron/renderer.js:6294-6307`; `view-settings` at `electron/index.html:1138-1208` has nothing model-related |
| 7 | No typing/thinking indicator independent of the step-card system — if the first SSE event is delayed (e.g. during model load), the user sees literally nothing until the first event arrives | Confirmed absent via repo-wide grep (`typing-indicator`/`dot-flashing`/`isTyping`: zero hits) |
| 8 | Approve/Deny action gate degrades to a bare `window.confirm()` when `nexusAPI` isn't present — no styling, no 30s countdown, blocks the render thread | `electron/renderer.js:5492-5497` vs. the real styled card at `electron/renderer.js:4993-5015` |
| 9 | Zero `aria-*` and zero `role=` attributes anywhere in the primary HTML/renderer surfaces (`index.html`, `renderer.js`, `messages-ui.js`, `newtab.html`, `dweb-studio.html`, `ephemeral.html`) | Repo-wide grep counts in the research report |
| 10 | Icon-only buttons rely on `title=` alone (57 instances) rather than `aria-label` — weak screen-reader support | e.g. `electron/index.html:1453` |
| 11 | Two unrelated systems are both called "ephemeral" in code (the genui/`nt-ephemeral-zone` in-page render surface vs. the Cmd+K popup window) — real naming confusion for anyone extending either | `electron/index.html:314`, `electron/renderer.js:6114-6150` vs. `electron/ephemeral-window.js` |

### P2 — polish

| # | Gap | Where |
|---|---|---|
| 12 | Disabled (RAM-infeasible) model options have no tooltip explaining why | `electron/renderer.js:6243` |
| 13 | No landmark regions (`<main>`, `<nav>`, skip link) for screen-reader navigation of the shell | App-wide |
| 14 | Generative-UI cards built via raw `innerHTML` template strings — consistent with the rest of the codebase, but reinforces #9/#10 since no role/tabindex gets baked in by construction | e.g. `electron/renderer.js:5029-5040` |

---

## 2. Defined & validated: "agents downloadable only after installing the app, from the chat interface"

**Validated as already true, structurally.** Checked every plausible alternate entry point:

- The Settings dashboard (`view-settings`, `electron/index.html:1138-1208`) has no model or provider control.
- The separate settings sidebar (`electron/index.html:1586-1595`) explicitly defers to the dashboard, which doesn't have one either.
- No first-run wizard exists that could pre-select or pre-download a model (see P0 #5).
- `agent/setup_models.sh` is a dev-only script that pulls Ollama models — unrelated to the embedded GGUF catalogue, not reachable from the app UI at all.

**The one and only path to downloading/switching a model is**: chat panel header → "Engine:"/"Model:" selectors (`electron/index.html:371-384`, duplicated at `:1400-1407`) → `populateNavChatModels()` fetches the catalogue from the already-running local agent server → selecting a model calls `POST /models/select` → `edge_llm.switch_model()` downloads (if not cached) then loads. This can only happen after the app — and therefore the local agent server — is installed and running. **Requirement satisfied by construction, not by convention**: there is no code path that could download a model before install, because the catalogue and the download logic both live inside the installed app's own local server.

**What actually needs fixing isn't "is it chat-only" (it is) — it's whether that flow is trustworthy**, which is exactly P0 #2 and #3 above: right now, clicking a model in the list gives no progress feedback and the status card can actively lie about readiness during the download. Fix those two and this requirement goes from "technically true" to "obviously true to the user."

## 3. Defined: the ephemeral-popup + clickable-CTA agentic interaction pattern

Three separate systems exist under this umbrella today — worth being explicit about which is which before extending any of them:

- **System A — inline generative-UI cards** (`agent/genui.py`, `_ALLOWED` set of 15 component types, rendered via `renderComponent()` in `electron/renderer.js:4802`). This is the real, working "agent shows a card with a button, click it to do X" pattern — `cta_row` (`agent/genui.py:77-79`) is a first-class component type, and clicks route through one global dispatcher, `window.__bucksGenUIAction(kind, value)` (`electron/renderer.js:3868-3882`), to one of four action kinds: `navigate`, `search`, `agent`, `copy`. **This is the pattern to build on.** It already renders inline in the chat stream inside `nt-ephemeral-zone` (`electron/index.html:314`).
- **System B — the Cmd+K popup window** (`electron/ephemeral-window.js`). Separate `BrowserWindow`, separate preload, no access to System A's component renderer at all — it can only ever forward plain text into chat, never render its own card. Currently dead end-to-end (§0).
- **System C — the approve/deny action gate** (`electron/renderer.js:4993-5015`). A specific, narrower kind of ephemeral CTA — not "click to do something new," but "confirm/deny something the agent already proposed," with a 30-second auto-deny timer. Already functional; the only gap is the unstyled `window.confirm()` fallback (P1 #8).

**Recommended logic going forward** (this is the "define and validate" the request asked for):
1. **All new agentic ephemeral interactions should be System-A `cta_row`/generative-UI cards**, rendered in-stream via `renderComponent()` — not a separate popup window. This keeps every clickable CTA on one dispatcher (`__bucksGenUIAction`), one place to enforce accessibility fixes (P0 #4), and one visual language.
2. **System B (Cmd+K) should either be wired to feed straight into the same chat pipeline** (`sendChat()`, same as pressing Enter in the main chat box) **or be retired** — right now it's a second, disconnected entry point that can't even render the cards System A can. Given it's currently 100% dead code from the user's perspective, the lowest-risk fix is wiring `onEphemeralQuery` → `sendChat(query)`, which makes Cmd+K a fast-launch shortcut into the exact same, already-working flow rather than a parallel system to maintain.
3. **Action confirmation (approve/deny) stays its own thing** — don't collapse it into `cta_row`, since it has different semantics (a default/timeout action, tied to a specific pending tool call rather than a free-standing button) — but its unstyled fallback (P1 #8) should be brought up to the same visual/interaction standard as the primary path, not left as a lesser-quality backup.

---

## 4. Accessibility — concrete fix list (expands P0 #4 / P1 #9-10 / P2 #13)

- Add `role="button"` + `tabindex="0"` + a `keydown` handler (Enter/Space → same action as click) to every element identified in P0 #4.
- Add `aria-label` alongside (not instead of) existing `title=` attributes on the 116 icon-only buttons in `index.html`.
- Add basic landmark structure: `<main>` around the primary content area, `<nav>` around the tab strip/dock, a skip-to-content link.
- Add `<html lang="en">` if not already present (verify — not explicitly checked in the research pass).
- These are almost entirely additive (attributes + a handful of keydown handlers) — low risk of regressing existing click behavior, since `onclick` handlers stay as-is.

---

## 5. Suggested execution order

Grouped by what unblocks what, not just severity:

1. **Wire the Cmd+K listener** (§0 / P0 #1) — smallest, highest-visibility fix, directly resolves the "ephemeral popup with CTA" ask.
2. **Model download progress + honest health status** (P0 #2, #3) — makes the "agents downloadable only via chat" flow actually trustworthy, not just technically correct.
3. **Keyboard access on CTA/card surfaces** (P0 #4 / §4) — unblocks the core shopping/agent-action flow for keyboard and screen-reader users; mechanically small (attributes + handlers), high impact.
4. **First-run onboarding** (P0 #5) — biggest single piece of net-new UI; do this after the above so onboarding can honestly describe a flow that already behaves correctly (no point onboarding someone into a misleading status card).
5. **P1 items** (settings-page model mirror, thinking indicator, styled approval fallback, aria/role sweep) — can proceed in parallel with 4, none block each other.
6. **P2 polish** — after the above.
