# Bridging IPFS with the Agentic Pipeline

Answers "how do we bridge the IPFS infrastructure with the current agentic layer?" — grounded in what was empirically verified on the running system, not on the design docs.

## The short answer

**The transport bridge already exists and works.** What was missing is that it was *browser-mediated* for exactly the parts that make Bucks distinctive, and that the agent had no reason to reach for the swarm even when it could.

---

## What was already there (verified live)

- `~/.bucks/ipfs.json` — endpoint manifest written by the browser: `apiUrl` (Kubo :5001), `bridgeUrl` (:5006), ordered `gatewayUrls` with public fallbacks.
- `mode: "kubo+bridge"` — Helia and the Kubo daemon peered, content planes merged.
- Agent tools: `ipfs_upload_text`, `ipfs_cat_text`, `dweb_publish`, `dweb_search`, `ipfs_dynamic_load_tool`, plus 8 `cluster_*` tools.
- `rag/ipfs_store.py` → `IPFSKnowledgeStore`, wired into `RAGPipeline` at `soul_engine.py`, used by the user-gated "adopt knowledge fragment" flow.

**Verified working:** upload → cat round-trip through the agent's own tools returned the exact payload.

---

## The real finding: a split-brain bridge

Two classes of IPFS call resolve through *different paths with different availability*:

| call | route | works headless? |
|---|---|---|
| `ipfs_upload_text` / `ipfs_cat_text` | Kubo daemon (:5001) | ✅ yes |
| `dweb_search`, `cluster_*`, files | **only** `electron/ipfs-bridge.js` (:5006) | ❌ no |

The `/api/v0/bucks/*` extension endpoints exist solely inside the Electron process. The agent server is a **separate** process on :8765 that can run headless — so with the browser closed, the agent could still upload to IPFS but "knew nothing" about its own cluster.

**Demonstrated directly** (browser closed):
```
upload:              ✓ CID: QmQXQj2Lgbr4H1vvSDh1eSdnunHQccG1
dweb_search:         Error: the Bucks browser bridge is not reachable…
cluster_list_members: Error: the Bucks browser bridge is not reachable.
```

This is why agent behaviour felt arbitrary: identical-looking capabilities silently depended on whether a UI window happened to be open.

### Fix applied — headless read path

`ipfs-node.js` already persists all cluster state as plain JSON under Electron's `userData/ipfs-data/` (`dweb-index.json`, `cluster-members.json`, `pinned.json`, `feed.json`, `following.json`, `votes.json`). The agent now reads these directly when the bridge is unreachable.

- `_electron_user_data_dir()` resolves the path per platform (macOS / Windows / XDG).
- `dweb_search` falls back to filtering the on-disk index and labels results `[cached index — browser not running]` so the model knows it is degraded.

**Verified with the browser closed:** the agent found the published page and its CID, then fetched 2,141 bytes of real HTML for it via `ipfs_cat_text`.

**Writes deliberately still require the browser** — publishing must gossip over the live libp2p node, which only exists in the Electron process. Reads degrade gracefully; writes fail honestly.

---

## Two agent-quality fixes this surfaced

**Tool-budget leak.** The query *"search the dweb index for published pages…"* selected **25** schemas — the bare word `"page"` tripped the 15-schema browser block, which was appended *after* the 10-tool cap. Trigger words are now specific (`"this page"`, `"open the"`, `"navigate"`), and the browser block is counted *inside* the budget. Same query now selects **10**.

**Hallucination on unread content.** Given a listing of titles, the model described a page it had never fetched — *"likely contains information about the project's goals"*. `dweb_search` now appends an explicit instruction that the listing is titles-only and that `ipfs_cat_text` must be called to read content. The model stopped inventing and now correctly reports that it hasn't read the page.

---

## The bridge, as four layers

1. **Transport** — endpoint resolution, gateway fallback, Kubo↔Helia peering. *Exists, verified.*
2. **Read/discovery** — the agent can find and fetch what the swarm holds, with or without the UI. *Now working.*
3. **Publication** — agent outputs become content-addressed. *Partially there:* `dweb_publish` and `ipfs_upload_text` exist, but generated reports/PDFs (`~/Documents/Bucks`) are not auto-pinned, so agent work product stays local and unshareable.
4. **Compute** — inference distributed across peers. *Designed only* (`ble-mesh-comms-plan.md` §7: `/bucks/inference/v1`, capability flags, BUCKS settlement). Nothing built.

---

## Recommended next steps, in order

**1. Index cluster content into RAG (highest value, low risk).**
Today the agent only sees swarm content if it *chooses* to call `dweb_search`. With tool tiering, those tools only load when keywords match — so "what do we know about X?" never consults the cluster. Feeding the dWeb index and pinned-file metadata through `IPFSKnowledgeStore` into normal retrieval makes cluster knowledge available without the model having to think of it. The plumbing (`IPFSKnowledgeStore`, `adopt_ipfs_fragment`) already exists and is currently only used for explicit adoption.

**2. Auto-pin agent work product.**
`create_document`/`create_pdf` write locally. Pinning on creation and returning the CID makes every artifact shareable across the cluster for free, and closes the publication layer.

**3. Distributed inference — the strategic one.**
This is the real answer to the 7B ceiling. The constraint is "no third-party LLM APIs", *not* "no remote compute": routing inference to a **peer you own or trust** (a desktop with a 70B model, say) honours the inbuilt-only principle while removing the capability ceiling. `/bucks/inference/v1` is already specified. This is the single change that would most improve agent quality, and it is architecture, not prompt-tuning.

---

## The ceiling, stated plainly

Two failures in this session were **not** pipeline defects and were not fixed by any of the above:

- the model asks *"would you like me to fetch it?"* instead of simply calling the next tool;
- it repeats a search 3–4× until duplicate-suppression stops it.

Both are 7B-model reasoning limits. Everything in this document removes self-inflicted damage around the model; none of it makes the model better. Recommendation #3 is the only lever here that changes that, and it is a product decision about what "inbuilt" means — worth deciding deliberately rather than discovering through disappointment.
