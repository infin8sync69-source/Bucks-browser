const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

// --- Swarm Intelligence Constants ---
const CLUSTER_SECRET =
  process.env.BUCKS_CLUSTER_SECRET || "BUCKS_DEFAULT_CLUSTER";
const CLUSTER_CIDN = process.env.BUCKS_CLUSTER_CIDN || "mainnet";
const BROWSER_VERSION = "1.2.0"; // Modern versioning for sync
const CLUSTER_TOPIC = `bucks-swarm-${crypto.createHash("sha256").update(CLUSTER_SECRET).digest("hex").slice(0, 16)}`;

const FEED_TOPIC = `bucks-feed-${crypto.createHash("sha256").update(CLUSTER_SECRET).digest("hex").slice(0, 16)}`;
const COMPUTE_TOPIC = `bucks-compute-${crypto.createHash("sha256").update(CLUSTER_SECRET).digest("hex").slice(0, 16)}`;

// --- Agent Soul Topics ---
const SOUL_TOPIC = `bucks-souls-${CLUSTER_CIDN}`;
const AGENT_INBOX_PREFIX = `bucks-agent-inbox-`;
const DWEB_TOPIC = `bucks-dweb-${crypto.createHash("sha256").update(CLUSTER_SECRET).digest("hex").slice(0, 16)}`;

let heliaNode = null;
let fsModule = null;
let gossip = null;

let feed = [];
let following = new Set();
let pinnedFiles = new Map();
let IPFS_DATA_DIR = null;
let forageInterval = null;
let advertiseInterval = null;

let dwebIndex = [];
let dwebIndexFile = null;

// Swarm State
let clusterPeers = new Map(); // PeerID -> { version, cidn, reputation, lastSeen }
let localReputation = 100; // Base pheromone level

// Soul State
let localSoul = null;
let peerSoulCallbacks = []; // registered listeners for incoming peer souls

/**
 * Initialize the Helia IPFS node with filesystem-backed storage.
 * Uses dynamic import() since Helia is ESM-only.
 */
async function startNode() {
  if (heliaNode) return heliaNode;

  // Initialize data dir now that app is ready
  IPFS_DATA_DIR = path.join(app.getPath("userData"), "ipfs-data");
  dwebIndexFile = path.join(IPFS_DATA_DIR, "dweb-index.json");

  try {
    // Dynamic imports for ESM modules
    const { createHelia } = await import("helia");
    const { unixfs } = await import("@helia/unixfs");
    const { FsBlockstore } = await import("blockstore-fs");
    const { FsDatastore } = await import("datastore-fs");
    const { gossipsub } = await import("@chainsafe/libp2p-gossipsub");
    const fs = require("fs");

    // Ensure IPFS data directory exists
    if (!fs.existsSync(IPFS_DATA_DIR)) {
      fs.mkdirSync(IPFS_DATA_DIR, { recursive: true });
    }
    
    // Load discovered dweb index
    if (fs.existsSync(dwebIndexFile)) {
      try {
        dwebIndex = JSON.parse(fs.readFileSync(dwebIndexFile, "utf8"));
        console.log(`[IPFS] Loaded ${dwebIndex.length} discovered dWeb pages.`);
      } catch (e) {
        console.error("[IPFS] Failed to load dweb index:", e);
        dwebIndex = [];
      }
    }
    if (!fs.existsSync(path.join(IPFS_DATA_DIR, "blocks"))) {
      fs.mkdirSync(path.join(IPFS_DATA_DIR, "blocks"), { recursive: true });
    }
    if (!fs.existsSync(path.join(IPFS_DATA_DIR, "datastore"))) {
      fs.mkdirSync(path.join(IPFS_DATA_DIR, "datastore"), { recursive: true });
    }

    const blockstore = new FsBlockstore(path.join(IPFS_DATA_DIR, "blocks"));
    const datastore = new FsDatastore(path.join(IPFS_DATA_DIR, "datastore"));

    const { identify } = await import("@libp2p/identify");
    const { tcp } = await import("@libp2p/tcp");
    const { webSockets } = await import("@libp2p/websockets");
    const { createLibp2p } = await import("libp2p");
    const { noise } = await import("@chainsafe/libp2p-noise");
    const { yamux } = await import("@chainsafe/libp2p-yamux");
    const { mplex } = await import("@libp2p/mplex");
    const { mdns } = await import("@libp2p/mdns");
    const { bootstrap } = await import("@libp2p/bootstrap");

    // Peer discovery: mDNS finds Bucks nodes on the same LAN automatically;
    // BUCKS_BOOTSTRAP_PEERS (comma-separated multiaddrs, e.g. over Tailscale)
    // connects machines across networks.
    const peerDiscovery = [mdns({ interval: 10000 })];
    const bootstrapList = (process.env.BUCKS_BOOTSTRAP_PEERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (bootstrapList.length > 0) {
      peerDiscovery.push(bootstrap({ list: bootstrapList }));
      console.log(`[Swarm] Bootstrap peers configured: ${bootstrapList.length}`);
    }

    // Stable ports so other machines can bootstrap-dial this node; fall back
    // to OS-assigned ports if another instance already holds them.
    async function createNode(listen) {
      return createLibp2p({
        addresses: { listen },
        transports: [tcp(), webSockets()],
        connectionEncryption: [noise()],
        streamMuxers: [yamux(), mplex()],
        peerDiscovery,
        services: {
          identify: identify(),
          pubsub: gossipsub({ allowPublishToZeroPeers: true }),
        },
      });
    }

    let libp2pNode;
    try {
      libp2pNode = await createNode(["/ip4/0.0.0.0/tcp/4020", "/ip4/0.0.0.0/tcp/4021/ws"]);
    } catch (portErr) {
      console.warn(`[Swarm] Ports 4020/4021 unavailable (${portErr.message}) — using random ports.`);
      libp2pNode = await createNode(["/ip4/0.0.0.0/tcp/0", "/ip4/0.0.0.0/tcp/0/ws"]);
    }

    libp2pNode.addEventListener("peer:discovery", (evt) => {
      const peer = evt.detail;
      console.log(`[Swarm] Discovered peer: ${peer.id.toString()}`);
      libp2pNode.dial(peer.id).catch(() => {});
    });
    libp2pNode.addEventListener("peer:connect", (evt) => {
      console.log(`[Swarm] Connected to peer: ${evt.detail.toString()}`);
    });

    heliaNode = await createHelia({
      blockstore,
      datastore,
      libp2p: libp2pNode,
    });

    fsModule = unixfs(heliaNode);
    gossip = heliaNode.libp2p.services.pubsub;

    // --- Swarm Identity & Handshake ---
    gossip.addEventListener("message", (evt) => {
      const topic = evt.detail.topic;
      if (topic === CLUSTER_TOPIC) {
        handleClusterMessage(evt.detail);
      } else if (topic === FEED_TOPIC) {
        handleFeedMessage(evt.detail);
      } else if (topic === SOUL_TOPIC) {
        handleSoulMessage(evt.detail);
      } else if (topic === DWEB_TOPIC) {
        handleDwebMessage(evt.detail);
      }
    });
    gossip.subscribe(CLUSTER_TOPIC);
    gossip.subscribe(FEED_TOPIC);
    gossip.subscribe(SOUL_TOPIC);
    gossip.subscribe(DWEB_TOPIC);

    // --- Swarm Survival: Foraging ---
    forageInterval = setInterval(forageForScarcity, 60000); // Forage every minute

    // Start periodic identity advertisement (Heartbeat)
    advertiseInterval = setInterval(advertiseIdentity, 10000);

    console.log(
      `[Swarm] Cluster Node Active. PeerID: ${heliaNode.libp2p.peerId.toString()}`,
    );
    console.log(`[Swarm] Topic: ${CLUSTER_TOPIC}`);

    // Load persisted following list
    const followFile = path.join(IPFS_DATA_DIR, "following.json");
    if (fs.existsSync(followFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(followFile, "utf8"));
        data.forEach((id) => following.add(id));
        console.log(`[IPFS] Restored ${following.size} followed peers.`);
      } catch (e) {
        console.error("[IPFS] Failed to load following list:", e);
      }
    }

    // Load persisted feed
    const feedFile = path.join(IPFS_DATA_DIR, "feed.json");
    if (fs.existsSync(feedFile)) {
      try {
        feed = JSON.parse(fs.readFileSync(feedFile, "utf8"));
        console.log(`[IPFS] Restored ${feed.length} feed items.`);
      } catch (e) {
        console.error("[IPFS] Failed to load feed:", e);
      }
    }

    // Load pinned metadata
    const pinnedFile = path.join(IPFS_DATA_DIR, "pinned.json");
    if (fs.existsSync(pinnedFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(pinnedFile, "utf8"));
        pinnedFiles = new Map(Object.entries(data));
        console.log(`[IPFS] Restored ${pinnedFiles.size} pinned files.`);
      } catch (e) {
        console.error("[IPFS] Failed to load pinned metadata:", e);
      }
    }

    return heliaNode;
  } catch (err) {
    console.error("[IPFS] Failed to start Helia node:", err);
    throw err;
  }
}

/**
 * Broadcast local identity information to the swarm.
 */
async function advertiseIdentity() {
  if (!gossip) return;

  const identity = {
    type: "identity",
    peerId: heliaNode.libp2p.peerId.toString(),
    version: BROWSER_VERSION,
    cidn: CLUSTER_CIDN,
    reputation: localReputation,
    timestamp: Date.now(),
  };

  const data = new TextEncoder().encode(JSON.stringify(identity));
  try {
    await gossip.publish(CLUSTER_TOPIC, data);
  } catch (e) {
    console.error("[Swarm] Failed to broadcast identity:", e);
  }
}

/**
 * Handle incoming swarm messages.
 * Validates peers and updates cluster state.
 */
function handleClusterMessage(msg) {
  try {
    const data = JSON.parse(new TextDecoder().decode(msg.data));
    const fromPeerId = msg.from.toString();

    // Ignore self-messages
    if (fromPeerId === heliaNode.libp2p.peerId.toString()) return;

    // Enforce transport-layer sender validation
    if (data.peerId !== fromPeerId) {
      console.warn(`[Swarm] Dropped spoofed identity message: payload peerId ${data.peerId} does not match publisher ${fromPeerId}`);
      return;
    }

    if (data.type === "identity") {
      const peerId = data.peerId;

      // Validate Cluster ID (CIDN)
      if (data.cidn !== CLUSTER_CIDN) {
        console.warn(
          `[Swarm] Rejected peer ${peerId}: CIDN mismatch (${data.cidn})`,
        );
        return;
      }

      // Update Cluster Peer Map
      clusterPeers.set(peerId, {
        version: data.version,
        reputation: data.reputation,
        lastSeen: Date.now(),
      });

      // Version Check (Swarm Survival)
      if (isNewerVersion(data.version, BROWSER_VERSION)) {
        console.log(
          `[Swarm] Peer ${peerId} has newer version: ${data.version}. Sync required.`,
        );
        // IPC back to main will handle the UI prompt/auto-update
      }
    }
  } catch (e) {
    console.error("[Swarm] Failed to parse message:", e);
  }
}

/**
 * Handle incoming feed updates from the swarm mesh.
 */
function handleFeedMessage(msg) {
  try {
    const data = JSON.parse(new TextDecoder().decode(msg.data));
    const fromPeerId = msg.from.toString();
    if (data.type === "post") {
      // Enforce transport-layer sender validation
      if (data.post && data.post.peerId !== fromPeerId) {
        console.warn(`[Swarm] Dropped spoofed feed post: payload peerId ${data.post.peerId} does not match publisher ${fromPeerId}`);
        return;
      }
      // Check if already in feed
      if (!feed.some((p) => p.cid === data.post.cid)) {
        feed.unshift(data.post);
        console.log(
          `[Swarm] Received gossiped post: ${data.post.cid.slice(0, 8)}`,
        );
      }

      // Record activity for reputation (ACO)
      recordPeerActivity(data.post.peerId, true);
    }
  } catch (e) {
    console.error("[Swarm] Failed to handle feed message:", e);
  }
}

/**
 * Digital Pheromones (ACO): Record successful data delivery from a peer.
 */
function recordPeerActivity(peerId, success = true) {
  const peer = clusterPeers.get(peerId);
  if (!peer) return;

  if (success) {
    peer.reputation = Math.min(200, peer.reputation + 5); // Accumulate pheromones
  } else {
    peer.reputation = Math.max(0, peer.reputation - 10); // Evaporate pheromones
  }
}

function isNewerVersion(v1, v2) {
  const p1 = v1.split(".").map(Number);
  const p2 = v2.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (p1[i] > p2[i]) return true;
    if (p1[i] < p2[i]) return false;
  }
  return false;
}

/**
 * Foraging Algorithm: Seek out under-represented data (Scarcity).
 * This mimics an immune system protecting rare memories.
 */
async function forageForScarcity() {
  console.log("[Swarm] Foraging for scarce data...");
  // In a real swarm, we'd query the DHT for random CIDs
  // and check their provider counts.
  // If count < 3, we "forage" (pin) the data and earn simulated yield.
}

/**
 * Information Dissemination: Flocking via Gossipsub.
 * Broadcasts a new post to the local swarm mesh.
 */
async function disseminatePost(post) {
  if (!gossip) return;
  const data = new TextEncoder().encode(JSON.stringify({ type: "post", post }));
  try {
    await gossip.publish(FEED_TOPIC, data);
    console.log(`[Swarm] Gossiped post: ${post.cid.slice(0, 8)}`);
  } catch (e) {
    console.error("[Swarm] Gossip failed:", e);
  }
}

/**
 * Gracefully stop the IPFS node.
 */
async function stopNode() {
  if (forageInterval) {
    clearInterval(forageInterval);
    forageInterval = null;
  }
  if (advertiseInterval) {
    clearInterval(advertiseInterval);
    advertiseInterval = null;
  }
  if (heliaNode) {
    // Persist feed and following before shutdown
    const fs = require("fs");
    try {
      fs.writeFileSync(
        path.join(IPFS_DATA_DIR, "following.json"),
        JSON.stringify([...following], null, 2),
        "utf8",
      );
      fs.writeFileSync(
        path.join(IPFS_DATA_DIR, "feed.json"),
        JSON.stringify(feed.slice(-100), null, 2),
        "utf8", // Keep last 100 items
      );
      fs.writeFileSync(
        path.join(IPFS_DATA_DIR, "pinned.json"),
        JSON.stringify(Object.fromEntries(pinnedFiles), null, 2),
        "utf8",
      );
    } catch (e) {
      console.error("[IPFS] Failed to persist state:", e);
    }

    await heliaNode.stop();
    heliaNode = null;
    fsModule = null;
    console.log("[IPFS] Node stopped.");
  }
}

/**
 * Publish content to IPFS and add to the local feed.
 * @param {Buffer|Uint8Array|string} content - File content to publish
 * @param {object} metadata - { name, type, description }
 * @returns {object} - { cid, peerId, timestamp, metadata }
 */
async function publishContent(content, metadata = {}) {
  if (!heliaNode || !fsModule) throw new Error("IPFS node not initialized");

  const data =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const cid = await fsModule.addBytes(data);
  const cidStr = cid.toString();

  const post = {
    cid: cidStr,
    peerId: heliaNode.libp2p.peerId.toString(),
    timestamp: Date.now(),
    metadata: {
      name: metadata.name || "Untitled",
      type: metadata.type || "file",
      description: metadata.description || "",
      size: data.length,
    },
    upvotes: 0,
    pinned: true, // Publisher always pins their own content
  };

  feed.unshift(post);
  console.log(`[IPFS] Published: ${cidStr} (${metadata.name || "Untitled"})`);

  // Disseminate to the Swarm!
  disseminatePost(post);

  return post;
}

/**
 * Retrieve content from IPFS by CID or hierarchical path.
 * Supports UnixFS directory traversal and index.html fallback.
 * @param {string} pathStr - The CID or CID path (e.g. "Qm.../assets/logo.png")
 * @returns {Uint8Array} - The file content
 */
async function getContent(pathStr) {
  // Normalize path
  const normalized = pathStr.replace(/^\//, '');
  const firstSlash = normalized.indexOf('/');
  let baseCidStr = firstSlash === -1 ? normalized : normalized.substring(0, firstSlash);
  const subPathStr = firstSlash === -1 ? '' : normalized.substring(firstSlash + 1);

  // Try Helia resolution first
  if (heliaNode && fsModule) {
    try {
      const { CID } = await import("multiformats/cid");
      let currentCid = CID.parse(baseCidStr);
      
      if (subPathStr) {
        const pathParts = subPathStr.split('/').filter(Boolean);
        for (const part of pathParts) {
          let found = false;
          for await (const entry of fsModule.ls(currentCid)) {
            if (entry.name === part) {
              currentCid = entry.cid;
              found = true;
              break;
            }
          }
          if (!found) {
            throw new Error(`Path component not found: ${part}`);
          }
        }
      }

      // Check if the final resolved CID is a directory
      let isDir = false;
      let indexCid = null;
      try {
        for await (const entry of fsModule.ls(currentCid)) {
          isDir = true;
          if (entry.name === 'index.html') {
            indexCid = entry.cid;
          }
        }
      } catch (e) {
        isDir = false;
      }

      if (isDir) {
        if (indexCid) {
          currentCid = indexCid;
        } else {
          throw new Error("Directory listing without index.html is not supported");
        }
      }

      const chunks = [];
      for await (const chunk of fsModule.cat(currentCid)) {
        chunks.push(chunk);
      }

      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    } catch (heliaErr) {
      console.warn(`[IPFS Node] Helia path resolution failed: ${heliaErr.message}. Falling back to Kubo gateway...`);
    }
  }

  // Fallback to Kubo HTTP gateway if Helia fails or is not initialized
  const http = require('http');
  return new Promise((resolve, reject) => {
    const gatewayUrl = `http://127.0.0.1:8080/ipfs/${normalized}`;
    http.get(gatewayUrl, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Kubo gateway returned HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    }).on('error', (err) => {
      reject(new Error(`Failed to contact Kubo gateway: ${err.message}`));
    });
  });
}

/**
 * Follow a peer — subscribe to their content feed.
 * @param {string} peerId - The PeerID to follow
 */
function followPeer(peerId) {
  if (following.has(peerId)) return { status: "already_following", peerId };
  following.add(peerId);
  console.log(`[IPFS] Now following: ${peerId}`);
  return { status: "followed", peerId };
}

/**
 * Unfollow a peer.
 * @param {string} peerId - The PeerID to unfollow
 */
function unfollowPeer(peerId) {
  following.delete(peerId);
  console.log(`[IPFS] Unfollowed: ${peerId}`);
  return { status: "unfollowed", peerId };
}

/**
 * Upvote (Like) content — pins it locally, making this node a co-host.
 * @param {string} cidStr - The CID to upvote
 */
async function upvoteContent(cidStr) {
  if (!heliaNode || !fsModule) throw new Error("IPFS node not initialized");

  // 1. Find the post in feed or metadata
  const post = feed.find((p) => p.cid === cidStr);

  // 2. Fetch and Pin the content locally
  try {
    const { CID } = await import("multiformats/cid");
    const cid = CID.parse(cidStr);

    // Fetch to ensure local copy
    const chunks = [];
    let totalSize = 0;
    for await (const chunk of fsModule.cat(cid)) {
      chunks.push(chunk);
      totalSize += chunk.length;
    }

    // Update post state
    if (post) {
      post.upvotes = (post.upvotes || 0) + 1;
      post.pinned = true;
    }

    // Add to pinned registry
    pinnedFiles.set(cidStr, {
      size: totalSize,
      timestamp: Date.now(),
      name: post ? post.metadata.name : "Remote File",
      type: post ? post.metadata.type : "unknown",
    });

    console.log(`[IPFS] Upvoted & Pinned: ${cidStr} (${totalSize} bytes)`);
    return { status: "pinned", cid: cidStr, size: totalSize };
  } catch (err) {
    console.error(`[IPFS] Failed to pin ${cidStr}:`, err);
    return { status: "error", error: err.message };
  }
}

/**
 * Unpin content to free up storage.
 * @param {string} cidStr
 */
async function unpinContent(cidStr) {
  if (pinnedFiles.has(cidStr)) {
    pinnedFiles.delete(cidStr);
    const post = feed.find((p) => p.cid === cidStr);
    if (post) post.pinned = false;
    console.log(`[IPFS] Unpinned: ${cidStr}`);
    return { status: "unpinned", cid: cidStr };
  }
  return { status: "not_found", cid: cidStr };
}

/**
 * Get storage statistics.
 */
function getStorageStats() {
  let totalSize = 0;
  pinnedFiles.forEach((meta) => {
    totalSize += meta.size;
  });

  return {
    pinnedCount: pinnedFiles.size,
    totalSizeBytes: totalSize,
    pinnedItems: [...pinnedFiles.entries()].map(([cid, meta]) => ({
      cid,
      ...meta,
    })),
  };
}

/**
 * Get the aggregated feed from all sources.
 * @returns {Array} - Array of post objects sorted by timestamp
 */
function getFeed() {
  return feed.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
}

/**
 * Get IPFS node information.
 */
function getNodeInfo() {
  if (!heliaNode) return { status: "offline" };

  return {
    status: "online",
    peerId: heliaNode.libp2p.peerId.toString(),
    addresses: heliaNode.libp2p.getMultiaddrs().map((a) => a.toString()),
    peers: heliaNode.libp2p.getPeers().length,
    following: [...following],
    feedCount: feed.length,
    storageDir: IPFS_DATA_DIR,
    cluster: {
      secret: CLUSTER_SECRET.slice(0, 3) + "***",
      cidn: CLUSTER_CIDN,
      topic: CLUSTER_TOPIC,
      peers: [...clusterPeers.entries()].map(([id, data]) => ({ id, ...data })),
      reputation: localReputation,
    },
  };
}

/**
 * Get list of connected peers.
 */
function getPeers() {
  if (!heliaNode) return [];
  return heliaNode.libp2p.getPeers().map((p) => p.toString());
}

/**
 * Handle an incoming soul advertisement from a peer agent.
 * Fires all registered peerSoulCallbacks for verification + registry.
 */
function handleSoulMessage(msg) {
  try {
    const soul = JSON.parse(new TextDecoder().decode(msg.data));
    if (!soul || !soul.soulId) return;
    const fromPeerId = msg.from.toString();
    // Bind it directly to the verified publisher PeerID
    soul.nodeId = fromPeerId;

    // Ignore our own broadcasts
    if (localSoul && soul.soulId === localSoul.soulId) return;
    console.log(`[Soul] Peer soul received: ${soul.soulId.slice(0, 16)}... locality=${soul.locality}`);
    peerSoulCallbacks.forEach((cb) => {
      try { cb(soul); } catch (e) { console.error("[Soul] Callback error:", e); }
    });
  } catch (e) {
    console.error("[Soul] Failed to parse soul message:", e);
  }
}

/**
 * Advertise this node's agent soul to the swarm.
 * @param {object} soul - The soul manifest from the agent server.
 */
async function advertiseAgentSoul(soul) {
  if (!gossip) return;
  localSoul = soul;
  const data = new TextEncoder().encode(JSON.stringify(soul));
  try {
    await gossip.publish(SOUL_TOPIC, data);
    console.log(`[Soul] Advertised soul: ${soul.soulId.slice(0, 16)}...`);
  } catch (e) {
    console.error("[Soul] Failed to advertise soul:", e);
  }
}

/**
 * Pin a soul manifest to IPFS and return its CID.
 * @param {object} soul - The soul manifest to pin.
 * @returns {string} CID string, or "" on failure.
 */
async function pinSoul(soul) {
  if (!heliaNode || !fsModule) return "";
  try {
    const data = new TextEncoder().encode(JSON.stringify(soul));
    const cid = await fsModule.addBytes(data);
    const cidStr = cid.toString();
    console.log(`[Soul] Pinned soul to IPFS: ${cidStr}`);
    return cidStr;
  } catch (e) {
    console.error("[Soul] Failed to pin soul:", e);
    return "";
  }
}

/**
 * Register a callback to be fired when a peer soul advertisement arrives.
 * @param {function} callback - Called with the parsed soul object.
 */
function onPeerSoul(callback) {
  peerSoulCallbacks.push(callback);
}

/**
 * Get the local soul (null if not yet set).
 */
function getLocalSoul() {
  return localSoul;
}

/**
 * Getters for internal references (used by chat-engine.js).
 */
function getHeliaNode() {
  return heliaNode;
}
function getGossip() {
  return gossip;
}
function getFsModule() {
  return fsModule;
}

/**
 * Handle incoming dWeb index publication messages from the swarm.
 */
function handleDwebMessage(msg) {
  try {
    const data = JSON.parse(new TextDecoder().decode(msg.data));
    const fromPeerId = msg.from.toString();
    if (data.type === "publish") {
      // Enforce transport-layer sender validation
      if (data.publisher !== fromPeerId) {
        console.warn(`[Swarm] Dropped spoofed dWeb publication: publisher ${data.publisher} does not match transport publisher ${fromPeerId}`);
        return;
      }
      if (!dwebIndex.some((item) => item.cid === data.cid)) {
        dwebIndex.unshift({
          cid: data.cid,
          name: data.name || 'Unnamed',
          title: data.title || 'Untitled',
          desc: data.desc || '',
          timestamp: data.timestamp || Date.now()
        });
        saveDwebIndex();
        console.log(`[Swarm] Discovered new dWeb page: ${data.name} (${data.cid.slice(0, 8)})`);
      }
    }
  } catch (e) {
    console.error("[Swarm] Failed to handle dweb message:", e);
  }
}

/**
 * Save current local dwebIndex array to JSON file.
 */
function saveDwebIndex() {
  if (!dwebIndexFile) return;
  const fs = require("fs");
  try {
    fs.writeFileSync(dwebIndexFile, JSON.stringify(dwebIndex), "utf8");
  } catch (e) {
    console.error("[IPFS] Failed to save dweb index:", e);
  }
}

/**
 * Broadcast a new dWeb page publication to the swarm.
 */
async function publishDweb(name, cid, title, desc) {
  if (!gossip) return;
  const metadata = {
    type: "publish",
    cid,
    name,
    title,
    desc,
    timestamp: Date.now(),
    publisher: heliaNode.libp2p.peerId.toString()
  };

  if (!dwebIndex.some((item) => item.cid === cid)) {
    dwebIndex.unshift(metadata);
    saveDwebIndex();
  }

  try {
    const data = new TextEncoder().encode(JSON.stringify(metadata));
    await gossip.publish(DWEB_TOPIC, data);
    console.log(`[Swarm] Broadcasted dWeb publication: ${name} (${cid.slice(0, 8)})`);
  } catch (e) {
    console.error("[Swarm] Failed to broadcast dWeb publication:", e);
  }
}

/**
 * Get all discovered dWeb pages.
 */
function getDwebIndex() {
  return dwebIndex;
}

/**
 * Search the discovered dWeb pages.
 */
function searchDweb(query) {
  const q = query.toLowerCase().trim();
  if (!q) return dwebIndex;
  return dwebIndex.filter(item => 
    item.name.toLowerCase().includes(q) ||
    item.title.toLowerCase().includes(q) ||
    item.desc.toLowerCase().includes(q) ||
    item.cid.includes(q)
  );
}

/**
 * Manually dial and connect to a peer by their multiaddress.
 */
async function connectPeer(multiaddr) {
  if (!heliaNode) throw new Error("IPFS node not running");
  try {
    const { multiaddr: parseMultiaddr } = await import("@multiformats/multiaddr");
    const ma = parseMultiaddr(multiaddr);
    await heliaNode.libp2p.dial(ma);
    console.log(`[Swarm] Manually connected to peer: ${multiaddr}`);
    return { success: true };
  } catch (err) {
    console.error(`[Swarm] Failed to connect to peer ${multiaddr}:`, err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  startNode,
  stopNode,
  publishContent,
  getContent,
  followPeer,
  unfollowPeer,
  upvoteContent,
  getFeed,
  getNodeInfo,
  getPeers,
  unpinContent,
  getStorageStats,
  getHeliaNode,
  getGossip,
  getFsModule,
  advertiseAgentSoul,
  pinSoul,
  onPeerSoul,
  getLocalSoul,
  publishDweb,
  getDwebIndex,
  searchDweb,
  connectPeer,
};
