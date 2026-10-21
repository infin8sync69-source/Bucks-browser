// Preflight checks P1–P12 (docs/IPFS-HOSTING-IMPLEMENTATION.md §5.3): run before anything is
// uploaded. Pure functions over a file list, the entries the walk left out, and the text of the
// files worth scanning, so they run under plain node. Each result is block | warn | info; a block
// that the default action already handles (links and secret files are left out) is `resolved`.

import { SHELL_FILE, MANIFEST_FILE, REDIRECTS_FILE } from './package.js';

export const LARGE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LISTED = 20;
const MAX_FINDINGS_PER_FILE = 5;
const MAX_FINDINGS = 50;
const UNCOMPRESSED_MEDIA = /\.(bmp|wav|aiff?|tiff?|psd)$/i;
const HTML_FILE = /\.html?$/i;
const SCRIPT_FILE = /\.(m?js|cjs|jsx|tsx?)$/i;
const STYLE_FILE = /\.css$/i;

/** Secret-looking text. The matched value is never reported, only the file, line and kind. */
const SECRET_PATTERNS = [
  { kind: 'private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'API key (sk-…)', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'Stripe secret key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/ },
  { kind: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'database URL with a password', re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:/@'"`]+:[^\s@/'"`]+@/i },
];
const ASSIGNED_SECRET = /\b(?:api[_-]?key|apikey|client[_-]?secret|secret|token|password|passwd|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/gi;
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g;
// A Firebase web config: { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId }.
// Its apiKey is public by design (Firebase Security Rules and App Check guard the data), unlike other
// Google keys of the same AIza… form (Maps, Gemini, Cloud APIs), which are billed secrets.
const FIREBASE_API_KEY = /\bapiKey["']?\s*:\s*["'`]$/;
const FIREBASE_FIELDS = /\b(?:projectId|appId|messagingSenderId|storageBucket)\b/;
const FIREBASE_WINDOW = 600; // a config object, minified or formatted, fits well inside this

const list = (items) => {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
};
const mib = (bytes) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;

/**
 * Is the Google key at `index` of `text` the apiKey of a Firebase web config: the value of an
 * `apiKey` property, with `authDomain` and another config field within FIREBASE_WINDOW characters?
 * Exported for tests.
 */
export function inFirebaseConfig(text, index, length) {
  if (!FIREBASE_API_KEY.test(text.slice(Math.max(0, index - 32), index))) return false;
  const around = text.slice(Math.max(0, index - FIREBASE_WINDOW), index + length + FIREBASE_WINDOW);
  return /\bauthDomain\b/.test(around) && FIREBASE_FIELDS.test(around);
}

/**
 * Line numbers (1-based) and kinds of secret-looking text in one file. A Firebase web API key is
 * reported with `public: true` (a warning, not a block). Exported for tests.
 */
export function findSecrets(text) {
  const out = [];
  const all = String(text);
  const lines = all.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length && out.length < MAX_FINDINGS_PER_FILE; offset += lines[i].length + 1, i += 1) {
    const line = lines[i];
    if (line.length > 20_000_000) continue;
    for (const { kind, re } of SECRET_PATTERNS) {
      if (re.test(line)) out.push({ line: i + 1, kind });
    }
    let firebase = false;
    let google = false;
    for (const g of line.matchAll(GOOGLE_KEY)) {
      if (inFirebaseConfig(all, offset + g.index, g[0].length)) firebase = true; else google = true;
    }
    if (google) out.push({ line: i + 1, kind: 'Google API key' });
    if (firebase) out.push({ line: i + 1, kind: 'Firebase web API key', public: true });
    ASSIGNED_SECRET.lastIndex = 0;
    let m;
    while ((m = ASSIGNED_SECRET.exec(line)) !== null) {
      // a real secret mixes letters and digits; prose and identifiers usually do not
      if (!(/[A-Za-z]/.test(m[1]) && /[0-9]/.test(m[1]))) continue;
      // `apiKey: "AIza…"` of a Firebase config is the public key reported above
      const at = offset + m.index + m[0].lastIndexOf(m[1]);
      if (/^AIza[0-9A-Za-z_-]{35}$/.test(m[1]) && inFirebaseConfig(all, at, m[1].length)) continue;
      out.push({ line: i + 1, kind: 'long value assigned to a secret name' });
      break;
    }
  }
  return out.slice(0, MAX_FINDINGS_PER_FILE);
}

/** Hosts a page loads subresources from (scripts, styles, images, frames, media, fetch). */
export function externalHosts(path, text) {
  const hosts = new Set();
  const add = (h) => { if (h) hosts.add(h.toLowerCase()); };
  const s = String(text);
  if (HTML_FILE.test(path)) {
    for (const m of s.matchAll(/<(?:script|img|link|iframe|video|audio|source|embed|object|track)\b[^>]*?\b(?:src|href|data)\s*=\s*["']?(?:https?:)?\/\/([^/"'\s>?#]+)/gi)) add(m[1]);
  }
  if (HTML_FILE.test(path) || STYLE_FILE.test(path)) {
    for (const m of s.matchAll(/url\(\s*["']?(?:https?:)?\/\/([^/"')\s?#]+)/gi)) add(m[1]);
    for (const m of s.matchAll(/@import\s+["'](?:https?:)?\/\/([^/"'\s?#]+)/gi)) add(m[1]);
  }
  if (HTML_FILE.test(path) || SCRIPT_FILE.test(path)) {
    for (const m of s.matchAll(/fetch\(\s*["'`](?:https?:)?\/\/([^/"'`\s?#]+)/g)) add(m[1]);
  }
  return [...hosts];
}

/**
 * Run every check.
 * @param {{
 *   files: Array<{ path: string, size: number }>,             // what would be published
 *   excluded?: Array<{ path: string, reason: 'hidden'|'secret'|'symlink'|'special'|'user'|'unreadable' }>,
 *   contents?: Map<string, string>,                            // text of the files worth scanning
 *   descriptor: { entry: string, spa: boolean, rules: object[], problems?: string[], source?: string },
 *   quotaBytes: number, maxFiles: number, truncated?: boolean,
 * }} input
 * @returns {Array<{ id: string, level: 'block'|'warn'|'info', message: string, resolved?: boolean,
 *   files?: Array<{ path: string, line?: number, kind?: string }>, hosts?: string[], fix?: { action: string, label: string } }>}
 */
export function runPreflight({ files, excluded = [], contents = new Map(), descriptor, quotaBytes, maxFiles, truncated = false }) {
  const checks = [];
  const paths = new Set(files.map((f) => f.path));
  const texts = [...contents.entries()];
  const entry = descriptor.entry;

  // P1: the entry file
  if (!paths.has(entry)) {
    const shell = entry === 'index.html' && paths.has(SHELL_FILE);
    checks.push({
      id: 'P1',
      level: 'block',
      message: shell
        ? `This folder has no ${entry}, but it has ${SHELL_FILE} (a single-page-app shell). Use it as ${entry}?`
        : `This folder has no ${entry}. Pick the folder that contains your built site.`,
      ...(shell ? { fix: { action: 'use-shell-as-index', label: `Use ${SHELL_FILE} as ${entry}` } } : {}),
    });
  }

  // P2: links and special files are never followed or published
  const links = excluded.filter((e) => e.reason === 'symlink' || e.reason === 'special').map((e) => e.path);
  if (links.length) {
    checks.push({ id: 'P2', level: 'block', resolved: true, message: `Symbolic links and special files are never published or followed: ${list(links)}. They were removed from the list.`, files: links.slice(0, MAX_LISTED).map((path) => ({ path })) });
  }

  // P3: secret-looking files are left out by default
  const secretFiles = excluded.filter((e) => e.reason === 'secret').map((e) => e.path);
  if (secretFiles.length) {
    checks.push({ id: 'P3', level: 'block', resolved: true, message: `Found files that look like private keys or passwords: ${list(secretFiles)}. They will not be published.`, files: secretFiles.slice(0, MAX_LISTED).map((path) => ({ path })) });
  }

  // P4: secret-looking text inside files (a Firebase web API key is public by design: a warning)
  const findings = [];
  const publicKeys = [];
  for (const [path, text] of texts) {
    if (findings.length >= MAX_FINDINGS) break;
    for (const f of findSecrets(text)) (f.public ? publicKeys : findings).push({ path, line: f.line, kind: f.kind });
  }
  if (findings.length) {
    const inFiles = [...new Set(findings.map((f) => f.path))];
    checks.push({
      id: 'P4',
      level: 'block',
      message: `Found text that looks like a password or key in ${list(inFiles)}. Secrets must never be published in a site. Exclude these files or cancel.`,
      files: findings.slice(0, MAX_FINDINGS),
      fix: { action: 'exclude', label: 'Exclude these files' },
    });
  }
  if (publicKeys.length) {
    checks.push({
      id: 'P4-firebase',
      level: 'warn',
      message: `Found a Firebase web API key in ${list([...new Set(publicKeys.map((f) => f.path))])}. Firebase keys are public by design, so the site can be published, but anyone can use this key: in the Google Cloud console restrict it to the Firebase APIs (it works for every API enabled on the project), and protect your data with Firebase Security Rules and App Check.`,
      files: publicKeys.slice(0, MAX_LISTED),
    });
  }

  // P5: quota
  const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
  if (truncated || files.length > maxFiles || bytes > quotaBytes) {
    const why = truncated || files.length > maxFiles
      ? `It has more than ${maxFiles.toLocaleString('en')} files.`
      : `It is ${mib(bytes)}, above the site quota of ${mib(quotaBytes)}.`;
    checks.push({ id: 'P5', level: 'block', message: `This site is too large to publish. ${why} Reduce it, or raise the quota in Settings.` });
  }

  // P6: features that need a server
  const serverHits = texts.filter(([path, t]) => (SCRIPT_FILE.test(path) || HTML_FILE.test(path))
    && (/\/_serverFn\/|createServerFn\s*\(|\bfetch\(\s*["'`]\/api\//.test(t)));
  if (serverHits.length) {
    const sample = serverHits.map(([, t]) => (/\/_serverFn\//.test(t) ? '/_serverFn/…' : /createServerFn/.test(t) ? 'createServerFn' : '/api/…'))[0];
    checks.push({ id: 'P6', level: 'warn', message: `This app calls a server (${sample}). Those features will not work on IPFS: hide or replace them. Never put a server's secret keys into the site to make them work.`, files: serverHits.slice(0, MAX_LISTED).map(([path]) => ({ path })) });
  }

  // P7: a history-router single-page app without fallback
  const entryText = contents.get(entry);
  const otherHtml = files.filter((f) => HTML_FILE.test(f.path) && f.path !== entry && f.path !== SHELL_FILE && !/(^|\/)404\.html?$/i.test(f.path));
  if (entryText && /<script\b[^>]*\btype\s*=\s*["']?module/i.test(entryText) && otherHtml.length === 0 && !descriptor.spa && !(descriptor.rules || []).length) {
    checks.push({ id: 'P7', level: 'warn', message: 'This looks like a single-page app. Without single-page-app mode, links such as /about will show "not found" when opened directly or reloaded.', fix: { action: 'enable-spa', label: 'Turn on single-page-app mode' } });
  }

  // P8: service workers
  const sw = texts.filter(([path, t]) => (SCRIPT_FILE.test(path) || HTML_FILE.test(path)) && /serviceWorker\s*\.\s*register\s*\(/.test(t));
  if (sw.length) checks.push({ id: 'P8', level: 'warn', message: 'This site registers a service worker. Service workers are not supported in Bucks yet; the site has to work without one.', files: sw.slice(0, MAX_LISTED).map(([path]) => ({ path })) });

  // P9: root-absolute URLs
  const rootAbs = texts.filter(([path, t]) => HTML_FILE.test(path) && /\b(?:src|href)\s*=\s*["']?\/(?!\/)/i.test(t));
  if (rootAbs.length) checks.push({ id: 'P9', level: 'warn', message: 'Some links start with "/" (for example src="/assets/…"). They work in Bucks and on subdomain gateways, but not on /ipfs/<cid>/ path gateways.', files: rootAbs.slice(0, MAX_LISTED).map(([path]) => ({ path })) });

  // P10: mixed content
  const mixed = texts.filter(([path, t]) => (HTML_FILE.test(path) && (/\bsrc\s*=\s*["']?http:\/\//i.test(t) || /<link\b[^>]*\bhref\s*=\s*["']?http:\/\//i.test(t)))
    || ((HTML_FILE.test(path) || STYLE_FILE.test(path)) && /url\(\s*["']?http:\/\//i.test(t)));
  if (mixed.length) checks.push({ id: 'P10', level: 'warn', message: 'Some files load http:// resources, which browsers block on a secure page.', files: mixed.slice(0, MAX_LISTED).map(([path]) => ({ path })) });

  // P11: external hosts
  const hosts = [...new Set(texts.flatMap(([path, t]) => externalHosts(path, t)))].sort();
  if (hosts.length) checks.push({ id: 'P11', level: 'info', message: `Visitors' browsers will contact these hosts: ${list(hosts)}.`, hosts: hosts.slice(0, MAX_LISTED) });

  // P12: large or uncompressed media
  const big = files.filter((f) => f.size > LARGE_FILE_BYTES || UNCOMPRESSED_MEDIA.test(f.path));
  if (big.length) checks.push({ id: 'P12', level: 'info', message: `Large or uncompressed files: ${list(big.map((f) => `${f.path} (${mib(f.size)})`))}. Compressing them makes the site faster to load.`, files: big.slice(0, MAX_LISTED).map((f) => ({ path: f.path })) });

  // The package's own configuration files
  if (descriptor.problems?.length) {
    const file = descriptor.source === 'redirects' ? REDIRECTS_FILE : MANIFEST_FILE;
    checks.push({ id: 'config', level: 'warn', message: `${file}: ${descriptor.problems.slice(0, 5).join('; ')}${descriptor.problems.length > 5 ? '; …' : ''}` });
  }
  return checks;
}

/** True when an unresolved blocking check prevents publishing. */
export function isBlocked(checks) {
  return checks.some((c) => c.level === 'block' && !c.resolved);
}
