// Third-party cookie helpers. Pure functions, no Electron imports (unit-testable).

/**
 * Public suffixes that span two labels. A site under one of these is registered one label
 * deeper (example.co.uk, not co.uk). This is a deliberately small, conservative list of the
 * common ccTLD second levels plus the big "user sites live under a shared domain" hosts,
 * where treating `alice.github.io` and `bob.github.io` as one site would let them share cookies.
 * It is NOT the full Public Suffix List.
 */
const TWO_LEVEL_SUFFIXES = new Set([
  // United Kingdom & Ireland
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  // Oceania
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  // Asia
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'go.kr', 'ac.kr',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'gov.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.hk', 'org.hk', 'com.tw', 'org.tw',
  'com.sg', 'edu.sg', 'com.my', 'co.id', 'co.il', 'co.th', 'in.th', 'com.vn', 'com.ph', 'com.pk',
  // Americas
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec',
  // Europe, Middle East, Africa
  'com.tr', 'org.tr', 'com.ua', 'com.pl', 'com.es', 'co.za', 'org.za', 'com.ng', 'com.eg', 'com.sa', 'co.ke', 'co.tz',
  // Shared hosting domains where each subdomain is an independent site
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
  'web.app', 'firebaseapp.com', 'blogspot.com', 'azurewebsites.net', 'appspot.com',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for IPv4 literals and bracketed/colon IPv6 literals. */
function isIpLiteral(host) {
  return IPV4.test(host) || host.startsWith('[') || host.includes(':');
}

/**
 * Approximate eTLD+1: the last two labels, or the last three when the last two form a known
 * two-level suffix (co.uk, github.io, ...). IP literals, single-label hosts (localhost, intranet
 * names) are returned unchanged.
 * @param {string} hostname
 * @returns {string}
 */
export function registrableDomain(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host || isIpLiteral(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/**
 * The "site" of a URL: registrable domain for http(s) and ws(s), otherwise scheme + host
 * (so every ipfs://<cid> is its own site). Returns '' when the URL cannot be parsed.
 * @param {string} url
 * @returns {string}
 */
export function siteOf(url) {
  try {
    const u = new URL(url);
    if (/^(https?|wss?):$/.test(u.protocol)) return registrableDomain(u.hostname);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/**
 * Whether `requestUrl` belongs to a different site than `firstPartyUrl`.
 * Conservative: when either side is unknown/unparseable it is NOT third-party.
 * @param {string} requestUrl
 * @param {string} firstPartyUrl
 * @returns {boolean}
 */
export function isThirdParty(requestUrl, firstPartyUrl) {
  const a = siteOf(requestUrl);
  const b = siteOf(firstPartyUrl);
  if (!a || !b) return false;
  return a !== b;
}

/**
 * Return a copy of `responseHeaders` without any Set-Cookie entries (header names are
 * case-insensitive). `removed` is the number of cookie header values dropped.
 * @param {Record<string, string[]|string>} responseHeaders
 * @returns {{ headers: Record<string, string[]|string>, removed: number }}
 */
export function stripSetCookie(responseHeaders) {
  const headers = {};
  let removed = 0;
  for (const [name, value] of Object.entries(responseHeaders || {})) {
    if (name.toLowerCase() === 'set-cookie' || name.toLowerCase() === 'set-cookie2') {
      removed += Array.isArray(value) ? value.length : 1;
    } else {
      headers[name] = value;
    }
  }
  return { headers, removed };
}
