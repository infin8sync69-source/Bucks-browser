# Bucks Browser — Master Phase Checklist

**Status:** Living tracker, consolidating everything built/verified/planned so far. Each item is checked only if it's actually implemented **and** verified (via a real test, not just "should work"). Detailed design lives in the companion docs linked per section — this file is the executive view across all of them.

**Sprint tracking:** Current sprint = wallet + mining fixes (this update). **Smart contracts explicitly deferred to sprint 2** per direction — not scoped here at all; `bucks-node.js` is an account-model chain today with no contract/VM layer, so that's genuinely new-build work for next sprint, not a fix to something existing.

**Companion docs:** `ble-mesh-comms-plan.md` · `production-distribution-plan.md` · `ui-flow-gap-checklist.md`

---

## Phase 1 — Architecture

### P2P / IPFS foundation
- [x] Helia + libp2p (TCP, noise, yamux, gossipsub) node — verified via real two-process Bitswap + gossipsub test
- [x] Kubo bridge (`ipfs-bridge.js`, Kubo-compatible HTTP API + Helia↔Kubo peering) — verified working, including live peering with a real local Kubo daemon
- [x] Cluster membership (invite-grown, genesis-seeded admission graph) — verified via real 4-node multi-process test, including anti-spoof rejection
- [x] Cluster-gated file discovery (feed posts attributed + filtered by cluster membership) — verified: member content visible, outsider content correctly excluded from the gated view but still visible in the global feed
- [x] Multi-device sync (mutual signed device-link attestation + IPFS state-snapshot sync) — verified: link requires both directions, followed-peers auto-merge, pinned-CID references surface without auto-fetch
- [ ] BLE mesh transport, hybrid capability/inference routing, voice/video over mesh — **design only**, see `ble-mesh-comms-plan.md` phases 1-5; no code written

### Distribution architecture
- [x] Reachability of the origin IPFS node tested from an external gateway (`dweb.link` succeeded; `ipfs.io` timed out) — real signal, not assumed
- [ ] `install.sh` / `install.ps1` — not written
- [ ] `build-and-pin-release.js` extended with a `source-tarball` artifact kind — not done
- [ ] `cluster-updater.js`'s `applyPendingUpdate()` extended with a source-tarball branch (extract + re-run install + restart, instead of `shell.openPath()`) — not done
- [ ] bucks.global landing page + Download CTA + CID pointer — not started; **blocked on repo access decision** (see Open Decisions)
- [ ] NAT/port-forward investigation on the Mac mini's Kubo node, to explain the `ipfs.io` timeout — not done

---

## Phase 2 — Backend

### Cryptography / identity
- [x] Hybrid post-quantum X3DH (ML-KEM-768 + X25519 mixed via HKDF into the session root key) — verified end-to-end via real two-process chat test, log-confirmed hybrid path
- [x] Hybrid signatures on pre-key bundles (ML-DSA-65 + Ed25519, both covering the same bound classical+PQ bytes) — verified: valid bundle accepted, tampered signature (either scheme) rejected
- [x] Backward compatibility with non-upgraded peers (classical-only fallback, `pq:false` flag) — verified
- [x] Documented rationale for NOT re-running PQ KEM on every Double Ratchet step (HKDF one-wayness already protects the whole chain from a PQ-seeded root) — decision recorded in `signal-store.js` header
- [ ] Pinned SHA-256 digests for the embedded GGUF model catalogue (`edge_llm.py`) — flagged in the 2026-07-06 production audit as unenforced; not yet closed

### Core services
- [x] `device-sync.js` (mutual device-link attestation, state-snapshot publish/merge) — verified via real 4-process multi-device test
- [x] `cluster-membership.js` extended with `getSoulIdForPeer()` reverse lookup (feed-post attribution anti-spoof) — verified
- [x] `ipfs-node.js`'s `getFeed()` cluster-gating + `getFollowing()` export — verified
- [x] **Wallet + mining backend (`bucks-node.js`) — re-audited and found solid, not dead.** The 2026-07-06 audit's "critical: wallet RPC targets nonexistent `:8080`" finding is **stale** — `wallet-rpc` in `main.js` already calls `bucks-node.js`'s `handleRPC()` in-process, no HTTP proxy at all. Verified via a new real end-to-end test (`scripts/test-bucks-node.js`, 23/23 passing): wallet create/restore (deterministic from mnemonic, unique per wallet), mining (single-block and continuous start/stop, correct coinbase rewards), transactions (send, overspend/bad-amount/unknown-sender rejection, correct balance updates once mined), economy/blockchain-info stats, and persistence across a restart.
- [ ] `social-rpc` (`main.js`) still proxies to a nonexistent `:8000` — genuinely dead, but out of this sprint's scope (wallet + mining only, per this sprint's direction)
- [ ] Messages UI backend completeness — open ship/hide decision, unrelated to wallet/mining

### Model / agent server
- [x] Validated: model download is reachable **only** through the chat interface's Engine/Model selector — no other UI entry point exists (checked settings dashboard, settings sidebar, first-run flow — none of them have one)
- [ ] Model-download progress indicator (currently: silent multi-minute download, toast only after the fact) — designed, not implemented
- [ ] `/health` status card correctly reflecting `mode:"loading"` during first-run download (currently shows "ready" regardless) — designed, not implemented

---

## Phase 3 — Frontend

- [x] Generative-UI card system (`cta_row` + 14 other component types, `renderComponent()`, single click dispatcher `__bucksGenUIAction`) — existing, confirmed functional; **the pattern all future agentic CTAs should build on**
- [x] Approve/Deny agent-action gate (styled card, 30s auto-deny timer) — existing, functional
- [x] Cmd/Ctrl+K ephemeral command bar — **was fully wired but silently dead** (popup → IPC → no listener); fixed this session by routing it into the same `sendChat()` pipeline as the main chat box
- [x] **Mining UI — was completely absent** (`/api/mining/*` had zero call sites anywhere in `renderer.js`/`index.html` despite a fully working backend); added a third "Mine" tab to the existing wallet panel (alongside Send/Receive, same pattern), with start/stop toggle, live status/hashrate polling (2s interval, only while the tab is visible, cleaned up on tab switch or panel close)
- [ ] Approve/Deny's `window.confirm()` fallback path (used when `nexusAPI` is absent) brought up to the same styled/timed standard as the primary path — not done
- [ ] Settings-page mirror of the model/engine picker (currently chat-only, which is correct per the "downloadable only from chat" requirement, but means a user who never opens chat has zero visibility into an active multi-GB model) — not done
- [ ] Dedicated typing/thinking indicator independent of the step-card system (currently: nothing shown until the first SSE event arrives) — not done
- [ ] First-run onboarding flow (wallet, IPFS/swarm, model-download-on-first-use, Cmd+K, device linking — none of it is currently explained anywhere) — not started, biggest remaining net-new UI piece
- [ ] Device-pairing UI (link a second device via `device-sync.js` — currently IPC-only, no screen; natural fit is extending the existing `bucks-qr.html` X3DH pairing screen) — not started

---

## Phase 4 — UX / UI (accessibility & flow polish)

Full detail in `ui-flow-gap-checklist.md` — summary here:

- [x] Full source-grounded UI audit completed (file:line references, not generic advice)
- [x] P0 #1 fixed this session (dead Cmd+K popup — see Phase 3)
- [x] P0 #2/#3 — model download progress + honest status card — done (real byte-progress tracking, both model-switcher UIs, status card respects `mode`)
- [x] P0 #4 — keyboard/screen-reader access on core clickable surfaces — done (product cards, checklist items, status cards, conversation list items now have `role`/`tabindex`/keydown)
- [x] P0 #5 — first-run onboarding — done (dismissible overlay explaining Soul Agent/P2P-IPFS/wallet-mining/Cmd+K, gated on a persisted setting)
- [ ] P1 — zero `aria-*`/`role=` attributes anywhere in the primary UI surfaces; icon buttons rely on `title=` alone instead of `aria-label`
- [ ] P2 — landmark regions (`<main>`/`<nav>`/skip link), disabled-option tooltips, `<html lang>` check

---

## Phase 5 — Other core components

### Security posture (from the 2026-07-06 production audit, re-scoped for public distribution)
- [x] **CSP — audit finding was stale AND the real policy was broken.** A CSP already existed (injected via `session.webRequest.onHeadersReceived` in `main.js`, not a `<meta>` tag, which is why the audit's static scan missed it). But its `script-src 'self'` had no `'unsafe-inline'`, and inline event-handler attributes fall under `script-src` — **empirically proven** (controlled Electron test) that all ~95 inline `onclick`/`onkeydown` handlers were silently dead, including the keyboard-accessibility fixes added earlier this session. Fixed by adding `'unsafe-inline'` to `script-src` only; no `unsafe-eval`, no remote script origins. **Verified in the real running app: zero CSP violations.**
- [x] **Model digest pinning** — all 9 `_GGUF_CATALOGUE` entries now carry real SHA-256 digests (fetched via HF `X-Linked-ETag` HEAD requests, no multi-GB downloads). Tamper-rejection and correct-digest acceptance both tested.
- [x] **Atomic persistence for chain + wallets (`bucks-node.js`)** — found `chain.json` truncated to **0 bytes** in the live app: `writeFileSync` is non-atomic, so a kill mid-write destroys it (same hazard guarded `wallets.json`, i.e. wallet seeds). Replaced with write-temp → `fsync` → `rename`. Loader now self-heals a damaged file instead of erroring every launch. 23/23 node tests still pass.
- [ ] `sandbox: true` — deferred pending isolated regression testing (unchanged)
- [ ] Wallet/Messages: ship with working backends, or explicitly gate as "coming soon" — **open decision**

### Testing infrastructure (built this session, reusable going forward)
- [x] Real two-process E2E test harness for chat/crypto (`scripts/test-two-users.js`) — pre-existing, now also validates the hybrid PQC path
- [x] Real two-process IPFS/Helia/gossipsub test harness (`scripts/test-ipfs-node.js`) — pre-existing
- [x] Real four-process multi-device/multi-user test harness (`scripts/device-worker.js` + `scripts/test-multi-device.js`) — **new this session**, covers cluster admission, feed gating, device linking, outsider rejection
- [ ] Re-run all three harnesses against a **packaged** build (not the dev tree) once `install.sh`/source-tarball distribution exists — packaging can silently drop dependencies the dev tree has

### Host system (this machine, the distribution origin)
- [x] Disk space crisis found and fixed (1.1GB → 9.8GB free) — 4 dead duplicate project folders + 2 redundant `bucks-mobile` copies removed (mockups archived first)
- [x] Kubo daemon confirmed running, peered (95 swarm peers), locally serving content correctly
- [ ] NAT/port-forward configuration for reliable external reachability — open, see Phase 1

---

## Open decisions blocking further work

These can't be resolved by more building — they need your input:

1. **bucks.global repo access** — PR from me, or hand you standalone files to paste in?
2. **Wallet / Messages UI** — fix the dead backends and ship, or gate as "coming soon" for the first public release?
3. **Compiled installers** — worth building later as a secondary path for users without Node/Python, or staying source-only permanently?
4. **Windows install-script prerequisites** — should `install.ps1` just check-and-guide for missing Node/Python, or attempt to auto-install via `winget`?
5. **`ipfs.io` gateway timeout** — worth chasing down (port-forward the Mac mini's Kubo swarm port) before the first public release, or acceptable to rely on `dweb.link` + a pinning-service fallback instead?

---

## Suggested next slice (highest leverage per phase)

If picking one item per phase to do next: **Phase 1** — extend `build-and-pin-release.js` for source-tarball; **Phase 2** — model-download progress + honest status card (small, high-trust-impact); **Phase 3** — first-run onboarding; **Phase 4** — keyboard access on CTA cards (mechanical, high impact); **Phase 5** — CSP in `index.html` (cheapest real security win before any public download).
