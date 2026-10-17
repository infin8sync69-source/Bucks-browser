// CID / URL normalisation helpers. Pure functions, no Electron imports (unit-testable).
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import { base36 } from 'multiformats/bases/base36';

const LIBP2P_KEY_CODEC = 0x72;

/** CIDv0 (Qm…) and any CIDv1 → CIDv1 base32 string, so it survives case-insensitive URL hosts. */
export function normalizeCid(cidStr) {
  const cid = CID.parse(cidStr);
  return cid.toV1().toString(base32);
}

/** IPNS name: peer IDs (12D3Koo…, Qm…) → base36 CIDv1 libp2p-key; DNSLink names pass through lowercased. */
export function normalizeIpnsName(name) {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
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
