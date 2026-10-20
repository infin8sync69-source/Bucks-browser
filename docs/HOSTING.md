# Hosting sites from Bucks

Publish a folder (a website or a client-side web app) from your own Bucks Browser and share an
address that other Bucks users open as `ipfs://<cid>` (one exact version) or `ipns://<name>` (an
address that follows your updates). Your browser is the host while it runs; your other devices or a
pinning service keep the site up when it does not.

Design and rationale: [IPFS-HOSTING-IMPLEMENTATION.md](IPFS-HOSTING-IMPLEMENTATION.md).
Channels and shapes: [IPC-CONTRACT.md](IPC-CONTRACT.md#sites-hosting-a-folder-from-this-browser).

## What works today

Everything in the main process is in place and tested against a real Kubo 0.43.1 and in the real
app (`test/e2e/hosting.test.mjs`): checks, publish, update with a diff, rollback, unpublish,
preview, key backup and restore, CAR export, health, device and pinning-service copies, the
`ipfs://` handler rules, the consent interstitial and the address bar badge data, and the agent's
hosting tools with approval cards.

**Not built yet:** the screens (the "Host a site" wizard, the `bucks://sites` dashboard, the badge
in the address bar, the approval card for `site_*` tools). They belong to the new framework-free
chrome (work package 9, [CONSOLIDATION-PLAN.md](CONSOLIDATION-PLAN.md)); the current Svelte
chrome is frozen. Until then you publish from the command line or from the agent, and the
existing approval card shows the main process's description of what will be published.

## Publish from the command line

`scripts/site.mjs` uses the same service, profile and node as the browser. If Bucks is running its
node is used (and left running); otherwise the script starts the node on your Bucks profile and
stops it afterwards.

```sh
node scripts/site.mjs inspect ~/projects/my-app          # checks only
node scripts/site.mjs publish ~/projects/my-app --name "My app" --spa
node scripts/site.mjs backup-key s_1a2b3c4d5e ~/my-app.bucks-key
node scripts/site.mjs update s_1a2b3c4d5e                 # shows the diff, asks, publishes
node scripts/site.mjs list | status <id> | rollback <id> <cid> | export-car <id> <file>
node scripts/site.mjs unpublish <id> stop|unpin|delete-key [--confirm "<site name>"]
```

You may pick the project folder: Bucks finds the build output (`dist/client`, `dist`, `build`,
`out`, `.output/public`, `public`) and says when the project builds a server it cannot run.
`--user-data <dir>` (or `BUCKS_USER_DATA`) picks another profile; `--offline` starts the node
without network.

## The folder

- `index.html` at the root is the entry. A TanStack Start SPA build has `_shell.html` instead:
  `--shell-as-index` publishes it as `index.html`.
- Files are published as they are. **Your folder is never modified**: fixes such as
  `--shell-as-index` and `--spa` change the published copy only.
- Hidden files and folders are left out (`.git`, `.env*`, `.DS_Store`, …), except `.well-known`.
  `_redirects` is published. Symbolic links are never followed or published.
- Limits: 500 MiB and 50,000 files per site (Settings: `sites.quotaMiB`, `sites.maxFiles`).

### `bucks-site.json` (optional)

```json
{
  "name": "My app",
  "entry": "index.html",
  "spa": true,
  "notFound": "404.html",
  "headers": { "/*": { "X-Frame-Options": "DENY" } },
  "csp": "default-src 'self'; img-src 'self' data: https:"
}
```

An `"app"` section makes the site an installable app as well (name, version, icon, permissions,
agent tools): see [APP-ENVIRONMENT.md](APP-ENVIRONMENT.md). Any Bucks user can install it from your
`ipns://` address and run it in its own container; it follows your updates.

`spa: true` serves the entry for page navigations to paths that do not exist (deep links of a
history router), while a missing `/assets/x.js` still answers 404. Without a manifest, a
`_redirects` file is honoured (`from to [status]`, `*` and `:param`, statuses 200, 301, 302, 404;
`/* /index.html 200` means `spa: true`; forced `!` rules are ignored). Sites never set cookies,
`Location`, framing or IPFS headers.

### Checks before anything is uploaded

| | Level | What |
|---|---|---|
| P1 | block | No entry file (one-click fix when `_shell.html` exists) |
| P2 | block, handled | Symbolic links and special files: never published |
| P3 | block, handled | Files that look like keys or passwords (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.git/`, `credentials*`, `*.p12`): left out |
| P4 | block | Text that looks like a secret (private keys, `sk-…`, `AIza…`, `ghp_…`, database URLs with passwords, long values assigned to `api_key`/`token`/`secret`): shown by file and line, never the value; exclude the file or cancel |
| P4-firebase | warn | The `apiKey` of a Firebase web config (next to `authDomain`, `projectId`, …): public by design, so it does not block; restrict the key to the Firebase APIs in the Google Cloud console and protect data with Security Rules and App Check. Any other `AIza…` key still blocks |
| P5 | block | Over the quota |
| P6 | warn | Calls to a server (`/_serverFn/`, `createServerFn`, `fetch('/api/…')`): those features will not work |
| P7 | warn | A history-router SPA without SPA mode (one-click fix) |
| P8 | warn | A service worker (not supported for `ipfs://` yet) |
| P9 | warn | Root-absolute links: fine in Bucks, broken on `/ipfs/<cid>/` path gateways |
| P10 | warn | `http://` subresources |
| P11 | info | Hosts visitors' browsers will contact |
| P12 | info | Files over 25 MiB, uncompressed media |

## Publishing, updating, rolling back

Publishing adds the files (pinned), **tests the new version through the same `ipfs://` handler
tabs use**, creates the `ipns://` key and points it at the version, announces the content when the
node is online, and records it. A failure before the IPNS step leaves the previous version live
and removes what this attempt created.

An update first shows the diff (files added, changed, removed; blocks new and reused) without
publishing anything; confirming publishes exactly the reviewed version (if the folder changed in
between, it asks again). The last `sites.historyLimit` (5) versions stay pinned for rollback. An
`ipfs://<cid>` link never changes; the `ipns://` address follows the current version.

Use the `ipns://` address for apps that keep data in `localStorage` or IndexedDB: each `ipfs://`
version is its own origin, so its storage does not carry over to the next version.

## Keep your key

The `ipns://` address is a key in your node. **Without the key you can never update the address
again.** `backup-key` encrypts it with a passphrase you choose (scrypt and AES-256-GCM); the
passphrase is never stored. On a new computer, restoring the backup (`bucks:sites:restore-key`)
re-imports the key and recreates the site from a CAR export or from the network.

## Is my site reachable?

`status` reports the highest state reached and the one check that failed:
**local only** → **announcing** → **discoverable** (a public delegated router lists your node,
`sites.routerUrl`) → **reachable** (an outside probe fetched and verified the root block,
`sites.probeUrl`; not configured by default, since Bucks does not run one yet) → **redundant**
(another copy: a device that pinned it, or a pinning service). Only the CID is sent to these
services, never file names.

Extra copies: paired devices are offered each new version (they pin it when
`devices.autoPin` is on); pinning services use the IPFS Pinning Service API with a token sealed by
the OS keychain (`bucks:sites:add-pinning-service`; refused when no keychain is available).

## Visiting a site

- With the local node running, `ipfs://` and `ipns://` pages come from it, and the address bar
  badge data says **Content-addressed** or **Signed name, updates allowed** (with the current CID).
- When the node is not running, the page asks: **Start node**, or **Use public gateway once** (for
  that site, until Bucks restarts). The gateway sees the address and your IP, and the page is
  badged **Unverified, via gateway**. Bucks never falls back to a public gateway silently.
  `ipfs.preferredGateway = public` is a standing choice and skips the question; the gateway must
  be `https://` on a public host.
- When nobody online has the content, the page says so ("The publisher's browser may be closed"),
  with Retry and, for `ipns://`, the newest record found.
- Web pages cannot call the node's API or gateway ports directly; they reach IPFS through `ipfs://`.
- Each CID and each name is its own origin, and a path can never leave it: an address such as
  `ipfs://<A>/..%2F<B>/page.html` is refused (Kubo's path gateway would answer it with B's file,
  which would then run on A's origin and could read A's storage).

## Node settings for hosting

New profiles create the Kubo repository without the `lowpower` profile, so the node can be a DHT
server when reachable; existing repositories keep their profile. On every start Bucks sets:
`Routing.AcceleratedDHTClient = false`, `Provide.Strategy = pinned` (only what you pin is
announced), `Swarm.ConnMgr` 50/150, `Datastore.StorageMax` = `ipfs.storageMaxGB` (10 GB; garbage
collection never removes pins), `Gateway.NoFetch = false`. Relay, hole punching, AutoNAT, IPNS
lifetimes and delegated routers keep Kubo's values. Kubo is pinned to v0.43.1 and every download is
checked against SHA-512 digests stored in `src/main/ipfs/dist.js` (`fetch-kubo.mjs --check-latest`
reports a newer release; updating is a deliberate change).

## Where this differs from the design document, and why

| Design | Implemented | Why |
|---|---|---|
| §6.2: fallback pages on `ipns://` get `max-age=0, must-revalidate` | Everything on an `ipns://` name is `no-store` | Measured in Electron 44: after an update, a reload still ran the old script, because Chromium's in-memory cache reuses custom-scheme subresources without revalidating. Requests go to the local node over loopback |
| §6.3 cache by resolved root | Same, plus: the browser serves **its own** names from the version it last published | Measured: an online Kubo keeps serving a name's previous version for up to the record TTL (5 min) after a republish; an offline node does not |
| §7.2 `pin/remote/*` through Kubo | The Pinning Service API spoken directly | `pin/remote/service add` stores the token in plain text in Kubo's config; §9.3 requires the OS keychain |
| §6.5 verify public responses (CAR) or badge them | Badge only ("Unverified, via gateway") | The design allows either; verification needs a UnixFS/CAR verifier in the handler |
| §6.6 `NoFetch=true` on gateways other pages can reach | Pages cannot reach the node's ports at all (subresource requests are cancelled) | Kubo has one gateway configuration; the handler needs `NoFetch=false` |
| §8.3 "stop updating" | `stop` removes the site from Bucks; content and key stay | The design names the choice but not its effect |
| P4 blocks every `AIza…` key | The `apiKey` of a Firebase web config is a warning (`P4-firebase`) | Firebase web apps ship that key in their bundle by design (Security Rules and App Check guard the data), so blocking it made every Firebase app unpublishable, and excluding the bundle breaks the app. Only the value of an `apiKey` property next to `authDomain` and another config field is excused; Maps, Gemini and Cloud keys still block |
| §8.1 `hosting.keepOnline` | Always true | This computer keeps every version for rollback; turning it off is not supported yet |

## Not done yet

The wizard and dashboard (package 9), a Bucks-run delegated router, outside probe and always-on
anchor (phase 4), verification of public-gateway responses, a content denylist, and a per-device
pinning quota. See §15–§16 of the design document.
