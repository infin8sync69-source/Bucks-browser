'use strict';
// ipfs:// and ipns:// address normalisation for the address bar, matching Bucks-browser's
// normalizeIpfsUrl (hosting/src/main/ipfs/cid.js), without dependencies so the renderer can load
// it as a plain script (window.BucksIpfsUrl). ipfs:// and ipns:// are standard schemes, so
// Chromium lowercases the host: a CID must be base32 and a peer id base36 before navigation.
//   ipfs://Qm…                 → ipfs://bafy… (CIDv1, base32)
//   ipns://12D3Koo… / Qm…      → ipns://k51… (CIDv1 libp2p-key, base36)
//   ipns://Example.COM         → ipns://example.com (DNSLink)
//   ipfs://ipfs/<cid>, ipfs:///ipfs/<cid> → ipfs://<cid>/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BucksIpfsUrl = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
  const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  const DAG_PB = 0x70;
  const LIBP2P_KEY = 0x72;
  const BARE_PEER_ID = /^(1|Qm)[1-9A-HJ-NP-Za-km-z]{40,}$/;
  const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

  function base58Decode(str) {
    const bytes = [];
    for (const ch of str) {
      let carry = B58.indexOf(ch);
      if (carry < 0) return null;
      for (let j = 0; j < bytes.length; j += 1) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (let i = 0; i < str.length && str[i] === '1'; i += 1) bytes.push(0);
    return Uint8Array.from(bytes.reverse());
  }

  /** [value, bytesRead] of an unsigned varint at `at`, or null. */
  function varint(bytes, at) {
    let value = 0;
    for (let i = 0; i < 4 && at + i < bytes.length; i += 1) {
      value += (bytes[at + i] & 0x7f) * 2 ** (7 * i);
      if (!(bytes[at + i] & 0x80)) return [value, i + 1];
    }
    return null;
  }

  /** The bytes, when they are exactly one multihash (code, length, digest). */
  function asMultihash(bytes) {
    if (!bytes) return null;
    const code = varint(bytes, 0);
    if (!code) return null;
    const len = varint(bytes, code[1]);
    if (!len) return null;
    return code[1] + len[1] + len[0] === bytes.length ? bytes : null;
  }

  function base32(bytes) {
    let out = '';
    let bits = 0;
    let value = 0;
    for (const b of bytes) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return `b${out}`;
  }

  function base36(bytes) {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    let out = '';
    while (n > 0n) { out = B36[Number(n % 36n)] + out; n /= 36n; }
    for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) out = `0${out}`;
    return `k${out}`;
  }

  const cidV1 = (codec, multihash) => Uint8Array.from([1, codec, ...multihash]);

  /** CIDv0 → CIDv1 base32; a base32 CIDv1 is lowercased; anything else is returned unchanged. */
  function normalizeCid(host) {
    if (CID_V0.test(host)) {
      const mh = asMultihash(base58Decode(host));
      return mh ? base32(cidV1(DAG_PB, mh)) : host;
    }
    if (/^b[a-z2-7]{20,}$/i.test(host)) return host.toLowerCase();
    return host;
  }

  /** Peer ids (12D3Koo…, Qm…) → base36 libp2p-key CID; k… names and DNSLink domains lowercased. */
  function normalizeIpnsName(host) {
    if (BARE_PEER_ID.test(host)) {
      const mh = asMultihash(base58Decode(host));
      if (mh) return base36(cidV1(LIBP2P_KEY, mh));
    }
    return host.toLowerCase();
  }

  /** Normalise an ipfs:// or ipns:// address; any other input is returned unchanged. */
  function normalizeIpfsUrl(input) {
    const m = /^(ipfs|ipns):\/\/+(.*)$/i.exec(String(input).trim());
    if (!m) return input;
    const scheme = m[1].toLowerCase();
    const rest = m[2].replace(/^(ipfs|ipns)\/+/i, '');
    if (!rest) return `${scheme}://`;
    const hostEnd = rest.search(/[/?#]/);
    const host = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
    const tail = hostEnd === -1 ? '/' : rest.slice(hostEnd).replace(/^\/*/, '/');
    return `${scheme}://${scheme === 'ipfs' ? normalizeCid(host) : normalizeIpnsName(host)}${tail}`;
  }

  return { normalizeIpfsUrl, normalizeCid, normalizeIpnsName };
}));
