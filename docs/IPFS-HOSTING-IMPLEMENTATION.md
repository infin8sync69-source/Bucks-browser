# Hosting sites and apps from the browser over ipfs:// and ipns://

Implementation specification. Date: 2026-10-19. Scope: the IPFS hosting infrastructure only; the
blockchain is out of scope. Companion documents: [research report](research/ipfs-native-hosting-architecture.md),
[consolidation plan](https://github.com/infin8sync69-source/Bucks-browser/blob/electron-main/docs/CONSOLIDATION-PLAN.md),
[IPC contract](https://github.com/infin8sync69-source/Bucks-browser/blob/electron-main/docs/IPC-CONTRACT.md)
(both on `electron-main`).

> **Paths in this branch.** The spec was written against `electron-main`, where the code lives in
> `src/main/`. Here (Bucks Core) the ported implementation lives in `electron/hosting/src/main/`, with
> its tests in `electron/hosting/test/`, and `electron/hosting-bridge.js` connects it to the app.

**Goal.** Anyone can take a folder (a website or a client-side web app), publish it from their own Bucks
Browser, and share an address that other Bucks users open as `ipfs://<cid>` (one exact version) or
`ipns://<name>` (an address that follows updates). The publisher's browser is the host while it runs;
optional pinning keeps the site up when it does not.

Evidence labels: **[measured]** = run on this machine on 2026-10-19 with Kubo 0.43.1; **[code]** = read in
this repository at the commit named in the section; **[spec]** = from the IPFS specifications or Kubo
documentation as cited in the research report; **[decision]** = a choice this document makes.

---------------------------------------------------------------------------------------------------

## 1. Terms in plain language

| Term | Meaning here |
|---|---|
| CID | Content identifier: a fingerprint of the bytes. `ipfs://<cid>` is always exactly those bytes, so a visitor can verify what they got. |
| IPNS name | A key pair. The owner signs "this name now points to CID X". `ipns://k51…` stays the same while the content changes. |
| DNSLink | A DNS TXT record pointing a domain name at a CID or IPNS name. Optional, needs a domain. |
| Pinning | Telling a node to keep a CID. Unpinned data is deleted by garbage collection. |
| Provider record | An entry in the public routing system saying "this peer has this CID". Lasts 48 hours, must be re-announced about every 22 hours. |
| Gateway | An HTTP server that turns a CID request into a web response. Bucks has one built in (Kubo's local gateway). |
| Site package | The folder being published, plus an optional `bucks-site.json` (section 5). |

## 2. What the Legrand trial proved

The folder `Legrand SPD Expert-avatar` (a TanStack Start and React app with a 3D viewer, built by Lovable)
was used as the first real test. Your folder was not modified; work was done in a scratch copy.

### 2.1 Steps and results

| Step | Result |
|---|---|
| Inspect | Server-side app: Nitro server build, one server function (`createAvatarEmbed`) that reads a private `LIVEAVATAR_API_KEY` from the server environment. No `.env` files, no secrets in source or in the git history file names. |
| Build as it is | Produces a server bundle (`.output/server`). **Not publishable**: IPFS has no server. |
| Build as a static SPA | Required replacing the Lovable wrapper config with plain TanStack Start in SPA mode (`spa: { enabled: true }`, no Nitro). The wrapper's Nitro layout made the SPA-shell step fail ("Failed to fetch /"). Output: `dist/client`, 12 files, 1.7 MB, an SPA shell named `_shell.html` and no `index.html`. |
| Make it a site | Copy `_shell.html` to `index.html`; add `_redirects` containing `/*  /index.html  200`. |
| Add to Kubo | `ipfs add -r --cid-version 1 --pin`: 0.06 s, 24 blocks, 1.73 MB, root `bafybeidlnkkgdhoyf53rcjqgzu5wupry5vgcc7byvvlftllr7ejddm74y4`. Re-adding identical content gives the same CID **[measured]**. |
| IPNS | Key `legrand-spd` created, published in 0.05 s: `k51qzi5uqu5dk9g7emlrcwkzfd9hukt9u469t2rarlg09ajktddwixu24tmfnp`; resolves to the CID. |
| Browse | `<cid>.ipfs.localhost:8311` and `<k51…>.ipns.localhost:8311` served the app. Rendered in the browser pane: 3D surge protector, trainer, chat. Secure context: yes. |
| Update | Changed the page title: new CID; **1 new file block plus the changed root directory**, the other 23 blocks reused; republished IPNS; the IPNS address served the new title while the old CID still served the old one. Restored afterwards, so the final state is the clean site. |
| Network state | Node ran with `--offline` on loopback only. **Nothing was announced to the public network.** |

### 2.2 Findings that change the design

| # | Finding **[measured]** | Design consequence |
|---|---|---|
| F1 | Extensionless deep links rewritten by `_redirects` (`/deep/link`) return **HTTP 200 with `Content-Type: application/octet-stream`**. A browser downloads the file instead of rendering it. A rewritten `/about.html` returns `text/html`. | Do not rely on the gateway's `_redirects` for SPA fallback. Bucks implements SPA fallback itself and sets the type (section 6.2). |
| F2 | The path gateway form (`/ipfs/<cid>/`) answered 301 to the subdomain form and ignores `_redirects`. | Bucks must serve each site on its own origin, never as a path under one shared origin. The `ipfs://<cid>/` scheme already gives one origin per CID **[code: `protocols/index.js`]**. |
| F3 | The Vite build emits root-absolute asset URLs (`/assets/…`, `/brand/…`). They work on a per-CID origin, and break on a path gateway. | Fine inside Bucks. Preflight warns that the site will not work on `/ipfs/<cid>/` path gateways (section 5.3). |
| F4 | The static build contains no API key, but the server function can never run. The app's first screen made no server call; the avatar embed would fail if opened. | Preflight detects server calls and tells the publisher which features will not work (section 5.3). Secrets must never be placed in a client bundle to "fix" this. |
| F5 | Chromium logged React hydration error 418 (SPA shell hydrates against different markup). The app still worked. | Warn-level only. Not a hosting defect. |
| F6 | Kubo `lowpower` profile sets `Routing.Type = autoclient` and connection limits 20 low / 40 high. The embedded node initialises with this profile **[code: `kubo.js:515`]**. | The node is a DHT client. It can announce what it hosts, but it is not a routing server. Acceptable for hosting; revisit connection limits (section 7.1). |
| F7 | Kubo's `key export` is **not available over the RPC API** (HTTP 404). `key import` is (format `libp2p-protobuf-cleartext`). | Key backup must read the key file from the repository's `keystore` folder in the main process (section 8). |
| F8 | `routing/provide` and `swarm/*` calls fail in offline mode; `dag/export` works (CAR of the 1.73 MB site: 1,735,079 bytes). | Provide only after the node is online; offer CAR export as an offline backup. |

## 3. What exists today and what is missing

State of the final repository at commit `ea4c0f0` **[code]**.

| Area | Today | Missing for hosting |
|---|---|---|
| Node | Kubo sidecar, loopback API and gateway, `Pubsub` and mDNS on, `Peering.Peers` for paired devices (`ipfs/kubo.js`, `applyBucksConfig`). | No Routing, Provide, AutoNAT, relay, hole-punch, `StorageMax` or gateway settings. |
| RPC wrapper | `add` for **a single file or text**, `cat`, `ls`, `pinAdd/Rm/Ls`, `nameResolve`, `dnsResolve`, peering, pubsub, config (`ipfs/rpc.js`). | Directory add, key management, `name/publish`, `routing/provide`, `dag/export`, `pin/remote/*`, `refs`. |
| Serving | `ipfs://` and `ipns://` proxy to the **path** gateway, with redirect rewriting and error pages (`protocols/ipfs.js`). Silent fallback to `https://ipfs.io` when the node is not ready. | SPA fallback, content-type repair, `_redirects`, consent for public fallback, verification, "content unavailable" experience. |
| UI | `bucks://ipfs` dashboard: status, add file, browse, pin. | No site publishing flow, no site list, no health view. |
| Names | `ipns://` resolution only. | No key creation, no publish, no republish, no backup. |
| Agent | `ipfs_upload_text` and `dweb_publish` tools exist in the Soul Engine but run **without approval** and point to a Bucks Core backend that this repository does not provide. | Electron-side tools with approval (section 11). |

## 4. Architecture

```
 Chrome UI (new web-component chrome)          Main process                         Kubo (loopback)
 ┌──────────────────────────────┐   IPC    ┌────────────────────────────┐  RPC   ┌──────────────────┐
 │ Host a site wizard           │─────────▶│ sites service              │───────▶│ add / pin / key  │
 │ Sites dashboard, health      │◀─────────│  preflight, publish,       │        │ name/publish     │
 └──────────────────────────────┘  events  │  update, rollback, backup  │        │ routing/provide  │
                                           │ ipfs protocol handler      │◀──────▶│ gateway :8080    │
 Visitor tab  ipfs://<cid>/…  ───────────▶ │  SPA fallback, headers     │  HTTP  └──────┬───────────┘
              ipns://<name>/… ───────────▶ │  origin per CID / name     │               │ libp2p
                                           └────────────────────────────┘               ▼
                                                                          peers, delegated routers,
                                                                          paired devices, pinning services
```

Principles **[decision]**:
1. The renderer never touches the file system or Kubo. It asks the main process, which owns the folder
   dialog, the walk, the upload and the keys.
2. Every hosted site is served from its own origin (`ipfs://<cid>` or `ipns://<name>`).
3. Public gateways are never used silently. The user gives consent per use.
4. The local node is the source of truth. Pinning services and other devices are extra copies.

## 5. Site package

### 5.1 Layout

The publisher chooses the **output folder** (for example `dist/client`, `dist`, `build`, `out`, `public`).
The wizard detects likely output folders inside a project and suggests one. Rules:

- `index.html` at the root is the entry. If `_shell.html` exists and `index.html` does not, offer to
  copy it (the TanStack Start SPA case, F1 and section 2).
- All files are published as they are. Nothing is minified or rewritten.
- Hidden files and folders are excluded by default (`.git`, `.env*`, `.DS_Store`, `.claude`, and so on).
  `_redirects` is allowed.

### 5.2 `bucks-site.json` (optional, in the site root)

```json
{
  "name": "Legrand SPD trainer",
  "entry": "index.html",
  "spa": true,
  "notFound": "404.html",
  "headers": { "/*": { "X-Content-Type-Options": "nosniff" } },
  "csp": "default-src 'self'; img-src 'self' data: https:; connect-src 'self' https:",
  "serviceWorker": false
}
```

| Key | Default | Meaning |
|---|---|---|
| `entry` | `index.html` | File served at `/`. |
| `spa` | `false` | Serve `entry` with status 200 for navigations to paths that do not exist. |
| `notFound` | none | File served with status 404 when nothing matches and `spa` is false. |
| `headers` | none | Extra response headers per path pattern. `Content-Security-Policy` here replaces the default. |
| `csp` | none | Shortcut for the CSP header. When absent Bucks adds none (apps break under blanket CSPs). The preflight recommends one. |
| `serviceWorker` | `false` | Reserved. Service workers are disabled for `ipfs://` and `ipns://` today (`allowServiceWorkers: false`). |

Compatibility **[decision]**: if there is no manifest but a valid `_redirects` file, Bucks reads it
(section 6.3), so sites built for other IPFS gateways keep working. The manifest wins when both exist.

### 5.3 Preflight checks

Run in the main process before anything is uploaded. Each result is `block`, `warn` or `info`, with an
action the user can take.

| ID | Level | Check | Action offered |
|---|---|---|---|
| P1 | block | No entry file (`index.html`/manifest `entry`). | Pick another folder; if `_shell.html` exists, "Use it as index.html". |
| P2 | block | Symbolic links, or any path that resolves outside the folder. | Remove from the list. Links are never followed. |
| P3 | block | Secret-like files: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.git/`, `credentials*`, `*.p12`. | Exclude (default) or cancel. |
| P4 | block | Secret-like content in text files: private key blocks, `sk-…`, `AIza…`, `ghp_…`, database URLs with passwords, long values assigned to `api_key`, `token`, `secret`. | Show file and line (never the value); exclude or cancel. |
| P5 | block | Over quota: total size above the site quota (default 500 MiB) or more than 50,000 files. | Reduce, or raise the quota in Settings. |
| P6 | warn | Server calls: strings such as `/_serverFn/`, `createServerFn`, same-origin `fetch('/api/…')`. | "These features need a server and will fail. Hide or replace them." (the Legrand avatar case) |
| P7 | warn | History-router SPA without `spa: true` or `_redirects`. Detected when `index.html` loads a module script and no other HTML files exist. | "Turn on single-page-app mode" (writes `spa: true` into the manifest). |
| P8 | warn | Service worker registration (`serviceWorker.register`). | "Not supported in Bucks yet." |
| P9 | warn | Root-absolute URLs (`src="/…"`, `href="/…"`). | "Works in Bucks and on subdomain gateways, not on `/ipfs/<cid>/` path gateways." |
| P10 | warn | `http://` subresources (mixed content). | Show list. |
| P11 | info | External hosts the page loads from (CDNs, fonts, analytics). | "Visitors' browsers contact these hosts." |
| P12 | info | Large files (above 25 MiB) and uncompressed media. | Suggest compression. |

The checks are pure functions over a file list and file contents, so they run under plain Node in unit tests.

## 6. Serving (the `ipfs://` and `ipns://` handler)

Changes to `src/main/protocols/ipfs.js` **[decision]**.

### 6.1 Addressing and origins

- `ipfs://<cid>/…`: host must be a CID; CIDv0 is normalised to CIDv1 base32 first (hostnames are
  case-insensitive). One origin per CID.
- `ipns://<name>/…`: `<name>` is a base36 `k51…` key (62 characters, fits one DNS label), a
  `12D3Koo…` peer ID normalised to base36, or a DNSLink domain. One stable origin per name; storage
  survives updates **[measured]**.
- Guidance for publishers: use the CID address for fixed documents, the IPNS address for apps that keep
  state in `localStorage`/`IndexedDB`. The CID address loses storage on every update.

### 6.2 SPA fallback and content type (fixes F1)

Order of work for a request:

1. Forward the path to the node as today. If the response status is 200, 206 or 304, pass it through,
   except step 4.
2. If the status is 404 and all of these hold, serve the fallback: method is GET; `Accept` contains
   `text/html`; the last path segment has no file extension; the site descriptor (section 6.3) enables
   fallback; the descriptor's `entry` exists.
3. Fallback response: body of `entry`, status 200, `Content-Type: text/html; charset=utf-8`,
   `Cache-Control: public, max-age=0, must-revalidate` for `ipns://`, `public, max-age=31536000, immutable`
   for `ipfs://`.
4. Content-type repair: if the upstream type is `application/octet-stream`, the path has no extension and
   the first 512 bytes look like HTML, answer `text/html; charset=utf-8`.
5. Otherwise a 404 uses `notFound` from the descriptor, or the standard Bucks error page.

Do not use the subdomain-form workaround (`http://<cid>.ipfs.localhost:<port>`): it honours `_redirects`
but still returns the wrong type for extensionless paths **[measured]**, and base32/base36 label limits
add failure cases.

### 6.3 Site descriptor discovery

On the first request for a resolved root, read `/bucks-site.json` (limit 64 KiB), else `/_redirects`
(limit 64 KiB, 100 rules), cache the parsed result by resolved root CID for the life of the process.
`_redirects` subset: `from to [status]` per line; `*` and `:param` placeholders; status 200 (rewrite),
301/302 (redirect), 404 (custom page); the first match wins; forced rules (`!`) are rejected with a logged
warning. A rule `/*  /index.html  200` is treated as `spa: true`.

### 6.4 Response headers

Forward the existing list. Add `X-Content-Type-Options: nosniff` for every response that has a known type.
Apply manifest `headers`. Never forward `Content-Security-Policy` from a gateway that is not the local node.

### 6.5 Fallback gateway policy (replaces the silent fallback)

Default `ipfs.preferredGateway` stays `local`, and the fallback to `ipfs.publicGateway` changes **[decision]**:

- The local node not ready: show an interstitial "Your node is not running. Start it, or load this page
  through a public gateway. The gateway will see the address you request and your IP." Buttons: Start node
  (default), Use public gateway once, Always ask.
- Public responses are not verified by the browser. When consent is given, request
  `Accept: application/vnd.ipld.car` (trustless gateway) and verify blocks against the CID, or show a
  persistent "unverified" badge.
- Validate `ipfs.publicGateway` as `https://` on a public host.

### 6.6 Visitor experience when the host is offline

Provider lookup that finds nobody ends in a 504 after about 30 s **[measured]**. The error page says:
"No online node has this content right now. The publisher's browser may be closed." It shows the CID or
name, a Retry button and, for `ipns://`, the sequence number and age of the newest record found. Set
`Gateway.NoFetch=false` for the local gateway used by visitors (default) but `NoFetch=true` on any
gateway reachable by pages other than the handler.

### 6.7 Address bar badges

| State | Badge |
|---|---|
| `ipfs://<cid>` served and verified by the local node | "Content-addressed" |
| `ipns://<name>` record verified | "Signed name, updates allowed" with the current CID on hover |
| Public gateway used (with consent) | "Unverified, via gateway" |
| Preview of unpublished site | "Preview, not published" |

## 7. Node configuration for hosting

### 7.1 Settings applied by `applyBucksConfig`

| Key | Value | Reason |
|---|---|---|
| `Routing.Type` | `auto` | Client or server by reachability. The `lowpower` profile forces `autoclient` (F6); init the repo without `lowpower` for new installs, leave existing repos on their profile. |
| `Routing.AcceleratedDHTClient` | `false` | Crawls the DHT hourly; unsuitable for laptops. |
| `Provide.Strategy` | `pinned` | Announce only content the user pinned, not everything browsed. |
| `Swarm.ConnMgr` | low 50, high 150 | `lowpower` values (20/40) starve a host. |
| `Swarm.RelayClient.Enabled`, `Swarm.EnableHolePunching`, `AutoNAT` | keep Kubo defaults (on) | About 70% hole-punch success once a relay reservation exists; 36% of NATed peers never get one (research report). |
| `Datastore.StorageMax` | user quota, default 10 GB | Garbage collection never removes pins. |
| `Gateway.NoFetch` | `false` for the local handler gateway | Visitors fetch through it. |
| `Ipns.RecordLifetime`, `Ipns.RepublishPeriod` | defaults (48 h, 4 h per Kubo docs) | Kubo republishes owned names while the node runs. |
| `Ipns.DelegatedPublishers`, `Routing.DelegatedRouters` | keep `auto` for now | Uses public delegated routers so other nodes can find records and providers; **maintainers of those services have left** (research report), so add Bucks-run endpoints as a second entry (Phase 4). |

Pin Kubo to a specific version with a SHA-512 embedded in the repository; do not download "latest"
(`scripts/fetch-kubo.mjs`). Update deliberately.

### 7.2 RPC wrapper additions (`src/main/ipfs/rpc.js`)

| Method | Kubo call | Notes |
|---|---|---|
| `addDirectory(files, onProgress)` | `POST /api/v0/add?recursive=true&cid-version=1&raw-leaves=true&pin=true&wrap-with-directory=false&progress=true` | Multipart; one part per file, `filename` = percent-encoded relative path (`site%2Fassets%2Fx.js`); last NDJSON entry is the root directory **[measured]**. Stream file contents with `fs.openAsBlob`; do not buffer. |
| `keyGen(name)` | `key/gen?arg=<name>&type=ed25519` | |
| `keyList()` | `key/list?l=true&ipns-base=base36` | Returns `k51…` ids. |
| `keyRm(name)` | `key/rm?arg=<name>` | Only after explicit user confirmation. |
| `keyImport(name, bytes)` | `key/import?arg=<name>&format=libp2p-protobuf-cleartext` | Multipart body. |
| `namePublish(name, cid, {lifetime, ttl, allowOffline})` | `name/publish?arg=/ipfs/<cid>&key=<name>&lifetime=48h&ttl=5m&resolve=false` | `allow-offline=true` only when the node is in offline mode. |
| `provide(cid)` | `routing/provide?arg=<cid>&recursive=true` | Online only. |
| `dagStat(cid)` | `dag/stat?arg=<cid>&progress=false` | Size and block count. |
| `dagExport(cid)` | `dag/export?arg=<cid>` | Streams a CAR. |
| `refs(cid)` | `refs?arg=<cid>&recursive=true&unique=true` | Update diff. |
| `pinRemoteAdd/Ls/Rm`, `pinRemoteServiceAdd/Rm/Ls` | `pin/remote/*` | Pinning Service API (section 9.3). |
| `bitswapStat`, `swarmAddrsLocal`, `id` | `bitswap/stat`, `swarm/addrs/local`, `id` | Health (section 9.1). |

## 8. Sites service (main process, new `src/main/sites/`)

### 8.1 Data model

Stored in the user profile as `sites.json` (written atomically, schema-versioned):

```json
{
  "version": 1,
  "sites": [{
    "id": "s_3f9c…",
    "name": "Legrand SPD trainer",
    "sourceDir": "/Users/…/dist/client",
    "keyName": "site-s_3f9c",
    "ipns": "k51qzi5uqu5dk9g7…",
    "current": { "cid": "bafybei…", "publishedAt": "2026-10-19T10:00:00Z", "bytes": 1734097, "files": 12 },
    "history": [{ "cid": "…", "publishedAt": "…", "bytes": 0, "files": 0, "note": "" }],
    "hosting": { "keepOnline": true, "pinToDevices": ["12D3Koo…"], "pinningServices": ["pinata"] },
    "quotaBytes": 524288000,
    "backup": { "keyBackedUpAt": null }
  }]
}
```

`sourceDir` is a path the main process obtained from its own folder dialog; the renderer only ever holds
the site `id`. Keys never leave Kubo's keystore except through the backup flow below.

### 8.2 Publish pipeline

1. **Inspect.** Walk `sourceDir` with `lstat`; build the file list; apply exclusions; run P1–P12.
2. **Add.** `addDirectory` streams the files and reports progress; the final entry is the root CID. The
   node is pinned recursively as part of the call.
3. **Self-test.** Through the same handler used by tabs, request `ipfs://<cid>/` and the entry file; the
   status must be 200 with `text/html`. If the manifest enables `spa`, also request a synthetic path
   (`/__bucks_probe__/x`) and expect the entry with 200.
4. **Name.** If the site has no key: `keyGen`; store `ipns`. Then `namePublish(cid)`.
5. **Announce.** If the node is online: `provide(cid)`; the node's reprovider keeps announcing pinned roots.
6. **Record.** Append to `history`; set `current`. Keep the previous root pinned (rollback) until the
   history limit (default 5) trims it.
7. **Report.** Emit progress events (section 10) and return the links.

Atomicity: the IPNS publish is the last step that changes what visitors see. A failure before it leaves
the previous version live.

### 8.3 Update and rollback

- **Update**: same pipeline from the remembered `sourceDir` (or a newly chosen folder). Show a diff before
  publishing: files added, changed, removed (by path and size), blocks new versus reused (`refs`).
- **Rollback**: choose an entry in `history`; `namePublish` to that CID. The CID address of any version
  never changes.
- **Unpublish**: three explicit choices: stop updating (keep the content), unpin (content disappears
  from this node, other copies remain), delete the key (the `ipns://` address is permanently dead).
  The last one needs a typed confirmation.

### 8.4 Key backup and restore (F7)

- Backup: the main process reads `<repo>/keystore/<keyName>`, encrypts it with a user-chosen
  passphrase (scrypt plus AES-256-GCM), and saves it to a path from a save dialog. The passphrase is
  never stored.
- Restore: decrypt, then `keyImport(name, bytes)`; verify that `key/list` returns the same `k51…` id
  as recorded for the site.
- The wizard asks for a backup at the end of the first publish and the dashboard shows "key not backed
  up" until done. Losing the key means losing the ability to update the `ipns://` address.

## 9. Availability and health

### 9.1 Health states per site

| State | Test | Meaning for visitors |
|---|---|---|
| Local only | Node offline or not announced | Only this computer can open it. |
| Announcing | `provide` succeeded or reprovider running | Others may find it soon (DHT lookups average about 0.3 s once announced). |
| Discoverable | A public delegated router's `/routing/v1/providers/<cid>` lists this node's peer ID | Others can find the host. |
| Reachable | A probe fetches the root block from outside (trustless gateway `?format=raw` through a Bucks-run probe) | Others can fetch the content. |
| Redundant | At least two independent providers (device or pinning service) | Survives this computer going to sleep. |

The dashboard shows the highest state reached and the one check that failed. The probe sends only the
CID and our peer ID, never file names.

### 9.2 Durability tiers

| Tier | How | When |
|---|---|---|
| 1. This computer | Local pin; node must be running | Always |
| 2. Own devices | Paired devices (existing pairing, `devices.autoPin`) pin the root, with a per-device quota | Offered after publish |
| 3. Always-on anchor | A Bucks-run Kubo that follows the user's `ipns://` name and pins the target; started by the user's own server or a community pool | Phase 4 |
| 4. Pinning service | Pinning Service API: `pin/remote/service/add` with the user's endpoint and token; `pin/remote/add` for each version | Optional; token stored in the OS keychain |

A model with each laptop online 30 to 50% of the time gives roughly 66 to 88% availability with three
independent copies. This is arithmetic, not a measurement; tier 3 or 4 is needed for a site that must
always load.

### 9.3 Pinning service handling

Never store a token in `settings.json`. Use Electron `safeStorage`. Show which versions are pinned
remotely and their status (`queued`, `pinning`, `pinned`, `failed`).

## 10. IPC contract additions

All channels check that the sender is the chrome (`bucks://app`), as the wallet proxy already does.
The renderer never passes file system paths except as the result of a main-process dialog.

| Channel | Payload | Returns |
|---|---|---|
| `bucks:sites:choose-folder` | none | `{ token, name, hints: { suggestedDir, framework } }` after a native dialog |
| `bucks:sites:inspect` | `{ token }` | `{ files, bytes, checks: [{id, level, message, fix?}] }` |
| `bucks:sites:preview` | `{ token }` | `{ previewCid }` (added unpinned, opened in a private tab) |
| `bucks:sites:publish` | `{ token, name, ipns: boolean, hosting }` | `{ id, cid, ipns, urls }` |
| `bucks:sites:update` | `{ id, token? }` | `{ cid, diff }` |
| `bucks:sites:list` | none | site records |
| `bucks:sites:status` | `{ id }` | health state and the failing check |
| `bucks:sites:rollback` | `{ id, cid }` | `{ cid }` |
| `bucks:sites:unpublish` | `{ id, mode, confirm? }` | `{ ok }` |
| `bucks:sites:backup-key` / `restore-key` | `{ id }` | `{ ok }` (dialogs run in main) |
| `bucks:sites:export-car` | `{ id }` | `{ path }` |
| `bucks:sites:progress` (event) | `{ id, step, done, total, message }` | Steps: `inspect`, `add`, `self-test`, `name`, `announce`, `record` |

Add `window.bucks.sites.*` to the preload bridge and the types to `docs/IPC-CONTRACT.md`.

## 11. Agent integration

The Soul Engine may propose hosting actions; it never performs them.

- Remove the engine's own `ipfs_upload_text` and `dweb_publish` execution paths. Register Electron-side
  tools `site_inspect`, `site_publish`, `site_update`, `site_status` that call the sites service.
- `site_publish` and `site_update` always show the same approval card as the wizard (site name, folder,
  file count, size, preflight warnings, whether a public address will be created). The approval is
  rendered by the trusted shell, not by text the engine supplies.
- Tools receive folder access only through the folder dialog or an already-approved site `id`.
- Page text and tool output are untrusted: they never alter the approval card, the target folder or the
  hosting options.

## 12. User flows

### 12.1 Host a site (first time)

Entry points: menu "Host a site…", `bucks://sites`, dropping a folder on the window, `/publish` in the
agent bar.

| Step | Screen | What the user does | What the app does |
|---|---|---|---|
| 1 | **Choose** | Drops or selects the site folder (or a project folder). | Detects likely output folders (`dist/client`, `dist`, `build`, `out`, `.output/public`) and suggests one. Shows detected framework and whether it is static. |
| 2 | **Check** | Reads the result list; clicks fixes. | Runs P1–P12. Blocking items prevent continuing. "Use `_shell.html` as `index.html`" and "Turn on single-page-app mode" are one click. Example shown for Legrand: warn P6 "The avatar needs a server and will not work". |
| 3 | **Preview** | Clicks "Preview". | Adds the folder unpinned and opens `ipfs://<cid>` in a private tab with the banner "Preview, not published". |
| 4 | **Address** | Names the site; keeps "Updatable address" on. | Explains: permanent link (CID) is always created; updatable address (IPNS) lets visitors keep the same link after updates. |
| 5 | **Hosting** | Chooses "Keep online from this computer" (default); optionally adds paired devices or a pinning service. | Shows plain consequences: "People can open your site while Bucks is running here." |
| 6 | **Publish** | Waits. | Shows steps with checkmarks: Checking, Adding files, Testing, Creating address, Announcing. |
| 7 | **Done** | Copies the link or shows the QR code; clicks "Test from outside". | Shows `ipns://k51…` and `ipfs://bafy…`, health state, and a prompt to back up the key. Offers "Open in a new tab". |

For a 1.7 MB site the add and name steps took about 0.11 s together on loopback **[measured]**; the rest of the
time is the user's decisions.

### 12.2 Update

1. Open `bucks://sites`, choose the site, click "Update".
2. The app re-reads the remembered folder (or asks for a new one) and runs the checks.
3. It shows the diff: added, changed, removed, new blocks versus reused.
4. The user confirms; the app publishes and republishes the name; history gains an entry.
5. The IPNS link now serves the new version; the old CID link still serves the old one.

### 12.3 A visitor opens the site

1. The visitor types or pastes `ipns://k51…` or `ipfs://bafy…` (or scans the QR code).
2. Bucks resolves the name, finds providers, streams the content, shows the badge (section 6.7).
3. If nobody is online: the "No online node has this content" page with Retry.
4. Visitors who do not have Bucks can be given a gateway link (`https://<cid>.ipfs.<gateway>`), shown
   with a note that public gateway availability is not guaranteed.

### 12.4 Manage and recover

- **Dashboard (`bucks://sites`)**: one card per site: name, links, health state, last published,
  size, hosts, key backup status, buttons Update, Rollback, Export CAR, Unpublish.
- **New computer**: install Bucks, open "Restore a site", choose the key backup and passphrase, import the
  CAR or let the node fetch the current CID from the network, then continue publishing.
- **Computer sleeps**: the dashboard shows "Redundant: no" with a one-click "Add my other device".

### 12.5 Error copy (examples)

| Case | Message |
|---|---|
| No entry file | "This folder has no index.html. Pick the folder that contains your built site." |
| Secrets found | "Found files that look like private keys or passwords: .env, id_rsa. They will not be published." |
| Server calls | "This app calls a server (/_serverFn/…). Those features will not work on IPFS." |
| Node offline | "Your IPFS node is not running. Start it to publish." |
| Not reachable | "Your site is saved on this computer but other people cannot reach it yet. Check your network or add a pinning option." |

## 13. Security

| Threat | Control |
|---|---|
| Malicious or accidental folder content (symlinks, huge trees, secrets) | P2–P5; `lstat` walk; no link following; quota; secrets excluded by default |
| Renderer asks the main process to read arbitrary files | Folder access only through a main-process dialog token |
| A published site reads another site's data | One origin per CID and per name; `corsEnabled` stays as is; no `bypassCSP` |
| Silent leak to a public gateway (CID, path, IP) | Consent interstitial, section 6.5 |
| Spoofed or unauthenticated IPC | Sender check on every `bucks:sites:*` channel |
| Agent publishes without consent | Section 11 |
| Lost or stolen IPNS key | Encrypted backup; "delete key" needs typed confirmation; keys only in Kubo's keystore |
| Provider IP exposure | Disclosed at the "Hosting" step; relay-only mode is a later option |
| Illegal or abusive content | Enable a denylist (NOpfs, compact denylist format) by default for content the node serves; a Bucks-run gateway needs an abuse contact. Legal review needed before wide release |
| Kubo vulnerabilities and unmaintained upstream | Pinned version with checksum; scheduled review; monitor advisories |

## 14. Tests and acceptance

Unit (plain Node): preflight rules P1–P12; `_redirects` parser; manifest validation; SPA fallback
decision function; content-type repair; site store (atomic writes, migrations); key backup crypto
round-trip.

Integration (real Kubo, offline, loopback), reusing the harness from `test/e2e`:
- add a generated site (static, hash-router, history-router with `spa: true`, 2,000 files, one 50 MB file);
- assert 200 and type for the entry, a deep link, a missing asset (404), range request on the large file;
- update one file and assert exactly one new leaf block plus new directory nodes;
- publish, resolve and republish IPNS; assert the IPNS origin keeps `localStorage` across an update;
- assert a missing block is reported as an error and not as a silently truncated 200 (known Kubo
  behaviour **[measured]**: it truncates mid-stream; the handler must detect a short body against
  `Content-Length` and abort the stream).

End-to-end (Playwright, Electron 44): the seven user flows above; unpublished preview banner; consent
interstitial; approval card for agent publish.

**Fixture rule.** The Legrand build is the reference manual test, but its content is not committed to this
repository. Tests generate their own sites.

Acceptance by phase is listed in section 15.

## 15. Work packages and order

Effort in person-days; all are estimates, not measurements. Work packages 1 to 8 are main-process work and
can start now, in parallel with the Svelte removal. Only package 9 depends on the new chrome.

| # | Package | Files | Days | Depends on |
|---|---|---|---|---|
| 1 | Node profile and config keys, pinned Kubo with embedded checksum | `ipfs/kubo.js`, `scripts/fetch-kubo.mjs`, `ipfs/dist.js` | 3 | none |
| 2 | RPC additions (section 7.2) | `ipfs/rpc.js` + tests | 4 | none |
| 3 | Site package: manifest, `_redirects` parser, preflight P1–P12 | `src/main/sites/package.js`, `preflight.js` | 5 | none |
| 4 | Publish, update, rollback, history, store | `src/main/sites/service.js`, `store.js` | 6 | 2, 3 |
| 5 | Handler: SPA fallback, content-type repair, truncated-body abort, consent interstitial, badges | `protocols/ipfs.js` | 5 | 3 |
| 6 | Health states, probes, device pinning, pinning-service client | `src/main/sites/health.js`, `ipfs/devices-service.js` | 7 | 2, 4 |
| 7 | Key backup and restore | `src/main/sites/keys.js` | 3 | 2 |
| 8 | IPC, preload bridge, sender checks, contract doc | `ipfs/ipc.js`, `preload.cjs`, `docs/IPC-CONTRACT.md` | 2 | 4 |
| 9 | UI: wizard, dashboard, health, visitor pages, badges | new `chrome/` | 9 | 8, chrome shell |
| 10 | Agent tools with approval; delete unsafe tools | `agent/`, `src/main/agent/` | 3 | 8 |
| 11 | Tests (section 14) | `test/unit`, `test/e2e` | 6 | all |
| 12 | Docs, installer notes, release | `docs/`, `scripts/` | 2 | all |
| | **Total** | | **55** | about 11 weeks for one developer, less in parallel |

Milestones:
- **M1 (packages 1 to 5, about 3 weeks):** an engineer can publish a folder from a script, open it at
  `ipfs://<cid>` in Bucks including SPA deep links, and update it through IPNS. Acceptance: the Legrand
  build loads, and `/deep/link` renders instead of downloading.
- **M2 (6 to 8, about 2 more weeks):** health states, durability tiers, key backup, secure IPC.
- **M3 (9 to 12):** the full user flow in the browser, agent approval, tests, release.

## 16. Risks and open decisions

| # | Decision or risk | Recommendation |
|---|---|---|
| D1 | Public routers and gateways are degrading after the upstream maintainers left | Run at least one Bucks delegated router and one always-on anchor (tier 3) before encouraging public use |
| D2 | Service workers are off for `ipfs://` | Keep off for now; enabling them needs tests on Electron 44 and a per-site opt-in |
| D3 | Default storage quota (10 GB) and site quota (500 MiB) | Keep; expose both in Settings |
| D4 | Content moderation posture for a node that serves others' content | Denylist on by default; needs legal review |
| D5 | Gateway links for non-Bucks visitors | Offer, with the availability warning; later run own gateway |
| D6 | Key custody for non-technical users | Encrypted backup file is mandatory prompt; consider OS keychain-wrapped keys |
| D7 | Apps that need a backend (the Legrand avatar) | Document as "client-side only"; later a signed-request proxy pattern, never secrets in bundles |

## Appendix A. Trial record

Environment: macOS arm64, Node 26.3, Kubo 0.43.1 (SHA-512 verified from the project's fetch script
earlier in the session), loopback ports 5311 (API) and 8311 (gateway), offline mode.

| Item | Value |
|---|---|
| Source | Legrand SPD Expert-avatar (TanStack Start 1.168, React 19, three.js), copied to scratch; `node_modules` reinstalled with `npm ci --legacy-peer-deps` because the shipped folder lacked macOS native binaries |
| Build config | `tanstackStart({ spa: { enabled: true } })` with Vite 7.3.6, no Nitro; build 6 s |
| Output | 12 files, 1.7 MB (`index-*.js` 1.0 MB, second chunk 340 KB) |
| Root CID | `bafybeidlnkkgdhoyf53rcjqgzu5wupry5vgcc7byvvlftllr7ejddm74y4` (24 blocks, 1,734,097 bytes) |
| IPNS name | `k51qzi5uqu5dk9g7emlrcwkzfd9hukt9u469t2rarlg09ajktddwixu24tmfnp` (local trial key, offline, not announced) |
| Add / IPNS publish time | 0.06 s / 0.05 s |
| Gateway results | `/` 200 text/html; `/assets/*.js` 200 text/javascript, `immutable`; images 200; IPNS responses `max-age=300`; `/deep/link` 200 but `application/octet-stream` (F1) |
| Update | New CID, 1 new file block plus the changed root; IPNS served the new version, old CID kept the old |
| Browser check | Rendered with secure context, one canvas (3D viewer); one console error (React hydration 418) |
| Cleanup | Kubo stopped; no process left running |

To repeat the hosting on another machine with Kubo: `ipfs dag import legrand-spd.car`, then
`ipfs pin add <cid>`; the folder and CAR are in the local `hosting-trial/` directory (not committed,
because they contain the client's build).
