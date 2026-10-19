# IPFS network, availability and incentive layer for "every browser is a host" (state as of Oct 2026)

Research depth note: about 16 tool calls; the Kubo config is read from master docs (not a pinned tag). Items not backed by a fetched source are placed in Inferences or Gaps and labelled as such.

## 1. Kubo version state and recommended desktop-node configuration

### Takeaway
Kubo is at v0.43.1 (15 Sep 2026) with sweeping provider, AutoConf, AutoTLS, relay v2 and hole punching all on by default. The project's maintainer organisation (Interplanetary Shipyard) is reported to cease work on 30 Sep 2026, so "who maintains Kubo/Helia/Boxo after Q4 2026" is a real dependency risk for a product built on them. A desktop node should default to Routing.Type=auto (it self-selects client vs server by reachability), keep the sweeping provider, and use a narrow Provide.Strategy.

### Cited Findings
**Versions and dates**
- Latest stable is Kubo v0.43.1, released 15 Sep 2026 (bugfix). Its release notes call v0.43 "the last Kubo by the Shipyard". — [Kubo releases](https://github.com/ipfs/kubo/releases)
- v0.43.1: an empty `Bootstrap` list now stops all bootstrap dialing, including saved backup peers; experimental `flatfs-pebbleds` profile (new repos only); gateways send `Ipfs-Uri` (IPIP-548) instead of deprecated `X-Ipfs-Path`; telemetry off by default. — [Kubo releases](https://github.com/ipfs/kubo/releases)
- v0.43.0 (3 Aug 2026): `ipfs://`/`ipns://` URIs accepted wherever a path or CID is; one-time log notice on carrier-grade NAT detection; AutoTLS checks the registration broker's health before issuing certs; IPNS/DNSLink caching follows record TTL; delegated routers can return browser-dialable addresses; daemon refuses to start if `Ipns.RecordLifetime` < `Ipns.RepublishPeriod`. — [Kubo releases](https://github.com/ipfs/kubo/releases)
- v0.42.0 (8 Jun 2026): `ipfs provide once` and `--local-only` partial CAR export/import; `Provide.DHT.Interval=0` no longer disables providing (explicit `Provide.Enabled` required); fixed pin operations blocking during reprovide cycles; bounded shutdown (`Internal.ShutdownTimeout`) and `ipfs diag healthy`. — [Kubo releases](https://github.com/ipfs/kubo/releases)
- v0.41.0 (23 Apr 2026): provider keystore moved to its own datastore; new `Provide.Strategy` modifiers `+unique` and `+entities` to cut provider traffic for large overlapping pin sets; `ipfs cid inspect`, built-in `ipfs update`; Go 1.26 build. — [Kubo releases](https://github.com/ipfs/kubo/releases)
- v0.40.0 shipped about 27 Feb 2026 (IPIP-499 CID Profiles, IPIP-523/524); v0.40.1 (27 Feb 2026) fixed a Windows crash by downgrading Go 1.26 to 1.25. — [Kubo releases](https://github.com/ipfs/kubo/releases); [Discuss search snippet, 0.40 announcement](https://discuss.ipfs.tech/tag/kubo/100)
- Sweeping provider (`Provide.DHT.SweepEnabled`) became default in v0.39 (noted indirectly on the releases page). — [Kubo releases](https://github.com/ipfs/kubo/releases)
- Security: an openSUSE advisory (Apr 2026) fixed 5 Kubo vulnerabilities including CVE-2026-35480 (details not fetched; keep the Electron-embedded Kubo patched). — search result via [SUSE package hub listing](https://packagehub.suse.com/packages/kubo/0_35_0-bp156_2_6_1/) (weak source, snippet only)

**Defaults from docs/config.md (master)**
- `Routing.Type` default `auto` = Amino DHT + delegated HTTP routers, becomes a DHT server only when publicly reachable. Others: `autoclient`, `dht`, `dhtclient`, `dhtserver`, `none`; `delegated`/`custom` experimental. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `Routing.AcceleratedDHTClient` default `false`; crawls the full DHT hourly, higher memory/CPU/bandwidth. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `Routing.DelegatedRouters` default `["auto"]` (Delegated Routing V1 HTTP API; "auto" resolved via AutoConf). — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `AutoConf.Enabled` true, URL `https://conf.ipfs-mainnet.org/autoconf.json`, refresh 24h; disabling it while "auto" values exist makes the daemon fail to start. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `AutoTLS.Enabled` true ("requires a publicly reachable node"), `AutoWSS` true, domain `libp2p.direct`, registration `https://registration.libp2p.direct`, Let's Encrypt CA, `RegistrationDelay` 1h. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `AutoNAT.ServiceMode` default `enabled` (`legacy-v1` deprecated); throttle 30 global/3 per peer per minute. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `Provide.Strategy` default `all`; options `all`, `pinned`, `roots`, `mfs`, `pinned+mfs`; modifiers `+unique`, `+entities`. `Provide.DHT.Interval` 22h (about half of the Amino record validity), `Provide.DHT.MaxWorkers` 16. `Reprovider.*` removed in favour of `Provide.*`. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `Swarm.ConnMgr`: basic, LowWater 32, HighWater 96, GracePeriod 20s. `Swarm.ResourceMgr` enabled; MaxMemory and MaxFileDescriptors default to half of system capacity. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `Swarm.RelayClient.Enabled` true; `Swarm.EnableHolePunching` true (needs RelayClient); `Swarm.DisableNatPortMap` false (UPnP/NAT-PMP on). Transports TCP, WebSocket, QUIC, Relay, WebTransport, WebRTCDirect all enabled by default; Noise and TLS security; Yamux only. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `Swarm.RelayService` (enabled by default) limits: 2m per circuit, 128 KB data, 128 reservations, 16 circuits, 8 reservations per IP. Relays are only for signalling/short-lived paths, not data. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `Datastore.StorageMax` 10GB, GC watermark 90%, GC period 1h; default spec `flatfs-levelds`; pebble variants experimental and fixed at repo creation. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `Gateway.NoFetch` default false (true = serve only local content); `Gateway.DeserializedResponses` default true (false = trustless-gateway-only). — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `Peering.Peers` default empty; peered nodes are protected from ConnMgr, connected at start, reconnected with ~5s-10min backoff. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- `Pubsub.Enabled` default false, router gossipsub; `Ipns.UsePubsub` disabled (experimental); `Ipns.RepublishPeriod` 4h, `RecordLifetime` 48h. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- Import defaults: CIDv0 unless set, chunker size-262144, sha2-256; `Import.FastProvideRoot` true. `server` profile disables mDNS/UPnP and filters private ranges (not appropriate for desktop). — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)

**DHT spec parameters**
- k = 20 (bucket size, replication, lookup return); provider records discarded after 48h by servers; clients should republish every 22h; provider multiaddrs kept 24h; clients (NAT'd, intermittent, limited) must not advertise the DHT protocol and are not put in routing tables, but can still provide. α=10, β=3; IPNS quorum 16 of 20; max 3 nodes per IP group globally. — [IPFS Kad-DHT spec](https://specs.ipfs.tech/routing/kad-dht/)

**Org/maintenance risk**
- Cryptobriefing (25 Aug 2026): Protocol Labs not renewing Shipyard's funding; Shipyard's IPFS work ends 30 Sep 2026; Kubo, Helia, Boxo and Rainbow described as left without dedicated maintainers; PL takes back ipfs.io / dweb.link operations and moves to smaller individual maintainer grants; names no successor. — [Cryptobriefing](https://cryptobriefing.com/shipyard-ipfs-protocol-labs-funding-ends/); also [Cointelegraph](https://cointelegraph.com/news/shipyard-winds-down-ipfs-protocol-labs-funding). Secondary news coverage only; I did not locate Shipyard's own post.
- A byteiota piece also claims Infura shut its IPFS service on 15 Aug 2026 and Cloudflare closed cloudflare-ipfs.com in Aug 2024; both uncorroborated and Cloudflare docs still describe the gateway. Treat as unverified. — [byteiota](https://byteiota.com/ipfs-shipyard-shuts-down-what-developers-must-do-now/)

### Inferences
- Recommended desktop profile (my synthesis, not a published recommendation): `Routing.Type=auto` (not `dhtserver`; a home laptop will mostly be a client), leave AcceleratedDHTClient off (hourly full-DHT crawl is a poor fit for laptops/battery; only worthwhile for bulk providers), keep sweeping provider, set `Provide.Strategy=pinned+mfs` (optionally `+unique`) so cached/visited-but-unpinned blocks are not announced, raise `Swarm.ConnMgr` only if swarm quality demands it (32/96 is conservative; fine for desktops), keep resource manager defaults, set `Datastore.StorageMax` to the user's quota and enable GC for the cache area, `Gateway.NoFetch=true` on any local gateway that must not become an open fetch-proxy for other origins, leave pubsub off unless needed.
- Because Kubo is slowing to community maintenance, pin to a vetted version, keep the embedding thin (use HTTP RPC/config surface, avoid forks), and plan for Helia/js for in-renderer use.
- Delegated routing v0.43 returning "browser-dialable addresses" is directly relevant to an Electron/Chromium host that wants to be reachable by browser peers.

### Gaps
- Exact AutoNAT v2 behaviour in Kubo (what changed vs v1) was not confirmed from a primary source in this pass; config only shows a `ServiceMode` knob.
- `Gateway.PublicGateways` and `lowpower`/`announce-off` profile contents were not in fetched text (last ~10k chars of config.md not read).
- Release notes for v0.38/v0.39/v0.40.0 were not read in full; sweeping-provider change details are secondhand.
- Bandwidth defaults (no cap by default) not verified.

## 2. Availability: why content disappears, pinning, Cluster, services, measured data

### Takeaway
Provider records live 48h and must be republished every ~22h by an online node; anything not pinned by at least one online, reachable provider disappears. Measured DHT lookups are fast (~0.3s average) but DHT servers churn heavily (about 60% online at most 1.5h in ProbeLab's talk), so a laptop fleet needs explicit replication and a stable anchor tier.

### Cited Findings
- Provider records are discarded by servers after 48h; republish interval 22h; k=20 replicas. — [IPFS Kad-DHT spec](https://specs.ipfs.tech/routing/kad-dht/)
- Churn: about 60% of DHT server peers stay online 1.5h or less (80% under 3h); ProbeLab classes ~14% of nodes as always-on, ~85% as "dangling"; comparable to early BitTorrent. Dated talk (Web3 Summit; year not confirmed). — [ProbeLab talk](https://probelab.io/talks/measuring-the-web30-stack/)
- Provider-record liveness study (ProbeLab + BSC, 2022): roughly 15 of the 20 record holders still serve records after 35+ hours; about 12 when Hydra boosters are excluded. Old (2022). — [ProbeLab RFM17 talk](https://probelab.io/talks/ipfs-provider-record-liveness-final-results/); [RFM17 write-up](https://github.com/probe-lab/network-measurements/blob/main/results/rfm17-provider-record-liveness.md)
- 2026 performance (ProbeLab weekly digests): DHT lookup latency averaged just over 0.3s (Wk 18 and Wk 29 2026); publish time under 1s with Kubo v0.39+ versus about 14s averages earlier; DHT server IPs steady at 23k-25k; ~400k client nodes seen/week (peak 525k at Wk 18); Bitswap 104M-120M+ unique CIDs/month; IPNI (cid.contact) over 198M requests/day, over 99% uptime, double mid-2025. — [ProbeLab Wk 29 2026](https://discuss.ipfs.tech/t/probelab-s-notable-ipfs-performance-results-week-29-2026/20276); [Wk 18 2026](https://discuss.ipfs.tech/t/probelabs-notable-ipfs-performance-results-week-18-2026/20107)
- Retrieval: service-worker-gateway TTFB for cached content trending down; uncached shows spikes for users routed via Europe/US-East; no numeric TTFB given in the digest. — [ProbeLab Wk 29 2026](https://discuss.ipfs.tech/t/probelab-s-notable-ipfs-performance-results-week-29-2026/20276)
- Pinning Service API: vendor-agnostic OpenAPI spec; `requestid` per pin; Kubo supports it natively (`ipfs pin remote`); conformance suite exists; Pinata implements it at `api.pinata.cloud/psa`. — [spec repo](https://github.com/ipfs/pinning-services-api-specs); [IPFS docs](https://docs.ipfs.tech/how-to/work-with-pinning-services/); [Pinata docs](https://docs.pinata.cloud/api-reference/pinning-service-api)
- Storacha (ex web3.storage) uses UCAN auth and its own client stack; no evidence found that it exposes the Pinning Service API. Pricing page (undated): 5GB free, then roughly $0.15/GB-month dropping to $0.03/GB at volume. — [Storacha docs](https://docs.storacha.network/); [web3.storage pricing](https://Web3.Storage/pricing/) (vendor claims, possibly stale)
- Pinata: third-party claim of $0.035/GB-month and 1GB free; unverified against vendor site. — [BlockEden](https://blockeden.xyz/blog/2026/01/11/pinata-8-8-million-revenue-ipfs-storage-web3-infrastructure/) (secondary)
- IPFS Cluster: README describes CRDT (eventually consistent) and Raft modes, a global pinset, `ipfs-cluster-follow` for follower peers; allocator uses min/max replication factor and informer/metrics (tags like a datacenter label usable with `allocate_by`). Priority peers are best effort. Sourced from secondary/community material, not the official docs pages. — [EPFL slides](https://www.epfl.ch/labs/dedis/wp-content/uploads/2020/01/presentation-2019-2-Guillaume-Michel-Speeding-up-the-Inter-Planetary-File-System.pdf); [forum thread](https://discuss.ipfs.tech/t/private-cluster-with-selective-replication/14840); [ipfs-cluster README](https://github.com/beemesh/ipfs-cluster)

### Inferences
- Realistic laptop replication: if a laptop is up ~8-12h/day and records are republished only while online, a replication factor of 3 laptops gives low per-minute availability for any given block unless the nodes' schedules are uncorrelated; I did not find a measured study for laptop fleets, so treat any specific number as a modelling assumption (e.g. P(at least one of N up) = 1 - (1-u)^N with u≈0.3-0.5 gives ~0.66-0.88 at N=3, ~0.97-1.0 at N=8, assuming independence, which fails for same-timezone users).
- Mitigation: keep at least one always-on anchor (project-run Kubo/Cluster peer or a paid pinning service such as Pinata/Storacha) as availability floor; use the laptop pool for locality, bandwidth offload and cache, not durability.
- A CRDT Cluster with a small trusted peer set plus many follower peers is the best fit for "many laptops" (followers do not participate in consensus and just receive pinset); but I could not confirm follower semantics from official docs this pass.
- Records for client-mode nodes: because clients are not in routing tables, a NAT'd laptop must still publish provider records to DHT servers (allowed) or rely on IPNI/delegated routing, and must be dialable (relay/hole punch) at retrieval time.

### Gaps
- Official ipfscluster.io pages (CRDT guide, collaborative clusters, allocation tags) failed to fetch; scale limits of CRDT clusters unverified.
- No measured provider-record churn or lookup success rate figure for 2026 (ProbeLab publishes latency means, not success ratios, in the digests I saw).
- No measured retrieval success/latency for content hosted only on residential nodes.
- Pinata and Storacha current prices are not confirmed from first-party pages.

## 3. NAT, reachability and transports for home users

### Takeaway
Roughly 70% of hole-punch attempts succeed in a large measurement, but only conditionally on first getting a relay reservation and address discovery; symmetric NAT and CGNAT are the weak spots. Plan for "mostly outbound-capable, partly reachable" hosts.

### Cited Findings
- Punchr campaign: over 4.4M traversal attempts from 85,000+ networks in 167 countries; hole-punch stage succeeds ~70% (±7.1%) conditional on prerequisites; TCP and QUIC statistically similar (~70%); 97.6% of successes on the first attempt; independent of relay characteristics. Published as arXiv 2510.27500 and an IMC '26 paper. — [arXiv 2510.27500](https://arxiv.org/pdf/2510.27500); [ProbeLab IMC '26 page](https://probelab.io/publications/large-scale-measurement-of-nat-traversal-for-the-decentralized-web-a-case-study-of-dcutr-in-ipfs/)
- ProbeLab follow-up: port-restricted cone NAT 82.9% success; symmetric NAT about 40% (small sample, 536 peers vs 3,669 cone); about 36% of DCUtR-advertising NAT'd peers never secure a relay reservation. — [ProbeLab blog](https://probelab.io/blog/can-libp2p-punch-through-nats/)
- Kubo detects and logs CGNAT since v0.43.0; UPnP/NAT-PMP port mapping on by default. — [Kubo releases](https://github.com/ipfs/kubo/releases); [config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- Browsers cannot open raw TCP and need CA-signed certs for secure contexts, which is why AutoTLS (`*.libp2p.direct`), WebTransport and WebRTC-direct exist; Helia can fall back to trustless HTTP gateways. — [IPFS blog on verified-fetch](https://blog.ipfs.tech/verified-fetch/); [Helia/FOSDEM 2026 slides](https://fosdem.org/2026/events/attachments/TRQ9LV-decentralized-to-doorsteps/slides/267235/decentral_g3k9ges.pdf)

### Inferences
- A desktop host should be treated as DHT client plus best-effort inbound; AutoTLS only helps nodes with a publicly reachable address (per docs), so most home hosts will not obtain WSS certs and will serve via relay/DCUtR or through a project-run gateway/relay edge.
- Because circuit relays are limited to ~2 min/128KB by default, bulk transfer to a NAT'd host depends on successful hole punch or a project-operated relay with raised limits.

### Gaps
- AutoNAT v2 rollout stats and share of home nodes that are publicly dialable were not found.
- WebRTC-direct/WebTransport real-world success rates not found.

## 4. Design options for "every browser is a host"

### Takeaway
Option analysis is mostly synthesis; sources support the building blocks (pinning API, Cluster, Helia verified-fetch, trustless gateways, provide strategies) but I found no deployed precedent of a browser vendor running a community pinning pool in 2026. Brave dropped its bundled node in 2024 for low usage, a cautionary data point.

### Cited Findings
- Brave deprecated local IPFS node support on 22 Aug 2024 (v1.69.153): under 0.1% of users used it, maintenance cost too high; kept ipfs:// gateway redirect. — [Brave](https://brave.com/ipfs-support/); [IPFS migration guide](https://blog.ipfs.tech/2024-brave-migration-guide/)
- Opera shipped ipfs:// handlers redirecting to a gateway (Android 2020, desktop 2021); no newer info found. — [IPFS blog](https://blog.ipfs.tech/2020-03-30-ipfs-in-opera-for-android/)
- `@helia/verified-fetch` and the service-worker gateway verify blocks against CIDs in the browser and can fetch from peers or from verifiable HTTP sources; FOSDEM 2026 slides anticipate ipfs.io gateway experiments pushing traffic to p2p and expect some gateway rate limiting in late 2026 (forward-looking, unconfirmed). — [IPFS blog](https://blog.ipfs.tech/verified-fetch/); [FOSDEM 2026 slides](https://fosdem.org/2026/events/attachments/TRQ9LV-decentralized-to-doorsteps/slides/267235/decentral_g3k9ges.pdf)
- `Provide.Strategy` options (`pinned`, `roots`, `mfs`, `+unique`, `+entities`) and `Gateway.NoFetch` give the knobs for "serve only what I chose to host". `ipfs provide once` and `--local-only` CAR export (v0.42) help targeted announcements. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md); [releases](https://github.com/ipfs/kubo/releases)

### Inferences (design menu; none is a measured result)
1. Opt-in cache-pinning of visited content: Visited blocks land in the blockstore anyway; promote to a bounded "cache" pin set with LRU eviction; announce only roots (`Provide.Strategy=roots` or `pinned`). Cheap, naturally popular-content-biased, but replication correlates with popularity (helps hot content, not the long tail).
2. Quota-limited community pool via IPFS Cluster follower peers: trusted core peers hold the CRDT, laptops follow with a disk quota; allocation by tags (region, uptime class). Adds an operator and a trust root.
3. Reciprocal pin swaps / friends and own-devices: low-trust, easy (Peering.Peers + pin remote or Cluster private); good for personal availability; needs scheduling to avoid correlated downtime.
4. On-chain registry coordination: registry records (CID, desired replicas, host attestations); hosts self-select. Verification of actual storage is the hard part (see section 6).
5. Retrieval path: serve over Bitswap and also as a trustless HTTP gateway (`application/vnd.ipld.car`, raw blocks) so non-p2p clients can use any host as a verifiable source; verification by CID makes untrusted hosts safe for integrity (not for availability).

### Gaps
- No evidence found of production "every desktop as pinning host" deployments in 2026 to benchmark participation rates.
- IPIP-337 / trustless gateway spec text was not fetched this pass (cite specs.ipfs.tech/http-gateways/trustless-gateway when writing).

## 5. Abuse, legal and privacy

### Takeaway
IPFS has a working denylist stack (Bad Bits, compact denylist format, NOpfs plugin in Kubo since v0.21) and gateway operators handle DMCA by blocking at the gateway; but a node that pins arbitrary content is the party holding it, so default posture should be curated or opt-in-by-publisher, not "pin anything".

### Cited Findings
- Compact denylist format (IPIP-383) and NOpfs: Kubo plugin avoids downloading blocked content; first stable support Kubo v0.21.0; no denylists enabled by default; files in `denylists` dir under config path; entries can be double-hashed, tagged; Kubo watches for appended lines; non-append changes need restart; Kubo docs suggest allowlist via `Gateway.NoFetch=true` for gateways serving only known content. — [IPFS blog 2023 content blocking](https://blog.ipfs.tech/2023-content-blocking-for-the-ipfs-stack/); [compact denylist spec](https://specs.ipfs.tech/compact-denylist-format); [NOpfs forum](https://discuss.ipfs.tech/t/nopfs-a-content-blocking-plugin-for-kubo-ipfs/16654); [Kubo content-blocking doc mirror](https://gitcode.com/GitHub_Trending/ku/kubo/blob/master/docs/content-blocking.md)
- Original Bad Bits list was for gateways/Nginx; content on it remained reachable via Bitswap, motivating the Kubo-level blocking. Community mirror denyli.st is append-only. — [IPFS blog 2023](https://blog.ipfs.tech/2023-content-blocking-for-the-ipfs-stack/); [forum on double hashing](https://discuss.ipfs.tech/t/double-hashed-entries-in-denylists/17199)
- ipfs.io / dweb.link block abusive content using the Bad Bits denylist; abuse via web form or abuse@ipfs.io. — [IPFS public utilities](https://docs.ipfs.tech/concepts/public-utilities/)
- Cloudflare: states it is not a hosting provider; on abuse reports it may disable access through its service to specific content, not remove it from the network; it has disabled access to reported pirated content on its gateway (2023). — [Cloudflare terms](https://www.cloudflare.com/distributed-web-gateway-terms/); [TorrentFreak](https://torrentfreak.com/cloudflare-disables-access-to-pirated-content-on-its-ipfs-gateway-230324/); [Cloudflare safe mode](https://blog.cloudflare.com/cloudflare-ipfs-safe-mode)
- Provider records carry host multiaddrs (with IPs) for 24h on DHT servers, and k=20 servers per CID store them; DHT servers are limited to 3 per IP group. — [Kad-DHT spec](https://specs.ipfs.tech/routing/kad-dht/)

### Inferences
- Privacy: any host that announces a CID exposes its IP to whoever looks up that CID; relayed addresses (circuit) hide the IP but cost performance. Private networks with swarm keys (libp2p PSK, supported in Kubo; not verified in this pass) give an isolated swarm but cut off public-DHT discoverability; they suit a "friends/devices" tier only.
- Liability/DMCA jurisdictional analysis was not researched from legal sources; recommend counsel review. Practical controls: ship the Bad Bits / compact denylist enabled by default in the embedded Kubo, restrict hosting to user-chosen CIDs or registry-curated sets, keep an abuse contact and takedown path for the project's own gateway.
- Safe Browsing-style URL reputation applies at the browser layer (not IPFS-native); no IPFS-specific equivalent was found.

### Gaps
- No legal-source research (DMCA §512 treatment of pinning nodes, EU DSA/hosting provider status).
- Brave/Opera handling of takedowns: not found (Brave removed the node entirely).
- Swarm-key behaviour and current private-network tooling not verified.

## 6. Incentive layers and on-chain verifiability

### Takeaway
Only Filecoin (PDP + Filecoin Onchain Cloud, with Storacha Forge on top) offers a production, cryptographically verifiable proof path that is compatible with IPFS CIDs; most others are small, paused (Codex/Logos Storage) or not IPFS-native. Cheap on-chain checks prove possession of data at points in time, not retrievability or latency.

### Cited Findings
- Filecoin PDP (Proof of Data Possession) live on Filecoin mainnet since May 2025; lets providers prove they hold files that can be served without unsealing; proofs checked via smart contracts; payments via Filecoin Pay depend on proofs. — [Filecoin blog](https://filecoin.io/blog/introducing-proof-of-data-possession-pdp-verifiable-hot-storage-on-filecoin); [Filecoin in 2025](https://www.filecoin.io/blog/filecoin-in-2025-year-in-review)
- Filecoin Onchain Cloud announced Nov 2025 with mainnet planned Jan 2026 (I could not confirm launch occurred); Storacha Forge positioned as IPFS-compatible warm storage with PDP proofs. — [BlockEden](https://blockeden.xyz/blog/2025/11/25/filecoin-onchain-cloud-enters-the-decentralized-infrastructure-race/); [Filecoin/Storacha blog](https://filecoin.io/blog/filecoin-and-storacha-spicing-up-decentralized-hot-storage-like-never-before)
- Filecoin Foundation claimed (Mar 2026) over 25 EiB active data, via a promotional secondary source; verify. — [KuCoin blog](https://www.kucoin.com/blog/bd-ai-storage-demand-hits-crypto-why-filecoin-and-storj-are-surging-as-us-equities-rally)
- Codex is now "Logos Storage"; team paused its testnet to redesign protocol parts; mainnet targeted for 2025 slipped. Design: node collateral staking against storage contracts. — [LinkedIn Logos Storage](https://www.linkedin.com/company/codexstorage) (date not shown)
- Storj and Sia prices (about $4/TB + $7/TB egress and ~$2/TB) come from a comparison site (vendor/third-party claims). Academic note: Sia and Arweave are very small networks (2025). — [enterno.io](https://enterno.io/s/alternatives-storj); [TMA 2025 paper](https://tma.ifip.org/2025/wp-content/uploads/sites/14/2025/06/tma2025_paper16.pdf)

### Inferences
- Cheaply verifiable on-chain: Merkle-based possession challenges (PDP-style) at intervals, hash-chain "I hold CID X" attestations, and stake/slash on missed proofs. Not cheaply verifiable: actual retrievability to a given user, latency, bandwidth served, and uptime between challenges; these need off-chain probing/oracles or optimistic fraud proofs and are gameable (Sybil hosts proxying to one copy, "generation attacks").
- For a custom token tied to the project's chain: reward proven possession (PDP-like), cap rewards per identity/IP/ASN, require stake, and pay for verified serving via signed receipts from random auditors; expect to rely on a bootstrap authority at first. Reusing Filecoin PDP/Filecoin Pay for the durable tier and using the custom token only for the laptop "cache" tier is a lower-risk split.
- No evidence found of any 2026 incentive network designed for intermittently online consumer laptops with working, audited economics.

### Gaps
- Arweave, Crust, Akash, Swarm status in 2026: not found in this pass.
- Confirmation that Filecoin Onchain Cloud mainnet launched; Storacha Forge pricing.
- Cost of on-chain PDP proof per challenge (gas) not found.

## 7. Security: integrity, DoS, eclipse and Sybil

### Takeaway
Content integrity is solved by CID verification (browsers can verify via Helia verified-fetch); the open risks are availability attacks (eclipse/Sybil on DHT keyspace regions, resource exhaustion on a host) and Sybil attacks on any reputation or token layer.

### Cited Findings
- CID verification client-side: verified-fetch and the service-worker gateway check blocks against CIDs before assembling. — [IPFS blog](https://blog.ipfs.tech/verified-fetch/)
- DHT spec mitigations: max 3 nodes per IP group, 2 per bucket; lookup β=3 closest reachable peers; IPNS quorum 16/20. — [Kad-DHT spec](https://specs.ipfs.tech/routing/kad-dht/)
- ProbeLab monitors keyspace density; in Wk 29 2026 some depth-6 regions crossed a risk threshold, attributed to several depth-10 prefixes each modestly above average; no single depth-10 prefix above ~20 peers. — [ProbeLab Wk 29 2026](https://discuss.ipfs.tech/t/probelab-s-notable-ipfs-performance-results-week-29-2026/20276)
- Kubo resource manager is on by default with half-of-system memory/FD limits; relay service has per-IP/ASN reservation caps. — [Kubo config.md](https://raw.githubusercontent.com/ipfs/kubo/master/docs/config.md)
- Kubo security advisories in 2026 (e.g., CVE-2026-35480; details unread). — [SUSE package hub](https://packagehub.suse.com/packages/kubo/0_35_0-bp156_2_6_1/)

### Inferences
- Embedded hosts should: disable `RelayService` on laptops (default enabled would let strangers burn bandwidth; actually it is only active when publicly reachable, per libp2p behaviour I did not verify here), cap Bitswap server concurrency/bandwidth, rate-limit gateway endpoints, and avoid exposing the RPC API beyond localhost.
- Sybil resistance for reputation: tie identity to stake, proof-of-possession over random challenges, and diversity constraints (IP/ASN), since peer IDs are free.

### Gaps
- No 2026 measurement of eclipse attacks or Bitswap amplification found; no first-party Kubo security-advisory text read.
