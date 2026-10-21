# Bucks Desktop Super App: Phased Implementation Setup

## Status (Oct 2026)

The desktop app was rewritten on Electron. The phases further down were written for the earlier
Tauri app and are kept as the product plan: read "the Tauri desktop app" in Phase 1 as "the
Electron desktop app". They are mostly not built yet: the interface has a DID login and static
overview pages for the super app and the phases (`bucks://superapp`, `bucks://implementation`), but
no signed-event store, provider modes, search index or dispatch. The rewrite described next is the
platform they will be built on.

### Done in this rewrite

- **Shell.** Electron 44, a frameless chrome window, and one `WebContentsView` per external tab with
  the tab list owned by the interface (see [ARCHITECTURE.md](ARCHITECTURE.md)).
- **IPFS.** `ipfs://` and `ipns://` served by protocol handlers that stream from a local Kubo
  node, with CIDv0 to CIDv1 normalisation and one web origin per CID. A public gateway only with
  the visitor's consent.
- **Hosting sites.** Publish a folder as `ipfs://` and `ipns://` from the browser: preflight checks,
  SPA deep links, updates with a diff, rollback, key backup, health, and agent tools with approval
  ([HOSTING.md](HOSTING.md)). The wizard and dashboard wait for the new chrome.
- **Apps in Bucks containers.** Install an app from an `ipns://` or `ipfs://` address, a folder or
  a hosted site after reviewing its permissions; each runs in its own window, session and
  `bucks-app://` origin with a network allowlist; updates with permission diffs, rollback,
  uninstall, "Host it", and agent tools with approval ([APP-ENVIRONMENT.md](APP-ENVIRONMENT.md)).
- **Design system.** Tokens for colour (dark and light, contrast-checked), type, space, radius,
  elevation, motion and layers; a Tailwind theme with nothing outside them; twelve framework-free
  components; a linter in CI; the whole Svelte chrome migrated ([DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)).
- **Kubo sidecar.** Locate or download (SHA-512 verified), init, configure, spawn, health check,
  restart after crashes, clean shutdown; reuse of a running daemon; external-node mode; the
  `bucks://ipfs` dashboard (status, add, browse, pin).
- **Security.** HTTPS-only upgrades, EasyList/EasyPrivacy blocking, third-party cookie blocking,
  deny-by-default permissions, sandboxed renderers, a locked-down `bucks://` protocol.
- **Browser features.** Downloads, native menu and shortcuts, context menus, window state, settings.
- **Agent.** Offline rules, a remote Bucks agent server, Ollama, and the Soul Engine, with
  automatic fallback to the offline rules.
- **Soul Engine (aligned from Bucks-App).** The Python agent of the Electron "Bucks Core" app
  (buckscore `Bucks-App/agent`) now lives in `agent/` and runs as a supervised loopback sidecar
  with a per-launch token, an on-device model by default, a one-click private Python install,
  generative-UI cards and follow-up suggestions in the chat panel. The move fixed a committed
  database password, unauthenticated local servers, a shell allowlist bypass and home-wide file
  access. Map of the remaining Bucks-App features: [ALIGNMENT.md](ALIGNMENT.md).
- **Wallet.** An origin-gated proxy from the interface to a Bucks node over HTTP.
- **Packaging.** `electron-builder.yml` with installers for Linux (AppImage, deb), Windows (NSIS and
  portable) and macOS (dmg, zip) bundling Kubo; GitHub Actions for checks, builds and tagged
  releases; developer runner `scripts/dev.mjs`. Builds are unsigned.
- **Tests.** Unit tests for the pure logic of each module, and a Playwright smoke test that boots
  the app, starts Kubo and loads an `ipfs://` page.
- **Source installers.** One-line installers for Linux (`scripts/install-linux.sh`) and macOS on
  Apple Silicon and Intel (`scripts/install-macos.sh`, which creates an unsigned launcher app in
  `~/Applications`). Both pre-download Kubo, falling back from `dist.ipfs.tech` to GitHub releases.

### In progress: device pairing over IPFS peering and pubsub

Pair your own Bucks installs (for example an Ubuntu laptop and a MacBook) and send files between
them, with no server in between. User guide: [DEVICES.md](DEVICES.md); protocol:
[IPC-CONTRACT.md](IPC-CONTRACT.md#devices-pairing-bucks-installs-over-ipfs-peering--pubsub).

- Built: Kubo configured with pubsub (gossipsub), mDNS discovery and `Peering.Peers` for paired
  devices; signed presence messages on the topic `bucks-devices-v1` every 30 s with a 7-day outbox
  for eventual delivery; pairing by discovery on the local network or by pasting a pairing address;
  live pairing changes without restarting the node; the Devices section on `bucks://ipfs`
  (this device, paired, nearby, received, pair manually), "Send to my devices", and optional
  auto-pin of received files.
- Remaining before calling it done: a test between two real machines (Linux and macOS) on the same
  Wi-Fi and across networks, including the macOS firewall and Local Network prompts.
- Next steps:
  1. **End-to-end encryption for shares.** Today a share is a public CID and the presence messages
     (device name, addresses, file names) are readable by any node on the topic. Encrypt shared
     content and the share list to the paired devices' keys (derived from their peer IDs), so
     only paired devices can read them.
  2. **Pairing confirmation.** Show a short code derived from both peer IDs on both screens so the
     user can confirm they paired the right device.
  3. **Reachability across networks.** Use Kubo's relay and hole punching (or a user-run relay) so
     devices on different networks connect without a VPN or port forwarding.

### Next

1. **OS keychain for wallet keys.** Keys and the DID are in the interface's `localStorage`,
   unencrypted. Move them behind Electron's `safeStorage` (Keychain, DPAPI, libsecret) so main holds
   the encrypted blob and the interface asks to sign. This is also Phase 1's "OS-secured storage".
2. **Hosting layer.** Use IPFS Cluster or a pinning-service API so published content stays
   available when the user's own machine is off (Phase 5 and the pinning node role in Phase 6).
3. **`bucks://` name resolution via the Bucks chain.** Today `bucks://` only serves the app's own
   pages (`bucks://app`, plus the interface's internal routes). Human-readable names should resolve to a CID
   through the chain, with a verified result.
4. **Chat over Kubo pubsub.** `src/main/chat/` is the end-to-end encrypted chat engine from
   Bucks-App v1.1.0 (CommonJS, Helia gossipsub; updated to its latest, hardened version, see
   `src/main/chat/README.md`). Port it to Kubo's pubsub RPC (pubsub is now enabled in the
   repo configuration for device pairing, and `src/main/ipfs/devices-service.js` shows how to
   stream `pubsub/sub` and publish with `pubsub/pub`), wire it into `index.js` and the contract.
   Its encryption is a model for encrypted shares.
5. **Agent tool permissions and MCP.** Let the agent call tools (including MCP servers) behind
   explicit per-tool, per-site user consent, with a visible log of what ran. First step: an
   approval prompt for the Soul Engine's `browser_action` events, then its `agentic` mode
   (read, click and type in the live tab, Bucks-App's `agent-browser-control.js`), then starting
   `agent/mcp_server.py` with its token behind a Settings switch.
6. **Tor through an `arti` sidecar.** A real Tor client supervised the same way as Kubo, with an
   opt-in per-session proxy and honest status reporting.
7. **Security follow-ups.** Ask before falling back from HTTPS to HTTP after a TLS error instead of
   doing it silently; a site-settings page backed by persistent permission grants.
8. **Release follow-ups.** Signed releases: code signing and notarisation (see
   [BUILDING.md](BUILDING.md)), so macOS and Windows users get a packaged app without Gatekeeper or
   SmartScreen warnings, and a stable signed identity for the macOS firewall and privacy prompts.
   Auto-update for packaged builds (`electron-updater` from the signed releases feed; source installs
   already update by re-running the installer). Opening `ipfs://` links handed over by the operating
   system (the packages already register the handler; the app must read the URL from `open-url` on
   macOS and from the command line elsewhere), and `desktopName` for correct Linux window grouping.

### Removed on purpose

- **The fake Tor command.** The Tauri app had a `start_tor_node` command that printed a message and
  returned "Tor node started on ports 9050/9051" without starting anything. It is gone, and
  nothing in the UI or docs claims Tor support until item 6 exists.
- **The Helia in-process IPFS node** of the first Electron version. A separate Kubo process is
  more complete, easier to reason about and shared with other IPFS tools.
- **The Tauri shell** (the Rust backend and its IPC), replaced by the Electron main process.
- The Next.js shell and the Qt prototype are only kept in Git history (tag `archive/pre-electron-rewrite`).

## Goal
Build the Desktop Bucks Browser as the command center for the hybrid P2P super app:
universal profile, provider modes, locality discovery, taxi dispatch, storefronts, social feed,
IPFS storage, relay/index nodes, mock wallet, and future Bucks-chain settlement.

## Phase 1: Desktop Identity And Signed Events
- Move DID/keypair generation into the Tauri desktop app.
- Store private keys in OS-secured storage instead of plain browser storage.
- Define signed event shape: `eventId`, `eventType`, `authorDid`, `topic`, `payloadHash`, `signature`, `createdAt`, `payload`, optional `previousEventId`.
- Add local event log and outbox before any network publish.
- Acceptance: profile updates and local actions can be verified offline from signature + payload hash.

## Phase 2: Universal Profile And Provider Modes
- Add one common user profile for every role.
- Add provider modes: `vehicle`, `skill`, `business`.
- Vehicle mode: vehicle info, service radius, online/offline, ride availability.
- Skill mode: skill tags, locality, portfolio/gallery, booking availability.
- Business mode: storefront, menu/products/services, media, open/closed status.
- Acceptance: one identity can activate multiple modes without separate accounts.

## Phase 3: Locality Search And Verified Index
- Build a local searchable index from signed provider/storefront events.
- Search by keyword, category, locality, online status, and distance.
- Add index-node mode later so anyone can serve search results that clients verify.
- Acceptance: searches like `plumber`, `biryani`, and `taxi` return relevant local providers.

## Phase 4: Taxi Dispatch
- Define `ride.requested`, `ride.accepted`, `ride.cancelled`, `ride.completed`.
- Broadcast ride requests to locality topics and online vehicle providers.
- Use first-valid-accept-wins assignment in local state and future dispatch nodes.
- Queue events when offline and replay when relays return.
- Acceptance: two drivers cannot both win the same ride request.

## Phase 5: P2P Transport And Offline Relay
- Add topic conventions:
  - `/bucks/providers/{locality}/{category}`
  - `/bucks/rides/{locality}/taxi`
  - `/bucks/feed/{did}`
  - `/bucks/messages/{recipientDid}`
  - `/bucks/nodes/{nodeType}`
- Use IPFS for content-addressed profiles, media, storefronts, posts, and event snapshots.
- Add relay/store-and-forward for offline delivery.
- Acceptance: app remains local-first and syncs when peers/relays are reachable.

## Phase 6: Mock Wallet, Staking, And Chain Adapter
- Mock wallet: balances, ride payment holds, release/refund, provider earnings.
- Mock node staking: bootstrap, relay, index, dispatch, pinning.
- Chain adapter interface for later Bucks contracts: stake, slash, escrow, settle, reward, attest.
- Acceptance: product flows work without real chain, but contracts can replace mocks later.

## Phase 7: Desktop UI Completion
- Convert `/superapp` cards into live forms and tables.
- Convert `/implementation` into a build-status dashboard.
- Add desktop navigation for super app, IPFS, wallet, node ops, and implementation phases.
- Keep browser chrome compact, stable, keyboard-friendly, and desktop-first.
- Acceptance: a tester can create a profile, add a provider mode, go online, search, request a ride, accept as driver, and inspect signed events.

## Build Order
1. Identity + signed event store.
2. Universal profile + provider modes.
3. Locality search from local signed index.
4. Ride request and first-accept dispatch.
5. P2P publish/subscribe and relay fallback.
6. Mock wallet and node staking.
7. Replace mocks with Bucks-chain contracts when available.

## Rule
Every feature should work locally first, write a signed event second, publish to P2P third,
and only then depend on relay, indexer, staking, or chain infrastructure.
