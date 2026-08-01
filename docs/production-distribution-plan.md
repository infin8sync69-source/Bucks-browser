# Production Distribution Plan: bucks.global → installed app

**Status:** Proposal / brainstorm — nothing in this document has been deployed. bucks.global is external, live, git+Vercel-connected infrastructure this session has no access to; every step that touches it needs your explicit go-ahead before anything is pushed.

**Goal:** a person visits bucks.global, runs a handful of terminal commands, and ends up with a running, production-quality Bucks Browser on macOS, Windows, or Linux — able to reach the same P2P swarm, cluster, and (per the work just finished) link as a second device to an already-running install.

---

## 1. The shape of the system (revised — IPFS-native, not GitHub Releases)

**This supersedes the first draft of this section.** The actual model: the Mac mini (this machine) is the origin seed on your own Bucks IPFS swarm — and critically, `scripts/build-and-pin-release.js` + `cluster-updater.js` **already implement almost this exact pattern** for *updates*. The gap is only: (a) it currently pins compiled platform artifacts, not a runnable source tree, and (b) it has no answer for the very first install, since that mechanism only reaches nodes that are *already running* and subscribed to the gossip topic.

| Piece | What it is | Where it lives |
|---|---|---|
| Landing page + Download CTA | Static HTML, one button | **bucks.global** (Vercel) — thin, just points at a CID |
| Source distribution artifact | A tarball of the repo (`bucks browser/`, `agent/`, `ipfs/`, `scripts/`, root `package.json`, `README.md`) *minus* `node_modules`/`.venv`/`__pycache__`/model weights, plus one bundled `install.sh` | **IPFS**, pinned by the Mac mini's Kubo daemon (already running and already peered — confirmed working in this session's IPFS test report) |
| Origin pointer (CID changes every release) | A small mutable pointer bucks.global reads | Either an **IPNS name** the Mac mini republishes, or (simpler to start) **hardcoded into the bucks.global page HTML and redeployed per release** — see §3 |
| Update propagation to every installed node | "Master updates → every node pulls + reinstalls" | **`cluster-updater.js`**, extended with one new artifact kind (`source-tarball`) — see §3 |

Why this is *better* than the GitHub-Releases plan I first sketched: it reuses infrastructure you've already built and tested (signed manifests, self-seeding, gossip-announced updates) instead of introducing a parallel binary-hosting system, and — because it distributes source rather than a signed `.app`, run via `bash install.sh` + `npm start` rather than double-clicking a Gatekeeper-gated bundle — **it sidesteps the macOS notarization blocker from my original §3 almost entirely.** Terminal-launched Node processes aren't subject to the same "Apple could not verify this app" hard block that gates double-clicking a downloaded `.app`. (Caveat below in §4 — worth verifying on your actual MacBook Air, not just asserting.)

## 2. Install flow (matches what you described)

1. User visits bucks.global, clicks **Download**.
2. Browser fetches from a public IPFS gateway URL pointing at the pinned tarball CID — served by the Mac mini's Kubo node (and, over time, by every other installed node too, see §3). Something like:
   `https://<gateway>/ipfs/<CID>?filename=bucks-browser-src.tar.gz&download=true`
3. User unpacks it, moves the folder to `~/Desktop` (or anywhere).
4. Opens Terminal, runs the bundled installer — the "few bash commands" goal:
   ```bash
   cd ~/Desktop/bucks-browser
   ./install.sh
   ```
   `install.sh` collapses today's multi-step README (`npm install` at root, `npm install` in `electron/`, agent venv setup via `start_soul_engine.sh`) into one script, then launches the app. This is genuinely close to a 2-command install already — the main work is *writing that script*, not inventing new plumbing.
5. First launch: Soul identity (UUID/peerID) generates automatically, same onboarding flow already tested this session.
6. User links this new node to an existing install via UUID/peerID — this is `device-sync.js`'s `initiateLinkDevice`, already verified working. (Still IPC-only — see the open item in §7 of the original plan below.)
7. **The new node becomes a source too.** Once running, it pins the same distribution CID through its own IPFS layer — exactly the "downloading self-pins, so that node becomes a source for the next downloader" pattern `cluster-updater.js`'s `applyPendingUpdate()` already implements for update artifacts. Extending it to also self-pin the *original install* tarball (not just updates) is a small, natural addition.

## 3. Update propagation: "every node should get the master's latest source"

This is precisely what `cluster-updater.js` + `scripts/build-and-pin-release.js` do today, verified working. The one real gap: `build-and-pin-release.js` currently runs `npm run dist` and pins *compiled* artifacts (`.dmg`/`.exe`/`.AppImage`), keyed by `platform`/`arch` in the manifest. For source-based distribution, it needs a new artifact `kind: "source-tarball"` (platform-independent — no `npm run dist` step, just `tar` the repo minus build/venv/model directories) and `cluster-updater.js`'s `applyPendingUpdate()` needs a branch for that kind: instead of `shell.openPath()` (which assumes a double-clickable installer), extract the tarball over the existing install directory and re-run `install.sh`, then prompt to restart. Everything else — signing with the maintainer's Ed25519 key, gossip-announcing the manifest CID on `RELEASE_TOPIC`, every node verifying the signature and comparing versions, self-seeding after download — is unchanged, already built, already tested.

**The one piece with no existing answer is the bucks.global pointer problem**: IPFS CIDs are content-addressed, so they change every release, but bucks.global's Download button needs a stable URL. Two options:
- **Simplest to start**: hardcode the current release CID into the bucks.global page and redeploy (git push) each time you cut a release. You already have git+Vercel wired up — this is a one-line diff and a push, no new infrastructure.
- **Nicer long-term**: the Mac mini's Kubo node runs `ipfs name publish <CID>` on each release (IPNS — a mutable pointer over a fixed key), and bucks.global links to the stable `/ipns/<key>` path instead of a raw CID. Slightly more moving parts (IPNS records need periodic republishing, which the daemon handles automatically while it's running, but that's one more thing depending on the Mac mini staying up).

I'd start with the hardcoded-CID approach — it's simpler, and you already have the redeploy workflow — and revisit IPNS if manual redeploys become a real friction point.

## 4. Reachability — the thing to actually test, not assume

For a stranger's browser to fetch the tarball from the Mac mini via IPFS, the Mac mini's Kubo node has to be dialable from the public internet — a DHT-only home connection behind NAT with no port-forward will not reliably serve a first-time visitor with no other peers already caching the content. Before this goes live, actually test it: from a machine on a **different network** (not on your LAN — e.g. a phone on cellular data, or a cloud VM), try fetching the CID from a public gateway (`https://ipfs.io/ipfs/<CID>`, `https://dweb.link/ipfs/<CID>`) and confirm it resolves and downloads. If it doesn't, the fix is a port-forward on the Mac mini's router for Kubo's swarm port (default 4001), or pinning the same content through a public pinning service (web3.storage, Pinata, etc.) as a bootstrap/fallback so the first few downloads don't depend solely on the Mac mini being reachable.

I'd genuinely treat this as the riskiest untested assumption in the whole plan — worth verifying before it's the thing bucks.global's Download button depends on.

## 5. Production-readiness cleanup — what actually blocks a public download

`docs/PRODUCTION_READINESS.md` (2026-07-06 audit) already has a prioritized list; re-reading it against "we're about to hand this to strangers on the internet," the items that change severity are:

| Item | Audit severity | Why it matters more now |
|---|---|---|
| No CSP in `index.html` | High | A public download is a public attack surface; this is the cheapest, highest-leverage fix left undone |
| Wallet RPC dead-ends (`:8080`/`:8000` targets don't exist) | Critical | A first-time user clicking "Wallet" hits a dead API. Either wire it up or hide the entry point before shipping — a broken feature in a first impression is worse than a missing one |
| No auto-update infra (P0 #4) | High | **Already solved** — `cluster-updater.js` exists and works (verified this session). This line item in the audit predates it; the doc just needs updating, not new code |
| Messages UI (P0 #5) | High | Same question as wallet: ship it, or gate it behind a "coming soon" so a stranger's first click isn't a dead end |
| `sandbox: true` not enabled | Medium, deferred in the audit for regression risk | Worth revisiting now specifically *because* this is about to be a public download, not just internal testing — but test it in isolation first, don't bundle it into the release-pipeline work |
| Model download digests unpinned (`_GGUF_CATALOGUE`) | Noted, enforcement pending | A production installer downloading unpinned model weights on first run is a supply-chain gap worth closing before wide distribution |

I'd propose treating this as its own short pass — a handful of targeted fixes, not a rewrite — done *before* cutting the first public-facing release tag, separately from the packaging/CI work above (they don't block each other and can happen in parallel).

## 6. What actually needs to be built (replaces the old "build pipeline" plan)

Since distribution is source + `install.sh`, not compiled/signed installers, the build-out is smaller and more concentrated than a traditional release pipeline:

- **`install.sh`** (new, bundled in the tarball) — collapses the current multi-step `README.md` (root `npm install`, `electron/npm install`, `agent/start_soul_engine.sh` for the Python venv + first model pull) into one script. Should be idempotent (safe to re-run), print clear progress, and end by launching the app.
- **`install.ps1`** (new) — same for Windows. Windows-specific friction to design around: PowerShell's default execution policy blocks running downloaded scripts (`Set-ExecutionPolicy` or `-ExecutionPolicy Bypass` on invocation), and Node/Python aren't preinstalled the way Xcode Command Line Tools often pre-seed some of this on macOS — the script needs to either detect-and-guide ("install Node from nodejs.org first") or, more ambitiously, bootstrap via `winget install` if present. Worth scoping as its own small design pass rather than assuming parity with the mac script.
- **`scripts/build-and-pin-release.js`**: add a `source-tarball` artifact kind — `tar` the repo excluding `node_modules/`, `.venv/`, `__pycache__/`, `dist/`, model weight caches, and any `.env*` files (mirroring the exclusion list `electron-builder`'s `extraResources.filter` already uses for the agent dir — reuse that list rather than re-deriving it), add to IPFS via the existing bridge, sign and announce exactly as it does today for compiled artifacts. Platform/arch fields become irrelevant for this kind (source runs anywhere with Node+Python) — the manifest schema should mark it `platform: "any"`.
- **`cluster-updater.js`**: `applyPendingUpdate()` needs a branch for `kind === "source-tarball"` — extract over the existing install directory (or a fresh sibling directory + swap), re-run `install.sh`, prompt for restart, instead of the current `shell.openPath()` (which assumes a double-clickable platform installer).
- **Self-seeding on first install**: `install.sh`'s last step (once the app is running) should pin the same distribution CID through the new node's own IPFS layer — reuses `ipfs-bridge.js`'s existing pin API, same call shape as `cluster-updater.js`'s self-seed-after-download step.

Compiled, signed installers (the original electron-builder/GitHub-Releases plan) aren't gone forever — they're just not the v1 path. Worth revisiting as a *secondary*, more polished option once source-distribution is proven out, for users who'd rather not have Node/Python on their machine at all.

## 7. The setup document (deliverable)

`docs/INSTALL.md` — audience: a non-developer end user, distinct from the existing dev-oriented `README.md`.
- The few-command install flow: download → unpack → `cd` → `./install.sh` (or `install.ps1`).
- Prerequisites the script can't install for you (Node ≥18, Python 3.11/3.12) and how to get them quickly per OS.
- What it downloads and where: the app itself, model weights on first run (`~/.bucks/models/`).
- How to link a second device (the `device-sync.js` flow — see the open UI gap in §9).
- How to join/request a cluster.
- Uninstall instructions (just delete the folder + `~/.bucks` — worth confirming that's actually true and complete, i.e. no stray launchd/registry entries left behind).
- Troubleshooting: what to do if the IPFS download stalls or fails (fallback gateway URLs, or a direct `ipfs get <CID>` command for anyone with Kubo already installed), firewall prompts for P2P ports, minimum RAM/disk.
- Explicitly NOT the source-build/contributor instructions — those stay in `README.md`.

## 8. Pre-deploy test plan

Reuses the real multi-process testing methodology already built and validated this session (actual OS processes running the real, unmodified production modules over real libp2p/Helia — see the hybrid-PQC and multi-device test runs):

1. **Fresh-install user flow** — the literal thing this plan is for, run by hand: take the actual tarball `install.sh` would produce, unpack it in a clean user account with *none* of the dev toolchain pre-set-up (no existing `node_modules`, no pre-created Python venv), run only `./install.sh`, confirm it gets to a running app with no manual intervention beyond having Node/Python installed.
2. **UUID/Soul identity onboarding** — verify a completely fresh `~/.bucks/agent` produces a valid soul (Ed25519 identity, address, first advertisement) with no leftover state from dev machines — extends `scripts/test-two-users.js`'s pattern to a true first-run.
3. Confirm the hybrid-PQC identity/session work from earlier in this session survives a real first-run bootstrap, not just the test harness.
4. **P2P connection** — already covered by `scripts/test-ipfs-node.js` and `scripts/test-multi-device.js` (cluster admission, feed gating, device linking) — since this is a source install (not a repackaged bundle), the main new risk is `install.sh` itself, not dependency-stripping — rerun these tests straight after a fresh `install.sh` run, not just in the dev tree.
5. **Messaging flows** — the existing chat E2E test (`scripts/test-two-users.js`), same fresh-install context.
6. **Agent/model download list in chat inference** — `edge_llm.py`'s `_GGUF_CATALOGUE` drives the "available models" list; test that it renders correctly on a fresh install, that selecting an unfetched model actually downloads and checksum-verifies it, and that RAM-tiered auto-select picks something sane on real low-end hardware — exactly what the MacBook Air test below covers.
7. **The IPFS reachability test from §4** — do this early, it's the riskiest assumption and gates whether the whole distribution model works for a stranger at all.

## 9. Your second device: MacBook Air (2017)

A genuinely useful real-world test, not just a demo — it exercises the actual flow end to end. Concrete things to check, not assume:

- **Architecture**: Intel (x86_64), not Apple Silicon — matters far less under source distribution than it would for a compiled binary (Node/Python for x64 macOS just need to be installed normally), but worth confirming `install.sh` doesn't hardcode any arch-specific download URL (e.g. if it ever needs to fetch a prebuilt native module).
- **RAM**: 8GB, right at the README's stated minimum — the best real test of the RAM-tiered edge-model auto-select logic (flagged in memory as already disk-aware; worth confirming it's conservative enough at exactly 8GB and doesn't try to grab something that OOMs).
- **The device-link flow** — download, install, then link to "the system we currently work with" via `device-sync.js`'s `initiateLinkDevice`, verified working this session. **The one real gap**: it's currently IPC-only, no UI to trigger it. For you personally testing, that's fine (call it via devtools/IPC directly); for `INSTALL.md` to tell a stranger how to do this, it needs an actual pairing screen — natural fit is extending the existing `bucks-qr.html` X3DH pairing UI to also trigger `deviceLinkInitiate` once both sides know each other's soulId.

## 10. Proposed phased rollout

1. **Verify IPFS reachability from outside your network** (§4) — do this first; it determines whether the whole model is viable before investing in anything else.
2. **Production cleanup pass** (§5) — CSP, wallet/messages dead-end decision, pinned model digests.
3. **Write `install.sh`/`install.ps1`** and the `build-and-pin-release.js`/`cluster-updater.js` extensions (§6).
4. **Full pre-deploy test pass** (§8) — including the MacBook Air.
5. **Minimal device-pairing UI** (§9's gap) if you want a stranger (not just you) to be able to link a second device without touching devtools.
6. **bucks.global integration** — landing page + Download CTA + the CID pointer (§3). Needs the repo handed over or changes prepared for you to paste in — see open decisions below. Explicit confirmation required before anything is pushed to that live site.
7. **First real release** — run `build-and-pin-release.js`, confirm the manifest gossip-announces correctly, update bucks.global's pointer, go live.

## 11. Open decisions I can't make for you

- **bucks.global access** — I couldn't find a local copy of that repo on this machine (checked common paths under `~/Desktop` and elsewhere) — is it available for a PR, or do you want the landing-page/CTA changes hand off as standalone files for you to paste in?
- **Wallet/Messages UI** — ship them as-is (with dead-end backends fixed or hidden), or mark "coming soon" for the first public release?
- **Compiled installers as a secondary path** — worth building later for users without Node/Python, or is source-only the permanent model?
- **Windows prerequisite handling** — should `install.ps1` just check-and-guide for Node/Python, or actually attempt to install them (`winget`) when missing?
