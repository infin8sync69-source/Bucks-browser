# PRODUCTION_READINESS.md — Bucks Browser

*Principal-engineer audit, 2026-07-06. Canonical app: `Bucks-browser/electron` (vanilla Electron).
Every claim is tagged **[Verified in code]**, **[Inferred]**, or **[Assumption — needs confirmation]**.
This document supersedes the narrative in `PRODUCTION-READINESS.md` (2026-07-02) and folds its
still-valid findings forward. Definitions are locked in [SPEC.md](SPEC.md).*

### Fixes applied in this pass (2026-07-06)
- **P0 #2 — `_safe_path` sibling-directory escape:** replaced the string-prefix guard with
  `is_relative_to` containment in `agent/tools/file_tools.py` and `agent/tools/registry.py`
  (unit-verified: `/x/bucks core-evil` no longer passes for root `/x/bucks core`).
- **Dormant swarm gated:** `agent-swarm.js` now only starts when `BUCKS_EXPERIMENTAL_SWARM=1`
  (`main.js`), so the unsigned/unaudited delegation path can't ship on by default.
- **Shell hardening:** removed `allowpopups` from the files `<webview>` (`index.html`); added a
  preventive `will-navigate` scheme allow-list on the shell frame (`main.js`).
- **Model supply chain:** `edge_llm.py` `_download` now verifies a pinned SHA-256 when present and
  logs `UNPINNED` when not — enforcement turns on as soon as digests are added to `_GGUF_CATALOGUE`.
- **Stale finding corrected:** the `wallet-reset` `process.cwd()` bug no longer exists — `bucks-node`
  is initialised with `userData/bucks-chain` (`main.js:1002`).
- **Not done (need your decision, unchanged):** chat direct-stream rewrite (P0 #1), auto-update infra
  (P0 #4), Messages UI (P0 #5), wallet backend/copy purge (P0 #6), CSP + `sandbox:true` (deferred —
  higher regression risk, wants dedicated testing).

---

## Phase 0 — Definition Lock (summary; full text in SPEC.md)

| Term | Locked definition (one line) | Source |
|---|---|---|
| Swarm intelligence | Load-aware gossipsub task delegation + majority-vote consensus; no CRDT/leader election; unsigned messages; **currently dormant** (targets absent `:3000`) | [Verified — `agent-swarm.js`] |
| Ephemeral UI | **Not ephemeral.** Everything persists except private windows. Product copy must be corrected. | [Verified — `main.js`, `chat-engine.js`] |
| Trust model | Open untrusted mesh (in-app Helia) **vs** private trusted cluster (external `ipfs/`). Two models, not one. | [Verified] |
| Threat model | Priority: malicious mesh peer > network observer (metadata leak) > forensic disk examiner. | [Verified + Decision] |

**Gate result:** all four defined → audit proceeds.

---

## Phase 1 — Architecture Audit

### Subsystem Risk Matrix

| Subsystem | Severity | Finding | Ref | Confidence |
|---|---|---|---|---|
| Electron shell | **Medium** | `sandbox` not enabled; `webviewTag:true` + `<webview allowpopups>`; no CSP; devtools auto-open unpackaged only | `main.js:132-137`, `index.html:1209` | Verified |
| Electron shell | **High** | No renderer CSP anywhere in `index.html`; renderer loads local file but hosts remote content via webview | grep: 0 CSP hits | Verified |
| IPC surface | **High** | `wallet-rpc`/`social-rpc` proxy to nonexistent `:8080`/`:8000`; `wallet-reset` writes wrong dir | `main.js:273,393,442` | Verified |
| IPFS (Helia) | **High** | No GC, no disk ceiling, no quota — unbounded local growth | grep: 0 gc/quota hits in `ipfs-node.js` | Verified |
| IPFS (Helia) | **Critical** | Ephemerality conflict: `ipfsUnpin` is local-only; replicated content cannot be recalled | `PRODUCTION-READINESS.md:128` + code | Verified |
| Llama agents | **Medium** | Agent file tools scoped to `BUCKS_ROOT` via `_safe_path`; **but default root is `~/Desktop/bucks core`** and symlink escape not blocked | `file_tools.py:12-20` | Verified |
| Llama agents | **High** | Prompt-injection surface: swarm/feed content reaches local LLM unsigned; no input sanitation | `agent-swarm.js`, `soul_engine.py` | Verified |
| P2P messaging | **High** | Chat envelope broadcasts `to`/`from` to whole topic → metadata leak (who-talks-to-whom) | `chat-engine.js:229` | Verified |
| P2P messaging | **Medium** | Offline delivery: message to offline peer **fails, not queued**; no store-and-forward | `chat-engine.js:189` | Verified |
| Swarm coordination | **High** | Unsigned messages: spoofable `nodeId`, forgeable results, ballot-stuffed consensus; no churn/partition handling beyond 30 s prune + no-retry | `agent-swarm.js:126-139` | Verified |
| Wallet backend | **Critical** | RPC targets absent `:8080` (Kubo-gateway collision); UI dead-ends. *(Note: the embedded `bucks-node.js` chain now exists and `wallet-reset` writes `userData/bucks-chain` correctly — the old `process.cwd()` bug is fixed. What's missing is the wallet/tx/mining HTTP API the RPC proxy expects.)* | `main.js:393,1002`, `bucks-node.js:703` | Verified |
| Social feed `:8000` | **High** | No service implements it; should rewire to local `ipfsFeed` | `main.js:442` | Verified |
| Auto-update | **High** | No `autoUpdater`/`electron-updater`; no signing; no rollback | grep: 0 hits | Verified |

**1. Electron shell.** `contextIsolation:true` and `nodeIntegration:false` on the one `BrowserWindow`
(`main.js:134-135`) — good baseline. **Gaps:** `sandbox` is not set (defaults are not relied-upon
safely given `webviewTag:true`); no Content-Security-Policy is emitted for the renderer; `<webview>`
carries `allowpopups` and points at `http://localhost:3939`. Navigation is guarded by a
`did-navigate` handler that `goBack()`s off-scheme URLs (`main.js:171-178`) — reactive, not
preventive (use `will-navigate`). **IPC classification:** *safe* — window controls, settings,
blocked-count. *Needs-validation* — `web-fetch`/`web-search` (SSRF vector to localhost), `ipfs-*`.
*Privilege-escalation risk* — `wallet-rpc`, `social-rpc` (proxy to arbitrary local ports with a
user-approval modal), `wallet-reset` (deletes `wallets.json` from `process.cwd()`, not `userData`).
**RAM budget [Inferred]:** Electron (~200 MB) + Helia/libp2p (~150 MB) + Ollama `hermes3:latest`
(~5–6 GB resident for an 8B model at Q4). Realistic minimum: **8 GB RAM, 16 GB recommended**;
without Ollama the embedded `node-llama-cpp` SLM path still needs ~2–3 GB. [Assumption — needs
confirmation via memory profiling on target hardware]

**2. IPFS / IPFS Cluster.** Given the Phase 0 open-mesh trust model, plain Helia + libp2p (in-app) is
the right primitive for the untrusted network; **IPFS Cluster is over-privileged there and should
remain confined to the opt-in private group.** Pinning: publish auto-pins locally; `ipfsUnpin`
removes only the local pin. **No GC, no disk ceiling** — after 6 months of feed caching and
publishing, `userData/ipfs-data` grows without bound. [Verified — no quota code]. **Ephemerality
conflict:** content-addressed blocks replicated to peers (via feed upvote/pin) are permanent; "delete"
can only mean "unpin locally + stop advertising." The UI must say: *"Removing this deletes your copy.
Copies other people pinned stay on their machines."* **Bootstrap/swarm.key:** default cluster secret is
shared globally; `BUCKS_BOOTSTRAP_PEERS` is operator-supplied; no one currently operates public
bootstrap infrastructure. [Verified + Operational gap]

**3. Local Llama agents.** Runtime is **Ollama** (`hermes3:latest`, Metal on macOS) with an embedded
`node-llama-cpp` fallback when Ollama is absent (`soul-engine-supervisor.js:167-182`,
`soul_engine.py:68-69`). Cold start = model pull on first run (multi-GB). **Model distribution:**
weights are **not bundled** — pulled from Ollama's registry at runtime, sidestepping redistribution
license concerns; the embedded fallback "first run downloads weights"
(`soul-engine-supervisor.js:182`). Verify Hermes-3/Llama-3 community license compatibility with the
project's MIT license before advertising bundled models. [Verified — not bundled; license check
outstanding]. **Agent sandboxing:** tools can read/write files (scoped to `BUCKS_ROOT` via
`_safe_path`, `file_tools.py:12-20`), run shell (`shell_tools.py`), fetch URLs, and hit IPFS
(`ipfs_tools.py`). `_safe_path` blocks `..` traversal via `resolve()` + prefix check but **does not
resolve symlinks inside the root** and the default root string `~/Desktop/bucks core` is
case/space-fragile. State-changing browser tools require explicit Approve/Deny
(`STATE_CHANGING_TOOLS`, `soul_engine.py:553`). **Prompt-injection:** agents consuming untrusted P2P
content is a direct injection vector with **no mitigation** — swarm task prompts and feed text flow
into the LLM unfiltered. Mitigation required: treat all peer-originated text as untrusted, isolate it
from the tool-authorizing system prompt, and keep the human-approval gate on every state-changing tool.

**4. P2P messaging (Signal).** Since the 2026-07-03 hardening pass: Ed25519 signed pre-key bundles
(replacing the unverifiable HMAC), bundle verification + TOFU key pinning, signing-key-swap rejection
(`chat-engine.js:52-58`), and encrypt-at-rest via `safeStorage` (`signal-store.js:157-196`).
**Remaining gaps:** (a) metadata leak — envelopes broadcast `to`/`from` over gossipsub
(`chat-engine.js:229`); (b) no forward-secrecy audit of the Double-Ratchet implementation
[Assumption — needs confirmation]; (c) offline delivery **fails** rather than queuing
(`chat-engine.js:189`) — must surface in UX; (d) key rotation / device-loss recovery has **no UI**.

**5. Swarm coordination.** Convergence under churn: none — no retry, no re-delegation, 30 s dead-peer
prune. Under partition: each side operates independently; no reconciliation. A single malicious peer
can forge results and votes (unsigned messages). **Consistency model: none / best-effort.** [Verified]

---

## Phase 2 — End-to-End User Journey Audit

*Walked as a first-time non-technical user. "Actual state" reflects the current code.*

| # | Journey | Expected | Actual | UX break (severity) |
|---|---|---|---|---|
| 1 | First run / onboarding | Guided identity + optional model download with progress | App boots to newtab; Signal identity auto-generated silently; **no onboarding, no model-download progress UI, no disk-space precheck** | **P1** — silent multi-GB Ollama pull on first agent use; no pause/resume |
| 2 | Peer discovery & connect | Scan QR / paste invite | mDNS auto-connects on LAN; cross-network needs env var `BUCKS_BOOTSTRAP_PEERS`; **no in-UI add-peer, no QR** | **P1** — non-technical user cannot connect across networks |
| 3 | Sending a message | Compose → states (sending/delivered/failed) | Engine sends; **no renderer Messages UI exists**; offline peer → hard failure | **P0** — feature unreachable from UI |
| 4 | Agent interaction | Invoke, stream, cancel, recover from crash | NEXUS panel streams SSE with Approve/Deny gates; cancel wired | **P2** — OOM/model-crash recovery unproven [Assumption] |
| 5 | Ephemerality in practice | What user thinks vanished vs. persisted | History/bookmarks/chat/feed all persist; unpin ≠ network delete | **P0** — trust-breaking if any copy implies ephemerality |
| 6 | Offline / degraded | Clear degraded-mode UX | Services fail as silent console warnings; no offline banner | **P1** — no failure-state UI |
| 7 | Update path | Signed auto-update, data migration | **No auto-update mechanism at all** | **P0** — no patch delivery for security fixes |
| 8 | Uninstall / exit | Told what remains on disk & peers | Standard uninstall leaves `userData` + peer replicas; **user not told** | **P1** — honesty gap |
| 9 | **Identity/contact recovery (new device)** | Restore identity + contacts; peers see me return | **No journey exists.** TOFU + safeStorage-bound keys → lost device forces every contact to re-verify; the signing-key-swap rejection (`chat-engine.js:52-58`) makes legitimate return look like a MITM attack to the other side | **P1** — anti-MITM protection actively blocks legitimate recovery; no UX for either side |

**Severity-ranked UX breaks → technical gap:**
1. **[P0]** Messaging has no UI → renderer Messages panel missing (Phase 1 §4).
2. **[P0]** Ephemerality mismatch → product copy + unpin semantics (Phase 0 §2, Phase 1 §2).
3. **[P0]** No auto-update → can't ship security fixes (Phase 1 auto-update row).
4. **[P1]** Identity/contact recovery collides with anti-MITM key-swap rejection → recovery design (journey #9).
5. **[P1]** No onboarding/model-download UX → first-run wizard missing.
6. **[P1]** Cross-network peering is env-var-only → no add-peer/QR UI.
7. **[P1]** Failures are silent → no degraded-mode UI.

---

## Phase 3 — Gap Closure Plan (prioritized backlog)

**Scoring note (revised after review):** P0 items are ranked, not an unordered set. Findings are
scored with the prompt-injection surface as a **multiplier**, not in isolation — a low-severity file
guard becomes high when an untrusted-mesh-driven agent can reach it. Release scope covers only the
**live** app (Electron shell + Soul Engine `:8765` + Helia/chat/feed). The **swarm delegation path is
dormant** (targets `:3000`, which the app never starts) and is therefore **removed from the release
path entirely** — see the "Dormant / experimental" bucket below. It is not a P0 blocker; it is a
gate: it must stay off until it is woken up and audited live.

### P0 — blockers, ranked (security holes, data-loss, dishonest claims)
| Rank | Item | Why this rank | Fix | Est | Arch decision? |
|---|---|---|---|---|---|
| **1** | **Chat metadata leak** — envelopes broadcast `to`/`from` PeerIDs to the whole gossip topic (`chat-engine.js:229`) | This is the finding that makes the E2E encryption theater: content is Signal-grade while the *social graph* is public to every stranger on the default mesh. A passive mesh node can publish "who talks to whom" — that becomes the launch story. | Replace topic-broadcast with libp2p **direct streams** to the recipient PeerID; stop putting routing metadata on a shared topic | M | **YES** — direct-stream vs. sealed-sender |
| **2** | **Injection × out-of-root read** (compound) — untrusted mesh text prompt-injects the agent (Phase 1 §3), and `_safe_path`'s guard is a raw string prefix (`file_tools.py:18`): root `.../bucks core` also matches sibling `.../bucks core-evil/...` | On the **live** engine only `read_file`/`list_directory` are exposed, so this is an **exfiltration read** primitive, not arbitrary write (verified: no `write_file`/shell in `EXPOSED_TOOLS`, `soul_engine.py:906`). Still high: injection turns a read guard into a data-exfil path. | Fix `_safe_path` to compare against `BUCKS_ROOT` via `Path.parents` / `os.path.commonpath` (not `startswith`); treat all peer text as untrusted and isolate it from the tool-authorizing prompt | S (guard) / M (injection isolation) | No |
| **3** | **Dishonest ephemerality** — UI implies vanishing; everything persists; `ipfsUnpin` is local-only | Trust-breaking; you already applied this standard, apply it fully | Correct all UI copy to SPEC.md §2; make unpin explain network permanence | S | No |
| **4** | **No auto-update** — cannot ship the fixes above | A security fix you can't deliver isn't a fix | Wire `electron-updater`: signed feed, staged rollout, rollback | M | **YES** — feed hosting/operator |
| **5** | **No messaging UI** — feature unreachable | Blocks the product's core pitch; also blocks validating fix #1 end-to-end | Build renderer Messages panel on existing `chat*` IPC | M | No |
| **6** | **Wallet dead-ends + dishonest surface** — no `:8080` backend; UI (and any README/screenshot/marketing showing a wallet) advertises non-existent functionality; `:8080` also collides with Kubo gateway | Same dishonesty class as ephemerality — hiding the UI while the *claim* persists is not enough | Flag-hide the UI **and** purge wallet from all outward-facing copy in the same change | S | **YES** — drop vs. integrate vs. build (post-1.0) |
| **7** | **Unsigned feed/dweb/version gossip** (live topics only) | A hostile peer poisons the feed/dweb index or spoofs "newer version" | Sign these payloads with the libp2p peer key; verify on receipt | M | **YES — see note** |

> **Signing is necessary but not sufficient (correction from review).** Signing with the libp2p peer
> key only proves "*some* peer key produced this." On an open mesh a Sybil attacker mints N valid keys
> for free and stuffs any vote/index legitimately. Peer-key signatures stop spoofing of a *known*
> nodeId; they do nothing against forged-but-valid new identities. So for anything trust-weighted
> (consensus, "authoritative" feed ranking) signing must be paired with **capability allow-lists
> (worldSoulHash-gated) or a stake/reputation notion — or the feature is labeled advisory-only.**
> This is an architectural decision, not a code fix.

### P1 — broken journeys, missing failure UI, key recovery, supply chain
| Item | Fix | Est |
|---|---|---|
| **Identity/contact recovery journey** (new device) — no journey exists; TOFU + safeStorage-bound keys mean a lost device forces every contact to re-verify, and the signing-key-swap rejection (`chat-engine.js:52-58`) makes legitimate return **look like an active MITM** | Design the recovery flow **and** what the *other* peer sees when you return on a new key (explicit re-verify UX that distinguishes recovery from attack) | L | 
| **Model supply chain** — weights fetched TOFU with no in-repo pinned digest (`edge_llm.py:31-37,140`, Ollama registry). Transport/tooling content-verify (TLS + HF blob hash / Ollama digest), but Bucks trusts the upstream repo owner and pins nothing | Pin expected SHA-256 per catalogue entry; verify after download; document the trust boundary | S | 
| First-run wizard (identity, model download w/ progress/pause, disk-space precheck) | New onboarding flow | L |
| Add-peer UI (show own multiaddr/PeerID + QR; paste/scan invite) | Settings/IPFS panel | M |
| Degraded-mode UI (offline banners, actionable service-down errors) | Renderer surfacing | M |
| Offline message handling (queue or honestly report "not delivered", `chat-engine.js:189`) | Engine + UI states | M |
| Key rotation UI | Signal store + UI | M |
| CSP + `sandbox:true` + `will-navigate` guard + drop `allowpopups` | Shell hardening | M |
| Rewire social feed to local `ipfsFeed` (kill `:8000`) | Renderer + IPC | S |
| Model license compatibility table (Hermes-3/Llama community terms vs. MIT) | Docs + confirm | S |

### P2 — performance, disk growth, polish
| Item | Fix | Est |
|---|---|---|
| Helia disk ceiling + GC + quota UI | Blockstore GC policy | M |
| Persist feed/pin metadata on write (not just clean shutdown) | `ipfs-node.js` | S |
| `:3939` EADDRINUSE probe-before-spawn | `main.js` spawn guard | S |
| Unify in-app Helia vs external Kubo/cluster (detect + delegate) | Integration | L |
| CI: main-process unit/smoke tests (signal round-trip, `_safe_path` sibling-escape regression) | Test harness | M |

### Dormant / experimental — OFF in 1.0, not on the release path
*The swarm delegation path (`agent-swarm.js`) targets an agent server on `:3000` the app never
starts. Its findings are real but unverifiable at runtime, so they must not imply release coverage.*
| Item | Disposition |
|---|---|
| Gate the entire swarm layer behind an explicit `BUCKS_EXPERIMENTAL_SWARM` flag, default off | **Required before 1.0** — prevents a future contributor "turning it on" with these holes intact |
| Unsigned swarm task/result/consensus messages; spoofable `nodeId`; ballot-stuffable consensus (quorum 2) | Fix **only if/when** the swarm is woken and audited live; otherwise it stays disabled |
| No retry / re-delegation on peer drop; 30 s prune; no partition reconciliation | Same — audit live or leave off |
| Swarm consensus is Sybil-vulnerable by design (see signing note) | If ever enabled, label **advisory-only** or add capability/stake gating |

**Items requiring an architectural decision (options, not silent choices):**
- **Chat privacy (P0 #1):** direct libp2p streams (simplest; still reveals *that* two peers connect to
  an on-path observer) vs. sealed-sender / mixnet (hides the graph; heavy). **Recommendation: direct
  streams for 1.0, sealed-sender tracked for later.**
- **Trust-weighted gossip (P0 #7):** peer-key signing alone (Sybil-open) vs. worldSoulHash capability
  allow-list vs. stake/reputation vs. advisory-only labeling. **Recommendation: sign + label
  feed/version as advisory for 1.0; no trust-weighting until a Sybil answer exists.**
- **Wallet (P0 #6):** (a) drop, (b) integrate an existing chain (EVM light client), (c) build a Bucks
  node. **Recommendation: (a) flag-hide + purge copy now; decide (b/c) post-1.0.**
- **Update infra (P0 #4):** who hosts and signs the feed (see Operational Reality).
- **Swarm identity:** if woken, how is a vote made trustworthy on an open mesh (capability vs. stake)?

---

## Phase 4 — Production & Open-Source Release Checklist

- **Packaging:** electron-builder configured for mac (dmg/zip) + win (nsis/portable); **Linux target
  missing**; **no code-signing, no macOS notarization, no Windows EV cert**; reproducible builds not
  set up; **no SBOM**. [Verified — `package.json` build block]
- **Auto-update:** none. Add signed `electron-updater` feed, staged rollout, rollback. [Verified absent]
- **CI/CD:** no cross-platform matrix, no e2e tests for Phase 2 journeys, no fuzzing on IPC or the P2P
  message parsers (`_onSwarmMessage`, chat envelope decode are the priority fuzz targets). [Verified absent]
- **Model supply chain:** weights fetched TOFU with no in-repo pinned digest — `hf_hub_download` from
  hardcoded HF repos (`edge_llm.py:31-37,140`) and Ollama registry pulls. Underlying tooling
  content-verifies (TLS + HF blob hash / Ollama digest addressing), but Bucks pins nothing and trusts
  the upstream repo owner. **Add per-entry SHA-256 pinning + post-download verification.** Note this is
  distinct from the threat-model's out-of-scope "malicious weights *adversary*": unverified *download*
  is an in-scope checklist gap. [Verified — no digest pinning in repo]
- **Chat security core:** the **Double-Ratchet forward-secrecy correctness must be moved from
  [Assumption] to [Verified] before 1.0** via test vectors or external cryptographic review. A silently
  broken ratchet voids the entire chat security story — this cannot ship as a footnote. [Gate]
- **Privacy & telemetry:** no telemetry present (good — default-off by absence); document this and keep
  it consistent with the corrected ephemerality promise. [Verified]
- **Licensing:** project is MIT (`LICENSE`, © `infin8sync69-source`). Produce a compatibility table for
  Electron (MIT), libp2p/Helia (Apache-2.0/MIT), `node-llama-cpp` (MIT), and **model weights**
  (Hermes-3/Llama community license — the one real risk; not MIT). [Verified — table outstanding]
- **Docs:** README present; **missing** `ARCHITECTURE.md`, `SECURITY.md` (with a disclosure policy),
  a threat-model doc (now seeded by SPEC.md §4), a contributor guide, and a governance model. [Verified]
- **Operational reality:** the "decentralized" claim fails its true test today — a single default
  cluster secret and no operated bootstrap/relay nodes mean cross-network discovery depends on
  users hand-configuring `BUCKS_BOOTSTRAP_PEERS`. If the maintainer disappears: LAN peers still find
  each other (mDNS), Ollama/Helia keep running locally, but there is no update channel, no bootstrap
  infra, and no wallet/social backend — the app degrades to a local-first browser + LAN mesh. State
  who runs bootstrap/relay nodes and what it costs (est. one small VPS per region, ~$5–20/mo each)
  before claiming a global decentralized network. [Inferred + Operational gap]

---

## Consolidated Confidence Ledger
- **[Verified in code]:** all Phase 1 subsystem findings, IPC surface, absence of CSP/sandbox/
  auto-update/GC, Ed25519 + safeStorage hardening, chat offline failure, swarm dormancy, wallet/social
  backends missing, MIT license, build config. **Live Soul Engine (`:8765`) exposes only read-mostly
  tools — `read_file`/`list_directory`, no `write_file`/shell** (`soul_engine.py:375-473,906`), so the
  injection compound risk is read-exfiltration on the live path, not arbitrary write. `_safe_path` uses
  a **string-prefix** guard (`file_tools.py:18`) with a sibling-directory escape; the write-capable
  `write_file`/shell tools exist only on the **dormant `:3000`** registry (`registry.py`,
  `shell_tools.py`). No in-repo model-digest pinning (`edge_llm.py`).
- **[Inferred]:** RAM budget composition, maintainer-disappearance degradation path, bootstrap cost.
- **[Assumption — needs confirmation]:** exact resident RAM on target hardware, agent OOM/model-crash
  recovery behavior, Hermes-3/Llama license terms.
- **[Gate — must become Verified before 1.0]:** Double-Ratchet forward-secrecy correctness (test
  vectors or external review); post-download model-weight digest verification once pinning is added.
