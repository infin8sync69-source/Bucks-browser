# Bucks Desktop Super App: Phased Implementation Setup

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
