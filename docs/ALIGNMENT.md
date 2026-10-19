# Aligning the two browser code bases

Date: 2026-10-18. Two code bases were each "the Bucks browser":

| | Bucks-browser (this repository) | buckscore `Bucks-App/` |
|---|---|---|
| What | Electron 44 rewrite (`electron-main` branch): `WebContentsView` tabs, Kubo sidecar, security layer, devices, installers, CI | The packaged Electron "Bucks Core" v1.1.0 that bucks.global installs: one 9,900-line renderer, Python Soul Engine, Helia node, Go and C++ chain binaries |
| Strength | Architecture, security, unit and Playwright e2e tests, cross-platform packaging | Features: the Soul Engine agent with tools and generative UI, hardened E2E chat, app store, maps, dWeb studio |
| Weakness | Agent limited to offline rules, a remote server or plain Ollama | Unauthenticated local services, a committed database password, macOS-arm64 only, no module boundaries |

**Decision: this repository is the browser, and features move into it from Bucks-App module by
module.** The October 9 unification plan in buckscore (`claude/unification-plan-and-core`,
ADR 0002) proposed Tauri as the shell; the Electron rewrite on `electron-main` came after it and
replaced the Tauri app, so this alignment follows the newer Electron line. Bucks-App stays in
buckscore as the shipped v1.1.0 and as the reference for the ports still to come.

## What moved in this change

| Bucks-App | Here | Notes |
|---|---|---|
| `agent/` (Python Soul Engine) | `agent/` | Copied from buckscore `7fb4ad2`, then fixed; see "Security fixes" |
| `electron/soul-engine-supervisor.js` | `src/main/agent/soul-engine.js` | Rewritten: per-launch token, free port, private venv **Install**, health states, crash restart, no adopting or killing foreign processes |
| `electron/nexus-ipc-bridge.js` (main-process client for `/agent`) | `src/main/agent/providers/soul.js` | The `soul` provider: streams `/agent`, collects cards and follow-ups, declines approval-gated actions |
| `electron/a2ui-engine.js`, `a2ui-results.js` (generative cards) | `src/main/agent/genui.js` + `ui/src/lib/GenUiCards.svelte` | Cards are sanitised in main and rendered as text; no remote images in the chrome |
| `electron/soul-ui.js` (engine status) | `ui/src/lib/settings/SoulEngineSettings.svelte` | Backend choice, start/stop/restart, install, live status |
| `electron/chat-engine.js`, `signal-store.js` | `src/main/chat/` (reference, not loaded) | Replaced the older February copy; adds verified pre-key bundles, key pinning, sender authentication, ML-KEM/ML-DSA. See `src/main/chat/README.md` |

## Security fixes made while moving

1. **Leaked database credential removed.** `agent/memory/session_store.py` fell back to a
   hard-coded Supabase Postgres URL with its password, so prompts were copied to that database
   whenever `psycopg2` was installed. Cloud copy is now opt-in through `DATABASE_URL` only. The
   password is in git history in buckscore and must be rotated.
2. **Local servers need a token.** The Soul Engine and the MCP server accepted any request with
   CORS `*`, so any web page could run the agent's tools. `agent/local_auth.py` requires
   `Authorization: Bearer <token>` (fresh per launch, from the browser) on everything but
   `GET /health`. Without a token they behave as before and log a warning.
3. **Shell allowlist bypass closed.** `run_shell` checked a prefix and then ran the string in a
   shell, so `ls ; anything` passed. Commands now run without a shell and shell metacharacters
   are refused; the working directory must stay in the project.
4. **Local model by default.** The engine defaulted to NVIDIA NIM (cloud). The default is now the
   embedded on-device model; NIM and Lightning AI are opt-in with the user's own key, and the UI
   says that prompts leave the device.
5. **File access confined.** Bucks-App granted the agent's file tools the whole home directory.
   The browser confines them to `<profile>/soul-engine/workspace` unless the user sets
   `BUCKS_ALLOWED_ROOTS`.
6. **No killing other programs.** Bucks-App sent `SIGKILL` to whatever listened on port 8765. The
   browser uses a free port and only stops the process it started.
7. **Runtime data out of the app bundle.** Several modules wrote next to the code
   (`<agent>/../data`), which fails in a packaged app. With `BUCKS_DATA_DIR` set they write to the
   profile (`agent/runtime_paths.py`).
8. **No silent hang on a failed model load.** `/health` used to report `loading` forever when the
   embedded model could not load; it now reports `error` with the reason, and switching to the
   embedded backend at run time starts loading the model.
9. **Acting in a tab really acts.** In agentic mode the engine still ran its shortcut pipelines
   first, so "click the Buy now button" became a shopping search and nothing was clicked. Agentic
   requests now go straight to the tool loop.

The same agent fixes were applied to `Bucks-App/agent/` in buckscore (branch
`claude/browser-repos-alignment-aew07f`), so the two copies have the same code and the shipped
app no longer carries the credential either. Bucks-App runs the engine without a token, so its
gate stays off there.

## Still in Bucks-App only (planned, in this order)

Order follows the unification roadmap, phase 2, minus what is already here.

| Bucks-App | What it does | Plan |
|---|---|---|
| `chat-engine.js` + `messages-ui.js`, `chat-ui-init.js` | End-to-end encrypted P2P chat | Port to Kubo pubsub (ROADMAP item 4); the reference code is in `src/main/chat/` |
| `mcp-bridge.js` | Starts the MCP server for external AI clients | Start `agent/mcp_server.py` with `BUCKS_MCP_TOKEN` behind a Settings switch (ROADMAP item 5) |
| `app-store.js`, `app-runner.js`, `bucks-calc/clock/converter/notes/qr.html` | Built-in mini apps | Serve them from `bucks://apps/…` with the chrome's CSP; `AppStore.svelte` already lists apps |
| `universe-map.js`, `earth-maps.js`, `three.min.js` | 3D universe and map views | After the above; bundle libraries instead of loading from CDNs |
| `dweb-studio.html`, `bucks-template-*.html` | Build a site from templates and publish it to IPFS | On top of `bucks://ipfs` add/publish |
| `cluster-membership.js`, `cluster-updater.js` | Invite-based IPFS cluster and updates through it | With the hosting layer (ROADMAP "Next" item 2) |
| `pane-manager.js` | Several pages side by side in one tab | Needs multiple `WebContentsView`s per tab in `tabs.js` |

## Replaced by this repository's own implementation (not ported)

| Bucks-App | Replaced by |
|---|---|
| `main.js`, `renderer.js`, `index.html`, `preload.js`, `tab-manager.js`, `tab-view.js` | `src/main/*`, `src/preload/preload.cjs`, the SvelteKit chrome in `ui/` |
| `ipfs-node.js`, `ipfs-bridge.js`, `ipfs-agent-soul.js` (Helia in-process) | Kubo sidecar `src/main/ipfs/*`, `ipfs://` protocol handlers |
| `device-sync.js` | Device pairing over Kubo peering and pubsub (`src/main/ipfs/devices*.js`) |
| `permission-manager.js`, `web-security.js` | `src/main/security/*` |
| `agent-connection.js`, `agent-engine.js`, `agent-swarm.js`, `agent-integration.js`, `intent-*.js`, `response-*.js`, `agent-composer.*`, `nim-panel.js` | `src/main/agent/bridge.js` and its providers; `ui/src/lib/swarmStore.ts`, `ChatPanel.svelte`, `AgenticBar.svelte` |
| `version-controller.js`, `build-release.js` | `src/main/updater.js`, `electron-builder.yml`, `.github/workflows/build.yml` |
| `file-manager-ui.js` | The `bucks://ipfs` dashboard |
| `agent-browser-control.js`, the engine's `agentic` mode | `src/main/agent/browser-control.js` (runs in the main process, isolated world) and the approval card in `ChatPanel.svelte` |
| `doc-factory.js` | `src/main/docs.js` (Markdown, HTML and PDF into `<Documents>/Bucks`) |

## Not carried over

| Bucks-App | Why |
|---|---|
| `bucks-node-manager.js`, `bucks-miner-manager.js`, `bin/bucks-go`, `bin/bucks-cpp`, `bin/bucks-miner`, `blockchain.db`, `utxodb.sqlite` | Chain and miner binaries without source in this repository; the wallet page talks to a node over HTTP instead. buckscore holds `node/` and `miner/` |
| `soul-bridge.js` | Talks to a QNN checkout at `~/Desktop/QNN` over stdin; not part of either repository's runnable code |
| `synthetic-users.js`, `synthetic-messages.js`, `simulation-orchestrator.js`, `e2e-scenarios.js`, `benchmark-panel.js`, `media-loader-test-harness.js` | Test and simulation tooling for the old renderer |
| Screenshots, `index.html.bak-*`, `move_chat_panel.js`, `get_dimensions.py` | Development leftovers |
