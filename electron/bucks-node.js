/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║   BUCKS NODE — Embedded blockchain wallet backend         ║
 * ║   Account-model chain · Ed25519 · SHA-256 PoW · Gossip    ║
 * ╚═══════════════════════════════════════════════════════════╝
 *
 * Implements the wallet API the shell already speaks (main.js wallet-rpc),
 * but in-process — no localhost:8080 server, no port collision with the
 * Kubo gateway. Blocks and transactions sync between Bucks browsers over
 * the existing libp2p gossipsub mesh (chain topic derived from the
 * cluster secret, same scheme as feed/chat topics).
 *
 * Units: 1 BUCK = 100,000,000 sat (renderer divides by 1e8).
 *
 * Key handling (v1, documented limitation): signing seeds are encrypted
 * at rest with a per-device key (device.key). The wallet password
 * additionally encrypts the mnemonic backup. This is hot-wallet grade —
 * OS-keychain integration is the planned upgrade path.
 */

"use strict";

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

// ─── Consensus constants ───
const CLUSTER_SECRET = process.env.BUCKS_CLUSTER_SECRET || "BUCKS_DEFAULT_CLUSTER";
const CHAIN_TOPIC = `bucks-chain-${crypto.createHash("sha256").update(CLUSTER_SECRET).digest("hex").slice(0, 16)}`;
const SAT = 100_000_000;
const BLOCK_REWARD = 50 * SAT;
const HALVING_INTERVAL = 210_000;
const MAX_SUPPLY = 21_000_000 * SAT;
const DIFFICULTY = 4; // leading hex zeros — ~2^16 hashes, seconds on any laptop
const MAX_TX_PER_BLOCK = 200;

// Deterministic genesis — identical on every node so chains can merge.
const GENESIS = Object.freeze({
  index: 0,
  timestamp: 1735689600000, // 2025-01-01T00:00:00Z
  prevHash: "0".repeat(64),
  nonce: 0,
  difficulty: DIFFICULTY,
  miner: "GENESIS",
  txs: [],
  hash: "GENESIS-BUCKS-9f2c4a1e",
});

// 256-word mnemonic list (8 bits/word; 12 words = 96 bits of entropy)
const WORDLIST = ("able acid acorn actor adapt adopt after agent agree ahead alarm album alert alien alley allow alone alpha altar amber angle ankle annex apart apple apron arena argue armor arrow asset atlas atom attic audio autumn avoid awake award axis bacon badge bagel baker bamboo banjo barge basil basin batch beach beacon beam bean bear beast begin bell belt bench berry bike birch bird bison blade blank blaze blend bloom blue board boat bonus book boost booth border bound brain brand brave bread brick bridge brief bright brisk broad bronze brook broom brush buddy budget buffalo bugle bulb bundle burst cabin cable cactus camel campus canal candle canoe canyon carbon cargo carpet castle cause cedar cello chain chair chalk charm chase cheese cherry chess chief chill choir chrome cider cinema circle citrus civil claim clash clay clean clerk cliff climb clock cloud clover coach coast cobalt cocoa coin comet copper coral cotton couch cougar course cover coyote crab craft crane crater cream creek crew crisp cross crowd crown cruise crystal cube curve cycle daisy dance dawn decade deck deer delta denim depot desert desk dial diamond dice diesel dinner dolphin dome donor dove dozen draft dragon drama drift drum dune eager eagle earth east echo edge elbow elder ember emblem empire energy engine envoy epoch equal era essay ethic evening event exact exile fabric falcon family fancy farm feast feather fence fern ferry fever fiber field fig film final firefly fiscal flame flash fleet flint flora flute foam forest forge fossil found fox frame fresh frost").split(/\s+/);
if (WORDLIST.length !== 256) throw new Error(`Wordlist must be 256 words, got ${WORDLIST.length}`);

// ─── Module state ───
let DATA_DIR = null;
let gossip = null; // gossipsub instance (optional — node works offline)
let chain = [GENESIS];
let mempool = []; // validated pending txs
let accounts = new Map(); // address -> { balance, nonce }
let wallets = []; // { address, label, seed(Buffer, in-memory), created }
let deviceKey = null; // 32-byte at-rest encryption key
let miner = { running: false, address: null, blocksMined: 0, hashRate: 0, timer: null };
let onNewBlockCallbacks = [];

// ─── Small helpers ───
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const now = () => Date.now();

function ed25519FromSeed(seed32) {
  // PKCS8 DER wrapper for a raw ed25519 seed
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([prefix, seed32]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" });
  return { privateKey, publicKey, rawPub: spki.subarray(spki.length - 32) };
}

function addressFromRawPub(rawPub) {
  return "bx" + sha256(rawPub).slice(0, 40);
}

function generateMnemonic() {
  const entropy = crypto.randomBytes(12);
  return [...entropy].map((b) => WORDLIST[b]).join(" ");
}

function seedFromMnemonic(mnemonic) {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update("BUCKS-SEED:" + normalized).digest();
}

// AES-256-GCM envelope helpers (at-rest encryption)
function sealJson(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
function openJson(key, env) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

// ─── Transactions ───

function txSigningPayload(tx) {
  return JSON.stringify({
    from: tx.from, to: tx.to, amount: tx.amount,
    nonce: tx.nonce, timestamp: tx.timestamp,
  });
}

function txId(tx) {
  return sha256(txSigningPayload(tx) + tx.signature);
}

function buildTx(wallet, to, amount, nonce) {
  const { privateKey, rawPub } = ed25519FromSeed(wallet.seed);
  const tx = {
    from: wallet.address,
    to,
    amount,
    nonce,
    timestamp: now(),
    pubkey: rawPub.toString("base64"),
  };
  tx.signature = crypto.sign(null, Buffer.from(txSigningPayload(tx), "utf8"), privateKey).toString("base64");
  tx.id = txId(tx);
  return tx;
}

function verifyTxSignature(tx) {
  try {
    const rawPub = Buffer.from(tx.pubkey, "base64");
    if (rawPub.length !== 32) return false;
    if (addressFromRawPub(rawPub) !== tx.from) return false;
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPub]);
    const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    return crypto.verify(
      null,
      Buffer.from(txSigningPayload(tx), "utf8"),
      publicKey,
      Buffer.from(tx.signature, "base64"),
    );
  } catch (_) {
    return false;
  }
}

function validTxShape(tx) {
  return tx && typeof tx.from === "string" && typeof tx.to === "string" &&
    Number.isInteger(tx.amount) && tx.amount > 0 &&
    Number.isInteger(tx.nonce) && tx.nonce > 0 &&
    typeof tx.signature === "string" && typeof tx.pubkey === "string" &&
    tx.to.startsWith("bx") && tx.to.length === 42;
}

// ─── Accounts / chain state ───

function blockReward(height) {
  const halvings = Math.floor(height / HALVING_INTERVAL);
  if (halvings >= 64) return 0;
  return Math.floor(BLOCK_REWARD / Math.pow(2, halvings));
}

function getAccount(addr) {
  if (!accounts.has(addr)) accounts.set(addr, { balance: 0, nonce: 0 });
  return accounts.get(addr);
}

/** Apply a block's transactions to an account map. Throws on invalid spend. */
function applyBlock(block, accountMap) {
  const get = (a) => {
    if (!accountMap.has(a)) accountMap.set(a, { balance: 0, nonce: 0 });
    return accountMap.get(a);
  };
  for (const tx of block.txs) {
    if (tx.from === "COINBASE") {
      const expected = blockReward(block.index);
      if (tx.amount > expected) throw new Error(`Coinbase overpays at #${block.index}`);
      get(tx.to).balance += tx.amount;
      continue;
    }
    if (!validTxShape(tx) || !verifyTxSignature(tx)) throw new Error(`Bad tx sig in #${block.index}`);
    const sender = get(tx.from);
    if (sender.balance < tx.amount) throw new Error(`Overspend by ${tx.from} in #${block.index}`);
    if (tx.nonce <= sender.nonce) throw new Error(`Nonce replay by ${tx.from} in #${block.index}`);
    sender.balance -= tx.amount;
    sender.nonce = tx.nonce;
    get(tx.to).balance += tx.amount;
  }
}

function rebuildAccounts(fromChain) {
  const map = new Map();
  for (let i = 1; i < fromChain.length; i++) applyBlock(fromChain[i], map);
  return map;
}

// ─── Blocks ───

function blockHeader(block) {
  return JSON.stringify({
    index: block.index,
    timestamp: block.timestamp,
    prevHash: block.prevHash,
    nonce: block.nonce,
    difficulty: block.difficulty,
    miner: block.miner,
    txRoot: sha256(JSON.stringify(block.txs.map((t) => t.id || "coinbase:" + t.to + ":" + t.amount))),
  });
}

function meetsDifficulty(hash, difficulty) {
  return hash.startsWith("0".repeat(difficulty));
}

function validateBlockLink(block, prev) {
  if (block.index !== prev.index + 1) return "bad index";
  if (block.prevHash !== prev.hash) return "bad prevHash";
  if (block.difficulty !== DIFFICULTY) return "bad difficulty";
  if (sha256(blockHeader(block)) !== block.hash) return "bad hash";
  if (!meetsDifficulty(block.hash, block.difficulty)) return "insufficient PoW";
  if (!Array.isArray(block.txs) || block.txs.length > MAX_TX_PER_BLOCK + 1) return "too many txs";
  const coinbases = block.txs.filter((t) => t.from === "COINBASE");
  if (coinbases.length > 1) return "multiple coinbases";
  return null;
}

/** Validate an entire foreign chain. Returns account map or null. */
function validateChain(candidate) {
  if (!Array.isArray(candidate) || candidate.length === 0) return null;
  if (JSON.stringify(candidate[0]) !== JSON.stringify(GENESIS)) return null;
  const map = new Map();
  for (let i = 1; i < candidate.length; i++) {
    const err = validateBlockLink(candidate[i], candidate[i - 1]);
    if (err) return null;
    try {
      applyBlock(candidate[i], map);
    } catch (_) {
      return null;
    }
  }
  return map;
}

function appendBlock(block) {
  const err = validateBlockLink(block, chain[chain.length - 1]);
  if (err) throw new Error(`Block rejected: ${err}`);
  // applyBlock throws on invalid spends — try on a clone of state first
  const trial = new Map([...accounts].map(([k, v]) => [k, { ...v }]));
  applyBlock(block, trial);
  accounts = trial;
  chain.push(block);
  // Drop mined txs from mempool
  const minedIds = new Set(block.txs.map((t) => t.id));
  mempool = mempool.filter((t) => !minedIds.has(t.id));
  persistChain();
  onNewBlockCallbacks.forEach((cb) => { try { cb(block); } catch (_) {} });
}

// ─── Mining (non-blocking) ───

async function mineOneBlock(minerAddress) {
  const prev = chain[chain.length - 1];
  const txs = [];
  const reward = blockReward(prev.index + 1);
  if (reward > 0) {
    txs.push({ from: "COINBASE", to: minerAddress, amount: reward, timestamp: now() });
  }
  // Include pending txs (already validated on entry to mempool)
  txs.push(...mempool.slice(0, MAX_TX_PER_BLOCK));

  const block = {
    index: prev.index + 1,
    timestamp: now(),
    prevHash: prev.hash,
    nonce: 0,
    difficulty: DIFFICULTY,
    miner: minerAddress,
    txs,
  };

  const started = now();
  let hashes = 0;
  for (;;) {
    // Hash in chunks, then yield so we never block the event loop
    for (let i = 0; i < 20_000; i++) {
      const h = sha256(blockHeader(block));
      hashes++;
      if (meetsDifficulty(h, block.difficulty)) {
        block.hash = h;
        miner.hashRate = Math.round(hashes / Math.max(0.001, (now() - started) / 1000));
        // Chain may have advanced while we mined — recheck before appending
        if (block.prevHash !== chain[chain.length - 1].hash) return null;
        appendBlock(block);
        miner.blocksMined++;
        broadcast({ type: "block", block });
        return block;
      }
      block.nonce++;
    }
    if (!miner.running && miner.oneShot !== block.index) {
      // stopped mid-mine (only for continuous mode)
    }
    await new Promise((r) => setImmediate(r));
    // Abandon if someone else extended the chain
    if (block.prevHash !== chain[chain.length - 1].hash) return null;
  }
}

function startMining(address) {
  if (miner.running) return { success: true, alreadyRunning: true };
  miner.running = true;
  miner.address = address || miner.address || (wallets[0] && wallets[0].address);
  if (!miner.address) {
    miner.running = false;
    return { success: false, error: "No wallet to mine to — create one first" };
  }
  (async () => {
    while (miner.running) {
      try {
        await mineOneBlock(miner.address);
      } catch (e) {
        console.error("[BucksNode] Mining error:", e.message);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  console.log(`[BucksNode] Mining started → ${miner.address}`);
  return { success: true, address: miner.address };
}

function stopMining() {
  miner.running = false;
  return { success: true };
}

// ─── Gossip sync ───

function broadcast(msg) {
  if (!gossip) return;
  const data = new TextEncoder().encode(JSON.stringify(msg));
  gossip.publish(CHAIN_TOPIC, data).catch(() => {});
}

function handleChainMessage(msg) {
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(msg.data));
  } catch (_) {
    return;
  }
  try {
    if (data.type === "tx") {
      const res = acceptTx(data.tx, { rebroadcast: false });
      if (res.success) console.log(`[BucksNode] Gossiped tx accepted: ${data.tx.id.slice(0, 8)}`);
    } else if (data.type === "block" && data.block) {
      const tipIndex = chain[chain.length - 1].index;
      if (data.block.index === tipIndex + 1) {
        appendBlock(data.block);
        console.log(`[BucksNode] Gossiped block #${data.block.index} accepted`);
      } else if (data.block.index > tipIndex + 1) {
        broadcast({ type: "chain_request", height: tipIndex });
      }
    } else if (data.type === "chain_request") {
      if (chain.length - 1 > (data.height || 0)) {
        broadcast({ type: "chain", blocks: chain });
      }
    } else if (data.type === "chain" && Array.isArray(data.blocks)) {
      if (data.blocks.length > chain.length) {
        const map = validateChain(data.blocks);
        if (map) {
          chain = data.blocks;
          accounts = map;
          const chainTxIds = new Set(chain.flatMap((b) => b.txs.map((t) => t.id)));
          mempool = mempool.filter((t) => !chainTxIds.has(t.id));
          persistChain();
          console.log(`[BucksNode] Adopted longer chain: height ${chain.length - 1}`);
        }
      }
    }
  } catch (e) {
    // Invalid foreign data is expected on an open topic — log quietly
    console.warn("[BucksNode] Rejected gossip:", e.message);
  }
}

// ─── Mempool entry ───

function acceptTx(tx, { rebroadcast = true } = {}) {
  if (!validTxShape(tx)) return { success: false, error: "Malformed transaction" };
  if (!verifyTxSignature(tx)) return { success: false, error: "Invalid signature" };
  if (tx.id !== txId(tx)) return { success: false, error: "Transaction id mismatch" };
  if (mempool.some((t) => t.id === tx.id)) return { success: false, error: "Already in mempool" };

  const sender = getAccount(tx.from);
  const pendingSpend = mempool.filter((t) => t.from === tx.from).reduce((s, t) => s + t.amount, 0);
  if (sender.balance < pendingSpend + tx.amount) {
    return { success: false, error: "Insufficient balance" };
  }
  const pendingNonces = mempool.filter((t) => t.from === tx.from).map((t) => t.nonce);
  if (tx.nonce <= sender.nonce || pendingNonces.includes(tx.nonce)) {
    return { success: false, error: "Bad nonce" };
  }

  mempool.push(tx);
  if (rebroadcast) broadcast({ type: "tx", tx });
  return { success: true, txId: tx.id };
}

// ─── Persistence ───

function persistChain() {
  if (!DATA_DIR) return;
  try {
    fs.writeFileSync(path.join(DATA_DIR, "chain.json"), JSON.stringify(chain), "utf8");
  } catch (e) {
    console.error("[BucksNode] Failed to persist chain:", e.message);
  }
}

function walletsFile() {
  return path.join(DATA_DIR, "wallets.json");
}

function persistWallets() {
  const payload = wallets.map((w) => ({
    address: w.address,
    label: w.label,
    created: w.created,
    seedEnc: sealJson(deviceKey, { seed: w.seed.toString("hex") }),
    mnemonicEnc: w.mnemonicEnc || null, // password-encrypted backup (optional)
  }));
  fs.writeFileSync(walletsFile(), JSON.stringify(payload, null, 2), "utf8");
}

function loadWallets() {
  if (!fs.existsSync(walletsFile())) return;
  try {
    const raw = JSON.parse(fs.readFileSync(walletsFile(), "utf8"));
    wallets = raw.map((w) => ({
      address: w.address,
      label: w.label,
      created: w.created,
      seed: Buffer.from(openJson(deviceKey, w.seedEnc).seed, "hex"),
      mnemonicEnc: w.mnemonicEnc || null,
    }));
    console.log(`[BucksNode] Loaded ${wallets.length} wallet(s).`);
  } catch (e) {
    console.error("[BucksNode] Failed to load wallets:", e.message);
  }
}

// ─── Wallet operations ───

function createWallet(password, label = "Primary") {
  const mnemonic = generateMnemonic();
  return importWallet(mnemonic, password, label, { returnMnemonic: true });
}

function importWallet(mnemonic, password, label = "Primary", { returnMnemonic = false } = {}) {
  if (!mnemonic || mnemonic.trim().split(/\s+/).length < 3) {
    return { success: false, error: "Mnemonic too short" };
  }
  const seed = seedFromMnemonic(mnemonic);
  const { rawPub } = ed25519FromSeed(seed);
  const address = addressFromRawPub(rawPub);

  if (wallets.some((w) => w.address === address)) {
    return { success: true, address, existing: true, ...(returnMnemonic ? { mnemonic } : {}) };
  }

  let mnemonicEnc = null;
  if (password) {
    const salt = crypto.randomBytes(16);
    const pkey = crypto.scryptSync(password, salt, 32);
    mnemonicEnc = { salt: salt.toString("base64"), ...sealJson(pkey, { mnemonic }) };
  }

  wallets.push({ address, label, seed, created: now(), mnemonicEnc });
  persistWallets();
  console.log(`[BucksNode] Wallet ready: ${address}`);
  return { success: true, address, ...(returnMnemonic ? { mnemonic } : {}) };
}

function totalSupply() {
  let s = 0;
  accounts.forEach((a) => { s += a.balance; });
  return s;
}

function addressHistory(addr, limit = 50) {
  const txs = [];
  for (let i = chain.length - 1; i >= 1 && txs.length < limit; i--) {
    for (const tx of chain[i].txs) {
      if (tx.from === addr || tx.to === addr) {
        txs.push({ ...tx, blockIndex: i, blockTime: chain[i].timestamp });
        if (txs.length >= limit) break;
      }
    }
  }
  return txs;
}

// ─── RPC dispatch (mirrors the old HTTP API the shell speaks) ───

async function handleRPC(method, endpoint, body) {
  try {
    // Address lookup (prefix route)
    if (endpoint.startsWith("/api/address/")) {
      const addr = endpoint.slice("/api/address/".length).split("/")[0];
      const acct = accounts.get(addr) || { balance: 0, nonce: 0 };
      return { ok: true, address: addr, balance: acct.balance, nonce: acct.nonce, txs: addressHistory(addr) };
    }

    switch (`${method} ${endpoint}`) {
      case "GET /api/status":
        return { ok: true, height: chain.length - 1, mempool: mempool.length, mining: miner.running };

      case "GET /api/economy/status": {
        const supply = totalSupply();
        return {
          ok: true,
          height: chain.length - 1,
          supply,
          supply_bucks: supply / SAT,
          max_supply: MAX_SUPPLY,
          reward: blockReward(chain.length),
          difficulty: DIFFICULTY,
          mempool: mempool.length,
          // Symbolic gold peg: scarcity-weighted, grows as supply is mined
          price_per_buck: +(0.001 * (1 + supply / MAX_SUPPLY)).toFixed(8),
        };
      }

      case "GET /api/blockchain/info":
        return {
          ok: true,
          height: chain.length - 1,
          tipHash: chain[chain.length - 1].hash,
          difficulty: DIFFICULTY,
          supply: totalSupply(),
          mempool: mempool.length,
          genesis: GENESIS.hash,
          topic: CHAIN_TOPIC,
        };

      case "GET /api/wallets":
        return {
          ok: true,
          wallets: wallets.map((w) => ({
            address: w.address,
            label: w.label,
            balance: getAccount(w.address).balance,
            nonce: getAccount(w.address).nonce,
          })),
        };

      case "GET /api/wallets/primary": {
        if (wallets.length === 0) return { error: "No wallet" };
        const w = wallets[0];
        return { ok: true, address: w.address, label: w.label, balance: getAccount(w.address).balance };
      }

      case "GET /api/wallets/mnemonic/generate":
        return { ok: true, mnemonic: generateMnemonic() };

      case "POST /api/wallets/create":
        return createWallet(body && body.password);

      case "POST /api/wallets/restore":
        return importWallet(body.mnemonic, body.password);

      case "POST /api/wallets/sign": {
        const w = wallets.find((x) => x.address === body.address);
        if (!w) return { error: "Unknown wallet address" };
        const { privateKey, rawPub } = ed25519FromSeed(w.seed);
        const signature = crypto.sign(null, Buffer.from(String(body.message), "utf8"), privateKey).toString("base64");
        return { ok: true, signature, pubkey: rawPub.toString("base64") };
      }

      case "POST /api/transactions/send": {
        const w = wallets.find((x) => x.address === body.from);
        if (!w) return { success: false, error: "Sender wallet not found on this node" };
        const amount = Number(body.amount);
        if (!Number.isInteger(amount) || amount <= 0) return { success: false, error: "Invalid amount" };
        const sender = getAccount(w.address);
        const pendingNonces = mempool.filter((t) => t.from === w.address).map((t) => t.nonce);
        const nonce = Math.max(sender.nonce, ...pendingNonces, 0) + 1;
        const tx = buildTx(w, String(body.to), amount, nonce);
        const res = acceptTx(tx);
        return res.success ? { success: true, txId: tx.id, pending: mempool.length } : res;
      }

      case "POST /api/transactions/broadcast": {
        let tx;
        try {
          tx = typeof body.rawTx === "string" ? JSON.parse(body.rawTx) : body.rawTx;
        } catch (_) {
          return { success: false, error: "rawTx is not valid JSON" };
        }
        return acceptTx(tx);
      }

      case "POST /api/mining/mine": {
        const to = miner.address || (wallets[0] && wallets[0].address);
        if (!to) return { success: false, error: "No wallet to mine to — create one first" };
        const block = await mineOneBlock(to);
        if (!block) return { success: false, error: "Race lost — chain advanced during mining" };
        return { success: true, index: block.index, hash: block.hash, reward: blockReward(block.index), txs: block.txs.length };
      }

      case "POST /api/mining/start":
        return startMining(body && body.address);

      case "POST /api/mining/stop":
        return stopMining();

      case "GET /api/mining/status":
        return {
          ok: true,
          running: miner.running,
          address: miner.address,
          blocksMined: miner.blocksMined,
          hashRate: miner.hashRate,
          height: chain.length - 1,
        };

      case "POST /api/mining/address":
        if (!body.address || !String(body.address).startsWith("bx")) return { success: false, error: "Invalid address" };
        miner.address = String(body.address);
        return { success: true, address: miner.address };

      default:
        return { error: `Unknown endpoint: ${method} ${endpoint}` };
    }
  } catch (e) {
    console.error(`[BucksNode] RPC ${method} ${endpoint} failed:`, e.message);
    return { error: e.message };
  }
}

// ─── Lifecycle ───

/**
 * Initialize the node. Electron-free: caller supplies the data directory.
 * @param {object} opts - { dataDir }
 */
function init({ dataDir }) {
  DATA_DIR = dataDir;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Per-device at-rest key
  const keyFile = path.join(DATA_DIR, "device.key");
  if (fs.existsSync(keyFile)) {
    deviceKey = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
  } else {
    deviceKey = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, deviceKey.toString("hex"), { encoding: "utf8", mode: 0o600 });
  }

  // Load chain
  const chainFile = path.join(DATA_DIR, "chain.json");
  if (fs.existsSync(chainFile)) {
    try {
      const candidate = JSON.parse(fs.readFileSync(chainFile, "utf8"));
      const map = validateChain(candidate);
      if (map) {
        chain = candidate;
        accounts = map;
        console.log(`[BucksNode] Chain loaded: height ${chain.length - 1}`);
      } else {
        console.error("[BucksNode] Persisted chain invalid — starting from genesis");
      }
    } catch (e) {
      console.error("[BucksNode] Failed to load chain:", e.message);
    }
  }

  loadWallets();
  console.log(`[BucksNode] Node ready. Height=${chain.length - 1}, wallets=${wallets.length}, topic=${CHAIN_TOPIC}`);
  return { height: chain.length - 1, wallets: wallets.length };
}

/** Attach gossipsub once the IPFS node is up — enables multi-machine sync. */
function attachGossip(gossipSub) {
  gossip = gossipSub;
  gossip.addEventListener("message", (evt) => {
    if (evt.detail.topic === CHAIN_TOPIC) handleChainMessage(evt.detail);
  });
  gossip.subscribe(CHAIN_TOPIC);
  // Ask the mesh whether someone has a longer chain
  setTimeout(() => broadcast({ type: "chain_request", height: chain.length - 1 }), 5000);
  console.log(`[BucksNode] Chain sync attached to gossip topic ${CHAIN_TOPIC}`);
}

function resetWallets() {
  wallets = [];
  try {
    if (fs.existsSync(walletsFile())) fs.unlinkSync(walletsFile());
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function stop() {
  miner.running = false;
  persistChain();
}

function onNewBlock(cb) {
  onNewBlockCallbacks.push(cb);
}

module.exports = {
  init,
  attachGossip,
  handleRPC,
  resetWallets,
  stop,
  onNewBlock,
  startMining,
  stopMining,
  CHAIN_TOPIC,
  // exported for tests
  _test: { generateMnemonic, seedFromMnemonic, ed25519FromSeed, addressFromRawPub, validateChain },
};
