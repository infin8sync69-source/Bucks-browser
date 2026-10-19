# SPEC.md — Definition Lock (Phase 0)

*Audit date: 2026-07-06. Definitions recovered from code where possible; each paragraph is
confidence-tagged. These four definitions gate the rest of the production-readiness audit.*

---

## 1. "Swarm Intelligence"

**What it actually is:** load-aware task delegation plus best-effort majority voting between
Bucks browser instances over IPFS gossipsub. Each node advertises a capability record every 8 s
(`bucks-swarm-caps-<cluster>` topic: model, tools, load, soul hash — `agent-swarm.js:92-122`).
A delegating node picks the peer with the lowest load that has the required capability, with a
+10 score bonus for a matching `worldSoulHash`, and publishes the task on a shared topic
(`agent-swarm.js:172-215`). There is **no** stigmergy, PSO, leader election, or CRDT
convergence. "Consensus" (`swarmConsensus`, `agent-swarm.js:280-357`) is a broadcast question
answered by each peer's local LLM, tallied by simple majority with a default quorum of 2 and a
15 s timeout. **Failure mode when peers drop:** a peer is declared dead after 30 s of silence
and pruned; a delegated task that gets no reply rejects after a 20 s timeout with **no retry and
no re-delegation** — the caller must handle the error. If no suitable peer exists, execution
falls back to the local agent server. All swarm messages are **unsigned JSON**; any subscribed
peer can spoof `nodeId`, forge capability records, forge task results for observed `taskId`s,
and stuff consensus votes. [Verified in code: `electron/agent-swarm.js`]

**Practical status:** the swarm layer calls an agent server on `:3000`
(`AGENT_SERVER_URL`, `agent-swarm.js:19`), but the live app runs only the Soul Engine on
`:8765`; `:3000` (server_lite.py / server.py) is not started by the app. Swarm delegation is
therefore **wired but dormant** — capability refresh fails (`model=undefined`) and delegated
tasks error out. [Verified in code + prior smoke test 2026-07-02]

## 2. "Ephemeral UI"

**Decision (recovered from code): the UI is NOT ephemeral, and the product must stop implying
it is.** What the code actually does: bookmarks, history, settings, downloads metadata, feed
posts, dweb index, agent chat threads (SQLite), and E2E chat history
(`userData/ipfs-data/chat-history/`, rolling 500-message window per peer) are **all persisted to
disk** and survive restart. The only ephemeral surface is a **private window**: in-memory
webview partition, no history written, discarded on close (`main.js:148-150`,
renderer `#private` mode). [Verified in code]

**Retention guarantee to the user, in plain words:** "Everything you do in a normal window is
saved on this computer until you delete it. A private window saves nothing after you close it.
Messages are stored encrypted on your device and on the recipient's device. Files you publish
are copied to other computers and cannot be recalled." Any UI copy promising more ephemerality
than this is dishonest and must be removed. [Decision — locked for this audit]

## 3. Trust model

**Two different trust models coexist and must not be conflated.** (a) The **in-app Helia/libp2p
mesh** is an **open network of untrusted strangers**: the default `clusterSecret`
(`BUCKS_DEFAULT_CLUSTER`) is shared by every default install, so anyone running Bucks is on the
same gossip mesh; the secret only derives topic names — it authenticates nothing. Chat peers are
authenticated via Ed25519-signed pre-key bundles with trust-on-first-use (TOFU) key pinning
(`signal-store.js`, `chat-engine.js:41-58`); everything else (feed, dweb index, swarm, version
announcements) accepts unsigned input from anyone. (b) The **external `ipfs/` stack**
(Kubo + ipfs-cluster + Tailscale) is a **private cluster of trusted collaborators**: membership
is gated by the cluster secret and tailnet invitation. [Verified in code]

**Consequence for component choice:** IPFS Cluster is the *correct* component only for the
opt-in private co-pinning group (b). It is *not* a defensible trust anchor for the open mesh
(a), and nothing in (a) should assume cluster-level trust. [Decision — locked for this audit]

## 4. Threat model

**Adversary, in priority order:** (1) a **malicious peer** on the open gossip mesh — can spoof
swarm/feed/dweb/version messages, harvest chat metadata, attempt MITM on first contact
(TOFU window), and submit hostile content that reaches the local LLM (prompt injection);
(2) a **network observer** — transport is Noise-encrypted (libp2p), but gossipsub topic
membership and traffic patterns are visible to mesh participants; chat envelopes broadcast
`to`/`from` PeerIDs to the whole topic, so **any mesh peer learns who talks to whom**
[Verified — open finding]; (3) a **forensic examiner with disk access** — Signal identity,
sessions, and pre-keys are encrypted at rest via Electron `safeStorage` (OS keychain-backed),
but chat *history*, browsing history, bookmarks, feed cache, and agent SQLite threads are
plaintext on disk [Verified in code]. **Out of scope:** a global passive adversary, malicious
model weights, a compromised OS/keychain, and physical attackers with the user's login session.
[Decision — locked for this audit]
