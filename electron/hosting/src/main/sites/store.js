// sites.json: the sites this browser hosts (docs/IPFS-HOSTING-IMPLEMENTATION.md §8.1), kept by the
// shared record store (src/main/lib/record-store.js): atomic writes, schema-versioned (a file from a
// newer Bucks is read but never overwritten), re-read when another process changed it (the app and
// scripts/site.mjs share it). This module validates the records. No Electron imports.

import { createRecordStore } from '../lib/record-store.js';

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
  return createRecordStore({ file, key: 'sites', version: STORE_VERSION, max: MAX_SITES, what: 'sites', sanitize: sanitizeSite, migrate, log });
}
