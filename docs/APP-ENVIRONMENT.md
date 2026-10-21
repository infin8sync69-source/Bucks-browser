# The Bucks app environment

Host an application, install it on any Bucks, and run it in a **Bucks container**: its own window,
its own storage, and only the network and features its user allowed. Apps travel over IPFS like
the sites in [HOSTING.md](HOSTING.md), and the agent can install, open and use them, always with
the user's approval.

Status: built and tested (unit, real-Kubo integration, Electron e2e). Channels:
[IPC-CONTRACT.md](IPC-CONTRACT.md#apps-installing-and-running-apps-in-a-bucks-container).
Screens use the design system: [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

## 1. The idea in one picture

```
 developer                         this browser                              another Bucks
 ─────────                         ────────────                              ─────────────
 folder with        Install from     ┌──────────────┐   Host it    ipns://k51…    Install from
 index.html     ──▶ a folder    ──▶  │ app (pinned) │ ──────────▶  (follows   ──▶ the address  ──▶ container
 + bucks-site.json                   │  container   │  (sites)     updates)        review, pin
                                     └──────────────┘
                                            ▲  app_list / app_call (approved)
                                            │
                                         the agent
```

One package format, three roles: a **site** (published from this browser, `ipns://`), an **app**
(the same package installed and run in a container), and **agent tools** (functions the app offers
to the user's agent).

## 2. What an app is

Any static site package (an IPFS directory with `index.html`) can be installed. An optional `app`
section in its `bucks-site.json` (the hosting manifest) describes it:

```json
{
  "spa": true,
  "app": {
    "name": "Notes",
    "version": "1.2.0",
    "description": "Take notes, offline first.",
    "icon": "icon.svg",
    "permissions": ["network:https://api.example.com", "notifications", "ipfs"],
    "agent": { "tools": [
      { "name": "search_notes", "description": "Find notes containing a phrase",
        "input_schema": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] } }
    ] },
    "window": { "width": 1000, "height": 720 }
  }
}
```

| Permission | What it opens | Risk |
|---|---|---|
| `network:https://host[:port]`, `network:wss://…`, `network:https://*.domain` | Requests to that origin (https covers wss on the same host). Everything else on the internet stays blocked | medium |
| `network:http://localhost:port` | A service on this computer (for developing an app) | high |
| `notifications` | Desktop notifications | low |
| `clipboard-read` | Reading the clipboard | high |
| `geolocation` | The user's position | high |
| `camera`, `microphone` | Capture | high |
| `ipfs` | `ipfs://` and `ipns://` content, and `bucks.app.ipfs.add/cat` on the user's node | medium |
| `agent-tools` (implied by declaring tools) | The agent may call the app's tools | medium |

Fullscreen, pointer lock and writing to the clipboard need no permission. Unknown permissions,
non-https origins, paths in origins and invalid tool names are dropped with a warning shown in the
review (`src/main/apps/manifest.js`).

## 3. Installing, updating, removing (`src/main/apps/service.js`)

| Source | How it resolves | Updates |
|---|---|---|
| `ipfs://<cid>` | That CID | None: one exact version |
| `ipns://<name>` (or a bare `k51…`) | `name/resolve` on the local node | Check resolves again |
| A folder (native dialog) | Checks P1–P12 ([HOSTING.md](HOSTING.md#checks-before-anything-is-uploaded)), added to the node unpinned | "Reload from folder" re-adds it |
| A site this browser hosts | The site's current CID | Follows the site |

1. **Review** (`inspect`): resolve, read `bucks-site.json` (≤ 64 KB) and the size through the local
   node. Nothing is pinned. The review lists every permission with its risk and every warning.
2. **Install** with the review's single-use token: pin the exact reviewed CID, cache the icon
   (≤ 512 KB), record the app in `<userData>/apps.json`. The user may leave any permission off.
3. **Update**: `check-update` records a pending version and its permission diff; applying it
   without `confirm` only reports. New permissions are granted only with `confirm` (the user saw
   them). The previous version stays pinned for **rollback**, which never widens grants.
4. **Uninstall**: close the window, clear the app's session storage and cache, delete its
   partition folder and icon, unpin every version no other app and no hosted site uses.
5. **Host it** (folder apps): publish the folder with the sites service; the app then follows the
   site's `ipns://` address, and anyone can install it from there.

Installing the same source again replaces the installed app and keeps its data.

## 4. The Bucks container (`policy.js`, `protocol.js`, `container.js`)

Each app gets:

* **An origin**: `bucks-app://<app id>/`, a privileged standard scheme. The handler maps it to the
  app's current CID and serves it through the same ipfs:// pipeline as tabs (site descriptor, SPA
  fallback, type repair, truncation guard, path-traversal refusal), from the **local node only**.
  The origin does not change between versions, so storage survives updates. Responses are
  `no-store` (Chromium reuses custom-scheme subresources without revalidating, measured for
  `ipns://`). Redirects are rewritten to stay on the origin. If the node is not ready, the app
  shows "Starting…" and the node starts; a public gateway is never used.
* **A session partition** `persist:bucks-app-<id>`: cookies, localStorage, IndexedDB and cache are
  the app's own, separate from tabs, the chrome and other apps.
* **A network allowlist** (`webRequest`): its own origin, `data:`/`blob:`, `ipfs://` only with
  `ipfs`, and the granted origins. The local node's API and gateway are refused whatever was
  granted (an app could otherwise control the node). Another app's `bucks-app://` origin is refused.
* **Permissions**: Chromium permission requests and checks answer from the grants; HID, USB,
  serial, Bluetooth and screen capture are always refused.
* **A window**: sandboxed renderer, context isolation, no Node, no `<webview>`, no navigation away
  from its origin; web and IPFS links open in a Bucks tab. The title is the page title and the
  app's name. Unstyled apps paint on white, like tabs.
* **One bridge**, `window.bucks.app` (`src/preload/app-preload.cjs`): `info()`, `agent.handle()`,
  `ipfs.add()/cat()` (with `ipfs`), `openExternal()`. Main checks the sender is the container's
  main frame on its own origin and the grant on every call. The chrome's `window.bucks` API is not
  there. In a plain tab the same app finds no `window.bucks.app` and should work without it.

Revoking a permission reloads a running app so the change takes effect at once.

## 5. Writing an app

```js
// works in a tab too: feature-detect
const bucks = window.bucks?.app;
if (bucks) {
  const { permissions } = await bucks.info();
  bucks.agent.handle('search_notes', async ({ q }) => ({ results: search(q) }));
}
```

Build it as a static site (any framework), put `bucks-site.json` next to `index.html`, then in
Bucks: **Apps → Install an app → Choose a folder**. Iterate with **Reload from folder**; share with
**Host it** (the address works for every Bucks user while your browser or a pinning copy is online).

## 6. The agent and apps (`agent-tools.js`, Soul Engine `APP_TOOL_SCHEMAS`)

| Tool | Does | Asks the user |
|---|---|---|
| `app_list` | Apps, versions, grants, tools with input schemas | — |
| `app_install { address }` | Review then install | Always: a card from Bucks' own review (source, size, each permission and risk, warnings) |
| `app_open { id }` | Opens the app's window | — (visible to the user) |
| `app_call { id, tool, input }` | Runs one of the app's tools inside the app | The first time per app per session; needs the app's `agent-tools` grant |
| `app_update { id }` | Check and update | Always: version change and new permissions |
| `app_uninstall { id }` | Remove | Always |

The engine proposes; the main process does. The engine's own label is never used to ask. An app's
answer is returned to the model marked as the app's own, untrusted output (≤ 256 KB, 60 s). The
app is opened (without focus) when its tool is called and it is not running, so the user sees it.

## 7. How this fits the rest of Bucks

* **IPFS hosting**: the same package, manifest, checks, `ipfs://` pipeline, pinning and records
  (`src/main/lib/record-store.js` is shared by `sites.json` and `apps.json`). An app's versions
  stay pinned while a site uses them.
* **Agent**: app tools run beside the hosting tools in the main process, with the same approval
  machinery; the chat's approval card renders the app's permission list.
* **Chrome plan**: the Apps screens are framework-free web components (`chrome/src/apps/`) on the
  design system, mounted today in the Svelte chrome at `bucks://apps` and portable unchanged to the
  framework-free chrome ([CONSOLIDATION-PLAN.md](CONSOLIDATION-PLAN.md)). They are the first part
  of `chrome/`.
* **App store** (Bucks Core feature): the store overlay links to the installed apps; its catalogue
  is still the static mock and becomes a list of `ipns://` app addresses.

## 8. Decisions and why

| Decision | Why |
|---|---|
| Apps are static web packages, not OS containers | A Bucks install has no Docker; a browser engine with a session per app is the container every user already has. Server code is out of scope (see §10) |
| One manifest (`bucks-site.json` + `app`) | Hosting and apps share checks, serving and tooling; a hosted site becomes installable by adding a section |
| `bucks-app://<id>` instead of `ipns://` as the app's origin | Stable across versions (ipfs:// origins change per CID) and across sources (folder → site); separate from the same site opened in a tab |
| A window per app, not a tab | Its own session cannot be mixed into the tab strip's session; a window makes the boundary visible |
| Deny-by-default network with origin grants | An installed app should not phone home unless the user saw where |
| Node ports always refused | Granting `localhost` for development must not hand the node's RPC to an app |
| Install pins | Installed means it runs offline and survives garbage collection |
| Agent tools via `window.bucks.app.agent.handle` + manifest declaration | The schema is reviewable at install; the code runs in the app's sandbox, not in the agent |

## 9. Verification

* `test/unit/apps/manifest-policy.test.js`: manifest parsing and normalisation, network origin
  rules, permission descriptions, request/permission/navigation policy, addresses (a bare `k51…`
  is an IPNS name even though it parses as a CID), store sanitising.
* `test/unit/apps/service.integration.test.js` (real Kubo, offline): folder review/install/serve
  (SPA deep links, directory redirects, traversal 400), tools gated by the grant, update with a new
  permission (dry run, confirm), rollback, Host it (site + ipns), uninstall (shared pins kept);
  ipfs:// vs ipns:// installs and updates.
* `test/unit/apps/agent-tools.test.js`, `test/unit/agent/soul.test.js`, `agent/tests/test_app_tools.py`.
* `test/e2e/apps.test.mjs` (Electron): install, bucks://apps, Open → `bucks-app://` window with the
  bridge; the web and the node's gateway blocked; the agent's `app_call` reaches the app's tool;
  storage persists across relaunch and is invisible to the chrome; revoke reloads; uninstall from
  the UI.

## 10. Not done yet

* Server-side code. A WebAssembly (WASI) backend per app, or a Service Worker on `bucks-app://`,
  would let apps answer their own `/api/…` calls; both need design work.
* Apps asking the agent (`bucks.app.agent.ask`), with a visible request in the chat.
* A catalogue: the app store overlay lists `ipns://` addresses instead of the mock registry; a
  signed index on IPFS.
* Per-app storage quota and usage display; export and import of an app's data.
* Installed apps on the new-tab grid; opening an app in a split pane.
* Signature checks on app packages (publisher identity beyond the IPNS key).
