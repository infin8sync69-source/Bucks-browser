# Connecting your devices

This guide connects two (or more) computers that run Bucks Browser, for example an Ubuntu laptop
and a MacBook Air, so you can send files from one to the other. There is no server or account in
between: each copy of Bucks runs its own IPFS node, and paired nodes talk to each other directly.

In short: install Bucks on both computers, open `bucks://ipfs` on both, click **Pair** on both,
then use **Send to my devices**.

## 1. Install Bucks on each computer

Both computers need a version of Bucks whose IPFS page has a **Devices** section. If one of them
already has Bucks, update it first by running its install command again.

| Computer | Install or update with |
|---|---|
| Linux (Ubuntu 24.04 and others) | `curl -fsSL https://raw.githubusercontent.com/infin8sync69-source/Bucks-browser/electron-main/scripts/install-linux.sh \| bash` |
| Mac (Apple Silicon or Intel, macOS 12 or newer; macOS 12 uses Electron 43) | `curl -fsSL https://raw.githubusercontent.com/infin8sync69-source/Bucks-browser/electron-main/scripts/install-macos.sh \| bash` |

The installers download the IPFS node (Kubo) for you. They try `dist.ipfs.tech` first and then
GitHub, so a network that blocks `dist.ipfs.tech` is fine. Details and prerequisites are in the
[README](../README.md).

## 2. Open the Devices section

On each computer:

1. Start Bucks. The first start can take a minute while the IPFS node sets itself up.
2. Type `bucks://ipfs` in the address bar. The card at the top says **Node Online** when the node is
   running. If it says something else, see [Troubleshooting](#troubleshooting).
3. Scroll to **Devices**. Its status line says **Listening for your devices** when it is ready.

### The "This device" card

| Field | What it is |
|---|---|
| Name | How this computer appears to your other devices. It starts as the computer's name; click the pencil to change it (up to 64 characters). |
| Peer ID | The node's identity, a long string starting with `12D3Koo`. Pairing trusts this ID. |
| Pairing address | Where other devices can reach this one, for example `/ip4/192.168.1.20/tcp/40785/p2p/12D3Koo…`. The number after `/tcp/` is this node's network port (it is picked at first start and normally stays the same). Click the copy button to copy it. |

If the pairing address says the device has no network address yet, connect it to Wi-Fi or a cable;
the address appears once the node is listening on that network.

## 3. Pair the two computers

### On the same Wi-Fi or network (automatic discovery)

1. Keep both computers on the same network with Bucks open.
2. Within about a minute each one appears on the other under **Nearby Bucks devices**, with its
   name, system (Linux or macOS) and the start and end of its peer ID. Discovery uses mDNS, the same
   local-network discovery printers and speakers use.
3. Before you click, check that the peer ID shown matches the one on the other computer's "This
   device" card (compare the last few characters).
4. Click **Pair** on the Mac, and **Pair** on the Linux laptop. Pairing is one-way until both sides
   have done it: each computer only accepts files from devices *it* has paired.

The device then moves to **Paired devices** on both computers. Pairings are remembered, and the
two nodes reconnect on their own whenever both are running.

### When discovery does not find the other computer (pair manually)

Automatic discovery needs the two computers to see each other's local-network announcements. It
does not work across different networks, and some routers, mesh systems and office networks block
those announcements even between devices on the same Wi-Fi.

1. On computer A, copy the **Pairing address** from the "This device" card.
2. Get it to computer B (a message to yourself, a note, a USB stick).
3. On computer B, paste it into **Pair manually** and click **Pair**. A bare peer ID (`12D3Koo…`)
   also works, but then the node has to search for the other device, which is slower; the full
   pairing address is better.
4. Computer A now sees B under **Nearby Bucks devices** within about a minute. Click **Pair** there
   (or paste B's pairing address into A's **Pair manually**).

Which network setups work:

| Situation | Works? |
|---|---|
| Same home Wi-Fi or office LAN | Yes, usually automatically. |
| Same network, but discovery is blocked (multicast filtered, mesh Wi-Fi, 2.4 GHz and 5 GHz bands kept apart) | Yes, with manual pairing. |
| Guest Wi-Fi or any network with "client isolation" / "AP isolation" | No. These networks block all traffic between devices, so manual pairing cannot connect either. Use another network, an Ethernet cable, or a VPN. |
| Different networks (home and office, home and phone hotspot) | Only when one computer can reach the other: with a VPN such as Tailscale, WireGuard or ZeroTier (open the "other addresses" list on the "This device" card and use the address with the VPN's IP), or with the node's port forwarded on the router (TCP and UDP) and the public IP in the address. Over the open internet without either, it may or may not connect. |

### Firewalls

**macOS.** The first time Bucks starts, macOS may ask:

- *Do you want the application "ipfs" (or "Electron") to accept incoming network connections?*
  Choose **Allow**. This is what lets the Linux laptop connect to the Mac. If you chose Deny, open
  **System Settings > Network > Firewall > Options…**, find `ipfs` or `Electron`, and set it to
  allow incoming connections. (The macOS firewall is off by default, in which case nothing is asked.)
- On macOS 15 and later: *Allow "Bucks Browser" (or "Electron") to find devices on local networks?*
  Choose **Allow**; without it discovery and connections on your Wi-Fi do not work. To change it
  later: **System Settings > Privacy & Security > Local Network**.

**Ubuntu.** The `ufw` firewall is off by default (`sudo ufw status` prints `Status: inactive`). If
you turned it on, allow the node's port, which is the number after `/tcp/` in the pairing address
shown on the IPFS page (40785 in the example above):

```sh
sudo ufw allow 40785/tcp
sudo ufw allow 40785/udp
```

ufw's default rules already let mDNS discovery through. If discovery still fails with ufw on,
also run `sudo ufw allow 5353/udp`, or pair manually.

## 4. Send files

1. On the sending computer, open `bucks://ipfs`.
2. Add a file under **Add file** (drag it in or choose it). When it is added, click
   **Send to my devices** in the result box. Files you already have are in the pin list at the
   bottom of the page; each row has a small send button that does the same.
3. The button reports **Sent to 1 online device**, or **Queued; will deliver when your devices
   come online** when none is online right now. The button is greyed out until you have paired a
   device.

On the receiving computer the file appears under **Received from your devices**, with its name,
size, sender and time:

- **Open** opens it in a new tab (`ipfs://<cid>`).
- **Pin** keeps a copy on this computer, so it stays available when the sender is off.
- **×** removes it from the list. It does not delete or unpin anything.

What "sending" means: Bucks sends the other device the file's IPFS address (its CID) and name, not
the file itself. The receiving computer downloads the content directly from the sender when you
open or pin it, so leave the sending computer on until the file is open or pinned on the other one.

**Auto-pin.** To have files copied over as soon as they arrive, turn on **Settings > Devices >
Pin files from my devices automatically** on the receiving computer. Received files then show a
**pinned** badge once the copy is complete.

Delivery details:

- A computer that is off or asleep gets the files it missed when it comes back online, as long as
  that is within 7 days. Each device re-announces its recent sends every 30 seconds.
- Only the 20 newest sends are re-announced, so if you send more than 20 files while the other
  computer is away, it only gets the newest 20. Send the others again later.
- The received list keeps the 100 newest entries.

## 5. Check that they are connected

| Where | What to look for |
|---|---|
| Devices status line | **Listening for your devices · 1 of 1 online** |
| Paired devices | A green dot means **Online**: Bucks heard from that device in the last 90 seconds. Grey means offline, with **Last seen …**. A **connected** badge means there is a direct connection right now, which is what file transfers use. |
| Node card at the top of `bucks://ipfs` | **Peers** counts every IPFS node yours is connected to, including your other device and nodes on the public IPFS network. 0 means the node has no network at all. |

Online without **connected** means the two can hear each other's announcements but have no direct
connection; transfers may be slow or fail. Check the firewall section above.

To stop trusting a device, click **Unpair** next to it and confirm, on both computers.

## Security and privacy

- **Pairing trusts a peer ID.** Every message on the device channel is signed by the node that sent
  it, so a paired device cannot be impersonated. Only paired devices can put files in your
  Received list. Anything under Nearby Bucks devices is just something seen on the network, and is
  never trusted until you click Pair. Only pair devices you recognise, after comparing peer IDs.
- **Announcements are not private.** Devices talk over the IPFS pubsub topic `bucks-devices-v1`.
  Any IPFS node that subscribes to that topic and connects to yours can read what your Bucks
  announces: the device name, system and Bucks version, its network addresses (including local IP
  addresses), and the names, sizes and CIDs of the files you sent in the last 7 days. Choose a
  device name you are comfortable sharing.
- **Files added to IPFS are public to anyone who has the CID.** Anyone who learns a CID can fetch
  that content from your node while it is online, and copies may spread to other nodes. Pairing
  does not encrypt anything. Do not send passwords, keys, ID documents or other secrets this way
  unless you encrypt them first (for example an encrypted zip or `age`). End-to-end encryption for
  shares is on the [roadmap](ROADMAP.md).
- With auto-pin on, files from your paired devices are downloaded to your disk automatically. Only
  enable it for devices you control.

## How it works

For the curious; the exact protocol is in [IPC-CONTRACT.md](IPC-CONTRACT.md#devices-pairing-bucks-installs-over-ipfs-peering--pubsub).

- Bucks turns on Kubo's pubsub (gossipsub) and mDNS local discovery every time it starts its own
  (embedded) node. An external node must have pubsub enabled by you, see Troubleshooting.
- Paired devices are stored in Bucks's settings (`ipfs.peers`) and given to Kubo as permanent peers
  (`Peering.Peers`), so the nodes keep a connection and reconnect after a restart or a network
  change. Pairing and unpairing take effect immediately, without restarting the node.
- Each device publishes a small signed "presence" message on `bucks-devices-v1` when it starts, every
  30 seconds, and right after you pair, unpair, rename or send. It carries the device's name,
  addresses and its recent sends. When a paired device's address changes (a new IP from the router),
  the others pick up the new one from its next presence.
- Received files and your recent sends are kept in `devices.json` in the Bucks profile folder:
  `~/.config/Bucks Browser/` on Linux, `~/Library/Application Support/Bucks Browser/` on macOS.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Devices says **Waiting for the IPFS node…** | The node is still starting, or stopped. | Look at the node card at the top of `bucks://ipfs`; click **Start** if it is stopped. The first start may still be downloading the node. |
| The node card says it could not download the IPFS node (`fetch failed`) | Your network blocks the download site. | Run the install command again: it downloads Kubo from GitHub when `dist.ipfs.tech` is blocked. Or install it by hand, see below. |
| Devices shows **Pubsub is disabled on the external IPFS node…** | Settings use an external node (IPFS mode `external`) without pubsub. | On that node run `ipfs config --json Pubsub.Enabled true` and restart it, or switch the IPFS mode back to `embedded` in Settings. |
| The other computer never shows up under Nearby Bucks devices | Different networks, discovery blocked by the router, firewall, or (macOS 15+) Local Network permission denied. | Check the firewall section, then pair manually. |
| Pair manually says it is this device's own peer ID | You pasted this computer's own address. | Copy the pairing address from the *other* computer. |
| Paired, but files sent never show up on the other side | The other side has not paired back. | Click **Pair** on both computers. |
| Paired device stays grey (offline) | That computer is off, asleep, or Bucks is closed there; or the network blocks the connection. | Open Bucks on it. If both are on and it stays grey, pair manually with its current address and check firewalls. |
| Online, but never **connected** | Announcements arrive, but no direct connection is possible. | Allow incoming connections (macOS firewall, ufw) for the node's port. |
| A received file does not open, or **Pin** never finishes | The content comes from the sender, which is off or unreachable. | Turn the sending computer on with Bucks open, wait for **connected**, then try again. |
| Pairing address shows a VPN or unexpected address first | The node lists every network it listens on. | Open the "other addresses" list and copy the one for the network both computers share. |

### Installing the IPFS node by hand

Only needed when neither the installer nor the app can download it. In Terminal, on the computer
that is missing it (replace `darwin-arm64` with `darwin-amd64` on an Intel Mac, or `linux-amd64`
/ `linux-arm64` on Linux):

```sh
cd ~/Downloads
curl -fLO https://github.com/ipfs/kubo/releases/download/v0.43.1/kubo_v0.43.1_darwin-arm64.tar.gz
curl -fLO https://github.com/ipfs/kubo/releases/download/v0.43.1/kubo_v0.43.1_darwin-arm64.tar.gz.sha512
shasum -a 512 -c kubo_v0.43.1_darwin-arm64.tar.gz.sha512    # Linux: sha512sum -c …
tar -xzf kubo_v0.43.1_darwin-arm64.tar.gz
```

Then copy `kubo/ipfs` into the Bucks profile folder and restart Bucks:

```sh
# macOS
mkdir -p "$HOME/Library/Application Support/Bucks Browser/kubo/bin"
cp kubo/ipfs "$HOME/Library/Application Support/Bucks Browser/kubo/bin/ipfs"
# Linux
mkdir -p "$HOME/.config/Bucks Browser/kubo/bin"
cp kubo/ipfs "$HOME/.config/Bucks Browser/kubo/bin/ipfs"
```

Downloading with `curl` in Terminal (rather than a web browser) keeps macOS from marking the file as
downloaded from the internet, so Gatekeeper does not block it.
