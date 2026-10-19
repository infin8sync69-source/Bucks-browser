// IPNS key backup and restore (docs/IPFS-HOSTING-IMPLEMENTATION.md §8.4). Kubo cannot export a key
// over its RPC API, so the main process reads the key file from the repository's keystore folder
// and encrypts it with a passphrase the user chooses (scrypt + AES-256-GCM). The passphrase is
// never stored. Restoring decrypts the file and imports the key with key/import. No Electron.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, scrypt as scryptCb, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { base32 } from 'multiformats/bases/base32';

const scrypt = promisify(scryptCb);
export const BACKUP_FORMAT = 'bucks-site-key';
export const BACKUP_VERSION = 1;
export const MIN_PASSPHRASE = 10;
const KDF = Object.freeze({ name: 'scrypt', N: 2 ** 17, r: 8, p: 1 });
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MAX_KEY_BYTES = 8192;
const MAX_BACKUP_BYTES = 64 * 1024;

/**
 * Kubo's file name for a key in <repo>/keystore: "key_" + the name in lowercase base32 without
 * padding ('site-s_abc' → 'key_onuxizjnonpwcytd').
 */
export function keystoreFileName(keyName) {
  if (typeof keyName !== 'string' || !keyName || keyName === 'self') throw new Error('invalid key name');
  return `key_${base32.baseEncode(new TextEncoder().encode(keyName))}`;
}

/** Read a key's private bytes from the repository (main process only; never sent anywhere). */
export async function readKeystoreKey(repoDir, keyName) {
  const file = path.join(repoDir, 'keystore', keystoreFileName(keyName));
  const st = await fsp.lstat(file).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`The key for this site is not in this node's keystore (${keyName}).`);
  if (st.size === 0 || st.size > MAX_KEY_BYTES) throw new Error('The key file has an unexpected size.');
  return new Uint8Array(await fsp.readFile(file));
}

function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || [...passphrase].length < MIN_PASSPHRASE) {
    throw new Error(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  }
  if (passphrase.length > 1024) throw new Error('The passphrase is too long.');
}

const deriveKey = (passphrase, salt, kdf) => scrypt(passphrase.normalize('NFKC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM });

/**
 * Encrypt a key for a backup file.
 * @param {Uint8Array} keyBytes
 * @param {string} passphrase
 * @param {{ siteName?: string, ipns: string, keyName: string, createdAt?: string }} meta  stored in clear, bound by GCM
 * @returns {Promise<Buffer>} the file contents (JSON)
 */
export async function encryptKeyBackup(keyBytes, passphrase, meta) {
  checkPassphrase(passphrase);
  if (!(keyBytes instanceof Uint8Array) || keyBytes.byteLength === 0 || keyBytes.byteLength > MAX_KEY_BYTES) throw new Error('invalid key bytes');
  const info = { siteName: String(meta?.siteName || '').slice(0, 100), ipns: String(meta?.ipns || ''), keyName: String(meta?.keyName || ''), createdAt: meta?.createdAt || new Date().toISOString() };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, KDF);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(info)));
  const ciphertext = Buffer.concat([cipher.update(keyBytes), cipher.final()]);
  const file = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    meta: info,
    kdf: { ...KDF, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64'),
  };
  return Buffer.from(`${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Decrypt a backup file. A wrong passphrase and a tampered file fail the same way.
 * @param {Uint8Array} fileBytes
 * @param {string} passphrase
 * @returns {Promise<{ keyBytes: Uint8Array, meta: { siteName: string, ipns: string, keyName: string, createdAt: string } }>}
 */
export async function decryptKeyBackup(fileBytes, passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('Enter the passphrase of this backup.');
  if (!fileBytes || fileBytes.byteLength > MAX_BACKUP_BYTES) throw new Error('This is not a Bucks site key backup.');
  let file;
  try {
    file = JSON.parse(Buffer.from(fileBytes).toString('utf8'));
  } catch {
    throw new Error('This is not a Bucks site key backup.');
  }
  if (file?.format !== BACKUP_FORMAT) throw new Error('This is not a Bucks site key backup.');
  if (file.version !== BACKUP_VERSION) throw new Error(`This key backup was made by a newer Bucks (format ${file.version}).`);
  const k = file.kdf || {};
  // Bounds stop a crafted file from making scrypt allocate gigabytes.
  if (k.name !== 'scrypt' || !Number.isInteger(k.N) || k.N < 2 ** 14 || k.N > 2 ** 20 || (k.N & (k.N - 1)) !== 0
    || !Number.isInteger(k.r) || k.r < 1 || k.r > 16 || !Number.isInteger(k.p) || k.p < 1 || k.p > 4) {
    throw new Error('This key backup uses unsupported encryption settings.');
  }
  const key = await deriveKey(passphrase, Buffer.from(String(k.salt || ''), 'base64'), k);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(file.cipher?.iv || ''), 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(file.meta)));
    decipher.setAuthTag(Buffer.from(String(file.cipher?.tag || ''), 'base64'));
    const keyBytes = Buffer.concat([decipher.update(Buffer.from(String(file.ciphertext || ''), 'base64')), decipher.final()]);
    return { keyBytes: new Uint8Array(keyBytes), meta: file.meta };
  } catch {
    throw new Error('Wrong passphrase, or the backup file was changed.');
  }
}
