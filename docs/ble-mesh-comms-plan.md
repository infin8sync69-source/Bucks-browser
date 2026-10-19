# BLE Mesh Communications: Architecture & Implementation Plan

**Status:** Proposal / design-stage — no code merged yet
**Scope:** `bucks browser/` (Electron desktop) + `bucks-mobile/` (iOS Swift + Android Kotlin)
**Author context:** Extends the existing libp2p/Helia P2P stack and Signal-derived E2E layer already shipped in `electron/ipfs-node.js`, `electron/chat-engine.js`, and `electron/signal-store.js`

## 0. Why this exists

Today, peer discovery and messaging depend on mDNS (LAN-local) and gossipsub over TCP/WebSocket libp2p transports (internet-routable, requires the swarm to actually connect). Both assume the participants share a network. A bitchat-style Bluetooth Low Energy (BLE) mesh removes that assumption entirely: two Souls standing in the same room, with no Wi-Fi, no SIM, no internet, no shared LAN — a subway platform, a protest, a disaster-response tent, a conference hall with hostile Wi-Fi — can still discover each other and exchange text, and with later phases, exchange voice, over nothing but Bluetooth radios hopping packets peer-to-peer. This is the same value proposition bitchat (Jack Dorsey's BLE mesh chat app, built on Apple's `MultipeerConnectivity`-adjacent BLE stack) demonstrated, but wired into Bucks' existing identity (Soul keypairs), transport abstraction (libp2p), and storage layer (Helia/IPFS) instead of being a standalone app.

The design goal throughout: **BLE is a new libp2p transport, not a new protocol stack.** Every layer above the radio — identity, encryption, message format, gossip topic — should be reused unmodified from what already ships. This keeps the mesh from becoming a second, parallel, under-maintained implementation of everything the TCP path already does correctly.

---

## 1. BLE Mesh Transport Layer

### 1.1 Platform BLE primitives

BLE mesh requires every device to act as **both** a GATT peripheral (advertising, accepting connections) and a GATT central (scanning, initiating connections) simultaneously — dual-role. This is the load-bearing constraint the whole design has to route around, because the three platforms expose it with meaningfully different ceilings:

| Platform | Peripheral API | Central API | Practical dual-role limit |
|---|---|---|---|
| iOS (`bucks-mobile/BucksMobile`) | `CBPeripheralManager` | `CBCentralManager` | Both run concurrently fine; background peripheral advertising is throttled by iOS to opportunistic/low-duty-cycle mode and background scanning only reports services in the advertisement's overflow area. Foreground is unrestricted. |
| Android (`bucks-mobile/app`) | `BluetoothLeAdvertiser` | `BluetoothLeScanner` | Concurrent advertise+scan supported since API 21, but max concurrent GATT server connections is vendor-dependent (commonly 4–7). Doze mode suspends scanning unless the app holds a foreground service. |
| Electron/desktop (`bucks browser/electron`) | `@abandonware/noble` (central only — most desktop BLE stacks have poor/no peripheral-mode support) | `@abandonware/noble` | Desktops typically **cannot advertise as a BLE peripheral** reliably (BlueZ peripheral-mode support on Linux is fragile; macOS/Windows Node bindings for peripheral mode are effectively unmaintained). Treat desktop as **central-and-relay-only**: it can scan for and connect to mobile peripherals and forward traffic onto the libp2p swarm, but does not advertise its own BLE identity by default. |

This asymmetry is a real constraint, not an oversight to paper over: desktop's role in the mesh is **bridge node**, not mesh peer. A desktop running the Electron app with Bluetooth enabled becomes a gateway that mobile mesh peers can route through to reach the internet-connected libp2p swarm — which is actually the more valuable role, since it lets a phone with no cellular/Wi-Fi reach IPFS and the rest of the network via a nearby laptop.

- **iOS**: `CoreBluetooth`, `CBPeripheralManager.startAdvertising(_:)` with a custom service UUID, `CBMutableCharacteristic` for the packet-relay characteristic (write-without-response for outbound relay, notify for inbound).
- **Android**: `BluetoothLeAdvertiser.startAdvertising()` + `BluetoothGattServer` for the peripheral side, `BluetoothLeScanner.startScan()` + `BluetoothGatt.connectGatt()` for central.
- **Electron**: `@abandonware/noble` for central/scan; no peripheral advertising attempted in v1.

### 1.2 Mesh topology: flooding, chosen over source-routing

Two real options exist for multi-hop delivery:

1. **Controlled flooding** (bitchat's approach, and BLE mesh's in general — cf. Bluetooth SIG Mesh profile): every node that receives an unseen packet rebroadcasts it once, bounded by TTL and a seen-packet cache for dedup.
2. **Source/table-driven routing** (AODV/OLSR-style): nodes maintain routing tables, compute paths, forward only along known routes.

**Decision: flooding.** Reasoning:

- BLE mesh membership is **highly transient** — peers walk in and out of range every few seconds to minutes. Route tables in AODV/OLSR converge over multiple round trips; by the time a route stabilizes in this mesh, the topology has already changed. Flooding needs zero convergence time.
- Node counts per local mesh are small (bitchat-scale deployments: single-digit to low tens of simultaneously-reachable peers). Flooding's O(n) rebroadcast cost is cheap at this scale; it only becomes a problem at hundreds of nodes, which is not the target.
- Flooding needs no per-node state beyond a bounded LRU of seen packet IDs — critical on memory-constrained mobile BLE stacks and important given the disk/RAM constraints already documented for this project's target hardware.
- The failure mode of flooding (redundant rebroadcasts) is bandwidth waste; the failure mode of routing (stale/broken routes) is silent message loss. Given BLE's already-thin bandwidth budget, silent loss is the worse failure to risk.

Cost paid: no traffic shaping, higher redundant airtime. Mitigated by TTL bounding (§1.3) and randomized rebroadcast jitter (10–50ms) to avoid all neighbors retransmitting in lockstep and colliding.

### 1.3 Multi-hop packet format

```
┌──────────┬──────────┬───────────┬──────────┬────────────┬───────────┬──────────────┐
│ version  │   type   │    ttl    │  nonce   │  origin_id │  payload  │  signature   │
│  1 byte  │  1 byte  │  1 byte   │ 8 bytes  │  8 bytes   │ variable  │   64 bytes   │
└──────────┴──────────┴───────────┴──────────┴────────────┴───────────┴──────────────┘
```

- `version` (1B): packet format version, allows the mesh to evolve without breaking old firmware/app versions mid-rollout.
- `type` (1B): `0x01 ANNOUNCE` (identity/capability advertisement relay), `0x02 MESSAGE` (E2E chat payload), `0x03 STORE_FORWARD` (buffered CID reference), `0x04 CALL_SIGNAL` (voice/video signaling), `0x05 AUDIO_FRAME` (BLE voice payload), `0x06 ACK` (optional delivery ack, best-effort only).
- `ttl` (1B): starts at **6** (empirically enough for ~5-6 hops at 10-30m/hop → 150-200m effective mesh diameter without saturating airtime), decremented at each relay, dropped at 0.
- `nonce` (8B): random per-packet value combined with `origin_id` to form the **dedup key** (`sha256(origin_id || nonce)`, truncated to 16B, kept in an LRU seen-set sized ~2048 entries with a 5-minute expiry). This is distinct from the secp256k1 message signature used at the application layer (§3.4) — the mesh-layer dedup key must be checkable *before* the (more expensive) signature verification, purely to decide "have I already relayed this," so a relay can drop duplicates in microseconds without doing a cryptographic verify on every packet it's already seen.
- `origin_id` (8B): truncated hash of the sending Soul's libp2p PeerID — enough entropy to make dedup collisions negligible at mesh scale, small enough to fit BLE's tight MTU budget.
- `payload`: type-dependent, see §2–5.
- `signature` (64B): secp256k1 signature over `version||type||ttl_original||nonce||origin_id||payload` by the **origin's** Soul key (not the relaying peer's) — this is what lets any relay or recipient verify authenticity without trusting intermediate hops, and it's the same signature scheme already used for gossipsub message authentication in `chat-engine.js`.

**BLE ATT MTU reality check**: default BLE MTU is 23 bytes (20 usable after ATT header); negotiated MTU on modern stacks commonly reaches 185–247 bytes. The packet header above is 83 bytes fixed overhead, leaving little room for payload at default MTU. **Mandatory MTU negotiation to 247 bytes** on connect (`requestMtu(247)` on Android, automatic on iOS via `peripheral.maximumWriteValueLength`) is a hard requirement, not an optimization — text messages beyond a single MTU frame are chunked with a 2-byte fragment index/total header inside the payload and reassembled at the receiving GATT characteristic before the outer packet is parsed.

### 1.4 Range and coverage

Single-hop BLE range: ~10m indoors (walls, bodies attenuate significantly), ~30m outdoors line-of-sight. TTL=6 flooding gives a **theoretical** mesh diameter of 60-180m through a densely-populated straight-line chain, but real coverage is topology-dependent — a mesh is only as wide as bodies are willing to stand. This is explicitly a **local, opportunistic** mesh, not a WAN replacement; positioning it as such in the product UI (a distinct "Nearby Mesh" indicator, not folded into general peer count) avoids setting the wrong expectation.

### 1.5 Coexistence with existing libp2p transports

The existing stack (`electron/ipfs-node.js`) runs libp2p over TCP + WebSocket with `@chainsafe/libp2p-gossipsub@14.1.2` pinned against `@libp2p/interface@2.11.0` (see `ipfs-experiment-report-dependency-fix.md` — this pin is load-bearing, any BLE transport addition must resolve against the *same* `@libp2p/interface@2.11.0` line or we reintroduce the exact dual-tree class-identity bug already fixed there). BLE is added as an **additional transport**, not a replacement:

```
libp2p.transports = [
  tcp(),
  webSockets(),
  bleMeshTransport(),   // new
]
```

A node with both internet connectivity and BLE active is simultaneously reachable over all three. Gossipsub itself is transport-agnostic — it works over whatever `Connection` objects the registered transports hand it — so the *same* topic subscriptions and message-handling code in `chat-engine.js` continue to work unmodified once a BLE `Connection` exists; the transport layer is where the actual new work lives.

### 1.6 BLE as a libp2p transport plugin

libp2p defines a `Transport` interface: `dial(multiaddr) → Connection`, `createListener() → Listener`, and a `filter` to claim which multiaddrs it handles. BLE doesn't have a natural multiaddr scheme, so we mint one: `/ble/<peripheral-uuid>`. The transport implementation:

```js
// electron/ble-mesh-transport.js (new)
class BLEMeshTransport {
  constructor({ noble, upgrader }) { this.noble = noble; this.upgrader = upgrader; }

  // Called by libp2p when dialing a discovered BLE peer's multiaddr
  async dial(ma, opts) {
    const peripheralId = ma.decapsulate('/ble/').toString();
    const peripheral = await this.noble.connectAsync(peripheralId);
    const stream = new BLEGattStream(peripheral, MESH_SERVICE_UUID, MESH_CHAR_UUID);
    return this.upgrader.upgradeOutbound(stream, opts); // multistream-select + noise/plaintext, same as any libp2p conn
  }

  createListener(opts) {
    return new BLEPeripheralListener(opts); // wraps CBPeripheralManager/BluetoothGattServer equivalents per platform
  }

  filter(multiaddrs) { return multiaddrs.filter(ma => ma.protoNames().includes('ble')); }
}
```

`BLEGattStream` implements the minimal `{ sink, source }` duplex-iterable interface libp2p transports require, translating GATT characteristic writes/notifications into a byte stream, with the fragmentation/reassembly from §1.3 handled inside it. This is genuinely the most delicate piece of the whole plan — BLE's connection-oriented GATT model maps awkwardly onto libp2p's expectation of a persistent bidirectional stream, and connection setup latency (BLE connection interval negotiation, service discovery) is 200ms-2s per new peer, versus sub-50ms for TCP. Expect connection establishment, not data transfer, to be the dominant mesh latency cost.

---

## 2. Peer Discovery & Identity

### 2.1 BLE advertisement payload

BLE advertisement packets are capped at 31 bytes legacy / 255 bytes extended (Android 8+/BLE 5.0). We use a compact custom manufacturer-specific-data structure:

```
┌────────────┬──────────────────┬─────────────┬──────────┐
│ soul_addr8 │  peer_id_hash8   │  cap_flags  │  seq (1B)│
│  (8 bytes) │    (8 bytes)     │   (1 byte)  │          │
└────────────┴──────────────────┴─────────────┴──────────┘
```

- `soul_addr8`: first 8 bytes of the Soul on-chain address (Chain 8192) — enough to recognize "is this a known contact" without leaking the full address over an unauthenticated broadcast channel; full verification happens after connection via the existing pre-key bundle exchange.
- `peer_id_hash8`: truncated libp2p PeerID hash, used to correlate the BLE-discovered peer with an already-known libp2p identity (e.g., a contact previously met over the internet mesh).
- `cap_flags` (1 byte bitfield): `bit0 can-relay`, `bit1 has-GPU`, `bit2 has-model` (paired with a follow-up GATT read for the specific model list, since it won't fit in the advertisement itself), `bit3 video-capable`, `bit4 can-infer`, `bits5-7 reserved`.
- `seq`: rolling sequence number, lets scanners detect a restarted/rotated advertisement versus a stale cached one.

Full detail (model list, display name, avatar CID) is fetched via a GATT characteristic read *after* a BLE connection is established — the advertisement is purely a low-bandwidth "who's nearby and roughly what can they do" beacon, not the full profile.

### 2.2 Combined mDNS + BLE discovery

Both feed the same internal `PeerRegistry` abstraction already implicit in `ipfs-node.js`'s peer-connect handling — a discovered peer, regardless of channel, becomes a `DiscoveredPeer { peerId, transports: Set<'mdns'|'ble'|'direct'>, capabilities, trustLevel }`. If mDNS and BLE both discover the same `peer_id_hash`, the entry merges rather than duplicating, and libp2p's dialer prefers TCP/WebSocket over BLE when both are available (BLE is the fallback of last resort, not a preference — it's slower and more battery-costly per byte).

### 2.3 QR pairing fallback

The app already has QR-based X3DH bundle exchange (`electron/bucks-qr.html`, referenced in the pre-key bundle flow in `signal-store.js`). BLE mesh reuses it unmodified for the case where two devices want to establish a **verified direct contact** relationship rather than relying on opportunistic mesh discovery — scanning each other's QR code performs the same pre-key bundle exchange it already does today, just with BLE (instead of only internet gossipsub) as an available transport for the subsequent traffic.

### 2.4 Trust levels

| Level | How established | What it grants |
|---|---|---|
| **Anonymous mesh peer** | BLE advertisement seen, no prior relationship | Can relay packets for others (flooding doesn't require trust); their own messages are E2E-illegible to us unless they initiate a session |
| **Verified Soul** | `soul_addr8` resolves to a known on-chain Soul (checked against Chain 8192 state when connectivity allows) | Displayed with verified badge; capability claims (has-GPU etc.) weighted higher for inference routing (§7) |
| **Direct contact** | X3DH session already established (QR pairing or prior internet-mesh contact) | Full E2E messaging over BLE immediately, no new handshake needed — same Double Ratchet session, new transport |

---

## 3. Messaging over BLE Mesh

### 3.1 Extending X3DH + Double Ratchet onto BLE

`signal-store.js`'s `performX3DH` / `respondX3DH` / ratchet session functions are transport-oblivious already — they operate on byte blobs exchanged via whatever channel `chat-engine.js` hands them. The only change needed is a new send/receive path: `chat-engine.js` currently does `gossip.publish(BUNDLE_TOPIC, data)` / `gossip.publish(CHAT_TOPIC, data)` over the libp2p pubsub instance. When BLE is the active transport to a given peer, the same encrypted envelope is instead wrapped in a `type: 0x02 MESSAGE` mesh packet (§1.3) and handed to the flooding relay logic. **The ciphertext produced by the Double Ratchet is identical regardless of which transport carries it** — this is exactly the point of keeping BLE as a transport-layer concern only.

### 3.2 Store-and-forward via IPFS

When the intended recipient isn't currently reachable (no direct BLE link, and they're not on the internet mesh either), a relaying peer can't hold the full message in BLE-packet form indefinitely — GATT connections don't persist across peer movement. Instead:

1. Sender encrypts the message normally (Double Ratchet ciphertext).
2. Sender adds the ciphertext blob to their local Helia node → gets a CID.
3. Sender broadcasts a small `type: 0x03 STORE_FORWARD` packet over the mesh containing `{ recipient_hash, cid, expiry }` — this is small enough to flood cheaply even when the payload itself is large.
4. Any relaying peer with `can-relay` capability pins the CID locally for a **1-hour TTL** (matching the group-channel store-and-forward TTL already specified for group history) via `ipfs-bridge.js`'s existing pin API.
5. When the recipient comes into range of any peer holding the pin (not necessarily the original sender), they fetch the CID over Bitswap/mesh and decrypt locally.
6. Expired unclaimed pins are garbage-collected by each relay locally; this is deliberately best-effort, not guaranteed delivery — BLE mesh store-and-forward is a convenience layer, not a durability guarantee. Guaranteed durable delivery still goes through the internet-connected IPFS path when available.

### 3.3 GossipSub topic routing over the mesh

The existing topic-naming convention hashes `CLUSTER_SECRET` into topic strings (`bucks-chat-<hash16>`, `bucks-swarm-<hash16>`, etc. — see `chat-engine.js` and `ipfs-node.js`). BLE mesh introduces one more: `bucks-mesh-<hash16>` (same derivation: `sha256(CLUSTER_SECRET).slice(0,16)`), used specifically for `ANNOUNCE` and `CALL_SIGNAL` packet types that benefit from mesh-wide gossip rather than point-to-point relay. Regular 1:1 `MESSAGE` packets are **not** gossiped to this topic — they're addressed (via `recipient_hash` in the payload) and only flood as far as needed to reach that recipient or a relay holding their store-and-forward pin, to avoid broadcasting private message ciphertext to every mesh participant unnecessarily (gossipsub gets used for genuinely public/group traffic; targeted flooding for private 1:1 traffic).

### 3.4 Dedup via signature-as-nonce

Application-layer messages are already secp256k1-signed before being handed to the transport (this is how `chat-engine.js` currently authenticates gossipsub `msg.from`). The mesh relay layer's own dedup (§1.3, `sha256(origin_id||nonce)`) is a cheap pre-filter; the *authoritative* dedup for delivered application messages is the message signature itself, since two honest relays flooding the same origin message will produce packets with the same signature bytes even if mesh-layer nonces briefly diverge due to fragmentation retries. Receivers de-duplicate on signature at the chat-engine layer exactly as they would for a gossipsub-delivered duplicate today.

### 3.5 Bandwidth budget

BLE 5.0 theoretical raw throughput: ~2 Mbps (LE 2M PHY). Real achievable application throughput after GATT overhead, connection interval negotiation, and retries: **50-100 KB/s** on a good link, often much less with multiple simultaneous connections (a relay node juggling several peers divides its airtime among them). Design consequence: **BLE mesh carries text and small control payloads only.** Any media (images, files, voice beyond Phase 3's dedicated low-rate codec) travels as an IPFS CID reference — the actual bytes fetched later via Bitswap when a higher-bandwidth path (Wi-Fi, internet) becomes available, or opportunistically over BLE if the recipient is patient and the file is small.

---

## 4. Voice Calling

### 4.1 Signaling

Call setup (offer/answer, ICE-equivalent transport negotiation) reuses the existing E2E channel — a `type: 0x04 CALL_SIGNAL` mesh packet when BLE is the active path, or a normal libp2p stream message when internet-connected. Signaling payload:

```json
{
  "call_id": "uuid",
  "kind": "offer" | "answer" | "end",
  "transport_pref": ["webrtc-direct", "webrtc-relay", "ble-opus"],
  "sdp": "...",            // present for webrtc offers/answers
  "codec": "opus",
  "ts": 1721990400
}
```

### 4.2 Transport selection waterfall

1. **WebRTC direct** — both peers have internet or share a LAN; standard ICE candidate exchange, lowest latency, highest quality.
2. **WebRTC via TURN relay** — an IPFS-hosted relay node (deployed alongside the existing IPFS cluster infrastructure in `ipfs/`) provides TURN service for peers behind symmetric NATs where direct/STUN-reflexive candidates fail.
3. **Opus over BLE mesh** — no internet path exists at all; fall back to a dedicated low-rate voice codec over the mesh transport itself.

The waterfall is evaluated at call-setup time based on which transports are currently live to the callee (from the `PeerRegistry` in §2.2), and can renegotiate mid-call if, say, a peer walks out of Wi-Fi range and back into pure-BLE range.

### 4.3 BLE voice: codec and framing

- **Codec**: Opus, configured at **8-16 kbps** CBR (constant bitrate — VBR's burstiness is a poor fit for BLE's fixed connection-interval scheduling), 13ms-20ms frames. This is Opus's SILK-mode narrowband/mediumband operating point — intelligible speech, not music quality, by design.
- **Framing**: each Opus frame becomes a `type: 0x05 AUDIO_FRAME` mesh packet with `ttl=1` (voice is point-to-point over the *current* best link, not flooded across the mesh — flooding audio would both waste airtime and arrive out of order from multiple paths). If the direct link drops, the call state machine attempts one relay hop (`ttl=2`) through the nearest common neighbor before failing over to "call degraded" UI state.
- **Jitter handling**: a small (100-150ms) adaptive jitter buffer client-side; BLE's connection-interval jitter is more variable than Wi-Fi/LTE, so the buffer sizing needs to be more generous than a typical VoIP default.

### 4.4 E2E for calls

- **WebRTC path**: DTLS-SRTP, WebRTC's built-in mandatory encryption — no extra work needed, but we add an **HMAC verification step** using the caller's Soul keypair over the SDP fingerprint exchanged through the (already-E2E) signaling channel, so a MITM on the signaling relay (e.g., a malicious TURN operator) can't substitute their own DTLS fingerprint undetected.
- **BLE audio path**: AES-256-GCM, key derived from the current Double Ratchet chain key at call start (`HKDF(ratchet_chain_key, "BucksCallAudio", 32)`) — reusing the existing key-derivation convention from `signal-store.js` (which already namespaces its HKDF info strings, e.g. `"BucksSignalX3DH"`). A fresh derivation per call means audio keys inherit the ratchet's forward secrecy without a separate call-specific key-agreement round trip.

### 4.5 Call state machine

```
IDLE → RINGING → CONNECTING → ACTIVE → ENDED
  │        │           │          │
  │        └─(timeout)─┴─(fail)───┴──→ ENDED
  └──(callee: incoming CALL_SIGNAL offer)
```

- `IDLE → RINGING`: callee receives `offer` signal.
- `RINGING → CONNECTING`: callee sends `answer`, both sides begin transport negotiation per the waterfall.
- `CONNECTING → ACTIVE`: media flowing (WebRTC ICE connected, or first BLE audio frame received).
- Any state `→ ENDED`: explicit `end` signal, timeout (30s ring, 15s connect), or transport exhaustion (waterfall fully failed).

### 4.6 Incoming-call push

Since a callee may not have an active connection to the caller at the moment the call is placed (BLE peers drift in and out of range), the `offer` signal is also gossiped on `bucks-mesh-<hash16>` (§3.3) so any mesh member who *does* currently have a path to the callee can relay it — this is the one case where call signaling deliberately uses gossip rather than pure point-to-point, because the goal is "reach the callee via whatever path exists right now," not "reach them via the specific path the caller happens to have."

---

## 5. Video Calling

Video is **internet/LAN-only** — BLE's 50-100 KB/s ceiling is roughly two orders of magnitude below even the lowest usable video bitrate, so no BLE video path is attempted; when BLE is the only transport, the call state machine forces `audio-only` and surfaces a status indicator (e.g., "Audio only — no video path available") rather than silently degrading.

- **Codec**: VP9 primary (broad WebRTC support today), AV1 as a forward-looking option once encode support is confirmed acceptable on target mobile hardware. Adaptive bitrate range **100 kbps (poor) → 2 Mbps (good)**, driven by WebRTC's built-in bandwidth estimation (GCC/BBR-style congestion control already part of libwebrtc) rather than a custom estimator.
- **Relay**: the same IPFS-hosted TURN infrastructure from §4.2, extended with **libp2p circuit relay v2** for the signaling/data-channel side where a direct WebRTC path can't be established even via TURN (e.g., corporate firewalls blocking UDP entirely) — circuit relay v2 gives a fallback relayed libp2p stream that can carry the WebRTC data channel's negotiation traffic even when media itself still needs TURN.
- **Screen share**: piggybacks the same WebRTC data-channel/media-channel infrastructure as camera video, capped at **1080p/15fps** — deliberately conservative to keep it usable over the "good but not great" end of the adaptive range rather than only over ideal connections.
- **Group video (SFU)**: out of scope for initial deployment, but the interface is designed now so later work slots in cleanly:

```ts
interface SFUSession {
  joinRoom(roomId: string, localTracks: MediaStreamTrack[]): Promise<RemoteParticipant[]>;
  onParticipantJoined(cb: (p: RemoteParticipant) => void): void;
  onParticipantLeft(cb: (peerId: string) => void): void;
  setSimulcastLayers(track: MediaStreamTrack, layers: SimulcastLayer[]): void;
  leaveRoom(): Promise<void>;
}
```
A single self-hosted SFU (e.g., mediasoup or ion-sfu deployed alongside the IPFS/TURN relay infrastructure) is the likely eventual backend; for 1:1 and small (≤4-person) calls, a full mesh of individual WebRTC connections (no SFU) remains sufficient and is what Phase 4 actually ships.

---

## 6. IPFS Integration Points

- **Media sharing**: sender `helia.fs.addFile()`s the plaintext-then-encrypted blob (see §8 for the encrypt-before-add requirement), sends the resulting CID over the already-E2E chat channel. Receiver fetches via `ipfs-bridge.js`'s Kubo-compatible API, falling back to direct Bitswap from the sender if the receiver's own IPFS node hasn't discovered a public path to it yet — mirroring the existing `getContent()` fallback behavior in `ipfs-node.js` (Helia path → local Kubo gateway fallback).
- **Store-and-forward** (§3.2): 1-hour TTL pins, held by whichever mesh relay(s) chose to accept the forward request — no single point of failure, since multiple relays in range of the sender may all pin it independently.
- **Soul Profile**: avatar image + display name + capability manifest (the full model list that didn't fit in the BLE advertisement, §2.1) stored as a small JSON+asset bundle on IPFS, pinned via `ipfs-bridge.js` to the local Kubo daemon, with the CID itself announced over the existing `SOUL_TOPIC` gossipsub topic (`bucks-souls-<CLUSTER_CIDN>` in `ipfs-node.js`) — BLE mesh peers who resolve a `soul_addr8` to a known Soul can fetch this profile the same way internet-connected peers already do.
- **Call recordings** (opt-in, user-controlled): if a user enables recording, the encrypted recording is added to IPFS and referenced by CID in the conversation log — never auto-recorded, and never stored in plaintext.
- **Group channel history**: IPFS-backed DAG — each message is a DAG node linking to its predecessor (`{ prev_cid, ciphertext, sender_sig }`), giving an append-only, tamper-evident log that any group member can replay from the head CID, consistent with the "group channel history" design already implied by the store-and-forward TTL model.

---

## 7. Agentic Inference over the Mesh

This is the most speculative section — it extends the mesh beyond messaging into distributed compute, letting a Soul Engine on a phone with no local model access borrow inference from a nearby, more capable peer.

- **Capability advertisement**: `cap_flags` bit2 (`has-model`) plus a GATT-readable follow-up listing specific models (e.g., `["qwen2.5-7b", "phi-3-mini"]`) and bit4 (`can-infer`) signaling willingness to actually serve requests (a device might *have* a model loaded but be low on battery and opt out of serving).
- **Routing waterfall** (mirrors §4.2's transport waterfall, applied to inference instead of media):
  1. Local model on-device (existing `edge_llm.py` / `model_engine.py` tiered dispatch).
  2. A BLE mesh peer currently advertising `can-infer`.
  3. A libp2p swarm peer (internet-reachable) advertising the same.
  4. Cloud tier (existing fallback path in `model_factory.py`, if configured).
- **Request protocol**: a new libp2p stream protocol `/bucks/inference/v1`, signed JSON:

```json
{
  "request_id": "uuid",
  "model_hint": "qwen2.5-7b",
  "prompt_ciphertext": "<ECIES-encrypted to serving peer's Soul pubkey>",
  "max_tokens": 512,
  "sig": "<secp256k1 sig by requester>"
}
```
- **Response streaming**: chunked over the same libp2p stream (one `Connection`, ongoing `write()` calls per token or small token batch), reassembled client-side into the running completion — no separate polling needed, since the stream is already bidirectional and long-lived for the duration of the request.
- **Reward**: serving a completed request emits a BUCKS micropayment on Chain 8192 — an ERC-20 `transfer` call whose calldata includes the `request_id`'s hash as a memo-equivalent, letting either side audit which payment corresponds to which job after the fact. The requester's client submits the transaction after receiving the final response chunk; disputes (payment sent, no response received, or vice versa) are out of scope for v1 and handled by reputation/trust-level weighting rather than an escrow contract initially — building a trustless escrow is a meaningfully larger scope than the mesh transport work this document covers, and should be its own design pass if pursued.
- **Privacy**: the prompt itself is ECIES-encrypted (secp256k1) directly to the serving peer's Soul public key before being placed in the request — relays forwarding the stream (in the BLE-relay or circuit-relay case) never see plaintext prompt content, only routing metadata (`request_id`, `model_hint`).
- **Agentic relay**: a Soul Engine that receives a complex tool-use task it can't handle locally (too large a model needed, or a tool requiring compute it lacks) can itself become a *requester* against a nearby larger Soul Engine, chaining the same protocol — this is a natural consequence of the routing waterfall being invocable recursively, not a separate mechanism.

---

## 8. E2E Encryption Architecture

| Channel | Scheme | Notes |
|---|---|---|
| 1:1 messaging | X3DH + Double Ratchet | Already implemented (`signal-store.js`); reused unmodified over BLE (§3.1) |
| Group messaging | Sender Keys (Signal-style) | Each member maintains their own sender key chain; a new member is bootstrapped by an existing admin sending them the key history over an already-established 1:1 X3DH channel — never broadcast in the clear to the group |
| Voice/video signaling & media | DTLS-SRTP (WebRTC-native) + Soul-keypair HMAC over the SDP fingerprint | Protects against a compromised TURN/signaling relay substituting its own DTLS identity |
| BLE audio | AES-256-GCM | Key = `HKDF(ratchet_chain_key, "BucksCallAudio", 32)`, fresh per call |
| IPFS content | AES-256-GCM before `addFile()` | Key shared via the 1:1 E2E channel alongside the CID; the CID itself is a content hash of ciphertext and reveals nothing about plaintext |
| Inference requests | ECIES (secp256k1) | Encrypt directly to serving peer's Soul public key; relays see only routing metadata |

**Key rotation**: Double Ratchet already provides per-message forward secrecy for 1:1 sessions — no new rotation mechanism needed there. Soul keypair rotation (the identity key itself, as opposed to ratchet session keys) happens via on-chain announcement on Chain 8192, consistent with how Soul identity is already anchored; BLE mesh code simply needs to re-resolve `soul_addr8` → current pubkey against the latest on-chain state when connectivity allows, and treat a stale cached identity key as advisory-only ("mesh peer claims to be Soul X, unverified since last online") rather than authoritative, until it can confirm.

---

## 9. Implementation Phases

**Phase 1 — BLE foundation**
- `BLEMeshTransport` (libp2p transport plugin) for Electron (noble, central-only) and both mobile platforms (full dual-role).
- Peer discovery + identity/capability advertisement (§2).
- Text mesh relay: flooding, TTL, dedup, packet format (§1.3).
- Deliverable: two phones with Bluetooth on and no internet can discover each other and exchange plaintext-routed (not yet E2E) mesh packets.

**Phase 2 — E2E extension**
- Wire X3DH/Double Ratchet session establishment and message encryption over the BLE transport (§3.1).
- Store-and-forward via IPFS pinning (§3.2).
- Deliverable: full E2E chat over BLE mesh, including offline store-and-forward through relay peers.

**Phase 3 — Voice**
- Call signaling over existing E2E channel + BLE `CALL_SIGNAL` packets.
- Opus low-rate BLE audio path, call state machine (§4).
- Deliverable: two mesh-only peers (no internet) can voice call each other.

**Phase 4 — Video**
- WebRTC video over internet/LAN, adaptive bitrate, circuit relay v2 fallback, screen share (§5).
- Deliverable: video calling parity with the transport waterfall; BLE-only calls correctly fall back to audio-only with a clear status indicator.

**Phase 5 — Inference mesh**
- Capability-routed inference requests over `/bucks/inference/v1`, BUCKS micropayment settlement (§7).
- Deliverable: a Soul Engine with no local model can route a request to a nearby capable peer and receive a paid, streamed completion.

Each phase is independently shippable and testable — Phase 1 alone already delivers standalone value (mesh presence/discovery), and later phases build strictly on top without requiring earlier phases to be revisited, aside from the transport abstraction itself needing to be solid before anything above it is trustworthy.

---

## 10. Platform Coverage

| Platform | BLE stack | WebRTC stack | Role in mesh |
|---|---|---|---|
| Electron desktop (`bucks browser/electron`) | `@abandonware/noble` (central-only) | Electron's built-in Chromium WebRTC (no extra package needed — `electron-webrtc` is a legacy shim for older Electron versions that lacked native support and is unnecessary here) | Central/relay/bridge node — connects to mobile peripherals, bridges mesh traffic onto the internet-connected libp2p swarm; does not advertise as a BLE peripheral in v1 |
| iOS (`bucks-mobile/BucksMobile`) | `CoreBluetooth` (`CBPeripheralManager` + `CBCentralManager`) | `GoogleWebRTC` via Swift Package Manager | Full dual-role mesh peer |
| Android (`bucks-mobile/app`) | `BluetoothLeAdvertiser` + `BluetoothLeScanner` + `BluetoothGattServer`/`BluetoothGatt` | `io.github.webrtc-sdk:android` (libwebrtc AAR) | Full dual-role mesh peer |

**Shared layer across all three**: the libp2p signaling/identity/encryption stack is transport-agnostic by construction — `signal-store.js`'s X3DH/ratchet logic, the gossipsub topic conventions, and the packet-format definitions in this document are a single conceptual specification that each platform implements against its own BLE and WebRTC primitives, not three separate protocol stacks that happen to be compatible. Keeping the packet format (§1.3) and capability-flag bit layout (§2.1) in one canonical location (proposed: a shared `mesh-protocol-spec.json` or equivalent checked into all three trees, or generated from one source) is worth doing early, before the three platform implementations drift.
