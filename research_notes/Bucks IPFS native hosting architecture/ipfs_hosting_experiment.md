# Hands-on IPFS site hosting experiment: Kubo gateway and Bucks-browser protocol handler

Source convention: every "measured" finding below was produced by a command run in this experiment; the artefacts (scripts, CIDs, configs) live in `/private/tmp/claude-501/-Users-mikado-Desktop-Bucks-Core-bucks-browser/afe3f5cc-208f-4037-9d92-cb0c8b618f1d/scratchpad/ipfs-exp/` (referred to as `$E`). Bucks repo code was read from the read-only copy at `.../scratchpad/bb` (referred to as `$BB`). Only one external URL source was used (Kubo v0.16 changelog). No public-network access by the node, no user data.

## 0. Environment and method

### Takeaway
All experiments ran on Kubo 0.43.1 (arm64/darwin) from the official GitHub release with a verified SHA-512, in an isolated repo, on non-default ports, offline or loopback-only. Everything except a real Electron run was executed (Electron could not be installed: disk full).

### Cited Findings
- Date 2026-10-19 (UTC 10:09 start), macOS 27.0.1 (build 26A434), Darwin 27.0.0 arm64, Node v26.3.0. Kubo `0.43.1-acc53c093`, repo version 18, go1.26.5. — measured (`ipfs version --all`, `sw_vers`)
- Kubo was fetched with the project's own `$BB/scripts/fetch-kubo.mjs --out-dir $E/kubo-dl`. dist.ipfs.tech timed out on the checksum fetch (10 s connect timeout to all three addresses); the script then fell back to GitHub releases (`github.com/ipfs/kubo/releases/download/v0.43.1/kubo_v0.43.1_darwin-arm64.tar.gz`) and printed "Checksum verified (GitHub releases)" (SHA-512 from the `.sha512` file next to the archive). Total 32.8 s. — measured
- Isolated repo `IPFS_PATH=$E/repo`; `ipfs init --profile=lowpower`; API 127.0.0.1:15001, Gateway 127.0.0.1:15080, Swarm 127.0.0.1:15004 (loopback only), `Bootstrap=[]`, `Routing.Type=none`, `Swarm.DisableNatPortMap=true`, daemon run with `--offline` for exps 1-5 and 7a. Exps 7b/7c briefly ran loopback-only "online" daemons (no bootstrap, mDNS disabled, no routing) so nothing could reach the public network. `~/.ipfs` was not touched.
- Playwright 1.64.1 + `chromium-headless-shell` installed into `$E/pw` (browsers in `$E/pw/browsers`). Electron 44.9.0 install attempted into `$E/el` failed with "No space left on device" (host volume had 117 MiB free); it was deleted. So no run inside the real Bucks/Electron runtime. — measured
- Cleanup: both daemons shut down via `ipfs shutdown`; `pgrep -f "ipfs daemon|headless_shell|origin.mjs"` returned 0 and `lsof` showed nothing on ports 15001/15004/15080/15101/15104/15180. — measured

### Inferences
- All numbers are loopback/local-disk numbers: they show gateway correctness and overhead, not network performance.

### Gaps
- Real Electron/Chromium-with-custom-scheme behaviour (origin per `ipfs://<cid>`, fetch/CORS, streaming) was not run; only read from code and covered by the project's unit tests.
- dist.ipfs.tech was unreachable from this machine at test time (GitHub mirror worked); cause unknown (network filtering or transient).

## 1. Static site on the Kubo gateway (path vs subdomain)

### Takeaway
A plain multi-file static site (css, js, image, nested dirs, spaces/unicode filenames) is served correctly by both the path gateway and the subdomain gateway; every `<cid>.ipfs.localhost:<port>` URL works with no config because Kubo ships a built-in `localhost` subdomain gateway. Responses carry long-lived immutable cache headers and CORS `*`, but no Content-Security-Policy.

### Cited Findings
- Site: `index.html`, `css/style.css`, `js/app.js`, `img/logo.png` (32x32 generated PNG), `docs/nested/deep/page.html`, `files/café menu ✓.txt`, `files/my file name.txt`. `ipfs add -r --cid-version 1 -Q site` gives root `bafybeicvbjhnjjth3miobraatqc5qanyikwa2lnzktbn3mf3vzqf72h6he`; directories are dag-pb (`bafybei…`), small files are raw leaves (`bafkrei…`). — measured
- Path gateway `http://127.0.0.1:15080/ipfs/<cid>/…`: `/` 200 `text/html`; `css/style.css` 200 `text/css; charset=utf-8`; `js/app.js` 200 `text/javascript; charset=utf-8`; `img/logo.png` 200 `image/png`; nested page 200; percent-encoded unicode and space filenames 200 `text/plain; charset=utf-8`; missing file 404 `text/plain` with body "failed to resolve … no link named "nope.html" under …". Server-side TTFB 0.6-1.3 ms for each. — measured (`probe.sh`)
- A directory URL without trailing slash (`/docs/nested/deep`) returns 301 to the same path with `/`; a directory without `index.html` returns 200 with a generated HTML listing (`Cache-Control: public, max-age=604800, stale-while-revalidate=2678400`, ETag `DirIndex-…`); `files/` listing links were correctly percent-encoded. — measured
- Headers on `/ipfs/<cid>/` (HTML): `Cache-Control: public, max-age=29030400, immutable`, `Etag: "<root cid>"` (file requests: ETag = file CID), `Content-Type: text/html` (no charset parameter; other types have `; charset=utf-8`), `Accept-Ranges: bytes`, `Ipfs-Uri: ipfs://<cid>/`, `X-Ipfs-Roots: <cid>[,<child cid>…]`, `Access-Control-Allow-Origin: *`, plus allow/expose-header lists. No `Content-Security-Policy`, no `Content-Disposition`; `X-Content-Type-Options: nosniff` only appeared on `application/vnd.ipld.raw` responses. — measured
- Conditional request: `If-None-Match: <etag>` returns 304. HEAD works. `Accept: application/vnd.ipld.raw` returns the raw block with nosniff. — measured
- Subdomain gateway: `curl http://<cid>.ipfs.localhost:15080/` returns 200 with identical headers; no `/etc/hosts` entry or gateway config needed (`Gateway.PublicGateways` is `null`; localhost subdomain support is built in and curl/Chromium/Node resolve `*.localhost` to loopback). A directory without slash returns a relative `301 Location: /docs/nested/deep/`. — measured
- Host handling: requests whose Host is the bare IP `127.0.0.1:15080` are served path-style with no redirect. A path request with `Host: localhost:15080` (or via `http://localhost:15080/ipfs/<cid>/…`) returns `301 Location: http://<cid>.ipfs.localhost:15080/<rest>`. A CIDv0 path on `localhost` redirects to the CIDv1 base32 subdomain (`Qm…` → `bafybeibu6z56i6ip…`). An invalid label (`nothex.ipfs.localhost`) gives 400; an unknown suffix host (`<cid>.ipfs.example.com`) gives 404. Setting `Host:` on a request to 127.0.0.1 also selects the subdomain form. — measured
- Subdomain form requires the CID in a case-insensitive DNS label, so CIDv1 base32/base36 only (CIDv0 is converted by redirect).

### Inferences
- For a local-only embedded node, the subdomain form works with zero configuration, so origin isolation is available without custom DNS.
- Because no CSP is sent, any CSP or sandboxing must be added by the consumer (browser protocol layer).

### Gaps
- Not tested: DNSLink hostnames (`<dnslink-domain>.ipns.localhost`) because they need DNS TXT lookups, which an offline node cannot do.

## 2. SPA routing: history router vs `_redirects` vs hash router

### Takeaway
A history-API SPA deep link returns 404 on every gateway form by default. A `_redirects` file with `/* /index.html 200` fixes it, but only on the subdomain gateway (404 on the path gateway), and Kubo 0.43.1 rejects forced rules and enforces a 64 KiB cap. A hash-router build works everywhere with relative asset URLs.

### Cited Findings
- Hand-written 3-route SPA (`/`, `/about`, `/users/42`), three builds: `spa-history` (no redirects, root-absolute `/assets/app.js`), `spa-redirects` (same + `_redirects`), `spa-hash` (hash router, `./assets/app.js`). CIDs in `$E/spa-*.cid`. No Vite build was attempted (hand-written was permitted). — measured
- (a) No redirects, subdomain: `/` 200, `/assets/app.js` 200, `/about` 404, `/users/42` 404, `/missing/x.png` 404 (all `text/plain`). Path gateway `/about` and `/users/42` 404. In headless Chromium, loading `http://<cid>.ipfs.localhost:15080/users/42` yields HTTP 404 and no app; navigating to `/` then `history.pushState('/users/42')` renders "ROUTE:user 42" (client-side navigation works, only cold deep links fail). — measured (`pw/spa.mjs`)
- (b) With `_redirects` = `/* /index.html 200`, subdomain: `/about`, `/users/42` return 200 `text/html` (body is index.html, 163 B) with `Cache-Control: public, max-age=29030400, immutable`, ETag = index.html CID, `Ipfs-Uri: ipfs://<cid>/users/42`; Chromium renders "ROUTE:about" and "ROUTE:user 42" on cold loads. Real files win (`/assets/app.js` served as JS) because shadowing is not supported. A non-existent `/missing/x.png` returns 200 with `Content-Type: image/png` but an HTML body (content type guessed from the extension) — a mislabelled response. — measured
- Path gateway with `_redirects`: `/ipfs/<cid>/about` and `/users/42` still 404, and in Chromium the root page loads but renders nothing because `/assets/app.js` (root-absolute) resolves to `127.0.0.1:15080/assets/app.js` (404). So `_redirects` is not applied on the path gateway, and root-absolute assets break there regardless. — measured
- Fuller rules file (`/old-about /about 301`, `/legacy/:id /users/:id 302`, `/api/* /404.html 404`, `/* /index.html 200`, plus `404.html` in the CID): subdomain `/old-about` → 301 `Location: http://<cid>.ipfs.localhost:15080/about` (query string preserved: `?x=1` kept), `/legacy/7` → 302 `/users/7`, `/api/foo` → 404 with body "<h1>custom 404</h1>" (`text/html`), `/users/9` → 200 index, `/_redirects` itself is readable as `text/plain` 200. Path gateway: 404 for the redirect rule. — measured
- Limits and errors: a forced rule (`/index.html /index.html 200!`) makes every request that reaches rule evaluation return HTTP 500 with "trouble processing _redirects file … forced redirects (or "shadowing") are not supported"; a malformed line returns 500 ("path must begin with '/'") for non-existing paths while existing paths (e.g. `/`) keep working; a 110,890-byte file returns 500 "redirects file size cannot exceed 65536 bytes". A bare `404.html` with no `_redirects` is NOT used (plain-text 404). — measured
- Version support: `_redirects` support landed in Kubo 0.16.0 ("Web Gateways now support `_redirects` files") — [Kubo v0.16 changelog](https://raw.githubusercontent.com/ipfs/kubo/master/docs/changelogs/v0.16.md); the behaviour above confirms it on 0.43.1 and shows it is subdomain-only here.
- (c) Hash-router build: subdomain `/#/about` and `/#/users/42` render correctly in Chromium (`location.pathname` is `/`); path gateway `/ipfs/<cid>/#/users/42` also renders (relative `./assets/app.js` resolves under `/ipfs/<cid>/`). Server never sees the fragment, so no redirects needed. — measured

### Inferences
- History-router SPAs need the subdomain gateway (or a handler that emulates `_redirects`) plus a build that either avoids root-absolute assets or runs on a subdomain origin.
- Authors must keep `_redirects` simple (no `!` force, <64 KiB); an invalid file breaks all unmatched routes with 500, so publish-time validation is advisable.
- Hash-router (or a router with a relative `base`) is the only approach that works identically on path gateway, subdomain gateway and any proxy that only does path mapping.

### Gaps
- No real framework build (React/Vite) was produced; framework-specific base-path issues (`vite base`, `homepage`) are inferred, not tested.

## 3. Large and many-file site

### Takeaway
2,000 small files plus a 50 MB asset add in well under a second against a local daemon, serve with ~1 ms TTFB, and support byte-range requests; directory sharding (HAMT) starts when a directory's estimated size passes about 256 KiB (about 3,000-4,000 entries here) and the gateway serves sharded directories transparently.

### Cited Findings
- Dataset `big/`: 2,000 files in `flat/` (20-200 B), 500 files across 25 subdirs in `nested/`, `index.html`, and `asset50.bin` (50 MiB = 52,428,800 B of random data); 2,502 files / 60 MB. — measured
- `ipfs add -r --cid-version 1 -Q big`: 0.64 s wall (CLI client, daemon did the work); CLI max RSS 52 MB; daemon RSS 63 MB before → 77.5 MB after. Result `bafybeictacrgwp2opbqegmyjrv7nuav65kynb7uofmncctbfccwcukio6q`; 2,732 unique blocks (`ipfs dag stat`: 2,732). — measured
- Structure: the 50 MB file is a balanced dag-pb tree whose root has 2 links (subtrees of 45,613,056 B and 6,815,744 B) over 200 leaf chunks of 262,144 B (the default chunk size). `flat/` with 2,000 entries is a single plain dag-pb block of 108,948 B with 2,000 links (not sharded). — measured
- HAMT threshold: with 50-byte file names, root block for N entries: 2,000 → 170,004 B / 2,000 links; 3,000 → 255,004 B / 3,000 links; 4,000, 4,500, 5,000 → 12,075 B / 256 links (HAMT fan-out 256, 2-hex-digit bucket names "00"…"FF"). 6,000 entries: add 1.43 s; `ipfs ls` lists all 6,000; the gateway served `d/file-with-a-somewhat-long-name-004321.txt` 200. Consistent with a size-estimate threshold of 256 KiB (`Import.UnixFSHAMTDirectorySizeThreshold`, config key present but unset by default in 0.43.1). — measured
- Gateway timing (path gateway, daemon local): 50 MB full download TTFB 1.1 ms, total 23 ms (sha256 identical to the source file); range `bytes=1000-1999` → 206, `Content-Range: bytes 1000-1999/52428800`; open-ended and suffix ranges → 206; out-of-bounds → 416; mid-file range at offset 30,000,000 returned in 1.3 ms and matched the source bytes; a multi-range request (`0-99,200-299`) returned only 100 bytes (a single range, not multipart) with `application/octet-stream`. HEAD returns `Content-Length` and ETag. — measured
- 2,000 sequential `curl` fetches of distinct files: 15.3 s total (≈7.7 ms each, dominated by process spawn); 2,000-entry directory listing HTML = 1,984,857 B (~2 MB) at TTFB 3 ms. — measured

### Inferences
- Large assets are viable (range requests, so video seeking works); very large directories are viable too but a generated listing page for huge directories is heavy.
- Authors should not rely on directory listing for large trees; keep an `index.html`.

### Gaps
- Real-network retrieval of a 50 MB asset (peer discovery, bitswap latency) was not measured; the only bitswap number is loopback (exp 7).
- Daemon peak memory during concurrent heavy serving was not measured (only idle/after-add RSS).

## 4. Update model: CID changes, structural sharing, MFS, IPNS

### Takeaway
Any change produces a new root CID but only the changed file and its ancestor directories are new blocks (2 new refs of 14 for a CSS edit; 3 of 2,731 for a 1-byte edit in a 50 MB file). IPNS publish/resolve works fully offline and fast (~20-25 ms), with TTL surfaced as `Cache-Control`; MFS gives a mutable working tree, but MFS-modified trees do not necessarily hash the same as `ipfs add` of identical content.

### Cited Findings
- Edit `css/style.css` only: v1 `bafybeicvbjhnjjth…` → v2 `bafybeiaoosnyzggqh6u456e6kdzjb3ijxwi6bd5pdnkk6j7yn6zctehqwm`. `refs -r -u` of each shows 14 non-root nodes; 12 shared, 2 new (the CSS file and the `css/` directory) plus the new root; `ipfs dag stat v1 v2`: 18 unique blocks, shared size 947 B, ratio 1.54. Re-adding unchanged content gives the identical CID. — measured
- 1-byte change at offset 40,000,000 of the 50 MB asset (whole `big` tree re-added): root changes (`bafybeia5mxqu2…`), 2,731 vs 2,731 blocks, 3 new refs plus new root, the changed leaf is 262,144 B (one 256 KiB chunk); `dag stat`: shared size 52,552,496 B, ratio 1.99. — measured
- MFS flow: `ipfs files mkdir -p /sites/demo`, `ipfs files cp /ipfs/<cid>/ /sites/demo/v1` (0.024 s, no data copy), `ipfs files write --create --truncate /sites/demo/v1/css/style.css < new` changes the path's hash; `ipfs files stat --hash /sites/demo/v1` yields the new root. MFS root itself is CIDv0 (`Qm…`) unless `files chcid`; sub-trees keep CIDv1. MFS survives `repo gc` (served 200 after gc). — measured
- Discrepancy: the MFS-edited tree `bafybeignjrmz…` ≠ `ipfs add` of the same final content `bafybeiaoosnyz…`. Diagnosis: the MFS-written `style.css` is a dag-pb file node (block codec 0x70, 45 B, `bafybeihtv76…`) whereas `ipfs add` stores it as a raw leaf (codec 0x55, `bafkreig3n3j…`), even with `--cid-version=1 --raw-leaves` on the write. So MFS publishing is correct but gives different CIDs than a clean `ipfs add`. — measured
- IPNS offline: `ipfs key gen --type=ed25519 mysite` → `k51qzi5uqu5dhiuqbyjhgy67ws8ymb0s6cgccafhgqxvi0j29hmd77vvff59s7` (base36 libp2p-key CIDv1). `ipfs name publish --key=mysite --allow-offline --lifetime=24h --ttl=5m /ipfs/<cid>` took 0.025 s; `ipfs name resolve /ipns/<k51…>` 0.019 s (also `--nocache`, `-r=false`: ~0.02 s). The record `lifetime`/`ttl` could not be inspected directly offline (`ipfs routing get` requires online mode), so TTL was verified via the gateway: `Cache-Control: public, max-age=300` for `--ttl=5m` and for the default (no flag), `max-age=3600` for `--ttl=1h`; `--ttl=0s` produced no `max-age` line at all in my capture (the header printed nothing). Config `Ipns.RecordLifetime`/`RepublishPeriod` are empty (defaults), `ResolveCacheSize` 128. — measured
- Update propagation: after `ipfs name publish` of a new CID, `GET /ipns/<k51…>/js/app.js` returned the new content 54 ms later (local, TTL=default). IPNS path/`<k51>.ipns.localhost` responses are not `immutable` (`max-age` = TTL), whereas `/ipfs/` is `max-age=29030400, immutable`. Unknown IPNS name offline → HTTP 500 in ~7 ms (text/plain). — measured
- Stability of origin across updates: with Playwright, `http://<k51>.ipns.localhost:15080/probe.html` kept the same origin and its `localStorage` (`from-a`) after republishing the IPNS name to a new CID (page content did change: v2 marker present). — measured

### Inferences
- Deploys are cheap in storage and bandwidth (only deltas are new blocks), which suits frequent updates.
- A stable address for users requires IPNS (or DNSLink); in an offline/local node IPNS is trivially fast, on the public network publish/resolve latency will differ and is not covered here.

### Gaps
- Public-DHT IPNS publish/resolve latency, record propagation and republish behaviour were not tested (public network excluded by the safety rules).
- Direct inspection of record fields (sequence, validity, TTL in nanoseconds) was not achieved offline.
- The `--ttl=0s` Cache-Control outcome should be re-checked (empty capture in this run).

## 5. Origin and storage behaviour in headless Chromium

### Takeaway
On the subdomain gateway each CID is its own secure-context origin with isolated localStorage, IndexedDB, cookies and service-worker scope; on the path gateway all CIDs share one origin and see each other's storage. IPNS subdomains give an update-stable origin.

### Cited Findings
- Setup: two probe sites (`origin-a`, `origin-b`), probe page runs `isSecureContext`, `crypto.subtle.digest`, `localStorage`, `document.cookie`, `indexedDB`, `navigator.serviceWorker.register('sw.js')`, `caches`. Headless Chromium (Playwright 1.64.1, chromium-headless-shell build 1248), fresh context. — measured (`pw/origin.mjs`)
- Subdomain `http://<cidA>.ipfs.localhost:15080/probe.html`: origin = that host; `isSecureContext` true; `crypto.subtle` works; localStorage ok; cookie set; IndexedDB ok; service worker registered with scope `http://<cidA>.ipfs.localhost:15080/`; `caches` available. `<cidB>.ipfs.localhost` is a separate origin: its localStorage started empty (`lsBefore:""`), cookies showed only `ck_b`, IndexedDB listed only `db_b`. Reloading A showed `lsBefore:"from-a"` (persistence) and only `ck_a`/`db_a`. — measured
- Path gateway `http://127.0.0.1:15080/ipfs/<cid>/probe.html`: origin is `http://127.0.0.1:15080` for both CIDs; `isSecureContext` true (loopback). Site B saw site A's localStorage key (`lsBefore:"from-a"`), cookies `ck_a=1; ck_b=1`, and IndexedDB databases `db_a,db_b`. Service workers register but with path scopes (`/ipfs/<cid>/`), and on a shared origin. — measured
- IPNS subdomain `http://<k51>.ipns.localhost:15080`: same origin and retained localStorage after the IPNS record moved to new content (see exp 4). — measured

### Inferences
- The path gateway has the classic shared-origin problem (cross-site data and cookie leakage, one site can read/overwrite another's storage); it should not be used for untrusted web apps. Subdomain-per-CID (or per-IPNS key) is the only gateway form that gives proper site isolation here.
- Because `<cid>.ipfs` origins change with every deploy, per-CID origin storage is lost on each update unless the app is served under an IPNS (or DNSLink) origin.

### Gaps
- Not tested: private/incognito partitions, third-party storage partitioning, `Secure` cookies, `Service-Worker-Allowed`, and the Bucks custom-scheme origin (see exp 6).

## 6. Bucks-browser serving logic versus gateway findings

### Takeaway
Bucks serves `ipfs://`/`ipns://` by proxying the Kubo path gateway (`/ipfs/<cid>/…`) from the main process, so it inherits path-gateway behaviour: no `_redirects`/SPA fallback, no custom 404, no CSP; origin isolation is delegated to the custom `standard`+`secure` scheme (one origin per CID), and service workers are disabled. 72 related unit tests pass.

### Cited Findings
- Code read: `$BB/src/main/protocols/ipfs.js` (293 lines), `protocols/index.js`, `ipfs/cid.js`, `ipfs/kubo.js`, `security/cookies.js`, `security/permissions.js`. — read
- Flow: `createIpfsHandler` parses the URL, validates the CID (`isCid`) or IPNS name, then if Kubo is ready proxies via `buildUpstreamUrl(kubo.gatewayUrl(), parsed)` = `http://127.0.0.1:<gw>/ipfs/<host><pathname><search>`; else shows a refresh page while initializing, else falls back to the configured public gateway (`settings.ipfs.publicGateway`, `normalizeGatewayBase`). Only GET/HEAD (405 otherwise). Forwards request headers `range, accept, if-none-match, if-modified-since`; forces `accept-encoding: identity`; `redirect: 'manual'`. — read
- Response header whitelist: `content-type, content-length, content-range, accept-ranges, etag, last-modified, cache-control, x-ipfs-path, x-ipfs-roots, content-disposition, content-security-policy, access-control-allow-origin, access-control-expose-headers`. Dropped: `Ipfs-Uri`, `X-Content-Type-Options`, allow-headers. Redirect `Location` is rewritten to `ipfs://`/`ipns://` (`rewriteLocation`, handles path, absolute and `<cid>.ipfs.<host>` subdomain forms) and self-redirects from public gateways are followed up to 3 hops. 502/504 upstream → "Content not found … within the timeout" page (HTTP 504); fetch failure → 502 page; header timeout 60 s (`UPSTREAM_HEADERS_TIMEOUT_MS`). — read
- Scheme privileges (`protocols/index.js`): `ipfs` and `ipns` registered `standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: false`. A standard scheme gets host-based origins, so `ipfs://<cid>` is its own origin (`security/cookies.js`: "every ipfs://<cid> is its own site"; `permissions.js`: per-origin keys for custom schemes). — read
- Kubo config applied by Bucks (`applyBucksConfig`): API/Gateway on loopback reserved ports, swarm port, pubsub gossipsub, mDNS on, peering list; init with `--profile=lowpower --empty-repo=true`; daemon `daemon --migrate=true --enable-gc`. No `Gateway.*` customisation (no `PublicGateways`, `NoFetch`, `RootRedirect`, `HTTPHeaders`). — read
- Unit tests (Node, no Electron) run from `$BB` without modification: `node --test test/unit/ipfs/protocol.test.js cid.test.js kubo.test.js dist.test.js rpc.test.js test/unit/security/cookies.test.js permissions.test.js` → 72 tests, 72 pass, 0 fail, 0.30 s (integration tests `kubo.integration.test.js`/`devices.integration.test.js` not run: they spawn Kubo). — measured
- Live run of the real handler against my Kubo (script `$E/handler-test.mjs` imports `createIpfsHandler` from `$BB` with a stub `kubo` pointing at 127.0.0.1:15080): static index 200 (TTFB 30 ms cold, <2 ms after), css 200, unicode file 200 for both percent-encoded and raw characters, dir without slash 301 rewritten to `ipfs://<cid>/docs/nested/deep/`, missing 404; **SPA deep link with no redirects 404, SPA with `_redirects` `/users/42` 404 and `/about` 404, `_redirects` 301 rule 404, custom 404 rule 404**; hash SPA root 200; 50 MB full stream 200 (52,428,800 B), range 1000-1999 → 206 with correct `Content-Range`; `If-None-Match` → 304; IPNS key `/` 200 with `max-age=3600`; unknown IPNS name 500 passes through text/plain; uppercase-lowercased CIDv0 host → 400 help page; `normalizeIpfsUrl` converts `ipfs://Qm…` to CIDv1 `bafybei…`. — measured
- Fix test for the SPA gap: Node's `fetch` ignores a `Host:` override (request to 127.0.0.1 with `Host: <cid>.ipfs.localhost:15080` → 404), but `fetch('http://<cid>.ipfs.localhost:15080/users/9')` works directly from Node (200, `*.localhost` resolves) and honours `_redirects`. `X-Forwarded-Host` triggers Kubo's canonical redirect to the subdomain (301) instead of serving. — measured (`$E/hosttrick.mjs`)

### Inferences (discrepancies and missing pieces)
- D1: `_redirects` (SPA fallback, 301/302 rules, custom 404) is not honoured, because Bucks calls the path gateway. Every history-router SPA deep link, and any site relying on redirects, returns 404 under `ipfs://`. Mitigation observed to work: proxy to `http://<cid>.ipfs.localhost:<gwport>/…` (requires CIDv1 base32 host, base36 IPNS key; DNSLink needs the dnslink-to-label encoding) and rewrite redirects back to `ipfs://`.
- D2: Root-absolute asset URLs (`/assets/app.js`) resolve correctly under `ipfs://<cid>/` (the scheme is host-based) — unlike on the path gateway — so Bucks already behaves like a subdomain gateway for URL resolution, which is a plus; but the proxied path gateway still cannot serve routes the SPA fallback would.
- D3: Origin isolation per CID exists via the scheme, matching the subdomain gateway and avoiding the path-gateway shared-origin problem; however it was not exercised in a real Electron run here.
- D4: Service workers are disabled (`allowServiceWorkers: false`), so PWAs/offline apps that register a SW (which works on the subdomain gateway, exp 5) will fail to register under `ipfs://`.
- D5: Headers: Bucks forwards Kubo's `Cache-Control: immutable` (good), but adds no CSP and drops `X-Content-Type-Options`; error pages carry a strict CSP, content pages none. HTML responses from Kubo lack `charset` (Chromium falls back to meta/sniffing).
- D6: Mislabelled responses when `_redirects` is used (HTML served as `image/png` for unknown image paths) would also carry over if D1 is fixed.
- D7: Update-stable origin: `ipfs://<cid>` origins change on every deploy; `ipns://<key>` gives a stable origin but IPNS TTL (default 300 s here) and resolution latency apply; Bucks has no explicit handling of IPNS TTL or `Cache-Control` beyond forwarding.
- D8: Timeouts: Kubo returns 504 at 30 s when online with no provider (exp 7); Bucks' own 60 s header timeout is never reached for the local gateway, the 504 page appears after 30 s with no progress UI.
- D9: Bucks init applies no `Gateway.NoFetch`, so an `ipfs://` URL for content not held locally triggers a network fetch (by design, but see exp 7 for the 30 s wait).
- D10: The 301 redirect for directory URLs without trailing slash is correctly rewritten back to `ipfs://` (tested live); `Ipfs-Uri` is dropped (harmless).

### Gaps
- Real Electron origin, `crypto.subtle`, `localStorage`, IndexedDB behaviour for `ipfs://<cid>` not run (Electron install blocked by disk space); the claims in D3 are from code and config, not runtime.
- The `bucks-protocol` tests and e2e tests were not run.

## 7. Failure modes: GC, partial content, NoFetch, timeouts

### Takeaway
Removing content makes the gateway return a clean 404 offline (with an explanatory text body) and 504 after 30 s when online without providers; `NoFetch=true` makes missing content fail immediately; partially missing blocks inside a large file produce a 200 that is silently truncated mid-stream, which is the nastiest failure for a browser.

### Cited Findings
- Unpin + GC: `ipfs pin rm <cid>` then `ipfs repo gc` (0.18 s) removed the 3 blocks; the same URL then returned 404 `text/plain` in 9 ms with body "failed to resolve /ipfs/<cid>/: block was not found locally (offline): ipld: could not find …: retrieval: no providers found for the CID (phase: path resolution)". Pinned/MFS content was unaffected (200). — measured
- Second repo (`$E/repo2`, ports API 15101 / GW 15180 / swarm 15104) that lacks the site CID: offline daemon, `NoFetch=false` → 404 in 1.8 ms; offline `NoFetch=true` → 404 in 1.8 ms (same message). — measured
- Same repo online (loopback swarm only, no bootstrap, routing none, mDNS off, 0 peers), `NoFetch=false` (default): request blocked for 30.0 s then `504 Gateway Timeout`, body "Unable to retrieve content within timeout period: no providers found for the CID (phase: provider discovery)", `Content-Type: text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`, no `Retry-After`. With `NoFetch=true` online → immediate 404 (1.2 ms). `Gateway.RetrievalTimeout` is not set in config (default applies; observed 30.0 s). — measured
- Positive control: node1 and node2 restarted online on loopback, `ipfs swarm connect` between them; node2's gateway fetched `css/style.css` from node1 over bitswap in 45.6 ms (then 0.9 ms locally), and the 50 MB `asset50.bin` in ~1.0 s total (200, 52,428,800 B). — measured
- Partial content: a 3 MiB pinned-then-unpinned file (12 leaves), one leaf block removed with `ipfs block rm`: `GET` of the full file returned `200` headers and then the connection closed early after 1,310,720 of 3,145,728 bytes (curl exit 18, "transfer closed with 1835008 bytes remaining"); `Range 0-99` → 206 OK; `Range` inside the missing leaf → 500 (120 B error body); the sibling `index.html` still 200. — measured
- Bucks handler: 502/504 from upstream is converted to the "Content not found… within the timeout" 504 page (unit-tested); mid-stream truncation is not detected (streamed body passed through). — read

### Inferences
- With an embedded node, users will see up to 30 s of blank loading for unreachable CIDs; a progress/“searching peers” UI and a user-configurable timeout would help.
- Availability is the dominant operational risk: a site is only available while some node pins it; GC deletes unpinned content.

### Gaps
- Behaviour with real remote providers (slow peers, partial providers) and DHT provider discovery timing was not measured.
- `Gateway.RetrievalTimeout` custom values not tested.

## Final feasibility verdict per class

### Takeaway
Static sites and hash-router SPAs are feasible today through Bucks' existing handler; history-router SPAs are feasible on a subdomain-form gateway but break under the current Bucks path-gateway proxy; large sites are feasible; dynamic apps needing a backend are not feasible on IPFS alone.

### Cited Findings
- Static site: PASS on path gateway, subdomain gateway and through the Bucks handler (200s, correct content types, redirects rewritten, range support, ETag 304). Caveat: shared-origin on path gateway; Bucks per-CID origin by scheme (code-level, not run).
- SPA with `_redirects` (history router): PASS on subdomain gateway (all deep links 200 in Chromium, 301/302/404 rules work; limits: no forced rules, 64 KiB cap); FAIL on path gateway; FAIL through the current Bucks handler (all deep links and rules return 404).
- SPA with hash router: PASS everywhere, including the Bucks handler (root 200; hash routing is client-side), provided asset URLs are relative.
- Large site (2,500 files / 50 MB): PASS (add 0.64 s, TTFB ~1 ms, ranges work, HAMT automatic and transparent); caveats: multi-range returns first range only, generated listings of big dirs are large, remote retrieval latency not measured.
- Dynamic app needing a backend: NOT FEASIBLE on IPFS alone (no server execution, no POST — gateway is read-only and the Bucks handler returns 405 for non-GET/HEAD); only front-end plus external APIs (CORS `*` is sent by the gateway; Bucks scheme has `corsEnabled`) or p2p/pubsub designs.
- Cross-cutting: updates are cheap (structural sharing) but change the CID; stable addresses need IPNS (offline: fast; public: untested) and per-CID origins mean storage resets on update.

### Inferences
- Decision input: if history-router SPAs are in scope, the browser must either emulate `_redirects` itself or proxy to the subdomain-form gateway; otherwise recommend hash routing at publish time.

### Gaps
- Public-network behaviour (availability, latency, IPNS/DNSLink resolution times) is outside this experiment.

## Gaps for the browser (concrete list)

### Takeaway
Eight concrete gaps in Bucks' IPFS serving relative to Kubo's own subdomain gateway.

### Cited Findings
- G1 SPA fallback and `_redirects`: proxy to `http://<cid-base32>.ipfs.localhost:<gw>` (verified to work from Node `fetch` and to honour `_redirects`), or implement `_redirects` parsing in the handler; add publish-time lint (no `!`, <64 KiB, valid paths). — experiment-derived
- G2 Normalisation for the subdomain form: CIDv0 → CIDv1 base32 (already in `normalizeIpfsUrl`), peer IDs → base36, DNSLink `a.b-c` → `a-b--c` label encoding (untested).
- G3 Service workers disabled for `ipfs://`/`ipns://`: decide whether PWAs are in scope; subdomain gateway supports them (exp 5).
- G4 Security headers: add a default CSP or sandbox policy per origin for content from untrusted CIDs, keep `X-Content-Type-Options: nosniff`, set `charset` for HTML; Kubo adds none.
- G5 Failure UX: 30 s blind wait for unreachable content, truncated 200 responses on missing blocks, 500 for ranges in missing blocks, mislabelled HTML-as-image when a catch-all redirect exists; add progress indicator, retry, and stream-error surfacing.
- G6 Update/stable-origin story: origin changes per deploy for `ipfs://<cid>`; use `ipns://` with sensible TTL, show "update available" for IPNS sites; MFS-published CIDs differ from `ipfs add` CIDs (file leaves are dag-pb vs raw), which matters for reproducible deploy tooling.
- G7 Real Electron verification: run the origin/storage/fetch probes (exp 5) inside Bucks itself and the e2e suite; not possible in this environment (disk full).
- G8 Operational: availability depends on pinning and GC (`--enable-gc` is on in Bucks); add pin management for hosted sites and communicate that unpinned sites vanish.

### Inferences
- G1 and G4 are the highest-impact, lowest-cost changes (handler-level), G3 and G7 need product decisions and Electron-runtime testing.

### Gaps
- Effort estimates are not part of this experiment.
