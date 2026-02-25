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

let heliaNode = null;
let fsModule = null;
let gossip = null;

let feed = [];
let following = new Set();
let pinnedFiles = new Map();
let IPFS_DATA_DIR = null;

// Swarm State
let clusterPeers = new Map(); // PeerID -> { version, cidn, reputation, lastSeen }
let localReputation = 100; // Base pheromone level

/**
 * Initialize the Helia IPFS node with filesystem-backed storage.
 * Uses dynamic import() since Helia is ESM-only.
 */
async function startNode() {
  if (heliaNode) return heliaNode;

  // Initialize data dir now that app is ready
  IPFS_DATA_DIR = path.join(app.getPath("userData"), "ipfs-data");

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

    const libp2pNode = await createLibp2p({
      addresses: {
        listen: ["/ip4/0.0.0.0/tcp/0", "/ip4/0.0.0.0/tcp/0/ws"],
      },
      transports: [tcp(), webSockets()],
      connectionEncryption: [noise()],
      streamMuxers: [yamux(), mplex()],
      services: {
        identify: identify(),
        pubsub: gossipsub({ allowPublishToZeroPeers: true }),
      },
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
      }
    });
    gossip.subscribe(CLUSTER_TOPIC);
    gossip.subscribe(FEED_TOPIC);

    // --- Swarm Survival: Foraging ---
    setInterval(forageForScarcity, 60000); // Forage every minute

    // Start periodic identity advertisement (Heartbeat)
    setInterval(advertiseIdentity, 10000);

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

    // Ignore self-messages
    if (data.peerId === heliaNode.libp2p.peerId.toString()) return;

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
    if (data.type === "post") {
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
 * Retrieve content from IPFS by CID.
 * @param {string} cidStr - The CID string
 * @returns {Uint8Array} - The file content
 */
async function getContent(cidStr) {
  if (!heliaNode || !fsModule) throw new Error("IPFS node not initialized");

  const { CID } = await import("multiformats/cid");
  const cid = CID.parse(cidStr);
  const chunks = [];

  for await (const chunk of fsModule.cat(cid)) {
    chunks.push(chunk);
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
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
};
