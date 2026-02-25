/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║   BUCKS BROWSER — Signal Protocol Key Store              ║
 * ║   Pure JS implementation using Node.js crypto            ║
 * ║   X25519 (ECDH) + AES-256-GCM + HKDF                    ║
 * ╚═══════════════════════════════════════════════════════════╝
 *
 * This module manages:
 * - Identity key pairs (long-term X25519 keys)
 * - Signed pre-keys & one-time pre-keys for X3DH
 * - Per-peer Double Ratchet session state
 * - Persistent storage in the Electron userData directory
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { app } = require("electron");

let STORE_DIR = null;

// ─── Crypto Primitives ───

/**
 * Generate an X25519 key pair for Diffie-Hellman key exchange.
 * Returns { publicKey: Buffer, privateKey: Buffer }
 */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKey: publicKey,
    privateKey: privateKey,
  };
}

/**
 * Perform X25519 Diffie-Hellman shared secret derivation.
 * @param {Buffer} privateKeyDer - Our private key in PKCS8 DER
 * @param {Buffer} publicKeyDer - Peer's public key in SPKI DER
 * @returns {Buffer} 32-byte shared secret
 */
function computeSharedSecret(privateKeyDer, publicKeyDer) {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyDer),
    format: "der",
    type: "pkcs8",
  });
  const pubKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyDer),
    format: "der",
    type: "spki",
  });
  return crypto.diffieHellman({ privateKey: privKey, publicKey: pubKey });
}

/**
 * HKDF (HMAC-based Key Derivation Function) — RFC 5869
 * @param {Buffer} ikm - Input keying material
 * @param {Buffer} salt - Salt (optional, defaults to zeros)
 * @param {Buffer} info - Context info
 * @param {number} length - Output key length in bytes
 * @returns {Buffer}
 */
function hkdf(ikm, salt, info, length = 32) {
  if (!salt) salt = Buffer.alloc(32, 0);
  // Extract
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  // Expand
  let t = Buffer.alloc(0);
  let okm = Buffer.alloc(0);
  let i = 1;
  while (okm.length < length) {
    t = crypto
      .createHmac("sha256", prk)
      .update(Buffer.concat([t, info, Buffer.from([i])]))
      .digest();
    okm = Buffer.concat([okm, t]);
    i++;
  }
  return okm.subarray(0, length);
}

/**
 * AES-256-GCM encrypt
 * @param {Buffer} key - 32-byte key
 * @param {Buffer|string} plaintext
 * @returns {{ ciphertext: string, iv: string, tag: string }} base64-encoded
 */
function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * AES-256-GCM decrypt
 * @param {Buffer} key - 32-byte key
 * @param {{ ciphertext: string, iv: string, tag: string }} envelope
 * @returns {Buffer}
 */
function decrypt(key, envelope) {
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─── Key Store ───

let identityKeyPair = null; // { publicKey, privateKey } Buffers (DER)
let signedPreKey = null; // { keyId, keyPair, signature }
let oneTimePreKeys = new Map(); // keyId -> keyPair
let sessions = new Map(); // peerId -> SessionState
let preKeyCounter = 0;

/**
 * Initialize the key store. Loads or generates identity keys.
 */
function initStore() {
  STORE_DIR = path.join(app.getPath("userData"), "ipfs-data", "signal");
  fs.mkdirSync(STORE_DIR, { recursive: true });

  const identityFile = path.join(STORE_DIR, "identity.json");
  if (fs.existsSync(identityFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(identityFile, "utf8"));
      identityKeyPair = {
        publicKey: Buffer.from(data.publicKey, "base64"),
        privateKey: Buffer.from(data.privateKey, "base64"),
      };
      preKeyCounter = data.preKeyCounter || 0;
      console.log("[Signal] Identity loaded.");
    } catch (e) {
      console.error("[Signal] Failed to load identity, regenerating:", e);
      identityKeyPair = null;
    }
  }

  if (!identityKeyPair) {
    identityKeyPair = generateKeyPair();
    preKeyCounter = 0;
    saveIdentity();
    console.log("[Signal] New identity generated.");
  }

  // Generate signed pre-key
  regenerateSignedPreKey();

  // Generate initial batch of one-time pre-keys
  generateOneTimePreKeys(10);

  // Load persisted sessions
  loadSessions();
}

function saveIdentity() {
  const identityFile = path.join(STORE_DIR, "identity.json");
  fs.writeFileSync(
    identityFile,
    JSON.stringify(
      {
        publicKey: identityKeyPair.publicKey.toString("base64"),
        privateKey: identityKeyPair.privateKey.toString("base64"),
        preKeyCounter: preKeyCounter,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function regenerateSignedPreKey() {
  const keyPair = generateKeyPair();
  const signature = crypto
    .createHmac("sha256", identityKeyPair.privateKey)
    .update(keyPair.publicKey)
    .digest();

  signedPreKey = {
    keyId: Date.now(),
    keyPair: keyPair,
    signature: signature,
  };
}

function generateOneTimePreKeys(count) {
  for (let i = 0; i < count; i++) {
    const keyId = ++preKeyCounter;
    oneTimePreKeys.set(keyId, generateKeyPair());
  }
  saveIdentity(); // Update counter
}

// ─── Pre-Key Bundle (for X3DH) ───

/**
 * Get this node's pre-key bundle for advertisement.
 * This is what peers need to establish a session with us.
 */
function getPreKeyBundle() {
  // Pick one OTK to share (first available)
  let oneTimePreKeyId = null;
  let oneTimePreKeyPublic = null;
  if (oneTimePreKeys.size > 0) {
    const [id, kp] = oneTimePreKeys.entries().next().value;
    oneTimePreKeyId = id;
    oneTimePreKeyPublic = kp.publicKey.toString("base64");
  }

  return {
    identityKey: identityKeyPair.publicKey.toString("base64"),
    signedPreKeyId: signedPreKey.keyId,
    signedPreKey: signedPreKey.keyPair.publicKey.toString("base64"),
    signedPreKeySignature: signedPreKey.signature.toString("base64"),
    oneTimePreKeyId: oneTimePreKeyId,
    oneTimePreKey: oneTimePreKeyPublic,
  };
}

// ─── X3DH Key Agreement (Initiator Side) ───

/**
 * Perform X3DH as the initiator to derive a shared secret with a peer.
 * @param {object} peerBundle - The peer's pre-key bundle
 * @returns {{ sharedSecret: Buffer, ephemeralPublicKey: string }}
 */
function performX3DH(peerBundle) {
  const ephemeral = generateKeyPair();

  const peerIdentityKey = Buffer.from(peerBundle.identityKey, "base64");
  const peerSignedPreKey = Buffer.from(peerBundle.signedPreKey, "base64");

  // DH1: Our identity key × Peer's signed pre-key
  const dh1 = computeSharedSecret(identityKeyPair.privateKey, peerSignedPreKey);
  // DH2: Our ephemeral key × Peer's identity key
  const dh2 = computeSharedSecret(ephemeral.privateKey, peerIdentityKey);
  // DH3: Our ephemeral key × Peer's signed pre-key
  const dh3 = computeSharedSecret(ephemeral.privateKey, peerSignedPreKey);

  let dhConcat = Buffer.concat([dh1, dh2, dh3]);

  // DH4 (optional): Our ephemeral key × Peer's one-time pre-key
  if (peerBundle.oneTimePreKey) {
    const peerOTK = Buffer.from(peerBundle.oneTimePreKey, "base64");
    const dh4 = computeSharedSecret(ephemeral.privateKey, peerOTK);
    dhConcat = Buffer.concat([dhConcat, dh4]);
  }

  // Derive shared secret via HKDF
  const sharedSecret = hkdf(
    dhConcat,
    null,
    Buffer.from("BucksSignalX3DH", "utf8"),
    32,
  );

  return {
    sharedSecret,
    ephemeralPublicKey: ephemeral.publicKey.toString("base64"),
  };
}

// ─── X3DH Key Agreement (Responder Side) ───

/**
 * Process an incoming X3DH handshake from a peer.
 * @param {string} peerIdentityKeyB64 - Peer's identity public key
 * @param {string} ephemeralKeyB64 - Peer's ephemeral public key
 * @param {number|null} oneTimePreKeyId - Which OTK was used (if any)
 * @returns {Buffer} sharedSecret
 */
function respondX3DH(peerIdentityKeyB64, ephemeralKeyB64, oneTimePreKeyId) {
  const peerIdentityKey = Buffer.from(peerIdentityKeyB64, "base64");
  const ephemeralKey = Buffer.from(ephemeralKeyB64, "base64");

  // DH1: Our signed pre-key × Peer's identity key
  const dh1 = computeSharedSecret(
    signedPreKey.keyPair.privateKey,
    peerIdentityKey,
  );
  // DH2: Our identity key × Peer's ephemeral key
  const dh2 = computeSharedSecret(identityKeyPair.privateKey, ephemeralKey);
  // DH3: Our signed pre-key × Peer's ephemeral key
  const dh3 = computeSharedSecret(
    signedPreKey.keyPair.privateKey,
    ephemeralKey,
  );

  let dhConcat = Buffer.concat([dh1, dh2, dh3]);

  // DH4: Use and consume the one-time pre-key
  if (oneTimePreKeyId !== null && oneTimePreKeys.has(oneTimePreKeyId)) {
    const otk = oneTimePreKeys.get(oneTimePreKeyId);
    const dh4 = computeSharedSecret(otk.privateKey, ephemeralKey);
    dhConcat = Buffer.concat([dhConcat, dh4]);
    oneTimePreKeys.delete(oneTimePreKeyId); // Consume it

    // Replenish if running low
    if (oneTimePreKeys.size < 5) {
      generateOneTimePreKeys(5);
    }
  }

  return hkdf(dhConcat, null, Buffer.from("BucksSignalX3DH", "utf8"), 32);
}

// ─── Double Ratchet Session State ───

/**
 * @typedef {Object} SessionState
 * @property {Buffer} rootKey - Current root key (32 bytes)
 * @property {Buffer} sendChainKey - Current sending chain key
 * @property {Buffer} recvChainKey - Current receiving chain key
 * @property {number} sendCounter - Messages sent in current chain
 * @property {number} recvCounter - Messages received in current chain
 * @property {object} sendRatchetKey - Our current ratchet key pair
 * @property {Buffer} peerRatchetKey - Peer's current ratchet public key
 */

/**
 * Initialize a new session with a peer after X3DH.
 * @param {string} peerId
 * @param {Buffer} sharedSecret - From X3DH
 * @param {boolean} isInitiator - Whether we initiated the session
 */
function createSession(peerId, sharedSecret, isInitiator) {
  const ratchetKeyPair = generateKeyPair();

  const session = {
    rootKey: sharedSecret,
    sendChainKey: null,
    recvChainKey: null,
    sendCounter: 0,
    recvCounter: 0,
    sendRatchetKey: {
      publicKey: ratchetKeyPair.publicKey.toString("base64"),
      privateKey: ratchetKeyPair.privateKey.toString("base64"),
    },
    peerRatchetKey: null,
    isInitiator: isInitiator,
    established: Date.now(),
  };

  // For the initiator, derive initial send chain from root key
  if (isInitiator) {
    const derived = hkdf(
      sharedSecret,
      null,
      Buffer.from("BucksInitSend", "utf8"),
      64,
    );
    session.sendChainKey = derived.subarray(0, 32);
    session.rootKey = derived.subarray(32, 64);
  }

  sessions.set(peerId, session);
  saveSessions();
  console.log(
    `[Signal] Session created with ${peerId.substring(0, 8)}... (${isInitiator ? "initiator" : "responder"})`,
  );
}

/**
 * Encrypt a message for a peer using the Double Ratchet.
 * @param {string} peerId
 * @param {string} plaintext
 * @returns {{ encrypted: object, ratchetKey: string, counter: number } | null}
 */
function encryptMessage(peerId, plaintext) {
  const session = sessions.get(peerId);
  if (!session) return null;

  // Derive message key from chain key using HKDF
  if (!session.sendChainKey) {
    // If no send chain yet, derive from root
    const derived = hkdf(
      Buffer.from(session.rootKey, "base64") || session.rootKey,
      null,
      Buffer.from("BucksMsgKey", "utf8"),
      64,
    );
    session.sendChainKey = derived.subarray(0, 32);
  }

  // KDF chain step: derive message key and advance chain
  const messageKey = hkdf(
    typeof session.sendChainKey === "string"
      ? Buffer.from(session.sendChainKey, "base64")
      : session.sendChainKey,
    null,
    Buffer.from("BucksMsgKey" + session.sendCounter, "utf8"),
    32,
  );

  // Advance chain key
  session.sendChainKey = hkdf(
    typeof session.sendChainKey === "string"
      ? Buffer.from(session.sendChainKey, "base64")
      : session.sendChainKey,
    null,
    Buffer.from("BucksChainAdv", "utf8"),
    32,
  );

  const encrypted = encrypt(messageKey, plaintext);
  const counter = session.sendCounter;
  session.sendCounter++;

  // Serialize chainKey for persistence
  if (Buffer.isBuffer(session.sendChainKey)) {
    session.sendChainKey = session.sendChainKey.toString("base64");
  }

  saveSessions();

  return {
    encrypted,
    ratchetKey: session.sendRatchetKey.publicKey,
    counter,
  };
}

/**
 * Decrypt a message from a peer using the Double Ratchet.
 * @param {string} peerId
 * @param {object} envelope - { encrypted, ratchetKey, counter }
 * @returns {string|null} plaintext
 */
function decryptMessage(peerId, envelope) {
  let session = sessions.get(peerId);
  if (!session) {
    console.warn(
      `[Signal] No session for ${peerId.substring(0, 8)}, cannot decrypt`,
    );
    return null;
  }

  // If peer's ratchet key changed, perform a DH ratchet step
  if (envelope.ratchetKey && envelope.ratchetKey !== session.peerRatchetKey) {
    session.peerRatchetKey = envelope.ratchetKey;

    // Perform DH with peer's new ratchet key
    const peerRatchetKeyBuf = Buffer.from(envelope.ratchetKey, "base64");
    const ourPrivKey = Buffer.from(session.sendRatchetKey.privateKey, "base64");

    try {
      const dhResult = computeSharedSecret(ourPrivKey, peerRatchetKeyBuf);
      const rootKeyBuf =
        typeof session.rootKey === "string"
          ? Buffer.from(session.rootKey, "base64")
          : session.rootKey;

      const derived = hkdf(
        Buffer.concat([rootKeyBuf, dhResult]),
        null,
        Buffer.from("BucksRatchet", "utf8"),
        64,
      );
      session.recvChainKey = derived.subarray(0, 32);
      session.rootKey = derived.subarray(32, 64).toString("base64");
      session.recvCounter = 0;
    } catch (e) {
      console.error("[Signal] DH ratchet step failed:", e.message);
    }
  }

  // Derive receive chain if needed
  if (!session.recvChainKey) {
    const rootKeyBuf =
      typeof session.rootKey === "string"
        ? Buffer.from(session.rootKey, "base64")
        : session.rootKey;
    const derived = hkdf(
      rootKeyBuf,
      null,
      Buffer.from("BucksRecvInit", "utf8"),
      64,
    );
    session.recvChainKey = derived.subarray(0, 32);
  }

  // Derive message key for this counter
  const recvChainBuf = Buffer.isBuffer(session.recvChainKey)
    ? session.recvChainKey
    : Buffer.from(session.recvChainKey, "base64");

  const messageKey = hkdf(
    recvChainBuf,
    null,
    Buffer.from("BucksMsgKey" + envelope.counter, "utf8"),
    32,
  );

  // Advance receive chain key
  session.recvChainKey = hkdf(
    recvChainBuf,
    null,
    Buffer.from("BucksChainAdv", "utf8"),
    32,
  ).toString("base64");

  session.recvCounter = envelope.counter + 1;
  saveSessions();

  try {
    const plaintext = decrypt(messageKey, envelope.encrypted);
    return plaintext.toString("utf8");
  } catch (err) {
    console.error(
      `[Signal] Decryption failed for ${peerId.substring(0, 8)}:`,
      err.message,
    );
    return null;
  }
}

/**
 * Check if a session exists for a peer.
 */
function hasSession(peerId) {
  return sessions.has(peerId);
}

/**
 * Get session info (for UI display).
 */
function getSessionInfo(peerId) {
  const session = sessions.get(peerId);
  if (!session) return null;
  return {
    established: session.established,
    messagesSent: session.sendCounter,
    messagesReceived: session.recvCounter,
    isInitiator: session.isInitiator,
  };
}

// ─── Persistence ───

function saveSessions() {
  if (!STORE_DIR) return;
  const sessionsFile = path.join(STORE_DIR, "sessions.json");
  const data = {};
  sessions.forEach((session, peerId) => {
    // Serialize Buffer fields to base64
    const s = { ...session };
    if (Buffer.isBuffer(s.rootKey)) s.rootKey = s.rootKey.toString("base64");
    if (Buffer.isBuffer(s.sendChainKey))
      s.sendChainKey = s.sendChainKey.toString("base64");
    if (Buffer.isBuffer(s.recvChainKey))
      s.recvChainKey = s.recvChainKey.toString("base64");
    data[peerId] = s;
  });
  try {
    fs.writeFileSync(sessionsFile, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("[Signal] Failed to save sessions:", e);
  }
}

function loadSessions() {
  if (!STORE_DIR) return;
  const sessionsFile = path.join(STORE_DIR, "sessions.json");
  if (fs.existsSync(sessionsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
      for (const [peerId, session] of Object.entries(data)) {
        sessions.set(peerId, session);
      }
      console.log(`[Signal] Loaded ${sessions.size} sessions.`);
    } catch (e) {
      console.error("[Signal] Failed to load sessions:", e);
    }
  }
}

// ─── Public API ───

function getIdentityPublicKey() {
  return identityKeyPair ? identityKeyPair.publicKey.toString("base64") : null;
}

module.exports = {
  initStore,
  getIdentityPublicKey,
  getPreKeyBundle,
  performX3DH,
  respondX3DH,
  createSession,
  encryptMessage,
  decryptMessage,
  hasSession,
  getSessionInfo,
  encrypt,
  decrypt,
  hkdf,
  generateKeyPair,
};
