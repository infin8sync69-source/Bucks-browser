# Hosting websites and web apps natively on IPFS (ipfs:// and ipns://) as of October 2026

Research date: 2026-10-19. Method note: ~20 searches/fetches. Several pages fetched via a summarizing tool, so exact wording should be re-checked against the primary page before quoting. Items I could not source are in Gaps, not in findings.

## 0. Ecosystem-health context (most important new fact for October 2026)

### Takeaway
Shipyard (the team that maintained Kubo, Boxo, Helia, Rainbow, Someguy, IPFS Companion, Service Worker Gateway) ended all IPFS work on 2026-09-30 after Protocol Labs declined to renew funding; as of early/mid October 2026 there is no confirmed successor maintainer set, and the public gateways and routing infrastructure are being wound down or rate-limited. A browser that embeds Kubo must plan for self-maintenance/pinning of versions.

### Cited Findings
- Shipyard announced on 2026-08-24 that its "final day of our IPFS related work will be September 30, 2026"; funding not renewed after about 2.5 years. Ends engineering, maintenance, infrastructure ops, spec/standards work and contributions to go-libp2p/js-libp2p — [Shipyard: The end of IPFS at Shipyard](https://ipshipyard.com/blog/2026-the-end-of-ipfs-at-shipyard/)
- Projects losing dedicated maintainers: Kubo, Helia, Boxo, Rainbow, IPFS Desktop, IPFS Companion, Someguy, Service Worker Gateway, IPFS Check, others. Infrastructure: ipfs.io, dweb.link, check.ipfs.network, delegated-ipfs.dev, bootstrap nodes, collaborative cluster; Protocol Labs owns the domains and decides their future. The post names no successors — [Shipyard post](https://ipshipyard.com/blog/2026-the-end-of-ipfs-at-shipyard/)
- Kubo v0.43 changelog: "last Kubo release with new features from the Shipyard team"; after 2026-09-30 "no one at Shipyard maintains Kubo"; no successor named — [Kubo v0.43 changelog](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.43.md)
- The ipfs/kubo GitHub page reportedly now says there is no dedicated maintainer (via search summary, not directly verified) — [ipfs/kubo](https://github.com/ipfs/kubo)
- IPFS blog (2026-08-25): ipfs.io and dweb.link are not fully shut down; browser users are redirected to the service-worker gateway at inbrowser.link; rate limiting of hotlinked/backend traffic has started and "will be increasing"; recommended migration is @helia/verified-fetch or the Drop-In Service Worker for apps, self-hosted Rainbow/Someguy/Kubo for backends, paid x402/MPP providers (Pinata, Filebase, Lighthouse). delegated-ipfs.dev and trustless-gateway.link are not addressed — [IPFS Blog: beyond sponsored gateways](https://blog.ipfs.tech/2026-08-beyond-sponsored-gateways/)
- Protocol Labs direction (per press summary of a Molly Mackinlay statement, secondary): "lighter-weight stewardship", IPFS Foundation grants to individual maintainers, focus on specs, conformance tests, implementation diversity — [Cointelegraph](https://cointelegraph.com/news/shipyard-winds-down-ipfs-protocol-labs-funding) (secondary; the IPFS blog above is the primary)
- Service Worker Gateway repo: maintenance now by two individuals (nymd, byo) on behalf of the IPFS Foundation — [ipfs/service-worker-gateway](https://github.com/ipfs/service-worker-gateway)
- Community forum, Aug-Oct 2026: no official answers on security-report triage, releases, forks; reports (Oct 4-6) that dist.ipfs.tech, ipfscluster.io, trustless-gateway.link were down and the IPFS Matrix space stopped accepting users; an unverified single-user claim (Oct 10) that new releases since Sept 30 came from new maintainers linked to IPNI/Protocol Labs — [discuss.ipfs.tech thread](https://discuss.ipfs.tech/t/what-happens-to-ipfs-maintenance-and-public-infrastructure-after-september-30/20324)
- Fleek IPFS hosting was discontinued on 2026-01-31 (Fleek pivoting to AI); IPFS project itself moved its sites to GitHub Pages + Kubo CAR creation + IPFS Cluster pinning + DNSLink — [docs.ipfs.tech Fleek case study](https://docs.ipfs.tech/case-studies/fleek/), [IPFS blog: Fleek migration](https://blog.ipfs.tech/2026-fleek-migration/) (second link seen only as a search result title; contents unverified)
- Fleek hosting had depended on a traditional HTTP CDN for post-first-load speed — [docs.ipfs.tech Fleek case study](https://docs.ipfs.tech/case-studies/fleek/)
- Brave deprecated native IPFS (local node and ipfs:// protocol support) as of 2024-08-22 (v1.69.153), citing under 0.1% usage — [Brave: IPFS Support](https://brave.com/ipfs-support/) (found via search snippet)

### Inferences
- Pin Kubo/Boxo versions and budget engineering time for security patches (the v0.43.0 notes list several 2026 CVEs: pubsub, WebTransport, HTTP/3 memory, OTLP). Treat any dependence on ipfs.io/dweb.link/delegated-ipfs.dev/bootstrap nodes as a risk; configure your own bootstrap/delegated routing endpoints.
- The "browser-native IPFS" niche is now thin: Brave removed it, so a browser with native ipfs:// is differentiated but without upstream browser-vendor allies.

### Gaps
- No confirmed successor maintainers for Kubo/Helia/Boxo as of mid-Oct 2026; I could not verify whether any release occurred after 2026-09-30. Kubo v0.43.0/0.43.1 exact release dates not stated on the changelog page. Storacha/Fil One status: a forum post says Storacha users were pointed to "Fil One"; I could not confirm what that is.

## 1. Serving a site from a CID: path vs subdomain gateway, DNSLink, IPNS, ENS

### Takeaway
Subdomain gateways (one origin per root CID/IPNS name) and DNSLink are the stable, specified way to get web-app origin isolation; path gateways give a single shared origin and are unsafe for apps that use storage. IPNS records are spec-stable (V2 signatures, 10 KiB limit, 5-min TTL suggestion, 48h DHT expiry); delegated IPNS HTTP API exists; I found no sourced evidence on Pkarr.

### Cited Findings
- Subdomain Gateway spec (published 2025-04-03, status reliable): root CID defines a separate origin; CIDv1 base32 in label; IPNS libp2p-key in base36 so ED25519 fits one DNS label; each DNS label max 63 chars (longer CIDs, e.g. sha2-512, are an open question); Host must have at least 3 labels; DNSLink names encoded in one label ("-" becomes "--", "." becomes "-"); path-style requests get 301 to subdomain; operators should register wildcard with the Public Suffix List — [Subdomain Gateway spec](https://specs.ipfs.tech/http-gateways/subdomain-gateway/)
- Uniswap release notes warn the interface keeps settings in localStorage, so use a gateway that enforces origin separation (an arbitrary path gateway like ipfs.io is a risk) — [Uniswap/interface release notes mirror](https://newreleases.io/project/github/Uniswap/interface/release/web%2F5.154.9) (mirror; verify on GitHub)
- IPNS spec (dated 2025-02-28): Ed25519 required default; RSA legacy only; secp256k1/ECDSA optional and may not resolve on public DHT; name = CIDv1 libp2p-key, base36 recommended; record fields Value, Validity (RFC 3339, DHT records should expire within 48h), Sequence, TTL (suggested default 5 minutes), SignatureV2 over DAG-CBOR; SignatureV1 deprecated since 2021; records up to 10 KiB must be supported; resolvers pick highest Sequence; routing via DHT or PubSub — [IPNS Record spec](https://specs.ipfs.tech/ipns/ipns-record/)
- IPIP-379 Delegated IPNS HTTP API: GET/PUT `/routing/v1/ipns/{name}` with content type `application/vnd.ipfs.ipns-record`; PUT 200/400/406; TLS recommended — [IPIP-0379](https://specs.ipfs.tech/ipips/ipip-0379)
- Kubo v0.43.0: IPNS and provider records share one store under `/dht`; DHT drops records not refreshed in 48h; own records kept alive by republisher; `ipfs name publish` validates `--lifetime`/`--ttl`; daemon refuses to start if `Ipns.RecordLifetime` < `Ipns.RepublishPeriod`; `ipfs init` no longer publishes an IPNS record; `ipfs://` and `ipns://` URIs accepted by CLI commands — [Kubo v0.43 changelog](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.43.md)
- Kubo v0.43.0 gateway caching: DNSLink responses set `Cache-Control: max-age` from DNS TXT TTL (requires a DoH resolver in `DNS.Resolvers`); IPNS `max-age` capped at record expiry, expired/unknown expiry gives `no-store`; 304 includes Etag and Cache-Control — [Kubo v0.43 changelog](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.43.md)
- Kubo v0.43.1: `Ipfs-Uri` header (IPIP-548) replaces `X-Ipfs-Path` — [Kubo v0.43 changelog](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.43.md)
- Service Worker Gateway handles `/ipns/*` and DNSLink (via DNS-over-HTTPS) — [ipfs/service-worker-gateway](https://github.com/ipfs/service-worker-gateway)
- Uniswap (2020 announcement): daily IPFS deploys, IPNS + DNSLink for app.uniswap.org, ENS contenthash on uniswap.eth, served via uniswap.eth.link; later release notes dropped the Cloudflare-gateway wording and now say "hosted deployment" — [Uniswap blog 2020-06-30](https://blog.uniswap.org/uniswap-interface-ipfs), [release notes mirror](https://newreleases.io/project/github/Uniswap/interface/release/v4.84.0)
- Delegated republishing caveat (forum user comment, not spec): delegated routing can only republish; TTL is signed so cannot be changed without the private key — [IPNS publishing guidance thread](https://discuss.ipfs.tech/t/ipns-publishing-guidance-for-high-availability/18928?page=2)

### Inferences
- In a native ipfs:// handler the scheme host (`ipfs://<cid>/`) already gives one origin per CID, so you get subdomain-gateway-equivalent isolation without wildcard DNS/TLS; base32 CIDv1 (case-insensitive) must be used as the host because URL hosts are lowercased.
- For ipns:// the origin is the name, so storage persists across versions: same-origin continuity is a feature but means a compromised key equals app takeover.
- IPNS freshness depends on a live republisher; with Kubo 0.43 the 48h DHT expiry means a publisher that goes offline causes name loss (see the forum item on a third-party republisher in section 0).

### Gaps
- Pkarr and ENS: I found no sourced material on Pkarr integration with IPNS, nor current ENS contenthash/ENSIP specifics or gateway behaviour in 2026; IPNS publish speed benchmarks not found.

## 2. SPA routing and web-app needs (_redirects, 404, headers, caching, ranges, HAMT)

### Takeaway
`_redirects` (IPIP-0002, Kubo 0.16 from late 2022) provides SPA fallback (200 rewrite) and custom 404 but only in unique-origin contexts (subdomain, DNSLink, and native ipfs:// handlers); there is no `_headers` support in anything I could source, so CSP and custom headers must be injected by your own handler.

### Cited Findings
- Web `_redirects` spec (published 2025-03-19, "reliable"; editors Justin Johnson, Marcin Rataj): file at root CID; max 64 KiB; statuses 200, 301 (default), 302, 303, 307, 308, 404, 410, 451; non-forced (only applies when path is absent from the DAG); first match wins; `:placeholders` and one trailing `*` splat; query params preserved; unreadable/unparseable file gives HTTP 500; applies only on Subdomain/DNSLink gateways "and on browsers with native ipfs:// and ipns:// handlers" — [Web Redirects File spec](https://specs.ipfs.tech/http-gateways/web-redirects-file/)
- Origin of feature: IPIP-0002; shipped in Kubo 0.16.0 as "Web Gateways now support _redirects files"; Netlify/Cloudflare Pages format subset — [IPIP-0002](https://specs.ipfs.tech/ipips/ipip-0002), [Kubo 0.16.0 notes](https://newreleases.io/project/github/ipfs/kubo/release/v0.16.0), [docs.ipfs.tech redirects how-to](https://docs.ipfs.tech/how-to/websites-on-ipfs/redirects-and-custom-404s/)
- Kubo v0.39: new `Gateway.MaxRangeRequestFileSize` to stop CDNs turning small range requests into full downloads (affects deserialized responses only) — [Kubo v0.39 changelog](https://github.com/ipfs/kubo/blob/master/docs/changelogs/v0.39.md)
- Kubo v0.43.0: 304 responses include Etag/Cache-Control; truncated CAR responses end with an explicit error marker; CAR traversal capped at 1024 levels — [Kubo v0.43 changelog](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.43.md)
- Kubo v0.24 (2023, older): Cache-Control handling for `/ipns/` paths so rarely-updated IPNS sites load faster — [search summary of Kubo v0.24 release](https://github.com/ipfs/kubo/releases/tag/v0.24.0)

### Inferences
- Immutable-CID semantics (a `/ipfs/` response never changes) justify `Cache-Control: public, max-age=31536000, immutable` in your own protocol handler; IPNS responses should use record TTL/expiry per the Kubo 0.43 behaviour above. (Inference; Kubo's `/ipfs/` header value was not verified here.)
- Implementing `_redirects` yourself in the handler is required if you go through Kubo's RPC/trustless endpoints rather than its HTTP gateway: use the spec's semantics (non-forced, 64 KiB, first-match).

### Gaps
- No sourced information on `_headers` support, content-type sniffing behaviour, HAMT directory sharding thresholds in current Kubo/Boxo, or exact Boxo version for redirects (the spec only links fixtures from Boxo v0.42.1 / gateway-conformance v0.13.2, per the fetch summary).

## 3. Origin and security model in a controlled browser (Electron 44)

### Takeaway
In Electron, a custom scheme must be registered with `registerSchemesAsPrivileged` before `app.ready`, only once; `standard` is mandatory for relative URL resolution and for web storage (localStorage, sessionStorage, IndexedDB, cookies). Per-CID origins then come naturally from `ipfs://<cid>` host, but the Electron docs do not document service-worker or range behaviour for `protocol.handle`.

### Cited Findings
- `registerSchemesAsPrivileged`: only before `ready`, callable once; privileges include standard, secure, bypassCSP, allowServiceWorkers, supportFetchAPI, corsEnabled, stream, codeCache; "standard" follows RFC 3986 so relative/absolute resources resolve; without standard, web storage APIs (localStorage, sessionStorage, webSQL, IndexedDB, cookies) are disabled; `stream: true` for streaming media — [Electron protocol docs](https://www.electronjs.org/docs/latest/api/protocol)
- `protocol.handle` replaced `protocol.register*Protocol`/`intercept*Protocol` in Electron >= 25; handler gets a `GlobalRequest` and returns a `Response`; handlers are per-session (use `session.fromPartition(...).protocol.handle` for custom partitions); `request.initiatorOrigin` preferred over `referrer` for access decisions — [Electron protocol docs](https://www.electronjs.org/docs/latest/api/protocol)
- The docs page does not describe service-worker behaviour, HTTP range handling or streaming for `protocol.handle` — [Electron protocol docs](https://www.electronjs.org/docs/latest/api/protocol)
- Service Worker Gateway runs only in subdomain mode, registering a service worker on first load to intercept `/ipfs/*` and `/ipns/*` with verified retrieval from peers or trustless gateways — [ipfs/service-worker-gateway](https://github.com/ipfs/service-worker-gateway)
- IPFS Companion: Chrome and Firefox builds are Manifest V3 (listings show v3.1.0 Firefox, v3.3.0 Chrome); MV3 background worker idling caused toolbar-state bugs fixed in v3.4.0; Igalia's 2022 work proposed manifest-declared `protocol_handlers` (needed `--enable-features=ExtensionProtocolHandlers` in Chrome); Firefox: no Mozilla plans for native IPFS as of 2022 — [Companion install docs](https://docs.ipfs.tech/install/ipfs-companion/), [v3.4.0 notes](https://newreleases.io/project/github/ipfs/ipfs-companion/release/v3.4.0), [IPFS blog: Igalia/Chromium](https://blog.ipfs.tech/14-11-2022-igalia-chromium/)
- Kubo v0.43: Web UI v4.13.0 adds opt-in native `ipfs://` share links; AutoTLS plus `webrtc-direct`/WebTransport (draft-15) address advertisement so browsers can dial nodes — [Kubo v0.43 changelog](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.43.md)

### Inferences
- Recommended registration (my synthesis from the docs above, not an official IPFS recommendation): `{scheme:'ipfs', privileges:{standard:true, secure:true, supportFetchAPI:true, corsEnabled:true, stream:true, allowServiceWorkers:?}}`; do NOT set `bypassCSP` (it would let content ignore CSP and defeats web-origin hygiene). `secure:true` is what should give secure-context status for Web Crypto/WebAuthn/service workers, but the Electron docs page fetched does not state this; must be tested in Electron 44.
- Same-scheme risk: with `standard` hosts, `ipfs://<cid-a>` and `ipfs://<cid-b>` are cross-origin; mixed content (ipfs page fetching http://) and gateway-to-gateway links need explicit policy in the handler (CSP injected via response headers).
- Absolute-path links (`/img.png`) resolve against the CID host, so they work under per-CID host origins; they break under path gateways (`/ipfs/<cid>/`), the main reason subdomain/native-origin is the right model.
- Service workers on a custom scheme need `allowServiceWorkers`; a client-side handler makes most SW use-cases (offline cache, verified fetch) unnecessary but PWAs may expect it.

### Gaps
- Not verified: Chromium behaviour for WebAuthn RP ID on custom schemes (WebAuthn requires a registrable domain; likely unavailable for hosts that are CIDs — unsourced), cookies semantics, Electron 44 specific changes, `@helia/verified-fetch` capabilities (the repo page was empty of detail), Opera's current IPFS support, and Chromium design notes on custom schemes.

## 4. Dynamic apps and decentralised backends

### Takeaway
IPFS hosts the static shell; anything needing authentication, payments, secrets or shared mutable databases needs either a server or a young decentralised substitute. I found little reliable 2026 maturity data, and part of the ecosystem is shrinking.

### Cited Findings
- Ceramic: forum reply says ComposeDB and js-ceramic would be deprecated then sunsetted in favour of ceramic-one (undated); OrbisDB presented as successor database — [Ceramic forum: ComposeDB continued support](https://forum.ceramic.network/t/composedb-continued-support-development/1920), [Ceramic blog: OrbisDB](https://blog.ceramic.network/orbisdb-is-a-practical-upgrade-for-databases-on-ceramic/); gateways deprecation post undated — [Deprecating Ceramic Gateways](https://forum.ceramic.network/t/deprecating-ceramic-gateways/514)
- OrbitDB: @orbitdb/core builds on Helia/libp2p (v4.0.0 per an indexed docs page; unverified) — [OrbitDB docs index](https://docsearch.algolia.com/mcp/docs/repo/orbitdb/orbitdb)
- Storacha is described as the successor to web3.storage using UCAN authorization on Filecoin-backed storage; no 2026 sunset found — [Storacha docs](https://docs.storacha.network/), [Storacha](https://storacha.network/)
- Public-good retrieval is moving to paid providers: x402 and MPP pinning/retrieval (Pinata, Filebase, Lighthouse) are recommended by the IPFS blog — [IPFS Blog](https://blog.ipfs.tech/2026-08-beyond-sponsored-gateways/)
- Uniswap's interface (a fully client-side app with wallet auth, no server-held secrets for users) is the main real-world IPFS-hosted dApp example and is still published per release with CIDs — [Uniswap release notes mirror](https://newreleases.io/project/github/Uniswap/interface/release/web%2F5.154.9)

### Inferences (verdicts are my judgement, not sourced)
- Blog, docs, marketing site: fully viable (static, `_redirects` for clean URLs). SPA and PWA: viable with a native handler (per-CID origin, `_redirects` fallback); service-worker PWAs depend on `allowServiceWorkers`.
- Dashboard: viable if it reads public APIs (CORS permitting, via `corsEnabled`) or on-chain data; secrets cannot live in the bundle.
- E-commerce: needs a payment processor/server for checkout, inventory and orders; IPFS only hosts the storefront (or use on-chain payments).
- Social, chat, collaborative editor: possible with local-first CRDTs (Yjs/Automerge) plus a sync relay or WebRTC/libp2p, but real-time reliability and moderation need infrastructure; treat as experimental. Nostr, Waku, Gun, Fission: no 2026 maturity data found.

### Gaps
- No 2026 sources on Yjs, Automerge, Gun, Nostr, Waku, WebRTC, Fission (my search returned irrelevant results), or Ethereum-as-backend; "Fil One" unidentified. Verdicts above are therefore unsourced reasoning.

## 5. Updating a site: deploys, pointers, tooling, cost

### Takeaway
Deploys are content-addressed (new CID per release) with a mutable pointer (IPNS, DNSLink TXT, or ENS contenthash); the hosted-deploy-platform layer collapsed in 2026 (Fleek gone). Rollback = repoint to an older CID, provided it is still pinned.

### Cited Findings
- Uniswap pattern: daily/per-release IPFS builds, each with its own CID published in GitHub release notes; IPNS + DNSLink + ENS contenthash as pointers — [Uniswap blog](https://blog.uniswap.org/uniswap-interface-ipfs), [release notes mirror](https://newreleases.io/project/github/Uniswap/interface/release/web%2F5.154.9)
- IPFS project's own post-Fleek stack: GitHub Pages for HTTPS, Kubo for CID/CAR creation, IPFS Cluster for pinning, DNSLink for naming — [IPFS Blog: Fleek migration](https://blog.ipfs.tech/2026-fleek-migration/) (via search result summary)
- Kubo v0.43.0: `ipfs add`/`dag import` immediately provide root CIDs (`--fast-provide-root` default on; sweep provider default since v0.39) — [Kubo v0.39](https://github.com/ipfs/kubo/blob/master/docs/changelogs/v0.39.md), [Kubo v0.43](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.43.md)
- Fleek migration help: Filebase offered one-click import of Fleek-pinned CIDs — [Filebase blog](https://filebase.com/blog/how-to-migrate-your-ipfs-content-from-fleek-to-filebase/) (vendor claim)

### Inferences
- Choose a pinning provider that supports plain CIDs (Pinata/Filebase/Lighthouse named by IPFS blog) plus your own Kubo/Cluster pin; avoid platform lock-in given Fleek and the public gateway changes.

### Gaps
- No sourced cost or time-to-publish figures; no current status for ipfs-deploy, w3 CLI, or GitHub Actions for IPFS.

## 6. Failure modes

### Takeaway
Documented 2026 failure modes are infrastructure-level: provider shutdowns, public gateway rate limiting, DHT record expiry; performance-level numbers were not found.

### Cited Findings
- Fleek hosting shutdown on 2026-01-31 took hosted sites offline unless migrated — [docs.ipfs.tech Fleek case study](https://docs.ipfs.tech/case-studies/fleek/), [pinner.xyz summary](https://pinner.xyz/alternatives/fleek/) (third-party)
- Public gateways ipfs.io/dweb.link rate-limiting hotlinks and backend traffic, increasing — [IPFS Blog](https://blog.ipfs.tech/2026-08-beyond-sponsored-gateways/)
- Unmaintained IPNS republishing: DHT drops records not refreshed within 48h — [Kubo v0.43](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.43.md)
- Abuse: forum users (Oct 2, 2026) report IPFS-hosted phishing sites and question whether the abuse reporting page still works (user reports, unverified) — [discuss.ipfs.tech thread](https://discuss.ipfs.tech/t/what-happens-to-ipfs-maintenance-and-public-infrastructure-after-september-30/20324)
- Sweep provider caveat: with `Routing.AcceleratedDHTClient`, full efficiency may be unavailable; fast root CID provide skipped when DHT routing unavailable — [Kubo v0.39](https://github.com/ipfs/kubo/blob/master/docs/changelogs/v0.39.md)

### Gaps
- No measured first-load latency, cold-content retrieval times, or large-bundle data sourced.

## 7. What a browser vendor controlling the client can improve

### Takeaway
Because the client controls the protocol handler, it can do verified retrieval, local-node caching, provider hints, and spec features (`_redirects`, origin per CID) without depending on public gateways, but it inherits routing/bootstrapping responsibility now that Shipyard's infrastructure is gone.

### Cited Findings
- Spec explicitly anticipates native handlers: `_redirects` applies "on browsers with native ipfs:// and ipns:// handlers" — [Web Redirects File spec](https://specs.ipfs.tech/http-gateways/web-redirects-file/)
- Verified retrieval: the Service Worker Gateway verifies blocks against CIDs client-side using Helia/verified-fetch, from p2p providers or fallback trustless gateways; same gateway-conformance suite as Kubo and Rainbow — [ipfs/service-worker-gateway](https://github.com/ipfs/service-worker-gateway)
- Browsers can now dial Kubo nodes via AutoTLS `/tls/ws` and `webrtc-direct`, and delegated provider records include these addresses (v0.43.0); `webrtc-direct` has a stable certhash across restarts — [Kubo v0.43](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.43.md)
- Delegated IPNS and content routing via HTTP (IPIP-379, Routing V1) avoid running a DHT client in the browser — [IPIP-0379](https://specs.ipfs.tech/ipips/ipip-0379), [Routing V1 spec](https://specs.ipfs.tech/routing/http-routing-v1)
- Kubo accepts `ipfs://`/`ipns://` URIs in CLI/paths (v0.43) — [Kubo v0.43](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.43.md)

### Inferences
- Concrete levers (my synthesis): serve from local Kubo first (blockstore as offline cache), pin on visit for "keep available" pages, trustless-gateway CAR fallbacks for cold fetches, host the delegated-routing endpoint yourself (delegated-ipfs.dev is at risk), preload linked CIDs and provider hints for subresources, show a "verified" indicator; keep a minimal origin-isolation + CSP policy in the handler.

### Gaps
- No sourced evidence on how Opera handles ipfs:// today, on Chromium's custom-scheme design notes, or on prefetch/offline-first implementations in existing browsers.
