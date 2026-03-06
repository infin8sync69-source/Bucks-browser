/**
 * Bucks Crypto — Client-side wallet cryptography
 * 
 * Mirrors the C++ implementation exactly:
 * - BIP-8192 mnemonic (13-bit words from 8192 wordlist)
 * - PBKDF2-HMAC-SHA512 seed derivation (2048 rounds)
 * - HD8192 key derivation (HMAC-SHA512 with "BIP-8192 seed")
 * - secp256k1 ECDSA signing
 * - P2PKH addresses (base58Check with version 0x00)
 * - Transaction serialization matching C++ wire format
 */

// @ts-ignore
import * as secp from '@noble/secp256k1';
// @ts-ignore
import { sha256, sha512 } from '@noble/hashes/sha2.js';
// @ts-ignore
import { ripemd160 } from '@noble/hashes/legacy.js';
// @ts-ignore
import { hmac } from '@noble/hashes/hmac.js';
// @ts-ignore
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';

// ─── Constants (CONSENSUS-CRITICAL) ───
const WORD_BITS = 13; // log2(8192)
const PBKDF2_ROUNDS = 2048;
const SALT_PREFIX = 'bip-8192 mnemonic';
const HD_KEY = new TextEncoder().encode('BIP-8192 seed');

// ─── Hex Utils ───
export function toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

// ─── Binary helpers ───
function writeU32LE(buf: number[], v: number) {
    for (let i = 0; i < 4; i++) buf.push((v >>> (8 * i)) & 0xff);
}

function writeU64LE(buf: number[], v: number) {
    // JS safe integer range — split into low/high
    const lo = v & 0xffffffff;
    const hi = Math.floor(v / 0x100000000) & 0xffffffff;
    writeU32LE(buf, lo);
    writeU32LE(buf, hi);
}

function writeVarInt(buf: number[], v: number) {
    if (v < 0xfd) {
        buf.push(v);
    } else {
        buf.push(0xfd);
        buf.push(v & 0xff);
        buf.push((v >>> 8) & 0xff);
    }
}

function writeVarBytes(buf: number[], data: Uint8Array) {
    writeVarInt(buf, data.length);
    for (const b of data) buf.push(b);
}

// Read helpers
function readU32LE(data: Uint8Array, offset: { v: number }): number {
    const v = data[offset.v] | (data[offset.v + 1] << 8) | (data[offset.v + 2] << 16) | (data[offset.v + 3] << 24);
    offset.v += 4;
    return v >>> 0;
}

function readU64LE(data: Uint8Array, offset: { v: number }): number {
    const lo = readU32LE(data, offset);
    const hi = readU32LE(data, offset);
    return lo + hi * 0x100000000;
}

function readVarInt(data: Uint8Array, offset: { v: number }): number {
    const first = data[offset.v++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
        const v = data[offset.v] | (data[offset.v + 1] << 8);
        offset.v += 2;
        return v;
    }
    throw new Error('Unsupported VarInt size');
}

function readVarBytes(data: Uint8Array, offset: { v: number }): Uint8Array {
    const len = readVarInt(data, offset);
    const result = data.slice(offset.v, offset.v + len);
    offset.v += len;
    return result;
}

// ─── Hash Functions ───
export function doubleSha256(data: Uint8Array): Uint8Array {
    return sha256(sha256(data));
}

export function hash160(data: Uint8Array): Uint8Array {
    return ripemd160(sha256(data));
}

// ─── Base58Check ───
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
    // Count leading zeros
    let zeros = 0;
    for (const b of bytes) { if (b === 0) zeros++; else break; }

    // Convert to BigInt for base conversion
    let num = BigInt(0);
    for (const b of bytes) num = num * 256n + BigInt(b);

    let result = '';
    while (num > 0n) {
        const mod = Number(num % 58n);
        num = num / 58n;
        result = BASE58_CHARS[mod] + result;
    }

    return '1'.repeat(zeros) + result;
}

/**
 * Base58Check encode - matches C++ base58CheckEncode(version, payload)
 * NOTE: The C++ implementation returns hex(version + hash160), NOT standard base58check.
 * We match the C++ behavior exactly.
 */
export function base58CheckEncode(version: number, payload: Uint8Array): string {
    // C++ implementation: returns hexStr of (version byte + payload)
    // This is NOT standard base58check - it's a hex encoding
    const result = new Uint8Array(1 + payload.length);
    result[0] = version;
    result.set(payload, 1);
    return toHex(result);
}

// ─── Wordlist ───
let cachedWordlist: string[] | null = null;

export async function loadWordlist(): Promise<string[]> {
    if (cachedWordlist) return cachedWordlist;

    // Try to fetch from the blockchain node's wordlist
    try {
        const res = await fetch('/wordlists/bip_8192.txt');
        if (res.ok) {
            const text = await res.text();
            cachedWordlist = text.split('\n').map(w => w.trim()).filter(w => w.length > 0);
            if (cachedWordlist.length === 8192) return cachedWordlist;
        }
    } catch { }

    // Fallback: fetch from node API
    try {
        const res = await fetch('http://localhost:8080/wordlists/bip_8192.txt');
        if (res.ok) {
            const text = await res.text();
            cachedWordlist = text.split('\n').map(w => w.trim()).filter(w => w.length > 0);
            if (cachedWordlist.length === 8192) return cachedWordlist;
        }
    } catch { }

    throw new Error('Could not load BIP-8192 wordlist');
}

export function setWordlist(words: string[]) {
    if (words.length !== 8192) throw new Error(`Wordlist must have 8192 words, got ${words.length}`);
    cachedWordlist = words;
}

// ─── Mnemonic Generation (matches bip_8192.cpp) ───
function bytesToBits(bytes: Uint8Array): number[] {
    const bits: number[] = [];
    for (const b of bytes) {
        for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
    }
    return bits;
}

export async function generateMnemonic(): Promise<string> {
    const wordlist = await loadWordlist();

    // 128 bits of entropy (16 bytes) — matches C++ Wallet::generateKeys()
    const entropy = new Uint8Array(16);
    crypto.getRandomValues(entropy);
    return entropyToMnemonic(entropy, wordlist);
}

export function entropyToMnemonic(entropy: Uint8Array, wordlist: string[]): string {
    // SHA256 checksum
    const hash = sha256(entropy);
    const checksumBits = (entropy.length * 8) / 32; // 4 bits for 128-bit entropy

    const entropyBits = bytesToBits(entropy);
    const hashBits = bytesToBits(hash);
    const allBits = [...entropyBits, ...hashBits.slice(0, checksumBits)];

    // Convert to 13-bit word indices
    const wordCount = Math.floor(allBits.length / WORD_BITS);
    const words: string[] = [];
    for (let i = 0; i < wordCount; i++) {
        let idx = 0;
        for (let b = 0; b < WORD_BITS; b++) {
            idx = (idx << 1) | allBits[i * WORD_BITS + b];
        }
        words.push(wordlist[idx]);
    }

    return words.join(' ');
}

// ─── Seed Derivation (matches bip_8192.cpp) ───
export function mnemonicToSeed(mnemonic: string, passphrase: string = ''): Uint8Array {
    const salt = SALT_PREFIX + passphrase;
    return pbkdf2(sha512, mnemonic, salt, { c: PBKDF2_ROUNDS, dkLen: 64 });
}

// ─── HD8192 Key Derivation (matches hd_8192.cpp) ───
export interface ExtendedKey {
    key: Uint8Array;       // 32 bytes (private key)
    chainCode: Uint8Array; // 32 bytes
    isPrivate: boolean;
    depth: number;
}

export function createMasterKey(seed: Uint8Array): ExtendedKey {
    const I = hmac(sha512, HD_KEY, seed);
    return {
        key: I.slice(0, 32),
        chainCode: I.slice(32, 64),
        isPrivate: true,
        depth: 0,
    };
}

export function deriveChild(parent: ExtendedKey, childIndex: number): ExtendedKey {
    const hardened = childIndex >= 0x80000000;
    const data: number[] = [];

    if (parent.isPrivate) {
        if (hardened) {
            data.push(0x00);
            for (const b of parent.key) data.push(b);
        } else {
            const pub = secp.getPublicKey(parent.key, true);
            for (const b of pub) data.push(b);
        }
    } else {
        if (hardened) throw new Error('Cannot derive hardened child from public key');
        for (const b of parent.key) data.push(b);
    }

    // Append childIndex big-endian
    data.push((childIndex >>> 24) & 0xFF);
    data.push((childIndex >>> 16) & 0xFF);
    data.push((childIndex >>> 8) & 0xFF);
    data.push(childIndex & 0xFF);

    const I = hmac(sha512, parent.chainCode, new Uint8Array(data));
    const IL = I.slice(0, 32);
    const IR = I.slice(32, 64);

    if (parent.isPrivate) {
        // Add scalars: child = (parent + IL) mod n
        const parentBig = bytesToBigInt(parent.key);
        const ilBig = bytesToBigInt(IL);
        // secp256k1 curve order
        const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
        const childKey = ((parentBig + ilBig) % n);
        return {
            key: bigIntToBytes(childKey, 32),
            chainCode: IR,
            isPrivate: true,
            depth: parent.depth + 1,
        };
    }

    throw new Error('Public child derivation not implemented');
}

function bytesToBigInt(bytes: Uint8Array): bigint {
    let result = 0n;
    for (const b of bytes) result = (result << 8n) | BigInt(b);
    return result;
}

function bigIntToBytes(n: bigint, len: number): Uint8Array {
    const bytes = new Uint8Array(len);
    for (let i = len - 1; i >= 0; i--) {
        bytes[i] = Number(n & 0xFFn);
        n >>= 8n;
    }
    return bytes;
}

export function derivePath(master: ExtendedKey, path: string): ExtendedKey {
    let current = master;
    if (!path.startsWith('m')) return master;

    const parts = path.slice(2).split('/');
    for (const part of parts) {
        if (!part) continue;
        const hardened = part.endsWith("'");
        const idx = parseInt(hardened ? part.slice(0, -1) : part, 10);
        current = deriveChild(current, hardened ? idx + 0x80000000 : idx);
    }
    return current;
}

// ─── Key Pair (matches wallet.cpp) ───
export interface BucksKeyPair {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    address: string;
}

export function privateKeyToPublicKey(privKey: Uint8Array): Uint8Array {
    return secp.getPublicKey(privKey, true); // compressed
}

export function publicKeyToAddress(pubKey: Uint8Array): string {
    const h = hash160(pubKey);
    return base58CheckEncode(0x00, h);
}

export function privateKeyToAddress(privKey: Uint8Array): string {
    const pub = privateKeyToPublicKey(privKey);
    return publicKeyToAddress(pub);
}

/**
 * Generate a complete wallet from mnemonic
 * Matches: Wallet::generateKeys() → mnemonic → seed → master → derive "m/0"
 */
export function mnemonicToKeyPair(mnemonic: string, passphrase: string = ''): BucksKeyPair {
    const seed = mnemonicToSeed(mnemonic, passphrase);
    const master = createMasterKey(seed);
    const derived = derivePath(master, 'm/0');
    const privKey = derived.key;
    const pubKey = privateKeyToPublicKey(privKey);
    const address = publicKeyToAddress(pubKey);
    return { privateKey: privKey, publicKey: pubKey, address };
}

// ─── P2PKH Script (matches wallet.cpp) ───
export function addressToP2PKHScript(address: string): Uint8Array {
    // Address is hex(version + hash160), parse it
    const decoded = fromHex(address);
    if (decoded.length !== 21 || decoded[0] !== 0x00) {
        throw new Error('Invalid address format');
    }
    const h160 = decoded.slice(1); // skip version byte

    // OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
    const script = new Uint8Array(25);
    script[0] = 0x76;  // OP_DUP
    script[1] = 0xa9;  // OP_HASH160
    script[2] = 0x14;  // push 20 bytes
    script.set(h160, 3);
    script[23] = 0x88; // OP_EQUALVERIFY
    script[24] = 0xac; // OP_CHECKSIG
    return script;
}

export function pubKeyToP2PKHScript(pubKey: Uint8Array): Uint8Array {
    const h160 = hash160(pubKey);
    const script = new Uint8Array(25);
    script[0] = 0x76;
    script[1] = 0xa9;
    script[2] = 0x14;
    script.set(h160, 3);
    script[23] = 0x88;
    script[24] = 0xac;
    return script;
}

// ─── Transaction Types ───
export interface TxInput {
    prevTxid: Uint8Array; // 32 bytes
    prevIndex: number;
    scriptSig: Uint8Array;
    pubKey: Uint8Array;
    sequence: number;
}

export interface TxOutput {
    amount: number;
    scriptPubKey: Uint8Array;
}

export interface BucksTransaction {
    version: number;
    inputs: TxInput[];
    outputs: TxOutput[];
    lockTime: number;
}

// ─── Transaction Serialization (matches transaction.cpp) ───
export function serializeTransaction(tx: BucksTransaction): Uint8Array {
    const buf: number[] = [];

    writeU32LE(buf, tx.version);

    // inputs
    writeVarInt(buf, tx.inputs.length);
    for (const inp of tx.inputs) {
        for (const b of inp.prevTxid) buf.push(b);
        writeU32LE(buf, inp.prevIndex);
        writeVarBytes(buf, inp.scriptSig);
        writeU32LE(buf, inp.sequence);
    }

    // outputs
    writeVarInt(buf, tx.outputs.length);
    for (const out of tx.outputs) {
        writeU64LE(buf, out.amount);
        writeVarBytes(buf, out.scriptPubKey);
    }

    // locktime
    writeU32LE(buf, tx.lockTime);

    return new Uint8Array(buf);
}

// ─── Legacy Signature Hash (matches transaction.cpp) ───
function legacySignatureHash(tx: BucksTransaction, inputIndex: number): Uint8Array {
    // Clear all scriptSigs
    const tmp: BucksTransaction = {
        version: tx.version,
        inputs: tx.inputs.map((inp, i) => ({
            ...inp,
            scriptSig: new Uint8Array(0), // clear for signing
        })),
        outputs: [...tx.outputs],
        lockTime: tx.lockTime,
    };

    const data = serializeTransaction(tmp);
    // Append SIGHASH_ALL (u32 LE)
    const withSighash = new Uint8Array(data.length + 4);
    withSighash.set(data);
    withSighash[data.length] = 1; // SIGHASH_ALL
    withSighash[data.length + 1] = 0;
    withSighash[data.length + 2] = 0;
    withSighash[data.length + 3] = 0;

    return doubleSha256(withSighash);
}

// ─── Sign Transaction (matches transaction.cpp signInput) ───
export async function signTransaction(
    tx: BucksTransaction,
    privateKey: Uint8Array,
    publicKey: Uint8Array
): Promise<BucksTransaction> {
    const signed = { ...tx, inputs: [...tx.inputs.map(i => ({ ...i }))] };

    for (let i = 0; i < signed.inputs.length; i++) {
        const hash = legacySignatureHash(tx, i);
        const sig: any = await secp.signAsync(hash, privateKey, { lowS: true });
        const derSig = sig.toBytes('der');

        // Append SIGHASH_ALL byte
        const scriptSig = new Uint8Array(derSig.length + 1);
        scriptSig.set(derSig);
        scriptSig[derSig.length] = 0x01; // SIGHASH_ALL

        signed.inputs[i].scriptSig = scriptSig;
        signed.inputs[i].pubKey = publicKey;
    }

    return signed;
}

// ─── UTXO type ───
export interface UTXO {
    txid: string;
    vout: number;
    amount: number;
    script: string;
}

// ─── Build + Sign Transaction (high-level) ───
export async function buildAndSignTransaction(
    utxos: UTXO[],
    toAddress: string,
    amount: number,
    privateKey: Uint8Array,
    publicKey: Uint8Array,
    changeAddress: string
): Promise<{ rawHex: string; txid: string }> {
    // Select UTXOs (simple: use all until enough)
    let accumulated = 0;
    const selectedUtxos: UTXO[] = [];
    for (const u of utxos) {
        if (accumulated >= amount) break;
        selectedUtxos.push(u);
        accumulated += u.amount;
    }

    if (accumulated < amount) throw new Error('Insufficient balance');

    // Build inputs
    const inputs: TxInput[] = selectedUtxos.map(u => ({
        prevTxid: fromHex(u.txid),
        prevIndex: u.vout,
        scriptSig: new Uint8Array(0),
        pubKey: new Uint8Array(0),
        sequence: 0xffffffff,
    }));

    // Build outputs
    const outputs: TxOutput[] = [
        { amount, scriptPubKey: addressToP2PKHScript(toAddress) },
    ];

    // Fee calculation (matches C++: max(100000, size * 100))
    const tmpTx: BucksTransaction = { version: 1, inputs, outputs, lockTime: 0 };
    const tmpSize = serializeTransaction(tmpTx).length;
    const fee = Math.max(100000, tmpSize * 100);

    if (accumulated < amount + fee) throw new Error('Insufficient funds for fee');

    // Change output
    const change = accumulated - amount - fee;
    if (change > 0) {
        outputs.push({ amount: change, scriptPubKey: addressToP2PKHScript(changeAddress) });
    }

    // Create and sign
    const tx: BucksTransaction = { version: 1, inputs, outputs, lockTime: 0 };
    const signedTx = await signTransaction(tx, privateKey, publicKey);

    const rawBytes = serializeTransaction(signedTx);
    const rawHex = toHex(rawBytes);
    const txid = toHex(doubleSha256(serializeTransaction({ ...signedTx, inputs: signedTx.inputs.map(i => ({ ...i })) })));

    return { rawHex, txid };
}

// ─── Full Wallet Generation (convenience) ───
export async function createWallet(): Promise<{
    mnemonic: string;
    privateKey: string;
    publicKey: string;
    address: string;
}> {
    const mnemonic = await generateMnemonic();
    const keyPair = mnemonicToKeyPair(mnemonic);
    return {
        mnemonic,
        privateKey: toHex(keyPair.privateKey),
        publicKey: toHex(keyPair.publicKey),
        address: keyPair.address,
    };
}

export function restoreWallet(mnemonic: string, passphrase: string = ''): {
    privateKey: string;
    publicKey: string;
    address: string;
} {
    const keyPair = mnemonicToKeyPair(mnemonic, passphrase);
    return {
        privateKey: toHex(keyPair.privateKey),
        publicKey: toHex(keyPair.publicKey),
        address: keyPair.address,
    };
}
