// Site package rules (docs/IPFS-HOSTING-IMPLEMENTATION.md §5, §6.3): the optional bucks-site.json
// manifest, the `_redirects` subset Bucks honours, and the "site descriptor" the ipfs:// handler
// derives from them. Pure functions, no Node or Electron imports: the protocol handler, the sites
// service and the unit tests all use them.

export const MANIFEST_FILE = 'bucks-site.json';
export const REDIRECTS_FILE = '_redirects';
export const SHELL_FILE = '_shell.html';
export const DEFAULT_ENTRY = 'index.html';
export const MAX_DESCRIPTOR_BYTES = 64 * 1024;
export const MAX_REDIRECT_RULES = 100;
const MAX_HEADER_PATTERNS = 50;
const MAX_HEADERS_PER_PATTERN = 32;
const MAX_HEADER_VALUE = 4096;
const MAX_NAME = 100;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]*$/;
/** Headers a site may never set: framing, cookies, redirects, IPFS metadata, credentialed CORS. */
const FORBIDDEN_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length',
  'content-encoding', 'content-range', 'set-cookie', 'set-cookie2', 'location', 'etag', 'x-ipfs-path',
  'x-ipfs-roots', 'access-control-allow-credentials', 'service-worker-allowed',
]);
const REDIRECT_STATUSES = new Set([200, 301, 302, 404]);

/** True for a relative POSIX path without '.', '..' or empty segments ('assets/app.js'). */
export function isSafeRelativePath(p) {
  if (typeof p !== 'string' || !p || p.length > 1024) return false;
  return p.split('/').every((s) => s && s !== '.' && s !== '..' && !/[\\\u0000-\u001f\u007f]/.test(s));
}

/** Last path segment has a file extension ('/a/b.js' yes, '/deep/link' and '/v1.2/' no). */
export function hasExtension(pathname) {
  const last = String(pathname || '').split('/').pop() || '';
  return /\.[A-Za-z0-9]{1,10}$/.test(last);
}

function cleanEntryPath(value, key, errors) {
  if (value === undefined || value === null) return null;
  const p = typeof value === 'string' ? value.replace(/^\/+/, '') : value;
  if (!isSafeRelativePath(p)) {
    errors.push(`"${key}" must be a relative file path inside the site`);
    return null;
  }
  return p;
}

/**
 * Validate one header block { Name: value }. Unknown, forbidden or malformed headers are dropped
 * with an error message; names are kept as written, compared case-insensitively.
 */
function cleanHeaders(obj, where, errors) {
  const out = {};
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(`${where} must be an object of header names to values`);
    return out;
  }
  let n = 0;
  for (const [name, value] of Object.entries(obj)) {
    if (n >= MAX_HEADERS_PER_PATTERN) { errors.push(`${where}: more than ${MAX_HEADERS_PER_PATTERN} headers`); break; }
    if (!HEADER_NAME.test(name)) { errors.push(`${where}: "${name.slice(0, 64)}" is not a valid header name`); continue; }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) { errors.push(`${where}: a site cannot set ${name}`); continue; }
    if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE || !HEADER_VALUE.test(value)) {
      errors.push(`${where}: the value of ${name} must be printable ASCII (at most ${MAX_HEADER_VALUE} characters)`);
      continue;
    }
    out[name] = value;
    n += 1;
  }
  return out;
}

/** A path pattern ('/*', '/blog/:slug', '/a/b.html') → RegExp with named placeholders, or null. */
export function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('/') || pattern.length > 512 || /\s/.test(pattern)) return null;
  const names = [];
  let src = '';
  const segments = pattern.split('/').slice(1);
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    if (seg === '*' && last) {
      src += '(?:/(.*))?';
      names.push('splat');
      break;
    }
    src += '/';
    if (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) {
      src += '([^/]+)';
      names.push(seg.slice(1));
    } else {
      src += seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // '/a/' and '/a' are the same path, as on other IPFS gateways
  return { re: new RegExp(`^${src || ''}/?$`), names };
}

/** Match a compiled pattern; returns the placeholder values ({ splat, slug, … }) or null. */
function matchPattern(compiled, pathname) {
  const m = compiled.re.exec(pathname);
  if (!m) return null;
  const params = {};
  compiled.names.forEach((n, i) => { params[n] = m[i + 1] ?? ''; });
  return params;
}

/**
 * Parse bucks-site.json. Never throws: problems are reported in `errors` and the offending keys
 * fall back to their defaults.
 * @param {string} text
 * @returns {{ manifest: { name: string|null, entry: string, spa: boolean, notFound: string|null,
 *   headers: Array<{ pattern: string, headers: Record<string,string> }>, csp: string|null, serviceWorker: false }, errors: string[] }}
 */
export function parseManifest(text) {
  const errors = [];
  const manifest = { name: null, entry: DEFAULT_ENTRY, spa: false, notFound: null, headers: [], csp: null, serviceWorker: false };
  let raw;
  try {
    raw = JSON.parse(String(text ?? ''));
  } catch (e) {
    return { manifest, errors: [`${MANIFEST_FILE} is not valid JSON (${e.message})`] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { manifest, errors: [`${MANIFEST_FILE} must contain a JSON object`] };

  if (raw.name !== undefined) {
    if (typeof raw.name === 'string' && raw.name.trim()) manifest.name = raw.name.trim().slice(0, MAX_NAME);
    else errors.push('"name" must be a non-empty string');
  }
  manifest.entry = cleanEntryPath(raw.entry, 'entry', errors) || DEFAULT_ENTRY;
  if (raw.spa !== undefined) {
    if (typeof raw.spa === 'boolean') manifest.spa = raw.spa;
    else errors.push('"spa" must be true or false');
  }
  manifest.notFound = cleanEntryPath(raw.notFound, 'notFound', errors);
  if (raw.headers !== undefined) {
    if (raw.headers === null || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) {
      errors.push('"headers" must map path patterns to header objects');
    } else {
      for (const [pattern, block] of Object.entries(raw.headers).slice(0, MAX_HEADER_PATTERNS)) {
        if (!compilePattern(pattern)) { errors.push(`"headers": "${pattern.slice(0, 80)}" is not a path pattern (start with /)`); continue; }
        const headers = cleanHeaders(block, `"headers" ${pattern}`, errors);
        if (Object.keys(headers).length) manifest.headers.push({ pattern, headers });
      }
    }
  }
  if (raw.csp !== undefined) {
    if (typeof raw.csp === 'string' && raw.csp.trim() && raw.csp.length <= MAX_HEADER_VALUE && HEADER_VALUE.test(raw.csp)) manifest.csp = raw.csp.trim();
    else errors.push('"csp" must be a Content-Security-Policy string');
  }
  if (raw.serviceWorker !== undefined && raw.serviceWorker !== false) errors.push('"serviceWorker" is reserved: service workers are not supported for ipfs:// and ipns:// yet');
  return { manifest, errors };
}

/**
 * Parse the `_redirects` subset: `from to [status]` per line, `#` comments, `*` and `:param`
 * placeholders, statuses 200 (rewrite), 301/302 (redirect) and 404 (custom page); the first match
 * wins. Forced rules (`200!`) are rejected. `/*  /index.html  200` becomes `spa: true` instead of a
 * rule, so missing assets still answer 404.
 * @param {string} text
 * @returns {{ rules: Array<{ from: string, to: string, status: number }>, spa: boolean, spaEntry: string|null, warnings: string[] }}
 */
export function parseRedirects(text) {
  const rules = [];
  const warnings = [];
  let spa = false;
  let spaEntry = null;
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/#.*$/, '').trim();
    if (!line) continue;
    const where = `${REDIRECTS_FILE} line ${i + 1}`;
    if (rules.length >= MAX_REDIRECT_RULES) { warnings.push(`${REDIRECTS_FILE}: only the first ${MAX_REDIRECT_RULES} rules are used`); break; }
    const parts = line.split(/\s+/);
    if (parts.length < 2 || parts.length > 3) { warnings.push(`${where}: expected "from to [status]"`); continue; }
    const [from, to, statusRaw = '301'] = parts;
    if (statusRaw.endsWith('!')) { warnings.push(`${where}: forced rules (${statusRaw}) are not supported and were ignored`); continue; }
    const status = Number(statusRaw);
    if (!REDIRECT_STATUSES.has(status)) { warnings.push(`${where}: status ${statusRaw} is not supported (200, 301, 302, 404)`); continue; }
    if (!compilePattern(from)) { warnings.push(`${where}: "${from}" is not a path pattern`); continue; }
    const absolute = /^https?:\/\//i.test(to);
    if (!(to.startsWith('/') || (absolute && (status === 301 || status === 302)))) {
      warnings.push(`${where}: "${to}" must be a path in the site${status === 200 || status === 404 ? '' : ' or an http(s) URL'}`);
      continue;
    }
    if (from === '/*' && status === 200 && /^\/[^:*?#]+\.html?$/i.test(to) && isSafeRelativePath(to.slice(1))) {
      spa = true;
      spaEntry = to.slice(1);
      continue;
    }
    rules.push({ from, to, status });
  }
  return { rules, spa, spaEntry, warnings };
}

/**
 * The first `_redirects` rule matching `pathname`, with placeholders substituted into the target.
 * @returns {{ rule: { from: string, to: string, status: number }, target: string } | null}
 */
export function matchRedirect(rules, pathname) {
  for (const rule of rules || []) {
    const compiled = compilePattern(rule.from);
    if (!compiled) continue;
    const params = matchPattern(compiled, pathname);
    if (!params) continue;
    const target = rule.to.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => (Object.hasOwn(params, name) ? params[name] : whole));
    return { rule, target };
  }
  return null;
}

/**
 * The descriptor the ipfs:// handler serves a site by. The manifest wins over `_redirects` when both
 * exist; with neither, nothing changes from plain gateway behaviour.
 * @param {{ manifestText?: string|null, redirectsText?: string|null }} input
 * @returns {{ source: 'manifest'|'redirects'|'none', name: string|null, entry: string, spa: boolean, fallback: string,
 *   notFound: string|null, rules: Array<{ from: string, to: string, status: number }>,
 *   headers: Array<{ pattern: string, headers: Record<string,string> }>, csp: string|null, problems: string[] }}
 */
export function buildDescriptor({ manifestText = null, redirectsText = null } = {}) {
  const base = { source: 'none', name: null, entry: DEFAULT_ENTRY, spa: false, fallback: DEFAULT_ENTRY, notFound: null, rules: [], headers: [], csp: null, problems: [] };
  if (typeof manifestText === 'string') {
    const { manifest, errors } = parseManifest(manifestText);
    return { ...base, source: 'manifest', name: manifest.name, entry: manifest.entry, spa: manifest.spa, fallback: manifest.entry, notFound: manifest.notFound, headers: manifest.headers, csp: manifest.csp, problems: errors };
  }
  if (typeof redirectsText === 'string') {
    const { rules, spa, spaEntry, warnings } = parseRedirects(redirectsText);
    return { ...base, source: 'redirects', spa, fallback: spaEntry || DEFAULT_ENTRY, rules, problems: warnings };
  }
  return base;
}

/** Extra response headers for a path: every matching manifest block in order, then `csp`. */
export function headersFor(descriptor, pathname) {
  const out = {};
  for (const { pattern, headers } of descriptor?.headers || []) {
    const compiled = compilePattern(pattern);
    if (compiled && matchPattern(compiled, pathname)) Object.assign(out, headers);
  }
  if (descriptor?.csp) {
    for (const k of Object.keys(out)) if (k.toLowerCase() === 'content-security-policy') delete out[k];
    out['Content-Security-Policy'] = descriptor.csp;
  }
  return out;
}
