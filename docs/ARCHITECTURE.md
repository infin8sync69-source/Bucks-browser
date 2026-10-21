# Architecture

This document explains how Bucks Browser is put together and why. For the exact list of IPC
channels and module signatures, see [IPC-CONTRACT.md](IPC-CONTRACT.md); that file is the
reference and `src/preload/preload.cjs` is its executable form.

## Process model

Four kinds of code run, and they trust each other as little as possible.

```
 +---------------------------- main process (src/main, Node, ES modules) ----------------------------+
 |  settings   window   tabs (TabManager)   protocols (bucks://, ipfs://, ipns://)   kubo + rpc      |
 |  security   downloads   menu   context menu   agent + Soul Engine sidecar   wallet proxy   updater  |
 +-----------------------------+------------------------------------------+--------------------------+
                               | ipcMain.handle / webContents.send        | WebContentsView.setBounds
                               | (channels "bucks:<area>:<action>")       | + navigation events
        +----------------------v----------------------+      +------------v---------------------------+
        | preload (src/preload/preload.cjs)           |      | web content views, one per external tab |
        | sandboxed, exposes window.bucks only        |      | partition persist:bucks-web             |
        +----------------------+----------------------+      | sandbox, no preload, no Node            |
                               | contextBridge                +------------------------------------------+
        +----------------------v----------------------+
        | chrome renderer (ui/, SvelteKit SPA)         |   Tabs, omnibox, bookmarks, history, settings,
        | loaded from bucks://app/ (dev: Vite :1420)   |   wallet, IPFS dashboard. No page content lives
        +---------------------------------------------+   in its DOM.
```

- **Main process.** `src/main/index.js` only wires modules together. Every subsystem is its own
  file that registers its own IPC handlers. It is the only code that touches the file system,
  the network (other than pages), child processes and the OS.
- **Preload.** One file, sandboxed CommonJS. It exposes a frozen `window.bucks` object whose
  methods are thin wrappers around `ipcRenderer.invoke` and `ipcRenderer.on` with fixed channel
  names. Nothing else from Electron or Node reaches the page.
- **Chrome renderer.** The browser interface is a static SvelteKit single-page app (adapter-static
  with an `index.html` fallback). In production it is served from `ui/build` by the `bucks://`
  protocol; in development `scripts/dev.mjs` points the window at the Vite server on
  `http://localhost:1420` through `BUCKS_DEV_URL`. It is a frameless window: the interface draws the
  title bar.
- **Web content views.** Every `http(s)://`, `ipfs://`, `ipns://` or `file://` tab is a
  `WebContentsView` owned by the main process. They use the session partition `persist:bucks-web`,
  separate from the interface's session, with `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, `webSecurity: true` and no preload.
- **App containers.** Each installed app runs in its own window on its own session partition
  (`persist:bucks-app-<id>`), served from `bucks-app://<id>/` (its pinned version, local node
  only), sandboxed, with a network allowlist of the origins its user granted, Chromium permissions
  only as granted, and one preload (`src/preload/app-preload.cjs`) exposing `window.bucks.app`.
  See [APP-ENVIRONMENT.md](APP-ENVIRONMENT.md).

### Why WebContentsView

Pages must be embeddable in the window without being part of the interface's DOM.

- **`<webview>`** is discouraged by the Electron project, has had an unstable architecture, and
  would require enabling `webviewTag` in the interface, which widens the trusted surface.
- **An `<iframe>`** shares the interface's process and session, is refused by every site that sends
  `X-Frame-Options` or `frame-ancestors`, and would force the interface's CSP to allow arbitrary
  frame sources. It also cannot give pages a separate cookie jar.
- **`BrowserView`** is deprecated in favour of `WebContentsView`.
- **`WebContentsView`** gives each tab its own `WebContents` with its own `webPreferences`, session
  and renderer process. The main process controls navigation, `window.open`, permissions, zoom,
  find, DevTools and thumbnails directly.

The cost is that a native view sits on top of the interface's page, so HTML overlays (menus, the
omnibox suggestion list, modals) would be hidden behind it. The chrome therefore reports where the
page should go and hides the view while an overlay is open; see the content rectangle protocol in
[IPC-CONTRACT.md](IPC-CONTRACT.md).

### Tab model ownership

| Owner | Owns |
|---|---|
| Chrome renderer | The list of tabs, their order, which is active, spaces, pins, names, colours, the closed-tab stack, bookmarks and history (persisted in `localStorage`; private tabs never are). Tab ids are generated here and passed to main in `tabs.create(id, url, { private })`. |
| Main process | One `WebContentsView` per external tab, created lazily (at startup only the active external tab gets a view). Internal tabs (`bucks://ipfs`, `bucks://settings`, ...) have no view; the chrome hides the content area and renders a route instead. |

Main pushes `bucks:tabs:updated` (a `TabState`) on every navigation, title, favicon or loading
change. Back and forward on external tabs are Chromium's own history. Links a page tries to open in
a new window, and any navigation to `bucks://` from web content, are blocked and forwarded to the
chrome as `bucks:tabs:open-request`, and the chrome decides what to open.

## The ipfs:// pipeline

```
 tab (Chromium)                    main process                              Kubo gateway
 --------------                    ------------                              ------------
 ipfs://bafy.../a.png  ---------->  protocol.handle("ipfs")
 origin = ipfs://bafy...            1. parse, validate host as a CID
                                    2. pick upstream:
                                         node ready      -> local gateway
                                         node starting   -> "starting" page (auto-refresh)
                                         stopped/failed  -> consent page (start node, or
                                                            public gateway once, per site)
                                    3. fetch GET/HEAD, redirect: manual ---> GET /ipfs/bafy.../a.png
                                       (site descriptor read once per root: bucks-site.json/_redirects)
                                    4. copy a short list of headers, add the site's,
                                       rewrite Location back to ipfs://; a 404 may become
                                       the SPA entry, a rewrite or the site's 404 page
 <---- streamed Response ---------  5. new Response(guarded body) <-------- bytes (not buffered)
```

1. **Scheme privileges.** Before the app is ready, `registerSchemePrivileges()` registers `bucks`,
   `ipfs` and `ipns` as *standard*, *secure* schemes that support `fetch()`, streaming, and (for
   ipfs/ipns) CORS. "Standard" is what makes the host part of the URL an origin and lets relative URLs
   resolve like they do on https. Service workers are disabled for `ipfs` and `ipns`.
2. **`protocol.handle`.** `installIpfsProtocols` installs the same handler on the default session
   (which serves the interface, whose CSP allows `ipfs:` images) and on `persist:bucks-web` (tabs);
   protocol handlers are per session in Electron.
3. **Validation.** For `ipfs://` the host must parse as a CID. For `ipns://` it must be a peer ID or
   a DNS name. Anything else gets a small self-contained HTML error page instead of a request to
   the node.
4. **Upstream choice.** If the local node is ready and the user has not set `preferredGateway` to
   `public`, requests go to `http://127.0.0.1:<gateway port>/ipfs/<cid>/<path>`. While the node is
   initialising the user sees a "starting" page that refreshes itself. If the node is stopped or has
   failed, the page asks first (`protocols/gateway-consent.js`): Start node, or use
   `settings.ipfs.publicGateway` once for that site; consent links carry a one-time nonce bound to
   the origin and the page cannot be framed. With `preferredGateway = public` the public gateway is
   used directly. A public gateway's `Content-Security-Policy` is never forwarded.
4a. **Site rules.** `protocols/site-serving.js` reads a site's `bucks-site.json` (else `_redirects`)
   once per root CID and applies it: single-page-app fallback for page navigations, rewrites,
   redirects, custom 404 pages and extra headers; it also turns an extensionless HTML file served as
   `application/octet-stream` into `text/html`. See [HOSTING.md](HOSTING.md).
5. **Streaming.** The response body of the upstream `fetch` is handed to `new Response(...)`
   unchanged, so large files and media stream with `Range` support (`Range`, `If-None-Match` and
   friends are forwarded). The 60 s timeout only covers waiting for response headers. When
   Kubo cannot find content in time (HTTP 502 or 504), the user gets a "no online node has this
   content" page. A body that ends before its `Content-Length` (Kubo cuts the stream when a block
   is missing) errors instead of ending quietly.
6. **Redirects.** Gateways redirect directories to a trailing slash and public gateways redirect to
   subdomain origins. The handler fetches with `redirect: 'manual'` and rewrites `Location`
   back to `ipfs://` or `ipns://` form, and follows by itself when the rewritten address is the
   one being served (which would otherwise loop).
7. Only `GET` and `HEAD` are allowed.

### CIDv0 and CIDv1

Chromium lowercases the host of a URL with a standard scheme. CIDv0 identifiers (`Qm...`) are
case-sensitive base58, so `ipfs://QmYwAP...` would silently turn into a different, invalid string.
CIDv1 in base32 (`bafy...`) is lowercase by construction. Bucks therefore normalises every `ipfs://`
address it controls to CIDv1 base32 (`normalizeIpfsUrl` in `src/main/ipfs/cid.js`): the address bar
goes through `bucks:ipfs:normalize-url`, and tab URLs are reported in canonical form. The same rule
applies to IPNS peer IDs, which become base36 CIDv1 `libp2p-key` names (`k51...`); DNSLink names are
just lowercased. If a lowercased `Qm...` reaches the handler anyway, the user gets an explanation
and a pointer to the converter on `bucks://ipfs`.

### Origin isolation per CID

Because `ipfs` is a standard scheme, `ipfs://<cid>` is a web origin of its own. Cookies, `localStorage`,
IndexedDB and the same-origin policy are separated by CID. Loading a gateway URL such as
`http://127.0.0.1:8080/ipfs/<cid>` instead would put every IPFS site on one origin
(`127.0.0.1:8080`), where any of them could read what another stored. That is the main reason for a custom
scheme over pointing tabs at the gateway. The handler never serves files from the chrome's directory.

## Kubo sidecar lifecycle

`src/main/ipfs/kubo.js` supervises the IPFS node. It is plain Node (no Electron imports) so it can be
tested without Electron. The state machine reported to the interface is
`idle -> initializing -> ready`, with `error` and `stopped` as the other states
(`IpfsStatus` in the contract). The steps:

1. **Locate.** First existing file wins: `$BUCKS_KUBO_BIN`; `<resources>/kubo/ipfs[.exe]` (packaged
   app, from `extraResources`); `<resources>/kubo/<os>-<arch>/ipfs[.exe]` (development, written by
   `scripts/fetch-kubo.mjs`); `<userData>/kubo/bin/ipfs[.exe]` (earlier runtime download).
2. **Download.** If nothing is found, download the pinned version (`PINNED_KUBO_VERSION` in
   `src/main/ipfs/dist.js`, v0.43.1) from `https://dist.ipfs.tech/kubo` or GitHub (override with
   `KUBO_DIST_URL`). The archive must match the SHA-512 stored in the repository; a mirror that lists
   another digest is skipped. Progress is reported as status messages.
3. **Init.** If `<userData>/kubo/repo/config` does not exist: `ipfs init --empty-repo=true` with
   `IPFS_PATH` set to that repo. (Repos created before hosting used `--profile=lowpower`; they keep
   it.) `BUCKS_KUBO_OFFLINE=1` starts the daemon with `--offline` (tests, air-gapped machines).
4. **Configure.** Ports are reserved once and kept in `<userData>/kubo/runtime.json`; a port that
   is busy later is replaced. Before every start the repo config is patched: the API and the gateway
   listen on `127.0.0.1` only, and the swarm addresses move to the reserved swarm port so that a Kubo you
   run yourself on 4001 is never disturbed. Pubsub, mDNS and paired devices' peering are set, and
   the hosting keys (`Provide.Strategy = pinned`, connection limits, `Datastore.StorageMax`, see
   [HOSTING.md](HOSTING.md#node-settings-for-hosting)). Everything else in the config is left alone.
5. **Adopt or spawn.** If the repo's `api` file points to a daemon that answers, that daemon is reused
   (for example after a crash of the app). Otherwise `ipfs daemon --migrate=true --enable-gc` is
   spawned with output going to `<userData>/logs/kubo.log` (rotated at 5 MB). A stale `repo.lock` is
   cleared and the start is retried once.
6. **Health.** The API (`/api/v0/id`) is polled every 500 ms for up to 60 s. If the process dies
   first, the error includes the last lines of its output.
7. **Ready.** The status is published with the API URL, gateway URL, Kubo version and peer ID, and
   the RPC client (`kubo.rpc`) becomes available to the IPC handlers.
8. **Crash handling.** If the daemon exits while ready, the status goes to `error` and a restart is
   scheduled with back-off of 2 s, 5 s and 15 s. After three attempts it gives up and asks the user to
   start the node from `bucks://ipfs`. The counter resets after two minutes of stable running.
9. **Shutdown.** `stop()` asks the daemon to shut down over RPC (3 s), sends SIGTERM, and sends
   SIGKILL after 5 s (`taskkill /T /F` on Windows). The app's `before-quit` handler waits at most 4 s
   for this. An exit hook kills any child still running if the main process dies abruptly.

**External mode.** With `settings.ipfs.mode = 'external'` steps 1 to 6 are replaced by a connection
to `externalApiUrl` (default `http://127.0.0.1:5001`), and the gateway address is read from the
node's config. Bucks never starts or stops that node; it polls its API every 30 s and treats a lost
connection like a crash. Changing the mode or the URL in Settings restarts the connection
automatically.

## Settings

`src/main/settings.js` keeps one JSON file, `settings.json` in the user data directory, merged over
`DEFAULT_SETTINGS` (so new keys appear without migration). The interface reads and patches it through
`bucks:settings:get` and `bucks:settings:set` (a deep merge), and gets `bucks:settings:changed` after
every change. Main-process modules call `settings.get()` at the moment they need a value, and a few
subscribe with `onChange`: the security layer re-applies its switches immediately and the Kubo
supervisor reconnects when the IPFS mode or API URL changes. Main treats the renderer's patch as untrusted
only in shape (it must be an object); individual values are validated by the module that uses them
(for example the wallet proxy re-validates the node URL on every call).

Sections: `searchEngine`, `homepage`, `ipfs`, `security`, `wallet`, `agent`, `downloads`, `ui`.

Environment variables used by the main process: `BUCKS_USER_DATA` (use another profile directory),
`BUCKS_DEV_URL` (load the interface from a dev server), `BUCKS_DEBUG=1` (debug logging),
`BUCKS_KUBO_BIN` (explicit Kubo binary), `BUCKS_IPFS_API_URL` (external API URL when none is set in
Settings), `KUBO_DIST_URL` (download mirror).

## Security model

**Trust boundaries.** The chrome renderer is trusted code that Bucks ships. Web pages are not. Pages
never receive a preload, Node, or any IPC handle.

- **Chrome window.** `sandbox`, `contextIsolation`, no `nodeIntegration`. The interface is built with a
  CSP (hash mode) that allows scripts from its own origin only and network connections only to its
  own origin and `http://127.0.0.1:*` / `http://localhost:*`. It is not allowed to navigate away from its
  own origin.
- **`bucks://`.** Registered on the interface's session only. It serves files solely from `ui/build`
  for the host `app`, rejects path traversal, and falls back to `index.html` for SPA routes. As a second
  layer, the request filter cancels any `bucks://` request that does not come from the interface.
- **Navigation policy for tabs.** Allowed schemes: `http`, `https`, `ipfs`, `ipns`, `about`, `data`,
  `blob`, and `file` only in a tab the user opened on a `file:` URL. `javascript:` and unknown schemes
  are blocked. `window.open`/`target=_blank` is always denied and forwarded to the chrome.
- **HTTPS-only.** One `webRequest` listener per session upgrades `http://` to `https://`, except for
  localhost, `*.local`, private and link-local addresses and single-label intranet names. If an
  upgraded top-level load fails with *connection refused* or a TLS/certificate error, the tab
  manager retries that host over plain `http://` and remembers the host for the session. This keeps
  sites without HTTPS reachable; it also means an attacker who can break TLS to a host can push the
  tab to HTTP. A stricter prompt-before-downgrade mode is on the roadmap.
- **Ad and tracker blocking.** The Ghostery adblocker engine (EasyList and EasyPrivacy, prebuilt,
  cached on disk and refreshed weekly) runs inside the same request listener. If the lists cannot
  be fetched, a stale cache is used, and failing that a small built-in list. It never blocks top-level
  documents and only looks at `http(s)`/`ws(s)`.
- **Cookies.** With `blockThirdPartyCookies`, `Set-Cookie` headers on third-party responses are
  dropped. "Third-party" uses an approximate registrable-domain match (a short built-in suffix
  list, not the full Public Suffix List); every `ipfs://<cid>` is its own site.
- **Permissions.** Web content is denied everything except fullscreen, pointer lock, sanitised
  clipboard writes, background sync and media *playback*. Camera, microphone, screen capture,
  geolocation, notifications, clipboard read, and HID/USB/serial/Bluetooth pickers are refused. A
  per-origin allow map exists in memory for a future site-settings UI.
- **IPFS origins.** One origin per CID (above). The Kubo API and gateway are bound to loopback.
  The swarm port is open to the network, as it must be for the node to be useful.
- **Wallet.** `bucks:wallet:rpc` only forwards `GET`/`POST` to a validated path on the configured
  node, never follows redirects, caps the response size, and refuses callers whose frame is not the
  interface. Private keys are generated and kept in the interface; main only sees signed requests.
  Today those keys are saved in the interface's `localStorage`, unencrypted, inside your profile
  directory, so anyone who can read that directory can read them. Moving them into the OS
  keychain is the first item on the roadmap.
- **Soul Engine.** Listens on loopback only and requires a per-launch bearer token on every
  endpoint but `GET /health`, so web pages (which can send requests to `127.0.0.1`) cannot drive
  it; no CORS is offered. Its file tools are confined to `<userData>/soul-engine/workspace`. Cards
  it returns are reduced to plain data in main (http(s)/ipfs/ipns links only, bounded sizes) and
  the chrome renders them as text without loading remote images, because the chrome's session has
  none of the tab session's tracker blocking. The default backend runs on the device; cloud
  backends need the user's own key and the UI says that prompts leave the device.
- **Private tabs.** They use their own in-memory session (`bucks-private`) with the same
  protocols, security layer and downloads as normal tabs; nothing of it is written to disk, the
  chrome never persists them or records them in history, and main clears the session when its last
  tab closes.
- **Extensions.** Unpacked extensions from `<userData>/extensions` are loaded into the web
  session only, never the chrome's, so they cannot script the interface.
- **Links from the OS.** URLs on the command line (first or second launch) and macOS `open-url`
  are limited to http(s), ipfs, ipns and file URLs and opened as new tabs once the chrome reports
  `bucks:app:chrome-ready`.
- **External links.** `bucks:shell:open-external` accepts only `http:`, `https:` and `mailto:`.
- **Downloads.** File names are sanitised for every OS and made unique in the target directory.
- **IPC.** Handlers validate their payloads and throw `Error` with a human-readable message.
- **Code integrity.** The Kubo download is verified by SHA-512. Release builds are not code-signed yet.
- **Updates.** The in-app updater (`bucks:updater:*`, outside the contract file) only works for a Git
  checkout and refuses when there are local changes. Installed packages are updated by installing a
  newer package.

## Agent providers

`src/main/agent/bridge.js` registers `bucks:agent:*` and dispatches each request to the provider selected
in `settings.agent.provider`:

| Provider | File | Behaviour |
|---|---|---|
| `offline` | `providers/offline.js` | Pure rules: turns "go to ...", bare domains, CIDs, "search ..." and a few page names (wallet, IPFS, settings, downloads) into a navigation or UI action. Always available. |
| `remote` | `providers/remote.js` | `POST <remoteUrl>/api/v1/swarm/task` with the prompt and current page; feedback to `/api/v1/swarm/feedback`. Probed for availability with a short ping. |
| `ollama` | `providers/ollama.js` | Chat with a local Ollama model. The system prompt asks it to end with one JSON action block when the browser should act; page text is sent only when the question is about the current page. |
| `soul` | `providers/soul.js` | The Soul Engine sidecar (below). `POST /agent` with the question, attachments, page context and the conversation so far, read as server-sent events: answer tokens, generative-UI cards (`ui_component`, normalised by `genui.js`), `<followup>` suggestions, tool names, progress, and `browser_action` requests (see "The agent acting in a tab"). Feedback goes to `/agent/feedback`. |

Every query carries the last turns of its thread (`history`, at most 12, 2,000 characters each)
and any attachments. Attachments (files up to 5 MB, IPFS CIDs through the embedded node) are read
in main by `agent/attachments.js` and handed to the provider as text (images and binaries are
named, with a note), because a small model given only a file name invents its contents. Each query
has an id: `bucks:agent:cancel` stops it (every provider stops at once; the Soul Engine is also told
to cancel its session) and its progress arrives as `bucks:agent:event`.

Threads are kept by the chrome (`localStorage`, 50 threads of 200 messages), so they work the same
with every provider. Slash commands (`ui/src/lib/agent/slash.ts`) open Bucks pages, run local
actions (new chat, save the page as PDF, publish text to IPFS) or become a clear request for the
agent; `/agent <task>` asks the agent to act in the tab.

Answers can carry an `a2ui` action (`navigate`, `open_tab`, `search`, `action`, `text`) that the
interface executes. Availability is cached for 10 s. When the selected provider is unreachable or fails,
the request is answered by the offline rules and the answer says why (status `offline_fallback`).
Page text for the model comes from `tabs.extractText`, which reads `innerText` of the tab in an
isolated world, truncated.

## The agent acting in a tab

With "act in this tab" (or `/agent <task>`) and the Soul Engine selected, the query is sent with
`agentic: true` and the engine may call its browser tools. It asks Bucks to run each one with a
`browser_action` event and waits for the result at `/agent/tool_result`.

- `agent/browser-control.js` runs them on the tab the question came from (never another one):
  `browser_read_page` (an indexed list of the page's links, buttons and fields; each gets a
  `data-bucks-ref`), `browser_click`, `browser_type` (real text input through
  `webContents.insertText`), `browser_scroll`, `browser_navigate` (http, https, ipfs and ipns
  only), `browser_screenshot`. Page scripts run in an isolated world, so the page cannot replace
  the functions they use; refs must be numbers.
- **Approval.** Clicking, typing and navigating always wait for the user, whatever the engine's
  `needs_approval` flag says; so do the engine's own state-changing tools (cluster votes and pins).
  The chrome shows an Allow / Refuse card naming the element; no answer within 25 seconds is a
  refusal (the engine itself gives up after 30). Stopping the query refuses everything pending.
- Without "act in this tab" the browser tools answer that acting was not enabled, so a request that
  did not ask for it cannot touch the page.
- **Documents.** `create_document`, `create_pdf` (Markdown rendered by `docs.js` in a hidden window
  with JavaScript off) and `page_to_pdf` write to `<Documents>/Bucks` under unique names; the answer
  lists the files with a Show button. Any answer can also be saved as Markdown or PDF from the
  chat. `bucks:docs:show` only reveals files Bucks wrote in this session.
- The engine skips its shortcut pipelines (shopping, weather, video, images, research) in agentic
  mode: "click the Buy now button" is a page action, not a shopping search.

## Soul Engine sidecar

`src/main/agent/soul-engine.js` supervises the Python agent in `agent/` the way `kubo.js`
supervises IPFS, and like it is plain Node so it runs under `node --test`. It runs only while
`settings.agent.provider` is `soul`.

1. **Locate.** Code: Settings `agent.soul.agentDir`, `$BUCKS_SOUL_DIR`, `<resources>/agent` when
   packaged, `<appRoot>/agent` from source; the first with `soul_engine.py` wins. Interpreter:
   Settings `agent.soul.python`, `$BUCKS_SOUL_PYTHON`, `<userData>/soul-engine/venv`,
   `agent/.venv`. Nothing found: state `unavailable` with what to do.
2. **Install** (on request). Find a system Python 3.10+, create `<userData>/soul-engine/venv`,
   `pip install -r requirements-engine.txt` (plus `requirements-edge.txt` for the embedded
   model), then start. Progress is reported as `installing` messages.
3. **Spawn.** `python -m uvicorn soul_engine:app --host 127.0.0.1 --port <port>` with a free port
   (or `agent.soul.port`) and a new 32-byte token in `BUCKS_SOUL_TOKEN`. The environment is the
   app's, plus the user's `<userData>/soul-engine/.env` (cloud API keys), plus values Bucks owns
   and the `.env` cannot override: the token, `BUCKS_DATA_DIR`/`BUCKS_HOME` =
   `<userData>/soul-engine`, `BUCKS_PROJECT_ROOT` = its `workspace/` (the only folder its file
   tools may read), `MODEL_PROVIDER` = `agent.soul.backend`. Output goes to
   `<userData>/logs/soul-engine.log`.
4. **Health.** `GET /health` (the one open endpoint) until it answers (60 s), then every 10 s
   (2 s while the model loads). Modes map to states: `local_llm`/`cloud_llm` → `ready`, `loading`
   → `loading`, `error`/`no_model`/`unconfigured`/`offline` → `error` with an explanation. An
   engine in `error` keeps running so it recovers by itself (for example once Ollama starts).
5. **Backend.** The engine remembers the last backend it was switched to, which outranks
   `MODEL_PROVIDER`; after the first answer the supervisor aligns it with Settings through
   `/providers/select`.
6. **Crashes** restart with back-off of 2 s, 5 s and 15 s, three times; the counter resets after two
   minutes of `ready`. **Stop** sends SIGTERM, then SIGKILL after 5 s (`taskkill /T /F` on Windows).
   It only ever stops the process it started.
7. **Settings changes** (`settingsAction`): choosing `soul` starts it (when `autoStart`), choosing
   another provider stops it, and changing the backend, port, interpreter or code folder (or the
   Ollama URL/model with the Ollama backend) restarts it.

Status is pushed as `bucks:agent:soul-status` (`SoulStatus` in the contract). The bridge passes
the running engine's `{ url, token }` to the provider in its config, and drops its 10 s
availability cache on every status change.

## Startup sequence

1. Module load: `registerSchemePrivileges()` (must precede `ready`); `BUCKS_USER_DATA` is applied; the
   single-instance lock is requested (a second launch focuses the first window).
2. `app.whenReady()`: resolve the user data directory, start file logging
   (`<userData>/logs/main.log`), create settings.
3. Create the Kubo supervisor and its IPC; if `ipfs.autoStart`, call `kubo.start()` in the
   background. The interface never waits for it.
4. Install protocols: `bucks://` on the default session, `ipfs://` and `ipns://` on the default and web sessions.
5. Install security on the web session (request filter, cookies, permissions) before any tab exists.
6. Create the chrome window (loads `bucks://app/` or `BUCKS_DEV_URL`), then the tab manager, menu and
   context menu, downloads, shell IPC, updater, the Soul Engine supervisor (started in the background
   if `soul` is the selected provider and `agent.soul.autoStart` is on), agent and wallet proxy.
7. On `window-all-closed` the app quits (except on macOS); on `before-quit` it waits up to 4 s for
   `kubo.stop()` and the Soul Engine's stop.

## File layout

```
package.json                  main: src/main/index.js ("type": "module")
electron-builder.yml          packaging configuration
src/
  main/
    index.js                  wiring only
    paths.js                  appRoot, uiDist, resourcesDir() (resourcesPath when packaged)
    log.js                    console + userData/logs/main.log
    settings.js               JSON settings + bucks:settings:*
    window.js, window-state.js  chrome window, remembered bounds
    tabs.js                   TabManager: WebContentsView per external tab
    menu.js, context-menu.js  native menu (owns accelerators), right-click menus
    downloads.js              will-download -> bucks:downloads:*
    shell.js                  bucks:shell:open-external
    updater.js, updater-core.js  git-checkout updater (bucks:updater:*)
    protocols/
      index.js                scheme privileges
      bucks.js                bucks://app/* from ui/build
      ipfs.js                 ipfs:// and ipns:// handler
      site-serving.js, gateway-consent.js  site descriptors, SPA fallback, consent interstitial
    ipfs/
      kubo.js                 sidecar supervisor
      dist.js                 Kubo download + checksum (shared with scripts/fetch-kubo.mjs)
      rpc.js                  Kubo HTTP RPC client
      cid.js                  CID and URL normalisation (pure)
      ipc.js                  bucks:ipfs:*
    security/                 filter.js (request listener), blocklist.js, cookies.js,
                              permissions.js, index.js (bucks:security:stats)
    agent/                    bridge.js, a2ui.js, genui.js (cards), soul-engine.js (sidecar supervisor),
                              providers/{offline,remote,ollama,soul}.js
    wallet/proxy.js           bucks:wallet:rpc
    sites/                    hosting sites (HOSTING.md): service, store, folder checks, keys, health, agent tools
    apps/                     apps in Bucks containers (APP-ENVIRONMENT.md): service, store, manifest,
                              policy (pure rules), protocol (bucks-app://), container (sessions, windows,
                              the app bridge), ipc, agent tools
    lib/record-store.js       atomic, versioned JSON collections (sites.json, apps.json)
    design/                   tokens.generated.js (the design tokens' CSS and hex colours), page.js
    chat/                     end-to-end encrypted chat engine from Bucks-App v1.1.0; reference
                              code, not loaded by index.js yet (see chat/README.md, ROADMAP.md)
  preload/preload.cjs         window.bucks (the chrome)
  preload/app-preload.cjs     window.bucks.app (apps in containers)
ui/                           SvelteKit chrome (src/routes: ipfs, settings, wallet, downloads, apps, ...)
design/                       the design system (DESIGN-SYSTEM.md): tokens/, dist/ (generated), components/, build/
chrome/src/                   framework-free chrome features (CONSOLIDATION-PLAN.md); apps/ is mounted at bucks://apps
agent/                        Soul Engine (Python): soul_engine.py, local_auth.py (token gate), tools/,
                              requirements-engine.txt / requirements-edge.txt, tests/
scripts/                      dev.mjs, fetch-kubo.mjs, check-main.mjs
resources/kubo/<os>-<arch>/   Kubo binaries for packaging (git-ignored; os = linux | win | mac)
build/icons/                  application icons
test/unit, test/e2e           node --test suites, Playwright smoke test
docs/                         this file, IPC-CONTRACT.md, BUILDING.md, ROADMAP.md
```
