# Bucks Browser codebase gap audit vs. target: "complete end-to-end decentralised browser where every system can host and serve ipfs:// content, with a local agent layer and a blockchain configuration platform"

Conventions. `bb/` = FINAL repo (branch `claude/browser-repos-alignment-aew07f`, HEAD 5e97efd) at `/private/tmp/claude-501/-Users-mikado-Desktop-Bucks-Core-bucks-browser/afe3f5cc-208f-4037-9d92-cb0c8b618f1d/scratchpad/bb`. `core/` = older Bucks Core line at `/Users/mikado/Desktop/Bucks Core/bucks browser` (branch `chore/production-cleanup`, dirty tree). `chain/` = `.../scratchpad/buckscore`. Sources are local files (file:line), not URLs. Every claim is tagged **[V]** verified by reading code, or **[I]** inferred. No apps were run; no project files modified; no secret values were read or printed (only file names and secret types are mentioned). Attempts to verify Kubo defaults from the upstream docs (WebFetch of ipfs/kubo docs/config.md) failed because the page text was truncated, so every statement below about Kubo's built-in defaults is **[I] from prior knowledge, unverified**.

---

## 1. IPFS today: how Kubo is located, configured, started; how ipfs:// and ipns:// are served; what features exist and what is missing

### Takeaway
The final repo has a solid, well-tested *consumer* IPFS stack (Kubo sidecar with locate/download/init/patch/spawn/health/restart, a streaming `ipfs://`/`ipns://` protocol handler with one web origin per CID, single-file add/pin/cat UI, and a device-pairing service over pubsub). It has no *publisher/host* stack: no directory/site add, no IPNS keys or publishing, no naming, no remote pinning/cluster, no quotas or GC policy, no provider (announce) tuning, no NAT/relay configuration, and no human-readable names. The Kubo node is configured only for pairing (pubsub+mDNS+Peering) and loopback binding, so "every system can host and serve" is not met.

### Cited Findings

**Locate / download / init / start (all [V])**
- Binary lookup order: `$BUCKS_KUBO_BIN`, `<resources>/kubo/ipfs`, `<resources>/kubo/<os>-<arch>/ipfs`, `<userData>/kubo/bin/ipfs` — `bb/src/main/ipfs/kubo.js:~230-247` (`candidateBinaryPaths`).
- Runtime download of the *latest stable* Kubo from `dist.ipfs.tech`, with GitHub-releases fallback and a hard-coded fallback version `v0.43.1`; integrity = SHA-512 from the *same mirror* (`.sha512` next to the archive), no signature verification — `bb/src/main/ipfs/dist.js:18-22, 62-78`; `bb/scripts/fetch-kubo.mjs:109-118` (latest unless `--version`). Release builds therefore are not version-pinned/reproducible.
- Repo init: `ipfs init --profile=lowpower --empty-repo=true` — `kubo.js:507-514`. (Per Kubo docs the lowpower profile sets the DHT client mode and disables reprovide/AutoNAT service: **[I] unverified**; if true, the node cannot serve content to the wider swarm well, which conflicts with "every system can host".)
- Config patch before every start, written atomically — `kubo.js:186-203` (`applyBucksConfig`) and `kubo.js:518-532` (`patchConfig`). Keys actually set: `Addresses.API` (127.0.0.1:<port>), `Addresses.Gateway` (127.0.0.1:<port>), `Addresses.Swarm` (rewritten to reserved swarm port), `Pubsub.Enabled=true`, `Pubsub.Router=gossipsub`, `Discovery.MDNS.Enabled=true`, `Peering.Peers` (paired devices only). **Not set anywhere**: `Routing.*`, `Provide.*`/`Reprovider.*`, `AutoNAT.*`, `Swarm.RelayClient/RelayService/EnableHolePunching/AutoRelay`, `Swarm.ConnMgr`, `Gateway.*` (HTTPHeaders, NoFetch, PublicGateways), `API.HTTPHeaders` (CORS), `Datastore.StorageMax`/`GCWatermark`, `Experimental.*`. (grep for these names across `bb/src`, `bb/ui/src`, `bb/agent` found nothing.)
- Daemon spawn: `ipfs daemon --migrate=true --enable-gc` — `kubo.js:588`. GC is on with Kubo's defaults only (no `StorageMax` set; **[V]** by absence).
- Adopt-or-spawn, stale-lock clearing, 60 s health poll, back-off restart 2/5/15 s, external-node mode (`settings.ipfs.mode='external'`, `externalApiUrl`) — `kubo.js:560-581, 725-775`, `docs/ARCHITECTURE.md` "Kubo sidecar lifecycle". External mode does not manage config, so pairing/pubsub only works if the user's node has it enabled (devices-service re-adds peering live at `devices-service.js:346-350`).
- Ports reserved once in `<userData>/kubo/runtime.json`; swarm port is non-default so it does not collide with a user's Kubo on 4001 — `kubo.js:415-436`. **[I]** consequence: a random swarm port hurts inbound reachability (no UPnP/port-mapping configured; see gap G7).

**Serving ipfs:// and ipns:// ([V], `bb/src/main/protocols/ipfs.js`)**
- Schemes registered as standard+secure+CORS+stream, service workers off — `bb/src/main/protocols/index.js:14-21`. Handler installed on default session and `persist:bucks-web` — `ipfs.js:283-293`.
- Validation: ipfs host must parse as CID (`ipfs.js:250-251`), ipns host must match `/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i` and <=253 chars (`ipfs.js:22,252`). Only GET/HEAD (`ipfs.js:172-175`).
- Upstream = path gateway `http://127.0.0.1:<gw>/ipfs|ipns/<host><path><query>` (`ipfs.js:33-37`). Streams the body unbuffered; 60 s timeout only for headers (`ipfs.js:177-201`, `229-232`).
- Origin per CID: follows from `standard` scheme (`protocols/index.js:15-16`); documented in `docs/ARCHITECTURE.md` "Origin isolation per CID". CIDv0 handling: `normalizeIpfsUrl` converts to CIDv1 base32 in the omnibox path (`bb/src/main/ipfs/cid.js:73-94`); lowercase `qm...` gets an explanatory error (`ipfs.js:21,121-129`).
- Redirect handling: `redirect:'manual'`, `Location` rewritten back to `ipfs://`/`ipns://` incl. subdomain-gateway form, self-redirect followed up to 3 hops (`ipfs.js:46-64, 213-227`). Relative `Location` returned unchanged (`ipfs.js:60-63`).
- Header policy: only a whitelist of response headers is copied, including upstream `content-security-policy`, `cache-control`, `etag`, `access-control-allow-origin` (`ipfs.js:15-20,208-212`). Bucks adds **no** CSP, no `X-Content-Type-Options`, no `Referrer-Policy`, no sandboxing of its own for ipfs content. Only Bucks-generated error pages carry a CSP (`ipfs.js:103`). Caching is entirely Kubo's (`cache-control` passthrough); there is no Bucks-side cache.
- **No SPA / web-app routing support.** The handler proxies to the *path* gateway; there is no `_redirects`, no fallback-to-index rewrite, no `404.html` handling. **[I]** Kubo's `_redirects` support is limited to subdomain/DNSLink gateway modes (from prior knowledge, unverified), so single-page apps with client-side routes deep-linked from `ipfs://<cid>/route` will 404 unless the app uses hash routing.
- Fallback policy: if node is ready and `preferredGateway !== 'public'` → local gateway; if `initializing` → "starting" page (503, refresh 2 s); **otherwise (error / stopped / idle) → public gateway `settings.ipfs.publicGateway` (default `https://ipfs.io`) silently** — `ipfs.js:256-266`, default at `bb/src/main/settings.js:14`. Privacy: the requested CID/IPNS name/path, the user's IP, and request headers (`Range`, `Accept`, `If-None-Match`) are sent to a third party with no per-request notice; I found no UI indicator that a given load went public (not verified in `ui/`, **[I]**). `ipns://<dnslink-domain>` resolution via the local node performs DNS lookups from the node (**[I]**).
- No CID-level verification when the public gateway is used (the response bytes are trusted; Bucks does not verify the hash of a public-gateway response). **[V]** by absence in `ipfs.js`.
- `ipns://` handled by exactly the same code path (`ipfs.js:250-253`), so IPNS names resolve only through Kubo's resolver; no `bucks://<name>` resolution (`bb/src/main/protocols/bucks.js:129` serves only host `app`).

**IPC / UI features ([V])**
- Channels (`bb/src/main/ipfs/ipc.js:103-189`, exposed at `bb/src/preload/preload.cjs:103-135`): `status,start,stop,node-info,add,add-text,cat,ls,pin-add,pin-rm,pin-ls,peers,stats,resolve,gateway-url-for,normalize-url`.
- `add`: **single file** from base64, hard cap 512 MiB (`ipc.js:13,56`), `pin:true`, CIDv1, raw-leaves. `rpc.add` has a `wrapWithDirectory` option (`rpc.js:196-228`) but no caller passes it and no multi-file/directory input exists. **No site/folder publishing.**
- `pin-ls` returns recursive pins only (`ipc.js:167`, `rpc.js:293-298`). No pin labels, no pin policy, no size accounting per pin, no unpin confirmation, no quota. `pin-add` timeout 120 s, unbounded size (`rpc.js:281-285`).
- Not present in `rpc.js` or IPC: `name/publish`, `key/*`, `files/*` (MFS), `repo/gc`, `routing/provide`, `dag/*`, `pin/remote/*`, `swarm/connect` is present for devices only (`rpc.js:361`). (grep over `bb/src`, `bb/ui/src`, `bb/agent` found no matches.)
- UI: `bb/ui/src/routes/ipfs/+page.svelte` (43 lines) composes `AddContent` (paste text → `addText`, or one file/drag-drop → `add`), `PinList`, `PathBrowser`, `NodeStatusCard`, Devices section. No publish-site, no IPNS, no names, no storage settings.
- `bb/docs/ROADMAP.md` ("Next" #2) lists the hosting layer (IPFS Cluster / pinning service) and #3 `bucks://` name resolution via chain as *not built*; `docs/FEATURE-PARITY.md` marks dWeb publish/search, Cluster, Feed as "planned (batch D)".

**Devices pairing / outbox ([V])**
- Pubsub topic `bucks-devices-v1`, 30 s presence, 7-day outbox, caps (`bb/src/main/ipfs/devices-core.js:11-30`); pairing by mDNS discovery or pasted `/p2p/` address; live `swarm/peering/add` (`devices-service.js:346-360, 575-600`).
- Authenticity relies on the libp2p pubsub `from` field equalling the payload `peerId` (`devices-core.js:280-291`); the "signature" in docs is libp2p's message signing, not an application-level signature (**[I]** — depends on Kubo's default strict signing).
- Shares are plain public CIDs; presence messages (device name, addrs, file names) are readable by any node subscribed to the topic. Acknowledged in `docs/ROADMAP.md` "Next steps 1-3" (no E2E encryption, no pairing code, no relay/hole-punch).
- Optional `devices.autoPin` pins whatever a *paired* peer offers without size limit (`devices-service.js:460, 483-501`; setting at `settings.js:22`).

### Inferences
- The node is effectively a read-mostly "light" node: reachable inbound only on the LAN or when the user opens a port. A published site would vanish when the author's laptop sleeps.
- Silent public-gateway fallback converts a decentralisation feature into a metadata leak whenever Kubo is down, restarting, or `preferredGateway=public`.
- Because content is always proxied through the *path* gateway, the browser inherits path-gateway limitations (no `_redirects`, no per-site gateway headers, no DNSLink-specific features).

### Gaps (in knowledge)
- Actual runtime values of Kubo defaults (lowpower profile, Provide strategy, AutoNAT/relay defaults, `_redirects` rules) were not verifiable here (upstream docs fetch truncated).
- Whether the UI warns the user when public fallback is used (searched only main-process code and the omnibox helper; did not read all Svelte components).
- Real-world behaviour of pairing across NAT (docs say untested across two real machines — `docs/ROADMAP.md` "In progress").

---

## 2. Security review of the IPFS/IPC/agent pieces (file:line)

### Takeaway
The final repo is markedly better hardened than the older line (loopback-only Kubo with random ports, token-gated Soul Engine, origin-checked wallet proxy, traversal-safe `bucks://`). Remaining issues are mostly design gaps: no sender-frame check on IPC (except wallet), unvalidated settings that control process spawn and gateways, silent public fallback, no isolation of web pages from loopback services, an agent that can publish to IPFS without approval, and a legacy `exec()` of IPFS-fetched Python in the agent. The older line has serious live issues: unauthenticated local HTTP bridges and a leaked cluster secret.

### Cited Findings

**Final repo**
1. `bucks://` path traversal: resolved with `path.resolve` + prefix check, NUL check, SPA fallback only inside root — `bb/src/main/protocols/bucks.js:85-114` **[V]** (tested in `test/unit/main/bucks-protocol.test.js`). OK.
2. ipfs/ipns handler path handling: `parseIpfsUrl` regex splits host/path (`cid.js:97-107`); path is appended verbatim to the gateway URL (`ipfs.js:33-37`). Chromium normalises `..` in standard-scheme URLs before the handler; the gateway itself resolves content-addressed paths only, so there is no file-system path traversal surface. **[V]** for code; **[I]** for Chromium normalisation. No unit test covers `..`, `%2e%2e`, or encoded-slash inputs (`test/unit/ipfs/protocol.test.js` test list lines 9-185) — severity low.
3. IPC handlers for IPFS do not check `event.senderFrame`/origin (`ipc.js:91-101` ignores `_event`). Same for `bucks:settings:set` (`settings.js:116-117`), `bucks:agent:*` (`bridge.js:290-291`). Only the wallet proxy checks the sender (`bb/src/main/wallet/proxy.js:70-75, 127-130`). Mitigation: preload attached only to the chrome window and the chrome cannot navigate off-origin (`window.js:73-79`); web tabs have no preload (`docs/ARCHITECTURE.md`). **[V]** code, **[I]** exploitability low unless a chrome XSS exists. Severity: medium (defence in depth).
4. `bucks:settings:set` deep-merges any patch (`settings.js:60-67,117`). Values consumed unvalidated by privileged code: `agent.soul.python` / `agent.soul.agentDir` (spawn target — `soul-engine.js:64-80`), `ipfs.publicGateway` (only trimmed — `kubo.js:251-255`), `ipfs.externalApiUrl`, `agent.remoteUrl`. A compromised chrome could therefore execute arbitrary programs. **[V]**. Severity: medium (chrome compromise prerequisite).
5. Public-gateway fallback leaks CID/name/path/IP (see §1; `ipfs.js:256-266`, default `settings.js:14`). Severity: medium-high for a privacy browser. `publicGateway` value is user/settings-controlled and no scheme/host check exists beyond trimming.
6. Web pages can reach loopback services: filter exempts localhost from HTTPS upgrade (`security/filter.js:35-43,85`), and I found no private-network-access blocking in `bb/src/main/security/`. Kubo API (random port) is protected by Kubo's own Origin checks (**[I]**); the Soul Engine is token-gated (`agent/local_auth.py:1-30`) **[V]**; the wallet node default `http://127.0.0.1:8080` (`settings.js:31`) and any user-run Kubo on 5001 are not protected by Bucks. Severity: medium.
7. Kubo API/gateway bound to 127.0.0.1 (`kubo.js:189-190`) **[V]**. Swarm listens on 0.0.0.0/:: (`kubo.js:28,191-194`) as required.
8. Kubo supply chain: checksum fetched from same host as archive, "latest" version (see §1) — `dist.js:62-78`. Severity: medium (no signature pinning; first-run auto-download of an executable).
9. Wallet keys: stored in the chrome's `localStorage`, unencrypted (`ui/src/routes/wallet/+page.svelte:58,223,247`; acknowledged `docs/ARCHITECTURE.md` "Wallet", `ROADMAP.md` Next #1). `safeStorage` appears only in the unwired chat engine (`src/main/chat/README.md:21`). **[V]**. Severity: high for the blockchain-config target.
10. Wallet proxy: strong path validation (`proxy.js:17-36`), same-origin target enforced (`proxy.js:61-68`), no redirects, 8 MiB cap; **but** it forwards any path on the node (no allow-list of wallet routes) so the chrome can call mining/admin endpoints on a node; cf. old `ALLOWED_WALLET_PREFIXES` in `chain/Bucks-App/electron/main.js:~474-507` (commented list) **[V]**. Severity: low-medium.
11. IPC `add`: `decodeDataPayload` percent-decodes non-base64 data URLs *before* any size check (`ipc.js:48-52`) and base64 payloads up to ~683 MB ride IPC as a string; DoS-grade only. Severity: low.
12. Devices: peerId==`from` check (`devices-core.js:291`) good; `autoPin` unbounded (`devices-service.js:483-501`) — a paired (but later compromised) device can fill the disk. Severity: low-medium.

**Agent (final repo)**
13. Engine-side approval relies on the engine's own flag or the main-process `STATE_CHANGING` set: `soul.js:187` (`ev.needs_approval === true || STATE_CHANGING.has(name)`), `browser-control.js:21` (`browser_click/type/navigate`, `pane_open/close`). Python gate set: `agent/soul_engine.py:934-937` (adds only `cluster_recommend/unrecommend/pin/unpin`). Tools `ipfs_upload_text`, `dweb_publish` are exposed to the model (`soul_engine.py:464-490`, group at `:864`), registered `safe=False` (`agent/tools/registry.py:644,647`) but `Tool.safe` is never consulted by the engine (grep: only `registry.py:35,44`; engine comment at `soul_engine.py:2315-2321`) so they **run without user approval**. **[V]**. Severity: high for target (publishing is irreversible and public).
14. `ipfs_dynamic_load_tool` does `exec(code, globals(), local_scope)` on text fetched from an arbitrary CID — `agent/tools/ipfs_tools.py:229`; reachable via the legacy router `agent/engine.py:362-368` (keywords "load/inject/install" + CID) and listed in the `ipfs` tool group `registry.py:684-685`. Not in the model-visible schema list I enumerated from `soul_engine.py` (`web_search ... render_component`), and `engine.py` is not imported by `soul_engine.py` (grep), so exposure via the Soul Engine path looks closed, but it is remote-code-execution-by-CID code that ships in the packaged `agent/` and MCP server (`mcp_server.py:419` lists only upload/cat/search). **[V]** code, **[I]** reachability. Severity: critical if reachable; recommend deletion.
15. Approval label can come from the engine/model (`soul.js:183`, `:227-228`), so a prompt-injected model can describe an action misleadingly (e.g. "Open docs" for a publish). **[V]**, severity medium.
16. Approval timeout 25 s main / 30 s engine, deny on timeout (`bridge.js` `createApprovals`, `soul_engine.py:1654`) **[V]** good.
17. Soul Engine environment inherits the whole app environment (`engineEnv` spreads `process.env` — `soul-engine.js:105`) plus `<userData>/soul-engine/.env` cloud keys **[V]**: any secret in the launching shell is visible to the Python agent and its tools. Severity: low-medium.
18. File tools confined to `<userData>/soul-engine/workspace` (`soul-engine.js:112-113`); adversarial path test exists (`agent/tests/test_adversarial.py:163-199`) but is **not run in CI** (CI runs only `test_local_security.py`, `test_nexus_endpoints.py` — `.github/workflows/build.yml` "Soul Engine tests" step). **[V]**.
19. Agent's IPFS tools still target Bucks-Core infrastructure that does not exist in the final repo (see §3), so behaviour is undefined/degraded, not a security flaw per se.

**Older line (`core/`)**
20. `core/electron/ipfs-bridge.js` serves an **unauthenticated** Kubo-compatible API plus `/api/v0/bucks/*` (cluster vote, cluster pin, release announce) on `127.0.0.1:5001` (or 5006) — `ipfs-bridge.js:326-510, 556-558`; grep for `origin|Authorization|Access-Control` finds only the multipart `content-type` (`:364`). It parses JSON bodies regardless of content type, so drive-by `fetch(..., {mode:'no-cors', method:'POST', body:'{"..."}'})` from any web page can hit it. **[V]** code, **[I]** exploit path. Severity: critical (in the old line only).
21. `core/ipfs/server.js` (file-manager proxy) **deletes the `Origin`/`Referer` headers** before forwarding to Kubo (`server.js:30-32`) – explicitly defeating Kubo's CORS protection – exposes `/api/*` → cluster REST :9094 and `/kubo/*` → Kubo API :5001 (`server.js:61-71`) and calls `.listen(PORT)` **without a host**, i.e. all interfaces (`server.js` last line). `dweb-studio-renderer.js:~196` posts site publishes to `http://localhost:3939/api/add`. **[V]**. Severity: critical.
22. Secret handling: `core/ipfs/cluster-config.env` contains `CLUSTER_SECRET` (type: IPFS-Cluster shared secret) and `BOOTSTRAP`; the file itself says the secret "was published inside the install tarball on public IPFS" and must be rotated. It is gitignored (`.gitignore:52`) but present in the local `core/bucks-browser-dist.tar.gz` (listing shows `bucks-browser/ipfs/cluster-config.env` and `bucks-browser/test-identities.json`); `test-identities.json` is **tracked in git** (type: test identity keys; contents not read). `core/scripts/build-dist-tarball.sh:9-11` states a prior tarball pinned on IPFS contained live `LITAI_API_KEY`/`NGC_API_KEY` values (file `agent/.env`; values not read). **[V]**. Severity: critical (rotate, purge from IPFS pins is impossible; treat as public).
23. `core/electron/cluster-membership.js:35-36` and `ipfs-node.js:17` default `CLUSTER_SECRET` to the literal `"BUCKS_DEFAULT_CLUSTER"`; topics are derived from a SHA-256 prefix of it, so topic names are guessable; admission is by signed records and genesis ids (`cluster-membership.js:41-48`). **[V]**. Severity: medium.
24. `core/electron/cluster-updater.js:243-271` runs `execSync` on tar extraction and on `install.sh/install.ps1` from a downloaded release; guarded by an Ed25519 publisher key and checksum (`:112-124`), and fails closed if `BUCKS_RELEASE_PUBLISHER_PUBKEY` is empty (`:42,112-114`). Reasonable but shell-string interpolation of paths. **[V]**. Severity: medium.
25. dWeb index messages: sender check `data.publisher !== msg.from` only (`ipfs-node.js:1022-1028`), index unbounded, titles/descriptions rendered from untrusted peers, no moderation/signature beyond transport. **[V]**. Severity: medium.

### Inferences
- The most dangerous pattern across both lines is "loopback HTTP service without auth"; the final repo fixed it for the agent (token) but the old bridge/proxy pattern must not be ported.
- The agent publish path is the only route by which prompt injection (a web page the agent reads) could cause an irreversible, public IPFS write without a prompt.

### Gaps
- Did not audit `ui/` Svelte for XSS in rendered CIDs/filenames/cards (genui sanitisation exists in `src/main/agent/genui.js`, `a2ui.js`; not reviewed line-by-line).
- Did not verify Kubo's actual Origin-check behaviour at runtime.
- `src/main/tabs.js` navigation policy and `window.open` handling not reviewed beyond docs.

---

## 3. Agent layer: Soul Engine, providers, tool permissions; what is missing for IPFS actions with approval

### Takeaway
Provider routing, sidecar supervision, token auth, per-action approval cards and tab-control tooling are well built. IPFS actions are not: the agent's IPFS tools are the old Bucks Core ones, point at endpoints the final repo does not provide, and are not approval-gated. A proper "publish site / pin / resolve name" capability needs main-process IPFS tools (executed in Electron against `kubo.rpc`) wired through the existing approval channel.

### Cited Findings
- Providers: `offline`, `remote`, `ollama`, `soul` selected by `settings.agent.provider`; fallback to offline rules on failure (`bb/src/main/agent/bridge.js`, `docs/ARCHITECTURE.md` "Agent providers"). Offline rules turn CIDs/"ipfs" phrases into navigation only (`providers/offline.js`, **[V]** per docs; file not line-reviewed).
- Soul Engine supervision: `soul-engine.js` (802 lines): per-launch 32-byte token (`BUCKS_SOUL_TOKEN`, `soul-engine.js:108`), loopback port, health poll, restart back-off, venv install. Python gate: `agent/local_auth.py` (all paths except `/health`).
- Tool call protocol: engine emits `browser_action` SSE events; main runs browser tools on the originating tab only, approvals always required for click/type/navigate (`soul.js:178-210`; `browser-control.js:21-26`). Without `agentic:true` the tab tools answer "not enabled" (`bridge.js:229`; docs "The agent acting in a tab").
- Python tool surface visible to the model (from `soul_engine.py:~440-560`): `web_search, fetch_url, extract_links, calendar_*, list_directory, read_file, track_order, product_*, ipfs_upload_text, ipfs_cat_text, dweb_publish, dweb_search, cluster_list_*, cluster_get_my_identity, cluster_recommend/unrecommend/pin/unpin, image_search, youtube_search, weather_lookup, deep_research, render_component`. Approval-gated: browser tools, pane tools, `cluster_recommend/unrecommend/pin/unpin` only (`soul_engine.py:934-937`, gate at `:2278-2294` and `:2333-2339`).
- IPFS tools are Bucks-Core-shaped:
  - `ipfs_upload_text` uses `IPFS_API_URL` default `http://localhost:5001` (`agent/config.py:165`) via `rag/ipfs_store.py`; the final repo's embedded Kubo uses a *reserved random* API port (`kubo.js:415-436`) and `engineEnv` passes **no** `IPFS_API_URL` (`soul-engine.js:104-120`) and no `~/.bucks/ipfs.json` manifest is written (grep `ipfs.json` in `bb/src` → none). So uploads only work when a separate Kubo happens to run on 5001. **[V]**.
  - `dweb_publish` / `dweb_search` call `/api/v0/bucks/dweb/*` served only by `core/electron/ipfs-bridge.js` (`agent/tools/ipfs_tools.py:58-88,134-153`), and fall back to reading `<Electron userData>/ipfs-data/dweb-index.json` for the app id `bucks-browser` (`ipfs_tools.py:28-55`) — a file the final repo never writes. **[V]**.
  - `cluster_*` tools call the same bridge endpoints (`agent/tools/cluster_tools.py:58-62`), also nonexistent in the final repo. `ROADMAP`/`ARCHITECTURE` nonetheless say cluster votes/pins are approval-gated (they are in the engine) — but there is nothing behind them. **[V]**.
  - `ipfs_cluster_client.py` expects an IPFS-Cluster REST API on `127.0.0.1:9094` (`agent/config.py:170`, `ipfs_cluster_client.py:30-40`); no component in the final repo provides it.
- Missing for IPFS actions: (a) a main-process tool executor for `ipfs_publish_site`, `ipfs_pin`, `ipfs_unpin`, `ipfs_resolve_name`, `ipns_publish` using `kubo.rpc` (today `REMOTE_TOOLS` = tab/pane tools + documents only — `browser-control.js:26`); (b) adding these names to `STATE_CHANGING` (`browser-control.js:21`) and to the Python `STATE_CHANGING_TOOLS` (`soul_engine.py:934`) or removing the Python tools; (c) approval cards that show what will be published (file list, size, destination, target name) rather than an engine-supplied label (`soul.js:183`); (d) per-tool/per-site policy and an audit log (`docs/ROADMAP.md` Next #5 lists it as not done); (e) prompt-injection tests.
- Default provider is `offline` (`settings.js:34`) and default Soul backend `edge` embedded model (`settings.js:41`) — a first-run user has no agent actions at all until they install Python venv.

### Inferences
- Reusing the Python IPFS tools in the final repo is a dead end; it is cleaner to implement IPFS actions as *Electron-side* tools following the `create_document`/`page_to_pdf` pattern (`REMOTE_TOOLS` + `runTool` + approval), and expose the same functions to the UI slash commands.
- Approvals asked in main (not in Python) are the trustworthy layer; the Python `safe` flag is decorative.

### Gaps
- Did not read `soul_engine.py` end to end (2,593 lines); tool-schema enumeration is from grep of `"name":` entries and could miss conditionally registered tools.
- Did not test whether `ipfs_dynamic_load_tool` is reachable via MCP (`mcp_server.py` group list excludes it).

---

## 4. Test coverage and CI

### Takeaway
Final repo: broad unit coverage of pure logic, a real-Kubo integration test and Playwright e2e for IPFS browsing, devices, and agent flows. Untested: IPFS publishing (does not exist), traversal/encoding edge cases, public-fallback privacy behaviour, SPA/redirect semantics, agent prompt-injection and approval bypass for Python tools, and several Python adversarial suites are not in CI. Older line: effectively no automated IPFS tests of note.

### Cited Findings
- `npm test` = `node --test "test/unit/**/*.test.js"`; `npm run test:e2e` = Playwright-driven `node --test` (`bb/package.json:22-23`). Unit suites (lines): `ipfs/kubo.test.js` 171, `kubo.integration.test.js` 373 (skips without a Kubo binary), `dist.test.js` 419, `rpc.test.js` 184, `cid.test.js` 111, `protocol.test.js` 215, `devices/*` (core 360, service 495, ipc 74), `agent/*` (bridge 312, soul 268, soul-engine 278, browser-control 117, providers 127), `security/*`, `wallet/proxy.test.js` 115, `main/bucks-protocol.test.js` 86. Total ≈ 5.7 k test lines.
- Protocol tests (`test/unit/ipfs/protocol.test.js`): upstream URL building, redirect rewrite, error pages, 405, 503 starting page, header forwarding, 504 not-found, public-gateway use when stopped/prefer-public, handler never throws, self-redirect loop. **Not covered**: path-traversal strings, ipns names edge cases (DNSLink with unicode/punycode), CSP/headers injection, range + 206 semantics end-to-end, any assertion that no public request is made when local node is ready.
- E2E: `smoke.test.mjs` (boots app, starts Kubo, loads an `ipfs://` page — line 33), `devices.test.mjs` (two instances pairing, 298 lines), `soul.test.mjs`, `agent-browser.test.mjs`, `agent-chat.test.mjs`, `browser-features.test.mjs`, `newtab.test.mjs`.
- CI `.github/workflows/build.yml`: job `check` (ubuntu) = `npm run check`, shellcheck on installers, Soul Engine pytest of **only** `tests/test_local_security.py tests/test_nexus_endpoints.py`, then `npm test`; job `e2e` = build UI, fetch Kubo, `xvfb-run npm run test:e2e`; job macOS installer test; `build` for Linux x64, Windows x64, macOS arm64/x64; `release` on `v*` tags. Builds unsigned (header comment, `electron-builder.yml:112-120`). No CodeQL/dependency audit/SBOM/secret-scan step. **[V]**.
- Not in CI: `agent/tests/test_adversarial.py`, `test_ipfs_skills.py` (needs live Kubo on 5001, exercises the exec-based dynamic tool loader), `eval_scenarios.py`.
- No tests for: IPFS add/pin IPC validation (`ipc.js` — `test/unit/ipfs` has no `ipc.test.js`; only `devices/ipc.test.js`), settings-patch validation, `ipfs.publicGateway` sanitising, agent prompt-injection against IPFS tools, approval bypass (Python `safe` flag), large-file/streaming memory tests.
- Older line: `core/test-ui2.js`, `test-results/`, `reports/` exist at root; no organised IPFS test suite found in `electron/` for ipfs-node/bridge/cluster (not exhaustively searched). **[I]**.

### Inferences
- The e2e network paths run against a loopback node with no peers; none verifies retrieval of content published by another real node over the DHT.

### Gaps
- Did not run any test; coverage % unknown.

---

## 5. Reuse: which Bucks Core modules to port, with size/quality

### Takeaway
Port *ideas and small slices*, not files. Most of the older line is CommonJS, Helia-based, loosely coupled to the Python agent over unauthenticated HTTP, and conflicts with the final repo's Kubo-sidecar design. Worth porting: dWeb index concept (as a signed, bounded index over Kubo pubsub), cluster-membership admission model (only if a trust group feature is wanted), the Ed25519 release-manifest verification pattern, and the IPFS-Cluster compose/scripts as an *optional operator kit* once secrets are rotated. Drop the bridge, the file-manager proxy, the Helia node, dweb-studio's HTTP dependency, and `ipfs_dynamic_load_tool`.

### Cited Findings (size from `wc -l`; quality is my judgement after skim)
| Module (core/) | Lines | What it is | Quality / issues | Verdict |
|---|---|---|---|---|
| `electron/ipfs-node.js` | 1162 | In-process Helia + libp2p (tcp, ws, circuit relay, DCUtR, AutoNAT, UPnP, kad-DHT, gossipsub, mDNS, bootstrap list; fixed ports 4020/4021) `:62-183`; dWeb index, soul gossip, cluster hooks | Feature-rich NAT traversal that Kubo can reproduce by config; monolith; default public bootstrap `:128-140`; spoof check only transport-level `:1022-1028` | **Drop** (replace by Kubo config: AutoNAT, relay client, hole punching, UPnP) |
| `electron/ipfs-bridge.js` | 616 | Kubo-compatible HTTP API over Helia + `/api/v0/bucks/*` + manifest `~/.bucks/ipfs.json` | Unauthenticated, binds 5001/5006 (`:556-558`), CSRF-able, cluster write endpoints | **Drop** (security) |
| `electron/cluster-membership.js` | 354 | Invite-grown membership: signed admission records over gossipsub, genesis seeds, presence | Sound crypto pattern (`verifyEd25519`), default secret literal `:35-36`, depends on soul identity from Python agent | **Port concept** if "trust group / pinning cluster" is wanted; rewrite on Kubo pubsub with bounded state |
| `electron/cluster-updater.js` | 429 | Signed release announce over gossipsub, checksum, tarball/installer update | Fails closed without publisher key `:42,112`; uses `execSync` string interpolation `:243-271` | **Port later** (decentralised updates), rewrite with `execFile` and `electron-updater` constraints |
| `electron/device-sync.js` | 426 | Mutual attestation of same-person devices + state snapshot via CID pointers | Overlaps final `devices-service.js` (731 lines, better tested); depends on soul ids | **Drop**, optionally reuse "pinned-CID list sync" idea |
| `electron/ipfs-agent-soul.js` | 147 | Pins agent soul to IPFS, advertises every 30 s, forwards peer souls to agent | Talks to `AGENT_SERVER_URL` :8765 unauthenticated `:15-18`; soul identity is a Python-side concept | **Drop** for now (agent identity model is separate decision) |
| `electron/dweb-studio.html`/`-renderer.js` | 383 / 287 | AI "generate a site" + publish single `index.html` to IPFS Cluster, broadcast to dWeb index | Publishes through `http://localhost:3939` (`:~196`), single file only, localStorage list, no IPNS; templates fetched from `bucks://` | **Port UX only**: template picker + preview + publish flow, re-implemented over `kubo.rpc.add` (dir) + IPNS |
| `ipfs/` (README, SETUP, docker-compose.yml, setup-host.sh, join-cluster.sh, server.js, public/) | ~10 files; `public/pdfjs` vendored | 3-node IPFS-Cluster demo + Tailscale join scripts + file manager UI | Uses `ipfs/kubo:latest`, `ipfs/ipfs-cluster:latest` (unpinned), `curl | sh`-style Homebrew install (`join-cluster.sh:22`), proxy flaws (§2 #21), `cluster-config.env` holds a compromised secret | **Port selectively** as an operator-run "pinning node kit" with pinned images, per-user secret generation; **drop** `server.js` and vendored `pdfjs` |
| `agent/ipfs_cluster_client.py` | 131 | Async client: cluster `/add`, `/pins/{cid}`, `/id`, fall back to Kubo | Clean small client; useful for a pinning-service adapter | **Port** (to JS in main, or keep in Python behind approval) |
| `agent/tools/cluster_tools.py` | 116 | Agent tools over the bridge | Tied to deleted bridge | **Drop**; replace with main-process tools |
| `agent/tools/ipfs_tools.py` (also in final repo) | 253 | upload/cat/dweb/dynamic-load | `exec` of IPFS code `:229` | **Delete** `ipfs_dynamic_load_tool`; rewrite others |

### Inferences
- The one capability the older line demonstrates that the final repo lacks and the target needs is *discoverability* (dWeb index) and *durability* (cluster). Both should be rebuilt on a signed, bounded, moderation-aware design, not ported verbatim.

### Gaps
- Did not read `ipfs-node.js` beyond the swarm/dWeb sections; `crypto-utils.js` and soul registry dependencies not audited.
- The older line's working tree contains many uncommitted changes (`git status` snapshot given in the task); behaviour of uncommitted code was read from disk as-is.

---

## 6. Blockchain integration points (browser side only) and naming

### Takeaway
The browser's chain integration is a wallet proxy plus client-side signing; there is no chain-configuration platform, no name resolution, no mining control, and the wallet's REST API contract appears not to match the Go node in `chain/node`.

### Cited Findings
- Wallet UI calls REST paths `/api/address/{addr}/balance`, `/api/address/{addr}/utxos`, `POST /api/transactions/broadcast` (`bb/ui/src/routes/wallet/+page.svelte:265,278`; `bb/ui/src/lib/newtab/StatusCards.svelte:48`). Default node URL `http://127.0.0.1:8080` (`settings.js:31`) — also Kubo's default gateway port (documentation clash risk **[I]**).
- `chain/node/api/rpc.go:70-71` registers only `/` (JSON-RPC: `eth_*`, `web3_*`, `net_*`, `bucks_getChainParams`, `bucks_getMithqalBalance`, `bucks_getSoulEngineStatus`, `bucks_getWork`, `bucks_submitWork` — `rpc.go:126-203`) and `/health`. `grep -rn "/api/" chain/node --include=*.go` returns nothing. The `/api/address`, `/api/mining/*`, `/api/transactions/*` paths exist only as references in `chain/Bucks-App/electron/main.js:~492-507` (an allow-list comment) and `core/electron/bucks-node.js`, which is **deleted** in the older working tree (`git status`: ` D electron/bucks-node.js`). **[V]** for the two greps; **[I]** that no running node serves the REST paths today. Needs confirmation by the chain researcher.
- Contracts present: `ContractRegistry.sol` (register/lookup by key or name, `ContractRegistry.sol:68-134`), `SoulVerified`, `BucksTransfer`, `BucksEscrow`, `BusinessAgreement`, `CommunityTreasury`, `Fees` (`chain/contracts/contracts/**`). A grep for `ipns|dnslink|resolver|namereg` over contracts finds only incidental matches (escrow); there is **no name-to-CID registry contract**. `ContractRegistry` maps names to *contract addresses*, not content.
- Keys: generated in the chrome (`bb/ui/src/lib/bucks-crypto.ts:327-352`), saved in `localStorage` (see §2 #9).
- `bucks://` serves only `bucks://app/*` (`protocols/bucks.js:129`), so `ROADMAP` item "bucks:// name resolution via the chain" is unbuilt.
- No mining controls in the browser (FEATURE-PARITY.md "Mining controls ⏳ batch D"), no chain/network configuration UI (RPC endpoints, chain id, contract addresses) other than a single node-URL text setting.

### Inferences
- A "blockchain configuration platform" in the target sense (select network, deploy/point to contracts, register names, configure staking/pinning roles, mining) has no code in either browser repo; only the Phase 6 "chain adapter interface" plan text in `ROADMAP.md` ("Phase 6").

### Gaps
- Chain node internals and consensus are explicitly out of scope (another researcher).

---

## 7. Ranked gap list (target: end-to-end decentralised browser; every system can host and serve ipfs://; local agent layer; blockchain configuration platform)

Severity: C critical, H high, M medium, L low. Effort: S (<=3 days), M (1-3 weeks), L (>3 weeks). Evidence paths are relative to `bb/` unless prefixed `core/` or `chain/`.

| # | Gap | Evidence | Sev | Effort | Depends on |
|---|---|---|---|---|---|
| G1 | **Rotate/purge leaked secrets in the older line** (cluster secret in distributed tarball; API keys historically tarballed; tracked `test-identities.json`); stop shipping `bucks-browser-dist.tar.gz` with them | `core/ipfs/cluster-config.env` (header note), `core/bucks-browser-dist.tar.gz` listing, `core/scripts/build-dist-tarball.sh:9-11`, git-tracked `core/test-identities.json` | C | S | none (operator action) |
| G2 | **No publishing flow for sites/web apps**: only single-file/text add; no directory add, no MFS, no site manifest | `src/main/ipfs/ipc.js:124-141`, `rpc.js:196-228` (unused `wrapWithDirectory`), `ui/src/lib/ipfs/AddContent.svelte` | H | M | none |
| G3 | **Node cannot be a reliable host**: lowpower profile, no Provide/Routing config, random swarm port, no AutoNAT/relay/hole-punch/UPnP config; no inbound reachability check or status | `kubo.js:507-514, 186-203, 415-436` | H | M | G2 for value; Kubo version/docs verification |
| G4 | **No durability layer**: nothing keeps content online when the author's machine is off (no pinning-service client, no cluster, no "pin to N peers") | `docs/ROADMAP.md` Next #2; `agent/config.py:170` target absent; `core/ipfs/` kit unported | H | L | G2, G3, G11 |
| G5 | **No IPNS / naming**: no key management, publish, republish, or resolution UI; `bucks://` names unresolved; no on-chain name registry | `rpc.js` (no `name/publish`,`key/*`), `protocols/bucks.js:129`, `chain/contracts/contracts` (no name->CID contract) | H | L | G2; chain contract design |
| G6 | **Agent can publish to IPFS without approval and IPFS tools target a nonexistent backend**; Python `safe` flag unused; approval label is engine-supplied | `agent/soul_engine.py:934-937, 464-490, 2278-2339`; `agent/tools/registry.py:644-647`; `src/main/agent/providers/soul.js:183-187`; `agent/tools/ipfs_tools.py:58-88`; `soul-engine.js:104-120` | H | M | G2 (tools to call) |
| G7 | **Silent public-gateway fallback** leaks CIDs/IP; no indicator, no consent, no hash verification of public responses; `publicGateway` unvalidated | `src/main/protocols/ipfs.js:256-266`; `settings.js:14`; `kubo.js:251-255` | H | S-M | none (add setting "never use public", UI badge; verified retrieval via trustless gateway/CAR is M) |
| G8 | **Wallet keys unencrypted in localStorage**; no OS keychain; blocks any chain-config/signing platform | `ui/src/routes/wallet/+page.svelte:58,223,247`; `docs/ROADMAP.md` Next #1 | H | M | none |
| G9 | **Wallet<->node API mismatch**: wallet expects REST `/api/address/*`, `/api/transactions/*`; Go node exposes JSON-RPC; REST server (`bucks-node.js`) deleted in older line | `ui/src/routes/wallet/+page.svelte:265,278`; `chain/node/api/rpc.go:70-71,126-203`; `core` `git status` `D electron/bucks-node.js` | H | M | chain researcher confirmation |
| G10 | **No blockchain configuration platform** (network/RPC/chain-id selection, contract addresses, deploy/register, staking roles, mining control) | `settings.js:30-32` (single `nodeUrl`); `docs/FEATURE-PARITY.md` "Mining controls ⏳"; `docs/ROADMAP.md` Phase 6 | H | L | G8, G9 |
| G11 | **No pin management policy / quotas / GC control**: no `StorageMax`, no per-pin sizes, unbounded `pin-add` and `autoPin`, no unpin confirm | `kubo.js:588`; `rpc.js:281-298`; `devices-service.js:483-501` | M | M | G3 |
| G12 | **No SPA/web-app serving semantics** (`_redirects`, history-API fallback, per-site headers, CSP for hosted apps); always path gateway | `protocols/ipfs.js:33-37, 208-232` | M | M | G2; decision on subdomain-style local gateway vs. in-handler rewrite |
| G13 | **Unauth'd loopback services reachable by web pages** (no private-network blocking); Kubo user-run on 5001, wallet node default 8080 | `security/filter.js:35-43,85`; `settings.js:31`; (core) `ipfs-bridge.js:556-558`, `ipfs/server.js` | M | S-M | none |
| G14 | **Settings/IPC trust**: no sender-frame check on IPFS/settings/agent IPC; settings patch controls spawn paths and gateways | `ipc.js:91-101`; `settings.js:116-117`; `soul-engine.js:64-80` | M | S | none |
| G15 | **`ipfs_dynamic_load_tool` exec of IPFS content** ships in packaged agent | `agent/tools/ipfs_tools.py:229`; `agent/engine.py:362-368`; `agent/tools/registry.py:646,684` | M (C if reachable) | S | none (delete) |
| G16 | **No content moderation / abuse controls** for hosted or discovered content (blocklists, denylist, reporting); dWeb index unbounded and unsigned | `core/electron/ipfs-node.js:1022-1050`; none in `bb/` | M | M | G4, discovery design |
| G17 | **Discovery/search of published sites absent** in final repo (dWeb index, feed) | `docs/FEATURE-PARITY.md` "dWeb: publish a site, search the index ⏳" | M | M-L | G2, G5, G16 |
| G18 | **Devices: no E2E encryption of shares, no pairing code, no relay**; autoPin unbounded | `docs/ROADMAP.md` "In progress" 1-3; `devices-service.js:483-501` | M | M | G3 |
| G19 | **Kubo supply chain**: unpinned "latest" download, same-origin checksum, no signature | `ipfs/dist.js:18-22,62-78`; `scripts/fetch-kubo.mjs:109-118` | M | S | none (pin version + embedded hashes) |
| G20 | **Release hygiene**: unsigned builds, no auto-update for packaged apps, no secret/dependency scanning in CI | `electron-builder.yml:112-120`; `.github/workflows/build.yml` header | M | M | signing certs |
| G21 | **Test gaps**: no tests for IPFS IPC validation, traversal/encoding, public-fallback privacy, SPA, agent injection/approval; Python adversarial + IPFS-skill tests not in CI; no multi-node retrieval test | `test/unit/ipfs/` (no `ipc.test.js`); `build.yml` pytest step | M | M | G2 |
| G22 | **Repo-hygiene in older line**: `electron/renderer.js.bak`, screenshots, `test-identities.json`, large tarball, dist tar at repo root; dirty tree on `chore/production-cleanup` | `git status` snapshot (task context); `core/bucks-browser-dist.tar.gz` | L | S | none |
| G23 | **Agent default is `offline`; Soul Engine needs Python venv install**; no packaged runtime | `settings.js:34,41`; `electron-builder.yml` (agent source only) | L | M | none |
| G24 | **Chat engine not wired**; Feed/Messages absent | `src/main/chat/README.md`; `docs/FEATURE-PARITY.md` | L (for target) | L | G3 |

### Suggested order (inference)
G1 -> G15, G7, G14, G19 (small, safety) -> G2 + G3 (core hosting) -> G6 (agent tools in main with approval) -> G12, G11 -> G5/G4 (naming + durability) -> G8, G9, G10 (chain platform) -> G16/G17/G18.

### Gaps
- Effort figures are my estimates, not measured.
- Severity for G3/G12 depends on unverified Kubo defaults.
