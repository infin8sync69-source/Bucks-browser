// Reading a site folder (docs/IPFS-HOSTING-IMPLEMENTATION.md §5.1, §8.2 step 1). The folder is
// walked with lstat and links are never followed; hidden and secret-looking files are left out.
// The user's folder is never modified: one-click fixes ("use _shell.html as index.html", "turn on
// single-page-app mode") are applied to the published copy only, as virtual files. No Electron.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildDescriptor, MANIFEST_FILE, REDIRECTS_FILE, SHELL_FILE, DEFAULT_ENTRY, MAX_DESCRIPTOR_BYTES } from './package.js';
import { runPreflight, isBlocked } from './preflight.js';

export const DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 50_000;
const MAX_VISITED = 200_000;
const MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_TOTAL_BYTES = 96 * 1024 * 1024;
const TEXT_FILE = /\.(html?|m?js|cjs|jsx|tsx?|css|json|map|txt|md|xml|svg|webmanifest|ya?ml|toml|ini|env|cfg|conf|properties)$/i;
/** Hidden entries that are part of the web platform, not secrets. */
const HIDDEN_ALLOWED = new Set(['.well-known']);
/** Likely output folders, best first (§12.1 step 1). */
export const OUTPUT_CANDIDATES = ['dist/client', 'dist', 'build', 'out', '.output/public', 'public'];
const FRAMEWORKS = [
  ['@tanstack/react-start', 'tanstack-start'], ['@tanstack/start', 'tanstack-start'], ['next', 'next'], ['nuxt', 'nuxt'],
  ['@sveltejs/kit', 'sveltekit'], ['astro', 'astro'], ['gatsby', 'gatsby'], ['@angular/core', 'angular'],
  ['react-scripts', 'create-react-app'], ['vite', 'vite'],
];

/** True for file or folder names that look like credentials (§5.3 P3). */
export function isSecretName(name) {
  return /^\.env(\..*)?$/i.test(name)
    || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(name)
    || /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i.test(name)
    || /^(\.npmrc|\.netrc|\.pgpass|\.htpasswd|\.git)$/i.test(name)
    || /^credentials/i.test(name);
}

const toPosix = (rel) => rel.split(path.sep).join('/');

/**
 * Walk a folder without following links.
 * @param {string} dir
 * @param {{ maxFiles?: number }} [opts]
 * @returns {Promise<{ root: string, files: Array<{ path: string, size: number, abs: string }>,
 *   excluded: Array<{ path: string, reason: string }>, truncated: boolean }>}
 */
export async function walkFolder(dir, { maxFiles = DEFAULT_MAX_FILES } = {}) {
  const root = await fsp.realpath(dir);
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw new Error(`${dir} is not a folder`);
  const files = [];
  const excluded = [];
  let visited = 0;
  let truncated = false;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      excluded.push({ path: toPosix(rel) || '.', reason: 'unreadable' });
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1)); // stack pops them in name order
    for (const ent of entries) {
      visited += 1;
      if (visited > MAX_VISITED || files.length > maxFiles) { truncated = true; break; }
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      const p = toPosix(childRel);
      let st;
      try {
        st = await fsp.lstat(path.join(root, childRel));
      } catch {
        excluded.push({ path: p, reason: 'unreadable' });
        continue;
      }
      if (st.isSymbolicLink()) { excluded.push({ path: p, reason: 'symlink' }); continue; }
      const hidden = ent.name.startsWith('.') && !HIDDEN_ALLOWED.has(ent.name);
      if (st.isDirectory()) {
        if (isSecretName(ent.name)) excluded.push({ path: `${p}/`, reason: 'secret' });
        else if (hidden) excluded.push({ path: `${p}/`, reason: 'hidden' });
        else stack.push(childRel);
        continue;
      }
      if (!st.isFile()) { excluded.push({ path: p, reason: 'special' }); continue; }
      if (isSecretName(ent.name)) { excluded.push({ path: p, reason: 'secret' }); continue; }
      if (hidden) { excluded.push({ path: p, reason: 'hidden' }); continue; }
      files.push({ path: p, size: st.size, abs: path.join(root, childRel) });
    }
    if (truncated) break;
  }
  return { root, files, excluded, truncated };
}

async function readSmallText(abs, limit = MAX_DESCRIPTOR_BYTES) {
  const fh = await fsp.open(abs, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > limit) return null;
    return (await fh.readFile()).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Text of the files worth scanning, bounded per file and in total. */
async function readContents(files) {
  const contents = new Map();
  let total = 0;
  for (const f of files) {
    if (!TEXT_FILE.test(f.path) || f.size > MAX_SCAN_FILE_BYTES || total + f.size > MAX_SCAN_TOTAL_BYTES) continue;
    try {
      const text = f.content ? f.content.toString('utf8') : await readSmallText(f.abs, MAX_SCAN_FILE_BYTES);
      if (text === null) continue;
      contents.set(f.path, text);
      total += f.size;
    } catch { /* unreadable: the add step will report it */ }
  }
  return contents;
}

const isExcludedBy = (p, rules) => rules.some((r) => p === r || (r.endsWith('/') && p.startsWith(r)));

/**
 * Inspect a folder for publishing: walk, apply the user's exclusions and fixes, run P1–P12.
 * @param {string} dir
 * @param {{ exclude?: string[], useShellAsIndex?: boolean, enableSpa?: boolean, quotaBytes?: number, maxFiles?: number }} [opts]
 *   exclude: relative paths (a trailing '/' excludes a folder) chosen by the user
 * @returns {Promise<{ root: string, files: Array<{ path: string, size: number, abs?: string, content?: Buffer }>,
 *   excluded: Array<{ path: string, reason: string }>, bytes: number, count: number,
 *   descriptor: ReturnType<typeof buildDescriptor>, checks: ReturnType<typeof runPreflight>, blocked: boolean,
 *   options: { exclude: string[], useShellAsIndex: boolean, enableSpa: boolean } }>}
 */
export async function inspectFolder(dir, { exclude = [], useShellAsIndex = false, enableSpa = false, quotaBytes = DEFAULT_QUOTA_BYTES, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const walked = await walkFolder(dir, { maxFiles });
  const rules = exclude.filter((e) => typeof e === 'string' && e && !e.startsWith('/') && !e.split('/').includes('..'));
  const files = [];
  const excluded = [...walked.excluded];
  for (const f of walked.files) {
    if (isExcludedBy(f.path, rules)) excluded.push({ path: f.path, reason: 'user' });
    else files.push(f);
  }
  const byPath = new Map(files.map((f) => [f.path, f]));

  // Fix: a TanStack-style SPA shell becomes the entry, in the published copy only.
  const shell = byPath.get(SHELL_FILE);
  if (useShellAsIndex && shell && !byPath.has(DEFAULT_ENTRY)) {
    const index = { path: DEFAULT_ENTRY, size: shell.size, abs: shell.abs };
    files.push(index);
    byPath.set(DEFAULT_ENTRY, index);
  }

  const manifestFile = byPath.get(MANIFEST_FILE);
  const redirectsFile = byPath.get(REDIRECTS_FILE);
  let manifestText = manifestFile ? await readSmallText(manifestFile.abs).catch(() => null) : null;
  const redirectsText = redirectsFile ? await readSmallText(redirectsFile.abs).catch(() => null) : null;

  // Fix: single-page-app mode, written into the published bucks-site.json.
  if (enableSpa) {
    let raw = {};
    try {
      const parsed = manifestText === null ? {} : JSON.parse(manifestText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
    } catch { /* replaced by a valid manifest */ }
    manifestText = `${JSON.stringify({ ...raw, spa: true }, null, 2)}\n`;
    const content = Buffer.from(manifestText, 'utf8');
    const virtual = { path: MANIFEST_FILE, size: content.length, content };
    const i = files.findIndex((f) => f.path === MANIFEST_FILE);
    if (i === -1) files.push(virtual); else files[i] = virtual;
  }

  const descriptor = buildDescriptor({ manifestText, redirectsText });
  const contents = await readContents(files);
  const checks = runPreflight({ files, excluded, contents, descriptor, quotaBytes, maxFiles, truncated: walked.truncated });
  return {
    root: walked.root,
    files,
    excluded,
    bytes: files.reduce((n, f) => n + f.size, 0),
    count: files.length,
    descriptor,
    checks,
    blocked: isBlocked(checks),
    options: { exclude: rules, useShellAsIndex: Boolean(useShellAsIndex), enableSpa: Boolean(enableSpa) },
  };
}

async function hasEntry(dir) {
  for (const name of [DEFAULT_ENTRY, SHELL_FILE]) {
    try {
      if ((await fsp.lstat(path.join(dir, name))).isFile()) return true;
    } catch { /* next */ }
  }
  return false;
}

const exists = (p) => fsp.lstat(p).then(() => true, () => false);

/**
 * Guess what the user picked: the site itself, or a project whose build output is inside.
 * @param {string} dir
 * @returns {Promise<{ siteDir: string, suggestedDir: string|null, framework: string|null, isStatic: boolean|null, note: string|null }>}
 *   siteDir: the folder to publish (absolute); suggestedDir: it, relative to `dir` ('' = dir itself)
 */
export async function detectProject(dir) {
  let framework = null;
  try {
    const pkg = JSON.parse(await readSmallText(path.join(dir, 'package.json'), 1024 * 1024));
    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
    framework = FRAMEWORKS.find(([dep]) => Object.hasOwn(deps, dep))?.[1] ?? null;
  } catch { /* no package.json: a plain folder */ }

  let suggestedDir = null;
  if (await hasEntry(dir)) suggestedDir = '';
  else {
    for (const c of OUTPUT_CANDIDATES) {
      if (await hasEntry(path.join(dir, ...c.split('/')))) { suggestedDir = c; break; }
    }
  }
  const serverBuild = (await exists(path.join(dir, '.output', 'server'))) || (await exists(path.join(dir, '.next', 'server')));
  let note = null;
  if (suggestedDir === null && serverBuild) {
    note = 'This project builds a server (.output/server or .next/server). IPFS cannot run a server: build it as a static site (for example single-page-app mode) and pick that output folder.';
  } else if (suggestedDir === null) {
    note = `No built site found here (no ${DEFAULT_ENTRY} in this folder or in ${OUTPUT_CANDIDATES.join(', ')}). Build the project first, then pick its output folder.`;
  } else if (serverBuild) {
    note = 'This project also has a server build. Only the static files are published; features that call the server will not work.';
  }
  return {
    siteDir: suggestedDir === null ? dir : path.join(dir, ...suggestedDir.split('/').filter(Boolean)),
    suggestedDir,
    framework,
    isStatic: suggestedDir === null ? (serverBuild ? false : null) : true,
    note,
  };
}
