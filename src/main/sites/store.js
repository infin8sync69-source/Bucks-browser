// sites.json: the sites this browser hosts (docs/IPFS-HOSTING-IMPLEMENTATION.md §8.1). Written
// atomically (temp file + rename, one write at a time) and schema-versioned. A file from a newer
// Bucks is read but never overwritten, so a downgrade cannot destroy it. The file is re-read when
// another process changed it (the app and scripts/site.mjs share it). No Electron imports.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const STORE_VERSION = 1;
const MAX_SITES = 500;
const MAX_HISTORY = 100;
const MAX_NAME = 100;
const SITE_ID = /^s_[a-f0-9]{8,32}$/;
const KEY_NAME = /^site-s_[a-f0-9]{8,32}$/;

const str = (v, max = 1024) => (typeof v === 'string' && v.length <= max ? v : null);
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

function cleanVersion(v) {
  if (!v || typeof v !== 'object') return null;
  const cid = str(v.cid, 200);
  if (!cid || !/^[a-z0-9]+$/i.test(cid)) return null;
  return { cid, publishedAt: iso(v.publishedAt), bytes: int(v.bytes), files: int(v.files), note: str(v.note, 500) || '' };
}

const cleanList = (v, max, re) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && re.test(x)).slice(0, max) : []);

/** Validate one site record; null when it is unusable. Unknown fields are dropped. */
export function sanitizeSite(s) {
  if (!s || typeof s !== 'object' || !SITE_ID.test(s.id)) return null;
  const history = (Array.isArray(s.history) ? s.history : []).map(cleanVersion).filter(Boolean).slice(0, MAX_HISTORY);
  const current = cleanVersion(s.current);
  const hosting = s.hosting && typeof s.hosting === 'object' ? s.hosting : {};
  return {
    id: s.id,
    name: str(s.name, MAX_NAME) || s.id,
    sourceDir: str(s.sourceDir, 4096),
    keyName: KEY_NAME.test(s.keyName) ? s.keyName : null,
    ipns: typeof s.ipns === 'string' && /^k51[a-z0-9]{40,80}$/.test(s.ipns) ? s.ipns : null,
    current,
    history,
    hosting: {
      keepOnline: hosting.keepOnline !== false,
      pinToDevices: cleanList(hosting.pinToDevices, 32, /^[1-9A-HJ-NP-Za-km-z]{40,64}$|^k51[a-z0-9]{40,80}$/),
      pinningServices: cleanList(hosting.pinningServices, 8, /^[A-Za-z0-9._-]{1,40}$/),
    },
    quotaBytes: int(s.quotaBytes) || null,
    backup: { keyBackedUpAt: iso(s.backup?.keyBackedUpAt) },
    announce: s.announce && typeof s.announce === 'object'
      ? { ok: s.announce.ok === true, at: iso(s.announce.at), error: str(s.announce.error, 500) }
      : null,
    createdAt: iso(s.createdAt),
  };
}

/** Bring any known older shape up to the current schema. */
export function migrate(raw) {
  if (Array.isArray(raw)) return { version: STORE_VERSION, sites: raw }; // pre-release: a bare list
  if (raw && typeof raw === 'object' && Array.isArray(raw.sites)) return { ...raw, version: Number(raw.version) || STORE_VERSION };
  return { version: STORE_VERSION, sites: [] };
}

/**
 * @param {{ file: string, log?: { warn: Function, error: Function } }} opts
 */
export function createSiteStore({ file, log = { warn() {}, error() {} } }) {
  let readOnly = false;
  let stamp = null;
  let sites = load();

  function stampOf() {
    try {
      const st = fs.statSync(file);
      return `${st.ino}:${st.mtimeMs}:${st.size}`; // every atomic write is a new inode
    } catch {
      return null;
    }
  }

  /** Pick up a change another process made since we last read or wrote the file. */
  function refresh() {
    const now = stampOf();
    if (now !== stamp) sites = load();
  }

  function load() {
    stamp = stampOf();
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        log.warn(`${file} is unreadable (${e.message}); keeping it as ${path.basename(file)}.corrupt and starting empty`);
        try { fs.renameSync(file, `${file}.corrupt`); } catch { /* best effort */ }
      }
      return [];
    }
    const data = migrate(raw);
    if (data.version > STORE_VERSION) {
      readOnly = true;
      log.warn(`${file} was written by a newer Bucks (schema ${data.version}); it will not be changed`);
    }
    const seen = new Set();
    const out = [];
    for (const s of data.sites.slice(0, MAX_SITES)) {
      const clean = sanitizeSite(s);
      if (clean && !seen.has(clean.id)) { seen.add(clean.id); out.push(clean); }
    }
    return out;
  }

  let writing = Promise.resolve();
  function persist() {
    if (readOnly) return Promise.reject(new Error('The sites list was written by a newer version of Bucks and cannot be changed here.'));
    const data = JSON.stringify({ version: STORE_VERSION, sites }, null, 2);
    writing = writing.catch(() => {}).then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, data, { mode: 0o600 });
      await fsp.rename(tmp, file);
      stamp = stampOf();
    });
    return writing;
  }

  return {
    file,
    get readOnly() { return readOnly; },
    list: () => {
      refresh();
      return sites.map((s) => structuredClone(s));
    },
    get: (id) => {
      refresh();
      const s = sites.find((x) => x.id === id);
      return s ? structuredClone(s) : null;
    },
    /** Insert or replace a site (validated); resolves once it is on disk. */
    async put(site) {
      const clean = sanitizeSite(site);
      if (!clean) throw new Error('Invalid site record');
      refresh();
      const i = sites.findIndex((x) => x.id === clean.id);
      if (i === -1) {
        if (sites.length >= MAX_SITES) throw new Error(`At most ${MAX_SITES} sites can be hosted`);
        sites = [...sites, clean];
      } else {
        sites = sites.map((x, j) => (j === i ? clean : x));
      }
      await persist();
      return structuredClone(clean);
    },
    async remove(id) {
      refresh();
      const before = sites.length;
      sites = sites.filter((x) => x.id !== id);
      if (sites.length !== before) await persist();
      return sites.length !== before;
    },
  };
}
