/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║   BUCKS BROWSER — Chat Engine                            ║
 * ║   E2E Encrypted P2P Messaging over IPFS Gossipsub        ║
 * ╚═══════════════════════════════════════════════════════════╝
 *
 * Responsibilities:
 * - Subscribe to chat gossipsub topic
 * - Encrypt/decrypt messages via signal-store
 * - Persist chat history locally
 * - Publish and process pre-key bundles for X3DH
 * - Notify renderer of incoming messages
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const signalStore = require("./signal-store");

// ─── Constants ───
const CLUSTER_SECRET =
  process.env.BUCKS_CLUSTER_SECRET || "BUCKS_DEFAULT_CLUSTER";
const CHAT_TOPIC = `bucks-chat-${crypto.createHash("sha256").update(CLUSTER_SECRET).digest("hex").slice(0, 16)}`;
const BUNDLE_TOPIC = `bucks-keys-${crypto.createHash("sha256").update(CLUSTER_SECRET).digest("hex").slice(0, 16)}`;

let gossip = null;
let heliaNode = null;
let fsModule = null;
let localPeerId = null;
let CHAT_DATA_DIR = null;
let onMessageCallback = null;

// In-memory state
let peerBundles = new Map(); // peerId -> preKeyBundle
let conversations = new Map(); // peerId -> { messages: [], unreadCount: number, lastMessage: string, lastTimestamp: string }

/**
 * Initialize the chat engine.
 * @param {object} helia - Helia node instance
 * @param {object} gossipSub - Gossipsub instance
 * @param {object} unixfs - Helia UnixFS module
 */
async function initChat(helia, gossipSub, unixfs) {
  heliaNode = helia;
  gossip = gossipSub;
  fsModule = unixfs;
  localPeerId = helia.libp2p.peerId.toString();

  CHAT_DATA_DIR = path.join(
    app.getPath("userData"),
    "ipfs-data",
    "chat-history",
  );
  fs.mkdirSync(CHAT_DATA_DIR, { recursive: true });

  // Initialize Signal store
  signalStore.initStore();

  // Load persisted conversations
  loadConversations();

  // Subscribe to chat and key exchange topics
  gossip.addEventListener("message", (evt) => {
    const topic = evt.detail.topic;
    if (topic === CHAT_TOPIC) {
      handleChatMessage(evt.detail);
    } else if (topic === BUNDLE_TOPIC) {
      handleBundleMessage(evt.detail);
    }
  });

  gossip.subscribe(CHAT_TOPIC);
  gossip.subscribe(BUNDLE_TOPIC);

  // Broadcast our pre-key bundle periodically
  publishPreKeyBundle();
  setInterval(publishPreKeyBundle, 30000); // Every 30s

  console.log(`[Chat] Engine initialized. Topic: ${CHAT_TOPIC}`);
  console.log(`[Chat] Key exchange topic: ${BUNDLE_TOPIC}`);
}

// ─── Pre-Key Bundle Exchange ───

/**
 * Broadcast this node's pre-key bundle to the cluster.
 */
async function publishPreKeyBundle() {
  if (!gossip) return;

  const bundle = signalStore.getPreKeyBundle();
  const message = {
    type: "prekey_bundle",
    peerId: localPeerId,
    bundle: bundle,
    timestamp: Date.now(),
  };

  const data = new TextEncoder().encode(JSON.stringify(message));
  try {
    await gossip.publish(BUNDLE_TOPIC, data);
  } catch (e) {
    // Silently ignore publish errors (common when no peers)
  }
}

/**
 * Handle incoming pre-key bundle messages.
 */
function handleBundleMessage(msg) {
  try {
    const data = JSON.parse(new TextDecoder().decode(msg.data));
    if (data.type !== "prekey_bundle") return;
    if (data.peerId === localPeerId) return; // Ignore our own

    peerBundles.set(data.peerId, data.bundle);

    // Persist bundles
    const bundlesFile = path.join(CHAT_DATA_DIR, "peer-bundles.json");
    const bundlesObj = {};
    peerBundles.forEach((b, id) => {
      bundlesObj[id] = b;
    });
    try {
      fs.writeFileSync(
        bundlesFile,
        JSON.stringify(bundlesObj, null, 2),
        "utf8",
      );
    } catch (e) {
      /* ignore */
    }
  } catch (e) {
    // Ignore malformed bundles
  }
}

// ─── Message Sending ───

/**
 * Send an encrypted message to a peer.
 * @param {string} peerId - Recipient's peer ID
 * @param {string} text - Plaintext message
 * @param {string|null} attachmentCid - Optional IPFS CID for attached file
 * @returns {{ success: boolean, error?: string }}
 */
async function sendMessage(peerId, text, attachmentCid = null) {
  if (!gossip) return { success: false, error: "Chat engine not initialized" };

  // Establish session if needed
  if (!signalStore.hasSession(peerId)) {
    const bundle = peerBundles.get(peerId);
    if (!bundle) {
      return {
        success: false,
        error: "No key bundle available for this peer. They may be offline.",
      };
    }

    // Perform X3DH
    const { sharedSecret, ephemeralPublicKey } =
      signalStore.performX3DH(bundle);
    signalStore.createSession(peerId, sharedSecret, true);

    // Send X3DH init message so peer can derive the same shared secret
    const initMessage = {
      type: "x3dh_init",
      from: localPeerId,
      to: peerId,
      identityKey: signalStore.getIdentityPublicKey(),
      ephemeralKey: ephemeralPublicKey,
      oneTimePreKeyId: bundle.oneTimePreKeyId,
      timestamp: Date.now(),
    };

    const initData = new TextEncoder().encode(JSON.stringify(initMessage));
    try {
      await gossip.publish(CHAT_TOPIC, initData);
    } catch (e) {
      console.error("[Chat] Failed to send X3DH init:", e);
    }
  }

  // Encrypt the message
  const payload = JSON.stringify({
    text: text || "",
    attachmentCid: attachmentCid || null,
  });

  const encResult = signalStore.encryptMessage(peerId, payload);
  if (!encResult) {
    return { success: false, error: "Encryption failed — no session" };
  }

  // Build envelope
  const envelope = {
    type: "chat_message",
    from: localPeerId,
    to: peerId,
    encrypted: encResult.encrypted,
    ratchetKey: encResult.ratchetKey,
    counter: encResult.counter,
    timestamp: Date.now(),
    nonce: crypto.randomBytes(8).toString("hex"),
  };

  const envelopeData = new TextEncoder().encode(JSON.stringify(envelope));
  try {
    await gossip.publish(CHAT_TOPIC, envelopeData);
  } catch (e) {
    console.error("[Chat] Failed to publish message:", e);
    return { success: false, error: "Failed to send via gossipsub" };
  }

  // Store in local history
  const localMsg = {
    sender: localPeerId,
    text: text || "",
    timestamp: new Date().toISOString(),
    cid: attachmentCid || undefined,
    encrypted: true,
  };

  addToConversation(peerId, localMsg);
  console.log(`[Chat] Sent encrypted message to ${peerId.substring(0, 8)}...`);

  return { success: true };
}

/**
 * Send a file as an encrypted chat attachment.
 * @param {string} peerId - Recipient peer ID
 * @param {Uint8Array|number[]} fileData - File bytes
 * @param {string} filename - Original filename
 * @returns {{ success: boolean, cid?: string, error?: string }}
 */
async function sendFile(peerId, fileData, filename) {
  if (!fsModule) return { success: false, error: "IPFS not ready" };

  try {
    // Add file to IPFS (encrypted at rest is optional — we encrypt the CID reference in the message)
    const data =
      fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData);
    const cid = await fsModule.addBytes(data);
    const cidStr = cid.toString();

    // Send chat message with the CID
    const result = await sendMessage(peerId, `📎 ${filename}`, cidStr);
    if (result.success) {
      return { success: true, cid: cidStr };
    }
    return result;
  } catch (err) {
    console.error("[Chat] File send failed:", err);
    return { success: false, error: err.message };
  }
}

// ─── Message Receiving ───

/**
 * Handle incoming chat messages from gossipsub.
 */
function handleChatMessage(msg) {
  try {
    const data = JSON.parse(new TextDecoder().decode(msg.data));

    // Handle X3DH initialization
    if (data.type === "x3dh_init") {
      handleX3DHInit(data);
      return;
    }

    // Only process messages addressed to us
    if (data.type !== "chat_message") return;
    if (data.to !== localPeerId) return;
    if (data.from === localPeerId) return; // Ignore own messages

    // Decrypt
    const plaintext = signalStore.decryptMessage(data.from, {
      encrypted: data.encrypted,
      ratchetKey: data.ratchetKey,
      counter: data.counter,
    });

    if (plaintext === null) {
      console.warn(
        `[Chat] Failed to decrypt message from ${data.from.substring(0, 8)}`,
      );
      return;
    }

    // Parse payload
    let payload;
    try {
      payload = JSON.parse(plaintext);
    } catch (e) {
      payload = { text: plaintext, attachmentCid: null };
    }

    const localMsg = {
      sender: data.from,
      text: payload.text || "",
      timestamp: new Date(data.timestamp).toISOString(),
      cid: payload.attachmentCid || undefined,
      encrypted: true,
    };

    addToConversation(data.from, localMsg);
    console.log(
      `[Chat] Received encrypted message from ${data.from.substring(0, 8)}...`,
    );

    // Notify renderer
    if (onMessageCallback) {
      onMessageCallback({
        peerId: data.from,
        message: localMsg,
      });
    }
  } catch (e) {
    console.error("[Chat] Failed to handle message:", e);
  }
}

/**
 * Handle X3DH init messages — establish session as responder.
 */
function handleX3DHInit(data) {
  if (data.to !== localPeerId) return;
  if (data.from === localPeerId) return;

  // Don't re-establish if we already have a session
  if (signalStore.hasSession(data.from)) return;

  try {
    const sharedSecret = signalStore.respondX3DH(
      data.identityKey,
      data.ephemeralKey,
      data.oneTimePreKeyId || null,
    );
    signalStore.createSession(data.from, sharedSecret, false);
    console.log(
      `[Chat] X3DH session established with ${data.from.substring(0, 8)}... (responder)`,
    );
  } catch (e) {
    console.error(
      `[Chat] X3DH init failed from ${data.from.substring(0, 8)}:`,
      e.message,
    );
  }
}

// ─── Conversation Management ───

function addToConversation(peerId, message) {
  let conv = conversations.get(peerId);
  if (!conv) {
    conv = { messages: [], unreadCount: 0, lastMessage: "", lastTimestamp: "" };
    conversations.set(peerId, conv);
  }

  conv.messages.push(message);
  conv.lastMessage = message.text || "📎 Attachment";
  conv.lastTimestamp = message.timestamp;

  // Increment unread if not from us
  if (message.sender !== localPeerId) {
    conv.unreadCount++;
  }

  // Keep only last 500 messages per conversation
  if (conv.messages.length > 500) {
    conv.messages = conv.messages.slice(-500);
  }

  saveConversation(peerId);
}

/**
 * Get chat history for a peer.
 * @param {string} peerId
 * @returns {{ history: object[], sessionInfo: object|null }}
 */
function getChatHistory(peerId) {
  const conv = conversations.get(peerId);
  return {
    history: conv ? conv.messages : [],
    sessionInfo: signalStore.getSessionInfo(peerId),
    hasSession: signalStore.hasSession(peerId),
  };
}

/**
 * Get all conversations (for the messages list page).
 * @returns {{ conversations: object[] }}
 */
function getConversations() {
  const result = [];
  conversations.forEach((conv, peerId) => {
    result.push({
      peer_id: peerId,
      last_message: conv.lastMessage,
      timestamp: conv.lastTimestamp,
      unread_count: conv.unreadCount,
      encrypted: true,
      hasSession: signalStore.hasSession(peerId),
    });
  });

  // Sort by most recent
  result.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  return { conversations: result };
}

/**
 * Mark a conversation as read.
 */
function markAsRead(peerId) {
  const conv = conversations.get(peerId);
  if (conv) {
    conv.unreadCount = 0;
    saveConversation(peerId);
  }
  return { success: true };
}

// ─── Persistence ───

function saveConversation(peerId) {
  if (!CHAT_DATA_DIR) return;
  const sanitized = peerId.replace(/[^a-zA-Z0-9]/g, "_");
  const filePath = path.join(CHAT_DATA_DIR, `${sanitized}.json`);
  const conv = conversations.get(peerId);
  if (!conv) return;

  try {
    fs.writeFileSync(filePath, JSON.stringify(conv, null, 2), "utf8");
  } catch (e) {
    console.error(
      `[Chat] Failed to save conversation ${peerId.substring(0, 8)}:`,
      e,
    );
  }
}

function loadConversations() {
  if (!CHAT_DATA_DIR) return;

  // Load peer bundles
  const bundlesFile = path.join(CHAT_DATA_DIR, "peer-bundles.json");
  if (fs.existsSync(bundlesFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(bundlesFile, "utf8"));
      for (const [id, bundle] of Object.entries(data)) {
        peerBundles.set(id, bundle);
      }
      console.log(`[Chat] Loaded ${peerBundles.size} peer key bundles.`);
    } catch (e) {
      /* ignore */
    }
  }

  // Load conversation files
  try {
    const files = fs
      .readdirSync(CHAT_DATA_DIR)
      .filter((f) => f.endsWith(".json") && f !== "peer-bundles.json");
    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(CHAT_DATA_DIR, file), "utf8"),
        );
        // Reconstruct peerId from filename
        const peerId = file.replace(".json", "").replace(/_/g, "");
        // But filenames are sanitized, so we need to use the sender from messages
        if (data.messages && data.messages.length > 0) {
          const otherPeer = data.messages.find((m) => m.sender !== localPeerId);
          const pid = otherPeer ? otherPeer.sender : peerId;
          conversations.set(pid, data);
        }
      } catch (e) {
        /* skip invalid files */
      }
    }
    console.log(`[Chat] Loaded ${conversations.size} conversations.`);
  } catch (e) {
    /* ignore */
  }
}

/**
 * Set the callback for incoming messages (used by main.js to forward to renderer).
 */
function setOnMessageCallback(callback) {
  onMessageCallback = callback;
}

/**
 * Get own pre-key bundle (for QR code sharing or manual exchange).
 */
function getOwnBundle() {
  return {
    peerId: localPeerId,
    bundle: signalStore.getPreKeyBundle(),
  };
}

/**
 * Manually process a peer's pre-key bundle (e.g., from QR scan).
 */
function processPeerBundle(peerId, bundle) {
  peerBundles.set(peerId, bundle);

  // Persist
  const bundlesFile = path.join(CHAT_DATA_DIR, "peer-bundles.json");
  const bundlesObj = {};
  peerBundles.forEach((b, id) => {
    bundlesObj[id] = b;
  });
  try {
    fs.writeFileSync(bundlesFile, JSON.stringify(bundlesObj, null, 2), "utf8");
  } catch (e) {
    /* ignore */
  }

  return { success: true };
}

/**
 * Check if we have a key bundle for a peer.
 */
function hasPeerBundle(peerId) {
  return peerBundles.has(peerId);
}

module.exports = {
  initChat,
  sendMessage,
  sendFile,
  getChatHistory,
  getConversations,
  markAsRead,
  setOnMessageCallback,
  getOwnBundle,
  processPeerBundle,
  hasPeerBundle,
  CHAT_TOPIC,
  BUNDLE_TOPIC,
};
