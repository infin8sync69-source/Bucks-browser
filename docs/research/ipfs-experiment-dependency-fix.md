# IPFS Infrastructure Experiment Report — Dependency & Content-Retrieval Fixes

Date: 2026-07-25

> **Note on filename:** the originally-requested path (`bucks browser/ipfs-experiment-report.md`)
> was found already occupied by a report from a separate, concurrent task working on this same
> repo (chat-messaging / P2P layer, touching `chat-engine.js`, `agent-swarm.js`, `scripts/ipfs-worker.js`
> etc.). That report actually references and builds on the `electron/package.json` fix documented
> here ("during which `electron/package.json` was updated externally... That fix is why GossipSub
> passes in this report"). Rather than overwrite their work, this report uses a distinct filename.
> Both should be read together — see the end of this doc for how they relate.

## TL;DR

The IPFS layer (`electron/ipfs-node.js` + Helia/libp2p) was **not actually working end-to-end** before this pass, despite looking correct on read-through and despite several real historical bug fixes already recorded in its comments. Nobody had run a genuine two-peer test before. Two independent, compounding dependency bugs plus one logic bug meant that in practice:

- **Gossipsub delivered no messages at all**, even between two directly-connected peers — so every swarm feature that depends on it (peer identity heartbeat, feed dissemination, soul discovery, dweb page announcements, recommend/pin votes, and — per the sibling report — chat key exchange) was silently non-functional.
- **Bitswap file transfer between peers broke** whenever gossipsub was also registered on the same libp2p node (which it always is in production).
- **Retrieving locally-stored content (`getContent()`) always mis-detected plain files as directories** and fell back to an HTTP call to a local Kubo gateway on `127.0.0.1:8080` — which most users won't have running, so this would fail outright for them.

All three are now fixed and verified against the **actual shipped `ipfs-node.js`**, running as two independent OS processes, with real bitswap transfer and real gossipsub propagation confirmed. 8/9 automated tests pass; the 9th (public-bootstrap peer discovery) is informational only and not part of the production design.

## Root cause #1: gossipsub is incompatible with the installed libp2p major version

`electron/package.json` had `libp2p: ^3.1.3` (resolved to `3.3.4`) alongside `@chainsafe/libp2p-gossipsub: ^14.1.2`. **14.1.2 is the newest gossipsub release that exists on npm, and it only supports `@libp2p/interface@^2.0.0`.** `libp2p@3.x` requires `@libp2p/interface@^3.x`. No gossipsub release compatible with libp2p v3 exists yet upstream (checked the full published version history).

Because of this, `npm install` silently nested an entire second, older `@libp2p/*`/`multiformats@13` dependency tree just to satisfy gossipsub, alongside the "real" v3 tree the rest of the stack uses. The two realms don't share class identity (a `PeerId` from one isn't `instanceof` the `PeerId` the other expects, etc.), so:

- Gossipsub's mesh never formed. Two directly-dialed peers subscribed to the same topic and gossipsub delivered **zero** messages between them — confirmed in isolation, independent of any other service.
- When gossipsub was registered as a co-service on the same libp2p node as bitswap (exactly production's setup), bitswap also broke: it never even attempted to send a `WANT` message to an already-connected peer.
- The class-identity split also caused sporadic false failures elsewhere (e.g. `ipfs-unixfs-exporter`'s `CID.asCID(path) === path` check failing on a CID minted in the "wrong" realm), because the surrounding install had `multiformats@13.4.2` at the top level while most of the stack expected `multiformats@14.0.0`.

**Fix:** downgraded the entire libp2p/helia generation in `electron/package.json` to the last major line that gossipsub 14.1.2 actually supports (`@libp2p/interface@^2.11.0`), and pinned every package in that interlocking set to exact versions rather than caret ranges — given how easily one transitive bump reintroduces this exact class of bug, floating ranges are actively dangerous here:

| package | before | after |
|---|---|---|
| `libp2p` | `^3.1.3` (→3.3.4) | `2.10.0` |
| `helia` | `^6.0.20` (→6.1.4) | `5.5.1` |
| `@helia/unixfs` | `^7.0.4` | `4.0.3` |
| `@helia/block-brokers` | *(missing from package.json — undeclared transitive dep)* | `4.2.4` |
| `@chainsafe/libp2p-noise` | `^17.0.0` | `16.1.4` |
| `@chainsafe/libp2p-yamux` | `^8.0.1` | `7.0.4` |
| `@libp2p/tcp` | `^11.0.10` | `10.1.0` |
| `@libp2p/websockets` | `^10.1.3` | `9.2.19` |
| `@libp2p/mplex` | `^12.0.11` | `11.0.47` |
| `@libp2p/mdns` | `^12.0.25` | `11.0.47` |
| `@libp2p/bootstrap` | `^12.0.25` | `11.0.47` |
| `@libp2p/identify` | `^4.0.10` | `3.0.20` |
| `@libp2p/crypto` | *(undeclared transitive)* | `5.1.8` |
| `@libp2p/utils` | *(undeclared transitive)* | `6.7.2` |
| `@multiformats/multiaddr` | `^13.0.1` | `12.5.1` |
| `multiformats` | *(undeclared transitive)* | `13.4.2` |
| `@chainsafe/libp2p-gossipsub` | `^14.1.2` | `14.1.2` (unchanged, now finally compatible) |

`@libp2p/peer-id` was already correctly pinned at `5.1.9` and needed no change.

Verified in isolation before touching the real project (scratch npm install), then verified again against the actual `electron/node_modules` tree: gossipsub delivery and bitswap transfer both pass now, `@libp2p/interface` dedupes to a single `2.11.0` across the tree, and `multiformats` dedupes to a single `13.4.2`.

**Trade-off, disclosed rather than hidden:** this downgrade reintroduces one `npm audit` finding — `@libp2p/kad-dht <16.2.6` (GHSA-32mq-hpph-xfvr, high, DHT server-mode disk exhaustion), pulled in as `helia@5.5.1`'s own internal fallback dependency. **Bucks never reaches this code path** — `ipfs-node.js` always supplies its own custom `libp2p` instance to `createHelia()`, and that instance never registers a `dht` service, so Helia's own bundled-but-unused kad-dht is dead code at runtime here, not a live attack surface. Still, it's a real line in `npm audit` now and worth knowing about. (Also confirmed a large pre-existing, unrelated `npm audit` cluster in the `electron-builder` devDependency tree, including a critical `node-tar` advisory — this existed before any of my changes and is unrelated to IPFS; flagging separately rather than fixing here since it's out of scope and `electron-builder` is dev/build tooling, not shipped in the app.)

## Root cause #2: `blockstore-fs` made a silent breaking change at v3.0.0

Independent of the above: `blockstore-fs@3.0.0` through the latest `3.0.3` (which is what was actually installed before I touched anything) changed `.get(cid)` from a plain `async get()` returning `Promise<Uint8Array>` to an `async *get()` **async generator** — without a corresponding major-version bump in its declared `interface-blockstore` peer range (both still claim `^5.0.0`/`^6.0.0`). `ipfs-unixfs-exporter`'s raw-block resolver (bundled inside `@helia/unixfs`) still assumes the old plain-Promise shape and does `size: BigInt(block.length)` — `block` is the async generator object itself (never awaited/consumed), so `.length` is `undefined` and `BigInt(undefined)` throws `TypeError: Cannot convert undefined to a BigInt`.

This means **`getContent()`, `pinContent()`, and any other call to `fsModule.cat()`/`fsModule.ls()` on locally-stored blocks were already broken before I changed anything else** — this predates the gossipsub fix and is not something I introduced. It was silently masked because `getContent()` catches the Helia-path failure and falls back to an HTTP call to a local Kubo gateway (`127.0.0.1:8080`) — which happens to be running on this development machine (a real `ipfs`/Kubo daemon was found listening on ports 5001/8080 via `lsof`; the sibling report identifies it as `kubo/0.41.0` via Homebrew), but won't be running on a typical end user's machine, where this would fail outright with no working retrieval path at all.

**Fix:** pinned `blockstore-fs` to `2.0.5` (the last version with the plain-Promise `get()` shape) and `datastore-fs` to `11.0.0` (matching `interface-datastore` generation) in `electron/package.json`. Verified via direct inspection of the packed tarball source across `2.0.5`/`3.0.0`–`3.0.3` that only `2.0.5` has the correct shape, then confirmed the fix removes the error entirely.

## Root cause #3: `getContent()`'s directory-detection logic has a real logic bug

Separately from the dependency issues, once blocks could actually be read, `getContent()` (`electron/ipfs-node.js`) still mis-classified every plain (non-directory) CID as a directory. Its check was:

```js
try {
  for await (const entry of fsModule.ls(currentCid)) { isDir = true; ... }
} catch { isDir = false; }
```

The assumption — `ls()` throws or yields nothing for a non-directory — doesn't hold for the currently-installed `ipfs-unixfs-exporter`: `ls()` on a raw/file leaf CID yields a single **self-referential entry describing the node itself**, rather than throwing. So `isDir` was always set `true`, no entry ever had `name === 'index.html'`, and the function always threw `"Directory listing without index.html is not supported"` for ordinary files — silently caught by the outer try/catch and routed to the Kubo-gateway fallback every single time.

**Fix:** replaced the `ls()`-based heuristic with `fsModule.stat(currentCid)`, which returns an explicit `{ type: 'file' | 'directory' | 'raw' }` and is the correct API for this check. `ls()` is now only called when `stat()` has already confirmed the CID is a real directory. Verified: after the fix, `getContent()` succeeds via the pure Helia path with **no fallback warning at all**, for both plain files and UnixFS directories with `index.html`.

## What was verified, and how

All testing used the actual shipped `electron/ipfs-node.js` module (not a parallel reimplementation), run under Electron's real main-process runtime (`app.getPath()` etc. all genuine) so results reflect what the packaged app will actually do:

1. **`electron/scripts/test-ipfs.mjs`** — a 9-part Helia/libp2p stress suite mirroring `ipfs-node.js`'s actual service configuration (identify + gossipsub, mDNS discovery, bitswap block broker — no DHT/ping, matching production, which uses neither). **8/9 pass.**
2. **`electron/scripts/smoke-ipfs-node.js`** — single-node lifecycle smoke test of the real module: `startNode()` → `publishContent()` → `getContent()` → `pinContent()` → `stopNode()`. Passes.
3. **`electron/scripts/smoke-node-a.js` + `smoke-node-b.js`** — two genuinely separate OS processes, each running the real `ipfs-node.js`. Node A publishes; Node B (a fresh process with its own identity) discovers A via mDNS, receives the gossiped feed post, and fetches the content via bitswap through the real `getContent()`. **Confirmed passing**, including the gossipsub propagation log line (`[Swarm] Received gossiped post`) and correct byte-for-byte content match.

### Test suite results (`electron/scripts/test-ipfs.mjs`)

| # | Test | Result |
|---|---|---|
| 1 | Node startup | ✅ ~30ms |
| 2 | String add/get | ✅ |
| 3 | JSON (Soul Profile) add/get | ✅ |
| 4 | UnixFS file add/cat | ✅ |
| 5 | Two-node bitswap transfer | ✅ |
| 6 | Public bootstrap peer discovery | ❌ (see below — expected) |
| 7 | GossipSub pubsub delivery | ✅ |
| 8 | 1MB file add + cross-node fetch | ✅ (add 2ms, fetch 29ms) |
| 9 | UnixFS directory + index.html resolution | ✅ |

**Test 6 failure is expected and not a product bug.** It dials the public `bootstrap.libp2p.io` dnsaddr peers — something Bucks's actual design deliberately never does (per `ipfs-node.js`'s own comments: mDNS for LAN discovery, explicit `BUCKS_BOOTSTRAP_PEERS` for cross-network — never the public IPFS network). DNS TXT resolution for the bootstrap dnsaddrs works fine from this sandbox (`dig`/`nslookup` succeed), but outbound TCP dials to the resolved public peer IPs never connect — most likely an egress restriction of this sandboxed environment, not a code issue. It's isolated to its own disposable node in the test suite specifically so it can't pollute the connection manager of the nodes used in the other 8 tests (it did, before the suite was restructured — see below).

### A methodological note worth keeping in mind for future testing

The first draft of the test suite ran the public-bootstrap test on the *same* node used for the bitswap/gossipsub tests. That node ended up connected to ~40 public IPFS peers and running kad-dht server-mode random-walk churn, which was enough to make the local two-node bitswap transfer time out — a **false negative** that had nothing to do with the real bug. Isolating the bootstrap test to its own disposable node (matching production, which never does this at all) removed the interference. Worth remembering if this suite gets extended: don't mix public-network stress with local-swarm correctness tests on the same node.

## Files changed

- **`electron/package.json`** — dependency versions per the table above. Original backed up to `bucks browser/.pre-ipfs-fix-backup/` (see below — **this project has no git**, so that folder is the only restore point).
- **`electron/ipfs-node.js`** — `getContent()`'s directory-detection logic (`stat()` instead of the `ls()` heuristic). No other logic changed.
- **`electron/scripts/test-ipfs.mjs`** (new) — the 9-part stress suite, kept as a reusable regression check.
- **`electron/scripts/smoke-ipfs-node.js`**, **`smoke-node-a.js`**, **`smoke-node-b.js`** (new) — real end-to-end regression tests against the actual shipped module. Worth keeping and running after any future dependency bump in this area, given how silently these bugs hid.
- **`scripts/test-ipfs.mjs`** (root level, the path originally requested for the test suite) — converted to a one-line redirect into `electron/scripts/test-ipfs.mjs`, with a comment explaining why (see next section). This did **not** touch `scripts/ipfs-worker.js`, `scripts/test-ipfs-node.js`, `scripts/chat-worker.js`, `scripts/test-two-users.js`, or `test-identities.json` — those belong to the concurrent chat-messaging task.

## A repo-hygiene finding, not fixed

`bucks browser/package.json` (root level) declares its **own, separate** copy of the entire helia/libp2p/gossipsub stack, resolved into `bucks browser/node_modules` — completely independent from `electron/node_modules`, which is what the shipped app actually uses (Node resolves `require()`/`import` from `electron/*.js` against `electron/node_modules` first, since it's closer in the directory tree; the root tree is never consulted while the app runs). This root copy:

- Still has the **unfixed** gossipsub/libp2p-v3 mismatch (only `electron/` was fixed).
- Also has a stale `@libp2p/webrtc@6.0.22` (root) vs. the already-patched `@libp2p/webrtc@6.0.25` in `electron/node_modules` — the older one has a real bug (`import pkgWebcrypto from '@peculiar/webcrypto'` default-imports a module with no default export, which is a hard `SyntaxError` under Node's strict ESM linking, not a runtime error — this crashes on the very first `import("helia")`, before any of your code runs). This is what caused my first standalone test run to fail outright, before I realized the root and electron trees were different.

Left alone rather than fixed, since it costs nothing at runtime (dead weight, not a live bug) and fixing it would mean repeating the entire dependency-downgrade exercise a second time for zero functional benefit. Recommend either deleting the root `node_modules`/`package.json`/`package-lock.json` (if nothing actually needs to run from there) or syncing it to match `electron/`'s fixed versions, to stop it being a trap for the next person who runs something from `bucks browser/` directly instead of `bucks browser/electron/`.

## Relationship to `ipfs-experiment-report.md` (the sibling report)

A separate concurrent task tested `ipfs-bridge.js` (Kubo-compatible HTTP API + real Kubo daemon peering) and the chat-engine's use of gossipsub for key exchange, building on top of the `electron/package.json` fix documented here once it landed. That report is complementary, not duplicate: it covers the bridge/HTTP layer and chat integration this report doesn't, while this report covers *why* the fix was needed, the two additional bugs (`blockstore-fs` shape mismatch, `getContent()` directory-detection) that report doesn't mention, and the repo-hygiene finding about the stale root `package.json`. Read both.

## Recommendation: get this into git

This repository has no version control. The dependency fix touches ~17 package versions across an interlocking, easy-to-silently-break stack, and the `.pre-ipfs-fix-backup/` folder created here is a stopgap, not a substitute for real history — doubly important now that at least two concurrent tasks are editing this repo at once with no way to see each other's diffs except by noticing files on disk. Strongly recommend `git init && git add -A && git commit` as a baseline as soon as possible.
