# IPFS/Helia Experiment Report — Phase 2

Generated: 2026-07-25T10:26:37.240Z

Tests the **existing, unmodified** `electron/ipfs-node.js` and `electron/ipfs-bridge.js`
modules — two real Helia/libp2p node processes, each running the real production code
against an isolated userData directory (via `scripts/ipfs-worker.js` + `scripts/test-ipfs-node.js`).
No reimplementation: every check below calls the actual exported functions from those files.

## Summary

| Area | Status | Detail |
|---|---|---|
| startup | PASS | Node A up — peerId 12D3KooWGJWJW5yeEByk... |
| startup | PASS | Node B up — peerId 12D3KooWFTVg1Vo6L5LQ... |
| bridge-startup | PASS | ipfs-bridge.js bound port=5006 kuboDetected=true |
| add | PASS | Added content, CID: bafkreidjm3f7cgf6n4653lo2ch6mr2yvhihsf5pphmdrjhwaz4daubwbuq |
| get-by-cid | PASS | Retrieved content matches exactly (2ms) |
| bridge-id | PASS | GET /api/v0/id -> 200, ID matches: true |
| bridge-gateway | PASS | GET /ipfs/<cid> -> 200, body matches: true |
| bridge-add | PASS | POST /api/v0/add -> 200, Hash: bafkreiegdhqf3ux6iomanun2cux7ek447kye4avzslatugkmurhltvvx3q |
| bridge-cat | PASS | GET /api/v0/cat -> 200, round-trip matches: true |
| p2p-connect | PASS | A.connectPeer(B) -> {"success":true} |
| p2p-publish | PASS | A published new content for B to fetch: bafkreiamihqazwggeer36ciyku2nzuvddncdtja3ylpzkeypuie73qxnbe |
| p2p-bitswap-fetch | PASS | B fetched A's content via Bitswap in 22ms, content matches exactly |
| gossipsub-app-topic | PASS | B learned A's identity via the app's CLUSTER_TOPIC gossipsub broadcast (advertiseIdentity) |
| gossipsub-raw-pubsub | PASS | Raw gossipsub publish/subscribe between the two Helia nodes works (pubsub IS wired through, not just raw libp2p) |

## What works

- **startup**: Node A up — peerId 12D3KooWGJWJW5yeEByk...
- **startup**: Node B up — peerId 12D3KooWFTVg1Vo6L5LQ...
- **bridge-startup**: ipfs-bridge.js bound port=5006 kuboDetected=true
- **add**: Added content, CID: bafkreidjm3f7cgf6n4653lo2ch6mr2yvhihsf5pphmdrjhwaz4daubwbuq
- **get-by-cid**: Retrieved content matches exactly (2ms)
- **bridge-id**: GET /api/v0/id -> 200, ID matches: true
- **bridge-gateway**: GET /ipfs/<cid> -> 200, body matches: true
- **bridge-add**: POST /api/v0/add -> 200, Hash: bafkreiegdhqf3ux6iomanun2cux7ek447kye4avzslatugkmurhltvvx3q
- **bridge-cat**: GET /api/v0/cat -> 200, round-trip matches: true
- **p2p-connect**: A.connectPeer(B) -> {"success":true}
- **p2p-publish**: A published new content for B to fetch: bafkreiamihqazwggeer36ciyku2nzuvddncdtja3ylpzkeypuie73qxnbe
- **p2p-bitswap-fetch**: B fetched A's content via Bitswap in 22ms, content matches exactly
- **gossipsub-app-topic**: B learned A's identity via the app's CLUSTER_TOPIC gossipsub broadcast (advertiseIdentity)
- **gossipsub-raw-pubsub**: Raw gossipsub publish/subscribe between the two Helia nodes works (pubsub IS wired through, not just raw libp2p)

## What is broken

Nothing — every check passed.

## Answering the specific questions asked

- **Add a file/string and get its CID, then retrieve it back**: PASS — Retrieved content matches exactly (2ms)
- **Peer-to-peer content transfer**: PASS — B fetched A's content via Bitswap in 22ms, content matches exactly
- **Is GossipSub wired through IPFS, or just raw libp2p?** GossipSub is genuinely wired through and both the app's own topics and a fresh raw topic deliver: app-topic propagation = PASS, raw pubsub round-trip = PASS. (This required the sibling chat-messaging fix earlier in this session — see below.)

## Context that shaped this run

This test ran immediately after a Phase 1 (chat messaging) test in the same session, during
which `electron/package.json` was updated externally (by a separate parallel task) to pin
`libp2p` down to `2.10.0` / `@libp2p/interface` to `2.11.0` — matching the peer dependency
`@chainsafe/libp2p-gossipsub@14.1.2` actually requires (`^2.0.0`). Before that pin landed,
gossipsub never formed a mesh at all (confirmed with a raw two-node pubsub test) because the
installed `libp2p` was on an incompatible v3 line with no gossipsub release supporting it.
That fix is why GossipSub passes in this report — it is app-wide (chat key exchange, cluster
membership, feed, soul, and dweb topics all share the same gossipsub instance/config shape),
not something this Phase 2 run did on its own.

## Notes on ipfs-bridge.js

`ipfs-bridge.js` is explicitly designed to be Electron-free and testable standalone (see its
own header comment), which held up — it ran unmodified against the real `ipfs-node.js` module
passed in as `_ipfs`.
It detected a **real local Kubo daemon already running on this machine** (`kubo/0.41.0`,
via Homebrew) and bidirectionally peered with it — Kubo's loopback multiaddrs were dialed
from the Helia side and Kubo was told about the Helia node's addresses via `/api/v0/swarm/connect`,
so it ran in `kubo+bridge` mode: the Kubo-compatible HTTP API on port 5006 (5001 was already
held by the real Kubo daemon) proxies to the Helia node while write-through block/put keeps
the two content planes in sync. This was not staged — it is the module's real behavior when
a Kubo daemon happens to be present, exactly as its header comment describes.
