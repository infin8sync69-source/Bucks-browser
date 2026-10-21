# Your devices: pair your Bucks installs and send files

Two or more computers running Bucks can pair directly, with no server or account in between, and
send each other files. Open the hamburger menu, then **Your devices**.

Code: `electron/hosting/src/main/ipfs/devices-core.js` (pure logic), `devices-service.js`
(pairing, presence, shares) and `devices.js` (Electron glue), ported from Bucks-browser. UI:
`electron/devices-panel.js`. The wire protocol is specified in Bucks-browser's `docs/IPC-CONTRACT.md`, section "Devices".

## How it works

* Each Bucks runs a pinned Kubo node (the same one that serves hosted sites). It starts when you
  open the panel or publish a site, and stops when Bucks quits. Your Helia node is untouched.
* Kubo has pubsub (gossipsub) and LAN mDNS discovery switched on, and paired devices are kept
  connected through Kubo's `Peering.Peers`.
* A device is identified by its Kubo peer ID. Pubsub messages are signed, so the sender of a
  message is authenticated.
* **Pairing is explicit and one-way until both sides do it.** Only messages from devices *you*
  paired can add files to your list. Devices seen on the network but not paired are shown as
  "Nearby", never trusted.
* Pairings live in `<userData>/hosting/settings.json` (`ipfs.peers`), shares in
  `<userData>/hosting/devices.json`.

## Pairing

1. Open **Your devices** on both computers.
2. On the same network, each appears under **Nearby Bucks devices** on the other. Check that the
   peer ID matches the other computer's "This device" card, then click **Pair** on both.
3. Otherwise copy the **Pairing address** from one computer and paste it into **Pair manually** on
   the other (and the reverse). Discovery does not cross networks and some routers block it.

## Sending files

Paste a CID of a file that is on this node and click **Send**. Paired devices see it under
**Received files** and can open it (`ipfs://<cid>`), copy the CID or dismiss it. Messages sent
before two nodes have connected are lost, so each device repeats its outbox in every presence
announcement (every 30 s) and files arrive when both are online.

## Privacy and limits

* The pubsub topic (`bucks-devices-v1`) is public: anyone on the gossip mesh can see a device's
  presence (name, addresses, the CIDs it offered in the last 7 days).
* Only paired devices can send you files; nothing is pinned automatically unless
  `devices.autoPin` is on in `hosting/settings.json`.
* Only the app's own shell page may call `bucks:devices:*`; web pages cannot.

This is separate from `electron/device-sync.js`, which links Soul identities over Helia gossip; it is
not affected.

## Tests

* `cd electron/hosting && npm test` (pure logic, the service against a fake node, the IPC layer).
* `BUCKS_KUBO_BIN=<path to ipfs> node --test test/unit/ipfs/devices.integration.test.js` pairs two
  real Kubo daemons, shares a file, auto-pins it and unpairs.
* `cd electron && npx playwright test tests/devices-panel.spec.js` drives the panel in the app.
