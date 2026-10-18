// CID / URL normalisation helpers. Pure functions, no Electron imports (unit-testable).
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import { base36 } from 'multiformats/bases/base36';
import { base58btc } from 'multiformats/bases/base58';
import * as Digest from 'multiformats/hashes/digest';

const LIBP2P_KEY_CODEC = 0x72;
/** Bare base58btc peer ids: 12D3Koo… (ed25519, identity multihash) and the legacy Qm… form. */
const BARE_PEER_ID = /^(1|Qm)[1-9A-HJ-NP-Za-km-z]{40,}$/;

/** CIDv0 (Qm…) and any CIDv1 → CIDv1 base32 string, so it survives case-insensitive URL hosts. */
export function normalizeCid(cidStr) {
  const cid = CID.parse(cidStr);
  return cid.toV1().toString(base32);
}

/**
 * Decode a bare base58btc-encoded peer id (12D3Koo…, Qm…) into its multihash.
 * Returns null when the string is not a complete, well-formed multihash.
 */
function decodeBarePeerId(str) {
  if (!BARE_PEER_ID.test(str)) return null;
  try {
    const bytes = base58btc.baseDecode(str);
    const mh = Digest.decode(bytes);
    return mh.bytes.length === bytes.length ? mh : null;
  } catch {
    return null;
  }
}

/** True when the string is a libp2p peer id in any of its textual forms (12D3Koo…, Qm…, k51…, bafzaa…). */
export function isPeerId(str) {
  const s = String(str || '').trim();
  if (decodeBarePeerId(s)) return true;
  try {
    const cid = CID.parse(s);
    return cid.version === 1 && cid.code === LIBP2P_KEY_CODEC;
  } catch {
    return false;
  }
}

/** IPNS name: peer IDs (12D3Koo…, Qm…, k51…) → base36 CIDv1 libp2p-key; DNSLink names pass through lowercased. */
export function normalizeIpnsName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return trimmed;
  const bare = decodeBarePeerId(trimmed);
  if (bare) return CID.createV1(LIBP2P_KEY_CODEC, bare).toString(base36);
  try {
    const cid = CID.parse(trimmed);
    if (cid.code === LIBP2P_KEY_CODEC || cid.version === 0) {
      return CID.createV1(LIBP2P_KEY_CODEC, cid.multihash).toString(base36);
    }
    return cid.toV1().toString(base36);
  } catch {
    // not a CID → DNSLink domain
    return trimmed.toLowerCase();
  }
}

/** True when the string is a syntactically valid CID. */
export function isCid(str) {
  try { CID.parse(str); return true; } catch { return false; }
}

/**
 * Normalise ipfs:// and ipns:// URLs. Returns the input unchanged for other schemes
 * or when the CID can't be parsed (the protocol handler will render an error page).
 * Accepts the sloppy forms users type: ipfs://ipfs/<cid>, ipfs:///ipfs/<cid>, ipfs://<cid>/path?x#y
 */
export function normalizeIpfsUrl(input) {
  const m = /^(ipfs|ipns):\/\/+(.*)$/i.exec(input.trim());
  if (!m) return input;
  const scheme = m[1].toLowerCase();
  let rest = m[2];
  // strip redundant /ipfs/ or /ipns/ path prefixes
  rest = rest.replace(/^(ipfs|ipns)\/+/i, '');
  if (!rest) return `${scheme}://`;

  const hostEnd = rest.search(/[/?#]/);
  const host = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
  const tail = hostEnd === -1 ? '/' : rest.slice(hostEnd).replace(/^\/*/, '/');

  if (scheme === 'ipfs') {
    try {
      return `ipfs://${normalizeCid(host)}${tail}`;
    } catch {
      return input;
    }
  }
  return `ipns://${normalizeIpnsName(host)}${tail}`;
}

/** Split an ipfs:// or ipns:// URL into { scheme, host, pathname, search, hash }. */
export function parseIpfsUrl(url) {
  const m = /^(ipfs|ipns):\/\/+([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url.trim());
  if (!m) return null;
  return {
    scheme: m[1].toLowerCase(),
    host: m[2],
    pathname: m[3] || '/',
    search: m[4] || '',
    hash: m[5] || '',
  };
}

/** Map an ipfs:// / ipns:// URL onto a path-style HTTP gateway (e.g. http://127.0.0.1:8080). */
export function toGatewayUrl(url, gatewayBase) {
  const p = parseIpfsUrl(url);
  if (!p) return null;
  const base = gatewayBase.replace(/\/+$/, '');
  return `${base}/${p.scheme}/${p.host}${p.pathname}${p.search}`;
}
